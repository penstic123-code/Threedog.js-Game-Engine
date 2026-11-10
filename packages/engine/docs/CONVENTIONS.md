# Additional conventions (read when the task is relevant)

For API details see `api/<module>.md`; this file holds conventions that don't belong to one API but cause problems when broken. `AI.md` lists each in
one line; the detail is here.

## Where a thing goes in the world

| The thing | Use |
|---|---|
| Built by code on every start | `scene.add` (plain three.js) or `engine.add` |
| Must be saved, or live on while far away | `engine.world` (`world.add`, `world.present` for its model) |
| Written as data | `content`, the data front of `engine.world` |
| Drawn in a level file | a level, through `level()` |
| Placed on cells | `engine.grids`, on top of the above |

`engine.stream` is the low-level loader under these; reach for it only for your own distance-based loading.

## World data and level ownership
- **World data**: game objects that must be saved, survive level changes, or change while far away go in `engine.world` (the model is built with
  `present` only when near, the simulation runs with `simulate`).
  Items written in content use `add(def, { initial: true })` (an id is required; a save records only changes and deletions, independent of the order
  relative to content.load); items generated at runtime use a plain `add`; temporary ones use `{ save: false }`;
  discrete changes use `world.set` (it emits world:change), things that change every step modify the field directly or use `move`. Usage is in `api/world.md`.
- **Level ownership**: world data carrying `zone: engine.world.zone` (= the current level name) gets its model built and is simulated only in that
  level; when you leave, the data stays (content NPCs, pickups and props already work this way);
  things that need not be kept (trigger zones, etc.) use `level.track(handle)` and are deleted automatically on level change.
- **Module type**: a module says what it owns with `type` (`'rules'` for game logic, the default; `'world'` state that draws nothing, `'picture'` what is
  seen and heard, `'ui'` panels, `'actor'`, `'net'`, `'tool'`; recipes/14). Modules depend on capabilities (`requires: ['inventory']`), never on
  another module's name or private fields; a module doing two kinds of thing is two definitions from one factory (`weather()`: state + drawing).
- **Who owns a handle**: every `{ remove() }` handle has one owner that removes it, chosen by how long it should live: the module
  (`ctx.track(h)` in its install / init: until the module goes), the playthrough (`engine.session.track(h)`: until newGame / load / quit), or
  the level (`level.track(h)`: until the level changes). A handle with none lives until `engine.dispose()`.
- **Two doors, one scene**: plain three.js (`engine.add(mesh, { id })`) and templates (`engine.content.spawn`, props) land in the same registry;
  `engine.thing(id)` says what it is and what a save keeps (`recipes/40-scene.md`). What must be saved with its own state or edited without
  code goes in `content/` (templates + props with ids, pickups, npcs, containers, game kinds) or the level model; a save stores only changes on top.
  Startup code never creates what a save stores whole (rule R33): things that appear during play come from `engine.content.spawn` inside an op.
- To find leaks read `engine.counts()` (listeners, timers, geometry count; they should not grow when entering and leaving a level repeatedly).

## Textures
The opts of `assets.texture(name, opts)` are part of the cache key: the same image with different opts gives two separately configured textures.

## Values the engine writes on its own (camera, shadow box)
Lights, fog, exposure and the environment have one writer, the game's `picture/` code (recipe 62). What the engine writes itself, the camera pose and the shadow box, and how to take it: recipe 52 "Who writes it".

## Layers the engine keeps
The three.js layers below belong to the engine (one table: `RESERVED_LAYERS` in `threedog/layers`, file `render/layers.js`). A game's own layers are 1 to 25; 30 is the default camera `hideLayer`.

| Layer | Name | What sits there |
| --- | --- | --- |
| 26 | `lightVolumes` | the box of air and the lights `lightVolumes` reads |
| 27 | `occlusionBox` | occlusion culling's query boxes, seen by the scene render of the view camera alone |
| 28 | `occlusionHidden` | nothing sits here: culling sets it on shadow cameras, so what it hides still casts |
| 29 | `outlineOff` | objects `outline({ offLayer })` leaves without lines; `OUTLINE_OFF_LAYER` from `@threedog/post-effects` is this same layer |
| 31 | `batched` | originals drawn through `engine.batching`, still hit by `engine.rays` |

