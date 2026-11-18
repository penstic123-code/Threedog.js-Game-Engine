// One-shot test: npm test
// For each workspace (engine package + games/*; in a game's own repo, the game): build, open the pages and test pages in a headless browser, and
//   check item by item. Run it after changing code to see whether anything else broke.
//   Test items: every <workspace>/tests/specs/*.mjs (engine: packages/engine/tests/specs/), each exporting `specs`, an array of
//     { name, url, run({ page, check, ev, frames, wait }) }: open url, wait for the engine, then run() records check(label, ok, detail on failure).
//     ev(fn, arg) runs fn in the page (window.engine is there); frames(n) waits n engine frames; wait(ms) waits (software rendering is slow, game
//     time runs behind real time); page is the Playwright page (page.keyboard.press('KeyE')). Files are found by the runner: a new file needs no
//     registration anywhere. A file that exports no runnable items, an item without name / url / run, or a name used twice is an error.
//     check(label, ok) given a Promise fails ("add await"); an item whose run() records no check fails ("no checks recorded").
//   A workspace without tests/specs/: a smoke test (every page opens, the engine is ready, no console errors)
//   Tests written as data: <workspace>/tests/scenarios/*.json (scenario.mjs).
//
// Install the browser once before first use: npx playwright install chromium
//   npm test                          all workspaces; prints failures (with detail), a progress line and the summary
//   npm test -- city settings         only test items whose names contain these words, any case (searched across all workspaces); no match fails
//   npm test -- -w my-farm            one workspace only (also npm test -w games/my-farm, or run npm test inside the game directory)
//   npm test -- --verbose             also print every passing item and check
//   npm test -- --json                the run as one JSON result on stdout (lib/result.mjs: { ok, summary, items }, one item per failed check); the text goes to stderr
// Rendering: a spec that reads rendered pixels runs on software rendering (SwiftShader: same pixels on every machine), the rest on the GPU.
//   spec.software: true / false decides; unset, it is true when run() itself calls a pixel API (readPixels, getImageData, screenshot ...). A spec
//   whose pixel reading sits in a helper must set it. A spec that reads pixels on the GPU unmarked is listed at the end of the run.
// Parallel: --jobs N / -j N (default half the cores, 1-6; 1 = one after the other). spec.serial: true runs a spec alone.
//   A spec that fails beside others is retried alone at the end of its workspace, for the first 5 failures of a run only (more = a real break).
//   Every item that passes only on a retry is named in the summary as "passed on retry", also without --verbose.
// Options are checked: an unknown one fails with the list (--update-snapshots, --gpu, --software, --verbose / -v, --jobs / -j, -w / --workspace).
// A spec may set timeout (ms, default 120000); one stuck spec fails with "timed out" instead of stalling the suite.
// Page helpers every spec can use inside ev(): __t.warns(fn) → { value, warns } (console.warn lines during fn, sync or async, ops-guard
//   reminders about test setup left out), __t.frames(n), __t.until(cond, ms).
process.env.THREEDOG_TEST = '1';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { packTest } from './pack-test.mjs';
import { item, result, startJson } from './lib/result.mjs';
import { waitEngine } from './wait-engine.mjs';
import { scenarioSpecs } from './scenario.mjs';
import { expectationSpecs } from './expect/spec.mjs';
import { launchBrowser, forcedRender, newGamePage, buildAndPreview, withTimeout, collect, specContext } from './browser.mjs';
import { cpus } from 'node:os';
import { nearest } from './lib/text.mjs';
import { workspaceSpecs, toolTests as findToolTests, noDuplicateNames, needsSoftware, softwareWhy } from './lib/specs.mjs';
import { intOption } from './lib/cli-args.mjs';
import { audioEnvLine } from './lib/audio-env.mjs';
import { ENGINE, TOOLS, ROOT, MODE, rel, posix, cli, engineMismatch } from './paths.mjs';

