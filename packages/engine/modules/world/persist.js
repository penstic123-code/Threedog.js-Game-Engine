// World saves and initial records. Rules (independent of the order of content.load):
//   Things written in content (props, pickups, NPCs…) are initial records: add(def, { initial: true }), which needs a stable id.
//   A save only keeps "which fields changed" and "which were removed" (tombstones) for them; runtime-created ones (a tree the player planted, a spawned monster) are saved whole.
//   Load: runtime records are replaced wholesale by the save's; initial records first go back to their original content, then the save's changes are applied; records removed in the save do not reappear.
//   Orphans: a change or removal in the save whose id the content no longer produces (renamed / deleted entry) is kept in _pending / _removed and
//   written back by the next save, never dropped, so reverting the content change gets the player's data back; dev warns once (world.orphans()).
//   Loading before content is loaded works too: changes and removals are remembered and applied / skipped when content is added. Things newly added to content after a game update still show up with an old save.
//   Temporary things (data for effects, one-off spawns): add(def, { save: false }) — not saved, cleared on load.
//   Changes are found by comparing JSON against the original content, not by events: fields changed directly inside simulate are saved too.
// Save format (part 'world', version 5): every record is keyed by its stable id, and only what play changed is stored:
//   { seq, step, time, records: { id: whole runtime record without id }, changed: { id: { set?: changed fields, del?: [removed fields] } },
//     removed: [ids of removed initial records], owed: { id: simulation seconds owed, only for kinds simulated with far },
//     marks: { id: the channel reading its debt counts from, signed, only for kinds on a time channel; a save without them still loads (sim.js) } }
//   Version 1 kept records as an array: migrate step 1 (WORLD_MIGRATE) turns it into the id-keyed object.
//   Version 2 numbered runtime records `<kind>-<n>`; version 3 uses `<kind>#<n>`, so a runtime id can never equal an authored one (authored ids may not
//   contain `#`, content/ids.js). Step 2 renames them (legacyRuntimeIds says which), and the containers part follows with the same map (a template
//   instance's container is keyed by the record id).
//   Version 4: a character's motion (Character.saveMotion: on the player record itself, in rec.motion for NPCs) keeps its jump state as
//   jump: { coyote, used } instead of the flat coyote field (the jump API: air jumps count used jumps). Step 3 moves it.
//   Version 5: an NPC's talk / talkLabel / talkRadius became interact { label, op: 'npc.talk', args: { script }, radius } (talking is one interact op
//   among many). Step 4 moves them, on whole records and on changed fields.
//   Removed fields are recorded separately (not saved as null): after loading it is "no such field", same as in a live run; a field that was null stays null.
//   step / time are the simulation step count and accumulated seconds: far simulation takes turns by step-count buckets, so one save advances the same way every time (see sim.js).

import { legacyRuntimeIds, renameIdKeys, renameIdValues } from '../../core/saves/saveIds.js';
import { codedError } from '../../core/base/errorHints.js';
import { fmt } from '../../core/base/validate.js';
import { isPlainObject, list } from '../../core/base/util.js';
import { refuseSave, checkSaveFile, saveNumberOk, SAVE_MAX, SAVE_MAX_SECONDS } from '../../core/base/saveValues.js';

const PLAIN_STRINGS = {
  msg: "saved world data must be plain values (number, string, boolean, array, plain object): {path} is {what}. A model: world.present('crate', { build: rec => mesh }), then world.view(id) gets it; logic: world.simulate(); not saved: world.add(rec, { save: false })",
  fn: 'a function', obj: 'a three.js object', asset: 'a three.js asset', dom: 'a DOM element', instance: 'a {name}, which comes back from a save as a bare object: write {shape}',
};
/** Dev-time check: data must not contain three.js objects, functions, DOM elements or class instances (saves can only store plain values) @internal */
export function checkPlain(v, path, depth = 0) {
  const fail = what => { throw codedError('world-plain', fmt(PLAIN_STRINGS.msg, { path, what })); };
  if (v == null || typeof v !== 'object') { if (typeof v === 'function') fail(PLAIN_STRINGS.fn); return; }
  const what = v.isObject3D ? PLAIN_STRINGS.obj : v.isMaterial || v.isBufferGeometry || v.isTexture ? PLAIN_STRINGS.asset : typeof Element !== 'undefined' && v instanceof Element ? PLAIN_STRINGS.dom : null;
  if (what) fail(what);
  // a Vector3 or Color passed here and came back from a load as a bare object, so rec.dir.add(...) threw only then
  if (!Array.isArray(v) && !isPlainObject(v)) fail(fmt(PLAIN_STRINGS.instance, { name: v.isVector3 ? 'Vector3' : v.isColor ? 'Color' : 'class instance', shape: v.isVector3 ? '{ x, y, z }' : v.isColor ? 'a number or a string' : 'plain fields' }));   // not constructor.name: a build minifies it
  if (depth > 6) return;
  for (const k in v) checkPlain(v[k], `${path}.${k}`, depth + 1);
}

