// Node-material version of the sky dome (modules/sky/shader.js) for WebGPURenderer.
// Why a registry instead of an import: modules/sky is in every WebGL game's bundle and must not pull in three/tsl, so this file (loaded with
// threedog/tsl, i.e. only on the WebGPU route) registers itself (render/backend.js registerWebGPUPart) and the sky looks it up when the renderer is a
// WebGPURenderer (same pattern as particles.tsl.js / patchNodes.tsl.js).
// One copy of every value: the dome's uniforms stay the { value } objects frame.js and the game write (sky.uniforms, engine.uniforms); the nodes read them back
// each render. The engine's own ones (uSunDir, uTime, uWeatherCloud) come from threedog/tsl uniforms(engine), the same cached nodes every other
// TSL shader of that engine reads, so the calendar / weather writing engine.uniforms moves this dome and a game's own TSL sky together.
// Line for line the GLSL domeFragment: gradient, sun and moon discs, clouds ('plane' / 'cumulus'), stars, fog band, dome layers.
// The two GLSL hooks of the sky each have a tsl form here, same contract as a shader patch's tsl field: (ctx) => node, ctx carrying the value
// so far and the hook's inputs (engine.sky.clouds(spec), engine.sky.layer(name, spec)). A hook with
// only GLSL throws [webgpu-needs-tsl] by name on this renderer; the GLSL form keeps drawing on WebGLRenderer unchanged.
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, BackSide } from 'three/webgpu';
import { noise, hash } from './noise.tsl.js';
import * as FX from './library.tsl.js';
import { uniforms as engineUniforms, valueNode } from './uniforms.tsl.js';
import { codedError } from '../../core/base/errorHints.js';
import { registerWebGPUPart } from '../backend.js';
import { SKY as K } from '../fxNumbers.js';

const { Fn, positionGeometry, varying, float, vec2, vec3, vec4, select, mix, pow, max, dot,
  floor, step, smoothstep, clamp, normalize, If } = TSL;

/** @template {string} T @typedef {import('three/webgpu').Node<T>} N */
/**
 * The dome's uniforms as nodes, by node type (makeSkyUniforms, clouds.js cloudUniforms, dome.js); a hook's own uniforms are the extra keys.
 * Colors are typed vec3 (what they are in the shader): @types/three's 'color' node type lacks the vec3 operators (addAssign ...)
 * @typedef {{ uTop: N<'vec3'>, uHorizon: N<'vec3'>, uSunColor: N<'vec3'>, uMoonColor: N<'vec3'>, uCloudColor: N<'vec3'>,
 *   uCloudShade: N<'vec3'>, uFogColor: N<'vec3'>, uSunDir: N<'vec3'>, uCloudWeights: N<'vec3'>, uSkyCloudSpeed: N<'vec2'>, uCloudFade: N<'vec2'>,
 *   uCloudMul: N<'vec2'>, uNight: N<'float'>, uSunSize: N<'float'>, uSunGlow: N<'float'>, uSunBrightness: N<'float'>, uMoonBrightness: N<'float'>,
 *   uMoonSize: N<'float'>, uTime: N<'float'>, uWeatherCloud: N<'float'>, uCloudCover: N<'float'>, uSkyCloudScale: N<'float'>, uStars: N<'float'>,
 *   uStarCloudDim: N<'float'>, uStarScale: N<'float'>, uSkyCurve: N<'float'>, uCloudHorizon: N<'float'>, uCloudOpacity: N<'float'>,
 *   uCloudSoft: N<'float'>, uCloudRelief: N<'float'>, uFogBand: N<'float'>, [k: string]: any }} SkyNodes
 */

/** sky.uniforms -> nodes: engine.uniforms entries through uniforms(engine), the sky's own { value } objects read back every render */
/** @returns {SkyNodes} */
function nodesOf(u, engine) {
  const E = engineUniforms(engine), n = /** @type {SkyNodes} */ ({});
  for (const [k, o] of Object.entries(u)) {
    if (engine.uniforms[k] === o) { n[k] = E[k]; continue; }   // shared object (makeSkyUniforms puts engine.uniforms.uSunDir in): no second node
    const v = o.value;
    if (typeof v !== 'number' && !v?.isVector2 && !v?.isVector3 && !v?.isColor) continue;
    // read back every render, also for vectors / colors: uFogColor is a getter (the fog object's color, which a game may replace)
    n[k] = valueNode(o);
  }
  return n;
}

/** clouds dim toward SKY.nightDim at night (GLSL nightDim + (1 - nightDim) * (1 - night)) */
const nightDim = (/** @type {SkyNodes} */ U) => U.uNight.oneMinus().mul(1 - K.nightDim).add(K.nightDim);

