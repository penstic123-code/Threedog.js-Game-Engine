// HLOD: far buildings as a few proxy meshes.
// Merges far-away buildings into proxy meshes and shows the originals when near: fewer draw calls.
//   engine.use(level({ url }), hlod());              // default: handles the level automatically (on level:loaded)
//   engine.hlod.add(group, { cell: 64, near: 160 }); // or register manually
// How: split into cells of `cell` meters (default = engine.stream cell size); per cell, meshes sharing a material are baked to world space and merged into one proxy mesh;
// a node named xxx_LOD1 is a simplified xxx and is preferred when merging (it stays hidden itself). Merging runs in engine.jobs, spread over frames, so startup does not hitch.
// Every 0.25 s, switch by distance from the full-detail engine.stream sources: cell center farther than `near` meters from all of them shows the proxy and hides originals; with terrain, uses chunk-ring distance (same measure as terrain LOD).
// Merges, never simplifies: engine.assets.lod is the one that lowers one model's triangles (core/assets/assetLod.js says how the neighbours split the work).
// Owns far: batching (engine.batching) owns repeated near props; a mesh hlod registers is marked userData.hlod and batching skips it, and a mesh already
// batched (userData.batched) is skipped here, so the two never fight. Skips vegetation (it has its own instancing and LOD); no mesh simplification; proxies are not raycast (rays only hit originals): originals hidden when far sit on the batch layer, which rays see,
// so engine.raycast still hits far buildings (see core/scene/Rays.js).
// The game's visible stays the game's: a far original moves to the batch layer (RESERVED_LAYERS.batched: not drawn, no shadows, rays hit it), the same way engine.batching
// hides what it draws, so nothing here sits between the game and three.js. A building the game hides (near or far) stays hidden after the switch and is not hit by rays.
// Skips meshes whose material moves vertices (wind and other shadow: true patches): that code reads object space (height above the
// model origin, phase from the origin), so a world-space proxy would sway far more on high ground and every merged object in lockstep.
// Those meshes stay as they are (always drawn) and keep their own sway. Mirrored meshes (negative scale) stay out of the proxies the same way.
// After install, engine.hlod: add() returns a handle { cells, ready (boolean: all proxies merged), whenReady (Promise), remove() }; each cell is { key, proxy, originals, center, far }.
import * as THREE from 'three';
import { mergeCommon } from '../../render/mergeCommon.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { movesVertices } from '../../render/patches.js';
import { warnOnce } from '../../core/base/validate.js';
import { isShown, isUnder } from '../../core/base/util.js';
import { RESERVED_LAYERS } from '../../render/layers.js';
import { unhideMask, FAR_BIT, noRaycast } from '../../render/occlusion.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { Hlod, HlodOptions } from '../../types/world' */

const ADD_KEYS = ['cell', 'near', 'castShadow', 'include'];
const LOD_RE = /_LOD1$/;

const FULL = { detail: 'full' };
const HLOD_PARAMS = keysSchema(['level', ...ADD_KEYS]);

/**
 * HLOD (merge far buildings into a few meshes) -> engine.hlod
 * @param {HlodOptions} [opts]
 * @returns {ModuleDef<Hlod>}
 * @experimental
 */
