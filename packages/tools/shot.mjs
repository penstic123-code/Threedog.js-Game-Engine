// One-shot screenshot: npm run shot -- [page] [options]
// Build → open the page in a headless browser in headless mode (?threedog-headless), with the options turned into URL parameters (?time=18:30&pos=40,-20…, the engine sets up the scenario itself)
// → wait for state:applied → save a PNG to the workspace's .threedog/shots/ and print describeText().
// In headless mode the game only advances on step, so the same options give the same result every time; by default only 1 shot at 960×540, to spare the GPU.
//
//   npm run shot                                   the open-world example in its default state (engine package packages/engine)
//   npm run shot -- -w my-game / --describe-only   another game: -w name (or run npm run shot inside the game directory)
//   npm run shot -- / --time 18:30 --weather rain --pos 40,-20 --wait 3
//   npm run shot -- /tests/city/index.html --time 12:00        the town test page
//   npm run shot -- / --describe-only              print text only, no screenshot
//   npm run shot -- styletest --view room --time dusk --weather rain   the style test page: the lit room at dusk in rain
//
//   npm run shot -- http://localhost:5173/ --time 21:30   a page that is already running (the dev server): no build, opened as given
//   npm run shot -- --image my-shot.png            the pixel part of the picture check on a picture taken any other way (no page, no build)
//
// Options:
//   page            URL path, default /; a bare name is a page of the workspace: `shot styletest` = /styletest.html;
//                   a full http(s):// URL is opened as given, without building (a dev server or any page that sets window.engine)
//   --image file    no page: read this saved picture and print the picture numbers and pixel-only hints (clipped / near-black share, near-white
//                   spots, DESIGN.md intent, --ref). What needs the live page (which light or material glares, shadows, noon / midnight) says so
//   --time HH:MM   set the time of day (needs the sky module)
//   --weather name  clear / cloudy / overcast / rain / storm / snow / fog (needs the weather module)
//   --pos x,z      put the player here (on the ground; the same pos as applyState({ pos }) and ?pos=). The camera's own spot is --view
//   --view name    a named camera view: engine.views.define(name, { position, target, fov }) (camera position and target [x, y, z]) in any game, or a page's own ?view= (the style test: overview, character, water, room, path, ui)
//   --cam x,y,z,tx,ty,tz[,fov]  a camera pose (position, target, optional fov in degrees) without declaring a view: judge a building or backdrop from outside. Not with --view
//   --wait seconds  real seconds to advance after setup (default 1)
//   --load-timeout s  wall seconds to wait for loading (engine.loading) to finish before the shot, default 120; on timeout it fails naming what is pending
//   --size WxH      screenshot resolution, default 960x540
//   --tier low|high  the device tier the page renders at (default high, the desktop tier: the headless browser would detect low, and a game that reads engine.tier would leave out what weak devices skip)
//   --keep-cutscene  do not skip a cutscene that is playing
//   --at place      start in play at a named place (content/places.js, level markers), with the game's camera (?at=, applyState({ at })); no --play needed
//   --play          start straight in play: past the title screen the way its Start does (?play, engine URL key; engine.session.newGame())
//   --describe-only  print describeText() only, no screenshot
//   --out file.png  a bare name: .threedog/shots/file.png instead of the generated name; a path with a directory (./x.png, out/x.png, absolute)
//                   is written as given, relative to the current directory. The output line says where it wrote
//   --keep         do not overwrite: add a timestamp to the generated file name, so shots of several runs sit side by side (with --out the name is used as given)
//   (every shot)   prints the picture numbers (luminance, contrast, saturation, clipped / near-black share, shadow area) and hints: contradictions
//                  (settings say X, pixels show not-X: shadows on but none visible, a light that lights nothing), facts (glare, clipped / near-black
//                  areas, a night not dark from lighting, key / fill) and, only against what the game declared, intent (DESIGN.md "Picture intent"
//                  line, or --ref). Facts and
//                  likely causes with the parameter's current value, never target values; nothing fails, nothing is changed (picture/check.mjs)
//   --ref image    also compare with this reference picture (picture compare) and say where it clearly differs
//   --no-picture      skip the numbers and hints
//   --json         print one JSON object (file, picture numbers, probe facts, hints, describe text) instead of text; for MCP / the dev bridge
//   --compare before.png  after the shot, print both file names, a pixel-diff number (0 = identical) and the picture differences; take `before` with --keep
//   --no-build     do not rebuild, use the last tool build in .threedog/tool-build/ (saves a few seconds when code did not change)
//   --gpu / --software  force the renderer (default: the hardware GPU when headless can reach it, else SwiftShader; also THREEDOG_RENDER=gpu|software)
//   -w name         which workspace (engine, my-game…); default the one containing the current directory, then the engine package
process.env.THREEDOG_TEST = '1';
import { launchBrowser, newGamePage, buildAndPreview } from './browser.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cli, rel } from './paths.mjs';
import { waitEngine, waitLoaded, sceneCounts, refuseState } from './wait-engine.mjs';
import { camPose, shotName, shotFile, viewSize, wrongServer } from './lib/shot-name.mjs';
import { formatPicture, pagePicture, imagePicture, NO_PAGE } from './picture/check.mjs';
import { PICTURE, TITLE_COVERS } from './threedog/pageFns.mjs';
import { drawnBy, headlessUrl } from './lib/page-url.mjs';

