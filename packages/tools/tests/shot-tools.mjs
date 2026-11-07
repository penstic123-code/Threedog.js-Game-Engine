// Friction found by a real art test (an experimental game), one check per fix so none can come back unnoticed:
//   shot waits for loading and fails naming what is pending; a page error stops the wait at once; shot file names never start with '-';
//   picture palette --json is JSON only; picture compare never enlarges a picture before measuring detail and says regions are positional;
//   describe text is English under a zh-CN game; new-game neither builds nor rewrites the lock; R40's documented switches all work (or say why not).
import { parseResult } from '../lib/result.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, newGamePage, orphanPids } from '../browser.mjs';
import { waitEngine, waitLoaded } from '../wait-engine.mjs';
import { camPose, shotName, shotFile, viewSize, wrongServer } from '../lib/shot-name.mjs';
import { pictureArgs, paletteText } from '../picture.mjs';

import { compareImages } from '../picture/compare.mjs';
import { render, parseArgs, copyTemplates } from '../lib/scaffold.mjs';
import { scanText, hintsConfigProblems } from '../rules/R40-bypass-hints.mjs';
import { pathToFileURL } from 'node:url';
import { TOOLS, ROOT, ENGINE } from '../paths.mjs';
import { png } from './picture-tools.mjs';

// engine internals by file path (tools reach the engine as a package, R24): the loading view and the describe text are pure enough to run in node
const { Loading } = await import(pathToFileURL(join(ENGINE, 'core/engine/Loading.js')).href);
const { describeText } = await import(pathToFileURL(join(ENGINE, 'core/inspect/describeText.js')).href);

export const name = 'shot / picture / new-game / R40 friction fixes';

const CJK = /[㐀-鿿]/;
const throwsWithSync = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

