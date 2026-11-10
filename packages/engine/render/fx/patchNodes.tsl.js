// TSL side of shader patches: what a patch's `tsl` field does on a NodeMaterial (WebGPURenderer), slot by slot (render/slots.js).
// Why a registry instead of an import: render/patches.js is in every WebGL game's bundle and must not pull in three/tsl, so this module
// (loaded with threedog/tsl, i.e. only on the WebGPU route) registers itself (render/backend.js registerWebGPUPart) and patches.js looks it up when a
// NodeMaterial gets patches. One list per material (patches.js keeps it, with the same conflict / needs / replace-by-name rules as GLSL);
// this file only turns that list into nodes.
//
// Where each slot lands (and why it is not always the NodeMaterial property of the same name):
//   position / shadowPosition / clipPosition / map / roughness / emissive: the properties positionNode / castShadowPositionNode / vertexNode /
//     colorNode / roughnessNode / emissiveNode. position must be the property: three's shadow pass reads material.positionNode
//     (Renderer._getShadowNodes), which is how a swaying tree's shadow sways with no depth material. These become instance accessors:
//     the getter returns the chain, a game's own assignment (before or after patching) becomes the chain's starting value.
//     position / shadowPosition run where GLSL runs them: on the object-space vertex before morphs, skinning, batching and instancing
//     (three applies positionNode after all of those). The property holds a stand-in node; NodeMaterial.setupPosition (wrapped once below,
//     for every NodeMaterial including three's shadow-pass material) runs the patch chain first, then three's own steps. A game's own
//     positionNode keeps three's meaning (applied after instancing).
//   color: after setupDiffuseColor, so ctx.color already has the map and vertex / instance colors (colorNode is applied before them).
//   normal: around setupNormal (ctx.normal = what three would use: normalNode or the normal map, view space).
//   output: around setupOutput, before fog (outputNode would come after fog, unlike the GLSL slot).
//   lighting: the material's own LightingModel wrapped (setupLightingModel); code runs at the end of start(), after every light and the
//     ambient are summed into reflectedLight but before LightsNode adds them up (measured in experiment E2: finish() is too late).
// Chaining: patches on one slot run in the order added, each ctx carrying the value so far (same rule as GLSL).
import * as TSL from 'three/tsl';
import { NodeMaterial, LightingNode } from 'three/webgpu';
import { codedError } from '../../core/base/errorHints.js';
import * as LIBRARY from './library.tsl.js';
import { lit } from '../lit.js';
import { engineNodes, valueNode } from './uniforms.tsl.js';
import { registerWebGPUPart } from '../backend.js';
import { engineUniformName } from '../engineUniforms.js';
import { SLOTS, LIGHT_HOOKS as HOOKS } from '../slots.js';
import { notePatch } from '../../core/scene/threePatches.js';
const WRAPPED = Symbol.for('threedog.patchWrapper');   // the same key as render/patches.js WRAPPED (a registry symbol, so this WebGL-free file need not import it)
import { nameNodeBuild, lostStatements } from './nodeErrors.tsl.js';

const { Fn, positionLocal, modelViewProjection, materialColor, materialRoughness, materialEmissive, materialNormal, diffuseColor, vec3 } = TSL;

/** One engine uniform as a node, looked up from the renderer compiling it (same as the Fn library) */
const engineUniform = name => Fn((_, builder) => {
  const n = engineNodes(builder, 'patch')[name];
  if (!n) throw codedError('tsl-misuse', `threedog/tsl: engine.uniforms has no '${name}'`);
  return n;
})();
// A patch's own uniforms ({ value } objects, shared with its GLSL side) as nodes: one node per object, reading the object every render, so
// detail.strength or the water's fresnel set live move both renderers. An engine uniform (engine.uniforms.uTime in the water patches) goes
// through engineUniform instead: resolved per compiling renderer, like resolveUniform on the GLSL side.
const OWN = new WeakMap();
/** @param {{ value: any }} o */
const patchUniform = o => {
  const eng = engineUniformName(o);
  if (eng) return engineUniform(eng);
  let n = OWN.get(o);
  if (!n) OWN.set(o, n = valueNode(o));   // render group: a 'color' / 'output' / 'lighting' patch leaves the material without node properties
  return n;
};
/** Sample the texture held by a { value } object at uv; the node reads o.value, so a texture that finishes loading later (value swapped) is used */
const patchTexture = (o, uv) => {
  const n = TSL.texture(o.value, uv);
  Object.defineProperty(n, 'value', { configurable: true, get: () => o.value, set(v) { o.value = v; } });
  return n;
};
/** What a patch's tsl code gets besides the slot value: the threedog/tsl functions and three/tsl itself (so engine files need no import) */
const FX = Object.freeze({ ...LIBRARY, uniform: engineUniform, patchUniform, patchTexture });

