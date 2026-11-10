// GLSL vs TSL parity page (tests/specs/fx-parity.mjs): each engine shader function drawn by a hand-written material twice,
// GLSL (WebGLRenderer + #include <threedog_*>) and TSL (WebGPURenderer on its WebGL2 backend + threedog/tsl), same scene / camera / values.
// Why also measure on vs off: 0% parity could mean neither side applied the effect; a clear on/off difference shows the effect itself is compared.
// Why hand-written materials, not engine patches: this checks the function library itself (signatures, spaces, units); the patches' tsl field is the next step.
// Exceptions, where hand-writing the GLSL would mean copying it: lighting uses the real `lighting` patch on a Lambert material (its chunk needs three's
// light uniforms), water the real `waves` / `waterSurface` pars and lines (the surface function is generated per water shader).
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { Fn, float, vec3, vec4, positionGeometry, positionLocal, positionWorld, positionView, positionViewDirection, normalView, faceDirection,
  modelWorldMatrix, cameraPosition, normalize, abs, floor, diffuseColor, color } from 'three/tsl';
import * as pub from 'threedog/tsl';
import { createEngine } from '../../index.js';
import { bindUniforms } from '../../render/engineUniforms.js';
import { wind, cloudShadow, season, objectOrigin, instanceOffset, uniforms, detailNoise, detailBump, wrapDiffuse, shadowTint, rim,
  waterWave, waterSurface, waterFresnel } from '../../render/fx/index.js';
import { applyEffects } from '../../render/materials.js';
import { lightingPatch } from '../../render/lighting.js';
import { waterShader, wavesPatch, surfacePatch } from '../../modules/water/surface.js';
import pixelmatch from './pixelmatch.js';

const W = 160, H = 120, AMP = 0.3;
const mk = (opts = {}) => createEngine({ canvas: opts.canvas || document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: opts.key || 'test-fx', urlState: false });
const engine = window.engine = mk();
await engine.start();
engine.haltLoop();

// ---------- the hand-written materials ----------
// GLSL: the same {value} objects as engine.uniforms (no copy), the callable chunks of render/effects.js, defines FX on / off
const VERT = `#include <threedog_uniforms>
#include <threedog_wind>
varying float vY; varying vec3 vWorld;
void main(){
  vec3 p = position;
  #ifdef FX_WIND
  { vec4 o = vec4(0.0, 0.0, 0.0, 1.0);
    #ifdef USE_INSTANCING
    o = instanceMatrix * o;
    #endif
    p += threedogWind(position, (modelMatrix * o).xyz, ${AMP.toFixed(2)}); }
  #endif
  vec4 mp = vec4(p, 1.0);
  #ifdef USE_INSTANCING
  mp = instanceMatrix * mp;
  #endif
  vY = position.y; vWorld = (modelMatrix * mp).xyz;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * mp;
}`;
const FRAG = `#include <threedog_uniforms>
#include <threedog_cloudShadow>
#include <threedog_season>
uniform vec3 uBase; varying float vY; varying vec3 vWorld;
void main(){
  vec3 c = uBase + vec3(0.15 * vY, 0.0, 0.0);
  #ifdef FX_CLOUD
  c *= threedogCloudShadow(vWorld);
  #endif
  #ifdef FX_SEASON
  c = threedogSeason(c, SEASON_KIND);
  #endif
  gl_FragColor = vec4(c, 1.0);
}`;
const glslMat = (U, base, fx, kind = 0) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG,
  uniforms: { ...U, uBase: { value: new THREE.Color(...base) } },
  defines: { ...(fx ? { [`FX_${fx}`]: 1 } : {}), SEASON_KIND: kind } });
// TSL: the same picture from threedog/tsl (positionGeometry = GLSL `position`; the offset goes through the instance basis like GLSL adds it before instanceMatrix)
const tslMat = (base, fx, kind = 0) => {
  const m = new TG.MeshBasicNodeMaterial();
  if (fx === 'WIND') m.positionNode = positionLocal.add(instanceOffset(wind(positionGeometry, objectOrigin(), float(AMP))));
  m.colorNode = Fn(() => {
    let c = vec3(...base).add(vec3(positionGeometry.y.mul(0.15), 0, 0));
    if (fx === 'CLOUD') c = c.mul(cloudShadow(positionWorld));
    if (fx === 'SEASON') c = season(c, kind);
    return c;
  })();
  return m;
};

