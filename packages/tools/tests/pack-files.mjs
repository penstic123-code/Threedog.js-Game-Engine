// Published packages carry every file their shipped code loads. For each package: ask npm what it would publish (npm pack --dry-run), follow each
// relative import, import(), new URL('./…') and src="./…" in the shipped .js/.mjs/.html, and fail on a target that exists here but is not in the tarball;
// also every bin / exports / main / types target is in it.
// Why: a folder left out of package.json "files" works in this repository (the file is on disk) and breaks only after npm install. 2.2.0 shipped
// without tools/expect/, so `threedog check` crashed on load for every user. pack-external catches this too but is opt-in (minutes, network); this is
// seconds and runs in every full suite. Paths built at run time (`rules/${name}`) are not followed: their folders are covered by the folder itself shipping.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { ENGINE, TOOLS, addonDir } from '../paths.mjs';
import { npm } from '../lib/proc.mjs';

export const name = 'pack files: every npm package ships the files its code imports and its bin / exports point at';

const REF = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*|\bsrc=)['"`](\.{1,2}\/[^'"`$]+)['"`]/g;
const ENV = { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };   // npm's update check alone took ~25 s here

/** The paths npm would publish for the package in dir, '/'-separated */
function shippedFiles(dir) {
  const r = npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed in ${dir}: ${(r.stderr || String(r.error)).slice(0, 300)}`);
  return new Set(JSON.parse(r.stdout)[0].files.map(f => f.path.replace(/\\/g, '/')));
}

/** Relative references from shipped code to files on disk that are not shipped: "target <- referencing file" */
function unshippedRefs(dir, shipped) {
  const out = new Map();
  for (const f of shipped) {
    if (!/\.(mjs|js|cjs|html)$/.test(f)) continue;
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(REF)) {
      const abs = resolve(dir, dirname(f), m[1].split('?')[0]);
      const tries = [abs, abs + '.js', abs + '.mjs'];
      if (!tries.some(existsSync)) continue;   // text that looks like a path (a template, an example in a comment)
      const rel = relative(dir, abs).replace(/\\/g, '/');
      if (rel.startsWith('..')) { out.set(rel, `${f} (outside the package)`); continue; }
      if ([rel, rel + '.js', rel + '.mjs', rel + '/index.js'].some(c => shipped.has(c))) continue;
      if (statSync(tries.find(existsSync)).isDirectory() && [...shipped].some(s => s.startsWith(rel + '/'))) continue;
      if (!out.has(rel)) out.set(rel, f);
    }
  }
  return [...out].map(([t, f]) => `${t} <- ${f}`);
}

/** bin / exports / main / types targets (no wildcards) that are not shipped */
function unshippedEntries(dir, shipped) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), want = [];
  const walk = v => { if (typeof v === 'string') want.push(v.replace(/^\.\//, '')); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  [pj.bin, pj.exports, pj.main, pj.types].forEach(walk);
  return want.filter(w => !w.includes('*') && !shipped.has(w));
}

export async function run({ check }) {
  for (const dir of [ENGINE, TOOLS, addonDir('post-effects'), addonDir('terrain-noise')]) {
    const label = relative(join(ENGINE, '..', '..'), dir).replace(/\\/g, '/');
    const shipped = shippedFiles(dir);
    const refs = unshippedRefs(dir, shipped), entries = unshippedEntries(dir, shipped);
    check(`${label}: every file its shipped code imports is in the package`, refs.length === 0, `add to package.json "files": ${refs.slice(0, 5).join('; ')}`);
    check(`${label}: bin / exports / main / types targets are in the package`, entries.length === 0, entries.join(', '));
  }
}
