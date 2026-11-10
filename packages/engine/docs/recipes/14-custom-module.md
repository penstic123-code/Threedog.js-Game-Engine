# Custom module

> **Covers:** a module of your own: template, what it may own, hooks and order, what it must clean up.
> **Use when:** a mechanic with its own state, per-frame logic and saving.
> **Shortest:** `export const stamina = () => ({ name: 'stamina', install(e, ctx) { … } })`.
> **Sections:** 1 Template example stamina · Type what the module · 2 Hooks and order · 3 Extra steps when · 4 Verify

When to write a module: a "mechanic" that has its own state, per-frame logic and saving (stamina, a heat meter, wave spawning, oxygen, a combo
counter). The contracts every module should follow (state, game time, skip, describe, ops) and a second copyable module are in
`49-game-module-contract.md`; this page is the template and the hook cheat sheet. A module is a file of your game (next to `main.js`, or in `plugins/`);
keep art and text out of its code (style values, `i18n`) so it can go to another game through your asset library (`threedog lib add`).

**A whole system to reuse.** A folder `systems/<name>/` with a `system.json` (`{ "summary", "module", "plug", "requires", "entries", "content", "text" }`) carries the module, its content piece, its words and its tests (`tests/*.mjs`, game specs) as one unit: fishing, a day-night shop, wave spawning, tides. `threedog lib add systems/fishing --kind system` refuses colors, art files and text in the code and a `requires` left out of `system.json`, then proves an entry with tests by pulling it into an empty game and running them (`--no-proof` skips that). `threedog lib pull fishing` puts it in `systems/fishing/`, writes its wiring file in `plugins/`, its tests in `tests/specs/` and merges its content into `content/index.js`.

## 1. Template (example: stamina, in the game as `stamina.js`)
```js
// Stamina: running drains it, standing recovers it; at 0 you can't run. engine.stamina.value is 0..max
import { readParams } from 'threedog';

export function stamina(opts = {}) {
  const PARAMS = { max: { type: 'number', default: 100 }, drain: { type: 'number', default: 20 }, regen: { type: 'number', default: 10 } };
  const { max, drain, regen } = readParams('stamina', PARAMS, opts);  // a misspelled option throws in dev with the fix (a release build warns once), a wrong type or a missing required option throws in every build; put PARAMS on the module as params to show it in engine.catalog()
  let e = null, ctx = null, tired = null, shown = -1;
  const api = {
    value: max, max,
    /** Eating restores stamina */
    restore(n) { api.value = Math.min(max, api.value + n); },
  };
  return {
    name: 'stamina', type: 'rules', label: 'Stamina', requires: ['characters'], optional: ['hud'], stage: 'gameplay',  // once installed, engine.stamina === api
    install(engine, c) {
      e = engine; ctx = c;  // what the module adds through ctx leaves with it (uninstall, replaces, a rolled-back use)
      e.i18n.add({ 'zh-CN': { 'stamina.label': '体力' }, en: { 'stamina.label': 'Stamina' } });  // don't hard-code UI text
      e.saves.define('stamina', { save: () => api.value, load: v => { if (typeof v === 'number') api.value = v; } });
      return api;
    },
    fixed(dt) {  // timing and value changes go in fixed (60 Hz, doesn't run while paused)
      const p = e.player; if (!p) return;
      api.value = p.state === 'run' ? Math.max(0, api.value - drain * dt) : Math.min(max, api.value + regen * dt);
      // no stamina: run speed = walk speed. A modifier, not a write to p.runSpeed: the base stays the game's, and haste / mud entries still combine
      if (api.value <= 0 && !tired) tired = ctx.mod('move.runSpeed', { id: 'player', set: p.speed });  // owner: the module
      else if (api.value > 0 && tired) { tired.remove(); tired = null; }
    },
    frame() {  // UI goes in frame; update only when the value changed (hud.bar redraws on every call)
      const v = Math.round(api.value);
      if (v !== shown) { shown = v; e.hud?.bar('stamina', { value: v, max, label: e.t('stamina.label') }); }
    },
    describe() { return { value: Math.round(api.value), max }; },  // this becomes describe().stamina
  };
}
```
Install it: `engine.use(openWorld({ camera: 'follow', ...}), stamina({ max: 80 }))` (dependencies must be installed first). Or put the file in `plugins/` with `export default stamina({ max: 80 })`: plugged with `engine.use` at start, switched off by `plugins.json` `off` (THREE.md, plugins folder).

## Type: what the module may own
`type` is not when it runs (that is `stage`); it says what the module may own. It is optional: a module without one is `'rules'`, game logic. An unknown name throws with the list. Pick by what it changes:

