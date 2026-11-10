// Props (each item of content/props.js): data is a plain record in engine.world with kind 'prop'; model and collision are "presentation that exists only when
// near".
//   record: { id, kind: 'prop', position: {x,y,z}, model, rot?, scale?, ground?, collide?, occluder?, offsetY?, static?, batch?, source?, zone? } (plain values only)
//   rot = the entry's rot plus its place's. source names the arrangement an entry was copied from: a tag for world.query, nothing at runtime reads it.
// Initial world data (initial: true on add): the save records only moves / removals, independent of content.load running before or after loading a save;
// positions using level markers carry a zone (data is kept across level changes).
//   id: the written id if content gives one; otherwise `prop:<model name>:<index in this props array>` (same on every load of the same content, no collisions).
//       To insert new entries in the middle later, give existing ones an id; otherwise later indexes shift and no longer match moves / removals in old saves.
// move / remove: engine.world.move(id, { x, z }) / engine.world.remove(id), included in the save automatically; height y is computed from the ground both on
// add and when the model is built, so ignore it.
// models: one prototype per model name (same-name props share geometry and material), each placement clones it; built when near (within view distance), torn
// down when far, only detached while keeping the prototype.
// collision: built / torn down with the model (only things near the player need to block), so props beyond the collision radius take no space in the collision
// table.
//   An entry with template (instead of model) is an instance of a content template: see templates.js.
import { buildModel, settle, fits, unbuildModel } from './models.js';
import { placeTemplate } from './templates.js';
import { srcOf } from './ids.js';
import { placeY } from '../../core/scene/ground.js';
import { tiltError } from './models.js';
import { isTilted } from './rules.js';
import { PLACEMENT_FIELDS, collideProblem } from './rules.js';
import { list } from '../../core/base/util.js';
import { DEV, fmt, closest } from '../../core/base/validate.js';
import { codedError } from '../../core/base/errorHints.js';

/** Stable id of a prop: the written id if given, otherwise "model name + array index" */
const propId = (p, i) => p.id ?? `prop:${list(p.model)[0]}:${i}`;

/**
 * Add the props array as initial world data (existing same-id records are kept, ones removed in the save are not re-added). zoneOf(p) gives the level an item
 * belongs to (null = everywhere); ids: this load's IdCheck
 */
export function addProps(e, api, props, st, zoneOf, ids) {
  const world = needWorld(e);
  presentProps(e, api, world, st);
  props.forEach((p, i) => {
    const at = DEV ? srcOf(props, i) : null;
    if (p.template) return placeTemplate(e, api, st, p, i, zoneOf(p), ids, at);   // an instance of a content template (templates.js), not a plain prop
    if (p.grid) return placeGridItem(e, p, i, zoneOf(p), ids, at);               // a pre-placed grid item (grid module)
    const collide = collideProblem(p.collide);
    if (collide) throw codedError('content-misuse', `props[${i}] (model ${JSON.stringify(p.model)}): collide ${collide}`);
    if (p.collide && isTilted(p) && !e.collider3d) throw tiltError({ ...p, id: p.id });
    const id = propId(p, i), free = p.ground === false, { x, y, z } = api.where(free ? { ...p, y: undefined, floor: undefined } : p), zone = zoneOf(p), floor = api._floorOf(p);
    if (p.id != null) ids.claim(p.id, `props[${i}] (model ${JSON.stringify(p.model)})`);
    // compute y from the ground now (same as when the model is built): unmoved props equal the content and stay out of the save
    const def = { id, kind: 'prop', position: { x, y: free ? p.y ?? 0 : y ?? (placeY(e, `props[${i}] (model ${JSON.stringify(p.model)})`, x, z)), z }, model: p.model };
    for (const k of ['scale', 'ground', 'collide', 'occluder', 'static', 'batch', 'lod', 'source']) if (p[k] !== undefined) def[k] = p[k];
    const rot = api._facingOf(p);
    if (rot !== undefined) def.rot = rot;
    if (p.y && !free) def.offsetY = p.y;
    if (floor !== undefined) def.floor = floor;   // kept so a moved prop lands on the same storey
    if (zone != null) def.zone = zone;
    const rec = world.add(def, { initial: true });
    if (rec && (rec.kind !== 'prop' || JSON.stringify(rec.model) !== JSON.stringify(p.model))) throw codedError('world-id', `Prop id "${id}" is already used by other data (${rec.kind}${rec.model ? ' ' + JSON.stringify(rec.model) : ''}): give this item a different id, e.g. { id: '${id}-2', model: ... }`);
    if (DEV) world.setOrigin(id, { definedAt: at, model: p.model });
  });
}