// ---------- scenes: one per function ----------
const tall = new THREE.BoxGeometry(0.6, 3, 0.6, 1, 10, 1).translate(0, 1.5, 0);
function windScene(mat) {
  const s = new THREE.Scene(), inst = new THREE.InstancedMesh(tall, mat, 4), q = new THREE.Object3D();
  [[-3, 0, 0.3, 1], [-1, 1, 1.1, 0.8], [1, -1, 2.0, 1.2], [3, 0.5, -0.7, 1]].forEach(([x, z, ry, sc], i) => {
    q.position.set(x, 0, z); q.rotation.set(0, ry, 0.1 * i); q.scale.set(sc, sc * 1.1, sc); q.updateMatrix(); inst.setMatrixAt(i, q.matrix); });
  // a second InstancedMesh on the same material: the E2 port read one mesh's instance buffer, so this one would sway with the first one's origins
  const inst2 = new THREE.InstancedMesh(tall, mat, 2);
  [[-4.5, 2.5, 0.9], [4.5, 2.5, -1.3]].forEach(([x, z, ry], i) => { q.position.set(x, 0, z); q.rotation.set(0, ry, 0); q.scale.setScalar(0.9); q.updateMatrix(); inst2.setMatrixAt(i, q.matrix); });
  const plain = new THREE.Mesh(tall, mat); plain.position.set(0, 0, -2.5); plain.rotation.y = 0.6;
  s.add(inst, inst2, plain);
  return s;
}
function groundScene(mat, extra) {
  const s = new THREE.Scene(), g = new THREE.Mesh(new THREE.PlaneGeometry(20, 20, 4, 4).rotateX(-Math.PI / 2), mat);
  s.add(g);
  if (extra) { const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0), extra); s.add(b); }
  return s;
}
// ---------- detail: the noise as color (each kind), the bump as a Lambert normalNode ----------
const DETAIL_SCALE = 1.5, DETAIL_OCT = 3, BUMP = 1.5;   // 3 octaves: fbm breaks out of its 4-step loop, dabs runs all 3
const DETAIL_FRAG = `#include <threedog_detail>
uniform vec3 uBase; varying vec3 vWorld;
void main(){
  vec3 c = uBase;
  #ifdef FX_DETAIL
  c *= 0.5 + threedogDetailNoise(vWorld.xz * ${DETAIL_SCALE.toFixed(2)}, DETAIL_KIND, ${DETAIL_OCT.toFixed(1)}).rgb;
  #endif
  gl_FragColor = vec4(c, 1.0);
}`;
const detailGLSL = (kind, on) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: DETAIL_FRAG,
  uniforms: { ...engine.uniforms, uBase: { value: new THREE.Color(0.6, 0.5, 0.4) } }, defines: { ...(on ? { FX_DETAIL: 1 } : {}), DETAIL_KIND: kind } });
const detailTSL = kind => Object.assign(new TG.MeshBasicNodeMaterial(), {
  colorNode: vec3(0.6, 0.5, 0.4).mul(detailNoise(positionWorld.xz.mul(DETAIL_SCALE), kind, DETAIL_OCT).rgb.add(0.5)) });
