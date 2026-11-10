// Built-in shader effects. Used by render/materials.js (applyEffects): the engine uniforms they read, the GLSL chunks (also registered as
// THREE.ShaderChunk.threedog_*), the named patches world / clouds / wind / season, and placeholder textures.
import * as THREE from 'three';
import { engineUniform } from './engineUniforms.js';
import { notePatch } from '../core/scene/threePatches.js';
import { declareUniforms } from './uniformDecl.js';
import { WIND, HASH, CLOUD, glslFloat as f } from './fxNumbers.js';

// ---------- engine uniforms ----------
// Each engine has its own uniforms (engine.uniforms). Built-in effects name engine uniforms, which patches.js swaps
// for the compiling renderer's engine (bindUniforms), so two engines on one page never share time, wind or cloud cover.
const UNIFORM_DEFAULTS = {
  uTime: 0,                                  // ambient seconds (engine.time.now('ambient')), written only by core/time/time.js
  uWind: 1,                                  // wind multiplier (driven by weather)
  uWeatherCloud: 0.25,                              // cloud cover 0-1 (driven by weather)
  uWeatherLight: 1, uWeatherFog: 1,         // weather's multipliers: the game's picture/ code applies them to its own light and fog distance
  uViewDistance: 600,                        // how far the world is meant to be seen, meters: stream radius, a game's fog far (terrain viewFog writes it)
  uRain: 0, uSnow: 0,                        // rain / snow amount 0-1 (weather state): signals for a game's wet road or snowy roof shader
  uCloudShadow: 0,                           // darkest cloud shadow (0 = no cloud shadows; the game writes it)
  uCloudShadowScale: 0.006,                        // cloud size (smaller = bigger clouds)
  uCloudShadowSpeed: () => new THREE.Vector2(0.012, 0.006),   // cloud drift direction and speed
  uWindFreq: 1,                              // sway frequency multiplier
  uWindAmp: 1,                               // sway amplitude multiplier; every wind patch's amplitude is scaled by it
  uFoliageTint: () => new THREE.Color(1, 1, 1),         // season: foliage tint (driven by the sky module's calendar)
  uGroundTint: () => new THREE.Color(1, 1, 1),          // season: ground tint
  uFoliageMix: 0, uGroundMix: 0,             // season mode 'mix': how far the surface moves to the tint (0 = multiply, the default)
  // snow / ash cover amount alone (x foliage, y ground, 0-1; modules/sky/tint.js): the tints above already hold it blended in, but a game's
  // own tint (engine.shaderTerms.season) needs the amount by itself to draw its own snow
  uGroundCover: () => new THREE.Vector2(0, 0),
  // the sky contract's shared outputs (modules/sky/frame.js writes them every frame): a game's own sky dome, water or shader reads these, so a
  // replaced sky still follows the time of day. Share the object itself: mySky.material.uniforms.sunPosition = engine.uniforms.uSunDir
  uSunDir: () => new THREE.Vector3(0, 1, 0),   // unit vector toward the sun
  uSunColor: () => new THREE.Color(1, 1, 1),   // the keyframes' sun color now: what a game's own sun takes, so no second table of the day's light
  uDaylight: 1,                              // 0 at night .. 1 at noon (the 'daylight' measure: calendar, else the drawn sun; render/daylight.js)
  uNight: 0,                                 // 0 by day .. 1 at night: the curve lightPool `dusk` sources fade on (render/daylight.js)
  uTimeOfDay: 0.5,                           // 0-1 time of day (0 midnight, 0.5 noon): the 'timeOfDay' measure, calendar else sky's fixed time; render/daylight.js
  // the sky colors as drawn this frame (keyframes, engine.sky.top / horizon, weather tint, lightning; a backdrop's color for the horizon): the one
  // read for a game shader that should meet the sky (sea, distant cards). Fog in its default 'horizon' color is this same color (fog.js)
  uSkyTop: () => new THREE.Color(0, 0, 0),
  uSkyHorizon: () => new THREE.Color(0.8, 0.8, 0.8),
  // the sky dome's picture numbers (modules/sky/shader.js shares these objects with the dome; sky({ ... }) sets their start values): write .value, on both renderers
  uSunSize: 900,                             // sharpness exponent of the sun disk (larger = smaller)
  uSunGlow: 0.18, uSunBrightness: 6,              // sun glow, sun disk brightness
  uMoonSize: 1400, uMoonBrightness: 3,            // sharpness exponent of the moon disk, moon disk brightness
  uMoonColor: () => new THREE.Color(0xdcdcdc),
  uStars: 0.0025, uStarScale: 260,           // share of sky grid cells holding a star at night (0 = none), star grid resolution (larger = smaller stars)
  uSkyCurve: 0.55,                              // horizon-to-zenith gradient exponent
  uCloudCover: 0,                            // dome cloud amount 0..1+, multiplied by the weather's uWeatherCloud
  uSkyCloudScale: 0.35,                      // dome cloud size (smaller = bigger clouds); uCloudShadowScale is the cloud shadows'
  uSkyCloudSpeed: () => new THREE.Vector2(0.004, 0.002),   // dome cloud drift [x, z] per second; uCloudShadowSpeed is the cloud shadows'
  uCloudOpacity: 0.9, uCloudSoft: 0.3,       // dome cloud opacity and edge softness
  uCloudColor: () => new THREE.Color(0xf4f4f4), uCloudShade: () => new THREE.Color(0xaaaaaa),   // dome cloud lit and shaded side
};
/**
 * A fresh set of engine uniforms at their neutral defaults (each engine owns one: engine.uniforms; the game writes them directly)
 * @internal
 * @returns {import('../types/core').EngineUniforms}
 */
