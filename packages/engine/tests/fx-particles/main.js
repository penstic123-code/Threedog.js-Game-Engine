// Particles / weather on both renderers (tests/specs/fx-particles.mjs): the real engine code (modules/particles Effect, modules/weather makeSystem)
// built once against WebGLRenderer (ShaderMaterial + Points / LineSegments) and once against WebGPURenderer on its WebGL2 backend (sprite quads +
// node materials from render/fx/particles.tsl.js), same seed, same camera, same moment.
// Why compare means, not pixels: a point sprite and an instanced quad rasterize their edges differently, so per-pixel equality is not expected;
// the data (count, positions) must match exactly and the pictures must agree in brightness and in where the particles are (lit-pixel centroid).
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import * as TSL from 'three/tsl';
import 'threedog/tsl';
import { createEngine, particles } from '../../index.js';
import { bindUniforms } from '../../render/engineUniforms.js';
import { swapWebGPUPart } from '../../render/backend.js';
import { Particles } from '../../modules/particles/Particles.js';
import { makeSystem, updateSystem, RAIN, SNOW } from '../../modules/weather/particles.js';
import { pointVert } from '../../modules/weather/shaders.js';
import { WeatherDraw } from '../../modules/weather/weatherDraw.js';

const W = 200, H = 150;
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-fx-particles', urlState: false });
await engine.start();
engine.haltLoop();

const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(0, 2, 7); cam.lookAt(0, 1.5, 0); cam.updateMatrixWorld();
const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const gl = new THREE.WebGLRenderer({ canvas: canvas(), antialias: false });
gl.setPixelRatio(1); gl.setSize(W, H, false); gl.toneMapping = THREE.NoToneMapping; gl.outputColorSpace = THREE.LinearSRGBColorSpace;
const gpu = new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true });
gpu.setPixelRatio(1); gpu.setSize(W, H, false); gpu.toneMapping = THREE.NoToneMapping; gpu.outputColorSpace = THREE.LinearSRGBColorSpace;
await gpu.init();
bindUniforms(gpu, engine.uniforms);   // what the engine will do for its own WebGPURenderer (step 2); a hand-made one stands in here
const glRT = new THREE.WebGLRenderTarget(W, H), gpuRT = new TG.RenderTarget(W, H);

/** A stand-in engine around one renderer and its own scene: what Effect / makeSystem read (renderer, camera, scene, add / remove, tier, uniforms) */
const host = renderer => {
  const scene = new THREE.Scene();
  return { renderer, scene, camera: cam, tier: 'high', uniforms: engine.uniforms, assets: engine.assets,
    add(o) { scene.add(o); return o; }, remove(o) { scene.remove(o); o.geometry?.dispose(); o.material?.dispose(); } };
};
const HGL = host(gl), HGPU = host(gpu);

const shot = async h => {
  if (h.renderer === gl) { gl.setRenderTarget(glRT); gl.setClearColor(0, 1); gl.render(h.scene, cam); const b = new Uint8Array(W * H * 4);
    gl.readRenderTargetPixels(glRT, 0, 0, W, H, b); gl.setRenderTarget(null); return b; }
  gpu.setRenderTarget(gpuRT); gpu.setClearColor(0, 1); gpu.render(h.scene, cam);
  const b = new Uint8Array(await gpu.readRenderTargetPixelsAsync(gpuRT, 0, 0, W, H)); gpu.setRenderTarget(null); return b;
};
/** mean brightness (0..255), lit share, lit-pixel centroid */
const stats = b => {
  let sum = 0, n = 0, cx = 0, cy = 0, ws = 0;
  for (let i = 0; i < W * H; i++) { const v = (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2]) / 3; sum += v; if (v > 8) { n++; ws += v; cx += (i % W) * v; cy += Math.floor(i / W) * v; } }
  const wsum = Math.max(1e-6, ws);
  return { mean: sum / (W * H), lit: n / (W * H), cx: cx / wsum, cy: cy / wsum };
};
/** the two pictures compared: relative mean difference (%), mean absolute pixel difference (% of 255), centroid distance (px) */
const compare = (a, b) => {
  const A = stats(a), B = stats(b);
  let abs = 0; for (let i = 0; i < a.length; i += 4) abs += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return { meanDiff: +(100 * Math.abs(A.mean - B.mean) / Math.max(1e-6, A.mean)).toFixed(2), absDiff: +(100 * abs / (W * H * 3 * 255)).toFixed(3),
    centroid: +Math.hypot(A.cx - B.cx, A.cy - B.cy).toFixed(2), mean: +A.mean.toFixed(2), lit: +A.lit.toFixed(3) };
};
/** share of pixels that changed between two shots of one renderer, in % */
const moved = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; return +(100 * n / (W * H)).toFixed(2); };

