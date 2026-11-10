// Player control is replaceable (genericity audit A1 / A2 / B1): control 'camera' / function, a game step through engine.control, faceMode, push, input.simulate, follow camera shoulder / frame, target selection.
// Guards [must not be bypassed]: while a game step holds the player's control nothing else in the engine moves it; while framing, a yaw the game writes directly is pulled back (frame() owns yaw);
// the engine picks no player feel (addPlayer without control throws, run / jump keys and camera follow exist only when given) and openWorld picks no camera.

export const specs = [
  {
    name: 'player control: a game step pauses the keys (guard), a side-scroller step reads one axis, camera = keys relative to the camera; describe reports it',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, inp = engine.input, at = () => ({ x: p.position.x, z: p.position.z });
        p.faceMode = 'move'; p.faceTarget = null;
        engine.step(10 / 60, { render: false });
        const out = {};
        // default: W moves the player
        let a = at(); inp.simulate('moveForward'); engine.step(20 / 60, { render: false }); inp.simulate('moveForward', false);
        let b = at(); out.defaultMoved = Math.hypot(b.x - a.x, b.z - a.z);
        engine.step(20 / 60, { render: false });
        // a game holding the player's control with no move: holding W for half a second changes nothing at all
        const still = engine.control.take(p, { owner: 'stun', layer: 'script', step: () => null });
        a = at(); inp.simulate('moveForward'); engine.step(30 / 60, { render: false }); inp.simulate('moveForward', false);
        b = at(); out.offIdle = Math.hypot(b.x - a.x, b.z - a.z); still.remove();
        // ...and the game's own step that only ever moves along +X is the one that moves it
        const own = engine.control.take(p, { owner: 'lunge', layer: 'script', step: () => ({ x: 1, z: 0 }) });
        a = at(); inp.simulate('moveForward'); inp.simulate('moveLeft'); engine.step(30 / 60, { render: false });
        inp.simulate('moveForward', false); inp.simulate('moveLeft', false);
        b = at(); out.offDx = b.x - a.x; out.offDz = b.z - a.z;
        out.describeOff = engine.describe().player.control; own.remove();
        // function control: only the x axis (side-scroller); W changes nothing
        const side = engine.control.take(p, { owner: 'side', layer: 'script', step: () => ({ x: inp.axis.x, z: 0 }) });
        engine.step(20 / 60, { render: false });
        a = at(); inp.simulate('moveForward'); engine.step(20 / 60, { render: false }); inp.simulate('moveForward', false);
        b = at(); out.fnW = Math.hypot(b.x - a.x, b.z - a.z);
        a = at(); inp.simulate('moveRight'); engine.step(20 / 60, { render: false }); inp.simulate('moveRight', false);
        b = at(); out.fnDx = b.x - a.x; out.fnDz = Math.abs(b.z - a.z);
        out.describeFn = engine.describe().player.control; side.remove();
        out.back = engine.describe().player.control;
        try { engine.characters.addPlayer({ control: 'manual' }); } catch (err) { out.err = String(err.message); }
        try { engine.characters.addPlayer({ control: true }); } catch (err) { out.errOld = String(err.message); }
        try { engine.characters.addPlayer({ spawn: { x: 0, z: 0 } }); } catch (err) { out.errNone = String(err.message); out.codeNone = err.code; }
        out.stillPlayer = engine.player === p;
        return out;
      });
      check('camera control: W moves the player', r.defaultMoved > 1, JSON.stringify(r));
      check('[guard] a game step holds the player: W / A do nothing, only its +X moves it', r.offIdle < 0.05 && r.offDx > 1 && Math.abs(r.offDz) < 0.3 && r.describeOff === 'lunge', JSON.stringify(r));
      check('side-scroller step: W does not move it, D moves only along X; removing it gives the keys back', r.fnW < 0.05 && r.fnDx > 1 && r.fnDz < 1e-6 && r.describeFn === 'side' && r.back === 'player-input', JSON.stringify(r));
      check('bad control throws with the fix, before touching the existing player', /is not a control/.test(r.err) && /presets\.player\.thirdPerson/.test(r.err) && /is not a control/.test(r.errOld) && r.stillPlayer, r.err + ' | ' + r.errOld);
      check('[guard] no control: addPlayer throws player-control and names the preset (the engine picks no feel)', r.codeNone === 'player-control' && /presets\.player\.thirdPerson/.test(r.errNone) && /engine\.control\.take/.test(r.errNone), r.errNone);
    },
  },
  {
    name: 'facing: manual keeps facing while moving, target faces the target while strafing, camera faces camera forward, push displaces without turning',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, inp = engine.input, at = () => ({ x: p.position.x, z: p.position.z });
        p.faceMode = 'move'; p.faceTarget = null;
        engine.step(10 / 60, { render: false });
        const out = {}, wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
        p.face(0); p.faceMode = 'manual';
        inp.simulate('moveRight'); engine.step(20 / 60, { render: false }); inp.simulate('moveRight', false);
        out.manual = p.facing;
        const t = { x: p.position.x + 10, z: p.position.z };
        p.faceMode = 'target'; p.faceTarget = t;
        inp.simulate('moveForward'); engine.step(40 / 60, { render: false }); inp.simulate('moveForward', false);
        out.target = Math.abs(wrap(p.facing - Math.atan2(t.x - p.position.x, t.z - p.position.z)));
        p.faceMode = 'camera'; engine.step(40 / 60, { render: false });
        const f = engine.cameraRig.forward(); out.camera = Math.abs(wrap(p.facing - Math.atan2(f.x, f.z)));
        p.faceMode = 'move'; p.face(1);
        const a = at(); p.push(0, 6, 0.3); engine.step(18 / 60, { render: false });
        const b = at(); out.pushFacing = p.facing; out.pushDz = b.z - a.z;
        return out;
      });
      check('manual: moving right does not turn the character', Math.abs(r.manual) < 1e-6, JSON.stringify(r));
      check('target: faces the target while walking forward', r.target < 0.05, JSON.stringify(r));
      check('camera: faces camera forward', r.camera < 0.05, JSON.stringify(r));
      check('push: displaced along +Z without turning (facing stays 1)', r.pushDz > 1 && Math.abs(r.pushFacing - 1) < 1e-6, JSON.stringify(r));
    },
  },
  {
    name: 'follow camera: shoulder shifts the camera along right(); frame(target) turns yaw behind the player toward the target and owns yaw (guard)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const rig = engine.cameraRig, p = engine.player.position, cam = engine.camera.position, out = {};
        const side = () => { const rt = rig.right(); return (cam.x - rig.focus.x) * rt.x + (cam.z - rig.focus.z) * rt.z; };
        rig.shoulder = 0; engine.step(30 / 60, { frameEvery: 1, render: false }); out.side0 = side();
        rig.shoulder = 1; engine.step(5 / 60, { frameEvery: 1, render: false }); out.side1 = side();
        rig.shoulder = 0;
        const t = { x: p.x + 12, y: p.y, z: p.z + 5 };
        rig.frame(t); engine.step(90 / 60, { frameEvery: 1, render: false });
        const f = rig.forward(), dx = t.x - p.x, dz = t.z - p.z, l = Math.hypot(dx, dz);
        out.aim = (f.x * dx + f.z * dz) / l;
        rig.yaw += 2; engine.step(90 / 60, { frameEvery: 1, render: false });
        const g = rig.forward(); out.aimAfterWrite = (g.x * dx + g.z * dz) / l;
        rig.frame(null); const y = rig.yaw; engine.step(10 / 60, { frameEvery: 1, render: false }); out.released = Math.abs(rig.yaw - y);
        return out;
      });
      check('shoulder 1: the camera moves about 1 m to the right of the follow line', Math.abs(r.side0) < 0.05 && Math.abs(r.side1 - 1) < 0.05, JSON.stringify(r));
      check('frame(): forward() points at the target', r.aim > 0.99, JSON.stringify(r));
      check('[guard] frame() owns yaw: a direct yaw write is pulled back; frame(null) releases it', r.aimAfterWrite > 0.99 && r.released < 1e-9, JSON.stringify(r));
    },
  },
  {
    name: 'pickTarget / switchTarget: prefers what is in view over what is behind, close range ignores angle, blocked skips, switch goes right / left and wraps',
    url: '/tests/a/',   // pure functions run in node; the runner still opens a page, take a light one
    async run({ check }) {
      const { pickTarget, switchTarget } = await import('../../core/scene/targeting.js');
      const from = { x: 0, z: 0 }, view = { x: 0, z: 1 };   // looking along +Z; screen right is -X
      const ahead = { id: 'ahead', x: 0, z: 8 }, behind = { id: 'behind', x: 0, z: -4 }, hug = { id: 'hug', x: 0, z: -2 }, right = { id: 'right', x: -5, z: 6 }, far = { id: 'far', x: 0, z: 30 };
      check('in view beats a nearer one behind', pickTarget(from, view, [behind, ahead, far])?.id === 'ahead');
      check('inside close range the angle is ignored', pickTarget(from, view, [hug])?.id === 'hug');
      check('blocked skips; out of range gives null', pickTarget(from, view, [ahead, right], { blocked: c => c === ahead })?.id === 'right' && pickTarget(from, view, [far]) === null);
      check('a facing angle works as view; objects with .position work as candidates', pickTarget({ position: from }, 0, [{ position: ahead }])?.position === ahead);
      const left = { id: 'left', x: 5, z: 6 }, list = [right, ahead, left];
      check('switch right from ahead → right, left from ahead → left, wraps', switchTarget(from, view, ahead, list, 1)?.id === 'right' && switchTarget(from, view, ahead, list, -1)?.id === 'left' && switchTarget(from, view, right, list, 1)?.id === 'left');
      let err = ''; try { pickTarget(from, view, [], { radiuss: 3 }); } catch (e) { err = e.message; }
      check('unknown option names the available ones', /available: radius/.test(err), err);
    },
  },
  {
    name: 'openWorld parts: every part takes false or its own options (nested calendar / terrain reach the modules), shorthand still works, bad values explain the fix',
    url: '/tests/placeables/index.html',   // built with openWorld({ camera: 'follow', terrain: { seed }, calendar: { time: 0.4, daysPerSeason: 28 }, debug: false, ambience: false })
    async run({ check, ev }) {
      const r = await ev(() => ({ days: engine.calendar._ends[0], time: engine.calendar.timeOfDay, debug: !!engine.debug?.el, ambience: !!engine.ambience, terrain: !!engine.terrain }));
      check('[guard] nested options reach the module: calendar daysPerSeason 28, time ~0.4; false parts are absent', r.days === 28 && Math.abs(r.time - 0.4) < 0.05 && !r.debug && !r.ambience && r.terrain, JSON.stringify(r));
      const { openWorld } = await import('../../index.js');
      const names = o => openWorld(o).map(m => m.name).join(',');
      check('shorthand and full list: all parts, camera included; debug is left out of non-dev builds (node is not dev)',
        names({ seed: 3, time: 0.3, camera: 'follow' }) === 'world,terrain,terrainDraw,vegetation,vegetationDraw,calendar,sky,weather,weatherDraw,water,collision,rigid,cameraRig,characters,ambience,settings', names({ seed: 3, camera: 'follow' }));
      let noCam = ''; try { openWorld({ seed: 3 }); } catch (e) { noCam = e.message; }
      check('[guard] openWorld picks no camera: leaving camera out throws open-world-camera with the choices', /\[open-world-camera\]/.test(noCam) && /camera: 'follow'/.test(noCam), noCam);
      // sky: false 只关画天空；时间归 calendar，照样在（其他部件读它的 timeOfDay / 季节）
      const dropped = names({ sky: false, camera: false, collision: false, debug: true });
      check('false drops any part, camera too; debug: true forces the panel in (sky: false keeps the calendar)', dropped === 'world,terrain,terrainDraw,vegetation,vegetationDraw,calendar,weather,weatherDraw,water,rigid,characters,ambience,settings,debugPanel', dropped);
      let err = ''; try { openWorld({ camera: 'follow', terrain: 'island' }); } catch (e) { err = e.message; }
      check('a non-object part value names the fix', /terrain must be false .* or an options object/.test(err), err);
    },
  },
];
