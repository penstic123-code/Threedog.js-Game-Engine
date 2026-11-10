// [guard] Whatever owns a value writes it, and what breaks ends: a timeline task that throws fails its own promise and nothing else (modules/timeline/Tween.js); a cutscene writes a
// character or the camera only while it is the holder in charge (modules/timeline/shots.js); physics' default floor is a copy of the ground, so it follows the ground source (modules/rigid/sync.js).
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  window.owQuiet = () => { const was = [console.error, console.warn]; console.error = console.warn = () => {}; return () => { [console.error, console.warn] = was; }; };
  // a timeline's next step starts in a microtask and a promise report in a macrotask, so a plain loop of step() would outrun both
  window.owRun = async (E, seconds) => { for (let t = 0; t < seconds - 1e-6; t += 0.05) { E.step(0.05, { render: false, describe: false }); await new Promise(r => setTimeout(r, 0)); } };
  window.owBad = (when = () => true) => { const o = { sets: 0, at: 0 }; Object.defineProperty(o, 'v', { get: () => o.at, set(x) { o.sets++; if (when(x)) throw new Error('bad write'); o.at = x; } }); return o; };
  window.owEngine = async (name, ...mods) => {
    const { mk, all: T } = threedogThreads, E = mk(T.createEngine, name);
    E.use(T.world(), T.collision(), T.characters(), T.timeline(), ...mods);
    await E.start(); E.haltLoop();
    return E;
  };
  // what p answers within that much game time; the steps stop with it, so the next part of a test starts on its own clock
  window.owTimed = async (p, E, seconds) => {
    let out = 'still waiting', over = false;
    p.then(v => { out = v; over = true; });
    for (let t = 0; t < seconds - 1e-6 && !over; t += 0.05) { E.step(0.05, { render: false, describe: false }); await new Promise(r => setTimeout(r, 0)); }
    return out;
  };
};