// The built-in cloud kinds (clouds.js PLANE / CUMULUS); same arguments as threedogClouds(d, time, sunDir, night, lit, shade, cov)
/** @type {Record<string, (U: SkyNodes, d: N<'vec3'>, cov: N<'float'>) => N<'vec4'>>} */
const CLOUDS = {
  plane: (U, d, cov) => {
    const cp = d.xz.div(d.y.add(U.uCloudHorizon)).mul(U.uSkyCloudScale).add(U.uSkyCloudSpeed.mul(U.uTime));
    const cn = noise(cp).mul(U.uCloudWeights.x).add(noise(cp.mul(U.uCloudMul.x).add(7)).mul(U.uCloudWeights.y)).add(noise(cp.mul(U.uCloudMul.y)).mul(U.uCloudWeights.z));
    const lo = cov.oneMinus();
    const cloud = smoothstep(lo, lo.add(U.uCloudSoft), cn).mul(smoothstep(U.uCloudFade.x, U.uCloudFade.y, d.y));
    const cc = mix(U.uCloudShade, U.uCloudColor, smoothstep(K.planeTone[0], K.planeTone[1], cn)).mul(nightDim(U));
    return vec4(cc, cloud.mul(U.uCloudOpacity));
  },
  cumulus: (U, d, cov) => {
    // threedogCumulusDensity: the 4-octave loop unrolled (JS builds the same four steps)
    const density = (/** @type {N<'vec2'>} */ p0) => {
      /** @type {N<'float'>} */ let s = float(0);
      let p = p0, a = 0.5;
      for (let i = 0; i < 4; i++) { s = s.add(noise(p).mul(a)); p = p.mul(K.lacunarity).add(K.offset); a *= 0.5; }
      return s.div(K.norm);
    };
    const cp = d.xz.div(d.y.add(U.uCloudHorizon)).mul(U.uSkyCloudScale).add(U.uSkyCloudSpeed.mul(U.uTime));
    const toSun = normalize(U.uSunDir.xz.add(vec2(0.0001, 0))).mul(K.toSun);
    const n0 = density(cp).toVar(), n1 = density(cp.add(toSun));
    const t = cov.mul(K.cover).oneMinus();
    const body = smoothstep(t, t.add(U.uCloudSoft), n0), core = smoothstep(t, t.add(K.core), n0);
    const sunSide = clamp(n0.sub(n1).mul(U.uCloudRelief).add(0.5), 0, 1);
    const light = mix(sunSide, float(1), core.oneMinus().mul(K.rim)).mul(core.mul(0.5).oneMinus().mul(K.coreDark).add(1 - K.coreDark));
    const cc = mix(U.uCloudShade, U.uCloudColor, light).mul(nightDim(U));
    return vec4(cc, body.mul(smoothstep(U.uCloudFade.x, U.uCloudFade.y, d.y)).mul(U.uCloudOpacity));
  },
};

/** Run a hook's tsl code; a throw or a non-node result is named after the hook, so the error points at the game's own code */
function runHook(where, fn, ctx) {
  let v;
  try { v = fn(ctx); }
  catch (e) { throw Object.assign(codedError('sky-option', `[sky] ${where} tsl: ${e?.message ?? e}`), { cause: e }); }
  if (!v?.isNode) throw codedError('sky-option', `[sky] ${where} tsl must return a vec4 node (rgb, amount), got ${v === null ? 'null' : typeof v}`);
  return v;
}

/**
 * The hooks a node dome draws, checked: each needs its tsl form (GLSL text has no node form), and each is run once on stand-in values now, so a
 * typo throws at the patch / sky() call instead of at the first draw (patchNodes.tsl.js does the same for its build-time slots).
 * @param {any} cloudsHook engine.sky.clouds(spec) value (GLSL string | { glsl?, tsl?, uniforms? }) or null
 * @param {{ tsl?: Function, blend: string, where: string }[]} layers resolved dome layers (domeLayers.js, gpu mode)
 * @param {Record<string, any>} U the dome uniforms as nodes (the real ones: a hook reading ctx.uniforms.uMine is checked too)
 * @returns {Function | null} the clouds tsl code
 */
function checkHooks(cloudsHook, layers, U) {
  const h = typeof cloudsHook === 'string' ? { glsl: cloudsHook } : cloudsHook;
  if (h != null && typeof h.tsl !== 'function') throw glslPart('engine.sky.clouds()');
  for (const l of layers) if (typeof l.tsl !== 'function') throw glslPart(l.where);
  const v3 = vec3(0, 1, 0), f = float(0.5), stand = { dir: v3, time: f, sunDir: v3, night: f, uniforms: U, fx: FX, tsl: TSL };
  if (h) runHook('engine.sky.clouds()', h.tsl, { ...stand, lit: v3, shade: v3, cover: f, clouds: vec4(0) });
  for (const l of layers) runHook(l.where, l.tsl, { ...stand, color: v3 });
  return h?.tsl ?? null;
}

/**
 * The dome's color node (the domeFragment math) over sky.uniforms, with the hooks' tsl code where the GLSL calls its functions.
 * @param {SkyNodes} U nodes of sky.uniforms @param {string} kind built-in cloud kind
 * @param {Function | null} clouds engine.sky.clouds(spec) tsl @param {{ tsl: Function, blend: string, where: string }[]} layers
 */
