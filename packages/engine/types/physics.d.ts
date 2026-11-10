// Collision, real physics, camera.
import type { Object3D, Vector3, DirXZ, Vec3Like, Ease, Handle, PositionLike } from './common';
import type { Engine, ModuleDef } from './core';
import type { Input } from './generated/core/input/Input';
import type { Character } from './gameplay';

// ======================================================================
// Lightweight collision collision() → engine.collision
// ======================================================================

export interface CollisionOptions {
  /** Max walkable slope (height difference / horizontal distance), default 1.1 */
  maxClimb?: number;
  /** A camera above this height (meters) is not considered blocked by trees, default 5 */
  canopyHeight?: number;
  /** Margin between the camera and obstacles (meters), default 0.5 @experimental */
  cameraPad?: number;
  /** Nearest camera distance (meters), default 1.5 */
  cameraMin?: number;
  /** Height above the water surface (meters) at which it counts as walkable, default 0.2 @experimental */
  walkableWaterMargin?: number;
  /** What camera occlusion checks: 'both' (default) | 'colliders' | 'meshes' = static meshes registered with engine.rays.addStatic(mesh, { occluder: true }) */
  cameraOcclusion?: 'colliders' | 'meshes' | 'both';
}
/** Circle collider: center x/z, radius r, height h (meters), occ false when added with occluder: false */
export interface CircleCollider { x: number; z: number; r: number; h: number; occ: boolean; /** its layer option */ ly?: string }
/** Box collider: center x/z, half width hw, half depth hd, rotation around Y rot (radians), height h, bottom height y (meters), occ as in CircleCollider */
export interface BoxCollider { x: number; z: number; hw: number; hd: number; rot: number; h: number; y?: number; occ: boolean; [k: string]: any }

/** Parameters of addCircle() (meters) */
export interface CircleColliderOptions {
  /** Radius, default 0.5 */
  radius?: number;
  /** Height, default 6 */
  height?: number;
  /** false: walkers are still stopped but the follow camera's occlusion check ignores it (forest trunks the camera may pass through). Default true */
  occluder?: boolean;
  /** A name: movers whose passes list names it go through it (walking, paths, navmesh), every other mover is stopped, e.g. a gate only some characters use. Omitted: it stops every mover. Sight lines and the camera ignore it */
  layer?: string;
}
/** Parameters of addBox() (meters, radians) */
export interface BoxColliderOptions {
  /** Half width (X direction), default 1 */
  halfWidth?: number;
  /** Half depth (Z direction), default 1 */
  halfDepth?: number;
  /** Rotation around the Y axis (radians), default 0 */
  rotation?: number;
  /** Height, default 6 */
  height?: number;
  /** Bottom height of the box; if omitted it sits on the ground (give it for walls placed on platforms in a level) */
  y?: number;
  /** false: walkers are still stopped but the follow camera's occlusion check ignores it (forest trunks the camera may pass through). Default true */
  occluder?: boolean;
  /** A name: movers whose passes list names it go through it (walking, paths, navmesh), every other mover is stopped, e.g. a gate only some characters use. Omitted: it stops every mover. Sight lines and the camera ignore it */
  layer?: string;
}

/** engine.collision (lightweight collision: no walking through things, the camera is not blocked). Real physics is a separate module, engine.rigid */
export interface Collision {
  /** @experimental */ maxClimb: number;
  /** @experimental */ canopyHeight: number;
  /** @experimental */ cameraPad: number;
  /** @experimental */ cameraMin: number;
  /** @experimental */ walkableWaterMargin: number;
  /** What camera occlusion checks (see CollisionOptions.cameraOcclusion) @experimental */
  cameraOcclusion: 'colliders' | 'meshes' | 'both';
  /** +1 each time a static collider is added or removed @experimental */
  version: number;
  /** Add a circle collider (pillar, campfire): position is the center, e.g. addCircle(mesh, { radius: 1 }). Returns a handle { remove() } */
  addCircle(position: PositionLike, opts?: CircleColliderOptions): Handle;
  /** Add a box collider (house, fence): position is the center, e.g. addBox(house, { halfWidth: 3, halfDepth: 2, rotation: 0.3 }). Returns a handle { remove() } */
  addBox(position: PositionLike, opts?: BoxColliderOptions): Handle;
  /** Add a thin wall along a -> b (fence). Options: thickness (default 0.3), height, y, occluder, layer (as in addBox). A gap between segments is a gate. Returns a handle { remove() } */
  addSegment(a: PositionLike, b: PositionLike, opts?: { thickness?: number; height?: number; y?: number; occluder?: boolean; layer?: string }): Handle;
  /** Mark ground impassable where fn(x, z) is true (river, lava); fn must be pure (no side effects, same answer for the same (x, z)); reading engine.ground in it is fine. findPathAsync caches the answers, so after the ground or your own state changes, remove() and add the field again. bounds { minX, maxX, minZ, maxZ } (world metres, the field's x / z extent) skips fn outside it; give it to keep findPathAsync's ground sampling cheap. Returns a handle { remove() } */
  addBlocked(fn: (x: number, z: number) => boolean, opts?: { bounds?: { minX: number; maxX: number; minZ: number; maxZ: number } }): Handle;
  /** Is a character of this radius touching addBlocked ground at (x, z) @experimental */
  blockedAt(x: number, z: number, radius?: number): boolean;
  /** Add a collider from an object's bounding box, pad expands outward (meters), occluder and layer as in addBox. Returns a handle { remove() } */
  addObject(obj: Object3D, opts?: { pad?: number; occluder?: boolean; layer?: string }): Handle;
  /** Iterate all static colliders added by hand @experimental */
  forEachStatic(fn: (type: 'box' | 'circle', data: any) => void): void;
  /** Keep an outside copy of the static colliders in step (physics colliders, navmesh obstacles): add builds one piece, remove drops one; sync() diffs only when colliders changed and returns whether it compared; clear() forgets every piece without remove (the outside world was thrown away) @experimental */
  mirror<P>(fns: { add(type: 'box' | 'circle', data: any): P; remove(piece: P, data: any): void }): { sync(): boolean; clear(): void; readonly size: number };
  /** Whether someone can stand at this position (for pathfinding): not in water, not too steep, not inside an obstacle. radius is the character radius (meters, default engine.movement.radius), passes the collider layers it goes through */
  walkable(position: PositionLike, opts?: { radius?: number; passes?: string[] }): boolean;
  /** walkable with plain numbers, allocating nothing (A* inner loops); radius defaults to engine.movement.radius; y picks the floor; passes as in walkable */
  walkableAt(x: number, z: number, radius?: number, y?: number, passes?: readonly string[]): boolean;
  /** Line of sight with height: is the 3D segment a -> b free of boxes, circles and terrain trees? radius fattens the line; addBlocked water is ignored. Give eye heights in a / b */
  lineClear(a: PositionLike, b: PositionLike, opts?: { radius?: number; /** who is looking (names the line in the event trace) */ who?: string }): boolean;
}

