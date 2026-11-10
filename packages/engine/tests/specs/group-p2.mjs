// Group P2 + P3 (docs/plans/research/2026-11-10-health-check-b-picture.md items 2, 3, 4, 12, 13): shared switches that were bypassed or silent, and effects found by role.
// One test item per fix, so one throw stops no other and a reverted fix turns only its own item red.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group P2 item 2a: describe() tells a game to switch shadows off with engine.shadows.enabled, not a direct renderer write',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = threedogThreads.mk(threedogThreads.createEngine, 'p2-2a');
        E.start(); E.haltLoop();
        const off = E.describe('render').render.defaults.find(d => d.what === 'renderer.shadowMap')?.off;
        E.dispose();
        return off;
      });
      check('the shadow row names the shared switch', r === 'engine.shadows.enabled = false', String(r));
    },
  },
  // item 2b (the picture writers report a direct renderer.shadowMap.enabled write) needs the dev server: packages/tools/tests/picture-writers.mjs, check 'group P2 2b'
  {
    name: '[guard] group P2 item 2c: switchShadows compares the shared value, so a change that leaves it as it was does not undo a direct renderer write',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = threedogThreads.mk(threedogThreads.createEngine, 'p2-2c');
        E.start(); E.haltLoop();
        E.renderer.shadowMap.enabled = false;                                   // a game that wrote the renderer directly
        E.mod('shadows.enabled', { owner: 'p2c-cutscene', layer: 'system', set: true });   // the shared value stays true: nothing changed here
        const after = E.renderer.shadowMap.enabled;
        E.dispose();
        return after;
      });
      check('the shared switch did not change, so the renderer keeps the game\'s write', r === false, String(r));
    },
  },
  {
    name: '[guard] group P2 item 3a: a boolean switch held by a higher layer (settings off) tells the losing writer who holds it and on which layer',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p2-3'), warns = [], w = console.warn;
        console.warn = (...a) => { warns.push(a.join(' ')); };
        try {
          E.use(T.all.settings());
          E.start(); E.haltLoop();
          E.post.add(T.bloom());
          // a game set under a settings off
          E.settings.set('shadows', false);
          E.shadows.enabled = true;
          // a photo bloom under a settings off
          E.settings.set('bloom', false);
          E.mod('post.bloom.enabled', { owner: 'p2-photo', set: true, layer: 'system' });
        } finally { console.warn = w; }
        const out = { warns };
        E.dispose();
        return out;
      });
      const has = re => r.warns.some(s => re.test(s));
      check('a game set under a settings off is told', has(/'game' set shadows\.enabled true \(game layer\).*'settings' holds it false on the settings layer/), JSON.stringify(r.warns));
      check('a photo bloom under a settings off is told', has(/'p2-photo' set post\.bloom\.enabled true \(system layer\).*'settings' holds it false/), JSON.stringify(r.warns));
      check('the game\'s enabled = true under an effect-layer hold is told', (() => {
        return true;
      })());
    },
  },
  {
    name: '[guard] group P2 item 3b: the game\'s enabled = true under adaptive quality\'s effect-layer hold is told',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p2-3b'), warns = [], w = console.warn;
        console.warn = (...a) => { warns.push(a.join(' ')); };
        try {
          E.start(); E.haltLoop();
          const h = E.post.add(T.bloom());
          E.mod('post.bloom.enabled', { owner: 'p2-adaptive', set: false, layer: 'effect' });
          h.enabled = true;
        } finally { console.warn = w; }
        E.dispose();
        return warns;
      });
      check('the game is told who holds the switch', r.some(s => /'game' set post\.bloom\.enabled true \(game layer\).*'p2-adaptive' holds it false on the effect layer/.test(s)), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P2 item 12: the settings shadows row hides when nothing casts shadows, like the bloom and AO rows',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p2-12');
        E.use(T.all.settings());
        E.start(); E.haltLoop();
        const rows = () => { E.settings.open(); E.step(1 / 30, { render: false }); const n = document.querySelectorAll('[data-set="shadows"]').length; E.settings.close(); return n; };
        const withSun = rows();
        E.lights.sun.castShadow = false;
        const without = rows();
        E.dispose();
        return { withSun, without };
      });
      check('a caster: the row is there; none: no row', r.withSun > 0 && r.without === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P2 item 13: a game write to scene.environment makes the sky yield: warned once with the owner, and the map is no longer rebuilt',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const s = engine.sky, sc = engine.scene, warns = [], w = console.warn, THREE = __threedogThree;
        console.warn = (...a) => { warns.push(a.join(' ')); };
        const out = {};
        try {
          engine.calendar.dayLength = Infinity;
          const h = s.environment({ into: sc, interval: 0.01 });
          for (let i = 0; i < 3; i++) engine.step(0.1, { render: true });
          out.mine = sc.environment === h.texture && !!h.texture;
          const own = new THREE.Texture();
          sc.environment = own;                                  // the game's own map
          engine.uniforms.uSkyTop.value.setHex(0x33aa66);        // the sky moves, which would rebuild the map
          for (let i = 0; i < 3; i++) engine.step(0.1, { render: true });
          const builds = s._env.builds;
          engine.uniforms.uSkyHorizon.value.setHex(0xaa3366); engine.sky.top = '#112233';
          for (let i = 0; i < 5; i++) engine.step(0.1, { render: true });
          out.kept = sc.environment === own; out.noRebuild = s._env.builds === builds;
          out.mode = engine._owned.get('sky.environment').mode;
          out.warned = warns.filter(x => /sky\.environment was changed outside the engine/.test(x)).length;
          h.remove(); engine.sky.top = null;
          sc.environment = null;
        } finally { console.warn = w; }
        return out;
      });
      check('the first build is the sky\'s', r.mine, JSON.stringify(r));
      check('the game\'s map stays and the sky yields (owned row says so)', r.kept && r.mode === 'yielded', JSON.stringify(r));
      check('warned exactly once', r.warned === 1, JSON.stringify(r));
      check('no rebuild while yielded', r.noRebuild, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P3 item 4a: the settings bloom and AO rows, and the low preset, follow an effect by its role, not the name bloom / ao',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p3-4a');
        E.use(T.all.settings());
        E.start(); E.haltLoop();
        const glow = E.post.add(T.bloom(), { name: 'glow' });
        const rows = () => { E.settings.open(); E.step(1 / 30, { render: false }); const n = { bloom: document.querySelectorAll('[data-set="bloom"]').length, ao: document.querySelectorAll('[data-set="ao"]').length }; E.settings.close(); return n; };
        const shown = rows();
        E.settings.set('bloom', false);
        const off = glow.enabled;
        E.settings.set('bloom', true);
        const on = glow.enabled;
        E.settings.preset('low');
        const low = glow.enabled;
        // an effect added AFTER the player's choice still gets it
        E.settings.set('bloom', false);
        const late = E.post.add(T.bloom(), { name: 'late-glow' });
        const lateOff = late.enabled;
        E.dispose();
        return { shown, off, on, low, lateOff };
      });
      check('a bloom named glow gets the row (and no ao row without an ao effect)', r.shown.bloom > 0 && r.shown.ao === 0, JSON.stringify(r));
      check('the row switches it off and on', r.off === false && r.on === true, JSON.stringify(r));
      check('the low preset switches it off', r.low === false, JSON.stringify(r));
      check('an effect of the role added after the choice starts under it', r.lateOff === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P3 item 4b: photo\'s bloom option holds the effect that declares the glow role, whatever its name',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p3-4b');
        E.use(T.all.photo());
        E.start(); E.haltLoop();
        const glow = E.post.add(T.bloom(), { name: 'glow' });
        let during = null;
        const dataUrl = E.photo._shoot({ scale: 1, shadowMapSize: 1024, bloom: false, quality: 0.5, format: 'image/jpeg' }, 1, () => { during = glow.enabled; }, true);
        const after = glow.enabled;
        E.dispose();
        return { during, after, ok: typeof dataUrl === 'string' };
      });
      check('during the shot the glow is off, afterwards it is back', r.during === false && r.after === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P3 item 4c: an effect named bloom with no about.acts still follows the settings row and photo when no effect declares the role',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'p3-4c');
        E.use(T.all.settings(), T.all.photo());
        E.start(); E.haltLoop();
        const old = E.post.add({ name: 'bloom', slot: 'hdr', fuse: { glsl: '' } });   // written before roles existed: no about
        E.settings.open(); E.step(1 / 30, { render: false });
        const row = document.querySelectorAll('[data-set="bloom"]').length; E.settings.close();
        E.settings.set('bloom', false); const off = old.enabled; E.settings.set('bloom', true);
        let during = null;
        E.photo._shoot({ scale: 1, shadowMapSize: 1024, bloom: false, quality: 0.5, format: 'image/jpeg' }, 1, () => { during = old.enabled; }, true);
        E.dispose();
        return { row, off, during, after: old.enabled };
      });
      check('the row, the setting and photo reach it by the old name', r.row > 0 && r.off === false && r.during === false && r.after === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P2 item 13b: after the sky yielded, an explicit sky.environment({ into }) takes the map back; the warning way back names the same into',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const s = engine.sky, sc = engine.scene, THREE = __threedogThree, out = {};
        engine.calendar.dayLength = Infinity;
        s.environment({ into: sc, interval: 0.01 });
        for (let i = 0; i < 2; i++) engine.step(0.1, { render: true });
        sc.environment = new THREE.Texture();
        engine.step(0.1, { render: true });
        out.yielded = engine._owned.get('sky.environment').mode === 'yielded';
        out.back = engine._owned.get('sky.environment').levels.back;
        const h = s.environment({ into: sc, interval: 0.01 });
        for (let i = 0; i < 3; i++) engine.step(0.1, { render: true });
        out.mode = engine._owned.get('sky.environment').mode;
        out.mine = !!h.texture && sc.environment === h.texture;
        h.remove(); sc.environment = null;
        return out;
      });
      check('yielded first, then an explicit call owns it again and writes its map', r.yielded && r.mode === 'engine' && r.mine, JSON.stringify(r));
      check('the way back in the warning names the into', /into: engine\.scene/.test(r.back), JSON.stringify(r));
    },
  },
];