export function createUniforms() {
  const u = /** @type {any} */ ({});
  for (const [k, v] of Object.entries(UNIFORM_DEFAULTS)) u[k] = engineUniform(k, typeof v === 'function' ? v() : v);
  return u;
}
/**
 * Give signals back to their neutral defaults: a module that wrote shared signals every frame calls this when it is removed, or the last value
 * (a blizzard's uSnow, a winter ground tint) would stay for every reader. The one way to take a written signal back; the defaults are the table above
 * @internal @param {any} e @param {string[]} names uniform names
 */
export function resetSignals(e, names) {
  for (const n of names) { const d = UNIFORM_DEFAULTS[n], v = typeof d === 'function' ? d() : d, u = e.uniforms[n]; if (v?.isColor || v?.isVector2 || v?.isVector3) u.value.copy(v); else u.value = v; }
}
const TEMPLATE = createUniforms();   // what built-in patches name; resolved to the compiling engine's uniforms

// ---------- GLSL ----------
/**
 * Shared GLSL value noise: threedogHash(vec2), threedogNoise(vec2) (used by sky clouds and cloud shadows).
 * One pcg2d core (threedogHashStep, fxNumbers.js HASH), two ways in. Public threedogHash(p): any vec2, hashed by its float bits (exact on
 * both backends for the same floats; a fractional p such as vUv gives a value per pixel, as the 1.0 contract says). Internal threedogHashCell:
 * the lattice cell floor(p), for the engine's noise and dabs, because pcg2d's first step is linear: cell (x + 1) starts at
 * threedogHashCell(x) + mul, so neighbor cells cost an add instead of a conversion and two multiplies (slow on some GPUs).
 * highp on the uints: a fragment shader's default int precision is mediump in GLSL ES 3.0, and the hash needs all 32 bits.
 * @internal
 */
const M = `${HASH.mul}u`;
// Guarded inside: the dome and the post pass paste it, and a game snippet there may still #include <threedog_noise>
export const NOISE_GLSL = `#ifndef THREEDOG_NOISE
#define THREEDOG_NOISE
  highp uvec2 threedogHashCell(vec2 p){ return uvec2(ivec2(floor(p))) * ${M} + ${HASH.add}u; }
  float threedogHashStep(highp uvec2 v){ v.x += v.y * ${M}; v.y += v.x * ${M}; v ^= v >> 16u; v.x += v.y * ${M};
    highp uint x = v.x ^ (v.x >> 16u); return float(x >> 8u) * ${f(1 / 2 ** 24)}; }
  // b ^= b >> 16: a whole-number float has zero low mantissa bits, and without this fold the x output draws diagonal stripes
  float threedogHash(vec2 p){ highp uvec2 b = floatBitsToUint(p); b ^= b >> 16u; return threedogHashStep(b * ${M} + ${HASH.add}u); }
  float threedogNoise(vec2 p){ highp uvec2 v = threedogHashCell(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(threedogHashStep(v), threedogHashStep(v + uvec2(${M}, 0u)), f.x), mix(threedogHashStep(v + uvec2(0u, ${M})), threedogHashStep(v + uvec2(${M})), f.x), f.y); }
#endif`;

