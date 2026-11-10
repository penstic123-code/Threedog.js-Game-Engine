// Save format and per-part versions. A save is the envelope { format, savedAt, versions: { part: n }, parts: { part: data } }:
//   format is the version of the envelope itself (FORMAT); a save from a newer format is refused as a whole, one without format is format 1.
//   Each saves.define part carries its own version and migrate steps, so one module changing its format never touches the others; a part missing from versions is version 1.
// Everything here runs before a load touches the game, and on a copy: a refused load leaves the game and the stored save as they were.
import { codedError } from '../base/errorHints.js';
import { fmt } from '../base/validate.js';

/** Version of the save envelope. Raise it only when the envelope itself changes shape (never for a part's data: that is the part's own version). */
export const FORMAT = 1;

const DEV = {
  badVersion: "saves.define('{k}'): version must be a whole number >= 1 (raise it by 1 whenever this part's saved data changes shape), got {v}",
  badMigrate: "saves.define('{k}'): migrate is { fromVersion: data => newData }, e.g. migrate: { 1: d => ({ ...d, gold: 0 }) }; key {m} is not a version below {v}",
  tooNew: "[saves] not loaded: {list}. The save comes from a newer build of the game, which this build cannot read; nothing was changed and the save is kept. " +
    'To read it, run the newer build, or raise this part\'s version (with migrate steps) to match.',
  format: 'the save envelope is format {f}, this build reads up to format {max}',
  corrupt: "[saves] not loaded: slot '{slot}' is not a readable save ({why}). Nothing was changed and the stored save is kept as it was.",
  noStep: "save part '{k}' is version {from} but this build is version {to}, and migrate has no step {from}: add migrate: { {from}: data => newData } to saves.define('{k}')",
};

// first: true loads before the rest (rank 0); a number ranks it (lower earlier: the level 0, the zones that need the level 1); no first = after them all
const firstRank = p => p.first === true ? 0 : Number.isFinite(p.first) ? p.first : Infinity;
/**
 * Validate a part's version and migrate steps at register time (a typo shows up at once, not when an old save happens to be read).
 * @param {string} key
 * @param {number} version
 * @param {Record<string, Function>} migrate
 * @returns {void}
 * @internal
 */
export function checkPartVersion(key, version, migrate) {
  if (!Number.isInteger(version) || version < 1) throw codedError('save-version', fmt(DEV.badVersion, { k: key, v: version }));
  for (const [m, fn] of Object.entries(migrate)) {
    if (!/^[1-9]\d*$/.test(m) || Number(m) >= version || typeof fn !== 'function') throw codedError('save-version', fmt(DEV.badMigrate, { k: key, m, v: version }));
  }
}

/** JSON reviver for save data from outside (stored text, imported files): drops "__proto__" keys, which Object.assign would turn into a prototype swap */
const clean = (k, v) => (k === '__proto__' ? undefined : v);

/**
 * Parse save text (or copy a save object) into a fresh, prototype-safe object. Throws on unreadable text.
 * @param {string | object} json
 * @returns {any}
 * @internal
 */
export function parseSave(json) { return JSON.parse(typeof json === 'string' ? json : JSON.stringify(json), clean); }

/**
 * A part's saved version; one the table does not have is version 1. Part names are the game's: 'constructor' finds Object's own in a plain lookup, as `in` does on parts.
 * @param {Record<string, number> | undefined} versions
 * @param {string} k
 * @returns {number}
 * @internal
 */
export function partVersion(versions, k) { return versions && Object.hasOwn(versions, k) ? versions[k] : 1; }

/**
 * Upgrade one part's data from its saved version to the current one, step by step (on a copy: the caller's save stays as it was).
 * @param {string} key
 * @param {{ version: number, migrate: Record<string, (d: any) => any> }} p
 * Each step gets (data, save): save is { parts, versions } of the whole save as read (before any part was upgraded), read only. It is there because
 * some upgrades depend on another part: the world part renaming runtime ids (`kind-3` -> `kind#3`) means every other part that keys data by a record id
 * (containers) has to rename the same ids, and only the world part's records tell which ids those are.
 * @param {any} data
 * @param {number} from
 * @param {{ parts: Record<string, any>, versions: Record<string, number> }} [save]
 * @returns {any}
 * @internal
 */
