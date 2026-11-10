// Group P (docs/plans/2026-11-10-group-p.md): cross-group problems found when the ten fix groups were reviewed together. One check per root cause.
//   copyOwns is the only copy-ownership test; frame hooks get the game time the fixed steps took; a hot rebuild of any copy is one path; debug views leave by identity.
// Run: npm test -- group-p
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'Group P: engine.dispose frees the instance buffers of a model copy (copyOwns, the same test dropCopy uses)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE } = threedogThreads;
        const E = mk(createEngine, 'gp-dispose');
        await E.start();
        let freed = 0;
        const make = () => { const g = new THREE.Group(), im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2); g.add(im); return g; };
        E.assets.manifest({ name: 'gpd', models: { gpdInst: { build: make } } });
        const copy = await E.assets.model('gpdInst');
        copy.traverse(o => { if (o.isInstancedMesh) { const d = o.dispose; o.dispose = function () { freed++; return d.call(this); }; } });
        E.add(copy);
        E.dispose();
        return { freed };
      });
      check('dispose gives back the InstancedMesh a model() copy cloned', r.freed === 1, JSON.stringify(r));
    },
  },
  {
    name: 'Group P: frame hooks get the time the fixed steps took, minus what the budget dropped',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'gp-dt');
        await E.start();
        const STEP = 1 / 60;
        E._acc = 0; const nFree = E._catchUp(0.05), free = E._gameDt, accFree = E._acc;
        E._acc = 0;
        const hook = E.onFixed(() => { const t = performance.now(); while (performance.now() - t < 40); });   // one step costs more than the whole budget
        const nSlow = E._catchUp(0.1), slow = E._gameDt, accSlow = E._acc;
        hook.remove();
        return { nFree, free, accFree, nSlow, slow, accSlow, STEP };
      });
      check('no drop: frame time is the real dt', Math.abs(r.free - 0.05) < 1e-9, JSON.stringify(r));
      check('budget drop: frame time is the fixed steps that ran plus the time kept, not the dt', r.nSlow < 6 && Math.abs(r.slow - (r.nSlow * r.STEP + r.accSlow)) < 1e-9 && r.slow < 0.1 - 1e-6, JSON.stringify(r));
    },
  },
  {
    name: 'Group P: a hot rebuild of a copy runs the first-build steps (setup, static rays, new parts) and stops the old Animator',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = __threedogThree, A = engine.assets, W = engine.world, tick = () => new Promise(res => setTimeout(res, 0));
        engine.haltLoop();
        const group = n => () => { const g = new T.Group(); for (let i = 0; i < n; i++) { const m = new T.Mesh(new T.BoxGeometry(0.5, 0.5, 0.5), new T.MeshStandardMaterial()); m.position.y = i; g.add(m); } return g; };
        A.manifest({ name: 'gp', models: { gpGroup: group(2), gpFree: group(2) } });
        const setups = {};
        A.onModel((m, name) => { setups[name] = (setups[name] ?? 0) + 1; });
        const p = engine.player.position, x = p.x + 8, z = p.z + 8;
        engine.content.load({ props: [{ id: 'gp-a', model: 'gpGroup', x, z, collide: false }] });
        for (let i = 0; i < 60 && !W.view('gp-a'); i++) { engine.step(0.05); await tick(); }
        const free = await A.model('gpFree'); engine.add(free);
        A.animate(free);
        const view = W.view('gp-a'), disposed = [];
        const before = { setups: setups.gpGroup, free: setups.gpFree, view: view.children.length };
        view.traverse(o => { if (o.isMesh) { const d = o.geometry.dispose; o.geometry.dispose = function () { disposed.push(1); return d.call(this); }; } });
        const rays = engine.rays, meshes = o => { const a = []; o.traverse(m => { if (m.isMesh) a.push(m); }); return a; };
        await engine.debug.reloadAssets({ name: 'gp', models: { gpGroup: group(3), gpFree: group(3) } });
        const v2 = W.view('gp-a');
        return {
          same: v2 === view, parts: meshes(v2).length, setups: setups.gpGroup, before,
          registered: meshes(v2).every(m => rays.statics.has(m)),
          sharedGeoKept: disposed.length === 0,
          freeSetups: setups.gpFree, freeParts: meshes(free).length, animGone: A.animatorOf(free) === null,
        };
      });
      check('the content copy is rebuilt in place with the new parts', r.same && r.parts === 3, JSON.stringify(r));
      check('the onModel setup ran again on the rebuilt content copy', r.setups === r.before.setups + 1, JSON.stringify(r));
      check('the rebuilt content copy has static rays on every new part', r.registered, JSON.stringify(r));
      check('a model() copy is rebuilt too and its Animator (old skeleton) is stopped', r.freeParts === 3 && r.animGone && r.freeSetups === r.before.free + 1, JSON.stringify(r));
    },
  },
  {
    name: 'Group P: a stale debug view handle does not remove the newer view of the same name',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const dbg = engine.debug, def = () => ({ what: 'x', apply: () => () => {} });
        const h1 = dbg.defineView('gpv', def());
        h1.remove();
        const h2 = dbg.defineView('gpv', def());
        h1.remove();   // stale
        const kept = dbg.viewModes?.().includes('gpv') ?? null;
        h2.remove();
        return { kept, gone: !(dbg.viewModes?.().includes('gpv')) };
      });
      check('the stale handle left the newer view alone; its own handle removes it', r.kept === true && r.gone, JSON.stringify(r));
    },
  },
];
