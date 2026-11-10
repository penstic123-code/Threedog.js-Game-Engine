// Rule R64 cannot be walked around: a capability with no task words, a task line that echoes the capability's name, and a task how cannot answer each fail; every real one passes.
// Real docs, real metadata, in Node; the fake module is the case the rule exists for, the tool or module added next year.
import { join } from 'node:path';
import { metadata } from 'threedog/metadata';
import { ENGINE } from '../paths.mjs';
import { capabilities, gap, browseProblems } from '../rules/R64-how-reach.mjs';
import { capabilityCards } from '../how-browse.mjs';
import { answer, browse, card } from '../how-answer.mjs';
import { STATIC_TOOLS } from '../threedog/mcp-extra.mjs';

export const name = 'rule R64: every capability is found by how from plain task words';

export async function run({ check }) {
  const docs = join(ENGINE, 'docs'), real = capabilities();
  const kinds = k => real.filter(c => c.kind === k).length;
  check('modules, factories, groups and recipes are all on the list', kinds('module') === Object.keys(metadata.modules).length && kinds('factory') >= 4 && kinds('group') >= 40 && kinds('recipe') >= 50, JSON.stringify([kinds('module'), kinds('factory'), kinds('group'), kinds('recipe')]));
  const gaps = real.map(c => gap(c, docs)).filter(Boolean);
  check('every capability is found', !gaps.length, gaps.slice(0, 3).join(' | '));

  // the layered way in, for when the words miss: short screens, every capability reachable, a card by stable id
  const cards = capabilityCards(docs), first = browse(), items = browse('items');
  check('how with no words opens the first screen, and browse is the same', first.text === (await answer(ENGINE, '')).text && first.ok);
  check('the first screen is a few categories, each with its size', first.data.categories.length >= 5 && first.data.categories.length <= 8 && first.text.length < 800, first.text);
  check('a category lists ids with task words, short', items.ok && items.text.includes('inventory: carry items in a backpack') && items.text.split('\n').length <= 32 && items.text.length < 2500, items.text.slice(0, 200));
  check('every capability has a category and a card', !browseProblems(real, cards).length, browseProblems(real, cards).slice(0, 3).join(' | '));
  check('a capability with no category is reported', browseProblems(real, cards.map(c => c.id === 'rigid' ? { ...c, category: undefined } : c)).length === 1);
  check('a capability with no card is reported', browseProblems(real, cards.slice(1)).length === 1);
  check('a line whose capability is gone is reported', browseProblems(real, cards, { MODULES: { gone: 'x' } }).length === 1);
  const inv = await card(ENGINE, 'inventory');
  check('a module card: solves, does not fit, install, dependencies, time, saves, example and its proof', ['Solves: ', 'Does not fit: ', "import { inventory } from 'threedog'", 'Requires: none', 'Time: ', 'as inventory, containers', 'recipes/66-common-tasks.md#pickup', 'run by the test "recipe 66"'].every(w => inv.text.includes(w)) && inv.text.length < 900, inv.text);
  check('facts come from the metadata: a module with no save part says so', /no save part/.test((await card(ENGINE, 'hud')).text));
  check('a factory card installs the factory, a group needs no install, a recipe opens the page', /firstPersonCamera\(\)/.test((await card(ENGINE, 'firstPersonCamera')).text) && /nothing to install/.test((await card(ENGINE, 'clock')).text) && /recipes\/65-swarm\.md/.test((await card(ENGINE, '65-swarm')).text));
  check('--full adds the example code, an unknown id or category fails and says where to look', /engine\.pickups\.spawn/.test((await card(ENGINE, 'inventory', { full: true })).text) && !(await card(ENGINE, 'bagg')).ok && !browse('stuff').ok);
  check('no match and a weak match name browse', /how --browse/.test((await answer(ENGINE, 'qqzzxx')).text) && /how --browse/.test((await answer(ENGINE, 'qqzzxx wibble game')).text));
  // MCP: explicit fields, no flag hidden in a task string
  const via = a => STATIC_TOOLS.how.run(ENGINE, a);
  check('MCP how: browse, card and task each answer as the command line does', (await via({ browse: 'categories' })).text === first.text && (await via({ browse: 'items' })).text === items.text && (await via({ card: 'inventory' })).text === inv.text && /Recommended/.test((await via({ task: 'rain' })).text));
  check('MCP how: a flag as a task is only words now', !/^character:/.test((await via({ task: '--browse' })).text));

  const saved = await answer(ENGINE, 'remember progress between visits');
  check('an entry row prints the section of the recipe it points at', /^The section \(recipes\/20-.*§/m.test(saved.text) && /engine\.saves/.test(saved.text) && /recipes\/20-/.test(saved.data.recommended.at), saved.text.slice(0, 300));

  const fake = { smelter: { call: 'smelter', file: 'x.js', provides: [] } };
  const one = capabilities({ modules: fake }, '', [])[0];
  check('a new module with no task words is a gap', gap(one, docs) === 'module smelter has no task words', gap(one, docs));
  check('task words holding the own name are a gap', gap({ ...one, task: 'run the smelter' }, docs).includes('own name'), gap({ ...one, task: 'run the smelter' }, docs));
  check('a task how answers with something else is a gap', gap({ ...one, task: 'make it rain' }, docs).includes('does not list'), gap({ ...one, task: 'make it rain' }, docs));
  const group = capabilities({ modules: {} }, 'engine sub-objects | newGroup.call | x\n', [])[0];
  check('a new engine group joins by itself', group.kind === 'group' && group.id === 'newGroup' && !group.task);
  const recipe = capabilities({ modules: {} }, '', ['70-new.md'])[0];
  check('a new recipe joins by itself', recipe.kind === 'recipe' && recipe.id === '70-new' && recipe.found('see recipe 70') && !recipe.found('see recipe 7'));
}