const SPEC_TIMEOUT = 120000;
const tSuite = Date.now();
// ops guard reminders (gameplay state written outside fixed steps and ops), unique per tested game: game dir -> (first line -> test name).
// Listed in <game>/.threedog/ops-guard.log, the folder the game's author works in
const guardSeen = new Map();

/** Page-side test helpers (installed before any page script runs) */
function pageHelpers() {
  const GUARD = /outside a fixed step or an op/;
  window.__t = {
    async warns(fn) {
      const warns = [], orig = console.warn;
      console.warn = (...a) => { const m = a.map(String).join(' '); if (!GUARD.test(m)) warns.push(m); };
      try { return { value: await fn(), warns }; } finally { console.warn = orig; }
    },
    pixelReads: 0,
    frames: (n = 2) => new Promise(r => { let k = 0; const h = window.engine.onFrame(() => { if (++k >= n) { h.remove(); r(); } }); }),
    async until(cond, ms = 10000) {
      const end = performance.now() + ms;
      while (performance.now() < end) { const v = await cond(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`__t.until: condition not met within ${ms} ms: ${String(cond).slice(0, 80)}`);
    },
    /** The facts printed under a failed spec: who holds the input, the open dialogue, what the player tried and the engine refused */
    state() {
      const e = window.engine, out = [];
      if (!e?.describe) return out;
      const ui = e.describe().ui, dl = ui?.dialogue;
      if (ui?.inputLocked) out.push(`game input locked by ${e.input.holders.filter(h => !h.pass).map(h => h.context).join(', ')}`);
      if (dl) out.push(`dialogue open, ${dl.speaker}: "${dl.text.slice(0, 50)}"${dl.typing ? ' (still typing)' : ''}; it advances with ${dl.advance}`);
      const refused = e.ops.recent().filter(r => !r.ok && r.source === 'player').slice(-3);
      if (refused.length) out.push(`refused presses: ${refused.map(r => `${r.name} ${r.code}${r.args?.by ? ` by ${r.args.by}` : ''}${r.count > 1 ? ` x${r.count}` : ''}`).join(', ')}`);
      return out;
    },
  };
  // Detector for tests that read rendered pixels without a software mark (reported at the end): WebGL readPixels, and a WebGL canvas read through 2D / toDataURL
  const hit = () => { window.__t.pixelReads++; };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const o = C?.prototype.readPixels; if (o) C.prototype.readPixels = function (...a) { hit(); return o.apply(this, a); };
  }
  const gl = new WeakSet(), getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { if (/webgl/.test(type)) gl.add(this); return getContext.call(this, type, ...a); };
  for (const k of ['toDataURL', 'toBlob']) {
    const o = HTMLCanvasElement.prototype[k]; HTMLCanvasElement.prototype[k] = function (...a) { if (gl.has(this)) hit(); return o.apply(this, a); };
  }
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (src, ...a) { if (gl.has(src)) hit(); return draw.call(this, src, ...a); };
}

// Which workspaces to test: -w > the workspace of the current directory > all
// named: -w was given or the current folder chose the workspace; only a run over everything adds the tools' own tests (counting the targets
// against workspaces() could not tell `test -w engine` from a full run in a repo without games)
const { dirs: targets, named, opt, rest: only } = cli(process.argv.slice(2), { workspace: 'targets', positional: true,
  flags: ['update-snapshots', 'gpu', 'software', 'verbose', 'json'], values: ['jobs'], short: { j: 'jobs', v: 'verbose' }, conflicts: [['gpu', 'software', 'they pick opposite renderers']] });
// --json: a failed check is one item (code 'test', message "<item name>: <check> → <detail>"); the result is written at exit, so the early exits report too
const jsonItems = [];
let totals = '';
if (opt.json) startJson(code => result(jsonItems, totals || (code ? 'test run failed before any check ran' : 'no checks ran'), code === 0));
if (!targets.length) { console.error(`✗ no workspace to test under ${ROOT} (a game needs package.json and main.js)`); process.exit(1); }
// The engine the games import must be the one this checkout reads: in a worktree without its own node_modules the build would test another copy
const mismatch = engineMismatch();
if (mismatch) { console.error('✗ ' + mismatch); process.exit(1); }
// --update-snapshots: tests that use expectDescribe (describe-snapshot.mjs) write their baselines instead of comparing
if (opt['update-snapshots']) process.env.THREEDOG_UPDATE_SNAPSHOTS = '1';

