// engine.sky.environment (modules/sky/environment.js): built only on the game's call, written only into what the game hands it, rebuilt on an interval not per frame,
// released on remove and dispose. The picture check is only "a frame renders"; the harness counts console errors as failures.

export const specs = [
  {
    name: '[guard] engine.sky.environment: with a sky and no call, scene.environment stays null for 10 frames and no PMREM is built; with into it is the handle\'s texture; remove frees it',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const s = engine.sky, sc = engine.scene, out = {};
        for (let i = 0; i < 10; i++) engine.step(1 / 30, { render: true });
        out.idle = [sc.environment, s._pmrem ?? null, s._env ?? null];
        const bg = sc.background, h = s.environment({ into: sc });
        out.on = [!!h.texture, sc.environment === h.texture, sc.background === bg];
        const t1 = h.texture, target = s._env.target; let freed = false; target.addEventListener('dispose', () => { freed = true; });
        engine.step(1 / 30, { render: true });
        out.sameTexture = h.texture === t1;
        h.remove();
        out.off = [sc.environment, freed, h.texture === t1 || h.texture === null, s._pmrem];
        h.remove();   // a second remove does nothing
        const a = s.environment({ into: sc }), b = s.environment({ into: sc, interval: 2 }); a.remove(); out.twice = !!s._env; b.remove();
        out.bad = ['intensity', 'interval'].map(k => { try { s.environment({ [k]: k === 'interval' ? -1 : 1 }); return ''; } catch (e) { return e.message; } });
        return out;
      });
      check('no call: 10 frames, scene.environment null, no generator, no map', r.idle.every(v => v === null), JSON.stringify(r.idle));
      check('with into: scene.environment is handle.texture, the background is not touched', r.on.every(Boolean), JSON.stringify(r.on));
      check('a second call replaces the first, and the old handle changes nothing', r.twice === true, String(r.twice));
      check('remove: scene.environment back to null, the target is freed, the generator gone', r.off[0] === null && r.off[1] && r.off[3] === null, JSON.stringify(r.off));
      check('unknown option names plain three.js; a bad interval throws', /environmentIntensity/.test(r.bad[0]) && /seconds/.test(r.bad[1]), JSON.stringify(r.bad));
    },
  },
  {
    name: '[guard] engine.sky.environment: without into nothing is written; a map the game writes stays; rebuilt only after interval and only when the sky changed; dispose frees it',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const s = engine.sky, cal = engine.calendar, sc = engine.scene, THREE = __threedogThree, out = {};
        cal.dayLength = Infinity;                     // the time is the calendar's: hold it, only the test moves it
        engine.weather.auto = false; engine.weather.set('clear', { seconds: 0.01 });   // cloud cover follows the weather, hold it too
        engine.step(1, { render: false });
        const h = s.environment({ interval: 1 });
        out.bare = [!!h.texture, sc.environment];
        const b0 = s._env.builds, first = h.texture;
        engine.step(0.2, { render: false }); engine.step(0.2, { render: false });
        out.idle = s._env.builds - b0;                // sky unchanged: no build
        cal.timeOfDay = (cal.timeOfDay + 0.2) % 1;
        engine.step(0.2, { render: false });
        out.early = s._env.builds - b0;               // changed, but the interval has not passed
        engine.step(1.2, { render: false });
        out.late = s._env.builds - b0;                // interval passed: one build
        out.live = h.texture !== first && !!h.texture;   // the getter follows the rebuild (this page is WebGL: three's WebGL generator returns a new target; WebGPU refills one, sky-tsl)
        engine.step(1.2, { render: false }); engine.step(1.2, { render: false });
        out.after = s._env.builds - b0;               // unchanged again: no build
        h.remove();
        // into: a map the game writes later stays through the rebuilds, and is not freed
        const h2 = s.environment({ into: sc, interval: 0 }), mine = new THREE.Texture(); let mineFreed = false; mine.addEventListener('dispose', () => { mineFreed = true; });
        sc.environment = mine;
        for (let i = 0; i < 5; i++) { cal.timeOfDay = (cal.timeOfDay + 0.05) % 1; engine.step(0.2, { render: false }); }
        out.mine = [sc.environment === mine, !!h2.texture && h2.texture !== mine];
        h2.remove(); out.mineAfter = [sc.environment === mine, mineFreed];
        sc.environment = null;
        const h3 = s.environment({ into: sc }), target = s._env.target; let freed = false; target.addEventListener('dispose', () => { freed = true; });
        engine.dispose();
        out.disposed = freed && sc.environment === null; out.h3 = h3.texture === target.texture;
        return out;
      });
      check('without into: handle.texture is there and scene.environment is not written', r.bare[0] && r.bare[1] === null, JSON.stringify(r.bare));
      check('sky unchanged: no rebuild', r.idle === 0, JSON.stringify(r));
      check('sky changed, interval not passed: no rebuild', r.early === 0, JSON.stringify(r));
      check('interval passed: one rebuild, then none while the sky stays; texture follows', r.late === 1 && r.after === 1 && r.live, JSON.stringify(r));
      check('a map the game wrote stays through rebuilds and after remove, never freed', r.mine.every(Boolean) && r.mineAfter[0] && !r.mineAfter[1], JSON.stringify([r.mine, r.mineAfter]));
      check('engine.dispose frees the map and clears what it wrote', r.disposed, JSON.stringify(r));
    },
  },
  {
    name: '[guard] engine.sky.environment: the default interval is 4 times longer on low tier, a given one stands',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'sky-env-tier');
        E.use(T.sky({ time: '12:00' }));
        const out = {};
        await E.start();
        const tier = Object.getOwnPropertyDescriptor(E, 'tier');
        Object.defineProperty(E, 'tier', { value: 'low', configurable: true });
        const h = E.sky.environment({ interval: 2 }); out.low = E.sky._env.interval; h.remove();
        const hd = E.sky.environment(); out.lowDefault = E.sky._env.interval; hd.remove();
        Object.defineProperty(E, 'tier', { value: 'high', configurable: true });
        const h2 = E.sky.environment({ interval: 2 }); out.high = E.sky._env.interval; h2.remove();
        if (tier) Object.defineProperty(E, 'tier', tier); else delete E.tier;
        return out;
      });
      check('a given interval stands on both tiers, the default is x 4 on low', r.low === 2 && r.high === 2 && r.lowDefault === 4, JSON.stringify(r));
    },
  },
];
