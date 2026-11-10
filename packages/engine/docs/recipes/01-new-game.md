# Starting a new game

> **Covers:** a new game folder: page, modules, content data, tests.
> **Use when:** starting any game.
> **Shortest:** `npm run new-game -- my-game` (`npx threedog init` outside the repo).
> **Sections:** 0 One-command setup preferred) · 1 Creating the files · 2 Verify · 3 Feel presets opt-in) · 4 Canvas size full

Goal: a game with its own page, modules, content data and tests. The engine's own example is `examples/world/` in the package.

In a folder of your own, installed from npm: run `npx threedog init` (add `--open-world` for the second form below), then `npm install`. In the engine repository: `npm run new-game -- my-game` creates `games/my-game/`. The rest of this page uses the repository form; read `games/my-game/` as your folder and `new-game` as `init`.

## 0. One-command setup (preferred)
```
npm run new-game -- my-game                     # blank start: an empty scene and a camera; no gameplay, no genre assumed
npm run new-game -- my-game --open-world        # generated ground, a day/night sky, a follow camera and a player
npm run new-game -- my-game --webgl             # either one on WebGL, shaders in GLSL, instead of WebGPU and TSL
```
(The `--` matters: without it npm swallows the flags. The CLI form takes them directly: `threedog new-game my-game --open-world`.)
A new game runs on WebGPU, shaders in TSL (recipe 56); `--webgl` is for GLSL. Without WebGPU the same game runs on three's WebGL2 backend, slower; `engine.describe().renderer` says which and why.
The name may only contain lowercase letters, digits and dashes; an existing directory under `games/` with the same name is refused. What it does:
1. Copies `packages/tools/templates/game/` to `games/my-game/` (`__NAME__` in the files is replaced by the name); `--open-world` copies `templates/openworld/` over it first.
2. Creates the `node_modules/my-game` link (the path npm gives a workspace named `my-game`). It builds nothing and leaves `package-lock.json` alone; it runs `npm install` only when a dependency of the template is not installed yet, and says so.
3. Runs `map` (generates GAMEMAP.md) and `check`. Any failing step stops and says why. The smoke test (`threedog test -w games/my-game`) builds, so it is left to you.

The default game has no genre: `world()` + `content()`, what nearly every game needs (a start screen with Continue / Start, autosave, Esc = pause + settings menu; delete a line if the game does not want it), a plain `THREE.PerspectiveCamera` placed by hand and the gray starting picture. No ground, sky, player or camera rig: a card table, a puzzle room, a side-scroller and an open world start differently (a character walking around a place you built: recipe 63, about twenty lines).
Content files start empty, a comment in each saying what goes there, except `props.js`, whose `marker-1` shows the shape. `picture/` (`index.js` wiring, `palette.js`, `lights.js`, `materials.js`) is plain three.js, yours to change or replace (recipe 62).
`--open-world` swaps `main.js` for `openWorld` (generated terrain from `@threedog/terrain-noise`, vegetation, a day/night sky, weather, water, collision, a
follow camera) and a player at a flat spot, with `sky()` giving the signals and `picture/` writing the lights; it adds `@threedog/terrain-noise` to `package.json`. `spawn` and `places` take any `{ x, z }` (or `{ x, y, z }`); `findSpawn` is only for generated terrain.
The canvas is the one you gave `createEngine({ canvas })`, also `engine.renderer.domElement`; the engine keeps no canvas property of its own.

- The comments in `main.js` list further gameplay modules you can add; usage is in `../api/<module>.md`.
- To change the starting point of new games, edit the real files in `packages/tools/templates/game/` (`templates/openworld/` for `--open-world`).
- `DESIGN.md` is a form to fill in with the game's design, `STATUS.md` holds progress, and `CLAUDE.md` holds the working rules, a table cut from AI.md and the reading order.
- There is no `tests/`: a smoke test runs until you add `tests/specs/`.

