// Group S (docs/plans/research/2026-11-10-gpt-review-seams.md 2.1, 6.1, 4.1, 5.1): seam fixes, one test item each so one throw stops no other.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group S 2.1: a window over a dialogue takes confirm; the dialogue line does not advance',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'seam-dlg');
        E.use(T.dialogue());
        E.start(); E.haltLoop();
        E.dialogue.define('s', { start: { text: 'one', next: 'b' }, b: { text: 'two' } });
        const lines = []; E.events.on('dialogue:line', x => lines.push(x.node));
        E.dialogue.start('s'); E.step(1, { render: false });   // typed out, so a confirm advances to the next line
        const win = T.uiFocus(E).push('settings-over');         // a window opened over it
        const press = () => { E.input._keyDown('Space', 'keyboard'); E.step(1 / 30, { render: false }); E.input._keyUp('Space'); E.step(1 / 30, { render: false }); };
        press();
        const over = lines.length;
        win.remove(); E.step(1 / 30, { render: false });
        press();
        const out = { over, after: lines.length };
        E.dispose();
        return out;
      });
      check('confirm under a window leaves the line; once the window closes it advances', r.over === 1 && r.after === 2, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 2.1b: a window over a dialogue whose confirm closes it does not let the same press advance the dialogue',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'seam-dlg2');
        E.use(T.dialogue());
        E.start(); E.haltLoop();
        E.dialogue.define('s', { start: { text: 'one', next: 'b' }, b: { text: 'two' } });
        const lines = []; E.events.on('dialogue:line', x => lines.push(x.node));
        E.dialogue.start('s'); E.step(1, { render: false });
        const win = T.uiFocus(E).push('closing-window', { nav: { count: () => 1, confirm: () => win.remove() } });
        E.step(1 / 30, { render: false });   // the window's cursor settles
        E.input._keyDown('Space', 'keyboard'); E.step(1 / 30, { render: false }); E.input._keyUp('Space');
        const out = { closed: T.uiFocus(E).top === 'dialogue', lines: lines.length };
        E.dispose();
        return out;
      });
      check('the press that closed the window is spent: the dialogue stays on its line', r.closed && r.lines === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 6.1: a terrain edit while a path batch is in flight makes the batch recompute on the new ground',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'seam-path');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }));
        await E.start(); E.haltLoop();
        let got = null, sampled = 0;
        E.characters.findPathAsync({ x: 0, z: 0 }, { x: 8, z: 0 }, (path, status) => { got = { n: path?.length ?? 0, status }; });
        E.step(1 / 60, { render: false, describe: false });   // the batch leaves (its ground is sampled here)
        const walk = E.collision.groundWalkable; E.collision.groundWalkable = function (...a) { sampled++; return walk.apply(this, a); };   // only the path raster asks this
        E.events.emit('ground:change', { x0: -20, z0: -20, x1: 20, z1: 20 });   // what terrain.edit announces
        for (let i = 0; i < 12 && !got; i++) E.step(1 / 60, { render: false, describe: false });
        E.collision.groundWalkable = walk;
        const out = { got, sampled };
        E.dispose();
        return out;
      });
      check('the stale batch is not used: the ground is sampled again and the request still answers', r.sampled > 0 && !!r.got, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 4.1: a load fires the exits before the other parts restore: the inventory is the saved one and a transient handle is released',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'seam-load');
        E.use(T.inventory(), T.triggers());   // inventory first: its part is restored before the zones' part
        await E.start(); E.haltLoop();
        let exits = 0, evs = 0, released = false;
        E.events.on('trigger:exit', () => evs++);
        E.triggers.add({ shape: 'sphere', radius: 2, position: { x: 0, y: 0, z: 0 }, who: () => [{ x: 0, y: 0, z: 0 }], tag: 'z', onExit: () => { exits++; released = true; E.ops.allow(() => E.inventory.add('apple', 1)); } });
        E.step(0.1, { render: false });   // occupied
        const inside = E.triggers.byTag('z')[0].inside;
        const saved = E.saves.collect(), before = E.inventory.count('apple');
        await E.saves.apply(saved, 'seam-load');
        const out = { inside, before, after: E.inventory.count('apple'), exits, evs, released };
        E.dispose();
        return out;
      });
      check('load: the occupied zone exits normally (onExit and trigger:exit run) and the save overwrites what onExit gave', r.inside && r.released && r.exits === 1 && r.evs === 1 && r.after === r.before, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 5.1: unloading triggers removes its zones with their exits; the level unloading later runs nothing more',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, level } = threedogThreads, T = threedogThreads.all, { THREE } = threedogThreads;
        const E = mk(T.createEngine, 'seam-unuse');
        E.use(T.triggers(), level());
        await E.start(); E.haltLoop();
        const g = new THREE.Group(); g.name = 'lv'; const f = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); f.name = 'ground'; g.add(f);
        const m = new THREE.Object3D(); m.name = 'trigger_door'; g.add(m);
        await E.level.load(g);
        let exits = 0;
        const zs = E.triggers.fromMarkers({ onExit: () => { exits++; } });
        zs.forEach(z => { z.inside = true; });
        const T0 = E.triggers;
        E.unuse('triggers');
        const gone = zs.every(z => z._gone), atUnload = exits;
        let err = null; try { E.level.unload(); } catch (x) { err = x.message; }
        const out = { n: zs.length, gone, left: T0.list().length, atUnload, exits, err, error: E.error?.message ?? null };
        E.dispose();
        return out;
      });
      check('unuse triggers: every zone gone, each exit ran once at unload, the later level unload adds none and runs clean', r.n >= 1 && r.gone && r.left === 0 && r.atUnload === r.n && r.exits === r.n && !r.err && !r.error, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 4.1b: triggers installed before the level still load after it: a spent once-zone of a level zone stays spent',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, level } = threedogThreads, T = threedogThreads.all, { THREE } = threedogThreads;
        const E = mk(T.createEngine, 'seam-order');
        E.use(T.triggers(), level());   // triggers first on purpose: the save order must not follow install order
        await E.start(); E.haltLoop();
        const mkL = n => { const g = new THREE.Group(); g.name = n; const f = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); f.name = 'ground'; g.add(f); const m = new THREE.Object3D(); m.name = 'trigger_door'; g.add(m); return g; };
        const A = mkL('A'), B = mkL('B');
        E.events.on('level:loaded', () => E.triggers.fromMarkers({ once: true }));   // a game makes its level's zones whenever a level stands
        await E.level.load(A);
        E.triggers.byTag('door')[0].used = true;
        const saved = E.saves.collect();
        await E.level.load(B);
        await E.saves.apply(saved, 'seam-order');
        const out = { root: E.level.root?.name, door: E.triggers.byTag('door').map(t => t.used) };
        E.dispose();
        return out;
      });
      check('after loading A from B the level zone is still spent', r.root === 'A' && r.door.length === 1 && r.door[0] === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group S 4.1c: saves.define refuses a first that is neither a boolean nor a finite number',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = threedogThreads.mk(threedogThreads.all.createEngine, 'seam-first');
        const tryFirst = first => { try { E.saves.define('f' + String(first), { save: () => ({}), load() {}, first }).remove(); return 'ok'; } catch (x) { return x.code ?? x.message; } };
        const out = { nan: tryFirst(NaN), str: tryFirst('1'), zero: tryFirst(0), yes: tryFirst(true) };
        E.dispose();
        return out;
      });
      check('NaN and a string throw at define time; 0 and true are accepted', r.nan === 'module-params' && r.str === 'module-params' && r.zero === 'ok' && r.yes === 'ok', JSON.stringify(r));
    },
  },
];
