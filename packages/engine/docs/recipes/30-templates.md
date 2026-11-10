# Templates: reusable objects, definition vs instance state

> **Covers:** templates: one kind of object defined once, placed many times, instance state.
> **Use when:** many objects of the same kind.
> **Shortest:** a template entry in content data, then instances (§1, §2).
> **Sections:** 1 Define a template · 2 Place instances · 3 What belongs to · 5 Point -> thing · 6 When to use · 7 A group of

Requires `world()` (in `openWorld()`); a template with `interact` needs `interactions({ ...presets.interactions.nearest })`, with `container` needs
`inventory()`.

A **template** describes one kind of object once: model, collision, interaction, container, sound, animation and the defaults of its saved state. Each
placed one is an **instance**: a world record whose `kind` is the template name, holding only its own state. No inheritance or variants: another look is
another template, `{ ...chest, model: 'iron-chest' }`.

## 1. Define a template
`games/<game>/content/templates.js` (add it to `content/index.js`):
```js
export default {
  chest: {
    model: 'chest',  // an asset name (file or generator of an asset pack, the same name pickups and vegetation take); every chest clones one shared prototype
    collide: 'box',  // 'box' = the model's bounds; 'circle' = a cylinder on its base; omitted = does not block
    state: { opened: false },  // instance fields and their defaults, copied onto each record and saved
    interact: { label: rec => rec.opened ? 'Close' : 'Open', op: 'chest.toggle', radius: 2 },  // using it runs the op with { id }
    container: { capacity: 6, items: { berry: 2 } },  // each chest gets a container whose id is the record id; items = starting goods (placed once)
    sound: { use: 'chest' },  // engine.audio.sfx after a successful use
    animate: (rec, obj, dt) => { obj.children[0].rotation.x = rec.opened ? -1.1 : 0; },  // per-frame look from the record, only while the model exists
  },
};
```
The action itself is an op in main.js (recipes/23-ops.md), so every open is logged and testable:
```js
engine.ops.define('chest.toggle', { run: (e, { id }) => e.world.set(id, { opened: !e.world.get(id).opened }) });
```
`interact` fields: `op` (required), `label` (text, i18n key, or `(rec, engine) => text`), `radius` (default 2.5), `height`, `action`,
`enabled: (rec, engine) => boolean`.

`collide` forms (the same on a plain prop): `'box'` is the model's bounding box, for buildings and crates. `'circle'` is a cylinder on the model's **base**: the
geometry in the lowest fifth of its height above the ground, so a tree gets its trunk and a street lamp its pole, and a crown or an arm blocks nobody. Write the radius
yourself with `collide: { circle: 0.25 }` (model meters: it follows `scale`), still centred on the base; add `occluder: false` when the follow camera may pass it
(recipes/21-camera.md). A bush or a tree whose crown hangs below head height but above that fifth lets a character walk into the leaves: give it a larger `circle`.

## 2. Place instances
In `content/props.js`, an entry with `template` instead of `model` places an instance. It takes a position and a few explicit overrides:
```js
export default [
  { template: 'chest', id: 'chest-home', place: 'home', x: 3, z: 1 },
  { template: 'chest', id: 'chest-cave', place: 'cave', x: 0, z: 2, opened: true, items: { film: 2 }, rot: 1.6 },
];
```
Allowed per instance: `id`, `place` / `x` / `z`, `y` (height above the ground), `rot`, `scale`, `items` (replaces the starting goods) and the
template's **state fields**. Writing a definition field (`model`, `collide`, `interact`...) throws and says to define another template.

**Field descriptions.** When a state field has a range or a short list of allowed values, say so in `fields` next to `state`. The default stays
only in `state`; a `default` inside `fields` is an error, because two copies of a default drift apart. The type is taken from the state value
when you leave it out:
```js fragment
crop:   { model: 'crop', state: { stage: 0, sort: 'wheat' }, fields: { stage: { type: 'int', min: 0, max: 4 }, sort: { values: ['wheat', 'corn'] } } },
turret: { model: 'turret', state: { ammo: 30 }, fields: { ammo: { min: 0, max: 99, desc: 'rounds left' } } },
```
`npm run check` then reports a placement with `stage: 9`, `sort: 'rice'` or a misspelled `stagee` (with the closest name), and dev `engine.content.spawn`
throws on the same mistakes. `engine.content.fields('crop')` returns the whole table (placement fields plus state fields, with each state default),
in the `core/base/params.js` format; `fields('props')`, `fields('pickups')`, `fields('views')` and `fields('props.grid')` give the engine's own placement
fields, and a game kind in `content/rules.js` can declare `fields` the same way. A state field may not be named `id`, `kind` or `position`: those
are the record's own.

