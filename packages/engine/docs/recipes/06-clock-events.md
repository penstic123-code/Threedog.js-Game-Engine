# Scheduling events on the game clock

> **Covers:** timers on game time, the time table, smooth movement between steps, skipping time.
> **Use when:** something happens later, repeatedly, or at an hour of the day.
> **Shortest:** `engine.clock.after(seconds, fn)`.
> **Sections:** Changing how fast time · The time table the · 1 Where to write · 1b Smooth movement between · 2 Skipping time sleep · 3 Verify

## Changing how fast time runs: `engine.mod`
```js
engine.time.channel('enemies');  // once: a channel of your own (world and player are built in)
const bt = engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });  // bullet time: enemies at 35% for 2 real seconds
engine.mod('time.player', { owner: 'haste', mul: 1.2, for: 5 });  // haste on the player
engine.mod('freeze', { owner: 'pause-menu' });  // pause menu (= engine.freeze('pause-menu'))
engine.onFixed(dt => moveEnemies(dt), { channel: 'enemies' });  // this dt is already scaled; plain onFixed dt stays 1/60
```
`engine.mod(target, { owner, mul | add | set | clamp, for, clock })` is the one entry for every quantity several systems share (time channels,
`'clock.rate'`, `'freeze'`, your own from `engine.stacks.define(name, { base })`). It returns `{ remove() }`; `remove()` ends only this owner's entry.
Details, only when you need them:
- One entry per owner: the same owner modding again updates its entry. Ending one recomputes from the base and the entries left, so effects can end
  in any order (bullet time ending under a stopwatch never "restores" a stale value).
- Combine order and conflicts: `55-mods-time-wrap.md` (one layer table for every shared value; a stopwatch `set: 0, layer: 'effect'` beats any
  slow-down; two owners `set` on one layer is an error in development).
- `for: seconds` ends it by itself, counted on `clock`: `'real'` (default; real seconds, which stop while frozen, so a pause menu does not use up a
  bullet time) or a channel name (`clock: 'enemies'`: a slow that lasts 3 enemy seconds lasts longer in bullet time). Each end emits `mod:end`
  `{ target, owner, id }`. Saved with the time left; `engine.skip` ends them at the right point of the jump.
- One record only: `engine.mod('time.local', { owner: 'stopwatch', id: 'slime_3', set: 0, layer: 'effect' })` (its speed = channel x local).
  `world.remove(id)` drops that record's entries.
- Reading: `engine.time.scale('enemies', id?)`, `engine.time.now('enemies')`, `engine.clock.rate`; `describe().time.channels` lists speeds and
  holders. Saved: entries below `'system'`; `system` / `debug` ones (menus, debug panel) are screen state and are taken again after a load.
- Freeze is not speed 0: a frozen engine runs no fixed step, so no channel moves, no `for` runs down and input is not read.
- Plain JS keeps working: your own fields and `onFixed(dt => ...)` logic need none of this. Use `engine.mod` for quantities more than one system writes.
- Order inside a fixed step: `onFixed(fn)` runs before the modules (player not moved yet), `onFixed(fn, { phase: 'late' })` after them. Stacks, `input.gate` and `engine.wrap` together: recipe 55.

## The time table (the single source; other docs link here)
**One time source.** `engine.time` counts one thing, `engine.time.tick` (fixed steps run). Every other time is a
read-only view of it, moved only by the engine, and always together: a fixed step, `engine.skip` and a new playthrough move or reset all of them.
Read any view with `engine.time.now(name)`: `'real'`, `'ambient'`, `'calendar'` or a channel (`'world'`, `'player'`, your own).
`'ambient'` (= `engine.uniforms.uTime`: wind, water, clouds) is the one view that keeps moving while gameplay is frozen, unless the freeze is a full still (`{ still: true }`, which also stops skeletal animation and particles; `engine.still` says so, for your own frame code).

