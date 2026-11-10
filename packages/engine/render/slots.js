import { codedError } from '../core/base/errorHints.js';
import { isObject } from '../core/base/util.js';
// Semantic patch slots. The one table that says where a patch's code goes. A patch names a slot ('position', 'color', 'lighting'...),
// this table maps the slot to a GLSL injection point on WebGLRenderer (a three.js `#include <chunk>` plus before / after / replace) and to where
// render/fx/patchNodes.tsl.js puts the patch's tsl on a NodeMaterial (`node`: { prop } a node property, { setup } code run inside that three
// setup method, null = WebGL only). patchNodes.tsl.js builds its slot map from this column, so the table cannot promise a mapping the code lacks.
// nodeMeaning: what is different on the NodeMaterial side, said here once (it is printed in the recipe 43 table).
// Why one table: patches, built-in effects (wind / cloud shadow / season / detail / lighting / CSM), error messages and the recipe 43 table all read from here,
// the WebGPU route only needed the node column and no patch changed; the anchor strings appear once here, not scattered across effects each writing their own.
// Raw anchors (`glsl: { vertex|fragment: { <chunk>: code } }`) stay as the expert exit: plain three.js knowledge, WebGL only.
/** @typedef {{ stage: 'vertex' | 'fragment', anchor: string, at: 'after' | 'before' | 'replace', shadowOnly?: boolean, scope: string, meaning: string,
 *   node: { prop?: string, setup?: string } | null, nodeMeaning?: string, closes?: string, exclusive?: boolean }} Slot */

