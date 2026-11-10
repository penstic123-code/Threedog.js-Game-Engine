// 运行时切换相机 engine.setCamera：身体显示、视角、鼠标锁定、参数保留、写错报错。页面是 tests/cameras（follow 起步）。

export const specs = [
  {
    // a pixel game wrote engine.cameraRig.shots.main to pan: this is the public way, and recipe 21 section 6 says so
    name: 'followCamera at a fixed angle: mouseLook false keeps drag and wheel off, the view pans with any object the game moves',
    url: '/tests/cameras/index.html',
    async run({ page, check, ev, frames }) {
      const iso = { pitch: 0.6, yaw: 0.8, distance: 20, projection: 'orthographic', size: 14, ground: 'none' };
      const read = () => ev(() => ({ q: engine.camera.quaternion.toArray(), yaw: engine.cameraRig.yaw, size: engine.cameraRig.size }));
      const drag = async () => {
        await page.mouse.move(300, 300); await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(300 + i * 30, 300); await frames(1); }
        await page.mouse.up(); await page.mouse.wheel(0, 400); await frames(3);
      };
      await ev(o => { engine.setCamera('follow', o); }, iso);
      await frames(3);
      const before = await read(); await drag();
      const free = await read();
      check('without mouseLook: false the drag turns the view and the wheel zooms (the test can see it)', free.yaw !== before.yaw && free.size !== before.size, JSON.stringify([before, free]));
      await ev(o => {
        engine.setCamera('follow', { ...o, mouseLook: false, smoothing: 1000 });
        window.view = new engine.scene.constructor();   // any Object3D
        engine.cameraRig.follow(window.view);
      }, iso);
      await frames(3);
      const a = await read(), offset = () => ev(() => engine.camera.position.clone().sub(window.view.position).toArray());
      const o1 = await offset();
      await drag();
      await ev(() => { window.view.position.set(30, 0, -12); });
      await frames(5);
      const b = await read(), o2 = await offset();
      const same = (x, y) => x.every((v, i) => Math.abs(v - y[i]) < 1e-4);
      check('drag and wheel leave the view alone', a.yaw === b.yaw && a.size === b.size && same(a.q, b.q), JSON.stringify([a, b]));
      check('the camera moved with the object and kept its offset', same(o1, o2), JSON.stringify([o1, o2]));
      await ev(() => { engine.setCamera('follow', { projection: 'perspective' }); delete window.view; });
    },
  },
  {
    // shot --play showed the defaults of followCamera(): the first session:start rebuilt the rig from the module's options
    name: '[guard] setCamera before play keeps its options when play starts; a runtime switch still starts over',
    url: '/tests/cameras/index.html?cam=first&preset=1',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const read = () => ({ kind: engine.cameraRig.kind, distance: engine.cameraRig.distance, pitch: engine.cameraRig.pitch, size: engine.cameraRig.size, ortho: !!engine.camera.isOrthographicCamera });
        await engine.session.newGame();
        engine.step(0.1);
        const out = { play: read() };
        engine.setCamera('firstPerson');   // the game is playing now: a switch, not the game's set-up
        await engine.session.newGame();
        engine.step(0.1);
        out.again = read();
        return out;
      });
      const want = o => o.kind === 'follow' && o.distance === 22 && o.pitch === 0.7 && o.size === 14 && o.ortho;
      check('play starts on the camera set before it', want(r.play), JSON.stringify(r));
      check('a new game after a runtime switch goes back to that camera', want(r.again), JSON.stringify(r));
    },
  },
  {
    // A first-person game's Continue came back facing the installed direction, silently, and a rig kept at boot pointed at a dead object after the load
    name: '[guard] Continue restores the first-person view, on the same rig object',
    url: '/tests/cameras/index.html?cam=first',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const rig = engine.cameraRig, out = {}, view = () => [+engine.cameraRig.yaw.toFixed(3), +engine.cameraRig.pitch.toFixed(3)];
        rig.height = 2.5;   // not save data: starts over as installed
        rig.yaw = 1.2; rig.pitch = -0.4;
        engine.saves.save('view'); await engine.saves.flush();
        rig.yaw = -2; rig.pitch = 0.5;
        out.ok = await engine.session.load('view');
        engine.step(0.1);
        out.same = engine.cameraRig === rig; out.view = view(); out.height = rig.height;
        out.camYaw = +engine.camera.rotation.y.toFixed(3); out.camPitch = +engine.camera.rotation.x.toFixed(3);
        rig.yaw = 2;
        rig.pitch = 0.1;
        await engine.saves.load('view');   // quick load: no session:start
        out.quick = view();
        await engine.session.newGame();
        out.fresh = view();
        // a save from before the view was saved: loads, no error
        const old = engine.saves.collect(); delete old.parts.cameraRig; delete old.versions.cameraRig;
        rig.yaw = 1;
        out.oldSave = await engine.saves.apply(old, 'old'); out.oldYaw = view()[0];
        // a game part writing the rig in its own load() keeps its write
        engine.saves.define('facing', { save: () => ({ yaw: 0.7 }), load: d => { engine.cameraRig.yaw = d.yaw; } });
        engine.saves.save('view2'); await engine.saves.flush();
        await engine.session.load('view2');
        engine.step(0.1);
        out.partWrite = view()[0];
        return out;
      });
      check('session.load: the same rig object is the camera', r.ok && r.same, JSON.stringify(r));
      check('session.load: yaw and pitch are the saved ones, on the rig and on the drawn camera', r.view[0] === 1.2 && r.view[1] === -0.4 && r.camYaw === 1.2 && r.camPitch === -0.4, JSON.stringify(r));
      check('session.load: the rest of the rig starts over as installed', r.height === 1.6, JSON.stringify(r));
      check('saves.load (quick load) restores the view too', r.quick[0] === 1.2 && r.quick[1] === -0.4, JSON.stringify(r));
      check("a save part's load() that writes the rig is not undone by the new playthrough", r.partWrite === 0.7, JSON.stringify(r));
      check('newGame goes back to the view right after start()', r.fresh[0] === 0 && r.fresh[1] === 0, JSON.stringify(r));
      check('a save without the part loads and leaves the view alone', r.oldSave === true && r.oldYaw === 1, JSON.stringify(r));
    },
  },
  {
    name: '相机切换：follow ↔ firstPerson ↔ rts，目标和朝向接着走、身体显示 / 视角恢复、切回参数还在、写错名字列出可选项',
    url: '/tests/cameras/index.html?cam=follow',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const P = engine.player, meshes = [];
        P.root.traverse(o => { if (o.isMesh) meshes.push(o); });
        const visible = () => meshes.length > 0 && meshes.every(m => engine.camera.layers.test(m.layers));
        const fov0 = engine.camera.fov;
        engine.step(0.3);
        engine.cameraRig.distance = 20; engine.cameraRig.yaw = 1.1;
        const out = { kind0: engine.cameraRig.kind, vis0: visible() };
        engine.setCamera('firstPerson', { fov: 80, height: 1.7 });
        engine.step(0.3);
        out.kind1 = engine.cameraRig.kind; out.vis1 = visible(); out.fov1 = engine.camera.fov;
        out.target1 = engine.cameraRig.target === P.root; out.yaw1 = +engine.cameraRig.yaw.toFixed(3);
        out.desc1 = engine.describe().camera.type;
        out.eye = +(engine.camera.position.y - P.position.y).toFixed(1);
        engine.setCamera('rts');
        engine.step(0.3);
        out.kind2 = engine.cameraRig.kind; out.vis2 = visible(); out.fov2 = engine.camera.fov === fov0;
        engine.setCamera('follow');
        engine.step(0.3);
        out.kind3 = engine.cameraRig.kind; out.vis3 = visible(); out.fov3 = engine.camera.fov === fov0;
        out.distance3 = engine.cameraRig.distance;
        out.fwdOk = Math.abs(engine.cameraRig.forward().x + Math.sin(1.1)) < 1e-6;
        try { engine.setCamera('thirdPerson'); out.err = ''; } catch (e) { out.err = e.message; }
        out.kindAfterErr = engine.cameraRig.kind;
        return out;
      });
      check('起步是 follow，身体可见', r.kind0 === 'follow' && r.vis0, JSON.stringify(r));
      check('切 firstPerson：种类、跟随目标、朝向接着、视角用新参数、身体从相机里藏起来', r.kind1 === 'firstPerson' && r.target1 && r.yaw1 === 1.1 && r.fov1 === 80 && !r.vis1 && r.desc1 === 'firstPerson', JSON.stringify(r));
      check('眼睛高度用新参数 1.7', Math.abs(r.eye - 1.7) < 0.2, JSON.stringify(r));
      check('切 rts：身体显示回来、视角恢复', r.kind2 === 'rts' && r.vis2 && r.fov2, JSON.stringify(r));
      check('切回 follow：身体可见、视角恢复、缩放距离还是 20、朝向接着', r.kind3 === 'follow' && r.vis3 && r.fov3 && r.distance3 === 20 && r.fwdOk, JSON.stringify(r));
      check('种类写错报错列出可选项；失败时相机不变', /firstPerson/.test(r.err) && /thirdPerson/.test(r.err) && r.kindAfterErr === 'follow', JSON.stringify(r));
    },
  },
  {
    name: 'RtsCamera 起点在岛外（surface 是 -Infinity）：不崩，焦点 y 退回 0',
    url: '/tests/cameras/index.html?cam=follow',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        engine.setGround({ height: x => x > 1000 ? -Infinity : 0, has: x => x <= 1000 });
        let err = null; try { engine.setCamera('rts', { start: { x: 2000, z: 0 } }); engine.step(0.1); } catch (e) { err = e.message; }
        const f = engine.camera.position;
        return { err, finite: [f.x, f.y, f.z].every(Number.isFinite) };
      });
      check('rts 相机起点在岛外：不抛错，相机位置有限', r.err === null && r.finite, JSON.stringify(r));
    },
  },
  {
    name: '正交相机：fixed 单镜头 projection orthographic，世界点落在预期屏幕位置，切回透视恢复',
    url: '/tests/cameras/index.html?cam=follow',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ')); oe(...a); };
        const home = engine.camera, V = home.position.constructor, out = {};
        let cam = home;
        const ndc = (x, y, z) => { cam.updateMatrixWorld(); return new V(x, y, z).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix); };
        engine.setCamera('fixed', { position: [0, 10, 10], lookAt: [0, 0, 0], projection: 'orthographic', size: 10 });
        engine.step(0.1);
        cam = engine.camera;
        out.ortho = cam.isOrthographicCamera === true && cam !== home;
        const a = (cam.right - cam.left) / (cam.top - cam.bottom), p = ndc(2, 0, 0), up = ndc(0, 0, -3);
        out.x = +p.x.toFixed(3); out.wantX = +(2 / (5 * a)).toFixed(3);
        out.centre = Math.abs(ndc(0, 0, 0).x) < 1e-6 && Math.abs(ndc(0, 0, 0).y) < 1e-6;
        out.upY = +up.y.toFixed(3);   // 3 m farther from the camera along the ground is 3 * sin(45deg) up the screen: 2.12 / 5
        out.parallel = Math.abs(ndc(0, 0, 0).x - ndc(0, 0, 5).x) < 1e-6;   // no perspective: depth does not change the x position
        engine.step(0.1);
        out.desc = engine.describe().camera.type;
        engine.setCamera('follow');
        engine.step(0.1);
        out.back = engine.camera === home && home.isPerspectiveCamera === true;
        console.error = oe; out.errs = errs.length;
        return out;
      });
      check('正交标记生效、屏幕中心不偏', r.ortho && r.centre, JSON.stringify(r));
      check('世界 x=2 落在 ndc.x = 2/(size/2*aspect)；沿地面远 3 米在屏幕上移 2.12/5', Math.abs(r.x - r.wantX) < 2e-3 && Math.abs(r.upY - 0.424) < 2e-3, JSON.stringify(r));
      check('正交无透视：深度不影响 x；渲染期间无 console.error；切回 follow 恢复透视', r.parallel && r.errs === 0 && r.back, JSON.stringify(r));
    },
  },
  {
    // 没装相机模块的场景（没 openWorld、没玩家）：setCamera 以前是 undefined，报 "setCamera is not a function"，不说怎么修
    name: '相机切换：没装相机模块时 setCamera 报带代码的错，说出要先 engine.use(fixedCamera(...))',
    url: '/tests/lights/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const out = { rig: !!engine.cameraRig };
        try { engine.setCamera('fixed', { position: [10, 10, 10], lookAt: [0, 0, 0] }); out.err = ''; } catch (e) { out.err = e.message; out.code = e.code; }
        return out;
      });
      check('[guard] 无相机模块：报 camera-none，消息点名 engine.use(fixedCamera({ position, lookAt }))', !r.rig && r.code === 'camera-none'
        && /engine\.use\(fixedCamera\(\{ position, lookAt \}\)\)/.test(r.err), JSON.stringify(r));
    },
  },
  {
    // setCamera let go of the old rig before it knew the new one could be built: a caught typo left a first-person rig with no target and no mouse
    name: '[guard] setCamera with a bad kind or option keeps the old rig on its target; an auto cut shows the new shot at once; leaving a fixed rig ends its blend',
    url: '/tests/cameras/index.html?cam=first',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const out = {}, rig = engine.cameraRig, had = rig.target, V = engine.camera.position.constructor;
        const code = f => { try { f(); return null; } catch (x) { return x.code; } };
        out.kind = code(() => engine.setCamera('nope'));
        out.option = code(() => engine.setCamera('follow', { ground: 'sideways' }));
        out.kept = engine.cameraRig === rig && rig.target === had && !!had;
        out.listening = rig._off && !rig._off.signal.aborted;
        const fixed = engine.setCamera('fixed', { start: 'a', auto: 'nearest', hysteresis: 0, shots: {
          a: { position: [0, 5, 5], lookAt: [0, 0, 0] }, b: { position: [500, 5, 5], lookAt: [500, 0, 0], projection: 'orthographic', size: 10 } } });
        fixed.target = { position: new V(500, 0, 0) };
        fixed.update(1, engine.input);
        out.shot = fixed.current; out.size = engine.camera.top - engine.camera.bottom;
        let done = false;
        fixed.blend('a', { seconds: 5 }).then(() => { done = true; });
        engine.setCamera('follow');
        await Promise.resolve(); await Promise.resolve();
        out.blendDone = done;
        return out;
      });
      check('the bad kind and the bad option are refused, and the rig still follows and listens', r.kind === 'camera-kind' && r.option === 'camera-option' && r.kept && r.listening, JSON.stringify(r));
      check('the frame of an auto cut draws the new shot\'s projection', r.shot === 'b' && r.size === 10, JSON.stringify(r));
      check('await blend() ends when the rig is switched away', r.blendDone, JSON.stringify(r));
    },
  },
];
