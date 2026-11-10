// What a character stands on (character.support), moving platforms that carry it, the last safe spot (character.safeGround) and falling out of the
// level (fall: { belowY }). Shared by the movers (simple.js, rapier.js, manual), so a platform feels the same with or without physics.
//   const lift = engine.characters.support(liftMesh);          // a box / mesh the player can stand on and ride; move liftMesh any way you like
// Why "record -> compare" and not "the platform tells the riders it moved": the rider remembers the platform's matrixWorld when it lands and, before
// its own move, after every fixed step and once a frame, applies "recorded matrix -> current matrix" to itself and records again. Every bit of platform
// motion is applied exactly once whenever it happened, so the platform may move in the game's onFixed before or after the player, in a timeline
// (frame), or in physics: no order to get right, no one-step lag.
// Why one "moved outside the mover" check here: a teleport guess from distance ("collider more than 0.3 m from the position") is inexact; a
// platform carry, placeAt and a load all move the position outside the mover, so the mover compares with where it left the character (exact).
import * as THREE from 'three';
import { codedError, coded } from '../../../core/base/errorHints.js';
import { DEV, warnOnce } from '../../../core/base/validate.js';
import { placeY, FALL_Y } from '../../../core/scene/ground.js';

const REG = new WeakMap();     // engine -> { list: Map<id, entry>, riders: Set<character> }
const STATE = new WeakMap();   // character -> per-character support state (private: games read character.support / safeGround)
const CARRY = ['position', 'position+yaw'];
const _inv = new THREE.Matrix4(), _d = new THREE.Matrix4(), _v = new THREE.Vector3(), _b = new THREE.Box3(), _m = new THREE.Matrix4();


/** @internal the engine's registered supports and current riders */
export function registry(e) { let r = REG.get(e); if (!r) REG.set(e, r = { list: new Map(), riders: new Set(), n: 0 }); return r; }   // n: generated ids (supports, unnamed characters), per engine

/** @internal per-character state */
export function stateOf(c) {
  let s = STATE.get(c);
  if (!s) STATE.set(c, s = { on: null, m: new THREE.Matrix4(), acc: new THREE.Vector3(), vel: new THREE.Vector3(), inherit: new THREE.Vector2(),
    last: null, fell: false, view: { kind: null, object: null, id: null, safe: true, velocity: { x: 0, y: 0, z: 0 } } });
  return s;
}

/**
 * Register an object characters can stand on and ride (engine.characters.support). Its box is measured once in its own space from its meshes,
 * so scale / rotate / move the object freely afterwards. safe: false = never a respawn spot (a crumbling ledge); carry: 'position+yaw' also turns the
 * rider with a turning platform; inherit: false = a rider jumping off keeps none of the platform's speed.
 * @returns {{ id: string, remove(): void }}
 */
export function addSupport(e, object, { id, safe = true, carry = 'position', inherit = true } = {}) {
  if (!object?.isObject3D) throw codedError('character-option', `characters.support(object): object is a three.js Object3D (a mesh or group) to stand on, got ${object?.constructor?.name ?? typeof object}`);
  if (!CARRY.includes(carry)) throw codedError('character-option', `characters.support(object, { carry }): carry is ${CARRY.map(c => `'${c}'`).join(' or ')}, got ${JSON.stringify(carry)}`);
  const R = registry(e);
  id ??= object.name || `support#${++R.n}`;
  if (R.list.has(id)) throw codedError('character-option', `characters.support(object, { id: '${id}' }): id already used by another support; give each a unique id (saves find the platform by it)`);
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3(), inv = _inv.copy(object.matrixWorld).invert();
  object.traverse(o => {
    const g = /** @type {any} */ (o).geometry; if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(_b.copy(g.boundingBox).applyMatrix4(_m.multiplyMatrices(inv, o.matrixWorld)));
  });
  if (box.isEmpty()) throw codedError('character-option', `characters.support(object '${id}'): it has no mesh to measure; pass a mesh or a group with meshes`);
  // r: the box's reach across x / z from the object's origin, for a quick "nowhere near" test (standAt's quick form)
  const r = Math.max(...[box.min, box.max].flatMap(a => [box.min, box.max].map(b => Math.hypot(a.x, b.z))));
  const entry = { id, object, safe, carry, inherit, box, r };
  R.list.set(id, entry);
  return { id, remove: () => {
    if (R.list.get(id) !== entry) return;
    R.list.delete(id);
    for (const c of [...R.riders]) if (stateOf(c).on === entry) leave(c);
  } };
}

