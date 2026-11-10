// Async pathfinding batch solver: the same code answers in the path worker (pathWorker.js), in the lane's main-thread fallback,
// and in engine.commits' fallback when a worker reply is late (pathAsync.js). Worker-safe: no three.js, no engine objects.
// A batch carries everything that is not mirrored in the worker: start / goal (with ground heights), and for A* a raster of the ground half of walkability, every floor of it.
// The worker mirrors the rest: the navmesh of every body size a batch asked for (imported from the bytes the nav module exports) and the collision module's colliders (rebuilt into the same grid).
import { findPath as astar, astarDefaults } from './astar.js';
export { astarDefaults };
import { CollisionGrid, gridBlocks } from '../collision/grid.js';
import { navSearch } from '../nav/navPath.js';
import { layerUnder } from '../../core/scene/floor.js';

/** Ground raster (height, water, slope): RES-meter cells, TILE x TILE cells per tile, keyed `${tx}:${tz}`; a cell's top floor is in flat arrays, the floors under it, few cells have any, in a sparse list */
export const RES = 1, TILE = 32;
export const tileOf = v => Math.floor(Math.round(v / RES) / TILE);

const TOP = { y: 0, ok: 0 };   // the answer for a cell's top floor: the search asks for every node, so it must not allocate

/**
 * The floor of a batch's ground a walker at height y comes to at (x, z), { y, ok } (nearest cell), the snapshot of what engine.surface(x, z, y) and the ground half of walkableAt
 * say on the main thread: no y is the top floor. Null outside the sent tiles, which counts as blocked: both sides see the same tiles.
 */
function floorAt({ tiles, heights, lower }, x, z, y, climb) {
  const ix = Math.round(x / RES), iz = Math.round(z / RES), tx = Math.floor(ix / TILE), tz = Math.floor(iz / TILE), k = tx + ':' + tz, ok = tiles[k];
  if (!ok) return null;
  const i = (iz - tz * TILE) * TILE + (ix - tx * TILE), top = heights[k][i], under = y === undefined || top <= y + climb ? undefined : lower[k]?.[i];
  if (under) return layerUnder(under, y + climb);
  TOP.y = top; TOP.ok = ok[i];
  return TOP;
}

/** Walkability from a batch: ground shape from the floor the walker is on, colliders tested exactly: the ground's own (terrain trees, sent with the batch) and the collision module's (mirrored grid) */
function snapshotWalkable(batch, q, grid, trees) {
  return (x, z, y) => !!floorAt(batch, x, z, y, q.climb)?.ok && !gridBlocks(trees, x, z, q.radius) && !(grid && gridBlocks(grid, x, z, q.radius, y, q.body, q.passes));
}

/** The worker's engine.surface(x, z, y); no ground there (the void of terrain({ shape }), or outside the sent tiles) leaves the walker at its height, as surfaceOr does */
function snapshotFloor(batch, q) {
  return (x, z, y) => { const f = floorAt(batch, x, z, y, q.climb); return !f || f.y === -Infinity ? y : f.y; };
}

/**
 * Answer every request of a batch: [{ status, path }...] in request order.
 * @param {{ reqs: any[], tiles: Record<string, Uint8Array>, heights: Record<string, Float32Array>, lower: Record<string, Record<number, { y: number, ok: number }[]>> }} batch
 * @param {{ meshes: Map<any, any>, grid: any }} ctx navmeshes (query, navMesh, links) by size and collider grid (live ones on the main thread, mirrored ones in the worker)
 */
export function solveBatch(batch, ctx) {
  let trees = null;
  return batch.reqs.map(q => {
    if (q.mode === 'nav') return navSearch(ctx.meshes.get(q.size), q.s, q.g, q.reach, q.body);
    if (q.mode !== 'grid') return { status: 'notReady', path: null };
    if (!trees) { trees = new CollisionGrid(); for (let i = 0; i < batch.trees.length; i += 3) trees.add({ x: batch.trees[i], z: batch.trees[i + 1], r: batch.trees[i + 2] }, false); }
    const floor = q.s.y === undefined ? undefined : snapshotFloor(batch, q);   // undefined: no height to follow, A* keeps its default
    const path = astar(snapshotWalkable(batch, q, ctx.grid, trees), q.s.x, q.s.z, q.g.x, q.g.z, { ...q, y: q.s.y, goalY: q.g.y, floor });
    return { status: q.navPending ? 'notReady' : path ? 'ok' : 'noPath', path };
  });
}

/**
 * Lane handler: { type: 'mesh', size, version, data, links } (the navmesh of a body size as bytes, the links its connections index; a new version drops the sizes of the old mesh), { type: 'colliders', items }, { type: 'batch', reqs, tiles } → results.
 * @param {() => Promise<any> | any} load gives the Recast module: the worker passes its static import (a worker bundle cannot split chunks);
 * the main-thread fallback imports it on demand so games without nav never download it
 */
export function pathHandler(load = () => import('@recast-navigation/core')) {
  const ctx = { meshes: new Map(), grid: null };
  let lib = null, chain = Promise.resolve(), version = -1;
  // Recast loads asynchronously; every message waits for the ones before it, so a batch always sees the mesh / colliders sent before it
  const then = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };   // one failed message must not block the rest
  return msg => {
    if (msg.type === 'mesh') return void then(async () => {
      if (!lib) { const m = await load(); await m.init(); lib = m; }
      const drop = size => { const m = ctx.meshes.get(size); m?.query.destroy(); m?.navMesh.destroy(); ctx.meshes.delete(size); };
      if (msg.version !== version) { [...ctx.meshes.keys()].forEach(drop); version = msg.version; }
      drop(msg.size);
      const navMesh = lib.importNavMesh(msg.data).navMesh;
      ctx.meshes.set(msg.size, { navMesh, query: new lib.NavMeshQuery(navMesh), links: msg.links });
    });
    if (msg.type === 'colliders') return void then(() => { const g = new CollisionGrid(); for (const it of msg.items) g.add(it, it.box); ctx.grid = g; });
    return then(() => solveBatch(msg, ctx));
  };
}
