// Real physics (Rapier): objects that topple, roll, get pushed and float on water.
//
// Split from collision() (engine.collision, cheap walking collision covering the whole map): this is dynamic-body physics, more costly, simulated only for
// chunks within +-terrainRing of each physics engine.stream source (the player, a teleport destination; never a camera-only source).
// The player is a kinematic capsule: it pushes crates and balls but is not pushed by them.
//
// const crate = engine.rigid.addBox(mesh, { mass: 5 });     // crate
// const ball  = engine.rigid.addBall(mesh, { radius: 0.4, restitution: 0.6 });
// engine.rigid.impulse(ball, [0, 3, 5]);                     // kick (impulse vector: Vector3 / [x, y, z] / { x, y, z })
// Returns an entry (handle) { body, collider, mesh (= object, position written by physics), remove() }: remove only deletes the body; the model is yours
// (shadow settings are untouched too). The other way round a body follows its model: engine.remove of the model, or of a parent such as a level's root, takes the body too
// const car = engine.rigid.addWheeled(carMesh, { wheels: [...] });   // vehicle, see Vehicles.js; engine.player.enter(car) to board; car.remove()
// Ray: once installed, engine.raycast(origin, direction, { targets: 'all' }) also hits rigid bodies (hit carries entry, kind: 'rigid'); no separate entry
// point.
//
// Rapier is downloaded on demand at start() (about 1.5MB); games without physics never load it.
import { FALL_Y } from '../../core/scene/ground.js';
import * as THREE from 'three';
import { vec3, xzOf } from '../../core/base/math.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { cellsChanged } from '../../core/stream/streamCells.js';
import { createVehicle, VEHICLE_KEYS, STRINGS } from './Vehicles.js';
import { syncTerrain, syncTrees, treesChanged, syncGroundTrees, syncStatics, restandStatics, syncLevel, syncFloor, dropChunks, wantsFloor, recordLocks, carryBody, carryCollider } from './sync.js';
import { refreshQueries } from './refresh.js';
import { Ragdolls } from './ragdoll.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { refuseSave, saveNumberOk, SAVE_MAX } from '../../core/base/saveValues.js';
import { warnOnce, DEV } from '../../core/base/validate.js';
import { follows } from '../../core/base/follows.js';
// Params of addBox / addBall / addHull
// A body lives in world space, a mesh's position in its parent's: register the world pose and write the pose back through the parent. A parent whose scale differs
// between axes would shear the rotation (and no body can follow it), so that is refused by name instead of drifting.
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _pq = new THREE.Quaternion();
function worldPose(mesh, who) {
  const P = mesh.parent;
  if (P) {
    P.updateWorldMatrix(true, false); P.matrixWorld.decompose(_p, _pq, _s);
    if (Math.abs(_s.x - _s.y) > 1e-4 || Math.abs(_s.x - _s.z) > 1e-4)
      throw codedError('rigid-misuse', `${who}: '${mesh.name || mesh.type}' sits under '${P.name || P.type}' whose world scale (${_s.x.toFixed(3)}, ${_s.y.toFixed(3)}, ${_s.z.toFixed(3)}) differs between axes; a body cannot follow a sheared parent. Make the parent's scale equal on all axes, or give the body a mesh outside it`);
  }
  mesh.updateWorldMatrix(true, false); mesh.matrixWorld.decompose(_p, _q, _s);
  return { p: _p, q: _q };
}
function setLocalPose(mesh, t, r) {
  const P = mesh.parent;
  if (!P || P.matrixWorld.equals(_I)) { mesh.position.set(t.x, t.y, t.z); mesh.quaternion.set(r.x, r.y, r.z, r.w); return; }
  P.matrixWorld.decompose(_p, _pq, _s);
  mesh.position.copy(P.worldToLocal(_p.set(t.x, t.y, t.z)));
  mesh.quaternion.copy(_pq.invert().multiply(_q.set(r.x, r.y, r.z, r.w)));
}
const _I = new THREE.Matrix4(), _eu = new THREE.Euler(), _box = new THREE.Box3(), _part = new THREE.Box3(), _inv = new THREE.Matrix4(), _rel = new THREE.Matrix4();
/**
 * The size a body gets from its model, as [x, y, z]: measured in the mesh's own axes, since the body takes its rotation, and at its world scale, parents included.
 * The box around it in the world grew with the turn, so a turned crate got a larger body turned on top of that.
 * skip(o): parts left out (a vehicle's wheels). The mesh is not moved: a parent's transform is in matrixWorld and in its inverse alike, so it cancels
 */
export function ownBox(mesh, skip) {
  mesh.updateWorldMatrix(true, true);
  mesh.matrixWorld.decompose(_p, _q, _s);
  _inv.copy(mesh.matrixWorld).invert(); _box.makeEmpty();
  mesh.traverse(o => {
    const g = o.geometry; if (!g || skip?.(o)) return;
    if (!g.boundingBox) g.computeBoundingBox();
    _box.union(_part.copy(g.boundingBox).applyMatrix4(_rel.multiplyMatrices(_inv, o.matrixWorld)));
  });
  const box = _box.clone(), k = _s.set(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z));   // a mirrored model (scale -1) has the size of its picture, not min above max
  box.min.multiply(k); box.max.multiply(k);
  return box;
}
const ownSize = mesh => ownBox(mesh).getSize(_p).toArray();
const NO_TURN = { x: 0, y: 0, z: 0, w: 1 };

const PHYSICS = { physics: true };   // stream source filter (shared, not rebuilt every step)
/** A body this far down over the ground fell through it: the rule 'fall' is asked. Deep enough that no walkable level reaches it by accident; a level below it sets the rule to false */
const SOLID_PARAMS = keysSchema(['position', 'size', 'radius', 'rotation', 'friction']);
const BODY_KEYS = ['id', 'mass', 'friction', 'restitution', 'damping', 'angularDamping', 'fixed'];

