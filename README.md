<p align="center">
  <img src="docs/brand/threedog-square.png" alt="Threedog.js logo: three cartoon dogs" width="200">
</p>

<h1 align="center">Threedog.js</h1>

<p align="center">
  A three.js game engine built for AI agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/threedog"><img src="https://img.shields.io/npm/v/threedog?label=npm" alt="Version on npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/three.js-0.187-black" alt="three.js 0.187">
  <img src="https://img.shields.io/badge/rendering-WebGPU%20%7C%20WebGL2-teal" alt="Rendering: WebGPU and WebGL2">
</p>

<p align="center">
  English · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="#what-it-can-do">What it can do</a> · <a href="#quick-start">Quick start</a> · <a href="#minimal-code-sample">Code sample</a> · <a href="#background">Background</a> · <a href="#design-philosophy">Philosophy</a> · <a href="#architecture">Architecture</a> · <a href="#modules">Modules</a> · <a href="#examples">Examples</a> · <a href="#tools-for-ai">AI tools</a> · <a href="#performance-and-partitioning">Performance</a> · <a href="#status-and-known-limits">Status</a> · <a href="#docs">Docs</a> · <a href="#faq">FAQ</a>
</p>

Threedog lets an AI build games in plain JavaScript and three.js. The engine handles time, input, assets, saves, physics and world management, and it comes with tools to run, check and debug a project. A project can start from an empty scene and add modules as it needs them.

The look and the rules belong to the project. Materials, lights, models and scene objects are three.js objects, and the engine only handles what several systems must agree on. An AI can then find the right interface, verify its own result, and still reach for three.js directly when a request gets complicated.

