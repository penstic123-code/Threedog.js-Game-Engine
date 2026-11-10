# UI parts: replace or turn off any piece of the engine's screen UI

> **Covers:** every piece of the engine's screen UI as a replaceable part, themes, toasts, the dialogue box.
> **Use when:** restyling or replacing the HUD, menus or dialogue.
> **Shortest:** a `theme` object of colors and fonts (§"Reskin").
> **Sections:** Reskin your picture on · 1 Pick at start · 2 Your own part · 3 Toasts filter instead · 4 Dialogue box your · The choice cursor windows · 5 Title screen and · 6 Settings menu only · 7 Keys, and UI

Every piece of UI the engine draws is a named **part** with a plain default:
`loading`, `toast`, `title` (off by default), `touch` (on-screen stick and buttons),
`hud.marker`, `hud.counter`, `hud.bar`, `hud.button`, `dialogue`, `prompt` ("E · Talk"), `questLog`, `inventory` (with the inventory module).
The engine keeps the behavior (when to show, the UI focus stack and Esc, input lock, i18n); a part only draws the data it gets.
Each name takes one value: `false` off · `true` default · `{ ...options }` default with options ·
`(engine, options) => ({ show, update, hide, dispose })` your own (any verb may be omitted).
An end screen is a flow state (`engine.flow.define('gameOver', { freeze: true, lockInput: true })`, recipe 07 §1) showing a window with `closable: false` ("A window: results, game over", below).
Only want different colors / layout? Use "Reskin" below, not a new part.

## Reskin: your picture on every default part, in one place
The default parts are neutral gray on purpose. About ten lines give all of them the game's picture; do this before writing your own dialogue box or HUD:
```js
const theme = {  // picture/ui.js
  bg: 'rgba(38,28,20,.94)',  // panels: dialogue, prompt, toast, windows; the HUD uses it slightly see-through
  fg: '#f4e8d0', muted: '#b8a88c',  // text, secondary text
  accent: '#e8a13a', good: '#9ccf6a',  // names, cursor, toast border, HUD bars; "done"
  line: 'rgba(244,232,208,.25)',  // borders, dividers
  font: '"Georgia", serif',  // a font file: ui.fonts: ['name'] (recipe 05, fonts)
  radius: '4px', radiusSmall: '2px',  // windows and dialogue; buttons, prompts, toasts, HUD counters
  loadingBg: '#1c140e',  // loading and title screens, cutscene bars
};
const engine = createEngine({ canvas, ui: { theme } });  // the same ui option as the parts below
```
Each key becomes the CSS variable `--threedog-<key>` (`radiusSmall` -> `--threedog-radius-small`) on `engine.uiRoot`, and no default rule has a color or corner of
its own. Also there: `shadow` (windows), `shadowSmall` (bubbles, marker labels), `fadeBg` (scene fades), and `hudBg` / `hudFg` / `hudAccent`,
which follow the main ones unless set. Your own part can read the same variables. Further steps, beside `theme` in the same `ui`: `css` is placed after every default, so it
overrides the `.threedog-*` classes (sizes, layout); `templates.<window>` replaces a window's HTML (`engine.ui.templates` is the same object, written directly); `fonts` lists
font assets. How high the prompt floats is `interactions({ promptHeight })`.

## 1. Pick at start (copy it)
```js
const engine = createEngine({
  canvas,
  ui: {
    loading: { title: 'My Game' },  // default loading screen with a title
    title: { title: 'My Game' },  // turn on the title screen: Continue (when a save exists) / Start / Settings
    toast: false,  // no pop-up messages at all
  },
});
```
`loading` can only be set here (it shows while the engine is built). The others may also be set with `engine.ui.set(name, value)` before `engine.start()`.
A misspelled name throws at `start()` and lists the names that exist.

