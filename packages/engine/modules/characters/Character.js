// Character: a body from a model asset (procedural rig from an asset pack, or a glTF model; gray capsule without one) + procedural animation (walk, run, swim, idle breathing)
// + movement control (ground snap, collision, slope limit, swimming).
// Used by both player and NPCs; a skeletal glTF body takes model + clips (or an animation state machine config), control logic stays the same.
// The mover owns position: only the mover (movers/) changes a character's position inside move(); other systems (pathfinding, triggers, vehicles, loading)
// request movement via placeAt (teleport), move (direction), enter / exit (vehicles).
// Characters backed by a world record (the player, recordId = 'player') write position and motion state back to the record after every move / placeAt / enter / exit;
// the record is saved, world splits near/far by it, the model is just its picture.
// Radius and step height default to engine.movement (the single source of "can walk through" parameters); passing radius / stepHeight overrides it for this character only.
// How to walk is decided by the mover (movers/: 'simple' default, 'rapier' character controller); feel parameters are identical for both.
// The procedural body (capsule, rig read from a model asset, limb swing) is in proceduralRig.js; loading a body by asset name in assetModel.js.
import * as THREE from 'three';
import { xzOf, yOf } from '../../core/base/math.js';
import { warnOnce, warnMissing, DEV, fmt } from '../../core/base/validate.js';
import { reportError } from '../../core/base/errors.js';
import { simpleMover } from './movers/simple.js';
import { rapierMover } from './movers/rapier.js';
import { manualMover } from './movers/manual.js';
import { moveStacks, stat, jumpOf, WATER_MODES } from './movers/common.js';
import { stateOf, detach, registry, placeAtHeight } from './movers/support.js';
import { loadAssetModel, buildNow } from './assetModel.js';
import { NO_CHARACTER, capsule, useRig, animateRig, rigFromObject, tintParts } from './proceduralRig.js';
import { walkTo } from './walkTo.js';
import { seatsOf } from './seat.js';
import { useModel } from './useModel.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { isModelName } from '../../core/base/util.js';
import { passesOf } from '../collision/grid.js';

// A record whose jump / safe is the wrong kind of thing (a damaged or hand-edited save) is repaired so the game keeps running, but said out loud once: bad data is reported, not quietly fixed
function badField(v, name, want) { if (v != null) warnOnce(`[threedog] character motion: the world record's '${name}' is ${JSON.stringify(v)} but should be ${want}; it was replaced with a fresh one. Check the save or the code that writes the record`); return undefined; }
const STRINGS = { noClip: 'character has no skeletal animation; playAction(\'{name}\') skipped (the model needs this action)' };
const BUILT_IN = { simple: simpleMover, rapier: rapierMover, manual: manualMover };

// Options Character understands (shared by player and NPC)
export const CHARACTER_KEYS = ['colors', 'speed', 'runSpeed', 'radius', 'water', 'states', 'swimDepth', 'swimSpeed', 'turnSpeed', 'acceleration', 'gravity',
  'jumpSpeed', 'stepHeight', 'airControl', 'coyoteTime', 'canJump', 'maxJumps', 'airJumpSpeed', 'jumpBuffer', 'fall', 'channel', 'model', 'clips', 'animation', 'mover', 'faceMode', 'faceTarget', 'rig', 'id', 'passes'];
const FACE_MODES = ['move', 'camera', 'target', 'manual'];

