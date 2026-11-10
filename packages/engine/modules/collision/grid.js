// Grid index of colliders: register each by bounding circle in the cells it covers; queries look at a few nearby cells instead of scanning all colliders.
// Results are ordered circles first, then boxes, each in insertion order, exactly the callback order of a linear scan (resolve edits the position in turn, so a different order changes the result).
// Worker-safe (no three.js, no engine objects): the path worker (characters/pathJob.js) rebuilds the same grid from the colliders it mirrors.
// Collider layers live here too (passesOf, passesThrough): every reader of colliders, the worker and nav included, asks the same two functions.
import { codedError } from '../../core/base/errorHints.js';
const CELL = 8, MAX_CELLS = 64, KEY = 1048576;   // colliders too large (covering > 64 cells) skip the grid and are scanned linearly, so registration cost does not blow up
/** Does a body with its feet at y reach this box? A box without a y of its own is a footprint, and a body without y is anywhere: both hit. Written so an undefined on either side falls through to true */
export const bodyHits = (it, y, body) => !(y >= it.y + it.h || y + body <= it.y);
/**
 * A mover's passes option (character option; findPath, findPathAsync and walkable option): the collider layers it goes through. Read here for every entry,
 * sorted and without repeats so one set is one navmesh, never two. Left out or empty: undefined, which every reader takes as "stopped by everything", as before
 */
export function passesOf(where, v) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every(n => typeof n === 'string' && n)) throw codedError('collision-misuse', `${where}: passes is a list of collider layer names, e.g. passes: ['gate']; got ${JSON.stringify(v)}`, TypeError);
  return v.length ? Object.freeze([...new Set(v)].sort()) : undefined;
}
/**
 * Does a mover go through this collider: it has a layer (addBox / addCircle { layer }) and the mover's passes list names it. The one test every reader
 * of colliders makes (resolve, walkableAt, A* here and in the worker, the navmesh cut per passes list, the rapier mover), so they cannot disagree.
 * A collider without a layer, or a mover without passes, answers false on the first comparison: what existed before costs one undefined check.
 */
export const passesThrough = (it, passes) => it.ly !== undefined && passes !== undefined && passes.includes(it.ly);

const byOrder = (a, b) => a._b - b._b || a._o - b._o;

/** Cell span [x0, x1, z0, z1] that an item (x, z, r) covers */
const cellRange = it => [Math.floor((it.x - it.r) / CELL), Math.floor((it.x + it.r) / CELL), Math.floor((it.z - it.r) / CELL), Math.floor((it.z + it.r) / CELL)];

/** Add it to out once per query (stamp st) when its circle overlaps the query circle; module-level so query() builds no closure */
function take(out, it, x, z, range, st) {
  if (it._q === st) return;
  it._q = st;
  const dx = it.x - x, dz = it.z - z, rr = range + it.r;
  if (dx * dx + dz * dz < rr * rr) out.push(it);
}

export class CollisionGrid {
  constructor() { this.cells = new Map(); this.big = new Set(); this.seq = 0; this.stamp = 0; this.out = []; }
  /** Register; item needs x, z, r. isBox puts it after circles in the callback order */
  add(item, isBox) {
    item._o = this.seq++; item._b = isBox ? 1 : 0;
    const [x0, x1, z0, z1] = cellRange(item);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS) { this.big.add(item); return; }
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i * KEY + j; let c = this.cells.get(k); if (!c) this.cells.set(k, c = []); c.push(item);
    }
  }
  remove(item) {
    if (this.big.delete(item)) return;
    const [x0, x1, z0, z1] = cellRange(item);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i * KEY + j, c = this.cells.get(k); if (!c) continue;
      // swap-remove: order inside a cell does not matter (query sorts by insertion order), and splice shifted the rest of a crowded cell every time
      const at = c.indexOf(item); if (at < 0) continue;
      c[at] = c[c.length - 1]; c.pop(); if (!c.length) this.cells.delete(k);
    }
  }
  /** Colliders intersecting the circle at (x, z) with radius range (exactly filtered, sorted). The returned array is reused by the next query, do not keep it */
  query(x, z, range) {
    const out = this.out; out.length = 0;
    const st = ++this.stamp;
    for (const it of this.big) take(out, it, x, z, range, st);
    const x0 = Math.floor((x - range) / CELL), x1 = Math.floor((x + range) / CELL), z0 = Math.floor((z - range) / CELL), z1 = Math.floor((z + range) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const c = this.cells.get(i * KEY + j);
      if (c) for (let k = 0; k < c.length; k++) take(out, c[k], x, z, range, st);
    }
    if (out.length > 1) out.sort(byOrder);
    return out;
  }
}

/**
 * Does a collider in the grid block a character of `radius` standing at (x, z)? The obstacle half of Collision.walkableAt,
 * shared with the pathfinding worker (it rebuilds a grid from the same colliders), so both answer identically. Worker-safe.
 * y, body: the feet and height of the character; a box on another floor does not block it. Left out, every box blocks. passes: the mover's layer list (passesThrough).
 */
export function gridBlocks(grid, x, z, radius, y, body, passes) {
  for (const it of grid.query(x, z, radius + 1)) {
    if (passesThrough(it, passes)) continue;
    if (!it._b) { if (Math.hypot(x - it.x, z - it.z) < radius + it.r) return true; continue; }
    if (!bodyHits(it, y, body)) continue;
    const dx = x - it.x, dz = z - it.z, lx = dx * it.c - dz * it.s, lz = dx * it.s + dz * it.c;
    if (Math.abs(lx) < it.hw + radius && Math.abs(lz) < it.hd + radius) return true;
  }
  return false;
}