// --jobs N / -j N (or THREEDOG_JOBS): test pages open at the same time. Default: half the cores, 1 to 6. 1 = one page at a time.
//   Snapshot writing is always serial (one baseline file at a time). Without --jobs, at most 2 software-rendered pages run at once:
//   SwiftShader spreads one page over every core, so more of them side by side only slow each other (and the machine) down.
let jobs = Math.max(1, Math.min(6, Math.floor(cpus().length / 2)));
const jobsGiven = opt.jobs !== undefined || !!process.env.THREEDOG_JOBS;
try { jobs = intOption({ jobs: opt.jobs ?? process.env.THREEDOG_JOBS }, 'jobs') ?? jobs; } catch (e) { console.error(`✗ ${e.message} (1 = one page at a time)`); process.exit(1); }
if (opt['update-snapshots']) jobs = 1;
const verbose = !!opt.verbose;
// Name filters ignore case: `hlod` finds "HLOD ..."
const nameHas = name => only.some(o => name.toLowerCase().includes(o.toLowerCase()));
const match = name => !only.length || nameHas(name);

/** Smoke test when a game has no specs: one item per page */
const smokeSpecs = dir => readdirSync(dir).filter(f => f.endsWith('.html')).sort().map(f => ({
  name: `smoke: ${basename(dir)} ${f === 'index.html' ? '/' : '/' + f}`,
  url: f === 'index.html' ? '/' : '/' + f,
  async run({ check, ev, frames }) {
    check('engine started, URL parameters applied, modules installed', await ev(() => !!engine.stateApplied && engine.modules.size > 0));
    await frames(2);   // the running frames, where a module's own key check fires (it then counts under "no console errors" too)
    // a console warning is not a failure here, and a page that loads proves nothing about keys: without this a game whose E does nothing passed
    const unbound = await ev(() => engine.describe().input.unbound);
    check('every action a module needs has a key', !unbound.length, `no key for ${unbound.join(', ')}. Add to createEngine({ bindings }) the matching presets.bindings.* map, or bindings: { ${unbound[0]}: ['KeyX'] }`);
  },
}));
/** A workspace's items: its tests/specs/*.mjs (lib/specs.mjs; none: the smoke test), then its scenarios (tests/scenarios/*.json, scenario.mjs) */
const loadProblems = new Set();   // spec files that could not be loaded (a Set: the engine's list is read twice); printed after the plan, they fail the round
async function specsOf(dir) {
  const found = [];
  const own = (await workspaceSpecs(dir, found)).map(x => x.spec);
  for (const p of found) loadProblems.add(p);
  const all = [...(own.length ? own : smokeSpecs(dir)), ...scenarioSpecs(dir), ...expectationSpecs(dir)];
  // A repeated name means one filter picks two items and the results cannot be told apart. Stop here, before any browser.
  noDuplicateNames(all, () => 'tests/specs or tests/scenarios', `${rel(dir) || basename(dir)}: test item`);
  return all;
}

