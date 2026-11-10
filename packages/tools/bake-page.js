// The headless page opened by npm run bake (packages/tools/bake.mjs opens it with Playwright through the workspace's vite dev server, so generated code is identical to npm run dev).
// Collects what to bake (the lists come from the dev server's /__threedog/bake-lists): the bake list, i.e. the
//   bake = { name: () => object | { build, params, source: 'file' } } exported by files named bake.js in this workspace (except tests/).
//   Models from a game's picture/ folder are baked by naming them in that bake.js (pictures are not packages, so nothing exports `assets` to scan).
// For each entry it asks the dev server for the hash (same scheme as the automatic cache); if equal to the last bake it is skipped, otherwise it is generated and exported as GLB for bake.mjs to write.
import { assertUniqueBakeNames } from './bake-names.js';
const info = await fetch('/__threedog/bake-lists').then(r => r.json());
const { toGLB } = await import(/* @vite-ignore */ info.baked);

async function collect() {
  const items = [];
  for (const { url, from } of info.lists) {
    const mod = await import(/* @vite-ignore */ url);
    for (const [name, v] of Object.entries(mod.bake || {})) items.push({ name, ...(typeof v === 'function' ? { build: v } : v), from });
  }
  assertUniqueBakeNames(items);   // before any generator runs
  return items;
}
const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

// only: bake only these names (empty = all); index: the existing manifest (each entry has an extra exists meaning the file is still there)
window.threedogBake = async ({ only, index }) => {
  const items = await collect(), out = [];
  for (const it of items) {
    const old = index[it.name], params = it.params ?? null, src = String(it.build);
    const base = { name: it.name, from: it.from };
    if (only.length && !only.includes(it.name)) { out.push({ ...base, status: 'skip' }); continue; }
    if (it.source === 'file' && old?.exists) { out.push({ ...base, status: 'file' }); continue; }
    const { key } = await fetch('/__threedog/cache/key', { method: 'POST', body: JSON.stringify({ name: it.name, src, params }) }).then(r => r.json());
    if (old?.exists && old.key === key && JSON.stringify(old.params ?? null) === JSON.stringify(params)) { out.push({ ...base, status: 'same' }); continue; }
    const t0 = performance.now(), v = await it.build(...(params == null ? [] : [params]));
    const buf = await toGLB(v, it.name);
    out.push({ ...base, status: 'baked', key, src, params, source: it.source, ms: Math.round(performance.now() - t0), data: b64(buf) });
  }
  return out;
};
window.threedogBakeReady = true;
