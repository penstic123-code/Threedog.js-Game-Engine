// Real-time light page (tests/specs/light-webgpu.mjs). A corner: a red wall in full sun meets a white wall in the wall's own shadow side, so whatever red
// lands on the white wall can only have bounced. forceWebGL: true is what ordinary runs get; packages/tools/real-webgpu.mjs rewrites it to real WebGPU.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import * as TSL from 'three/tsl';
import 'threedog/tsl';
import { createEngine } from '../../index.js';
import { backendName } from '../../render/backend.js';
import { threePatches } from '../../core/scene/threePatches.js';
import { PostFX } from '../../render/PostFX.js';
import { RESERVED_LAYERS } from '../../render/layers.js';
import { voxelGI, temporalAA, sunShafts, lightVolumes, reflections, autoExposure } from '@threedog/post-effects/tsl';
import { bloom } from '@threedog/post-effects';

const W = 320, H = 240;
const renderer = new TG.WebGPURenderer({ canvas: document.getElementById('view'), antialias: false, forceWebGL: true });
renderer.shadowMap.enabled = true;
const engine = window.engine = createEngine({ renderer, pixelRatio: 1, adaptiveResolution: false, lights: false, ui: { loading: false }, saveKey: 'test-light-webgpu', urlState: false });
engine.tier = 'high';   // the headless GPU reads as low; the tier hold has its own check below

const wall = (color, w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide }));
const red = wall(0xff0000, 8, 6), white = wall(0xffffff, 8, 6), floor = wall(0x808080, 8, 8);
red.position.set(-4, 3, 0); red.rotation.y = Math.PI / 2;          // x = -4, faces +x
white.position.set(0, 3, -4);                                     // z = -4, faces +z
floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, 0);
for (const m of [red, white, floor]) { m.castShadow = m.receiveShadow = true; engine.scene.add(m); }
// the sun hits the red wall square on and only grazes the white one
const sun = new THREE.DirectionalLight(0xffffff, 6);
sun.position.set(10, 4, -3.9); sun.target.position.set(0, 2, -4); sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.1, far: 40 });
engine.scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.15));

await engine.start();
const demo = new URLSearchParams(location.search).get('demo');
if (!demo) engine.haltLoop();
const cam = engine.camera;
cam.position.set(1.5, 3, 5); cam.lookAt(-2, 2.5, -4); cam.aspect = W / H; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
const rt = new TG.RenderTarget(W, H);
// the chain stays on through every on / off pair: without any effect the render into rt skips the output stage, and linear next to sRGB reads as a brightness change
engine.post.add({ name: 'chain', node: input => input });

/** Mean color of the white wall's left part, where it meets the red one (columns found by the test scene's camera; rows are the middle, so a flipped read agrees) */
async function corner(frames = 24) {
  for (let i = 0; i < frames; i++) { engine.renderOnce(rt); await new Promise(requestAnimationFrame); }
  const px = new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
  let r = 0, g = 0, n = 0;
  for (let y = H * 0.4 | 0; y < H * 0.6; y++) for (let x = W * 0.45 | 0; x < W * 0.6; x++) { const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; n++; }
  return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1) };
}
/** Median ms from submit to the GPU finishing one frame; a real-device number, so only real-WebGPU runs read it */
async function cost(n = 40) {
  const t = [], device = renderer.backend.device;
  for (let i = 0; i < n; i++) {
    const a = performance.now(); engine.renderOnce(rt); await device?.queue.onSubmittedWorkDone(); t.push(performance.now() - a);
  }
  return +t.sort((x, y) => x - y)[n >> 1].toFixed(2);
}
const passOf = () => engine.post._pipe;

