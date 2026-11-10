// Named shader patches. One way to add shader code to any three.js material: GLSL on WebGLRenderer, the patch's tsl on NodeMaterials (WebGPURenderer).
// A patch says where its code goes (a semantic slot from render/slots.js: 'position', 'color', 'lighting'...; or, as the expert exit,
// a raw `#include <chunk>` anchor with before / after / replace), which uniforms it needs and what makes its
// program unique (cacheKey). Patches stack: the material's own onBeforeCompile runs first (also one the game assigns after the engine
// patched it: the instance accessor keeps both, see patchMaterial), then every patch in the order added,
// and the program cache key joins all of them, so two patches never overwrite each other and differently-parameterised
// materials never share a program. A missing anchor is reported when the patch is added, not discovered as a silent no-op.
// GLSL lives under `glsl`; the TSL version under `tsl`: (ctx) => node per slot, applied by render/fx/patchNodes.tsl.js (loaded with threedog/tsl)
// on a NodeMaterial, and on the node twin WebGPURenderer builds of a classic material (dressNodeTwins below). So one patched MeshLambertMaterial
// draws with its GLSL on WebGLRenderer and with its tsl on WebGPURenderer: the engine's own materials stay classic, which is what lets
// fallback: 'webgl' (decided in start(), after they were made) keep them. A patch without tsl throws on a NodeMaterial and is named by
// start() on WebGPURenderer (render/backend.js webglOnlyOn). Engine uniforms (engine.uniforms: uTime, uWind, uWeatherCloud...) are resolved per
// renderer when the program compiles, so one material works under any engine and two engines on a page each drive their own time and weather.
// A patch that moves vertices (shadow: true) owns its shadow: meshes using the material get matching depth and distance
// materials automatically (see the customDepthMaterial / customDistanceMaterial defaults below), callers never set them.
// material.clone() does not carry patches (three's Material.copy skips onBeforeCompile): a game applies the effects to the clone again (recipes/09); engine code copies with cloneMaterial(from).
//
// Composition contract (each part is checked, so a bad combination fails loudly in development instead of rendering wrong):
//   needs.data     program inputs the code reads, named like three's program parameters ('instancing', 'instancingColor',
//                  'vertexColors', 'skinning', 'batching'); checked when the program compiles, one console.error per material.
//   needs.patches  patches that must already be on the material (their varyings / functions are used); checked when added.
//   conflicts      patch names this one cannot share a material with (both write the same output); checked when added, both ways.
//   uniforms       a name belongs to one patch: two patches bringing different objects under one uniform name is a conflict
//                  (the same engine uniform, e.g. engine.uniforms.uTime, counts as one object).
//   shadow         render steps: without it the patch runs only in the color pass; with it its vertex code also runs in the
//                  depth pass (directional / spot shadows) and the distance pass (point-light shadows).
//   cacheKey       must change whenever the GLSL text changes (defines, branches), never for uniform values. The program key is
//                  the material's own key + '|threedog:' + name=cacheKey of every patch in order; one name + cacheKey producing
//                  two different GLSL texts throws, since those materials would silently share one program.
import * as THREE from 'three';
import { closest, DEV, warnOnce } from '../core/base/validate.js';
import { EFFECTS, PROVIDED_BY } from './effects.js';
import { noteCopy, VERSION } from '../core/engine/copies.js';
import { notePatch, patchOn } from '../core/scene/threePatches.js';
import { sameUniform, resolveUniform, engineUniformName } from './engineUniforms.js';
import { SLOTS, SLOT_NAMES, toAnchors } from './slots.js';
import { codedError, coded } from '../core/base/errorHints.js';
import { webgpuPart, webgpuPartOrNull, addWebGPURule } from './backend.js';
import { copyTerms } from './terms.js';   // a cycle (terms.js patches materials); only called at run time, never while loading

/** @import { Material } from '../types/common' */

/**
 * @typedef {{ before?: string, after?: string, replace?: string } | string} PatchCode  code for one anchor (a plain string goes after the include;
 *   replace swaps the include itself for new code, one patch per anchor)
 * @typedef {'position' | 'shadowPosition' | 'clipPosition' | 'map' | 'color' | 'normal' | 'roughness' | 'emissive' | 'lightsPars' | 'lightingModel' | 'lighting' | 'output' | 'fogPars' | 'fog'} PatchSlot
 * @typedef {{ name: string, cacheKey?: string | number, uniforms?: Record<string, { value: any }>, shadow?: boolean,
 *   needs?: { data?: string[], patches?: string[] }, conflicts?: string[], slot?: PatchSlot, pars?: string | { vertex?: string, fragment?: string },
 *   glsl?: string | { [slot in PatchSlot]?: string } | { vertex?: Record<string, PatchCode>, fragment?: Record<string, PatchCode> },
 *   tsl?: ((ctx: any) => any) | { [slot in PatchSlot]?: any } }} ShaderPatch
 *   tsl (NodeMaterial / WebGPURenderer): (ctx) => node for `slot`, or { slot: fn }; ctx[slot] is the value so far, ctx.fx the threedog/tsl
 *   functions (ctx.fx.patchUniform(u) = a { value } uniform of the patch as a node), ctx.tsl three/tsl.
 *   The lighting slot returns { directDiffuse?, directSpecular?, indirectDiffuse?, indirectSpecular? }, or takes
 *   hooks { start?(ctx), light?(light, ctx) => color, direct?(light, ctx), after?(ctx) } (light = { direction, color, shadow, directional, light };
 *   light() returns that one light's new color before three uses it; ctx.state is shared by the hooks).
 *   slot + glsl string: that slot's code (render/slots.js lists the slots, where each goes and what is in scope); glsl { slot: code }:
 *   several slots; pars: declarations at the top of every stage the patch touches (or { vertex, fragment }).
 *   Raw-anchor exit: glsl.vertex / glsl.fragment: three.js chunk name -> code; the key `pars` is declarations placed at the top of the shader.
 *   shadow: the patch moves vertices, so the depth and point-light distance passes run its vertex code too.
 *   needs.data: program inputs read, e.g. ['instancing']; needs.patches: patches it builds on, e.g. ['world'] (the vThreedogWorld varying).
 *   conflicts: patch names it cannot be combined with. cacheKey: changes whenever the GLSL text changes (see the header).
 */

