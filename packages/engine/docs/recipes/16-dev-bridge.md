# Dev bridge: operate the running game from the terminal (threedog describe / step / press / op...)

> **Covers:** driving the running game from the terminal: describe, step, press, state, scenarios, snapshots, MCP.
> **Use when:** checking a change without a screenshot or a browser script.
> **Shortest:** `threedog describe -w my-game`.
> **Sections:** 1 Usage · 2 Notes · 2b A scripted playthrough · 3 Windows / PowerShell · 3b Speed, a session · 4 Let describe see · 5 Safety · 6 Reuse in scenario · 7 Describe snapshots instead · 8 Errors carry a · 9 Reusable scenarios · 10 MCP server Claude · 11 When something happens

After changing code, ask the running game instead of writing a playwright script or taking a screenshot: look, advance time, press keys, change state. Output is a few English lines.

What the bridge changes lives in this session only: `op`, `step`, `state` and `js` alter the running game and its saves, never the level. To change
the level, edit `content/*.js` (templates, props, npcs…) or the level model and reload the page.

## 1. Usage
```
npm run dev -- my-game          # terminal A: start the dev server first (for the engine example just npm run dev)
threedog describe -w my-game     # terminal B: look at the scene (inside the game folder you can omit -w)
```
No browser needs to be open: when the first command arrives, the dev server itself opens a headless page with Playwright (`?threedog-headless`; the
game only advances on step); once you open the page in a browser, commands go to the real page you clicked most recently.

Every command and its options are in `../COMMANDS.md`. What each does to the game:

| Moves game time | Changes state, no game time | Only looks |
|---|---|---|
| `step`, `press`, `hold`, `skip`, and `scenario` / `verify`, which use them | `op`, `state` (only its `wait=` moves the clock), `js` | `describe`, `ops`, `inspect`, `pick`, `explain`, `errors`, `loading`, `snap`, `snap-describe` |

- `describe` is one line: position, time and weather, nearby, quest. `describe player.position` or any dotted path of `engine.describe()` reads one item (`--max characters`). `describe --full` is the state as text in at most 30 lines (`engine.describeText()`: the nearest things, the game's `describe.add` sections, one line per module, the engine tables as one count line, and how to expand); `--all` is everything and large, so prefer a path. In code: `engine.describe('picture')`, `describe({ only: ['picture', 'shared'] })`. `describe render` lists how the picture is set; it informs and never warns.
- `step 2` is deterministic; a real-time page is halted first.
- `press interact` takes an action name or key (`KeyE`, `e`, `Escape`). **It advances game time**: 0.1 s held + one rendered frame of 1/60 s, about 0.117 s; shorten the hold with `--for 0.02` when timing matters.
- `op shop.buy shop=trader item=medkit n=2` runs as source `bridge`. Values follow the op's `args` shape (`n=2` a number, `position=3,0,-2` an array). **Change state with this, not `js`**: `js` writes skip the op log.
- `ops` lists every offer checked with `can`; `inspect [id | x,z]` adds what is around, with reasons (recipes/23-ops.md section 8); `explain op ...` / `explain quest ...` says why one cannot run or where a quest is stuck (`--full` adds the last attempt and events around it).
- `state time=18:30 weather=rain pos=40,-20` sets the scene like URL parameters (`engine.applyState`). A weather name must be in the game's table (`describe weather`; `weather({ types: presets.weather.temperate })`, which `--open-world` games start with): what could not be applied fails with the reason and exit 1.
- `js "engine.calendar.timeOfDay"`: `engine` is available directly and `await` works inside; multi-line statements need their own `return` (`js "const p = engine.player.position; return p.x + p.z"`). Long scripts: `js --file script.js`.
- `scenario barter` runs `tests/scenarios/barter.json` (recipes/23-ops.md section 7), prints failed checks and leaves the loop halted.

## 2. Notes
- **Smallest scenario** (`tests/scenarios/coins.json` <!-- r18-ignore-line -->, then `threedog verify coins` or `scenario coins`; `verify` with no file says "Have: none"):
  `{ "name": "coins", "url": "/", "state": { "pos": "6,4" }, "steps": [ { "step": 1 }, { "expect": { "inventory.items.coin": 1 } } ] }`
- **Position formats**: `pos=x,z` (state, shot, `applyState`) is two numbers on the ground plane, and the height is looked up; an op argument such as `position=3,0,-2` is `x,y,z`. Both are meters, north is -z. `describe` reports the player as `{ x, y, z }` (`describe player.position`).
- **Teleport the player**: `threedog state "pos=40,-20"`, or `await engine.applyState({ pos: '40,-20' })` in a test or `js` (both wait for the ground to load). A bare
  `player.placeAt` outside an op prints the ops-guard warning. `step 1` after it collects `auto` pickups.
- **Ops with a reach** (`interaction.use`, `pickup.take`) check the player's distance as a key press would, also from the bridge: put the player next
  to the thing first (`threedog state "pos=x,z"`), then `threedog op interaction.use id=gate`. A `tooFar` result carries `facts: { distance, radius, at }`.
- **`shot` always starts a fresh game** (`?save=slot1` loads one); after playing use `snap name`. Every shot prints the picture numbers and hints (recipes/35 "Picture check after every shot").
- **`step` / `press` halt the real page's loop**; resume with `threedog resume` when done (they halt as owner `threedog`, so nothing of the game's is touched). A headless page only advances on step anyway.
- **Run state** is printed after `step` / `press` / `skip` / `resume` and by `threedog status`: `running`, `title-frozen` (title screen waiting for start), `halted` (the loop is stopped: the bridge, a test or a headless page), `frozen(by owners)` (every `freeze` owner, e.g. `ui-inventory` or `page`) or `loading`. The same object is `engine.runState` and `describe().time.run`: `{ state, owners, blockedBy }`, where `blockedBy` lists what keeps input from driving the game (opaque input contexts such as `win-settings`, `ui-title`, `dialogue`, `cutscene`, plus `error` and `loading`); the bridge and the MCP tools copy it as-is.
- **Who holds what**: `describe().holds` lists every holder in one place: `halt / freeze / camera / debugView` as `[{ owner, at }]` (`at` = game clock time of the take, `engine.clock.now`, so two new games read the same), `input` (pushed contexts `[{ context, owner, pass }]`), `gates` (`input.gate` owners by action) and `stacks` (every other `engine.mod` quantity), so a stuck pause, a closed jump or a camera nobody gave back has a name.
- **`snap` on a real page captures only the canvas** (not the HTML UI); on a headless page it captures the whole page. To see UI state use `describe`
  (`ui.windows`, dialogue).
