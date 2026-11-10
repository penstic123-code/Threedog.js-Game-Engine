// engine.catalog(): what this game can do, read from the registrations that already exist (module definitions, ops.define,
// saves.define, describe.add, module hooks, params schemas). Why a reader and not a registry: a second list would drift from the code;
// this file runs no gameplay and stores only who registered what (so an op or save part can be traced back to its module).
//   engine.catalog()            -> short list, one line of data per module (+ 'core' and 'game' for what no module registered)
//   engine.catalog('shop')      -> one module expanded: dependencies, ops with args / defaults / failure codes, saved parts, time model
//   engine.catalog('shop.buy')  -> one op expanded (args schema, reasons, its last attempt)
//   engine.catalog({ find: 'buy' }) -> the short list filtered by id, label, op or save name
//   engine.catalog('post')      -> a capability that is no module (post chain, shadows): its entry names and what it holds now
//   engine.catalog('picture')   -> the picture menu: every picture capability, on or not, can it run here, cost, one way on, limits (pictureMenu.js)
// Ownership: engine.use / module init take a snapshot of the op, save and describe names before and after (catalogSnap / catalogClaim);
// what existed before the first engine.use is 'core', what appeared outside any module is 'game'. An op named '<module>.verb' or a save
// part keyed by the module name belongs to that module even when registered later (from game code calling into the module).
import { parseSchema, schemaInfo } from '../base/params.js';
import { ENGINE_PARAMS } from '../engine/Engine.js';
import { SKIP_KINDS, TIME_HOOKS } from '../engine/moduleTypes.js';
import { pictureMenu } from './pictureMenu.js';

const MAX_API = 200;   // the dev bridge narrows this to what the api page lists (tools/threedog/catalog.mjs)

const keysOf = e => [
  ...[...e.ops.defs.keys()].map(k => 'op:' + k),
  ...[...e.saves.providers.keys()].map(k => 'save:' + k),
  ...[...(e.describe?._extras?.keys() ?? [])].map(k => 'describe:' + k),
];
const track = e => e._catalog ??= { core: null, owner: new Map() };

/** @internal before a module's install / init: names registered so far (the first call also fixes what counts as core) */
export function catalogSnap(e) {
  const c = track(e), now = new Set(keysOf(e));
  c.core ??= now;
  return now;
}
/** @internal after it: the names that appeared since snap belong to that module */
export function catalogClaim(e, name, snap) {
  const c = track(e);
  for (const k of keysOf(e)) if (!snap.has(k) && !c.owner.has(k)) c.owner.set(k, name);
}