/** @type {Record<string, Slot>} */
export const SLOTS = {
  position:       { stage: 'vertex', anchor: 'begin_vertex', at: 'after', node: { prop: 'positionNode' },
    scope: 'transformed (vec3, object space, write), position, normal, uv',
    meaning: 'move vertices in object space, before skinning / instancing / the model matrix',
    nodeMeaning: "the same place (the engine runs the chain before three's instancing; a game's own positionNode still applies after it)" },
  shadowPosition: { stage: 'vertex', anchor: 'begin_vertex', at: 'after', shadowOnly: true, node: { prop: 'castShadowPositionNode' },
    scope: 'transformed (vec3, object space, write), position',
    meaning: 'vertex code for the shadow passes only (depth / point-light distance), replacing this patch\'s position code there' },
  clipPosition:   { stage: 'vertex', anchor: 'project_vertex', at: 'after', node: { prop: 'vertexNode' },
    scope: 'transformed, mvPosition (view space), gl_Position (clip space, write)',
    meaning: 'after projection: snap or offset on screen, or write world-space varyings' },
  map:            { stage: 'fragment', anchor: 'map_fragment', at: 'after', node: { prop: 'colorNode' },
    scope: 'diffuseColor (vec4, write; the map applied, vertex colors not yet)',
    meaning: 'the base color / texture, before vertex colors and every color patch' },
  color:          { stage: 'fragment', anchor: 'color_fragment', at: 'after', node: { setup: 'setupDiffuseColor' },
    scope: 'diffuseColor (vec4, write; map and vertex colors already applied), vUv when the material has a map',
    meaning: 'the surface (diffuse) color before lighting' },
  normal:         { stage: 'fragment', anchor: 'normal_fragment_maps', at: 'after', node: { setup: 'setupNormal' },
    scope: 'normal (vec3, view space, write), faceDirection, vViewPosition',
    meaning: 'the shading normal (bump, detail) after normal / bump maps' },
  roughness:      { stage: 'fragment', anchor: 'roughnessmap_fragment', at: 'after', node: { prop: 'roughnessNode' },
    scope: 'roughnessFactor (float, write); MeshStandard / MeshPhysical only',
    meaning: 'roughness after the roughness map' },
  emissive:       { stage: 'fragment', anchor: 'emissivemap_fragment', at: 'after', node: { prop: 'emissiveNode' },
    scope: 'totalEmissiveRadiance (vec3, write), diffuseColor',
    meaning: 'emitted light after the emissive map' },
  lightsPars:     { stage: 'fragment', anchor: 'shadowmap_pars_fragment', at: 'after', node: null,
    nodeMeaning: "TSL has no declaration area: the light's direction and shadow come to the lighting slot's direct(light, ctx) hook",
    scope: 'declarations; three\'s light structs, getShadow() and directionalLights[] are already declared',
    meaning: 'functions that call three\'s light / shadow helpers (pars goes before them)' },
  lightingModel:  { stage: 'fragment', anchor: 'lights_fragment_begin', at: 'replace', node: null,
    nodeMeaning: "use the lighting slot's hooks { start, light, direct, after }, or a NodeMaterial with your own setupLightingModel",
    scope: 'geometryPosition, geometryNormal, material, reflectedLight; your code replaces three\'s light loop',
    meaning: 'replace how lights are summed (one patch per material may take it)' },
  lighting:       { stage: 'fragment', anchor: 'lights_fragment_end', at: 'after', node: { setup: 'setupLightingModel' },
    scope: 'reflectedLight.directDiffuse / directSpecular / indirectDiffuse (write), normal, diffuseColor, vViewPosition',
    meaning: 'after lights are summed: wrap, shadow tint, rim',
    nodeMeaning: "hooks { start, light, direct, after }: light(light, ctx) returns a new color for one light before three lights the surface with it (what GLSL does by wrapping three's light info in lightsPars), direct(light, ctx) sees each light in three's loop and adds to its own sums, which join the summed light at the patch's place in the list, then its after() runs: the same order as WebGL" },
  output:         { stage: 'fragment', anchor: 'opaque_fragment', at: 'before', node: { setup: 'setupOutput' },
    scope: 'outgoingLight (vec3, write), diffuseColor.a',
    meaning: 'the final lit color, before fog and tone mapping' },
  // fog as two slots, like lightsPars / lightingModel: functions cannot sit inside main(), and they must come after three's fog uniforms
  // (declared in fog_pars_fragment), which the top-of-shader pars precedes. A game's own fog math goes through these
  // instead of rewriting THREE.ShaderChunk.fog_*, which is one object for the whole page
  fogPars:        { stage: 'fragment', anchor: 'fog_pars_fragment', at: 'after', node: null,
    nodeMeaning: 'fog on WebGPU is scene.fogNode, set by the game',
    scope: 'declarations; fogColor and fogNear / fogFar or fogDensity are already declared (inside #ifdef USE_FOG)',
    meaning: 'fog functions that read three\'s fog uniforms (wrap them in #ifdef USE_FOG)' },
  // the engine mixes fog in linear space first thing in tonemapping_fragment (render/postWebGL.js), so this slot sits right before it and closes
  // with THREEDOG_FOG_DONE: the patch IS the one fog mix, the engine's is skipped (a second mix on a tone-mapped colour was the bug)
  fog:            { stage: 'fragment', anchor: 'tonemapping_fragment', at: 'before', closes: '#define THREEDOG_FOG_DONE', exclusive: true, node: null,
    nodeMeaning: 'fog on WebGPU is scene.fogNode, set by the game',
    scope: 'gl_FragColor (write; linear, before tone mapping), vFogDepth, threedogFogColor() (fog colour, linear), threedogFogFactor() (0..1, the same curve three uses), fogColor (as three has it) and fogNear / fogFar or fogDensity (all inside #ifdef USE_FOG)',
    meaning: 'replace how fog mixes into the final color: the only fog mix, in linear space before tone mapping and the output encoding (one patch per material may take it)' },
};
export const SLOT_NAMES = Object.keys(SLOTS);
/** The lighting slot's hook names on the TSL side (render/fx/patchNodes.tsl.js) */
export const LIGHT_HOOKS = ['start', 'light', 'direct', 'after'];
/** Slots a patch's tsl can use (the node column is not null) */
const NODE_SLOTS = SLOT_NAMES.filter(n => SLOTS[n].node);

/** Whether a patch uses the slot form (slot: / glsl keyed by slot names) rather than raw anchors (glsl: { vertex, fragment }) */
const slotForm = p => p.slot != null || typeof p.glsl === 'string' || (isObject(p.glsl) && !('vertex' in p.glsl) && !('fragment' in p.glsl));
const EXIT = "or the raw-anchor exit glsl: { vertex|fragment: { <three.js chunk>: code } } (WebGL only)";

