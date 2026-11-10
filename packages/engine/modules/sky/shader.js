// Dome shader (gradient + sun + moon + stars + clouds), its uniforms, and neutral fallback keyframes. Start values come from sky({ ... }).
import * as THREE from 'three';
import { NOISE_GLSL } from '../../render/effects.js';
import { resolveClouds, cloudUniforms, CLOUD_UNIFORM_DECL } from './clouds.js';
import { codedError } from '../../core/base/errorHints.js';
import { SKY as K, glslFloat as f } from '../../render/fxNumbers.js';
import { isWebGPU, webgpuPart } from '../../render/backend.js';
import { drawOnly } from '../../core/scene/drawOnly.js';

// Keyframes: [time 0-1, zenith color, horizon color (= fog color), sun color, ambient intensity]
// Neutral fallback with no keyframes: pure gray (no hue), only brightness changes with time. Night holds from 19:12 to 04:48 (rows 0.2 / 0.8):
// with only the midnight row, 21:30 was halfway between dusk and midnight and read as late afternoon (demo finding 2026-11-02)
export const NEUTRAL_KEYFRAMES = [
  [0.00, 0x161616, 0x2a2a2a, 0xa8a8a8, 0.35],
  [0.20, 0x161616, 0x2a2a2a, 0xa8a8a8, 0.35],
  [0.25, 0x7c7c7c, 0xb4b4b4, 0xe4e4e4, 0.8],
  [0.50, 0x989898, 0xd4d4d4, 0xffffff, 1.2],
  [0.75, 0x7c7c7c, 0xb4b4b4, 0xe4e4e4, 0.8],
  [0.80, 0x161616, 0x2a2a2a, 0xa8a8a8, 0.35],
  [1.00, 0x161616, 0x2a2a2a, 0xa8a8a8, 0.35],
];

/**
 * Check keyframes: sorted by time, from 0 to 1, no duplicate times. Anything else would extrapolate (black sky) or divide by
 * zero (NaN colors), so it throws with the fix.
 */
export function checkKeyframes(kf) {
  const times = Array.isArray(kf) ? kf.map(k => k?.[0]) : [];
  const bad = times.length < 2 || times[0] !== 0 || times[times.length - 1] !== 1
    || kf.some(k => !Array.isArray(k) || k.length !== 5) || times.some((t, i) => i > 0 && !(t > times[i - 1]));
  if (bad) throw codedError('sky-option', `sky keyframes must be [time, zenith, horizon, sunColor, ambientIntensity] rows sorted by time, starting at 0 and ending at 1, with no time repeated; got times [${times.join(', ')}]`);
}

/**
 * Dome uniforms from the sky({ ... }) start values. The picture numbers are engine.uniforms' own objects, so a write to .value moves the dome on both renderers
 * and a game's shader reads the same object; the dome's own clouds are uSkyCloudScale / uSkyCloudSpeed in both places;
 * uCloudShadowScale / uCloudShadowSpeed are the shadows on the ground.
 */
export function makeSkyUniforms(st, E) {
  const cl = resolveClouds(st.clouds);   // throws on a bad kind / glsl / custom uniform before anything is built
  const num = (k, v) => { E[k].value = v; return E[k]; }, put = (k, ...v) => { E[k].value.set(...v); return E[k]; }, built = cloudUniforms(st.clouds, cl.kind);
  return {
    ...built, ...cl.uniforms,
    uCloudOpacity: num('uCloudOpacity', built.uCloudOpacity.value), uCloudSoft: num('uCloudSoft', built.uCloudSoft.value),
    uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunDir: E.uSunDir, uSunColor: E.uSunColor, uNight: { value: 0 },
    uSunSize: num('uSunSize', st.sunSize ?? 900), uSunGlow: num('uSunGlow', st.sunGlow ?? 0.18), uSunBrightness: num('uSunBrightness', st.sunBrightness ?? 6), uMoonBrightness: num('uMoonBrightness', st.moonBrightness ?? 3),
    uMoonSize: num('uMoonSize', 1400), uMoonColor: put('uMoonColor', st.moonColor ?? 0xdcdcdc),
    uTime: E.uTime, uWeatherCloud: E.uWeatherCloud, uCloudCover: num('uCloudCover', st.clouds?.coverage ?? (st.clouds ? 1 : 0)),
    uSkyCloudScale: num('uSkyCloudScale', st.clouds?.scale ?? 0.35), uSkyCloudSpeed: put('uSkyCloudSpeed', ...(st.clouds?.speed ?? [0.004, 0.002])),
    uCloudColor: put('uCloudColor', st.clouds?.color ?? 0xf4f4f4), uCloudShade: put('uCloudShade', st.clouds?.shade ?? 0xaaaaaa),
    uStars: num('uStars', st.starDensity ?? 0.0025), uStarCloudDim: { value: st.dim?.stars === false ? 0 : 1 }, uStarScale: num('uStarScale', 260), uSkyCurve: num('uSkyCurve', 0.55),
  };
}