/**
 * Run Rapier's step and character-controller code once in a throwaway world, while start() still loads. Why: the browser compiles a WASM
 * function on its first call, and the game world's first step paid that for the whole step path: ~120 ms with 77 colliders on a real GPU
 * machine (built page), the whole "draw" part of the first frame (docs/testing/field/2026-11-03-perf.md). Here it runs while start() waits
 * for the GPU to compile shaders, when the page's thread is idle anyway (a setTimeout instead landed in WebGPU's nearby-build wait and made
 * it 150 ms longer). The game's world is untouched (no game time passes, same results).
 * Once per page: the compiled code belongs to the one WASM instance.
 */
const WARMED = new WeakSet();
function warmRapier(R) {
  if (WARMED.has(R)) return;
  WARMED.add(R);
  const w = new R.World({ x: 0, y: -9.81, z: 0 });
  try {
    w.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5));
    w.createCollider(R.ColliderDesc.trimesh(new Float32Array([-5, 1, -5, 5, 1, -5, 0, 1, 5]), new Uint32Array([0, 1, 2])));
    for (const [i, c] of [R.ColliderDesc.ball(0.5), R.ColliderDesc.cuboid(0.4, 0.4, 0.4), R.ColliderDesc.cylinder(0.4, 0.3), R.ColliderDesc.capsule(0.3, 0.2)].entries())
      w.createCollider(c, w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(i - 1.5, 1.2, 0)));
    const kin = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(2, 1.5, 2));
    const me = w.createCollider(R.ColliderDesc.capsule(0.5, 0.3), kin);
    const cc = w.createCharacterController(0.01);
    for (let i = 0; i < 3; i++) {
      cc.computeColliderMovement(me, { x: 0.1, y: -0.1, z: 0 });
      kin.setNextKinematicTranslation({ x: 2 + i * 0.1, y: 1.5, z: 2 });
      w.step();
    }
    w.removeCharacterController(cc);
  } finally { w.free(); }
}

export class RigidBodies {
  /** terrainRing = chunk rings around each physics stream source that get terrain collision; buoyancyForce = buoyancy strength (1 = exactly floats); waterDrag = drag in water;
   * floatLine / floatDepth: buoyancy starts when the body center is below floatLine meters above the surface and peaks floatDepth meters deeper;
   * treeColliderHeight = trunk collision cylinder height; treeRadius = trunks get cylinders only in chunks within this many meters of the player or a non-fixed body;
   * playerCapsule { halfHeight, radius } = player capsule size (default derived from engine.movement radius / height);
   * fallbackFloor = the flat plane at y = 0 when the ground has no collision of its own (default true; false for a game with only its own bodies and solids) */
  constructor(engine, { gravity = -9.81, terrainRing = 1, buoyancy = true, buoyancyForce = 1.6, waterDrag = 2.5, floatLine = 0.3, floatDepth = 0.8,
    treeColliderHeight = 6, treeRadius = 16, playerCapsule, fallbackFloor = true } = {}) {
    const mv = engine.movement;   // default capsule uses the shared character radius / height: total height = 2 * halfHeight + 2 * radius
    this._capsuleRadiusGiven = playerCapsule?.radius != null;   // the mover follows the character's radius only when the game did not set one here
    playerCapsule ??= { halfHeight: Math.max(0.05, (mv.height - 2 * mv.radius) / 2), radius: mv.radius };
    this.engine = engine;
    this.gravity = gravity;
    this.terrainRing = terrainRing;
    this.buoyancy = buoyancy; this.buoyancyForce = buoyancyForce; this.waterDrag = waterDrag; this.playerCapsule = playerCapsule;
    this.floatLine = floatLine; this.floatDepth = floatDepth; this.treeColliderHeight = treeColliderHeight; this.treeRadius = treeRadius;
    this.fallbackFloor = fallbackFloor;
    this.rapier = null; this.world = null;
    this.bodies = [];                 // { body, mesh, enabled }
    /** @internal body handle -> entry for rays, rebuilt only after bodies changed (null): a ray cast every frame (aim, a camera probe) built a new Map each time */ this._byHandle = null;
    /** @internal a session:end asked for a rebuild that world:load / afterLoad has not run yet (one rebuild per new game or load) */ this._freshDue = false;
    this.terrain = new Map();         // chunk key -> { colliders: [] }
    this.trees = new Map();           // chunk key -> { token, colliders }: trunk cylinders of the chunks near the player / bodies (see sync.js)
    this._anchors = []; this._treeMemo = [];
    this.groundTrees = new Map();     // 'x,z,r' -> cylinder collider: circles from ground.forEachCollider when the ground has no chunked collision
    /** @internal houses / pillars of the collision module as colliders (engine.collision.mirror, built on the first step: sync.js syncStatics) */ this._statics = null; /** @internal mirror data -> collider, for those standing on the ground */ this._onGround = new Map(); /** @internal collider -> mirror data, for those with a layer: the rapier mover lets a body that passes it through */ this._layered = new Map();
    /** @internal the sources of the copies above, checked on every read (_current) */ this._collision = follows(() => engine.collision); this._level = follows(() => engine.ground.staticTrimeshes ?? null, () => engine.ground.staticVersion?.() ?? 0); this._standOn = follows(() => engine.ground, G => G.staticVersion?.() ?? 0); this._floor = follows(() => wantsFloor(this));
    /** @internal the world changed since Rapier last built its query structures, which it does only in a step */ this._behind = false;
    /** @internal fixed solids of the collider3d contract: what they are, so every new world (init, _fresh) builds them; a collider only lives as long as its world */ this._solids = new Set();
    this.vehicles = [];
    /** @internal numbers vehicles added without an id */ this._vehicleSeq = 0;
    /** @internal id -> saved physics state of a body not built yet (the save part 'rigid'; claimed when a body with that id is added) */ this._saved = new Map();
    this.ready = false;
  }

