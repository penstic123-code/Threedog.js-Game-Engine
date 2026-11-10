# Performance comparison (PERF)

> Sections 1-5 come from a cloud environment without a GPU (Chromium + SwiftShader software rendering, 1280x720, pixel ratio 1; section 6 is a real GPU). Use them only for
**relative comparison**; they do not represent real-device frame rates.
> Reproduce: `node packages/tools/perf.mjs [frames]` (default 60 frames; it builds first, then opens
> `packages/engine/tests/perf/index.html` in a headless browser; both are in the engine repository, not the npm package). Resolution: `--size WxH` (same form as `shot` / `capture`; default 1280x720), e.g. `node packages/tools/perf.mjs --size 1920x1080`.
> Startup time is also printed in the "startup time" item of `npm test` (reported only, no threshold).
> **Latest run (2026-10-30, wrap-up)**: cloud container with a 2-core CPU and 7 GB memory, no GPU; `npm run perf` (60 frames) run alone (not at the
same time as `npm test`).
> This machine is about 1.5-2x slower overall than the one behind the old numbers (the same plain three.js scene takes 9.6-12.2 ms, the old one 9.9
ms); compare across runs only through relations within the same run. Old numbers are kept in the "previous run" rows of each table.

## 0. Real-device baseline

Measured 2026-10-31 on the open-world example, before the stage 2 changes, with the in-game F3 panel "20-second stress test" (view distance 256 m, density 1x).

| Machine | Avg fps | 1% low fps | Longest frame | Chunks generated during the run |
|---|---|---|---|---|
| AMD Ryzen 7 **integrated GPU** (desktop), browser not recorded | 60.0 (vsync cap) | 53.8 | 21.0 ms | 6366 |

The average is capped by the display refresh rate, so this shows headroom exists, not how much. Not yet measured: the same machine's discrete GPU (RTX
5060), `npm run perf` on this machine, phones and laptop integrated GPUs.

## How it was measured

- Test page (engine repository) `packages/engine/tests/perf/index.html?mode=...`:
  - `native`: plain three.js, 2000 cubes (shared geometry and material) + a ground + 1 directional light with shadows (2048 pixels, covering +-70 m) +
    a hemisphere light, `renderer.render` every frame.
  - `engine`: the same scene inside `createEngine()` (**no modules installed**), running the same sequence as the real-time loop each frame: fixed
    step -> frame hooks (including stream/jobs) -> render -> budget sampling -> afterRender.
  - `world`: `openWorld()` plus the gameplay modules (interactions, dialogue, inventory, quests, timeline, triggers,
    particles, hud; debug panel, music and ambience off), with the same seed, the same flat ground and the same vegetation as the open-world example,
    without NPCs/quests or other content; `engine.profile()` times `fixed/frame/afterRender` for each module.
  - `props`: `n` repeated props over 4 models placed through `world.present`, with a directional shadow; `batch=0` turns `engine.batching` off (section 3c).
  - `city`: used by the C group of feature tests (HLOD, scenario parameters, settings freeze); not timed.
- Shadows: `renderer.shadowMap.render` is wrapped to count "how many times shadows were really updated" and the draw calls per update.
- Each item runs 3 times and the median is taken; native/engine alternate for two rounds, and every page uses a freshly opened browser (the
  software-rendering GPU process carries the backlog of the previous page into the next; the first version of the script did not do this and the same
  item varied 2x).

## 1. Plain three.js vs engine (no modules), 60 frames

| | CPU ms/frame | Render ms/frame | Draw calls | Triangles | Shadow draw calls |
|---|---|---|---|---|---|
| Plain three.js (round 1) | 9.55 | 9.55 | 3723 | 44666 | 1848 |
| Engine (round 1) | 9.87 | 9.81 | 3723 | 44666 | 1848 |
| Plain three.js (round 2) | 12.2 | 12.2 | 3723 | 44666 | 1848 |
| Engine (round 2) | 10.95 | 10.89 | 3723 | 44666 | 1848 |
| Previous run: plain three.js (two rounds) | 9.98 / 9.88 | | | | |
| Previous run: engine (two rounds) | 9.67 / 9.89 | | | | |

