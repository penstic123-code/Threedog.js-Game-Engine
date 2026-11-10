// Exposure, soft shadows and area lights page (tests/specs/picture-light.mjs): autoExposure from @threedog/post-effects/tsl, pcss from threedog/tsl,
// and a RectAreaLight with no setup by the game, on WebGPURenderer (its WebGL2 backend in ordinary runs) and on WebGLRenderer.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { pcss } from 'threedog/tsl';
import { createEngine } from '../../index.js';
import { autoExposure, temporalAA } from '@threedog/post-effects/tsl';
import { bloom } from '@threedog/post-effects';

const W = 160, H = 120;
const renderer = new TG.WebGPURenderer({ canvas: document.getElementById('view'), antialias: false, forceWebGL: true });
renderer.shadowMap.enabled = true;
const engine = window.engine = createEngine({ renderer, pixelRatio: 1, adaptiveResolution: false, lights: false, ui: { loading: false }, saveKey: 'test-picture-light', urlState: false });
await engine.start();
engine.haltLoop();
engine.tier = 'high';
const cam = engine.camera;
/** @param {any} c */
const look = c => { c.up.set(0, 0, -1); c.position.set(0, 10, 0); c.lookAt(0, 0, 0); c.aspect = W / H; c.updateProjectionMatrix(); c.updateMatrixWorld(); };   // straight down: screen x is world x
look(cam);
const rt = new TG.RenderTarget(W, H);
// the chain stays on through every on / off pair, so linear next to sRGB never reads as a change of brightness
engine.post.add({ name: 'chain', node: input => input });
const textures = () => renderer.info.memory.textures;
const read = async () => new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
const frame = async () => { engine.renderOnce(rt); await new Promise(requestAnimationFrame); };
const mean = (/** @type {Uint8Array} */ px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i]; return +(s / (px.length / 4)).toFixed(1); };
/** mean red of the column at world x over the middle 17 rows (around world z 0), the same rows whichever way a backend reads them */
const atX = (/** @type {Uint8Array} */ px, /** @type {number} */ x) => {
  const v = new THREE.Vector3(x, 0, 0).project(cam), col = Math.round((v.x + 1) / 2 * (W - 1));
  let s = 0; for (let y = (H >> 1) - 8; y <= (H >> 1) + 8; y++) s += px[(y * W + col) * 4];
  return +(s / 17).toFixed(1);
};
const floorOf = (/** @type {number} */ color) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color, roughness: 1 })); m.rotation.x = -Math.PI / 2; return m; };

// Exposure eases on engine.time (ambient), so each drawn frame here first steps the engine by dt: the numbers are frames of known length, not wall time
window.exposure = async () => {
  const floor = floorOf(0x808080), amb = new THREE.AmbientLight(0xffffff, 0.4);
  engine.scene.add(floor, amb);
  const draw = (dt = 0.1) => { engine.step(dt, { render: false, describe: false }); engine.renderOnce(rt); };
  const brightness = async (dt = 0.1) => { draw(dt); await new Promise(requestAnimationFrame); return mean(await read()); };
  const settle = async (n = 40, dt = 0.1) => { for (let i = 1; i < n; i++) { draw(dt); if (i % 8 === 0) await new Promise(requestAnimationFrame); } return brightness(dt); };
  const plain = { dark: await settle(3) };
  amb.intensity = 8; plain.bright = await settle(3);
  amb.intensity = 0.4;
  const tex0 = textures();
  const fx = engine.post.add(autoExposure({ speedUp: 3, speedDown: 3 }));
  const dark = await settle(), made = textures() - tex0;
  // dark to bright: the picture starts too bright and comes down; another effect added on the way rebuilds the chain and must not snap it to the goal
  amb.intensity = 8;
  const path = [await brightness()];
  const glow = engine.post.add(bloom({ strength: 0.2 })), taa = engine.post.add(temporalAA());
  for (let i = 0; i < 24; i++) path.push(await brightness());
  const order = engine.post._pipe.order.filter(n => ['bloom', 'autoExposure', 'temporalAA'].includes(n));
  glow.remove(); taa.remove();
  const built = engine.post._pipe.output;
  fx.set({ key: 0.36 });
  const keyed = await settle(), live = engine.post._pipe.output === built;
  // max holds a dark place below its goal
  fx.set({ key: 0.18, max: 2 }); amb.intensity = 0.4;
  const capped = await settle();
  // slow and in small steps (0.15 per second at 60 frames a second, as 0.3 at 120): the stored value must reach the goal, not stall short of it
  fx.set({ max: 10 });
  const goal = await settle(), steps = [];
  fx.set({ speedUp: 0.15 }); amb.intensity = 0.4 / 1.15;
  for (let i = 0; i < 18; i++) steps.push(await settle(40, 1 / 60));
  fx.remove();
  await brightness();
  const left = textures() - tex0;
  floor.removeFromParent(); amb.removeFromParent();
  return { plain, dark, path, keyed, live, capped, order, made, left, slow: { goal, steps } };
};