/** Run fn with Math.random replaced by a seeded generator (mulberry32): both sides get the same scatter */
function seeded(seed, fn) {
  const r = Math.random; let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = r; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

window.fxParticles = async () => {
  const out = { particles: {}, weather: {}, errors: {} };
  // ---- particles: one effect per blending, emitted from the same seed, aged the same, then aged again (the "time" of a particle system)
  const PGL = new Particles(HGL), PGPU = new Particles(HGPU);
  const DEFS = {
    puff: { max: 80, lifetime: [3, 4], speed: [0.6, 1.4], spread: Math.PI, gravity: 0.3, drag: 0.3, size: [0.5, 1.1], color: [0xffcc88, 0x8899ff], opacity: [0.9, 0.2] },
    sparks: { max: 60, lifetime: [3, 4], speed: [1, 2], spread: 1.2, gravity: -0.4, size: [0.25, 0.15], color: [0xffaa33, 0xff3300], opacity: [1, 0.4], blending: 'additive', spin: 2 },
  };
  for (const [name, def] of Object.entries(DEFS)) {
    for (const P of [PGL, PGPU]) { P.define(name, def); seeded(7, () => P.emit(name, [0, 1.5, 0], { count: 50 })); P.update(0.4); }
    const a = await shot(HGL), b = await shot(HGPU);
    const fa = PGL.effects.get(name), fb = PGPU.effects.get(name);
    const r = { count: [PGL.count(name), PGPU.count(name)], samePos: same(fa.aPos.array, fb.aPos.array) && same(fa.aSize.array, fb.aSize.array) && same(fa.aAlpha.array, fb.aAlpha.array),
      kinds: [fa.points.type, fb.points.type, fb.material.type], instances: fb.points.count, ...compare(a, b) };
    for (const P of [PGL, PGPU]) P.update(0.5);
    const a2 = await shot(HGL), b2 = await shot(HGPU);
    r.later = { moved: [moved(a, a2), moved(b, b2)], samePos: same(fa.aPos.array, fb.aPos.array), ...compare(a2, b2) };
    out.particles[name] = r;
    for (const P of [PGL, PGPU]) P.clear(name);
  }
  // ---- fog on, both blendings, into a linear target (where the engine draws whenever post is on): the WebGL shader mixes the fog after its
  // tone-mapping / color-space chunks, which do nothing in a linear target, so both sides mix in linear and must agree.
  // Logged only, the canvas with a tone curve + sRGB output (no post): there WebGL blends transparent pixels on the sRGB-encoded canvas and
  // WebGPU in its linear frame buffer, a difference of every transparent material and present without fog (canvasNoFog), so it is no fog parity bound
  const canvasShot = h => {
    const r = h.renderer, tm = r.toneMapping, cs = r.outputColorSpace;
    r.toneMapping = THREE.AgXToneMapping; r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor(0, 1);
    r.render(h.scene, cam);
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(r.domElement, 0, 0);
    r.toneMapping = tm; r.outputColorSpace = cs;
    return x.getImageData(0, 0, W, H).data;
  };
  out.fog = {};
  for (const name of Object.keys(DEFS)) {
    for (const P of [PGL, PGPU]) { seeded(7, () => P.emit(name, [0, 1.5, 0], { count: 50 })); P.update(0.4); }
    const plainGL = stats(await shot(HGL)).mean;
    for (const h of [HGL, HGPU]) h.scene.fog = new THREE.Fog(0x8899aa, 2, 10);   // the puff sits 7 m away: about 60% fog
    const a = await shot(HGL), b = await shot(HGPU), A = stats(a), B = stats(b);
    out.fog[name] = { ...compare(a, b), fogGL: +(100 * Math.abs(A.mean - plainGL) / Math.max(1e-6, plainGL)).toFixed(2), gpuMean: +B.mean.toFixed(2),
      canvas: compare(canvasShot(HGL), canvasShot(HGPU)).meanDiff };
    for (const h of [HGL, HGPU]) h.scene.fog = null;
    out.fog[name].canvasNoFog = compare(canvasShot(HGL), canvasShot(HGPU)).meanDiff;
    for (const P of [PGL, PGPU]) P.clear(name);
  }
  // ---- weather: built-in rain (lines) and snow (sprites), same scatter seed, then time moved on (uFallOff / uSway from t)
  for (const [field, base] of [['rain', RAIN], ['snow', SNOW]]) {
    const [sa, sb] = [HGL, HGPU].map(h => seeded(11, () => makeSystem(h, field, {}, { area: 14, count: 600, base })));
    const step = t => { for (const s of [sa, sb]) updateSystem(s, 1, cam, t, 0.6); };
    step(3.2);
    const a = await shot(HGL), b = await shot(HGPU);
    const pa = sa.object.geometry.getAttribute('position').array, pb = sb.line ? sb.object.geometry.getAttribute('position').array : sb.object.geometry.getAttribute('aPos').array;
    const r = { kinds: [sa.object.type, sb.object.type, sb.object.material.type], samePos: same(pa, pb),
      drawn: [sa.line ? sa.object.geometry.drawRange.count / 2 : sa.object.geometry.drawRange.count, sb.line ? sb.object.geometry.drawRange.count / 2 : sb.object.count], ...compare(a, b) };
    step(3.9);
    const a2 = await shot(HGL), b2 = await shot(HGPU);
    r.later = { moved: [moved(a, a2), moved(b, b2)], ...compare(a2, b2) };
    out.weather[field] = r;
    for (const [h, s] of [[HGL, sa], [HGPU, sb]]) h.remove(s.object);
  }
  // ---- errors by name: a game's own GLSL on WebGPU, and the TSL side not loaded
  const tryIt = fn => { try { fn(); return 'no error'; } catch (e) { return String(e.message); } };
  const glsl = { vertex: 'void main(){ gl_Position = vec4(0.0); }', fragment: 'void main(){ gl_FragColor = vec4(1.0); }' };
  out.errors.glslGpu = tryIt(() => makeSystem(HGPU, 'ash', { glsl }, { area: 14, count: 10 }));
  out.errors.glslGl = tryIt(() => { const s = makeSystem(HGL, 'ash', { glsl }, { area: 14, count: 10 }); HGL.remove(s.object); });
  const keep = swapWebGPUPart('particles', null);
  try {
    out.errors.noTslParticles = tryIt(() => PGPU.define('lost', {}));
    out.errors.noTslWeather = tryIt(() => makeSystem(HGPU, 'snow', {}, { area: 14, count: 10, base: SNOW }));
  } finally { swapWebGPUPart('particles', keep); }
  return out;
};

// ---- the soft option: pictures of one particle in front of a wall, on every route and target
const PIX = b => b[(H / 2 * W + W / 2) * 4];
/** The red of the middle pixel of one draw of scene, on target or the canvas (a white additive particle over black: its alpha, 0..255) */
async function middle(r, scene, camera, target) {
  r.setClearColor(0, 1); r.setRenderTarget(target ?? null); r.render(scene, camera);
  if (target) {
    const b = new Uint8Array(W * H * 4);
    const px = r.isWebGPURenderer ? new Uint8Array(await r.readRenderTargetPixelsAsync(target, 0, 0, W, H)) : (r.readRenderTargetPixels(target, 0, 0, W, H, b), b);
    r.setRenderTarget(null);
    return PIX(px);
  }
  const x = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  x.drawImage(r.domElement, 0, 0);
  return PIX(x.getImageData(0, 0, W, H).data);
}
const SOFT_CAM = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); SOFT_CAM.position.set(0, 0, 7); SOFT_CAM.lookAt(0, 0, 0); SOFT_CAM.updateMatrixWorld();
const SOFT_ORTHO = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 200); SOFT_ORTHO.position.set(0, 0, 7); SOFT_ORTHO.lookAt(0, 0, 0); SOFT_ORTHO.updateMatrixWorld();
const STILL = { max: 4, lifetime: [100, 100], speed: 0, spread: 0, gravity: 0, drag: 0, size: 3, color: 0xffffff, opacity: 1, blending: 'additive', fog: false };

