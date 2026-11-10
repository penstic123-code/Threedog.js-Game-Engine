// Lightweight collision: characters are upright cylinders, trees/rocks are circles, houses etc. are rotated rectangles.
// Only keeps walkers from clipping and the camera from being blocked; much faster than a full physics engine, tens of thousands of trees are fine on big maps.
// For falling, pushing crates and other real physics, add Rapier separately; it does not affect this.
// Once installed: engine.collision (real physics is another module, rigid() → engine.rigid).
// Positions are always a single argument (Vector3 / Object3D / [x, y, z] / { x, z }); sizes go in the options object:
//   const h = engine.collision.addBox(house, { halfWidth: 3, halfDepth: 2, rotation: 0.3 });   h.remove();
import { Box3, Vector3 } from 'three';
import { xzOf, yOf } from '../../core/base/math.js';
import { surfaceOr } from '../../core/scene/ground.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { CollisionGrid, gridBlocks, bodyHits, passesThrough, passesOf } from './grid.js';
import { codedError } from '../../core/base/errorHints.js';

/** One axis of the slab test: narrows S.t0 / S.t1 to where the ray is inside |o + d t| <= h; false when it misses */
function slab(S, o, d, h) {
  if (Math.abs(d) < 1e-6) return Math.abs(o) <= h;
  let ta = (-h - o) / d, tb = (h - o) / d; if (ta > tb) { const t = ta; ta = tb; tb = t; }
  S.t0 = Math.max(S.t0, ta); S.t1 = Math.min(S.t1, tb);
  return S.t0 <= S.t1;
}

const BOX_KEYS = ['halfWidth', 'halfDepth', 'rotation', 'height', 'y', 'occluder', 'layer'], CIRCLE_KEYS = ['radius', 'height', 'occluder', 'layer'], SEG_KEYS = ['thickness', 'height', 'y', 'occluder', 'layer'], BLOCK_KEYS = ['bounds'];

/** A collider's layer option: one name, or undefined for "stops every mover" (what every collider did before layers) */
function layerOf(where, v) {
  if (v === undefined || (typeof v === 'string' && v)) return v;
  throw codedError('collision-misuse', `${where}: layer is one name, e.g. { layer: 'gate' } (movers with passes: ['gate'] go through it, every other mover is stopped); got ${JSON.stringify(v)}`, TypeError);
}

