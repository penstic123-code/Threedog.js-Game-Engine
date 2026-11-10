# Scene transitions and pause (flow)

> **Covers:** flow states (title, playing, paused, ending), changing scene, input contexts, new game / continue.
> **Use when:** menus, pause, a title screen, moving between scenes.
> **Shortest:** `engine.use(flow({ start: 'title' }))`.
> **Sections:** 1 Pause / title · 1b Title -> start · 2 Changing scene / · 2b Input contexts menus · 3 Verify · 4 New game / · 5 Window and device

Needs the module `flow()` (not in openWorld; add it yourself: `engine.use(openWorld({ camera: 'follow', ...}), flow())`).
- **Flow states**: title, playing (built-in `playing`), paused (built-in `paused`: freezes gameplay + locks input), ending, ... Only one is active at a time.
- **Scene transition** `transition(fn)`: lock input -> fade to black -> fade music out -> (with `{ autosave: 'auto' }` save slot 'auto'; off by If the world does not settle within `engine.loading.timeoutMs`, it rejects with `module-not-ready` and gives the screen and input back. Autosave waits for the end of a transition.
  default) -> run fn -> wait until every module is ready -> fade in -> unlock. Repeated calls queue up automatically.

## 1. Pause / title / ending (in main.js)
```js
import { flow, toast } from 'threedog';
const titleEl = document.getElementById('title'), startBtn = document.getElementById('start');  // elements you wrote in the page html
engine.use(flow({ start: 'title' }));  // start in the title state (entered after engine:ready)

engine.flow.define('title', {
  freeze: true, lockInput: true, music: 'title',  // music: the track to play on entry (music module), null = stop
  enter: (e, from) => { titleEl.hidden = false; },
  exit: (e, to) => { titleEl.hidden = true; },
});
engine.flow.define('ending', { freeze: true, lockInput: true, enter: () => toast(engine, 'The end') });
startBtn.onclick = () => engine.flow.go('playing');

engine.input.define('pause', { label: 'Pause', keys: ['KeyO'] });  // read by action name; Esc is the back key (see below)
engine.onFrame(() => {
  if (engine.input.pressedRaw('pause')) engine.flow.go(engine.flow.state === 'paused' ? 'playing' : 'paused');  // paused pushes an opaque input context, so use pressedRaw
});
engine.events.on('flow:change', ({ from, to }) => console.log(from, '->', to));
```
**Pausing has a single entry point: flow's `'paused'`** (internally `engine.freeze('flow')`: the picture keeps rendering and the UI keeps working).
`engine.haltLoop()` stops even rendering and is for tests; a game never needs it.
The settings menu also pauses while open: `settings({ freezeWorld: true })`. With flow installed it switches to `'paused'` and returns to the previous
state when the menu closes; without flow it calls `engine.freeze('settings')` directly.
Stopped while frozen: the fixed step (movement, physics), module `fixed`, the game clock `clock`, quest checks (they run in the fixed step), timeline
`wait` / tweens / camera / paths. Still running: rendering, UI, `onFrame`, the fade-to-black `fadeScreen`.

Restarting a run from a UI button (retry, "play again"): a whole new run is `engine.session.newGame()`; it works from a frozen screen too, and flow goes to `'playing'` by itself.
To reset only part of the run, do not write positions, health and spawns inside the click handler or an `onFrame` callback; that is mid-frame and can leave half the world on the old tick.
Apply it on a fixed tick with `engine.nextFixed(fn)` or a flag read in `onFixed`. No fixed step runs while frozen, so on an end screen with `freeze: true` leave the freeze first:
```js
engine.flow.define('gameOver', { freeze: true, lockInput: true });
const resetRun = () => engine.vars.bump('tries', 1);  // the game's own reset: positions, health, spawns
const retry = async () => { engine.flow.go('playing'); await engine.nextFixed(resetRun); };  // this order: frozen, nextFixed never fires
```

### Back key (Esc): the UI focus stack
Windows (inventory, quests, settings), dialogue and cutscenes are pushed onto the stack in the order they open (`uiFocus(engine)` in `ui/Focus.js`),
and Esc goes **only to the top one**:
cutscene -> skip; window -> close; dialogue -> swallow (do nothing); empty stack -> open the settings menu. So one Esc never both skips a cutscene and
opens the menu, and no patch like "ignore keys for 0.15 s after opening" is needed.
A game's own windows made with `makeWindow` are pushed automatically (`onCancel` changes what Esc does); UI you draw yourself must be pushed:
`uiFocus` is experimental; `engine.input.push` is the stable route to take the keys for a screen of your own.
```js
import { uiFocus } from 'threedog';
const h = uiFocus(engine).push('myMap', { cancel: () => closeMap() });  // call h.remove() when closing; h.fresh = opened this very frame
```
An entry with a `nav` (every window, the settings menu, dialogue choices) lets go of a locked mouse when it opens. For anything else, `engine.page.releaseLock()` frees the mouse
(recipe 21); neither counts as the player's Esc, so the pause menu stays shut.

