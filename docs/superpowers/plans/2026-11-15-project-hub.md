# Project Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `threedog hub` — a local web page listing all threedog projects, creating new ones, and showing each project's auto-refreshing screenshot wall, opened from a desktop icon.

**Architecture:** A plain Node `http` server in `@threedog/tools` (no new dependencies) serves one static page and a small JSON API with a server-sent-events stream. Pure modules (point list, wall store, registry, queue) are unit-tested; the shooting reuses the existing build/browser/wait code of `shot.mjs` through one extracted helper.

**Tech Stack:** Node ≥20.19, ES modules, existing `browser.mjs` / `wait-engine.mjs` / `lib/page-url.mjs`, `node:fs.watch` (recursive, Windows-supported), PowerShell `WScript.Shell` for the .lnk.

**Spec:** `docs/superpowers/specs/2026-11-15-project-hub-design.md` (read it first; it is in Chinese — its decisions are restated here in English).

## Global Constraints

- No new npm dependencies.
- Everything under `packages/tools/hub/` plus `packages/tools/hub.mjs` (the command script). New folder `hub` must be added to `files` in `packages/tools/package.json`.
- Registry path: `join(process.env.THREEDOG_HOME ?? join(homedir(), '.threedog'), 'projects.json')` — content `{ "projects": ["<abs path>", …] }`.
- Points file: `<project>/shots.json`. Allowed keys per point: `name` (required, non-empty string, unique in the file), `page`, `view`, `cam`, `pos`, `at`, `play`, `time`, `weather`, `wait`, `size`. `view` and `cam` together is an error (same conflict as `shot`). Unknown key → error naming key and point index/name.
- Wall store: `<project>/.threedog/wall/`; manifest `index.json`; keep the newest **10** pictures per point, delete older files.
- Re-shoot debounce: **30 s** of no file change. Ignore `node_modules`, `.threedog`, `dist`, `.git`.
- One shooting job at a time across all projects (one build + one headless browser for all points of a project). At most one project dev server at a time.
- Default port **5180**, host `127.0.0.1`. A second `threedog hub` finding a live hub on that port opens the browser to it and exits 0.
- Add-existing-folder accepts only a folder whose `package.json` lists `threedog` in dependencies or devDependencies.
- Tool output short (one line per event); code comments in English, following the repo's "why" comment style.
- Desktop icon: Windows only; elsewhere print the command.
- Do not edit any roadmap file.

## Review Focus

1. A project folder deleted/moved while the hub runs → card shows "not found" + Remove; watcher error must not crash the server. (Task 5 test)
2. `shots.json` saved half-written (invalid JSON) by an AI mid-edit → project-level error shown, previous pictures kept, next valid save shoots. (Task 1 test + Task 4 test)
3. A file changes *while* that project is being shot → exactly one more run after the current one, not zero and not a pile. (Task 4 test)
4. Two projects with the same folder name → distinct ids, both listed. (Task 2 test)
5. Hub started from a game's node_modules copy, then that game deleted → desktop icon retargeted next start from another copy; a stale target never blocks start. (Task 7 test on the pure retarget decision)

---

### Task 1: Point list parser

**Files:**
- Create: `packages/tools/hub/points.mjs`
- Test: `packages/tools/tests/hub-points.mjs`

**Interfaces:**
- Produces: `parsePoints(text: string | null): { points: Point[], error: string | null, pointErrors: {index:number, name?:string, message:string}[] }` where `Point = { name, page?, view?, cam?, pos?, at?, play?, time?, weather?, wait?, size? }`. `text === null` (no file) → `{ points: [{ name: 'default' }], error: null, pointErrors: [], missing: true }`.
- Produces: `pointQuery(p: Point): URLSearchParams` — the same URL keys `shot.mjs` sets (`time weather pos at view`, `cam`→`view`, `wait` default `1`, `cutscene=skip`, `play` → `play=''`, `threedog-tier=high`).
- Produces: `pointFile(name: string): string` — safe file stem (replace chars outside `[\p{L}\p{N}_-]` with `-`).

- [ ] **Step 1: Write the failing test** (test file style: `export const name`, `export async function run({ check })`, as `tests/game-root.mjs`)

