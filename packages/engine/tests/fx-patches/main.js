// Patch `tsl` field page (tests/specs/fx-patches.mjs): the engine's built-in patches through applyEffects on a NodeMaterial (WebGPURenderer,
// WebGL2 backend) against the same call on a plain three.js material (WebGLRenderer, GLSL), in one vegetation scene: instanced trees with a
// sun shadow on a lit ground. Why the real applyEffects and not hand-written materials (tests/fx does those): this checks the patch path itself
// (slot mapping, chaining, the lighting wrap, shadows following positionNode); tests/fx checks the function library under it.
// Why also on vs off: 0% parity could mean neither side applied the effect.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';   // registers the NodeMaterial side of patches (render/fx/patchNodes.tsl.js), as the WebGPU route will
import { createEngine, applyEffects, water } from '../../index.js';
import { lightingPatch } from '../../render/lighting.js';
import { copyPatches, materialPatches } from '../../render/patches.js';
import { bindUniforms } from '../../render/engineUniforms.js';
import pixelmatch from '../fx/pixelmatch.js';

const W = 160, H = 120;
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-fx-patches', urlState: false });
await engine.start();
engine.haltLoop();
const U = engine.uniforms;

// ---------- renderers: one of each kind side by side, bound to this engine's uniforms (the engine's own WebGPU entry is tested in tests/backend) ----------
const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const look = r => { r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; return r; };
const gl = look(new THREE.WebGLRenderer({ canvas: canvas(), antialias: false }));
bindUniforms(gl, U);   // our own WebGLRenderer reads this engine's uniforms too, so both sides draw the same time / wind / clouds
const gpu = look(new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true }));
await gpu.init();
bindUniforms(gpu, U);
const glRT = new THREE.WebGLRenderTarget(W, H), gpuRT = new TG.RenderTarget(W, H);
const shotGL = (scene, cam) => { gl.setRenderTarget(glRT); gl.setClearColor(0x000000, 1); gl.render(scene, cam); const b = new Uint8Array(W * H * 4);
  gl.readRenderTargetPixels(glRT, 0, 0, W, H, b); gl.setRenderTarget(null); return b; };
const shotGPU = async (scene, cam) => { gpu.setRenderTarget(gpuRT); gpu.setClearColor(0x000000, 1); gpu.render(scene, cam);
  const b = new Uint8Array(await gpu.readRenderTargetPixelsAsync(gpuRT, 0, 0, W, H)); gpu.setRenderTarget(null); return b; };
/** share of pixels pixelmatch (threshold 0.1) calls different, in % */
const diff = (a, b) => +(100 * pixelmatch(a, b, null, W, H, { threshold: 0.1 }) / (W * H)).toFixed(3);
const mean = a => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return +(s / (W * H * 3)).toFixed(2); };

U.uTime.value = 1.7; U.uWind.value = 1.5; U.uWindFreq.value = 1; U.uWindAmp.value = 1;
U.uWeatherCloud.value = 0.5; U.uCloudShadow.value = 0.8; U.uCloudShadowScale.value = 0.35; U.uCloudShadowSpeed.value.set(0.4, 0.2);
U.uGroundTint.value.setRGB(0.9, 0.6, 0.3); U.uGroundMix.value = 0; U.uFoliageTint.value.setRGB(0.8, 0.3, 0.1); U.uFoliageMix.value = 0.5;

const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(0, 6, 11); cam.lookAt(0, 1, 0); cam.updateMatrixWorld();
const tall = new THREE.BoxGeometry(0.6, 3, 0.6, 1, 10, 1).translate(0, 1.5, 0), flat = new THREE.PlaneGeometry(20, 20, 4, 4).rotateX(-Math.PI / 2);
/** A lit material of either kind: three's MeshLambertMaterial (GLSL) or MeshLambertNodeMaterial (TSL), same color */
const lit = (kind, color, type = 'lambert') => type === 'standard'
  ? (kind === 'gpu' ? new TG.MeshStandardNodeMaterial({ color, roughness: 0.5 }) : new THREE.MeshStandardMaterial({ color, roughness: 0.5 }))
  : kind === 'gpu' ? new TG.MeshLambertNodeMaterial({ color }) : new THREE.MeshLambertMaterial({ color });

