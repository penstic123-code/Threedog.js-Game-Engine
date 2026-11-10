// Light shaft page (tests/specs/light-shaft.mjs): a dark room, a beam from y = 4 down to the floor. Every number is "with the beam minus without it"
// at points projected from the world, so the checks say what the beam does where, not how one frame looks.
// forceWebGL: true is what ordinary runs get (WebGPURenderer's WebGL2 backend); packages/tools/real-webgpu.mjs rewrites it to real WebGPU.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { lightShaft } from 'threedog/tsl';
import { createEngine } from '../../index.js';
import { backendName } from '../../render/backend.js';
import { bloom } from '@threedog/post-effects';

const W = 320, H = 240;
const renderer = new TG.WebGPURenderer({ canvas: document.getElementById('view'), antialias: false, forceWebGL: true });
const engine = window.engine = createEngine({ renderer, pixelRatio: 1, adaptiveResolution: false, lights: false, ui: { loading: false }, saveKey: 'test-light-shaft', urlState: false });
engine.tier = 'high';   // the headless GPU reads as low; the low-tier check sets it itself

const dim = new THREE.MeshBasicMaterial({ color: 0x101010 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), dim); floor.rotation.x = -Math.PI / 2;
const wall = new THREE.Mesh(new THREE.PlaneGeometry(12, 8), dim); wall.position.set(0, 4, -4);
// a white marker high on the left: tells which way readRenderTargetPixelsAsync stores rows on this backend
const marker = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ color: 0xffffff })); marker.position.set(-3.2, 5.2, -3.9);
engine.scene.add(floor, wall, marker);

await engine.start();
const demo = new URLSearchParams(location.search).get('demo');
if (!demo) engine.haltLoop();
engine.tier = 'high';   // again after start: the device tier found at start replaces the one set before it
const cam = engine.camera;
cam.position.set(0, 2.2, 6); cam.lookAt(0, 1.8, -1); cam.aspect = W / H; cam.near = 0.1; cam.far = 40; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
const rt = new TG.RenderTarget(W, H);

async function frame() {
  for (let i = 0; i < 4; i++) { engine.renderOnce(rt); await new Promise(requestAnimationFrame); }
  return new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
}
let topFirst = true;
/** mean over a 5x5 window around a world point's screen spot: one channel (ch 0 r, 1 g, 2 b) or the mean of the three */
const at = (px, p, ch = -1) => {
  const v = new THREE.Vector3(...p).project(cam), cx = Math.round((v.x + 1) / 2 * W), cy0 = Math.round((1 - v.y) / 2 * H), cy = topFirst ? cy0 : H - 1 - cy0;
  let s = 0, n = 0;
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) { const i = (y * W + x) * 4; s += ch < 0 ? (px[i] + px[i + 1] + px[i + 2]) / 3 : px[i + ch]; n++; }
  return s / n;
};
const add = (on, off, p, ch = -1) => +(at(on, p, ch) - at(off, p, ch)).toFixed(1);

// where to read: the beam's axis at mid height, near its side at the same height, outside it, and its foot (on the floor just inside the cone's front, where the cone meets it)
const P = { core: [0, 2, 0], side: [0.68, 2, 0], outside: [2.2, 2, 0], foot: [0, 0.02, 0.8] };
const SHAFT = { radiusTop: 0.5, radiusBottom: 0.9, length: 4, intensity: 0.12, color: 0xffffff };