## Customization ladder
Pick the row for what you want; each row is the one entry for it (take the first that fully works). Plain JS fields and your own `onFixed`
logic need none of this.

| You want to | Use | Detail |
|---|---|---|
| Tweak a parameter of a system | its options (`createEngine({...})`, `terrain({...})`, `openWorld({...})`; unknown keys throw), or content data | `api/<module>.md` |
| Let several systems change one shared value (speed, time scale, gravity, damage taken): the game sets, effects multiply, settings cap | `engine.mod(point, { owner, set \| add \| mul \| clamp, for })`, in a module `ctx.mod`; `mul` / `add` cooperate, two owners' `set` on one layer is an error with the fix; your own point: `engine.stacks.define` | `recipes/55-mods-time-wrap.md` |
| Run code before / after / around a module method (a weight limit on `inventory.add`) | `engine.wrap(engine.inventory, 'add', (next, ...a) => next(...a), { owner })` | `recipes/55-mods-time-wrap.md` |
| Close one action for a while (stunned: no jump) | `engine.input.gate(action, { owner, for })` | `recipes/55-mods-time-wrap.md` |
| Replace a whole system (your own inventory, interactions, dialogue, quests, flow, characters, camera, collision, level; your own vehicle for `character.enter`) | `engine.use(mine(), { replaces: '<slot>' })` for a part that `provides` that slot; a module (or object) that meets that contract (`<module>.contract.js`; vehicle: `modules/characters/vehicle.contract.js`), checked with `runContract` | `recipes/55-mods-time-wrap.md` "Replacing a module" |
| Change a picture value (light, fog, sky, water, tone, post) | write it in your `picture/` code on the three.js object or the module's `material` (recipe 62); a value the engine drives (camera far, fov, pixel ratio): write it directly, the engine yields; `engine.autoView.manual(key)` is for borrowing one and giving it back; a screen effect: `engine.post.add(x)` |
| Write the picture yourself | plain three.js on `engine.scene / camera / renderer` (own material, `ShaderMaterial`, pass); a direct write takes that value over and the engine yields | `THREE.md` |

