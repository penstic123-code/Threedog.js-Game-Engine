// Sky dome and sky fog on both renderers (tests/specs/sky-tsl.mjs): the real engine sky (engine.use(sky())) drives one set of uniforms; the dome
// is built from them twice with the real makeDome, once for WebGLRenderer (ShaderMaterial) and once for WebGPURenderer on its WebGL2 backend
// (render/fx/sky.tsl.js node material), then both are drawn from the same camera at the same moment.
// Why compare means, not pixels: the two backends compile different shader text, so sin-hash noise can land a cloud edge one pixel apart;
// the pictures must agree in mean brightness and per-pixel on average.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';
import { createEngine, sky } from '../../index.js';
import { bindUniforms } from '../../render/engineUniforms.js';
import { swapWebGPUPart } from '../../render/backend.js';
import { makeDome, makeSkyUniforms } from '../../modules/sky/shader.js';
import { cloudUniforms } from '../../modules/sky/clouds.js';
import { DOME_FOG } from '../../modules/sky/fog.js';
import { renderOnce } from '../../render/backend.js';

const W = 200, H = 150;
// colored keyframes (the neutral ones are grey): a warm sunrise horizon and a blue noon, so a hue mistake shows in the mean
const KF = [[0, 0x101830, 0x203050, 0x8090c0, 0.3], [0.2, 0x101830, 0x203050, 0x8090c0, 0.3], [0.25, 0x4060a0, 0xf0a070, 0xffc080, 0.6],
  [0.5, 0x3a78d8, 0xb8d8f0, 0xffffff, 1], [0.75, 0x4060a0, 0xf0a070, 0xffc080, 0.6], [0.8, 0x101830, 0x203050, 0x8090c0, 0.3], [1, 0x101830, 0x203050, 0x8090c0, 0.3]];
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-sky-tsl', urlState: false });
engine.use(sky({ time: 0.27, keyframes: KF, clouds: { coverage: 1 } }));
await engine.start();
engine.haltLoop();
engine.uniforms.uWeatherCloud.value = 0.55;   // weather's cloud amount (no weather module here): clouds on

const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const gl = new THREE.WebGLRenderer({ canvas: canvas(), antialias: false });
gl.setPixelRatio(1); gl.setSize(W, H, false); gl.toneMapping = THREE.NoToneMapping;
const gpu = new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true });
gpu.setPixelRatio(1); gpu.setSize(W, H, false); gpu.toneMapping = THREE.NoToneMapping;
await gpu.init();
bindUniforms(gpu, engine.uniforms);   // what the engine does for its own WebGPURenderer; a hand-made one stands in here
// sRGB targets: the bytes compared are the encoded colors a screen shows (both materials end in three's color space conversion)
const glRT = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace }), gpuRT = new TG.RenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });

const S = engine.sky;
const gpuHost = { renderer: gpu, uniforms: engine.uniforms };
const st = { clouds: { coverage: 1 } };
const sceneOf = o => { const s = new THREE.Scene(); s.add(o); return s; };
const pair = (U, stl) => ({ gl: sceneOf(makeDome(U, stl, DOME_FOG)), gpu: sceneOf(makeDome(U, stl, DOME_FOG, gpuHost)) });
const PLANE = pair(S.uniforms, st);
// cumulus: the same sky uniforms with the cumulus defaults for the cloud shape ones
const UC = { ...S.uniforms, ...cloudUniforms({ kind: 'cumulus' }, 'cumulus') };
const CUMULUS = pair(UC, { clouds: { kind: 'cumulus', coverage: 1 } });

// camera towards the sunrise azimuth, a little above the horizon: horizon band, sun disc and clouds are all in frame
S.fixedTime = 0.27; S.update(engine.focus);
const az = Math.atan2(S.sunDir.x, S.sunDir.z);
const cam = new THREE.PerspectiveCamera(80, W / H, 0.1, 500); cam.position.set(0, 2, 0);
cam.lookAt(Math.sin(az) * 10, 2 + 10 * Math.tan(0.35), Math.cos(az) * 10); cam.updateMatrixWorld();

const shot = async (r, scene, c = cam) => {
  if (r === gl) { gl.setRenderTarget(glRT); gl.setClearColor(0, 1); gl.render(scene, c); const b = new Uint8Array(W * H * 4);
    gl.readRenderTargetPixels(glRT, 0, 0, W, H, b); gl.setRenderTarget(null); return b; }
  gpu.setRenderTarget(gpuRT); gpu.setClearColor(0, 1); gpu.render(scene, c);
  const b = new Uint8Array(await gpu.readRenderTargetPixelsAsync(gpuRT, 0, 0, W, H)); gpu.setRenderTarget(null); return b;
};
const mean = b => { let s = 0; for (let i = 0; i < b.length; i += 4) s += (b[i] + b[i + 1] + b[i + 2]) / 3; return s / (W * H); };
/** relative mean difference (%), mean absolute per-channel difference (% of 255), the WebGL mean */
const compare = (a, b) => {
  const A = mean(a), B = mean(b);
  let abs = 0; for (let i = 0; i < a.length; i += 4) abs += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return { meanDiff: +(100 * Math.abs(A - B) / Math.max(1e-6, A)).toFixed(2), absDiff: +(100 * abs / (W * H * 3 * 255)).toFixed(3), mean: +A.toFixed(2) };
};
/** mean absolute difference between two shots of one renderer, % of 255 */
const change = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]); return +(100 * s / (W * H * 3 * 255)).toFixed(3); };

