# Who steers a character: engine.control

> **Covers:** who steers a character: the control slot, script moves, vehicles, your own mover.
> **Use when:** a quest, cutscene or vehicle takes over a character.
> **Shortest:** `engine.control.take(character, { owner, step })`.
> **Sections:** Who takes what · Control is not the · Moved by script ride · Vehicles · Saves · Advanced your own mover

Every character (the player, an NPC, a hand-built `Character`) has one control slot. One owner is in charge of it at a time, and only that
owner moves the character. Take it, steer, give it back:

```js fragment
// a quest walks the guard to the gate; its schedule waits and carries on afterwards
const escort = engine.control.take(guard, { owner: 'escort', layer: 'script', step: (dt, ch) => ({ x: 0, z: 1 }) });
escort.remove();

// a roll: the keys pause for 0.4 play seconds, then come back
const roll = engine.control.take(engine.player, { owner: 'roll', layer: 'script', step: () => ({ x: 0, z: 1, run: true }) });
engine.clock.after(0.4, () => roll.remove(), { channel: 'real' });

// no step: move it from your own code; move() does nothing while someone above holds it
const h = engine.control.take(drone, { owner: 'ai', layer: 'script' });
engine.onFixed(dt => h.move(dir.x, dir.z, false, dt));

engine.control.of(engine.player);  // { owner: 'timeline', layer: 'cutscene', waiting: [{ owner: 'walkTo', layer: 'script' }, { owner: 'player-input', layer: 'base' }] }
engine.describe().control;  // the same for every held character, by id
```

What to remember:
- **Layers, lowest first**: `base` (the character's own driver: the player's keys, an NPC's behaviour) < `script` (walkTo, quest scripts, AI
  orders; the default) < `cutscene` (timeline) < `physics` (a ragdoll: nothing can steer a limp body) < `net` (another machine drives it). The highest holder is in charge.
- **A higher holder pauses the lower one, it does not cancel it.** When the cutscene ends, the walk it interrupted goes on; when the walk
  arrives, the keys work again. Nobody has to remember what to restore.
- **One owner per layer.** Two different owners on the same layer is `[control-conflict]` in every build, naming both: end the old one first
  (`h.remove()`), or take another layer. The same owner taking again just replaces its own hold.
- **A held character moves only through its holder.** `character.move()` from anywhere else is `[control-bypass]` in development: the bug where
  keys, a walk and a cutscene all pushed one body in the same step and the last one won.
- **`step(dt, ch)`** returns `{ x, z, run }` (world direction, length 0-1 scales the speed), `null` (stand still: gravity and the idle pose go on)
  or `false` (do not move this step: you placed it yourself). `dt` is the character's time channel, so bullet time slows it too.
- **Inside a module** use `ctx.control.take(ch, { ... })`: the owner defaults to the module, and everything it holds is handed back when the
  module goes (unloaded, rolled back, replaced).

## Who takes what

| Driver | Layer | Owner | Notes |
|---|---|---|---|
| `addPlayer({ control })` | base | `'player-input'` | `control` is `'camera'` or `(player, input, dt) => ({ x, z, run })`; jump and driving live here too |
| NPC behaviour (schedule, wander, your own) | base | `'npcs'` | paused near and far while anything above holds the NPC; kept by NPC id, so it survives the model being rebuilt |
| `character.walkTo(target)` | script | `'walkTo'` | paused under a cutscene (no progress, no stuck clock), resumes after |
| `timeline.play(steps, { actors })` | cutscene | `'timeline'` | `actors` defaults to `[engine.player]`; `[]` drives nobody; a `path` step adds its character. Resolves `{ ending, error? }`: `'finished'`, `'skipped'`, `'dropped'` (a load, new game or dispose took its state) or `'failed'`; `timeline:end` carries the same. While the player is an actor, the `'cutscene'` input context is up |
| `net()` | net | `'net'` | a client holds every character the host drives; the host holds each peer's avatar. Taking one is `[control-net]`: change it with an op the host runs |

Two cutscenes running at once are one owner (`'timeline'`), counted per character, so they never conflict; the slot goes back when the last
one using that character ends.

## Control is not the body

**Control** decides where to go. **The mover** (`character.mover = 'simple' | 'rapier' | 'manual'`) decides how the body gets there: integration,
collision, gravity. They never mix: a cutscene can take a character whose mover is `'rapier'`, and a `'manual'` mover can be steered by the
player's input. `mover: 'manual'` is for a game that writes the position itself; it still needs someone in control to call `move()` each
step (a `control` function returning `null` does).

## Moved by script: ride a boat, a lift, an elevator, a ladder

Move the player by script in one of three ways. Pick by what the player may still do.