/**
 * The sky dome: a back-faced sphere that follows the camera and is scaled to 0.9 of its far plane (drawn first, no depth).
 * extra = { decl, body, layers }: GLSL added by fog.js (fog-colored horizon band) and domeLayers.js (dome layers)
 * engine: on a WebGPURenderer the dome is render/fx/sky.tsl.js's node material over the same uniforms (needs threedog/tsl), drawing the layers' tsl forms
 */
export function makeDome(uniforms, st, extra, engine) {
  const cl = resolveClouds(st.clouds);
  const nodes = skyNodes(engine);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), nodes ? nodes.domeMaterial(uniforms, st, cl.kind, engine, { layers: extra.layers })
    : new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: domeFragment(cl, extra), uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false }));
  dome.frustumCulled = false; dome.renderOrder = -1000; dome.userData.budgetTag = 'sky';
  drawOnly('sky dome (left out: the tracer shows scene.environment and scene.background)', dome);
  dome.onBeforeRender = (r, sc, cam) => {
    dome.position.copy(cam.position); dome.scale.setScalar(/** @type {THREE.PerspectiveCamera} */ (cam).far * 0.9); dome.updateMatrixWorld();
  };
  return dome;
}

/**
 * The node side of the sky (render/fx/sky.tsl.js: dome material, the GLSL-only checks) when the engine draws with a WebGPURenderer, else null.
 * Why throw instead of a fallback: a ShaderMaterial does not draw on WebGPURenderer. Only this lookup is on the WebGL side, the rest (and its
 * messages) ships with threedog/tsl, so WebGL bundles do not grow.
 */
export function skyNodes(engine) {
  return isWebGPU(engine?.renderer) ? webgpuPart('sky', '[sky] the sky dome') : null;
}

/** Panorama skybox (engine.sky.replace(name)): hides the gradient dome once the texture is wanted, becomes the scene background when loaded */
export function loadSkybox(sky, name) {
  const e = sky.engine;
  sky.dome.visible = false; sky._panorama = name;
  // the load can end after another replace(): only the panorama still asked for is shown
  e.assets.useTexture(name, t => { if (sky._panorama !== name) return; t.mapping = THREE.EquirectangularReflectionMapping; e.scene.background = t; sky.skybox = t; sky._oBg?.mark(); },
    { where: 'sky skybox', instead: 'no panorama shows (the gradient dome stays hidden)' });
}

const vert = `varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
export const domeFragment = (cl, x) => `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uNight;
uniform float uSunSize; uniform float uSunGlow; uniform float uSunBrightness; uniform float uMoonBrightness; uniform float uMoonSize; uniform vec3 uMoonColor; uniform float uStars; uniform float uStarCloudDim; uniform float uStarScale; uniform float uSkyCurve;
uniform float uTime; uniform float uWeatherCloud; uniform float uCloudCover; uniform float uSkyCloudScale; uniform vec2 uSkyCloudSpeed; uniform vec3 uCloudColor; uniform vec3 uCloudShade;
${CLOUD_UNIFORM_DECL}
${NOISE_GLSL}
${cl.decl}${x.decl ? '\n' + x.decl : ''}
varying vec3 vDir;
${cl.glsl}
void main(){
  vec3 d = normalize(vDir);
  float y = max(d.y, 0.0);
  vec3 col = d.y < 0.0 ? uHorizon : mix(uHorizon, uTop, pow(y, uSkyCurve));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, uSunSize) * uSunBrightness + pow(sd, ${f(K.glowPower)}) * uSunGlow) * step(0.0, uSunDir.y + ${f(K.sunCut)});
  float md = max(dot(d, -uSunDir), 0.0);
  col += uMoonColor * pow(md, uMoonSize) * uMoonBrightness * uNight;
  vec3 g = floor(d * uStarScale);
  // Clouds: threedogClouds() is the game's (or a built-in kind's) cloud function, see clouds.js; coverage follows weather
  float cov = uWeatherCloud * uCloudCover, clA = 0.0;
  if (d.y > 0.0 && cov > 0.01) {
    vec4 cl = threedogClouds(d, uTime, uSunDir, uNight, uCloudColor, uCloudShade, cov);
    col = mix(col, cl.rgb, cl.a); clA = cl.a;
  }
  // Stars sit behind the clouds (hidden where a cloud is drawn) and dim with the weather's cloud cover (uWeatherCloud): a rainy / overcast night has
  // no clear sky between the drawn clouds either, and a picture with sparse cloud art must not show a starry sky in a storm. Relative to the
  // weather value, no extra constant: uWeatherCloud 0 = every star, 1 = none. engine.sky.dim.stars false (uStarCloudDim 0) keeps them through the cover
  col += vec3(step(1.0 - uStars, threedogHash(vec2(g.x + g.z * ${f(K.starZ)}, g.y))) * uNight * smoothstep(0.0, ${f(K.starFade)}, d.y) * (1.0 - clA) * (1.0 - clamp(uWeatherCloud, 0.0, 1.0) * uStarCloudDim));${x.body}
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
