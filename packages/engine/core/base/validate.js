// Runtime checks: when an option or name is misspelled, print the fix to the console ("did you mean `xxx`?").
// Type checking (npm run types) catches mistakes while you write code; this catches the same kind at runtime, which also works for code without type checking.
//
//   readParams('npcs.add()', NPC_PARAMS, opts)                    // options: an unknown key throws in dev (core/base/params.js)
//   checkOptions('inventory.define()', def, KEYS, { loose: true })  // extensible data: warns once on a near-miss key
//   warnMissing('action', 'jupm', ['jump', 'run'])                // 'action "jupm" does not exist, did you mean `jump`? (available: jump, run)'
// Properties the engine writes every frame (sky lights, camera ...) are core/ops/owned.js defineOwned: the engine yields to a direct write and warns once
//
// On by default; createEngine({ validate: false }) turns it all off (for release builds). Each message warns only once.

import { hintText, hintFor, coded, codedError } from './errorHints.js';
import { isOptions } from './util.js';
import { closest } from './spelling.js';
export { closest };

const STRINGS = {
  unknownKey: '{where}: unknown option "{key}", {hint}',
  didYouMean: 'did you mean `{name}`?',
  available: 'available options: {list}',
  missing: '{what} "{name}" does not exist, {hint} (available: {list})',
  missingFar: '{what} "{name}" does not exist (available: {list})',
  none: 'none yet',
  more: ', ... {n} total',
  eventTypo: 'event "{name}" was never emitted or listened to; did you mean `{hint}`? (shown only because the names are similar; ignore it if this really is a new event)',
  // Display names for each kind of name (the kind passed to warnMissing)
  kinds: {
    action: 'action', bus: 'audio bus', synth: 'synth', event: 'event', particle: 'particle effect', asset: 'asset', text: 'text key', module: 'module', weather: 'weather',
    dialogue: 'dialogue', node: 'dialogue node', shot: 'camera shot', track: 'music track', entityType: 'entity type', quest: 'quest', ease: 'easing',
    step: 'timeline step', animState: 'animation state', clip: 'animation clip', item: 'item', vegetation: 'vegetation', state: 'scenario', condition: 'condition word', effect: 'effect word', flowState: 'flow state', material: 'material',
  },
};

/**
 * Fill {name} placeholders from p (an unknown or null one stays as written). The one copy core shares (threadPure.js keeps its own: it must stay import-free).
 */
export const fmt = (s, p) => s.replace(/\{(\w+)\}/g, (m, k) => p[k] ?? m);
// The warn-once set and owned.js allowOwned exemptions are page-wide (a warning said once is said once). The validate switch is per engine:
// engine.validate holds each engine's own setting, and checks that know their engine (event-name spelling, owned values) read it. warnOnce has no
// engine to ask, so it stays on while any live engine has checks on (it used to follow whichever engine was created last).
let live = 0, quiet = 0;
const enabled = () => live === 0 || quiet < live;
/** Dev mode: npm run dev, or the test bundle built by npm test / npm run shot (vite.config defines import.meta.env.THREEDOG_TEST when THREEDOG_TEST is set). */
// Written exactly `import.meta.env`: the Vite 8 dev server only rewrites that literal form; `(import.meta).env` stayed undefined there, so every dev check was
// off under npm run dev
// @ts-ignore Vite's import.meta.env (undefined outside Vite)
const ENV = import.meta.env;
export const DEV = !!(ENV?.DEV || ENV?.THREEDOG_TEST);
/** Positions and speeds beyond this are damage, not a big world: float32 models are already centimetres off at 1e5 and useless far before 1e7 @internal */
export const SAVE_MAX = 1e7;
/** A number the running game can take. Past SAVE_MAX the ground loops around it never end, or a step later a position goes out of range @internal */
export const saveNumberOk = v => Number.isFinite(v) && Math.abs(v) <= SAVE_MAX;
/** Whether a position can be written: [x, y, z], or { x, z } with y left out or a number, each one a save can hold (a save with a bigger one never loads). The one answer; thing.set asks it in can, world's putPos before it writes @param {any} p @returns {boolean} @internal */
export const goodPos = p => Array.isArray(p) ? p.length === 3 && p.every(saveNumberOk) : saveNumberOk(p?.x) && saveNumberOk(p?.z) && (p.y === undefined || saveNumberOk(p.y));
/** The Vite dev server itself (npm run dev, not the test bundle): only it serves /__threedog endpoints and the dev bridge. The other spelling of "dev", named so nothing reads import.meta.env.DEV on its own. */
export const DEV_SERVER = !!ENV?.DEV;
/** Vite's base URL ('/' outside Vite) */
export const BASE_URL = ENV?.BASE_URL ?? '/';
const warned = new Set();
// Dev: what warnOnce said, for describe().warnings, so an AI sees a fallback or clamp without reading the console. The first ones are kept (the first
// warning is most often the cause of the rest); later ones are only counted
const said = [], SAID_MAX = 20;
let saidCount = 0;

