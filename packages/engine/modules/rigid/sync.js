// Colliders the rigid module keeps in sync with what the game draws: terrain chunks (trimesh + trunk cylinders), trunks on a level or code-built ground, the
// collision module's houses / pillars, and a level's static ground. Each function takes the RigidBodies instance as `r` and is called from its step().
import * as THREE from 'three';

// Chunks around physics stream sources ([cx, cz, rings] each): terrain uses triangle-mesh colliders (identical to what is drawn), vegetation uses cylinders.
// Data comes from the ground API ground.chunkCollision
// Building a trimesh costs a few ms and the broadphase pays again on the next world step; a whole new ring (9 chunks, or after a teleport) in one fixed step
// was the worst frame of streaming. So once playing, the chunk under the source is built at once and the others go CHUNKS_PER_STEP per step, nearest first.
// Returns true while chunks are still waiting, so the caller syncs again on the next step instead of after 0.5 s.
const CHUNKS_PER_STEP = 1;
export function syncTerrain(r, src) {
  const e = r.engine, R = r.rapier, want = new Set(), todo = [];
  for (const [pcx, pcz, n] of src) for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
    const cx = pcx + dx, cz = pcz + dz, key = cx + ',' + cz; if (want.has(key)) continue; want.add(key);
    todo.push({ cx, cz, key, d: Math.max(Math.abs(dx), Math.abs(dz)) });
  }
  todo.sort((a, b) => a.d - b.d);
  let built = 0, pending = false;
  for (const { cx, cz, key, d } of todo) {
    const have = r.terrain.get(key);
    const data = e.ground.chunkCollision(cx, cz);
    if (have?.ready && data && have.token === data.token) continue;
    if (data && d > 0 && e.ready && built >= CHUNKS_PER_STEP) { pending = true; continue; }   // keeps the old collider until its turn
    if (have) dropTerrain(r, key);
    if (data && d > 0) built++;
    if (!data) { r.terrain.set(key, { ready: false, colliders: [] }); continue; }
    // a chunk wholly in the void (terrain({ shape })) has no triangles: nothing to collide with, and Rapier rejects an empty trimesh
    if (!data.positions.length) { r.terrain.set(key, { ready: true, token: data.token, colliders: [] }); continue; }
    const t0 = performance.now();   // measure: the 'collider' stage of engine.budget.cost
    const idx = new Uint32Array(data.positions.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i;
    const ground = R.ColliderDesc.trimesh(new Float32Array(data.positions), idx).setTranslation(data.ox, 0, data.oz).setFriction(0.9);
    const colliders = [r.world.createCollider(ground)];
    r.terrain.set(key, { ready: true, token: data.token, colliders });
    e.budget.cost.end('collider', t0);
  }
  for (const key of [...r.terrain.keys()]) if (!want.has(key)) { dropTerrain(r, key); dropTrees(r, key); }
  return pending;
}

