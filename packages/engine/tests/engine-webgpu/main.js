// The engine's own content on the WebGPU route (tests/specs/engine-webgpu.mjs): terrain, vegetation (wind), water (waves, foam, fresnel),
// sky, particles and post (bloom in the chain, off) all on, drawn once by a WebGL engine and once by a renderer: 'webgpu' engine, with time and weather held
// still. Why this page: before, the engine's materials were plain three.js materials whose GLSL patches WebGPURenderer never runs, so on
// WebGPU every effect was missing without a word and no test drew engine content there. The comparison is per pixel, so a missing effect
// (no sway, no season tint, flat water) shows even when the mean stays close. Plus fallback: 'webgl' must start and draw with all of it rebuilt.
import * as THREE from 'three';
import 'threedog/tsl';
import { MeshStandardNodeMaterial, MeshToonNodeMaterial } from 'three/webgpu';
import { color as tslColor } from 'three/tsl';
import { createEngine, terrain, vegetation, water, sky, particles, weather, mergeColored, applyEffects } from '../../index.js';
import { bloom } from '@threedog/post-effects';
import { materialPatches, patchMaterial, cloneMaterial } from '../../render/patches.js';

const W = 160, H = 120;

/** One engine with every engine part on; time / weather fixed so both routes draw the same moment */
async function make(extra, { parts = true, more = [], before = null, ground = {}, skyOptions = {} } = {}) {
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false,
    saveKey: 'test-engine-webgpu', ...extra });
  e.plugins.add({ 'bloom.js': { default: bloom({ strength: 0.4, threshold: 0.9 }) } });
  e.use(terrain({ height: (x, z) => Math.sin(x * 0.15) * 1.5 + Math.cos(z * 0.12) * 1.2, viewChunks: 1, ...ground }), vegetation(), water({ sea: true, level: -0.4 }), sky({ time: 0.4, ...skyOptions }), ...(parts ? [particles()] : []), ...more);
  const cone = new THREE.ConeGeometry(0.8, 3, 6).translate(0, 1.5, 0);
  e.vegetation.define('tree', { geometry: mergeColored([[cone, 0x3c7a34]]), wind: 0.08, rule: { perChunk: 60 } });
  // near-only tufts: their distance fade (nearFade patch) is a second position patch after the wind one
  e.vegetation.define('tuft', { geometry: mergeColored([[new THREE.ConeGeometry(0.3, 0.9, 5).translate(0, 0.45, 0), 0xa8b848]]), nearOnly: true, wind: 0.05, rule: { perChunk: 150 } });
  if (parts) e.particles.define('puff', { rate: 0, max: 60, color: [0xffffff, 0xffeeaa], size: [0.6, 0.6], lifetime: [100, 100], speed: [0, 0] });
  before?.(e);
  await e.start();
  e.haltLoop();
  if (parts) e.particles.emit('puff', { x: 0, y: 3, z: 0 }, { count: 40 });
  e.camera.position.set(0, 9, 16); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
  return e;
}

const read = c => { const x = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  x.drawImage(c, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
/** one frame drawn and read in the same task (no preserveDrawingBuffer needed) */
const shot = e => { e.step(1 / 60); return read(e.renderer.domElement); };
/** share of pixels (%) whose largest channel differs by more than tol */
const differ = (a, b, tol = 24) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > tol) n++; return +(100 * n / (W * H)).toFixed(2); };
const mean = a => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return +(s / (W * H * 3)).toFixed(2); };

/** The engine materials in the scene: how many, whether each one's node twin got its patches (WebGPU), and their patch names */
function engineMaterials(e) {
  const out = [];
  e.scene.traverse(o => { for (const m of [o.material].flat()) if (m && materialPatches(m).length && !out.some(x => x.m === m)) out.push({ m, o }); });
  return out.map(({ m, o }) => ({ type: m.type, object: o.name || o.type, patches: materialPatches(m), position: !!m.positionNode }));
}

// the WebGL engine is made at load: the test runner waits for window.engine
const gl = window.engine = await make({});

// terrain({ shading: 'texture' }): the per-chunk color map patch (terrainTexture.js) drawn by both routes
window.textureShading = async () => {
  const opts = { parts: false, ground: { shading: 'texture', colorResolution: 32 } };
  const a = await make({ saveKey: 'test-engine-webgpu-tex' }, opts), b = await make({ renderer: 'webgpu', saveKey: 'test-engine-webgpu-tex' }, opts);
  const A = shot(a), B = shot(b);
  const out = { mean: { gl: mean(A), gpu: mean(B) }, differ: differ(A, B), differFine: differ(A, B, 8),
    patched: engineMaterials(b).some(m => m.patches.includes('terrainColorMap')), errors: [a.error, b.error].filter(Boolean).map(x => String(x.message).slice(0, 300)) };
  a.dispose(); b.dispose();
  return out;
};

