// R71 tests (no browser): fixture lists only. The live engine is checked by `npm run check` itself.
import { literalSet, literalProblems } from '../rules/R71-literal-params.mjs';

export const name = 'R71 literal params: JSDoc and d.ts list the same named strings';

export async function run({ check }) {
  const js = (fn, param, set) => ({ file: 'core/x.js', line: 3, fn, param, set }), d = (fn, param, set) => ({ fn, param, set });
  const msgs = (a, b) => literalProblems(a, b).map(r => r.msg);
  check('literalSet reads a union of two or more string literals, sorted; anything else is null',
    literalSet("'b' | 'a'")?.join() === 'a,b' && literalSet('("x" | \'y\')')?.join() === 'x,y' && literalSet("'a'") === null && literalSet("'a' | number") === null && literalSet('string') === null);
  // why a guard: autoView.manual took 'aspect' and 'sunDir' in the code and the docs, the d.ts listed four keys, and nothing said so until a doc example used one
  check('[guard] strings the d.ts does not list are an error naming both lists',
    msgs([js('manual', 'key', ['aspect', 'far', 'sunDir'])], [d('manual', 'key', ['far'])]).some(m => /manual\(key\) takes 'aspect' \| 'far' \| 'sunDir' in the code's JSDoc, the d\.ts says 'far'/.test(m)));
  check('[guard] a string only the d.ts lists is an error too', msgs([js('manual', 'key', ['far', 'fov'])], [d('manual', 'key', ['far', 'fov', 'gone'])]).length === 1);
  check('equal lists pass; so does a same-named method elsewhere when one d.ts copy matches', !msgs([js('show', 'mode', ['a', 'b'])], [d('show', 'mode', ['x', 'y']), d('show', 'mode', ['a', 'b'])]).length);
  check('a parameter the d.ts does not type by strings is not compared', !msgs([js('set', 'mode', ['a', 'b'])], [d('set', 'other', ['a', 'c'])]).length);
}
