// Group E, environment modules (docs/plans/2026-11-09-group-e.md; GPT layer-2 review): a module takes back what it wrote, caches see every change,
// lifetimes end with the module. The WebGPU/WebGL particle checks are in fx-particles.mjs. Each check fails with its fix reverted.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[group E] a removed weather / sky gives its shared signals back; the last day / night source going leaves one neutral daylight',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'group-e-signals'), U = E.uniforms;
        E.use(T.sky({ time: '00:00' }), T.weather({ types: { clear: {}, storm: { snow: 1, wind: 3, cloud: 1, sun: 0.3, fog: 0.4 } }, start: 'storm' }));
        await E.start();
        E.step(0.5);
        out.storm = [U.uSnow.value, U.uWind.value, U.uWeatherCloud.value];
        out.night = [U.uDaylight.value, U.uNight.value, U.uTimeOfDay.value, U.uSkyTop.value.getHex()];
        E.unuse('weatherDraw'); E.unuse('weather'); E.step(0.1);
        out.weatherGone = [U.uSnow.value, U.uWind.value, U.uWeatherCloud.value, U.uWeatherLight.value, U.uWeatherFog.value];
        E.unuse('sky'); E.step(0.1); E.step(0.1);
        out.skyGone = [U.uDaylight.value, U.uNight.value, U.uTimeOfDay.value, U.uSkyTop.value.getHex(), U.uSkyHorizon.value.getHex()];
        E.dispose();
        return out;
      });
      check('the storm reached the signals first', r.storm[0] === 1 && r.storm[1] === 3 && r.storm[2] === 1, JSON.stringify(r.storm));
      check('a sky at midnight is dark', r.night[0] === 0 && r.night[1] === 1 && r.night[2] === 0, JSON.stringify(r.night));
      check('weather removed: uSnow / uWind / uWeatherCloud / light / fog are back to clear', r.weatherGone.join() === '0,1,0.25,1,1', JSON.stringify(r.weatherGone));
      check('the last day / night source removed: uDaylight 1, uNight 0, uTimeOfDay 0.5 together', r.skyGone[0] === 1 && r.skyGone[1] === 0 && r.skyGone[2] === 0.5, JSON.stringify(r.skyGone));
      check('sky removed: its colors are back to neutral', r.skyGone[3] === 0 && r.skyGone[4] === 0xe7e7e7, JSON.stringify(r.skyGone));
    },
  },
  {
    name: '[group E] a removed sky leaves what the game wrote or took: its own tint uniform and a sun direction taken with autoView.manual',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'group-e-sky-game'), U = E.uniforms;
        E.use(T.sky({ time: '12:00' }));
        await E.start();
        E.step(0.2);
        U.uFoliageTint.value.setRGB(1, 0, 0); U.uGroundMix.value = 0.4;   // the game paints the tint itself (the sky never did)
        E.autoView.manual('sunDir'); U.uSunDir.value.set(1, 0, 0);          // the game takes the sun
        E.step(0.2);
        E.unuse('sky'); E.step(0.1); E.step(0.1);
        const out = { tint: U.uFoliageTint.value.toArray(), mix: U.uGroundMix.value, sun: U.uSunDir.value.toArray() };
        E.dispose();
        return out;
      });
      check("the game's tint survives", r.tint.join() === '1,0,0' && r.mix === 0.4, JSON.stringify(r));
      check('the sun direction the game took survives', r.sun.join() === '1,0,0', JSON.stringify(r));
    },
  },
  {
    name: '[group E] calendar removed while the sky stays: no frame reads the neutral noon in between',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'group-e-swap'), U = E.uniforms;
        E.use(T.calendar({ time: '00:00', dayLength: 1000 }), T.sky({ time: '00:00' }));
        await E.start();
        E.step(0.2);
        const seen = [];
        E.onFrame(() => seen.push([U.uTimeOfDay.value, U.uDaylight.value]));
        E.unuse('calendar');
        for (let i = 0; i < 4; i++) E.step(0.1);
        const out = { seen };
        E.dispose();
        return out;
      });
      check('the hook ran every frame and always read midnight (never 0.5 / daylight 1)', r.seen.length >= 4 && r.seen.every(([t, d]) => t < 0.01 && d === 0), JSON.stringify(r.seen));
    },
  },
  {
    name: '[group E] sky environment map: a changed cloud color, sun brightness or dome layer uniform rebuilds it',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const s = engine.sky, cal = engine.calendar, THREE = __threedogThree, out = {};
        cal.dayLength = Infinity; engine.weather.auto = false; engine.weather.set('clear', { seconds: 0.01 });
        engine.step(1, { render: false });
        const h = s.environment({ interval: 0.1 }), b0 = s._env.builds;
        engine.step(0.3, { render: false }); const idle = s._env.builds - b0;
        const steps = [['uCloudColor', () => s.uniforms.uCloudColor.value.set(0xff0000)], ['uCloudCover', () => { s.uniforms.uCloudCover.value = 0.7; }],
          ['uSkyCloudSpeed', () => s.uniforms.uSkyCloudSpeed.value.set(0.1, 0.1)], ['uSunBrightness', () => { s.uniforms.uSunBrightness.value = 20; }],
          ['layer uniform', () => { s.layer('aurora', { glsl: 'vec4 threedogSkyLayer(vec3 d, float t, vec3 s, float n){ return vec4(uAur, 0.5); }', uniforms: { uAur: new THREE.Color(0x00ff00) } }); }]];
        out.idle = idle; out.steps = {};
        for (const [name, change] of steps) { const n0 = s._env.builds; change(); engine.step(0.3, { render: false }); out.steps[name] = s._env.builds - n0; }
        const n1 = s._env.builds; s.uniforms.uAur.value.set(0x0000ff); engine.step(0.3, { render: false }); out.steps.layerValue = s._env.builds - n1;
        h.remove(); s.layer('aurora', null);
        return out;
      });
      check('an unchanged sky builds nothing', r.idle === 0, String(r.idle));
      check('each of cloud color, cover, speed, sun brightness, a new layer and a layer\'s own uniform rebuilds once', Object.values(r.steps).every(n => n >= 1), JSON.stringify(r.steps));
    },
  },
  {
    name: '[group E] lightPool: changing glow gives the old stand-in back at its own brightness, also by day for a dusk source',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'group-e-glow');
        E.use(T.lightPool({ point: 1 }));
        const m = new THREE.MeshBasicMaterial(); m.opacity = 0.8;
        const h = E.lightPool.add({ x: 0, y: 3, z: 0 }, { intensity: 5, distance: 20, dusk: true, glow: m });
        E.step(0.5, { render: false });
        const byDay = m.opacity;   // no sky: day, a dusk lamp's stand-in is off
        h.set({ glow: null }); const after = m.opacity;
        E.dispose();
        return { byDay, after };
      });
      check('by day the stand-in is off', r.byDay === 0, JSON.stringify(r));
      check('a new glow (none) puts the old material back as it was added', r.after === 0.8, JSON.stringify(r));
    },
  },
  {
    name: '[group E] particle emitters stop when the group above their object leaves the scene',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'group-e-emitter');
        E.use(T.particles());
        E.particles.define('smoke', { max: 20, lifetime: [1, 1], speed: 0.5 });
        const group = new THREE.Group(), chimney = new THREE.Object3D(); group.add(chimney); E.scene.add(group);
        E.particles.attach('smoke', chimney, { rate: 10 });
        E.step(0.3, { render: false }); const on = E.particles.emitters.size;
        E.scene.remove(group); E.step(0.3, { render: false }); const off = E.particles.emitters.size;
        const cam = new THREE.Object3D(); E.camera.add(cam); E.particles.attach('smoke', cam, { rate: 10 });
        E.step(0.3, { render: false }); const carried = E.particles.emitters.size;
        E.dispose();
        return { on, off, carried };
      });
      check('running while the group is in the scene, removed once the group is out, one on the camera stays', r.on === 1 && r.off === 0 && r.carried === 1, JSON.stringify(r));
    },
  },
  {
    name: '[group E] photo: an album restore that finishes after the module is removed makes no Blob URL, and removal empties the album',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, made = [], real = URL.createObjectURL;
        const E = mk(T.createEngine, 'group-e-photo');
        E.use(T.photo());
        await E.start();
        URL.createObjectURL = b => { const u = real.call(URL, b); made.push(u); return u; };
        try {
          E.saves.attachments = async () => { await new Promise(r => setTimeout(r, 20)); return [{ id: 'a', blob: new Blob(['x']), meta: {}, at: 1 }]; };
          const ph = E.photo, p = ph.restore();
          E.unuse('photo');
          await p;
          return { made: made.length, album: ph.album.length };
        } finally { URL.createObjectURL = real; E.dispose(); }
      });
      check('no Blob URL after removal, album empty', r.made === 0 && r.album === 0, JSON.stringify(r));
    },
  },
  {
    name: '[group E] water: normalMap repeat 0 then a positive repeat leaves the UVs finite and scaled',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'group-e-water');
        E.use(T.water({ sea: false }));
        const body = E.addWaterBody({ position: [0, 0, 0], radius: 5, level: 1 });
        E.water.update(E.focus, 0);
        const mesh = [...E.water.bodies.values()][0];
        E.water.normalMap('n', { repeat: 0 });
        E.water.normalMap('n', { repeat: 0.5 });
        const uv = mesh.geometry.attributes.uv.array, finite = uv.every(Number.isFinite), max = Math.max(...uv);
        E.dispose();
        return { finite, max, body: !!body };
      });
      check('UVs finite and scaled by size * repeat again', r.finite && r.max > 0.5, JSON.stringify(r));
    },
  },
];
