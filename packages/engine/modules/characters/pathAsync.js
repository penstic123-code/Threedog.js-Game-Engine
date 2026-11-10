// engine.characters.findPathAsync: many paths off the main thread, answered on a fixed step (part of the characters module).
// Requests queue up; each fixed step at most pathsPerStep of them leave as one batch (counted in requests, not milliseconds, so the result never depends on machine speed).
// A batch runs in an engine.threads lane (pathWorker.js) and lands PATH_LAG steps later through engine.commits; late or no workers -> the same
// solveBatch runs here at the due step. The batch is tagged with the walkable state it was computed on (navmesh revision or collision version);
// if that changed before it lands, it is recomputed here on the current state, so threads on / off / slow / crashed give identical paths.
// A request belongs to the world it was asked in, like any background result: one still queued when a save load, new game or level change
// invalidates engine.commits is dropped (its done never runs), the same as a batch already sent.
// done stays a callback on purpose: it runs inside the fixed step. A Promise's then runs after the whole frame's steps, so a write there would depend on how many
// steps a frame ran, and a dropped request would leave the Promise pending forever.
import { xzOf, yOf } from '../../core/base/math.js';
import { surfaceOr } from '../../core/scene/ground.js';
import { solveBatch, pathHandler, astarDefaults, RES, TILE, tileOf } from './pathJob.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { withHeights } from './moveHelpers.js';
import { reportError } from '../../core/base/errors.js';
import { warnOnce } from '../../core/base/validate.js';
import { passesOf } from '../collision/grid.js';

/** Steps between sending a batch and its answers taking effect (4 = 67 ms): enough for a worker round trip, short enough that an NPC barely waits */
const PATH_LAG = 4;
/** A cached ground raster tile is reused for this many fixed steps (5 s), then sampled again: streamed terrain may have added trees meanwhile */
const TILE_TTL = 300;
/** Floors looked for under a cell's top one: only a ground that answers something new for every height ever reaches it */
const MAX_FLOORS = 16;
const NO_DONE = 'characters.findPathAsync(from, to, done): done must be a function (path, status) => { ... }; it runs on a fixed step when the path is ready';

/** A position in any form as the plain point a path source reads and writes */
const point = p => { const [x, z] = xzOf(p); return { x, y: yOf(p), z }; };

/**
 * What the characters.path rule says for one request, as a search answer; null when the built-in search answers ('walk'). A game's source returns a list of points, null or an empty list for no way, 'walk' to fall back.
 * The points are copied: walkers fill in heights and eat the path as they go, and the list may be one the game keeps and hands to everyone.
 * Why it runs on the main thread at the due step, also for findPathAsync: a game's function cannot go to a worker, and done must still come on a fixed step
 */
export function sourcePath(e, rule, from, to, o) {
  const d = rule.decide(o.id, { from: point(from), to: point(to), o });
  if (d === 'walk') return null;
  if (d && !Array.isArray(d)) throw codedError('character-option', `rule 'characters.path': a path source returns a list of { x, y?, z } points, null or 'walk', got ${JSON.stringify(d)}`);
  return d?.length ? { status: 'ok', path: d.map(p => ({ ...p, ...point(p) })) } : { status: 'noPath', path: null };
}

/**
 * nav() is installed but cannot answer, and has no walkable mesh (procedural terrain has none): paths silently stand on collision A*. Say so once,
 * in dev. Which method answers is unchanged. Also said while a level is still loading, so the text names both causes (characters may not import the level module).
 */
export function noteAStarStandIn(e) {
  if (!e.nav || e.nav.ready) return;
  warnOnce(coded('nav-fallback', 'nav() is installed but has no navmesh (it is built from the level ground: that level is still loading, or the terrain is procedural, which has none), so characters.findPath and findPathAsync use collision A* instead. Paths work, but are coarser than a navmesh and nav links / crowds do not apply.'), 'nav-fallback');
}