window.engineWebGPU = async () => {
  const gpu = await make({ renderer: 'webgpu' });
  const out = { backend: gpu.describe().renderer.backend, errors: [] };
  const a = shot(gl), b = shot(gpu);
  out.mean = { gl: mean(a), gpu: mean(b) };
  out.differ = differ(a, b);
  out.differFine = differ(a, b, 8);
  out.materials = engineMaterials(gpu);
  // each effect really moves on WebGPU: wind 0 -> 3 sways the trees, the foliage / ground tint recolors, waves move with time
  const U = gpu.uniforms, step = (fn, back) => { const before = shot(gpu); fn(); const after = shot(gpu); back(); return differ(before, after, 8); };
  out.sway = step(() => { U.uWind.value = 3; U.uTime.value = 7.3; }, () => { U.uWind.value = 1; U.uTime.value = 0; });
  out.tint = step(() => { U.uFoliageTint.value.set(1.6, 0.6, 0.2); U.uGroundTint.value.set(1.5, 1.2, 0.5); }, () => { U.uFoliageTint.value.set(1, 1, 1); U.uGroundTint.value.set(1, 1, 1); });
  out.errors = [gl.error, gpu.error].filter(Boolean).map(x => String(x.message).slice(0, 300));   // a frozen world (an error in a frame) fails here
  out.swayGL = (() => { const G = gl.uniforms, before = shot(gl); G.uWind.value = 3; G.uTime.value = 7.3; const after = shot(gl); G.uWind.value = 1; G.uTime.value = 0; return differ(before, after, 8); })();
  gpu.dispose();
  return out;
};

/**
 * The three routes added on 2026-11-03 (tests/specs/picture-routes.mjs), on the WebGL engine and on a WebGPU one: the game's own cloud-shadow term
 * (engine.shaderTerms.cloudShadow), its own season tint (engine.shaderTerms.season), a color hook on the plants (engine.vegetation.color).
 * Each reaches materials already built, and removing it gives the engine's back.
 */
window.pictureRoutes = async () => {
  const gpu = await make({ renderer: 'webgpu' }, { parts: false });
  const run = e => {
    const out = {};
    const amp = e.uniforms.uWindAmp;
    amp.value = 0;   // no sway: each frame steps time, so "back to the same picture" needs a still one
    const base = shot(e), now = () => differ(base, shot(e), 8);
    const has = n => engineMaterials(e).filter(m => m.patches.includes(n)).length;
    // (c) cloud shadow: the game's own term in place of the engine's (here a flat darkening), then none at all, then the engine's again
    const hc = e.shaderTerms.cloudShadow({ glsl: 'reflectedLight.directDiffuse *= 0.25;', tsl: c => ({ directDiffuse: c.directDiffuse.mul(0.25) }) });
    out.cloud = { moved: now(), on: has('clouds') };
    hc.remove();
    const ho = e.shaderTerms.cloudShadow(false);
    out.cloudOff = has('clouds');
    ho.remove();
    out.cloudBack = { on: has('clouds'), moved: now() };
    // (c) season tint: kind => spec, ground red and foliage blue, reading the signals still bound (uGroundCover)
    const hs = e.shaderTerms.season(kind => ({ glsl: `diffuseColor.rgb = mix(vec3(${kind === 'ground' ? '1.0, 0.0, 0.0' : '0.0, 0.0, 1.0'}), vec3(1.0), uGroundCover.y);`,
      tsl: c => c.tsl.vec4(kind === 'ground' ? c.tsl.vec3(1, 0, 0) : c.tsl.vec3(0, 0, 1), c.color.a) }));
    out.season = { moved: now(), on: has('season') };
    hs.remove();
    out.seasonBack = now();
    // (b) vegetation color hook, live on the planted trees
    e.vegetation.color({ glsl: 'diffuseColor.rgb = vec3(1.0, 0.0, 1.0);', tsl: c => c.tsl.vec4(1, 0, 1, c.color.a) });
    out.veg = { moved: now(), on: has('vegetationColor') };
    e.vegetation.color(null);
    out.vegBack = { moved: now(), on: has('vegetationColor') };
    // the form this renderer needs, when missing, is named instead of drawing nothing
    const gpuSide = !!e.renderer.isWebGPURenderer, half = gpuSide ? { glsl: 'diffuseColor.rgb *= 0.5;' } : { tsl: c => c.color };
    const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
    const sway = { glsl: 'void threedogWind(inout vec3 t, vec3 ip, vec3 p){ t.x += 0.5 * max(p.y, 0.0) * THREEDOG_WIND_AMP; }', tsl: c => c.position.add(c.tsl.vec3(c.tsl.positionGeometry.y.mul(0.1), 0, 0)) };
    const swayHalf = gpuSide ? { glsl: sway.glsl } : { tsl: sway.tsl };
    out.named = [err(() => e.shaderTerms.cloudShadow(half)), err(() => e.shaderTerms.season(half)), err(() => e.vegetation.color(half)),
      err(() => applyEffects(new THREE.MeshStandardMaterial(), { engine: e, wind: { amplitude: 0.1, ...swayHalf } }))];
    // wind: the signal reaches plants already planted, and a species' own sway rides on its wind option
    amp.value = 60; out.wind = { moved: now() };
    amp.value = 0; out.wind.back = now();
    const blade = () => mergeColored([[new THREE.ConeGeometry(0.2, 1, 3).translate(0, 0.5, 0), 0xa8b848]]);
    e.vegetation.define('plainSway', { geometry: blade(), wind: 0.07, rule: { perChunk: 1 } });
    e.vegetation.define('ownSway', { geometry: blade(), wind: { amplitude: 0.07, ...sway }, rule: { perChunk: 1 } });
    shot(e);
    const key = n => { const m = [e.vegetationDraw.kind(n)?.material].flat()[0]; return m?.customProgramCacheKey?.() ?? ''; };
    out.wind.plain = key('plainSway'); out.wind.own = key('ownSway');
    amp.value = 1;
    return out;
  };
  const out = { gl: run(gl), gpu: run(gpu) };
  gpu.dispose();
  return out;
};

