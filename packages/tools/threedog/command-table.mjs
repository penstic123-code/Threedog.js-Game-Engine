// The names and help lines of the bridge commands: plain data, so bin/threedog.mjs can read the list without loading the commands themselves.
// The one text of each command: its --help line and its row in docs/COMMANDS.md (apidoc.mjs writes the rows, npm run map). MCP tool descriptions stay
// their own short form on purpose: they are sent every turn (mcp.mjs).

/** The commands of commands.mjs: they need a running page */
export const COMMANDS = {
  describe: 'compact scenario description (--full for the describeText summary, --all for everything, describe player.x for one item, --max characters); recipes/16-dev-bridge.md',
  step: 'advance N real seconds: step 2. The loop stays halted afterwards (threedog resume)',
  skip: 'jump the clock like sleeping: skip to=06:00 / skip seconds=600 (engine.skip: op time.skip, sky clock and time-keeping modules catch up; optional fade=0.6 save=auto). to works with calendar() alone; the sky only follows the clock when installed',
  press: 'press a key or action: press interact / press KeyE / press e (held 0.1 s, then renders 1/60 s; --for 0.02 shortens the hold)',
  hold: 'hold for N seconds: hold moveForward 1.5. moveForward walks along the camera\'s heading, so with a follow camera at its start angle it goes diagonally, not along an axis: place things by reading player after a short hold',
  state: 'change the scenario without a reload: state time=18:30 weather=rain pos=40,-20; view=name or view=x,y,z,tx,ty,tz[,fov] puts the camera on a declared view or a pose, for the next snap (pos=x,z has no height: the hero stands on the highest support over that spot, a ledge included; to stand under it, js "engine.player.placeAt([x, y, z])")',
  js: 'evaluate an expression in the page (engine is available, await works; one expression prints its value, several statements print what they return): js ' +
    '"engine.calendar.timeOfDay"; long scripts: js --file path. A script that calls assert(cond, msg) or expect(v).toBe/toEqual/toBeCloseTo/toBeGreaterThan(x, msg) (or expect(v, msg)) runs as checks in ONE call: ' +
    'failed checks are recorded and the script goes on, a throw stops it; output ✓ 7 checks passed, or the failures then ✗ 2 of 7 checks failed; exit 1 on failure; --verbose adds passes, log lines and the return value. ' +
    'A script without those calls is the plain form. Both modes get the globals engine, step(seconds), log(...), assert, expect. --wait <seconds>, default 120: how long a script may wait on a page that looks stopped ' +
    '(driven by manual step, nothing loading, no clock tick); the command then ends and says the script may be waiting on the game clock, and the script may still run in the page',
  'snap-describe': 'describe snapshot instead of a screenshot, a baseline of the gameplay part of describe(): snap-describe save|diff name [--only a,b] [--ignore x.y] [--tolerance 0.5] (recipes/16-dev-bridge.md section 7); in tests one line expectDescribe({ check, ev }, name, { only, tolerance }) from @threedog/tools/describe-snapshot',
  snap: 'save a screenshot to .threedog/shots/name.png and run the picture check on the page, as threedog shot does (snap name, or snap path/to/file.png used as given; --play first leaves the title as shot --play; --width N scales the returned image down, the saved file stays full size; --no-picture skips the check)',
  errors: 'page errors with id (E1…), time, tick, source and count; the same error repeated is one line with its first and last id / time and ×N. errors = new since the last read; errors latest [N] = the last N (default 3), same answer every time; ' +
    'errors --since E5 = after id 5, never moves the read position. Every result prints a cursor (known classes come with the cause and the doc page)',
  reload: 'reload the page',
  resume: 'resume real-time running (the page is halted after step / press)',
  ops: 'what the player can do now (each op offer checked with can): ✓ shop.buy shop=bakery item=bread · ✗ … (reason); recipes/23-ops.md',
  op: 'run an op as source bridge (no time passes): op shop.buy shop=bakery item=bread n=2 (values converted by the op args shape)',
  inspect: 'what is around the player (or inspect npc_3 / inspect 10,-4) and which ops it can do now, with reasons. inspect materials (engine.inspect.materials(), plain three.js: scene.traverse + texture.colorSpace) = every material: textures (slot, size, color space, estimated GPU MB, shared-by), ' +
    'engine- or game-made, shader patches and their slots, meshes sharing it; materials that read the same are one line with ×N; wrong color spaces first (color map not sRGB = washed out; normal / roughness map marked sRGB). ' +
    'inspect perf (engine.inspect.perf(), plain three.js: renderer.info) = the last frame against budgets: draw calls, triangles, programs, texture MB (estimate), JS ms by phase, compile stalls during play, costliest programs; ✗ lines name the next call. ' +
    'Budgets: engine.budget limits, else a desktop reference. The engine benchmark suite is npm run perf',
  scene: 'the mesh exists but is not drawn: use this first. Counts, one Not drawn because: line over every Mesh / Points / Line / Sprite, then the first 6 undrawn ones (surprising before plain view culling) with every reason, most likely first: visible=false on it or a parent, layers vs camera, material flags, ' +
    'scale 0 / NaN, NaN position or vertices, empty geometry, behind the camera, beyond camera.far, outside the view. "maybe" reasons (depthWrite off, fully fogged...) do not stop drawing. scene [--hidden (only undrawn)] [--limit N | --full (40)] [--json]. Code: engine.inspect.scene(). Cannot see shader output',
  pick: 'what is at screen pixel x,y (from the canvas top-left): pick 480,270 -> record id, kind, template, where it is defined (content file:line), fields',
  explain: 'why: explain op shop.buy shop=bakery item=bread (can it run; --full adds its last attempt) / explain quest first-light (where it is stuck) / explain value fog.far (which line last changed it) / explain thing player-chest (where it is defined; --full: everything about the id as JSON) / explain module quests / explain capability ground. engine.explain; recipes/23-ops.md, recipes/40-scene.md section 9, recipes/62-picture-code.md',
  scenario: 'run one scenario test (tests/scenarios/<name>.json) on this page: scenario barter [--freeze-reload: saves do not reload the page during the run] (prints failed checks and the Coverage block of verify; the scenario leaves the page halted)',
  catalog: 'what the game can do: catalog = a line per module with ops or problems, the rest named on one line (--full: a line each); catalog shop = one module ' +
    '(dependencies, params + defaults, ops with args and failure codes, saved parts, time hooks, problems, doc / recipe / source files); catalog shop.buy ' +
    '= one op; catalog picture = picture menu + checks; catalog --find throw; --json for the raw data; recipes/51-capability-catalog.md',
  loading: 'what loading waits for / what failed / does it block the start (answers while start() is stuck); loading hero: one task with its manifest and path; recipes/05-props-bake.md',
};

