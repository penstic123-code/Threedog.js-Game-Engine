# Shared values, exclusive slots, time channels and wrapping module methods

> **Covers:** shared values (`engine.mod`), exclusive slots, time channels, wrapping and replacing modules.
> **Use when:** several systems change one value, or a module needs replacing.
> **Shortest:** `engine.mod('move.speed', { owner, mul: 0.5 })`.
> **Sections:** The rules in full · Picture points follow the · Time channels · Fixed-step order onFixed fn · Wrapping a module method · Replacing a module · Who holds what

A shared value is something several owners change: the game, a module, an effect. Name it, say who you are, say how you change it:

```js
engine.time.channel('enemies');  // a channel of your own exists once you name it (world, player and calendar are built in)
const slow = engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });  // bullet time; slow.remove() ends it early
engine.mod('time.world', { owner: 'hitstop', set: 0, layer: 'system', for: 0.06 });  // decide on a higher layer: hides everything below

const storm = () => ({ name: 'storm', type: 'rules', install(e, ctx) {
  ctx.mod('time.world', { mul: 0.8, layer: 'effect' });  // inside a module: owned by it, gone when the module goes
} });

const myBag = () => ({ name: 'myBag', type: 'rules', provides: ['inventory'], install(e) { /* ... */ } });  // only one may hold 'inventory'
engine.use(myBag(), { replaces: 'inventory' });  // swap the engine's part: the old one leaves with all its changes
const shop = () => ({ name: 'shop', type: 'rules', requires: ['inventory'] }); // depend on the slot, not on a module name

engine.describe().shared['time.world'];  // { value: 0.8, writer: 'default', how: 'default 1 × storm 0.8', also: [{ owner: 'storm', ... }] }
```

What to remember:
- **Layers combine by themselves.** The game sets a base value, effects (weather, sunset, bullet time) multiply on top, the player's settings cap
  it. You never pick a layer by hand unless you want to: game code and game modules write `'game'` (the default); effects pass `layer: 'effect'`.
- **`mul` / `add` to cooperate, `set` to decide.** Any number of owners can multiply and add. Two owners `set` the same value on the same layer is
  an error (in development and release alike) that names both lines and gives three copyable fixes; copy one. The earlier value stays.
- **`replaces` to swap an engine part** that `provides` a slot; a second provider without it is the error `shared-taken`. What the old part issued goes with it: read `engine.<slot>` where you use it, and keep the issuer beside any handle so you can compare (`if (from !== engine.rigid) { from = engine.rigid; crate = from.addBox(mesh); }`). Version numbers count per module, so they cannot tell two modules apart. The engine's own props, NPCs, pickups, cars and movers do this; a rider leaves a rigid car when rigid goes. `world` is the exception: it owns every record, so install your world before the modules that need it. Once they are installed, or after `start()`, `replaces: 'world'` and `unuse('world')` are refused (`module-replaces`, `module-unuse`) and nothing changes. A factory that gives two modules goes in whole: `engine.use(terrain(o), { replaces: 'terrain' })` swaps its drawing part too. A module of your own wraps `world.present`, `world.simulate`, `rays.addProvider`, `input.touchButton` and `assets.onSwap` in `ctx.track(...)`, so they leave with it.
- Every handle ends with `h.remove()` (`engine.mod`, `ctx.mod`, `input.gate`, `wrap`, `freeze`, `takeCamera`); it drops only your own entry.

Only things several parties commonly write are shared values: time speeds and the calendar rate, pause / freeze / camera holders, move stats,
input gates; shadow on / quality and post parameters are on them too. Your own objects,
materials and textures are plain three.js: never registered, never a conflict. Which tool to reach for: `../CONVENTIONS.md` "Customization ladder".

