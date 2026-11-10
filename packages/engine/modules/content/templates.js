// Content templates (content/templates.js): one reusable object = model + collision + interaction + optional container / sound / animation + state defaults.
// The template is a shared, frozen definition; every placed copy is a world record whose kind is the template name and whose own fields are its state.
//   content/templates.js:
//     export default { chest: { model: 'chest', collide: 'box', state: { opened: false },
//       interact: { label: rec => rec.opened ? '关上' : '打开', op: 'chest.toggle' },          // op is run with { id } of the instance
//       container: { capacity: 6, items: { berry: 2 } }, sound: { use: 'chest' },               // container id = record id
//       animate: (rec, obj, dt) => { obj.rotation.x = rec.opened ? -0.3 : 0; } } };              // per-frame look from the record
//   content/props.js:  { template: 'chest', id: 'chest-home', place: 'home', x: 3, z: 1, opened: true, items: { film: 2 } }   // position + overrides
//   code (in an op or fixed step): engine.content.spawn('chest', { x: 10, z: 4 }, { opened: true })   // runtime copy, saved whole; id 'chest#<n>'
// Things that change over game time (a crop, a turret warming up, a building under construction) add stages (stages.js) and update:
//     crop: { model: 'crop-seed', state: { watered: false },
//       stages: [{ name: 'seed', duration: 600 }, { name: 'sprout', duration: 900, scale: 0.6 }, { name: 'ripe', model: 'crop-ripe' }],
//       canGrow: rec => rec.watered,                                    // asked every step, near and far; false holds the stage (blocked time does not count)
//       update: (rec, dt, e) => { if (rec.stage === 2) rec.glow = Math.min(1, (rec.glow ?? 0) + dt); },   // fixed step, near only
//       interact: { label: '浇水', op: 'crop.water' } }                 // interactions are ops, never callbacks
//   the record carries stage (a state field, default 0) and stageAt (clock.now when it entered); event template:stage { id, template, stage, name }.
// Why one system: every saveable, interactive placeable is a template, so the save, content-check, content.fields() and the editor all see one shape.
// Definition (shared, read-only): model, collide, static, interact, container capacity / starting goods, sound, animate, stages, update, canGrow,
// state defaults.
// Instance (saved): the record (id, kind, position, rot, scale, y offset, state fields) and the container with the record's id (its goods).
// A placement may override only rot / scale / y / items and the state fields; a different look or behaviour is a different template.
// Recipe: docs/recipes/30-templates.md.
// body: { shape: 'box' | 'ball' | 'hull', mass?, friction?, restitution?, damping?, angularDamping? } makes each copy a rigid body (needs rigid()):
//   it can be pushed, the model moves itself and its position is copied back to the record, so a pushed crate's place is saved like any other change,
//   and its whole state (turn, speed, asleep) with it in the save part 'rigid'. A copy nothing moved stays out of the save.
// Ids: an instance with state (state / container / interact / body) should have a written id (ids.js); without one dev warns.
import { checkOptions, freezeDef, missingText, fmt, DEV } from '../../core/base/validate.js';
import { xzOf, scaleOf } from '../../core/base/math.js';
import { placeY } from '../../core/scene/ground.js';
import { buildModel, settle, fits, fitsShape, unbuildModel } from './models.js';
import { srcOf, stateful, templateId } from './ids.js';
import { PLACEMENT_FIELDS, collideProblem } from './rules.js';
import { fieldsShape } from './fields.js';
import { whyBad, readParams, keysSchema } from '../../core/base/params.js';
import { stagesProblems, stagedFields, growStages } from './stages.js';
import { codedError } from '../../core/base/errorHints.js';

const DEF_KEYS = ['model', 'collide', 'occluder', 'static', 'lod', 'interact', 'container', 'sound', 'animate', 'state', 'fields', 'body', 'stages', 'update', 'canGrow'];
const BODY_KEYS = ['shape', 'mass', 'friction', 'restitution', 'damping', 'angularDamping'];
// what a placement may set besides the state fields: the placement field table (rules.js), so the loader, content-check and content.fields() agree
const PLACE_KEYS = Object.keys(PLACEMENT_FIELDS['props.template']);
// content.spawn gets its position as an argument, so only the id and the picture / goods keys of the same table
const SPAWN_KEYS = PLACE_KEYS.filter(k => !['template', 'place', 'x', 'z', 'floor', 'source'].includes(k));

