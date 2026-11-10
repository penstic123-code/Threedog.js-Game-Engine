// threedog impact: a small game in a temp folder, so every group has a known answer, and the sentence about what it cannot see is never left out.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { impact } from '../impact.mjs';

export const name = 'impact: lists content, calls, saved parts, templates, tests and engine facts for a name, and says what it cannot see';

export async function run({ check }) {
  const game = mkdtempSync(join(tmpdir(), 'impact-game-'));
  try {
    mkdirSync(join(game, 'content')); mkdirSync(join(game, 'tests/scenarios'), { recursive: true });
    writeFileSync(join(game, 'package.json'), '{"name":"g"}');
    writeFileSync(join(game, 'content/items.js'), "export default { gem: { name: 'Gem' } };\n");
    writeFileSync(join(game, 'content/pickups.js'), "export default [{ id: 'p1', item: 'gem', x: 1, z: 2 }];\n");
    writeFileSync(join(game, 'main.js'), ["const engine = {};", "engine.inventory.add('gem', 1);", "engine.saves.define('gem', { save() {}, load() {} });", "const k = 'g' + 'em'; engine.inventory.add(k, 1);", "engine.ops.run(`buy-${k}`);", ''].join('\n'));
    writeFileSync(join(game, 'tests/scenarios/a.json'), '{ "name": "a", "steps": [{ "expect": { "x": "gem" } }] }\n');
    const r = await impact(game, 'gem'), d = r.data;
    check('[guard] the content that names it, by the section\'s own references', d.content.some(l => /content\/pickups\.js pickups\[0\] \(names items\.gem\)/.test(l)), JSON.stringify(d.content));
    check('the content that defines it', d.content.some(l => /content\/items\.js items\.gem/.test(l)), JSON.stringify(d.content));
    check('one place is said once: the walk does not repeat a reference', d.content.filter(l => /pickups/.test(l)).length === 1, JSON.stringify(d.content));
    check('calls by file and line', d.calls.some(l => l.startsWith('main.js:2 ')), JSON.stringify(d.calls));
    check('saved parts: the game\'s own, and the owner\'s with the rename route', d.saved.some(l => l.startsWith('main.js:3 ')) && d.saved.some(l => /content\/renames\.js/.test(l)), JSON.stringify(d.saved));
    check('tests: a scenario that names it', d.tests.some(l => /a\.json/.test(l)), JSON.stringify(d.tests));
    check('[guard] it says plainly what it cannot see, with the computed calls found', /Cannot see: names computed in game code \(2 such calls: main\.js:4, main\.js:5\)/.test(r.text) && /players' saves/.test(r.text), r.text);
    check('short by default', r.text.split('\n').length <= 20, String(r.text.split('\n').length));
    const engine = await impact(game, 'collider3d');
    check('a capability: its contract and who requires it, from the metadata', engine.data.engine.some(l => /capability contract collider3d/.test(l)), JSON.stringify(engine.data.engine));
    const none = await impact(game, ['zzz', 'nothing'].join('-'));   // joined: this file must not hold the name, tests are searched too
    check('[guard] nothing found is not called unused', /nothing found\. That does not prove it is unused/.test(none.text) && /Cannot see/.test(none.text), none.text);
  } finally { rmSync(game, { recursive: true, force: true }); }
}
