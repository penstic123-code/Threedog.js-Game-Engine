// [layer FAILING] Conflicts from the layer inventory (docs/testing/review/2026-11-07-1.0-audit/layer-inventory.md): two mechanisms for one idea that disagree, shown through
// the public API. Red on purpose while the conflict stands, like [map FAILING]; a fix renames the row. Each row has a control that passes today, so a red row means
// the conflict and not a broken setup.
const THREADS = '/tests/threads/';
const show = o => JSON.stringify(o);

export const specs = [
  {
    // Refresh family: level (level/index.js:172) and nav (nav/index.js:278) sync on fixed + frame + skip, because "a frozen engine runs no fixed step, and rays and paths
    // still ask". rigid has the same collision mirror (rigid/sync.js:136) and syncs in step() only (RigidBodies.js:434), so one wall is in two copies of the world and not the third.
    name: '[guard] refresh: a wall added while frozen reaches rigid queries, as it reaches walking collision',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'layer-frozen-wall', {});
        E.use(T.collision(), T.rigid());
        await E.start();
        const ask = x => E.collider3d.overlap([x, 2, 0], 0.5);
        // control: on a running engine the next fixed step brings the wall in
        E.collision.addBox([0, 0, 0], { halfWidth: 1, halfDepth: 1, height: 6 });
        E.step(1 / 60);
        const running = ask(0);
        const hold = E.freeze('menu');
        E.collision.addBox([10, 0, 0], { halfWidth: 1, halfDepth: 1, height: 6 });
        for (let i = 0; i < 5; i++) E.step(1 / 60);
        const walks = E.collision.resolve ? E.collision.resolve(10, 0, 0.3).x !== 10 || E.collision.resolve(10, 0, 0.3).z !== 0 : null;
        const frozen = ask(10);
        hold.remove();
        E.dispose();
        return { running, walks, frozen };
      });
      check('control: a wall reaches rigid on a running engine', r.running === true, show(r));
      check('control: walking collision sees the wall while frozen', r.walks === true, show(r));
      check('collider3d queries see the same wall while frozen', r.frozen === true, show(r));
    },
  },
  {
    // Event family: calendar/index.js:40 re-checks between() ranges on engine:ready, save:loaded and state:applied, the moments "anything moves the clock without stepping".
    // A new game moves it too, and announces itself with session:start, so the range keeps saying inside. Each door into one state replacement has its own word.
    name: '[guard] events: a calendar range hears a new game as it hears a load',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'layer-range', {});
        E.use(T.calendar({ time: '08:00', dayLength: 600 }));
        await E.start();
        const log = [];
        E.calendar.between('12:00', '14:00', { on: () => log.push('on'), off: () => log.push('off') });
        await E.saves.save('early');
        await E.skip({ to: '13:00' });
        const at13 = [...log];
        await E.saves.load('early');
        const afterLoad = [...log];
        await E.skip({ to: '13:00' });
        const before = log.length;
        await E.session.newGame();
        const out = { at13, afterLoad, hour: E.calendar.timeOfDay, afterNew: log.slice(before) };
        E.dispose();
        return out;
      });
      check('control: entering the range says on', r.at13.includes('on'), show(r));
      check('control: a load back before the range says off', r.afterLoad.at(-1) === 'off', show(r));
      check('a new game back before the range says off too', r.afterNew.at(-1) === 'off', show(r));
    },
  },
  {
    // View family: the slider is the base view (setFov). A fixed rig used to write the fov it first saw on every frame, so on a shot with no fov of its own the slider did nothing
    name: '[guard] view: the fov slider works on a fixed camera, and waits under a shot with a fov of its own',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, out = {};
        const E = threedogThreads.mk(T.createEngine, 'layer-fov', {});
        E.use(T.world(), T.fixedCamera({ start: 'plain', shots: { plain: { position: [0, 5, 5], lookAt: [0, 0, 0] }, wide: { position: [1, 5, 5], lookAt: [0, 0, 0], fov: 30 } } }), T.settings({ sections: ['camera'] }));
        await E.start();
        const go = () => { for (let i = 0; i < 3; i++) E.step(1 / 60); return E.camera.fov; };
        go(); E.settings.set('camera.fov', 70); out.plain = go();
        E.cameraRig.cut('wide'); out.shot = go();
        E.settings.set('camera.fov', 80); out.under = go();
        E.cameraRig.cut('plain'); out.back = go();
        E.cameraRig.cut('wide'); go(); E.setCamera('rts'); out.left = go();
        E.dispose();
        return out;
      });
      check('the slider reaches a shot with no fov', r.plain === 70, show(r));
      check('a shot with a fov shows it, and keeps it while the slider moves', r.shot === 30 && r.under === 30, show(r));
      check('the slider\'s value comes back with the next shot', r.back === 80, show(r));
      check('a rig that leaves takes its shot\'s fov along', r.left !== 30, show(r));
    },
  },
  {
    // Contract family: characters is a replaceable slot. What world asks of a live character is characters/character.contract.js, the stand-in here gives exactly that list
    // (tests/contract/fakeCharacter.js, run by the tools test contracts), and R50 fails any call outside it, through a local too.
    name: '[guard] contract: world.move works on a character from a provider that keeps the written contract',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, { THREE } = threedogThreads, out = {};
        const E = threedogThreads.mk(T.createEngine, 'layer-contract', {});
        const hero = threedogThreads.fakeCharacter({ root: new THREE.Object3D() });
        const was = [console.error, console.warn]; console.error = console.warn = () => {};
        E.use(T.world(), { name: 'myCharacters', type: 'world', provides: ['characters'], install(e) { e.control.resolveWith(id => (id === 'hero' ? hero : null)); } });
        await E.start();
        E.world.add({ id: 'hero', kind: 'thing', position: [0, 0, 0] }); E.world.add({ id: 'rock', kind: 'thing', position: [0, 0, 0] }); E.world.move('rock', [1, 0, 0]); out.rock = E.world.get('rock')?.position?.x;
        try { E.world.move('hero', [3, 0, 0]); } catch (x) { out.threw = String(x.message).slice(0, 160); }
        E.world.set('hero', { rot: 1 }); out.pose = hero.pose.rot;
        out.hero = hero.root.position.x; out.err = E.error?.message?.slice(0, 160) ?? null;
        [console.error, console.warn] = was;
        E.dispose();
        // the same list holds for the engine's own character: a member added to the contract, or dropped from Character, fails here
        const c = threedogThreads.characterContract, R = threedogThreads.mk(T.createEngine, 'layer-contract-real', {}); R.use(T.world(), T.characters()); await R.start();
        const P = R.ops.allow(() => R.characters.addPlayer({ control: () => null }));
        out.gaps = [...c.api.filter(m => typeof P[m] !== 'function'), ...c.fields.filter(f => !(f in P))]; R.dispose();
        return out;
      });
      check('the engine\'s character gives every member of its contract', r.gaps.length === 0, show(r));
      check('control: world.move works on a plain record', r.rock === 1, show(r));
      check('world.move placed the character', !r.threw && !r.err && r.hero === 3, show(r));
      check('world.set gave it the pose', r.pose === 1, show(r));
    },
  },
];
