// [guard] Plugins composed (outside review of 0.4.0, 2026-11-03): several plugins on one picture must switch off and on without side effects.
// Why a guard: four gaps were found with real plugin code. Post effects with no distinct order came back in a new place after off / on (the
// list still said A, B); the plugins of one style pack shared one owner, so switching B off also dropped A's material; turning a material
// patch plugin off left the materials already made with the patch (a streamed world got mixed looks); off('<pack>') did not say that the
// pack's starting values stay. If any of these comes back, or off / on stops giving back the exact picture, this fails.
// Page: perf city (WebGL, real picture / plugin / patch code). Same format as the other files here.

/** Shared by the pixel items: render the engine at a small fixed size, read every pixel, compare two reads */
const PIX = `(() => {
  const R = engine.renderer, gl = R.getContext(), W = 64, H = 48, size = R.getSize(new threedogTest.THREE.Vector2());
  R.setSize(W, H, false); engine.post.antialias = false;
  const read = () => { engine.step(1 / 60, { describe: false }); const b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
  const diff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
  return { read, diff, done: () => R.setSize(size.x, size.y, false) };
})()`;

export const specs = [
  {
    name: '[guard] plugins composed: post effects keep their place across off / on; handle.enabled is a pause, plugins.off an unload',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.loading.settled(); engine.haltLoop();
        const { ShaderPass, CopyShader } = threedogTest, out = {};
        const fx = n => ({ name: n, slot: 'ldr', create: () => new ShaderPass(CopyShader) });   // no order of its own: ties decide
        engine.plugins.add({ './plugins/60-pa.js': { default: fx('pa') }, './plugins/61-pb.js': { default: fx('pb') } });
        const order = () => engine.post.list().filter(x => /^p[ab]$/.test(x.name)).map(x => x.name).join();
        out.start = order();
        out.offResult = engine.plugins.off('60-pa');
        out.offOrder = order();
        engine.plugins.on('60-pa'); out.back = order();
        engine.post.get('pa').enabled = false; engine.post.get('pa').enabled = true; out.paused = order();
        engine.plugins.off('60-pa'); engine.plugins.off('61-pb');
        return out;
      });
      console.log('  plugin post order:', JSON.stringify(r));
      check('A, B with no order render A then B; after off(A) / on(A) still A then B (the place is the registration place)', r.start === 'pa,pb' && r.offOrder === 'pb' && r.back === 'pa,pb', JSON.stringify(r));
      check('handle.enabled = false / true keeps the place too', r.paused === 'pa,pb', r.paused);
      check('off() returns what it did: the plugins it took out and how to pause instead', r.offResult?.off?.join() === '60-pa' && r.offResult.note?.includes("engine.post.get('pa').enabled = false"), JSON.stringify(r.offResult));
    },
  },
  {
    name: '[guard] plugins composed: each plugin is its own owner (B off gives A back, not the base); the same key from two plugins is a conflict unless one replaces the other',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, ShaderPass, CopyShader } = threedogTest, out = {};
        const err = async f => { try { await f(); return ''; } catch (e) { return e.message; } };
        const mk = (plugins, key) => { const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: key + performance.now() });
          e.plugins.add(plugins); return e; };
        const effect = tag => ({ name: 'tint', tag, create: () => new ShaderPass(CopyShader) });
        const red = () => effect('red'), blue = () => effect('blue');
        // two plugins naming one effect, neither says it replaces the other: a dev conflict naming both
        const c = mk({ './plugins/10-a.js': { default: red() }, './plugins/20-b.js': { default: blue() } }, 'pc-conflict');
        out.conflict = await err(() => c.start());
        c.dispose?.();
        // B declares it replaces A: B wins while on; B off gives A's red back (A still on); both off gives the base
        const e = mk({ './plugins/10-a.js': { default: red() }, './plugins/20-b.js': { default: blue(), replaces: '10-a' } }, 'pc-replace');
        await e.start();
        const hex = () => e.post._list.find(h => h.name === 'tint')?._def.tag ?? 'none';
        out.both = hex();
        out.offB = e.plugins.off('20-b'); out.afterB = hex(); out.aOn = e.plugins.list().find(p => p.name === '10-a')?.on;
        e.plugins.on('20-b'); out.backB = hex();
        e.plugins.off('20-b'); e.plugins.off('10-a'); out.base = hex();
        e.dispose?.();
        return out;
      });
      console.log('  plugin owners:', JSON.stringify(r));
      check('two plugins naming the same effect: the second fails at start, naming both files, the effect and the way out', /plugins\/20-b\.js/.test(r.conflict) && /plugins\/10-a\.js/.test(r.conflict) && /'tint' is already added/.test(r.conflict) && /export const replaces/.test(r.conflict), r.conflict);
      check('B (replaces A) wins; B off gives A\'s red with A still on; B on again is blue', r.both === 'blue' && r.afterB === 'red' && r.aOn === true && r.backB === 'blue', JSON.stringify(r));
      check('both off gives the base', r.base === 'none', r.base);
    },
  },
  {
    software: true,   // reads rendered pixels: stays on software rendering (same pixels on every machine)
    name: '[guard] plugins composed (WebGL pixels): sky + weather + fog, bloom + grading + grain over a material with wind + cloud shadow: each plugin off changes the picture, on gives the exact previous picture, the post order stays',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async PIX => {
        await engine.loading.settled(); engine.haltLoop();
        const { THREE, postEffects: E, applyEffects } = threedogTest, out = {};
        const hold = engine.freeze('pc-pixels', { still: true }), px = (0, eval)(PIX);   // wind, clouds, weather stand still: two reads differ only by the plugins
        // material + wind + cloud shadow: a crate in front of the camera with both effects
        const cam = engine.camera, ahead = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(4).add(cam.position);
        const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), applyEffects(new THREE.MeshLambertMaterial({ color: 0xaa8855 }), { wind: 0.05, clouds: true, engine }));
        crate.position.copy(ahead); engine.add(crate, { id: 'pcomb-crate' });
        // fog as a module plugin (it writes scene.fog and puts the old one back on dispose), with the page's sky and weather running
        const fogRule = { name: 'pcFog', type: 'picture', install(en) { this.old = en.scene.fog; this.en = en; en.scene.fog = new __threedogThree.Fog('#ff00ff', 1, 30); }, dispose() { this.en.scene.fog = this.old; } };
        engine.plugins.add({
          './plugins/80-fog.js': { default: fogRule },
          './plugins/82-bloom.js': { default: E.bloom({ strength: 0.8, threshold: 0.2 }) },
          './plugins/83-grade.js': { default: E.lut({ contrast: 1.3, saturation: 0.6, temperature: 0.4 }) },
          './plugins/84-grain.js': { default: E.grain({ amount: 0.15, animated: false }) },
        });
        const order = () => engine.post.list().map(x => x.name).join();
        const base = px.read(), order0 = order();
        out.rows = {};
        for (const n of ['80-fog', '82-bloom', '83-grade', '84-grain']) {
          engine.plugins.off(n); const off = px.read();
          engine.plugins.on(n); const on = px.read();
          out.rows[n] = { changed: px.diff(base, off), back: px.diff(base, on), order: order() === order0 };
        }
        px.done(); hold?.remove?.();
        for (const n of ['80-fog', '82-bloom', '83-grade', '84-grain']) engine.plugins.off(n);
        engine.remove(crate);
        return out;
      }, PIX);
      console.log('  plugin combos:', JSON.stringify(r));
      for (const [n, x] of Object.entries(r.rows)) {
        check(`${n}: off changes the picture, on gives the exact previous picture, the post order is the same`, x.changed > 2 && x.back === 0 && x.order, JSON.stringify(x));
      }
    },
  },
  {
    software: true,   // reads rendered pixels: stays on software rendering (same pixels on every machine)
    name: '[guard] plugins composed on WebGPU and WebGL: two post plugins whose result depends on their order keep it across off / on, and on gives the picture back',
    url: '/tests/engine-webgpu/index.html',
    async run({ check, ev }) {
      const r = await ev(() => window.pluginOrderRoutes());
      console.log('  plugin order routes:', JSON.stringify(r));
      for (const k of ['gl', 'gpu']) {
        const x = r[k];
        check(`${k}: half then lift (plugin order); each off changes the picture, on gives it back (as close as two untouched frames) and the order stays`,
          x.order === 'half,lift' && ['60-half', '61-lift'].every(n => x[n].changed > 5 && x[n].back <= Math.max(x.still, 0.05) && x[n].order), JSON.stringify(x));
      }
    },
  },
];
