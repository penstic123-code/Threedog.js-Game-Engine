# Moving a game from 0.7 to 0.8

npm never had 0.7.1, so this page goes from 0.7.0 straight to 0.8.0.

First run `threedog doctor --fix`: it rewrites the `threedog` and `@threedog/*` pins in each game's `package.json`. A game in `games/` of a clone that still pins `^0.7.1` stops `npm install` with `ETARGET`.

Names were settled before 1.0: a few were removed, a few renamed. Nothing below keeps working under its old name. A stale uniform name in shader text reads 0 with no error and no warning, so search for the old names below.

## Uniforms

Search your shader strings as well as your JavaScript.

| 0.7 | 0.8 |
|---|---|
| `engine.uniforms.uCloudScale` | `uCloudShadowScale` (the cloud shadows on the ground) |
| `engine.uniforms.uCloudSpeed` | `uCloudShadowSpeed` |
| `uCloud` | `uWeatherCloud` |
| `uCurve` | `uSkyCurve` |
| `uCover` | `uGroundCover` |
| `uSunPower` | `uSunBrightness` |
| `uMoonPower` | `uMoonBrightness` |
| `uCloudScale`, `uCloudSpeed` on `engine.sky.uniforms`, or in `engine.sky.clouds()` and dome layer GLSL | `uSkyCloudScale`, `uSkyCloudSpeed` (the dome's clouds, the same names as on `engine.uniforms`) |

The same names apply to `uniforms(engine)` from `threedog/tsl`, `c.fx.uniform('...')`, and `#include <threedog_uniforms>`. A patch that brings its own uniform called `uCover` is yours and is left alone.

## Changed shapes

These do not fail loudly, so search for them.

| 0.7 | 0.8 |
|---|---|
| `const key = bag.add(id)`; `false` when full | `const r = bag.add(id)`: `{ ok: true, key, added }`, or `{ ok: false, code: 'full', facts }`. The result is always an object, so `if (bag.add(id))` is now `if (bag.add(id).ok)` |
| `clock.after(s, 'ev', data, { channel })` | `clock.after(s, 'ev', { data, channel })`, the same third argument as `clock.every`. The old form throws |
| `player.onStep = type => ...` | `engine.events.on('character:step', ({ character }) => ...)`, ground from `character.groundType()`. Assigning the old property does nothing and says nothing, so search for it |
| `player.onLand = impact => ...` | `engine.events.on('character:land', ({ character, impact }) => ...)`. Assigning the old property does nothing and says nothing, so search for it |
| `grids.get(name)`, `inventory.get(key)`, `container.get(key)`, `interactions.get(id)` return `null` when there is none | `undefined`, like every other `get`; a test `=== null` no longer matches, use `!x` |
| `settings({ presets: { high: { pixelRatio: 1.5 } } })`: a fixed ratio | A share from 0 to 1 of the ratio the engine picked for this device (`high: { pixelRatio: 1 }`); above 1 throws `module-params`. For a fixed ratio call `engine.setPixelRatio` |
| `settings.values` was the stored object; `settings.get('pixelRatio')` kept the last number set | `settings.values` is a read-only copy, change a value with `settings.set`; `pixelRatio` is the renderer's real ratio, the same as `describe().render.scale.current` |
| `mesh.visible` on a registered hlod mesh read `false` while far | It is your own value near and far. To ask whether the camera draws it: `mesh.layers.test(engine.camera.layers)` |
| `await engine.applyState(...)` resolved to nothing, and rejected for `season` with no calendar or an `at` nothing knows | It resolves to `{ ok, refused: [{ key, value, reason }] }`: read `refused`. A `fresh`, `wait` or `pos` it cannot read throws `state-value` |

## Removed names

| 0.7 | 0.8 |
|---|---|
| `engine.rays.cast(...)`, `engine.rays.pick(...)` | `engine.raycast(...)`, `engine.pick(...)` |
| `engine.THREE` | `import { THREE } from 'threedog'`, the same copy of three.js. |
| `model.userData.animations` | `model.animations`, three's own place: `model.clone()` keeps it, where `userData` broke the clips. Clips you add by hand go there too. |
| `engine.i18n.t(key)` | `engine.t(key)` |
| `inventory.slotsUsed` | `inventory.of().slotsUsed` |
| `engine.openWindows` | `engine.ui.isOpen(id)` |
| `engine.decoders` | set it with `createEngine({ decoders })`; it can no longer be read back |
| `EASINGS` | `ease(name)` |
| `assets.reportText(name)` | `assets.report(name)` |
| `assets.users(name)` | no replacement: it was internal |
| `player.object`, `character.object` | `.root`, the same object (`npc.object` stays) |
| `character.addTo()` | `engine.add(character.root)` for a `new Character` of your own; `addPlayer` still adds the player |
| `engine.rigid.R` | `engine.rigid.rapier` |
| `collision.circles`, `collision.boxes` | `collision.forEachStatic((type, data) => ...)` |
| `engine.stream.readyCheck(name, fn)` | `engine.stream.addReadyCheck(name, fn)` |
| `engine.music.addTracks({ a: url, b: url })` | `engine.music.define('a', url)`, one call per track; it no longer returns the music object |
| `debug.startBench()`, `debug.benchmarking`, the debug panel's stress button, `describe().debugPanel.benchmarking` | `threedog stress` |
| The types `Object3D`, `Vector3`, `Vector2`, `Color`, `Quaternion`, `Material`, `BufferGeometry`, `Texture` from `threedog` | import them from `three` |
| `threedog assets` with no verb | `threedog assets optimize` (it writes files) or `threedog assets check`. `npm run assets` becomes `npm run assets -- optimize` |
| `threedog doctor --json`: `{ healthy, items: [{ status, msg, fix }], render }` | `{ ok, summary, items: [{ level, message, fix }] }`, the shape of `check --json`. Items are the problems (`error`) and info lines (`warn`); passed lines are left out; `summary` says whether a hardware GPU is reachable |
| `engine.tick` | `engine.time.tick` |
| `engine.cpuMs`, `engine.cpuPhases` | `engine.inspect.perf()` (`cpuMs`, `cpuPhases`), `engine.budget.values().cpuMs` |
| `saves.queue(fn)` | `saves.putAttachment(group, id, blob, meta)`, `saves.removeAttachment(group, id)`; read with `saves.attachments(group)` |
| `saves.prefix` | `saves.storageKey(name)` for a key of your own |
| `userData.rayVisible = true` on a hidden object | Leave `visible` alone and put the mesh on `RESERVED_LAYERS.batched` (`threedog/layers`): not drawn, no shadows, still hit by `engine.raycast` |
| `engine.adaptive.paused` | `engine.adaptive.on = false` |
| `settings.removeSection(id)` | List the tabs you want: `settings({ sections: [...] })` |
| `sky({ moonSize })`, `sky({ starScale })`, `sky({ gradientCurve })`, `sky({ orbitTilt })`, `sky({ orbitSway })` | Write `engine.uniforms.uMoonSize.value`, `uStarScale.value`, `uSkyCurve.value`, `engine.sky.orbit.tilt`, `engine.sky.orbit.sway` (plain values after `engine.use(sky())`; defaults unchanged) |
| `saves.define(key, { movedFrom })` | No replacement. Only the calendar used it: the time and day of a 0.2 save, kept under the old `sky` part, are no longer read, and such a save starts from `calendar({ time })` |
| The old keys of `sky()` and `water()` (`sky({ fog })`, `sky({ sun })`, `sky({ layers })`, `sky({ dayLength })`, `water({ color })`, `water({ glsl })` and the like) | They are ordinary unknown options now: an error with a did-you-mean in development, one warning in a build. Recipes 08, 44 and 62 say where each value lives |
| `calendar.daysPerSeason` (the field) | Nothing read it and writing it did nothing. The option `calendar({ daysPerSeason })` stays |
| `ground.navGeometry` on a ground API of your own | Nothing read it: the navmesh comes from `staticTrimeshes()` |
| `settings.saved` | No replacement: nothing read it |
| `withHint` from `threedog/error-hints` | `hintText` |
| `threePatches.off('hlod-visible')` | The patch is gone: `hlod` hides a far original on the batch layer |
| `threedog bake light --spacing` | The bake traces rays now, so the option is gone, and `--samples` means rays per texel (default 128). Bake again and compare |

## Renamed

The table below keeps every rename; `engine.page.held` and `describe().page.held` are removed: ask `engine.frozen`, or `engine.stacks.get('freeze').has('page')` for this one holder. A page hold is now a plain freeze by owner `'page'`, so cutscene tweens and `runState` obey it, and `engine.step()` on a page in the background needs the loop stopped first, as the dev bridge already does.

| 0.7 | 0.8 |
|---|---|
| `hud.add(id, n)` | `hud.bump(id, n)` |
| `dialogue.cps` | `dialogue.charsPerSecond` (the option already had this name) |
| `rtsCamera({ angle })`, `cameraRig.angle` under that camera | `pitch`, as on the other cameras; `angle` is now refused as an unknown option |
| `weather.define(field, spec)` | `weather.defineField(field, spec)` |
| `terrain.T` | `terrain.generator` |
| `terrain.CHUNK` | `terrain.chunkSize` (`createTerrain()` keeps its own `CHUNK`) |
| `engine.pause(owner)` | `engine.haltLoop(owner)`, for tests and tools. It stops rendering too, so a game that wants to pause uses `engine.freeze` or flow `'paused'`. The `{ kind: 'test' }` option is gone |
| `engine.paused`, `describe().time.paused` | `engine.halted`, `describe().time.halted` |
| `engine.mod('pause', ...)`, `describe().holds.pause` | `engine.mod('halt', ...)`, `describe().holds.halt` |
| `runState.state` `'test-paused'`, `'paused'` | `'halted'` (the loop is stopped), `'frozen'` (a game, page or error freeze) |
| `engine.terms`, `terms.cloudShadow`, `terms.season` | `engine.shaderTerms`, with the same two members |
| `engine.view`, `view.manual` | `engine.autoView`, `autoView.manual` |
| `lightPool.usage()` | `engine.describe().lightPool` |
| `terrain.isReadyAround(p)`, `rigid.groundReady(p)` | `engine.stream.addReadyCheck` and `stateApplied` already wait on them |

## Error codes

Search any `e.code === '...'` or `catch` in your game, and any test that names a code.

| 0.7 | 0.8 |
|---|---|
| `options-object` | `bad-position` |
| `npc-option` | `character-option` |
| `pickup-prop-id` | `world-id` |
| `session-handle` | `module-handle` |
| `world-missing` | `module-needs` |
| `load-failed` | `asset-load` |
| `pause-owner` | `halt-owner` |
| `bad-arg` | Gone: `input.bind` raises `input-keys`, `characters.support` raises `character-option`, `settings({ presets })` raises `module-params` |
| `state-at` | Gone: `applyState` lists the value in `refused` |
| `renamed-field`, `shadow-type` | Gone, nothing raises them: the old names they caught are plain unknown options now |
| `engine.stacks.define` of a known name raised `mod-owner` | `engine-misuse` |
| `weather.set` with bad seconds raised `module-params` | `weather-option` |
| `interaction.use` answered `noKey` | With no key it runs when code asks, `ops.list({ available: true })` leaves it out, and `interaction-no-key` is a dev warning. Code that read `noKey` reads `engine.input.isUnbound(action)` |
| `ground-missing` threw (a prop, spawn or `snapToGround` beyond `terrain({ shape })`) | A warning, and the safe fallback runs: a `catch` for it no longer fires |

These used to throw and now warn once in dev and go on: `engine.wrap` on a `_private` method, `createEngine({ fallback })` without WebGPU, a vegetation `rule` beside `positions`, `ui.theme.promptHeight`, a module going against its `type`, `engine.sky.environment()` called twice (the second replaces the first), and `sky({ time })` with a calendar.

## Behaves differently

No error tells you about these.

| 0.7 | 0.8 |
|---|---|
| Physics ran at full speed under `engine.mod('time.world', ...)` | Rigid bodies and vehicles follow the `world` channel, and a hit-stop at speed 0 holds them. To keep them at full speed, slow a channel of your own |
| `engine.freeze(owner, { ambient: true })` left skeletal animation and particles moving | A real still: they stop with `uTime`. A plain freeze keeps them moving as before |
| `engine.batching` cell 64 m | 256 m, about 13-25% more triangles drawn. A game with heavy props sets `createEngine({ batching: { cell: 64 } })` |
| `engine.remove` disposed a shared geometry or material at once | It disposes with the last user. Code that relied on the old timing disposes it itself |
| `engine.stream` unloaded in the same frame | Through `engine.jobs`, so an entry out of range can stay a few frames longer in the real-time loop; `engine.step` still finishes in the frame |
| A low-tier device lowered `particles.define` `max`, `weather({ particles })`, a weather `count` and `sky.environment({ interval })` | It changes defaults only: these stand as the game gave them |
| A skybox reached full brightness at ambient 1.2 | At the brightest row of the game's keyframes |
| `engine.setPixelRatio(p)` was undone by adaptive resolution within two minutes | It is the top adaptive climbs back to; adaptive may still lower it under load |
| Settings stored every value | Only what the player changed, with a preset stored by name. Stored files of version 1 are read: a value equal to the default lets go |
| `music.play`, `music.stinger`, `hud.counter`, `hud.bar`, `calendar.at`, `calendar.daily`, `calendar.between`, `vegetation.removeInstance` ignored an unknown option | They throw on it |
| A class instance in a saved `world` record (`Vector3`, `Color`, `Map`) failed after a load | It throws `world-plain` in dev at `world.add` / `world.set`. Write `{ x, y, z }`, or add the record with `{ save: false }`. `position` stays free |
| A direct write to `engine.sky.sunDir` was undone on the next frame | It is the same vector as `engine.uniforms.uSunDir` and the write stays; `engine.autoView.manual('sunDir', false)` gives it back |
| An `approach` interaction on a held character walked or hung | Refused with `cannotWalk` |
| `characters.findPath` with no navmesh routed to a target inside a wall or water | `null` (`noPath` when detailed) |
| `hud.counter` with no label showed the id | The value alone |
| A quest reward that threw stopped the rest of the list | `content.run` runs every effect, rethrows the first error, and the quest still finishes |
| `inspect.perf()` on a halted page read `cpuMs` and `fps` as 0 | `null`, and `measured` says whether anything was counted |
| Two manifest entries naming each other as `fallback` waited for good | The load fails once with `asset-fallback-cycle`, naming the chain |
| An awaited `model()`, `texture()` or `font()` could reject or resume while the engine was disposed | The promise stays pending for good, and so does any later call: put teardown work in your dispose path, not after the `await` |
| A load ended by `release`, `trim`, a palette write or registering the name again could write its result back | Its result is freed when it arrives; code awaiting it gets a fresh load |
| `release('shrub')` on a name that fell back to `rock` touched `rock`'s data | A name that fell back holds no data: release `rock` |
| A mesh dropped while its material stayed in use held memory on WebGPU | The engine sweeps these every few seconds, so calls you added to work around it can go; `threePatches.off('webgpu-record-sweep')` turns it off |

## Tools

| 0.7 | 0.8 |
|---|---|
| `assets optimize` put the optimized pack anywhere in `assets.js` | It comes last, so `/optimized/x.glb` wins over an original of the same name; the next run moves an older game over |
| `assets optimize --strict` or a lower `--budget` skipped cached models | Cached models count, so a run that passed may now fail |
| `check` passed a kind in `content/index.js` listed without `rules` | An error |
| `check` in a game failed on file size, its own docs, a stale GAMEMAP, a module with no key, or startup creation | Warnings: a CI step that relied on one reads the warnings. New rules: R52 (captured twice), R53 (merge conflict markers in a tracked file) |
| `state`, `step`, `hold`, `press` and scenarios reported success when they did less | They fail with the reason and exit 1: a refused state, seconds that did not pass, a stopped engine |
| `shot` and `capture` ignored a value the page refused (`--weather rian`) | They fail |
| `threedog state` and `threedog snap` added a tick or two | They move no game time, so a script that counted on it steps itself |
| `lib pull` copied an entry the game's renderer cannot draw | Refused, nothing copied; `--force` copies it to port by hand, and `lib check` fails until it is ported |

## Stability

`@experimental` now means one thing everywhere: the name may change or go in any version with no migration note. See "Stability" in `CONVENTIONS.md` for the list. Nothing stops working, but do not build a save format on a marked name. The printed text of commands was never an interface: read `--json`.
