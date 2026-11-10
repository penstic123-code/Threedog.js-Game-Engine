// Navmesh (Recast): generated after a level loads; engine.characters.findPath switches to it automatically (falls back to A* when not installed).
//   engine.use(level({ url }), collision(), characters(), nav({ agentRadius: 0.4 }));
// Once installed, engine.nav offers findPath(from, to) and the native objects navMesh / query / tileCache / crowd / helper.
// version: +1 on every rebuild / unload. Native objects (crowd agents etc.) are destroyed on rebuild; code that cached them keeps the object and compares it (NPCs compare crowd): version counts per module, so a replaced nav can show the same number.
//
// Where the mesh comes from: the ground API's staticTrimeshes() (the level's walkable mesh).
// Walls and obstacles: boxes/circles in the collision module (level col_ boxes, ones added by game collision.addBox) are all synced into TileCache dynamic obstacles,
// and affected tiles are rebuilt on add/remove, so level walls and later-added obstacles work the same way.
// Levels only for now (ground with staticTrimeshes); procedural terrain keeps using A*. Recast (728 KB, 218 KB gzipped) starts loading when nav() is installed.
// The mesh is built once per level: ground edits (engine.terrain.edit, 'ground:change') do not update it, so paths keep following the ground as it was
// at level load (rebuilding all tiles per edit is too slow to do automatically). A game that reshapes walkable ground at runtime leaves nav out:
// characters.findPath then uses A*, which resamples the edited area (its rasters are dropped on 'ground:change').
// Body sizes: Recast bakes the body's radius into the mesh, so a mesh is good for one size (Recast's own advice, and what Unreal's supported agents do: one mesh per size).
// api itself is the mesh of agentRadius; a findPath for another radius gets its own, built the first time that size is asked for and kept in api.meshes until the next rebuild or unload.
// Radii that round to the same cells share one. Each has its own tile cache, obstacles and seated links; revision covers them all, and a game with one size pays for nothing else.
// Collider layers (collision.addBox { layer }) work the same way: a path for a body that passes some layers gets a mesh where colliders of those layers cut nothing,
// keyed by size and layer list. Why a mesh and not a Detour query filter: the tile cache cuts an obstacle out of the mesh for every query, and an obstacle that only
// marks polygons is not in this Recast build; Godot's advice for agents that need different geometry is the same, a map of their own. A game without layers builds none.
// shortcut: built on the main thread when first asked for, which stalls that step; move to a worker (or a list of sizes built at load) if a real level's build shows up in a frame.
// Links (Recast off-mesh connections): nav({ links: [{ id, from, to }] }) joins two places a walker cannot walk between, a gap to jump or a ladder to climb.
// generateTileCache has no offMeshConnections option (generateTiledNavMesh does), so they go in through the tile cache's mesh process, which Detour runs for
// every tile it builds: a tile rebuilt around an obstacle gets them back the same way. They live in the tile data, so exportMesh carries them to the path worker.
import { readParams, keysSchema } from '../../core/base/params.js';
import { xzOf, yOf } from '../../core/base/math.js';
import { follows } from '../../core/base/follows.js';
import { navSearch, OPTS } from './navPath.js';
import { sameFloor } from '../../core/scene/floor.js';
import { warnOnce } from '../../core/base/validate.js';
import { coded, codedError } from '../../core/base/errorHints.js';
import { passesOf, passesThrough } from '../collision/grid.js';

const NAV_PARAMS = keysSchema(['cellSize', 'agentRadius', 'agentHeight', 'maxClimb', 'maxSlope', 'tileSize', 'crowd', 'debug', 'maxObstacles', 'maxAgents', 'arrive', 'links']);
const LINK_PARAMS = keysSchema(['id', 'from', 'to', 'oneWay', 'radius']);
const ANY_FLOOR = { halfExtents: { ...OPTS.halfExtents, y: 1e4 } };   // the search's reach sideways, every floor up and down: what stands at this spot, however far the height given is
const BASE = 'agent';   // the size of the mesh cut for agentRadius, which is api itself: cells alone can't name it, a wider body in the same cells needs more room round an obstacle
const NO_LINK = -1;   // Detour's DT_NULL_LINK, the end of a polygon's link list: 0xffffffff in C++, but the wrapper reads it back signed

