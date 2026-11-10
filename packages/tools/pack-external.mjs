// Outside-the-repo install check (release reliability). npm pack the engine and tools packages, install the tarballs into a fresh temp project
// outside this repository (so nothing resolves through workspaces or the monorepo layout), then check what a real user gets:
//   1. package contents: the tarballs carry what is needed (docs, workers, style types) and nothing internal (tests)
//   2. types: a // @ts-check file with a three.js method typo, a wrong vector argument type and an engine option typo gives exactly those
//      three tsc errors; the correct main.js gives none (skipLibCheck off, so the engine's own declarations are checked too)
//   3. what opening a game checks: page opens, engine.ready, no 4xx/5xx (Workers, wasm, decoders, assets), no console errors
//   4. the threedog CLI works in that project: map (GAMEMAP with package-relative paths), check, test (smoke), examples pull, dev + one bridge command;
//      the project is the new-game template (packages/tools/templates/game + templates/openworld), so the template installs, checks, runs and builds outside the repo
//   5. vite build + preview of that project and of every other start `threedog init` offers (blank, --pixel, each also with --webgl): a start that builds can still crash on first open
//   6. the engine alone, installed from a local folder with npm install --install-links (a plain link would skip its dependencies):
//      nothing unpublished is pulled in (no @threedog/* or file:/workspace: dependency), one copy of three, and a plain vite config builds
//   7. a game that vendors the whole engine (tests included) in vendor/threedog as a file: dependency: threedog check and types look only at the
//      game's own sources (vendor/ and local-path dependencies are skipped; package.json "threedog": { exclude } drops more)
// Shipped doc references are checked by rule R18 in the repository (no packages/ paths, every named file exists).
// Run: npm test -- pack-external   (needs network or a warm npm cache for third-party dependencies; takes a few minutes)
//      node packages/tools/pack-external.mjs [--keep]   standalone; --keep leaves the temp project for inspection
import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ENGINE, TOOLS, addonDir } from './paths.mjs';
import { waitEngine } from './wait-engine.mjs';
import { npm as npmRun } from './lib/proc.mjs';
import { parseOptions } from './lib/cli-args.mjs';
import { newGamePage } from './browser.mjs';
import { copyTemplate, usePost, engineAlone, vendored, packageContents } from './lib/pack-cases.mjs';
import { applyDeps } from './lib/scaffold.mjs';

// The engine alone (step 6): no style given, so neutral placeholders and flat ground
const SOLO_MAIN = `// @ts-check
import { createEngine, openWorld, presets, THREE } from 'threedog';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const engine = createEngine({ canvas });
engine.use(openWorld({ camera: 'follow', seed: 7 }));
engine.characters.addPlayer({ ...presets.player.thirdPerson });
const up = new THREE.Vector3(0, 1, 0).normalize();
engine.camera.lookAt(up);
/** @type {any} */ (window).engine = engine;
await engine.start();
`;
// Line numbers matter: the test expects errors on lines 5, 6 and 7
const BAD = `// @ts-check
import { createEngine, THREE } from 'threedog';
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const v = new THREE.Vector3();
v.normalise();
v.set('1', 2, 3);
createEngine({ canvas, styel: {} });
`;
const TSCONFIG = { compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler',
  allowJs: true, checkJs: true, noEmit: true, skipLibCheck: false,
  // types: [] so unrelated global @types pulled in by tool dependencies are not loaded; @types/three still arrives through 'three' imports
  types: [] }, include: ['main.js'] };

// npm and node both run without a shell (lib/proc.mjs)
// A vite build earlier in this process sets NODE_ENV=production, and npm then skips devDependencies (@threedog/tools, vite): install like a fresh shell
const cleanEnv = () => { const env = { ...process.env }; for (const k of Object.keys(env)) if (k === 'NODE_ENV'
  || /^npm_config_(omit|production|only)$/i.test(k)) delete env[k]; return env; };
