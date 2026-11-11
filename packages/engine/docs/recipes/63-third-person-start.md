# Third-person start: walking, camera, save, pause, menu

> **Covers:** the shortest third-person start, and its first-person variant (§7): walking, camera, collision, save, pause, menu.
> **Use when:** a character walks around a place you built, seen from behind or through its eyes.
> **Shortest:** about twenty lines (§1); first person changes three of them (§7).
> **Sections:** 1 About twenty lines · 2 What each line · 3 Where it stops · 4 Talk, press E · 5 Not worth it · 6 A model made · 7 First-person start

The blank template's `main.js` plus a few lines, on any ground (`--open-world` adds terrain and a sky on the same parts). The picture stays plain three.js in `picture/`.

## 1. About twenty lines
```js
import 'threedog/tsl';  // WebGPU with TSL, as a new game starts; a game started with --webgl drops this line and `renderer: 'webgpu'`
import { createEngine, presets, world, content, settings, characters, collision, followCamera, hud } from 'threedog';
import { createPicture } from './picture/index.js';
import data from './content/index.js';

const engine = createEngine({ canvas: document.getElementById('view'), renderer: 'webgpu', lights: false,
  bindings: { ...presets.bindings.walk, ...presets.bindings.interact },  // Shift runs, Space jumps, E uses; WASD, arrows and the pad stick are built in
  ui: { loading: { title: 'Pier' }, title: { title: 'Pier' } }, saveKey: 'pier' });  // start screen: Continue (once a save exists), Start, Settings
engine.use(world(), content(), collision(), characters(), followCamera({ pointerLock: true }), hud(), settings({ freezeWorld: true }));
engine.saves.autosave(0.5);  // every 30 s of play
engine.use(createPicture());
const { picture } = engine;
engine.collision.addBlocked((x, z) => Math.abs(x) > 3 || Math.abs(z) > 20);  // the walkable shape: here a pier 6 m by 40 m
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });
engine.content.load(data);

const game = { score: 0 };
engine.saves.define('game', { version: 1, save: () => ({ ...game }), load: d => { Object.assign(game, d); } });
engine.hud.addCounter('score', { label: 'Score', value: game.score });
Object.assign(window, { engine, picture });
await engine.start();
```

## 2. What each line gives
Each line is one module you can swap: `characters()` with `presets.player.thirdPerson` (WASD, arrows, stick, run, jump, camera-relative walking, gravity), `followCamera()` (the camera follows, the mouse turns it, walls pull it in), `saves.autosave` and `saves.define` (position and your state come back after a refresh; Continue on the start screen), `settings({ freezeWorld: true })` (Esc stops the game and opens a menu: quality presets, volume, keys, language, saves), `collision()` (`addBlocked`, `addBox`, `addCircle`, `addObject(mesh)`), `hud()` (`addCounter`).

A floor that is not at `y = 0`: `engine.setGround({ height: (x, z) => 0.4 })`. A body for the player: `addPlayer({ model })` (recipe 13); without one it is a gray capsule. Feet on stairs and slopes: `engine.player.anim.addFeet()` ([13 §3e](13-animation.md)).

## 3. Where it stops
Each part is one line to swap and none of them holds the rest back:
- Your own movement or feel: recipe 21 §5 replaces one piece of the player and keeps saving and `describe().player`; dropping `characters()` leaves the rest working.
- Your own start screen: `engine.ui.set('title', ...)`; menu: recipe 26 §6. End screens: recipe 26 ("A window: results, game over"); replay with `engine.session.newGame()`.
- Saving at a moment you choose (a lamp lit, a level done): `await engine.saves.save()`. A refresh keeps what the last save wrote; a save started as the page closes is not reliable.

