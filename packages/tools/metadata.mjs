// Metadata generator: one file of facts about the engine's modules, read from what the code already declares (module definitions, params, content sections,
// contracts, placement fields, the generated api pages). Step of npm run map; `--check` (npm run check) says when the file is stale.
//   node packages/tools/metadata.mjs [--check]
// Why generated and not a format the modules are rewritten into: the code stays the only place a fact is written. Why one file: catalog, how, the editor, the rules
// and the content loader used to keep their own copies (a section -> module table, api page parsing in two tools, a second walk over the contracts).
// Facts only a running game has (its own modules, ops, template state) stay with engine.catalog() and engine.content.fields().
// Output is JS, not JSON, so the content loader can import sectionHomes in a browser without the rest: a bundler drops the unused `metadata`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ts, parse, visit, walk, abs, P } from './rules/_lib.mjs';
import { withDomStub } from './content-check/dom-stub.mjs';
import { parseOptions } from './lib/cli-args.mjs';

const CHECK = !!parseOptions(process.argv.slice(2), { flags: ['check'] }).opt.check;
const OUT = abs(P.METADATA_REL);
const ARGS = { net: { role: 'host', transport: {} } };   // the one factory that refuses to build with no options; a definition is only read here, nothing connects
const load = f => import(pathToFileURL(abs(f)).href);
const isContract = f => /(^|[/.])contract\.js$/.test(f);
const AUTHORED = f => !f.startsWith(`${P.MODULES_REL}/content/`);   // a pack's own actions are the game's, listed in its GAMEMAP
const [{ parseSchema, schemaInfo }, { PLACEMENT_FIELDS }, { SKIP_KINDS, TIME_HOOKS }, { BASIC_KEYS }] = await Promise.all([load(`${P.CORE_REL}/base/params.js`), load(P.CONTENT_RULES_REL), load(`${P.CORE_REL}/engine/moduleTypes.js`), load(`${P.CORE_REL}/input/inputDefaults.js`)]);

/** Every module definition in the source: { file, call: the factory's name }. What the definition says is read by calling the factory, so a computed table counts too */
function factories() {
  const out = [];
  for (const file of walk(P.MODULES_REL)) {
    if (isContract(file)) continue;
    visit(parse(file), n => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const has = k => n.properties.some(p => (p.name?.text ?? p.name?.getText()) === k);
      const name = n.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'name');
      if (!name || !ts.isStringLiteralLike(name.initializer) || !['install', 'fixed', 'frame'].some(has)) return;
      let fn = n.parent;
      while (fn && !(ts.isFunctionDeclaration(fn) && fn.name) && !(ts.isFunctionLike(fn) && ts.isVariableDeclaration(fn.parent))) fn = fn.parent;
      const call = fn?.name?.getText() ?? fn?.parent?.name?.getText();
      if (call && !out.some(x => x.file === file && x.call === call)) out.push({ file, call });
    });
  }
  return out;
}