let pass = 0, fail = 0, ran = 0;
/** Parallel failures retried alone per run, at most (see runSpecs); parallelFails counts them, retriesSkipped the ones past the limit */
const RETRY_LIMIT = 5;
let parallelFails = 0, retriesSkipped = 0;
const retried = new Map(), unmarked = [], notRun = [];   // item -> how it failed before it passed on a retry; read pixels on the GPU without a software mark
const seenNames = [];
/** Items expected this run (for the progress line); set once the plan is made */
let expected = 0;
const failedItems = [];
const tty = !!process.stdout.isTTY && !opt.json;
let progressShown = false;
/** Progress: on a terminal one line rewritten in place, otherwise a line every 50 items (logs stay short) */
function progress() {
  if (verbose || !expected) return;
  const text = `   ${ran}/${expected} items done, ${failedItems.length} failed`;
  if (tty) { process.stdout.write(`\r${text}`); progressShown = true; } else if (ran % 50 === 0 && ran < expected) console.log(text);
}
/** Before printing anything else on a terminal: end the progress line so the text does not land on it */
const endProgress = () => { if (progressShown) { process.stdout.write('\n'); progressShown = false; } };
/** Add one item's results to the totals and print them: every check with --verbose, otherwise only a failed item and its failed checks */
function report(name, results, t0, extra = '', state = []) {
  const bad = results.filter(r => !r.ok);
  // a check labelled 'skipped: why' says nothing was compared (no fast-check, no baseline for this renderer): told apart from a pass
  const skipped = results.filter(r => r.ok && /\bskipped:/i.test(r.label));
  notRun.push(...skipped.map(r => `${name}: ${r.label}`));
  pass += results.length - bad.length - skipped.length; fail += bad.length; ran++;
  if (bad.length) failedItems.push(name);
  if (bad.length && state.length) jsonItems.push(item({ level: 'warn', code: 'test-state', message: `${name}: when it ended: ${state.join('; ')}` }));
  for (const r of bad) jsonItems.push(item({ code: 'test', message: `${name}: ${r.label}${r.detail ? ' → ' + r.detail : ''}` }));
  if (verbose || bad.length) {
    endProgress();
    console.log(`\n${bad.length ? '✗' : '✓'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s${extra})`);
    for (const r of verbose ? results : bad) console.log(`   ${r.ok ? '✓' : '✗'} ${r.label}${r.detail && !r.ok ? '  → ' + r.detail : ''}`);
    if (!verbose && results.length > bad.length) console.log(`   (${results.length - bad.length} other check(s) passed)`);
    if (bad.length) for (const line of state) console.log(`   when it ended: ${line}`);
  }
  progress();
}
/** An item whose own run() recorded no check tested nothing (an early return, a loop over an empty list): one failed check says so */
const noChecks = (results, check) => { if (!results.length) check('no checks recorded', false, 'run() returned without calling check(): it tested nothing'); };

// Plan first (no browser yet), so a filter that matches nothing fails at once with the closest names
const plan = [];   // [dir, specs to run]
// The tools' own tests (need a dev server and the like, not part of any workspace): every packages/tools/tests/*.mjs, exporting { name,
//   async run({ check, browser }), optIn? }. Only in the monorepo, and not with -w or inside a game directory. optIn: slow tests that run only
//   when named. Found by the runner like the specs; a file without name / run, or a name used twice (also by an engine page spec), is an error.
const toolTests = [];
try {
  for (const dir of targets) { const all = await specsOf(dir); seenNames.push(...all.map(s => s.name)); plan.push([dir, all.filter(s => match(s.name))]); }
  if (MODE === 'monorepo' && !named) {
    const tools = await findToolTests(join(TOOLS, 'tests'));
    for (const { test: t } of tools) {
      seenNames.push(t.name);
      if (match(t.name) && (!t.optIn || nameHas(t.name))) toolTests.push(t);
    }
    // a tools test named like an engine page spec: one name, two items whose results cannot be told apart (each list was only checked on its own)
    const engineSpecs = (await specsOf(ENGINE)).map(s => ({ name: s.name, where: 'packages/engine tests' }));
    noDuplicateNames([...engineSpecs, ...tools.map(({ test, file }) => ({ name: test.name, where: `tools test ${file}` }))], s => s.where, 'engine page spec / tools test');
  }
} catch (e) { console.error(`\n✗ ${e.message}`); process.exit(1); }
// A spec file that did not load is one failed check; the other files still run (the round ends failed, never silently passing)
for (const p of loadProblems) console.log(`\n✗ ${p}`);
fail += loadProblems.size;
const packs = targets.filter(d => d !== ENGINE).map(d => [d, `pack: ${rel(d) || basename(d)}`]);
seenNames.push(...packs.map(p => p[1]));
// Every filter word must find something: a misspelled word next to a good one would otherwise just quietly run less
const unmatched = only.filter(o => !seenNames.some(n => n.toLowerCase().includes(o.toLowerCase())));
expected = plan.reduce((n, [, l]) => n + l.length, 0) + toolTests.length + packs.filter(p => match(p[1])).length;
if (only.length && (unmatched.length || !expected)) {
  const words = unmatched.length ? unmatched : only;
  console.log(`\n✗✗ NOTHING MATCHED: no test name contains ${words.map(o => `"${o}"`).join(' or ')} (case is ignored). Close: ${words.flatMap(o => nearest(o, seenNames, 3)).map(n => `"${n}"`).join(', ') || '(none)'}`);
  console.log(`\nTotal: ${expected ? `${unmatched.length} filter word(s) matched nothing` : '0 items matched'} — FAILED, nothing was tested (${((Date.now() - tSuite) / 1000).toFixed(1)} s)`);
  process.exit(1);
}