Between the two rounds plain three.js itself differs by 2.6 ms (software-rendering noise), and the engine falls between the two plain rounds.
Conclusion: draw calls and triangles are identical; the engine core's per-frame cost beyond rendering is about 0.05 ms (fixed step, frame hooks,
jobs/stream, budget sampling returns immediately when off), within measurement error. The engine adds no extra draws (with bloom/ambient occlusion
off, PostFX renders directly).

## 2. openWorld fully on, per-module cost per frame (60 frames, player moving forward at 6 m/s)

Whole frame 3.99 ms, of which rendering (submitting draw commands) 2.97 ms; 74 draw calls, 67k triangles (previous run: whole frame 1.84 ms, rendering
1.38 ms, 66 draw calls, 84k triangles).

| Module | ms/frame (this run) | Previous run |
|---|---|---|
| rigid (Rapier physics) | 0.56 | 0.23 |
| sky | 0.12 | 0.02 |
| cameraRig | 0.09 | 0.03 |
| terrain (chunk streaming, LOD, frustum) | 0.04 | 0.06 |
| weather | 0.02 | < 0.01 |
| characters / interactions / particles | 0.01 each | < 0.01-0.01 |
| triggers, quests, timeline, water, dialogue, settings, hud, inventory | 0 | < 0.01 |

Conclusion: module logic totals about 0.9 ms/frame (a quarter of the frame), and the biggest part is still Rapier; every item rose together with the
slower whole frame (slower machine), and no single module became slower.
particles: group X once measured 0.21 ms/frame, and this run alone it is 0.01. The world scene has no particle effects (no emit/attach); particles per
frame only computes one point-size ratio and then iterates an empty effect table,
so it cannot cost 0.2 ms; that was noise from competing for CPU with another process (the full test run), not a regression, and no code was changed.
The real cost is in rendering (on real devices mostly the GPU, which cannot be measured here).

## 3. Shadow parameter comparison (openWorld, 60 frames, player moving forward at 6 m/s)

| updateEvery | snap | Shadow updates | Draw calls per shadow | CPU ms/frame | Render ms/frame |
|---|---|---|---|---|---|
| 1 (default) | 0.5 (default) | 60/60 | 27 | 2.17 | 1.74 |
| 3 | 0.5 | 20/60 | 27 | 1.56 | 1.14 |
| 1 | 'texel' | 60/60 | 27 | 2.53 | 1.93 |
| 3 | 'texel' | 21/60 | 27 | 1.00 | 0.75 |

- `updateEvery: 3` cuts shadow drawing from 60 to 20 times per second (in this scene 27 draw calls each time -> about 1080 fewer draws per second).
  The difference in the CPU column is hidden by software-rendering noise (the same configuration can differ by 0.5 ms between two runs), so rely on
  "shadow updates x draw calls per update".
- Early update while moving: only when the shadow center is more than 1/4 of the coverage radius away from the last update point (default 17.5 m;
  teleporting or fast movement) is the update brought forward. The first version updated "whenever the snapped cell changed", and with 'texel' (cell
  only 0.07 m) it updated almost every frame (27/30), which saves nothing; that was changed.
- `snap: 'texel'` does not save performance by itself; it keeps shadow edges from flickering while moving (aligned to shadow pixels).

## 3b. HLOD (`threedog test HLOD`, test block of 7x7 buildings + ground)

With the focus at the block center: 93 draw calls (including shadows); with the focus moved 400 m away and everything switched to proxies: 16; moving
back restores 93.

## 3c. Automatic batching (engine.batching), 2026-10-31

`npm run perf -- --only=props`: 3000 repeated props over 4 models (a lamp of 2 meshes, a fence, a crate, an AC unit; 3750 meshes), each a world record
presented as a clone of its model, spread over about 143 x 143 m (16 cells of 64 m), one directional light with shadows, 60 frames, headless Chromium
with ANGLE SwiftShader
on the user's Windows machine (plain `--use-gl=swiftshader` does not start WebGL there, which is why section 5 shows 0 draw calls; perf.mjs has since
moved to the hardware GPU when headless reaches one, so later runs of this table are GPU numbers: the first output line names the renderer).