- **Keys go through `engine.input` like a real keyboard**: action names are translated to keyboard keys (gamepad buttons are ignored); when a window
  locks input, menu-type actions (`pressedRaw`) are still received.
- **In your own page scripts and tests use `engine.input.simulate(action, down = true)`** (the same path as `press`): `engine.input.simulate('jump'); engine.step(1 / 60); engine.input.simulate('jump', false)`.
- `describe` by default gives only the 3 nearest things and the first quest; for detail use a path (`quests.active`, `nearby`, `world`) or `--full`.
- Several pages: `--page /<page>.html` picks the path; `-w name` picks the workspace.
- Another port (`npm run dev -- my-game --port 5000`) is found through `.threedog/dev.json`.
- Never ready: the dev server attaches `window.engine` itself, but a bundled build (npm test) needs `window.engine = engine;` before `await engine.start()`; the timeout error says which is missing.

## 2b. A scripted playthrough, and three kinds of check
```
threedog state fresh=1 play=1         # clean start: no saves, past the title
threedog state pos=0,0 time=12:00     # known place
threedog hold moveForward 1.5         # walk (real key path, advances 1.5 s)
threedog press interact               # one key press (~0.117 s)
threedog step 2                       # let things happen
threedog js "engine.player.position.x > 1"   # state assertion: read the ✓ true / false
threedog snap after-walk              # only now look at pixels
```
The same steps as a file: `tests/scenarios/<name>.json` with `{ "press": … }`, `{ "step": … }`, `{ "until": …, "within": s }`, `{ "expect": { path: value } }` (section 9; no `hold` there).
- **State checks** (`op`, `expect`, `describe`, `js`): fast and exact, but they skip input. They prove rules, not that the player can reach them.
- **Simulated-input checks** (`press`, `hold`, `engine.input.simulate`): bridge key events through the game's input path, never a physical keyboard/mouse. `verify` prints which layer each check ran on, what it did **not** prove (pointer lock and mouse look, real GPU/visuals, real FPS) and coverage (ops run vs defined; modules tested, indirect or untested; uses `engine.catalog()`); `scenario` prints the same coverage, and `--json` has the full lists.
- **Visual checks** (`snap`, `shot`): the only ones that see the picture (exposure, color, UI overlap). Slowest; take them last.

**Script the failures, not only the win.** Every end state gets a scenario: lose, die and respawn, retry, reload mid-run (`threedog reload` between bridge commands; a scenario file has no reload step). Read `ops never run` in the `verify` report (rules no script reached), then check what the player stands in after the failure: a closed-off respawn point, a hit landing after the blow that should end contact, a timer or lock left from the last attempt.

Playing a game through from a script, the five things that cost the most time:
- **Start clean.** Enter on a title picks Continue when a save exists, so a rerun by keys plays the last autosave. `state fresh=1` deletes the saves and
  goes back to the title, `play=1` starts the run; `?fresh&play` does the same in a URL. `session.newGame()` alone leaves the title open.