// Trunk cylinders are not part of a chunk's terrain collider: only chunks near something that can hit them have them (the player and every non-fixed body,
// r.treeRadius), because hundreds of resident static cylinders cost world.step time while character collision never reads them (the Collision grid does).
// Same numeric budget as terrain (TREES_PER_STEP chunks per fixed step, never wall-clock, so replays agree), except chunks right at an anchor (URGENT):
// a body must never reach a trunk that has no collider yet. Dropped only beyond treeRadius + TREE_KEEP, so a body on the border does not thrash.
const TREES_PER_STEP = 1, URGENT = 4, TREE_KEEP = 8;
// r._anchors = [x, z, ...] of the player and each non-fixed body (a body's _x / _z were noted by the step loop or setPosition)
function anchors(r, focus) {
  const a = r._anchors; a.length = 0;
  a.push(focus.x, focus.z);
  for (const b of r.bodies) if (!b.fixed) a.push(b._x, b._z);
  return a;
}
/** Did the chunks any anchor needs change since the last call (compared in place, runs every fixed step) */
export function treesChanged(r, focus, CH) {
  const a = anchors(r, focus), m = r._treeMemo, R = r.treeRadius;
  let same = m.length === a.length * 4, k = 0;
  for (let i = 0; i < a.length; i++, k += 4) {
    if (span(m, k, a[i], R, CH)) same = false;
    if (span(m, k + 2, a[i], URGENT, CH)) same = false;
  }
  m.length = k;
  return !same;
}
// chunk span of [c - d, c + d] stored at m[k], m[k + 1]; true when it changed
function span(m, k, c, d, CH) {
  const lo = Math.floor((c - d) / CH), hi = Math.floor((c + d) / CH);
  if (m[k] === lo && m[k + 1] === hi) return false;
  m[k] = lo; m[k + 1] = hi; return true;
}
/** Chunks whose Chebyshev distance to (x, z) is <= d: callback fn(cx, cz, dist) for each */
function nearChunks(x, z, d, CH, fn) {
  for (let cz = Math.floor((z - d) / CH); cz <= Math.floor((z + d) / CH); cz++) for (let cx = Math.floor((x - d) / CH); cx <= Math.floor((x + d) / CH); cx++) {
    fn(cx, cz, Math.max(Math.max(cx * CH - x, x - (cx + 1) * CH, 0), Math.max(cz * CH - z, z - (cz + 1) * CH, 0)));
  }
}
/** Build / drop trunk cylinders for the chunks near the anchors (only where the terrain collider is already built). Returns true while chunks are still queued */
export function syncTrees(r, focus, CH) {
  const e = r.engine, R = r.rapier, a = anchors(r, focus), want = new Map(), keep = new Set();
  for (let i = 0; i < a.length; i += 2) {
    nearChunks(a[i], a[i + 1], r.treeRadius + TREE_KEEP, CH, (cx, cz, d) => {
      const key = cx + ',' + cz; keep.add(key);
      if (d > r.treeRadius || !r.terrain.get(key)?.ready) return;
      const w = want.get(key);
      if (!w) want.set(key, { cx, cz, key, d });
      else if (d < w.d) w.d = d;
    });
  }
  const todo = [...want.values()].sort((p, q) => p.d - q.d);
  let built = 0, pending = false;
  for (const { cx, cz, key, d } of todo) {
    const have = r.trees.get(key), data = e.ground.chunkCollision(cx, cz);
    // both tokens: the ground changing moves trunk heights, the tree circles changing (density, a felled tree) changes which trunks exist
    if (!data || have?.token === data.token && have?.trees === data.treeToken) continue;
    const urgent = d <= URGENT || !e.ready;
    if (!urgent && built >= TREES_PER_STEP) { pending = true; continue; }   // keeps the old cylinders until its turn
    if (have) dropTrees(r, key);
    if (!urgent) built++;
    const colliders = [], half = r.treeColliderHeight / 2;
    for (const k of data.circles) for (let i = 0; i < k.length; i += 3) {
      const h = e.surface(k[i], k[i + 1]);
      colliders.push(r.world.createCollider(R.ColliderDesc.cylinder(half, k[i + 2]).setTranslation(k[i], h + half, k[i + 1])));
    }
    r.trees.set(key, { token: data.token, trees: data.treeToken, colliders });
  }
  for (const key of [...r.trees.keys()]) if (!keep.has(key)) dropTrees(r, key);
  return pending;
}
function dropTrees(r, key) {
  const t = r.trees.get(key);
  if (t) for (const c of t.colliders) r.world.removeCollider(c, false);
  r.trees.delete(key);
}
// Vegetation on a level model or code-built ground has no chunked collision: its trunks reach us only as circles through
// ground.forEachCollider (the same source character collision and path planning read). Make them cylinders around the physics sources
export function syncGroundTrees(r, src, CH) {
  const e = r.engine, G = e.ground, R = r.rapier, half = r.treeColliderHeight / 2, want = new Set();
  if (G.forEachCollider) for (const [pcx, pcz, n] of src) {
    G.forEachCollider((pcx + 0.5) * CH, (pcz + 0.5) * CH, (n + 0.5) * CH * Math.SQRT2, (x, z, rad) => {
      const key = x + ',' + z + ',' + rad;
      want.add(key);
      if (r.groundTrees.has(key)) return;
      const h = e.surface(x, z);
      r.groundTrees.set(key, r.world.createCollider(R.ColliderDesc.cylinder(half, rad).setTranslation(x, h + half, z)));
    });
  }
  for (const [key, col] of r.groundTrees) if (!want.has(key)) { r.world.removeCollider(col, false); r.groundTrees.delete(key); }
}
function dropTerrain(r, key) {
  const t = r.terrain.get(key);
  if (t) for (const c of t.colliders) r.world.removeCollider(c, false);
  r.terrain.delete(key);
}
// Chunk copies of a ground source that left: terrain and trunks are copies of the ground too, and nothing else asks for them once chunkCollision is gone. Answers whether any went.
export function dropChunks(r) {
  if (r.engine.ground.chunkCollision || !(r.terrain.size || r.trees.size)) return false;
  for (const key of [...r.terrain.keys()]) dropTerrain(r, key);
  for (const key of [...r.trees.keys()]) dropTrees(r, key);
  return true;
}
// Houses and pillars from the collision module, as physics colliders: engine.collision.mirror does the add / remove diff (shared with nav), this
// only says how one collider is built and dropped. Built lazily: the mirror lives on the collision module, which rigid requires. A mirror knows one module, so another
// collision module (replaces) drops the old colliders and starts a new mirror. Answers whether a collider changed.
const UP = new THREE.Vector3(0, 1, 0), Q = new THREE.Quaternion();
export function syncStatics(r) {
  r._collision.sync(() => { r._statics?.clear(true); r._statics = null; });
  r._statics ??= r.engine.collision?.mirror({
    add(type, o) {
      const R = r.rapier, g = o.y ?? r.engine.surface(o.x, o.z);
      Q.setFromAxisAngle(UP, o.rot ?? 0);
      const shape = type === 'box' ? R.ColliderDesc.cuboid(o.hw, o.h / 2, o.hd).setRotation({ x: Q.x, y: Q.y, z: Q.z, w: Q.w }) : R.ColliderDesc.cylinder(o.h / 2, o.r);
      const c = r.world.createCollider(shape.setTranslation(o.x, g + o.h / 2, o.z));
      if (o.y == null) r._onGround.set(o, c);
      if (o.ly !== undefined) r._layered.set(c, o);
      return c;
    },
    remove(c, o) { r._onGround.delete(o); r._layered.delete(c); r.world.removeCollider(c, false); },
  }) ?? null;
  return !!r._statics?.sync();
}

