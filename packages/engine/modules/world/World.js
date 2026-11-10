// World data, engine.world: anything the game must remember or keep changing while far away is a plain record here (stable id, kind, position, your own
// fields);
// a model is only what gets built while the record is near the camera. It knows nothing about NPCs, zombies or crops: the game (or a larger module) tells them
// apart by kind and writes its own present / simulate.
// Usage, examples, the update convention (set / move), saves, near / far and zone: see packages/engine/docs/recipes/18-world.md; the save rules are at the top
// of persist.js.
// Data must be plain values (putting a three.js object or a function in it throws in dev); position is a plain { x, y, z }. Don't hold on to rec: loading a
// save swaps in new objects, so keep the id and use world.get(id).
import { DEV, fmt } from '../../core/base/validate.js';
import { checkTypeRule } from '../../core/engine/moduleTypes.js';
import { addRecord, setRecord, removeRecord, queryRecords } from './records.js';
import { Views } from './views.js';
import { Sim } from './sim.js';
import { initState, mixInternals } from './state.js';
import { putPos, centerOf } from './pos.js';
import { codedError } from '../../core/base/errorHints.js';

const STRINGS = {
  anchor: 'world.anchor must be null, an Object3D, a Vector3 / { x, z } or [x, y, z]; got {got}',
};

/** World data (see the top of the file) */
export class World {
  /**
   * @param {any} engine
   * @param {{ cellSize?: number, radius?: number, farEvery?: number, farMaxPerTick?: number, buildPerFrame?: number }} [opts]
   */
  constructor(engine, opts = {}) {
    const { cellSize = 32, radius = 60, farEvery = 1, farMaxPerTick = 500, buildPerFrame = 8 } = opts;
    /** @internal */ this.engine = engine;
    initState(this, cellSize);
    /** All records: id → record (read-only; use set to change fields, move to change position) @type {Map<string, WorldRecord>} @experimental */
    this.records = new Map();
    /**
     * Default distance (meters) for building models and counting as near; present / simulate can override it. Changing it at runtime affects those without
     * their own radius @type {number}
     */
    this.radius = radius;
    /** Default interval (seconds) between far simulations, same unit as dt @type {number} */
    this.farEvery = farEvery;
    /**
     * Max far simulations per fixed step; the rest queue for the next step (dt accumulates, no time is lost). Counted by records, not milliseconds, so results
     * do not depend on machine speed @type {number}
     */
    this.farMaxPerTick = farMaxPerTick;
    /** Max models built per frame; the rest continue next frame (ready waits for all of them; loading is not limited) @type {number} */
    this.buildPerFrame = buildPerFrame;
    /** @internal */ this._v = new Views(this);
    /** @internal */ this._s = new Sim(this);
  }

  /**
   * Gameplay simulation center (near / far is measured from it): null (default) = where engine.actor is (engine.actorPosition(): the player, or engine.focus
   * when there is no player). The built-in stream source engine.stream.player follows the player too (models and colliders around it); the camera source
   * engine.stream.camera adds models only.
   * For another center (a strategy game's base) set a Vector3 / object / { x, z } / [x, y, z]; set null to restore. Read once at the start of each fixed step
   * @example engine.world.anchor = baseObject
   * @type {any}
   */
  get anchor() { return this._anchor; }
  set anchor(a) {
    const ok = a == null || a.isObject3D || (Array.isArray(a) ? a.length === 3 && a.every(Number.isFinite) : Number.isFinite(a.x) && Number.isFinite(a.z));
    if (!ok) throw codedError('world-option', fmt(STRINGS.anchor, { got: JSON.stringify(a) }));
    const boot = this._anchor, S = this.engine.session;
    this._anchor = a ?? null;
    // not saved (it may be an Object3D): set during play, it ends with the playthrough and what boot left comes back. Tracked, so a failed load keeps it
    if (S.captured && !this._anchorEnd) this._anchorEnd = S.track({ remove: () => { this._anchor = boot; this._anchorEnd = null; } });
  }

  /**
   * Current zone (e.g. level name, set by the level module on level change): once set, records of another zone get no model and no near simulation; null = no
   * zoning @type {string | null}
   */
  get zone() { return this._zone; }
  // a zone change must re-decide which models to build (otherwise nothing refreshes while the focus stays still)
  set zone(z) { if (z !== this._zone) { this._zone = z; this._v.dirty = true; } }

