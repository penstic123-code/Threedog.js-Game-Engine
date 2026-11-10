// [vertical] Top-down play chains of the 1.0 audit (docs/testing/review/2026-11-07-1.0-audit/vertical-play.md), driven through public API only.
// A name starting "[vertical FAILING]" proves an open bug: it fails on purpose until the bug is fixed; a fix renames the row. Each row first checks that its setup took, so it fails only for the reason in its name.
// Plain "[vertical]" rows are the same chains where nothing broke: they keep a clean result honest.
import { readFileSync } from 'node:fs';
import { TASK_ENDS } from '../../core/ops/control.js';
const src = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  const { all: T, THREE, mk } = threedogThreads;
  window.vpFlat = (name = 'vp') => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(200, 0.2, 200), new THREE.MeshBasicMaterial()); s.name = name; m.name = 'ground'; m.position.y = -0.1; s.add(m); return s; };
  window.vpSteps = (E, n) => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
  // every row builds its own game; the dev warnings of a bare test game are not what these rows look at
  window.vpGame = async (name, mods = () => [], { npcs = false } = {}) => {
    const E = mk(T.createEngine, name);
    E.use(T.world(), T.collision(), T.characters({ npcs }), T.level({ scene: vpFlat() }), ...mods(T));
    await E.start();
    E.ops.allow(() => E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } }));
    return E;
  };
  window.vpRide = n => vpGame(n, T => [T.rigid()]);
  window.vpPlay = n => vpGame(n, T => [T.inventory({ capacity: 1 }), T.quests(), T.interactions({ pick: 'nearest' }), T.pickups(), T.content({})]);
  window.vpCar = (E, id = 'vp-car', o = {}) => {
    const wheels = [[-1, 0, 1.5], [1, 0, 1.5], [-1, 0, -1.5], [1, 0, -1.5]].map(position => ({ position, radius: 0.35, drive: true }));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4)); mesh.position.set(5, 1, 0);
    return E.ops.allow(() => E.rigid.addWheeled(mesh, { id, wheels, ...o }));
  };
  window.vpSecond = E => E.ops.allow(() => E.characters.addPlayer({ id: 'p2', control: 'camera', spawn: { x: 3, z: 3 } }));
  window.vpWalk = (ch, to) => { const w = { status: null }; ch.walkTo(to).then(r => { w.status = r.status; }); return w; };
};

// the page's console stays quiet for the row; ev runs in the page, so fn sees setup's helpers
const row = (name, fn, checks) => ({
  name, url: PAGE,
  async run({ check, ev }) {
    await ev(setup);
    const r = await ev(`(async () => { const was = [console.error, console.warn]; console.error = console.warn = () => {}; try { return await (${fn})(); } finally { [console.error, console.warn] = was; } })()`);
    checks(check, r);
  },
});