export const specs = [
  {
    name: '[guard] tween failure: a write that throws on its last or a middle step ends the run, frees the cutscene and leaves the other tasks going',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const quiet = owQuiet(), out = {}, E = await owEngine('ow-tween');
        const P = E.characters.addPlayer({ control: () => null, spawn: { x: 0, z: 0 } });
        const base = E.control.of(P).owner;
        const free = () => ({ playing: E.timeline.playing, owner: E.control.of(P).owner, blocked: E.runState.blockedBy.includes('cutscene'), tasks: E.timeline._tweener.list.length });
        const last = owBad(x => x === 1);
        out.last = await owTimed(E.timeline.play([{ tween: { target: last, to: { v: 1 }, duration: 0.2, ease: 'linear' } }]), E, 1);
        out.lastFree = free();
        const middle = owBad(), good = { v: 0 };
        const both = E.timeline.play([{ parallel: [{ tween: { target: middle, to: { v: 1 }, duration: 0.5 } }, { wait: 5 }] }]);
        const beside = E.timeline.tween(good, { v: 1 }, { duration: 0.2, ease: 'linear' });
        out.middle = await owTimed(both, E, 1);
        out.middleFree = free(); out.sets = middle.sets;
        await owRun(E, 0.3);
        out.beside = [await owTimed(beside, E, 0.1), good.v];
        E.dispose(); quiet();
        return { ...out, base };
      });
      for (const k of ['last', 'middle']) check(`the ${k} step: play() answers failed`, r[k]?.ending === 'failed' && r[k].error === 'bad write', J(r));
      const free = (f, tasks) => f.playing === false && f.owner === r.base && !f.blocked && f.tasks === tasks;
      check('control and input focus go back, the task left the list (the tween beside it stays)', free(r.lastFree, 0) && free(r.middleFree, 1), J(r));
      check('a bad step is not tried again every frame', r.sets === 1, J(r));
      check('a tween beside it reaches its end', r.beside[0] === true && r.beside[1] === 1, J(r));
    },
  },
  {
    name: '[guard] tween failure: start, end and a jump to the end fail the promise alone; nobody awaiting is reported once, an await that catches not at all',
    url: PAGE,
    expectErrors: /bad write|bad start|bad end|rejection/i,   // the deliberate rejection nobody awaits
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const quiet = owQuiet(), out = {}, E = await owEngine('ow-tween-parts'), T = E.timeline, W = T._tweener;
        const said = p => p.then(() => 'ok', x => x.message);
        const unhandled = () => E.describe().unhandled?.count ?? 0;
        let ended = 0;
        const start = said(W.run({ duration: 1, start() { throw new Error('bad start'); }, end() { ended++; } }));
        const end = said(W.run({ duration: 0.1, end() { throw new Error('bad end'); } }));
        await owRun(E, 0.3);
        out.start = await owTimed(start, E, 0.05); out.end = await owTimed(end, E, 0.05); out.ended = ended; out.left = W.list.length;
        // a zero-length tween runs inside the call: a refused write is still the promise's, or a skipped run would stop before its other tasks
        try { out.zero = await said(T.tween(owBad(), { v: 1 }, { duration: 0 })); } catch (x) { out.sync = x.message; }
        // skip jumps every task to its end: the first one throwing leaves the rest going to theirs
        const bad = owBad(x => x === 1), good = { v: 0 };   // throws on the end value only: mid-run failure cancels (group T), this is the skip's jump
        const skipped = T.play([{ parallel: [{ tween: { target: bad, to: { v: 1 }, duration: 5 } }, { tween: { target: good, to: { v: 1 }, duration: 5 } }] }], { actors: [] });
        await owRun(E, 0.1);
        try { T.skip(); } catch (x) { out.thrown = x.message; }
        out.skip = await owTimed(skipped, E, 0.5); out.good = good.v; out.afterSkip = W.list.length;
        await new Promise(res => setTimeout(res, 20));
        out.before = unhandled();
        T.tween(owBad(), { v: 1 }, { duration: 0.1 });
        await owRun(E, 0.5); await new Promise(res => setTimeout(res, 20));
        out.alone = unhandled();
        const caught = await said(T.tween(owBad(), { v: 1 }, { duration: 0 }));
        await new Promise(res => setTimeout(res, 20));
        out.caught = [caught, unhandled()];
        E.dispose(); quiet();
        return out;
      });
      check('start: the promise fails and what it holds is freed', r.start === 'bad start' && r.ended === 1, J(r));
      check('end: the promise fails', r.end === 'bad end', J(r));
      check('both left the list', r.left === 0, J(r));
      check('zero length: the promise fails, the call does not throw', r.zero === 'bad write' && !r.sync, J(r));
      check('skip: every other task reaches its end and the run says failed', !r.thrown && r.good === 1 && r.skip?.ending === 'failed' && r.afterSkip === 0, J(r));
      check('a run reports its own failure: nothing unhandled', r.before === 0, J(r));
      check('a plain tween nobody awaits is reported once', r.alone === 1, J(r));
      check('an await that catches it adds nothing', r.caught[0] === 'bad write' && r.caught[1] === 1, J(r));
    },
  },
  {
    name: '[guard] cutscene path: a character under a higher holder or on a seat is left alone, the run ends on time, and the path writes again once back in charge',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { THREE } = threedogThreads, quiet = owQuiet(), out = {}, E = await owEngine('ow-path');
        const P = E.characters.addPlayer({ control: () => null, spawn: { x: 0, z: 0 } });
        await owRun(E, 0.1);
        let syncs = 0;
        const sync = P.syncRecord; P.syncRecord = function () { syncs++; return sync.call(this); };
        const path = duration => ({ path: { object: P, points: [[0, 0, 0], [20, 0, 0]], duration, ease: 'linear', lookAhead: 0.05 } });
        const pose = () => [P.position.x, P.position.z, P.facing].map(n => Math.round(n * 1000) / 1000);

        // a holder above the cutscene (what a ragdoll takes) from the start to the end
        P.placeAt({ x: 3, z: 3 });
        const body = E.control.take(P, { owner: 'body', layer: 'physics', step: () => false });
        out.held = pose();
        const run = E.timeline.play([path(0.5)]);
        await owRun(E, 0.25);
        out.during = pose();
        out.heldEnd = await owTimed(run, E, 0.5);
        out.after = pose(); out.syncs = syncs;
        body.remove();

        // the holder comes and goes half way: the path picks up where its clock is, and what it placed last reaches the record
        const late = E.timeline.play([path(1)]);
        const body2 = E.control.take(P, { owner: 'body', layer: 'physics', step: () => false });
        await owRun(E, 0.5);
        out.paused = pose();
        body2.remove();
        await owRun(E, 0.2);
        out.back = pose();
        out.lateEnd = await owTimed(late, E, 0.6);
        out.record = E.world.get('player').position.x; out.syncsAfter = syncs;

        // a seat keeps its rider too
        const object = new THREE.Object3D(); E.add(object); object.position.set(-7, 0, -7);
        const car = { object, speed: 0, driver: null, seatPosition: () => object.position.clone(), exitPosition: () => ({ x: -9, y: 0, z: -7 }), drive() {} };
        P.enter(car);
        await owRun(E, 0.1);
        const seen = [];
        const seated = E.timeline.play([path(0.4)]);
        for (let i = 0; i < 6; i++) { await owRun(E, 0.05); seen.push(P.position.x); }
        out.seatEnd = await owTimed(seated, E, 0.5);
        out.seat = seen;
        E.dispose(); quiet();
        return out;
      });
      check('held: nothing written during the run', J(r.during) === J(r.held) && J(r.after) === J(r.held), J(r));
      check('held: the run finishes on time, and does not write the record over the holder', r.heldEnd?.ending === 'finished' && r.syncs === 0, J(r));
      check('paused under a holder that came in half way', r.paused[0] === r.after[0], J(r));
      check('back in charge the path writes again, where its clock is', r.back[0] > 8, J(r));
      check('it ends on its point and catches the record up', r.lateEnd?.ending === 'finished' && Math.abs(r.record - 20) < 0.01 && r.syncsAfter === 1, J(r));
      check('a rider stays on its seat', r.seat.every(x => x === -7) && r.seatEnd?.ending === 'finished', J(r));
    },
  },
  {
    name: '[guard] cutscene camera: a shot or a camera path that is not the holder in charge keeps its time, writes nothing, and writes again when back',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { all: T, THREE } = threedogThreads, quiet = owQuiet(), out = {}, E = await owEngine('ow-cam', T.followCamera());
        const r3 = n => Math.round(n * 1000) / 1000;
        const lens = () => [...E.camera.position.toArray().map(r3), r3(E.camera.fov)];
        const look = () => E.camera.getWorldDirection(new THREE.Vector3()).toArray().map(r3);

        // another holder takes the camera in the middle of a shot
        const shot = E.timeline.play([{ camera: { to: { position: [40, 10, 0], lookAt: [0, 0, 0] }, duration: 2, ease: 'linear', fov: 30 } }], { actors: [] });
        await owRun(E, 0.5);
        const photo = E.takeCamera('photo');
        E.camera.position.set(1, 2, 3); E.camera.lookAt(0, 0, -50); E.camera.fov = 70; E.camera.updateProjectionMatrix();
        const mine = lens(), dir = look();
        await owRun(E, 0.5);
        const same = (a, b) => a.every((n, i) => n === b[i]);
        out.held = [same(lens(), mine), same(look(), dir)]; out.seen = lens();
        photo.remove();
        await owRun(E, 0.25);
        out.back = lens();
        out.shotEnd = await owTimed(shot, E, 1.2);
        out.last = lens();

        // two overlapping runs: the newer one has the camera, the older one's clock runs under it
        const a = E.timeline.play([{ camera: { to: { position: [0, 50, 0], lookAt: [0, 0, 0] }, duration: 2, ease: 'linear' } }], { actors: [] });
        await owRun(E, 0.25);
        const b = E.timeline.play([{ camera: { from: { position: [-30, 5, 0], lookAt: [0, 0, 0] }, to: { position: [-30, 5, 0], lookAt: [0, 0, 0] }, duration: 0.5 } }], { actors: [] });
        const seen = [];
        for (let i = 0; i < 6; i++) { await owRun(E, 0.05); seen.push(lens()[0]); }
        out.older = seen;
        await owTimed(b, E, 0.5);
        await owRun(E, 0.2);
        out.afterB = lens();
        await owTimed(a, E, 1.8);

        // a path on the camera goes through the same check
        const path = E.timeline.play([{ path: { object: E.camera, points: [[0, 5, 0], [0, 5, 40]], duration: 1, ease: 'linear' } }], { actors: [] });
        await owRun(E, 0.25);
        const views = E.takeCamera('views');
        E.camera.position.set(-1, -2, -3);
        await owRun(E, 0.25);
        out.path = lens().slice(0, 3);
        views.remove();
        await owRun(E, 0.2);
        out.pathBack = lens().slice(0, 3);
        await owTimed(path, E, 0.5);
        E.dispose(); quiet();
        return out;
      });
      check('held: position and look stay the holder\'s', r.held[0] && r.held[1], J(r));
      check('held: fov stays the holder\'s', r.seen[3] === 70, J(r));
      check('back in charge the shot writes again, where its clock is', r.back[0] > 20 && r.back[0] < 40 && r.back[3] < 55, J(r));
      check('it ends on time on its target', r.shotEnd?.ending === 'finished' && r.last[0] === 40, J(r));
      check('overlap: only the newer run writes', r.older.every(x => x === -30), J(r));
      check('overlap: the older run writes again', r.afterB[1] > 5 && r.afterB[0] > -30, J(r));
      check('a camera path writes nothing while held, and again when back', J(r.path) === J([-1, -2, -3]) && r.pathBack[2] > 20, J(r));
    },
  },
  {
    name: '[guard] physics floor: it follows the ground source in both directions, across a rebuild, and a game that turned it off has none',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, THREE, all: T } = threedogThreads, out = {};
        const scene = () => { const g = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); m.name = 'ground'; m.position.y = -5; g.add(m); return g; };
        const E = mk(createEngine, 'ow-floor');
        E.use(T.collision(), T.rigid());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const floor = () => E.collider3d.overlap([10, -0.2, 10], 0.1);
        const count = () => E.rigid.world.colliders.len();
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.position.set(0, 0.6, 0); E.add(m);
        const crate = E.rigid.addBox(m, { mass: 1 });
        steps(240);
        out.start = { floor: floor(), rest: crate.body.translation().y, asleep: crate.body.isSleeping() };
        out.c0 = count();
        E.use(level({ scene: scene() }));
        await E.loading.settled(); steps(1);
        out.level = floor();
        steps(90);
        out.fell = crate.body.translation().y;
        E.rigid._fresh(); steps(1);
        out.rebuilt = floor();
        E.unuse('level');
        out.gone = floor();
        steps(1);
        out.back = { floor: floor(), count: count() };
        E.rigid._fresh(); steps(1);
        out.rebuiltBack = { floor: floor(), count: count() };
        E.dispose();

        const O = mk(createEngine, 'ow-floor-off');
        O.use(T.collision(), T.rigid({ fallbackFloor: false }));
        await O.start();
        out.off = O.collider3d.overlap([10, -0.2, 10], 0.1);
        O.dispose();
        return out;
      });
      check('no ground source: the floor is there and a crate sleeps on it', r.start.floor && r.start.asleep && Math.abs(r.start.rest - 0.5) < 0.05, J(r));
      check('a level installed while running takes the floor away', r.level === false, J(r));
      check('what slept on it falls to the level', r.fell < -3, J(r));
      check('a rebuild does not bring it back under a level', r.rebuilt === false, J(r));
      check('the ground source gone, the floor is back on the next read', r.gone === true && r.back.floor, J(r));
      check('one floor, also after a rebuild', r.rebuiltBack.floor && r.back.count === r.rebuiltBack.count && r.back.count === r.c0, J(r));
      check('fallbackFloor: false stays off', r.off === false, J(r));
    },
  },
  {
    name: '[guard] physics terrain: chunks built from a ground source that left go with it, and stay while it is there',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, out = {};
        const E = mk(createEngine, 'ow-terrain');
        E.use(T.collision(), T.terrain({ height: () => 0, viewChunks: 2 }), T.rigid());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        for (let i = 0; i < 300 && !E.rigid.terrain.size; i++) { steps(1); await new Promise(res => setTimeout(res, 0)); }
        steps(60);
        const count = () => E.rigid.world.colliders.len();
        out.built = E.rigid.terrain.size; out.c0 = count();
        steps(60);
        out.stays = E.rigid.terrain.size; out.same = count();
        E.unuse('terrainDraw'); E.unuse('terrain');
        E.collider3d.overlap([1, -0.05, 1], 0.02);
        out.left = E.rigid.terrain.size + E.rigid.trees.size;
        steps(2);
        out.after = { left: E.rigid.terrain.size + E.rigid.trees.size, count: count() };
        E.dispose();
        return out;
      });
      check('terrain chunks are built (setup)', r.built > 0, J(r));
      check('with the terrain there nothing is dropped', r.stays === r.built && r.same === r.c0, J(r));
      check('the terrain gone, its chunks are gone on the next read', r.left === 0 && r.after.left === 0, J(r));
      check('the default floor stands alone', r.after.count < r.c0, J(r));
    },
  },
  {
    name: '[guard] ops.undo: a failed run leaves nothing to undo, and a canUndo that throws is answered like a broken undo',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, out = {};
        const E = mk(createEngine, 'ow-undo');
        E.use(T.collision());
        await E.start(); E.haltLoop();
        const args = { id: 'no-such-thing', position: [1, 0, 1] }, failed = E.ops.run('thing.set', args);
        out.failed = failed.ok;
        const rev = E.ops.revision;
        try { out.set = E.ops.undo('thing.set', args, failed.value).code; } catch (err) { out.set = 'threw: ' + err.message; }
        try { out.remove = E.ops.undo('thing.remove', { id: 'no-such-thing' }, undefined).code; } catch (err) { out.remove = 'threw: ' + err.message; }
        out.same = E.ops.revision === rev;
        E.dispose();
        return out;
      });
      check('the run failed (setup)', r.failed === false, J(r));
      check('undo of it answers, on both thing ops', r.set === 'nothingToUndo' && r.remove === 'nothingToUndo', J(r));
      check('nothing changed, so the revision stays', r.same, J(r));
    },
  },
];
