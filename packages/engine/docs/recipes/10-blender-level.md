# Importing Blender models and levels

> **Covers:** levels and models from Blender: naming conventions, compression, plants on a level.
> **Use when:** the map is built in a modeling tool.
> **Shortest:** `engine.use(level({ url: '/models/town.glb' }))`.
> **Sections:** 1 Place things in · 2 Compression · 3 Putting it in · 4 Grass and trees · 5 Verify · 6 A level and

## 1. Place things in Blender by naming convention (the level module recognizes names)
| Purpose | How to name it |
|---|---|
| Walkable ground | Object name contains `ground` `floor` `road` `terrain` `stair(s)` `ramp`, or custom property `walkable = true` (if there are none, every mesh counts as walkable); ground type = custom property `groundType`, otherwise the material name |
| Walls / obstacles | `col_xxx`: a hidden collision box that only blocks the player (hidden automatically after loading); or custom property `collider = true` (a visible object that also blocks); custom property `layer` (text): characters with it in `passes` walk through (recipe 12) |
| Spawn point | Empty object `spawn` (or `spawn_2`...) |
| NPC position | Empty object `npc_shopkeeper` |
| Trigger zone | Empty object `trigger_door`; the custom properties `shape` (cylinder/sphere/box), `radius`, `height` become trigger zone parameters |
| Other markers | Empty object `marker_chest`; all custom properties go into `userData` unchanged |
| Things a save must know (a door that opens, a rock that can be removed) | Custom property `template = 'door'` (an instance of a content template; its other custom properties fill the template's state) or `id = true` (the node itself is the model). The node becomes a world record with id `<level file name>/<node name>` (`town/door_front`), saved as a diff (needs `world()` installed, and `content()` for `template`); untagged meshes stay static scenery (recipe 30 §2) |

Export glTF/GLB (tick "Custom Properties") into `art/models/` (create it if missing).

## 2. Compression
`npm run assets -- optimize` compresses to `public/optimized/<same name>.glb` (Meshopt geometry + KTX2 textures, recipe 46 section 3) and points `assets.js` at the results (`/optimized/<name>.glb`). Object names and
hierarchy are kept; faces are not reduced. Only changed files are processed; `-- --force` redoes everything.

## 3. Putting it in the game (main.js)
```js fragment
import { presets, level, collision, followCamera, characters, interactions, dialogue, triggers, content, hlod } from 'threedog';
engine.use(level({ url: '/models/town.glb' }), collision(), followCamera(), characters(), interactions({ ...presets.interactions.nearest }), dialogue(), triggers(), content(), hlod());
engine.events.once('level:loaded', () => {  // once: level:loaded fires again on every level change
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: engine.level.spawn });
  engine.content.load(data);  // a place in content can be a marker name directly: { place: 'npc_shopkeeper' }
});
engine.start();
```
- Trigger zone data: write `{ door: { fromLevel: true, onEnter: { toast: 'Welcome' } } }` in `<game>/content/triggers.js` (tag = the name after `trigger_`).
- Content validation (`npm run check`) reads the level `.glb` files in `art/models/` and `public/models/` (needs `@gltf-transform/cli` installed):
  marker names used in content (`{ place: 'npc_shopkeeper' }`) need no description in `content/places.js`; a `fromLevel` trigger zone must have a
  `trigger_<tag>` node, and a node's `template` must exist in `content/templates.js`. Without a readable `.glb`, validation
  skips `fromLevel` and GAMEMAP says the markers cannot be read statically; `level.js` is only for code-built levels.
- `npm run assets -- check` prints what the level will find in each model (spawns, colliders, triggers, template nodes, duplicate ids) plus
  material / color-space suspicions; `-- --json` gives the same as data.
- When the level changes, the
  old level's trigger zones and the like are deleted automatically (`level.track`); NPCs, pickups and props placed by marker only lose their model
  while their data stays (with a zone), and are rebuilt when you return to this level; things that were picked up / deleted stay gone.
- Get a marker in code: `engine.level.marker('marker_chest')?.position`, `engine.level.markersWith('npc_')`.
- Many buildings: install `hlod()`, which merges distant ones into a few meshes. For a navmesh see `12-navmesh.md`.
- A single model (not a level): `engine.assets.manifest({ models: { house: '/models/house.glb' } })`,
  `const h = await engine.assets.model('house', { static: true })` (static: registers it for rays).
- For models with skeletal animation see `13-animation.md`.

## 4. Grass and trees on a level
Without `terrain()`, `vegetation()` grows on its own chunks over whatever provides the ground: the level, a code-built ground (`engine.setGround`), or
the flat default. Rules read `engine.surface / slope / groundType`, so pick the level's surfaces by ground type (a mesh's `groundType` custom
property, else its material name) with `rule.biomes`, and limit the scatter with `area`:
```js fragment
engine.use(level({ url: '/models/town.glb' }), vegetation({ area: { min: [-80, -80], max: [80, 80] }, viewChunks: 3 }), collision());
engine.vegetation.define('grass', { geometry: grassGeo, nearOnly: true, rule: { perChunk: 500, biomes: { lawn: 1 } } });
engine.vegetation.define('tree', { model: oak, rule: { perChunk: 6, biomes: { lawn: 0.6, park: 1 }, maxSlope: 0.4, collider: 0.4 } });
```
Chunks stream around `engine.stream` sources and stay one InstancedMesh per species per chunk (LOD, shadows and felling work as on terrain:
`instanceAt` / `removeInstance`, saved). Collision and path planning see the trees through `engine.ground.forEachCollider`; a new level or `setGround`
re-places them; after changing a ground function behind the same provider call `engine.vegetation.rebuild()`. Heights are unlimited unless the rule
sets `minHeight / maxHeight`. Content `vegetation` works the same way. With `terrain()` installed, `vegetation()` takes no options (density and view
distance are terrain options). Rapier (`rigid()`) bodies collide with them too (cylinders from `engine.ground.forEachCollider`, gone when felled).

