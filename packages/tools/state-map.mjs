// Global state map, generated part: fills the block between the markers in the audit's global-state-map.md with what the source itself declares,
// so the hand-read tables around it can be checked against code and not against memory or docs.
//   node packages/tools/state-map.mjs            rewrite the block
//   node packages/tools/state-map.mjs --check    also fail when a `file:line` written by hand points past the end of its file, or at a blank line
// Why a line scan and not a run: the question is "who could write this", and a running game only shows who did. Why it stays a small scan: it reports candidates
// (two writers, an event nobody hears); a person decides which are real. A computed name (`level:${x}`) cannot be read here and is listed as `dynamic`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ts, parse, visit, lineOf, walk, abs, P } from './rules/_lib.mjs';
import { loose as registrations, moduleFiles } from './rules/R65-registration-leaves.mjs';
import { withDomStub } from './content-check/dom-stub.mjs';
import { cli } from './paths.mjs';

const { opt } = cli(process.argv.slice(2), { workspace: false, flags: ['check'] });
const MAP = 'docs/testing/review/2026-11-07-1.0-audit/global-state-map.md';
const START = '<!-- state-map:generated:start -->', END = '<!-- state-map:generated:end -->';
const HOOKS = ['install', 'init', 'fixed', 'frame', 'afterRender', 'skip', 'afterLoad', 'dispose'];
const LIFE = ['session:end', 'session:start', 'session:failed', 'save:loaded', 'module:restored', 'page:contextlost', 'page:contextrestored'];
const short = f => f.replace(`${P.ENGINE_REL}/`, '');
const load = f => import(pathToFileURL(abs(f)).href);
const cell = list => list.length ? list.join(', ') : '-';

const { metadata } = await load(P.METADATA_REL);
const { ENGINE_EVENTS } = await load(P.EVENTS_GEN_REL);
const files = P.ENGINE_CODE_DIRS_REL.flatMap(d => walk(d));

/** Who a source line belongs to: its module folder, or the core part. Folder, not module name: one folder can hold several modules, and the module table says which */
const ownerOf = f => /\/modules\/([^/]+)\//.exec(f)?.[1] ?? short(f).split('/').slice(0, 2).join('/').replace(/\.js$/, '');

// One walk over the syntax tree: a line scan also matched names inside error messages. A first argument is read when it is a string, a plain `a ? 'x' : 'y'`, or the loop
// variable of `for (const n of [...])` / `[...].map(n => ...)`; anything else is `dynamic`, so a reader knows what the table cannot see
const KINDS = { emit: c => c.name === 'emit', on: c => /^(on|once)$/.test(c.name) && /(^|\.)(events|e|engine)$/.test(c.obj), save: c => (c.name === 'define' || c.name === 'register') && /saves$/.test(c.obj),
  op: c => c.name === 'define' && /ops$/.test(c.obj), mod: c => c.name === 'mod', point: c => /^(define|rule)$/.test(c.name) && /stacks$/.test(c.obj) };
const found = Object.fromEntries(Object.keys(KINDS).map(k => [k, new Map()]));
const tracks = new Map(), borrows = [];

/** The strings an expression can be: a literal, both sides of a conditional, or the array a loop variable walks */
function namesOf(n) {
  if (ts.isStringLiteralLike(n)) return [n.text];
  if (ts.isConditionalExpression(n)) return [...namesOf(n.whenTrue), ...namesOf(n.whenFalse)];
  if (ts.isIdentifier(n)) for (let p = n.parent; p; p = p.parent) {
    if (ts.isForOfStatement(p) && p.initializer.getText().endsWith(n.text) && ts.isArrayLiteralExpression(p.expression)) return p.expression.elements.flatMap(namesOf);
    if (ts.isArrowFunction(p) && p.parameters[0]?.name.getText() === n.text && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && ts.isArrayLiteralExpression(p.parent.expression.expression)) return p.parent.expression.expression.elements.flatMap(namesOf);
  }
  return [`dynamic ${n.getText().slice(0, 40)}`];
}

for (const f of files.filter(x => !x.endsWith('.generated.js'))) {
  visit(parse(f), n => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !n.arguments.length) return;
    const c = { name: n.expression.name.text, obj: n.expression.expression.getText() }, at = `${short(f)}:${lineOf(n)}`, owner = ownerOf(f);
    if (c.name === 'track' && c.obj === 'ctx') tracks.set(owner, (tracks.get(owner) ?? 0) + 1);
    if (c.name === 'borrow' && c.obj === 'ctx') borrows.push({ at, what: n.arguments[0].getText() });
    for (const [kind, is] of Object.entries(KINDS)) if (is(c)) for (const name of namesOf(n.arguments[0])) {
      if (['on', 'emit'].includes(kind) && !name.includes(':') && !name.startsWith('dynamic ')) continue;   // a DOM-style emitter (a net transport), not the event bus
      if (!found[kind].has(name)) found[kind].set(name, []);
      found[kind].get(name).push({ at, owner });
    }
  });
}