const STRINGS = {
  noModel: "template '{name}' needs a model: a model name from an asset pack (engine.assets.manifest({ models: { chest: '/models/chest.glb' | fn } })), e.g. { model: 'chest' }",
  noOp: "template '{name}': interact needs op, the op run with { id } of the instance when used, e.g. interact: { label: '打开', op: 'chest.toggle' } "
    + "and in main.js engine.ops.define('chest.toggle', { run: (e, { id }) => e.world.set(id, { opened: !e.world.get(id).opened }) })",
  taken: "template '{name}': world kind '{name}' already has a world.present of its own; rename the template (its name is the kind of its instances)",
  clash: 'template instance id "{id}" is already used by other data (kind {kind}): give it a different id, e.g. { id: "{id}-2", template: "{name}" }',
  defKey: "template '{name}': '{key}' belongs to the definition and cannot be set per instance. Define another template for a different {key}",
  noBox: "template '{name}' has no container, so an instance cannot have items. Add container: { capacity } to the template",
  noInv: "template '{name}' has a container: install inventory() (the openWorld() preset includes it)",
  noRigid: "template '{name}' has a body: install rigid() (real physics; the openWorld() preset includes it)",
  shape: "template '{name}': body.shape must be 'box', 'ball' or 'hull', e.g. body: { shape: 'box', mass: 2 }",
  fn: "template '{name}': {key} must be a function {sig}",
  onUse: "template '{name}': interact.onUse is not supported; an interaction runs an op (logged, replayable, checkable), e.g. interact: { op: '{name}.use' } "
    + "and engine.ops.define('{name}.use', { run: (e, { id }) => ... })",
  noStages: "template '{name}': canGrow only applies with stages (it holds the current stage while false)",
};

/** Register template definitions (frozen) and their presenters; a later load replaces a definition of the same name. @internal */
export function defineTemplates(e, api, st, defs) {
  for (const [name, d] of Object.entries(defs)) {
    readParams(`template '${name}'`, keysSchema(DEF_KEYS), d);
    if (!d?.model) throw codedError('content-template', fmt(STRINGS.noModel, { name }));
    const collide = collideProblem(d.collide);
    if (collide) throw codedError('content-template', `template '${name}': collide ${collide}`);
    if (d.interact) {
      readParams(`template '${name}' interact`, keysSchema(['label', 'op', 'radius', 'height', 'action', 'enabled']), d.interact);
      // why a throw and not the usual unknown-key warning: a callback here would be a second, unlogged way to change saved state
      if ('onUse' in d.interact) throw codedError('content-template', fmt(STRINGS.onUse, { name }));
      if (!d.interact.op) throw codedError('content-template', fmt(STRINGS.noOp, { name }));
      st.ops.add(d.interact.op);   // checked against engine.ops once the game is ready, like { op } in content
    }
    readParams(`template '${name}' container`, keysSchema(['capacity', 'maxWeight', 'items']), d.container);
    readParams(`template '${name}' sound`, keysSchema(['use']), d.sound);
    if (d.container && !e.inventory) throw codedError('content-template', fmt(STRINGS.noInv, { name }));
    if (d.body) {
      readParams(`template '${name}' body`, keysSchema(BODY_KEYS), d.body);
      if (!['box', 'ball', 'hull'].includes(d.body.shape)) throw codedError('content-template', fmt(STRINGS.shape, { name }));
      if (!e.rigid) throw codedError('content-template', fmt(STRINGS.noRigid, { name }));
    }
    const sp = stagesProblems(`template '${name}'`, d.stages);
    if (sp.length) throw codedError('content-template', sp.join('; '));
    for (const [key, sig] of [['update', '(rec, dt, engine) => void'], ['canGrow', '(rec, engine) => boolean'], ['animate', '(rec, obj, dt) => void']]) {
      if (d[key] !== undefined && typeof d[key] !== 'function') throw codedError('content-template', fmt(STRINGS.fn, { name, key, sig }));
    }
    if (d.canGrow && !d.stages) throw codedError('content-template', fmt(STRINGS.noStages, { name }));
    // stages add the `stage` state field (default 0, int 0..n-1): it is then placed, checked and saved like any other state field
    const staged = stagedFields(d);
    // fields: range / values / desc of the state fields (defaults stay in state); the parsed table checks placements and feeds content.fields()
    const f = fieldsShape(`template '${name}'`, staged.fields, staged.state);
    if (f.problems.length) throw codedError('content-template', f.problems.join('; '));
    st.templateFields.set(name, f.shape);
    st.templates.set(name, freezeDef(d.stages ? { ...d, state: staged.state } : d));
    if (DEV) st.templateSrc.set(name, srcOf(defs, name));
    present(e, api, st, name);
    if (d.stages || d.update) simulate(e, st, name);
    limitContainers(e, st, name);
  }
  // a save brings back runtime instances and their goods, but container limits are definition data: put them back from the template
  st.templateLoad ??= st.track(e.events.on('world:load', () => { for (const name of st.templates.keys()) limitContainers(e, st, name); }));
}

