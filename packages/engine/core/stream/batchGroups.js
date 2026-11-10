// InstancedMesh side of engine.batching (core/stream/Batching.js): build / join / leave / dissolve / grow a batch, instance colors, bounds,
// and the transform snapshots the per-frame check compares. B is the Batching instance; g a group (one cell + geometry + material + shadow flags);
// e an entry (one mesh of one placed object). Hidden instances are swap-removed, not zero-scaled (vegetation's way), so batch bounds stay tight.
import * as THREE from 'three';
import { cloneMaterial } from '../../render/patches.js';
import { RESERVED_LAYERS } from '../../render/layers.js';
import { noRaycast } from '../../render/occlusion.js';

/** Layer a batched original is moved to: the camera does not draw it (nor its shadow), engine.rays still tests it */
export const BATCH_LAYER = RESERVED_LAYERS.batched;
const WHITE = new THREE.Color(1, 1, 1);
const _m = new THREE.Matrix4(), _c = new THREE.Color();
const hold = (B, x, d) => { const n = (B.held.get(x) ?? 0) + d; if (n > 0) B.held.set(x, n); else B.held.delete(x); };

function makeMesh(B, g, capacity) {
  const im = new THREE.InstancedMesh(g.geometry, g.material, capacity);
  // No DynamicDrawUsage: on WebGPURenderer it means a full refresh of every batch, every pass, every frame, and a batch rests almost always. three sees a write by the attribute's version either way
  im.castShadow = g.cast; im.receiveShadow = g.receive;
  im.matrixAutoUpdate = false; im.raycast = noRaycast;   // rays hit the originals (on BATCH_LAYER), never the batch
  im.userData = { budgetTag: 'batch', cell: g.cell };
  g.mesh = im; B.byMesh.set(im, g); B.root.add(im);
  if (!B.root.parent) B.engine.scene.add(B.root);   // joins at the first batch: a scene with none is the game's alone
  g.watch?.remove();
  let version = -1;   // the box follows the instances: a stale one would hide what stands elsewhere now
  g.watch = B.engine.occlusion.watch([im], () => {
    if (version !== im.instanceMatrix.version) { version = im.instanceMatrix.version; im.computeBoundingBox(); }
    return im.boundingBox;
  });
  return im;
}

