// Group P1 page (tests/specs/group-p1.mjs): fog and renderOnce(target) agree whether or not an effect is on, on a WebGLRenderer and a
// WebGPURenderer (WebGL2 backend). Same hand-made renderers + stand-in engine as tests/post-webgpu/main.js.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';
import { bloom, vignette } from '@threedog/post-effects';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/addons/shaders/GammaCorrectionShader.js';
import { createEngine, threePatches, applyEffects } from '../../index.js';
import { PostFX } from '../../render/PostFX.js';

const W = 160, H = 120;
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-group-p1', urlState: false });
await engine.start(); engine.haltLoop();

const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const look = r => { r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor(0x000000, 1); return r; };
const gl = look(new THREE.WebGLRenderer({ canvas: canvas(), antialias: false }));
const gpu = look(new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true }));
await gpu.init();

// A floor running into the distance and a wall past fog far: the wall is pure fog colour, the floor in between is part fogged
const FOG = 0xb8c4d6;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(FOG, 4, 30);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0xc86432 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -1.5; scene.add(floor);
const wall = new THREE.Mesh(new THREE.PlaneGeometry(400, 40), new THREE.MeshBasicMaterial({ color: 0x2060c0 }));
wall.position.set(0, 0, -90); scene.add(wall);
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 300); camera.position.set(0, 0, 6); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();

function postOn(renderer, effects, sc = scene) {
  const e = Object.create(engine, { renderer: { value: renderer }, scene: { value: sc, writable: true }, camera: { value: camera }, tier: { value: 'high' },
    _owned: { value: new Map(), writable: true }, look: { value: undefined, writable: true }, stacks: { value: null, writable: true } });
  e.stacks = new engine.stacks.constructor(e);
  const post = new PostFX(e, { antialias: false });
  for (const fx of effects) post.add(fx);
  return post;
}
const read = r => { const c = canvas(), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(r.domElement, 0, 0); return x.getImageData(0, 0, W, H).data; };
const shot = post => { post.render(0.016); return read(post.engine.renderer); };
/** mean rgb of a pixel rectangle [x0,y0,x1,y1] */
const patch = (a, [x0, y0, x1, y1]) => { const s = [0, 0, 0]; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; s[0] += a[i]; s[1] += a[i + 1]; s[2] += a[i + 2]; n++; }
  return s.map(v => +(v / n).toFixed(2)); };
const dist = (p, q) => +Math.max(...p.map((v, i) => Math.abs(v - q[i]))).toFixed(2);
const WALL = [60, 40, 100, 50], FLOOR = [60, 70, 100, 75];   // pure fog (the wall, near the horizon) and the part-fogged floor
const noop = () => vignette({ strength: 0 });   // a no-op ldr effect: the chain is on, the picture is not changed by it
const bloomOn = () => bloom({ strength: 0.0001, radius: 0.1, threshold: 5 });   // bloom's own glow is out of the way: only the chain differs
const backends = [['gl', gl], ['gpu', gpu]];

/** (a) fog and no effect, (b) the same with the chain on: the wall and floor patches */
window.fogCase = async () => {
  const out = {};
  for (const [k, r] of backends) {
    const pa = postOn(r, []), a = shot(pa);
    const pb = postOn(r, [bloomOn()]), b = shot(pb);
    const pn = postOn(r, [noop()]), n = shot(pn);
    out[k] = { direct: { wall: patch(a, WALL), floor: patch(a, FLOOR) }, bloom: { wall: patch(b, WALL), floor: patch(b, FLOOR) }, noop: { wall: patch(n, WALL), floor: patch(n, FLOOR) } };
    out[k].wallDiff = dist(out[k].direct.wall, out[k].bloom.wall); out[k].floorDiff = dist(out[k].direct.floor, out[k].bloom.floor);
    out[k].wallDiffNoop = dist(out[k].direct.wall, out[k].noop.wall); out[k].floorDiffNoop = dist(out[k].direct.floor, out[k].noop.floor);
    for (const p of [pa, pb, pn]) p.dispose?.();
  }
  return out;
};

/** (c) a flat background in the fog colour (what sky({ backdrop }) writes to scene.background): the wall against the sky above it */
window.seamCase = async () => {
  const out = {};
  const sc = new THREE.Scene(); sc.fog = scene.fog; sc.background = new THREE.Color(FOG); sc.add(floor.clone(), wall.clone());
  for (const [k, r] of backends) {
    const SKY = [60, 2, 100, 10], res = {};
    for (const [n, fx] of [['direct', []], ['bloom', [bloomOn()]]]) {
      const p = postOn(r, fx, sc), a = shot(p);
      res[n] = { sky: patch(a, SKY), wall: patch(a, WALL) }; res[n].seam = dist(res[n].sky, res[n].wall); p.dispose?.();
    }
    out[k] = res;
  }
  return out;
};

