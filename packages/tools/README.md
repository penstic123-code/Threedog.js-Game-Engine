# @threedog/tools

The command line and build tooling for [threedog](https://www.npmjs.com/package/threedog) games: the `threedog` CLI, a vite preset, the test runner, rule checks, doc generators, headless screenshots and an MCP server for AI assistants.

This README describes 1.0 (older releases do not match it). Inside the [repository](https://github.com/penstic123-code/Threedog.js-Game-Engine): `npm install`, then `npm run new-game -- my-game`. A game in its own folder:

```sh
npm install threedog@1 three@~0.187.0
npm install -D @threedog/tools@1
npx playwright install chromium        # once per machine, for shot / play / test
npx threedog init                      # sets up the current folder and its CLAUDE.md, never overwrites a file
npm install
```

The `threedog` command itself comes with the `threedog` package and runs this package's commands (so `npx threedog` works with only the engine installed, and then says to install this package).

Node 20.19+ or 22.12+ (what vite 8 needs); the commands that start vite say so when the Node is older.

Common commands (run in the game folder; the full list is `node_modules/threedog/docs/COMMANDS.md`):

| Command | What it does |
|---|---|
| `threedog dev` / `build` / `preview` | vite with the threedog preset |
| `threedog check` | rule checks, content validation, types, generated docs up to date |
| `threedog test [name]` | the game's tests (headless browser) |
| `threedog shot` | a headless screenshot plus the game state and picture numbers |
| `threedog map` | regenerate GAMEMAP.md |
| `threedog examples list` / `pull <name>` | copy a technique example into the game |

In-browser editor: on the dev server press F2 (or add `?edit=1`), click a content entry, then move or turn it with its handles, edit its fields, add, delete and undo; each change is written into its content file by the same targeted edit as `threedog content set`, refused when the file changed since the click. A game needs no code for it and a build has none of it.

vite preset: `import { gameConfig } from '@threedog/tools/vite'; export default gameConfig(import.meta.dirname);`

Peer dependencies: `threedog`; optional `tweakpane` (dev panel) and `@gltf-transform/cli` (asset optimisation). MIT license.