Three rulers, always named: **real seconds** (`engine.time.now('real')` = tick / 60; the `dt` of a plain `onFixed` / module `fixed` / `world.simulate`, the N of
`engine.step(N)`; never scaled), **channel seconds** (`engine.time.now(ch)`, the `dt` of
`onFixed(fn, { channel })`: real seconds x the channel's speed) and **calendar seconds** (`engine.clock.now` = world-channel seconds x
`engine.clock.rate`). "Game time" is not a unit: always say one of them. **Time of day** (`engine.calendar.timeOfDay`, 0-1, the `calendar()` module) is derived
from calendar seconds: one day = `calendar.dayLength` calendar seconds. **Frame seconds** (the `dt` of `onFrame` / module `frame`) are for presentation only.

| Use it for | Time to use | Paused / frozen | `clock.rate` 2 (one real second at 60 Hz) |
|---|---|---|---|
| Movement, camera follow, AI steering | real seconds, or channel seconds for things bullet time should slow (`onFixed(fn, { channel })`) | stops | unchanged: speed in m/s stays the same |
| Physics (Rapier) | the `world` channel, so `engine.mod('time.world', ...)` slows bodies and speed 0 holds them; a mod on another channel leaves them alone | stops | unchanged |
| Action judgement and action timelines (hit windows, invulnerability, "finish the swing"), cooldowns, hit-stop | a `mod` with `for` (hit-stop: `engine.mod('time.world', { owner: 'hitstop', set: 0, layer: 'system', for: 0.06 })`), or accumulate `dt` in `onFixed` | stops | unchanged: a 0.6 s swing is still 0.6 s |
| `world.simulate` near / far, dialogue typing, cutscenes, `engine.step(N)` | real seconds | stops | unchanged |
| Poison ticks, status effects, projectiles that bullet time should slow | channel seconds (`clock.after(s, 'ev', { data, channel })`, `for` + `clock: '<channel>'`) | stops | unchanged |
| Crop / template stage growth, vegetation and pickup respawn, "ripe after 10 minutes" | calendar seconds (`clock.now`, `clock.after / every`; saved) | stops | twice as fast: growth that needs 600 calendar seconds is ripe after 300 real seconds |
| Calendar, day, season, clock hours, lamps and shop doors (`calendar.at / between / daily / onSeason`) | time of day (`engine.calendar`, derived from calendar seconds) | stops | twice as fast: with `dayLength = 360` one hour (15 calendar seconds) passes in 7.5 real seconds |
| UI animation and effects that follow the game (bobbing, sway) | `engine.time.now('real')` | stops | unchanged |
| Shader motion that should not stop behind a pause menu (wind, water) | `engine.time.now('ambient')` / `uniforms.uTime` | keeps running (unless `freeze(owner, { still: true })`) | unchanged |
| Menu / HUD animation that must keep running while paused | frame seconds (`onFrame` `dt`) | keeps running | unchanged |
| Toast and loading fade-out, music volume fades | wall-clock time (they never affect gameplay) | keeps running | unchanged |
| `saves.autosave(minutes)` | real seconds of play (only while a playthrough runs: not on the title screen, not during newGame / load) | stops | unchanged |