  /**
   * Add a record and return it (a plain object). kind is required; without id one is numbered automatically (kind#1, kind#2…, saved; `#` never appears in an
   * authored id, so the two can never collide).
   * opts.initial: initial record written in content (needs an id); saves only keep its changes and removal; if the id already exists the existing one is
   * returned (content may load twice), after taking a new position / rot from the content unless play moved it;
   * returns null if the save removed it (it is not added back). opts.save: false: not saved (temporary things).
   * @example engine.world.add({ id: 'shop_owner', kind: 'npc', position: [12, 0, -30], name: '店主', mood: 'calm' }, { initial: true })
   * @param {{ kind: string, id?: string, position?: any, [field: string]: any }} def
   * @param {{ initial?: boolean, save?: boolean }} [opts]
   * @returns {WorldRecord | null}
   */
  add(def, opts) { checkTypeRule(this.engine, 'world.write', `added a world record (${def?.kind ?? '?'})`); return addRecord(this, def, opts); }
  /**
   * Where a record comes from (filled in dev and test builds; null in release): { definedAt: 'content/props.js:14' } for a content entry,
   * { level, node } for a level-model node, { template } when it is a template instance, { spawned: { op, tick } } for a record created during play.
   * engine.inspect(id) and engine.pick(...).thing show it, so you know which file to edit to change the level for good.
   * @example engine.world.origin('chest-home')   // { definedAt: 'content/props.js:14', template: 'chest' }
   * @param {string} id
   * @returns {{ definedAt?: string, level?: string, node?: string, template?: string, spawned?: { op: string | null, tick: number } } | null}
   */
  origin(id) { return this._origin.get(id) ?? null; }
  /**
   * The id of the record whose model contains obj (obj itself or one of its parents is a built model), else null. A ray hit on a model names its record this
   * way.
   * @example const h = engine.pick(0, 0); const id = h && engine.world.idOf(h.object);
   * @param {any} obj  a THREE.Object3D (a mesh of the model is fine)
   * @returns {string | null}
   * @experimental
   */
  idOf(obj) {
    for (let o = obj; o; o = o.parent) { const id = this._v.byObj.get(o); if (id !== undefined) return id; }
    return null;
  }
  /**
   * Get a record by id (undefined if missing, like a Map)
   * @param {string} id
   * @returns {WorldRecord | undefined}
   */
  get(id) { return this.records.get(id); }
  /**
   * Merge fields into a record and emit the world:change event; a position in patch also moves it. Returns the record.
   * For discrete changes (chest opened, growth stage, picked up); if present has show, it is re-evaluated after the change. id / kind cannot be changed
   * @example engine.world.set('crate_1', { opened: true })
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {WorldRecord}
   */
  set(id, patch) { checkTypeRule(this.engine, 'world.write', `set world record ${id}`); return setRecord(this, id, patch); }
  /**
   * Move a record (no event; use it in simulate for things that move every step); still saved (saves diff against content).
   * The model of a positionFrom 'record' (default) record follows this frame; to do something else with the position in presentation, compare in update.
   * On a live character (the player, an NPC with a model) this is its placeAt: the character owns its position, so it goes there and the record says where it stands.
   * A seated rider gets out to go there (placeAt ends a ride); a write equal to where it sits only follows the seat
   * @example engine.world.move(rec.id, { x: rec.position.x + 1, z: rec.position.z })
   * @param {string} id
   * @param {any} position  Vector3 / object / [x, y, z] / { x, z } (y stays unchanged if omitted)
   * @returns {void}
   */
  move(id, position) {
    DEV && this.engine.ops.guard('world.move');
    const rec = this._need(id, 'move'), live = this._character(rec), to = live ? { ...live.root.position } : rec.position;
    putPos(`world.move("${id}")`, position, to);
    if (live) {   // design.md section 9: the character is the authority. A write that agrees with it is the record following (Character._store, npcSim); any other is a placement
      const p = live.root.position;
      if (p.x !== to.x || p.y !== to.y || p.z !== to.z) live.placeRecord(to);
      rec.position.x = p.x; rec.position.y = p.y; rec.position.z = p.z;
    }
    this._v.placed(rec);
    this._index(rec);
  }
  /** @internal The character that owns this record's pose, or null. A far record rules its own model, except a rider's: the seat would take the write back as it comes near */
  _character(rec) { const ch = this.engine.control?.characterOf(rec.id); return ch && (ch.vehicle || !this._s.recordRules(rec)) ? ch : null; }
  /**
   * Remove a record (its model is torn down too) and emit the world:remove event. Does nothing if the id does not exist. Removing an initial record is saved,
   * so it stays gone after loading
   * @param {string} id
   * @returns {void}
   */
  remove(id) { checkTypeRule(this.engine, 'world.write', `removed world record ${id}`); removeRecord(this, id); }
  /**
   * Query records; returns an array. With near only nearby cells are scanned and results are sorted nearest first (radius defaults to 30 m); where filters
   * further. For neighbor queries every step use forEachNear
   * @example engine.world.query({ kind: 'zombie', near: engine.player, radius: 30, where: z => !z.dead })
   * @param {{ kind?: string, near?: any, radius?: number, where?: (rec: WorldRecord) => boolean, zone?: string | null }} [opts]
   * @returns {WorldRecord[]}
   */
  query(opts = {}) { return queryRecords(this, opts); }
  /**
   * Call fn(rec, d2) for each record within radius meters (horizontal distance) of center; d2 is the squared distance. Unsorted, no allocation: use it for
   * per-step neighbor queries (hundreds of zombies avoiding each other).
   * Don't add / remove / move in the callback (moving into a cell not yet visited visits it again): record the change and apply it after the loop
   * @example engine.world.forEachNear(rec.position, 5, (o, d2) => { if (o !== rec && o.kind === 'zombie') n++; })
   * @param {any} center  Vector3 / object / { x, z }
   * @param {number} radius
   * @param {(rec: WorldRecord, d2: number) => void} fn
   * @returns {void}
   */
  forEachNear(center, radius, fn) { this._cells.forEach(centerOf(center), radius, fn); }

