// Layer scan: measures which layer depends on which, from the syntax tree, and fills the generated block of the audit's layer-inventory.md.
//   node packages/tools/layer-scan.mjs           rewrite the block
//   node packages/tools/layer-scan.mjs --dry     print it, write nothing
//   node packages/tools/layer-scan.mjs --check   write nothing, fail on a member read across folders that no page, contract or @internal states, and on a private read across layers that KNOWN_PRIVATE does not list (tools test module boundaries)
// Why not R25 / R27 / R46: those are gates with allowlists, each matching a few receiver spellings (`e.x._y`, one alias hop), so a green check says nothing about
// what sits outside the pattern. This counts everything, allowlisted or not, and a person decides what is a violation. The report itself fails nothing; only --check does, and only on what is new.
// A private member is `x._name` with `x` not `this`. Its owner is the folder that assigns or declares `_name`; a name declared in several folders counts as
// "own" when the reader is one of them, so a reach between two same-named privates is missed. Written limit, not a proof of absence.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ts, parse, visit, lineOf, walk, abs, resolveImport, isGeneratedFile, P } from './rules/_lib.mjs';
import { cli } from './paths.mjs';

const { opt } = cli(process.argv.slice(2), { workspace: false, flags: ['dry', 'check'] });
const DOC = 'docs/testing/review/2026-11-07-1.0-audit/layer-inventory.md';
const START = '<!-- layer-scan:generated:start -->', END = '<!-- layer-scan:generated:end -->';
const E = P.ENGINE_REL, short = f => f.replace(`${E}/`, '');
const { metadata } = await import(pathToFileURL(abs(P.METADATA_REL)).href);

