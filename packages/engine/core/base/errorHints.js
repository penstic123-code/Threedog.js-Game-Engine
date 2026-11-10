// Error hints: "what to do + which doc to read" for any error, so an AI that sees one knows the next step without searching. Appended to
// engine.error (errors.js), warnOnce (validate.js), .threedog/errors.log (vite-error-relay) and the dev bridge `errors` command, all through
// hintText().
//
//   throw codedError('clock-interval', 'clock.every(0): ...')   // err.code, err.fix, err.docs; the message ends with [clock-interval]
//   hintFor('... [world-plain]')                       // { id: 'world-plain', cause: ERROR_CODES fix, docs } (from the tag)
//   hintFor("Cannot read properties of undefined (reading 'give')")   // { id: 'not-installed', ... } (from a pattern)
//
// Two sources, one per kind of message (why: a pattern for a message the engine writes is a second copy that drifts from the message):
//   the engine's own errors carry a stable code (a key of ERROR_CODES) as err.code and as a "[code]" tag at the end of the message;
//   messages the engine does not write (JavaScript, the browser, three.js) are matched by the patterns in ERROR_HINTS.
//
// Doc paths are relative to the package docs (recipes/..., api/..., CONVENTIONS.md), same as the shipped docs.
// Plain data (it imports only errorCodes.js, also plain data), so node tools can load it too. First pattern match wins, so put specific ones first.
import { ERROR_CODES } from './errorCodes.js';
import { docRefsLine } from './docRef.js';
export { docRef, parseDocRef, docRefsLine, docReadCommand, docSlug } from './docRef.js';


/** @typedef {{ id: string, match: RegExp, cause: string, docs: string[] }} ErrorHint */