/** The vegetation scene: trees (two InstancedMeshes + a plain mesh) casting a sun shadow on the ground; fx = applyEffects options per part */
function vegetation(kind, fx) {
  const s = new THREE.Scene();
  // bright enough that the season tint reads above pixelmatch's threshold (linear output, no tone mapping)
  s.add(new THREE.HemisphereLight(0xbcd4ff, 0x606050, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(-6, 10, 4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 40 });
  s.add(sun, sun.target);
  const treeMat = applyEffects(lit(kind, 0x9ad070, fx.type), fx.trees), groundMat = applyEffects(lit(kind, 0xc8d0a0, fx.type), fx.ground);
  for (const m of [treeMat, groundMat]) if (fx.patches) applyEffects(m, { clouds: false, patches: fx.patches() });
  const ground = new THREE.Mesh(flat, groundMat); ground.receiveShadow = true;
  const inst = new THREE.InstancedMesh(tall, treeMat, 4), q = new THREE.Object3D();
  [[-3, 0, 0.3, 1], [-1, 1, 1.1, 0.8], [1, -1, 2.0, 1.2], [3, 0.5, -0.7, 1]].forEach(([x, z, ry, sc], i) => {
    q.position.set(x, 0, z); q.rotation.set(0, ry, 0.1 * i); q.scale.set(sc, sc * 1.1, sc); q.updateMatrix(); inst.setMatrixAt(i, q.matrix); });
  const inst2 = new THREE.InstancedMesh(tall, treeMat, 2);
  [[-4.5, 2.5, 0.9], [4.5, 2.5, -1.3]].forEach(([x, z, ry], i) => { q.position.set(x, 0, z); q.rotation.set(0, ry, 0); q.scale.setScalar(0.9); q.updateMatrix(); inst2.setMatrixAt(i, q.matrix); });
  const plain = new THREE.Mesh(tall, treeMat); plain.position.set(0, 0, -2.5); plain.rotation.y = 0.6;
  for (const t of [inst, inst2, plain]) { t.castShadow = true; t.receiveShadow = true; }
  s.add(ground, inst, inst2, plain);
  return { scene: s, tree: plain };
}
const OFF = { trees: { clouds: false }, ground: { clouds: false } };
const CASES = {
  wind: { trees: { clouds: false, wind: 0.3 }, ground: { clouds: false } },
  clouds: { trees: {}, ground: {} },   // clouds default on, as in applyEffects
  season: { trees: { clouds: false, season: 'foliage' }, ground: { clouds: false, season: 'ground' } },
  // detail: each projection, the texture source and the blend modes; bump + roughness on a standard material (their slots need one)
  detailWorld: both({ detail: { noise: 'grain', scale: 1.5, strength: 0.9 } }),
  detailTriplanar: both({ detail: { noise: 'paper', projection: 'triplanar', scale: 2, strength: 0.9, mode: 'add', direction: 30, stretch: 2 } }),
  detailScreen: both({ detail: { noise: 'dabs', projection: 'screen', scale: 6, strength: 0.8, mode: 'mix', tint: 0xffd0a0 } }),
  detailTexture: both({ detail: { texture: checker(), scale: 1, strength: 0.7 } }),
  // bump at a scale where a stroke spans many pixels: finer, coarse vs fine screen derivatives (backend-chosen in WGSL) part the normals
  // (real WebGPU at scale 1.2: 2.7% of pixels); tests/fx compares the bump function itself by normal angle
  detailBump: { ...both({ detail: { noise: 'stroke', scale: 0.3, strength: 0, normal: 3, roughness: 0.9 } }), type: 'standard' },
  // lighting: wrap (direct light), shadowTint (ambient by the sun's shadow), rim (edge light); each alone, then all three
  lightWrap: { ...OFF, patches: () => [lightingPatch({ wrap: 0.8 })] },
  lightTint: { ...OFF, patches: () => [lightingPatch({ shadowTint: { color: 0x3050ff, strength: 0.9, soft: 0.4 } })] },
  lightRim: { ...OFF, patches: () => [lightingPatch({ rim: { color: 0xffc080, strength: 0.8, power: 2, shadowSide: 0.5 } })] },
  lightAll: { ...OFF, patches: () => [lightingPatch({ wrap: 0.5, shadowTint: { color: 0x3050ff, strength: 0.7 }, rim: { color: 0xffc080, strength: 0.5, power: 2 } })] },
};
/** The same applyEffects options on trees and ground, clouds off (so only this effect differs from OFF) */
function both(o) { return { trees: { clouds: false, ...o }, ground: { clouds: false, ...o } }; }
/** An 8x8 sRGB checker, the texture source of detail */
function checker() {
  const d = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) { const v = ((i % 8) + (i >> 3)) % 2 ? 230 : 40; d.set([v, v * 0.8, v * 0.6, 255], i * 4); }
  const t = new THREE.DataTexture(d, 8, 8); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}

