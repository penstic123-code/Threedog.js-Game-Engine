// [guard] Every module list the docs, templates and examples show installs what each module requires. Why: a fresh AI copies the list it sees; a module
// whose dependency was missing from it (characters() without world()) failed only later, at addPlayer, although engine.use() checks requires at install.
// One rule for the whole class: a module declares what it always needs in `requires` (checked by use()), and every list shown to a game author satisfies it.
// Per file, not per call: a recipe often installs in two steps (engine.use(world()) above, engine.use(characters()) later in the same page).
// Run in Node against the real factories: what is under test is the declared requires against the shown lists, not drawing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE, ROOT } from '../paths.mjs';

export const name = 'module lists: every engine.use list in docs, templates and examples installs what its modules require';

const engine = await import(pathToFileURL(join(ENGINE, 'index.js')).href);
/** factory name -> module definitions it returns (terrain() gives terrain and terrainDraw) */
const defsOf = new Map();
for (const [k, f] of Object.entries(engine)) {
  if (typeof f !== 'function' || /^[A-Z]/.test(k)) continue;
  let r; try { r = k === 'openWorld' ? f({ camera: false }) : f(); } catch { continue; }
  const defs = [r].flat(Infinity).filter(d => d && typeof d === 'object' && d.name && (d.install || d.label));
  if (defs.length) defsOf.set(k, defs);
}

const files = [];
const walk = dir => { for (const n of readdirSync(dir)) { if (n === 'node_modules' || n.startsWith('.')) continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p) : /\.(md|js|mjs)$/.test(n) && files.push(p); } };
for (const d of ['docs', 'modules', 'examples']) walk(join(ENGINE, d));
walk(join(ROOT, 'packages/tools/templates'));

/** The factory names called inside every `.use(...)` of a text (balanced parentheses, so options with calls inside stay in one list) */
function usedFactories(text) {
  const out = [];
  for (const m of text.matchAll(/\.use\(/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
    for (const c of text.slice(m.index + m[0].length, i).matchAll(/\b([a-z]\w*)\(/g)) if (defsOf.has(c[1])) out.push(c[1]);
  }
  return out;
}

export function run({ check }) {
  const bad = [];
  let lists = 0;
  for (const f of files) {
    const used = usedFactories(readFileSync(f, 'utf8'));
    if (!used.length) continue;
    lists++;
    const defs = used.flatMap(u => defsOf.get(u));
    const gives = new Set(defs.flatMap(d => [d.name, ...(d.provides ?? [])]));
    for (const d of defs) for (const dep of d.requires ?? []) if (!gives.has(dep)) bad.push(`${relative(ROOT, f)}: ${d.name} requires '${dep}', which no module in its engine.use lists gives`);
  }
  check('the scan found module lists to read (else this guard reads nothing)', lists > 20, String(lists));
  check('every shown module list installs what its modules require', !bad.length, [...new Set(bad)].join('\n'));
  // the rule itself: what a module always needs is declared, so use() names it at install (characters: the player and NPCs are world records)
  check("characters() requires world (the player and NPCs are world records)", defsOf.get('characters')[0].requires?.includes('world'));
}
