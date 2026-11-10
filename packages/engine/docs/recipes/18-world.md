# World data: things that must be saved, grow, and keep changing while far away

> **Covers:** world records: things that are saved, grow and change while far away.
> **Use when:** an object must live on outside the view or across levels.
> **Shortest:** `engine.world.add({ id, kind, position })`.
> **Sections:** 1 Three steps data · 2 How to change · 3 Example a crop · 4 Data written in · 4b One object from · 5 Example something that · 6 Near, far, camera · 7 Time and ordering · 8 Querying nearby things · 9 zone and data

Requires `world()` (part of `openWorld()`); the examples also use `interactions({ ...presets.interactions.nearest })` and `inventory()`. API: `../api/world.md`.

Anything that must remember its state, survive level changes and keep changing while far away (chests, NPCs, crops, the player itself) is one **plain data
record** in `engine.world`: a stable id, a kind, a position, plus your own fields. The model is only how it looks when near; unloading tears down the model,
never the data; a save stores only data; far away the data is still simulated. A decorative rock is a props entry (recipe 05); many copies of one interactive
object are a content template with instances (recipe 30-templates.md), whose records hold only the instance state.

## 1. Three steps: data, picture, change
```js
const W = engine.world;
W.add({ id: 'zombie_1', kind: 'zombie', position: [10, 0, -4], hp: 10 });  // fields must be plain values; without an id one is numbered automatically (saved)
W.present('zombie', {
  build: rec => new THREE.Mesh(zombieGeo, zombieMat),  // required: built when the camera is near (may be async); world adds it to the scene at rec.position
  update: (rec, obj, dt) => { obj.visible = rec.hp > 0; },  // optional: called every frame for records that have a model; change the picture from the data
  dispose: (rec, obj) => engine.remove(obj),  // optional: first argument is the data, second the model; this is the default
  show: rec => rec.hp > 0,  // optional: false = this record has no model right now (picked up, waiting to respawn)
  radius: 40,  // optional: how near to build the model (meters or a function); default world.radius (60)
});
W.simulate('zombie', {
  near: (rec, dt, obj) => { W.move(rec.id, { x: rec.position.x + dt, z: rec.position.z }); },  // near the player: every fixed step; obj may not be built yet (null), gameplay must not depend on it
  far: (rec, dt) => { rec.hp = Math.min(10, rec.hp + dt * 0.1); },  // far away: once every farEvery seconds; dt is accumulated seconds (it can catch up a long time at once)
});
```
- If `build` throws, fails, or returns something that is not an object, the error is reported once and does not block the loading screen
  (`world.ready`); it retries when you walk away and come back.
- `show` is re-evaluated when `world.set` changes data of that kind. Calling `present` again for the same kind tears down old models with the old
  dispose and rebuilds them with the new one.
- Per-frame picture work (animation, particles) goes in `present.update`, which runs after world placed the model, so motion written there stays: `update: (rec, obj, dt) => { obj.getObjectByName('legL').rotation.x = Math.sin(rec.walk * 9) * 0.5;
  obj.position.x += rec.stagger * 0.1; }` (a leg swing, a stagger offset). Moving the model from anywhere else is put back next frame, with a warning.
- world places only the position of a model your `build` returns: apply `rec.rot` / `rec.scale` yourself (your units, on the root or a child),
  and again in `update` to follow later writes. Content props and templates turn and size theirs.

## 2. How to change data
- Discrete changes (open a chest, switch growth stage, get picked up, change direction) use `W.set(id, { opened: true })`: it emits `world:change` and
  re-evaluates `show`. Don't `set` every step. id / kind cannot be changed (to change the kind, remove then add).
- Things that change every step (position, timers, pathfinding state) are changed directly on the rec's fields inside simulate, and position with
  `W.move`: no event, cheap.
- Both ways are saved (a save compares contents). `move` emits no event: a picture that follows position compares in `update`.
- Don't hold a rec object for long: loading a save replaces it with a new object. Keep the id and call `W.get(id)` when you need it.
- Position forms: Vector3 / object / `[x, y, z]` / `{ x, z }` (a missing y keeps the old one). NaN or an array with only two numbers
  throws immediately, in release too, and writes nothing.

