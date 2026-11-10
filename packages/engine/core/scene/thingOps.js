// engine.thing and the two built-in ops on things (thing.set / thing.remove), plus the 'scene' save part and describe().scene.
// One query and one way to change for both kinds of things: a world record (template instance, prop, pickup, NPC) and a plain three.js object added with
// engine.add. Why both go through ops: a change then has undo, lands in the op log and is checked by can(), whichever system owns the object.
// For a record the ops turn into world.set / world.move / world.remove (the model follows the record); for a plain object they write the transform and,
// when the object has a stable id and is rebuilt by code at setup, record it as an override in the 'scene' save part (things.js).
import { Things, snap, write, moduleOwnerOf } from './things.js';
import { closest, DEV, goodPos } from '../base/validate.js';
import { onSceneRoot } from './sceneDelta.js';
import { codedError } from '../base/errorHints.js';

// ops.undo of a run that failed has no value to reverse: an answer, not a crash
const NOTHING_TO_UNDO = { code: 'nothingToUndo' };

const SAY = {
  record: { keeps: ['record fields and position (world save part)'], loses: ['the built model itself: it is rebuilt from its template / present after a load'] },
  code: { keeps: ['position, rotation, scale, visibility and removal made with thing.set / thing.remove (scene save part)'],
    loses: ['geometry and material changes', 'children added later', 'userData', 'closure state (onFrame callbacks)', 'changes written directly (mesh.position.x = 3)'] },
  session: { keeps: [], loses: ['everything: it exists only in this session and does not come back after a load'] },
  engine: { keeps: [], loses: ['changes written directly: the engine module that owns it rewrites them'] },
};

/** How to change it for good, one line */
function editText(en, tier, rec) {
  if (tier === 'record') return `${rec ?? 'world record'} · thing.set turns into world.set / world.move`;
  const at = en.at ? ` at ${en.at}` : '';
  if (tier === 'engine') return `managed by ${en.owner}: change it through that module, not directly`;
  if (tier === 'code') return `added by code${at} (id '${en.id}'): to change it for good edit that line; thing.set changes are saved as overrides`;
  if (!en.stable) return `added by code${at} without an id: give it one at setup (engine.add(obj, { id: 'name' })) to save thing.set changes; now they last this session only`;
  return `made during play${en.op ? ` by op ${en.op}` : ''}${at}: to keep it, make it a template and create it inside the op with engine.content.spawn(name, at)`;
}

/** A registered plain object as a thing (same shape as hit.thing); `object` is a non-enumerable getter so the result stays JSON-able */
function nativeThing(e, en, root) {
  const tier = e._things.tier(en), say = SAY[tier];
  const out = { id: en.id, kind: root.type, owner: en.owner, at: en.at, phase: en.phase, ...(en.op && { op: en.op, tick: en.tick }), saved: tier,
    keeps: say.keeps, loses: say.loses, edit: editText(en, tier), removed: e._things.gone.has(en.id),
    template: null, definedAt: null, model: null, fields: {} };
  return Object.defineProperty(out, 'object', { get: () => root, enumerable: false });
}

/**
 * The thing for a record id (from a source, see Things.addSource), a registered id / name, or any Object3D (its
 * registered ancestor). null when nothing matches.
 * @internal
 */
export function findThing(e, q) {
  const T = e._things;
  if (typeof q === 'string') {
    if (T.source(q)) return recordAsThing(e, q);
    const o = T.live(q) ?? e.scene.getObjectByName(q);
    return native(e, o && T.entryOf(o));
  }
  if (!q?.isObject3D) return null;
  const id = T.idOf(q);
  return id ? recordAsThing(e, id) : native(e, T.entryOf(q));
}
/** A world-owned entry that world no longer answers for is a torn-down model (template models are only detached): not a thing */
const native = (e, hit) => hit && hit[0].owner !== 'world' ? nativeThing(e, hit[0], hit[1]) : null;
function recordAsThing(e, id) {
  const src = e._things.source(id), r = src.explain(id);
  const out = { ...r, owner: 'world', at: r.definedAt ?? null, phase: r.spawned ? 'play' : 'setup', saved: 'record', ...SAY.record, edit: editText(null, 'record', r.edit) };
  return Object.defineProperty(out, 'object', { get: () => src.view(id), enumerable: false });
}
/** Every id engine.thing knows (for "did you mean") */
function thingIds(e) { return [...e._things.recordIds(), ...e._things.byId.keys()]; }
export const hintThing = (e, id) => { const c = closest(String(id), thingIds(e)); return c ? ` (did you mean '${c}'?)` : ''; };

