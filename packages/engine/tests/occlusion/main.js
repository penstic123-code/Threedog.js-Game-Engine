// Occlusion culling page (tests/specs/occlusion.mjs). A wall hides a heavy crowd and a tower; the sun comes from the side, so the hidden tower's shadow lands past the wall's end, where the
// camera sees it. ?r=gpu runs on WebGPURenderer (forceWebGL: true in ordinary runs, rewritten by packages/tools/real-webgpu.mjs), else on WebGLRenderer.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';
import { createEngine } from '../../index.js';
import { outline, OUTLINE_OFF_LAYER } from '@threedog/post-effects';
import { RESERVED_LAYERS } from '../../render/layers.js';

const { occlusionHidden: HIDDEN_LAYER, occlusionBox: BOX_LAYER } = RESERVED_LAYERS;
const W = 200, H = 150, gpu = location.search.includes('r=gpu');
const canvas = document.getElementById('view');
const renderer = gpu ? new TG.WebGPURenderer({ canvas, antialias: false, forceWebGL: true }) : new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
const engine = window.engine = createEngine({ renderer, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, saveKey: 'test-occlusion', urlState: false });

const lit = c => new THREE.MeshStandardMaterial({ color: c, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), lit(0x909090));
const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 0.4), lit(0x505070));
wall.position.set(0, 3, 0);
ground.receiveShadow = wall.castShadow = wall.receiveShadow = true;
const tower = new THREE.Mesh(new THREE.BoxGeometry(1, 5, 1), lit(0x30c030));
tower.position.set(2, 2.5, -1); tower.castShadow = true;
const heavy = new THREE.SphereGeometry(0.3, 64, 48), crowd = [];
for (let i = 0; i < 20; i++) {
  const m = new THREE.Mesh(heavy, lit(0xd03030));
  m.position.set(-2 + (i % 5), 0.5 + (i / 5 | 0) * 0.9, -0.8);
  crowd.push(m);
}
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(-10, 8, 0.5); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 0.1, far: 40 });
engine.scene.add(ground, wall, tower, sun, new THREE.AmbientLight(0xffffff, 0.4), ...crowd);
engine.scene.background = new THREE.Color(0x203040);

await engine.start();
engine.haltLoop();
const cam = engine.camera, rt = gpu ? new TG.RenderTarget(W, H) : new THREE.WebGLRenderTarget(W, H);
const place = x => { cam.position.set(x, 2, 10); cam.lookAt(x, 2, 0); cam.aspect = W / H; cam.updateProjectionMatrix(); cam.updateMatrixWorld(); };

// the boxes stay out of these extra renders: on WebGPU a render into another target is another render context, whose answers would read "not occluded"
async function read() {
  const mask = cam.layers.mask;
  cam.layers.disable(BOX_LAYER);
  engine.renderOnce(rt);
  cam.layers.mask = mask;
  if (gpu) return new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  return px;
}
const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) n++; return n; };
/** One engine frame, then a browser frame so the GPU's answers can come back */
const tick = async () => { engine.step(1 / 60, { describe: false }); await new Promise(requestAnimationFrame); };
/** What the frame would look like with nothing hidden, without touching the culling state */
async function truth() {
  const on = [...engine.occlusion._items].filter(i => i.hidden).flatMap(i => i.meshes), boxLayer = cam.layers.mask;
  for (const m of on) delete m.layers.test;
  const px = await read();
  for (const m of on) m.layers.test = engine.occlusion._unseen;
  cam.layers.mask = boxLayer;
  return px;
}