## 3. Example: a crop grows on the calendar, press E to harvest when ripe
The key idea: **record `plantedAt = clock.now` and compute growth = now - planted time** instead of accumulating every step: right after walking away, a save load or `engine.step(60)`, with no simulate.
```js
import { presets, THREE } from 'threedog';

const GROW = 120;  // ripe after 120 calendar seconds (the unit of clock.now)
const growth = rec => Math.min(1, (engine.clock.now - rec.plantedAt) / GROW);  // 0..1
const geo = new THREE.ConeGeometry(0.25, 0.8, 6);

engine.world.present('crop', {
  build(rec) {
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x6aa84f }));
    m.castShadow = true;
    m.userData.use = engine.interactions.add(m, { label: 'Harvest', radius: 2, enabled: () => growth(rec) >= 1, onUse: () => harvest(rec) });  // can be harvested only when ripe
    return m;
  },
  update(rec, obj) {  // grows bigger, changes color when ripe
    const g = growth(rec);
    obj.scale.setScalar(0.3 + 0.7 * g);
    obj.material.color.setHex(g >= 1 ? 0xe8a33d : 0x6aa84f);
  },
  dispose(rec, obj) { obj.userData.use.remove(); engine.remove(obj); },  // an interaction you registered yourself must be removed yourself
});

function harvest(rec) {
  engine.inventory.add('carrot', 2);
  engine.world.remove(rec.id);  // delete the data after harvesting (the model goes with it). To "grow back after a while": world.set(rec.id, { plantedAt: engine.clock.now }); to hide temporarily: return false from show
}

// the player plants one: an op, because saved state changes only in a fixed step or an op (recipe 23 §5); a key, a button or a test runs it
engine.ops.define('crop.plant', {
  desc: 'Plant a crop on the ground',
  args: { x: 'number', z: 'number' },
  run(e, { x, z }) { return e.world.add({ kind: 'crop', position: { x, y: e.surface(x, z), z }, plantedAt: e.clock.now })?.id; },
});
```
The same "store when, derive the rest" pattern fits any timed thing: an enemy camp that respawns (`clearedAt`), a turret or machine cooldown
(`usedAt`), a door that shuts again (`openedAt`):
`const ready = rec => engine.clock.now - rec.usedAt >= rec.cooldown;   // no per-step counter, correct after skip and load`
Test: `engine.ops.run('crop.plant', { x: 2, z: 2 })` -> `engine.step(130)` (130 real seconds, 130 calendar seconds at `clock.rate` 1) -> the player walks next to it -> `engine.ops.run('interaction.use')` ->
`engine.inventory.count('carrot')`.

## 4. Data written in content: `initial`
Things that exist from the start (3 crops already in the field, chests on the map) use `add(def, { initial: true })` and must have a stable id. **A
save records only their changes and deletions**: if the content changes (one more crop is placed), an old save shows it too; a deleted one stays gone
after loading, and a deleted field is "no such field" after loading; it does not matter whether `content.load` runs before or after loading the save.
```js
for (const [i, p] of [[0, 0], [2, 0], [4, 0]].entries())
  engine.world.add({ id: `crop-start-${i}`, kind: 'crop', position: { x: p[0], z: p[1] }, plantedAt: 0 }, { initial: true });
```
When placement should be "random but identical on every start", use `engine.random.seeded(seed)` (an independent generator that does not touch the
saved `engine.random`):
```js
const rnd = engine.random.seeded(7);
for (let i = 0; i < 20; i++) engine.world.add({ id: `rock-${i}`, kind: 'rock', position: { x: rnd.range(-40, 40), z: rnd.range(-40, 40) } }, { initial: true });
```
These loops show what content loaders do. In a game, put such entries in `content/props.js` (a loop inside the content file is fine): each then gets a
source line (`engine.world.origin(id).definedAt` in dev builds) and a new game stays equal to the content.
Gameplay randomness (drops, lightning, wander turns) still uses `engine.random` (saved; after loading it continues the same sequence). Records
generated at runtime (planted by the player, spawned) are saved whole; `add(def, { save: false })` is not saved (temporary things). The rules are
described at the top of `modules/world/persist.js`.
World models are in the thing registry too (`engine.thing(id)` answers with the record, saved `'record'`): do not move them from code. Change the
record (`ops.run('thing.set', { id, position })`, `world.set` / `world.move`) and the model follows; dev reports code that moves a `positionFrom: 'record'` model, and
`engine.add` of a model throws (recipe 40).

