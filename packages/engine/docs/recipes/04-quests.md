# Adding quests (with HUD objective markers)

> **Covers:** quests as data or code, progress, objective markers.
> **Use when:** goals the player follows and checks off.
> **Shortest:** a quest entry in content data with `quests()` installed (§1).
> **Sections:** 1 Write data recommended) · 2 In code complex · 3 Verify · Reading and moving progress

Modules needed: `quests()` (quest log; the game binds its `quests` action: `presets.bindings.quests` is J / gamepad Select, `quests: []` for
none); objective markers need `hud()` (neither is in openWorld, add them yourself:
`engine.use(openWorld({ camera: 'follow', ...}), quests(), hud())`).
A quest is a list of steps completed in order; each step has one completion condition (or several parallel goals), checked every half second; a quest
may also fail. When the current step has a `target`, hud shows a marker and distance above it automatically, and an edge arrow when it is off-screen.

## 1. Write data (recommended)
`games/<game>/content/quests.js`:
```js
export default {
  'restore-power': {
    title: 'Restore power',
    desc: 'The engineer needs three fuses to restart the relay.',
    startOn: 'engine:ready',  // the event that starts it automatically (or use { startQuest: 'restore-power' } in a dialogue)
    steps: [
      { id: 'talk', text: 'Talk to the engineer', done: { flag: 'metEngineer' }, target: { npc: 'engineer' } },  // the marker follows the NPC
      { id: 'gather', text: 'Find 3 fuses', done: { has: { fuse: 3 } }, target: 'storage' },  // a place name
      { id: 'return', text: 'Fit them at the relay', done: { flag: 'relayOn' }, target: { place: 'home', x: 0, z: 3 } },
    ],
    reward: [{ take: { fuse: 3 } }, { give: { coin: 5 } }, { toast: 'Power restored!' }],
  },
};
```
`target` forms: a place name (its coordinates come from `content/places.js`, `engine.content.load(data, { places })` or a level marker, recipe 01), `{ place, x, z }`, `{ x, z }` (world coordinates; any of these may add `floor` / `y` for a storey on multi-layer ground,
as in props), `{ npc: 'id in npcs.js' }`, `{ nearest: 'itemId' }` (the closest not-yet-picked-up pickup of that kind to the player; hidden
automatically once picked up).
In code you can also write a function `target: () => target or null` (evaluated every frame); to change the target of a manual marker use
`engine.hud.marker(...).setTarget(newTarget)`.
Give every step (and every part of a parallel step) a stable `id`: saves store progress by it, so inserting or reordering steps after release never
moves a player's progress (without ids the position is the id). A save that names a step id the quest no longer has restarts that quest from its first
step, with a dev warning (code `quest-step`).
Completion conditions use the condition words (flag has counter...); to count "how many times", call `engine.vars.bump('name')` in code and write the
condition as `{ counter: { name: 3 } }`.

### Parallel goals, optional goals, failing
Not every quest is a straight line. A step can hold several goals done in any order (`all`); a goal marked `optional` never holds the step back;
`fail` ends the quest early:
```js fragment
'defend-camp': {
  title: 'Hold the camp',
  startOn: 'engine:ready',
  steps: [
    { text: 'Reach the camp', done: { flag: 'atCamp' }, target: 'camp' },
    { all: [  // text defaults to the required goals: "Hold the north gate / Hold the south gate"
      { text: 'Hold the north gate', done: { counter: { northWaves: 3 } }, target: 'northGate' },
      { text: 'Hold the south gate', done: { counter: { southWaves: 3 } }, target: 'southGate' },
      { text: 'No ally hurt', done: { notFlag: 'allyHurt' }, optional: true },  // a bonus: never blocks, shown done if met in time
    ] },
  ],
  fail: { flag: 'campBurned' },  // checked while the quest is active
  onFail: [{ toast: 'The camp has fallen' }, { setFlag: 'mayRetryCamp' }],
  reward: { give: { coin: 20 } },
},
```
- hud marks every unfinished goal of the current parallel step; `quests.list()` gives that step `parts: [{ text, target, optional, done }]`.
- Events: `quest:part` `{ id, step, part }` when one goal is met (give a bonus for an optional goal here), `quest:fail` `{ id }`.
- A failed quest is not active (`isFailed(id)`); `quests.start(id)` (or `{ startQuest }`) takes it again from step 1 — daily orders, retries.

## 2. In code (complex conditions, or when you need functions)
```js
engine.quests.define('slimes3', {
  title: 'Clear the cellar',
  steps: [{ text: 'Defeat 3 slimes', done: e => e.vars.counter('slimes') >= 3, target: () => engine.npcs.get('engineer')?.position }],  // the function returns a position every frame: when the NPC is far away and has no model, root is null, so read position from the data
  reward: e => e.inventory.add('coin', 3),
});
engine.quests.start('slimes3');
engine.vars.bump('slimes');  // each time one is defeated
engine.events.on('quest:done', ({ id }) => { /* quest completed */ });  // there are also quest:start, quest:step, quest:part and quest:fail
```
A failed reward (full bag, refused `{ op }`, a function returning `{ ok: false, code }`) still finishes the quest and fires `quest:unpaid`. Items that did not fit stay owed (`quests.list()`, saved) until there is room, unless the game decides itself with `onUnpaid` (effect words, or `(e, answer) => ...`).

To turn off automatic markers: `hud({ questMarkers: false })`. To add a marker by hand: `const m = engine.hud.marker('gate', { label: 'Gate' }); m.remove();`;
content effects can add them too: `{ marker: 'gate' }` / `{ clearMarker: 'gate' }`. A counter in the screen corner:
`engine.hud.addCounter('slimes', { label: 'Slimes', value: 2, max: 3 })`; `anchor: 'top-right'` (or `top`, `bottom`, `bottom-left`...) puts a counter
or bar in that screen column.

## 3. Verify
- `npm run check`: a wrong item / flag / place name / NPC id in a step is an error; "flag is only checked but never set" is a warning. After
  `npm run map`, GAMEMAP.md has the quest step table.
- `describe().quests`: `active: [{ id, title, step: current step text }]`, `done: number completed`, `failed: number failed` (in describeText it is a
  `quests: {...}` line).
  In more detail: `engine.quests.list()` (each step has `current/done/target`), `engine.quests.isActive(id)`; story flags in `engine.vars.flags`.
- Objective markers: `describe().hud.markers` has `{ label: quest title, distance: meters, onScreen }`; counters are in `describe().hud.counters`.
- After advancing a condition you don't have to wait: `engine.quests.check()` checks immediately.

## Reading and moving progress from code
A step the game finishes from its own code (a cutscene ended, a fight was won) can skip its condition: `engine.quests.advance(id)` moves to the next step
and completes the quest after the last one (reward, `quest:done`); call it from an op or a fixed step. A replacement quests module meets
`modules/gameplay/quests.contract.js` (define / start / advance / state / list, events quest:start / quest:step / quest:done, save key quests).
