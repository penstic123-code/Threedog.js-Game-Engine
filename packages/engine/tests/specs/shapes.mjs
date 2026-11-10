// Four game shapes and the boundary rules, on the real engine in a real browser through public names (page: tests/shapes/main.js). Why: "you can tune a parameter" is not "you can do it
// another way", so each shape installs only what it needs and the checks fail if a shape had to bring a module, a player or a private field.
const PAGE = '/tests/shapes/index.html?scene=';
const boot = async () => { for (let i = 0; i < 300 && !window.game?.ready; i++) await new Promise(r => setTimeout(r, 50)); return !!window.game?.ready; };
const mods = () => [...engine.modules.keys()];
const base = { timeout: 120000, software: true };

export const specs = [
  {
    ...base, name: 'shapes explore: third person, then a game mover lying on a wall keeps interactions, saves and footsteps',
    url: PAGE + 'explore',
    async run({ check, ev, page, frames }) {
      check('starts', await ev(boot));
      check('only what it asked for', (await ev(mods)).join() === 'world,collision,cameraRig,characters,interactions', (await ev(mods)).join());
      const z0 = await ev(() => game.p.position.z);
      await page.keyboard.down('KeyW'); await frames(30); await page.keyboard.up('KeyW');
      const z1 = await ev(() => game.p.position.z);
      check('keys walk the player', Math.abs(z1 - z0) > 0.1, JSON.stringify([z0, z1]));
      const r = await ev(async () => {
        const { p, used, wallMover, engine: e } = game, o = {}, steps = [];
        e.haltLoop();
        const off = e.events.on('character:step', () => steps.push(1));
        p.placeAt([2, 0, 0]); e.step(1 / 60);
        p.mover = wallMover; o.mover = p.mover.name;
        e.input.simulate('moveForward');
        for (let i = 0; i < 120; i++) e.step(1 / 60);
        e.input.simulate('moveForward', false);
        o.y = p.position.y; o.tilt = p.root.quaternion.z; o.steps = steps.length; off.remove();
        for (let i = 0; i < 30; i++) e.step(1 / 60);
        o.y2 = p.position.y; o.tilt2 = p.root.quaternion.z;
        p.root.position.set(2, 0, 0); e.step(1 / 60);
        e.input.simulate('interact'); e.step(1 / 60); e.input.simulate('interact', false); e.step(1 / 60);
        o.used = used.length;
        o.saved = await e.saves.save('t'); o.loaded = await e.saves.load('t'); o.savedUsed = game.saved();
        return o;
      });
      check('the mover took over', r.mover === 'wall', r.mover);
      check('it climbs: no one height per x, z pulled it back', Math.abs(r.y) > 1 && Math.abs(r.y - r.y2) < 0.01, JSON.stringify([r.y, r.y2]));
      check('the body stays on its side', Math.abs(Math.abs(r.tilt) - Math.SQRT1_2) < 0.01 && Math.abs(Math.abs(r.tilt2) - Math.SQRT1_2) < 0.01, JSON.stringify([r.tilt, r.tilt2]));
      check('footsteps still fire', r.steps > 0, r.steps);
      check('interactions still work', r.used === 1, JSON.stringify(r));
      check('saves still work', r.saved && r.loaded && r.savedUsed === 1, JSON.stringify(r));
    },
  },
  {
    ...base, name: 'shapes one clip: a character with one clip of any name, no idle or walk',
    url: PAGE + 'explore',
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(async () => {
        const { engine: e, THREE: T, presets } = game, g = new T.Group(), b = new T.Bone(), o = {};
        g.add(b); b.name = 'spin';
        g.animations = [new T.AnimationClip('tumble', 1, [new T.NumberKeyframeTrack('spin.rotation[y]', [0, 1], [0, 3])])];
        e.haltLoop();
        const c = e.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0], model: g, animation: { states: { idle: { clip: 'tumble' } } } });
        for (let i = 0; i < 30; i++) e.step(1 / 60);
        o.has = !!c.anim; o.rot = c.root.getObjectByName('spin')?.rotation.y ?? null;
        return o;
      });
      check('it animates', r.has && r.rot > 0.5, JSON.stringify(r));
    },
  },
  {
    ...base, name: 'shapes strategy: real orthographic camera, click and box select, orders, nothing installed',
    url: PAGE + 'strategy',
    async run({ check, ev, page, frames }) {
      check('starts', await ev(boot));
      check('no module at all', (await ev(mods)).length === 0, (await ev(mods)).join());
      check('the real camera draws, no player', await ev(() => engine.camera === game.cam && game.cam.isOrthographicCamera && !engine.player));
      const at = i => ev(n => game.screen(game.units[n]), i), sel = () => ev(() => [...game.selected].map(u => u.name).join());
      const [x3, y3] = await at(3);
      await page.mouse.click(x3, y3); await frames(2);
      check('a click selects one', (await sel()) === 'unit3', await sel());
      const [ax, ay] = await at(0), [cx, cy] = await at(2);
      await page.mouse.move(ax - 15, ay - 15); await page.mouse.down(); await page.mouse.move(cx + 15, cy + 15, { steps: 4 }); await page.mouse.up(); await frames(2);
      check('a box selects three', (await sel()) === 'unit0,unit1,unit2', await sel());
      const before = await ev(() => game.units.map(u => u.position.toArray()));
      await page.mouse.click(x3 - 40, y3 + 10, { button: 'right' });
      await ev(() => { engine.haltLoop(); for (let i = 0; i < 400; i++) engine.step(1 / 60, { render: false, describe: false }); });
      const after = await ev(() => ({ u: game.units.map(u => u.position.toArray()), going: game.units.some(u => u.userData.goal) }));
      check('orders move the selection', Math.hypot(after.u[0][0] - before[0][0], after.u[0][2] - before[0][2]) > 2 && !after.going, JSON.stringify(after));
      check('and not the rest', after.u[3].join() === before[3].join(), JSON.stringify(after.u[3]));
    },
  },
  {
    ...base, name: 'shapes puzzle: authored shots, clicks, no player and no follow camera',
    url: PAGE + 'puzzle',
    async run({ check, ev, page, frames }) {
      check('starts', await ev(boot));
      check('only the fixed camera', (await ev(mods)).join() === 'cameraRig', (await ev(mods)).join());
      const spot = () => ev(() => { const o = game[game.log.length ? 'door' : 'lever'].position.clone().project(engine.camera); return [(o.x + 1) / 2 * innerWidth, (1 - o.y) / 2 * innerHeight]; });
      check('starts on the first shot', await ev(() => engine.camera.position.distanceTo(new game.THREE.Vector3(0, 3, 10)) < 0.01), await ev(() => engine.camera.position.toArray()));
      await page.mouse.click(...await spot()); await frames(3);
      check('a click on the lever cuts to the next shot', await ev(() => game.log.join() === 'lever' && engine.camera.position.x === 12), await ev(() => game.log.join() + ' ' + engine.camera.position.toArray()));
      await page.mouse.click(...await spot()); await frames(3);
      check('a click in that shot opens the door', await ev(() => game.log.join() === 'lever,door' && !game.door.visible), await ev(() => game.log.join()));
    },
  },
  {
    ...base, name: 'shapes procedural: no module, no player, own ShaderMaterial on onFrame reads back as its colour',
    url: PAGE + 'procedural',
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(async () => {
        const e = engine, r0 = game.knot.rotation.y; await __t.frames(4);
        e.haltLoop(); e.step(1 / 60);
        const c = e.renderer.domElement, gl = e.renderer.getContext(), mid = new Uint8Array(4), edge = new Uint8Array(4);
        gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, mid); gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, edge);
        return { spun: game.knot.rotation.y - r0, mid: [...mid], edge: [...edge], mods: e.modules.size, kids: e.scene.children.length };
      });
      check('nothing installed, one child', r.mods === 0 && r.kids === 1, JSON.stringify(r));
      check('onFrame drives it', r.spun > 0, r.spun);
      check('the shader output is on screen as written', r.mid.join() === '255,0,255,255', r.mid.join());
      check('the background is what the game set', r.edge.join() === '0,0,0,255', r.edge.join());
    },
  },
  {
    ...base, name: 'shapes bare: lights false adds nothing to the scene and draws what three.js draws',
    url: PAGE + 'bare',
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(async () => {
        const { engine: e, THREE: T, listeners } = game, s = e.scene, gl0 = e.renderer, o = {};
        o.kids = s.children.map(c => c.type + ':' + c.name); o.fog = s.fog; o.env = s.environment; o.tone = gl0.toneMapping; o.space = gl0.outputColorSpace; o.exposure = gl0.toneMappingExposure;
        o.post = e.post.active; o.defaults = e.describe().render.defaults.map(d => d.what);
        o.shadow = gl0.shadowMap.enabled; o.bg = s.background?.getHexString?.() ?? null;
        o.unsignalled = listeners.filter(l => !l.signal).map(l => l.type);
        o.counts = e.counts();
        e.renderer.shadowMap.enabled = false; s.background = null;
        const m = new T.Mesh(new T.SphereGeometry(4, 24, 16), new T.MeshStandardMaterial({ color: 0x4080c0 })), sun = new T.DirectionalLight(0xffffff, 2);
        sun.position.set(3, 5, 4); s.add(m, sun); e.camera.position.set(0, 0, 20); e.camera.lookAt(0, 0, 0);
        e.haltLoop();
        const read = (r, w, h) => { const gl = r.getContext(), b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
        const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
        e.step(1 / 60); const a = read(e.renderer, w, h);
        const c2 = Object.assign(document.createElement('canvas'), { width: w, height: h }), plain = new T.WebGLRenderer({ canvas: c2, antialias: false });
        plain.setPixelRatio(1); plain.setSize(w, h, false); plain.render(s, e.camera); const b = read(plain, w, h);
        let diff = 0, lit = 0; for (let i = 0; i < a.length; i++) { if (Math.abs(a[i] - b[i]) > 1) diff++; if (i % 4 === 2 && a[i] > 20) lit++; }
        o.diff = diff; o.lit = lit;
        plain.dispose();
        return o;
      });
      check('an empty scene', r.kids.length === 0 && r.fog === null && r.env === null, JSON.stringify(r));
      check('three.js renderer defaults', r.tone === 0 && r.space === 'srgb' && r.exposure === 1 && !r.post, JSON.stringify(r));
      check('what stands is named with its off switch', r.defaults.join() === 'scene.background,renderer.shadowMap' && r.bg === '8c8c8c' && r.shadow, JSON.stringify(r.defaults));
      check('no frame hook or static of its own', r.counts.frame === 0 && r.counts.fixed === 0 && r.counts.statics === 0, JSON.stringify(r.counts));
      check('every window listener goes with dispose', r.unsignalled.length === 0, JSON.stringify(r.unsignalled));
      check('with those two off, the same pixels as plain three.js', r.lit > 100 && r.diff === 0, JSON.stringify([r.lit, r.diff]));
    },
  },
  {
    ...base, name: 'shapes native objects: a scene.add mesh and own camera are picked, shadowed, posted, and left to the game to free',
    url: PAGE + 'bare',
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(() => {
        const { engine: e, THREE: T, vignette } = game, s = e.scene, o = {};
        e.haltLoop();
        const lit = c => new T.MeshLambertMaterial({ color: c });
        const plane = new T.Mesh(new T.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), lit(0xffffff)), ball = new T.Mesh(new T.SphereGeometry(1, 16, 12), lit(0xff0000)), sun = new T.DirectionalLight(0xffffff, 3);
        ball.position.y = 3; ball.castShadow = true; plane.receiveShadow = true; sun.position.set(10, 20, 0); sun.castShadow = true;
        Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
        s.background = new T.Color(0); s.add(plane, ball, sun);
        const own = new T.PerspectiveCamera(50, 1, 0.1, 100); own.position.set(0, 25, 0.01); own.lookAt(0, 0, 0); e.camera = own;
        const px = (x, y) => { e.step(1 / 60); const gl = e.renderer.getContext(), c = e.renderer.domElement, b = new Uint8Array(4); gl.readPixels(c.width * x | 0, c.height * y | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [...b]; };
        const at = p => { const q = new T.Vector3(...p).project(own); return [(q.x + 1) / 2, (q.y + 1) / 2]; };
        o.pickDefault = e.pick(0, 0)?.object === ball;
        o.pickListed = e.pick(0, 0, { targets: [ball, plane] })?.object === ball;
        e.rays.addStatic(ball); o.pickRegistered = e.pick(0, 0)?.object === ball;
        o.shadowed = px(...at([-1.6, 0, 0])); ball.castShadow = false; o.open = px(...at([-1.6, 0, 0])); ball.castShadow = true;
        o.corner = px(0.03, 0.03); e.post.add(vignette()); o.posted = px(0.03, 0.03);
        let freed = 0; ball.geometry.addEventListener('dispose', () => freed++); ball.material.addEventListener('dispose', () => freed++);
        e.dispose(); o.freed = freed;
        return o;
      });
      check('a listed mesh picks with no registration', r.pickListed, JSON.stringify(r));
      check('a registered mesh picks', r.pickRegistered, JSON.stringify(r));
      check('its shadow falls through the engine shadow map', r.shadowed[0] < r.open[0] - 40, JSON.stringify(r));
      check('post runs over it, through the own camera', r.posted[0] < r.corner[0] - 5, JSON.stringify(r));
      // whoever made a resource frees it (docs/plans/2026-11-09-resource-lifetime.md, design 6.2): engine.dispose() lets go of the game's mesh and frees none of it
      check('dispose leaves its geometry and material to the game', r.freed === 0, String(r.freed));
    },
  },
  // the game's own renderer is the one route to a transparent canvas (recipes/50-own-renderer.md): both backends, with and without a post effect
  ...[['', 'WebGL'], ['post', 'WebGL with a post effect'], ['gpu', 'WebGPURenderer'], ['gpupost', 'WebGPURenderer with a post effect'], ['gpuswap', "WebGPURenderer replaced by fallback: 'webgl'"]].map(([mode, what]) => ({
    ...base, name: 'shapes transparent: a canvas with alpha over a page shows the page where nothing is drawn, ' + what,
    url: PAGE + 'clear&mode=' + mode,
    ...(mode === 'gpuswap' && { notRealWebGPU: 'the page takes WebGPU away: this is the fallback' }),
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(() => {
        engine.haltLoop(); engine.step(1 / 60);
        // the canvas copied into a 2D canvas in the same task as the render: the same read for either backend
        const c = game.renderer.domElement, t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
        const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0);
        return { corner: [...x.getImageData(2, 2, 1, 1).data], mid: [...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data], gpu: !!game.renderer.isWebGPURenderer };
      });
      check('the renderer is the one asked for', r.gpu === (mode.includes('gpu') && !mode.includes('swap')), String(r.gpu));
      check('empty pixels have zero alpha', r.corner[3] === 0, r.corner.join());
      check('the box is opaque red', r.mid[3] === 255 && r.mid[0] > 250 && r.mid[1] < 5 && r.mid[2] < 5, r.mid.join());
    },
  })),
  {
    ...base, name: 'shapes rays: every hit on a ray, and one chosen surface, through a cave and a bridge',
    url: PAGE + 'bare',
    async run({ check, ev }) {
      check('starts', await ev(boot));
      const r = await ev(() => {
        const { engine: e, THREE: T } = game, o = {}, slab = (y, n) => { const m = new T.Mesh(new T.BoxGeometry(10, 0.2, 10), new T.MeshBasicMaterial()); m.position.y = y; m.name = n; e.scene.add(m); m.updateMatrixWorld(); return m; };
        const parts = [slab(9, 'cave roof'), slab(5, 'bridge'), slab(0, 'cave floor')];
        e.rays.addStatic(parts);
        const down = new T.Vector3(0, -1, 0), from = new T.Vector3(0, 20, 0);
        o.native = [...new Set(new T.Raycaster(from, down).intersectObjects(parts).map(h => h.object.name))];
        const seen = []; e.raycast(from, down, { filter: h => { seen.push(h.object.name); return false; } }); o.filterSaw = seen;
        o.surface = e.raycast(from, down, { filter: h => h.object.name === 'cave floor' })?.object.name;
        o.listed = e.raycast(from, down, { targets: [parts[1]] })?.object.name;
        return o;
      });
      check('native three.js gives every surface in order', r.native.join() === 'cave roof,bridge,cave floor', r.native.join());
      check('engine.raycast with a filter walks them all', new Set(r.filterSaw).size === 3, r.filterSaw.join());
      check('and picks one surface', r.surface === 'cave floor' && r.listed === 'bridge', JSON.stringify(r));
    },
  },
  {
    ...base, name: 'shapes cellar: a follow camera below another floor stays with the player, under that floor',
    url: '/tests/apartment/',
    async run({ check, ev }) {
      check('starts', await ev(async () => { for (let i = 0; i < 300 && !(window.game?.ready && engine.nav?.ready); i++) await new Promise(r => setTimeout(r, 100)); return !!window.game?.ready; }));
      const r = await ev(async () => {
        const e = engine, g = game; e.haltLoop();
        const rise = y => { g.one.placeAt([0, y, 0]); g.two.placeAt([1, y, 0]); for (let i = 0; i < 90; i++) e.step(1 / 60, { describe: false }); return e.camera.position.y - g.one.position.y; };
        return rise(g.FLOOR.cellar) + g.FLOOR.cellar;
      });
      check('the camera stays under the floors above', r < 0, r);
    },
  },
];
