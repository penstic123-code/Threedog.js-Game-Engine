// API doc generator: generates from the type declarations (packages/engine/index.d.ts, packages/engine/types/*.d.ts)
//   packages/engine/docs/API.md index: the core everyday API + one line per core object / module (the AI reads this page first, target within 120
//   lines)
//   packages/engine/docs/api/<name>.md one page per core object and per module: methods, parameters, properties, data structures (read only the page
//   you need)
// Parsed with the TypeScript compiler (not regexes), so regenerating after a declaration change never goes stale.
//   packages/engine/docs/COMMANDS.md the dev bridge rows, from threedog/command-table.mjs
//   node packages/tools/apidoc.mjs           generate
//   node packages/tools/apidoc.mjs --check   check it is up to date (exit code 1 if not)
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { API_MD_REL, API_DIR_REL, RECIPES_REL, CONTENT_RULES_REL, METADATA_REL, ENGINE, abs, cli } from './paths.mjs';
import { COMMANDS, EXTRA as EXTRA_COMMANDS } from './threedog/command-table.mjs';
import { aiTable } from './how.mjs';
import {
  ROOT, OUT, PAGES, GEN, decls, indexFns, reexported, shown, get, clean, docOf, first, full, brief, raw, typeText, sig,
  INTERNAL, missingDocs, split, ext, methodLine, fieldLines, renderApi, renderOptions, renderStruct,
  names, pages, page, link, fnLine, idx, structs,
} from './apidoc/lib.mjs';

const { opt: OPT } = cli(process.argv.slice(2), { workspace: false, flags: ['check', 'report'] });

const recipeNames = readdirSync(abs(RECIPES_REL)).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')).sort();
idx.push('# Engine API index (generated, do not edit by hand; produced by npm run map)', '',
  '> A new feature starts at `AI.md` or `threedog how`; this page is for looking up a name.',
  '> The api pages are generated too, do not edit them by hand; `?` in a signature means optional, what follows `→` is the return value; the full types ' +
    'are in `types/*.d.ts`.',
  '> One line per core object / module; for the one you need, **read only that page** `api/<name>.md`.',
  '> Paths are relative to the package (`node_modules/threedog/`). Entry: `import { createEngine, openWorld, … } from \'threedog\'` (the engine ' +
    'package\'s own examples use relative paths); ' +
    'a module the game needs is installed with `engine.use` before `await engine.start()`; `engine.xxx?.method()` is only for a feature the game works without, and a required module left out that way fails in silence.',
  '> By task: ordinary picture is plain three.js (`THREE.md`); game rules are `onFixed`, `ops`, `world`; modules are `use` and `ctx.track`; drawing of your own is at the end of the module list; to troubleshoot, `describe` gives state and `explain` why.', '');

// ---------- Core: engine ----------
const eng = get('Engine');
const engApi = split(eng, 'Engine');
{
  const L = page('engine', 'engine — createEngine and the Engine class (core)');
  L.push(fnLine('createEngine'));
  renderOptions(L, 'EngineOptions');
  L.push('', '## engine methods');
  for (const e of engApi.methods) L.push(methodLine('engine.', e));
  L.push('', '## engine properties (module properties are on each module page)', ...fieldLines(engApi.props.filter(p => !p.optional), ''));
  L.push('', '## Module definition (engine.use(myModule()))');
  renderStruct(L, 'ModuleDef');
  L.push('', '## createEngine({ ui })');
  renderStruct(L, 'UIOptions');
  renderStruct(L, 'UITheme');
  structs(L, 'engine');
}
const COMMON = ['use', 'start', 'step', 'describe', 'describeText', 'applyState', 'onFixed',
  'onFrame', 'add', 'remove', 'surface', 'snapToGround', 'raycast', 'pick', 'freeze', 'haltLoop'];