  /**
   * Register how a kind of thing looks: models are built automatically within radius meters of any full-detail stream source (engine.stream: player, camera
   * focus, teleport destination) and torn down when far from all of them (radius × 1.25); tearing down never touches the record. Callbacks:
   * build(rec) → three.js object (may be async). world adds it to the scene and places it at rec.position; if it throws / fails / returns a non-object:
   * reported once, does not block ready, retried when you leave and come back. Only the position is world's: rec.rot / rec.scale are the build's to apply
   * (rotate the root or a child, in its own units) and update's to follow.
   *   update(rec, obj, dt): called every frame for records that have a model (change the picture from the data, e.g. an opened chest swaps texture).
   *   dispose(rec, obj): called on teardown (record first, model second); if omitted, engine.remove(obj).
   *   show(rec) → false: this record has no model right now (picked up, waiting to respawn); re-evaluated when world.set changes records of this kind.
   * radius: meters, or a function (for distances that change, like terrain view distance); defaults to world.radius. Registering the same kind again: old
   * models are torn down with the old dispose and rebuilt with the new one.
   * positionFrom: 'record' (default, the model follows the record every frame) or 'view' (the model moves itself, e.g. driven by a character mover; model
   * position is copied back to the record at the end of each fixed step, and a write to the record moves the model and a rigid body on it).
   * @example engine.world.present('chest', { build: rec => new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial()), dispose: (rec, obj) => engine.remove(obj), show: rec
   * => !rec.looted })
   * @param {string} kind
   * @param {{ build: (rec: WorldRecord) => any, update?: (rec: WorldRecord, obj: any, dt: number) => void, dispose?: (rec: WorldRecord, obj: any) => void,
   * show?: (rec: WorldRecord) => boolean, radius?: number | (() => number), positionFrom?: 'record' | 'view' }} opts
   * @returns {{ remove(): void }}
   */
  present(kind, opts) { return this._v.present(kind, opts); }
  /**
   * The current model of this record (only exists nearby; null if not built yet or far away)
   * @param {string} id
   * @returns {any}
   */
  view(id) { return this._v.map.get(id)?.obj ?? null; }
  /**
   * @internal Tear down this record's model now and build it again on the next refresh (a content template stage that names another model).
   * The record is untouched; safe to call from a present update (the views loop tolerates the entry going away).
   */
  rebuild(id) { this._v.unview(id); this._v.dirty = true; }
  /**
   * All models that should exist near the stream sources are built (async ones too; failed builds do not count as pending). The loading screen waits for it; to
   * wait yourself, await world.whenReady @type {boolean}
   */
  get ready() { return this._v.ready; }
  /** Promise that resolves when ready becomes true @type {Promise<void>} */
  get whenReady() { return this._v.whenReady; }
  /**
   * Build / tear down models for the stream sources right now (normally automatic every frame, with a per-frame limit). Use it right after add when you need
   * the model: sync builds are available via view(id) after the call, for async ones also await world.whenReady
   * @example engine.world.add({ id: 'gate', kind: 'gate', position: p }); engine.world.refresh(); engine.world.view('gate')
   * @returns {void}
   */
  refresh() { this._v.refresh(); }
  /**
   * Register how a kind of thing changes (gameplay logic goes here, runs in the fixed step); near / far is split by distance from world.anchor (default: the
   * player):
   * near(rec, dt, obj): within radius, once per fixed step (obj is the model, may be null if not built yet; gameplay must not depend on it);
   * far(rec, dt): farther away, once every farEvery seconds; dt is the seconds accumulated since the last simulation (can catch up a long time at once); on the
   * far → near step, far runs first to pay back the owed time.
   * With only far (crops), near also advances via far; with only near, far records are not simulated and owed time is not made up.
   * Both dt are accumulated real (fixed-step) seconds (not multiplied by clock.rate). For things measured in game clock (grows over days) store engine.clock.now
   * and compare. channel: a time channel name (or rec => name) the kind lives on; then both dt are the channel time the record lived through (its
   * engine.time.local stack too), whatever the speed when far settles, so bullet time on 'enemies' slows near and far records alike (NPCs use it with their own channel).
   * radius defaults to the present radius ('view' widened by 1.25), or world.radius without present; may also be a function.
   * fullRadius + nearEvery (tiers, for crowds): records within fullRadius m (number or function) run near every step; the rest of the near zone runs near
   * once every nearEvery seconds, dt being the seconds since its last turn (deterministic: turns go by hashed id and step count, saved).
   * worker: true (experimental) runs far in engine.threads workers (batched per step, written back 4 steps later, bit-identical with threads off). far must
   * then be self-contained:
   * it is recompiled from source and sees only (rec, dt) and globals like Math; an outside variable throws naming it (threads on or off alike).
   * @example engine.world.simulate('zombie', { near: (rec, dt) => chase(rec, dt), far: (rec, dt) => wander(rec, dt), farEvery: 2 })
   * @example engine.world.simulate('slime', { near: chase, far: wander, channel: 'enemies' })   // engine.mod('time.enemies', { mul: 0.35, for: 2 }) slows them
   * @example engine.world.simulate('crop', { far: (rec, dt) => { rec.growth = Math.min(1, rec.growth + dt / 600); }, worker: true })
   * @param {string} kind
   * @param {{ near?: (rec: WorldRecord, dt: number, obj: any) => void, far?: (rec: WorldRecord, dt: number) => void, farEvery?: number, radius?: number | (()
   * => number), fullRadius?: number | (() => number), nearEvery?: number, worker?: boolean, channel?: string | ((rec: WorldRecord) => string) }} opts
   * @returns {{ remove(): void }}
   */
  simulate(kind, opts) { return this._s.simulate(kind, opts); }
  /**
   * Stop running simulate() handlers on this machine until remove(): a multiplayer client lets the host simulate and only receives the records.
   * Public so net() needs no world internals.
   * @returns {{ remove(): void }}
   * @experimental
   */
  pauseSimulation() { const s = this._s; s.fixed = () => {}; return { remove: () => { delete s.fixed; for (const e of s.ents.values()) e.ch = e.mark = undefined; } }; }   // channels kept moving: no stretch of the pause is owed
  /** Number of fixed steps simulated @experimental */ get steps() { return this._s.n; }
}

/**
 * One world record: id, kind and position are fixed fields, the rest are yours (plain values only)
 * @typedef {{ id: string, kind: string, position: { x: number, y: number, z: number }, zone?: string, [field: string]: any }} WorldRecord
 */
mixInternals(World);