export class Character {
  /**
   * @param engine
   * @param o  model: the body, one path for all: a model asset name (a procedural builder from an asset pack, or a GLB name), [name, ...args] for a generator, or what
   *                  engine.assets.model() returned; without model and rig a gray capsule (warned once). rig: a ready body (proceduralRig.js format)
   *           colors: { body, skin, legs, hair } per-character part colors (meshes marked userData.part; a capsule takes colors.body)
   *           speed walk speed, runSpeed run speed (m/s), radius collision radius
   *           passes the collider layers it walks through, e.g. ['gate'] (collision.addBox { layer }): its walking, paths and navmesh all follow it; plain, may be rewritten later
   *           water what water deeper than swimDepth does: 'swim' (default, floats, state 'swim') | 'block' (never enters it) | 'wade' (walks the
   *                 bottom) | (character, { depth, x, z }) => one of those (per spot: a swim skill, a boat, depth); character:water fires on each change.
   *                 swimDepth water depth at which it counts as deep, swimSpeed swim speed multiplier
   *           states (character, facts) => state name | null, run after the mover's own state each step: the game's own states (crouch, climb,
   *                  glide, dash, roll) on top of idle / walk / run / jump / fall / swim; facts { base, speed, grounded, swimming, vy, water }; null keeps
   *                  base. The state picks the clip like any other (clips: { crouch: 'Crouch' }); speed changes stay engine.mod('move.speed')
   *           turnSpeed how fast it turns, acceleration how fast it starts/stops
   *           jump and gravity: gravity (negative), jumpSpeed takeoff speed, stepHeight step height it can climb directly, airControl air steering 0-1,
   *                      coyoteTime how long after leaving a ledge a jump is still allowed, canJump, jumpBuffer how long a jump() pressed early
   *                      waits for the ground (s), maxJumps jumps before landing again (2 = double jump), airJumpSpeed takeoff speed of an air jump
   *                      (default jumpSpeed). These are the base values and belong to the game; modules change them with engine.mod('move.<stat>').
   *           fall: { belowY } a height (or (character) => boolean): below it character:fall fires and the rule 'fall' decides (no rule: nothing happens;
   *                 engine.mod('fall', { owner: 'game', set: 'rescue' }) goes back to safeGround). false (default) = off
   *           channel: the time channel its movement and animation follow when the engine drives it (player 'player', others 'world')
   *           model + clips: optional glTF model and action-name map { idle, walk, run, swim, jump, fall, drive } (shorthand for animation)
   *           animation: animation state machine config (see core/assets/Animator.js), state names are character state names;
   *                      without walk/run, move (blend tree, param speed) is used
   *           mover: (character, engine) => ({ name, move(x, z, run, dt, y) }) your own (flight, wall running: mover.contract.js, recipe 57) |
   *                  'simple' (default) | 'rapier' (Rapier character controller, needs the rigid module) | 'manual' (the game writes the position;
   *                  move() only updates grounded / support / safeGround / fall, movers/manual.js); assign at any time: player.mover = 'manual'
   *           faceMode which way it turns each move: 'move' (default, toward its velocity) | 'camera' (along cameraRig.forward(), over-the-shoulder aiming)
   *                    | 'target' (toward faceTarget: Object3D / Vector3 / { x, z }, lock-on strafing) | 'manual' (only face() turns it);
   *                    both are plain properties, change them at any time
   *           a file model name shows the capsule until it loads, then is swapped in (assetModel.js)
   */
  constructor(engine, { colors = {}, speed = 4.5, runSpeed = 7, radius = engine.movement.radius, water = 'swim', states = null, swimDepth = 1.0, swimSpeed = 0.45,
    turnSpeed = 10, acceleration = 12, gravity = -24, jumpSpeed = 8, stepHeight = engine.movement.stepHeight, airControl = 0.35, coyoteTime = 0.12,
    canJump = true, maxJumps = 1, airJumpSpeed = null, jumpBuffer = 0.12, fall = false, channel = 'world',
    model = null, clips = null, animation = null, mover = 'simple', faceMode = 'move', faceTarget = null, rig = null, id = null, passes } = {}) {
    /** @internal the id option, else the generated one (a character without a world record); the getter id below is the one public form */ this._ownId = id;
    /** @internal true for a world NPC's model (npcView.js): disposing it keeps the NPC's control slot */ this.npcModel = false;
    this.engine = engine;
    if (typeof water !== 'function' && !WATER_MODES.includes(water)) throw codedError('character-option', `character option water: 'swim' | 'block' | 'wade' or (character, { depth }) => one of them; got ${JSON.stringify(water)}`, TypeError);
    if (states != null && typeof states !== 'function') throw codedError('character-option', 'character option states: (character, facts) => state name | null', TypeError);
    /** What deep water does ('swim' | 'block' | 'wade' | function); states: the game's state hook. Both plain, change them at any time */
    this.water = water; this.states = states;
    /** Collider layers this body goes through (character option passes); undefined: stopped by every collider */ this.passes = passesOf('character option passes', passes);
    Object.assign(this, { speed, runSpeed, radius, swimDepth, swimSpeedFactor: swimSpeed, turnSpeed, acceleration, gravity, jumpSpeed, stepHeight,
      airControl, coyoteTime, canJump, maxJumps, airJumpSpeed, jumpBuffer, channel });
    if (fall && !(typeof fall.belowY === 'number' || typeof fall.belowY === 'function')) throw codedError('character-option', `character option fall: { belowY: -20 } (a height, or (character) => boolean), or false; got ${JSON.stringify(fall)}`, TypeError);
    this.fall = fall || false;
    /** Last spot it stood still on safe ground (Vector3), where a fall returns it; null until it first stands. Saved with the motion */
    this.safeGround = null;
    moveStacks(engine);
    if (!FACE_MODES.includes(faceMode)) warnMissing('faceMode', faceMode, FACE_MODES);
    this.faceMode = faceMode; this.faceTarget = faceTarget;
    // velocity (x / z, m/s) and vy are plain and writable: a write is an impulse the mover integrates from next step (velocity is then steered back
    // toward the input, vy falls with gravity). Nobody owns them and nothing auto-yields: a knockback that should last is push(), a jump pad is
    // launch(), full control is mover 'manual'.
    this.vy = 0; this.grounded = true; this._push = 0;
    this.limp = null; this.disposed = false;   // limp: the ragdoll that has the body (rigid/ragdoll.js)
    this.root = new THREE.Group();
    this._pose = engine._poses.add(this.root, null, null, () => `character '${this.id}'`);
    this.velocity = new THREE.Vector2();
    this.facing = 0; this.phase = 0; this.moveAmount = 0;
    this.swimming = false;
    /** Action state the animation plays: 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'swim' | 'drive' | 'ragdoll', or what the states option returned. Read it freely;
     *  the engine mover recomputes it every step, so a direct write warns once (states option for own states, character.playAction(name) for one-shot
     *  actions, mover 'manual' to own it). stateMark: the engine's last write @type {string} */
    this.state = this.stateMark = 'idle';
    /** The vehicle it sits in (null on foot) and its seat there (0 = driver, null on foot) */
    /** @internal the seat relation (seat.js), null on foot */ this._ride = null; this.anim = null;
    /** @internal set by addPlayer: tears the player's registry entry down and then this character (player.js), so dispose() reaches it from either side */ this._release = null;
    /** false while a model named by asset loads (placeholder shows); await whenReady */
    this.ready = true;
    /**
     * id of the world record ('player' for the player); once set, position, facing and motion state are written back to it.
     * A write to that record's position (world.move, world.set, thing.set) is a placeAt
     * @type {string | null}
     */
    this.recordId = null;
    /** @internal where a write to its record's position goes (world.move): placeAt; an NPC's model goes through npc.placeAt, which drops its path too */ this.placeRecord = p => this.placeAt(p);
    /** @internal where a turn written to its record goes; an NPC's facing is saved in its motion */ this._turnRecord = yaw => { this.face(yaw); this._store(); };
    /** @internal each mover built once, kept while switching (rapier keeps its native body), by name or by the game's function */ this._movers = new Map([['simple', simpleMover(this)]]);
    /** @internal the rule character.mover: an entry there wins over this character's own mover and ends with its owner, so a ladder puts back what was there */ this._moverRule = engine.stacks.rule('character.mover', null);
    this.mover = mover;
    this._colors = colors;
    // one path for every body: an object, a procedural builder built now (joints exist at once), or a file asset loaded behind a capsule
    const now = isModelName(model) ? buildNow(engine, model) : model;
    if (now && !now.then) { this._useModel(now, clips, animation); return; }   // a promise: an async builder, waited on below
    if (!rig && !model) warnOnce(NO_CHARACTER);
    useRig(this, rig || capsule(colors.body, engine));
    if (model) this._whenReady = loadAssetModel(this, model, m => this._useModel(m, clips, animation), now);
  }
  /** A model object with userData.rig is a procedural body (limb swing); anything else animates by its clips */
  _useModel(model, clips, animation) {
    const r = rigFromObject(model);
    if (r) useRig(this, r); else useModel(this, model, clips, animation);
    tintParts(model, this._colors);
  }