export class Collision {
  /**
   * maxClimb: max walkable slope (height diff / horizontal distance; default slopeRatio derived from engine.movement.maxSlope); canopyHeight: a camera above this height is not blocked by trees
   * cameraPad: camera margin from obstacles; cameraMin: closest camera distance; walkableWaterMargin: how far above the water surface counts as walkable
   * cameraOcclusion: what camera occlusion tests: 'both' (default) | 'colliders' circles and boxes only | 'meshes' only meshes registered as camera blockers (level buildings, col_ meshes,
   * engine.rays.addStatic(mesh, { occluder: true })). Why both: a collider is a footprint for walkers, so a crown or an eave above it never stopped the arm, and a registered mesh was ignored
   * unless the game also found this option. The ray skips every mesh that is no blocker on one flag check, so 'both' costs only for the blockers
   */
  constructor(engine, { maxClimb = engine.movement.slopeRatio, canopyHeight = 5, cameraPad = 0.5, cameraMin = 1.5, walkableWaterMargin = 0.2, cameraOcclusion = 'both' } = {}) {
    this.engine = engine;
    Object.assign(this, { maxClimb, canopyHeight, cameraPad, cameraMin, walkableWaterMargin, cameraOcclusion });
    // Sets, not arrays: they keep insertion order (forEachStatic and every consumer see colliders in the order added) and delete in O(1),
    // where an array filter per remove made unloading n colliders O(n^2)
    /** manually added circle colliders {x, z, r, h} @type {Set<any>} */ this._circles = new Set();
    /** rectangles {x, z, hw, hd, rot, h} @type {Set<any>} */ this._boxes = new Set();
    this._grid = new CollisionGrid();   // grid index: resolve / camera look only nearby instead of scanning all (circles / boxes change only via addCircle / addBox)
    this._blocked = [];   // addBlocked fields {fn, bounds}; empty = zero cost
    this.blockedVersion = 0;   // +1 on addBlocked / remove: async paths re-sample their cached ground rasters
    this.version = 0;   // +1 on every static collider add/remove; the physics module syncs on it
    this._onGroundCircle = (cx, cz, r) => this._pushCircle(this._rPos, cx, cz, r, this._rRad);   // built once: ground.forEachCollider callback
    this._camS = { from: null, to: null, ux: 0, uz: 0, len: 0, pad: 0, want: 0, best: 0, t0: 0, t1: 0 };   // cameraDistance scratch for its callbacks
    this._lineS = { t0: 0, t1: 0 };   // lineClear slab scratch
    this._onCamCircle = (a, b, c) => this._camCircle(a, b, c);
    this._gb = { x: 0, z: 0, radius: 0, hit: false };   // _groundBlocks scratch: it runs in the inner loop of A*
    this._onBlockCircle = (cx, cz, r) => { const G = this._gb; if (Math.hypot(G.x - cx, G.z - cz) < G.radius + r) G.hit = true; };
  }
  /** Iterate all manually added static colliders (for the physics module): fn('box' | 'circle', data) */
  forEachStatic(fn) { for (const b of this._boxes) fn('box', b); for (const c of this._circles) fn('circle', c); }
  /**
   * Keep an outside copy of the static colliders (boxes and circles) in step, e.g. physics colliders or navmesh obstacles. add(type, data) builds the
   * copy of one collider and returns it; remove(piece, data) drops one. sync() does the work only when `version` moved since the last sync, then adds
   * what is new (in forEachStatic order) and removes what is gone; returns whether anything was compared. clear() forgets every piece without calling
   * remove (the outside world they lived in was thrown away) so the next sync builds all again; clear(true) calls remove on each (this collision module is leaving, the
   * outside world stays).
   * Why one shared mirror: nav and rigid each had their own copy of this diff, and the two copies drifted (one checked readiness, the other a version
   * field of its own); a third consumer would copy it a third time.
   * @param {{ add: (type: 'box' | 'circle', data: any) => any, remove: (piece: any, data: any) => void }} fns
   */
  mirror({ add, remove }) {
    const pieces = new Map(), col = this;
    const seen = new Set();
    let version = -1;
    return {
      sync() {
        if (col.version === version) return false;
        version = col.version; seen.clear();
        col.forEachStatic((type, o) => { seen.add(o); if (!pieces.has(o)) pieces.set(o, add(type, o)); });
        for (const [o, p] of pieces) if (!seen.has(o)) { pieces.delete(o); remove(p, o); }
        seen.clear();
        return true;
      },
      clear(drop = false) { if (drop) for (const [o, p] of pieces) remove(p, o); pieces.clear(); version = -1; },
      get size() { return pieces.size; },
    };
  }

