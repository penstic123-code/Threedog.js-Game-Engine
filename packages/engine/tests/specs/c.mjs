// Batch 3, group C specs (same format as the other files here).
// Covers budget, shadow options, HLOD, scenario option hooks, settings menu freezing gameplay, startup time (numbers only).
// For detailed performance comparison see node packages/tools/perf.mjs and docs/testing/perf.md.
export const specs = [
  {
    name: '性能预算（小城示例）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const off = engine.budget.report();
        engine.budget.enable({ drawCalls: 1 });
        engine.step(0.1);
        const on = engine.budget.report(), desc = engine.describe().perf.budget;
        engine.budget.enable({});   // no limits given = nothing is checked
        engine.step(0.1);
        const none = engine.budget.report();
        const metric = engine.budget.metric('crates', () => 99, { limit: 10 });
        const custom = engine.budget.report().over.map(o => o.category);
        metric.remove(); engine.budget.disable(); engine._unhalt();
        return { off, on, desc: !!desc, none, custom };
      });
      check('report() is null when budget is off', r.off === null);
      check('drawCalls over limit and the top consumers are listed', r.on && !r.on.ok && r.on.over[0].category === 'drawCalls' && r.on.over[0].top.length > 0, JSON.stringify(r.on));
      check('describe().perf.budget has a report', r.desc);
      check('categories without a limit are not checked', r.none?.ok === true, JSON.stringify(r.none));
      check('module custom category metric takes effect', r.custom.includes('crates'), r.custom.join(','));
    },
  },
  {
    name: '阴影：budget 控制重画频率，box 的 snap 可换，阴影值是 three.js 的（小城示例）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const sm = engine.renderer.shadowMap, orig = sm.render.bind(sm), sun = engine.lights.sun, sh = sun.shadow;
        // counted once per engine frame: a post pass that draws the scene again (ao on a higher tier, e.g. on the GPU) calls render twice
        let n = 0, frame = 0, counted = -1;
        const step = () => { frame++; engine.step(1 / 60); };
        sm.render = (...a) => { if ((sh.autoUpdate || sh.needsUpdate) && counted !== frame) { n++; counted = frame; } orig(...a); };
        const def = { bias: sh.bias, auto: sh.autoUpdate };
        const budget = engine.shadows.budget(sun, { every: 4 }); sh.bias = -0.001;
        step();   // first frame (budget() requests one update)
        n = 0;
        for (let i = 0; i < 8; i++) step();
        const every4 = n, bias = sh.bias;
        budget.set({ every: 1 }); sh.bias = def.bias;
        const box = engine.shadows.box(sun, { snap: 'texel' });
        n = 0;
        for (let i = 0; i < 4; i++) step();
        const every1 = n;
        box.remove(); budget.remove();
        sm.render = orig; engine._unhalt();
        return { def, every4, every1, bias, back: sh.autoUpdate };
      });
      check('the placeholder sun updates every frame, bias -0.0001 (render/lights.js)', r.def.bias === -0.0001 && r.def.auto, JSON.stringify(r.def));
      check('every: 4 updates twice in 8 frames', r.every4 === 2, r.every4);
      check('bias is a three.js value the engine leaves alone', r.bias === -0.001, r.bias);
      check('every: 1 + texel updates every frame, remove() gives autoUpdate back', r.every1 === 4 && r.back, r.every1);
    },
  },
  {
    name: '阴影：renderer.shadowMap.type 是 three.js 的值，换类型后受预算的灯下一帧就重建贴图',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const sm = engine.renderer.shadowMap, T = __threedogThree, sun = engine.lights.sun, out = { def: sm.type === T.PCFShadowMap };
        const budget = engine.shadows.budget(sun, { every: 50 });
        engine.step(1 / 60); engine.step(1 / 60);
        const map = sun.shadow.map;
        sm.type = T.BasicShadowMap;
        engine.step(1 / 60);   // renders with the new type without throwing
        out.rebuilt = !!sun.shadow.map && sun.shadow.map !== map;   // three rebuilds only the maps it draws that frame: the budget must draw this one
        sm.type = T.PCFShadowMap;
        budget.remove(); engine.step(1 / 60);
        engine._unhalt();
        return out;
      });
      check('default is pcf', r.def);
      check('a filter switch under a budget redraws at once, so the map is rebuilt for the new filter', r.rebuilt);
    },
  },
  {
    name: 'HLOD：远处合并成代理（C 组测试页街区）',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const h = engine.hlod;
        await new Promise(res => { const t = () => (h.cells.length && !engine.jobs.pending ? res() : setTimeout(t, 50)); t(); });
        engine.haltLoop();
        const calls = () => { engine.step(0.5); return engine.renderer.info.render.calls; };
        engine.focus.set(0, 0, 0); const near = calls();
        const nearVisible = engine.level.root.getObjectByName('b_3_3').visible;
        engine.focus.set(400, 0, 400); const far = calls();
        const farState = { orig: engine.level.root.getObjectByName('b_3_3').layers.test(engine.camera.layers), allFar: h.cells.every(c => c.far), proxies: h.cells.reduce((n, c) => n + c.proxy.length, 0) };
        engine.focus.set(0, 0, 0); const back = calls();
        const lod = engine.level.root.getObjectByName('b_0_0_LOD1').visible;
        // count source queries in one switch pass: one for all cells, not one per cell
        const S = engine.stream, orig = S.sources; let queries = 0;
        S.sources = function (...a) { queries++; return orig.apply(this, a); };
        try { h.update(); } finally { S.sources = orig; }
        engine._unhalt();
        return { near, far, back, nearVisible, ...farState, cells: h.cells.length, lod, queries, d: engine.describe().hlod };
      });
      check('merged cells were built', r.cells > 0 && r.proxies > 0, JSON.stringify(r));
      check('focus moved 400 m away: everything switches to proxies, originals hidden', r.allFar && !r.orig, JSON.stringify(r));
      check(`draw calls drop clearly (near ${r.near} → far ${r.far})`, r.far < r.near * 0.5, `near ${r.near} → far ${r.far}`);
      check('originals visible again after moving back', r.back === r.near && r.nearVisible, `back ${r.back}`);
      check('_LOD1 nodes are hidden normally', r.lod === false);
      check('describe().hlod', r.d?.cells === r.cells, JSON.stringify(r.d));
      check(`one switch pass queries the stream sources once for all ${r.cells} cells`, r.cells > 1 && r.queries === 1, `queries ${r.queries}, cells ${r.cells}`);
    },
  },
  {
    name: '现场参数钩子（calendar.timeOfDay、weather）与设置菜单冻结玩法',
    url: '/tests/perf/index.html?mode=city',
    async run({ page, check, ev, frames }) {
      const r = await ev(() => {
        const cal = engine.modules.get('calendar'), w = engine.modules.get('weather');
        cal.applyState(engine, { time: '18:30' }); const clock = engine.calendar.clock;
        engine.calendar.timeOfDay = 0.3; const exact = { tod: engine.calendar.timeOfDay, clock: engine.calendar.clock };
        cal.applyState(engine, { time: '0.25' }); const t = engine.calendar.timeOfDay;
        w.applyState(engine, { weather: 'rain' });
        return { clock, exact, t, weather: engine.weather.name, rain: engine.weather.current.rain, auto: engine.weather.auto };
      });
      check('time 18:30 → calendar.clock', r.clock === '18:30', r.clock);
      check('time 0.25 (text from the URL) → calendar.timeOfDay', r.t === 0.25, r.t);
      check('timeOfDay 0.3 reads back exactly and shows 07:12 (no float drift to 07:11)', r.exact.tod === 0.3 && r.exact.clock === '07:12', JSON.stringify(r.exact));
      check('weather rain applies immediately and turns off auto weather', r.weather === 'rain' && r.rain > 0.5 && !r.auto, JSON.stringify(r));
      await page.mouse.click(640, 360);
      await ev(() => engine.settings.open()); await frames(2);
      // frozen: frame hooks still run, fixed steps (engine.time.now('real')) do not
      const frozen = await ev(async () => { const t = engine.time.now('real'), f = engine.frozen; await __t.frames(15); return { f, same: engine.time.now('real') === t }; });
      check('freezeWorld: gameplay frozen and time stopped while the menu is open', frozen.f && frozen.same, JSON.stringify(frozen));
      await ev(() => engine.settings.close()); await frames(2);
      check('unfrozen after the menu closes', await ev(async () => { const t = engine.time.now('real'); await __t.until(() => engine.time.now('real') > t, 10000).catch(() => {}); return !engine.frozen && engine.time.now('real') > t; }));
    },
  },
  {
    name: '天空修饰层（天气层 + 游戏层相乘，互不覆盖）',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.modules.get('weather').applyState(engine, { weather: 'rain' }); engine.step(0.1);
        // weather writes its multipliers on the effect layer of the picture points; a game's mul on top multiplies, it does not overwrite
        const P = n => engine.stacks.get(n), wOf = n => P(n).holders().find(h => h.owner === 'weatherDraw')?.value;
        const w = { tint: wOf('sky.tint')?.amount };
        return { w, grey: engine.weather.current.grey, noModify: !('modify' in engine.sky) };
      });
      check('the weather holds the sky.tint point at its grey amount', Math.abs(r.w.tint - r.grey) < 1e-6, JSON.stringify(r));
      // guard: the old sky-only mechanism is gone, its name throws and points at engine.mod (one entry for shared quantities)
      check('engine.mod is the one way to change sky light: the sky has no modify()', r.noModify, JSON.stringify(r));
    },
  },
  {
    name: '[guard] pause menu: freeze stops gameplay time, ambient uTime (wind / water / clouds) keeps moving; freeze({ still: true }) stops it too',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const U = engine.uniforms.uTime, at = () => [engine.time.now('real'), U.value];
        const h = engine.freeze('menu'); const [e0, u0] = at(); engine.step(0.5); const [e1, u1] = at(); h.remove();
        const s = engine.freeze('photo', { still: true }); const [, u2] = at(); engine.step(0.5); const [, u3] = at(); s.remove();
        return { gameplay: e1 - e0, ambient: u1 - u0, still: u3 - u2 };
      });
      check('frozen: real time stays, uTime advances by the stepped time', r.gameplay === 0 && Math.abs(r.ambient - 0.5) < 0.02, JSON.stringify(r));
      check('freeze({ still: true }): uTime stops too', r.still === 0, JSON.stringify(r));
    },
  },
  {
    name: 'X：钩子出错隔离（错误分级：游戏回调出错冻结玩法、帧钩子照跑）、按键刚按下照常清空',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const logs = [], orig = console.error; console.error = (...a) => logs.push(String(a[0]));   // expected errors must not count as console errors
        let after = 0;
        const bad1 = engine.onFrame(() => { throw new Error('坏 onFrame'); });
        const bad2 = engine.onFixed(() => { throw new Error('坏 onFixed'); });
        const good = engine.onFrame(() => { after++; });
        engine.input.justPressed.add('KeyE');
        engine.step(0.2);
        const cleared = !engine.input.justPressed.has('KeyE');
        engine.step(0.2);
        bad1.remove(); bad2.remove(); good.remove();
        console.error = orig; engine._unhalt();
        return { after, cleared, reports: logs.length, error: engine.error, frozen: engine.frozen };
      });
      check('onFrame after a bad hook still runs', r.after >= 6, JSON.stringify(r));
      check('input.endFrame still runs (just-pressed keys are cleared)', r.cleared, JSON.stringify(r));
      check('an error from the same hook is reported once (two bad hooks → 2 reports)', r.reports === 2, JSON.stringify(r));
      check('game callback error in test mode: engine.error records it, gameplay frozen', /onFixed/.test(r.error?.where) && r.frozen, JSON.stringify(r));
    },
  },
  {
    name: 'X：HLOD 远处隐藏原件，射线照样打得到',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const h = engine.hlod;
        await new Promise(res => { const t = () => (h.cells.length && !engine.jobs.pending ? res() : setTimeout(t, 50)); t(); });
        engine.haltLoop();
        const b = engine.level.root.getObjectByName('b_3_3');
        const down = () => engine.raycast([b.position.x, 200, b.position.z], [0, -1, 0])?.object?.name ?? null;
        engine.focus.set(0, 0, 0); engine.step(0.5); const near = down();
        engine.focus.set(400, 0, 400); engine.step(0.5); const far = down(), hidden = !b.layers.test(engine.camera.layers) && b.visible;
        engine.focus.set(0, 0, 0); engine.step(0.5);
        engine._unhalt();
        return { near, far, hidden };
      });
      check('ray hits the original when near', r.near === 'b_3_3', JSON.stringify(r));
      check('ray still hits the original when it is hidden far away (proxy shown)', r.hidden && r.far === 'b_3_3', JSON.stringify(r));
    },
  },
  {
    name: "[guard] HLOD: the game's own visible wins (hidden near stays hidden after far -> near; hidden while far stays hidden; no ray hit)",
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const h = engine.hlod;
        await new Promise(res => { const t = () => (h.cells.length && !engine.jobs.pending ? res() : setTimeout(t, 50)); t(); });
        engine.haltLoop();
        const a = engine.level.root.getObjectByName('b_3_3'), b = engine.level.root.getObjectByName('b_2_2');
        const down = o => engine.raycast([o.position.x, 200, o.position.z], [0, -1, 0])?.object?.name ?? null;
        engine.focus.set(0, 0, 0); engine.step(0.5);
        a.visible = false;                                   // the game hides a building while near (burnt down)
        engine.focus.set(400, 0, 400); engine.step(0.5);
        b.visible = false;                                   // another one hidden while far
        const farRayB = down(b);
        engine.focus.set(0, 0, 0); engine.step(0.5);
        const out = { aNear: a.visible, bNear: b.visible, farRayB };
        a.visible = true; b.visible = true; engine.step(0.5);
        out.shownAgain = a.visible && b.visible;
        engine._unhalt();
        return out;
      });
      check('a building the game hid near stays hidden after a far -> near switch', r.aNear === false, JSON.stringify(r));
      check('a building the game hid while far stays hidden when near, and rays miss it while far', r.bNear === false && r.farRayB !== 'b_2_2', JSON.stringify(r));
      check('showing them again works', r.shownAgain, JSON.stringify(r));
    },
  },
  {
    name: '[guard] HLOD: unloading the module takes its proxies out and gives the far originals back',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const h = engine.hlod;
        await new Promise(res => { const t = () => (h.cells.length && !engine.jobs.pending ? res() : setTimeout(t, 50)); t(); });
        engine.haltLoop();
        engine.focus.set(400, 0, 400); engine.step(0.5);
        const c = h.cells.find(x => x.far), m = c?.originals[0], drawn = () => m?.layers.isEnabled(0);
        const out = { far: !!c, drawnFar: drawn(), proxy: !!c?.proxy[0]?.parent };
        engine._unuse('hlod', true);
        out.drawnAfter = drawn(); out.proxyAfter = !!c?.proxy[0]?.parent?.parent;
        engine._unhalt();
        return out;
      });
      check('a far original is off the drawn layer and its proxy is in the scene before', r.far && r.drawnFar === false && r.proxy, JSON.stringify(r));
      check('after unloading it is drawn again and the proxy is gone', r.drawnAfter === true && r.proxyAfter === false, JSON.stringify(r));
    },
  },
  {
    name: 'X：烘焙读回保留材质设置、射线登记随几何体释放',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE, toGLB } = threedogTest;
        const mat = new THREE.MeshLambertMaterial({ color: 0x808080, flatShading: true, transparent: true, opacity: 0.5, side: THREE.DoubleSide, emissive: 0x332211 });
        mat.userData.purpose = 'prop';
        const buf = await toGLB(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
        const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })) + '#x.glb';
        const m = (await engine.assets.model(url)).getObjectByProperty('isMesh', true).material;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); engine.add(mesh);
        engine.rays.addStatic(mesh); const had = engine.rays.statics.has(mesh);
        mesh.geometry.dispose(); const gone = !engine.rays.statics.has(mesh); mesh.removeFromParent();
        return { purpose: m.userData.purpose, flat: m.flatShading, tr: m.transparent, op: m.opacity, side: m.side === THREE.DoubleSide,
          em: m.emissive?.getHex(), want: new THREE.Color(0x332211).getHex(), had, gone };
      });
      check('rebuilt as recorded, keeping purpose / flatShading / transparent / opacity / side / emissive', r.purpose === 'prop' && r.flat && r.tr && r.op === 0.5 && r.side && r.em === r.want, JSON.stringify(r));
      check('ray registration is removed automatically after geometry dispose', r.had && r.gone, JSON.stringify(r));
    },
  },
  {
    name: 'X：确定性（step 下 jobs 做完、stream 同步挂上、engine.random 可复现、冻结）',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        let n = 0; engine.jobs.add(function* () { for (let i = 0; i < 200; i++) { n++; yield; } });
        engine.step(1 / 30); const jobsDone = n === 200 && engine.jobs.pending === 0;
        const h = engine.stream.add({ position: [engine.focus.x + 2, 0, engine.focus.z], build: () => new threedogTest.THREE.Object3D() });
        engine.step(1 / 30); const stream = { built: h.built, ready: engine.stream.ready, inScene: !!h.object?.parent }; h.remove();
        const seq = () => { engine.random.setSeed(5); return [1, 2, 3].map(() => engine.random.next()); };
        const same = JSON.stringify(seq()) === JSON.stringify(seq());
        engine.random.setSeed(9); engine.random.next(); const saved = engine.saves.collect();
        const a = engine.random.next(); engine.saves.apply(saved); const b = engine.random.next();
        const auto = () => { engine.random.setSeed(7); engine.weather.set('clear', { seconds: 0.01 }); engine.weather.auto = true; engine.step(0.1); return engine.weather.name; };
        const w1 = auto(), w2 = auto(); engine.weather.auto = false;
        engine.freeze('xtest'); const t0 = engine.time.now('real'), c0 = engine.clock.now; engine.step(1);
        const frozen = engine.time.now('real') === t0 && engine.clock.now === c0; engine.stacks.get('freeze').release('xtest');
        engine._unhalt();
        return { jobsDone, stream, same, resume: a === b, w1, w2, frozen };
      });
      check('generator jobs in step ignore real time and finish in one frame', r.jobsDone, JSON.stringify(r));
      check('stream sync build: built, ready and in the scene when step returns', r.stream.built && r.stream.ready && r.stream.inScene, JSON.stringify(r.stream));
      check('engine.random: same seed gives same sequence; continues the sequence after load', r.same && r.resume, JSON.stringify(r));
      check('auto weather uses engine.random (same seed, same result)', r.w1 === r.w2, JSON.stringify(r));
      check('elapsed and clock.now both stop while frozen', r.frozen, JSON.stringify(r));
    },
  },
  {
    name: 'X：读档（函数定时按剩余时间、vars 往返）、阴影开关、手柄键、显示名',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        let fired = 0; engine.clock.after(10, () => fired++);
        const d = engine.saves.collect(); d.parts.time.channels.calendar = engine.clock.now - 1000;
        engine.saves.apply(d); engine.step(5); const early = fired; engine.step(6); const late = fired;
        engine.vars.setFlag('xKeep'); engine.vars.bump('xCount', 3);
        engine.saves.apply(engine.saves.collect());
        const varsOk = engine.vars.flag('xKeep') === true && engine.vars.counter('xCount') === 3;
        const L = new threedogTest.THREE.PointLight(); L.castShadow = false; engine.add(L);
        engine.mod('shadows.enabled', { owner: 'ctest', set: false }).remove();   // off, then the handle gives the switch back
        const shadows = { game: L.castShadow, sun: engine.lights.sun.castShadow }; engine.remove(L);
        engine.input.bind('xPad', ['KeyZ', 'PadY']);
        const pad = { custom: engine.input.keysOf('xPad').includes('PadY'), noPhoto: !engine.input.keysOf('photo').length || engine.input.keysOf('photo').every(k => !k.startsWith('Pad') || k === 'PadRB') };
        engine.modules.get('weather').applyState(engine, { weather: 'rain' });
        const d2 = engine.describe(), label = d2.weather.label, text = engine.describeText();
        engine._unhalt();
        return { early, late, varsOk, shadows, pad, label, textHas: text.includes('Weather: rain'), isDay: engine.sky.isDay === engine.sky.daylight > 0 };
      });
      check('function-type after expires by remaining time after load', r.early === 0 && r.late === 1, JSON.stringify(r));
      check('vars: apply(collect()) keeps flags and counters', r.varsOk, JSON.stringify(r));
      check('shadows.enabled off then back on: lights the game turned off stay off, the sun is restored', r.shadows.game === false && r.shadows.sun === true, JSON.stringify(r.shadows));
      check('gamepad buttons go in the bound key list; the engine adds no pad key to photo', r.pad.custom && r.pad.noPhoto, JSON.stringify(r.pad));
      check('weather display name comes from the string table (describe label); describeText is developer English and names the id', r.label === '雨' && r.textHas, JSON.stringify(r));
      check('sky.isDay agrees with daylight', r.isDay);
    },
  },
  {
    name: 'startup time (numbers are only reported, no threshold)',
    url: '/',
    async run({ check, ev, page }) {
      for (const [name, url] of [['open world', '/'], ['city', '/tests/city/index.html']]) {
        if (url !== '/') { await page.goto(page.url().replace(/\/[^/]*$/, url)); await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 }); }
        const s = await ev(() => engine.startup);
        check(`${name}: open to playable ${s?.totalMs} ms (start to playable ${s?.startMs} ms, first-screen chunks ${s?.modules.terrain?.ready ?? '—'} ms)`, !!s);
      }
    },
  },
];
