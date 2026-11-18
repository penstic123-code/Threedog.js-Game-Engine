// Bundle size budget: the blank new-game template (templates/game), built for production on each route, must stay under a loose gzip ceiling for its JS.
// Why: every game starts from this build, so an engine import that drags a big dependency into core (or a module that stops tree-shaking) shows here
// first, long before a game notices a slow first load. The ceiling is the size measured when it was set plus ~25%; raise it only for a growth you meant.
// Each route has its own ceiling: a WebGPU game also carries three/webgpu and the engine's node parts, and that must not loosen the check on the engine core
// that WebGL games pay for (the core never imports threedog/tsl, so a WebGL game stays small).
// On failure the detail lists the largest source modules of the build (rendered bytes, before gzip), so what grew is visible without another tool.
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { metadata } from 'threedog/metadata';
import { ROOT, rel, viteOptions } from '../paths.mjs';
import { copyTemplates } from '../lib/scaffold.mjs';

/** gzip KB of all JS in dist/assets, lazy chunks included (navmesh wasm, draco decoder). WebGL: 899 KB measured 2026-11-02, + 25%. WebGPU: 1164 KB measured 2026-11-04, + 25% */
const CEILING_KB = { webgl: 1125, webgpu: 1455 };
/** gzip KB of the first load (the entry chunk and what it imports statically: what every player downloads before the first frame). Measured 2026-11-05: WebGL 475, WebGPU 689, + ~10%.
 *  2026-11-16 the starter picture wires ao() and bloom() (GTAOPass, UnrealBloomPass on WebGL): WebGL 522 -> 537 on purpose, so its ceiling moves by that growth
 *  2026-11-19 the 11-18 engine rounds (post.add key check, saves.list() summaries, audio.addNode and per-bus relink, shot points) add ~1 KB gzip to engine/core, all of it used by every game: WebGPU first load 760 -> 761 measured, ceiling 765 (not lazy-loadable: they are core API) */
const FIRST_KB = { webgl: 560, webgpu: 765 };

export const name = 'bundle size: the blank game template builds on each route and its JS stays under that route\'s gzip ceiling';

export async function run({ check }) {
  for (const route of /** @type {const} */ (['webgpu', 'webgl'])) await measure(check, route);
}

/** @param {any} check @param {'webgpu' | 'webgl'} route */
async function measure(check, route) {
  // inside the repo's .threedog so `threedog` and `@threedog/tools/vite` resolve through the root node_modules, as in a real game workspace
  const dir = join(ROOT, '.threedog', 'bundle-size');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    copyTemplates(dir, { name: 'sizecheck', webgl: route === 'webgl' });
    const { build } = await import('vite');
    const res = await build(await viteOptions(dir, { logLevel: 'error' }));
    const outputs = [res].flat().flatMap(r => r.output ?? []);
    const assets = join(dir, 'dist', 'assets'), js = readdirSync(assets).filter(f => f.endsWith('.js'));
    const sizes = js.map(f => ({ f, kb: gzipSync(readFileSync(join(assets, f))).length / 1024 })).sort((a, b) => b.kb - a.kb);
    const total = Math.round(sizes.reduce((s, x) => s + x.kb, 0));
    // first load = the entry chunk plus what it imports statically (lazy chunks load only when a game uses navmesh, draco ...)
    const chunks = new Map(outputs.filter(o => o.type === 'chunk').map(o => [o.fileName, o])), first = new Set();
    const walk = f => { if (first.has(f) || !chunks.has(f)) return; first.add(f); chunks.get(f).imports.forEach(walk); };
    for (const o of chunks.values()) if (o.isEntry) walk(o.fileName);
    const firstKb = Math.round(sizes.filter(x => first.has('assets/' + x.f)).reduce((s, x) => s + x.kb, 0));
    // the source modules with the most rendered code, grouped to a package or engine folder (three/examples/jsm, threedog/core, ...)
    const by = new Map();
    for (const o of outputs) for (const [id, m] of Object.entries(o.modules ?? {})) {
      const p = id.replace(/\\/g, '/'), k = p.match(/node_modules\/((?:@[^/]+\/)?[^/]+(?:\/[^/]+)?)/)?.[1] ?? p.match(/packages\/(.+?\/[^/]+)\//)?.[1] ?? p.split('/').slice(-2).join('/');
      by.set(k, (by.get(k) ?? 0) + m.renderedLength);
    }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, b]) => `${k} ${Math.round(b / 1024)} KB`).join(', ');
    check(`${route} template JS: ${total} KB gzip in ${js.length} file(s), first load ${firstKb} KB (ceilings ${CEILING_KB[route]} KB total, ${FIRST_KB[route]} KB first load)`, total <= CEILING_KB[route] && firstKb <= FIRST_KB[route],
      `largest chunks: ${sizes.slice(0, 4).map(x => `${x.f} ${Math.round(x.kb)} KB`).join(', ')}; largest sources (rendered, before gzip): ${top}. ` +
      `Look at what an import added (git diff of index.js / core imports); raise CEILING_KB / FIRST_KB in ${rel(join(import.meta.dirname, 'bundle-size.mjs'))} only for a growth you meant`);
    // the hints a system declares are for the tools: they stay in the source and never reach a player
    const leaked = Object.values(metadata.hints).filter(h => js.some(f => readFileSync(join(assets, f), 'utf8').includes(h.seen))).map(h => h.kind);
    check(`${route} template JS carries no hint text`, !leaked.length, leaked.join(', '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
