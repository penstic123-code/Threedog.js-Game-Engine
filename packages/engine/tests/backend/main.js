// Renderer backend page (tests/specs/backend.mjs): createEngine({ renderer: 'webgpu' }) and a game's own WebGPURenderer, the three fallbacks with
// WebGPU taken away (navigator.gpu missing, requestDevice failing), the loud line and describe().renderer, and a small WebGPU-route scene
// (ground + swaying trees through the engine's own patches) that must draw and sway. Why stub navigator.gpu: headless browsers differ in
// whether they offer WebGPU at all, and the fallback paths must be tested the same way on every machine.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';   // what a WebGPU game imports first: it brings three/webgpu for renderer: 'webgpu'
import { createEngine, applyEffects, world, terrain, hlod } from '../../index.js';
import { renderOnce, stats, whyNoWebGPU } from '../../render/backend.js';
import { watchGeometries } from '../../core/inspect/geometryWatch.js';

const W = 160, H = 120;
const base = { lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, urlState: false };
// the default engine (WebGL): describe / perf / tier stay what they were before the WebGPU entry
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), ...base, saveKey: 'test-backend' });
await engine.start();
engine.haltLoop();

const canvas = () => { const c = Object.assign(document.createElement('canvas'), { width: W, height: H }); c.style.cssText = `width:${W}px;height:${H}px`; document.body.appendChild(c); return c; };
let n = 0;
const make = opts => createEngine({ canvas: canvas(), ...base, saveKey: `test-backend-${++n}`, ...opts });

/** Run fn with navigator.gpu replaced (undefined = missing), collecting console.warn lines */
async function withGpu(gpu, fn) {
  const warns = [], warn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
  Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
  try { return { ...(await fn()), warns: warns.filter(w => w.startsWith('[threedog]') || /WebGPU/.test(w)) }; }
  finally { delete navigator.gpu; console.warn = warn; }
}
const failingDevice = { requestAdapter: async () => ({ features: new Set(), limits: {}, requestDevice: async () => { throw new Error('test: no device'); } }) };
const message = async p => { try { await p; return ''; } catch (e) { return String(e?.message ?? e).split('\n')[0]; } };
const trees = (node) => {
  const mat = node ? new TG.MeshLambertNodeMaterial({ color: 0x9ad070 }) : new THREE.MeshLambertMaterial({ color: 0x9ad070 });
  return new THREE.Mesh(new THREE.BoxGeometry(0.6, 3, 0.6, 1, 10, 1).translate(0, 1.5, 0), mat);
};

/** Pixels of one render of e's scene into a target (WebGPU: async read-back) */
async function shot(e, cam) {
  const r = e.renderer;
  if (r.isWebGPURenderer) {
    const rt = new TG.RenderTarget(W, H); r.setClearColor(0x000000, 1); renderOnce(r, e.scene, cam, rt);
    const b = new Uint8Array(await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H)); rt.dispose(); return b;
  }
  const rt = new THREE.WebGLRenderTarget(W, H); renderOnce(r, e.scene, cam, rt);
  const b = new Uint8Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, b); rt.dispose(); return b;
}
const mean = a => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return +(s / (W * H * 3)).toFixed(2); };
const changed = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) d++; return +(100 * d / (W * H)).toFixed(2); };

// The startup probe: a yes costs one device per page, and a stand-in that fails or a missing navigator.gpu still gets its own answer
window.probeCases = async () => {
  let devices = 0, adapters = 0;
  const gpu = { requestAdapter: async () => { adapters++; return { requestDevice: async () => { devices++; return { destroy() {} }; } }; } };
  const first = await withGpu(gpu, () => whyNoWebGPU().then(why => ({ why })));
  const again = await withGpu(gpu, () => whyNoWebGPU().then(why => ({ why })));
  const failing = await withGpu(failingDevice, () => whyNoWebGPU().then(why => ({ why })));
  const none = await withGpu({ requestAdapter: async () => null }, () => whyNoWebGPU().then(why => ({ why })));
  const missing = await withGpu(undefined, () => whyNoWebGPU().then(why => ({ why })));
  return { first: first.why, again: again.why, failing: failing.why, none: none.why, missing: missing.why, devices, adapters };
};

