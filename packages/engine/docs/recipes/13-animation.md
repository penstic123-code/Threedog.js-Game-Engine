# Animation state machine (skeletal animation)

> **Covers:** skeletal animation: clips mapped to game actions, skinned and sprite characters, objects that animate, look-at and foot IK.
> **Use when:** a model should move its body.
> **Shortest:** `engine.assets.animate(model, config)`.
> **Sections:** 1 The model · 2 Mapping game action · 3 A character with · 3b Procedural bodies are · 3c Sprite characters a · 3d Which modules need · 3e IK heads that · 4 Non-character objects a · 5 Gameplay controls progress · 6 Verify

There is a single entry point: `engine.assets.animate(model, config)` -> Animator (advanced every frame by the engine; never call mixer.update yourself).
For characters (player, NPCs), passing `model` builds the Animator automatically and switches clips by character state (idle walk run swim jump fall drive).

## 1. The model
Export a glTF with animations from Blender, put it in `art/models/` -> `npm run assets -- optimize` -> `public/optimized/hero.glb`. Register it and fetch a copy (the
skeleton is cloned correctly; clips are in `model.animations`, three's own place, so `model.clone()` animates too):
```js
engine.assets.manifest({ models: { hero: '/models/hero.glb', dog: '/models/dog.glb' } });
const hero = await engine.assets.model('hero');
```

## 2. Mapping: game action names -> whatever the asset calls its clips
States are the mapping. The left side is what your game says (`idle`, `attack`, `hurt`), the right side is the clip name in the file, so a new model
only changes the right side:
```js fragment
states: { idle: { clip: 'Idle_Sword' }, attack: { clip: 'Sword_Slash', loop: false }, hurt: { clip: 'HitRecieve', loop: false }, death: { clip: 'Death', loop: false } }
```
**Keep the mapping as data, on the model's manifest entry** (it describes the file, so it travels with it in an asset pack). `assets.animate(model)`
and characters start from it; config passed in code adds states and wins per state. Swapping the model then only edits its manifest entry:
```js fragment
engine.assets.manifest({ name: 'heroes', models: { hero: { url: '/models/hero.glb', animation: {
  fade: 0.2,
  states: { idle: { clip: 'Idle_Sword' }, walk: { clip: 'Walk' }, attack: { clip: 'Sword_Slash', loop: false, timing: 0.62 }, hurt: { clip: 'HitRecieve', loop: false } },
} } } });
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: 'hero' });  // no clips / animation in code
await engine.player.whenReady;
engine.assets.mapping(engine.player.anim.root);  // the entry's mapping, or null
```
A character's default names (`Idle`, `Walk`...) never shadow a mapped state, and the entry's `fade` beats `characters({ animation })`.

- A clip name also matches the part after the last `|`: Blender / FBX2glTF exports `CharacterArmature|Idle`, you write `Idle`.
- Dev checks: a state whose clip is not in the model warns at `assets.animate()` with the available clip names and where to fix it
  (`state "attack" maps to a missing clip ... Fix the clip name in manifest "heroes" models.hero.animation.states.attack`); unknown keys
  (`loops: false`) warn ``did you mean `loop`?``; `go('atack')` / `sync('atack')` warn ``did you mean `attack`?`` and return null.
- **Check the actions the game plays**, once after building (a test, the console): `anim.check(['idle', 'walk', 'attack', 'hurt'])` returns `[]`, or
  one line per problem with its fix
  (`action "hurt" has no state. Add it to manifest "heroes" models.hero.animation.states.hurt: { clip: '<name>' } (clips in the model: ...)`). A model
  with no clips says so.
- Several states may share one clip (they share one AnimationAction, so switching between them does not cross-fade).
- Bone names: GLTFLoader drops dots, so `Wrist.R` becomes `WristR` in `model.getObjectByName`.

## 3. A character with a skinned model (most common)
```js
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero,
  clips: { idle: 'Idle', walk: 'Walk', run: 'Run', jump: 'Jump' },  // character state -> clip name in the glTF; states you leave out use the capitalised name if the model has that clip
});
engine.player.playAction('Wave');  // one-shot clip (skipped if the clip doesn't exist); returns to the previous state when done
engine.player.anim.state;  // current state name
```
**The game's own states** (crouch, climb, glide, dash, roll) go on top of the built-in ones through the `states` option, without taking the mover
over: it runs after the mover's state each step and returns a state name or null (keep the built-in `facts.base`); the clip comes from `clips`
like any other state, a speed change stays `engine.mod('move.speed')`. A state only names the pose: climbing also needs someone to move the body
(recipe 57, Moved by script, has a ladder).
```js
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero, clips: { crouch: 'Crouch', glide: 'Glide' },
  states: (c, f) => f.grounded && engine.input.down('crouch') ? 'crouch' : !f.grounded && f.vy < 0 && gliding ? 'glide' : null });
```
Deep water follows `water`: `'swim'` (default), `'block'` (never enters), `'wade'` (walks the bottom), or `(c, { depth }) => mode` per spot;
`character:water { in, mode, depth }` fires on each change.
For smooth walk/run blending, use `animation` instead of `clips` and write a `move` blend tree (when the model has no walk/run states, move is used
automatically; the `speed` parameter is in m/s):
```js
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero, animation: { states: {
  idle: { clip: 'Idle' },
  move: { blend: [{ clip: 'Walk', at: 1.5 }, { clip: 'Run', at: 6 }], param: 'speed', sync: true },  // sync: align footsteps
  jump: { clip: 'Jump', loop: false },
} } });
```
The default transition time for every character is `characters({ animation: { fade: 0.15 } })`; a model's manifest mapping and the character's own
`animation` win over it.

**The placeholder capsule.** A character without a model draws with `engine.characters.material`, one plain three.js material shared by every capsule:
`engine.characters.material = new THREE.MeshToonMaterial({ color: 0xd9a066 })` swaps them all, as given. `colors: { body }` gives one character a copy in
that color. A model keeps its own materials.

**By asset name.** `model` also takes a registered model asset's name (file or builder). A file shows a gray capsule until the copy replaces it under the
same root (position, facing, state and collision stay); then `ready` turns true, `whenReady` settles and `character:model` is emitted. A name no model asset has throws with the registered
names; a failed load keeps the capsule and warns once; a character disposed before loading ends never gets the model. `p.anim` is set after `await p.whenReady` (unless the load failed).

## 3b. Procedural bodies are assets too (`model: 'humanoid'`)
An asset pack can supply a code-built humanoid (box limbs the engine swings while walking, running, swimming, jumping); a builder is built at once, so its joints (`player.armL`, `legR`...) exist right after `addPlayer`. Without `model` (and without `rig`) a character is a gray capsule, warned once.
```js fragment
import { assets } from './assets.js';  // an asset pack of yours (or a published one) with a 'humanoid' builder
engine.assets.manifest(assets);
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: 'humanoid' });
engine.npcs.add({ id: 'fisher', model: 'humanoid', colors: { body: 0x4f6d8f } });  // per-character part colors
```
- **Colors**: a builder's materials are its own three.js materials, and colors shared by many bodies come from `this.palette` (recipe 05);
  `colors: { body, skin, legs, hair }` recolors one character's marked parts.
- **Your own procedural body**: a builder that returns an Object3D with `root.userData.rig = { body: 'hips', head: 'head', joints: ['armL'],
  limbs: [{ joint: 'legL', offset: 0, amp: 0.9, kind: 'leg' }] }` (object names, so it survives copies and baking) animates like the humanoid; mark
  meshes `userData.part = 'body'` for `colors`. A hand-built one-off passes `{ rig }` instead ([02-npc](02-npc.md)).

## 3c. Sprite characters: a 2D billboard or flat body in plain three.js
A 2D sprite character is a plain three.js object handed to `model`. `THREE.Sprite` always faces the camera; a `Mesh` with a `PlaneGeometry` turns with
`character.root`, takes light and can cast a shadow. Frames live in `picture/` (recipe 62); `onPose` gives them the character's state each frame:
```js fragment
// picture/sprites.js: a sheet of cols x rows frames; which row is which is your sheet's layout
const ROW = { idle: 0, walk: 1, run: 1, jump: 2, fall: 2 };
export function spriteBody(texture, cols, rows, framesPerSecond) {
  const map = texture.clone();  // offset lives on the texture, so one clone per character; the image stays shared
  map.needsUpdate = true;
  map.repeat.set(1 / cols, 1 / rows);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map }));
  sprite.center.set(0.5, 0);  // feet on the character's origin
  let t = 0;
  const animate = (c, dt) => {
    t += dt;
    map.offset.set(Math.floor(t * framesPerSecond) % cols / cols, 1 - ((ROW[c.state] ?? 0) + 1) / rows);
  };
  return { sprite, animate };
}
// main.js: the sheet is a name in assets.js like any texture
const hero = spriteBody(await engine.assets.texture('hero-sheet', { pixelated: true }), 4, 3, 8);
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero.sprite }).onPose(hero.animate);
```
**In an orthographic view of a 3D scene** use `pixelSprite` from `threedog/pixel` instead of a `Sprite` or a free plane (recipe 62 section 4b): a plain `Mesh` that stands upright, so walls behind it do not cut its head, and shows one texel per art pixel. `model` takes it as it is. It ignores the turn of `character.root`, and `onPose` picks the frame:
```js fragment
const hero = pixelSprite({ grid: engine.cameraRig.pixelSnap.grid, material, width: 16, height: 24, columns: 4, rows: 3, snap: 'followed' });
const ch = engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero });
const right = engine.cameraRig.pixelSnap.grid.axes().right;  // the same vector every frame
ch.onPose(c => spriteFrame(hero, ROW[c.state] * 4, Math.sin(c.facing) * right.x + Math.cos(c.facing) * right.z < 0));  // no state machine here: which frame shows is the game's
```
`c.facing` is an angle in radians around Y (0 looks along +Z), so `c.facing < 0` is not "looks left": which way is left depends on how the camera is turned. Mirror when the heading `(sin, cos)` points against the screen's right axis, as above. Run once in a view turned 45 degrees: walking toward the screen's right gave "not mirrored"; the other direction was not run.
`character.root` and `hero.position` stay exact, so physics and saves see the true position. A one-off `new Character(engine, { model: hero })` still needs `engine.add(character.root)`, as in recipe 02.
- **What the engine still does**: everything but the drawing. The mover, ground and collision, `state`, `facing`, `walkTo`, the camera and the save work as for any body; `anim`
  has no clips to play. A one-off NPC is `new Character(engine, { model })` the same way ([02-npc](02-npc.md)).
- **Facing**: a `Sprite` ignores `root`'s turn and a negative scale. Pick a row from `c.facing`, or mirror with a negative `map.repeat.x` and the matching `offset`.
- **Edges**: `alphaTest` on the material gives hard edges and no sorting trouble between overlapping sprites. For a side or top-down view see recipe 21 section 6; for a pixel look, recipe 62 section 4b.

## 3d. Which modules need an engine character, which take a sprite or any position
Tried with a `pixelSprite` mesh and a `Character` whose `model` is one (`threedog new-game name --pixel` is the starting game). Each row below was run once in a real browser, in a few lines; "not run" means only the docs were read.
| Module | On a sprite / plain object / position | Result |
|---|---|---|
| `characters` (`addPlayer`, `new Character`, `walkTo`, `onPose`) | the sprite is the character's `model` | works: moves, collides, `state` and `facing` drive `onPose`; `walkTo` on an NPC character walked there |
| `interactions.add(object, ...)` | any mesh or sprite, no character | works: E near it, `once`, `counter`, saved as used |
| `dialogue` | no object at all (a name and flags) | works: flags are in the save |
| `triggers.add({ position })` | a position; `who` is the actor or an id | works: fired for the player character |
| `pickups.spawn(position, { mesh })` | a position and your own mesh; `give` as a function without `inventory()` | spawned with a sprite mesh; collecting: not run |
| `quests` | steps with `target` an object or `{ x, z }` and `done(e)` | works to start and report steps; a step moved on by a dialogue flag: not run past the flag |
| `collision.addBlocked(fn)` | a function of x, z (the player was kept in the arena) | works; `addObject(mesh)`: not run |
| `characters.findPath` | positions | returned a path; `nav.findPath` needs the `nav` module: not run |
| `audio.sfx`, `audio.tone`, `ambience.add` | no object | ran without error (no sound file named, so nothing audible was checked) |
| `weather.set`, `calendar.at`, `sky` | no object | installed and started; `weather.set('rain')` kept the name `clear` without a weather table (give the module one), `calendar.at` firing: not run |
| `makeWindow(engine, opts)` | no object | created a window object (`open`, `toggle`, `remove`) |
Needs an engine character: `addPlayer`, `walkTo`, `onPose`, schedules, characters' collision and ground. Everything else above takes a position or any `THREE.Object3D`. A sprite that only stands there (a signpost, an NPC that never walks) needs no `Character`; one that walks, follows ground or is scheduled does.

## 3e. IK: heads that look, feet on the ground
Two layers after the clips on any Animator, off until added:
```js fragment
const look = npc.anim.addAim({ bones: ['Neck', 'Head'], target: engine.player.root, limit: 70 });
const feet = engine.player.anim.addFeet();  // feet on stairs and slopes
```
- `set({ weight })` fades over `fade` s; weight 0 leaves the animation pose exactly, `remove()` restores it at once; `target: null` looks ahead.
- `forward: [x, y, z]` (the last bone's axes): a head facing another axis than the bind pose says.
- `legs: [[upper, lower, foot], ...]` when it cannot tell the legs by bone name (it throws, listing them).
- Feet use the character's ground, platforms included (`ground: (x, z, y) => h` overrides); off while it jumps or swims, beyond `far`, or hidden.

## 4. Non-character objects (a dog, a windmill, a door)
```js
const dog = await engine.assets.model('dog'); engine.add(dog);
const anim = engine.assets.animate(dog, {
  fade: 0.25,
  states: {
    idle: { clip: 'Idle' },
    move: { blend: [{ clip: 'Walk', at: 1 }, { clip: 'Run', at: 5 }], param: 'speed' },
    bark: { clip: 'Bark', loop: false, then: 'idle', lock: true },  // one-shot; lock: go() doesn't interrupt it while it plays
  },
  transitions: { '*>idle': 0.4 },  // transition seconds for specific switches
});
anim.go('idle');
anim.set('speed', 3); anim.go('move');  // just set the speed every frame
anim.action('bark');
engine.events.on('anim:end', ({ root, state }) => { if (root === dog) console.log(state, 'finished'); });
anim.dispose();  // no longer needed: stop per-frame updates (call this when deleting the model)
```
**Gameplay timing never reads the animation**: the mixer advances per frame and `anim:end` is emitted per frame, so dropped frames, fast-forward
(step's frameEvery) and a model being torn down when it is far away all make it drift from game time. When an attack lands, cooldowns, recovery and
"finish the swing before moving" are timed in fixed steps:
```js
engine.input.define('attack', { label: 'Attack', keys: ['KeyF', 'Mouse0'] });  // no module binds it for you
let t = -1;  // seconds since the swing started (-1 = not swinging); put it in a world record if it must be saved
engine.onFixed(dt => {
  if (t < 0) { if (!engine.input.pressed('attack')) return; t = 0; }
  const before = t; t += dt;
  if (before < 0.3 && t >= 0.3) hitEnemiesInFront();  // hit check at 0.3 s
  if (t >= 0.6) t = -1;  // can swing again after 0.6 s
  engine.player.anim.sync(t < 0 ? null : 'attack', t);  // the animation follows t (the attack state of section 5)
});
```
## 5. Gameplay controls progress: `sync(state, t)`
Who owns the clock: **gameplay**. An action timeline counts `t` in fixed-step seconds (recipe 06) and decides hit windows, i-frames and when the
action ends; the animation only shows `t`.
`anim.sync(state, t)` poses `state` at gameplay time `t`: the clip does not advance or end by itself (no `anim:end`), and `go()` / `action()` leave it
alone, so a character's per-frame locomotion cannot override it. `sync(null)` hands control back; the next `go()` switches as usual. Entering a synced
state cross-fades like `go()` (the `transitions` table applies).
`timing` on the state maps gameplay seconds to clip seconds:
```js fragment
const anim = engine.player.anim;  // or engine.assets.animate(model, {...})
Object.assign(anim.states, {
  // gameplay: windup 0-0.16, hit 0.16-0.28, recovery 0.28-0.62. The clip raises the sword until 0.24 s and brings it down by 0.5 s:
  attack: { clip: 'Sword_Slash', loop: false, timing: [[0, 0], [0.16, 0.24], [0.28, 0.5], [0.62, 1]] },  // piecewise linear
  roll: { clip: 'Roll', loop: false, timing: 0.62 },  // a number: stretch the whole clip over 0.62 gameplay seconds
  hurt: { clip: 'HitRecieve', loop: false, timing: 0.45 },
  death: { clip: 'Death', loop: false },  // no timing: clip seconds = t (clamped at the last frame)
});
engine.onFixed(() => {  // one call site: whatever gameplay is doing decides the pose
  if (f.dead) anim.sync('death', f.deadT);
  else if (f.stun > 0) anim.sync('hurt', f.stunMax - f.stun);
  else if (f.act) anim.sync(f.act.id, f.act.t);
  else anim.sync(null);  // free: locomotion (idle / walk / run) takes over
});
```
- Calibrate `timing` once by looking: sync the raw clip (no timing) at a few `t` and watch the weapon hand (`describe()` or a bone's world position);
  put the down-swing inside the hit phase.
- Pause, fast-forward, hit-stop (t stays still), loading mid-action and replays all line up, because the pose is a pure function of `t`.
- Looping states wrap `t`, one-shots clamp it to the clip.

Use `anim:end` only for presentation (change an expression, play the next clip). Native objects: `anim.mixer` (AnimationMixer), `anim.actions` (clip
name -> AnimationAction). Things without a skeleton that only move/rotate as a whole use `engine.timeline.tween`, not an Animator.

Footsteps: `engine.events.on('character:step', ({ character }) => ...)` hears each foot come down (`character.groundType()` is what it stepped on), and `character:land` each landing; the engine's own footstep sound listens the same way, so yours adds to it. Bones after the pose: `const h = player.onPose((c, dt) => { sword.position.copy(hand.getWorldPosition(v)); })` runs every frame right after the character's pose (IK included: a bone written here keeps the game's value) is
applied (clips or procedural rig); `h.remove()` stops it. Presentation only.

## 6. Verify
- `anim.describe()` -> `{ state, clip, time, progress, driven, t, weights }` (clip seconds, 0-1 progress, whether sync drives it, the last gameplay t,
  each fading state's share); the player's is in `describe().player.anim`.
- In a test: `engine.haltLoop(); anim.go('move'); engine.step(0.4)`, then look at `anim.state` and `anim.actions.get('Walk').getEffectiveWeight()` (all
  clip weights sum to 1).
- Characters: `describe().player.state` (idle/walk/run...) matches `engine.player.anim.state`.
- `anim.check([...actions])` is `[]`.