// slot -> [property, default value when the material has none]; built from the slot table's node column (render/slots.js), so the table cannot
// list a mapping this file lacks. The default is what three uses without the property.
const DEFAULTS = { positionNode: () => positionLocal, castShadowPositionNode: () => positionLocal, vertexNode: () => modelViewProjection,
  colorNode: () => materialColor, roughnessNode: () => materialRoughness, emissiveNode: () => materialEmissive };
const PROPS = Object.fromEntries(Object.entries(SLOTS).filter(([, s]) => s.node?.prop).map(([n, s]) => {
  if (!DEFAULTS[s.node.prop]) throw codedError('shader-patch', `[threedog] render/slots.js names node property '${s.node.prop}' for slot '${n}', which patchNodes.tsl.js has no default for`);
  return [n, [s.node.prop, DEFAULTS[s.node.prop]]];
}));
// position chains, by their stand-in node: what setupPosition runs before three's morph / skinning / instancing steps
// The registry lives on the shared wrapper below (a second copy of this module, hot reload or another URL, finds the first copy's wrapper and must fill the same map)
const setupPosition = NodeMaterial.prototype.setupPosition;
/** @type {WeakMap<object, any>} */
const PRE = /** @type {any} */ (setupPosition)._threedogPre ?? new WeakMap();
/**
 * The stand-in for a position chain: evaluates to the game's own value (or positionLocal, i.e. leaves three's result as it is) where three
 * applies positionNode, while the chain itself runs at the start of setupPosition. Its cache key is the chain's, so a different chain is a
 * different program. @param {any} chain @param {any} base
 */
function preMarker(chain, base) {
  const m = Fn(() => base ?? positionLocal)();
  m.customCacheKey = () => chain.getCacheKey();
  PRE.set(m, chain);
  return m;
}
// Why the prototype and not each material: three's shadow pass draws with its own NodeMaterial, handed our positionNode / castShadowPositionNode
// (Renderer._getShadowNodes), and the shadow must sway exactly like the surface. Only materials carrying one of our stand-ins are affected.
if (!(/** @type {any} */ (setupPosition))._threedogPre) {   // already wrapped (module loaded twice)
  NodeMaterial.prototype.setupPosition = Object.assign(function (builder) {
    const chain = PRE.get(this.positionNode);
    if (chain) positionLocal.assign(TSL.subBuild(chain, 'POSITION', 'vec3'));
    return setupPosition.call(this, builder);
  }, { _threedogPre: PRE });
  notePatch('node-setup-position', 'NodeMaterial.prototype.setupPosition: runs the vertex-moving patch chain before three builds the position (WebGPU wind and its shadow)',
    () => { NodeMaterial.prototype.setupPosition = setupPosition; }, { lost: 'on WebGPURenderer, wind and other vertex-moving patches no longer move vertices or their shadow' });
}

const BUILT = Object.keys(SLOTS).filter(n => SLOTS[n].node?.setup);   // slots handled inside three's setup methods
const LIGHT_KEYS = ['directDiffuse', 'directSpecular', 'indirectDiffuse', 'indirectSpecular'];

/** The patch's code for a slot as { start?, light?, direct?, after? } (lighting) or a function, or undefined */
const codeOf = (p, slot) => p.tsl?.[slot];
const prefix = (p, slot) => `[threedog] patch '${p.name}' (slot ${slot})`;