// The shared hash / value noise drawn raw (gray = 0.6 * (0.5 + value)), so their own value range is measured and compared, not only through detail.
// 'hash' feeds cells (floor); 'hashFract' fractional inputs, fine cells times FRACT_STEP: 27 of them share one integer cell, so a per-cell
// hash would draw flat blocks, while the 1.0 contract (any vec2 in, a value per input) changes value from one fine cell to the next.
// Why not a raw position: a varying differs in its last bits between WebGL and WebGPU (real WebGPU: 24% of pixels), and a hash of the bits
// is exact only for the same floats; a cell times a constant is one correctly rounded multiply, the same float on both.
const FRACT_STEP = 0.0371;
const RAW_FRAG = `#include <threedog_noise>
varying vec3 vWorld;
void main(){
  float n = 0.0;
  #ifdef FX_RAW
  n = RAW_KIND == 0 ? threedogNoise(vWorld.xz * ${DETAIL_SCALE.toFixed(2)}) : RAW_KIND == 1 ? threedogHash(floor(vWorld.xz * ${(DETAIL_SCALE * 4).toFixed(2)}))
    : threedogHash(floor(vWorld.xz * 8.0) * ${FRACT_STEP});
  #endif
  gl_FragColor = vec4(vec3(0.6 * (0.5 + n)), 1.0);
}`;
const rawGLSL = (kind, on) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: RAW_FRAG, uniforms: { ...engine.uniforms },
  defines: { ...(on ? { FX_RAW: 1 } : {}), RAW_KIND: kind } });
const rawTSL = kind => Object.assign(new TG.MeshBasicNodeMaterial(), {
  colorNode: vec3((kind === 0 ? pub.noise(positionWorld.xz.mul(DETAIL_SCALE)) : kind === 1 ? pub.hash(floor(positionWorld.xz.mul(DETAIL_SCALE * 4)))
    : pub.hash(floor(positionWorld.xz.mul(8)).mul(FRACT_STEP))).add(0.5).mul(0.6)) });
