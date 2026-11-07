// [守] shot 的画面检查（packages/tools/picture/check.mjs）：真引擎、真渲染，跑和 threedog shot 同一个页内探针 probePicture，再用同一个 pictureHints 出提示。
// 守的是"不许绕开"：不是喂假数字给 pictureHints，而是让探针自己把阴影强度调 0 对比像素，
// 所以 bias 把影子推没了这种"设置说有、画面没有"的矛盾，只有真量到才会报；正常场景不许报任何矛盾。
import { probeSource, pictureHints, pictureNumbers } from '@threedog/tools/picture-check';

const PAGE = '/tests/threads/';

const hintsOf = p => pictureHints({ numbers: pictureNumbers(new Uint8Array(64), 4), probe: p });
const ids = p => hintsOf(p).map(h => h.id);
const hintIn = (p, id) => hintsOf(p).find(h => h.id === id);

/** Each case on a fresh engine: build(T, E) places the objects (text, it runs in the page), the answer comes from the probe. kept: lights and layers are back after it */
async function shootCases(ev, cases) {
  return ev(async ([src, cases]) => {
    const probe = (0, eval)('(' + src + ')'), { mk } = threedogThreads, A = threedogThreads.all, T = __threedogThree, out = {};
    for (const [k, build] of Object.entries(cases)) {
      const E = mk(A.createEngine, `picture-edges-${k}`);
      E.scene.background = new T.Color(0x203040);
      E.camera.position.set(-6, 9, 13); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld();
      await E.start(); E.haltLoop();
      const after = (0, eval)('(' + build + ')')(T, E);   // a build may return what to undo once the probe is done
      E.step(1 / 30);
      const state = () => { const s = []; E.scene.traverse(o => s.push(o.layers.mask, o.visible, ...(o.isLight ? o.position.toArray() : []))); return JSON.stringify(s); }, before = state();
      out[k] = await probe(E, { time: false });
      delete out[k].pixels;
      out[k].kept = state() === before;
      after?.();
      E.dispose();
    }
    return out;
  }, [probeSource, cases]);
}

const LIT = `const sun = new T.DirectionalLight(0xffffff, 3); sun.name = 'my-sun'; sun.position.set(6, 10, 4); sun.castShadow = true; Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 }); sun.shadow.mapSize.set(512, 512); E.scene.add(sun, sun.target);
  const floor = new T.Mesh(new T.PlaneGeometry(24, 24), new T.MeshLambertMaterial({ color: 0x889988 })); floor.name = 'floor'; floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; E.scene.add(floor);
  const box = new T.Mesh(new T.BoxGeometry(3, 3, 3), new T.MeshLambertMaterial({ color: 0xaa6644 })); box.name = 'crate'; box.position.y = 1.5; box.castShadow = box.receiveShadow = true; E.scene.add(box);`;