  /**
   * Add a circle collider (pillar, statue, campfire): position is the centre, radius (default 0.5), height (default 6). It stands on the ground and stops walkers on every floor; a pillar upstairs is an addBox with a y.
   * occluder: false keeps it from pulling the follow camera in (walkers are still stopped), e.g. forest trunks the camera may pass through.
   * layer: a name; movers whose passes list names it go through (walking, paths, navmesh), every other mover is stopped. Left out: it stops every mover. Sight lines and the camera ignore it. Returns a handle { remove() }
   * @example engine.collision.addBox(gate, { halfWidth: 2, halfDepth: 0.3, layer: 'gate' });   // a character made with passes: ['gate'] walks through, the rest are stopped
   */
  addCircle(position, opts = {}) {
    opts = readParams('collision.addCircle()', keysSchema(CIRCLE_KEYS), opts);
    const [x, z] = xzOf(position), c = { x, z, r: opts.radius ?? 0.5, h: opts.height ?? 6, occ: opts.occluder !== false, ly: layerOf('collision.addCircle()', opts.layer) };
    this._circles.add(c); this._grid.add(c, false); this.version++;
    return { remove: () => { if (!this._circles.delete(c)) return; this._grid.remove(c); this.version++; } };
  }
  /**
   * Add a rectangle collider (house, fence): position is the centre; halfWidth / halfDepth (default 1), rotation about the Y axis (radians),
   * height (default 6), y is the box bottom height (omit to sit on the ground; set it for walls on platforms in levels); occluder and layer as in addCircle. Returns a handle { remove() }
   */
  addBox(position, opts = {}) {
    opts = readParams('collision.addBox()', keysSchema(BOX_KEYS), opts);
    const [x, z] = xzOf(position), hw = opts.halfWidth ?? 1, hd = opts.halfDepth ?? 1, rot = opts.rotation ?? 0;
    const b = { x, z, hw, hd, rot, h: opts.height ?? 6, y: opts.y, c: Math.cos(rot), s: Math.sin(rot), r: Math.hypot(hw, hd), occ: opts.occluder !== false, ly: layerOf('collision.addBox()', opts.layer) };
    this._boxes.add(b); this._grid.add(b, true); this.version++;
    return { remove: () => { if (!this._boxes.delete(b)) return; this._grid.remove(b); this.version++; } };
  }
  /**
   * Add a thin wall along the line a -> b (fence, wall; positions like addBox). thickness (default 0.3), height (default 6), y, occluder and layer as in addBox.
   * It is a rotated box in the same grid, so a gap between two segments is a gate. Returns a handle { remove() }
   */
  addSegment(a, b, opts = {}) {
    opts = readParams('collision.addSegment()', keysSchema(SEG_KEYS), opts);
    const [ax, az] = xzOf(a), [bx, bz] = xzOf(b);
    // box-local +x is (cos r, -sin r) in world, so r = -atan2(dz, dx)
    return this.addBox([(ax + bx) / 2, 0, (az + bz) / 2], { halfWidth: Math.hypot(bx - ax, bz - az) / 2, halfDepth: (opts.thickness ?? 0.3) / 2, rotation: -Math.atan2(bz - az, bx - ax), height: opts.height, y: opts.y, occluder: opts.occluder, layer: opts.layer });
  }
  /**
   * Mark ground as impassable where fn(x, z) is true (river, lava, cliff edge). Walkers are stopped at its edge (sliding along it) and walkable() says no.
   * fn must be pure and deterministic (no clock, no random). bounds { minX, maxX, minZ, maxZ } (world metres, the field's x / z extent) skips fn outside it. A bridge: have fn return false over it,
   * or keep the water field exact and let fn test `!onBridge(x, z)`. findPathAsync samples fn into its ground raster (1 m cells), so give bounds to keep that cheap. Returns a handle { remove() }
   */
  addBlocked(fn, opts = {}) {
    opts = readParams('collision.addBlocked()', keysSchema(BLOCK_KEYS), opts);
    if (typeof fn !== 'function') throw codedError('collision-misuse', `collision.addBlocked(fn): fn is (x, z) => boolean, got ${typeof fn}`);
    const f = { fn, bounds: opts.bounds ?? null }; this._blocked.push(f); this.version++; this.blockedVersion++;
    return { remove: () => { if (!this._blocked.includes(f)) return; this._blocked = this._blocked.filter(o => o !== f); this.version++; this.blockedVersion++; } };
  }
  /** Is a character of `radius` standing at (x, z) touching blocked ground (centre and four points on its rim). Free when addBlocked was never used */
  blockedAt(x, z, radius = this.engine.movement.radius) {
    const L = this._blocked; if (!L.length) return false;
    for (let i = 0; i < L.length; i++) {
      const { fn, bounds: bd } = L[i];
      if (bd && (x + radius < bd.minX || x - radius > bd.maxX || z + radius < bd.minZ || z - radius > bd.maxZ)) continue;
      if (fn(x, z) || fn(x + radius, z) || fn(x - radius, z) || fn(x, z + radius) || fn(x, z - radius)) return true;
    }
    return false;
  }
  /** Add collision from a three.js object's bounding box (common for house models), pad grows it outward (m), occluder and layer as in addBox. Returns a handle { remove() } */
  addObject(obj, { pad = 0, occluder = true, layer } = {}) {
    obj.updateMatrixWorld(true);
    // a THREE.LOD is measured by its full model: a low level may stick out a little, and collision must not change with which levels exist
    const box = new Box3().setFromObject(obj.isLOD ? obj.levels[0].object : obj), c = box.getCenter(new Vector3()), s = box.getSize(new Vector3());
    return this.addBox(c, { halfWidth: s.x / 2 + pad, halfDepth: s.z / 2 + pad, height: s.y, y: box.min.y, occluder, layer });
  }