// The bump compared by its normal, not by a lit color: the two backends take screen-space derivatives differently (WGSL leaves dpdx coarse or
// fine to the device), and a lit color turns a degree of normal difference into a pixel difference. Normal drawn as color (n * 0.5 + 0.5).
// At BUMP_SCALE a pattern cell spans tens of pixels, as on a live bump (the detail patch fades the bump out where a cell nears a pixel); at
// DETAIL_SCALE the finest octave is 2 pixels wide and coarse vs fine derivatives of it disagree everywhere (real WebGPU: 61% over 10 degrees).
const BUMP_SCALE = 0.25;
const NORMAL_VERT = `varying vec3 vVP; varying vec3 vN; varying vec3 vWorld;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vVP = -mv.xyz; vN = normalMatrix * normal;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * mv; }`;
const NORMAL_FRAG = `#include <threedog_detail>
varying vec3 vVP; varying vec3 vN; varying vec3 vWorld;
void main(){
  vec3 n = normalize(vN);
  #ifdef FX_BUMP
  n = threedogDetailBump(-vVP, n, threedogDetailNoise(vWorld.xz * ${BUMP_SCALE.toFixed(2)}, 0, ${DETAIL_OCT.toFixed(1)}).a, ${BUMP.toFixed(2)}, gl_FrontFacing ? 1.0 : -1.0);
  #endif
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;
const normalGLSL = on => new THREE.ShaderMaterial({ vertexShader: NORMAL_VERT, fragmentShader: NORMAL_FRAG, defines: on ? { FX_BUMP: 1 } : {} });
const normalTSL = () => Object.assign(new TG.MeshBasicNodeMaterial(), {
  colorNode: detailBump(positionView, normalView, detailNoise(positionWorld.xz.mul(BUMP_SCALE), 0, DETAIL_OCT).a, BUMP, faceDirection).mul(0.5).add(0.5) });
// ---------- lighting: wrap / shadowTint / rim on a shadowed Lambert scene ----------
// GLSL: the engine's real `lighting` patch (it calls the callable chunk). TSL: the lighting slot as E2 found it (experiments/webgpu/e2/tsl/lightingSlot.js):
// wrap the material's LightingModel, capture the sun in direct(), shape reflectedLight at the end of start() (= lights_fragment_end).
const LIT = { wrap: { wrap: 0.6 }, shadowTint: { shadowTint: { color: 0x3355ff, strength: 1, soft: 0.6 } },
  rim: { rim: { color: 0xffcc88, strength: 0.9, power: 2, shadowSide: 0.5 } } };
function extendLighting(mat, hooks) {
  const base = mat.setupLightingModel;
  mat.setupLightingModel = function (builder) {
    const model = base.call(this, builder), state = {}, { start, direct } = model;
    model.start = function (b) { hooks.start(state); start.call(this, b); hooks.after(b.context.reflectedLight, state); };
    model.direct = function (data, b) { const r = direct.call(this, data, b); hooks.direct(data, state); return r; };
    return model;
  };
  return mat;
}
function litTSL(o) {
  const m = new TG.MeshLambertNodeMaterial({ color: 0xc8b090 }), st = o.shadowTint, r = o.rim;
  return extendLighting(m, {
    start(s) { s.nl = float(0).toVar(); s.shadow = float(1).toVar(); s.seen = false; },
    direct({ lightNode, lightDirection, lightColor, reflectedLight }, s) {
      if (s.seen || !lightNode?.light?.isDirectionalLight) return;
      s.seen = true; s.nl.assign(normalView.dot(lightDirection));
      if (lightNode.shadowNode) s.shadow.assign(lightNode.shadowNode.x);
      // lightColor here already carries the shadow, so shadow = 1 (GLSL passes the unshadowed color and the shadow apart)
      if (o.wrap !== undefined) reflectedLight.directDiffuse.addAssign(wrapDiffuse(s.nl, float(o.wrap), lightColor, float(1), diffuseColor.rgb));
    },
    after(rl, s) {
      if (!s.seen) return;
      if (st) rl.indirectDiffuse.assign(shadowTint(rl.indirectDiffuse, color(st.color), float(st.strength), float(st.soft), s.nl, s.shadow));
      if (r) rl.indirectDiffuse.addAssign(rim(normalView, positionViewDirection, color(r.color), float(r.strength), float(r.power), float(r.shadowSide), s.nl));
    },
  });
}
const litGLSL = o => { const m = new THREE.MeshLambertMaterial({ color: 0xc8b090 }); if (o) applyEffects(m, { clouds: false, patches: [lightingPatch(o)] }); return m; };
function litScene(mat) {
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(0xbcd0ff, 0x554433, 0.8));
  const sun = new THREE.DirectionalLight(0xffeedd, 2.2); sun.position.set(-5, 8, 3); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 }); sun.shadow.mapSize.set(512, 512); sun.shadow.bias = -0.002;
  s.add(sun, sun.target);
  const g = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), mat); g.receiveShadow = true;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 16), mat); ball.position.set(-1.5, 1.4, 0);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 1.6), mat); box.position.set(2, 1.2, -0.5); box.rotation.y = 0.5;
  for (const o of [ball, box]) { o.castShadow = o.receiveShadow = true; s.add(o); }
  s.add(g);
  return s;
}

// ---------- water: waves (vertex), waterSurface (depthColor / foam), fresnel ----------
// GLSL: the real `waves` / `waterSurface` pars and lines from modules/water/surface.js; the fresnel line as Water.js writes it (inline there)
const WAVES = { waveHeight: 3, waveScale: 2, waveSpeed: 1 };
const WATER_SHADERS = { wave: { depthColor: { shallow: 0x55ddcc, deep: 0x103060, by: 'wave', curve: 1.3 }, foam: { color: 0xffffff, start: 0.4, end: 0.8, opacity: 0.9 } },
  view: { depthColor: { shallow: 0x66ddbb, deep: 0x081840, curve: 0.8 } } };
const FRESNEL = 0.9, FRES_TO = new THREE.Color(0.85, 0.8, 0.95);
function waterGLSL(fx, shaderName) {
  const shader = waterShader(shaderName ? WATER_SHADERS[shaderName] : {}), surf = fx === 'SURFACE' ? surfacePatch(engine, shader) : null;
  const waves = wavesPatch(engine, { uWave: { value: WAVES.waveHeight }, uWaveScale: { value: WAVES.waveScale }, uWaveSpeed: { value: WAVES.waveSpeed } }, shader, !!surf);
  const vert = `${waves.pars}
