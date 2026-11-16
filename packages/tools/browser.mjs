// The one headless-browser harness for the test runner, screenshots, perf, stress, bake, doctor, pack tests and the dev bridge: launch arguments,
// a game page that collects errors, and build + preview on a free port.
//   CHROMIUM_ARGS.software  WebGL through ANGLE's SwiftShader (--use-gl=swiftshader fails on some Windows setups): same pixels on every machine, so tests use it
//   CHROMIUM_ARGS.gpu       WebGL through ANGLE on the real GPU (backend per platform): shot / gallery / perf / stress prefer it, it is several times faster
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { trackPageErrors, trackRequests } from './wait-engine.mjs';
import { TOOLS, viteOptions } from './paths.mjs';
import { parseOptions } from './lib/cli-args.mjs';

const COMMON = ['--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
/** ANGLE backend that reaches the hardware GPU headless on this platform */
const GPU_ANGLE = { win32: 'd3d11', darwin: 'metal' }[process.platform] ?? 'vulkan';
export const CHROMIUM_ARGS = {
  software: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...COMMON],
  // --force_high_performance_gpu: on a laptop with two GPUs the discrete one (what a game asking powerPreference 'high-performance' gets);
  // without it headless Chromium took the integrated one. --enable-unsafe-webgpu: WebGPU on adapters Chromium has not allow-listed yet;
  // --disable-dawn-features=use_dxc: Playwright's Chromium ships without dxil.dll, so D3D12 WebGPU requestDevice() failed ("dxil.dll Windows Error 87")
  // and every WebGPU page silently ran on the WebGL2 backend; FXC (built into Windows) compiles the shaders instead
  gpu: [`--use-angle=${GPU_ANGLE}`, '--force_high_performance_gpu', '--enable-unsafe-webgpu', '--disable-dawn-features=use_dxc', ...COMMON],
};
/** Renderer strings of software rasterizers (SwiftShader, Mesa llvmpipe, the Windows basic adapter): not a hardware GPU */
export const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i;
/** Console noise from software WebGL that is not a page error */
export const IGNORED_CONSOLE = /GL Driver|GPU stall due to ReadPixels|Automatic fallback to software WebGL/;

/** What the user forced: --gpu / --software on the command line, else THREEDOG_RENDER=gpu|software, else null */
export function forcedRender() {
  // both given: an error, not a silent pick (gpu used to win)
  const { opt } = parseOptions(process.argv.slice(2), { positional: true, passthrough: true, flags: ['gpu', 'software'] });
  if (opt.gpu && opt.software) throw new Error('--gpu and --software pick opposite renderers: give one of them');
  if (opt.gpu) return 'gpu';
  if (opt.software) return 'software';
  const e = process.env.THREEDOG_RENDER;
  if (e && e !== 'gpu' && e !== 'software') throw new Error(`THREEDOG_RENDER="${e}": use gpu or software`);
  return e || null;
}

/** WebGL2 renderer string and timer-query support of a fresh page in this browser (null when WebGL2 cannot be created) */
export async function probeRenderer(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      if (!g) return null;
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return { renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', timer: !!g.getExtension('EXT_disjoint_timer_query_webgl2') };
    });
  } finally { await page.close(); }
}