/** Whether a value can go into a save: what checkPlain accepts @internal */
export function isPlain(v) { try { checkPlain(v, ''); return true; } catch { return false; } }

const CHANGES_MAX = 50;

/** Compare an initial record with its original: which top-level fields changed, which were removed (null if neither) */
function diff(rec, base) {
  let set = null, del = null;
  for (const k in rec) {
    if (rec[k] === undefined) { if (k in base) (del ||= []).push(k); continue; }   // set to undefined = removed
    if (JSON.stringify(rec[k]) !== JSON.stringify(base[k])) (set ||= {})[k] = rec[k];
  }
  for (const k in base) if (!(k in rec)) (del ||= []).push(k);
  return set || del ? { set: set ?? undefined, del: del ?? undefined } : null;
}

const mapValues = (o, f) => o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) : o;

/** Upgrade steps of the world save part (saves.define version 5) @internal */
export const WORLD_MIGRATE = {
  1: d => ({ ...d, records: Object.fromEntries((d?.records || []).map(({ id, ...r }) => [id, r])) }),   // array of records -> keyed by id
  2: d => {   // runtime ids `<kind>-<n>` -> `<kind>#<n>`: record keys, owed keys, and field values that name a renamed record
    const map = legacyRuntimeIds(d);
    if (!map.size) return d;
    return { ...d, records: renameIdValues(renameIdKeys(d.records, map), map), changed: renameIdValues(d.changed, map), owed: renameIdKeys(d.owed, map) };
  },
  3: d => {   // motion coyote -> jump: { coyote, used: 0 } (whole runtime records and changed fields; the player keeps it on the record, NPCs in motion)
    const fix = m => { if (!m || typeof m !== 'object' || !('coyote' in m)) return m; const { coyote, ...rest } = m; return { ...rest, jump: { coyote: coyote ?? 0, used: 0 } }; };
    const rec = r => { const o = fix(r); return o && typeof o === 'object' && o.motion ? { ...o, motion: fix(o.motion) } : o; };
    return { ...d, records: mapValues(d.records, rec), changed: mapValues(d.changed, c => c?.set ? { ...c, set: rec(c.set) } : c) };
  },
  4: d => {   // NPC talk / talkLabel / talkRadius -> interact (records of any kind that carry talk: only NPCs had it)
    const fix = r => {
      if (!r || typeof r !== 'object' || !('talk' in r)) return r;
      const { talk, talkLabel, talkRadius, ...rest } = r;
      return { ...rest, interact: talk ? { label: talkLabel ?? null, op: 'npc.talk', args: { script: talk }, radius: talkRadius ?? 3.2 } : null };
    };
    // a changed entry of an initial NPC: a removed talk means it no longer talks (interact removed). A label / radius alone (set or removed) has no
    // script to build an interact from, so it is dropped and the content's interact stays; a stray key would sit on the record unread
    const OLD = ['talkLabel', 'talkRadius'];
    const strip = s => s && typeof s === 'object' && !('talk' in s) && OLD.some(k => k in s) ? Object.fromEntries(Object.entries(s).filter(([k]) => !OLD.includes(k))) : s;
    const del = l => Array.isArray(l) ? [...new Set(l.filter(k => !OLD.includes(k)).map(k => k === 'talk' ? 'interact' : k))] : l;
    const change = c => c && typeof c === 'object' ? { ...c, ...(c.set && { set: strip(fix(c.set)) }), ...(c.del && { del: del(c.del) }) } : c;
    return { ...d, records: mapValues(d.records, fix), changed: mapValues(d.changed, change) };
  },
};