## 1b. Title -> start -> continue, and opening straight into a moment (screenshots, tests)
`flow({ start: 'title' })` enters the title during `engine.start()` (on `engine:ready`), so when `await engine.start()` returns the title is
already showing. The title's buttons go through `engine.session` (section 4): a fresh run or the saved one, then flow moves to `'playing'` by itself.
To open straight into play, pick the start state up front instead of leaving the title afterwards; time and weather come from the engine's
own URL keys (`?time=22:20&weather=storm`, applied after `engine:ready`, weather at once, then `wait` seconds are advanced), so only the game's
own state needs a key of its own.
```js fragment
const q = new URLSearchParams(location.search), moment = q.get('moment');  // the game's own key: which lamps are lit, the score ...
engine.use(openWorld({ camera: 'follow' }), flow({ start: moment ? 'playing' : 'title' }));
engine.flow.define('title', { freeze: true, lockInput: true,
  enter: () => showTitle({ canContinue: engine.saves.list().some(s => s.slot === 'auto') }), exit: () => hideTitle() });
newBtn.onclick = () => engine.session.newGame();  // -> session:start -> 'playing'
continueBtn.onclick = () => engine.session.load('auto');  // the same, from the save
await engine.start();
if (moment) setUpMoment(moment);  // the game's own data only; in code, time / weather are engine.calendar.timeOfDay = 0.93, weather.set('storm', { seconds: 0 })
```
The engine's ready-made title (`createEngine({ ui: { title } })`, recipe 26 §5) opens in `start()` the same way: leave `title` out for a moment
(`ui: { ...(moment ? {} : { title: { title: 'My Game', items: ['continue', 'start'] } }) }`).
Shoot it with `npm run shot -- "/?moment=night" --time 22:20 --weather storm`; a game test opens the same URL.
To start at a named place, write no code: `?at=pier` (dev and tools, like the other URL keys; `npm run shot -- --at pier`, `applyState({ at: 'pier' })`) leaves the
start screen as `?play` does, stands the player at that place of `content/places.js` (or a level marker) after the game's `session:start` code ran, and puts the
game's camera there at once. An unknown name stops with the list of places. A camera of your own: listen to `state:placed` ({ x, z }).

To get past the title without a key of your own, use the engine's `?play` URL key (`npm run shot -- --play`, `applyState({ play: true })`): after
`engine:ready` it does what the title's Start does (`engine.session.newGame()`, then the title part closes), so `flow({ start: 'title' })` moves to
`'playing'` and the game's `session:start` setup runs; with no title up it does nothing. `?fresh` (`applyState({ fresh: true })`) first deletes this
page's saves, so the title offers no Continue; on a running page it also ends the run. Two things that leave a moment half-drawn in a picture: a headless page
advances only on `engine.step`, so a `weather.set(name, { seconds: 0.1 })` made after `start()` is still changing (use `seconds: 0`), and an `onFrame` copy of a sky
color is one frame old (share `engine.uniforms.uSkyHorizon` instead, recipe 08).

## 2. Changing scene / teleporting
```js fragment
// A level-based game: switch to another map
await engine.flow.transition(async () => {
  await engine.level.load('/models/town2.glb');  // or a name from the assets manifest
  engine.player.placeAt(engine.level.spawn);
  engine.cameraRig.follow(engine.player.root);  // the camera jumps straight there instead of flying from far away
}, { fade: 0.6, autosave: 'auto' });  // also save slot 'auto' before switching

// Teleport within the same map: no save, music keeps playing
engine.flow.transition(() => engine.player.placeAt([40, 0, -20]), { music: 'keep' });
```
When the level changes, trigger zones built by `triggers.fromMarkers` are cleared automatically. NPCs, pickups and props in content whose position uses a level
marker are not deleted: their data (in `engine.world`, with zone = level name) stays and only the model is removed; it is rebuilt automatically
when you return to this map, with its state intact.
Things the game builds itself that belong to this map are registered with `engine.level.track(handle)` (`{ remove() }`) and deleted together when the
map changes.
Loading a save across levels: the save records the level name, so `await engine.saves.load('slot1')` first switches back to that map, waits for it to
finish loading, and then puts the player and everything else back. The level must be loaded by name, `level({ url })`. For an area built in code that name
is a builder in the assets manifest (recipe 66, "Two areas built in code"); a `level({ scene })` object has no name to record.

Saves live in the browser's IndexedDB (falling back to localStorage, with one notice). `save()` / `remove()` / `load()` return a Promise (a failed write shows a notice), while
`list()` / `export()` are synchronous (saves are read into memory at startup). Attachments, file backup and `storageKey`: `../api/saves.md`.
For just a fade-to-black, without locking input or saving: `await fadeScreen(engine, 1, { seconds: 0.5 }); ...; await fadeScreen(engine, 0, { seconds: 0.5 });` (import from `threedog`).
Fades inside a cutscene use the timeline steps `{ fade: 0.5 }`, `{ fade: 0.5, to: 0 }`.

