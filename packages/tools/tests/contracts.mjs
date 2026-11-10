// Module contracts (docs/plans/done/2026-11-02-gameplay-architecture.md §1.3, §7 step 10): the engine's inventory, interactions, flow, characters, calendar,
// dialogue, quests, camera and particles each pass the shared contract check (@threedog/tools/contract), and small fakes (tests/contract/fake*.js) pass the same
// check, so replacing a module is tested, not hoped for. The vehicle contract is an object contract: a rigid car's shape and a fake raft both pass it.
// That the engine's callers (NPC talk, timeline say, content loader, hud, character.enter, control: 'camera') work with the fakes is the browser
// spec specs/ui-nav.mjs. Also engine.wrap (core/ops/wrap.js): wrappers compose (last wrapped runs first), remove in any order, show in describe,
// refuse private methods, and calls from inside the module (ops) go through them.
// The "no way around it" check: every module with a contract file is run here (a new contract.js without a run fails).
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';
import { runContract, contractEngine, contractCtx } from '@threedog/tools/contract';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { flatGround } = await imp('core/scene/ground.js');
const { fakeInventory } = await imp('tests/contract/fakeInventory.js');
const { inventory } = await imp('modules/gameplay/Inventory.js');
const { interactions } = await imp('modules/gameplay/Interactions.js');
const { flow } = await imp('modules/flow/index.js');
const { characters } = await imp('modules/characters/index.js');
const { calendar } = await imp('modules/calendar/index.js');
const { dialogue } = await imp('modules/gameplay/Dialogue.js');
const { quests } = await imp('modules/gameplay/Quests.js');
const { followCamera } = await imp('modules/camera/FollowCamera.js');
const { particles } = await imp('modules/particles/Particles.js');
const all = { ...await imp('modules/collision/Collision.js'), ...await imp('modules/level/index.js'), ...await imp('modules/nav/index.js') };
const THREE = await import('three');
const { fakeDialogue } = await imp('tests/contract/fakeDialogue.js');
const { fakeQuests } = await imp('tests/contract/fakeQuests.js');
const { fakeCamera } = await imp('tests/contract/fakeCamera.js');
const { fakeVehicle } = await imp('tests/contract/fakeVehicle.js');
const { fakeCharacter } = await imp('tests/contract/fakeCharacter.js');
const { fakeCollider3d } = await imp('tests/contract/fakeCollider3d.js');

// What the engine's camera module touches beyond the small contract engine: engine.camera, a canvas to listen on, the scene, the takeover hold.
// Stand-ins only (no browser): the contract checks the surface, the camera's looks are its own browser tests.
const cameraParts = e => {
  globalThis.document ??= /** @type {any} */ ({ pointerLockElement: null, addEventListener() {} });
  const canvas = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), requestPointerLock() {} };
  Object.assign(e, { camera: new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000), scene: new THREE.Scene(), focus: new THREE.Vector3(), signal: new AbortController().signal,
    renderer: { domElement: canvas, getSize: v => v.set(800, 600) }, takeCamera: () => ({ remove() {} }), _oFov: { drive(v) { e.camera.fov = v; } }, raycast: () => null,
    player: null });
};
// what the engine's particles draw into: add / remove objects, the wind uniform (no renderer: the WebGL material is built, never drawn)
const particleParts = e => { Object.assign(e, { add() {}, remove() {}, tier: 'high', uniforms: { uWind: { value: 0 } } }); };
// a car shaped like rigid.addWheeled's (the parts character.enter uses: two seats, hidden riders, a passenger list), without Rapier
const rigidShaped = () => { const object = new THREE.Object3D(); return { id: 'car', object, body: null, controller: null, wheels: [], speed: 0, driver: null,
  seats: 2, hideDriver: true, passengers: [], drive() {},
  seatPosition: (seat = 0) => object.position.clone().setY(1).setX(seat * 0.8), exitPosition: (seat = 0) => object.position.clone().setX(2 - seat * 4) }; };

export const name = 'contracts: engine inventory / interactions / flow / characters / calendar / dialogue / quests / camera / particles and fakes pass one check; vehicle object contract; engine.wrap';