/** The layer a file belongs to; core splits by folder because the inventory asks about each part of it */
function layerOf(f) {
  const s = short(f);
  if (s === 'index.js' || s === 'presets.js') return 'entry';
  let m;
  if ((m = /^core\/([^/]+)\//.exec(s))) return `core/${m[1]}`;
  if (s.startsWith('render/')) return 'render';
  if (s.startsWith('ui/')) return 'ui';
  if ((m = /^modules\/([^/]+)\//.exec(s))) return `modules/${m[1]}`;
  if (s.startsWith('examples/')) return 'examples';
  if (f.startsWith(`${P.TOOLS_REL}/templates/`)) return 'templates';
  if (f.startsWith(`${P.TOOLS_REL}/`)) return 'tools';
  if ((m = /^packages\/([^/]+)\//.exec(f))) return `pkg/${m[1]}`;
  return 'other';
}
const band = l => l.startsWith('modules/') ? 'modules' : l.startsWith('core/') ? 'core' : l.startsWith('pkg/') ? 'addons' : l;

const engineCode = [`${E}/index.js`, `${E}/presets.js`, ...P.ENGINE_CODE_DIRS_REL.flatMap(d => walk(d))];
const outside = [...walk(`${E}/examples`, ['.js', '.mjs']), ...walk(P.TOOLS_REL, ['.js', '.mjs']).filter(f => !f.includes('/tests/') && !f.includes('/node_modules/')),
  ...['post-effects', 'starter-pictures', 'terrain-noise'].flatMap(p => walk(`packages/${p}`, ['.js', '.mjs']).filter(f => !f.includes('/node_modules/')))];
const files = [...new Set([...engineCode, ...outside])].filter(f => !isGeneratedFile(f));
const trees = new Map(files.map(f => [f, parse(f)]));

// 1. Imports. One edge per import statement; `import type` and JSDoc imports are not dependencies at run time and are not counted
const edges = [], external = new Map();
for (const [f, sf] of trees) visit(sf, n => {
  let spec = null;
  if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) spec = n.moduleSpecifier.text;
  else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) spec = n.arguments[0].text;
  if (!spec) return;
  const to = resolveImport(f, spec), from = layerOf(f);
  if (to) { const target = layerOf(to); if (target !== from) edges.push({ from, to: target, file: f, line: lineOf(n), spec, target: to }); return; }
  if (!spec.startsWith('.') && !spec.startsWith('node:')) {
    const pkg = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
    const key = `${band(from)} -> ${pkg}`;
    external.set(key, (external.get(key) ?? 0) + 1);
    if (spec.startsWith(`${P.ENGINE_PKG}/`)) edges.push({ from, to: 'engine-subpath', file: f, line: lineOf(n), spec, target: spec });
  }
});

// 2. Who declares each private name
const declared = new Map();
const note = (name, f) => { const k = layerOf(f); if (!declared.has(name)) declared.set(name, new Set()); declared.get(name).add(k); };
for (const [f, sf] of trees) visit(sf, n => {
  if ((ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && n.name?.getText().startsWith('_')) note(n.name.getText(), f);
  if (ts.isPropertyAssignment(n) && n.name?.getText().startsWith('_')) note(n.name.getText(), f);
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(n.operatorToken.kind) && ts.isPropertyAccessExpression(n.left) && n.left.name.text.startsWith('_')) note(n.left.name.text, f);
});
const reaches = [], foreign = [], innerReach = [];
const inner = l => /^(core|render|ui)\b/.test(l);
for (const [f, sf] of trees) visit(sf, n => {
  if (!ts.isPropertyAccessExpression(n) || !n.name.text.startsWith('_') || n.expression.kind === ts.SyntaxKind.ThisKeyword) return;
  const name = n.name.text, from = layerOf(f), owners = declared.get(name);
  const row = { from, name, file: f, line: lineOf(n), text: n.getText().slice(0, 48).replace(/\s+/g, ' ') };
  if (!owners) foreign.push(row);   // nobody in the repo declares it: three.js, Rapier, the browser, or a name made by a computed write
  else if (owners.has(from)) return;
  else if ([...owners].some(inner) && inner(from)) innerReach.push({ ...row, owner: [...owners].join('+') });   // core, render and ui are one layer by design: counted apart
  else reaches.push({ ...row, owner: [...owners].join('+') });
});

// 3. Core, render and ui naming a module. Every spelling, not only the three receivers R27 reads: strings too, because engine.has('terrain') and a table key are the same knowledge
const moduleNames = new Set(Object.keys(metadata.modules ?? {}));
const capNames = new Set(Object.values(metadata.modules ?? {}).flatMap(m => m.provides ?? []));
const names = new Set([...moduleNames, ...capNames]);
const WORDS_THAT_ARE_ALSO_ENGLISH = new Set(['content', 'camera', 'level', 'world', 'ground', 'picture', 'lights', 'debug', 'tone']);
const known = [];
for (const [f, sf] of trees) {
  if (!/^(core|render|ui)\b/.test(layerOf(f))) continue;
  visit(sf, n => {
    if (ts.isPropertyAccessExpression(n) && names.has(n.name.text) && /^(?:e|engine|this\.e|this\.engine|this\._engine|this\.engine\?|ctx\.engine)$/.test(n.expression.getText()))
      known.push({ file: f, line: lineOf(n), how: 'prop', name: n.name.text, text: n.getText() });
    if (ts.isStringLiteralLike(n) && names.has(n.text)) {
      const p = n.parent;
      if (ts.isImportDeclaration(p)) return;
      known.push({ file: f, line: lineOf(n), how: 'string', name: n.text, text: p.getText().slice(0, 70).replace(/\s+/g, ' ') });
    }
  });
}

// 4. One module reading another: which members, and whether a game could see them too. A member that is not in the public surface is a contract only by habit
const surface = readFileSync(abs('docs/api-surface.txt'), 'utf8');
const inSurface = (mod, member) => new RegExp(`\\b${mod}\\.${member}\\b`).test(surface) || new RegExp(`\\.${member}\\b`).test(surface);
const decl = new Map(Object.entries(metadata.modules ?? {}).map(([k, m]) => [k, m]));
const folderOfModule = new Map();
for (const [f, sf] of trees) {
  const l = layerOf(f);
  if (!l.startsWith('modules/')) continue;
  const folder = l.slice(8);
  visit(sf, n => { if (ts.isPropertyAssignment(n) && n.name?.getText() === 'name' && ts.isStringLiteralLike(n.initializer) && decl.has(n.initializer.text)) folderOfModule.set(n.initializer.text, folder); });
}
const ownFolder = name => folderOfModule.get(name) ?? [...decl].find(([, m]) => (m.provides ?? []).includes(name))?.[0];
const cross = new Map(), undeclared = new Map();
for (const [f, sf] of trees) {
  const l = layerOf(f);
  if (!l.startsWith('modules/')) continue;
  const folder = l.slice(8);
  const mine = [...decl].filter(([k]) => folderOfModule.get(k) === folder).map(([, m]) => m);
  const listed = new Set(mine.flatMap(m => [...(m.requires ?? []), ...(m.optional ?? []), ...(m.provides ?? [])]));
  visit(sf, n => {
    if (!ts.isPropertyAccessExpression(n) || !/^(?:e|engine|this\.e|this\.engine)$/.test(n.expression.getText().replace(/\?$/, '')) || !names.has(n.name.text)) return;
    const owner = folderOfModule.get(ownFolder(n.name.text)) ?? ownFolder(n.name.text) ?? n.name.text;
    if (owner === folder) return;
    if (!listed.has(n.name.text) && mine.length) { const k = `${folder} -> ${n.name.text}`; if (!undeclared.has(k)) undeclared.set(k, `${short(f)}:${lineOf(n)}`); }
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      const member = p.name.text, k = `${n.name.text}.${member}`;
      if (!cross.has(k)) cross.set(k, { readers: new Set(), site: `${short(f)}:${lineOf(p)}`, pub: inSurface(n.name.text, member) });
      cross.get(k).readers.add(folder);
    }
  });
}

// Report
const at = r => `${short(r.file)}:${r.line}`;
const list = (rows, cap = 12) => rows.slice(0, cap).map(at).join(', ') + (rows.length > cap ? `, and ${rows.length - cap} more` : '');
const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)).push(r); } return [...m].sort((a, b) => b[1].length - a[1].length); };
const out = [`${files.length} source files read (generated files left out; tests left out).`, ''];

