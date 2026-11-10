// Group P4 (docs/plans/research/2026-11-10-health-check-b-picture.md 5, 6, 11; health-check-a HC4): tier defaults follow engine.tier, the engine sun keeps maxFar
// on a low-tier single map, and a photo never lowers a larger shadow map. One test item per fix so one throw stops no other; each fails with only its own fix reverted.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group P4 5a: the engine sun\'s shadow map follows the tier; a size the game wrote stays',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-sun');
        E.tier = 'high'; const high = E.lights.sun.shadow.mapSize.x;
        E.tier = 'low'; const low = E.lights.sun.shadow.mapSize.x;
        E.tier = 'high'; const back = E.lights.sun.shadow.mapSize.x;
        E.lights.sun.shadow.mapSize.set(4096, 4096);   // the game's own size
        E.tier = 'low'; const kept = E.lights.sun.shadow.mapSize.x;
        E.dispose();
        return { high, low, back, kept };
      });
      check('2048 on high, 1024 on low, 2048 again; a written 4096 stays', r.high === 2048 && r.low === 1024 && r.back === 2048 && r.kept === 4096, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 5b: the weather\'s default particle count follows the tier; a given count stays',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const count = E => E.weather.particles.rain.count;
        const types = { clear: {}, rain: { rain: 1 } };
        const E = mk(T.createEngine, 'p4-weather');
        E.tier = 'high';
        E.use(T.weather({ types, start: 'rain' }));
        await E.start(); E.haltLoop();
        const high = count(E); E.tier = 'low'; const low = count(E); E.tier = 'high'; const back = count(E);
        E.dispose();
        const G = mk(T.createEngine, 'p4-weather-given');
        G.tier = 'high';
        G.use(T.weather({ types, start: 'rain', particles: 777 }));
        await G.start(); G.haltLoop();
        G.tier = 'low'; const given = count(G);
        G.dispose();
        return { high, low, back, given };
      });
      check('6000 on high, 3000 on low, 6000 again; weather({ particles: 777 }) stays 777', r.high === 6000 && r.low === 3000 && r.back === 6000 && r.given === 777, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 5c: the sky environment\'s default rebuild interval follows the tier, built before or after the change; a given one stays',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-env');
        E.tier = 'high';
        E.use(T.sky({ time: '12:00' }));
        await E.start(); E.haltLoop();
        E.sky.environment({ interval: 2 });
        const given = E.sky._env.interval; E.tier = 'low'; const givenLow = E.sky._env.interval;
        E.sky.environment(); const lowStart = E.sky._env.interval;   // asked while low, then the tier goes up
        E.tier = 'high'; const high = E.sky._env.interval;
        E.dispose();
        return { given, givenLow, lowStart, high };
      });
      check('a given 2 stays 2; default: 4 while low, 1 once the tier goes high', r.given === 2 && r.givenLow === 2 && r.lowStart === 4 && r.high === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 5d: terrain\'s low-tier color map follows the tier (all chunks rebuilt); a resolution the game gave stays',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const res = E => E.terrain.drawPart._config.get().colorResolution;
        const E = mk(T.createEngine, 'p4-terrain');
        E.tier = 'high';
        E.use(T.terrain({ height: () => 0, viewChunks: 2, shading: 'texture' }));
        await E.start(); E.haltLoop();
        const high = res(E); E.tier = 'low'; const low = res(E); E.tier = 'high'; const back = res(E);
        E.dispose();
        const G = mk(T.createEngine, 'p4-terrain-given');
        G.tier = 'high';
        G.use(T.terrain({ height: () => 0, viewChunks: 2, shading: 'texture', colorResolution: 100 }));
        await G.start(); G.haltLoop();
        G.tier = 'low'; const given = res(G);
        G.dispose();
        return { high, low, back, given };
      });
      check('unset on high, 64 on low, unset again; a given 100 stays', r.high == null && r.low === 64 && r.back == null && r.given === 100, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 5e: a tier change while the height map loads leaves the heights intact and the workers at the new resolution',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-terrain-load');
        E.tier = 'high';
        const c = document.createElement('canvas'); c.width = c.height = 4; c.getContext('2d').fillRect(0, 0, 4, 4);
        E.use(T.terrain({ viewChunks: 2, shading: 'texture', heightmap: { url: c.toDataURL(), size: [100, 100], scale: 10 } }));
        const decode = Image.prototype.decode;
        Image.prototype.decode = function () { E.tier = 'low'; return decode.call(this); };   // the tier changes while the image is loading
        try { await E.start(); } finally { Image.prototype.decode = decode; }
        E.haltLoop();
        const g = E.terrain.generator.config, d = E.terrain.drawPart._config.get();
        const out = { workerRes: g.colorResolution, workerData: !!g.heightmap?.data, cfgRes: d.colorResolution, cfgData: !!d.heightmap?.data };
        E.dispose();
        return out;
      });
      check('64 and the height data in both the workers copy and the live config', r.workerRes === 64 && r.workerData && r.cfgRes === 64 && r.cfgData, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 6b: an extent the game set on the engine sun wins over maxFar, before or after the cascades, and stays when they are removed',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-sunbox2');
        E.tier = 'low';
        const sc = E.lights.sun.shadow.camera;
        const b = E.shadows.box(E.lights.sun, { extent: 40 });   // the game's own extent first
        const h = E.shadows.cascades(E.lights.sun, { count: 3, maxFar: 90 }); const before = sc.right;
        h.remove(); const afterRemove = sc.right; b.remove();
        const h2 = E.shadows.cascades(E.lights.sun, { count: 3, maxFar: 90 });
        const b2 = E.shadows.box(E.lights.sun, { extent: 50 });   // set while the cascades are on
        h2.remove(); const late = sc.right;
        b2.remove();
        E.dispose();
        return { before, afterRemove, late };
      });
      check('40 stays 40 through the cascades; an extent set meanwhile (50) is left as the game set it', r.before === 40 && r.afterRemove === 40 && r.late === 50, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 6: cascades on the engine sun keep maxFar on a low-tier single map, and remove puts the 30 m box back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-sunbox');
        E.tier = 'low';
        const sc = E.lights.sun.shadow.camera, base = sc.right;
        const h = E.shadows.cascades(E.lights.sun, { count: 3, maxFar: 90 });   // low: one map unless the game says so
        const during = sc.right;
        h.set({ maxFar: 60 }); const set = sc.right;
        h.remove(); const after = sc.right;
        E.dispose();
        return { base, during, set, after };
      });
      check('30 m baseline, 90 then 60 with the cascades, 30 again after remove', r.base === 30 && r.during === 90 && r.set === 60 && r.after === 30, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P4 11: a photo raises a small shadow map to the photo size and never lowers a larger one; both come back',
    url: PAGE,
    software: true,   // toDataURL reads the canvas: stays on software rendering
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'p4-photo');
        E.tier = 'high';
        E.use(T.photo({ shadowMapSize: 4096 }));
        const sun = E.lights.sun, seen = [];
        E.shadows.mapSize(sun, 2048);   // set here, so this item does not depend on the tier following (5a)
        const shoot = () => { seen.length = 0; E.photo._shoot(E.photo._opts({}), 1, () => seen.push(sun.shadow.mapSize.x), true); return seen[0]; };
        const small = shoot(), smallAfter = sun.shadow.mapSize.x;
        E.shadows.mapSize(sun, 8192);
        const large = shoot(), largeAfter = sun.shadow.mapSize.x;
        E.dispose();
        return { small, smallAfter, large, largeAfter };
      });
      check('2048 -> 4096 during the shot, back to 2048; 8192 stays 8192 during and after', r.small === 4096 && r.smallAfter === 2048 && r.large === 8192 && r.largeAfter === 8192, JSON.stringify(r));
    },
  },
];