  /**
   * @internal Import and instantiate Rapier once. Started at install: the import plus WASM compile took 0.8-1.1 s on a cold start and used to
   * begin only when start() reached this module's init, with every later init waiting behind it; begun at install it overlaps the world build
   */
  _wasm() { return (this._rapier ??= import('@dimforge/rapier3d-compat').then(async mod => { const R = mod.default ?? mod; await R.init(); return R; })); }

  /** @internal module hook */
  async init(signal) {
    if (this.ready) return;
    this.rapier = await this._wasm();
    if (signal?.aborted) return;   // unloaded while the WASM loaded: dispose ran with no world to free, so none may be made now (ctx.signal)
    this._newWorld();
    this.ready = true;
  }
  /** @internal A fresh Rapier world with the player capsule (and the flat plane without chunked ground): what init builds, and what _fresh rebuilds */
  _newWorld() {
    const R = this.rapier;
    this.world = new R.World({ x: 0, y: this.gravity, z: 0 });
    // Player capsule (kinematic: the character controller decides position; physics only pushes other things away)
    this.playerBody = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    const pc = this.playerCapsule;
    this.playerCollider = this.world.createCollider(R.ColliderDesc.capsule(pc.halfHeight, pc.radius).setTranslation(0, pc.halfHeight + pc.radius, 0), this.playerBody);
    this._floorCollider = null; this._floor.reset(); syncFloor(this);   // a new world has none. Here, so colliders keep the order a fresh page builds them in
    for (const s of this._solids) this._buildSolid(s);
  }

  /** @internal Copies of what others own are current, as any read needs them. Every step runs it; a frozen engine runs no step, and queries still ask */
  _upkeep() { if (syncStatics(this) | syncLevel(this) | syncFloor(this) | dropChunks(this)) this._behind = true; }
  /**
   * @internal Every query starts here, and answers whether physics can be asked. Rapier has no call that refreshes its query structures alone (refresh.js), so a step of no time does, twice (one leaves a moved body or a reused collider slot out, measured in `refresh while frozen`): nothing
   * moves, and it runs only when something changed, so a ray pays three compares.
   */
  _current() {
    if (!this.ready) return false;
    this._upkeep();
    if (this._behind) { refreshQueries(this.world); this._behind = false; }
    return true;
  }

  /**
   * @internal New playthrough or a load (world:load, else afterLoad after a session:end): physics starts over like a fresh page. Velocities, sleep and the solver's warm
   * start live inside the Rapier world, and so does the order bodies were created in (freed handles are reused last-in first-out), so the same
   * crate pushed the same way after newGame landed a few millimetres off the fresh-page result (durability audit). The world is rebuilt: the
   * player capsule first, every body still here (bodies of world records were already removed by the load and come back with their views) at its
   * pose with no velocity, and terrain / tree / static colliders on the next step, the order a fresh page builds them in. What the game wrote on a
   * body or collider itself (gravityScale, axis locks, ccd, dominance, sensor, groups, enabled) is carried onto the rebuilt one (carryBody / carryCollider in sync.js). Joints are not carried: Rapier has no getters for a joint's
   * whole description (rope length, motor settings), and copying one would mean patching Rapier. The game re-creates its own joints on rigid:rebuilt,
   * emitted once the bodies are back (the coordination point); a dev warning names a game whose joints vanished with no re-creation. Movers'
   * character controllers are freed with the old world (World.free frees them; movers/rapier.js sees another world object and builds new ones).
   * Vehicles hold a controller built for one world: with a vehicle present only the bodies are stopped and put to sleep (no rebuild).
   */
  _fresh() {
    this._freshDue = false;
    if (!this.ready) return;
    if (this.vehicles.length) {
      for (const b of this.bodies) { const y = b.body; y.setLinvel({ x: 0, y: 0, z: 0 }, false); y.setAngvel({ x: 0, y: 0, z: 0 }, false); y.resetForces(false); y.resetTorques(false); if (y.isDynamic()) y.sleep(); }
      return;
    }
    const old = this.world, R = this.rapier, hadJoints = old.impulseJoints.len();
    this._newWorld();
    this.terrain.clear(); this.trees.clear(); this.groundTrees.clear(); this._statics?.clear(); this._onGround.clear(); this._layered.clear();
    this._level.reset(); this._levelColliders = [];
    this._srcMemo = null; this._srcPending = false; this._syncT = 0; this._anchors = []; this._treeMemo = [];
    for (const b of this.bodies) {
      const t = b.body.translation(), q = b.body.rotation();
      const bd = (b.fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic()).setTranslation(t.x, t.y, t.z).setRotation(q)
        .setLinearDamping(b.damping).setAngularDamping(b.angularDamping).setCanSleep(true);
      const ob = b.body, oc = b.collider;
      b.body = this.world.createRigidBody(bd);
      b.collider = this.world.createCollider(b._desc, b.body);
      // what the game wrote on the Rapier body / collider (gravityScale, locks, ccd, sensor, groups, enabled...) is its own and survives the rebuild
      carryBody(b, ob, b.body); carryCollider(oc, b.collider);
      // b.enabled stays: it is the engine's own freeze flag (no ground under it), which the step loop compares with; a game's setEnabled(false) was carried
      b.wet = false; b._void = false; b._fell = false;
    }
    old.free(); this._byHandle = null;   // every body has a new handle
    // the old world's joints (every one is the game's: the engine makes none) went with it. The game re-creates them here, between the rebuilt bodies
    const bodies = {};
    for (const b of this.bodies) if (b.id != null) bodies[b.id] = b.body;
    this.engine.events.emit('rigid:rebuilt', { world: this.world, player: this.playerBody, bodies });
    // checked on the next step, not here: on a load, a presenter's build re-adds its bodies (and their joints) after world:load
    if (DEV && hadJoints) this._jointsGone = hadJoints;
  }

