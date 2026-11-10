// 所有权（core/ops/owned.js）："不许绕开"的检查。每个登记过的引擎自写属性都必须在 CASES 里有一条用例，
// 否则第一条检查就失败——新登记一个属性却不写用例，过不了。每条用例跑三步：
//   (a) 游戏不接管直接写 → 引擎让开，值留着，恰好一条警告且含接管原文
//   (b) engine.autoView.manual(key) → 引擎不再写，也不警告
//   (c) manual(key, false) 交还 → 引擎恢复驱动
// 另有原生对拍：同一个小场景，纯 three.js 渲染和引擎（画面捷径全关）渲染，像素一致。
// Same format as the other files here.

// 每个 id：poke = 游戏直接写（返回写进去的值），get = 读当前值，drive = 让引擎有机会写一次（一帧，或该属性的引擎写入点）
const CASES = `({
  'shadow.follow': { poke: () => (engine.lights.sun.target.position.x = 9999), get: () => engine.lights.sun.target.position.x,
    manual: on => engine.shadows.box(engine.lights.sun, { follow: on === false ? 'focus' : false }) },
  'background': { poke: () => (engine.scene.background = window.__bg ??= new __threedogThree.Color(0.9, 0.1, 0.1)), get: () => engine.scene.background,
    // with the dome the sky does not write scene.background; it draws over it. Owned means: game takes it -> dome hides, hand back -> dome shows
    // no manual verb: a direct write is the takeover, engine.sky.replace(null) the hand-back
    engineWrites: () => !!engine.sky._backdrop || !!engine.sky.skybox, domeShown: () => engine.sky.dome.visible, handBack: () => engine.sky.replace(null) },
  'view.fov': { setup: () => (window.__fov0 = engine.camera.fov), poke: () => (engine.camera.fov = 33), get: () => engine.camera.fov,
    drive: () => engine._oFov.drive(61.5), teardown: () => engine._oFov.drive(window.__fov0) },
  'view.aspect': { poke: () => (engine.camera.aspect = 2.5), get: () => engine.camera.aspect, drive: () => engine._oAspect.drive(1.5) },
  'sky.sunDir': { poke: () => (engine.sky.sunDir.set(1, 0, 0), 1), get: () => engine.sky.sunDir.x, drive: () => engine.step(0.05) },
  // the environment map: only built on the game's call, written into the into it hands over; a game's own map there is the game's (the sky yields), a manual() or a new explicit call hands it back
  'sky.environment': { setup: () => { window.__env = engine.sky.environment({ into: engine.scene, interval: 0.01 }); }, poke: () => (engine.scene.environment = window.__envOwn ??= new __threedogThree.Texture()), get: () => engine.scene.environment,
    drive: () => engine.step(0.1, { render: true }), manual: on => engine.sky._oEnv.manual(on !== false), handBack: () => engine.sky._oEnv.manual(false),
    teardown: () => { window.__env.remove(); engine.scene.environment = null; } },
  'view.far': { poke: () => (engine.camera.far = 4321), get: () => engine.camera.far, drive: () => engine.viewFar(engine.camera.far + 100) },
  'view.pixelRatio': { poke: () => { engine.renderer.setPixelRatio(0.77); return 0.77; }, get: () => engine.renderer.getPixelRatio(),
    drive: () => { const a = engine.adaptive, was = { on: a.on, min: a.min }; Object.assign(a, { on: true, cooldown: 0, t: 0, age: 10, min: 0.3 }); engine._adapt(1, 1000, false, true); Object.assign(a, was); } },   // one heavy 1 s window past the startup grace
  // written once at creation, never per frame: drive = describe() (the read that notices a direct write); quiet = the yield warns nothing,
  // because a direct renderer.toneMapping write is the documented way to change the curve; no game verb hands it back (look.tone is gone), the row's own hand-back still writes the creation curve
  'toneMapping': { poke: () => (engine.renderer.toneMapping = __threedogThree.NeutralToneMapping), get: () => engine.renderer.toneMapping, drive: () => engine.describe(), quiet: true, handBack: () => engine._oTone.manual(false) },
  'camera': { skip: 'tests/specs/b.mjs "[guard] Camera" (the vehicle page has a camera module)' },
  // never yields (a write to post.object() is replaced on the next chain change, post-fuse.mjs); manual() is checked on both backends there
  'post.chain': { skip: 'tests/specs/post-webgpu.mjs "[guard] post on WebGPU" (own() stops rebuilds)' },
})`;

