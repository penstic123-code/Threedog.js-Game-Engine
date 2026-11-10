// engine.assets.lod(name) and a prop's `lod: true` (helper of Assets.js): one object as a plain THREE.LOD over the level files `threedog assets optimize --lod` wrote.
// three.js does the switching (the renderer calls lod.update for WebGL and WebGPU), so lod.levels, lod.addLevel and lod.autoUpdate stay the game's to read and replace.
// What differs from its neighbours, each owning a different job so they never fight over one mesh:
//   this:            ONE heavy model, fewer triangles far away, per object, no merging. Costs its own draw calls.
//   engine.hlod:     MANY static level objects merged into one proxy per cell: fewer draw calls, same triangles unless a node xxx_LOD1 exists. Skips LOD objects.
//   vegetation:      plants, instanced per chunk; lodGeometry swaps by chunk ring. Thousands of copies, a job THREE.LOD cannot do one object at a time.
//   engine.batching: many copies of a light model as one InstancedMesh. Instances share one geometry, so a copy cannot change level alone: a LOD object is never
//                    batched (userData.batch = false). Choosing LOD gives batching up for that object, hence the warning at MANY_COPIES.
// The full model stays the real one: level 0 is an ordinary copy, collision and saves read the model or record and never see a level, and rays hit level 0 at any
// distance. Far off it sits on the batch layer with its visible true (RESERVED_LAYERS.batched: not drawn, no shadows, engine.rays hit it), the way hlod hides its far
// originals, so it is one way of hiding for all three. Low meshes are marked userData.lodLevel, which rays and rays.addStatic leave out. A game's own THREE.Raycaster
// ignores visible but obeys layers, so it cannot reach a far full mesh: the level on screen passes the ray on to it, and the hit still names the full mesh.
// Popping: no crossfade (it would need a transparent pass per material, a look the game did not ask for). Hysteresis stops the flicker at a boundary; the error
// limit of the tool keeps the jump small, and a game that wants a fade has plain meshes in lod.levels to fade.
import * as THREE from 'three';
import { warnOnce, DEV } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';
import { notePatch, patchOn } from '../scene/threePatches.js';
import { RESERVED_LAYERS } from '../../render/layers.js';
import { unhideMask, FAR_BIT } from '../../render/occlusion.js';

const HYSTERESIS = 0.1;      // share of a level's distance: coming back needs 10% more, so a camera resting on the line does not flicker
// Default distance of level i, in lengths of the model's diagonal. Why relative: one number in meters is wrong for a chair and for a tower alike, while a model
// this many of its own lengths away covers the same part of the screen whatever its size.
const FIRST_LENGTHS = 8, STEP = 3;
const MANY_COPIES = 32;      // from here the draw calls batching would have saved usually outweigh the triangles

notePatch('lod-view-camera', 'update and clone on the THREE.LOD objects of assets.lod: only the engine camera moves the level, and a far full model waits on the batch layer instead of visible = false', () => {},
  { scope: 'LOD objects made by assets.lod and props with lod', lost: 'LOD objects made after it keep three\'s own update and clone: every camera moves the level (the shadow camera too, on WebGPU) and level 0 hides by visible, so far rays miss it. For one object: delete lod.update while level 0 shows (done far off, the full model stays on the batch layer)' });

/**
 * The level follows what the player sees. Why: WebGPURenderer walks the scene again for each shadow map and calls lod.update with the shadow camera, which stands far
 * off, so every model ended the frame on its lowest level (measured on real WebGPU: main camera level 0, shadow camera level 2). Shadows were always the coarsest,
 * getCurrentLevel() lied, and hysteresis, which reads visible, stopped working. WebGLRenderer's shadow pass does not do this, so the two now agree.
 * three hides level 0 with visible = false, which rays obey, so that is undone here and the model moves to the batch layer. Layers are per object, not inherited, hence
 * the walk; it runs every far frame so that something the game hangs on the model while far goes with it, and costs no more than the walk three now does anyway.
 * clone: the copy would inherit far masks with no record of what they were, and draw nothing when near, so the masks go home first; the next update moves them again.
 */
function driveLevels(lod, engine) {
  if (!patchOn('lod-view-camera')) return;
  const pick = lod.update, away = new Map();   // object of the full model -> its layer mask before it moved
  const moveAway = o => { if (!away.has(o)) { away.set(o, o.layers.mask); o.layers.set(RESERVED_LAYERS.batched); } };
  const bringBack = () => { for (const [o, mask] of away) o.layers.mask = unhideMask(o.layers.mask, FAR_BIT, mask); away.clear(); };
  lod.update = function (camera) {
    if (camera !== engine.camera) return;
    pick.call(this, camera);
    if (this.getCurrentLevel() === 0) { bringBack(); return; }
    const full = this.levels[0].object;
    full.visible = true;
    full.traverse(moveAway);
  };
  lod.clone = function (recursive) {
    bringBack();
    const copy = THREE.LOD.prototype.clone.call(this, recursive), fullMeshes = meshesOf(copy.levels[0].object);
    driveLevels(copy, engine);
    for (const { object } of copy.levels.slice(1)) passRays(object, fullMeshes);
    return copy;
  };
}

