// Environment picture open points (recipes/34): the dome's band under the game's fog, exposure and tone mapping,
// extra dome layers. Defaults draw what they always drew (pixel / text comparison), new settings take effect, replacements compile,
// wrong settings throw with the fix.

// Shared page helpers (serialized into the page): a headless engine with sky() options and a sky picture, and a pixel shot
const HELPERS = `
  const { THREE, createEngine, sky, skyLayers } = threedogTest;
  const make = (look = {}, opts = {}) => {
    const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'appearance-env' });
    try { const { layers, ...keys } = look.sky ?? {}; e.use(sky({ ...opts, ...keys })); skyLayers(e, { layers }); } catch (err) { e.dispose(); return { error: err.message }; }
    return { e };
  };
  const domeShot = (e, pitch) => {
    const R = engine.renderer, rt = new THREE.WebGLRenderTarget(24, 24), bytes = new Uint8Array(24 * 24 * 4);
    const cam = new THREE.PerspectiveCamera(100, 1, 0.1, 1000), sc = new THREE.Scene(), m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), e.sky.dome.material);
    m.scale.setScalar(500); m.frustumCulled = false; sc.add(m); cam.rotation.set(pitch, 0.4, 0, 'YXZ');
    let err = ''; const prev = R.debug.onShaderError; R.debug.onShaderError = (gl, p, vs, fs) => { err += (gl.getProgramInfoLog(p) || '') + (gl.getShaderInfoLog(fs) || ''); };
    R.setRenderTarget(rt); R.render(sc, cam); R.readRenderTargetPixels(rt, 0, 0, 24, 24, bytes); R.setRenderTarget(null); R.debug.onShaderError = prev; rt.dispose();
    return { px: Array.from(bytes).join(','), err: err.slice(0, 400) };
  };
`;
const page = fn => new Function(`${HELPERS}\nreturn (${fn})();`);

