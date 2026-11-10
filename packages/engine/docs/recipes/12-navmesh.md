# Navigation mesh (nav)

> **Covers:** the navigation mesh, paths, many paths at once, links across gaps, sight lines.
> **Use when:** characters walk around obstacles to a goal.
> **Shortest:** `engine.characters.findPath(from, to)` (with `nav()` for a mesh).
> **Sections:** 1 Install main.js) · 2 Use · 3 Verify · 4 Many paths at · 5 One source for · 6 NPC links across · Fences and rivers collision) · Gates some characters pass · Line of sight, stealth

There is a single pathfinding entry point: `engine.characters.findPath(from, to)`; NPC schedules use it too.
- Without `nav()` (or before it is built): the collision module's grid A* (good enough for open terrain with a few obstacles).
- With `nav()`: after a level loads, a Recast navmesh is built; paths are more accurate and go around walls more cleverly. **Only level ground (the
  level module) is supported**; procedural terrain keeps using A*. Without a level mesh dev warns once (`nav-fallback`): A* has no nav links, crowd or floor changes. The mesh is built once per level: `engine.terrain.edit` and other ground changes do not
  update it, so a game that reshapes walkable ground at runtime leaves `nav()` out.

## 1. Install (main.js)
A level is a file or a `THREE.Object3D` built in code: `level({ scene: group })`, its meshes named as in `10-blender-level.md`.
```js fragment
import { level, collision, followCamera, characters, nav } from 'threedog';
engine.use(level({ url: '/models/town.glb' }), collision(), followCamera(), characters(),
  nav({ agentRadius: 0.4, agentHeight: 1.8, maxClimb: 0.45, maxSlope: 45, debug: false }));  // debug: true draws the navmesh
```
- Mesh source: the walkable meshes in the level (naming convention in `10-blender-level.md`). Walls = the level's `col_` boxes + every
  `addBox / addCircle` in the collision module;
  they sync automatically as dynamic obstacles: add an obstacle in game and the affected tiles rebuild themselves, no manual refresh.
- Recast (728 KB, 218 KB gzipped) starts loading when `nav()` is installed, and a game without `nav()` never downloads it; the path worker's bundle holds a second copy. Until it is ready findPath falls back to A*.

## 2. Use
```js fragment
const path = engine.characters.findPath(engine.player.position, { x: 4, z: 5 });  // [{ x, y, z }...] or null (unreachable); a y on either end picks the floor
const wall = engine.collision.addBox([16, 0, 0], { halfWidth: 4.5, halfDepth: 1 });  // temporarily block a gap (center, half width, half depth); the navmesh updates with it
wall.remove();  // remove the obstacle
engine.npcs.add({ name: 'Courier', position: [4, 0, -5], schedule: [{ at: 0, position: [4, 0, 5] }] });  // the NPC finds its own way there
engine.nav.dispose();  // unload the navmesh; afterwards A* is used again
```
Native Recast objects: `engine.nav.navMesh / query / tileCache / crowd` (crowd needs `nav({ crowd: true })`).

## 3. Verify
- `describe().nav`: `{ ready: true, version, obstacles: number of obstacles }`; in `describeText()` it is the "nav: {...}" line.
- In a test: after `engine.haltLoop()` call `findPath` and look at the waypoints (going around a wall they pass through the gap); after `addBox`,
  `engine.step(0.1)` and query again: the path should switch sides.
- Did the NPC arrive: after `engine.step(30)`, check `engine.npcs.get('Courier').position`.
- To see the mesh: `nav({ debug: true })` + `npm run shot -- /your-page.html`.
  `packages/engine/tests/nav/`).