// Two browsers, started on first use. Rendering: a test that reads rendered pixels needs the same pixels on every machine, so it runs on SwiftShader
//   (software). Everything else runs on the hardware GPU, several times faster and far lighter on the CPU. A GPU launch that fails or lands on a
//   software renderer falls back to the software browser (launchBrowser prints one line why). --software / --gpu / THREEDOG_RENDER force one for all.
const forced = forcedRender();
let softP = null, gpuP = null, gpuFellBack = false;
const softBrowser = () => (softP ??= launchBrowser({ prefer: 'software' }));
const gpuBrowser = () => (gpuP ??= forced ? softBrowser() : launchBrowser({ prefer: 'gpu' }).then(async b => {
  if (b.render.kind === 'gpu') return b;
  gpuFellBack = true;
  await b.close().catch(() => {});   // fell back: use the one software browser instead of keeping two
  return softBrowser();
}));
/** The browser a spec runs in: software when it reads pixels (spec.software, else detected in its run() source), else the GPU one */
const browserFor = spec => (needsSoftware(spec) ? softBrowser() : gpuBrowser());

/** A failed item for an error that escaped a spec's own try (the browser crashed, the page could not open): the scheduler below only handles
 *  fulfilled results, so one rejection used to stop the whole run with no summary and leave the later items and workspaces untested */
const crashed = (name, e, t0 = Date.now()) => ({ name, t0, extra: '', gpuPixels: false,
  results: [{ label: 'run error (outside the test body: browser or page setup)', ok: false, detail: String(e?.message ?? e).split('\n')[0] }] });