- **Advance time yourself.** On a headless page the clock moves only on `step`, `press` and `hold`, so `await player.walkTo(spot)` never returns. Start it,
  step, then await: `const w = engine.player.walkTo(spot); step(5); return await w`. A `js` script whose page clock stands still for 20 s ends with that reason.
- **Continue finishes after `press` returns.** The load is async, so the first lines of `press` on a title still say `windows open title`; the `Changed:` line and the next command show it closed. A load that waits on frames needs a `step` on a halted page.
- **Read why it was refused.** `interaction.use` fails with `inputLocked` and `facts: { by }` (`title`, `dialogue`, `settings`...), `tooFar` with the distance.
- **Press real keys when input is the question**: the title menu, whether a key reaches the action, a hold. For rules use `op` and `state`: faster and exact.
  Neither tells you how the game feels or sounds, and a headless picture falls back to software WebGL2 where no hardware GPU is reachable (the `shot` / `snap` line says): report those as not verified.

## 3. Windows / PowerShell notes
- **Quote commas**: PowerShell splits `pos=1,-8` into two arguments and the coordinates become NaN. Write `threedog state "pos=1,-8"` (the bridge
  reports an error and shows this tip when pos is not two numbers).
- Wrap the whole `js` expression in **double quotes** and use single quotes for strings inside: `threedog js "engine.vars.counter('score')"`.
  PowerShell expands `$variables` inside double quotes; to pass `$` literally wrap the whole thing in single quotes.
- **Write a command on a single line** (a multi-line here-string to a native command often returns nothing): separate statements with semicolons, or use `threedog js --file script.js`.
- Some terminal sandboxes (Bash) block commands containing the word `eval`: use `js`, not `eval`.

## 3b. Speed, a session, and checks in one call

The bin called directly is the fastest route (COMMANDS.md, first lines); `threedog session` saves a little more per command. Commands behave identically with or without it.

- `threedog js --file steps.js`: the whole test in one file, one round trip. Inside: `assert(cond, msg)`, `expect(v).toBe(x)` (also `toEqual`, `toBeCloseTo(x, tol)`, `toBeGreaterThan`), `step(seconds)`, `log(...)`, and `engine`. It prints the failures and one summary line, exit code 1 on failure:

```js fragment
step(2);
const before = engine.time.tick;
step(1);
expect(engine.time.tick).toBeGreaterThan(before, 'time advanced');
```

## 4. Let describe see the game's own state
A game's own state (score, number of targets, crops) is not in `describe` by default. **Small games use this**: register it in one line, no module needed:
```js
engine.describe.add('range', () => ({ score, targets: targets.length }));  // the returned handle's .remove() cancels it
```
After that `threedog describe range` shows it, and `describeText()` lists it before the module lines. The name must not collide with a core field or a module name;
a callback that throws shows `{ error }` for this item only. **Large games use modules** (14-custom-module.md): the module's `describe(e, ctx)` hook goes into `describe().<module name>`.

## 5. Safety
The bridge exists only in the dev server (`apply: 'serve'`); built and preview output contains no bridge code. The command entry point `POST /__threedog/cmd` accepts only local connections, requires the random token in `.threedog/dev.json`, the Host must
be localhost, and anything carrying an Origin (sent from a web page) is rejected.

## 6. Reuse in scenario tests
The bridge commands are built on one small driver, `{ evaluate(src, arg), screenshot(), reload?() }`. The dev bridge's driver forwards the three to
the dev server. For your own tests, `import { pageDriver, runScenario } from '@threedog/tools/scenario'` (the public entry; the command runner behind
the bridge is internal) gives the same driver for a Playwright `page` and runs a scenario file through it.

## 7. Describe snapshots instead of screenshots
A baseline is the gameplay part of `engine.describe()` saved as JSON (`<workspace>/tests/snapshots/<name>.describe.json`, commit it). `perf`, `loading`, `picture.writers` and the clock counters `time.tick` / `time.real` / `time.ambient` are dropped; numbers compare within a tolerance (default 0.5); a list of things with an `id` or `name` is compared by that key, so a
reordered `nearby` is not a change. A difference comes out as text, e.g. `player.x: 10 -> 14 (changed 4, tolerance 0.5)` or `nearby[Cow]: added {...}`.

```
threedog snap-describe save market-noon --only player,quests,nearby     # write / overwrite the baseline
threedog snap-describe diff market-noon --only player,quests,nearby     # compare the running page with it (exit code 1 if different)
```
Options: `--only a,b.c` (compare just these fields; dotted paths allowed), `--ignore x.y` (extra fields to skip), `--tolerance 1`. Use the same
`--only` for save and diff.

