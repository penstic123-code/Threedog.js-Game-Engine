---
paths:
  - "**/style/**"
  - "**/picture/**"
  - "packages/engine/render/**"
  - "packages/engine/ui/**"
  - "packages/engine/core/base/I18n.js"
---

# Styles, rendering, UI and i18n

- Hard rule 1 (`CLAUDE.md`) in practice: the engine ships no art: no default look, character model, terrain drawing or generator, and no `style` option (`createEngine({ style })` throws). A game's picture lives in its own `picture/` folder (plain three.js, what `new-game` generates); sounds are the game's (`createEngine({ audio })`). A new picture parameter falls back to neutral gray in the engine; examples that need a value set it in their own `picture/` (e.g. `packages/engine/examples/world/picture/`; its procedural models are art in `examples/world/art/`). Picture plugins in a `plugins/` folder go through `engine.plugins`; never add a second loader.
- Never hard-code player-facing text in the engine: it goes through i18n (`e.t('key')`, strings added with `e.i18n.add`). Developer-facing text (console warnings, errors, `describe` output) is English. R12 checks that strings from `STRINGS` tables are not shown to players directly; don't touch its `SINK_*` patterns.
- Never rename an I18n key. Only developer text may be edited; both the zh-CN and en player-facing tables stay. `check.mjs` finds keys by the `'module.n':` form appearing once in each table; keep that format.
- The default locale follows the player's browser (Chinese browser -> Chinese, otherwise English); a game may set it explicitly with `createEngine({ locale })`.
- Two render backends (WebGL and WebGPU): backend differences are read in `render/backend.js`; the engine's own shader numbers exist once in `render/fxNumbers.js` (GLSL and TSL read it); where a patch's code goes is the one table `render/slots.js`; an effect written for one backend only must fail at start naming itself, never silently draw nothing.
- Shader code goes in as named patches via `applyEffects` (`render/patches.js`); never assign `onBeforeCompile` directly. A patch declares needs / conflicts / shadow / cacheKey (see the header of render/patches.js); post effects are named entries in engine.post slots, never a direct EffectComposer (R26 checks both: an error in engine code and styles, a warning with the reason in game code; it also warns on `material.clone()` without `copyPatches`).