// GLSL pieces, also registered as THREE.ShaderChunk.threedog_* so a hand-written ShaderMaterial can #include them.
// The callable ones (fixed signatures, for your own ShaderMaterial; the automatic patches call the same functions, so the math lives once):
//   #include <threedog_uniforms>      every engine uniform declared, made from UNIFORM_DEFAULTS above, so a new uniform cannot be missing from it
//   #include <threedog_wind>          vec3 threedogWind(vec3 position, vec3 origin, float amplitude)   object-space offset; origin = world origin of the object
//   #include <threedog_cloudShadow>   float threedogCloudShadow(vec3 worldPos)                         light factor 0-1 under drifting clouds
//   #include <threedog_season>        vec3 threedogSeason(vec3 color, int kind)                        kind 0 foliage, 1 ground
//   #include <threedog_detail>  threedogDetailNoise / threedogDetailBump (render/detail.js);  #include <threedog_lighting>  threedogWrapDiffuse / ShadowTint / Rim (render/lighting.js)
//   new THREE.ShaderMaterial({ uniforms: { ...engine.uniforms, uMine: { value: 1 } }, vertexShader, fragmentShader })
// Why functions and not only patches: a game's own shader should get the engine's wind or cloud shadows by calling them, without the engine
// patching the game's material (plan §4b). The older pars / vertex chunks below stay for the patches (they declare only what each patch needs).
const CALLABLE = {
  threedog_uniforms: declareUniforms('engine uniforms', Object.fromEntries(Object.entries(TEMPLATE).map(([k, o]) => [k, o.value]))).decl,
  // Higher vertices sway more; each tree / grass clump / batched object has its own phase from its own origin
  threedog_wind: `
  vec3 threedogWind(vec3 position, vec3 origin, float amplitude){
    float wt = uTime * uWindFreq;
    float sw = sin(wt * (${f(WIND.speed)} + ${f(WIND.gust)} * uWind) + origin.x * ${f(WIND.phase[0])} + origin.z * ${f(WIND.phase[1])}) * ${f(WIND.weight)}
      + sin(wt * ${f(WIND.speed2)} + origin.x * ${f(WIND.phase2[0])} + origin.z * ${f(WIND.phase2[1])}) * ${f(WIND.weight2)};
    float k = max(position.y, 0.0) * amplitude * uWind;
    return vec3(sw * k + k * ${f(WIND.lean)} * (uWind - 1.0), 0.0, sw * k * ${f(WIND.side)});
  }`,
  threedog_noise: NOISE_GLSL,
  threedog_cloudShadow: `
  #include <threedog_noise>
  float threedogCloudShadow(vec3 worldPos){
    vec2 p = worldPos.xz * uCloudShadowScale + uCloudShadowSpeed * uTime;
    float n = threedogNoise(p) * ${f(CLOUD.weight)} + threedogNoise(p * ${f(CLOUD.octave)}) * ${f(CLOUD.weight2)};
    float c = smoothstep(1.0 - uWeatherCloud, 1.0 - uWeatherCloud + ${f(CLOUD.edge)}, n);
    return 1.0 - c * uCloudShadow;
  }`,
  threedog_season: `
  vec3 threedogSeason(vec3 color, int kind){
    vec3 t = kind == 1 ? uGroundTint : uFoliageTint; float m = kind == 1 ? uGroundMix : uFoliageMix;
    return m > 0.0 ? mix(color, t, m) : color * t;
  }`,
};
const CHUNKS = {
  threedog_world_pars_vertex: 'varying vec3 vThreedogWorld;',
  threedog_world_pars_fragment: 'varying vec3 vThreedogWorld;',
  // same order as three's project_vertex: batching, then instancing, then the model matrix (InstancedMesh and BatchedMesh both work)
  threedog_world_vertex: `
  {
    vec4 threedogP = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      threedogP = batchingMatrix * threedogP;
    #endif
    #ifdef USE_INSTANCING
      threedogP = instanceMatrix * threedogP;
    #endif
    vThreedogWorld = (modelMatrix * threedogP).xyz;
  }`,
  threedog_clouds_pars_fragment: `
  uniform float uTime; uniform float uWeatherCloud; uniform float uCloudShadow; uniform float uCloudShadowScale; uniform vec2 uCloudShadowSpeed;
  #include <threedog_cloudShadow>
  float threedogCloudLight(vec2 xz){ return threedogCloudShadow(vec3(xz.x, 0.0, xz.y)); }`,
  // The built-in cloud shadow, in the lightsPars slot: three's own directional (and SunLight) light info is wrapped, so clouds dim only the
  // sun / moon light (every cascade of a cascaded sun too), never a street lamp or a torch (point, spot, rect-area) or the ambient light.
  // Why a branch on uCloudShadow and not a recompile: the default is 0, and a branch on a uniform takes the same path for the whole frame
  // (no noise is computed), while every plain material of one type keeps one program whether the shadow is on or off. The factor is
  // computed once per pixel (threedogCloudK caches it: a cascaded sun calls the light info once per cascade).
  threedog_clouds_light: `
  float threedogCloudK = -1.0;
  float threedogSunCloud(){
    if (threedogCloudK < 0.0) { threedogCloudK = 1.0; if (uCloudShadow > 0.0) threedogCloudK = threedogCloudLight(vThreedogWorld.xz); }
    return threedogCloudK;
  }
  #if NUM_DIR_LIGHTS > 0
  void threedogDirectionalLightInfo(const in DirectionalLight l, out IncidentLight light){ getDirectionalLightInfo(l, light); light.color *= threedogSunCloud(); }
  #define getDirectionalLightInfo threedogDirectionalLightInfo
  #endif
  #if NUM_SUN_LIGHTS > 0
  void threedogSunLightInfo(const in SunLight l, out IncidentLight light){ getSunLightInfo(l, light); light.color *= threedogSunCloud(); }
  #define getSunLightInfo threedogSunLightInfo
  #endif`,
  threedog_wind_pars_vertex: `uniform float uTime; uniform float uWind; uniform float uWindFreq;
#include <threedog_wind>`,
  threedog_wind_vertex: `
  {
    vec4 ipo = vec4(0.0, 0.0, 0.0, 1.0);
    #ifdef USE_BATCHING
      ipo = batchingMatrix * ipo;
    #endif
    #ifdef USE_INSTANCING
      ipo = instanceMatrix * ipo;
    #endif
    vec3 ip = (modelMatrix * ipo).xyz;
    #ifdef THREEDOG_WIND_CUSTOM
      threedogWind(transformed, ip, position);
    #else
      transformed += threedogWind(position, ip, THREEDOG_WIND_AMP);
    #endif
  }`,
};
Object.assign(THREE.ShaderChunk, CALLABLE, CHUNKS);
notePatch('shader-chunks', 'THREE.ShaderChunk.threedog_* (new names only, none of three\'s replaced): the engine\'s GLSL pieces, #include-able in a ShaderMaterial',
  null, { lost: "the engine's own material patches #include them; nothing changes for code that does not include a threedog_ chunk" });