const CONTRACTS = {
  'modules/gameplay/inventory.contract.js': [['engine', o => inventory(o)], ['fake', () => fakeInventory()]],
  'modules/gameplay/interactions.contract.js': [['engine', o => interactions(o)]],
  'modules/flow/contract.js': [['engine', o => flow(o)]],
  'modules/characters/contract.js': [['engine', o => characters(o)]],
  'modules/calendar/contract.js': [['engine', o => calendar(o)]],
  'modules/gameplay/dialogue.contract.js': [['engine', o => dialogue(o)], ['fake', () => fakeDialogue()]],
  'modules/gameplay/quests.contract.js': [['engine', o => quests(o)], ['fake', () => fakeQuests()]],
  'modules/camera/contract.js': [['engine', () => followCamera(), cameraParts], ['fake', () => fakeCamera()]],
  'modules/particles/contract.js': [['engine', () => particles(), particleParts]],
  'modules/collision/contract.js': [['engine', o => all.collision(o)]],
  'modules/level/contract.js': [['engine', o => all.level(o), e => { e.setGround = () => {}; }]],
  'modules/nav/contract.js': [['engine', o => all.nav(o)]],
  'core/scene/ground.contract.js': [['flat', () => ({ ...flatGround })]],
  'modules/characters/character.contract.js': [['fake', () => fakeCharacter()]],   // the real one needs a browser: [guard] contract in specs/layer-conflicts.mjs
  'modules/characters/mover.contract.js': [['fake', () => ({ name: 'fly', move() {}, dispose() {} })]],
  'modules/characters/vehicle.contract.js': [['rigid-shaped', rigidShaped], ['fake', () => fakeVehicle()]],
  'modules/rigid/collider3d.contract.js': [['fake', () => fakeCollider3d()]],   // the real holder needs Rapier: tests/rigid-rules.mjs runs it
};

export async function run(t) {
  try { await checkContracts(t); } finally { delete globalThis.document; }   // cameraParts' stand-in: a later test in this process must not see a document
}

