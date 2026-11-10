// The CLI surface an AI meets first: page arguments, options, which workspace a bridge command talks to, the art-code scope of R1, and COMMANDS.md.
// Why a unit test: each of these failed silently in a real session (Git Bash turned "/" into "C:/Git/", `shot --out` was ignored, `threedog catalog`
// at the repo root said "no dev server" while a game's ran, a 21 KB art generator was "too big", `threedog hold` was missing from COMMANDS.md).
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ROOT, ENGINE, TOOLS, workspaceFor, workspaces, isArtFile } from '../paths.mjs';
import { devServerInfo } from '../devinfo.mjs';
import { pagePath, parseOptions } from '../lib/cli-args.mjs';
import { SCRIPTS, BRIDGE, VITE, main, helpText } from '../bin/threedog.mjs';
import { BRIEF, atPath } from '../threedog/pageFns.mjs';
import { errorsCommand, errorMark, errorsSince, markReload, currentErrors } from '../threedog/errorlog.mjs';
import { oneLine, ONE_LINE_MAX } from '../lib/oneline.mjs';
import { cutLog } from '../vite/vite-error-relay.js';
import { NODE_RANGE, nodeSupported } from '../lib/node-version.mjs';

export const name = 'cli surface: MSYS page paths, unknown options, live dev server pick, R1 art files, every command in COMMANDS.md, Node version preflight';

const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

