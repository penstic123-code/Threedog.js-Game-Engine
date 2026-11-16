// Frame capture for development: threedog capture [page] [options]
// Opens the page headless (like `threedog shot`, on the hardware GPU when it can reach it), renders one frame and prints the renderer it measured and a short summary
// of the frame: draw calls, shadow draws, render passes (post effects), and the largest draws with their ThreeDog names (world record id, budget tag, material
// purpose). A frame with no draws fails: there is nothing to report. Two sources, joined in the summary:
//   - a hook on the game's own renderer, WebGL or WebGPU (lib/capture-lib.mjs): one entry per draw call with the three.js object and material behind it;
//   - Spector.js (https://spector.babylonjs.com), WebGL only, when it can run: records the raw WebGL command stream of the same frame to a file you can open
//     in the Spector UI (or read as JSON). On real WebGPU there is no WebGL stream, so it is skipped and the output says so. Spector is NOT a dependency of the
//     engine or of any game: it is fetched on first use from the npm CDN into <workspace>/.threedog/cache/ and injected by this tool only. --no-spector skips
//     it, --spector-url overrides the source.
//
//   threedog capture                                 the open-world example, default state
//   threedog capture /tests/city/index.html --top 12
//   threedog capture / --time 18:30 --pos 40,-20 --out .threedog/captures
//
// Options: page (default /) · -w name · --top N (largest draws listed, default 8) · --out dir · --time HH:MM · --weather name · --pos x,z ·
//   --no-spector · --spector-url url · --full (keep Spector's per-draw state and stack traces: loads in the Spector UI, 10+ MB) · --no-build · --size WxH
// The capture file lists every WebGL command of the frame; the printed summary is what to read first. On a software browser the GPU work is slow but the draw list is the same.
process.env.THREEDOG_TEST = '1';
import { withBrowser, newGamePage, buildAndPreview } from './browser.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cli, rel } from './paths.mjs';
import { viewSize } from './lib/shot-name.mjs';
import { waitEngine, waitLoaded, refuseState } from './wait-engine.mjs';
import { summarize, hookScript, fetchSpector, spectorDraws } from './lib/capture-lib.mjs';
import { rendererLine, headlessUrl } from './lib/page-url.mjs';

// Per-draw state snapshots and stack traces make a frame 10+ MB; the default file keeps the command list (names, arguments, text) only
const slim = cap => ({ ...cap, commands: cap.commands.map(({ id, name, commandArguments, status, text }) => ({ id, name, commandArguments, status, text })) });

