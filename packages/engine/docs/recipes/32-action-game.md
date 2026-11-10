# Action game wiring: hp, attacks, guns, enemy AI, drops, death, win and lose without engine combat rules

> **Covers:** an action game's own rules: health, attacks, guns, enemy AI, drops, win and lose.
> **Use when:** combat on top of the engine's systems.
> **Shortest:** the working example `examples/action/` (§1 says what goes where).
> **Sections:** 1 What goes where · 2 Rules that keep · 2b Guns hitscan shots · 3 Mouse attack and · 4 Movement jumps, speed

The engine has no health, damage, hit detection or death. An action game writes those as its own rules on top of systems that already exist. The
working example is `examples/action/` (page `/action.html`, the rules in `main.js`, the room in `content/`).

## 1. What goes where
| Piece | Built on | In the example |
|---|---|---|
| The room, the enemy and its stats (hp, damage, drop) | content `templates` + `props` with ids (recipe 30) | `content/templates.js` `slime: { model, static: false, state: { hp, maxHp, damage, cooldown, drop } }` |
| Player hp, attack cooldown, game over | plain object + `engine.describe.add` + `engine.saves.define` | `const game = fresh()` |
| Attack, damage, enemy hit, death | ops with `can` / `run` (recipe 23), so keys, the dev bridge, MCP, tests and the AI run one rule | `player.attack`, `enemy.damage`, `enemy.attack`, `player.die` |
| Enemy AI (chase, face, strike) | `engine.world.simulate(kind, { near, channel? })` (channel: bullet time reaches it, section 4), a fixed step per near record; it strikes with `ops.run(..., { actor: rec.id })` | `world.simulate('slime', ...)` |
| Gameplay keys | content `actions` (`attack: { keys: ['Mouse0', 'KeyF'] }`), read with `input.pressed` in `onFixed` | `onFixed` runs `player.attack` |
| Drop | `engine.pickups.spawn(at, { give: item, id })` inside the death op; E picks it up through `interactions`, into the bag of whoever presses | `${id}-drop` |
| HUD, death screen, retry, save keys | `onFrame`: `hud.bar`, `toast`, `engine.session.newGame()` | the frame hook |

## 2. Rules that keep it replayable
- Damage, cooldowns and AI run in fixed steps or ops only (`onFixed`, `world.simulate`, `ops.run`), never in `onFrame`, so the result is the same at
  any frame rate and a save loads bit-identical.
