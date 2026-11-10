# Grid placement: towers, furniture, buildings, crops

> **Covers:** grid placement: cells, layers per cell, preview, baked vs changing state.
> **Use when:** towers, furniture, buildings or crops on cells.
> **Shortest:** `engine.grids.add('board', { cell: 1, size: [16, 12] })`.
> **Sections:** 1 Grids and items · 2 Place, pick up · 3 Layers per-cell state · 4 Preview · Materials · 5 Baked data vs · 6 Verify

Requires module `grids()` and `world()` (`openWorld()` includes world; grids is opt-in and costs nothing when not installed). The API list is in
`../api/grids.md`.
A grid turns world positions into cells. Things placed on it are ordinary `engine.world` records; per-cell state that is not a thing (tilled soil, wet
soil, creep on a board, a painted floor) lives in **layers**. Per-cell gameplay state always goes here; `terrain.edit({ paint })` is only for landscape ground types (roads, sand),
see `28-terrain.md`.
Works on any ground: procedural terrain, a Blender level, an indoor floor. Heights come from `engine.surface`, ground types from `engine.groundType`.

## 1. Grids and items
```js
import { grids, toast } from 'threedog';
engine.use(grids());
const board = engine.grids.add('board', { cell: 1, origin: [0, 0], size: [16, 12] });  // several grids may exist: a tower-defense board,
const room = engine.grids.add('room', { cell: 0.5, origin: [-3, -3], size: [12, 12], zone: 'house' });  // a dungeon or house room,
const plot = engine.grids.add('plot', { cell: 1, origin: [20, 0], size: [8, 8] });  // a garden plot

engine.grids.define('tower', { size: [2, 2], kind: 'tower', fields: { level: 1 } });  // 2x2 cells on the board
engine.grids.define('crop',  { layer: { soil: 'tilled' }, fields: { plantedAt: 0 } });  // only on cells whose soil layer has tilled
engine.grids.define('bed',   { size: [2, 1], kind: 'furniture', fields: { model: 'bed' } });  // 2x1 cells; world record kind 'furniture'
engine.grids.define('shed',  { size: [3, 2], ground: ['grass', 'dirt'], flat: 0.2 });  // engine.groundType must match; max 0.2 m height difference
engine.grids.define('crate', { size: [1, 1], can: (e, { cell }) => (cell[1] > 2 ? true : 'tooCloseToRoad') });  // your own rule
```
Coordinates: `board.toCell(pos)` -> `[i, j]`, `board.toWorld(cell, size?, rotation?)` -> footprint center on the ground as a plain `{ x, y, z }` (not a Vector3:
`obj.position.copy(board.toWorld(c))`), `board.snap(pos)`,
`board.inside(cell)`, `board.footprint(cell, size, rotation)`.
Cell `[0, 0]` starts at `origin`. A footprint is anchored at its min corner; `rotation` is quarter turns (0-3), odd turns swap width and depth.

## 2. Place, pick up, move: always ops
```js
engine.ops.run('grid.place', { grid: 'room', item: 'bed', cell: [4, 4], rotation: 1 });  // { ok, value: record id } or { ok: false, code, facts, nextActions }
engine.ops.run('grid.move',  { id: 'furniture-3', cell: [6, 2], rotation: 0 });  // its own cells do not block it; grid: 'room' moves it to another grid
engine.ops.run('grid.remove', { id: 'furniture-3' });  // value { item, kind }: put it back in the bag yourself
board.can('tower', [3, 5]);  // ask only: true or a failure code string
```
Failure codes: `outOfBounds` `occupied` `wrongGround` `notFlat` `not<Field>` (from a layer rule: `notTilled`) `noGrid` `idTaken` `unknown` `notPlaced`
`badFields` (fields that set id / kind / grid / position / rot, which the placement owns), or your `can` code.
Show them through i18n (`engine.t('grid.' + r.code)`; `grid.can()` returns the same names as a plain string). The engine ships the `grid.<code>`
player text of its own codes (zh-CN and en; override a line with `engine.i18n.add`); codes the game makes, a layer rule's `not<Field>` and your
`can` codes, need their own `grid.<code>` line through `engine.i18n.add`. `engine.explain({ grid: { grid: 'room', item: 'bed', cell: [4, 4] } }).text` says which cell
and which record is in the way.
A placed record looks like `{ id, kind, position, rot, ...fields, grid: { id: 'room', cell: [4, 4], size: [2, 1], rotation: 1, item: 'bed' } }`. Give
it a picture with `world.present(kind, ...)` as usual (`rot` is the yaw in radians).
To build several things at once, call `grid.place` from your own op (`build.wall`), so each placement is still checked.