export async function run({ check }) {
  // ── page paths rewritten by Git Bash ──
  const git = p => p === 'C:/Git/usr/bin/msys-2.0.dll' || p === 'C:/Program Files/Git/usr/bin/msys-2.0.dll';
  check('"C:/Git/" (Git Bash\'s "/") becomes "/"', pagePath('C:/Git/', { exists: git, env: {} }) === '/');
  check('a page and its query survive', pagePath('C:/Program Files/Git/styletest.html?view=room', { exists: git, env: {} }) === '/styletest.html?view=room');
  check('a normal page path is left alone', pagePath('/tests/city/index.html') === '/tests/city/index.html' && pagePath('styletest') === 'styletest');
  check('no Git root found: the error names the three ways out', /without the slash.*MSYS_NO_PATHCONV=1.*PowerShell/.test(throws(() => pagePath('D:/x/y.html', { exists: () => false, env: {} }))));
  // npm run hands its children Git Bash's environment: EXEPATH names the root even where no msys dll is found under it
  const bash = { MSYSTEM: 'MINGW64', EXEPATH: 'D:\\Tools\\Git\\bin' }, none = () => false;
  check('EXEPATH root undone without the dll lookup ("/", a page with a query, any case)', pagePath('D:/Tools/Git/', { exists: none, env: bash }) === '/'
    && pagePath('d:/tools/git/index.html?play', { exists: none, env: bash }) === '/index.html?play');
  check('EXEPATH only counts under Git Bash (MSYSTEM set) and only as a whole folder', /Windows path/.test(throws(() => pagePath('D:/Tools/Git/x', { exists: none, env: { EXEPATH: bash.EXEPATH } })))
    && /Windows path/.test(throws(() => pagePath('D:/Tools/Github/x', { exists: none, env: bash }))));
  const po = parseOptions(['styletest', '--play'], { page: '/', flags: ['play'] }), pd = parseOptions([], { page: '/' });
  check('parseOptions keeps the argument as typed next to the page (shot names an undone rewrite), null when none was given', po.pageArg === 'styletest' && po.opt.play === true && pd.pageArg === null, JSON.stringify([po, pd]));

  // the WebGPU fallback is one line in errors.log whatever its words; a real error keeps its own line
  const { mergeKey } = await import('../vite/vite-error-relay.js');
  const warn = msg => ({ type: 'warn', msg }), k1 = mergeKey(warn('[threedog] WebGPU unavailable (no adapter), running webgl2'), 'a.js:1'), k2 = mergeKey(warn('THREE.WebGPURenderer: WebGPU is not available, running under WebGL2 backend.'), 'b.js:9');
  check('errors.log: every wording of the WebGPU fallback warning merges into one line', k1 === k2);
  check('[guard] describe path: a null value is that value, a missing field is undefined, position still reads off x, y, z',
    atPath({ ui: { dialogue: null } }, 'ui.dialogue') === null && atPath({ ui: {} }, 'ui.dialogue') === undefined && atPath({ p: { x: 1, y: 2, z: 3 } }, 'p.position').y === 2);
  // [guard] the log and the three positions in it: a repeat raises a count, and a size cut must not renumber
  {
  const elog = mkdtempSync(join(tmpdir(), 'td-errlog-')), blk = (t, msg) => `[browser error] ${t}\npage| /index.html\npage| ${msg}\npage| at f (main.js:3:4)\n\n`;
  const rep = (n, msg) => `[browser error ×${n}, ${n + 1} total] 12:00:09 same as above: ${msg}\n`;
  mkdirSync(join(elog, '.threedog'));
  const wlog = t => writeFileSync(join(elog, '.threedog/errors.log'), t), head = '# Browser error log\n', two = head + blk('12:00:01', 'old one') + blk('12:00:02', 'old two');
  wlog(two);
  errorsCommand(elog, [], {});
  const mark = errorMark(elog);
  markReload(elog);
  wlog(two + rep(3, 'old one'));
  const again = errorsCommand(elog, [], {});
  check('[guard] errors: a repeat of an error already read is news, not "No new errors"', /old one/.test(again.text) && !again.ok, again.text);
  check('[guard] errors: read once, the same repeat is not news again', /No new errors/.test(errorsCommand(elog, [], {}).text));
  check('[guard] status after a reload: the page that repeats an old error has that error', currentErrors(elog).map(r => r.id).join() === '1');
  check('[guard] verify: a repeat since the mark counts', errorsSince(elog, mark).map(r => r.id).join() === '1');
  const pad = Array.from({ length: 20 }, (_, i) => blk('12:01:00', 'filler ' + i)).join(''), big = two + pad + blk('12:02:00', 'last');
  wlog(big);
  const before = errorMark(elog), cut = cutLog(big, 300);
  wlog(cut);
  const kept = errorsCommand(elog, ['latest', '1'], {});
  check('[guard] errors.log cut: ids stay what they were', /^E23 .*last/m.test(kept.text) && kept.data.cursor === 23, kept.text);
  check('[guard] errors.log cut: the first line, which names the dev run, stays', cut.startsWith(head));
  check('[guard] errors.log cut: nothing old reads as new to verify', errorsSince(elog, before).length === 0);
  wlog(cut + blk('12:03:00', 'after the cut'));
  check('[guard] errors.log cut: a new error after it is seen by verify', errorsSince(elog, before).map(r => r.id).join() === '24');
  rmSync(elog, { recursive: true, force: true });
  }
  check('errors.log: an error about WebGPU and any other warning stay apart', mergeKey({ type: 'error', msg: 'WebGPU unavailable' }, '') !== k1 && mergeKey(warn('other'), '') !== k1);

  // the bridge commands read their options through the one parser: a typo fails before anything reaches the page
  const { run: bridgeRun } = await import('../threedog/commands.mjs'), typo = (cmd, ...a) => bridgeRun({ evaluate: () => { throw new Error('reached the page'); } }, cmd, a).then(() => '', e => e.message);
  check('[guard] a mistyped bridge option fails naming the closest one', /did you mean --full/.test(await typo('describe', '--fulll')) && /unknown option --foo/.test(await typo('ops', '--foo')) && /unknown option --fast/.test(await typo('step', '2', '--fast')));

  const pageSays = text => ({ evaluate: async () => text });
  check('[guard] inspect: an op that cannot run now is the answer, not a failure of the command', (await bridgeRun(pageSays('hero at (0, 0)\n✗ shop.buy (closed)'), 'inspect', [])).ok);
  check('[guard] inspect materials: its ✗ lines are problems found', !(await bridgeRun(pageSays('3 materials\n✗ map not sRGB'), 'inspect', ['materials'])).ok);

  // a snap that times out says what the page was doing; here the page answers nothing, so it says the main thread is busy
  let calls = 0; const alive = setInterval(() => {}, 500);   // readRuntime's timer is unref'd: a real bridge call keeps the process up, this fake does not
  const stuck = { evaluate: () => ++calls === 1 ? Promise.resolve(true) : new Promise(() => {}), screenshot: () => Promise.reject(new Error('page.screenshot: Timeout 30000ms exceeded.\nCall log:')) };
  const snapMsg = await bridgeRun(stuck, 'snap', ['x'], { dir: '.' }).then(() => '', e => e.message); clearInterval(alive);
  check('snap timeout: keeps the browser line and says the page main thread is busy', /Timeout 30000ms/.test(snapMsg) && /main thread is busy/.test(snapMsg) && !/Call log/.test(snapMsg), snapMsg);

  // ── the one-line brief of a bridge command: engine.error is an object (printed "engine error [object Object]" once) ──
  const brief = BRIEF({ describe: () => ({ error: { where: 'onFixed', message: 'x is not iterable', code: 'some-code', at: 'at tick (main.js:91:12)' } }) }).join(' ');
  check('brief: an engine error shows code, where, message and the line that threw', brief.includes('engine error [some-code] onFixed: x is not iterable (at tick (main.js:91:12))') && !brief.includes('[object Object]'), brief);

  // ── one-line error summaries keep the end of the message (the requirement and the [code]); 为什么：重复行截到 120 字，"ending at 1" 被截掉 ──
  const sky = 'Error: style.sky.keyframes must be [time, zenith, horizon, lightColor, lightIntensity, ambientIntensity] rows sorted by time, starting at 0 and ending at 1, with no time repeated; got times [0, 0.25, 0.5, 0.75, 0.88] [sky-option]';
  check('oneLine: an engine validation message stays whole', oneLine(sky + '\n    at x (a.js:1:1)') === sky);
  const long = oneLine('x'.repeat(900) + ' ending at 1 [some-code]');
  check('oneLine: a longer one keeps its start and its end', long.length === ONE_LINE_MAX && long.endsWith('ending at 1 [some-code]') && long.includes(' … '), long.slice(-40));
  const cutters = ['threedog', 'vite'].flatMap(d => readdirSync(join(TOOLS, d)).filter(f => /\.m?js$/.test(f)).map(f => join(d, f))).concat('wait-engine.mjs')
    .filter(f => /(message|msg|String\(s\))\.split\([^)]*\)\[0\]\.slice\(0,/.test(readFileSync(join(TOOLS, f), 'utf8')));
  check('no error summary cuts the message tail itself (use lib/oneline.mjs oneLine)', !cutters.length, cutters.join(', '));

  // ── options: unknown ones fail instead of being ignored ──
  const spec = { flags: ['keep', 'picture'], values: ['out', 'time'] };
  const ok = parseOptions(['/x.html', '--out', 'day.png', '--picture', '--time=18:30'], { ...spec, page: '/' });
  check('values (both spellings), switches and the page are read', ok.opt.out === 'day.png' && ok.opt.picture === true && ok.opt.time === '18:30' && ok.page === '/x.html');
  check('an unknown option fails with did-you-mean', /unknown option --ot; did you mean --out\?/.test(throws(() => parseOptions(['--ot', 'x.png'], spec))));
  check('a value option without its value fails', /--out needs a value/.test(throws(() => parseOptions(['--out', '--picture'], spec))));
  check('a command without pages refuses a stray argument', /takes only options/.test(throws(() => parseOptions(['x'], { ...spec, page: null }))));
  const many = parseOptions(['a', '-j4', 'b', '-w', 'g', '--', '--c'], { positional: true, values: ['jobs'], short: { j: 'jobs' }, workspace: true });
  check('short spellings, -w, plain arguments and everything after -- are read', many.opt.jobs === '4' && many.workspace === 'g' && many.rest.join() === 'a,b,--c', JSON.stringify(many));
  check('-w is refused by a command that takes no workspace', /unknown option -w/.test(throws(() => parseOptions(['-w', 'g'], spec))));
  // 为什么：第二个页面参数以前悄悄顶掉第一个（shot a b 拍的是 b），被另一个选项架空的选项（shot --ref x --no-picture）什么也不做也不说
  check('[guard] a second page argument fails instead of replacing the first', /one page argument.*"\/a\.html".*"b"/.test(throws(() => parseOptions(['/a.html', 'b'], { ...spec, page: '/' }))));
  // why: a repeated value option used to keep only the last one (check --rule R10 --rule R2 ran R2 alone and said 0 errors)
  check('[guard] a value option given twice fails naming both values', /--out given twice \("a\.png" and "b\.png"\)/.test(throws(() => parseOptions(['--out', 'a.png', '--out=b.png'], spec))));
  check('a list option given twice keeps both, comma-joined', parseOptions(['--rule', 'R10', '--rule=R2'], { values: ['rule'], lists: ['rule'] }).opt.rule === 'R10,R2');
  const off = { ...spec, flags: [...spec.flags, 'no-picture'], values: [...spec.values, 'ref'], conflicts: [['ref', 'no-picture', 'the reference is compared in the picture check']] };
  check('[guard] an option another one switches off fails naming why', /--ref does nothing with --no-picture: the reference is compared in the picture check/.test(throws(() => parseOptions(['--ref', 'r.png', '--no-picture'], off)))
    && parseOptions(['--ref', 'r.png'], off).opt.ref === 'r.png');
  const shot = readFileSync(join(ROOT, 'packages/tools/shot.mjs'), 'utf8');
  check('shot reads --out and parses through the shared parser', /\bcli\(process\.argv/.test(shot) && /shotFile\(dir, opt\.out/.test(shot));
  // [guard] one reading of options and -w: a tool that looks up its own switches in argv (argv.includes('--x')) or its own -w
  // (=== '-w') silently ignores a typo again. The allowed few read a switch that crosses process boundaries, each with its reason
  const HAND_OK = {
    'lib/scope.mjs': '--tally-json is passed by check to types, which declares it',
    'rules/R10-duplicates.mjs': '--r10-anon is passed through check, which declares it',
    'rules/R18-doc-refs.mjs': 'reads -w inside command lines quoted in docs, not its own arguments',
  };
  const toolFiles = dir => readdirSync(join(TOOLS, dir), { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? (['tests', 'templates', 'node_modules'].includes(e.name) ? [] : toolFiles(join(dir, e.name))) : /\.m?js$/.test(e.name) ? [join(dir, e.name).split('\\').join('/')] : []);
  const byHand = toolFiles('.').map(f => f.replace(/^\.\//, '')).filter(f => f !== 'lib/cli-args.mjs' && !HAND_OK[f])
    .filter(f => /argv\.(includes|indexOf|find(Index)?)\(|===? '-w'|=== '--workspace'/.test(readFileSync(join(TOOLS, f), 'utf8')));
  check('[guard] no tool parses its own options or -w (paths.mjs cli() / command(), lib/cli-args.mjs parseOptions)', !byHand.length, byHand.join(', '));

  // ── bridge commands at the repo root: the running dev server, not the engine fallback ──
  const before = workspaces().filter(w => devServerInfo(w).state === 'live');
  if (before.length) check('live pick (skipped: a real dev server runs here)', true);
  else {
    const gamesDir = join(ROOT, 'games'), hadGames = existsSync(gamesDir), made = ['zz-live-a', 'zz-live-b'];
    const fake = g => { const d = join(gamesDir, g); mkdirSync(join(d, '.threedog'), { recursive: true }); writeFileSync(join(d, 'package.json'), `{"name":"${g}","private":true}\n`); return d; };
    try {
      const a = fake('zz-live-a');
      writeFileSync(join(a, '.threedog/dev.json'), JSON.stringify({ port: 5999, pid: process.pid }));
      fake('zz-live-b');
      check('one live dev server: the bridge talks to it from the repo root', workspaceFor(undefined, { cwd: ROOT, live: true }) === a);
      check('without live (shot, build tools) the fallback stays', workspaceFor(undefined, { cwd: ROOT }) === ENGINE);
      writeFileSync(join(gamesDir, 'zz-live-b/.threedog/dev.json'), JSON.stringify({ port: 5998, pid: process.pid }));
      check('two live dev servers: the error lists both and says -w', /2 dev servers are running \(games\/zz-live-a, games\/zz-live-b\): pick one with -w/.test(throws(() => workspaceFor(undefined, { cwd: ROOT, live: true }))));
    } finally {
      for (const g of made) rmSync(join(gamesDir, g), { recursive: true, force: true });
      if (!hadGames && existsSync(gamesDir) && !readdirSync(gamesDir).length) rmSync(gamesDir, { recursive: true });
    }
  }

  // ── R1: art code has the error limit only ──
  check('art files: picture/, style/, art/, assets.js, art.js; gameplay files are not', ['games/g/picture/lights.js', 'games/g/style/index.js', 'games/g/art/tree.js', 'games/g/assets.js', 'games/g/art.js', 'style/index.js'].every(isArtFile)
    && !['games/g/main.js', 'games/g/content/items.js', 'games/g/party.js'].some(isArtFile));
  {
    const gamesDir = join(ROOT, 'games'), hadGames = existsSync(gamesDir), d = join(gamesDir, 'zz-size');
    const body = n => '// filler\n' + 'export const v = [' + '0.123, '.repeat(n) + '];\n';
    try {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'package.json'), '{"name":"zz-size","private":true}\n');
      writeFileSync(join(d, 'art.js'), body(3000));    // ~21 KB: under the 48 KB error limit
      writeFileSync(join(d, 'logic.js'), body(3000));
      writeFileSync(join(d, 'assets.js'), body(8000));  // ~56 KB: over it
      const R1 = (await import('../rules/R01-file-size.mjs')).default.run().filter(r => r.file.startsWith('games/zz-size/'));
      const at = f => R1.find(r => r.file === `games/zz-size/${f}`);
      check('a 21 KB art.js gets no size warning; the same size in a gameplay file still does', !at('art.js') && at('logic.js')?.level === 'warn', JSON.stringify(R1));
      check('[guard] game code over 48 KB is a warning, never an error', at('assets.js')?.level === 'warn' && !R1.some(r => r.level === 'error'), JSON.stringify(R1));
    } finally {
      rmSync(d, { recursive: true, force: true });
      if (!hadGames && existsSync(gamesDir) && !readdirSync(gamesDir).length) rmSync(gamesDir, { recursive: true });
    }
  }

  // ── COMMANDS.md lists every CLI command (generated tables in bin/threedog.mjs are the source) ──
  const doc = readFileSync(join(ENGINE, 'docs/COMMANDS.md'), 'utf8');
  const esc = s => s.replace(/[-.]/g, '\\$&');
  const missing = [...Object.keys(SCRIPTS), ...BRIDGE, ...VITE, 'map'].filter(c => !new RegExp(`(threedog(\\.mjs)?|npm run|npm) ${esc(c)}(?![\\w-])`).test(doc));
  check('every threedog command appears in COMMANDS.md as `threedog <cmd>` or `npm run <cmd>`', !missing.length, 'missing: ' + missing.join(', '));
  // options too, for the tools that declare them through cli() (the declaration is the source): an option nobody can find is not there.
  // Found where: the command's --help (its header comment; the docs trim moved option details there), or COMMANDS.md for the options all
  // tools share (--gpu / --software are described once there)
  const flagGaps = [];
  for (const tool of ['shot', 'capture', 'gallery']) {
    const src = readFileSync(join(ROOT, `packages/tools/${tool}.mjs`), 'utf8'), decl = src.match(/\bcli\(process\.argv\.slice\(2\), \{([\s\S]*?)\}\s*\)/)?.[1] ?? '';
    const opts = [...new Set([...decl.matchAll(/'([\w-]+)'/g)].map(m => m[1]))], helpDoc = helpText([SCRIPTS[tool]]);
    if (!opts.length) flagGaps.push(`${tool}: cli() declaration not found`);
    for (const o of opts) if (!new RegExp(`--${esc(o)}(?![\\w-])`).test(helpDoc + doc)) flagGaps.push(`${tool} --${o}`);
  }
  check('every option shot / capture / gallery declare appears in its --help (or COMMANDS.md, shared options) as --<option>', !flagGaps.length, 'missing: ' + flagGaps.join(', '));

  // ── .gitignore: tool output (.threedog/) stays out, a game's own shots/ folder can be committed (0.5 acceptance: a bare `shots` ignored it) ──
  if (existsSync(join(ROOT, '.git'))) {
    const ignored = p => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
    check('.gitignore: .threedog/shots ignored, games/<game>/shots not', ignored('packages/engine/.threedog/shots/a.png') && ignored('games/g/.threedog/shots/a.png') && !ignored('games/g/shots/a.png'));
  }

  // ── --help prints the script's header and runs nothing (threedog test --help used to start the whole suite) ──
  const log = console.log, said = [];
  console.log = (...a) => said.push(a.join(' '));
  let codes;
  try { codes = ['test', 'shot', 'map'].map(c => main([c, '--help'])); } finally { console.log = log; }
  check('--help: test / shot / map print their header and exit 0 without running', codes.every(c => c === 0) && /One-shot test/.test(said[0] ?? '') && /screenshot/.test(said[1] ?? '') && said.length === 3, said.map(t => t.split('\n')[0]).join(' | '));

  // ── Node version: one range everywhere, and the vite commands stop on an old Node with the version, the range and the fix ──
  const pkgFiles = ['package.json', 'packages/engine/package.json', 'packages/tools/package.json', 'packages/post-effects/package.json', 'packages/terrain-noise/package.json', 'packages/tools/templates/game/package.json'];
  const ranges = pkgFiles.map(f => `${f}: ${JSON.parse(readFileSync(join(ROOT, f), 'utf8')).engines?.node}`);
  check('engines.node is NODE_RANGE in every package.json and the template', ranges.every(r => r.endsWith(`: ${NODE_RANGE}`)), ranges.join(' | '));
  const viteEngines = JSON.parse(readFileSync(join(dirname(createRequire(join(TOOLS, 'package.json')).resolve('vite/package.json')), 'package.json'), 'utf8')).engines?.node;
  check('NODE_RANGE is the installed vite\'s engines.node', viteEngines === NODE_RANGE, `vite: ${viteEngines}`);
  check('nodeSupported: 20.19 / 22.12 / 24 yes, 20.11 / 21.7 / 22.11 / 18 no',
    ['20.19.0', 'v22.12.0', '24.1.0'].every(nodeSupported) && !['20.11.1', '21.7.0', '22.11.0', 'v18.20.0'].some(nodeSupported));
  const realNode = process.versions.node, err = console.error, errs = [];
  Object.defineProperty(process.versions, 'node', { value: '20.11.0', configurable: true });
  console.error = (...a) => errs.push(a.join(' '));
  let oldCodes;
  try { oldCodes = ['dev', 'build', 'test', 'shot', 'perf'].map(c => main([c])); } finally { console.error = err; Object.defineProperty(process.versions, 'node', { value: realNode, configurable: true }); }
  check('faked Node 20.11: dev / build / test / shot / perf exit 1 before starting anything, naming the version, the range and the fix',
    oldCodes.every(c => c === 1) && errs.length === 5 && errs.every(e => e.includes('Node 20.11.0') && e.includes(NODE_RANGE) && e.includes('nodejs.org')), errs[0]);
  // the usage line promises -w on these; perf once answered "unknown option -w" and a game went without a frame time
  for (const c of ['shot', 'perf', 'bake', 'assets']) {
    const r = spawnSync(process.execPath, [join(TOOLS, 'bin/threedog.mjs'), c, ...(c === 'assets' ? ['report'] : []), '-w', 'no-such-game'], { encoding: 'utf8', cwd: ROOT });
    check(`[guard] ${c} takes the -w its usage line lists: an unknown game is named, the option is not refused`, /no-such-game/.test(r.stdout + r.stderr) && !/unknown option/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 200));
  }
  // perf --size takes the same WxH as shot / capture and refuses a bad one before it builds anything
  const ps = spawnSync(process.execPath, [join(TOOLS, 'bin/threedog.mjs'), 'perf', '--size', '1280'], { encoding: 'utf8', cwd: ROOT });
  check('perf --size: a bad value fails at once with the WxH form', ps.status === 1 && /--size 1280: give WxH/.test(ps.stdout + ps.stderr), (ps.stdout + ps.stderr).slice(0, 200));
  check('doctor reports the Node version through the same check', /nodeProblem\(\)/.test(readFileSync(join(TOOLS, 'doctor.mjs'), 'utf8')));
  // [guard] real-webgpu built into dist/ while buildAndPreview served .threedog/tool-build: the pages it opened never had its rewrites
  check('[guard] real-webgpu builds into the folder buildAndPreview serves', /build: TOOL_BUILD/.test(readFileSync(join(TOOLS, 'real-webgpu.mjs'), 'utf8')));
  // [guard] a mistyped option on a bridge command used to run it the default way (`play --stopp` started a server, `verify --freeze-relod x` ran without the freeze)
  const { execute } = await import('../threedog/dispatch.mjs'), { options } = await import('../threedog/commands.mjs');
  const sdir = mkdtempSync(join(tmpdir(), 'td-strict-'));
  try {
    for (const [cmd, args] of [['play', ['--stopp']], ['status', ['--verbose']], ['verify', ['--freeze-relod', 'x']], ['scenario', ['--nope', 'x']]]) {
      const r = await execute(sdir, cmd, args);
      check(`${cmd} ${args.join(' ')}: an unknown option fails with the parser's list`, !r.ok && /unknown option --/.test(r.text) && /options: /.test(r.text), r.text.slice(0, 160));
    }
    check('verify takes one scenario name', /one scenario name/.test((await execute(sdir, 'verify', ['a', 'b'])).text));
    for (const [cmd, args] of [['play', ['--stop']], ['verify', ['--freeze-reload', 'x']], ['scenario', ['x', '--freeze-reload']]]) {
      const r = await execute(sdir, cmd, args);
      check(`${cmd} ${args.join(' ')}: the real options pass the parser`, !/unknown option|one scenario name/.test(r.text), r.text.slice(0, 160));
    }
    // commands.mjs run() parses the rest through its OPTIONS table: one unknown flag per group, then the real flags and positionals
    const bad = (cmd, args) => { try { options(cmd, args); return false; } catch (e) { return /unknown option/.test(e.message); } };
    for (const [cmd, flag] of [['describe', '--ful'], ['press', '--fro'], ['snap-describe', '--onlyy'], ['catalog', '--fnd'], ['scene', '--hiden'], ['state', '--x']]) check(`${cmd} ${flag}: unknown option fails`, bad(cmd, [flag]));
    const o = options('describe', ['player.x', '--full', '--max', '99']);
    check('describe keeps its positional path and real options', o.rest[0] === 'player.x' && o.opt.full === true && o.opt.max === 99);
    check('press / pick / explain op keep their positionals and options', options('press', ['interact', '--for', '2']).opt.for === '2'
      && options('pick', ['480,270']).rest[0] === '480,270' && options('explain', ['op', 'shop.buy', 'shop=bakery']).rest.length === 3);
    check('js passes a dash expression through', options('js', ['-x', '--verbose']).opt.verbose === true);
  } finally { rmSync(sdir, { recursive: true, force: true }); }
}
