// threedog stress [-w game] [--only a,b] [--frames 30] [--json] [--gpu|--software]: load ramps, one axis at a time.
// In a game (run from its folder, or -w): the load goes on top of the game's own scene, on the game's own renderer (stress-page.js), in system Chrome on the real GPU. A WebGPU game
// that lands on the WebGL2 fallback is refused: those numbers would describe another renderer. Outside a game, in the engine repo: the neutral page packages/engine/tests/stress/,
// always named as such, for the table in docs/testing/perf.md. That page does not ship in the npm package, so an install has only the game route.
// Each axis starts small and grows (×2 per step; post effects one at a time) until the frame crosses 33 ms, fails (shader limit, lost context) or hits
// its cap; a step is 6 warm-up + `frames` measured frames (medians). Prints per step cpu / gpu / frame ms, then a budget table: the largest load that
// still fits 16.7 ms (60 fps) and 33 ms (30 fps), with a log-interpolated crossing estimate. GPU ms needs EXT_disjoint_timer_query_webgl2.
// Renderer: a game always runs on the hardware GPU, so --software (or THREEDOG_RENDER=software) is refused there. The neutral page takes the hardware GPU when
// headless can reach it (the point of this tool), else SwiftShader with a note, and follows --gpu / --software. The budget table goes into docs/testing/perf.md labelled
// with the renderer string it printed.
process.env.THREEDOG_TEST = '1';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withBrowser, launchRealGPU, buildAndPreview, devServer, injectTool, forcedRender } from './browser.mjs';
import { ENGINE, cli } from './paths.mjs';
import { rendererLine, headlessUrl } from './lib/page-url.mjs';
import { waitEngine, waitLoaded } from './wait-engine.mjs';
import { intOption } from './lib/cli-args.mjs';

// --only a,b / --only=a,b (the axes are checked against the page's list below); --frames N a whole number
const { dir, opt } = cli(process.argv.slice(2), { workspace: 'targets', flags: ['json', 'gpu', 'software'], values: ['only', 'frames'] });
const GAME = dir && dir !== ENGINE && existsSync(join(dir, 'main.js')) ? dir : null;
if (!GAME && !existsSync(join(ENGINE, 'tests/stress/index.html'))) { console.error('✗ stress measures a game: run it from the game folder or with -w game (the neutral page only exists in the engine repo)'); process.exit(1); }
if (GAME && forcedRender() === 'software') { console.error('✗ stress measures a game on the real GPU: --software (or THREEDOG_RENDER=software) only applies to the neutral page'); process.exit(1); }
const ONLY = opt.only?.split(','), JSON_OUT = !!opt.json;
let FRAMES = 30;
try { FRAMES = intOption(opt, 'frames') ?? FRAMES; } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const t0 = Date.now();
// the game on a dev server: the injected page has to import the game's own three
let out, code = 0;
await withBrowser(async ({ server, launch }) => {
  const browser = await launch();
  out = { target: GAME ? 'game' : 'neutral page', renderer: browser.render?.renderer ?? 'SwiftShader (software)', kind: browser.render?.kind ?? 'gpu', timer: false, axes: {} };
  try {
    const open = async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', e => say('  page error', String(e)));
      if (GAME) {
        await injectTool(page, server.base, 'stress-page.js', async () => {
          await page.goto(server.base + headlessUrl('/', { 'threedog-tier': 'high', cutscene: 'skip' }));
          await waitEngine(page, { timeout: 120000, errors: [] });
          await waitLoaded(page);
        }, () => window.stress?.ready);
        return page;
      }
      await page.goto(server.base + '/tests/stress/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => window.stress?.ready, null, { timeout: 120000 });
      return page;
    };
    const probe = await open();
    const axes = await probe.evaluate(() => window.stress.axes), maxTex = await probe.evaluate(() => window.stress.maxTexture());
    if (GAME) {
      const back = await probe.evaluate(() => engine.describe().renderer);
      out.renderer = rendererLine(back).replace('Renderer: ', ''); out.backend = back.backend;
      if (back.requested === 'webgpu' && back.backend !== 'webgpu') throw new Error(`stress refuses: the game asks for WebGPU but this browser gave it ${back.backend}${back.reason ? ` (${back.reason})` : ''}, so the numbers would describe another renderer`);
      await probe.evaluate(() => { engine.step(1 / 60, { render: true, describe: false }); });
      out.alone = await probe.evaluate(f => window.stress.measure(f), FRAMES);
      if (!out.alone.drawCalls) throw new Error('the game drew nothing on this page, so there is no frame to load: is it on a screen with no 3D?');
    }
    await probe.close();
    for (const k of ONLY ?? []) if (!axes[k]) throw new Error(`stress --only: unknown axis "${k}". Axes: ${Object.keys(axes).join(', ')}`);
    say(`Measured: ${GAME ? 'this game' : 'the neutral test page (WebGL, no game)'} · ${out.renderer} (${out.kind}) · 1280×720 · ${FRAMES} frames per step, medians`);
    if (out.alone) say(`The game alone: ${out.alone.frame} ms a frame (cpu ${out.alone.cpu}), ${out.alone.drawCalls} draw calls, ${out.alone.triangles} triangles. The load below comes on top of it.`);
    for (const [name, ax] of Object.entries(axes)) {
      if (ONLY && !ONLY.includes(name)) continue;
      say(`\n## ${name}: ${ax.unit}`);
      say('| load | cpu ms | gpu ms | frame ms | draw calls | triangles |\n|---|---|---|---|---|---|');
      // a fresh page per axis: leftover GPU memory and compiled programs of the previous axis would bias the next one
      const page = await open(), steps = [];
      let n = ax.start, stop = 'cap';
      try {
        for (; n <= (name === 'shadowMapSize' ? Math.min(ax.cap, maxTex) : ax.cap); n = await page.evaluate(([a, x]) => window.stress.next(a, x), [name, n])) {
          await page.evaluate(([a, x]) => window.stress.set(a, x), [name, n]);
          // the first step of a fresh page still pays one-time costs (program link, render targets, driver warm-up): measure it twice, keep the second
          if (!steps.length) await page.evaluate(f => window.stress.measure(f), FRAMES);
          const r = await page.evaluate(f => window.stress.measure(f), FRAMES);
          out.timer ||= r.timer;
          if (r.error) { stop = `${r.error} at ${n}`; break; }
          steps.push({ n, ...r });
          say(`| ${n} | ${r.cpu} | ${r.gpu ?? '—'} | ${r.frame} | ${r.drawCalls} | ${r.triangles} |`);
          if (r.frame > 33.3) { stop = '33 ms'; break; }
        }
      } catch (e) { stop = `error at ${n}: ${String(e?.message ?? e).split('\n')[0]}`; }
      await page.close();
      out.axes[name] = { unit: ax.unit, ladder: ax.ladder, steps, stop, fit60: fit(steps, 16.7, ax.ladder), fit30: fit(steps, 33.3, ax.ladder) };
      say(`stopped: ${stop}`);
    }
  } catch (e) { console.error(String(e?.message ?? e)); code = 1; }
}, { exitOnFail: true, prefer: 'gpu', launch: GAME ? launchRealGPU : undefined,
  server: () => GAME ? devServer(GAME, { cacheDir: '.threedog/vite-stress', fs: { strict: false } }) : buildAndPreview(ENGINE) });

