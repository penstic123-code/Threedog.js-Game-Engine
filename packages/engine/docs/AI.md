# threedog.js tasks (on demand)

threedog.js: a web 3D game engine on plain three.js 0.187, **core** -> **modules** (`engine.use`); all art is the game's own.
Paths: `node_modules/threedog/docs/`. `threedog how "<2-4 English words>"`; no words: browse.

## Three rules
1. **Each thing has a name**: `engine.describe()` lists it; `engine.explain({ module: name })` says why.
2. **Each thing has an owner**: `add*` / `on*` return a handle, `h.remove()` undoes it (except `engine.add`, `world.add`, `addPlayer`: CONVENTIONS.md); `define` names a kind.
3. **What several sides change has one owner**; the rest use it: values `engine.mod` (add / mul / clamp by layer), services `provides` / `replaces`, control and keys: top layer; time: one clock.
Verbs: `define`, `add`, `set`, `remove`, `describe`.

## Common mistakes
- `Math.random()`, `setTimeout`, `performance.now()`, `addEventListener('keydown')` in game logic: `engine.random.next()`, `engine.clock.after`, fixed `dt`, `input.bind`.
- Changing gameplay state from a frame hook or a raw callback: do it in `onFixed`, in an op, or via `engine.nextFixed(fn)`.
- Saving positions or object references: save stable ids; `await` every `saves.*` call; a mesh a save must know about gets `engine.add(obj, { id })`.
- Awaiting `level.load` / `content.load` in a save part's `load(data, turn)`: pass `{ turn }`, or it waits for ever.
- Guessing a name: `how --read <name>`, `api/<module>.md`; errors carry `err.code` / `fix` / `docs`.
- Generated docs (API.md, api/, CODEMAP): edit the source, then `npm run map`.

## Reading order
A row or `threedog how` -> recipe -> `api/<module>.md`. Also: `CONVENTIONS.md`, `THREE.md`, `COMMANDS.md`.

## What exists: look here first
### Which one
| To do | Use | Recipe |
|---|---|---|
| Say it happened, no answer; cause chain, randomness | `engine.events`, `engine.random.next()` | 06-clock-events.md |
| Player actions, UI buttons (can refuse) | `engine.ops.define` | 23-ops.md §1 |
| A value several systems change; one-holder parts | `engine.mod`, `engine.stacks`, `provides`, `wrap` | 55-mods-time-wrap.md §"The rules in full" |
| Content: items, NPCs, places, packs; change an entry for good | `engine.content`, `threedog content set` | 20-content-actions-save.md §1b |
| Save game, load game, autosave, story flags, counters | `engine.saves.define`, `engine.vars` | 20-content-actions-save.md §4 |
| Preferences outside the save; turn off my effect | `engine.settings` (`limits: 'post.x.enabled'`) | 26-ui-parts.md §6 |
| Timers, skip time; game time: rules, AI | `engine.clock` (after, every), `engine.onFixed(dt)`, `engine.time.now(…)` | 06-clock-events.md §1 |
| What shows: animation, camera, HUD (`engine.stepBlend`) | `engine.onFrame` | 06-clock-events.md §1 |
| Picture per frame | `engine.onRender` | 62-picture-code.md §0 |

