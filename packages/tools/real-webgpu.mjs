#!/usr/bin/env node
// Maintainer script, not part of `npm test`: run pages on REAL WebGPU in system Chrome, where the suite cannot go. The suite's Chromium lands on
// WebGPURenderer's WebGL2 backend, so a "WebGPU" pass there proves the node path, never the WGSL, the bind groups or the device.
//   node packages/tools/real-webgpu.mjs [spec name words...]            the engine's tests/specs whose name or url holds a word, on real WebGPU
//   node packages/tools/real-webgpu.mjs --urls=/a.html,/b.html?x=1      open pages, wait, report (with --shots=dir, one PNG each)
//   --game=<dir>  build and serve this folder instead of packages/engine   --no-build  serve the last tool build
//   --eval=<file> with --urls: run this script in each page once it stands, print what it returns (JSON)
//   --webgl       with --urls: no backend demand, for the WebGL picture to compare with   --headed  a visible window
//   --all-webgpu  examples and tests that ask for no renderer get renderer: 'webgpu' too (a build-time rewrite of createEngine)
// A spec with notRealWebGPU: '<why>' is listed as SKIP: its page holds no device of its own for this run to judge.
// Each page prints its adapter, three's backend and its contexts; a page that is not on real WebGPU fails loudly, it never passes on the fallback.
// Why build-time rewrites: test pages say forceWebGL: true so that headless runs agree, and that one word would hide the whole point of this run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { build } from 'vite';
import { withBrowser, buildAndPreview, launchRealGPU, newGamePage, IGNORED_CONSOLE, TOOL_BUILD, collect, specContext } from './browser.mjs';
import { viteOptions, ENGINE } from './paths.mjs';
import { workspaceSpecs } from './lib/specs.mjs';
import { waitEngine, waitLoaded } from './wait-engine.mjs';

process.env.THREEDOG_TEST = '1';   // the build then holds tests/<name>/index.html too
const args = process.argv.slice(2);
const value = k => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = k => args.includes(`--${k}`);
const words = args.filter(a => !a.startsWith('--'));
const dir = resolve(value('game') ?? ENGINE), shots = value('shots');
const urls = value('urls')?.split(',');

/** Before any page script: what the page really got from the browser, whichever renderer object made it (test pages keep theirs private) */
function gpuProbe() {
  const log = window.__gpu = { adapters: [], devices: 0, contexts: {}, errors: [], lost: [] };
  // the page's own listener counts (lifetime tests) wrap this later: the probe's listener is not the page's
  const listen = EventTarget.prototype.addEventListener;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    const c = getContext.call(this, type, ...a);
    if (c) log.contexts[type] = (log.contexts[type] ?? 0) + 1;
    return c;
  };
  const requestAdapter = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = async function (...a) {
    const adapter = await requestAdapter.apply(this, a);
    if (!adapter) return adapter;
    const i = adapter.info;
    log.adapters.push({ vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, fallback: !!(i.isFallbackAdapter ?? adapter.isFallbackAdapter) });
    const requestDevice = adapter.requestDevice;
    adapter.requestDevice = async function (...d) {
      const device = await requestDevice.apply(this, d);
      log.devices++;
      // a validation error does not throw: the frame is dropped and the page goes on, so this is the only place it shows
      listen.call(device, 'uncapturederror', e => { if (log.errors.length < 20) log.errors.push(e.error.message.slice(0, 400)); });
      device.lost.then(l => { if (l.reason !== 'destroyed') log.lost.push(`${l.reason}: ${l.message}`); });   // destroyed: the page's own dispose()
      return device;
    };
    return adapter;
  };
  window.__glRows = async (renderer, read, rt, x, y, w, h) => {
    const b = await read;
    if (!renderer.backend?.isWebGPUBackend) return b;
    const row = b.length / h, out = new b.constructor(b.length);
    for (let i = 0; i < h; i++) out.set(b.subarray(i * row, (i + 1) * row), (h - 1 - i) * row);
    return out;
  };
  window.__t = {
    async warns(fn) {
      const warns = [], orig = console.warn;
      console.warn = (...a) => warns.push(a.map(String).join(' '));
      try { return { value: await fn(), warns }; } finally { console.warn = orig; }
    },
    pixelReads: 0,
    frames: (n = 2) => new Promise(r => { let k = 0; const h = window.engine.onFrame(() => { if (++k >= n) { h.remove(); r(); } }); }),
    async until(cond, ms = 10000) {
      const end = performance.now() + ms;
      while (performance.now() < end) { const v = await cond(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`__t.until: condition not met within ${ms} ms: ${String(cond).slice(0, 80)}`);
    },
  };
}