  // The per-frame walkers below pass state through fields instead of building callbacks: resolve() and cameraDistance() run every step / frame.
  // resolve saves and restores its fields, so a nested call (from a ground collider callback) stays safe.
  _pushCircle(pos, a, b, c, radius) {
    let dx = pos.x - a, dz = pos.z - b, d = Math.hypot(dx, dz);
    const min = radius + c;
    if (d >= min) return;
    if (d <= 1e-5) { dx = 1; dz = 0; d = 1; }   // dead centre has no direction: always leave towards +x, so the same input gives the same exit
    pos.x = a + dx / d * min; pos.z = b + dz / d * min; this._rHit = true;
  }
  _pushBox(pos, bx, radius) {
    const lx0 = pos.x - bx.x, lz0 = pos.z - bx.z;
    const lx = lx0 * bx.c - lz0 * bx.s, lz = lx0 * bx.s + lz0 * bx.c;   // to box-local coordinates
    const qx = Math.max(-bx.hw, Math.min(bx.hw, lx)), qz = Math.max(-bx.hd, Math.min(bx.hd, lz));
    const dx = lx - qx, dz = lz - qz, d = Math.hypot(dx, dz);
    if (d >= radius) return;
    let nx, nz;
    if (d > 1e-5) { nx = dx / d; nz = dz / d; nx = lx + nx * (radius - d); nz = lz + nz * (radius - d); }
    else { // centre is inside the box: push out along the nearest edge
      const px = bx.hw - Math.abs(lx), pz = bx.hd - Math.abs(lz);
      if (px < pz) { nx = (lx < 0 ? -1 : 1) * (bx.hw + radius); nz = lz; } else { nx = lx; nz = (lz < 0 ? -1 : 1) * (bx.hd + radius); }
    }
    pos.x = bx.x + nx * bx.c + nz * bx.s; pos.z = bx.z - nx * bx.s + nz * bx.c; this._rHit = true;
  }

