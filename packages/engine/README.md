# threedog

A web 3D game engine on three.js 0.187: **core** (rendering, main loop, input, audio, saving, UI) -> **modules** (terrain, sky and weather, physics, characters, dialogue, inventory, quests... installed on demand); all art is the game's own (`picture/` folder, `assets.js`).

## Install
This README describes threedog 1.0 (older releases do not match it; from 0.x read `docs/MIGRATING-1.0.md`, from 0.8.0 `CHANGELOG.md`, from 0.7.0 first `docs/MIGRATING-0.8.md`). To work on the engine itself, clone the [repository](https://github.com/penstic123-code/Threedog.js-Game-Engine), run `npm install`, then `npm run new-game -- my-game`. A game in its own folder:
```sh
npm install threedog@1 three@~0.187.0
npm install @threedog/terrain-noise@1      # optional: the noise terrain generator terrainPreset() (without one the ground is flat)
npm install -D vite @threedog/tools@1      # optional: the vite preset and the threedog command line
```
Then let it set up the folder: `npx threedog init` (flags: `--open-world` for generated ground, sky, follow camera and a player; the default is a blank scene with a camera and a gray starter picture in `picture/`) writes index.html, main.js, vite.config.js, content/, CLAUDE.md and `.mcp.json` (Claude Code then starts the threedog MCP server by itself), never overwriting a file you have. Finish with `npm install` (for what the new files need) and `npm run dev`.
`three` is a peer dependency: your game and the engine share one copy. Types for three come with the engine (`@types/three`, same version), so `// @ts-check` JS and TypeScript both see real three.js types.

## Minimal usage
```js
import 'threedog/tsl';   // WebGPU with TSL, what a new game starts on; a game started with --webgl leaves this line out and the renderer option below
import { createEngine, presets, openWorld } from 'threedog';
import { terrainPreset } from '@threedog/terrain-noise';   // optional terrain generator (npm install @threedog/terrain-noise)

const engine = createEngine({ canvas: document.getElementById('view'), renderer: 'webgpu' });   // no picture code yet: gray placeholders
engine.use(openWorld({ camera: 'follow', seed: 7, terrain: terrainPreset() }));
engine.characters.addPlayer({ ...presets.player.thirdPerson });
engine.start();
```
The picture is the game's own: plain three.js in its `picture/` folder (what `threedog new-game` generates), reading signals from `engine.uniforms`. A new game runs on WebGPU with TSL shaders, or on WebGL with GLSL shaders through `--webgl`. A browser without WebGPU still runs the WebGPU form, on three's WebGL2 backend, slower; `describe().renderer` says why.
`vite.config.js` with the preset: `import { gameConfig } from '@threedog/tools/vite'; export default gameConfig(import.meta.dirname);`

## Entry points
- `threedog`: the whole public API (`THREE` is re-exported, so `import { THREE } from 'threedog'` is the same three instance).
- The engine ships no art (visuals only; the noise terrain generator `terrainPreset()` is `@threedog/terrain-noise`); without picture code everything is a neutral gray placeholder.
- `threedog/tsl`: the WebGPU route; import it before `createEngine({ renderer: 'webgpu' })`. Also TSL helpers for materials and lighting.
- `threedog/layers`: `RESERVED_LAYERS`, the three.js layers the engine keeps (a game's own are 1 to 25).
- `threedog/pixel`: `pixelGrid`, `pixelSprite`, `spriteFrame` (art pixel math on an orthographic camera, and an upright sprite; recipe 62 section 4b).
- `threedog/grid`: `sampleGrid`, `gridFromPixels`, `decodePng` (2D fields; no three.js, works in workers and tests).
- `threedog/worker`: `serve(handler)`, the worker side of `engine.threads` lanes.

Nothing else is a public path: `threedog/error-hints`, `threedog/metadata` and `threedog/spelling` are there for `@threedog/tools`, not for game code; files under `core/`, `modules/` etc. may move between versions.

## Changes to three.js
The engine changes three.js in a few places, because three.js has no per-object hook for what it needs. `describe().threePatches` lists every one at run time, `threePatches.off(id)` turns off the ones that can be turned off, and `docs/THREE.md` is the full list, with what each does to your code.

Raycasting is not a global change: a mesh registered as static gets its own bounds tree and its own `raycast`; `Mesh.prototype.raycast` is untouched.

## Docs
Shipped in the package: `docs/AI.md` (how to use the engine, written for AI assistants), `docs/API.md` + `docs/api/` (per module), `docs/recipes/` (task guides), `docs/THREE.md` (using three.js directly).
