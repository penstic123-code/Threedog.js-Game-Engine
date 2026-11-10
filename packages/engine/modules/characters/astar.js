// Grid A* pathfinding (fallback when no navmesh is installed or it is not ready yet). The one A* in the engine:
// engine.characters.findPath calls it with the collision module's walkability, the pathfinding worker (pathJob.js) with a snapshot of it.
// In games use engine.characters.findPath / findPathAsync, do not import this directly. Worker-safe: its one import, floor.js, has none.
import { sameFloor } from '../../core/scene/floor.js';

/** Default cell size from the character radius: a small character gets finer cells (never below the 1 m ground raster, never above the old 2 m); no radius = 2 */
const defaultStep = r => r == null ? 2 : Math.min(2, Math.max(1, r * 4));
const defaultNodes = step => Math.round(6000 * Math.max(1, 2 / step) ** 2);   // finer cells need more of them to cover the same distance
/** The step / maxNodes findPath uses for a character radius when the caller gives none (pathAsync sizes its ground raster with the same numbers) */
export const astarDefaults = radius => { const step = defaultStep(radius); return { step, maxNodes: defaultNodes(step) }; };

const sameHeight = (x, z, y) => y;

class MinHeap {
  constructor() { this.a = []; }
  push(n, f, g) { const a = this.a; a.push([f, n, g]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

/**
 * Grid A*: cells of step meters, searches at most maxNodes cells; returns [{ x, y?, z }...] or null if no path.
 * Height rides along: a node is a cell and a floor, the one a walker coming from the cell before ends up on, so a walker downstairs is measured against downstairs and a deck
 * passed under is still reached by the ramp up to it. Floors are told apart by the exact height floor() answers: every way onto one layer gets the same number.
 * shortcut: a floor change here is walking up a slope, a step at a time; a stair steeper than a step per cell, a ladder or a jump needs nav, or the characters.path rule.
 * @param {(x: number, z: number, y?: number) => boolean} walkable can a character stand here (radius already applied)
 * @param {{ radius?: number, step?: number, maxNodes?: number, y?: number, goalY?: number, floor?: (x: number, z: number, y?: number) => number | undefined, body?: number }} [o] y: the floor of the start; goalY: the height of the goal, none = any floor; floor: the height a walker at y comes to at (x, z), default stays at y; body: engine.movement.height, what sameFloor measures with
 */
export function findPath(walkable, sx, sz, gx, gz, { radius, step = defaultStep(radius), maxNodes = defaultNodes(step), y, goalY, floor = sameHeight, body = Infinity } = {}) {
  const sample = 0.12;   // smoothing samples a segment every 0.12 m: one radius apart (the old rule) let a straight leg clip a wall corner by up to 0.3 m between two samples
  if (!walkable(gx, gz, goalY ?? floor(gx, gz, y))) return null;   // a target inside a wall / water is unreachable: say so instead of a path that ends in the wall
  const key = (i, j) => i * 100003 + j, level = (a, b) => a === b || sameFloor(a, b, body);
  const si = Math.round(sx / step), sj = Math.round(sz / step), gi = Math.round(gx / step), gj = Math.round(gz / step);
  const open = new MinHeap(), cells = new Map();   // cell -> its first node; other floors of the cell hang on .next (nearly every cell has one floor)
  const add = (k, i, j, y) => { const n = { i, j, y, g: Infinity, from: null, ok: false, next: cells.get(k) ?? null }; cells.set(k, n); return n; };
  /** The node a walker at height y comes to in cell (i, j): walkable() runs once per floor */
  const reach = (i, j, y) => {
    const k = key(i, j), fy = floor(i * step, j * step, y);
    let n = cells.get(k);
    while (n && n.y !== fy) n = n.next;
    if (!n) { n = add(k, i, j, fy); n.ok = walkable(i * step, j * step, fy); }
    return n;
  };
  const h = (i, j) => Math.hypot(i - gi, j - gj);
  const first = add(key(si, sj), si, sj, y); first.g = 0; open.push(first, h(si, sj), 0);
  let n = 0;
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (open.size && n++ < maxNodes) {
    const [, s, at] = open.pop();
    if (at > s.g) { n--; continue; }   // a cheaper way here was found after this entry went in: expanding it would change nothing
    // under the goal, on another floor: not there yet, the way up may be further on
    if (s.i === gi && s.j === gj && (goalY === undefined || s.y === undefined || level(floor(gx, gz, s.y), floor(gx, gz, goalY)))) {
      const path = [];
      for (let c = s; c; c = c.from) path.push({ x: c.i * step, y: c.y, z: c.j * step });
      path.reverse(); path[0] = { x: sx, y, z: sz }; path[path.length - 1] = { x: gx, y: s.y, z: gz };   // real start, not the snapped cell centre (which may even lie behind a wall)
      const out = simplify(walkable, floor, level, path, sample);
      out[out.length - 1] = { x: gx, z: gz };   // the goal's height is the caller's
      return out;
    }
    for (const [di, dj, c] of dirs) {
      const ni = s.i + di, nj = s.j + dj, t = reach(ni, nj, s.y);
      if (!t.ok && !(ni === gi && nj === gj)) continue;
      const ng = s.g + c;
      // the cells being free says nothing about the way between them: a thin wall or fence lies between two free cell centres. Checked only for a step that would improve the cell, sampled
      // every third of a cell (smoothing below samples finer). The first and last leg run from the real start / to the real goal, as the path does: a cell centre may lie behind a wall
      if (ng < t.g) {
        const from = s === first ? { x: sx, y, z: sz } : { x: s.i * step, y: s.y, z: s.j * step }, to = ni === gi && nj === gj ? { x: gx, y: t.y, z: gz } : { x: ni * step, y: t.y, z: nj * step };
        if (lineClear(walkable, floor, level, from, to, step / 3)) { t.g = ng; t.from = s; open.push(t, ng + h(ni, nj), ng); }
      }
    }
  }
  return null;
}
// drop redundant corners: go straight when two points are directly walkable
function simplify(walkable, floor, level, path, sample) {
  if (path.length < 3) return path;
  const out = [path[0]];
  let a = 0;
  while (a < path.length - 1) {
    let b = path.length - 1;
    while (b > a + 1 && !lineClear(walkable, floor, level, path[a], path[b], sample)) b--;
    out.push(path[b]); a = b;
  }
  return out;
}
/** Can a walker go straight from p to q, and does it come out on q's floor: under a deck the line is clear, and ends below the point it was for */
function lineClear(walkable, floor, level, p, q, sample) {
  const d = Math.hypot(q.x - p.x, q.z - p.z), n = Math.ceil(d / sample);
  let y = p.y;
  for (let i = 1; i < n; i++) { const t = i / n, x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t; y = floor(x, z, y); if (!walkable(x, z, y)) return false; }
  return level(floor(q.x, q.z, y), q.y);
}
