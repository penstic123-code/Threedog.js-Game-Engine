// NPC: what it does is decided by a behavior (default schedule: go to different places by time of day; also wander, or register your own);
// avoids water, steep slopes, trees and houses (pathfinding via engine.characters.findPath); stops and turns to face the player when talking.
//
// const fisher = engine.npcs.add({
//   id: 'fisher', name: '老渔夫', colors: { body: 0x4f6d8f },
//   schedule: [ { at: '06:00', position: { x: 10, z: 20 } },   // go to the river at 6 am (at can also be a 0–1 time of day); a y in position picks the floor
//               { at: '13:00', position: { x: 40, z: -5 } } ], // back home at noon
//   interact: { op: 'npc.talk' },                        // the interact key nearby runs this op (npc.talk = dialogue, script defaults to the NPC id)
// });
//   interact: { label: 'Trade', op: 'shop.open', args: { shelf: 'fish' } }   // any op: open a shop, hand in, recruit; the op gets { npc: id, ...args }
// Why interact is an op and not a dialogue id: talking is one of many things an NPC offers (trade, recruit, heal, start a match); an op keeps the
// record plain (saved), runs the same from the key, the dev bridge and tests, and refuses with a reason through its can.
//
// Facts and presentation are separate: an NPC's fact is a record in engine.world (kind 'npc', stable id: the given id, else the name),
// the model (Character: mesh + mover + animation) is just a presentation built when near: torn down when far, rebuilt when near;
// changing level only tears down models (data carries zone, so it is rebuilt on return), saves follow world.
// The NPC returned by npcs.add is a handle that finds the data / current model by id; it holds no model, so it stays usable after the model is torn down.
// Who owns position: with a model, the mover moves the model and the data follows (positionFrom: 'view', world copies it back at the end of each fixed step);
// without a model, simulation edits the data directly; building a model reads from the data (npcView.js builds and tears down the model).
// Simulation: world.simulate('npc') dispatches by rec.behavior to registered behaviors { near, far } (built-ins in behaviors.js, schedule details in npcSim.js):
// near runs once per fixed step (pathfinding + mover + mutual avoidance npcAvoid.js), far simulates on data (schedule walks in a straight line).
// Near / far is by distance to the focus; far -> near first catches up owed time (world handles it).
//
// One NPC record (all plain values, inspectable via engine.world.get(id)):
// name, behavior (behavior name), mind (behavior params and memory, plain values the behavior reads/writes), schedule [{ at: 0-1, x, y?, z }] (y only when the stop gave one),
// interact ({ label (when text), op, args, radius } or null), pathStep, repath, arriveDistance, speed,
// look (look and feel params: colors, runSpeed, channel...), zone (which level it belongs to; null = everywhere),
// npcs.add({ channel: 'enemies' }): its time channel (default 'world'); near and far both follow it, so bullet time slows it anywhere.
// state (animation state), busy (in dialogue), nav { stop (current stop index), path (remaining waypoints), repath (re-path countdown), link (the crossing under way, or none) },
// motion (motion state from Character.saveMotion)
// model given as an asset name ('villager', or ['villager', ...args]) is plain and goes into look (saved); a model object, animation, clips, a function-form interact label and
// any other option that is not a plain value (states: fn, water: fn, fall: { belowY: fn }, a Vector3 faceTarget) stay in memory only (by id);
// game code supplies them again via add after loading.
import { keepTable } from '../../core/base/sections.js';
import * as THREE from 'three';
import { CHARACTER_KEYS } from './Character.js';
import { buildNpcView, unbuildNpcView, defineTalk } from './npcView.js';
import { warnOnce, fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { NpcAvoid } from './npcAvoid.js';
import { parseClock } from '../../core/time/dayTime.js';
import { xzOf, yOf } from '../../core/base/math.js';
import { placeAtHeight } from './movers/support.js';
import { stopIndex, timeOfDay, npcChannel, crossLink } from './npcSim.js';
import { leaveLink } from './moveHelpers.js';
import { Behaviors } from './behaviors.js';
import { codedError } from '../../core/base/errorHints.js';
import { isModelName } from '../../core/base/util.js';
import { passesOf } from '../collision/grid.js';

const STRINGS = {
  noInteract: 'NPC "{name}" has interact set, but the interactions() module is not installed: nothing can use it',
  badInteract: 'npcs.add(): interact is { op: \'npc.talk\' } or { label, op, args, radius } (op: the op name the interact key runs); got {got}',
  noWorld: 'NPCs need the world() module (facts live in engine.world): engine.use(world(), …, characters()); openWorld() already installs it. '
    + 'If you do not want NPCs, use characters({ npcs: false })',
  notNpc: 'npcs.add(): id "{id}" is already used by a "{kind}" in world; give this NPC a different id',
  sameName: 'npcs.add(): an NPC named "{name}" already exists (without id the name is the id, so the two would merge). '
    + 'Give each different NPC its own id, e.g. npcs.add({ id: "{name}_2", name: "{name}", … }); to update an existing NPC, add again with the same id',
};
const KIND = 'npc';
const TIER_PARAMS = {
  fullRadius: { type: 'number', min: 0, desc: 'NPCs within this many meters of the focus walk every fixed step' },
  nearEvery: { type: 'number', min: 0, desc: 'seconds between turns of the near NPCs farther out (they get the accumulated dt)' },
};
// Params that stay out of saves even when plain: kept in memory only, used when building the model
const RUNTIME_KEYS = ['model', 'animation', 'clips'];
const NPC_KEYS = [...CHARACTER_KEYS, 'id', 'initial', 'zone', 'name', 'schedule', 'interact', 'pathStep', 'repath', 'arriveDistance',
  'position', 'behavior', 'mind'];

/** NPC handle: finds the data and current model by id. Stays usable after the model is torn down or the data is replaced by loading (does not cache the data object) */
export class NPC {
  /** @param {NPCManager} mgr @param {string} id */
  constructor(mgr, id) {
    this.id = id;
    /** @internal */ this._m = mgr;
    /** @internal */ this._p = new THREE.Vector3();
  }
  /** The record in world (plain object; undefined after removal). Change fields with engine.world.set(npc.id, {...}) */
  get data() { return this._m.world.get(this.id); }
  get name() { return this.data?.name; }
  get schedule() { return this.data?.schedule ?? []; }
  /** What the interact key does near it: { label, op, args, radius }, null when nothing */
  get interact() { return this.data?.interact ?? null; }
  /** Current behavior name */
  get behavior() { return this.data?.behavior; }
  /**
   * Switch behavior (stored in data, restored by saves). mind is the new behavior's params / memory (plain values); omitted = cleared.
   * @example npc.setBehavior('wander', { radius: 12 });   // in 12 m around the current position; setBehavior('schedule') returns to the schedule
   * @param {string} name registered behavior name @param {object} [mind]
   */
  setBehavior(name, mind = {}) {
    this._m._b.check(name);
    const rec = this.data; if (!rec) return this;
    // the path belonged to the old behavior: cleared in the same world.set, so world:change carries it (no silent edit of the record)
    this._m.world.set(this.id, { behavior: name, mind, nav: { ...rec.nav, path: null, repath: 0 } });
    return this;
  }
  get state() { return this.data?.state ?? 'idle'; }
  get busy() { return !!this.data?.busy; }
  /** Current character model (Character): only exists when near; null when far, in another level or not built yet */
  get character() { return this._m.character(this.id); }
  /** three.js root of the current model (= character.root); null without a model */
  get root() { return this.character?.root ?? null; }
  get object() { return this.root; }
  /** Position: with a model it is the model's position (read-only, use placeAt to move); without a model a copy of the data position */
  get position() {
    const ch = this.character; if (ch) return ch.root.position;
    const r = this.data; if (r) this._p.set(r.position.x, r.position.y, r.position.z);
    return this._p;
  }
  /** The stop it should go to now ({ at, x, z }); null without a schedule */
  currentStop() { const s = this.schedule, i = stopIndex(s, timeOfDay(this._m.engine)); return i == null ? null : s[i]; }
  /** Teleport onto the ground at a position (the mover handles it with a model, else edits data), re-paths */
  placeAt(position) {
    const e = this._m.engine, W = this._m.world, rec = this.data; if (!rec) return this;
    const [x, z] = xzOf(position), ch = this.character;
    this._m._claim(rec); e.control.endTasks(this.id, 'placed');
    if (ch) { if (ch.vehicle) ch.exit({ force: true }); ch._place(position); }
    if (rec.vehicle != null) e.ops.allow(() => W.set(this.id, { vehicle: null, seat: null }));   // its record waited for a vehicle not built yet: the game put it elsewhere
    W.move(this.id, { x, y: ch ? ch.root.position.y : placeAtHeight(e, `npc.placeAt() (${this.id})`, x, z, yOf(position), rec.look?.stepHeight ?? e.movement.stepHeight, rec.position.y).y, z });
    return this;
  }
  /** Face a position (only turns with a model) */
  face(position) { const ch = this.character; if (ch) { ch.face(position); if (this.data?.motion) this.data.motion.facing = ch.facing; } return this; }
  /** Remove this NPC (data and model together) */
  remove() { return this._m.remove(this); }
}

export class NPCManager {
  /** @internal Every option add() reads: content npcs (modules/content/loader.js) are checked against the same table, without importing this module */
  get optionKeys() { return NPC_KEYS; }
  /** @param {any} engine @param {any} ctx the characters module's ctx @param {Map<string, { character: any }>} players the module's players, who NPCs give way to */
  constructor(engine, ctx, players) {
    const { track } = ctx;
    this.engine = engine;
    /** @internal the module's ctx: setup() registers npc.talk when the world is there */ this._ctx = ctx;
    /** @internal */ this._handles = new Map();   // id -> NPC handle (just a cache, can be rebuilt any time)
    /** @internal */ this._runtime = new Map();   // id -> non-saveable params (model, animation, clips, any non-plain option, function interact label)
    /** @internal */ this._views = new WeakMap(); // model root -> { ch, use }
    /** @internal */ this._ready = false;
    /** Near NPCs avoid each other (on by default): avoid.set(false) turns it off, see npcAvoid.js */
    this.avoid = new NpcAvoid(engine, track, players);
    /** @internal */ this._b = new Behaviors();   // behavior name -> { near, far } (code, not saved)
    /** @internal */ this._tiers = null;   // { fullRadius, nearEvery } from tiers(), null = every near NPC every step
    /** @internal */ this._byName = new Set();  // NPCs added this run without id, using the name as id (two with one name would be one record)
    // on the event, not in remove(): world.remove(id) and thing.remove take NPCs too, and a later add of that id must not inherit the old model or trip the same-name check
    track(engine.events.on('world:remove', ({ id }) => { this._runtime.delete(id); this._handles.delete(id); this._byName.delete(id); }));
    // a load or new game is a new run, and it fires no world:remove: setup code adding the same names again is not a clash
    track(engine.events.on('world:load', () => this._byName.clear()));
  }
  get world() { const W = this.engine.world; if (!W) throw codedError('module-needs', STRINGS.noWorld); return W; }

  /** Register the NPC model and simulation with world (called in characters init; add calls it first if npcs.add comes earlier)@internal */
  setup() {
    if (this._ready) return;
    const e = this.engine, W = this.world;
    this._ready = true;
    this._ctx.track(W.present(KIND, {
      positionFrom: 'view',   // with a model the mover decides; world copies the model position back to data at the end of each fixed step
      build: rec => buildNpcView(this, rec),
      update: (rec, obj, dt) => {
        const v = this._views.get(obj);
        if (v && rec.interact && v.useFrom !== e.interactions) W.rebuild(rec.id);   // its use lives in the interactions module it was built with: another one starts empty
        else v?.ch.animate(dt);
      },
      dispose: (rec, obj) => unbuildNpcView(this, rec, obj),
    }));
    this._b.addBuiltin(e, W);
    defineTalk(e, this._ctx, this);
    /** @internal what world.simulate gets for NPCs; tiers() adds fullRadius / nearEvery on top and registers again */
    this._sim = {
      // near and far both run on the NPC's time channel (character.channel, else npcs.add({ channel })): world.simulate scales both dt by it
      // (far dt, accumulated over farEvery steps, at the channel's speed now; exact in engine.skip, whose segments end where a speed changes)
      channel: rec => this.character(rec.id)?.channel ?? npcChannel(rec),
      near: (rec, dt) => {
        // self-heal: after loading, dialogue and bubbles are gone (session end drops both without onEnd), so do not stand still forever.
        // A bubble talk (npc.talk channel 'bubble') runs with no main dialogue, so bubbles still showing keep it busy too
        if (rec.busy && !e.dialogue?.active && !e.dialogue?.bubbles?.().length) rec.busy = false;
        this.avoid.stamp(rec);
        const ch = rec.nav.link && this.character(rec.id);
        const ran = this._drive(rec, () => ch ? crossLink(W, rec, ch, dt) : this._b.of(rec)?.near?.(rec, dt, this._handle(rec.id)));
        if (ch && !ran) crossLink(W, rec, ch, dt, true);
      },
      far: (rec, dt) => {
        this._drive(rec, () => this._b.of(rec)?.far?.(rec, dt, this._handle(rec.id)));
        const ch = this.character(rec.id);   // already far but the model is not torn down yet: let the model catch up with the data. A rider stays with its seat, a ragdoll with its body: this is no write, and placing would end the ride or lift the body
        if (ch && !ch.bodyHeld) { ch._place(rec.position); ch.loadMotion(rec.motion); }
      },
    };
    this._ctx.track({ remove: () => this._simHandle.remove() });   // one tracked entry however often tiers() registers again
    this._register();
  }
  /**
   * @internal Run an NPC's behavior as the base holder of its control slot (core/ops/control.js, owner 'npcs'): only while nothing above holds it.
   * A walkTo, a quest script or a cutscene on the NPC pauses its schedule / wander (near and far) and the behavior carries on when they end;
   * the behavior's own character.move() calls pass the bypass check because they run inside this. A character another machine drives (net)
   * is never taken: its behavior does not run here. Returns whether fn ran.
   */
  _drive(rec, fn) {
    return this._claim(rec) && this.engine.control.runAs(rec.id, 'npcs', fn);
  }
  /** @internal The NPC's own hold on its slot, taken when first needed. Its path is the task on it: a placement drops it, the other endings leave it to the schedule. false: another base or net holder drives it */
  _claim(rec) {
    const C = this.engine.control;
    if (C.has(rec.id, 'npcs')) return true;
    const top = C.of(rec.id)?.layer;
    if (top === 'net' || top === 'base') return false;
    C.take(rec.id, { owner: 'npcs', layer: 'base', task: why => { if (why === 'placed') this._dropPath(rec.id); } });
    return true;
  }
  /** @internal A placement: the path, the answer still on its way (it starts from where it stood) and a crossing all belong to the old spot */
  _dropPath(id) {
    const rec = this.world.get(id), ch = this.character(id);
    if (!rec) return;
    if (ch) { ch._pathReq?.remove(); ch._pathReq = null; }
    rec.nav.path = null; rec.nav.repath = 0;
    if (rec.nav.link) { leaveLink(this.engine, id, ch, rec.nav.link); rec.nav.link = null; }
  }
  /** @internal (re)register NPC simulation with world: world.simulate replaces the earlier registration of the same kind */
  _register() { this._simHandle = this.world.simulate(KIND, this._tiers ? { ...this._sim, ...this._tiers } : this._sim); }   // released: the entry setup() tracks

  /**
   * Near tiers for large crowds (off by default: every near NPC walks every fixed step). With tiers, NPCs within fullRadius m of the focus walk every step;
   * the rest of the near zone takes a turn once every nearEvery seconds with the seconds since its last turn (world.simulate's fullRadius / nearEvery,
   * deterministic and save-safe). Why off by default: a tiered NPC on screen moves in visible jumps and collides with a longer step; that trade is the
   * game's to make for a crowd of hundreds, not the engine's. Also characters({ npcTiers }) at install; tiers(null) turns them off.
   * @param {{ fullRadius: number, nearEvery: number } | null} opts
   */
  tiers(opts) {
    this._tiers = opts ? readParams('npcs.tiers', TIER_PARAMS, opts) : null;
    if (this._ready) this._register();
    return this;
  }

  /**
   * Register an NPC behavior (what it does); data selects it via behavior: npcs.add({ behavior: name }) or npc.setBehavior(name).
   * Built-in 'schedule' (default), 'wander' (mind: { radius, pause, home }).
   * near(rec, dt, npc): once per fixed step when near (npc.character is the model, null if not built);
   * far(rec, dt): simulate on data when far, dt is accumulated seconds (can be large), far -> near catches up owed time; no far = does not move when far.
   * Keep state in rec.mind (plain values, saved); move via world.move(rec.id, {x, y, z}), with a model use npc.character.move(dx, dz, false, dt).
   * @example // chase the player: stop within 2 m of the player
   * engine.npcs.behavior('chase', { near(rec, dt, npc) {
   *   const p = npc.position, t = engine.player.position, dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz) || 1;
   *   npc.character?.move(d > 2 ? dx / d : 0, d > 2 ? dz / d : 0, false, dt);
   *   engine.world.move(rec.id, npc.position);
   * } });
   * @param {string} name @param {{ near?: (rec: any, dt: number, npc: NPC) => void, far?: (rec: any, dt: number) => void }} impl
   */
  behavior(name, impl) {
    readParams(`npcs.behavior('${name}')`, keysSchema(['near', 'far']), impl);
    this._b.set(name, impl);
    return this;
  }
  /** @internal A failed content load puts what add kept beside the records back (core/base/sections.js undo): the function that does it @returns {() => void} */
  undoPoint() { return keepTable(this._runtime); }
  /**
   * Add an NPC, returns a handle. Position: opts.position (Vector3 / object / [x, y, z] / { x, z }), defaults to the schedule's current stop.
   * For behavior (default 'schedule') and mind see behavior().
   * id is the stable identity (saves, quest targets, npcs.get all use it), defaults to name (two NPCs with the same name and no id throw).
   * Adding the same id again updates the definition (schedule, dialogue...) and keeps position and state.
   * initial: true = NPC authored in content (everything content adds): saves record only changes, removed ones do not reappear after loading.
   */
  add(opts) {
    readParams('npcs.add()', keysSchema(NPC_KEYS), opts);
    for (const s of opts.schedule || []) readParams('npcs.add() schedule', keysSchema(['at', 'position']), s);
    this.setup();
    const e = this.engine, W = this.world;
    const { id: given, name = 'NPC', schedule = [], interact: io = null, pathStep = 2, repath = 2, arriveDistance = 1.2,
      position, zone = null, speed = 2.6, initial = false, behavior = 'schedule', mind = {}, ...rest } = opts;
    if (io !== null && !(io && typeof io === 'object' && typeof io.op === 'string')) throw codedError('character-option', fmt(STRINGS.badInteract, { got: JSON.stringify(io) }), TypeError);
    if (io) readParams('npcs.add() interact', keysSchema(['label', 'op', 'args', 'radius']), io);
    passesOf('npcs.add() passes', rest.passes);   // here, not when its body is first built near the player
    const id = given ?? name, look = {}, runtime = { ...this._runtime.get(id) };   // a re-add keeps what it does not pass, as the record does
    if (given == null && this._byName.has(id)) throw codedError('world-id', fmt(STRINGS.sameName, { name }));
    // an asset name is data (saved); a model object, animation, clips and whatever is not plain stay in memory
    for (const [k, v] of Object.entries(rest)) {
      if ((RUNTIME_KEYS.includes(k) && !(k === 'model' && isModelName(v))) || !W.isPlain(v)) runtime[k] = v;
      else { look[k] = v; delete runtime[k]; }
    }
    if (io) { if (typeof io.label === 'function') runtime.interactLabel = io.label; else delete runtime.interactLabel; }
    this._b.check(behavior);
    const old = W.get(id);
    if (old && old.kind !== KIND) throw codedError('world-id', fmt(STRINGS.notNpc, { id, kind: old.kind }));
    const hpd = e.calendar?.hoursPerDay ?? 24;
    // at may be 'HH:MM' or 0-1
    const sched = schedule.map(s => { const [x, z] = xzOf(s.position), y = yOf(s.position); return { at: parseClock(s.at, hpd), x, ...(y !== undefined && { y }), z }; }).sort((a, b) => a.at - b.at);
    if (io && !e.interactions) warnOnce(fmt(STRINGS.noInteract, { name }));
    // the record keeps plain values only: a function label stays in runtime (above), the record gets null and the view reads runtime first
    const interact = io && { label: typeof io.label === 'string' ? io.label : null, op: io.op, args: io.args ?? {}, radius: io.radius ?? 3.2 };
    const def = { name, behavior, mind, schedule: sched, interact, pathStep, repath, arriveDistance, speed, look, zone };
    // the name and the runtime entry (the presenters read it as the record arrives) are taken only now, and given back if the world write throws (checkPlain on a mind with a function, a
    // dev id clash): a failed add leaves nothing behind, so a retry is not 'sameName' and a non-NPC id has no entry
    const prev = this._runtime.get(id);
    if (given == null) this._byName.add(id);
    this._runtime.set(id, runtime);
    try {
      if (old) {
        // re-add overrides only fields passed explicitly (unpassed zone, schedule etc. keep their values)
        const patch = {};
        const keys = ['name', 'interact', 'pathStep', 'repath', 'arriveDistance', 'speed', 'zone', 'schedule'];
        for (const k of keys) if (opts[k] !== undefined) patch[k] = k === 'schedule' ? sched : def[k];
        // a new behavior starts a new memory, as setBehavior does; naming the one it has is setup code running again, and the memory is state
        const changes = opts.behavior !== undefined && behavior !== old.behavior;
        if (changes) { patch.behavior = behavior; patch.nav = { ...old.nav, path: null, repath: 0 }; }
        if (changes || opts.mind !== undefined) patch.mind = mind;
        if (Object.keys(look).length) patch.look = { ...old.look, ...look };
        W.set(id, patch);
      } else {
        const i = stopIndex(sched, timeOfDay(e)), at = position ?? (i != null ? sched[i] : { x: 0, z: 0 }), [x, z] = xzOf(at);
        const nav = { stop: null, path: null, repath: 0 };
        W.add({ id, kind: KIND, position: [x, placeAtHeight(e, `npcs.${id}`, x, z, yOf(at), 0, 0).y, z], ...def, state: 'idle', busy: false, nav, motion: null }, { initial });
      }
    } catch (err) {
      if (prev) this._runtime.set(id, prev); else this._runtime.delete(id);
      if (given == null) this._byName.delete(id);
      throw err;
    }
    return this._handle(id);
  }
  /** Remove an NPC (pass handle, id or name): deletes data and tears down the model, dialogue interaction and crowd agent. Returns false if not found */
  remove(npc) {
    const id = typeof npc === 'string' ? this.get(npc)?.id : npc?.id;
    if (id == null || this.world.get(id)?.kind !== KIND) return false;
    this.world.remove(id);
    return true;
  }
  /** Find by id or name (id first) */
  get(idOrName) {
    const W = this.engine.world; if (!W) return undefined;
    if (W.get(idOrName)?.kind === KIND) return this._handle(idOrName);
    for (const r of W.records.values()) if (r.kind === KIND && r.name === idOrName) return this._handle(r.id);
    return undefined;
  }
  /** All NPCs (kind 'npc' records in world, including far ones and those in other levels) */
  list() {
    const W = this.engine.world, out = [];
    if (W) for (const r of W.records.values()) if (r.kind === KIND) out.push(this._handle(r.id));
    return out;
  }
  /** Current character model (Character) of an NPC; null if none */
  character(id) { const o = this.engine.world?.view(id); return (o && this._views.get(o)?.ch) || null; }

  /** @internal */
  _handle(id) { let h = this._handles.get(id); if (!h) this._handles.set(id, h = new NPC(this, id)); return h; }
}