const TIMES = [0.25, 0.28, 0.33, 0.42, 0.5];   // sunrise (06:00) to noon

window.skyTsl = async () => {
  const out = { kinds: [PLANE.gl.children[0].material.type, PLANE.gpu.children[0].material.type], times: {}, cumulus: {}, errors: {} };
  let prev = null;
  for (const t of TIMES) {
    S.fixedTime = t; S.update(engine.focus);   // the real sky writes uTop / uHorizon / uSunColor / engine.uniforms.uSunDir ...
    const a = await shot(gl, PLANE.gl), b = await shot(gpu, PLANE.gpu);
    const r = compare(a, b);
    if (prev) r.moved = [change(prev[0], a), change(prev[1], b)];   // the time step moved both pictures
    out.times[t] = r; prev = [a, b];
  }
  // fog band on (a fog color that is not the horizon), and engine.uniforms.uTime moved: clouds drift on both
  for (const [name, set] of [['cumulus', () => {}], ['fogBand', () => { S.uniforms.uFogBand.value = 1; }], ['later', () => { engine.uniforms.uTime.value += 40; }]]) {
    S.fixedTime = 0.33; S.update(engine.focus); set();
    const P = name === 'cumulus' ? CUMULUS : PLANE;
    out.cumulus[name] = compare(await shot(gl, P.gl), await shot(gpu, P.gpu));
  }
  S.uniforms.uFogBand.value = 0;

  const tryIt = fn => { try { fn(); return 'no error'; } catch (e) { return String(e.message); } };
  // ---- the engine entry: createEngine({ renderer: 'webgpu' }) + sky() builds the node dome itself and draws what the WebGL engine draws.
  // navigator.gpu taken away so the WebGPURenderer runs on its WebGL2 backend on every machine (tests/backend does the same)
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  try {
    const c2 = Object.assign(document.createElement('canvas'), { width: W, height: H }); c2.style.cssText = `width:${W}px;height:${H}px`; document.body.appendChild(c2);
    const e2 = createEngine({ canvas: c2, renderer: 'webgpu', pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, saveKey: 'test-sky-tsl-gpu', urlState: false });
    e2.use(sky({ time: 0.33, keyframes: KF, clouds: { coverage: 1 } }));
    e2.scene.fog = new THREE.FogExp2(0xcccccc, 0.01);
    await e2.start(); e2.haltLoop();
    e2.uniforms.uWeatherCloud.value = engine.uniforms.uWeatherCloud.value; e2.uniforms.uTime.value = engine.uniforms.uTime.value;
    S.fixedTime = 0.33; S.update(engine.focus); e2.sky.update(e2.focus);
    e2.scene.fog.color.copy(e2.sky.uniforms.uHorizon.value); e2.sky.update(e2.focus);   // a fog in the horizon color: no fog band on the dome, like the WebGL side
    // the engine's own scene (only the dome draws in it: no ground, no objects) against the WebGL dome over the WebGL engine's uniforms
    const a = await shot(gl, sceneOf(makeDome(S.uniforms, st, DOME_FOG)));
    const rt = new TG.RenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace }); renderOnce(e2.renderer, e2.scene, cam, rt);
    const read = async () => { renderOnce(e2.renderer, e2.scene, cam, rt); return new Uint8Array(await e2.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H)); };
    const b = await read();
    // engine.uniforms is the dome's own value on this renderer too: a plain .value write moves the picture, and writing it back restores it
    const moved = {};
    for (const [k, v] of [['uSkyCurve', 3], ['uCloudCover', 0], ['uSkyCloudScale', 3]]) {
      const was = e2.uniforms[k].value; e2.uniforms[k].value = v; moved[k] = change(b, await read()); e2.uniforms[k].value = was;
    }
    moved.back = change(b, await read()); rt.dispose();
    // engine.sky.environment on this renderer: three/webgpu's PMREMGenerator draws the node dome
    const envH = e2.sky.environment({ into: e2.scene }); e2.sky._envFrame(0); out.env = { written: !!envH.texture && e2.scene.environment === envH.texture };
    // a rebuild refills the same texture: a new one rebuilt every material reading the environment (a stall at each rebuild, modules/sky/environment.js)
    const envFirst = envH.texture; e2.sky._envBuild(); out.env.same = envH.texture === envFirst && e2.sky._env.builds === 2;
    envH.remove(); out.env.off = e2.scene.environment === null;
    // the real hook path on the WebGPU engine's node dome
    out.errors.cloudsHookGpu = tryIt(() => e2.sky.clouds('vec4 threedogClouds(vec3 d, float t, vec3 s, float n, vec3 l, vec3 h, float c){ return vec4(1.0); }'));
    out.engine = { isGPU: !!e2.renderer.isWebGPURenderer, dome: e2.sky.dome.material.type, moved, ...compare(a, b) };
    e2.dispose();
  } finally { delete navigator.gpu; }

  // ---- errors by name
  const keep = swapWebGPUPart('sky', null);
  try {
    out.errors.noTslDome = tryIt(() => makeDome(makeSkyUniforms({}, engine.uniforms), {}, DOME_FOG, gpuHost));
  } finally { swapWebGPUPart('sky', keep); }
  out.errors.glDome = tryIt(() => makeDome(makeSkyUniforms({}, engine.uniforms), {}, DOME_FOG));
  return out;
};