/** Run one spec in its own page; returns what report() needs, never rejects. Output is not printed here (specs run in parallel and print in order) */
const runSpec = (spec, dir, server, opts) => { const t0 = Date.now(); return runSpecPage(spec, dir, server, opts).catch(e => crashed(spec.name, e, t0)); };
async function runSpecPage(spec, dir, server, { software = false } = {}) {
  const errors = [];
  const browser = await (software ? softBrowser() : browserFor(spec));
  // tests assert zh-CN strings; the engine default 'auto' follows this locale
  const page = await newGamePage(browser, { errors, locale: 'zh-CN' });
  await page.addInitScript(pageHelpers);
  let shots = 0;   // page.screenshot is a pixel read too (the page-side hooks only see canvas reads)
  const screenshot = page.screenshot.bind(page);
  page.screenshot = (...a) => { shots++; return screenshot(...a); };
  page.on('console', m => {
    if (m.type() !== 'warning' || !m.text().includes('outside a fixed step or an op')) return;
    const k = m.text().split('\n')[0];
    // test scripts setting up state are not game code
    if (k.includes('eval at evaluate')) return;
    const seen = guardSeen.get(dir) ?? guardSeen.set(dir, new Map()).get(dir);
    if (!seen.has(k)) seen.set(k, spec.name);
  });
  const { results, check } = collect();
  const t0 = Date.now();
  let startup = null;
  try {
    // The spec's clock starts once the engine is up: opening the page used to count against it, so a slow start (cold cache, busy machine) failed
    // a spec that was fast. The start has its own 60 s inside waitEngine.
    await page.goto(server.base + spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 });   // not Playwright's 30 s "load": a busy machine passed it before the engine was even asked
    await waitEngine(page, { timeout: 60000, errors });
    startup = await page.evaluate(() => engine.startup);
    await withTimeout(spec.run(specContext(page, check)), spec.timeout ?? SPEC_TIMEOUT, 'spec');
  } catch (e) {
    const why = /timed out/.test(String(e)) && browser.render.kind !== 'gpu' ? softwareWhy(spec) : null;
    check('run error', false, String(e).split('\n')[0] + (why ? `; ${why}` : ''));
  }
  noChecks(results, check);   // before the console check below, which every page gets
  // spec.expectErrors (regex): errors this test deliberately provokes (such as the error-level test); matches do not count
  const unexpected = spec.expectErrors ? errors.filter(m => !spec.expectErrors.test(m)) : errors;
  check('no console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  // A spec that read pixels while on the GPU and is not marked: its pixels depend on the machine. Reported at the end so the mark gets added.
  const pixelReads = shots + (await page.evaluate(() => window.__t?.pixelReads ?? 0).catch(() => 0));
  const gpuPixels = !!pixelReads && browser.render.kind === 'gpu' && !needsSoftware(spec) && spec.software !== false;
  // what a failed check cannot see: "have 0" alone sent an agent hunting through pickups while an open dialogue held the input
  const failed = results.some(r => !r.ok);
  const state = failed ? await page.evaluate(() => window.__t?.state() ?? []).catch(() => []) : [];
  const audioEnv = failed ? await page.evaluate(audioEnvLine).catch(() => null) : null;   // a headless browser without an audio device fails every sound check
  if (audioEnv) state.push(audioEnv);
  await page.close().catch(() => {});
  // Startup timing: open to playable / start() to playable, slowest modules
  const slow = startup && Object.entries(startup.modules).map(([n, t]) => [n,
    (t.init ?? 0) + (t.ready ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n, t]) => `${n} ${t}`).join(', ');
  return { name: spec.name, results, t0, gpuPixels, state, extra: startup ? `; startup ${startup.totalMs}/${startup.startMs} ms, slowest ${slow || '-'}` : '' };
}

/** How the lists at the end of the run name an item: two workspaces can hold the same test name */
const itemName = (spec, dir) => `${rel(dir) || basename(dir)} · ${spec.name}`;

/** runSpec, plus: a spec that read pixels on the GPU unmarked is listed, and when it failed it runs again on software rendering (its pixels
 *  depend on the machine, so a GPU failure says nothing); the note says so, the list at the end asks for the mark */
async function runSpecChecked(spec, dir, server) {
  const d = await runSpec(spec, dir, server);
  if (!d.gpuPixels) return d;
  unmarked.push(itemName(spec, dir));
  if (!d.results.some(r => !r.ok)) return d;
  const s = await runSpec(spec, dir, server, { software: true });
  s.note = '; failed on the GPU after reading pixels unmarked, run again on software rendering';
  if (!s.results.some(r => !r.ok)) retried.set(itemName(spec, dir), 'failed on the GPU after reading pixels unmarked, passed on software rendering');
  return s;
}

/**
 * Run a workspace's specs: up to `jobs` pages at once, results printed in test order (never interleaved).
 *   spec.serial: runs alone (waits for the running ones, nothing starts beside it): timing assertions, files written
 *   A spec that fails while others run beside it is run once more alone: heavy parallel load slows every page, and a timing or timeout failure
 *   caused by that is not a bug. It prints as passed with a note and is listed in the summary; failing again alone is a real failure.
 */