// A KTX2 asset asked for before start() on WebGPU: the decoder's setup needs the renderer's init, which the engine waits for itself
window.ktxBeforeStart = async () => {
  const e = make({ renderer: 'webgpu' });
  const t = await e.assets.texture(new URL('../fixtures/tex-bc1.ktx2', import.meta.url).href).catch(err => err);
  await e.start();
  const out = { compressed: !!t.isCompressedTexture, error: t instanceof Error ? t.message : null, backend: e.describe().renderer.backend };
  e.dispose();
  return out;
};
window.backendCases = async () => {
  const out = {};
  out.webglDefault = { renderer: engine.describe().renderer, isWebGL: !!engine.renderer.isWebGLRenderer, perf: Object.keys(engine.describe().perf), tier: engine.tier,
    stats: stats(engine.renderer), counts: Object.keys(engine.counts()) };

  // fallback 'webgl2' (default), navigator.gpu missing: same WebGPURenderer, WebGL2 backend
  out.webgl2 = await withGpu(undefined, async () => {
    const e = make({ renderer: 'webgpu' }); await e.start();
    const r = { renderer: e.describe().renderer, text: e.describeText(), isGPU: !!e.renderer.isWebGPURenderer, drawCalls: typeof stats(e.renderer).drawCalls };
    e.dispose(); return r;
  });
  // fallback 'webgl', requestDevice failing: a WebGLRenderer on the same canvas
  out.webgl = await withGpu(failingDevice, async () => {
    const c = canvas(), e = createEngine({ canvas: c, ...base, saveKey: 'test-backend-gl', renderer: 'webgpu', fallback: 'webgl' }); await e.start();
    const r = { renderer: e.describe().renderer, isWebGL: !!e.renderer.isWebGLRenderer, sameCanvas: e.renderer.domElement === c };
    e.dispose(); return r;
  });
  // fallback 'webgl' with a NodeMaterial in the scene: start() fails naming fallback 'webgl2'
  out.webglNode = await withGpu(undefined, async () => {
    const e = make({ renderer: 'webgpu', fallback: 'webgl' }); e.scene.add(trees(true));
    const r = { error: await message(e.start()) }; e.dispose(); return r;
  });
  // fallback 'error': start() rejects
  out.error = await withGpu(failingDevice, async () => {
    const e = make({ renderer: 'webgpu', fallback: 'error' });
    const r = { error: await message(e.start()) }; e.dispose(); return r;
  });
  // a game's own WebGPURenderer asking for WebGL2 itself: not a fallback, no loud line
  out.own = await withGpu(undefined, async () => {
    const r0 = new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true /* kept */ });
    const e = make({ renderer: r0 }); await e.start();
    const r = { renderer: e.describe().renderer, same: e.renderer === r0, initialized: r0.initialized }; e.dispose(); return r;
  });
  // WebGL-only material on the WebGPU route: start() names it
  const sm = make({ renderer: 'webgpu' }), bad = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ name: 'myGlow' })); bad.name = 'glow';
  sm.scene.add(bad);
  out.shaderMaterial = { error: await message(sm.start()) }; sm.dispose();
  // a game's onBeforeCompile (WebGPURenderer never runs it): named at start(), also when it sits under the engine's patch wrapper;
  // an engine-patched material with no hook of the game's (applyEffects wind: GLSL patches under the wrapper) is not
  const hookStart = async (mat, name) => { const e = make({ renderer: 'webgpu' }), m = new THREE.Mesh(new THREE.BoxGeometry(), mat); m.name = name; e.scene.add(m);
    const err = await message(e.start()); e.dispose(); return err; };
  const bend = new THREE.MeshStandardMaterial({ name: 'myBend' }); bend.onBeforeCompile = s => { s.vertexShader = '// bend\n' + s.vertexShader; };
  const patchedOnly = applyEffects(new THREE.MeshLambertMaterial({ name: 'enginePatched' }), { clouds: false, wind: 0.3 });
  const patchedThenHook = applyEffects(new THREE.MeshLambertMaterial({ name: 'patchedThenHook' }), { clouds: false, wind: 0.3 });
  patchedThenHook.onBeforeCompile = () => {};
  out.hook = { game: await hookStart(bend, 'bent'), engine: await hookStart(patchedOnly, 'swaying'), under: await hookStart(patchedThenHook, 'both') };
  // a ShaderMaterial added after start(): named on the next frame through the scene-entry visitor (sceneDelta), with no full scene walk per frame
  {
    const e = make({ renderer: 'webgpu' }); await e.start(); e.haltLoop();
    const errs = [], error = console.error; console.error = (...a) => errs.push(a.map(String).join(' '));
    try {
      e.step(1 / 60, { describe: false }); e.step(1 / 60, { describe: false });
      const walks = e._webglOnlyView.walks;
      const late = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.RawShaderMaterial({ name: 'lateRaw' })); late.name = 'late';
      const holder = new THREE.Group(); e.scene.add(holder); holder.add(late);   // nested add: still seen
      e.step(1 / 60, { describe: false });
      out.late = { error: errs.find(l => l.includes("'lateRaw'")) ?? '', frozen: !!e.error, logged: errs.some(l => l.includes("'lateRaw'")), walks: e._webglOnlyView.walks - walks };
    } finally { console.error = error; e.dispose(); }
  }
  // option mistakes
  out.badName = (() => { try { make({ renderer: 'vulkan' }); return ''; } catch (e) { return e.message; } })();
  out.fallbackOnWebGL = (() => { try { make({ fallback: 'webgl' }).dispose(); return ''; } catch (e) { return e.message; } })();
  // 'webgl' names the default: the engine builds and owns a WebGLRenderer, as with the option left out
  out.webglName = (() => { const w = make({ renderer: 'webgl' }); try { return !!w.renderer.isWebGLRenderer && w._ownsRenderer; } finally { w.dispose(); } })();

  // the WebGPU route draws: ground + trees with the engine's wind patch (tsl field), real navigator.gpu (webgpu or its webgl2 fallback)
  const g = make({ renderer: 'webgpu', lights: true });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), applyEffects(new TG.MeshLambertNodeMaterial({ color: 0xc8d0a0 }), { clouds: false }));
  const tree = trees(true); applyEffects(tree.material, { clouds: false, wind: 0.3 }); tree.castShadow = true; ground.receiveShadow = true;
  g.scene.add(ground, tree);
  await g.start();
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(0, 3, 8); cam.lookAt(0, 1.5, 0); cam.updateMatrixWorld();
  const U = g.uniforms;
  U.uTime.value = 1.7; U.uWindFreq.value = 1; U.uWindAmp.value = 1; U.uWind.value = 0;
  const still = await shot(g, cam);
  U.uWind.value = 2;
  const sway = await shot(g, cam);
  out.scene = { renderer: g.describe().renderer, mean: mean(still), sway: changed(still, sway) };
  g.dispose();
  return out;
};

