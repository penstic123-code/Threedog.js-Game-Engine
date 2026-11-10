# Adding an NPC (schedule + dialogue)

> **Covers:** people with schedules, dialogue, avoidance and behavior of your own.
> **Use when:** a character the player meets or talks to.
> **Shortest:** an entry in content data plus `characters()`, `interactions()`, `dialogue()` (§1).
> **Sections:** 1 Write data recommended) · 2 Add in code · NPC data and model · Changing behavior / custom · Avoidance NPCs don't clump · A guard you build · Pick a dialogue choice · 3 Verify · Talking in a bubble

Modules needed: `characters()` (NPCs on by default), `interactions({ ...presets.interactions.nearest })`, `dialogue()`; clock-time schedules need
`calendar()` with a day cycle (`dayLength`, e.g. `presets.calendar.cycle`: without one the clock never moves and the NPC keeps to one stop). `openWorld()`
installs `characters()` and the calendar but not the other two: `engine.use(openWorld({ camera: 'follow', calendar: presets.calendar.cycle, ...}),
interactions({ ...presets.interactions.nearest }), dialogue(), content())`.

## 1. Write data (recommended)
`games/<game>/content/npcs.js`:
```js
export default {
  guard: {
    name: 'Gate guard',
    colors: { body: 0xc89a5a, legs: 0x5b4a3a, hair: 0x3a2a1a },  // omit to use the default colors
    start: { place: 'home', x: 6, z: -3 },  // starting position; omitted = the first stop of the schedule
    schedule: [  // at is a clock time 'HH:MM'; at that time the NPC walks there (pathfinding is automatic)
      { at: '07:00', place: 'home', x: 6, z: -3 },
      { at: '13:00', place: 'tower' },
      { at: '18:30', place: 'home', x: 2, z: 4 },
    ],
    interact: { op: 'npc.talk' },  // the interact key nearby talks: dialogue 'guard' (the NPC id) in dialogues.js
  },
  cat: { name: 'Cat', start: { place: 'home' }, behavior: 'wander', mind: { radius: 6 } },  // no schedule: write behavior + start, omit schedule
};
```
A content NPC takes every `npcs.add` option (`speed`, `interact`, `arriveDistance`, `pathStep`, `repath`, `model`...) written as a
field; a misspelt one errors with the closest name. `start` and `schedule` are the content forms (clock strings, places); the key is the id.
`interact` is what the interact key does near the NPC: the op it runs with `{ npc: id, ...args }`. Dialogue is the op `npc.talk` (script = the
NPC id, or `args: { script }`); a shopkeeper, recruiter or healer names its own op: `interact: { label: 'Trade', op: 'shop.open', args: { shelf: 'tools' } }`
(`radius` default 3.2 m).
`content/dialogues.js`:
```js
export default {
  guard: {
    speaker: 'Gate guard',
    nodes: {
      start: {
        text: [  // several variants: the first whose condition holds is used
          { if: { flag: 'metGuard' }, text: 'Back again?' },
          { text: 'Halt. First time here?' },
        ],
        do: { setFlag: 'metGuard' },
        next: 'ask',
      },
      ask: { text: 'A pass costs one coin.', choices: [
        { text: 'Buy one', next: 'buy', if: { has: { coin: 1 } } },
        { text: 'No thanks' },  // a choice with no next = the dialogue ends; a plain node with no next waits for one more interact press, then ends
      ] },
      buy: { text: 'Move along.', do: [{ take: { coin: 1 } }, { give: { pass: 1 } }], next: 'end' },
    },
  },
};
```
The words usable in conditions / effects are in the last section of `../api/content.md` (flag notFlag has lacks counter can / setFlag
give take bump startQuest toast particles marker clearMarker op). A game's own action is an op, always written as a pair `[name, args]` (a bare
name string is rejected): `do: { op: ['delivery.done', { parcel: 'p1' }] }` (`23-ops.md`).
The items used (coin, pass) must be defined in `items.js`, otherwise validation fails. A `place` name comes from `content/places.js`, `content.load(data, { places })` or
from a level marker (such as `npc_guard`). Add a new content file to `content/index.js`.

## 2. Add in code (temporary NPCs, dynamic schedules)
```js
engine.dialogue.define('passerby', { start: { text: 'Nice day.', speaker: 'Passerby' } });
const npc = engine.npcs.add({ id: 'passerby', name: 'Passerby', position: [10, 0, 5], schedule: [{ at: '08:00', position: [20, 0, 5] }], interact: { op: 'npc.talk' } });  // at: 'HH:MM' or 0-1; without id the name is used
engine.npcs.remove('passerby');  // remove by id, name or handle
```

**An NPC that stands still** (a quest giver): give `start` and omit both `schedule` and `behavior`; the default `schedule` behavior with no stops
has no goal, so it stays at `start`: `elder: { name: 'Elder', start: { x: 4, z: 6 }, interact: { op: 'npc.talk', args: { script: 'elder-hello' } } }`.