// ======================================================================
// Real physics rigid() → engine.rigid
// ======================================================================

export interface RigidOptions {
  /** Gravity (m/s², negative points down), default -9.81 */
  gravity?: number;
  /** How many rings of chunks around the player get terrain colliders, default 1. A body outside them freezes until the player comes near (entry.enabled false, describe().rigid.frozen), because it would fall through the ground: raise this for a car or ball that must keep moving far away */
  terrainRing?: number;
  /** Whether there is buoyancy, default true */
  buoyancy?: boolean;
  /** Buoyancy strength (1 = just floats), default 1.6 @experimental */
  buoyancyForce?: number;
  /** Drag in water, default 2.5 @experimental */
  waterDrag?: number;
  /** Buoyancy "waterline": an object starts floating when its center is this many meters below the water surface, default 0.3 @experimental */
  floatLine?: number;
  /** Buoyancy reaches its maximum this many meters further down, default 0.8 @experimental */
  floatDepth?: number;
  /** Height (meters) of vegetation collision pillars (tree trunks), default 6 @experimental */
  treeColliderHeight?: number;
  /** Trunks get collision cylinders only in chunks within this many meters of the player or a moving rigid body (the rest are covered by engine.collision for characters), default 16 @experimental */
  treeRadius?: number;
  /** Player capsule size (meters), default computed from engine.movement radius / height @experimental */
  playerCapsule?: { halfHeight: number; radius: number };
  /** The flat plane at y = 0 when the ground has no collision of its own, default true. false: only your own bodies and colliders are there (a sky of islands) */
  fallbackFloor?: boolean;
}
/** Parameters for adding a physics body */
export interface RigidBodyOptions {
  /** Stable id (e.g. the world record id): saves keep this body's pose, rotation, velocities and sleep under it, and a load hands them back to the body with this id, also one built after the load. Without an id the body is not saved. Unique among live bodies and vehicles */
  id?: string;
  /** Mass (kilograms), default 1 */
  mass?: number;
  /** Friction, default 0.7 */
  friction?: number;
  /** Restitution 0–1, default 0.1 */
  restitution?: number;
  /** Linear damping, default 0.05 */
  damping?: number;
  /** Angular damping, default 0.1 */
  angularDamping?: number;
  /** Fixed in place (only blocks other things) */
  fixed?: boolean;
}
/** Parameters of addBox() */
export interface RigidBoxOptions extends RigidBodyOptions {
  /** Size [width, height, depth] (meters); if omitted, taken from the model's bounding box */
  size?: number[];
}
/** Parameters of addBall() */
export interface RigidBallOptions extends RigidBodyOptions {
  /** Radius (meters); if omitted, taken from the model's bounding box */
  radius?: number;
}
/** A physics body (the handle returned by addBox / addBall / addHull) */
export interface RigidEntry extends Handle {
  /** The id it was added with (saves name it by this), undefined without one */
  readonly id?: string;
  /** Rapier rigid body (translation(), mass(), setLinvel()…); newGame / a load rebuild the world, so read entry.body again instead of keeping it */
  body: any;
  /** Rapier collider */
  collider: any;
  /** The matching three.js model (position is written by physics every step) */
  mesh: Object3D;
  /** Same as mesh */
  object: Object3D;
  /** Whether it is being simulated: false while it is outside the terrain colliders (rigid({ terrainRing })), where it would fall through the ground */
  enabled: boolean;
  /** Volume (cubic meters, used for buoyancy) */
  volume: number;
  damping: number;
  angularDamping: number;
  wet?: boolean;
  /** Remove this rigid body (the model was passed in by you and is not deleted; call engine.remove(entry.object) when done). Casting / receiving shadows follows the model's own castShadow / receiveShadow */
  remove(): void;
}