// engine.debug.view on the WebGPU route: every built-in mode draws something of its own, swayed meshes keep their sway inside the
// scene-wide views, shaderCost ranks the node programs, 'off' gives back the exact real picture. Console errors are collected per mode.
window.debugViewCases = async () => {
  const g = make({ renderer: 'webgpu', lights: true });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), applyEffects(new TG.MeshLambertNodeMaterial({ color: 0xc8d0a0 }), { clouds: false }));
  const tree = trees(true); applyEffects(tree.material, { clouds: false, wind: 0.3 }); tree.position.x = 1.5;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xd02020, roughness: 0.6 })); box.position.set(-1.5, 0.6, 0);
  const glass = new THREE.MeshBasicMaterial({ color: 0x4060ff, transparent: true, opacity: 0.4 });
  const panes = [0, 1].map(i => { const p = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.5), glass); p.position.set(0, 1.5, 2 + i * 0.3); return p; });
  g.scene.add(ground, tree, box, ...panes);
  await g.start(); g.haltLoop();
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(0, 3, 8); cam.lookAt(0, 1, 0); cam.updateMatrixWorld();
  const U = g.uniforms; U.uTime.value = 1.7; U.uWindFreq.value = 1; U.uWindAmp.value = 1; U.uWind.value = 0;
  const errs = [], orig = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 200)); orig(...a); };
  const share = (b, f) => { let n = 0; for (let i = 0; i < b.length; i += 4) if (f(b[i], b[i + 1], b[i + 2])) n++; return +(100 * n / (W * H)).toFixed(2); };
  const red = b => share(b, (r, gg, bb) => r > gg + 60 && r > bb + 60);
  const res = { backend: g.describe().renderer.backend, modes: g.debug.viewModes(), views: {} };
  try {
    const off = await shot(g, cam);
    res.off = { mean: mean(off), red: red(off), green: share(off, (r, gg) => gg > r + 30) };
    for (const mode of ['albedo', 'lighting', 'shadow', 'normals', 'overdraw', 'shaderCost']) {
      const n0 = errs.length, st = g.debug.view(mode);
      const a = await shot(g, cam);
      const v = res.views[mode] = { mode: st.mode, mean: mean(a), changed: changed(off, a), red: red(a), green: share(a, (r, gg) => gg > r + 30), levels: new Set(Array.from({ length: W * H }, (_, i) => a[i * 4])).size };
      if (mode === 'lighting' || mode === 'albedo') { U.uWind.value = 2; v.sway = changed(a, await shot(g, cam)); U.uWind.value = 0; }
      if (mode === 'shaderCost') { const cols = new Set(); g.scene.traverse(o => { if (o.isMesh) cols.add(o.material.color?.getHex()); }); v.colors = [...cols]; }
      v.override = g.scene.overrideMaterial ? { type: g.scene.overrideMaterial.type, node: !!g.scene.overrideMaterial.isNodeMaterial } : null;
      v.errors = errs.slice(n0);
    }
    g.debug.view('off');
    const back = await shot(g, cam);
    res.restored = { changed: changed(off, back), override: g.scene.overrideMaterial, materials: [ground, tree, box, ...panes].every(o => !o.material.userData._dbgOf) };
  } finally { console.error = orig; g.dispose(); }
  return res;
};

// debug.view('shadow') with an environment map (both renderers): scene.environment lights every standard material from all sides, so it lifted
// the shadows the view is meant to show black. Shadow area = ground pixels the sun's shadow darkens (castShadow on vs off, both in the view);
// level = their brightness in shadow over lit. Then 'off' must give back the real picture byte for byte and leave nothing on the scene.
window.shadowViewEnvCases = async (renderer) => {
  const g = make({ ...(renderer === 'webgpu' ? { renderer } : {}), lights: true });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.8 }));
  ground.receiveShadow = true;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), new THREE.MeshStandardMaterial({ color: 0xd02020 })); box.position.set(0, 1, 0); box.castShadow = true;
  g.scene.add(ground, box);
  await g.start(); g.haltLoop();
  const sun = g.lights.sun; sun.castShadow = true; sun.position.set(4, 6, 2); sun.target.position.set(0, 0, 0);
  const step = () => g.step(1 / 60, { describe: false });
  step();
  if (!g.scene.environment) {   // no map by default; this check needs one
    const pm = new (renderer === 'webgpu' ? TG.PMREMGenerator : THREE.PMREMGenerator)(g.renderer);
    g.scene.environment = pm.fromScene(new THREE.Scene().add(new THREE.HemisphereLight(0xffffff, 0xffffff, 3)), 0.04).texture;
  }
  const env = g.scene.environment, warns = [], warn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(-2, 4, 4.5); cam.lookAt(-1, 0, -0.5); cam.updateMatrixWorld();
  try {
    step(); const off = await shot(g, cam);
    g.debug.view('shadow'); step();
    sun.castShadow = false; step();
    const lit = await shot(g, cam);
    sun.castShadow = true; step();
    const dark = await shot(g, cam);
    let n = 0, sd = 0, sl = 0;
    for (let i = 0; i < dark.length; i += 4) {
      const a = dark[i] + dark[i + 1] + dark[i + 2], b = lit[i] + lit[i + 1] + lit[i + 2];
      if (b - a > 60) { n++; sd += a; sl += b; }
    }
    const envInView = g.scene.environment === env;   // between renders the scene keeps its real map (nothing for an ownership check to see)
    g.debug.view('off'); step();
    const back = await shot(g, cam);
    let diff = 0; for (let i = 0; i < back.length; i++) if (back[i] !== off[i]) diff++;
    return { backend: g.describe().renderer.backend, env: !!env, area: +(100 * n / (W * H)).toFixed(2), level: n ? +(sd / sl).toFixed(3) : null,
      envInView, restored: { bytes: diff, env: g.scene.environment === env, hooks: Object.hasOwn(g.scene, 'onBeforeRender') || Object.hasOwn(g.scene, 'onAfterRender'),
        override: g.scene.overrideMaterial }, ownedWarns: warns.filter(w => /owned-prop|stopped writing/.test(w)) };
  } finally { console.warn = warn; g.dispose(); }
};

