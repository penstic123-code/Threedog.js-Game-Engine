// Loading a level is the module's content section (core/base/sections.js): prepare builds the new level beside the old one, commit swaps it in.
// st is the module's state (index.js). Nothing live changes before commit, so a level that cannot load leaves the old one playable:
// a save transaction rolls back around it, and the error reaches whoever asked.
// The moments: level:loading (asked for), then level:failed, or level:loaded (state committed: ground, markers, records) and later
// level:playable (every module and required nearby build settled). A load overtaken by a newer one, a save or an unload ends silently: the newest stands and reports. Only the level gives way: the rest of its pack goes in, on the level that won.
import * as THREE from 'three';
import { buildHeightfield } from './heightfield.js';
import { colliderBoxes } from './geometry.js';
import { sortNodes, groundTypeOf, readMarkers, chainHas, chainValue, COL_RE } from './meshes.js';
import { toast } from '../../ui/UI.js';
import { runSections, DROPPED } from '../../core/base/sections.js';
import { whenSettled } from '../../core/engine/headlessLoad.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';

const isScene = v => !!v?.isObject3D;
const nameOf = source => typeof source === 'string' ? source : null;   // code-built scenes have no name: saves record null, no zoning

/** The level section: a file or asset name, or a THREE object, becomes the level; plain { markers } data is the tools' file for a code-built level and loads nothing */
export const levelSection = st => ({
  desc: 'level markers (spawn point, NPCs, trigger zones) of a code-built level: for the tools (content checks, GAMEMAP); load() reads no markers from it. A file or asset name here switches level, as engine.level.load does',
  validate(data) {
    if (typeof data === 'string' || isScene(data) || (data && typeof data === 'object' && !Array.isArray(data))) return;
    throw codedError('content-misuse', `level: expected a file or asset name, a THREE object, or { markers }, got ${JSON.stringify(data)}`);
  },
  prepare: (data, c) => typeof data === 'string' || isScene(data) ? prepareLevel(st, data, c) : null,
  // an overtaken load's pack goes in on the level that won, so it waits to see which. Not for a pack queued behind this one: that one waits for this
  waitFor: p => p && !isNewest(st, p) && st.asks.length && !st.asks.at(-1).behind ? new Promise(res => st.idle.push(res)) : undefined,
  commit: (p, c) => p ? commitLevel(st, p, c) : undefined,
  cancel: p => { if (p) letGo(st, p.ask ?? p); },
  undo: p => p ? backToLevel(st) : undefined,
  get once() { return st.kept; },   // the level came back through the save part: the pack's is older than where the game stood
});

/**
 * The undo of a level swap: the old root left the scene and its memory may be gone, so the old level loads again, by the same road as any level (a failure there is told
 * as a level failure, and reaches whoever asked for the pack: sections.js). Records of its nodes are still in the world. A pack with no level before it ends with no level
 */
function backToLevel(st) {
  const { e, api } = st, root = api.root, source = st.current ?? root, zone = e.world?.zone;
  return () => {
    if (api.root === root) return;
    api.unload();
    if (e.world) e.world.zone = zone;
    if (source) return loadLevel(st, source, false);
  };
}

/** hard: the first load from init() stops start() on its own (the module is critical), so no toast over the loading screen.
 *  async: a scene with nothing to wait for commits on this tick, and any failure still arrives as a rejection */
export async function loadLevel(st, source, hard) {
  await runSections([{ s: st.section, data: source }], { hard });
}

/** The load is over: a failure is told once, here, and passed on. It ends every load before it too: they were already overtaken */
function failLevel(st, source, err, { hard }) {
  const { e } = st;
  dropAsks(st); st.done = true;   // nothing is loading any more
  if (!st.api.root) st.current = null;   // a first load that failed: the save must not name a level that never loaded
  e.events.emit('level:failed', { source: nameOf(source), error: err });
  if (!hard) toast(e, e.t('level.loadFailed', { url: nameOf(source) ?? 'scene' }), { kind: 'error' });
  throw err;
}