```js
check('missing file → one default point', parsePoints(null).points[0].name === 'default');
check('invalid JSON → project error, no points', parsePoints('[{').error && parsePoints('[{').points.length === 0);
check('not an array → project error', !!parsePoints('{}').error);
const r = parsePoints(JSON.stringify([{ name: 'a', view: 'x' }, { name: 'b', colour: 1 }, { name: 'c', view: 'v', cam: [0,1,2,0,0,0] }, { view: 'y' }, { name: 'a' }]));
check('valid point kept', r.points.map(p => p.name).join() === 'a');
check('unknown key named', r.pointErrors.some(e => e.name === 'b' && /colour/.test(e.message)));
check('view+cam refused', r.pointErrors.some(e => e.name === 'c'));
check('missing name refused', r.pointErrors.some(e => e.index === 3));
check('duplicate name refused', r.pointErrors.some(e => e.index === 4 && /a/.test(e.message)));
check('query', pointQuery({ name: 'n', cam: [0,12,30,0,0,0], play: true }).get('view') === '0,12,30,0,0,0' && pointQuery({ name: 'n' }).get('wait') === '1');
check('file stem', pointFile('村口 全景/1') === '村口-全景-1');
```

- [ ] **Step 2:** Run `npm test -- hub-points` from repo root. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `packages/tools/hub/points.mjs`. Reuse `camPose` from `lib/shot-name.mjs` to validate `cam` (array or string form `x,y,z,tx,ty,tz[,fov]`); reuse `viewSize` for `size`.
- [ ] **Step 4:** Run `npm test -- hub-points`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(hub): shots.json point parser`.

### Task 2: Project registry

**Files:**
- Create: `packages/tools/hub/registry.mjs`
- Modify: `packages/tools/init.mjs` (after the package.json write: `addProject(dir)`; never fail init if it throws — print one `!` line)
- Test: `packages/tools/tests/hub-registry.mjs`

**Interfaces:**
- Produces: `registryPath(env = process.env): string`
- Produces: `listProjects(env?): { id: string, dir: string, name: string, exists: boolean }[]` — `id` = first 10 hex of sha1 of the lower-cased absolute path; `name` = package.json name, else folder name.
- Produces: `addProject(dir: string, env?): { ok: true, id } | { ok: false, reason: string }` — refuses when no `package.json` or no `threedog` dependency; adding twice is ok and not duplicated.
- Produces: `removeProject(id: string, env?): boolean`
- Writes atomically with `lib/atomic.mjs`.

- [ ] **Step 1: Write the failing test** — temp `THREEDOG_HOME` via `mkdtempSync`; make two temp games `a/farm` and `b/farm` with `{"dependencies":{"threedog":"^1.3.0"}}`, one folder without the dep.

```js
check('two same-named folders get distinct ids', ids.size === 2);
check('folder without threedog refused with reason', !bad.ok && /threedog/.test(bad.reason));
check('adding twice does not duplicate', listProjects(env).length === 2);
rmSync(farmA, { recursive: true });
check('deleted folder listed as not existing', listProjects(env).find(p => p.dir === farmA).exists === false);
check('remove', removeProject(idA, env) && listProjects(env).length === 1);
check('threedog init registers the new game', /* spawn bin init into tmp with env THREEDOG_HOME */ listProjects(env).some(p => p.dir === initDir));
```

- [ ] **Step 2:** `npm test -- hub-registry` → FAIL.
- [ ] **Step 3:** Implement; wire `init.mjs`.
- [ ] **Step 4:** `npm test -- hub-registry game-root` → PASS (game-root guards init behaviour; pass `THREEDOG_HOME` to a temp dir there too so tests never touch the real home — add it to that test's spawn env).
- [ ] **Step 5:** Commit `feat(hub): project registry; init registers the game`.

### Task 3: Wall store

**Files:**
- Create: `packages/tools/hub/wall.mjs`
- Test: `packages/tools/tests/hub-wall.mjs`

**Interfaces:**
- Consumes: `pointFile` (Task 1).
- Produces: `wallDir(dir): string`; `readWall(dir): Wall` where `Wall = { runAt: number|null, error: string|null, points: { [name]: { shots: {file, at}[] /* newest first */, error: string|null } } }` (missing/broken index → empty wall).
- Produces: `newShotPath(dir, name, at: number): string` (`<wall>/<stem>-<at>.png`).
- Produces: `recordRun(dir, { at, error?, results: { name, file?, error? }[], keep = 10 }): Wall` — prepends shots, sets per-point error (a failed point keeps its old shots), drops points no longer in `results` only from the manifest order (keep their files until 10-rule — simpler: delete files of points absent from results), deletes files beyond `keep`, writes index atomically.

- [ ] **Step 1: Failing test** — record 12 runs for point `a` → `readWall(d).points.a.shots.length === 10` and the 2 oldest files are gone from disk; a run with `{name:'a', error:'boom'}` keeps 10 shots and sets error `'boom'`; project-level `error` stored; corrupt `index.json` → empty wall.
- [ ] **Step 2:** `npm test -- hub-wall` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test -- hub-wall` → PASS.
- [ ] **Step 5:** Commit `feat(hub): wall store keeps the newest 10 per point`.

