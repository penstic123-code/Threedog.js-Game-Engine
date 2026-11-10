// Error tiers.
// What to do when a module hook, onFixed / onFrame / clock callback or event listener throws (the main loop and the event bus both come here).
//   picture and ui modules (the module's type says it: particles, sky, music, a HUD, a menu...): disable the module (its hooks are no longer called),
//     log once to the console, emit module:disabled; the game carries on -- a missing picture, sound or panel does not change game state.
//   Gameplay (all other modules, the game's own callbacks and event listeners): in dev and tests (DEV) fail hard -- freeze gameplay (freeze('error')),
//     engine.error records where and why, emits engine:error, and describe() / describeText() show it on the first line;
//     so a half-deducted inventory or half-updated quest does not keep running, and a test does not mistake it for normal. A release build does not freeze (so the player is not stuck
//     for the whole session) but the game can still see it: engine.error keeps the first one and engine:error fires once per site; a game that cares can react (save and offer a restart).
//   soft (core steps such as rendering and stream.update): report once per site and continue.
// engine.error is machine-readable: { where, message, code, fix, docs } (code / fix / docs come from the error itself or from the hint table, errorHints.js).
import { DEV, fmt } from './validate.js';
import { errorInfo, hintText } from './errorHints.js';

const STRINGS = { once: '[engine] {key} threw (later errors at the same place are not reported again)', disabled: '[engine] {type} module {name} threw and was disabled (the game continues) [module-disabled]', halted: '[engine] {key} threw and gameplay is frozen (in dev / tests a gameplay error fails hard; see engine.error for details) [gameplay-frozen]', listener: 'listener of event {name}',
  rejected: '[engine] a promise rejected and nothing caught it (e.g. audio.play() of a missing file, an async callback that threw); reported once, the game continues. Add .catch or await it in try. ' };

/** picture / ui modules only show the game, so an error in one switches it off instead of freezing gameplay (the type is the one source; no extra flag) */
const failsSoft = m => m?.type === 'picture' || m?.type === 'ui';

/** Handle an error. key: where it happened (for display); module: the module definition that threw (none means a game callback / event listener, counted as gameplay); soft: report only once */
export function reportError(engine, err, key, { module = null, soft = false } = {}) {
  if (failsSoft(module)) return disableModule(engine, module, err);
  // dev: the first gameplay error freezes the game. Release: no freeze, but the game can SEE it: engine.error keeps the first, engine:error fires once per site
  if (!soft && (DEV ? !engine.error : !engine._hookErrors.has(key))) {
    const message = String(err?.message ?? err);
    // code + fix + docs: what to do and which page to read; at: the line that threw (the message alone often does not say which callback line)
    const info = { where: key, message, ...errorInfo(err), at: firstFrame(err) };
    engine.error ??= info;
    if (DEV) {
      engine.freeze('error');   // until reload, a new game included: dev must not walk past a bug, and a new playthrough on top of it would hide it
      console.error(fmt(STRINGS.halted, { key }) + hintText(err?.code ? `[${err.code}]` : message), err);
    } else { engine._hookErrors.add(key); console.error(fmt(STRINGS.once, { key }), err); }
    engine.events.emit('engine:error', info);
    return;
  }
  if (engine._hookErrors.has(key)) return;
  engine._hookErrors.add(key);
  console.error(fmt(STRINGS.once, { key }), err);
}

/** First stack frame of an error: V8 "at fn (file:line:col)", Firefox / Safari "fn@file:line:col"; null without a stack */
const firstFrame = err => String(err?.stack ?? '').split('\n').map(l => l.trim()).find(l => l.startsWith('at ') || /@\S+:\d+/.test(l)) ?? null;

/**
 * Dev / tests: a rejection nobody caught is reported once as a soft error (console + describe().unhandled { message, code, fix, docs, count }); it never freezes,
 * since an uncaught promise is usually presentation (a sound, a fetch). Without this it was only a red line in the console that tools and AIs never saw.
 */
export function watchRejections(engine) {
  if (!DEV || typeof addEventListener !== 'function') return;
  addEventListener('unhandledrejection', ev => {
    if (engine._unhandled) { engine._unhandled.count++; return; }
    const err = ev.reason;
    engine._unhandled = { message: String(err?.message ?? err), ...errorInfo(err), count: 1 };
    console.error(STRINGS.rejected + hintText(err?.code ? `[${err.code}]` : engine._unhandled.message), err);
  }, { signal: engine.signal });
}

/** An event listener threw (called by the event bus): counted as gameplay */
export function reportListenerError(engine, name, err) { reportError(engine, err, fmt(STRINGS.listener, { name })); }

/** Disable a picture / ui module: remove everything it tracked (borrows given back) and its fixed / frame / afterRender hooks */
function disableModule(engine, m, err) {
  const was = engine._modState.get(m.name);
  if (was === 'disabled') return;
  // the same teardown as unload for what it tracked (listeners, timers, borrows, slots), so a disabled module leaves nothing running; it stays installed. A failed init stays 'failed':
  // that word is what blocks the modules that require it. _setModState re-sorts, which drops its hooks and re-blocks its dependents ('disabled' counts as dead there)
  engine._dropTracked(m.name);
  if (was !== 'failed') engine._setModState(m, 'disabled');
  console.error(fmt(STRINGS.disabled, { type: m.type, name: m.name }), err);
  engine.events.emit('module:disabled', { name: m.name, message: String(err?.message ?? err) });
}

/**
 * @internal The one cleanup rule: remove every handle, newest first when the caller orders them so; one that throws is reported (soft) and the rest still go.
 * Modules (unload, failed init) and sessions (the old playthrough's session.track handles) both clean up through it.
 * @param {any} e @param {Iterable<{ remove(): void }>} handles @param {string} where @param {(h: any) => void} [first]  runs before each remove(), inside its catch
 */
export function removeEach(e, handles, where, first) {
  for (const h of handles) { try { first?.(h); h.remove(); } catch (err) { reportError(e, err, where, { soft: true }); } }
}
