# Scene: what is in the world, where, who manages it, and what a save keeps (engine.thing)

> **Covers:** the scene: content and code as two doors, ids, what a save keeps, explain.
> **Use when:** deciding where an object is written and what persists.
> **Shortest:** `engine.add(mesh, { id: 'mill' })`.
> **Sections:** 1 Two doors into · 2 What goes in · 3 Which state a · 4 Give it an · 4b Change it thing.set · 4c Saves the scene · 5 Moving from three.js · 6 Verify and dev · 7 Why is this · 8 When to write · 9 One id, everything

The engine's three outward concepts are **Scene** (what stands in the world, where it is, how you interact with it), **Assets** (models, textures,
sounds, fonts: `05-props-bake.md` §3b) and **Picture** (how it looks: `09-materials-lights-models.md`). Content packs belong to Scene: they are the data form of it.
Patches, ops and world records are the scene's inner machinery; read them when you need them (`23-ops.md`, `18-world.md`).

Every root added with `engine.add` or `engine.scene.add` is registered: an id, where it was added (`main.js:50`, dev builds only), who manages it and how much a save
keeps. World records (template instances, props, pickups, NPCs, level nodes) share the same id space and the same query, so one question works for a
plain three.js mesh and for a template instance alike. Only `engine.add(obj, { id })` gives it a stable id.

## 1. Two doors into one scene
A scene object comes in either of two ways, and both end up in the same scene:

- **Plain three.js.** Build a mesh or group, `engine.scene.add(obj)` (or `engine.add(obj)`, the same registration). Nothing else is required. This is the right way for anything your code rebuilds
  on every start. A piece that stands on its own can be one file in `plugins/` instead (`export default mesh`): plugged at start with the file name
  as its id (THREE.md, plugins folder).
- **A template.** Define it in `content/templates.js`, place it in `content/props.js` with an `id`, or create it during play with
  `engine.content.spawn(name, at)`. This is the right way for anything that must be saved, be editable without code, or exist in many copies.

The same windmill, both ways. A, plain three.js built on every start: `THREE.md §"Example: a spinning windmill"` (with `engine.add(mill, { id: 'mill' })` for a stable id). B:
```js
// B. template: the definition is data; the model is a name in the asset manifest
// content/templates.js
export default { windmill: { model: 'windmill', collide: 'circle' } };
```
```js
// content/props.js
export default [{ id: 'windmill-hill', template: 'windmill', x: 20, z: -10 }];
```
```js fragment
// main.js: a code-built model registered by name
engine.assets.manifest({ models: { windmill: buildWindmill } });
```
Route B gives the object an id, a source line (`engine.world.origin('windmill-hill')`), a save record and a place the editor (F2, recipe 30 section 7) writes back to.
Route A gives you less ceremony and full three.js control.

## 2. What goes in content, what stays three.js
| Put it in content (templates, props, pickups, npcs, containers) | Write it as three.js (`engine.scene.add`, `engine.add(obj, { id })`) |
|---|---|
| Must come back after a load, or the player can change it and the change must be saved | Rebuilt by your code on every start: lights, decoration, effects, bullets |
| Should be editable without a code change (position, state, copies) | Procedural or per-frame: particles, trails, shaders, a spinning blade |
| Many copies of one definition | A one-off with custom geometry or material logic |
| Has a state worth reading with `world.get(id)` | Pure presentation |

The rule check R33 flags only calls that would run again after a load and so duplicate saved data (recipe 30 section 6). `engine.add`, `collision.*`, `rigid.*`, `interactions.add` and the
like are fine at startup.

## 3. Which state a save keeps
Every scene object is one of four tiers, judged in this order (`thing.saved`):

| Tier | When | A save keeps | A save loses |
|---|---|---|---|
| `record` | A world record's model (template instance, props entry, pickup, NPC, level node) | The record's fields and position (world part); the model is rebuilt from its template / present | The model object itself and direct edits to it; change the record instead (`world.set`) |
| `code` | Added by game code with a stable id (`engine.add(obj, { id })`) at setup (before `engine.ready`, or in a `session:start` listener) | Position, rotation, scale, visibility and removal made with `thing.set` / `thing.remove` (`scene` part) | Geometry and material changes, children added later, `userData`, closure state (inside an `onFrame` callback), writes like `mesh.position.x = 3` |
| `session` | No stable id, or added during play | Nothing: it exists only in this session | Everything; it does not come back after a load |
| `engine` | Owned by an engine module (water, sky, terrain) | Its module's business | Direct changes (the module rewrites them) |

Writing `mesh.position.x = 3` in code always works; it just is not saved and cannot be undone. Only transform, visibility and removal are saved for
`code` objects; colours and materials belong to the picture and are not saved. To keep something made during play, make it a template and create it
inside an op with `engine.content.spawn(name, at)`: a record is saved whole.

