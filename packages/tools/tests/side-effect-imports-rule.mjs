// R70 tests (no browser): fixture files only. The live engine is checked by `npm run check` itself.
import { sideEffectProblems } from '../rules/R70-side-effect-imports.mjs';

export const name = 'R70 side effect imports: a file imported for what it does is listed in sideEffects';

export async function run({ check }) {
  const file = (file, ...text) => ({ file, text }), yes = () => true;
  const msgs = (files, listed, exists = yes) => sideEffectProblems(files, listed, exists).map(r => `${r.file}:${r.line} ${r.msg}`);
  // why a guard: this is the bug the rule exists for: the patch file was imported, not listed, and the bundler dropped it without a word
  check('[guard] a bare import of a file that is not listed is an error naming the file and the line',
    msgs([file('render/fx/index.js', "import { a } from './a.js';", "import './patch.tsl.js';")], ['./render/fx/a.js']).some(m => /^render\/fx\/index\.js:2 \.\/patch\.tsl\.js is imported only for its side effects/.test(m)));
  check('a listed file passes, through ../ too', !msgs([file('render/fx/index.js', "import './patch.tsl.js';", "import '../cascades.tsl.js';")], ['./render/fx/patch.tsl.js', './render/cascades.tsl.js']).length);
  check('imports with names, package imports and comments are not read', !msgs([file('core/a.js', "import { x } from './x.js';", "import 'three';", "// import './y.js';", "import * as z from './z.js';")], []).length);
  check('[guard] a listed path with no file is an error, so the list cannot rot', msgs([], ['./render/gone.js'], () => false).some(m => /lists \.\/render\/gone\.js, which does not exist/.test(m)));
}