/** Is this load the last one asked for? Only that one may commit */
const isNewest = (st, ask) => st.asks.at(-1) === ask && !st.e.disposed;

/** A load that goes no further. e.remove releases a file, so assets.trim can free it; a code-built scene stays the caller's, whole */
function letGo(st, ask) {
  const i = st.asks.indexOf(ask), { root, source, taken = [] } = ask;
  if (i >= 0) st.asks.splice(i, 1);
  ask.leave.abort();   // a file still on its way: this load stops waiting for it, and with no other waiter the download ends
  if (!st.asks.length) st.done = true;
  if (!root) return;
  ask.root = null;
  if (typeof source === 'string') st.e.remove(root); else st.nodeSet.giveBack(taken);
}

/** A save that stays on this level: what is on its way would land on top of it. The first load is the level itself, so it goes on */
export function dropLoad(st) { if (st.api.root) { dropAsks(st); st.done = true; } }

/** No load under way counts any more: each stops waiting for its file (its prepare then ends as an overtaken load does) */
export function dropAsks(st) { for (const ask of st.asks.splice(0)) ask.leave.abort(); }

/** Everything that can fail, away from the live game. Returns what commitLevel needs, or for a file a Promise of it */
function prepareLevel(st, source, c) {
  const { e } = st, ask = { source, behind: !!c.after, leave: new AbortController() };   // grows into the prepared level; behind: a content load queued after an earlier one; leave: stop waiting for the file
  st.asks.push(ask);
  st.done = false;
  e.events.emit('level:loading', { source: nameOf(source) });
  const build = root => {
    Object.assign(ask, readScene(st, root));
    st.nodeSet.check(ask.taken, nameOf(source), root);
    return ask;
  };
  const fail = err => {
    const newest = isNewest(st, ask);
    letGo(st, ask);
    return newest ? failLevel(st, source, err, c) : ask;
  };
  if (isScene(source)) { ask.root = source; try { return build(source); } catch (err) { return fail(err); } }
  return Object.assign(new Promise(res => res(e.assets.wholeModel(source, ask.leave.signal))).then(root => {
    ask.root = root;
    // a newer load / unload / save came while this file loaded (two doors in a row, a save loaded mid-switch): that one owns the level now
    if (!isNewest(st, ask)) { letGo(st, ask); return ask; }
    return build(root);
  }).catch(fail), { ask });   // cancel may come while the file is on its way
}

/** The swap, or giving way to a newer load: the newest level wins, the pack's other sections do not depend on that. Prepare checked what it can, so a throw here is a bug: told like any failure */
function commitLevel(st, p, c) {
  const { e, api } = st;
  if (!isNewest(st, p)) { letGo(st, p); return DROPPED; }
  try {
    api.unload();
    st.done = false;
    e.commits.invalidate();   // background results requested for the old level must not land on the new one
    // world-data zone = level name: other levels' NPCs etc. only lose models, data stays and is rebuilt on return
    if (e.world) e.world.zone = nameOf(p.source);
    st.current = nameOf(p.source);   // before the records are placed: level nodes read it as their zone
    adoptScene(st, p);
    finishLoad(st);
  } catch (err) { failLevel(st, p.source, err, c); }
}

export function finishLoad(st) {
  const { e, api } = st;
  addColliders(st);                  // if the collision module is installed after level, add colliders here
  // nodes tagged template / id become world records (loading is setup, not a gameplay action) before anyone (hlod...) sees level:loaded
  e.ops.allow(() => st.nodeSet.place(st.taken.splice(0)));
  st.done = true;
  e.assets.trim();                   // old level's models have no copies in use: return GPU memory
  e.events.emit('level:loaded', { root: api.root, markers: api.markers, spawn: api.spawn });
  // playable comes later than committed: nav, nearby models and physics start building on level:loaded. This level leaving ends the wait, a load that may not come to anything does not
  const version = st.version;
  st.playable = false;
  whenSettled(e, () => version === st.version, true).then(ok => {
    if (!ok) return;
    st.playable = true;
    e.events.emit('level:playable', { root: api.root });
  }, err => warnOnce(coded('module-not-ready', `level:playable did not come: ${err.message}`)));
}