// a cloud function with both forms and a marker number in its GLSL: after the swap the WebGL dome must still carry it
const CLOUDS = { glsl: 'vec4 threedogClouds(vec3 d, float t, vec3 s, float n, vec3 lit, vec3 shade, float c){ return vec4(lit, 0.4321 * c * step(0.0, d.y)); }',
  tsl: ({ dir, lit, cover, tsl }) => tsl.vec4(lit, cover.mul(0.4321).mul(tsl.step(0, dir.y))) };

/**
 * fallback 'webgl': everything built before start() for the WebGPURenderer start() then replaced is built again for WebGL: post (bloom),
 * the sky dome with a engine.sky.clouds() made before start, the game's FogExp2, cascaded shadows
 * (CSMShadowNode -> extra lights), particles and rain / snow. start() must not crash and the picture is drawn.
 */
window.fallbackWebGL = async () => {
  const keep = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  try {
    // low: { cascades }: the page's software GPU is low tier from the start (render/backend.js tierBeforeRenderer), which keeps one shadow map
    const e = await make({ renderer: 'webgpu', fallback: 'webgl' }, { more: [weather({ types: { wet: { rain: 1 }, white: { snow: 1 } } })], skyOptions: { clouds: { coverage: 1 } },
      before: g => { g.shadows.cascades(g.lights.sun, { count: 3, low: { count: 3 } }); g.sky.clouds(CLOUDS); g.scene.fog = new THREE.FogExp2(0xcccccc, 0.01); } });
    e.weather.set('wet', { seconds: 0.01 }); e.step(0.1);
    const px = shot(e), d = e.describe().renderer;
    const nodeMats = [];
    e.scene.traverse(o => { for (const m of [o.material].flat()) if (m?.isNodeMaterial) nodeMats.push(`${o.type} ${o.name}`); });
    const fx = e.particles.effects.get('puff');
    const r = { backend: d.backend, isWebGL: !!e.renderer.isWebGLRenderer, dome: e.sky.dome.material.type, domeNode: !!e.sky.dome.material.isNodeMaterial, mean: mean(px), post: e.post.active,
      cloudHook: e.sky.dome.material.fragmentShader?.includes('0.4321') ?? false, nodeMats,
      particles: fx.points.type + ' ' + fx.material.type, rain: e.weatherDraw.systems.get('rain')?.object.material.type, snow: e.weatherDraw.systems.get('snow')?.object.material.type,
      rainShown: e.weatherDraw.systems.get('rain')?.object.visible, csm: e.shadows.csm ? (e.shadows.csm.isCascadeNode ? 'node' : 'lights') : null };
    e.dispose();
    return r;
  } catch (err) { return { error: String(err?.stack ?? err) }; }
  finally { if (keep) Object.defineProperty(navigator, 'gpu', keep); else delete navigator.gpu; }
};

/**
 * Two patch meanings that once differed between the routes, each drawn by a WebGL and a WebGPU engine:
 * position: an offset in object space on turned instances (GLSL adds it before instanceMatrix; WebGPU used to add it after, so it pointed
 * the wrong way); lighting order: 'dim' (after: scales direct light) then 'glow' (direct: adds light). On WebGL glow comes after dim and is
 * not dimmed; WebGPU's direct hooks used to add inside three's light loop, so dim scaled them too.
 */