**Occupancy is not saved separately.** `room.at(cell)` / `room.area(cell, size)` read an index built from the world records' `grid` field, so a save
holds every placed thing once and can never disagree with itself.
**Don't go around it** (dev): the `grid` field of a placed record is frozen (editing it in place throws); `world.set / add` outside an op trigger the
ops guard; a record added by hand that overlaps another is reported and the cell stays with the first.

**Occupancy layers and levels.** An item takes cells in its own occupancy layer (`occupy`, default `'main'`), so things in different layers share
a cell and two in one layer do not; `level` is a storey (integer, default 0) with its own cells.
```js
engine.grids.define('tile', { occupy: 'floor' });  // floor tiles, rugs, paint marks
engine.grids.define('lamp', { occupy: 'wall' });  // wall-hung things
engine.grids.define('sofa', { size: [2, 1] });  // 'main': a sofa stands on a tile, a second sofa there is 'occupied'
engine.ops.run('grid.place', { grid: 'room', item: 'sofa', cell: [2, 2], level: 1 });  // upstairs: y = (grid y or the ground) + 1 * levelHeight
room.at([2, 2], { occupy: 'floor', level: 0 }); room.stack([2, 2]);  // one layer's record id; every layer's on that cell { floor, main }
```
`grids.add(name, { y, levelHeight })`: `y` fixes level 0's height (default: the ground under each cell), `levelHeight` is meters per level (default 3);
ground type and flatness are checked only on level 0 of a grid that follows the ground. The record keeps `grid.occupy` / `grid.level` when not the
defaults. The cell <-> world math is one replaceable pair, `grids.add(name, { mapping: { toCell(x, z) => [i, j], center([i, j]) => [x, z] } })`,
used by `toCell`, `toWorld`, tiles and flatness (footprints stay rectangles of cells).

## 3. Layers: per-cell state (soil, creep, paint)
```js
const soil = plot.layer('soil', { tiles: true });  // created on first use, options read then; saved with the game (only cells that differ from content)
engine.ops.define('plot.till',  { args: { cell: 'any' },
  can: (e, { cell }) => (!plot.inside(cell) ? 'outOfBounds' : plot.at(cell) ? 'occupied' : true),
  run: (e, { cell }) => soil.set(cell, { tilled: true }) });
engine.ops.define('plot.water', { args: { cell: 'any' },
  can: (e, { cell }) => (soil.get(cell)?.tilled ? true : 'notTilled'),
  run: (e, { cell }) => soil.set(cell, { watered: true }) });
engine.ops.define('plot.dry',   { run: () => soil.updateAll(d => { delete d.watered; }) });  // bulk change; return null from fn to clear a cell
engine.calendar.at('06:00', () => engine.ops.run('plot.dry'));  // daily reset is the game's job
```
`get(cell)`, `set(cell, patch)` (merge; a field set to null is deleted), `clear(cell)`, `query(cell?, size?)` -> `[{ cell, data }]`, `updateAll(fn)`, `count`.
Writes are saved gameplay state: do them inside an op or a fixed step (the guard reports anything else). Data must be plain values.
Cells that exist from the start go in content: `content/grids.js` <!-- r18-ignore-line -->
`plot: { cell: 1, origin: [20, 0], size: [8, 8], layers: { soil: [[3, 5, { tilled: true }]] } }` <!-- r18-ignore-line -->
(or `grids.add(name, { layers })`). They are the baseline: a save keeps only cells changed from it, so editing the content later still reaches old saves.