## 2. Your own part (DOM, canvas, a UI library: anything)
```js
engine.ui.set('hud.bar', (engine) => {  // called once per bar
  const el = document.createElement('progress'); el.max = 1; engine.uiRoot.appendChild(el);  // build under engine.uiRoot: dispose cleans it up
  return {
    update: d => { el.value = d.value / (d.max ?? 1); el.title = d.label ?? d.id; },
    dispose: () => el.remove(),
  };
});
engine.hud.bar('hp', { value: 80, max: 100, label: 'HP' });  // game code does not change
```
What each part receives:
| Part | Created | Calls |
|---|---|---|
| `loading` | once | `show({ title })` · `update({ progress 0-1, text })` · `hide()` |
| `toast` | once | `show({ text, kind, ms })`; kind is `'info' 'quest' 'item' 'save' 'error'` |
| `title` | once | `show({ title, items: [{ id, label, run() }] })` · `hide()` (call `item.run()` on click) |
| `hud.marker` | per marker | `update({ x, y, onScreen, arrow, angle, label, icon, distance })` every frame · `hide()` · `dispose()` |
| `hud.counter` | per counter | `update({ id, label, icon, value, max })` · `dispose()` |
| `hud.bar` | per bar | `update({ id, label, value, max })` · `dispose()` |
| `hud.button` | per button | `update({ id, label, icon, run, key? })` · `dispose()` (call `run()` on click; `label` goes through `engine.t`) |
| `hud.hint` | per key hint | `update({ id, label, key })` · `dispose()` (shows `key · label` like `prompt`, e.g. `Space · Jump`; `key` = `input.label(action)` or `input.noKey`, kept current) |
| `inventory` | once (on first open; opened by the bound `inventory` key or `engine.ui.open('inventory')`) | `show(d)` · `update(d)` while open · `hide()`; `d = { title, hint, items: [{ key, id, count, data, def }], capacity, used, weight, maxWeight }`; buttons run `inventory.use / drop / transfer` ops (recipe 03) |
| `touch` | once, if wanted (1) | `show(view)` · `update(view)` (buttons or language changed) |
| `prompt` | once | `update({ id, action, key, label, text, x, y, onScreen, use(), options })` every frame in reach · `hide()` |
| `questLog` | once, full screen (2) | `show(view)` · `update(view)` (quests changed while open) · `hide()` |
| `dialogue` | once | `show()` · `update(view)` per line, typed character, choices (section 4) · `hide()` |

(1) Only when a stick (`createEngine({ joystick })`: `'auto'` on touch devices, `true` always) or a touch button is wanted.
`view = { stick, buttons: [{ action, label }], move(x, y), press(action), release(action) }`.
(2) The bound `quests` key (e.g. `presets.bindings.quests`) opens it, Esc and the key close it.
`view = { title, key, quests: engine.quests.list(), close() }`.

Every view hands back functions (`advance`, `choose`, `use`, `close`, `move`, `press`...) instead of making your part call engine internals:
they run the same ops and input path as keys, so tests, the dev bridge and replays see one path.
With every part off (`false`) the engine draws no DOM at all and the logic keeps running (`describe()`, ops, quests).

## 3. Toasts: filter instead of all-or-nothing
```js
toast(engine, 'Saved', { kind: 'save' });  // your own message (the engine comes first)
engine.ui.set('toast', (engine) => ({ show: ({ text, kind }) => { if (kind !== 'quest') myBanner(text); } }));
engine.use(quests({ notify: false }));  // or only silence quest messages; notify: ({ type, id, text }) => ... shows them your way
```

