// [review] Fourth batch of cross-module probes of the 1.0 whole-system review: the player's fov across a new game, the rapier mover under a replaced rigid.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] The fov slider survives a new game and a save load',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, all: T } = threedogThreads;
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const E = mk(createEngine, 'rv-fov');
        E.use(world(), T.followCamera({ distance: 8 }), T.settings({ sections: ['camera'] }));
        await E.start(); E.step(1 / 60);
        const out = { fov0: E.camera.fov };
        E.settings.set('camera.fov', 80); E.step(1 / 60);
        out.set = E.camera.fov;
        await E.session.newGame(); E.step(1 / 60);
        out.newGame = { fov: E.camera.fov, setting: E.settings.get('camera.fov') };
        E.settings.set('camera.fov', 70); E.step(1 / 60);
        E.setCamera('follow', { distance: 5 }); E.step(1 / 60);
        out.switched = { fov: E.camera.fov, setting: E.settings.get('camera.fov') };
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('the slider moved the camera', r.set === 80, J(r));
      check('a new game keeps the player\'s fov', r.newGame.fov === r.newGame.setting, J(r));
      check('a rig switch keeps the player\'s fov (control)', r.switched.fov === r.switched.setting, J(r));
    },
  },
  {
    name: '[guard] Rapier mover: rigid replaced under a walking player and NPC-free scene',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE, all: T } = threedogThreads;
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g);
        const E = mk(createEngine, 'rv-rap');
        E.use(world(), collision(), characters(), level({ scene: s }), T.rigid());
        await E.start();
        const p = E.characters.addPlayer({ control: 'camera', mover: 'rapier' });
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        step(10);
        const out = { mover: p.mover?.name ?? p.mover ?? null, before: E.error?.message ?? null };
        try { E.use(T.rigid(), { replaces: 'rigid' }); await E.loading.settled(); step(20); } catch (x) { out.swapErr = x.message; }
        out.err = E.error?.message ?? null; out.y = +p.root.position.y.toFixed(2);
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('no error before the swap', !r.before, J(r));
      check('rigid replaced under a rapier-mover player: the game keeps running', !r.swapErr && !r.err, J(r));
    },
  },
];