/**
 * The one check behind every `.material = m` setter a module hands out.
 * @param {string} code  the module's error code
 * @param {string} what  what is being set, e.g. 'engine.water.material'
 * @param {any} m  the value
 * @param {string} [next]  what to write instead, appended to the message
 * @internal
 */
export function needMaterial(code, what, m, next = '') { if (!m?.isMaterial) throw codedError(code, `${what} takes a three.js Material, got ${m}${next}`); }
/**
 * A shader part written for one renderer only, on the other one: the error that names the missing form.
 * @param {string} code  the module's error code
 * @param {string} what  the part, e.g. 'wind'
 * @param {boolean} gpu  true on WebGPURenderer (the glsl form cannot run), false on WebGLRenderer (the tsl form cannot run)
 * @internal
 */
export const oneForm = (code, what, gpu) => codedError(code, gpu
  ? `${what} has only a glsl form, which WebGPURenderer cannot draw: give tsl too ({ glsl, tsl })`
  : `${what} has only a tsl form, which WebGLRenderer cannot draw: give glsl too ({ glsl, tsl })`);

/**
 * Count one engine's createEngine({ validate }) for the page-wide warnings; returns the release for dispose().
 * @param {boolean | undefined} on
 * @returns {() => void}
 * @internal
 */
export function trackValidate(on) {
  const off = on === false; live++; if (off) quiet++;
  let done = false;
  return () => { if (done) return; done = true; live--; if (off) quiet--; };
}

/**
 * Warn only once (no warning when checks are off). The one dedupe for engine warnings: modules do not keep private "already warned" sets.
 * @param {string | (() => string)} msg  the text, usually coded(code, text) so it carries its fix; a function (with a key) builds it only when it is said,
 *   for a call on a hot path whose text is costly to build (a value read every frame)
 * @param {string} [key]  what counts as "the same warning" when the text has changing parts (a measured value each second, a stack line); default the text
 */
/** Whether v is a Promise or any thenable. The one test the engine's sync contracts use (syncOnly below). @param {unknown} v */
export const isThenable = v => typeof /** @type {any} */ (v)?.then === 'function';
/**
 * Guard a callback whose contract is synchronous (op run, frame / fixed / render hooks, install, dispose, a listener inside a load): the engine does not await what it
 * returns, so a Promise would count as done while its writes and its failure happen outside the op's rollback, the frame's error tiers or the save's transaction.
 * That is a programming error: dev (and strict, always) throws a coded error naming the callback; release warns once. It never awaits the thenable.
 * Callbacks that DO accept async (module init, a save part's load / afterLoad, flow.transition) must not call this.
 * @param {unknown} r  what the callback returned
 * @param {string} what  who it was: "ops.run('shop.buy')", "hook frame of module fishing"
 * @param {boolean} [strict]  throw in release too (an op: its failure must reach the caller)
 */
export function syncOnly(r, what, strict = false) {
  if (!isThenable(r)) return;
  const text = `${what} returned a Promise, but it must be synchronous: the engine does not wait for it, so what it does after its first await escapes the rollback, error handling or save transaction around it. Do the async work outside (await it first, then call this with the result) and keep this callback plain`;
  if (DEV || strict) throw codedError('engine-misuse', text);
  warnOnce(coded('engine-misuse', text), what);
}
export function warnOnce(msg, key = /** @type {string} */ (msg)) {
  if (typeof msg === 'function' && /** @type {unknown} */ (key) === msg) throw new Error('warnOnce(textFactory, key): a text factory needs a key, or every call is a new function and nothing dedupes');
  if (!enabled() || warned.has(key)) return;
  warned.add(key);
  if (typeof msg === 'function') msg = msg();
  if (DEV) { saidCount++; if (said.length < SAID_MAX) { const h = hintFor(msg); said.push({ code: h?.id ?? null, text: msg.replace(/ \[[a-z][a-z0-9-]*\]$/, ''), fix: h?.cause ?? null }); } }
  console.warn(DEV ? msg + hintText(msg) : msg);   // the fix + doc page only in dev: release builds drop the hint table
}