## 4. Many paths at once: findPathAsync
`findPath` answers now, on the main thread. For crowds (dozens of NPCs repathing, AI squads) use `findPathAsync`: the same search (navmesh if ready, else A*)
runs in `engine.threads` workers and `done(path, status)` runs at the start of a fixed step about 4 steps (67 ms) later, through `ctx.commits`.
```js fragment
const req = engine.characters.findPathAsync(guard.position, target, (path, status) => {  // status 'ok' | 'noPath' | 'notReady', as findPath({ detailed: true })
  guard.path = path;
}, { radius: 0.5 });
req.remove();  // the target changed before the answer came: done is never called
engine.characters.pathsPerStep = 64;  // requests sent per fixed step (default 32); the rest wait in order
```
- Built-in NPCs already use it; keep `findPath` for the few calls that need a path this step (player click-to-move).
- threads on / off / slow / crashed give identical paths on the identical step: the worker mirrors the navmesh (exported bytes) and the collision colliders;
  if either changes while a batch is in flight, that batch is recomputed on the main thread on the new state.
- With A*, ground shape (height, water, slope) is sampled on a 1 m raster cached 5 s, every floor of it, so what stands under a bridge or a storey counts as it does for `findPath` (colliders and terrain trees are tested exactly), and the search stays inside
  the start-goal box plus a margin, so an async path can differ slightly from `findPath`'s.
- A save taken while a request is in flight does not keep it: the NPC asks again after loading. Tests: `threedog test "paths:"`.

## 5. One source for "can walk there"
`createEngine({ movement: { radius, height, maxSlope, stepHeight } })` sets it once; read it as `engine.movement`. Collision, the Rapier capsule, the
navmesh, A* and level steps all read it, so a module never writes its own 0.4 or 0.45. A character's position belongs to its mover: other systems
request movement (`placeAt`, `move`, vehicle `enter`) and never set `player.position`.

