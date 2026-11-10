// Performance comparison: npm run perf (run this before writing results into docs/testing/perf.md)
// Build (including test pages) → open the packages/engine/tests/perf/ pages in a headless browser and measure:
//   1. native three.js vs the engine (no modules) on the same scene: 2000 cubes + 1 directional light with shadows, CPU milliseconds per frame and draw calls
//   2. per-module time per frame with openWorld fully on
//   3. shadow updateEvery 1 vs 3, snap 0.5 vs 'texel': shadow update count, shadow draw calls, milliseconds per frame
//   4. first frame (engine.startup.firstFrameMs and its phases) for the examples, a WebGPU page and the blank new-game template
//   5. automatic batching (engine.batching): 3000 repeated props over 4 models, batching off vs on
//   6. streaming into a new area: ms per stage of applying background results (transit, build, collider, upload, stream)
//   7. the two real pages (world example, city test page) on WebGL and WebGPU: frame time, draw calls, programs, memory
// A game: threedog perf -w my-game [frames]: its page in play, standing still, on the same numbers as section 7 (frame ms, JS ms, draw calls, memory);
//   the sections above measure the engine's own test pages, so --only, --shading and --renderer do not apply to a game.
// Run one section only: npm run perf -- --only=props (sections: native, world, startup, props, stream, pages)
// Terrain shading for the stream section: npm run perf -- --only=stream --shading=texture
// Renderer: the hardware GPU when headless can reach it, else SwiftShader (--gpu / --software force one); the first line says which. Under SwiftShader
// GPU work counts as CPU time, so only look at relative differences. Pages section route: --renderer=webgl|webgpu|both (default both).
// Resolution: --size WxH (default 1280x720, as in shot / capture), e.g. npm run perf -- --size 1920x1080. A game: threedog perf -w my-game --size 1920x1080.
// Impostor cards (docs/plans/2026-11-09-impostors.md): --impostor adds a row of the world example with its trees as baked cards (?impostor), WebGPU route only.
// Frame count: npm run perf -- 120. Load ramps per axis: threedog stress
process.env.THREEDOG_TEST = '1';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, buildAndPreview, newGamePage } from './browser.mjs';
import { waitEngine } from './wait-engine.mjs';
import { ENGINE, GAMES, MODE, ROOT, cli, rel } from './paths.mjs';
import { intOption } from './lib/cli-args.mjs';
import { viewSize } from './lib/shot-name.mjs';
import { copyTemplates } from './lib/scaffold.mjs';