/** Height of entry's top under world (x, z), or null when (x, z) is off it. quick: judge "nowhere near" by the matrix as last refreshed first */
function topAt(entry, x, z, quick) {
  const o = entry.object, b = entry.box;
  if (quick) {
    const el = o.matrixWorld.elements, sc = Math.max(Math.hypot(el[0], el[1], el[2]), Math.hypot(el[8], el[9], el[10]));
    if (Math.hypot(x - el[12], z - el[14]) > entry.r * sc + 1) return null;   // +1 m: it may have moved since the last refresh
  }
  o.updateWorldMatrix(true, false);   // the game moved it this step; matrixWorld is otherwise only refreshed at render
  _v.set(x, 0, z).applyMatrix4(_inv.copy(o.matrixWorld).invert());
  if (_v.x < b.min.x || _v.x > b.max.x || _v.z < b.min.z || _v.z > b.max.z) return null;
  return _v.set(_v.x, b.max.y, _v.z).applyMatrix4(o.matrixWorld).y;
}

/**
 * @internal What stands at (x, z): { y, on } with on the support that won, or null. With a height y: engine.surface plus every registered support whose
 * top is within `step` above y, higher ones are passed under. Without y (undefined): the highest support top, so a placement on a boat at sea stands on
 * the deck and not on the sea floor. y may be -Infinity beyond terrain({ shape }). The one rule for walking, placing and data-only NPCs: one place, one answer.
 * out: the object to fill (a per-frame caller allocates nothing); quick: skip supports far from (x, z) by their last refreshed matrix (feet IK, a picture
 * reader every frame; the movers keep the exact form).
 */
export function standAt(e, x, z, y, step, out = { y: 0, on: null }, quick = false) {
  let h = e.surface(x, z, y), on = null;
  const R = REG.get(e);
  if (R?.list.size) for (const en of R.list.values()) {
    const t = topAt(en, x, z, quick);
    if (t != null && t > h && (y === undefined || t <= y + step + 1e-3)) { h = t; on = en; }
  }
  out.y = h; out.on = on;
  return out;
}

/** @internal Ground height under (x, z) for a character at height y (standAt). Sets the state's `hit` to the support that won (or null) */
export function groundAt(c, x, z, y) {
  const r = standAt(c.engine, x, z, y, c.stepHeight);
  stateOf(c).hit = r.on;
  return r.y;
}

/** @internal standAt for a place-it-here entry: off the ground it fails the way placeY does (dev throws with the fix, release keeps fallback) */
export function placeAtHeight(e, who, x, z, y, step, fallback) {
  const r = standAt(e, x, z, y, step);
  return r.y !== -Infinity ? r : { y: placeY(e, who, x, z, y, fallback), on: null };
}

/**
 * @internal Apply the platform's motion since it was last recorded to its rider and record again. Called before the rider moves, after each fixed
 * step and once a frame (characters module): whatever moved the platform, its motion is applied once. Returns true when it moved the rider.
 */
function carry(c) {
  const s = stateOf(c), on = s.on;
  if (!on) return false;
  const o = on.object; o.updateWorldMatrix(true, false);
  if (s.m.equals(o.matrixWorld)) return false;
  _d.multiplyMatrices(o.matrixWorld, _inv.copy(s.m).invert());   // recorded -> now
  const p = c.root.position;
  _v.copy(p); p.applyMatrix4(_d); s.acc.add(_v.subVectors(p, _v));
  if (on.carry === 'position+yaw') { const el = _d.elements; c.facing += Math.atan2(el[8], el[0]); c.root.rotation.y = c.facing; }
  s.m.copy(o.matrixWorld);
  return true;
}

/** @internal the rider stops riding: keeps the platform's horizontal speed (inherit) until it lands */
function leave(c) {
  const s = stateOf(c);
  if (s.on?.inherit) s.inherit.set(s.vel.x, s.vel.z);
  s.on = null; registry(c.engine).riders.delete(c);
}

/** @internal a teleport (placeAt, fall respawn, load): rides nothing, keeps no platform speed */
export function detach(c) { const s = stateOf(c); if (s.on) registry(c.engine).riders.delete(c); s.on = null; s.inherit.set(0, 0); s.vel.set(0, 0, 0); s.acc.set(0, 0, 0); }

/**
 * @internal Start of a mover step: carry by the platform, then report whether the position moved outside the mover since it last finished
 * (placeAt, a load, a platform, a cutscene): the rapier mover then moves its collider there first.
 */