/** Options of engine.rigid.ragdoll @experimental */
export interface RagdollOptions {
  /** A push (kg*m/s) on the part nearest position, else on the root part. A hit stronger than the part can take spreads to the whole body, total momentum unchanged */
  impulse?: Vec3Like;
  /** Where the push lands (world) */
  position?: PositionLike;
  /** Humanoid graph only: part -> bone name or bone, over the auto-detection. Parts: hips, chest, head, upperArmL, lowerArmL, upperArmR, lowerArmR, upperLegL, lowerLegL, upperLegR, lowerLegR */
  bones?: Record<string, string | Object3D>;
  /** Part or kind ('lowerLeg', 'upperArm', 'chest', 'head'...) -> [min, max] radians from the bind pose: bend forward (a knee: backward), side, twist along the bone */
  limits?: Record<string, { bend?: [number, number]; side?: [number, number]; twist?: [number, number] }>;
  /** Whole body, kg (default the graph's; humanoid 70). The graph's proportions stay */
  mass?: number;
}

/** One part of a ragdoll graph, the value of the rule 'ragdoll.graph': { body: { bone: 'Spine' }, tail: { bone: 'Tail1', parent: 'body', mass: 2 } } @experimental */
export interface RagdollPart {
  /** Bone name or bone */
  bone: string | Object3D;
  /** The part this one hangs from; its bone must be above this bone. Exactly one part has none: the root, which leads the body */
  parent?: string;
  /** Range of motion, [min, max] radians from the bind pose; default loose (45° bend and side, 30° twist) */
  limits?: { bend?: [number, number]; side?: [number, number]; twist?: [number, number] };
  /** kg; default 70 shared equally */
  mass?: number;
  /** The part this bone points at; default the middle of its child parts, then its first child bone. 'top' measures it from the mesh along up (a head) */
  end?: string;
  /** Which way a positive bend moves the tip, in bind space; default [0, 0, 1] */
  forward?: Vec3Like;
  /** Fallback for forward and the direction of end: 'top'; default [0, 1, 0] */
  up?: Vec3Like;
  /** Name shared by several parts, so one limits entry of rigid.ragdoll covers them ('leg') */
  kind?: string;
}

/** What engine.rigid.ragdoll returns. remove() gives the character back; safe to call twice @experimental */
export interface Ragdoll extends Handle {
  /** False once removed (remove(), a load, the character deleted) */
  readonly active: boolean;
  /** Every part is at rest (asleep or frozen). Nothing is written to the bones then, so a game's own bone write stays */
  readonly settled: boolean;
  /** Part name -> its rigid entry: entry.body for forces, entry.object is the bone; engine.raycast hits carry the same entry. The bones stay plain three.js */
  readonly parts: Record<string, RigidEntry>;
}

/** A hit of Collider3D.sweep */
export interface SweepHit {
  /** The ball's center at the hit */
  point: Vector3;
  /** World direction out of what it hit */
  normal: Vector3;
  /** How far the ball got (meters) */
  distance: number;
}
/** engine.collider3d: collision on all three axes (modules/rigid/collider3d.contract.js). rigid provides it; engine.use(mine(), { replaces: 'collider3d' }) swaps in your own @experimental */
export interface Collider3D {
  /** A fixed solid turned any way. size [x, y, z] for a box or radius for a ball; rotation [x, y, z] radians or a quaternion. Callable before start(); newGame and a load keep it. engine.collision does not know it */
  addSolid(opts: { position: PositionLike; size?: number[]; radius?: number; rotation?: number[] | { x: number; y: number; z: number; w: number }; friction?: number }): Handle;
  /** Is a ball here inside something solid. Skips the player's capsule */
  overlap(position: PositionLike, radius?: number): boolean;
  /** Move a ball from there to there: null when clear, else the first hit. Skips the player's capsule */
  sweep(from: PositionLike, to: PositionLike, radius?: number): SweepHit | null;
}

/** engine.rigid (real physics; bodies can only be added after start(), or in the engine:ready event) */
export interface RigidBodies {
  /** Is the physics engine ready (downloaded and initialized at start()) */
  readonly ready: boolean;
  /** All physics bodies */
  bodies: RigidEntry[];
  gravity: number;
  /** @experimental */ terrainRing: number;
  /** @experimental */ buoyancy: boolean;
  /** @experimental */ buoyancyForce: number;
  /** @experimental */ waterDrag: number;
  /** @experimental */ floatLine: number;
  /** @experimental */ floatDepth: number;
  /** @experimental */ treeColliderHeight: number;
  /** @experimental */ treeRadius: number;
  /** The Rapier library itself: its shape follows the Rapier version @experimental */
  rapier: any;
  /** The Rapier world: its shape follows the Rapier version @experimental */
  world: any;
  /** Add a box (crate). Physics is ready after engine.start() (or on engine:ready): called before, it throws in development, a release build warns once and returns null */
  addBox(mesh: Object3D, opts?: RigidBoxOptions): RigidEntry | null;
  /** Add a ball; null only as in addBox: a release build, called before physics is ready @experimental */
  addBall(mesh: Object3D, opts?: RigidBallOptions): RigidEntry | null;
  /** Add a convex hull (irregular objects such as rocks and barrels); null only as in addBox: a release build, called before physics is ready @experimental */
  addHull(mesh: Object3D, opts?: RigidBodyOptions): RigidEntry | null;
  /**
   * Turn a skinned character limp in one call; rd.remove() returns it to animation. who: a Character, an NPC handle, a character id or a skinned Object3D.
   * Its mover, animator, capsule and camera yield until then; calling again on the same one pushes it again and returns the same ragdoll.
   * Not saved: any load ends it. A skeleton it cannot read throws, naming the missing parts. The rule 'ragdoll.graph' (per character id) gives the parts: 'humanoid' (default),
   * Record<string, RagdollPart> for any other body, a function (facts: { character, root, mesh }, engine) => one of those, or false for no ragdoll (returns null). @experimental
   */
  ragdoll(who: any, opts?: RagdollOptions): Ragdoll | null;
  /** Give it a push: impulse vector impulse (Vector3 / [x, y, z] / { x, y, z }), e.g. impulse(ball, [0, 3, 5]) */
  impulse(entry: RigidEntry, impulse: Vec3Like): void;
  /** Teleport to position (velocity is zeroed) */
  setPosition(entry: RigidEntry, position: PositionLike): void;
  /** The player's Rapier kinematic body and capsule collider (follow the player position every step; used for collision when mover: 'rapier'; the capsule is off while driving) @experimental */
  playerBody: any;
  /** The capsule collider on playerBody @experimental */
  playerCollider: any;
  /** Player capsule size (meters) @experimental */
  playerCapsule: { halfHeight: number; radius: number };
  /** All vehicles @experimental */
  vehicles: Vehicle[];
  /**
   * Turn a model into a wheeled vehicle (Rapier ray-cast vehicle controller: cars, karts, carts); remove it with vehicle.remove() (anyone inside gets out
   * first). Before physics is ready it throws in development (release: warns, null), like addBox. Boats, mounts and mechs are the game's own objects with the same seat interface
   */
  addWheeled(mesh: Object3D, opts: VehicleOptions): Vehicle | null;
  /** Statistics */
  readonly stats: { bodies: number; active: number; colliders: number };
}