/**
 * Run one patch's code with the try the error prefix needs; `want` checks the result. The nodes it returns carry the prefix into three's
 * later build (nameNodeBuild), and statements it issues outside three's build are named in dev (lostStatements). probe: false inside the
 * build (ctx.builder: a stack is there, so a Loop is fine) and for compute()'s stand-in runs of the build-time slots, whose real run is there.
 */
function run(p, slot, fn, ctx, want = 'node', probe = !ctx.builder) {
  let v;
  try { v = probe ? lostStatements(prefix(p, slot), () => fn(ctx)) : fn(ctx); }
  catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith(prefix(p, slot))) throw e;
    const err = Object.assign(codedError('shader-patch', `${prefix(p, slot)}: ${msg}`), { cause: e });
    // the stack of the error that happened (the game's patch line first), not of this wrapper: devtools and three's 'TSL:' build-error log
    // (StackTrace, first non-three frame) would otherwise point at this file. Chrome frames are '    at ...', Firefox / Safari 'fn@file:line:col'
    const frames = String(e?.stack ?? '').split('\n').filter(l => /^\s+at |@.+:\d+:\d+$/.test(l));
    if (frames.length) err.stack = `${err.name}: ${err.message}\n${frames.join('\n')}`;
    throw err;
  }
  if (want === 'node' && !v?.isNode) throw codedError('shader-patch', `${prefix(p, slot)}: tsl must return a node (the new ${slot} value), got ${v === null ? 'null' : typeof v}`);
  if (want === 'light' && v != null) {
    const bad = typeof v !== 'object' ? [String(v)] : Object.keys(v).filter(k => !LIGHT_KEYS.includes(k) || !v[k]?.isNode);
    if (bad.length) throw codedError('shader-patch', `${prefix(p, slot)}: tsl returns nothing or { ${LIGHT_KEYS.join(', ')} } as nodes; got ${bad.join(', ')}`);
    for (const k in v || {}) nameNodeBuild(v[k], prefix(p, slot), ctx[k]);
  }
  return want === 'node' ? nameNodeBuild(v, prefix(p, slot), ctx[slot]) : v;
}

/** Fold every patch's code for one value slot over `value` (the value so far), in list order */
const chain = (list, slot, value, extra) => list.reduce((v, p) => { const fn = codeOf(p, slot);
  return typeof fn === 'function' ? run(p, slot, fn, { ...extra, [slot]: v }) : v; }, value);

/** lighting hooks of a patch, normalised: a function is the end-of-lighting code */
const hooksOf = h => typeof h === 'function' ? { after: h } : h;

/**
 * Why this material cannot take the patch on the TSL side ('' = fine). patches.js throws it (strict) or skips with a warning, like a missing GLSL anchor.
 * m is a NodeMaterial, or a classic material whose node twin three builds (same lit / roughness facts).
 * @param {any} m @param {any} p
 */
function gaps(m, p) {
  const out = [];
  for (const slot of Object.keys(p.tsl || {})) {
    if (!(slot in PROPS) && !BUILT.includes(slot)) out.push(`slot '${slot}' is WebGL only (render/slots.js has no NodeMaterial place for it)`);
    // MeshBasicNodeMaterial has lights = true (for light maps) but no direct lighting, as MeshBasicMaterial has no lights chunk in GLSL
    else if (slot === 'lighting' && !lit(m)) out.push(`slot 'lighting' needs a lit material (${m.type} has no lights)`);
    else if (slot === 'roughness' && m.roughness === undefined) out.push(`slot 'roughness' needs a standard / physical material`);
    const h = p.tsl[slot];
    if (slot === 'lighting' ? !(typeof h === 'function' || (h && typeof h === 'object' && HOOKS.some(k => typeof h[k] === 'function')))
      : typeof h !== 'function') out.push(`slot '${slot}' code must be (ctx) => node` + (slot === 'lighting' ? ' or { start?, light?, direct?, after? }' : ''));
  }
  return out.length ? `patch '${p.name}': ${out.join('; ')}` : '';
}