// Shader errors on the WebGPU route (render/shaderErrors.js, render/fx/patchNodes.tsl.js): a tsl patch failing where it runs and inside three's
// build both name the patch and slot with this file on top of the stack; a compile error in a node program and a WebGPU pipeline failure name
// the material, the mesh and the patches on it. console.error is captured, not passed on: these errors are the point of the test.
window.shaderErrorCases = async () => {
  const TSL = await import('three/tsl'), { error: threeError } = await import('three');
  const out = {};
  try { applyEffects(new TG.MeshLambertNodeMaterial(), { clouds: false, patches: [{ name: 'oops', slot: 'position', tsl: c => c.nope.mul(2) }] }); }
  catch (e) { out.sync = { message: String(e.message).split('\n')[0], top: String(e.stack).split('\n')[1] ?? '' }; }
  const g = make({ renderer: 'webgpu', lights: true });
  await g.start(); g.haltLoop();
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100); cam.position.set(0, 1, 4); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const errs = [], orig = console.error;
  console.error = (...a) => { errs.push(a.map(x => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
  const settle = async () => { await shot(g, cam); await new Promise(r => setTimeout(r, 300)); await shot(g, cam); return errs.splice(0).join('\n'); };
  try {
    // a lighting hook object runs only inside three's build (applyEffects keeps it as text): three logs 'TSL:' with the location of the error's stack
    const late = applyEffects(new TG.MeshLambertNodeMaterial({ color: 0x808080 }), { clouds: false, patches: [{ name: 'late', slot: 'lighting', tsl: { after: c => { c.nope.mul(2); } } }] });
    const a = new THREE.Mesh(new THREE.BoxGeometry(), late); a.name = 'lateBox'; g.scene.add(a);
    out.build = await settle();
    a.removeFromParent();
    // code that runs fine but returns a node three cannot build (a null input, like a node made for another slot): the 'TSL:' log names
    // the patch and slot, then the material and mesh that now draw as three's plain stand-in
    const nul = applyEffects(new TG.MeshLambertNodeMaterial({ name: 'nullInput' }), { clouds: false,
      patches: [{ name: 'wetPatch', slot: 'color', tsl: c => { const n = c.tsl.mix(c.color, c.tsl.vec4(1), 0.5); n.cNode = null; return n; } }] });
    const nb = new THREE.Mesh(new THREE.BoxGeometry(), nul); nb.name = 'nullBox'; g.scene.add(nb);
    out.nullPatch = await settle();
    nb.removeFromParent();
    // the same in a post effect's node, and a Loop written outside an Fn (three drops it with no error): both name the effect
    const warns = [], warn = console.warn;
    console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
    try {
      g.post.add({ name: 'nullFog', slot: 'hdr', node: (input, { tsl }) => { const n = tsl.mix(input, tsl.vec4(1), 0.5); n.cNode = null; return n; } });
      g.post.render(0.016); await new Promise(r => setTimeout(r, 300)); g.post.render(0.016);
      out.nullPost = errs.splice(0).join('\n');
      g.post.get('nullFog').enabled = false;
      g.post.add({ name: 'loopFog', slot: 'hdr', node: (input, { tsl }) => {
        const acc = tsl.vec4(0).toVar(); tsl.Loop(3, () => { acc.addAssign(input.mul(0.3)); }); return acc; } });
      g.post.render(0.016);
      out.loop = warns.join('\n');
      g.post.get('loopFog').enabled = false;
    } finally { console.warn = warn; }
    // code three cannot compile, inside a node program with an engine patch on it
    const bad = applyEffects(new TG.MeshLambertNodeMaterial({ name: 'broken' }), { clouds: false, wind: 0.2 });
    out.backend = g.describe().renderer.backend;
    bad.colorNode = out.backend === 'webgpu' ? TSL.wgslFn('fn brokenColor() -> vec4f { return nope; }')() : TSL.glslFn('vec4 brokenColor() { return nope; }')();
    const b = new THREE.Mesh(new THREE.BoxGeometry(), bad); b.name = 'brokenBox'; g.scene.add(b);
    out.compile = await settle();
    // the WebGPU backend's only report path, called the way three's popErrorScope handler calls it (headless runs the WebGL2 backend)
    threeError(`WebGPURenderer: Render pipeline creation failed (renderPipeline_${bad.name}_${bad.id}): test validation error`);
    out.pipeline = errs.splice(0).join('\n');
  } finally { console.error = orig; g.dispose(); }
  return out;
};

// What a dropped mesh leaves in WebGPURenderer until the record sweep comes by (tests/specs/webgpu-release.mjs). The WebGL2 backend runs the same RenderObjects bookkeeping as real WebGPU, so this needs no GPU.
const gpuEngine = async () => { const e = make({ renderer: new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true }), batching: false }); await e.start(); e.haltLoop(); return e; };
const records = e => e.renderer._objects._renderObjects.size;
window.releaseCases = async () => {
  const out = {};
  const e = await gpuEngine(), mat = new THREE.MeshLambertMaterial();   // outlives every mesh, like a ground or asset material
  e.camera.position.set(0, 0, 8); e.camera.lookAt(0, 0, 0);
  e.renderOnce();
  const keep = new THREE.Mesh(new THREE.BoxGeometry(), mat); e.scene.add(keep); e.renderOnce();   // an emptied scene reads like three's fallback Scene (render/recordSweep.js)
  const base = records(e);
  const spawn = () => { const ms = []; for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(), mat); m.frustumCulled = false; ms.push(m); e.scene.add(m); } e.renderOnce(); return ms; };
  let ms = spawn(); out.drawn = records(e) - base;
  for (const m of ms) { m.removeFromParent(); m.geometry.dispose(); }
  e.renderOnce(); out.plainDrop = records(e) - base;
  const sweep = g => { g._records.sweepNow(); g._records.sweepNow(); };   // both, as a mesh must stay out across two
  sweep(e); out.released = records(e) - base;
  e.assets.shared.add(mat);   // what engine.remove skips: it may not dispose this material, and the records must go all the same
  ms = spawn(); e.remove(...ms); e.renderOnce(); sweep(e); out.engineRemove = records(e) - base;
  e.dispose();
  // streamed terrain: fly until far more chunks have come and gone than stay loaded
  const t = await gpuEngine();
  t.use(world(), terrain({ height: () => 0, viewChunks: 1 }));
  const cam = t.camera, seen = new Set(), dt = 1 / 60, say = console.warn, said = []; let x = 0, samples = 0;
  console.warn = (...a) => said.push(a.join(' '));
  cam.position.set(0, 40, 0); t.stream.source(cam, { detail: 'full' });
  for (let i = 0; i < 600 && seen.size < 100; i++) {
    x += 6; cam.position.set(x, 40, 0); cam.lookAt(x + 20, 0, 0);
    t.input.poll(dt); t._fixedStep(); t._frameHooks(dt); t._render(dt); t.input.endFrame(); t._runHooks('afterRender', dt);
    for (const k of t.terrain.chunks.keys()) seen.add(k);
    if (i % 2 === 0) { watchGeometries(t, 10); samples++; }   // streaming that disposes what it unloads: the geometry warning must stay silent
    await new Promise(r => setTimeout(r, 5));
  }
  console.warn = say; sweep(t);
  out.terrain = { seen: seen.size, loaded: t.terrain.chunks.size, records: records(t), samples, geometryWarnings: said.filter(m => m.includes('[geometry-undisposed]')).length };
  t.dispose();
  return out;
};