```js
engine.mod('time.player', { owner: 'haste', mul: 1.2, for: 5 });  // haste on the player
const menu = engine.freeze('pause-menu');  /* ... */  menu.remove();  // pause menu: the picture, UI and ambient uTime (wind, water, clouds) keep running; { still: true } stops those too
engine.input.gate('jump', { owner: 'stun', for: 1.5 });  // no jumping while stunned
engine.wrap(engine.inventory, 'add', (next, id, n = 1, o) =>  // a weight rule on top of the engine's inventory
  carried() + weightOf(id) * n > 30 ? { ok: false, code: 'tooHeavy' } : next(id, n, o), { owner: 'weight' });
```

## The rules in full: `engine.mod(point, { owner, set | add | mul | clamp, layer?, for?, id? })`

| Layer (low to high) | Who writes it |
|---|---|
| `engine` | the engine's own defaults and drivers |
| `game` (default) | game code, game modules |
| `effect` | temporary effects: weather, sunset fade, bullet time, haste |
| `system` | cutscenes, menus, photo tools (also "lock this number": a `set` here hides every layer below) |
| `settings` | the player's settings menu: only `clamp` / `mul` (a value point: `set: false`), so it can turn things down or off, never on. Above `system`, so the restriction holds in a cutscene too |
| `debug` | debug overrides and panels |