### Task 4: Re-shoot queue and watcher

**Files:**
- Create: `packages/tools/hub/queue.mjs`
- Test: `packages/tools/tests/hub-queue.mjs`

**Interfaces:**
- Produces: `createQueue({ shoot: (id) => Promise<void>, delay = 30000, timers = { setTimeout, clearTimeout } }): { touch(id), now(id), busy(): string|null, pending(): string[], stop() }`
  - `touch(id)`: (re)start that id's debounce timer; on fire, enqueue.
  - `now(id)`: enqueue immediately (button), clearing its timer.
  - Enqueue is a set: an id already waiting is not added twice. An id that is *being shot* when enqueued runs once more after.
  - Strictly one `shoot` at a time; `shoot` rejection is caught (the shooter records its own errors).
- Produces: `watchProject(dir, onChange: () => void): () => void` — `fs.watch(dir, { recursive: true })`, ignoring paths whose first segment is `node_modules|.threedog|dist|.git`; watcher `error` event → stop watching, no throw. Returns close.
- Produces: `newestChange(dir): number` — newest mtime among files outside the ignored folders (walk, skip ignored).

- [ ] **Step 1: Failing test** with fake timers (an array of pending callbacks advanced manually) and a `shoot` that resolves on demand:

```js
q.touch('a'); q.touch('a'); advance(30000);
check('debounced touches → one run', calls.join() === 'a');
q.touch('a'); advance(30000);   // while 'a' is still shooting
q.touch('a'); advance(30000);
finish(); await tick();
check('changes during a run → exactly one more run', calls.join() === 'a,a');
q.now('b'); q.now('c');
check('one at a time', running === 1);
// watcher: temp dir, write node_modules/x.js → no call; write main.js → call within 2 s; rm the dir → no throw
```

