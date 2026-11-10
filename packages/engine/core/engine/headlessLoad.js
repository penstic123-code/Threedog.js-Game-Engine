// Headless loading after start: a headless engine (?threedog-headless, createEngine({ headless: true })) has no real-time loop, so after start()
// nothing runs frames unless someone calls step(). Anything that makes the world load again after start (a species added with
// vegetation.define, terrain.density, a teleport, a level swap) queued its work and waited for frames that never came: the page sat on
// "waiting for module terrain" forever, while the same page in a live browser loaded within a second.
//
// Why a load pump and not "step more" in the tools: step() is synchronous, and chunk results come back from workers between tasks, so no
// number of steps inside one call can finish a load. Only frames spread over real time can, which is what a live loop gives. So while the
// world is not settled, the headless engine runs the same loading frame start() runs (frame hooks, stream, jobs; game time does not move:
// dt 0, jobs drain deterministically), on a timer. A settled world runs nothing, so step()-driven tests keep their exact frame count.
//
// stateApplied waits for it too (Engine.js): screenshots, npm test and the dev bridge wait on stateApplied, so a load that began after
// start is finished before they capture. A load that never settles stops holding stateApplied at whenSettled's limit with one warning naming who is still waiting, so a stuck module cannot hang a tool.
import { DEV, warnOnce } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';

const TICK_MS = 16;   // one loading frame per ~60 Hz tick: the same pace a live loop gives the workers

/** Modules whose isReady(e) is false, plus the stream when its required nearby builds are not done ([] = settled) */
export function unsettled(e) {
  const who = [];
  for (const m of e.modules.values()) if (m.isReady && !m.isReady(e)) who.push(m.name);
  if (!e.stream.ready) who.push('the stream (required nearby builds)');
  return who;
}

/** The error of a settle that did not come, in the words unsettled() gives */
const stalled = e => codedError('module-not-ready', `Still waiting after ${Math.round(e.loading.timeoutMs / 1000)} s for: ${unsettled(e).join(', ')}. A module's isReady(e) keeps returning false (or the world never finished its nearby builds); fix that, or raise engine.loading.timeoutMs if the load is only slow`);

/**
 * @internal The one wait for "ready to play": true once nothing is unsettled, checked per engine frame so step() advances it too; false as soon as valid() stops holding. It rejects (module-not-ready,
 * naming who still waits) after engine.loading.timeoutMs. start(), flow's transition, level:playable and the headless pump all read this, so the question has one answer and one limit.
 */
export function whenSettled(e, valid = () => true, rearm = false) {
  const now = () => !valid() ? false : unsettled(e).length ? null : true;
  const first = now();
  if (first !== null) return Promise.resolve(first);
  // rearm: a load during play (a level, a flow transition) passes it, since its start-up cost is not play either: timing is cleared again once it settles
  // (loop.js startPlayTiming). The headless pump does not: chunks streaming in while walking are play, and their spikes must stay visible
  if (rearm) e._playTiming = false;
  const since = performance.now();   // measure: wall clock, so a wait with no frames to run on still ends
  let h;
  const settled = new Promise((res, rej) => {
    h = e.onFrame(() => {
      try { const r = now(); if (r !== null) { h.remove(); res(r); } } catch (err) { h.remove(); rej(err); }   // a throwing isReady ends the wait: this hook's error would reach no waiter
    });
  });
  return e.loading._limit(settled, () => now() === null ? since : null, () => { h.remove(); return stalled(e); });
}

/** @internal start(): begin pumping loading frames for a headless engine (no-op for a live one, its loop already runs frames) */
export function startHeadlessLoad(e) {
  if (!e.headless || e._headlessLoad) return;
  const s = e._headlessLoad = { watching: false, stalled: false };
  const tick = () => {
    if (e.disposed) return;
    if (!unsettled(e).length) s.stalled = false;
    else {
      if (!s.watching && !s.stalled) {
        s.watching = true;
        whenSettled(e).catch(err => { s.stalled = true; if (DEV) warnOnce(coded('module-not-ready', `headless load after start: ${err.message}; stateApplied no longer waits for it`)); }).finally(() => { s.watching = false; });
      }
      // the same loading frame start() runs while it waits (startup.js _waitReady): frame hooks, stream, jobs; game time stays put
      // (no input.endFrame: a key a test pressed before its next step() must still read as just pressed there)
      e._frameHooks(0, true);
    }
    setTimeout(tick, TICK_MS);   // main-loop: a headless engine's stand-in for the live frame loop while something is loading
  };
  tick();
}

/** @internal stateApplied: true when the world is settled (or its post-start load gave up after timeoutMs); always true for a live engine */
export function headlessSettled(e) {
  const s = e._headlessLoad;
  return !s || s.stalled || !unsettled(e).length;
}