// The nodes a patch list turns into, kept per SOURCE material: a NodeMaterial patched directly, or a classic material (MeshLambertMaterial ...)
// patched for both renderers. Why classic materials too: the engine's own materials (terrain, vegetation, water) stay classic so
// one material object draws on WebGLRenderer (GLSL side) and on WebGPURenderer, including fallback: 'webgl', which is decided only in start().
// three's WebGPURenderer turns a classic material into a fresh node twin per build (NodeLibrary.fromMaterial); render/patches.js wraps that
// one call so the twin gets these nodes (dress). The source keeps them too, as non-enumerable accessors: three's shadow pass reads
// positionNode / castShadowPositionNode off the drawn (classic) material, which is how a swaying tree's shadow sways.
const STATE = new WeakMap();   // source -> { list, own (game values of PROPS), out (chained PROPS), color, key, fresh, error }
// chained node -> the game value it was built on. Why: three's NodeMaterial.copy reads source.positionNode through the accessor, i.e. the
// chain, and stores it as the copy's own value; copyPatches would then chain the same patches on top again (the effect applied twice)
const BASE = new WeakMap();
const baseOf = v => (v && BASE.has(v) ? BASE.get(v) : v ?? null);
// listOf / src: set for a classic source only (its list lives in patches.js), so a stale state rebuilds itself when read
const newState = () => ({ list: [], own: {}, out: {}, color: null, key: '', fresh: false, error: null, listOf: null, src: null });

/**
 * Accessors for every PROPS property on target, reading st (the chain, else the game's own value). enumerable: a NodeMaterial's own
 * properties (three keys its program by them); a classic material or a node twin gets hidden ones (three's program key for those is the
 * classic material's customProgramCacheKey, render/patches.js).
 */
function accessors(target, st, enumerable) {
  for (const [prop] of Object.values(PROPS)) {
    if (enumerable) st.own[prop] = baseOf(target[prop]);
    Object.defineProperty(target, prop, { configurable: true, enumerable, get: () => { if (!st.fresh && st.listOf) classic(st.src, st.listOf()); return st.out[prop] ?? st.own[prop] ?? null; },
      set(v) { st.own[prop] = v ?? null; st.fresh = false; if (enumerable) compute(target, st); target.needsUpdate = true; } });
  }
}