  /**
   * Walk to a point along characters.findPath on fixed steps (turn rate, skips passed points, re-plans when stuck). Returns a promise of
   * { status: 'arrived' | 'noPath' | 'stuck' | 'cancelled' } (never rejects) with remove() to cancel; a new walkTo, dispose() or a save load cancels it (not saved). speed m/s, arrive metres, turnRate rad/s
   * @example await guard.walkTo(player.position, { arrive: 1.5 })
   */
  walkTo(target, opts) { return walkTo(this, target, opts); }

  /**
   * The character's id, the one form engine.mod / time.local take for its entries: its world record id ('player' for the player, an NPC's
   * record id), else the id option you gave it (new Character(e, { id: 'knight-1' })), else a fixed generated one.
   * Why one form: a misspelled id silently mods nobody.
   * @example engine.mod('move.speed', { owner: 'haste', id: 'player', mul: 1.2, for: 5 })
   * @readonly @type {string}
   */
  get id() { return this.recordId ?? (this._ownId ??= `character#${++registry(this.engine).n}`); }
  /**
   * A movement stat as the mover uses it now: the base field with every engine.mod('move.<name>') entry applied (speed / runSpeed / gravity /
   * jumpSpeed / canJump (1 or 0)). Read-only; the base is the plain field (player.speed = 6), modifiers go through engine.mod.
   * @param {'speed' | 'runSpeed' | 'gravity' | 'jumpSpeed' | 'canJump'} name
   */
  stat(name) { return stat(this, name); }

