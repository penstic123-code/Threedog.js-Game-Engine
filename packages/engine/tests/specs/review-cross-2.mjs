// [review] Second batch of cross-module probes of the 1.0 whole-system review: camera views, riders and swaps, walks across a level switch, dispose during start.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Orthographic rig: the fov slider, a rig module leaving, a session and post',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, THREE, all: T, bloom } = threedogThreads;
        const quiet = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 200));
        const E = mk(createEngine, 'rv-cam');
        E.use(world(), T.followCamera({ distance: 8 }), T.settings({ sections: ['camera'] }));
        await E.start(); E.step(1 / 60);
        const out = {}, home = E.camera;
        out.fov0 = home.fov;
        E.setCamera('follow', { projection: 'orthographic', size: 14 }); E.step(1 / 60);
        out.ortho = E.camera.isOrthographicCamera;
        try { E.settings.set('camera.fov', 80); } catch (x) { out.setErr = x.message; }
        out.setting = E.settings.get('camera.fov');
        E.setCamera('follow', { projection: 'perspective' }); E.step(1 / 60);
        out.back = { same: E.camera === home, fov: E.camera.fov, setting: E.settings.get('camera.fov') };
        // the rig module leaves while the view is orthographic
        E.setCamera('follow', { projection: 'orthographic', size: 14 }); E.step(1 / 60);
        E.unuse('cameraRig'); E.step(1 / 60);
        out.left = { ortho: !!E.camera.isOrthographicCamera, same: E.camera === home };
        out.said = said.slice(0, 3);
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('a fov set while orthographic is the fov of the perspective view that comes back', r.back?.fov === 80, J(r));
      check('the slider and the camera agree afterwards', r.back?.fov === r.back?.setting, J(r));
      check('the rig that made the view orthographic takes it along when it leaves', r.left?.ortho === false, J(r));
    },
  },
  {
    name: '[guard] A driver when rigid is replaced gets out and stays a sound character',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE, all: T } = threedogThreads;
        const quiet = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 200));
        const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g);
        const E = mk(createEngine, 'rv-ride');
        E.use(world(), collision(), characters(), level({ scene: s }), T.rigid());
        await E.start();
        const p = E.characters.addPlayer({ control: 'camera' });
        const wheels = [[-1, 0, 1.5], [1, 0, 1.5], [-1, 0, -1.5], [1, 0, -1.5]].map(position => ({ position, radius: 0.35 }));
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial()); mesh.position.set(3, 1, 3); E.scene.add(mesh);
        const out = {};
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        let car;
        try { E.ops.allow(() => { car = E.rigid.addWheeled(mesh, { id: 'rv-car', wheels }); }); } catch (x) { out.addErr = x.message; }
        let exits = 0; E.events.on('vehicle:exit', () => exits++);
        step(5); p.enter(car); step(5);
        out.seated = p.vehicle === car;
        try { E.use(T.rigid(), { replaces: 'rigid' }); step(10); } catch (x) { out.swapErr = x.message; }
        out.afterSwap = { inOld: p.vehicle === car, err: E.error?.message ?? null, cars: E.rigid.vehicles?.length ?? null };
        out.sound = { seat: p.seat, state: p.state, visible: p.root.visible, gone: car.gone === true, ctx: !!p._driveCtx, exits };
        E.ops.allow(() => p.placeAt({ x: 0, y: 0, z: 0 })); step(3); out.walks = { err: E.error?.message ?? null, state: p.state };
        out.said = said.slice(0, 3);
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('seated', r.seated, J(r));
      check('rigid replaced under a driver: the game keeps running', !r.swapErr && !r.afterSwap?.err, J(r));
      check('... and the driver is not seated in a car of a freed solver', !r.afterSwap?.inOld, J(r));
      check('... out the normal way: told once, seat, input context and model back, the car marked gone', r.sound?.exits === 1 && r.sound.seat === null && r.sound.state === 'idle' && r.sound.visible && r.sound.gone && !r.sound.ctx, J(r));
      check('... and the character goes on on foot', !r.walks?.err, J(r));
    },
  },
  {
    name: '[guard] A walk across a level switch and a collision swap ends or follows the new level',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
        const quiet = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 200));
        const flat = (w, wallX) => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, w), new THREE.MeshBasicMaterial()); m.name = 'ground'; m.position.y = -0.1; s.add(m); if (wallX != null) { const c = new THREE.Mesh(new THREE.BoxGeometry(1, 3, w), new THREE.MeshBasicMaterial()); c.name = 'col_w'; c.position.set(wallX, 1.5, 0); s.add(c); } return s; };
        const E = mk(createEngine, 'rv-walk');
        E.use(world(), collision(), characters(), level({ scene: flat(60) }), nav({ agentRadius: 0.4 }));
        await E.start();
        for (let i = 0; i < 20 && !E.nav.ready; i++) { await new Promise(s => setTimeout(s, 30)); E.step(1 / 60); }
        const p = E.characters.addPlayer({ control: 'camera' });
        const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60); };
        const out = {};
        let end = null;
        E.ops.allow(() => { p.placeAt({ x: -20, y: 0, z: 0 }); });
        const w = p.walkTo ? p.walkTo({ x: 20, z: 0 }) : E.characters.walkTo(p, { x: 20, z: 0 }); w.then(v => { end = v.status; });
        step(30);
        out.x0 = +p.root.position.x.toFixed(1);
        await E.level.load(flat(60, 0));   // a wall right across the way, the whole width
        for (let i = 0; i < 5; i++) { await new Promise(s => setTimeout(s, 10)); step(1); }
        step(600); await new Promise(s => setTimeout(s, 10));
        out.x1 = +p.root.position.x.toFixed(1); out.end = end;
        out.err = E.error?.message ?? null; out.said = said.slice(0, 3);
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('the walker never crosses the new wall', r.x1 < 0, J(r));
      check('the walk ends with a status', !!r.end, J(r));
      check('no error', !r.err, J(r));
    },
  },
  {
    name: '[guard] Pad seats: a seat bound to a pad hears it on any engine of the page, the owner leaves it alone; dispose during start lands nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
        const quiet = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 200));
        const rej = []; const onRej = x => { rej.push(String(x.reason?.message ?? x.reason).slice(0, 200)); x.preventDefault(); }; addEventListener('unhandledrejection', onRej);
        const flat = () => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(20, 0.2, 20), new THREE.MeshBasicMaterial()); m.name = 'ground'; s.add(m); return s; };
        const out = {};
        const A = mk(createEngine, 'rv-dsp');
        A.use(world(), collision(), characters(), level({ scene: flat() }), nav());
        const started = A.start().catch(x => { out.startErr = x.message; });
        await Promise.resolve();
        A.dispose();
        await started; await new Promise(s => setTimeout(s, 300));
        out.navLeft = { ready: A.nav?.ready ?? null, mesh: !!A.nav?.navMesh };
        // pad: two engines, the first owns, the second has a seat on pad 0
        const pads = [{ connected: true, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 0 })), axes: [0, 0, 0, 0] }];
        const real = navigator.getGamepads; navigator.getGamepads = () => pads;
        const B = mk(createEngine, 'rv-pb'), C = mk(createEngine, 'rv-pc');
        await B.start(); await C.start();
        const seat = C.input.seat({ pad: 0 });
        C.input.poll(1 / 60); B.input.poll(1 / 60);
        out.seatHearsPadWhenNotOwner = C.input.keys.has('PadA@0');
        engine.input.poll(1 / 60); out.ownerReadsBoundPad = engine.input.keys.has('PadA');
        const own = engine.input.seat({ pad: 0 }); engine.input.poll(1 / 60); out.seatOnOwner = engine.input.keys.has('PadA@0'); own.remove();
        B.dispose();
        C.input.poll(1 / 60);
        out.seatAfterOwnerLeft = C.input.keys.has('PadA@0');
        seat.remove();
        navigator.getGamepads = real;
        C.dispose();
        removeEventListener('unhandledrejection', onRej);
        out.rej = rej; out.said = said.slice(0, 4);
        [console.error, console.warn] = quiet;
        return out;
      });
      check('no unhandled rejection after dispose', !r.rej.length, J(r));
      check('no navmesh built on a disposed engine', !r.navLeft.mesh && !r.navLeft.ready, J(r));
      check('a seat with its own pad hears it even on the engine that does not own the keyboard', r.seatHearsPadWhenNotOwner, J(r));
      check('control: a seat on the engine that owns the page hears the pad', r.seatOnOwner, J(r));
      check('the owner leaves a pad bound on another engine alone', r.ownerReadsBoundPad === false, J(r));
    },
  },
];