## 4b. One object from start to end: who owns what
Four questions meet in every object: where its state lives, when it may change, who owns each part, what a save keeps. Here one chest answers all four; a door,
a switch or a parked vehicle goes the same way. It is a flat content entry (recipe 30 §2 and §7) with the `chest` template and `chest.toggle` op of recipe 30 §1:
`content/places.js`:
```js
export default { yard: { x: 12, z: -6 } };
```
`content/props.js`:
```js
export default [{ id: 'yard-chest', template: 'chest', place: 'yard', x: 1 }];
```

| Step | What happens | Who owns what | What a save keeps |
|---|---|---|---|
| Creation | `content.load` makes the record `yard-chest` from the entry and the template's `state` | The content files own the definition and the starting position; `engine.world` owns the record | Nothing: the record equals the content |
| Near | The model is built at the record's position | The record owns position and `opened`; the model only shows them. Geometry and materials belong to `engine.assets`, shared by every chest | Nothing: models are not saved |
| Interaction | Using it runs the op: `e.world.set(id, { opened: true })` | Only an op or a fixed step changes the record; `animate` reads it. Nothing writes to the model | `opened: true`, the one changed field |
| Leaving the area | The model is torn down; the record stays, and `simulate.far` still runs if the kind has it | The world still owns the record; there is nothing to clean up. The shared model data outlives this copy | The same |
| Loading a save | The record becomes a new object with the saved change on top of today's content; the model is built again when near | Code keeps the id and calls `W.get(id)`: a rec or a model held from before is stale | The same; a place moved since the save moves the chest too |
| Removal | An op calls `e.world.remove(id)`; the model goes with the record | The record is gone. The shared model data stays until nothing uses it and `assets.trim()` runs (a level change does) | The deletion: the chest stays gone after loading, while a new game has it again |

The one habit that follows: hold `'yard-chest'`, never the record or the model, across any of these steps.

## 5. Example: something that wanders
For enemies that chase the player / wandering NPCs there is the ready-made `engine.npcs.behavior(name, { near, far })` + `engine.npcs.avoid` (mutual
avoidance), see recipe 02 "Changing behavior / custom behavior"; below is the pure world version without NPCs.
```js
engine.world.present('chicken', { build: rec => makeChicken() });
engine.world.simulate('chicken', {
  near: (rec, dt) => wander(rec, dt),  // near: a small step every fixed step
  far:  (rec, dt) => wander(rec, dt),  // far: catch up once every farEvery seconds
  farEvery: 2,
});
function wander(rec, dt) {
  const a = rec.heading ?? 0;
  engine.world.move(rec.id, { x: rec.position.x + Math.sin(a) * 1.2 * dt, z: rec.position.z + Math.cos(a) * 1.2 * dt });
  if (engine.random.chance(0.01)) engine.world.set(rec.id, { heading: engine.random.range(0, Math.PI * 2) });
}
```

## 6. Near, far, camera, player
- **Near / far is decided by the gameplay anchor `world.anchor`**: by default the position of the player record (`engine.focus` when there is no
  player). A cutscene or photo mode moves the camera away, but the player's surroundings are still simulated as near: gameplay results do not depend
  on the camera. For a top-down strategy game centered on a base, set `W.anchor = baseObject`; set it back to `null` to restore the default.
- **The player is a record too**: the id and kind added by `addPlayer` are both `'player'`; position, facing, motion state (vx, vz, vy, facing,
  grounded...) and which vehicle it is on (vehicle) live in the record and are saved, and it is never torn down by walking away. Only the character's
  mover changes the position and then writes it back to the record. `world.move`, `world.set` and `thing.set` on a live character (the player, an NPC with
  a model) are its `placeAt`: it goes there, standing on what is there, and the record says where it stands. A seated rider gets out to go there; undo of that `thing.set`
  seats it again, and answers `ownerRefuses` with the reason if the seat is gone or taken or it sits elsewhere. A ragdoll goes there whole and at rest, still limp. `rot` and `scale` on its record (`world.set`, `thing.set` `rotation` / `scale`) go to the character too: `rot` is its
  facing, kept in its motion (written with no model, it waits for the model), `scale` sizes `root` and stays on the record, so a rebuild and a load keep it. It
  is the picture: radius and height stay. A tilt about x or z, or a turn while seated (the seat turns its rider), is refused by name. On load the player is
  put back from the record.