/** Values of the slots written so far: [[got, want]...] compared by the spec */
const LIFE = { max: 8, lifetime: [4, 4], speed: 0, spread: 0, gravity: 0, drag: 0, fog: false };
const srgb = c => new THREE.Color(c).r;   // a color's red in the linear space the attribute holds
const refuse = fn => { try { fn(); return 'no error'; } catch (e) { return String(e.message); } };

/** A game's own material reading aLife, per route: color = aLife, at the particle's place */
function ownMaterial(fx, gpuRoute) {
  if (!gpuRoute) return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.NoBlending,
    vertexShader: 'attribute float aLife; attribute float aAlpha; varying float vLife; void main() { vLife = aLife; gl_PointSize = aAlpha > 0.0 ? 40.0 : 0.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vLife; void main() { gl_FragColor = vec4(vec3(vLife), 1.0); }' });
  const m = new TG.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NoBlending, sizeAttenuation: false });
  m.sizeNode = TSL.float(40);   // no positionNode: the engine's places it
  m.colorNode = TSL.vec4(TSL.vec3(TSL.attribute('aLife', 'float')), 1);
  return m;
}

window.fxOverLife = async () => {
  const routes = {};
  for (const [name, h, target] of [['webgl', HGL, glRT], ['webgl2-backend', HGPU, gpuRT]]) {
    const P = new Particles(h), gpuRoute = h === HGPU, c = routes[name] = {};
    const one = (id, opts, age = 1, emit = {}) => { const fx = P.define(id, { ...LIFE, ...opts }); P.emit(id, [0, 0, 0], { count: 1, ...emit }); P.update(age); return fx; };
    // aLife: six particles of different lives
    const fx = P.define('life', { ...LIFE, max: 6, lifetime: [2, 8] }); P.emit('life', [0, 0, 0], { count: 6 }); P.update(1);
    c.life = [...Array(6).keys()].map(i => [fx.aLife.array[i], fx.age[i] / fx.life[i]]);
    c.lifeUploads = fx.aLife.version > 0 && fx.aLife.updateRanges.length > 0;
    P.clear('life');
    // a game's material
    const own = one('own', { lifetime: [4, 4] }, 1);
    own.material = ownMaterial(own, gpuRoute);
    if (gpuRoute) c.ownNodes = { placed: !!own.material.positionNode, sized: own.material.sizeNode !== own._own.sizeNode, plain: refuse(() => { own.material = new THREE.PointsMaterial(); }) };
    h.camera = SOFT_CAM;
    c.ownMaterial = await middle(h.renderer, h.scene, SOFT_CAM, target);
    h.camera = cam; own.material = null; P.clear('own');
    // the two-point form, against the old sum
    const two = one('two', { size: [1, 3], opacity: [0.8, 0], color: [0xff0000, 0x0000ff] }, 1), k = 0.25;
    c.twoPoint = [[two.aSize.array[0], 1 + 2 * k], [two.aAlpha.array[0], 0.8 * (1 - k)], [two.aColor.array[0], 1 - k], [two.aColor.array[1], 0], [two.aColor.array[2], k]];
    P.clear('two');
    const single = one('single', { size: 2, opacity: 0.5, color: 0xff0000 }, 1);
    c.single = [[single.aSize.array[0], 2], [single.aAlpha.array[0], 0.5], [single.aColor.array[0], 1]];
    P.clear('single');
    // timed: 0 -> 1 by 0.25, back to 0 at 1; lives 4 s
    const fade = one('fade', { opacity: [[0, 0], [0.25, 1], [1, 0]] }, 0.5), got = [[fade.aAlpha.array[0], 0.5]];
    P.update(0.5); got.push([fade.aAlpha.array[0], 1]); P.update(1.5); got.push([fade.aAlpha.array[0], 0.5]); c.fade = got; P.clear('fade');
    // even: three stops
    const even = one('even', { size: [1, 5, 2], color: [0x000000, 0xffffff, 0x000000] }, 2);
    c.even = [[even.aSize.array[0], 5], [even.aColor.array[0], 1]];
    P.update(1); c.even.push([even.aSize.array[0], 3.5], [even.aColor.array[0], 0.5]); P.clear('even');
    const ends = one('ends', { size: [[0.25, 2], [0.5, 4]] }, 0.5);
    c.ends = [[ends.aSize.array[0], 2]]; P.update(2.5); c.ends.push([ends.aSize.array[0], 4]); P.clear('ends');
    // overrides: two batches, two curves, one effect
    const bat = P.define('bat', { ...LIFE, opacity: [1, 1] });
    P.emit('bat', [0, 0, 0], { count: 1 }); P.emit('bat', [0, 0, 0], { count: 1, overrides: { opacity: [[0, 0], [0.5, 1], [1, 0]] } }); P.update(1);
    c.batches = [[bat.aAlpha.array[0], 1], [bat.aAlpha.array[1], 0.5]]; P.clear('bat');
    // a fade-in on screen
    const fi = one('fi', { ...STILL, lifetime: [4, 4], opacity: [[0, 0], [0.25, 1], [1, 1]] }, 0);
    c.fadeIn = [await middle(h.renderer, h.scene, SOFT_CAM, target)]; P.update(1); c.fadeIn.push(await middle(h.renderer, h.scene, SOFT_CAM, target)); P.clear('fi');
    for (const n of ['life', 'own', 'two', 'single', 'fade', 'even', 'ends', 'bat', 'fi']) P.effects.get(n).dispose();
  }
  const P = new Particles(HGL); P.define('ok', {});
  const refused = {
    'one stop': refuse(() => P.define('x', { size: [1] })),
    'times out of order': refuse(() => P.define('x', { opacity: [[0.5, 1], [0.2, 0]] })),
    'a time past death': refuse(() => P.define('x', { opacity: [[0, 1], [1.5, 0]] })),
    'forms mixed': refuse(() => P.define('x', { size: [[0, 1], 2] })),
    'a word for a size': refuse(() => P.define('x', { size: ['big', 'small'] })),
    'in emit overrides': refuse(() => P.emit('ok', [0, 0, 0], { overrides: { size: [1] } })),
    'in attach overrides': refuse(() => P.attach('ok', h0(), { overrides: { opacity: [[0, 1], [0, NaN]] } })),
    'in particles({ effects })': refuse(() => particles({ effects: { a: { size: [1] } } })),
    'in particles({ default })': refuse(() => particles({ default: { opacity: [] } })),
  };
  P.effects.get('ok').dispose();
  return { routes, refused };
};