export function beginMove(c) {
  carry(c);
  const s = stateOf(c), p = c.root.position;
  return !!s.last && (s.last.x !== p.x || s.last.y !== p.y || s.last.z !== p.z);
}

/**
 * @internal End of a mover step: what the character stands on now (hit: the support groundAt picked, or null), its speed, the safe spot and the fall check.
 * kind: 'platform' on a registered support, 'water' swimming, else `ground` ('ground' simple / 'collider' rapier) when grounded, else null.
 */
export function endMove(c, dt, hit, ground = 'ground') {
  const s = stateOf(c), p = c.root.position, R = registry(c.engine);
  s.vel.copy(s.acc).divideScalar(dt > 0 ? dt : 1); s.acc.set(0, 0, 0);
  const now = c.grounded && !c.swimming ? hit : null, landed = !!now && now !== s.on;
  if (now !== s.on) {
    if (s.on) leave(c);
    if (now) { s.on = now; now.object.updateWorldMatrix(true, false); s.m.copy(now.object.matrixWorld); R.riders.add(c); s.inherit.set(0, 0); }
  }
  if (c.grounded || c.swimming) s.inherit.set(0, 0);
  const v = s.view;
  v.kind = c.swimming ? 'water' : s.on ? 'platform' : c.grounded ? ground : null;
  v.object = s.on?.object ?? null; v.id = s.on?.id ?? null; v.safe = s.on ? s.on.safe : v.kind !== 'water';
  v.velocity.x = s.vel.x; v.velocity.y = s.vel.y; v.velocity.z = s.vel.z;
  // safe spot: standing still on something that is not moving and not marked unsafe. Not on the landing step: nothing has carried the rider yet, so a moving platform still reads as speed 0
  if (c.grounded && !c.swimming && v.safe && !landed && s.vel.lengthSq() < 1e-8) (c.safeGround ??= new THREE.Vector3()).copy(p);
  fallCheck(c, s);
  (s.last ??= new THREE.Vector3()).copy(p);
}

/** Dev, once: a player gone past the void with nobody deciding stays gone, which reads as a bug in the game unless something names the choice */
function tellNoFallRule(c) {
  const e = c.engine;
  if (c !== e.player || c.root.position.y >= Math.max(e.ground.voidY?.() ?? -Infinity, FALL_Y)) return;
  const point = e.stacks.get('fall');
  if (point.holders().length + point.holders(c.id).length) return;
  warnOnce(coded('character-option', `the player fell past the void and no rule 'fall' is set, so nothing brings it back. Decide what a fall is: engine.mod('fall', { owner: 'game', set: 'rescue' }) with addPlayer({ fall: { belowY } }) returns it to safeGround, a function is your own rule, and set: false says the game handles it`), 'fall-no-rule');
}

/** belowY: a height or (character) => boolean. character:fall once per fall, then the rule 'fall' decides: 'rescue' goes back to safeGround, nothing or false leaves it to the game */
function fallCheck(c, s) {
  if (DEV) tellNoFallRule(c);
  const f = c.fall;
  if (!f) return;
  const out = typeof f.belowY === 'function' ? !!f.belowY(c) : c.root.position.y < f.belowY;
  if (!out) { s.fell = false; return; }
  if (s.fell) return;   // the rule kept it out there: say it once, not every step
  s.fell = true;
  const safe = c.safeGround ? c.safeGround.clone() : null;
  c.engine.events.emit('character:fall', { character: c, safe });
  if (c.engine.stacks.rule('fall', false, ['rescue']).decide(c.id, { kind: 'character', who: c, position: c.root.position.clone(), safe }) !== 'rescue') return;
  // the exact spot, not placeAt: a platform that was under this spot may have moved away, and placeAt would land on the ground below it
  if (c.safeGround) c.root.position.copy(c.safeGround);
  detach(c); c.velocity.set(0, 0); c.vy = 0; c._push = 0; c.grounded = true;
  s.fell = false;
  c._store();
}

/**
 * @internal Carry every character standing on a support by the support's motion since it was last applied (characters module: fixed and frame
 * hooks). between = outside a fixed step (frame): the record write is allowed explicitly, it only follows motion that already happened.
 */
export function carryRiders(e, between) {
  const R = REG.get(e);
  if (!R?.riders.size) return;
  for (const c of [...R.riders]) {
    if (!carry(c)) continue;
    if (between) e.ops.allow(() => c._store()); else c._store();
  }
}
