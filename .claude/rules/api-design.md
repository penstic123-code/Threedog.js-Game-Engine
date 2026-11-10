---
paths:
  - "packages/engine/**/*.js"
  - "packages/engine/**/*.d.ts"
  - "packages/engine/types/**"
---

# API design

New public APIs follow these conventions. The "one thing, one entry point" table (what to use for raycasts, tweens, deleting objects, pathfinding, timers...) is in `packages/engine/docs/AI.md`; its principle: before adding a new way to do something, check that table and extend the existing entry point instead of building another.

## Interface conventions
- **A position is one argument**, always in the same slot with the same forms in every API: the rule, the `position` options key and the ground-sampling exceptions are in `packages/engine/docs/CONVENTIONS.md` "Interface conventions" (AI.md has the one-line form).
- Cancel convention: registering a listener, timer, continuing effect or registration returns a handle, and `h.remove()` undoes it (safe to call repeatedly); never return a bare function.
  Which APIs are registrations (the full list), and what `remove()` deletes: `packages/engine/docs/CONVENTIONS.md` "Registrations return a handle". APIs that add an object or change business data (`engine.add`, `inventory.add`, `world.add`...) return what their own declaration says (the added object, a result, a record), not a handle.
- **Readiness**: a boolean property `ready` and a hook `isReady(e)`, as in `packages/engine/docs/CONVENTIONS.md`.
- **Event names are `noun:action`** (naming rule in `packages/engine/docs/CONVENTIONS.md`). Engine/module events: add them to `EventMap` in `types/core.d.ts` first. Game events: declare them in `games/<game>/events.d.ts` as `interface GameEvents { 'name:verb': [args] }` (global, merged into EventMap); never edit the engine for a game event.
- **Time**: one source, `engine.time.tick`; every other time is a read-only view, `engine.time.now(name)` (`'real'`, a channel name, `'calendar'`). Which to use for what, and the effect of pause / freeze / `clock.rate`: only in the table in `recipes/06-clock-events.md`; don't restate it. Always name the unit, never plain "game time".
- **Input**: gameplay keys are read in the fixed step (`onFixed` / module `fixed`, a per-step snapshot); UI keys in `onFrame` / module `frame`. Write JSDoc examples that way. A module declares actions and never names a key; JSDoc examples bind them with `bindings` / `input.bind`.
- **Module names**: `collision()` installs as `engine.collision` (lightweight collision: walking, camera); `rigid()` installs as `engine.rigid` (real physics with Rapier).
- **Shared values**: a value several owners write is changed with `engine.mod(point, { owner, set | add | mul | clamp, layer })` (layers and order: `docs/architecture.md` section 6); never a new setter, a saved old value to restore, or an exclusive option.
- **Presets**: what `openWorld()` installs is in `packages/engine/docs/CONVENTIONS.md`; a new gameplay module stays out of it and the game adds it with `engine.use`.
- **Errors say how to fix it**: passing an old form (a numeric position, etc.) throws and explains the fix (what is wrong + how to fix).
