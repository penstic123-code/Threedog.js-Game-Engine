// WebGPU post chain page (tests/specs/post-webgpu.mjs): the same PostFX list run by postWebGL.js (EffectComposer on a WebGLRenderer) and by
// render/fx/postWebGPU.tsl.js (RenderPipeline on a WebGPURenderer, WebGL2 backend), on one scene with HDR-bright spheres so bloom has work.
// Why hand-made renderers and a PostFX per renderer: the engine has no WebGPURenderer entry yet (plan step 2, core/engine/Engine.js). Each PostFX gets a
// stand-in engine (Object.create of the real one) that swaps in its renderer and keeps its own ownership map, which is what Engine.js will
// hand it once it builds a WebGPURenderer itself.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';   // registers the WebGPU post backend, as the WebGPU route will
import { bloom, ao, vignette, lut, grain, chromatic, outline, dof, OUTLINE_OFF_LAYER } from '@threedog/post-effects';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { createEngine } from '../../index.js';
import { PostFX } from '../../render/PostFX.js';

const W = 200, H = 150;
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-post-webgpu', urlState: false });
await engine.start();
engine.haltLoop();

const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const look = r => { r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
  r.setClearColor(0x000000, 1); return r; };
const gl = look(new THREE.WebGLRenderer({ canvas: canvas(), antialias: false }));
const gpu = look(new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true }));
await gpu.init();

// HDR-bright spheres (values > 1 before tone mapping, so the 0.85 threshold keeps them) in front of a dim backdrop box
const scene = new THREE.Scene();
const room = new THREE.Mesh(new THREE.BoxGeometry(30, 20, 30), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.1, 0.14), side: THREE.BackSide }));
scene.add(room);
for (const [x, y, c] of [[-2.5, 0, [4, 2, 0.6]], [0, 0.8, [0.8, 3, 4]], [2.5, -0.4, [3, 3, 3]]]) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(...c) }));
  s.position.set(x, y, 0); scene.add(s);
}
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100); camera.position.set(0, 0, 7); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();

/**
 * A PostFX on its own renderer: a stand-in engine with that renderer, this scene / camera, its own ownership map and its own shared
 * points: an effect's switch is a shared point, and two PostFX on one registry cleared each other's
 */
function postOn(renderer, effects) {
  const e = Object.create(engine, { renderer: { value: renderer }, scene: { value: scene }, camera: { value: camera }, tier: { value: 'high' },
    _owned: { value: new Map(), writable: true }, look: { value: undefined, writable: true }, stacks: { value: null, writable: true } });
  e.stacks = new engine.stacks.constructor(e);
  e.stacks.define('tier', { kind: 'value', base: 'high', save: false });   // the stand-in has no Engine constructor: PostFX follows the tier point
  const post = new PostFX(e, { antialias: false });
  for (const fx of effects) post.add(fx);
  return post;
}
const read = r => { const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(r.domElement, 0, 0); return x.getImageData(0, 0, W, H).data; };
/** draw one frame and read it in the same task (no preserveDrawingBuffer needed) */
const shot = post => { post.render(0.016); return read(post.engine.renderer); };
const mean = a => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return s / (W * H * 3); };
/** relative difference of the two means, in % */
/** mean absolute pixel difference of two shots, in % of 255 */
const change = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return +(100 * s / (W * H * 3 * 255)).toFixed(3); };
const rel = (a, b) => +(100 * Math.abs(a - b) / Math.max(1e-6, b)).toFixed(2);
const thrown = f => { try { f(); return ''; } catch (err) { return String(err?.message ?? err); } };

/** Every node reachable from n (three's Node.traverse) */
const nodesOf = n => { const out = new Set(); n.traverse(x => out.add(x)); return out; };