/** Who registered this 'op:x' / 'save:x' / 'describe:x' name: a module name, 'core' or 'game' */
function ownerOf(e, key) {
  const c = track(e), claimed = c.owner.get(key);
  if (claimed && e.modules.has(claimed)) return claimed;
  const [type, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const guess = type === 'op' ? name.split('.')[0] : name;
  if (e.modules.has(guess)) return guess;
  return c.core?.has(key) ? 'core' : 'game';
}
function owned(e, id) {
  const out = { op: [], save: [], describe: [] };
  for (const k of keysOf(e)) if (ownerOf(e, k) === id) { const i = k.indexOf(':'); out[k.slice(0, i)].push(k.slice(i + 1)); }
  return out;
}

/** A value shown in the catalog: plain data as is, anything else only by kind (functions, three.js objects are not JSON) */
function toData(v) {
  if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
  if (typeof v === 'function') return '<function>';
  if (Array.isArray(v)) return v.length <= 8 && v.every(x => x == null || typeof x !== 'object') ? v : `<array of ${v.length}>`;
  return Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length <= 8 ? v : '<object>';
}

function opInfo(e, name, full) {
  const d = e.ops.defs.get(name), args = schemaInfo(d.shape);
  const o = { name, desc: d.desc, args, failures: Object.keys(d.reasons || {}) };
  if (!full) return o;
  const last = e.ops.recent(name).at(-1);
  return { id: name, kind: 'op', owner: ownerOf(e, 'op:' + name), ...o, reasons: d.reasons || {}, can: !!d.can, offers: !!d.offers,
    undo: !!d.undo, net: d.net ?? 'host', last: last ? { tick: last.tick, ok: last.ok, code: last.code, args: last.args, source: last.source } : null };
}
function saveInfo(e, key) {
  const p = e.saves.providers.get(key);
  return { key, version: p.version, ...(p.first !== undefined && p.first !== false ? { first: p.first } : {}), ...(Object.keys(p.migrate || {}).length ? { migrates: Object.keys(p.migrate).map(Number) } : {}) };
}

/** Public methods and properties of a module's api object (own and inherited, no _private ones) */
function apiNames(api) {
  if (!api || typeof api !== 'object') return [];
  const out = new Set();
  for (let o = api; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && !k.startsWith('_') && out.size < MAX_API) out.add(k);
  return [...out];
}

/** Time model: which loop hooks it has, and how engine.skip advances it (skipKind) */
function timeOf(m) {
  const hooks = TIME_HOOKS.filter(h => typeof m[h] === 'function');
  return { hooks, step: m.fixed ? 'fixed' : m.frame ? 'frame' : 'none', skip: !!m.skip, ...(m.skipKind ? { kind: m.skipKind } : {}), ...(m.noSkip ? { noSkip: m.noSkip } : {}) };
}

function optionalOf(e, m) {
  const opt = m.optional;
  if (!opt) return [];
  const list = Array.isArray(opt) ? opt.map(n => [n, null]) : Object.entries(opt);
  return list.map(([name, lost]) => ({ name, installed: e.modules.has(name), ...(lost ? { lost } : {}) }));
}

function paramsOf(m) {
  if (!m.params) return null;
  const info = schemaInfo(parseSchema(`module ${m.name} params`, m.params));
  if (m.options) for (const k in info) if (m.options[k] !== undefined) info[k].value = toData(m.options[k]);
  return info;
}

function problemsOf(e, m, entry) {
  const out = [];
  if (entry.state === 'failed') out.push('init failed (engine.errors has the reason); no hooks run');
  if (entry.state === 'disabled') out.push('switched off after it threw while running; no hooks run until it is installed again');
  for (const b of entry.blockedBy) out.push(`blocked: requires ${b.requires}, and ${b.module} is ${b.state}; no init, no hooks until it runs`);
  for (const g of e._contractGaps()) if (g.module === m.name) out.push(`capability ${g.cap}: the contract lists ${g.missing.join(', ')}, which this module's API lacks; a caller of one crashes`);
  if ((m.fixed || m.skip) && !m.skipKind) out.push(`no skipKind: declare how engine.skip advances it (${SKIP_KINDS.join(', ')})`);
  if (['approx', 'step'].includes(m.skipKind) && !m.skip) out.push(`skipKind '${m.skipKind}' but no skip hook: engine.skip does not advance it`);
  for (const o of entry.optional) if (!o.installed && o.lost) out.push(`optional ${o.name} missing: ${o.lost}`);
  return out;
}

function moduleEntry(e, m) {
  const id = m.name, own = owned(e, id);
  const entry = {
    id, kind: 'module', ...(m.label ? { label: m.label } : {}), state: e.moduleStates[id], stage: m.stage ?? 'late', runIndex: e.moduleOrder.indexOf(id),
    critical: !!m.critical, requires: m.requires ?? [], optional: optionalOf(e, m), time: timeOf(m), params: paramsOf(m),
    blockedBy: e._modBlocked.get(id) ?? [],
    resources: [...(e._modTracked.get(id) ?? [])].filter(h => h.kind).map(h => `${h.kind}:${h.id}`),
    ops: own.op.map(n => opInfo(e, n, false)), saves: own.save.map(k => saveInfo(e, k)),
    queries: { describe: m.describe ? `describe().${id}` : null, extra: own.describe.map(n => `describe().${n}`), api: apiNames(e[id]) },
    ...(m.docs ? { docs: m.docs } : {}),
  };
  entry.problems = problemsOf(e, m, entry);
  return entry;
}
function looseEntry(e, id) {
  const own = owned(e, id);
  return { id, kind: id, ops: own.op.map(n => opInfo(e, n, false)), saves: own.save.map(k => saveInfo(e, k)),
    queries: { describe: null, extra: own.describe.map(n => `describe().${n}`), api: [] }, problems: [],
    // core params are createEngine() options: same schema, values read from engine._createParams (same shape as module params)
    ...(id === 'core' ? { params: paramsOf({ name: 'core', params: ENGINE_PARAMS, options: e._createParams }) } : {}) };
}

// Not modules, but a reader asks for them the same way. Read live from the object, so nothing here can drift
const CAPABILITIES = {
  post: e => ({ describe: 'describe().render', facts: { antialias: e.post.antialias, ownedByGame: !e.post._own.on,
    effects: e.post._list.map(h => ({ name: h.name, slot: h.slot, order: h.order, enabled: h.enabled, params: Object.fromEntries(Object.entries(h.params).map(([k, v]) => [k, toData(v)])) })) } }),
  shadows: e => ({ describe: 'describe().picture', facts: { enabled: e.shadows.enabled, cascades: !!e.shadows.csm } }),
};
/**
 * One lookup scheme for every name: 'module:<id>', 'op:<name>', 'capability:<id>' always mean that kind; a bare name tries the engine's few
 * capability names first (fixed and documented, where a game's module names are not), then modules, ops, 'core' / 'game'.
 */
const KINDS = ['module', 'op', 'capability'];
const isCapability = (e, n) => n === 'picture' || (Object.hasOwn(CAPABILITIES, n) && !!e[n]);
function lookup(e, kind, n, o) {
  if ((!kind || kind === 'capability') && isCapability(e, n)) return n === 'picture' ? pictureMenu(e, o) : capabilityEntry(e, n);
  if ((!kind || kind === 'module') && e.modules.has(n)) return moduleEntry(e, e.modules.get(n));
  if ((!kind || kind === 'op') && e.ops.defs.has(n)) return opInfo(e, n, true);
  if (!kind && (n === 'core' || n === 'game')) return looseEntry(e, n);
  return null;
}
function capabilityEntry(e, id) {
  const { describe, facts } = CAPABILITIES[id](e);
  return { id, kind: 'capability', ops: [], saves: [], queries: { describe, extra: [], api: apiNames(e[id]) }, facts, problems: [] };
}

function summary(x) {
  const s = { id: x.id, kind: x.kind };
  if (x.label) s.label = x.label;
  if (x.state) s.state = x.state;
  if (x.stage) s.stage = x.stage;
  s.ops = x.ops.map(o => o.name);
  s.saves = x.saves.map(p => p.key);
  if (x.time) s.time = [x.time.step, x.time.skip ? 'skip' : null].filter(Boolean).join('+');
  if (x.problems.length) s.problems = x.problems.length;
  if (x.blockedBy?.length) s.blockedBy = x.blockedBy;
  return s;
}

function entries(e) {
  const out = [...e.modules.values()].map(m => moduleEntry(e, m));
  for (const id of ['core', 'game']) { const x = looseEntry(e, id); if (x.ops.length || x.saves.length || x.queries.extra.length) out.push(x); }
  for (const id of Object.keys(CAPABILITIES)) if (e[id] && !e.modules.has(id)) out.push(capabilityEntry(e, id));
  return out;
}

/**
 * What this game can do, from the registrations that already exist (modules, ops, save parts, describe, params schemas); no second list to keep in sync.
 * No argument: a short list (id, state, stage, op and save names, time model, problem count). A module id: that module expanded
 * (requires / optional, params with defaults and the values in use, ops with args schema and failure codes, saved parts and versions,
 * time hooks and skip kind, describe fields and api names, problems such as "no skipKind"). An op name: that op expanded, with its last attempt.
 * Names: 'module:<id>', 'op:<name>', 'capability:<id>' pick the kind; a bare name tries the capabilities ('picture', 'post', 'shadows') first, then
 * modules, ops, 'core' / 'game' (a capability sharing its name with a module says sameNameModule: 'module:<id>').
 * 'post' or 'shadows': that capability's entry names and what it holds now (effects in the chain, cascades on or off).
 * 'picture': the picture menu (three's features and post effects, one row each: on, runs here, cost class, one way on, recipe, main limit) and the
 * combination checks; o.offered: effect factories not in the chain yet (the dev bridge passes @threedog/post-effects).
 * The dev bridge `threedog catalog [id]` prints the same data and adds the doc, recipe and source files.
 * @param {string | { find?: string }} [id] @param {{ offered?: any[] }} [o]
 * @returns {any}
 * @example engine.catalog();               // [{ id: 'calendar', kind: 'module', state: 'running', stage: 'environment', ops: [], saves: ['calendar'], time: 'fixed+skip' }, ...]
 * engine.catalog('shop').ops[0];           // { name: 'shop.buy', args: { n: { type: 'int', optional: true, default: 1 } }, failures: ['soldOut', 'noMoney'] }
 * engine.catalog('shop.buy').last;         // { tick: 812, ok: false, code: 'noMoney', ... }
 * engine.catalog({ find: 'throw' });       // only entries whose id, label, op or save mentions "throw"
 */
export function catalog(e, id, o) {
  if (typeof id === 'string') {
    const i = id.indexOf(':'), kind = KINDS.includes(id.slice(0, i)) ? id.slice(0, i) : null, name = kind ? id.slice(i + 1) : id;
    const x = lookup(e, kind, name, o);
    // a capability name the game also gave a module (the game template's 'picture' module): the bare name stays the capability, the module is a prefix away
    if (x && !kind && x.kind !== 'module' && e.modules.has(name)) x.sameNameModule = `module:${name}`;
    return x;
  }
  const list = entries(e).map(summary);
  const q = id?.find?.toLowerCase();
  return q ? list.filter(s => [s.id, s.label, ...s.ops, ...s.saves].some(x => x?.toLowerCase().includes(q))) : list;
}
