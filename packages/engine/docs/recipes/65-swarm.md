# Swarm: shots, crowds, pickups, debris by the thousand

> **Covers:** swarm: thousands of shots, crowds, pickups or debris in one draw.
> **Use when:** very many simple moving things.
> **Shortest:** `engine.use(swarm())`, then `engine.swarm({ name, capacity, geometry, material })`.
> **Sections:** Which tool for many · The id rule handles · Hits near · The same thing in · Drawing · Time, saves, limits · Pure picture GPU compute

```js
import * as THREE from 'three';
import { swarm } from 'threedog';
engine.use(swarm());
const bullets = engine.swarm({
  name: 'bullets', capacity: 4096,
  geometry: new THREE.SphereGeometry(0.1, 6, 4),
  material: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  fields: ['vx', 'vz', 'life'],  // your own number columns, beside x, y, z
});
bullets.onStep((d, i, dt) => {  // set once; runs every fixed step, for each live object
  d.x[i] += d.vx[i] * dt;
  d.z[i] += d.vz[i] * dt;
  return (d.life[i] -= dt) > 0;  // false removes it; anything else keeps it
});
engine.onFixed(() => {
  if (engine.input.pressed('fire')) bullets.spawn({ x: 0, y: 1, z: 0, vx: 20, life: 2 });
});
```
One swarm is a set of same-kind objects that the game plays with: they spawn, die, move, collide and get asked about. Their data sits in typed arrays, one
array per field, and they draw as one plain `THREE.InstancedMesh`: one draw call, nothing allocated per object. The geometry and material are yours and work
on WebGL and WebGPU alike. There is no framework behind it: a game that does not call `engine.use(swarm())` pays nothing.

## Which tool for many things
| The things | Use | Why |
|---|---|---|
| Hit, are hit, get counted, saved or asked about: bullets, enemies in a horde, coins, crops | `engine.swarm` | spawn, die, move and query, on the fixed step |
| Only seen, short-lived, no rules: dust, sparks, smoke | `engine.particles` (recipe 64) | emitters, fades and sizes over a lifetime |
| Placed once, do not move: fences, rocks, a crop field's scenery | `engine.batching` or `props` (recipe 05) | no per-frame work at all |
| Only seen, a very great number, and the game runs on WebGPU: snow, ash, star fields | GPU compute, last section | the CPU never touches them |
| A few dozen that each need their own logic, animation or a skeleton | one object each (`engine.characters`, plain meshes) | a swarm is same-kind objects, one geometry, no skeleton |

The test: if game rules read the thing, it is a swarm; if only eyes do, it is one of the visual tools.

## The id rule: handles and rows
Two numbers, never mixed up.

- A **handle** is what `spawn` returns and what `d.id[i]` holds. It names one object for as long as it lives and never names another afterwards. Keep these, in a variable or in a
  field of any swarm: a turret's target, a homing missile's prey. A handle in a save stays good after loading that save.
- A **row** `i` is where the object sits now: what `onStep` and `near` pass, what `d.x[i]` reads. Removing an object moves the last row into the gap, so a
  row means something only inside one callback or one plain loop. Never store a row.

`swarm.row(handle)` turns a handle into today's row, -1 when it is gone. `free` takes a handle; given a row by mistake it throws `[swarm-handle]`.
```js
const enemies = engine.swarm({ name: 'enemies', capacity: 2000, fields: ['hp'] });
let target = enemies.spawn({ x: 5, z: 2, hp: 3 });  // a handle: safe to keep
engine.onFixed(() => {
  const i = enemies.row(target);  // today's row, -1 once it died
  if (i < 0) return;
  enemies.data.hp[i] -= 1;
  if (enemies.data.hp[i] <= 0) enemies.free(target);
});
```
Inside `onStep` and `near` you may `free` and `spawn` freely. A freed object counts as gone at once (`row` and `near` skip it, `count` drops), and rows only move
when the walk ends, so nothing is skipped or run twice. An object spawned during a walk first moves in the next step. To walk every object outside a callback:
`for (let i = 0; i < s.count; i++)` reading `s.data`, without removing; collect handles and free them afterwards.

## Hits: `near`
```js
const shots = engine.swarm({ name: 'shots', capacity: 1024, fields: ['vx', 'vz'] });
const crowd = engine.swarm({ name: 'crowd', capacity: 8000, cell: 2, fields: ['hp'] });
shots.onStep((d, i, dt) => {
  d.x[i] += d.vx[i] * dt;
  d.z[i] += d.vz[i] * dt;
  let hit = false;
  crowd.near(d.x[i], d.z[i], 0.6, (c, j) => {
    hit = true;
    if ((c.hp[j] -= 1) <= 0) crowd.free(c.id[j]);
    return false;  // false stops the query: this shot is spent
  });
  return !hit;
});
```
`near(x, z, r, cb)` calls `cb(d, i, dist2)` for each live object within `r` meters on the ground plane; height is ignored, so a game that needs it compares `d.y[i]`
itself. It returns how many it visited, and the order is the same every run. The grid behind it is built on the first query after things moved, once per step
when you only ask at one point in the step, and not at all if nobody asks. `cell` is about your usual query radius.