import { readFileSync } from 'node:fs';

export const specs = [
  {
    name: '[guard] owned: every engine-written property yields to a direct write (one warning with the takeover call), manual() stops the engine, manual(k, false) hands back',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async (CASES) => {
        await engine.loading.settled();
        engine.haltLoop(); engine.step(0.05);
        const C = (0, eval)(CASES), owned = engine.describe().owned, out = { missing: Object.keys(owned).filter(id => !C[id]), rows: {} };
        const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-3 : a === b);
        for (const [id, row] of Object.entries(owned)) {
          const c = C[id];
          if (!c || c.skip) continue;
          const part = c.manual ? { manual: (k, on) => c.manual(on) } : row.part === 'view' ? engine.autoView : null, drive = c.drive ?? (() => engine.step(0.05));
          const res = out.rows[id] = {};
          c.setup?.(); drive(); drive();
          // (a) direct write: the engine yields, the value stays, one warning naming the takeover
          let v;
          const a = await __t.warns(() => { v = c.poke(); drive(); drive(); });
          res.a = { yielded: engine.describe().owned[id].writer, stays: near(c.get(), v), warns: a.warns.filter(w => w.includes(`${id} was changed outside`) && w.includes(row.manual)).length, quiet: !!c.quiet };
          if (c.domeShown) res.a.domeHidden = !c.domeShown();
          // (c) hand back: the engine drives it again (the value moves off the game's)
          (c.handBack ?? (() => part.manual(row.key, false)))(); drive(); drive();
          res.c = { by: engine.describe().owned[id].writer, moved: c.engineWrites && !c.engineWrites() ? c.domeShown() : !near(c.get(), v) };
          // (b) manual: the engine stops, no warning, describe().owned says manual:game
          if (part) {
            const b = await __t.warns(() => { part.manual(row.key); v = c.poke(); drive(); drive(); });
            res.b = { by: engine.describe().owned[id].writer, stays: near(c.get(), v), warns: b.warns.filter(w => w.includes(id)).length };
            part.manual(row.key, false); drive();
          }
          c.teardown?.();
        }
        let typo = '', none = ''; try { engine.autoView.manual('fa'); } catch (err) { typo = err.message; }
        try { engine.autoView.manual(); } catch (err) { none = err.message; }
        out.typo = typo; out.none = none;
        out.ids = Object.keys(owned);
        out.writer = (() => { const h = engine.autoView.manual('far'), o = engine.describe().owned['view.far'].writer; h.remove(); return [o, engine.describe().owned['view.far'].writer]; })();
        return out;
      }, CASES);
      check('every registered owned property has a case here (registering one without a test fails)', r.missing.length === 0, JSON.stringify(r.missing));
      const rows = Object.entries(r.rows);
      check('rows ran (sky page: shadow.follow, background, view.far, view.pixelRatio ...)', rows.length >= 5, rows.map(([k]) => k).join());
      for (const [id, x] of rows) {
        check(`${id} (a): direct write -> engine yields, value stays, exactly one warning with the takeover call (none for a quiet once-written one)`, /yielded/.test(x.a.yielded) && x.a.stays && x.a.warns === (x.a.quiet ? 0 : 1) && x.a.domeHidden !== false, JSON.stringify(x.a));
        check(`${id} (c): manual(key, false) -> the engine drives it again`, x.c.by === 'engine' && x.c.moved, JSON.stringify(x.c));
        if (x.b) check(`${id} (b): manual(key) -> the engine stops writing, no warning, describe().owned says manual:game`, x.b.by === 'manual:game' && x.b.stays && x.b.warns === 0, JSON.stringify(x.b));
      }
      // the ownership table in recipe 52 must list every registered id (camera too: registered on camera-module pages); read here in node
      const md = readFileSync(new URL('../../docs/recipes/52-around-the-picture.md', import.meta.url), 'utf8');
      const undocumented = [...r.ids, 'camera'].filter(id => !md.includes('| `' + id + '`'));
      check('recipe 52 "Who writes it" lists every registered id', undocumented.length === 0, JSON.stringify(undocumented));
      check('engine.autoView.manual: a typo throws with the keys, no key throws, remove() hands back, describe().owned shows the writer', /keys: .*far/.test(r.typo) && /key must be/.test(r.none) && r.writer.join() === 'manual:game,engine', JSON.stringify([r.typo, r.none, r.writer]));
    },
  },
  {
    // The template writes scene.background in picture/, before engine.start(): every other case here writes after two frames, so they cannot see this window
    name: '[guard] owned: scene.background written before the first frame (after sky(), or before it) takes the background like a write during play',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all;
        const run = async (key, before, after) => {
          const E = mk(T.createEngine, key);
          before?.(E);
          E.use(T.sky());
          after?.(E);
          await E.start(); E.step(0.05); E.step(0.05);
          const o = { dome: E.sky.dome.visible, writer: E.describe().owned.background.writer, red: E.scene.background?.r === 1 };
          E.dispose();
          return o;
        };
        const red = E => { E.scene.background = new THREE.Color(1, 0, 0); };
        return { none: await run('own-bg-0'), after: await run('own-bg-1', null, red), before: await run('own-bg-2', red),
          dim: await run('own-bg-3', null, E => { E.scene.backgroundIntensity = 0.5; }),
          viaSky: await run('own-bg-4', null, E => { E.sky.backdrop = 0x00ff00; }) };
      });
      check('nothing written: the dome shows and the engine holds the row', r.none.dome && r.none.writer === 'engine', JSON.stringify(r.none));
      check('written after sky(), before start: the dome hides, the value stays, describe says the game wrote it', !r.after.dome && r.after.red && /yielded/.test(r.after.writer), JSON.stringify(r.after));
      check('written before sky(): the same', !r.before.dome && r.before.red && /yielded/.test(r.before.writer), JSON.stringify(r.before));
      check('backgroundIntensity counts as the background too', !r.dim.dome && /yielded/.test(r.dim.writer), JSON.stringify(r.dim));
      check("a backdrop through engine.sky stays the engine's (not mistaken for an outside write)", r.viaSky.writer === 'engine' && !r.viaSky.dome, JSON.stringify(r.viaSky));
    },
  },
  {
    name: "[guard] parity: a small scene in plain three.js and in the engine with the picture shortcuts off render the same pixels (the engine adds nothing hidden)",
    url: '/tests/parity/index.html',
    software: true,   // compares pixels; the read happens inside the page's parity()
    async run({ check, ev }) {
      const r = await ev(() => window.parity());
      check('engine vs plain three.js: mean channel difference < 0.5, max < 8 (of 255)', r.mean < 0.5 && r.max < 8 && r.lit > 0.2, JSON.stringify(r));
    },
  },
  {
    name: "[guard] parity on WebGPU: the same scene, createEngine({ renderer: 'webgpu' }) vs a plain WebGPURenderer on the same backend, same pixels",
    url: '/tests/parity/index.html?backend=webgpu',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.parity());
      console.log('  webgpu parity numbers:', JSON.stringify(r));
      check(`engine (${r.backend}) vs plain WebGPURenderer: mean channel difference < 0.5, max < 8 (of 255)`,
        ['webgpu', 'webgl2'].includes(r.backend) && r.mean < 0.5 && r.max < 8 && r.lit > 0.2, JSON.stringify(r));
      // the tier is known only after init() on WebGPU; the MSAA default must follow it (it once kept the pre-init 'high' guess: edge pixels off by 126)
      check('MSAA default follows the tier detected after init (low -> off)', r.engine.msaa === (r.engine.tier !== 'low'), JSON.stringify(r.engine));
    },
  },
];