const h0 = () => HGL.add(new THREE.Object3D());
/** x of each live particle, oldest slot first */
const xs = fx => [...fx.life].flatMap((l, i) => l ? [fx.pos[i * 3]] : []).sort((a, b) => a - b);
const gaps = x => { const g = x.slice(1).map((v, i) => v - x[i]); return [Math.min(...g), Math.max(...g)]; };

window.fxPerMeter = async () => {
  const P = new Particles(HGL), TRAIL = { ...LIFE, max: 64, lifetime: [100, 100], rate: 0 }, out = {};
  const run = (opts, attach, steps) => {
    const fx = P.define('t', { ...TRAIL, ...opts }), o = h0(), h = P.attach('t', o, attach);
    P.update(0.01);   // the first step only notes where it is
    for (const [x, dt = 0.01] of steps) { o.position.x = x; P.update(dt); }
    const r = { fx, x: xs(fx), h, o };
    return r;
  };
  const done = ({ fx, h, o }) => { h.remove(); HGL.remove(o); P.clear('t'); fx.dispose(); P.effects.delete('t'); };
  let t = run({ ratePerMeter: 2 }, {}, [[20]]);
  out.fast = { n: t.x.length, gap: gaps(t.x), last: t.x.at(-1) }; done(t);
  t = run({ ratePerMeter: 2 }, {}, [[0.3], [0.31], [2.9], [6]]);
  out.uneven = { n: t.x.length, gap: gaps(t.x) }; done(t);
  t = run({ rate: 100 }, {}, [[20, 0.2]]);
  out.rateOnly = t.x; done(t);
  t = run({ rate: 100, ratePerMeter: 2 }, {}, [[10, 0.05]]);
  out.both = t.x.length; done(t);
  t = run({ ratePerMeter: 2 }, {}, [[0], [0]]);
  out.still = t.x.length; done(t);
  t = run({ ratePerMeter: 2 }, {}, []); t.h.ratePerMeter = 1; t.o.position.x = 3; P.update(0.01);
  out.live = xs(t.fx).length; done(t);
  t = run({ ratePerMeter: 2 }, { ratePerMeter: 1 }, [[3]]);
  out.attachWins = t.x.length; done(t);
  t = run({ ratePerMeter: 2 }, {}, []); t.h.active = false; P.update(0.01); t.o.position.x = 50; P.update(0.01); t.h.active = true; P.update(0.01);
  out.paused = xs(t.fx).length; done(t);
  t = run({ ratePerMeter: 2 }, {}, []); HGL.still = true; t.o.position.x = 10; P.update(0.01);
  const during = xs(t.fx).length; HGL.still = false; P.update(0.01);
  out.frozen = { during, after: xs(t.fx).length }; done(t);
  const uw = engine.uniforms.uWind.value; engine.uniforms.uWind.value = 2;
  t = run({ ratePerMeter: 2, wind: 1, windDir: [0, 0, 1] }, {}, [[1]]); P.update(0.1); out.wind = Math.abs(t.fx.pos[2]); done(t);
  engine.uniforms.uWind.value = uw;
  t = run({ ratePerMeter: 2, max: 8 }, {}, [[100]]);
  out.cap = { n: t.x.length, first: t.x[0], last: t.x.at(-1) }; done(t);
  out.refused = { define: refuse(() => P.define('x', { ratePerMeter: -1 })), attach: (P.define('y', {}), refuse(() => P.attach('y', h0(), { ratePerMeter: -1 }))) };
  P.effects.get('y').dispose();
  return out;
};