// ---------- Vehicles ----------
/** A wheel: position relative to the body (meters), radius (meters), steer can steer, drive is powered, object is the wheel model that spins */
export interface VehicleWheel { position: Vec3Like; radius: number; steer?: boolean; drive?: boolean; object?: Object3D }
/** Parameters of rigid.addWheeled() */
export interface VehicleOptions {
  /** Stable id (default 'vehicle1', 'vehicle2'... in creation order): saves name the player's vehicle and the vehicle's body state by it; give one when the creation order varies */
  id?: string;
  /** Wheels (at least 3) */
  wheels: VehicleWheel[];
  /** Mass (kilograms) */
  mass?: number;
  /** Throttle force, default 800 */
  engineForce?: number;
  /** Brake force, default 20 */
  brakeForce?: number;
  /** Max steering angle (radians), default 0.5 */
  maxSteer?: number;
  /** Suspension: rest natural length (meters), stiffness, damping */
  suspension?: { rest?: number; stiffness?: number; damping?: number };
  /** Seat positions relative to the body (meters): the first drives, the rest ride; each gets out beside its own seat. Default one at the body center */
  seats?: Vec3Like[];
  /** Hide whoever sits in it, default true; false keeps riders visible on their seats, turning with the vehicle (bikes, open carts, karts) */
  hideDriver?: boolean;
  /** Camera distance and height while driving (meters) */
  camera?: { distance?: number; height?: number };
  /** Body collision box size [width, height, depth] (meters); if omitted, taken from the model's bounding box (wheels excluded) */
  size?: number[];
  /** Tire grip, default 1.5 */
  friction?: number;
  /** Distance from the side of the body when getting out (meters), default 0.8 */
  exitOffset?: number;
}
/** A vehicle (returned by rigid.addWheeled, faces the model's +Z). player.enter(vehicle) gets in; with interactions installed, press the interact key nearby to get in / out */
export interface Vehicle extends RigidEntry, Rideable {
  /** Stable id (rigid.addWheeled({ id })); saves name the player's vehicle by it */
  readonly id: string;
  /** Body model (the mesh you passed in) */
  object: Object3D;
  /** Rapier rigid body */
  body: any;
  /** Rapier vehicle controller (DynamicRayCastVehicleController) */
  controller: any;
  wheels: VehicleWheel[];
  seats: number;
  passengers: Character[];
  hideDriver: boolean;
  /** World position of a seat (default 0, the driver's) */
  seatPosition(seat?: number): Vector3;
  /** Where to get out of a seat (outside the door on that seat's side, world coordinates) */
  exitPosition(seat?: number, n?: number): Vector3;
}
/**
 * What character.enter(vehicle) needs from anything it rides (modules/characters/vehicle.contract.js): rigid.addWheeled's car passes it, and so does a
 * game's own boat, horse, mech or lift built on three.js or another physics library.
 */
export interface Rideable {
  /** Stable id when saves should put the player back in it (rigid vehicles have one) */
  readonly id?: string;
  /** What the camera follows while driving */
  object: Object3D;
  /** Current speed (m/s): the driver's moveAmount (animation, describe) */
  readonly speed: number;
  /** Who is driving (null if nobody); character.enter / exit set it */
  driver: Character | null;
  /** Number of seats, driver included (default 1); enter takes the driver seat, else the first free passenger seat */
  seats?: number;
  /** Who rides in the other seats (enter creates the list when missing) */
  passengers?: Character[];
  /** false keeps riders visible on their seats (bikes, open carts); default hidden */
  hideDriver?: boolean;
  /** Camera parameters while driving */
  camera?: { distance?: number; height?: number };
  /** Controls, called every fixed step while driven: throttle -1..1, steer -1..1 (right is positive), brake 0–1; exit calls drive(0, 0, 1) */
  drive(throttle: number, steer: number, brake?: number): void;
  /** World position of a seat (default 0, the driver's; a rider is kept there) */
  seatPosition(seat?: number): Vector3 | Vec3Like;
  /** Where to get out of a seat (world coordinates; rigid cars: outside the door on that seat's side) */
  exitPosition(seat?: number, n?: number): Vector3 | Vec3Like;
}