async function checkContracts({ check }) {
  for (const [file, impls] of Object.entries(CONTRACTS)) {
    const contract = (await imp(file)).default;
    for (const [who, make, prepare] of impls) await runContract(contract, () => make(contract.options), { check, label: `${contract.name} (${who})`, prepare });
  }
  // guard: every contract file in the engine is run above
  const found = [];
  const walk = d => { for (const f of readdirSync(join(ENGINE, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/(^|\.)contract\.js$/.test(f.name)) found.push(p); } };
  walk('modules');
  const unrun = found.filter(f => !CONTRACTS[f]);
  check('every modules/**/contract.js is run by this test', !unrun.length, unrun.join(', '));
  // [guard] who may write a character's position is stated where a replacement reads it, never implied
  const silent = [];
  for (const f of ['modules/characters/contract.js', 'modules/characters/mover.contract.js', 'modules/characters/vehicle.contract.js']) if ((await imp(f)).default.position?.authority !== 'solver') silent.push(f);
  check('[guard] the character, mover and vehicle contracts state the position authority', !silent.length, silent.join(', '));
  // [guard] no way around the bind check: a new contract is on the capability list in index.js, or named here with why it binds no capability
  const { CAP_CONTRACTS } = await imp('core/engine/moduleSlots.js');
  await imp('index.js');   // the list fills as index.js loads
  const NOT_CAPS = { mover: 'a per-character value of the rule character.mover', vehicle: 'a per-object shape, no module holds it', character: 'a per-object shape: characters hands it out' };
  const unbound = [];
  for (const f of found) { const c = (await imp(f)).default; if (!CAP_CONTRACTS.has(c.name) && !NOT_CAPS[c.name]) unbound.push(c.name); }
  check('[guard] every module contract binds at its capability (on the list in index.js) or says why not', CAP_CONTRACTS.size > 0 && !unbound.length, `size ${CAP_CONTRACTS.size}; missing: ${unbound.join(', ')}`);

  // ---- [guard] the contract engine is not looser than the real one: what engine.use() refuses fails the contract, and the save round trip loads in the engine's order
  // (first ranks, a part load returning a Promise holds the later ones). A third-party module that passes here must not throw when a game installs it
  const tiny = { name: 'tiny', api: ['get'], ops: [], saves: { zone: 1, level: 1 }, probe: { state: { read: ['get'], expect: 'zone in level' } } };
  const tinyModule = (o = {}) => () => ({ name: 'tiny', install(_e, ctx) {
    let level = null, zone = 'zone in level';
    // the zone is defined first but needs the level: only first: true puts the level ahead, and the level's load finishes later (a Promise) than the zone would start
    ctx.saves.define('zone', { notAtomic: 'test part', save: () => 'zone', load: d => { zone = level ? `${d} in ${level}` : `${d} before the level`; } });
    ctx.saves.define('level', { notAtomic: 'test part', first: o.badFirst ? 'yes' : true, save: () => 'level', load: d => new Promise(r => setTimeout(() => { level = d; r(); }, 1)) });
    if (o.twice) ctx.saves.define('level', { notAtomic: 'test part', save: () => 1, load() {} });
    const api = { get: () => zone };
    return o.async ? Promise.resolve(api) : api;
  } });
  const failsOf = async o => { const bad = []; await runContract(tiny, tinyModule(o), { check: (l, ok, d) => { if (!ok) bad.push(`${l} (${d ?? ''})`); } }); return bad; };
  const good = await failsOf();
  check('[guard] contract engine: the save round trip loads by first and waits for a part load that returns a Promise, as saves.load does', !good.length, good.join('; '));
  for (const [what, o] of [['a save key defined twice', { twice: true }], ["a first that is no number or boolean", { badFirst: true }], ['an install that returns a Promise', { async: true }]]) {
    const bad = await failsOf(o);
    check(`[guard] contract engine refuses ${what}, as engine.use() does`, bad.some(x => x.includes('installs on the contract engine')), bad.join('; ') || 'passed');
  }

  // ---- engine.wrap
  const e = contractEngine(), mod = inventory(), inv = mod.install(e, contractCtx(e, mod.name));
  e.inventory = inv; e.modules.set('inventory', mod);
  inv.define('fish', { name: 'Fish' }).define('rock', { name: 'Rock' });
  const order = [];
  const a = e.wrap(inv, 'add', (next, ...x) => { order.push('a'); return next(...x); }, { owner: 'log' });
  const weight = e.wrap(inv, 'add', (next, id, n = 1, o) => { order.push('w'); return id === 'rock' ? { ok: false, code: 'tooHeavy' } : next(id, n, o); }, { owner: 'weight' });
  inv.add('fish', 2);
  check('wrap: the last wrapped runs first, next reaches the earlier one, then the method', order.join('') === 'wa' && inv.count('fish') === 2, order.join(''));
  check('wrap: around may refuse (no next call, its result returned)', inv.add('rock').code === 'tooHeavy' && inv.count('rock') === 0);
  check('wrap: describe lists owners outermost first', JSON.stringify(e._wraps.describe()) === JSON.stringify({ 'inventory.add': ['weight', 'log'] }), JSON.stringify(e._wraps.describe()));
  // the op calls engine.inventory.transfer: a wrapper on transfer is on the op's path too (the wrapper sits on the object, not on one caller)
  e.inventory.container('chest').add('rock', 1);
  const t = e.wrap(inv, 'transfer', (next, from, to, item, n) => to === 'player' && item === 'rock' ? false : next(from, to, item, n), { owner: 'weight' });
  e.ops.run('inventory.transfer', { from: 'chest', to: 'player', item: 'rock', n: 1 });
  check('wrap: an op calling the wrapped method (inventory.transfer op -> inventory.transfer) goes through the wrapper', inv.count('rock') === 0, `rock ${inv.count('rock')}`);
  t.remove();
  a.remove(); order.length = 0; inv.add('fish');
  check('wrap: removing the inner one keeps the other', order.join('') === 'w' && inv.count('fish') === 3, order.join(''));
  weight.remove();
  check('wrap: removing the last one puts the class method back (no own property left)', !Object.prototype.hasOwnProperty.call(inv, 'add') && Object.keys(e._wraps.describe()).length === 0);
  // guard: dispose restores every wrapped method (an own method back as it was, a class method un-shadowed), the wrapper no longer runs
  const plain = { hi() { return 'hi'; } }, own0 = plain.hi;
  e.wrap(plain, 'hi', () => 'wrapped'); e.wrap(inv, 'add', () => false);
  e._wraps.dispose();
  check('[guard] wrap dispose(): own method back (same function), class method un-shadowed, describe empty', plain.hi === own0 && plain.hi() === 'hi'
    && !Object.prototype.hasOwnProperty.call(inv, 'add') && Object.keys(e._wraps.describe()).length === 0);
  const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
  check('wrap: a non-name method throws and lists the public ones', /count/.test(err(() => e.wrap(inv, 7, n => n()))));
  check('wrap: a leading _ is allowed (the object is yours to change); the handle takes it off', (() => { const h = e.wrap(inv, '_refresh', n => n()); h.remove(); return !!h; })());
  check('wrap: an unknown method throws naming the target', /inventory has no method 'ad'/.test(err(() => e.wrap(inv, 'ad', n => n()))), err(() => e.wrap(inv, 'ad', n => n())));
}
