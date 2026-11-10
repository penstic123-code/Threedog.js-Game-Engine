# Terrain: your own generator, digging, raising and painting the ground, islands

> **Covers:** terrain: generators, digging and raising, soil and ground types, height, roads, islands.
> **Use when:** a ground of your own, generated or shaped by play.
> **Shortest:** `openWorld({ terrain: terrainPreset() })`.
> **Sections:** 0 A ready-made generator · 1 Your own generator · 2 Changing the ground · 3 Farming soil and · 4 Height and snapping · 4b A road laid · 5 Where the ground · 6 Drawing the ground · 7 A chunk that · 8 Triangle cut and · 9 Height from a

Requires module `terrain()` (in the `openWorld()` preset). The API list is in `../api/terrain.md`.

The engine always does the chunks, streaming, workers, collision and vegetation. It has **no built-in landform**: `terrain()` without a generator is
flat gray ground at y = 0, with a dev warning. The height and ground type come from your own two functions or a preset, and the player can change the
ground during play. How the ground looks: recipes 36 and 53.

Flat island (no noise): `terrain({ height: () => 2, shape: { mask: (x, z) => 25 - Math.hypot(x, z) } })`; inside `openWorld` the same object goes under `terrain:`.

## 0. A ready-made generator: the noise preset
```js
import { openWorld, createTerrain } from 'threedog';
import { terrainPreset, riverAt } from '@threedog/terrain-noise';  // optional package: noise hills, rivers, biomes
engine.use(openWorld({ camera: 'follow', seed: 7, terrain: terrainPreset({ shape: 'island' }) }));  // 'hills' (default) | 'island' | 'canyon' | 'flat'
const preview = createTerrain({ seed: 7, ...terrainPreset() });  // same heights before the engine starts
const dry = (x, z) => riverAt(x, z, preview.noise) === 0;
```
Its ground types are `beach snow rock riverbank wetland savanna forest highland meadow`; the game colors them (`terrain({ colors, biomeColors })`),
and `terrainStrings` names them for `describe()`. Other options:
`heightScale mountains rivers riverWidth river biomes noise island canyon` (types in the package's `index.d.ts`).

## 1. Your own generator
```js
import { terrain } from 'threedog';
terrain({
  // meters at (x, z); n = { fbm(x, z, octaves), noise(x, z), hash(x, z, salt), seed, waterLevel, params }; fbm, noise and hash all give 0 to 1, not -1 to 1
  // (fbm gathers around 0.5 and seldom reaches either end: subtract 0.5 to center it, and sample the map before choosing a cut for a ground type)
  height: (x, z, n) => 4 + 30 * n.fbm(x * 0.004, z * 0.004) - 8 * Math.abs(Math.sin(x * 0.01)),
  // a ground type name (null = 'default'); its colors come from biomeColors[type]
  groundType: (x, z, h, slope) => slope > 0.8 ? 'rock' : h < 1 ? 'beach' : 'grass',
  waterLevel: 0,  // a sea at y = 0; leave it out for no water (the default is -Infinity; terrainPreset() sets 0)
});
```
The terrain moves the camera's far plane out to its view distance and leaves the fog to the game; `terrain({ viewFog: true })` (on in `openWorld()`) writes that
distance to the signal `engine.uniforms.uViewDistance`, which your fog code reads so the far chunk edge fades out (recipe 34). It never writes `scene.fog`.
Both functions run in workers, so they are **pure**: they see only their parameters and globals like `Math`. Reading a variable from outside
(`(x, z) => x * scale`) throws at `terrain()` and names the variable; put the number inside the function, or pass settings as plain data in
`terrain({ params })` and read them as `n.params`. `flatten` plots still apply on top. A new type name needs colors:
`terrain({ biomeColors: { lava: ['lavaA', 'lavaB'] }, colors: { lavaA: 0xd04010, lavaB: 0xa03008 } })`.

## 2. Changing the ground: `engine.terrain.edit`
```js
const at = [12, 0, 20];  // an op's 'position' argument is [x, y, z]
engine.ops.define('ground.dig', { args: { at: 'position' }, run(e, a) { e.terrain?.edit(a.at, { radius: 3, lower: 1.5 }); } });
engine.ops.define('ground.level', { args: { at: 'position' }, run(e, a) {
  e.terrain?.edit(a.at, { shape: 'square', radius: 6, flatten: e.surface(a.at) });  // a flat foundation at the height of its center
} });
engine.ops.run('ground.dig', { at });
```
- Edits snap to the terrain grid: heights to grid points, paint to whole cells of `engine.terrain.cellSize` meters (`chunkSize / resolution`, default
  4). A shape smaller than a cell takes the nearest one. For finer paint use a higher `terrain({ resolution })` (64 gives 1 m cells); per-cell
  gameplay state belongs in a grid layer (section 3).
- It is saved gameplay state: call it from an op or a fixed step (in development a call from a plain button handler warns).
- Everything follows at once: the mesh, `engine.surface / slope / groundType`, character and physics collision, path rasters (`ground:change` event),
  and vegetation (trees and grass on edited cells are removed). Edits are saved with the save, and a chunk that unloads and comes back is generated
  edited (workers get the edits, so threads on and off build the same chunk).

## 3. Farming soil and ground types
Gameplay soil state (tilled, watered, crops) is **not** terrain paint: keep it in a grid layer (`grids()`, `farm.layer('soil')`), which is per cell,
saved, works on levels and indoors, and draws its own tiles. See `recipes/29-grid.md` section 3.
`terrain.edit({ paint })` is for landscape ground types: roads, sand, a coarse visual layer (a painted type with no color is gray; the game names its
types and gives them colors in its own style object: `terrain.colors` + `terrain.biomeColors`). `engine.groundType(pos)` reads the painted type
(footsteps, `can` checks):
```js
engine.ops.define('path.sand', { args: { at: 'position' },  // a sandy path; a new type name needs biomeColors (section 1)
  run(e, a) { e.terrain?.edit(a.at, { shape: 'square', radius: (e.terrain.cellSize ?? 4) / 2, paint: 'beach' }); } });
```

## 4. Height and snapping
Read the ground with `engine.surface(x, z)` (also `slope`, `groundType`, `waterAt`) and put an object on it with `engine.snapToGround(obj)`. Don't
raycast the terrain for this: the height function is exact and works before the chunk has a mesh.

## 4b. A road laid on the ground

The road and the height function must read the same data, or the road floats or sinks wherever they disagree. Write the road's shape once as plain numbers and hand them over with `terrain({ params })`. The height function runs in workers and sees only `n.params`, so it works out the centre line itself: a formula or a small table of numbers, never a curve object. Near the line it returns the road's level, and it blends to the hills further out.

```js
const ROAD = { R: 130, wobble: 24, level: 14, flat: 10, blend: 40 };  // the one copy of the road's shape

function height(x, z, n) {
  const p = n.params, t = Math.atan2(z, x);
  const centre = p.R + p.wobble * Math.sin(2 * t);
  const k0 = Math.min(1, Math.max(0, (Math.abs(Math.hypot(x, z) - centre) - p.flat) / p.blend)), k = k0 * k0 * (3 - 2 * k0);
  const hills = 10 + 60 * (n.fbm(x * 0.009, z * 0.009, 4) - 0.5);
  return p.level + (hills - p.level) * k;
}
// terrain({ params: ROAD, height })
```

The road itself comes from the same numbers, with its heights read from `engine.surface`, so nothing is computed twice:

```js
const points = [];
for (let i = 0; i < 720; i++) {
  const t = i / 720 * Math.PI * 2, r = ROAD.R + ROAD.wobble * Math.sin(2 * t), x = r * Math.cos(t), z = r * Math.sin(t);
  points.push({ x, y: engine.surface(x, z), z });
}
```

Build the road's mesh from `points`, a little above the ground, and keep `flat` wider than half the road. The same data answers gameplay questions too, such as where the road is or how far a car has left it.

## 5. Where the ground ends: `shape`
`terrain({ shape })` decides where there is ground at all: an island, a floating rock, a world that ends. Without it the ground goes on forever. With it, ground exists only
where `mask > 0`; the rim is cut through the cells in straight lines, walls hang down from it, and an optional underside closes it. The keys and their defaults are `TerrainShape` in `types/world.d.ts`.

```js
import { createEngine, openWorld } from 'threedog';

const engine = createEngine({ canvas: document.querySelector('canvas') });
engine.use(openWorld({ camera: 'follow', water: false, terrain: {  // water: false -- a floating island has no sea under it
  height: (x, z, n) => 4 + 6 * n.fbm(x * 0.02, z * 0.02),
  shape: {
    mask: (x, z) => 60 - Math.hypot(x, z),  // > 0 ground: a 60 m disc (meters read best)
    edge: { noise: 8, size: 20, jitter: 0.6, round: 1.5 },  // ragged outline, jagged rim, top bends down 1.5 m at the edge
    side: { depth: 3, ground: 'cliff' },  // 3 m of cliff band, colored by biomeColors.cliff
    bottom: { depth: (x, z, n, m) => 2 + m * 0.5 + 4 * n.fbm(x * 0.1, z * 0.1), ground: 'rock' },  // hangs lower inland (m grows inward)
  },
} }));
await engine.start();

const home = { x: 0, z: 0 };
engine.events.on('terrain:void', ({ who }) => {  // fell off: the game decides (the engine never respawns)
  if (who === engine.player) engine.player.placeAt(home);
});
```

Colors come from `terrain({ biomeColors })` as usual: add `cliff` and `rock` (a name without a color is neutral gray). The mask is pure like `height`, or a gray image.
Without `bottom` the island is open underneath (the cheapest choice when the camera never looks up at it). The side wall follows every bend of an `edge.round` top, so no slit shows between them.

What the rest of the engine does off the outline:

- `engine.surface(x, z)` is `-Infinity`, `engine.ground.has(x, z)` is `false`, `engine.slope` is 0, `engine.groundType` is `'void'`.
  Check `has` before placing things: `engine.snapToGround` over the void warns once and leaves the object where it is, instead of writing an infinite y.
  The same holds for every place-it-here entry (`engine.content.spawn`, content props, pickups, npcs, `character.placeAt`): a warning once per caller with this advice, and they keep the caller's y (or 0), never `-Infinity` (a save would turn it into NaN). Camera starts, HUD anchors, grid tiles and shot paths fall back to y 0 / the last height without a word.
- Characters walk off the rim and fall; pathfinding and spawn search treat the void as not walkable.
- Physics: the top and the walls collide (a rolling barrel stops at a wall, a ball falls off the edge); the underside does not.
- Vegetation never grows off the outline. `engine.terrain.edit` off it does nothing (returns `{ heights: 0, cells: 0 }`); near the rim it
  still digs, and painting works. The outline itself cannot be edited.
- The player and every moving rigid body that drops below `engine.terrain.voidY` get one `terrain:void { who, position }` per fall.
- Global water still draws at its level: a floating island usually turns water off (`water: false` above).

Limits:

- The cut follows cell edges, so detail finer than a cell (`chunkSize / resolution`, 4 m by default) is lost. Keep `edge.size` above a cell,
  or raise `resolution`.
- `shading: 'texture'`: the color map covers the top only (void pixels keep the color of the ground under them, so no seam shows at the rim, with alpha 0); sides and bottom use vertex colors or `side.material`.
- The mask is fixed at start; a game that wants the outline to change while playing builds that itself.

## 6. Drawing the ground and plants your own way: replace the picture, keep play

`terrain()` and `vegetation()` each install two modules: the data part (`engine.terrain`: heights, chunks, edits, collision;
`engine.vegetation`: species, placement, tree collision, felling) and the picture (`engine.terrainDraw`, slot `'terrain-draw'`;
`engine.vegetationDraw`, slot `'vegetation-draw'`). Collision, paths, `engine.surface`, `instanceAt` and saves read only the data, so a game that
replaces a picture keeps all of play. A picture listens to the data part's `view` hooks and never changes the data:
```js fragment
engine.use({ name: 'myGround', type: 'picture', provides: ['terrain-draw'], install(e, ctx) {
  const meshes = new Map();
  ctx.track(e.terrain.view({
    add(c) { const m = buildMesh(c.data.pos, c.data.nor, c.data.col); m.position.set(c.cx * e.terrain.chunkSize, 0, c.cz * e.terrain.chunkSize); e.scene.add(m); meshes.set(c, m); },
    change(c) { refill(meshes.get(c), c.data); },  // terrain.edit rewrote the arrays (the count can differ on an 'adaptive' rim)
    remove(c) { e.scene.remove(meshes.get(c)); meshes.delete(c); },
    show(c, visible) { meshes.get(c).visible = visible; },
  }));
} }, { replaces: 'terrain-draw' });
```
Plants work the same way: a module with `provides: ['vegetation-draw']`, `{ replaces: 'vegetation-draw' }` and `e.vegetation.view({ species, change, ring, show, drop })` (hooks in `../api/vegetation.md`). In `change(c, name)`, `c.plants[name]` is `{ n, m (16 floats per plant, chunk-local), c (colors), ids }` and `c.hidden[name]` the felled slots; when it is gone, drop that mesh.
`c.data` holds `pos`, `nor`, `col`, `uv`, and `tex: { data, size }` in texture mode; `engine.terrain.generator.buildChunk(cx, cz)` returns the same raw arrays.
Only the material, not the meshes? `engine.terrain.material = material` swaps it on every loaded chunk in place (recipe 36).

## 7. A chunk that fails

A chunk job that throws (usually the game's `height` / `groundType` / placement rule at that spot) is tried 3 times, then the chunk stays empty
(no ground, no collision there): `terrain:chunkFailed` `{ cx, cz, error }` fires, the error `[terrain-chunk-failed]` names the chunk and the cause,
and `describe().perf.chunks.failed` counts it. Fix the rule, then `engine.terrain.retry()` sends every failed chunk again.

## 8. Triangle cut and bounds margin
```js
terrain({ diagonal: 'adaptive' })  // 'fixed' (default) | 'adaptive' | 'alternate'
```
`fixed` cuts every cell the same way. `adaptive` cuts along the diagonal with the smaller height difference, which removes
the zigzag ridges a fixed cut leaves on a slope; `alternate` flips every other cell (no directional bias on flat low-poly facets). `engine.surface`,
collision and vegetation heights follow the chosen cut, so nothing floats. It changes the walkable shape, so `recolor` does not take it.

`boundsPad: { up: 3, radius: 8 }` (meters, the defaults) is the margin of the chunk's bounding sphere: the center is raised by `up`, the radius grows
by `radius`. Raise it if a shader moves vertices far (wind on tall ground cover, a vertex-displacement patch) and chunks pop out at the screen edge.

## 9. Height from a grid or image
`sampleGrid(data, opts)` (`../api/tools.md`) turns numbers laid out on a regular grid into a function `(x, z) => value`;
`await engine.assets.gridFromImage(nameOrUrl, opts)` (`../api/assets.md`) reads such a grid from an image. Samples sit on the grid nodes, so
`width` samples span `width - 1` cells. The grid is just a field: height, moisture, a
ground-type weight, spawn density, a walkable mask, danger, travel cost.

`interp` is the picture between nodes, and none of them is the right one: `'nearest'` for terraces, blocky ground, tile masks and ids; `'linear'` (default) for most fields;
`'cubic'` for slopes without cell creases, which can overshoot beside a sharp step (`clamp: true` keeps it inside the four corner values).

```js fragment
const g = await engine.assets.gridFromImage('/maps/height16.png', { range: [-5, 60] });  // meters, 16-bit file
const heightAt = sampleGrid(g.data, { ...g, size: [512, 512], origin: [-256, -256], interp: 'cubic', clamp: true });
heightAt(10, 20);  // gameplay side: where to put a camp, a mine, a lighthouse
const wet = sampleGrid(moisture, { width: 32, height: 32, cellSize: 8 });  // a hand-made field: wetter ground grows reeds, rice, moss
const walk = sampleGrid(mask, { width: 64, height: 64, cellSize: 1, interp: 'nearest', outside: 0 });  // 0 / 1 per tile; off the map: not walkable
```
A terrain `height` function is recompiled in a worker and cannot capture `heightAt`, so the terrain reads the same image through its own
`heightmap` (bilinear, centered on `center`): `terrain({ heightmap: { ...g, size: [512, 512], min: -5, max: 60 } })` with `g` from `gridFromImage`
using the default `range` (it expects 0-1 values; `min`/`max` scale them). Use `sampleGrid` for everything outside the terrain module; when you need
a picture the terrain's bilinear read does not give (terraces: `nearest`), bake it into the data first or write the step in a `height` function.
