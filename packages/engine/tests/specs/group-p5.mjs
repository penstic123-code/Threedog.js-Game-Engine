// Group P5 (docs/plans/research/2026-11-10-health-check-b-picture.md 7, 9): backend parity of the picture readers. One test item per fix so one throw stops no other;
// each goes red with only its own fix reverted.
//   9: the dome's fog band, the water's grazing colour and the horizon check follow scene.fog AND the WebGPU form scene.fogNode = fog(color, factor) (render/fogLook.js)
//   7: the `lighting` patch (WebGL) takes the shadow of the cascade the fragment falls in, not cascade 0's (render/lighting.js SUN)

export const specs = [
  {
    name: '[guard] group P5 9a: the sky dome\'s fog band follows scene.fog and scene.fogNode alike; a node colour it cannot read is said once',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { THREE, createEngine, sky, tsl } = threedogTest;
        const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'p5-dome' });
        e.use(sky()); e.sky.fixedTime = 0.5;
        const S = e.scene, u = e.sky.uniforms, frame = () => { e.sky.update(e.focus); return { band: u.uFogBand.value, col: u.uFogColor.value.getHex() }; };
        const out = { none: frame() };
        S.fog = new THREE.Fog(0x804020, 5, 90); out.fog = frame();
        S.fog = null;
        const R = e.renderer; R.isWebGPURenderer = true;   // the renderer decides which fog is drawn (a flag on this renderer stands in for WebGPURenderer)
        S.fogNode = tsl.fog(tsl.color(0x804020), tsl.rangeFogFactor(5, 90)); out.node = frame();   // WebGPU's documented form
        S.fogNode = tsl.fog(new THREE.Color(0x804020), tsl.rangeFogFactor(5, 90)); out.raw = frame();   // a plain Color is as good
        S.fog = new THREE.Fog(0x112233, 5, 90); out.both = frame();   // WebGPU draws the node when both are set
        S.fog = null; R.isWebGPURenderer = false; out.webgl = frame();   // WebGLRenderer never draws a fogNode
        R.isWebGPURenderer = true;
        S.fogNode = tsl.fog(tsl.uniform(u.uHorizon.value.clone()), tsl.rangeFogFactor(5, 90)); out.horizon = frame();   // a fog the dome already draws: no band
        const warns = []; const w0 = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
        S.fogNode = tsl.fog(tsl.color(0x804020).mul(2), tsl.rangeFogFactor(5, 90)); frame(); frame();   // an expression: not readable
        console.warn = w0;
        out.unread = { band: frame().band, warns: warns.filter(x => /fogNode/.test(x)).length };
        out.want = new THREE.Color(0x804020).getHex();
        e.dispose();
        return out;
      });
      check('no fog: band off', r.none.band === 0, JSON.stringify(r.none));
      check('scene.fog: band on in its colour (WebGL form)', r.fog.band === 1 && r.fog.col === r.want, JSON.stringify(r.fog));
      check('scene.fogNode = fog(color(..), factor): the same band and colour (WebGPU form)', r.node.band === 1 && r.node.col === r.want, JSON.stringify(r.node));
      check('a raw THREE.Color in fog(): read, and not called unreadable', r.raw.band === 1 && r.raw.col === r.want, JSON.stringify(r.raw));
      check('fogNode and scene.fog both set: WebGPU follows the node, as three draws it', r.both.col === r.want, JSON.stringify(r.both));
      check('WebGLRenderer never draws a fogNode: no band', r.webgl.band === 0, JSON.stringify(r.webgl));
      check('a fogNode in the horizon colour: band off, like scene.fog', r.horizon.band === 0, JSON.stringify(r.horizon));
      check('a fogNode with a computed colour: no band, and one warning (not one per frame)', r.unread.band === 0 && r.unread.warns === 1, JSON.stringify(r.unread));
    },
  },
  {
    name: '[guard] group P5 9b: the water\'s grazing colour follows scene.fog and scene.fogNode alike',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { THREE, createEngine, sky, water, tsl } = threedogTest;
        const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'p5-water' });
        e.use(sky(), water({ sea: false }));
        const S = e.scene, hex = () => e.water._reflects().getHex(), out = { want: new THREE.Color(0x123456).getHex() };
        out.horizon = e.water._reflects() === e.uniforms.uSkyHorizon.value;
        S.fog = new THREE.Fog(0x123456, 1, 2); out.fog = hex();
        S.fog = null;
        S.fogNode = tsl.fog(tsl.color(0x123456), tsl.rangeFogFactor(1, 2)); out.webgl = e.water._reflects() === e.uniforms.uSkyHorizon.value;   // WebGLRenderer ignores it
        e.renderer.isWebGPURenderer = true; out.node = hex();
        e.dispose();
        return out;
      });
      check('no fog: the sky horizon', r.horizon, JSON.stringify(r));
      check('scene.fog colour (WebGL form)', r.fog === r.want, JSON.stringify(r));
      check('WebGLRenderer ignores a fogNode', r.webgl, JSON.stringify(r));
      check('scene.fogNode colour (WebGPU form)', r.node === r.want, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P5 9c: the horizon check (fog-horizon) reads scene.fogNode too, and stays quiet when the fog is the background colour',
    url: '/tests/probes/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { THREE, tsl } = threedogTest, e = engine, s = e.scene, out = {};
        e.step(0.05);
        const ids = () => e.describe().render.checks.map(c => c.id);
        const fog0 = s.fog, bg0 = s.background;
        s.background = new THREE.Color(0x000000);
        s.fog = new THREE.Fog(0xffffff, 1, 50); out.fog = ids();
        s.fog = null;
        s.fogNode = tsl.fog(tsl.color(0xffffff), tsl.rangeFogFactor(1, 50)); out.webgl = ids();   // WebGLRenderer ignores it
        engine.renderer.isWebGPURenderer = true; out.node = ids();
        s.fogNode = tsl.fog(tsl.color(0x000000), tsl.rangeFogFactor(1, 50)); out.same = ids();
        s.fogNode = null; engine.renderer.isWebGPURenderer = false; s.fog = fog0; s.background = bg0;
        return out;
      });
      check('scene.fog differing from the background: fog-horizon (WebGL form)', r.fog.includes('fog-horizon'), JSON.stringify(r));
      check('scene.fogNode differing from the background: fog-horizon (WebGPU form)', r.node.includes('fog-horizon'), JSON.stringify(r));
      check('WebGLRenderer ignores a fogNode: no fog-horizon', !r.webgl.includes('fog-horizon'), JSON.stringify(r));
      check('a fogNode in the background colour: quiet', !r.same.includes('fog-horizon'), JSON.stringify(r));
    },
  },
  {
    software: true,   // reads rendered pixels (same numbers on every machine)
    name: '[guard] group P5 7: with cascades, the lighting patch (shadowTint) sees the shadow of the cascade the fragment is in, near and far alike',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { THREE, createEngine, applyEffects } = threedogTest;
        const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'p5-csm', lights: false, pixelRatio: 1 });
        e.tier = 'high'; e.haltLoop?.();
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 1 }));
        ground.receiveShadow = true;
        applyEffects(ground.material, { lighting: { shadowTint: { color: 0xff0000, strength: 1 } } });   // the shaded side turns red
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
        box.castShadow = true;
        const light = new THREE.DirectionalLight(0xffffff, 2.5);
        light.position.set(60, 60, 0); light.castShadow = true; light.shadow.mapSize.setScalar(1024);
        e.scene.add(ground, box, light, new THREE.AmbientLight(0xffffff, 2));
        e.camera.position.set(0, 6, 30); e.camera.lookAt(0, 2, -30);
        const N = 96, rt = new THREE.WebGLRenderTarget(N, N), R = e.renderer, bytes = new Uint8Array(N * N * 4);
        const red = () => {
          e.step(1 / 30, { describe: false }); R.setRenderTarget(rt); R.render(e.scene, e.camera); R.readRenderTargetPixels(rt, 0, 0, N, N, bytes); R.setRenderTarget(null);
          let n = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] - bytes[i + 1] > 40) n++;
          return n;
        };
        const h = e.shadows.cascades(light, { count: 3, maxFar: 120 });
        const splits = h.csm.uniforms.CSM_cascades.value.map(v => [v.x, v.y]);
        const out = { splits };
        box.scale.set(8, 8, 8); box.position.set(0, 4, 15); out.near = red();      // 15 m ahead of the camera: inside cascade 0
        box.scale.set(40, 20, 40); box.position.set(0, 10, -45); out.far = red();     // 75 m ahead: past the first split (the box is bigger so it shows the same size)
        out.cascade0Far = splits[0][1] * (Math.min(e.camera.far, 120) - e.camera.near);
        e.dispose();
        return out;
      });
      check('the first cascade ends before the far shadow (so it is not cascade 0\'s shadow)', r.cascade0Far < 60, JSON.stringify(r));
      check('shadowTint reddens the shaded ground in cascade 0 (the setup works)', r.near > 30, JSON.stringify(r));
      check('shadowTint reddens the shaded ground past the first split too', r.far > 30, JSON.stringify(r));
    },
  },
  {
    software: true,   // reads rendered pixels (same numbers on every machine)
    name: "[guard] group P5 7b: with cascade fade on (the default) and off, the lighting patch's sun shadow equals what three's cascade chunk lights with, seams and the faded last cascade included",
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { THREE, createEngine, applyEffects } = threedogTest;
        const out = {};
        for (const [name, fade, maxFar] of [['fade', true, 120], ['hard', false, 120], ['hardShort', false, 40]]) {   // hardShort: much of the ground lies past the last far edge
          const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'p5-csm-fade', lights: false, pixelRatio: 1 });
          e.tier = 'high'; e.haltLoop?.();
          const geo = new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2);
          // reference: three's own cascade lighting. patched: the lighting patch writes N.L * its sun shadow as the direct light (sun intensity pi makes three's result N.L * shadow too)
          const ref = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff })), got = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }));
          applyEffects(got.material, { lighting: { glsl: 'void threedogLighting(inout ReflectedLight light, vec3 normal, vec3 viewDir, vec3 sunDir, float sunShadow, vec3 albedo){ light.directDiffuse = vec3(max(dot(normal, sunDir), 0.0) * sunShadow); light.indirectDiffuse = vec3(0.0); }' } });
          ref.receiveShadow = got.receiveShadow = true;
          const light = new THREE.DirectionalLight(0xffffff, Math.PI);
          light.position.set(60, 60, 0); light.castShadow = true; light.shadow.mapSize.setScalar(1024);
          e.scene.add(light);
          for (let z = 20; z > -110; z -= 14) { const b = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 6), new THREE.MeshLambertMaterial()); b.position.set(-4, 4, z); b.castShadow = true; e.scene.add(b); }
          e.camera.position.set(0, 14, 40); e.camera.lookAt(0, 0, -50);
          e.shadows.cascades(light, { count: 3, maxFar, fade });
          const N = 256, rt = new THREE.WebGLRenderTarget(N, N), R = e.renderer, bytes = new Uint8Array(N * N * 4);
          const shot = m => { e.scene.remove(ref, got); e.scene.add(m); e.step(1 / 30, { describe: false }); R.setRenderTarget(rt); R.render(e.scene, e.camera); R.readRenderTargetPixels(rt, 0, 0, N, N, bytes); R.setRenderTarget(null); return Array.from(bytes); };
          shot(ref); const a = shot(ref), b = shot(got);
          let bad = 0, lit = 0; for (let i = 0; i < a.length; i += 4) { if (Math.abs(a[i] - b[i]) > 4) bad++; if (a[i] > 20) lit++; }
          out[name] = { bad, lit };
          e.dispose();
        }
        return out;
      });
      check("fade on: the patch's sun shadow matches three's blended cascades (no pixel off)", r.fade.lit > 500 && r.fade.bad === 0, JSON.stringify(r));
      check('fade off: the hard pick matches', r.hard.lit > 500 && r.hard.bad === 0, JSON.stringify(r));
      check('fade off, ground past the last far edge: unshadowed like three (the last map is not sampled there)', r.hardShort.lit > 500 && r.hardShort.bad === 0, JSON.stringify(r));
    },
  },
];
