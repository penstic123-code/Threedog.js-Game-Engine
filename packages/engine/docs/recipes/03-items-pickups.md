# Adding items and pickups

> **Covers:** items, pickups, the inventory, single pieces, containers and shelves.
> **Use when:** things the player picks up, carries, uses or stores.
> **Shortest:** `engine.interactions.add(mesh, { id, label })` on your own mesh, or items as data (§1).
> **Sections:** Pick and count meshes · Items and pickups · 1 Write data recommended) · 2 In code dynamic · Single pieces durability, upgrade · Limits all optional, none · Using and dropping ops) · The inventory window UI · Chests / corpses / · 3 Verify

## Pick and count: meshes you built, no bag
Shells on a beach, four kinds of flowers, letters to collect: things the player takes and a number goes up. `interactions()`, `hud()` and a key (`createEngine({ bindings: presets.bindings.interact })`: E) are enough:
```js fragment
engine.hud.addCounter('shells', { label: 'Shells', value: 0, max: 4 });  // at setup, not on session:start
shells.forEach((shell, i) => engine.interactions.add(shell, { id: `shell-${i}`, label: 'Pick up', once: true, counter: 'shells', onUse: () => engine.audio.sfx('pick') }));
```
`once` hides the mesh after a use (`onUse` returning `{ ok: false }` leaves it; an async `onUse` is judged when it settles, and a throw leaves it too); `counter` adds 1 through `engine.hud.bump(name, n)`, and does nothing without
`hud()`. Both are saved and go back on a new game. The save knows a thing by `id`, else `mesh.name`: `interactions.add` throws when it has neither, or shares one with another once item.
A hidden mesh is only hidden: a collider it had is yours to remove in `onUse`. To add up without a thing to take, call `engine.hud.bump('score', 10)` yourself.

| Use | When |
|---|---|
| `interactions.add(mesh, { once, counter })` | a mesh you already have, a number on screen, nothing to carry or spend |
| `pickups.spawn` (below) | it goes in a bag, respawns, is taken by walking into it (`auto`), is laid out in `content/`, or a net host must decide who got it |

## Items and pickups
Modules needed: `inventory()` (its window is the UI part `inventory`; the open key is the game's: `presets.bindings.inventory` is I / gamepad Y,
`inventory: []` none) + `pickups()` (things lying on the ground; needs `world()`, which `openWorld()` includes) +
`interactions({ ...presets.interactions.nearest })` (walk up to a pickup and press E). "Already picked up / how long until it grows back" is data in world and is saved with the game.

**Every actor has its own bag**: the container whose id is the actor's id (`inventory.of(actor)`): `'player'` for the local user, each net peer's actor
id on the host, an NPC's id. "The player inventory" (`inventory.add / count / list ...`) is the bag of `engine.actor`. Whoever takes a pickup gets it in
their own bag; inside an op use `inventory.of(ctx.actor)`, never a fixed `'player'`. A pickup can also give an instant effect instead of an item
(`give: (e, { actor }) => ...`), which needs no inventory at all.

## 1. Write data (recommended)
`games/<game>/content/items.js`:
```js
// Items: id -> name, icon, description. stack = how many fit in one slot (default 99; more spill into further slots), weight (optional), color = color when dropped on the ground
export default {
  mushroom: { name: 'Mushroom', icon: '🍄', desc: 'Found in the woods', color: 0xc0504d },
  coin: { name: 'Coin', icon: '🪙', stack: 99999 },  // currency: one slot however much you carry; full buying/selling in recipe 22
};
export const startItems = { coin: 3 };  // what the inventory holds at the start (optional)
```
`content/pickups.js` (a list):
```js
export default [
  { item: 'mushroom', place: 'home', x: 8, z: 3, respawn: 120 },  // respawn: after how many calendar seconds it grows back (omitted = never again)
  { item: 'coin', x: 40, z: -12, count: 5, auto: true },  // without place it is a world coordinate; count = how many at once; auto = taken by walking into it
  { item: 'sword', x: 12, z: 4, data: { durability: 60 } },  // data = this piece's own data (see "Single pieces"); radius = reach in meters (default 2)
];
```
Remember to `import items, { startItems } from './items.js'` and `import pickups from './pickups.js'` in `content/index.js` and put them in the exported object.