export const specs = [
  // ---- chain A: walking and pathfinding
  row('[guard] walk level: a walk ends with the level it was planned on', async () => {
    const E = await vpGame('vpA1'), w = vpWalk(E.player, { x: 30, z: 0 });
    vpSteps(E, 30); const moved = E.player.position.x;
    await E.level.load(vpFlat('other')); vpSteps(E, 30); await 0;
    const out = { moved, status: w.status, owner: E.control.of(E.player)?.owner }; E.dispose(); return out;
  }, (check, r) => {
    check('the walk was under way', r.moved > 0.5, J(r));
    check('the walk ended with the level', r.status === 'cancelled' && r.owner !== 'walkTo', J(r));
  }),
  row('[guard] walk placement: a placement ends a walk, as it ends an NPC path', async () => {
    const E = await vpGame('vpA2'), w = vpWalk(E.player, { x: 30, z: 0 });
    vpSteps(E, 30); E.ops.allow(() => E.player.placeAt({ x: -40, z: 40 })); vpSteps(E, 30); await 0;
    const out = { status: w.status, x: E.player.position.x, z: E.player.position.z }; E.dispose(); return out;
  }, (check, r) => {
    check('the player was placed', r.x < -30, J(r));
    check('it stands where the game put it', r.status === 'cancelled' && Math.hypot(r.x + 40, r.z - 40) < 0.5, J(r));
  }),
  // the whole class: every row of TASK_ENDS, on a live walk, on player and NPC alike; a new row without a case here fails
  row('[guard] walk ends: every ending in the table answers a live walk and gives the slot back', async () => {
    const cases = {
      replaced: async (E, P) => { await E.session.newGame(); },
      level: async E => { await E.level.load(vpFlat('next')); },
      placed: async (E, P) => E.ops.allow(() => P.placeAt({ x: -5, z: 0 })),
      seated: async (E, P) => E.ops.allow(() => P.enter({ id: 'b', object: new threedogThreads.THREE.Group(), driver: null, speed: 0, seatPosition: () => ({ x: 0, y: 0, z: 0 }), exitPosition: () => ({ x: 1, y: 0, z: 0 }), drive() {} })),
      physics: async (E, P) => { const h = E.control.take(P, { owner: 'limp', layer: 'physics', step: () => false }); h.remove(); },
      gone: async (E, P) => E.ops.allow(() => E.world.remove(P.id)),
      order: async (E, P) => { P.walkTo({ x: -30, z: 0 }); },
    };
    const out = {};
    for (const [why, act] of Object.entries(cases)) {
      const E = await vpGame(`vpEnd-${why}`, () => [], { npcs: true });
      E.ops.allow(() => E.npcs.add({ id: 'guard', position: [3, 0, 3] })); vpSteps(E, 3);
      const G = E.control.characterOf('guard'), w = vpWalk(E.player, { x: 30, z: 0 }), g = vpWalk(G, { x: 3, z: 30 }); vpSteps(E, 10);
      await act(E, E.player); if (why !== 'level' && why !== 'replaced') await act(E, G); vpSteps(E, 3); await 0; await 0;
      out[why] = [w.status, g.status, E.control.has('player', 'walkTo')]; E.dispose();
    }
    return out;
  }, (check, r) => {
    check('every row of TASK_ENDS has a case', J(Object.keys(r).sort()) === J(Object.keys(TASK_ENDS).sort()), J(Object.keys(r)));
    for (const [why, [p, g, held]] of Object.entries(r)) check(`${why}: both walks said cancelled`, p === 'cancelled' && g === 'cancelled' && (why === 'order' || !held), J(r[why]));
  }),
  row('[guard] walk freeze: a cutscene above only suspends a walk, it is no ending', async () => {
    const E = await vpGame('vpPause'), w = vpWalk(E.player, { x: 30, z: 0 }); vpSteps(E, 10);
    const h = E.control.take(E.player, { owner: 'cs', layer: 'cutscene' }); vpSteps(E, 30); await 0; const during = w.status;
    h.remove(); const x = E.player.position.x; vpSteps(E, 30); const out = { during, moved: E.player.position.x - x }; E.dispose(); return out;
  }, (check, r) => check('still walking after it', r.during === null && r.moved > 0.5, J(r))),
  {
    name: '[guard] walk source: a walk subscribes to nothing, and no field outside the slot says one runs',
    url: PAGE,
    async run({ check }) {
      const w = src('modules/characters/walkTo.js'), c = src('modules/characters/Character.js');
      check('walkTo.js holds no event list', !/events\.on/.test(w));
      check('no ch._walk', !/\._walk\b/.test(w + c));
    },
  },
  row('[guard] npc placement: a placement by either door drops an NPC\'s path', async () => {
    const E = await vpGame('vpNpcPlace', () => [], { npcs: true });
    E.ops.allow(() => E.npcs.add({ id: 'guard', position: [3, 0, 3] })); vpSteps(E, 3);
    const rec = E.world.get('guard'), ch = E.control.characterOf('guard'), out = [];
    rec.nav.path = [{ x: 9, y: 0, z: 9 }]; E.ops.allow(() => ch.placeAt({ x: 1, z: 1 })); out.push(rec.nav.path);
    rec.nav.path = [{ x: 9, y: 0, z: 9 }]; E.ops.allow(() => E.world.move('guard', [2, 0, 2])); out.push(rec.nav.path);
    rec.nav.path = [{ x: 9, y: 0, z: 9 }]; E.ops.allow(() => E.npcs.get('guard').placeAt({ x: 4, z: 4 })); out.push(rec.nav.path);
    E.dispose(); return out;
  }, (check, r) => check('all three doors', r.every(p => p === null), J(r))),
  row('[vertical] walk: a way that closes ends with a status, keys come back, a cancel stops an NPC and its record follows', async () => {
    const E = await vpGame('vpA3', () => [], { npcs: true });
    const w = vpWalk(E.player, { x: 30, z: 0 }); vpSteps(E, 30);
    for (const [x, z, a, b] of [[30, -6, 8, 1], [30, 6, 8, 1], [24, 0, 1, 8], [36, 0, 1, 8]]) E.collision.addBox([x, 0, z], { halfWidth: a, halfDepth: b });
    vpSteps(E, 1500); await 0;
    const out = { status: w.status, owner: E.control.of(E.player)?.owner };
    E.ops.allow(() => E.npcs.add({ id: 'guard', position: [3, 0, 3] })); vpSteps(E, 5);
    const ch = E.control.characterOf('guard'), walk = ch.walkTo({ x: 20, z: 3 }); vpSteps(E, 40); walk.remove(); vpSteps(E, 40);
    Object.assign(out, { state: ch.state, gap: Math.abs(E.world.get('guard').position.x - ch.position.x) }); E.dispose(); return out;
  }, (check, r) => {
    check('the walk answered', ['noPath', 'stuck'].includes(r.status), J(r));
    check('the keys are back', r.owner === 'player-input', J(r));
    check('a cancelled NPC stands still and its record agrees', r.state === 'idle' && r.gap < 0.01, J(r));
  }),

  // ---- chain B: interaction, quests, inventory
  row('[vertical] play: use, take, quest step, reward and a load agree', async () => {
    const E = await vpPlay('vpB0'), o = new threedogThreads.THREE.Object3D(); E.scene.add(o);
    E.inventory.define('gem', { name: 'g', stack: 9 });
    E.interactions.add(o, { id: 'elder', label: 'talk', onUse: () => { E.quests.start('q'); } });
    E.quests.define('q', { title: 'q', steps: [{ id: 's', text: 's', done: e => e.inventory.has('gem', 1) }], reward: e => e.vars.setFlag('paid') });
    const used = E.ops.run('interaction.use', { id: 'elder' }).ok;
    E.ops.allow(() => E.pickups.spawn([0.5, 0, 0.5], { give: 'gem', id: 'drop' })); vpSteps(E, 3);
    const took = E.ops.run('pickup.take', { id: 'drop' }).ok; vpSteps(E, 90);
    E.saves.save('s'); await E.saves.flush(); const ok = await E.session.load('s'); vpSteps(E, 3);
    const out = { used, took, ok, done: E.quests.isDone('q'), gem: E.inventory.has('gem', 1), paid: !!E.vars.flag('paid'), drop: !!E.world.get('drop') }; E.dispose(); return out;
  }, (check, r) => check('every layer says the same after the load', r.used && r.took && r.ok && r.done && r.gem && r.paid && !r.drop, J(r))),
  row('[guard] reward full bag: a reward that does not fit is owed, said, saved and paid once there is room', async () => {
    const E = await vpPlay('vpB1'), said = [];
    for (const n of ['rock', 'gem']) E.inventory.define(n, { name: n, stack: 1 });
    E.ops.allow(() => E.inventory.add('rock', 1));
    for (const n of ['quest:unpaid', 'content:failed']) E.events.on(n, p => said.push([n, p.code]));
    E.quests.define('q', { title: 'q', steps: [{ id: 's', text: 's', done: () => false }], reward: () => E.content.run([{ give: { gem: 1 } }]) });
    E.ops.allow(() => { E.quests.start('q'); E.quests.advance('q'); }); vpSteps(E, 3);
    const row = () => E.quests.list().find(q => q.id === 'q');
    const full = { done: E.quests.isDone('q'), gem: E.inventory.has('gem', 1), owed: row().owed };
    vpSteps(E, 70);   // a check with no room asks again quietly: the event does not repeat
    E.saves.save('s'); await E.saves.flush(); await E.session.newGame(); vpSteps(E, 2);
    await E.session.load('s'); vpSteps(E, 2);
    const loaded = row().owed;
    E.ops.allow(() => E.inventory.remove('rock', 1)); vpSteps(E, 70);
    const out = { full, said, loaded, gem: E.inventory.count('gem'), after: row().owed ?? null, error: !!E.error }; E.dispose(); return out;
  }, (check, r) => {
    check('the quest finished, and the gem is owed by name', r.full.done && !r.full.gem && r.full.owed?.gem === 1, J(r));
    check('the game was told once: which reward, and why', r.said.filter(x => x[0] === 'quest:unpaid').length === 1 && r.said[0][1] === 'full', J(r));
    check('the debt survives a save and a load', r.loaded?.gem === 1, J(r));
    check('room pays it once, and the debt is gone', r.gem === 1 && r.after === null && !r.error, J(r));
  }),
  row('[guard] unpaid rewards: part of a stack is owed, onUnpaid is the game\'s choice, a function reward answers too', async () => {
    const E = await vpPlay('vpB1b'), told = [], chose = [];
    E.inventory.define('coin', { name: 'coin', stack: 3 });
    const step = [{ id: 's', text: 's', done: () => false }], end = id => E.ops.allow(() => { E.quests.start(id); E.quests.advance(id); });
    E.events.on('quest:unpaid', p => told.push(p.id));
    E.quests.define('part', { title: 'part', steps: step, reward: () => E.content.run({ give: { coin: 5 } }) });
    end('part');
    const part = { coins: E.inventory.count('coin'), owed: E.quests.list().find(q => q.id === 'part').owed };
    E.quests.define('mine', { title: 'mine', steps: step, reward: () => E.content.run({ give: { coin: 1 } }), onUnpaid: (e, a) => chose.push(a.code) });
    end('mine');
    const mine = E.quests.list().find(q => q.id === 'mine').owed ?? null;
    E.quests.define('fn', { title: 'fn', steps: step, reward: e => e.inventory.add('coin', 9) });
    end('fn');
    E.quests.define('boom', { title: 'boom', steps: step, reward: () => { throw new Error('reward bug'); } });
    end('boom');
    const out = { part, mine, chose, told, boom: E.quests.isDone('boom') }; E.dispose(); return out;
  }, (check, r) => {
    check('what did not fit of a stack is owed, what fit stays', r.part.coins === 3 && r.part.owed?.coin === 2, J(r));
    check('onUnpaid decides: it is called and nothing is kept', r.chose[0] === 'full' && r.mine === null, J(r));
    check('a failed function reward and a throwing one reach the same place', r.told.includes('fn') && r.told.includes('boom') && r.boom, J(r));
  }),
  row('[guard] effect answers: a failed word reaches the top from every runner, and content.run returns it', async () => {
    const E = await vpGame('vpB1c', T => [T.inventory({ capacity: 1 }), T.quests(), T.dialogue(), T.triggers(), T.content({})]), got = [];
    E.inventory.define('rock', { name: 'rock', stack: 1 }); E.inventory.define('gem', { name: 'gem', stack: 1 });
    E.ops.define('t.no', { run: () => ({ ok: false, code: 'nope' }) });
    E.ops.allow(() => E.inventory.add('rock', 1));
    E.events.on('content:failed', p => got.push(p.failed.map(f => f.word + ':' + f.code).join()));
    const answers = E.ops.allow(() => [{ give: { gem: 1 } }, { take: { gem: 1 } }, { op: ['t.no'] }].map(w => E.content.run(w)));
    const clean = E.ops.allow(() => E.content.run({ setFlag: 'x' }));
    const both = E.ops.allow(() => E.content.run([{ give: { gem: 1 } }, { setFlag: 'after' }]));
    E.ops.define('t.wrapped', { atomic: true, run: e => { e.vars.setFlag('wrapped'); return e.content.run({ op: ['t.no'] }); } });
    const wrapped = E.ops.run('t.wrapped');
    got.length = 0;
    await E.content.load({ dialogues: { d: { nodes: { start: { text: 'x', do: { op: ['t.no'] } } } } }, triggers: { t: { position: { x: 30, z: 0 }, radius: 3, onEnter: { op: ['t.no'] } } } });
    E.ops.allow(() => E.dialogue.start('d')); vpSteps(E, 2); E.ops.allow(() => { E.dialogue.end(); E.player.placeAt({ x: 30, z: 0 }); }); vpSteps(E, 40);
    const out = { codes: answers.map(a => [a.ok, a.code, a.facts.failed[0].word]), clean, after: !!E.vars.flag('after'), left: both.facts.failed[0].facts.left, wrapped: [wrapped.ok, wrapped.code, !!E.vars.flag('wrapped')], got }; E.dispose(); return out;
  }, (check, r) => {
    check('give, take and op each answer with their failure', J(r.codes) === J([[false, 'full', 'give'], [false, 'notEnough', 'take'], [false, 'nope', 'op']]), J(r));
    check('a list that all ran answers ok', r.clean?.ok === true, J(r));
    check('one failing word does not stop the rest, and says what is left', r.after && r.left?.gem === 1, J(r));
    check('an op that returns the answer fails with it, and rolls back', J(r.wrapped) === J([false, 'nope', false]), J(r));
    check('a dialogue do and a trigger reach the game the same way', r.got.length === 2 && r.got.every(g => g === 'op:nope'), J(r));
  }),
  row('[guard] async once: an onUse is judged when it settles, whatever way it ends', async () => {
    const E = await vpPlay('vpB2'), T = threedogThreads.THREE, sites = {}, add = (id, onUse, more) => { const o = new T.Object3D(); E.scene.add(o); E.interactions.add(o, { id, label: 'x', once: true, onUse, ...more }); sites[id] = o; };
    let open = null;
    add('shrine', async () => ({ ok: false, code: 'locked' }));
    add('broken', async () => { throw new Error('later'); });
    add('door', () => new Promise(r => { open = r; }));
    add('stale', () => new Promise(r => { open = r; }));
    const use = id => E.ops.run('interaction.use', { id }), can = id => E.ops.can('interaction.use', { id }).ok;
    const shrine = await use('shrine').value, broken = await use('broken').value;
    const v = use('door');
    const during = { visible: sites.door.visible, again: can('door') };
    open({ ok: true }); await v.value;
    E.saves.save('s'); await E.saves.flush();
    const stale = use('stale').value, waiting = can('stale');
    await E.session.load('s'); open({ ok: true }); await stale;
    const out = { shrine, broken, ran: v.ok, sh: [sites.shrine.visible, can('shrine')], br: [sites.broken.visible, can('broken')], during, door: [sites.door.visible, can('door')], waiting, st: [sites.stale.visible, can('stale')] }; E.dispose(); return out;
  }, (check, r) => {
    check('the use ran', r.ran, J(r));
    check('a failure after an await leaves the shrine', r.shrine.code === 'locked' && r.sh.every(Boolean), J(r));
    check('a rejected onUse leaves it too, and answers with a failure', r.broken.ok === false && r.broken.code === 'error' && r.br.every(Boolean), J(r));
    check('while it waits it is not spent and cannot be used twice', r.during.visible && !r.during.again && !r.waiting, J(r));
    check('a success spends it when it settles', !r.door[0] && !r.door[1], J(r));
    check('a use from before a load spends nothing in the state after it', r.st[0] && r.st[1], J(r));
  }),
  row('[guard] other endings: a dialogue and a flow transition give back what they hold, whatever way they end', async () => {
    const E = await vpGame('vpSweep', T => [T.dialogue(), T.flow()]), ended = [];
    E.events.on('dialogue:end', s => ended.push(s));
    const free = () => E.input.enabled;
    E.dialogue.define('bad', { start: { text: 'x', do: () => { throw new Error('do failed'); } } });
    const said = await Promise.race([E.dialogue.say({ start: { text: 'x', do: () => { throw new Error('do failed'); } } }).then(() => 'answered'), new Promise(r => setTimeout(() => r('hung'), 200))]);
    E.dialogue.start('bad');
    const afterThrow = { active: !!E.dialogue.active, free: free() };
    E.dialogue.define('ok', { start: { text: 'x', next: 'two' }, two: { text: 'y' } });
    E.dialogue.start('ok');
    const held = !!E.dialogue.active;
    E.saves.save('s'); await E.saves.flush(); await E.session.load('s'); vpSteps(E, 2);
    const afterLoad = { active: !!E.dialogue.active, free: free() };
    let threw = false;
    await E.flow.transition(() => { throw new Error('swap failed'); }, { fade: 0 }).catch(() => { threw = true; }); vpSteps(E, 2);
    const out = { said, afterThrow, held, afterLoad, threw, transitioning: E.flow.transitioning, free: free(), ended: ended.length }; E.dispose(); return out;
  }, (check, r) => {
    check('a do that throws ends the conversation and answers its say()', r.said === 'answered' && !r.afterThrow.active && r.afterThrow.free, J(r));
    check('a load ends a conversation that was open', r.held && !r.afterLoad.active && r.afterLoad.free, J(r));
    check('a transition whose swap throws answers, and gives the keys back', r.threw && !r.transitioning && r.free, J(r));
  }),
  row('[guard] approach cancel: an approach can be called off through what it returned', async () => {
    const E = await vpPlay('vpB3'), o = new threedogThreads.THREE.Object3D(); o.position.set(20, 0, 0); E.scene.add(o);
    let used = 0;
    E.interactions.add(o, { id: 'clerk', label: 'x', radius: Infinity, approach: true, onUse: () => { used++; } });
    const r = E.ops.run('interaction.use', { id: 'clerk' }); vpSteps(E, 10);
    const out = { walking: E.control.of(E.player)?.owner, cancel: typeof r.value?.approaching?.remove };
    r.value.approaching.remove(); out.answer = (await r.value.approaching).status; vpSteps(E, 3); Object.assign(out, { used, keys: E.control.of(E.player)?.owner }); E.dispose(); return out;
  }, (check, r) => {
    check('the player is walking there', r.walking === 'walkTo', J(r));
    check('the handle has remove(), like the walk it stands for', r.cancel === 'function', J(r));
    check('remove() stops the walk: nothing used, the keys are back', r.answer === 'cancelled' && r.used === 0 && r.keys === 'player-input', J(r));
  }),
  row('[guard] atomic once: a once item used inside a failed atomic op comes back', async () => {
    const E = await vpPlay('vpB4'), o = new threedogThreads.THREE.Object3D(); E.scene.add(o);
    E.interactions.add(o, { id: 'stall', label: 'x', once: true, onUse: () => ({ ok: true }) });
    E.ops.define('shop.buy', { atomic: true, run(e) { e.ops.run('interaction.use', { id: 'stall' }); e.vars.setFlag('paid'); return { ok: false, code: 'nope' }; } });
    const r = E.ops.run('shop.buy'), out = { failed: !r.ok, paid: !!E.vars.flag('paid'), visible: o.visible, again: E.ops.can('interaction.use', { id: 'stall' }).ok }; E.dispose(); return out;
  }, (check, r) => {
    check('the op failed and the flag went back', r.failed && !r.paid, J(r));
    check('the stall went back with it', r.visible && r.again, J(r));
  }),

  // ---- chain C: combat and damage (the rules are the game's: ops on world records, recipe 32)
  row('[vertical] fight: a kill rolled back brings the NPC back whole, a stun ends with the playthrough', async () => {
    const E = await vpGame('vpC1', T => [T.interactions({ pick: 'nearest' })], { npcs: true });
    E.ops.allow(() => E.npcs.add({ id: 'guard', position: [3, 0, 3] })); vpSteps(E, 5);
    const w = vpWalk(E.control.characterOf('guard'), { x: 20, z: 3 }); vpSteps(E, 20);
    E.ops.define('enemy.kill', { atomic: true, run(e) { e.world.remove('guard'); return { ok: false, code: 'nope' }; } });
    const failed = !E.ops.run('enemy.kill').ok; vpSteps(E, 60); await 0;
    const c = E.control.characterOf('guard'), out = { failed, rec: !!E.world.get('guard'), scene: !!c?.root?.parent, holder: E.control.of('guard')?.owner ?? null, status: w.status };
    E.mod('move.speed', { owner: 'stun', id: 'player', set: 0 }); out.stunned = E.player.stat('speed');
    await E.session.newGame(); vpSteps(E, 2); out.speed = E.player.stat('speed'); E.dispose(); return out;
  }, (check, r) => {
    check('record, model and its driver are back', r.failed && r.rec && r.scene && r.holder === 'npcs', J(r));
    check('the walk it was on said cancelled', r.status === 'cancelled', J(r));
    check('the stun ended with the playthrough', r.stunned === 0 && r.speed > 0, J(r));
  }),
  {
    name: '[guard] limp walk: a body knocked down ends the walk it was on',
    url: '/tests/ragdoll/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        while (!window.ready) await new Promise(res => setTimeout(res, 50));
        engine.haltLoop(); const p = engine.player; engine.step(0.2);
        let status = null; p.walkTo({ x: 8, z: 0 }).then(x => { status = x.status; }); engine.step(0.2);
        const rd = engine.ops.allow(() => engine.rigid.ragdoll(p, { impulse: [150, 120, 250] })); engine.step(1);
        const rec = engine.world.get('player').position, gap = Math.hypot(rec.x - p.position.x, rec.z - p.position.z);
        engine.step(10); await 0; const whileDown = status;
        rd.remove(); engine.step(0.5); await 0;
        return { gap, whileDown, owner: engine.control.of(p)?.owner };
      });
      check('the record follows the body (clean)', r.gap < 0.01, J(r));
      check('an 11 s fall ended the walk: nobody waits on a body that cannot walk', r.whileDown === 'cancelled', J(r));
      check('getting up does not walk on to the old order', r.owner !== 'walkTo', J(r));
    },
  },

  // ---- chain D: vehicles and riding
  row('[guard] stale throttle: a driver paused by a higher holder lets go of the pedal', async () => {
    const E = await vpRide('vpD1'), car = vpCar(E), P = E.player;
    vpSteps(E, 30); E.ops.allow(() => P.enter(car)); E.input.autopilot = { x: 0, y: 1 }; vpSteps(E, 60); const was = car.speed;
    E.control.take(P, { owner: 'cs', layer: 'cutscene', step: () => null }); E.input.autopilot = null; vpSteps(E, 120);
    const out = { was, now: car.speed }; E.dispose(); return out;
  }, (check, r) => {
    check('the car was driving', r.was > 0.3, J(r));
    check('it does not keep accelerating with nobody on the pedal', r.now <= r.was, J(r));
  }),
  row('[guard] enter walk: entering a vehicle stops the walk', async () => {
    const E = await vpRide('vpD2'), car = vpCar(E), P = E.player; vpSteps(E, 30);
    const w = vpWalk(P, { x: 30, z: 0 }); vpSteps(E, 10);
    E.ops.allow(() => P.enter(car)); vpSteps(E, 5); await 0;
    const owner = E.control.of(P)?.owner; E.input.autopilot = { x: 0, y: 1 }; vpSteps(E, 60);
    const out = { inCar: P.vehicle === car, status: w.status, owner, speed: car.speed }; E.dispose(); return out;
  }, (check, r) => {
    check('the player sits in the car', r.inCar, J(r));
    check('the walk ended (Character.enter says "stops walking")', r.status === 'cancelled' && r.owner === 'player-input', J(r));
    check('the keys drive at once', r.speed > 0.3, J(r));
  }),
  row('[guard] seat saved: a load puts each rider back on the seat it sat on', async () => {
    let E = await vpRide('vpD3'), car = vpCar(E, 'c3', { seats: [[0, 0, 1], [0, 0, -1]] }); vpSteps(E, 10);
    let Q = vpSecond(E);
    E.ops.allow(() => { Q.enter(car); E.player.enter(car); });
    const before = [E.player.seat, Q.seat];
    E.saves.save('s'); await E.saves.flush(); E.dispose();
    E = await vpRide('vpD3'); car = vpCar(E, 'c3', { seats: [[0, 0, 1], [0, 0, -1]] }); Q = vpSecond(E);
    const ok = await E.session.load('s'); vpSteps(E, 3);
    const out = { before, ok, after: [E.player.seat, Q.seat] }; E.dispose(); return out;
  }, (check, r) => {
    check('p2 drove, the player rode', r.ok && J(r.before) === '[1,0]', J(r));
    check('the same seats after the load', J(r.after) === J(r.before), J(r));
  }),
  row('[guard] late car: a vehicle built after the load takes its saved rider, or the record stops claiming it', async () => {
    let E = await vpRide('vpD4'), car = vpCar(E, 'c4'); vpSteps(E, 10); E.ops.allow(() => E.player.enter(car)); vpSteps(E, 3);
    E.saves.save('s'); await E.saves.flush(); E.dispose();
    E = await vpRide('vpD4'); const ok = await E.session.load('s'); vpSteps(E, 2);
    car = vpCar(E, 'c4'); vpSteps(E, 3);
    const out = { ok, seated: E.player.vehicle === car, record: E.world.get('player').vehicle }; E.dispose(); return out;
  }, (check, r) => {
    check('the load went through', r.ok, J(r));
    check('record and rider agree', r.seated === (r.record === 'c4'), J(r));
    check('rigid keeps a late body its saved state, so the rider is seated too', r.seated, J(r));
  }),
  row('[guard] late car, NPC: a vehicle that joins after a load takes back the NPC its record names; one gone for good lets the record go', async () => {
    const boatOf = (id = 'boat') => { const object = new threedogThreads.THREE.Group(); return { id, object, driver: null, speed: 0, passengers: [], seatPosition: () => ({ x: 1, y: 0, z: 1 }), exitPosition: () => ({ x: 2, y: 0, z: 2 }), drive() {} }; };
    const E = await vpGame('vpD4n', () => [], { npcs: true }), boat = boatOf();
    E.scene.add(boat.object); E.ops.allow(() => { E.npcs.add({ id: 'guard', position: [3, 0, 3] }); }); vpSteps(E, 5);
    const G = E.control.characterOf('guard'); E.ops.allow(() => G.enter(boat)); vpSteps(E, 3);
    const saved = E.world.get('guard').vehicle;
    E.saves.save('s'); await E.saves.flush();
    boat.gone = true; const ok = await E.session.load('s'); vpSteps(E, 5);
    const waiting = E.world.get('guard').vehicle, late = boatOf(); E.scene.add(late.object);
    const book = E.characters.addVehicle(late); vpSteps(E, 3);
    const seated = E.control.characterOf('guard')?.vehicle === late;
    E.ops.allow(() => E.control.characterOf('guard').exit({ force: true })); vpSteps(E, 2);
    // a far NPC has no model to exit: only the record says it rides
    E.ops.allow(() => E.world.set('guard', { vehicle: 'boat', seat: 0 })); E.npcs.get('guard').placeAt({ x: 4, z: 4 }); const placed = E.world.get('guard').vehicle;
    const wreck = boatOf('wreck'), held = E.characters.addVehicle(wreck);
    E.ops.allow(() => E.world.set('guard', { vehicle: 'wreck', seat: 0 })); wreck.gone = true; held.remove(); book.remove();
    const out = { saved, ok, waiting, seated, placed, cleared: E.world.get('guard').vehicle ?? null, seat: E.world.get('guard').seat ?? null }; E.dispose(); return out;
  }, (check, r) => {
    check('the NPC record names its seat, and the load goes through', r.saved === 'boat' && r.ok, J(r));
    check('the record waits for the boat', r.waiting === 'boat', J(r));
    check('the boat that joins takes the NPC back', r.seated, J(r));
    check('a placement ends a record that only waits', r.placed == null, J(r));
    check('a vehicle gone for good lets the record go', r.cleared === null && r.seat === null, J(r));
  }),
  row('[guard] own vehicle: a contract vehicle with an id keeps its rider through a load', async () => {
    const E = await vpRide('vpD5'), P = E.player, boat = { id: 'boat', object: new threedogThreads.THREE.Group(), driver: null, speed: 0, seatPosition: () => ({ x: 1, y: 0, z: 1 }), exitPosition: () => ({ x: 2, y: 0, z: 2 }), drive() {} };
    E.scene.add(boat.object); E.ops.allow(() => P.enter(boat)); vpSteps(E, 3);
    const saved = E.world.get('player').vehicle;
    E.saves.save('s'); await E.saves.flush(); const ok = await E.session.load('s'); vpSteps(E, 3);
    const out = { saved, ok, seated: E.player.vehicle === boat }; E.dispose(); return out;
  }, (check, r) => {
    check('the record named the boat', r.saved === 'boat' && r.ok, J(r));
    check('vehicle.contract.js: "saves put the player back into the vehicle with that id"', r.seated, J(r));
  }),
  row('[guard] rider left: a seat holds its rider with or without a holder that moves it', async () => {
    const E = await vpRide('vpD6'), car = vpCar(E), P = E.player; vpSteps(E, 30); E.ops.allow(() => P.enter(car)); E.input.autopilot = { x: 0, y: 1 }; vpSteps(E, 30);
    E.control.take(P, { owner: 'manual', layer: 'script' }); vpSteps(E, 90);
    const s = car.seatPosition(0), out = { gap: Math.hypot(s.x - P.position.x, s.z - P.position.z), inCar: P.vehicle === car }; E.dispose(); return out;
  }, (check, r) => {
    check('still riding', r.inCar, J(r));
    check('the rider is on the seat', r.gap < 0.2, J(r));
  }),
  row('[guard] exit wall: getting out beside a wall does not put the rider into the chassis and shove the car', async () => {
    const E = await vpRide('vpD7'), car = vpCar(E, 'c7'), P = E.player; vpSteps(E, 60);
    const ex = car.exitPosition(0), x0 = car.object.position.x;
    E.collision.addBox([ex.x + 1.3, 0, ex.z], { halfWidth: 2, halfDepth: 3 });   // clear of the chassis: a wall overlapping it would itself push the car out
    E.ops.allow(() => P.enter(car)); vpSteps(E, 2); E.ops.allow(() => P.exit()); vpSteps(E, 30);
    const out = { out: !P.vehicle, px: P.position.x, x0, shoved: Math.abs(car.object.position.x - x0), half: car.exitPosition(0).x - car.object.position.x }; E.dispose(); return out;
  }, (check, r) => {
    check('the rider got out', r.out, J(r));
    check('nobody shoves the parked car: the rider stands beside it, outside the 1 m half-width chassis', r.shoved < 0.2 && Math.abs(r.px - r.x0) > 1, J(r));
  }),
  row('[guard] exit refused: with every exit blocked the rider stays seated, and a forced exit still gets out', async () => {
    const E = await vpRide('vpExit'), car = vpCar(E, 'c9'), P = E.player; vpSteps(E, 60);
    for (let n = 0; n < 4; n++) { const p = car.exitPosition(0, n); E.collision.addBox([p.x, 0, p.z], { halfWidth: 0.6, halfDepth: 0.6 }); }
    E.ops.allow(() => P.enter(car)); const ok = E.ops.allow(() => P.exit()), stays = P.vehicle === car, rec = E.world.get('player').vehicle;
    const forced = E.ops.allow(() => P.exit({ force: true })), past = car.exitPosition(0, 4), out = { ok, stays, rec, forced, off: !P.vehicle, past }; E.dispose(); return out;
  }, (check, r) => {
    check('refused, seated, the record agrees', r.ok === false && r.stays && r.rec === 'c9', J(r));
    check('force gets out; the list ends with null', r.forced === true && r.off && r.past === null, J(r));
  }),
  // the class: any vehicle, built any time, by anyone, in a fresh session; seat kept and the rider on it with no holder running
  row('[guard] seat book: a game-made vehicle that joins before or after the load gets its rider back on its seat', async () => {
    const boat = () => ({ id: 'boat', seats: 2, object: new threedogThreads.THREE.Group(), driver: null, passengers: [], speed: 0, seatPosition: s => ({ x: 7 + s, y: 0, z: 1 }), exitPosition: () => ({ x: 2, y: 0, z: 2 }), drive() {} });
    let E = await vpRide('vpSeat'), b = boat(); E.scene.add(b.object); let Q = vpSecond(E);
    E.ops.allow(() => { Q.enter(b); E.player.enter(b); }); E.saves.save('s'); await E.saves.flush(); E.dispose();
    const out = {};
    for (const when of ['before', 'after']) {
      E = await vpRide('vpSeat'); Q = vpSecond(E); b = boat(); E.scene.add(b.object);
      if (when === 'before') E.characters.addVehicle(b);
      await E.session.load('s'); if (when === 'after') E.characters.addVehicle(b);
      vpSteps(E, 2); out[when] = [E.player.vehicle === b, E.player.seat, Q.seat, E.player.position.x, E.world.get('player').seat]; E.dispose();
    }
    return out;
  }, (check, r) => { for (const w of ['before', 'after']) check(`joined ${w}: seat 1 and seat 0, on the seat`, J(r[w]) === '[true,1,0,8,1]', J(r)); }),
  {
    name: '[guard] seat source: the seat has one writer and asks no module for a vehicle',
    url: PAGE,
    async run({ check }) {
      const c = src('modules/characters/Character.js'), p = src('modules/characters/player.js');
      check('move() does not write the seat', !/seatPosition/.test(c.slice(c.indexOf('  move(dirX'), c.indexOf('   * Enter a vehicle'))));
      check('the input step does not drive', !/\.drive\(/.test(p));
      check('characters reads no rigid list, and no event writes the record', !/rigid\?*\.vehicles|vehicle:enter|vehicle:exit/.test(p));
    },
  },
  row('[vertical] ride: a removed car lets out every rider and the records say so', async () => {
    const E = await vpRide('vpD8'), car = vpCar(E, 'c8', { seats: [[0, 0, 1], [0, 0, -1]] }), P = E.player, Q = vpSecond(E); vpSteps(E, 10);
    E.ops.allow(() => { P.enter(car); Q.enter(car); });
    const seats = [P.seat, Q.seat];
    E.ops.allow(() => car.remove()); vpSteps(E, 3);
    const out = { seats, p: !!P.vehicle, q: !!Q.vehicle, visible: Q.root.visible, record: E.world.get('p2').vehicle }; E.dispose(); return out;
  }, (check, r) => check('both out, visible, records clear', J(r.seats) === '[0,1]' && !r.p && !r.q && r.visible && r.record === null, J(r))),
];
