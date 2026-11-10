// Kept shadows page (tests/specs/shadow-cache.mjs). A top view of a lit ground with two boxes under a slanted sun, so each shadow lies on bare ground beside its box and
// one spot's brightness says whether a shadow is there. Why the static box is moved on purpose: a kept shadow staying behind is the only outside proof that it was not redrawn.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { vec4 } from 'three/tsl';
import 'threedog/tsl';
import { createEngine } from '../../index.js';
import { backendName, renderOnce } from '../../render/backend.js';
import { threePatches } from '../../core/scene/threePatches.js';

const W = 200, H = 200;
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), renderer: 'webgpu', lights: false, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, saveKey: 'test-shadow-cache', urlState: false });
const sun = new THREE.DirectionalLight('#ffffff', 3);
sun.position.set(10, 20, 0); sun.castShadow = true; sun.shadow.mapSize.setScalar(512);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
engine.scene.add(sun, new THREE.AmbientLight('#ffffff', 0.4));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 1 }));
ground.receiveShadow = true;
const boxMat = new THREE.MeshStandardMaterial({ color: 0x808080 }), geo = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
const make = (x, z) => { const m = new THREE.Mesh(geo, boxMat); m.position.set(x, 0, z); m.castShadow = true; engine.scene.add(m); return m; };
const town = new THREE.Group(); engine.scene.add(ground, town);
const still = make(-5, -5), mover = make(5, 5); town.add(still);
await engine.start();
engine.haltLoop();

const cam = engine.camera, rt = new TG.RenderTarget(W, H);
async function shot() {
  cam.position.set(0, 30, 0.01); cam.lookAt(0, 0, 0); cam.aspect = W / H; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  engine.step(1 / 30, { describe: false });
  renderOnce(engine.renderer, engine.scene, cam, rt);
  return new Uint8Array(await engine.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
}
/**
 * mean brightness of the screen spot where the ground point lands. A WebGPU target reads top row first; real-webgpu.mjs flips what pages read to WebGL's order (window.__glRows) and
 * npm test, also on real WebGPU, does not, so reading in one fixed order looks at the mirror spot: bare lit ground, every shadow gone
 */
const spot = (b, x, z) => {
  const v = new THREE.Vector3(x, 0, z).project(cam), cx = Math.round((v.x + 1) / 2 * W), cy = Math.round((1 + (window.__glRows ? v.y : -v.y)) / 2 * H);
  let s = 0, n = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const k = ((cy + j) * W + cx + i) * 4; s += b[k]; n++; }
  return Math.round(s / n);
};
// the slanted sun lays a 2 m box's shadow on the 1 m of ground beyond its far side (-x). x - 1.75, not the middle: from this camera the box top leans out over x - 1.4
const dark = (b, m) => spot(b, m.position.x - 1.75, m.position.z);
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) n++; return Math.round(n / (a.length / 4) * 10000) / 100; };