**Data and stable ids**: each pickup is a plain `kind: 'pickup'` record in `engine.world` (needs `world()`, which `openWorld()` includes); the model
is built only near the player and removed when far.
Id: write an `id`; without one it is `pickup:<item>:<index in the pickups array>`, which moves when an entry is inserted above it (recipe 30, "Ids").
When picked up, the record is removed from world; one with `respawn` stays and gets an `until` (calendar seconds); while waiting it has no model,
and at that time (also when far away with no model) it returns to the ground. Pickups in content are initial data, like props (recipe 18 §4).
`engine.world.remove(id)` deletes one directly.

## 2. In code (dynamic drops, custom models, instant effects)
```js fragment
engine.inventory.define('gem', { name: 'Gem', icon: '💎', color: 0x66ccff });  // shape: model: 'gemModel' (an asset name), else an asset named 'pickup:gem' / 'pickup', else a gray box (spawn { mesh } puts one object of the game's own down instead)
const gem = engine.pickups.spawn(engine.player.position, { give: 'gem', count: 1 });  // returns a handle; gem.remove() deletes data and model together
// opts.id writes a stable id (spawning again with the same id reuses the existing one)
engine.inventory.add('coin', 2);  // the local bag; { ok: true, key: 'coin', added: 2 }, or { ok: false, code: 'full' } if none fit
engine.pickups.spawn([8, 0, 2], { give: 'ammo', count: 30, auto: true, radius: 1.2 });  // taken on touch by whoever touches it (pickups.takers), no key, no prompt
engine.pickups.spawn(p, { give: (e, { actor }) => e.ops.run('hp.heal', { n: 25 }, { actor }), name: 'Medkit', model: 'medkit', auto: true });  // instant effect, no inventory needed
engine.events.on('pickup:take', ({ actor, x, z }) => engine.particles?.emit('dust', { x, y: engine.surface(x, z), z }, { count: 10 }));  // also item:add / item:remove (with container, actor) / item:use
```
The default reach is `pickups({ radius: 2 })`; each pickup can set its own `radius`. Reach is a sphere around the pickup, so a coin on a ledge less than `radius` above the player is taken from under it: give it a smaller `radius`. Taking one is the op `pickup.take { id }` (net: `'peer'`): the
interact key, auto pickups, a net client's press (sent to the host, which puts the item into that peer's bag) and tests all run it as `ctx.actor`.
A give function is not saved data: code that spawns one spawns it again on load (content and setup code do); a runtime drop gives an item id.

## Single pieces: durability, upgrade level, ammo in the magazine, freshness
An item can carry its own data (a plain object). Pieces with different data never mix; stackable pieces with equal data share an entry; a `stack: 1`
item with data is one entry per piece.
Each entry has a **key**: the item id for plain items (`'arrow'`), `'<item>#<n>'` for pieces with data (`'sword#3'`). Every call that takes an item
also takes a key.
```js
const I = engine.inventory;
I.define('sword', { name: 'Sword', stack: 1 });
const { key } = I.add('sword', 1, { data: { durability: 80, level: 3 } });  // 'sword#7' (add returns { ok: false, code: 'full' } when it does not fit)
// change it inside an op or fixed step (data objects are frozen: always pass a new one; the key stays the same)
const s = I.get(key); I.setData(key, { ...s.data, durability: s.data.durability - 1 });
I.container('chest-1', { capacity: 8 });
I.transfer('player', 'chest-1', key);  // exactly this sword; it keeps its data and key
I.container('chest-1').remove(key);  // exactly this one; I.remove('sword') takes plain ones first, then the oldest
I.define('tomato', { name: 'Tomato' });
const t = I.add('tomato', 5, { data: { quality: 2 } });  // stackable: equal data joins the same entry
I.setData(t.key, { quality: 1 }, 2);  // only 2 of that stack change: they split off under a new key (returned)
```
Data and keys are saved with the container. Which piece a player means is chosen by key (a click on a row of `list()`), so ops take `item` as an id or a key.

