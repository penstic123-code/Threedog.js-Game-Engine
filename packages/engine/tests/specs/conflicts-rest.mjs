// [guard] What the 2026-11-05 conflicts review found fighting, one check per fix (docs/testing/review/2026-11-05-conflicts.md).
export const specs = [
  {
    name: '[guard] conflicts V1: engine.setPixelRatio is a ceiling adaptive resolution keeps, like the raw three.js call',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const w0 = console.warn; console.warn = () => {};
        try {
          engine.haltLoop();
          const a = engine.adaptive, pr = () => engine.renderer.getPixelRatio(), max0 = a.max;
          const feed = (secs, gap, cost) => { for (let t = 0; t < secs; t += gap) engine._adapt(gap, cost, false, true); };
          Object.assign(a, { on: true, target: 60, t: 0, good: 0, cooldown: 0, lowered: false, from: null, age: 10, costs: [], gaps: [], refresh: Infinity });
          const want = 0.9;   // under the old ceiling, so a raise back to it shows
          engine.setPixelRatio(want);
          feed(120, 1 / 60, 3); const cheap = pr();
          feed(4, 1 / 60, 40); const heavy = pr();   // it may still lower: the game set the top, not a lock
          feed(120, 1 / 60, 3); const back = pr();
          const writer = engine.describe().owned['view.pixelRatio'].writer;
          a.on = false; engine.setPixelRatio(max0);
          return { want, cheap, heavy, back, writer };
        } finally { console.warn = w0; }
      });
      const J = JSON.stringify(r);
      check('120 s of cheap frames leave the ratio the game set', r.cheap === r.want, J);
      check('overload still lowers it', r.heavy < r.want, J);
      check('cheap frames raise it back only to what the game set', r.back === r.want, J);
      check('adaptive stays the writer: its own writes are not outside writes', r.writer === 'engine', J);
    },
  },
  {
    name: 'settings: a graphics row the game omits has no control, and no preset, stored value or reset moves it',
    url: '/tests/settings/index.html?pixel=1',
    async run({ page, check, ev }) {
      const r = await ev(() => {
        const S = engine.settings, ratio = () => engine.renderer.getPixelRatio(), start = ratio();
        S.open();
        const set = [...S.win.el.querySelectorAll('[data-set], [data-range]')].map(c => c.dataset.set ?? c.dataset.range);
        S.close();
        S.preset('low'); const low = ratio(), shadows = S.get('shadows'); S.reset();
        localStorage.setItem(S.storageKey, JSON.stringify({ v: 2, values: { pixelRatio: 0.5, antialias: true } }));
        return { start, low, reset: ratio(), shadows, set };
      });
      check('the omitted rows are gone, the others stay', !['pixelRatio', 'antialias', 'adaptive'].some(k => r.set.includes(k)) && r.set.includes('quality') && r.set.includes('shadows'), JSON.stringify(r.set));
      check('a preset leaves the ratio alone and sets the rest', r.low === r.start && r.reset === r.start && r.shadows === false, JSON.stringify(r));
      await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, { timeout: 60000 });
      const after = await ev(() => { const o = { ratio: engine.renderer.getPixelRatio() }; localStorage.removeItem(engine.settings.storageKey); return o; });
      check('a stored value of an omitted row is not applied', after.ratio === r.start, JSON.stringify([after, r.start]));
      const err = await ev(() => { try { new engine.settings.constructor(engine, { sections: [{ id: 'graphics', omit: ['scale'] }] }); return ''; } catch (x) { return x.code + ' ' + x.message; } });
      check('a row name that does not exist throws and lists the rows', /^settings-tab .*pixelRatio/.test(err), err);
    },
  },
  {
    name: '[guard] conflicts V2: settings keep only what the player changed; presets are shares of the default ratio; get(pixelRatio) is the real ratio',
    url: '/tests/settings/index.html',
    async run({ page, check, ev }) {
      const reload = async () => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, { timeout: 60000 }); };
      const file = () => ev(() => JSON.parse(localStorage.getItem(engine.settings.storageKey) || '{}'));
      const J = JSON.stringify;
      await ev(() => { engine.settings.reset(); engine.settings.set('vol.music', 0.25); });
      let f = await file();
      check('one volume change stores that volume, no graphics value', Object.keys(f.values).join() === 'vol.music', J(f));

      const base = await ev(() => engine.adaptive.max);
      await ev(() => engine.settings.preset('high'));
      f = await file();
      check('high never renders above the default ratio', await ev(() => engine.renderer.getPixelRatio()) === base, base);
      check('a preset stores its name, not a ratio: the next device works it out again', f.values.quality === 'high' && !('pixelRatio' in f.values), J(f));
      await ev(() => engine.settings.preset('low'));
      check('low is a share of the default ratio', await ev(() => engine.renderer.getPixelRatio()) === +(0.75 * base).toFixed(2), base);
      await reload();
      check('the preset comes back on the next launch', await ev(() => engine.settings.get('quality')) === 'low' && await ev(() => engine.renderer.getPixelRatio()) === +(0.75 * base).toFixed(2), base);

      const seen = await ev(() => {
        const w0 = console.warn; console.warn = () => {};
        try {
          const a = engine.adaptive, keep = a.on; engine.settings.reset();
          Object.assign(a, { on: true, target: 60, t: 0, cooldown: 0, age: 10, costs: [], gaps: [], min: 0.3 });
          for (let i = 0; i < 20; i++) engine._adapt(0.1, 60, false, true);
          const out = { get: engine.settings.get('pixelRatio'), scale: engine.describe().render.scale.current, quality: engine.settings.get('quality') };
          a.on = keep; engine.settings.reset();
          return out;
        } finally { console.warn = w0; }
      });
      check('while adaptive lowers the ratio the setting says the same as describe().render.scale', seen.get === seen.scale && seen.get < base, J(seen));
      check('adaptive lowering it is not the player picking custom', seen.quality !== 'custom', J(seen));

      await ev(() => engine.settings.set('pixelRatio', 0.8));
      await reload();
      check('a ratio the player chose survives a reload, and adaptive keeps it as its top', await ev(() => [engine.renderer.getPixelRatio(), engine.adaptive.max].join()) === '0.8,0.8');
      await ev(() => engine.settings.reset('pixelRatio'));
      f = await file();
      check('reset forgets it', !('pixelRatio' in f.values) && await ev(() => engine.renderer.getPixelRatio()) === base, J(f));

      // a file from 0.8 or older held every value: only what differs from the default can be the player's
      await ev(b => { localStorage.setItem(engine.settings.storageKey, JSON.stringify({ v: 1, values: { pixelRatio: b, shadows: true, 'vol.music': 0.3, quality: 'custom' }, bindings: {} })); }, base);
      await reload();
      await ev(() => engine.settings.save());
      f = await file();
      check('an old file keeps the changed value and lets go of the rest', f.values['vol.music'] === 0.3 && !('pixelRatio' in f.values) && !('shadows' in f.values) && !('quality' in f.values), J(f));
      await ev(() => { localStorage.removeItem(engine.settings.storageKey); });
    },
  },
  {
    name: "[guard] conflicts D2: a game's mesh.layers write while occlusion hides the mesh stands",
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const THREE = __threedogThree, o = engine.occlusion, m = new THREE.Mesh(), it = { meshes: [m] };
        const round = write => { m.layers.set(0); o._hide(it); write?.(); o._show(it); return Object.hasOwn(m.layers, 'test') ? -1 : m.layers.mask; };
        return { plain: round(), set: round(() => m.layers.set(3)), enable: round(() => m.layers.enable(2)) };
      });
      const J = JSON.stringify(r);
      check('nothing written: the mask comes back', r.plain === 1, J);
      check('layers.set while hidden is the game taking the mask', r.set === 1 << 3, J);
      check('layers.enable while hidden keeps the old layers too', r.enable === (1 | 1 << 2), J);
    },
  },
  {
    name: "[guard] conflicts D3: hlod hides far originals by layer: their visible is never touched, a layer write stands, occlusion watches what is drawn",
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const h = engine.hlod;
        await new Promise(res => { const t = () => (h.cells.length && !engine.jobs.pending ? res() : setTimeout(t, 50)); t(); });
        engine.haltLoop();
        const b = engine.level.root.getObjectByName('b_3_3'), o = engine.occlusion, out = {};
        const cell = h.cells.find(c => c.originals.includes(b));
        const items = () => [...o._items].filter(it => it.meshes.includes(b) || it.meshes.includes(cell.proxy[0])).map(it => it.meshes.includes(b) ? 'originals' : 'proxy').join();
        out.own = !!Object.getOwnPropertyDescriptor(b, 'visible').get;
        out.patch = engine.describe().threePatches.some(p => p.id === 'hlod-visible');
        engine.focus.set(0, 0, 0); engine.step(0.5); out.nearItems = items();
        engine.focus.set(400, 0, 400); engine.step(0.5);
        out.far = { visible: b.visible, drawn: b.layers.test(engine.camera.layers), ray: engine.raycast([b.position.x, 200, b.position.z], [0, -1, 0])?.object?.name, items: items() };
        b.layers.enable(4);
        engine.focus.set(0, 0, 0); engine.step(0.5);
        out.back = b.layers.mask; b.layers.disable(4);
        engine.focus.set(400, 0, 400); engine.step(0.5);
        b.layers.set(0);   // a plain three.js write while far: the game takes the mesh back
        engine.focus.set(0, 0, 0); engine.step(0.5); out.set = b.layers.mask;
        engine._unhalt();
        return out;
      });
      const J = JSON.stringify(r);
      check('visible is a plain three.js field, no hlod-visible patch', !r.own && !r.patch, J);
      check('far: visible stays true, the camera does not draw it, a ray hits it', r.far.visible && !r.far.drawn && r.far.ray === 'b_3_3', J);
      check('occlusion watches originals near, the proxy far', r.nearItems === 'originals' && r.far.items === 'proxy', J);
      check('near again: the old layer back, plus what the game enabled meanwhile', r.back === (1 | 1 << 4), J);
      check('layers.set while far stands', r.set === 1, J);
    },
  },
  {
    // 不许绕开：hlod 收下的网格，batching 之后再也不能把它合进批里（等凑够份数的那种也不行），否则远处同时画替身和批里那一份
    name: '[guard] conflicts: a mesh hlod takes while batching waits for more copies never joins a batch later, and joins once hlod lets go',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const B = engine.batching, was = B.enabled;
        B.enabled = true;
        const src = engine.level.root.getObjectByName('b_3_3'), Mesh = src.constructor, Group = engine.level.root.constructor;   // the page has no THREE global
        const geo = src.geometry.clone(), mat = src.material.clone();
        const root = n => { const g = new Group(), m = new Mesh(geo, mat); m.position.set(300 + n * 2, 0, 300); g.add(m); g.userData.batch = true; engine.scene.add(g); return g; };
        const first = root(0);
        engine.step(1 / 30);
        const waiting = !!B._entryOf(first.children[0]) && !first.children[0].userData.batched;
        const h = engine.hlod.add(first);
        const rest = []; for (let i = 1; i < 40; i++) rest.push(root(i));
        engine.step(1 / 15);
        const out = { waiting, firstBatched: !!first.children[0].userData.batched, restBatched: rest.filter(g => g.children[0].userData.batched).length };
        h.remove(); engine.step(1 / 15);   // hlod lets go: batching is told, as add() tells it, and takes the copy into the batch beside it
        out.afterRemove = !!first.children[0].userData.batched;
        for (const g of [first, ...rest]) g.removeFromParent();
        engine.step(1 / 30);
        B.enabled = was;
        return out;
      });
      const J = JSON.stringify(r);
      check('batching was holding the first copy, waiting for more', r.waiting, J);
      check('after hlod.add it stays out of the batch the later copies make; the others batch', !r.firstBatched && r.restBatched > 0, J);
      check('after hlod remove() batching takes it again', r.afterRemove, J);
    },
  },
  {
    name: '[guard] conflicts little use: the unused names stay gone',
    url: '/tests/settings/index.html',
    async run({ check, ev }) {
      const r = await ev(() => ({ paused: 'paused' in engine.adaptive, section: 'removeSection' in engine.settings }));
      check('adaptive.paused and settings.removeSection are not there', !r.paused && !r.section, JSON.stringify(r));
    },
  },
];
