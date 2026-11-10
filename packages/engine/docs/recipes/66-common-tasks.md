# Common tasks, complete

> **Covers:** common tasks as whole files that a test runs.
> **Use when:** you want a complete working example to copy.
> **Shortest:** the section for your task, printed by `threedog how`.
> **Sections:** Pickup something to take · Custom picture piece your · Saved game value a · Input action your own · Rain effect weather with · Custom NPC behaviour your · Custom path source paths · Two areas built in · Climb a ladder your · In an existing game · In an existing game · In an existing game · In an existing game · In an existing game

The most asked tasks, each as one short whole file: the modules it needs, the definitions, the input, then a check that also shows the cleanup. `threedog how` prints these sections whole, and a test runs every block, so they cannot go stale.
The sections "In an existing game" hold only the lines to add to a game that runs, with where they go, what to skip if it is there, the failure to handle and the check; `threedog how` prints them when it finds a game. They are a starting point, not the only way: each ends with the next route. Names like `gem` and `pace` stand for yours. The second block of a section runs on the live page with `threedog js --file <file>`.

## Pickup: something to take that goes in a bag
```js
import { createEngine, presets, world, collision, characters, inventory, pickups, interactions } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view'), bindings: { ...presets.bindings.walk, ...presets.bindings.interact } });  // interact is E
engine.use(world(), collision(), characters(), inventory(), pickups(), interactions({ ...presets.interactions.nearest }));
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });
engine.inventory.define('gem', { name: 'Gem' });
engine.pickups.spawn([1, 0, 0], { give: 'gem', id: 'gem-1' });
Object.assign(window, { engine });
await engine.start();
```
```js
step(0.2);
engine.input.simulate('interact', true); step(0.1); engine.input.simulate('interact', false); step(0.1);
expect(engine.inventory.count('gem'), 'E takes it').toBe(1);
const left = engine.pickups.spawn([3, 0, 0], { give: 'gem', id: 'gem-2' });
left.remove();  // cleanup: data and model go together
assert(!engine.world.get('gem-2'), 'a removed pickup is gone');
```
**When it does not fit:** a mesh you already have and a number on screen, with no bag: `engine.interactions.add(mesh, { once: true, counter })`, recipe 03 "Pick and count".

## Custom picture piece: your own three.js in the scene
```js
import { createEngine, THREE } from 'threedog';

const lantern = () => ({ name: 'lantern', type: 'picture', install(e, ctx) {
  const glow = new THREE.PointLight(0xffcc88, 2, 12);
  glow.name = 'lantern-glow';
  e.scene.add(glow);
  ctx.track({ remove() { e.scene.remove(glow); glow.dispose(); } });  // leaves with the piece
  ctx.track(e.onRender(() => { glow.intensity = 2 + Math.sin(e.time.tick / 20) * 0.2; }));
} });

const engine = createEngine({ canvas: document.getElementById('view') });
engine.use(lantern());
Object.assign(window, { engine });
await engine.start();
```
```js
step(0.1);
assert(engine.scene.getObjectByName('lantern-glow'), 'the piece is in the scene');
await engine.unuse('lantern');  // cleanup: what it tracked leaves with it
assert(!engine.scene.getObjectByName('lantern-glow'), 'the piece took its light away');
```
**When it does not fit:** one author and one look: put it in `picture/` and call it from `picture/index.js`, recipe 62. No module is needed to add a mesh: `engine.scene.add(mesh)` is plain three.js.

## Saved game value: a number that survives a reload
```js
import { createEngine } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view') });
const best = { score: 0 };
engine.saves.define('best', { version: 1, save: () => ({ ...best }), load: d => { best.score = d.score; } });
engine.onFixed(() => { best.score += 1; });
Object.assign(window, { engine, best });
await engine.start();
```
```js
step(0.1);
await engine.saves.save('check');
const kept = best.score;
step(0.5);
assert(best.score > kept, 'the value moved on');
await engine.saves.load('check');
expect(best.score, 'the save brought it back').toBe(kept);
await engine.saves.remove('check');  // cleanup: the test slot; the part itself lasts as long as the game
```
**When it does not fit:** a preference (volume, language) is not game state: `localStorage` with `engine.saves.storageKey(name)`. A best time that outlives every save: recipe 20. A value several systems change: `engine.mod`, recipe 55.

