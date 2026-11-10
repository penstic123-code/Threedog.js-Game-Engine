// [review] Third batch of cross-module probes of the 1.0 whole-system review: hot reload against play, walks across a new game, what level.unload leaves.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  window.rvFlat = (THREE, w = 60) => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, w), new THREE.MeshBasicMaterial()); m.name = 'ground'; m.position.y = -0.1; s.add(m); return s; };
  window.rvQuiet = () => { const was = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 180)); return { said, back() { [console.error, console.warn] = was; } }; };
};

export const specs = [
  {
    name: '[guard] Hot reload of a body template against play: a pushed crate stays, a body taken out of the template leaves',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, level, THREE, all: T } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-hot');
        E.assets.manifest({ name: 'rv-h', models: { rvCrate: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) } });
        E.use(world(), collision(), T.content(), level({ scene: rvFlat(THREE) }), T.rigid());
        await E.start();
        const pack = body => ({ templates: { rvCrate: { model: 'rvCrate', ...(body ? { body: { shape: 'box', mass: 2 } } : { collide: 'box' }) } }, props: [{ id: 'rv-c1', template: 'rvCrate', x: 2, z: 2 }] });
        const settle = async n => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(s => setTimeout(s, 10)); E.step(1 / 60); } };
        const out = {};
        E.content.load(pack(true)); await settle(8);
        const b = E.rigid.bodies.find(x => x.mesh);
        b.body.setTranslation({ x: 8, y: 0.6, z: 2 }, true); await settle(10);
        out.pushed = +E.world.get('rv-c1').position.x.toFixed(1);
        E.content.load(pack(true)); await settle(8);
        out.reloaded = +E.world.get('rv-c1').position.x.toFixed(1);
        out.bodyAt = +(E.rigid.bodies.find(x => x.mesh)?.body.translation().x ?? NaN).toFixed(1);
        E.content.load(pack(false)); await settle(8);
        out.noBody = { bodies: E.rigid.bodies.filter(x => x.mesh).length };
        out.err = E.error?.message ?? null; out.said = q.said.slice(0, 2);
        E.dispose(); q.back();
        return out;
      });
      check('the crate was pushed and the record followed', r.pushed === 8, J(r));
      check('the same pack again leaves the pushed crate where play put it', r.reloaded === 8 && r.bodyAt === 8, J(r));
      check('a template that no longer has a body has none on its copies', r.noBody.bodies === 0, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] A walk does not outlive its playthrough: newGame and quit end it and give the control slot back',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE, all: T } = threedogThreads, q = rvQuiet();
        const E = mk(createEngine, 'rv-ng');
        E.use(world(), collision(), characters(), level({ scene: rvFlat(THREE) }));
        await E.start();
        const p = E.characters.addPlayer({ control: 'camera' });
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        const out = {}; let end = null;
        const w = p.walkTo({ x: 20, z: 0 }); w.then(v => { end = v.status; });
        step(10);
        await E.session.newGame(); await new Promise(s => setTimeout(s, 20));
        step(60); await new Promise(s => setTimeout(s, 20));
        const p2 = E.player; out.same = p2 === p; out.end = end; out.slot = E.control.of(p2.id)?.layer ?? null;
        let end2 = null; p2.walkTo({ x: 20, z: 0 }).then(v => { end2 = v.status; }); step(5);
        await E.session.quit(); await new Promise(s => setTimeout(s, 20)); out.quit = end2; out.slotQuit = E.control.of(p2.id)?.layer ?? null; out.x = +p2.root.position.x.toFixed(1); out.err = E.error?.message ?? null; out.said = q.said.slice(-2);
        E.dispose(); q.back();
        return out;
      });
      check('the walk ended with the old playthrough', r.end === 'cancelled', J(r));
      check('quit ends a walk too', r.quit === 'cancelled', J(r));
      check('the control slot is the player\'s again', r.slot === 'base' && r.slotQuit === 'base', J(r));
      check('the player of the new game stands at the start', Math.abs(r.x) < 0.5, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] level.unload: A* rasters and props of the level that left',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE, all: T } = threedogThreads, q = rvQuiet();
        const s = rvFlat(THREE), c = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 60), new THREE.MeshBasicMaterial()); c.name = 'col_w'; c.position.set(0, 1.5, 0); s.add(c);
        const E = mk(createEngine, 'rv-ul');
        E.assets.manifest({ name: 'rv-u', models: { rvPost: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) } });
        E.use(world(), collision(), characters(), T.content(), level({ scene: s }));
        await E.start();
        E.content.load({ props: [{ id: 'rv-p', model: 'rvPost', x: -4, z: 0, collide: 'box' }] });
        const settle = async n => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(s => setTimeout(s, 10)); E.step(1 / 60); } };
        await settle(6);
        const out = { before: E.characters.findPath({ x: -8, z: 0 }, { x: 8, z: 0 })?.length ?? null };
        E.level.unload(); await settle(4);
        out.after = E.characters.findPath({ x: -8, z: 0 }, { x: 8, z: 0 })?.length ?? null;
        out.wall = !E.collision.walkable({ x: 0, z: 0 });
        out.prop = !!E.world.get('rv-p'); out.propBlocks = !E.collision.walkable({ x: -4, z: 0 });
        out.zone = E.world.zone; out.err = E.error?.message ?? null;
        E.dispose(); q.back();
        return out;
      });
      check('the wall left with the level', r.wall === false, J(r));
      check('A* no longer goes by the raster of the wall that left', r.after > 0, J(r));
      check('no error', !r.err, J(r));
    },
  },
];
