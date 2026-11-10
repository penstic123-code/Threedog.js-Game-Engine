// [guard] One state-application path (docs/plans/2026-11-09-state-path.md): every door that applies saved state goes through the one queue (core/saves/stateReplace.js)
// and the one part loop (runParts, core/saves/saveApply.js). One row per finding of the layer-2 review; each failed on the code before it.
// Run: threedog test "state path"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  const { THREE, mk, createEngine, all: T } = threedogThreads;
  const tick = () => new Promise(res => setTimeout(res, 0));
  const within = (p, ms = 1500) => Promise.race([p.then(v => ({ ended: 'resolved', v }), err => ({ ended: 'rejected', err: String(err?.message ?? err) })), new Promise(res => setTimeout(() => res({ ended: 'pending' }), ms))]);
  const rig = async (key, extra = []) => {
    const was = [console.error, console.warn], said = [];
    console.error = console.warn = (...a) => said.push(a.join(' '));
    const E = mk(createEngine, key);
    E.use(T.world(), ...extra);
    await E.start();
    const base = E.saves.collect();
    const save = (parts = {}) => ({ ...base, parts: { ...base.parts, ...parts }, versions: { ...base.versions, ...Object.fromEntries(Object.keys(parts).map(k => [k, 1])) } });
    return { E, said, save, end() { E.dispose(); [console.error, console.warn] = was; } };
  };
  window.sp = { THREE, tick, within, rig };
};

