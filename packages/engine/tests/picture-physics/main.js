// Picture physics page (tests/specs/picture-physics.mjs): pixels held against answers physics knows, not against an earlier picture.
// Why: the other picture tests compare a picture with itself (an effect on and off), so light the engine adds or loses on top of three.js
// passes them as long as it does so every time. Here a white sphere in a uniform white world must vanish (white furnace), baked probes plus the
// environment they were baked from must read twice the light (and litTwice() must say so), and a plane under one sun must read the BRDF by hand.
// Both renderers: WebGPURenderer (its WebGL2 backend in ordinary runs, node materials) and WebGLRenderer. Every read is linear: a float target,
// tone mapping off, drawn by engine.renderOnce(target, camera), which skips the post chain (three's plain draw into a target).
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';   // the WebGPU route needs it loaded (webgpu-needs-tsl)
import { createEngine } from '../../index.js';
import { litTwice } from '../../core/inspect/pictureChecks.js';

const S = 64;   // square view: the sphere's disc is a circle in pixels
const L = 0.5;  // the environment's radiance: below 1 so a gain is not hidden by anything that clamps
const ALBEDO = 0.8, SUN = 1.5, THETA = Math.PI / 3;   // the analytic plane: albedo, light intensity, angle from the normal

/** an environment of one radiance in every direction: a small half-float panorama (0.5 is exact there), which both renderers turn into their
 *  own PMREM. Half, not full float: WebGLRenderer turns an equirect background into a cube target of the texture's own type, and a 32-bit float
 *  cube with linear filtering needs OES_texture_float_linear, which software rendering lacks (the background read 0 there) */
function uniformEnv() {
  const w = 16, h = 8, d = new Uint16Array(w * h * 4), half = THREE.DataUtils.toHalfFloat(L), one = THREE.DataUtils.toHalfFloat(1);
  for (let i = 0; i < d.length; i += 4) d.set([half, half, half, one], i);
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

/** one engine per renderer, lights: false (the game writes its own light), tone mapping off */
async function side(kind) {
  const canvas = Object.assign(document.createElement('canvas'), { width: S, height: S });
  document.body.appendChild(canvas);
  const renderer = kind === 'gpu' ? new TG.WebGPURenderer({ canvas, antialias: false, forceWebGL: true }) : undefined;
  const e = createEngine({ ...(renderer ? { renderer } : { canvas }), pixelRatio: 1, adaptiveResolution: false, lights: false, ui: { loading: false }, saveKey: 'test-picture-physics-' + kind, urlState: false });
  await e.start(); e.haltLoop();
  const r = /** @type {any} */ (e.renderer);
  r.toneMapping = THREE.NoToneMapping; r.toneMappingExposure = 1;
  const gpu = !!r.isWebGPURenderer;
  const rt = gpu ? new TG.RenderTarget(S, S, { type: THREE.FloatType }) : new THREE.WebGLRenderTarget(S, S, { type: THREE.FloatType });
  const buf = new Float32Array(S * S * 4);
  /** every pixel, RGBA: the checks read all three colour channels, so a lost or doubled channel fails as a wrong value */
  const read = async (/** @type {THREE.Camera} */ cam) => {
    e.renderOnce(rt, cam);
    if (gpu) return new Float32Array(await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S));
    r.readRenderTargetPixels(rt, 0, 0, S, S, buf);
    return buf.slice();
  };
  return { e, r, gpu, read, done: () => { e.dispose(); rt.dispose(); canvas.remove(); } };
}

const r4 = (/** @type {number} */ v) => +v.toFixed(4);
/** sphere of radius 1 seen by an orthographic camera spanning +-1.25: every channel of the pixels inside 0.95 of the disc (min / max / mean, so a
 *  light that is right on average but wrong across the sphere shows in min / max), and the largest gap between channels anywhere */