// Without -w (and outside a game folder) it measures the engine package (test pages in tests/perf/ and the two examples)
// --only one section (`--only world` and `--only=world` both work; perf and stress used to read opposite spellings); a frame count as `--frames 120`
// or a bare number. A wrong section or shading fails before the build instead of measuring nothing and exiting 0
const SECTIONS = ['native', 'world', 'startup', 'props', 'stream', 'pages'], ROUTES = ['webgl', 'webgpu', 'both'], SHADINGS = ['smooth', 'flat', 'texture'];
const { dir, named, opt, rest } = cli(process.argv.slice(2), { workspace: 'scope', positional: true, flags: ['gpu', 'software', 'impostor'], values: ['only', 'shading', 'frames', 'renderer', 'size'] });
const GAME = MODE === 'game' ? dir ?? ROOT : named && dir !== ENGINE ? dir : null;   // a game in its own repo has no engine pages to fall back on
const fail = m => { console.error('✗ ' + m); process.exit(1); };
if (GAME && (opt.only || opt.shading || opt.renderer)) fail('perf -w <game> measures the game\'s own page: --only, --shading and --renderer choose among the engine\'s test pages');
if (opt.only && !SECTIONS.includes(opt.only)) fail(`perf --only: unknown section "${opt.only}". Sections: ${SECTIONS.join(', ')}`);
if (opt.shading && !SHADINGS.includes(opt.shading)) fail(`perf --shading: "${opt.shading}" is not one of ${SHADINGS.join(', ')}`);
if (opt.renderer && !ROUTES.includes(opt.renderer)) fail(`perf --renderer: "${opt.renderer}" is not one of ${ROUTES.join(', ')}`);
if (rest.length > 1 || (rest[0] && opt.frames)) fail(`perf takes one frame count, got ${[...rest, opt.frames].filter(Boolean).join(' ')}`);
const ONLY = opt.only, want = k => !GAME && (!ONLY || ONLY === k);
const SHADING = opt.shading;   // world / stream pages: terrain shading 'smooth' | 'flat' | 'texture' (default: the page's)
let W, H; try { [W, H] = viewSize(opt.size ?? '1280x720'); } catch (e) { fail(e.message); }   // --size WxH as in shot / capture; perf kept its own 1280x720 default
let FRAMES = 60;
try { FRAMES = intOption({ frames: opt.frames ?? rest[0] }, 'frames') ?? FRAMES; } catch (e) { fail(e.message); }
const server = await buildAndPreview(GAME ?? ENGINE), base = server.base;
// A fresh browser for every page (leftover work in the software-rendering GPU process from the previous page would slow the next one)
let said = false, failed = 0;
async function open(url, host = base) {
  const browser = await launchBrowser({ prefer: 'gpu' });
  if (!said) { said = true; console.log(`Renderer: ${browser.render.kind}${browser.render.renderer ? ` (${browser.render.renderer})` : ''}`); }
  const page = await newGamePage(browser, { viewport: { width: W, height: H } });
  page.close = () => browser.close();
  page.on('pageerror', e => console.log('  page error', String(e)));
  try {
    await page.goto(host + url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitEngine(page, { field: 'ready', timeout: 120000 });   // the shared wait: a page that threw fails at once with the engine's fix
  } catch (e) { failed++; await browser.close(); throw e; }   // the callers go on with the next page: this browser must not stay behind
  return page;
}
// Run each item 3 times and take the median (the first run often includes one-time costs such as shader compilation)
async function median(page, fn, arg) {
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await page.evaluate(fn, arg));
  rs.sort((a, b) => a.cpuMs - b.cpuMs);
  return rs[1];
}
const row = (...c) => console.log('| ' + c.join(' | ') + ' |');

