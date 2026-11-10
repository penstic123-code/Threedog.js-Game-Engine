# Engine API index (generated, do not edit by hand; produced by npm run map)

> A new feature starts at `AI.md` or `threedog how`; this page is for looking up a name.
> The api pages are generated too, do not edit them by hand; `?` in a signature means optional, what follows `→` is the return value; the full types are in `types/*.d.ts`.
> One line per core object / module; for the one you need, **read only that page** `api/<name>.md`.
> Paths are relative to the package (`node_modules/threedog/`). Entry: `import { createEngine, openWorld, … } from 'threedog'` (the engine package's own examples use relative paths); a module the game needs is installed with `engine.use` before `await engine.start()`; `engine.xxx?.method()` is only for a feature the game works without, and a required module left out that way fails in silence.
> By task: ordinary picture is plain three.js (`THREE.md`); game rules are `onFixed`, `ops`, `world`; modules are `use` and `ctx.track`; drawing of your own is at the end of the module list; to troubleshoot, `describe` gives state and `explain` why.

## Core everyday API (all methods, properties, createEngine options and how to write a module are in [api/engine.md](api/engine.md))
- `createEngine(opts: EngineOptions) → Engine` — creates the engine (core only); options: canvas ui loading saveKey headless budget …
- `openWorld(opts: OpenWorldOptions) → ModuleDef[]` — open-world preset (world and environment + basic modules; add gameplay modules yourself; `xxx: false` turns one off), options in [api/openWorld.md](api/openWorld.md)
- `engine.use(...mods: (ModuleInput | { replaces })[])` — Install one or more modules
- `engine.start() → Promise<this>` — Start: initialize modules, preload assets, wait for the world to be ready
- `engine.step(seconds: number, opts?: { render?, frameEvery?, describe? }) → GameState | null` — Advance seconds of fixed-step time synchronously
- `engine.describeText(opts?: { radius?, full?, path? }) → string` — The same information as English text, summary first: at most 30 lines…
- `engine.applyState(params: StateParams) → Promise<{ ok: boolean, refused: {…` — Set up a scenario: time of day, weather, player position, load a save, advance time, skip cutscenes
- `engine.onFixed(fn: (dt: number) => void, opts?: { channel?, phase? }) → Handle` — Fixed-step logic (60 times per second, dt in fixed seconds): movement, physics, cooldowns, and game…
- `engine.onFrame(fn: (dt: number) => void) → Handle` — Once per frame
- `engine.add(obj: T, ...more: (Object3D | { id?, save? })[]) → T` — Add objects to the scene and register them (engine.thing), returns the first one
- `engine.remove(...objs: Object3D[])` — Fully delete an object (use it when you no longer want the object): removes it from its parent, unr…
- `engine.surface(x: number, z: number, refY?: number) → number` — Ground height (meters) at (x, z)
- `engine.snapToGround(obj: T, offset?: number) → T` — Put an object on the ground under it (y = ground height + offset) and return the object
- `engine.raycast(origin: Vec3Like, dir: Vec3Like, opts?: RaycastOptions) → RayHit | null` — Ray: shoot from origin along dir, returns the nearest hit or null…
- `engine.pick(ndcX: number, ndcY: number, opts?: RaycastOptions) → RayHit | null` — Shoot a ray through the camera from screen coordinates (-1..1, e.g. input.pointer.ndcX/ndcY)
- `engine.freeze(owner?: string | { owner?, kind?, still? }, opts?: { kind?: 'title'; still?: boolean }) → OwnerHandle` — Gameplay pause (menu, flow's paused): fixed steps are skipped entirely…
- `engine.haltLoop(owner?: string | { owner?: string }) → OwnerHandle` — Pause the real-time loop: the picture stops and even rendering stops, only step() advances…
- `engine.stateApplied` — Scenario is ready: start() completed, and the URL parameters / the latest applyState have all been …
- `engine.ready` — phase is 'ready' or 'running': the world is built and the loading screen is gone…
- `engine.player` — The player (exists only after characters.addPlayer())
- `engine.scene` — three.js scene
- `engine.camera` — The camera the engine draws with, a plain THREE.PerspectiveCamera to begin with

## Core objects (engine.xxx, no install needed)
- [`engine.events`](api/events.md) the event bus: traceFocus note trace recent on once emit; event table
- [`engine.input`](api/input.md) Input: read by "action": define bind touchButton simulate seat rebind rebound keysOf isUnbound label down pressed released pressedRaw …
- [`engine.clock`](api/clock.md) calendar seconds and "after how long / every how long": after every
- [`engine.vars`](api/vars.md) story flags and counters (autosaved): flag setFlag counter bump
- [`engine.saves`](api/saves.md) engine.saves handles saving: define putAttachment removeAttachment attachments storageKey flush collect check apply save load list remove export …
- [`engine.assets`](api/assets.md) Assets: manifest builder paramsOf setParams preload font model lod modelNow onModel geometry gridFromImage texture useTexture …
- [`engine.audio`](api/audio.md) buses: addBus setVolume duck condition measure value matches volumeOf sfx noiseBurst tone load play
- [`engine.i18n`](api/i18n.md) string tables: add setLocale has
- [`engine.rays`](api/rays.md) engine.rays is the ray registry…: addStatic addProvider
- [`engine.jobs`](api/jobs.md) engine.jobs queues build work in a binary heap: add run
- [`engine.stream`](api/stream.md) engine.stream builds on demand by space: only entries n…: add source teleport addReadyCheck sources
- [`engine.budget`](api/budget.md) performance budget (turned on by createEngine: enable disable metric limitOf report checkStartup values record notice byTag
- [`engine.post`](api/post.md) PostFX: object targets add get byRole own list render
- [`engine.occlusion`](api/occlusion.md) Occlusion
- [`engine.ground`](api/ground.md) Ground provider: whoever provides the ground height is …: height slope type water has voidY forEachCollider viewRange chunkCollision staticTrimeshes staticVersion

## Modules (installed with engine.use; the openWorld preset installs only world and environment, see [api/openWorld.md](api/openWorld.md))
- [`engine.terrain`](api/terrain.md) terrain() Procedural terrain, data part: recolor view retry rebuild edit
- [`engine.vegetation`](api/vegetation.md) vegetation() Vegetation: sway color view rebuild setShadowRing define get list isRemoved removeInstance restoreInstance instanceAt …
- [`engine.sky`](api/sky.md) sky() Sky dome and the sun / daylight / sky-color signals, from the calendar's time; it writes no light or fog: keyframes clouds layer replace environment
- [`engine.calendar`](api/calendar.md) calendar() Time of day, day, seasons and clock-time timers: at between daily onSeason untilMark
- [`engine.weather`](api/weather.md) weather() Weather state: defineField set label
- [`engine.water`](api/water.md) water() Water surface: shader normalMap
- [`engine.world`](api/world.md)  World data: add origin idOf get set move remove query forEachNear present view refresh …
- [`engine.net`](api/net.md)  net: reconnect
- [`engine.grids`](api/grids.md)  grids: add get list define preview
- [`engine.collision`](api/collision.md) collision() Lightweight collision: addCircle addBox addSegment addBlocked blockedAt addObject forEachStatic mirror walkable walkableAt lineClear
- [`engine.rigid`](api/rigid.md) rigid() Real physics, Rapier: addBox addBall addHull ragdoll impulse setPosition addWheeled
- [`engine.collider3d`](api/collider3d.md)  collider3d: addSolid overlap sweep
- [`engine.cameraRig`](api/cameraRig.md) followCamera() / firstPersonCamera() / fixedCamera() / rtsCamera() Current camera: follow forward right focusPoint screenToGround update onOverride onEnter onExit
- [`engine.timeline`](api/timeline.md) timeline() Cutscenes, tweens: tween play skip
- [`engine.level`](api/level.md) level() Hand-built level: marker markersWith unload load track
- [`engine.triggers`](api/triggers.md) triggers() Trigger zones: list add clear byTag fromMarkers
- [`engine.particles`](api/particles.md) particles() Particles: define has emit attach count clear
- [`engine.swarm`](api/swarm.md)  swarm
- [`engine.settings`](api/settings.md) settings() Settings menu: get set preset define addSection open close toggle reset resetBindings rebind actionList …
- [`engine.music`](api/music.md) music() Background music: define play stop stinger rules override pick
- [`engine.characters`](api/characters.md) characters() Characters: findSpawn addPlayer moveInput addVehicle support removePlayer findPath findPathAsync; Character, NPC; engine.npcs: list add remove behavior tiers get character avoid (behavior and avoid: see recipes/02-npc)
- [`engine.interactions`](api/interactions.md) interactions() Interaction prompts: add get
- [`engine.dialogue`](api/dialogue.md) dialogue() Dialogue: define start say bubbles end
- [`engine.inventory`](api/inventory.md) inventory() Inventory: of define item count has list get add remove trade setData container …
- [`engine.pickups`](api/pickups.md) pickups() pickups: spawn nearest
- [`engine.quests`](api/quests.md) quests() Quests: define start state advance isDone isActive isFailed check list
- [`engine.photo`](api/photo.md) photo() Photo mode: take trace subject
- [`engine.ambience`](api/ambience.md) ambience() Ambience: add rules nearWater
- [`engine.nav`](api/nav.md) nav() Navmesh: findPath dispose
- [`engine.hlod`](api/hlod.md) hlod() hlod: add
- [`engine.lightPool`](api/lightPool.md) lightPool() Light pool: add
- [`engine.content`](api/content.md) content() Content loading: load condition test run place where template fields spawn
- [`engine.flow`](api/flow.md) flow() Game flow and scene transitions: define go transition
- [`engine.hud`](api/hud.md) hud() Objective markers, counters, progress bars: marker addCounter bump value bar button hint remove

## Custom drawing (only to replace how a module draws: the facades above are the entry; `engine.use(mine, { replaces })`, recipe 28 §6)
- [`engine.terrainDraw`](api/terrainDraw.md) terrain() terrainDraw: recolor
- [`engine.vegetationDraw`](api/vegetationDraw.md) vegetation() vegetationDraw: mesh kind
- [`engine.weatherDraw`](api/weatherDraw.md) weather() weatherDraw

## Other
- [Utility functions](api/tools.md): PICTURE_SLOTS presets world net fakeNetwork webSocket grids swarm screenToGround sampleGrid ease checkOptions contentParts readParams threePatches createTerrain terrainMaterial mergeColored applyEffects rampTexture bakeVertexAO materialPatches toast makeWindow …