  /**
   * @internal Push a character of radius `radius` out of obstacles; edits pos.x / pos.z directly. Returns whether a collision happened.
   * A box with an explicit `y` occupies y .. y + height, and stops only a body (pos.y .. + movement.height) that overlaps that span: a wall upstairs leaves the floor below free.
   * A box without `y` is a footprint, as is every box when pos has no y: those stop at any height. walkableAt and A* read boxes the same way (bodyHits).
   * passes: the mover's layer list (passesOf); a collider whose layer it names does not push it
   */
  resolve(pos, radius = this.engine.movement.radius, passes) {
    const sPos = this._rPos, sRad = this._rRad;
    this._rPos = pos; this._rRad = radius; this._rHit = false;
    const g = this.engine.ground, y = pos.y, body = this.engine.movement.height;
    for (let iter = 0; iter < 2; iter++) {
      g.forEachCollider?.(pos.x, pos.z, radius + 2, this._onGroundCircle);
      const list = this._grid.query(pos.x, pos.z, radius + 2);
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (passesThrough(it, passes)) continue;
        if (!it._b) this._pushCircle(pos, it.x, it.z, it.r, radius);
        else if (bodyHits(it, y, body)) this._pushBox(pos, it, radius);
      }
      if (!this._rHit) break;   // nothing pushed: a second pass would ask the same questions at the same spot (most steps of most walkers)
    }
    const hit = this._rHit;
    this._rPos = sPos; this._rRad = sRad;
    return hit;
  }

  /** Can anyone stand here (for pathfinding): not in water, not too steep, not inside an obstacle. radius is the character radius (m, default engine.movement.radius), passes its layer list (addBox { layer }). A position with y asks about the floor that height picks */
  walkable(position, { radius = this.engine.movement.radius, passes } = {}) { const [x, z] = xzOf(position); return this.walkableAt(x, z, radius, yOf(position), passesOf('collision.walkable()', passes)); }
  /**
   * Line of sight with height: is the 3D segment a -> b free of colliders (boxes, circles, terrain trees)? Positions like addBox ([x, y, z] / Vector3 / Object3D).
   * Heights count: a 1 m wall does not block a sight line passing 3 m above it; a collider's `y` and `height` are honoured (no `y` = sits on the ground).
   * Give real eye heights in a and b (`[x, 1.6, z]`); a plain { x, z } counts as y = 0. opts.radius (default 0) fattens the line, e.g. the character radius for "can I walk straight there".
   * Ignores addBlocked fields (water is not a wall). Terrain trees have no stored height and block below `canopyHeight` above the ground. Allocates a little: not for hundreds of pairs per frame.
   * opts.who: world record id of the asker; with events.traceSize > 0 every query is noted as a `sight` trace entry (data: from, to, clear), in full for who === events.traceFocus.
   * @param {any} a @param {any} b @param {{ radius?: number, who?: string }} [opts]
   * @returns {boolean} true = nothing in the way
   * @example if (engine.collision.lineClear(guard.position, player.position, { who: 'guard-1' })) alert();   // guard sees the player
   */
  lineClear(a, b, opts = {}) {
    const clear = this._lineClear(a, b, opts), ev = this.engine.events;
    if (ev.traceSize > 0) { const A = this._vec(a), B = this._vec(b), r = x => Math.round(x * 10) / 10; ev.note('sight', { obj: opts.who, verbose: clear, data: { from: [r(A.x), r(A.y), r(A.z)], to: [r(B.x), r(B.y), r(B.z)], clear } }); }   // a clear line is the common case: only kept for the focused object; a blocked one is always kept
    return clear;
  }
  /** @internal */
  _lineClear(a, b, opts) {
    readParams('collision.lineClear()', keysSchema(['radius', 'who']), opts); if (typeof opts !== 'object') opts = {};
    const rad = opts.radius ?? 0;
    const A = this._vec(a), B = this._vec(b), dx = B.x - A.x, dz = B.z - A.z, dy = B.y - A.y;
    const S = this._lineS;
    // y of the segment is linear in t; an obstacle occupying t in [t0, t1] blocks if the segment's y range there overlaps [bottom, top]
    const blocks = (t0, t1, bottom, top) => {
      t0 = Math.max(t0, 0); t1 = Math.min(t1, 1);
      if (t0 > t1) return false;
      const y0 = A.y + dy * t0, y1 = A.y + dy * t1;
      return Math.max(y0, y1) > bottom && Math.min(y0, y1) < top;
    };
    const circle = (cx, cz, r, bottom, top) => {
      const ox = A.x - cx, oz = A.z - cz, R = r + rad, qa = dx * dx + dz * dz, qb = 2 * (ox * dx + oz * dz), qc = ox * ox + oz * oz - R * R;
      if (qa < 1e-12) return qc < 0 && blocks(0, 1, bottom, top);   // straight up / down
      const disc = qb * qb - 4 * qa * qc; if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      return blocks((-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa), bottom, top);
    };
    const len = Math.hypot(dx, dz), mx = A.x + dx / 2, mz = A.z + dz / 2;
    // what stands on the ground stands on the floor the line passes over, not on a deck far above it
    const floorAt = (x, z) => this.engine.surface(x, z, A.y + dy * (len > 1e-6 ? Math.min(1, Math.max(0, ((x - A.x) * dx + (z - A.z) * dz) / (len * len))) : 0));
    const list = this._grid.query(mx, mz, len / 2 + rad + 1);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it._b) { const g = floorAt(it.x, it.z); if (circle(it.x, it.z, it.r, g, g + it.h)) return false; continue; }
      const ox = A.x - it.x, oz = A.z - it.z;
      const lx = ox * it.c - oz * it.s, lz = ox * it.s + oz * it.c, ldx = dx * it.c - dz * it.s, ldz = dx * it.s + dz * it.c;
      S.t0 = 0; S.t1 = 1;
      if (!slab(S, lx, ldx, it.hw + rad) || !slab(S, lz, ldz, it.hd + rad)) continue;
      const bottom = it.y ?? floorAt(it.x, it.z);
      if (blocks(S.t0, S.t1, bottom, bottom + it.h)) return false;
    }
    let treeHit = false;
    this.engine.ground.forEachCollider?.(mx, mz, len / 2 + rad + 1, (cx, cz, r) => {   // plants grow on the top ground: that is where their trunks stand
      if (!treeHit) { const g = this.engine.surface(cx, cz); treeHit = circle(cx, cz, r, g, g + this.canopyHeight); }
    });
    return !treeHit;
  }
  /** @internal position argument -> { x, y, z } (y 0 when only x, z are given) */
  _vec(p) {
    const [x, z] = xzOf(p);
    return { x, y: yOf(p) ?? 0, z };
  }
  /** @internal The collider grid (boxes and circles added through this module), read by async pathfinding on the main thread */
  get grid() { return this._grid; }
  /**
   * Same as walkable but takes plain numbers (inner loop of A* pathfinding and spawn search, allocates nothing; like engine.surface(x, z)). radius defaults to engine.movement.radius.
   * y picks the floor as in surface(), and only the floor it picks counts, so [x, 0, z] on raised ground asks about that ground. Left out: the top ground, and every box blocks at any height.
   * passes: the mover's layer list as passesOf returns it (the inner loop of A* does not read it again)
   */
  walkableAt(x, z, radius = this.engine.movement.radius, y, passes) {
    const f = y === undefined ? y : surfaceOr(this.engine, x, z, y, y);
    return this.groundWalkable(x, z, f) && !this.blockedAt(x, z, radius) && !this._groundBlocks(x, z, radius) && !gridBlocks(this._grid, x, z, radius, f, this.engine.movement.height, passes);
  }
  /** @internal Ground shape half of walkableAt (water, slope): a smooth field, so async pathfinding samples it on a raster; colliders are tested exactly there */
  groundWalkable(x, z, y) {
    const e = this.engine;
    // the void of terrain({ shape }): -Infinity is not below a water level of -Infinity, so it must be asked directly
    return e.ground.has(x, z) && !(e.surface(x, z, y) < e.waterAt(x, z, y) + this.walkableWaterMargin || e.slope(x, z, y) > this.maxClimb * 0.8);
  }
  /** Does one of the ground's own colliders (terrain trees) block this spot */
  _groundBlocks(x, z, radius) {
    const G = this._gb;
    G.x = x; G.z = z; G.radius = radius; G.hit = false;
    this.engine.ground.forEachCollider?.(x, z, radius + 1, this._onBlockCircle);
    return G.hit;
  }

  /** A camera above the canopy is not blocked by trees: is the line of sight at distance tc above it over (x, z) */
  _yAbove(x, z, tc) { const S = this._camS; return S.from.y + (S.to.y - S.from.y) * (tc / S.len) - this.engine.surface(x, z) > this.canopyHeight; }
  _camCircle(a, b, c) {
    const S = this._camS, from = S.from, tc = (a - from.x) * S.ux + (b - from.z) * S.uz;
    if (tc <= 0.3 || tc >= S.len) return;
    const px = from.x + S.ux * tc - a, pz = from.z + S.uz * tc - b, rr = c + S.pad;
    if (px * px + pz * pz > rr * rr) return;
    const t = tc - Math.sqrt(rr * rr - (px * px + pz * pz));   // distance at which the line of sight (character to camera) hits the obstacle
    if (this._yAbove(a, b, tc)) return;
    S.best = Math.min(S.best, S.want * t / S.len);
  }
  /** Rectangle: rotate the line of sight into box-local coordinates and compute where it enters the box (slab intersection) */
  _camBox(bx) {
    const S = this._camS, from = S.from, ox = from.x - bx.x, oz = from.z - bx.z, len = S.len;
    const lx = ox * bx.c - oz * bx.s, lz = ox * bx.s + oz * bx.c, dx = S.ux * bx.c - S.uz * bx.s, dz = S.ux * bx.s + S.uz * bx.c;
    S.t0 = 0; S.t1 = len;
    if (!slab(S, lx, dx, bx.hw + S.pad) || !slab(S, lz, dz, bx.hd + S.pad)) return;
    if (S.t0 <= 0.3) return;
    const yAt = from.y + (S.to.y - from.y) * (S.t0 / len);
    if (yAt > (bx.y ?? this.engine.surface(bx.x, bx.z, yAt)) + bx.h) return;   // camera above the wall top
    S.best = Math.min(S.best, S.want * S.t0 / len);
  }

  /** @internal Camera occlusion: if the line from the character's head to the camera passes through a trunk or house, pull the camera closer. Returns the max allowed distance */
  cameraDistance(from, to, want, pad = this.cameraPad) {
    const mode = this.cameraOcclusion;
    let best = want;
    if (mode !== 'colliders') {   // meshes: cast a ray from the head toward the camera, pull closer if it hits a camera-blocking mesh
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len3 = Math.hypot(dx, dy, dz);
      const hit = len3 > 1e-3 && this.engine.raycast(from, { x: dx, y: dy, z: dz }, { far: len3, occluders: true });
      if (hit) best = Math.min(best, want * Math.max(0, hit.distance - pad) / len3);
      if (mode === 'meshes') return Math.max(this.cameraMin, best);
    }
    const sx = to.x - from.x, sz = to.z - from.z, len = Math.hypot(sx, sz);
    if (len < 1e-3) return mode === 'colliders' ? want : Math.max(this.cameraMin, best);
    const S = this._camS;
    S.from = from; S.to = to; S.ux = sx / len; S.uz = sz / len; S.len = len; S.pad = pad; S.want = want; S.best = best;
    this.engine.ground.forEachCollider?.(from.x + sx / 2, from.z + sz / 2, len / 2 + 1, this._onCamCircle);
    const list = this._grid.query(from.x + sx / 2, from.z + sz / 2, len / 2 + 1);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it.occ) continue;   // occluder: false (addCircle / addBox)
      if (it._b) this._camBox(it); else this._camCircle(it.x, it.z, it.r);
    }
    best = S.best;
    S.from = S.to = null;   // do not keep the caller's vectors alive
    return Math.max(this.cameraMin, best);
  }
}

