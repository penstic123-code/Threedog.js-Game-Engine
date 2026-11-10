// Shared parts of the API doc generator (used by packages/tools/apidoc.mjs): parsing d.ts, JSDoc and type text, member rendering, the page table.
// Split out of apidoc.mjs: this is "how to read a declaration and write one line", apidoc.mjs is "which pages to generate and what goes on each".
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT, abs, API_MD_REL, API_DIR_REL, TYPES_REL, TYPES_GEN_REL, INDEX_DTS_REL } from '../paths.mjs';

export { ROOT };
export const OUT = abs(API_MD_REL), PAGES = abs(API_DIR_REL);
export const TYPES = abs(TYPES_REL);
// Hand-written declarations + declarations generated from JSDoc (types/generated/, see gentypes.mjs; the directory mirrors the engine source, so
//   search recursively)
function walkDts(d) {
  if (!existsSync(d)) return [];
  const list = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return list.flatMap(e => e.isDirectory() ? walkDts(join(d, e.name)) : e.name.endsWith('.d.ts') ? [join(d, e.name)] : []);
}
export const GEN = abs(TYPES_GEN_REL).replace(/\\/g, '/');   // file names in the d.ts syntax tree are /-separated
export const files = [abs(INDEX_DTS_REL), ...readdirSync(TYPES).filter(f => f.endsWith('.d.ts')).sort().map(f => join(TYPES, f)), ...walkDts(GEN)];

// ---------------------------------------------------------------------
// Parsing: name → declaration nodes (interface / class / type / function / const)
// ---------------------------------------------------------------------
export const decls = new Map();          // name → [nodes…] (overloaded functions have several)
export const indexFns = [];              // exported functions/constants of index.d.ts in order [{ name, nodes, section }]
// Functions/constants in the generated declarations: name → node. `export { a, b } from './types/generated/…'` in index.d.ts is merged into indexFns
//   in its order,
// and treated like hand-written declarations
const genFns = new Map();
for (const f of files.filter(f => f.replace(/\\/g, '/').startsWith(GEN))) {
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    const name = ts.isFunctionDeclaration(st) ? st.name?.text : ts.isVariableStatement(st) ? st.declarationList.declarations[0].name.text : null;
    if (name) genFns.set(name, [...(genFns.get(name) || []), st]);
  }
}
export const reexported = new Set();     // names index.d.ts re-exports (the public API)
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  const isIndex = f === abs(INDEX_DTS_REL);
  for (const st of sf.statements) {
    if (isIndex && ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (!st.isTypeOnly && !el.isTypeOnly) reexported.add(el.name.text);
        const orig = (el.propertyName ?? el.name).text;
        if (!st.isTypeOnly && !el.isTypeOnly && genFns.has(orig)) indexFns.push({ name: el.name.text, nodes: genFns.get(orig) });
      }
      continue;
    }
    let name = null;
    if (ts.isInterfaceDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isFunctionDeclaration(st)) name = st.name?.text;
    else if (ts.isVariableStatement(st)) name = st.declarationList.declarations[0].name.text;
    if (!name) continue;
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push(st);
    if (isIndex && (ts.isFunctionDeclaration(st) || ts.isVariableStatement(st))) {
      const last = indexFns[indexFns.length - 1];
      if (last?.name === name) last.nodes.push(st); else indexFns.push({ name, nodes: [st] });
    }
  }
}
export const shown = new Set();          // names already written into the quick reference (leftover exported classes and functions are added at the end)
export const get = name => { const d = decls.get(name)?.[0]; if (!d) throw new Error(`apidoc: type ${name} not found`); shown.add(name); return d; };

