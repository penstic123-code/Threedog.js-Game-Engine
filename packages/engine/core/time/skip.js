// engine.skip: jump time in segments.
// Skipping time (part of Engine, mixed into Engine.prototype): engine.skip({ to: '06:00' }) for "sleep until morning", { seconds } for "wait a while".
// Why not step(): a long skip can be hours of fixed steps. skip moves calendar seconds in segments that end at each timed thing
// (a clock timer due, a calendar clock mark: midnight, an at time, a between edge), so after / every / at / daily / between / day:start / season:change
// fire in the same order and the same number of times as when stepping. The world catches up once at the end: every record with far
// gets the whole span as one far(rec, dt) (records added by a timer mid-skip owe only from when they were added).
// What does not run while skipping: onFixed callbacks, module fixed hooks, physics and near simulation.
// Every time view (core/time/time.js) moves as if stepped: tick and real by the skipped fixed seconds, ambient too, each channel by those x its speed,
// so timers on any channel fire and mods with `for` end in order (a segment also ends at each of those). One call per segment: time._skip.
// Modules that keep their own time implement the hook skip(dt, e, done): dt is the segment in fixed seconds, done is true on the last segment (do expensive catch-up once there).
// The jump itself is the op 'time.skip' (logged, replayable, allowed to write saved state); skip() adds the 'skip' input context, optional fade and autosave around it.
import { parseClock } from './dayTime.js';
import { asModule } from '../engine/moduleTypes.js';
import { readParams, keysSchema } from '../base/params.js';
import { reportError } from '../base/errors.js';
import { codedError } from '../base/errorHints.js';
import { fmt, warnOnce } from '../base/validate.js';
import { fadeScreen } from '../../ui/UI.js';

const NUDGE = 1e-6;   // calendar seconds past each mark: land just after it, so float error never leaves a mark uncrossed
const STRINGS = {
  amount: 'engine.skip(): pass { to: "06:00" } (until the calendar clock next reads 06:00) or { seconds: 600 } (calendar seconds, > 0); got {got}',
  noSkip: "engine.skip(): module '{name}' has a fixed hook but no skip hook and no skipKind, so the skipped time does not advance it (its own timers and cooldowns stay behind). Add skip(dt, e, done), or skipKind: 'none' if it should not move",
  noCalendar: 'engine.skip({ to }) needs the calendar module (it reads the calendar clock: engine.use(calendar({ dayLength: 360 }))); without one pass { seconds } (calendar seconds)',
  fixedDay: 'engine.skip({ to }): the calendar time of day never moves (calendar({ dayLength: Infinity })), so the clock never reads that time; pass { seconds } (calendar seconds)',
  hook: 'skip hook of module {name}',
};

/** Calendar seconds to skip for opts ({ seconds } or { to } = the next time the calendar clock reads that time; the current time itself means a full day) */
function amount(e, o) {
  const bad = () => codedError('skip-amount', fmt(STRINGS.amount, { got: String(JSON.stringify(o)) }));
  if (o.seconds != null) { if (!(o.seconds > 0) || !Number.isFinite(o.seconds)) throw bad(); return o.seconds; }
  if (o.to == null) throw bad();
  // engine.calendar is whatever module meets modules/calendar/contract.js (timeOfDay, dayLength, hoursPerDay, untilMark): core reads only those
  const cal = e.calendar; if (!cal) throw codedError('skip-amount', STRINGS.noCalendar);
  if (!Number.isFinite(cal.dayLength)) throw codedError('skip-amount', STRINGS.fixedDay);   // the clock never reaches that time: an endless skip otherwise
  const f = parseClock(o.to, cal.hoursPerDay) % 1;
  if (!Number.isFinite(f)) throw bad();
  // + NUDGE: land just past the mark, like every segment end. Without it the float sums of the segments could stop a hair short, and the clock
  // read 05:59 instead of 06:00 (a flaky spec, review 0.4 B)
  return ((((f - cal.timeOfDay) % 1) + 1) % 1 || 1) * cal.dayLength + NUDGE;
}

/** Advance calendar seconds in segments (see the top of the file). Called by the op 'time.skip' */
function jump(e, seconds) {
  const clock = e.clock, cal = e.calendar, time = e.time;   // clock: the calendar view of time (its timers are in time's one queue)
  let left = seconds, ended = false;
  for (const h of e._hooks.fixed) if (!h.mod.skip && !h.mod.skipKind && !h.mod.noSkip) warnOnce(fmt(STRINGS.noSkip, { name: h.name }));   // said at skip time, once per module: a skip that silently leaves a module behind
  const off = e.events.on('session:end', () => { ended = true; });   // a timer callback ended the playthrough mid-skip: the new one must not be skipped
  try {
    while (left > 0 && !ended) {
      // calendar seconds per fixed second, read per segment (an ended mod changes it); a stopped calendar (0) would need infinite fixed seconds: skip as if at 1x
      const r = clock.speed, ts = r > 0 ? r : 1;
      let seg = Math.min(left, cal ? cal.untilMark() + NUDGE : Infinity, time._untilNext(ts) + NUDGE);
      left -= seg;
      if (left < NUDGE) { seg += left; left = 0; }   // no sliver segment at the end
      const dt = seg / ts, done = left === 0;
      for (const h of e._hooks.skip) {
        try { asModule(e, h.mod, () => h.fn(dt, e, done)); } catch (err) { reportError(e, err, fmt(STRINGS.hook, { name: h.name }), { module: h.mod }); }
      }
      time._skip(dt, seg);
    }
  } finally { off.remove(); }
  if (ended) return null;
  e.events.emit('time:skip', { seconds });
  return { seconds, clock: cal?.clock ?? null, day: cal?.day ?? null };
}