out.push('### L1. Import edges between bands (run-time imports, one per statement)', '', '| From | To | Count | Sites |', '|---|---|---|---|');
for (const [k, rows] of group(edges.filter(e => band(e.from) !== band(e.to)), e => `${band(e.from)} -> ${band(e.to)}`)) { const [a, b] = k.split(' -> '); out.push(`| ${a} | ${b} | ${rows.length} | ${list(rows, 4)} |`); }

out.push('', '### L2. Inside core: which part imports which part', '', 'Row imports column. An upward arrow on the list `base < time, input, ... < engine` is shown in the table below it.', '', '| From | Imports (count) |', '|---|---|');
for (const [k, rows] of group(edges.filter(e => e.from.startsWith('core/')), e => e.from)) out.push(`| ${k} | ${group(rows, e => e.to).map(([t, r]) => `${t.replace('core/', '')} ${r.length}`).join(', ')} |`);
out.push('', '`core/base` importing anything above it:', '');
for (const r of edges.filter(e => e.from === 'core/base')) out.push(`- ${at(r)} -> ${short(r.target)}`);

out.push('', '### L3. Module folder importing another module folder', '', '| From | To | Site |', '|---|---|---|');
for (const r of edges.filter(e => e.from.startsWith('modules/') && e.to.startsWith('modules/'))) out.push(`| ${r.from} | ${r.to} | ${at(r)} |`);

