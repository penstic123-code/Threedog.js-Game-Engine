// The editor's one door to the design data (plan docs/plans/done/2026-11-05-editor.md, "窄层"). Everything that knows what a content entry looks like in this
// page is here: the field names, what a place does to an offset, what each kind of entry can do. The editor's screen gets a neutral entry and calls these
// functions, so a different content format changes this file and content-write.mjs, not the screen (rule R54 keeps it so).
//
// What is compared on a write is what the FILE said when the entry was selected, never the running game: a chest the player moved is not a design value.
//
// How the running game follows a saved change: the record is taken out and the entry is loaded again from the file's text (follow). Why not patch the record:
// what a field does to a record (y to a height, place to a facing, cell to a position, body to a rigid body) lives in the content loader, and a second copy here
// would drift. So one path serves every property, a physics body, a grid item, a new entry and an undo, and the record equals its baseline, so nothing lands in
// the save. What the loader cannot take alone (an entry with computed values, an NPC) reloads the page, which is always true; the history survives that.
//
// One step at a time (inTurn): every exported function that changes the file waits for the step before it. Why here and not in the screen: the history undoes its
// own work by position, and an expect is only right against the file as the last step left it, so a step must start from the newest entry (fresh), not the one
// the screen held when the user let go.

import { metadata } from 'threedog/metadata';

const WHY = {
  code: 'not in the content files, so it cannot be saved',
  noPlace: 'this kind of entry has no position here: edit the file',
  noStart: 'it starts from its schedule, which has no one position: edit the file',
};
const isLive = kind => !!metadata.sections[kind]?.live;   // the loader can take one entry of this kind; anything else reloads the page
const HISTORY = 'threedog-editor-history', KEEP = 100, EPS = 1e-4, APART = 1;   // APART: metres between entries added from one view
/** The facing in a file's or a record's rot: a number, or the y of [x, y, z] (rotOf in modules/content/models.js; the editor sees only the package's public files) */
const yawOf = rot => (Array.isArray(rot) ? rot[1] : rot) ?? 0;
const round = v => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r; };   // a millimetre: no 3.4000000000000004 in a hand-kept file
const fileValues = new WeakMap();   // entry -> { fields, kind, computed, file, line } as read from the file; private so the screen cannot grow a dependency on them

