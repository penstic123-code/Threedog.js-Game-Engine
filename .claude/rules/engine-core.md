---
paths:
  - "packages/engine/core/**"
  - "packages/engine/modules/**"
---

# Engine core and modules

Where each part lives and the test that guards it: `docs/architecture.md`.

- Hard rule 2 in detail: module-to-module dependencies go in `requires` (a capability name from `provides`, not a module name, when one exists); an optional dependency is used as `engine.xxx?.` and listed in `optional`, and must not throw when missing.
- **One source for "can walk there"**: `engine.movement` (set with `createEngine({ movement })`); every module that needs walkability reads it, and none writes its own 0.4 / 0.45. Who owns a character's position: `packages/engine/docs/CONVENTIONS.md` "Core conventions".
- Units are meters, Y is up, north is -Z. Characters and vehicles face the model's +Z; `facing` 0 = +Z, forward = (sin f, cos f).
- No `requestAnimationFrame` or `renderer.render` of your own. **Game logic uses fixed seconds or channel seconds** (the hook's `dt`, `engine.time.now(...)`, `engine.clock` timers; table in `recipes/06-clock-events.md`). `core/time/time.js` is the only file that adds to any time; `engine.elapsed` is gone, never `setTimeout` / `setInterval` / `performance.now()`: they ignore pause, freeze and `engine.step`, and can be neither tested nor saved.
  Real time or `Math.random` that the engine cannot avoid gets a purpose tag at the end of the line: `// presentation` `// measure` `// wall-clock` `// main-loop` `// debug`. R4 lets only tagged lines through; `// measure` is not accepted inside the fixed step (gameplay limits count items/steps, never milliseconds).
- State that must be saved: `engine.saves.define(key, { save, load })` (`load` may return a Promise); `saves.save / load` always return `Promise<boolean>` (callers `await`). Saved data names things by stable ids, never positions; a shape change raises `version` with a `migrate` step (recipe 20 "Save format").
- Values the engine writes each frame (sun, hemisphere, fog, camera pose...) are registered with `defineOwned` (`core/ops/owned.js`): a direct three.js write makes the engine yield and warn once. Every value several systems write is a shared point (`core/ops/sharedPoint.js`): change it with `engine.mod` (the rule: "Shared values" in `api-design.md`; time channels are `time.<channel>`); the camera is taken with `engine.takeCamera(owner)` (see `packages/engine/docs/CONVENTIONS.md`).
- Who decides where a character goes: `engine.control` (one holder per character, layers base < script < cutscene < net); never call `character.move()` for a held character. Key bindings are the game's: a module declares actions (`ctx.input.define(name, { context })`) and never names a key; menus and dialogue push an input context instead of locking input.
- Time of day, day and season belong to the `calendar` module (`calendar.timeOfDay / isDay / daylight`, 0-1 for fades); sky only reads it to draw. Never judge by wall-clock time, and never keep a second day counter.
- `terrainGen.js` must not import three.js (it runs in a Worker); vegetation `rule` must not contain functions (it is sent to a Worker). Split a file by responsibility when it passes about 400 lines (R1).

## Writing a module
Template and steps: `packages/engine/docs/recipes/14-custom-module.md`.
- A module is a function returning `{ name, type, label, requires, optional, provides, stage, install, fixed, frame, describe, ... }`; `type` is one of `world | picture | actor | rules | ui | net | tool` and is required and is the one source for what the module may own and how its errors are handled (picture / ui fail soft: `core/engine/moduleTypes.js`, `core/base/errors.js`); `engine.use` installs it and the object returned by `install` becomes `engine.<name>`. Validate options with `readParams('name', PARAMS, opts)` (unknown key throws in dev; `checkOptions` only for extensible data such as item fields); UI text goes through i18n (`e.i18n.add` + `e.t('key')`).
- Movement, timing and gameplay keys go in `fixed` (`input.pressed / down / released / axis` read this step's snapshot, independent of frame rate); animation, UI and camera go in `frame` (it keeps running while frozen, so check `e.frozen` before gameplay decisions). Gameplay timing never reads an Animator's mixer or `anim:end`. Saving: `e.saves.define(key, { save, load })`; modules talk through `engine.events`.
- A module's listeners / timers go through `ctx.track(handle)` (install(e, ctx) / init(e, ctx); the members of `ctx` are in `docs/architecture.md` section 4, and what they register leaves with the module too): removed on use() rollback, failed init and dispose; the Lifecycle spec checks every module. Jobs, stream entries and sources, ray registrations and scene GPU memory are collected by `engine.dispose()`; DOM listeners use `{ signal: engine.signal }`, UI elements attach to `engine.uiRoot`.
- A new public API is exported from `packages/engine/index.js` and gets JSDoc with an example in `index.d.ts` / `types/*.d.ts` (`npm run types` finds gaps). The source JSDoc is the truth; the migration registry is `MIGRATED_JS_REL` in `packages/tools/paths.mjs`.
- Hook order (one fixed step, one frame, stages, frozen): `docs/architecture.md` section 5. Read the real order from `engine.moduleOrder`; stages per module are in CODEMAP.
- Per-playthrough state: `docs/architecture.md` section 4 "Playthroughs" and recipe 14 "Per-playthrough state"; background results go through commits.
- Other module hooks: `afterRender(dt, e)`; `afterLoad(e)`: after a save loaded, gameplay stays frozen until its Promise resolves; `skip(dt, e, done)`: called per segment by `engine.skip`, `done` on the last segment, needed only by modules that keep their own time.
- Gameplay state (world, containers, vars, quests) changes only in fixed steps or inside ops (`engine.ops`); dev warns otherwise (`npm test` prints the first place and lists all in `<game>/.threedog/ops-guard.log`). Engine-built player actions are ops (`interaction.use`, `dialogue.advance/choose`, `inventory.transfer`).