  /**
   * Request a jump (call when the jump key is pressed). It waits jumpBuffer seconds for the ground, so pressing slightly before landing counts;
   * on the ground or in coyote time it is the ground jump, otherwise an air jump while maxJumps allows. air: false = only a ground jump.
   * @example addPlayer({ ..., maxJumps: 2 });   // double jump: the same jump key twice
   */
  jump({ air = true } = {}) { const j = jumpOf(this); j.buffer = this.jumpBuffer || 1e-6; j.fresh = true; j.air = air; return this; }
  /** Give back n jumps for this airtime (a pickup, a wall touch) @param {number} [n] */
  addJumps(n = 1) { const j = jumpOf(this); j.used = Math.max(0, j.used - n); return this; }
  /** All jumps back, as if it had landed */
  resetJumps() { jumpOf(this).used = 0; return this; }
  /**
   * Throw it upward at speed m/s (jump pad, spring, geyser): leaves the ground, ends coyote time, counts as having used the ground jump
   * (air jumps stay). Emits character:launch { character, speed, owner }.
   * @example engine.events.on('trigger:enter', ({ id }) => { if (id === 'pad') player.launch(19, { owner: 'pad' }); })
   */
  launch(speed, { owner = 'game' } = {}) {
    const j = jumpOf(this);
    this.vy = speed; this.grounded = false; j.coyote = 0; j.buffer = 0; j.used = Math.max(1, j.used);
    this.engine.events.emit('character:launch', { character: this, speed, owner });
    return this;
  }
  /**
   * Jump state now, read-only: { grounded, coyoteLeft, bufferLeft, jumpsUsed, jumpsLeft, vy }
   * @returns {{ grounded: boolean, coyoteLeft: number, bufferLeft: number, jumpsUsed: number, jumpsLeft: number, vy: number }}
   */
  jumpState() {
    const j = jumpOf(this);
    return { grounded: this.grounded, coyoteLeft: Math.max(0, j.coyote), bufferLeft: Math.max(0, j.buffer), jumpsUsed: j.used,
      jumpsLeft: Math.max(0, this.maxJumps - j.used), vy: this.vy };
  }
  /**
   * What it stands on, read-only (reused object): { kind: 'ground' | 'platform' | 'collider' | 'water' | null, object, id, safe, velocity: { x, y, z } }.
   * platform = a registered support (engine.characters.support), which carries it; velocity is that platform's.
   */
  get support() { return stateOf(this).view; }

  /**
   * Move at a fixed velocity (m/s, world x/z) for `seconds`, ignoring the direction passed to move() and without turning: knockback, dodge-roll displacement, lunges.
   * Gravity, collision and ground snap still apply; move() must still be called every fixed step (the default player control does)
   * @example player.push(-toEnemy.x * 6, -toEnemy.z * 6, 0.15)   // knocked back, still facing the attacker
   */
  push(vx, vz, seconds) { this._pushX = vx; this._pushZ = vz; this._push = seconds; }