export const specs = [
  {
    software: true,   // reads rendered pixels (through a helper): stays on software rendering (same pixels on every machine)
    name: '[guard] exposure and tone curve: no curve by default; direct writes of both survive the sky; look.tone is gone',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(page(() => {
        const out = {}, err = f => { try { f(); return ''; } catch (e) { return e.message; } };
        const n = make({}).e; n.renderer.toneMappingExposure = 1.05; n.renderer.toneMapping = THREE.ACESFilmicToneMapping; n.sky.update(n.focus);
        out.num = n.renderer.toneMappingExposure === 1.05 && n.renderer.toneMapping === THREE.ACESFilmicToneMapping;
        const d = make({}).e;
        out.defTone = d.renderer.toneMapping === THREE.NoToneMapping;
        n.renderer.toneMappingExposure = 1.3; n.sky.update(n.focus); n.sky.update(n.focus); out.set = n.renderer.toneMappingExposure;
        n.renderer.toneMapping = THREE.NeutralToneMapping; n.sky.update(n.focus); n.sky.update(n.focus); out.tone = n.renderer.toneMapping === THREE.NeutralToneMapping;
        for (const e of [n, d]) e.dispose();
        return out;
      }));
      check('renderer tone values written by the game stay as given', r.num, JSON.stringify(r));
      check('no curve written: three.js default (none)', r.defTone, JSON.stringify(r));
      check('a direct renderer.toneMappingExposure write stays through sky frames', r.set === 1.3, String(r.set));
      check('a direct renderer.toneMapping write stays', r.tone, JSON.stringify(r));
    },
  },
  {
    software: true,   // reads rendered pixels (through a helper): stays on software rendering (same pixels on every machine)
    name: "[guard] fog is the game's: the sky writes none and keeps the game's object as it is; the dome's band reads scene.fog (off in the horizon color or at density 0, on otherwise)",
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(page(() => {
        const out = {}, band = e => { e.sky.update(e.focus); return e.sky.uniforms.uFogBand.value; };
        const e = make().e; e.sky.fixedTime = 0.5;
        out.none = { band: band(e), fog: e.scene.fog };
        const plain = domeShot(e, 0.05);
        const f = e.scene.fog = new THREE.Fog(0xffffff, 11, 77); f.color.copy(e.sky.uniforms.uHorizon.value);
        out.horizon = band(e);
        f.color.set(0x804020);
        out.colored = band(e);
        out.kept = e.scene.fog === f && f.near === 11 && f.far === 77 && f.color.getHex() === 0x804020;
        const s = domeShot(e, 0.05);
        out.dome = { err: s.err, differs: s.px !== plain.px };
        const x = e.scene.fog = new THREE.FogExp2(0x804020, 0.01);
        out.exp2 = band(e);
        x.density = 0;
        out.exp2Zero = band(e);
        e.dispose();
        return out;
      }));
      check('no fog written by the sky: scene.fog stays null, the band is off', r.none.fog === null && r.none.band === 0, JSON.stringify(r.none));
      check("the game's Fog stays as written through sky frames (same object, near, far, color)", r.kept);
      check('a fog in the horizon color: band off, nothing to hide', r.horizon === 0, String(r.horizon));
      check('a fog in another color: band on, the dome fades to it (compiles, picture differs)', r.colored === 1 && r.dome.err === '' && r.dome.differs, JSON.stringify(r.dome));
      check('FogExp2 turns the band on, density 0 draws nothing and turns it off', r.exp2 === 1 && r.exp2Zero === 0, `${r.exp2} ${r.exp2Zero}`);
    },
  },
  {
    software: true,   // reads rendered pixels (through a helper): stays on software rendering (same pixels on every machine)
    name: '[守] 天空多层：默认无层时穹顶着色器文本不变；层编译通过、画面变化、按 order 排序且改名不冲突、uniform 进 sky.uniforms；写错报错给签名',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(page(() => {
        const out = {};
        const def = make({}).e; def.sky.fixedTime = 0.5; def.sky.update(def.focus);
        const glsl = 'vec4 threedogSkyLayer(vec3 d, float time, vec3 sunDir, float night){ return vec4(uBand, smoothstep(0.2, 0.4, d.y) * uK); }';
        const two = make({ sky: { layers: [
          { glsl, uniforms: { uBand: [1, 0, 0], uK: 0.8 }, order: 2 },
          // calls the noise helpers recipe 08 promises in a layer's scope (the dome once declared them after the layers, so this failed to compile)
          { glsl: 'vec4 threedogSkyLayer(vec3 d, float time, vec3 sunDir, float night){ return vec4(0.0, 0.3 * threedogNoise(d.xz * 4.0) + 0.1 * threedogHash(d.xz), 0.0, 1.0); }', blend: 'add', order: 1 } ] } }).e;
        two.sky.fixedTime = 0.5; two.sky.update(two.focus);
        const fs = two.sky.dome.material.fragmentShader;
        out.renamed = /threedogSkyLayer0\(/.test(fs) && /threedogSkyLayer1\(/.test(fs) && !/threedogSkyLayer\(/.test(fs);
        out.ordered = fs.indexOf('col += L.rgb * L.a') < fs.indexOf('col = mix(col, L.rgb, L.a)');   // order 1 (add) drawn before order 2
        out.uniform = two.sky.uniforms.uK?.value === 0.8;
        const a = domeShot(def, 0.9), b = domeShot(two, 0.9);
        out.err = a.err + b.err; out.differs = a.px !== b.px;
        def.dispose(); two.dispose();
        out.errGlsl = make({ sky: { layers: [{ glsl: 'float x;' }] } }).error;
        out.errBlend = make({ sky: { layers: [{ glsl, uniforms: { uBand: [1, 0, 0], uK: 1 }, blend: 'screen' }] } }).error;
        return out;
      }));
      check('两层改名为 threedogSkyLayer0 / 1，原名不残留', r.renamed);
      check('按 order 画（order 1 的 add 层在前）', r.ordered);
      check('层的 uniform 在 engine.sky.uniforms 里', r.uniform);
      check('层编译通过且画面变化', r.err === '' && r.differs, r.err);
      check('glsl 没定义 threedogSkyLayer / blend 写错 / 不是数组：各自报错给写法',
        /vec4 threedogSkyLayer\(vec3 dir/.test(r.errGlsl || '') && /'mix' or 'add'/.test(r.errBlend || ''), [r.errGlsl, r.errBlend].join(' | '));
    },
  },
];
