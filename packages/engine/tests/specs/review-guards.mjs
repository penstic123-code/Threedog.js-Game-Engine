// Review guards ("do not bypass"): the engine picks no gameplay key, no day cycle, no dialogue duck and no sea for a game; plus the bugs the
// review found (autopilot speed, afterLoad on newGame, idle shadow slots, level nodes without world, canvas with one auto axis, audio before unlock...).
// Same format as the other files here. Run: npm test -- "review guard"
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'review guard: no module binds a gameplay key or takes a keys option; presets.bindings holds them; module actions leave with the module',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { createEngine, presets } = T, out = {};
        const err = f => { try { f(); return null; } catch (e) { return String(e.code || e.message); } };
        const E = mk(createEngine, 'rg-keys');
        // every module that used to take keys: installs without them, declares its action, binds nothing
        out.use = err(() => E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.interactions({ ...presets.interactions.nearest }), T.inventory(), T.quests(), T.photo(), T.grids(), T.rtsCamera()));
        const acts = ['interact', 'inventory', 'quests', 'photo', 'jump', 'run', 'brake', 'rotateLeft', 'rotateRight'];
        out.declared = acts.filter(a => E.input.actions.has(a));
        out.bound = acts.filter(a => E.input.keysOf(a).length);
        // a keys option is an unknown option now (the old way fails loudly instead of being ignored)
        out.keysOpt = ['inventory', 'quests', 'photo', 'interactions'].map(n => err(() => T[n]({ keys: ['KeyX'], pick: 'nearest' })));
        out.brakeOpt = err(() => T.characters({ brakeKeys: ['KeyB'] }));
        out.presetKeys = 'keys' in presets;
        // modules leave with their actions (ctx-tracked, also the rts camera's and the grid preview's)
        const albumUrl = URL.createObjectURL(new Blob(['x'])), revoked = [], revoke = URL.revokeObjectURL; E.photo.album.push({ url: albumUrl });
        URL.revokeObjectURL = u => { revoked.push(u); revoke.call(URL, u); };
        for (const n of ['inventory', 'quests', 'photo', 'interactions', 'cameraRig', 'characters']) E._unuse(n);
        out.left = acts.filter(a => E.input.actions.has(a));
        URL.revokeObjectURL = revoke; out.photoGone = [E.ops.defs.has('photo.take'), revoked.includes(albumUrl)];
        const F = mk(createEngine, 'rg-keys2', { bindings: { ...presets.bindings.walk, ...presets.bindings.inventory, ...presets.bindings.brake } });
        F.use(T.world(), T.inventory());
        out.invKeys = F.input.keysOf('inventory'); out.jump = F.input.keysOf('jump'); out.brake = F.input.keysOf('brake');
        // core pad keys are only in the basics: a game binding jump to Space gets no gamepad A behind its back
        const G = mk(createEngine, 'rg-keys3', { bindings: { jump: ['Space'], interact: ['KeyF'], run: ['ShiftLeft'] } });
        out.gJump = G.input.keysOf('jump'); out.gInteract = G.input.keysOf('interact'); out.gRun = G.input.keysOf('run');
        out.confirmPad = G.input.keysOf('confirm').includes('PadA');
        E.dispose(); F.dispose(); G.dispose();
        return out;
      });
      check('modules install without keys and declare their actions', r.use === null && r.declared.length === 9, JSON.stringify(r));
      check('[guard] no module binds a key by itself', r.bound.length === 0, JSON.stringify(r.bound));
      check('[guard] keys / brakeKeys options are unknown options; presets.keys is gone', r.keysOpt.every(x => x === 'module-params') && r.brakeOpt === 'module-params' && !r.presetKeys, JSON.stringify(r));
      check('[guard] module actions leave with the module (rts camera and characters too)', r.left.length === 0, JSON.stringify(r.left));
      check('[guard] photo takes its op and its album blob URLs with it', r.photoGone[0] === false && r.photoGone[1], JSON.stringify(r.photoGone));
      check('presets.bindings: inventory I + Y, walk Space + A, brake B + LT', r.invKeys.includes('KeyI') && r.invKeys.includes('PadY') && r.jump.includes('PadA') && r.brake.includes('PadLT'), JSON.stringify(r));
      check('[guard] core adds no gamepad key to jump / interact / run; confirm keeps PadA', !r.gJump.some(k => k.startsWith('Pad')) && !r.gInteract.some(k => k.startsWith('Pad')) && !r.gRun.some(k => k.startsWith('Pad')) && r.confirmPad, JSON.stringify(r));
    },
  },
  {
    name: 'review guard: calendar() keeps a fixed time of day, presets.calendar.cycle moves it; music() does not duck for dialogue unless asked; time condition warns on unknown forms',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { createEngine, presets } = T, out = {};
        const E = mk(createEngine, 'rg-sky');
        E.use(T.calendar({ time: 0.3 }), T.sky(), T.music()); await E.start();
        const t0 = E.calendar.timeOfDay; E.step(30, { render: false }); out.fixed = E.calendar.timeOfDay === t0; out.len = E.calendar.dayLength;
        E.audio._init();
        E.events.emit('dialogue:start', {}); E.step(0.5, { render: false });
        out.duck = E.audio.info.ducks.music ?? 1;
        const warns = [], w0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
        out.evening = E.audio.matches({ time: 'evening' }, {}); console.warn = w0;
        out.warned = warns.some(m => /never matches/.test(m) && /'day', 'night'/.test(m));
        const F = mk(createEngine, 'rg-sky2');
        F.use(T.calendar({ ...presets.calendar.cycle, time: 0.3 }), T.sky(), T.music({ duckDialogue: 0.35 })); await F.start();
        F.step(30, { render: false }); out.moves = F.calendar.timeOfDay > 0.3;
        F.audio._init(); F.events.emit('dialogue:start', {}); F.step(1, { render: false });
        out.duckOn = F.audio._ducks.size;
        out.seasonsCycle = presets.calendar.fourSeasons.dayLength;
        E.dispose(); F.dispose();
        return out;
      });
      check('[guard] calendar() alone: dayLength Infinity, the time of day does not move', r.fixed && r.len === Infinity, JSON.stringify(r));
      check('presets.calendar.cycle (and fourSeasons) bring the 360 s day', r.moves && r.seasonsCycle === 360, JSON.stringify(r));
      check('[guard] music() alone does not duck for dialogue; duckDialogue opts in', r.duck === 1 && r.duckOn === 1, JSON.stringify(r));
      check('time: \'evening\' warns with the accepted forms and does not match', r.evening === false && r.warned, JSON.stringify(r));
    },
  },
  {
    name: 'review guard: terrain has no sea and leaves the fog unless asked; idle shadow slots skip their shadow pass; shadows >= point still lights plain sources',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { lightPool } = T, { createEngine } = T, out = {};
        out.water = T.createTerrain({}).waterLevel;
        const E = mk(createEngine, 'rg-terrain');
        E.use(T.terrain({ viewChunks: 2 })); await E.start();
        out.fogFar = E.terrain.viewFogFar; out.engineWater = E.waterLevel;
        const F = mk(createEngine, 'rg-terrain2');
        F.use(T.terrain({ viewChunks: 2, viewFog: true })); await F.start(); out.viewFog = F.terrain.viewFogFar;
        // viewFog goes out as a signal: a sky writes no fog from it
        F.step(0.1); out.viewSignal = F.uniforms.uViewDistance.value; out.noSignal = E.uniforms.uViewDistance.value;
        const G = mk(createEngine, 'rg-terrain3');
        G.use(T.sky(), T.terrain({ viewChunks: 2, viewFog: true })); await G.start(); G.step(0.1);
        out.fogAfter = G.scene.fog;
        E.dispose(); F.dispose(); G.dispose();
        // light pool: 2 points, both cast; a source without castShadow still gets one, and a dark slot has autoUpdate off
        const warns = [], w0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
        const L = mk(createEngine, 'rg-lights');
        L.use(lightPool({ point: 2, shadows: 2, fade: 0 })); console.warn = w0;
        out.allShadowWarn = warns.some(m => /every point light casts shadows/.test(m));
        await L.start();
        out.idleAuto = L.lightPool.lights.map(l => l.shadow.autoUpdate);
        const h = L.lightPool.add({ x: 0, y: 1, z: 0 }, { intensity: 3, distance: 8 });
        L.step(0.3);
        out.lit = L.lightPool.stats.lit; out.autoAfter = L.lightPool.lights.filter(l => l.shadow.autoUpdate).length;
        h.remove(); L.step(0.5);
        out.autoGone = L.lightPool.lights.filter(l => l.shadow.autoUpdate).length;
        L.dispose();
        return out;
      });
      check('[guard] terrain without waterLevel has no sea (-Infinity)', r.water === -Infinity && r.engineWater === -Infinity, JSON.stringify(r));
      check('[guard] terrain leaves the fog alone; viewFog: true puts the view distance on the signal uViewDistance', r.fogFar === null && r.viewFog > 0 && r.viewSignal === r.viewFog && r.noSignal === 600, JSON.stringify(r));
      check('[guard] viewFog under a sky writes no scene.fog', r.fogAfter === null, JSON.stringify(r.fogAfter));
      check('[guard] idle shadow slots render no shadow map (autoUpdate false), a lit one does, released again after', r.idleAuto.every(a => a === false) && r.autoAfter === 1 && r.autoGone === 0, JSON.stringify(r));
      check('shadows >= point: a non-casting source still lights (and the pool warns once)', r.lit === 1 && r.allShadowWarn, JSON.stringify(r));
    },
  },
  {
    name: 'review guard: afterLoad runs on saves.apply and session.newGame; level nodes with id stay without world(); audio.play before unlock does not throw',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { level } = threedogThreads, { createEngine, THREE } = T, out = { hooks: 0 };
        const E = mk(createEngine, 'rg-load');
        E.use(T.world(), { name: 'rgHook', type: 'rules', afterLoad: async () => { out.hooks++; } });
        await E.start();
        const data = E.saves.collect();
        out.applied = await E.saves.apply(data); out.afterApply = out.hooks;
        await E.session.newGame(); out.afterNew = out.hooks;
        E.dispose();
        // a level whose node carries a custom property id, no world(): the node stays in the scene, one warning names the fix
        const warns = [], w0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
        const root = new THREE.Group(); root.name = 'lvl';
        const ground = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 10)); ground.name = 'ground'; root.add(ground);
        const chest = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); chest.name = 'chest'; chest.userData.id = 'chest'; chest.position.set(2, 0.6, 0); root.add(chest);
        const L = mk(createEngine, 'rg-level');
        L.use(level({ scene: root })); await L.start(); console.warn = w0;
        out.kept = chest.parent === root; out.levelWarn = warns.some(m => /install world\(\)/.test(m));
        L.dispose();
        // audio.play of a named asset before any click: no throw (the context is created suspended)
        const A = mk(createEngine, 'rg-audio');
        A.assets.manifest({ name: 'rg', sounds: { beep: '/tests/settings/audio/sting.wav' } });
        try { const h = await A.audio.play('beep'); out.play = h ? 'handle' : 'null'; } catch (e) { out.play = 'threw: ' + e.message; }
        A.dispose();
        return out;
      });
      check('[guard] saves.apply runs the modules\' afterLoad', r.applied === true && r.afterApply === 1, JSON.stringify(r));
      check('[guard] session.newGame runs afterLoad too', r.afterNew === 2, JSON.stringify(r));
      check('[guard] a node with id stays in the level without world() and the warning names world()', r.kept && r.levelWarn, JSON.stringify(r));
      check('audio.play(\'assetName\') before the first click resolves instead of throwing', r.play === 'handle', String(r.play));
    },
  },
  {
    name: 'review guard: a canvas with one auto axis (width 100%, height auto) keeps its own box; assets warn when a later manifest replaces a name; pack startItems add up',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { createEngine } = T, out = {};
        const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:500px';
        const cv = document.createElement('canvas'); cv.width = 400; cv.height = 200; cv.style.cssText = 'width:100%;height:auto;display:block';
        host.append(cv); document.body.append(host);
        const E = createEngine({ canvas: cv, headless: true, urlState: false, saveKey: 'rg-canvas', ui: { loading: false } });
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        out.auto = E._autoSize; out.w = cv.clientWidth; out.h = cv.clientHeight;
        E.dispose(); host.remove();
        const warns = [], w0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
        const A = mk(createEngine, 'rg-assets');
        A.assets.manifest({ name: 'packA', models: { tree: '/a/tree.glb' } }); A.assets.manifest({ name: 'packB', models: { tree: '/b/tree.glb' } });
        console.warn = w0; out.replaced = warns.some(m => m.includes('packA') && m.includes('packB') && m.includes('tree'));
        // `threedog assets optimize` writes a JSON pack named 'optimized': it swaps the file, the game's other options (needs, prepare) stay
        const prepare = () => {};
        A.assets.manifest({ name: 'game', models: { hero: { url: '/models/hero.glb', needs: { nodes: ['Hand'] }, prepare } } });
        A.assets.manifest({ name: 'optimized', models: { hero: { url: '/optimized/hero.glb', lods: ['/optimized/hero_1.glb'] } } });
        const he = A.assets.entries.get('hero');
        out.optimized = { url: he.url, lods: he.opts.lods?.length, needs: !!he.opts.needs, prepare: he.opts.prepare === prepare };
        // a generator the optimized pack later points at a file: the file wins (build is checked before url)
        A.assets.manifest({ name: 'game2', models: { tree: () => new threedogThreads.THREE.Group() } });
        A.assets.manifest({ name: 'optimized', models: { tree: { url: '/optimized/tree.glb' } } });
        out.treeBuild = !!A.assets.entries.get('tree').opts.build;
        // the load path of needs: one node and one clip the model lacks give exactly one asset-needs warning naming both
        const seen = [], w1 = console.warn; console.warn = (...a) => { seen.push(a.join(' ')); };
        A.assets.manifest({ name: 'contract', models: { hero: { needs: { nodes: ['Hand_L', 'Hand_R'], clips: ['Idle', 'Run'] }, build() { const g = new threedogThreads.THREE.Group(), h = new threedogThreads.THREE.Group(); h.name = 'Hand_L'; g.add(h); g.animations = [new threedogThreads.THREE.AnimationClip('Idle', 1, [])]; return g; } } } });
        await A.assets.model('hero'); await A.assets.model('hero');
        console.warn = w1; out.needs = seen.filter(m => m.includes('asset-needs'));
        A.use(T.world(), T.inventory(), T.content()); await A.start();
        A.content.load([{ name: 'base', items: { gold: { name: 'Gold' } }, startItems: { gold: 5 } }, { name: 'dlc', startItems: { gold: 3 } }]);
        out.gold = A.inventory.count('gold');
        A.dispose();
        return out;
      });
      check('[guard] width: 100%; height: auto is not treated as unsized (no window size forced)', r.auto === false && r.w === 500 && Math.abs(r.h - 250) <= 1, JSON.stringify(r));
      check('a later manifest replacing a same-named asset warns naming both manifests', r.replaced, JSON.stringify(r));
      check('[guard] the optimized pack replaces the file and lods and keeps the entry\'s needs and prepare', /optimized\/hero\.glb$/.test(r.optimized.url) && r.optimized.lods === 1 && r.optimized.needs && r.optimized.prepare, JSON.stringify(r.optimized));
      check('[guard] an optimized file replaces a generator: the old build goes with the old file', r.treeBuild === false, JSON.stringify(r));
      check('[guard] a model missing a needed node and clip warns once at load, naming both (fails if checkNeeds is not called)', r.needs.length === 1 && /Hand_R/.test(r.needs[0]) && /"Run"/.test(r.needs[0]) && !/Hand_L|Idle/.test(r.needs[0].replace(/\(closest[^)]*\)/g, '')), JSON.stringify(r.needs));
      check('startItems from two packs add up instead of clashing', r.gold === 8, JSON.stringify(r));
    },
  },
  {
    name: 'review guard: autopilot speed reaches the player (one move.speed entry, not a second speed road)',
    url: '/tests/a/',
    async run({ check, ev }) {
      // since acb3fd2a autopilot { speed } is a move.speed entry (owner 'autopilot', id 'player'); moveInput() returns only the direction.
      // The guard is that the speed still reaches the player and is released again, so a recording or benchmark walks at the asked speed
      const r = await ev(() => {
        engine.haltLoop();
        const s = engine.stacks.get('move.speed');
        engine.input.autopilot = { x: 0, y: 1, speed: 3.5 }; engine.step(0.05);
        const a = [s.value('player'), s.names('player').includes('autopilot'), engine.characters.moveInput().speed];
        engine.input.autopilot = null; engine.step(0.05);
        const b = s.names('player').includes('autopilot');
        return { a, b, player: !!engine.player };
      });
      check('[guard] input.autopilot.speed sets the player move.speed (owner autopilot) and is released when autopilot ends', r.player && r.a[0] === 3.5 && r.a[1] && r.a[2] === undefined && r.b === false, JSON.stringify(r));
    },
  },
  {
    name: 'review guard: render and ui leftovers (a part of a placed object refreshes, skip list sees a swap, cascades see an ortho height, box follows a camera on a rig, nothing stays behind a modal or an unloaded module)',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE: H } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(createEngine, 'rg-render');
        E.use(T.settings(), T.hud());
        await E.start(); E.haltLoop();
        // batching: refresh() of a part keeps the placed object; a swap that keeps the count reaches the draw list
        const B = E.batching, g = new H.BoxGeometry(), m = new H.MeshBasicMaterial(), roots = [];
        for (let i = 0; i < 10; i++) { const o = new H.Group(); o.userData.batch = true; o.add(new H.Mesh(g, m)); o.add(new H.Group()); E.scene.add(o); roots.push(o); }
        E.step(1 / 30);
        const part = roots[0].children[0];
        out.batched = B.of(roots[0]).length;
        B.refresh(part); E.step(1 / 30);
        out.afterRefresh = B.of(roots[0]).length;
        B.skip(); B.unskip();
        const P = roots[1], old = P.children[1], fresh = new H.Group();
        P.remove(old); P.add(fresh);
        B.skip(); out.drawn = P.children.includes(fresh) && !P.children.includes(old); B.unskip();
        // tint on a plain mesh: the table must not hold the mesh for ever
        out.weakOrig = B.orig instanceof WeakMap;
        // a box following a camera on a rig is centered on the camera's world position
        const sun = new H.DirectionalLight(); sun.castShadow = true; sun.position.set(5, 10, 5); E.scene.add(sun, sun.target);
        const rig = new H.Group(); rig.position.set(300, 0, -200); E.scene.add(rig); rig.add(E.camera); E.camera.position.set(0, 2, 5);
        const box = E.shadows.box(sun, { follow: 'camera', extent: 20, snap: 0 });
        E.step(1 / 30);
        out.boxAt = [Math.round(sun.target.getWorldPosition(new H.Vector3()).x), Math.round(sun.target.getWorldPosition(new H.Vector3()).z)];
        box.remove(); rig.remove(E.camera); E.scene.add(E.camera);
        // a title list that throws leaves no freeze or input hold behind
        E.ui.values.set('title', { items: ['no-such-item'] }); E.ui.live.delete('title');
        let threw = false; try { E.ui.open('title'); } catch { threw = true; }
        out.title = { threw, open: E.ui.isOpen('title'), top: T.uiFocus(E).top };
        // mergeColored leaves a non-indexed input as it was
        const flatIn = new H.BoxGeometry().toNonIndexed(), before = Array.from(flatIn.attributes.normal.array);
        flatIn.attributes.normal.array.fill(0.5); const same = Array.from(flatIn.attributes.normal.array);
        T.mergeColored([[flatIn, 0xffffff]]);
        out.input = Array.from(flatIn.attributes.normal.array).every((v, i) => v === same[i]) && before.length > 0;
        // hud leaves the screen with its module; settings no longer answers the back key
        E.hud.addCounter('c', { value: 1 }); E.hud.marker({ x: 0, z: 0 });
        out.hudThere = !!E.uiRoot.querySelector('.threedog-hud');
        E._unuse('hud'); out.hudGone = !E.uiRoot.querySelector('.threedog-hud');
        const m0 = (E.use(T.music({ tracks: { a: '/none.ogg' } })), E.music); m0.play('a');
        E._unuse('music'); out.music = [m0.current, m0.pending];
        E.use(T.flow()); E.flow.go('paused');
        const flowHolds = () => [E.stacks.get('freeze').has('flow'), E.input.holders.some(h => h.context === 'flow')];
        out.flowHolds = flowHolds(); E._unuse('flow'); out.flowFreed = flowHolds();
        E._unuse('settings');
        const real = E.input.pressedRaw;
        E.input.pressedRaw = function (a) { return a === 'cancel' || real.call(this, a); };
        E.step(1 / 30); E.input.pressedRaw = real;
        out.focusTop = T.uiFocus(E).top;
        // the chain's targets give their memory back while nothing is on, and a Color background is left alone while the game clears itself
        const h = E.post.add({ name: 'dim', fuse: { glsl: 'color.rgb *= 0.9;' }, slot: 'ldr' });
        E.step(1 / 30);
        let freed = 0; E.post.object().renderTarget1.addEventListener('dispose', () => freed++);
        h.enabled = false; out.freed = E.post.active ? 'active' : freed;
        h.enabled = true; E.step(1 / 30); h.remove();
        const color = new H.Color(0.2, 0.4, 0.6); let seen = null;
        E.scene.background = color; E.renderer.toneMapping = H.ACESFilmicToneMapping; E.renderer.autoClear = false;
        E.scene.onBeforeRender = () => { seen = E.scene.background; };
        E.renderOnce(); E.renderer.autoClear = true; E.scene.onBeforeRender = () => {};
        out.bgKept = seen === color;
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r), { projectionKey } = await import('../../render/backend.js');
      const ortho = (top) => projectionKey({ left: -1, right: 1, top, bottom: -top, near: 0.1, far: 10, zoom: 1 });
      check('[guard] a new height of an orthographic camera is a new projection', ortho(1) !== ortho(2));
      check('[guard] batching.refresh(part) puts the placed object back in its batch', r.batched === 1 && r.afterRefresh === 1, J);
      check('[guard] a remove + add under a batched parent reaches the draw list', r.drawn, J);
      check('[guard] the tint table is weak', r.weakOrig, J);
      check('[guard] shadows.box follow camera uses the world position (camera on a rig)', r.boxAt[0] === 300 && r.boxAt[1] === -195, J);
      check('[guard] a modal part whose data throws leaves no hold', r.title.threw && !r.title.open && r.title.top === null, J);
      check('[guard] mergeColored flat leaves a non-indexed input alone', r.input, J);
      check('[guard] hud leaves the screen with its module', r.hudThere && r.hudGone, J);
      check('[guard] music stops with its module', r.music[0] === null && r.music[1] === null, J);
      check('[guard] flow unloaded while paused ends its freeze and input lock', r.flowHolds.every(Boolean) && !r.flowFreed.some(Boolean), J);
      check('[guard] an unloaded settings menu no longer answers the back key', r.focusTop === null, J);
      check('[guard] the chain frees its targets when nothing is on', r.freed > 0, J);
      check('[guard] a Color background stays a clear while the game owns autoClear', r.bgKept, J);
    },
  },
];