const COLLISION_PARAMS = keysSchema(['maxClimb', 'canopyHeight', 'cameraPad', 'cameraMin', 'walkableWaterMargin', 'cameraOcclusion']);

/** Collision module: lightweight character walking collision, covers the whole map. Once installed: engine.collision */
export function collision(opts = {}) {
  readParams('collision', COLLISION_PARAMS, opts);
  let c = null;
  return { name: 'collision', skipKind: 'none', type: 'world', provides: ['collision'], params: COLLISION_PARAMS, options: opts, label: 'Collision', install(e) { e.i18n.add({ 'zh-CN': { 'module.collision': '碰撞' }, en: { 'module.collision': 'collision' } }); return (c = new Collision(e, opts)); },
    // counts of what blocks walking, and whether the player's own spot is walkable: answers "why can the player not go there" without stepping
    describe(e) {
      const p = e.player?.position;
      return { circles: c._circles.size, boxes: c._boxes.size, fields: c._blocked.length, cameraOcclusion: c.cameraOcclusion,
        ...(p ? { atPlayer: { walkable: c.groundWalkable(p.x, p.z), blocked: c.blockedAt(p.x, p.z) } } : {}) };
    } };
}

export const handRolled = [{ kind: 'collision', seen: 'a hand-written box overlap', use: 'engine.collision.addBox / addCircle for walls and props (movement, rays and physics read them); engine.collision.walkable to ask', quiet: /\b(engine|e|eng|ctx)\.collision\b/, code: /Math\.abs\([^)]*\)\s*<=?[^&|;]*&&\s*Math\.abs\([^)]*\)\s*<=?|[<>]=?\s*[\w.]*\bmin[XYZ]?\b[^;]*&&[^;]*[<>]=?\s*[\w.]*\bmax[XYZ]?\b/i }];