/** Marker comments around injected code, so a compile error can be traced back to the patch and slot (render/shaderErrors.js) */
const mark = (patch, slot, code) => `// threedog:begin patch=${patch} slot=${slot}\n${code}\n// threedog:end`;

/**
 * Turn a slot-form patch into the raw-anchor form patches.js applies (one internal representation, so shadows, conflicts and
 * cacheKey checks work the same for both). Raw-form patches come back with their code marked (slot=<chunk>). Throws on an unknown slot.
 *   { name, slot: 'color', glsl: 'code', pars? }              one slot
 *   { name, glsl: { position: 'code', color: 'code' }, pars? } several slots
 *   pars: declarations at the top of every stage the patch touches, or { vertex, fragment } to place them per stage.
 * @internal patches.js
 * @param {any} p
 * @returns {any} a new patch object (p itself is not changed)
 */
export function toAnchors(p) {
  if (!p || typeof p !== 'object') return p;
  if (p.tsl != null) p = { ...p, tsl: tslSlots(p) };
  // a TSL-only patch has no GLSL to place: it drops slot / pars like the slot form does and keeps tsl (NodeMaterials only)
  if (p.tsl != null && p.glsl == null) { const { slot, pars, ...rest } = p; return rest; }
  if (!slotForm(p)) {
    if (p.pars !== undefined) throw codedError('shader-patch', `[threedog] patch '${p.name}': top-level pars goes with slot names; in the raw-anchor form put it at glsl.vertex.pars / glsl.fragment.pars`);
    if (p.glsl == null) return p;
    const glsl = {};
    for (const st of ['vertex', 'fragment']) if (p.glsl[st]) {
      glsl[st] = {};
      for (const [k, c] of Object.entries(p.glsl[st])) glsl[st][k] = k === 'pars' ? c : typeof c === 'string' ? mark(p.name, k, c)
        : { ...c, ...(c.before ? { before: mark(p.name, k, c.before) } : {}), ...(c.after ? { after: mark(p.name, k, c.after) } : {}), ...(c.replace != null ? { replace: mark(p.name, k, c.replace) } : {}) };
    }
    const extra = Object.keys(p.glsl).filter(k => k !== 'vertex' && k !== 'fragment');
    if (extra.length) throw codedError('shader-patch', `[threedog] patch '${p.name}' mixes raw stages (vertex / fragment) with '${extra.join("', '")}'; use slot names only: ${SLOT_NAMES.join(' | ')}, ${EXIT}`);
    return { ...p, glsl };
  }
  /** @type {Record<string, string>} */
  let bySlot;
  if (p.slot != null) {
    if (typeof p.glsl !== 'string') throw codedError('shader-patch', `[threedog] patch '${p.name}' names slot '${p.slot}', so glsl is that slot's code as a string; for several slots write glsl: { ${SLOT_NAMES[0]}: '...', color: '...' }`);
    bySlot = { [p.slot]: p.glsl };
  } else if (typeof p.glsl === 'string') throw codedError('shader-patch', `[threedog] patch '${p.name}' has glsl code but no slot; add slot: ${SLOT_NAMES.join(' | ')}, ${EXIT}`);
  else bySlot = p.glsl;
  const glsl = { vertex: {}, fragment: {} }, shadow = {}, used = new Set();
  for (const [name, code] of Object.entries(bySlot)) {
    const s = SLOTS[name];
    if (!s) throw codedError('shader-patch', `[threedog] patch '${p.name}': unknown slot '${name}'; use ${SLOT_NAMES.join(' | ')}, ${EXIT}`);
    if (typeof code !== 'string') throw codedError('shader-patch', `[threedog] patch '${p.name}' slot '${name}' must be GLSL code as a string; got ${typeof code}`);
    const marked = mark(p.name, name, s.closes ? `${code}
${s.closes}` : code);   // closes: a line the engine adds after the code (fog: THREEDOG_FOG_DONE)
    if (s.shadowOnly) { shadow[s.anchor] = marked; used.add('vertex'); continue; }
    glsl[s.stage][s.anchor] = s.at === 'after' ? marked : { [s.at]: marked };
    used.add(s.stage);
  }
  if (p.pars != null) {
    // pars goes first in each stage: same JSON as the hand-written anchor form { pars, <chunk>: code }, so the cacheKey "same key, same code" check recognizes it as the same piece
    const put = (st, text) => { glsl[st] = { pars: text, ...glsl[st] }; };
    if (typeof p.pars === 'string') for (const st of used) put(st, p.pars);
    else if (isObject(p.pars)) for (const st of /** @type {const} */ (['vertex', 'fragment'])) { if (p.pars[st]) put(st, p.pars[st]); }
    else throw codedError('shader-patch', `[threedog] patch '${p.name}': pars is GLSL declarations as a string, or { vertex, fragment }`);
  }
  const { slot, pars, ...rest } = p;
  const out = { ...rest, glsl: { ...(Object.keys(glsl.vertex).length ? { vertex: glsl.vertex } : {}), ...(Object.keys(glsl.fragment).length ? { fragment: glsl.fragment } : {}) } };
  // shadowPosition: code only for the depth / distance materials (patches.js shadowMaterial), so the patch counts as moving its shadow
  if (Object.keys(shadow).length) { out.shadowVertex = shadow; out.shadow = true; }
  return out;
}