if (want('native')) {
console.log(`\n## 1. native three.js vs the engine (${FRAMES} frames, 2000 cubes + directional light shadow)\n`);
row('', 'CPU ms/frame', 'render ms/frame', 'draw calls', 'triangles', 'shadow draw calls');
row('---', '---', '---', '---', '---', '---');
for (const mode of ['native', 'engine', 'native', 'engine']) {   // two alternating rounds, to see whether order matters
  const page = await open(`/tests/perf/index.html?mode=${mode}`);
  const r = await median(page, n => window.bench.run(n), FRAMES);
  row(mode === 'native' ? 'native three.js' : 'engine (no modules)', r.cpuMs, r.renderMs, r.drawCalls, r.triangles, r.shadowCalls);
  await page.close();
}

}
if (want('world')) {
console.log(`\n## 2. openWorld fully on, per-module time per frame (${FRAMES} frames, player moving forward at 6 m/s)\n`);
const world = await open('/tests/perf/index.html?mode=world');
const w = await median(world, n => window.bench.run(n, { move: 6 }), FRAMES);
console.log(`whole frame ${w.cpuMs} ms, of which render ${w.renderMs} ms; draw calls ${w.drawCalls}, triangles ${w.triangles}\n`);
row('module', 'ms/frame');
row('---', '---');
for (const [k, v] of Object.entries(w.modules).sort((a, b) => b[1] - a[1])) row(k, v);

console.log(`\n## 3. shadow parameter comparison (openWorld, ${FRAMES} frames, player moving forward at 6 m/s)\n`);
row('updateEvery', 'snap', 'shadow updates', 'shadow draw calls per update', 'CPU ms/frame', 'render ms/frame');
row('---', '---', '---', '---', '---', '---');
for (const [updateEvery, snap] of [[1, 0.5], [3, 0.5], [1, 'texel'], [3, 'texel']]) {
  const r = await median(world, async ([n, o]) => { const sun = engine.lights.sun, h = [engine.shadows.budget(sun, { every: o.updateEvery }), engine.shadows.box(sun, { snap: o.snap })], r = await window.bench.run(n, { move: 6 }); h.forEach(x => x.remove()); return r; }, [FRAMES, { updateEvery, snap }]);
  row(updateEvery, snap, `${r.shadowRenders}/${FRAMES}`, r.shadowCalls, r.cpuMs, r.renderMs);
}
await world.close();

}
if (want('startup')) {
console.log('\n## 4. first frame: page open to the first frame drawn after the loading screen (engine.startup.firstFrameMs), cold browser, median of 3\n');
console.log('phases add up to it: script (page open until createEngine) / construct / setup (game code until start()) / init (saves, renderer, module init) /');
console.log('preload / world (nearby builds) / compile (shaders + hidden warm-up frame) / draw (ready until the first frame was submitted)\n');
const PHASES = ['script', 'construct', 'setup', 'init', 'preload', 'world', 'compile', 'draw'];
row('page', 'first frame ms', ...PHASES, 'programs', 'slowest module');
row('---', '---', ...PHASES.map(() => '---'), '---', '---');
async function firstFrame(name, url, host = base) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    let page;
    try { page = await open(url, host); } catch (e) { row(name, 'failed: ' + String(e.message ?? e).split('\n')[0].slice(0, 120)); return; }
    runs.push(await page.evaluate(async () => {
      for (const t0 = performance.now(); engine.startup?.firstFrameMs == null;) {
        if (performance.now() - t0 > 30000) throw new Error('no first frame 30 s after ready');
        await new Promise(r => setTimeout(r, 20));
      }
      const s = engine.startup, p = engine.inspect.perf();
      return { ...s, programs: p.programs ?? engine.renderer._pipelines?.programs?.fragment?.size ?? null, backend: engine.describe().renderer?.backend };
    }).catch(e => ({ error: String(e.message ?? e).split('\n')[0] })));
    await page.close();
  }
  const ok = runs.filter(r => !r.error).sort((a, b) => a.firstFrameMs - b.firstFrameMs);
  if (!ok.length) { row(name, 'failed: ' + runs[0].error); return; }
  const s = ok[ok.length >> 1];
  const slow = Object.entries(s.modules).map(([k, v]) => [k, (v.init ?? 0) + (v.ready ?? 0)]).sort((a, b) => b[1] - a[1])[0];
  row(`${name} (${s.backend})`, `${s.firstFrameMs} (${ok.map(r => r.firstFrameMs).join(' / ')})`, ...PHASES.map(k => s.phases[k]), s.programs, slow ? `${slow[0]} ${slow[1]}` : '—');
}
for (const [name, url] of [['open world', '/'], ['open world WebGPU', '/?renderer=webgpu'], ['town', '/tests/city/index.html'], ['perf island', '/perf-island.html'], ['WebGPU TSL', '/webgpu-tsl.html']])
  await firstFrame(name, url);