- [ ] **Step 2:** `npm test -- hub-queue` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test -- hub-queue` → PASS.
- [ ] **Step 5:** Commit `feat(hub): debounced one-at-a-time re-shoot queue, project watcher`.

### Task 5: Shooting a project (shared with `threedog shot`)

**Files:**
- Create: `packages/tools/lib/shot-page.mjs`
- Modify: `packages/tools/shot.mjs` (the goto → waitEngine → refuseState → waitLoaded → `engine.ui.settled()` block, current lines ~126–142, becomes one call; output and options unchanged)
- Create: `packages/tools/hub/shoot.mjs`
- Test: `packages/tools/tests/hub-shoot.mjs` (real render, software, one tiny game: run `threedog init` into a temp folder pointing at this repo's packages via the same approach `tests/game-root.mjs` uses, or reuse an existing fixture under `tests/fixtures` if one is a buildable game — check first)

**Interfaces:**
- Produces: `openShotPage(page, base: string, url: string, q: URLSearchParams, { errors, loadTimeout = 120 }): Promise<{ tail }>` in `lib/shot-page.mjs` — exactly the steps `shot.mjs` does today, including `refuseState(page, keys present in q)`.
- Consumes: `parsePoints`, `pointQuery` (Task 1); `newShotPath`, `recordRun` (Task 3); `buildAndPreview`, `launchBrowser`, `newGamePage` (`browser.mjs`).
- Produces: `shootProject(dir: string, { onPoint?: (name, ok) => void } = {}): Promise<Wall>` — reads `shots.json`; project-level parse error → `recordRun` with `error`, no build; else one `buildAndPreview(dir)` (build failure → project error `"build failed: <first line>"`), one browser (`prefer: 'gpu'`), one page **per point** (fresh state each), `page.screenshot` to `newShotPath`; per-point errors recorded, others continue; always closes browser and server. Sets `process.env.THREEDOG_TEST = '1'` only for its own build (save & restore).

- [ ] **Step 1: Failing test** — game with `shots.json` = two valid points + one with `"at": "nowhere"`:

```js
const wall = await shootProject(game);
check('two pictures written', ['p1','p2'].every(n => existsSync(wall.points[n].shots[0].file)));
check('a bad point fails alone with a reason', !!wall.points.bad.error && !wall.points.bad.shots.length);
writeFileSync(join(game, 'shots.json'), '[{');
const w2 = await shootProject(game);
check('broken shots.json → project error, old pictures kept', !!w2.error && w2.points.p1.shots.length === 1);
```

- [ ] **Step 2:** `npm test -- hub-shoot` → FAIL.
- [ ] **Step 3:** Extract `openShotPage`, switch `shot.mjs` to it, implement `hub/shoot.mjs`.
- [ ] **Step 4:** `npm test -- hub-shoot cli-surface` → PASS; then one manual `npx threedog shot -w <temp game>` prints the same lines as before.
- [ ] **Step 5:** Commit `feat(hub): shoot all points of a project with one build and one browser`.

### Task 6: Server, page and command

**Files:**
- Create: `packages/tools/hub.mjs` (command script; header comment = `--help` text: `threedog hub [--port 5180] [--no-open] [--shortcut]`)
- Create: `packages/tools/hub/server.mjs`, `packages/tools/hub/page/index.html`, `packages/tools/hub/page/hub.js`, `packages/tools/hub/page/hub.css`
- Modify: `packages/tools/bin/threedog.mjs` (`SCRIPTS.hub = 'hub.mjs'`; add `hub` to `NEEDS_NODE`; USAGE gains `threedog hub [--shortcut]`), `packages/tools/package.json` (`files` += `hub`), `packages/engine/docs/COMMANDS.md` (one entry — `cli-surface` test requires every SCRIPTS command documented)
- Test: `packages/tools/tests/hub-server.mjs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `startHub({ port = 5180, env = process.env, shoot = shootProject }): Promise<{ url, close }>`; API (all JSON):
  - `GET /api/ping` → `{ hub: 'threedog', version }` (single-instance probe)
  - `GET /api/projects` → `[{ id, name, dir, exists, cover: url|null, updatedAt, error, busy, queued, pointsMissing }]`
  - `GET /api/projects/:id` → `{ …card, points: [{ name, shots: [{ url, at }], error }] }`
  - `POST /api/projects` body `{ dir }` → add existing (400 with `reason`)
  - `POST /api/new` body `{ parent, name, template: 'blank'|'open-world'|'pixel'|'scene-only' }` → spawn `bin/threedog.mjs init <parent>/<name> [--flag]` then `npm install` in it (stream progress lines over SSE), then register and queue a shoot
  - `DELETE /api/projects/:id` → remove from list (files untouched)
  - `POST /api/projects/:id/reshoot` → `queue.now(id)`
  - `POST /api/projects/:id/open` body `{ what: 'game'|'editor'|'gallery' }` → close any other project's dev server, `devServer(dir)`, reply `{ url }` (`/`, `/?editor=1` — check the editor's real switch in `vite/vite-threedog-editor.js` — `/?gallery=1`)
  - `POST /api/quit` → close everything, exit 0
  - `GET /wall/:id/<file>` → the PNG from that project's wall dir (reject `..`)
  - `GET /events` → SSE: `{ type: 'project', id }` whenever a card/wall changes, `{ type: 'log', line }` for new-project progress
- On start: for each existing project, `watchProject` → `queue.touch(id)`; if `newestChange(dir) > readWall(dir).runAt` → `queue.touch(id)`.
- `hub.mjs`: probe `GET http://127.0.0.1:<port>/api/ping`; live → open browser, exit 0; else `startHub`, print one line `Hub: http://127.0.0.1:5180 (Ctrl+C or close this window to stop)`, open the browser (`start ""` on Windows / `open` / `xdg-open`) unless `--no-open`; on start call `ensureShortcut({ onlyIfPresent: true })` from Task 7.
- Page: plain HTML/JS, no framework. Two views by hash: `#/` project cards grid (cover, name, updated time, status badge "shooting…/queued/error/not found"), "New project" form, "Add folder" (text field for a path — a browser cannot pick folders by path), "Put icon on desktop", "Close hub"; `#/p/<id>` wall: grid of points (latest picture, name, time or error line), "Re-shoot now", "Open game / Editor / Assets", clicking a picture opens a lightbox with that point's older pictures as a strip. Colors as CSS custom properties on `:root` with a `prefers-color-scheme: dark` set; cards reflow to one column under 600 px.

- [ ] **Step 1: Failing test** — `startHub({ port: 0, env: { THREEDOG_HOME: tmp }, shoot: fakeShoot })` (fake writes a 1×1 PNG via `recordRun`):

