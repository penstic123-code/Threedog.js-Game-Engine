// [guard] Every module list the docs, templates, examples and engine tests show installs what each module requires. Why: a fresh AI copies the list it
// sees; a module whose dependency was missing from it (characters() without world()) failed only later, at addPlayer, although engine.use() checks
// requires at install. One rule for the whole class: a module declares what it always needs in `requires` (checked by use()), and every shown list satisfies it.
// In order, like use(): it checks one module at a time against what is installed and what comes before it in the same call, so
// engine.use(characters(), world()) throws. Earlier lists in the same file count as installed (a recipe installs in steps).
// A test that calls use() to see it refused marks that line with `module-lists: refused on purpose`. In tests/specs, `engine.use(...)` adds to the
// test page's engine, whose modules its tests/<page>/main.js installed (scanned too), so only engines a spec makes itself are read there: E.use(...), and make(...) (the specs' helper that builds a fresh engine with that list, after what its own body installs).
// Run in Node against the real factories: what is under test is the declared requires against the shown lists, not drawing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE, ROOT } from '../paths.mjs';

export const name = 'module lists: every engine.use list in docs, templates, examples and engine tests installs what its modules require, in order';

const engine = await import(pathToFileURL(join(ENGINE, 'index.js')).href);
/** factory name -> module definitions it returns (terrain() gives terrain and terrainDraw) */
const defsOf = new Map();
for (const [k, f] of Object.entries(engine)) {
  // createEngine is not a module factory: building one here (it throws in Node partway) leaves it counted page-wide (validate) for every later test
  if (typeof f !== 'function' || /^[A-Z]/.test(k) || k === 'createEngine') continue;
  let r; try { r = k === 'openWorld' ? f({ camera: false }) : f(); } catch { continue; }
  const defs = [r].flat(Infinity).filter(d => d && typeof d === 'object' && d.name && (d.install || d.label));
  if (defs.length) defsOf.set(k, defs);
}

const files = [];
const walk = dir => { for (const n of readdirSync(dir)) { if (n === 'node_modules' || n.startsWith('.')) continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p) : /\.(md|js|mjs)$/.test(n) && files.push(p); } };
for (const d of ['docs', 'modules', 'examples', 'tests']) walk(join(ENGINE, d));
walk(join(ROOT, 'packages/tools/templates'));

/** Every `.use(...)` of a text in order, each as the factory names called inside it (balanced parentheses, so options with calls inside stay in one list) */
function useCalls(text, pageEngine) {
  const out = [];
  for (const m of text.matchAll(/(?:(\w+)\.use|\b(make))\(/g)) {
    if (pageEngine && m[1] === 'engine') continue;
    const start = text.lastIndexOf('\n', m.index) + 1, end = text.indexOf('\n', m.index);
    if (text.slice(start, end < 0 ? text.length : end).includes('module-lists: refused on purpose')) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
    const names = [...text.slice(m.index + m[0].length, i).matchAll(/\b([a-z]\w*)\(/g)].map(c => c[1]).filter(n => defsOf.has(n));
    if (names.length) out.push({ names, fresh: !!m[2] });
  }
  return out;
}

export function run({ check }) {
  const bad = [];
  let lists = 0;
  for (const f of files) {
    const calls = useCalls(readFileSync(f, 'utf8'), /[\\/]tests[\\/]specs[\\/]/.test(f));
    if (!calls.length) continue;
    lists++;
    const gives = new Set();   // what is installed so far in this file, in use() order
    const text = readFileSync(f, 'utf8'), def = text.search(/const make = /);
    // a make helper that installs a base list itself (E.use(terrain(), collision(), ...mods)): every make(...) starts from that base
    const base = def < 0 ? [] : (useCalls(text.slice(def, def + 600), false).find(c => !c.fresh)?.names ?? []).flatMap(u => defsOf.get(u)).flatMap(d => [d.name, ...(d.provides ?? [])]);
    for (const call of calls) for (const d of (call.fresh && (gives.clear(), base.forEach(g => gives.add(g))), call.names).flatMap(u => defsOf.get(u))) {
      for (const dep of d.requires ?? []) if (!gives.has(dep)) bad.push(`${relative(ROOT, f)}: ${d.name} requires '${dep}', which nothing before it in the file's engine.use lists gives`);
      for (const g of [d.name, ...(d.provides ?? [])]) gives.add(g);
    }
  }
  check('the scan found module lists to read (else this guard reads nothing)', lists > 20, String(lists));
  check('every shown module list installs what its modules require, in use() order', !bad.length, [...new Set(bad)].join('\n'));
  // the rule itself: what a module always needs is declared, so use() names it at install (characters: the player and NPCs are world records)
  check("characters() requires world (the player and NPCs are world records)", defsOf.get('characters')[0].requires?.includes('world'));
}