/** Commands of dispatch.mjs: they work (or explain why not) without a running page */
export const EXTRA = {
  play: 'start the game for the AI: starts the dev server if none runs (detached, output in .threedog/dev.log), waits for the bridge and the engine, prints the page address and whether a headless or a live browser page is connected (play --stop stops the server play started)',
  impact: 'before a change, what it touches, from the files alone: impact coin / impact shop.buy / impact stack / impact collider3d lists content, calls, saved parts, templates, tests and engine facts, then says what it cannot see (names computed in game code, what only a page or a save holds). --full lists every place',
  report: 'one file another AI can rerun a problem from: engine version, seed, tick, describe, recent ops, errors with hints, modules and capability state, steps to reproduce and a derived scenario; no tokens or user paths. Writes .threedog/reports/ (--out file); --scenario also writes tests/scenarios/report.json for threedog verify report. Works with no page, and says what is then missing',
  status: 'is it ready: engine ready / loading / page errors / running, halted or frozen. When the bridge cannot answer it names one of five causes with one next step: no server (threedog play), server still starting (wait, status again), server busy and not answering in time (wait, status again), page script error (threedog errors latest), no dev bridge installed (use gameConfig)',
  'picture-palette': 'measure a reference picture, no game needed: picture-palette art/reference/ref.png [--n 8] [--average] [--ignore-ui] [--region x,y,w,h] (same as threedog picture palette)',
  'picture-compare': 'numbers for two pictures, no game needed: picture-compare ref.png .threedog/shots/snap.png [--region x,y,w,h] [--out side.png] (same as threedog picture compare)',
  verify: 'run a scenario (tests/scenarios/<name>.json) and report PASS / FAIL, what it tested (ops with outcomes, describe sections compared, time advanced) and what it never touched (ops never run, sections never compared, steps skipped after a failure, key path, picture): verify barter [--freeze-reload: saves do not reload the page during the run] [--save-baseline: perf medians to .threedog/]; a Perf: line if over budget or slower. ' +
    'Also a Layers: line (steps by layer: direct = op/describe call, simulated-input = bridge press; real-browser-input is always 0 and printed as not verified, visual 0 because scenario snapshots are describe, not pixels), tests that mention an error code seen, and the threedog test command to re-run. ' +
    'A page error during the run fails it. JSON adds layers / layerCounts / evidence (per-check layers, notProven, ops / modules coverage; text: Evidence, NOT proven, Coverage: ops ran/total with refused ones marked, modules tested / indirect / untested, lists capped with "+N more")',
};