In a test, one line (the page must already be in the state to freeze; use `engine.haltLoop()` and `engine.step()` first):
```
import { expectDescribe } from '@threedog/tools/describe-snapshot';  // in the engine's own specs: '../../../tools/describe-snapshot.mjs'
await expectDescribe({ check, ev }, 'market-noon', { only: ['player', 'quests', 'nearby'], tolerance: { default: 0.5, player: 1 } });
```
Update after an intended change: `threedog test <name> --update-snapshots` or `threedog snap-describe save <name>`, and review the JSON diff before committing.

## 8. Errors carry a code, a fix and a doc page
Every error and warning the engine raises carries a stable **code**: `err.code`, `err.fix` (what to do) and `err.docs` (pages to read), and its message
ends with `[code]` (e.g. `clock.every(seconds): ... [clock-interval]`), so logs show it too. Messages the engine does not write (JavaScript's
`Cannot read properties of undefined`, `... is not a function`, a frozen definition, a browser resource 404) get the code of the hint whose pattern matches. Dev text adds `Code: …`
(when the message has no tag), `Possible cause: …` and `Read: recipes/…, api/…`. The same data shows in `engine.error`
(`{ where, message, code, fix, docs }`), the first line of `describeText()`, `.threedog/errors.log` and `threedog errors`. A code never changes meaning.

## 9. Reusable scenarios
`engine.applyState({ time, weather, pos, ... })` (also URL parameters) sets up a scenario in one call; `engine.defineState(name, params)` names a
combination so tests and scenarios reuse it.

## 10. MCP server: Claude Code, Cursor and other MCP clients
`threedog mcp` runs the dev bridge as an MCP server over stdio. Each command becomes a tool (`play`, `status`, `describe`, `step`, `press`, `hold`, `skip`, `state`, `ops`,
`op`, `catalog`, `inspect`, `scene`, `pick`, `thing`, `explain`, `errors`, `loading`, `snap`, `snap_describe`, `picture_palette`, `picture_compare`, `scenario`, `verify`, `reload`, `resume`, and the static `how`, `check`, `art_list` and `lib_list`) and returns the same text as the
command line (every default answer fits in about 4 KB; a `data` payload over 3 KB keeps its small fields and names `threedog <cmd> --json` for the rest); `snap` also returns the PNG as an image, 480 px wide by default (`size` for more; the full file is saved). `picture_palette` and `picture_compare` need no game (recipe 35). It finds the dev server through `.threedog/dev.json` like the CLI; with none running, call the `play` tool (it starts the server and waits for the bridge)
(or start `npm run dev` yourself; a tool call without a server answers with that fix). It is only a local client of the bridge and opens no port; every check in section 5 still applies. As
with the command line, the `op` and `step` tools change the current session and its saves; the level itself changes only by editing content files.

Claude Code (in the game folder; in the engine repository add `-w name` after `mcp`):
```
claude mcp add threedog -- node node_modules/@threedog/tools/bin/threedog.mjs mcp
```
Cursor, `.cursor/mcp.json` in the game folder: <!-- r18-ignore-line -->
```
{ "mcpServers": { "threedog": { "command": "node", "args": ["node_modules/@threedog/tools/bin/threedog.mjs", "mcp"] } } }
```
Plain node is the same on every OS. `npm run new-game` writes a `.mcp.json` like this into the new game, so Claude Code picks it up.

The `js` tool (arbitrary code in the page) is off by default; `threedog mcp --allow-js` enables it, for development only. Other options: `-w name`
(workspace), `--page /<page>.html` (page path).

## 11. When something happens: which tool
Tools: MCP, or `node node_modules/@threedog/tools/bin/threedog.mjs <cmd>` (`COMMANDS.md`). Errors: `.threedog/errors.log`, **read first when something breaks**.
- Not sure the engine has X -> `threedog how "<task>"`, `threedog catalog [id]`.
- An action failed -> its `code`, `facts`, `nextActions`.
- What is this object, why can't I click it -> `explain({ thing: id })`.
- Stuck, or a value is not what you set -> `describe().holds` / `.shared` / `.control`.
- What caused this -> `events.trace(name)`, `traceFocus(id)`.
- Placeholders (gray picture, capsule, boxes) -> the picture is not made yet: `picture/` (recipes 62, 09), code models (05), tuning (35).
- The picture looks wrong -> `engine.debug.view('lighting')`, `describe().picture`, `threedog inspect materials`.
- Slow or stutters -> `threedog inspect perf`, `debug.view('shaderCost')`.
- "... so the engine stopped writing it" -> your direct write owns it now: `engine.autoView.manual(key)`, `describe().owned` (recipe 52).
- Models made in code -> hot swap, `threedog gallery --shots` (recipe 05 §2c); another game's art -> `threedog art copy`.
- Verifying a change -> `describeText()` for logic, shots for the picture, `threedog verify <scenario>` (read "not proven").
- Saves or time skips broken -> `checkSave`, `checkSkip`.