/** The definition of a template, or a dev error listing the known ones. @internal */
export function templateOf(st, name) {
  const d = st.templates.get(name);
  if (!d) throw codedError('unknown-name', `${missingText('template', name, [...st.templates.keys()])} (define it in content/templates.js)`);
  return d;
}

/**
 * One entry of content/props.js with template: an initial world record (stable id `<template>:<index>` unless given). @internal
 * ids: this load's IdCheck (null for level nodes, whose ids the level makes); origin: where it was authored ({ definedAt } or { level, node }), dev only
 */
export function placeTemplate(e, api, st, p, i, zone, ids, origin) {
  const name = p.template, d = templateOf(st, name), id = templateId(p, i), { x, y, z } = api.where(p), floor = api._floorOf(p);
  const own = instanceFields(name, d, p, PLACE_KEYS, st.templateFields.get(name));
  if (floor !== undefined) own.floor = floor;   // same as props: a moved instance lands on the same storey
  const rot = api._facingOf(p);
  if (rot !== undefined) own.rot = rot;
  if (p.source !== undefined) own.source = p.source;
  if (ids && p.id != null) ids.claim(p.id, `props[${i}] (template ${name})`);
  else if (ids && stateful(d)) ids.unnamed(id, `props[${i}] (template ${name})`);
  const rec = e.world.add({ id, kind: name, position: { x, y: y ?? placeY(e, `props[${i}] (template ${name})`, x, z), z }, ...own, ...(zone != null && { zone }) }, { initial: true });
  if (rec && rec.kind !== name) throw codedError('world-id', fmt(STRINGS.clash, { id, kind: rec.kind, name }));
  if (DEV) e.world.setOrigin(id, { ...(typeof origin === 'string' ? { definedAt: origin } : origin), template: name, templateAt: st.templateSrc.get(name) ?? null, model: d.model });
  if (rec) openContainer(e, name, d, id, p.items);   // null = removed in the save: no container either
}

/** engine.content.spawn: a runtime instance (saved whole). at = position ({ x, z } or [x, y, z]; it sits on the ground, fields.y lifts it). @internal */
export function spawnTemplate(e, st, name, at, fields = {}) {
  const d = templateOf(st, name), [x, z] = xzOf(at);
  const own = instanceFields(name, d, fields, SPAWN_KEYS, st.templateFields.get(name));
  if (d.stages) own.stageAt = e.clock.now;   // a spawned copy starts its stage now (an authored placement starts on its first fixed step, stages.js)
  const y = placeY(e, `engine.content.spawn('${name}')`, x, z, undefined, 0) + (fields.y ?? 0);
  const rec = e.world.add({ ...(fields.id != null && { id: fields.id }), kind: name, position: { x, y, z }, ...own });
  if (DEV) e.world.setOrigin(rec.id, { template: name, templateAt: st.templateSrc.get(name) ?? null, model: d.model });   // world.add already noted the op that spawned it
  openContainer(e, name, d, rec.id, fields.items);
  return rec;
}