// ======================================================================
// Skeletal animation state machine Animator (returned by engine.assets.animate)
// ======================================================================

/** An animation state: clip is the clip name; or blend is a blend tree (blends several clips by the param parameter); loop: false is a one-shot clip */
export interface AnimatorState {
  /** Clip name (the clip name in the glTF) */
  clip?: string;
  /** Blend tree: at the parameter value at it is fully this clip, in between they blend proportionally, e.g. [{ clip: 'Walk', at: 1.5 }, { clip: 'Run', at: 6 }] */
  blend?: { clip: string; at: number }[];
  /** Which parameter the blend tree reads (set by anim.set), default 'speed' */
  param?: string;
  /** Align the strides of blended clips, default true */
  sync?: boolean;
  /** Loop, default true; with false the anim:end event fires when it finishes */
  loop?: boolean;
  /** Which state a one-shot clip goes to when it finishes */
  then?: string;
  /** go() cannot interrupt it while playing */
  lock?: boolean;
  /**
   * For sync(): gameplay seconds -> clip seconds. A number = the gameplay length the whole clip is stretched over;
   * [[gameT, clipT], ...] = piecewise linear (land the swing on the hit phase). Without it clip seconds = t
   */
  timing?: number | [number, number][];
}
/** What an Animator is showing (anim.describe(), describe().player.anim) */
export interface AnimatorInfo {
  state: string | null;
  /** Clip name as written in the state */
  clip: string | null;
  /** Clip seconds */
  time: number;
  /** 0-1 through the clip */
  progress: number;
  /** true while sync() drives it */
  driven: boolean;
  /** Last gameplay t passed to sync (only while driven) */
  t?: number;
  /** Share of each fading state (sums to 1) */
  weights: Record<string, number>;
}
/** Animation state machine parameters */
export interface AnimatorOptions {
  /** Default transition seconds, default 0.25 (characters({ animation: { fade } }) for every character) */
  fade?: number;
  /** States: name → state */
  states?: Record<string, AnimatorState>;
  /** Transition seconds for specific pairs: { 'jump>fall': 0.1, '*>idle': 0.3 } */
  transitions?: Record<string, number>;
  /** Initial parameter values */
  params?: Record<string, number>;
}
/** Where a look-at layer looks: an object, a point, [x, y, z] (exactly three numbers, as ik.js checks), or null to look ahead */
export type AimTarget = Object3D | Vector3 | [number, number, number] | null;
/** What an IK layer reports (anim.addAim / addFeet handles) */
export interface IkLayerInfo { kind: string; bones: string[]; weight: number }
/** A look-at layer (anim.addAim): set() takes what addAim took except bones and forward, which are fixed when it is made; remove() puts the pose back at once */
export interface AimLayer {
  set(opts: { target?: AimTarget; limit?: number; speed?: number; weight?: number; fade?: number }): AimLayer;
  remove(): void;
  describe(): IkLayerInfo;
}
/** A feet layer (anim.addFeet): set() takes what addFeet took except legs and hips, which are fixed when it is made; remove() puts the pose back at once */
export interface FeetLayer {
  set(opts: { reach?: number; far?: number; speed?: number; weight?: number; fade?: number; ground?: (x: number, z: number, y: number) => number }): FeetLayer;
  remove(): void;
  describe(): IkLayerInfo;
}
/** Skeletal animation state machine (returned by engine.assets.animate(model, config)) */
export declare class Animator {
  constructor(engine: Engine, root: Object3D, opts?: AnimatorOptions);
  /** The animated object */
  root: Object3D;
  /** three.js AnimationMixer */
  mixer: any;
  /** clip name → three.js AnimationAction */
  actions: Map<string, any>;
  /** Current state name */
  state: string | null;
  /** State configuration (states can be added directly) */
  states: Record<string, AnimatorState>;
  /** Parameters (used by blend trees) */
  params: Record<string, number>;
  /** Set a parameter, e.g. set('speed', 3) */
  set(param: string, value: number): this;
  /** Switch to a state ({ fade }: transition seconds); null (dev warning) if there is no such state / clip; ignored while sync() drives a state */
  go(state: string, opts?: { fade?: number }): any;
  /** One-shot clip: state name or clip name, returns to then or the previous state when done; go() cannot interrupt it while playing */
  action(name: string, opts?: { fade?: number }): any;
  /**
   * Gameplay drives the clock: show state at gameplay time t (fixed-step seconds) through its timing.
   * The clip never advances or ends by itself and go() leaves it alone; sync(null) hands control back
   */
  sync(state: string | null, t?: number): any;
  /** What is showing: state, clip, clip time, progress, driven, weights */
  describe(): AnimatorInfo;
  /**
   * Check the mapping against the action names the game plays: each problem as text with its fix ([] = all will play).
   * @example anim.check(['idle', 'walk', 'attack', 'hurt'])
   */
  check(actions?: string[]): string[];
  /**
   * Look-at IK, the last layer on the clips: a bone or a chain from the body out turns toward target, within limit degrees of the animated pose.
   * Weight 0 leaves the pose exactly; target null looks ahead; forward: the last bone's own front axis when the bind pose does not say (recipe 13 §3e)
   * @example const look = npc.anim.addAim({ bones: ['Neck', 'Head'], target: engine.player.root, limit: 70 });
   */
  addAim(opts: { bones: string | string[]; target?: AimTarget; limit?: number; speed?: number; weight?: number; fade?: number; forward?: [number, number, number] }): AimLayer;
  /**
   * Feet on the ground: each [upper, lower, foot] leg bends onto the model's own ground (a Character's includes platforms; off while it jumps or swims,
   * beyond far from the camera, while hidden); the hips lower for the foot that reaches down. legs: bone names when they are not recognised
   * @example const feet = engine.player.anim.addFeet();
   */
  addFeet(opts?: { legs?: string[][]; hips?: string; reach?: number; far?: number; speed?: number; weight?: number; fade?: number; ground?: (x: number, z: number, y: number) => number }): FeetLayer;
  /** Stop the per-frame update when no longer needed */
  dispose(): void;
}

