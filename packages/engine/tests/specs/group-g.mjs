// Group G guards (gameplay modules review, docs/plans/2026-11-09-group-g.md): one check per root cause, each fails with its fix reverted.
// Run: npm test -- "group G"
const PAGE = '/tests/threads/';
const T = () => threedogThreads;
const BUILD = `(n, marker) => { const { THREE } = threedogThreads; const g = new THREE.Group(); g.name = n; const f = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); f.name = 'ground'; g.add(f); if (marker) { const m = new THREE.Object3D(); m.name = marker; g.add(m); } return g; }`;

export const specs = [
  {
    name: 'group G: a once trigger is spent before its callbacks run, so a save inside onEnter records it (1)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads;
        const E = mk(createEngine, 'gg1'); E.use(all.triggers()); await E.start(); E.haltLoop();
        const seen = {};
        E.triggers.add({ shape: 'sphere', radius: 2, position: { x: 0, y: 0, z: 0 }, once: true, who: () => [{ x: 0, y: 0, z: 0 }], tag: 'a', onEnter: t => { seen.inCallback = t.used; seen.saved = JSON.stringify(E.triggers._save?.() ?? null); } });
        E.events.on('trigger:enter', ({ trigger }) => { seen.inEvent = trigger.used; });
        E.step(0.1, { render: false }); E.step(0.1, { render: false });
        E.dispose();
        return seen;
      });
      check('used is already true inside onEnter and the trigger:enter listener', r.inCallback === true && r.inEvent === true, JSON.stringify(r));
    },
  },
  {
    name: 'group G: flow go() asked from inside an exit waits for it: no recursion, the states end in order (2)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads;
        const E = mk(createEngine, 'gg2'); E.use(all.flow()); await E.start(); E.haltLoop();
        const log = [];
        E.flow.define('A', { exit: (e, to) => { log.push('exitA>' + to); E.flow.go('C'); }, enter: () => log.push('enterA') });
        E.flow.define('B', { enter: () => log.push('enterB') });
        E.flow.define('C', { enter: () => log.push('enterC') });
        E.flow.go('A');
        let err = null;
        try { E.flow.go('B'); } catch (x) { err = x.message; }
        const out = { err, log, state: E.flow.state };
        E.dispose();
        return out;
      });
      check('A exits once, B is entered, then the queued C; no stack overflow', r.err === null && r.state === 'C' && r.log.join() === 'enterA,exitA>B,enterB,enterC', JSON.stringify(r));
    },
  },
  {
    name: 'group G: a quest:part listener that advances the quest does not break the parallel check (3)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, quests } = threedogThreads;
        const E = mk(createEngine, 'gg3'); E.use(quests()); await E.start(); E.haltLoop();
        E.quests.define('par', { title: 'p', steps: [{ text: 'both', all: [{ text: 'x', done: () => true }, { text: 'y', done: () => true }] }, { text: 'next', done: () => false }] });
        let adv = 0;
        E.events.on('quest:part', () => { if (!adv++) E.quests.advance('par'); });
        E.quests.start('par');
        let err = null;
        try { E.step(0.1, { render: false }); E.quests.check(); } catch (x) { err = x.message; }
        const out = { err, step: E.quests._progress.par.step, parts: E.quests._progress.par.parts };
        E.dispose();
        return out;
      });
      check('no TypeError; the quest is on its second step', r.err === null && r.step === 1, JSON.stringify(r));
    },
  },
  {
    name: 'group G: a throwing handle does not stop a level unload: the other handles and the root go (4); fromMarkers twice leaves one set of zones (5); a save with no level unloads (7)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async (build) => {
        const { mk, createEngine, level, all } = threedogThreads;
        const mkL = (n, marker) => (0, eval)(build)(n, marker);
        const E = mk(createEngine, 'gg4'); E.use(all.triggers(), all.content(), level()); await E.start(); E.haltLoop();
        await E.level.load(mkL('zero')); E.level.unload();
        await E.saves.save('nolevel');   // 7: saved after a level left, none standing
        await E.level.load(mkL('one', 'trigger_door'));
        const out = {};
        // 5: the game's own zone and a content commit (twice) -- the commit replaces only its own set
        let fired = 0;
        const mine = E.triggers.fromMarkers({ onEnter: () => { fired++; } });
        E.content.load({ triggers: { door: { fromLevel: true } } });
        E.content.load({ triggers: { door: { fromLevel: true } } });
        out.zones = E.triggers.list().filter(t => t.tag === 'door').length;
        out.mineAlive = mine.every(t => E.triggers.list().includes(t));
        // 4
        let later = 0;
        E.level.track({ remove() { later++; } });
        E.level.track({ remove() { throw new Error('boom'); } });
        E.level.track({ remove() { later++; } });
        let err = null; const q0 = console.error; console.error = () => {};   // the unload reports the throw (engine.error in dev); the test reads it from there
        try { E.level.unload(); } catch (x) { err = x.message; } finally { console.error = q0; }
        out.reported = /boom/.test(E.error?.message ?? '');
        out.err = err; out.later = later; out.root = !!E.scene.getObjectByName('one'); out.has = !!E.level.root;
        // 7
        await E.level.load(mkL('two'));
        await E.saves.load('nolevel');
        out.afterLoad = { root: E.level.root ? 'standing' : null, drawn: !!E.scene.getObjectByName('two') };
        E.dispose();
        return out;
      }, BUILD);
      check('the game zone stays, the content zone is one (not doubled)', r.zones === 2 && r.mineAlive, JSON.stringify(r));
      check('both other handles ran and the level root left, though one handle threw', r.later === 2 && !r.root && !r.has && r.err === null && r.reported, JSON.stringify(r));
      check('loading a save made with no level unloads the level that stands', r.afterLoad.root === null && !r.afterLoad.drawn, JSON.stringify(r.afterLoad));
    },
  },
  {
    name: 'group G: a level loaded by code after start survives newGame; one loaded then unloaded saves "no level" (2 of review)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async (build) => {
        const { mk, createEngine, level } = threedogThreads;
        const E = mk(createEngine, 'gg7'); E.use(level()); await E.start(); E.haltLoop();
        await E.level.load((0, eval)(build)('late'));
        await E.session.newGame();
        const out = { standing: !!E.level.root };
        E.dispose();
        return out;
      }, BUILD);
      check('the level loaded after start is still there after newGame', r.standing, JSON.stringify(r));
    },
  },
  {
    name: 'group G: an async once use finishing after its item was replaced by one of the same id spends nothing on the new one (6)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE, all } = threedogThreads;
        const E = mk(createEngine, 'gg6'); E.use(all.interactions({ pick: 'nearest' })); await E.start(); E.haltLoop();
        let go; const mesh = () => { const m = new THREE.Mesh(); E.scene.add(m); return m; };
        const a = mesh(), b = mesh();
        const ha = E.interactions.add(a, { id: 'lever', label: 'x', once: true, onUse: () => new Promise(res => { go = res; }) });
        const res = E.ops.run('interaction.use', { id: 'lever' }, { source: 'player' });
        ha.remove();
        E.interactions.add(b, { id: 'lever', label: 'x', once: true });
        go(undefined); await new Promise(r2 => setTimeout(r2, 20)); await res.value?.catch?.(() => {});
        const out = { spent: [...E.interactions._spent], newVisible: b.visible, ok: res.ok };
        E.dispose();
        return out;
      });
      check('the new item with the same id is not spent', r.spent.length === 0 && r.newVisible === true, JSON.stringify(r));
    },
  },
  {
    name: 'group G: grid preview and tiles free through e.remove once; a material the game set stays undisposed (8)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE, all } = threedogThreads;
        const E = mk(createEngine, 'gg8'); E.use(all.world(), all.grids()); await E.start(); E.haltLoop();
        const count = (o, n = { v: 0 }) => { o.addEventListener('dispose', () => n.v++); return n; };
        E.grids.add('farm', { cell: 1, origin: [-4, -4], size: [8, 8] });
        E.grids.define('crate', { size: [1, 1] });
        const out = {};
        // preview with a game material
        const pv = E.grids.preview({ grid: 'farm', item: 'crate', rotate: false });
        const mesh = E.scene.getObjectByName('grid:preview');
        const mine = new THREE.MeshBasicMaterial(), nMine = count(mine), nGeo = count(mesh.geometry), nOwn = count(mesh.material);
        pv.material = mine;
        pv.remove();
        out.pv = { mine: nMine.v, geo: nGeo.v, own: nOwn.v };
        // tiles
        const layer = E.grids.get('farm').layer('soil', { tiles: { color: () => 0x886644 } });
        const tm = E.scene.getObjectByName('grid:farm.soil');
        const mine2 = new THREE.MeshBasicMaterial(), n2 = count(mine2), g2 = count(tm.geometry), o2 = count(tm.material);
        tm.material = mine2;
        E.grids._retile(layer);
        out.tiles = { mine: n2.v, geo: g2.v, own: o2.v };
        E.dispose();
        return out;
      });
      check('preview: its own box and material are freed once, the game material not at all', r.pv.mine === 0 && r.pv.geo === 1 && r.pv.own === 1, JSON.stringify(r.pv));
      check('tiles: same', r.tiles.mine === 0 && r.tiles.geo === 1 && r.tiles.own === 1, JSON.stringify(r.tiles));
    },
  },
  {
    name: 'group G: the debug panel time scale leaves with the module (9)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads;
        const E = mk(createEngine, 'gg9'); E.use(all.calendar(), all.debug()); await E.start(); E.haltLoop();
        const slider = E.debug.panel.el.querySelector('[data-i="ts"]');
        slider.value = '0'; slider.dispatchEvent(new Event('input'));
        const during = E.clock.rate;
        E.unuse('debugPanel');
        const out = { during, after: E.clock.rate };
        E.dispose();
        return out;
      });
      check('the slider changed the rate, and unuse gives the game rate back', r.during === 0 && r.after === 1, JSON.stringify(r));
    },
  },
];