## 4. Give it an id
```js
const windmill = new THREE.Group();  // any Object3D
engine.add(windmill, { id: 'windmill' });  // at setup: thing.set / thing.remove changes to it are saved
engine.add(new THREE.Group());  // effects need no id: obj#7, this session only
engine.thing('windmill');
// { id: 'windmill', kind: 'Group', owner: 'game', at: 'main.js:50', phase: 'setup', saved: 'code',
//   keeps: ['position, rotation, scale, visibility and removal made with thing.set / thing.remove (scene save part)'],
//   loses: ['geometry and material changes', 'children added later', 'userData', ...], edit: 'added by code at main.js:50 (id ...)' }
engine.thing('windmill').object;  // the live Object3D (not enumerable, so the result stays JSON-able)
engine.pick(0, 0)?.thing;  // any child resolves to its registered root
```
- The id is `{ id }`, else a session id `obj#n` (session tier: never saved). `obj.name` is not an id (GLB roots are all called `Scene`): it only helps `engine.thing(name)` find the object. An id is a non-empty string without `#`,
  unique across `engine.add` objects and world records: a clash throws (`thing-id`) from either side (`engine.add` or `world.add`) and says which one holds it.
- With several objects in one call (`engine.add(a, b)`) pass no id; add the one that needs an id on its own.
- `engine.thing(id | name | obj)` throws with the closest id when nothing matches. `engine.inspect(id)` takes the same ids.
- `describe().scene` gives counts only: `{ game, code, session, world, engine, unsaved, conflicts, orphans }`. Objects of engine modules (particles,
  physics bodies, nav helpers, hlod, grid tiles, the level root, streamed objects) are counted under `engine` and never listed as the game's.
- `engine.pick(x, y).thing` gives the same answer as `engine.thing(id)`. `engine.remove(obj)` forgets the object in the registry too.

## 4b. Change it: thing.set / thing.remove (ops, undoable)
```js
const args = { id: 'windmill', position: [5, 0, 2], rotation: 1.2 };  // rotation: a number is yaw, or [x, y, z]; scale: a number or [x, y, z]
const r = engine.ops.run('thing.set', args);
engine.ops.undo('thing.set', args, r.value);  // back where it was
const gone = engine.ops.run('thing.remove', { id: 'windmill' });  // detached and kept: undo puts it back
engine.ops.undo('thing.remove', { id: 'windmill' }, gone.value);
```
- A world record id turns into `world.set` / `world.move` (`rot` / `scale` are template instance fields) and `world.remove`; the model follows the
  record. `visible` is refused for a record (`recordVisible`): hide its model with `present({ show })` and a field.
- A `code` object gets its new values written and recorded as an override; a `session` object only changes in this session.
- Objects of engine modules are refused (`engineOwned`).

## 4c. Saves: the `scene` part (version 1)
`{ set: { windmill: { position: [5, 0, 2] } }, removed: ['old-fence'] }`, only for `code` objects. A load first undoes the current overrides (a new
game applies an empty part, so everything goes back to what the code built), then applies the save. An id the save names but no object has yet waits:
the override applies the moment `engine.add(obj, { id })` runs. One that never comes is an orphan: kept in the save, listed in
`describe().scene.orphans` and warned once (`thing-orphan`).

## 5. Moving from three.js to a template
When an object turns out to need saving, editing or many copies: register its builder as a model (`assets.manifest({ models: { windmill: buildWindmill } })`),
write a template, add a placement with an id. Delete the `engine.add` line. Nothing else in the game changes.

## 6. Verify and dev checks
`threedog check` flags the startup calls above; `engine.world.origin(id)` and `engine.pick(x, y).thing` say where a record came from (`30-templates.md`
§5); `engine.world.query({ kind: 'windmill' })` lists the records a save would hold.
- `engine.add(obj, { save: true })` for an object that cannot be saved (no id, or during play) warns at once (`thing-unsaved`); objects added inside an
  op are listed by `saves.save()` and in `describe().scene.unsaved`.
- `engine.add` of a world model throws (`thing-owned`): world adds, places and tears down its models.
- Code that moves a `positionFrom: 'record'` world model outside its present `update` is warned once and listed in `describe().scene.conflicts`.
- Dev builds take a short stack for `at`, at most 2000 per session (`describe().scene.atCapped` after that).

## 7. Why is this mesh this colour? (material provenance)

`engine.inspect.scene()` / `threedog scene` list, for each mesh, one `material:` line and the renderer line (tone mapping, exposure; the same text as `describe().render`). Diagnostics only: nothing about the picture changes.

```
renderer: aces (game) exposure 1.1 shadows pcf
✓ roof [Mesh] (4, 3, 0) r=2 · MeshLambertMaterial/roof
    material: roof from game · MeshLambertMaterial #3b5168 · map x color #3b5168 (vertexColors off) · map (base colour)
      note: map already carries colour and color #3b5168 is not white: the result is map x color (fine when it is a tint)
```

- `from` is `engine` (a neutral material the engine made) or `game`.
- `--json` carries `material.info[]` per mesh: role, from, type, color, maps (base colour vs detail), vertexColors, side, transparent, opacity, colorPath, notes.
- The tint note is not an error: a map times a non-white colour is how tinting works.

## 8. When to write plain three.js directly, and which integrations you lose