## 4. Talk, press E, a counter
Add `THREE, interactions, dialogue` to the import and `interactions({ ...presets.interactions.nearest }), dialogue()` to `engine.use`; E is already bound in section 1 (any other key works: `interact: ['KeyF']`; with no key at all dev warns with the line to add). Then, before `engine.start()`:
```js
const guide = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1, 4, 8), new THREE.MeshStandardMaterial({ color: 0xc89a5a }));  // any three.js object
guide.position.set(0, 0.9, -8); engine.scene.add(guide);
const shell = new THREE.Mesh(new THREE.SphereGeometry(0.25), new THREE.MeshStandardMaterial({ color: 0xd8c8a8 }));
shell.name = 'shell'; shell.position.set(1, 0.25, -4); engine.scene.add(shell);
engine.dialogue.define('guide', { start: { text: 'Pick up the shell, then walk to the end of the pier.', choices: [{ text: 'On my way', do: s => { s.flags.met = true; } }, { text: 'Later' }] } });
engine.interactions.add(shell, { id: 'shell-1', label: 'Pick up', once: true, counter: 'coins' });  // hides it, counts it, both saved
engine.interactions.add(guide, { label: 'Talk', onUse: () => engine.dialogue.start('guide') });  // E nearby; the same call works on a door, a lever
engine.hud.addCounter('coins', { label: 'Coins', value: 0 });  // call again with a new value to update it
```
A quest with a marker arrow and a log (J): recipe 04. Dialogue flags and what `once` and `counter` did are saved by the modules. An interaction's `counter` adds 1 to the HUD counter of that name (`hud.bump`); read the total with `engine.hud.value('coins')`.

Camera blocking: recipe 21 (`addStatic`).

## 5. Not worth it for a small game
Plain three.js and `engine.setGround` are shorter for these; the modules pay off when a game leans on them.
- Water: a `PlaneGeometry` with your material; `water()` is for floating waves, or swimming.
- Terrain: `engine.setGround({ height: (x, z) => ... })` plus meshes; `terrain()` is for large streamed worlds.
- The sky module for a fixed time of day: a background color or gradient mesh and your lights; `sky()` is for a changing day.
- Rigid vehicles: a mesh moved by your rule needs no physics; `rigid()` is for pushing, rolling, colliding.

## 6. A model made in code, placed in content
The shape is code, where it stands is content. The blank game ships one gray example.
```js
// assets.js: a generator returns a geometry (drawn gray) or an Object3D; it runs once per name, every placement is a clone
const marker = () => new THREE.CylinderGeometry(0.2, 0.25, 1.2, 12).translate(0, 0.6, 0);
export default [{ name: 'starter', models: { marker } }];
```
```js
// content/props.js: placements, each with a stable id (saved with the game)
export default [{ id: 'marker-1', model: 'marker', x: 0, z: -2 }, { id: 'marker-2', model: 'marker', x: 3, z: -5 }];
```
`scene.add` at startup also works, but the model stays out of GAMEMAP and the save; `world.add` at startup duplicates after each load unless `{ save: false }` (`npm run check` warns; recipe 18). A `.glb` registered under the same name later replaces the generator (recipe 05). `threedog lib list` and `threedog how "<words>"` search the library before you build from scratch.

## 7. First-person start: walk and collide with walls you built
The same start with the camera at the eyes; §1 changes in the player preset, the camera module, and the walls (code-built level, grid, maze).
```js
import { createEngine, presets, world, content, settings, characters, collision, firstPersonCamera, hud } from 'threedog';
engine.use(world(), content(), collision(), characters(), firstPersonCamera({ height: 1.6 }), hud(), settings({ freezeWorld: true }));  // pointer lock is on by default
engine.characters.addPlayer({ ...presets.player.aim, spawn: [0, 0, 0] });  // aim: the body turns with the view
const maze = ['.....', '..#..', '.....'];  // rows by z, columns by x, 1 m cells from 0, 0: '#' = wall (your grid or code map)
engine.collision.addBlocked((x, z) => maze[Math.floor(z)]?.[Math.floor(x)] === '#');  // walls of a grid or code map: one pure function
engine.collision.addBox([4, 0, -6], { halfWidth: 1, halfDepth: 0.2, height: 3 });   // one wall, crate or door frame
engine.cameraRig.yaw = Math.PI;  // heading: yaw 0 looks toward -z, PI toward +z (recipe 21 §3)
```
`world()` stays even with no content and no saves (the player is a record in it); `content()`, `hud()`, `settings()` can go.
Walls from your own geometry are only picture until a collider (api/collision.md) says no. Later third-person: `engine.setCamera('follow')` (recipe 21 §1).