## Input action: your own key
```js
import { createEngine } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view'), bindings: { dash: ['KeyQ', 'PadX'] } });  // the game binds keys, the player can rebind them
const dashes = { n: 0 };
const action = engine.input.define('dash', { label: 'Dash' });
const reader = engine.onFixed(() => { if (engine.input.pressed('dash')) dashes.n++; });  // gameplay reads in the fixed step
Object.assign(window, { engine, dashes, leave: () => { reader.remove(); action.remove(); } });
await engine.start();
```
```js
engine.input.simulate('dash', true); step(0.1); engine.input.simulate('dash', false); step(0.1);
expect(dashes.n, 'one press, one dash').toBe(1);
expect(engine.input.isUnbound('dash'), 'it has a key').toBe(false);
leave();  // cleanup: the reader and the action go; in a module, ctx.input takes them with it
```
**When it does not fit:** a key only inside a vehicle or menu: a context, `engine.input.push`, recipe 58 §2. A text field keeps its own browser listener.

## Rain effect: weather with its particles
```js
import { createEngine, calendar, sky, weather } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view') });
// the table is the game's: without one only a calm 'clear' exists (presets.weather.temperate has seven types)
engine.use(calendar(), sky(), weather({ types: { clear: {}, rain: { rain: 1, cloud: 0.8 } }, rain: { count: 500 } }));
Object.assign(window, { engine });
await engine.start();
engine.weather.set('rain', { seconds: 0 });
```
```js
step(0.2);
expect(engine.describe().weather.name, 'it rains').toBe('rain');
assert(engine.describe().weather.rain > 0, 'the rain is falling');
engine.weather.set('clear', { seconds: 0 });  // cleanup: the module stays, the rain stops
step(0.2);
expect(engine.describe().weather.name, 'it stopped').toBe('clear');
```
**When it does not fit:** a rain that is not weather (a burst in one room, a fountain): `particles()`, recipe 64, or your own three.js `Points`. Your own drawing of the weather table: `weather.defineField`, recipe 44.

## Custom NPC behaviour: your own rule for what it does
```js
import { createEngine, world, collision, characters } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view') });
engine.use(world(), collision(), characters());
engine.npcs.behavior('pace', {  // what must be remembered goes in rec.mind: plain values, saved with the NPC
  near(rec, dt) { rec.mind.walked = (rec.mind.walked ?? 0) + dt; },
  far(rec, dt) { rec.mind.walked = (rec.mind.walked ?? 0) + dt; },
});
engine.npcs.add({ id: 'guard', name: 'Guard', position: [2, 0, 2], behavior: 'pace', mind: {} });
Object.assign(window, { engine });
await engine.start();
```
```js
step(0.5);
assert(engine.world.get('guard').mind.walked > 0, 'the behaviour runs');
engine.npcs.remove('guard');  // cleanup: the data, the model and its interaction go together
assert(!engine.npcs.get('guard'), 'the NPC is gone');
```
**When it does not fit:** a daily route needs no code: `schedule` or `behavior: 'wander'`, recipe 02. Something that is not a person (a crowd of birds): recipe 65, or your own objects and `engine.onFixed`.

## Custom path source: paths that do not come from the ground
```js
import { createEngine, world, collision, characters } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view') });
engine.use(world(), collision(), characters());
Object.assign(window, { engine });
await engine.start();
// a list of points, null for no way, 'walk' for the built-in search
window.rails = engine.mod('characters.path', { owner: 'rails', set: ({ from, to }) => [from, { x: to.x, y: 0, z: from.z }, to] });
```
```js
const path = engine.characters.findPath({ x: 0, z: 0 }, { x: 4, z: 4 });
expect(path.length, 'the source answered').toBe(3);
expect(path[1].x, 'through its corner').toBe(4);
rails.remove();  // cleanup: the built-in search answers again
assert(JSON.stringify(engine.characters.findPath({ x: 0, z: 0 }, { x: 4, z: 4 })) !== JSON.stringify(path), 'the source no longer answers');
```
**When it does not fit:** walking around obstacles on the ground needs no source: `engine.characters.findPath`, or `nav()` for a navmesh, recipe 12. One character only: give the entry an `id`.