  /** Settles (never rejects) once a model named by asset is swapped in or failed; already settled otherwise */
  get whenReady() { return this._whenReady ?? Promise.resolve(); }
  get position() { return this.root.position; }
  /** What it rides now (the vehicle contract object), null on foot */
  get vehicle() { return this._ride?.vehicle ?? null; }
  /** @internal Something other than a holder has the body: a ragdoll (rigid/ragdoll.js) or a seat (seat.js). Nothing may move or place it meanwhile */
  get bodyHeld() { return !!(this.limp || this._ride); }
  /** Its seat in that vehicle (0 = driver), null on foot */
  get seat() { return this._ride?.seat ?? null; }
  // Why write-only accessors: these were plain slots until 0.8. A game still assigning one got no error and no sound, because the plain write just
  // made a property nothing reads. The write stays harmless (no throw), only the silence goes. No getter: the old names still read as undefined.
  /**
   * Place at a position (Vector3 / Object3D / [x, y, z] / { x, z }). With a y it stands on what a character at that height stands on: the floor there, or a
   * registered support within step height above it, so a place under a deck stays under it. With { x, z } it stands on the highest support there, else the ground.
   * A rider gets out first (exit: vehicle:exit fires, the vehicle brakes): the seat would otherwise pull it back on the next step.
   * A ragdoll goes there whole, at rest, and stays limp. A walk ends: the game said where it is, so the old order no longer applies.
   */
  placeAt(position) {
    this.engine.control?.endTasks(this, 'placed');
    if (this.vehicle) this.exit({ force: true });
    else if (this.recordId && this.engine.world?.get(this.recordId)?.vehicle != null) this._writeSeat(null, null);   // its record waited for a vehicle not built yet: the game put it elsewhere
    return this._place(position);
  }
  /** @internal Put it there with no ending of its own: a link crossing, a step out of a vehicle */
  _place(position) {
    const [x, z] = xzOf(position), at = placeAtHeight(this.engine, 'character.placeAt()', x, z, yOf(position), this.stepHeight, this.root.position.y), was = this.root.position;
    this.limp?.shift(x - was.x, at.y - was.y, z - was.z);   // limp, root follows the body: the body goes first, or the next step puts root back on it
    this.root.position.set(x, at.y, z);
    detach(this);
    // ground is a safe spot. A support may be unsafe or moving, which only a step can tell: the next mover step applies the rule in endMove
    if (!at.on) (this.safeGround ??= new THREE.Vector3()).copy(this.root.position);
    this._store(); return this;
  }
  /** @internal Why it could not keep this rot, or null: facing is about Y only, and a seat turns its rider every step. thing.set answers with it, world.set throws it */
  poseProblem({ rot, scale }) {
    const bad = v => v !== undefined && !Number.isFinite(v) && !(Array.isArray(v) && v.length === 3 && v.every(Number.isFinite));
    if (bad(rot) || bad(scale)) return `character '${this.id}': rot and scale on its record are the character's turn and size, a number or [x, y, z]; got ${JSON.stringify({ rot, scale })}`;
    if (rot === undefined) return null;
    if (Array.isArray(rot) && (rot[0] || rot[2])) return `rot ${JSON.stringify(rot)} on character '${this.id}': a character stays upright and turns about Y only, so a tilt about x or z cannot apply. Write a number or [0, yaw, 0]; to lean its picture, turn a child of root`;
    return this.vehicle ? `rot on character '${this.id}': it sits in a vehicle and the seat turns it. Turn the vehicle, or exit() first` : null;
  }
  /** @internal A write to its record's rot / scale (world.set, thing.set): the character owns both, as it owns its position. scale is the picture: radius and height stay */
  takePose(pose) {
    const problem = this.poseProblem(pose), { rot, scale } = pose;
    if (problem) throw codedError('character-option', problem);
    if (rot !== undefined) this._turnRecord(Array.isArray(rot) ? rot[1] : rot);
    if (scale !== undefined) { if (Array.isArray(scale)) this.root.scale.fromArray(scale); else this.root.scale.setScalar(scale); this._scaled = true; }
  }
  /** @internal Built or loaded from its record: scale stays there; rot is a write made while it had no character, taken once. A record without scale takes back one written before */
  _fromRecord(rec) {
    const { rot } = rec, scale = rec.scale ?? (this._scaled ? 1 : undefined);
    delete rec.rot;
    this.takePose({ rot, scale });
  }
  /**
   * How it walks now: the mover object ({ name, move, controller? }). Assign a built-in name or (character, engine) => mover to switch for good: c.mover = 'manual'.
   * For a while, use the rule: engine.mod('character.mover', { owner: 'ladder', id: c.id, set: 'manual' }) and remove the handle after. false in the rule means 'manual'
   */
  get mover() { return this._moverOf(this._moverRule.value(this.id) ?? this._ownMover); }
  set mover(v) { this._moverOf(v); this._ownMover = v; }
  /** @internal the mover for a rule value or an assignment, built the first time */
  _moverOf(v) {
    const key = v === false ? 'manual' : v;
    let m = this._movers.get(key);
    if (m) return m;
    if (typeof key === 'function') {
      m = key(this, this.engine);
      if (typeof m === 'string' || m === false) return this._movers.set(key, this._moverOf(m)).get(key);   // the function chose a built-in, once for this character
      if (typeof m?.move !== 'function') throw codedError('character-option', `the mover function for '${this.id}' must return { name, move(x, z, run, dt, y) } (mover.contract.js) or a built-in name, got ${JSON.stringify(m)}`);
    } else if (BUILT_IN[key]) m = BUILT_IN[key](this, this._movers.get('simple'));
    else throw codedError('character-option', `mover ${JSON.stringify(key)}: use 'simple', 'rapier', 'manual' or your own (character, engine) => ({ name, move(x, z, run, dt, y) }). Recipe 57`);
    this._movers.set(key, m);
    return m;
  }
  _store() { const id = this.recordId; if (id) { const W = this.engine.world; this.saveMotion(W.get(id)); W.move(id, this.root.position); } }
  /** After moving root yourself (a cutscene path, a scripted pose): write position and motion back to the world record, so a save right after has it */
  syncRecord() { this._store(); return this; }