**Tiles.** The game gives a layer its colors: `plot.layer('soil', { tiles: { color: d => d.watered ? 0x5b3d2a : d.tilled ? 0x8a6243 : null } })`
(what the data means is gameplay, so the game writes these). A layer with tiles shows crisp per-cell quads just above the ground, following its
height (slopes, ramps, level meshes).
`tiles: { colors: { watered: 0x5b3d2a, tilled: 0x8a6243 } }` is the same as `color` from a table (first truthy field wins) and wins over the module's `grids({ tiles: { soil: { ... } } })`; `plot.layer('soil', { tiles: false })` turns them off; `{ tiles: true }` draws every non-empty cell gray; `lift` raises them; `{ tiles:
(engine, layer) => ({ update(cells), dispose() }) }` is your own view. Options are read when the layer is first created.

## 4. Preview
```js
engine.input.define('place', { label: 'Place', keys: ['Mouse0'] });  // gameplay reads input actions, not pointer.clicked (recipe 26)
engine.input.bind(presets.bindings.gridRotate);  // R turns it (action 'rotate')
const pv = engine.grids.preview({ grid: 'board', item: 'tower' });  // under the pointer; from: 'front' = the cell in front of the player
engine.onFrame(() => {
  if (engine.input.pressed('place')) { const r = pv.place(); if (!r.ok) toast(engine, engine.t('grid.' + r.code)); }  // 'noTarget' or a grid.place code
});
pv.remove();  // leave build mode
```
The engine binds no key: the preview declares the action `rotate` (gone with the preview); `presets.bindings.gridRotate` binds it to R, or bind it yourself with
`engine.input.bind('rotate', ['KeyR'])`; pass `rotate: 'myAction'` to read another one, `false` for none. Without a binding the preview warns once and only `pv.rotate()` turns
it. `pv.cell`, `pv.rotation`, `pv.ok`, `pv.code` (the `can` answer, `'noTarget'` with no cell, null when ok)
are readable every frame.
Colors come from `grids({ ok, bad, previewOpacity, previewHeight })`. `draw: false` hides the default box; `draw: (engine) => ({ update(view), hide(), dispose()
})` draws your own (`view = { cells, center, size, rotation, ok, code }`).

## Materials
```js
engine.use(world(), grids({ ok: 0x66dd88, bad: 0xdd5544, previewOpacity: 0.6, tileLift: 0.05 }));
plot.layer('soil').material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
pv.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false });
```
Both are plain three.js materials, used as given. Tile colors are vertex colors, so a tile material keeps `vertexColors: true` to show them; the default also has a polygon
offset against the ground. The preview still writes ok / bad to its material's `color`. `layer.material` is null on a layer that draws no tiles, `pv.material` with `draw` off or your own.

## 5. Baked data vs state the player changes
Anything the player can change in play must be runtime state, never baked into generated height or ground-type data: a tilled plot (farming), a dug or mined
tile (survival), a road or placed floor (city builder), a painted tile (puzzle), a breakable wall (action). Bake only what never changes: the landform (hills,
valleys, coast). Runtime state is a grid cell (`layer`), a `terrain.edit` (lower / raise / paint a ground type) or a world record (`grid.place`); all three are
saved, while a baked version cannot be changed in game and is not saved. A save keeps only what differs from the generated base.
```js
engine.use(terrain({ height: (x, z) => 3 + Math.sin(x * 0.05) * 2 }), world(), grids());  // generated: the landform only
engine.grids.add('plots', { cell: 4, origin: [8, 16], size: [4, 4] });
engine.ops.define('plot.dig', { args: { cell: 'any' },
  can: (e, { cell }) => (e.grids.get('plots').inside(cell) ? true : 'outOfBounds'),
  run: (e, { cell }) => {
    const [x, z] = [8 + cell[0] * 4 + 2, 16 + cell[1] * 4 + 2];  // cell centre
    e.terrain.edit({ x, z }, { shape: 'square', radius: 2, lower: 0.5, paint: 'dug' });  // ground shape and type
    e.grids.get('plots').layer('state').set(cell, { dug: true });  // per-cell game state
  } });
```
Undo with `paint: null` and `raise`.

## 6. Verify
`engine.describe().grids` -> `{ room: { occupied, items: { bed: 1 }, layers: {} }, plot: { ..., layers: { soil: 30 } } }`.