/** Normalise thing.set args into a patch of arrays (rotation as a number = yaw; scale as a number = uniform) */
function patchOf(o, a) {
  const p = {};
  if (a.position) p.position = Array.isArray(a.position) ? [...a.position] : [a.position.x, a.position.y ?? o.position.y, a.position.z];
  if (a.rotation != null) p.rotation = typeof a.rotation === 'number' ? [o.rotation.x, a.rotation, o.rotation.z] : [...a.rotation];
  if (a.scale != null) p.scale = typeof a.scale === 'number' ? [a.scale, a.scale, a.scale] : [...a.scale];
  if (a.visible != null) p.visible = a.visible;
  return p;
}
const xyz = p => Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p;
/** thing.set args as a record patch. rotation and scale pass as given, a number or [x, y, z], as the record's rot and scale read them */
const recordPatch = a => ({ ...(a.position && { position: xyz(a.position) }), ...(a.rotation != null && { rot: a.rotation }), ...(a.scale != null && { scale: a.scale }) });

/** Register the registry, engine.thing's ops, the 'scene' save part and the session:start setup window (called once by the Engine constructor) */
export function installThings(e) {
  const T = e._things = new Things(e);
  // Adopt-on-add: plain three.js scene.add(obj) registers obj exactly as engine.add(obj) does (engine.thing, describe().scene, thing.set /
  // remove, the save tier), because the owner's rule is that what the engine can see it plugs in without an extra call. Only roots right
  // under the scene: a child added to a root belongs to that root's entry (entryOf walks up). engine.add registers before it attaches,
  // so its options win; a module's own objects carry their module owner (engineOwned) and never count as the game's.
  e._adoptAdds = onSceneRoot(e.scene, o => {
    if (T.byObj.has(o)) return;
    const owner = moduleOwnerOf(o);
    let stack = null;
    if (DEV && !owner && T.wantStack()) {   // frame 0 here, 1 the Object3D.add hook, 2 the game line that called scene.add
      const lim = Error.stackTraceLimit; Error.stackTraceLimit = 4;
      try { stack = new Error(); } finally { Error.stackTraceLimit = lim; }
    }
    T.add(o, owner ? { owner } : null, stack);
  }, o => {
    // Release-on-remove: a root with no stable id taken off the scene (scene.remove of a bullet) is forgotten, else a game adding and
    // removing ten bullets a second grew byId by 36 000 entries an hour, all walked by describe(). Checked after the current code finishes
    // (a microtask), so a remove and re-add on the same line (three's add detaches first, a move between parents) keeps its id;
    // thing.remove's held objects and objects with an id stay (they may come back, the save names them).
    const en = T.byObj.get(o);
    if (!en || en.stable || T.gone.has(en.id) || !(en.owner === 'game' || en.owner.startsWith('engine:'))) return;
    queueMicrotask(() => { let r = o; while (r.parent) r = r.parent; if (r !== e.scene && T.byObj.get(o) === en) T.forget(o); });
  });
  // what a module put in the scene before the registry existed (the default sun and hemisphere are made first) gets its module owner too
  for (const o of e.scene.children) { const owner = moduleOwnerOf(o); if (owner && !T.byObj.has(o)) T.add(o, { owner }, null); }
  T.explainers = [];   // explain contributions from modules (see thingExplain.js)
  /**
   * Add a contribution to engine.explain({ thing: id }): fn(engine, thing, out) may fill out.state / out.rules (or add keys) for the things its module owns.
   * For module authors: core never reads another module's record or template shape, the module hands it over here. A throwing fn is skipped.
   * @param {(e: any, t: any, out: any) => void} fn
   * @example engine.explainWith((e, t, out) => { const r = e.myRecords.get(t.id); if (r) out.state = { ...r }; });
   */
  e.explainWith = fn => { T.explainers.push(fn); return { remove: () => { T.explainers = T.explainers.filter(x => x !== fn); } }; };
  e.saves.define('scene', { atomic: true, save: () => T.save(), load: d => T.load(d) });
  const kindOf = id => T.source(id) ? 'record' : T.live(id) ? T.tier(T.byObj.get(T.live(id))) : null;
  const reasons = {
    noThing: 'no world record or engine.add object has this id (engine.thing(id) suggests the closest one)',
    engineOwned: 'an engine module manages this object (water, particles, physics…); change it through that module',
    recordVisible: 'a world record has no visible flag: hide its model with present({ show: rec => … }) and a field set by world.set',
    badPosition: 'position takes [x, y, z] or { x, y, z } with finite numbers (y may be left out of the object)',
    ownerRefuses: 'what owns this record cannot apply the change (facts.why says why and what to do instead)',
  };
  e.ops.define('thing.set', {
    targets: '*',
    desc: 'Move / turn / scale / show or hide a thing: a world record (via world.set / move; a live character or a body gets it through its owner) or an engine.add object (saved as an override when it has an id)',
    args: { id: 'string', position: 'any?', rotation: 'any?', scale: 'any?', visible: 'bool?' },
    can: (_, a) => {
      const k = kindOf(a.id);
      if (!k || k === 'engine') return k ? 'engineOwned' : 'noThing';
      if (k === 'record' && a.visible != null) return 'recordVisible';
      if (a.position != null && !goodPos(a.position)) return 'badPosition';
      const why = k === 'record' && T.source(a.id).refuses(a.id, recordPatch(a));
      return why ? { code: 'ownerRefuses', facts: { why } } : true;
    },
    run(eng, a) {
      if (kindOf(a.id) === 'record') {
        return { record: true, before: T.source(a.id).set(a.id, recordPatch(a)) };
      }
      const obj = T.live(a.id), p = patchOf(obj, a);
      if (T.tier(T.byObj.get(obj)) === 'code') return T.override(a.id, obj, p);
      const before = { patch: Object.fromEntries(Object.keys(p).map(k => [k, snap(obj)[k]])), had: true, session: true };
      write(obj, p);
      return before;
    },
    canUndo(_, a, v) { if (!v) return NOTHING_TO_UNDO; const why = v.record && T.source(a.id)?.refusesUndo(a.id, v.before); return why ? { code: 'ownerRefuses', facts: { why } } : true; },
    undo(eng, a, v) {
      if (v.record) { T.source(a.id).set(a.id, v.before); return; }
      const obj = T.live(a.id); if (!obj) return;
      write(obj, v.patch);
      if (v.session) return;
      if (!v.had) T.over.delete(a.id); else Object.assign(T.over.get(a.id)?.cur ?? {}, v.patch);
    },
    reasons,
  });
  e.ops.define('thing.remove', {
    targets: '*',
    desc: 'Remove a thing (undoable): a world record via world.remove, or an engine.add object (detached and kept; saved when it has an id)',
    args: { id: 'string' },
    can: (_, a) => { const k = kindOf(a.id); return !k || T.gone.has(a.id) ? 'noThing' : k === 'engine' ? 'engineOwned' : true; },
    run(eng, a) {
      if (kindOf(a.id) === 'record') {
        const src = T.source(a.id);
        return { record: src.remove(a.id), src };
      }
      T.hide(a.id, T.live(a.id), T.tier(T.byObj.get(T.live(a.id))) === 'code');
      return {};
    },
    canUndo: (_, a, v) => v ? true : NOTHING_TO_UNDO,
    undo(eng, a, v) {
      if (!v.record) { T.unhide(a.id); return; }
      v.src.restore(v.record);
    },
    reasons,
  });
}