| | CPU ms/frame | Render ms/frame | Draw calls (incl. shadow) | Shadow draw calls | Batches | Instances |
|---|---|---|---|---|---|---|
| batching off (round 1) | 77.36 | 76.09 | 6742 | 3333 | 0 | 0 |
| batching on (round 1) | 7.91 | 6.26 | 156 | 79 | 56 | 3694 |
| batching off (round 2) | 43.77 | 42.63 | 6742 | 3333 | 0 | 0 |
| batching on (round 2) | 9.14 | 7.10 | 156 | 79 | 56 | 3694 |

Draw calls fall 43x (6742 -> 156); 56 of the 79 (cell, geometry, material) groups reached the threshold of 8, the other 23 (cell-edge strips) stay plain meshes.
The batching bookkeeping itself costs about 0.46 ms/frame with 3000 batched objects and nothing moving (a transform check per batched object plus a
256-object round robin that looks for parts changed behind its back). With nothing repeating it only checks a few transforms.

## 3d. Swarm against one Mesh per object (`engine.swarm`), 2026-11-05

**Where: a real GPU.** System Chrome 156, headless, on the hardware adapter WebGPU reports as `nvidia/blackwell`, 1280x720, pixel ratio 1. Not software rendering. Page
`tests/swarm-perf/index.html?mode=swarm|mesh&n=...` (`&renderer=webgpu`), through `node packages/tools/real-webgpu.mjs --urls=... --eval=<file: window.measure()>`, `--webgl` for
the WebGL renderer. The same objects both ways: lit boxes of 12 triangles bouncing in a 200 x 200 m square, one light, shared geometry and material; the Mesh side is what a
hand-written game does, a `new Mesh` per object and a plain array of them.