Inside `onStep`, `near` on the same swarm sees cells from the start of the step, with live positions for the distance. Fine for crowds keeping apart; for exact
answers query after the step (`engine.onFixed(fn, { phase: 'late' })`). A bullet faster than its radius per step can jump over a target: use a radius of at least
speed x dt / 2, or check along the path yourself. Rays: `engine.rays` does not hit instances; three's `Raycaster` on `swarm.mesh` gives `instanceId`, which is a row.

## The same thing in other games
Tower defence: enemies walk a path, each tower holds one handle and keeps it until `row` says -1.
```js
const creeps = engine.swarm({ name: 'creeps', capacity: 500, fields: ['along', 'hp', 'yaw'] });
const towers = [{ x: 4, z: 4, target: -1 }];
engine.onFixed(() => {
  for (const t of towers) {
    if (creeps.row(t.target) >= 0) continue;  // still alive: keep shooting it
    t.target = -1;
    creeps.near(t.x, t.z, 8, (d, i) => { t.target = d.id[i]; return false; });
  }
});
```
Farm game: crops grow slowly, stay where they are, and belong in the save.
```js
const crops = engine.swarm({ name: 'crops', capacity: 5000, fields: ['age', 'scale'], save: true, color: true });
crops.spawn({ x: 2, z: 3, scale: 0.2, color: 0x88cc44 });
crops.onStep((d, i, dt) => {
  d.age[i] += dt;
  d.scale[i] = Math.min(1, 0.2 + d.age[i] / 300);
});
```

## Drawing
- Matrices are written once per rendered frame, between the last two fixed steps (`engine.stepBlend`), so motion stays smooth at any frame rate. Writing `d.x[i]` from
  `onFixed` is smoothed the same way.
- Fields named `yaw`, `pitch`, `roll` (radians, three's order `'YXZ'`) and `scale` are drawn when you list them. Without them only the position is written, which is cheapest.
- `color: true` adds columns `r`, `g`, `b` (linear) and the spawn key `color: 0xff8800`. Your material's colour multiplies it.
- `swarm.mesh` is plain three.js: set `castShadow`, `layers`, `renderOrder` on it. The instance index is the row, and `mesh.count` follows the live count.
- A transparent swarm draws in row order: three sorts objects, not the instances inside one, so overlapping see-through objects can blend in the wrong order.
- Bounds are kept up to date while matrices are written, so culling is right for the whole swarm; it is one object to the camera, so it is drawn whole or not at all.
- Leave out `geometry` and `material` for a swarm that only holds data, and draw it your own way from `swarm.data`.

## Time, saves, limits
- `onStep`'s function runs on the fixed step with the `dt` of the swarm's time channel, default `'world'`; `{ channel: 'enemies' }` joins bullet time (recipe 55). It does not run while
  frozen, or while that channel stands still. `engine.skip` does not run it either: nothing in a swarm ages during a skip.
- `{ save: true }` keeps a swarm in saves, handles included. Any swarm without it is emptied by a load or a new game, so last round's bullets do not stay on the field. A saved
  swarm with objects at start returns to them on `engine.session.newGame()`. A saved field added in a later game version starts at its default.
- Saves write every number of every object: fine for crops, wasteful for 50,000 bullets, which is why it is opt-in.
- `capacity` is fixed and all memory is taken at once. A full swarm refuses the spawn: `spawn` returns -1, `dropped` counts it, one `[swarm-full]` warning names it, and `free(-1)` is
  harmless. `describe().swarm`, `engine.explain({ swarm: 'name' })` and `engine.counts().swarm` show the numbers. Your own `fields` are `Float64Array`, so a handle kept in one stays exact. `x`, `y`, `z` and `r`, `g`, `b` are `Float32Array`: fine for a position or a colour, not for a handle.
- `swarm.dispose()` removes the mesh and its GPU buffers; so do `engine.unuse('swarm')` and `engine.dispose()`. Geometry and material stay yours to dispose.
- A swarm is for one shape. Three enemy kinds are three swarms, or one swarm when they differ only in colour and scale.

## Pure picture: GPU compute
When nothing in the rules reads the things, and the game runs on WebGPU, they need not touch the CPU at all. This is plain three.js with no engine API. It needs a real
WebGPU device to be worth it: without one, use `engine.particles` or a swarm. Pick it over a swarm when the count is far past what the CPU should write per frame and no game
code needs an answer back: reading a GPU buffer takes frames, so `near` and hits are out.
Build it with three's TSL as in three's own compute examples (an `instancedArray` buffer, compute nodes, a `SpriteNodeMaterial` reading the buffer through `positionNode`). What the engine adds is where each call goes:
```js fragment
import 'threedog/tsl';  // before createEngine
const gpu = /** @type {any} */ (engine.renderer);  // a WebGPURenderer: the engine's type also covers WebGL
await gpu.computeAsync(seed);  // once, to fill the buffer
engine.onFrame(d => { uDt.value = engine.frozen ? 0 : d; });  // time as a uniform set here, so a freeze stops the snow
engine.onRender(() => { gpu.compute(fall); });  // the shader here, so it runs once per drawn frame
snow.frustumCulled = false;  // the sprite's own bounds know nothing of the flakes
```
