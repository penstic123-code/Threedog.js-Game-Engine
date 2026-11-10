// The `lighting` patch (applyEffects(mat, { lighting })) and the toon ramp (rampTexture). Extra, optional light shaping on three's lit materials (lambert, phong, standard, toon).
// three has no "shadow color": a shadow just removes the sun's light. The patch therefore works after the lights are summed (lights_fragment_end):
// it re-reads the first directional light (three sorts shadow-casting lights first, so that is the sun) and its shadow-map value for this
// pixel, and shapes the result from them. Limits: one directional light is considered (point / spot lights are untouched); wrap does not
// follow a toon ramp (a toon ramp is the better tool there); cloud shadows are not "shadow" for shadowTint.
// All values are uniforms: materials differing only in numbers or colors share one program (the cacheKey holds which features are on).
import * as THREE from 'three';
import { readParams, keysSchema } from '../core/base/params.js';
import { isOptions } from '../core/base/util.js';
import { hashText } from './effects.js';
import { declareUniforms } from './uniformDecl.js';
import { codedError } from '../core/base/errorHints.js';
import { LUMA } from './fxNumbers.js';

const KEYS = ['wrap', 'shadowTint', 'rim', 'glsl', 'uniforms'];
const lum = `vec3(${LUMA.join(', ')})`;

// Callable (#include <threedog_lighting> in your own ShaderMaterial; the patch below calls the same functions, so the math lives once).
// Plain inputs, no uniforms and no three internals: nl = dot(normal, sunDir), shadow 1 lit / 0 shadowed, viewDir from the surface to the eye.
//   vec3 threedogWrapDiffuse(float nl, float wrap, vec3 lightColor, float shadow, vec3 albedo)   half-lambert light beyond plain Lambert
//   vec3 threedogShadowTint(vec3 ambient, vec3 tint, float strength, float soft, float nl, float shadow)   ambient with the shaded side's hue moved
//   vec3 threedogRim(vec3 normal, vec3 viewDir, vec3 color, float strength, float power, float shadowSide, float nl)   edge light to add
// Why: a game's own shader should get the style's light shaping by calling it, not by having the engine patch its material.
const LIGHTING_CHUNK = `#ifndef THREEDOG_LIGHTING
#define THREEDOG_LIGHTING
vec3 threedogWrapDiffuse(float nl, float wrap, vec3 lightColor, float shadow, vec3 albedo){
  return ( max( ( nl + wrap ) / ( 1.0 + wrap ), 0.0 ) - max( nl, 0.0 ) ) * lightColor * shadow * 0.3183098861837907 * albedo;
}
vec3 threedogShadowTint(vec3 ambient, vec3 tint, float strength, float soft, float nl, float shadow){
  float k = ( 1.0 - shadow * smoothstep( 0.0, soft, nl ) ) * strength;
  vec3 hue = tint / max( dot( tint, ${lum} ), 0.001 );
  return mix( ambient, ambient * hue, k );
}
vec3 threedogRim(vec3 normal, vec3 viewDir, vec3 color, float strength, float power, float shadowSide, float nl){
  return color * ( pow( 1.0 - clamp( dot( normal, viewDir ), 0.0, 1.0 ), power ) * mix( 1.0, 1.0 - clamp( nl, 0.0, 1.0 ), shadowSide ) * strength );
}
#endif`;
Object.assign(THREE.ShaderChunk, { threedog_lighting: LIGHTING_CHUNK });   // the same registry effects.js fills

