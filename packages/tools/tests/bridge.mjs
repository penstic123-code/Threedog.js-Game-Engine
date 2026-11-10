// Dev bridge test: npm test -- dev bridge
// Starts a real dev server on the engine package (its index page is the world example; a free port) and hits it with the real threedog command
//   line: the headless fallback page and a real browser page, pending commands failing fast on reload, the security checks of the bridge and of the
//   error relay, and that the build output contains no bridge. Expected values are read from describe() first, never hard-coded.
// Waits poll a condition with a deadline; no fixed sleeps.
import { wrongServer } from '../lib/shot-name.mjs';
import { createServer, build } from 'vite';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TOOLS, ROOT, ENGINE, viteOptions } from '../paths.mjs';
import { waitEngine } from '../wait-engine.mjs';
import { until, securityCases } from '../lib/bridge-cases.mjs';

export const name = 'dev bridge: threedog command line drives the dev page';

const CLI = join(TOOLS, 'threedog/cli.mjs');
/** Run one command line, returning { out, code }. Must be async: the dev server lives in this process, so waiting synchronously would deadlock */
const threedog = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args, '-w', 'engine'],
  { cwd: ROOT, encoding: 'utf8' }, (err, out) => res({ out: out.trim(), code: err ? err.code : 0 })));
export async function run({ check, browser }) {
  const dir = ENGINE;
  const reportScenario = join(dir, 'tests/scenarios/report.json');
  // 1. No dev server: tell the user to start it first (skipped when someone is running dev on the engine right now)
  if (!existsSync(join(dir, '.threedog/dev.json'))) {
    const r = spawnSync(process.execPath, [CLI, 'describe', '-w', 'engine'], { cwd: ROOT, encoding: 'utf8' });
    check('without a dev server it says to run npm run dev first', r.status === 1 && r.stdout.includes('npm run dev'), r.stdout);
  }

  const server = await createServer(await viteOptions(dir, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  try {
    const dev = JSON.parse(readFileSync(join(dir, '.threedog/dev.json'), 'utf8'));
    check('after start .threedog/dev.json is written (port + token)', dev.port && dev.token?.length >= 16);
    // a fresh server on a loaded machine can sit past wrongServer's five seconds on its first request: wait for any answer, so the check reads what the server says.
    // No answer in 30 s falls through, and the check below fails on "unknown"
    for (const end = Date.now() + 30000; Date.now() < end;) { try { await fetch(`http://localhost:${dev.port}/__threedog/root`, { signal: AbortSignal.timeout(10000) }); break; } catch { /* not answering yet */ } }
    const owner = await wrongServer(`http://localhost:${dev.port}/`, dir), foreign = await wrongServer(`http://localhost:${dev.port}/`, join(dir, 'another-game'));
    check('the server names its folder: shot <url> passes its own game and refuses another', !owner.wrong && !owner.unknown && /serves/.test(foreign.wrong ?? ''), JSON.stringify({ owner, foreign }));

    // 2. Headless fallback page (no real browser connected)
    // snap first, before anything stepped: a paused page had drawn nothing yet and snap saved a black picture (r4 G11)
    const s0 = await threedog('snap', 'tick0'), lum0 = +(/Picture: luminance ([\d.]+)/.exec(s0.out)?.[1] ?? 0);
    check('snap at tick 0 draws the page before reading (not black)', s0.code === 0 && lum0 > 0.02, s0.out.slice(0, 300));
    const d = (await threedog('describe'));
    const startClock = (await threedog('describe', 'time.clock')).out.replace(/"/g, '');
    // toasts on the headless page live on the stepped time (r4 G10): shown, step past their time, then snap -> gone (after startClock: reload must find the initial clock)
    const toastCount = async () => +(await threedog('js', "document.querySelectorAll('.threedog-toast').length")).out.replace(/[^\d]/g, '');
    await threedog('js', "engine.ui.get('toast').show({ text: 'r4 toast', kind: 'info', ms: 2000 }); 1");
    const t1 = await toastCount(); await threedog('step', '3'); const snapT = await threedog('snap', 'toast-step'), t2 = await toastCount();
    check('a toast expires with threedog step (stepped time) before snap', t1 >= 1 && t2 === 0 && snapT.code === 0, JSON.stringify({ t1, t2 }));
    check('describe: compact plus the state line', d.code === 0 && d.out.includes('Player') && d.out.split('\n').length <= 4 && d.out.length < 600
      && /Headless page, tick \d+/.test(d.out), d.out);
    check('describe --full: the full text', (await threedog('describe', '--full')).out.includes('[Game state]'));
    check('describe path: one item', /^\d\d:\d\d$/.test(startClock), startClock);
    const clockOf = async () => (await threedog('js', 'engine.describe().time.real')).out.replace('✓ ', '');
    const t0 = +await clockOf(), s = (await threedog('step', '2'));
    check('step 2: advances 2 seconds', s.out.startsWith('✓ Stepped 2 s') && Math.abs(+await clockOf() - t0 - 2) < 0.1, s.out);
    await threedog('state', 'cutscene=skip');   // the game's opening camera (5 s) takes Esc as "skip" while it plays
    const p = (await threedog('press', 'cancel'));
    check('press cancel: the settings window opens (settings opens on the basic cancel key)', p.out.includes('settings') && !/Blocked/.test(p.out), p.out);
    // with the settings window open a game action is refused for a real key too: threedog press names the holder, and a scenario press step fails with it
    const blockedPress = await threedog('press', 'moveForward');
    const bsDir = join(dir, 'tests', 'scenarios'), bsFile = join(bsDir, 'tmp-blocked.json'), bsHad = existsSync(bsDir);
    let bs;
    try { mkdirSync(bsDir, { recursive: true }); writeFileSync(bsFile, JSON.stringify({ name: 'tmp', steps: [{ press: 'moveForward' }] })); bs = await threedog('scenario', 'tmp-blocked'); }
    finally { rmSync(bsHad ? bsFile : bsDir, { recursive: true, force: true }); }
    check('[guard] a blocked press says who holds input (command and scenario step), not a silent no-op',
      /Blocked: moveForward did nothing, input is held by win-settings/.test(blockedPress.out) && bs.code === 1 && /win-settings/.test(bs.out), blockedPress.out + ' | ' + bs.out);
    (await threedog('press', 'cancel'));
    check('press again: it closes', !(await threedog('describe')).out.includes('settings'));
    check('press an unknown action: lists the available actions', (await threedog('press', 'nope')).out.includes('Unknown'));
    const where = async () => JSON.parse((await threedog('describe', 'player.position')).out);
    const before = await where(), h = (await threedog('hold', 'moveForward', '1')), after = await where();
    check('hold: the player position changes', h.out.startsWith('✓ Held moveForward') && Math.hypot(after.x - before.x, after.z - before.z) > 0.3,
      `${h.out} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const tickOf = async () => +(await threedog('js', 'engine.time.tick')).out.replace(/[^\d]/g, '');
    const tick0 = await tickOf();
    check('state: change time and weather', (await threedog('state', 'time=12:00', 'weather=rain')).out.includes('12:00'));
    // [guard] state and snap only set up and look: game time moves on step, press, hold, skip (docs/COMMANDS.md), never as a side effect
    await threedog('snap', 'no-tick', '--no-picture');
    check('state and snap advance no game time', await tickOf() === tick0, String(tick0));
    // [guard] the exit code is the verdict: what did not take effect is not a success
    const noWeather = await threedog('state', 'weather=no-such-weather');
    check('state: a weather the game lacks fails with the reason', noWeather.code !== 0 && /Not applied: weather=no-such-weather/.test(noWeather.out), noWeather.out);
    const longOut = await threedog('describe', 'modules', '--max', '40');
    check('describe: cut output says it was cut and how to see it all', /cut at 40 of \d+ characters \(--max \d+/.test(longOut.out), longOut.out);
    const badBool = await threedog('op', 'thing.set', 'id=x', 'visible=yes');
    check('op: a value that does not fit the shape is refused before the op', badBool.code !== 0 && /visible=yes is not true or false/.test(badBool.out), badBool.out);
    const help = await threedog('step', '--help');
    check('--help on a bridge command answers and exits 0', help.code === 0 && help.out.includes('advance N real seconds'), help.out);
    check('eval: expression / statements / error', (await threedog('js', '1 + 1')).out === '✓ 2' && (await threedog('js',
      'const a = 3; return a * 2')).out === '✓ 6' && (await threedog('js', 'engine.nope.x')).code === 1);
    check('eval: await works (expression and multi-line statements)', (await threedog('js',
      'await Promise.resolve(7)')).out === '✓ 7' && (await threedog('js', 'const a = await Promise.resolve(4); return a + 1')).out === '✓ 5');
    const script = join(tmpdir(), 'threedog-bridge-js-test.js');
    writeFileSync(script, 'const a = 20;\nconst b = await Promise.resolve(1);\nreturn a + b;\n');
    check('js alias / --file: reads a multi-line script from a file', (await threedog('js', '1 + 2')).out === '✓ 3' && (await threedog('js',
      '--file', script)).out === '✓ 21' && (await threedog('js', '--file', 'nope.js')).out.includes('Script file not found'));
    // plain js and checks scripts get the same globals (step / log / assert / expect); a failed expect shows its message in both forms
    writeFileSync(script, 'const t = engine.time.now("real");\nstep(0.5);\nlog("stepped");\nreturn +(engine.time.now("real") - t).toFixed(1) > 0.4;\n');
    const plainJs = await threedog('js', '--file', script);
    check('js without checks: step() and log() exist, the return value is printed', plainJs.code === 0 && plainJs.out === '· stepped\n✓ true', plainJs.out);
    writeFileSync(script, 'expect(1, "on expect").toBe(2);\nexpect(1).toBe(3, "on matcher");\nassert(false, "on assert");\nexpect(1).toBe(1);\n');
    const checks = await threedog('js', '--file', script);
    check('js checks: expect(v, msg) and expect(v).toBe(x, msg) failures print the message', checks.code === 1 && checks.out.startsWith('✗ 3 of 4 checks failed')
      && checks.out.includes('#1 on expect → expected 2, got 1') && checks.out.includes('#2 on matcher') && checks.out.includes('#3 on assert'), checks.out);
    // [guard] a SyntaxError thrown BY the script (JSON.parse) read as "not an expression" and ran it again as statements: its steps happened twice
    const tickBefore = Number((await threedog('js', 'engine.time.tick')).out.replace('✓ ', ''));
    const twice = await threedog('js', "step(1), JSON.parse('{')");
    const moved = Number((await threedog('js', 'engine.time.tick')).out.replace('✓ ', '')) - tickBefore;
    check('[guard] js: an expression that throws a SyntaxError runs once', twice.code !== 0 && moved < 90, `moved ${moved} ticks: ${twice.out}`);
    const close = await threedog('js', "expect(1).toBeCloseTo(1, 'one is one'); expect(1.5).toBeCloseTo(1, 1, 'tolerance then message'); expect(2).toBeCloseTo(1, 'two is not one')");
    check('[guard] expect.toBeCloseTo: a message may stand where the tolerance goes', close.code !== 0 && /1 of 3 checks failed/.test(close.out) && /two is not one/.test(close.out) && !/one is one/.test(close.out), close.out);
    check('js: a script may declare its own log, step or engine', (await threedog('js', 'const log = 2; const step = 3; return log + step')).out === '✓ 5');
    rmSync(script, { force: true });
    const rawClock = async () => +(await threedog('js', 'engine.time.now("real")')).out.replace('✓ ', ''),
      tp0 = await rawClock(); await threedog('press', 'KeyJ', '--for', '0.02'); const tp1 = await rawClock();
    check('press --for 0.02: advances only about 0.04 s (default 0.117 s)', tp1 - tp0 > 0.03 && tp1 - tp0 < 0.06, `${tp0} ${tp1}`);
    // op / ops: run a game op from the command line; values are converted by the op's args shape
    await threedog('js', `engine.ops.define('test.take', { args: { item: 'string', n: 'int?' }, reasons: { notEnough: 'Not enough' },
      can: (e, { item, n = 1 }) => e.inventory.count(item) >= n || 'notEnough', run: (e, { item, n = 1 }) => { e.inventory.remove(item, n); return n; },
      offers: () => [{ item: 'film' }] }); engine.inventory.add('film', 3, { silent: true }); return 1`);
    const o1 = await threedog('op', 'test.take', 'item=film', 'n=2'), o2 = await threedog('op', 'test.take', 'item=film', 'n=999');
    check('op: success shows the value and the bag; n=2 becomes a number', o1.code === 0 && o1.out.startsWith('✓ test.take → 2 · Bag')
      && /film×[0-9]/.test(o1.out), o1.out);
    check('op: failure exits 1 with the reason and its note', o2.code === 1 && o2.out.startsWith('✗ test.take: notEnough (Not enough)'), o2.out);
    const ol = await threedog('ops'), typo = await threedog('op', 'test.tkae');
    check('ops: lists offers checked with can; a wrong op name suggests the right one', ol.out.includes('✓ test.take item=film') && typo.code === 1
      && /did you mean.*test\.take/.test(typo.out), ol.out + ' | ' + typo.out);
    const oh = (await threedog('js', "engine.ops.recent('test.take').map(h => h.source + '/' + h.phase).join()")).out;
    check('[guard] op runs are logged with source bridge, phase between', oh === '✓ "bridge/between,bridge/between"', oh);
    const ex = await threedog('explain', 'op', 'test.take', 'item=film', 'n=999', '--full'), ins = await threedog('inspect');
    const scDir = join(dir, 'tests', 'scenarios'), scFile = join(scDir, 'tmp-bridge.json'), hadDir = existsSync(scDir);
    let sc, vf;
    try {
      mkdirSync(scDir, { recursive: true });
      writeFileSync(scFile, JSON.stringify({ name: 'tmp',
        steps: [{ op: 'test.take', args: { item: 'film', n: 999 }, expect: 'notEnough' }, { expect: { 'ui.dialogue': null } }] }));
      sc = await threedog('scenario', 'tmp-bridge');
      vf = await threedog('verify', 'tmp-bridge');
    } finally { rmSync(hadDir ? scFile : scDir, { recursive: true, force: true }); }
    check('explain op / inspect / scenario: why not with the note, offers with reasons, a scenario file runs on the page',
      ex.code === 1 && /notEnough \(Not enough\)[\s\S]*last attempt/.test(ex.out) && ins.out.includes('test.take item=film') && sc.code === 0
        && /scenario tmp-bridge: 2 checks passed/.test(sc.out), [ex.out, ins.out, sc.out].join(' | '));
    check('verify: PASS, tested and not tested', vf.code === 0 && /verify tmp-bridge: PASS/.test(vf.out) && vf.out.includes('Tested: ops test.take') && vf.out.includes('Not tested:'), vf.out);
    check('verify: evidence report has layers, NOT proven (pointer lock / GPU / FPS) and untested coverage',
      /Evidence \(per check[\s\S]*direct: 2 checks/.test(vf.out) && /NOT proven: .*pointer lock.*real GPU.*real FPS/.test(vf.out) && /Coverage: ops [1-9]\d*\/\d+ ran \(refused: test\.take\) · modules \d+ tested, \d+ indirect, \d+ untested/.test(vf.out)
        && /scenario tmp-bridge: 2 checks passed\nCoverage[^\n]*refused: test\.take/.test(sc.out), vf.out.split('\n').filter(l => /^Coverage|untested/.test(l)).join(' | ').slice(0, 300) + ' || ' + sc.out);
    // loading: the same view as describe().loading; a degradable missing file shows as a failure with path and fallback, exit code 1
    await threedog('js', "engine.assets.manifest({ name: 'bridge-test', textures: { bridgeMissing: '/textures/bridge-missing.png' } }); await " +
      "engine.assets.texture('bridgeMissing'); return 1");
    const ld = await threedog('loading'), one = await threedog('loading', 'bridgeMissing');
    check('loading: lists the failed file with its fallback and a hint; loading name shows the source manifest',
      ld.code === 1 && /fell back texture "bridgeMissing" \/textures\/bridge-missing\.png/.test(ld.out) && ld.out.includes('Possible cause')
        && one.out.includes('"manifest": "bridge-test"'), ld.out + ' | ' + one.out.slice(0, 200));
    const bad = await threedog('state', 'pos=1', '-8'), bad2 = await threedog('state', 'pos=1');
    check('state: a PowerShell comma split into an array errors and says to quote',
      bad.code === 1 && bad.out.includes('"pos=1,-8"') && bad2.code === 1 && bad2.out.includes('x,z'), bad.out + bad2.out);
    const pp = await threedog('describe', 'player.position');
    check('describe player.position: gives numeric coordinates', (() => { try { const v = JSON.parse(pp.out); return [v.x,
      v.y, v.z].every(Number.isFinite); } catch { return false; } })(), pp.out);
    const snap = (await threedog('snap', 'bridge-test'));
    const png = join(dir, '.threedog/shots/bridge-test.png');
    check('snap: writes a PNG', snap.code === 0 && existsSync(png) && statSync(png).size > 1000 && readFileSync(png).subarray(1,
      4).toString() === 'PNG', snap.out);
    // [guard] a picture through the bridge runs the same picture check as threedog shot (the demos skipped it by screenshotting another way)
    check('snap: prints the picture check of the live page (Picture: numbers), --no-picture skips it', /\nPicture: luminance [\d.]+/.test(snap.out)
      && !/Picture: luminance/.test((await threedog('snap', 'bridge-test', '--no-picture')).out), snap.out);
    // [guard] a WebGL2 fallback picture must not pass for WebGPU, and --play is the same word as on shot
    check('snap: says which backend drew the picture', /drawn by (WebGPU|WebGL2|WebGL)/.test(snap.out), snap.out);
    const sp = await threedog('snap', 'bridge-test', '--play', '--no-picture');
    check('snap --play: takes the same word as shot, with no start-screen note', sp.code === 0 && !/start screen covers/.test(sp.out), sp.out);
    // [guard] a script waiting on game time on a page nobody steps (await walkTo) ends with the reason, not a silent command timeout
    const waits = await threedog('js', '--wait', '1', 'await new Promise(() => {})');
    check('js --wait: a script on a stopped page ends, says it may be waiting on the game clock and may still run', waits.code !== 0 && /may be waiting on the game clock/.test(waits.out) && /may still be running/.test(waits.out), waits.out);
    // [guard] a real wait that is not the clock: the old rule failed any script after 20 s with no tick, though nothing was wrong
    const longWait = await threedog('js', 'await new Promise(r => setTimeout(r, 21000)); return "waited"');
    check('js: a real 21 s wait (a timer, not the game clock) finishes by default', longWait.code === 0 && /waited/.test(longWait.out), longWait.out);
    // [guard] a running load is not a stopped page: the count starts only once it is done
    const loading = await threedog('js', '--wait', '1', 'const m = { name: "hold", isReady: () => false }; engine.modules.set("hold", m); await new Promise(r => setTimeout(r, 2500)); engine.modules.delete("hold"); return "loaded"');
    check('js --wait: a load running in the page does not count as stopped', loading.code === 0 && /loaded/.test(loading.out), loading.out);
    // [guard] statements fail the expression try first: that path once left the 500 ms timer running after every multi-statement script
    await threedog('js', 'const live = window.__live = new Set(), si = window.setInterval, ci = window.clearInterval; window.setInterval = (...a) => { const t = si(...a); live.add(t); return t; }; window.clearInterval = t => { live.delete(t); ci(t); }; return 1');
    const liveBefore = (await threedog('js', 'window.__live.size')).out;
    await threedog('js', 'const a = 1; return a');
    const liveAfter = (await threedog('js', 'window.__live.size')).out;
    check('js: a multi-statement script leaves no timer behind', liveBefore === liveAfter, liveBefore + ' / ' + liveAfter);
    const sh = await threedog('snap', '--help'), sx = await threedog('snap', '--nope');
    check('snap --help prints usage, an unknown flag lists the valid ones, neither saves a file', sh.code === 0 && sh.out.startsWith('Usage: threedog snap')
      && sx.code === 1 && sx.out.includes('--width') && !existsSync(join(dir, '.threedog/shots/--help.png')) && !existsSync(join(dir, '.threedog/shots/--nope.png')),
      sh.out + ' | ' + sx.out);
    // [guard] snap --width sends the whole PNG through the bridge to scale it, so a body past the old 4 MB limit must pass
    const bigScript = join(tmpdir(), `threedog-bridge-big-${process.pid}.js`);
    writeFileSync(bigScript, `// ${'x'.repeat(5 << 20)}\nreturn 'big'`);
    const bigBody = await threedog('js', '--file', bigScript);
    rmSync(bigScript, { force: true });
    check('[guard] a 5 MB command body reaches the page', bigBody.code === 0 && /big/.test(bigBody.out), bigBody.out.slice(0, 200));
    const absShot = join(tmpdir(), `threedog-bridge-snap-${process.pid}.png`), relShot = join(dir, '.threedog/rel-snap.png');
    const sa = await threedog('snap', absShot), sr = await threedog('snap', '.threedog/rel-snap');
    check('snap path: absolute used as given, relative gets .png only when it has no extension', sa.code === 0 && existsSync(absShot)
      && existsSync(relShot) && !existsSync(relShot + '.png') && !/undefined/.test(sa.out), sa.out + ' | ' + sr.out);
    for (const f of [absShot, relShot]) rmSync(f, { force: true });
    (await threedog('errors'));   // move the cursor to now first
    (await threedog('js', "setTimeout(() => { throw new Error('bridge test deliberate error'); }, 0)"));
    const er = await until(async () => { const r = await threedog('errors'); return r.out.includes('deliberate') && r; })
      || { out: '(no error arrived)', code: 0 };
    check('errors: reads the new error, the next read is empty',
      er.code === 1 && er.out.includes('bridge test deliberate error') && (await threedog('errors')).out.includes('No new errors'), er.out);
    // 引擎自己的错误都带 "[code]" 标签（W4 起一种失败形状），提示按标签查 ERROR_CODES，不再靠猜消息文字；这里照引擎的写法带上 [world-plain]
    (await threedog('js', "setTimeout(() => { throw new Error('world data must be plain values (number, string): x is a function [world-plain]'); }, 0)"));
    const er2 = await until(async () => { const r = await threedog('errors'); return r.out.includes('plain values') && r; }) || { out: '(no error arrived)' };
    const lt1 = await threedog('errors', 'latest'), lt2 = await threedog('errors', 'latest'), cur = /Cursor E(\d+)/.exec(lt1.out)?.[1];
    const sn0 = await threedog('errors', '--since', String(Math.max(0, +cur - 2))), sn1 = await threedog('errors', '--since', cur ?? '0');
    check('errors latest: repeatable, with id and tick; --since lists only later ones',
      lt1.code === 1 && lt1.out.includes('deliberate') && lt1.out === lt2.out && /E\d+ \d\d:\d\d:\d\d tick \d+/.test(lt1.out) && sn0.out.includes('deliberate')
        && sn1.out.includes('No errors since E' + cur), [lt1.out, sn1.out].join(' | '));
    check('errors: a known error class comes with the likely cause and the doc page',
      er2.out.includes('Possible cause:') && er2.out.includes('Read: recipes/18-world.md'), er2.out);
    const sd = join(dir, 'tests/snapshots/bridge-test.describe.json');
    try {
      const saved = await threedog('snap-describe', 'save', 'bridge-test', '--only', 'player,ui');
      check('snap-describe save: writes the baseline file', saved.code === 0 && existsSync(sd), saved.out);
      check('snap-describe diff: same state matches', (await threedog('snap-describe', 'diff', 'bridge-test', '--only', 'player,ui')).out.startsWith('✓'));
      await threedog('state', 'pos=40,-20');
      const df = await threedog('snap-describe', 'diff', 'bridge-test', '--only', 'player,ui');
      check('snap-describe diff: after the player moved it prints the changed field as text and the update command',
        df.code === 1 && /player\.x: .* -> .*changed/.test(df.out) && df.out.includes('snap-describe save bridge-test'), df.out);
      check('snap-describe: no name gives usage', (await threedog('snap-describe', 'diff')).out.includes('Usage'));
    } finally { rmSync(sd, { force: true }); }
    // [guard] a fade waits on frames and the bridge halts the page first: the command hung until the bridge gave up after two minutes
    const faded = await threedog('skip', 'seconds=60', 'fade=0.05');
    check('[guard] skip with fade= ends on a halted page', faded.code === 0 && /Skipped/.test(faded.out), faded.out);
    check('reload: after reloading the scenario is back to its initial state',
      (await threedog('reload')).code === 0 && (await threedog('describe')).out.includes(startClock), startClock);

    // report round trip: a refused op on a clean page, the file, and verify runs the scenario it derived
    await threedog('reload');
    await threedog('op', 'thing.set', 'id=no-such-thing', 'visible=true');
    const rep = await threedog('report', '--scenario', '--out', '.threedog/reports/bridge.json'), file = readFileSync(join(dir, '.threedog/reports/bridge.json'), 'utf8'), body = JSON.parse(file);
    check('[guard] report: the file has the seed, the tick, the op and the modules, and no token or user path', rep.code === 0 && Number.isInteger(body.page.seed) && body.page.tick >= 0 && body.ops.some(o => o.name === 'thing.set') && body.modules.length > 0
      && !file.includes(dev.token) && !/[A-Za-z]:[\\/]+Users/.test(file), rep.out);
    const again = await threedog('verify', 'report');
    rmSync(reportScenario, { force: true });
    check('[guard] verify runs the scenario report derived', again.code === 0 && /PASS/.test(again.out), again.out.slice(0, 400));

    // 3. A real browser page (over the HMR WebSocket)
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`http://localhost:${dev.port}/`);
    await page.waitForFunction(() => window.engine?.stateApplied, null, { timeout: 90000 });
    // commands go to the real page once its hello arrived (the headless page has ?threedog-headless in its URL)
    await until(async () => !(await threedog('js', 'location.search')).out.includes('threedog-headless'));
    const live = (await threedog('step', '1'));
    check('real page: step pauses first and says to resume', live.out.includes('threedog resume') && await page.evaluate(() => engine.halted), live.out);
    check('real page: the command takes effect on this page', (await page.evaluate(() => engine.describe().time.real)) > 0);
    const liveTick = await page.evaluate(() => engine.time.tick);
    await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 16; document.body.prepend(c); });
    check('real page: snap can capture (canvas only)', (await threedog('snap',
      'bridge-live')).code === 0 && existsSync(join(dir, '.threedog/shots/bridge-live.png')));
    const shotWidth = readFileSync(join(dir, '.threedog/shots/bridge-live.png')).readUInt32BE(16);
    check('[guard] real page: snap reads the game canvas, not the first canvas in the page', shotWidth > 16, String(shotWidth));
    check('real page: snap advances no game time', await page.evaluate(() => engine.time.tick) === liveTick, String(liveTick));
    check('real page: resume restores real time', (await threedog('resume')).code === 0 && !(await page.evaluate(() => engine.halted)));
    // [guard] the old socket closing is not the page being back: the next command landed in the gap and opened a headless page beside the real one
    const rl = await threedog('reload'), back = await fetch(`http://localhost:${dev.port}/__threedog/cmd`, { method: 'POST', headers: { 'x-threedog-token': dev.token }, body: '{"op":"ping"}' }).then(r => r.json());
    check('[guard] real page: reload answers once the page is connected again', rl.code === 0 && back.value.live && !back.value.headless, JSON.stringify(back));
    // a command still running when its page reloads fails at once, not after the 2-minute timeout
    const tr = Date.now(), hang = threedog('js', 'window.__hang = true; return new Promise(() => {})');
    await until(() => page.evaluate(() => window.__hang));
    await page.reload();
    const hung = await hang;
    check('real page: a pending command fails fast when the page reloads', hung.code === 1 && /reloaded or closed/.test(hung.out) && Date.now() - tr < 30000, `${hung.out} (${Date.now() - tr} ms)`);
    await page.close();

    await securityCases({ check, dev, dir });
  } finally {
    await server.close();
  }
  check('after the dev server closes dev.json is removed', !existsSync(join(dir, '.threedog/dev.json')));

  // The engine wait timeout must give the reason: no window.engine attached / attached but not ready
  const bare = await browser.newPage();
  await bare.setContent('<html><body></body></html>');
  const why1 = await waitEngine(bare, { grace: 300, timeout: 600, errors: ['deliberate error'] }).then(() => '', e => e.message);
  check('engine wait timeout: without window.engine it gives the reason, the fix and the latest errors',
    why1.includes('missing') && why1.includes('window.engine = engine') && why1.includes('deliberate error'), why1);
  await bare.evaluate(() => { window.engine = { ready: false }; });
  const why2 = await waitEngine(bare, { grace: 300, timeout: 600 }).then(() => '', e => e.message);
  check('engine wait timeout: attached but not ready says ready=false', why2.includes('engine.ready=false') && why2.includes('engine.start()'), why2);
  await bare.close();

  // 5. No bridge in the build output
  const out = mkdtempSync(join(tmpdir(), 'threedog-bridge-'));
  try {
    await build(await viteOptions(dir, { build: { outDir: out, emptyOutDir: true }, logLevel: 'error' }));
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter(f => f.isFile() && /\.(js|html)$/.test(f.name));
    const hit = files.filter(f => /threedog-bridge|__threedog\/cmd|threedog:hello/.test(readFileSync(join(f.parentPath, f.name), 'utf8')));
    check('the build output contains no bridge code', files.length > 0 && hit.length === 0, hit.map(f => f.name).join(', '));
  } finally { rmSync(out, { recursive: true, force: true }); }
}