varying vec3 vN; varying vec3 vVP; varying float vH;
void main(){
  vec3 transformed = position;
  #ifdef FX_WAVES
  ${waves.glsl}
  #endif
  vH = (modelMatrix * vec4(transformed, 1.0)).y;
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0); vVP = -mv.xyz; vN = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;
  const frag = `${surf ? surf.pars : ''}
uniform vec3 uBase; uniform float uFresnel; uniform vec3 uFresnelColor; varying vec3 vN; varying vec3 vVP; varying float vH;
void main(){
  vec4 diffuseColor = vec4(uBase + vec3(0.0, 0.0, 0.8 * vH), 0.8);
  ${surf ? surf.glsl : ''}
  vec3 outgoingLight = diffuseColor.rgb; vec3 normal = normalize(vN);
  #ifdef FX_FRESNEL
  float threedogFres = pow(1.0 - abs(dot(normalize(vVP), normal)), 3.0) * uFresnel;
  outgoingLight = mix(outgoingLight, uFresnelColor, clamp(threedogFres, 0.0, 1.0));
  #endif
  gl_FragColor = vec4(outgoingLight, diffuseColor.a);
}`;
  // transparent on both sides: an opaque NodeMaterial writes alpha 1 whatever its color's alpha is (an opaque ShaderMaterial writes it as is),
  // and foam raises the opacity, so blending over the black clear color is how the alpha gets compared at all
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true,
    uniforms: { ...waves.uniforms, ...surf?.uniforms, uBase: { value: new THREE.Color(0.1, 0.3, 0.4) }, uFresnel: { value: FRESNEL }, uFresnelColor: { value: FRES_TO } },
    defines: { ...(fx !== null ? { FX_WAVES: 1 } : {}), ...(fx === 'FRESNEL' ? { FX_FRESNEL: 1 } : {}) } });
}
function waterTSL(fx, shaderName) {
  const t = uniforms(engine).uTime;
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz.mul(WAVES.waveScale);
  const h = waterWave(wp, t.mul(WAVES.waveSpeed)).toVarying();   // a varying like GLSL vThreedogWave (interpolated, not re-evaluated per pixel)
  const m = new TG.MeshBasicNodeMaterial({ transparent: true });
  m.positionNode = positionLocal.add(vec3(0, h.mul(WAVES.waveHeight), 0));
  m.colorNode = Fn(() => {
    let c = vec4(vec3(0.1, 0.3, 0.4).add(vec3(0, 0, positionWorld.y.mul(0.8))), 0.8);
    if (fx === 'SURFACE') {
      const L = WATER_SHADERS[shaderName];
      c = waterSurface({ depth: L.depthColor, foam: L.foam })(c, h, abs(normalize(cameraPosition.sub(positionWorld)).y), positionWorld, t);
    }
    if (fx === 'FRESNEL') c = vec4(waterFresnel(c.rgb, normalView, positionViewDirection, float(FRESNEL), color(FRES_TO)), c.a);
    return c;
  })();
  return m;
}
const waterScene = mat => { const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.PlaneGeometry(30, 30, 90, 90).rotateX(-Math.PI / 2), mat)); return s; };

const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200); cam.position.set(0, 6, 11); cam.lookAt(0, 1, 0); cam.updateMatrixWorld();

// ---------- renderers ----------
const canvas = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const gl = new THREE.WebGLRenderer({ canvas: canvas(), antialias: false });
gl.setPixelRatio(1); gl.setSize(W, H, false); gl.toneMapping = THREE.NoToneMapping; gl.outputColorSpace = THREE.LinearSRGBColorSpace;
// shadows on both sides for the lighting cases (the unlit cases have no lights, so no shadow pass runs for them); PCF as the engine uses
gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFShadowMap;
const glRT = new THREE.WebGLRenderTarget(W, H);
async function gpuRenderer(U) {
  const r = new TG.WebGPURenderer({ canvas: canvas(), antialias: false, forceWebGL: true });
  r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
  await r.init();
  // several bare renderers side by side (no engine around each): bind them to the engine's uniforms by hand, as the engine does for its own
  if (U) bindUniforms(r, U);
  return r;
}
const gpuRT = new TG.RenderTarget(W, H);
const shotGL = scene => { gl.setRenderTarget(glRT); gl.setClearColor(0x000000, 1); gl.render(scene, cam); const b = new Uint8Array(W * H * 4);
  gl.readRenderTargetPixels(glRT, 0, 0, W, H, b); gl.setRenderTarget(null); return b; };
