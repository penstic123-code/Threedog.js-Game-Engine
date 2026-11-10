// engine.shadows.cascades(light): one entry for a game's own DirectionalLight and for the engine sun, with or without a sky.
// Guards: one copy of the engineering (only render/cascades.js builds on the addon, both routes make the same class), the light stays the game's (nothing about
// the picture is written on it, its own position / target come back), it follows the camera and the light, it reads engine.tier, every misuse fails at the call.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sources = dir => readdirSync(dir, { withFileTypes: true }).flatMap(f => (f.isDirectory() ? sources(join(dir, f.name)) : f.name.endsWith('.js') ? [join(dir, f.name)] : []));

export const specs = [
  {
    name: '[guard] cascades own light: no sky, one entry, the light stays the game\'s, follows camera and light, reads the tier, misuse fails by name',
    url: '/tests/perf/index.html?mode=world',
    software: true,   // reads rendered pixels: same numbers on every machine
    async run({ page, check, ev }) {
      const importers = ['core', 'render', 'modules', 'ui'].flatMap(d => sources(join(ENGINE, d)))
        .filter(f => /from 'three\/addons\/csm\/CSM(ShadowNode)?\.js'/.test(readFileSync(f, 'utf8'))).map(f => relative(ENGINE, f).replaceAll('\\', '/')).sort();
      check('[guard] one copy: only render/cascades.js and its WebGPU half build on three\'s cascades', importers.join() === 'render/cascades.js,render/cascades.tsl.js', importers.join());
      const core = readFileSync(join(ENGINE, 'render/shadows.js'), 'utf8');
      check('[guard] the core entry imports no module', !/from '[^']*modules\//.test(core));

      const r = await ev(() => {
        const { THREE, createEngine, sky, materialPatches } = threedogTest;
        const out = {}, N = 48, near = (a, b, d = 1e-6) => Math.abs(a - b) < d;
        const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
        const make = (o = {}) => createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'cascades-own-light', pixelRatio: 1, ...o });
        const e = make({ lights: false });
        e.tier = 'high';   // a headless page detects low; the tier's own check is below
        e.haltLoop?.();
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 1 }));
        ground.receiveShadow = true;
        const box = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 6), new THREE.MeshStandardMaterial({ color: 0x808080 }));
        box.position.set(0, 5, 0); box.castShadow = true;
        const light = new THREE.DirectionalLight(0xffeecc, 2.5);
        light.name = 'gameSun'; light.position.set(40, 80, 30); light.castShadow = true; light.shadow.mapSize.setScalar(512);
        const player = new THREE.Object3D(); player.position.set(3, 0, -2);
        light.target = player;   // the plain three.js way to aim at something the game moves
        e.scene.add(ground, light, player);
        e.camera.position.set(0, 30, 45); e.camera.lookAt(0, 0, 0);
        const rt = new THREE.WebGLRenderTarget(N, N), R = e.renderer, bytes = new Uint8Array(N * N * 4);
        const shot = () => {
          e.step(1 / 30, { describe: false });
          R.setRenderTarget(rt); R.render(e.scene, e.camera); R.readRenderTargetPixels(rt, 0, 0, N, N, bytes); R.setRenderTarget(null);
          return Array.from(bytes);
        };
        const mean = px => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i]; return s / (px.length / 4); };
        const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) n++; return n / (a.length / 4) * 100; };
        const box0 = { ...light.shadow.camera };
        const plain = shot();

        const h = e.shadows.cascades(light, { count: 3, maxFar: 80 });
        const c = h.csm, cls = c.constructor;
        const on = shot();
        out.on = { lights: c.lights.length, first: c.lights[0] === light, same: e.shadows.csm === c, inScene: c.lights.every(l => l.parent === e.scene),
          csm: materialPatches(ground.material).includes('csm'), owned: e.describe().owned?.['shadow.csm']?.materials ?? [], ratio: mean(on) / mean(plain) };
        e.scene.add(box);
        const withBox = shot();
        out.cast = changed(on, withBox);

        out.yours = { color: light.color.getHex(), intensity: light.intensity, cast: light.castShadow, player: player.position.toArray(), playerTarget: light.target === player };
        light.intensity = 1.5; light.color.set(0x88aaff); light.shadow.bias = -0.002; light.shadow.mapSize.setScalar(256); light.shadow.intensity = 0.3;
        shot();
        out.read = c.lights.slice(1).map(l => ({ i: l.intensity, c: l.color.getHex(), b: l.shadow.bias, m: l.shadow.mapSize.x, s: l.shadow.intensity }));
        light.intensity = 2.5; light.shadow.bias = 0; light.shadow.intensity = 1;

        // dispose() on a material that stays on its mesh is a game forcing a rebuild: it still loses the patch at remove()
        const kept = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
        e.scene.add(kept);
        shot();
        kept.material.dispose();

        const before = c.lights.map(l => l.position.clone());
        e.camera.position.x += 60; e.camera.lookAt(60, 0, 0);
        shot();
        out.follow = c.lights.map((l, i) => l.position.distanceTo(before[i]));

        // picture code aims the light in onRender, after the frame hooks; the cascades must still be what is drawn
        const aim = e.onRender(() => light.position.set(-60, 50, 10));
        let drawn = null;
        const seen = e.onRender(() => { drawn = light.position.clone(); }, { when: 'after' });
        shot(); shot();
        const want = new THREE.Vector3(-60, 50, 10).sub(player.position).normalize(), got = light.position.clone().sub(light.target.position).normalize();
        out.aim = { dot: want.dot(got), placed: drawn.distanceTo(new THREE.Vector3(-60, 50, 10)) };
        aim.remove(); seen.remove();
        light.position.set(-60, 50, 10);

        light.castShadow = false; shot();
        out.noCast = c.lights.slice(1).every(l => !l.visible);
        light.castShadow = true; shot();
        out.cast2 = c.lights.slice(1).every(l => l.visible);

        out.errors = {
          twice: err(() => e.shadows.cascades(light)), notLight: err(() => e.shadows.cascades(new THREE.PointLight())),
          off: err(() => e.shadows.cascades(new THREE.DirectionalLight())), split: err(() => h.set({ split: 'nope' })), key: err(() => h.set({ cout: 2 })), count: err(() => h.set({ count: 9 })),
        };
        h.set({ count: 2 });
        out.set = { lights: h.csm.lights.length, first: h.csm.lights[0] === light };
        const extra = h.csm.lights.slice(1);
        h.remove(); h.remove();
        out.keptPatch = materialPatches(kept.material).includes('csm');
        out.off = { pos: light.position.toArray(), target: light.target === player, player: player.position.toArray(), csm: e.shadows.csm, handle: h.csm, gone: extra.every(l => !l.parent),
          patch: materialPatches(ground.material).includes('csm'), box: ['left', 'right', 'top', 'bottom', 'near', 'far'].every(k => near(light.shadow.camera[k], box0[k])), owned: e.describe().owned?.['shadow.csm'] ?? null };

        light.castShadow = false;
        out.noShadow = err(() => e.shadows.cascades(light));
        light.castShadow = true;
        e.tier = 'low';
        // one map, far from the origin: the box's shadow must still be there, so the map has to follow the camera
        box.position.set(200, 5, 200); e.camera.position.set(200, 30, 225); e.camera.lookAt(200, 0, 200);
        const cast = () => { box.castShadow = false; const a = shot(); box.castShadow = true; return changed(a, shot()); };
        const low = e.shadows.cascades(light, { count: 3, maxFar: 90 }), sc = light.shadow.camera;
        out.low = { csm: low.csm, cast: cast(), right: sc.right, far: sc.far, depth: light.position.distanceTo(light.target.position), refused: err(() => e.shadows.box(light)) };
        low.set({ maxFar: 60 });
        shot();
        out.lowSet = sc.right;
        low.set({ low: { count: 2 } });
        out.lowCount = low.csm?.lights.length;
        low.set({ low: { count: 1 } });
        shot();
        // the one map's size reads count (it was left out of the rebuild key): 60 / 4, then a game's own count 1 is all of maxFar with no forward shift
        const shift = () => Math.hypot(light.target.position.x - e.camera.position.x, light.target.position.z - e.camera.position.z);
        low.set({ count: 4 }); shot(); out.count4 = { right: sc.right, shift: shift() };
        low.set({ count: 1 }); shot(); out.count1 = { right: sc.right, shift: shift() };
        // a maxFar under count meters worked before the cut: the derived size stays at the box's 1 m minimum, it does not throw
        out.tiny = err(() => low.set({ count: 3, maxFar: 1 })); out.tinyRight = sc.right;
        low.set({ count: 3, maxFar: 60 });
        low.remove();
        out.lowOff = { pos: light.position.toArray(), target: light.target === player, box: ['left', 'right', 'top', 'bottom', 'near', 'far'].every(k => near(sc[k], box0[k])) };
        e.tier = 'high';
        // a box that was given no extent never sized the camera, so what the game wrote there later stays
        const free = e.shadows.box(light);
        sc.right = 33;
        free.remove();
        out.boxKept = sc.right;
        sc.right = box0.right;
        // ahead follows the level part of the view continuously: straight down shifts 0, a hair off straight down shifts a hair (it jumped the whole 10 m)
        const fwd = e.shadows.box(light, { follow: 'camera', ahead: 10, snap: 0 });
        const aheadAt = (x, y) => { e.camera.position.set(0, 40, 0); e.camera.lookAt(x, y, 0); shot(); return Math.hypot(light.target.position.x, light.target.position.z); };
        out.ahead = [aheadAt(0, 0), aheadAt(0.2, 0), aheadAt(10, 40)];   // straight down, 0.3 degrees off it, level
        fwd.remove();

        // cascades on, a chunk's material leaves the scene and is disposed: nothing here may hold it (the spec collects garbage and looks)
        window.liveCascades = e.shadows.cascades(light, { count: 2 });
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
        e.scene.add(chunk);
        shot();
        window.chunkMaterial = new WeakRef(chunk.material);
        e.scene.remove(chunk); chunk.material.dispose(); chunk.material = null;
        shot(); shot();
        rt.dispose();

        // the engine sun takes the same entry under a sky: one set per engine, and its box comes back after
        const s = make();
        s.tier = 'high';
        s.use(sky({ time: '10:00' }));
        s.step(1 / 30, { describe: false });
        const sunH = s.shadows.cascades(s.lights.sun, { count: 3 });
        const own = new THREE.DirectionalLight(); own.castShadow = true; s.scene.add(own);
        s.step(1 / 30, { describe: false });
        out.sky = { sameClass: s.shadows.csm?.constructor === cls, taken: err(() => s.shadows.cascades(own)), lights: s.shadows.csm?.lights.length };
        sunH.remove();
        s.focus.set(40, 0, 0); s.step(1 / 30, { describe: false });
        out.sky.boxBack = s.lights.sun.target.position.x;
        s.lights.sun.castShadow = false;
        const beside = s.shadows.cascades(own);
        out.sky.back = err(() => s.shadows.cascades(s.lights.sun));
        out.sky.kept = { handle: !!beside.csm };
        s.dispose();

        // a sky without its sun: the error points here, and a game light works beside that sky
        const n = make({ lights: false });
        n.tier = 'high';
        n.use(sky({ time: '10:00' }));
        out.noSun = err(() => n.shadows.cascades(n.lights.sun, { count: 3 }));
        const nl = new THREE.DirectionalLight(); nl.castShadow = true; n.scene.add(nl);
        const nh = n.shadows.cascades(nl, { count: 2 });
        n.step(1 / 30, { describe: false });
        out.noSunWorks = nh.csm?.lights.length;
        n.dispose();
        e.dispose();
        out.disposed = !!e.disposed;
        return out;
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage');
      check('[guard] running cascades do not keep a disposed material alive (streamed terrain: one material and color map per chunk)', await ev(() => window.chunkMaterial.deref() === undefined));
      check('a material disposed but kept on its mesh still loses the csm patch at remove()', r.keptPatch === false);
      console.log('  cascades own light numbers:', JSON.stringify({ on: r.on, cast: r.cast, follow: r.follow, aim: r.aim }));

      check('[guard] a light with no sky module installed gets 3 cascades, it is cascade 0, the extras are in the scene', r.on.lights === 3 && r.on.first && r.on.same && r.on.inScene, JSON.stringify(r.on));
      check('[guard] the game material carries the csm patch and describe().owned says so', r.on.csm && r.on.owned.includes('MeshStandardMaterial'), JSON.stringify(r.on.owned));
      check('[guard] the picture is lit once, not once per cascade: same brightness as one map (within 5%)', Math.abs(r.on.ratio - 1) < 0.05, r.on.ratio);
      check('a box casts through the cascades (more than 0.5% of the picture changes)', r.cast > 0.5, r.cast);
      check('[guard] nothing about the picture is written on the light, and the game\'s target stays where it was', r.yours.color === 0xffeecc && r.yours.intensity === 2.5 && r.yours.cast && !r.yours.playerTarget && r.yours.player.join() === '3,0,-2', JSON.stringify(r.yours));
      check('what the game writes on its light reaches every cascade (intensity, color, bias, map size)', r.read.length === 2 && r.read.every(l => l.i === 1.5 && l.c === 0x88aaff && l.s === 0.3 && l.b === -0.002 && l.m === 256), JSON.stringify(r.read));
      check('[guard] the cascades follow the camera', r.follow.every(d => d > 20), JSON.stringify(r.follow));
      check('[guard] a position written in onRender sets the direction, and what is drawn is the placement', r.aim.dot > 0.99999 && r.aim.placed > 1, JSON.stringify(r.aim));
      check('light.castShadow off hides the extra lights (they would only add light), on shows them', r.noCast && r.cast2, JSON.stringify([r.noCast, r.cast2]));
      const e = r.errors;
      check('[guard] misuse fails at the call: second handle, not a DirectionalLight, not in the scene, bad split, unknown key, count out of range',
        /already has a cascades handle/.test(e.twice) && /needs a three\.js DirectionalLight/.test(e.notLight) && /engine\.scene\.add\(light\)/.test(e.off) && /split must be/.test(e.split) && /cout/.test(e.key) && /count/.test(e.count), JSON.stringify(e));
      check('[guard] castShadow off fails at the call: the engine does not write it', /castShadow = true/.test(r.noShadow), r.noShadow);
      check('handle.set rebuilds with the light still cascade 0', r.set.lights === 2 && r.set.first, JSON.stringify(r.set));
      check('[guard] remove gives everything back: position, target, shadow box; extras and patch gone; a second remove is harmless',
        r.off.pos.join() === '-60,50,10' && r.off.target && r.off.player.join() === '3,0,-2' && r.off.csm === null && r.off.handle === null && r.off.gone && !r.off.patch && r.off.box && r.off.owned === null, JSON.stringify(r.off));
      // [guard] the low tier must not trade sharpness for reach: its one map is maxFar / count each way (90 / 3), the texel size of an average cascade; stretched
      // over all of maxFar it had 3x the texels and PCF's blur grows with them (the low-tier soft smear)
      check('[guard] low tier: one map that follows the camera, maxFar / count each way (cascade-sized texels), so a shadow 280 m from the origin is drawn; low: { count } opts in',
        r.low.csm === null && r.low.cast > 0.5 && r.low.right === 30 && r.low.far === 160 && Math.abs(r.low.depth - 130) < 1e-6 && Math.abs(r.lowSet - 20) < 1e-9 && r.lowCount === 2, JSON.stringify([r.low, r.lowSet, r.lowCount]));
      check('[guard] that map is a placement like the cascades: engine.shadows.box on the light is refused by name, remove() gives position, target and shadow box back',
        /has cascades/.test(r.low.refused) && r.lowOff.target && r.lowOff.box && r.lowOff.pos.join() === '-60,50,10', JSON.stringify([r.low.refused, r.lowOff]));
      check('a box with no extent leaves a later write to the shadow camera alone at remove()', r.boxKept === 33, String(r.boxKept));
      check('[guard] low tier one map follows count: 60 / 4 shifted ahead, count 1 back to all 60 m on the camera; maxFar 1 at count 3 does not throw',
        r.count4.right === 15 && r.count4.shift > 1 && r.count1.right === 60 && r.count1.shift < 1 && r.tiny === '' && r.tinyRight === 1, JSON.stringify([r.count4, r.count1, r.tiny, r.tinyRight]));
      check('[guard] box ahead is continuous: 0 looking straight down, under 0.1 m a hair off it, about 10 m level', r.ahead[0] < 0.01 && r.ahead[1] < 0.1 && Math.abs(r.ahead[2] - 10) < 0.01, JSON.stringify(r.ahead));
      check('[guard] the engine sun under a sky takes the same entry: same class, 3 lights, and its box follows the focus again after remove()', r.sky.sameClass && r.sky.lights === 3 && r.sky.boxBack === 40, JSON.stringify(r.sky));
      check('[guard] one set per engine, named at the second call', /already/.test(r.sky.taken) && r.sky.kept.handle, JSON.stringify(r.sky));
      check('[guard] lights: false under a sky: the sun is refused by name (not in the scene), and a game light works beside the sky', /engine\.scene\.add/.test(r.noSun) && r.noSunWorks === 2, r.noSun);
      check('engine.dispose with a live handle does not throw', r.disposed);
    },
  },
  {
    name: '[guard] cascades own light on WebGPU: the node sits on the game light, the light is not moved, off restores, no threedog/tsl fails by name',
    url: '/tests/cascades-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.ownLightWebGPU());
      check('[guard] the shadow node sits on the game\'s light, one light in the scene', r.node && r.onLight && r.dirLights === r.dirBefore, JSON.stringify(r));
      check('[guard] the light keeps its position and target (three\'s node moves stand-ins)', r.still, JSON.stringify(r));
      check('the cascades cast (more than 0.5% of the picture changes)', r.changed > 0.5, r.changed);
      check('[guard] a target under a parent: the cascades take its world direction, the same as the light', r.parented.same && r.parented.cascades.every((v, i) => Math.abs(v - r.parented.light[i]) < 1e-4), JSON.stringify(r.parented));
      check('remove takes the node off and restores the shadow box', r.off.node && r.off.far === r.far0, JSON.stringify(r.off));
      check('[guard] without threedog/tsl the call names the import and the entry', /threedog\/tsl/.test(r.noTsl) && /engine\.shadows\.cascades/.test(r.noTsl), r.noTsl);
    },
  },
];