window.patchMeanings = async () => {
  const draw = async extra => {
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false,
      saveKey: 'test-engine-webgpu-meanings', ...extra });
    await e.start(); e.haltLoop();
    const lit = applyEffects(new THREE.MeshLambertMaterial({ color: 0x808080 }), { clouds: false, patches: [
      { name: 'dim', slot: 'lighting', glsl: 'reflectedLight.directDiffuse *= 0.2;', tsl: { after: c => ({ directDiffuse: c.directDiffuse.mul(0.2) }) } },
      { name: 'glow', slot: 'lighting', glsl: '#if NUM_DIR_LIGHTS > 0\n  reflectedLight.directDiffuse += vec3(0.0, 0.0, 0.4);\n#endif',
        tsl: { direct: (L, c) => { if (L.directional) c.directDiffuse.addAssign(c.tsl.vec3(0, 0, 0.4)); } } },
    ] });
    e.add(new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), lit));
    const moved = applyEffects(new THREE.MeshBasicMaterial({ color: 0xff3020 }), { clouds: false, patches: [
      { name: 'push', slot: 'position', glsl: 'transformed.x += 2.0;', tsl: c => c.position.add(c.tsl.vec3(2, 0, 0)) },
    ] });
    const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), moved, 3), m = new THREE.Matrix4();
    for (let i = 0; i < 3; i++) boxes.setMatrixAt(i, m.makeRotationY(Math.PI / 2 * (i + 1)).setPosition(-4 + 4 * i, 1, 0));
    e.add(boxes);
    e.camera.position.set(0, 10, 9); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
    const px = shot(e);
    e.dispose();
    return px;
  };
  const a = await draw({}), b = await draw({ renderer: 'webgpu' });
  return { differ: differ(a, b), differFine: differ(a, b, 8), mean: { gl: mean(a), gpu: mean(b) } };
};

// Plugins composed on both routes (tests/specs/plugin-composition.mjs): two post plugins with no order of their own whose result depends on
// their order (halve, then lift), each switched off and on. The chain order and the picture must come back exactly
window.pluginOrderRoutes = async () => {
  const gpu = await make({ renderer: 'webgpu', saveKey: 'test-engine-webgpu-plugins' }, { parts: false });
  const fx = (name, glsl, tsl) => ({ name, slot: 'ldr', fuse: { glsl, tsl: (c, uv, { tsl: T }) => T.vec4(tsl(c.rgb), c.a) } });
  const run = e => {
    const amp = e.uniforms.uWindAmp, hold = e.freeze('plugin-order', { still: true });
    e.post.get('bloom').enabled = false;   // the two plugins' order is what is compared here
    amp.value = 0;
    e.plugins.add({ './plugins/60-half.js': { default: fx('half', 'color.rgb *= 0.5;', c => c.mul(0.5)) },
      './plugins/61-lift.js': { default: fx('lift', 'color.rgb += 0.2;', c => c.add(0.2)) } });
    shot(e);
    const base = shot(e), order = () => e.post.list().map(x => x.name).filter(n => n === 'half' || n === 'lift').join(), o0 = order(), out = { order: o0, still: differ(base, shot(e), 1) };   // still: what two frames with no change differ by (the WebGL engine here has live particles)
    for (const n of ['60-half', '61-lift']) {
      e.plugins.off(n); shot(e); const off = shot(e); e.plugins.on(n); shot(e); const on = shot(e);
      out[n] = { changed: differ(base, off, 4), back: differ(base, on, 1), order: order() === o0 };
    }
    e.plugins.off('60-half'); e.plugins.off('61-lift'); amp.value = 1; e.post.get('bloom').enabled = true; hold.remove();
    return out;
  };
  const out = { gl: run(gl), gpu: run(gpu) };
  gpu.dispose();
  return out;
};

/**
 * Program sharing on WebGPU: N materials with the same lighting and detail options through applyEffects, so each is its
 * own material object. three builds a node program per distinct key, and the key holds the identity of each patch uniform object
 * (threedogNodeKey, render/patches.js), so the engine must hand same-spec materials the same patch objects. Counts the node builds three
 * creates for those materials (renderer.debug.onNodeBuilderCreated) while one frame draws them.
 */
/** assets.texture() before start() on the WebGPU route: a game loads in any order it likes, so the load must work and the texture must still reach the picture */
window.textureBeforeStart = async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false, lights: false,
    saveKey: 'test-engine-webgpu-tex', renderer: 'webgpu' });
  const c = Object.assign(document.createElement('canvas'), { width: 4, height: 4 }), x = c.getContext('2d');
  x.fillStyle = '#f00'; x.fillRect(0, 0, 4, 4);
  try {
    const t = await e.assets.texture(c.toDataURL('image/png'));
    await e.start(); e.haltLoop();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
    e.add(m); e.camera.position.set(0, 0, 5); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
    e.step(0.1);
    const px = shot(e);
    let red = 0; for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 60) red++;
    return { backend: e.describe().renderer.backend, red: red / (px.length / 4) };
  } catch (err) { return { error: String(err.message) }; } finally { e.dispose?.(); }
};