async function runSpecs(list, dir, server) {
  const done = new Array(list.length).fill(null), running = new Set(), retry = [];
  // a page renders in software when it reads pixels, or when everything does (--software, or the GPU launch fell back)
  if (!forced && list.some(s => !needsSoftware(s))) await gpuBrowser();
  const soft = s => forced === 'software' || gpuFellBack || needsSoftware(s);
  const softCap = jobsGiven ? jobs : Math.min(jobs, 2);
  let softRunning = 0;
  let next = 0;   // next index to print
  const flush = () => { while (next < list.length && done[next]) { const d = done[next++]; report(d.name, d.results, d.t0, d.extra + (d.note ?? ''), d.state); } };
  const idle = async () => { while (running.size) await Promise.race(running); };
  const alone = async i => { const d = await runSpecChecked(list[i], dir, server); done[i] = d; flush(); return d; };
  const retryAll = async () => {
    for (const r of retry.splice(0)) {
      const d = await runSpecChecked(list[r], dir, server);
      if (!d.results.some(x => !x.ok)) { d.note = '; failed beside other pages, passed on a serial retry'; retried.set(itemName(list[r], dir), 'failed beside other pages, passed alone'); }
      done[r] = d;
    }
    flush();
  };
  const start = i => {
    const s = soft(list[i]);
    if (s) softRunning++;
    const p = runSpecChecked(list[i], dir, server).then(d => {
      running.delete(p);
      if (s) softRunning--;
      // Many failures in one run mean a real break (a build or an engine bug), not load: past RETRY_LIMIT a failure is kept as it is, so a
      // broken build costs one parallel pass instead of one pass plus every failed page again one at a time
      const failed = jobs > 1 && d.results.some(r => !r.ok);
      if (failed && ++parallelFails <= RETRY_LIMIT) retry.push(i);
      else { if (failed) { d.note = `; not retried alone (more than ${RETRY_LIMIT} failures this run)`; retriesSkipped++; } done[i] = d; }
      flush();
    });
    running.add(p);
  };
  for (let i = 0; i < list.length; i++) {
    // Retries wait for a serial spec or the end of the workspace: retrying as soon as one failed drained the parallel pipeline each time
    if (list[i].serial) { await idle(); await retryAll(); await alone(i); continue; }
    while (running.size >= jobs || (soft(list[i]) && softRunning >= softCap)) await Promise.race(running);
    start(i);
  }
  await idle();
  await retryAll();
}

try {
  const total = plan.reduce((n, [, l]) => n + l.length, 0), pix = plan.reduce((n, [, l]) => n + l.filter(needsSoftware).length, 0);
  if (total) console.log(`Running ${total} test pages, ${jobs} at a time${forced ? ` (all on ${forced} rendering, forced)` : `: ${total - pix} on the GPU, ${pix} that read pixels on software rendering`}${toolTests.length ? `; then ${toolTests.length} tools tests` : ''}${verbose ? '' : ' (only failures are printed; --verbose prints every check)'}`);
  // said before anything runs: the timeout it can lead to comes minutes later (the engine's own suite marks its specs, so this reaches games)
  for (const [d, l] of plan) if (d !== ENGINE) for (const s of l) { const why = softwareWhy(s); if (why) console.log(`Note: "${s.name}": ${why}`); }
  for (const [dir, list] of plan) {
    if (!list.length) continue;
    process.env.THREEDOG_SNAP_DIR = join(dir, 'tests', 'snapshots');   // where this workspace's describe baselines live
    endProgress(); console.log(`\n━━ ${rel(dir) || basename(dir)}: building…`);
    // a workspace that does not build is one failed item; the other workspaces are still tested and the summary still prints
    const t0 = Date.now();
    let server;
    try { server = await buildAndPreview(dir); } catch (e) { const d = crashed(`build: ${rel(dir) || basename(dir)}`, e, t0); report(d.name, d.results, t0); continue; }
    try { await runSpecs(list, dir, server); } finally { await server.close(); }
  }
  for (const { name, run } of toolTests) {
    const { results, check } = collect(), t0 = Date.now();
    // the tools' own tests keep the software browser (render-paths and pixel tests assume it)
    try { await run({ check, browser: await softBrowser() }); } catch (e) { check('run error', false, String(e).split('\n')[0]); }
    noChecks(results, check);
    report(name, results, t0);
  }
  // Works after packaging: each game is built for production once and started from dist only (see pack-test.mjs); the name contains "pack"
  for (const [dir, label] of packs) {
    if (!match(label)) continue;
    endProgress(); console.log(`\n━━ ${rel(dir) || basename(dir)}: production build + serving dist…`);
    const t0 = Date.now();
    const { name, results } = await (async () => packTest(dir, await softBrowser()))().catch(e => crashed(label, e, t0));
    report(name, results, t0);
  }
} finally { await Promise.all([softP, gpuP].map(p => p?.then(b => b.close()).catch(() => {}))); }