Rules that follow: gameplay timing is in real or channel seconds unless it is a thing the world does by itself over days (growth, respawn, calendar),
which is in calendar seconds. With `engine.mod('clock.rate', { owner: 'game', set: 0 })` calendar seconds stop (no `clock.after` fires, crops stop),
but movement and cooldowns still run; a game that freezes the time of day that way must not use `clock.after` for gameplay delays (use a channel
timer or a `for`). Conversion: 1 hour = `dayLength / hoursPerDay` calendar seconds, 1 minute = `dayLength / (hoursPerDay x 60)` (24-hour day,
`dayLength = 360`, as in `presets.calendar.cycle`: 1 hour = 15 calendar seconds). With `clock.rate` 10, `step(10)` advances 100 calendar
seconds = 6.7 hours. The docs say "calendar seconds" and "N clock hours/minutes", never "game minutes".
Tick, real and ambient seconds are not saved (a new game or a session load starts them at 0, like a fresh page); channels and the calendar are; to keep a cooldown across a save, use a `mod` with `for` (saved with its time left) or store it in a
world record. Don't use `setTimeout` / `setInterval` / `performance.now()` (they ignore pause, are not saved, and can't be tested with fast-forward).
The engine itself runs on the fixed step except the wall-clock items in the table.
"After how long / every how long" uses `engine.clock` (part of the core; one timer queue for every view: `{ channel: 'real' | '<channel>' }`, default calendar seconds); "at what time every day / within a time window / when the season changes"
uses `engine.calendar` (the `calendar()` module with a `dayLength`; at a fixed time of day these never fire).

**The calendar is gameplay, the sky is a picture.** `calendar()` owns the time of day, the day, seasons, the timers below and their save; NPC schedules,
content `clock` conditions, audio rules `{ time }` / `{ daylight }`, `engine.skip({ to })` and the debug panel read it. `sky()` only reads it to draw
the sun, moon, colors and season tint. So each kind of game installs what it needs:
- an outdoor day-night game: `calendar(presets.calendar.cycle), sky()` (`openWorld()` installs both; its `calendar` / `time` / `dayLength` go to the calendar);
- an indoor shop, office or dungeon with opening hours and NPC shifts: `calendar({ dayLength: 600, hoursPerDay: 24 })` and no sky at all;
- a management sim on a painted backdrop or a game with its own sky dome: `calendar()` and the game's own drawing reading `engine.calendar.timeOfDay`
  (or `engine.uniforms.uTimeOfDay`, which the calendar writes even with no sky);
- a survival game with a short brutal day and long seasons: `calendar({ dayLength: 240, seasons: [{ name: 'thaw', days: 3 }, { name: 'frost', days: 9 }] })`;
- an arena or a level at one frozen hour: `sky({ time: '18:30' })` alone (no calendar: the sky draws that fixed time; nothing has a schedule).
A game's own calendar (turns, a lunar calendar) replaces the module by meeting `modules/calendar/contract.js` (recipe 55 "Replacing a module").

## 1. Where to write it
Game logic goes in `main.js` or the game's own module.

```js
import { parseClock, formatClock } from 'threedog';
const lamp = new THREE.PointLight();

// Time-window switch: lamps on from 18:00 to 06:00 (crosses midnight). On registration, at start, after loading a save, applyState, or turning the time back, it aligns to the current time immediately (returns a handle; lampHours.remove() cancels)
const lampHours = engine.calendar.between('18:00', '06:00', { on: () => lamp.visible = true, off: () => lamp.visible = false });

// An event when a clock time is crossed (an "action" once per day): open the market at 12:00
engine.calendar.at('12:00', day => engine.vars.bump('marketDays'), { days: [1, 3, 5] });  // only on days 1, 3, 5; a function also works: day => day % 7 === 6

// After how long: pass an event name to make it saveable (still fires after loading a save); a function cannot be saved
engine.clock.after(120, 'bread:ready', { data: { oven: 1 } });
engine.events.on('bread:ready', ({ oven }) => engine.vars.bump('bread'));

engine.clock.every(30, () => engine.vars.bump('birds'));  // every 30 calendar seconds (not 30 clock seconds)
engine.calendar.daily(day => console.log('day', day));  // every day at 00:00
engine.calendar.onSeason('winter', () => engine.weather?.set('snow', { seconds: 20 }));  // needs seasons (presets.calendar.fourSeasons) and a 'snow' weather (presets.weather.temperate)

// Clock conversion: 'HH:MM' <-> fraction of a day 0-1
engine.calendar.timeOfDay = parseClock('17:30');  // jump straight to 17:30 (see the catch-up rules below)
formatClock(engine.calendar.timeOfDay);  // '17:30' (engine.calendar.clock is the same text)
```
**Use between for states, at for actions.** A lamp on, a shop open, an NPC home are states: `between` checks the time every step, so no time jump leaves them wrong.
`at` is an event for "crossing a clock time", with these catch-up rules:
- It fires only when time moves **forward** across the time: walking naturally, `step` fast-forward, or setting `calendar.timeOfDay` later (17:00 -> 19:00
  on the same day). When several trigger points are crossed at once, `catchUp` decides: `'once'` fires once (default), `'all'` fires them all,
  `'skip'` fires none.