## Limits (all optional, none by default)
`inventory({ capacity, maxWeight })` for the player and `inventory.container(id, { capacity, maxWeight })` for others:
`capacity` = slots (an entry uses `ceil(count / stack)`), `maxWeight` = sum of item `weight` × count.

## Using and dropping (ops)
```js
I.define('potion', { name: 'Potion', consume: true, use: (e, { actor, key, data }) => heal(actor, 30), canUse: (e, { actor }) => hp(actor) < 100 || 'full' });
engine.ops.run('inventory.use', { item: 'potion' });  // runs canUse / use; consume removes one first; emits item:use
engine.ops.run('inventory.drop', { item: 'sword#7' });  // a pickup at the actor's feet, keeps its data
```
Both act on `ctx.actor`'s container (`'player'` by default).

**Replace an item when the bag is full**: `inventory.trade` takes A and gives B as one all-or-nothing step (it checks that B fits once A is gone), and
can be undone.
```js fragment
const r = engine.ops.run('inventory.trade', { take: 'rusty_key', give: 'gold_key' });  // also takeN / giveN; take may be an entry key ('sword#3')
if (!r.ok) say(r.code);  // 'notEnough' (A missing) | 'full' (B does not fit even after A leaves)
engine.ops.undo('inventory.trade', { take: 'rusty_key', give: 'gold_key' }, r.value);  // gives A back (with its data), takes B away
engine.inventory.trade('rusty_key', 'gold_key');  // the same from code; a container has .trade() too
```
**Why a pickup failed**: a pickup that does not fit fails `interaction.use` with code `full` (the item stays on the ground):
`const r = engine.ops.run('interaction.use'); if (!r.ok) say(r.code);   // 'full'`.