/**
 * What play changed, for describe().world: totals alone said "same" after a prop moved. changed holds one row per record whose fields differ from its content
 * (runtime records report their kind and place), removed the initial records gone. Capped, with the rest counted, because describe runs after every step and goes
 * to the AI. The player's motion and the player record are left out: describe().player already says where it is, and those fields change every step. So is where a
 * record with motion stands (a walking NPC): it is a new row on every step, and the one thing a command really changed would drop off the line that names it.
 * @param {import('./World.js').World} w @internal
 */
export function worldChanges(w) {
  const rows = [];
  for (const rec of w.records.values()) {
    if (w._unsaved.has(rec.id) || rec.kind === 'player') continue;
    const base = w._base.get(rec.id);
    if (!base) { rows.push({ id: rec.id, kind: rec.kind, runtime: true, ...(!rec.motion && { position: { ...rec.position } }) }); continue; }   // a copy: a kept describe result must not move
    const d = diff(rec, base);
    if (!d) continue;
    const { motion, ...set } = d.set ?? {};
    if (rec.motion) { delete set.position; delete set.rot; }
    if (Object.keys(set).length || d.del) rows.push({ id: rec.id, ...set, ...(d.del && { removedFields: d.del }) });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const removed = [...w._removed].sort();
  return { ...(rows.length && { changed: rows.slice(0, CHANGES_MAX) }), ...(rows.length > CHANGES_MAX && { changedMore: rows.length - CHANGES_MAX }),
    ...(removed.length && { removed: removed.slice(0, CHANGES_MAX) }), ...(removed.length > CHANGES_MAX && { removedMore: removed.length - CHANGES_MAX }) };
}

/** @param {import('./World.js').World} w @internal */
export function saveWorld(w) {
  const records = {}, changed = {};
  for (const rec of w.records.values()) {
    if (w._unsaved.has(rec.id)) continue;
    const base = w._base.get(rec.id);
    if (!base) { const { id, ...r } = rec; records[id] = r; continue; }
    const d = diff(rec, base);
    if (d) changed[rec.id] = d;
  }
  for (const [id, d] of w._pending) changed[id] = d;   // from a save, content not loaded yet this time (e.g. another level): keep as is
  return { seq: w._seq, ...w._s.toJSON(), records, changed, removed: [...w._removed] };
}

// Shape check of a world save before anything is replaced. Why here and not in add(): putPos only checks in dev, and a save bypasses add() entirely,
// so a hand-edited or damaged record ({ x: 1e12, y: null, z: 'abc' }) went straight into the records and threw later in a listener / a mover,
// with the game half-loaded. Refusing throws: saves.apply rolls the whole load back and reports this message (save-bad-record).
const SHAPE_STRINGS = {
  obj: 'must be a plain object', kind: 'must have kind (a string)', pos: `must be { x, y, z } with finite numbers within ±${SAVE_MAX}`,
  arr: 'must be an array of record ids', motion: 'must be a plain object (the character motion state) or null', nav: 'must be a plain object (the NPC path state)', path: 'must be null or a list of { x, z } with finite numbers', link: 'must be null or a link leg with an id and both ends', num: 'must be a finite number within ±{max}', count: 'must be a finite number >= 0', base: 'must be a finite number',
};
/** Throw save-bad-record for the first malformed core field of a world save (fields of the game's own are not checked); kindOf(id) is the kind of an authored record @internal */
function checkWorldSave(d, kindOf, assets) {
  const bad = (path, why, got) => refuseSave('world', path, why, got);
  const pos = (path, p) => { if (!isPlainObject(p) || !['x', 'y', 'z'].every(k => saveNumberOk(p[k]))) bad(path, SHAPE_STRINGS.pos, p); };
  const num = (path, v) => { if (v !== undefined && !(Number.isFinite(v) && v >= 0)) bad(path, SHAPE_STRINGS.count, v); };
  // rec.motion is written in place by Character.saveMotion on every fixed step (npcSim): a number there threw "Cannot create property 'vx'" and froze the game
  // and its numbers feed the mover: a wrong one comes back a step later as a NaN position. The player holds them on the record itself
  const speeds = (path, o) => { for (const k of ['vx', 'vy', 'vz', 'facing', 'amount']) if (o[k] != null && !saveNumberOk(o[k])) bad(`${path}.${k}`, SHAPE_STRINGS.num, o[k]); };
  const motion = (path, m) => { if (m == null) return; if (!isPlainObject(m)) bad(path, SHAPE_STRINGS.motion, m); speeds(path, m); };
  // a link leg on a path point ({ id, from, to }) or the crossing under way ({ link, from, to, seconds, time }): the mover reads them on every step of a crossing
  const leg = (path, l, id) => { if (!isPlainObject(l) || !['string', 'number'].includes(typeof l[id])) bad(path, SHAPE_STRINGS.link, l); pos(`${path}.from`, l.from); pos(`${path}.to`, l.to); };
  // rec.nav of an NPC is written in place the same way, and every NPC has one. Another kind's `nav` is the game's own field
  const nav = (path, v) => {
    if (!isPlainObject(v)) bad(path, SHAPE_STRINGS.nav, v);
    if (v.path != null && !(Array.isArray(v.path) && v.path.every(p => isPlainObject(p) && saveNumberOk(p.x) && saveNumberOk(p.z)))) bad(`${path}.path`, SHAPE_STRINGS.path, v.path);
    v.path?.forEach((p, i) => { if (p.link != null) leg(`${path}.path.${i}.link`, p.link, 'id'); });
    if (v.link == null) return;
    leg(`${path}.link`, v.link, 'link');
    for (const k of ['seconds', 'time']) if (!(saveNumberOk(v.link[k]) && v.link[k] >= 0)) bad(`${path}.link.${k}`, SHAPE_STRINGS.count, v.link[k]);
  };
  // a prop, pickup or NPC builds what its model field says, when it comes near: by then the load is long over, so a URL there stops here
  const model = (path, m) => { const name = list(m)[0]; if (typeof name === 'string') checkSaveFile(assets, 'world', path, name); };
  if (!isPlainObject(d)) bad('the world part', SHAPE_STRINGS.obj, d);
  num('seq', d.seq); num('step', d.step); num('time', d.time);
  if (d.time > SAVE_MAX_SECONDS) bad('time', SHAPE_STRINGS.count, d.time);   // a step no longer moves it: world time stops for good
  // far records take turns in buckets[step % period]: only a whole number lands in one. seq numbers new ids: past safe whole numbers it stops counting and ids repeat
  for (const k of ['step', 'seq']) if (d[k] !== undefined && !Number.isSafeInteger(d[k])) bad(k, SHAPE_STRINGS.count, d[k]);
  for (const f of ['records', 'changed', 'owed', 'marks']) if (d[f] !== undefined && !isPlainObject(d[f])) bad(f, SHAPE_STRINGS.obj, d[f]);
  if (d.removed !== undefined && !(Array.isArray(d.removed) && d.removed.every(id => typeof id === 'string'))) bad('removed', SHAPE_STRINGS.arr, d.removed);
  for (const [id, r] of Object.entries(d.records ?? {})) {
    if (!isPlainObject(r)) bad(`records.${id}`, SHAPE_STRINGS.obj, r);
    if (typeof r.kind !== 'string') bad(`records.${id}`, SHAPE_STRINGS.kind, r.kind);
    pos(`records.${id}.position`, r.position);   // world.add gives every record one, and the cell index reads it
    motion(`records.${id}.motion`, r.motion);
    model(`records.${id}.model`, r.model);
    if (r.kind === 'npc') nav(`records.${id}.nav`, r.nav);
    if (r.kind === 'player') speeds(`records.${id}`, r);
  }
  for (const [id, c] of Object.entries(d.changed ?? {})) {
    if (!isPlainObject(c) || (c.set !== undefined && !isPlainObject(c.set)) || (c.del !== undefined && !Array.isArray(c.del))) bad(`changed.${id}`, SHAPE_STRINGS.obj, c);
    if (c.set && 'position' in c.set) pos(`changed.${id}.set.position`, c.set.position);
    if (c.del?.includes('position')) pos(`changed.${id}.del`, undefined);
    if (c.set) { motion(`changed.${id}.set.motion`, c.set.motion); model(`changed.${id}.set.model`, c.set.model); }
    if (c.set && 'kind' in c.set && typeof c.set.kind !== 'string') bad(`changed.${id}.set`, SHAPE_STRINGS.kind, c.set.kind);
    // shortcut: an NPC whose content loads after the save is not known here, so its changed nav goes unchecked; move the check to where a pending change is applied if a fuzz run reaches it
    if ((c.set?.kind ?? kindOf(id)) === 'npc') {
      if (c.set && 'nav' in c.set) nav(`changed.${id}.set.nav`, c.set.nav);
      if (c.del?.includes('nav')) nav(`changed.${id}.del`, undefined);
    }
  }
  for (const [id, v] of Object.entries(d.owed ?? {})) num(`owed.${id}`, v);
  // a mark is a base, not a count: a record faster than its channel (time.local above 1) moves it below zero, and it can pass any fixed range the same way
  for (const [id, v] of Object.entries(d.marks ?? {})) if (!Number.isFinite(v)) bad(`marks.${id}`, SHAPE_STRINGS.base, v);
}

/** Load: replace runtime records wholesale; loaded initial records go back to the original then get the save's changes; unloaded content waits for its add. Independent of the order of content.load @internal */
export function loadWorld(w, d) {
  checkWorldSave(d, id => w._base.get(id)?.kind, w.engine.assets);   // before anything is cleared: a refused save leaves the world as it was (the rollback then has nothing to undo here)
  // a replacement rebuilds every model (its afterLoad hooks and the physics parts rebuild what they attach for the new state); outside one, an atomic op's
  // rollback puts plain data back and runs no afterLoad, so a model whose record comes back the same stays (views.keepSame)
  const built = w.engine.saves.replacing ? null : new Map(w.records);
  if (!built) w._v.clear();
  w.records.clear(); w._cells.clear(); w._unsaved.clear();
  for (const id of [...w._origin.keys()]) if (!w._base.has(id)) w._origin.delete(id);   // runtime records come from the save now (no op to name)
  w._seq = d?.seq ?? 0;
  w._removed = new Set(d?.removed);
  w._pending = new Map(Object.entries(d?.changed || {}));
  w._s.fromJSON(d);
  renamePending(w);   // content/renames.js, before initial records take their diffs
  for (const [id, base] of w._base) if (!w._removed.has(id)) w._insert(w._fromBase(id, base));
  for (const [id, r] of Object.entries(d?.records || {})) w._insert({ id, ...r });
  if (built) w._v.keepSame(built);
  w.engine.events.emit('world:load', { count: w.records.size });
}

/**
 * Apply content/renames.js to the save data waiting for content: changed fields (_pending), removals (_removed) and owed simulation time move from the old
 * id to the new one; a null target drops them (deleted on purpose, so they are no orphans). Skipped, and returned as 'old (why)', when the old id is still
 * authored (the rename would steal its data) or the new id already has saved data (two saves' worth of state cannot merge): those stay orphans. @internal
 * @param {import('./World.js').World} w
 * @returns {string[]}
 */
export function renamePending(w) {
  const stuck = [], owed = w._s.owed;
  for (const [a, b] of w._renames) {
    const has = w._pending.has(a) || w._removed.has(a) || owed.has(a);
    if (!has) continue;
    if (w._base.has(a)) { stuck.push(`${a} (still defined by content)`); continue; }
    if (b != null && (w._pending.has(b) || w._removed.has(b) || owed.has(b))) { stuck.push(`${a} (${b} already has saved changes)`); continue; }
    if (w._pending.has(a)) { if (b != null) w._pending.set(b, w._pending.get(a)); w._pending.delete(a); }
    if (w._removed.delete(a) && b != null) w._removed.add(b);
    if (owed.has(a)) { if (b != null) owed.set(b, owed.get(a)); owed.delete(a); }
  }
  return stuck;
}
