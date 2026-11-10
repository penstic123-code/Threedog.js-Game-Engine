// threedog gallery: every registered model and texture of a game on a turntable under three neutral light setups, and the look-dev
// switches (light setups incl. the game's own, exposure, tone mapping, channels, one material on a sphere) (packages/tools/gallery).
//   threedog gallery [-w game] [--port 5181]       serve the game in dev mode and print the gallery URL (/?gallery=1); Ctrl+C stops it
//   threedog gallery --shots [--size 256] [--only a,b] [--mode silhouette,value,albedo,normal,roughness,metalness,ao]
//                            [--light midday,lowSun,overcast,studio,game] [--exposure 1.2] [--tone agx] [--material name]
//                                                  headless: one PNG per asset per light in <game>/.threedog/gallery/, plus index.html
//                                                  (all pictures on one page) and index.json; --mode adds <name>-<mode>.png per asset and
//                                                  prints their measured facts; --light picks the light columns (studio: a neutral room to
//                                                  reflect; game: the game's own lights and environment map); --material puts one material
//                                                  of the game (a TSL one too) on a sphere; compare a crop with a reference:
//                                                  threedog picture compare <reference.png> .threedog/gallery/<name>-midday.png --out diff.png
// Why the dev server (not a build): the gallery is injected by the vite preset in dev only, and an asset edit needs no rebuild to be seen.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, rel } from './paths.mjs';
import { intOption } from './lib/cli-args.mjs';
import { headlessUrl } from './lib/page-url.mjs';
import { parseGalleryOptions, fileStems, escapeHtml as esc } from './gallery/index.js';


const { dir, opt } = cli(process.argv.slice(2), { flags: ['shots', 'gpu', 'software'], values: ['port', 'size', 'only', 'mode', 'light', 'exposure', 'tone', 'material'] });
let look;
try { look = parseGalleryOptions(opt); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
if (opt.shots) process.env.THREEDOG_TEST = '1';   // before the server: the vite preset reads it, and a run for pictures must not rewrite GAMEMAP.md
const { devServer } = await import('./browser.mjs');
const { base, close } = await devServer(dir, { port: opt.port ? +opt.port : opt.shots ? 0 : 5181, host: '127.0.0.1', open: false });
if (!opt.shots) {
  console.log(`Asset gallery: ${base}/?gallery=1   (${rel(dir)}; save an art module and the gallery and game update in place; Ctrl+C stops)`);
} else {
  const { launchBrowser, newGamePage } = await import('./browser.mjs');
  const { waitEngine } = await import('./wait-engine.mjs');
  const browser = await launchBrowser({ prefer: 'gpu' }), errors = [], out = join(dir, '.threedog', 'gallery');
  let code = 0;
  try {
    const page = await newGamePage(browser, { errors });
    // desktop tier like shot (core/scene/tier.js): the headless browser would be detected low and the turntables would lack the game's post
    await page.goto(base + headlessUrl('/', { 'threedog-tier': 'high', cutscene: 'skip', gallery: '1' }));
    await waitEngine(page, { timeout: 120000, errors, dir });
    await page.waitForFunction(() => !!globalThis.threedogGallery, null, { timeout: 30000 });
    const size = intOption(opt, 'size') ?? 256, only = typeof opt.only === 'string' ? opt.only.split(',') : null;
    const list = await page.evaluate(o => globalThis.threedogGallery.shots(o), { size, only, ...look });
    const typo = only?.filter(n => !list.some(s => s.name === n)) ?? [];
    if (typo.length) throw new Error(`--only: no asset named ${typo.join(', ')}`);
    mkdirSync(out, { recursive: true });
    const rows = [], stems = fileStems(list.map(s => s.name));
    for (const s of list) {
      const file = `${stems.get(s.name)}-${s.light}.png`;
      if (s.png) writeFileSync(join(out, file), Buffer.from(s.png.split(',')[1], 'base64'));
      rows.push({ name: s.name, type: s.type, light: s.light, ...(s.png ? { file } : { error: s.error }), ...(s.facts ? { facts: s.facts } : {}) });
    }
    writeFileSync(join(out, 'index.json'), JSON.stringify(rows, null, 1));
    const lights = [...new Set(rows.map(r => r.light))], names = [...new Set(rows.map(r => r.name))];
    const factText = f => f ? Object.entries(f).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
    const cell = r => r?.file ? `<td><img src="${esc(r.file)}" width="${size}" height="${size}">${r.facts ? `<br>${esc(factText(r.facts))}` : ''}</td>` : `<td>${esc(r?.error ?? '')}</td>`;
    writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Asset gallery</title><style>body{font:12px sans-serif;background:#222;color:#ddd}td{padding:2px;vertical-align:middle;text-align:center}</style>
<table><tr><th></th>${lights.map(l => `<th>${esc(l)}</th>`).join('')}</tr>
${names.map(n => `<tr><td>${esc(n)}</td>${lights.map(l => cell(rows.find(r => r.name === n && r.light === l))).join('')}</tr>`).join('\n')}</table>`);
    const bad = rows.filter(r => r.error);
    console.log(`Gallery shots: ${rows.length - bad.length} PNG(s), ${names.length} asset(s), columns ${lights.join(' / ')} -> ${rel(out)}/ (index.html shows them all)`);
    // facts only: fill = share of the frame the outline covers, boxFill = share of its own bounding box, aspect = width/height;
    // p5 / p50 / p95 = luminance percentiles (0..1) inside the outline. What reads well depends on the game, so no threshold is applied.
    for (const r of list.filter(x => x.note)) console.log(`  ${r.light}: ${r.note}`);
    if (look.modes.length) for (const n of names) {
      const f = rows.filter(r => r.name === n && r.facts).map(r => `${r.light}: ${factText(r.facts)}`);
      if (f.length) console.log(`  ${n}  ${f.join('   ')}`);
    }
    if (bad.length) { console.log('Failed:\n  ' + bad.map(r => `${r.name}: ${r.error}`).slice(0, 10).join('\n  ')); code = 1; }
  } catch (e) { console.error(String(e?.message ?? e)); code = 1; }
  finally { await browser.close(); await close(); }
  if (errors.length) console.log('\nPage errors:\n  ' + errors.slice(0, 5).join('\n  '));
  process.exit(code);
}