> **Version: 1.1.0.** Install it from npm, or run the engine [from source](#create-a-project-from-source).

## What it can do

| | |
|---|---|
| ![First-person view of a shotgun firing at a walker in a walled yard under a pink sky](docs/brand/screens/shooter-yard.jpg) | ![A red car and a blue car side by side on a road through dark pines at dusk](docs/brand/screens/racing-dusk.jpg) |
| First-person shooter | Racing |
| ![A fox runs past coins on a flat, paper-cut landscape at sunset](docs/brand/screens/platformer-fox.jpg) | ![Glowing towers beside a stone path on a dark grid, with enemies walking the path](docs/brand/screens/tower-defense-lanterns.jpg) |
| 2D side-scroller | Tower defense |
| ![A timbered town street at night with lit windows and lamps](docs/brand/screens/open-world-town-night.jpg) | ![Huge blue and violet crystals rising from a bright sea under a ringed planet](docs/brand/screens/crystal-sea.jpg) |
| Open world | Stylized shaders |
| ![A ghost in a candle-lit ballroom with a checkered floor](docs/brand/screens/haunted-ballroom.jpg) | ![The editor panel beside a gray terrain, with a selected marker and its fields](docs/brand/screens/editor-placing-props.jpg) |
| Horror | In-browser editor |

These games run on one engine. AI agents built each from a short brief in about 30 to 60 minutes, art included, and played it through by script. Every picture comes from code the agent wrote. More records are in the [capability tests](docs/testing/capability/).

## Quick start

You need [Node.js](https://nodejs.org) 20.19+ (20.x) or 22.12+.

### Create a project from source

Use this route until 1.0.0 is published. The project lands in `games/my-game/`, linked to the engine source, and F2 opens the editor on the dev server.

```sh
git clone https://github.com/penstic123-code/Threedog.js-Game-Engine.git
cd Threedog.js-Game-Engine
npm install
npm run new-game -- my-game
npm run dev -- my-game
```

For a start with ground, sky, a follow camera and a player, add `--open-world` to the `new-game` line.

### Create a standalone project

Once 1.0.0 is published, install it like this:

```sh
mkdir my-game
cd my-game
npm init -y
npm install threedog@1.0.0 three@~0.187.0
npm install -D @threedog/tools@1.0.0
npx threedog init
npm install
npm run dev
```

Open the address the terminal prints. The default template is an empty scene with a camera, a gray starting picture and the basic wiring for startup, saves and settings. It assumes no terrain, player or game type. The folder needs a name npm accepts. In one it refuses, a Chinese name for example, `npm init -y` stops with "Invalid name": skip that line, and the next one writes `package.json`.

`init` has a few options:

| Option | Starting point |
|---|---|
| `--open-world` | Ground, sky, a follow camera and a player |
| `--pixel` | A pixel-picture template |
| `--webgl` | WebGL and GLSL shaders instead of the default WebGPU and TSL |

The two render routes use different picture code, so the choice is made when the project is created. `createEngine()` itself defaults to WebGL, and the project template sets WebGPU.

### Where to start changing things

```text
main.js       creates the engine, installs modules, connects project systems
content/      instances, items, places and other content data
picture/      materials, lights and the look, in three.js
plugins/      one-file pieces, picked up when dropped in
assets.js     declares project assets
DESIGN.md     the project's design notes
STATUS.md     current progress
CLAUDE.md     working instructions for the AI
```

These folders are a suggested start, and plain three.js objects can go straight into the scene. The whole process is in [Starting a new game](packages/engine/docs/recipes/01-new-game.md).

## Minimal code sample

This can replace `main.js` in the blank template, keeping the template's `<canvas id="view">`. It shows a spinning cube with WebGL and a native material.

```js
import { createEngine, THREE } from 'threedog';

const canvas = document.getElementById('view');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('The page needs <canvas id="view"></canvas>');
}

const engine = createEngine({
  canvas,
  renderer: 'webgl',
  lights: false,
});

engine.scene.background = new THREE.Color(0x20242c);
engine.camera.position.set(3, 2, 5);
engine.camera.lookAt(0, 0, 0);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x78a6ff }),
);
engine.scene.add(cube);

const ambient = new THREE.HemisphereLight(0xffffff, 0x303040, 2);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(3, 5, 2);
engine.scene.add(ambient, sun);

engine.onFrame(dt => {
  cube.rotation.y += dt * 0.5;
});

// The dev tools inspect and drive the engine through this reference.
window.engine = engine;
await engine.start();
```

The scene, geometry, lights and materials are three.js objects. `onFrame` updates visual animation, and game state such as damage, cooldowns and character decisions goes in `onFixed` or a project op.

## Background

Have you seen the demos AI makes with three.js? The pictures are often startlingly good, and they make you wonder whether it could build a whole game. AI knows the front end and three.js so well that writing one should come easily. Yet with every new game it rewrites saves, collision and the interface, and as the project grows that code gets harder and harder to maintain. If an engine for three.js had those shared parts ready, AI could pick them up and go straight to making the game. Threedog.js is that engine.

## Design philosophy

**An AI can find, use and check what exists.** The engine offers docs searched by task, a capability catalog, a command line, MCP and runtime checks. Ease of use also means an AI can tell whether a module is ready, why an action failed, which system controls an object, and whether a change took effect.

<p align="center"><img src="docs/brand/diagrams/design.png" alt="The loop: the AI writes three.js, the engine plugs it in and coordinates it, the AI checks the result, then the next change" width="760"></p>

**three.js keeps its full expression.** A project can make its own materials, lights, geometry and shaders, and it can plug in its own render pass. [THREE.md](packages/engine/docs/THREE.md) covers cameras, resource release, shared state and render backends.

**No fixed look or gameplay.** The gray placeholder is only a start. Cartoon, realistic, pixel and procedural looks are the project's choice. Follow cameras, inventories, quests and open worlds are all optional, and a world can be a height field, a hand-built mesh or an imported level.

**Many tools, few concepts.** One job has one recommended entry. What three.js already does clearly, the engine does not wrap.

**Modules have clear boundaries.** Modules declare what they need and provide, shared state coordinates changes from several systems, and diagnostics trace who controls a value and who wrote it.

More background is in [the philosophy](docs/philosophy.md) and [how the design evolved](docs/evolution.md).

## Architecture

```text
Project
├─ behavior code: rules, ops, character decisions
├─ content/: instances, places, items and content parameters
└─ picture/: three.js materials, lights and the look
          │
          ▼
Optional modules: terrain, characters, physics, navigation, weather, interaction...
          │
          ▼
Base runtime: core/ + render/ + ui/
Time, input, assets, saves, module lifecycle, rendering and diagnostics
          │
          ▼
three.js / Rapier / Recast and other base libraries

<p align="center"><img src="docs/brand/diagrams/arch.png" alt="Layers: your game, modules, core, rendering, three.js and Rapier, with the agent tools beside them" width="760"></p>

Dev tools: connect to the running project, run actions, read state, check results
```

`createEngine()` creates the base runtime, `engine.use(...)` installs a module and `engine.unuse(...)` removes it. Modules describe dependencies and replacement with `requires`, `provides` and `replaces`. A custom module joins the same way as a built-in one, and the listeners and update hooks it adds enter the lifecycle through `ctx.track(...)`.

Time has three stages:

| Hook | What goes there |
|---|---|
| `onFixed` | Game logic on a fixed step |
| `onFrame` | Per-frame display such as animation and the HUD |
| `onRender` | Picture updates just before drawing |

`scene.add(obj)` suits ordinary display objects. An object that needs a stable ID and engine registration uses `engine.add(obj, { id })`; see [the scene conventions](packages/engine/docs/recipes/40-scene.md). A project's own state joins saves through `engine.saves.register(...)`.

Maintainers can read [the current architecture](docs/architecture.md). Project authors do better starting from the [AI index](packages/engine/docs/AI.md).

## How gameplay and picture work together

Gameplay code decides what happens, and picture code shows it in three.js. Rain is one example. The weather system records the current weather, the picture reads it to decide clouds, raindrops and wet ground, audio reads it to play rain, and gameplay can use it to change friction or crop growth. The same rain state can be drawn as a realistic curtain, cartoon lines or pixel particles.

<p align="center"><img src="docs/brand/diagrams/picture.png" alt="Game systems send signals to the picture folder, which is plain three.js; big pieces hand out materials and checks read the result" width="760"></p>

```text
Weather state
├─ picture reads → clouds, raindrops, wet ground, lights
├─ audio reads   → rain, wind
└─ gameplay reads → friction, crops, character behavior
```

Shared signals such as time, daylight and wind reach the picture through `engine.uniforms`. Below, `sun` is a three.js light the project made and `palette.sun` is the project's own strength:

```js fragment
engine.onRender(() => {
  sun.intensity = palette.sun * engine.uniforms.uDaylight.value;
});
```

Character positions and rules change in the fixed step, and display objects can interpolate between steps with `engine.stepBlend` so movement stays smooth. Player input and a cutscene may both drive one character; the [control interface](packages/engine/docs/recipes/57-control.md) records who holds it and handles taking over and giving back. When several systems affect one value, `engine.mod` keeps each source separate, so a slow-down and a temporary boost each remove their own share when they end. That interface is still marked experimental.

Terrain, vegetation and weather keep data apart from drawing. A project can keep terrain queries for movement and placement while drawing the ground its own way.

## Modules

`modules/` holds 30 module folders, and one folder may have several public factories. Input, saves, assets and basic audio live in the core, so they are not in this table.

<p align="center"><img src="docs/brand/diagrams/module.png" alt="A module has one type, slots and install; ctx ties it to the engine, and what it made leaves with it" width="760"></p>

| Module | Purpose | Source |
|---|---|---|
| World | Records of world objects; models load and unload around the view | [world](packages/engine/modules/world/) |
| Content | Feeds content data files into the modules | [content](packages/engine/modules/content/) |
| Level | Loads a glTF or code-built scene and makes it playable | [level](packages/engine/modules/level/) |
| Terrain | Chunked, streamed ground with sampling, editing and drawing | [terrain](packages/engine/modules/terrain/) |
| Vegetation | Species, placement, tree collision and instanced drawing | [vegetation](packages/engine/modules/vegetation/) |
| Grid | Placement on cells: furniture, buildings, towers, crops, tactics | [grid](packages/engine/modules/grid/) |
| Calendar | Time of day, dates and seasons | [calendar](packages/engine/modules/calendar/) |
| Sky | The sky and environment signals | [sky](packages/engine/modules/sky/) |
| Weather | Weather state, changes and drawing | [weather](packages/engine/modules/weather/) |
| Water | Water drawing and its interfaces | [water](packages/engine/modules/water/) |
| Collision | Collision and obstacle queries for character movement | [collision](packages/engine/modules/collision/) |
| Rigid | Rapier bodies, joints and related physics | [rigid](packages/engine/modules/rigid/) |
| Nav | Recast navmesh and pathfinding | [nav](packages/engine/modules/nav/) |
| Characters | Player, NPCs, movement, vehicles and control | [characters](packages/engine/modules/characters/) |
| Camera | Follow, first-person, fixed and strategy cameras | [camera](packages/engine/modules/camera/) |
| Gameplay | Interaction, dialogue, inventory, pickups and quests | [gameplay](packages/engine/modules/gameplay/) |
| Triggers | Who enters, stays in and leaves a zone | [triggers](packages/engine/modules/triggers/) |
| Flow | Game states and scene transitions | [flow](packages/engine/modules/flow/) |
| Timeline | Cutscenes and actions arranged in time | [timeline](packages/engine/modules/timeline/) |
| Swarm | Many same-kind moving things: bullets, debris, enemy crowds | [swarm](packages/engine/modules/swarm/) |
| Particles | Running and drawing particle effects | [particles](packages/engine/modules/particles/) |
| HLOD | Merges far buildings into a few proxy meshes for fewer draw calls | [hlod](packages/engine/modules/hlod/) |
| Lights | Many sources sharing a few real lights | [lights](packages/engine/modules/lights/) |
| HUD | Objective markers, counters and progress bars | [hud](packages/engine/modules/hud/) |
| Settings | A menu for quality, sound, keys and more | [settings](packages/engine/modules/settings/) |
| Photo | Photo mode | [photo](packages/engine/modules/photo/) |
| Music | Music playback and switching | [music](packages/engine/modules/music/) |
| Ambience | Ambient sound | [ambience](packages/engine/modules/ambience/) |
| Debug | Dev debug panel and inspection entry | [debug](packages/engine/modules/debug/) |
| Net | Experimental host-authoritative co-op sync, with known problems | [net](packages/engine/modules/net/) |

For daily use, look up the entry in the [task index](packages/engine/docs/AI.md), then read the [module API](packages/engine/docs/api/) and the matching recipe.

## Graphics tools and packages

The engine offers material patches, ramp textures, vertex AO, cascaded shadows, a post-effect chain, light probes, lightmaps and occlusion culling. All are optional. Write the picture in native three.js first, and look these up when you need them.

| Package | What it is |
|---|---|
| [`threedog`](packages/engine) | The engine |
| [`@threedog/tools`](packages/tools) | The `threedog` command line, the MCP server and production tools |
| [`@threedog/post-effects`](packages/post-effects) | Optional post effects: color grading, film grain, vignette, depth of field and more |
| [`@threedog/terrain-noise`](packages/terrain-noise) | Optional noise-based terrain: hills, islands, canyons, rivers |

A new game starts on WebGPU with TSL, the node shader language of three.js. In a browser without WebGPU the same game runs on the WebGL2 backend of three.js, more slowly. A few effects (`voxelGI`, `temporalAA`, `sunShafts`, `lightVolumes`) exist only in TSL; see [WebGPU and TSL](packages/engine/docs/recipes/56-webgpu-tsl.md).

## Examples

| Example | What it shows |
|---|---|
| [plain-picture](packages/engine/examples/plain-picture/) | A project picture in plain three.js |
| [world](packages/engine/examples/world/) | World features working together |
| [action](packages/engine/examples/action/) | Organizing the rules of an action game |
| [rc2d](packages/engine/examples/rc2d/) | Screen-space global illumination for top-down and side-view games |
| [techniques](packages/engine/examples/techniques/) | Different picture techniques |
| [webgpu-tsl](packages/engine/examples/webgpu-tsl/) | WebGPU and node shaders |
| [perf-island](packages/engine/examples/perf-island/) | A performance scene and its trade-offs |

To learn by task, read the [recipes](packages/engine/docs/recipes/). There is no need to read the whole API first.

## Tools for AI

An AI works by finding a capability, writing code, running actions and reading results. The command line and MCP (Model Context Protocol, used by tools such as Claude Code and Cursor) offer the same entries; the options are in [the command docs](packages/engine/docs/COMMANDS.md).

```sh
npx threedog how "day night cycle"   # which recipe answers a task
npx threedog check                   # rules, types, content and misuse of the API
npx threedog play                    # start the game for the tools
npx threedog describe                # read the running state
npx threedog shot --play             # a screenshot and the picture check
npx threedog play --stop             # stop the dev server
```

| Entry | Use |
|---|---|
| `how` | Searches the docs by task; queries must be in English for now |
| `catalog` | Lists capabilities, options and ops |
| `check` | Checks rules, content and API use, ending in one line: passed or failed |
| `describe` / `inspect` / `explain` | Reads state, object details and reasons |
| `play` / `press` / `step` / `op` | Starts and drives the running project |
| `shot` | A screenshot and picture facts, such as what is blown out and which light is the likely cause |
| `verify` | Runs a scenario from `tests/scenarios/`, with PASS or FAIL |
| In-browser editor | F2 on the dev server; edits write back to content files |

An AI presses keys, advances game time, runs a player action and reads the outcome as text, with no person at the keyboard. The template ships `CLAUDE.md` and the MCP config, and asks the AI to check whether the game or the engine already has something before it writes a new system. Other AI assistants can read the same instructions and use the tools over MCP or the command line.

A project can add custom modules, define ops, register save state, and replace parts through public contracts:

- [Custom modules](packages/engine/docs/recipes/14-custom-module.md)
- [Shared state and module replacement](packages/engine/docs/recipes/55-mods-time-wrap.md)
- [Using three.js directly](packages/engine/docs/THREE.md)
- [Conventions](packages/engine/docs/CONVENTIONS.md)

## Results

**Whole games.** Seven games from short briefs, each in about 30 to 60 minutes. The latest three (shooter, racing, 2D platformer) were built from the shipped docs and tools with no engine changes, and each put its rules in separate files by system. [First-round record](docs/testing/capability/composite-round-1.md).

**Single tasks.** [85 tasks](docs/testing/capability/) cover the engine's modules and command groups, each judged by a script or a stated screenshot. 76 passed in the first round, and the rest went into the engine fixes that followed.

**A large city.** On one RTX 5060 laptop with WebGPU at 1280×720, a city 1.9 km across (about 6,400 buildings and 72,000 meshes) runs at about 60 fps with 14,000 moving cars and people, 200 NPCs and 8 real lights, measured while other tests kept the machine busy. Moving objects set the limit: at 28,000 it drops to 26 to 35 fps, while a map four times larger leaves frame time unchanged. Ten minutes of walking showed no leak, and 12 rounds of save and load were all correct. [Full report](docs/testing/field/2026-11-05-city/acceptance.md).

**Test suite.** 9,777 checks in 1,353 items, all passing. CI runs the static checks, a browser group and a build on every push.

## Performance and partitioning

A large world is split so that the game pays only for what is near. Each part can be turned off or replaced, and none changes the rules of the game:

- **Partitioning:** terrain and world content load in chunks around the player and any other stream source. Physics colliders follow the same sources, and distant simulated things catch up in larger steps.
- **Drawing less:** LOD, merged distant models (HLOD), occlusion culling and batching of repeated objects.
- **Budgets:** adaptive resolution, shadow update budgets and quality presets change only what is displayed.

With all of these on and then all off, measured on 2026-11-07 on an RTX 5060 laptop with WebGPU, the picture differed by 0% at seven moments, saves and collision were equal, and median main-thread time per frame fell from 5.2 ms to 2.5 ms. That scene is one test page, so a real game's gain depends on its content.

## Status and known limits

This table lists only what has actually been run:

| Where | Status |
|---|---|
| Chrome and Edge on Windows, WebGPU and WebGL | Supported. Real GPU runs, a 30-minute soak on Chrome |
| Firefox and WebKit builds on Windows | One release scene passed on the WebGL2 backend, with no WebGPU |
| Chromium on Linux | CI only, on software rendering. No real GPU run |
| Safari, macOS | Never run. Mac support comes after 1.0 |
| Phones, tablets, Electron, Tauri | Not tested |
| Gamepad and touch | Tested with simulated devices only |

Known limits:

- **Multiplayer:** `engine.net` is experimental and has known problems. 1.0 makes no promise about its behavior.
- **Video memory:** destroying and re-creating the engine again and again adds about 0.2 MB of video memory each time. Normal play does not.
- **WebGPU:** a throw in a game's own `onBeforeRender` stops the picture, and the error is reported. This is a three.js limit.
- **Pathfinding:** the first path for a new body size builds its navmesh on the main thread, which can hitch for about 0.3 s on a large level; asking once during loading avoids it. A `nav({ crowd: true })` crowd runs on one mesh only.
- **Saves:** a game's own save part that awaits `level.load` or `content.load` must pass the `turn` it was given. Without it the load waits, then fails after `engine.loading.timeoutMs`.
- **Rays:** something moved between two rays of one step answers from the next step, a cost of keeping rays cheap on thousands of static meshes.
- **Streaming:** `stream.ready` means nothing is pending, not that everything built. A failed build is reported and left out.
- **Physics props:** a settled prop that was moved and then put back by an undo, saved and loaded on a fresh page, drops again from its authored place, a few centimeters at most.
- **Finding features:** `threedog how` matches words, in English, so a plain phrasing can put the wrong answer first. `threedog how --browse` lists everything by category.

## Docs

| File | Content |
|---|---|
| [AI.md](packages/engine/docs/AI.md) | The recommended entry for each task |
| [API.md](packages/engine/docs/API.md) | Public API index, generated from code |
| [recipes/](packages/engine/docs/recipes/) | Guides by task |
| [COMMANDS.md](packages/engine/docs/COMMANDS.md) | Every command |
| [THREE.md](packages/engine/docs/THREE.md) | Native three.js: how it joins, where the limits are |
| [Architecture](docs/architecture.md) | A code and responsibility map for maintainers |
| [FAQ](docs/faq.md) | Common doubts, including what the engine cannot do |
| [CHANGELOG](packages/engine/CHANGELOG.md) | What changed in each version |

Experimental interfaces are marked `@experimental`.

## FAQ

### How does Threedog relate to three.js?

three.js provides the scene, cameras, geometry, materials and rendering. Threedog adds a game runtime, module coordination and AI tools on top. A project keeps writing its picture in three.js and can work on `engine.scene`, meshes and materials directly.

### Does it fix a look or a kind of gameplay?

No. The picture comes from the project's models, materials, lights and shaders, the gameplay from its rules, and modules are chosen as needed.

### Do I have to install every module?

No. A project picks modules with `engine.use(...)` and only needs to meet their dependencies.

### Where does gameplay code go?

Damage, cooldowns and character decisions go in `onFixed` or a project op, animation and the HUD in `onFrame`, and picture values for the coming draw in `onRender`.

### When should I use the engine, and when plain three.js?

Use the engine first for shared engineering such as time, input, saves and module coordination, and three.js for the picture. When an engine feature does not fit, project code joins through the public interfaces.

### Do I need a particular AI assistant?

No. The tools have command-line and MCP entries, and a person can write and debug a project directly.

### How do I know an AI finished a task?

Run the static checks, run the project's scenarios, then read the state and look at the picture. Keeping key actions and expected results in a scenario lets later changes reuse them.

More questions are in the [FAQ](docs/faq.md).

## Contributing

Reproducible issues, doc fixes and code improvements are welcome. A report should give the engine and three.js versions, the render backend, the smallest steps to reproduce, and the error or a screenshot. Generated API docs are updated from source, not edited by hand.

## License

[MIT](LICENSE). The logo is AI-generated, and the screenshots are rendered by the engine. Asset details are in [ASSETS.md](ASSETS.md).