// Shader source of built-in materials, to check anchors before the first compile
const LIB = { MeshBasicMaterial: 'basic', MeshLambertMaterial: 'lambert', MeshPhongMaterial: 'phong', MeshStandardMaterial: 'standard',
  MeshPhysicalMaterial: 'physical', MeshToonMaterial: 'toon', MeshMatcapMaterial: 'matcap', MeshDepthMaterial: 'depth',
  MeshDistanceMaterial: 'distance', MeshNormalMaterial: 'normal', PointsMaterial: 'points', SpriteMaterial: 'sprite' };
function sourceOf(m, stage) {
  if (m.isShaderMaterial) return m[stage + 'Shader'];
  const id = LIB[m.type];
  return id ? THREE.ShaderLib[id][stage + 'Shader'] : null;
}
/** Anchors the patch needs that the material's shader lacks ([] = fits; null = unknown material, checked at compile time) */
function missing(m, p) {
  const out = [];
  for (const stage of ['vertex', 'fragment']) {
    const src = sourceOf(m, stage);
    if (src == null) return null;
    for (const k in p.glsl?.[stage] || {}) if (k !== 'pars' && !src.includes(`#include <${k}>`)) {
      const slot = SLOT_NAMES.find(n => SLOTS[n].stage === stage && SLOTS[n].anchor === k);
      out.push(`${stage} <${k}>` + (slot ? ` (slot '${slot}')` : ''));
    }
  }
  return out;
}

