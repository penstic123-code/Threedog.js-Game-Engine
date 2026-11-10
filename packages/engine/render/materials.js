// Shader effects on plain three.js materials (shadows, fog and tone mapping kept): wind sway, cloud shadows, season tint, ground detail texture,
// light shaping; plus the terrain's base material and vertex-colored merging. A material's picture is the game's: this file only adds effects to it.
import * as THREE from 'three';
import { oneForm } from '../core/base/validate.js';
import { patchMaterial, sharedPatch } from './patches.js';
import { declareUniforms } from './uniformDecl.js';
import { EFFECTS } from './effects.js';
import { cloudsPatch, seasonPatch, trackTerms } from './terms.js';
import { detailPatch } from './detail.js';
import { lightingPatch } from './lighting.js';
import { neutralMaterial } from './neutral.js';
import { codedError } from '../core/base/errorHints.js';
/** @import { ColorLike, Material, BufferGeometry } from '../types/common' */

// Live engines in creation order: applyEffects called without an engine (a game's module-level code) uses the first one's assets and terms
const ENGINES = [];
/**
 * Register an engine for applyEffects without an engine option; returns a handle whose remove() unregisters it (engine.dispose)
 * @internal
 * @param {{ assets: any }} engine
 * @returns {{ remove(): void }}
 */
export function registerEngine(engine) {
  ENGINES.push(engine);
  return { remove: () => { const i = ENGINES.indexOf(engine); if (i >= 0) ENGINES.splice(i, 1); } };
}