/** Dev: the warnings said so far on this page, { count, list: [{ code, text, fix }] } (list capped at the first 20), or null when there were none @internal */
export const warningsSaid = () => (saidCount ? { count: saidCount, list: said.map(w => ({ ...w })) } : null);

/**
 * A dev note that is not a problem (a hot swap happened, why a shared value shows another number): console.info with the '[threedog] ' prefix,
 * silenced like warnings by validate: false. Why here and not console.info at the call: one prefix, one switch, one dedupe (R45 flags a bare call).
 * @param {string} msg
 * @param {string} [key]  print once per page for this key; without a key every call prints
 */
export function note(msg, key) {
  if (!enabled() || (key !== undefined && warned.has(key))) return;
  if (key !== undefined) warned.add(key);
  console.info('[threedog] ' + msg);
}

const listText = list => { const a = [...list]; return a.length ? a.slice(0, 15).join(', ') + (a.length > 15 ? fmt(STRINGS.more, { n: a.length }) : '') : STRINGS.none; };

/** Text like 'xxx "name" does not exist, did you mean `yyy`? (available: a, b, c)', shared by errors and warnings. */
export function missingText(kind, name, list) {
  const c = closest(name, list), p = { what: STRINGS.kinds[kind] || kind, name, list: listText(list) };
  return c ? fmt(STRINGS.missing, { ...p, hint: fmt(STRINGS.didYouMean, { name: c }) }) : fmt(STRINGS.missingFar, p);
}
/** A name does not exist: warn once */
export function warnMissing(kind, name, list) {
  // may be called every frame: keyed by the name, so the list text is built only the first time
  if (!enabled() || warned.has(kind + '\0' + name)) return;
  warnOnce(coded('unknown-name', missingText(kind, name, list)), kind + '\0' + name);
}

/**
 * The one unknown-option rule, shared by readParams (options: strict) and checkOptions (extensible data): text for a key not in known, or null when it is fine.
 * Why one function: the "did you mean" search and the wording must not drift between the two readers.
 * soft: a key with no close match is not reported (data like items and template state, where games add their own fields).
 */
export function unknownOptionText(where, key, known, { soft = false } = {}) {
  if (known.includes(key)) return null;
  const c = closest(key, known);
  if (!c && soft) return null;
  return fmt(STRINGS.unknownKey, { where, key, hint: c ? fmt(STRINGS.didYouMean, { name: c }) : fmt(STRINGS.available, { list: known.join(', ') }) });
}

/**
 * Unknown keys in extensible data (item definitions, template instance state, material specs: objects where games add their own fields): warn once.
 * Options bags of public calls do not come here: they go through readParams (core/base/params.js), where an unknown key throws in dev with the
 * did-you-mean and warns once in a release build. Why two kinds: a misspelled option is always a bug and should stop on the spot; extra fields in extensible data may be the game's own, so only near-spellings are hinted (loose).
 * where is the origin (such as 'inventory.define()'), known are the keys the code reads. loose: report only near-misses.
 */
export function checkOptions(where, opts, known, { loose = false } = {}) {
  if (!enabled() || !isOptions(opts)) return;
  for (const k of Object.keys(opts)) {
    const msg = unknownOptionText(where, k, known, { soft: loose });
    if (!msg) continue;
    warnOnce(coded('unknown-option', msg));
  }
}

/**
 * Event name very close to another known event (dev only): warn only when 1 letter differs (2 for long names), to avoid false positives on the game's own
 * events.
 */
export function checkEventName(name, known) {
  const c = closest(name, known, name.length >= 12 ? 2 : 1), digits = s => s.replace(/\d+/g, '#');
  if (c && digits(c) !== digits(name)) warnOnce(coded('event-typo', fmt(STRINGS.eventTypo, { name, hint: c })));
}


/**
 * Freeze a shared definition (content template, item, entity type) and every plain object / array inside it, in place; returns it.
 * Every instance reads the same definition, so a write would silently change all of them: frozen, the write throws instead
 * (error hint 'frozen-definition' says to keep per-instance state on the world record). Functions and class instances are left alone.
 * @example const def = freezeDef({ state: { opened: false } }); def.state.opened = true;   // TypeError: Cannot assign to read only property 'opened'
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function freezeDef(v) {
  if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) freezeDef(v[k]);
  return v;
}