const HEADLESS_SHELL = /(?:^|[\\/])(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i;
const LIST_PROCESSES = process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name like '%headless%'" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }`]]
  : ['ps', ['-eo', 'pid=,ppid=,args=']];
/** The program a command line runs: its first word, or the first quoted part (Chromium quotes its own path on Windows, for its children, and that path can hold spaces) */
const programOf = cmd => { const m = cmd.match(/^"([^"]*)"|^\S*/); return m[1] ?? m[0]; };
/** Child processes whose browser is gone, from the process listing (one "pid ppid command" per line). A headless shell by its program alone: an argument can name anything */
export function orphanPids(listing) {
  const list = listing.split(/\r?\n/).map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(m => m && HEADLESS_SHELL.test(programOf(m[3])))
    .map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const shells = new Set(list.map(p => p.pid));
  return list.filter(p => /--type=/.test(p.cmd) && !shells.has(p.ppid)).map(p => p.pid);
}
/**
 * Stops what a dead browser left behind. A page stuck in a loop does not notice its browser die when the tool that opened it is killed, and then spins a
 * core until someone stops it, unreachable by any close: six of them once ran 18 hours. Only headless shells are touched, and a live browser's children have their parent.
 */
export function reapOrphanBrowsers() {
  // timeout: the sweep is not awaited, so a hung WMI would hold the tool open after its work is done
  return new Promise(done => execFile(LIST_PROCESSES[0], LIST_PROCESSES[1], { windowsHide: true, maxBuffer: 1 << 24, timeout: 10000 }, (err, out) => {
    const pids = err ? [] : orphanPids(out);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    done(pids);
  }));
}

/** The fixes for a browser that cannot run, in the words threedog doctor reports them (doctor imports these, so a command and doctor never disagree) */
export const BROWSER_FIX = {
  install: 'run npx playwright install chromium (once per machine), then try again',
  reinstall: 'reinstall the browser: npx playwright install chromium --force',
  get repair() { return 'update the graphics driver; if that fails, ' + this.reinstall; },
};
/** Codes a launch failure carries: withBrowser turns these into one line, anything else is a bug and keeps its stack */
const BROWSER_FAILURE = new Set(['no-browser', 'browser-failed']);
/**
 * Launch Playwright's Chromium with one CHROMIUM_ARGS entry, no fallback (doctor tests each path this way). A failure comes back as one coded line with its fix:
 * code 'no-browser' (not installed) or 'browser-failed' (anything else), `why` the raw first line. Why coded here: each command used to word it its own way.
 */
export function launchKind(kind, opts = {}) {
  return chromium.launch({ ...opts, args: [...CHROMIUM_ARGS[kind], ...(opts.args || [])] }).catch(e => {
    const why = String(e?.message ?? e).split('\n')[0];
    // case-sensitive, and not for a browser the caller pointed at itself (executablePath): Playwright's 'executable doesn't exist' there is a wrong path, not a missing install
    if (!opts.executablePath && /Executable doesn't exist|npx playwright install/.test(String(e?.message ?? e))) throw Object.assign(new Error(`the Playwright browser is not installed: ${BROWSER_FIX.install}`), { code: 'no-browser', why });
    throw Object.assign(new Error(`the headless browser did not start (${why}): ${BROWSER_FIX.repair}. threedog doctor shows the details`), { code: 'browser-failed', why });
  });
}

let reaped = false, gpuFailed = null;   // why the GPU launch fell back, remembered so perf (a fresh browser per page) notes it once and does not retry each time
/**
 * Launch headless Chromium. `prefer`: 'software' (default: tests need the same pixels everywhere) or 'gpu' (shot, gallery, perf, stress);
 * --gpu / --software / THREEDOG_RENDER override it. A GPU launch is verified (renderer string): no hardware GPU or a failed launch falls back to
 * SwiftShader with a one-line note. The browser gets `render`: { kind: 'gpu' | 'software', renderer?, timer?, fallback? }.
 * A command opens it through withBrowser, which closes it; launching it directly is for callers that keep it open (run.mjs, the dev bridge).
 */
export async function launchBrowser({ prefer = 'software', ...opts } = {}) {
  if (!reaped) { reaped = true; reapOrphanBrowsers(); }   // once per process, not awaited: the launch does not wait for the sweep
  const want = forcedRender() ?? prefer;
  if (want === 'gpu' && !gpuFailed) {
    let b;
    try {
      b = await launchKind('gpu', opts);
      const r = await probeRenderer(b);
      if (r && !SOFTWARE_RENDERER.test(r.renderer)) { b.render = { kind: 'gpu', ...r }; return b; }
      gpuFailed = r ? `the GPU launch got a software renderer (${r.renderer})` : 'the GPU launch has no WebGL2';
    } catch (e) { if (e?.code === 'no-browser') throw e; gpuFailed = `the GPU launch failed (${e?.why ?? String(e?.message ?? e).split('\n')[0]})`; }
    await b?.close().catch(() => {});
    // stderr: a diagnostic, not output. shot / doctor / stress --json print one JSON object on stdout, and this line in front of it broke the parse
    console.error(`Note: ${gpuFailed}; using software rendering (SwiftShader). threedog doctor shows the details.`);
  }
  const b = await launchKind('software', opts);
  b.render = { kind: 'software', ...(want === 'gpu' && { fallback: gpuFailed }) };
  return b;
}

/**
 * System Chrome on the real GPU, for what needs true WebGPU (`threedog bake light`, stress on a game). Playwright's Chromium compiles WebGPU shaders through FXC and some of
 * three's fail there; Chrome ships dxil.dll and uses DXC. Fails coded like launchKind, with what to do when Chrome is not installed.
 */
export async function launchRealGPU({ headless = true } = {}) {
  try {
    return await chromium.launch({ channel: 'chrome', headless, args: ['--enable-unsafe-webgpu', '--force_high_performance_gpu', '--ignore-gpu-blocklist'] });
  } catch (e) {
    const why = String(e?.message ?? e).split('\n')[0];
    throw Object.assign(new Error(`system Chrome could not start (${why}): install Google Chrome, this step needs real WebGPU`), { code: 'browser-failed', why });
  }
}

/**
 * The one lifecycle of a command's headless run: start the server (when given), hand fn a launcher, and in finally close every browser it launched,
 * then the server, whatever fn did. Before it each command had its own try/finally, and a launch failure left the preview server open and printed a stack.
 * A browser that could not start is handed back (coded no-browser / browser-failed), so a long-lived process (hub, MCP, a library call) never ends by it.
 * A command's entry passes exitOnFail: true to end with one line on stderr (stdout stays clean for --json) and exit 1 instead of a stack.
 * Long-lived owners that keep a browser open (run.mjs's shared browsers, the dev bridge's page, picture/pixels.mjs openImage) call launchBrowser and close it themselves.
 * @template T
 * @param {(ctx: { server: { base: string, close(): Promise<void> } | null, base: string, launch: () => Promise<import('playwright').Browser & { render?: object }> }) => Promise<T>} fn
 *   launch() may be called more than once (perf takes a fresh browser per page); closing one early is fine
 * @param {{ prefer?: 'software' | 'gpu', launch?: () => Promise<import('playwright').Browser>, server?: () => Promise<{ base: string, close(): Promise<void> }>, exitOnFail?: boolean }} [o]
 *   launch: another launcher (launchRealGPU); server: started first, e.g. () => buildAndPreview(dir)
 * @returns {Promise<T>}
 */
export async function withBrowser(fn, { prefer = 'software', launch = () => launchBrowser({ prefer }), server: start, exitOnFail = false } = {}) {
  const open = new Set();
  let server = null, failure = null;
  try {
    server = start ? await start() : null;
    return await fn({ server, base: server?.base ?? '', launch: async () => { const b = await launch(); open.add(b); return b; } });
  } catch (e) {
    if (!exitOnFail || !BROWSER_FAILURE.has(e?.code)) throw e;
    failure = e;
  } finally {
    await Promise.all([...open].map(b => b.close().catch(() => {})));
    await server?.close().catch(() => {});
    if (failure) { console.error('✗ ' + failure.message); process.exit(1); }
  }
}

/**
 * A new page whose page errors and console errors go into `errors` (array). Options are passed to browser.newPage
 * (default viewport 1280×720). Returns the page.
 */
export async function newGamePage(browser, { errors = [], ...opts } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ...opts });
  trackPageErrors(page);   // from creation, so waitEngine sees an error main.js threw during page.goto (before any wait started)
  trackRequests(page);     // from creation too: the shot's quiet check waits for files the game's code after start() still loads
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) errors.push(m.text()); });
  return page;
}