window.shadowCache = async () => {
  const r = { backend: backendName(engine.renderer) };
  await shot();   // the first frame compiles
  const plain = await shot();
  r.off = { node: sun.shadow.shadowNode === undefined, patch: threePatches.list().some(p => p.id === 'shadow-cache'), still: dark(plain, still), mover: dark(plain, mover), lit: spot(plain, 0, 12) };
  // off: both redraw as ever
  still.position.z = 9; mover.position.z = -9;
  const moved = await shot();
  r.offMoved = { still: dark(moved, still), mover: dark(moved, mover), oldStill: spot(moved, -6.75, -5), oldMover: spot(moved, 3.25, 5) };
  still.position.z = -5; mover.position.z = 5;

  const kept = engine.shadows.cache(sun, { static: town });
  await shot();
  const on = await shot();
  r.on = { node: !!sun.shadow.shadowNode?.isCachedShadowNode, patch: threePatches.list().some(p => p.id === 'shadow-cache'), changed: diff(plain, on), still: dark(on, still), mover: dark(on, mover) };
  const old = { x: mover.position.x - 1.75, z: mover.position.z };
  mover.position.z = -9; still.position.z = 9;
  const a = await shot(), b = await shot();
  r.frozen = { oldStill: spot(b, -6.75, -5), newStill: dark(b, still), oldMover: spot(b, old.x, old.z), newMover: dark(b, mover), firstFrame: dark(a, mover) };
  const late = make(-5, 2); town.add(late);   // static, but it came after the kept map was drawn
  r.late = dark(await shot(), late);
  town.remove(late);
  kept.redraw();
  const c = await shot();
  r.redrawn = { oldStill: spot(c, -6.75, -5), newStill: dark(c, still) };
  sun.position.set(-10, 20, 0);   // the light moved: nothing kept can stand, and no redraw() is needed
  const d = await shot();
  r.sunMoved = { oldSide: dark(d, still), newSide: spot(d, still.position.x + 1.75, still.position.z) };
  sun.position.set(10, 20, 0); still.position.z = -5; mover.position.z = 5;
  // under a box the light holds still inside a quarter of the box (15 / 4 m), or every step of the camera would throw the kept map away
  const at = new THREE.Vector3(), box = engine.shadows.box(sun, { follow: () => at, snap: 0 });
  await shot();
  const p0 = sun.position.clone();
  at.x = 1; await shot();
  const held = sun.position.distanceTo(p0);
  at.x = 5; await shot();
  r.box = { held, stepped: sun.position.distanceTo(p0) };
  box.remove();
  // a new size replaces both depth maps: the copy must find them equal, and the kept shadow comes back
  engine.shadows.mapSize(sun, 1024);
  await shot();
  const big = await shot();
  r.resized = { size: sun.shadow.shadowNode.shadowMap.width, kept: sun.shadow.shadowNode._cache.width, still: dark(big, still), mover: dark(big, mover) };
  engine.shadows.mapSize(sun, 512);
  kept.remove();
  await shot();
  const back = await shot();
  r.removed = { node: sun.shadow.shadowNode === undefined, changed: diff(plain, back) };
  // a batch hangs under the batching root, not under what the game named static: it answers for its originals, and its instance version keeps the kept map honest
  const row = new THREE.Group();
  for (let i = 0; i < 24; i++) { const m = new THREE.Mesh(geo, boxMat); m.position.set(-12 + i, 0, -13); m.castShadow = true; row.add(m); }
  row.userData.batch = true; engine.scene.add(row);
  await shot(); await shot();
  const batch = engine.batching.batches.find(b => b.count >= 24)?.mesh;
  const wide = engine.shadows.cache(sun, { static: row }), node = sun.shadow.shadowNode;
  await shot();
  r.batch = { made: !!batch, byRoot: !!batch && node._isStatic(batch), kept: !!batch && node._kept.has(batch) };
  wide.set({ static: mesh => mesh !== row.children[3] });
  r.batch.oneMoving = !!batch && node._isStatic(batch);
  wide.set({ static: row });
  await shot();
  row.position.x -= 1;   // the whole group moved: batching replaces its InstancedMesh
  await shot();
  const next = engine.batching.batches.find(b => b.count >= 24)?.mesh;
  r.batch.replaced = !!next && next !== batch && node._kept.has(next) && !node._instanced.has(batch);
  const v = next?.instanceMatrix.version;
  if (next) next.instanceMatrix.needsUpdate = true;   // what a write to an instance does
  await shot();
  r.batch.liveFirst = !!next && !node._kept.has(next);   // a refill just happened (the replaced batch): the written mesh draws live until the next one
  for (let i = 0; i < 8; i++) await shot();
  r.batch.keptAgain = next?.instanceMatrix.version !== v && node._instanced.get(next)?.v === next?.instanceMatrix.version;
  // 不许绕开：边走边加载时 batching 几乎每帧都写实例；每次写都重画整张保留图，比不开缓存还贵。合并成每 REFILL_EVERY 个阴影帧最多一次
  const fills0 = node._fills, own = node.renderShadow;
  let calls = 0;
  node.renderShadow = function (f) { calls++; return own.call(this, f); };
  for (let i = 0; i < 24; i++) { if (next) next.instanceMatrix.needsUpdate = true; await shot(); }
  delete node.renderShadow;
  r.batch.streaming = { writes: 24, shadowFrames: calls, fills: node._fills - fills0 };
  // 不许绕开：藏起来的（植被出了 maxRing、区块被放掉）也要重画，不能只看实例版本，否则留下已经不在的东西的影子
  if (next) next.visible = false;
  await shot();
  r.batch.hiddenRedrawn = !!next && !node._instanced.has(next);
  if (next) next.visible = true;
  wide.remove(); row.removeFromParent();
  return r;
};
/** renderer.shadowMap.transmitted: a static box whose castShadowNode (three's transmitted-shadow color) is red tints its shadow; kept, the tint must still be there on a frame that skips the box */
window.transmitted = async () => {
  const R = engine.renderer, was = R.shadowMap.transmitted;
  R.shadowMap.transmitted = true;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0), Object.assign(new TG.MeshStandardNodeMaterial({ color: 0xff2020 }), { castShadowNode: vec4(1, 0.1, 0.1, 1) }));
  glass.position.set(-5, 0, 5); glass.castShadow = true; town.add(glass);
  [ground.material, boxMat].forEach(m => { m.needsUpdate = true; });
  // the spot's red minus blue: the tint of the glass box's shadow on gray ground
  const tint = b => { const v = new THREE.Vector3(-6.75, 0, 5).project(cam), cx = Math.round((v.x + 1) / 2 * W), cy = Math.round((1 + (window.__glRows ? v.y : -v.y)) / 2 * H), k = (cy * W + cx) * 4; return b[k] - b[k + 2]; };
  await shot();
  const off = tint(await shot());
  const kept = engine.shadows.cache(sun, { static: town });
  await shot(); await shot();
  const on = tint(await shot());   // a later frame: the box is skipped, its tint comes from the kept map
  kept.remove(); glass.removeFromParent(); R.shadowMap.transmitted = was;
  [ground.material, boxMat].forEach(m => { m.needsUpdate = true; });
  return { off, on };
};
window.ready = true;
