// R2 unused exports: a name exported in packages/engine/ that no file in the project (engine, examples, tests, tools) imports,
// and that packages/engine/index.js does not export (so it is not public API) → warning. A stray export makes the AI think it is usable API.
// Criteria: collect each file's import { a as b } from 'path' / export { a } from / export * from via the syntax tree, resolve the path to a file, and record which names of whom are used.
//   import * as ns and dynamic import(): any name in the target file that appears as a same-named word in the importer counts as used (conservative, no false positives).
//   const { a, b } = await import(<computed path>): tools load engine files by a path built at run time (pathToFileURL(abs(...))), which cannot be
//   resolved to a file; the destructured names count as used in every engine file (conservative: a same-named export elsewhere also passes).
//   `(await load(file)).name` in a tool counts the same way.
// Convention: a module's implementation class (export class Sky) pairs one-to-one with the same-named interface type in the d.ts; exporting it eases cross-reference, so it is not reported (only classes without a same-named type in the d.ts are).
// Limitation: another project (a game repo) importing engine internals directly is invisible here.
import { ts, parse, visit, engineFiles, projectFiles, resolveImport, lineOf, read, strValue, dtsFiles, E, P } from './_lib.mjs';

// Allowlist: [file, name or '*', reason]
const ALLOW = [
  [E('index.js'), '*', 'the entry file exports the public API'],
  [E('modules/terrain/chunkWorker.js'), '*', 'Worker entry, loaded through new Worker'],
  // The content vocabulary is for Node tools: content-check/load.mjs imports it dynamically via the path in paths.mjs (the path is not hard-coded), so static analysis cannot see it
  [P.CONTENT_RULES_REL, 'CLOCK_RE', 'tools (content check, game map) import it dynamically'],
  [P.CONTENT_RULES_REL, 'mergeRules', 'tools (content check, game map) import it dynamically'],
  [P.CONTENT_RULES_REL, 'describeCond', 'tools (content check, game map) import it dynamically'],
  [P.CONTENT_RULES_REL, 'describeEffect', 'tools (content check, game map) import it dynamically'],
  [E('core/ops/sharedPoint.js'), 'LAYERS', 'tools/tests/stacks.mjs reads the layer table from this source text (it must stay exported here)'],
  [E('core/engine/moduleTypes.js'), 'MODULE_TYPES', 'R47 reads the type table from this source text (export const MODULE_TYPES)'],
  [E('core/scene/pixel.js'), '*', 'public subpath threedog/pixel (package.json exports ./pixel), not through index.js'],
  [E('modules/vegetation/draw.js'), 'drawnPlants', 'tools/tests/vegetation-thin.mjs loads it through load(), which the import scan does not resolve'],
];

function exportsOf(sf) {
  const out = [];   // { name, node }
  const exported = n => n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && exported(s) && s.name) out.push({ name: s.name.text, node: s });
    else if (ts.isVariableStatement(s) && exported(s)) for (const d of s.declarationList.declarations) { if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, node: d }); }
    else if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) for (const el of s.exportClause.elements) out.push({ name: el.name.text, node: el });
  }
  return out;
}

export default {
  id: 'R2', title: 'Unused exports',
  run() {
    const used = new Map();          // file → Set(names); '*' means all
    const loose = new Map();         // file → [importer files] (namespace / dynamic import)
    const mark = (f, n) => { if (!used.has(f)) used.set(f, new Set()); used.get(f).add(n); };
    const dynNames = new Set();      // names destructured from import(<computed path>), target unknown
    const isImportCall = x => x && ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword;
    for (const file of projectFiles()) {
      const sf = parse(file);
      visit(sf, n => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
          const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : null;
          if (isImportCall(init) && strValue(init.arguments[0]) == null)
            for (const el of n.name.elements) { const k = el.propertyName ?? el.name; if (ts.isIdentifier(k)) dynNames.add(k.text); }
        }
        if (ts.isPropertyAccessExpression(n) && file.startsWith(P.TOOLS_REL + '/')) {
          let e = n.expression; while (ts.isParenthesizedExpression(e)) e = e.expression;
          if (ts.isAwaitExpression(e) && ts.isCallExpression(e.expression)) dynNames.add(n.name.text);
        }
        let spec = null, clause = null, star = false, dyn = false;
        if (ts.isImportDeclaration(n)) { spec = strValue(n.moduleSpecifier); clause = n.importClause; }
        else if (ts.isExportDeclaration(n) && n.moduleSpecifier) { spec = strValue(n.moduleSpecifier); star = !n.exportClause; clause = n.exportClause; }
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) { spec = strValue(n.arguments[0]); dyn = true; }
        if (!spec) return;
        const target = resolveImport(file, spec);
        if (!target) return;
        if (star) return mark(target, '*');
        if (dyn) { if (!loose.has(target)) loose.set(target, []); loose.get(target).push(file); return; }
        if (!clause) return;
        if (ts.isImportClause(clause)) {
          if (clause.name) mark(target, 'default');
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) { if (!loose.has(target)) loose.set(target, []); loose.get(target).push(file); }
          else if (nb) for (const el of nb.elements) mark(target, (el.propertyName || el.name).text);
        } else if (ts.isNamedExports(clause)) for (const el of clause.elements) mark(target, (el.propertyName || el.name).text);
      });
    }
    const dtsTypes = new Set(dtsFiles().flatMap(f => [...read(f).matchAll(/(?:class|interface)\s+(\w+)/g)].map(m => m[1])));
    const out = [];
    for (const file of engineFiles()) {
      if (ALLOW.some(([f, n]) => f === file && n === '*')) continue;
      const sf = parse(file), u = used.get(file) || new Set();
      if (u.has('*')) continue;
      const text = read(file);
      for (const { name, node } of exportsOf(sf)) {
        if (ts.isClassDeclaration(node) && dtsTypes.has(name)) continue;
        if (u.has(name) || dynNames.has(name) || ALLOW.some(([f, n]) => f === file && n === name)) continue;
        if ((loose.get(file) || []).some(g => new RegExp(`\\b${name}\\b`).test(read(g)))) continue;
        const selfUse = (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1;
        out.push({ level: 'warn', file, line: lineOf(node), msg: `exports ${name}, but no file in the project imports it and packages/engine/index.js does not export it`,
          fix: selfUse ? `drop the export (only used inside this file)` : `${name} is not used anywhere, delete it` });
      }
    }
    return out;
  },
};
