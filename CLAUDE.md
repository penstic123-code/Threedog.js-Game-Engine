# CLAUDE.md: entry point for agents that maintain the threedog engine

threedog.js is a web 3D game engine on top of three.js 0.187 (plain three.js, no React), built for AI coding agents. This file is for agents that DEVELOP the engine. Agents that use it to make games read `packages/engine/docs/AI.md` (shipped with the package) instead.

## Read in this order (stop when you have enough)
1. `docs/design.md`: why the engine is built this way, and its principles. It wins over every other document.
2. `docs/architecture.md`: how the engine is built now, each part with its files, its one rule, and the test that guards it.
3. `docs/workflow.md`, only when it is present (maintainer copy; the public repository does not ship it): helpers and worktrees, merging, testing, commits, reporting.
4. `HANDOFF.md`, only when it is present (it stays local; the public repository does not ship it): current status and what runs next.
5. `.claude/rules/*.md`: loaded by path when you touch matching files (core and modules, API design, docs and tests, styles and i18n, performance, tools).
6. `docs/plans/`: only the open plans (`done/README.md` lists the finished ones); `docs/testing/`: see its `README.md` for which records are public (the test log `runs.md`, reviews and usability runs stay in the maintainer copy).

## Hard rules (`npm run check` verifies them)
1. **The engine provides mechanisms, never hard-coded art.** Colors, models, sky, lighting, particles and UI colors come from the game (its `picture/` code, names in `assets.js`, or plain three.js); without them the engine shows neutral gray. Engine modules build plain three.js through `render/neutral.js` and hand it out as `engine.<module>.material`.
2. **Core never depends on modules.** `packages/engine/core` must not import `packages/engine/modules` or name one; module dependencies go in `requires` / `provides`, optional ones are used as `engine.xxx?.` and listed in `optional`.
3. **Game content never enters the engine.** Dialogue, quests, items and map layout live in the game's `content/`; no game's name or data appears in the engine.
4. **three.js stays fully writable.** Why and how far: `docs/design.md` sections 2.1 and 4. Every change the engine makes to three.js itself is listed in `core/scene/threePatches.js` (`describe().threePatches`).

## Repository layout
```
packages/engine/         threedog: core/ modules/ render/ ui/ examples/ docs/ tests/ types/ (no art)
packages/terrain-noise/  optional terrain generator @threedog/terrain-noise
packages/tools/          @threedog/tools: CLI `threedog`, paths.mjs, rules/ (R1...), generators, templates/
docs/                    design.md, architecture.md, testing/ (part public); workflow.md, plans/ (maintainer copy only)
games/<game>/            none in this repo (`threedog new-game <name>` creates one)
```

## Commands
`npm run check` after every change (rules, type check, docs; it ends with one line, `✓ check passed` or `✗ check FAILED: <parts>`); `npm test -- "<test name>"` runs tests whose NAME contains the text, any case (a word with no match fails); prints failures + summary only, `-- --verbose` every check; a new `tests/specs/*.mjs` is found automatically; `npm run map` regenerates GAMEMAP / API.md / api/ / CODEMAP (never edit those by hand); `npm run types`; `npm run dev [-- game]`. Full list: `packages/engine/docs/COMMANDS.md`.

## Working rules
- What belongs in the engine: `docs/design.md` section 2.2. One entry per mechanism; customization follows the ladder in `packages/engine/docs/CONVENTIONS.md` "Customization ladder".
- Before writing, list every place the change must reach (callers, games and examples, tests, types, docs, saves). Then take the first option that fully works: not needed at all (say so in one line) -> already in the engine (CODEMAP, `threedog catalog`) -> three.js or the platform -> an installed dependency -> the least new code.
- No abstraction, option or "for later" code nobody asked for. Deleting beats adding: a replaced way, option, test or doc is deleted in the same change, no compat layer.
- Bug fix: grep every caller, find the root cause, fix it once in the layer that owns it.
- New logic with weight gets one test that cannot be bypassed; a known-limit shortcut gets `// shortcut: <limit>, <when to upgrade>`; other comments say why in one line. Never cut save-data safety, option validation at public entries, or what was asked for.
- A new public API adds its AI.md row and recipe section in the same commit (checked by R22); R18 checks names in hand-written docs.
- Verify in this order and say what you ran: `npm run map` (only if you changed a public API, JSDoc or content) -> `npm run check` -> the related tests. Attach before / after numbers for performance changes.
- A design trade-off that changes gameplay or a recorded decision: ask first.
- Reply in the language the user writes in.

<!-- Working rules adapt principles from the ponytail skill (github.com/DietrichGebert/ponytail, MIT). -->