// tests/specs/plain-three-adoption.mjs and one-post-entry.mjs: post.add, the one way in, on both backends (a Pass on WebGL, a node
// function on WebGPU, an effect { name, create, node } on both)
window.postAddPass = async () => {
  const out = {};
  const pg = postOn(gpu, []), base = mean(shot(pg));
  pg.add((input, { tsl }) => tsl.vec4(input.rgb.mul(0.25), input.a));   // keep alpha: a dimmed alpha reads back unpremultiplied
  const dark = mean(shot(pg));
  out.gpu = { base: +base.toFixed(2), dark: +dark.toFixed(2), list: pg.list().map(e => `${e.name}:${e.slot}`) };
  // the leak (review 2026-11-03): remove() of a node effect must dispose what the engine built for it (bloom's mip targets)
  const glow = pg.add((input, ctx) => input.add(ctx.display.bloom(input)), { name: 'glow' });
  shot(pg);
  let freed = 0; const rec = pg.get('glow')?._impl, d0 = rec?.dispose, nBuilt = rec?.nodes?.length ?? 0;
  if (rec) rec.dispose = () => { freed++; d0.call(rec); };
  glow.remove(); shot(pg);
  out.leak = { built: nBuilt > 0, freed, gone: !pg.get('glow') };
  // one effect, both renderers: the same { name, create, node } value runs on each, and set() switches it the same way
  const both = () => ({ name: 'dim', slot: 'ldr',
    create: () => new ShaderPass({ uniforms: { tDiffuse: { value: null } }, vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(c.rgb * 0.25, c.a); }' }),
    node: (input, { tsl }) => tsl.vec4(input.rgb.mul(0.25), input.a) });
  out.both = {};
  for (const [k, r] of [['gl', gl], ['gpu', gpu]]) {
    const q = postOn(r, []), b0 = mean(shot(q)); q.add(both()); shot(q); const on = mean(shot(q));
    q.get('dim').enabled = false; shot(q); const off = mean(shot(q));
    out.both[k] = { base: +b0.toFixed(1), on: +on.toFixed(1), off: +off.toFixed(1) };
    q.dispose();
  }
  const pl = postOn(gl, []), copy = new ShaderPass(CopyShader);
  pl.add(copy); shot(pl);
  out.gl = { list: pl.list().map(e => `${e.name}:${e.slot}`), inChain: pl.object()?.passes.includes(copy) ?? false };
  out.glNode = thrown(() => { pl.add(input => input); shot(pl); });
  pg.dispose(); pl.dispose();
  return out;
};

window.postWebGPU = async () => {
  const out = {};
  // ---------- parity: the same effect on both backends, screenshot means within 3% ----------
  const pair = effects => {
    const a = postOn(gl, effects()), b = postOn(gpu, effects());
    const r = { gl: +mean(shot(a)).toFixed(2), gpu: +mean(shot(b)).toFixed(2) };
    a.dispose(); b.dispose();
    return r;
  };
  const base = pair(() => [{ ...vignette({ strength: 0 }) }]);   // a no-op ldr effect: both chains on, nothing changing the picture
  const bl = pair(() => [bloom({ strength: 0.5, radius: 0.5, threshold: 0.85 })]);
  const vg = pair(() => [vignette({ strength: 0.8, start: 0.2 })]);
  const oc = pair(() => [ao({ radius: 1.5 })]);   // smoke only: GTAOPass and GTAONode differ in sampling, so no parity bound
  // outline / dof: engine-written passes ported step by step to nodes (not three's OutlineNode / DepthOfFieldNode). A blur keeps the mean, so the
  // effect itself is the mean absolute pixel change against the no-op baseline (% of 255); parity is still the screenshot mean within 3%
  const fx = effects => {
    const a = postOn(gl, effects()), b = postOn(gpu, effects()), A = shot(a), B = shot(b);
    a.dispose(); b.dispose();
    return { gl: +mean(A).toFixed(2), gpu: +mean(B).toFixed(2), diff: rel(mean(B), mean(A)), A, B };
  };
  const ref = fx(() => [{ ...vignette({ strength: 0 }) }]);
  const fxOut = r => ({ gl: r.gl, gpu: r.gpu, diff: r.diff, effectGL: change(r.A, ref.A), effectGPU: change(r.B, ref.B), cross: change(r.A, r.B) });
  const white = scene.children[3];   // the white sphere, exempt from the lines through the off layer in the offLayer case
  white.layers.enable(OUTLINE_OFF_LAYER);
  out.outline = {
    depth: fxOut(fx(() => [outline({ thickness: 1.5, strength: 1 })])),
    normal: fxOut(fx(() => [outline({ mode: 'normal', thickness: 1.5, strength: 1 })])),
    both: fxOut(fx(() => [outline({ mode: 'both', thickness: 1.5, strength: 1 })])),
    wobble: fxOut(fx(() => [outline({ thickness: 1.5, strength: 1, wobble: 1.5 })])),
    offLayer: fxOut(fx(() => [outline({ thickness: 1.5, strength: 1, offLayer: OUTLINE_OFF_LAYER })])),
  };
  white.layers.disable(OUTLINE_OFF_LAYER);
  // focus behind the back wall, so spheres and wall both blur and mix at the sphere edges (a sharp neighbor is kept out of a blur by design)
  out.dof = fxOut(fx(() => [dof({ focus: 40, range: 1, falloff: 4, maxBlur: 6 })]));
  // ---------- color grading and the tone slot: same steps on both backends, so they are compared pixel by pixel (cross: mean absolute
  // difference of the two shots, % of 255) as well as by mean ----------
  // a 3D LUT that rotates the channels (r, g, b) -> (g, b, r): an axis-order or row-layout slip on one backend shows as a hue change
  const N = 8, cube = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const i = 4 * (r + N * (g + N * b)), v = x => Math.round(255 * x / (N - 1));
    cube.set([v(g), v(b), v(r), 255], i);
  }
  const lut3 = new THREE.Data3DTexture(cube, N, N, N);
  lut3.format = THREE.RGBAFormat; lut3.minFilter = lut3.magFilter = THREE.LinearFilter; lut3.unpackAlignment = 1; lut3.needsUpdate = true;
  out.lut = {
    numbers: fxOut(fx(() => [lut({ contrast: 1.4, saturation: 0.4, temperature: 0.8 })])),
    texture: fxOut(fx(() => [lut({ lut: lut3, amount: 1 })])),
  };
  // a game's own tone curve (Reinhard, then gamma 2.2) replacing OutputPass / renderOutput: a Pass for WebGL, a node for WebGPU, the same math
  const tone = () => ({ name: 'myTone', slot: 'tone',
    create: () => new ShaderPass({ uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); ' +
        'gl_FragColor = vec4(pow(c.rgb / (1.0 + c.rgb), vec3(1.0 / 2.2)), c.a); }' }),
    node: (input, { tsl: T }) => T.vec4(T.pow(input.rgb.div(input.rgb.add(1)), T.vec3(1 / 2.2)), input.a) });
  out.tone = {
    alone: fxOut(fx(() => [tone()])),
    // an ldr effect after it colors the tone stage's output on both (the order is scene -> tone -> ldr)
    withLut: fxOut(fx(() => [tone(), lut({ lut: lut3, amount: 1 })])),
  };
  lut3.dispose();
  // ---------- no effects: straight to the canvas on both. A Color background, and the clear color with none, are tone-mapped like the rest
  // (WebGL draws them as a tone-mapped quad in postWebGL direct(); WebGPU renders through its frame-buffer target and output pass) ----------
  const direct = (bg, clear) => {
    const a = postOn(gl, []), b = postOn(gpu, []), was = scene.background;
    scene.background = bg;
    for (const r of [gl, gpu]) r.setClearColor(clear ?? 0x000000, 1);
    const A = shot(a), B = shot(b), pick = s => Array.from(s.slice(0, 3));   // a corner pixel: the background
    scene.background = was;
    for (const r of [gl, gpu]) r.setClearColor(0x000000, 1);
    const res = { active: a.active || b.active, gl: +mean(A).toFixed(2), gpu: +mean(B).toFixed(2), diff: rel(mean(B), mean(A)), bgGL: pick(A), bgGPU: pick(B) };
    a.dispose(); b.dispose();
    return res;
  };
  const room = scene.children[0];
  out.direct = { scene: direct(null) };
  room.visible = false;   // only the spheres: the background fills most of the picture
  out.direct.color = direct(new THREE.Color(0.9, 0.55, 0.2));
  out.direct.clear = direct(null, 0x66aaff);
  out.direct.hdrColor = direct(new THREE.Color(3, 1.5, 0.6));   // above 1: only a tone-mapped background keeps its hue roll-off
  const tex = new THREE.DataTexture(new Uint8Array([230, 140, 50, 255]), 1, 1); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  out.directTexture = direct(tex);   // logged, not checked: the one known difference (see postWebGPU.tsl.js direct())
  tex.dispose();
  room.visible = true;
  out.parity = {
    base: { ...base, diff: rel(base.gpu, base.gl) },
    bloom: { ...bl, diff: rel(bl.gpu, bl.gl), effectGL: rel(bl.gl, base.gl), effectGPU: rel(bl.gpu, base.gpu) },
    vignette: { ...vg, diff: rel(vg.gpu, vg.gl), effectGL: rel(vg.gl, base.gl), effectGPU: rel(vg.gpu, base.gpu) },
    ao: { ...oc, diff: rel(oc.gpu, oc.gl), darkerGL: oc.gl < base.gl, darkerGPU: oc.gpu < base.gpu },
  };

  // ---------- four slots in order: scene -> hdr -> renderOutput -> ldr -> final ----------
  const tag = (name, slot) => ({ name, slot, node: input => input.mul(1) });
  const p = postOn(gpu, [chromatic(), grain({ animated: false }), vignette(), lut({ saturation: 1.2 }), bloom(), tag('pixelScene', 'scene'), tag('sharpen', 'final')]);
  p.render(0.016);
  const P = p._pipe, o = p.object();
  out.order = P.order;
  out.object = { pipeline: o?.pipeline === P.pipeline && !!o.pipeline.isRenderPipeline, scenePass: o?.scenePass === P.scenePass && !!o.scenePass.isPassNode,
    manualOutput: o?.pipeline.outputColorTransform === false };
  // the graph itself: bloom's node sits under renderOutput, the ldr effects' uniforms do not (they color the tone-mapped image)
  const all = nodesOf(P.output), ro = [...all].find(n => n.isRenderOutputNode), under = ro ? nodesOf(ro) : new Set();
  const bloomNode = [...all].find(n => n.constructor.name === 'BloomNode' || n.type === 'BloomNode');
  const vigU = p.get('vignette')._u.strength, lutU = p.get('lut')._u.saturation;
  out.graph = { renderOutput: !!ro, bloomUnder: !!bloomNode && under.has(bloomNode), vigInGraph: all.has(vigU), vigAfter: !under.has(vigU), lutAfter: all.has(lutU) && !under.has(lutU) };
  // a number param writes its uniform: no rebuild
  const before = P.output;
  p.get('vignette').set({ strength: 0.7 });
  out.live = { same: p._pipe.output === before, value: vigU.value };
  // a game's three.js Pass (create only) on WebGPU fails by name with the node: form
  out.onlyCreate = thrown(() => p.add({ name: 'myCopy', slot: 'ldr', create: () => new ShaderPass(CopyShader) }));
  out.onlyCreateGone = !p.get('myCopy') && p._pipe.output === before;
  out.glslFuse = thrown(() => p.add({ name: 'tintGL', slot: 'ldr', fuse: { glsl: 'color.rgb *= 0.5;' } }));
  p.dispose();

  // ---------- a param the effect reads as a plain value (ctx.params on WebGPU, a constant baked at create() on WebGL, no update()): set() reaches
  // the picture on both backends, by a rebuild (the uniform alone would reach nothing) ----------
  const tint = () => ({ name: 'tint', slot: 'ldr', params: { amount: 0.25 },
    create: ({ params }) => new ShaderPass({ uniforms: { tDiffuse: { value: null }, amount: { value: params.amount } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(c.rgb * amount, c.a); }' }),
    node: (input, { tsl: T, params }) => T.vec4(input.rgb.mul(params.amount), input.a) });
  const plain = renderer => {
    const q = postOn(renderer, [tint()]);
    shot(q); const dim = mean(shot(q));
    q.get('tint').set({ amount: 0.5 });
    const lit = mean(shot(q));
    q.dispose();
    return { dim: +dim.toFixed(2), lit: +lit.toFixed(2), ratio: +(lit / Math.max(1e-6, dim)).toFixed(3) };
  };
  out.plainParam = { gl: plain(gl), gpu: plain(gpu) };
  // outline's color starts as a number, so its uniform is a float: a Color rebuilds the chain instead of writing into it
  const lined = postOn(gpu, [outline({ thickness: 1.5, strength: 1 })]);
  shot(lined);
  out.colorParam = thrown(() => { lined.get('outline').set({ color: new THREE.Color(0xff0000) }); shot(lined); });
  lined.dispose();
  // a node() that throws while the chain rebuilds: the effects still in the list get a working graph, not the old one whose nodes and scene pass the failed build already disposed
  const kept = postOn(gpu, [vignette()]);
  shot(kept);
  const failed = thrown(() => kept.add({ name: 'bad', slot: 'ldr', needsBuffers: ['normal'], node: () => { throw new Error('bad node'); } }));
  out.rollback = { failed, gone: !kept.get('bad'), built: !!kept.get('vignette')._impl, buffers: kept._pipe.buffers, lit: mean(shot(kept)) > 0 };
  kept.dispose();

  // ---------- post.own(): the engine stops rebuilding the chain (both backends); own(false) rebuilds ----------
  const manual = (renderer, read) => {
    const q = postOn(renderer, [vignette(), grain({ animated: false })]);
    q.render(0.016);
    const was = read(q);
    q.own();
    const writer = q.engine._owned.get('post.chain')?.info().writer;
    q.get('grain').enabled = false;   // a chain change while the game owns it
    q.render(0.016);
    const kept = read(q) === was;
    q.own(false);
    const rebuilt = read(q) !== was;
    const r = { kept, rebuilt, writer };
    q.dispose();
    return r;
  };
  out.manual = {
    gpu: manual(gpu, q => q._pipe.output),
    gl: manual(gl, q => q.composer.passes.map(x => x.constructor.name + (x.items?.length ?? '')).join(',')),
  };
  return out;
};