const { dir, page: url, opt } = cli(process.argv.slice(2), { page: '/', flags: ['no-spector', 'full', 'no-build', 'gpu', 'software'], values: ['top', 'out', 'time', 'weather', 'pos', 'size', 'spector-url'] });
let W, H; try { [W, H] = viewSize(opt.size); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
const TOP = +(opt.top || 8);
// resolve, not join: join(cwd, 'D:/caps') glued an absolute --out under the current folder ("<cwd>/D:/caps")
const outDir = opt.out ? resolve(String(opt.out)) : join(dir, '.threedog', 'captures');

if (!opt['no-build']) console.log(`Building… (${rel(dir)})`);
const errors = [];
let spectorNote = '', file = null, failed = null;
// gpu: the game's own renderer where the machine has it, a software browser puts a WebGPU game on its WebGL2 fallback
await withBrowser(async ({ base, launch }) => {
const browser = await launch();
const page = await newGamePage(browser, { errors, viewport: { width: W, height: H } });
try {
  // desktop tier like shot (core/scene/tier.js): the captured frame is the one the game's picture is made of, costly post included
  const q = new URLSearchParams({ 'threedog-tier': 'high', wait: '1', cutscene: 'skip' });
  for (const k of ['time', 'weather', 'pos']) if (opt[k]) q.set(k, opt[k]);
  await page.goto(base + headlessUrl(url, q));
  await waitEngine(page, { timeout: 60000, errors });
  await refuseState(page, ['time', 'weather', 'pos']);
  await waitLoaded(page);   // the same wait as shot: loading done, and the game's code after start() has run
  await page.evaluate(() => engine.ui.settled());
  // halted first: a page with a live loop would render between our calls and mix several frames into the capture. The warm-up step compiles
  // the shaders and does the first uploads, so the captured frame is a steady one
  await page.evaluate(() => { engine.haltLoop(); engine.step(1 / 30); });

  const backend = await page.evaluate(() => engine.describe().renderer);
  console.log(rendererLine(backend, browser.render.kind));
  if (!await page.evaluate(hookScript)) throw new Error('capture cannot hook this renderer: it has neither renderBufferDirect nor _renderObjectDirect, so no draw can be listed');   // the hook records the draws of the next render
  let spector = null;
  if (backend.backend === 'webgpu') spectorNote = 'Spector skipped: it records WebGL commands and this frame is drawn on WebGPU';
  else if (!opt['no-spector']) {
    try {
      const code = await fetchSpector(join(dir, '.threedog', 'cache'), opt['spector-url']);
      await page.addScriptTag({ content: code });
      const ok = await page.evaluate(() => {
        const S = window.SPECTOR; if (!S) return false;
        const sp = window.__spector = new S.Spector();
        window.__captured = null; sp.onCapture.add(c => { window.__captured = c; });
        const canvas = engine.renderer.domElement;
        sp.startCapture(canvas, 1e6, true);   // quick capture: the command list only, no per-draw state snapshots (keeps the file small)
        return true;
      });
      spector = ok;
      if (!ok) spectorNote = 'Spector bundle loaded but window.SPECTOR is missing';
    } catch (e) { spectorNote = 'Spector not available: ' + String(e.message).split('\n')[0]; }
  }
  const frame = await page.evaluate(() => { engine.step(1 / 60); return JSON.parse(JSON.stringify(window.__draws)); });
  let captured = null;
  if (spector) {
    captured = await page.evaluate(async () => {
      window.__spector.stopCapture();
      for (let i = 0; i < 100 && !window.__captured; i++) await new Promise(r => setTimeout(r, 50));
      const c = window.__captured; if (!c) return null;
      return JSON.parse(JSON.stringify(c, (k, v) => (k === 'visual' || k === 'VisualState' ? undefined : v)));
    });
    if (!captured) spectorNote = 'Spector did not return a capture (headless WebGL: the frame ended before it could record)';
    else {
      mkdirSync(outDir, { recursive: true });
      file = join(outDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
      writeFileSync(file, JSON.stringify(opt.full ? captured : slim(captured)));
    }
  }
  if (!frame.draws.length) failed = 'the frame drew nothing: no draw call went through the renderer. Is the page on a screen with no 3D, or is the camera looking at an empty scene? threedog scene --hidden lists what is not drawn';
  else console.log(summarize(frame, { top: TOP, gl: captured ? spectorDraws(captured) : null }));
  if (file) console.log(`\nSpector capture: ${rel(file)} (${(readFileSync(file).length / 1048576).toFixed(1)} MB; the commands array, or with --full a file the Spector UI can load)`);
  if (spectorNote) console.log(`\n${spectorNote}. The summary above comes from the renderer hook alone.`);
} catch (e) { failed = String(e?.message ?? e).split('\n')[0]; }
}, { exitOnFail: true, prefer: 'gpu', server: () => buildAndPreview(dir, { build: !opt['no-build'] }) });
// Spector probes the canvas for a WebGL 1 context; three.js logs that as an error although nothing is wrong
const real = errors.filter(e => !/Canvas has an existing context of a different type/.test(e));
if (real.length) console.log('\nPage errors:\n  ' + real.slice(0, 5).join('\n  '));
if (failed) console.error('✗ ' + failed);
process.exit(real.length || failed ? 1 : 0);