Where a species grows is decided in the same `define()` call, with up to three parts (on a level, a code-built ground or terrain alike):
```js fragment
// rule: random scatter per chunk (above). positions: the game's own spots instead, [x, z] or [x, z, scale, yaw], planted at the ground height
engine.vegetation.define('hedge', { model: hedge, positions: hedgeSpots /* [[x, z], ...] from your level data */, rule: { collider: 0.5 } });
// densityMap: thins the rule's or the positions' result, 0..1 per spot -- a function of game data, or a gray image with the heightmap keys
engine.vegetation.define('weeds', { geometry: weedGeo, rule: { perChunk: 300 }, densityMap: (x, z) => farm.neglect(x, z) });
engine.vegetation.define('flowers', { geometry: flowerGeo, rule: { perChunk: 200 }, densityMap: { url: '/maps/flowers.png', size: [256, 256] } });
```
With `positions`, the rule keeps only what shapes an instance (`scale`, `stretch`, `sink`, `tints`, `tintJitter`, `collider`); the scatter filters
are refused. The id of a listed plant is its index in the list. After what a density function reads changes, call `engine.vegetation.rebuild()`.
A game that wants every instance under its own code still builds a plain `THREE.InstancedMesh` and adds it to the scene.

## 5. Verify
- `npm run assets -- optimize` prints each file's size before and after compression (`-- --dry` only estimates); a browser 404 appears in `.threedog/errors.log` (asset load failure).
- `describe()`: `ready` is true and `loading` is empty; the player's coordinates are at the spawn point; `nearby` contains trigger zones
  (`kind: 'trigger'`) and NPCs.
  Text version: `npm run shot -- /your-page.html --describe-only`.
- Collision: `engine.collision.walkable({ x, z })` is false inside a col_ box; ground: `engine.surface(x, z)` equals the step / floor height.

## 6. A level and a terrain together
Each takes the ground slot on its own, so installing both is refused. `compositeGround` holds the slot and asks one of them per point:
```js fragment
engine.use(terrain({ part: true }), level({ scene: town, part: true }),
  compositeGround({ parts: [{ of: 'level', region: (x, z) => x >= -30 && x <= 34 && Math.abs(z) <= 20, priority: 1 }, { of: 'terrain' }] }));
```
- `region` is omitted (everywhere), `(x, z) => boolean`, or `{ volume }`, the same `{ contains({ x, y, z }) }` water and trigger zones take (asked at `y` 0). Higher `priority` wins where regions overlap.
- A region has no height: everything above and below a point belongs to one part. A cellar under a hillside goes in the level, and the level's mesh carries the ground over it too.
- The navmesh is built from the level parts only. Outside them paths use A*.
- Physics follows the regions: `rigid` gets terrain triangles only where the terrain answers, so a hill under a level's region is not solid. It is still drawn; lower it there or keep it out of sight.
- Water over a room: a character, `describe()` and floating bodies ask `waterAt` at their own height, so `addWaterBody({ query })` returning `null` below a lake's bed leaves the room under it dry. A plain `radius` or `halfWidth` body has no bottom and counts at every height.