Plain three.js is always allowed (`engine.scene`, `engine.renderer`, `engine.camera` are the real objects; `engine.add(obj, { id })` keeps it saveable). Write it directly for a one-off effect, a special mesh, a shader nothing else shares. What you give up depends on how the material or pass was made:

| You wrote | Not applied to it |
|---|---|
| `new THREE.MeshStandardMaterial(...)` with no `applyEffects` | wind sway, snow and season cover, the cloud shadow, lighting and detail, `debug.view` modes |
| your own `EffectComposer` / render call to the canvas | the engine yields the frame (`[own-frame]`), so `engine.post` effects, adaptive resolution, photo mode, `describe().render.post`; keep them with `engine.post.add(pass)` instead |
| `renderer.toneMappingExposure = x`, `scene.fog = ...` | the debug layer's restore (`engine.debug.override` gives the old value back) |

The engine adds nothing to your materials. The cloud shadow is a signal (`engine.uniforms.uCloudShadow`, `uCloudShadowScale`, `uCloudShadowSpeed`) and a function: `applyEffects(mat)` gives a lit three.js material the engine's term, so it darkens under the drifting clouds like the engine's ground, on WebGL and WebGPU; your own shader calls `threedogCloudShadow(worldPos)` (recipe 43). Clouds dim the sun only (directional lights, every cascade included): a `PointLight` street lamp or a torch is never shaded by them. At 0 a uniform branch skips the cloud noise, and one program per material type stays. Snow and season cover work the same way: `applyEffects(mat, { season: 'ground' })` (`'foliage'` for leaves).
Keep the integrations by going through the engine: `applyEffects(mat, { wind, season, detail, lighting, patches })` on your material, `engine.post.add(pass | { name, fuse: { glsl }, slot })` for a screen effect.

## 9. One id, everything: explain and the three kinds of change
```js
engine.explain({ thing: 'chest-home' }).detail;  // CLI: threedog explain thing chest-home --full (MCP: explain); the same JSON
// { id, kind, owner, definition: { at: 'content/props.js:14', template, templateAt, level?, node?, spawned? }, model, materials: [{ role, name, from, keys }],
//   state, rules: { blocksMovement, pickable, interact, height }, ops: [{ op, desc, args }], saved: { tier, keeps, loses }, change: {…}, overrides? }
```
`ops` lists the ops whose definition names this id, kind or template in the optional `targets` field (`engine.ops.define('chest.toggle', { targets: 'chest', … })`;
`'*'` = any thing, which `thing.set` / `thing.remove` use). `definition.at` is null in release builds and for code run without a file (page `eval`).
`text` says in one line where the id comes from and how to change it for good; `detail` has type `ThingExplanation`. The same `engine.explain` answers an op, a quest, a value, a module and a capability (recipe 23).

| Kind | How | Lasts |
|---|---|---|
| Game state (a chest opens, a door moves) | an op: `ops.run('chest.toggle', { id })`, `thing.set`, `thing.remove` (section 4b) | by the thing's save tier |
| Permanent edit (another model, place, material) | content entry: `threedog content set <id> <field> <json>` (below); template or `engine.add` line: edit the file:line `explain().change.permanent` prints; then reload | forever |
| Diagnostic override ("show me without it") | `engine.debug.override(owner, id, { visible: false, material: 'flat' \| 'wire', apply })` | until `handle.remove()` / `engine.debug.clear(owner)`; never saved |

```js
const h = engine.debug.override('ai-session', 'windmill', { material: 'flat' });  // unlit base colour: is the colour wrong, or the light?
engine.debug.override('ai-session', engine.player.root, { visible: false });
engine.debug.override('ai-session', engine.renderer, 'toneMappingExposure', 3);  // any three.js value: (object, key, value); held above picture code until remove()
engine.describe().scene.overrides;  // [{ owner, target, material: 'flat' }, …]: the screen differs from the real state while this is non-empty
h.remove(); engine.debug.clear('ai-session');  // clear removes every override of that owner (and its debug.view) and nothing else
```
`apply(obj)` may return its undo function: any other picture (a view mode) uses the same owner mechanism. Overrides do not touch game state, ops or saves.

`threedog content set cabin x=12 z=3 place=home --in props` writes a permanent change into the content entry: several fields in one call (one write, one check, all or nothing;
values are JSON, a bare word is a string; `-w game` or `--dir folder` picks the game; `--dry` only shows it). It edits just that value in place (comments and spacing stay), adds the
field when missing, checks the one file it wrote (reverting if that fails; the full check stays `npm run check`) and tells you to reload. `--expect x=5` refuses the write when the
file no longer has the value you saw (someone else changed it). `content add props id=crate-7 template=crate x=1 z=2` appends one entry at the end (always with an id;
`--file content/props/town.js` picks the part of a folder kind) and `content remove <id>` deletes one. Fields are the content file's names
(`x`, `z`, `y`, `rot`, `scale`, `template`, `place`, `model`), not the record's `position`. It refuses, and says why with the line, for an entry built
by code (loop, spread, computed value), an id matching several entries (`--in props`), or an add / remove that would shift entries whose id is their position. A placed entry wins over a template or npc of the same name.