| Case | Use | The player |
|---|---|---|
| A floor that moves: lift, elevator, raft, moving platform | `characters.support(deck)` (recipe 32, Platforms) | keeps walking and jumping, is carried |
| A ride on a route: boat, cable car, being carried up stairs | `engine.control.take` with `step: () => false` | steers nothing, gravity is off, your code places it |
| Climbing: ladder, rope, wall | `mover: 'manual'` plus the `states` option | moves on the axis you write, the climb clip plays |

```js fragment
// a ride: keys and gravity stop while the hold lasts; the seat is a point in the boat's own space
const seat = new THREE.Vector3(0, 0.6, 0);
const ride = engine.control.take(engine.player, { owner: 'boat', layer: 'script', step: (dt, ch) => {
  boat.updateWorldMatrix(true, false);
  boat.localToWorld(ch.root.position.copy(seat));
  ch.syncRecord();
  return false;  // placed by hand this step
} });
```
To lock the player's input during a scripted ride, one line: `const lock = engine.input.push('ride');` and `lock.remove()` at the end.
Gravity comes back the moment the hold ends, so end a ride where the character can stand: `player.placeAt(pier)` then `ride.remove()`, both in a
fixed step or an op. The camera and saves follow the position as usual.

```js fragment
// a ladder (the landing point must be ground or a registered platform, engine.characters.support; anywhere else it drops to what is below): addPlayer({ clips: { climb: 'Climb' }, states: () => climbing ? 'climb' : null }), then call this when the player uses the ladder
let climbing = false;
function climb(player, top) {  // top: { x, y, z }, where it steps off, on ground or a registered platform
  climbing = true; player.mover = 'manual';  // no gravity, the position is yours
  const h = engine.control.take(player, { owner: 'ladder', layer: 'script', step: (dt, ch) => {
    const up = (engine.input.down('moveForward') ? 1 : 0) - (engine.input.down('moveBack') ? 1 : 0);
    ch.root.position.y += up * 2 * dt;
    if (ch.root.position.y < top.y) return null;  // null: the mover runs, so states picks climb
    climbing = false; ch.mover = 'simple'; h.remove(); ch.placeAt(top);
    return false;
  } });
}
```

## Vehicles

Getting into a vehicle does not change who controls the character: the player's input (`'player-input'`) drives the car while seated. A
cutscene that takes the player while driving stops the steering; the rider stays on its seat.

Holding a car on the grid (a countdown, after the finish) is the same take, plus the brake, since a released pedal only rolls:
```js
const hold = engine.control.take(engine.player, { owner: 'race', layer: 'script', step: () => null });  // the keys stop driving
engine.onFixed(() => { if (hold.active) car.drive(0, 0, 1); });  // throttle, steer, brake
hold.remove();  // go
```

## Saves

Holds are not saved: they are running code (a walk, a cutscene, a quest step), and that code takes control again after a load. `walkTo` resolves
`'cancelled'` on whatever ends the walk: a load or new game, a level change, `placeAt`, a seat, physics taking the body, the character going. To go on, call it again.

## Advanced: your own mover (flight, swimming, wall running)

Only for a body the built-in movers cannot move. Most games stop at the sections above.

Control decides where to go, the mover decides how to move. A mover is `(character, engine) => ({ name, move(x, z, run, dt, y), dispose? })`; `y` is the up part of the direction (a control step returns `{ x, y, z }`, default 0, and `walkTo` and NPCs pass it towards the path's next point). It writes `character.root.position`.

```js fragment
const fly = (c, e) => ({ name: 'fly', move(x, z, run, dt, y) {
  const p = c.root.position, v = c.stat('speed') * dt;
  p.x += x * v; p.y += y * v; p.z += z * v;
  c.grounded = false; e.characters.kit.ownState(c, 'fly', v / dt);
} });
const held = engine.mod('character.mover', { owner: 'wings', id: 'player', set: fly });  // for a while: held.remove() puts back what was there
engine.player.mover = fly;  // or for good
```

A mover that keeps something in the physics world gives it a `leave()`: the engine calls it when another mover takes over, and `move` runs again when it is back. `mover: 'rapier'` does this, so an NPC taking off leaves no capsule behind.

Contact is opt-in: `engine.characters.kit` has `kit.beginMove`, `kit.groundAt`, `kit.endMove`, `kit.ownState`. Call `kit.beginMove` first and `kit.endMove` last to be carried by platforms and keep `safeGround` and the fall check. A mover that calls neither owns contact. The rule takes the built-in names too, and `false` means `'manual'`; it is not saved, take it again after a load. What a mover must have: `modules/characters/mover.contract.js`.
