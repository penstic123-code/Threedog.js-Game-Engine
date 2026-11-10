// Replaceable rules (ctx.rule): a rule is a plain shared point, so the module system gives it owners, conflicts, layers and cleanup; this checks the
// reader on the real Stacks: default, name, function, false, per id, sharing one rule between two readers, a bad name.
// The "no way around it" check: no module keeps its own rule registry; every ctx.rule goes through engine.stacks.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { ENGINE } from '../paths.mjs';

const { Stacks } = await import(pathToFileURL(join(ENGINE, 'core/ops/stacks.js')).href);

export const name = 'rules: ctx.rule on a shared point';

const fresh = () => { const e = { events: { emit() {} } }; e.stacks = new Stacks(e); return e; };
const code = f => { try { f(); return 'no throw'; } catch (x) { return x.code; } };

export async function run({ check }) {
  {
    const e = fresh(), r = e.stacks.rule('fall', 'rescue');
    check('default: the reader\'s own default, with no entry', r.decide('p', {}) === 'rescue' && r.value() === 'rescue');
    const h = e.stacks.mod('fall', { owner: 'game', set: false });
    check('false for everyone = manual', r.decide('p', {}) === false);
    h.remove();
    check('... and the default comes back', r.decide('p', {}) === 'rescue');
    e.stacks.mod('fall', { owner: 'game', id: 'boss', set: (facts, eng) => (facts.y < 0 && eng === e ? false : 'rescue') });
    check('a function per id gets (facts, engine); others keep the default', r.decide('boss', { y: -1 }) === false && r.decide('boss', { y: 1 }) === 'rescue' && r.decide('p', {}) === 'rescue');
    check('a function shows in describe() as a function', /function/.test(e.stacks.describe()['fall[boss]'].how));
    check('a rule is not saved', !('fall' in e.stacks._save()));
  }
  {
    const e = fresh(), a = e.stacks.rule('fall', 'rescue'), b = e.stacks.rule('fall', 'keep', ['keep', 'drop']);
    check('a second reader shares the point and keeps its own default', a.value() === 'rescue' && b.value() === 'keep');
    e.stacks.mod('fall', { owner: 'g', set: 'drop' });
    check('a name is checked against the reader\'s own list', b.decide(null) === 'drop' && code(() => a.decide(null)) === 'unknown-name');
    e.stacks.define('n', {});
    check('a point of another shape is not a rule', code(() => e.stacks.rule('n', 'x')) === 'engine-misuse');
  }
  {
    const e = fresh(), g = e.stacks.rule('graph', 'humanoid');
    const data = { body: { bone: 'b' } };
    e.stacks.mod('graph', { owner: 'g', set: data });
    check('data passes through as the decision', g.decide(null) === data);
  }
  // a closed install gets an inert answer (group N review), a live one the Stacks reader: still no second registry
  check('ctx.rule is the Stacks reader, no second registry', /rule: \(n, def, names\) => \(stale\(\) \? \{[^}]*\} : this\.stacks\.rule\(n, def, names\)\)/.test(readFileSync(join(ENGINE, 'core/engine/modules.js'), 'utf8')));
}