export const specs = [
  {
    name: '[guard] picture check: moving film grain reads as no shadow stripes',
    url: PAGE, software: true,
    async run({ check, ev }) {
      // On / off differ by the grain alone in a speckle, and two renders back to back read as still, so the probe has to wait out a frame of it (shadowEdgeMask in probe-shadows.mjs).
      // The clock here is a fast GPU's, whatever this page's software renderer takes: a render costs 20 ms of it, and a grain frame lasts 1 / 24 s (WebGPU's post runs on the
      // wall clock; WebGL's on the dt it is handed, and the probe hands it 0). Three phases, because a grain frame may or may not end between the probe's first two reads
      const clock = phase => `let t = ${phase}, frame = 0; const now = performance.now, real = E._render; performance.now = () => ++t; E._render = (dt, hooks) => { t += 20; const f = Math.floor(t / 1000 * 24), d = (f - frame) * 1.01 / 24; frame = f; return real.call(E, d, hooks); }; return () => { performance.now = now; };`;
      const lit = phase => `(T, E) => { ${LIT} sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; E.post.add(threedogThreads.grain({ enabled: true, amount: 0.3, size: 1, animated: true })); ${clock(phase)} }`;
      const r = await shootCases(ev, { a: lit(0), b: lit(14), c: lit(28) });
      for (const k of ['a', 'b', 'c']) {
        const j = JSON.stringify({ e: r[k].error, noise: r[k].shadows?.edgeNoise, edges: hintsOf(r[k]) && r[k].shadows?.edges, ids: ids(r[k]) });
        check(`[guard] phase ${k}: an animated post that changes 24 times a second: no stripes`, !r[k].error && !hintIn(r[k], 'shadow-stripes'), j);
        check(`[guard] phase ${k}: the grain was there and is said`, r[k].shadows?.edgeNoise >= 0.02 && !!hintIn(r[k], 'shadow-edges-unread'), j);
      }
    },
  },
  {
    name: '[guard] picture check: what the shadow map does not shape is no stepped edge',
    url: PAGE, software: true,
    async run({ check, ev }) {
      const pile = `for (let i = 0; i < 40; i++) { const p = new T.Mesh(new T.BoxGeometry(0.5, 1 + i % 3, 0.5), box.material); p.position.set((i % 8) * 1.1 - 4, 1, Math.floor(i / 8) * 1.1 - 2); p.castShadow = true; E.scene.add(p); }`;
      const r = await shootCases(ev, {
        corners: `(T, E) => { ${LIT} sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0005; ${pile} }`,
        blocks: `(T, E) => { ${LIT} E.renderer.shadowMap.type = T.BasicShadowMap; sun.shadow.mapSize.set(64, 64); sun.shadow.bias = -0.002; ${pile} }`,
      });
      const j = k => JSON.stringify({ e: r[k].error, grid: r[k].shadows?.grid, ids: ids(r[k]), kept: r[k].kept });
      check('[guard] many real corners on a fine map: silent', !hintIn(r.corners, 'shadow-jag'), j('corners'));
      check('[guard] the same corners on a coarse hard map: moving the grid moves the edges, and the fact says so', /half a pixel/.test(hintIn(r.blocks, 'shadow-jag')?.text), j('blocks'));
    },
  },
  {
    name: '[guard] picture check: the shadow grid is read on lights that place themselves, and they come back as the game left them',
    url: PAGE, software: true,
    async run({ check, ev }) {
      const placed = `${LIT} sun.shadow.bias = -0.0005; E.lights.sun.castShadow = false;`;
      const r = await shootCases(ev, {
        box: `(T, E) => { ${placed} const player = new T.Object3D(); player.position.set(3, 0, 3); E.scene.add(player); E.shadows.box(sun, { follow: player, extent: 12 }); }`,
        cascades: `(T, E) => { ${placed} E.shadows.cascades(sun, { count: 3, low: { count: 3 }, maxFar: 400 }); E.step(1 / 30); }`,
      });
      for (const k of ['box', 'cascades']) check(`[guard] ${k}: the grid moved and every light and layer is back`, !r[k].error && typeof r[k].shadows?.grid?.share === 'number' && r[k].kept, JSON.stringify([r[k].error, r[k].shadows?.grid, r[k].kept]));
    },
  },
  {
    name: '[guard] picture check on WebGPU: the shadow grid is read, cascades too',
    url: '/tests/parity/index.html?backend=webgpu', software: true,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const E = window.engine, T = __threedogThree, S = E.scene;
        const crate = new T.Mesh(new T.BoxGeometry(2, 2, 2), new T.MeshStandardMaterial()); crate.position.y = 1; crate.castShadow = crate.receiveShadow = true;
        const sun = new T.DirectionalLight(0xffffff, 3); sun.position.set(5, 9, 4); sun.castShadow = true;
        S.add(crate, sun, sun.target); E.renderer.shadowMap.enabled = true;
        const read = async () => { E.step(1 / 30); E.step(1 / 30); const { error, shadows } = await window.__probePicture(E, { time: false }); return { error, grid: shadows?.grid }; };
        const plain = await read(), h = E.shadows.cascades(sun, { count: 3, low: { count: 3 } }), at = sun.position.toArray().join(), cascades = await read(), back = sun.position.toArray().join() === at;
        h.remove(); S.remove(crate, sun, sun.target);
        return { plain, cascades, back };
      });
      check('[guard] no error, the grid moved, the light is back', !r.plain.error && !r.cascades.error && typeof r.plain.grid?.share === 'number' && typeof r.cascades.grid?.share === 'number' && r.back, JSON.stringify(r));
    },
  },
  {
    // [guard] weather as signals: picture code reads rain / snow / cloud from engine.uniforms (a shader can share the same object); they come from
    // the weather state every frame, so a game that draws its own rain still gets them
    name: '[guard] weather signals: engine.uniforms uRain / uSnow / uWeatherCloud follow the weather state',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'weather-signals');
        E.use(T.sky(), T.weather({ types: { clear: {}, rain: { rain: 1, cloud: 0.8 }, snow: { snow: 0.7 } } }));
        await E.start();
        const U = E.uniforms, read = () => ({ rain: U.uRain.value, snow: U.uSnow.value, cloud: U.uWeatherCloud.value });
        E.weather.set('rain', { seconds: 0 }); E.step(1 / 30);
        const rain = read();
        E.weather.set('snow', { seconds: 0 }); E.step(1 / 30);
        const snow = read();
        E.dispose();
        return { rain, snow };
      });
      check('rain: uRain 1, uWeatherCloud 0.8; snow: uSnow 0.7, uRain 0', r.rain.rain === 1 && Math.abs(r.rain.cloud - 0.8) < 1e-6 && Math.abs(r.snow.snow - 0.7) < 1e-6 && r.snow.rain === 0,
        JSON.stringify(r));
    },
  },
  {
    // [guard] picture code that writes three.js values every frame (engine.onRender) is the recommended way to write a picture; the probe's renders
    // ran it too, so a lamp the probe had turned off was turned back on and read "changes no pixel". And with createEngine({ lights: false })
    // the key / fill lines named the engine's lights that are not in the scene
    name: '[guard] picture check: picture code in onRender does not undo the probe; the game’s own key / fill lights are named when the engine lights are off',
    software: true,
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, { createEngine } = threedogThreads.all;
        const E = mk(createEngine, 'picture-picture-code', { lights: false });
        E.renderer.setSize(320, 180, false);
        E.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xa0a0a0 })));
        const sun = new THREE.DirectionalLight(0xffffff, 1), hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3), lamp = new THREE.PointLight(0xffaa66, 0, 12, 1.5);
        sun.name = 'my-sun'; lamp.name = 'my-lamp'; lamp.position.set(0, 2, 2);
        E.scene.add(sun, hemi, lamp);
        E.onRender(() => { lamp.intensity = 20; sun.intensity = 1.5; });   // the game's picture code
        E.renderer.toneMapping = THREE.NoToneMapping;   // flat colors as written
        await E.start();
        E.camera.position.set(0, 4, 8); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld();
        E.step(1 / 30);
        const p = await window.__probePicture(E, { time: false });
        delete p.pixels;
        // a built page: no three.js under the private name. What needs a class says so, the rest still runs
        const three = globalThis.__threedogThree; delete globalThis.__threedogThree;
        const built = await window.__probePicture(E, { time: false }).finally(() => { globalThis.__threedogThree = three; });
        p.built = { error: built.error, unread: built.unread, keys: Object.keys(built) };
        // a Standard material reads scene.environment: with the engine's lights off the room map must not come in for it
        E.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 })));
        E.step(1 / 30); E.step(1 / 30);
        p.envAfter = E.scene.environment === null;
        // the owned table read alone (no render section built first): the order of sections must not change the answer
        E.renderer.toneMapping = THREE.NeutralToneMapping; E.step(1 / 30);
        p.tone = { owned: E.describe('owned').owned?.toneMapping?.writer };
        E.dispose();
        return p;
      });
      check('a built page (no three.js for the tools): no error, what needs a class is named, shadows, key and lights are still read',
        !r.built.error && r.built.unread?.length === 4 && ['shadows', 'key', 'lights'].every(k => r.built.keys.includes(k)), JSON.stringify(r.built));
      check('lights: false: no room environment either, even for a Standard material', r.envAfter === true);
      check('the game set toneMapping: describe().owned no longer says the engine writes it', r.tone.owned && r.tone.owned !== 'engine', JSON.stringify(r.tone));
      const lamp = r.lights.find(l => l.name === 'my-lamp');
      check('the probe turns the lamp off for its render although picture code writes it each frame: it changes pixels', lamp?.changed === true, JSON.stringify(r.lights));
      const hn = pictureHints({ numbers: { luminance: 0.4, saturation: 0.1, contrast: 0.1, range: 0.3, overexposed: 0, dark: 0 }, probe: r });
      check('no "changes no pixel" contradiction; key / fill name the game’s own lights', !hn.some(h => h.id === 'light-no-effect')
        && /DirectionalLight 'my-sun' intensity/.test(r.params.sun?.name ?? '') && /HemisphereLight/.test(r.params.hemi?.name ?? ''),
        JSON.stringify({ sun: r.params.sun, hemi: r.params.hemi, hints: hn.map(h => h.id) }));
    },
  },
  {
    // [guard] the real failure, not a stand-in: a ShaderMaterial that outputs NaN, with bloom on. Whether it blacks out the frame depends on the GPU,
    // so the probe is what is checked: on a black frame it names that material, and a material whose shader does not compile is reported
    name: '[guard] picture check: a NaN ShaderMaterial under bloom is found; a shader that fails to compile is said on a black frame',
    software: true,
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE, bloom } = threedogThreads, { createEngine } = threedogThreads.all;
        const E = mk(createEngine, 'picture-nan');
        E.renderer.setSize(320, 180, false);
        E.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc0a080 })));
        E.post.add(bloom({ strength: 0.8, radius: 0.6, threshold: 0.2 }));
        E.post.get('bloom').enabled = true;
        await E.start();
        E.camera.position.set(0, 3, 10); E.camera.lookAt(0, 0, -30); E.camera.updateMatrixWorld();
        const nan = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'uniform float uZero; void main() { float n = uZero / uZero; gl_FragColor = vec4(n, n, n, 1.0); }', uniforms: { uZero: { value: 0 } } });
        nan.name = 'nan-lamp';
        const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), nan);
        lamp.position.set(0, 2, 0); E.scene.add(lamp);
        E.step(1 / 30);
        const p = await window.__probePicture(E, { time: false });
        delete p.pixels;
        const post = E.post?.active;
        E.dispose();
        return { black: p.black ?? null, post };
      });
      console.log('  NaN + bloom on software rendering:', JSON.stringify(r));
      check('bloom is on in this test', r.post === true);
      check('a black frame names the NaN material (a frame that stays lit runs no search)', !r.black || r.black.culprit?.name === 'nan-lamp', JSON.stringify(r.black));
      const N = { luminance: 0, saturation: 0, contrast: 0, range: 0, overexposed: 0, dark: 1 };
      const hints = pictureHints({ numbers: N, probe: { params: {}, lights: [], black: { post: false, tried: 3, materials: 3, culprit: null, broken: ['ShaderMaterial'] } } });
      check('a program that failed to compile is said in the black-frame hint', hints.some(h => h.id === 'black-frame' && /failed to compile: ShaderMaterial/.test(h.text)), JSON.stringify(hints));
    },
  },
  {
    // [guard] a game's ShaderMaterial blacked out the whole frame with no error anywhere, and a dark fog from 14 m hid most of a night street
    // while the hints named neither. The probe must name the material whose hiding brings the picture back, and the fog's share of the picture
    name: '[guard] picture check: a black frame names the material that causes it; fog that is most of the picture is a fact with its setting',
    software: true,
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, { createEngine } = threedogThreads.all;
        const E = mk(createEngine, 'picture-black');
        E.renderer.setSize(320, 180, false);
        const g = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc0a080 }));
        E.scene.add(g);
        await E.start();
        E.camera.position.set(0, 3, 10); E.camera.lookAt(0, 0, -30); E.camera.updateMatrixWorld();
        // a black screen right in front of the camera, drawn by a ShaderMaterial (the whole view)
        const lamp = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }' });
        lamp.name = 'lamp-shader';
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), lamp);
        screen.position.set(0, 3, 9); E.scene.add(screen);
        E.step(1 / 30);
        const black = await window.__probePicture(E, { time: false });
        screen.visible = false;
        const clear = await window.__probePicture(E, { time: false });
        E.scene.fog = new THREE.Fog(0x050608, 1, 8);
        E.step(1 / 30);
        const foggy = await window.__probePicture(E, { time: false });
        const fogColor = E.scene.fog.color.getHexString();
        for (const o of [black, clear, foggy]) delete o.pixels;
        E.dispose();
        return { black, clear, foggy, fogColor, screenBack: screen.visible === false };
      });
      const N = { luminance: 0, saturation: 0, contrast: 0, range: 0, overexposed: 0, dark: 1 };
      const hb = pictureHints({ numbers: N, probe: r.black });
      check('black frame: the probe names the ShaderMaterial whose hiding brings the picture back, as a contradiction (and no duplicate near-black fact)',
        r.black.black?.culprit?.name === 'lamp-shader' && hb.some(h => h.id === 'black-frame' && h.kind === 'contradiction' && /lamp-shader/.test(h.text)) && !hb.some(h => h.id === 'crushed'),
        JSON.stringify({ black: r.black.black, hints: hb.map(h => h.id) }));
      check('a lit frame runs no black-frame search, and no fog means no fog fact', !r.clear.black && !r.clear.fog, JSON.stringify({ black: r.clear.black, fog: r.clear.fog }));
      const hf = pictureHints({ numbers: { ...N, luminance: 0.1, dark: 0.3 }, probe: r.foggy });
      check('fog from 1 to 8 m over a long view: fog-cover names its share, near / far and color; the probe put the fog color back',
        r.foggy.fog?.share > 0.4 && hf.some(h => h.id === 'fog-cover' && /near 1 far 8/.test(h.text) && /#050608/.test(h.text)) && r.fogColor === '050608',
        JSON.stringify({ fog: r.foggy.fog, hints: hf.map(h => h.id) }));
    },
  },
  {
    name: '[守] picture check: a shadowed scene gives no contradiction; the same scene with a bias that pushes the shadows away names bias; probe restores what it touched',
    software: true,   // picture check measures rendered pixels
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all, { createEngine } = T;
        const E = mk(createEngine, 'picture-check');
        E.renderer.setSize(320, 180, false);
        E.use(T.calendar({ time: '10:00' }), T.sky());
        const g = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 }));
        g.receiveShadow = true; E.scene.add(g);
        // 几个立方体投影到地上，相机斜着看：影子占画面一块，正常时量得到
        for (const [x, z] of [[-3, 0], [0, 2], [3, -1], [1, -4]]) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3, 1.6), new THREE.MeshStandardMaterial({ color: 0xb08060 }));
          b.position.set(x, 1.5, z); b.castShadow = true; b.receiveShadow = true; E.scene.add(b);
        }
        await E.start();
        E.step(1 / 30); E.step(1 / 30);
        // 从太阳对面看：影子落在箱子朝相机的一侧（顺着太阳看，影子全躲在箱子后面，量不到也不算矛盾）
        const aim = () => { E.camera.position.set(-10, 10, -14); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld(); };
        aim();
        const out = {};
        out.normal = await window.__probePicture(E, { time: false });
        // 顺着太阳看：影子都在箱子后面，量不到是正常的，不许报矛盾
        E.camera.position.set(8, 9, 12); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld();
        out.behind = await window.__probePicture(E, { time: false });
        // camera inside a box (the demo's first shot stood inside a building): the probe names that box; from outside it names nothing
        E.camera.position.set(-3, 1.5, 0); E.camera.lookAt(0, 1.5, 5); E.camera.updateMatrixWorld();
        out.inside = await window.__probePicture(E, { time: false });
        aim();
        const was = E.lights.sun.shadow.bias;
        E.lights.sun.shadow.bias = -0.05;   // 阴影深度 0-1 里的 -0.05，乘上几百米的深度范围就是十几米：影子全没了
        E.step(1 / 30); aim();
        // scene.background 是引擎建场景时写的底色灰 #8c8c8c（core/engine/Engine.js），穹顶盖在它上面：不许当成"夜里还亮着的东西"报出来。
        // 不能自己赋一个新 Color 进去：那算游戏接管背景，天空会让出并藏起穹顶，底色就真露出来了
        // time of day is a view of the time channel now: steps advance it, so the value to compare is the one right before the probe (it must not move)
        const tod = E.calendar.timeOfDay;
        out.biased = await window.__probePicture(E, { time: true });
        E.sky.dome.visible = false;   // 穹顶拿掉，底色真露出来了，才该点名
        out.bare = await window.__probePicture(E, { time: true });
        E.sky.dome.visible = true;
        out.restored = { bias: E.lights.sun.shadow.bias, intensity: E.lights.sun.shadow.intensity, tod: Math.abs(E.calendar.timeOfDay - tod) < 1e-9, view: E.debug.viewState?.().mode ?? 'off' };
        out.biasSet = E.lights.sun.shadow.bias !== was;
        for (const k of ['normal', 'behind', 'inside', 'biased', 'bare']) delete out[k].pixels;
        E.dispose();
        return out;
      });
      const N = { luminance: 0.5, saturation: 0.2, contrast: 0.15, range: 0.4, overexposed: 0, dark: 0 };
      const hn = pictureHints({ numbers: N, probe: r.normal }), hb = pictureHints({ numbers: N, probe: r.biased });
      check('normal scene: shadows are measured (area above 1%) and no contradiction hint', r.normal.shadows?.area > 0.01 && !hn.some(h => h.kind === 'contradiction'),
        JSON.stringify({ shadows: r.normal.shadows, hints: hn }));
      check('[guard] camera inside a box: the probe names it (camera-inside); from outside, no mesh is named',
        /^Mesh /.test(r.inside.cameraInside?.name ?? '') && !r.normal.cameraInside && pictureHints({ numbers: N, probe: r.inside }).some(h => h.id === 'camera-inside'),
        JSON.stringify({ inside: r.inside.cameraInside, normal: r.normal.cameraInside ?? null }));
      check('[guard] key against fill: the sun off and the fill off each darken the shot (two measured renders), and the hint states both shares',
        r.normal.key && r.normal.key.noKey < r.normal.key.base && r.normal.key.noFill < r.normal.key.base && pictureHints({ numbers: N, probe: r.normal }).some(h => h.id === 'light-balance' && /% of the lit brightness/.test(h.text)),
        JSON.stringify(r.normal.key));
      check('sun behind the camera: shadows hidden behind the casters are no contradiction', !pictureHints({ numbers: N, probe: r.behind }).some(h => h.kind === 'contradiction'), JSON.stringify(r.behind.shadows));
      check('[guard] scene.background is named as a night source only when it shows: covered by the sky dome no, dome hidden yes',
        r.biased.time && !r.biased.time.at.midnight.background && r.bare.time?.at.midnight.background?.value === '#8c8c8c',
        JSON.stringify({ covered: r.biased.time?.at?.midnight, bare: r.bare.time?.at?.midnight }));
      const sh = hb.find(h => h.id === 'shadow-invisible');
      check('bias -0.05: the probe measures no shadow and the hint names shadow.bias with its value', r.biasSet && r.biased.shadows?.area < 0.003 && /shadow\.bias -0\.05/.test(sh?.text ?? ''),
        JSON.stringify({ shadows: r.biased.shadows, hints: hb }));
      check('hints state facts, never a target value ("should", "<", "target")', ![...hn, ...hb].some(h => /\bshould\b|\btarget\b| < \d/.test(h.text)), JSON.stringify(hb));
      check('the probe puts back shadow intensity, the time of day and the debug view', r.restored.intensity === 1 && r.restored.tod && r.restored.view === 'off', JSON.stringify(r.restored));
      check('pictureNumbers: contrast and range of a two-tone picture', (() => { const px = new Uint8Array(4 * 4); px.set([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]); const n = pictureNumbers(px); return n.contrast === 0.5 && n.range === 1; })());
    },
  },
  {
    // 为什么：逐灯开关那一段以前把投影的灯整个跳过（!casters.includes），游戏自己的投影灯（带影子的路灯、手电）
    // 点不亮东西或者晃眼，都不会被量，提示也就不会有。投影只决定它进不进阴影那一段，不该决定量不量它。
    name: '[守] picture check: a game light that casts shadows is still turned off and measured (light-no-effect)',
    software: true,   // picture check measures rendered pixels
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all, { createEngine } = T;
        const E = mk(createEngine, 'picture-check-caster');
        E.renderer.setSize(320, 180, false);
        const g = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 }));
        g.receiveShadow = true; E.scene.add(g);
        const lamp = new THREE.PointLight(0xffffff, 1e-6, 30, 2); lamp.name = 'castLamp'; lamp.castShadow = true; lamp.position.set(0, 3, 0); E.scene.add(lamp);
        await E.start();
        E.step(1 / 30);
        E.camera.position.set(0, 6, 8); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld();
        const p = await window.__probePicture(E, { time: false });
        delete p.pixels;
        E.dispose();
        return { lights: p.lights, error: p.error ?? null };
      });
      const lamp = r.lights.find(l => l.name === 'castLamp');
      const h = pictureHints({ numbers: { luminance: 0.5, saturation: 0.2, contrast: 0.15, range: 0.4, overexposed: 0, dark: 0 }, probe: { lights: r.lights } });
      check('the shadow-casting lamp is measured and named as changing no pixel', !!lamp && !lamp.changed && h.some(x => x.id === 'light-no-effect' && x.text.includes('castLamp')), JSON.stringify(r));
    },
  },
  {
    // [guard] the game's own lights, measured by the real probe: createEngine({ lights: false }) with plain three.js lights is how a new game starts,
    // so the budget, the near-black shadow and the stripe / stepped edge facts must read those lights, not engine.lights. Real renders: a fake mask
    // would pass while the probe reads the wrong pixels
    name: '[guard] picture check on the game’s own lights: budget, near-black shadows with no fill, shadow stripes and stepped edges come from real renders',
    software: true,
    url: PAGE,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, { createEngine } = threedogThreads.all;
        const E = mk(createEngine, 'picture-own-lights', { lights: false });
        E.renderer.setSize(640, 360, false);
        E.renderer.toneMapping = THREE.NoToneMapping;
        E.renderer.shadowMap.type = THREE.BasicShadowMap;   // hard edges: the map's pixels show as they are
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xb0b0b0 }));
        ground.receiveShadow = true; E.scene.add(ground);
        const box = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 5), new THREE.MeshLambertMaterial({ color: 0x8090a0 }));
        box.position.set(0, 2, 0); box.rotation.y = 0.6; box.castShadow = true; E.scene.add(box);
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.name = 'my-sun'; sun.position.set(12, 14, 6); sun.castShadow = true;
        Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 60 });
        sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
        E.scene.add(sun);
        await E.start();
        E.camera.position.set(-6, 9, 13); E.camera.lookAt(0, 0, 0); E.camera.updateMatrixWorld();
        const shoot = async fn => {
          fn?.(); sun.shadow.map?.dispose(); sun.shadow.map = null; sun.shadow.needsUpdate = true;
          E.step(1 / 30);
          const p = await window.__probePicture(E, { time: false }); delete p.pixels; return p;
        };
        const out = {};
        out.sharp = await shoot();
        out.blocks = await shoot(() => { sun.shadow.mapSize.set(128, 128); });
        out.acne = await shoot(() => { sun.shadow.mapSize.set(512, 512); sun.shadow.bias = 0; ground.castShadow = true; ground.material.shadowSide = THREE.FrontSide; });
        sun.shadow.bias = -0.0005; sun.shadow.mapSize.set(2048, 2048); ground.castShadow = false;
        const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.2);
        E.scene.add(hemi);
        out.filled = await shoot();
        // the filter a game gets by default: its soft, noisy rim must not read as stripes or steps
        out.soft = await shoot(() => { E.renderer.shadowMap.type = THREE.PCFShadowMap; ground.material.needsUpdate = box.material.needsUpdate = true; });
        out.restored = { shadow: sun.shadow.intensity, hemi: hemi.intensity, env: E.scene.environmentIntensity };
        // nine lit lamps of the game's own: over the engine's default line. A map size the game capped: its own limit
        for (let i = 0; i < 9; i++) { const l = new THREE.PointLight(0xffaa66, 3, 6); l.position.set(i * 3 - 12, 2, -10); E.scene.add(l); }
        E.budget.enable({ shadowMaps: 0, shadowMapSize: 1024 });
        out.over = await shoot();
        out.report = E.budget.report().over.map(o => o.category);
        out.perf = E.inspect.perf().budgets.filter(b => !b.ok).map(b => `${b.name} ${b.next}`);
        E.dispose();
        return out;
      });
      const N = { luminance: 0.4, saturation: 0.1, contrast: 0.15, range: 0.4, overexposed: 0, dark: 0 };
      const H = p => pictureHints({ numbers: N, probe: p }), has = (p, id) => H(p).find(h => h.id === id);
      const edges = k => { H(r[k]); const { settings, ...s } = r[k].shadows ?? {}; return JSON.stringify({ k, err: r[k].error, s, ids: H(r[k]).map(h => h.id) }); };
      check('a sharp map: no stripes and no stepped edges on a real shadow', !has(r.sharp, 'shadow-stripes') && !has(r.sharp, 'shadow-jag'), edges('sharp'));
      check('the default soft filter: no stripes and no stepped edges either', !has(r.soft, 'shadow-stripes') && !has(r.soft, 'shadow-jag'), edges('soft'));
      check('a coarse map: stepped edges with the light’s own map size and half width', /DirectionalLight '[^']+' shadow\.mapSize 128/.test(has(r.blocks, 'shadow-jag')?.text) && /half width 30/.test(has(r.blocks, 'shadow-jag')?.text), edges('blocks'));
      check('a game’s own light: cascades point to engine.shadows.cascades, not to a picture verb', /engine\.shadows\.cascades\(light/.test(has(r.blocks, 'shadow-jag')?.text) && !/engine\.look\.shadow\.set/.test(has(r.blocks, 'shadow-jag')?.text));
      check('a bias that makes the ground shadow itself: stripes with the share and the bias', /stripes on/.test(has(r.acne, 'shadow-stripes')?.text) && /shadow\.bias 0/.test(has(r.acne, 'shadow-stripes')?.text), edges('acne'));
      check('no fill at all: near-black shadow fact naming bakeProbes; with the game’s own HemisphereLight it is gone', /engine\.bakeProbes/.test(has(r.sharp, 'shadow-black')?.text) && !has(r.filled, 'shadow-black'), edges('sharp') + edges('filled'));
      check('the probe puts back what it turned off', r.restored.shadow === 1 && r.restored.hemi === 1.2 && r.restored.env === 1, JSON.stringify(r.restored));
      const ob = H(r.over).filter(h => h.id === 'over-budget'), of = re => ob.find(h => re.test(h.text));
      check('nine lamps the game added: over the default limit, a fact pointing to lightPool', of(/9 real point/)?.kind === 'fact' && /engine\.use\(lightPool/.test(of(/9 real point/).text), JSON.stringify(ob));
      check('limits the game wrote: shadow maps and map size are intent, the casting light named by its own name', of(/shadow maps drawn/)?.kind === 'intent' && /my-sun \(DirectionalLight, 2048\)/.test(of(/shadow maps drawn/).text) && of(/largest shadow map/)?.kind === 'intent', JSON.stringify(ob));
      check('same values everywhere: budget.report() and inspect.perf() list the same categories, perf with its next step', ['lights', 'shadowMaps', 'shadowMapSize'].every(c => r.report.includes(c)) && r.perf.some(t => /^lights .*lightPool/.test(t)) && r.perf.some(t => /^shadowMaps .*castShadow/.test(t)), JSON.stringify([r.report, r.perf]));
      check('no budget line under the limits', !r.sharp.budget && !r.filled.budget);
    },
  },
  {
    name: '[guard] picture check: meshes beyond camera.far are counted (far-clip), a raised plane or a sky dome is not',
    url: PAGE, software: true,
    async run({ check, ev }) {
      const ground = `const g = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshLambertMaterial({ color: 0x889988 })); g.rotation.x = -Math.PI / 2; E.scene.add(g); const near = new T.Mesh(new T.BoxGeometry(2, 2, 2), new T.MeshLambertMaterial({ color: 0xaa6644 })); near.position.set(0, 1, 0); E.scene.add(near);`;
      const far = `const f = new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshLambertMaterial({ color: 0x6688aa })); f.position.set(0, 10, -3000); E.scene.add(f);`;
      const r = await shootCases(ev, {
        cut: `(T, E) => { ${ground} ${far} }`,
        raised: `(T, E) => { ${ground} ${far} E.autoView.manual('far'); E.camera.far = 5000; E.camera.updateProjectionMatrix(); }`,
        dome: `(T, E) => { ${ground} const d = new T.Mesh(new T.SphereGeometry(4000, 8, 6), new T.MeshBasicMaterial({ side: T.BackSide })); d.position.set(0, 0, -3000); E.scene.add(d); }`,
        none: `(T, E) => { ${ground} }`,
      });
      const N = { luminance: 0.5, saturation: 0.2, contrast: 0.15, range: 0.4, overexposed: 0, dark: 0 };
      check('[guard] a mesh 3000 m away with the default far plane: counted once, with the plane and the distance', r.cut.far?.beyond === 1 && r.cut.far.far === 1500 && r.cut.far.nearest > 2900 && r.cut.far.nearest < 3000 && pictureHints({ numbers: N, probe: r.cut }).some(h => h.id === 'far-clip'), JSON.stringify(r.cut.far ?? null));
      check('[guard] the same mesh with the plane raised past it: nothing reported', !r.raised.far && !ids(r.raised).includes('far-clip'), JSON.stringify(r.raised.far ?? null));
      check('[guard] a BackSide sky dome far away is not counted (it is meant to be seen from inside)', !r.dome.far, JSON.stringify(r.dome.far ?? null));
      check('[guard] a scene with everything in range: nothing reported, and the probe put every value back', !r.none.far && ['cut', 'raised', 'dome', 'none'].every(k => r[k].kept), JSON.stringify({ far: r.none.far ?? null, kept: ['cut', 'raised', 'dome', 'none'].map(k => r[k].kept) }));
    },
  },
];