/** The ground moved under a world box: a collider that stands on the ground, one with no y of its own, stands on what is there now. Mirror data keeps no height, so nothing else would tell it. No area: all of them */
export function restandStatics(r, { x0 = -Infinity, z0 = -Infinity, x1 = Infinity, z1 = Infinity } = {}) {
  for (const [o, c] of r._onGround) if (o.x + o.r >= x0 && o.x - o.r <= x1 && o.z + o.r >= z0 && o.z - o.r <= z1) { c.setTranslation({ x: o.x, y: r.engine.surface(o.x, o.z) + o.h / 2, z: o.z }); r._behind = true; }
}

// Ground of a level (hand-built scene): one static triangle mesh, rebuilt when the level changes. The provider's staticTrimeshes names the source
// (engine.ground itself is a fresh object whenever a collider source joins, and that alone must not rebuild it). A new ground of any kind stands the world boxes on it again:
// a level at another height sends no ground:change. Answers whether the triangles changed.
export function syncLevel(r) {
  r._standOn.sync(() => restandStatics(r));
  return !!r._level.sync(() => {
    const G = r.engine.ground, old = r._levelColliders || [];
    r._levelColliders = [];   // before anything can throw: the retry must not remove these twice
    for (const c of old) r.world.removeCollider(c, false);
    const desc = t => r.rapier.ColliderDesc.trimesh(t.positions, t.indices).setFriction(0.9);
    for (const t of G.staticTrimeshes?.() ?? []) r._levelColliders.push(r.world.createCollider(desc(t)));
  });
}

