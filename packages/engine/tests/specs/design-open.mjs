// What a game may do without the engine stopping it or silently undoing it (design review 2026-11-05). Each check is one way a game was blocked: a frame write that
// lost a value, a throw where the game runs fine, a saved record that failed only after a load.
export const specs = [
  {
    name: '[guard] applyState: a save that did not load and a new game that failed are refused, the title stays, and the rest of the call stands',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const E = engine, out = {};
        out.missing = await E.applyState({ save: 'no-such-slot', pos: '3,4' });
        out.placedTo = E.player ? Math.round(E.player.position.x) : 3;
        const quiet = console.error; console.error = () => {};
        const part = E.saves.define('ao-bad', { save: () => ({ n: 1 }), load() { throw new Error('part broke'); } });
        await E.saves.save('ao-slot');
        out.threw = await E.applyState({ save: 'ao-slot' });
        part.remove({ keep: false }); console.error = quiet;
        const newGame = E.session.newGame, isOpen = E.ui.isOpen, closed = [], close = E.ui.close;
        E.session.newGame = async () => false; E.ui.isOpen = n => n === 'title' || isOpen.call(E.ui, n); E.ui.close = n => { closed.push(n); };
        out.play = await E.applyState({ play: 1 });
        E.session.newGame = async () => true;
        out.good = await E.applyState({ play: 1 });
        out.closed = closed;
        E.session.newGame = newGame; delete E.ui.isOpen; delete E.ui.close;
        return out;
      });
      const J = JSON.stringify, one = (a, key) => a.ok === false && a.refused.length === 1 && a.refused[0].key === key;
      check('a missing slot is refused and says why', one(r.missing, 'save') && /missing/.test(r.missing.refused[0].reason), J(r.missing));
      check('the rest of the call stands', r.placedTo === 3, r.placedTo);
      check('a save that failed while loading is refused too', one(r.threw, 'save'), J(r.threw));
      check('a new game that failed is refused', one(r.play, 'play'), J(r.play));
      check('the title closes only for the new game that worked', r.good.ok === true && r.closed.join() === 'title', J({ good: r.good, closed: r.closed }));
    },
  },
  {
    name: '[guard] a game\'s own value stays: sunDir and aspect yield, a lost signal write warns, sky and applyState refuse without throwing',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        const out = {}, warns = [], w = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); w(...a); };
        const threw = f => { try { f(); return ''; } catch (e) { return e.message; } };
        // the sun: a direct write on either name stays, and the hand-back computes it again
        engine.sky.sunDir.set(1, 0, 0); engine.step(0.05); engine.step(0.05);
        out.sun = engine.uniforms.uSunDir.value.toArray(); out.same = engine.sky.sunDir === engine.uniforms.uSunDir.value;
        engine.autoView.manual('sunDir', false); engine.step(0.05); out.sunBack = engine.sky.sunDir.x;
        // aspect: a letterbox survives a resize
        engine.camera.aspect = 2.5; engine.camera.updateProjectionMatrix();
        const c = engine.renderer.domElement;
        engine.renderer.setSize(c.clientWidth - 8, c.clientHeight - 8, false); engine._resize(); out.aspect = engine.camera.aspect;
        engine.autoView.manual('aspect', false);
        // a write that loses says so, with the entry
        engine.uniforms.uSkyTop.value.setHex(0xff0000); engine.uniforms.uDaylight.value = 0.123; engine.step(0.05); engine.step(0.05);
        out.topWarn = warns.some(s => s.includes('uSkyTop') && s.includes('engine.sky.top')); out.dayWarn = warns.some(s => s.includes('uDaylight'));
        // sky entries that had no reason to throw
        const a = engine.sky.environment(), b = threw(() => engine.sky.environment({ interval: 3 })); a.remove(); out.env = b; out.envOn = !!engine.sky._env; engine.sky._envOff();
        out.layer = threw(() => engine.sky.layer('极光', null));
        console.warn = w;
        return out;
      });
      check('sunDir: a direct write stays through frames, one vector under two names', Math.abs(r.sun[0] - 1) < 1e-6 && r.sun[1] === 0 && r.same, JSON.stringify(r));
      check('sunDir: handing it back computes the sun again', r.sunBack !== 1, JSON.stringify(r));
      check('camera.aspect: a game value survives a resize', r.aspect === 2.5, JSON.stringify(r));
      check('uSkyTop and uDaylight: a lost write warns with the entry', r.topWarn && r.dayWarn, JSON.stringify(r));
      check('sky.environment twice replaces, the old handle changes nothing', !r.env && r.envOn, JSON.stringify(r));
      check('sky.layer takes any name', !r.layer, r.layer);
    },
  },
  {
    name: '[guard] applyState: season with no calendar and an unknown at are refused, and the rest of the call stands',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        const calendar = !!engine.calendar, places = !!engine.content;
        const res = await engine.applyState(calendar ? { time: '09:00' } : { time: '09:00', season: 'winter' });
        return { calendar, places, res, time: engine.sky.fixedTime };
      });
      check('season refused, not thrown, and time still applied', r.calendar || (r.res.refused?.some?.(x => x.key === 'season') && Math.abs(r.time - 0.375) < 1e-6), JSON.stringify(r));
    },
  },
  {
    name: '[guard] world data: an unsaved record holds anything, a saved one is refused at once with a line to copy',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, engine = mk(T.createEngine, 'design-world', {});
        engine.use(T.world()); await engine.start();
        const V = engine.camera.position.constructor, Mesh = engine.camera.constructor, threw = f => { try { f(); return ''; } catch (e) { return e.message; } };
        const at = await engine.applyState({ at: 'zz-nowhere' }).then(r => JSON.stringify(r), e => `threw: ${e.message}`);
        return { at, ...engine.ops.allow(() => ({
          temp: threw(() => engine.world.add({ kind: 'zz-temp', mesh: new Mesh(), dir: new V() }, { save: false })),
          vec: threw(() => engine.world.add({ kind: 'zz-saved', dir: new V() })),
          mesh: threw(() => engine.world.add({ kind: 'zz-saved', mesh: new Mesh() })),
          pos: threw(() => engine.world.add({ kind: 'zz-ok', position: new V(1, 0, 2), data: { a: [1, { b: 2 }] } })),
        })) };
      });
      check('applyState({ at }) nothing knows is refused, never thrown', !r.at.startsWith('threw') && r.at.includes('zz-nowhere'), r.at);
      check('{ save: false } may hold a mesh', !r.temp, r.temp);
      check('a Vector3 in a saved record is refused now, not after a load', /Vector3/.test(r.vec) && r.vec.includes('{ x, y, z }'), r.vec);
      check('the refusal shows the line to copy', r.mesh.includes("world.present('crate', { build: rec => mesh })"), r.mesh);
      check('position stays free and plain data passes', !r.pos, r.pos);
    },
  },
];
