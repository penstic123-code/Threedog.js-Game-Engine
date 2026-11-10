// Group L3C (docs/plans/research/2026-11-10-gpt-review-l3-core.md items 1-8): one test item each so one throw stops no other.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group L3C 1: a timed mod replaced with an unknown clock throws and keeps the old entry',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-1'); E.start(); E.haltLoop();
        E.stacks.define('l3c.speed', { base: 1 });
        E.mod('l3c.speed', { owner: 'x', mul: 3 });
        let threw = false;
        try { E.mod('l3c.speed', { owner: 'x', mul: 2, for: 1, clock: 'typo' }); } catch { threw = true; }
        const out = { threw, value: E.stacks.get('l3c.speed').value() };
        E.dispose();
        return out;
      });
      check('the failed replacement throws and the first modifier still applies', r.threw && r.value === 3, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 2: a feeder handle removed twice does not remove the next module\'s feeder',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-2'); await E.start(); E.haltLoop();
        let fedB = 0;
        E.use({ name: 'l3cA', type: 'rules', install(e, ctx) { ctx.feeds('l3cHolder', () => {}).remove(); } });
        E.use({ name: 'l3cB', type: 'rules', install(e, ctx) { ctx.feeds('l3cHolder', () => { fedB++; }); } });
        E.unuse('l3cA');   // its tracked handle is removed again here
        E.use({ name: 'l3cHolder', type: 'rules', install() {} });
        const out = { fedB };
        E.dispose();
        return out;
      });
      check('B is still fed when the holder arrives', r.fedB === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 3: unuse in the same turn as use keeps the late init from running',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-3'); await E.start(); E.haltLoop();
        let ran = 0;
        E.use({ name: 'l3cInit', type: 'rules', install() {}, init() { ran++; } });
        E.unuse('l3cInit');
        await E.loading.settled(); await new Promise(r => setTimeout(r, 0));
        const out = { ran };
        E.dispose();
        return out;
      });
      check('init never runs after the module was disposed', r.ran === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 4: disposing before the store opened closes the connection that opens later',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-4');
        const store = E.saves.store, ready = E.saves.whenReady;
        E.dispose();
        await ready.catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        return { closed: store.db == null };
      });
      check('no database connection stays open after dispose', r.closed, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 5: a batched object whose scale turns negative leaves the batch',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine, THREE } = threedogThreads;
        const E = mk(createEngine, 'l3c-5', { batching: { minCount: 1 } });
        E.start(); E.haltLoop();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        mesh.userData.batch = true; E.scene.add(mesh);
        const run = n => { for (let i = 0; i < n; i++) E.step(1 / 30, { render: false }); };
        run(4);
        const B = E.batching, was = B.live.size;
        mesh.scale.x = -1;
        run(4);
        const out = { was, now: B.live.size, tracked: B.roots.has(mesh) };
        E.dispose();
        return out;
      });
      check('it was batched, then left the batch when mirrored', r.was === 1 && r.now === 0 && !r.tracked, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 5b: a mirrored root drops out alone; its geometry is not banned and other copies, also a new one, still batch',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine, THREE } = threedogThreads;
        const E = mk(createEngine, 'l3c-5b', { batching: { minCount: 1 } });
        E.start(); E.haltLoop();
        const geo = new THREE.BoxGeometry(), mat = new THREE.MeshStandardMaterial();
        const add = x => { const m = new THREE.Mesh(geo, mat); m.position.x = x; m.userData.batch = true; E.scene.add(m); return m; };
        const run = n => { for (let i = 0; i < n; i++) E.step(1 / 30, { render: false }); };
        const a = add(1), b = add(2); run(4);
        a.scale.x = -1; run(4);
        const c = add(3); run(4);
        const B = E.batching, out = { aTracked: B.roots.has(a), banned: B.banned.has(geo), live: B.live.size, bLive: B.of(b).length > 0, cLive: B.of(c).length > 0 };
        E.dispose();
        return out;
      });
      check('only the mirrored root left; the old and the new copy are batched', !r.aTracked && !r.banned && r.live === 2 && r.bLive && r.cLive, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 5c: a root that turns mirrored and crosses a cell in the same update is not uploaded',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine, THREE } = threedogThreads;
        const E = mk(createEngine, 'l3c-5c', { batching: { minCount: 1 } });
        E.start(); E.haltLoop();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        mesh.userData.batch = true; mesh.position.x = 1; E.scene.add(mesh);
        const run = n => { for (let i = 0; i < n; i++) E.step(1 / 30, { render: false }); };
        run(4);
        const B = E.batching, was = B.live.size;
        mesh.scale.x = -1; mesh.position.x += B.cell * 3;   // mirrored and in another cell, one update
        run(4);
        const out = { was, now: B.live.size, groups: B.groups.size };
        E.dispose();
        return out;
      });
      check('it was batched; mirrored in a new cell it is in no batch', r.was === 1 && r.now === 0 && r.groups === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 6: a hidden root whose material turned transparent is not batched when shown',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine, THREE } = threedogThreads;
        const E = mk(createEngine, 'l3c-6', { batching: { minCount: 1 } });
        E.start(); E.haltLoop();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        mesh.userData.batch = true; mesh.visible = false; E.scene.add(mesh);
        const run = n => { for (let i = 0; i < n; i++) E.step(1 / 30, { render: false }); };
        run(4);
        const B = E.batching, tracked = B.roots.has(mesh);
        mesh.material = new THREE.MeshStandardMaterial({ transparent: true });
        mesh.visible = true;
        run(6);
        const out = { tracked, live: B.live.size, groups: B.groups.size };
        E.dispose();
        return out;
      });
      check('the transparent mesh joins no batch', r.tracked && r.live === 0 && r.groups === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 7: a late save part whose save() cannot be stored throws and leaves its key free',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-7'); await E.start(); E.haltLoop();
        const cyc = {}; cyc.self = cyc;
        let threw = false;
        try { E.saves.define('l3cLate', { save: () => cyc, load() {} }); } catch { threw = true; }
        const held = E.saves.providers.has('l3cLate');
        let retry = true;
        try { E.saves.define('l3cLate', { save: () => ({ ok: 1 }), load() {} }); } catch { retry = false; }
        const out = { threw, held, retry };
        E.dispose();
        return out;
      });
      check('it throws, the key is not taken, and a good part can use the key', r.threw && !r.held && r.retry, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group L3C 8: a number point with a NaN base is refused at define',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'l3c-8'); E.start(); E.haltLoop();
        let threw = false;
        try { E.stacks.define('l3c.nan', { base: NaN }); } catch { threw = true; }
        E.stacks.define('l3c.ok', { base: 2 });
        const out = { threw, ok: E.stacks.get('l3c.ok').value() === 2 };
        E.dispose();
        return out;
      });
      check('NaN base throws; a finite base works', r.threw && r.ok, JSON.stringify(r));
    },
  },
];
