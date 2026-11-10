# Performance investigation (F3, budget, profile, describe().perf)

> **Covers:** finding what makes the game slow, limits that warn, baselines, common fixes, less detail far away.
> **Use when:** the game is slow or you want limits that warn.
> **Shortest:** `createEngine({ budget: { drawCalls: 250, fps: 55 } })`, then `engine.budget.report()`.
> **Sections:** 1 Where things stand · 2 Set a budget · 2a Slower than before · 3 Whose CPU is · 4 Common fixes · 4a Less detail far · 4b Render scale and · 5 Verify once before

Order: numbers first (which category is over: fps, draw calls, CPU, startup?), then who takes the most; after a change compare the same way (section 5).
Which renderer measures: `threedog shot`, `perf`, `stress` and `gallery --shots` use the hardware GPU when headless can reach it (`threedog doctor` says; `--gpu`). On a machine without one, ask the user to press F3 in the browser (bound by `createEngine({ bindings: { ...presets.bindings.debug } })`; the open-world template does).
What this machine can carry: `threedog stress` (COMMANDS.md) prints where 16.7 / 33 ms are crossed for each kind of load. Turn the row for your target machine into `engine.budget` limits (section 2).

## 1. Where things stand
- **One report with verdicts**: `engine.inspect.perf()` / `threedog inspect perf`: draw calls (shadow and post passes included), triangles, programs,
  texture memory (estimate), JS ms per phase, the dearest modules, compile stalls during play (`startup.compileMs`), the costliest programs, one line per budget
  (`✗` with the next call; your `engine.budget` limits, else a desktop 60 fps reference, not enforced). Plain three.js: `renderer.info`. Textures: `engine.inspect.materials()`.
- **Which materials cost**: `engine.debug.view('shaderCost')` colors materials green -> red by compiled program cost (gray = not compiled yet);
  `engine.debug.view('overdraw')` shows pixels drawn many times over. `'off'` restores. Real GPU timings: `threedog capture` (Spector.js) or the browser's GPU profiler.
- **Other view modes**: `debug.view('triggers')` shows hidden zones (`triggers({ debugColor, debugOpacity })` colors them); modules add their own (`engine.debug.defineView(name, { what, apply })`);
  `engine.debug.viewModes()` lists them.
- **F3 panel** (`engine.debug.panel`; `debug()` module, dev builds, null without it; action `debugPanel`): frame rate, CPU ms, draw calls, triangles,
  chunks, vegetation instances, time of day; with a budget set, over-limit items and startup time.
- **Text**: `engine.describe().perf` =
  `{ fps, cpuMs, cpuFrames, cpu, apply, drawCalls, triangles, pixelRatio, gpuMemory, budget, notice, startup, stream, batching, jobs, commits, chunks?, vegetation? }`
  (`cpuMs`: median of `cpuFrames` frames, as in `inspect.perf()` and F3; `cpu`: last frame by phase);
  also the Perf line of `threedog shot --describe-only` (headless: fps and cpu are `-`).
- **One line when something is off**: `engine.budget.notice()` (`describe().perf.notice`, printed by `describeText`, `shot`, `verify`), null when all is fine:
  `Perf: over budget drawCalls 312 (limit 250, +25%); slower than baseline: ...; spiky: ...; lowered automatically: reflections cheaper, resolution 1.5 -> 1.2 (...)`, against your own limits and baseline (2, 2a).
- **CPU time of a frame**: `engine.inspect.perf().cpuMs`, main thread from input to the afterRender hooks (no GPU time); `cpuPhases` splits it:
  `fixed` (input + fixed steps), `frame` (frame hooks, stream, jobs), `render` (draw submission, uploads, shader compiles), `afterRender`.
  `npm run perf -- --only=stream` measures the stream-in numbers below.
- **Applying background results** (`engine.budget.cost.report()`, `describe().perf.apply`, budget categories `applyBuildMs` ...): what the main thread
  pays for chunks, vegetation, colliders and stream builds, in stages `transit` (worker round trip minus its compute, approximate), `build` (three.js
  objects), `collider`, `upload` (readying streamed textures and shaders, plus the extra render time of frames that first draw new objects), `stream` (sync part of a `stream.add` build).
  Per stage: `n`, `totalMs`, `maxMs`, smoothed `frameMs`, `bytes` (transit).
- **Startup**: `engine.startup` = `{ totalMs, startMs, preloadMs, streamMs, compileMs, firstFrameMs, phases, modules: { name: { init, ready } } }`. `firstFrameMs` is page open to the first frame drawn after the loading screen, and `phases`
  splits it into parts that add up to it: `script` (page open until `createEngine`), `construct`, `setup` (game code until `start()`), `init` (saves,
  renderer, module init), `preload`, `world` (nearby builds), `compile` (shaders + hidden warm-up frame), `draw`. `inspect.perf().text` prints the line.