```js
check('ping', (await get('/api/ping')).hub === 'threedog');
check('add folder without threedog → 400 with reason', r.status === 400 && /threedog/.test(r.body.reason));
check('add game → listed', (await get('/api/projects')).length === 1);
await post(`/api/projects/${id}/reshoot`); await until(() => fakeShoot.calls === 1);
check('reshoot → cover url served as image/png', res.headers['content-type'] === 'image/png');
check('path traversal refused', (await raw(`/wall/${id}/..%2F..%2Fpackage.json`)).status >= 400);
rmSync(game, { recursive: true });
check('deleted project → exists:false, server alive', (await get('/api/projects'))[0].exists === false);
check('SSE sends a project event after reshoot', sawEvent);
```

- [ ] **Step 2:** `npm test -- hub-server` → FAIL.
- [ ] **Step 3:** Implement server, page, command, CLI wiring, COMMANDS.md entry.
- [ ] **Step 4:** `npm test -- hub-server cli-surface` → PASS. Manual: `node packages/tools/hub.mjs` opens the page; add the `demonstration` game folder; wall fills; edit its `main.js`, after ~30 s the picture changes without reload. **Stop the hub afterwards** (no leftover dev servers/browsers).
- [ ] **Step 5:** Commit `feat(hub): threedog hub server and page`.

### Task 7: Desktop icon

**Files:**
- Create: `packages/tools/hub/shortcut.mjs`, `packages/tools/hub/threedog.ico` (from `docs/brand/threedog-icon.png`, sizes 16/32/48/256 — write the ICO by hand from PNG frames in a one-off script outside the repo; commit only the .ico)
- Modify: `hub.mjs` (`--shortcut`), `hub/server.mjs` (`POST /api/shortcut`)
- Test: `packages/tools/tests/hub-shortcut.mjs`

**Interfaces:**
- Produces: `shortcutPlan(platform, { desktop, current: { target, args } | null, node: string, script: string }): { action: 'create'|'retarget'|'none'|'unsupported', target, args, icon }` — pure decision; `target` = `node` (process.execPath), `args` = `"<script>"` where `script` = absolute `hub.mjs` of this copy.
- Produces: `ensureShortcut({ onlyIfPresent = false } = {}): { action, path?, message }` — Windows: desktop via `[Environment]::GetFolderPath('Desktop')` (handles OneDrive-redirected desktops), read existing `threedog.lnk` target via PowerShell `WScript.Shell` `CreateShortcut(path).TargetPath/Arguments`, then create/retarget with `WindowStyle = 7` (minimized), `IconLocation` = the .ico, `WorkingDirectory` = home dir. `onlyIfPresent`: only retarget an existing icon, never create. Non-Windows → `unsupported` with message `run: npx threedog hub`. PowerShell failure → return message, never throw.

- [ ] **Step 1: Failing test** (pure function only; no real desktop writes):

```js
check('no icon → create', shortcutPlan('win32', { current: null, … }).action === 'create');
check('icon pointing at a deleted copy → retarget', shortcutPlan('win32', { current: { target: node, args: '"C:/gone/hub.mjs"' }, … }).action === 'retarget');
check('icon already right → none', …action === 'none');
check('mac → unsupported', shortcutPlan('darwin', {…}).action === 'unsupported');
```

- [ ] **Step 2:** `npm test -- hub-shortcut` → FAIL.
- [ ] **Step 3:** Implement; wire `--shortcut` and the page button.
- [ ] **Step 4:** `npm test -- hub-shortcut` → PASS. Manual once: `node packages/tools/hub.mjs --shortcut` → icon on desktop; double-click opens the page; double-click again opens only a browser tab. Close the hub.
- [ ] **Step 5:** Commit `feat(hub): desktop icon`.

### Task 8: Template, AI guidance, docs

**Files:**
- Create: `packages/tools/templates/game/shots.json` — `[{ "name": "start" }]`
- Modify: `packages/tools/templates/game/CLAUDE.md` (one line: after a new place or a visible change, add or adjust a point in `shots.json`; fields = `threedog shot` options; the hub re-shoots by itself), `packages/engine/docs/AI.md` (same line where screenshots are discussed), `README.md` and `README.zh-CN.md` (a short "Project hub" section: icon, list, wall, auto re-shoot — add, do not shorten other sections), `.gitignore` of template already ignores `.threedog` — verify.
- Test: existing `npm test -- game-root how doc-rules` (template and doc guards).

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `npm test -- game-root how doc-rules cli-surface` → PASS.
- [ ] **Step 3:** Record one line in `docs/testing/runs.md`.
- [ ] **Step 4:** Commit `docs(hub): shots.json in the template, AI guidance, README`.