function discStats(/** @type {Float32Array} */ px) {
  const inside = [];
  let grey = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, wx = ((x + 0.5) / S * 2 - 1) * 1.25, wy = ((y + 0.5) / S * 2 - 1) * 1.25, d = Math.hypot(wx, wy);
    grey = Math.max(grey, Math.abs(px[i] - px[i + 1]), Math.abs(px[i] - px[i + 2]));
    if (d < 0.95) inside.push(px[i], px[i + 1], px[i + 2]);
  }
  const mean = (/** @type {number[]} */ a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { mean: r4(mean(inside)), min: r4(Math.min(...inside)), max: r4(Math.max(...inside)), grey: r4(grey) };
}

/** three's own direct-light BRDF for a flat surface, by hand. Physically correct lights (the only kind since r155): irradiance = intensity * cos(theta).
 *  Lambert: albedo / pi. Standard (RE_Direct_Physical of three 0.187): the diffuse keeps only what the specular interface passes on, albedo / pi *
 *  (1 - F) (glTF fresnel_mix), plus BRDF_GGX: Schlick Fresnel in its exp2 form, height-correlated Smith visibility, GGX distribution, alpha = roughness^2.
 *  Left out: the specular's multiple-scattering factor 1 + F0 (1 / Ess - 1), which reads a LUT; at F0 0.04 it moves this plane by under 0.3 % (measured 0.16 % at roughness 1) */
function analytic({ albedo, roughness, metalness, standard, view = [0, 1, 0] }) {
  const n = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(...view).normalize(), l = new THREE.Vector3(Math.sin(THETA), Math.cos(THETA), 0), h = l.clone().add(v).normalize();
  const nl = n.dot(l), nv = n.dot(v), nh = n.dot(h), vh = v.dot(h), irradiance = SUN * nl;
  const diffuse = albedo * (1 - metalness) / Math.PI;
  if (!standard) return irradiance * diffuse;
  const a2 = roughness ** 4, f0 = 0.04 * (1 - metalness) + albedo * metalness;
  const fres = 2 ** ((-5.55473 * vh - 6.98316) * vh), F = f0 * (1 - fres) + fres;
  const gv = nl * Math.sqrt(a2 + (1 - a2) * nv * nv), gl = nv * Math.sqrt(a2 + (1 - a2) * nl * nl), V = 0.5 / (gv + gl);
  const D = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2);
  return irradiance * (diffuse * (1 - F) + F * V * D);
}