  /**
   * Move along a direction (call once per fixed step). dirX/dirZ is a world-space direction (length 0-1), run toggles running.
   * How it walks is decided by this.mover ('simple' default / 'rapier'); on a seat nothing moves it here (seat.js holds it). dt is used as given (the engine's own
   * drivers pass the character's channel dt); speed comes from the stats (character.stat, engine.mod('move.speed')), the direction's length scales it.
   */
  move(dirX, dirZ, run, dt, dirY = 0) {
    // a held character moves only through its holder (core/ops/control.js): a second driver calling move() in the same step is the bug where keys,
    // a walk and a cutscene all pushed the player and the last one won
    if (DEV) this.engine.control?.checkMove(this);
    if (this.bodyHeld) return;   // release builds skip the check above, so nothing may move it here either
    const m = this.mover;
    if (m !== this._moving) { this._moving?.leave?.(); this._moving = m; }   // once per change: what the last mover left standing in the world must not block this one
    m.move(dirX, dirZ, run, dt, dirY);
    this._store();
  }

  /**
   * Enter a vehicle: rigid.addWheeled's car or any object with the vehicle contract (vehicle.contract.js: seatPosition / exitPosition / speed / drive /
   * driver / object, optional seats / hideDriver), so a game's own boat or mount needs no rigid module. Takes the driver seat when free, else a free
   * passenger seat (vehicle.seats, default 1; this.seat says which, 0 = driver). Stops walking; hidden unless vehicle.hideDriver is false; the camera
   * follows vehicle.object. No-op when every seat is taken
   */
  enter(vehicle) {
    if (this.vehicle || this.limp) return;
    const ride = vehicle.passengers ??= [];
    let seat = 0;
    if (vehicle.driver) {
      const taken = new Set(ride.map(c => c.seat));
      for (seat = 1; seat < (vehicle.seats ?? 1) && taken.has(seat); seat++);
      if (seat >= (vehicle.seats ?? 1)) return;
    }
    this._sit(vehicle, seat);
  }
  /** @internal Why it cannot go back to this seat, or null (it may be there already). Undo of a placement that ended a ride asks this first */
  seatProblem({ vehicle, seat }) {
    if (this.vehicle === vehicle && this.seat === seat) return null;
    if (vehicle.gone || !vehicle.object.parent) return `character '${this.id}': the vehicle it sat in is gone, so it cannot go back to its seat`;
    if (this.vehicle) return `character '${this.id}': it sits in another vehicle now. exit() first`;
    if (this.limp) return `character '${this.id}': it is a ragdoll now. remove() it first`;
    return (seat === 0 ? vehicle.driver : vehicle.passengers.some(c => c.seat === seat)) ? `character '${this.id}': seat ${seat} is taken now` : null;
  }
  /** @internal Back on the seat a placement took it from; seatProblem said it can */
  backInSeat({ vehicle, seat }) {
    if (this.vehicle) return;
    this._sit(vehicle, seat);
  }
  /** @internal Take this seat: enter chose it, or an undo names it */
  _sit(vehicle, seat) {
    const e = this.engine;
    e.control?.endTasks(this, 'seated');
    this._ride = { rider: this, vehicle, id: vehicle.id ?? null, seat, pedal: false };
    const book = seatsOf(e); book.rides.add(this._ride); if (vehicle.id != null) book.vehicles.add(vehicle);
    this.root.position.copy(vehicle.seatPosition(seat));   // the record says the seat at once, not on the next step
    this._writeSeat(this._ride.id, seat);
    if (seat === 0) vehicle.driver = this; else vehicle.passengers.push(this);
    if (e.player === this) this._driveCtx = e.input.push('vehicle', { pass: true });   // driving: brake lives in this context, walking-only keys are shadowed
    if (e.player === this && !e.input.keysOf('brake').length) warnOnce(coded('input-keys', "the player drives without a brake key: no module binds one by itself. engine.input.bind(presets.bindings.brake) (B / gamepad LT) or engine.input.bind('brake', ['KeyX'])"));
    this.root.visible = vehicle.hideDriver === false; this.velocity.set(0, 0); this.vy = 0; this.swimming = false; this.state = this.stateMark = 'drive'; this._store();
    // only when the game asked the camera to follow the player (addPlayer({ cameraFollow }))
    if (e.player === this && this.cameraFollow) e.cameraRig?.follow(vehicle.object, vehicle.camera);
    e.events.emit('vehicle:enter', { character: this, vehicle });
  }
  /** @internal The relation's half in the record, saved with it. A load writes nothing: recordId is null while it places */
  _writeSeat(vehicle, seat) { const id = this.recordId; if (id) this.engine.ops.allow(() => this.engine.world.set(id, { vehicle, seat })); }
  /** @internal The first exit the vehicle offers that a body of this size can stand on, or null. Without collision nothing can say no */
  _exitSpot(v, seat) {
    for (let n = 0; n < 8; n++) {   // bounded: a vehicle with one exit answers the same point for every n
      const p = v.exitPosition(seat, n);
      if (!p) return null;
      if (this.engine.collision?.walkableAt(p.x, p.z, this.radius, p.y, this.passes) ?? true) return p;
    }
    return null;
  }
  /**
   * Exit: step out at the first exit the vehicle offers that is walkable, camera returns to the character. With none it refuses and the rider stays seated.
   * force: true gets out anyway, at the first exit: the vehicle is going, or the rider is being placed elsewhere.
   * @param {{ force?: boolean }} [o]
   * @returns {boolean} whether it got out
   */
  exit({ force = false } = {}) {
    const v = this.vehicle, e = this.engine;
    if (!v) return false;
    const seat = this.seat, at = this._exitSpot(v, seat) ?? (force ? v.exitPosition(seat) : null);
    if (!at) return false;
    if (seat === 0) { v.drive(0, 0, 1); v.driver = null; } else v.passengers.splice(v.passengers.indexOf(this), 1);
    seatsOf(e).rides.delete(this._ride); this._ride = null;
    this._writeSeat(null, null);
    this._driveCtx?.remove(); this._driveCtx = null;
    this.root.quaternion.identity(); this.root.rotation.y = this.facing;
    this._place(at); this.root.visible = true; this.grounded = true; this.state = this.stateMark = 'idle';
    if (e.player === this && this.cameraFollow) e.cameraRig?.follow(this.root);
    e.events.emit('vehicle:exit', { character: this, vehicle: v });
    return true;
  }
  /** Dispose this character completely: exit the vehicle first, release animation and mover, remove from the scene and dispose geometries and materials */
  dispose() {
    // a player made by addPlayer: its registry entry (st.players, keys, touch button, world:load listener) goes first, and calls this again with _release cleared
    if (this._release) { const r = this._release; this._release = null; r(); return; }
    this.disposed = true;   // a model still loading by asset name is dropped on arrival
    this.engine.control?.endTasks(this, 'gone');
    // a character without a world record or NPC id has nothing to come back as: its control slot goes with it (records drop theirs on world:remove,
    // an NPC model torn down when far keeps its slot, the NPC lives on)
    if (!this.recordId && !this.npcModel) this.engine.control?.forget(this.id);
    this.exit({ force: true });
    detach(this);   // a disposed rider must leave the platform's rider list, or it is carried and kept alive for as long as the platform lives
    this._pose.remove();
    this.anim?.dispose();
    for (const m of new Set(this._movers.values())) m.dispose?.();
    this.engine.characters?._capsules.delete(this._rig?.capsule);
    this.engine.remove(this.root);
  }
  /**
   * Copy motion state into a plain object (written into out, in place, no allocation): velocity, vertical speed, facing, move amount, grounded, swimming
   * (animation state is stored by the caller).
   * Why: the model is only a presentation of world data, torn down when far and rebuilt on load; keeping these in data lets loadMotion continue after a rebuild,
   * so running continuously and "save -> load -> continue" give the same result (NPCs, future enemies and zombies all use it).
   */
  saveMotion(out = {}) {
    out.vx = this.velocity.x; out.vz = this.velocity.y; out.vy = this.vy; out.facing = this.facing; out.amount = this.moveAmount;
    out.grounded = this.grounded; out.swimming = this.swimming;
    // motion format 2 (world part version 4): jump state nested, safe spot and the support's id; written in place so a per-step store allocates nothing
    const j = jumpOf(this), jo = (out.jump !== null && typeof out.jump === 'object') ? out.jump : (out.jump = badField(out.jump, 'jump', 'an object { coyote, used }') ?? {}); jo.coyote = j.coyote; jo.used = j.used;
    const g = this.safeGround; if (g) { const a = Array.isArray(out.safe) ? out.safe : (out.safe = badField(out.safe, 'safe', 'an array [x, y, z]') ?? [0, 0, 0]); a[0] = g.x; a[1] = g.y; a[2] = g.z; } else out.safe = null;
    out.support = stateOf(this).on?.id ?? null;
    return out;
  }
  /** Restore motion state from a saveMotion plain object (call after building the model / loading; missing fields keep defaults) */
  loadMotion(m) {
    if (!m) return this;
    this.velocity.set(m.vx ?? 0, m.vz ?? 0); this.vy = m.vy ?? 0; this.facing = m.facing ?? 0; this.root.rotation.y = this.facing;
    this.moveAmount = m.amount ?? 0; this.grounded = m.grounded ?? true; this.swimming = !!m.swimming;
    const j = jumpOf(this); j.coyote = m.jump?.coyote ?? 0; j.used = m.jump?.used ?? 0; j.buffer = 0;
    this.safeGround = (Array.isArray(m.safe) && m.safe.length === 3 && m.safe.every(Number.isFinite)) ? new THREE.Vector3(m.safe[0], m.safe[1], m.safe[2]) : this.safeGround;
    // ride the saved support again (found by id) from its current matrix; no support id = rides nothing
    detach(this);
    const en = m.support != null ? registry(this.engine).list.get(m.support) : null;
    if (en) { const s = stateOf(this); s.on = en; en.object.updateWorldMatrix(true, false); s.m.copy(en.object.matrixWorld); registry(this.engine).riders.add(this); }
    return this;
  }
  /** Play a one-shot action (e.g. 'wave', returns to the previous state when done); procedural characters have no actions, warn once and skip */
  playAction(name) {
    if (this.anim) this.anim.action(name);
    else warnOnce(fmt(STRINGS.noClip, { name: String(name) }));
  }