const GRID_STRINGS = {
  noId: "props[{i}]: a grid item needs an id (the player can move or pick it up, and the save names it), e.g. { id: '{item}-1', grid: '{grid}', item: '{item}', cell: [0, 0] }",
  noGrids: 'props[{i}] places on grid "{grid}": install grids() and add the grid first (content/grids.js or engine.grids.add)',
  keys: "props[{i}] (grid item): unknown key '{key}'{hint}. A grid item takes {list} (rules.js PLACEMENT_FIELDS['props.grid'])",
};

// the keys a grid item may have: the placement field table (rules.js), the same one content-check and engine.content.fields('props.grid') read
const GRID_KEYS = Object.keys(PLACEMENT_FIELDS['props.grid']);

/**
 * A props entry { id, grid, item, cell, rotation?, fields? }: the same record grid.place makes, added as authored data (moves / pick-ups are saved as a diff)
 */
function placeGridItem(e, p, i, zone, ids, at) {
  for (const k of Object.keys(p)) if (!GRID_KEYS.includes(k)) {
    const c = closest(k, GRID_KEYS);
    throw codedError('content-misuse', fmt(GRID_STRINGS.keys, { i, key: k, hint: c ? ` (did you mean '${c}'?)` : '', list: GRID_KEYS.join(', ') }));
  }
  if (p.id == null) throw codedError('content-misuse', fmt(GRID_STRINGS.noId, { i, grid: p.grid, item: p.item ?? 'bed' }));
  if (!e.grids) throw codedError('content-misuse', fmt(GRID_STRINGS.noGrids, { i, grid: p.grid }));
  ids.claim(p.id, `props[${i}] (grid ${p.grid} item ${p.item})`);
  const { kind, fields } = e.grids.placement(p.grid, p.item, p.cell, p.rotation ?? 0);
  const rec = e.world.add({ id: p.id, kind, ...fields, ...structuredClone(p.fields ?? {}), ...(zone != null && { zone }) }, { initial: true });
  if (rec && rec.kind !== kind) throw codedError('world-id', `grid item id "${p.id}" is already used by other data (kind ${rec.kind}): give it a different id`);
  if (DEV) e.world.setOrigin(p.id, { definedAt: at });
}

/** Dev error when the world module is not installed */
export function needWorld(e) {
  if (!e.world) throw codedError('module-needs', 'content has props or pickups, whose data is stored in world: call engine.use(world()) first (the openWorld() preset already installs it)');
  return e.world;
}

/** Register how props are displayed (once per content) */
function presentProps(e, api, world, st) {
  if (st.propsPresenter) return;

  st.propsPresenter = st.track(world.present('prop', {
    // build by view distance: follows the terrain view distance (fog distance if no terrain), also when changed at runtime
    radius: () => Math.max(world.radius, e.stream.activeRadius),
    build: rec => buildModel(e, api, rec, rec.model, rec),   // a failed model generation is reported by world (does not block loading), retried when near again
    // moved / rot or scale changed (world.move sends no event, so compare here): world already put the model at the new position; collision and rays follow
    update(rec, o) { if (!fits(e, o, rec)) settle(e, rec, o, rec); },
    dispose: (rec, o) => unbuildModel(e, o),
  }));
}