window.programSharing = async () => {
  const N = 8;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false,
    saveKey: 'test-engine-webgpu-share', renderer: 'webgpu' });
  await e.start(); e.haltLoop();
  const mats = new Set(), g = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < N; i++) {
    const m = applyEffects(new THREE.MeshLambertMaterial({ color: 0x808080 + i * 0x101010 }),
      { clouds: false, lighting: { wrap: 0.4, shadowTint: { color: 0x4455aa }, rim: { color: 0xffffff } }, detail: { noise: 'paper' }, engine: e });
    mats.add(m);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(i * 1.5 - 5, 0.5, 0); e.add(mesh);
  }
  e.camera.position.set(0, 4, 9); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
  let builds = 0;
  const d = e.renderer.debug, prev = d.onNodeBuilderCreated;
  d.onNodeBuilderCreated = (b, ro) => { if (mats.has(ro?.material)) builds++; prev?.(b, ro); };
  try { shot(e); } finally { d.onNodeBuilderCreated = prev; }
  const keys = new Set([...mats].map(m => m.threedogNodeKey));
  const out = { materials: N, builds, nodeKeys: keys.size, colors: new Set([...mats].map(m => m.color.getHex())).size };
  e.dispose();
  return out;
};

/**
 * Patches that differ only in their tsl (tests/specs/tsl-identity.mjs): the program key must follow the code that runs. Two same-named
 * patches with no GLSL, a term swapped for one with other tsl, and the other way round: materials of one built-in setup keep sharing.
 */
window.tslIdentity = async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false,
    saveKey: 'test-engine-webgpu-tsl', renderer: 'webgpu' });
  await e.start(); e.haltLoop();
  e.camera.position.set(0, 0, 5); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();
  const at = (px, x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const plane = (m, x) => { const o = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m); o.position.x = x; e.add(o); return o; };
  const tint = rgb => ({ name: 'tint', slot: 'color', tsl: c => c.tsl.vec4(...rgb, 1) });
  const pair = [[1, 0, 0], [0, 0, 1]].map((rgb, i) => plane(patchMaterial(new THREE.MeshBasicMaterial(), [tint(rgb)]), i ? 1.2 : -1.2));
  const px = shot(e);
  const out = { left: at(px, W / 2 - 24, H / 2), right: at(px, W / 2 + 24, H / 2), keys: new Set(pair.map(o => o.material.threedogNodeKey)).size };
  for (const o of pair) e.remove(o);

  // a term swapped on a live material: same GLSL (none), same name, other tsl
  const lit = plane(applyEffects(new THREE.MeshLambertMaterial({ color: 0xffffff }), { engine: e }), 0);
  const term = k => e.shaderTerms.cloudShadow({ tsl: c => ({ directDiffuse: c.directDiffuse.mul(k) }) });
  const mid = () => at(shot(e), W / 2, H / 2)[0];
  const builtIn = mid();
  const a = term(0), dark = mid();
  a.remove();
  const b = term(1), light = mid();
  b.remove();
  Object.assign(out, { builtIn, dark, light });
  e.remove(lit);

  // the built-in effects, each called once per material: one setup must stay one program
  const N = 6, mats = new Set();
  for (let i = 0; i < N; i++) {
    const m = applyEffects(new THREE.MeshLambertMaterial({ color: 0x808080 }), { wind: 0.2, season: 'foliage', engine: e });
    mats.add(m); plane(m, i * 0.4 - 1);
  }
  let builds = 0;
  const d = e.renderer.debug, prev = d.onNodeBuilderCreated;
  d.onNodeBuilderCreated = (bd, ro) => { if (mats.has(ro?.material)) builds++; prev?.(bd, ro); };
  try { shot(e); } finally { d.onNodeBuilderCreated = prev; }
  Object.assign(out, { materials: N, builds, sharedKeys: new Set([...mats].map(m => m.threedogNodeKey)).size });
  let events = 0;
  e.events.on('page:contextlost', () => { events++; });
  const logged = console.error;   // three's own hook logs an error, which this page would count as a failure
  console.error = () => {};
  for (let i = 0; i < 2; i++) e.renderer.onDeviceLost({ api: 'WebGPU', message: 'test', reason: null });
  console.error = logged;
  // a halted engine has no real-time loop to hold, so the 'page' freeze comes up when the loop restarts (core/engine/page.js): read it on both sides of that
  const lostWhileHalted = { frozen: e.frozen, lost: e.page.contextLost };
  e._unhalt();
  out.lost = { halted: lostWhileHalted, held: e.stacks.get('freeze').has('page'), events, three: e.renderer._isDeviceLost === true };
  e.dispose();

  // WebGL reads customProgramCacheKey only: patches with the same GLSL and other tsl stay one program there
  const same = k => patchMaterial(new THREE.MeshBasicMaterial(), [{ name: 'tintBoth', slot: 'color', glsl: 'diffuseColor.r = 1.0;', tsl: c => c.color.mul(k) }]);
  out.webglKeys = new Set([same(1), same(2)].map(m => m.customProgramCacheKey())).size;
  return out;
};