export const specs = [
  {
    name: 'state path: one queue, one part loop, one hook gate, one cleanup rule',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { THREE, tick, within, rig } = sp, out = {};

        // #1 a load asked in a state:replaced listener waits in line: it used to start at once, and the job in line started beside it
        {
          const R = await rig('sp-1'), S = R.E.saves, log = [];
          S.define('spA', { save: () => ({}), load: async d => { log.push(d.n + ' in'); await tick(); await tick(); log.push(d.n + ' out'); } });
          let c = null;
          const off = R.E.events.on('state:replaced', () => { if (!c) c = S.apply(R.save({ spA: { n: 'c' } })); });
          const a = S.apply(R.save({ spA: { n: 'a' } })), b = S.apply(R.save({ spA: { n: 'b' } }));
          await within(a); await within(b); for (let i = 0; i < 20 && !c; i++) await tick();
          if (c) await within(c);
          off.remove?.(); off.off?.();
          out.q = log;
          R.end();
        }

        // #2 an atomic op's rollback: a part that throws does not stop the rest, unchanged models stay (an async part is refused there: group B6a)
        {
          const R = await rig('sp-2'), E = R.E, S = E.saves;
          let good = 1, disposed = 0;
          S.define('spBad', { atomic: true, save: () => ({ v: 1 }), load: () => { throw new Error('spBad will not go back'); } });
          S.define('spGood', { atomic: true, save: () => ({ v: good }), load: d => { good = d.v; } });
          E.world.present('spBox', { build: () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), dispose: (rec, obj) => { disposed++; E.remove(obj); } });
          const rec = E.ops.allow(() => E.world.add({ kind: 'spBox', position: { x: 1, y: 0, z: 1 } }));
          E.step(0.2);
          const before = E.world.view(rec.id);
          E.ops.define('sp.fail', { atomic: true, run: () => { good = 2; return { ok: false, code: 'no' }; } });
          E.ops.run('sp.fail');
          out.atomic = { good };
          out.atomic.same = E.world.view(rec.id) === before && !!before; out.atomic.disposed = disposed;
          R.end();
        }

        // #4 a late part loads under the marker, as a load does, and its module's afterLoad rebuilds after it
        {
          let hooks = 0;
          const R = await rig('sp-4', [{ name: 'spHook', type: 'rules', skipKind: 'none', afterLoad: () => { hooks++; } }]), S = R.E.saves;
          await within(S.apply(R.save({ spLate: { v: 1 } })));
          hooks = 0;
          const seen = {};
          S.define('spLate', { save: () => ({}), load: async () => { seen.marker = S._replace.replacing; await tick(); seen.after = S._replace.replacing; } });
          await within(S.settled?.() ?? Promise.resolve()); for (let i = 0; i < 5; i++) await tick();
          out.late = { ...seen, hooks };
          R.end();
        }

        // #5 two scene requests run one after the other, and no write permit spans a request's awaits
        {
          const log = [], depth = [];
          const R = await rig('sp-5', [{ name: 'spScene', type: 'rules', skipKind: 'none', stateKeys: ['spk'], applyState: async (e, { spk }) => {
            if (spk == null) return; log.push(spk + ' in'); await tick(); depth.push(e.ops._allowDepth); await tick(); log.push(spk + ' out');
          } }]);
          const a = R.E.applyState({ spk: 'a' }), b = R.E.applyState({ spk: 'b' });
          await within(a, 4000); await within(b, 4000);
          out.scene = { order: log, firstB: log.indexOf('b in'), lastA: log.lastIndexOf('a out'), depth };
          R.end();
        }

        // #10 afterLoad skips a module still initializing; and it never waits for one: an init that defines a save part (a late job) and then awaits a load finishes
        {
          let done = false;
          const R0 = await rig('sp-10b'), E0 = R0.E;
          await within(E0.saves.apply(R0.save({ spLM: { v: 1 } })));
          E0.use({ name: 'spLM', type: 'rules', skipKind: 'none', async init(e, ctx) { ctx.saves.define('spLM', { save: () => ({}), load() {} }); await e.saves.apply(R0.save({})); done = true; }, afterLoad() {} });
          for (let i = 0; i < 40 && !done; i++) await new Promise(res => setTimeout(res, 25));
          out.lateInit = done;
          R0.end();
        }
        {
          let ready = false, open;
          const gate = new Promise(res => { open = res; }), seen = [];
          const R = await rig('sp-10'), E = R.E;
          E.use({ name: 'spInit', type: 'rules', skipKind: 'none', async init() { await gate; ready = true; }, afterLoad: () => { seen.push(ready); } });
          const a = E.saves.apply(R.save({}));
          for (let i = 0; i < 3; i++) await tick();
          open();
          await within(a);
          out.gate = seen;
          R.end();
        }

        // review: an atomic op failing inside a scene request, and a second scene request: the marker ends, applied waits for the last
        {
          let slow = 1;
          const R = await rig('sp-r2', [{ name: 'spRb', type: 'rules', skipKind: 'none', stateKeys: ['spr'], applyState: async (e, { spr }) => {
            if (spr !== 'op') return; await tick(); e.ops.run('sp.failSlow'); await tick();
          } }]), E = R.E;
          E.saves.define('spSlow2', { atomic: true, save: () => ({ v: slow }), load: d => { slow = d.v; } });
          E.ops.define('sp.failSlow', { atomic: true, run: () => { slow = 2; return { ok: false, code: 'no' }; } });
          const a = E.applyState({ spr: 'op' }), b = E.applyState({ spr: 'b' });
          await within(a, 4000);
          out.overlap = { appliedBetween: E._urlState.applied };
          await within(b, 4000); for (let i = 0; i < 10; i++) await tick();
          Object.assign(out.overlap, { slow, replacing: E.saves.replacing, frozen: !!E.saves._replace.freeze, applied: E._urlState.applied });
          R.end();
        }

        // #11 a session.track handle whose remove() throws does not stop the switch to the new playthrough
        {
          const R = await rig('sp-11'), E = R.E;
          let removed = 0, started = 0;
          E.session.track({ remove() { throw new Error('sp: remove threw'); } });
          E.session.track({ remove() { removed++; } });
          E.events.on('session:start', () => { started++; });
          const id = E.session.id;
          const res = await within(E.session.newGame(), 4000);
          out.session = { res: res.ended === 'resolved' ? res.v : res.ended + ' ' + (res.err ?? ''), removed, started, moved: E.session.id === id + 1 };
          R.end();
        }
        return out;
      });
      const pairs = l => l.every((x, i) => i % 2 ? x === l[i - 1].replace(' in', ' out') : x.endsWith(' in'));
      check('#1 the listener\'s load waits for the job in line: no two loads run side by side', r.q.length === 6 && pairs(r.q) && r.q.join().startsWith('a in,a out,b in,b out'), J(r.q));
      check('#2 a part that throws on rollback does not stop the others going back', r.atomic.good === 1, J(r.atomic));
      check('#2 a model whose record did not change stays through the rollback', r.atomic.same && r.atomic.disposed === 0, J(r.atomic));
      check('#4 a late part loads under the marker, before and after its await', r.late.marker === true && r.late.after === true, J(r.late));
      check('#4 afterLoad rebuilds after a late part, as after a load', r.late.hooks === 1, J(r.late));
      check('#5 the second scene request starts after the first ended', r.scene.firstB > r.scene.lastA && r.scene.lastA >= 0, J(r.scene));
      check('#5 no write permit spans a scene request\'s await', r.scene.depth.length > 0 && r.scene.depth.every(d => d === 0), J(r.scene));
      check('#10 afterLoad skips a module still initializing', r.gate.length === 0, J(r.gate));
      check('#10 an init that defines a save part and then awaits a load does not wait for itself', r.lateInit === true, J(r.lateInit));
      check('an atomic rollback inside applyState ends: no stuck marker or freeze', r.overlap.slow === 1 && r.overlap.replacing === false && r.overlap.frozen === false, J(r.overlap));
      check('applied stays false while a later scene request is still in line, true after the last', r.overlap.appliedBetween === false && r.overlap.applied === true, J(r.overlap));
      check('#11 one remove() throwing: the new game still starts, the rest are removed', r.session.res === true && r.session.removed === 1 && r.session.started === 1 && r.session.moved, J(r.session));
    },
  },
];