/** Median ms for one engine frame, GPU finished; only real-device runs mean anything by it */
async function cost(n = 30) {
  const t = [], device = renderer.backend?.device;
  for (let i = 0; i < n; i++) { const a = performance.now(); engine.step(1 / 60, { describe: false }); await device?.queue.onSubmittedWorkDone(); t.push(performance.now() - a); }
  return +t.sort((x, y) => x - y)[n >> 1].toFixed(2);
}
window.occlusionRun = async () => {
  const out = { backend: gpu ? (renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2') : 'webgl' };
  place(0);
  for (let i = 0; i < 3; i++) await tick();
  const offPicture = await read();
  const offDraws = engine.renderer.info.render.triangles;

  for (const m of [tower, ...crowd]) engine.occlusion.watch([m]);
  let reads = 0;
  const reader = engine.occlusion.watch([tower], () => { reads++; return new THREE.Box3(); });
  out.offCost = { reads, boxes: [...engine.occlusion._items].filter(i => i.box).length };
  reader.remove();
  const shadowMask = sun.shadow.camera.layers.mask;
  engine.occlusion.enabled = true;
  for (let i = 0; i < 40 && engine.occlusion.stats.hidden < 21; i++) await tick();
  out.still = engine.occlusion.stats;
  out.row = engine.describe().render.occlusion;
  out.text = /occlusion: /.test(engine.describe().render.text);
  out.hiddenFromView = !tower.layers.test(cam.layers) && tower.layers.mask === 1;
  out.visibleKept = tower.visible;
  out.shadowSeesBoxes = sun.shadow.camera.layers.isEnabled(BOX_LAYER);
  out.shadowSeesHidden = sun.shadow.camera.layers.isEnabled(HIDDEN_LAYER);
  engine.rays.addStatic(tower);
  out.rayHit = engine.raycast(new THREE.Vector3(2, 2.5, -4), new THREE.Vector3(0, 0, 1))?.object === tower;
  const onPicture = await read();
  out.ms = { on: await cost() };
  out.changed = differing(offPicture, onPicture);
  // the measure can see the shadow: without it the picture differs
  tower.castShadow = false;
  out.shadowMatters = differing(onPicture, await read());
  tower.castShadow = true;

  // the same view with nothing watched costs this
  engine.occlusion.enabled = false;
  out.ms.off = await cost();
  engine.occlusion.enabled = true;
  for (let i = 0; i < 40 && engine.occlusion.stats.hidden < 21; i++) await tick();
  // the crowd comes into view past the wall's end, a step at a time: every frame must equal the frame with nothing hidden
  let worst = 0, shown = 0;
  for (let i = 1; i <= 70; i++) {
    place(i * 0.1);
    await tick();
    const a = await read(), b = await truth();
    worst = Math.max(worst, differing(a, b));
    shown = Math.max(shown, 21 - engine.occlusion.stats.hidden);
  }
  out.gap = { worst, shown };
  // a camera cut: the frame right after it hides nothing it should show
  place(0); for (let i = 0; i < 40 && engine.occlusion.stats.hidden < 21; i++) await tick();   // place(0) is a cut too: answers start over
  const before = engine.occlusion.stats.hidden;
  place(9);
  await tick();
  out.cut = { before, after: engine.occlusion.stats.hidden, differs: differing(await read(), await truth()) };

  out.rootOwner = engine._things.byObj.get(engine.occlusion._root)?.owner;
  engine.occlusion.enabled = false;
  out.off = { boxes: engine.scene.getObjectByName('occlusion boxes') ? 1 : 0, layerBack: tower.layers.test(cam.layers), stats: engine.occlusion.stats.hidden, shadowMaskBack: sun.shadow.camera.layers.mask === shadowMask };
  return out;
};
// outline's own renders of the camera (normal view, exempt-layer mask) with the boxes around things in view: the lines must not change
window.occlusionOutline = async () => {
  const line = engine.post.add(outline({ mode: 'both', offLayer: OUTLINE_OFF_LAYER, strength: 1 }));
  // not read(): that takes the boxes off first, and here they must be there when the chain runs
  const withBoxes = async () => { await tick(); cam.layers.enable(BOX_LAYER); engine.renderOnce(rt); return gpu ? new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H)) : (() => { const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); return px; })(); };
  // from behind the wall: nothing hides the crowd, so each sphere's square box stands in front of the camera
  cam.position.set(0, 2, -8); cam.lookAt(0, 1.5, -1); cam.updateMatrixWorld();
  await tick();
  const plain = await withBoxes();
  engine.occlusion.enabled = true;
  for (let i = 0; i < 4; i++) await tick();
  const boxes = [...engine.occlusion._items].filter(i => i.proxy?.visible).length, on = await withBoxes();
  const out = { boxes, hidden: engine.occlusion.stats.hidden, differs: differing(plain, on) };
  engine.occlusion.enabled = false; line.remove();
  return out;
};
// cascades built while culling hides things (a shadow setting or tier change does this): every fresh cascade light's camera must see the hidden layer within two frames,
// not at the next timed walk (LIGHT_WALK, ~1 s), or the hidden casters' shadows vanish meanwhile. Frames counted up to 70, past one timed walk
window.occlusionCascades = async () => {
  place(0);
  engine.occlusion.enabled = true;
  for (let i = 0; i < 40 && engine.occlusion.stats.hidden < 21; i++) await tick();
  const own = engine.lights?.sun, casts = own?.castShadow; if (own) own.castShadow = false;   // one shadow-casting directional light: cascades take the page's sun
  const hidden = engine.occlusion.stats.hidden, set = engine.shadows.cascades(sun, { count: 2, maxFar: 30, low: { count: 2 } });   // low: the headless tier would draw one map
  const cams = () => { const out = []; engine.scene.traverse(o => { if (o.isLight && o.castShadow) { out.push(o.shadow.camera); o.shadow.shadowNode?.lights?.forEach(l => out.push(l.shadow.camera)); } }); return out; };
  let frames = -1, lights = 0;
  for (let i = 1; i <= 70 && frames < 0; i++) {
    await tick();
    const c = cams(); lights = c.length;
    if (c.length >= 2 && c.every(x => x.layers.isEnabled(HIDDEN_LAYER))) frames = i;
  }
  set.remove(); if (own) own.castShadow = casts; engine.occlusion.enabled = false; await tick();
  return { hidden, lights, frames };
};
// start() falling back to WebGLRenderer with culling already on: the boxes must get WebGL's query hooks, or every frame throws
window.occlusionFallback = async () => {
  const failing = { requestAdapter: async () => ({ features: new Set(), limits: {}, requestDevice: async () => { throw new Error('test: no device'); } }) };
  Object.defineProperty(navigator, 'gpu', { value: failing, configurable: true });
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }); document.body.appendChild(c);
  const e = createEngine({ canvas: c, renderer: 'webgpu', fallback: 'webgl', lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, saveKey: 'test-occlusion-fb', urlState: false });
  try {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    m.position.z = -5; e.scene.add(m);
    e.occlusion.watch([m]); e.occlusion.enabled = true;
    await e.start(); e.haltLoop();
    for (let i = 0; i < 3; i++) { e.step(1 / 60, { describe: false }); await new Promise(requestAnimationFrame); }
    const [it] = e.occlusion._items;
    return { webgl: !!e.renderer.isWebGLRenderer, query: !!it.query, gpuHook: !!it.proxy.occlusionTest };
  } finally { delete navigator.gpu; e.dispose(); }
};
window.ready = true;