/**
 * Two small spots where the routes once disagreed (2026-11 notes: 9-15% and ~6% of pixels): half-transparent meshes in fog in front of an
 * opaque one, and an sRGB texture as scene.background. Each drawn by a WebGL engine and a WebGPU one without modules or post, compared per pixel.
 */
window.colorSpots = async () => {
  const bg = (() => {   // an sRGB gradient through mid tones: a missing or doubled sRGB decode shows most there
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 64, 64); g.addColorStop(0, '#203060'); g.addColorStop(0.5, '#c08040'); g.addColorStop(1, '#80c0a0');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const scene = async (renderer, kind, tone = true) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const e = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false,
      saveKey: 'test-engine-webgpu-spots', ...(renderer && { renderer }) });
    await e.start(); e.haltLoop();
    e.renderer.toneMapping = tone ? THREE.AgXToneMapping : THREE.NoToneMapping;
    if (kind === 'fog') {
      e.scene.background = new THREE.Color(0x8fa8c0);
      e.scene.fog = new THREE.Fog(0x8fa8c0, 4, 30);
      e.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(3, 6, 4); e.scene.add(sun);
      for (const [z, op, col] of [[-14, 1, 0xd04020], [-8, 0.5, 0x2060e0], [-3, 0.35, 0x30c060]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 0.5), new THREE.MeshStandardMaterial({ color: col, transparent: op < 1, opacity: op, roughness: 0.8 }));
        m.position.set(z * 0.15, 1.5, z); e.scene.add(m);
      }
    } else e.scene.background = bg;
    e.camera.position.set(0, 2, 6); e.camera.lookAt(0, 1.5, -10); e.camera.updateMatrixWorld();
    return e;
  };
  const out = {};
  // background twice: with the engine's tone mapping and without. Why: plain WebGLRenderer leaves an sRGB background out of tone mapping
  // (WebGLBackground: toneMapped = false for sRGB transfer), WebGPURenderer tone-maps the whole frame once at output, background included;
  // the engine's WebGL straight path tone-maps it too (render/postWebGL.js toneBackground), so all three agree with tone mapping on
  for (const [kind, tone] of [['fog', true], ['background', true], ['backgroundFlat', false]]) {
    const a = await scene(null, kind.replace('Flat', ''), tone), b = await scene('webgpu', kind.replace('Flat', ''), tone);
    const pa = shot(a), pb = shot(b);
    out[kind] = { differ: differ(pa, pb), differFine: differ(pa, pb, 8), mean: { gl: mean(pa), gpu: mean(pb) }, px: { gl: [...pa.slice(0, 4)], gpu: [...pb.slice(0, 4)] } };
    if (kind === 'fog') {
      // WebGL straight to the canvas tone-maps and encodes each material, then fogs and blends in display values; WebGPU, and WebGL through a
      // composer, fog and blend in linear and tone-map once. So the like-for-like pair is composer against WebGPU, and it must match
      const h = a.post.add({ name: 'through', slot: 'ldr', fuse: { glsl: '', tsl: c => c } }), pc = shot(a);
      out.fogLinear = { composer: a.post.active, differ: differ(pc, pb, 2), mean: { gl: mean(pc), gpu: mean(pb) } };
      h.remove();
    }
    if (kind === 'background') {
      // WebGL's two paths: straight to the canvas, then through the composer (a pass-through effect on), then straight again
      const direct = { active: a.post.active, px: pa };
      const h = a.post.add({ name: 'through', slot: 'ldr', fuse: { glsl: '', tsl: c => c } }), pc = shot(a), composer = a.post.active;
      h.remove(); const again = shot(a);
      out.backgroundComposer = { direct: direct.active, composer, differ: differ(pa, pc), differFine: differ(pa, pc, 8), back: differ(pa, again, 2), mean: { direct: mean(pa), composer: mean(pc) } };
    }
    a.dispose(); b.dispose();
  }
  return out;
};