  // ---------- Add bodies ----------
  /** @internal Rapier loads during engine.start(): a body added before has no world. Dev throws at the call (a null handle used to fail far
   *  away, at crate.body.applyImpulse); release warns once and the add returns null */
  _ready(call) {
    if (this.ready) return true;
    const msg = `engine.rigid.${call}() ran before physics was ready (Rapier loads during engine.start()). Add bodies after it: ` +
      `\`await engine.start(); engine.rigid.${call}(mesh, { ... })\`, or inside engine.events.on('engine:ready', () => { ... })`;
    if (DEV) throw codedError('module-needs', msg);
    warnOnce(coded('module-needs', msg)); return false;
  }
  _add(mesh, desc, { id, mass = 1, friction = 0.7, restitution = 0.1, damping = 0.05, angularDamping = 0.1, fixed = false } = {}) {
    // id names the body in the save part 'rigid': two live bodies with one id would load into each other
    if (id != null && this.bodies.some(b => b.id === id)) throw codedError('rigid-misuse', `rigid: id '${id}' is already used by another body or vehicle; ids name the body in saves, pick a unique one (e.g. the world record id)`);
    const R = this.rapier, { p, q } = worldPose(mesh, 'rigid');
    // the pose registration comes first: a mesh another body or a character already owns throws here, before any Rapier body exists to leak
    let entry;
    const pose = this.engine._poses.add(mesh, at => { if (this.world) this.setPosition(entry, entry.place?.(at) ?? at); }, () => entry.remove(), () => id != null ? `rigid body '${id}'` : 'a rigid body');
    const bd = (fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(damping).setAngularDamping(angularDamping).setCanSleep(true);
    const body = this.world.createRigidBody(bd);
    desc.setFriction(friction).setRestitution(restitution).setMass(mass);
    const collider = this.world.createCollider(desc, body);   // desc is kept on the entry (_desc): _fresh rebuilds the collider from it
    if (!mesh.parent) this.engine.add(mesh, { owner: 'engine:rigid' });   // shadow casting/receiving follows the model's own settings (not forced)
    entry = { id, body, collider, mesh, object: mesh, enabled: true, volume: 0, damping, angularDamping, fixed, _x: p.x, _z: p.z, _desc: desc };   // _x / _z: where sync.js looks for trunks to give it
    entry.remove = () => this._remove(entry);
    recordLocks(entry, body);
    this.bodies.push(entry); this._byHandle = null; this._behind = true;
    // a write to the record of this model lands here (world/views.js placed); with rigid gone first at dispose the model is on its own
    // entry.place: a template's copy says what a written place means for it (content/templates.js)
    entry._pose = pose;
    // a loaded save holds this body's state (it is built after the load, e.g. by a world presenter): it continues from there, not from the record's pose
    this._claim(entry);
    return entry;
  }
  /** Box. When size is omitted it is computed from the model bounding box */
  addBox(mesh, o = {}) {
    readParams('rigid.addBox()', keysSchema([...BODY_KEYS, 'size']), o);
    if (!this._ready('addBox')) return null;
    const s = o.size || ownSize(mesh);
    return this._add(mesh, this.rapier.ColliderDesc.cuboid(s[0] / 2, s[1] / 2, s[2] / 2), o);
  }
  /** Ball */
  addBall(mesh, o = {}) {
    readParams('rigid.addBall()', keysSchema([...BODY_KEYS, 'radius']), o);
    if (!this._ready('addBall')) return null;
    const r = o.radius ?? ownSize(mesh)[0] / 2;
    return this._add(mesh, this.rapier.ColliderDesc.ball(r), o);
  }
  /** Convex hull: auto-wrapped around the model shape (irregular objects such as rocks, barrels) */
  addHull(mesh, o = {}) {
    readParams('rigid.addHull()', keysSchema(BODY_KEYS), o);
    if (!this._ready('addHull')) return null;
    const g = mesh.geometry, pts = new Float32Array(g.attributes.position.count * 3);   // count, not array.length: an interleaved attribute's array is the whole buffer
    const v = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false); mesh.matrixWorld.decompose(_p, _q, _s);   // the world scale: a parent's counts as much as the mesh's own
    const scale = _s.clone();
    for (let i = 0; i < g.attributes.position.count; i++) {
      v.fromBufferAttribute(g.attributes.position, i).multiply(scale); pts.set([v.x, v.y, v.z], i * 3);
    }
    return this._add(mesh, this.rapier.ColliderDesc.convexHull(pts), o);
  }
  /**
   * Wheeled vehicle (Rapier ray-cast vehicle controller): id (stable, for saves; default vehicle1, vehicle2... in creation order), wheels, mass,
   * engineForce, brakeForce, maxSteer, suspension, seats (local seat positions, the first drives; default one at the chassis center), hideDriver
   * (default true; false keeps riders visible on their seats: bikes, open carts), camera; see Vehicles.js
   * @example const kart = engine.rigid.addWheeled(mesh, { wheels, seats: [[-0.4, 0.6, 0], [0.4, 0.6, 0]], hideDriver: false });
   */
  addWheeled(mesh, o) {
    readParams('rigid.addWheeled()', keysSchema(VEHICLE_KEYS), o);
    if (!this._ready('addWheeled')) return null;
    const { id = 'vehicle' + ++this._vehicleSeq, ...rest } = o;
    // id: the player's save names the vehicle it sits in by it, and the save part 'rigid' its body state (the unique check is _add's)
    const v = createVehicle(this, mesh, rest, id);
    v.remove = () => this._removeVehicle(v);
    this.vehicles.push(v);
    return v;
  }
  /** Remove a vehicle (the occupant exits first): called by vehicle.remove() */
  _removeVehicle(v) {
    if (!this.vehicles.includes(v)) return;
    for (const p of [...v.passengers]) p.exit({ force: true });
    v.driver?.exit({ force: true }); v._use?.remove(); v.gone = true; v._seatBook?.remove();
    this.vehicles = this.vehicles.filter(x => x !== v);
    this.world.removeVehicleController(v.controller);
    this._remove(v);
  }
  /**
   * Turn a skinned character limp, one call; rd.remove() returns it to animation. Its mover, animation, capsule and camera yield until then. @experimental
   * @param {any} who a Character, an NPC handle, a character id or a skinned Object3D
   * The rule 'ragdoll.graph' says which parts it has: 'humanoid' (default), a graph { part: { bone, parent, limits, mass } }, or false for none (returns null).
   * @param {{ impulse?: any, position?: any, bones?: Record<string, any>, limits?: Record<string, any>, mass?: number }} [o] impulse: a push (kg*m/s) on the part nearest position, else on the root part; bones: humanoid part -> bone name or bone, over the auto-detection; limits: part or kind ('lowerLeg') -> { bend, side, twist } as [min, max] radians from the bind pose; mass: whole body, default the graph's (humanoid 70 kg)
   * @example const rd = engine.rigid.ragdoll(player, { impulse: [0, 200, -300], position: hit.point }); engine.clock.after(4, () => rd.remove(), { channel: 'real' });
   */
  ragdoll(who, o) {
    if (!this._ready('ragdoll')) return null;
    return (this._ragdolls ??= new Ragdolls(this)).start(who, o);
  }
  /** @internal Whether the physics ground under a position is built (used by mover: 'rapier'; always true without chunked terrain) */
  readyAt(position) {
    if (!this.engine.ground.chunkCollision) return true;
    const [x, z] = xzOf(position);
    return this._chunkReady(x, z);
  }
  /** @internal */
  _chunkReady(x, z) { const CH = this.engine.ground.chunkSize ?? 64; return !!this.terrain.get(Math.floor(x / CH) + ',' + Math.floor(z / CH))?.ready; }
  /** @internal A moving body left the terrain colliders. Told once in dev; not told: a body at rest left behind (normal), a chunk still waiting for its collider (it has a terrain entry, or chunks are pending) */
  _tellFrozen(b, t, CH) {
    if (this._srcPending || !b.body.isDynamic() || b.body.isSleeping() || this.terrain.has(Math.floor(t.x / CH) + ',' + Math.floor(t.z / CH))) return;
    warnOnce(coded('rigid-misuse', `rigid: body '${b.id ?? (b.mesh.name || 'unnamed')}' froze at x ${t.x.toFixed(0)}, z ${t.z.toFixed(0)} (entry.enabled is false): it left rigid({ terrainRing: ${this.terrainRing} }), the ${CH} m chunks around the player that have terrain colliders, and would fall through the ground. It stays frozen until the player comes near. A body that must keep moving out there needs a larger terrainRing (recipe 11 section 3)`), 'rigid-frozen');
  }
  /** Delete the body (called by entry.remove()); the model stays */
  _remove(entry) {
    const i = this.bodies.indexOf(entry); if (i < 0) return;
    this.world?.removeRigidBody(entry.body);   // no world: rigid left first at dispose and freed its bodies with it
    this.bodies.splice(i, 1); this._byHandle = null; this._behind = true;
    entry._pose.remove();
  }
  /** Push: impulse vector v (Vector3 / [x, y, z] / { x, y, z }) */
  impulse(entry, v) { const { x, y, z } = vec3(v); entry.body.wakeUp(); entry.body.applyImpulse({ x, y, z }, true); }
  /** Teleport to position (velocity zeroed) */
  setPosition(entry, position) {
    const { x, y, z } = vec3(position);
    entry._x = x; entry._z = z;
    entry.body.setTranslation({ x, y, z }, true); entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true); this._behind = true;
  }

  // ---------- The collider3d contract (collider3d.contract.js): engine.collider3d is this object ----------
  /**
   * A fixed solid turned any way: size [x, y, z] for a box or radius for a ball, rotation [x, y, z] radians or a quaternion. Returns { remove() }. Callable before start();
   * newGame and a load keep it. Bodies and the rapier mover hit it; engine.collision does not know it, so a simple-mover walker walks through.
   * @example const ramp = engine.collider3d.addSolid({ position: [0, 2, 0], size: [8, 0.5, 3], rotation: [0, 0, 0.4] });
   */
  addSolid(o) {
    readParams('collider3d.addSolid()', SOLID_PARAMS, o);
    if ((o.size == null) === (o.radius == null)) throw codedError('rigid-misuse', `collider3d.addSolid(): give exactly one of size ([x, y, z], a box) or radius (a ball)`);
    const s = { o, collider: null, remove: () => { if (this._solids.delete(s) && this.world && s.collider) { this.world.removeCollider(s.collider, false); this._behind = true; } } };
    this._solids.add(s);
    if (this.world) this._buildSolid(s);
    return s;
  }
  /** @internal */
  _buildSolid(s) {
    const R = this.rapier, { position, size, radius, rotation, friction = 0.9 } = s.o, p = vec3(position);
    const q = Array.isArray(rotation) ? _q.setFromEuler(_eu.fromArray(rotation)) : rotation ? _q.set(rotation.x, rotation.y, rotation.z, rotation.w) : _q.identity();
    const desc = size ? R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2) : R.ColliderDesc.ball(radius);
    s.collider = this.world.createCollider(desc.setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(friction));
    this._behind = true;
  }
  /** Is a ball here inside something solid (false before physics is ready). Sees the world as it stands now, also while frozen; skips the player's capsule */
  overlap(position, radius = 0.01) {
    if (!this._current()) return false;
    const R = this.rapier, { x, y, z } = vec3(position);
    return !!this.world.intersectionWithShape({ x, y, z }, NO_TURN, new R.Ball(radius), R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, this.playerBody);
  }
  /**
   * Move a ball from there to there: null when clear, else the first hit { point, normal, distance }: point is the ball's center at the hit, normal the world direction out of what it hit.
   * A ball that starts touching or inside a solid and moves out of it is clear: a flyer taking off from the ground must not be held by the ground it stands on.
   * @example const hit = engine.collider3d.sweep(drone.position, next, 0.4); if (hit) drone.position.copy(hit.point);
   */
  sweep(from, to, radius = 0.01) {
    if (!this._current()) return null;
    const R = this.rapier, a = vec3(from), d = vec3(to).sub(a), len = d.length();
    if (!len) return null;
    d.divideScalar(len);
    const hit = this.world.castShape({ x: a.x, y: a.y, z: a.z }, NO_TURN, { x: d.x, y: d.y, z: d.z }, new R.Ball(radius), 0, len, false, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, this.playerBody);
    if (!hit) return null;
    const n = hit.normal1;   // world space on World.castShape (the tilted-box test fails first if an upgrade changes that)
    return { point: a.addScaledVector(d, hit.time_of_impact), normal: new THREE.Vector3(n.x, n.y, n.z), distance: hit.time_of_impact };
  }

  /** Ray (provider for engine.rays, called by engine.raycast when targets: 'all'): hits dynamic bodies only, returns RayHit (with entry, kind: 'rigid') */
  _raycast(origin, dir, far) {
    if (!this._current() || !this.bodies.length) return null;
    let byHandle = this._byHandle;
    if (!byHandle) { byHandle = this._byHandle = new Map(); for (const b of this.bodies) byHandle.set(b.body.handle, b); }
    const max = Number.isFinite(far) ? far : 1e6;
    const only = c => byHandle.has(c.parent()?.handle);
    const hit = this.world.castRayAndGetNormal(new this.rapier.Ray(origin, dir), max, true, undefined, undefined, undefined, this.playerBody, only);
    if (!hit) return null;
    const entry = byHandle.get(hit.collider.parent()?.handle);
    if (!entry) return null;
    const t = hit.timeOfImpact;
    const point = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(dir, t);
    return { point, distance: t, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), object: entry.object, face: null, entry, kind: 'rigid' };
  }

  // ---------- Save part 'rigid' ----------
  /**
   * @internal What a save keeps of each body with an id (addBox / addBall / addHull({ id }), vehicles always): pose, velocities, asleep. Without it a
   * load put a toppling crate back upright and at rest wherever its record was, so the game after the load was not the game that was saved. A template
   * body carries its record id, and atRest (content/templates.js): while it stands where content put it, content is its state and it stays out of the save.
   * Bodies not built yet keep their loaded state (it is still the saved game). Not kept: Rapier's contact / warm-start caches (docs/recipes/11-vehicles.md, section 3).
   */
  _saveState() {
    const out = {};
    for (const [id, s] of this._saved) if (!this._outrun(id, s)) out[id] = s;
    for (const b of this.bodies) if (b.id != null && !b.atRest) out[b.id] = stateOf(b.body);
    return out;
  }
  /** @internal Load: bodies here now take their state in afterLoad (after _fresh rebuilt them); the rest when they are added */
  _loadState(d) {
    // a body past float precision (x = -1e308) sends the ground loops around it spinning and the page never comes back: damage, refused like a damaged world record (world/persist.js)
    for (const [id, s] of Object.entries(d ?? {}))
      if (!Array.isArray(s) || s.length !== 14 || !s.every(v => typeof v === 'boolean' || saveNumberOk(v))) refuseSave('rigid', `body '${id}'`, `must be a list of 14 numbers within ±${SAVE_MAX}`, s);
    this._saved = new Map(Object.entries(d ?? {})); this._ragdolls?.load();
  }
  /** @internal afterLoad: hand the loaded state to the bodies that exist (vehicles, bodies the game keeps across a load) */
  _claimSaved() {
    for (const b of this.bodies) this._claim(b);
  }
  /** @internal A body takes its loaded state, the one way in */
  _claim(entry) {
    if (entry.id == null) return;
    const s = this.stateFor(entry.id);
    this._saved.delete(entry.id);
    if (s) putState(entry, s);
  }
  /** @internal The loaded state a body built now with this id takes, or null. Asked before the build too: a copy about to take a state is not where content put it (content/templates.js addBody) */
  stateFor(id) {
    const s = this._saved.get(id);
    return s && !this._outrun(id, s) ? s : null;
  }
  /** @internal The world record of a body not built yet was moved after this state was saved (no body was there to take the write): the newer write wins, as in views.pull */
  _outrun(id, s) {
    const W = this.engine.world, rec = W?.records.get(id), p = rec?.position;
    return !!p && W.presents(rec.kind) && Math.max(Math.abs(p.x - s[0]), Math.abs(p.y - s[1]), Math.abs(p.z - s[2])) > 1e-3;   // presented: a record that only shares its id with a game's body follows nothing
  }

  // ---------- Every fixed step ----------
  /** @internal module hook */
  step(dt) {
    if (!this.ready) return;
    const e = this.engine, G = e.ground, CH = G.chunkSize ?? 64, chunked = !!G.chunkCollision;
    // the simulation runs on the world channel, like characters, walks and swarms: slow motion slows bodies and a hit-stop holds them. Collider upkeep below stays on real time
    const worldDt = e.time.dt('world');
    const focus = e.player ? e.player.position : e.focus;   // player-body: the player's own kinematic body follows the character, not engine.actor
    // terrain collision around physics stream sources: sync at once when their chunks change, otherwise check every 0.5 s (tree felling etc.)
    // compared in place against last step's cells (no array, no string key while nothing crosses a chunk border); the list is built only when syncing
    const memo = this._srcMemo || (this._srcMemo = []);
    const moved = cellsChanged(e.stream, memo, CH, this.terrainRing, PHYSICS), n = memo.length;
    const treesMoved = chunked && treesChanged(this, focus, CH);
    this._syncT = (this._syncT || 0) + dt;
    if (moved || treesMoved || this._srcPending || this._syncT > 0.5) {
      const src = [];
      for (let i = 0; i < n; i += 3) src.push([memo[i], memo[i + 1], memo[i + 2]]);
      let pending = false;
      if (chunked) { pending = syncTerrain(this, src); pending = syncTrees(this, focus, CH) || pending; } else syncGroundTrees(this, src, CH);
      this._srcPending = pending; this._syncT = 0;   // pending: chunks still waiting for their turn, sync again next step
    }
    this._upkeep();
    if (this._jointsGone) {   // dev only (set in _fresh): the old world had the game's joints and nothing re-created one since the rebuild
      if (!this.world.impulseJoints.len()) warnOnce(coded('rigid-misuse', `rigid: ${this._jointsGone} joint(s) were freed with the old physics world by newGame / load and none was re-created. The engine rebuilds the world and does not copy joints: re-create them in a rigid:rebuilt listener ({ world }), between entry.body of the rebuilt bodies (recipes/11-vehicles.md, Joints)`));
      this._jointsGone = 0;
    }
    // player capsule follows the player (the rapier mover computes collision and writes the position itself); turned off while driving to avoid colliding with
    // the car
    if (e.player) this.playerBody.setNextKinematicTranslation({ x: focus.x, y: focus.y, z: focus.z });
    // no player, no capsule: with no player nothing moves it, and it would sit as an invisible solid body at the origin
    const onFoot = !!e.player && !e.player.vehicle && !this._ragdolls?.holds(e.player);
    if (this.playerCollider.isEnabled() !== onFoot) this.playerCollider.setEnabled(onFoot);
    if (worldDt > 0) for (const v of this.vehicles) if (v.enabled) v._update(worldDt);

    // freeze bodies without terrain collision under them (unfrozen they would fall through)
    for (const b of this.bodies) {
      const t = b.body.translation();
      b._x = t.x; b._z = t.z;
      const ok = !chunked || this._chunkReady(t.x, t.z);
      if (ok !== b.enabled) { if (DEV && !ok) this._tellFrozen(b, t, CH); b.body.setEnabled(ok); b.enabled = ok; }
      // buoyancy: the submerged part gets an upward force, and water adds drag
      const water = this.buoyancy ? e.waterAt(t.x, t.z, t.y) : -Infinity;   // at its own height: a game's water body may be a pool upstairs or a falling column
      if (ok && this.buoyancy && t.y < water + this.floatLine && b.body.isDynamic()) {
        const depth = Math.min(1, (water + this.floatLine - t.y) / this.floatDepth);
        const m = b.body.mass();
        b.body.applyImpulse({ x: 0, y: -this.gravity * m * (this.buoyancyForce * depth) * worldDt, z: 0 }, true);   // an impulse, not addForce: Rapier keeps forces until reset, and a reset would wipe the game's own thrust / wind on the same body
        b.body.setLinearDamping(this.waterDrag); b.body.setAngularDamping(this.waterDrag);
        b.wet = true;
      } else if (b.wet) {
        b.body.setLinearDamping(b.damping); b.body.setAngularDamping(b.angularDamping); b.wet = false;
      }
    }

    if (worldDt > 0) { this.world.timestep = worldDt; this.world.step(); this._behind = false; }

    for (const b of this.bodies) {
      if (!b.enabled || b.body.isSleeping() || b.ragdoll) continue;   // ragdoll parts are drawn by ragdoll.js, through the bones
      const t = b.body.translation(), r = b.body.rotation();
      setLocalPose(b.mesh, t, r);
      this._fallen(b, t);
      // fell off terrain({ shape }): one terrain:void per fall, the game decides what next
      const under = t.y < e.ground.voidY();
      if (under && !b._void) e.events.emit('terrain:void', { who: b, position: { x: t.x, y: t.y, z: t.z } });
      b._void = under;
    }
    for (const v of this.vehicles) v._sync();
    this._ragdolls?.sync();
  }

  /**
   * @internal Fell through the ground: the rule 'fall' decides (nothing happens until the game sets one; 'rescue' is the built-in), asked once per fall so a game's function sees one event, not one per step; b._fell stays set
   * while a body it left down there is still down. Only over ground: out past the map edge there is nothing to put it back on.
   */
  _fallen(b, t) {
    const e = this.engine, out = t.y < FALL_Y && e.ground.has(t.x, t.z);
    if (!out) { b._fell = false; return; }
    if (b._fell) return;
    b._fell = this._fall.decide(b.id, { kind: 'body', who: b, position: { x: t.x, y: t.y, z: t.z } }) !== 'rescue';
    if (!b._fell) this.setPosition(b, [t.x, e.surface(t.x, t.z, t.y) + 2, t.z]);   // from below every floor the height picks the lowest: the one it went through, not a deck or a mountain over a cave
  }

  get stats() {
    const active = this.bodies.filter(b => b.enabled && !b.body.isSleeping()).length;
    return { bodies: this.bodies.length, active, colliders: this.world ? this.world.colliders.len() : 0 };
  }
}