/** describe().scene: counts by owner and save tier, plus the problems (never the full list: describeText({ path: 'scene' }) is the same object) */
export function describeScene(e) {
  const T = e._things, n = { game: 0, code: 0, session: 0, world: 0, engine: 0 };
  for (const id of [...T.byId.keys()]) {
    const o = T.live(id); if (!o) continue;
    const en = T.byObj.get(o), tier = T.tier(en);
    if (en.owner === 'game') { n.game++; n[tier]++; } else if (tier === 'record') { if (o.parent) n.world++; } else n.engine++;
  }
  const ov = e.debug.overrides();
  const out = { ...n, ...(ov.length && { overrides: ov, overridesNote: 'diagnostic: the screen differs from the real state until engine.debug.clear(owner)' }), unsaved: T.lost().map(en => `${en.id} (${en.at ? en.at + ', ' : ''}${en.phase === 'play' ? 'made during play' : 'no stable id'}${en.op ? ` by op ${en.op}` : ''})`),
    conflicts: [...T.conflicts], orphans: T.orphans() };
  if (T.atCapped) out.atCapped = true;   // dev stacks stopped: later objects have at: null
  return out;
}

/** engine.thing(idOrObj): throws with the closest id when nothing matches @internal */
export function thing(e, q) {
  const t = findThing(e, q);
  if (t) return t;
  const what = typeof q === 'string' ? `'${q}'` : q?.isObject3D ? `an unregistered ${q.type}` : JSON.stringify(q);
  throw codedError('thing-id', `engine.thing(${what}): nothing has this id or name${typeof q === 'string' ? hintThing(e, q) : ''}. Pass a world record id, the id given to engine.add(obj, { id }), an object name or any Object3D in engine.scene (scene.add and engine.add both register; an object not in the scene is not)`);
}