// What the record sweep frees and what it must leave alone (render/recordSweep.js), and the dev geometry warning (core/inspect/geometryWatch.js). tests/specs/webgpu-release.mjs reads these.
// three's BundleGroup beside the engine (tests/specs/bundles.mjs). Everything is read off real pixels: a bundle's whole point is that it draws what was recorded, not what the scene says now.
// Top-down camera, sun from +x, so the box's shadow falls on the ground at x = -3 and, with the sun moved, at x = +3. Points sit on the middle row, so the read-back's row order does not matter.
window.bundleCases = async () => {
  const e = make({ renderer: new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true }) }); await e.start(); e.haltLoop();
  const r = e.renderer, out = { bundles: r.backend.beginBundle !== undefined }, cam = e.camera;
  r.shadowMap.enabled = true;
  cam.position.set(0, 30, 0.001); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.position.set(10, 20, 0); sun.castShadow = true; Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20 }); e.scene.add(sun, new THREE.AmbientLight(0xffffff, 0.3));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 })); ground.receiveShadow = true; e.scene.add(ground);
  let recorded = 0;
  if (out.bundles) { const begin = r.backend.beginBundle; r.backend.beginBundle = function (c) { recorded++; return begin.call(this, c); }; }
  const px = async () => {
    const b = await shot(e, cam);
    return x => { const v = new THREE.Vector3(x, 0, 0).project(cam), i = Math.round((v.x + 1) / 2 * (W - 1)), j = H >> 1, o = (j * W + i) * 4; return [b[o], b[o + 1], b[o + 2]]; };
  };
  const red = c => c[0] > c[1] * 2 + 20, sum = c => c[0] + c[1] + c[2];
  const state = async () => { await px(); const q = await px(); return { box: red(q(0)), left: sum(q(-3)), right: sum(q(3)) }; };
  const empty = await state();
  const shadowed = v => v < empty.right * 0.75;   // the unshadowed ground, with nothing standing on it
  const mat = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 1 }), geo = new THREE.BoxGeometry(3, 6, 3).translate(0, 3, 0), box = new THREE.Mesh(geo, mat); box.castShadow = true;
  const bundle = new TG.BundleGroup(); bundle.name = 'town'; bundle.add(box); e.scene.add(bundle);
  const seen = async () => { const s = await state(); return { box: s.box, shadowLeft: shadowed(s.left), shadowRight: shadowed(s.right) }; };
  out.drawn = await seen();
  const rec = recorded; out.replay = await seen(); out.replayRecorded = recorded - rec;   // nothing changed: nothing is recorded again

  // the shadow pass replays too, and must follow the light, not the frame it was recorded in
  sun.position.set(-10, 20, 0); out.sunMoved = await seen();
  sun.position.set(10, 20, 0); await seen();

  // a child's visible: the bundle keeps replaying it until the game says so, and its shadow goes with it
  box.visible = false; out.childHiddenStale = await seen();
  bundle.needsUpdate = true; out.childHidden = await seen();
  box.visible = true; bundle.needsUpdate = true; out.childBack = await seen();
  // the group's own visible works at once, for the shadow as well, and costs no recording
  const before = recorded; bundle.visible = false; out.groupHidden = await seen();
  bundle.visible = true; out.groupBack = await seen(); out.groupRecorded = recorded - before;

  // read, not assumed: what a replayed bundle takes along without a recording
  box.position.x = 6; box.updateMatrixWorld(); out.moved = await seen();
  box.position.x = 0; box.updateMatrixWorld(); await seen();
  mat.color.set(0x0000ff); out.recolored = await seen();
  mat.color.set(0xff0000); await seen();

  // a light added after the recording
  const extra = new THREE.PointLight(0xffffff, 400); extra.position.set(0, 12, 0); e.scene.add(extra);
  const lit = await state(); out.lightAdded = { box: lit.box, ground: lit.right }; e.scene.remove(extra); extra.dispose(); await state();

  // removal from the group, then the group from the scene, through the engine: nothing stays drawn, nothing stays held
  bundle.remove(box); out.removedStale = await seen();
  bundle.needsUpdate = true; out.removed = await seen();
  bundle.add(box); bundle.needsUpdate = true; await seen();
  let freed = 0; geo.addEventListener('dispose', () => freed++);
  const records = () => r._objects._renderObjects.size, held = records();
  e.remove(bundle); out.gone = await seen(); e._records.sweepNow(); e._records.sweepNow(); await seen();
  out.goneFreed = freed; out.recordsDropped = held - records();

  // one owner: what is in a bundle is never batched, a plain group of the same is
  const warned = []; const say = console.warn; console.warn = (...a) => warned.push(a.join(' '));
  try {
    const kit = new THREE.BoxGeometry(), kitMat = new THREE.MeshStandardMaterial(), copies = (root, n = 12) => { for (let i = 0; i < n; i++) { const m = new THREE.Mesh(kit, kitMat); m.position.set(i * 2 - 12, 0.5, 8); root.add(m); } return root; };
    const asked = copies(new TG.BundleGroup()); asked.name = 'asked'; asked.userData.batch = true; e.scene.add(asked);
    const held2 = copies(new THREE.Group()), inner = copies(new TG.BundleGroup()); held2.add(inner); held2.userData.batch = true; e.scene.add(held2);
    e.step(1 / 60); e.step(1 / 60);
    out.batched = e.batching.stats.instances;   // the 12 plain copies alone
    out.bundledLayers = [...asked.children, ...inner.children].every(m => m.layers.mask === 1 && !m.userData.batched);
    out.batchWarned = warned.filter(w => w.includes('BundleGroup')).length;
    const d = e.describe?.().render ?? e.describe?.render; out.described = d?.bundles ?? null; out.describedText = /render bundles/.test(d?.text ?? '');
    const seenItem = e.inspect.scene({ limit: 500 }).items.find(x => x.path.includes('asked'));
    out.inspected = seenItem?.reasons?.some(x => x.code === 'in-bundle') ?? false;
    // a stream build may return a bundle: it loads with its meshes untouched, and unloading takes it out of the scene
    let built = null;
    const entry = e.stream.add({ position: [0, 0, 0], radius: 10, build: () => (built = copies(new TG.BundleGroup())) });
    e.stream.source(cam, { detail: 'full', physics: false });
    // a material the renderer has not drawn compiles first and attaches a task later (core/stream/prepare.js): let the compile settle between steps
    for (let i = 0; i < 60 && !built?.parent; i++) { e.step(1 / 60); await new Promise(res => setTimeout(res, 10)); }
    e.step(1 / 60);
    out.streamLoaded = !!built?.parent; out.streamBatched = e.batching.stats.instances;
    entry.remove?.(); for (let i = 0; i < 10 && built?.parent; i++) e.step(1 / 60);
    out.streamUnloaded = !built?.parent;
    // hlod leaves a bundle alone and says so
    e.use(hlod()); warned.length = 0;
    const h = e.hlod.add(asked); for (let i = 0; i < 5; i++) e.step(1 / 60);   // the page is paused, so whenReady would wait for jobs nobody runs
    out.hlodCells = h.cells.length; out.hlodWarned = warned.filter(w => w.includes('hlod')).length;
    out.hlodTouched = asked.children.some(m => m.userData.hlod);
    h.remove(); e.remove(asked); e.remove(held2);
  } finally { console.warn = say; }

  // a batch rests: its instances are static to three, and a write still reaches the screen (a move, a recolor, a copy leaving)
  e.scene.add(new THREE.AmbientLight(0xffffff, 1));
  const copyGeo = new THREE.BoxGeometry(2, 2, 2), copyMat = new THREE.MeshBasicMaterial({ color: 0xff0000 }), copies = [];
  for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(copyGeo, copyMat); m.position.set(i === 0 ? 0 : 200 + i * 3, 1, 0); m.userData.batch = true; e.scene.add(m); copies.push(m); }
  const look = async () => { e.step(1 / 60); e.step(1 / 60); await px(); const p = await px(); return { at0: red(p(0)), at6: red(p(6)), dimmed6: p(6)[0] > 20 && p(6)[0] < 150 }; };
  out.batch = await look();
  const im = e.batching.of(copies[0])[0]?.mesh; out.batchUsage = im ? im.instanceMatrix.usage === THREE.DynamicDrawUsage : null;
  copies[0].position.x = 6; out.batchMoved = await look();
  // the first tint of a batch already drawn: the copy at 6 goes darker (red x grey) (spec in bundles.mjs)
  e.batching.tint(copies[0], 0x808080); out.batchTinted = await look();
  e.batching.tint(copies[0], null); e.remove(copies[0]); out.batchLeft = await look();
  e.dispose();
  return out;
};