// ---------- shader effects (named patches, see patches.js; the built-in ones are in effects.js) ----------
// Your own sway function (applyEffects(mat, { wind: { amplitude, glsl, tsl, uniforms } }), the same object on a species): the GLSL must define threedogWind();
// its uniforms are declared for it. tsl: the WebGPURenderer form, (ctx) => the moved object-space position (a 'position' slot patch's tsl)
/** @param {{ glsl?: string, uniforms?: Record<string, any>, tsl?: (ctx: any) => any }} sway @param {boolean} [gpu] the engine draws with WebGPURenderer; left out: unknown */
export function windCustom({ glsl, uniforms, tsl }, gpu) {
  if (tsl != null && typeof tsl !== 'function') throw codedError('material-option', "wind.tsl is (ctx) => vec3 node: the moved object-space position (ctx.position, ctx.fx.wind, ctx.fx.objectOrigin())");
  if ((glsl != null || tsl == null) && !/void\s+threedogWind\s*\(/.test(glsl || '')) throw codedError('material-option', 'the sway GLSL must define `void threedogWind(inout vec3 transformed, vec3 ip, vec3 position)`: move the vertex (object space) by the sway; ip = world position of this instance, uTime / uWind / uWindFreq / THREEDOG_WIND_AMP are in scope');
  // each renderer draws its own form: the missing one would leave the built-in sway in place without a word
  if (gpu === false && glsl == null) throw oneForm('material-option', 'wind', false);
  if (gpu && tsl == null) throw oneForm('material-option', 'wind', true);
  return { glsl, tsl, ...declareUniforms('wind.uniforms', uniforms) };
}
/**
 * Add effects to any material (the engine's or your own); returns the same material. The one entry for shader effects:
 * wind (sway amplitude; the shadow sways too, nothing else to set up), clouds (drifting cloud shadows, default on; how dark is
 * engine.uniforms.uCloudShadow), season ('foliage' | 'ground' seasonal tint), and patches: your own named patches (see ShaderPatch in
 * render/patches.js), detail (grain / paper / strokes / a texture over the surface, see DetailOptions in render/detail.js; a texture given by
 * asset name loads from `engine`, default the first live engine), lighting (light shaping: { wrap, shadowTint, rim }, or your own { glsl, uniforms };
 * see LightingOptions in render/lighting.js; materials with the same options share one program). The 'world' patch (varying vThreedogWorld, world position) comes with clouds, and is added for any of your
 * patches that lists it in needs.patches or reads vThreedogWorld (a one-time dev note asks for the needs line).
 * Built-in effects the material cannot take (MeshBasicMaterial has no lighting chunk for clouds) are skipped with a one-time warning;
 * detail, lighting and your own patches throw when their anchor is missing. Calling again with the same effect replaces it.
 * @example
 * applyEffects(new THREE.MeshToonMaterial({ color: 0x5a8a3a }), { wind: 0.03, season: 'foliage' });
 * applyEffects(new THREE.MeshLambertMaterial({ color: 0xb0a080 }), { lighting: { wrap: 0.4, rim: { color: 0xffe0b0, strength: 0.3 } } });
 * applyEffects(mat, { clouds: false, patches: [{ name: 'snap', cacheKey: 64, uniforms: { uGrid: { value: 64 } },
 *   slot: 'clipPosition', pars: 'uniform float uGrid;', glsl: 'gl_Position.xy = floor(gl_Position.xy / gl_Position.w * uGrid) / uGrid * gl_Position.w;' }] });
 * @param {Material} material
 * @param {{ wind?: number | { amplitude: number, glsl?: string, uniforms?: Record<string, any>, tsl?: (ctx: any) => any }, clouds?: boolean, season?: 'foliage' | 'ground', detail?: import('./detail.js').DetailOptions, lighting?: import('./lighting.js').LightingOptions, engine?: { assets: any }, patches?: import('./patches.js').ShaderPatch[] }} [opts]
 * @returns {Material}
 */
export function applyEffects(material, { wind, clouds = true, season, detail, lighting, engine, patches } = {}) {
  const list = [], te = engine ?? ENGINES[0] ?? null;
  // cloud shadow and season tint: the engine's own term, or the one the game put in its place (engine.shaderTerms,
  // render/terms.js). The material is remembered under its engine, so a replace made later reaches it too.
  const cp = clouds && cloudsPatch(te), sp = season && seasonPatch(te, season);
  if (clouds || season) trackTerms(te, material, { clouds: !!clouds, season: season || null });
  if (cp) list.push(EFFECTS.world(), cp);   // a patch of yours that reads vThreedogWorld gets 'world' from patchMaterial
  if (sp) list.push(sp);
  if (wind) list.push(typeof wind === 'number' ? EFFECTS.wind(wind) : EFFECTS.wind(wind.amplitude, windCustom(wind, te?.renderer ? !!te.renderer.isWebGPURenderer : undefined)));
  if (detail) list.push(EFFECTS.world());
  patchMaterial(material, list, { strict: false });
  // same options -> the same patch object (sharedPatch): one WebGPU program for every material that gives them. Strict, like your own patches: a
  // lighting option on a material with no lights is a mistake to name, not an effect to skip
  const asked = [...(detail ? [sharedPatch(te, 'detail', detail, () => detailPatch(detail, te, 'detail'))] : []),
    ...(lighting ? [sharedPatch(te, 'lighting', lighting, () => lightingPatch(lighting, 'applyEffects lighting'))] : []), ...(patches ?? [])];
  if (asked.length) patchMaterial(material, asked);
  return material;
}

/**
 * Terrain material: base (default neutral with vertex colors) + cloud shadows + season tint + optional detail layer (detail: see DetailOptions; defaults scale 0.25,
 * strength 0.35, top-down world projection, multiply). Pass the engine so its assets load a detail texture by name. effects: false returns your base as is
 * (no engine patch at all, the vegetation.define({ effects: false }) word).
 * @param {Material | null} [base]
 * @param {{ assets: any }} [engine]
 * @param {{ effects?: boolean, detail?: import('./detail.js').DetailOptions | null }} [o]
 * @returns {Material}
 * @experimental
 */
export function terrainMaterial(base = null, engine = undefined, { effects = true, detail = null } = {}) {
  if (base && effects === false) return base;
  return applyEffects(base || neutralMaterial('terrain', { vertexColors: true }),
    { season: 'ground', engine: engine ?? ENGINES[0], ...(detail && { detail }) });
}

/**
 * Merge several geometries into one vertex-colored geometry (a tree = trunk + canopy in one draw call): [[geometry, color], ...].
 * flat (default true): one normal per triangle, the faceted low-poly look; false keeps each part's own (smooth) normals.
 * UVs are kept when every part has them, so the merged model can still take a texture.
 * @example
 * const trunk = new THREE.CylinderGeometry(0.2, 0.3, 2).translate(0, 1, 0), crown = new THREE.SphereGeometry(1.2).translate(0, 2.6, 0);
 * const tree = mergeColored([[trunk, 0x7a5536], [crown, 0x4c8a3b]], { flat: false });   // smooth crown
 * @param {[BufferGeometry, ColorLike][]} parts
 * @param {{ flat?: boolean }} [opts]
 * @returns {BufferGeometry}
 */
export function mergeColored(parts, { flat = true } = {}) {
  const pos = [], nor = [], col = [], uv = [];
  const keepUV = parts.every(([g]) => g.attributes.uv);
  for (const [g0, hex] of parts) {
    if (!flat && !g0.attributes.normal) g0.computeVertexNormals();
    const g = g0.index ? g0.toNonIndexed() : flat ? g0.clone() : g0;   // flat rewrites normals: never on the caller's geometry
    if (flat) g.computeVertexNormals();
    // by getX / getY (not .array): an interleaved attribute's array holds the other attributes too, and its length is not the vertex count
    const c = new THREE.Color(hex), p = g.attributes.position, n = g.attributes.normal, t = keepUV && g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.r, c.g, c.b);
      if (t) uv.push(t.getX(i), t.getY(i));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (keepUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}