### Picture and sound
| To do | Use | Recipe |
|---|---|---|
| The picture in three.js (`picture/`): lights, fog, exposure, parts | `lights: false`, `engine.uniforms` | 62-picture-code.md §0, 34-environment-lighting.md |
| Picture, writers; try a value | `describe().picture`, `explain({ value })`, `debug.watch`, `debug.override` | 52-around-the-picture.md §"Who writes it", 62-picture-code.md §3c |
| Materials, textures, a module's picture | `engine.water.material` | 09-materials-lights-models.md §1 |
| Own material or shader (toon, cel shading) | TSL (WebGPU), `ShaderMaterial` (WebGL), `rampTexture`, `celLighting` | 43-shader-patches-surfaces.md §"Your own material", 56-webgpu-tsl.md §"A minimal TSL material" |
| WebGPU (new games' default), TSL node materials, WebGL fallback | `renderer: 'webgpu'`, `import 'threedog/tsl'` | 56-webgpu-tsl.md §"WebGPU or WebGL" |
| three.js idioms, own renderer | the idiom table in `THREE.md`, `createEngine({ renderer })` | 50-own-renderer.md |
| Dust, smoke | `engine.particles` | 64-particles.md |
| Sky, season tints, weather, wet roads | `engine.sky`, `engine.weather`, `engine.weatherDraw` | 08-weather-sky.md §1 |
| Water, rain, snow cover (own rain: `THREE.md`) | `engine.water`, `weather({ rain, snow })` | 44-water-weather-hooks.md |
| Shadows: blur, follow, cost | `engine.shadows` | 45-cascaded-shadows.md |
| Own far, fov; clouds | `engine.autoView`, `engine.shaderTerms` | 52-around-the-picture.md §"Atmosphere" |
| Environment light, reflections, probes, lightmaps, GI, culling | `engine.sky.environment`, `engine.bakeProbes`, `engine.loadLightmap`, `engine.occlusion` | 34-environment-lighting.md §"Environment maps" |
| Post passes: color grading, bloom, outline, depth, AO | `engine.post.add(pass)`, `@threedog/post-effects` | 52-around-the-picture.md §"Post effect chain", 59-depth-post-effects.md |
| Many lights (torches); windows, signs at night | `engine.lightPool`, `uNight` | 09-materials-lights-models.md §1b |
| Picture from a reference; judge | `threedog picture palette`, `threedog examples list` | 35-picture-from-reference.md §"The loop", 60-judge-the-picture.md |
| Reuse effects, models of old games | `threedog lib` | 05-props-bake.md |
| Sound, music, ambience | `engine.audio`, `engine.music`, `engine.ambience` | 31-audio.md |

### Rules, state, time
| To do | Use | Recipe |
|---|---|---|
| Items, chests, shops, gold; things to pick up | `engine.inventory`, `engine.pickups` | 03-items-pickups.md §"Items and pickups", 22-shop-gold.md |
| Quests, objective markers | `engine.quests`, `engine.hud.marker()` | 04-quests.md §1 |
| What can the player do here, why not | `engine.inspect`, `engine.explain`, `engine.catalog` | 51-capability-catalog.md §1 |
| New game / continue, scene flow, fades, pause for a menu, cutscenes | `engine.session`, `engine.flow`, `engine.freeze`, `engine.timeline` | 07-flow-scenes-pause.md §4 |
| Slow or speed up time, bullet time | `engine.mod('clock.rate')` | 55-mods-time-wrap.md §"Time channels" |
| Time of day, day / night, seasons | `engine.calendar` | 08-weather-sky.md §4, 06-clock-events.md |
| Multiplayer | `engine.net` | 27-net.md §1 |

### Characters, input, UI
| To do | Use | Recipe |
|---|---|---|
| Third-person start (player walks, walking player, pause) | `addPlayer` | 63-third-person-start.md §1 |
| Player, characters | `engine.player`, `engine.characters`, `engine.control` | 57-control.md §"Who takes what", 13-animation.md |
| Keys, gamepad, rebinding, seats | `engine.input` | 58-input.md §1 |
| Camera: followCamera (third person), first person, fixedCamera, rts; setCamera | `engine.cameraRig`, `engine.page` | 21-camera.md §1 |
| 2D, side-scroller, orthographic; 2D lights | `presets.player.sideScroller`; example `rc2d` | 21-camera.md §6 |
| Pixel art | `pixelSize`, `pixelSnap` | 62-picture-code.md §4b |
| Skeletal animation, IK | `engine.assets.animate`, `anim.addAim`, `.addFeet`, `engine.hlod` | 13-animation.md §3, 15-perf.md |
| Pathfinding, navmesh, NPC jumps and gaps, gates | `engine.characters.findPath`, `engine.nav` | 12-navmesh.md §2 |
| Physics, ragdoll, collision, vehicles | `engine.collision`, `engine.rigid`, `engine.collider3d` | 11-vehicles.md §3 |
| Ray / mouse picking, shooting, lock-on | `engine.rays` | 19-shooting-picking.md §1 |
| Prompts, trigger zones | `engine.interactions`, `engine.triggers` | 20-content-actions-save.md §3 |
| Press E on a mesh | `interactions.add(mesh, { once, counter })` | 03-items-pickups.md |
| Reskin UI | `createEngine({ ui: { theme } })` | 26-ui-parts.md §"Reskin" |
| Start at a place | `?at=<place>` | 07-flow-scenes-pause.md §2 |
| NPC conversation: talk to an NPC, what NPCs do | `engine.npcs`, `engine.dialogue` | 02-npc.md §1 |
| Speech bubble over a head, barks | `dialogue.say(text, { channel: 'bubble' })` | 26-ui-parts.md §4 |
| UI, menus, HUD, languages, settings, photo mode | `engine.ui`, `makeWindow`, `toast(engine, text)`, `engine.hud`, `engine.i18n`, `engine.settings`, `engine.photo` | 26-ui-parts.md §1, 26-ui-parts.md §6 |
| Action game: hp, attacks, enemy AI, drops | your ops + `world.simulate` | 32-action-game.md §1 |
| Ambient occlusion, soft shadows | `engine.post.add(ao())`, `bakeVertexAO` | 52-around-the-picture.md |
| Many bullets, debris | `engine.swarm` | 65-swarm.md §"Which tool for many things" |
| Enemy crowds, flocks | `engine.swarm` | 65-swarm.md §"Which tool for many things" |

### Project, world, content
| To do | Use | Recipe |
|---|---|---|
| New game, project layout, preset start | `npx threedog init` (repo: `new-game`), `createEngine`, `openWorld()` | 01-new-game.md §0 |
| Put something in the scene | `scene.add(obj)`; saved: `engine.add(obj, { id })` | 40-scene.md §1 |
| Reusable objects (prefabs), groups of them | `templates`, flat `props` | 30-templates.md §1 |
| Props, many repeated objects, static batching | content `props`, `engine.batching` | 05-props-bake.md §2b |
| What is this thing, does it persist | `engine.pick(x, y)`, `engine.explain({ thing: id })` | 30-templates.md §5, 40-scene.md §9 |
| Teleport the player, far-away and saved objects, streaming | `player.placeAt`, `engine.stream.teleport`, `engine.world` | 18-world.md §6, 33-stream-sources.md |
| Blender level | `engine.level` | 10-blender-level.md §1 |
| Grass, trees | `engine.vegetation.define` | 05-props-bake.md §2e, 36-ground-plants.md |
| Terrain, height | `engine.terrain`, `engine.ground` | 28-terrain.md §2 |
| Ground picture | `engine.terrain.material`, `terrain({ detail, shape })` | 36-ground-plants.md §"Ground color", 53-ground-up-close.md |
| Grid placement, plots, build on cells; a grid from a PNG | `engine.grids`, `sampleGrid`, `assets.gridFromImage` | 29-grid.md §1, 28-terrain.md §9 |
| Assets, loading; code-made models; LOD; setup per model | `engine.assets.manifest`, `.onModel`, `.palette`, `.lod`, `engine.loading` | 05-props-bake.md §3, 15-perf.md |
| Blender -> GLB art; fixed views before / after | `threedog assets check`, `engine.views`, manifest `needs` | 46-blender-art-route.md §1, 05-props-bake.md §2f |

### Composing modules
| To do | Use | Recipe |
|---|---|---|
| Replace a module (dialogue, camera) | `replaces`, `runContract` | 55-mods-time-wrap.md §"Replacing a module" |
| Your own module: `type`, `requires`, swap a part (`provides` + `{ replaces }`) | `engine.use`, `.unuse` | 14-custom-module.md §1, 49-game-module-contract.md |
| Drop-in file per piece, no main.js | `plugins/`, `engine.plugins`, `describe().slots` | 40-scene.md |

### Advanced
| To do | Use | Recipe |
|---|---|---|
| Own ground or plant drawing, keep collision | `engine.terrain.view`, `engine.terrainDraw`, `engine.vegetationDraw` | 28-terrain.md §6 |
| Worker results, far records' models, raw navmesh or physics, content sections, own mover | `ctx.commits`, `world.present`, `nav.query`, `rigid.world`, module `content`, `characters.kit` | 15-perf.md, 18-world.md, 12-navmesh.md, 11-vehicles.md, 14-custom-module.md, 57-control.md |

### Troubleshooting and speed
| To do | Use | Recipe |
|---|---|---|
| Broke; describe, explain, shot: which tool | `.threedog/errors.log`, `engine.describe`, `engine.explain` | 16-dev-bridge.md §11 |
| Picture looks wrong: judge it | `threedog shot` | 60-judge-the-picture.md §"How to judge" |
| Drive and check the live game | the dev bridge (`verify <scenario>`) | 16-dev-bridge.md §1 |
| Slow, low fps | `engine.jobs`, `engine.threads`, `engine.budget`, `engine.debug` | 15-perf.md §1 |
| Deploy | `npm run build` | 61-deploy.md |

## Conventions (`CONVENTIONS.md`)
- **A position is one argument**, then an options object. **Units** are meters, Y up, north -Z; characters face +Z.
- **Ready is `ready`**. **Events are `noun:action`**. **`owner`** is the name you pass.

## Stability
`@experimental`: may change or go with no migration note.