// ---------------------------------------------------------------------
// JSDoc and type text
// ---------------------------------------------------------------------
export const clean = s => String(s ?? '').replace(/\s*\n\s*\*?\s*/g, ' ').replace(/\|/g, '/').trim();
export function docOf(node) {
  const d = (node.jsDoc || [])[node.jsDoc?.length - 1];
  if (!d) return { text: '', example: '' };
  const exp = (d.tags || []).some(t => t.tagName.text === 'experimental');   // badge: the API may still change (AI.md "Stability")
  const text = (exp ? '(experimental) ' : '') + clean(ts.getTextOfJSDocComment(d.comment));
  const ex = (d.tags || []).find(t => t.tagName.text === 'example');
  return { text, example: ex ? clean(ts.getTextOfJSDocComment(ex.comment)) : '' };
}
// After truncation, if brackets no longer pair up ("ground type (terrain name"), fall back to before the opening bracket
export function balance(t) {
  for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) {
    if (t.split(o).length > t.split(c).length) { const i = t.lastIndexOf(o); const cut = t.slice(0, i).trim(); t = cut || t; }
  }
  return t;
}
const SENTENCE_END = /\.(?=\s+[A-Z`(])|\.$/;   // first sentence: up to the first ". " followed by a capital letter (so e.g. does not end it) or the end; if still too long, cut at ";"
export function first(s, max = 160) {
  let t = s.split(SENTENCE_END)[0];
  if (t.length > max && t.includes(';')) t = balance(t.split(';')[0]);
  return t.length > max + 30 ? balance(t.slice(0, max + 29)) + '…' : t;
}
// Used in pages: the whole description, truncated only if too long
// Too long is cut at a sentence end (pages never show half a sentence); only a first sentence that is itself too long is hard-cut
export function full(s, max = 900) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max), m = [...cut.matchAll(/\.(?=\s)/g)].at(-1), i = m ? m.index : -1;
  return i > 0 ? cut.slice(0, i + 1) : balance(cut.slice(0, max - 1)) + '…';
}
// When ". Example: …" follows, drop the sentence-final period to avoid ".."
const noEnd = s => s.replace(/\.$/, '');
// Short description for the index lines, up to the first "," / ";"
export const brief = s => { const t = balance(first(s, 70).split(/[,;]/)[0]); return t.length > 56 ? balance(t.slice(0, 55)) + '…' : t; };

export const raw = n => n.getText().replace(/\s+/g, ' ').replace(/;\s*\}/g, ' }');
// Type simplification: an over-long object is written as { a, b, … }, a function as (parameter names) => return
export function typeText(n, max = 40) {
  if (!n) return 'any';
  const t = raw(n);
  if (t.length <= max) return t;
  if (ts.isTypeLiteralNode(n)) {
    const names = n.members.map(m => m.name ? m.name.getText() + (m.questionToken ? '?' : '') : m.getText().startsWith('[') ? '…' : '').filter(Boolean);
    const s = names.slice(0, 6).join(', ');
    return `{ ${s}${names.length > 6 ? ', …' : ''} }`;
  }
  if (ts.isFunctionTypeNode(n)) return `(${n.parameters.map(p => p.name.getText()).join(', ')}) => ${typeText(n.type, 20)}`;
  if (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n)) {
    const sep = ts.isUnionTypeNode(n) ? ' | ' : ' & ';
    const parts = n.types.map(x => typeText(x, 24));
    const s = parts.join(sep);
    return s.length <= max + 20 ? s : parts.slice(0, 3).join(sep) + sep + '…';
  }
  if (ts.isParenthesizedTypeNode(n)) return `(${typeText(n.type, max)})`;
  if (ts.isArrayTypeNode(n)) return typeText(n.elementType, max) + '[]';
  if (ts.isIndexedAccessTypeNode(n) && t.length <= 40) return t;
  return t.slice(0, max - 1) + '…';
}
export const params = ps => ps.map(p => `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${p.questionToken ? '?' : ''}: ${typeText(p.type, 36)}`).join(', ');
export const ret = n => { if (!n) return ''; const t = typeText(n, 34); return /^(void|this)$/.test(t) ? '' : ` → ${t}`; };
export const sig = (name, n) => `${name}(${params(n.parameters)})${ret(n.type)}`;

// ---------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------
// Methods without a description are internal per-frame ones of the module; the docs do not list them
export const INTERNAL = new Set(['update', 'tick', 'apply', 'init', 'step', 'refreshLevels', 'registerSpecies',
  'forEachCollider', 'chunkCollision', 'animate', 'buildChunk', 'place', 'setSize', 'setPixelRatio', 'render']);
export const missingDocs = [];

export function members(node) {
  if (ts.isTypeAliasDeclaration(node)) return ts.isTypeLiteralNode(node.type) ? node.type.members : [];
  return node.members || [];
}
// A @deprecated alias or an @internal member is not listed: the pages teach the current name, and the CHANGELOG lists every rename
const hidden = m => (m.jsDoc || []).some(d => (d.tags || []).some(t => t.tagName.text === 'deprecated' || t.tagName.text === 'internal'));
// Interface members are split into methods (overloads merged) and properties
export function split(node, owner) {
  const methods = new Map(), props = [];
  for (const m of members(node)) {
    if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration?.(m) || ts.isIndexSignatureDeclaration(m)) continue;
    const name = m.name?.getText();
    if (!name || hidden(m)) continue;
    const isMethod = ts.isMethodSignature(m) || ts.isMethodDeclaration(m);
    const doc = docOf(m);
    if (isMethod) {
      if (!methods.has(name)) methods.set(name, { name, sigs: [], doc: doc.text, example: doc.example });
      const e = methods.get(name);
      e.sigs.push(m);
      if (!e.doc) e.doc = doc.text;
    } else props.push({ name, optional: !!m.questionToken, readonly: m.modifiers?.some(x => x.kind === ts.SyntaxKind.ReadonlyKeyword),
      type: m.type, doc: doc.text, example: doc.example, node: m });
  }
  for (const e of methods.values()) if (!e.doc && !INTERNAL.has(e.name)) missingDocs.push(`${owner}.${e.name}()`);
  return { methods: [...methods.values()], props };
}
export const ext = node => node.heritageClauses ? node.heritageClauses.flatMap(h => h.types.map(t => raw(t))).join(', ') : '';
export function methodLine(prefix, e, indent = '') {
  let line = `${indent}- \`${sig(prefix + e.name, e.sigs[0])}\``;
  if (e.sigs.length > 1) line += ` / \`${e.sigs.slice(1).map(s => sig(e.name, s)).join('` / `')}\``;
  if (e.doc) line += ` — ${e.example ? noEnd(full(e.doc)) : full(e.doc)}`;
  if (e.example) line += `${e.doc ? '. ' : ' '}Example: \`${e.example}\``;
  return line;
}
// Fields: one line each, with type and full description
export function fieldLines(props, indent = '  ') {
  return props.map(p => {
    const fns = p.type && ts.isTypeLiteralNode(p.type) && p.type.members.every(m => ts.isMethodSignature(m)) ? ` (${p.type.members.map(m => m.name.getText() + '()').join(' ')})` : '';
    return `${indent}- \`${p.name}${p.optional ? '?' : ''}: ${typeText(p.type, 60)}\`${p.doc ? ' ' + (p.example ? noEnd(full(p.doc, 360)) : full(p.doc, 360)) : ''}${fns}${p.example ? `${p.doc ? '. ' : ' '}Example: \`${p.example}\`` : ''}`;
  });
}
export function renderApi(lines, typeName, prefix, { skipProps = [] } = {}) {
  const { methods, props } = split(get(typeName), typeName);
  for (const e of methods.filter(e => e.doc)) lines.push(methodLine(prefix, e));
  const bare = methods.filter(e => !e.doc && !INTERNAL.has(e.name));
  if (bare.length) lines.push(`- Also: ${bare.map(e => '`' + sig(prefix + e.name, e.sigs[0]) + '`').join(', ')}`);
  const ps = props.filter(p => !skipProps.includes(p.name) && (p.doc || p.readonly));
  if (ps.length) lines.push('- Properties:', ...fieldLines(ps));
  return { methods, props };
}
export function renderOptions(lines, typeName, label = 'Options') {
  if (!decls.has(typeName)) return;
  const node = get(typeName);
  const { props } = split(node, typeName);
  const x = ext(node);
  lines.push(`- ${label} \`${typeName}\`${x ? ` (also includes the fields of ${x})` : ''}${props.length ? ':' : ''}`, ...fieldLines(props));
}
export function renderStruct(lines, typeName) {
  const node = get(typeName);
  const d = docOf(node).text;
  if (!d) missingDocs.push(`${typeName} (the type itself)`);
  if (ts.isTypeAliasDeclaration(node) && !ts.isTypeLiteralNode(node.type)) { lines.push(`- **${typeName}** = \`${typeText(node.type, 160)}\`${d ? ' — ' + full(d) : ''}`); return; }
  const { methods, props } = split(node, typeName);
  const x = ext(node);
  lines.push(`- **${typeName}**${x ? ` (extends ${x})` : ''}${d ? ' ' + full(d) : ''}`, ...fieldLines(props));
  for (const e of methods) lines.push(methodLine('', e, '  '));
}
// One line in the index: the list of method names
export const names = (typeName, max = 14) => {
  const { methods } = split(get(typeName), typeName);
  const ns = methods.filter(e => e.doc || !INTERNAL.has(e.name)).map(e => e.name);
  return ns.length > max ? ns.slice(0, max).join(' ') + ' …' : ns.join(' ');
};

// ---------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------
export const pages = new Map();   // file name (without .md) → lines
export function page(file, title) {
  const lines = [`# ${title}`, ''];
  pages.set(file, lines);
  return lines;
}
export const link = file => `api/${file}.md`;
export const fnLine = name => {
  const nodes = indexFns.find(x => x.name === name).nodes;
  const doc = docOf(nodes[0]).text;
  if (ts.isVariableStatement(nodes[0])) { const d = nodes[0].declarationList.declarations[0]; return `- \`${name}: ${typeText(d.type, 50)}\`${doc ? ' — ' + full(doc) : ''}`; }
  return `- \`${sig(name, nodes[0])}\`${nodes.length > 1 ? ' / …' : ''}${doc ? ' — ' + full(doc) : ''}`;
};
export const idx = [];            // packages/engine/docs/API.md

// Data structures attached to each page
const STRUCTS = {
  engine: ['Handle', 'StateParams', 'StartupReport'], calendar: ['CalendarAtOptions', 'CalendarBetweenOptions'],
    collision: ['CircleColliderOptions', 'BoxColliderOptions'], budget: ['BudgetLimits', 'BudgetReport', 'BudgetOver'],
  audio: ['AudioConfig', 'SoundDef', 'AmbienceRule'], rays: ['RaycastOptions', 'RayHit'], stream: ['StreamEntryOptions', 'StreamHandle'], saves: ['SaveProvider'],
  assets: ['AssetManifest', 'AnimatorOptions', 'AnimatorState', 'Animator'],
  dialogue: ['DialogueScript', 'DialogueNode', 'DialogueChoice', 'DialogueState'],
  characters: ['NPCOptions', 'ScheduleStop', 'ScheduleEntry', 'PlayerOptions', 'CharacterOptions', 'FindSpawnOptions'],
  inventory: ['ItemDef', 'PickupOptions', 'PickupHandle'], quests: ['QuestDef', 'QuestStep'], triggers: ['TriggerOptions', 'Trigger'],
  particles: ['ParticleOptions', 'ParticleEmitter'],
  swarm: ['SwarmOptions', 'Swarm'],
  interactions: ['InteractionOptions'], rigid: ['RigidBodyOptions', 'RigidEntry', 'VehicleOptions', 'VehicleWheel', 'Vehicle'],
  flow: ['FlowStateDef', 'FlowTransitionOptions'], content: ['ContentConditionDef'], hud: ['HudMarkerOptions', 'HudMarker', 'HudAnchor'],
  hlod: ['HlodAddOptions', 'HlodCell', 'HlodHandle'], lightPool: ['LightSourceOptions', 'LightSourcePatch', 'LightSource'], water: ['WaterBodyOptions', 'WaterBody'],
    vegetation: ['VegetationOptions', 'VegetationRule'], terrain: ['FlattenZone'],
  post: ['PostEffect'], cameraRig: ['CameraShot'], music: ['MusicRule'], settings: ['SettingsSection'], level: ['LevelMarker'],
  timeline: ['TimelinePlayOptions', 'CameraPose'], tools: ['WindowOptions', 'UIWindow', 'ScreenPoint'],
};
export const structs = (lines, file) => { const list = STRUCTS[file]; if (!list) return; lines.push('',
  '## Data structures'); for (const n of list) renderStruct(lines, n); };