/** An api page's facts: { options: { key: { type, desc } }, names: the public methods and properties }, or null with no page. Read once here for every tool */
function pageOf(id) {
  const f = abs(`${P.API_DIR_REL}/${id}.md`);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8'), lines = text.split(/\r?\n/), at = lines.findIndex(l => /^- Options\b/.test(l)), options = at < 0 ? null : {};
  for (let i = at + 1; at >= 0 && i < lines.length && /^\s+-\s/.test(lines[i]); i++) {
    const m = /^\s+-\s+`([\w$]+)(\??):\s*(.*?)`\s*(.*)$/.exec(lines[i]);
    if (m) options[m[1]] = { type: m[3], desc: m[4].trim(), required: !m[2] };
  }
  const names = new Set();
  for (const l of (text.split(/^## /m).find(x => x.startsWith('Methods and properties')) ?? '').split(/\r?\n/)) { const m = /^\s*-\s+`(?:[\w$]+\.)?([\w$]+)/.exec(l); if (m) names.add(m[1]); }
  return { options, names: [...names] };
}

/** Names on a contract that their source marks @internal: other modules call them and a replacement must give them, games do not, so they stay out of the types */
function internalOf(c, file) {
  const dir = file.slice(0, file.lastIndexOf('/')), api = new Set(c.api ?? []), out = new Set();
  for (const f of walk(dir)) visit(parse(f), n => {
    const k = n.name?.getText();
    if (api.has(k) && (n.jsDoc ?? []).some(d => /@internal\b/.test(d.getText()))) out.add(k);
  });
  return [...out].sort();
}

/** Thin factories: exported functions whose whole body returns another factory's call, as followCamera() returns rigModule('follow'). module name -> [{ call, file }] */
function aliases(list) {
  const out = {}, target = new Map(list.map(f => [f.call, f]));
  for (const file of walk(P.MODULES_REL)) visit(parse(file), n => {
    if (!ts.isFunctionDeclaration(n) || !n.name || !n.body || n.body.statements.length !== 1) return;
    const s = n.body.statements[0], c = ts.isReturnStatement(s) ? s.expression : null;
    if (c && ts.isCallExpression(c) && target.has(c.expression.getText()) && target.get(c.expression.getText()).call !== n.name.text) (out[c.expression.getText()] ??= []).push({ call: n.name.text, file });
  });
  return out;
}

/** Input actions the modules declare: { action, param?, context, label, optional?, hasKey?, file }; hasKey: a basic the engine binds itself. A name held in a variable shows the option it comes from and that option's default */
function actionsOf(modules) {
  const out = [], byFile = Object.fromEntries(Object.values(modules).map(m => [m.file, m]));
  const text = n => n ? (ts.isStringLiteralLike(n) ? n.text : n.getText().replace(/\s+/g, '')) : null;
  for (const file of walk(P.MODULES_REL).filter(AUTHORED)) {
    const sf = parse(file), defaults = {};
    visit(sf, n => { if (ts.isBindingElement(n) && n.initializer && ts.isStringLiteralLike(n.initializer)) defaults[n.name.getText()] ??= n.initializer.text; });
    visit(sf, n => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !/^(define|action)$/.test(n.expression.name.text) || !/(^|\.)input$/.test(n.expression.expression.getText())) return;
      const [a, o] = n.arguments, isVar = ts.isIdentifier(a), def = isVar ? defaults[a.text] ?? byFile[file]?.params?.[a.text]?.default : null;
      const field = k => { const p = o?.properties?.find(x => x.name?.getText() === k); return p && (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer) ? p.initializer.text : '(variable)'); };
      out.push({ action: def ?? text(a), ...(def && { param: a.text }), context: field('context') || 'walk', label: field('label') || '', ...(/\boptional: true\b/.test(o?.getText() ?? '') && { optional: true }), ...(BASIC_KEYS[def ?? text(a)] && { hasKey: true }), file });
    });
  }
  return out;
}

/** params with the page's words merged in: the schema keeps names, defaults and checks; the type and the sentence live once, in the JSDoc */
function paramsOf(def, page) {
  if (!def.params) return null;
  const info = schemaInfo(parseSchema(`module ${def.name} params`, def.params));
  for (const [k, s] of Object.entries(info)) {
    const d = page?.options?.[k];
    if (d?.type && s.type === 'any') s.docType = d.type;
    if (!s.desc && d?.desc) s.desc = d.desc;
  }
  return info;
}

// What hand-written game code a system replaces, declared next to its definition as `export const handRolled` (a list of hints, or 'none: why no code shape can show it').
// A plain export and not a field of the definition: nothing imports it, so a game's bundle drops it and it costs nothing at run time. Regexes become strings here; rule R40 rebuilds them.
const FROZEN = { net: 'none: an own connection is a plain WebSocket, used on purpose' };   // modules/net is not edited for now (no multiplayer work), so its answer is kept here
const HINT_RE = ['quiet', 'code', 'raw', 'orRaw', 'not', 'notRaw'];
const hintData = (h, file) => ({ ...h, file, ...Object.fromEntries(HINT_RE.filter(k => h[k]).map(k => [k, String(h[k])])), ...(h.near && { near: h.near.map(n => ({ ...n, re: String(n.re) })) }), ...(h.yields && { yields: { ...h.yields, raw: String(h.yields.raw) } }) });
/** Every hint in the source, by kind. A file is read only when it declares one; core systems declare here too, they have no module definition */
async function hintsOf(problems) {
  const out = {};
  for (const file of [P.CORE_REL, P.MODULES_REL].flatMap(d => walk(d)).filter(f => readFileSync(abs(f), 'utf8').includes('export const handRolled'))) {
    const said = (await load(file)).handRolled;
    if (typeof said === 'string') { if (!/^none: .{12,}/.test(said)) problems.push(`${file}: handRolled must be a list of hints or 'none: <why no code shape shows it>'`); continue; }
    for (const h of said) {
      if (out[h.kind]) problems.push(`${file}: hint kind ${h.kind} is declared twice`);
      if (!h.kind || !h.seen || !h.use || !(h.code || h.raw)) problems.push(`${file}: hint ${h.kind} needs kind, seen, use and code or raw`);
      out[h.kind] = hintData(h, file);
    }
  }
  return out;
}

