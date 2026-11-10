// [guard] Module removals and swaps from the state conflict map: each row was a bug shown through the public API.
// A fix may either make the action work or refuse it at the gate, so rows that take a provider away accept a refusal as well as a game that runs on.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  // A small running game. The console is silenced because the rows provoke errors on purpose and read them from engine.error.
  window.msRun = async (key, mods, act, extra) => {
    const { mk, createEngine, THREE } = threedogThreads;
    const was = [console.error, console.warn]; console.error = console.warn = () => {};
    const E = mk(createEngine, key, extra), out = {};
    const step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) E.step(dt); };
    const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(r => setTimeout(r, 8)); step(); } };
    const floor = () => { const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g); return s; };
    try {
      E.use(...mods({ floor, THREE }));
      await E.start();
      await act({ E, out, step, settle, THREE });
    } catch (x) { out.threw = String(x.message).slice(0, 240); }
    out.err = E.error?.message ?? null; out.where = E.error?.where;
    try { E.dispose(); } catch (x) { out.disposeThrew = String(x.message).slice(0, 240); }
    [console.error, console.warn] = was;
    return out;
  };
  window.msBase = ({ floor }) => { const { world, collision, characters, level } = threedogThreads; return [world(), collision(), characters(), level({ scene: floor() })]; };
  window.msTry = (out, fn) => { try { fn(); } catch (x) { out.refused = String(x.message).slice(0, 200); } };
};