## 2. Set a budget (so going over reports itself)
Off by default and costs nothing. Only the categories given are checked; `gpuMemoryMB` is three's own byte count (WebGPU only, not driver VRAM):
```js
const engine = createEngine({ canvas, budget: { drawCalls: 250, fps: 55, low1: 30, triangles: 600000, gpuMemoryMB: 512, rigidBodies: 300, startupMs: 5000 } });
// or at runtime: engine.budget.enable({ drawCalls: 200 });
const r = engine.budget.report();  // { ok, over: [{ category, value, limit, top }] }; going over also prints one console hint
```
`top` lists the biggest draw-call users grouped by an object's `userData.budgetTag`. Tag your own things to see who it is:
```js fragment
house.userData.budgetTag = 'houses';  // children inherit the parent's tag; untagged ones count as 'other'
engine.budget.byTag();  // [{ tag, drawCalls, triangles }...], largest first
engine.budget.metric('fishCount', () => fish.length, { limit: 50 });  // a module's own category
engine.budget.enable({ modules: { terrain: 1.5, vegetation: 2 } });  // ms per frame of one module (median of engine.profile(), section 3; a fixed-step module counts its dearest single step, catch-up steps are not added)
```

## 2a. Slower than before (a baseline on this machine)
`threedog shot --save-baseline` (or `verify <name> --save-baseline`) writes `engine.budget.record()` (draw calls, triangles, module ms, live `cpuMs`) to
`.threedog/perf-baseline.json`, keyed by GPU, canvas size, pixel ratio, headless or live, camera pose. Runs with that key load it into `engine.budget.baseline`
and name what got slower (times +20% and +0.2 ms, new ones past 0.2 ms; counts +5%). Local to this machine, do not commit; save again after a change you accept.

## 3. Whose CPU is slow
```js
engine.profile();  // { terrain: { ms: 0.1, mean: 0.12, p95: 0.4 } } per frame, last 300 (ms: median); on in dev
engine.profile(true); // production: on (afresh); false: off
```
Only the module's own hooks count, not what it hands to `engine.jobs` or `engine.stream` loaders. Fixed hooks count one fixed step per frame, the dearest one: a slow frame runs several catch-up steps, and that is the frame's cost (`cpuMs`), not a spike of the physics module. `threedog inspect perf` lists the five dearest.
Browsers round time to 0.1 ms. `onFrame/onFixed` are not timed; to time one, make it a small module (`14-custom-module.md`).

## 4. Common fixes
| Symptom | Fix |
|---|---|
| Many draw calls | Use `vegetation` / InstancedMesh for repeated objects; install `hlod()` for a block of buildings; share geometry and materials between copies of a model (`assets.model` shares by default) |
| Expensive shadows | `engine.shadows.budget(light, { every: 3 })` (update every 3 frames), reduce `light.shadow.mapSize` / the box's `extent`; filter `renderer.shadowMap.type`: Basic cheapest, PCF default, VSM softest and dearest (switching recompiles); vegetation `shadowRing` (default 1) is how many chunk rings cast (culled per camera: a shadow box or cascade draws only chunks inside it), `engine.vegetation.setShadowRing('tree', 0)` while playing; grass-scale species: `castShadow: false` (`content check` hints) |
| Stutter while walking | Put generation work in `engine.jobs.add(function* () { ...; yield; })` or `engine.stream.add`; chunk upload budget `engine.terrain.applyBudgetMs` |
| Slow start | Look at which is slowest in `engine.startup.modules`; `npm run bake` for large models; preload only the necessary assets |
| Slow physics | Keep dynamic rigid bodies within a few hundred (the `rigidBodies` budget); `rigid({ terrainRing: 1 })` |
| Too much loaded at once | Each `engine.stream` source loads its own surroundings: remove sources you no longer need, give a far camera `physics: false` and a `radius`, use `detail: 'simple'` for a distant view (recipe 18 section 10) |

**Main thread busy with simulation or pure computation: use workers.** `createEngine({ threads: 'auto' | n | false })`, default 'auto';
false = all on the main thread, same results.
- Many far records: `world.simulate(kind, { far, worker: true })` (recipe 18 section 7).
- Many paths per step (NPC crowds, AI squads): `engine.characters.findPathAsync(from, to, done)` (recipe 12 section 4); built-in NPCs already use it.
- Your own worker script: `engine.threads.lane({ create: () => new Worker(new URL('./w.js', import.meta.url), { type: 'module' }), local: makeHandler })`;
  the worker file is `serve(makeHandler())` from `threedog/worker`. Results that change gameplay go through `ctx.commits`.

**Two worker limits**, with examples in `../CONVENTIONS.md`, "Worker limits": `ctx.commits` runs your `fallback()` when the worker is late and does not clear pending requests on a load or level change, so give each a `valid()`; `threads.pure` functions are recompiled from source and capture nothing.

## 4a. Less detail far away: which tool for which job

