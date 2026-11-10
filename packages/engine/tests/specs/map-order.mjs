// State map, order group: each row shows one suspected conflict between two owners of a state, through the public API only. A row stays here only while it fails on the
// claimed cause; the fix deletes the prefix and keeps the row as a guard. Run: npm test -- "[map FAILING] order"
const THREADS = '/tests/threads/';
const show = r => JSON.stringify(r).slice(0, 900);

export const specs = [
  {
    name: '[guard] order flow music: the title track plays after quit whichever module was installed first',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, out = {};
        for (const order of ['flowFirst', 'musicFirst']) {
          const E = threedogThreads.mk(T.createEngine, 'map-order-' + order, {});
          const mods = [T.flow({ start: 'title' }), T.music({ tracks: { t: '/t.ogg' } })];
          E.use(...(order === 'flowFirst' ? mods : mods.reverse()));
          E.flow.define('title', { music: 't' });
          await E.start();
          const boot = E.music.current;
          E.flow.go('playing');
          await E.session.quit();
          out[order] = { boot, state: E.flow.state, current: E.music.current };
          E.dispose();
        }
        return out;
      });
      check('both orders reached the title state with its track at boot', r.flowFirst.boot === 't' && r.musicFirst.boot === 't', show(r));
      check('music first: the title track is back after quit', r.musicFirst.current === 't', show(r));
      check('flow first: the title track is back after quit too', r.flowFirst.current === 't', show(r));
    },
  },
  {
    name: '[guard] order audio state: a new game does not inherit the mode the last playthrough left in audio.state',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'map-audio-state', {});
        E.use(T.music({ tracks: { calm: '/c.ogg', fight: '/f.ogg' }, rules: [{ track: 'fight', when: { state: 'combat' } }, { track: 'calm' }] }));
        await E.start();
        const first = E.audio.state;
        E.audio.state = 'combat';
        await E.session.newGame();
        const out = { first, state: E.audio.state, track: E.music.current };
        E.dispose();
        return out;
      });
      check('the page opens with no mode', r.first === null, show(r));
      check('a new game starts with no mode, like the page did', r.state === null, show(r));
      check('so the new game does not start on the old run\'s combat track', r.track === 'calm', show(r));
    },
  },
  {
    name: '[guard] order failed load physics: a load that rolled back leaves rigid bodies moving as they were',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE, quiet = console.error;
        console.error = () => {};
        const E = threedogThreads.mk(T.createEngine, 'map-rigid-rollback', {});
        E.use(T.world(), T.collision(), T.rigid());
        await E.start();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); mesh.position.set(0, 3, 0); E.add(mesh);
        const crate = E.ops.allow(() => E.rigid.addBox(mesh, { id: 'crate', size: [1, 1, 1] }));
        let armed = false;
        E.saves.define('mapBad', { save: () => 1, load() { if (armed) { armed = false; throw new Error('a part that cannot load'); } } });
        for (let i = 0; i < 60; i++) E.step(1 / 60, { render: false, describe: false });
        E.saves.save('s'); await E.saves.flush();
        crate.body.setLinvel({ x: 7, y: 0, z: 0 }, true);
        const before = crate.body.linvel().x;
        armed = true;
        const ok = await E.session.load('s');
        const out = { ok, before, after: crate.body.linvel().x, awake: !crate.body.isSleeping() };
        E.dispose(); console.error = quiet;
        return out;
      });
      check('the load was refused by the bad part', r.ok === false, show(r));
      check('the crate was moving before the load', r.before === 7, show(r));
      check('the crate moves as before: "a refused load leaves the game as it was, physics included"', r.after === 7, show(r));
    },
  },
  {
    name: '[guard] order vehicle camera: session.load keeps the view the save had, the driver\'s vehicle camera and a yaw on a switched rig',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE, quiet = [console.warn, console.error], out = {};
        console.warn = console.error = () => {};
        const steps = (E, n) => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const E = threedogThreads.mk(T.createEngine, 'map-car-cam', {});
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.rigid(), T.followCamera({ distance: 6 }));
        await E.start();
        const P = E.characters.addPlayer({ control: 'camera', cameraFollow: true, spawn: { x: 0, z: 0 } });
        const wheels = [[-1, 0, 1.5], [1, 0, 1.5], [-1, 0, -1.5], [1, 0, -1.5]].map(position => ({ position, radius: 0.35 }));
        const car = E.ops.allow(() => E.rigid.addWheeled(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4)), { id: 'map-car', wheels, camera: { distance: 12 } }));
        E.ops.allow(() => P.enter(car)); steps(E, 3);
        out.seated = { car: E.cameraRig.target === car.object, distance: E.cameraRig.distance };
        E.saves.save('s'); await E.saves.flush();
        out.ok = await E.session.load('s'); steps(E, 3);
        out.loaded = { inCar: E.player.vehicle === car, car: E.cameraRig.target === car.object, onPlayer: E.cameraRig.target === E.player.root, distance: E.cameraRig.distance };
        E.dispose();
        const F = threedogThreads.mk(T.createEngine, 'map-rig-yaw', {});
        F.use(T.followCamera({ distance: 6 }));
        await F.start();
        F.setCamera('follow', { distance: 5 });
        F.cameraRig.yaw = 1.2;
        F.saves.save('y'); await F.saves.flush();
        F.cameraRig.yaw = -2;
        out.yawOk = await F.session.load('y');
        out.yaw = F.cameraRig.yaw;
        F.dispose();
        [console.warn, console.error] = quiet;
        return out;
      });
      check('the rig followed the car with its own camera before the save', r.seated.car && r.seated.distance === 12, show(r));
      check('the player is back in the car after the load', r.ok && r.loaded.inCar, show(r));
      check('the rig follows the car after the load', r.loaded.car, show(r));
      check('the vehicle camera distance is back', r.loaded.distance === 12, show(r));
      check('the view saved on a rig switched at runtime comes back', r.yawOk && r.yaw === 1.2, show(r));
    },
  },
  {
    name: '[guard] order ground change: the rigid mirror of a box without y follows the ground',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, quiet = console.warn;
        console.warn = () => {};
        const E = threedogThreads.mk(T.createEngine, 'map-ground', {});
        E.use(T.terrain({ height: () => 0, viewChunks: 2 }), T.collision(), T.rigid());
        await E.start();
        const settle = async n => { for (let i = 0; i < n; i++) { E.step(1 / 30, { render: false, describe: false }); await new Promise(s => setTimeout(s, 0)); } };
        E.collision.addBox([2, 0, 2], { halfWidth: 1, halfDepth: 1, height: 2 });
        await settle(30);
        const out = { first: E.rigid.overlap([2, 1, 2]) };
        E.ops.allow(() => E.terrain.edit({ x: 2, z: 2 }, { shape: 'square', radius: 12, flatten: 10 }));
        await settle(40);
        const g = E.surface(2, 2);
        // control: a box added now is mirrored at that same height, so a false above means the old box was left behind, not that the query cannot see up there
        E.collision.addBox([-2, 0, -2], { halfWidth: 1, halfDepth: 1, height: 2 });
        await settle(30);
        Object.assign(out, { g, onGround: E.rigid.overlap([2, g + 1, 2]), beside: E.rigid.overlap([7, g + 1, 7]), late: E.rigid.overlap([-2, g + 1, -2]) });
        E.dispose(); console.warn = quiet;
        return out;
      });
      check('the box stood on the ground first', r.first === true, show(r));
      check('the ground really rose', Math.abs(r.g - 10) < 0.01, show(r));
      check('the air beside the box is clear', r.beside === false, show(r));
      check('a box added after the edit stands on the new ground', r.late === true, show(r));
      check('the box stands on the new ground', r.onGround === true, show(r));
    },
  },
  {
    name: '[guard] order settings load: a save loaded from the settings opened over the title starts the game',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'map-title-load', { ui: { loading: false, title: { title: 'T' } } });
        E.use(T.settings({ sections: ['game'], storageKey: 'map-title-load' }));
        await E.start();
        await E.session.newGame(); E.ui.close('title');
        E.saves.save('s'); await E.saves.flush();
        await E.session.quit();
        const out = { title0: E.ui.isOpen('title') };
        let started = false; E.events.on('session:start', () => { started = true; });
        E.settings.open();
        const btn = E.uiRoot.querySelector('[data-game=load]');
        out.button = !!btn;
        btn?.click();
        for (let i = 0; i < 100 && !started; i++) await new Promise(s => setTimeout(s, 10));
        await new Promise(s => setTimeout(s, 20));
        Object.assign(out, { started, title: E.ui.isOpen('title'), frozen: E.frozen, playing: E.session.playing });
        E.dispose();
        return out;
      });
      check('the title was up with a load button in its settings', r.title0 && r.button, show(r));
      check('the load ran', r.started, show(r));
      check('the title closed', r.title === false, show(r));
      check('the game runs', r.frozen === false && r.playing === true, show(r));
    },
  },
  {
    name: '[guard] order failed load markers: a load that rolled back keeps the quest markers of the old playthrough',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, quiet = console.error;
        console.error = () => {};
        const E = threedogThreads.mk(T.createEngine, 'map-hud-rollback', {});
        E.use(T.world(), T.quests(), T.hud());
        await E.start();
        E.quests.define('q', { title: 'Q', steps: [{ text: 'go', target: { x: 3, y: 0, z: 4 }, done: () => false }] });
        E.quests.start('q');
        let armed = false;
        E.saves.define('mapBad', { save: () => 1, load() { if (armed) { armed = false; throw new Error('a part that cannot load'); } } });
        E.step(1 / 60);
        E.saves.save('s'); await E.saves.flush();
        const before = E.hud.markers.length;
        armed = true;
        const ok = await E.session.load('s');
        E.step(1 / 60);
        const out = { ok, before, after: E.hud.markers.length, quests: E.quests.list().map(q => q.id) };
        E.dispose(); console.error = quiet;
        return out;
      });
      check('the load was refused', r.ok === false, show(r));
      check('the quest showed a marker', r.before === 1, show(r));
      check('the quest is still running', r.quests.includes('q'), show(r));
      check('its marker is still there', r.after === 1, show(r));
    },
  },
  {
    name: '[guard] order overlapping skip: a second skip neither joins nor ends the first one\'s freeze',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'map-skip', {});
        await E.start();
        const t0 = E.clock.now;
        let done = false;
        const a = E.skip({ seconds: 60, fade: 0.2 }); a.then(() => { done = true; });
        const frozen0 = E.frozen;
        let second = 'resolved';
        try { await E.skip({ seconds: 10 }); } catch { second = 'rejected'; }
        const frozen1 = E.frozen;
        for (let i = 0; i < 200 && !done; i++) { E.step(1 / 30); await new Promise(s => setTimeout(s, 0)); }
        const out = { frozen0, second, frozen1, done, frozenEnd: E.frozen, moved: E.clock.now - t0 };
        E.dispose();
        return out;
      });
      check('the first skip froze the game', r.frozen0 === true, show(r));
      check('the first skip finished', r.done === true, show(r));
      check('the game stays frozen while the first skip is still fading, or the second was refused as its doc says', r.frozen1 === true || r.second === 'rejected', show(r));
      check('the doc: a skip already under way rejects', r.second === 'rejected', show(r));
      check('the game runs again after the first one ended', r.frozenEnd === false, show(r));
    },
  },
  {
    name: '[guard] order pinned release: release keeps a load pinned by geometry()',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE;
        const E = threedogThreads.mk(T.createEngine, 'map-pin', {});
        await E.start();
        const g = new THREE.BoxGeometry(1, 1, 1);
        let freed = 0; g.addEventListener('dispose', () => freed++);
        E.assets.manifest({ models: { rock: { build: async () => new THREE.Mesh(g, new THREE.MeshBasicMaterial()) } } });
        const got = await E.assets.geometry('rock');
        const shown = new THREE.Mesh(got, new THREE.MeshBasicMaterial()); E.scene.add(shown);
        const trim = E.assets.trim(), afterTrim = freed;
        E.assets.release('rock');
        const out = { same: got === g, trim, afterTrim, afterRelease: freed };
        E.dispose();
        return out;
      });
      check('geometry() handed out the model\'s geometry', r.same, show(r));
      check('trim respects the pin', r.afterTrim === 0, show(r));
      check('release respects the pin as well', r.afterRelease === 0, show(r));
    },
  },
];