/** One renderer, a black wall at z = 0 behind an unseen sheet that writes no depth: the middle pixel of a particle in front of it, hard and with soft 2 */
async function softCase(r, target, camera = SOFT_CAM) {
  const h = host(r); h.camera = camera;
  const P = new Particles(h);
  const wall = h.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0 })));
  const glass = h.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0, depthWrite: false })));
  glass.position.z = 0.3;   // no surface to fade against
  const at = async (name, gap) => { P.emit(name, [0, 0, gap], { count: 1 }); P.update(0.01); const v = await middle(r, h.scene, camera, target); P.clear(name); P.update(0.01); return v; };
  P.define('hard', STILL); P.define('soft', { ...STILL, soft: 2 });
  const out = { hard: await at('hard', 1), near: await at('soft', 0.02), mid: await at('soft', 1), far: await at('soft', 3), behind: await at('soft', -1) };
  P.effects.get('soft').uniforms.uSoft.value = 4; out.live = await at('soft', 1);   // a gap of 1 m with soft 4 reads a quarter
  for (const n of ['hard', 'soft']) P.effects.get(n).dispose();
  h.remove(wall); h.remove(glass);
  return out;
}

/** What soft costs a game: render calls per frame on WebGL with it off, on, idle and under a game's material; the material on both routes */
async function softCost() {
  const c = {}, P = new Particles(HGL), scene = HGL.scene;
  const wall = HGL.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0 })));
  const glass = HGL.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0, depthWrite: false })));
  const renders = async () => { const was = gl.render; let n = 0; gl.render = function (...a) { n++; return was.apply(this, a); }; await middle(gl, scene, SOFT_CAM, glRT); gl.render = was; return n; };
  const hard = P.define('hard', STILL), soft = P.define('soft', { ...STILL, soft: 2 }), soft2 = P.define('soft2', { ...STILL, soft: 1 });
  P.update(0.01);
  P.emit('hard', [0, 0, 1], { count: 1 }); P.update(0.01);
  c.off = { renders: await renders(), defines: Object.keys(hard.material.defines).length, depth: P._depth !== null, uSoft: 'uSoft' in hard.uniforms };
  c.idle = { renders: await renders() };
  P.emit('soft', [0, 0, 1], { count: 1 }); P.emit('soft2', [0, 0, 1], { count: 1 }); P.update(0.01);
  const mask = glass.layers.mask;
  c.two = { renders: await renders() };
  c.restored = glass.layers.mask === mask && scene.overrideMaterial === null && P._depth !== null;
  P.clear('soft2'); P.update(0.01);
  const mine = soft.material = new THREE.PointsMaterial({ size: 4 });
  c.given = { renders: await renders() };
  soft.material = null; mine.dispose();
  for (const n of ['hard', 'soft', 'soft2']) P.effects.get(n).dispose();
  HGL.remove(wall); HGL.remove(glass);
  // WebGPU: the depth read is in the graph only with soft on, and uSoft with it
  const G = new Particles(HGPU), hasDepth = fx => 'uSoft' in fx.uniforms;
  c.nodes = [hasDepth(G.define('a', STILL)), hasDepth(G.define('b', { ...STILL, soft: 2 }))];
  G.effects.get('a').dispose(); G.effects.get('b').dispose();
  return c;
}

