// Content vocabulary: the "conditions" and "effects" that content files (content/*.js) can use. Shared by the loader, the validator packages/tools/content-check.mjs and the map packages/tools/gamemap.mjs.
// Plain data + small functions, no import of three and nothing from the engine but node-safe core/base/util.js (the validator reads it directly in node). Real execution is in loader.js.
//
// Conditions (quest step done, dialogue option if, line variant if): several items in one object must all hold; array = every item holds
//   { flag: 'metFisher' }  { notFlag: 'x' }  { has: { berry: 3 } }  { lacks: { film: 6 } }  { counter: { sunsetPhotos: 1 } }
//   { can: ['shop.buy', { shop: 'bakery', item: 'bread' }] }   an op would succeed now (engine.ops.can)
// Effects (dialogue node/option do, quest reward, trigger onEnter/onExit): same, one or several items or an array
//   { setFlag: 'metFisher' }  { give: { film: 6 } }  { take: { berry: 3 } }  { bump: 'sunsetPhotos' }  { startQuest: 'first-light' }
//   { toast: 'text' }  { particles: { name: 'sparks', at: [x, y, z], count: 40 } }
//   { marker: 'river' } or { marker: { place: 'home', x: 2, z: 0, label: '门口' } } adds an objective marker (hud module); { clearMarker: 'river' } removes it
//   { op: ['shop.buy', { shop: 'bakery', item: 'bread' }] }   runs a game op (engine.ops.run). A game's own actions are ops (recipes/23-ops.md), never new effect words,
//   so every action has one registration and one log.
//
// Game condition words: in content/rules.js, export default { conditions: { word: { ref, desc, describe, test } } } (conditions only read state),
// registered automatically when the engine loads, and the validator and map read it too. ref is the value notation (the validator checks by it, the loader converts by it):
//   flag flag name · counter counter name · itemCounts { item: count } · counterCounts { counter: count } · quest quest id · text text
//   particles { name, at, count } · clock 'HH:MM' (test/run receive a 0-1 fraction) · position place name or { place, x, z } (receive { x, z })
//   op ['noun.verb', { args }] · any not checked
//
// Game content kinds: the same content/rules.js may export kinds: { name: { desc, load, check, map } }, so a game keeps its own data
// (enemies, recipes, loot tables, waves, shop stock) in content/<name>.js. The loader, content-check and GAMEMAP all read this one table:
//   desc  one line (map, file list) · load(e, data, content) hands the data to the game when engine.content.load runs (optional: a game that imports the file itself needs none)
//   check(data, ctx)  optional validation in npm run check: ctx.err(msg) / ctx.warn(msg); ctx.data is all content (items, npcs…), ctx.known(obj) lists ids
//   map(data)  optional GAMEMAP lines (default: the number of entries and their ids)
//   fields  optional { key: 'int?' | { type, min, max, values, desc } } (core/base/params.js format, no default): the keys of each entry; content-check
//           reports unknown keys (did you mean), wrong types, out of range, and missing required keys; engine.content.fields(name) returns it
//   export default { kinds: { recipes: { desc: 'crafting recipes (id -> { needs: { item: n }, makes })', load: (e, data) => e.crafting.add(data),
//     check: (data, ctx) => { for (const [id, r] of Object.entries(data)) if (!ctx.data.items?.[r.makes]) ctx.err(`recipe ${id} makes unknown item ${r.makes}`); } } } };

import { list, isObject } from '../../core/base/util.js';
import { sectionDocs, sectionEffects } from '../../core/inspect/metadata.generated.js';

const counts = o => Object.entries(o || {}).map(([k, n]) => `${k}×${n}`).join('、');
const opText = v => Array.isArray(v) ? `${v[0]}${v[1] ? ' ' + Object.entries(v[1]).map(([k, x]) => `${k}=${x}`).join(' ') : ''}` : String(v);
const posText = v => typeof v === 'string' ? v : v.place ? `${v.place}${v.x || v.z ? `(${v.x ?? 0},${v.z ?? 0})` : ''}` : `(${v.x},${v.z})`;