- An enemy that dies is `world.remove(id)`: the save remembers it is gone. A per-step value (the enemy's cooldown) is written straight onto the record
  inside `simulate` or an op; a discrete one (its hp) goes through `world.set`.
- Hit detection is the game's: the example tests distance and the angle against the actor record's `facing`; a game with swords on bones would raycast
  or test shapes instead (recipe 19).
- `player.die` decides what death does. The example offers `respawn` (`player.placeAt(spawn)`, full hp), `restart` and `gameover` (both end in
  `engine.session.newGame()`, which is async flow and so runs from the frame hook, not inside the op).
- What a fight sets up, falling undoes. `respawn` leaves the world as it was, so a closed arena gate, a blocked area, a locked camera or a boss phase is still there when the player returns, and a spawn point can end up inside ground that is no longer walkable. Keep one function that undoes the fight and call it from `player.die`; a win calls it too.
- A blow that ends a contact ends it for both sides: a stomp, a dash through or a parry needs a short window in which that enemy cannot hurt the player, or its touch damage lands the step after. Each of these gets a scenario that loses and one that wins (recipe 16 section 2b).
- Win and lose are the game's rule too: one state field, judged last in the fixed step so it sees this step's hits. The end screen is a `makeWindow`
  with `closable: false` (recipe 26).

## 2b. Guns: hitscan shots, spread, recoil
A hitscan weapon fires a ray, not a projectile (many real bullets in flight are `engine.swarm`, recipe 65). The shot is an op, so a key, a test and the dev bridge fire the same one.
- **The ray**: `engine.raycast(origin, direction, { far: range })` gives the nearest level or registered static mesh; `{ targets: 'all' }` adds rigid bodies.
  An enemy that is neither: test its shape along the same ray and keep the nearer hit, so walls stop shots.
- **Aim**: build the direction from `engine.cameraRig.yaw` / `pitch`, not from `engine.camera`: the camera's matrix is only written on a drawn frame, so a fixed step or a test would read an old aim.
- **Spread**: bend the direction with `engine.random`, so a replay fires the same shots.
- **Recoil**: in the op, add to `cameraRig.pitch` and `yaw`, and let the view settle back in `onFixed`; the next shot's aim sees the climb. A first-person rig looks up with positive pitch, the follow camera with negative. The gun model's kick and the muzzle flash read the shot from an event in `onFrame`: they show, they change no rule.

## 3. Mouse attack and pointer lock
`followCamera({ ...presets.camera.overShoulder })` locks the mouse on a click. While locked, mouse buttons still arrive as `Mouse0`..`Mouse4` keys, so
`attack: { keys: ['Mouse0'] }` works in both states. The click that takes the lock is swallowed, so it does not swing; `swallowLockClick: false` delivers it.
`presets.player.aim` turns the player toward where the camera
looks, so a swing goes where you aim. The rules do not need the picture: `?picture=none` runs them under the engine's placeholder lights; the whole picture is
`examples/action/picture/`.

## 4. Movement: jumps, speed effects, bullet time, platforms, falling
```js fragment
engine.characters.addPlayer({ ...presets.player.thirdPerson, maxJumps: 2 });  // double jump: the same jump key twice
engine.player.launch(16, { owner: 'pad' });  // a jump pad / spring
engine.mod('move.speed', { owner: 'haste', id: 'player', mul: 1.2, for: 5 });  // haste for 5 s; no id = every character (mud, wind)
engine.time.channel('enemies');  // once, before anything uses it: a channel of your own
engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });  // bullet time: enemies on channel 'enemies' at 35%
engine.world.simulate('slime', { near: chase, channel: 'enemies' });  // world records (the enemy AI above) get the slowed dt
engine.onFixed(dt => moveShots(dt), { channel: 'enemies' });  // your own enemy logic on the same slowed dt
engine.characters.support(liftMesh);  // a moving platform: move liftMesh any way, riders follow
engine.player.mover = 'manual'; /* a cutscene, your own physics */ engine.player.mover = 'simple';  // take over, give back
```
- **Jumps** (all public, no private fields): `jump()` is buffered for `jumpBuffer` s (default 0.12) and uses coyote time (`coyoteTime`); in the air it is an
  air jump while `maxJumps` allows, at `airJumpSpeed` (default `jumpSpeed`). `jump({ air: false })` = ground only. `addJumps(n)` / `resetJumps()` for
  pickups and wall touches, `launch(speed, { owner })` for jump pads (emits `character:launch`), `jumpState()` reads `{ grounded, coyoteLeft,
  bufferLeft, jumpsUsed, jumpsLeft, vy }`. `character:jump` carries `{ air, index }`. Writing `player.vy` yourself is fine: it is an impulse.
- **Speed, gravity, jump height, can-jump**: the fields (`player.speed = 6`) are the game's base values; effects go through `engine.mod('move.speed' |
  'move.runSpeed' | 'move.gravity' | 'move.jumpSpeed' | 'move.canJump', { owner, id?, set | add | mul | clamp, for? })`, so stamina (run = walk), haste
  x1.2 and mud x0.6 combine and end in any order. `player.stat('speed')` reads the result. A stun: `engine.mod('move.canJump', { owner: 'stun', id:
  'player', set: 0, for: 0.8 })`. `move()` takes no speed argument; the direction's length (0-1) scales the speed.
- **Bullet time / time channels**: a character the engine drives moves and animates on `character.channel` (player `'player'`, NPCs `'world'`), so
  `engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35 })` slows NPCs added with `npcs.add({ channel: 'enemies' })` (far ones too) and
  `onFixed(fn, { channel: 'enemies' })` code; world records follow only with `world.simulate(kind, { near, channel: 'enemies' })` (without it they
  keep the 'world' pace while everything else slows); `clock.after(1, 'poison:tick', { data, channel: 'enemies' })` slows a timer with them. The player keeps
  full speed unless you mod `'time.player'`. Your own `player.move(x, z, run, dt)` uses the dt you pass. Effects end in any order (recipe 55).
- **Platforms**: `characters.support(object, { id?, safe?, carry?: 'position' | 'position+yaw', inherit? })` returns `{ id, remove() }`. The rider
  compares the platform's matrix with the one it recorded, so it does not matter whether the platform moves in your `onFixed` before or after the
  player, in a timeline or in physics. `player.support` says what it stands on (`kind: 'ground' | 'platform' | 'collider' | 'water' | null`, the
  platform's `velocity`); jumping off keeps the platform's speed until landing. With `mover: 'rapier'` give the platform a collider as well.
  **What it needs**: the standing height is the top of the bounding box of every mesh under the object you pass, over that box's footprint. Pass the
  floor mesh, not the whole model: a group with a mast or a railing has its top up there, and the character passes under it to whatever is below (a
  boat at sea leaves it on the sea floor). A character gets on when its feet are at most `stepHeight` below the top, or it falls or is placed onto
  it (`placeAt` over a support stands on it). Moving the parent moves the floor mesh, so move the whole model as you like.
  ```js fragment
  const raft = new THREE.Group(), deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 2), wood);
  raft.add(deck, mast); engine.scene.add(raft);
  engine.characters.support(deck, { id: 'raft' });  // the deck, not the raft with its mast
  engine.onFixed(dt => { raft.position.x += 1.5 * dt; });  // the player on it is carried
  ```
  A ride the player does not steer is `engine.control` instead (recipe 57, Moved by script).
- **Falling out**: `addPlayer({ ..., fall: { belowY: -20 } })` fires `character:fall { character, safe }` once. Take hp in the listener. The rule `fall` decides what happens: `engine.mod('fall', { owner: 'game', set: 'rescue' })` (or `characters({ fall: 'rescue' })`; `openWorld` and the new-game templates choose it) puts the player back on `player.safeGround`, the last spot it stood still on safe, unmoving ground (saved); `set: false` handles it yourself, a function `(facts, engine) => 'rescue' | false` decides per fall (`facts.kind` is `'character'` or `'body'`), and without `id` it covers everything that falls, rigid bodies below y = -200 too.
- **Your own controller**: `mover: 'manual'` = you write the position; `move()` then only updates `grounded`, `support` (platforms still carry),
  `safeGround` and the fall check. Switch at any time (`player.mover = 'manual'` / `'simple'`): a cutscene, a grapple, a ladder.
- **Knockback / dashes**: `player.push(vx, vz, seconds)`. Writing `player.velocity` or `player.vy` is an impulse: the mover keeps integrating from
  it next step (horizontal velocity is then steered back toward the input), so it never fights you; for full control use `mover: 'manual'`.