## NPC data and model (why npc.root is sometimes null)
The fact of an NPC is one record in the world data `engine.world` (kind `'npc'`, the id is the id above / the key in content): position, schedule,
current stop, in-dialogue, animation state and movement state are plain fields and are saved.
The character model is just an appearance built only near the player (world radius, default 60 meters): removed when you walk away and rebuilt when
you come near; changing level only removes the model, and it is rebuilt automatically when you return to that level.
- `npcs.add` returns a **handle**: `npc.data` (the record), `npc.position` (the model position when there is a model, otherwise the data position),
  `npc.character` / `npc.root` (the current model, `null` if none), `npc.placeAt(p)`, `npc.remove()`.
- **Arrival tolerance**: within 1.2 meters of a stop (`arriveDistance`, default 1.2, can be set per NPC) counts as arrived and the NPC stops, without
  stepping exactly on the stop center; for an exact position put the stop a bit away from obstacles, or `placeAt` yourself.
- Far away with no model, an NPC follows its schedule in a straight line (stops at the stop if reachable, otherwise on the line); when it comes back,
  the model is built at the computed position; nearby it paths around obstacles as usual.
- Add things to the model (a hat, a name tag) after every model build; don't call `npc.root.add(...)` right after add (the first model is built in the
  next fixed step; for one immediately use `engine.world.refresh()`).
- Looking at the player: `npc.character.anim.addAim({ bones: ['Neck', 'Head'], target: engine.player.root })`, added with the rest of its model ([13 §3e](13-animation.md)).
- When two NPCs share a name, give each an `id` (without an id the name is the id, and in development a duplicate name throws). NPCs in content are
  the world's **initial data**: the save records only changes such as position and state; schedule and name follow the content.
- Change data with `engine.world.set(npc.id, { mood: 'happy' })` (emits the world:change event); only plain values go in the data, models and
  functions stay in code.