/** Short text hash for cacheKeys @internal */
export const hashText = t => { let h = 7; for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const pick = (...keys) => Object.fromEntries(keys.map(k => [k, TEMPLATE[k]]));
// What the built-in cloud shadow and season terms read; render/terms.js keeps them on a game's replacement too
export const CLOUD_UNIFORMS = ['uTime', 'uWeatherCloud', 'uCloudShadow', 'uCloudShadowScale', 'uCloudShadowSpeed'];
export const SEASON_UNIFORMS = ['uFoliageTint', 'uGroundTint', 'uFoliageMix', 'uGroundMix'];
export const CLOUD_PARS = '#include <threedog_clouds_pars_fragment>';
export const SEASON_PARS = 'uniform vec3 uFoliageTint; uniform vec3 uGroundTint; uniform float uFoliageMix; uniform float uGroundMix;\n#include <threedog_season>';

/**
 * Varyings an engine patch declares, by the patch that provides them: a game patch whose GLSL reads one gets that patch added before it
 * (patchMaterial in patches.js), so forgetting needs: { patches: ['world'] } is a one-time dev note, not a shader compile error
 * @internal
 */
export const PROVIDED_BY = { vThreedogWorld: 'world' };
// One tsl function per built-in spec: the WebGPU program key holds each function's identity (render/patches.js nodeKey), so a fresh closure per
// call would give every material with the same effects its own program
const TSL_ONCE = new Map();
const tslOnce = (key, make) => { let t = TSL_ONCE.get(key); if (!t) TSL_ONCE.set(key, t = make()); return t; };
// The engine's built-in effects as named patches (also readable as GLSL examples for your own patches)
/** @internal @type {Record<string, (...args: any[]) => import('./patches.js').ShaderPatch>} */
export const EFFECTS = {
  // world-space position varying vThreedogWorld; clouds, the terrain detail texture and your own patches build on it (needs: ['world'])
  // (slot names: render/slots.js)
  world: () => ({ name: 'world', slot: 'clipPosition', glsl: '#include <threedog_world_vertex>',
    pars: { vertex: '#include <threedog_world_pars_vertex>', fragment: '#include <threedog_world_pars_fragment>' },
    // TSL needs no varying for this (positionWorld is a built-in node), so the NodeMaterial side has nothing to do
    tsl: {} }),
  // tsl = the same one-line call as the GLSL, through the threedog/tsl function (ctx.fx); effects.js stays free of three/tsl imports
  clouds: () => ({ name: 'clouds', needs: { patches: ['world'] }, uniforms: pick(...CLOUD_UNIFORMS),
    // sun light only, skipped while uCloudShadow is 0 (threedog_clouds_light above); WebGPU: the lighting slot's light() hook changes the
    // sun's color before three lights the surface with it, behind the same uniform branch
    pars: CLOUD_PARS, glsl: { lightsPars: '#include <threedog_clouds_light>' },
    tsl: tslOnce('clouds', () => ({ lighting: { light: (L, c) => {
      if (!L.light?.isDirectionalLight && !L.light?.isSunLight) return undefined;
      const T = c.tsl;
      if (!c.state.cloud) {
        const k = c.state.cloud = T.float(1).toVar('tdCloud');
        T.If(c.fx.uniform('uCloudShadow').greaterThan(0), () => { k.assign(c.fx.cloudShadow(T.positionWorld)); });
      }
      return L.color.mul(c.state.cloud);
    } } })) }),
  // wind(amplitude) or wind(amplitude, { glsl, uniforms, decl }): a game's own sway function replaces the default one
  wind: (amplitude, custom) => ({ name: 'wind', cacheKey: custom ? `${amplitude}|${hashText(custom.glsl ?? '')}` : amplitude, shadow: true,
    uniforms: { ...pick('uTime', 'uWind', 'uWindFreq', 'uWindAmp'), ...custom?.uniforms }, slot: 'position', glsl: '#include <threedog_wind_vertex>',
    pars: `uniform float uWindAmp;
#define THREEDOG_WIND_AMP (${(+amplitude).toFixed(4)} * uWindAmp)
#include <threedog_wind_pars_vertex>` + (custom?.glsl != null
      ? `
#define THREEDOG_WIND_CUSTOM
${custom.decl}
${custom.glsl}` : ''),
    // a game's own sway brings its own tsl (engine.vegetation.sway({ glsl, tsl })); one with GLSL only has no tsl (a NodeMaterial names it).
    // ctx.position is object space before instancing on both renderers (render/slots.js), so this is the GLSL line as it is
    ...(custom?.tsl && { tsl: custom.tsl }),
    ...(!custom && { tsl: tslOnce(`wind ${(+amplitude).toFixed(4)}`, () => c => c.position.add(c.fx.wind(c.tsl.positionGeometry, c.fx.objectOrigin(),
      c.tsl.float(+(+amplitude).toFixed(4)).mul(c.fx.uniform('uWindAmp'))))) }) }),
  season: kind => {
    // the shared threedogSeason / TSL season() on both sides (mix is 0 in the default 'multiply' mode; a season's mode 'mix' sets it)
    const id = kind === 'ground' ? 1 : 0;
    return { name: 'season', cacheKey: kind, uniforms: pick(...SEASON_UNIFORMS), slot: 'color',
      pars: SEASON_PARS,
      glsl: `diffuseColor.rgb = threedogSeason(diffuseColor.rgb, ${id});`,
      tsl: tslOnce(`season ${id}`, () => c => c.tsl.vec4(c.fx.season(c.color.rgb, id), c.color.a)) };
  },
};

// Until the image loads, a 1x1 linear mid-gray placeholder (x2 in the shader = 1) leaves the ground unchanged instead of darkening it.
/**
 * Neutral 1x1 linear stand-in for a texture that is still loading: 'detail' (0.5 gray, which the detail shader doubles to 1) or
 * 'normal' (a flat normal). A plain Texture (not DataTexture), so the loaded image's source can replace it in place.
 * @internal
 * @param {'detail' | 'normal'} kind
 * @returns {any}
 */
export function placeholderTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.fillStyle = kind === 'normal' ? 'rgb(128,128,255)' : 'rgb(128,128,128)'; g.fillRect(0, 0, 1, 1);
  const t = new THREE.Texture(c); t.needsUpdate = true;
  return t;
}
