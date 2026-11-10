// [review] Combinations left from the 1.0 whole-system review: what else stands on a level that left, runners across a playthrough, riders through a swap and a save,
// collision replaced under a walk, pixelSnap through shots, post and a level reload.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  window.rvFlat = (THREE, w = 60, h = 0) => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, w), new THREE.MeshBasicMaterial()); m.name = 'ground'; m.position.y = h - 0.1; s.add(m); return s; };
  window.rvQuiet = () => { const was = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 180)); return { said, back() { [console.error, console.warn] = was; } }; };
  window.rvWait = async (E, n) => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(s => setTimeout(s, 10)); E.step(1 / 60); } };
};

export const specs = [
  {
    name: '[guard] Level left: hlod lets go of it and grid tiles lie on the ground that is there now',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level, THREE, all: T } = threedogThreads, q = rvQuiet();
        const s = rvFlat(THREE, 60, 3);
        for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()); b.position.set(i * 8 - 20, 4, 0); s.add(b); }
        const E = mk(createEngine, 'rv-left');
        E.use(world(), level({ scene: s }), T.hlod(), T.grids());
        await E.start(); await rvWait(E, 3);
        const g = E.grids.add('rv', { cell: 1, origin: [-2, -2], size: [4, 4] }), soil = g.layer('rvSoil', { tiles: { color: () => 0xffffff } });
        E.ops.define('test.rvWet', { run: () => { soil.set([1, 1], { wet: true }); } }); E.ops.run('test.rvWet');
        await rvWait(E, 2);
        const tileY = () => { const m = E.scene.getObjectByName('grid:rv.rvSoil'); return m?.geometry.attributes.position ? +m.geometry.attributes.position.getY(0).toFixed(1) : null; };
        const out = { cells0: E.modules.get('hlod').describe().cells, tile0: tileY() };
        E.level.unload(); await rvWait(E, 2);
        out.cells1 = E.modules.get('hlod').describe().cells; out.tile1 = tileY(); out.err = E.error?.message ?? null;
        E.dispose(); q.back();
        return out;
      });
      check('hlod had the level', r.cells0 > 0, J(r));
      check('hlod has no cells of a level that left', r.cells1 === 0, J(r));
      check('the tile lay on the level', r.tile0 > 2.9, J(r));
      check('the level gone, the tile lies on the ground there now', r.tile1 < 1, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] Nav obstacles: one added while frozen or during a skip is on every size of mesh before the next fixed step',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, level, nav, THREE } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-obs');
        E.use(world(), collision(), level({ scene: rvFlat(THREE) }), nav({ agentRadius: 0.4 }));
        await E.start();
        for (let i = 0; i < 20 && !E.nav.ready; i++) { await new Promise(s => setTimeout(s, 30)); E.step(1 / 60); }
        const len = radius => E.nav.findPath({ x: -6, z: 0 }, { x: 6, z: 0 }, { radius })?.length ?? 0;
        const out = { open: [len(), len(1.2)] };
        const fz = E.freeze('rv');
        const a = E.collision.addBox([0, 0, 0], { halfWidth: 1, halfDepth: 8 });
        E.step(1 / 60);
        out.frozen = [len(), len(1.2)];
        a.remove(); E.step(1 / 60); out.gone = [len(), len(1.2)];
        fz.remove();
        let inTimer = null;
        E.clock.after(30, () => { E.collision.addBox([0, 0, 0], { halfWidth: 1, halfDepth: 8 }); });
        E.clock.after(40, () => { inTimer = len(); });
        await E.skip({ seconds: 60 });
        out.skip = [inTimer, len(1.2)]; out.err = E.error?.message ?? null;
        E.dispose(); q.back();
        return out;
      });
      const round = a => a.every(n => n > 2), straight = a => a.every(n => n === 2);
      check('open floor: straight, each size', straight(r.open), J(r));
      check('frozen: the new box is gone round, each size', round(r.frozen), J(r));
      check('frozen: a box removed opens the way again', straight(r.gone), J(r));
      check('a box a skip\'s timer added counts for the next timer and after', round(r.skip), J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] Across a playthrough: an async path asked in the old one does not answer in the new one',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-as');
        E.use(world(), collision(), characters(), level({ scene: rvFlat(THREE) }));
        await E.start(); await rvWait(E, 2);
        let got = 0;
        E.characters.findPathAsync({ x: -5, z: 0 }, { x: 5, z: 0 }, () => { got++; });
        await E.session.newGame();
        await rvWait(E, 12);
        const out = { got, err: E.error?.message ?? null };
        E.dispose(); q.back();
        return out;
      });
      check('no answer from the old playthrough', r.got === 0, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] A rider through a save and a character swap: a contract vehicle',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-seat');
        E.use(world(), collision(), characters(), level({ scene: rvFlat(THREE) }));
        await E.start(); await rvWait(E, 2);
        const car = { id: 'rv-boat', object: new THREE.Object3D(), driver: null, passengers: [], seats: 2, speed: 0, seatPosition: () => ({ x: 5, y: 0, z: 5 }), exitPosition: () => ({ x: 7, y: 0, z: 5 }), drive() {}, hideDriver: false };
        const p = E.characters.addPlayer({ control: 'camera' });
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        const out = {};
        p.enter(car); step(3);
        // unseated while a save is being written: the save said seated at its collect
        const saving = E.saves.save('rv1'); p.exit(); step(3); await saving;
        out.exited = { vehicle: !!p.vehicle, driver: !!car.driver, x: +p.root.position.x.toFixed(1) };
        await E.saves.load('rv1'); await rvWait(E, 3);
        out.loaded = { vehicle: !!p.vehicle, x: +p.root.position.x.toFixed(1), rec: E.world.get('player')?.vehicle ?? null };
        // the characters module replaced with a rider seated
        p.vehicle || p.enter(car); step(3);
        try { E.use(characters(), { replaces: 'characters' }); await rvWait(E, 3); } catch (x) { out.swapErr = x.message; }
        out.swap = { driverStale: car.driver === p, player: !!E.player, err: E.error?.message ?? null };
        E.dispose(); q.back();
        return out;
      });
      check('exit let go on both sides', !r.exited.vehicle && !r.exited.driver && r.exited.x === 7, J(r));
      check('the load does not leave a half seat', r.loaded.rec == null ? !r.loaded.vehicle : true, J(r));
      check('characters replaced: the seat of the old rider is free', r.swap.driverStale === false, J(r));
      check('no error', !r.swapErr && !r.swap.err, J(r));
    },
  },
  {
    name: '[guard] Collision replaced mid-walk with nav rebuilding: the walk goes on round the wall, no doubled obstacles',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, nav, THREE } = threedogThreads, q = rvQuiet();
        const s = rvFlat(THREE), c = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 20), new THREE.MeshBasicMaterial()); c.name = 'col_w'; c.position.set(0, 1.5, 0); s.add(c);
        const E = mk(createEngine, 'rv-mid');
        E.use(world(), collision(), characters(), level({ scene: s }), nav({ agentRadius: 0.4 }));
        await E.start();
        for (let i = 0; i < 20 && !E.nav.ready; i++) { await new Promise(s => setTimeout(s, 30)); E.step(1 / 60); }
        const p = E.characters.addPlayer({ control: 'camera' });
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        E.ops.allow(() => p.placeAt({ x: -6, y: 0, z: 0 }));
        const wide = E.nav.findPath({ x: -6, z: 0 }, { x: 6, z: 0 }, { radius: 1.2 })?.length;
        const out = { wide }; let end = null, minAbs = 99;
        p.walkTo({ x: 6, z: 0 }).then(v => { end = v.status; });
        step(40);
        const rev = E.nav.revision;
        E.use(collision(), { replaces: 'collision' });
        for (let i = 0; i < 900 && !end; i++) { step(1); if (Math.abs(p.root.position.z) < 9.5) minAbs = Math.min(minAbs, Math.abs(p.root.position.x)); if (i % 60 === 0) await Promise.resolve(); }
        await new Promise(s => setTimeout(s, 10));
        out.end = end; out.x = +p.root.position.x.toFixed(1); out.minAbs = +minAbs.toFixed(2); out.revMoved = E.nav.revision !== rev;
        out.obstacles = E.modules.get('nav').describe().obstacles; out.boxes = E.modules.get('collision').describe(E).boxes;
        out.wideAfter = E.nav.findPath({ x: -6, z: 0 }, { x: 6, z: 0 }, { radius: 1.2 })?.length;
        out.err = E.error?.message ?? null;
        E.dispose(); q.back();
        return out;
      });
      check('the walk arrives', r.end === 'arrived', J(r));
      check('never through the wall', r.minAbs > 0.4, J(r));
      check('each size still goes round', r.wide > 2 && r.wideAfter > 2, J(r));
      check('one obstacle set', r.obstacles === r.boxes, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] pixelSnap through shots, post and a level reload',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level, THREE, all: T, bloom } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-px');
        const shot = x => ({ position: [x, 10, 10], lookAt: [x, 0, 0], projection: 'orthographic' });
        E.use(world(), level({ scene: rvFlat(THREE) }), T.fixedCamera({ start: 'a', pixelSnap: { pixelsPerMeter: 16 }, shots: { a: shot(0), b: shot(10) } }));
        await E.start(); await rvWait(E, 2);
        const read = () => ({ ortho: !!E.camera.isOrthographicCamera, snap: E.describe().camera?.pixelSnap ?? null, h: E.camera.isOrthographicCamera ? +(E.camera.top - E.camera.bottom).toFixed(3) : null });
        const out = { a: read() };
        const inChain = () => E.post?._camera === E.camera;
        try { E.post.add(bloom()); } catch (x) { out.postErr = x.message; }
        E.cameraRig.cut('b'); await rvWait(E, 2); out.b = read(); out.chainB = inChain();
        await E.level.load(rvFlat(THREE, 30)); await rvWait(E, 3); out.reload = read();
        E.cameraRig.cut('a'); await rvWait(E, 2); out.a2 = read(); out.chainA = inChain();
        await E.session.newGame(); await rvWait(E, 2); out.ng = read(); out.chainNg = inChain();
        out.err = E.error?.message ?? null; out.said = q.said.filter(s => /pixel/i.test(s)).slice(0, 2);
        E.dispose(); q.back();
        return out;
      });
      const keeps = a => a.ortho && a.snap?.agrees !== false;
      check('shot a', keeps(r.a), J(r));
      check('shot b', keeps(r.b) && r.b.h === r.a.h, J(r));
      check('back on a after a level reload: same art pixel', keeps(r.a2) && r.a2.h === r.a.h, J(r));
      check('the post chain follows the camera', r.chainB && r.chainA && r.chainNg, J(r));
      check('a new game starts on shot a, agreeing', keeps(r.ng), J(r));
      check('no conflict said, no error', !r.said.length && !r.err, J(r));
    },
  },
];