/** fn, marked as the engine's wrapper of inner (the game's own method or three's): cloneMaterial carries inner, never fn, which runs this material's st */
const wrapper = (fn, inner) => Object.assign(fn, { [WRAPPED]: () => inner });
/** Wrap three's setup methods of the NodeMaterial m (a patched one, or a classic material's node twin) to run st's color / normal / output / lighting code */
function wrapSetup(m, st, src) {
  const ctx = extra => ({ fx: FX, tsl: TSL, material: src, ...extra });
  const diffuse = m.setupDiffuseColor, normal = m.setupNormal, output = m.setupOutput, model = m.setupLightingModel;
  m.setupDiffuseColor = wrapper(function (builder) { const r = diffuse.call(this, builder); if (st.color) diffuseColor.assign(st.color); return r; }, diffuse);
  m.setupNormal = wrapper(function (builder) { return chain(st.list, 'normal', normal.call(this, builder), ctx({ builder })); }, normal);
  m.setupOutput = wrapper(function (builder, node) { return output.call(this, builder, chain(st.list, 'output', node, ctx({ builder }))); }, output);
  m.setupLightingModel = wrapper(function (builder) {
    const lm = model.call(this, builder);
    const hooks = st.list.filter(p => codeOf(p, 'lighting')).map(p => [p, hooksOf(codeOf(p, 'lighting'))]);
    if (!lm || !hooks.length) return lm;
    // Why each direct hook adds into its own light sums: on WebGL every lighting patch runs after three's light loop, in list order, so
    // light a patch adds is scaled only by the patches after it. Here direct() runs inside the loop; added straight into reflectedLight it
    // would be scaled by every after() (the clouds patch darkened the lighting patch's wrap light on WebGPU only). Each patch's sums join
    // reflectedLight at its own place in the list, right before its after().
    const { start, direct } = lm, states = hooks.map(() => ({}));
    let sums = [];
    const light = (rl, i, b) => ctx({ builder: b, state: states[i], reflectedLight: rl, ...Object.fromEntries(LIGHT_KEYS.map(k => [k, rl[k]])) });
    lm.start = function (b) {
      const rl = b.context.reflectedLight;
      sums = hooks.map(([, h], i) => h.direct ? Object.fromEntries(LIGHT_KEYS.map(k => [k, vec3(0).toVar(`tdLight${i}_${k}`)])) : null);
      hooks.forEach(([p, h], i) => h.start && run(p, 'lighting', h.start, light(rl, i, b), 'any'));
      start.call(this, b);
      hooks.forEach(([p, h], i) => {
        if (sums[i]) for (const k of LIGHT_KEYS) rl[k].addAssign(sums[i][k]);
        if (!h.after) return;
        const v = run(p, 'lighting', h.after, light(rl, i, b), 'light');
        for (const k in v || {}) rl[k].assign(v[k]);
      });
    };
    lm.direct = function (data, b) {
      const ln = data.lightNode;
      // the light as a patch needs it: direction and color (shadow already multiplied in), its shadow factor alone, whether it is the sun
      const L = { direction: data.lightDirection, color: data.lightColor, shadow: ln?.shadowNode ? ln.shadowNode.x : null,
        directional: !!ln?.light?.isDirectionalLight, light: ln?.light ?? null };
      // light(light, ctx) hooks first, in list order: a new color for this one light before three lights the surface with it (the cloud
      // shadow dims the sun only; GLSL does the same by wrapping three's getDirectionalLightInfo in lightsPars). direct() sees the color as
      // three gave it, as GLSL code reading directionalLights[i].color does
      let color = data.lightColor;
      hooks.forEach(([p, h], i) => {
        if (!h.light) return;
        const v = run(p, 'lighting', c => h.light({ ...L, color }, c), light(sums[i] ?? data.reflectedLight, i, b), 'any');
        if (v == null) return;
        if (!v.isNode) throw codedError('shader-patch', `${prefix(p, 'lighting')}: light() returns the light's new color as a node, or nothing; got ${typeof v}`);
        color = v;
      });
      const r = direct.call(this, color === data.lightColor ? data : { ...data, lightColor: color }, b);
      hooks.forEach(([p, h], i) => h.direct && run(p, 'lighting', c => h.direct(L, c), light(sums[i], i, b), 'any'));
      return r;
    };
    return lm;
  }, model);
}

/** Install the accessors and method wrappers once on a NodeMaterial patched directly */
function install(m) {
  const st = newState();
  STATE.set(m, st);
  accessors(m, st, true);
  wrapSetup(m, st, m);
  // clone() carries no patches (as on the GLSL side, where Material.copy skips onBeforeCompile): the copy gets the game's own values, not the
  // chains, so a clone without copyPatches is the plain material and one with copyPatches has each effect once
  const clone = m.clone, key = m.customProgramCacheKey;
  m.clone = wrapper(function () {
    const c = clone.call(this);
    for (const [prop] of Object.values(PROPS)) if (c[prop] === st.out[prop]) c[prop] = st.own[prop];
    return c;
  }, clone);
  // three keys NodeMaterial programs by their node properties only; code added inside the setup methods is not one, so two materials
  // differing only in a color / normal / output / lighting patch would share a program. st.key is built from those patches' node graphs
  m.customProgramCacheKey = wrapper(function () { return key.call(this) + (st.key ? '|threedog:' + st.key : ''); }, key);
  return st;
}