/** A real engine with a wall and a soft effect: the picture at the wall and away from it, as the engine draws it */
async function softEngine(extra, post) {
  const can = canvas(), e = createEngine({ canvas: can, lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, urlState: false, saveKey: 'test-fx-soft', ...extra });
  e.use(particles());
  e.particles.define('s', { ...STILL, soft: 2 });
  await e.start(); e.haltLoop();
  e.renderer.toneMapping = THREE.NoToneMapping;
  e.camera.position.set(0, 0, 7); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
  e.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0 })));
  if (post) e.post.add({ name: 'through', slot: 'ldr', fuse: { glsl: '', tsl: c => c } });
  const look = z => {
    e.particles.emit('s', [0, 0, z], { count: 1 }); e.step(1 / 60);
    const x = Object.assign(document.createElement('canvas'), { width: can.width, height: can.height }).getContext('2d', { willReadFrequently: true });
    x.drawImage(e.renderer.domElement, 0, 0);
    const v = x.getImageData(can.width >> 1, can.height >> 1, 1, 1).data[0];
    e.particles.clear('s'); return v;
  };
  const r = { near: look(0.01), mid: look(1), away: look(4), backend: e.describe().renderer?.backend };
  e.destroy?.();
  return r;
}

window.fxSoft = async ({ real = false } = {}) => {
  const out = {}, errors = [], warned = [], keep = console.error, keepWarn = console.warn;
  console.error = (...a) => { errors.push(a.join(' ').slice(0, 200)); keep(...a); };
  console.warn = (...a) => { warned.push(a.join(' ').slice(0, 300)); keepWarn(...a); };
  const plain = r => { r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace; return r; };
  const gpuOf = async (antialias, forceWebGL) => { const r = plain(new TG.WebGPURenderer({ canvas: canvas(), antialias, forceWebGL })); await r.init(); bindUniforms(r, engine.uniforms); return r; };
  const routes = [['webgl', antialias => plain(new THREE.WebGLRenderer({ canvas: canvas(), antialias })), o => new THREE.WebGLRenderTarget(W, H, o)], ['webgl2-backend', aa => gpuOf(aa, true), o => new TG.RenderTarget(W, H, o)]];
  if (real) routes.push(['webgpu', aa => gpuOf(aa, false), o => new TG.RenderTarget(W, H, o)]);
  try {
    for (const [name, make, rt] of routes) for (const aa of [false, true]) {
      const r = await make(aa), key = `${name}${aa ? ' msaa' : ''}`;
      if (name === 'webgpu' && !r.backend.isWebGPUBackend) { out[key] = 'no webgpu here'; r.dispose(); continue; }
      out[key] = { canvas: await softCase(r), target: await softCase(r, rt({})), msaaTarget: await softCase(r, rt({ samples: 4 })), ortho: await softCase(r, rt({}), SOFT_ORTHO) };
      r.dispose();
    }
    const cost = await softCost();
    const eng = { 'WebGL, post off': await softEngine({}), 'WebGL, post on, MSAA': await softEngine({ antialias: true }, true) };
    if (real) { eng['WebGPU, post off'] = await softEngine({ renderer: 'webgpu', fallback: 'error' }); eng['WebGPU, post on, MSAA'] = await softEngine({ renderer: 'webgpu', fallback: 'error', antialias: true }, true); }
    const P = new Particles(HGL);
    return { routes: out, cost, engine: eng, refused: refuse(() => P.define('x', { soft: -1 })), errors: [...new Set(errors)].slice(0, 8), warned: [...new Set(warned)] };
  } finally { console.error = keep; console.warn = keepWarn; }
};