// A body's state in the save: [x, y, z, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz, asleep]. Rapier stores f32, which JSON keeps exactly
function stateOf(b) {
  const t = b.translation(), q = b.rotation(), v = b.linvel(), w = b.angvel();
  return [t.x, t.y, t.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z, b.isSleeping() ? 1 : 0];
}
function putState(entry, s) {
  const b = entry.body, m = entry.mesh;
  entry.atRest = false;
  // sleep first: Rapier's sleep() clears speed, and a body falls asleep with the speed it last had, which it moves off with when woken
  if (s[13]) b.sleep(); else b.wakeUp();
  b.setTranslation({ x: s[0], y: s[1], z: s[2] }, false); b.setRotation({ x: s[3], y: s[4], z: s[5], w: s[6] }, false);
  b.setLinvel({ x: s[7], y: s[8], z: s[9] }, false); b.setAngvel({ x: s[10], y: s[11], z: s[12] }, false);
  setLocalPose(m, { x: s[0], y: s[1], z: s[2] }, { x: s[3], y: s[4], z: s[5], w: s[6] });
  entry._x = s[0]; entry._z = s[2];
}

const RIGID_PARAMS = keysSchema(['gravity', 'terrainRing', 'buoyancy', 'buoyancyForce', 'waterDrag', 'floatLine', 'floatDepth', 'treeColliderHeight', 'treeRadius', 'playerCapsule', 'fallbackFloor']);