/** renderOnce(target): the target's pixels against the canvas's, with and without an effect on */
window.targetCase = async () => {
  const out = {}, fog = scene.fog;
  scene.fog = null;   // this item is about the target, not the fog (item 1 has its own)
  for (const [k, r] of backends) {
    const res = {};
    for (const [n, fx] of [['direct', []], ['chain', [noop()]]]) {
      const p = postOn(r, fx), canvasPx = shot(p);
      const rt = new (k === 'gl' ? THREE.WebGLRenderTarget : TG.RenderTarget)(W, H, { type: THREE.UnsignedByteType });
      p.render(0, rt);
      const px = new Uint8Array(W * H * 4);
      if (k === 'gl') r.readRenderTargetPixels(rt, 0, 0, W, H, px); else px.set(new Uint8Array(await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H)));
      // both readbacks are bottom-up: flipped to screen order

      const t = new Uint8Array(px.length); for (let y = 0; y < H; y++) t.set(px.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
      res[n] = { target: patch(t, FLOOR), canvas: patch(canvasPx, FLOOR) }; res[n].diff = dist(res[n].target, res[n].canvas);
      rt.dispose(); p.dispose?.();
    }
    out[k] = res;
  }
  scene.fog = fog;
  return out;
};

/** (2) no tone curve (sRGB output only): fog is still mixed before the encoding, so direct and chain agree */
window.noToneCase = async () => {
  const out = {};
  for (const [k, r] of backends) {
    r.toneMapping = THREE.NoToneMapping;
    const a = shot(postOn(r, [])), n = shot(postOn(r, [noop()]));
    out[k] = { direct: patch(a, FLOOR), chain: patch(n, FLOOR) };
    out[k].diff = dist(out[k].direct, out[k].chain); out[k].wallDiff = dist(patch(a, WALL), patch(n, WALL));
    r.toneMapping = THREE.ACESFilmicToneMapping;
  }
  return out;
};

/** (4) a ShaderMaterial that runs fog_fragment BEFORE tonemapping_fragment: compiles, and draws what three's own chunks draw */
window.orderCase = async () => {
  const mat = (v = '') => new THREE.ShaderMaterial({ fog: true, uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: '#include <fog_pars_vertex>\nvoid main(){ vec4 mvPosition = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}',
    fragmentShader: '#include <common>\n#include <fog_pars_fragment>\nvoid main(){ gl_FragColor = vec4(0.8, 0.4, 0.2, 1.);\n#include <fog_fragment>\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' + v });
  const sc = new THREE.Scene(); sc.fog = scene.fog;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat()); m.rotation.x = -Math.PI / 2; m.position.y = -1.5; sc.add(m);
  let errors = 0; const logs = []; gl.debug.onShaderError = (g, pr, vs, fs) => { errors++; logs.push((g.getShaderInfoLog(fs) + g.getShaderInfoLog(vs)).slice(0, 300)); };
  const withPatch = patch(shot(postOn(gl, [], sc)), FLOOR);
  threePatches.off('fog-linear');
  const m2 = new THREE.Mesh(m.geometry, mat('// a second program: the cached one was built with the patch')); m2.rotation.x = -Math.PI / 2; m2.position.y = -1.5; sc.remove(m); sc.add(m2);
  const without = patch(shot(postOn(gl, [], sc)), FLOOR);
  return { errors, logs, withPatch, without, diff: dist(withPatch, without) };
};

/** (6) the module evaluated a second time (hot reload): off() still puts three's own chunks back */
window.reevalCase = async () => {
  await import('../../render/postWebGL.js?second');
  const on = THREE.ShaderChunk.tonemapping_fragment.includes('THREEDOG_FOG_DONE');
  threePatches.off('fog-linear');
  const C = THREE.ShaderChunk;
  return { on, off: !C.tonemapping_fragment.includes('THREEDOG_FOG') };   // only the engine's own mix goes; the fog slot's helpers and guard stay (D1)
};

/** (1) 60 renderOnce(target) calls with no effect on dispose the composer's targets 0 times; they go back after the idle frames */
window.reuseCase = async () => {
  const p = postOn(gl, []), rt = new THREE.WebGLRenderTarget(W, H);
  p.render(0, rt);
  let disposed = 0; const c = p.composer;
  for (const t of [c.renderTarget1, c.renderTarget2]) t.addEventListener('dispose', () => disposed++);
  for (let i = 0; i < 60; i++) p.render(0, rt);
  const during = disposed;
  for (let i = 0; i < 130; i++) p.render(0.016);
  return { during, afterIdle: disposed };
};