export async function run({ check }) {
  // --cam: a camera pose in the form views.define takes (position, target, optional fov); anything else is refused naming the option and the form
  const pose = camPose('-30,30,-440,0,-1,-492,60'), noFov = camPose('0,5,10,0,1,0');
  check('--cam: negative numbers and a fov are read; the fov is optional', JSON.stringify(pose) === '{"position":[-30,30,-440],"target":[0,-1,-492],"fov":60}' && JSON.stringify(noFov) === '{"position":[0,5,10],"target":[0,1,0]}', JSON.stringify([pose, noFov]));
  check('--cam: wrong counts, empty parts and words are refused with the option and the form', ['1,2', '1,2,3,4,5', '1,2,3,4,5,6,7,8', '1,,3,4,5,6', 'a,b,c,d,e,f', true, undefined].every(v => throwsWithSync(() => camPose(v), /--cam .*x,y,z,targetX,targetY,targetZ\[,fov\]/)));
  // ── a dead browser's children are stopped, a live browser's are not ──
  const win = '"C:\\Program Files\\pw\\chrome-headless-shell.exe"', shells = [
    '1 9 /pw/chrome-linux/headless_shell --no-sandbox', '2 1 /pw/chrome-linux/headless_shell --type=renderer', '3 77 /pw/chrome-linux/headless_shell --type=renderer', '4 8 /pw/chrome-linux/headless_shell',
    `5 77 ${win} --type=gpu-process`, '6 7 C:\\pw\\chrome-headless-shell.exe --no-sandbox', `  8 6 ${win} --type=renderer`,
    '10 77 node watch.mjs /pw/headless_shell --type=renderer', '11 77 "C:\\Program Files\\node.exe" C:\\pw\\chrome-headless-shell.exe --type=renderer', '12 77 /pw/headless_shell_notes/grep --type=x',
  ].join('\r\n') + '\r\n';
  check('orphan sweep: only a child without its browser, by the program and not its arguments', orphanPids(shells).join() === '3,5', orphanPids(shells).join());
  // ── D3: shot file names ──
  check('[guard] two pages named in Chinese keep two shot names', shotName('/宝塔.html', {}, 1) !== shotName('/城门.html', {}, 1));
  const names = [shotName('/?grain=0&view=ref', {}, 3), shotName('/', {}, 1), shotName('/styletest.html', { time: '18:30', view: 'room' }, 1), shotName('/-x.html', {}, 1)];
  check('shot name: never starts with "-" or ".", a query-only page is main_<query>', names.every(n => /^\w/.test(n)) && names[0] === 'main_grain-0-view-ref_w3' && names[1] === 'main_w1'
    && names[2] === 'styletest_t1830_view-room_w1');
  // 为什么：--size 1280X720 / 1280 以前拆出 NaN，浏览器视口报一句看不懂的错，开着的预览服务器和浏览器也没关
  const sz = s => { try { return viewSize(s).join('x'); } catch (e) { return e.message; } };
  check('[guard] --size: WxH (x or X), default 960x540; anything else fails naming the form', sz(undefined) === '960x540' && sz('1280X720') === '1280x720'
    && ['1280', 'axb', '0x10', '10x-5'].every(s => /--size .* WxH/.test(sz(s))), ['1280', 'axb'].map(sz).join(' | '));
  // round-2 demo: the headless page was detected low tier, so ao / bloom silently dropped out of every shot. The tool pages name their tier;
  // this guards the one path (engine reads ?threedog-tier only when headless, before it builds the renderer; shot, gallery and capture pass it)
  const { forcedTier } = await import(pathToFileURL(join(ENGINE, 'core/scene/tier.js')).href);
  const src = f => readFileSync(join(TOOLS, f), 'utf8');
  check('tier: ?threedog-tier=high|low is read, anything else ignored; Engine takes it only headless; shot / gallery / capture pass it',
    forcedTier('?threedog-headless&threedog-tier=high') === 'high' && forcedTier('?threedog-tier=low') === 'low' && forcedTier('?threedog-tier=ultra') === null && forcedTier('') === null
    && /\(headless && forcedTier\(\)\) \|\| \(owned \? tierBeforeRenderer\(\) : null\);[^]*this\._deviceTier = tierFirst \|\| detectTier\(r\)/.test(readFileSync(join(ENGINE, 'core/engine/Engine.js'), 'utf8'))
    && /'threedog-tier': tier/.test(src('shot.mjs')) && /'threedog-tier': 'high'/.test(src('gallery.mjs')) && /'threedog-tier': 'high'/.test(src('capture.mjs')));
  // content check's browser stand-in answered window.__THREE__ with a truthy stand-in: "Multiple instances of Three.js" on every check
  const { withDomStub } = await import('../content-check/dom-stub.mjs');
  check('content check DOM stand-in: "__x__" probe flags read unset (no false "Multiple instances of Three.js")',
    await withDomStub(async () => globalThis.window.__THREE__ === undefined && !!globalThis.window.document));
  // round-2 demo: `shot --out day.png` wrote into the game root and nearly got committed
  const g = join(tmpdir(), 'g'), shots = join(g, '.threedog', 'shots');
  check('shot --out: a bare name goes to <game>/.threedog/shots/, a path with a directory is kept as given',
    shotFile(g, 'day.png', 'x') === join(shots, 'day.png') && shotFile(g, 'day', 'x', '_1') === join(shots, 'day_1.png')
    && shotFile(g, 'out/day.png', 'x') === join(process.cwd(), 'out', 'day.png') && shotFile(g, undefined, 'main_w1') === join(shots, 'main_w1.png'));
  const a = pictureArgs(['--n', '4', 'ref.png', '--json', '--', '-grain.png', '--odd.png']);
  check('picture args: after a bare -- every argument is a path, even one starting with -', a.pos.join() === 'ref.png,-grain.png,--odd.png' && a.val('--n') === '4' && a.flag('--json'));

  // ── D6: describe / loading text is English whatever the locale ──
  const fake = { modules: new Map([['terrain', { name: 'terrain', isReady: () => false }]]), moduleName: () => '地形', stream: { ready: true }, ready: false, t: k => k };
  const view = new Loading(fake).view();
  check('loading waiting line names the module id, not its translated label', view.waiting === 'waiting for module terrain' && !CJK.test(view.waiting));
  let txt = '';
  try {
    txt = describeText({ ready: true, time: { t: 1, halted: false, headless: true }, loading: view, player: { x: 0, y: 0, z: 0, ground: 'default', groundName: '默认', inWater: false, state: 'idle' },
      weather: { name: 'clear', label: '晴', rain: 0, snow: 0, fog: 0 }, nearby: [], nearbyRadius: 20, modules: [], perf: {}, actions: [], camera: { type: 'follow', x: 0, y: 5, z: 5, focus: { x: 0, z: 0 } }, ui: { windows: [] } });
  } catch (e) { txt = 'threw: ' + e.message; }
  check('describeText prints ground and weather ids, no translated (zh-CN) names', /ground default/.test(txt) && /Weather: clear/.test(txt) && !CJK.test(txt), txt.slice(0, 300));

  // ── P1 / P2: scaffolding ──
  const ng = readFileSync(join(TOOLS, 'new-game.mjs'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  check('new-game: no build (no smoke test step) and no lock-only rewrite', !/\['test',/.test(ng) && !/package-lock-only/.test(ng));
  const tpl = JSON.parse(readFileSync(join(TOOLS, 'templates/game/package.json'), 'utf8'));
  check('template package name is the plain game name, linked where npm links it (node_modules/<name>)',
    render(JSON.stringify(tpl), { name: 'my-farm' }).includes('"name":"my-farm"') && /join\(ROOT, 'node_modules', name\)/.test(ng));
  // every template layer starts from the same picture/ folder: a main.js still importing the removed style/ would only fail at build time, in a slower test
  const made = {};
  for (const [k, o] of Object.entries({ blank: {}, world: { openWorld: true } })) {
    const dir = mkdtempSync(join(tmpdir(), 'td-tpl-'));
    copyTemplates(dir, { name: 'g', ...o });
    made[k] = { picture: ['index', 'palette', 'lights', 'materials'].every(f => existsSync(join(dir, 'picture', f + '.js'))), noStyle: !existsSync(join(dir, 'style')), main: readFileSync(join(dir, 'main.js'), 'utf8'), lights: readFileSync(join(dir, 'picture', 'lights.js'), 'utf8') };
    rmSync(dir, { recursive: true, force: true });
  }
  check('new-game: every layer has picture/, no style/, and main.js wires createPicture with the engine lights off',
    Object.values(made).every(m => m.picture && m.noStyle && /engine\.use\(createPicture\(\)\)/.test(m.main) && /lights: false/.test(m.main) && !m.main.includes('style/index')), JSON.stringify(Object.values(made).map(m => [m.picture, m.noStyle])));
  check('new-game: picture/lights.js sizes the shadow map by engine.tier', /engine\.tier/.test(made.blank.lights));
  check('new-game: the worlds with a sky leave lights and fog to picture/', /lights: false/.test(made.world.main) && !/sky: \{/.test(made.world.main));
  check('new-game / init reject unknown flags (no --style: the art starts in the game picture/ folder)',
    !!parseArgs(['g', '--style', 'x']).error && !!parseArgs(['g', '--example']).error && parseArgs(['g', '--open-world']).openWorld === true);

  // ── F7: R40 switches ──
  const mat = "const spin = Math.random();\n";
  const off = '// hint-off-file(random) a wobble nobody replays\n' + mat;
  check('R40: hint-off-file(kind) with a reason works, also in a CRLF file', scanText(off).length === 0 && scanText(off.replaceAll('\n', '\r\n')).length === 0 && scanText(mat).length === 1);
  check('R40: a switch that cannot work says why (unknown kind, bad package.json value)',
    scanText('// hint-off(randoms)\n' + mat).some(r => r.kind === 'switch' && /no hint kind "randoms"/.test(r.msg)) && hintsConfigProblems({ randm: false }).length === 1);
  // The per-game switch needs games: two throwaway ones under games/ (the repo may have none), the same direct material in both, the switch in one;
  // the one without it must still get the hint, so the check cannot pass just because R40 skipped games/. Removed afterwards, with a games/ made for them
  const gamesDir = join(ROOT, 'games'), hadGames = existsSync(gamesDir);
  const fixture = (dir, threedog) => {
    mkdirSync(join(gamesDir, dir), { recursive: true });
    writeFileSync(join(gamesDir, dir, 'package.json'), JSON.stringify({ name: dir, private: true, type: 'module', ...(threedog && { threedog }) }) + '\n');
    writeFileSync(join(gamesDir, dir, 'main.js'), mat);
  };
  try {
    fixture('zz-hints-off', { hints: { random: false } });
    fixture('zz-hints-on');
    const r40 = (await import('../rules/R40-bypass-hints.mjs')).default.run();
    const hinted = dir => r40.some(r => r.kind === 'random' && r.file.startsWith(`games/${dir}/`));
    check('R40: a game\'s own package.json "hints": { "random": false } is honored; the same file in a game without it is still hinted',
      !hinted('zz-hints-off') && hinted('zz-hints-on'));
  } finally {
    for (const d of ['zz-hints-off', 'zz-hints-on']) rmSync(join(gamesDir, d), { recursive: true, force: true });
    if (!hadGames && existsSync(gamesDir) && !readdirSync(gamesDir).length) rmSync(gamesDir, { recursive: true });
  }

  const tmp = mkdtempSync(join(tmpdir(), 'threedog-shot-'));
  const browser = await launchBrowser();
  try {
    // ── D4: palette --json is JSON only ──
    writeFileSync(join(tmp, 'p.png'), png(20, 20, (x) => (x < 10 ? [200, 40, 40] : [40, 40, 200])));
    const js = await paletteText(join(tmp, 'p.png'), { n: 3, json: true });
    check('picture palette --json: the output parses as JSON (nothing after it)', (() => { try { return !!JSON.parse(js).summary; } catch { return false; } })());
    // [guard] a leftover dev server on the port was another game: the shot and its picture check passed on the wrong picture
    const answer = root => async () => ({ ok: true, json: async () => ({ root }) });
    check('shot <url>: a server of another folder is refused, naming both', /serves .*old-game, not .*new-game/.test((await wrongServer('http://localhost:5173/', '/x/new-game', answer('/x/old-game'))).wrong ?? ''));
    check('shot <url>: the game own server passes (slashes and case do not matter)', !Object.keys(await wrongServer('http://localhost:5173/', 'C:\\Games\\Mine', answer('c:/games/mine/'))).length);
    const silent = await wrongServer('http://localhost:5173/', '/x', async () => ({ ok: false }));
    check('shot <url>: a server that cannot say is reported, never passed quietly', /does not say which game/.test(silent.unknown ?? ''), JSON.stringify(silent));
    check('shot <url>: another host is not asked', !Object.keys(await wrongServer('https://example.com/', '/x', () => { throw new Error('asked'); })).length);
    // ── D5: detail at the smaller picture's scale ──
    writeFileSync(join(tmp, 'ref.png'), png(200, 200, (x, y) => (((x >> 1) + (y >> 1)) % 2 ? [220, 220, 220] : [30, 30, 30])));
    writeFileSync(join(tmp, 'shot.png'), png(100, 100, (x, y) => ((x + y) % 2 ? [220, 220, 220] : [30, 30, 30])));
    const c = await compareImages(join(tmp, 'ref.png'), join(tmp, 'shot.png'));
    check('picture compare: the same texture at half resolution has a detail ratio near 1 (not enlarged first), and notes say so',
      c.diff.detail.ratio > 0.5 && c.diff.detail.ratio < 2 && c.notes.some(n => /smaller picture's scale/.test(n)), `ratio ${c.diff.detail.ratio}`);
    check('picture compare: notes say regions are positional and point at --ref-region / --shot-region', c.notes.some(n => /by position/.test(n) && /--ref-region/.test(n)));

    // ── D2: a page error before window.engine stops the wait at once ──
    const page = await browser.newPage();
    await page.setContent('<script>setTimeout(() => { throw new Error("main.js exploded") }, 50)</script>');
    const t0 = Date.now();
    const fast = await throwsWith(() => waitEngine(page, { grace: 20000, timeout: 30000 }), /threw before window\.engine[\s\S]*main\.js exploded/);
    check('waitEngine: a page error before window.engine fails within seconds, quoting it', fast && Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
    // the round-2 demo: main.js threw [module-needs] on its first lines, i.e. during goto, before the wait listened. It must still fail at once,
    // with the engine's own fix for that code, and must not blame window.engine (the page has none only because it died)
    const early = await newGamePage(browser);
    await early.setContent('<script>throw new Error("content pickups lie on the ground as pickups: add pickups() to engine.use(...) [module-needs]")</script>');
    const t1 = Date.now();
    let msg = '';
    try { await waitEngine(early, { grace: 20000, timeout: 30000 }); } catch (e) { msg = e.message; }
    check('waitEngine: an error thrown during goto (before the wait) fails at once with its [code] fix, no window.engine hint',
      Date.now() - t1 < 5000 && /Fix \[module-needs\]: A call needs a module/.test(msg) && !/window\.engine = engine/.test(msg), `${Date.now() - t1} ms: ${msg.slice(0, 300)}`);
    // a page that threw nothing and has no engine: that is when the window.engine hint is right
    const quiet = await newGamePage(browser);
    await quiet.setContent('<p>no game</p>');
    msg = '';
    try { await waitEngine(quiet, { grace: 300, timeout: 300 }); } catch (e) { msg = e.message; }
    check('waitEngine: no error and no engine → the window.engine hint', /threw no error/.test(msg) && /window\.engine = engine/.test(msg), msg.slice(0, 200));
    await early.close(); await quiet.close();
    // ── D1: waitLoaded steps until loading is done, and names what is pending when it never is ──
    const scene = 'scene: { kids: [], traverse(f) { this.kids.forEach(f) } }';
    await page.setContent(`<script>let n = 0; window.engine = { ${scene}, step() { n++ }, describe: () => ({ perf: { chunks: { queued: 89 } } }),
      loading: { view: () => ({ done: n >= 12, waiting: 'waiting for module terrain', counts: { pending: 1 }, pending: [{ kind: 'module', name: 'terrain' }] }) } };</script>`);
    await waitLoaded(page, { timeout: 5000 });
    check('waitLoaded: steps the headless engine until loading is done', await page.evaluate(() => window.engine.loading.view().done));
    // [guard] the game's code after await engine.start() (a lamp added after a later await) is in the shot: waitLoaded waits until the page is quiet
    // the lamp's file takes 0.6 s (longer than the quiet window): the open request is what keeps the wait going
    const lamp = await newGamePage(browser);
    await lamp.route('http://threedog.test/lamp.json', r => setTimeout(() => r.fulfill({ body: '{}', headers: { 'access-control-allow-origin': '*' } }), 600));
    await lamp.setContent(`<script>window.engine = { ${scene}, step() {}, loading: { view: () => ({ done: true }) } };
      fetch('http://threedog.test/lamp.json').then(() => engine.scene.kids.push({ isLight: true }));</script>`);
    const { tail } = await waitLoaded(lamp, { timeout: 5000 });
    check('waitLoaded: waits for a light added after a file the page still loads, and reports it', tail.quiet && tail.lights === 1 && tail.ms >= 400
      && await lamp.evaluate(() => engine.scene.kids.length === 1), JSON.stringify(tail));
    await lamp.close();
    await page.setContent(`<script>window.engine = { ${scene}, step() {}, describe: () => ({ perf: { chunks: { queued: 89 } } }),
      loading: { view: () => ({ done: false, waiting: 'waiting for module terrain', counts: { pending: 1 }, pending: [{ kind: 'module', name: 'terrain' }] }) } };</script>`);
    check('waitLoaded: never done → fails naming what is pending ("waiting for module terrain: 89 chunks queued")',
      await throwsWith(() => waitLoaded(page, { timeout: 300 }), /no screenshot taken: waiting for module terrain: 89 chunks queued/));
  } finally { await browser.close(); rmSync(tmp, { recursive: true, force: true }); }

  // ── shot / doctor / stress --json: stdout is one JSON object ──
  // 为什么：GPU 起不来退回软件渲染时，launchBrowser 的那行 "Note: ..." 以前写在 stdout，排在 --json 的对象前面，MCP / 开发桥解析整段输出就失败了。
  // 子进程里用一个不存在的浏览器路径逼出这条退路（GPU 和软件两次启动都失败），只看提示落在哪条流上
  const { spawnSync } = await import('node:child_process');
  const probe = `import(${JSON.stringify(pathToFileURL(join(TOOLS, 'browser.mjs')).href)}).then(m => m.launchBrowser({ prefer: 'gpu', executablePath: 'no-such-browser.exe' })).catch(() => {})`;
  const env = { ...process.env }; delete env.THREEDOG_RENDER;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env, timeout: 60000 });
  check('[guard] the GPU fallback note goes to stderr, so a --json command\'s stdout stays one JSON object', !p.stdout.includes('Note:') && /Note: the GPU launch failed/.test(p.stderr), JSON.stringify({ out: p.stdout, err: p.stderr.slice(0, 300) }));

  // 为什么：doctor --json 以前是自己的形状，读工具结果的代码要认两种；bare `assets` 以前直接写文件
  const dr = spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'doctor', '--json', '--ci'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const verdict = parseResult(dr.stdout);
  check('[guard] doctor --json is the one result shape { ok, summary, items }', !!verdict && typeof verdict.summary === 'string' && !('healthy' in verdict), dr.stdout.slice(0, 200));
  const bare = spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'assets', '-w', 'engine'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  check('[guard] `threedog assets` with no verb refuses instead of writing files', bare.status === 1 && /assets optimize/.test(bare.stderr), bare.stderr.slice(0, 200));

  // round-4 demo: every shot printed "Picture: skipped (no pixels read)": Playwright evaluates a string as an expression, so the probe's
  // function source came back uncalled. Source checks passed; only a real shot shows it, so this runs one end to end
  const outFile = join(mkdtempSync(join(tmpdir(), 'threedog-shot-')), 'picture.png');
  const sh = spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'shot', '-w', 'engine', '--out', outFile], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  check('[guard] a real threedog shot prints the picture numbers (the page probe ran), not "skipped"', /\nPicture: luminance [\d.]+/.test(sh.stdout) && !/Picture: skipped/.test(sh.stdout),
    (sh.stdout + sh.stderr).split('\n').filter(l => /Look|Error|error/.test(l)).slice(0, 4).join(' | '));
}
