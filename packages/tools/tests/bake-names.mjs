// threedog bake: two bake lists exporting one model name must stop the bake before any generator runs, naming both sources (the page itself needs a browser).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../paths.mjs';
import { assertUniqueBakeNames } from '../bake-names.js';

export const name = 'bake: a model name exported by two bake lists is refused with both sources named';

export async function run({ check }) {
  let err = '';
  try { assertUniqueBakeNames([{ name: 'oak', from: 'a/bake.js' }, { name: 'rock', from: 'a/bake.js' }, { name: 'oak', from: 'b/bake.js' }]); } catch (e) { err = e.message; }
  check('the same name in two lists is an error that names both files', /"oak"/.test(err) && err.includes('a/bake.js') && err.includes('b/bake.js'), err);
  let ok = true;
  try { assertUniqueBakeNames([{ name: 'oak', from: 'a/bake.js' }, { name: 'pine', from: 'b/bake.js' }]); } catch { ok = false; }
  check('the bake page runs the check before generating anything', /assertUniqueBakeNames\(items\)/.test(readFileSync(join(TOOLS, 'bake-page.js'), 'utf8')));
  check('[guard] different names in different lists pass', ok);
}