/** (5) engine.scene replaced: renderOnce(target) on WebGPU shows the new scene */
window.sceneSwapCase = async () => {
  const p = postOn(gpu, []), rt = new TG.RenderTarget(W, H, { type: THREE.UnsignedByteType });
  const mid = async () => { p.render(0, rt); const px = new Uint8Array(await gpu.readRenderTargetPixelsAsync(rt, 0, 0, W, H)); const i = ((H / 2) * W + W / 2) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const a = await mid();
  const sc2 = new THREE.Scene(); sc2.background = new THREE.Color(0x00ff00);
  p.engine.scene = sc2;
  const b = await mid();
  return { a, b };
};

/** item 3: the warnings: a gamma ShaderPass on WebGL, a node calling renderOutput on WebGPU, and the opt-out (slot 'tone') */
window.twiceCase = async () => {
  const warns = [], w = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); w.apply(console, a); };
  try {
    const pg = postOn(gl, []); pg.add(new ShaderPass(GammaCorrectionShader));
    const warnedGl = warns.length;
    const pg2 = postOn(gl, []); pg2.add(new ShaderPass(GammaCorrectionShader), { slot: 'tone' });
    const optOutGl = warns.length - warnedGl;
    const pp = postOn(gpu, []); pp.add((input, { tsl }) => tsl.renderOutput(input), { name: 'twice' });
    pp.render(0.016);   // nodes are built at the first draw
    const warnedGpu = warns.length - warnedGl - optOutGl;
    const pq = postOn(gpu, []); pq.add((input, { tsl }) => tsl.renderOutput(input), { slot: 'tone', name: 'mine' });
    pq.render(0.016);
    const optOutGpu = warns.length - warnedGl - optOutGl - warnedGpu;
    return { warnedGl, optOutGl, warnedGpu, optOutGpu, warns };
  } finally { console.warn = w; }
};

/** (D1 item 16) a `fog` slot patch is the one fog mix: a patch that writes default fog draws the same pixels as no patch, direct and through the chain; a second mix would shift the floor */
window.fogSlotCase = async () => {
  const mix = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, threedogFogColor(), threedogFogFactor() );';
  const floorOf = patches => { const f = new THREE.Mesh(floor.geometry, applyEffects(new THREE.MeshBasicMaterial({ color: 0xc86432 }), { patches })); f.rotation.x = -Math.PI / 2; f.position.y = -1.5; return f; };
  const draw = (patches, effects) => { const sc = new THREE.Scene(); sc.fog = scene.fog; sc.add(floorOf(patches)); return patch(shot(postOn(gl, effects, sc)), FLOOR); };
  const none = draw([], []), same = draw([{ name: 'fogsame', slot: 'fog', glsl: mix }], []), chain = draw([{ name: 'fogsame', slot: 'fog', glsl: mix }], [noop()]);
  const twice = draw([{ name: 'fogtwice', slot: 'fog', glsl: mix + mix }], []);   // control: the harness does see a second mix
  return { none, same, chain, twice, diff: dist(none, same), chainDiff: dist(none, chain), twiceDiff: dist(none, twice) };
};

/** (D1 item 16b) threePatches.off('fog-linear') keeps a fog slot patch compiling and mixing once; with no patch three's own order is back */
window.fogSlotOffCase = async () => {
  const mix = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, threedogFogColor(), threedogFogFactor() );';
  const draw = (patches, tag) => { const f = new THREE.Mesh(floor.geometry, applyEffects(new THREE.MeshBasicMaterial({ color: 0xc86432 }), { patches: patches.map(p => ({ ...p, name: p.name + tag })) })); f.rotation.x = -Math.PI / 2; f.position.y = -1.5;
    const sc = new THREE.Scene(); sc.fog = scene.fog; sc.add(f); return patch(shot(postOn(gl, [], sc)), FLOOR); };
  const slot = [{ name: 'fogoff', slot: 'fog', glsl: mix }];
  const nop = t => [{ name: 'nop' + t, slot: 'color', glsl: 'diffuseColor.rgb *= 1.0;' }];   // a distinct program per call: the shader cache would hand back the one built before off()
  const before = draw(slot, 'a'), noneOn = draw(nop('a'), 'a');
  let errors = 0; gl.debug.onShaderError = () => { errors++; };
  threePatches.off('fog-linear');
  const after = draw(slot, 'b'), noneOff = draw(nop('b'), 'b');
  const orig = THREE.ShaderChunk[Symbol.for('threedog.fogChunks')];
  return { before, after, noneOn, noneOff, errors, slotDiff: dist(before, after), orderBack: THREE.ShaderChunk.tonemapping_fragment === orig.tonemapping_fragment, noneMoved: dist(noneOn, noneOff) };
};

/** (D1 item 16c) two fog slot patches on one material: the second is rejected (the slot is exclusive, as a replace is) */
window.fogSlotTwoCase = async () => {
  const m = applyEffects(new THREE.MeshBasicMaterial(), { patches: [{ name: 'fogA', slot: 'fog', glsl: 'gl_FragColor.rgb *= 1.0;' }] });
  try { applyEffects(m, { patches: [{ name: 'fogB', slot: 'fog', glsl: 'gl_FragColor.rgb *= 1.0;' }] }); return { error: '' }; } catch (e) { return { error: String(e.message) }; }
};