idx.push('## Core everyday API (all methods, properties, createEngine options and how to write a module are in [api/engine.md](api/engine.md))');
idx.push(`- \`${sig('createEngine', indexFns.find(x => x.name === 'createEngine').nodes[0])}\` — creates the engine (core only); options: canvas ui loading saveKey headless budget …`);
idx.push(`- \`${sig('openWorld', indexFns.find(x => x.name === 'openWorld').nodes[0])}\` — open-world preset (world and environment + basic modules; add gameplay modules yourself; \`xxx: false\` turns one off), options in [api/openWorld.md](api/openWorld.md)`);
for (const n of COMMON) { const e = engApi.methods.find(m => m.name === n); if (e) idx.push(`- \`${sig('engine.' + n, e.sigs[0])}\`${e.doc ? ' — ' + first(e.doc, 70) : ''}`); }
for (const n of ['stateApplied', 'ready', 'player', 'scene',
  'camera']) { const p = engApi.props.find(x => x.name === n); if (p) idx.push(`- \`engine.${n}\`${p.doc ? ' — ' + first(p.doc, 70) : ''}`); }

// ---------- Core objects ----------
const CORE_OBJS = [['events', 'Events'], ['input', 'Input'], ['clock', 'Clock'], ['vars',
  'Vars'], ['saves', 'Saves'], ['assets', 'Assets'], ['audio', 'Audio'], ['i18n', 'I18n'],
  ['rays', 'Rays'], ['jobs', 'Jobs'], ['stream', 'Stream'], ['budget', 'Budget'], ['post', 'PostFX'], ['occlusion', 'Occlusion'], ['ground', 'GroundProvider']];
idx.push('', '## Core objects (engine.xxx, no install needed)');
for (const [p, t] of CORE_OBJS) {
  const d = docOf(get(t)).text;
  const L = page(p, `engine.${p} (${t})${d ? ' — ' + first(d, 140) : ''}`);
  if (p === 'i18n') L.push(methodLine('engine.', engApi.methods.find(m => m.name === 't')));   // the everyday call lives on Engine, not on this class
  renderApi(L, t, `${p}.`, { skipProps: ['composer'] });
  if (p === 'events') {
    L.push('', '## Event table (engine.events.on(name, (args…) => …), the [] lists the callback arguments)');
    const { props } = split(get('EventMap'), 'EventMap');
    for (const ev of props) L.push(`- \`${ev.name.replace(/'/g, '')}\` ${typeText(ev.type, 70)} ${ev.doc}`);
    L.push('- Other names work too (the game\'s own events, such as \'door:open\'), their arguments are just not checked');
  }
  structs(L, p);
  const own = d.replace(/^engine\.\w+\s*:\s*/, '').replace(/\s*:\s*engine\..*$/, '');
  const ns = names(t);
  idx.push(`- [\`engine.${p}\`](${link(p)}) ${brief(own) || t}${ns ? ': ' + ns : ''}${p === 'events' ? '; event table' : ''}`);
}