/** Instance fields of a placement: state defaults (copied, never shared), then the allowed overrides; shape = the template's parsed state fields. */
function instanceFields(name, d, p, keys, shape) {
  const state = Object.keys(d.state ?? {});
  for (const key of Object.keys(p)) if (DEF_KEYS.includes(key) && !state.includes(key)) throw codedError('content-template', fmt(STRINGS.defKey, { name, key }));
  checkOptions(`template '${name}' instance`, p, [...keys, ...state]);
  // a state value outside the template's fields (range, values, type) fails here, for engine.content.spawn as well as for content
  for (const k of state) { const why = p[k] !== undefined && whyBad(shape[k], p[k]); if (why) throw codedError('content-template', `template '${name}' instance: ${k} ${why}`); }
  if (p.items && !d.container) throw codedError('content-template', fmt(STRINGS.noBox, { name }));
  const own = structuredClone(d.state ?? {});
  for (const k of state) if (p[k] !== undefined) own[k] = structuredClone(p[k]);
  for (const k of ['rot', 'scale']) if (p[k] !== undefined) own[k] = p[k];
  if (p.y) own.offsetY = p.y;
  return own;
}

/** The instance's container (id = record id); starting goods only the first time, a save wins afterwards (see Containers). */
function openContainer(e, name, d, id, items) {
  if (!d.container) return;
  const { capacity, maxWeight } = d.container;
  e.inventory.container(id, { capacity, maxWeight, items: items ?? d.container.items });
}

function limitContainers(e, st, name) {
  const c = st.templates.get(name).container;
  if (c) for (const r of e.world.query({ kind: name })) e.inventory.container(r.id, { capacity: c.capacity, maxWeight: c.maxWeight });
}

/** How a template's instances look: shared prototype model, collision, interaction; built near, torn down far (once per template name). */
function present(e, api, st, name) {
  const def = () => st.templates.get(name);   // a later load may replace the definition: always read the current one
  const body = !!def().body, was = st.templateViews.get(name);   // a physics body moves the model itself: the record follows the model (positionFrom 'view'), so a pushed position is saved
  if (was?.body === body) return;
  was?.remove();   // a reload that adds or takes out `body`: who places the model changes, and world reads that once per presenter. Every copy rebuilds, from the record
  if (e.world.presents(name)) throw codedError('content-template', fmt(STRINGS.taken, { name }));
  st.templateViews.set(name, st.track(e.world.present(name, {   // tracked: without content there is no definition to build from, and a new content() must be able to present the kind
    radius: () => Math.max(e.world.radius, e.stream.activeRadius),   // same build distance as props
    positionFrom: body ? 'view' : 'record',
    async build(rec) {
      const d = def(), model = modelOf(d, rec), id = rec.id, mine = e.world.building(id);
      const o = await buildModel(e, api, rec, model, d.body ? { ...d, static: false, collide: false } : d, stageScale(d, rec));
      o.userData.model = JSON.stringify(model);   // the built model, as text (describe / tests read it); serialized once per build, never per frame
      o.userData.modelFrom = modelSource(d, rec);      // update compares this cheap key every frame: a stage with another model rebuilds the copy
      if (d.body && e.world.building(id) === mine) addBody(e, rec, o, d);   // a build a load or rebuild replaced meanwhile is dropped: its body would take the id, and the saved state, from the real one
      o.userData.useFrom = e.interactions;
      if (d.interact && e.interactions) o.userData.use = e.interactions.add(o, {
        id, radius: d.interact.radius ?? 2.5, height: d.interact.height, action: d.interact.action,
        label: () => label(e, def().interact?.label, e.world.get(id)) ?? name,
        enabled: () => { const r = e.world.get(id), en = def().interact?.enabled; return !!r && (!en || !!en(r, e)); },
        onUse: () => use(e, def(), id),
      });
      return o;
    },
    update(rec, o, dt) {
      const d = def();
      // a stage that names another model: tear this copy down, world builds the new one next frame (the record, and so the save, is untouched)
      if (d.stages && !sameModel(o.userData, d, rec)) { e.world.rebuild(rec.id); return; }
      if (d.interact && o.userData.useFrom !== e.interactions) { e.world.rebuild(rec.id); return; }   // its use lives in the interactions module it was built with: another one starts empty
      const mul = stageScale(d, rec);
      if (d.body) {   // a body places itself. Its turn and size were built into the solver: a new one needs a new body, built where the record stands
        if (!fitsShape(o, rec, mul) || !sameBody(e, o.userData, d)) { e.world.rebuild(rec.id); return; }
        restBody(e, rec, o);
      } else if (!fits(e, o, rec, mul)) settle(e, rec, o, d, mul);   // a stage scale re-aligns collision too
      d.animate?.(rec, o, dt);
    },
    dispose(rec, o) { o.userData.use?.remove(); o.userData.body?.remove(); unbuildModel(e, o); },
  })));
  st.templateViews.get(name).body = body;
}