## 4. Dialogue box: your own picture, your own fields
The engine keeps the dialogue logic (typing on game time, input lock, Esc, number keys, conditions).
The part draws `view` and answers with `view.advance()` / `view.choose(i)`, which run the ops `dialogue.advance` / `dialogue.choose`.
`view = { script, node, speaker, text (typed so far), full, typing, choices: [{ text, key, data }], hint, data, lock, advance(), choose(i) }`
```js
engine.dialogue.define('fisher', {
  start: { text: 'Quiet day.', data: { portrait: 'fisher.png', mood: 'tired' }, next: 'ask' },  // your own fields go in data
  ask: { text: 'Here for photos?', choices: [{ text: 'Yes', next: 'end', data: { icon: '📷' } }] },
});
engine.ui.set('dialogue', (engine) => {
  const el = document.createElement('div'); el.className = 'my-dlg'; el.hidden = true; engine.uiRoot.appendChild(el);
  let view = null;
  el.onclick = (ev) => { const i = ev.target.dataset?.i; i != null ? view.choose(+i) : view.advance(); };
  return {
    show: () => { el.hidden = false; },
    update: (v) => {
      view = v;
      el.innerHTML = `<img src="${v.data.portrait ?? ''}"><b>${v.speaker}</b><p>${v.text}</p>`
        + v.choices.map((c, i) => `<button data-i="${i}">${c.data.icon ?? ''} ${c.text}</button>`).join('');
    },
    hide: () => { el.hidden = true; },
    dispose: () => el.remove(),
  };
});
// voice / portraits / camera shots without replacing the box:
engine.events.on('dialogue:line', ({ speaker, data }) => { if (data.voice) playVoice(data.voice); });
```
Any other unknown node key is reported as a typo (a misspelled `next` would silently end the dialogue), so extra fields always go in `data`.
- **Two channels.** `main` (default) is the conversation the player reads: it locks game input, takes Esc and its choices.
  `bubble` is a line over its speaker while the player keeps playing (barks, shop chatter, a squad calling out, radio with no `at`):
  `engine.dialogue.say('Reloading!', { speaker: 'Mira', channel: 'bubble', at: mira.root, seconds: 2 })`, or a whole script with
  `start(name, 'start', null, { channel: 'bubble', at })`. Several speakers show at once; one speaker's lines queue (`queue: false` replaces).
  Bubbles never wait for or cut into the main dialogue. They are drawn by the multi part `dialogue.bubble` (`update({ speaker, text, x, y, onScreen, screen })`
  every frame); `describe().ui.bubbles` lists them. NPCs pick the channel with the `npc.talk` arg `channel: 'bubble'`, a timeline `say` step with `channel` / `at`.
- **Keyboard and gamepad choices**: the main dialogue's choices take the UI choice cursor (next section); `view.selected` is the highlighted one.
- **Options**: `dialogue({ charsPerSecond: 40, advanceActions: ['confirm'], holdSeconds: 2 })`.
  `charsPerSecond: 0` shows the whole line at once. Number keys pick choices only when the game binds them: `createEngine({ bindings: { ...presets.bindings.dialogNumbers } })`.
  The choice keys are the actions `choice1`...`choice9` (rebind with `createEngine({ bindings })`), read only while the main dialogue runs.

## The choice cursor: windows and choices without a mouse

Every entry of the UI focus stack (dialogue, `engine.ui.open` parts, `makeWindow` windows) can carry a cursor. The menu actions `uiUp` / `uiDown` /
`uiLeft` / `uiRight` (arrows and WASD, gamepad d-pad; the left stick too) move it and `confirm` (Space / Enter, pad A) presses it; `cancel`
(Esc, pad B) is still the back key. Only the top entry moves, so a dialogue over an open window never moves the window's slots.
- A window or full-screen part: the cursor walks the controls inside the part's `el` (button, input, select, `[data-nav]`) by screen layout,
  so lists, slot grids and settings rows all work without declaring columns; left / right change a slider or a dropdown. The selected control
  has the class `is-cursor` (style it in `ui.css`). Your own part opts in by exposing `get el() { return root; }`.
- Your own focus entry: `uiFocus(engine).push('shop', { cancel, nav: () => shopEl })`, or a list you draw yourself:
  `nav: { count: () => items.length, moved: i => draw(i), confirm: i => engine.ops.run('shop.buy', { item: items[i].id }) }`.
- Keys are actions: rebind with `createEngine({ bindings: { uiUp: ['KeyI', 'PadUp'], confirm: ['Space', 'PadB'], cancel: ['Escape', 'PadA'] } })` or the settings menu.