/** Save parts a module registers: its own file and the files it imports, by the literal name (the engine's own parts all name theirs). Why from the source: a part registers at install, and metadata never installs */
function savedParts(file) {
  const read = f => { try { return readFileSync(abs(f), 'utf8'); } catch { return ''; } }, own = read(file);
  const near = [...own.matchAll(/from '(\.\.?\/[^']+\.js)'/g)].map(m => read(join(dirname(file), m[1]).replaceAll('\\', '/')));
  return [...new Set([own, ...near].flatMap(t => [...t.matchAll(/\.saves\??\.(?:define|register)\('([\w-]+)'/g)].map(m => m[1])))];
}

/** engine.<member> a module brings that the core does not: { module, by }; by is 'install', or the function that sets it later (engine.player stays null until addPlayer). Why from the source:
 *  a slot name, a code member and what must exist first are three facts, and a tool that guesses one from another prints a member that is not there (test "how cards") */
function membersOf(modules) {
  const core = [`${P.CORE_REL}/engine/Engine.js`, `${P.CORE_REL}/engine/services.js`].map(f => readFileSync(abs(f), 'utf8')).join('\n');
  const inCore = k => new RegExp(`\\b(?:this|engine)\\.${k} = (?!null\\b)`).test(core), out = {}, list = Object.entries(modules), dir = f => f.slice(0, f.lastIndexOf('/'));
  // `e` is also what plenty of local loops call an entry, so a name counts only when the public surface lists it as an engine member
  const surface = new Set([...readFileSync(abs('docs/api-surface.txt'), 'utf8').matchAll(/^engine sub-objects \| (\w+)\./gm)].map(m => m[1]));
  for (const [id, m] of list) for (const slot of m.provides) if (slot !== id && /^\w+$/.test(slot) && !inCore(slot)) out[slot] ??= { module: id, by: 'install' };
  for (const file of walk(P.MODULES_REL).filter(f => !isContract(f))) visit(parse(file), n => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(n.left) || !/^(e|engine)$/.test(n.left.expression.getText())) return;
    const k = n.left.name.text, owner = list.find(([, m]) => m.file === file) ?? list.find(([, m]) => dir(m.file) === dir(file));
    if (n.right.kind === ts.SyntaxKind.NullKeyword || !surface.has(k) || inCore(k) || !owner || modules[k]) return;
    let fn = n.parent;
    while (fn && !(ts.isFunctionLike(fn) && fn.name)) fn = fn.parent;
    out[k] ??= { module: owner[0], by: fn?.name?.getText() ?? 'install' };
  });
  return out;
}

function moduleOf(def, { file, call }, alias, said) {
  const page = pageOf(def.name);
  return {
    call, file, ...(alias && { aliases: alias }), ...(def.label && { label: def.label }), needs: [...new Set([...Object.keys(ARGS[call] ?? {}), ...Object.keys(page?.options ?? {}).filter(k => page.options[k].required)])], type: def.type ?? 'rules', provides: def.provides ?? [], requires: def.requires ?? [],
    ...(said && { handRolled: typeof said === 'string' ? said : said.map(h => h.kind) }),
    stage: def.stage ?? 'late', before: def.before ?? [], after: def.after ?? [],
    optional: Array.isArray(def.optional) ? def.optional : Object.keys(def.optional ?? {}), params: paramsOf(def, page), page: !!page, documented: !!page?.options,
    names: page?.names ?? [], sections: Object.keys(def.content ?? {}), saves: savedParts(file),
    time: { kind: def.skipKind, hooks: TIME_HOOKS.filter(h => typeof def[h] === 'function'), ...(def.noSkip && { noSkip: def.noSkip }) },
  };
}