function domeColor(U, kind, clouds, layers) {
  // unit sphere: positionGeometry is already unit length at the vertices, normalized again per pixel like GLSL normalize(vDir)
  const vDir = varying(normalize(positionGeometry));
  return Fn(() => {
    const d = normalize(vDir).toVar();
    const y = max(d.y, 0);
    const col = select(d.y.lessThan(0), U.uHorizon, mix(U.uHorizon, U.uTop, pow(y, U.uSkyCurve))).toVar();
    const sd = max(dot(d, U.uSunDir), 0);
    col.addAssign(U.uSunColor.mul(pow(sd, U.uSunSize).mul(U.uSunBrightness).add(pow(sd, K.glowPower).mul(U.uSunGlow))).mul(step(0, U.uSunDir.y.add(K.sunCut))));
    const md = max(dot(d, U.uSunDir.negate()), 0);
    col.addAssign(U.uMoonColor.mul(pow(md, U.uMoonSize)).mul(U.uMoonBrightness).mul(U.uNight));
    const g = floor(d.mul(U.uStarScale));
    const cov = U.uWeatherCloud.mul(U.uCloudCover), clA = float(0).toVar();
    // what every hook gets: the arguments its GLSL function takes, the dome's uniforms as nodes, the noise functions and three/tsl
    const base = { dir: d, time: U.uTime, sunDir: U.uSunDir, night: U.uNight, uniforms: U, fx: FX, tsl: TSL };
    If(d.y.greaterThan(0).and(cov.greaterThan(0.01)), () => {
      // engine.sky.clouds(spec) tsl: ctx.clouds is the built-in kind's result (the value so far), built only when the code reads it
      const cl = (clouds ? runHook('engine.sky.clouds()', clouds, { ...base, lit: U.uCloudColor, shade: U.uCloudShade, cover: cov,
        get clouds() { return CLOUDS[kind](U, d, cov); } }) : CLOUDS[kind](U, d, cov)).toVar();
      col.assign(mix(col, cl.rgb, cl.a)); clA.assign(cl.a);
    });
    // stars behind the clouds, dimmed by the weather's cover (see the GLSL comment in shader.js)
    const star = step(U.uStars.oneMinus(), hash(vec2(g.x.add(g.z.mul(K.starZ)), g.y))).mul(U.uNight).mul(smoothstep(0, K.starFade, d.y)).mul(clA.oneMinus())
      .mul(clamp(U.uWeatherCloud, 0, 1).mul(U.uStarCloudDim).oneMinus());
    col.addAssign(vec3(star));
    // fog band (fog.js DOME_FOG): always built, switched by uFogBand
    col.assign(mix(col, U.uFogColor, U.uFogBand.mul(smoothstep(-0.02, 0.15, d.y).oneMinus())));
    // dome layers after the fog band, in their resolved order, as the GLSL body appends them; ctx.color is the sky so far
    for (const l of layers) {
      const L = runHook(l.where, l.tsl, { ...base, color: col }).toVar();
      if (l.blend === 'add') col.addAssign(L.rgb.mul(L.a)); else col.assign(mix(col, L.rgb, L.a));
    }
    return vec4(col, 1);
  })();
}

/**
 * The dome material: MeshBasicNodeMaterial with the domeFragment math as its colorNode, reading sky.uniforms.
 * @param {Record<string, { value: any }>} u sky.uniforms (makeSkyUniforms + prepareDome) @param {any} st the sky() options
 * @param {string} kind cloud kind @param {any} engine
 * @param {{ clouds?: any, layers?: any[] }} [hooks] clouds hook value and resolved dome layers (shader.js / dome.js resolve them)
 */
function domeMaterial(u, st, kind, engine, hooks = {}) {
  const m = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false, fog: false });
  setHooks(m, u, kind, engine, hooks);
  return m;
}

/**
 * Point a node dome at new hooks (engine.sky.clouds / layer rebuild): checked first, so a bad hook throws with the dome unchanged; then a new color node
 * (one recompile, like the GLSL dome's new fragment text). The nodes are made again here: a hook may have brought uniforms of its own.
 */
function setHooks(m, u, kind, engine, { clouds = null, layers = [] } = {}) {
  const U = nodesOf(u, engine), fn = checkHooks(clouds, layers, U);
  m.colorNode = domeColor(U, kind, fn, layers);
  m.needsUpdate = true;
}

/** A GLSL-only sky hook on WebGPU: named, with the ways that do draw there. Why throw: a dome missing its layers is a wrong sky, not a neutral one */
const glslPart = what => codedError('webgpu-needs-tsl', `[sky] ${what} is GLSL only, which does not draw on WebGPURenderer: give it a tsl form too ` +
  "(tsl: (ctx) => vec4 node, recipe 52 'tsl forms'), keep this sky on WebGLRenderer, or draw your own sky object (engine.sky.replace(object), " +
  "e.g. three's SkyMesh from three/addons/objects/SkyMesh.js)");

registerWebGPUPart('sky', Object.freeze({ domeMaterial, setHooks, kinds: Object.freeze(Object.keys(CLOUDS)) }));