/** Largest measured load under `ms`, the first above it, and (doubling axes) the log-interpolated crossing */
function fit(steps, ms, ladder) {
  const i = steps.findIndex(s => s.frame > ms), ok = i < 0 ? steps.at(-1) : steps[i - 1], over = i < 0 ? null : steps[i];
  let est = null;
  if (ok && over && !ladder) est = Math.round(ok.n * (over.n / ok.n) ** ((ms - ok.frame) / (over.frame - ok.frame)));
  return { ok: ok ?? null, over, est };
}
const fmt = n => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : String(n);
const cell = f => !f.ok ? 'none (over at the first step)' : !f.over ? `≥ ${fmt(f.ok.n)} (not crossed)` : f.est ? `≈ ${fmt(f.est)}` : `${fmt(f.ok.n)}`;
const at = f => !f.ok ? '—' : `${f.ok.cpu} / ${f.ok.gpu ?? '—'} / ${f.ok.frame}`;

if (JSON_OUT) console.log(JSON.stringify(out, null, 1));
else if (Object.keys(out.axes).length) {
  console.log(`\n## Budget (${GAME ? 'this game' : 'neutral page'}, ${out.renderer}${out.timer ? '' : '; no GPU timer: frame time only'})\n`);
  console.log('| axis | fits 16.7 ms | fits 33 ms | cpu / gpu / frame ms at the 16.7 ms load | stopped by |\n|---|---|---|---|---|');
  for (const [k, a] of Object.entries(out.axes)) console.log(`| ${k} (${a.unit}) | ${cell(a.fit60)} | ${cell(a.fit30)} | ${at(a.fit60)} | ${a.stop} |`);
  console.log(`\nframe = cpu + waiting for the GPU (no overlap): a conservative upper bound. Took ${Math.round((Date.now() - t0) / 1000)} s`);
}
process.exit(code);