/**
 * A game's own material and the cloud shadow (tests/specs/plain-three-adoption.mjs): the engine adds nothing unasked, whatever uCloudShadow says, and a
 * MeshStandardMaterial passed to applyEffects darkens under the clouds on both renderers, the sun only, one program per material type.
 */
window.plainClouds = async () => {
  const gpu = await make({ renderer: 'webgpu' }, { parts: false });
  const run = e => {
    const U = e.uniforms, g = new THREE.BoxGeometry(40, 0.2, 40);
    // a wide slab over the ground (the camera at (0, 9, 16) looks down at its sunlit top): the center of the view reads only the slab
    const center = px => { let s = 0, n = 0; for (let y = 45; y < 75; y++) for (let x = 65; x < 95; x++) { const i = (y * W + x) * 4; s += px[i] + px[i + 1] + px[i + 2]; n++; } return s / (n * 3); };
    const dim = box => {
      e.scene.add(box); box.position.set(0, 2.5, 0); box.updateMatrixWorld();
      // full cover and small clouds (scale 0.5: many cells inside the region, so the noise near the world origin, about 0, cannot hide them)
      U.uWeatherCloud.value = 1;
      const lit = dim.lit = center(shot(e)), was = [U.uCloudShadow.value, U.uCloudShadowScale.value];
      U.uCloudShadow.value = 0.9; U.uCloudShadowScale.value = 0.5;
      const shade = center(shot(e));
      [U.uCloudShadow.value, U.uCloudShadowScale.value] = was; box.removeFromParent();
      return +(100 * (1 - shade / Math.max(lit, 1e-3))).toFixed(1);   // % darker under the clouds
    };
    const stand = () => new THREE.MeshStandardMaterial({ color: 0xd0c8b0, roughness: 0.9 });
    // unasked: the signal is on and the material is in the scene, and it compiles exactly what the game wrote
    const left = stand(), plain = applyEffects(stand(), { engine: e });
    const out = { leftDim: dim(new THREE.Mesh(g, left)), leftPatches: materialPatches(left), plain: dim(new THREE.Mesh(g, plain)), patches: materialPatches(plain) };
    // the shadow going 0 -> 0.9 builds no program: the off state is a branch on the uniform, not a different shader
    {
      const box = new THREE.Mesh(g, plain), dbg = e.renderer.debug, prev = dbg?.onNodeBuilderCreated, gpuSide = !!e.renderer.isWebGPURenderer;
      let builds = 0;
      e.scene.add(box); box.position.set(0, 2.5, 0); shot(e);
      const before = gpuSide ? 0 : e.renderer.info.programs.length;
      if (gpuSide) dbg.onNodeBuilderCreated = (b, ro) => { if (ro?.material === plain) builds++; prev?.(b, ro); };
      U.uCloudShadow.value = 0.9;
      try { shot(e); U.uCloudShadow.value = 0; shot(e); } finally { if (gpuSide) dbg.onNodeBuilderCreated = prev; }
      out.newPrograms = gpuSide ? builds : e.renderer.info.programs.length - before;
      box.removeFromParent();
    }
    // a lamp, not the sun: with the sun and sky light off, a PointLight over the slab lights it and the clouds leave it alone
    const { sun, hemi } = e.lights, lit = [sun.intensity, hemi.intensity];
    sun.intensity = hemi.intensity = 0;
    const lamp = new THREE.PointLight(0xffffff, 300, 0, 2); lamp.position.set(0, 6, 0); e.scene.add(lamp);
    out.lamp = dim(new THREE.Mesh(g, plain)); out.lampLit = +dim.lit.toFixed(1);
    lamp.removeFromParent(); [sun.intensity, hemi.intensity] = lit;
    // a NodeMaterial (WebGPU) too: left alone until the game asks
    if (e.renderer.isWebGPURenderer) {
      const nm = new MeshStandardNodeMaterial({ name: 'myNodeMat' }), nmesh = new THREE.Mesh(g, nm);
      e.scene.add(nmesh); U.uCloudShadow.value = 0.9; e.step(1 / 60); U.uCloudShadow.value = 0;
      out.node = { left: materialPatches(nm).length, asked: materialPatches(applyEffects(nm, { engine: e })) };
      nmesh.removeFromParent();
    }
    // six plain materials of one type: one program (the patch objects are shared, the cache key is the same)
    const mats = [], meshes = [];
    for (let i = 0; i < 6; i++) { const m = applyEffects(new THREE.MeshStandardMaterial({ color: 0x406080 + i * 0x101010 }), { engine: e }); mats.push(m); const o = new THREE.Mesh(g, m); o.position.set(i * 7 - 18, 3, -20); e.scene.add(o); meshes.push(o); }
    let builds = 0;
    const d = e.renderer.debug, prev = d?.onNodeBuilderCreated, gpuSide = !!e.renderer.isWebGPURenderer;
    if (gpuSide) d.onNodeBuilderCreated = (b, ro) => { if (mats.includes(ro?.material)) builds++; prev?.(b, ro); };
    try { shot(e); } finally { if (gpuSide) d.onNodeBuilderCreated = prev; }
    out.share = gpuSide ? { builds, keys: new Set(mats.map(m => m.threedogNodeKey)).size } : { keys: new Set(mats.map(m => m.customProgramCacheKey())).size };
    for (const o of meshes) o.removeFromParent();
    return out;
  };
  const out = { gl: run(gl), gpu: run(gpu) };
  gpu.dispose();
  return out;
};

