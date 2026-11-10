// R69 tests (no browser): fixture items only, so a change to the real surface cannot hide a broken rule. The live surface is checked by `npm run check` itself.
import { verbProblems, docListProblems } from '../rules/R69-one-verb-set.mjs';

export const name = 'R69 one verb set: add / on give back a handle, no register / create / bind for define / add';

export async function run({ check }) {
  const item = (name, handle, group = 'engine sub-objects') => ({ group, name, decl: 'types/x.d.ts', handle, sig: '(name: string) => void' });
  const msgs = (items, ex = {}) => verbProblems(items, ex).map(r => r.msg);
  check('a new add without remove() is an error', msgs([item('things.add', false)]).some(m => /things\.add adds without/.test(m)));
  check('an on* hook without remove() is an error, with remove() it passes', msgs([item('things.onHit', false)]).length === 1 && !msgs([item('things.onHit', true)]).length);
  // why a guard: register next to define is the exact drift the rule exists for; it must fail even when the function returns a handle
  check('[guard] register / create / bind are errors even when they return a handle', ['register', 'createThing', 'bind'].every(n => msgs([item('things.' + n, true)]).length === 1));
  check('define, set and plain domain verbs pass', !msgs([item('things.define', false), item('things.set', false), item('things.spawn', false), item('things.pressed', false)]).length);
  const def = (name, sig) => ({ group: 'engine sub-objects', name, decl: 'types/x.d.ts', handle: false, sig });
  check('[guard] a define that does not take the name first is an error; with a string name first it passes',
    msgs([def('things.define', '(def: object) => void')]).some(m => /without taking the name first/.test(m)) && !msgs([def('things.define', '(name: string, def: object) => void')]).length);
  check('a listed exception passes', !msgs([item('things.register', true)], { 'things.register': 'alias' }).length);
  check('[guard] an exception that no longer applies is an error, so the list cannot rot', msgs([item('things.add', true)], { 'things.add': 'old' }).some(m => /no longer applies/.test(m))
    && msgs([], { 'gone.add': 'old' }).some(m => /'gone\.add' no longer applies/.test(m)));
  check('not callable, or outside engine and module APIs, is not read', !msgs([item('things.add', null), item('createThing', true, 'exports threedog')]).length);
  // why a guard: the CONVENTIONS line is the copy an AI reads; it must name exactly the table's keys, or the two lists drift apart again (they had: 5 names vs 17)
  const doc = (line, ex) => docListProblems(`# x\n${line}\n`, ex).map(r => r.msg), ab = { 'a.add': 'x', 'b.on': 'y' };
  check('[guard] the CONVENTIONS exception line must name exactly the table', !doc('Exceptions to the verb rules (reasons: R69): `a.add`, `b.on`.', ab).length
    && doc('Exceptions to the verb rules: `a.add`.', ab).some(m => /`b\.on` is missing/.test(m))
    && doc('Exceptions to the verb rules: `a.add`, `b.on`, `c.put`.', ab).some(m => /names `c\.put`/.test(m))
    && doc('no such line', ab).some(m => /no "Exceptions to the verb rules" line/.test(m)));
}
