// Impostor cards (vegetation.define({ impostor }), docs/plans/2026-11-09-impostors.md), tests/specs/impostor.mjs. Two WebGPU engines plant the same
// red trees on flat ground; one draws them as meshes everywhere, the other as baked cards beyond lodRing 0. The camera stands in ring 0 and
// looks over the far rings, so what it sees of the trees is the far drawing: draws, tree pixels and their colour are compared, then every far
// tree is felled on the card engine and its cards must go.
import * as THREE from 'three';
import 'threedog/tsl';
import { createEngine, terrain, vegetation, mergeColored } from '../../index.js';
import { stats } from '../../render/backend.js';
import { materialPatches } from '../../render/patches.js';
import { traceSnapshot } from '../../modules/photo/pathTrace.js';

const W = 320, H = 200;
const read = c => { const x = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  x.drawImage(c, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };

async function make(impostor) {
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  document.body.append(canvas);
  const e = createEngine({ canvas, renderer: 'webgpu', pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false, saveKey: 'test-impostor-' + impostor });
  e.use(terrain({ height: () => 0, viewChunks: 2 }), vegetation());
  // a trunk and a crown: two parts, as a real tree (the mesh draws a group each); red so tree pixels are easy to tell from the ground
  const crown = new THREE.ConeGeometry(1.6, 5, 7).translate(0, 4.5, 0), trunk = new THREE.CylinderGeometry(0.25, 0.3, 2, 6).translate(0, 1, 0);
  e.vegetation.define('tree', { geometry: mergeColored([[crown, 0xc8322a], [trunk, 0x8a3a24]]), wind: 0, lodRing: 0, castShadow: false, rule: { perChunk: 40, scale: [0.9, 1.3] },
    densityMap: (x, z) => (x >= 0 && x < 64 && z >= 0 && z < 64 ? 0 : 1),   // none in the chunk the camera stands in: every tree it sees is a far one
    ...(impostor && { impostor: true }) });
  await e.start();
  e.haltLoop();
  // stand in the middle of chunk (0, 0), look along +x over the far chunks
  e.focus.set(32, 0, 32);
  for (let i = 0; i < 200 && !e.terrain.readyAt?.({ x: 160, z: 32 }); i++) { e.step(1 / 60); await new Promise(r => setTimeout(r, 5)); }
  for (let i = 0; i < 30; i++) { e.step(1 / 60); await new Promise(r => setTimeout(r, 5)); }
  e.camera.position.set(4, 7, 32); e.camera.lookAt(120, 2, 32);
  if (new URLSearchParams(location.search).has('close')) { e.camera.position.set(88, 5, 20); e.camera.lookAt(110, 3, 30); }   // rings follow the focus, not the camera: a close look at far cards
  e.camera.updateMatrixWorld();
  return e;
}

/** one frame: draw calls and the tree pixels (red clearly above green and blue), their count and mean colour */
function shot(e) {
  e.step(1 / 60);
  const draws = stats(e.renderer).drawCalls, a = read(e.renderer.domElement);
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] > a[i + 1] + 40 && a[i] > a[i + 2] + 40) { n++; r += a[i]; g += a[i + 1]; b += a[i + 2]; }
  return { draws, trees: n, color: n ? [r / n, g / n, b / n].map(Math.round) : null };
}

window.impostorCards = async () => {
  const mesh = meshEngine, card = await make(true);
  const out = { mesh: shot(mesh), card: shot(card), errors: [] };
  const k = card.vegetationDraw.kind('tree'), I = k?.impostor;
  out.cardMesh = { made: !!I?.mesh, count: I?.mesh?.geometry.instanceCount ?? 0, layers: I?.bake?.albedo.image.depth ?? 0 };
  // rings: how many chunks are past lodRing 0, so the far drawing really is what the camera sees
  out.far = [...card.terrain.chunks.values()].filter(c => c.ring > 0 && c.plants?.tree).length;
  // the photo path trace: a stand-in tracer records what setScene saw. The card mesh (one quad at the origin outside its shader) must not be in it,
  // and the untraced line must say the far plants are missing
  let seen = [];
  const untraced = traceSnapshot({ setScene(s) { s.traverseVisible(o => seen.push(o)); } }, card.scene, card.camera, true);
  out.traced = { cardSeen: !!I?.mesh && seen.includes(I.mesh), shownAgain: !!I?.mesh?.visible, untraced };
  // fell every far tree: the cards must go with them (zero-scale slots, count unchanged)
  for (const c of card.terrain.chunks.values()) {
    if (!(c.ring > 0) || !c.plants?.tree) continue;
    for (const id of c.plants.tree.ids) card.vegetation.removeInstance('tree', c.cx, c.cz, id);
  }
  card.step(1 / 60);
  out.felled = shot(card);
  out.felledCount = I?.mesh?.geometry.instanceCount ?? 0;
  // a species' own material is patched in place (wind, season): the bake reads an unpatched copy, the drawn far mesh keeps its patches
  const own = new THREE.MeshLambertMaterial({ vertexColors: true });
  card.vegetation.define('bush', { geometry: new THREE.BoxGeometry(1, 1, 1), material: own, wind: 0.05, impostor: true, rule: { perChunk: 1 } });
  out.bakeSource = { drawn: materialPatches(own), baked: materialPatches(card.vegetationDraw.kind('bush').impostor.src.material) };
  // bad impostor values (content data can carry them) throw instead of sizing a render target
  out.refused = [{ views: 0 }, { views: NaN }, { size: 1e5 }, 'yes', { views: 2.5 }].map(v => {
    try { card.vegetation.define('bad', { geometry: new THREE.BoxGeometry(1, 1, 1), impostor: v }); return false; } catch { return true; }
  });
  out.errors = [mesh.error, card.error].filter(Boolean).map(x => String(x.message).slice(0, 300));
  mesh.dispose(); card.dispose();
  return out;
};
// the test runner waits for window.engine: the mesh engine is made at load
// (?card: the card engine instead, to look at with threedog shot /tests/impostor/index.html?card)
const meshEngine = window.engine = await make(new URLSearchParams(location.search).has('card'));
window.ready = true;