// The blank new-game template: scaffolded into a throwaway games/ folder (so it resolves this repo's packages like a real game), built, removed.
// games/ itself is removed too when this run made it and it is empty again (the repo has no games/; an empty one used to be left behind)
const blank = join(GAMES, 'perf-blank-template'), madeGames = !existsSync(GAMES);
rmSync(blank, { recursive: true, force: true });
try {
  copyTemplates(blank, { name: 'perf-blank-template' });
  const srv = await buildAndPreview(blank);
  try { await firstFrame('blank template', '/', srv.base); } finally { await srv.close(); }
} finally {
  rmSync(blank, { recursive: true, force: true });
  if (madeGames && existsSync(GAMES) && !readdirSync(GAMES).length) rmSync(GAMES, { recursive: true, force: true });
}

}
if (want('props')) {
  console.log(`\n## 5. automatic batching (${FRAMES} frames, 3000 repeated props over 4 models placed through world.present, directional shadow)\n`);
  row('', 'CPU ms/frame', 'render ms/frame', 'draw calls (incl. shadow)', 'shadow draw calls', 'batches', 'instances');
  row('---', '---', '---', '---', '---', '---', '---');
  for (const batch of ['0', '1', '0', '1']) {
    const page = await open(`/tests/perf/index.html?mode=props&n=3000&batch=${batch}`);
    const r = await median(page, n => window.bench.run(n), FRAMES);
    const st = await page.evaluate(() => engine.batching.stats);
    row(batch === '0' ? 'batching off' : 'batching on', r.cpuMs, r.renderMs, r.drawCalls, r.shadowCalls, st.batches, st.instances);
    await page.close();
  }
}
if (want('stream')) {
  console.log('\n## 6. streaming into a new area: cost of applying background results, per stage (openWorld, player moved 700 m, 12 s of the real-time loop)\n');
  console.log('transit = worker round trip minus worker compute (async wait, approximate); build = three.js objects; collider = physics colliders;');
  console.log('upload = extra render time of frames that first draw new objects (GPU upload + shader compile, approximate); stream = sync part of stream build()\n');
  row('stage', 'results', 'total ms', 'worst one ms', 'KB');
  row('---', '---', '---', '---', '---');
  const page = await open('/tests/perf/index.html?mode=world' + (SHADING ? '&shading=' + SHADING : ''));
  const r = await page.evaluate(d => window.bench.streamIn(d), 700);
  for (const [k, v] of Object.entries(r.cost)) row(k, v.n, v.totalMs, v.maxMs, Math.round(v.bytes / 1024));
  console.log(`\n${r.frames} frames in ${r.seconds} s, ${r.chunks} chunks loaded; frame CPU avg ${r.cpuAvg} ms, worst ${r.cpuMax} ms ` +
    `(worst frame by phase: ${Object.entries(r.worstPhases).map(([k, v]) => k + ' ' + v).join(', ')})`);
  await page.close();
}

