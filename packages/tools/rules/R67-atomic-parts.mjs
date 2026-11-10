// R67 a save part says whether an atomic op covers it (error). An atomic op puts back the parts that declared atomic and nothing else, so a part that never thought about it stays
// changed while everything around it rolls back: a `once` stall stayed spent after the sale it belonged to was undone. So every engine part answers: `atomic: true`, or
// `notAtomic: '<why>'` in the words a reader of the part needs. Why static: the bug shows only on a failed op that happens to touch the part, which a test of that part never tries.
// Reads the object written at the call, so a part built elsewhere is an error too: spread it and answer next to the call.
// Known limits: a game's own parts are not asked (atomic stays their opt-in, recipe 23). The answer's truth is a promise read in review.
import { ts, parse, visit, lineOf, engineFiles } from './_lib.mjs';

/** Module ctx.saves.define passes a part it did not write on, so the part is judged at its own call */
const FORWARD = /(^|\/)core\/engine\/modules\.js$/;

/** @param {any} n a property @returns {string | null} its plain name */
const keyOf = n => (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) ? n.name.getText().replace(/['"]/g, '') : null;

/** @param {any} o a part's object @returns {string | null} what is wrong with its answer, or null */
function problem(o) {
  if (!o || !ts.isObjectLiteralExpression(o)) return 'is not an object written at the call';
  const atomic = o.properties.find(p => keyOf(p) === 'atomic'), not = o.properties.find(p => keyOf(p) === 'notAtomic');
  if (atomic && not) return 'says both atomic and notAtomic';
  if (atomic) return atomic.initializer?.kind === ts.SyntaxKind.TrueKeyword ? null : 'has an atomic that is not true: leave it out and say why in notAtomic';
  if (!not) return 'does not say whether an atomic op covers it';
  return ts.isStringLiteralLike(not.initializer) && not.initializer.text.trim() ? null : 'has a notAtomic that gives no reason';
}

/** The parts a parsed file registers with no answer, as { line, key, why } @param {any} source */
export function unanswered(source) {
  const out = [];
  visit(source, n => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'define' || !/\bsaves$/.test(n.expression.expression.getText())) return;
    const why = problem(n.arguments[1]);
    if (why) out.push({ line: lineOf(n), key: n.arguments[0]?.getText() ?? '?', why });
  });
  return out;
}

/** Same on a text (the rule test) */
export const scanText = text => unanswered(ts.createSourceFile('mod.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));

export default {
  id: 'R67', title: 'a save part says whether an atomic op covers it (atomic: true, or notAtomic: why)',
  run() {
    const out = [];
    let n = 0;
    for (const file of engineFiles()) {
      if (FORWARD.test(file)) continue;
      for (const { line, key, why } of unanswered(parse(file))) {
        out.push({ level: 'error', file, line, msg: `save part ${key} ${why}`, fix: "add atomic: true when its load puts plain data back by itself, else notAtomic: '<why not>' (core/ops/opsAtomic.js)" });
        n++;
      }
    }
    out.note = `${n} part(s) without an answer`;
    return out;
  },
};