// ======================================================================
// Camera → engine.cameraRig (install one kind, switch at runtime with engine.setCamera)
// ======================================================================

/** Camera kinds: 'follow' third person | 'firstPerson' first person | 'fixed' fixed shot | 'rts' strategy top-down */
export type CameraKind = 'follow' | 'firstPerson' | 'fixed' | 'rts';

/** Interface shared by all cameras */
export interface CameraRigBase {
  /** Current kind (the first argument of engine.setCamera) */
  kind: CameraKind;
  /** The object being followed */
  target: Object3D | null;
  /** The pixelSnap option at work, or null: grid (give it to pixelSprite), error (last rounding in art pixels), agrees (false: something else set the view height, rounding stopped) */
  pixelSnap?: { readonly grid: import('./pixel').PixelGrid; readonly error: { x: number; y: number }; readonly agrees: boolean; bounds: import('./pixel').PixelBounds | null } | null;
  /** Follow someone (called automatically when the player is created), null to cancel. opts temporarily changes distance / height (used while driving), restored when the target changes */
  follow(obj: Object3D | null, opts?: { distance?: number; height?: number }): void;
  /** The "forward" direction on the horizontal plane (player movement is relative to it) */
  forward(): DirXZ;
  /** The "right" direction on the horizontal plane */
  right(): DirXZ;
  /** Where the world loads around (the followed object's position, else the camera's) */
  focusPoint(): Vector3;
  /** Screen coordinates (-1..1, engine.input.pointer.ndcX / ndcY) → the point on the ground under it, null if nothing is hit (every camera kind) */
  screenToGround(ndcX: number, ndcY: number): Vector3 | null;
  /** Update the camera every frame */
  update(dt: number, input: Input): void;
  /** Called when a cutscene takeover starts / ends */
  onOverride?(on: boolean): void;
  /** Called when this camera is switched in (switched: switched at runtime) */
  onEnter?(switched?: boolean): void;
  /** Called when this camera is switched out */
  onExit?(): void;
}