/** Turn a group that reached minCount into one InstancedMesh */
export function build(B, g) {
  const im = makeMesh(B, g, Math.max(16, g.members.size * 2));
  im.count = 0;
  im.name = 'batch:' + (g.geometry.name || [...g.members][0].mesh.name || g.geometry.id);
  hold(B, g.geometry, 1); hold(B, g.material, 1);
  for (const e of g.members) join(B, e);
}
/** Put one entry into its group's InstancedMesh and hide its own mesh */
export function join(B, e) {
  const g = e.group, m = e.mesh;
  let im = g.mesh;
  if (g.items.length >= im.instanceMatrix.count) im = grow(B, g);
  e.slot = g.items.length; g.items.push(e);
  im.count = g.items.length;
  if (B.orig.has(m)) { m.material.dispose(); m.material = B.orig.get(m); B.orig.delete(m); }   // a local tint clone: the instance color takes over
  m.updateWorldMatrix(true, false);
  im.setMatrixAt(e.slot, m.matrixWorld); im.instanceMatrix.needsUpdate = true;
  if (g.colored || B.tints.has(m)) color(B, e);
  m.layers.set(BATCH_LAYER); m.userData.batched = true;   // not visible = false: visibility stays the game's
  g.dirty = true; B.live.add(e.info); B._skipChanged(e);
}
/** Swap-remove an entry from its InstancedMesh and show its mesh again */
export function leave(B, g, e) {
  const im = g.mesh, last = g.items.pop();
  if (last !== e) {
    g.items[e.slot] = last; last.slot = e.slot;
    im.getMatrixAt(im.count - 1, _m); im.setMatrixAt(e.slot, _m);
    if (im.instanceColor) { im.getColorAt(im.count - 1, _c); im.setColorAt(e.slot, _c); im.instanceColor.needsUpdate = true; }
  }
  im.count = g.items.length; im.instanceMatrix.needsUpdate = true; g.dirty = true;
  e.slot = -1;
  const m = e.mesh; m.layers.set(0); delete m.userData.batched; B._skipChanged(e);
  localTint(B, m);
  if (!e.info.entries.some(x => x.slot >= 0)) B.live.delete(e.info);
}
/** Back to plain meshes (the group dropped under half of minCount, or batching was switched off) */
export function dissolve(B, g) {
  for (const e of [...g.items].reverse()) leave(B, g, e);
  g.watch?.remove(); g.watch = null;
  g.mesh.removeFromParent(); g.mesh.dispose(); g.mesh = null; g.colored = false;
  hold(B, g.geometry, -1); hold(B, g.material, -1);
}
/** Double the capacity (InstancedMesh buffers are fixed size) */
function grow(B, g) {
  const old = g.mesh, n = old.instanceMatrix.count * 2;
  old.removeFromParent(); old.dispose();
  const im = makeMesh(B, g, n);
  im.instanceMatrix.array.set(old.instanceMatrix.array);
  if (old.instanceColor) { im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3); im.instanceColor.array.set(old.instanceColor.array); }
  im.name = old.name; im.count = old.count;
  return im;
}
/** Write an entry's tint (white when none) into the batch's instance colors */
export function color(B, e) {
  const g = e.group, im = g.mesh;
  if (!im.instanceColor) { im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(im.instanceMatrix.count * 3).fill(1), 3); g.colored = true; im.material.needsUpdate = true; }   // three built this batch's shader (and its vertex buffers) before any instance color existed; without a rebuild the color never reaches the GPU
  im.setColorAt(e.slot, B.tints.get(e.mesh) ?? WHITE); im.instanceColor.needsUpdate = true;
}
/** An unbatched mesh shows its tint through a cloned material (patches carried over); the original is kept for grouping and restored on clear */
export function localTint(B, m) {
  const t = B.tints.get(m), base = B.orig.get(m) ?? m.material;
  if (!base || Array.isArray(base) || !base.color) return;
  if (t) {
    if (!B.orig.has(m)) { B.orig.set(m, base); m.material = cloneMaterial(base); }
    m.material.color.copy(base.color).multiply(t);
  } else if (B.orig.has(m)) { m.material.dispose(); m.material = base; B.orig.delete(m); }
}
/** Bounds follow the instances (frustum culling) */
export function bounds(g) { const im = g.mesh; if (!im) return; im.computeBoundingSphere(); im.computeBoundingBox(); }

/** Transform + visibility snapshot of a root (TRS when three composes the matrix, the matrix itself when the game does) */
export function snap(o, s) {
  if (o.matrixAutoUpdate) {
    const p = o.position, q = o.quaternion, k = o.scale;
    s[0] = p.x; s[1] = p.y; s[2] = p.z; s[3] = q.x; s[4] = q.y; s[5] = q.z; s[6] = q.w; s[7] = k.x; s[8] = k.y; s[9] = k.z; s.length = 10;
  } else { for (let i = 0; i < 16; i++) s[i] = o.matrix.elements[i]; s.length = 16; }
  s.push(o.visible ? 1 : 0);
}
/** Does the root still match its snapshot */
export function same(o, s) {
  if (s[s.length - 1] !== (o.visible ? 1 : 0)) return false;
  if (o.matrixAutoUpdate) {
    const p = o.position, q = o.quaternion, k = o.scale;
    return s.length === 11 && s[0] === p.x && s[1] === p.y && s[2] === p.z && s[3] === q.x && s[4] === q.y && s[5] === q.z && s[6] === q.w
      && s[7] === k.x && s[8] === k.y && s[9] === k.z;
  }
  if (s.length !== 17) return false;
  for (let i = 0; i < 16; i++) if (s[i] !== o.matrix.elements[i]) return false;
  return true;
}
/** Instance matrices are float32: compare against the float32 rounding of matrixWorld */
export function stored(a, slot, mw) { const el = mw.elements, o = slot * 16; for (let i = 0; i < 16; i++) if (a[o + i] !== Math.fround(el[i])) return false; return true; }
/** Is o inside a THREE.BundleGroup? three replays a bundle as recorded, so what is inside belongs to it: hiding a child from outside (a batch, an hlod swap) would do nothing */
export function inBundle(o) { for (let p = o; p; p = p.parent) if (p.isBundleGroup) return true; return false; }