## Two areas built in code: the engine remembers which one
```js
import { createEngine, world, collision, characters, level, THREE } from 'threedog';

const engine = createEngine({ canvas: document.getElementById('view') });
const floor = size => new THREE.Mesh(new THREE.BoxGeometry(size, 1, size).translate(0, -0.5, 0), new THREE.MeshStandardMaterial());
// a name in the manifest is what a save remembers, and its builder is how the area comes back: nothing else to wire
engine.assets.manifest({ models: { house: () => floor(20), outpost: () => floor(40) } });
engine.use(world(), collision(), characters(), level({ url: 'house' }));
engine.characters.addPlayer({ control: () => null, spawn: [0, 0, 0] });
Object.assign(window, { engine });
await engine.start();
```
```js
await engine.level.load('outpost'); step(0.1);
engine.player.placeAt([15, 0, 0]);
await engine.saves.save('check');
await engine.level.load('house'); step(0.1);
expect(engine.world.zone, 'walked back').toBe('house');
await engine.saves.load('check'); step(0.1);
expect(engine.world.zone, 'the save went back by itself').toBe('outpost');
expect(engine.player.position.x, 'with the player where it stood').toBe(15);
await engine.saves.remove('check');  // cleanup: the test slot
```
**When it does not fit:** `level({ scene })` takes an object with no name, so a save cannot rebuild it: fine for a game with one area. Records with `zone: 'outpost'` show only there, recipe 07. Changing area in play: `engine.flow.transition`, recipe 07.

## Climb a ladder: your own movement, kept when loading mid-climb
```js
import { createEngine, world, collision, characters } from 'threedog';
const engine = createEngine({ canvas: document.getElementById('view'), audio: { sounds: { rung: { src: 'footstep' } } } });
engine.use(world(), collision(), characters(), { name: 'ladder', afterLoad: () => grip() });  // after a load: the hold of the save, or none
engine.setGround({ height: (x, z) => z > 1 ? 3 : 0, slope: () => 0, type: () => 'wood' });  // the upper floor starts at z = 1
const player = engine.characters.addPlayer({ control: () => null, spawn: [0, 0, 0] });
let hold = null;  // running code, so no save keeps it: the record field does, and grip puts the hold back
const grip = () => { hold?.remove(); hold = engine.world.get('player').climbing ? engine.control.take(player, { owner: 'ladder', step: (dt, ch) => (climb(dt, ch), false) }) : null; };  // false: placed by hand, no mover, no gravity
const climb = (dt, ch) => {
  const y = ch.root.position.y += 1.5 * dt;
  if (y % 0.5 < 1.5 * dt) engine.audio.sfx('rung', { at: ch.root });
  ch.syncRecord(); engine.characters.kit.ownState(ch, 'climb', 1.5);  // the position is saved with the record, the state picks the animation
  if (y >= 3) { engine.world.set('player', { climbing: false }); grip(); ch.placeAt([0, 3, 2]); }
};
engine.ops.define('ladder.climb', { run: e => { e.world.set('player', { climbing: true }); grip(); } });
Object.assign(window, { engine }); await engine.start();
```
```js
engine.ops.run('ladder.climb'); step(1);
const rung = engine.player.position.y;
assert(rung > 1 && rung < 3, 'halfway up');
await engine.saves.save('check');
step(2);
expect(engine.player.position.z, 'stepped off at the top').toBe(2);
expect(engine.control.of(engine.player).owner, 'the keys are back').toBe('player-input');
await engine.saves.load('check');
expect(engine.player.position.y, 'back on the rung').toBe(rung);
expect(engine.control.of(engine.player).owner, 'holding on again').toBe('ladder');
step(0.5);
assert(engine.player.position.y > rung, 'and the climb goes on');
step(2);
expect(engine.player.position.y, 'to the top').toBe(3);
await engine.saves.remove('check');  // cleanup: the test slot; the climb ended itself and took its hold away
```
**When it does not fit:** climbing with the up and down keys, or a climb animation clip: recipe 57 "a ladder". A climb that stops for a cutscene: a higher `layer` pauses this hold, recipe 57. Your own way of moving for a whole game (flying, swimming): your own mover, recipe 57.