export function upgradePart(key, p, data, from, save = { parts: {}, versions: {} }) {
  if (from >= p.version) return data;
  let d = structuredClone(data);
  for (let v = from; v < p.version; v++) {
    const fn = p.migrate[v];
    if (!fn) throw codedError('save-refused', fmt(DEV.noStep, { k: key, from: v, to: p.version }));
    d = fn(d, save) ?? d;
  }
  return d;
}

/**
 * Everything that can be checked before a load touches the running game: readable JSON, the envelope format, the save shape, no part from a newer build,
 * every migrate step present. Returns the parsed save (prototype-safe), the upgraded registered parts (in load order) and the parts no registered module owns
 * (kept, so a save does not lose them), or the reason the load is refused.
 * @param {string | object | undefined} json  the stored save text, or a save object
 * @param {Map<string, { version: number, first: boolean, migrate: Record<string, Function> }>} providers
 * @param {string} slot  for the message only
 * @returns {{ data: any, list: [string, any, any][], foreign: { parts: Record<string, any>, versions: Record<string, number>, whole: any } } | { reason: 'missing' | 'corrupt' | 'tooNew' | 'migrate', dev: string }}
 * @internal
 */
export function readSave(json, providers, slot) {
  if (json == null) return { reason: 'missing', dev: `[saves] slot '${slot}' does not exist` };
  let data;
  try { data = parseSave(json); } catch (e) { return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: e.message }) }; }
  if (!data?.parts || typeof data.parts !== 'object' || Array.isArray(data.parts)) return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: 'no parts' }) };
  const format = data.format ?? 1;
  if (!Number.isInteger(format) || format < 1) return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: `format ${JSON.stringify(data.format)}` }) };
  if (format > FORMAT) return { reason: 'tooNew', dev: fmt(DEV.tooNew, { list: fmt(DEV.format, { f: format, max: FORMAT }) }) };
  // a null part is damage, not "empty": world.fromJSON(null) used to load as an empty world and wipe the playthrough. The writer never writes one
  // (collectParts leaves out a part whose save() returns null / undefined), so only a hand edit or a broken file has it
  const nul = Object.keys(data.parts).filter(k => data.parts[k] === null);
  if (nul.length) return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: `part${nul.length > 1 ? 's' : ''} ${nul.map(k => `'${k}'`).join(', ')} is null` }) };
  // versions decide which migrate steps run: a value that is no whole number passes every comparison, so no step ran and load() got the old shape. Parts nobody owns here
  // count too: a part registered later reads its version from this table. Only a missing table means version 1
  const versions = data.versions === undefined ? (data.versions = {}) : data.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: `versions ${JSON.stringify(versions)}` }) };
  const odd = Object.keys(versions).filter(k => !Number.isInteger(versions[k]) || versions[k] < 1);
  if (odd.length) return { reason: 'corrupt', dev: fmt(DEV.corrupt, { slot, why: `version of ${odd.map(k => `'${k}'`).join(', ')}` }) };
  const list = [...providers].filter(([k]) => Object.hasOwn(data.parts, k)).sort((a, b) => { const x = firstRank(a[1]), y = firstRank(b[1]); return x < y ? -1 : x > y ? 1 : 0; });   // stable: equal ranks keep install order
  const newer = list.filter(([k, p]) => partVersion(versions, k) > p.version).map(([k, p]) => `part '${k}' is version ${versions[k]}, this build reads up to ${p.version}`);
  if (newer.length) return { reason: 'tooNew', dev: fmt(DEV.tooNew, { list: newer.join('; ') }) };
  // whole: the save as read, for migrate steps that need another part (upgradePart); kept on foreign so a part registered later (adoptPart) sees it too
  const whole = { parts: data.parts, versions }, foreign = { parts: {}, versions: {}, whole };
  for (const k of Object.keys(data.parts)) if (!providers.has(k)) { foreign.parts[k] = data.parts[k]; foreign.versions[k] = partVersion(versions, k); }
  try { return { data, foreign, list: list.map(([k, p]) => [k, p, upgradePart(k, p, data.parts[k], partVersion(versions, k), whole)]) }; } catch (e) { return { reason: 'migrate', dev: e.message }; }
}