// ---------- Modules ----------
{
  const L = page('openWorld', 'openWorld() preset — installs the open-world world and environment modules in one go');
  L.push(fnLine('openWorld'));
  renderOptions(L, 'OpenWorldOptions');
}
idx.push('', '## Modules (installed with engine.use; the openWorld preset installs only world and environment, see [api/openWorld.md](api/openWorld.md))');
const engProps = engApi.props.filter(p => p.optional);
// a factory returns ModuleDef<Api>, or an array or tuple of them: the first is what the options configure, the rest are parts of it (weather: state, then drawing)
const factories = indexFns.filter(f => ts.isFunctionDeclaration(f.nodes[0]) && /^\[?\s*ModuleDef\b/.test(raw(f.nodes[0].type)));
const apisOf = f => [...raw(f.nodes[0].type).matchAll(/ModuleDef<(?:import\("[^"]*"\)\.)?(\w+)>/g)].map(m => m[1]);
const drawIdx = [];                                   // the second half of a tuple: for authors of custom drawing, listed apart from the facades
const EXTRA = { npcs: 'characters' };                // properties not installed by a module function of their own: written into that module's page
const EXTRA_TYPES = {                                  // classes that come with a module (engine.player etc.)
  characters: [['Character', 'player.', 'engine.player / NPC are both Character'], ['NPC', 'npc.', 'engine.npcs.add() returns an NPC (extends Character)']],
};
const CAMS = [['FollowCamera', 'followCamera'], ['FirstPersonCamera', 'firstPersonCamera'], ['FixedCamera', 'fixedCamera'], ['RtsCamera', 'rtsCamera']];
for (const p of engProps) {
  const t = typeText(p.type);
  const fs = factories.filter(f => apisOf(f).includes(t)), part = fs.length > 0 && fs.every(f => apisOf(f)[0] !== t);
  const mods = fs.map(f => { const o = f.nodes[0].parameters[0]; return `${f.name}(${o ? `${o.name.getText()}?: ${typeText(o.type)}` : ''})`; });
  const need = fs.map(f => docOf(f.nodes[0]).text.match(/requires (?:module )?`?\w+`? to be installed first/i)?.[0]).find(Boolean);
  let L;
  if (EXTRA[p.name]) { L = pages.get(EXTRA[p.name]); L.push('', `## engine.${p.name} (installed together with ${EXTRA[p.name]}())`); }
  else {
    L = page(p.name, `engine.${p.name} — ${mods.join(' / ') || p.name + '()'}${need ? ` (${need})` : ''}`);
    if (p.doc) L.push(full(p.doc), '');
    if (!part) for (const f of fs) { const o = f.nodes[0].parameters[0]; if (o) renderOptions(L, typeText(o.type), fs.length > 1 ? `${f.name} options` : 'Options'); }
    L.push('', '## Methods and properties');
  }
  const short = p.name === 'cameraRig' ? 'cam.' : `${p.name}.`;
  if (p.name === 'cameraRig') {
    renderApi(L, 'CameraRigBase', 'cam.');
    for (const [t2, who] of CAMS) {
      const node = get(t2), { methods, props } = split(node, t2);
      const live = `every item of the options (the options of \`${who}\`) can be read and written at runtime, e.g. \`engine.cameraRig.yaw = 1.2\`, \`pitch\``;
      L.push(`- ${who} only: ${/Required<Omit<\w+Options/.test(ext(node)) ? live : ''}`);
      for (const e of methods) L.push(methodLine('cam.', e, '  '));
      if (props.length) L.push(...fieldLines(props, '  '));
    }
  } else renderApi(L, t, short);
  for (const [ct, pre, note] of EXTRA_TYPES[p.name] || []) {
    L.push('', `## ${ct} (${note})`);
    const { methods, props } = split(get(ct), ct);
    for (const e of methods.filter(e => !INTERNAL.has(e.name) || e.doc)) L.push(methodLine(pre, e));
    const ps = props.filter(x => x.doc);
    if (ps.length) L.push('- Properties:', ...fieldLines(ps));
  }
  if (EXTRA[p.name]) continue;
  if (p.name === 'timeline') {
    // Timeline steps: a union type, listed one by one
    const node = get('TimelineStep');
    L.push('', '## Timeline steps (engine.timeline.play([...]))', `- **TimelineStep** ${first(docOf(node).text)}, which can be any of the following:`);
    for (const x of node.type.types) {
      if (!ts.isTypeLiteralNode(x)) { const s = raw(x); if (!/^(null|undefined|false)$/.test(s)) L.push(`  - \`${typeText(x, 60)}\``); continue; }
      const [m, ...rest] = x.members;
      // The description on a union member is written before the |, which TS does not put into jsDoc: take the /** … */ between the end of the
      //   previous member and the start of this one
      const prev = node.type.types[node.type.types.indexOf(x) - 1];
      const gap = x.getSourceFile().text.slice(prev ? prev.end : node.type.pos, x.getStart());
      const before = gap.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
      const more = rest.map(r => r.name.getText() + (r.questionToken ? '?' : '')).join(', ');
      L.push(`  - \`{ ${m.name.getText()}: ${typeText(m.type, 60)}${more ? ', ' + more : ''} }\`${before ? ' — ' + full(clean(before[1])) : ''}`);
    }
  }
  structs(L, p.name);
  const label = p.doc.split(/[(:]/)[0].trim() || p.name, ns = names(p.name === 'cameraRig' ? 'CameraRigBase' : t, 12);
  const extraTypes = EXTRA_TYPES[p.name] ? '; ' + EXTRA_TYPES[p.name].map(x => x[0]).join(', ') : '';
  const npcNote = p.name === 'characters' ? '; engine.npcs: ' + names('NPCManager') + ' avoid (behavior and avoid: see recipes/02-npc)' : '';
  (part ? drawIdx : idx).push(`- [\`engine.${p.name}\`](${link(p.name)}) ${fs.map(f => f.name + '()').join(' / ')} ${label}${need ? ` (${need})` : ''}${ns ? ': ' + ns : ''}${extraTypes}${npcNote}`);
}
idx.push('', '## Custom drawing (only to replace how a module draws: the facades above are the entry; `engine.use(mine, { replaces })`, recipe 28 §6)', ...drawIdx);

// ---------- content vocabulary (generated from modules/content/rules.js, not copied by hand) ----------
{
  const { CONDITIONS, ALL_EFFECTS, REFS } = await import(pathToFileURL(abs(CONTENT_RULES_REL)).href);
  const { sectionDocs } = await import(pathToFileURL(abs(METADATA_REL)).href);
  const row = ([k, d]) => `  - \`${k}\` ${REFS[d.ref] ?? d.ref}: ${d.desc}`;
  pages.get('content').push('', '## Condition words / effect words in content files (generated from modules/content/rules.js)',
    'Conditions are used in quest step done, dialogue option if and line variant if; effects in dialogue do, quest reward and trigger zone onEnter / onExit. ' +
    'Several entries in one object = all must hold / run in order; an array works too. ' +
    'A game\'s own condition words go in content/rules.js (or content.condition); a game\'s own actions are ops, called with { op: [...] } ' +
      '(recipes/23-ops.md). ' +
    'The format of actions.js and how to write loading are in recipes/20-content-actions-save.md.',
    '- Condition words:', ...Object.entries(CONDITIONS).map(row), '- Effect words:', ...Object.entries(ALL_EFFECTS).map(row),
    '- Files content/ recognizes:', ...Object.entries(sectionDocs).map(([k, d]) => `  - \`${k}.js\` ${d}`),
    '  - any other `<name>.js` the game registers in content/rules.js as '
      + 'kinds: { name: { desc, load?(e, data), check?, map? } } (enemies, recipes, loot tables…)');
}

// ---------- Utility functions ----------
{
  const L = page('tools', 'Utility functions (imported from threedog)');
  const used = new Set(['createEngine', 'openWorld', 'THREE', ...factories.map(f => f.name)]);
  for (const f of indexFns) if (!used.has(f.name)) L.push(fnLine(f.name));
  for (const f of indexFns) shown.add(f.name);   // entry functions are all written already (module functions are on module pages)
  L.push('- `THREE` — three.js itself (any): `import { THREE } from \'threedog\'`');
  structs(L, 'tools');
  // Exported classes and functions not written above (index.d.ts exports every declaration of types/*.d.ts with export *)
  const exported = n => n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  const rest = [...decls].filter(([name,
    [n]]) => !shown.has(name) && exported(n) && (!n.getSourceFile().fileName.startsWith(GEN) || reexported.has(name))
      && (ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)));
  if (rest.length) {
    L.push('', '## Other exported classes and functions');
    for (const [name, [n]] of rest) {
      if (ts.isClassDeclaration(n)) renderStruct(L, name);
      else L.push(`- \`${sig(name, n)}\`${docOf(n).text ? ' — ' + full(docOf(n).text) : ''}`);
    }
  }
}
idx.push('', '## Other');
idx.push(`- [Utility functions](${link('tools')}): ${indexFns.filter(f => !['createEngine', 'openWorld'].includes(f.name) && !factories.includes(f)).map(f => f.name).slice(0, 24).join(' ')} …`);
idx.push('');

// ---------------------------------------------------------------------
// Write out / check
// ---------------------------------------------------------------------
// llms.txt at the package root (llmstxt.org convention): where an AI starts, the reading order, then AI.md's task table by domain (the same rows threedog how
// searches and falls back to, read by one parser, aiTable; no second hand-written list) and one line per recipe from its title
const LLMS = join(ENGINE, 'llms.txt');
const llms = ['# threedog', '', '> A web 3D game engine on three.js 0.187 (plain three.js, no React): core and modules installed with engine.use. ' +
  'It ships no art: each game draws its own picture (plain three.js in its picture/ folder, and assets).', '',
  "Taking over a game: its status notes first. A new feature: docs/AI.md or threedog how, then the recipe, then docs/api/<module>.md.", '',
  '## Start', '', '- [AI.md](docs/AI.md): entry table, commands, verification rules, conventions',
    '- [API.md](docs/API.md): API index; one page per module in docs/api/', '',
  ...[...new Set(aiTable(join(ENGINE, 'docs')).filter(r => r.domain).map(r => r.domain))].flatMap(d => [`## ${d}`, '',
    ...aiTable(join(ENGINE, 'docs')).filter(r => r.domain === d && r.where).map(r => `- ${r.task.replace(/`/g, '')}: docs/${r.where}`), '']),
  '## Recipes', '', ...recipeNames.map(r => `- [${r}](docs/recipes/${r}.md): ${readFileSync(join(abs(RECIPES_REL), r + '.md'), 'utf8').split('\n')[0].replace(/^#\s*/, '')}`), ''].join('\n');
// COMMANDS.md: the dev bridge rows come from the command table, the rest of the page is hand-written
const COMMANDS_DOC = join(ENGINE, 'docs/COMMANDS.md');
const bridgeRows = ['| Command | What it does |', '|---|---|', ...Object.entries({ ...COMMANDS, ...EXTRA_COMMANDS }).filter(([c]) => !c.startsWith('picture-'))
  .map(([c, text]) => `| \`threedog ${c}\` | ${text.replaceAll('|', '\\|')} |`)].join('\n');
const commandsDoc = readFileSync(COMMANDS_DOC, 'utf8').replace(/(<!-- rows written by .*-->\n)[^]*?(<!-- end of generated rows -->)/, (_, top, end) => `${top}${bridgeRows}\n${end}`);
const outputs = new Map([[OUT, idx.join('\n')], [LLMS, llms], [COMMANDS_DOC, commandsDoc]]);
for (const [file, lines] of pages) outputs.set(join(PAGES, file + '.md'), [...lines, ''].join('\n'));
const relp = f => f.slice(ROOT.length + 1);
if (OPT.check) {
  const stale = [...outputs].filter(([f, c]) => (existsSync(f) ? readFileSync(f, 'utf8') : '') !== c).map(([f]) => relp(f));
  const extra = existsSync(PAGES) ? readdirSync(PAGES).map(f => join(PAGES, f)).filter(f => !outputs.has(f)).map(relp) : [];
  if (stale.length || extra.length) { console.log(`✗ API docs are not up to date (${[...stale, ...extra].join(', ')}), run npm run map`); process.exit(1); }
  console.log(`✓ API docs are up to date (${API_MD_REL} + ${API_DIR_REL}/ ${pages.size} pages)`);
} else {
  rmSync(PAGES, { recursive: true, force: true });
  mkdirSync(PAGES, { recursive: true });
  for (const [f, c] of outputs) writeFileSync(f, c);
  const n = c => c.split('\n').length;
  console.log(`Generated ${API_MD_REL} (${n(outputs.get(OUT))} lines) + ${API_DIR_REL}/ ${pages.size} pages (${[...pages.keys()].map(k => `${k} ${n(outputs.get(join(PAGES, k + '.md')))}`).join(', ')})`);
  if (OPT.report && missingDocs.length) console.log('Methods without a description: ' + [...new Set(missingDocs)].join(', '));
}