// Functions need getShadow and the light uniforms, which exist only after these includes: they go after shadowmap_pars_fragment
// With cascades (render/cascades.js, the 'csm' patch: USE_CSM) the sun is N directional lights with one color and direction, one shadow map each: the shadow is
// the map of the cascade this fragment's depth falls in, picked the way three's CSMShader picks it (linear depth against CSM_cascades; the last one takes the rest).
// Cascade 0 alone read as "lit" past its far edge, so wrap added sun light inside shadows and shadowTint went missing there.
// With CSM_FADE (the engine default) CSMShader adds each cascade's light weighted by its margin ratio and fades the last one out; the sun's light is linear
// in the shadow factor, so the same sum on the factor gives the same result, from the same CSM_cascades values.
const SUN = `float threedogSunShadow(){
  #if NUM_DIR_LIGHTS > 0 && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0 && defined( USE_CSM ) && defined( CSM_CASCADES )
    float s = 1.0, sh, linearDepth = vViewPosition.z / ( shadowFar - cameraNear );
    #ifdef CSM_FADE
      vec2 cascade; float cascadeCenter, margin, csmx, csmy, ratio; bool lastOne;
      s = 0.0;   // each cascade adds its share (CSMShader: reflectedLight = mix( before, before + this cascade's light, ratio ))
    #endif
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      #ifdef CSM_FADE
        cascade = CSM_cascades[ i ]; cascadeCenter = ( cascade.x + cascade.y ) / 2.0;
        margin = 0.25 * pow( linearDepth < cascadeCenter ? cascade.x : cascade.y, 2.0 );
        csmx = cascade.x - margin / 2.0; csmy = cascade.y + margin / 2.0; lastOne = UNROLLED_LOOP_INDEX == CSM_CASCADES - 1;
        if ( linearDepth >= csmx && ( linearDepth < csmy || lastOne ) ) {
          ratio = clamp( min( linearDepth - csmx, csmy - linearDepth ) / margin, 0.0, 1.0 );
          sh = receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity,
            directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
          sh = mix( 1.0, sh, lastOne && linearDepth > cascadeCenter ? ratio : 1.0 );   // the last cascade fades out to unshadowed
          s += sh * ( !lastOne || linearDepth < cascadeCenter ? ratio : 1.0 );   // neighbours cross over across the margin
        }
      #else
        if ( linearDepth >= CSM_cascades[ i ].x && linearDepth < CSM_cascades[ i ].y )   // past the last far edge three lights unshadowed: s stays 1
          s = receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity,
            directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
      #endif
    }
    #pragma unroll_loop_end
    return s;
  #elif NUM_DIR_LIGHTS > 0 && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    return receiveShadow ? getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity,
      directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
  #else
    return 1.0;
  #endif
}`;

/**
 * @typedef {{ wrap?: number, shadowTint?: { color: import('../types/common').ColorLike, strength?: number, soft?: number },
 *   rim?: { color: import('../types/common').ColorLike, strength?: number, power?: number, shadowSide?: number }, glsl?: string, uniforms?: Record<string, any> }} LightingOptions
 */

/**
 * The `lighting` patch. With `glsl` your function replaces the built-in shaping.
 * @internal use applyEffects(mat, { lighting })
 * @param {LightingOptions} o
 * @param {string} [label]
 * @returns {import('./patches.js').ShaderPatch}
 */