/** Register the op behind engine.skip (called once by the Engine constructor) */
export function defineSkipOp(e) {
  e.ops.define('time.skip', {
    desc: 'Skip game time forward by that many calendar seconds (timers, calendar clock events and world far simulation catch up in order)',
    args: { seconds: 'number' },
    can: (_, a) => a.seconds > 0 ? true : 'notForward',
    run: (eng, a) => jump(eng, a.seconds),
    reasons: { notForward: 'seconds must be > 0 (time only skips forward)' },
  });
}

export const skipMethods = {
  /**
   * Skip game time forward (sleep until morning, wait an hour) without stepping every fixed step.
   * Timers fire in time order as if stepped: clock.after / every, calendar.at / daily / between, day:start, season:change (each crossing once; catchUp does not apply).
   * World records with far catch up the whole span in one far(rec, dt) (dt in fixed seconds = calendar seconds / (clock.rate x world speed)); growth and respawns measured with clock.now are exact.
   * Not run while skipping: onFixed, module fixed hooks, physics, near simulation. Input is blocked (an opaque 'skip' input context) and gameplay frozen for the whole skip; emits time:skip { seconds } after the jump.
   * With fade 0 (default) the time has already moved when skip returns; with fade > 0 it fades out, jumps, (saves), fades in (through flow.transition when flow is installed),
   * and the Promise resolves after the fade in, which needs frames: in a paused test keep calling engine.step while waiting.
   * @example await engine.skip({ to: '06:00' });                        // sleep: until the calendar clock next reads 06:00
   * @example engine.skip({ seconds: 600 });                             // wait 600 calendar seconds
   * @example await engine.skip({ to: '06:00', fade: 0.6, save: 'auto' }); // fade to black, jump, autosave, fade in
   * Bad arguments throw at the call, before any fade (`[skip-amount]`, `[module-params]`); a skip already under way rejects.
   * @param {{ to?: string | number, seconds?: number, fade?: number, save?: string | boolean }} opts
   * Cancelled cleanly by session.newGame / load / quit and by saves.load (the skip resolves null and time stays where the new playthrough put it).
   * @returns {Promise<{ seconds: number, clock: string | null, day: number | null } | null>}
   */
  skip(opts) {
    opts ??= {};   // skip(null) reads as no amount, the coded error below, not a TypeError on .fade
    readParams('engine.skip()', keysSchema(['to', 'seconds', 'fade', 'save']), opts);
    const { fade = 0, save = null } = opts;
    amount(this, opts);   // throw on bad arguments now, not after the fade
    // one at a time: the end of a second one unfroze the game during the first one's fade
    if (this._skipping) return Promise.reject(codedError('skip-busy', 'engine.skip(): a skip is already under way; await the first one, then skip again'));
    this._skipping = true;
    let out = null, ended = false;
    const generation = this.saves.generation;
    const go = () => {
      if (ended || this.saves.generation !== generation) return;   // the playthrough ended, or a quick load replaced the state, during the fade out: nothing to skip in the new one
      const r = this.ops.run('time.skip', { seconds: amount(this, opts) });   // measured at jump time: a queued transition may have moved the clock
      if (!r.ok) throw codedError('skip-amount', `engine.skip(): the time.skip op was refused (${r.code}); read it with engine.ops.can('time.skip', { seconds })`);
      out = r.value;
      if (save && out) this.saves.save(save === true ? 'auto' : save);
    };
    const ctx = this.input.push('skip'); const fz = this.freeze('skip');   // opaque 'skip' context: gameplay input blocked until the skip ends
    const off = this.events.on('session:end', () => { ended = true; });   // newGame / load / quit cancel the skip cleanly (it resolves null)
    const end = () => { this._skipping = false; ctx.remove(); fz.remove(); off.remove(); };
    if (!(fade > 0)) { try { go(); } finally { end(); } return Promise.resolve(out); }
    const run = this.flow ? this.flow.transition(go, { fade, autosave: false, music: false })
      : (async () => { try { await fadeScreen(this, 1, { seconds: fade }); go(); } finally { await fadeScreen(this, 0, { seconds: fade }); } })();
    return run.finally(end).then(() => out);
  },
};