// Two bars over a white floor, lit from straight above (tilted along z only, so the edges along x stay where the bars are): a low one, 0.2 over the floor, and a high one, 2.95 over it.
// The pixels just outside and just inside each shadow's inner edge: PCSS widens the high bar's edge and keeps the low one's hard. The bars cast but do not draw, so every pixel read is floor
window.softShadow = async () => {
  const g = new THREE.Group(), floor = floorOf(0xffffff);
  floor.receiveShadow = true;
  const bar = (/** @type {number} */ x, /** @type {number} */ y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 6), new THREE.MeshStandardMaterial({ colorWrite: false, depthWrite: false })); m.position.set(x, y, 0); m.castShadow = true; return m; };
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0, 20, 0.5); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 40 });
  sun.shadow.filterNode = pcss({ lightSize: 0.15, samples: 16 });
  const hi = bar(2.5, 3);
  g.add(floor, bar(-2.5, 0.25), hi, new THREE.AmbientLight(0xffffff, 0.3));
  engine.scene.add(g, sun, sun.target);
  const o = 0.12;   // world units from the edge
  const edges = async () => {
    for (let i = 0; i < 3; i++) await frame();
    const px = await read();
    return { lowOut: atX(px, -1.5 + o), highOut: atX(px, 1.5 - o), lowIn: atX(px, -1.5 - o), highIn: atX(px, 1.5 + o), lit: atX(px, 0), shade: atX(px, -2.5) };
  };
  const single = await edges();
  // the engine's cascades on WebGPU are three's CSMShadowNode: the game's filterNode must reach every cascade
  const cs = engine.shadows.cascades(sun, { count: 2, maxFar: 30 });
  const cascaded = await edges();
  cs.remove();
  // the high bar between the search's depth levels (1 and 2.25 world units under maxDistance 4): the edge must still widen with every step up
  const mids = [];
  for (const h of [1.2, 1.6, 2]) { hi.position.y = h + 0.05; mids.push(await edges()); }
  const message = (/** @type {() => void} */ f) => { try { f(); return null; } catch (err) { return /** @type {Error} */ (err).message; } };
  g.removeFromParent(); sun.removeFromParent(); sun.target.removeFromParent();
  return { single, cascaded, mids, bad: message(() => pcss({ samples: 0 })) };
};

// A RectAreaLight over a plane and nothing else: it must light the plane with no setLTC / RectAreaLightUniformsLib.init from the game, on both renderers
const areaScene = () => {
  const g = new THREE.Group(), plane = floorOf(0xffffff), lamp = new THREE.RectAreaLight(0xffffff, 6, 3, 3);
  lamp.position.set(0, 3, 0); lamp.lookAt(0, 0, 0);
  g.add(plane, lamp);
  return g;
};
window.areaLight = async () => {
  const errors = [], err = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); err(...a); };
  const g = areaScene();
  engine.scene.add(g);
  let threw = null;
  try { engine.renderOnce(rt); } catch (e) { threw = /** @type {Error} */ (e).message; }   // drawn before the tables have loaded: the stand-ins
  let gpu = 0;
  for (let i = 0; i < 60 && gpu < 40; i++) { await frame(); gpu = atX(await read(), 0); }
  g.removeFromParent();
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }); document.body.appendChild(c);
  const e = createEngine({ canvas: c, lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, saveKey: 'test-picture-light-gl', urlState: false });
  e.scene.add(areaScene());
  await e.start(); e.haltLoop(); look(e.camera);
  const glrt = new THREE.WebGLRenderTarget(W, H), buf = new Uint8Array(W * H * 4);
  let gl = 0;
  for (let i = 0; i < 60 && gl < 40; i++) { e.renderOnce(glrt); await new Promise(requestAnimationFrame); /** @type {any} */ (e.renderer).readRenderTargetPixels(glrt, 0, 0, W, H, buf); gl = buf[((H >> 1) * W + (W >> 1)) * 4]; }
  const isGL = !/** @type {any} */ (e.renderer).isWebGPURenderer;
  e.dispose(); glrt.dispose();
  console.error = err;
  return { gpu, gl, isGL, threw, errors: errors.filter(m => /RectArea|LTC|ltc/i.test(m)) };
};
window.ready = true;
