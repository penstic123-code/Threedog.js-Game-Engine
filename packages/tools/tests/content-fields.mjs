// Field tables (engine modules/content/fields.js) in content validation, no browser: a throwaway game folder in the OS temp dir goes through checkGame.
// The guard: content-check validates every entry against the same tables engine.content.fields() hands an editor panel, so a misspelled key, an
// out-of-range or not-allowed value, and a default written inside `fields` (defaults live only in state) cannot slip past `npm run check`.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGame } from '../content-check.mjs';

export const name = 'content-check: field tables (placement fields, template / kind fields)';

const FILES = {
  'main.js': '\n',
  'content/rules.js': `export default { kinds: {
    recipes: { desc: 'crafting recipes', load() {}, fields: { makes: 'string', time: { type: 'number', min: 0 } } },
    waves: { desc: 'enemy waves', load() {}, fields: { count: { type: 'int', default: 3 } } },
  } };\n`,
  'content/recipes.js': "export default { loaf: { makes: 'bread', time: 2 }, toast: { makes: 'toast', tme: 1 }, burnt: { time: -1 } };\n",
  'content/waves.js': 'export default [{ count: 2 }];\n',
  'content/templates.js': `export default {
    crop: { model: 'm', state: { stage: 0, sort: 'wheat' }, fields: { stage: { type: 'int', min: 0, max: 4 }, sort: { values: ['wheat', 'corn'] } } },
    lamp: { model: 'm', state: { lit: false }, fields: { lit: { type: 'bool', default: true }, lite: 'bool' } },
    tag: { model: 'm', state: { kind: 'red' } },
    post: { model: 'm', collide: { circle: 0.25, occluder: false } },
    pole: { model: 'm', collide: { radius: 0.25 } },
    gate: { model: 'm', collide: { layer: 'gate' } },
  };\n`,
  'content/props.js': `export default [
    { model: 'm', x: 0, z: 0, rot: 1.5 },
    { model: 'm', x: 0, z: 0, scael: 2 },
    { model: 'm', x: 0, z: 0, collide: 'sphere' },
    { template: 'crop', id: 'c1', x: 1, z: 1, stage: 2, sort: 'corn' },
    { template: 'crop', id: 'c2', x: 1, z: 1, stage: 9 },
    { template: 'crop', id: 'c3', x: 1, z: 1, sort: 'rice', stagee: 1 },
    { id: 'g1', grid: 'yard', item: 'bed', cell: [0, 0], rotation: 5 },
    { model: 'm', x: 0, z: 0, collide: { circle: 0.25 } },
    { model: 'm', x: 0, z: 0, collide: { circle: -1 } },
    { model: 'm', x: 0, z: 0, rot: [0.5, 0, 0], collide: { layer: 'gate' } },
    { model: 'm', x: 0, z: 0, rot: 1, collide: { layer: 'gate' } },
    { template: 'gate', id: 'g2', x: 1, z: 1, rot: [0, 0, 0.3] },
  ];\n`,
  'content/pickups.js': "export default [{ item: 'x', x: 0, z: 0, cuont: 2 }];\n",
};

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'threedog-fields-'));
  try {
    mkdirSync(join(dir, 'content'));
    for (const [f, src] of Object.entries(FILES)) writeFileSync(join(dir, f), src);
    const { errors, warnings } = await checkGame(dir);
    const all = errors.join('\n'), has = re => errors.some(e => re.test(e)), none = re => !errors.some(e => re.test(e));
    check('[guard] a misspelled placement field is an error with did-you-mean (plain prop, template instance, pickup)',
      has(/prop #2: unknown field 'scael' \(did you mean 'scale'\?\)/) && has(/prop #6 \(template crop\): unknown field 'stagee' \(did you mean 'stage'\?\)/)
      && has(/pickup #1: unknown field 'cuont' \(did you mean 'count'\?\)/), all);
    check('[guard] out of range and not in values are errors (template fields, placement fields)',
      has(/prop #5 \(template crop\): stage must be <= 4, got 9/) && has(/prop #6 \(template crop\): sort must be one of "wheat", "corn"/)
      && has(/prop #3: collide must be one of false, "box", "circle"/) && has(/prop #7 \(grid item\): rotation must be one of 0, 1, 2, 3/), all);
    check('[guard] collide: the object form passes, a mistyped one is an error (template and plain prop)',
      has(/template pole: collide must be one of/) && has(/prop #9: collide must be one of/) && none(/template post: collide/) && none(/prop #8: collide/), all);
    check('[guard] a layer on a tilted prop is a warning (plain prop and template instance), an upright one is not: the load warns with the same predicate',
      warnings.some(w => /prop #10: collide.layer needs an upright model/.test(w)) && warnings.some(w => /prop #12: collide.layer needs an upright model/.test(w)) && !warnings.some(w => /prop #11: collide.layer/.test(w)), warnings.join('|'));
    check('[guard] default inside fields is an error (template and kind): defaults live only in state / the data',
      has(/template lamp: fields\.lit has a default; defaults live only in state/) && has(/kind waves: fields\.count has a default/), all);
    check('a template fields key that is no state key is an error with the closest state name; a state field named like a record field is an error',
      has(/template lamp: fields\.lite names no state field \(did you mean 'lit'\?\)/) && has(/template tag: state\.kind is a world record field/), all);
    check('kind entries: misspelled key and out of range and missing required key, each pointing at the kind file',
      has(/recipes\.js: recipes toast: unknown field 'tme' \(did you mean 'time'\?\)/) && has(/recipes burnt: time must be >= 0/) && has(/recipes burnt: makes is required/), all);
    check('valid entries pass (no message for prop #1, prop #4, recipe loaf)', none(/prop #1\b/) && none(/prop #4\b/) && none(/recipes loaf/), all);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
