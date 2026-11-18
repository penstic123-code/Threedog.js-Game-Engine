// vite preset: each workspace's (engine package, each game) vite.config.js is a single line:
//   import { gameConfig } from '@threedog/tools/vite';
//   export default gameConfig(import.meta.dirname);
// What it does:
//   · multi-page entry: collects the *.html in the directory automatically (index.html → main, or index when a main.html has that name; the rest by file name), so a new page needs no manual input
//   · when running tests (THREEDOG_TEST, set by npm test / npm run shot / npm run perf) it also adds the tests/<name>/index.html test pages
//   · cache directory .threedog/vite; errorRelay: during development sends browser errors to the terminal and this directory's .threedog/errors.log; threedogBridge: the dev bridge (threedog describe|step|press…, dev only); threedogCache: automatic cache for generated models and the stale-bake check (.threedog/cache); threedogContentSrc: content/*.js line tables for "defined in file:line" (dev and test builds only); threedogLive: shader hot reload of ?raw .glsl/.vert/.frag files with file:line errors, the dev panel's tune write-back endpoint (dev only); threedogPanel: the dev panel's optional tweakpane, and a production build never bundles @threedog/tools/panel (vite-threedog-panel.js); threedogEditor: the in-browser editor (F2 or ?edit=1) and its write-back endpoint (dev only, vite-threedog-editor.js)
//   · threedogMap: keeps GAMEMAP.md current while dev runs (vite-threedog-map.js; check only compares, so a stale commit still fails it)
//   · threedogPlugins: a page with a plugins/ folder next to its html gets every file in it plugged at engine.start() (vite-threedog-plugins.js, engine.plugins)
//   · threedogThree: dev and test pages hold three.js for the picture probe and in-page test code, under a private name (vite-threedog-three.js)
//   · turns on import.meta.env.THREEDOG_TEST (test builds also enable the development-time checks), and Workers as ES modules
// extra goes through vite's mergeConfig: its plugins come after these, its objects merge, its plain values win.
import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import errorRelay from './vite-error-relay.js';
import threedogBridge from './vite-threedog-bridge.js';
import threedogCache from './vite-threedog-cache.js';
import threedogContentSrc from './vite-threedog-content-src.js';
import threedogLive from './vite-threedog-live.js';
import threedogPanel from './vite-threedog-panel.js';
import threedogPlugins from './vite-threedog-plugins.js';
import threedogMap from './vite-threedog-map.js';
import threedogEditor from './vite-threedog-editor.js';
import threedogThree from './vite-threedog-three.js';

/** The pages a directory builds: { entry name: absolute html path } */
function pagesOf(dir) {
  const input = {};
  const html = readdirSync(dir).filter(f => f.endsWith('.html')).sort();
  for (const f of html) input[f === 'index.html' && !html.includes('main.html') ? 'main' : f.slice(0, -5)] = resolve(dir, f);
  const tests = resolve(dir, 'tests');
  if (process.env.THREEDOG_TEST && existsSync(tests)) for (const d of readdirSync(tests, { withFileTypes: true })) {
    const html = resolve(tests, d.name, 'index.html');
    if (d.isDirectory() && existsSync(html)) input['test-' + d.name] = html;
  }
  return input;
}

export function gameConfig(dir, extra = {}) {
  return defineConfig(mergeConfig({
    root: dir,
    cacheDir: resolve(dir, '.threedog/vite'),   // the dependency pre-bundle cache also goes in this workspace's .threedog/ (no node_modules is created in the game directory)
    plugins: [errorRelay(), threedogBridge(), threedogCache(), threedogContentSrc(), threedogLive(), threedogPanel(), threedogPlugins(), threedogMap(), threedogEditor(), threedogThree()],
    optimizeDeps: { exclude: ['@threedog/tools'] },   // the dev panel imports a virtual module of threedogPanel, which the dependency pre-bundler cannot see
    define: { 'import.meta.env.THREEDOG_TEST': JSON.stringify(!!process.env.THREEDOG_TEST) },
    // hot update only after a saved file stops changing: an editor or a tool that writes in chunks otherwise has the half-written file loaded (and its error counted)
    server: { watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 } } },
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 2000, outDir: resolve(dir, 'dist'), emptyOutDir: true, rollupOptions: { input: pagesOf(dir) } },
  }, extra));
}

export default gameConfig;