Each number is the median of 120 frames (40 for 50k meshes), from one run of each page, not repeated, so read them as sizes, not to the last digit; `performance.now()` here ticks in 0.1 ms.
Frames are driven by `engine.step()`, not `requestAnimationFrame`, so the display refresh does not cap them.
step = one fixed step without drawing (the game's movement). cpu = step + hooks + render submission. frame = cpu + waiting for the GPU to finish, no overlap: an upper bound, as in section 6.
near = 100 queries of radius 3 in one step, grid rebuild included; the Mesh side loops over its array.

| Backend | Objects | Swarm step / cpu / frame ms (p95) | Meshes step / cpu / frame ms (p95) | Draw calls swarm / meshes | near swarm / loop ms |
|---|---|---|---|---|---|
| WebGPU | 1,000 | 0.1 / 1.1 / 4.6 (6.7) | 0.2 / 14.6 / 24.4 (28.4) | 2 / 988 | 0.1 / 1.6 |
| WebGPU | 10,000 | 0.3 / 1.5 / 5.5 (7.5) | 0.8 / 151.6 / 233.3 (252.7) | 2 / 9,870 | 0.4 / 55.9 |
| WebGPU | 50,000 | 1.1 / 6.3 / 7.7 (13.2) | 4.6 / 955.7 / 1208.5 (1380.7) | 2 / 49,410 | 3.6 / 392.4 |
| WebGL | 1,000 | 0.1 / 0.4 / 1.1 (3.3) | 0.2 / 4.6 / 7.1 (11.4) | 1 / 987 | 0.1 / 1.5 |
| WebGL | 10,000 | 0.3 / 0.9 / 2.1 (5.4) | 0.7 / 52.8 / 55.4 (61.0) | 1 / 9,869 | 0.6 / 30.6 |
| WebGL | 50,000 | 0.7 / 1.9 / 3.9 (5.6) | 3.8 / 304.7 / 307.1 (327.6) | 1 / 49,409 | 2.6 / 348.7 |

Reading it: the difference is almost all draw submission, one call against thousands; moving the objects was never the expensive part. This machine is fast and a phone is not:
take the ratio, not the milliseconds. The boxes are tiny and nothing else is in the scene, so a real game has less room. At 1,000 objects on WebGL the Mesh side still fits a frame,
so a game of a few hundred objects gains little from the frame time, only from `near` and the bookkeeping. Meshes cull one by one and a swarm draws whole or not at all; on this page only about 1% is off-screen,
so that is not tested here, and in a wide world a swarm spread over the map draws its off-screen objects too.

Heap (Node, one run, `--expose-gc`): 200,000 spawns, 2,000 update steps and 40,000 queries grew the heap by about 3.1 MB before collection, which is the one number box of each returned handle
(16 bytes); update, free and near allocated nothing measurable.

GPU compute (recipe 65, `tests/compute-snow`), same machine, real WebGPU, one run: 100,000 sprites moved by a TSL compute shader, 3.5 ms a frame (median of 60, draw + compute + GPU wait, 320 x 240 canvas, so fill is nearly free here). All 100,000 read back from the GPU buffer as moved and inside the box.

## 4. Open to playable (engine.startup)

> Dated: the tables below predate the 2026-11-02 cold-start change (no scene render before ready, `compileAsync` for the real render target, the
> room environment built only when a material reads it, Rapier / Recast loading from install). After it a test game measured 2.9 s cold start with
> 2.46 s of long tasks before ready (Radeon 780M, headless); the open-world rows have not been remeasured.

| Example | Open to playable ms | start() to playable ms | Asset preload ms | First-screen chunks (terrain ready) ms | Slowest module |
|---|---|---|---|---|---|
| Open world (`/`), before optimization | 7036 | 6778 | 0 | 4319 | terrain 4319 |
| Open world (`/`), after optimization (median of 5) | 3067 | 2798 | 0 | 377 | rigid 2420 (Rapier download and initialization) |
| Small city (`/tests/city/index.html`), previous run | 2103 | 1866 | 0 | — | rigid 1863 (Rapier download and initialization) |
| Open world, this run (perf.mjs) | 4392 | 4116 | 0 | 1281 | rigid 2834 |
| Open world, this run (npm test "startup time") | 4057 | 3176 | 0 | 940 | rigid 2235 |
| Small city, this run (perf.mjs / npm test) | 2470 / 3094 | 2246 / 1846 | 0 | — | rigid 1511 |

This run is about 1 second slower than "after optimization", with first-screen chunks 377 -> 940-1281 ms: this machine has only 2 cores, and the
background chunk threads, the Rapier wasm compilation and the main thread compete for them; rigid (Rapier) is still the slowest item.

With software rendering, shader compilation and chunk upload are very slow and real devices will be much faster; use it to see "who is slowest" and
the change before/after a modification.

### Where the open-world startup is slow (per-frame record of chunk count, in-flight tasks, pending upload results)

Background-thread generation itself is not slow (measured in node: terrain 7 ms/chunk, all vegetation about 8 ms/chunk). The slowness is **a single
very long main-thread frame** (0.5-1.8 seconds per frame during loading under software rendering, longer while Rapier compiles), and the chunk
pipeline advances "per frame" everywhere:

1. **Dispatch per frame**: at most 4 tasks at the same time, and a result has to wait for the next frame's update before the next one is dispatched.
   With a 1-second main-thread frame, the background thread finishes 4 (tens of milliseconds) and then idles.
2. **Upload limited per frame**: a 3 ms upload budget per frame; during loading results pile up to 8-14 in the queue and only about 4 are uploaded per frame.
3. **Ready check one frame late**: start() checks readiness with a timer every 20 ms, but the timer is often scheduled after the next frame, so after
   all chunks are in place one more whole frame (about 1 second) is rendered before it notices.
4. The ready check radius is 1 ring (3x3 = 9 chunks), which is reasonable and was not changed; the stream registry is empty here (0 ms); there is no
   duplicate generation (the rebuilds of registerSpecies all happen before start).

The fixes (effective only while the loading screen is still up; behavior after entering the game is unchanged, view distance and density unchanged):

- ChunkManager: dispatch the next task as soon as a result returns (`_pump`); when the engine is not ready, do not limit the number of concurrent
  tasks (send all to the background threads to queue, nearest first).
- ChunkManager: when the engine is not ready, the ring of chunks around the player (needed for the first screen) is not limited by the 3 ms upload
  budget and is uploaded entirely within one frame; the rest still follow the budget.
- Engine.start: besides the timer, the real-time loop also checks readiness at the end of every frame.

Step-by-step effect (first-screen chunks ms, 2-3 runs each): originally 4254-4591 -> dispatch on result return 4359-4779 (the real bottleneck was the
main thread not receiving replies) -> send everything while loading 2897-3185 -> first-screen chunks without budget 2960-3185 -> check readiness at
the end of each frame 332-1927. The biggest remainder is rigid (Rapier wasm compilation, about 2.4 seconds), which runs in parallel with chunk generation.

## 5. Worker pool (engine.threads), 2026-10-31

Measured on the user's Windows machine (16 logical cores, so `threads: 'auto'` = 4 workers), headless Chromium. **WebGL did not start in this headless run**
(0 draw calls everywhere), so only CPU module timings and startup are comparable; render numbers are meaningless. Not a real-device GPU measurement.

`npm run perf`, before -> after the change (terrain moved from its own single worker to a 4-worker lane):

| | Before | After |
|---|---|---|
| openWorld whole frame ms | 0.54 | 0.61 |
| terrain module ms/frame | 0.06 | 0.08 |
| rigid module ms/frame | 0.24 | 0.27 |
| open world: open to playable / start() to playable ms | 821 / 340 | 1211 / 538 |
| town: open to playable / start() to playable ms | 804 / 358 | 947 / 394 |

The slowest item in both runs is rigid (Rapier), which this change does not touch, and it moved 339 -> 537 ms by itself: the differences are run-to-run noise,
not a regression. Terrain's per-frame cost stays under 0.1 ms.

World far simulation in workers (`threedog test "threads:"`, 460 records, far every 0.05 s, 240 steps): main-thread ms per fixed step
threads 0 = 1.34-1.41, threads 2 = 0.95-1.10. The main thread still copies each batch (structuredClone) and diffs the result, so the gain grows with how heavy
`far` is; a trivial far gains little. Records are bit-identical between threads 0 and 2 at every checkpoint;
with threads 2 every batch used the worker result (0 late).

## 5b. Pathfinding in workers (`findPathAsync`), 2026-10-31

Same machine (16 logical cores), headless Chromium, `threedog test "paths: findPathAsync main"`. Two headless engines get the same 300 requests;
"main-thread ms" is the total time of the fixed steps until every answer landed, minus the same number of steps without requests. Workers were already started
and held the mesh (a game pays that start-up once). Before = the synchronous `findPath` loop that NPCs used until now.

| 300 paths | Before: sync `findPath` | `findPathAsync`, threads 0 | `findPathAsync`, threads 2 |
|---|---|---|---|
| A* (40 boxes, 140 m area) | 218-266 ms | 254-294 ms | 78-90 ms (2 of 10 batches late) |
| Navmesh (40x40 maze) | 8-17 ms | 11-35 ms | 3 ms (0 late) |

Paths and landing steps are identical between threads 0 and 2 (also across a collider change and a crashed worker). The A* main-thread time that remains is
sampling the ground raster (water / slope, cached 5 s) and the batches that came back late; with real frame gaps (16 ms instead of the test's 2-4 ms)
fewer are late.
threads 0 costs a little more than the sync loop (batch building plus the raster), so `findPath` stays the call for one-off paths.

## 5c. Vegetation culled per camera, 2026-11-09

World example (`/`), WebGL, AMD Radeon 780M headless, 1280x720, in play standing still, 300 frames. Draw calls and triangles from `engine.inspect.perf()`
(shadow passes included), shadow draws by wrapping `renderer.shadowMap.render`, vegetation draws from `engine.budget.byTag()`. Before: chunk meshes had
`frustumCulled = false`; after: three culls each chunk's mesh per camera (`modules/vegetation/draw.js`, `cullSphere`).

| Case | Draw calls | Triangles | Shadow draws per pass (vegetation) | Vegetation draws |
|---|---|---|---|---|
| default follow camera | 213 -> 190 | 111k -> 99k | 60 (22) -> 60 (22) | 93 -> 57 |
| wide view (45 m out, 40 m up) | 235 -> 224 | 116k -> 115k | 60 (22) -> 60 (22) | 103 -> 89 |
| 3 cascades (`maxFar` 150) | 329 -> 297 | 128k -> 114k | 176 (66) -> 167 (57) | 137 -> 75 |
| 3 cascades + grass and flowers casting | 377 -> 334 | 212k -> 191k | 224 (114) -> 205 (94) | 185 -> 96 |

JS ms per frame 3.6-4.7 in both (noise); frames are vsync bound (median 16.6 ms, p95 about 19 ms both); `engine.profile()` vegetation and vegetationDraw 0 ms
median (their hooks are not where the cost is; it is draw submission). The single shadow box (extent 70 m) covers all of ring 1, so it culls nothing; the
gain there is the main view skipping ring-1 chunks behind the camera. Per chunk a culling sphere is at least half a chunk diagonal (23 m at 32 m chunks),
which limits what a near cascade can skip. Screenshots before / after differ by 0.12% of pixels (WebGL) and 0.14% (WebGPU), the same as two runs of one
build (0.14%); `threedog picture compare`: no difference above its thresholds. Then the vegetation group hide for chunks off the main view was removed (it dropped
those chunks' shadows): same numbers, wide view 224 -> 226.

## 5d. Walking a big world: readying streamed content, memory after round trips, 2026-11-09

World example (`/`, and `/?renderer=webgpu`), AMD Radeon 780M headless, 1280x720, real-time loop: the player is placed 400 m east at 25 m/s and back,
three round trips (about 5750 frames). Before = the prepare step switched off in the page (`engine.stream._prep.run = () => null`), after = on. Apply ms =
the per-frame sum of the `build`, `collider`, `upload`, `stream` stages (`transit` left out: an async wait), over the 110 frames that applied anything.

| Route | worst frame JS ms | p95 frame JS ms | apply p95 / worst ms | compile stall frames | prepare compiles | geometries / textures / GPU MB after trips 1, 2, 3 |
|---|---|---|---|---|---|---|
| WebGL before -> after | 21.0 -> 24.4 (20.7 rerun) | 5.1 -> 5.9 (5.0) | 2.3 / 3.5 -> 2.7 / 6.3 (2.6 / 3.1) | 0 -> 0 | 0 -> 3 (1.1-1.8 ms each) | 84 / 15 flat both |
| WebGPU before -> after | 36.9 -> 33.0 | 8.8 -> 8.1 | 2.9 / 4.5 -> 2.9 / 4.1 | not counted (no program list) | 0 -> 3 | 84 / 18 / 63.5 -> 63.6 flat both |

This example streams no material the startup compile missed (0 stall frames before too). The three compiles were fresh `world.present` material
instances (by identity, programs already cached); that route was taken out again (it made `world.view(id)` arrive frames late and broke 5 world tests), so
the final code does not prepare them. Frame differences are run-to-run noise (the rerun row). Memory is flat over
round trips on both. Where the step matters, and the leak it first caused: `tests/specs/stream-prepare.mjs` (a stream entry with an unseen material and
texture: compiled and uploaded before it is attached, 0 stall frames after; 24 entries out and back six times). Two `compileAsync` calls in flight at
once on WebGPURenderer left `_callDepth` one high and grew 4 render records and 784 bytes per trip; the step now runs one at a time (flat).

## 6. Load budget (`threedog stress`), 2026-11-02

**Machine: `ANGLE (AMD, AMD Radeon 780M Graphics (0x00001900) Direct3D11 vs_5_0 ps_5_0, D3D11)`** (AMD Ryzen 7 integrated GPU, headless Chromium on
the hardware GPU), 1280x720, pixel ratio 1, 30 frames per step, medians. Other headless browsers were running on the machine at the same time: expect
10-20% noise. The same machine's discrete GPU (RTX 5060) is measured separately by the user (key B on the WebGPU compare page); add its row here.

Each axis alone on the neutral page `tests/stress/` (gray ground, the engine's default lights, 400 boxes under the light / shadow / post axes). frame =
CPU + waiting for the GPU to finish, no overlap: an upper bound of the real frame. "≈" is log-interpolated between the two steps around the crossing.

| Axis (unit) | Fits 16.7 ms | Fits 33 ms | CPU / GPU / frame ms at the 16.7 ms load | Stopped by |
|---|---|---|---|---|
| triangles (1M-triangle tiles, few draws) | ≈ 45M | ≈ 100M | 0.6 / 10.1 / 11.9 | 33 ms |
| draw calls (separate meshes, one material) | ≈ 2400 | ≈ 4800 | 8.6 / 4.5 / 13.1 | 33 ms |
| instances (one InstancedMesh of boxes) | ≈ 3.2M | ≈ 7.3M | 0.3 / 15.0 / 16.6 | 33 ms |
| point + spot lights (no shadow) | ≥ 128 | ≥ 128 | 2.3 / 10.3 / 13.6 | shader compile fails at 256 (uniform limit) |
| shadow-casting spot lights (1024²) | ≥ 8 | ≥ 8 | 2.7 / 2.8 / 6.6 | shader compile fails at 16 (texture units) |
| sun shadow map size | ≈ 9700² (8192² fits) | ≈ 13000² | 2.7 / 2.8 / 6.3 at 8192² | 33 ms (16384²: 45 ms GPU) |
| overlapping full-view transparent quads | ≈ 58 | ≈ 113 | 0.4 / 8.2 / 9.3 | 33 ms |
| point particles (4 px, additive) | ≈ 1.7M | ≈ 3.8M | 0.3 / 14.6 / 15.8 | 33 ms |
| post effects, cumulative: bloom, vignette, grain, lut, chromatic, outline, ao, dof | 7 (all but dof) | all 8 (17.1 ms) | 4.1 / 9.7 / 15.0 | ladder end |
| skinned characters (24 bones, 2352 triangles, own mixer) | ≈ 230 | ≈ 440 | 4.9 / 2.7 / 9.2 | 33 ms |

Reading it: on this iGPU draw calls and skinned characters are CPU-bound (main thread), everything else is GPU-bound; ao (GTAO) is the costliest
single post effect (+5 ms GPU, it redraws the scene for normals). Real scenes combine axes, so take a game's limit well below one axis' crossing.

## 6b. Reflections (`reflections()`, three's SSRNode), 2026-11-09

Real WebGPU in system Chrome (`node packages/tools/real-webgpu.mjs --urls=/tests/light-webgpu/index.html?demo=mirror --eval=...`), adapter AMD RDNA 3
(the Radeon 780M of section 6), worst case: a polished metal floor fills most of the screen. Median ms from submit to the GPU finishing one frame, 60 frames:

| Size | off | on (scale 1) | on (`resolutionScale: 0.5`, the default since) |
|---|---|---|---|
| 1280x720 | 4.1 | 8.8-10.7 (+5-6.6) | 5.2 (+1.1) |
| 1920x1080 | 4.1 | 16.6-16.8 (+12.5) | 7.0 (+2.9) |

"off" also drops the metalRough buffer (nothing else asked for it). The 2026-11-04 spike's +2.0 / +1.2 ms was another scene with one global roughness; take these as the screen-filling bound.
The cost scales with the reflecting pixels: metalness 0 is skipped before any ray.

## Limitations

- SwiftShader does the GPU's work on the CPU, but WebGL commands are submitted asynchronously: "render ms" in the tables is mostly the time three.js
  spends traversing the scene + submitting commands, and **does not include** the time to actually draw pixels. Fragment-heavy things (shadow map
  resolution, bloom, ambient occlusion, transparent overdraw) show no difference here; measure them with `threedog stress` on the GPU (section 6).
- Noise: the same configuration run repeatedly can differ by 10-30%; draw no conclusion from smaller differences.
- The `world` mode has no NPCs, pickups or other content, so it has fewer draw calls than the open-world example; to see the example itself, open
  it with `npm run dev`.
- The budget monitor (`engine.budget`) is off by default; when on, each frame adds one array write and a check once per second, and only when over the
  limit does it traverse the scene to count by `userData.budgetTag`.

## Per-module timing

The core times module hooks (on by default in dev builds; `engine.profile(true)` starts afresh) and `engine.profile()` reads `{ moduleName: { ms, mean, p95 } }`
over the last 300 frame-hook cycles (ms is the median). The test pages read `mean` (the run's average) instead of wrapping hooks themselves, and put
timing back as they found it.