- **Models are built around the stream sources** (`33-stream-sources.md`): by default the player (`engine.stream.player`, follows
  `world.anchor`) and the camera
  focus (`engine.stream.camera`). Built inside the radius of any source, torn down beyond 1.25x of all of them, with an error of at most 8 meters; at
  most `world.buildPerFrame` are built per frame (default 8, unlimited while loading), and `ready` waits until all are built. Tearing a model down
  never touches its record.
- `positionFrom: 'view'` (the model moves itself, for example an NPC driven by the character mover): near simulation builds the model on the spot and
  copies the model position back to the data at the end of every fixed step; when not simulated near, the data decides and the model follows the data.
  A write to the record (`world.move`, `world.set`, `thing.set`, or `rec.position` itself, seen at the end of the step) moves the model, and a rigid body on
  that model goes along at rest, however the body was made. `rot` and `scale` on a template with a `body` build a new body where the record stands; with your
  own `present` and `positionFrom: 'view'` they are your fields, so read them there.
  A model moved by a physics body saves its position, not the physics solver state: after a load, resting bodies settle again and can differ by ~0.01
  mm, so replays that must match exactly should not depend on physics props.
- Radius: present / simulate each take their own `radius` (meters or a function); without it they follow `world.radius` (default 60).

## 7. Time and ordering rules (nothing lost, nothing doubled, loading a save is bit-identical)
- A kind on a channel owes what it lived through: a far `dt` that spans a slowdown is the sum of each stretch at its own speed, and it survives a save.
- The dt of both near and far is accumulated fixed-step seconds (real seconds: not multiplied by `clock.rate`; with `simulate(kind, { channel: 'enemies' })` both are multiplied by that time channel's speed). For one record, whether near, far, or
  alternating, the dts add up to the elapsed time: on the step going from far to near, `far` first catches up the owed time, then `near` runs.
- **Kinds that only define far** (crops) are not split into near and far; even when you stand next to them they advance at the far pace. **Kinds that
  only define near** are not simulated far away, and the owed time is not caught up.
- Near: at the start of each step, the records inside the radius are gathered and simulated one by one **sorted by id** (independent of insertion
  order and loading; when near records affect each other, running continuously and saving then loading give bit-identical results).
- **Near tiers** for crowds: `simulate(kind, { near, fullRadius: 25, nearEvery: 4 / 60 })` runs records within `fullRadius` every step and the rest of
  the near zone once every `nearEvery` seconds, handing it the seconds since its last turn. Turns go by hashed id and step count (saved), so loading a
  save between turns gives the same result. NPCs use it only when the game opts in (`engine.npcs.tiers({ fullRadius, nearEvery })`); leave it off for enemies whose every step matters.
- Far: records are bucketed by id and taken in turns (one round every `farEvery` seconds), at most `world.farMaxPerTick` records per fixed step
  (default 500); the rest queue for the next step, and dt keeps accumulating without loss. It counts records, not milliseconds, so the result does not
  depend on how fast the machine is.
- The owed time and the simulation step count are saved: after loading they are caught up the same way, and the same save gives the same result
  however many fixed steps run per frame. For things measured on the calendar (grows in a few days, respawns at a time), record `engine.clock.now` and compare.
- **Far in workers** (thousands of crops, spawners or machines): `W.simulate('crop', { far, worker: true })`. Each step's far batch runs in `engine.threads` workers and is written
  back 4 fixed steps later through `ctx.commits`; a late reply runs on the main thread, so threads on / off / slow give **bit-identical** records, and only fields far changed are written
  back. `far` must be self-contained: it is recompiled from source and sees only `(rec, dt)` and globals like `Math`; an outside variable throws (also with `threads: false`, so you find
  it in development). Limit: a save taken while a batch is in flight re-simulates that stretch after loading (equal within float tolerance, not bit-identical).

## 8. Querying nearby things
```js
let crowd = 0;
engine.world.forEachNear(engine.player, 5, (rec, d2) => { if (rec.kind === 'zombie') crowd++; });  // no allocation, no sorting; world.query sorts nearest first and returns an array
```
For things that query neighbors every step (hundreds of zombies avoiding each other) use `forEachNear`; inside the callback don't add / remove / move,
note them down and change them after the loop.

## 9. zone and data limits
- A record can carry a `zone` (for example the level name); once `world.zone` is set, records with a different zone get no model and no near
  simulation, and the data stays when the level changes.
- Data must be plain values (numbers, strings, booleans, arrays, plain objects): in development, putting a three.js object or a function in it throws
  immediately and explains the fix — models go in present, logic goes in simulate.

