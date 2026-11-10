// Doc rule tests (no browser): R18 finds stale names in fixture docs and lets placeholders through; R22 checks the AI.md entry table;
// the GAMEMAP template section renders templates, placements, spawns and a missing op.
import { checkDoc, checkAnchors, context } from '../rules/R18-doc-refs.mjs';
import { entryTable, sentences, passages, cardProblems } from '../rules/R22-doc-shape.mjs';
import { templateLines, declaredEvents, eventLines } from '../gamemap/extra.mjs';
import { RECIPES_REL, ENGINE } from '../paths.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metadata } from 'threedog/metadata';
import { defaultLayer, hintProblems, installCalls } from '../lib/default-layer.mjs';

export const name = 'doc rules: R18 references, R22 entry table and copied passages, GAMEMAP templates';

export async function run({ check }) {
  const anchors = (text, other = '## Real heading, with `code`\n<a id="named"></a>\n') => checkAnchors('docs/x.md', text, () => other).map(r => r.msg);
  check('R18: a link to a heading or an <a id> passes', !anchors('[a](y.md#real-heading-with-code) [b](y.md#named) [c](#here)\n## Here\n').length);
  check('R18: a link to a section that is gone is an error', anchors('[a](y.md#gone)').length === 1 && anchors('[a](#gone)').length === 1);
  const ctx = await context(), doc = `${RECIPES_REL}/99-fixture.md`;
  const errs = text => checkDoc(doc, text, ctx);
  const has = (r, re) => r.some(x => re.test(x.msg));
  // why: a plan is where future files get named, and docs cannot break a game; the same text in an engine doc stays an error
  const later = 'See `content/later.js`, then `npm test -- zzz-none`, `threedog zzz-none` and `npm run zzz-none`.', plan = checkDoc('games/zz/DESIGN.md', later, ctx);
  check('[guard] R18: names that do not exist yet in a game doc warn, in an engine doc they fail', plan.length >= 3 && plan.every(r => r.level === 'warn') && errs(later).some(r => r.level === 'error'), JSON.stringify(plan));
  check('R18: a stale test name is an error with close names', has(errs('Run `npm test -- zzz-no-such-test`.'), /matches no test/));
  check('R18: a real test name passes', !errs('Run `npm test -- "dev bridge"`.').length);
  check('R18: a test name after threedog test is read the same way', has(errs('Run `threedog test zzz-no-such-test`.'), /matches no test/) && !errs('Run `threedog test "dev bridge" --verbose`.').length);
  check('R18: an unknown event warns, a real one passes', has(errs('Listen to `quest:doen`.'), /did you mean `quest:done`/) && !errs('Listen to `quest:done`.').length);
  check('R18: placeholder paths and clock times pass', !errs('Edit `games/<game>/content/npcs.js` or `recipes/NN-x.md`; open at `18:30`.').length);
  check('R18: a monorepo path in a shipped doc is an error', has(errs('See `packages/engine/docs/AI.md`.'), /monorepo path/));
  check('R18: a missing recipe path suggests the right one', has(errs('Read `recipes/02-npcs.md`.'), /did you mean/));
  check('R18: unknown CLI command / npm script', has(errs('`npx threedog descibe`'), /did you mean `threedog describe`/) && has(errs('`npm run chek`'), /npm run check/));
  check('R18: engine member typo warns with a suggestion', has(errs('Call `engine.clok.after(2, fn)`.'), /engine\.clock/) && has(errs('`engine.clock.aftr`'), /engine\.clock\.after/));
  // [守] 引擎文档里的 API 名必须真实存在：AI 把文档里的名字当事实抄，改名必须连文档一起改，所以在 docs/ 下是 error 不是 warn
  check('R18: an unknown engine member in an engine recipe is an error', errs('Call `engine.clok.after(2, fn)`.').some(x => x.level === 'error'));
  // 游戏自己的 DESIGN/STATUS/README 会写自己的模块名，只警告
  const gameErrs = checkDoc('games/x/DESIGN.md', 'Call `engine.farm.plant(1)` and `plantNow()`.', ctx);
  check('R18: a game doc naming its own module only warns', gameErrs.length > 0 && gameErrs.every(x => x.level === 'warn'));
  check('R18: a game doc naming its own helpers (snake_case, art-pipeline) is not flagged', !checkDoc('games/x/DESIGN.md', 'Run `straw_hat()` then `build_rig()`.', ctx).length);
  check('R18: a game doc with a near miss of an engine export still warns; an engine doc flags any unknown name', checkDoc('games/x/DESIGN.md', 'Use `createEngin()`.', ctx).some(x => x.level === 'warn' && /createEngin/.test(x.msg))
    && checkDoc(doc, 'Use `build_rig()`.', ctx).some(x => x.level === 'error'));
  check('R18: an ignore marker skips the line', !errs('`npm test -- zzz` <!-- r18-ignore-line -->').length);
  // R22: the Already-here table and the check hints name one API (lib/default-layer.mjs), on the real AI.md and on a broken copy
  const ai = readFileSync(join(ENGINE, 'docs', 'AI.md'), 'utf8'), calls = installCalls(metadata.modules);
  check('[guard] R22: every check hint kind sits under a table key or in OFF_TABLE, and each row names its hint\'s API', !hintProblems(ai, metadata.hints, calls).length, hintProblems(ai, metadata.hints, calls).join(' | '));
  check('[guard] R22: a row naming another API than its hint, and a hint kind placed nowhere, are both found',
    hintProblems(ai.replace('| NPC conversation: talk to an NPC, what NPCs do | `engine.npcs`, `engine.dialogue` |', '| NPC conversation: talk to an NPC | `engine.npcs` |'), metadata.hints, calls).some(m => /"dialogue" points at dialogue/.test(m))
    && hintProblems(ai, { ...metadata.hints, zzz: { use: 'engine.zzz' } }, calls).some(m => /"zzz" is neither/.test(m)));
  const layer = defaultLayer(ai).table;
  check('the Already-here table covers the systems blind tests wrote by hand', ['engine.dialogue', 'engine.quests', 'engine.interactions', 'engine.inventory', 'engine.pickups', 'engine.terrain', 'engine.water',
    'engine.vegetation', 'engine.cameraRig', 'engine.characters', 'engine.saves', 'engine.ui', 'engine.audio', 'engine.input'].every(n => layer.includes(n)));
  const table = rows =>`## What exists: look here first\n| To do | Use | Recipe |\n|---|---|---|\n${rows}\n## Next\n`;
  const exists = r => r === 'recipes/02-npc.md';
  check('R22: a namespace without a row is named', entryTable(table('| Talk | `engine.dialogue` | `recipes/02-npc.md` |'), ['dialogue', 'quests'], exists).some(x => /engine\.quests/.test(x.msg)));
  check('R22: a row pointing at a missing recipe is an error', entryTable(table('| Talk | `engine.dialogue` | `recipes/03-nope.md` |'), ['dialogue'], exists).some(x => /does not exist/.test(x.msg)));
  check('R22: every recipe of a row is checked, not only the first', entryTable(table('| Talk | `engine.dialogue` | `recipes/02-npc.md`, `recipes/03-nope.md` |'), ['dialogue'], exists).some(x => /03-nope/.test(x.msg)));
  // [guard] a new row registers its route in the same change (how-tasks.mjs ROUTES), and its section pointer opens a section
  const routed = { routes: [['talk to a villager', '02-npc.md §1']], resolve: ref => !/§9/.test(ref) };
  check('[guard] R22: a row whose first pointer has no route is an error', entryTable(table('| Talk | `engine.dialogue` | 02-npc.md §2 |'), ['dialogue'], exists, routed).some(x => /no route to 02-npc\.md §2/.test(x.msg))
    && !entryTable(table('| Talk | `engine.dialogue` | 02-npc.md §1 |'), ['dialogue'], exists, routed).length);
  check('[guard] R22: a section pointer that opens no section is an error', entryTable(table('| Talk | `engine.dialogue` | 02-npc.md §9 |'), ['dialogue'], exists, routed).some(x => /is no section/.test(x.msg)));
  // [guard] a selector the parser rejects (unknown words, 1.2) is an error, not read as the whole file the route list may hold (review 2026-11-09)
  const fileRoute = { routes: [['music', '31-audio.md']], resolve: () => true };
  check('[guard] R22: a section that does not parse is an error, even when the file has a route', ['31-audio.md §不存在', '31-audio.md §1.2'].every(p =>
    entryTable(table(`| Sound | \`engine.dialogue\` | ${p} |`), ['dialogue'], exists, fileRoute).some(x => /does not parse/.test(x.msg))));
  check('[guard] R22: a row naming a section as file.md#anchor is an error (the form is `NN-x.md §2f`)', entryTable(table('| Talk | `engine.dialogue` | `recipes/02-npc.md#2f` |'), ['dialogue'], exists).some(x => /#anchor/.test(x.msg)));
  check('R22: a complete table passes', !entryTable(table('| Talk | `engine.dialogue` | `recipes/02-npc.md` |'), ['dialogue'], exists, { routes: [['talk to a villager', '02-npc.md']] }).length);
  check('R22: sentences of 12+ words are compared, short ones and code are not',
    sentences('One two three four five six seven eight nine ten eleven twelve.\nShort one.\n```\na b c d e f g h i j k l m\n```').length === 1);
  // [守] 一个事实一个出处：30 个词以上的段落出现在两份文档里就报错，29 个词或代码块里的不算
  const w = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  check('R22: a 30-word passage in two docs is found once, 29 words is not, code blocks are not',
    passages([['a.md', `Intro.\n${w(40)}\n`], ['b.md', `Other.\n${w(35)} tail\n`]]).length === 1 && !passages([['a.md', w(29)], ['b.md', w(29)]]).length
    && !passages([['a.md', '```\n' + w(40) + '\n```'], ['b.md', '```\n' + w(40) + '\n```']]).length);
  // [guard] every recipe opens with a card: how --read <file> prints it, so a page without one sends the AI into the whole text
  const card = '# T\n\n> **Covers:** a.\n> **Use when:** b.\n> **Shortest:** `c()`.\n> **Sections:** 1 A\n\n## 1. A\n';
  check('[guard] R22: a recipe without a card, with a missing line or over 6 lines fails; a whole card passes',
    !cardProblems(card).length && /no card/.test(cardProblems('# T\n\nIntro.\n## 1. A\n')[0])
    && cardProblems(card.replace('> **Shortest:** `c()`.\n', '')).some(m => /"Shortest"/.test(m))
    && cardProblems(card.replace('> **Sections:** 1 A\n', '')).some(m => /"Sections"/.test(m))
    && cardProblems(card.replace('> **Sections:**', '> x\n> x\n> x\n> **Sections:**')).some(m => /7 lines/.test(m)));
  // GAMEMAP templates / events
  const c = { templates: { crate: { model: 'crate', collide: true, interact: { op: 'crate.open', label: 'open' }, container: { capacity: 6 }, state: { open: false } } },
    props: [{ template: 'crate', place: 'home', x: 1, z: 2 }, { model: 'tree', x: 0, z: 0 }] };
  const rows = templateLines(c, [], f => f).join('\n');
  check('GAMEMAP: a template row shows model, op, container, state and placements', /\| crate \| crate \| true \| crate\.open \/ open/.test(rows) && /6 slots/.test(rows) && /open=false/.test(rows) && /1 placed \(home\)/.test(rows), rows);
  check('GAMEMAP: an interact op the game never defines is flagged', /op "crate\.open" not defined/.test(rows));
  const ev = eventLines({ 'door:open': { emit: ['main.js'], on: [] } }, new Map([['door:close', { args: '[]', doc: '', file: 'events.d.ts' }]])).join('\n');
  check('GAMEMAP: undeclared and never-emitted events are flagged', /emitted but not declared/.test(ev) && /declared but never emitted/.test(ev), ev);
  check('GAMEMAP: no d.ts means no declared events', declaredEvents(RECIPES_REL, f => f).size === 0);
}