// never rejects: a server that went away is one more refusal, on a read as on a write, and the screen has one way to show it
const post = body => fetch('/__threedog/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  .catch(e => ({ ok: false, error: `the dev server did not answer (${e.message})` }));
const editorRun = (engine, op, args) => engine.ops.run(op, args, { source: 'editor' });

// The history: file changes and how to take each back. Every step carries expect, so an undo over a hand edit is refused like any other stale write
const history = { done: [], undone: [] };
try { Object.assign(history, JSON.parse(sessionStorage.getItem(HISTORY))); } catch { /* blocked or empty storage: the history lives until the page goes */ }
const keep = () => { try { sessionStorage.setItem(HISTORY, JSON.stringify(history)); } catch { /* same */ } };

let tail = Promise.resolve(), leaving = false;   // leaving: a step reloads the page; what is queued behind it would write against a page that is going
const inTurn = job => { const out = tail.then(() => leaving ? { reloading: true } : job()); tail = out.catch(() => {}); return out; };
const newest = new Map();   // id -> the entry last read from the file
const fresh = entry => newest.get(entry.id) ?? entry;

const spotOf = (kind, f) => kind === 'npcs' ? f.start : f;   // the object that holds place / x / z: an NPC keeps them in start
const isGrid = f => f.grid != null;

/** Why an entry read from the file cannot be moved here, or null */
function whyFixed({ kind, fields, computed }) {
  const axes = kind === 'npcs' ? ['start'] : isGrid(fields) ? ['cell'] : ['x', 'z', 'place'];
  const bad = computed.find(k => axes.includes(k) || k === '...');
  if (bad) return `${bad} is computed by code: edit the file`;
  if (kind === 'npcs') return fields.start && typeof fields.start === 'object' ? null : WHY.noStart;
  return isLive(kind) ? null : WHY.noPlace;
}

/** The running game's side of an id: its record and model; a record not built yet has no object */
function liveOf(engine, id) {
  const rec = engine.world?.get(id);
  return { rec, object: rec ? engine.world.view(id) ?? null : null };
}

/** What the screen holds for one entry, from what the file says now */
async function neutral(engine, thing) {
  const { rec, object } = liveOf(engine, thing.id), p = rec?.position ?? (thing.object ?? thing).position;
  const entry = { id: thing.id, at: thing.definedAt ?? null, position: { x: p.x, y: p.y, z: p.z }, yaw: object?.rotation.y ?? yawOf(rec?.rot), object: object ?? thing.object ?? null,
    movable: false, removable: false, height: false, turn: false, why: WHY.code };
  if (!thing.definedAt) return entry;
  const r = await post({ op: 'read', id: thing.id, ...(rec?.kind === 'npc' && { kind: 'npcs' }) });
  if (!r.ok) return { ...entry, why: r.error };
  const why = whyFixed(r), plain = r.kind === 'props' && !isGrid(r.fields), quarter = r.kind === 'props' && isGrid(r.fields) && !r.computed.includes('rotation');
  const out = { ...entry, at: `${r.file}:${r.line}`, why, movable: !why, removable: !r.computed.includes('...'), // computed values go with the cut; only a spread hides what else the entry would bring back
    height: !why && (plain || r.kind === 'pickups'), turn: !why && (plain || quarter) };
  fileValues.set(out, r);
  newest.set(out.id, out);
  return out;
}

/**
 * What the editor knows about a thing it was handed.
 * @param {any} engine
 * @param {any} thing  from pickAt or thingAt
 * @returns {Promise<any>} { id, at, position, yaw, object, movable, removable, height, turn, why } or null
 */
export const entryAt = async (engine, thing) => thing ? neutral(engine, thing) : null;

/** The thing with this id, or null when it is gone @param {any} engine @param {string} id */
export function thingAt(engine, id) { try { return engine.thing(id); } catch { return null; } }

/**
 * The thing under a screen point. engine.pick looks at what is registered as static; what moves on its own (static: false, an NPC) is not, so the built models
 * of the world are asked as well, and the nearer hit wins.
 * @param {any} engine @param {number} x  ndc @param {number} y  ndc
 */
export function pickAt(engine, x, y) {
  const views = engine.world ? engine.world.query({}).map(r => engine.world.view(r.id)).filter(Boolean) : [];
  const fixed = engine.pick(x, y), moving = views.length ? engine.pick(x, y, { targets: views }) : null;
  const thing = (moving && (!fixed || moving.distance <= fixed.distance) ? moving : fixed)?.thing;
  return thing?.id ? thing : null;   // a mesh nobody named (engine.rays.addStatic alone) is hit, but there is no entry behind it
}

/** The model on screen for an entry now: a save builds a new one, so the selection box asks every frame @param {any} engine @param {any} entry */
export const modelOf = (engine, entry) => liveOf(engine, entry.id).object ?? entry.object;

/** The cell of a grid item at a world point, and that cell's centre */
function cellAt(engine, f, to) {
  const g = engine.grids.get(f.grid), cell = g.toCell(to.x, to.z), { x, z } = g.toWorld(cell);
  return { g, cell, x, z };
}

const QUARTER = Math.PI / 2, quarterOf = yaw => Math.round(yaw / QUARTER);   // a grid item faces in quarter turns only
const previewed = new Set();   // ids a drag has moved: only those need putting back. A press that moved nothing must not write a rot the record never had

/**
 * Move the real model while a handle is dragged. Only the picture: nothing is saved until the handle is let go, and letting go loads the entry from the file anyway.
 * @param {any} engine @param {any} entry @param {{ x: number, y: number, z: number, yaw: number }} to
 */
export function previewEntry(engine, entry, to) {
  previewed.add(entry.id);
  const f = fileValues.get(entry)?.fields, { object } = liveOf(engine, entry.id);
  const at = f && isGrid(f) ? { ...to, ...cellAt(engine, f, to), yaw: quarterOf(to.yaw) * QUARTER } : to;
  // a rigid body owns its object (the record follows the view) and the frozen game steps no physics, so the object is the thing to move
  if (object?.userData.body) { object.position.set(at.x, at.y, at.z); object.rotation.y = at.yaw; return; }
  editorRun(engine, 'thing.set', { id: entry.id, position: { x: at.x, y: at.y, z: at.z }, ...(entry.turn && { rotation: at.yaw }) });
}

const gridProblem = (g, f, id, cell, rotation) => { const { code } = g.check(f.item, cell, { rotation, ignore: id }); return code ? `cell ${cell} is not free (${code})` : null; };

/** The file's values for a pose given in world terms: only what really moved, so an axis left alone stays as the author wrote it */
function poseFields(engine, entry, to) {
  const { fields: f, kind } = fileValues.get(entry);
  if (isGrid(f)) {
    const { g, cell } = cellAt(engine, f, to), was = f.rotation ?? 0, out = {};
    // the short way round, counted in quarter turns: the record faces rotation * a quarter, so the file's number follows the same count
    const turns = entry.turn ? quarterOf(Math.atan2(Math.sin(to.yaw - entry.yaw), Math.cos(to.yaw - entry.yaw))) : 0, rotation = (((was + turns) % 4) + 4) % 4;
    if (String(cell) !== String(f.cell)) out.cell = cell;
    if (rotation !== was) out.rotation = rotation;
    if (!Object.keys(out).length) return {};
    const why = gridProblem(g, f, entry.id, cell, rotation);
    if (why) throw new Error(why);
    return out;
  }
  const spot = spotOf(kind, f), base = spot.place ? engine.content.place(spot.place) : null;
  const off = engine.content.offset(spot.place ?? null, to.x, to.z), next = { x: round(off.x), z: round(off.z) }, out = {};
  for (const k of ['x', 'z']) if (next[k] !== round(spot[k] ?? 0)) out[k] = next[k];   // rounded alike: 1.23456 in the file is not a move of the axis left alone
  if (kind === 'npcs') return Object.keys(out).length ? { start: { ...spot, ...out } } : {};
  if (entry.height && Math.abs(to.y - entry.position.y) > EPS) {
    // y is metres above the ground, so what the ground did between the two spots comes off: on a slope a sideways move alone writes no height at all
    const floor = f.floor ?? base?.y, ground = (x, z) => { const h = engine.surface(x, z, floor); return Number.isFinite(h) ? h : 0; };
    const y = round((f.y ?? 0) + to.y - entry.position.y - ground(to.x, to.z) + ground(entry.position.x, entry.position.z));
    if (y !== (f.y ?? 0)) out.y = y;
  }
  // by how much it turned, the short way round: a file may say 7, and the handle only knows angles up to a half turn
  const turned = Math.atan2(Math.sin(to.yaw - entry.yaw), Math.cos(to.yaw - entry.yaw));
  if (entry.turn && Math.abs(turned) > EPS) out.rot = Array.isArray(f.rot) ? [f.rot[0], round(f.rot[1] + turned), f.rot[2]] : round((f.rot ?? 0) + turned);
  return out;
}

/** The two steps of a change of fields: forward, and back to what the file said */
function setSteps(entry, fields, unset = []) {
  const { fields: f, kind } = fileValues.get(entry), id = entry.id, names = [...Object.keys(fields), ...unset];
  const was = k => f[k] ?? null, now = k => k in fields ? fields[k] : unset.includes(k) ? null : was(k);
  // place belongs to every expect: an offset means nothing against another place
  const watched = [...new Set([...names, ...(kind === 'npcs' || isGrid(f) ? [] : ['place'])])];
  return {
    fwd: { op: 'write', id, kind, fields, unset, expect: Object.fromEntries(watched.map(k => [k, was(k)])) },
    // spot: a field cut by this step goes back in front of the one that followed it, so the file reads as it did and not with the field at the end
    back: { op: 'write', id, kind, fields: Object.fromEntries(names.filter(k => f[k] != null).map(k => [k, f[k]])), unset: names.filter(k => f[k] == null), expect: Object.fromEntries(watched.map(k => [k, now(k)])),
      spot: Object.fromEntries(unset.filter(k => f[k] != null).map(k => [k, Object.keys(f)[Object.keys(f).indexOf(k) + 1]]).filter(([, next]) => next)) },
  };
}

/** Take the record out for good: thing.remove keeps it in the op log, forget drops the baseline the content gave it */
function leave(engine, id) {
  if (engine.world.get(id)) { const r = editorRun(engine, 'thing.remove', { id }); if (!r.ok) throw new Error(`thing.remove refused (${r.code})`); }
  engine.world.forget(id);
}

const nextFrame = () => new Promise(requestAnimationFrame);

/** Make the running game what the file says for this id; { reload: true } when only a page load can. A file that took the change is not taken back here: act decides that */
async function follow(engine, step, r) {
  const id = step.id ?? step.entry.id;
  if (step.op === 'remove') { leave(engine, id); return isLive(step.kind) ? {} : { reload: true }; }
  const now = await post({ op: 'read', id, kind: r.kind });
  if (!now.ok) throw new Error(now.error);
  if (now.computed.length || !isLive(now.kind)) return { reload: true };
  leave(engine, id);
  engine.content.load({ [now.kind]: [{ id, ...now.fields }] });
  engine.world.setOrigin(id, { definedAt: `${now.file}:${now.line}` });
  for (let i = 0; i < 60 && !engine.world.view(id); i++) await nextFrame();   // the model is built a frame or more later; the box and the next pick need it
  return {};
}

/** Send one step and bring the game along. The screen gets the reply and the fresh entry to hold */
async function run(engine, step, id) {
  const r = await post(step);
  if (!r.ok) return { ok: false, error: r.error, conflict: !!r.conflict };
  const out = { ok: true, change: r.change, restore: r.restore };
  try {
    const { reload } = await follow(engine, step, r);
    if (reload) { leaving = true; keep(); location.reload(); return { ...out, reloading: true }; }
  } catch (e) { return { ...out, ok: false, cause: e.message, error: `saved, but this page could not follow (${e.message}): reload it` }; }
  const thing = step.op === 'remove' ? null : thingAt(engine, id);
  return { ...out, entry: thing ? await neutral(engine, thing) : null };
}

/** Do a step for the first time: on the history, and what could be redone is gone. back null: a remove, whose way back is in its own reply */
async function act(engine, fwd, back, id) {
  // the history is written first for a step that reloads the page: run does not come back from that
  const pending = { id, fwd, back };
  const { done } = history, before = history.undone;
  done.push(pending); history.undone = [];
  const r = await run(engine, fwd, id);
  if (!r.ok && !r.change) { done.pop(); history.undone = before; keep(); return r; }
  // the file took it and the game cannot load it (a place that does not exist): left there, the next start fails, and with the game down there is no editor to undo in
  if (!r.ok && back && (await run(engine, back, id)).ok) { done.pop(); history.undone = before; keep(); return { ok: false, error: `not kept: the game cannot load that (${r.cause})` }; }
  pending.back ??= { op: 'restore', id, kind: fwd.kind, ...r.restore };
  if (done.length > KEEP) done.shift();   // only now: a refused step must not cost the oldest good one
  keep();
  return r;
}

/**
 * Save a new pose for a movable entry: the file first, the running game only when the file took it. Refused: the model goes back where it stood.
 * @param {any} engine
 * @param {any} held  from entryAt
 * @param {{ x: number, y: number, z: number, yaw: number }} to  world pose
 * @returns {Promise<{ ok: boolean, error?: string, conflict?: boolean, change?: string, entry?: any, reloading?: boolean }>} entry: the one to hold from now on
 */
export const moveEntry = (engine, held, to) => inTurn(async () => {
  const entry = fresh(held), stay = () => { if (previewed.has(entry.id)) { previewEntry(engine, entry, { ...entry.position, yaw: entry.yaw }); previewed.delete(entry.id); } };
  let fields;
  try { fields = poseFields(engine, entry, to); } catch (e) { stay(); return { ok: false, error: e.message }; }
  if (!Object.keys(fields).length) { stay(); return { ok: true, entry }; }
  const { fwd, back } = setSteps(entry, fields), r = await act(engine, fwd, back, entry.id);
  previewed.delete(entry.id);
  if (!r.ok && !r.change) { previewed.add(entry.id); stay(); }
  return r;
});

// A yes/no is a list with an empty first line, not a checkbox: most of these mean yes when the file says nothing (static, batch, occluder), and an empty box would show the opposite
const YES_NO = [true, false];
const inputOf = spec => spec.values || /^bool/.test(spec.type) ? 'select' : { number: 'number', int: 'number', string: 'text' }[spec.type] ?? 'json';

/**
 * The rows of the property panel: the field table of this kind of entry (engine.content.fields, the one the content check reads) plus whatever else the file has.
 * @param {any} engine @param {any} entry
 * @returns {{ key: string, label: string, rare: boolean, input: 'number' | 'text' | 'select' | 'json', value: any, values?: any[], placeholder?: string, desc?: string, locked: boolean }[]}
 */
export function fieldsOf(engine, entry) {
  const v = fileValues.get(entry);
  if (!v) return [];
  const { fields: f, kind, computed } = v, specs = { ...(kind === 'npcs' ? {} : engine.content.fields(isGrid(f) ? 'props.grid' : f.template ?? kind)) };
  const models = catalog(engine).filter(c => c.model).map(c => c.name);
  for (const k of Object.keys(f)) specs[k] ??= { type: typeof f[k] };
  if (specs.model && models.includes(f.model)) specs.model = { ...specs.model, values: models };
  return Object.entries(specs).filter(([k]) => k !== 'id').map(([key, s]) => ({
    key, label: s.label ?? key, rare: !!s.rare && f[key] == null, input: inputOf(s), value: f[key] ?? null, ...(inputOf(s) === 'select' && { values: s.values ?? YES_NO }), ...(s.default !== undefined && { placeholder: JSON.stringify(s.default) }),
    ...(s.desc && { desc: s.desc }), locked: computed.includes(key) }));
}

/** The value a row's input means; throws why not */
function parseRow(row, raw) {
  if (row.input === 'number') { const n = Number(raw); if (!Number.isFinite(n)) throw new Error(`${row.key}: not a number`); return n; }
  if (row.input === 'json') {
    try { return JSON.parse(raw); } catch { if (/^\s*[[{"]/.test(raw)) throw new Error(`${row.key}: not valid JSON`); return raw; }   // a bare word is a string; a broken list is a typo
  }
  if (row.input === 'select') { const hit = row.values.find(v => String(v) === String(raw)); if (hit === undefined) throw new Error(`${row.key}: not one of ${row.values.join(', ')}`); return hit; }
  return String(raw);
}

/** Why a row's value cannot stand, for what only the running game can tell: the drag asks the grid the same, and an NPC reloads the page, where a place that is not there stops the game before any editor opens */
function whyNot(engine, entry, key, value) {
  const { fields: f, kind, computed } = fileValues.get(entry), other = { start: 'schedule', schedule: 'start' }[key];
  if (kind === 'npcs' && value == null) {
    if (key === 'name') return 'an NPC needs a name';
    if (other && f[other] == null && !computed.includes(other)) return 'an NPC needs a start or a schedule: without one the game stops at load';
    return null;
  }
  try {
    if (isGrid(f) && (key === 'cell' || key === 'rotation')) return gridProblem(engine.grids.get(f.grid), f, entry.id, key === 'cell' ? value : f.cell, key === 'rotation' ? value : f.rotation ?? 0);
    if (kind === 'npcs' && key === 'start') { if (!value || typeof value !== 'object') return 'start: write { "x": 1, "z": 2 } or { "place": "name" }'; engine.content.where(value); }
  } catch (e) { return `${key}: ${e.message}`; }
  return null;
}

/**
 * Save one property from the panel. An empty value takes the field out of the entry.
 * @param {any} engine @param {any} held @param {string} key @param {any} raw  what the input holds
 */
export const setField = (engine, held, key, raw) => inTurn(async () => {
  const entry = fresh(held), row = fieldsOf(engine, entry).find(r => r.key === key), had = fileValues.get(entry).fields[key];
  if (!row) return { ok: false, error: `${key} is not a field of this entry` };
  if (row.locked) return { ok: false, error: `${key} is computed by code: edit the file` };
  if (raw === '' || raw == null) {
    if (had === undefined) return { ok: true, entry };
    const why = whyNot(engine, entry, key, null);
    if (why) return { ok: false, error: why };
    const { fwd, back } = setSteps(entry, {}, [key]), r = await act(engine, fwd, back, entry.id);
    // what the entry then does is the default, which may well put the model elsewhere: said here, so the jump has a reason and the way back
    return r.ok ? { ...r, change: `${row.label} emptied, so it uses its default. Undo brings back ${JSON.stringify(had)}` } : r;
  }
  let value;
  try { value = parseRow(row, raw); } catch (e) { return { ok: false, error: e.message }; }
  if (JSON.stringify(value) === JSON.stringify(had)) return { ok: true, entry };
  const why = whyNot(engine, entry, key, value);
  if (why) return { ok: false, error: why };
  const { fwd, back } = setSteps(entry, { [key]: value });
  return act(engine, fwd, back, entry.id);
});

/**
 * What can be placed: the game's templates and named models. An entry stands for something the game already has.
 * @param {any} engine
 * Items defined in the inventory are listed too: placing one writes a pickup of it (pickups are the content kind for "an item lying on the ground").
 * @returns {{ name: string, model: boolean, pickup?: boolean }[]}
 */
export function catalog(engine) {
  const models = [...engine.assets.entries.values()].filter(a => a.type === 'model' && a.named).map(a => a.name);
  const items = engine.pickups && engine.inventory?.defs ? [...engine.inventory.defs.keys()] : [];
  return [...(engine.describe().content?.templates ?? []).map(name => ({ name, model: false })), ...models.map(name => ({ name, model: true })), ...items.map(name => ({ name, model: false, pickup: true }))];
}

/**
 * Write a new entry into the game's props (or pickups, for an item) and place it in the running game.
 * @param {any} engine @param {{ name: string, model: boolean, pickup?: boolean }} what  from catalog @param {{ x: number, z: number }} near  world position
 */
export const addEntry = (engine, what, near) => inTurn(async () => {
  // beside whatever already stands here: Add twice from one view would put the second exactly inside the first, and nothing on screen would change
  const at = { x: near.x, z: near.z }, taken = engine.world.query({}).map(r => r.position).filter(Boolean);
  while (taken.some(p => Math.hypot(p.x - at.x, p.z - at.z) < APART / 2)) at.x += APART;
  let n = 1;
  // the file too: an entry collected in play or in another zone has no live record, and its id is still taken
  while (engine.world.get(`${what.name}-${n}`) || (await post({ op: 'read', id: `${what.name}-${n}` })).ok) n++;
  const kind = what.pickup ? 'pickups' : 'props', id = `${what.name}-${n}`;
  const entry = { id, [what.pickup ? 'item' : what.model ? 'model' : 'template']: what.name, x: round(at.x), z: round(at.z) };
  return act(engine, { op: 'add', kind, entry }, { op: 'remove', id, kind, expect: entry }, id);
});

/**
 * Take an entry out of its file and out of the running game. Undo puts the same bytes back in the same spot.
 * @param {any} engine @param {any} held
 */
export const removeEntry = (engine, held) => inTurn(() => {
  const entry = fresh(held), { fields, kind } = fileValues.get(entry);
  return act(engine, { op: 'remove', id: entry.id, kind, expect: fields }, null, entry.id);
});

/** Walk the history one step: the same writes, the same refusals. Refused, the step stays where it is, so nothing is lost by trying */
async function walk(engine, from, to, way) {
  const step = from.at(-1), other = way === 'back' ? 'fwd' : 'back';
  if (!step) return { ok: false, error: `nothing to ${way === 'back' ? 'undo' : 'redo'}` };
  to.push(from.pop());   // before the write, for a step that reloads the page
  keep();
  const r = await run(engine, step[way], step.id);
  if (!r.ok && !r.change) { from.push(to.pop()); keep(); return r; }
  if (r.restore && step[other].op === 'restore') { step[other] = { op: 'restore', id: step.id, kind: step.fwd.kind, ...r.restore }; keep(); }
  return r;
}

/** Take back the last saved change @param {any} engine */
export const undo = engine => inTurn(() => walk(engine, history.done, history.undone, 'back'));
/** Do again what undo took back @param {any} engine */
export const redo = engine => inTurn(() => walk(engine, history.undone, history.done, 'fwd'));