// Vegetation draws a model with the material the game made (tests/specs/engine-webgpu.mjs). Its copy of each mesh's material once kept only what
// three's copy() knows: a NodeMaterial's own setupLightingModel (the cel.tsl.js route), a field its class never declares and a classic material's
// own onBeforeCompile were dropped, so every tree drew with three's plain lighting. Also: the game's onModel runs on a model named in define
window.vegetationGameMaterial = async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const e = createEngine({ canvas, pixelRatio: 1, ui: { loading: false }, urlState: false, saveKey: 'test-vegetation-game-material' });
  e.use(vegetation({ area: { min: [-10, -10], max: [10, 10] } }));
  const lighting = () => ({ game: 'soft', start() {}, direct() {} });   // the game's own lighting model, as celLighting is
  const paint = tslColor(0xff00ff), hook = () => {};
  const leaf = new MeshToonNodeMaterial(); leaf.colorNode = paint; leaf.setupLightingModel = lighting; leaf.look = { rim: 0.2 };
  // bark: the game's hook on a material the game already gave the engine's effects (its onBeforeCompile is then the engine's wrapper)
  const bark = new THREE.MeshLambertMaterial(); bark.onBeforeCompile = hook; applyEffects(bark, { engine: e });
  const tree = new THREE.Group(); tree.add(new THREE.Mesh(new THREE.BoxGeometry(), bark), new THREE.Mesh(new THREE.ConeGeometry(), leaf));
  e.vegetation.define('own', { model: tree, wind: 0.05, positions: [[0, 0]] });
  const [b, l] = e.vegetationDraw.kind('own').material;
  // a model named in define: the game's onModel swaps its material before vegetation copies the meshes
  const swapped = new MeshToonNodeMaterial(); swapped.setupLightingModel = lighting;
  e.assets.onModel(m => m.traverse(o => { if (o.isMesh) o.material = swapped; }));
  e.assets.manifest({ models: { bushy: () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.ConeGeometry(), new THREE.MeshLambertMaterial())); return g; } } });
  await e.vegetation.define('named', { model: 'bushy', positions: [[2, 2]] });
  const n = e.vegetationDraw.kind('named').material[0];
  // colors on one mesh only: the merged species geometry drops them, and says so
  const painted = new THREE.BoxGeometry();
  painted.setAttribute('color', new THREE.Float32BufferAttribute(new Array(painted.attributes.position.count * 3).fill(1), 3));
  const mixed = new THREE.Group(); mixed.add(new THREE.Mesh(painted, new THREE.MeshLambertMaterial({ vertexColors: true })), new THREE.Mesh(new THREE.ConeGeometry(), new THREE.MeshLambertMaterial()));
  const quiet = !e.describe().warnings.list.some(w => w.code === 'vegetation-ignored');
  e.vegetation.define('mixed', { model: mixed, positions: [[4, 4]] });
  const out = { notice: quiet && e.describe().warnings.list.some(w => w.code === 'vegetation-ignored' && /mixed.*color/.test(w.text)), copied: l !== leaf && b !== bark, colorNode: l.colorNode === paint, lighting: l.setupLightingModel({})?.game === 'soft', look: l.look?.rim === 0.2,
    patches: materialPatches(l).join(','), hook: b.onBeforeCompile[Symbol.for('threedog.patchWrapper')]?.() === hook,
    named: !!n.isMeshToonNodeMaterial && n.setupLightingModel({})?.game === 'soft' };
  // a copy of a copy: the engine's wrappers are unwrapped to the game's part each time, so nothing nests and every patch is there once
  const wrapped = Symbol.for('threedog.patchWrapper'), inner = f => f?.[wrapped] ? f[wrapped]() : f, l2 = cloneMaterial(l), b2 = cloneMaterial(b);
  out.twice = inner(l2.setupLightingModel) === lighting && materialPatches(l2).join(',') === out.patches && inner(b2.onBeforeCompile) === hook && materialPatches(b2).join(',') === materialPatches(b).join(',');
  e.dispose();
  return out;
};