const shotGPU = async (r, scene) => { r.setRenderTarget(gpuRT); r.setClearColor(0x000000, 1); r.render(scene, cam);
  const b = new Uint8Array(await r.readRenderTargetPixelsAsync(gpuRT, 0, 0, W, H)); r.setRenderTarget(null); return b; };
/** share of pixels pixelmatch (threshold 0.1) calls different, in % */
const diff = (a, b) => +(100 * pixelmatch(a, b, null, W, H, { threshold: 0.1 }) / (W * H)).toFixed(3);
/** mean / std of the drawn value (R = 255 * 0.6 * (0.5 + value)) over the drawn pixels: the noise's own range, before vs after a change */
const stats = a => { let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < a.length; i += 4) { if (a[i] + a[i + 1] + a[i + 2] <= 30) continue; const v = a[i] / 255 / 0.6 - 0.5; n++; s += v; s2 += v * v; }
  const m = s / n; return { mean: +m.toFixed(3), std: +Math.sqrt(s2 / n - m * m).toFixed(3) }; };
/** Angle between two normal pictures (n * 0.5 + 0.5) per drawn pixel: share over ANGLE_LIMIT degrees in %, median and 99th percentile in degrees */
const ANGLE_LIMIT = 10;
const angles = (a, b) => { const d = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] + a[i + 1] + a[i + 2] <= 30 || b[i] + b[i + 1] + b[i + 2] <= 30) continue;
    const u = [0, 1, 2].map(k => a[i + k] / 127.5 - 1), v = [0, 1, 2].map(k => b[i + k] / 127.5 - 1);
    const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.hypot(...u) / Math.hypot(...v);
    d.push(Math.acos(Math.min(1, Math.max(-1, c))) * 180 / Math.PI);
  }
  d.sort((x, y) => x - y);
  return { over: +(100 * d.filter(x => x > ANGLE_LIMIT).length / Math.max(1, d.length)).toFixed(3), p50: +(d[Math.floor(d.length * 0.5)] ?? 0).toFixed(2), p99: +(d[Math.floor(d.length * 0.99)] ?? 0).toFixed(2), px: d.length }; };
/** share of drawn pixels (%) whose red equals the pixel to their right: ~100 for flat blocks, ~1 for a value per pixel */
const same = a => { let n = 0, k = 0;
  for (let i = 0; i < a.length - 4; i += 4) { if ((i / 4) % W === W - 1 || a[i] + a[i + 1] + a[i + 2] <= 30 || a[i + 4] + a[i + 5] + a[i + 6] <= 30) continue; n++; if (a[i] === a[i + 4]) k++; }
  return +(100 * k / n).toFixed(2); };
const lit = a => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2] > 30) n++; return +(n / (W * H)).toFixed(2); };

/** Set the engine values each case needs (clouds strong and small enough to vary across the ground, a season tint in both modes) */
function setValues(U, w = 1) {
  U.uTime.value = 1.7; U.uWind.value = w; U.uWindFreq.value = 1; U.uWindAmp.value = 1;
  U.uWeatherCloud.value = 0.5; U.uCloudShadow.value = 0.8; U.uCloudShadowScale.value = 0.35; U.uCloudShadowSpeed.value.set(0.4, 0.2);
  U.uGroundTint.value.setRGB(0.9, 0.6, 0.3); U.uGroundMix.value = 0; U.uFoliageTint.value.setRGB(0.8, 0.3, 0.1); U.uFoliageMix.value = 0.5;
}