endProgress();
// Written for every tested game on every run, empty when clean: written only on a hit, a clean run left the previous run's list behind as if it were current.
// The first place is printed here, so a single hit needs no file at all
for (const dir of targets) {
  const seen = guardSeen.get(dir) ?? new Map(), log = join(dir, '.threedog', 'ops-guard.log');
  mkdirSync(join(dir, '.threedog'), { recursive: true });
  writeFileSync(log, [...seen].map(([k, v]) => `${k}\n    in ${v}\n`).join(''));
  if (!seen.size) continue;
  const [k, v] = seen.entries().next().value, shown = posix(relative(process.cwd(), log)) || log;
  console.log(`\nops guard (${rel(dir) || basename(dir)}): ${seen.size} place(s) change gameplay state outside fixed steps and ops:\n   ${k}\n      in ${v}`
    + `\n   ${seen.size > 1 ? 'all of them' : 'listed'} in ${shown}`);
}
if (retriesSkipped) console.log(`\n${retriesSkipped} failed item(s) were not retried alone: more than ${RETRY_LIMIT} failed this run, so the cause is not load`);
// Named on every run, with or without --verbose: a pass on a retry is a first failure, and one nobody saw hid a real test defect for a long time
for (const [n, why] of retried) jsonItems.push(item({ level: 'warn', code: 'test-retried', message: `${n}: passed on retry (${why})` }));
if (retried.size) console.log(`\n${retried.size} item(s) passed on retry (each failed first: load, or a defect in the test; \`--jobs 1\` runs one at a time, spec.serial: true keeps one alone):\n${[...retried].map(([n, why]) => `   ${n}: ${why}`).join('\n')}`);
if (unmarked.length) console.log(`\n${unmarked.length} item(s) read rendered pixels on the GPU but are not marked \`software: true\` (their pixels depend on the machine; add the mark to the spec):\n${unmarked.map(n => '   ' + n).join('\n')}`);
for (const n of notRun) jsonItems.push(item({ level: 'warn', code: 'test-skipped', message: n }));
if (notRun.length) console.log(`\n${notRun.length} check(s) did not run, so they are not counted as passed:\n${notRun.map(n => '   ' + n).join('\n')}`);
const took = (Date.now() - tSuite) / 1000;
const time = took >= 90 ? `${(took / 60).toFixed(1)} min` : `${took.toFixed(1)} s`;
if (failedItems.length) console.log(`\n${failedItems.length} item(s) failed (details above):\n${failedItems.map(n => '   ✗ ' + n).join('\n')}`);
// Nothing ran at all (every workspace empty, say) is never a pass
if (!ran) { console.log(`\n✗✗ NOTHING RAN — FAILED, nothing was tested (${time})`); process.exit(1); }
totals = `${pass + fail} checks in ${ran} items, ${pass} passed, ${fail} failed${notRun.length ? `, ${notRun.length} not run` : ''} (${time})`;
console.log(`\nTotal: ${totals}`);
process.exit(fail ? 1 : 0);