## In an existing game: pickup
```js
// main.js imports: add the ones it lacks. engine.use goes before engine.start(); a module it already has is ignored with a warning, so drop those
import { presets, world, collision, characters, inventory, pickups, interactions } from 'threedog';
engine.use(world(), collision(), characters(), inventory({ capacity: 1, defaultStack: 1 }), pickups(), interactions({ ...presets.interactions.nearest }));
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });  // only if there is no hero yet
// where the level is set up
engine.inventory.define('gem', { name: 'Gem' });
engine.pickups.spawn([1, 0, 0], { give: 'gem', id: 'gem-1' });
// giving by hand: the answer is an object, so read .ok; if (inventory.add(...)) is true even when the bag is full
const given = engine.inventory.add('gem');
if (!given.ok) console.warn('bag full', given.code);
```
```js
expect(engine.inventory.add('gem').ok, 'a second gem does not fit').toBe(false);
step(0.2);
engine.input.simulate('interact', true); step(0.1); engine.input.simulate('interact', false); step(0.1);
assert(engine.world.get('gem-1'), 'with a full bag it stays on the ground');
engine.inventory.remove('gem');  // cleanup: the bag as it was
```
**When it does not fit:** it reuses what your game has: the whole file is "Pickup" above. Items in your own data: `inventory.define` takes them from `content/`, recipe 03.

## In an existing game: saved value
```js
// beside the system that owns the value, once, before the first load. A module's own state saves itself: this is for yours
const tally = { score: 0 };
engine.saves.define('tally', { version: 1, save: () => ({ ...tally }), load: d => { tally.score = d.score; } });
// at a checkpoint or a menu: false means nothing was written, so say "saved" only after true
const saveTally = async () => { if (!await engine.saves.save('slot1')) console.warn('not saved'); };
```
```js
tally.score = 7;
await saveTally();
tally.score = 0;
expect(await engine.saves.load('slot1'), 'it loads').toBe(true);
expect(tally.score, 'the value came back').toBe(7);
await engine.saves.remove('slot1');  // cleanup: the test slot
```
**When it does not fit:** a part that changes shape later needs a `migrate`: recipe 20. A preference is no game state: `localStorage`.

## In an existing game: press a key on a thing
```js
// main.js imports and engine.use, as in the pickup above. The key is the 'interact' action in your bindings
import { presets, world, collision, characters, interactions } from 'threedog';
engine.use(world(), collision(), characters(), interactions({ ...presets.interactions.nearest }));
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });  // only if there is no hero yet
// where the level is set up: a mesh of yours, or a position
const door = { open: false, locked: false };
const spot = engine.interactions.add([1, 0, 0], { onUse: () => { if (door.locked) return { ok: false, code: 'locked' }; door.open = true; } });
```
```js
step(0.2);
engine.input.simulate('interact', true); step(0.1); engine.input.simulate('interact', false); step(0.1);
assert(door.open, 'E opens it');
spot.remove();  // cleanup: the handle ends it with the door
```
**When it does not fit:** something that happens by walking in, with no key: `triggers()`. Clicking with the mouse: `engine.rays`, recipe 19.

## In an existing game: after a delay
```js
// no setup: the clock is in every engine and stops when the game pauses, setTimeout would run on
const flags = { late: false };
const timer = engine.clock.after(2, () => { flags.late = true; }, { channel: 'real' });
// called off: timer.remove(). A function does not survive a load: pass an event name if the wait must
```
```js
step(2.1);
assert(flags.late, 'it ran in game time');
timer.remove();  // cleanup: removing it twice is fine
```
**When it does not fit:** hours and days of a calendar: `calendar()`, recipe 06. A menu or a sound that must run while paused: frame seconds (`onFrame` dt), recipe 06.

## In an existing game: steer the hero for a moment
```js
// main.js imports and engine.use, as in the pickup above; a hero must exist
import { presets, world, collision, characters } from 'threedog';
engine.use(world(), collision(), characters());
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });  // only if there is no hero yet
// from your own rule: a hold outranks the keys until it ends, so never write the hero's position each frame
const dash = () => { const hold = engine.control.take(engine.player, { owner: 'dash', layer: 'script', step: () => ({ x: 0, z: 1, run: true }) }); engine.clock.after(0.4, () => hold.remove(), { channel: 'real' }); };
```
```js
step(0.2);
const from = engine.player.position.z;
dash();
step(0.3);
assert(engine.player.position.z !== from, 'the hold moved the hero');
step(0.3);  // cleanup: the hold ended by itself
expect(engine.control.of(engine.player).owner, 'the keys are back').toBe('player-input');
```
**When it does not fit:** a whole new way of moving: "Climb a ladder" above. A car or a ship: recipe 11. Who holds what: recipe 57.