/** In the page: n frames of the running loop, the numbers of section 7 and of a game */
async function sampleFrames(n) {
  await new Promise(res => setTimeout(res, 500));   // let start-up streaming settle a little before sampling
  const timing = engine.profile() !== null; engine.profile(true);   // module medians and p95 over the sampled frames only (a built page times nothing by default)
  const gaps = []; let last = performance.now();
  await new Promise(res => { let k = 0; const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (++k < n) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
  const mid = a => [...a].sort((x, y) => x - y)[a.length >> 1], r1 = v => Math.round(v * 10) / 10;
  const p = engine.inspect.perf(), rd = engine.renderer;
  // the five modules with the worst p95: a spike (p95 far over the median) hitches play even when the median looks cheap
  const modules = Object.entries(engine.profile()).sort((a, b) => b[1].p95 - a[1].p95).slice(0, 5).map(([k, m]) => `${k} ${m.ms}/${m.p95}`).join(', ');
  if (!timing) engine.profile(false);
  // WebGPU keeps no program list in renderer.info: count the distinct fragment programs three's pipeline cache holds instead
  const programs = p.programs ?? rd._pipelines?.programs?.fragment?.size ?? null;
  return { cpuMs: p.cpuMs, frameMs: r1(mid(gaps.slice(1))), backend: engine.describe().renderer?.backend ?? '?', reason: engine.describe().renderer?.reason, drawCalls: p.drawCalls, triangles: p.triangles,
    programs, geometries: p.memory.geometries, textures: p.memory.textures, textureMB: p.textureMB, heapMB: performance.memory ? r1(performance.memory.usedJSHeapSize / 1048576) : null, modules };
}

if (GAME) {
  // the real loop, past the title: a built page reads no ?play, so the same call the title's Start ends in. Headless mode would stop the loop being measured
  let page;
  try { page = await open('/'); await page.evaluate(() => engine.applyState({ play: 1 })); }
  catch (e) { await server.close(); fail(`the game's page did not start: ${String(e.message ?? e).split('\n')[0]}`); }
  const r = await median(page, sampleFrames, FRAMES * 2);
  await page.close();
  console.log(`\n## ${rel(GAME)}, in play, standing still (${FRAMES * 2} frames, median of 3 runs)\n`);
  console.log('frame = requestAnimationFrame interval (capped by vsync on a GPU); JS = main-thread ms of update + render submit\n');
  row('backend', 'frame ms', 'JS ms', 'draw calls', 'triangles', 'programs', 'geometries', 'textures', 'texture MB', 'JS heap MB');
  row('---', '---', '---', '---', '---', '---', '---', '---', '---', '---');
  row(r.backend, r.frameMs, r.cpuMs, r.drawCalls, r.triangles, r.programs, r.geometries, r.textures, r.textureMB, r.heapMB);
  console.log(`\nmodules, ms median/p95 (worst p95 first): ${r.modules || 'none timed'}`);
}

if (want('pages')) {
  // Why measure the real pages and not only tests/perf: the WebGPU route's cost shows on full games (sky, post chain, terrain, many materials),
  // and these two pages are the ones the WebGL vs WebGPU advice in recipe 56 is about. ?renderer=webgpu switches the page itself (its main.js).
  console.log(`\n## 7. real pages, WebGL vs WebGPU (${FRAMES * 2} frames standing still after ready, median of 3 runs)\n`);
  console.log('frame = requestAnimationFrame interval (capped by vsync on a GPU); JS = main-thread ms of update + render submit\n');
  row('page', 'route', 'backend', 'frame ms', 'JS ms', 'draw calls', 'triangles', 'programs', 'geometries', 'textures', 'texture MB', 'JS heap MB');
  row('---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---');
  const routes = !opt.renderer || opt.renderer === 'both' ? ['webgl', 'webgpu'] : [opt.renderer], spikes = [];
  const pages = [['world example', '/'], ...(opt.impostor ? [['world, impostor cards', '/', 'impostor']] : []), ['city test page', '/tests/city/index.html']];
  for (const [name, url, extra] of pages) {
    for (const route of routes) {
      if (extra && route !== 'webgpu') continue;   // cards are WebGPU only: the WebGL row would measure the same meshes
      let page;
      const query = [route === 'webgpu' && 'renderer=webgpu', extra].filter(Boolean).join('&');
      try { page = await open(url + (query ? '?' + query : '')); } catch (e) { row(name, route, 'failed: ' + String(e.message ?? e).split('\n')[0].slice(0, 120)); continue; }
      // Standing still means the camera too: the world example flies an intro camera for 5 s after ready (the built page reads no ?cutscene=skip),
      // and draw calls follow the view, so a route whose samples fell inside the flight showed ~60 more than one whose samples came after it
      const still = await page.evaluate(async () => {
        const m = engine.camera.matrixWorld, last = m.clone(), t0 = performance.now();
        for (let same = 0; same < 30 && performance.now() - t0 < 20000;) {
          await new Promise(r => requestAnimationFrame(r));
          same = m.equals(last) ? same + 1 : 0; last.copy(m);
        }
        return performance.now() - t0 < 20000;
      });
      if (!still) console.log(`  (${name} ${route}: the camera was still moving after 20 s; measured anyway)`);
      const r = await median(page, sampleFrames, FRAMES * 2);
      if (route === 'webgpu' && r.backend !== 'webgpu') console.log(`  (${name}: no WebGPU adapter, ran on the WebGL2 backend: ${String(r.reason).split('\n')[0]})`);
      row(name, route, r.backend, r.frameMs, r.cpuMs, r.drawCalls, r.triangles, r.programs, r.geometries, r.textures, r.textureMB, r.heapMB);
      spikes.push(`${name} ${route}: ${r.modules || 'none timed'}`);
      await page.close();
    }
  }
  console.log('\nmodules, ms median/p95 (worst p95 first):\n' + spikes.map(l => '  ' + l).join('\n'));
}

await server.close();
process.exit(failed ? 1 : 0);