const t0 = Date.now();

// switches never take a value (so `--keep /page` keeps /page as the page); an unknown option fails naming the closest one
let { dir, page: url, pageArg, opt } = cli(process.argv.slice(2), { page: '/', flags: ['keep', 'no-picture', 'json', 'describe-only', 'no-build', 'keep-cutscene', 'gpu', 'software', 'play'],
  values: ['time', 'weather', 'pos', 'at', 'view', 'cam', 'wait', 'load-timeout', 'size', 'compare', 'out', 'ref', 'tier', 'image'],
  // an option the other switches off used to be dropped without a word (--ref under --no-picture compared nothing)
  conflicts: [['ref', 'no-picture', 'the reference is compared inside the picture check'], ['cam', 'view', 'a view and a pose both place the camera'],
    ...['ref', 'compare', 'out', 'keep'].map(k => [k, 'describe-only', 'describe-only takes no screenshot']),
    ...['time', 'weather', 'pos', 'view', 'cam', 'wait', 'size', 'out', 'keep', 'compare', 'no-picture', 'describe-only', 'tier', 'play'].map(k => [k, 'image', '--image reads a saved picture, there is no page to set up'])] });
const json = !!opt.json;
if (opt.image !== undefined) process.exit(await imageOnly(opt));

/** --image: the picture check's pixel facts on a picture taken any other way (a self-written screenshot script, a browser's own capture) */
async function imageOnly(opt) {
  if (opt.image === true) { console.log('✗ --image needs a file: shot --image my-shot.png'); return 1; }
  try {
    let ref = null;
    if (opt.ref && opt.ref !== true) ref = await (await import('./picture/compare.mjs')).compareImages(opt.ref, opt.image);
    const r = await imagePicture(opt.image, { dir, ref });
    if (json) console.log(JSON.stringify({ image: resolve(opt.image), size: r.size, picture: r.numbers, intent: r.intent, hints: r.hints, page: false }, null, 1));
    else console.log([`Picture: ${opt.image} (${r.size.join('×')})`, ...formatPicture(r.numbers, null, r.hints, null), NO_PAGE].join('\n'));
    return 0;
  } catch (e) { console.log('✗ ' + e.message); return 1; }
}
// The device tier the page renders at (core/scene/tier.js ?threedog-tier). Default high: the headless browser reports SwiftShader or an integrated GPU,
// which detection calls low, and the shot then showed what a game gives weak devices; --tier low checks exactly that
const tier = opt.tier === undefined ? 'high' : String(opt.tier);
if (!['low', 'high'].includes(tier)) { console.log(`✗ --tier ${opt.tier}: use low or high`); process.exit(1); }
const say = json ? () => {} : (...a) => console.log(...a), result = {};   // --json: stdout is the one JSON object
if (/^[\p{L}\p{N}_-]+$/u.test(url)) url = `/${url}.html`;   // a bare name is a page: shot styletest
let W, H; try { [W, H] = viewSize(opt.size); } catch (e) { console.log('✗ ' + e.message); process.exit(1); }
let pose = null; if (opt.cam !== undefined) { try { pose = camPose(opt.cam); } catch (e) { console.log('✗ ' + e.message); process.exit(1); } }
const wait = opt.wait !== undefined ? +opt.wait : 1;
const loadTimeout = opt['load-timeout'] !== undefined ? +opt['load-timeout'] : 120;
if (!(loadTimeout > 0)) { console.log(`✗ --load-timeout ${opt['load-timeout']}: a number of seconds`); process.exit(1); }   // NaN never times out

