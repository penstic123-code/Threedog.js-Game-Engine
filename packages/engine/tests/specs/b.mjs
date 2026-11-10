// Batch-3 group B specs (same format as the other files here): vehicle, character controller, navmesh, animation state machine, camera override warning.
export const specs = [
  {
    name: 'Vehicle (Rapier vehicle controller)',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const car = window.car;
        engine.step(3);
        const y = car.object.position.y, z0 = car.object.position.z, x0 = car.object.position.x;
        car.drive(1, 0, 0); engine.step(3);
        const fwd = car.object.position.z - z0, side = Math.abs(car.object.position.x - x0), speed = car.speed;
        car.drive(0, 0, 1); engine.step(3);
        return { y, fwd, side, speed, stopped: Math.abs(car.speed) < 0.5, native: !!car.controller && !!car.body };
      });
      check('car rests on the ground (y > 0)', r.y > 0, r.y);
      check('throttle for 3 s moves it more than 5 m forward (nose is +Z)', r.fwd > 5 && r.side < 1, JSON.stringify(r));
      check('speed is positive and the car stops after braking', r.speed > 1 && r.stopped, JSON.stringify(r));
      check('exposes native objects controller / body', r.native);

      const t = await ev(() => {
        const p = engine.player, car = window.car;
        const before = p.position.distanceTo(car.object.position);
        p.placeAt({ x: car.object.position.x + 2.5, z: car.object.position.z });
        engine.step(0.1);
        const prompt = engine.interactions.current?.object === car.object;
        p.enter(car);
        engine.step(0.1);
        const inCar = { state: p.state, cam: engine.cameraRig.target === car.object, dist: engine.cameraRig.distance, hidden: !p.root.visible,
          desc: engine.describe().player.vehicle, seat: p.position.distanceTo(car.seatPosition()) };
        engine.input.autopilot = { x: 0.6, y: 1 };    // driving: autopilot stands in for the arrow keys
        const z0 = car.object.position.z, x0 = car.object.position.x; engine.step(2);
        const steered = { dz: car.object.position.z - z0, dx: car.object.position.x - x0 };
        engine.input.autopilot = null;
        engine.step(2);
        p.exit(); engine.step(0.1);
        return { before, prompt, inCar, steered, out: { state: p.state, cam: engine.cameraRig.target === p.root, dist: engine.cameraRig.distance, visible: p.root.visible, driver: car.driver } };
      });
      check('an enter-vehicle interaction appears next to the car', t.prompt);
      check('after enter: camera follows the car, state is drive, character is hidden', t.inCar.state === 'drive' && t.inCar.cam && t.inCar.hidden && t.inCar.dist === 16, JSON.stringify(t.inCar));
      check('while driving the player sits at the seat position and describe reports vehicle speed', t.inCar.seat < 0.5 && t.inCar.desc && 'speed' in t.inCar.desc, JSON.stringify(t.inCar));
      check('driving: moves forward and turns right (right = -X)', t.steered.dz > 1 && t.steered.dx < -0.2, JSON.stringify(t.steered));
      check('after exit: camera returns to the character, distance restored, character visible', t.out.state === 'idle' && t.out.cam && t.out.dist === 13 && t.out.visible && !t.out.driver, JSON.stringify(t.out));
    },
  },
  {
    name: 'Character controller mover: rapier (steps)',
    url: '/tests/vehicle/index.html?mover=rapier',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player;
        engine.cameraRig.yaw = -Math.PI / 2;            // camera forward = +X
        const walk = (x, z) => { p.placeAt({ x, z }); p.velocity.set(0, 0); engine.step(0.2); engine.input.autopilot = { x: 0, y: 1, speed: 3 }; engine.step(2.5); engine.input.autopilot = null; return { x: p.position.x, y: p.position.y }; };
        return { name: p.mover.name, ctl: !!p.mover.controller, low: walk(2, 0), high: walk(2, 10) };
      });
      check('player uses the rapier mover and exposes mover.controller', r.name === 'rapier' && r.ctl, JSON.stringify(r));
      check('can walk up a 0.4 m step', r.low.y > 0.35 && r.low.x > 6.5, JSON.stringify(r.low));
      check('cannot climb a 1 m step', r.high.y < 0.1 && r.high.x < 6.2, JSON.stringify(r.high));
      const j = await ev(() => {
        const p = engine.player; p.placeAt({ x: 0, z: -6 }); engine.step(0.3);
        const y0 = p.position.y; p.jump(); let top = y0;
        for (let i = 0; i < 30; i++) { engine.step(1 / 30); top = Math.max(top, p.position.y); }
        engine.step(1);
        return { up: top - y0, grounded: p.grounded };
      });
      check('rapier mover can jump and land', j.up > 1 && j.grounded, JSON.stringify(j));
    },
  },
  {
    name: 'Mover simple (default) and steps',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player;
        engine.cameraRig.yaw = -Math.PI / 2;
        const walk = (x, z) => { p.placeAt({ x, z }); engine.step(0.2); engine.input.autopilot = { x: 0, y: 1, speed: 3 }; engine.step(2.5); engine.input.autopilot = null; return { x: p.position.x, y: p.position.y }; };
        return { name: p.mover.name, low: walk(2, 0), high: walk(2, 10) };
      });
      check('default mover is simple', r.name === 'simple');
      check('simple: climbs a 0.4 m step, not a 1 m one', r.low.y > 0.35 && r.high.y < 0.1 && r.high.x < 6.2, JSON.stringify(r));
    },
  },
  {
    name: 'Animation state machine Animator',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const model = window.makeRig(); engine.add(model);
        const anim = engine.assets.animate(model, {
          states: { idle: { clip: 'Idle' }, walk: { clip: 'Walk' }, move: { blend: [{ clip: 'Walk', at: 1.5 }, { clip: 'Run', at: 6 }] }, wave: { clip: 'Wave', loop: false, then: 'idle', lock: true } },
        });
        const w = n => anim.actions.get(n)?.getEffectiveWeight() ?? 0;
        anim.go('idle'); engine.step(0.1);
        anim.go('walk'); engine.step(0.1);
        const mid = { idle: w('Idle'), walk: w('Walk') };
        engine.step(0.2);
        const after = { idle: w('Idle'), walk: w('Walk'), sum: w('Idle') + w('Walk') };
        anim.set('speed', 3); anim.go('move'); engine.step(0.4);
        const blend = { walk: w('Walk'), run: w('Run'), sum: w('Walk') + w('Run') };
        const ends = []; const sub = engine.events.on('anim:end', d => ends.push(d.state));
        anim.action('wave'); engine.step(0.1);
        const blocked = (anim.go('idle'), anim.state);
        engine.step(1.2);
        sub.remove();
        const back = anim.state;
        return { mid, after, blend, blocked, back, ends };
      });
      check('go(walk): both actions have weight mid-transition', r.mid.idle > 0 && r.mid.walk > 0, JSON.stringify(r.mid));
      check('go(walk): after 0.25 s weights sum to 1 and only walk remains', Math.abs(r.after.sum - 1) < 1e-6 && r.after.walk > 0.999, JSON.stringify(r.after));
      check('blend tree at speed=3: Walk and Run both have weight', r.blend.walk > 0 && r.blend.run > 0 && Math.abs(r.blend.sum - 1) < 1e-6, JSON.stringify(r.blend));
      check('one-shot action with lock: go() does not interrupt it while playing', r.blocked === 'wave');
      check('a one-shot action emits anim:end when done and returns to then', r.back === 'idle' && r.ends.includes('wave'), JSON.stringify(r));
      const c = await ev(() => {
        const p = engine.characters.addPlayer({ control: 'camera', cameraFollow: true, spawn: { x: 0, z: 4 }, model: window.makeRig(), clips: { walk: 'Walk', run: 'Run' } });
        engine.step(0.5);
        const idle = p.anim.state;
        p.playAction('Wave'); engine.step(0.1);
        const acting = p.anim.state;
        engine.step(1.5);
        return { idle, acting, back: p.anim.state };
      });
      check('character with model: idle, playAction, back to the previous state', c.idle === 'idle' && c.acting === 'Wave' && c.back === 'idle', JSON.stringify(c));
    },
  },
  {
    name: 'Navmesh (Recast)',
    url: '/tests/nav/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const len = p => p ? p.reduce((s, q, i) => i ? s + Math.hypot(q.x - p[i - 1].x, q.z - p[i - 1].z) : 0, 0) : 0;
        const path = engine.characters.findPath({ x: 4, z: -5 }, { x: 4, z: 5 });
        const native = !!(engine.nav.navMesh && engine.nav.query && engine.nav.tileCache && engine.nav.helper) && engine.nav.crowd === null;
        // block the right-hand gap
        const wall = engine.collision.addBox({ x: 16, z: 0 }, { halfWidth: 4.5, halfDepth: 1, height: 3 });
        engine.step(0.1);
        const blocked = engine.characters.findPath({ x: 4, z: -5 }, { x: 4, z: 5 });
        wall.remove(); engine.step(0.1);
        const reopened = engine.characters.findPath({ x: 4, z: -5 }, { x: 4, z: 5 });
        return { ready: engine.nav.ready, native, path, len: len(path), blocked, reopenedMaxX: reopened && Math.max(...reopened.map(q => q.x)) };
      });
      check('navmesh is built and exposes native objects', r.ready && r.native, JSON.stringify(r));
      check('around the wall: path goes through the right-hand gap', r.path && r.len > 20 && Math.max(...r.path.map(q => q.x)) > 12, JSON.stringify(r.path));
      check('after collision.addBox blocks the right gap the path goes left', r.blocked && Math.min(...r.blocked.map(q => q.x)) < -12, JSON.stringify(r.blocked));
      check('after the obstacle is removed the path goes right again', r.reopenedMaxX > 12, r.reopenedMaxX);
      const n = await ev(() => {
        const npc = engine.npcs.get('信使');
        engine.step(30);
        return { d: Math.hypot(npc.position.x - 4, npc.position.z - 5), side: npc.position.z };
      });
      check('NPC paths through the shared entry point and reaches its schedule spot around the wall within 30 s', n.d < 1.5, JSON.stringify(n));
      const a = await ev(() => {
        engine.nav.dispose();
        const p = engine.characters.findPath({ x: 4, z: -5 }, { x: 4, z: 5 });
        return { ready: engine.nav.ready, ok: !!p && p.length > 1 };
      });
      check('after disposing the navmesh it falls back to A* and still finds a path', !a.ready && a.ok, JSON.stringify(a));
    },
  },
  {
    name: '[guard] Camera: a direct camera.position edit takes the camera (the rig stops, one warning), engine.autoView.manual hands it back',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const during = await __t.warns(() => {
          engine.haltLoop(); engine.step(0.1);
          globalThis.__cam = engine.takeCamera('test'); engine.camera.position.x += 5; engine.step(0.1); globalThis.__cam?.remove(); engine.step(0.1);
        });
        let x = 0, by = '';
        const after = await __t.warns(() => {
          engine.camera.position.x += 5; engine.step(0.1); engine.camera.position.x += 5; x = engine.camera.position.x; engine.step(0.1);
          by = engine.describe().owned.camera.writer; globalThis.__holder = engine.cameraOverride?.owner;
        });
        const stays = engine.camera.position.x === x;
        engine.autoView.manual('camera', false); engine.step(0.1);
        const m = engine.autoView.manual('camera'); const mHolder = engine.cameraOverride?.owner; m.remove(); const freed = engine.cameraOverride;
        const w = [...during.warns, ...after.warns].filter(w => w.includes('camera was changed outside'));
        return { clean: during.warns.length, n: w.length, takeover: w.every(t => t.includes("engine.takeCamera('me')") && !t.includes("engine.autoView.manual('camera')")), stays, by,
          back: engine.describe().owned.camera.writer, moved: engine.camera.position.x !== x, holder: globalThis.__holder, mHolder, freed };
      });
      check('no warning when the camera is edited during an override', r.clean === 0, JSON.stringify(r));
      check('direct camera.position edit: exactly 1 warning, the rig stops (the value stays), describe().owned says so', r.n === 1 && r.stays && /yielded/.test(r.by), JSON.stringify(r));
      // the warning's takeover is the one canonical form, takeCamera (the hand-back for the yielded camera stays engine.autoView.manual('camera', false))
      check("the warning names engine.takeCamera('me') as the takeover", r.takeover, JSON.stringify(r));
      check('engine.autoView.manual(camera, false) hands it back: the rig places the camera again', r.back === 'engine' && r.moved, JSON.stringify(r));
      // guard: one camera state. A direct write and engine.autoView.manual are takeCamera holds (cameraOverride names them); remove() frees the camera
      check('[guard] direct write / engine.autoView.manual(camera) show as the camera holder; hand-back clears it', r.holder === 'three' && r.mHolder === 'manual:game' && r.freed === null, JSON.stringify(r));
    },
  },
  // ---------- Seams (review 6.8): vehicle saves, brake key, rigid-body shadows, fixed camera interrupting a blend, nav version, entity growth ----------
  {
    name: 'B 接缝：玩家存档带载具、刹车独立按键、刚体不改投影设置',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, car = window.car;
        p.placeAt({ x: car.object.position.x + 2.5, z: car.object.position.z }); engine.step(0.1);
        engine.saves.save('b-walk');
        p.enter(car); engine.step(0.2);
        engine.saves.save('b-drive');
        engine.saves.load('b-walk'); engine.step(0.2);
        const walk = { vehicle: !!p.vehicle, visible: p.root.visible, seat: p.position.distanceTo(car.seatPosition()) };
        engine.saves.load('b-drive'); engine.step(0.1);
        const drive = { vehicle: p.vehicle === car };
        p.exit(); engine.step(0.1);
        const keys = { brake: engine.input.keysOf('brake'), jump: engine.input.keysOf('jump') };
        const m = new __threedogThree.Mesh(new __threedogThree.BoxGeometry(1, 1, 1), new __threedogThree.MeshBasicMaterial());
        m.position.set(0, 3, 0);
        const e = engine.rigid.addBox(m, { mass: 1 }), shadow = m.castShadow || m.receiveShadow;
        e.remove(); engine.remove(m);
        return { walk, drive, keys, shadow };
      });
      check('loading an on-foot save while driving: exits the car first, not pulled back to the seat', !r.walk.vehicle && r.walk.visible && r.walk.seat > 1, JSON.stringify(r.walk));
      check('loading a driving save: back in the car', r.drive.vehicle);
      check('brake is a separate action and does not compete with jump for Space', r.keys.brake.length > 0 && !r.keys.brake.includes('Space') && r.keys.jump.includes('Space'), JSON.stringify(r.keys));
      check('rigid.addBox does not force the model to cast/receive shadows', r.shadow === false);
    },
  },
  {
    name: 'B 接缝：固定机位 cut 打断 blend 时 Promise 照样完成',
    url: '/tests/cameras/index.html?cam=fixed',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const rig = engine.cameraRig;
        let done = false;
        rig.blend('east', { seconds: 5 }).then(() => { done = true; });
        engine.step(0.2);
        rig.cut('north');
        for (let i = 0; i < 5; i++) await Promise.resolve();
        return { done, shot: rig.current };
      });
      check('cut during a blend: await blend() does not hang', r.done && r.shot === 'north', JSON.stringify(r));
    },
  },
  {
    name: 'B 接缝：导航网格版本号（重建后 NPC 重新加群体代理）',
    url: '/tests/nav/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const v0 = engine.nav.version;
        engine.nav.dispose();
        return { v0, v1: engine.nav.version, ready: engine.nav.ready, helper: engine.nav.helper };
      });
      check('after dispose version is +1 and helper is removed', r.v1 === r.v0 + 1 && !r.ready && r.helper === null, JSON.stringify(r));
    },
  },
  {
    name: 'B 接缝：NPC 删除彻底释放',
    url: '/tests/placeables/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const npc = engine.npcs.add({ name: 'b路人', position: { x: 2, z: 2 } });
        engine.step(1 / 60, { render: false });   // the NPC model is world presentation: nearby ones are built on the next fixed step
        const root = npc.root, geo = root?.children[0]?.children[0]?.geometry ?? null;
        let disposed = false; geo?.addEventListener('dispose', () => { disposed = true; });
        engine.npcs.remove(npc);
        return { built: !!root, gone: !!root && !root.parent && !engine.world.get(npc.id), disposed: !geo || disposed };
      });
      check('npcs.remove: record deleted, model removed from the scene, geometry disposed', r.built && r.gone && r.disposed, JSON.stringify(r));
    },
  },
];