export function lightingPatch(o, label = 'lighting') {
  if (isOptions(o)) readParams(label, keysSchema(KEYS), o);
  const { wrap, shadowTint: st, rim } = o;
  if (o.glsl && !/void\s+threedogLighting\s*\(/.test(o.glsl)) throw codedError('material-option', `${label}.glsl must define \`void threedogLighting(inout ReflectedLight light, vec3 normal, vec3 viewDir, vec3 sunDir, float sunShadow, vec3 albedo)\`: normal and viewDir are in view space, sunDir points to the sun, sunShadow is 1 lit / 0 in shadow (1 without shadows); change light.directDiffuse / indirectDiffuse (the lights are already summed)`);
  if (st && st.color === undefined) throw codedError('material-option', `${label}.shadowTint needs a color: { color: shadowColor, strength: 0.6 }`);
  if (rim && rim.color === undefined) throw codedError('material-option', `${label}.rim needs a color: { color: rimColor, strength: 0.4, power: 3 }`);
  const own = declareUniforms(label + '.uniforms', o.uniforms);
  const u = { ...own.uniforms };
  let pars = `uniform float uLitWrap; uniform vec3 uLitShadowColor; uniform vec2 uLitShadow; uniform vec3 uLitRimColor; uniform vec3 uLitRim;\n#include <threedog_lighting>\n${own.decl}`;
  let code = '#if NUM_DIR_LIGHTS > 0\n  float tdSun = threedogSunShadow(); vec3 tdL = directionalLights[ 0 ].direction; float tdNL = dot( normal, tdL );\n';
  if (o.glsl) code += '  threedogLighting( reflectedLight, normal, normalize( vViewPosition ), tdL, tdSun, diffuseColor.rgb );\n';
  else {
    if (wrap !== undefined) {
      // half-lambert: the diffuse term (n.l + w) / (1 + w); only the part beyond plain Lambert is added, with the sun's color and shadow
      code += '  reflectedLight.directDiffuse += threedogWrapDiffuse( tdNL, uLitWrap, directionalLights[ 0 ].color, tdSun, diffuseColor.rgb );\n';
      u.uLitWrap = { value: wrap };
    }
    if (st) {
      // 1 - lit: in the shadow map, or turned away from the sun (soft = how wide the terminator is, in n.l). The hue moves, the brightness stays.
      const c = new THREE.Color(st.color);
      code += '  reflectedLight.indirectDiffuse = threedogShadowTint( reflectedLight.indirectDiffuse, uLitShadowColor, uLitShadow.x, uLitShadow.y, tdNL, tdSun );\n';
      u.uLitShadowColor = { value: c }; u.uLitShadow = { value: new THREE.Vector2(st.strength ?? 0.5, Math.max(st.soft ?? 0.3, 0.001)) };
    }
    if (rim) {
      // fresnel-like edge light, added to the ambient part; shadowSide 1 = only on the side facing away from the sun
      code += '  reflectedLight.indirectDiffuse += threedogRim( normal, normalize( vViewPosition ), uLitRimColor, uLitRim.x, uLitRim.y, uLitRim.z, tdNL );\n';
      u.uLitRimColor = { value: new THREE.Color(rim.color) }; u.uLitRim = { value: new THREE.Vector3(rim.strength ?? 0.4, rim.power ?? 3, rim.shadowSide ?? 0) };
    }
  }
  code += '#endif';
  for (const n of ['uLitWrap', 'uLitShadowColor', 'uLitShadow', 'uLitRimColor', 'uLitRim']) u[n] ??= { value: n === 'uLitWrap' ? 0 : n === 'uLitShadow' ? new THREE.Vector2() : n === 'uLitRim' ? new THREE.Vector3() : new THREE.Color() };
  const key = o.glsl ? 'g' + hashText(o.glsl) : `${wrap !== undefined ? 'w' : ''}${st ? 's' : ''}${rim ? 'r' : ''}`;
  return { name: 'lighting', cacheKey: key, uniforms: u, pars, glsl: { lightsPars: (o.glsl ? o.glsl + '\n' : '') + SUN, lighting: code },
    // your own GLSL threedogLighting has no TSL twin: no tsl field, so a NodeMaterial names the patch instead of dropping it
    ...(!o.glsl && { tsl: { lighting: lightingTsl(u, wrap !== undefined, !!st, !!rim) } }) };
}

/**
 * The patch on a NodeMaterial, through the lighting slot's hooks (render/fx/patchNodes.tsl.js), same math as the GLSL above:
 * direct() sees each light; the first directional one is the sun (GLSL directionalLights[0]), whose n.l and shadow factor are kept and whose
 * wrap light is added there (its color already carries the shadow, hence shadow 1). after() shapes the summed ambient, as the GLSL code after
 * lights_fragment_end does. No directional light: nothing changes (GLSL #if NUM_DIR_LIGHTS > 0).
 * @param {Record<string, { value: any }>} u @param {boolean} wrap @param {boolean} st @param {boolean} rim
 */
function lightingTsl(u, wrap, st, rim) {
  return {
    start: c => { c.state.sun = false; c.state.nl = c.tsl.float(0).toVar('tdNL'); c.state.shadow = c.tsl.float(1).toVar('tdSun'); },
    direct: (L, c) => {
      if (!L.directional || c.state.sun) return;
      const T = c.tsl;
      c.state.sun = true;
      c.state.nl.assign(T.dot(T.normalView, L.direction));
      if (L.shadow) c.state.shadow.assign(L.shadow);
      if (wrap) c.directDiffuse.addAssign(c.fx.wrapDiffuse(c.state.nl, c.fx.patchUniform(u.uLitWrap), L.color, 1, T.diffuseColor.rgb));
    },
    after: c => {
      if (!c.state.sun || !(st || rim)) return undefined;
      const T = c.tsl, U = k => c.fx.patchUniform(u[k]), { nl, shadow } = c.state;
      let ind = c.indirectDiffuse;
      if (st) { const s = U('uLitShadow'); ind = c.fx.shadowTint(ind, U('uLitShadowColor'), s.x, s.y, nl, shadow); }
      if (rim) { const r = U('uLitRim'); ind = ind.add(c.fx.rim(T.normalView, T.positionViewDirection, U('uLitRimColor'), r.x, r.y, r.z, nl)); }
      return { indirectDiffuse: ind };
    },
  };
}

// ---------- toon ramp ----------
const rampCache = new Map();
/**
 * The gradientMap of a toon material from `ramp` (grays or colors, dark to light) and `soften` (0 = hard bands, 1 = bands melt into each other).
 * A gray number n is the light's strength in that band. three's toon reads only the red channel of this texture on both renderers; color entries
 * tint the band under `celLighting` of threedog/tsl (WebGPU route).
 * @example new THREE.MeshToonMaterial({ color: 0x8aa0b0, gradientMap: rampTexture([0.35, 0.7, 1], 0.2) });
 * @param {(number | import('../types/common').ColorLike)[]} ramp
 * @param {number} [soften]
 * @returns {THREE.DataTexture}
 */
export function rampTexture(ramp, soften = 0) {
  if (!Array.isArray(ramp) || ramp.length < 2) throw codedError('material-option', 'toon ramp must be an array of at least 2 grays or colors, dark to light, e.g. ramp: [0.35, 0.7, 1] or three colors');
  const key = JSON.stringify([ramp, soften]);
  if (rampCache.has(key)) return rampCache.get(key);
  const cols = ramp.map(v => typeof v === 'number' && v <= 1 ? new THREE.Color(v, v, v) : new THREE.Color(v));
  const soft = Math.max(0, Math.min(1, soften)), W = soft > 0 ? 128 : cols.length, N = cols.length, data = new Uint16Array(W * 4), c = new THREE.Color();
  for (let i = 0; i < W; i++) {
    const x = (i + 0.5) / W * N, b = Math.round(x), d = x - b;   // b = nearest band border
    if (soft > 0 && b > 0 && b < N && Math.abs(d) < soft / 2) c.copy(cols[b - 1]).lerp(cols[b], THREE.MathUtils.smoothstep(d, -soft / 2, soft / 2));
    else c.copy(cols[Math.min(N - 1, Math.floor(x))]);
    data.set([THREE.DataUtils.toHalfFloat(c.r), THREE.DataUtils.toHalfFloat(c.g), THREE.DataUtils.toHalfFloat(c.b), THREE.DataUtils.toHalfFloat(1)], i * 4);
  }
  const t = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = soft > 0 ? THREE.LinearFilter : THREE.NearestFilter; t.needsUpdate = true;
  rampCache.set(key, t);
  return t;
}