## The inventory window (UI part `inventory`)
`inventory({ pauseGame: true })` freezes gameplay (`engine.freeze`, the same mechanism as flow's `paused`) while the window
is open; default `false` (the world keeps running behind the window). Switchable at runtime: `engine.inventory.pauseGame = true`.

The window is a UI part (recipe 26): the engine opens and closes it (the bound `inventory` key, Esc, input lock), the part only draws
`{ title, hint, items: list(), capacity, used, weight, maxWeight }`.
```js
engine.ui.set('inventory', false);  // no window at all (the key does nothing, no DOM)
engine.ui.set('inventory', { drop: true });  // default window plus a Drop button per row (Use appears for items with use)
engine.ui.set('inventory', (engine) => {  // your own: grid, drag and drop, anything; buttons run ops with an entry's key
  const el = document.createElement('div'); engine.uiRoot.appendChild(el);
  el.onclick = ev => { const key = ev.target.dataset.key; if (key) engine.ops.run('inventory.use', { item: key }); };
  const draw = d => { el.innerHTML = d.items.map(i => `<button data-key="${i.key}">${i.def.name} ×${i.count}</button>`).join(''); };
  return { show: d => { el.hidden = false; draw(d); }, update: draw, hide: () => { el.hidden = true; }, dispose: () => el.remove() };
});
engine.ui.open('inventory'); engine.ui.close('inventory');  // open / close from code
```
The shape of an item on the ground is a model name from an asset pack, built through the same path as content props (recipe 05 §1): the item's `model`,
else a model named `pickup:<item id>`, else one named `pickup`, else a neutral gray box. A generator that returns bare geometry is drawn with
`engine.pickups.material` in the item's own `color`.
```js
engine.use(pickups({ color: 0xd8c070, size: 0.3, lift: 0.5 }));  // default color, placeholder box, height above the ground
engine.pickups.material = new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.3 });  // swaps every box and geometry-only model; used as given
```
A pickup or item with its own `color`, and a vertex-colored geometry, draw with a copy of that material carrying the color. For one object of the game's own pass
`{ mesh }` (a three.js object cannot go into a save, so after loading it falls back to the item's model).
To give / take items in content use the effect words: `{ give: { coin: 2 } }`, `{ take: { mushroom: 3 } }`; condition words:
`{ has: { mushroom: 3 } }`, `{ lacks: { coin: 1 } }`.

## Chests / corpses / shelves (multiple containers)
The player inventory is just one container (the bag of `engine.actor`). Chests, corpses, shelves and ammo boxes use `inventory.container(id, { capacity })`
to get or create one (the same id returns the same one); it has the inventory's methods plus `room(id)` and `on('add' | 'remove', fn)`.
```js
const I = engine.inventory;
const chest = I.container('chest-1', { capacity: 8 });
chest.add('bandage', 2);  // { ok: false, code: 'full' } if none fit; if part fits, that part goes in and `added` says how many
I.transfer(chest, 'player', 'bandage', 1);  // a container or a container id both work; returns how many were actually moved (fewer / 0 if the inventory is full)
I.transfer('player', chest, 'coin', 5);  // shelves and money boxes work the same way
chest.on('remove', ({ id, count, actor }) => console.log(actor, 'took', id, count));  // every container emits item:add / item:remove with { container, actor, id, key, count, total }
```
- **Relation to world**: a container id can be a world record's id directly (for example `'prop:chest:3'`, a zombie's id). Containers do not depend on
  models: a far-away chest has no model but its contents still exist; contents are saved (containers that hold something, and those that were given
  initial goods). Loading creates the containers first, and a later `container(id, { capacity })` in code just fills in the slot count, in either order.
- **Deleting a world record does not delete its container automatically** (whether to keep a searched corpse is up to the game). To clear both:
  `engine.events.on('world:remove', ({ id }) => I.removeContainer(id))`.
- **Pre-filled contents**: goods are placed only the **first** time; on load the save wins, and a searched-empty container is not refilled. Write
  `content/containers.js` (`export default { 'chest-1': { capacity: 8, items: { bandage: 2 } } }`, exported from `content/index.js`), or in code
  `I.container('chest-1', { capacity: 8, items: { bandage: 2 } })`. Don't fill with `container(id).add(...)` at startup: a container with nothing in it is
  not saved, so after a refresh it would be treated as new and filled again.
- **UI**: the engine only makes the player inventory window; for a chest UI draw `chest.list()` yourself, and clicking an entry runs
  `engine.ops.run('inventory.transfer', { from: 'chest-1', to: 'player', item: entry.key })`.
- Non-empty containers appear in `describe()` under `inventory.containers`.

## 3. Verify
- `npm run check`: an undefined item id in pickups or a missing place name is an error. After `npm run map`, GAMEMAP.md has the item table and the pickup count.
- Find the nearest of an item: `engine.pickups.nearest('berry')` (world data, found even when far); all of them:
  `engine.world.query({ kind: 'pickup' })`.
- `describe()`: `inventory.items` (key -> count, or `{ count, data }` for pieces with data), `inventory.slots`; items still on the ground appear in
  `nearby` with `kind: 'pickup'` and `id`.
  Text version: `npm run shot -- / --pos x,z --describe-only` shows the pickup entries in "nearby" and an `inventory: {...}` line.
- Simulate picking up (in tests): put the player next to the item with `engine.player.placeAt({ x, z })`, run `engine.ops.run('interaction.use')` (no
  id = the nearest interaction) after `engine.step(0.2)`, then check `engine.inventory.count(id)`. Auto pickups need only `engine.step(0.2)` with the
  player inside the radius.