/** @type {ErrorHint[]} */
export const ERROR_HINTS = [
  // Only messages the engine does not write itself: JavaScript, the browser and three.js. An engine error carries its own code, fix and
  // pages (codedError / coded with an ERROR_CODES entry), so a pattern for it here would be a second copy that drifts from the message.
  // Frozen definitions are plain objects and arrays (freezeDef skips class instances), so the object named in the message must be one of those: a three.js
  // object's read-only `position` / `rotation` (#<Mesh>, or a minified class name) is another cause and gets no hint.
  { id: 'frozen-definition',
    match: /Cannot (assign to read only property '[^']*' of object '(#<Object>|\[object Array\])'|add property [^,]*, object is not extensible|delete property '[^']*' of (#<Object>|\[object Array\]))/,
    cause: 'Definitions (content templates, items, entity types) are shared by every instance and frozen. Keep per-instance ' +
      'state on the world record (engine.world.set(id, { opened: true })) or in its container; define another template for a different kind of thing.',
    docs: ['recipes/30-templates.md §3', 'recipes/18-world.md §2'] },
  // undefined only: a module that is not installed is undefined, never null. A read on null is another cause (null-value below), and
  // calling it "not installed" sent a reader after engine.use() when three.js mergeGeometries had returned null.
  { id: 'not-installed', match: /Cannot read properties of undefined \(reading '[\w$]+'\)|engine\.[\w$]+(\.[\w$]+)* is undefined/,
    cause: 'A plain TypeError: something was undefined where code read a property, and the message does not say which. If the stack line reads engine.<module>, ' +
      'that module is not installed (engine.use(...)) or the code ran before engine.start() finished; otherwise it is a missing object, array item or ' +
      'misspelled field in the game own code. Check the stack for the line.',
    docs: ['recipes/01-new-game.md', 'api/engine.md'] },
  { id: 'null-value', match: /Cannot read properties of null \(reading '[\w$]+'\)|[\w$.]+ is null/,
    cause: 'A value was null where code read a property: a lookup or helper returned null (document.querySelector found nothing; ' +
      'three.js BufferGeometryUtils.mergeGeometries returns null when the geometries have different attributes and logs which one in the ' +
      'console just before). Check the stack for the line and what produced the value.',
    docs: ['THREE.md', 'recipes/16-dev-bridge.md'] },
  // A guessed pause method (the engine has one answer: engine.freeze; `threedog check` asks this entry too, tools/types.mjs)
  { id: 'fall-prevent', match: /\bpreventDefault is not a function/,
    cause: "The character:fall event can no longer be cancelled: falling is the rule 'fall'. To leave a fall to the game: engine.mod('fall', { owner: 'game', id: 'player', set: false }).",
    docs: ['MIGRATING-1.0.md', 'recipes/55-mods-time-wrap.md §"The rules in full"'] },
  { id: 'thing-explain', match: /\.explain is not a function/,
    cause: 'engine.explain is the one way to ask why: what engine.thing(id).explain() gave is engine.explain({ thing: id }).detail.',
    docs: ['MIGRATING-1.0.md', 'recipes/40-scene.md §9'] },
  { id: 'pause-guess', match: /\b(?:time\.(?:pause|stop|resume)|engine\.(?:pause|resume|stop)) is not a function/,
    cause: 'The engine has no pause method of that name. To pause the world call engine.freeze(owner): it returns the handle that releases it ' +
      '(handle.remove()); settings({ freezeWorld: true }) does it for a menu.',
    docs: ['recipes/07-flow-scenes-pause.md §1', 'api/engine.md'] },
  { id: 'not-function', match: /[\w$.]+ is not a function/,
    cause: 'The method name is wrong, or the module is not installed (the property is then undefined). Check spelling against api/<module>.md.',
    docs: ['api/engine.md', 'CODEMAP.md'] },
  { id: 'resource-load', match: /Failed to load <(img|script|link|audio)/,
    cause: 'The browser could not load a file the page references (404 or wrong type). Check the path (files under public/ are served ' +
      'from /), the extension and the case of the name.',
    docs: ['api/assets.md', 'recipes/05-props-bake.md §2d'] },
];


const TAGS = /\[([a-z][a-z0-9-]*)\]/g;
/**
 * The code a message is tagged with: the last "[word]" that is a known code or hint id, else null.
 * Why known-only and last: messages also hold other brackets ("[engine] ... threw", "[threedog] patch ..."), and single-word codes
 * (container, movement) look like them; the code is appended at the end.
 * @param {string} s
 */
function tagOf(s) {
  let tag = null;
  for (const m of s.matchAll(TAGS)) if (ERROR_CODES[m[1]] || ERROR_HINTS.some(h => h.id === m[1])) tag = m[1];
  return tag;
}

/** The hint for a message: its "[code]" tag first (ERROR_CODES or a hint id), else the first pattern that matches; null if none. @param {unknown} message */
export function hintFor(message) {
  const s = String(message ?? ''), tag = tagOf(s), c = tag && ERROR_CODES[tag];
  return (c ? { id: tag, cause: c.fix, docs: c.docs } : tag && ERROR_HINTS.find(h => h.id === tag)) || ERROR_HINTS.find(h => h.match.test(s)) || null;
}

/**
 * Machine-readable view of any error: its code, the fix and the pages to read (err.code first, else the hint for its message; nulls when unknown).
 * @param {any} err
 * @returns {{ code: string | null, fix: string | null, docs: string[] }}
 */
export function errorInfo(err) {
  const h = hintFor(err?.code ? `[${err.code}]` : err?.message ?? err);
  return { code: err?.code ?? h?.id ?? null, fix: err?.fix ?? h?.cause ?? null, docs: err?.docs ?? h?.docs ?? [] };
}

/**
 * An Error with a stable code: err.code, err.fix (what to do), err.docs (pages to read); the message ends with "[code]".
 * @param {string} code  a key of ERROR_CODES or an ERROR_HINTS id
 * @param {string} message  English: what is wrong and how to fix it
 * @param {ErrorConstructor} [Type]  Error by default (TypeError for a wrong argument type)
 * @returns {Error & { code: string, fix: string | null, docs: string[] }}
 * @example throw codedError('clock-interval', 'clock.every(0): seconds must be > 0');
 */
export function codedError(code, message, Type = Error) {
  const err = /** @type {any} */ (new Type(coded(code, message)));
  return Object.assign(err, errorInfo({ code }));
}

/** A message tagged with its code, for warnings: warnOnce(coded('save-refused', text)). @param {string} code @param {string} message */
export function coded(code, message) { return `${message} [${code}]`; }

/** Indented lines "Code" (when the message has no [code] tag) + "Possible cause" + "Read"; '' if no hint matches. @param {unknown} message */
export function hintText(message) {
  const h = hintFor(message);
  if (!h || ERROR_CODES[h.id]?.brief) return '';
  return (tagOf(String(message)) ? '' : `\n  Code: ${h.id}`) + `\n  Possible cause: ${h.cause}\n  Read: ${docRefsLine(h.docs)}`;
}