const RULE_STRINGS = {
  conditions: {
    flag: { ref: 'flag', desc: 'story flag is set', describe: v => `flag ${v}` },
    notFlag: { ref: 'flag', desc: 'story flag is not set', describe: v => `no flag ${v}` },
    has: { ref: 'itemCounts', desc: 'inventory has at least', describe: v => `has ${counts(v)}` },
    lacks: { ref: 'itemCounts', desc: 'inventory has fewer than', describe: v => `fewer than ${counts(v)}` },
    counter: { ref: 'counterCounts', desc: 'counter is at least', describe: v => `counter ${Object.entries(v).map(([a, n]) => `${a}≥${n}`).join(', ')}` },
    can: { ref: 'op', desc: 'an op would succeed now (engine.ops.can)', describe: v => `can ${opText(v)}` },
  },
  effects: {
    setFlag: { ref: 'flag', desc: 'set a story flag', describe: v => `set flag ${v}` },
    give: { ref: 'itemCounts', desc: 'give items', describe: v => `give ${counts(v)}` },
    take: { ref: 'itemCounts', desc: 'take items', describe: v => `take ${counts(v)}` },
    bump: { ref: 'counter', desc: 'counter +1', describe: v => `counter ${v}+1` },
    toast: { ref: 'text', desc: 'show a toast', describe: v => `toast "${v}"` },
    particles: { ref: 'particles', desc: 'play particles', describe: v => `particles ${v.name}×${v.count ?? ''}` },
    marker: { ref: 'position', desc: 'add an objective marker (hud module)', describe: v => `marker ${posText(v)}${v.label ? `"${v.label}"` : ''}` },
    // raw: the value names the marker (content-check still reads it as a place); a place that is gone, on a level left behind, must not stop the clearing
    clearMarker: { ref: 'position', raw: true, desc: 'remove an objective marker', describe: v => `remove marker ${posText(v)}` },
    op: { ref: 'op', desc: "run a game op (engine.ops.run); the game's own actions are ops", describe: v => `op ${opText(v)}` },
  },
  // Placement fields: the keys one entry of a content file may have, in the core/base/params.js spec format. Declared once here, read by the loader
  // (unknown keys), content-check (unknown keys with did-you-mean, wrong type, out of range, not in values) and engine.content.fields() (an editor
  // panel's rows), so the three cannot drift apart. props has three entry shapes: a plain model ('props'), a template instance ('props.template',
  // plus the template's state fields) and a grid item ('props.grid'). Required-ness of x / z / model is checked by the content rules themselves
  // (x, z are optional when place is given), so they are marked optional here.
  fields: (() => {
    const at = {
      place: { label: 'Place', rare: true, type: 'string', optional: true, desc: "place name (places.js / level marker); x and z are then offsets from it and turn with the place's rot" },
      x: { type: 'number', optional: true, desc: 'meters along x (offset from place when place is given)' },
      z: { type: 'number', optional: true, desc: 'meters along z (offset from place when place is given)' },
      floor: { label: 'Storey height', rare: true, type: 'number', optional: true, desc: 'reference height of the storey it stands on (multi-layer ground)' },
      y: { label: 'Height', type: 'number', optional: true, desc: 'meters above the ground it stands on (the height itself when ground is false)' },
    };
    const pose = {
      rot: { label: 'Facing', type: 'number|position', optional: true, desc: 'facing around the vertical axis, radians; or [x, y, z] radians to tilt it (a tilted collide needs a collider3d provider)' },
      scale: { label: 'Size', type: 'number|position', optional: true, desc: 'uniform scale (1 = model size), or [x, y, z] per axis' },
    };
    // a plain tag, so world.query({ where: r => r.source === 'stall' }) finds every copy of one arrangement; nothing else reads it
    const copied = { source: { label: 'Copied from', rare: true, type: 'string', optional: true, desc: 'name of the arrangement this entry was copied from; queryable, no other effect' } };
    return {
      props: {
        id: { type: 'string', optional: true, desc: 'stable id (needed when entries are later inserted in the middle)' },
        model: { type: 'any', desc: "model name, or [name, ...args] for a generated model" }, ...at, ...pose, ...copied,
        ground: { type: 'bool', optional: true, desc: 'false = do not snap to the ground: y is the height in the world' },
        collide: { label: 'Collision', rare: true, type: 'any', optional: true, desc: "collision: 'box', 'circle', { circle?: radius, occluder?: false, layer?: 'gate' } (layer: characters with passes: ['gate'] walk through), or false = none" },
        occluder: { label: 'Blocks camera', rare: true, type: 'bool', optional: true, desc: 'false = a solid prop the follow camera may pass through (walkers are still stopped)' },
        static: { label: 'Never moves', rare: true, type: 'bool', optional: true, desc: 'never moves (may be merged into one draw call)' },
        batch: { label: 'Merge copies', rare: true, type: 'bool', optional: true, desc: 'false = never batch this copy' },
        lod: { label: 'Far detail', rare: true, type: 'any', optional: true, desc: 'true = lower-detail levels far away (threedog assets optimize --lod), or rising distances in meters like [40, 120]; such a copy is never batched' },
      },
      'props.template': {
        template: { type: 'string', desc: 'template name (content/templates.js)' },
        id: { type: 'string', optional: true, desc: 'stable id; instances with state should have one' }, ...at, ...pose, ...copied,
        items: { label: 'Starts with', rare: true, type: 'object', optional: true, desc: "starting goods of the instance's container { itemId: count }" },
      },
      'props.grid': {
        id: { type: 'string', desc: 'stable id (the player can move or pick it up)' },
        grid: { type: 'string', desc: 'grid name (content/grids.js)' },
        item: { type: 'string', desc: 'grid item name' },
        cell: { type: 'position', desc: 'grid cell [col, row]' },
        rotation: { label: 'Quarter turns', type: 'int', optional: true, values: [0, 1, 2, 3], desc: 'quarter turns' },
        fields: { label: 'Own fields', rare: true, type: 'object', optional: true, desc: 'record fields of this copy' },
      },
      pickups: {
        id: { type: 'string', optional: true, desc: 'stable id' },
        item: { type: 'string', desc: 'item id (items.js)' }, ...at,
        count: { type: 'int', optional: true, min: 1, desc: 'how many one pickup gives' },
        data: { label: 'Extra data', rare: true, type: 'any', optional: true, desc: 'extra data handed to the game' },
        radius: { label: 'Reach', rare: true, type: 'number', optional: true, min: 0, desc: 'pickup reach in meters' },
        auto: { label: 'Walk to take', rare: true, type: 'bool', optional: true, desc: 'taken by walking into it, no key' },
        respawn: { label: 'Comes back after', rare: true, type: 'number', optional: true, min: 0, desc: 'seconds until it comes back (0 = never)' },
      },
      views: {
        position: { type: 'position', optional: true, desc: 'camera position [x, y, z]' },
        target: { type: 'position', optional: true, desc: 'point looked at [x, y, z]' },
        fov: { type: 'number', optional: true, min: 1, max: 179, desc: 'vertical field of view, degrees' },
      },
    };
  })(),
  // ref of conditions / effects -> how to write the value (used to generate API docs)
  refs: {
    flag: "value is a flag name, e.g. 'metFisher'", counter: "value is a counter name, e.g. 'sunsetPhotos'", itemCounts: 'value is { itemId: count }, e.g. { berry: 3 }',
    counterCounts: 'value is { counterName: count }, e.g. { sunsetPhotos: 1 }', quest: 'value is a quest id', text: 'value is text',
    particles: 'value is { name, at: [x, y, z], count }', op: "value is ['noun.verb', { args }], e.g. ['shop.buy', { shop: 'bakery', item: 'bread' }]", position: 'value is a place name, or { place, x, z } / { x, z }', clock: "value is 'HH:MM'", any: 'value is passed to the function as is',
  },
  and: ' and ', then: ', ', fn: '(function)',
};
const S = RULE_STRINGS;

