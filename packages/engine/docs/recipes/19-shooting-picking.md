# Shooting and picking (cast a ray from the screen center or the mouse position, with any camera)

> **Covers:** a ray from the screen center or the pointer: shooting, selecting, tapping.
> **Use when:** the player aims, clicks or taps at something in the scene.
> **Shortest:** `engine.pick(x, y)` or `engine.rays`.
> **Sections:** 1 A first-person shooting · 2 What happens after · 3 Testing

Works with any camera (`follow`, `firstPerson`, `rts`, `fixed`): a click-to-select strategy game, a puzzle that taps tiles or a first-person shooter all
use the same ray. The example below is the first-person case; a score display needs `hud()`.
The ray API is `engine.pick(ndcX, ndcY, opts)`: screen coordinates -1..1 (0, 0 is the screen center, which is also the first-person crosshair); it
returns the nearest hit `{ point, distance, object, ... }` or null. **If you only want to hit your own targets, pass `targets: [array of objects]`; no
ray registration is needed.**

## 1. A first-person shooting range (copy it and it runs)
```js
import { createEngine, presets, openWorld, hud, THREE } from 'threedog';
import { createPicture } from './picture/index.js';  // the game's own picture, plain three.js (recipe 62)
import { terrainPreset } from '@threedog/terrain-noise';

const engine = createEngine({ canvas: document.getElementById('view'), lights: false, saveKey: 'range' });
engine.use(openWorld({ seed: 7, terrain: terrainPreset(), camera: 'firstPerson' }), hud());  // camera (required): 'follow' | 'firstPerson' | 'rts' | 'fixed', or pass a module like firstPersonCamera({ height: 1.7 })
engine.use(createPicture());
const { picture } = engine;
engine.input.define('shoot', { label: 'Shoot', keys: ['Mouse0', 'KeyF'] });  // the left mouse button is a key too (Mouse0 / Mouse1 / Mouse2); either it or KeyF works
engine.characters.addPlayer({ ...presets.player.aim, spawn: engine.characters.findSpawn([0, 0, 0], { minH: 3, maxH: 14 }) });
Object.assign(window, { engine, picture });
await engine.start();  // place targets after the terrain is generated

// Targets: ordinary three.js objects. Put your own data in target.userData; managing them with a Map / Set is faster than traversing the scene
const targets = [];
function addTarget(x, z) {
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 16), new THREE.MeshLambertMaterial({ color: 0xd9534f }));
  t.rotation.x = Math.PI / 2;
  t.position.set(x, engine.surface(x, z) + 1.5, z);
  engine.add(t); targets.push(t);
}
const p0 = engine.player.position;
for (let i = 0; i < 6; i++) addTarget(p0.x + (i - 2.5) * 3, p0.z - 15);

let score = 0;
engine.hud.addCounter('score', { label: 'Hits', value: 0 });
engine.describe.add('range', () => ({ score, targets: targets.length }));  // dev bridge: threedog describe range; in code the part sits under its name: engine.describe('range').range.score

engine.onFixed(() => {  // firing is gameplay: read it in fixed so the result is independent of frame rate
  if (!engine.input.pressed('shoot')) return;  // "just pressed" from the fixed-step snapshot; one click counts once
  const hit = engine.pick(0, 0, { targets });  // cast from the screen center; hit.object may be a child mesh of the target, so find the target as below
  const t = hit && targets.find(x => x === hit.object || x.getObjectById(hit.object.id));
  if (!t) return;
  engine.remove(t); targets.splice(targets.indexOf(t), 1);
  engine.hud.addCounter('score', { value: ++score });  // calling again with the same id = update
});
```
- **Where fire and reload live**: the engine has no weapon system. In a game with ammo they are the game's ops (`engine.ops.define('weapon.fire', ...)`, recipe 23), so a key, a test and the dev bridge run one path; the fixed step above only calls `engine.ops.run`.
- **Finding the target again**: when a target is made of several meshes, `hit.object` is the piece that was hit. Set `userData.target = true` on the
  target's root object, then `let o = hit.object; while (o && !o.userData.target) o = o.parent;`.
- **Why not read `pointer.clicked`**: it is true only for "this frame" and requires no dragging; a fixed step can miss that frame (at a high frame
  rate a frame may have 0 fixed steps). Leave `clicked` for UI and clicking the ground (read it in onFrame); bind firing / attacking to a `Mouse0`
  action and read `pressed` in onFixed.
- **Picking instead of shooting**: for the mouse position use `engine.pick(engine.input.pointer.ndcX, engine.input.pointer.ndcY, { targets })`; with
  the mouse locked in first person use `(0, 0)`. To click the ground (move, place) use `screenToGround(engine, ndcX, ndcY)`.
- **The first click**: on desktop, first person by default needs one click on the canvas to lock the mouse. That press only locks: it is not delivered
  as `Mouse0` and not as a click, so it cannot fire (every later click after Esc and a re-lock behaves the same). `swallowLockClick: false` on the
  camera delivers it too.
- **Adding a gamepad button**: `engine.input.define('shoot', { label: 'Shoot', keys: ['Mouse0', 'KeyF', 'PadRT'] })`; the key names go into the settings key table and the
  UI prompts. A touch tap does not count as `Mouse0` (give phones a button: `engine.input.touchButton('shoot', 'Shoot')`).
- To hit terrain / houses / registered static objects, don't pass `targets` (the default hits what was registered with `rays.addStatic`); to hit rigid
  bodies too, pass `targets: 'all'`.

## 2. What happens after a hit
- Hit-point effect: `engine.particles.emit(name, hit.point)` (install `particles()` first, recipe 64).
- For bullets with flight time (arcs, enemies dodging): don't use a ray; write `world.add({ kind: 'bullet', ... })` + `world.simulate`, see `18-world.md`.
- Distance limit: `engine.pick(0, 0, { targets, far: 60 })`.
- Recoil: `pick` casts from the camera as last drawn, so a `rig.yaw` / `rig.pitch` write reaches it on the next drawn step. For several shots in one step with recoil between them, build the direction from the rig's angles and use `engine.raycast`.
- Score, ammo: `hud.addCounter` / `hud.bar`; numbers that must be saved go in `engine.vars` (`engine.vars.bump('score')`); after changing them call
  `hud.addCounter` again to sync the display.

## 3. Testing
```js fragment
engine.haltLoop();
engine.input.simulate('shoot'); engine.step(0.1); engine.input.simulate('shoot', false);  // simulate a click on the action bound to Mouse0 (use your action name)
// To hit a specific target: first aim the camera at it with engine.cameraRig.lookAt(target), then click
```
From the command line: `threedog press Mouse0` (the same as pressing a keyboard key), then look at `describe range`:
```
threedog press Mouse0
threedog describe range
```