- Turning time **back** does not fire; it only resets the baseline: `applyState({ time })` to an earlier time, or lowering `calendar.timeOfDay` (19:00 ->
  05:50 is going back within the same day, not "a night passed").
- Loading a save does not fire; it only resets the baseline (trigger points between the save and the load are not made up).
So after "applyState back to 17:50" an `at`-driven lamp will not switch itself off: use `between`.
Length of a day: `openWorld({ camera: 'follow', dayLength: 600 })` / `calendar({ dayLength })` (calendar seconds; without it the time of day never moves,
`presets.calendar.cycle` is 360); `engine.mod('clock.rate', { owner: 'game', set: 10 })` speeds things up temporarily (`remove()` on its handle undoes it; see the table above).
For "has this been done" in a story, use `engine.vars.bump / setFlag` (saved automatically).

## 1b. Smooth movement between fixed steps: `engine.stepBlend`
Most frames fall between two fixed steps, so something moved in `onFixed` and drawn at its latest position stutters, more on a fast screen. Keep where it was before the step and draw between: `engine.stepBlend` is how far this frame is from the last step to the next, 0 to 1:
```js fragment
const body = { x: 0, lastX: 0 };
engine.onFixed(dt => { body.lastX = body.x; body.x += speed * dt; });  // the rules read body.x
engine.onFrame(() => { mesh.position.x = body.lastX + (body.x - body.lastX) * engine.stepBlend; });  // the picture only
```
The picture runs at most one step behind; rules read the fixed-step value, never the drawn one. After a teleport set `lastX` to `x` too. While frozen `stepBlend` holds still. `engine.swarm` does this by itself (recipe 65).

## 2. Skipping time (sleep until morning, wait an hour)
`engine.skip` moves calendar seconds and the calendar clock forward without running every fixed step, so even a game with a real-length day can sleep through
the night instantly.
```js
await engine.skip({ to: '06:00' });  // until the calendar clock next reads 06:00 (at 06:00 exactly: a full day; throws without a calendar dayLength)
engine.skip({ seconds: 600 });  // 600 calendar seconds
await engine.skip({ to: '06:00', fade: 0.6, save: 'auto' }); // fade out, jump, save, fade in (through flow.transition when flow is installed)
engine.events.on('time:skip', ({ seconds }) => engine.vars.bump('restSeconds', seconds));  // after the jump
```
What catches up, and how:
- `clock.after / every`, `calendar.at / daily / between`, `day:start`, `season:change` fire **in time order, once per crossing, as if stepped** (a 3-day
  sleep fires `daily` 3 times; `catchUp` does not apply). Inside a callback `clock.now` and `calendar.timeOfDay` already read the callback's own moment.