  /** Ground type under the feet (terrain groundType or level material name); 'water' while swimming. Footstep sounds map it via audio.footsteps */
  groundType() {
    if (this.swimming) return 'water';
    const p = this.root.position;
    return this.engine.groundType(p.x, p.z, p.y);
  }

  /**
   * Turn at once to face a point (Object3D / Vector3 / { x, z }) or an angle in radians (0 = +Z, PI / 2 = +X).
   * With faceMode 'manual' this is the only thing that turns the character
   * @example npc.face(engine.player); player.face(Math.PI)
   */
  face(target) {
    if (typeof target === 'number') this.facing = target;
    else { const [x, z] = xzOf(target); this.facing = Math.atan2(x - this.root.position.x, z - this.root.position.z); }
    this.root.rotation.y = this.facing;
  }

  /**
   * Run fn(character, dt) every frame right after this character's animation pose is applied (model clips or procedural rig), so a game can attach things to bones
   * or adjust bones on top of the pose. Returns a handle; h.remove() stops it. Presentation only: never read it for gameplay timing.
   * @param {(character: Character, dt: number) => void} fn
   * @returns {{ remove(): void }}
   * @example const h = player.onPose(() => sword.position.copy(player.root.getObjectByName('Hand_R').getWorldPosition(v)));
   */
  onPose(fn) { (this._poseFns ??= new Set()).add(fn); return { remove: () => this._poseFns.delete(fn) }; }
  /** @internal */
  _firePose(dt) { if (this._poseFns?.size) for (const f of [...this._poseFns]) { try { f(this, dt); } catch (err) { reportError(this.engine, err, 'character.onPose callback'); } } }
  /** @internal Call every frame: play animation, at the speed of the character's time channel (bullet time on 'enemies' slows their walk cycle too) */
  animate(dt) {
    dt *= this.engine.still ? 0 : this.engine.time.scale(this.channel, this.id);
    if (!this.limp) this._animate(dt);
    if (!this.anim?._hook) this._firePose(dt);   // an Animator with a frame hook fires it itself, once the pose is applied; a model without clips (and no IK) has no hook
  }
  /** @internal */
  _animate(dt) {
    const sp = this.moveAmount, t = this.engine.time.now('real'), st = this.state;
    this.phase += dt * (2.2 + sp * 1.25);
    const s = Math.sin(this.phase);
    // footstep event: fires once per foot landing (swing direction flips); model and procedural animation share this rhythm
    // the payload stays { character }: a crowd of NPCs steps all the time, and only a listener that wants the ground should pay for reading it
    if (this.grounded && sp > 0.4 && Math.sign(s) !== Math.sign(this._lastS ?? s)) this.engine.events.emit('character:step', { character: this });
    this._lastS = s;
    if (this.anim) {
      const a = this.anim;
      a.set('speed', sp);
      // state missing in the model: walk/run fall back to move (blend tree), then to idle
      a.go(a.states[st] ? st : (st === 'walk' || st === 'run') && a.states.move ? 'move' : 'idle');
      return;
    }
    if (st === 'drive') return;
    animateRig(this, sp, t, st);
  }
}