/** Recompute everything the list decides (called on every change): chained properties, the color node, the cache key */
function compute(m, st) {
  const extra = { fx: FX, tsl: TSL, material: m };
  const out = {};
  for (const [slot, [prop, dflt]] of Object.entries(PROPS)) {
    if (slot === 'shadowPosition') {
      // the shadow passes run the vertex code of shadow: true patches only, each one's shadowPosition code where it has one, else its
      // position code (the GLSL rule: patches.js shadowMaterial). three's shadow pass reads castShadowPositionNode before positionNode, so it
      // is set whenever the two differ: a shadow: false patch then moves the surface but not its shadow, on both renderers
      if (!st.list.some(p => codeOf(p, 'shadowPosition') || (codeOf(p, 'position') && !p.shadow))) continue;
      const c = st.list.reduce((v, p) => { const s = !p.shadow ? null : codeOf(p, 'shadowPosition') ? 'shadowPosition' : codeOf(p, 'position') ? 'position' : null;
        return s ? run(p, s, codeOf(p, s), { ...extra, position: v }) : v; }, positionLocal);
      out[prop] = preMarker(c, st.own[prop] ?? st.own.positionNode);
    } else if (!st.list.some(p => typeof codeOf(p, slot) === 'function')) continue;
    else if (slot === 'position') out[prop] = preMarker(chain(st.list, slot, positionLocal, extra), st.own[prop]);
    else out[prop] = chain(st.list, slot, st.own[prop] ?? dflt(), extra);
  }
  const color = st.list.some(p => codeOf(p, 'color')) ? chain(st.list, 'color', diffuseColor, extra) : null;
  // the build-time slots are also run once here on stand-in values: a typo in the code fails now, at the call that added the patch,
  // and the node graphs it returns key the program (customProgramCacheKey above)
  const keys = [];
  for (const p of st.list) {
    const parts = [p.name + '=' + (p.cacheKey ?? '')];
    if (codeOf(p, 'normal')) parts.push(run(p, 'normal', codeOf(p, 'normal'), { ...extra, normal: materialNormal }, 'node', false).getCacheKey(true));
    if (codeOf(p, 'output')) parts.push(run(p, 'output', codeOf(p, 'output'), { ...extra, output: TSL.vec4(0) }, 'node', false).getCacheKey(true));
    const h = codeOf(p, 'lighting');
    if (typeof h === 'function') {
      const v = run(p, 'lighting', h, { ...extra, state: {}, ...Object.fromEntries(LIGHT_KEYS.map(k => [k, vec3(0)])) }, 'light', false);
      for (const k in v || {}) parts.push(k + v[k].getCacheKey(true));
    } else if (h) parts.push(Object.values(h).map(String).join());   // hook objects: their text (put values that change the code into cacheKey)
    if (codeOf(p, 'color')) parts.push('c');
    keys.push(parts.join(':'));
  }
  for (const prop in out) BASE.set(out[prop], st.own[prop]);
  st.out = out; st.color = color; st.key = (color ? color.getCacheKey(true) + ',' : '') + keys.join(',');
  st.fresh = true;
}

/**
 * Make the material's nodes follow its patch list (patchMaterial / unpatchMaterial / copyPatches call it after every change on a NodeMaterial)
 * @param {any} m @param {any[]} list
 */
function apply(m, list) {
  const st = STATE.get(m) || install(m);
  const prev = st.list;
  st.list = list.slice();
  try { compute(m, st); } catch (e) { st.list = prev; compute(m, st); throw e; }
}

// ---------- classic materials (one material, both renderers) ----------

/** Why a patch on a classic material does nothing on WebGPURenderer, or '' (its GLSL is never compiled there) @param {any} m @param {any} p */
function noNodeForm(m, p) {
  if (p.tsl == null && p.glsl != null) return `patch '${p.name}' on ${m.type}${m.name ? ` '${m.name}'` : ''} is GLSL only, which WebGPURenderer never compiles: `
    + 'give it a tsl version next to glsl (recipe 43), or stay on WebGL (no renderer option)';
  return gaps(m, p);
}

/** The state of a classic source material for its current list, computed when stale; a patch that cannot run is kept as st.error, not thrown */
function classic(src, list) {
  const st = classicState(src);
  if (st.fresh) return st;
  st.list = list.slice();
  st.error = null;
  try {
    const bad = list.map(p => noNodeForm(src, p)).find(Boolean);
    if (bad) throw codedError('webgpu-needs-tsl', `[threedog] ${bad}`);
    compute(src, st);
  } catch (e) {
    // drawn without its patches instead of a frame loop that throws: start() and every later add name it (render/backend.js webglOnlyOn)
    st.error = e; st.list = []; st.out = {}; st.color = null; st.key = ''; st.fresh = true;
  }
  return st;
}

