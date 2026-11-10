// Shared helpers for rules: project paths, file walking, syntax trees (TypeScript parses JS / d.ts), line numbers, allowlist comments.
// One file per rule, packages/tools/rules/Rxx-name.mjs, exporting default { id, title, run(ctx) }; run returns [{ level: 'error'|'warn', file, line, msg, fix }].
// packages/tools/check.mjs calls them all and prints the results grouped by rule.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import ts from 'typescript';
import * as P from '../paths.mjs';
import { ROOT, rel, abs } from '../paths.mjs';
import { walk as walkFiles } from '../lib/text.mjs';

// The game folders once per run: R18 asks for every code span of every doc, and each P.gameDirs() lists the folders again (about half of a whole check)
let gameRels = null;
/** How hard a doc finding lands: a game's own docs (a plan names files that do not exist yet, docs cannot break a game) warn, engine docs fail */
export const docLevel = doc => P.MODE === 'game' || /^games\//.test(doc) || (gameRels ??= P.gameDirs().map(d => `${rel(d)}/`)).some(d => doc.startsWith(d)) ? 'warn' : 'error';

export { ts, ROOT, rel, abs, P };

/** Does this object literal node have a property of that name */
export const hasProp = (obj, name) => obj.properties.some(p => p.name?.getText() === name);
/** The parameter names a module factory takes its options under */
export const OPT_NAMES = new Set(['opts', 'options', 'all']);
/** The function around node n (the module factory of a module definition), methods skipped */
export function factoryOf(n) { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) && !ts.isMethodDeclaration(p)) return p; return null; }

const walked = new Map();
/** Recursively list files (paths relative to ROOT); exts is an array of suffixes. Listed once per run, since the rules ask for the same folders again and again: treat the list as read-only */
export function walk(dir, exts = ['.js']) {
  const key = `${dir}|${exts}`;
  if (!walked.has(key)) walked.set(key, walkFiles(abs(dir), { exts: { test: p => exts.some(e => p.endsWith(e)) } }).map(rel));
  return walked.get(key);
}

const textCache = new Map();
export function read(file) {
  if (!textCache.has(file)) textCache.set(file, readFileSync(abs(file), 'utf8'));
  return textCache.get(file);
}
// CRLF too: with a trailing \r every `//(.*)$` comment match failed (. does not cross \r), so comment switches such as R40's hint-off were ignored in Windows files
export const lines = file => read(file).split(/\r?\n/);

const sfCache = new Map();
/** Syntax tree (.js is parsed as JS, .d.ts/.ts as TS) */
export function parse(file) {
  if (!sfCache.has(file)) {
    const kind = /\.(m?js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    sfCache.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind));
  }
  return sfCache.get(file);
}
/** Line number of a node (1-based) */
export const lineOf = node => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** Depth-first walk over all nodes */
export function visit(node, fn) { (function go(n) { fn(n); ts.forEachChild(n, go); })(node); }

/** Engine source: index.js + the .js files under core modules render ui (directories in paths.mjs) */
export const engineFiles = () => [P.INDEX_JS_REL, ...P.ENGINE_CODE_DIRS_REL.flatMap(d => walk(d, ['.js']))];
/** API declarations (packages/engine/index.d.ts + packages/engine/types/*.d.ts) */
export const dtsFiles = () => [P.INDEX_DTS_REL, ...walk(P.TYPES_REL, ['.d.ts'])].filter(f => existsSync(abs(f)));
/** All project source: engine, add-ons, examples, engine tests, tools, games/* (picture/ folders included) (scope: SOURCE_DIRS_REL in paths.mjs) */
export const projectFiles = (exts = ['.js', '.mjs']) => [...(exts.some(e => P.INDEX_JS_REL.endsWith(e)) ? [P.INDEX_JS_REL] : []), ...P.SOURCE_DIRS_REL.flatMap(d => walk(d, exts))];

/**
 * Allowlist comment: a // comment on this line or the previous one that names one of the tags (e.g. // presentation, // measure) lets the line through.
 * tags is an array of strings; returns the matched tag or null.
 */