/** Where a tool's build goes and what buildAndPreview serves. Into .threedog/, not dist/: this is a test build (test pages, the real panel) and a deploy of dist/ must never ship it */
export const TOOL_BUILD = { outDir: '.threedog/tool-build' };
/** Build a workspace (unless build: false) and serve TOOL_BUILD (or `outDir`) with vite preview on a free 127.0.0.1 port: { base, close() } */
export async function buildAndPreview(dir, { build: doBuild = true, outDir = TOOL_BUILD.outDir } = {}) {
  const { build, preview } = await import('vite');
  const out = { outDir };   // outDir: a caller that runs beside shot/test (the hub) builds into its own folder instead of fighting them over this one
  if (doBuild) await build(await viteOptions(dir, { logLevel: 'error', build: out }));
  // Serve without compression. vite preview gzips every response on the fly, and the physics library is one 4 MB script (its wasm inlined as
  //   base64): that was ~250 ms of CPU on the machine for every test page that loads it, and compressing over 127.0.0.1 saves nothing. The hook
  //   runs before the compression middleware, so dropping Accept-Encoding here switches it off.
  const noGzip = { name: 'threedog-preview-no-gzip', configurePreviewServer(s) { s.middlewares.use((req, _res, next) => { delete req.headers['accept-encoding']; next(); }); } };
  const server = await preview(await viteOptions(dir, { plugins: [noGzip], build: out, preview: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' }));
  const base = (server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.httpServer.address().port}/`).replace(/\/$/, '');
  return { base, close: () => new Promise(r => server.httpServer.close(() => r())) };
}

/**
 * A workspace on a vite dev server (a tool page is injected into the game, or the game is watched): { base, close() }. cacheDir (relative to dir) gives it its own
 * dependency cache, so it does not fight a running `npm run dev` over node_modules/.vite. The rest is vite's `server` options; the default is a free port.
 */
export async function devServer(dir, { cacheDir, ...server } = {}) {
  const { createServer } = await import('vite');
  const s = await createServer(await viteOptions(dir, { logLevel: 'error', ...cacheDir && { cacheDir: resolve(dir, cacheDir) }, server: { port: 0, strictPort: false, ...server } }));
  await s.listen();
  const base = (s.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${s.httpServer.address().port}/`).replace(/\/$/, '');
  return { base, close: () => s.close() };
}

/** The promise's result, or a rejection `<label> timed out after N s` when it takes longer than ms */
export function withTimeout(promise, ms, label) {
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}

// A Promise (or any thenable) as ok is always truthy: check('door opens', ev(...)) without await would pass whatever the page says, so it fails instead
// Reversed, check(condition, 'name') has the always-truthy name as ok: it could never fail, so a label that is not a string fails instead
export const collect = () => { const results = []; return { results, check: (label, ok, detail = '') => results.push(typeof label !== 'string'
  ? { label: String(ok), ok: false, detail: 'check(name, condition, detail): the first argument must be the name' }
  : typeof ok?.then === 'function' ? { label, ok: false, detail: 'check got a Promise: add await' } : { label, ok: !!ok, detail }) }; };

/**
 * What a spec's run() receives: { page, check, frames, ev, wait }. frames(n): wait for the engine's loop to run n more frames (a key press is read on the next frame;
 * software rendering is slow, so waiting by frames is more reliable than by milliseconds). ev takes one argument, like page.evaluate: a second one used to vanish
 * without a word and the function ran with undefined; a caller with its own ev (retrying) passes it in.
 */
export function specContext(page, check, ev = (fn, arg, ...extra) => {
  if (extra.length) throw new Error(`ev(fn, arg) takes one argument, got ${extra.length + 1}: pass them together, ev(({ a, b }) => ..., { a, b })`);
  return page.evaluate(fn, arg);
}) {
  return { page, check, frames: (n = 2) => page.evaluate(n => window.__t.frames(n), n), ev, wait: ms => page.waitForTimeout(ms) };
}

/**
 * Open a page on a dev server and put a tool's own script into it. The first time vite meets a module it re-optimizes and reloads the page, which throws away the injected
 * script, so the whole opening is tried again.
 * @param {import('playwright').Page} page @param {string} base  the dev server's address
 * @param {string} file  a file of the tools package @param {() => Promise<any>} open  go to the page and wait for the game
 * @param {() => any} ready  runs in the page: true once the script is up
 */
export async function injectTool(page, base, file, open, ready) {
  for (let i = 0; ; i++) {
    try {
      await open();
      await page.addScriptTag({ type: 'module', url: `${base}/@fs${TOOLS.replace(/\\/g, '/').replace(/^(?!\/)/, '/')}/${file}` });
      await page.waitForFunction(ready, null, { timeout: 60000 });
      return;
    } catch (e) { if (i === 2) throw e; }
  }
}