const npm = (args, cwd) => npmRun(args, { cwd, timeout: 600000, env: cleanEnv() });
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 600000 });
/** The installed threedog CLI in the temp project; async, so a dev server in another process keeps running */
const cliIn = (cwd, app, ...args) => new Promise(res => execFile(process.execPath, [join(app, 'node_modules/@threedog/tools/bin/threedog.mjs'), ...args],
  { cwd, encoding: 'utf8', timeout: 900000 }, (err, out, errOut) => res({ code: err ? err.code ?? 1 : 0, out: (out + errOut).trim() })));
const cli = (app, ...args) => cliIn(app, app, ...args);
const freePort = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/** npm pack one package into dest; returns the npm pack --json entry ({ filename, files: [{ path }] }) */
function pack(dir, dest) {
  const r = npm(['pack', '--json', '--pack-destination', dest], dir);
  if (r.status !== 0) throw new Error(`npm pack failed in ${dir}: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0];
}

/** tsc errors as "file(line,col): error TSxxxx: …" lines */
function tsc(app, project) {
  const r = node([join(app, 'node_modules/typescript/bin/tsc'), '-p', project, '--pretty', 'false'], app);
  return (r.stdout + r.stderr).split(/\r?\n/).filter(l => /error TS\d+/.test(l));
}

/** Start vite preview and resolve with its base URL once it answers */
async function preview(dir, app, port) {
  const proc = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: dir });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/')).ok) return { proc, base }; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('vite preview did not answer: ' + log.slice(-300));
}

/** The starts of `threedog init` other than the open world the project above is made from */
const STARTS = [['blank', []], ['blank --webgl', ['--webgl']], ['pixel', ['--pixel']], ['pixel --webgl', ['--pixel', '--webgl']], ['open world --webgl', ['--open-world', '--webgl']]];

/**
 * Build the game in dir, preview it and open the page: it must reach engine.ready, draw a few frames and load everything without a console error.
 * Each start goes through here because only an opened page shows a crash at startup: the build and the file checks all passed on a main.js that threw on its first lines.
 * @param {string} dir @param {string} app the project holding node_modules @param {string} label @param {{ check: Function, browser?: any, look?: (page: any) => Promise<void> }} o  look: more checks on the running page
 */
async function buildAndOpen(dir, app, label, { check, browser, look }) {
  const b = node([join(app, 'node_modules/vite/bin/vite.js'), 'build'], dir);
  check(`${label}: vite build succeeds`, b.status === 0, (b.stdout + b.stderr).split('\n').filter(l => /error/i.test(l)).slice(0, 3).join(' | '));
  if (b.status !== 0 || !browser) return;
  const { proc, base } = await preview(dir, app, await freePort());
  try {
    const errors = [], badRes = [];
    const page = await newGamePage(browser, { errors });
    page.on('response', r => { if (r.status() >= 400) badRes.push(`${r.status()} ${r.url().replace(base, '')}`); });
    page.on('requestfailed', r => badRes.push(`failed ${r.url().replace(base, '')}`));
    try {
      await page.goto(base + '/');
      await waitEngine(page, { field: 'ready', errors });
      // a few more frames: Worker / physics / navmesh errors often only show up after startup
      await page.evaluate(() => new Promise(r => { let k = 0; const h = window['engine'].onFrame(() => { if (++k >= 5) { h.remove(); r(); } }); }));
      check(`${label}: page opens, engine.ready is true`, true);
      await look?.(page);
    } catch (e) { check(`${label}: page opens, engine.ready is true`, false, String(e).split('\n')[0]); }
    check(`${label}: no failed resource loads (Workers, wasm, decoders, assets)`, badRes.length === 0, badRes.slice(0, 3).join(' | '));
    check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  } finally {
    // wait for preview to exit: on Windows its open handles keep the temp folder locked (EBUSY) for a moment
    if (proc.exitCode === null) await new Promise(r => { proc.once('exit', r); proc.kill(); });
  }
}

export async function packExternal({ check, browser, keep = false }) {
  const tmp = mkdtempSync(join(tmpdir(), 'threedog-ext-'));
  const app = join(tmp, 'app');
  try {
    // 1. pack and look at the contents
    const eng = pack(ENGINE, tmp), tools = pack(TOOLS, tmp), terrainPkg = pack(addonDir('terrain-noise'), tmp), postPkg = pack(addonDir('post-effects'), tmp);
    packageContents(check, { eng, tools, terrainPkg });

    // 2. a fresh project that installs the tarballs like a user would
    mkdirSync(app);
    // The dependencies are the template's own (as new-game --open-world writes them), each threedog / @threedog/* range swapped for its tarball.
    // Why not a hand-written list: a package the template's code or docs use but its package.json forgot (post-effects once) would then
    // install here by accident and only fail for a real standalone game. The template has no post-effects dependency (optional package): the
    // style plugin bloom() below is the game choosing it, so it adds the package as a game would (npm install @threedog/post-effects).
    const tarballs = { threedog: eng, '@threedog/tools': tools, '@threedog/terrain-noise': terrainPkg, '@threedog/post-effects': postPkg };
    const tplDeps = applyDeps(JSON.parse(readFileSync(join(TOOLS, 'templates', 'game', 'package.json'), 'utf8')).dependencies, { openWorld: true });
    const deps = Object.fromEntries(Object.entries(tplDeps).map(([n, r]) => [n, tarballs[n] ? `file:../${tarballs[n].filename}` : r]));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'threedog-external-check', private: true, type: 'module',
      scripts: { test: 'threedog test', check: 'threedog check', map: 'threedog map' },
      dependencies: { ...deps, '@threedog/post-effects': `file:../${postPkg.filename}` } }, null, 2));
    copyTemplate(app);   // index.html, main.js, content/, vite.config.js and the docs of a new game
    usePost(app);   // plugins/10-bloom.js: export default bloom(), as the docs show it, so types, build and the preview page need the post-effects package added above
    // the type-error fixture lives in tests/, which every game check leaves out (template tsconfig exclude, threedog check / types since 1.1.0 read every
    // other .js of a game): at the project root it would be a game source, and check / types below would rightly fail on it
    mkdirSync(join(app, 'tests'), { recursive: true });
    writeFileSync(join(app, 'tests', 'bad.js'), BAD);
    writeFileSync(join(app, 'tsconfig.strict.json'), JSON.stringify(TSCONFIG, null, 2));
    writeFileSync(join(app, 'tsconfig.bad.json'), JSON.stringify({ extends: './tsconfig.strict.json', include: ['tests/bad.js'] }));
    const inst = npm(['install', '--no-audit', '--no-fund', '--loglevel=error'], app);
    check('npm install of the tarballs succeeds', inst.status === 0, (inst.stderr || String(inst.error)).slice(0, 300));
    if (inst.status !== 0) return;
    const deep = existsSync(join(app, 'node_modules/threedog/node_modules/three'));
    check('one copy of three (peer dependency, not nested under threedog)', !deep);

    // 3. types
    const good = tsc(app, 'tsconfig.strict.json');
    check('types: correct main.js has 0 tsc errors', good.length === 0, good.slice(0, 3).join(' | '));
    const bad = tsc(app, 'tsconfig.bad.json');
    const at = n => bad.some(l => l.startsWith(`tests/bad.js(${n},`));
    check('types: three.js method typo (v.normalise) is an error', at(5) && bad.some(l => /normalise/.test(l)), bad.join(' | '));
    check('types: wrong vector argument type (v.set(\'1\', …)) is an error', at(6), bad.join(' | '));
    check('types: engine option typo (styel) is an error', at(7) && bad.some(l => /styel/.test(l)), bad.join(' | '));
    check('types: no other errors', bad.length === 3, bad.join(' | '));

    // 4. the CLI in a game outside the monorepo (paths.mjs game mode)
    const map = await cli(app, 'map'), gm = existsSync(join(app, 'GAMEMAP.md')) ? readFileSync(join(app, 'GAMEMAP.md'), 'utf8') : '';
    check('cli: threedog map writes GAMEMAP.md with game-relative and node_modules/threedog/docs paths', map.code === 0 && gm.includes('node_modules/threedog/docs/') && !gm.includes('packages/'), map.out.slice(-300));
    const chk = await cli(app, 'check');
    check('cli: threedog check passes (game checks only)', chk.code === 0 && /GAMEMAP\.md is up to date/.test(chk.out), chk.out.split('\n').filter(l => /✗|error/i.test(l)).slice(0, 4).join(' | ') || chk.out.slice(-300));
    check('template: AGENTS.md is written beside CLAUDE.md with the same text, and threedog check still passes with it there', existsSync(join(app, 'AGENTS.md')) && readFileSync(join(app, 'AGENTS.md'), 'utf8') === readFileSync(join(app, 'CLAUDE.md'), 'utf8'));
    // hints and how reach a project with no games/ folder: the patterns come from the installed package's metadata, the words from its docs
    check('cli: the new game itself gets no bypass hint', !/bypass/.test(chk.out), chk.out.slice(-200));
    mkdirSync(join(app, 'systems'));
    writeFileSync(join(app, 'systems/handmade.js'), "import * as THREE from 'three';\nexport const mixer = new THREE.AnimationMixer(new THREE.Object3D());\nexport const bag = [];\nfunction tick() { requestAnimationFrame(tick); }\ntick();\n");
    const hints = await cli(app, 'check', '--rule', 'R40');
    check('cli: threedog check hints at hand-written code in a project outside the repo, and still passes', hints.code === 0 && ['AnimationMixer', 'requestAnimationFrame'].every(w => hints.out.includes(w)) && /handmade\.js/.test(hints.out), hints.out.slice(-400));
    const pj = join(app, 'package.json'), pkgText = readFileSync(pj, 'utf8');
    writeFileSync(pj, JSON.stringify({ ...JSON.parse(pkgText), threedog: { hints: { animation: false } } }, null, 2));
    const off = await cli(app, 'check', '--rule', 'R40');
    check('cli: the package.json switch turns a kind off there too', !off.out.includes('AnimationMixer') && off.out.includes('requestAnimationFrame'), off.out.slice(-300));
    writeFileSync(pj, pkgText); rmSync(join(app, 'systems'), { recursive: true });
    const how = await cli(app, 'how', 'carry items in a backpack');
    check('cli: threedog how answers from the installed docs', how.code === 0 && /inventory/.test(how.out) && !/packages\//.test(how.out), how.out.slice(0, 300));
    const list = await cli(app, 'how', '--browse'), inv = await cli(app, 'how', '--card', 'inventory'), miss = await cli(app, 'how', 'qqzzxx');
    check('cli: threedog how --browse and --card work from the installed package', list.code === 0 && /^items: /m.test(list.out) && inv.code === 0 && /engine\.use\(inventory\(\)\)/.test(inv.out) && /recipes\/66-common-tasks\.md/.test(inv.out), list.out.slice(0, 300) + inv.out.slice(0, 300));
    const missLine = miss.out.trim().split('\n')[0];   // the first line carries the pointers; the domains list may follow it (tests/how.mjs)
    check('cli: a miss names browse and the installed AI.md, in its first line', /how --browse/.test(missLine) && /node_modules\/threedog\/docs\/AI\.md/.test(missLine), miss.out);
    const ty = await cli(app, 'types');
    check('cli: threedog types passes with the template tsconfig.json (game sources, lib ESNext, skipLibCheck)', ty.code === 0, ty.out.split('\n').filter(l => /✗|error/i.test(l)).slice(0, 4).join(' | ') || ty.out.slice(-300));
    // examples ship in the engine tarball and pull from node_modules/threedog into the game (examples.mjs, game mode of paths.mjs)
    const shipped = ['examples/pullable.json', 'examples/techniques/contact-shadows/contactShadows.js'].every(f => eng.files.some(x => x.path === f));
    const pull = await cli(app, 'examples', 'pull', 'contact-shadows'), pulled = join(app, 'techniques/contact-shadows/contactShadows.js');
    check('cli: threedog examples pull copies a technique from the installed package into techniques/<name>/ and prints the import line',
      shipped && pull.code === 0 && existsSync(pulled) && /applyContactShadows/.test(pull.out), pull.out.slice(-300));
    if (browser) {
      // the browser build that matches the playwright version npm just installed (a no-op when it is already there), as a user's first run does
      const pw = node([join(app, 'node_modules/playwright/cli.js'), 'install', 'chromium'], app);
      const t = await cli(app, 'test');
      check('cli: threedog test runs the smoke test and passes', t.code === 0 && /Total: [1-9]\d* checks in [1-9]\d* items, .* 0 failed/.test(t.out),
        (pw.status ? `playwright install: ${(pw.stdout + pw.stderr).slice(-200)} | ` : '') + t.out.split('\n').filter(l => /✗|Error|Executable|install|Total/.test(l)).slice(0, 5).join(' | '));
      const z = await cli(app, 'test', 'zzz-no-such-test');
      check('cli: a test filter that matches nothing fails', z.code === 1 && /no test name contains/.test(z.out), z.out.slice(-200));
      // dev server + one bridge command (the bridge opens its own headless page)
      const port = await freePort();
      const dev = spawn(process.execPath, [join(app, 'node_modules/@threedog/tools/bin/threedog.mjs'), 'dev', '--port', String(port), '--strictPort'], { cwd: app });
      let devLog = ''; dev.stdout.on('data', d => devLog += d); dev.stderr.on('data', d => devLog += d);
      try {
        for (let i = 0; i < 120 && !existsSync(join(app, '.threedog/dev.json')); i++) await new Promise(r => setTimeout(r, 250));
        const d = await cli(app, 'describe');
        check('cli: threedog dev starts and threedog describe reads the page', d.code === 0 && /Player/.test(d.out), d.out.slice(-300) || devLog.slice(-300));
      } finally { if (dev.exitCode === null) await new Promise(r => { dev.once('exit', r); dev.kill(); }); }
    }

    // 6 runs before the browser part: it needs no browser
    await engineAlone(tmp, eng, check, { npm, node, MAIN: SOLO_MAIN });
    // 7. a game that vendors the engine in a subfolder
    await vendored(tmp, tools, check, { npm, cli });

    // 5. production build + preview in a browser: the open-world project, then every other start, made by the real init
    await buildAndOpen(app, app, 'preview', { check, browser, look: async page => {
      const tpl = await page.evaluate(() => { const e = window['engine']; e.ops.define('probe.ping', { desc: 'Outside check', run: () => {} }); return e.ops.run('probe.ping'); });
      check('template: an op defined in the page runs from the installed packages', tpl.ok, JSON.stringify(tpl));
      // this browser usually has no WebGPU adapter, so either backend is right; what must hold is the ask, and a reason whenever it fell back
      const drawn = await page.evaluate(() => window['engine'].describe().renderer);
      console.log(`  packaged game: asked ${drawn.requested}, drawn on ${drawn.backend}${drawn.reason ? ` (${drawn.reason})` : ''}`);
      check('template: the new game asks for WebGPU and describe() says which backend draws, with the reason on a fallback',
        drawn.requested === 'webgpu' && (drawn.backend === 'webgpu' || (drawn.backend === 'webgl2' && !!drawn.reason)), JSON.stringify(drawn));
    } });
    for (const [label, flags] of STARTS) {
      const dir = join(app, 'starts', label.replace(/\W+/g, '-'));
      const made = await cli(app, 'init', dir, ...flags);
      check(`${label}: threedog init makes the game`, made.code === 0, made.out.slice(-300));
      const chk = await cliIn(dir, app, 'check'), ty = await cliIn(dir, app, 'types');
      check(`${label}: threedog check and types pass`, chk.code === 0 && ty.code === 0, (chk.out + ty.out).split('\n').filter(l => /✗|error/i.test(l)).slice(0, 4).join(' | '));
      await buildAndOpen(dir, app, label, { check, browser });
    }
  } finally {
    if (keep) console.log('temp project kept: ' + app);
    else try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
    catch (e) { console.log(`(could not delete temp project ${tmp}: ${e.code}; the OS temp cleanup will)`); }
  }
}

// Standalone: node packages/tools/pack-external.mjs [--keep]
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { opt } = parseOptions(process.argv.slice(2), { flags: ['keep', 'gpu', 'software'] });
  const { launchBrowser } = await import('./browser.mjs');
  const browser = await launchBrowser();
  let fail = 0;
  await packExternal({ browser, keep: !!opt.keep,
    check: (label, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? '  → ' + detail : ''}`); } });
  await browser.close();
  process.exit(fail ? 1 : 0);
}