**Ids.** An entry with state (a template with `state`, `container`, `interact` or `body`, every pickup, every grid item) gets a written id: saves find
its changes by id, and an index id (`<template>:<index>`, `pickup:<item>:<index>`) moves to another entry when one is inserted above it. Without one,
dev warns once per load and names the id to write. Pure decoration may keep its index id. Two entries with the same id in one load throw with the fix;
an authored id may not contain `#` or `/` (those are kept for records made during play and for level nodes). Places computed from the seed (a flat
spot near the river) stay in code and come in through `content.load(data, { places })`.

**Writing the ids, renaming them.** `threedog content ids [-w game]` lists each stateful entry that still relies on its index id with the id it
has now (`-`/`+` lines, dry run); `--write` writes them into the content files. Writing today's id changes nothing for old saves. To give an entry a
readable id later, change it and add the pair to `content/renames.js`: <!-- r18-ignore-line -->
```js
export default { 'chest:3': 'chest-home', 'prop:rock:12': null };  // old id -> new id; null = deleted on purpose
```
Loading a save then moves its changes, removal, owed time and container goods from `chest:3` to `chest-home` (save loaded before or after content),
and drops `prop:rock:12`'s data quietly. `npm run check` errors on a target no entry defines and on a source content still defines; dev warns about an
orphan near an existing id with the exact pair to add.

**Physics props.** `body: { shape: 'box' | 'ball' | 'hull', mass, friction?, restitution?, damping?, angularDamping? }` in a definition makes each
copy a rigid body (needs `rigid()`). The copy rests on the ground asleep until something hits it; then the record follows the body, and a save keeps
the crate's place like any other change, with its turn, speed and sleep in the save part `rigid` under the record id. A load puts it back as it was, in
the air if it was falling. A copy nothing has touched stays out of the save, however it settled on the ground.
```js
// content/templates.js
export default { crate: { model: 'crate', body: { shape: 'box', mass: 2 } } };
```

**Grid items and level nodes.** A props entry `{ id: 'bed-home', grid: 'farm', item: 'bed', cell: [4, 4], rotation: 1 }` is the record `grid.place`
would make, as authored data (the grid comes from the content key `grids`, `{ farm: { cell: 1, origin: [0, 0], size: [16, 12] } }`, or
`engine.grids.add`). In a level model, a node tagged `template = 'door'` becomes an instance of that template and one tagged `id = true` a record of kind `levelNode`, with id
`<level file name>/<node name>` (recipe 10).

At runtime (inside an op or a fixed step), `engine.content.spawn(name, at, fields)` places a new instance and returns its record (without `fields.id`
the id is numbered `<template>#<n>`, for example `chest#3`):
```js
engine.ops.define('chest.build', {
  run: (e, { x, z }) => e.content.spawn('chest', { x, z }, { items: { stick: 3 } }).id,
});
```
Instances from `props.js` are initial records (a save stores only their changes); spawned ones are saved whole. Use `engine.world.get(id)`, `set`,
`move`, `remove` and `query({ kind: 'chest' })` as for any record (recipe 18). Removing a record does not remove its container (the game decides what
happens to the goods).

**Things that change over time: `stages`, `canGrow`, `update`.** A placeable that moves through named steps over game time is still a template.
The same shape covers a crop (seed, sprout, ripe), a turret warming up (cold, warming, armed), a building under construction (scaffold, frame,
done) or a door that takes a while to open:
```js
// content/templates.js
export default {
  crop: {
    model: 'crop-seed', state: { watered: false },
    stages: [{ name: 'seed', duration: 600 }, { name: 'sprout', duration: 900, scale: 0.6 }, { name: 'ripe', model: 'crop-ripe' }],
    canGrow: rec => rec.watered,  // asked every step, near and far; false holds the stage and blocked time does not count
    interact: { label: 'Water', op: 'crop.water' },  // an interaction is always an op, run with { id }
  },
  turret: {
    model: 'turret', state: { heat: 0 },
    stages: [{ name: 'cold', duration: 5 }, { name: 'armed' }],
    update: (rec, dt, e) => { if (rec.stage === 1) rec.heat = Math.min(1, rec.heat + dt); },  // every fixed step while near
  },
};
```
- `duration` is calendar seconds (`engine.clock.now`) spent in a stage; only the last stage may leave it out (it stays there). `scale` multiplies the
  instance's scale; `model` is a model name shown from that stage on. Stages are data: content-check validates them with the engine's own rules.