## Changing behavior / custom behavior
What an NPC "does" is a swappable **behavior**: the `behavior` field in the data picks it, and the schedule (`'schedule'`, the default) is just one of
them. Built in there is also `'wander'` (random wandering near home, using `engine.random`, same seed same result).
```js
npc.setBehavior('wander', { radius: 12 });  // home = current position, wander within 12 meters (pause: [2, 6] pause seconds, home: { x, z } sets the center)
npc.setBehavior('schedule');  // back to the schedule
engine.npcs.add({ id: 'dog', name: 'Dog', position: [5, 0, 5], behavior: 'wander', mind: { radius: 8 } });  // wanders from the start
```
The behavior name and `mind` (the behavior's parameters and memory) are in the NPC data and are saved; after changing behavior or loading, the NPC
carries on with the new behavior. A wrong behavior name throws and lists the registered ones. NPCs in content can also write `behavior` + `mind`
directly (see the cat above); to change behavior at runtime use `npc.setBehavior`.

**An enemy that chases the player**: the `chase` behavior below is the example; the push in "Avoidance" below keeps several from piling into one clump. Things that are not NPCs
(monsters, crops) are written as world data, see recipe 18 section 5.

To write your own: `engine.npcs.behavior(name, { near(rec, dt, npc), far(rec, dt) })`, with the same rules as `world.simulate`: `near` is called once
per fixed step while nearby (`npc.character` is the model, `null` if not yet built), `far` simulates from data while far away (`dt` is accumulated
seconds and can be large; on the far -> near step `far` is used first to make up the owed time; without `far` the NPC stands still when far). The
behavior keeps no variables of its own; what must be remembered goes in `rec.mind` (plain values), otherwise it won't match after the model is removed
or after loading.
```js
// Chase the player: chase in a straight line when near, stand still within 2 meters of the player; do not chase when far. Register before npcs.add / setBehavior
engine.npcs.behavior('chase', {
  near(rec, dt, npc) {
    const p = npc.position, t = engine.player.position, dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz) || 1;
    npc.character?.move(d > 2 ? dx / d : 0, d > 2 ? dz / d : 0, false, dt);  // no model: don't move
    engine.world.move(rec.id, npc.position);  // write the position back to the data
  },
});
npc.setBehavior('chase');
```
To path around obstacles, use `engine.characters.findPath(from, to)` to get waypoints and walk them one by one (the schedule behavior does exactly
this).

## Avoidance (NPCs don't clump or pass through each other)
NPCs with models nearby avoid each other by default: when closer than the sum of two radii (`engine.movement.radius` x 2, about 0.8 meters) they push
each other apart, harder the more they overlap, at most 3 meters per second; the player counts as an obstacle that only NPCs yield to, and the
player's position is never pushed. After pushing, `engine.collision` (if installed) constrains them back to walkable ground, so they are not pushed
into walls. The built-in `schedule` and `wander` both avoid.
- Deterministic: done only in the fixed step, no random numbers, neighbors computed from the positions at the start of the step, so a load or a different
  `frameEvery` gives identical positions.
- Tune or turn off:
```js
engine.npcs.avoid.set({ radius: 0.6, strength: 2 });  // stand sparser (radius in meters), push slower (strength in meters/second)
engine.npcs.avoid.set(false);  // turn off (ghosts, crowds passing through); set(true) turns it on again
```
- Far away (no model) NPCs are simulated from data without per-NPC avoidance; a few steps after a model is built on approach they get pushed apart.
- `nav({ crowd: true })` replaces this push with Recast crowd agents: they route around obstacles along the navmesh but do not guarantee identical
  results after a load, and the player is no agent, so crowd NPCs walk through the player. The push routes around nothing and only keeps NPCs from overlapping. For replays and saves use the push; for crowds going
  around big obstacles use crowd.
- Behaviors you write are not avoided automatically: after your own `character.move`, call `engine.npcs.avoid.push(rec, npc.character, dt)` once
  (inside `near`, before writing back to the data).


## A guard you build yourself (`Character` + `walkTo`)

For a one-off (guard, pet, follower) that `schedule` / `wander` do not cover: `new Character(engine, { rig })` takes a ready body
(`{ root, body?, head?, limbs?, joints? }`), or `{ model: 'villager' }` / `{ model: ['villager', 0xcc8844] }` names a body your own asset pack registers (none ships with the engine; `humanoid` in other pages is such a name) like any character ([13-animation](13-animation.md)); call `character.animate(dt)` each frame.
`character.walkTo(target, { speed, arrive, turnRate, run })` follows `characters.findPath` on fixed steps (turns at `turnRate` rad/s, skips passed
points, re-plans when it makes no progress for `stuckSeconds`, up to `maxRepaths`). It returns a promise of `{ status }`: `'arrived'` | `'noPath'` |
`'stuck'` | `'cancelled'` (never rejects), with `remove()` to cancel.
A walk holds the character's control on layer `script` ([57-control](57-control.md)): an NPC's behaviour waits meanwhile, a cutscene pauses the
walk, and an escort quest that wants the same NPC takes control itself (`engine.control.take(npc, { owner: 'escort', step })`) instead of
editing its record.

```js fragment
const guard = new Character(engine, { rig: { root: myGuardMesh } });
engine.add(guard.root);
guard.placeAt(post);
const walk = guard.walkTo(player.position, { arrive: 1.5 });
if ((await walk).status === 'noPath') guard.face(player);  // walk.remove() cancels
```

## Pick a dialogue choice, advance, close a dialogue
The dialogue's keys go through two ops, so code, tests and the dev bridge drive it the same way a player does:
- Pick a choice: `engine.ops.run('dialogue.choose', { index })`, the 0-based index among the visible choices (bridge: `threedog op dialogue.choose index=1`).
- Advance: `engine.ops.run('dialogue.advance')` finishes typing the line, else goes on to the next node.
- Close it from code: `engine.dialogue.end()` ends the main dialogue (there is no `close()`); a choice or node with no `next` ends it by itself.

## 3. Verify
- `npm run check`: content validation catches "dialogue id does not exist", "bad clock-time format", "node next points to a missing node". After
  `npm run map` it shows up in the NPC table and dialogue graph of GAMEMAP.md.
- State: `npm run shot -- / --time 13:10 --wait 20 --describe-only`; the "nearby" list has an entry for `Gate guard` tagged as an NPC with its distance in
  meters (only listed within 30 meters; add `--pos x,z` to stand by the tower).
- Console / tests: `engine.npcs.get('guard').position`, `.currentStop()`; during a dialogue `engine.describe().ui.dialogue` = `{ speaker, text, typing, choices: [labels], selected, advance }`. `describe` shows no node or NPC id: to inspect the node, listen to `engine.events.on("dialogue:line", ({ script, node, speaker, text }) => ...)` (also `dialogue:start` / `dialogue:end`).
- E opens a conversation; only confirm (Space / Enter) advances it, unless `dialogue({ advanceActions })` adds a key. `describe().ui.dialogue.advance` names the keys. While it is open game input is locked, so E on anything else does nothing: the press is logged as a refused `interaction.use` (`inputLocked`) in `engine.ops.recent()` and `threedog test` prints it under a failed spec.
- Advancing a dialogue in a headless test (typing and "keys ignored right after opening" both run on game time): press E when near -> `engine.step(1)`
  to finish typing -> press a number key or run `engine.ops.run('dialogue.choose', { index: i })` (while typing it completes the sentence first) ->
  `engine.step(0.3)`. No real-time waiting.

## Talking in a bubble instead of a conversation
`interact: { op: 'npc.talk', args: { channel: 'bubble' } }` (code or content) makes the interact key play the NPC's script as bubble lines over its head while the player keeps
moving (a shopkeeper's greeting, a guard's warning); the default `'main'` opens the conversation that locks input. Choices need `'main'`.