/** Built-in condition words of the engine */
export const CONDITIONS = RULE_STRINGS.conditions;
/** Built-in effect words of the engine */
export const EFFECTS = RULE_STRINGS.effects;
/** Every effect word of the engine: the built-in ones and those a section's owner declares, which metadata.mjs reads out for the tools that run without an engine */
export const ALL_EFFECTS = { ...EFFECTS, ...Object.fromEntries(Object.entries(sectionEffects).map(([k, d]) => [k, { ...d, describe: v => d.describe.replace('{v}', v) }])) };
/** ref → ref -> how to write the value */
export const REFS = RULE_STRINGS.refs;
/** content entry shape -> { key: field spec } (core/base/params.js format): 'props', 'props.template', 'props.grid', 'pickups', 'views'. Read via fields.js */
export const PLACEMENT_FIELDS = RULE_STRINGS.fields;
/** Why a prop's or template's `collide` is wrong, or null. One rule for the load and content-check: a mistyped object must not quietly become a box */
export function collideProblem(v) {
  if (v === undefined || v === false || v === 'box' || v === 'circle') return null;
  const keys = isObject(v) ? Object.keys(v) : [];
  const form = keys.length > 0 && keys.every(k => k === 'circle' || k === 'occluder' || k === 'layer');
  if (form && (v.circle === undefined || Number.isFinite(v.circle) && v.circle > 0) && (v.occluder === undefined || typeof v.occluder === 'boolean')
    && (v.layer === undefined || typeof v.layer === 'string' && v.layer)) return null;
  return `must be one of false, "box", "circle" or { circle?: radius in meters above 0 (a box without it), occluder?: false, layer?: 'gate' }, got ${JSON.stringify(v)}`;
}
/** A prop turned about X or Z (not only faced about Y): the three-axis provider holds it. One reading for the load and content-check */
export const isTilted = rec => Array.isArray(rec?.rot) && !!(rec.rot[0] || rec.rot[2]);
/** Why a layer is ignored, or null: collide.layer on a tilted prop (collider3d has no layers, so it stops every mover). The load warns with it, content-check reports it */
export const layerIgnored = (rec, collide) => isTilted(rec) && isObject(collide) && collide.layer ? 'collide.layer needs an upright model; this tilted one stops every mover' : null;
/** Why a place cannot load, or null: a turned place moves everything standing on it, so a bad rot stops at the load and in content-check alike */
export const placeProblem = p => p?.rot !== undefined && !Number.isFinite(p.rot) ? `rot must be a number of radians about Y, got ${JSON.stringify(p.rot)}` : null;
/** Clock time notation 'HH:MM' (24-hour) */
export const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Merge the engine vocabulary and the game vocabulary (default export of the game's content/rules.js) -> { conditions, effects }. Games add conditions only */
export function mergeRules(game = {}) {
  return { conditions: { ...CONDITIONS, ...game.conditions }, effects: ALL_EFFECTS };
}
/** Every content name a game may use: the engine's sections plus the game's kinds (rules.js kinds) -> description; the one list loader, content-check and GAMEMAP share */
export function contentFiles(game = {}) {
  const out = { ...sectionDocs };
  for (const [name, k] of Object.entries(game?.kinds || {})) out[name] ??= k?.desc || 'game data kind';
  return out;
}
/** Problems with a game's kinds table (name clashes with an engine file, a load that is no function): a list of messages */
export function kindProblems(game = {}) {
  return Object.entries(game?.kinds || {}).flatMap(([name, k]) => [
    ...(sectionDocs[name] ? [`kind "${name}" is an engine content file name: pick another name (engine files: ${Object.keys(sectionDocs).join(', ')})`] : []),
    ...(k?.load !== undefined && typeof k.load !== 'function' ? [`kind "${name}": load must be a function (e, data) => …, or left out when the game imports the file itself`] : []),
  ]);
}
/** Error text for a content name that is neither an engine file nor a registered kind */
export const unknownContent = (name, game) => `unknown content "${name}". Known: ${Object.keys(contentFiles(game)).join(', ')}. `
  + `For the game's own data, register it in content/rules.js: export default { kinds: { ${name}: { desc: '…', load: (e, data) => { … } } } }, and list \`rules\` in content/index.js too: the loader only knows what it is handed`;
/** Error text for an effects key in a game's content/rules.js */
export const NO_GAME_EFFECTS = "content/rules.js: effects is not a key here. Register the action as an op (engine.ops.define('noun.verb', { can, run }) in main.js) "
  + "and call it from content with { op: ['noun.verb', { args }] }; see recipes/23-ops.md §2";

const say = (vocab, x) => Object.entries(x).map(([k, v]) => vocab[k]?.describe?.(v) ?? `${k} ${JSON.stringify(v)}`);

/** Describe a condition as one human-readable sentence (for the map); vocab defaults to the engine vocabulary */
export function describeCond(c, vocab = CONDITIONS) {
  if (!c) return '';
  if (typeof c === 'function') return S.fn;
  return list(c).map(x => say(vocab, x).join(S.and)).join(S.and);
}
/** Describe an effect as one human-readable sentence (for the map); vocab defaults to the engine vocabulary */
export function describeEffect(a, vocab = ALL_EFFECTS) {
  if (!a) return '';
  if (typeof a === 'function') return S.fn;
  return list(a).map(x => say(vocab, x).join(S.then)).join(S.then);
}