/** @internal */
export class AsyncPaths {
  constructor(e, rule) {
    this.e = e;
    this.rule = rule;
    this.queue = [];
    this.perStep = 32;
    this.lane = null;
    this.sent = { from: null, meshes: new Map(), ver: -1 };   // what the workers mirror, and of which provider: mesh size -> its revision, collision version
    this.turn = 0;   // bumps with every provider
    this.ground = 0;   // bumps with every ground:change: a batch computed on the ground before a terrain edit must not land (the navmesh / collision numbers do not move for it)
    this.tiles = new Map();             // 'tx:tz' -> { data, trees, at, bv }
  }
  request(from, to, done, o = {}) {
    if (typeof done !== 'function') throw codedError('character-option', NO_DONE);
    const [sx, sz] = xzOf(from), [gx, gz] = xzOf(to), passes = passesOf('characters.findPathAsync()', o.passes);
    if (passes !== o.passes) o = { ...o, passes };   // the read form: one set of layers is one navmesh
    const h = { sx, sz, gx, gz, sy: yOf(from), gy: yOf(to), o, done, epoch: this.e.commits.epoch, canceled: false, remove() { h.canceled = true; } };
    this.queue.push(h);
    return h;
  }
  /** The module is unloading: nothing queued or on its way may answer, the world it was asked in has no characters now. A lane is the engine's: it ends with engine.threads */
  stop() { this.queue.length = 0; this.stopped = true; }
  /** Which walkable state answers now: navmesh revision, collision version, or nothing */
  key() {
    const e = this.e, from = e.nav?.ready ? e.nav : e.collision;
    if (from === e.collision) noteAStarStandIn(e);
    // another provider starts its numbers over, so equal ones say nothing: what the workers mirror goes, and a batch of the old one cannot match the new key
    if (from !== this.sent.from) { this.sent = { from, meshes: new Map(), ver: -1 }; this.turn++; }
    return from === e.nav ? `n${this.turn}.${e.nav.revision}.${this.ground}` : from ? `g${this.turn}.${e.collision.version}.${this.ground}` : '-';
  }
  /** Each fixed step (characters fixed): send up to perStep queued requests as one batch */
  flush() {
    const list = [];
    const epoch = this.e.commits.epoch;
    while (this.queue.length && list.length < this.perStep) { const h = this.queue.shift(); if (!h.canceled && h.epoch === epoch) list.push(h); }
    if (!list.length) return;
    const e = this.e, T = e.threads, batch = this.build(list);
    const t = e.commits.request({ lag: PATH_LAG, fallback: () => null, apply: r => this.land(batch, list, r) });
    if (!T.size || batch.key === '-') return;
    this.mirror(batch);
    this.lane.run(batch).then(r => t.resolve(r), () => {});   // a failed run is ignored: land() computes the same answer here
  }
  /** Plain-data batch: everything the solver needs that the worker does not mirror */
  build(list) {
    const e = this.e, key = this.key(), mode = key[0] === 'n' ? 'nav' : key[0] === 'g' ? 'grid' : 'none', tiles = {}, heights = {}, lower = {}, trees = [], seen = new Set();
    const take = (tk, tx, tz) => {
      if (tiles[tk]) return;
      const c = this.tile(tk, tx, tz); tiles[tk] = c.data;
      heights[tk] = c.top;
      if (c.lower) lower[tk] = c.lower;
      for (let i = 0; i < c.trees.length; i += 3) { const id = c.trees[i] + ',' + c.trees[i + 1]; if (!seen.has(id)) { seen.add(id); trees.push(c.trees[i], c.trees[i + 1], c.trees[i + 2]); } }
    };
    const reqs = list.map(({ sx, sy, sz, gx, gy, gz, o }) => {
      if (mode === 'nav') { const m = e.nav.mesh(o.radius, o.passes); return { mode, size: m.size, s: e.nav.point([sx, sy, sz], m), g: e.nav.point([gx, gy, gz], m), reach: e.nav.reach(o.radius), body: e.movement.height }; }
      if (mode === 'none') return { mode };
      const radius = o.radius ?? e.movement.radius, dflt = astarDefaults(radius), step = o.step ?? dflt.step, maxNodes = o.maxNodes ?? dflt.maxNodes;
      // A* may wander this far beyond the start-goal box; bounded by how far maxNodes cells can reach
      const m = Math.min(step * Math.sqrt(maxNodes / Math.PI), 16 + Math.hypot(gx - sx, gz - sz) / 2);
      for (let tx = tileOf(Math.min(sx, gx) - m); tx <= tileOf(Math.max(sx, gx) + m); tx++)
        for (let tz = tileOf(Math.min(sz, gz) - m); tz <= tileOf(Math.max(sz, gz) + m); tz++) take(tx + ':' + tz, tx, tz);
      const at = (x, z, y) => surfaceOr(e, x, z, y, y);
      return { mode, s: { x: sx, y: at(sx, sz, sy), z: sz }, g: { x: gx, y: gy === undefined ? undefined : at(gx, gz, gy), z: gz }, body: e.movement.height, climb: e.movement.stepHeight, radius, passes: o.passes, step, maxNodes, navPending: !!e.nav };
    });
    return { type: 'batch', key, reqs, tiles, heights, lower, trees };
  }
  /**
   * One tile of the ground, sampled here (height / water / slope and terrain trees are main-thread functions) and cached for TILE_TTL steps:
   * data = can the top floor be walked, top = its height, lower = the floors under it by cell index, { y, ok } each (null when no cell has one), trees = [x, z, r, ...] of the ground's colliders around the tile.
   */
  tile(k, tx, tz) {
    const e = this.e;
    // another collision module counts from zero, so an equal number says nothing; a new playthrough restarts the tick, so a negative age is an old tile, not a young one
    const from = e.collision;
    if (from !== this.tilesOf) { this.tiles.clear(); this.tilesOf = from; }   // the issuer beside what it issued (architecture 8.2), compared, never called
    const c = this.tiles.get(k), bv = e.collision.blockedVersion, age = c ? e.time.tick - c.at : -1;
    if (c && c.bv === bv && age >= 0 && age < TILE_TTL) return c;
    const data = new Uint8Array(TILE * TILE), top = new Float32Array(TILE * TILE), col = e.collision, trees = [], span = TILE * RES, body = e.movement.height;
    let lower = null;
    // addBlocked fields are functions and cannot go to a worker: they are sampled into this same raster (the worker sees blocked cells as unwalkable).
    // A cell counts as blocked if fn is true at its centre or on a ring of half a cell (blockedAt), so a 1 m cell never hides a thin river; bounds skip the sampling outside.
    for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
      const x = (tx * TILE + i) * RES, z = (tz * TILE + j) * RES;
      const c = j * TILE + i, free = !col.blockedAt(x, z, RES / 2), t = e.surface(x, z);
      data[c] = free && col.groundWalkable(x, z) ? 1 : 0;
      top[c] = t;
      // the ground gives floors by height only, so go down it: asked from a body under a floor (nearer is the same floor, and a ground's step is its own) it answers the next one, or the same one when that was the lowest
      for (let n = 0, y = t, b; n < MAX_FLOORS && (b = e.surface(x, z, y - body)) < y; n++, y = b) ((lower ??= {})[c] ??= []).push({ y: b, ok: free && col.groundWalkable(x, z, b) ? 1 : 0 });
    }
    // every collider that can touch a point of the tile: half diagonal + the largest character radius we expect + 1 (the same reach walkableAt uses)
    e.ground.forEachCollider?.((tx + 0.5) * span, (tz + 0.5) * span, span * 0.71 + 3, (x, z, r) => { trees.push(x, z, r); });
    const v = { data, top, lower, trees, at: e.time.tick, bv };
    this.tiles.set(k, v);
    if (this.tiles.size > 4096) for (const [kk, o] of this.tiles) if (e.time.tick - o.at >= TILE_TTL) this.tiles.delete(kk);
    return v;
  }
  /** Forget cached tiles overlapping a world box and retire batches in flight (ground:change) */
  dropTiles({ x0, z0, x1, z1 }) {
    this.ground++;   // also ends the batches in flight: key() reads it, land() recomputes them on the edited ground
    const span = TILE * RES;
    for (const k of this.tiles.keys()) {
      const [tx, tz] = k.split(':').map(Number);
      if ((tx + 1) * span + 3 >= x0 && tx * span - 3 <= x1 && (tz + 1) * span + 3 >= z0 && tz * span - 3 <= z1) this.tiles.delete(k);
    }
  }
  /** Bring the workers' mirror up to the state this batch is tagged with (broadcasts arrive before the batch: one message queue per worker) */
  mirror({ key, reqs }) {
    const e = this.e, sent = this.sent.meshes;
    this.lane ??= e.threads.lane({ create: () => new Worker(new URL('./pathWorker.js', import.meta.url), { type: 'module' }), local: pathHandler });
    if (key[0] === 'n') for (const size of new Set(reqs.map(q => q.size))) {
      const m = e.nav.meshes.get(size);
      if (sent.get(size) === e.nav.revision || !m.navMesh) continue;
      sent.set(size, e.nav.revision);
      this.lane.broadcast({ type: 'mesh', size, version: e.nav.version, data: e.nav.exportMesh(m), links: m.links }, 'mesh' + size);
    }
    if (key[0] === 'g' && this.sent.ver !== e.collision.version) {
      this.sent.ver = e.collision.version;
      const items = [];
      e.collision.forEachStatic((type, o) => items.push(type === 'box' ? { x: o.x, y: o.y, z: o.z, h: o.h, r: o.r, c: o.c, s: o.s, hw: o.hw, hd: o.hd, ly: o.ly, box: true } : { x: o.x, z: o.z, r: o.r, ly: o.ly, box: false }));
      this.lane.broadcast({ type: 'colliders', items }, 'colliders');
    }
  }
  /** Due step: worker answer if it arrived and the walkable state is unchanged, else the same solver here on the current state */
  land(batch, list, r) {
    if (this.stopped) return;
    const e = this.e, key = this.key();
    if (!r || key !== batch.key) r = solveBatch(key === batch.key ? batch : this.build(list), { meshes: e.nav?.meshes, grid: e.collision?.grid });
    list.forEach((h, i) => {
      if (h.canceled) return;
      const from = { x: h.sx, y: h.sy, z: h.sz }, to = { x: h.gx, y: h.gy, z: h.gz }, a = sourcePath(e, this.rule, from, to, h.o) ?? r[i];
      if (a.path) withHeights(e, a.path, from, to);
      try { h.done(a.path, a.status); } catch (err) { reportError(e, err, 'findPathAsync done', { soft: true }); }   // one request's throw must not leave the rest of the batch without an answer
    });
  }
}
