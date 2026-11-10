// The one low-level GPU free (design.md 6.2): engine.remove, engine.dispose and the asset cache dispose scene parts only here, each passing its own owner test.
// Why one helper: walks with rules of their own would free a game's own material at engine.dispose and a material an asset file shares twice (once by the scene walk,
// once by the cache). The caller says what it owns; the helper walks, asks, and disposes each part at most once per call.
// The guard spec 'resource lifetime: only freeParts disposes scene parts in a walk' keeps a second walk from coming back.

// Instanced / batched objects a model clone produced: their buffers are the copy's. One a game attached to the copy (onModel) is the game's and is not in here
const CLONED = new WeakSet();
/** A model copy: SkeletonUtils.clone (a skinned part gets bones of its own), with the instance objects it produced marked as the copy's @param {any} src */
export function cloneModel(src) {
  const root = skeletonClone(src);
  root.traverse(o => { if (o.isInstancedMesh || o.isBatchedMesh) CLONED.add(o); });
  return root;
}
/** What Assets.dropCopy frees of a model copy: its cloned bones and the instance objects its clone produced (engine.remove frees more: it is handed the whole object) */
export const copyOwns = (shared, o) => copyBones(shared, o) || CLONED.has(o);

import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/** The geometry and materials of one object */
export const partsOf = o => [o.geometry, ...[].concat(o.material)].filter(Boolean);

/** A model copy's own bones: skeletonClone gave the copy a skeleton of its own, while its geometry is the asset's (shared). The engine made those bones */
const copyBones = (shared, o) => !!o.isSkinnedMesh && shared.has(o.geometry);

// Parts a maker shares among many of its objects and frees itself (the characters' capsule material): engine.remove and engine.dispose leave them.
// Why not assets.shared: that set says "an asset load owns it and frees it", and a module's material is no load's, so marking it there freed it never.
// A hold, not a mark: one who stops holding (a material replaced, a module unloaded) gives it back with remove(), and a part nobody keeps is ordinary
// again, so engine.remove frees a game material characters no longer use. Counted, since two holders may keep one part.
const KEPT = new WeakMap();   // part -> number of holds
/** Hold a part its holder frees or hands back itself: { part, remove() } (remove is idempotent) @template T @param {T} x @returns {{ part: T, remove(): void }} */
export function keepPart(x) {
  KEPT.set(x, (KEPT.get(x) ?? 0) + 1);
  let held = true;
  return { part: x, remove() { if (!held) return; held = false; const n = KEPT.get(x) - 1; if (n > 0) KEPT.set(x, n); else KEPT.delete(x); } };
}
/** Whether someone holds this part (keepPart) @param {any} x */
export const kept = x => KEPT.has(x);

const run = fn => fn();

/**
 * Dispose the GPU parts under roots that the caller owns, each once.
 * @param {any | any[]} roots Object3D roots, each walked with traverse
 * @param {(part: any) => boolean} mine true for a geometry, material or texture this caller made or was handed; a part it says no to is left alone
 * @param {{ textures?: boolean, own?: (obj: any) => boolean, tidy?: (fn: () => void) => void }} [opts]
 *   textures: also the textures in each freed material's slots (that pass mine too). own(obj): the object's own GPU data is the caller's (instance buffers,
 *   a batch's textures, a light's shadow map, the bone texture). tidy wraps each dispose: engine.dispose keeps going past a game 'dispose' listener that throws.
 */
export function freeParts(roots, mine, { textures = false, own = null, tidy = run } = {}) {
  const done = new Set();
  const free = x => {
    if (!x || done.has(x) || !mine(x)) return false;
    done.add(x);
    if (textures && x.isMaterial) for (const k in x) if (x[k]?.isTexture) free(x[k]);   // before the material, as three's own examples do
    tidy(() => x.dispose());
    return true;
  };
  for (const r of [].concat(roots)) r.traverse(o => {
    if (own?.(o)) {
      if ((o.isInstancedMesh || o.isBatchedMesh || o.isLight) && !done.has(o)) {
        done.add(o);
        if (o.isBatchedMesh && (done.has(o.geometry) || !mine(o.geometry))) {
          // BatchedMesh.dispose() frees its geometry unconditionally: a geometry freed earlier in this walk, or one the caller does not own (another mesh still draws it),
          // goes through the same check as any geometry, so only the batch's own textures are freed here (three's private fields; the dispose event is what the renderer listens to)
          tidy(() => { for (const k of ['_matricesTexture', '_indirectTexture', '_colorsTexture', '_previousMatricesTexture']) o[k]?.dispose(); o.dispatchEvent({ type: 'dispose' }); });
        } else {
          tidy(() => o.dispose());
          if (o.isBatchedMesh) done.add(o.geometry);   // dispose() freed it with the batch: the walk below must not dispose it a second time
        }
      }
      if (o.skeleton && !done.has(o.skeleton)) { done.add(o.skeleton); tidy(() => o.skeleton.dispose()); }   // one skeleton may drive several meshes
    }
    free(o.geometry);
    for (const m of [].concat(o.material || [])) free(m);
  });
}