// A ground with no collision of its own stands on an infinite flat plane at y = 0, unless the game turned it off. One more copy of the ground, so it comes and goes with the ground
// source: left standing it is an invisible floor over a level installed later. Answers whether it changed.
export const wantsFloor = r => { const G = r.engine.ground; return r.fallbackFloor && !G.chunkCollision && !G.staticTrimeshes; };
export function syncFloor(r) {
  return !!r._floor.sync(() => {
    const want = wantsFloor(r);
    if (want && !r._floorCollider) r._floorCollider = r.world.createCollider(r.rapier.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0));
    else if (!want && r._floorCollider) { r.world.removeCollider(r._floorCollider, false); r._floorCollider = null; }
  });
}

// ---------- Game-set body / collider state across RigidBodies._fresh ----------
// What the game wrote on a Rapier body / collider, carried onto the rebuilt one when _fresh starts the physics world over (newGame, load).
// Why: the rebuild exists so physics after newGame matches a fresh page exactly, but the game owns body.* / collider.* (direct Rapier writes are plain
// API use, as three.js writes are): gravityScale, ccd, dominance, sensor, collision groups, enabled... must survive it. A setter only runs when the
// value differs from the rebuilt default, so an untouched body is built exactly as on a fresh page (no extra mass-property or wake-up work).

const LOCKS = ['lockTranslations', 'setEnabledTranslations', 'lockRotations', 'setEnabledRotations'];

/**
 * Remember axis locks on a body: Rapier has setters but no getters for them, so the calls are recorded and replayed on a rebuilt body.
 * @internal
 */
export function recordLocks(entry, body) {
  const locks = entry._locks ??= new Map();
  for (const k of LOCKS) {
    const f = body[k];
    // the later of lockRotations / setEnabledRotations wins in Rapier, so one slot per group keeps only the last call
    body[k] = (...a) => { const g = k.includes('Rot') ? 'rot' : 'trans'; locks.delete(g); locks.set(g, [k, a]); return f.apply(body, a); };
  }
}

/** @internal Copy game-set body state from the old body onto the rebuilt one (before old.free()) */
export function carryBody(entry, o, n) {
  if (o.bodyType() !== n.bodyType()) n.setBodyType(o.bodyType(), false);
  if (o.gravityScale() !== n.gravityScale()) n.setGravityScale(o.gravityScale(), false);
  if (o.isCcdEnabled() !== n.isCcdEnabled()) n.enableCcd(o.isCcdEnabled());
  if (o.softCcdPrediction() !== n.softCcdPrediction()) n.setSoftCcdPrediction(o.softCcdPrediction());
  if (o.dominanceGroup() !== n.dominanceGroup()) n.setDominanceGroup(o.dominanceGroup());
  if (o.additionalSolverIterations() !== n.additionalSolverIterations()) n.setAdditionalSolverIterations(o.additionalSolverIterations());
  // damping is not copied: the engine writes it itself (buoyancy swaps in water drag) and rebuilds from the entry's damping / angularDamping
  if (o.userData !== undefined) n.userData = o.userData;
  // wakeUp (the last argument) is false: a rebuilt body starts like a fresh one
  for (const [k, a] of entry._locks?.values() ?? []) n[k](...a.slice(0, k.startsWith('lock') ? 1 : 3), false);
  recordLocks(entry, n);
  if (!o.isEnabled()) n.setEnabled(false);
}

/** @internal Copy game-set collider state from the old collider onto the one rebuilt from the entry's desc */
export function carryCollider(o, n) {
  const pairs = [['isSensor', 'setSensor'], ['collisionGroups', 'setCollisionGroups'], ['solverGroups', 'setSolverGroups'], ['friction', 'setFriction'],
    ['restitution', 'setRestitution'], ['frictionCombineRule', 'setFrictionCombineRule'], ['restitutionCombineRule', 'setRestitutionCombineRule'],
    ['activeEvents', 'setActiveEvents'], ['activeHooks', 'setActiveHooks'], ['activeCollisionTypes', 'setActiveCollisionTypes'],
    ['contactForceEventThreshold', 'setContactForceEventThreshold'], ['contactSkin', 'setContactSkin'], ['mass', 'setMass']];
  for (const [get, set] of pairs) { const v = o[get](); if (v !== n[get]()) n[set](v); }
  if (!o.isEnabled()) n.setEnabled(false);
}