- World records with `far` catch up the whole span in **one** `far(rec, dt)` at the end (dt in real seconds = calendar seconds / `clock.speed`, the rate x the world channel's speed), near ones
  included; kinds with only `near` are not made up. Growth and respawns measured with `clock.now` (template stages, pickups, vegetation, the crop example in
  recipe 18) are exact; a far function that accumulates dt matches stepping within one far turn (`world.farEvery`); schedule NPCs end at the same
  place within one far turn of walking.
- Not run while skipping: `onFixed`, module `fixed` hooks, physics, near simulation. Every time view moves exactly as if stepped (tick, real,
  ambient, each channel by the skipped real seconds x its speed, the calendar), so timers on any channel fire and `mod`s with `for` end in order (`mod:end` as often as when stepping). So anything that must advance during a sleep is measured in calendar seconds (`clock.now`) or lives in a world record with `far`.
- Input is locked and gameplay frozen for the whole skip (keys pressed during the fade do nothing). With `fade: 0` (default) the time has moved when
  `skip` returns; with a fade the Promise resolves after the fade in, which needs frames (in a halted test keep calling `engine.step`).
- A stopped calendar (`clock.rate` 0) skips as if at 1x. The jump itself is the op `time.skip { seconds }` (logged and replayable; it refuses `seconds <= 0`).
- A module that keeps its own time implements the hook `skip` (recipe 49, item 3).

### Order inside one frame
Each rendered frame runs: input poll -> the fixed steps due (`commits` applied first, then `onFixed`, module `fixed` hooks, `onFixed` `{ phase: 'late' }`, clock timers) -> `onFrame`
callbacks **in the order they were registered** -> animators (every `engine.assets.animate` model and a Character's clips) -> module `frame` hooks -> stream / jobs / batching -> render -> `afterRender` hooks.
Animators run after the whole `onFrame` list, whoever registered first: an `anim.sync / go / set` from `onFrame` shows this frame, and `onFrame` reads last frame's pose.
To read or override a pose after animation, use `character.onPose` (recipe 13) or a module `frame` hook.
When a game has several systems, a default that keeps this order in one place: one `engine.onFixed(dt => { weapons.step(dt); enemies.step(dt); })` in `main.js` instead of one registration per system (`{ phase: 'late' }` for code that reads this step's results; a game module with `before` / `after`: recipe 14).

## 3. Verify
- Without waiting real time: in a test or the console, `engine.calendar.timeOfDay = parseClock('17:59'); engine.step(5)`, then look at the result (`step`
  returns the describe).
  Time-window switch: after `await engine.applyState({ time: '17:50' })` read the state immediately (between has already aligned), then
  `engine.step(...)` across the boundary.
  The length of a day is `describe().time.dayLength` (calendar seconds); with `clock.rate` 1, `step(1 clock minute)` = `step(dayLength / 1440)` (24-hour day); if the rate
  is not 1, divide by `engine.clock.speed` as well.
- Reproduce a scenario: `npm run shot -- / --time 17:58 --wait 10 --describe-only`, then look at the time (18:0x) and your effect (lamps, NPCs, items).
- After `npm run map`, the "timed events" section of GAMEMAP.md lists every `calendar.at/between/daily/onSeason` and `clock.after/every`.
- Is skip the same as living through it? `const r = await engine.checkSkip(600)` skips 600 calendar seconds, rewinds, steps the same span and compares the saved state: `{ ok, diffs: [{ path, a, b }] }`
  (a = skip, b = step; `{ ignore: ['parts.world', 'parts.rigid', 'parts.random'] }` drops paths; it refuses while frozen or with the clock stopped). Skip runs no near simulation, so a moving player/NPC
  or a settling physics body always differs: ignore those parts and read the rest. It leaves the world at the stepped state, so run it on a scratch playthrough or in a test. A diff usually means a
  module with its own time lacks a `skip` hook. `await engine.checkSave()` does the same for save -> load (a diff names a save part whose `load` does not restore what `save` wrote).
- Why did it fire (or not)? `engine.events.traceSize = 200` records each event with the event or op that caused it: `events.trace('item:add').at(-1).chain`. Failed ops, sight queries and NPC state changes are entries too (with `code`); `events.note(name, { obj, code, data })` adds your own and `events.traceFocus(id)` makes one object verbose (the ring is bounded; size 0 costs nothing). Details: recipe 23 section 12.