- Each instance gets the state field `stage` (default 0, an int 0..n-1, so a placement may write `{ template: 'crop', stage: 2 }` and
  `content.fields('crop').stage` describes it) and `stageAt`, the clock time it entered. Both are on the world record and saved like any other field.
- Growth runs near and far. A far copy has no model but still grows, and after a load, a time skip or a long walk away it catches up through
  several stages at once. Each change fires `template:stage { id, template, stage, name }`. To jump a stage from an op, write the record:
  `e.world.set(id, { stage: 2, stageAt: e.clock.now })`.
- `update(rec, dt, engine)` is gameplay on the fixed step (a `world.simulate` near hook), near only. Write record fields directly or with
  `world.set`; both are saved. A far copy only grows.

**Many placements: split a kind into a folder.** Any content kind may be a folder instead of one file: `content/props/<area>.js`… (by area,
by theme, as you like). The parts are joined in file-name order; in `content/index.js` write `const props = contentParts(import.meta.glob('./props/*.js', { eager: true }));`
(`import { contentParts } from 'threedog'`). An id must be unique across all parts (the content check names both files). The content check hints at splitting past
about 2000 entries in one file; it also writes `.threedog/content-index.json` (id -> file:line), so `threedog content set/add/remove` opens only the one part it edits. After a hand edit or a rename the next write rebuilds it first, and refuses while a content file does not load.
Add new entries at the end of a part with a written id: an entry without an id gets its position in the joined list, which an insert above it would shift.

## 3. What belongs to the definition, what to the instance
| | Definition (shared, read-only) | Instance (per object, saved) |
|---|---|---|
| Template | model, collide, static, interact, container capacity and starting goods, sound, animate, stages, canGrow, update, state defaults, body | world record: id, kind, position, rot, scale, state fields (`opened`, `stage`, `stageAt`) |
| Container | capacity, maxWeight | the goods in `engine.inventory.container(id)` |
| Item (`inventory.define`) | name, icon, stack, weight, use | count and per-piece `data` (durability, ammo): `add('sword', 1, { data: { durability: 40 } })` |
| Crop / enemy kind (your own table) | grow time, max hp, drops | `plantedAt`, `hp` on the record |

Definitions are frozen when registered (`content/templates.js`, `inventory.define`):
`engine.content.template('chest').state.opened = true` throws `Cannot assign to read only property`, and the engine's error hint says to keep the
value on the record instead (`engine.world.set(id, { opened: true })`). Read a definition with `engine.content.template(name)` or
`engine.inventory.item(id)`. For your own tables of kinds (enemy types, crop types), the same split applies: keep the table in content, store `kind`
plus the changing values on the record, and wrap the table with `Object.freeze` if you like. <!-- r18-ignore-line -->

## 5. Point -> thing: where is this defined
Runtime ops change only the current session and its saves. To change the level itself, edit the content files or the level model, then reload. To find
the entry, ask the engine what a thing is:
```js
const t = engine.pick(0, 0)?.thing;  // what is in the middle of the screen
// { id: 'chest-home', kind: 'chest', template: 'chest', definedAt: 'content/props.js:14', templateAt: 'content/templates.js:3', fields: { opened: false }, edit: 'defined in content/props.js:14: …' }
engine.world.origin('chest-home');  // the same source info for an id
```
`hit.thing` is on every `engine.pick` / `engine.raycast` hit (computed when read); a hit on a batched copy resolves to its original object.
`engine.inspect(id).thing` and `engine.explain({ op, args: { id } })` say the same. A hit on a plain object added with `engine.add` gets its
`hit.thing` from the registry (id, `at` = the file:line of the add, `saved`, `edit`; recipe 40). A record made during play shows the op and tick that spawned it
(`spawned`), a level node its level and node name. Source lines exist in dev and test builds only (a Vite transform tags `content/*.js` with their
line numbers); a release build has none and pays nothing. From a terminal or an MCP client: `threedog pick 480,270` (screen pixels from the canvas
top-left) or the MCP tool `pick { x, y }`.