async function build() {
  const modules = {}, sections = {}, docs = {}, effects = {}, contracts = {}, problems = [], list = factories(), thin = aliases(list);
  for (const f of list) {
    let defs, said;
    try { const mod = await load(f.file); said = mod.handRolled; defs = [mod[f.call](ARGS[f.call])].flat(); }
    catch (e) { problems.push(`${f.file}: ${f.call}() would not build: ${e.message}`); continue; }
    for (const def of defs.filter(d => d?.name && d.install)) {
      modules[def.name] ??= moduleOf(def, f, thin[f.call], said ?? FROZEN[def.name]);
      for (const [name, s] of Object.entries(def.content ?? {})) { sections[name] = { owner: def.name, ...(s.live && { live: true }) }; docs[name] = s.desc; for (const [w, d] of Object.entries(s.effects ?? {})) effects[w] = { ref: d.ref, desc: d.desc, describe: d.describe('{v}') }; }
    }
  }
  for (const file of [P.MODULES_REL, P.CORE_REL].flatMap(d => walk(d)).filter(isContract)) {
    const c = (await load(file)).default;
    contracts[c.name] = { file, ...(c.kind && { kind: c.kind }), api: c.api ?? [], internal: internalOf(c, file), fields: c.fields ?? [] };
  }
  const fields = Object.fromEntries(Object.entries(PLACEMENT_FIELDS).map(([shape, t]) => [shape, schemaInfo(parseSchema(`fields ${shape}`, t))]));
  for (const [name, d] of Object.entries(docs)) if (!d) problems.push(`section ${name} of module ${sections[name].owner} has no desc`);
  return { problems, docs: sorted(docs), effects: sorted(effects), data: { modules: sorted(modules), members: sorted(membersOf(modules)), sections: sorted(sections), contracts: sorted(contracts), actions: actionsOf(modules), fields, skipKinds: SKIP_KINDS, hints: sorted(await hintsOf(problems)) } };
}
const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en')));

/** section -> how to install what reads it, for the loader's error when nothing does */
const homeOf = (m, all) => `${all[m].call}()${all[m].requires.length ? ` after ${all[m].requires.map(r => all[r] ? all[r].call + '()' : r).join(', ')}` : ''}`;

const { problems, docs, effects, data } = await withDomStub(build);
if (problems.length) { console.log(problems.map(p => '  ✗ ' + p).join('\n')); process.exit(1); }
const homes = Object.fromEntries(Object.entries(data.sections).map(([name, s]) => [name, homeOf(s.owner, data.modules)]));
const text = `// Generated by npm run map, do not edit by hand. Source: packages/tools/metadata.mjs reads the module definitions, contracts and api pages.\n`
  + `/** section name -> what it holds, as its owner wrote it */\nexport const sectionDocs = ${JSON.stringify(docs, null, 1)};\n`
  + `/** effect word of a section -> ref, desc, describe ({v} is the value), as its owner wrote them */\nexport const sectionEffects = ${JSON.stringify(effects, null, 1)};\n`
  + `/** section name -> the module call that reads it */\nexport const sectionHomes = ${JSON.stringify(homes, null, 1)};\n`
  + `/** Modules, content sections, contracts and placement fields of the engine */\nexport const metadata = ${JSON.stringify(data, null, 1)};\n`;

if (CHECK) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) { console.log(`✗ ${P.METADATA_REL} is not up to date, run npm run map`); process.exit(1); }
  console.log(`✓ metadata is up to date (${Object.keys(data.modules).length} modules)`);
} else {
  writeFileSync(OUT, text);
  console.log(`Generated ${P.METADATA_REL} (${Object.keys(data.modules).length} modules, ${Object.keys(data.sections).length} sections, ${Object.keys(data.contracts).length} contracts)`);
}
process.exit(0);   // module files keep timers and three.js state alive in Node; nothing here needs them to wind down
