// Group L3G (docs/plans/research/2026-11-10-claude-review-l3-gameplay.md items 1-6, 8-11): one test item each so one throw stops no other.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group L3G 1: a once zone whose onEnter removes itself exits once, not twice',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-1'); E.use(A.triggers()); await E.start(); E.haltLoop();
        let exits = 0, evs = 0; E.events.on('trigger:exit', () => evs++);
        E.triggers.add({ shape: 'sphere', radius: 2, position: { x: 0, y: 0, z: 0 }, who: () => [{ x: 0, y: 0, z: 0 }], once: true, onEnter: t => t.remove(), onExit: () => exits++ });
        E.step(0.1, { render: false });
        const out = { exits, evs }; E.dispose(); return out;
      });
      check('one exit callback and one trigger:exit event', r.exits === 1 && r.evs === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 2: a reward that answers a plain { ok: false, code } still gives quest:done and runs onUnpaid',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-2'); E.use(A.quests()); await E.start(); E.haltLoop();
        let done = 0, unpaid = 0, err = null;
        E.events.on('quest:done', () => done++);
        E.quests.define('q', { title: 'Q', steps: [{ text: 'a', done: () => false }], reward: () => ({ ok: false, code: 'nope' }), onUnpaid: () => { unpaid++; } });
        try { E.ops.allow(() => { E.quests.start('q'); E.quests.advance('q'); }); } catch (x) { err = x.message; }
        const out = { done, unpaid, err }; E.dispose(); return out;
      });
      check('no TypeError, quest:done fired and onUnpaid ran', r.err === null && r.done === 1 && r.unpaid === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 3: pickup:take on a partial take reports the count taken, not 0',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-3'); E.use(A.world(), A.inventory({ capacity: 1 }), A.pickups()); await E.start(); E.haltLoop();
        E.inventory.define('rock', { name: 'rock', stack: 3 });
        const got = []; E.events.on('pickup:take', x => got.push(x.count));
        E.ops.allow(() => { E.pickups.spawn([0, 0, 0], { give: 'rock', count: 5, id: 'p' }); });
        const res = E.ops.run('pickup.take', { id: 'p' }, { actor: 'player' });
        const out = { got, ok: res.ok, left: E.world.get('p')?.count }; E.dispose(); return out;
      });
      check('3 taken of 5 (2 stay on the ground)', r.got.join() === '3' && r.left === 2, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 4: a failed npcs.add leaves nothing behind (name free again, no runtime for a non-NPC id)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-4'); E.use(A.world(), A.characters()); await E.start(); E.haltLoop();
        const out = {};
        try { E.npcs.add({ name: 'Bob', behavior: 'no-such-behavior' }); } catch (x) { out.first = x.code ?? x.message; }
        try { E.npcs.add({ name: 'Bob' }); out.retry = 'ok'; } catch (x) { out.retry = x.code ?? x.message; }
        E.ops.allow(() => E.world.add({ id: 'rock1', kind: 'rockish', position: [0, 0, 0] }));
        try { E.npcs.add({ id: 'rock1', name: 'X' }); } catch (x) { out.kind = x.code ?? x.message; }
        out.runtime = E.npcs._runtime.has('rock1');
        E.dispose(); return out;
      });
      check('the retry works and the non-NPC id has no runtime entry', r.first && r.retry === 'ok' && r.kind && r.runtime === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 5: a dialogue line whose text() throws ends the dialogue (focus released)',
    url: PAGE,
    expectErrors: /dialogue text/,   // the throw is the point; it is reported soft
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-5'); E.use(A.dialogue()); await E.start(); E.haltLoop();
        E.dialogue.define('s', { start: { text: 'one', next: 'b' }, b: { text: () => { throw new Error('boom'); } } });
        const out = {};
        try { E.dialogue.start('s'); E.step(1, { render: false }); E.ops.run('dialogue.advance', {}, { source: 'player' }); E.step(1, { render: false }); } catch (x) { out.threw = x.message; }
        out.active = !!E.dialogue.active; out.top = A.uiFocus(E).top;
        E.dispose(); return out;
      });
      check('no throw, dialogue closed, focus not left on it', !r.threw && !r.active && r.top !== 'dialogue', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 6: after the content module is installed again, zone effects still run',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-6'); E.use(A.world(), A.triggers(), A.content()); await E.start(); E.haltLoop();
        const data = { triggers: { z: { position: { x: 0, z: 0 }, radius: 2, who: () => [{ x: 0, y: 0, z: 0 }], onEnter: { setFlag: 'l3g6' } } } };
        E.content.load(data);
        E.unuse('content'); E.use(A.content());
        E.content.load(data);
        E.step(0.1, { render: false });
        const out = { flag: E.vars.flag('l3g6') }; E.dispose(); return out;
      });
      check('the flag is set by the reinstalled content\'s listener', r.flag === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 8: a findPathAsync done that throws does not stop the other requests of its batch',
    url: PAGE,
    expectErrors: /findPathAsync done/,   // the throw is the point; it is reported soft
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-8'); E.use(A.world(), A.collision(), A.characters({ npcs: false })); await E.start(); E.haltLoop();
        let second = false;
        E.characters.findPathAsync({ x: 0, z: 0 }, { x: 4, z: 0 }, () => { throw new Error('boom'); });
        E.characters.findPathAsync({ x: 0, z: 0 }, { x: 5, z: 0 }, () => { second = true; });
        let err = null;
        try { for (let i = 0; i < 12 && !second; i++) E.step(1 / 60, { render: false, describe: false }); } catch (x) { err = x.message; }
        const out = { second, err }; E.dispose(); return out;
      });
      check('the second request is answered and nothing escapes', r.second && r.err === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 9: addHull on an interleaved position attribute sends one point per vertex',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-9'); E.use(A.world(), A.collision(), A.rigid()); await E.start(); E.haltLoop();
        const ib = new THREE.InterleavedBuffer(new Float32Array(8 * 6), 6), g = new THREE.BufferGeometry();
        const c = [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]];
        c.forEach((p, i) => ib.array.set(p, i * 6));
        g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); E.scene.add(m);
        const CD = E.rigid.rapier.ColliderDesc, hull = CD.convexHull; let n = -1;
        CD.convexHull = pts => { n = pts.length; return hull.call(CD, pts); };
        try { E.rigid.addHull(m, { fixed: true }); } finally { CD.convexHull = hull; }
        E.dispose(); return { n };
      });
      check('24 numbers (8 vertices), no extra points at the origin', r.n === 24, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 10: a throwing use in the fixed step does not leave the pick pass open',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-10'); E.use(A.world(), A.interactions({ pick: 'nearest' })); await E.start(); E.haltLoop();
        const I = E.interactions; I._presses = () => { throw new Error('boom'); };
        try { I.fixed(1 / 60); } catch { /* the throw is the point */ }
        const out = { pass: I._pass }; E.dispose(); return out;
      });
      check('the pass is closed again', r.pass === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 11: with pickMode facing, an item straight above the actor can still be picked',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-11'); E.use(A.world(), A.collision(), A.characters({ npcs: false }), A.interactions({ pick: 'nearest' })); await E.start(); E.haltLoop();
        E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const p = E.player.position;
        E.interactions.pickMode = 'facing';
        E.interactions.add({ x: p.x, y: p.y + 3, z: p.z }, { id: 'above', label: 'Above', radius: 6 });
        E.step(1 / 60, { render: false, describe: false });
        const out = { id: E.interactions.pick()?.id ?? null }; E.dispose(); return out;
      });
      check('picked', r.id === 'above', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 5a: a bubble script whose text() throws ends that script (onEnd runs), the main dialogue stays open',
    url: PAGE,
    expectErrors: /dialogue text/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-5a'); E.use(A.dialogue()); await E.start(); E.haltLoop();
        E.dialogue.define('m', { start: { text: 'main line' } });
        E.dialogue.define('b', { start: { text: () => { throw new Error('boom'); } } });
        let ended = 0;
        E.dialogue.start('m'); E.step(1, { render: false });
        E.dialogue.start('b', 'start', () => ended++, { channel: 'bubble' }); E.step(1, { render: false });
        const out = { ended, main: !!E.dialogue.active }; E.dispose(); return out;
      });
      check('the bubble script settled and the main dialogue is still open', r.ended === 1 && r.main, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 5b: a choice whose label or condition throws ends the dialogue instead of leaving it half open',
    url: PAGE,
    expectErrors: /dialogue choice/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all, out = {};
        for (const [k, c] of [['label', { text: () => { throw new Error('boom'); } }], ['cond', { text: 'ok', if: () => { throw new Error('boom'); } }]]) {
          const E = mk(A.createEngine, 'l3g-5b' + k); E.use(A.dialogue()); await E.start(); E.haltLoop();
          E.dialogue.define('s', { start: { text: 'pick', choices: [c] } });
          try { E.dialogue.start('s'); E.step(1, { render: false }); } catch (x) { out[k + 'Threw'] = x.message; }
          out[k] = !!E.dialogue.active; E.dispose();
        }
        return out;
      });
      check('no throw and the dialogue is closed for both', !r.labelThrew && !r.condThrew && r.label === false && r.cond === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 1b: a zone removed by its onEnter emits no trigger:enter after its exit (also occupancy each)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all, out = {};
        const E = mk(A.createEngine, 'l3g-1b'); E.use(A.triggers()); await E.start(); E.haltLoop();
        for (const occ of ['zone', 'each']) {
          const log = [];
          const off = [E.events.on('trigger:enter', x => log.push('enter:' + x.tag)), E.events.on('trigger:exit', x => log.push('exit:' + x.tag))];
          E.triggers.add({ tag: occ, shape: 'sphere', radius: 2, occupancy: occ, position: { x: 0, y: 0, z: 0 }, who: () => [{ x: 0, y: 0, z: 0 }], onEnter: t => t.remove() });
          E.step(0.1, { render: false });
          out[occ] = log.join();
          for (const h of off) h.remove();
        }
        E.dispose(); return out;
      });
      check('one zone: exit only', r.zone === 'exit:zone', JSON.stringify(r));
      check('each zone: exit only', r.each === 'exit:each', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 4b: an npcs.add whose world write throws leaves no name and no runtime entry',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-4b'); E.use(A.world(), A.characters()); await E.start(); E.haltLoop();
        const out = {};
        const W = E.world, add = W.add; W.add = () => { throw new Error('world refused'); };   // what checkPlain does to a mind holding a function
        try { E.npcs.add({ name: 'Cy' }); } catch (x) { out.threw = x.message; }
        W.add = add;
        out.runtime = E.npcs._runtime.has('Cy');
        try { E.npcs.add({ name: 'Cy' }); out.retry = 'ok'; } catch (x) { out.retry = x.code ?? x.message; }
        E.dispose(); return out;
      });
      check('threw, nothing left behind, the retry works', r.threw === 'world refused' && r.runtime === false && r.retry === 'ok', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 5c: a choice number pressed while the line still types, with a condition that throws, ends the dialogue',
    url: PAGE,
    expectErrors: /dialogue choice/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all, out = {};
        const E = mk(A.createEngine, 'l3g-5c'); E.use(A.dialogue()); await E.start(); E.haltLoop();
        let bad = false;   // the condition holds while the line is opened, then throws
        E.dialogue.define('s', { start: { text: 'a long line that is still typing out', choices: [{ text: 'x', if: () => { if (bad) throw new Error('boom'); return true; } }] } });
        E.dialogue.start('s'); E.step(1 / 60, { render: false });
        bad = true;
        try { out.avail = E.ops.can('dialogue.choose', { index: 0 }, { source: 'player' }).ok ?? null; } catch (x) { out.threw = x.message; }
        out.active = !!E.dialogue.active;
        E.dispose(); return out;
      });
      check('no throw and the dialogue is closed', !r.threw && r.active === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3G 5d: describe() reads the labels already shown and does not run a choice label again',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, A = threedogThreads.all;
        const E = mk(A.createEngine, 'l3g-5d'); E.use(A.dialogue()); await E.start(); E.haltLoop();
        let calls = 0;
        E.dialogue.define('s', { start: { text: 'pick', choices: [{ text: () => { calls++; return 'yes'; } }] } });
        E.dialogue.start('s'); E.step(1, { render: false });
        const before = calls, d = E.describe();
        const out = { before, after: calls, choices: d.ui?.dialogue?.choices }; E.dispose(); return out;
      });
      check('the label ran once (to show it), describe adds no call and still lists it', r.before === 1 && r.after === 1 && r.choices?.join() === 'yes', JSON.stringify(r));
    },
  },
];
