// Light probes (render/probes.js). Page: tests/probes (gray floor, unlit red wall at +x, headless).
// The non-bypassable checks: one picture must show red light on the floor beside the wall and none far from it (per-pixel: the old single SH for the
// whole scene could not), and the engine's rebuilt half-float atlas must draw what three's own float grid draws (three's layout is copied by hand; a
// three.js update that changes it fails here). Plus interpolation, the file round trip, refusal of a bad file, the two checks, describe, debug view.

export const specs = [
  {
    name: 'light probes: per-pixel grid sees the red wall, half atlas draws like three\'s own grid, sample, file round trip, checks, describe, view',
    software: true,   // reads the baked colors
    url: '/tests/probes/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE, LightProbeGridWebGL } = threedogTest, info = engine.renderer.info, R = engine.renderer, out = {};
        engine.step(0.1);
        const opt = { bounds: { min: [-3, 0.5, -1], max: [3, 1.5, 1] }, spacing: 3, resolution: 8, owner: 'probe-test' };
        // an overhead view of the floor, as float pixels: the grid's own part is the picture with it minus the picture without it
        const top = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50); top.position.set(0, 20, 0); top.lookAt(0, 0, 0); top.updateMatrixWorld();
        const S = 40, rt = new THREE.WebGLRenderTarget(S, S, { type: THREE.FloatType });
        const shot = () => { const px = new Float32Array(S * S * 4), keep = R.toneMapping; R.toneMapping = THREE.NoToneMapping; R.setRenderTarget(rt); R.render(engine.scene, top); R.readRenderTargetPixels(rt, 0, 0, S, S, px); R.setRenderTarget(null); R.toneMapping = keep; return px; };
        const at = (px, wx, wz) => { const i = (Math.round((wz + 5) / 10 * (S - 1)) * S + Math.round((wx + 5) / 10 * (S - 1))) * 4; return [px[i], px[i + 1], px[i + 2]]; };
        const base = shot();
        const tex0 = info.memory.textures;
        const set = await engine.bakeProbes(opt);
        Object.assign(out, { count: set.count, counts: set.counts, bakeMs: set.bakeMs, inScene: set.grid.parent === engine.scene, isGrid: set.grid.isLightProbeGrid === true });
        out.half = set.grid.texture.isData3DTexture && set.grid.texture.type === THREE.HalfFloatType;
        const lit = shot();
        const gain = (wx, wz) => { const a = at(lit, wx, wz), b = at(base, wx, wz); return a.map((v, i) => v - b[i]); };
        out.near = gain(3, 0); out.far = gain(-3, 0); out.outsideGain = gain(4.5, 4.5);
        // three's own grid, baked at the same points in its float target, against the engine's half atlas: same picture
        const raw = new LightProbeGridWebGL(set.grid.width, set.grid.height, set.grid.depth, ...set.counts);
        raw.position.copy(set.grid.position); raw.updateBoundingBox();
        set.grid.visible = false;
        raw.bake(R, engine.scene, { cubemapSize: 8, near: 0.05, far: engine.camera.far });
        engine.scene.add(raw);
        const own = shot();
        raw.removeFromParent(); raw.dispose(); set.grid.visible = true;
        out.atlasErr = 0; for (let i = 0; i < lit.length; i++) out.atlasErr = Math.max(out.atlasErr, Math.abs(lit[i] - own[i]));
        // the texture left behind is the half atlas alone: the float target went with the bake (three keeps one small cube and batch target for reuse)
        const tex1 = info.memory.textures, again = await engine.bakeProbes(opt);
        out.texLeak = info.memory.textures - tex1 - 1; again.remove();
        // red share of the average light (DC term) at the probe side beside the wall and far from it
        const red = sh => { const c = sh.coefficients[0]; return c.x / Math.max(1e-6, (c.x + c.y + c.z) / 3); };
        out.redNear = red(set.sample([3, 1, 0])); out.redFar = red(set.sample([-3, 1, 0]));
        // halfway between grid points x = 0 and x = 3 is their average
        const a = set.sample([0, 1, 0]).toArray(), b = set.sample([3, 1, 0]).toArray(), m = set.sample([1.5, 1, 0]).toArray();
        out.lerpErr = Math.max(...m.map((v, i) => Math.abs(v - (a[i] + b[i]) / 2)));
        out.clampErr = Math.max(...set.sample([99, 1, 0]).toArray().map((v, i) => Math.abs(v - b[i])));
        // file round trip: JSON text -> loadProbes gives the same samples and the same picture
        const json = JSON.parse(JSON.stringify(set.toJSON()));
        out.fileBytes = JSON.stringify(json).length;
        const loaded = engine.loadProbes(json, { owner: 'probe-file' });
        out.jsonErr = Math.max(...loaded.sample([1, 1, 0.3]).toArray().map((v, i) => Math.abs(v - set.sample([1, 1, 0.3]).toArray()[i])));
        out.loadedSource = loaded.source;
        // a damaged file is refused with a code and adds nothing
        const before = engine.describe().render.probes.length;
        try { engine.loadProbes({ ...json, half: json.half.slice(8) }); out.badData = 'no throw'; } catch (e) { out.badData = e.code; }
        try { engine.loadProbes({ ...json, format: 'x' }); out.badFormat = 'no throw'; } catch (e) { out.badFormat = e.code; }
        try { engine.loadProbes({ ...json, version: 1 }); out.oldFile = 'no throw'; } catch (e) { out.oldFile = e.code; }
        out.countAfterBad = engine.describe().render.probes.length - before;
        try { await engine.bakeProbes({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, spacing: 1, spacng: 2 }); out.typo = 'no throw'; } catch (e) { out.typo = e.code; }
        try { await engine.bakeProbes({ bounds: { min: [0, 0, 0], max: [100, 100, 100] }, spacing: 1 }); out.tooMany = 'no throw'; } catch (e) { out.tooMany = e.code; }
        try { await engine.bakeProbes({ ...opt, follow: 'focus' }); out.follow = 'no throw'; } catch (e) { out.follow = e.code; }
        // float noise on a flat axis (2 um over 3 m spacing): two layers a spacing apart, as an exactly flat one gets
        const thin = await engine.bakeProbes({ bounds: { min: [0, 1, 0], max: [3, 1 + 2e-6, 3] }, spacing: 3, resolution: 4 });
        out.thin = { counts: thin.counts, step: thin.step }; thin.remove();
        // the two checks: a lit object past the grid is named; a hemisphere light and an environment are reported as counted twice
        const stray = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); stray.name = 'strayBox'; stray.position.set(40, 1, 0); engine.scene.add(stray);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1); hemi.name = 'fill'; engine.scene.add(hemi); engine.scene.updateMatrixWorld(true);
        const d = engine.describe().render;
        out.describe = d.probes[0]; out.text = /probes: 12 \(3x2x2/.test(d.text) && /strayBox/.test(d.text) && /picture (check|note) lit-twice: probe light/  /* a loaded file's set is in the scene too: its lights are unknown, so a note */.test(d.text);
        out.twice = d.checks.find(c => c.id === 'lit-twice')?.text;
        out.lightsRow = d.lights.some(l => /Grid/.test(String(l.type)));
        stray.removeFromParent(); hemi.removeFromParent();
        // the debug view draws one dot per probe and takes them away again
        engine.debug.view('probes', { owner: 'probe-test' });
        out.viewDots = engine.scene.getObjectByName('debug:probes')?.count ?? 0;
        engine.debug.clear('probe-test');
        out.viewGone = !engine.scene.getObjectByName('debug:probes');
        // remove: the grid leaves, the data stays readable; off means nothing left in the scene
        const grid = set.grid; set.remove(); set.remove(); loaded.remove();
        out.removed = !grid.parent && !engine.describe().render.probes.length && set.sample([0, 1, 0]).toArray()[0] === a[0];
        rt.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('bake: 3 x 2 x 2 = 12 probes, time measured, three\'s grid is in the scene', r.count === 12 && r.counts.join() === '3,2,2' && r.bakeMs > 0 && r.inScene && r.isGrid, J);
      check('[guard] per pixel: in one picture the floor beside the wall gets clearly redder light than the far floor', r.near[0] > 0.02 && r.near[0] / r.near[2] > 2 * (r.far[0] / r.far[2]), JSON.stringify([r.near, r.far]));
      check('[guard] stored half precision: a half-float Data3DTexture, not three\'s float target', r.half === true, J);
      check('[guard] the half atlas draws what three\'s own float grid draws (same layout)', r.atlasErr < 0.01, String(r.atlasErr));
      check('outside the grid the floor gets no probe light', r.outsideGain.every(v => Math.abs(v) < 1e-3), JSON.stringify(r.outsideGain));
      check('the probe beside the red wall is redder than the far one', r.redNear > r.redFar * 1.2, `near ${r.redNear} far ${r.redFar}`);
      check('sample halfway is the average of the two grid probes; outside the grid it clamps to the edge', r.lerpErr < 1e-3 && r.clampErr < 1e-5, `${r.lerpErr} ${r.clampErr}`);
      check('toJSON -> loadProbes gives the same samples, exactly (both are half precision)', r.jsonErr === 0 && r.loadedSource === 'file', String(r.jsonErr));
      check('a damaged / foreign / version 1 file is refused (probes-data) and adds nothing', r.badData === 'probes-data' && r.badFormat === 'probes-data' && r.oldFile === 'probes-data' && r.countAfterBad === 0, J);
      check('an axis thinner than a millionth of the spacing counts as flat: 2 layers, a whole step apart', r.thin.counts[1] === 2 && r.thin.step[1] === 3, JSON.stringify(r.thin));
      check('an option typo throws (module-params); too many probes throws (probes-option); follow is gone (module-params)', r.typo === 'module-params' && r.tooMany === 'probes-option' && r.follow === 'module-params', J);
      check('a second bake leaves one texture, the half atlas', r.texLeak === -1 || r.texLeak === 0, String(r.texLeak));
      check('[guard] describe names a lit object outside the grid and light counted twice (hemisphere), text line too', r.describe?.outside.names.includes('strayBox') && /HemisphereLight/.test(r.twice ?? '') && r.text, JSON.stringify([r.describe, r.twice]));
      check('describe: count, owner, source; the grid is not listed as a light', r.describe?.count === 12 && r.describe.owner === 'probe-test' && r.describe.source === 'bake' && !r.lightsRow, JSON.stringify(r.describe));
      check("debug.view('probes'): one dot per live probe (12 + 12 loaded), gone after clear", r.viewDots === 24 && r.viewGone, String(r.viewDots));
      check('remove(): grid leaves the scene and describe, data still readable; twice is harmless', r.removed);
    },
  },
  {
    // 为什么：步长 0 的文件在 sample() 里除以 0 得到 NaN，画面直接变黑也不报错，要在动手之前拒绝。
    name: 'light probes: a file with step 0 is refused',
    url: '/tests/probes/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.step(0.1);
        const json = { format: 'threedog-probes', version: 2, origin: [0, 0, 0], step: [0, 1, 1], counts: [2, 2, 2], half: btoa('\0'.repeat(8 * 27 * 2)) }, out = {};
        try { engine.loadProbes(json); out.step0 = 'no throw'; } catch (e) { out.step0 = e.code; }
        out.left = engine.describe().render.probes.length;
        return out;
      });
      check('[guard] step 0 is refused (probes-data), not sampled as NaN', r.step0 === 'probes-data' && r.left === 0, JSON.stringify(r));
    },
  },
];