export function lineTag(file, line, tags) {
  const L = lines(file);
  for (const n of [line, line - 1]) {
    const s = L[n - 1] || '';
    const c = s.match(/\/\/(.*)$/)?.[1] || s.match(/\/\*(.*?)\*\//)?.[1];
    if (!c) continue;
    if (n === line - 1 && !/^\s*(\/\/|\/\*)/.test(s)) continue;   // the previous line only counts if it is a whole-line comment
    const hit = tags.find(t => c.includes(t));
    if (hit) return hit;
  }
  return null;
}

/** Strip the // comment and string contents of a line (keeping the quotes), for matching code with regexes */
export function codeOnly(line) {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '$1$1').replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

/** Value of a string literal ('x', "x", a template without substitutions), else null */
export function strValue(n) {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** The initializer node of const NAME = <init> in the same file */
export function constInit(sf, name) {
  let found = null;
  visit(sf, n => { if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer; });
  return found;
}

/** Property names (strings) of an object literal; follows ...X by resolving X in the same file */
export function objectKeys(sf, node, depth = 0) {
  const keys = [];
  if (!node || depth > 5) return { keys, complete: false };
  if (ts.isIdentifier(node)) return objectKeys(sf, constInit(sf, node.text), depth + 1);
  if (!ts.isObjectLiteralExpression(node)) return { keys, complete: false };
  let complete = true;
  for (const p of node.properties) {
    if (ts.isSpreadAssignment(p)) { const r = objectKeys(sf, p.expression, depth + 1); keys.push(...r.keys); complete &&= r.complete; continue; }
    const k = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : null;
    if (k != null) keys.push(k); else complete = false;
  }
  return { keys, complete };
}

/** Values of a string array literal: supports ...X, ...Object.keys(X) and same-file constants */
export function stringArray(sf, node, depth = 0) {
  const vals = [];
  if (!node || depth > 5) return { vals, complete: false };
  if (ts.isIdentifier(node)) return stringArray(sf, constInit(sf, node.text), depth + 1);
  if (ts.isCallExpression(node) && node.expression.getText() === 'Object.keys') { const r = objectKeys(sf, node.arguments[0], depth + 1); return { vals: r.keys, complete: r.complete }; }
  if (ts.isPropertyAccessExpression(node)) {   // STEP_KEYS.step
    const base = constInit(sf, node.expression.getText());
    if (base && ts.isObjectLiteralExpression(base)) {
      const p = base.properties.find(p => p.name?.getText() === node.name.text);
      if (p && ts.isPropertyAssignment(p)) return stringArray(sf, p.initializer, depth + 1);
    }
    return { vals, complete: false };
  }
  if (!ts.isArrayLiteralExpression(node)) return { vals, complete: false };
  let complete = true;
  for (const el of node.elements) {
    if (ts.isSpreadElement(el)) { const r = stringArray(sf, el.expression, depth + 1); vals.push(...r.vals); complete &&= r.complete; continue; }
    const v = strValue(el);
    if (v != null) vals.push(v); else complete = false;
  }
  return { vals, complete };
}

let exportsMap = null;
const engineExports = () => exportsMap ??= JSON.parse(readFileSync(join(P.ENGINE, 'package.json'), 'utf8')).exports;
/** Resolve an import path to a project file (relative paths and site paths starting with /); null if it cannot be resolved */
export function resolveImport(fromFile, spec) {
  let p;
  if (spec.startsWith('.')) p = resolve(dirname(abs(fromFile)), spec);
  else if (spec.startsWith('/')) p = join(P.workspaceOf(dirname(abs(fromFile))) ?? ROOT, spec);   // site path: relative to the workspace root
  else if (spec === P.ENGINE_PKG) p = abs(P.INDEX_JS_REL);
  else if (P.optionalEntry(spec)) p = P.optionalEntry(spec);   // an add-on package (@threedog/terrain-noise)
  else if (spec.startsWith(P.ENGINE_PKG + '/') && typeof engineExports()['.' + spec.slice(P.ENGINE_PKG.length)] === 'string') p = join(P.ENGINE, engineExports()['.' + spec.slice(P.ENGINE_PKG.length)]);   // other fixed subpaths of package.json exports (threedog/error-hints)
  else return null;
  for (const cand of [p, p + '.js', join(p, 'index.js')]) if (existsSync(cand) && statSync(cand).isFile()) return rel(cand);
  return null;
}

/** The paths one line imports: static (`from '...'`, `import '...'`) and dynamic (`import('...')`); comment lines and the // comment are skipped */
export const importSpecs = raw => /^\s*(\*|\/\*|\/\/)/.test(raw) ? []
  : [...raw.replace(/\/\/.*$/, '').matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g)].map(m => m[1]);
/** Where a relative import from a file lands in modules/: { folder, path } (path inside modules/: '<folder>/x.js'), null when it lands outside
 *  modules/ or is not relative. Resolved as a path, so '../../modules/nav/x.js' lands in nav like '../nav/x.js' (R16, R46) */
export function moduleTarget(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const to = rel(resolve(dirname(abs(fromFile)), spec));
  if (!to.startsWith(P.MODULES_REL + '/')) return null;
  const path = to.slice(P.MODULES_REL.length + 1);
  return { folder: path.split('/')[0], path };
}

/** Read d.ts with the TypeScript type checker (shared by R6 and R7) */
let program = null;
export function dtsProgram() {
  if (!program) program = ts.createProgram(dtsFiles().map(abs), { noEmit: true, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, types: [] });
  return program;
}

/**
 * The public engine surface read from the d.ts program above (shared by R18 and R22): { checker, engine (the Engine type),
 * exports (names exported by index.d.ts), namespaces ([{ name, type }]: Engine properties whose type is declared by the engine and has methods) }
 */
let api = null;
const PRIMITIVE = ts.TypeFlags.BooleanLike | ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
export function engineApi() {
  if (api) return api;
  const prog = dtsProgram(), checker = prog.getTypeChecker(), sf = prog.getSourceFile(abs(P.INDEX_DTS_REL));
  const mod = sf && checker.getSymbolAtLocation(sf);
  const exp = mod ? checker.getExportsOfModule(mod) : [];
  const sym = exp.find(s => s.name === 'Engine');
  const engine = sym && checker.getDeclaredTypeOfSymbol(sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
  const typeOf = s => { const d = s.declarations?.[0]; return d ? checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(s, d)) : null; };
  const ownType = t => { const parts = t.isUnion() ? t.types : [t]; return parts.every(x => { if (x.flags & PRIMITIVE) return false; const f = x.getSymbol()?.declarations?.[0]?.getSourceFile().fileName; return !f || !/node_modules\/(?!threedog\/)/.test(f.replace(/\\/g, '/')); }); };
  const isMethod = (s, t) => { const d = s.declarations?.[0]; return d && (ts.isMethodSignature(d) || ts.isMethodDeclaration(d) || checker.getTypeOfSymbolAtLocation(s, d).getCallSignatures().length > 0); };
  const namespaces = [];
  for (const s of engine ? checker.getPropertiesOfType(engine) : []) {
    const d = s.declarations?.[0];
    if (!d || s.name.startsWith('_') || s.getJsDocTags(checker).some(t => t.name === 'internal') || ts.isMethodSignature(d) || ts.isMethodDeclaration(d)) continue;
    const t = typeOf(s);
    if (t && ownType(t) && checker.getPropertiesOfType(t).some(m => isMethod(m, t))) namespaces.push({ name: s.name, type: t });
  }
  return (api = { checker, engine, typeOf, exports: new Set(exp.map(s => s.name)), namespaces });
}

/** Generated docs (not edited by hand, exempt from size checks etc.) */
export const GENERATED = P.GENERATED;

/** Path inside the engine package (relative to the repo root): E('modules/x.js') → 'packages/engine/modules/x.js' */
export const E = sub => `${P.ENGINE_REL}/${sub}`;
/** Regex for a path inside the engine package (source is the part after packages/engine/): reE('modules\\/debug\\/') */
export const reE = source => new RegExp(`^${P.ENGINE_REL.replace(/\//g, '\\/')}\\/${source}`);
/** Is this engine source (index.js, or under core modules render ui) */
export const isEngineCode = f => f === P.INDEX_JS_REL || P.ENGINE_CODE_DIRS_REL.some(d => P.under(f, d));