/** Real physics module (Rapier). Installs as engine.rigid. Requires collision() to be installed first */
export function rigid(opts = {}) {
  readParams('rigid', RIGID_PARAMS, opts);
  let r = null;
  return {
    name: 'rigid', skipKind: 'none', type: 'world', provides: ['rigid', 'collider3d'], params: RIGID_PARAMS, options: opts, label: 'Physics', noSkip: 'bodies rest while time jumps (stepping seconds of physics would only scatter them)', optional: ['interactions', 'cameraRig', 'characters'], requires: ['collision'],
    install(e, ctx) {
      e.i18n.add(STRINGS); e.i18n.add({ 'zh-CN': { 'module.rigid': '物理引擎' }, en: { 'module.rigid': 'physics' } }); r = new RigidBodies(e, opts);
      r._fall = ctx.rule('fall', false, ['rescue']);   // shared with characters: one rule for everything that falls out of the world; no rescue unless the game chose it
      r._graph = ctx.rule('ragdoll.graph', 'humanoid');
      r._wasm().catch(() => {});   // start loading now (see _wasm); a failure surfaces in init, which awaits the same promise
      ctx.budget.metric('rigidBodies', () => r.bodies.length);
      ctx.stream.addReadyCheck('rigid', s => !s.physics || r.ready && r.readyAt(s));   // a physics stream source waits for the collider under it
      ctx.track(e.rays.addProvider((o, d, far) => r._raycast(o, d, far)));   // engine.raycast(..., { targets: 'all' }) includes rigid bodies
      // a new playthrough / a load is a fresh page for physics too (_fresh), rebuilt once per load: session:end only marks it due. With the world
      // module the rebuild runs on world:load, after the load removed the records' bodies, so the rebuilt world gets them back in view order; without
      // it, afterLoad (newGame / load / quit all apply a save) runs it. Rebuilding on both events built the world twice per new game.
      // A refused load (session:failed) leaves the game as it was, physics included: no afterLoad runs after a rollback, so the state its rigid part read back is claimed here.
      ctx.track(e.events.on('ground:change', b => { r._srcPending = true; restandStatics(r, b); }));   // dug or raised ground: colliders follow on the next step, not at the half-second check a body could fall through
      ctx.track(e.events.on('session:end', () => { r._freshDue = true; }));
      ctx.track(e.events.on('session:failed', () => { r._freshDue = false; r._claimSaved(); }));
      ctx.track(e.events.on('world:load', () => r._fresh()));
      ctx.saves.define('rigid', { notAtomic: 'the physics world is stepped, not written: a load cannot rewind what the bodies did', save: () => r._saveState(), load: d => r._loadState(d) });
      return r;
    },
    afterLoad() { if (r._freshDue) r._fresh(); r._claimSaved(); },   // after every part loaded and _fresh rebuilt the world (world:load is emitted inside the world part's load)
    async init(e, ctx) { await r.init(ctx.signal); ctx.whileCompiling(() => warmRapier(r.rapier)); },
    counts() { return r.bodies.length; },   // engine.counts().rigid
    // bodies by type and what they are doing: sleeping = at rest (normal), frozen = disabled because no terrain collider is under them yet (they wait, not fall)
    describe() {
      const B = r.bodies, n = f => B.filter(f).length;
      return { ready: r.ready, bodies: B.length, dynamic: n(b => !b.fixed), fixed: n(b => b.fixed), sleeping: n(b => b.enabled && b.body.isSleeping()),
        frozen: n(b => !b.enabled), vehicles: r.vehicles.length, colliders: r.world ? r.world.colliders.len() : 0, ...(r._ragdolls?.live.size && { ragdolls: r._ragdolls.live.size }), ...(r._solids.size && { solids: r._solids.size }) };
    },
    fixed(dt) { r.step(dt); },
    // a vehicle lives in this world: its riders get out while the seat and the exit can still be read, or they would read a freed solver every step
    dispose() { for (const v of [...r.vehicles]) r._removeVehicle(v); r._ragdolls?.dispose(); for (const b of [...r.bodies]) r._remove(b); r.world?.free(); r.world = null; },   // every body lets go of its mesh's pose, or a new rigid could not take the same mesh
  };
}

export const handRolled = [{ kind: 'physics', seen: 'a physics library of its own', use: 'rigid(): bodies, joints and vehicles on the engine step, shared with collision and saves (recipe 11)', quiet: /\b(engine|e|eng|ctx)\.rigid\b|\brigid\(\s*[{)]/, raw: /\bfrom\s+['"](?:cannon-es|cannon|ammo\.js|@dimforge\/rapier3d(?:-compat)?|oimo|matter-js)['"]/ }];