const meshesOf = root => { const out = []; root.traverse(m => { if (m.isMesh) out.push(m); }); return out; };

/** A level is never hit itself. While it is on screen it hands a ray that cannot see the full mesh over to that mesh; a ray that can see it (near, or engine.rays) hits it directly, so never twice */
function passRays(level, fullMeshes) {
  meshesOf(level).forEach((m, j) => {
    const f = fullMeshes[j];
    m.raycast = (ray, out) => { if (level.visible && !f.layers.test(ray.layers)) f.raycast(ray, out); };
  });
}

function readDistances(d) {
  if (d === undefined) return null;
  if (!Array.isArray(d) || d.some((x, i) => !(x > 0) || (i && x <= d[i - 1]))) throw codedError('asset-lod', `assets.lod(): distances must be rising positive meters, like [40, 120] (got ${JSON.stringify(d)})`);
  return d;
}

/**
 * Wrap one copy of a model. scale: what the copy will be scaled by, so default distances follow its size on screen.
 * @param {any} a the Assets instance  @param {string} name  @param {THREE.Object3D} full  @returns {Promise<THREE.LOD>}
 */
export async function wrapLod(a, name, full, opts = {}) {
  // `full` is the caller's already (a lease, a clone's bones): a LOD that cannot be made gives it back, so a rejected call leaves nothing counted
  try { return await assemble(a, name, full, opts); } catch (err) { a.dropCopy(full); throw err; }
}
async function assemble(a, name, full, { distances, hysteresis = HYSTERESIS, scale = 1 } = {}) {
  const asked = readDistances(distances), e = a.entries.get(name), lod = new THREE.LOD();
  lod.name = full.name;
  Object.assign(lod.userData, { batch: false, ...(full.userData.modelName && { modelName: full.userData.modelName }) });
  lod.animations = full.animations;
  driveLevels(lod, a.engine);
  lod.addLevel(full, 0, hysteresis);
  const urls = e?.load?.owner === e || !e?.load ? e?.opts.lods ?? [] : [];   // a model that fell back shows another file: its levels would not match
  if (DEV && !urls.length) warnOnce(coded('asset-lod', `assets.lod('${name}'): no levels for this model, so it draws in full at every distance. Run \`threedog assets optimize --lod\`; its report says when a model is skipped and why`));
  // shortcut: counts copies ever made, not live ones (a prop's clone is no counted copy of the model); enough for a one-time hint, count live ones if it misfires
  if (e) e.lodCopies = (e.lodCopies ?? 0) + 1;
  if (DEV && e?.lodCopies === MANY_COPIES) warnOnce(coded('asset-lod', `assets.lod('${name}'): ${MANY_COPIES} copies, and a LOD object is never batched, so each one is its own draw calls. Check engine.batching is not the better fit: drop lod for this model and compare describe().perf`));
  const fullMeshes = meshesOf(full);
  const size = new THREE.Box3().setFromObject(full).getSize(new THREE.Vector3()).length() * scale;
  // allSettled: one level failing to load must not strand the others that did (each holds a lease)
  const got = await Promise.allSettled(urls.map(u => a._bare(u, {}, 'lod'))), failed = got.find(r => r.status === 'rejected');
  if (failed) { for (const r of got) if (r.status === 'fulfilled') a.dropCopy(r.value); throw failed.reason; }
  const copies = got.map(r => r.value);   // bare: a level is part of the LOD, which is what gets the onModel setup
  copies.forEach((copy, i) => {
    const low = meshesOf(copy), at = asked ? asked[i] : size * FIRST_LENGTHS * STEP ** i;
    // a level built from another version of the model, or more levels than the game gave distances: leave it out rather than draw the wrong material on it
    if (low.length !== fullMeshes.length || at === undefined) {
      if (DEV && at !== undefined) warnOnce(coded('asset-lod', `assets.lod('${name}'): ${urls[i]} has ${low.length} meshes and the model ${fullMeshes.length}, so that level is left out. Run \`threedog assets optimize --lod --force\``));
      a.forget(copy);
      return;
    }
    low.forEach((m, j) => {
      const f = fullMeshes[j];
      m.material = f.material; m.castShadow = f.castShadow; m.receiveShadow = f.receiveShadow;
      m.userData.lodLevel = i + 1;
    });
    passRays(copy, fullMeshes);
    lod.addLevel(copy, at, hysteresis);
  });
  return lod;
}
