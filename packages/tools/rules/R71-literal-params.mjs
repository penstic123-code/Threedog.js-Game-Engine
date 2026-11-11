// Detection: R71 a parameter that takes one of a few named strings lists the same strings in the code's JSDoc and in the hand-written d.ts (error).
// `@param {'far' | 'fov' | 'sunDir'} key` on a function in engine code is compared with the parameter of the same name on every d.ts function or method of the
// same name whose type is a union of string literals (written in place, or a `type X = 'a' | 'b'` alias). When the d.ts has such a parameter and none of
// them has exactly the JSDoc's strings, the two copies have drifted: the editor refuses a value the code takes (autoView.manual('sunDir') did), or offers
// one the code throws on. R6 keeps option KEYS equal the same way; this is the same rule for string VALUES.
// Known limits: matched by function name and parameter name, not by owner, so two same-named methods with different sets pass when each set is somewhere in
// the d.ts; a d.ts parameter typed string (or by a type this rule cannot read) is not compared; option fields are not read, only parameters.
import { ts, parse, visit, lineOf, engineFiles, dtsFiles } from './_lib.mjs';

/** 'a' | 'b' -> ['a', 'b'] (sorted), null when the text is anything else. Two or more literals: one literal is a tag, not a choice */
export function literalSet(text) {
  const parts = text.replace(/^\(|\)$/g, '').split('|').map(s => s.trim()), out = [];
  for (const p of parts) { const m = /^(['"])([^'"]*)\1$/.exec(p); if (!m) return null; out.push(m[2]); }
  return out.length > 1 ? [...new Set(out)].sort() : null;
}

/** @param {{ file: string, line: number, fn: string, param: string, set: string[] }[]} js the JSDoc side
 *  @param {{ fn: string, param: string, set: string[] }[]} dts the d.ts side */
export function literalProblems(js, dts) {
  const out = [], key = (/** @type {{ fn: string, param: string }} */ x) => `${x.fn}(${x.param})`, sets = new Map();
  for (const d of dts) (sets.get(key(d)) ?? sets.set(key(d), []).get(key(d))).push(d.set.join('|'));
  for (const j of js) {
    const found = sets.get(key(j));
    if (!found || found.includes(j.set.join('|'))) continue;
    const quote = (/** @type {string[]} */ s) => s.map(v => `'${v}'`).join(' | ');
    out.push({ level: /** @type {const} */ ('error'), file: j.file, line: j.line, msg: `${j.fn}(${j.param}) takes ${quote(j.set)} in the code's JSDoc, the d.ts says ${found.map(f => quote(f.split('|'))).join(' or ')}`,
      fix: 'make the d.ts parameter list the same strings (or correct the JSDoc if the code does not take them)' });
  }
  return out;
}

const nameOf = n => n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : null;

/** JSDoc @param string choices of every named function / method in one engine file */
function jsSide(file) {
  const out = [];
  visit(parse(file), n => {
    if (!(ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyAssignment(n))) return;
    const fn = nameOf(n); if (!fn) return;
    for (const tag of ts.getJSDocTags(n)) {
      if (!ts.isJSDocParameterTag(tag) || !tag.typeExpression || !ts.isIdentifier(tag.name)) continue;
      const set = literalSet(tag.typeExpression.type.getText());
      if (set) out.push({ file, line: lineOf(tag), fn, param: tag.name.text, set });
    }
  });
  return out;
}

/** String choices of every d.ts function / method parameter, aliases resolved by name across the d.ts files */
function dtsSide(files) {
  const alias = new Map(), out = [];
  for (const f of files) visit(parse(f), n => { if (ts.isTypeAliasDeclaration(n)) { const s = literalSet(n.type.getText()); if (s) alias.set(n.name.text, s); } });
  for (const f of files) visit(parse(f), n => {
    if (!(ts.isMethodSignature(n) || ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertySignature(n) && n.type && ts.isFunctionTypeNode(n.type))) return;
    const fn = nameOf(n), params = ts.isPropertySignature(n) ? /** @type {any} */ (n.type).parameters : n.parameters; if (!fn) return;
    for (const p of params) {
      if (!p.type || !ts.isIdentifier(p.name)) continue;
      const t = p.type.getText(), set = literalSet(t) ?? alias.get(t);
      if (set) out.push({ fn, param: p.name.text, set });
    }
  });
  return out;
}

export default {
  id: 'R71', title: 'A parameter of named strings lists the same strings in JSDoc and d.ts', game: false,
  run() {
    const js = engineFiles().flatMap(jsSide), dts = dtsSide(dtsFiles());
    return Object.assign(literalProblems(js, dts), { note: `${js.length} JSDoc parameters of named strings, ${dts.length} in the d.ts` });
  },
};