export function nav(opts = {}) {
  readParams('nav', NAV_PARAMS, opts);
  // maxObstacles / maxAgents: Recast's fixed capacities (a city of 3000 wall pieces needs more than a village; a crowd scene more than 128 agents).
  // arrive: meters past the character's radius a path may end short of its goal and still count as arrived (a ledge-strict platformer wants less)
  const { cellSize = 0.3, tileSize = 32, crowd = false, debug = false, maxObstacles = 1024, maxAgents = 128, arrive = 0.6, links = [] } = opts;
  for (const l of links) readParams('nav links', LINK_PARAMS, l);
  // agent size defaults come from engine.movement (filled at install); opts values override them
  let agentRadius, agentHeight, maxClimb, maxSlope;
  let revision = 0;
  let e = null, lib = null, gen = null, pending = false, wasm = null;   // wasm: the recast import + init begun at install
  const processes = new Map();   // size -> what runs for every tile built, with links only: without them the generator's default is the same thing
  const cellsOf = r => Math.ceil(+(r / cellSize).toFixed(6));   // rounded first: 0.9 / 0.3 is a hair over 3

  const api = {
    ready: false, agent: null, links: [], navMesh: null, query: null, tileCache: null, crowd: null, helper: null,
    /** @internal this mesh's body: its size in api.meshes, walkableRadius in cells, the radius obstacles are grown by; obstacles: engine.collision.mirror, collider -> its Recast obstacles (big boxes are cut into several pieces), of the collision module obstaclesOf. A mesh of another size has these too */
    size: BASE, cells: 0, radius: 0, obstacles: null, obstaclesOf: follows(() => e?.collision ?? null),
    /** @internal size -> mesh ({ query, navMesh, links, ... }), this one included: async pathfinding looks a batch's mesh up here */
    meshes: new Map(),
    /** +1 on rebuild / unload: code that cached native objects such as crowd agents must re-create them when it changes */
    version: 0,
    /**
     * Path [{ x, z }...] (meters) from `from` to `to`; null if not ready or unreachable.
     * Pass { detailed: true } to get { status: 'ok' | 'noPath' | 'notReady', path } instead: tells "navmesh not generated yet" from "generated but unreachable"
     */
    findPath(from, to, o = {}) {
      syncObstacles();
      const res = search(from, to, o);
      return o.detailed ? res : res.path;
    },
    /** @internal +1 whenever the walkable mesh changes (rebuild, unload, obstacle sync): async pathfinding re-sends the mesh to its workers and redoes answers computed on an older one */
    /** Any walkable change. A read of it is a read of the mesh, so it syncs first: a frozen engine runs no step, and a cached path asks here */
    get revision() { syncObstacles(); return revision; },
    /** @internal a mesh as bytes, imported by the pathfinding worker */
    exportMesh(m = api) { return lib.exportNavMesh(m.navMesh); },
    /** @internal the mesh for a body of this radius that goes through colliders of these layers, built the first time it is asked for; no radius: agentRadius. A mesh the build refused has no query, and every path on it is noPath */
    mesh(radius = agentRadius, passes) {
      if (!(radius >= 0)) throw codedError('character-option', `nav: a path's radius is a number of meters, 0 or more, got ${radius}`);
      // a structured key: a layer name may hold a comma, and joined text would make the one layer "a,b" the same body as the two layers a and b
      const c = cellsOf(radius), size = c === api.cells && radius <= agentRadius ? BASE : c, through = passesOf('nav: passes', passes), key = through ? JSON.stringify([size, ...through]) : size;
      return api.meshes.get(key) ?? extraMesh(key, size, through);
    },
    /**
     * @internal The one rule for a position given to the navmesh (search, links, async paths, crowd goals). No height: the ground. A height picks the nearest surface of the mesh at that
     * spot, which is what tells the floors of a building apart, and the point lands on it: a crowd target looks only a little way up and down. A height farther than a body from
     * every surface was not meant as a floor ([x, 0, z] on ground at 8), so it also warns. Before the mesh exists it stays as given; seatLinks asks again once it does.
     * m: the mesh the point is for: a passage only a small body fits is on no other
     */
    point(p, m = api) {
      syncObstacles();
      const [x, z] = xzOf(p), y = yOf(p);
      if (y === undefined) return { x, y: e.surface(x, z), z };
      const near = m.query?.findNearestPoly({ x, y, z }, ANY_FLOOR);
      if (!near?.success || !near.nearestRef) return { x, y, z };
      const floor = near.nearestPoint.y, r = v => +v.toFixed(2);
      if (!sameFloor(y, floor, e.movement.height)) warnOnce(coded('nav-height', `nav: height ${r(y)} at x ${r(x)}, z ${r(z)} is on no floor, so ${r(floor)} is used, the nearest walkable surface there`), 'nav-height');
      return { x, y: floor, z };
    },
    /** @internal how far (m) a search may end from its goal for a body of this radius; the path search and the worker read it */
    reach(radius) { return (radius ?? agentRadius) + arrive; },
    /** Unload the navmesh (frees native objects); afterwards characters.findPath falls back to A* */
    dispose() {
      api.ready = false; api.version++; revision++;
      if (api.helper) e.remove(api.helper);   // the debug mesh is built by us: remove it completely
      api.crowd?.destroy();
      for (const m of api.meshes.values()) { m.tileCache?.destroy(); m.navMesh?.destroy(); m.query?.destroy(); }
      Object.assign(api, { navMesh: null, query: null, tileCache: null, crowd: null, helper: null });
      api.obstacles?.clear();
      api.meshes.clear(); api.meshes.set(BASE, api);
    },
  };

  function search(from, to, o) {
    if (!api.ready) return { status: 'notReady', path: null };
    const m = api.mesh(o.radius, o.passes);
    return navSearch(m, api.point(from, m), api.point(to, m), api.reach(o.radius), e.movement.height);
  }

  /** Walkable triangle mesh of the ground (world coordinates), merged into one */
  function geometry() {
    const G = e.ground;
    const list = G.staticTrimeshes?.() || [];
    let n = 0, m = 0;
    for (const t of list) { n += t.positions.length; m += t.indices.length; }
    const positions = new Float32Array(n), indices = new Uint32Array(m);
    let pn = 0, im = 0;
    for (const t of list) { positions.set(t.positions, pn); for (let i = 0; i < t.indices.length; i++) indices[im + i] = t.indices[i] + pn / 3; pn += t.positions.length; im += t.indices.length; }
    return { positions, indices };
  }

  /** The links with their ends in 3D (a y left out is the ground there) and the catch radius: the mesh stops the agent radius, rounded up to cells, plus up to a cell short of an edge, and a ladder stands a little off that edge */
  function placeLinks(m) {
    return links.map((l, i) => ({ id: l.id ?? i, from: api.point(l.from, m), to: api.point(l.to, m), oneWay: !!l.oneWay, radius: l.radius ?? m.radius + cellSize * 3 }));
  }
  /**
   * The mesh process with the links that start in the tile being built. Detour keeps a connection only in its start's tile, and the wrapper's copy of the list
   * is never freed (nothing runs after this callback), so passing only those keeps that to a few bytes per link instead of the whole list for every tile.
   */
  function linkProcess(size) {
    if (!processes.has(size)) processes.set(size, new lib.TileCacheMeshProcess((params, areas, flags) => {
      for (let i = 0; i < params.polyCount(); i++) { areas.set(i, 0); flags.set(i, 1); }
      const raw = params.raw, inside = (v, a) => v >= raw.get_bmin(a) && v < raw.get_bmax(a), mine = [];
      api.meshes.get(size).links.forEach((l, i) => { if (inside(l.from.x, 0) && inside(l.from.z, 2)) mine.push({ startPosition: l.from, endPosition: l.to, radius: l.radius, bidirectional: !l.oneWay, userId: i }); });
      params.setOffMeshConnections(mine);
    }));
    return processes.get(size);
  }
  /** The indexes of the links attached at both ends */
  function joinedLinks(m) {
    const mesh = m.navMesh, joined = new Set();
    for (let t = 0; t < mesh.getMaxTiles(); t++) {
      const tile = mesh.getTile(t), h = tile.header();
      for (let i = 0; h && i < h.offMeshConCount(); i++) {
        let ends = 0;
        for (let k = tile.polys(h.offMeshBase() + i).firstLink(); (k | 0) !== NO_LINK; k = tile.links(k).next()) ends++;
        if (ends >= 2) joined.add(tile.offMeshCons(i).userId());
      }
    }
    return joined;
  }
  /** Where an end meets the ground it reaches: on that ground and inside its tile (a tile's far edge belongs to the next one), or the end as given when it reaches none */
  function seat(m, p, radius) {
    const near = m.query.findNearestPoly(p, { halfExtents: { x: radius, y: maxClimb, z: radius } });
    if (!near.success || !near.nearestRef) return p;
    const h = m.navMesh.getTileAndPolyByRef(near.nearestRef).tile.header(), { x, y, z } = near.nearestPoint, pad = cellSize / 4;
    const within = (v, axis) => Math.min(Math.max(v, h.bmin(axis) + pad), h.bmax(axis) - pad);
    return { x: within(x, 0), y, z: within(z, 2) };
  }
  /**
   * Links on the finished mesh. Detour files an end under the tile its x, z fall in and looks for ground in that tile alone, so an end beside a tile's edge with its
   * ground across the edge stays loose (a ladder under a deck that starts in the next tile), and a start in a tile with no ground is dropped. Each end moves onto its
   * ground, and the tiles its start left and joined are rebuilt with it. m.links is then where walkers really step on and land, which a crowd NPC reads. On the ground
   * an end needs no reach beyond a cell or two, so an obstacle standing on it cuts the link and does not leave it hooked to ground past the obstacle.
   * A link Detour still could not attach at both ends does nothing, silently: say so once, at the build. Only for agentRadius: a ledge too narrow for a wide body is that body's limit, not the game's mistake.
   */
  function seatLinks(m) {
    if (!m.links.length) return;
    const tiles = new Map(), note = p => { const t = m.navMesh.calcTileLoc(p), x = t.tileX(), y = t.tileY(); tiles.set(`${x},${y}`, [x, y]); };
    for (const l of m.links) { note(l.from); l.from = seat(m, api.point(l.from, m), l.radius); l.to = seat(m, api.point(l.to, m), l.radius); l.radius = cellSize * 2; note(l.from); }
    for (const [x, y] of tiles.values()) m.tileCache.buildNavMeshTilesAt(x, y, m.navMesh);
    if (m !== api) return;
    const joined = joinedLinks(m);
    m.links.forEach((l, i) => { if (!joined.has(i)) warnOnce(coded('nav-link', `nav: link "${l.id}" does not join the mesh at both ends, so no path uses it`)); });
  }

  /** Cut the mesh of m's body out of the ground; false when Recast refuses */
  function cut(m, { positions, indices }) {
    const ch = cellSize / 2;
    m.links = placeLinks(m);
    const r = gen.generateTileCache(positions, indices, {
      cs: cellSize, ch, tileSize, expectedLayersPerTile: 4, maxObstacles, tileCacheMeshProcess: links.length ? linkProcess(m.size) : undefined,
      walkableSlopeAngle: maxSlope, walkableHeight: Math.ceil(agentHeight / ch), walkableClimb: Math.ceil(maxClimb / ch), walkableRadius: m.cells,
    });
    if (!r.success) { warnOnce(coded('nav-build', 'nav: ' + r.error)); return false; }
    m.tileCache = r.tileCache; m.navMesh = r.navMesh;
    m.query = new lib.NavMeshQuery(r.navMesh);
    seatLinks(m);
    return true;
  }

  /**
   * The mesh of a size (and layer list) no one asked for before; key names it in api.meshes. The whole cell counts as its radius: it stands for every body that rounds to it, the agent's own size keeps the agent's.
   * passes: colliders of these layers cut nothing in it. It takes no part in revision: nothing walkable changed, and async pathfinding sends each mesh when a batch first needs it
   */
  function extraMesh(key, size, passes) {
    const cells = size === BASE ? api.cells : size, m = { size: key, cells, radius: size === BASE ? api.radius : cells * cellSize, passes, links: [], tileCache: null, navMesh: null, query: null, obstacles: null, obstaclesOf: follows(() => e.collision ?? null) };
    api.meshes.set(key, m);
    if (cut(m, geometry())) syncMesh(m);
    return m;
  }

  async function build() {
    pending = false;
    if (api.ready) api.dispose();
    const ground = geometry();
    if (!ground.indices.length || !cut(api, ground)) return;
    if (crowd) api.crowd = new lib.Crowd(api.navMesh, { maxAgents, maxAgentRadius: agentRadius * 2 });
    api.ready = true; api.version++; revision++;
    syncObstacles();
    if (debug) {
      const built = api.navMesh, three = await import('@recast-navigation/three');
      if (api.navMesh !== built) return;   // unloaded or rebuilt while the import ran: that mesh is gone (dispose clears it), a helper of it would draw freed data
      api.helper = new three.NavMeshHelper(api.navMesh);
      api.helper.position.y = 0.05; e.add(api.helper, { owner: 'engine:nav' });
    }
  }

  // collision-module colliders -> TileCache obstacles (engine.collision.mirror diffs add / remove, shared with rigid), then rebuild affected tiles
  function obstacle(m, type, o) {
    const tc = m.tileCache, list = [];
    if (passesThrough(o, m.passes)) return list;   // a gate this mesh's bodies walk through: no piece, and remove() has nothing to drop
    const y = (o.y ?? e.surface(o.x, o.z)) - maxClimb, h = (o.h ?? 6) + maxClimb;   // extend a bit downward: Recast ignores a bottom face lying exactly on the ground
    if (type === 'box') {
      // one obstacle affects at most 8 tiles: cut big boxes into pieces no larger than half a tile (along the box's own orientation)
      const hw = o.hw + m.radius, hd = o.hd + m.radius, piece = tileSize * cellSize / 2;   // add the agent radius so agents don't hug walls
      const nx = Math.ceil(hw * 2 / piece), nz = Math.ceil(hd * 2 / piece), c = Math.cos(o.rot), sn = Math.sin(o.rot);
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const lx = -hw + (i + 0.5) * hw * 2 / nx, lz = -hd + (j + 0.5) * hd * 2 / nz;
        const res = tc.addBoxObstacle({ x: o.x + lx * c + lz * sn, y: y + h / 2, z: o.z - lx * sn + lz * c }, { x: hw / nx, y: h / 2, z: hd / nz }, -o.rot);   // Detour's rotation direction is opposite to three's
        if (res.success) list.push(res.obstacle);
      }
    } else {
      const res = tc.addCylinderObstacle({ x: o.x, y, z: o.z }, o.r + m.radius, h);
      if (res.success) list.push(res.obstacle);
    }
    queued += list.length;
    if (queued >= BATCH) flush(m);
    return list;
  }
  /** One mesh's obstacles up to date; true when any changed */
  function syncMesh(m) {
    if (!m.tileCache) return false;
    const col = e.collision ?? null, swapped = m.obstaclesOf.sync(() => { m.obstacles?.clear(true); m.obstacles = null; });
    if (!col && !swapped) return false;
    m.obstacles ??= col?.mirror({ add: (type, o) => obstacle(m, type, o), remove: list => { for (const ob of list) { m.tileCache.removeObstacle(ob); if (++queued >= BATCH) flush(m); } } }) ?? null;
    if (!m.obstacles?.sync() && !swapped) return false;
    flush(m);
    return true;
  }
  function syncObstacles() {
    if (!api.ready) return;
    let changed = false;
    for (const m of api.meshes.values()) changed = syncMesh(m) || changed;
    if (!changed) return;
    revision++;
    api.helper?.update();
  }
  // obstacle requests are processed once a batch has built up, until all tiles are rebuilt
  const BATCH = 48;
  let queued = 0;
  function flush(m) { queued = 0; for (let i = 0; i < 256 && !m.tileCache.update(m.navMesh).upToDate; i++); }

  return {
    name: 'nav', skipKind: 'none', type: 'world', provides: ['nav'], optional: { collision: 'walls and obstacles are not cut out of the navmesh', level: 'no walkable mesh to build from, so paths stay on A*' }, params: NAV_PARAMS, options: opts, label: 'Navmesh',
    install(engine, ctx) {
      e = engine;
      e.i18n.add({ 'zh-CN': { 'module.nav': '导航网格' }, en: { 'module.nav': 'navmesh' } });
      const mv = e.movement;
      ({ agentRadius = mv.radius, agentHeight = mv.height, maxClimb = mv.stepHeight, maxSlope = mv.maxSlope } = opts);
      api.agent = { radius: agentRadius, height: agentHeight, maxClimb, maxSlope };
      api.radius = agentRadius; api.cells = cellsOf(agentRadius); api.meshes.set(BASE, api);
      ctx.track(e.events.on('level:loaded', () => { if (lib) build(); else pending = true; }));
      ctx.track(e.events.on('level:unloaded', () => { pending = false; if (api.ready) api.dispose(); }));   // every size was cut from the level that left
      pending = !!e.level?.ready;   // installed after the level loaded: that event is gone, init builds the mesh
      // fetch and compile the WASM from install on, so it loads while the page builds the world instead of inside start()'s module inits
      wasm = Promise.all([import('@recast-navigation/core'), import('@recast-navigation/generators')]).then(async ([l, g]) => { await l.init(); return [l, g]; });
      wasm.catch(() => {});   // a failure is reported by init (which awaits the same promise), not as an unhandled rejection here
      return api;
    },
    async init() {
      [lib, gen] = await wasm;
      if (pending) await build();
    },
    isReady() { return !!lib && !pending; },
    fixed(dt) {
      syncObstacles();
      api.crowd?.update(dt);
    },
    describe() { return { ready: api.ready, version: api.version, obstacles: api.obstacles?.size ?? 0, links: api.links.length, meshes: api.ready ? api.meshes.size : 0 }; },
    // engine.dispose(): the Recast navMesh / query / tileCache / crowd live in the WASM heap, not in JS, so the garbage collector never frees
    // them; an editor or test that makes engines over and over would grow that heap every time
    dispose() { api.dispose(); },
  };
}

export const handRolled = 'none: a pathfinder of its own is explicitly allowed';
