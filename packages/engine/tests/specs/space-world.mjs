// Facts outlive models, the world is ready before the player walks in, and who writes a body stays clear: cross-module runs on throwaway engines (threads test page).
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'space world: a record outlives its model: released, moved far away, an async build overtaken, rebuilt at the record; far time adds up; an NPC comes back on its floor',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'world-rec');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const W = E.world, step = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const pending = [], made = [], dropped = [];
        W.present('crate', { radius: 20, build: rec => new Promise(res => pending.push(() => { const m = new THREE.Object3D(); made.push(m); res(m); })), dispose: (rec, obj) => { dropped.push(obj); E.remove(obj); } });
        W.simulate('crate', { far: (rec, dt) => { rec.seconds = (rec.seconds ?? 0) + dt; }, farEvery: 0.25 });
        W.add({ id: 'c', kind: 'crate', position: [5, 0, 0], hp: 3 });
        step(2); pending.shift()(); await new Promise(res => setTimeout(res, 0)); step(1);
        out.built = !!W.view('c');
        E.focus.set(500, 0, 0); step(2);
        out.released = W.view('c') ?? null; out.kept = W.get('c')?.hp;
        W.set('c', { hp: 2 }); W.move('c', [505, 0, 0]);
        step(2);                                     // near again, at the far place: a build starts
        const late = pending.shift();
        E.focus.set(0, 0, 0); step(2);               // gone again before it finished
        late?.(); await new Promise(res => setTimeout(res, 0)); step(1);
        out.overtaken = { asked: !!late, dropped: dropped.length, made: made.length, view: W.view('c') ?? null };
        E.focus.set(505, 0, 0); step(2);
        pending.shift()?.(); await new Promise(res => setTimeout(res, 0)); step(2);
        out.rebuilt = W.view('c')?.position.toArray() ?? null; out.hp = W.get('c').hp;
        // removed while a build is on its way: nothing stays in the scene
        W.add({ id: 'd', kind: 'crate', position: [506, 0, 0] }); step(2);
        const dead = pending.shift(); W.remove('d'); dead?.(); await new Promise(res => setTimeout(res, 0)); step(1);
        out.removed = { asked: !!dead, sceneHas: made.at(-1)?.parent ? 'in scene' : 'gone' };
        // an NPC walks a straight line far off and is on the record's floor when its model returns
        E.focus.set(0, 0, 0);
        E.setGround({ height: (x, z, y) => (x > 90 && (y === undefined || y >= 2.5) ? 3 : 0), slope: () => 0, type: () => 'default' });
        const n = E.npcs.add({ id: 'n', name: 'N', position: [100, 3, 0], schedule: [{ at: 0, position: [100, 3, 30] }], speed: 3 });
        step(2);
        out.npcModelFar = !!n.character; const t0 = n.position.z;
        step(300);
        out.npcFar = n.position.toArray();
        E.focus.set(100, 0, 20); step(3);
        out.npcBack = { model: !!n.character, pos: n.position.toArray(), z0: t0 };
        const before = n.position.z; step(60); out.npcMoved = n.position.z - before; out.npcY = n.position.y;
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('the model exists near', r.built === true, J);
      check('far, the model goes and the record stays', r.released === null && r.kept === 3, J);
      check('a build that finishes after the source left is thrown away, not left in the scene', r.overtaken.asked && r.overtaken.view === null && r.overtaken.dropped >= 2, J);
      check('the rebuilt model stands at the record, with the changes made while it had none', r.rebuilt?.[0] === 505 && r.hp === 2, J);
      check('a record removed during its build leaves nothing', r.removed.asked && r.removed.sceneHas === 'gone', J);
      check('far, an NPC keeps walking on data at its height', r.npcModelFar === false && r.npcFar[2] > 10 && r.npcFar[1] === 3, J);
      check('near again, the model comes back at the data and keeps its floor', r.npcBack.model && r.npcBack.pos[2] >= r.npcFar[2] && r.npcY === 3, J);
    },
  },
  {
    name: 'space world: into unloaded ground: teleport waits for colliders and a slow stream entry; a Rapier walker placed ahead of its collider does not fall through',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'world-stream');
        E.use(T.terrain({ height: (x, z) => 3 * Math.sin(x * 0.05), viewChunks: 2 }), T.world(), T.collision(), T.characters({ npcs: false }), T.rigid());
        await E.start(); E.haltLoop();
        const P = E.characters.addPlayer({ control: 'camera', mover: 'rapier', spawn: { x: 0, z: 0 } });
        const tick = async n => { for (let i = 0; i < n; i++) { E.step(1 / 30, { render: false, describe: false }); await new Promise(res => setTimeout(res, 0)); } };
        await tick(10);
        const dest = [900, 0, 900]; let finish = null, wall = null;
        E.stream.add({ position: dest, radius: 4, build: () => new Promise(res => { finish = () => { wall = E.collision.addBox([905, 0, 900], { halfWidth: 1, halfDepth: 1 }); res(new THREE.Object3D()); }; }) });
        let landed = false; const go = E.stream.teleport(dest).then(() => { landed = true; });
        await tick(40);
        out.waiting = { landed, x: P.position.x, asked: !!finish };
        finish?.();
        for (let i = 0; i < 400 && !landed; i++) await tick(1);
        await go;
        out.landed = { landed, x: P.position.x, wall: !!wall, physics: E.rigid.readyAt(P.position), solid: E.terrain.readyAt(P.position, { rings: 1, solid: true }) };
        // no teleport: straight into ground with no collider yet, keys held
        P.placeAt([-1500, undefined, 40]);
        const h = E.control.take(P, { owner: 't', layer: 'script' });
        out.notReadyAt = !E.rigid.readyAt(P.position);
        let low = Infinity;
        for (let i = 0; i < 200; i++) { h.move(1, 0, false, 1 / 30); E.step(1 / 30, { render: false, describe: false }); low = Math.min(low, P.position.y - E.surface(P.position.x, P.position.z)); if (i % 20 === 0) await new Promise(res => setTimeout(res, 0)); }
        out.low = low; out.after = E.rigid.readyAt(P.position);
        h.remove(); E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('the player stays while the slow entry builds', r.waiting.asked && !r.waiting.landed && Math.abs(r.waiting.x) < 1, J);
      check('it lands with the entry\'s collider, the ground collider and the chunks solid', r.landed.landed && Math.abs(r.landed.x - 900) < 1 && r.landed.wall && r.landed.physics && r.landed.solid, J);
      check('placed ahead of the colliders the walker stays on the ground, and Rapier takes over', r.notReadyAt && r.low > -0.05 && r.after, J);
    },
  },
  {
    name: 'space world: one writer per body: a walk pauses under a holder and resumes, a walk follows a moving target, a manual mover rides a platform, a game-owned fall is not rescued',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'world-writers');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }));
        await E.start(); E.haltLoop();
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 }, fall: { belowY: -5 } });
        // a walk under a higher holder: nothing moves it, then it goes on
        let res = null; const w = P.walkTo([20, 0, 0]); w.then(v => { res = v; });
        step(30);
        const hold = E.control.take(P, { owner: 'cut', layer: 'cutscene' }), x0 = P.position.x;
        step(120); out.held = P.position.x - x0; hold.remove();
        step(600); await w; out.walk = res?.status; out.walkX = P.position.x;
        // a walk's target moves: a follower is not stuck because its target left
        const dog = new THREE.Object3D(); dog.position.set(0, 0, 0);
        P.placeAt([0, 0, 10]); res = null;
        const f = P.walkTo(dog, { arrive: 1 }); f.then(v => { res = v; });
        for (let i = 0; i < 2400 && !res; i++) { if (i < 1500) dog.position.x += 0.04; step(1); await (i % 200 ? null : new Promise(r2 => setTimeout(r2, 0))); }
        await f; out.follow = res?.status; out.gap = Math.hypot(P.position.x - dog.position.x, P.position.z - dog.position.z);
        // the game owns the fall: fact reported, no rescue
        const facts = []; E.events.on('character:fall', a => facts.push(a.character.id));
        E.mod('fall', { owner: 'game', set: false });
        E.setGround({ height: (x) => (x > 100 ? -50 : 0), slope: () => 0, type: () => 'default' });
        P.placeAt([99, 0, 0]);
        const h = E.control.take(P, { owner: 't', layer: 'script' });
        for (let i = 0; i < 200; i++) h.move(1, 0, false, 1 / 60);
        h.remove();
        out.fall = { facts: facts.length, y: P.position.y };
        // a manual mover: the game writes the position, a platform still carries it
        E.setGround({ height: () => 0, slope: () => 0, type: () => 'default' });
        const lift = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), new THREE.MeshBasicMaterial()); lift.position.set(50, 2, 50); E.scene.add(lift);
        const sup = E.characters.support(lift);
        P.placeAt([50, 2.5, 50]); P.mover = 'manual'; step(2);
        const on = P.support?.object === lift;
        for (let i = 0; i < 60; i++) { lift.position.x += 0.05; step(1); }
        out.manual = { on, x: P.position.x, name: P.mover.name };
        sup.remove();
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('a holder above stops the walk', Math.abs(r.held) < 1e-6, J);
      check('and the walk arrives after it', r.walk === 'arrived' && Math.abs(r.walkX - 20) < 1, J);
      check('a walk after a moving target arrives', r.follow === 'arrived' && r.gap < 1.5, J);
      check('the fall is reported and, with the rule off, the game keeps the body', r.fall.facts === 1 && r.fall.y < -5, J);
      check('a manual mover rides a platform', r.manual.on === true && Math.abs(r.manual.x - 53) < 0.1 && r.manual.name === 'manual', J);
    },
  },
  {
    name: 'space world: chunk collision takes effect on the same step with workers on, off and slowed, so walking into new ground meets the same world',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk } = threedogThreads;
        const run = async (threads, pause) => {
          const E = mk(T.createEngine, 'world-commit' + threads + pause, { threads });
          E.use(T.terrain({ height: (x, z) => 3 * Math.sin(x * 0.05), viewChunks: 2 }), T.world(), T.collision(), T.characters({ npcs: false }));
          await E.start(); E.haltLoop();
          const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } }), h = E.control.take(P, { owner: 't', layer: 'script' }), log = [];
          for (let i = 0; i < 360; i++) {
            h.move(1, 0, true, 1 / 60); E.step(1 / 60, { render: false, describe: false });
            if (pause && i % 7 === 0) await new Promise(res => setTimeout(res, pause));
            if (i % 12 === 0) log.push([...E.terrain.chunks.values()].filter(c => c.solid).map(c => c.key).sort().join(' '));
          }
          h.remove(); E.dispose();
          return log;
        };
        const a = await run(0, 0), b = await run(2, 0), c = await run(2, 4);
        return { n: a.length, ab: a.findIndex((v, i) => v !== b[i]), ac: a.findIndex((v, i) => v !== c[i]), last: a.at(-1).split(' ').length, first: a[0].split(' ').length };
      });
      const J = JSON.stringify(r);
      check('new chunks did turn solid during the run', r.last > 0 && r.n === 30, J);
      check('workers on: same solid chunks on the same steps as off', r.ab === -1, J);
      check('workers given time to answer early: the same again', r.ac === -1, J);
    },
  },
];