A navmesh is cut for one body, so bodies of other sizes get their own. `nav({ agentRadius })` is the size built at load; a path asked for with another `radius` (`findPath`, `findPathAsync`, and `walkTo` and NPCs, which pass the character's own) uses a mesh of that size, built the first time it is asked for and kept until the next rebuild. A small body takes the gap a large one cannot, and a body too wide for every way gets `noPath` and stays put.
- Sizes are whole cells (`cellSize`, 0.3 m by default), rounded up: 0.5 and 0.6 share a mesh, and only a body no wider than `agentRadius` shares that one. To tell closer sizes apart, or fit a gap within a cell of the body, make `cellSize` smaller.
- Each extra size is another mesh in memory, about as big as the first, and its first ask builds it there and then, on the main thread: about 10 ms on a 40 m level, 0.3 s on a 200 m one with 300 walls. Ask once during loading to take that off the first walk: `engine.nav.findPath(a, b, { radius })`. With one size none of this happens. Obstacles and rebuilds reach every size.
- Links exist on each size where both ends still reach its mesh, and their ends sit a little differently on each. `engine.nav.links` is the links of `agentRadius`; `crossing.to` on a path is the walker's own.
- Height, step and slope are the same for all sizes: only the radius differs.
- `nav({ crowd: true })` keeps one crowd on the `agentRadius` mesh: Recast's crowd runs on a single mesh, so give it the size of the widest crowd NPC. Use plain NPCs where sizes must differ.

Floors: a `y` on a path, a stop or `collision.walkable([x, y, z])` picks the floor nearest that height, and `{ x, z }` means the ground. A height more than `engine.movement.height` from every surface there goes to the nearest one and warns once `[nav-height]`. A box added with `y` blocks only that floor, for every mover. Between floors takes the navmesh; A* answers `noPath` for a goal on another floor. Without `nav()` a game names its stairs: `engine.mod('characters.path', { owner, set: ({ from, to }) => points })` returns waypoints with `y`, which `walkTo`, NPCs and `findPath` follow. A walker that falls off asks again, so the list must work from anywhere.

## 6. NPC links across gaps
A link joins two places no one can walk between (Recast calls it an off-mesh connection): a gap, a ledge, a teleporter. Paths use it like any other way, and a walker with no help from the game crosses in a straight line at walking speed.
```js fragment
nav({ links: [
  { id: 'gap', from: [-2.2, 0, 0], to: [2.2, 1.5, 0] },  // both ways
  { id: 'drop', from: [10, 4, 2], to: [12, 0, 2], oneWay: true },  // down only
] });
const path = engine.characters.findPath(a, b);  // [{ x, y, z }, { x, y, z, link: { id: 'gap', from, to } }, { x, y, z }...]: the leg after a point with link is the crossing
```
- Put each end on or near walkable ground: within `radius` sideways (default the agent radius + 3 cells, enough for a point at a ledge or a ladder just off it) and within `maxClimb` in height. A `y` left out is the ground there.
- Each end then moves onto the mesh, and that is where walkers step on and land: the mesh stops about the agent radius short of every edge, so a ladder at a deck's side or through a hatch ends 0.6 to 0.8 m in from the edge (cells round it), wherever its top was written. `engine.nav.links` and `crossing.to` give those places. The straight line between them cuts the deck's edge: a ladder that must look straight uses `linkPose` to climb first and step in last (below).
- A link reaches at most the neighbouring tile, counted where its ends meet the mesh: two platforms up to `tileSize` x `cellSize` meters (9.6 m by default) minus a little on each side. An end that attaches nowhere gets the `nav-link` warning at the build; no path uses that link.
- An obstacle on an end cuts the link until the obstacle goes. Elsewhere, rebuilt tiles keep their links, and `findPathAsync` sees the same ones. Links are fixed at `nav()`: none can be added at run time.

The engine moves the walker and says when; how it looks and how long it takes are yours. NPCs, `character.walkTo` and `nav({ crowd: true })` NPCs all cross this way. There is no default animation: the body keeps its last state.
```js
engine.events.on('link:enter', ({ character, crossing }) => {  // crossing: { link, from, to, seconds, time }
  if (crossing.link === 'gap') { crossing.seconds = 0.7; character.playAction('jump'); }
});
engine.events.on('link:exit', ({ id, crossing }) => console.log(id, 'crossed', crossing.link));
engine.characters.linkPose = (t, position) => { position.y += Math.sin(t * Math.PI) * 1.2; };  // t 0-1: bend the straight line into a hop
engine.characters.linkPose = (t, position, { from: a, to: b }) => {  // or through a hatch: up the opening, then the step onto the deck; coming down, the step first
  const up = b.y > a.y, side = up ? Math.max(0, t - 0.85) / 0.15 : Math.min(1, t / 0.15), rise = up ? Math.min(1, t / 0.85) : Math.max(0, t - 0.15) / 0.85;
  position.set(a.x + (b.x - a.x) * side, a.y + (b.y - a.y) * rise, a.z + (b.z - a.z) * side);
};
```
- During a crossing the walker has no gravity or collision and its talk, goal and behavior wait. `npc.placeAt` ends it, and `link:exit` still comes. A control holder above the walker (a cutscene, a ragdoll, a `walkTo` on an NPC) does not wait for it: the walker lands at the far end at once, with its `link:exit`. A walker with no speed (a `move.speed` mod of 0) also lands at once, unless `link:enter` sets `seconds`.
- An NPC's crossing is saved (`rec.nav.link`). After a load it goes on from the same spot: `link:enter` is not sent again, so a clip started there does not restart; `linkPose` and `link:exit` work as before. An NPC that goes out of range mid-crossing lands at the far end at once, with `character: null` in `link:exit`. A `walkTo` is not saved: its crossing ends with the walk, and `walk.remove()` lands the character at the far end.
- `linkPose` must depend only on its arguments, or a loaded crossing jumps. The game cannot hold a walker on a link until a clip ends: give `seconds` the clip's length.
- With `crowd: true` the crowd takes a link about 1 m short of its end, so the NPC walks the rest and crosses from the end like any walker; the agent is pulled back to the NPC after the crossing, and only the character's own crossing counts. Recast does not say which link an agent took, so the nearest link end is used: keep the ends of two links apart. Recast times a traversal by its x, z distance, so ends closer than speed / 30 m (a ladder straight up through a solid deck) are over before the NPC sees them: not for crowd NPCs. Through any opening the ends are far enough apart, as above.
- A link has no queue. Walkers on it share the line and pass through each other, up and down at once, and other agents do not avoid them: six crowd NPCs pacing through one hatch never jammed (44 crossings in 46 s), often two on it 0.2 m apart. Taking turns is the game's.
- A walker is not done while a link is left on its path, however close the goal is in x, z, so a goal at the top of a ladder is reached at the top. An NPC standing within `arriveDistance` of such a goal with no path yet, or one steered by the crowd, still stops at the foot: give the goal a place away from the ladder.
- Paths choose a link by its length, like walking: there is no extra cost for a jump. Start and goal heights still come from `engine.surface`, so a path from under a deck starts on top of it.

## Fences and rivers (collision)

Walls and water that are not meshes: `engine.collision.addSegment(a, b, { thickness })` is a thin wall along a line; `addBlocked(fn)` marks ground impassable where `fn(x, z)` is true. Both return `{ remove() }` and are free when unused.

```js
// A river along x 5..9 with a bridge at z -1..1: the bridge is just a hole in the blocked function
engine.collision.addBlocked((x, z) => x > 5 && x < 9 && !(z > -1 && z < 1), { bounds: { minX: 5, maxX: 9, minZ: -50, maxZ: 50 } });
// A fence with a gate: two segments, the gap between them is the gate
engine.collision.addSegment([-18, 0, -12], [-18, 0, -4]);
engine.collision.addSegment([-18, 0, 0], [-18, 0, 12], { thickness: 0.4 });
```

Walkers stop at the edge and slide along it; `collision.walkable()` and A* pathing, sync and async, see both. `fn` must be pure and deterministic (no clock, no random). Async paths cannot send a function to the worker, so `fn` is sampled into the 1 m ground raster instead (re-sampled when you add or remove a field): give `bounds`, or every requested tile is sampled in full. Navmesh mode (`nav()` installed) does not see `addBlocked`; use `addSegment` or bake the river into the mesh there.

## Gates some characters pass: collider layers

A collider with a `layer` stops every mover but those whose `passes` names it (a pen, a members' door). Walking, paths and the navmesh obey it.

```js fragment
engine.collision.addBox(gate, { halfWidth: 2, halfDepth: 0.3, layer: 'gate' }); // any add*
engine.npcs.add({ id: 'pig', name: 'Pig', passes: ['gate'] }); // or addPlayer, findPath
```

Content: `collide: { layer: 'gate' }` on a prop or template; a Blender level: custom property `layer` on a `col_` / `collider` object or its parent.

`character.passes` may be rewritten. Each layer list gets a navmesh, like a size (section 5). Rigid bodies, `lineClear`, the camera and `nav({ crowd: true })` NPCs ignore layers.

## Line of sight, stealth vision cones and straight-line checks: collision.lineClear
`engine.collision.lineClear(a, b, { radius })` answers "is anything solid between a and b?" for a 3D segment (the wall test of a guard's vision cone; the cone is your own angle check on `guard.facing`): boxes, circles and terrain trees, with heights (a 1 m wall does not block a sight line 3 m up). A boolean; `addBlocked` water is ignored. Give eye heights in `a` / `b`; `radius` fattens the line (pass the character radius for "can I walk straight there").
```js fragment
const sees = engine.collision.lineClear([guard.x, 1.6, guard.z], [player.x, 1.6, player.z]);  // true = clear view
const straight = engine.collision.lineClear(me.position, goal, { radius: engine.movement.radius });
```
The A* fallback smooths paths with the same idea: it samples each shortcut at most one character radius apart (so a thin fence cannot be skipped), starts from the character's real position, and its cell size follows `radius` (1-2 m) unless you pass `step`.