// Why a patch cannot join the material's list, or '' (composition rules from the header)
let deriving = false;   // re-entrancy flag, set and cleared inside one synchronous call (never across a frame)
const CODE = new Map();   // name=cacheKey -> GLSL text, to catch a cacheKey that does not follow the code
// one patch per chunk: a replace, or a slot flagged exclusive (fog sits before tonemapping_fragment, but two fog mixes would stack); the marker names the slot
const EXCLUSIVE = SLOT_NAMES.filter(n => SLOTS[n].exclusive).map(n => `slot=${n}
`);
const replaced = p => ['vertex', 'fragment'].flatMap(st => Object.entries(p.glsl?.[st] || {}).filter(([, c]) => typeof c === 'object' && (c.replace != null || EXCLUSIVE.some(m => (c.before ?? '').includes(m)))).map(([k]) => st + k));
const DATA = ['instancing', 'instancingColor', 'vertexColors', 'skinning', 'batching'];
function clash(list, p, fresh) {   // fresh: the CODE keys this call adds, so a failed batch can take them back
  for (const d of p.needs?.data || []) if (!DATA.includes(d)) {
    const near = closest(d, DATA);
    return `patch '${p.name}' needs.data names '${d}', which is not a program input; use ${DATA.join(' | ')}` + (near ? ` (did you mean '${near}'?)` : '');
  }
  const others = list.filter(q => q.name !== p.name);
  for (const q of others) if (p.conflicts?.includes(q.name) || q.conflicts?.includes(p.name))
    return `patches '${q.name}' and '${p.name}' cannot be combined on one material; keep one of them, or use two materials`;
  for (const n of p.needs?.patches || []) if (!others.some(q => q.name === n))
    return `patch '${p.name}' needs patch '${n}' on the material first; put '${n}' before it in the patches list (the built-in 'world' is added by the engine), or fix why '${n}' was skipped`;
  for (const q of others) for (const u in p.uniforms || {}) if (q.uniforms?.[u] && !sameUniform(q.uniforms[u], p.uniforms[u]))
    return `patches '${q.name}' and '${p.name}' both bring a uniform named '${u}'; rename one (prefix it with the patch name), or share engine.uniforms.${u}`;
  const mine = replaced(p);
  for (const q of others) if (replaced(q).some(k => mine.includes(k)))
    return `patches '${q.name}' and '${p.name}' both replace one chunk; keep one, or add code before / after it`;
  // strip slots.js's marker comments before comparing: the same code written with slots or anchors differs only by slot= in the marker and generates the same program, so it is not "same cacheKey, different code"
  const key = p.name + '=' + (p.cacheKey ?? ''), code = JSON.stringify(p.glsl ?? {}).replace(/\/\/ threedog:(begin|end)[^\\"]*/g, '');
  if (CODE.has(key) && CODE.get(key) !== code)
    return `patch '${p.name}' produced different GLSL under the same cacheKey '${p.cacheKey ?? ''}'; put every value that changes the code into cacheKey`;
  if (!CODE.has(key)) { CODE.set(key, code); fresh?.push(key); }
  return '';
}

const LISTS = new WeakMap();   // material -> its patches (not userData: that gets JSON-cloned and exported to glTF)

// A list read back from a material (engine.<module>.patches) comes through applyEffects a second time: already placed, it stays as it is.
// Placing it again would wrap its code in a second marker, and the 'same cacheKey, different code' check would then reject the module's own patch.
const ANCHORED = new WeakSet();
const anchored = p => { if (ANCHORED.has(p)) return p; const a = toAnchors(p); ANCHORED.add(a); return a; };

// Shared declarations appear once per stage. Patches may share engine.uniforms (uTime ...) and the threedog_* chunks, and each patch's pars is
// written to stand alone, so two patches on one material each declare `uniform float uTime;` (twice is a GLSL redefinition: the program fails).
// Done here, in the one place that joins the pars, so no patch has to guard its own lines: threedog_* includes are expanded once (a second
// include of the same chunk is dropped), then a uniform name already declared by the material's own shader or an earlier patch is dropped.
const DECL = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
const OWN_INC = /#include\s+<(threedog_\w+)>/g;
function sharedOnce(pars, src) {
  const expander = (seen = new Set()) => function expand(code) {
    return code.replace(OWN_INC, (all, name) => {
      if (seen.has(name)) return '';
      seen.add(name);
      const chunk = THREE.ShaderChunk[name];
      return chunk == null ? all : expand(chunk);
    });
  };
  // the material's own source is only scanned (three resolves it), with its own chunk set: a statement chunk included inside main() must not
  // hide a global one from the pars
  const uniforms = new Set(Array.from(expander()(src).matchAll(DECL), m => m[1])), expand = expander();
  return pars.map(code => expand(code).replace(DECL, (all, name) => uniforms.has(name) ? '' : (uniforms.add(name), all)));
}
const PROTO_COMPILE = THREE.Material.prototype.onBeforeCompile, PROTO_KEY = THREE.Material.prototype.customProgramCacheKey;
// An engine wrapper put on a material instance (this file's onBeforeCompile / customProgramCacheKey, render/fx/patchNodes.tsl.js's setup methods)
// carries this key: a function handing back the game's part it wraps (null / three's method when the game had none). The WebGPU route names
// only the game's GLSL hook by it (render/backend.js), and cloneMaterial carries the game's part instead of a wrapper bound to the original
/** @internal */
export const WRAPPED = Symbol.for('threedog.patchWrapper');

function apply(shader, list, m, renderer) {
  for (const p of list) for (const d of p.needs?.data || []) if (!shader[d]) {
    // keyed per material + patch: the same text for another mesh is another place to fix
    warnOnce(coded('shader-patch', `[threedog] patch '${p.name}' needs '${d}', which this mesh does not provide (e.g. 'instancing' needs an InstancedMesh, 'vertexColors' needs material.vertexColors and a color attribute)`), `patch-data\0${m.uuid}:${p.name}:${d}`);
  }
  for (const stage of ['vertex', 'fragment']) {
    const key = stage + 'Shader', pars = [], at = new Map();
    for (const p of list) {
      for (const u in p.uniforms) shader.uniforms[u] = resolveUniform(p.uniforms[u], renderer);
      for (const [k, code] of Object.entries(p.glsl?.[stage] || {})) {
        if (k === 'pars') { pars.push(code); continue; }
        const slot = at.get(k) || at.set(k, { before: [], after: [], replace: null }).get(k);
        if (typeof code === 'string') slot.after.push(code);
        else { if (code.before) slot.before.push(code.before); if (code.after) slot.after.push(code.after); if (code.replace != null) slot.replace = code.replace; }
      }
    }
    let src = shader[key];
    for (const [k, { before, after, replace }] of at) {
      const inc = `#include <${k}>`;
      if (!src.includes(inc)) {
        warnOnce(coded('shader-patch', `[threedog] shader patch anchor ${inc} not found in ${m.type}; add it to your shader or #include the threedog_* chunks by hand (see render/patches.js)`));
        continue;
      }
      src = src.replace(inc, () => [...before, replace ?? inc, ...after].join('\n'));
    }
    shader[key] = sharedOnce(pars, src).join('\n') + '\n' + src;
  }
}

/**
 * Add named shader patches to any material; returns the same material. Stacks with the material's own onBeforeCompile
 * and with earlier patches; a patch with the same name replaces the earlier one. A missing anchor throws (strict) or
 * skips that patch with a one-time warning (strict: false, used for the engine's automatic effects). Composition errors
 * (conflicts, a needed patch missing, a uniform name taken, cacheKey not following the code) throw the same way.
 * @example
 * // reads the world position varying of 'clouds', and must not share a material with the engine's 'wind'
 * patchMaterial(mat, [{ name: 'ripple', needs: { patches: ['clouds'] }, conflicts: ['wind'], shadow: true, ... }]);
 * patchMaterial(mat, [{ name: 'snap', slot: 'clipPosition', cacheKey: 64, uniforms: { uGrid: { value: 64 } }, pars: 'uniform float uGrid;',
 *   glsl: 'gl_Position.xy = floor(gl_Position.xy / gl_Position.w * uGrid) / uGrid * gl_Position.w;' }]);
 * @internal games go through applyEffects(material, { patches })
 * @param {Material} material
 * @param {ShaderPatch[]} patches
 * @param {{ strict?: boolean }} [opts]
 * @returns {Material}
 */
export function patchMaterial(material, patches, { strict = true } = {}) {
  const m = /** @type {any} */ (material);
  let list = LISTS.get(m);
  // NodeMaterials take no onBeforeCompile / GLSL program key (three keys them by their nodes): the list alone, turned into nodes below
  if (!list && m.isNodeMaterial) LISTS.set(m, list = []);
  if (!list) {
    LISTS.set(m, list = []);
    // the game's own onBeforeCompile / customProgramCacheKey: those there before patching and those assigned after patching are all kept here and run first (user decision 5, 2026-11-02).
    // Why an instance accessor instead of a warning: before, a game assigning `m.onBeforeCompile = fn` later silently overwrote the wrapper, losing wind / cloud shadow / season;
    // with a warning an AI could only copy it into the chained form, an extra step for nothing. Now assignment replaces only "the game's part", engine patches still follow, and both apply.
    let game = m.onBeforeCompile, gameKey = Object.hasOwn(m, 'customProgramCacheKey') || (!m.isNodeMaterial && m.customProgramCacheKey !== PROTO_KEY) ? m.customProgramCacheKey : null;   // own, or a subclass's override on its prototype (a NodeMaterial's is three's own, keyed by its nodes)
    const own = game !== PROTO_COMPILE;
    const wrapper = function (shader, renderer) { if (game && game !== PROTO_COMPILE) game.call(this, shader, renderer); apply(shader, list, m, renderer); };
    // the wrapper marks itself as the engine's and hands out the game's part: the WebGPU route names only the game's GLSL hook (render/backend.js)
    wrapper[WRAPPED] = () => game;
    const key = () => (gameKey ? gameKey.call(m) : game && game !== PROTO_COMPILE ? game.toString() : '') + '|threedog:' + list.map(p => p.name + '=' + (p.cacheKey ?? '')).join(',');
    key[WRAPPED] = () => gameKey;   // cloneMaterial carries the game's own key function, not this one (it reads this material's list)
    if (!patchOn('material-compile-accessor')) { m.onBeforeCompile = wrapper; m.customProgramCacheKey = key; }   // three's plain properties: a later assignment replaces both
    else {
      Object.defineProperty(m, 'onBeforeCompile', { configurable: true, enumerable: own, get: () => wrapper, set(fn) { game = fn; m.needsUpdate = true; } });
      Object.defineProperty(m, 'customProgramCacheKey', { configurable: true, enumerable: false, get: () => key, set(fn) { gameKey = fn; m.needsUpdate = true; } });
    }
    m.addEventListener('dispose', () => dropShadow(m));
  }
  // slot form is converted to anchor form at the entry (one internal representation), so the later conflict / shadow / cacheKey checks are the same for both forms; derived ones (copyPatches / shadow material) are already converted
  const before = list.slice(), fresh = [];
  try {   // any throw (a strict clash, a missing chunk, the NodeMaterial build) puts the list back: a rejected batch leaves no earlier patch installed
    for (const p of deriving ? patches : withProviders(patches, list).map(anchored)) {
      // a GLSL-only patch on a NodeMaterial throws even when not strict: skipping it would draw the material without its picture, silently
      if (m.isNodeMaterial && !deriving && p.tsl == null) throw codedError('shader-patch', `[threedog] patch '${p.name}' has no tsl version; add tsl: (ctx) => ..., or keep this material on WebGLRenderer (${m.type} is a NodeMaterial)`);
      const nodeGap = m.isNodeMaterial && !deriving ? nodePatches(m).gaps(m, p) : '';
      if (nodeGap) {
        if (strict) throw codedError('shader-patch', `[threedog] ${nodeGap}`);
        warnOnce(coded('shader-patch', `[threedog] ${nodeGap}; skipped`));
        continue;
      }
      const bad = deriving ? '' : clash(list, p, fresh);
      if (bad) {
        if (strict) throw codedError('shader-patch', `[threedog] ${bad}`);
        warnOnce(coded('shader-patch', `[threedog] ${bad}; patch '${p.name}' skipped`));
        continue;
      }
      const gaps = missing(m, p);
      if (gaps?.length) {
        const msg = `patch '${p.name}' needs ${gaps.join(', ')}, which ${m.type} does not have`;
        if (strict) throw codedError('shader-patch', msg + '; use a material that has these chunks, or #include the threedog_* chunks in your own shader');
        warnOnce(coded('shader-patch', '[threedog] ' + msg + '; skipped'));
        continue;
      }
      const i = list.findIndex(q => q.name === p.name);
      if (i >= 0) list[i] = p; else list.push(p);
    }
    if (m.isNodeMaterial) nodePatches(m).apply(m, list);
  } catch (e) { list.splice(0, list.length, ...before); for (const k of fresh) CODE.delete(k); throw e; }
  if (!m.isNodeMaterial) changedClassic(m);
  dropShadow(m);
  m.needsUpdate = true;
  return m;
}

/** The TSL side of a classic material: its nodes follow the list (rebuilt on the next read) when threedog/tsl is loaded; WebGL games skip it */
function changedClassic(m) {
  webgpuPartOrNull('nodePatches')?.invalidate(m, () => LISTS.get(m) ?? []);
  if (!Object.hasOwn(m, NODE_KEY)) Object.defineProperty(m, NODE_KEY, { configurable: true, enumerable: true, get: () => nodeKey(m) });
}

// WebGPURenderer keys a classic material's program by its customProgramCacheKey (the patch names and cacheKeys above) plus its enumerable
// properties, and shares one node build between materials whose keys match. The build holds the patch's own uniform nodes (render/fx:
// one node per { value } object) and runs the patch's tsl, while cacheKeys follow the GLSL, so two materials with the same patch names but
// their own uniform objects, or other tsl under the same GLSL (or none), would draw as the first one, with no error. This enumerable
// property adds the identities of those objects and tsl functions to the WebGPU key only (WebGLRenderer never reads it, and there every
// material binds its own uniforms, so sharing a program is right). Materials that share them (one material, patches made once and reused,
// sharedPatch, the built-in effects) still share one program; a tsl function written fresh per material gets one program per material.
const NODE_KEY = 'threedogNodeKey';
const IDS = new WeakMap();
let nextId = 0;
const idOf = o => { let i = IDS.get(o); if (i === undefined) IDS.set(o, i = ++nextId); return i; };
/** Every function of a patch's tsl: (ctx) => node, { slot: fn }, or a lighting slot's hook object */
const tslFunctions = t => typeof t === 'function' ? [t] : t && typeof t === 'object' ? Object.values(t).flatMap(tslFunctions) : [];
function nodeKey(m) {
  const ids = [];
  for (const p of LISTS.get(m) ?? []) {
    for (const u in p.uniforms ?? {}) if (!engineUniformName(p.uniforms[u])) ids.push(idOf(p.uniforms[u]));
    for (const f of tslFunctions(p.tsl)) ids.push(idOf(f));
  }
  return ids.join('.');
}

/**
 * @internal One patch object per (owner, kind, options): materials made from the same spec get the same patch, so its uniform objects and
 * with them threedogNodeKey are the same and WebGPURenderer builds one program for all of them (8 same-role materials: 8 builds -> 1).
 * WebGL already shares the program (its key is the code); there this also saves the uniform objects. Options that hold something whose
 * identity matters (a function, the game's own uniforms objects, any non-plain object but a Color / Vector / Texture) are not shared:
 * make() runs every time. Shared means one set of values: change a patch uniform on one material and every material of that spec follows,
 * which is what a spec means; give a material its own options to tune it alone.
 * @template T @param {object | null} owner the engine (null: a page-wide table) @param {string} kind @param {any} opts @param {() => T} make @returns {T}
 */
export function sharedPatch(owner, kind, opts, make) {
  const key = optionsKey(opts);
  if (key == null) return make();
  const o = owner ?? SHARED_PAGE;
  let t = SHARED.get(o);
  if (!t) SHARED.set(o, t = new Map());
  const k = kind + ':' + key;
  let p = t.get(k);
  if (!p) t.set(k, p = make());
  return p;
}
const SHARED = new WeakMap(), SHARED_PAGE = {};
/** A text key for plain options, or null when they hold something that cannot be keyed by value @param {any} v */
function optionsKey(v) {
  let ok = true;
  const s = JSON.stringify(v, (k, x) => {
    if (!ok || x == null || typeof x !== 'object') { if (typeof x === 'function') ok = false; return x; }
    if (k === 'uniforms') { ok = false; return null; }
    if (x.isTexture) return 'tex#' + idOf(x);
    if (x.isColor) return 'c#' + x.getHexString();
    if (x.isVector2 || x.isVector3 || x.isVector4) return x.toArray();
    if (Array.isArray(x) || Object.getPrototypeOf(x) === Object.prototype) return x;
    ok = false; return null;
  });
  return ok ? s : null;
}

/**
 * @internal core/engine/Engine.js, once per WebGPURenderer: the node twin three makes of a classic material (NodeLibrary.fromMaterial, run for each
 * program it builds) gets the material's patches as nodes. Why this one call: it is where three turns MeshLambertMaterial into
 * MeshLambertNodeMaterial, copying the plain properties and nothing of onBeforeCompile, so without it every engine material lost wind,
 * season, cloud shadows, detail and lighting on WebGPU without a word. Unpatched twins pass through too: a Lambert / Phong twin gets
 * scene.environment's diffuse light, which three's WebGLRenderer gives the classic material and its node twin does not (patchNodes.tsl.js).
 * @param {any} r
 */
export function dressNodeTwins(r) {
  const lib = r?.library;
  if (!lib || lib._threedogTwins) return;
  const from = lib.fromMaterial.bind(lib);
  lib.fromMaterial = material => {
    const twin = from(material);
    if (!twin || twin === material) return twin;
    const list = LISTS.get(material) ?? [];
    // every twin goes through dress (Lambert / Phong get scene.environment's diffuse light as on WebGL); only a patched one needs threedog/tsl
    const part = list.length ? nodePatches(material) : webgpuPartOrNull('nodePatches');
    return part ? part.dress(twin, material, list) : twin;
  };
  lib._threedogTwins = true;
}
notePatch('node-twin-dress', "renderer.library.fromMaterial of a WebGPURenderer: the node twin of a classic material gets the material's patches as nodes (render/patches.js)", null,
  { scope: 'engine renderer', lost: 'without it every patched material on WebGPU draws without its picture and without a word (wind, season, cloud shadows, detail, lighting), so it stays' });

// start() on WebGPURenderer, and each object added later: a classic material whose patches cannot all run there (a GLSL-only patch, a slot
// with no node place) is named instead of drawing without its picture
addWebGPURule(m => {
  const list = !m.isNodeMaterial ? LISTS.get(m) : null;
  return list?.length ? webgpuPartOrNull('nodePatches')?.problem(m, list) ?? null : null;
});

/** The TSL side (render/fx/patchNodes.tsl.js registers it when threedog/tsl loads, so this file never imports three/tsl) */
function nodePatches(m) {
  return webgpuPart('nodePatches', `patches on ${m.type}`);
}

// A patch read a varying that an engine patch brings (vThreedogWorld comes from 'world') without writing needs; it used to fail compiling with undeclared identifier,
// with no hint to write needs: { patches: ['world'] }. There is a single provider and adding it changes nothing else visible, so it is added automatically before the patch (dev warns once when needs was not written),
// and also when needs was written: every entry passes through here, so none has to remember to add 'world'.
const reads = (p, name) => new RegExp(`\\b${name}\\b`).test(JSON.stringify([p.glsl ?? '', p.pars ?? '']));
/** patches with every engine patch they read from (by needs.patches or by the varyings their code uses) inserted before them, once */
function withProviders(patches, list) {
  const out = [], have = n => list.some(q => q.name === n) || out.some(q => q.name === n);
  for (const p of patches) {
    for (const [varying, prov] of Object.entries(PROVIDED_BY)) {
      if (p.name === prov || have(prov)) continue;
      const declared = !!p.needs?.patches?.includes(prov);
      if (!declared && !reads(p, varying)) continue;
      out.push(EFFECTS[prov]());
      if (DEV && !declared) warnOnce(`[threedog] patch '${p.name}' reads ${varying}: the engine added the '${prov}' patch that provides it. Say so in the patch with needs: { patches: ['${prov}'] } (recipes/43)`);
    }
    out.push(p);
  }
  return out;
}

/**
 * Names of the patches on a material (in order), e.g. ['clouds', 'tint', 'wind']
 * @param {Material} material
 * @returns {string[]}
 * @experimental
 */
export function materialPatches(material) { return (LISTS.get(material) || []).map(p => p.name); }

/**
 * The patches on a material with the slots (or raw anchors) their code goes into, read from the threedog:begin markers (engine.inspect.materials)
 * @internal
 * @param {Material} material
 * @returns {{ name: string, slots: string[] }[]}
 */
export function materialPatchSlots(material) {
  return (LISTS.get(material) || []).map(p => ({ name: p.name, slots: [...new Set([...JSON.stringify(p.glsl ?? {}).matchAll(/threedog:begin patch=\S+ slot=([\w.-]+)/g)].map(m => m[1]))] }));
}

let hotRev = 0;
/**
 * Shader hot reload (render/hotGlsl.js): swap the GLSL text `old` for `neu` inside the patches of these materials. A changed patch gets a new cacheKey
 * (else three.js would reuse the program compiled from the old text), and every material carrying it recompiles. Returns the materials changed.
 * @internal
 * @param {Material[]} materials @param {string} old @param {string} neu
 * @returns {Material[]}
 */
export function replacePatchCode(materials, old, neu) {
  const changed = new Set(), seen = new Set();
  // only walk shapes the patch code is known to use: glsl / pars / shadowVertex are strings, or plain objects (slots, vertex / fragment, chunk name -> string or { before, after, replace }),
  // at most three levels. Why not recurse into every object field: today toAnchors already turned glsl into a new object holding only strings, but if the internal representation changes (e.g. uniforms brought in),
  // an Object3D / camera (parent <-> children cycle) would overflow the stack on hot reload, and also trigger getters. Non-plain objects (three class instances) and uniforms keys are never entered
  const swap = (o, k, depth = 0) => {
    const v = o[k];
    if (typeof v === 'string') { if (!v.includes(old)) return false; o[k] = v.replaceAll(old, neu); return true; }
    if (depth >= 3 || !v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return false;
    let hit = false;
    for (const kk of Object.keys(v)) if (kk !== 'uniforms' && swap(v, kk, depth + 1)) hit = true;
    return hit;
  };
  for (const m of materials) for (const p of LISTS.get(m) || []) {
    if (seen.has(p)) continue;
    seen.add(p);
    const hit = ['glsl', 'pars', 'shadowVertex'].map(k => swap(p, k)).some(Boolean);
    if (hit) { p.cacheKey = `${String(p.cacheKey ?? '').replace(/~hot\d+$/, '')}~hot${++hotRev}`; changed.add(p); }
  }
  const out = materials.filter(m => (LISTS.get(m) || []).some(p => changed.has(p)));
  for (const m of out) { dropShadow(m); m.needsUpdate = true; if (!(/** @type {any} */ (m).isNodeMaterial)) changedClassic(m); }
  return out;
}

/**
 * The patches on a material, a copy of the list. @internal modules hand it out as engine.<module>.patches
 * @param {Material} material
 * @returns {ShaderPatch[]}
 */
export function patchesOf(material) { return [...(LISTS.get(material) ?? [])]; }

/**
 * Take the patch named `name` off a material (no-op when absent); returns the material.
 * @internal cascades, shader terms, and the modules that swap one patch
 * @param {Material} material
 * @param {string} name
 * @returns {Material}
 */
export function unpatchMaterial(material, name) {
  const list = LISTS.get(material), i = list ? list.findIndex(p => p.name === name) : -1;
  if (i >= 0) {
    list.splice(i, 1); dropShadow(material); material.needsUpdate = true;
    if (/** @type {any} */ (material).isNodeMaterial) nodePatches(material).apply(material, list); else changedClassic(material);
  }
  return material;
}

// What three's clone leaves behind. NodeMaterial.copy (and Material.copy's fixed list) carries only properties a fresh instance of the class
// already has, so what a game set on the instance itself was dropped: its own lighting (mat.setupLightingModel = celLighting, the cel.tsl.js
// example), its own onBeforeCompile, a field its class never declares. The copy then drew with three's plain lighting (Pigforest: every
// vegetation model tree lost its toon look). Skipped as three's copy skips them: '_' internals, is* flags, ids, userData (copied by three)
const NOT_CARRIED = /^(?:is[A-Z]|_)|^(?:id|uuid|version|type|userData|clippingPlanes)$/;
/** The game's part under engine wrappers (WRAPPED), else the value itself */
const gamePart = v => { while (typeof v === 'function' && v[WRAPPED]) v = v[WRAPPED](); return v; };
/**
 * The engine's material copy: from.clone(), plus what the game put on the instance itself (above), plus from's engine patches, each once.
 * Every engine copy of a material goes through here (vegetation models, tinted characters and pickups, terrain textures, batching).
 * @internal
 * @template {Material} M @param {M} from @returns {M}
 */
export function cloneMaterial(from) {
  const to = /** @type {any} */ (from.clone());
  for (const k of Object.getOwnPropertyNames(from)) {
    if (NOT_CARRIED.test(k) || Object.hasOwn(to, k)) continue;   // own on the copy: three's copy already carried it (or the class makes it)
    const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(from, k)), raw = d.get ? d.get.call(from) : d.value;
    // an accessor is the engine's (a classic material's patch chains, the node key: copyPatches makes them again) unless it hands out a
    // wrapper of the game's part (onBeforeCompile, customProgramCacheKey); three's copy skips accessors of the game's as well
    if (d.get && !raw?.[WRAPPED]) continue;
    const v = gamePart(raw);
    if (v != null && v !== to[k]) to[k] = v;   // null / three's own method: nothing of the game's there
  }
  return /** @type {M} */ (copyPatches(from, to));
}

/**
 * Give `to` the patches of `from` (three's Material.copy does not carry onBeforeCompile, so a clone starts without patches). Returns `to`.
 * @internal a copy made from `from` goes through cloneMaterial, which calls this; alone it gives the patches to another material
 * @param {Material} from
 * @param {Material} to
 * @returns {Material}
 */
export function copyPatches(from, to) {
  const list = LISTS.get(from);
  if (!list?.length || from === to) return to;
  copyTerms(from, to);   // the copy carries the cloud / season terms, so a later engine.shaderTerms call reaches it too
  deriving = true;   // already checked on `from`
  try { return patchMaterial(to, list, { strict: false }); } finally { deriving = false; }
}

// ---------- which materials the engine made ----------
// Why record: automatic effects (season, cloud shadow, wind, cascaded-shadow list) should land only on materials the engine made (user decision 3, 2026-11-02); a game `new` material that wants effects must call
// applyEffects to opt in. WeakSet, not userData: userData is carried by clone and written into the file on glTF export, so a game material cloned from an engine one would be mistaken for it.
const MADE = new WeakSet();
/**
 * Record a material (terrain, vegetation clones, water) or a texture as engine-made; returns it. It is also the creator record engine.dispose reads
 * (core/engine/lifecycle.js): only a marked material or texture is freed there, a texture never because the material it sits on is the engine's.
 * @internal
 * @template {Material | import('three').Texture} M @param {M} m @returns {M}
 */
export function markEngineMade(m) { MADE.add(m); return m; }
/**
 * Whether the engine made this material or texture (see markEngineMade); a game's `new THREE.*Material` is false.
 * @internal
 * @param {Material | import('three').Texture} m @returns {boolean}
 */
export function isEngineMade(m) { return MADE.has(m); }

// ---------- shadows follow vertex-moving patches ----------
// Depth / distance materials carrying the material's vertex-moving patches; undefined when nothing moves. Cached per material
// and kind; patchMaterial and material.dispose() drop (and dispose) the cached ones, so patches added later are picked up.
const shadowMats = new WeakMap();
function dropShadow(material) {
  const byKind = shadowMats.get(material);
  if (byKind) for (const k in byKind) byKind[k]?.dispose();
  shadowMats.delete(material);
}
const moves = m => !!LISTS.get(m)?.some(p => p.shadow);
/**
 * Whether the material carries a vertex-moving patch (shadow: true, e.g. wind). Such code reads object space (position.y, the model
 * origin), so baking these meshes into world space (merging, HLOD proxies) would change how they move.
 * @internal
 * @param {Material | Material[]} material
 * @returns {boolean}
 */
export function movesVertices(material) { return [].concat(material).some(moves); }
function shadowMaterial(material, kind) {
  let byKind = shadowMats.get(material);
  if (!byKind) shadowMats.set(material, byKind = {});
  if (kind in byKind) return byKind[kind];
  // shadowPosition slot code goes only into the shadow material, replacing the same patch's position code (use when the shadow must differ from the color pass)
  const moving = LISTS.get(material).filter(p => p.shadow).map(p => ({ ...p, needs: { data: p.needs?.data }, conflicts: undefined,
    glsl: { vertex: p.shadowVertex ? { ...p.glsl?.vertex, ...p.shadowVertex } : p.glsl?.vertex } }));
  // three copies side, alphaTest, map and clipping from the drawn material onto the depth material on every draw
  const base = kind === 'depth' ? new THREE.MeshDepthMaterial() : new THREE.MeshDistanceMaterial();
  deriving = true;   // vertex-only copies of patches already checked on the source material
  try { return byKind[kind] = patchMaterial(base, moving, { strict: false }); } finally { deriving = false; }
}
// The shadow passes read object.customDepthMaterial (sun / spot) and customDistanceMaterial (point lights); three has no other hook.
// Their default (nothing assigned) becomes "my material's moving patches in that pass", so a wind material casts a swaying shadow
// however the mesh was built (game code, level load, instancing, a swapped material); an explicit assignment still wins. It must be
// on Mesh.prototype before any mesh exists (Object3D's constructor assigns both, which would otherwise make own properties).
// Explicit values live under a global symbol, so a second copy of this file (hot reload) redefining the accessor loses none.
// A second copy of the ENGINE (another path) still breaks the first copy's moving shadows (its shadowMaterial is no longer the one
// asked), so noteCopy says so once, with both paths and how to dedupe (core/engine/copies.js).
{ const w = noteCopy({ version: VERSION, url: import.meta.url }); if (w) warnOnce(w); }
{
  /** @type {[string, PropertyDescriptor | undefined][]} */
  const before = ['customDepthMaterial', 'customDistanceMaterial'].map(p => [p, Object.getOwnPropertyDescriptor(THREE.Mesh.prototype, p)]);
  notePatch('shadow-accessors', 'Mesh.prototype.customDepthMaterial / customDistanceMaterial: an unassigned one returns the moving shadow of a wind-patched material',
    () => { for (const [p, d] of before) { if (d) Object.defineProperty(THREE.Mesh.prototype, p, d); else delete THREE.Mesh.prototype[p]; } },
    { lost: 'meshes with wind or another vertex-moving patch cast a still shadow' });
}
notePatch('material-compile-accessor', "onBeforeCompile / customProgramCacheKey on each material the engine patches (what applyEffects was asked for, wind, the game's own shader slots): an own get / set, so the game's own hook assigned before or after still runs, then the engine's",
  () => {},   // off: materials patched from now on get three's plain properties (patchMaterial asks patchOn)
  { scope: 'patched materials', lost: "on materials patched from now on, assigning material.onBeforeCompile replaces the engine's patches (wind, cloud shadow) instead of running before them" });
for (const [prop, kind] of [['customDepthMaterial', 'depth'], ['customDistanceMaterial', 'distance']]) {
  const own = Symbol.for('threedog.' + prop);
  Object.defineProperty(THREE.Mesh.prototype, prop, {
    configurable: true,
    get() {
      if (Object.hasOwn(this, own)) return this[own];
      // multi-material mesh (trunk + leaves): one shadow material serves every group, so take the first one that moves
      const m = Array.isArray(this.material) ? this.material.find(moves) : this.material;
      // NodeMaterials: three's shadow pass reads material.positionNode itself (the tsl position chain), so no depth / distance material
      return moves(m) && !m.isNodeMaterial ? shadowMaterial(m, kind) : undefined;
    },
    set(v) { if (v === undefined) delete this[own]; else this[own] = v; },   // Object3D's constructor assigns undefined
  });
}