/**
 * A patch's tsl field as { slot: code } (WebGPU route, render/fx/patchNodes.tsl.js applies it): tsl: (ctx) => node goes to the patch's
 * slot; tsl: { position: fn, color: fn } names several. Throws on an unknown slot, and on lightsPars, which TSL does not have.
 * @param {any} p
 * @returns {Record<string, any>}
 */
function tslSlots(p) {
  // slot: 'lighting' + tsl: { start, light, direct, after } is that slot's hook object, not a slot map (no slot has those names)
  const hooks = isObject(p.tsl) && p.slot != null && Object.keys(p.tsl).length > 0 && Object.keys(p.tsl).every(k => LIGHT_HOOKS.includes(k));
  const by = typeof p.tsl === 'function' || hooks ? (p.slot != null ? { [p.slot]: p.tsl } : null) : isObject(p.tsl) ? p.tsl : undefined;
  if (by === null) throw codedError('shader-patch', `[threedog] patch '${p.name}' has a tsl function but no slot; add slot: ${SLOT_NAMES.join(' | ')}, or write tsl: { <slot>: (ctx) => node }`);
  if (by === undefined) throw codedError('shader-patch', `[threedog] patch '${p.name}': tsl is (ctx) => node with slot:, or { <slot>: (ctx) => node }; got ${typeof p.tsl}`);
  for (const name of Object.keys(by)) {
    // TSL has no declaration area: the sun direction and shadow value lightsPars code reads come to the lighting slot's direct() hook instead
    if (name === 'lightsPars') throw codedError('shader-patch', `[threedog] patch '${p.name}': slot 'lightsPars' does not exist on WebGPU (TSL has no declaration area); read the light's direction and shadow in the lighting slot's direct hook: tsl: { lighting: { direct(light, ctx) { ... }, after(ctx) { ... } } }`);
    if (!SLOTS[name]) throw codedError('shader-patch', `[threedog] patch '${p.name}': unknown tsl slot '${name}'; use ${NODE_SLOTS.join(' | ')}`);
    if (!SLOTS[name].node) throw codedError('shader-patch', `[threedog] patch '${p.name}': slot '${name}' is WebGL only (${SLOTS[name].nodeMeaning}); tsl slots: ${NODE_SLOTS.join(' | ')}`);
  }
  return by;
}

/** The node column as text: the property, the setup method the code runs in, or WebGL only @param {Slot} s */
const nodeText = s => !s.node ? 'WebGL only' : s.node.prop ? `\`${s.node.prop}\`` : `inside \`${s.node.setup}\``;
/** The slot table as a markdown table; recipe 43 holds a copy that threedog check R42 compares (it imports this) @internal */
export const slotTable = () => ['| slot | GLSL (WebGL) | WebGPU (NodeMaterial) | in scope | meaning |', '|---|---|---|---|---|',
  ...SLOT_NAMES.map(n => { const s = SLOTS[n]; return `| \`${n}\` | ${s.at} \`${s.anchor}\`${s.shadowOnly ? ' (shadow passes)' : ''} | ${nodeText(s)} | ${s.scope} | ${s.meaning}${s.nodeMeaning ? `; WebGPU: ${s.nodeMeaning}` : ''} |`; })].join('\n');