const SETTLE = 0.05;   // meters: a body that only settled (contact with uneven ground) moves less than this; a push moves it more
/**
 * A rigid body for one built copy, never batched (it moves). The body owns the pose and the record follows it (positionFrom 'view'), so one thing decides a copy's place:
 * - A copy still where content put it stands on the ground: the collider is centred on the model's origin, so it is lifted by half its height, and that place counts
 *   as the authored one (world.rest). It starts asleep and atRest, which keeps it out of the save: content rebuilds it.
 * - A copy with state in the save (the 'rigid' part, keyed by record id): that state is the pose, speed and sleep, and the record takes it, since no step runs before the next read.
 * - A copy moved with no state (rebuilt by a new holder, a save without it, or a record moved after that state: rigid drops it): it starts awake at the record, so one left in the air comes down.
 */
function addBody(e, rec, o, d) {
  const { shape, ...opts } = d.body, s = o.userData.measure.size, ud = o.userData, p = rec.position;
  ud.batch = false; ud.bodyFrom = d.body; ud.holder = bodyHolder(e);
  const half = s.y * scaleOf(rec)[1] / 2, floor = e.surface(p.x, p.z, rec.floor) + half;
  // a state from the save decides this copy's place, even when the record reads as unmoved (put back by an undo): resting it would rewrite the baseline to a place it is not at
  const unmoved = !e.rigid?.stateFor?.(rec.id) && e.world.rest(rec.id, { x: p.x, y: rec.ground === false ? Math.max(p.y, floor) : floor, z: p.z });
  o.position.y = p.y;
  o.updateMatrixWorld(true);
  if (!ud.holder) return;   // the copy stands as a plain model; sameBody builds its body when a holder is ready
  const add = shape === 'ball' ? 'addBall' : shape === 'hull' && o.isMesh ? 'addHull' : 'addBox';   // a hull needs one mesh; a group gets a box
  const b = ud.body = ud.holder[add](o, { ...opts, id: rec.id });
  if (!b) return;
  // a place written with no height (thing.set [x, 0, z]) means on the ground: a body put inside it goes through a thin floor and falls for good
  b.place = at => { const y = e.surface(at.x, at.z, rec.floor) + half; return at.y < y - SETTLE ? { x: at.x, y, z: at.z } : at; };
  if (b.atRest === false) { const t = b.body.translation(); p.x = t.x; p.y = t.y; p.z = t.z; return; }
  b.atRest = true;
  if (unmoved) b.body.sleep();
  else { const at = b.place(p); if (at !== p) { p.y = at.y; ud.holder.setPosition(b, at); } }
}
/** Who can hold a body now: a rigid still loading its solver is not one yet, so a copy built meanwhile waits instead of throwing */
const bodyHolder = e => e.rigid?.ready ? e.rigid : null;
/**
 * Does the copy carry what the template asks for now, in the holder installed now? A body is a handle into one solver: another holder has none of it, and a hot reload
 * that changes `body` cannot reach a built one. Same definition is a yes without serializing; a reloaded equal one is adopted, as sameModel does.
 */