/** Line of each hook in a module's definition; a hook that comes from a spread has none, and the table says so */
function hookLines(m, name) {
  const out = {};
  visit(parse(m.file), n => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const isIt = n.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'name' && p.initializer.getText().slice(1, -1) === name);
    if (!isIt) return;
    for (const p of n.properties) if (HOOKS.includes(p.name?.getText())) out[p.name.getText()] = lineOf(p);
  });
  return out;
}

async function moduleRows() {
  const rows = [];
  await withDomStub(async () => {
    for (const [name, m] of Object.entries(metadata.modules)) {
      const made = (await load(m.file))[m.call]?.(name === 'net' ? { role: 'host', transport: {} } : undefined);
      const def = [].concat(made).find(d => d?.name === name);   // a factory can return a world module and its picture module together
      const lines = hookLines(m, name);
      const hooks = HOOKS.filter(h => typeof def?.[h] === 'function' || lines[h]).map(h => `${h}${lines[h] ? `:${lines[h]}` : ':unknown'}`);
      rows.push({ name, m, def, hooks });
    }
  });
  return rows;
}

const whereList = (list, max = 4) => cell(list.slice(0, max).map(x => x.at)) + (list.length > max ? ` +${list.length - max}` : '');
const owners = list => [...new Set(list.map(x => x.owner))];

function build(rows) {
  const out = [];
  const folderOf = r => /\/modules\/([^/]+)\//.exec(r.m.file)?.[1];
  const savedBy = new Map();
  for (const [key, list] of found.save) for (const x of list) { if (!savedBy.has(x.owner)) savedBy.set(x.owner, []); savedBy.get(x.owner).push(key); }

  out.push(`### G1. Modules (from \`metadata.generated.js\`, the factories, and their definitions)\n`,
    `Hook numbers are lines in the module's file; \`unknown\` means the hook arrives through a spread. Save keys, \`ctx.track\` counts and lifecycle listeners are per module FOLDER, because one folder can hold several modules.\n`,
    '| Module | File | Type | Stage | Provides | Requires | Skip kind | Hooks | Folder: save keys | Folder: ctx.track |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const f = folderOf(r);
    out.push(`| ${r.name} | ${short(r.m.file)} | ${r.m.type} | ${r.m.stage ?? '-'} | ${cell(r.m.provides)} | ${cell(r.m.requires)} | ${r.def?.skipKind ?? 'unknown'} | ${cell(r.hooks)} | ${cell(savedBy.get(f) ?? [])} | ${tracks.get(f) ?? 0} |`);
  }

  out.push(`\n### G2. Save parts (every literal \`saves.define\`)\n`, '| Key | Registered at | Owner |', '|---|---|---|');
  for (const [key, list] of [...found.save].sort()) if (!key.startsWith('dynamic ')) out.push(`| ${key} | ${whereList(list)} | ${cell(owners(list))} |`);

  out.push(`\n### G3. Lifecycle listeners (every literal listener on a moment event)\n`, '| Event | Emitted at | Listeners |', '|---|---|---|');
  for (const ev of LIFE) out.push(`| ${ev} | ${whereList(found.emit.get(ev) ?? [])} | ${whereList(found.on.get(ev) ?? [], 30)} |`);

  out.push(`\n### G4. Shared points with more than one writing owner (\`mod\` with a literal point)\n`, 'Two owners are fine on a shared point when they stack; a row here is only a place to look. The layer of each write is in the source line.\n', '| Point | Writers |', '|---|---|');
  for (const [point, list] of [...found.mod].sort()) if (owners(list).length > 1) out.push(`| ${point} | ${whereList(list, 8)} |`);
  out.push(`\nAll named points: ${found.mod.size}; written by one owner: ${[...found.mod.values()].filter(l => owners(l).length === 1).length}; a computed name: ${[...found.mod.keys()].filter(k => k.startsWith('dynamic ')).length}.\n`);
  out.push('Points defined (`stacks.define` / `stacks.rule`):\n', '| Point | Defined at | Written at |', '|---|---|---|');
  for (const [point, list] of [...found.point].sort()) if (!point.startsWith('dynamic ')) out.push(`| ${point} | ${whereList(list, 2)} | ${whereList(found.mod.get(point) ?? [], 6)} |`);
  out.push('');

  const listed = new Set(ENGINE_EVENTS), literal = n => !n.startsWith('dynamic ');
  const emitted = [...found.emit.keys()].filter(literal), heard = [...found.on.keys()].filter(literal);
  out.push(`### G5. Events (emit and listen sites; \`dynamic\` names are at the end)\n`, '| Event | In events.generated | Emitted at | Heard by the engine at |', '|---|---|---|---|');
  for (const ev of [...new Set([...listed, ...emitted, ...heard])].sort()) out.push(`| ${ev} | ${listed.has(ev) ? 'yes' : 'NO'} | ${whereList(found.emit.get(ev) ?? [], 3)} | ${whereList(found.on.get(ev) ?? [], 5)} |`);
  out.push('', `Dynamic emits: ${cell([...found.emit].filter(([n]) => !literal(n)).map(([n, l]) => `\`${n.slice(8)}\` (${l[0].at})`))}.`);
  out.push(`Dynamic listeners: ${cell([...found.on].filter(([n]) => !literal(n)).map(([n, l]) => `\`${n.slice(8)}\` (${l[0].at})`))}.\n`);

  out.push(`### G6. \`ctx.borrow\` sites\n`, whereList(borrows, 40), '');
  out.push(`### G7. Ops per owner (literal \`ops.define\`)\n`);
  const ops = new Map();
  for (const [name, list] of found.op) for (const x of list) ops.set(x.owner, [...(ops.get(x.owner) ?? []), name]);
  out.push('| Owner | Count | Names |', '|---|---|---|');
  for (const [o, l] of [...ops].sort()) out.push(`| ${o} | ${l.length} | ${l.join(', ')} |`);
  const { hard, loose } = reach();
  out.push(`\n### G8. Reach past what a module declared (optional reads report only; registrations held by R65)\n`, `Optional neighbour read with no \`?.\` (${hard.length}): ${cell(hard)}.\n`, `Registration not through \`ctx\` and not tracked on the same statement (${loose.length}; R65 holds each to a \`// released:\` line): ${cell(loose)}.`);
  return out.join('\n');
}