**What can be replaced**: a slot with a contract file (inventory, interactions, dialogue, quests, flow, characters, calendar, cameraRig, particles, collision, level, nav) lists what a replacement must supply, and `runContract` checks it. A `nav` replacement must still be Recast underneath (path search, the path worker and NPC steering call Recast's `query`, `navMesh` and `crowd` methods listed in `modules/nav/contract.js`); for a search of another kind, leave `nav()` out and call yours from game code. The slots below have no contract; a replacement must supply what the engine's own callers read:

| Slot | A replacement must supply |
|---|---|
| `sky` | the `engine.uniforms` signals your `picture/` code reads; `dome` (the object a photo leaves out) if it has one |
| `terrain` | the ground through `engine.setGround`; `chunkSize`, `stats`, `edit` (nav), `view` and `setPlanter` (vegetation). Replace `terrain-draw` with it: the drawing half reads the engine terrain's chunks |
| `weather` | `types`, `name`, `current`, `label(name)`, `set(name, { seconds })`, `auto`. Replace `weatherDraw` with it |
| `vegetation` | `define(name, rule)` (content), `instanceAt(point, { radius })` (photo), `host` (settings). Replace `vegetation-draw` with it |
| `rigid` | `vehicles`, a list of objects that meet `modules/characters/vehicle.contract.js`; `collider3d`, the three-axis slot (`modules/rigid/collider3d.contract.js`) |
| `swarm` | nothing: no other module calls it |

**Not replaceable**: `world` (saves, ids, streaming and content stand on its records; `requires: ['world']` names it as a capability), and the player inside `characters` (`engine.player` is the engine's own character; steer it with `control.take`).

A picture factory can also be passed at the call site, which wins (`terrain({ material })` and the like; the water surface is `engine.water.material`).

**Time channels**: one group runs slower or faster than the rest (bullet time on enemies): `engine.onFixed(fn, { channel: 'enemies' })` gets that channel's scaled `dt`, `engine.mod('time.enemies', { owner, mul })` scales it (`recipes/06-clock-events.md`).

### One task, which entry
Where a task has more than one entry they are layers of the ladder above, not alternatives: take the first, go down only for the reason given.
Picture rows (light, glow, environment, post) follow the order in `THREE.md` (plain three.js first): they name the hook your three.js code plugs
into, or a convenience for after.

| Task | First | Go down a layer when |
|---|---|---|
| Windows, signs, screens glow at night | a material whose `emissiveIntensity` reads `engine.uniforms.uNight` (recipe 09 §1b) | `lightPool.add(obj, { glow })` is something else: the stand-in a pooled lamp shows while it holds no real light |
| Time of day | `engine.calendar` (`calendar({ time })`) | no calendar at all (one fixed scene): `sky({ time })`; timers: `engine.clock`; one group faster / slower: a time channel |
| Sun / light strength | your own three.js light in `picture/`, reading `engine.uniforms` (recipe 62) | the placeholders: write `engine.lights.sun` directly |
| A game test (write one for your game) | a spec file `tests/specs/<name>.mjs` exporting `specs` (COMMANDS.md "A game's tests": minimal example, `threedog test <name>`) | the test is steps and checks only: a scenario JSON `tests/scenarios/<name>.json` (recipes/23 §7); compare whole state: describe snapshots (recipes/16 §7) |
| Teleport the player | `player.placeAt(p)` in an op | not streamed in yet: `await engine.stream.teleport(p)` (waits, then places); a test or scenario: `applyState({ pos })` |
| Camera | install one: `openWorld({ camera })`, `engine.use(fixedCamera({ position, lookAt }))` | switch kinds at runtime: `setCamera(kind)`; a shot of your own: `takeCamera(owner)` |
| Sky | `sky({ ... })` start values, tuned through `engine.uniforms` and `engine.sky` | a custom sky of your own (shader dome, skybox, painted backdrop): `engine.sky.replace(obj)` (recipe 08 "Your own sky object"); on WebGPU three's `SkyMesh` the same way |
| Environment light | `engine.sky.environment({ into: engine.scene })`, or `scene.environment` | light that changes from place to place: `bakeProbes` |
| Post effects | your own three.js Pass in the engine's chain: `engine.post.add(pass)` | ready-made effects: `@threedog/post-effects` through the same call or a plugin file, tuned with its handle; a whole chain of your own: `engine.post.own()` |
| Ambient occlusion | `engine.post.add(ao())` (screen space) | a model made in code: `bakeVertexAO(geometry)`; bounce light between places: `bakeProbes` |
| Days, months and seasons that pass | `calendar()`, read `engine.calendar` (recipe 06) | one fixed moment: `sky({ time })` |
| See through the hero's eyes | `firstPersonCamera()` (recipe 21) | switch at runtime: `setCamera(kind)` |
| Still view of a room, security-camera style | `fixedCamera({ position, lookAt })` (recipe 21) | a moving shot: `takeCamera(owner)` |
| Strategy view from above, edge scrolling | `rtsCamera()` (recipe 21) | a view of your own: a module writing `engine.camera` |
| A person who walks, follows a path, is steered | `engine.characters` (recipe 13, 57) | a mover of your own: `characters.kit` |
| Levels, items and quests written as data files | `content/` files, read by `engine.content` (recipe 20) | built at runtime: plain code in a module |
| Look at only the normals or overdraw of the picture to find what is wrong | `engine.debug.view('normals', { owner })`, then `view('off')` (recipe 15) | your own overlay: `engine.debug.defineView` |
| Dev info on screen, a key that shows it | `debug()`: F3 opens the panel, `engine.debug` (recipe 15) | outside the page: `threedog describe` |
| Far buildings or forests merged into one cheap mesh | `engine.hlod.add(root)` (recipe 15) | close objects: `engine.batching` |
| Next map, next stage, change level | `engine.level.load(name)` (recipe 10) | a fade around it: `engine.flow` (recipe 07) |
| Background song that changes in a fight or a place | `engine.music`, rules as data (recipe 31) | one track: `engine.audio.play` |
| An enemy walks around obstacles to reach someone | `engine.characters.findPath` on `engine.nav` (recipe 12) | a search of your own is fine: it reads `engine.collision.walkable` |
| Two people play together over the internet | `engine.net` (recipe 27) | |
| Take a snapshot in the game and keep it | `photo()`, `engine.photo.take()` | the raw image: `renderer.domElement.toBlob` |
| A cutscene: steps in order; tween a value | `engine.timeline`, `engine.timeline.tween(target, to)` (recipe 07) | one delay: `engine.clock.after` |
| Something happens when the player enters a zone | `engine.triggers` (recipe 20) | a press inside it: `engine.interactions` |
| Raindrops and snow drawn on screen | `engine.weatherDraw` (recipe 08) | your own drawing: `THREE.md` |
| Lower the resolution when the frame rate drops | `engine.adaptive` (recipe 15) | a fixed size: `engine.setPixelRatio` |
| Draw many copies of one mesh in one call | `engine.batching` (recipe 05) | your own `InstancedMesh`: plain three.js |
| What each frame costs, against limits | `engine.budget` (recipe 15) | |
| A cutscene takes the view for a moment | `engine.takeCamera(owner)`, read `engine.cameraOverride` | a whole shot list: `engine.timeline` |
| Sweep a shape through solid things, overlap tests | `engine.collider3d` (recipe 11) | a line: `engine.rays` |
| Message when the game crashes, the last error | `engine.error` and `.threedog/errors.log` (recipe 16) | |
| Tell other systems something happened | `engine.events` (recipe 06) | |
| Height of the floor under a point | `engine.surface(x, z)` (recipe 28) | whether there is floor at all, or a fall out of the map: `engine.ground.has(x, z)` / `voidY()` |
| Heavy work done bit by bit without freezing a frame | `engine.jobs` (recipe 15) | off the main thread: `engine.threads` |
| Loading screen, progress bar while files load | `engine.loading` (recipe 07) | |
| Pause when the browser tab is hidden | `engine.page` does it: gameplay freezes under owner `page` (recipe 07) | |
| Style files that plug in with no main.js line | `plugins/`, `engine.plugins` (recipe 40) | |
| Seeded dice roll that replays the same | `engine.random` (recipe 06) | |
| What is the mouse pointing at, click an object | `engine.rays`, `engine.pick(x, y)` (recipe 19) | |
| Which systems are stopped and who stopped them | `engine.runState` (recipe 16) | |
| Remember progress between visits | `engine.saves` (recipe 20) | |
| New game and continue from the menu | `engine.session` (recipe 07) | |
| Cloud shadow and season in your own material | `engine.shaderTerms` (recipe 52) | |
| Stack bonuses from several sources on one value | `engine.stacks` (recipe 55) | one value, no bookkeeping: `engine.mod` |
| How long the first frame took to load | `engine.startup` (recipe 15) | |
| Load far parts of a big map only when near | `engine.stream` (recipe 33) | |
| Heavy work in a web worker | `engine.threads` (recipe 15) | bit by bit on the main thread: `engine.jobs` |
| How many seconds passed in the game | `engine.time.now()` (recipe 06) | |
| Remember a flag or a count, a door was opened | `engine.vars` (recipe 20) | |
| A named fixed view, a second camera to show | `engine.views` (recipe 46) | |
| Load a model, texture or sound file | `engine.assets` (recipe 05) | a format it does not read: a three.js loader |
| Something at a set hour of game time (a shop opens at nine) | `engine.clock`, `engine.calendar` (recipe 06) | |
| A guard patrols or wanders between points | `engine.characters` with `findPath` (recipe 12, 57) | |
| Back to the main menu after losing, game over, retry | `engine.flow`, `engine.session` (recipe 07) | the rules of the ending: recipe 32 |
| Sunset, sunrise, the sky's colors | `engine.sky`, `engine.calendar` (recipe 08) | your own sky: `THREE.md` |
| Mission marker, an arrow on screen | `engine.hud.marker()` (recipe 04) | |
| Place furniture and merge it for speed | content `props` (recipe 05) | |
| Your own colors, textures and models | plain three.js in `picture/` (recipe 09) | |
| A map or model from a 3D modeling tool (Blender) | `engine.level` (recipe 10) | art only: recipe 46 |
| Write your own engine system | a module (recipe 14) | one that plugs into saves and time: recipe 49 |
| Match the look of a reference painting or picture | recipe 35 | |
| The image looks flat, what to adjust | recipe 60 | |

### Look-alike entries
Each of these does one job. Take the row for your job; none replaces another.

**What each wait waits for**

| Entry | Waits for |
|---|---|
| `engine.ready` (`await engine.start()`) | World built and the loading screen gone |
| `x.whenReady` (`x.ready` is the same as a boolean) | That one thing: a character's model, a stream source's area, `saves` storage |
| `engine.loading.settled()` | Every module installed after start() finished its init, also when one failed |
| `engine.stateApplied` | start() done and the URL parameters or latest `applyState` applied: for tests and screenshots |

**Time**

| Entry | Job |
|---|---|
| `engine.clock` | Timers: `after`, `every` |
| `engine.time` | Reading game time: ticks and each channel's `now` |
| `engine.calendar` | Time of day, days, seasons |

**Hooks**

| Entry | Runs | For |
|---|---|---|
| `onFixed` | 60 times a game second, stops when frozen | Rules: movement, damage, cooldowns |
| `onFrame` | Once a frame | Presentation: animation, UI, what the player sees |
| `onRender` | Around the frame's render | Extra three.js renders into your own targets |

**Loading a save**

| Entry | Job |
|---|---|
| `session.load` | The default: Continue or retry, nothing of the current playthrough left over |
| `saves.load` | A quick load inside the same playthrough |

**Putting something in**

| Entry | Use it for | Saved |
|---|---|---|
| `scene.add` | Plain three.js, rebuilt by code on every start | No |
| `engine.add(obj, { id })` | The same, with an id so changes to it persist | Its changes |
| `world.add` | A game object that lives on while far away or across levels | Yes |
| `content.spawn` | A placement of something written as data, at run time | Yes |

**Taking something out**

| Entry | Leaves the scene | Frees |
|---|---|---|
| `scene.remove` | Yes | Nothing: plain three.js, GPU memory stays until you dispose it |
| `obj.removeFromParent()` | Yes | Nothing, on purpose: you will add it back |
| `engine.remove` | Yes | Its and its children's geometry and materials; rays unregistered. Asset-shared data stays with the asset cache |

## Owners
Everything that holds the engine is named by an owner, and only that owner releases it. Positional `freeze('menu')` and `freeze({ owner: 'menu' })` are the same.

| What | Take | Release | Returns |
|---|---|---|---|
| Real-time loop | `haltLoop(owner)` (tests and tools; a game freezes) | `handle.remove()` | handle `{ remove() }` |
| Gameplay freeze | `freeze(owner, { kind? })` | `handle.remove()` | handle |
| Camera | `takeCamera(owner, { focus? })` | `handle.remove()` | handle |
| Where a character goes | `control.take(character, { owner, layer, step? })` (layers base < script < cutscene < net; higher pauses lower) | `handle.remove()` | handle `{ active, move(), remove() }` |
| Debug override / view | `debug.override(owner, ...)`, `debug.view(mode, { owner })` | `debug.clear(owner)` | handle / state |

## Worker limits
`modules/terrain/terrainGen.js` (via `chunkJob.js`) runs in a Worker and must not import three.js; a vegetation `rule` is sent to the Worker and must
not contain functions.
Workers are created only through `engine.threads.lane({ create, local })` (the same handler runs on the main thread when there are no workers); no
`new Worker` / `postMessage` elsewhere (`npm run check` rule R19). Worker files import only worker-safe code (a game:
`import { serve } from 'threedog/worker'`; inside the engine `core/threads/threadServe.js`, `core/threads/threadPure.js`), never `core/threads/Threads.js` or three.js.

### Worker results that change gameplay: `ctx.commits`
A result that changes gameplay never takes effect "when it arrives"; it takes effect on a fixed tick decided when you ask (`engine.time.tick + lag`,
default 30 steps), so threads on or off, fast or slow machine, give the same state.
```js
const t = ctx.commits.request({
  apply: r => { state.path = r; },  // runs on the due tick, with the worker result or the fallback result
  fallback: () => computePath(from, to),  // required: the SAME computation on the main thread
  valid: () => state.gen === myGen,  // still wanted? checked on the due tick
});
lane.run(job).then(r => t.resolve(r));  // when the worker replies; t.remove() if you no longer want it
```
- **No worker result by the due tick**: `fallback()` runs then, `apply` gets its result, `ctx.commits.stats.late` goes up, and a later reply is ignored. So `fallback`
  must give the same result as the worker (one function for both) and fit inside one fixed step.
- **Dropping an old result**: `t.remove()`, or `valid()` returning false on the due tick. A save load (`saves.apply`) or `level.load` drops pending
  commits that have no `valid` (they were requested for the old world), including `jobs.add(work, { apply })` started before it (`jobs.add` also takes
  `valid`); a request with `valid` decides itself.

### Pure functions for workers: `engine.threads.pure(fn, label)`
A function sent to a worker (`world.simulate(kind, { far, worker: true })`, your own lane) is sent as source text and recompiled in an empty scope. So
it **cannot use outside variables, `this` or imports**, and cannot be native, bound, a class, `async` or a generator; it may use its parameters,
constants written inside it, and globals such as `Math`. The main thread runs the same recompiled copy, so a mistake fails the same way with threads on or off.
```js
const RATE = 1 / 600;
// wrong: RATE is an outside variable -> ReferenceError "RATE is not defined" (message says to put it inside)
engine.world.simulate('crop', { far: (rec, dt) => { rec.growth += dt * RATE; }, worker: true });
// right: the constant lives inside, or on the record (rec.rate)
engine.world.simulate('crop', { far: (rec, dt) => { rec.growth = Math.min(1, rec.growth + dt / 600); }, worker: true });
```
Registration (`threads.pure` / `simulate`) checks that the function recompiles and names outside variables with the fix (a heuristic: a variable inside a template string throws on the first call instead).

## Interface conventions (one style across the engine)
- **A position is one argument**: any API that takes a position takes it as a single argument: Vector3, Object3D (its position), `[x, y, z]` or
  `{ x, z }` all work. Size, radius and count go in the options object after it: `collision.addBox(house, { halfWidth: 3, halfDepth: 2 })`,
  `particles.emit('dust', p, { count: 20 })`, `world.query({ near: p, radius, kind })`. A position key inside an options object is always `position`
  (`stream.add({ position, build })`). The only exceptions are ground sampling `engine.surface / slope / groundType / waterAt(x, z)`;
  `{ place, x, z }` in content data is a data form.
- **Registrations return a handle**: anything that registers a listener, timer, continuing effect or registration (`events.on/once`,
  `onFixed/onFrame`, `clock.after/every`, `calendar.at/between/daily/onSeason`, `collision.addBox/...`, `interactions.add`, `rays.addStatic`, `stream.add`,
  `triggers.add`, `hud.marker`, `hlod.add`, `particles.attach`, `pickups.spawn`, `rigid.addBox/...`, `audio.addBus`, `defineState`, `ops.define`, `saves.define`, `ui.define`) returns a
  handle `{ owner?, remove() }`, never a bare function; `h.remove()` is the only give-back form (safe to repeat, removes only its own registration, so `ctx.track` takes any). `remove()` undoes what that call did: models it created itself are deleted with it (such as a
  pickup); objects you passed in are not. APIs that add an object or change business data return what their own signature says: `engine.add(obj)`
  returns the added object, `inventory.add` a result, `world.add` a record; delete those with `engine.remove(obj)` / their own remove call.
  Exceptions to the verb rules (each with its reason in the table of check rule R69, which checks this line): `add`, `characters.addPlayer`, `world.add`, `inventory.add`, `settings.addSection`, `i18n.add`, `plugins.add`, `plugins.on`, `jobs.add`, `grids.add`, `player.addJumps`, `input.bind`, `particles.attach`, `saves.putAttachment`, `ui.create`; giving back is the verb remove, and these are the only other verbs for it (clear / forget / release / unload / dispose, each does what remove cannot): `triggers.clear`, `debug.clear`, `particles.clear`, `level.unload`, `assets.release`, `views.release`, `page.releaseLock`, `control.forget`, `player.dispose`, `nav.dispose`, `dispose`.
  A definition by name (`inventory.define`, `quests.define`, `settings.define`) is data, not a registration: it returns its own object, and defining the name again replaces it.
- **Verbs** (AI.md "Three rules"): a named kind or rule is `define` (`vegetation.define`, `ops.define`, `saves.define(key, { save, load })`); placing one is `add` / `spawn`;
  then `set`, `remove`, `describe`.
  One timer entry: `engine.clock.after(seconds, fn, { data, channel })` (calendar seconds, or `'real'` / a time channel's seconds with `channel`);
  one queue, so `remove()` is immediate: a removed timer never fires, not even later in the same step.
- **Unknown options throw**: every options bag goes through a `readParams` schema (one schema gives the check, the defaults and the catalog entry); an
  unknown key throws in dev with a did-you-mean and warns once in a release build; `checkOptions` is only for extensible data (item, template
  state and material fields, where games add their own keys).
- **Ready is always the boolean property `ready`** (to wait, `await h.whenReady`); a module's readiness hook is `isReady(e)`.
- **Event names are `noun:action`**: the noun is the emitter's singular camelCase name (`item`, `template`...), the action is a lowercase verb or state
  (`add`, `done`, `change`); a game's own events follow the same rule (`door:open`).
- **Time**: one source, `engine.time.tick`; real, ambient, channel and calendar seconds are read-only views (`engine.time.now(name)`), and only
  `core/time/time.js` adds to them (a spec checks). Always name the unit, real, channel or calendar seconds; `recipes/06-clock-events.md` defines them (and the calendar's time of day) and has
  the table of which one to use for movement, action timelines, cooldowns, hit-stop, crop growth, calendar and UI, and what pause / freeze /
  `clock.rate` 2 do to each. Speeds change only through `engine.mod` (the "Customization ladder" above).
- **Input**: gameplay keys are read in the fixed step (`onFixed` / module `fixed`), where `pressed / down / released` are a snapshot from the step's start (no frame-rate
  dependence, no lost press); UI keys (menus, a view toggle) in `onFrame` / module `frame`. Never read `pointer.clicked` for gameplay; bind a `Mouse0` action.
  Modules declare actions and their context (`ctx.input.define`) and never name a key; the game binds (`createEngine({ bindings })`,
  `input.bind`, `presets.bindings.*`); only the basics (move, confirm, cancel, UI cursor) have default keys (`recipes/58-input.md`).
- **Module names**: `collision()` installs as `engine.collision` (lightweight collision: walking, camera); `rigid()` installs as `engine.rigid` (real
  physics with Rapier).
- **Presets**: `openWorld()` installs only world, environment and basic modules; the game adds gameplay modules with `engine.use`; `false` drops an item; the camera has no default and must be named, e.g.
  `openWorld({ camera: 'firstPerson' })` (`'follow'` / `'rts'` / `'fixed'`, a camera module, or `false`).
- **Errors say how to fix it**: passing an old form (a numeric position, etc.) throws and explains the fix.

## Core conventions
- Lighting without `sky`: every engine has `engine.lights = { sun, hemi }` (neutral); to light the scene yourself hide or adjust them and add three.js
  lights. The engine ships no art: the humanoid, pickup shapes and flat shading come from the game's `picture/` folder and `assets.js` (e.g.
  `terrain({ shading: 'flat' })`); without them the engine shows a gray capsule, a gray box and flat gray ground at y = 0, with a
  dev warning naming the fix.
- Gameplay state (world, containers, vars, quests) changes only in fixed steps or inside ops; dev warns otherwise (`npm test` prints the first place, all in
  `<game>/.threedog/ops-guard.log`). (game side)
- **One source for "can walk there"**: `engine.movement`, and a character's position belongs to its mover (recipe 12 section 5).
  Who calls `move` is the character's control holder (`engine.control`, `recipes/57-control.md`): one per step; anyone else is `[control-bypass]`.
- Units are meters, Y is up, north is -Z. Characters and vehicles face the model's +Z; `facing` 0 = +Z, forward = (sin f, cos f).
- Never call `requestAnimationFrame` or `renderer.render` yourself. **Game logic uses real or calendar seconds** (the hook's `dt`, `engine.clock`; `recipes/06-clock-events.md`),
  never `setTimeout` / `setInterval` / `performance.now()`: they ignore pause, freeze and `engine.step`.
- To be saved, call `engine.saves.define(key, { save, load })` (`load` may return a Promise); `saves.save / load` always return `Promise<boolean>`,
  so `await` them. Saved data names things by stable ids, never positions; when it changes shape raise `version` and add a `migrate` step
  (`recipes/20-content-actions-save.md` "Save format").
- Day / night in gameplay comes from the calendar: read `calendar.isDay`, use `calendar.daylight` (0-1) for fades (they work with no sky); don't judge by clock text yourself.
- A game's own picture parameters (colors, materials) can live anywhere plain three.js code lives; its `picture/` folder keeps them in one place (recipe 62).
- Terrain is editable: `engine.terrain.edit(pos, { lower|raise|flatten|paint })`, only inside an op or fixed step; custom
  `terrain({ height, groundType })` must be pure functions.
- Loading follows the `engine.stream` sources (player + camera focus by default); display, physics and world data are separate: unloading a model
  never removes its world record.
- Window blur, tab hidden, pointer lock and WebGL context loss are listened to only in `core/engine/page.js`; modules read `engine.page` or listen to
  `page:*`. Show "saved" only after `saves.save` returns true.
- Character bodies are assets: `addPlayer({ ...presets.player.thirdPerson, model: 'humanoid' | 'hero' })` (a procedural builder is built
  now; a file shows a gray capsule and is swapped in when it loads: `await player.whenReady`, event `character:model`), or `{ rig }`; a name no model
  asset has throws. Per-character colors: `colors: { body, skin, legs, hair }` on meshes marked `userData.part`.
- Wind-swayed meshes cast swaying shadows with nothing to set up (`shadow-accessors` in `THREE.md`). Shader time, wind and cloud cover are per engine in
  `engine.uniforms`; with two engines on a page, pass the engine to `applyEffects(mat, { engine })`.

## Failures: which shape
A runtime "can't" (not enough money, shelf empty) is returned as `{ ok: false, code, facts, nextActions }` (ops.run / can / undo, and direct calls such as `container.trade`, which a module builds by returning that shape, or a code string from an op's `can`). Misuse (a wrong call, a typo) is a thrown `codedError`. Documented exceptions: `checkSkip` / `checkSave` return `{ ok, diffs }`, `walkTo` returns `{ status }`. Read `code` (there is no `reason` field). Predicates (op `can`, `grid.can()`) may return a plain code string.

Inside the engine a failure takes one of three forms, so every one reaches the reader with a code, a fix and a page: misuse throws `codedError(code, message)` with an `ERROR_CODES` entry (`core/base/errorCodes.js`: what to change, which page to read); a recoverable problem warns once with `warnOnce(coded(code, message))` (dev lists each in `describe().warnings`; a code ending `-clamped`, `-fallback`, `-ignored` or `-replaced` says the engine used something other than what the game gave); a game or module callback that threw goes to `reportError`. Check rule R45 rejects a plain `throw new Error` and a bare `console.warn` / `console.error` in engine code.

## Stability

`@experimental` means one thing: the name may change or go in any version, with no migration note. Everything unmarked is frozen at 1.0.

- **How to see it.** The tag sits on the declaration, so an editor shows it; `api/*.md` prints `(experimental)`; the name's line in `docs/api-surface.txt` ends with it. A tag on a module or an engine member covers what hangs off it. A value or a sub-command has no line of its own, so its docs say so.
- **How it is kept.** The API lock (rule R55) lets a marked name change. Marking a stable name needs a line in the changelog: the mark takes a promise back.
- **Objects from other libraries**, which follow that library's version: `rigid.rapier / world / playerBody / playerCollider`, `nav.navMesh / query / tileCache / crowd / helper`, `assets.gltf / draco / ktx2`, `post.object / targets`, `shadows.csm`.
- **Effects still moving with three.js**: all of `threedog/tsl` and `@threedog/post-effects/tsl`.
- **Names nothing uses yet**: a public name no game, recipe, example or template used at 0.8 stays marked until one does; `docs/api-surface.txt` lists them.
- **Coordination no test game has used**: `engine.stacks`, `engine.wrap`, `time.channel / channels`.
- **Systems still settling**: `net()`, `engine.threads`, `grids()`, `hlod()`, `swarm()`, `stream.source / teleport / addReadyCheck / sources`, `post.own / antialias`, `world.simulate({ worker })`, `terrain.edit`, `ops.guard / allow`, `terrainDraw`, `vegetationDraw`, `weatherDraw`, `engine.bakeProbes / loadProbes / loadLightmap`.
- **Flat content**: an entry's `source`, `content stamp`, `content capture`.
- **Tuning and readings**: `engine.moduleOrder / moduleStates`, `player.saveMotion / loadMotion`, `jobs.loadingMs / maxSteps / slowStepMs`, `stream.unloadFactor`, `batching.held`, `world.steps`, `level.heightfield`.
- **Commands.** Only the `--json` and MCP shapes are an interface; printed text keeps changing for AI readers. An error's `code` string is frozen, its message is not.