## 6. When to use a template
Plain three.js or a template: recipe 40 sections 1 and 2 decide. Game code keeps the rules: ops, `world.simulate` / `world.present`, conditions and UI. Something that appears during play is created inside an op with `engine.content.spawn`.

`npm run check` (rule R33) flags only what can break, in examples, templates and `games/*` alike. Warning, with `// runtime: <reason>` as the way to say it is fine (no saves, a new run only): `world.add` (without `{ save: false }`),
`engine.content.spawn`, `pickups.spawn` or `npcs.add` at module top level or in an `engine:ready` / `level:loaded` / `session:start`
handler, because those are saved whole and the startup code would make a second copy after every load. Error: `world.add(…, { initial: true })`
anywhere, which corrupts what saves compare against. Warning: code that `engine.add`s a `world.view(id)` model or writes its position / rotation / scale (world puts it back every frame).
The fix is a placement in content, or an op; a mesh built in code becomes a model by name (`engine.assets.manifest({ models: { cabin } })`) when you want it as a template.

## 7. A group of things
A market stall, a gun nest, a pit lane, a shop shelf, a puzzle room: several things that belong together. Content stays flat. Each thing is its own plain
entry with its own id, and what holds them together is the **place** they stand at. Nothing nests at runtime: there is no group object, no parent and no
per-part override, so `engine.thing(id)`, the save, `threedog content set` and `engine.pick` see each entry the same way as any other.

`content/places.js`, one place per group; `rot` is optional, radians about Y:
```js
export default { 'stall-1': { x: 40, z: -12 }, 'nest-1': { x: 8, z: 30, rot: 1.57 } };
```
`content/props.js`, entries around that place (`template` is the prototype, `id` the instance):
```js
export default [
  { id: 'stall-1-counter', model: 'counter', collide: 'box', place: 'stall-1', source: 'stall' },
  { id: 'stall-1-chest', template: 'chest', place: 'stall-1', x: 1, source: 'stall' },
  { id: 'nest-1-wall', template: 'sandbags', place: 'nest-1', z: 2, source: 'nest' },
  { id: 'nest-1-gun', template: 'turret', place: 'nest-1', x: 1, rot: 0.5, ammo: 5, source: 'nest' },
];
```
**One edit moves the group.** An entry's `x`, `z` are offsets from the place and turn with its `rot` (the same sense as a model's `rotation.y`); its own `rot` adds to
the place's. Change the place and every entry follows, with its model and collision. This also holds without a page reload when the place changes through a
second `engine.content.load(data, { places })`. What play moved or turned stays where the player left it, and a save keeps only what play changed, so an old
save follows the new place too. Only places in `places.js` (or the `places` of `content.load`) have `rot`; a level marker gives a position.

**`source`** (experimental, with `content stamp` and `content capture`) is a plain optional string on a model or template entry, naming what the entry was copied from. It has no effect at runtime; it is there to ask:
```js fragment
engine.world.query({ where: r => r.source === 'stall' });  // every thing copied from that arrangement
```
**Moving entries by hand.** On the dev server press F2 (or add `?edit=1` to the address), click an entry and drag its handle: letting go writes `x` and `z` into its content file, as an offset when it stands on a place. Comments and alignment stay. A value someone changed since the click is refused, and code-built entries and things added by code say why they cannot be saved.

**Arrangements.** To stamp out the same group again (`threedog content stamp <name> id=stall-1 x=20 z=5 rot=1.6`, then `threedog content set --source <name> <part> y=2` changes that part in every copy, as one explicit edit), keep it as a small file, `content/arrangements/<name>.js`: entries around zero, with a local `part` name
instead of an id and no place. Only the tools read it, when they copy it into `props.js`; the game never loads it, so the copies are ordinary entries from then
on and changing the file later changes nothing already placed.
```js
export default [
  { part: 'counter', model: 'counter', collide: 'box' },
  { part: 'chest', template: 'chest', x: 1 },
];
```
Copied to `stall-1`, part `chest` becomes `{ id: 'stall-1-chest', template: 'chest', place: 'stall-1', x: 1, source: 'stall' }`.

**Deleting.** Delete an entry and a save that changed it still loads: the change is an orphan (recipe 20, "Orphans are kept");
the `renames` content file says where it went (`null` = deleted on purpose). Delete a place and `threedog check` names every entry still standing on it; the
load refuses it too (`content-place`), because an entry with no place has no position.