export function hlod(opts = {}) {
  readParams('hlod', HLOD_PARAMS, opts);
  const { level: autoLevel = true, ...defaults } = opts;
  let e = null, timer = 0, levelHandle = null;
  const handles = new Set();
  const away = new Map();   // far original -> its layer mask before it moved

  /** Far from every full-detail stream source (a 'simple' source keeps the proxy): chunk-ring difference with terrain, else horizontal distance (meters); a source radius caps near.
   *  srcs: [{ x, z, n }] per source with n = its reach for this handle's near, read once per update for all cells */
  function isFar(c, srcs) {
    const CH = e.terrain?.chunkSize;
    for (const f of srcs) {
      if (CH ? Math.max(Math.abs(Math.floor(c.center.x / CH) - Math.floor(f.x / CH)), Math.abs(Math.floor(c.center.z / CH) - Math.floor(f.z / CH))) <= Math.ceil(f.n / CH)
        : Math.hypot(c.center.x - f.x, c.center.z - f.z) <= f.n) return false;
    }
    return true;
  }
  function setFar(c, far) {
    if (c.far === far) return;
    c.far = far;
    // occlusion watches what is on screen. Taking the old watch away first shows anything it hid
    c.watch?.remove();
    for (const p of c.proxy) p.visible = far;
    for (const m of c.originals) {
      if (far && !away.has(m)) { away.set(m, m.layers.mask); m.layers.set(RESERVED_LAYERS.batched); }
      else if (!far && away.has(m)) { m.layers.mask = unhideMask(m.layers.mask, FAR_BIT, away.get(m)); away.delete(m); }
    }
    if (c.watch) c.watch = watch(c);
  }
  const watch = c => e.occlusion.watch(c.far ? c.proxy : c.originals);

  const api = {
    cells: [],
    /** Register objects (root or array) and merge them per cell into proxies; returns handle { cells, ready, whenReady, remove() } */
    add(target, o = {}) {
      readParams('hlod.add()', keysSchema(ADD_KEYS), o);
      const { cell = e.stream.cellSize, near = 160, castShadow = false, include = null } = { ...defaults, ...o };
      const roots = [].concat(target);
      for (const r of roots) r.updateMatrixWorld(true);
      // simplified node xxx_LOD1: record it, hide it
      const lods = new Map();
      for (const r of roots) r.traverse(n => { if (LOD_RE.test(n.name)) lods.set(n.name.replace(LOD_RE, ''), { node: n, used: false }); });
      // originals: visible plain meshes (skip LOD1 subtrees, skinned, instanced, multi-material)
      const originals = [];
      const walk = n => {
        if (!n.visible || LOD_RE.test(n.name)) return;
        if (n.isLOD) return;   // already swaps its own levels: a proxy of it would fight lod.update over what is shown
        // a bundle replays as recorded, so hlod could never hide its meshes: near and far would both draw
        if (n.isBundleGroup) { warnOnce(`hlod.add(): "${n.name || 'a BundleGroup'}" is left out: a BundleGroup draws its own meshes, hlod cannot swap them. Use a plain Group for what hlod should take`); return; }
        if (n.isMesh && !n.isInstancedMesh && !n.isSkinnedMesh && !n.userData.batched && !Array.isArray(n.material) && n.geometry && (!include || include(n))) originals.push(n);
        for (const c of n.children) walk(c);
      };
      roots.forEach(walk);
      // swaying meshes keep their own transform (see header); so do mirrored ones (negative scale): baked into a proxy their faces turn inside out, and only a mesh's own matrix flips the winding back
      for (let i = originals.length; i--;) if (movesVertices(originals[i].material) || originals[i].matrixWorld.determinant() < 0) originals.splice(i, 1);
      for (const m of originals) m.userData.hlod = true;   // engine.batching leaves hlod's meshes alone (marked after the filter: swaying meshes stay batchable)
      // batching may already track one of them, waiting for copies to reach minCount: re-check it now, or the copies that arrive later
      // would batch it anyway and a far cell would draw both the proxy and the batch instance
      if (e.batching) for (const m of originals) e.batching.refresh(m);   // a mesh batching does not track: nothing to re-check
      // the LOD1 copy is only merge material: never drawn, never hit by rays; remove() gives it its visible back
      for (const l of lods.values()) { l.visible = l.node.visible; l.node.visible = false; }
      // split into cells by bounding-box center; where a LOD1 exists, its meshes join the merge instead (each LOD1 used once)
      const cells = new Map(), box = new THREE.Box3(), v = new THREE.Vector3();
      const lodOf = m => { for (let p = m; p; p = p.parent) { const l = lods.get(p.name); if (l) return l; if (roots.includes(p)) break; } return null; };
      for (const m of originals) {
        box.setFromObject(m).getCenter(v);
        const key = Math.floor(v.x / cell) + ',' + Math.floor(v.z / cell);
        const c = cells.get(key) || cells.set(key, { key, proxy: [], originals: [], sources: [], center: new THREE.Vector3(), far: false }).get(key);
        c.originals.push(m); c.center.add(v);
        const l = lodOf(m);
        if (!l) c.sources.push(m);
        else if (!l.used) { l.used = true; l.node.traverse(n => { if (n.isMesh && !Array.isArray(n.material)) c.sources.push(n); }); }
      }
      const group = new THREE.Group();
      group.name = 'hlod'; group.userData.budgetTag = 'hlod'; group.matrixAutoUpdate = false;
      e.add(group, { owner: 'engine:hlod' });
      const list = [...cells.values()];
      for (const c of list) c.center.divideScalar(c.originals.length);
      const h = {
        cells: list, near, ready: false,
        // one step per cell: merge by material into a proxy (spread over frames, at most engine.jobs.budgetMs ms per frame)
        whenReady: e.jobs.add(function* () {
          for (const c of list) {
            if (h.removed) return;
            const byMat = new Map();
            for (const m of c.sources) (byMat.get(m.material) || byMat.set(m.material, []).get(m.material)).push(m);
            for (const [mat, ms] of byMat) {
              const p = new THREE.Mesh(mergeCommon(ms.map(m => m.geometry.clone().applyMatrix4(m.matrixWorld))), mat);
              p.name = 'hlod_' + c.key; p.castShadow = castShadow; p.receiveShadow = true;
              p.matrixAutoUpdate = false; p.visible = false; p.raycast = noRaycast;
              group.add(p); c.proxy.push(p);
            }
            delete c.sources;
            c.watch = watch(c);
            api.cells.push(c);
            yield;
          }
          h.ready = true;
          return h;
        }),
        /** Unregister: restore originals, release proxies */
        remove() {
          h.removed = true; handles.delete(h);
          for (const c of list) { setFar(c, false); c.watch?.remove(); for (const p of c.proxy) p.geometry.dispose(); for (const m of c.originals) { delete m.userData.hlod; e.batching?.refresh(m); } }   // unmarked: batching may take them again (as add() re-checks)
          api.cells = api.cells.filter(c => !list.includes(c));
          for (const l of lods.values()) l.node.visible = l.visible;
          group.removeFromParent();   // proxies share the originals' materials and are never ray-registered: geometries were disposed above
        },
      };
      handles.add(h);
      timer = Infinity;   // switch by distance on the next frame
      return h;
    },
    /** @internal Switch by the current stream sources right now (normally runs automatically every 0.25 s) */
    update() {
      // a cell holding a building the game hid (the mesh or a parent group) stays near: its proxy was merged with that building in it and
      // would draw it far away ("the burnt-down house is back on the horizon"); its other originals draw one by one meanwhile
      // one source query per update serves every cell of every handle
      const src = handles.size ? e.stream.sources(FULL) : [];
      for (const h of handles) {
        const srcs = src.map(f => ({ x: f.x, z: f.z, n: f.reach(h.near) }));
        for (const c of h.cells) if (c.proxy.length) setFar(c, isFar(c, srcs) && c.originals.every(m => isShown(m) && isUnder(m, e.scene)));
      }
    },
  };

  const addLevel = root => { levelHandle?.remove(); levelHandle = root ? api.add(root) : null; };
  return {
    name: 'hlod', skipKind: 'none', type: 'picture', params: HLOD_PARAMS, options: opts, label: 'HLOD', optional: ['terrain', 'level'],
    install(engine, ctx) {
      e = engine;
      e.i18n.add({ 'zh-CN': { 'module.hlod': '远景合并' }, en: { 'module.hlod': 'distant merge' } });
      if (autoLevel) {
        ctx.track(e.events.on('level:loaded', ({ root }) => addLevel(root)));
        ctx.track(e.events.on('level:unloaded', () => addLevel(null)));
        if (e.level?.ready && e.level.root) addLevel(e.level.root);   // install hlod only after the level is ready
      }
      return api;
    },
    frame(dt) { if ((timer += dt) >= 0.25) { timer = 0; api.update(); } },
    // unloaded or rolled back: proxies go, far originals come back off the batch layer
    dispose() { for (const h of [...handles]) h.remove(); },
    describe() { return { cells: api.cells.length, far: api.cells.filter(c => c.far).length }; },
  };
}

export const handRolled = 'none: merging far meshes is plain three.js, used on purpose';