window.sweepCases = async () => {
  const e = await gpuEngine(), r = e.renderer, s = e._records, out = {}, mat = new THREE.MeshLambertMaterial();
  const set = () => r._objects._renderObjects, box = new THREE.BoxGeometry();
  const spawn = (n, into = e.scene) => Array.from({ length: n }, () => { const m = new THREE.Mesh(new THREE.BoxGeometry(), mat); m.frustumCulled = false; into.add(m); return m; });
  const both = () => { s.sweepNow(); s.sweepNow(); };
  e.camera.position.set(0, 0, 8); e.camera.lookAt(0, 0, 0);
  spawn(1);   // a scene that stays in use: an emptied one reads like three's internal fallback Scene (drawnWithoutScene)
  e.renderOnce();
  const base = set().size;
  // plain three.js: scene.remove, material still in use, no event
  const ms = spawn(12); e.renderOnce(); out.drawn = set().size - base;
  ms.forEach(m => e.scene.remove(m));
  s.sweepNow(); out.afterOneSweep = set().size - base;
  s.sweepNow(); out.afterTwoSweeps = set().size - base;
  // the record is a cache
  const pool = ms[0]; e.scene.add(pool); e.renderOnce(); out.readded = set().size - base;
  // a pooled mesh in and out between sweeps keeps its record
  const rec = [...set()].find(o => o.object === pool);
  for (let i = 0; i < 4; i++) { e.scene.remove(pool); s.sweepNow(); e.scene.add(pool); e.renderOnce(); s.sweepNow(); }
  out.poolKept = set().has(rec);
  e.scene.remove(pool); both(); out.poolFreed = !set().has(rec);
  // a game's own second Scene and everything drawn with no Scene above it
  const second = new THREE.Scene(); spawn(3, second);
  const tex = new THREE.DataTexture(new Uint8Array([40, 90, 200, 255]), 1, 1); tex.mapping = THREE.EquirectangularReflectionMapping; tex.needsUpdate = true;
  e.scene.background = tex;
  const quad = new TG.QuadMesh(new TG.MeshBasicNodeMaterial());
  const solo = new THREE.Mesh(box, mat), group = new THREE.Group(); group.add(new THREE.Mesh(box, mat));
  const pmrem = new TG.PMREMGenerator(r), env = pmrem.fromScene(second, 0, 0.1, 100, { size: 32 }), equi = pmrem.fromEquirectangular(tex);
  e.scene.environment = env.texture;
  e.post.add({ name: 'dim', slot: 'hdr', node: input => input.mul(0.9) });
  const draw = () => { e.renderOnce(); r.render(second, e.camera); quad.render(r); r.render(solo, e.camera); r.render(group, e.camera); };
  draw();
  const held = new Set(set());
  for (let i = 0; i < 3; i++) { s.sweepNow(); draw(); }
  out.rebuilt = [...held].filter(o => !set().has(o)).map(o => `${o.object.type}:${o.object.name}`);
  const top = o => { while (o.parent) o = o.parent; return o; };
  out.noScene = [...new Set([...set()].filter(o => !top(o.object).isScene).map(o => `${o.object.isQuadMesh ? 'QuadMesh' : o.object.type}:${o.object.name}`))];
  e.scene.background = null; e.scene.environment = null; equi.dispose();
  // a child taken out of a live render bundle is still replayed until the game sets needsUpdate; the WebGL2 backend has no bundles, there it is a plain group
  out.bundles = r.backend.beginBundle !== undefined;
  const bundle = new TG.BundleGroup(); spawn(2, bundle); e.scene.add(bundle); e.renderOnce();
  const child = bundle.children[0], kept = [...set()].filter(o => o.object === child); bundle.remove(child);
  both(); out.bundleKept = kept.length > 0 && kept.every(o => set().has(o));
  e.renderOnce();
  e.scene.remove(bundle); both(); out.bundleFreed = kept.every(o => !set().has(o));
  // three moved the private field: off, one coded warning, no throw
  const say = console.warn, said = []; console.warn = (...a) => said.push(a.join(' '));
  try {
    const Sweep = s.constructor, keep = r._objects._renderObjects, objects = r._objects;
    const guard = change => { const g = new Sweep(r); change(); try { g.sweepNow(); g.sweepNow(); return g.off; } catch { return 'threw'; } finally { r._objects = objects; objects._renderObjects = keep; } };
    out.guards = [guard(() => { delete objects._renderObjects; }), guard(() => { objects._renderObjects = new Set([{}]); }), guard(() => { r._objects = undefined; })];
    out.guardWarnings = said.splice(0).filter(m => m.includes('[webgpu-records-unread]')).length;
    out.sweeping = !s.off && s.sweeps > 0;
    // the geometry warning: silent on what is not a leak
    const round = (n, fn) => { e._geometryWatch = null; for (let i = 0; i < n; i++) { fn(); e.renderOnce(); watchGeometries(e, 10); } return said.splice(0).filter(x => x.includes('[geometry-undisposed]')).length; };
    let live = [];
    out.warnStreaming = round(30, () => { live.forEach(m => { e.scene.remove(m); m.geometry.dispose(); }); live = spawn(30); });
    live.forEach(m => { e.scene.remove(m); m.geometry.dispose(); }); live = [];
    const world = spawn(400); world.forEach(m => { m.visible = false; });
    e.renderOnce();
    let shown = 0;
    out.warnFirstDraws = round(20, () => { for (let i = 0; i < 20; i++) world[shown++].visible = true; });
    world.forEach(m => { e.scene.remove(m); m.geometry.dispose(); });
    out.warnGrowingWorld = round(20, () => { live.push(...spawn(20)); });
    live.forEach(m => { e.scene.remove(m); m.geometry.dispose(); }); live = [];
    out.warnOneBurst = round(20, () => { if (!live.length) { live = spawn(300); e.renderOnce(); live.forEach(m => e.scene.remove(m)); } });
    live.forEach(m => m.geometry.dispose());
    const leak = () => { const lost = spawn(20); e.renderOnce(); lost.forEach(m => e.scene.remove(m)); };
    out.warnLeak = round(20, leak);
    out.warnLeakAgain = round(20, leak);
  } finally { console.warn = say; }
  e.dispose();
  return out;
};