function sameBody(e, ud, d) {
  if (ud.holder !== bodyHolder(e)) return false;
  if (ud.bodyFrom === d.body) return true;
  if (JSON.stringify(ud.bodyFrom) !== JSON.stringify(d.body)) return false;
  ud.bodyFrom = d.body;
  return true;
}
/**
 * While a body only settles where content put it, the settled pose is its authored rest and it stays out of the save. Settling ends when it first sleeps:
 * from then on anything that wakes it is play, however small the move, and the body's state goes in the save, so nothing a player did is lost to a tolerance.
 */
function restBody(e, rec, o) {
  const ud = o.userData, entry = ud.body;
  if (!entry?.atRest) return;
  ud.restAt ??= { ...rec.position };
  const p = rec.position, r = ud.restAt, asleep = entry.body.isSleeping();
  if ((ud.settled && !asleep) || Math.abs(p.x - r.x) > SETTLE || Math.abs(p.y - r.y) > SETTLE || Math.abs(p.z - r.z) > SETTLE) { entry.atRest = false; return; }
  if (asleep) { e.world.rest(rec.id, p, SETTLE); ud.settled = true; }
}

/**
 * Which definition and which stage supplied the model (the stage index, -1 for the template's own). Two equal keys always mean the same model, so
 * the per-frame check compares one object and one number instead of serializing the model of every instance every frame.
 */
function modelSource(d, rec) {
  for (let i = Math.min(rec.stage ?? 0, (d.stages?.length ?? 0) - 1); i >= 0; i--) if (d.stages[i].model) return { d, at: i };
  return { d, at: -1 };
}
/** The model a copy shows: its stage's model, else the nearest earlier stage's, else the template's (so it never depends on what was built before) */
function modelOf(d, rec) { const { at } = modelSource(d, rec); return at < 0 ? d.model : d.stages[at].model; }
/** Same model as when built? Same definition + same source stage is a yes without serializing; only a reloaded definition falls back to comparing text */
function sameModel(ud, d, rec) {
  const k = modelSource(d, rec), b = ud.modelFrom;
  if (b.d === d) return b.at === k.at;
  if (ud.model !== JSON.stringify(modelOf(d, rec))) return false;
  ud.modelFrom = k;   // a reload with the same model: adopt the new definition so the next frames take the cheap path again
  return true;
}
/** A stage's scale multiplies the instance's own scale (a sprout at 0.6 of a placement scaled 2 is 1.2) */
const stageScale = (d, rec) => d.stages?.[rec.stage ?? 0]?.scale ?? 1;

/**
 * Gameplay of a template kind on the fixed step (world.simulate, once per name; each step reads the current definition, so a later load replaces it).
 * Growth runs near and far (far catches up in calendar seconds, several stages at once); update runs near only: a far copy only grows.
 */
function simulate(e, st, name) {
  if (st.templateSims.has(name)) return;
  const grow = rec => {
    const d = st.templates.get(name);
    if (!d?.stages) return;
    const next = growStages(rec, d.stages, e.clock.now, d.canGrow && (() => !!d.canGrow(rec, e)));
    if (!next) return;
    e.world.set(rec.id, next);   // through world.set: world:change fires and the save keeps it, like any other gameplay change
    e.events.emit('template:stage', { id: rec.id, template: name, stage: next.stage, name: d.stages[next.stage].name });
  };
  st.templateSims.set(name, st.track(e.world.simulate(name, {
    near: (rec, dt) => { grow(rec); st.templates.get(name)?.update?.(rec, dt, e); },
    far: rec => grow(rec),
  })));
}

const label = (e, l, rec) => typeof l === 'function' ? l(rec, e) : l && e.i18n.has(l) ? e.t(l) : l;

/** Using an instance runs the template's op with its id (a gameplay action, logged), then plays the use sound if it succeeded. */
function use(e, d, id) {
  const r = e.ops.run(d.interact.op, { id });
  if (r.ok && d.sound?.use) e.audio.sfx(d.sound.use);
}
