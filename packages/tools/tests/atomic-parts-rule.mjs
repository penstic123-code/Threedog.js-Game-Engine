// Rule R67 on small texts: a save part answers atomic: true or notAtomic: why, at the call; the rule run on the engine finds no part without an answer.
import { scanText } from '../rules/R67-atomic-parts.mjs';
import rule from '../rules/R67-atomic-parts.mjs';

export const name = 'rule R67: a save part says whether an atomic op covers it';

export function run({ check }) {
  const why = text => scanText(text).map(x => x.why).join();
  check('atomic: true answers', !why("ctx.saves.define('a', { atomic: true, save, load });"));
  check('a reason answers', !why("e.saves.define('a', { notAtomic: 'simulated', save, load });"));
  check('a spread part answers beside the spread', !why("ctx.saves.define('a', { ...part(), atomic: true });"));
  check('saying nothing does not', /does not say/.test(why("ctx.saves.define('a', { save, load });")));
  check('an empty reason does not', /no reason/.test(why("ctx.saves.define('a', { notAtomic: ' ', save, load });")));
  check('both does not', /both/.test(why("ctx.saves.define('a', { atomic: true, notAtomic: 'x', save, load });")));
  check('atomic: false is no answer', /not true/.test(why("ctx.saves.define('a', { atomic: false, save, load });")));
  check('a part built elsewhere is no answer', /written at the call/.test(why("ctx.saves.define('a', part());")));
  check('another register is none of its business', !why("engine.input.register('a', {}); items.register('b');"));
  // [guard] saves.register was removed with no alias: the rule matches only saves.define, so a call by the old name is not taken for a save part
  check('saves.register is not a save part any more', !scanText("ctx.saves.register('a', { save, load });").length);
  const left = rule.run().filter(r => r.level === 'error');
  check('every engine part has its answer', left.length === 0, left.map(r => `${r.file}:${r.line} ${r.msg}`).join('; '));
}