async function measure(/** @type {any} */ s, kind) {
  const { e, read } = s, scene = e.scene, out = /** @type {any} */ ({ kind, gpu: s.gpu });
  const env = uniformEnv();
  scene.environment = env; scene.environmentIntensity = 1;
  scene.background = env; scene.backgroundIntensity = 1; scene.backgroundBlurriness = 0; scene.fog = null;
  out.lights = []; scene.traverse(o => { if (/** @type {any} */ (o).isLight) out.lights.push(o.type); });   // lights: false must leave none
  const cam = new THREE.OrthographicCamera(-1.25, 1.25, 1.25, -1.25, 0.1, 20); cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
  // the background, read through a perspective camera with nothing in view: WebGLRenderer draws a cube background as a unit box around the
  // camera, which an orthographic camera of half-width 1.25 sees only in its middle (the rest was the clear color, 0)
  const persp = new THREE.PerspectiveCamera(60, 1, 0.1, 20); persp.position.set(0, 0, 5); persp.updateMatrixWorld();
  const bg = await read(persp); let sum = 0; for (let i = 0; i < bg.length; i += 4) sum += bg[i] + bg[i + 1] + bg[i + 2];
  out.bg = r4(sum / (bg.length / 4 * 3));
  scene.add(sphere);

  // 1. White furnace: a white rough dielectric, then a white rough metal. three's multiple-scattering term makes both sum to exactly one in a
  //    uniform world (dielectric: diffuse * (1 - Ess - Ems) + Ess + Ems; metal: F0 = 1 gives Ess + Ems = 1), so either may not show
  out.dielectric = discStats(await read(cam));
  sphere.material.metalness = 1;
  out.metal = discStats(await read(cam));
  sphere.material.metalness = 0;
  // the specular share alone: a black dielectric keeps only its reflection. A probe gives diffuse light only (three samples no specular from it)
  // and the diffuse is what the reflection left, so probes alone must read L minus this, not L
  sphere.material.color.setRGB(0, 0, 0);
  out.specOnly = discStats(await read(cam)).mean;   // an input to the probe check below, not a check of its own
  sphere.material.color.setRGB(1, 1, 1);

  // 2. Lit twice: probes baked from the same world (the bake hides the sphere, so the probes see only the background, radiance L everywhere)
  out.twice = { before: litTwice(e) };
  const probes = await e.bakeProbes({ bounds: { min: [-2, -2, -2], max: [2, 2, 2] }, spacing: 2, include: () => false });
  out.twice.dc = r4(probes.sh[0] * 0.282095);   // the first probe's average radiance: the bake itself must see L
  out.twice.both = discStats(await read(cam));
  out.twice.said = litTwice(e);
  scene.environmentIntensity = 0;   // the Fix the warning gives: lower the environment where the bake takes over
  out.twice.probesOnly = discStats(await read(cam));
  out.twice.afterFix = litTwice(e);
  scene.environmentIntensity = 1; probes.remove();
  out.twice.envOnly = discStats(await read(cam));
  sphere.removeFromParent(); sphere.geometry.dispose(); sphere.material.dispose();

  // 3. Analytic plane: no environment, one directional light at THETA from the normal, the camera straight down (one view direction everywhere)
  scene.environment = null; scene.background = null;
  const sun = new THREE.DirectionalLight(0xffffff, SUN); sun.position.set(Math.sin(THETA) * 10, Math.cos(THETA) * 10, 0);
  scene.add(sun, sun.target);
  const top = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20); top.position.set(0, 5, 0); top.up.set(0, 0, -1); top.lookAt(0, 0, 0); top.updateMatrixWorld();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshLambertMaterial({ color: new THREE.Color(ALBEDO, ALBEDO, ALBEDO) }));
  plane.rotation.x = -Math.PI / 2; scene.add(plane);
  /** lowest and highest of every colour channel of every pixel: the plane is white-lit grey, so all of them must be the one answer */
  const flat = async (/** @type {THREE.Camera} */ c = top) => {
    const px = await read(c); let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) { lo = Math.min(lo, px[i + k]); hi = Math.max(hi, px[i + k]); }
    return { lo: r4(lo), hi: r4(hi) };
  };
  out.lambert = { ...(await flat()), want: r4(analytic({ albedo: ALBEDO, roughness: 1, metalness: 0, standard: false })) };
  plane.material.dispose(); plane.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(ALBEDO, ALBEDO, ALBEDO), roughness: 1, metalness: 0 });
  out.standard = { ...(await flat()), want: r4(analytic({ albedo: ALBEDO, roughness: 1, metalness: 0, standard: true })), diffuseOnly: out.lambert.want };
  plane.material.roughness = 0.5;
  out.standardHalf = { ...(await flat()), want: r4(analytic({ albedo: ALBEDO, roughness: 0.5, metalness: 0, standard: true })) };
  // Specular alone, where it is the whole pixel: a black metal (no diffuse, F0 = 0) seen from the mirror direction of the sun (the half vector is
  // the normal, so D is at its peak). F0 = 0 also makes three's multiple-scattering factor 1 + F0 (1 / Ess - 1) exactly 1, so nothing here reads a
  // LUT: the pixel is intensity * cos * F(f90 part) * V * D by hand. The plane above is 98 % diffuse and could hide a specular fault in its tolerance
  const mirror = [-Math.sin(THETA), Math.cos(THETA), 0];
  const mirrorCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20); mirrorCam.position.set(mirror[0] * 5, mirror[1] * 5, 0); mirrorCam.lookAt(0, 0, 0); mirrorCam.updateMatrixWorld();
  plane.material.color.setRGB(0, 0, 0); plane.material.metalness = 1;
  out.specular = { ...(await flat(mirrorCam)), want: r4(analytic({ albedo: 0, roughness: 0.5, metalness: 1, standard: true, view: mirror })) };
  env.dispose(); s.done();
  return out;
}

// the WebGPU side is made at load: the test runner waits for window.engine; the WebGL one is made when measured
const first = await side('gpu');
window.engine = first.e;
window.physics = async () => ({ gpu: await measure(first, 'gpu'), gl: await measure(await side('gl'), 'gl') });
window.ready = true;
