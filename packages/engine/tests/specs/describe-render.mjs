// describe().render: current renderer / post / light values, each tagged engine | style | game (core/inspect/describeRender.js).
export const specs = [
  {
    name: '[guard] describe picture: values set directly on three.js objects are what describe().picture reports, with no engine call in between',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const T = __threedogThree, R = engine.renderer, S = engine.scene;
        const was = { tone: R.toneMapping, exposure: R.toneMappingExposure, fog: S.fog, bg: S.background, env: S.environment, envI: S.environmentIntensity, type: R.shadowMap.type, on: R.shadowMap.enabled };
        R.toneMapping = T.CineonToneMapping; R.toneMappingExposure = 0.00125;
        S.fog = new T.FogExp2(0x123456, 0.0375); S.background = new T.Color(0xabcdef);
        S.environment = new T.Texture(); S.environmentIntensity = 0.625;
        R.shadowMap.type = T.BasicShadowMap;
        const lamp = new T.PointLight(0xff8000, 7.25); lamp.name = 'guardLamp'; lamp.castShadow = true; S.add(lamp);
        const hidden = new T.Group(); hidden.visible = false; const off = new T.SpotLight(0x00ff00, 2); off.name = 'guardOff'; hidden.add(off); S.add(hidden);
        const a = engine.describe('picture').picture;
        S.fog = new T.Fog(0x654321, 3, 90); S.background = null; S.environment = null;
        const b = engine.describe('picture').picture, text = engine.describeText({ full: true });
        S.remove(lamp); S.remove(hidden);
        const c = engine.describe('picture').picture;
        R.toneMapping = was.tone; R.toneMappingExposure = was.exposure; S.fog = was.fog; S.background = was.bg; S.environment = was.env; S.environmentIntensity = was.envI;
        R.shadowMap.type = was.type; R.shadowMap.enabled = was.on;
        return { a, b, c, text };
      });
      const lamp = r.a.lights.find(l => l.name === 'guardLamp'), off = r.a.lights.find(l => l.name === 'guardOff');
      check('tone mapping and exposure, full precision', r.a.toneMapping === 'cineon' && r.a.exposure === 0.00125, JSON.stringify([r.a.toneMapping, r.a.exposure]));
      check('FogExp2: type, color, density', r.a.fog?.type === 'FogExp2' && r.a.fog.color === '#123456' && r.a.fog.density === 0.0375, JSON.stringify(r.a.fog));
      check('Fog: type, color, near, far', r.b.fog?.type === 'Fog' && r.b.fog.color === '#654321' && r.b.fog.near === 3 && r.b.fog.far === 90, JSON.stringify(r.b.fog));
      check('environment present and intensity', r.a.environment.present === true && r.a.environment.intensity === 0.625 && r.b.environment.present === false, JSON.stringify([r.a.environment, r.b.environment]));
      check('background', r.a.background?.type === 'Color' && r.a.background.color === '#abcdef' && r.b.background === null, JSON.stringify([r.a.background, r.b.background]));
      check('a light the game added: type, color, intensity, castShadow', lamp?.type === 'PointLight' && lamp.color === '#ff8000' && lamp.intensity === 7.25 && lamp.castShadow === true && lamp.visible === true, JSON.stringify(lamp));
      check('a light under a hidden group is listed as not visible', off?.visible === false && off.castShadow === false, JSON.stringify(off));
      check('a removed light is gone from the list', !r.c.lights.some(l => l.name === 'guardLamp'));
      check('shadows: enabled and type', r.a.shadows.type === 'basic' && typeof r.a.shadows.enabled === 'boolean', JSON.stringify(r.a.shadows));
      check('full text has the scene line', /^scene: background none fog Fog #654321 3\.\.90 environment none$/m.test(r.text), r.text.split('\n').find(l => l.startsWith('scene:')));
    },
  },
  {
    name: 'describe render: values listed, a change made by the game is tagged game (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const before = engine.describe().render;
        // tone mapping is plain three.js (written once at creation, never again): the game's direct write shows as game and stays after frames
        const m0 = engine.renderer.toneMapping;
        engine.renderer.toneMapping = __threedogThree.NeutralToneMapping; engine.step(0.05); engine.step(0.05);
        const after = engine.describe().render, kept = engine.renderer.toneMapping === __threedogThree.NeutralToneMapping;
        const text = engine.describeText({ full: true });
        engine.renderer.toneMapping = m0;
        return { before, after, kept, text };
      });
      check('tone mapping untouched is not tagged game', r.before.toneMapping.writer !== 'game');
      check('renderer.toneMapping written by the game: tagged game, never overwritten by the engine', r.after.toneMapping.value === 'neutral' && r.after.toneMapping.writer === 'game' && r.kept, JSON.stringify(r.after.toneMapping));
      check('post and lights lists present', Array.isArray(r.before.post) && Array.isArray(r.before.lights) && r.before.lights.length > 0);
      check('default lights are marked engine-default', r.before.lights.every(l => l.source === 'engine-default'));
      check('full text has the renderer line', /^renderer: /m.test(r.text));
    },
  },
  {
    name: 'describe holds: halt / freeze / camera / debug view owners come in one shape (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const none = engine.describe().holds;
        const p = engine.haltLoop('t-halt'), f = engine.freeze('t-freeze'), c = engine.takeCamera('t-cam'), v = engine.debug.view('normals', { owner: 't-view' });
        const held = engine.describe().holds;
        p.remove(); f.remove(); c.remove(); engine.debug.clear('t-view');
        return { none, held, after: engine.describe().holds };
      });
      const shape = o => Array.isArray(o) && o.every(x => typeof x.owner === 'string' && typeof x.at === 'string');
      check('each kind lists its owner', ['halt', 'freeze', 'camera', 'debugView'].every(k => r.held[k]?.[0]?.owner === 't-' + (k === 'debugView' ? 'view' : k === 'camera' ? 'cam' : k)), JSON.stringify(r.held));
      check('every kind has the same [{ owner, at }] shape', Object.values(r.held).every(shape), JSON.stringify(r.held));
      check('released claims leave the list', !r.after.halt && !r.after.freeze && !r.after.camera && !r.after.debugView, JSON.stringify(r.after));
    },
  },
  {
    name: 'render scale: describe().render.scale says upscaled / auto-lowered / floor, and the first auto-lowering warns once (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const warns = [], w0 = console.warn; console.warn = (...a) => { warns.push(String(a[0])); };
        try {
          engine.haltLoop();
          const dpr = devicePixelRatio || 1, base = engine.describe().render.scale;
          const a = engine.adaptive; a.on = true; a.target = 60; a.lowered = false; a.from = null; a.age = 10;   // past the startup grace
          const max = a.max; engine.setPixelRatio(max);
          const slow = () => { for (let i = 0; i < 10; i++) engine._adapt(0.1, 60, false, true); };   // 60 ms frames with GPU time known: overload
          slow(); slow();
          const low = engine.describe().render.scale;
          const text = engine.describeText({ full: true });
          engine.setPixelRatio(max); a.on = false;
          return { dpr, base, low, max, warns: warns.filter(x => /lowered automatically/.test(x)), text };
        } finally { console.warn = w0; }
      });
      check('scale lists current / devicePixelRatio / upscaled / floor', r.base.devicePixelRatio === r.dpr && typeof r.base.upscaled === 'boolean' && r.base.floor === 0.6, JSON.stringify(r.base));
      check('after auto-lowering: autoLowered and upscaled are true', r.low.autoLowered === true && r.low.current < r.max && r.low.upscaled === true, JSON.stringify(r.low));
      check('one dev warning names the change, the fps and how to turn it off', r.warns.length === 1 && /->/.test(r.warns[0]) && /adaptiveResolution: false/.test(r.warns[0]), JSON.stringify(r.warns));
      check('the text summary says so too', /render scale: .*auto-lowered/.test(r.text));
    },
  },
  {
    // W8: every engine module reports itself (rule R44 enforces the hook exists; this checks the hooks answer with their fields on a real page),
    // and "who set it" is `writer` everywhere: no `by` key anywhere in describe() (style values under `value` are data, not a who field)
    name: 'describe hooks: ambience / collision / music / particles / photo / rigid / water / settings report their state, no `by` key left (example world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        if (engine.particles.effects.has('dust')) engine.particles.emit('dust', engine.player.position, { count: 12 });
        const d = engine.describe(), keys = o => (o && typeof o === 'object' ? Object.keys(o).sort().join() : String(o));
        const byPaths = [];
        (function walk(o, path) {
          if (!o || typeof o !== 'object') return;
          for (const [k, v] of Object.entries(o)) { if (k === 'by') byPaths.push(path + '.by'); if (k !== 'value') walk(v, path + '.' + k); }
        })(d, 'describe()');
        const pick = n => (d[n] === undefined ? 'missing' : keys(d[n]));
        return { mods: Object.fromEntries(['ambience', 'collision', 'music', 'particles', 'photo', 'rigid', 'water', 'settings', 'debugPanel'].map(n => [n, pick(n)])),
          hasDust: engine.particles.effects.has('dust'), live: d.particles?.alive.effects, sea: d.water?.sea, byPaths,
          tone: d.render?.toneMapping, exposure: d.render?.exposure, rendererExposure: engine.renderer.toneMappingExposure, run: d.time.run, installed: [...engine.modules.keys()] };
      });
      const want = { ambience: 'audioLocked,on,rules', collision: 'atPlayer,boxes,cameraOcclusion,circles,fields', music: 'current,ducked,gain,intensity,override,pending,playing,ready,ruled,stems,tracks',
        particles: 'alive,effects,emitters', photo: 'album,keyBound,last,maxAlbum,tracing', rigid: 'bodies,colliders,dynamic,fixed,frozen,ready,sleeping,vehicles', water: 'bodies,sea',
        settings: 'capturing,open,tab,values', debugPanel: 'open' };
      for (const [n, k] of Object.entries(want)) {
        if (n === 'debugPanel' && !r.installed.includes(n)) continue;   // dev builds only
        check(`describe().${n} has its fields`, r.mods[n] === k, `${r.mods[n]} (want ${k})`);
      }
      if (r.hasDust) check('particles: a burst shows in live', r.live?.dust > 0, JSON.stringify(r.live));
      check('water: the sea reports its level and size', typeof r.sea?.level === 'number' && r.sea.size > 0, JSON.stringify(r.sea));
      check('no `by` key anywhere in describe() (who set it = writer)', r.byPaths.length === 0, r.byPaths.join(', '));
      check('render: toneMapping says writer, exposure is the value on the renderer', typeof r.tone?.writer === 'string' && Math.abs(r.exposure?.value - r.rendererExposure) < 0.01, JSON.stringify([r.tone, r.exposure, r.rendererExposure]));
      check('time.run lists halt owners as owners', Array.isArray(r.run?.owners) && r.run.owners.length > 0, JSON.stringify(r.run));
    },
  },
  {
    name: "describe level + debug view 'triggers': level reports file / markers, the view draws the zones and 'off' clears them (level page)",
    url: '/tests/level/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const lv = engine.describe().level, zones = engine.triggers.list().length;
        const lines = () => engine.scene.getObjectByName('triggers-debug')?.children.length ?? 0;
        const on = engine.debug.view('triggers'), drawn = lines(), text = engine.describeText({ path: 'render' });
        engine.debug.view('off');
        return { lv, zones, on, drawn, after: lines(), text, modes: engine.debug.viewModes() };
      });
      check('describe().level: code-built scene (file null), ready, markers counted, spawn', r.lv?.file === null && r.lv.ready === true && r.lv.markers > 0 && typeof r.lv.spawn?.x === 'number', JSON.stringify(r.lv));
      check("'triggers' is a debug view mode", r.modes.includes('triggers') && r.on.mode === 'triggers', JSON.stringify(r.on));
      check('the view draws one wireframe per zone', r.zones > 0 && r.drawn === r.zones, `${r.drawn} / ${r.zones}`);
      check('describe().render says the triggers view is on', /DEBUG VIEW .*triggers/.test(r.text));
      check("view 'off' clears the wireframes", r.after === 0);
    },
  },
];
