// What a review of the 1.0 branch found, each on a real engine: three-axis rot / scale in the code that still read one number, composite void height, refY on a level's
// slope and ground type, quest steps after a branch or a loop, and A* with a goal on a floor it can't reach.
const PAGE = '/tests/threads/';

/** Ground at 0 and a deck at 3 m over x 3..15: two floors with no way between them. The deck is tilted a little so it has a slope of its own; material names are the ground types */
const twoFloors = `(THREE => {
  const g = new THREE.Group();
  const part = (geo, name, x, y) => { const p = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ name })); p.position.set(x, y, 0); g.add(p); };
  part(new THREE.PlaneGeometry(40, 30).rotateX(-Math.PI / 2), 'grass', 0, 0);
  part(new THREE.PlaneGeometry(12, 10).rotateX(-Math.PI / 2).rotateZ(0.1), 'wood', 9, 3);
  return g;
})`;

export const specs = [
  {
    name: 'Review: [x, y, z] rot and scale reach a template body and a place that moved',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const E = mk(T.createEngine, 'rv-rot');
        E.use(T.world(), T.collision(), T.content(), T.rigid());
        await E.start(); E.haltLoop();
        const steps = async n => { for (let i = 0; i < n; i++) { E.step(1 / 60, { render: false, describe: false }); await new Promise(res => setTimeout(res, 0)); } };
        E.assets.manifest({ name: 'rv', models: { rvBox: () => new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial()) } });
        E.content.load({ templates: { rvCrate: { model: 'rvBox', body: { shape: 'box', mass: 1 } } }, props: [{ id: 'rv-a', template: 'rvCrate', x: 4, z: 4, scale: [1, 3, 1] }] });
        for (let i = 0; i < 60 && !E.world.view('rv-a'); i++) await steps(1);
        out.y = E.world.get('rv-a').position.y;
        // a place turned by a reload: the turn reaches a record nobody turned, though its rot is an array the baseline only has a copy of
        const places = turn => ({ rvSpot: { x: 8, z: 8, rot: turn } });
        const prop = { id: 'rv-b', model: 'rvBox', place: 'rvSpot', rot: [0.3, 0, 0], collide: false };
        E.content.load({ props: [prop] }, { places: places(0) });
        E.content.load({ props: [prop] }, { places: places(1) });
        out.rot = E.world.get('rv-b').rot;
        await steps(2);
        E.dispose();
        return out;
      });
      check('a body with a per-axis scale stands on the ground at half its scaled height', Math.abs(r.y - 3) < 1e-6, r.y);
      check('a place turned on reload carries an untouched [x, y, z] rot', JSON.stringify(r.rot) === '[0.3,1,0]', JSON.stringify(r.rot));
    },
  },
  {
    name: 'Review: compositeGround takes the void height from the parts that have one',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const E = mk(T.createEngine, 'rv-void');
        const island = { height: () => 0, voidY: () => -20 };
        E.use(T.world(), T.collision(), T.rigid({ fallbackFloor: false }), T.compositeGround({ parts: [{ ground: island, region: (x, z) => x < 100 }, { ground: { height: () => 7 }, region: { volume: { contains: p => p.x >= 100 } } }] }));
        await E.start(); E.haltLoop();
        out.voidY = E.ground.voidY();
        out.ys = [E.surface(0, 0), E.surface(200, 0)];
        const fell = [];
        E.events.on('terrain:void', e => fell.push(e.position.y));
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial()); ball.position.set(50, -15, 0); E.add(ball);
        E.rigid.addBall(ball, { mass: 1 });
        for (let i = 0; i < 240 && !fell.length; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(res => setTimeout(res, 1)); }
        out.fell = fell.length;
        E.dispose();
        const O = mk(T.createEngine, 'rv-rect');
        try { O.use(T.compositeGround({ parts: [{ ground: island, region: { rect: [0, 0, 1, 1] } }] })); await O.start(); out.oldForm = 'taken'; } catch (e) { out.oldForm = e.message; }
        O.dispose();
        return out;
      });
      check('a part with no void leaves the height of the part that has one', r.voidY === -20, r.voidY);
      check('a ball falling past it fires terrain:void', r.fell === 1, r.fell);
      check('a region is a function or a { volume }', r.ys.join() === '0,7', r.ys.join());
      check('{ rect } is refused and the error names what to write', /volume/.test(r.oldForm), r.oldForm);
    },
  },
  {
    name: 'Review: refY picks the layer of a level for slope and ground type, and a character under a deck reads the ground it stands on',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async scene => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const E = mk(T.createEngine, 'rv-layers');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.level({ scene: eval(scene)(THREE) }));
        await E.start(); E.haltLoop();
        out.type = [E.groundType(9, 0), E.groundType(9, 0, 3), E.groundType(9, 0, 0)];
        out.slope = [E.slope(9, 0), E.slope(9, 0, 3), E.slope(9, 0, 0)];
        const p = E.characters.addPlayer({ control: 'camera', spawn: { x: 9, y: 0, z: 0 } });
        p.placeAt([9, 0, 0]);
        out.feet = [p.position.y, p.groundType()];
        E.dispose();
        return out;
      }, twoFloors);
      check('groundType: no refY is the top layer, refY picks the layer', r.type.join() === 'wood,wood,grass', r.type.join());
      check('slope: no refY is the top layer, refY picks the layer', r.slope[0] > 0.05 && Math.abs(r.slope[1] - r.slope[0]) < 1e-3 && r.slope[2] < 1e-6, r.slope.join());
      check('Character.groundType reads the layer under the feet', r.feet[1] === 'grass', r.feet.join());
    },
  },
  {
    name: 'Review: quests.list marks the steps that ran: a skipped step is not done, a step looped back to is current',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'rv-quest');
        E.use(T.world(), T.quests());
        await E.start(); E.haltLoop();
        const never = () => false, row = id => E.quests.list().find(q => q.id === id).steps.map(s => `${s.done ? 'd' : '-'}${s.current ? 'c' : ''}`).join(' ');
        E.ops.allow(() => {
          E.quests.define('skip', { title: 's', steps: [{ id: 'a', text: 'a', done: never, next: 'c' }, { id: 'b', text: 'b', done: never }, { id: 'c', text: 'c', done: never }, { id: 'd', text: 'd', done: never }] });
          E.quests.define('loop', { title: 'l', steps: [{ id: 'a', text: 'a', done: never }, { id: 'b', text: 'b', done: never }, { id: 'c', text: 'c', done: never, next: 'b' }, { id: 'd', text: 'd', done: never }] });
          E.quests.start('skip'); E.quests.advance('skip'); out.skip = row('skip');
          E.quests.advance('skip'); E.quests.advance('skip'); out.skipEnd = row('skip');
          E.quests.start('loop'); E.quests.advance('loop'); E.quests.advance('loop'); E.quests.advance('loop'); out.loop = row('loop');
        });
        // a save from before visited: the steps behind the current one still read as done
        const s = structuredClone(E.quests._save()); delete s.state.loop.visited; s.state.loop.step = 'c';
        E.quests._load(s); out.old = row('loop');
        E.dispose();
        return out;
      });
      check('the skipped step stays not done', r.skip === 'd - -c -', r.skip);
      check('and stays so when the quest is done', r.skipEnd === 'd - d d', r.skipEnd);
      check('the step looped back to is current, not done, and the steps that ran are done', r.loop === 'd -c d -', r.loop);
      check('a save without visited reads the steps behind as done', r.old === 'd d -c -', r.old);
    },
  },
  {
    name: 'Review: A* answers noPath for a goal on a floor it cannot reach, and a path for anything on the walker\'s floor',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async scene => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const E = mk(T.createEngine, 'rv-astar');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.level({ scene: eval(scene)(THREE) }));
        await E.start(); E.haltLoop();
        const ask = (a, b) => { const x = E.characters.findPath(a, b, { detailed: true }); return [x.status, x.path ? +x.path.at(-1).y.toFixed(2) : null]; };
        out.up = ask([-8, 0, 0], [9, 3, 0]);
        out.down = ask([9, 3, 0], [12, 0, 0]);
        out.drop = ask([9, 3, 0], [-8, 0, 0]);
        out.same = ask([-8, 0, 0], [9, 0, 0]);
        out.deck = ask([5, 3, 0], [12, 3, 0]);
        out.noY = ask([5, 3, 0], { x: 12, z: 0 });
        out.noYBelow = ask([-8, 0, 0], { x: 9, z: 0 });
        out.air = ask([-8, 0, 0], [-2, 1.4, 0]);
        // async on the same two floors
        const later = (a, b) => new Promise(res => { E.characters.findPathAsync(a, b, (p, status) => res(status)); for (let i = 0; i < 12; i++) E.step(1 / 60, { render: false, describe: false }); });
        out.async = [await later([-8, 0, 0], [9, 3, 0]), await later([-8, 0, 0], [9, 0, 0]), await later([-8, 0, 0], { x: 9, z: 0 })];
        E.dispose();
        return out;
      }, twoFloors);
      const J = k => JSON.stringify(r[k]);
      check('up to a deck with no way there: noPath', r.up[0] === 'noPath' && r.up[1] === null, J('up'));
      check('from it to the ground under it: off the edge and back under', r.down[0] === 'ok' && r.down[1] === 0, J('down'));
      check('off its edge to open ground: a walker drops, so a path', r.drop[0] === 'ok' && r.drop[1] === 0, J('drop'));
      check('under the deck, on the walker\'s floor: a path', r.same[0] === 'ok' && r.same[1] === 0, J('same'));
      check('along the deck: a path', r.deck[0] === 'ok', J('deck'));
      check('a goal with no y means any height', r.noY[0] === 'ok' && r.noYBelow[0] === 'ok', J('noY') + J('noYBelow'));
      check('a y in the air over the walker\'s floor is that floor', r.air[0] === 'ok', J('air'));
      check('async A* says the same', r.async.join() === 'noPath,ok,ok', J('async'));
    },
  },
];