export const specs = [
  {
    name: '[guard] swap unuse world: a live player does not break the step',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => msRun('ms-world', msBase, async ({ E, out, step, settle }) => {
        E.characters.addPlayer({ control: 'camera' });
        await settle();
        msTry(out, () => E.unuse('world'));
        step(3);
      }));
      check('world leaves, or is refused, and the step goes on', !r.threw && !r.err, J(r));
    },
  },
  {
    name: '[guard] swap unuse characters: a near NPC does not break the world step',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => msRun('ms-chars', msBase, async ({ E, out, step, settle }) => {
        E.npcs.add({ id: 'ms-npc', position: [1, 0, 1], schedule: [{ at: 0, position: [9, 0, 9] }] });
        E.world.refresh(); await settle();
        out.record = !!E.world.get('ms-npc');
        msTry(out, () => E.unuse('characters'));
        step(6, 0.1);
      }));
      check('the NPC record existed', r.record, J(r));
      check('characters leaves, or is refused, and the world step goes on', !r.threw && !r.err, J(r));
    },
  },
  {
    name: '[guard] swap replaces terrain: the new terrain gets a drawing part',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => msRun('ms-terrain', () => [threedogThreads.world(), threedogThreads.all.terrain({ height: () => 0, viewChunks: 1 })], async ({ E, out, settle }) => {
        await settle();
        out.before = !!E.terrain.drawPart;
        E.use(...[].concat(threedogThreads.all.terrain({ height: () => 1, viewChunks: 1 })), { replaces: 'terrain' });
        await settle();
        out.after = !!E.terrain.drawPart;
      }));
      check('the old terrain had its drawing', r.before, J(r));
      check('the swap went through', !r.threw && !r.err, J(r));
      check('the terrain installed now has a drawing part', r.after, J(r));
    },
  },
  {
    name: '[guard] swap replaces cameraRig: a camera hold does not freeze the new rig',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const rig = () => threedogThreads.all.followCamera({ distance: 6 }), mods = ({ floor }) => [threedogThreads.world(), threedogThreads.collision(), threedogThreads.level({ scene: floor() }), rig()];
        const run = (key, take) => msRun(key, mods, async ({ E, out, step, settle }) => {
          await settle();
          take(E); step(2);
          out.held = E.cameraOverride?.owner ?? null;
          E.use(rig(), { replaces: 'cameraRig' });
          await settle();
          E.autoView.manual('camera', false);
          step(2);
          out.after = E.cameraOverride?.owner ?? null;
        });
        return { write: await run('ms-cam-w', E => { E.camera.position.x += 1; }), manual: await run('ms-cam-m', E => E.autoView.manual('camera')) };
      });
      for (const k of ['write', 'manual']) {
        check(`${k}: the camera was held before the swap`, !!r[k].held, J(r));
        check(`${k}: handing back after the swap leaves no hold, so the new rig moves`, !r[k].threw && !r[k].err && r[k].after === null, J(r));
      }
    },
  },
  {
    name: '[guard] swap replaces rigid: a live ragdoll gives the character back',
    url: '/tests/ragdoll/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const was = [console.error, console.warn]; console.error = console.warn = () => {};
        const p = engine.player, out = {};
        engine.step(0.2);
        const before = engine.control.of(p);
        engine.rigid.ragdoll(p); engine.step(0.1);
        out.limp = !!p.limp;
        try {
          // this page exports no rigid(): the installed definition goes in again, which builds a fresh instance the way a failed swap's put-back does
          engine.use(engine.modules.get('rigid'), { replaces: 'rigid' });
          await engine.loading.settled();
          engine.step(0.1); engine.step(0.1);
          out.limpAfter = !!p.limp; out.held = p.anim?._held ?? null; out.control = J0(engine.control.of(p)); out.controlBefore = J0(before);
          p.placeAt(new THREE.Vector3(1, 0, 1));
        } catch (x) { out.threw = String(x.message).slice(0, 240); }
        out.err = engine.error?.message ?? null;
        [console.error, console.warn] = was;
        return out;
        function J0(c) { return JSON.stringify(c?.owner ?? c ?? null); }
      });
      check('the character was limp before the swap', r.limp, J(r));
      check('the swap gives the body back: not limp, animation free, control as it was, placing works', !r.threw && !r.err && !r.limpAfter && !r.held && r.control === r.controlBefore, J(r));
    },
  },
  {
    name: '[guard] swap unuse rigid: a ray for all targets still answers with a body the game kept',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => msRun('ms-ray', ({ floor }) => [threedogThreads.world(), threedogThreads.collision(), threedogThreads.level({ scene: floor() }), threedogThreads.all.rigid()], async ({ E, out, step, settle, THREE }) => {
        await settle();
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.position.set(0, 2, 0); E.scene.add(m);
        E.ops.allow(() => E.rigid.addBox(m));
        step(2);
        const ray = () => E.raycast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), { targets: 'all' });
        out.before = ray()?.kind ?? null;
        E.unuse('rigid');
        ray(); step();
        out.rayOk = true;
      }));
      check('the ray hit the body before', r.before === 'rigid', J(r));
      check('after the module left, the ray answers without throwing', r.rayOk && !r.threw && !r.err, J(r));
    },
  },
  {
    name: '[guard] swap unuse level: record nodes leave the scene and the rays',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => msRun('ms-node', ({ floor, THREE }) => {
        const s = floor(), n = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
        s.name = 'msLevel'; n.name = 'msNode'; n.userData.id = 'door'; n.position.set(0, 1, 0); s.add(n); s.updateMatrixWorld(true);
        return [threedogThreads.world(), threedogThreads.collision(), threedogThreads.level({ scene: s })];
      }, async ({ E, out, settle, step, THREE }) => {
        await settle();
        const ray = () => { const h = E.raycast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -1, 0)); return h ? h.object?.name ?? 'hit' : null; };
        out.drawn = !!E.scene.getObjectByName('msNode'); out.hit = ray();
        E.unuse('level');
        step(3); await settle(2);
        out.drawnAfter = !!E.scene.getObjectByName('msNode'); out.hitAfter = ray();
      }));
      check('the node was drawn and hit by a ray', r.drawn && r.hit === 'msNode', J(r));
      check('the level left and its node left the scene', !r.threw && !r.err && !r.drawnAfter, J(r));
      check('... and the rays', r.hitAfter === null, J(r));
    },
  },
  {
    name: '[guard] swap unuse inventory: its touch button goes too',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        // a phone, seen the way Input reads it; restored at once, so the shared page stays a desktop for other rows
        const real = window.matchMedia; window.matchMedia = q => (q.includes('coarse') ? { matches: true, addEventListener() {}, removeEventListener() {} } : real.call(window, q));
        try {
          return await msRun('ms-touch', () => [threedogThreads.all.inventory()], async ({ E, out }) => {
            const has = () => E.input._touch.some(b => b.action === 'inventory');
            out.before = has();
            E.unuse('inventory');
            out.after = has();
          }, { bindings: { inventory: ['KeyI'] } });
        } finally { window.matchMedia = real; }
      });
      check('the button was there', r.before, J(r));
      check('it left with the module', !r.threw && !r.err && !r.after, J(r));
    },
  },
  {
    name: '[guard] swap unload level: the zone and the spawn of a level that left are gone with it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => {
        const { level, world, THREE } = threedogThreads;
        const scene = async () => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()), p = new THREE.Object3D(); m.name = 'ground'; p.name = 'spawn'; p.position.set(3, 0, 0); s.add(m, p); return s; };
        return msRun('ms-zone', () => [world(), level({})], async ({ E, out, settle }) => {
          E.assets.manifest({ name: 'ms-zone', models: { lvZ: { build: scene } } });
          await E.level.load('lvZ'); await settle();
          out.zone = E.world.zone; out.spawn = E.level.spawn.x;
          E.level.unload();
          out.zoneAfter = E.world.zone ?? null; out.spawnAfter = E.level.spawn.x;
        });
      });
      check('the level stood in its zone, on its spawn', r.zone === 'lvZ' && r.spawn === 3, J(r));
      check('an unloaded level leaves neither', !r.threw && r.zoneAfter === null && r.spawnAfter === 0, J(r));
    },
  },
  {
    name: '[guard] swap unuse content: its hud markers go',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => {
        const { all: T } = threedogThreads;
        return msRun('ms-mark', () => [T.hud(), T.content()], async ({ E, out }) => {
          let live = 0;
          const watch = hud => { const real = hud.marker; hud.marker = (...a) => { const h = real.apply(hud, a), rm = h.remove; live++; h.remove = () => { live--; rm.call(h); }; return h; }; };
          watch(E.hud);
          E.content._mark('ms-m', { x: 1, y: 0, z: 1 }, 'here');
          out.shown = live;
          E.unuse('content');
          out.live = live;
        });
      });
      check('the marker was shown', r.shown === 1, J(r));
      check('it left with content', !r.threw && !r.err && r.live === 0, J(r));
    },
  },
  {
    name: '[guard] swap replaces picture: the new style pack holds the slot and the old one wrote nothing behind',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(() => {
        const look = (name, ctxLog) => ({ name, type: 'picture', skipKind: 'none', provides: ['picture', 'sun'], install(e, ctx) { ctxLog.push(name); ctx.track({ remove: () => ctxLog.push('-' + name) }); } });
        const log = [];
        return msRun('ms-pic', () => [look('msLookA', log)], async ({ E, out, step }) => {
          E.use(look('msLookB', log), { replaces: 'picture' });
          step(2);
          out.mods = [...E.modules.keys()]; out.log = log.join();
        });
      });
      check('the old pack left, the new one came, in that order', !r.threw && !r.err && r.log === 'msLookA,-msLookA,msLookB' && !r.mods.includes('msLookA'), J(r));
    },
  },
  {
    name: '[guard] swap replaces level: the pack does not take the game back from a later level.load',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { level, world, all: T, THREE } = threedogThreads;
        const scene = n => async () => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); s.name = n; m.name = 'ground'; s.add(m); return s; };
        const run = (key, swap) => msRun(key, () => [world(), T.content(), level({})], async ({ E, out, settle }) => {
          E.assets.manifest({ name: key, models: { lvA: { build: scene('lvA') }, lvC: { build: scene('lvC') } } });
          E.content.load({ level: 'lvA' });
          await settle();
          await E.level.load('lvC');   // finished before any swap: nothing was overtaken in flight
          await settle();
          out.was = E.modules.get('level').describe().file;
          swap(E);
          await settle(10);
          out.now = E.modules.get('level').describe().file;
          out.roots = ['lvA', 'lvC'].filter(n => E.scene.getObjectByName(n));
        });
        return {
          // a failed swap promises the game as it was (core/engine/modules.js _putBack)
          failed: await run('ms-lv-bad', E => { try { E.use({ name: 'badLv', type: 'world', provides: ['level'], install() { throw new Error('bad install'); } }, { replaces: 'level' }); } catch { /* the failure is the case */ } }),
          worked: await run('ms-lv-ok', E => E.use(level({}), { replaces: 'level' })),
        };
      });
      check('a failed swap leaves the game on the level it was on', r.failed.was === 'lvC' && r.failed.now === 'lvC' && r.failed.roots.join() === 'lvC', J(r));
      check('a swap that worked does not go back to the pack\'s older level', r.worked.was === 'lvC' && r.worked.now === 'lvC' && r.worked.roots.join() === 'lvC', J(r));
    },
  },
];
