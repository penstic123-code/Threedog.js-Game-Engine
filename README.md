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

Threedog is a game engine on plain three.js 0.187 for medium and large web games, made to be driven by AI coding agents. A new game runs on WebGPU with TSL shaders; WebGL stays available. The engine handles what several systems must agree on: time, input, saves, assets, physics, streaming worlds, module lifecycle. It also gives the agent tools to find the right entry, run the game and check the result. It does **not** hide three.js: scenes, meshes, materials, lights and shaders are three.js objects the game writes itself. It has no finished look and no genre: the starting picture is gray, and the art is the game's own.

| | |
|---|---|
| ![First-person view of a shotgun firing at a walker in a walled yard](docs/brand/screens/shooter-yard.jpg) | ![A red car and a blue car on a road through dark pines at dusk](docs/brand/screens/racing-dusk.jpg) |
| ![A fox runs past coins on a paper-cut landscape at sunset](docs/brand/screens/platformer-fox.jpg) | ![A timbered town street at night with lit windows and lamps](docs/brand/screens/open-world-town-night.jpg) |

Each of these was built by an AI agent from a short brief, art included; the records are in [the capability tests](docs/testing/capability/).

## Start a game

You need [Node.js](https://nodejs.org) 20.19+ or 22.12+.

```sh
mkdir my-game
cd my-game
npm init -y
npm install threedog@1 three@~0.187.0
npm install -D @threedog/tools@1
npx threedog init
npm install
npm run dev
```

Open the address the terminal prints. The default start is an empty scene with a camera, saves and a settings menu, and no genre. `init` takes `--open-world` (ground, sky, follow camera, a player) or `--pixel` (a pixel-art start), and `--webgl` for WebGL and GLSL instead of WebGPU and TSL. If npm refuses the folder name (a Chinese name, for example), skip `npm init -y`. The full walkthrough is [recipe 01](packages/engine/docs/recipes/01-new-game.md).

### Or hand it to your agent

Paste this into an empty folder's agent session, then describe the game:

```text
Create a threedog game in this empty folder: npm init -y, npm install threedog@1 three@~0.187.0, npm install -D @threedog/tools@1, npx threedog init, npm install.
Read the new CLAUDE.md first: it lists what the engine already has, and `npx threedog how "<task words>"` finds everything else.
Then loop until the game plays and looks as asked: `npx threedog play` to run it, `npx threedog shot --play` to look at it, fix what the errors and `npx threedog check` point to.
```

The installed packages carry what the agent needs: `node_modules/threedog/docs/AI.md` and the recipes it points to.

## What is in the box

Everything is optional; a game installs what it uses with `engine.use(...)`. Each row names the recipe in [`packages/engine/docs/recipes/`](packages/engine/docs/recipes/) to start from. The full task index is [AI.md](packages/engine/docs/AI.md).

| System | Entry | Recipe |
|---|---|---|
| Fixed-step time, timers, events, seeded random | `engine.onFixed`, `engine.clock`, `engine.random` | 06 |
| Player actions that can refuse | `engine.ops.define` | 23 |
| Saves, autosave, story flags | `engine.saves.define`, `engine.vars` | 20 |
| Preferences and the settings menu (a row per `settings.define`) | `engine.settings` | 26 |
| Content data: items, NPCs, places | `engine.content` | 20 |
| Keys, gamepad, rebinding | `engine.input` | 58 |
| Player, NPCs, who controls whom | `engine.characters`, `engine.control` | 57 |
| Cameras: follow, first person, fixed, RTS, 2D | `engine.cameraRig` | 21 |
| Collision, Rapier physics, vehicles | `engine.collision`, `engine.rigid` | 11 |
| Navmesh and pathfinding | `engine.nav` | 12 |
| Terrain, vegetation, streamed worlds | `engine.terrain`, `engine.vegetation`, `engine.world` | 28, 18 |
| Interaction, dialogue, inventory, quests | `engine.interactions`, `engine.dialogue`, `engine.inventory`, `engine.quests` | 03, 04 |
| Scene flow, pause, cutscenes | `engine.flow`, `engine.timeline` | 07 |
| Many bullets or crowds | `engine.swarm` | 65 |
| Sky, weather, water, day and night | `engine.sky`, `engine.weather`, `engine.water`, `engine.calendar` | 08 |
| Particles, also lit by scene lights (`lit: true`) | `engine.particles` | 64 |
| Light pools, environment light, visible light beams | `engine.lightPool`, `lightShaft` | 09, 34 |
| Post effects, shadows | `engine.post`, `engine.shadows` | 52, 45 |
| Sound, music, ambience by place, reverb | `engine.audio`, `engine.music`, `engine.ambience` | 31 |
| HUD, menus, languages, photo mode | `engine.hud`, `engine.ui`, `engine.i18n`, `engine.photo` | 26 |
| Your own module or a replaced one | `requires`, `provides`, `replaces` | 14 |

Your own picture code goes in plain three.js; [THREE.md](packages/engine/docs/THREE.md) says how it joins the engine and where the limits are. Packages: [`threedog`](packages/engine) (the engine), [`@threedog/tools`](packages/tools) (CLI, MCP server, checks), [`@threedog/post-effects`](packages/post-effects), [`@threedog/terrain-noise`](packages/terrain-noise).

## How the agent stays on track

```sh
npx threedog how "day night cycle"   # which recipe answers a task (English words)
npx threedog check                   # rules, types, content, API misuse: ends "passed" or "failed"
npx threedog play                    # run the game for the tools
npx threedog shot --play             # a screenshot plus picture facts and a few hints
npx threedog test -w my-game         # the game's own tests
```

- **Hand-rolled hints.** `check` notices code that rebuilds an engine system by hand (a `setTimeout` timer, `Math.random`, a `localStorage` save, raw `keydown` listeners, a hand-made inventory) and names the system to use. A deliberate choice can turn a hint off per line or per project.
- **Errors that say the fix.** Engine errors carry a code, a fix and the doc to read; `engine.describe()` and `engine.explain(...)` say what is running and why something did not happen.
- **Scripted play.** `threedog verify <scenario>` presses keys, runs actions and checks the outcome as text, with PASS or FAIL.
- The same entries work over MCP (Claude Code, Cursor and others). Every command is in [COMMANDS.md](packages/engine/docs/COMMANDS.md).

## Status and numbers

- **Version:** 1.1.0 on npm. This repository is ahead of it; the changes not yet released are under "Unreleased" in the [CHANGELOG](packages/engine/CHANGELOG.md).
- **Single tasks:** [85 tasks](docs/testing/capability/) cover the modules and commands, each judged by a script or a stated screenshot.
- **A large city:** a 1.9 km city (about 6,400 buildings) with 14,000 moving cars and people, 200 NPCs and 8 real lights, on one RTX 5060 laptop with WebGPU; numbers and limits in [the acceptance report](docs/testing/field/2026-11-05-city/acceptance.md).
- **Performance:** how to measure and the reference numbers are in [perf.md](docs/testing/perf.md).
- **Tests:** the suites in `packages/engine/tests/` and `packages/tools/tests/` run with `npm test`; [CI](.github/workflows/ci.yml) runs the static checks, a browser group and a build on every push. Which records are public: [docs/testing](docs/testing/README.md).
- **Browsers:** developed and measured in Chrome and Edge on Windows with real GPUs, WebGPU and WebGL. CI runs Chromium on Linux with software rendering. Safari, macOS and phones are not tested yet. Without WebGPU, a game runs on three.js's WebGL2 backend, more slowly.
- **Experimental:** names marked `@experimental` may change; `engine.net` multiplayer is one of them.

Common doubts, including what the engine cannot do: [FAQ](docs/faq.md).

## Contributing

To work on the engine itself, clone this repository: `npm install`, then `npm run new-game -- my-game` and `npm run dev -- my-game`. Read [CLAUDE.md](CLAUDE.md) first (the agent entry for engine work), then [docs/design.md](docs/design.md) (why it is built this way; it wins over other docs) and [docs/architecture.md](docs/architecture.md) (how it is built now). Run `npm run check` after every change. Issues with the engine and three.js versions, the renderer, the smallest steps to reproduce and the error or a screenshot are welcome.

## License

[MIT](LICENSE). The logo is AI-generated and the screenshots are rendered by the engine; asset details are in [ASSETS.md](ASSETS.md).