out.push('', '### L4. Third-party packages by band', '', '| Edge | Imports |', '|---|---|');
for (const [k, c] of [...external].sort()) if (!k.includes('@threedog/') && !/^tools/.test(k)) out.push(`| ${k} | ${c} |`);

out.push('', '### L5. Outside packages reaching engine files', '', 'Subpath imports of the engine, by importer band. Each must be listed in `packages/engine/package.json` `exports`, or it would not resolve for a game.', '', '| From | Subpath | Count |', '|---|---|---|');
for (const [k, rows] of group(edges.filter(e => e.to === 'engine-subpath' && !/^(core|modules|render|ui)/.test(e.from)), e => `${band(e.from)} | ${e.spec}`)) out.push(`| ${k.replace(' | ', ' | `')}\` | ${rows.length} |`);
const deep = edges.filter(e => band(e.from) !== 'modules' && !/^(core|render|ui|entry)/.test(e.from) && /^(core|render|ui|modules)/.test(e.to) && e.spec.startsWith('.'));
const named = edges.filter(e => band(e.from) !== 'modules' && !/^(core|render|ui|entry)/.test(e.from) && /^(core|render|ui|modules)/.test(e.to) && !e.spec.startsWith('.'));
out.push('', `Through a named exports subpath: ${named.length} (${[...new Set(named.map(e => e.spec))].join(', ')}). Reaching engine source by relative path: ${deep.length}.`, '');
for (const [k, rows] of group(deep, e => e.from)) out.push(`- ${k}: ${list(rows, 6)}`);

out.push('', '### L6. Private members read across folders', '', `${reaches.length} reads of a private written only by another layer. R25 reads a few spellings of this; the table counts all of them. A further ${innerReach.length} stay inside core + render + ui, which the architecture treats as one layer (L6b).`, '', '| From | Owner | Member | Count | Sites |', '|---|---|---|---|---|');
for (const [k, rows] of group(reaches, r => `${r.from}|${r.owner}|${r.name}`)) { const [a, b, c] = k.split('|'); out.push(`| ${a} | ${b} | \`${c}\` | ${rows.length} | ${list(rows, 3)} |`); }

out.push('', '### L6b. Inside core + render + ui (top 15)', '', '| From | Owner | Member | Count |', '|---|---|---|---|');
for (const [k, rows] of group(innerReach, r => `${r.from}|${r.owner}|${r.name}`).slice(0, 15)) { const [a, b, c] = k.split('|'); out.push(`| ${a} | ${b} | \`${c}\` | ${rows.length} |`); }

out.push('', '### L7. Privates nobody in the repo declares (three.js, Rapier, browser, or computed writes)', '', '| Member | Count | Sites |', '|---|---|---|');
for (const [k, rows] of group(foreign, r => r.name)) out.push(`| \`${k}\` | ${rows.length} | ${list(rows, 3)} |`);

out.push('', '### L8. Core, render and ui naming a module or capability', '', `Names read from \`metadata.generated.js\`: ${moduleNames.size} modules, ${capNames.size} capabilities. Words that are also plain English (${[...WORDS_THAT_ARE_ALSO_ENGLISH].join(', ')}) are counted apart: most hits on them are not the module.`, '', '| Name | Property reads | String hits | Sites |', '|---|---|---|---|');
const clear = known.filter(k => !WORDS_THAT_ARE_ALSO_ENGLISH.has(k.name));
for (const [k, rows] of group(clear, r => r.name)) out.push(`| ${k} | ${rows.filter(r => r.how === 'prop').length} | ${rows.filter(r => r.how === 'string').length} | ${list(rows, 5)} |`);
out.push('', `Hits on the English-word names: ${known.length - clear.length} (property reads only: ${known.filter(k => k.how === 'prop' && WORDS_THAT_ARE_ALSO_ENGLISH.has(k.name)).map(k => `${k.text} ${at(k)}`).join(', ') || 'none'}).`);

// Where a member read across folders is stated when no public page has it: its contract, or @internal on its definition (a method, a getter, a this.x = line)
function stated(mod, member) {
  const c = metadata.contracts?.[mod];
  if (c && [...c.api, ...c.fields].includes(member)) return 'contract';
  const folder = folderOfModule.get(ownFolder(mod)) ?? ownFolder(mod) ?? mod;
  const named = n => (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.left) ? n.expression.left.name.text : n.name?.getText());
  let hit = null;
  for (const [f, sf] of trees) if (layerOf(f) === `modules/${folder}`) visit(sf, n => { if ((n.jsDoc ?? []).some(d => /@internal\b/.test(d.getText())) && named(n) === member) hit = '@internal'; });
  return hit;
}
const hidden = [...cross].filter(([, v]) => !v.pub).map(([k, v]) => [k, { ...v, stated: stated(...k.split('.')) }]);
const unstated = hidden.filter(([, v]) => !v.stated).map(([k, v]) => `${k} (${v.site})`);
// Private reads across layers that are left on purpose (from|member -> why). The list only shrinks: a new one means reaching into another layer, give it a public member instead
const KNOWN_PRIVATE = {
  'tools|_tools': 'the official door of the tools (engine._tools)',
  'modules/*|_poses': 'R25 allowlist: the pose store is shared state of every module that records poses',
  'modules/debug|_frameMs': 'R25 allowlist: the panel reads the frame timer it draws',
  'modules/ambience|_fade': 'skips the per-frame option parse',
  'modules/ambience|_stop': 'skips the per-frame option parse',
  'modules/characters|_hook': 'the hook slot a character installs on its own model',
  'render|_animation': 'the renderer steps the animation a character owns',
  'tools|_relight': 'decided in commit 2d3adaa2b: the picture tools relight the probes directly',
};
const newPrivate = [...new Set(reaches.map(r => `${r.from}|${r.name}`))].filter(k => !(k in KNOWN_PRIVATE) && !(k.replace(/^modules\/[^|]+/, 'modules/*') in KNOWN_PRIVATE));
const newSites = newPrivate.map(k => `${k} (${reaches.filter(r => `${r.from}|${r.name}` === k).map(r => `${r.file}:${r.line}`).join(', ')})`);
if (opt.check) { const bad = unstated.length || newPrivate.length; console.log(bad ? [unstated.length && `stated nowhere: ${unstated.join(', ')}`, newPrivate.length && `private read across layers, not in KNOWN_PRIVATE: ${newSites.join('; ')}`].filter(Boolean).join('\n') : 'every member read across folders is stated, no new private read across layers'); process.exit(bad ? 1 : 0); }
out.push('', '### L9. One module reading another', '', `${cross.size} distinct \`e.<module>.<member>\` reads between folders. ${hidden.length} members appear nowhere in \`docs/api-surface.txt\`: each is stated in a contract or by @internal on its definition, and \`--check\` fails one that is not (${unstated.length} now).`, '', '| Member | Read by | First site | Stated |', '|---|---|---|---|');
for (const [k, v] of hidden.sort()) out.push(`| \`${k}\` | ${[...v.readers].join(', ')} | ${v.site} | ${v.stated ?? 'NOWHERE'} |`);
out.push('', `Modules read but not listed in the reader's requires, optional or provides (${undeclared.size}): ${[...undeclared].map(([k, s]) => `${k} (${s})`).join(', ') || 'none'}.`);

const block = out.join('\n');
if (opt.dry) console.log(block);
else {
  const doc = abs(DOC);
  if (!existsSync(doc)) throw new Error(`${DOC} is missing; it holds the markers this script fills`);
  const text = readFileSync(doc, 'utf8'), a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`${DOC} has no ${START} block`);
  writeFileSync(doc, `${text.slice(0, a + START.length)}\n\n${block}\n\n${text.slice(b)}`);
  console.log(`layer-scan: ${files.length} files, ${edges.length} edges, ${reaches.length} private reads across layers, ${known.length} core name hits`);
}