window.lightGI = async () => {
  const backend = backendName(renderer), out = { backend };
  let vxgiNode = null;
  const gi = engine.post.add(voxelGI({ resolution: 64, bounds: new THREE.Box3(new THREE.Vector3(-6, -1, -6), new THREE.Vector3(6, 7, 6)), intensity: 2, setup: n => { vxgiNode = n; } }));
  const taa = engine.post.add(temporalAA());
  out.row = () => engine.describe().render.post.find(x => x.name === 'voxelGI');
  engine.post.antialias = true;
  out.antialias = engine.describe().render.antialias;
  out.aaText = /temporalAA in place of MSAA/.test(engine.describe().render.text);
  taa.enabled = false;
  out.msaa = engine.describe().render.antialias;
  out.msaaText = /\+ MSAA x4/.test(engine.describe().render.text);
  taa.enabled = true;
  engine.post.antialias = false;
  if (backend !== 'webgpu') {   // forced WebGL2 backend: nothing runs, describe() says so, nothing was built
    const row = out.row(); delete out.row;
    return { ...out, row, built: !!vxgiNode, buffersWithoutGI: passOf()?.order?.includes('voxelGI') ?? false };
  }
  gi.enabled = false; taa.enabled = false;
  const base = await cost();
  const plain = await corner();
  gi.enabled = true; taa.enabled = true;
  out.bounced = await corner();
  // with occlusion culling on: a thing it hides leaves the picture, not the bounce
  const watched = engine.occlusion.watch([red]);
  engine.occlusion.enabled = true;
  const item = [...engine.occlusion._items].find(i => i.meshes[0] === red);
  engine.occlusion._hide(item); vxgiNode.needsUpdate = true;
  out.hiddenBounce = await corner();
  engine.occlusion.enabled = false; watched.remove(); vxgiNode.needsUpdate = true;
  const row = out.row(); delete out.row;
  out.row = row;
  out.costOn = await cost();
  out.buffersOn = Object.keys(passOf().scenePass.getMRT()?.outputNodes ?? {});
  // the only way voxelGI could have run on a low tier device
  engine.tier = 'low'; engine.post._sync();
  out.lowTier = { on: gi.enabled, order: passOf().order.includes('voxelGI'), held: engine.describe().render.post.find(x => x.name === 'voxelGI').held };
  engine.tier = 'high'; engine.post._sync();
  gi.enabled = false; taa.enabled = false;
  out.off = { order: passOf().order, mrt: !!passOf().scenePass.getMRT(), cost: await cost(), facts: engine.describe().render.post.find(x => x.name === 'voxelGI').facts ?? null };
  out.plain = plain; out.base = base;
  gi.remove(); taa.remove();
  return out;
};
// Why an effect is held, with no GPU behind it: a fake effect that declares everything, against each kind of renderer (the swap is read where
// runsHere reads it, engine.post._fellBack). What the real effects do on a WebGLRenderer the game chose is real below
window.lightHeld = async () => {
  const fake = { name: 'fake', node: i => i, backend: 'webgpu', skipOnLowTier: true };
  const held = (renderer, { tier = 'high', fellBack = false, on = true } = {}) => PostFX.prototype._held.call({ engine: { renderer, tier, post: { _fellBack: fellBack } } }, { name: 'fake', _def: fake, _on: () => on });
  const gpu = { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }, gl2 = { isWebGPURenderer: true, backend: {} }, forced = { isWebGPURenderer: true, backend: { parameters: { ['force' + 'WebGL']: true } } }, webgl = {};   // spelled in two: real-webgpu.mjs rewrites the plain text
  const warn = console.warn, notes = [];
  console.warn = (...a) => { notes.push(a.join(' ')); };
  const cases = { runs: held(gpu), low: held(gpu, { tier: 'low' }), lowOff: held(gpu, { tier: 'low', on: false }), webgl2: held(gl2), swapped: held(webgl, { fellBack: true }), chose: held(webgl), choseLow: held(webgl, { tier: 'low' }), forced: held(forced) };
  held(gpu, { tier: 'low' });
  console.warn = warn;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }); document.body.appendChild(c);
  const e = createEngine({ canvas: c, lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false }, saveKey: 'test-light-held', urlState: false });
  await e.start(); e.haltLoop();
  const errors = [fake, voxelGI(), temporalAA(), sunShafts({ light: sun }), lightVolumes({ bounds: new THREE.Box3() }), reflections(), autoExposure()].map(fx => { try { e.post.add(fx); return null; } catch (err) { return err.message; } });
  e.dispose();
  return { cases, lowNotes: notes.filter(n => /fake' held off: engine.tier/.test(n)).length, errors };
};
// More scene targets than the device takes: a named throw and nothing added, never three's validation error. Only the WebGL2 backend's count can be faked; real WebGPU's limits are read-only
window.lightRoom = async () => {
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }); document.body.appendChild(c);
  const e = createEngine({ renderer: new TG.WebGPURenderer({ canvas: c, forceWebGL: true }), lights: false, pixelRatio: 1, ui: { loading: false }, saveKey: 'test-light-room', urlState: false });
  await e.start(); e.haltLoop(); const gl = e.renderer.backend.gl, get = gl?.getParameter.bind(gl);
  if (gl) gl.getParameter = k => (k === gl.MAX_DRAW_BUFFERS ? 3 : get(k));
  const msg = (() => { try { e.post.add({ name: 'many', node: i => i, needsBuffers: ['normal', 'diffuse', 'metalRough'] }); return null; } catch (err) { return err.message; } })(), kept = !!e.post.get('many');
  e.dispose();
  return { backend: backendName(e.renderer), msg, kept };
};
// The two effects that need something the game may not have say so by name
// The WGSL a depth-compare sample is written as, asked of three's builder itself: no GPU and no backend needed, so every run checks it (render/fx/compareLevel.tsl.js)
window.compareSnippets = () => {
  const write = texture => TG.WGSLNodeBuilder.prototype.generateTextureCompare.call({ shaderStage: 'fragment' }, texture, 'map', 'uv', 'ref', null, null, 'fragment');
  const on = { shadowMap: write({ isDepthTexture: true }), array: write({ isDepthTexture: true, isArrayTexture: true }), mipmapped: write({ isDepthTexture: true, generateMipmaps: true }) };
  threePatches.off('compare-sample-level');
  return { on, off: write({ isDepthTexture: true }), listed: threePatches.list().some(p => p.id === 'compare-sample-level' && p.offable) };
};
window.lightMissing = async () => {
  const message = f => { try { f(); return null; } catch (err) { return err.message; } };
  const noBounds = message(() => lightVolumes());
  const noLight = message(() => engine.post.add(sunShafts()));
  return { noBounds, noLight };
};
// A closed room with one window: the air is dark, so a shaft has something to stand out from
const dark = new THREE.MeshStandardMaterial({ color: 0x404040, roughness: 1, side: THREE.DoubleSide });
function room() {
  const parts = [[0.2, 8, 3, 0, 4, 2.5, 6.5], [0.2, 4, 3, 0, 1, 0, 0], [0.2, 2, 5, 3, 3, -3.5, 0], [0.2, 2, 5, 3, 3, 3.5, 0]];
  const g = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 14), dark); roof.position.y = 6.1; g.add(roof);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.2, 6, 14), dark); back.position.set(3.5, 3, 0); back.visible = false;
  // the wall the sun hits, x = 3.5, with a window at y 2.5 to 4.5, z -1 to 1
  for (const [y, h, z, d] of [[1.25, 2.5, 0, 14], [5.25, 1.5, 0, 14], [3.5, 2, -4, 6], [3.5, 2, 4, 6]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, d), dark); m.position.set(3.5, y, z); g.add(m);
  }
  const far = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 0.2), dark); far.position.set(0, 3, 7); g.add(far);
  g.traverse(o => { o.castShadow = o.receiveShadow = true; });
  engine.scene.add(g);
  sun.position.set(12, 9, 0); sun.target.position.set(0, 1, 0);
  return g;
}
/** Mean brightness of the columns the shaft crosses (left of center is the lit patch side), and of the rest */
async function bright() {
  for (let i = 0; i < 12; i++) { engine.renderOnce(rt); await new Promise(requestAnimationFrame); }
  return new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
}
const delta = (on, off, x0, x1, y0, y1) => { let s = 0, n = 0; for (let y = y0 * H | 0; y < y1 * H; y++) for (let x = x0 * W | 0; x < x1 * W; x++) { const i = (y * W + x) * 4; s += on[i] - off[i]; n++; } return +(s / n).toFixed(1); };