const rewrites = {
  name: 'real-webgpu-rewrites', enforce: 'pre',
  transform(code, id) {
    if (!/\.m?js$/.test(id.split('?')[0]) || /node_modules/.test(id) || !/[\\/](tests|examples)[\\/]|[\\/]games[\\/]/.test(id)) return null;
    let out = code.replace(/\bforceWebGL:\s*true\b(?! \/\* kept \*\/)/g, 'forceWebGL: false')
      // WebGL reads rows bottom-up, a WebGPU target top-down: pages compare the two buffers pixel by pixel
      .replace(/([\w.]+)\.readRenderTargetPixelsAsync\(([^()]*)\)/g, 'window.__glRows($1, $1.readRenderTargetPixelsAsync($2), $2)');
    // these pages take navigator.gpu away so the renderer lands on WebGL2 on every machine; pages that test the fallback itself keep doing it
    if (/[\\/](sky-tsl|sky-hooks-tsl|recipe-56)[\\/]/.test(id)) out = out.replace(/Object\.defineProperty\(navigator, 'gpu', \{ value: undefined, configurable: true \}\);/g, '');
    if (flag('all-webgpu') && /createEngine\(\{/.test(out) && !/renderer\s*[:,]/.test(out)) out = `import 'threedog/tsl';\n${out.replace(/createEngine\(\{/g, "createEngine({ renderer: 'webgpu', ")}`;
    return out === code ? null : { code: out, map: null };
  },
};

/** What the page got, as one line of facts plus whether it counts as real WebGPU */
async function verdict(page, { demand = true, strict = false, expected = null } = {}) {
  const g = await page.evaluate(() => ({
    ...window.__gpu,
    gpuApi: !!navigator.gpu,
    described: window.engine?.describe?.().renderer ?? null,
  }));
  const a = g.adapters[0];
  if (expected) g.errors = g.errors.filter(m => !expected.test(m));   // a test that breaks a shader on purpose names what the device says about it
  const why = [];
  if (demand) {
    if (!g.gpuApi) why.push('navigator.gpu missing');
    if (!g.devices) why.push('no GPUDevice was made');
    if (strict && !g.contexts.webgpu) why.push('no webgpu canvas context');   // only a game page must have one: many test pages draw into a render target
    if (a && (a.fallback || /swiftshader|software|basic render/i.test(`${a.description} ${a.vendor} ${a.architecture}`))) why.push('software adapter');
    // test pages hold a WebGL engine beside the WebGPU renderer to compare pictures, so describe() only counts on a game page
    if (strict && g.described && g.described.backend !== 'webgpu') why.push(`describe() says ${g.described.backend} (${g.described.reason})`);
  }
  if (g.errors.length) why.push(`${g.errors.length} GPU validation error(s): ${g.errors[0]}`);
  if (g.lost.length) why.push(`device lost: ${g.lost[0]}`);
  return { why, line: `adapter=${a ? `${a.vendor}/${a.architecture}${a.description ? ` (${a.description})` : ''}` : 'none'} backend=${g.described?.backend ?? 'page-owned'} contexts=${JSON.stringify(g.contexts)} devices=${g.devices}` };
}

/** A fresh page with the probe and the GPU warnings Chrome only prints to the console */
async function open(browser, errors, gpuWarnings) {
  const page = await newGamePage(browser, { errors, locale: 'zh-CN' });
  await page.addInitScript(gpuProbe);
  page.on('console', m => { if (m.type() === 'warning' && /WGSL|\bGPU[A-Z]|\[Invalid/.test(m.text()) && !IGNORED_CONSOLE.test(m.text())) gpuWarnings.push(m.text().slice(0, 300)); });
  // the console line names no file and a missing favicon gives one on every page; a real 404 is named below
  page.on('console', () => { for (let i = errors.length - 1; i >= 0; i--) if (/^Failed to load resource.* 404/.test(errors[i])) errors.splice(i, 1); });
  page.on('response', r => { if (r.status() === 404 && !/favicon/.test(r.url())) gpuWarnings.push(`404 ${r.url()}`); });
  return page;
}

const report = (ok, name, line, details) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${line}`);
  for (const d of details) console.log(`      ! ${d}`);
};

let failed = 0, skipped = 0;
async function runSpec(browser, server, spec) {
  const errors = [], gpuWarnings = [], { results, check } = collect();
  const page = await open(browser, errors, gpuWarnings);
  let facts = { why: ['page never opened'], line: '' };
  try {
    await page.goto(server.base + spec.url);
    await waitEngine(page, { timeout: 60000, errors });
    // a real GPUDevice comes later than the fallback's: the page's test function is defined after `await renderer.init()`, past the moment the engine is ready
    const ev = async (fn, arg) => {
      for (let i = 0; ; i++) {
        try { return await page.evaluate(fn, arg); } catch (e) { if (i > 100 || !/is not a function/.test(e.message)) throw e; await page.waitForTimeout(300); }
      }
    };
    await Promise.race([
      spec.run(specContext(page, check, ev)),
      new Promise((_, no) => setTimeout(() => no(new Error('spec timed out after 150 s')), 150000).unref()),
    ]);
  } catch (e) { check('run error', false, String(e).split('\n')[0]); }
  facts = await verdict(page, { expected: spec.expectErrors }).catch(e => ({ why: [`page gone: ${e.message.split('\n')[0]}`], line: '' }));
  const unexpected = spec.expectErrors ? errors.filter(m => !spec.expectErrors.test(m)) : errors;
  const warned = spec.expectErrors ? gpuWarnings.filter(m => !spec.expectErrors.test(m)) : gpuWarnings;
  const bad = [...facts.why.map(w => `NOT REAL WEBGPU OR GPU ERROR: ${w}`), ...results.filter(r => !r.ok).map(r => `${r.label} ${String(r.detail).slice(0, 500)}`), ...unexpected.slice(0, 3).map(e => `console: ${e.slice(0, 300)}`), ...[...new Set(warned)].slice(0, 3).map(w => `gpu warning: ${w}`)];
  failed += bad.length ? 1 : 0;
  report(!bad.length, `${spec.name} [${results.filter(r => r.ok).length}/${results.length}]`, facts.line, bad);
  await page.close().catch(() => {});
}

async function runUrl(browser, server, url) {
  const errors = [], gpuWarnings = [];
  const page = await open(browser, errors, gpuWarnings);
  const bad = [];
  let facts = { why: [], line: '' };
  try {
    await page.goto(server.base + url);
    await waitEngine(page, { timeout: 90000, errors });
    await waitLoaded(page).catch(e => bad.push(e.message.split('\n')[0]));
    await page.evaluate(() => window.engine.ui?.settled?.());
    await page.evaluate(() => Promise.race([window.__t.frames(10), new Promise(r => setTimeout(r, 5000))]));   // a test page may have paused the engine
    if (value('eval')) console.log(`      eval: ${JSON.stringify(await page.evaluate(readFileSync(value('eval'), 'utf8')))}`);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, `${url.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'index'}${flag('webgl') ? '.webgl' : ''}.png`), await page.screenshot());
    }
    facts = await verdict(page, { demand: !flag('webgl'), strict: !/^\/tests\//.test(url) });
  } catch (e) { bad.push(String(e).split('\n')[0]); }
  bad.push(...facts.why, ...errors.slice(0, 3).map(e => `console: ${e.slice(0, 300)}`), ...[...new Set(gpuWarnings)].slice(0, 3).map(w => `gpu warning: ${w}`));
  failed += bad.length ? 1 : 0;
  report(!bad.length, url, facts.line, bad);
  await page.close().catch(() => {});
}

if (!flag('no-build')) await build(await viteOptions(dir, { plugins: flag('webgl') ? [] : [rewrites], build: TOOL_BUILD, logLevel: 'error' }));
if (!existsSync(join(dir, TOOL_BUILD.outDir))) throw new Error(`${dir} has no ${TOOL_BUILD.outDir}: drop --no-build`);
await withBrowser(async ({ server, launch }) => {
  const browser = await launch();
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  console.log(`system Chrome ${browser.version()} pid ${processInfo.find(p => p.type === 'browser')?.id} on ${basename(dir)}, served at ${server.base}`);
  if (urls) for (const u of urls) await runUrl(browser, server, u);
  else {
    const specs = (await workspaceSpecs(dir)).map(x => x.spec).filter(s => !words.length || words.some(w => `${s.name} ${s.url}`.toLowerCase().includes(w.toLowerCase())));
    if (!specs.length) throw new Error(`no test name holds: ${words.join(', ')}`);
    for (const s of specs) {
      if (s.notRealWebGPU) { skipped++; console.log(`SKIP  ${s.name}\n      ${s.notRealWebGPU}`); } else await runSpec(browser, server, s);
    }
  }
}, { exitOnFail: true, launch: () => launchRealGPU({ headless: !flag('headed') }), server: () => buildAndPreview(dir, { build: false }) });
console.log(`${failed ? `\n${failed} page(s) FAILED` : '\nall pages passed on real WebGPU'}${skipped ? `, ${skipped} skipped by their spec` : ''}`);
process.exitCode = failed ? 1 : 0;