## 1. Creating the files by hand (to learn what each file is, or when the template doesn't fit)
| File | Content |
|---|---|
| `games/my-game/package.json` | Copy the template's and set `name` to `my-game` (the plain game name; `@threedog/` is the engine's packages). Dependencies `threedog`, `@threedog/tools`, plus `@threedog/terrain-noise` only for an open-world start and `@threedog/post-effects` only when the game imports it |
| `games/my-game/vite.config.js` | One line: `export default gameConfig(import.meta.dirname)` (imported from `@threedog/tools/vite`); *.html files in the directory are bundled automatically, no `input` needed. Without `@threedog/tools`, a plain vite config needs `worker: { format: 'es' }` (the engine's Workers are ES modules) or `vite build` fails; `threedog dev / build` on a folder with no vite config uses the preset |
| `games/my-game/index.html` | The page: one `<canvas id="view">` with a CSS size + `/main.js` (for more pages put `xxx.html` in the same directory); see §4 for embedding |
| `games/my-game/main.js` | Install modules, compute places, `content.load`, wire the game's systems (template `CLAUDE.md`, "Content vs code") |
| `games/my-game/content/index.js` | Combines the content files into one object |
| `games/my-game/content/*.js` | Only these names are read: items pickups containers npcs dialogues quests actions places triggers level vegetation props templates audio views grids renames rules, plus the game's own kinds (rules.js) |
| `games/my-game/DESIGN.md` | The design as a form (copy the template's), copied into GAMEMAP.md |
| `games/my-game/STATUS.md` | Progress and what comes next (copy the template's) |
| `games/my-game/CLAUDE.md` | Working rules and reading order (copy the template's) |
| `games/my-game/public/` | This game's art assets (URL `/models/...`); keep Blender source files in `games/my-game/art/models/`, `npm run assets -- optimize -w my-game` compresses them into `public/optimized/` |

After creating them, run `npm install` once at the repository root (this links the new game into the workspaces so `threedog` can find it).

Outside the engine repository, a game installs `threedog` and `three` (plus `@threedog/post-effects` / `@threedog/terrain-noise` if it imports them,
and `@threedog/tools` as a dev dependency for the CLI and the vite preset). To use an engine folder on disk instead of npm, install it with
`npm install --install-links <folder>`: a plain link skips the engine's own dependencies (Rapier, Recast) and the build cannot resolve them.

In a game's own repository, `threedog check`, `types` and `map` read only the game's sources: `node_modules`, a `vendor/` folder and every `file:` /
`link:` dependency are skipped. To narrow it further, list the sources in the game's `package.json`:
`"threedog": { "src": ["main.js", "src", "content"], "exclude": ["notes"] }` (paths relative to the game folder; `src` defaults to the whole folder).
The template's `tsconfig.json` checks the game files only (`checkJs`), with `lib` ESNext + DOM (dependency typings such as Rapier's use
`Symbol.dispose`) and `skipLibCheck: true`; without a tsconfig, `threedog types` writes the same settings to `.threedog/tsconfig.types.json`.


`games/my-game/main.js`: the opening lines are written out once, in [recipe 63](63-third-person-start.md) §1 (the blank template's `main.js` has the same opening with `world(), content(), settings()` and the camera placed by hand). What an open-world game with a few gameplay modules changes in it:
```js
// my-game: ... (this first comment line appears in the file table of GAMEMAP.md)
// The opening stays as in recipe 63 §1: createEngine({ canvas, lights: false, ui, saveKey, bindings }), engine.use(createPicture()) after engine.use,
// Object.assign(window, { engine, picture }) (tests, screenshots and the console rely on it), await engine.start().
import { presets, openWorld, interactions, dialogue, inventory, pickups, quests, content } from 'threedog';
import { terrainPreset } from '@threedog/terrain-noise';  // optional terrain generator (nor a world shape)
import data from './content/index.js';

// keys: modules only declare actions, the game binds them (presets.bindings.* are ready-made maps); this goes in createEngine({ bindings })
const bindings = { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory, ...presets.bindings.quests };
// the preset only covers world and environment; the debug panel is installed in dev builds only (debug: true forces it in release too)
engine.use(openWorld({ camera: 'follow', seed: 42, terrain: terrainPreset(), time: 0.3 }),
  // add gameplay modules as the game needs (a shooter has no inventory); pickups() when items lie on the ground (content pickups)
  interactions({ ...presets.interactions.nearest }), dialogue(), inventory(), pickups(), quests(),
  content());
// the terrain is generated: find flat ground as "home" at the start (give your own height range to avoid beach and peaks)
const home = engine.characters.findSpawn([0, 0, 0], { minH: 3, maxH: 14 });
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: home });
engine.content.load(data, { places: { home } });  // on top of the names in content/places.js; content uses { place: 'home', x, z }, quests target: 'home'
```
Every `openWorld` part takes `false` (leave it out) or its module's own options object, so you never have to drop the preset for one setting:
`openWorld({ seed: 42, camera: 'follow', calendar: { seasons: ['wet', 'dry'], daysPerSeason: 28 }, characters: { npcs: false }, rigid: false, ambience:
false, debug: false })`;
`camera` is required (no default camera) and takes `'follow'` / `'firstPerson'` / `'rts'` / `'fixed'`, a camera module such as
`followCamera({ shoulder: 0.7 })`, or `false`. A game that wants only a few parts (an arena without terrain) turns the rest off the same way:
`openWorld({ camera: 'follow', terrain: false, vegetation: false, weather: false, water: false })`.
With `terrain: false` the game supplies its ground. Until it does, characters, props and pickups stand on an invisible flat plane at y = 0 (no
warning): they look like they float over nothing. Draw the ground yourself, and if it is not flat at y = 0 tell the engine its height:
```js
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8c8c8c }));  // what you see
floor.receiveShadow = true; engine.add(floor);
engine.setGround({ height: (x, z) => 0 });  // what walking, placing and the camera read (a ramp, a raised floor: return its y here)
```
Walls and obstacles are `engine.collision.addBox(obj, { halfWidth, halfDepth })`; a Blender level brings its own ground (`level()`, next paragraph).
`saveKey` must differ per game, otherwise saves overwrite each other. The UI language follows the player's browser (Chinese browser -> Chinese,
otherwise English) unless you set `createEngine({ locale: 'zh-CN' })` (`'zh'` and `'en-US'` match too; a language with no strings warns). A game on a level built in code: register
the level generator function under `models` in `engine.assets.manifest({ name, models })`, use `level({ url: name })` and pick your own modules, then
create the player and install content in `level:loaded`.

`games/my-game/content/index.js`:
```js
import items, { startItems } from './items.js';
import places from './places.js';
export default { items, startItems, places };
```
`content/places.js`: `export default { farm: { x: 12, z: -4 }, home: 'flat ground found at the start' };`. `content.load` reads a place written with coordinates from the data; a text entry only declares the name for `threedog check` and waits for `content.load(data, { places })`.

## 2. Verify
1. `npm run map` -> generates `games/my-game/GAMEMAP.md`; check the "engine modules" and "page /" sections.
2. `npm run check` -> content validation points out wrong file names, ids and clock-time formats; `npm run types` finds misused engine APIs.
3. `npm run shot -- -w my-game / --describe-only` -> the text has a `player` line with its position, the module list, and no "still loading".
4. `npm test -w games/my-game` -> without `tests/specs/` a smoke test runs; gameplay specs: `COMMANDS.md` §"Running one game only" (a minimal example).
5. To see the picture: `npm run shot -- -w my-game /`; while developing `npm run dev -- my-game` and read errors in `games/my-game/.threedog/errors.log`.


## 3. Feel presets (opt-in)
The engine applies no gameplay feel by itself: `weather()` alone has only a calm `clear`, `sky()` no seasons, and calls that need a feel refuse to guess
(`addPlayer()` throws `[player-control]` without `control`, `interactions()` `[interaction-setup]` without `pick`, `openWorld()` `[open-world-camera]` without `camera`).
`presets` holds named option objects a game picks on purpose, bundling options you could write yourself, so spread and override:
```js fragment
import { presets, weather, calendar, sky, followCamera, interactions } from 'threedog';
engine.use(calendar(presets.calendar.fourSeasons), sky(), weather({ ...presets.weather.temperate, autoPool: ['clear', 'rain'] }), followCamera(presets.camera.overShoulder));
engine.use(interactions({ ...presets.interactions.facing }));  // nearest / facing / aim, each with E
const player = engine.characters.addPlayer({ ...presets.player.lockOn, faceTarget: boss });  // none / thirdPerson / lockOn / aim / sideScroller
```
The run / jump keys are `presets.bindings.walk`. No module or preset takes keys: every key comes from `createEngine({ bindings })` or `engine.input.bind(...)`.

## 4. Canvas size: full window, a page section, a split layout or an editor panel
The engine follows the canvas's own CSS box (a `ResizeObserver` on the canvas), not the window: renderer size, camera aspect, `input.pointer` (`x / y`
pixels and `ndcX / ndcY` relative to the canvas), `engine.pick`, `screenToGround`, `worldToScreen` and the HUD all use that box, and the engine's UI
root is laid exactly over it. So the layout decides:
```html
<style>#view{position:fixed;inset:0;width:100%;height:100%;display:block}</style>   <!-- full window (the template) -->
<section style="position:relative;width:640px;height:360px"><canvas id="view" style="width:100%;height:100%;display:block"></canvas></section>   <!-- in a page -->
```
A canvas with no CSS size takes its size from its own pixel buffer, which would grow on every resize; the engine then sizes it to the window and warns
once in dev. The pixel ratio (`createEngine({ pixelRatio })`, adaptive resolution) applies on top of the CSS size.