// Structure of the hash over whole-number cells (one cell per pixel, cells -256..255): neighbor correlation along x, y and the diagonal.
// Why: mean / std and parity cannot see stripes (both backends draw the same ones); a correlated hash shows here. GLSL only: parity covers TSL.
function hashStructure() {
  const N = 512, rt = new THREE.WebGLRenderTarget(N, N), q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const sc = new THREE.Scene(); sc.add(q);
  const out = {};
  for (const [k, expr] of [['bits', 'threedogHash(c)'], ['cell', 'threedogHashStep(threedogHashCell(c))']]) {
    q.material = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `#include <threedog_noise>
void main(){ vec2 c = floor(gl_FragCoord.xy) - 256.0; gl_FragColor = vec4(vec3(${expr}), 1.0); }` });
    gl.setRenderTarget(rt); gl.render(sc, oc); const b = new Uint8Array(N * N * 4); gl.readRenderTargetPixels(rt, 0, 0, N, N, b); gl.setRenderTarget(null);
    const v = (x, y) => b[(y * N + x) * 4];
    const corr = (dx, dy) => { let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
      for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) { const a = v(x, y), c = v(x + dx, y + dy); sa += a; sb += c; sab += a * c; saa += a * a; sbb += c * c; n++; }
      return +((sab / n - sa / n * sb / n) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2))).toFixed(4); };
    out[k] = { x: corr(1, 0), y: corr(0, 1), d: corr(1, 1) };
    q.material.dispose();
  }
  rt.dispose();
  return out;
}