window.lightShafts = async () => {
  const backend = backendName(renderer);
  const g = room();
  const fx = engine.post.add(sunShafts({ light: sun }));
  fx.enabled = false;
  const off = await bright();
  fx.enabled = true;
  const on = await bright();
  const msOn = await cost(); fx.enabled = false;
  const out = { backend, ms: { on: msOn, off: await cost() }, whole: delta(on, off, 0, 1, 0, 1), rows: [0.2, 0.4, 0.6, 0.8].map(y => [0, 0.25, 0.5, 0.75].map(x => delta(on, off, x, x + 0.25, y, y + 0.2))) };
  fx.remove(); g.removeFromParent();
  return out;
};
window.lightCones = async () => {
  const backend = backendName(renderer);
  sun.intensity = 0; red.material.color.set(0x303030); white.material.color.set(0x303030);
  const spot = new THREE.SpotLight(0xffffff, 200, 12, 0.3, 0.3, 1.5);
  spot.position.set(0, 6, -1); spot.target.position.set(0, 0, -1); spot.castShadow = true; spot.shadow.bias = -0.002;
  engine.scene.add(spot, spot.target);
  const fx = engine.post.add(lightVolumes({ bounds: new THREE.Box3(new THREE.Vector3(-6, 0, -6), new THREE.Vector3(6, 7, 6)) }));
  fx.enabled = false;
  const off = await bright();
  fx.enabled = true;
  const on = await bright();
  const lampLayer = spot.layers.isEnabled(RESERVED_LAYERS.lightVolumes);
  // a background given as a node: three prefers it over scene.background, and it must stay out of the air, or the box adds the sky over the picture
  // read at the draw itself: the box of air is drawn in the air pass alone, so what its hook sees is what that pass sees
  let box = null, atDraw = null;
  engine.scene.traverse(o => { if (o.isMesh && o.layers.isEnabled(RESERVED_LAYERS.lightVolumes)) box = o; });
  box.onBeforeRender = (r, s) => { atDraw = { background: s.background, backgroundNode: s.backgroundNode, alpha: r.getClearAlpha() }; };
  spot.intensity = 0;
  engine.scene.backgroundNode = TSL.vec3(1, 1, 1);
  const skyOn = await bright();
  const nodeKept = !!engine.scene.backgroundNode;
  fx.enabled = false;
  const skyOff = await bright();
  engine.scene.backgroundNode = null;
  spot.intensity = 200;
  fx.enabled = true;
  const ms = { on: await cost() }; fx.enabled = false; ms.off = await cost(); fx.enabled = true;
  const cone = [0.2, 0.4, 0.6, 0.8].map(y => [0, 0.25, 0.5, 0.75].map(x => delta(on, off, x, x + 0.25, y, y + 0.2)));
  // the sun alone: the fact in describe() must be true
  spot.intensity = 0; sun.intensity = 6;
  const sunOn = await bright();
  fx.enabled = false;
  const sunOff = await bright();
  const out = { backend, ms, cone, sunOnly: delta(sunOn, sunOff, 0, 1, 0, 1), skyOnly: delta(skyOn, skyOff, 0, 1, 0, 1), atDraw, nodeKept, lampLayer, fact: engine.describe().render.post.find(x => x.name === 'lightVolumes').facts };
  fx.remove();
  out.lampBack = !spot.layers.isEnabled(RESERVED_LAYERS.lightVolumes);
  engine.scene.remove(spot, spot.target);
  red.material.color.set(0xff0000); white.material.color.set(0xffffff);
  return out;
};
// A mirror: a polished metal floor under a bright box, the walls hidden. Without an environment map the metal is dark, so whatever lights it under the box is the reflection
function mirror(metalness = 1) {
  const g = new THREE.Group();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness, roughness: 0.05 }));
  plane.rotation.x = -Math.PI / 2;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 3 }));
  box.position.set(-1, 1.2, -1);
  g.add(plane, box);
  for (const m of [red, white, floor]) m.visible = false;
  engine.scene.add(g);
  cam.lookAt(-1, 0, -1); cam.updateMatrixWorld();   // down at the floor (the corner view barely shows it); lightMirror puts it back
  // where the box's mirror image lands on screen: its center mirrored under the floor, projected
  const at = new THREE.Vector3(-1, -1.2, -1).project(cam);
  const x = (at.x + 1) / 2, y = (at.y + 1) / 2;
  // the rows of a read come bottom first on one backend and top first on the other: the larger of the two places is the image (the box does not move with the effect)
  const win = (on, off, v) => delta(on, off, x - 0.04, x + 0.04, v - 0.04, v + 0.04);
  return { g, plane, under: (on, off) => Math.max(win(on, off, y), win(on, off, 1 - y)) };
}
const textures = () => renderer.info.memory.textures;
window.lightMirror = async () => {
  const backend = backendName(renderer), m = mirror();
  engine.tier = 'high';   // the page's own setting, again: the engine's first-seconds frame check reads the headless GPU as low by now
  await bright(); const tex0 = textures();
  // add, draw, remove, draw: what it made (its targets, the merged buffers) goes with it; alone, and with bloom and temporalAA. setup's resolutionScale holds
  const once = engine.post.add(reflections({ setup: s => { s.resolutionScale = 1; } })); await bright(); const made = textures() - tex0, full = engine.describe().render.post.find(x => x.name === 'reflections').facts;
  once.remove(); await bright(); const leak = { made, left: textures() - tex0, full: full?.target };
  const trio = [reflections(), bloom({ strength: 0.3 }), temporalAA()].map(e => engine.post.add(e)); await bright();
  // temporalAA after another effect once left two textures per rebuild (traa's own copy of its input)
  for (const h of trio) h.remove(); await bright(); leak.trio = textures() - tex0;
  const fx = engine.post.add(reflections());
  fx.enabled = false;
  const off = await bright();
  fx.enabled = true;
  const on = await bright();
  const row = () => engine.describe().render.post.find(x => x.name === 'reflections');
  const out = { backend, leak, under: m.under(on, off), buffers: Object.keys(passOf().scenePass.getMRT()?.outputNodes ?? {}), facts: row().facts };
  // a number changes in place (no rebuild: the same pipeline output node), and it really reaches the shader
  const built = passOf().output;
  fx.set({ intensity: 0 });
  out.live = { same: passOf().output === built, under: m.under(await bright(), off) };
  fx.set({ intensity: 1, binaryRefine: true });   // built into the shader: rebuilds
  out.refine = { rebuilt: passOf().output !== built, under: m.under(await bright(), off) };
  // order with the rest of the chain: before bloom and temporalAA
  const glow = engine.post.add(bloom({ strength: 0.3 })), taa = engine.post.add(temporalAA());
  await bright();
  out.order = passOf().order.filter(n => ['reflections', 'bloom', 'temporalAA'].includes(n));
  glow.remove();
  // voxelGI + reflections + temporalAA, as recipe 34 suggests: metalRough rides in velocity's target, four targets in all (32 bytes, WebGPU's default)
  const gi = engine.post.add(voxelGI({ resolution: 32, bounds: new THREE.Box3(new THREE.Vector3(-6, -1, -6), new THREE.Vector3(6, 7, 6)) }));
  out.combo = { under: m.under(await bright(), off), buffers: Object.keys(passOf().scenePass.getMRT()?.outputNodes ?? {}), gi: !engine.describe().render.post.find(x => x.name === 'voxelGI').held };
  gi.remove(); taa.remove();
  out.ms = { on: await cost() };
  fx.enabled = false; out.ms.off = await cost(); fx.enabled = true;
  // a surface reflects in proportion to its metalness: none at 0, some at 0.3
  const at = async metalness => { m.plane.material.metalness = metalness; const a = await bright(); fx.enabled = false; const b = await bright(); fx.enabled = true; return m.under(a, b); };
  out.stone = await at(0); out.partial = await at(0.3);
  engine.tier = 'low'; engine.post._sync();
  out.lowTier = { order: passOf().order.includes('reflections'), held: row().held };
  engine.tier = 'high';
  fx.remove();
  out.after = { mrt: !!passOf().scenePass.getMRT() };
  m.g.removeFromParent();
  for (const o of [red, white, floor]) o.visible = true;
  cam.lookAt(-2, 2.5, -4); cam.updateMatrixWorld();
  return out;
};
// ?demo=shafts or ?demo=cones leaves the effect on and the loop running, to look at it (real-webgpu.mjs --urls ... --shots=dir)
if (demo === 'shafts') { room(); engine.post.add(sunShafts({ light: sun })); }
if (demo === 'cones') {
  sun.intensity = 0;
  const spot = new THREE.SpotLight(0xffffff, 200, 12, 0.3, 0.3, 1.5);
  spot.position.set(0, 6, -1); spot.target.position.set(0, 0, -1); spot.castShadow = true; spot.shadow.bias = -0.002;
  engine.scene.add(spot, spot.target);
  engine.post.add(lightVolumes({ bounds: new THREE.Box3(new THREE.Vector3(-6, 0, -6), new THREE.Vector3(6, 7, 6)) }));
}
if (demo === 'mirror') { mirror(); engine.post.add(reflections()); }
window.ready = true;