// Streaming after start (core/stream/prepare.js) on either renderer; tests/specs/stream-prepare.mjs reads these. An entry with an unseen material and texture must be
// uploaded and compiled before it is attached; one sharing a startup material attaches in the same step; walking away and back N times gives its memory back.
window.streamCases = async (gpu) => {
  const e = gpu ? await gpuEngine() : make({ batching: false });
  if (!gpu) { await e.start(); e.haltLoop(); }
  const r = e.renderer, S = e.stream, dt = 1 / 60, out = {}, frame = () => e.step(dt);
  const startMat = new THREE.MeshLambertMaterial(), shared = new THREE.DataTexture(new Uint8Array(16 * 16 * 4).fill(200), 16, 16);
  shared.needsUpdate = true;
  let sharedDisposed = 0; shared.addEventListener('dispose', () => sharedDisposed++);   // a game-owned texture: unloading must never dispose it
  e.scene.add(new THREE.AmbientLight(0xffffff, 1), new THREE.Mesh(new THREE.BoxGeometry(), startMat));
  S._prep.mark(e.scene);   // what start() does after its compile; this engine started empty, so its scene is marked here
  frame();
  const until = async (ok, n = 300) => { for (let i = 0; i < n && !ok(); i++) { frame(); await new Promise(res => setTimeout(res, 5)); } return ok(); };
  S.radius = 40;
  // 1. unseen material + texture, behind the camera (WebGPU's compileAsync culls by the frustum): readied first, attached after, drawn later with no compile
  e.camera.position.set(0, 2, 0); e.camera.lookAt(0, 2, -10); e.camera.updateMatrixWorld();
  const programs = () => gpu ? r._pipelines.programs.vertex.size + r._pipelines.programs.fragment.size : r.info.programs.length, stalls = e.budget.cost.compiles.length;
  let mesh = null;
  const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(90), 4, 4); tex.needsUpdate = true;
  const c0 = S._prep.compiles, t0 = r.info.memory.textures, p0 = r.info.programs?.length ?? null;
  const fresh = S.add({ position: [0, 0, 6], build: () => (mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3 }))).translateZ(6).translateY(2) });
  e.step(dt, { render: false });
  out.fresh = { compiled: S._prep.compiles - c0, uploadedBeforeDraw: r.info.memory.textures - t0, programsBeforeDraw: p0 == null ? null : r.info.programs.length - p0, attachedInStep: fresh.built };
  out.fresh.attached = await until(() => fresh.built);
  frame(); const before = programs();
  e.camera.lookAt(0, 2, 10); e.camera.updateMatrixWorld(); frame(); frame();   // turn around: the first draw of it
  out.fresh.programsOnTurn = programs() - before;
  out.fresh.drawn = !gpu || [...r._objects._renderObjects].some(ro => ro.object === mesh);
  out.fresh.stallsAfterAttach = e.budget.cost.compiles.length - stalls;   // WebGL: neither the compile's own frame nor the first draw counts as a stall
  // 2. a material start() compiled: shown in the same step, no compile
  const c1 = S._prep.compiles, kit = S.add({ position: [-2, 0, 0], build: () => new THREE.Mesh(new THREE.BoxGeometry(), startMat) });
  frame();
  out.kit = { attachedInStep: kit.built, compiled: S._prep.compiles - c1 };
  fresh.remove(); kit.remove();
  // 3. walk away and back: 24 entries 200 m out, each with its own geometry and material and the game's shared texture
  const reused = new THREE.MeshLambertMaterial({ color: 0xc08060 });   // one game material every build of an entry reuses: the unload disposes it
  S.add({ position: [210, 0, 12], build: () => new THREE.Mesh(new THREE.BoxGeometry(), reused) });
  for (let i = 0; i < 24; i++) S.add({ position: [200 + (i % 6) * 3, 0, Math.floor(i / 6) * 3], build: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2), new THREE.MeshLambertMaterial({ map: shared, color: 0x80a0c0 })) });
  const mem = () => { if (gpu) { e._records.sweepNow(); e._records.sweepNow(); } frame(); const m = r.info.memory; return { geometries: m.geometries, textures: m.textures, total: m.total ?? null, records: gpu ? records(e) : null }; };
  const trip = async () => {
    e.focus.set(205, 0, 4); const there = await until(() => S.stats.built === 25 && S.ready), knownThere = S._prep.known.get(reused) === true;
    e.focus.set(0, 0, 0); const back = await until(() => S.stats.built === 0 && e.jobs.pending === 0);
    return there && back && knownThere && !S._prep.known.has(reused);   // compiled each time it comes back, forgotten when disposed
  };
  out.trips = [];
  for (let i = 0; i < 6; i++) out.trips.push({ ok: await trip(), ...mem() });
  out.sharedDisposed = sharedDisposed;
  // 4. the GPU memory metric: in the budget only where three counts bytes, reported only against the game's own limit
  e.budget.enable({ gpuMemoryMB: 0.001 });
  const v = e.budget.values();
  out.metric = { value: v.gpuMemoryMB ?? null, notice: e.budget.notice() ?? '', describe: e.describe().perf.gpuMemory, perfText: e.inspect.perf().text.includes('GPU memory') };
  e.budget.disable();
  e.dispose();
  return out;
};

// texture MB in inspect.perf / threedog perf (tests/specs/texture-memory.mjs): one 256x256 texture drawn must read above zero on both renderers.
// WebGPU: the texture sits only in a TSL node (no material slot), the case the material walk missed; the reading is three's info.memory.texturesSize.
// WebGL: three counts no bytes, so the estimate walks material slots and shadow maps
window.textureMemoryCase = async (gpu) => {
  const e = gpu ? await gpuEngine() : make({ batching: false });
  if (!gpu) { await e.start(); e.haltLoop(); }
  const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4).fill(150), 256, 256); tex.needsUpdate = true;
  const mat = gpu ? Object.assign(new TG.MeshBasicNodeMaterial(), { colorNode: TG.TSL.texture(tex) }) : new THREE.MeshBasicMaterial({ map: tex });
  e.camera.position.set(0, 0, 3); e.camera.lookAt(0, 0, 0);
  e.step(1 / 60);
  const before = e.inspect.perf().textureMB;
  e.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), mat));
  e.step(1 / 60); e.step(1 / 60);
  const p = e.inspect.perf(), out = { before, after: p.textureMB, line: p.text.split('\n')[0] };
  e.dispose();
  return out;
};