window.fxParity = async () => {
  const U = engine.uniforms, out = { cases: {}, stats: {}, structure: hashStructure() };
  setValues(U);
  const gpu = await gpuRenderer(U);
  const CASES = {
    wind: fx => windScene(fx === 'tsl' ? tslMat([0.2, 0.5, 0.3], 'WIND') : glslMat(U, [0.2, 0.5, 0.3], fx ? 'WIND' : null)),
    cloudShadow: fx => groundScene(fx === 'tsl' ? tslMat([0.5, 0.7, 0.4], 'CLOUD') : glslMat(U, [0.5, 0.7, 0.4], fx ? 'CLOUD' : null)),
    season: fx => groundScene(fx === 'tsl' ? tslMat([0.5, 0.7, 0.4], 'SEASON', 1) : glslMat(U, [0.5, 0.7, 0.4], fx ? 'SEASON' : null, 1),
      fx === 'tsl' ? tslMat([0.3, 0.6, 0.2], 'SEASON', 0) : glslMat(U, [0.3, 0.6, 0.2], fx ? 'SEASON' : null, 0)),
    ...Object.fromEntries(['grain', 'paper', 'stroke', 'dabs'].map((k, kind) => ['detailNoise.' + k,
      fx => groundScene(fx === 'tsl' ? detailTSL(kind) : detailGLSL(kind, fx))])),
    noise: fx => groundScene(fx === 'tsl' ? rawTSL(0) : rawGLSL(0, fx)),
    hash: fx => groundScene(fx === 'tsl' ? rawTSL(1) : rawGLSL(1, fx)),
    hashFract: fx => groundScene(fx === 'tsl' ? rawTSL(2) : rawGLSL(2, fx)),
    ...Object.fromEntries(Object.entries(LIT).map(([k, o]) => ['lighting.' + k, fx => litScene(fx === 'tsl' ? litTSL(o) : litGLSL(fx ? o : null))])),
    waterWave: fx => waterScene(fx === 'tsl' ? waterTSL('WAVES') : waterGLSL(fx ? 'WAVES' : null)),
    'waterSurface.wave': fx => waterScene(fx === 'tsl' ? waterTSL('SURFACE', 'wave') : waterGLSL(fx ? 'SURFACE' : 'WAVES', 'wave')),
    'waterSurface.view': fx => waterScene(fx === 'tsl' ? waterTSL('SURFACE', 'view') : waterGLSL(fx ? 'SURFACE' : 'WAVES', 'view')),
    waterFresnel: fx => waterScene(fx === 'tsl' ? waterTSL('FRESNEL') : waterGLSL(fx ? 'FRESNEL' : 'WAVES')),
  };
  for (const [name, make] of Object.entries(CASES)) {
    const on = shotGL(make(true)), off = shotGL(make(false)), tsl = await shotGPU(gpu, make('tsl'));
    out.cases[name] = { parity: diff(on, tsl), effect: diff(on, off), lit: lit(tsl) };
    if (/^(noise|hash|detailNoise)/.test(name)) out.stats[name] = { gl: stats(on), tsl: stats(tsl) };
    if (name === 'hashFract') out.stats[name].same = same(on);
  }
  // detailBump: the bumped normal on both sides, compared by angle
  const nOn = shotGL(litScene(normalGLSL(true))), nOff = shotGL(litScene(normalGLSL(false))), nTsl = await shotGPU(gpu, litScene(normalTSL()));
  out.bump = { ...angles(nOn, nTsl), effect: angles(nOn, nOff).over };

  // a value changed on engine.uniforms reaches both sides (no second copy): wind 1 -> 2.5, same materials, drawn again
  const glWind = windScene(glslMat(U, [0.2, 0.5, 0.3], 'WIND')), gpuWind = windScene(tslMat([0.2, 0.5, 0.3], 'WIND'));
  const before = await shotGPU(gpu, gpuWind);
  U.uWind.value = 2.5;
  const glAfter = shotGL(glWind), gpuAfter = await shotGPU(gpu, gpuWind);
  out.sync = { moved: diff(before, gpuAfter), parity: diff(glAfter, gpuAfter) };
  setValues(U);
  // the water reads engine.uniforms.uTime the same way: time moved on the engine, both pictures move together
  const glSea = waterScene(waterGLSL('SURFACE', 'wave')), gpuSea = waterScene(waterTSL('SURFACE', 'wave'));
  const seaBefore = await shotGPU(gpu, gpuSea);
  U.uTime.value = 4.2;
  const seaGL = shotGL(glSea), seaGPU = await shotGPU(gpu, gpuSea);
  out.waterSync = { moved: diff(seaBefore, seaGPU), parity: diff(seaGL, seaGPU) };
  setValues(U);

  // two engines on one page: the SAME TSL material drawn by renderers of two engines reads each engine's own wind
  const engine2 = mk({ canvas: canvas(), key: 'test-fx-2' }), U2 = engine2.uniforms;
  setValues(U2, 2.5);
  const gpu2 = await gpuRenderer(U2), shared = windScene(tslMat([0.2, 0.5, 0.3], 'WIND'));
  const a1 = await shotGPU(gpu, shared), a2 = await shotGPU(gpu2, shared), g2 = shotGL(windScene(glslMat(U2, [0.2, 0.5, 0.3], 'WIND')));
  out.twoEngines = { apart: diff(a1, a2), parity2: diff(g2, a2), cached: uniforms(engine) === uniforms(engine), own: uniforms(engine).uWind !== uniforms(engine2).uWind };

  // a renderer with no engine: the Fn says so by code instead of drawing with no wind. three catches errors thrown while it builds
  // a node graph and prints them as "THREE.TSL: Error: ..." (console.error), so that print is where the code shows up
  const lone = await gpuRenderer(null), said = [], ce = console.error;
  console.error = (...a) => { said.push(a.map(String).join(' ')); ce.apply(console, a); };
  try { lone.render(windScene(tslMat([0.2, 0.5, 0.3], 'WIND')), cam); out.unbound = said.length ? said[0].split('\n')[0] : 'no error'; }
  catch (e) { out.unbound = String(e.message || e); }
  finally { console.error = ce; }

  // threedog/tsl (package exports) is this same module, not a second copy with its own uniform cache
  const lib = { wind, cloudShadow, season, objectOrigin, uniforms, detailNoise, detailBump, wrapDiffuse, shadowTint, rim, waterWave, waterSurface, waterFresnel };
  out.subpath = Object.keys(lib).every(k => pub[k] === lib[k]);
  for (const r of [gpu, gpu2, lone]) r.dispose();
  engine2.dispose();
  return out;
};