| type | for | dev warns when it |
|---|---|---|
| `'rules'` | game logic: save parts, ops, events; may take input, control or the camera for a while. The usual one for a game module | - |
| `'world'` | game state: save parts, records, ops, ground / collision / navigation data; draws nothing | - |
| `'picture'` | what is seen and heard: picture values, three.js objects, particles, sounds | defines an op, writes world records |
| `'ui'` | panels and menus: declares input actions, runs ops | writes world records, binds keys (`input.bind`; keys are the game's), registers a save part (preferences are not game saves) |
| `'actor'` | characters and their control | - |
| `'net'` | multiplayer: remote characters, the transport | - |
| `'tool'` | a one-shot job that undoes itself (a photo, a bake) | - |

No subtypes: inside a type the differences are declarations (`provides`, `requires`, `ctx.mod` values, material slots, post stage, sounds).
A module that does two kinds of thing is two definitions returned together (`weather()` returns the `weather` state and the `weatherDraw` drawing part;
`engine.use(weather())` installs both). The warning comes once and refuses nothing: it names the module, its type, what it did, why not, and the fix. A game's own module may do what it needs; a split into two modules is usually the fix.

## 2. Hooks and order cheat sheet
- `install(e, ctx)` returns the public object; `init(e, ctx)` (may be async) prepares at start; `ctx.track(handle)` ties a listener or timer to
  the module (next bullet but four); while `isReady(e)` returns false the loading screen waits for it
  (the hook is called isReady; `ready` is always a boolean property in the engine); `afterLoad(e, turn)` (may be async; recipe 20 says what `turn` is for) runs after a save loaded, to rebuild
  what the loaded state needs nearby, with gameplay frozen and ops refused (`'loading'`) until it resolves. It rebuilds by writing state directly, inside
  `e.ops.allow(...)` when the write is guarded, not through `e.ops.run`.
- `fixed(dt, e)` movement, timing, gameplay keys (`input.pressed` read in fixed is this step's snapshot, independent of frame rate); `frame(dt, e)`
  animation, camera, UI (it reads this frame's latest input); `afterRender(dt, e)` after rendering.
- `describe(e, ctx)`: see recipe 49 contract 4; `ctx.near(object or {x,z}, { name, kind })` reports things nearby. `skip(dt, e, done)`: recipe 49 contract 3.
- `applyState(e, p)`: called by `engine.applyState` / URL parameters with the keys `time`, `season`, `weather`, `cutscene`, `play` and `at` (core handles the rest); `stateKeys: ['time']` lists what the module handles, and it refuses with `{ refused: { key: reason } }`.
- `stage`: only when the hooks run (first -> last): `control` timeline, camera -> `ground` terrain, level -> `environment` weather, sky, water -> `gameplay`
  interactions, dialogue -> `effects` particles, objective markers -> `late` (the default) characters, physics -> `audio` music. Within
  a stage, to read another module's result for this frame, write `after: ['its-name']` (or `before`). The name may be a capability, `after: ['ground']`: whichever module provides it
  now, so the order survives a `replaces`. Across stages the stage always wins, so a
  `before` / `after` that contradicts it (a `control` module `after` an `audio` one) makes `engine.use` throw `module-order` naming both modules: give
  them the same stage or drop the line. `engine.use(a, b)` is all-or-nothing: if `b` fails, nothing of `a` stays installed.
- Installed is not running: `engine.has('nav')` says it is installed; after `await engine.loading.settled()`, `engine.explain({ module: 'nav' })` says whether it runs and, if not, why.
- A module with `provides: ['inventory']`, or one another module `requires`, is checked in dev against that capability's contract when it binds: a missing method is one
  `module-contract` warning and a line in `engine.catalog(name).problems`. The module still runs: only the game knows which calls it makes.
- Between modules: notify with `e.events.emit('stamina:empty')` and let others `on` it; use optional dependencies as `e.hud?.` and list them in
  `optional: ['hud']` (for engine modules R16 of `npm run check` verifies this). Never import another module's files directly.
- A module the game cannot run without sets `critical: true`: if its `init` fails, `engine.start()` rejects with the module name and reason (default
  false: a failed init is reported and start goes on). A module installed after start gets no `fixed` / `frame` before its `init` finished:
  `engine.explain({ module })` shows `initializing` / `running` / `failed`, and `await engine.loading.settled()` waits for it. A module whose `isReady` never
  turns true makes `start()` reject after `engine.loading.timeoutMs` (default 120 s), naming it.
- The `type` decides what an error does: in a `picture` or `ui` module (gameplay works without it) an error in a hook only switches that module off
  (`module:disabled`, listed in `describe().disabledModules`); in any other type it freezes the game in development/tests and is recorded in `engine.error`.
- `requires` means the provider works, not only that it is installed: until a required provider runs, the module is `'blocked'` in `engine.explain({ module })` (no init, no hooks) and `engine.catalog(name).blockedBy` says on what. If it can live without the provider, list it in `optional` instead. A `critical` module blocked by a failure stops `start()`.
- Whatever the module registers goes through `ctx`: `ctx.ops.define`, `ctx.saves.define`, `ctx.ui.define`, `ctx.stream.addReadyCheck`, `ctx.budget.metric`, `ctx.things.addSource` / `explainWith`,
  `ctx.ground.provide` / `addColliders`. They take the same arguments as the engine call, and `engine.catalog(name).resources` lists them. They leave with the module, so `engine.unuse` then
  `engine.use` of the same module works; a save part's data stays in the save and goes back to the part when it registers again.
- Listeners and timers the module adds go through `ctx.track(...)`: `ctx.track(e.events.on('item:add', fn))`, also `onFixed` / `onFrame` /
  `clock.after` / `audio.measure` / a `makeWindow` window, anything with `remove()`. They leave with the module: when its `engine.use(...)` batch
  rolls back, when its `init` fails, and on `engine.dispose()` before its `dispose` hook (the spec `threedog test "Lifecycle: every built-in"`
  checks every engine module). A class the module builds takes `ctx` as a constructor argument. DOM listeners use
  `addEventListener(type, fn, { signal: engine.signal })`, and UI elements attach to `engine.uiRoot` (not `document.body`); jobs and stream
  entries are collected by `engine.dispose()`; scene GPU memory is its creator's: `engine.dispose()` does not free the meshes, materials and textures you made, so track their removal: `ctx.track({ remove: () => engine.remove(mesh) })` (`engine.remove` disposes geometry and materials, not their textures: three's `material.dispose()` leaves its maps, so dispose a texture you made when nothing uses it). The `dispose(e)`
  hook frees the rest (Workers, the physics world, WASM objects, real-time timers), in reverse install order.
- Your data in a replaceable provider: `ctx.feeds('collision', () => addMyWalls())` runs before the `use()` of a new holder returns.
- Foundation slots are the ones a running game cannot swap: `world` alone, because it owns every record. Choose your own holder before `start()`; every other slot takes `replaces` at any time.
- A module's changes to shared values go through `ctx.mod(point, { mul: 0.8, layer: 'effect' })` (= `ctx.track(e.mod(point, { owner: ctx.name, ... }))`),
  so they leave with it too. A module that must be the only one of its kind declares `provides: ['inventory']`; others `requires: ['inventory']`
  (a capability, never a module name), and a game swaps it with `engine.use(mine(), { replaces: 'inventory' })` (`55-mods-time-wrap.md`). `engine.unuse('name')` removes a module with nothing in its place, and refuses while another still requires it. Picture slots: `62-picture-code.md` 3e:
  `engine.inventory` is then the new module's API, so the dependents keep working. A missing capability throws naming both fixes: install the
  engine's part of that name first, or your own module with `provides`.
- `engine.phase` says where the engine is: `'constructed'` -> `'starting'` (modules init) -> `'loading'` (assets and the world; in both frame hooks run, fixed steps do not, so no game
  time passes while the machine loads) -> `'ready'` (the world is built; fixed steps from here) -> `'running'` (start() resolved) ->
  `'disposed'`. `engine.ready` is true in the last two live ones; `engine.step()` while loading runs frame hooks only.
- While frozen (`engine.freeze`, flow pause) `fixed` is skipped entirely and `frame` still runs: check `e.frozen` before gameplay decisions.
- Changing what a saved part looks like: `version` + `migrate` (recipe 49 contract 1). A save written by a newer build is refused (load returns false).
- Saved state the module writes joins the ops guard (experimental): `e.ops.guard('stamina.set')` in each writing method (a no-op in production builds,
  no DEV check needed), `e.ops.allow(fn)` around writes that are allowed anyway (recipe 23 section 5).
- **Per-playthrough state** is a save part: whatever changes during play and matters for what happens next (a zone's `once` / cooldown, a
  transition's progress, a hand-picked music track, a check timer, markers an effect placed) goes in `e.saves.define(...)`. The engine calls it
  on all three paths: save, load, and new game (a new game loads the state captured when `start()` finished), so there is nothing to reset by
  hand. What cannot be saved ends with its playthrough: a background result goes through `ctx.commits` (a load or new game drops old ones;
  keep `ctx.commits.epoch` on a queued request and drop it when that changed), and an effect of a running playthrough (an open dialogue, a
  running cutscene, the music playing) stops on `ctx.track(e.events.on('session:end', ...))`. What is derived from save parts is rebuilt on
  `'session:start'` and `'save:loaded'`, and what a rollback took down on `'session:failed'`. A `'session:end'` listener only stops things: it starts nothing for the next state. A module's `describe()` should show such state: the session spec (`threedog test "session fresh page"`) compares `describe()` after a new game with a fresh page, and the Lifecycle spec round-trips the engine's own.
- When you only need a per-frame callback and no module structure: `const h = engine.onFrame(dt => ...)` / `engine.onFixed`, and `h.remove()` cancels it.

## 3. Extra steps when it goes into the engine
- Declare a `type`: rule R47 requires it of engine modules, and a `world` module's file draws nothing.
- Write the declarations and JSDoc in `index.d.ts` (or `types/*.d.ts`) of the engine package; `npm run types` checks that the exports of index.js are declared.
- Hand out a picture as `.material`, `.uniforms`, `.patches` (see `09-materials-lights-models.md` §3), put text in i18n, then `npm run map` to generate API.md + `api/` / CODEMAP.md.

## 4. Verify
- `npm run check` (hard rules + types + generated docs up to date).
- In a test: watch `stamina.value` in the describe returned by `engine.step(2)`; `engine.saves.collect().parts.stamina` shows the save content.
- Add an automated test: write one entry like those in `tests/specs/*.mjs` and run only it with `threedog test name`.