/**
 * A classic material's patch list changed (patches.js): its nodes are rebuilt on the next read. The hidden accessors are installed on the
 * first change, so the shadow pass finds positionNode even before the color pass converted the material.
 * @param {any} src @param {() => any[]} listOf  the material's current list
 */
function invalidate(src, listOf) { const st = classicState(src); st.listOf = listOf; st.fresh = false; }

/** A classic source's state, made (with its hidden accessors) on first use @param {any} src */
function classicState(src) {
  let st = STATE.get(src);
  if (!st) { STATE.set(src, st = newState()); st.src = src; accessors(src, st, false); }
  return st;
}

/**
 * Give the node twin three just made of a classic material (NodeLibrary.fromMaterial) the source's patch nodes; returns the twin
 * @param {any} twin @param {any} src @param {any[]} list
 */
function dress(twin, src, list) {
  environmentDiffuse(twin);
  if (!list.length) return twin;
  const st = classic(src, list);
  if (!st.list.length) return twin;
  accessors(twin, st, false);
  wrapSetup(twin, st, src);
  return twin;
}

// Lambert / Phong twins: diffuse light from scene.environment, as WebGLRenderer gives the classic material. Why: three 0.187's WebGLRenderer
// lights MeshLambertMaterial / MeshPhongMaterial without an envMap of their own with scene.environment's irradiance (WebGLPrograms: PMREM
// for Lambert / Phong, lights_fragment_maps getIBLIrradiance), but their node twins (BasicEnvironmentNode) read only material.envMap, so on
// WebGPU every engine Lambert / Phong surface lost the room map's (or sky map's) fill: terrain and trees about 4% darker on the whole picture,
// a plain gray plane 30% darker (tests/specs/engine-webgpu.mjs measures both routes). Same formula as GLSL getIBLIrradiance:
// PI * the roughest PMREM level along the world normal (env rotation applied) * scene.environmentIntensity, added to the indirect irradiance.
class EnvironmentDiffuse extends LightingNode {
  /** @param {any} envNode builder.environmentNode (a texture node of scene.environment) */
  constructor(envNode) { super(); this.envNode = envNode; this.pmrem = null; this.updateBeforeType = TSL.NodeUpdateType.RENDER; }
  // setup and updateBefore return nothing, like three's own EnvironmentNode (@types/three declares a Node / boolean result): typed any for that
  /** @param {any} builder @returns {any} */
  setup(builder) {
    this.pmrem = TSL.pmremTexture(this.envNode.value, TSL.materialEnvRotation.mul(TSL.normalWorld), TSL.float(1));
    builder.context.irradiance.addAssign(this.pmrem.mul(Math.PI).mul(TSL.materialEnvIntensity).rgb);
  }
  // the scene's environment can change without a rebuild (as three's EnvironmentNode allows)
  /** @param {any} frame @returns {any} */
  updateBefore(frame) { const t = this.envNode.value; if (this.pmrem && t && this.pmrem.value !== t) { this.pmrem.value = t; this.pmrem.updateBefore(frame); } }
}
/** @param {any} twin a node twin three just made of a classic material */
function environmentDiffuse(twin) {
  if (!(twin.isMeshLambertNodeMaterial || twin.isMeshPhongNodeMaterial)) return;
  const own = twin.setupEnvironment;
  twin.setupEnvironment = function (builder) {
    const env = own.call(this, builder);
    return env || this.envMap || !builder.environmentNode ? env : new EnvironmentDiffuse(builder.environmentNode);
  };
}

/** Why the classic material's patches do not all draw on WebGPURenderer (the message), or null @param {any} src @param {any[]} list */
const problem = (src, list) => classic(src, list).error?.message ?? null;

registerWebGPUPart('nodePatches', Object.freeze({ gaps, apply, invalidate, dress, problem }));