export interface FollowCameraOptions {
  /** 'orthographic' draws without perspective (isometric / 2.5D; the wheel then changes size); default 'perspective' */
  projection?: 'perspective' | 'orthographic';
  /** With projection 'orthographic': world units of view height, default 20 */
  size?: number;
  /** Which side of the focus the camera sits on (radians), default 0.8: camera = focus + (sin yaw, cos yaw) × distance, it looks along forward() = -(sin yaw, cos yaw). Behind a character facing f: yaw = f + PI */
  yaw?: number;
  /** Pitch angle (radians), default 0.42. Positive = camera above the look point, looking down: the opposite of firstPersonCamera's pitch */
  pitch?: number;
  /** Distance (meters), default 13 */
  distance?: number;
  /** Zoom range (meters) */
  minDistance?: number;
  maxDistance?: number;
  /** How high above the character to look at (meters), default 1.4 */
  height?: number;
  /** Follow smoothing, default 10 @experimental */
  smoothing?: number;
  /** Drag sensitivity, default 1 */
  sensitivity?: number;
  /** Pitch range (radians), default 0.05 to 1.35. The camera never goes below the look point, so the view cannot look up (a tall building's roof stays out of sight); a negative minPitch looks up (recipe 21 section 4b) */
  minPitch?: number;
  /** Upper pitch limit (looking down), default 1.35 (about 77 degrees, not straight down) @experimental */ maxPitch?: number;
  /** Zoom ratio per wheel notch, default 0.1 @experimental */
  zoomStep?: number;
  /** Minimum camera height above the ground (meters), default 1.2 @experimental */
  groundClearance?: number;
  /** Invert vertical @experimental */
  invertY?: boolean;
  /** Lock the pitch angle (top-down games) */
  lockPitch?: boolean;
  /** Over-the-shoulder offset: meters to the right of the target the camera aims (negative = left shoulder), default 0 */
  shoulder?: number;
  /** Click locks the mouse; mouse motion turns the view without dragging (Esc releases), default false */
  pointerLock?: boolean;
  /** The press that locks the mouse is not delivered as Mouse0 / a click (default true); false delivers it too */
  swallowLockClick?: boolean;
  /**
   * What happens when the camera would go below the ground. 'raise': lift it (the view direction changes, so you cannot look up from flat ground);
   * 'shorten': pull it along the arm toward the look point (the view direction is kept, a negative minPitch really looks up); 'none': leave it;
   * a function gets the facts and returns the camera position (or null to keep it). Default: 'shorten' when minPitch < 0, else 'raise'
   */
  ground?: 'raise' | 'shorten' | 'none' | ((facts: FollowCameraGroundFacts) => Vec3Like | null | void);
  /** false: the built-in mouse / stick look and wheel zoom are off, the game drives the view with setView() (default true) */
  mouseLook?: boolean;
  /** Hide the followed object from the camera when the camera is closer than this to the look point (meters, 0 = never; default 0.9). The shadow stays */
  hideTargetNear?: number;
  /** Layer used to hide the followed object (0-31), default 30 */
  hideLayer?: number;
  /** Art-pixel rounding, orthographic only: rounds the camera on screen axes, clamps to bounds there first, and decides the view height (buffer height / pixelsPerMeter), so no size with it. Recipe 62 section 4b */
  pixelSnap?: { pixelsPerMeter: number; bounds?: import('./pixel').PixelBounds | null };
}
/** What a followCamera({ ground: fn }) function receives each frame */
export interface FollowCameraGroundFacts {
  /** Camera position after wall avoidance (a copy) */
  position: Vector3;
  /** The point the camera looks at (target + height + shoulder) */
  lookPoint: Vector3;
  /** Unit arm direction, look point -> camera */
  dir: Vec3Like;
  /** Arm length after walls (m); distance is the wanted one */
  arm: number;
  distance: number;
  /** Ground height under the camera, groundClearance, and a ground query (x, z) => height */
  groundY: number;
  clearance: number;
  surface(x: number, z: number): number;
  rig: FollowCamera;
}
/** followCamera getView() */
export interface FollowCameraView {
  yaw: number;
  /** Positive = camera above the look point looking down; negative = looking up */
  pitch: number;
  /** Wanted distance; arm is the actual one this frame (after walls and ground) */
  distance: number;
  arm: number;
  lookPoint: Vec3Like;
  /** Unit 3D direction the camera looks along */
  look: Vec3Like;
}
/** Third-person follow camera */
export interface FollowCamera extends CameraRigBase, Required<Omit<FollowCameraOptions, 'lockPitch' | 'pixelSnap'>> {
  /** Smoothed follow point */
  focus: Vector3;
  lockPitch?: boolean;
  /** false: no occlusion handling */
  avoidOcclusion?: boolean;
  /** Lock-on framing set by frame() */
  framing: { target: Object3D | Vec3Like; strength: number } | null;
  /** Lock-on framing: turn yaw each frame toward "behind the followed object, looking at target"; mouse yaw is ignored meanwhile; null hands yaw back. strength default 6 (1/s) */
  frame(target: Object3D | Vec3Like | null, opts?: { strength?: number }): void;
  /** Set the view from game code: pitch is clamped to minPitch..maxPitch, distance to the zoom range. Negative pitch looks up. Pair with mouseLook: false to own it every frame */
  setView(view: { yaw?: number; pitch?: number; distance?: number }): this;
  /** The current view: angles, wanted / actual arm, look point and 3D look direction */
  getView(): FollowCameraView;
  /** Actual arm length last frame (after walls and ground), meters */
  readonly arm: number;
}

export interface FirstPersonCameraOptions {
  /** Eye height above the feet (meters), default 1.6 */
  height?: number;
  /** Mouse sensitivity, default 1 */
  sensitivity?: number;
  /** Field of view (degrees); unchanged if omitted */
  fov?: number | null;
  /** Walking bob amplitude (meters), 0 off, default 0.04 */
  headBob?: number;
  /** Bobs per meter @experimental */
  bobFrequency?: number;
  /** Hide the character itself (its shadow remains), default true @experimental */
  hideTarget?: boolean;
  /** Layer number used for hiding 0–31 */
  hideLayer?: number;
  /** Click to lock the mouse, default true */
  pointerLock?: boolean;
  /** The press that locks the mouse is not delivered as Mouse0 / a click (default true); false delivers it too */
  swallowLockClick?: boolean;
  /** Initial heading (radians) */
  yaw?: number;
  /** Initial look angle (radians), default 0 = level. Positive looks up, negative down: the opposite of followCamera's pitch */
  pitch?: number;
  /** Look down / up limit (radians), default -1.45 / 1.45 */
  minPitch?: number;
  /** @experimental */ maxPitch?: number;
  /** Turn range left / right [min, max] (radians), unlimited by default @experimental */
  yawLimits?: number[] | null;
  /** Smoothing of the camera following the body @experimental */
  smoothing?: number;
  /** Invert vertical @experimental */
  invertY?: boolean;
}
/** First-person camera */
export interface FirstPersonCamera extends CameraRigBase, Required<Omit<FirstPersonCameraOptions, 'fov'>> {
  /** Eye position */
  eye: Vector3;
  /** Turn toward a world position (Vector3 / object / [x, y, z] / { x, y, z }) */
  lookAt(position: PositionLike): void;
}