/** Group E (docs/plans/2026-11-09-group-e.md): WebGPU particles keep their size under an orthographic camera, weather is not fogged, the "no texture" stand-in is freed */
window.fxGroupE = async () => {
  const out = {};
  // two equal particles at depth 20 and 30 under an orthographic camera: the same number of lit pixels (WebGL does not shrink them either)
  const ortho = new THREE.OrthographicCamera(-5, 5, 3.75, -3.75, 0.1, 100); ortho.position.set(0, 0, 20); ortho.updateMatrixWorld(); ortho.updateProjectionMatrix();
  const P = new Particles(HGPU), keepCam = HGPU.camera;
  HGPU.camera = ortho;
  P.define('dot', { max: 4, lifetime: [20, 20], speed: 0, spread: 0, gravity: 0, drag: 0, size: 1, color: 0xffffff, opacity: 1 });
  P.emit('dot', [-2, 0, 0], { count: 1 }); P.emit('dot', [2, 0, -10], { count: 1 }); P.update(0.01);
  gpu.setRenderTarget(gpuRT); gpu.setClearColor(0, 1); gpu.render(HGPU.scene, ortho);
  const b = new Uint8Array(await gpu.readRenderTargetPixelsAsync(gpuRT, 0, 0, W, H)); gpu.setRenderTarget(null);
  const lit = [0, 0]; for (let i = 0; i < W * H; i++) if (b[i * 4] > 40) lit[(i % W) < W / 2 ? 0 : 1]++;
  out.ortho = lit; P.clear('dot'); HGPU.camera = keepCam;
  // weather is fogged on both backends: the flags, and the same picture in a fogged scene (rain fades into fog, WebGL as WebGPU)
  out.weatherFog = {};
  for (const [field, base] of [['rain', RAIN], ['snow', SNOW]]) {
    const [sa, sb] = [HGL, HGPU].map(h => seeded(11, () => makeSystem(h, field, {}, { area: 14, count: 600, base })));
    for (const s of [sa, sb]) updateSystem(s, 1, cam, 3.2, 0.6);
    const clear = stats(await shot(HGL)).mean;
    for (const h of [HGL, HGPU]) h.scene.fog = new THREE.Fog(0x2040ff, 2, 14);
    const a = await shot(HGL), b = await shot(HGPU);
    for (const h of [HGL, HGPU]) h.scene.fog = null;
    out.weatherFog[field] = { flags: [sa.object.material.fog, sb.object.material.fog], clear, fogged: stats(a).mean, ...compare(a, b) };
    for (const [h, s] of [[HGL, sa], [HGPU, sb]]) h.remove(s.object);
  }
  // the white stand-in is disposed when a real texture takes its place and with the material; the game's own texture is not touched
  const stand = fx => fx.uniforms.uMap.value;
  const fx = P.define('tex', { max: 2 }), white1 = stand(fx); let freed = 0; white1.addEventListener('dispose', () => freed++);
  const real = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1); let realFreed = 0; real.addEventListener('dispose', () => realFreed++);
  fx.uniforms.uMap.value = real; out.swapped = freed;
  fx.uniforms.uMap.value = null; const white2 = stand(fx); let freed2 = 0; white2.addEventListener('dispose', () => freed2++);
  fx.material.dispose(); out.disposed = [freed2, realFreed, freed];
  // weather rebuilt on a tier change (modules/weather/weatherDraw.js _rebuild): the old snow's white stand-in is freed with its material, so the
  // new system must draw a stand-in of its own, not take the old one for the game's texture; a texture the game gave is carried
  {
    // the drawing half only (no weather table): what _rebuild reads, over the stand-in engine
    const W8 = Object.assign(Object.create(WeatherDraw.prototype), { engine: HGPU, area: 14, particles: 600, systems: new Map() });
    const white = W8._build('snow', {}, SNOW).uniforms.uMap.value;
    W8._rebuild();
    const snow = W8.systems.get('snow');
    out.rebuild = { own: snow.uniforms.uMap.own, carried: snow.uniforms.uMap.value === white };
    const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1); snow.uniforms.uMap.value = tex;
    W8._rebuild(); out.rebuild.given = W8.systems.get('snow').uniforms.uMap.value === tex;
    for (const s of W8.systems.values()) HGPU.remove(s.object);
  }
  // a game vertex shader without the fog chunks, scene fog on: still compiles and draws (the material just is not fogged)
  const errs = [], keep = console.error; console.error = (...a) => { errs.push(String(a[0]).slice(0, 200)); };
  try {
    const vertex = pointVert.split('\n').filter(l => !l.includes('#include <fog_')).join('\n');
    const s = seeded(11, () => makeSystem(HGL, "snow", { glsl: { vertex } }, { area: 14, count: 600, base: SNOW })); updateSystem(s, 1, cam, 3.2, 0.6);
    HGL.scene.fog = new THREE.Fog(0x2040ff, 2, 14);
    const px = await shot(HGL); HGL.scene.fog = null; HGL.remove(s.object);
    out.customVertex = { fog: s.object.material.fog, lit: stats(px).lit, errs };
  } finally { console.error = keep; }
  return out;
};