/** The message of what f throws ('' when it does not), first line only */
const thrown = f => { try { f(); return ''; } catch (e) { return String(e?.message ?? e).split('\n')[0]; } };

window.fxPatches = async () => {
  const out = { cases: {} };
  out.base = diff(shotGL(vegetation('gl', OFF).scene, cam), await shotGPU(vegetation('gpu', OFF).scene, cam));
  for (const [name, fx] of Object.entries(CASES)) {
    const on = shotGL(vegetation('gl', fx).scene, cam), off = shotGL(vegetation('gl', OFF).scene, cam), tsl = await shotGPU(vegetation('gpu', fx).scene, cam);
    out.cases[name] = { parity: diff(on, tsl), effect: diff(on, off), mean: mean(tsl) };
  }

  out.water = await waterCases();
  out.clone = await cloneCase();

  // wind's shadow: WebGL keeps its depth / distance materials (unchanged), a NodeMaterial gets none (three's shadow pass reads positionNode)
  const tg = vegetation('gl', CASES.wind).tree, tn = vegetation('gpu', CASES.wind).tree;
  out.depth = { gl: !!tg.customDepthMaterial?.isMeshDepthMaterial && !!tg.customDistanceMaterial, gpu: tn.customDepthMaterial === undefined && tn.customDistanceMaterial === undefined,
    positionNode: !!tn.material.positionNode?.isNode };

  // errors by name
  const node = () => new TG.MeshLambertNodeMaterial();
  out.errors = {
    glslOnly: thrown(() => applyEffects(node(), { clouds: false, patches: [{ name: 'tint', slot: 'color', glsl: 'diffuseColor.rgb *= 0.5;' }] })),
    gameWind: thrown(() => applyEffects(node(), { clouds: false, wind: { amplitude: 0.2, glsl: 'void threedogWind(inout vec3 transformed, vec3 ip, vec3 position){}' } })),
    lightsPars: thrown(() => applyEffects(node(), { clouds: false, patches: [{ name: 'sunny', slot: 'lightsPars', tsl: c => c }] })),
    badCode: thrown(() => applyEffects(node(), { clouds: false, patches: [{ name: 'oops', slot: 'color', tsl: c => c.nope.mul(2) }] })),
    unlit: thrown(() => applyEffects(new TG.MeshBasicNodeMaterial(), { clouds: false, patches: [{ name: 'dark', slot: 'lighting', tsl: c => ({ directDiffuse: c.directDiffuse }) }] })),
  };
  // a failed patch leaves the material as it was (the list is rolled back)
  const keep = applyEffects(node(), { clouds: false, season: 'foliage' });
  thrown(() => applyEffects(keep, { clouds: false, patches: [{ name: 'oops', slot: 'color', tsl: c => c.nope.mul(2) }] }));
  out.rolledBack = (await import('../../render/patches.js')).materialPatches(keep).join(',');

  // two tsl patches on one slot run in the order added, each seeing the value so far: 0.6 -> x0.5 -> +0.25 = 0.55, the other way 0.425
  const half = { name: 'half', slot: 'color', tsl: c => c.tsl.vec4(c.color.rgb.mul(0.5), c.color.a) };
  const lift = { name: 'lift', slot: 'color', tsl: c => c.tsl.vec4(c.color.rgb.add(0.25), c.color.a) };
  const floorScene = mat => { const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), mat)); return s; };
  const px = b => b[(10 * W + W / 2) * 4];   // a floor pixel near the bottom middle, red channel
  const basic = () => new TG.MeshBasicNodeMaterial({ color: new THREE.Color(0.6, 0.6, 0.6) });
  out.order = {
    halfThenLift: px(await shotGPU(floorScene(applyEffects(basic(), { clouds: false, patches: [half, lift] })), cam)),
    liftThenHalf: px(await shotGPU(floorScene(applyEffects(basic(), { clouds: false, patches: [lift, half] })), cam)),
    // same two patches on the GLSL side, for the same numbers
    glsl: px(shotGL(floorScene(applyEffects(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.6, 0.6) }), { clouds: false, patches: [
      { name: 'halfGL', slot: 'color', glsl: 'diffuseColor.rgb *= 0.5;' }, { name: 'liftGL', slot: 'color', glsl: 'diffuseColor.rgb += 0.25;' }] })), cam)),
  };

  // lighting slot: a minimal patch (no direct light) and the hook form (the sun's light scaled from direct(), which also sees its shadow)
  const seen = { directional: false, shadow: false };
  const groundOnly = patches => vegetation('gpu', { trees: { clouds: false, patches }, ground: { clouds: false, patches } }).scene;
  const noDirect = { name: 'noDirect', slot: 'lighting', tsl: c => ({ directDiffuse: c.directDiffuse.mul(0) }) };
  const quarter = { name: 'quarterSun', slot: 'lighting', tsl: {
    start: c => { c.state.k = c.tsl.float(1).toVar('tdSunK'); },
    direct: (L, c) => { if (!L.directional) return; seen.directional = true; seen.shadow = !!L.shadow?.isNode; c.state.k.assign(0.25); },
    after: c => ({ directDiffuse: c.directDiffuse.mul(c.state.k) }),
  } };
  const plainLit = await shotGPU(groundOnly([]), cam), dark = await shotGPU(groundOnly([noDirect]), cam), q4 = await shotGPU(groundOnly([quarter]), cam);
  out.lighting = { plain: mean(plainLit), noDirect: mean(dark), quarter: mean(q4), ...seen };
  return out;
};