/** Read a scene without touching the game: classify meshes, build the heightfield, read markers */
export function readScene(st, root) {
  const { e, o } = st;
  root.userData.budgetTag ??= 'level';
  root.updateMatrixWorld(true);
  const taken = st.nodeSet.take(root);   // record nodes leave the level root first: no ground, collision or ray registration for them, and hlod never bakes them
  const { meshes, cols, markerObjs, walk, walkSet } = sortNodes(root, o);
  const t0 = performance.now();   // measure
  const hf = buildHeightfield(walk, { cellSize: o.cellSize, outside: o.outside, typeOf: groundTypeOf(root), sharpEdge: o.sharpEdge, stepUp: e.movement.stepHeight, layerGap: e.movement.height });
  const buildMs = performance.now() - t0;   // measure: heightfield build time (shown in the debug panel)
  const markers = readMarkers(markerObjs, o.hideMarkers);
  const sp = markers.spawn || Object.values(markers).find(m => /^spawn_/i.test(m.name));
  // rays: all meshes; collision meshes and shown non-walkable meshes also occlude the camera, unless a node says userData.occluder = false (a glass roof, a thin railing).
  // col_ meshes are hidden by design and still block; any other hidden mesh is not on screen, so the arm has nothing to avoid
  const blocks = m => chainValue(m, root, 'occluder') !== false, shownHere = m => !chainHas(m, root, p => !p.visible);
  return {
    root, taken, walk, hf, buildMs, markers,
    spawn: sp ? sp.position.clone() : new THREE.Vector3(0, hf.height(0, 0), 0),
    colliders: o.colliders === false ? cols.filter(m => COL_RE.test(m.name) || chainValue(m, root, 'collider')) : cols,
    occluders: [...cols.filter(blocks), ...meshes.filter(m => !walkSet.has(m) && shownHere(m) && blocks(m))],
  };
}

/** A read scene becomes the level. Colliders wait for the collision module (may not be installed at install time) */
export function adoptScene(st, p) {
  const { e, api, o } = st;
  api.root = p.root;
  if (o.addToScene && !p.root.parent) e.add(p.root, { owner: 'level' });
  st.taken = p.taken;
  st.walkMeshes.push(...p.walk);
  st.hf = api.heightfield = p.hf; api.buildMs = p.buildMs;
  api.markers = p.markers; api.spawn = p.spawn;
  st.colliders = p.colliders;
  st.removers.push(e.rays.addStatic(p.root), e.rays.addStatic(p.occluders, { occluder: true }));
  st.trimeshCache = null; st.version++;
  addColliders(st);
}

/**
 * Turn collision meshes into rotated boxes in the collision module (best-fit box by the mesh's world orientation). A level load and a change of collision module ask (ctx.feeds):
 * it acts only when the module holding them is not the one installed now, so one that came late, came back or replaced the old one gets the walls, and the old handles, gone
 * with their module, are dropped. All or none: a module that refuses a box keeps none of them, and its use() fails on that error
 */
export function addColliders(st) {
  if (!st.colliders) return;
  st.wallsIn.sync(() => {
    const ph = st.e.collision, fresh = [];
    if (ph) try {
      for (const b of colliderBoxes(st.colliders, { colliderHeight: st.o.colliderHeight, colliderPad: st.o.colliderPad,
        // `layer` read up the parent chain like occluder: it is often on the col_ / collider object, and a mesh with two materials is a Group of meshes in three
        layerOf: m => chainValue(m, st.api.root, 'layer') })) fresh.push(ph.addBox(b.at, b.opts));
    } catch (err) { for (const h of fresh) h.remove?.(); throw err; }
    st.walls.length = 0; st.walls.push(...fresh);
  });
}
