// Content sections cannot be bypassed: the loader names no provider module, so a section's format follows the module that owns it, and one protocol carries
// every section. Run against the real loader and the real quests section on a small stand-in engine, in Node: what is under test is routing, not drawing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { content } = await imp('modules/content/index.js');
const { quests } = await imp('modules/gameplay/Quests.js');
const { dialogue } = await imp('modules/gameplay/Dialogue.js');
const { inventory } = await imp('modules/gameplay/Inventory.js');
const { pickups } = await imp('modules/gameplay/pickups.js');
const { characters } = await imp('modules/characters/index.js');
const { triggers } = await imp('modules/triggers/index.js');
const { grids } = await imp('modules/grid/index.js');

export const name = 'content sections: the loader names no provider, a replaced module brings its format, a pack commits whole';

function stand(...mods) {
  const e = {
    modules: new Map(), i18n: { add() {} }, events: { on: () => ({ remove() {} }), emit() {} }, ops: { allow: f => f(), actor: null, defs: new Map() },
    input: { action() {} }, ready: false, world: null, level: null, assets: {},   // assets: content holds the model prototypes it clones (holdProtos, core/assets/namedModel.js)
  };
  const c = content();
  for (const m of [c, ...mods]) e.modules.set(m.name, m);
  e.saves = { _replace: { read: f => f(), restoring() {} } };
  e.content = c.install(e, { track: h => h, feeds() {}, things: { explainWith() {} }, saves: { define() {} } });
  return e;
}
const refused = f => { try { f(); return null; } catch (err) { return err; } };

export async function run({ check }) {
  const loader = readFileSync(join(ENGINE, 'modules/content/loader.js'), 'utf8');
  check('the loader calls no provider module', !/\be\.(quests|dialogue|npcs|pickups|triggers|grids|vegetation)\b|\be\.inventory\./.test(loader));

  // the format follows the module: this quests module reads a shape the built-in one would refuse
  const got = [];
  const own = { name: 'myQuests', content: { quests: { commit: d => got.push(d.chain.length), effects: { startQuest: { ref: 'quest', run: (e, v) => got.push(v) } } } } };
  const e = stand(own);
  e.content.load({ quests: { chain: ['a', 'b'] } });
  check('a replaced module reads its own format', got[0] === 2);
  e.content.run({ startQuest: 'a' });
  check('and owns its words', got[1] === 'a');

  check('a section without its module names the module', /quests\(\)/.test(refused(() => stand().content.load({ quests: { q: { steps: [] } } }))?.message ?? ''));
  check('an empty section needs no module', !refused(() => stand().content.load({ quests: {} })));
  check('two owners of a section are refused', /two owners/.test(refused(() => stand(own, quests()).content.load({ quests: {} }))?.message ?? ''));

  // the real providers: each section reaches its own module's API
  const calls = [];
  const rec = who => new Proxy({}, { get: (_, k) => k === 'optionKeys' ? ['name'] : k === 'get' ? () => null : (...a) => { calls.push(`${who}.${String(k)}`); return a[0]; } });
  const fake = { events: { on: () => ({ remove() {} }) }, ops: { allow: f => f() }, session: { captured: null } };
  for (const w of ['quests', 'dialogue', 'inventory', 'pickups', 'npcs', 'triggers', 'grids', 'vegetation']) fake[w] = rec(w);
  const c = { engine: fake, content: { test: () => true, run() {} }, where: p => p, zone: () => null, bind: h => h, origin() {}, pickupId: (p, i) => p.id ?? i, track: h => h, ids: { claim() {}, unnamed() {} } };
  const data = {
    quests: { q: { title: 't', steps: [{ text: 's', done: { flag: 'x' }, target: { npc: 'n' } }] } }, dialogues: { d: { nodes: { a: { text: 'hi' } } } }, items: { i: {} }, startItems: { i: 1 },
    containers: { box: { items: { i: 1 } } }, pickups: [{ item: 'i' }], npcs: { n: { start: {} } }, triggers: { t: { position: {} } }, grids: { g: {} },
  };
  const owners = [quests(), dialogue(), inventory(), pickups(), characters(), triggers(), grids()];
  for (const m of owners) for (const [k, s] of Object.entries(m.content)) if (data[k]) { s.validate?.(data[k], c); s.commit(data[k], c); }
  for (const want of ['quests.define', 'dialogue.define', 'inventory.define', 'inventory.giveStart', 'inventory.container', 'pickups.spawn', 'npcs.add', 'triggers.add', 'grids.add']) check(`${want} is reached through its section`, calls.includes(want));
  const refs = owners.flatMap(m => Object.entries(m.content).flatMap(([k, s]) => data[k] ? s.references?.(data[k]) ?? [] : []));
  check('sections name what they point at', refs.some(r => r.section === 'npcs' && r.id === 'n') && refs.filter(r => r.section === 'items').length === 3);

  // validate and prepare of every section come before any commit
  const log = [];
  const bad = { name: 'bad', content: { laterSection: { validate() { throw new Error('refused'); }, commit() { log.push('bad'); } } } };
  const good = { name: 'good', content: { earlier: { commit() { log.push('good'); } } } };
  check('the pack is refused', refused(() => stand(good, bad).content.load({ earlier: {}, laterSection: {} }))?.message === 'refused');
  check('and nothing committed', log.length === 0);
}