### A window: results, game over, summary, any modal
`makeWindow` is the one window: it opens on top of the UI focus stack, locks game input while open, closes with its close button or Esc
(pad B), and its buttons take the choice cursor, so it works with the keyboard, a gamepad and the mouse (opening it lets go of a locked mouse; the next click on
the view locks again). A window that ends something, win or lose, takes `closable: false`: no close button and Esc does nothing, so the player cannot slip back into the
game past it and only your buttons end it. Nothing else closes a window: a game that restarts by another road (a new game from the title, a load) closes it on `session:start`. Its picture is your `ui.css` /
`ui.templates[id]`. A level clear, a match score, a day's earnings or a run summary are all this:
```js fragment
import { makeWindow } from 'threedog';
const results = makeWindow(engine, {
  id: 'results', title: () => 'Run complete',
  data: () => ({ score: run.score, best: run.best }),  // read on every refresh(), so it shows the current values
  render: (d, { esc }) => `<p>${esc(d.score)} / ${esc(d.best)}</p><button class="threedog-btn" data-act="again">Again</button>`,
  closable: false,  // a run summary ends the run; for a window Esc may leave, drop this (onCancel changes what Esc does)
});
results.el.addEventListener('click', ev => {  // one listener: refresh() rewrites the content, not this
  if (ev.target.closest('[data-act="again"]')) { results.toggle(false); startRun(); }  // a click, Enter or pad A on the cursor
});
let held = null;  // stop gameplay behind it (the picture keeps drawing)
engine.events.on('ui:open', id => { if (id === 'results') held = engine.freeze('results'); });
engine.events.on('ui:close', id => { if (id === 'results') { held?.remove(); held = null; } });
engine.events.on('session:start', () => results.toggle(false));  // a new run or a load, however it was started
results.toggle(true);  // when the run ends; results.refresh() after the data changes
```

## 5. Title screen and "back to title"
```js
createEngine({ canvas, ui: { title: { title: 'My Game', items: ['continue', 'start', { label: 'Credits', run: e => showCredits() }] } } });
engine.events.on('ui:close', id => { if (id === 'title') startIntro(); });  // the player left the title screen
engine.ui.open('title');  // show it again (the settings 'game' tab has a "Back to title" button)
```
While the title is open gameplay is frozen, input is locked, and Esc goes to it (the settings menu does not open).

**A custom item closes the title itself.** The built-in `continue` / `start` call `e.ui.close('title')` after loading; yours does not, so `flow` can reach `playing` with the title still on top, no warning. End every item that leaves the title with `e.ui.close('title')`:
```js fragment
{ label: 'Tutorial', run: async e => { await e.session.newGame(); e.ui.close('title'); } }
```

### Photo mode: the picture without the interface, and hiding the interface
`engine.photo.take()` (op `photo.take`) reads back one canvas frame at a higher pixel ratio, so no DOM (HUD, toasts, windows) is in it. To hide the interface on screen, hide the engine's UI root:
```js
const photoMode = on => { engine.uiRoot.style.display = on ? 'none' : ''; };  // hud, toasts, windows, title
engine.photo.take();  // shot.url is the picture, the album keeps it
photoMode(true);  // while the player frames a shot
```
```js fragment
engine.use(photo({ pathTracer: () => import('three-gpu-pathtracer/webgpu') }));  // after npm i -D three-gpu-pathtracer three-mesh-bvh
const still = await engine.photo.trace({ samples: 128 });  // still.pathTraced.untraced: what differs
```
HUD text follows the engine locale (`createEngine({ locale })`, default `'auto'` = the browser language): a game written in English sets `locale: 'en'`, or distance labels read `50 米` on a Chinese browser.

