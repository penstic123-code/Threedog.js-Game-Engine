// One node of a multi-part file as its own model (manifest models: { wall: { url: '/models/kit.glb', node: 'Wall.001' } }), helper of assetEntry.js.
// The file is loaded once, as the entry of its path (what assets.model('/models/kit.glb') reads too), and each part holds a lease on it: the part's
// geometry and materials are the file's, so freeing a part only gives that lease back, and the file goes when nothing holds it.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { sanitize, closest } from '../base/spelling.js';
import { fmt } from '../base/validate.js';
import { LoadError } from './assetLoad.js';

const MISSING = 'no node "{node}" in {url}{near}. three renames nodes on load: a dot, colon, slash or bracket is dropped ("Wall.001" is Wall001), a space becomes _, '
  + 'and a second node of the same name gets _1, _2 ("Fence", "Fence_1"); either spelling works here. Nodes in the file: {list}';
const BONES = 'node "{node}" in {url} holds a skinned mesh whose bones are outside it, so a copy would have no skeleton. Name the node that holds both the mesh and its armature';

/**
 * The part of a loaded gltf: the named node in a group of its own, at the origin. Why the world turn and size are kept and only the place is dropped:
 * a kit lays its parts out side by side (the place), while the turn and size are how the part should look, often set on a parent (a Z-up root turned
 * -90 degrees about x, a scaled root). A wrapper group, so content's rot / scale on the copy root add to that turn instead of replacing it.
 * Geometry and materials are shared with the file (SkeletonUtils clone: a skinned part gets its own bones); the file's scene is not changed.
 * @returns {{ scene: THREE.Group, animations: THREE.AnimationClip[] }}
 */
export function partOf(gltf, node, url) {
  const all = [];
  gltf.scene.traverse(o => { if (o !== gltf.scene && o.name) all.push(o.name); });
  const name = all.includes(node) ? node : sanitize(node);
  const src = all.includes(name) ? gltf.scene.getObjectByName(name) : null;
  if (!src) {
    const near = closest(sanitize(node), all);
    const list = all.slice(0, 20).join(', ') + (all.length > 20 ? `, ... (${all.length})` : '');
    throw new LoadError(fmt(MISSING, { node, url, near: near ? ` (did you mean "${near}"?)` : '', list }), { url });
  }
  const inside = new Set();
  src.traverse(o => inside.add(o));
  src.traverse(o => { if (o.isSkinnedMesh && o.skeleton.bones.some(b => !inside.has(b))) throw new LoadError(fmt(BONES, { node, url }), { url }); });
  src.updateWorldMatrix(true, false);
  const part = skeletonClone(src), p = new THREE.Vector3();
  src.matrixWorld.decompose(p, part.quaternion, part.scale);
  part.position.set(0, 0, 0);
  // a node hidden in the file (KHR_node_visibility, nodeVisibility.js) is still shown when a manifest names it: a kit keeps its spare parts hidden. Hidden nodes inside it stay hidden
  part.visible = true;
  const scene = new THREE.Group();
  scene.name = name;
  scene.add(part);
  // clips that move something inside the part; the rest name nodes this model does not have
  const names = new Set([...inside].map(o => o.name));
  const animations = gltf.animations.filter(c => c.tracks.some(t => names.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName)));
  return { scene, animations };
}

/** The load of a part entry: wait for the file's own entry, take the part and a lease on the file (released by freeValue, assetEntry.js) */
export function loadPart(a, e, task) {
  task.phase('download');
  const file = a._resolve(e.url, 'model');
  return a._with(file, g => ({ ...partOf(g, e.opts.node, e.url), fileLease: a._lease(file, undefined, undefined, `file part ${e.name}`) }));
}