window.shaftRun = async () => {
  const out = { backend: backendName(renderer) };
  const blank = await frame();
  topFirst = at(blank, marker.position.toArray()) > 100; out.topFirst = topFirst;
  const beam = lightShaft(engine, SHAFT); beam.position.set(0, 4, 0); engine.scene.add(beam);
  const on = await frame();
  out.add = Object.fromEntries(Object.keys(P).map(k => [k, add(on, blank, P[k])]));
  // the same beam without the fade at geometry: its foot is where the fade shows
  beam.visible = false;
  const hard = lightShaft(engine, { ...SHAFT, fadeAtGeometry: 0 }); hard.position.copy(beam.position); engine.scene.add(hard);
  const hardOn = await frame();
  out.hard = { core: add(hardOn, blank, P.core), foot: add(hardOn, blank, P.foot) };
  engine.remove(hard);
  beam.visible = true;
  // live number: half the intensity, about half the light, no rebuild needed
  beam.shaft.intensity.value = 0.06; out.half = add(await frame(), blank, P.core); beam.shaft.intensity.value = SHAFT.intensity;
  // fog dims the beam and never adds the fog colour (three's own fog under additive blending would): a red beam in green fog adds less red than in
  // clear air, and no green
  beam.shaft.color.value.set(0xff0000);
  const clearRed = add(await frame(), blank, P.core, 0);
  engine.scene.fog = new THREE.Fog(0x00ff00, 1, 8);
  const fogOff = (beam.visible = false, await frame()); beam.visible = true; const fogOn = await frame();
  out.fog = { clearRed, red: add(fogOn, fogOff, P.core, 0), green: add(fogOn, fogOff, P.core, 1) };
  engine.scene.fog = null;
  beam.shaft.color.value.set(0xffffff);
  // with bloom after it: the chain runs and the beam still adds where it stands, not elsewhere
  const glow = engine.post.add(bloom({ strength: 0.2 }));
  const bOff = (beam.visible = false, await frame()); beam.visible = true; const bOn = await frame();
  out.bloom = { core: add(bOn, bOff, P.core), outside: add(bOn, bOff, P.outside) };
  glow.remove();
  // dust: on 'high' it patterns the beam; on 'low' the pattern is skipped and the beam equals the even one
  const pattern = px => { const xs = [-0.3, -0.15, 0, 0.15, 0.3].flatMap(x => [1.2, 1.8, 2.4, 3].map(y => at(px, [x, y, 0]))); const m = xs.reduce((a, b) => a + b) / xs.length; return +Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length).toFixed(2); };
  const even = await frame();
  beam.shaft.dust.value = 1;
  const dusty = await frame();
  engine.tier = 'low'; const low = await frame(); engine.tier = 'high';
  beam.shaft.dust.value = 0;
  out.dust = { even: pattern(even), high: pattern(dusty), low: pattern(low), lowVsEven: +Math.abs(at(low, P.core) - at(even, P.core)).toFixed(2) };
  // follows a spot light: position and aim
  const spot = new THREE.SpotLight(0xffaa00, 10, 3, 0.3); spot.position.set(1.5, 3.5, -1); spot.target.position.set(1.5, 0, -1); engine.scene.add(spot, spot.target);
  const follow = lightShaft(engine, { light: spot }); engine.scene.add(follow);
  await frame();
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(follow.getWorldQuaternion(new THREE.Quaternion()));
  out.follow = { at: follow.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)), down: down.toArray().map(v => +v.toFixed(2)),
    radius: +follow.geometry.parameters.radiusBottom.toFixed(3), color: follow.shaft.color.value === spot.color };
  // engine.remove frees geometry and material (nothing else was made)
  const freed = [];
  follow.geometry.addEventListener('dispose', () => freed.push('geometry')); follow.material.addEventListener('dispose', () => freed.push('material'));
  engine.remove(follow); engine.scene.remove(spot, spot.target);
  out.freed = freed;
  engine.remove(beam);
  // refusals by name
  const err = f => { try { f(); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; } };
  out.refused = { webgl: err(() => lightShaft({ renderer: { isWebGLRenderer: true }, uniforms: {} }, {})), point: err(() => lightShaft(engine, { light: new THREE.PointLight() })),
    typo: err(() => lightShaft(engine, { radius: 1 })) };
  return out;
};
// ?demo=1 leaves a dusty beam on and the loop running, to look at it (threedog shot /tests/light-shaft/index.html?demo=1)
if (demo) {
  const beam = lightShaft(engine, { ...SHAFT, intensity: 0.25, dust: 0.6 }); beam.position.set(0, 4, 0); engine.scene.add(beam);
}
window.ready = true;