## 2b. Input contexts (menus, vehicles, build mode)
Who declares an action and who binds its keys: recipe 58.
Actions are grouped into **contexts**, a stack like Unity's Action Maps. `input.push(name)` returns a handle; `h.remove()` pops it. The top context
shadows lower actions bound to the same key; an opaque context (the default) blocks everything below it, `{ pass: true }` lets unrelated actions
through. Dialogue, windows, full-screen UI parts, cutscenes (while the player is one of their `actors`), paused and transitions each push an
opaque one: that is what "locks input" means (`input.enabled` is false while one is on the stack). Who moves a character is separate: a
cutscene takes its actors' control ([57-control](57-control.md)).
```js
engine.input.define('exit', { label: 'Get out', keys: ['KeyF'], context: 'vehicle' });  // 'interact' has E; give the vehicle its own keys
engine.input.define('inspect', { label: 'Inspect', keys: ['KeyF'] });  // gameplay action on the same key
const h = engine.input.push('vehicle', { pass: true });  // now F means exit, inspect is shadowed, WASD still works
h.remove();  // back on foot
engine.input.define('menuConfirm', { label: 'OK', keys: ['Space'], context: 'menu' });  // readable only while a window / menu is open
```
- A switch applies at the start of the next fixed step (the input snapshot), so the press that boarded cannot also get out in the same step. Actions
  the switch blocks lose their held state, and a key cleared this way stays dead until released: closing a menu never leaves a key "still held" and
  keyboard auto-repeat does not bring it back.
- Losing focus (`blur`, tab hidden) releases every held key.
- `describe().holds.input` lists the stack with owners (`input.push(name, { owner })`; `input.gate(action, owner)` closes one action, listed in `holds.gates`; `holds.shadowed`: actions a pass context's key hides; `press` also names `shadowed-by:` / `context-off:`); the event `input:context { stack }` fires on every change. `characters()` pushes `'vehicle'` while
  the player drives (its `brake` action lives there).
- Test: `engine.input.push('menu'); engine.step(1 / 60);` then `input.pressed('attack')` is false.

## 3. Verify
- `describe().flow`: `{ state: 'paused', transitioning: false }`; when `describe().time.frozen` is true gameplay is frozen; `ui.inputLocked` shows
  whether input is locked.
- In tests: after `engine.flow.go('paused'); engine.step(1)` the player position, `engine.clock.now`, quest progress and timelines are unchanged;
  after `await engine.flow.transition(fn)` returns, `transitioning` is false (if fn throws, the error goes to the caller and the screen still fades back in).

## 4. New game / continue / back to title / retry (engine.session)
Every playthrough starts from a clean slate, so a second new game is exactly like the first:
```js fragment
await engine.session.newGame();  // the state right after start(): world, containers, vars, quests, clock, sky, weather, random
await engine.session.load('slot1');  // continue (title "Continue", settings "Load"); retry: engine.session.load('checkpoint')
await engine.session.quit();  // back to the title (settings "Back to title"); the title's Start calls newGame
engine.session.track(engine.events.once('npc:talk', onTalk));  // anything the game adds during play: removed when the playthrough ends
```
Ending a playthrough drops a running cutscene, removes tracked handles, drops clock timers added after start(), drops background results not yet
applied (commits), stops the music, applies the start state and snaps the camera to the player. flow goes back to its start state, then to
`'playing'`. Events: `session:end`, `session:start { kind: 'new' | 'load', slot? }` (play an intro per new game there, not on `engine:ready`).
- When a save part's `load()` throws, newGame / `session.load` resolve `false` and the old playthrough goes on: its data is rolled back, its
  tracked handles and timers stay, flow returns to the state it left, and `session:failed { kind, slot? }` fires instead of `session:start` (also from a rolled-back `saves.load` or `saves.apply`, with `kind: 'quick'`) (for a quit: instead of the title, kind 'quit').
- `saves.load(slot)` is a quick load onto the running playthrough (keeps what the game added); `session.load(slot)` ends the playthrough first and
  refuses an unreadable save without touching the game. Deleting a save is `saves.remove(slot)`.
- Listeners and hooks registered at boot stay (they are the game); register play-time ones with `session.track`.

## 5. Window and device (engine.page)
One place listens to window focus, tab visibility, mouse lock and the WebGL context; modules never add their own listeners.
- Window in the background / tab hidden: gameplay is frozen by owner `'page'`, a full still (`freeze('page', { still: true })`; cutscenes stop too, rendering and UI go on; `engine.frozen` and `runState.owners` show it). `createEngine({ pauseOnBlur: false })` or
  `engine.page.pauseOnBlur = false` keeps playing. Coming back resumes with no catch-up burst; a long frame turns into at most 0.1 s of fixed steps,
  and fewer when the steps are heavy (at most about 33 ms of catch-up work per frame; the rest is dropped as a brief slow-down). `engine.step()` never drops time.
- `engine.events.on('page:blur', () => engine.flow?.go('paused'))` also opens the pause menu. Other events: `page:focus`,
  `page:pointerlock { locked, byEngine }` (cameras lock again on the next click; a lock the player ended counts as Esc, because the browser keeps that key), `page:contextlost` / `page:contextrestored` (the same freeze, and the player
  sees a message; three.js restores the context).
- `engine.step()` still advances while away (tests, dev bridge). Held keys are released by Input.
- Tests: `threedog test "Session:" "Window:"`.