- Inside a layer: `set`, then every `add`, then every `mul`, then every `clamp` (`{ min, max }`); the result is clamped to the point's own min / max.
- One entry per owner; the same owner writing again replaces its own entry (never a conflict). Only the owner ends it: `remove()`, or `for` seconds.
- Nothing remembers an old value: every read recomputes from the base and the entries still there, so effects end in any order without fighting.
- Development builds print one console line when a value the game `set` is shown as another number because effects changed it ("'game' set
  sun 3, shown 1.8 = game 3 × weather 0.6 ... to lock the number: ..."). That is the rule working, not a bug.
- `describe().shared` has one row per point with entries: `value`, `writer` (whose value the rest acts on; `'default'` when nobody set it),
  `layer`, `at` (the code line, development builds), `how` (`'cave 180 × storm 0.6'`), `also` (everyone else; `hidden: true` when a set above hides
  theirs). `engine.stacks.of('storm')` lists everything one owner changes. Per-record points read `'move.speed[player]'`.
- A point holds a value and writes no three.js by itself: whoever reads it writes three.js. A value the engine writes on its own shows in
  `describe().owned`, and a direct three.js write takes it (the row says `writer: 'three (engine yielded)'`).
- Base values are yours: `player.speed = 6` is always fine; modifiers go through `engine.mod('move.speed', { owner, id: 'player', mul })`.
- Your own point: `engine.stacks.define('damageTaken', { per: true, min: 0 })`, then `engine.stacks.get('damageTaken').value(enemyId)`;
  `kind: 'value'` holds a color, a string or a flag (set only), `kind: 'one'` is an exclusive slot (what `provides` makes).
- "What is being changed right now": `engine.describeText()` has one line `Values being changed now: move.speed[player] 6 → 4.2 (default 6 × haste 1.4 × mud 0.5), …`,
  read from `engine.stacks.changed()` (the dev panel shows the same list): the points off their base or capped by a setting, furthest first, at most five.
  `engine.stacks.define(name, { important: true })` keeps a point on that line even at its base and before the cap, for the few values a reader must always see.
- Saved: `engine` to `effect` entries. Not saved: `settings` (the settings module re-applies the player's choices), `system`, `debug`.

## Picture points follow the same rule
`shadows.enabled`, `post.<name>.enabled`, `sky.tint`, `sky.flash` and `ground.cover` are shared points like the rest.
`sky.tint`, `ground.cover` (blend by amount) and `sky.flash` (adds) are written with `engine.mod`.
```js
const hold = engine.mod('shadows.enabled', { owner: 'cutscene', layer: 'system', set: false });  // decides over the game
engine.describe().shared['shadows.enabled'];  // who decided and who is hidden
hold.remove();  // the handle ends yours
```
- The exact number whatever else is stacked: set on `{ layer: 'system' }` (the player's settings can still lower it), or write the three.js value.
- The settings menu only restricts (`shadows` off is `shadows.enabled` set false on the settings layer), so neither a game's nor a cutscene's `enabled: true`
  switches them back on, and a cutscene's `false` is not undone by the menu.
- A direct three.js write (`engine.lights.hemi.intensity = 0.2`) still works, and describe tags it `three`.

## Time channels

- `engine.onFixed(dt => moveEnemies(dt), { channel: 'enemies' })`: dt is that channel's scaled dt. Without `channel` dt is real (1/60): cooldowns
  and UI timers are not slowed by bullet time by accident.
- `engine.characters.addPlayer` drives the player on channel `'player'`; `new Character(engine, { channel })` picks one for other characters.
- `engine.world.simulate('slime', { near, far, channel: 'enemies' })`: near and far dt follow the channel too (NPCs: their own channel).
- `engine.clock.rate` is the calendar speed (fast-forward a day), separate from the channels.
- One time source: `engine.time.tick` is the only counter; `engine.time.now('real' | 'ambient' | 'calendar' | channel)` are read-only views of it
  (recipe 06 "The time table"). Passing time is `engine.skip({ seconds })`: every view moves as if stepped, timers fire in order, far NPCs and
  the calendar catch up. Writing `engine.clock.now` throws (it is a view).
- Timers: `engine.clock.after(s, fnOrEvent, { data, channel })` / `clock.every(s, fn, { channel })` on any view (default `'calendar'`; `'real'`
  ignores bullet time; `'enemies'` slows with it). One queue: `remove()` takes effect at once, even later in the same step.

## Fixed-step order: `onFixed(fn, { phase })`

`'early'` (default) runs before every module (the player has not moved yet this step); `'late'` runs after all modules and before the clock (hit
checks that need this step's player position). The order never depends on which line registered first.

## Wrapping a module method: `engine.wrap(target, method, (next, ...args) => ...)`

- Before: do something, then `return next(...args)`. After: `const r = next(...args); ...; return r`. Around: change the args, or skip `next`.
- Several wrappers compose: the last one wrapped runs first. `handle.remove()` takes one out; the method is restored when the last goes.
- Every caller of that method goes through it (the game, the module's own ops, other modules). It wraps one method: a rule for every way items
  enter the bag wraps `add` and `transfer`.
- Meant for public methods (the module's `contract.js` `api` list); a `_private` name warns once in dev and still works. `describe().wraps` lists `{ 'inventory.add': [owners] }`.

## Replacing a module

Two modules that each want to be "the" one (a sky, a tone-mapping stage, an inventory) declare an exclusive slot: `provides: ['inventory']`.
Other modules `requires: ['inventory']` and work with whichever holds it. `engine.use(myInventory(), { replaces: 'inventory' })` unloads the
holder (its tracked handles, its `ctx.mod` entries, its `dispose`) before the new install, and puts it back if that fails, with its save data and content sections. Either way the holder is a fresh install, so `module:restored` fires with the fresh modules once their `init` is done: content sections load again, as a `content.load` on a running game would (a newcomer with its own format may refuse a pack written for the old holder: that part stays out, with a warning naming the pack), and what game code defined on the old holder by hand it defines again on that event. Level walls and solid props need no event: they go into whichever `collision` or `collider3d` is installed, also one that came late or came back.

Most replaceable modules have a contract (`modules/gameplay/*.contract.js`, `modules/*/contract.js`; object contract `modules/characters/vehicle.contract.js`; the rest and what cannot be replaced: CONVENTIONS.md "What can be replaced"): the api, fields, ops, events
and save keys other code relies on, and nothing more (the engine's callers use only that surface). `await runContract(contract, () => myInventory(), { check })`
from `@threedog/tools/contract` checks a replacement (in a game installed from npm too); `tests/contract/` in the engine's repository (not shipped) holds small
whole replacements such as `fakeInventory.js`.
A camera module's `prepare` hook: `await runContract(contract, () => myCamera(), { check, prepare: e => { e.camera = ... } })` adds what it needs to the
small engine. A vehicle is checked as an object: `runContract(vehicleContract, () => myBoat, { check })`.

## Who holds what

Holders: `describe().holds` (recipe 16, Notes). Every other shared value and slot: `describe().shared`.