// water: the module's patches (waves, waterSurface, fresnel) copied onto a Phong material of each kind (fresnel lives in Water.js)
async function waterCases() {
  const out = {};
  const looks = {
    view: { depthColor: { shallow: 0x60c0d0, deep: 0x103050, by: 'view', curve: 1.5 }, foam: { start: 0.2, end: 0.6 } },
    wave: { depthColor: { shallow: 0x60c0d0, deep: 0x103050, by: 'wave' } },
    plain: {},   // waves + fresnel only (no surface patch)
  };
  const cam2 = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam2.position.set(0, 3, 9); cam2.lookAt(0, 0, -2); cam2.updateMatrixWorld();
  const flatWater = new THREE.PlaneGeometry(24, 24, 96, 96).rotateX(-Math.PI / 2);
  for (const [name, look] of Object.entries(looks)) {
    const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'fx-patches-water', urlState: false });
    e.use(water({ sea: false, flat: false }));
    e.water.shader(look);
    const U = e.water.uniforms; U.uWave.value = 1.6; U.uWaveScale.value = 4; U.uFresnel.value = 0.9;
    const src = e.water.material;
    const scene = (kind, patched) => {
      const s = new THREE.Scene();
      s.add(new THREE.HemisphereLight(0xbcd4ff, 0x404050, 1.2));
      const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(-4, 6, 3); s.add(sun, sun.target);
      const p = { color: 0x3070a0, shininess: 90, specular: 0xaaaaaa };
      const m = kind === 'gpu' ? new TG.MeshPhongNodeMaterial(p) : new THREE.MeshPhongMaterial(p);
      if (patched) copyPatches(src, m);
      s.add(new THREE.Mesh(flatWater, m));
      return s;
    };
    const on = shotGL(scene('gl', true), cam2), off = shotGL(scene('gl', false), cam2), tsl = await shotGPU(scene('gpu', true), cam2);
    out[name] = { parity: diff(on, tsl), effect: diff(on, off), mean: mean(tsl), patches: materialPatches(src).join(',') };
    e.dispose();
  }
  return out;
}

// clone: a patched NodeMaterial's clone() + copyPatches has each effect once (the chain is not taken as the clone's own value)
async function cloneCase() {
  const fx = { trees: { clouds: false, wind: 0.3, season: 'foliage', detail: { noise: 'grain', scale: 1.5, strength: 0.9 } },
    ground: { clouds: false, season: 'ground', detail: { noise: 'paper', scale: 1.5, strength: 0.9 } } };
  const orig = vegetation('gpu', fx), cl = vegetation('gpu', fx), bare = vegetation('gpu', fx), off = vegetation('gpu', OFF);
  const swap = (sc, f) => sc.traverse(o => { if (o.isMesh) o.material = f(o.material); });
  swap(cl.scene, m => copyPatches(m, m.clone()));
  swap(bare.scene, m => m.clone());   // no copyPatches: the plain material, as on the GLSL side
  const a = await shotGPU(orig.scene, cam), b = await shotGPU(cl.scene, cam), c = await shotGPU(bare.scene, cam), d = await shotGPU(off.scene, cam);
  // the clone's positionNode: its own chain, as many nodes as the original's (wrapped twice would be ~2x)
  const size = n => { let k = 0; n.traverse(() => k++); return k; };
  const m = orig.tree.material, k = copyPatches(m, m.clone());
  return { cloned: diff(a, b), bare: diff(c, d), effect: diff(a, d), nodes: [size(m.positionNode), size(k.positionNode)], own: k.positionNode !== m.positionNode };
}