/** Each row is a module reaching past what it declared. Optional reads are report only: most sit behind an `if` a scan cannot see */
function reach() {
  const hard = [];
  for (const m of Object.values(metadata.modules)) {
    const folder = m.file.replace(/\/[^/]+$/, '');
    for (const f of files.filter(x => x.startsWith(`${folder}/`) && !x.endsWith('.generated.js'))) visit(parse(f), n => {
      // `e.world.x` with no `?.` on a name the module listed as optional: unuse leaves it undefined
      if (ts.isPropertyAccessExpression(n) && !n.questionDotToken && m.optional?.includes(n.name.text) && /^(e|engine|this\.engine|this\.e)$/.test(n.expression.getText())
        && ts.isPropertyAccessExpression(n.parent) && !n.parent.questionDotToken && n.parent.expression === n) hard.push(`${short(f)}:${lineOf(n)} ${n.name.text}`);
    });
  }
  // R65 holds these: what is left has a `// released:` line naming who gives it back
  const loose = moduleFiles().flatMap(f => registrations(parse(f)).map(r => `${short(f)}:${r.line} ${r.name}`));
  return { hard: [...new Set(hard)], loose };
}

/** A hand cell says `file:line`; a stale one must not read as evidence. Only catches a line past the end or a blank line, not a line that moved */
function checkCitations(text) {
  const bad = [];
  for (const m of text.matchAll(/\b((?:core|modules|render|ui)\/[\w./-]+\.js):(\d+)/g)) {
    const f = abs(`${P.ENGINE_REL}/${m[1]}`);
    if (!existsSync(f)) { bad.push(`${m[0]}: no such file`); continue; }
    const line = readFileSync(f, 'utf8').split(/\r?\n/)[Number(m[2]) - 1];
    if (!line?.trim()) bad.push(`${m[0]}: no such line`);
  }
  return [...new Set(bad)];
}

const rows = await moduleRows();
const text = readFileSync(abs(MAP), 'utf8');
const a = text.indexOf(START), b = text.indexOf(END);
if (a < 0 || b < 0) { console.log(`✗ ${MAP} has no generated markers`); process.exit(1); }
const next = `${text.slice(0, a + START.length)}\n\n${build(rows)}\n\n${text.slice(b)}`;
writeFileSync(abs(MAP), next);
const bad = opt.check ? checkCitations(next) : [];
for (const x of bad) console.log(`  ✗ ${x}`);
console.log(`${bad.length ? '✗' : '✓'} state map: ${rows.length} modules, ${found.save.size} save parts, ${found.emit.size} emitted events, ${found.mod.size} shared points`);
process.exit(bad.length ? 1 : 0);