/** Fixed shot */
export interface CameraShot {
  /** Camera position */
  position: Vec3Like;
  /** Fixed point to look at (if omitted, it turns its head with the player) */
  lookAt?: Vec3Like;
  /** Turn its head with the player */
  track?: boolean;
  /** Field of view (degrees) */
  fov?: number;
  /** Position used to judge the "nearest shot", defaults to position */
  at?: Vec3Like;
  /** How high above the character to look at (meters) */
  trackHeight?: number;
  /** 'orthographic' draws this shot without perspective (isometric / 2.5D); default 'perspective' */
  projection?: 'perspective' | 'orthographic';
  /** With projection 'orthographic' (required there): world units of view height; the width follows the aspect */
  size?: number;
}
/** fixedCamera / setCamera('fixed', ...) options; the shot fields (position, lookAt, projection, size...) at the top level are a one-shot form: shots = { main: them } */
export interface FixedCameraOptions extends Partial<CameraShot> {
  /** Art-pixel rounding, orthographic only: rounds the camera on screen axes, clamps to bounds there first, and decides the view height (buffer height / pixelsPerMeter), so no size with it. Recipe 62 section 4b */
  pixelSnap?: { pixelsPerMeter: number; bounds?: import('./pixel').PixelBounds | null };
  /** Shots: name → shot */
  shots?: Record<string, CameraShot>;
  /** Initial shot name */
  start?: string | null;
  /** Automatic switching: false | 'nearest' (pick the one nearest to the player) */
  auto?: false | 'nearest';
  /** Check interval for automatic switching (seconds) @experimental */
  autoInterval?: number;
  /** How many meters closer a new shot must be to switch (prevents flipping back and forth) */
  hysteresis?: number;
  /** Transition seconds for trigger-zone switches (0 = hard cut) @experimental */
  triggerBlend?: number;
  /** How high above the character a track shot looks (meters) @experimental */
  trackHeight?: number;
  /** Head-follow smoothing @experimental */
  trackSmoothing?: number;
  /** Keep the direction when switching shots until the direction key is released @experimental */
  holdDirection?: boolean;
  /** Transition easing */
  ease?: Ease;
}
/** Fixed-shot camera */
export interface FixedCamera extends CameraRigBase {
  /** All shots. A shot stays where it was placed: for a view that pans at a fixed angle use followCamera({ mouseLook: false }) (recipe 21 section 6) */
  shots: Record<string, any>;
  /** Current shot name */
  current: string | null;
  auto: false | 'nearest';
  autoInterval: number;
  hysteresis: number;
  triggerBlend: number;
  trackHeight: number;
  trackSmoothing: number;
  holdDirection: boolean;
  ease: Ease;
  /** Add / replace a shot */
  add(name: string, shot: CameraShot): this;
  /** Cut to a shot immediately */
  cut(name: string): void;
  /** Transition smoothly to a shot ({ seconds = 1, ease }); the Promise resolves when done */
  blend(name: string, opts?: { seconds?: number; ease?: Ease }): Promise<void>;
  /** Name of the shot nearest to a point */
  nearest(p: Vector3): string | null;
}

export interface RtsCameraOptions {
  /** Camera height above the focus (meters), default 30 */
  height?: number;
  /** Zoom range (meters) */
  minHeight?: number;
  maxHeight?: number;
  /** Pitch down angle (radians, π/2 = straight down), default 0.95 */
  pitch?: number;
  /** Initial horizontal heading (radians) */
  yaw?: number;
  /** Pan speed multiplier @experimental */
  panSpeed?: number;
  /** Drag with the mouse to pan, default true @experimental */
  dragPan?: boolean;
  /** Pan at the screen edge, default false @experimental */
  edgePan?: boolean;
  /** Edge width (fraction of the screen) @experimental */
  edgeSize?: number;
  /** Focus range (meters) */
  bounds?: { minX?: number; maxX?: number; minZ?: number; maxZ?: number } | null;
  /** false: no turning. Default true: declares the actions rotateLeft / rotateRight (no keys; presets.bindings.rtsRotate binds Q / R) */
  rotate?: boolean;
  /** Rotation speed (radians/second) @experimental */
  rotateSpeed?: number;
  /** Zoom ratio per wheel notch @experimental */
  zoomStep?: number;
  /** Smoothing @experimental */
  smoothing?: number;
  /** Field of view (degrees); unchanged if omitted */
  fov?: number | null;
  /** Manual panning is not allowed while following @experimental */
  followLock?: boolean;
  /** Initial focus (position) */
  start?: PositionLike | null;
}
/** Strategy top-down camera */
export interface RtsCamera extends CameraRigBase, Required<Omit<RtsCameraOptions, 'rotate' | 'fov' | 'start'>> {
  /** Is it following target */
  following: boolean;
  /** Focus (on the ground) */
  focus: Vector3;
  /** Can it rotate */
  rotate: boolean;
  /** Move the view to position (instant: true skips smoothing) */
  moveTo(position: PositionLike, opts?: { instant?: boolean }): void;
}

/**
 * engine.cameraRig: one of four cameras. The shared methods (follow, forward, right) always work;
 * properties specific to one camera (distance, cut(), moveTo()…) only exist when that camera is installed.
 */
export type CameraRig = CameraRigBase
  & Partial<Omit<FollowCamera, keyof CameraRigBase>>
  & Partial<Omit<FirstPersonCamera, keyof CameraRigBase | 'height' | 'smoothing'>>
  & Partial<Omit<FixedCamera, keyof CameraRigBase | 'trackHeight' | 'add' | 'ease' | 'auto'>>
  & Partial<Omit<RtsCamera, keyof CameraRigBase | 'height' | 'smoothing' | 'focus'>>
  & {
    /** Fixed shot: add a shot */
    add?(name: string, shot: CameraShot): any;
    ease?: Ease;
    auto?: false | 'nearest';
  };

/** Fixed-shot switch event */
export interface CameraShotEvent { name: string }

export type CameraModule = ModuleDef<CameraRig>;
