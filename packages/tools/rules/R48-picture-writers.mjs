// R48 engine code writes a renderer-wide picture value only where WRITERS says so: the game's picture/ code owns these values, the engine does not
//   touch them behind its back.
// Why: exposure, shadow switches and environment strength decide the whole picture. A module that sets one on its own overrides the game's picture/
//   code with nothing on screen saying who did it.
// Criteria: in engine code (core / modules / render / ui), an assignment `<anything>.<prop> = ...` for a prop in PROPS is an error unless WRITERS
//   lists that file and prop. A WRITERS row whose file is gone is a warning: delete the row.
// PROPS: the three.js properties whose names are distinctive enough to match by name. Generic names (intensity, color, near, far) are not listed:
//   they would match unrelated objects.
// WRITERS: add a row only with a reason a reviewer accepts.
import { ts, parse, visit, lineOf, engineFiles } from './_lib.mjs';

/** Property paths (last segments of the assignment target) */
const PROPS = ['toneMappingExposure', 'shadowMap.enabled', 'shadowMap.type', 'environmentIntensity'];

/** [file suffix, prop or '*', reason] */
export const WRITERS = [
  ['core/engine/startup.js', '*', 'the WebGL fallback copies every renderer setting onto the new renderer: a copy of the current value, not a decision'],
  ['render/shadows.js', 'shadowMap.enabled', 'engine.shadows, the shadow capability: the game asks for it'],
  ['render/backend.js', 'toneMappingExposure', 'releaseRenderer gives back the value its borrow saved: a copy of the value before, not a decision'],
];

/** The prop an assignment target ends in, or null (only property names count, no calls) */
function propOf(target) {
  const names = [];
  for (let n = target; n && ts.isPropertyAccessExpression(n); n = n.expression) names.unshift(n.name.text);
  return PROPS.find(k => { const want = k.split('.'); return want.every((w, i) => names[names.length - want.length + i] === w); }) ?? null;
}

/** Findings of one parsed file (exported for the rule test) */
export function strayWrites(file, sf, writers = WRITERS) {
  const out = [];
  visit(sf, n => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const prop = propOf(n.left);
    if (!prop || writers.some(([f, p]) => file.endsWith(f) && (p === '*' || p === prop))) return;
    out.push({ level: 'error', file, line: lineOf(n), msg: `engine code writes ${prop}: that value is the game's picture/ code to set`,
      fix: "delete the write and publish a signal in engine.uniforms for picture/ code to read; a copy that is not a decision goes in R48's WRITERS with its reason" });
  });
  return out;
}

export default {
  id: 'R48', title: 'Engine code writes a renderer-wide picture value only where R48 lists it',
  run() {
    const files = engineFiles();
    const out = files.flatMap(f => (/toneMappingExposure|shadowMap|environmentIntensity/.test(parse(f).text) ? strayWrites(f, parse(f)) : []));
    for (const row of new Set(WRITERS.map(([f]) => f))) if (!files.some(f => f.endsWith(row)))
      out.push({ level: 'warn', file: 'packages/tools/rules/R48-picture-writers.mjs', line: 1, msg: `WRITERS names ${row}, which is gone`, fix: 'delete its row' });
    return out;
  },
};