// a full URL: the page already runs (dev server, another host). Why: the demos screenshotted their running dev server with their own script and
// skipped the picture check; pointing shot at that same URL keeps the check without a build
const live = /^https?:\/\//i.test(url);
// npm echoes the rewritten argument (`> threedog shot C:/Git/`): say which page really opens, so the echo is not taken for it
if (pageArg && pageArg !== url && /^[A-Za-z]:[\\/]/.test(pageArg)) say(`Page: ${url} (Git Bash had rewritten the argument to ${pageArg}; undone)`);
if (live) {
  const who = await wrongServer(url, dir);
  if (who.wrong) { console.log('✗ ' + who.wrong); process.exit(1); }
  if (who.unknown) say(`Note: ${who.unknown}`);
}
if (!opt['no-build'] && !live) say(`Building… (${rel(dir)})`);
const server = live ? { base: '', close: async () => {} } : await buildAndPreview(dir, { build: !opt['no-build'] }), base = server.base;
const browser = await launchBrowser({ prefer: 'gpu' });   // a hardware GPU is several times faster than SwiftShader; tests stay on software for stable pixels
const errors = [];
const page = await newGamePage(browser, { errors, viewport: { width: W, height: H } });

try {
  // Time, weather, position, skipping cutscenes and advancing are all left to the engine's URL parameters (engine.applyState, see packages/engine/core/inspect/UrlState.js)
  const q = new URLSearchParams({ 'threedog-tier': tier });
  for (const k of ['time', 'weather', 'pos', 'at', 'view']) if (opt[k]) q.set(k, opt[k]);
  q.set('wait', String(wait));
  q.set('cutscene', opt['keep-cutscene'] ? 'keep' : 'skip');
  if (opt.play) q.set('play', '');
  await page.goto(base + headlessUrl(url, q));
  await waitEngine(page, { timeout: 60000, errors });
  await refuseState(page, ['time', 'weather', 'pos', 'at', 'view']);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  // --cam: a throwaway view through the engine's own views (the camera is taken over, and the world loads around the target), before waiting for loading
  if (pose) await ev(p => { engine.views.define('shot-cam', p); engine.views.show('shot-cam'); }, pose);
  // A picture taken while terrain / models are still arriving shows a half-built world that looks like an art bug, so finish loading first.
  // Headless only advances on step, so step (no render) until engine.loading says nothing is pending; past the limit fail with what it is still waiting for
  // then the game's own code after `await engine.start()` (lamps added after a later await): a shot never shows the scene before it ran
  const { tail } = await waitLoaded(page, { timeout: loadTimeout * 1000 });
  result.afterStart = tail;
  const grew = [['objects', tail.objects], ['lights', tail.lights], ['materials', tail.materials]].filter(([, n]) => n).map(([k, n]) => `${n > 0 ? '+' : ''}${n} ${k}`);
  if (!tail.quiet) say(`  The scene was still changing ${Math.round(tail.ms / 1000)} s after start() resolved (${grew.join(', ') || 'requests still open'}); shot as it is now`);
  else if (grew.length) say(`  Waited ${(tail.ms / 1000).toFixed(1)} s for the game's code after await engine.start() (${grew.join(', ')})`);
  await ev(() => engine.ui.settled());   // the loading screen fades out on a wall-clock timer after ready; do not capture it mid-fade
  const text = await ev(() => { engine.step(1 / 30, { render: true }); return engine.describeText(); });
  if (!opt['describe-only']) {
    // --keep: a timestamp in a generated name (an explicit --out is the name the caller chose and wants to find again, so it is used as given), so a new shot never replaces an earlier one (to compare before / after a change)
    const stamp = opt.keep && (!opt.out || opt.out === true) ? '_' + new Date().toISOString().replace(/\D/g, '').slice(4, 14) + String(Date.now() % 1000).padStart(3, '0') : '';
    // --out: a bare name goes into .threedog/shots/ too, a path with a directory is kept as given (lib/shot-name.mjs)
    const file = shotFile(dir, opt.out === true ? undefined : opt.out, shotName(url, opt, wait), stamp);
    // the same file on both sides: the new shot would replace the "before" and the diff would read identical
    if (opt.compare && opt.compare !== true && resolve(opt.compare) === resolve(file)) throw new Error(`--compare ${opt.compare} is the file this shot writes: copy it first, or use --keep or --out`);
    mkdirSync(dirname(file), { recursive: true });
    const pictured = await sceneCounts(page);
    await page.screenshot({ path: file });
    const backend = drawnBy(await ev(() => engine.describe().renderer));
    Object.assign(result, { file, size: [W, H], renderer: browser.render.kind, backend, tier });
    say(`Screenshot: ${rel(file)} (${W}×${H}, ${browser.render.kind} rendering, ${tier} tier, drawn by ${backend})`);
    // the picture numbers below would measure the start screen, not the game's picture
    if (!opt.play && await ev(() => engine.ui.isOpen('title'))) say('  ' + TITLE_COVERS);
    if (opt.compare && opt.compare !== true) {   // before / after: the earlier picture against this one
      const { compareImages, formatCompare, pixelDiff } = await import('./picture/compare.mjs');
      const diff = await pixelDiff(opt.compare, file), cmp = await compareImages(opt.compare, file);
      result.compare = { before: opt.compare, pixelDiff: diff, ...cmp };
      say(`Before: ${opt.compare}
After:  ${rel(file)}
Pixel diff: ${diff} (0 = identical, 1 = black vs white)`);
      say(formatCompare(cmp));
    }
    if (!opt['no-picture']) {
      const tPicture = Date.now();
      let ref = null, refMs = 0;
      if (opt.ref && opt.ref !== true) {   // --ref opens its own picture reader: not counted in the picture time
        const { compareImages } = await import('./picture/compare.mjs'), t = Date.now();
        ref = await compareImages(opt.ref, file); refMs = Date.now() - t;
      }
      // noon / midnight renders only where the game moves time (calendar + sky: 'auto'), or when this shot set a time
      // Playwright evaluates a string as an expression (a function source comes back as the function itself, serialized to undefined): call it here
      const lk = await pagePicture((src, arg) => page.evaluate(`(${src})(${JSON.stringify(arg)})`), { dir, time: opt.time ? true : 'auto', ref });
      // the picture check never fails the shot: a probe that could not read the canvas says so and the shot stands
      if (lk.error) { result.pictureError = lk.error; say(`Picture: skipped (${lk.error})`); }
      else {
        const pictureMs = Date.now() - tPicture - refMs;
        Object.assign(result, { picture: lk.numbers, pictureMs, probe: lk.probe, intent: lk.intent, hints: lk.hints, ...(ref && { ref: { file: ref.reference.file, diff: ref.diff, summary: ref.summary } }) });
        say(formatPicture(lk.numbers, lk.probe, lk.hints, pictureMs).join('\n'));
      }
    }
    // the quiet wait cannot see a game that adds things after a timer with no request open: count again now, so such a picture is never taken for complete
    const later = await sceneCounts(page), late = Object.keys(later).filter(k => later[k] !== pictured[k]);
    if (late.length) {
      result.lateChange = { pictured, later };
      say(`Warning: the scene changed after this picture was taken (${late.map(k => `${k} ${pictured[k]} -> ${later[k]}`).join(', ')}): it may lack what the game added late. Add it before await engine.start()`);
    }
  }
  result.describe = text;
  // under a picture only what bears on it (the same PICTURE lines as threedog snap); --describe-only and --json keep the whole describeText
  if (opt['describe-only']) say('\n' + text);
  else { result.pictureLines = await ev(`(${PICTURE})(window.engine)`); say('\n' + result.pictureLines.join('\n')); }   // result.picture holds the numbers
} catch (e) { errors.push(String(e?.message ?? e)); }   // whole message: the wait/loading failures put the reason on the following lines
finally { await browser.close(); await server.close(); }
if (errors.length) say('\nPage errors:\n  ' + errors.slice(0, 5).join('\n  '));
say(`\nTook ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (json) console.log(JSON.stringify({ ...result, errors, seconds: +((Date.now() - t0) / 1000).toFixed(1) }, null, 1));
process.exit(errors.length ? 1 : 0);