## 6. Settings menu: only the tabs the game needs
```js
engine.use(settings({ sections: ['game', 'graphics', 'audio', 'controls', 'camera'] }));  // default: graphics, audio, controls, language, saves
// optional built-ins by name: 'game' (resume / load / back to title), 'camera' (sensitivity, invert Y, field of view; re-applied on 'camera:change')
engine.settings.addSection('camera');
// leave graphics rows out: the entry { id: 'graphics', omit } in the list; an omitted row stays the game's value, and no preset or stored value moves it
settings({ sections: [{ id: 'graphics', omit: ['pixelRatio', 'antialias', 'adaptive'] }, 'audio', 'controls', 'language', 'saves'] });

// a setting of your own is a menu row the engine draws, in the 'options' tab unless menu names another tab
// (true/false: a switch; a number: a slider from min to max; options: buttons). label: an i18n key or text, else the key
engine.settings.define('subtitles', true, { label: 'my.subtitles', apply: on => { document.body.dataset.subtitles = String(on); } });
engine.settings.define('lampShadows', true, { menu: 'graphics', apply: on => { lamp.castShadow = on; } });
engine.settings.define('difficulty', 'normal', { options: ['easy', 'normal', 'hard'], apply: d => game.setDifficulty(d) });
engine.settings.define('hudScale', 1, { min: 0.5, max: 2, step: 0.1, apply: v => hud.scale(v) });

// a tab of your own: render gets tools with the control helpers (row / toggle / range / segmented) already bound;
// the rows it draws itself say menu: false, or the engine draws them a second time (it warns once when it sees that)
engine.settings.define('vibration', true, { menu: false, apply: on => { game.vibration = on; } });
engine.settings.addSection('gameplay', {
  title: 'Gameplay',
  render: (tools, e, s) => tools.row('Vibration', tools.toggle('vibration', s.get('vibration'))),
  order: 50,
});
```
`settings.define` draws the row itself, in the 'options' tab (`menu: '<tab>'` picks another tab), labelled by `label` (text, or an i18n key such as `settings.subtitles` in `strings`). With `menu: false` it draws nothing: the row is what your own tab's `render` returns, labelled by the first argument of `tools.row` (text, or `e.t('settings.subtitles')`).

A row that switches off an effect of your own (a post effect, a picture value): name the shared value it limits, and it works like the
built-in shadows row. Off holds the value off on the settings layer, so a later scene, weather or cutscene cannot turn it back on; on
allows whatever the scene chose. A number row from 0 to 1 is a factor on a number value. Define the row after the effect exists. `bloom` and `ao` already have rows of their own (limiting `post.bloom.enabled` / `post.ao.enabled`), so `settings.define('bloom', ...)` throws: switch them with `engine.settings.set('bloom', false)`, or in a preset.
```js fragment
engine.post.add(volFog);  // post.volFog.enabled now exists
engine.settings.define('volFog', true, { limits: 'post.volFog.enabled' });  // add apply: v => ... too if the game reacts in code
engine.settings.define('flashCap', 1, { limits: 'sky.flash' });  // 0.5 = half of any lightning flash
settings({ presets: { low: { volFog: false } } });  // a preset can switch the row like any other key
settings({ presets: { low: { viewChunks: 0.5, density: 0.25 } } });  // viewChunks and density in a preset: shares (0 to 1) of the game's own value; the top preset lets everything through
settings({ presets: { low: { pixelRatio: 0.5 } } });  // pixelRatio in a preset: a share (0 to 1) of the ratio the engine picked for this device
```
`engine.describe().shared['post.volFog.enabled']` shows the settings entry and what the scene wanted underneath.

A completely different menu: don't install `settings()`; open your own with `uiFocus(engine).setRoot(() => myMenu.open())` so Esc on an empty stack reaches it.

Check what is in use: `engine.ui.describe()` → `{ loading: 'default', toast: 'off', 'hud.bar': 'custom', ... }`.

## 7. Keys, and UI that follows the world
- Read keys by bound action name (recipe 58): gameplay keys in the fixed step, UI keys in the frame hook; no `keydown` listeners, no `pointer.clicked` for gameplay (bind `Mouse0`).
- A label over a world position: `worldToScreen(engine, pos)` gives screen coordinates for an HTML element.
- A counter bound to an item count: recipe 22 section 4.
