// [guard] What a consumer builds from a provider belongs to that provider: another collision module or another ground rebuilds it, even with the same local version number,
// and the old pieces go. Real Rapier and real Recast. Run: threedog test "Provider caches"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Provider caches: a newcomer that refuses a pack written for the old holder is told, the game runs on; a game listener that throws on module:fresh is a named error',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn], said = [];
        console.error = () => {}; console.warn = m => said.push(String(m));
        const mod = (name, rule) => { const m = { name, type: 'rules', provides: ['pcFormat'], fed: [], content: { pcFormat: { desc: 'test', validate: rule, commit: d => m.fed.push(...Object.keys(d)) } }, install() {} }; return m; };
        const E = mk(createEngine, 'pc-format');
        E.use(T.content(), mod('oldFormat', () => {}));
        await E.start();
        E.content.load({ name: 'oldPack', pcFormat: { a: { title: 'old' } } });
        E.content.load({ name: 'goodPack', pcFormat: { b: { prey: 'stag' } } });
        const next = mod('newFormat', d => { for (const [k, v] of Object.entries(d)) if (!v.prey) throw new Error(`${k}: name the prey`); });
        E.use(next, { replaces: 'pcFormat' });
        out.refused = { error: E.error?.message ?? null, frozen: E.frozen, fed: next.fed, told: said.filter(m => /oldPack/.test(m) && /name the prey/.test(m)).length };
        E.dispose();

        const G = mk(createEngine, 'pc-throw');
        G.use(T.content(), mod('oldFormat', () => {}));
        await G.start();
        G.events.on('module:fresh', () => { throw new Error('game listener broke'); });
        G.use(mod('newFormat', () => {}), { replaces: 'pcFormat' });
        out.thrown = { where: G.error?.where ?? null, message: G.error?.message ?? null };
        G.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('a pack the newcomer refuses stops nothing', r.refused.error === null && !r.refused.frozen, J(r));
      check('the refusal names the pack and the reason', r.refused.told === 1, J(r));
      check('the packs it can read reach it', r.refused.fed.join() === 'b', J(r));
      check('a game listener that throws is a named error, in dev as on any event', /module:fresh/.test(r.thrown.where ?? '') && /game listener broke/.test(r.thrown.message ?? ''), J(r));
    },
  },
  {
    name: '[guard] Level load order: a pack that sets the level, loaded before or after start, loads whole and wins over level({ url }), with one load of one file; a pack that fails leaves the url',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, world, THREE, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn], said = [];
        const errs = [];
        console.error = (...a) => errs.push(a.map(String).join(' ')); console.warn = m => said.push(String(m));
        const run = async (key, { opts = { url: 'lvB' }, pack = { level: 'lvA', pcKeep: { sword: 1 }, props: [{ id: 'lo-post', model: 'loPost', place: 'home' }] }, loadOpts = { places: { home: { x: 2, z: 2 } } }, order, then }) => {
          const E = mk(createEngine, key), built = [], loaded = [], fed = [];
          const scene = n => async () => {
            built.push(n);
            const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial());
            s.name = n; m.name = 'ground'; s.add(m);
            return s;
          };
          E.assets.manifest({ name: key, models: { lvA: { build: scene('lvA') }, lvB: { build: scene('lvB') }, lvC: { build: scene('lvC') }, loPost: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) } });
          E.events.on('level:loaded', ({ root }) => loaded.push(root.name));
          const keeper = { name: 'loKeeper', type: 'rules', content: { pcKeep: { desc: 'test', commit: d => fed.push(Object.keys(d)) } }, install() {} };
          const lvl = () => level(opts);
          const load = () => { try { E.content.load(pack, loadOpts); } catch (x) { out[key + 'Threw'] = x.message; } };
          await order(E, lvl, keeper, load);
          const settle = async () => { for (let i = 0; i < 6; i++) { await E.loading.settled(); await new Promise(res => setTimeout(res, 15)); E.step(1); } };
          await settle();
          const saved = JSON.stringify(E.saves.collect().parts.level);
          if (then) { await then(E, load); await settle(); }
          const res = { file: E.modules.get('level').describe().file, roots: ['lvA', 'lvB', 'lvC', 'scn'].filter(n => E.scene.getObjectByName(n)), built, loaded, fed: fed.length, prop: !!E.world.get('lo-post'), saved, ready: E.content.ready };
          E.dispose();
          return res;
        };
        const plain = (E, lvl, k) => E.use(world(), T.content(), lvl(), k);
        out.after = await run('lo-after', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); } });
        out.before = await run('lo-before', { order: async (E, l, k, load) => { plain(E, l, k); load(); await E.start(); } });
        // main.js of the templates: modules, the camera, the load, the globals, then start
        out.template = await run('lo-template', { order: async (E, l, k, load) => { plain(E, l, k); E.camera.position.set(0, 6, 12); load(); Object.assign(window, { loEngine: E }); await E.start(); delete window.loEngine; } });
        out.late = await run('lo-late', { order: async (E, l, k, load) => { E.use(world(), T.content(), k); await E.start(); E.use(l()); load(); } });
        out.noUrl = await run('lo-nourl', { opts: {}, order: async (E, l, k, load) => { plain(E, l, k); load(); await E.start(); } });
        out.noUrlSaid = said.filter(m => /needs a url or scene/.test(m)).length;
        const scn = new THREE.Group(); scn.name = 'scn';
        out.scene = await run('lo-scene', { opts: { scene: scn }, order: async (E, l, k, load) => { plain(E, l, k); load(); await E.start(); } });
        out.bad = await run('lo-bad', { pack: { level: 'lvNope', pcKeep: { sword: 1 } }, order: async (E, l, k, load) => { plain(E, l, k); load(); await E.start(); } });
        said.length = 0;
        const newer = (E, name) => E.level.load(name).catch(() => {});
        out.overAfter = await run('lo-over', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvC'); } });
        out.overBefore = await run('lo-over2', { order: async (E, l, k, load) => { plain(E, l, k); load(); newer(E, 'lvC'); await E.start(); } });
        out.overSaid = said.length;
        out.failAfter = await run('lo-fail', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvNope'); } });
        out.failBefore = await run('lo-fail2', { order: async (E, l, k, load) => { plain(E, l, k); load(); newer(E, 'lvNope'); await E.start(); } });
        out.noLevel = await run('lo-none', { pack: { pcKeep: { sword: 1 }, props: [{ id: 'lo-post', model: 'loPost', place: 'home' }] }, order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvC'); } });
        out.twoPacks = await run('lo-two', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); E.content.load({ level: 'lvC', pcKeep: { shield: 1 } }); } });
        errs.length = 0;
        out.onlyThere = await run('lo-only', { pack: { level: 'lvA', pcKeep: { sword: 1 }, props: [{ id: 'lo-post', model: 'loPost', place: 'onlyInA' }] }, order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvC'); } });
        out.onlyThereSaid = errs.filter(m => /onlyInA/.test(m)).length;
        out.reload = await run('lo-again', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvC'); }, then: (E, load) => load() });
        out.putBack = await run('lo-back', { order: async (E, l, k, load) => { plain(E, l, k); await E.start(); load(); newer(E, 'lvC'); }, then: E => { try { E.use({ name: 'badLv', type: 'world', provides: ['level'], install() { throw new Error('bad install'); } }, { replaces: 'level' }); } catch { /* the swap fails, that is the point */ } } });
        [console.error, console.warn] = quiet;
        return out;
      });
      const whole = a => a.file === 'lvA' && a.roots.join() === 'lvA' && a.fed === 1 && a.prop;
      const once = a => a.built.join() === 'lvA' && a.loaded.join() === 'lvA';
      check('content.load after start: the pack is whole and its level wins', whole(r.after), J(r.after));
      check('content.load before start: the same', whole(r.before), J(r.before));
      check('... and the url file is never fetched, the level loads once', once(r.before), J(r.before));
      check('the order of the templates\' main.js: the same', whole(r.template) && once(r.template), J(r.template));
      check('level installed after start, pack on the next line: the same', whole(r.late) && once(r.late), J(r.late));
      check('level() with no url: the pack is the level, and no warning that it has none', whole(r.noUrl) && once(r.noUrl) && r.noUrlSaid === 0, J(r));
      check('level({ scene }): the pack wins and level:loaded is told for it alone', whole(r.scene) && r.scene.loaded.at(-1) === 'lvA', J(r.scene));
      check('a pack whose level cannot load: level({ url }) is still the level', r.bad.file === 'lvB' && r.bad.roots.join() === 'lvB', J(r.bad));
      const yields = a => a.file === 'lvC' && a.roots.join() === 'lvC' && a.fed === 1 && a.prop && a.ready === true;
      check('a pack overtaken by a newer level.load after start: its other sections go in, the newer level stays', yields(r.overAfter), J(r.overAfter));
      check('... before start: the same, and the url is not fetched', yields(r.overBefore) && !r.overBefore.built.includes('lvB'), J(r.overBefore));
      check('... with nothing to warn about', r.overSaid === 0, J(r));
      check('the save names the newer level', /lvC/.test(r.overAfter.saved), J(r.overAfter));
      check('a newer load that fails after start: the old level stays, the pack\'s other sections go in', r.failAfter.file === 'lvB' && r.failAfter.fed === 1 && r.failAfter.prop, J(r.failAfter));
      check('... before start: level({ url }) is the level, the other sections go in', r.failBefore.file === 'lvB' && r.failBefore.roots.join() === 'lvB' && r.failBefore.fed === 1 && r.failBefore.prop, J(r.failBefore));
      check('a pack with no level section is not touched by a level load', yields(r.noLevel), J(r.noLevel));
      check('two packs with a level in a row: the later level, both packs in, no wait on each other', r.twoPacks.file === 'lvC' && r.twoPacks.fed === 2 && r.twoPacks.prop && r.twoPacks.ready === true, J(r.twoPacks));
      check('a section naming a place only the pack\'s level had gets the named error, and goes back whole', r.onlyThereSaid >= 1 && r.onlyThere.fed === 0 && r.onlyThere.file === 'lvC', J(r));
      check('loading the pack again later is a new ask: its level comes up', r.reload.file === 'lvA' && r.reload.fed === 2, J(r.reload));
      check('a level put back after a failed swap does not get a level that gave way', !r.putBack.roots.includes('lvA'), J(r.putBack));
    },
  },
  {
    name: '[guard] Provider caches: a collision module that comes late or comes back gets the col_ walls and solid props, doubling nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, collision, world, THREE, all: T } = threedogThreads, out = {};
        const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial();
        const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), mat), wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), mat);
        floor.name = 'ground'; wall.name = 'col_wall'; wall.position.set(5, 2, 0);
        g.add(floor, wall);
        const E = mk(createEngine, 'pc-late');
        E.assets.manifest({ name: 'pc-late', models: { pclPost: () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0)) } });
        E.use(level({ scene: g }), world(), T.content());
        await E.start();
        E.content.load({ props: [{ id: 'pcl-post', model: 'pclPost', collide: 'box', x: -5, z: 0 }] });
        for (let i = 0; i < 200 && !E.content.ready; i++) { await new Promise(res => setTimeout(res, 5)); E.step(1); }
        const read = () => ({ wall: !E.collision.walkable({ x: 5, z: 0 }), prop: !E.collision.walkable({ x: -5, z: 0 }), boxes: E.modules.get('collision').describe(E).boxes });
        E.use(collision());
        E.step(2);
        out.first = read();
        E.unuse('collision');
        E.step(2);
        out.without = E.has('collision');
        E.use(collision());
        E.step(2);
        out.back = read();
        E.step(2);
        out.later = read();
        E.level.unload();
        E.step(2);
        out.unloaded = read();
        E.dispose();
        return out;
      });
      const both = a => a.wall && a.prop && a.boxes === 2;
      check('a first collision module installed after the level loaded gets both', both(r.first), J(r));
      check('unuse then a plain use gets both again', r.without === false && both(r.back), J(r));
      check('... once: more steps add nothing', both(r.later), J(r));
      check('unloading takes the wall away, the prop stays', !r.unloaded.wall && r.unloaded.prop && r.unloaded.boxes === 1, J(r));
    },
  },
  {
    name: '[guard] Provider caches: a tilted solid prop goes into the collider3d holder installed now, after a replaces, a failed one, and a holder that left and came back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, THREE, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn];
        console.error = console.warn = () => {};
        const E = mk(createEngine, 'pc-tilt');
        E.assets.manifest({ name: 'pc-tilt', models: { pctSlab: () => new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4).translate(0, 0.5, 0)) } });
        E.use(collision(), world(), T.content(), T.rigid());
        await E.start();
        E.content.load({ props: [{ id: 'pct-slab', model: 'pctSlab', collide: 'box', rot: [0.4, 0, 0], ground: false, x: 3, y: 2, z: 3 }] });
        for (let i = 0; i < 200 && !E.content.ready; i++) { await new Promise(res => setTimeout(res, 5)); E.step(1); }
        const settle = async () => { await E.loading.settled(); E.step(3); };
        const solids = () => E.modules.get('rigid').describe().solids ?? 0;
        const solid = () => E.collider3d.overlap([3, 2.5, 3], 0.1);
        await settle();
        out.before = [solids(), solid()];
        E.use(T.rigid(), { replaces: 'collider3d' });
        out.nextLine = solids();
        await settle();
        out.swapped = [solids(), solid()];
        try { E.use({ name: 'badC3', type: 'world', provides: ['collider3d'], install() { throw new Error('bad install'); } }, { replaces: 'collider3d' }); } catch { /* the swap fails, that is the point */ }
        await settle();
        out.failed = [solids(), solid()];
        E.unuse('rigid');
        let thrown = null;
        try { E.step(3); } catch (x) { thrown = x.message; }
        out.without = { errors: E.errors?.length ?? 0, thrown };
        E.use(T.rigid());
        await settle();
        out.back = [solids(), solid()];
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      const held = a => a[0] === 1 && a[1] === true;
      check('a tilted prop is solid before any swap', held(r.before), J(r));
      check('after a replaces it is solid in the new holder, once', held(r.swapped), J(r));
      check('the new holder has it on the line after the use', r.nextLine === 1, J(r));
      check('after a failed replaces it is solid in the holder put back', held(r.failed), J(r));
      check('no holder for a while is no error', r.without.thrown === null, J(r));
      check('a holder that comes back gets it', held(r.back), J(r));
    },
  },
  {
    name: '[guard] Provider caches: a module replaced after packs loaded ends as a fresh start with that module, then those packs',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, THREE, all: T } = threedogThreads;
        const built = n => () => { const s = new THREE.Group(); s.name = n; const m = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); m.name = 'ground'; s.add(m); return s; };
        // a section whose module finishes in an async init, and notes whether that was done when the pack reached it
        const keeper = () => {
          const m = { name: 'pcKeeper', type: 'rules', provides: ['pcKeep'], fed: [], inited: false, content: { pcKeep: { desc: 'test', commit: d => m.fed.push({ keys: Object.keys(d), inited: m.inited }) } },
            install() { return { fed: m.fed }; }, async init() { await null; m.inited = true; } };
          return m;
        };
        const pack = { level: 'lvA', pcKeep: { sword: 1 } };
        const scene = E => ({ current: E.modules.get('level').describe().file, roots: ['lvA', 'lvB'].filter(n => E.scene.getObjectByName(n)), keeps: E.pcKeeper.fed.length, inited: E.pcKeeper.fed.at(-1)?.inited });
        const manifest = (E, n) => E.assets.manifest({ name: n, models: { lvA: { build: async () => built('lvA')() }, lvB: { build: async () => built('lvB')() } } });
        const settle = async E => { for (let i = 0; i < 5; i++) { await E.loading.settled(); await new Promise(res => setTimeout(res, 20)); E.step(1); } await E.content.ready; };

        const F = mk(createEngine, 'pc-fresh');
        manifest(F, 'pc-fresh');
        F.use(T.content(), level({ url: 'lvB' }), keeper());
        await F.start();
        F.content.load(pack);
        await settle(F);
        const fresh = scene(F);
        F.dispose();

        const R = mk(createEngine, 'pc-swap');
        manifest(R, 'pc-swap');
        R.use(T.content(), level({ url: 'lvA' }), keeper());
        await R.start();
        R.content.load(pack);
        await settle(R);
        R.use(level({ url: 'lvB' }), { replaces: 'level' });
        R.use(keeper(), { replaces: 'pcKeep' });
        await settle(R);
        const swapped = scene(R);
        R.dispose();
        return { fresh, swapped };
      });
      const same = (a, b) => a.current === b.current && a.roots.join() === b.roots.join() && a.keeps === b.keeps && a.inited === b.inited;
      check('the fresh start itself: the pack wins over the url, and the section is fed', r.fresh.current === 'lvA' && r.fresh.keeps === 1, J(r));
      check('a replaced level and section module end the same as that fresh start', same(r.swapped, r.fresh), J(r));
    },
  },
  {
    name: '[guard] Provider caches: what fed the old collision module feeds the new one, col_ walls and solid props, after a replaces and after a failed one',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, collision, world, THREE, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn];
        console.error = console.warn = () => {};
        const scene = () => {
          const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial();
          const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), mat), wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), mat);
          floor.name = 'ground'; wall.name = 'col_wall'; wall.position.set(5, 2, 0);
          g.add(floor, wall);
          return g;
        };
        const E = mk(createEngine, 'pc-feed');
        E.assets.manifest({ name: 'pc-feed', models: { pcfPost: () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0)) } });
        E.use(collision(), level({ scene: scene() }), world(), T.content(), T.rigid());
        await E.start();
        E.content.load({ props: [{ id: 'pcf-post', model: 'pcfPost', collide: 'box', x: -5, z: 0 }] });
        for (let i = 0; i < 200 && !E.content.ready; i++) { await new Promise(res => setTimeout(res, 5)); E.step(1); }
        E.step(2);
        const read = () => ({ wall: !E.collision.walkable({ x: 5, z: 0 }), prop: !E.collision.walkable({ x: -5, z: 0 }), boxes: E.modules.get('collision').describe(E).boxes, rigid: E.rigid.world.colliders.len() });
        out.before = read();
        const told = [];
        E.events.on('module:fresh', ({ modules }) => told.push(modules.map(m => m.name).join()));
        const old = E.collision;
        E.use(collision(), { replaces: 'collision' });
        out.nextLine = read();
        E.step(2);
        out.swapped = read(); out.fresh = E.collision !== old;
        try { E.use({ name: 'badCol', type: 'world', provides: ['collision'], install() { throw new Error('bad install'); } }, { replaces: 'collision' }); } catch { /* the swap fails, that is the point */ }
        E.step(2);
        out.failed = read();
        out.told = told;
        E.level.unload();
        E.step(2);
        out.unloaded = read();
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      const same = a => a.boxes === r.before.boxes && a.rigid === r.before.rigid;
      check('the wall and the prop block before any swap', r.before.wall && r.before.prop && r.before.boxes === 2, J(r));
      check('after a replaces the col_ wall blocks in the new module', r.fresh && r.swapped.wall, J(r));
      check('... and so does the solid prop', r.swapped.prop, J(r));
      check('the line after the use reads both, frozen or not', r.nextLine.wall && r.nextLine.prop && r.nextLine.boxes === 2, J(r));
      check('... nothing doubled, and rigid mirrors the same colliders', same(r.swapped), J(r));
      check('after a failed replaces the module put back has them too', r.failed.wall && r.failed.prop && same(r.failed), J(r));
      check('module:fresh names who is fresh, once per change', r.told.join('|') === 'collision|collision', J(r));
      check('unloading the level takes the replayed wall away, the prop stays', !r.unloaded.wall && r.unloaded.prop, J(r));
    },
  },
  {
    name: '[guard] Provider caches: rigid follows a replaced collision module and a second ground with the same version',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, out = {};
        const E = mk(createEngine, 'pc-rigid');
        E.use(T.collision(), T.rigid());
        await E.start();
        const count = () => E.rigid.world.colliders.len();
        E.step(2);
        const empty = count();
        E.collision.addBox({ x: 5, z: 5 }, { halfWidth: 1, halfDepth: 1 });
        E.step(2);
        out.first = count() - empty;
        const statics = E.rigid._statics;
        E.use(T.collision(), { replaces: 'collision' });
        E.step(2);
        out.afterSwap = count() - empty;
        E.collision.addBox({ x: 9, z: 9 }, { halfWidth: 1, halfDepth: 1 });
        E.collision.addBox({ x: 9, z: -9 }, { halfWidth: 1, halfDepth: 1 });
        E.step(2);
        out.newBoxes = count() - empty;
        out.newMirror = E.rigid._statics !== statics;
        const tri = x => [{ positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 0, 1]), indices: new Uint32Array([0, 1, 2]) }];
        const ground = x => ({ height: () => 0, slope: () => 0, type: () => 'default', waterLevel: -Infinity, staticTrimeshes: () => tri(x), staticVersion: () => 1 });
        const at = () => E.rigid._levelColliders.map(c => c.vertices()[0]);
        E.setGround(ground(10));
        E.step(2);
        out.g1 = at();
        const n1 = count();
        E.setGround(ground(20));
        E.step(2);
        out.g2 = at();
        out.sameCount = count() === n1;
        E.addGroundColliders(() => {});   // engine.ground becomes a new object, the provider is the same: nothing to rebuild
        const kept = E.rigid._levelColliders[0];
        E.step(2);
        out.kept = E.rigid._levelColliders[0] === kept;
        E.setGround({ height: () => 0, slope: () => 0, type: () => 'default', waterLevel: -Infinity });
        E.step(2);
        out.flat = { list: E.rigid._levelColliders.length, count: count() - n1 };
        E.dispose();
        return out;
      });
      check('the first box is a collider', r.first === 1, J(r));
      check('the old module\'s collider goes with it', r.afterSwap === 0, J(r));
      check('boxes of the new module become colliders, through a new mirror', r.newBoxes === 2 && r.newMirror, J(r));
      check('a second ground with the same version rebuilds the mesh, one for one', r.g1[0] === 10 && r.g2[0] === 20 && r.sameCount, J(r));
      check('a collider source joining the same ground rebuilds nothing', r.kept, J(r));
      check('a ground with no mesh leaves no mesh behind, and stands on the default floor again', r.flat.list === 0 && r.flat.count === 0, J(r));
    },
  },
  {
    name: '[guard] Provider caches: a template body lives in the rigid installed now, while it loads, after it left, and across a reload that adds or changes body',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, level, THREE, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g);
        const E = mk(createEngine, 'pc-body');
        E.assets.manifest({ name: 'pc-b', models: { pcbCrate: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) } });
        E.use(world(), collision(), T.content(), level({ scene: s }), T.rigid());
        await E.start();
        const pack = body => ({ templates: { pcbCrate: { model: 'pcbCrate', ...(body && { body }) } }, props: [{ id: 'pcb-1', template: 'pcbCrate', x: 2, z: 2 }] });
        const settle = async n => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(res => setTimeout(res, 10)); E.step(1 / 60); } };
        const mine = () => E.rigid?.bodies.filter(b => b.mesh) ?? [];
        const at = () => +E.world.get('pcb-1').position.x.toFixed(1);
        E.content.load(pack(null)); await settle(6);
        out.plain = mine().length;
        E.content.load(pack({ shape: 'box', mass: 2 })); await settle(8);
        out.gained = mine().length;
        mine()[0].body.setTranslation({ x: 8, y: 0.6, z: 2 }, true); await settle(10);
        out.followed = at();   // a body added by a reload: the record follows the model, or a push would be lost
        E.content.load(pack({ shape: 'box', mass: 9 })); await settle(8);
        out.heavier = { x: at(), bodyX: +mine()[0].body.translation().x.toFixed(1), mass: +mine()[0].body.mass().toFixed(1) };
        E.use(T.rigid(), { replaces: 'rigid' });
        E.step(1 / 60); E.step(1 / 60);   // frames before the new solver is ready: the old handle must not be touched, the build must not throw
        out.loading = { ready: E.rigid.ready, err: E.error?.message ?? null };
        await settle(8);
        out.swapped = { n: mine().length, x: at(), mass: +mine()[0]?.body.mass().toFixed(1) };
        E.unuse('rigid'); await settle(4);
        out.left = { has: E.has('rigid'), err: E.error?.message ?? null, x: at() };
        E.use(T.rigid()); await settle(8);
        out.back = { n: mine().length, x: at(), err: E.error?.message ?? null };
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('a reload that adds body builds it', r.plain === 0 && r.gained === 1, J(r));
      check('... and the record follows that body', r.followed === 8, J(r));
      check('a new mass reaches the body, and the pushed crate stays where it was', r.heavier.mass === 9 && r.heavier.x === 8 && r.heavier.bodyX === 8, J(r));
      check('frames while the new rigid loads pass without an error', !r.loading.err, J(r));
      check('the new rigid holds the crate with the template\'s mass, where play left it', r.swapped.n === 1 && r.swapped.mass === 9 && r.swapped.x === 8, J(r));
      check('rigid gone: the copy stands as a model, nothing throws', r.left.has === false && !r.left.err && r.left.x === 8, J(r));
      check('rigid back: the body comes back', r.back.n === 1 && r.back.x === 8 && !r.back.err, J(r));
    },
  },
  {
    name: '[guard] Provider caches: nav drops the old collision module\'s obstacles and cuts in the new ones',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, out = {};
        const g = new THREE.Group();
        const f = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); f.name = 'ground'; g.add(f);
        const E = mk(createEngine, 'pc-nav');
        E.use(T.world(), T.collision(), T.level({ scene: g }), T.nav());
        await E.start();
        const nav = E.modules.get('nav'), n = () => nav.describe(E).obstacles;
        for (let i = 0; i < 200 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 10));
        E.collision.addBox({ x: 5, z: 5 }, { halfWidth: 1, halfDepth: 1 });
        E.step(2);
        out.first = n();
        const rev = E.nav.revision;
        E.use(T.collision(), { replaces: 'collision' });
        E.step(2);
        out.afterSwap = n(); out.revised = E.nav.revision > rev;
        E.collision.addBox({ x: -5, z: 5 }, { halfWidth: 1, halfDepth: 1 });
        E.collision.addBox({ x: -5, z: -5 }, { halfWidth: 1, halfDepth: 1 });
        E.step(2);
        out.newBoxes = n();
        E.dispose();
        return out;
      });
      check('the first box is an obstacle', r.first === 1, J(r));
      check('the old module\'s obstacle goes, and paths are told', r.afterSwap === 0 && r.revised, J(r));
      check('boxes of the new module are obstacles', r.newBoxes === 2, J(r));
    },
  },
];