Four tools lower the cost of distant things, and each owns a different case. Pick by what is actually over budget: triangles or draw calls.

| You have | Use | Saves | Costs |
|---|---|---|---|
| A few heavy models (a statue, a vehicle, a tower) | `engine.assets.lod` or `lod: true` | Triangles | Each copy stays its own draw calls |
| Many copies of a light model (crates, fences) | `engine.batching`, on by default | Draw calls | Every copy keeps full triangles |
| A static level seen from far off | `engine.hlod` | Draw calls, by merging per cell | Same triangles unless a node `xxx_LOD1` exists |
| Plants by the thousand | `engine.vegetation` with `lodGeometry` | Both, per chunk ring | Plants only |

```js fragment
// 1. once: writes public/optimized/tower.lod1.glb, .lod2.glb and lists them in assets.optimized.js
// threedog assets optimize --lod            (--lod-shares 0.5,0.2 sets the triangle share of each level)
// 2. one line in the game; without it no level is ever downloaded
const tower = await engine.assets.lod('tower');  // distances follow the model's size
const gate = await engine.assets.lod('gate', { distances: [40, 120] });  // or your own, in meters
// content/props.js: { model: 'tower', x: 10, z: 4, collide: 'box', lod: true }  // or lod: [40, 120]; also on a template
tower.levels[1].object;  // a plain THREE.LOD: read, replace, tower.addLevel(...), tower.autoUpdate = false
```

- **Batching:** instances share one geometry, so a copy cannot change level alone. A LOD object is never batched, which means `lod` on a model placed many times can
  cost more than it saves. Compare `describe().perf` with and without it; dev warns at 32 copies.
- **What stays on the full model:** `engine.raycast`, `engine.rays`, your own `THREE.Raycaster`, `collision` and saves. A level draws with the full mesh's material, so swap
  materials on `tower.levels[0].object` and on each level.
- **Asking what is drawn:** far off the full model waits on the batch layer with `visible` true, so read `tower.getCurrentLevel()`, not `tower.levels[0].object.visible`.
- **Skipped by the tool, with the reason in its report:** skinned, morphing and animated models, and models under 1000 triangles. `assets.lod` still works on them: one level, and a
  dev warning.
- **The level follows `engine.camera`** only, so a shadow pass does not change it. `delete tower.update`, while level 0 shows, restores the plain method; far rays then miss the full model.
- **A narrow lens:** `camera.zoom` counts towards the distance, `camera.fov` does not: a scope narrowing `fov` shows the far level, so zoom, or set
  `tower.autoUpdate = false` while scoped.
- **Check the last level up close once:** a low level can lose round details (a dial, a dome) that a few dozen pixels hide and a scope shows. If it shows, raise `--lod-shares` or move the distance out.
- **Popping:** no crossfade (only `hysteresis`); if a switch shows, move the distance out.
- **Scale:** default distances follow a prop's `scale`. On `assets.lod` they follow the model as loaded, so give `distances` when you scale it yourself.

## 4b. Render scale and effects are never lowered silently
- Default render scale: `min(devicePixelRatio, 1.5)`; the low tier uses at least 0.75 x devicePixelRatio (a 2x laptop screen gets 1.5, not 1), never above 1.5.
- Adaptive quality (`createEngine({ adaptiveResolution, targetFps })`, default on) lowers one step a second while frames cost more than the target allows
  (CPU + GPU time where timed, else fps unless locked to the display); the first 3 s, compile frames and a 30 Hz lock are not judged.
  Dev warns once; the perf notice (section 1) names what stays lowered. 4 s of cheap frames raise the last one back.
- `engine.adaptive.steps`, first lowered first. Default `null`: effects' own `cheaper` params (in place, no recompile), the resolution (0.1 a step, floor 0.6),
  then `skipOnLowTier` effects held off (a rebuild, so last; one that drops straight back waits longer). Your own knob: `{ name, down, up }`
  (down: false at its floor). `['resolution']` = scale only, `[]` = nothing.
  Only downward: what the game or player has off is no step, settings stay above it, `adaptive.on = false` puts every effect back.
- `engine.setPixelRatio(p)` = the top it climbs back to; a direct `renderer.setPixelRatio` drops the resolution step; `pixelSize` stops it all (recipe 62 4b).
- `describe().render.scale`: `{ current, devicePixelRatio, upscaled, pixelSize, autoLowered, adaptive, floor, max }`. `upscaled: true` means current < devicePixelRatio, the picture
  is softer than the screen: if that looks wrong in a screenshot, check this before the style. Fixed quality: `pixelRatio: n` plus `adaptiveResolution: false`.

## 5. Verify (once before and once after, under the same conditions)
- `npm run perf` (native vs engine vs per-module cost of openWorld), run before and after on the same machine; differences under 10-30% are noise.
- One spot: `threedog shot --pos x,z --save-baseline` before, the same shot after (2a). Attach the numbers.
