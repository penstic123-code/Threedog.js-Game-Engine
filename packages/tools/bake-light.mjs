// Bake light: threedog bake light [-w game] [--out public/light/level.lightmap] [--size 1024] [--samples 128] [--page /index.html]
// Opens the game in a browser with a real GPU, bakes a lightmap of the meshes marked userData.static = true (light-bake-page.js) and writes one file for
// engine.loadLightmap: the map in half precision and the second UV set.
// Why system Chrome and not the repo's Chromium: three's LightMapper needs real WebGPU, and Playwright's Chromium has no dxil.dll, so it compiles through FXC, which fails
// on some of three's shaders with only a console error. Why this stops instead of falling back: a software bake takes minutes and proves nothing about the GPU path.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cli, rel } from './paths.mjs';

const { dir: ROOT, opt } = cli(process.argv.slice(2), { values: ['out', 'size', 'samples', 'page'], positional: true });
const size = Number(opt.size ?? 1024), samples = Number(opt.samples ?? 128);
if (!Number.isInteger(Math.log2(size)) || size < 64 || size > 4096) { console.error(`✗ --size ${opt.size}: use a power of two from 64 to 4096`); process.exit(1); }
if (!Number.isInteger(samples) || samples < 8 || samples > 2048) { console.error(`✗ --samples ${opt.samples}: rays per texel, a whole number from 8 to 2048`); process.exit(1); }
const OUT = resolve(ROOT, opt.out ?? 'public/light/level.lightmap');

const [{ withBrowser, launchRealGPU, injectTool, devServer }, { waitEngine }] = await Promise.all([import('./browser.mjs'), import('./wait-engine.mjs')]);
let code = 0;
await withBrowser(async ({ base, launch }) => { try {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } }), errors = [];
  page.on('pageerror', x => errors.push(String(x)));
  // a shader that fails to compile is only a console line: the draw is dropped and the map stays black, so the failure has to show here
  const gpuErrors = []; page.on('console', m => { if (/error while parsing WGSL|pipeline creation failed/i.test(m.text())) gpuErrors.push(m.text().slice(0, 900)); });
  await injectTool(page, base, 'light-bake-page.js', async () => {
    await page.goto(base + (opt.page ?? '/'));
    await waitEngine(page, { errors });
  }, () => window.threedogBakeLightReady);
  const r = await page.evaluate(a => window.threedogBakeLight(a), { size, samples });
  if (r.gpu) console.log(`GPU: ${r.gpu}, backend ${r.backend}, browser ${browser.version()}`);
  if (r.error || gpuErrors.length) { console.error('✗ ' + (r.error ?? 'a GPU pipeline failed, so the bake cannot be trusted')); for (const l of gpuErrors.slice(0, 3)) console.error('  ' + l); code = 1; } else {
    const table = Buffer.from(JSON.stringify(r.meta)), head = Buffer.alloc(8);
    head.writeUInt32LE(0x4d4c4454, 0); head.writeUInt32LE(table.length, 4);
    const pad = Buffer.alloc(((8 + table.length + 7) & ~7) - 8 - table.length);   // engine.loadLightmap reads aligned views
    const file = Buffer.concat([head, table, pad, Buffer.from(r.texture, 'base64'), Buffer.from(r.lists, 'base64')]);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, file);
    console.log(`✓ ${rel(OUT)}  ${(file.length / 1048576).toFixed(1)} MB, ${r.meta.meshes.length} mesh(es), ${size} map, ${r.rays} rays per texel, brightest texel ${+r.brightest.toFixed(3)}, ${r.ms} ms`);
    for (const s of r.meta.skipped) console.log(`  skipped ${s.name}: ${s.why}`);
    if (r.warnings.excludedFaces) console.log(`  ${r.warnings.excludedFaces} face(s) too thin to unwrap`);
    console.log('  In the game: await engine.loadLightmap(path), and turn down the ambient light the bake saw (recipes/34-environment-lighting.md)');
  }
} catch (e) { console.error('✗ ' + String(e?.message ?? e).split('\n')[0]); code = 1; } },
{ launch: launchRealGPU, server: () => devServer(ROOT, { cacheDir: '.threedog/vite-bake', fs: { strict: false } }) });
process.exit(code);
