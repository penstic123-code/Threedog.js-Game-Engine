// Core hardening: module install is all-or-nothing, stage order is enforced, critical modules stop start(), late modules get a state, step(0) does not advance.
// Each test builds fresh headless engines on the threads test page. Run: npm test -- "Core modules"

const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'Core modules: template instances are placed only through engine.content.spawn (no engine.spawn on the root, no engine.entities) [guard]',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cm-spawn' });
        const out = { spawn: typeof E.spawn, entities: typeof E.entities, content: typeof E.content };
        E.dispose();
        return out;
      });
      // why: a second placement path (engine.spawn / engine.entities) is how a second, unsaved or unchecked kind of placeable creeps back in
      check('a bare engine has no engine.spawn and no engine.entities; content.spawn exists only with content()', r.spawn === 'undefined' && r.entities === 'undefined' && r.content === 'undefined', JSON.stringify(r));
    },
  },
  {
    name: 'Core modules: engine.use(a, b) is all-or-nothing -- b failing validation or install leaves no trace of a (modules, engine.a, hooks, dispose called)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cm-batch' });
        const err = fn => { try { fn(); return null; } catch (e) { return e; } };
        const hooks = () => E._hooks.fixed.length;
        const h0 = hooks();
        const e1 = err(() => E.use({ name: 'cmA', type: 'rules', fixed() {} }, { name: 'cmB', type: 'rules', stage: 'bogus' }));
        const afterValidate = { has: E.has('cmA'), prop: E.cmA, hooks: hooks() - h0 };
        let disposed = 0;
        const e2 = err(() => E.use({ name: 'cmC', type: 'rules', fixed() {}, install: () => ({}), dispose() { disposed++; } }, { name: 'cmD', type: 'rules', install() { throw new Error('install boom'); } }));
        const afterInstall = { has: E.has('cmC'), prop: E.cmC, hooks: hooks() - h0, disposed, order: E.moduleOrder.filter(n => n.startsWith('cm')) };
        const e3 = err(() => E.use({ name: 'cmE', type: 'rules' }, { name: 'cmF', type: 'rules', requires: ['cmE'], after: ['cmG'] }, { name: 'cmG', type: 'rules', after: ['cmF'] }));
        const afterCycle = E.has('cmE');
        E.use({ name: 'cmH', type: 'rules', fixed() {} }, { name: 'cmI', type: 'rules', requires: ['cmH'], fixed() {} });   // a later module in the same batch may require an earlier one
        const ok = { h: E.has('cmH'), i: E.has('cmI'), hooks: hooks() - h0 };
        E.dispose();
        return { e1: e1?.message, afterValidate, e2: e2?.message, afterInstall, e3: e3?.message, afterCycle, ok };
      });
      check('b fails validation (bad stage): a is not installed, hooks unchanged', /bogus/.test(r.e1 ?? '') && !r.afterValidate.has && r.afterValidate.prop === undefined && r.afterValidate.hooks === 0, JSON.stringify(r));
      check('b throws in install(): a is rolled back (modules, engine.a, hooks), a.dispose() ran, the error still reaches the caller', /install boom/.test(r.e2 ?? '') && !r.afterInstall.has && r.afterInstall.prop === undefined && r.afterInstall.hooks === 0 && r.afterInstall.disposed === 1 && r.afterInstall.order.length === 0, JSON.stringify(r));
      check('a cycle created inside one batch is caught before anything installs', /cycle/.test(r.e3 ?? '') && !r.afterCycle, JSON.stringify(r));
      check('a later module in the batch can require an earlier one; a good batch installs and its hooks are in', r.ok.h && r.ok.i && r.ok.hooks === 2, JSON.stringify(r));
    },
  },
  {
    name: 'Core modules: before / after that contradict the stage order throw at use() with both modules, both stages and the fix; same stage is fine',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cm-stage' });
        const err = fn => { try { fn(); return null; } catch (e) { return e; } };
        const bad = err(() => E.use({ name: 'cmA', type: 'rules', stage: 'control' }, { name: 'cmB', type: 'rules', stage: 'audio', before: ['cmA'] }));
        const afterBad = E.has('cmA') || E.has('cmB');
        E.use({ name: 'cmX', type: 'rules', stage: 'control' });
        const badAfter = err(() => E.use({ name: 'cmY', type: 'rules', stage: 'control', after: ['cmZ'] }, { name: 'cmZ', type: 'rules', stage: 'audio' }));
        const badAgainstInstalled = err(() => E.use({ name: 'cmW', type: 'rules', stage: 'audio', before: ['cmX'] }));
        E.use({ name: 'cmS1', type: 'rules', stage: 'gameplay' }, { name: 'cmS2', type: 'rules', stage: 'gameplay', before: ['cmS1'] });   // same stage: before / after decide as before
        const same = E.moduleOrder.filter(n => n.startsWith('cmS'));
        const good = err(() => E.use({ name: 'cmP', type: 'rules', stage: 'control', before: ['cmQ'] }, { name: 'cmQ', type: 'rules', stage: 'audio' }));   // consistent with the stage order
        E.dispose();
        return { bad: bad?.message, code: bad?.code, afterBad, badAfter: badAfter?.message, badAgainstInstalled: badAgainstInstalled?.message, same, good: good?.message ?? null };
      });
      check('before against the stage order: error names both modules and stages and says what to change', /cmB/.test(r.bad ?? '') && /cmA/.test(r.bad) && /audio/.test(r.bad) && /control/.test(r.bad) && /stage/.test(r.bad) && r.code === 'module-order' && !r.afterBad, JSON.stringify(r));
      check('after against the stage order and against an already installed module also throw', /cmY/.test(r.badAfter ?? '') && /cmW/.test(r.badAgainstInstalled ?? ''), JSON.stringify(r));
      check('inside one stage before / after still decide; a consistent cross-stage before is accepted', r.same.join() === 'cmS2,cmS1' && r.good === null, JSON.stringify(r));
    },
  },
  {
    name: 'Core modules: a critical module whose init fails makes start() reject with the reason; a non-critical one keeps the old behaviour; a module that never gets ready times out with its name',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const run = async (id, mod, tweak) => {
          const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: id });
          E.use(mod); tweak?.(E);
          let rejected = null;
          try { await E.start(); } catch (e) { rejected = e; }
          const out = { rejected: rejected?.message ?? null, code: rejected?.code ?? null, ready: E.ready, state: E.moduleStates?.[mod.name], err: E.error?.message ?? null };
          E.dispose();
          return out;
        };
        const crit = await run('cm-crit', { name: 'cmCrit', type: 'rules', critical: true, init() { throw new Error('crit boom'); } });
        const soft = await run('cm-soft', { name: 'cmSoft', type: 'picture', init() { throw new Error('soft boom'); } });
        const dflt = await run('cm-dflt', { name: 'cmDflt', type: 'rules', init() { throw new Error('dflt boom'); } });
        const never = await run('cm-never', { name: 'cmNever', type: 'rules', isReady: () => false }, E => { E.loading.timeoutMs = 300; });
        // a later poll runs in a timer, where a throw used to end the polling: start() then never settled
        const t0 = performance.now();
        const threw = await run('cm-threw', { name: 'cmThrew', type: 'rules', isReady() { if (performance.now() - t0 > 60) throw new Error('ready boom'); return false; } }, E => { E.loading.timeoutMs = 5000; });
        [console.error, console.warn] = quiet;
        return { crit, soft, dflt, never, threw };
      });
      check('critical init failure: start() rejects, message has the module name and "crit boom", engine not ready', /cmCrit/.test(r.crit.rejected ?? '') && /crit boom/.test(r.crit.rejected) && !r.crit.ready && r.crit.state === 'failed', JSON.stringify(r.crit));
      check('non-critical picture module failing init: start() resolves, the module is disabled', r.soft.rejected === null && r.soft.ready && r.soft.state === 'failed', JSON.stringify(r.soft));
      check('a module is not critical by default: gameplay init failure is reported (engine.error) but start() still resolves', r.dflt.rejected === null && r.dflt.ready && r.dflt.state === 'failed', JSON.stringify(r.dflt));
      check('isReady that never turns true: start() rejects after loading.timeoutMs naming the module', /cmNever/.test(r.never.rejected ?? '') && r.never.code === 'module-not-ready', JSON.stringify(r.never));
      check('an isReady that throws while start() waits rejects start() with that error', /ready boom/.test(r.threw.rejected ?? '') && !r.threw.ready, JSON.stringify(r.threw));
    },
  },
  {
    name: 'Core modules: a module installed after start() has a state; no fixed / frame hooks until init succeeded; loading.settled() waits; failed init stays out',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cm-late' });
        await E.start();
        let release, fixed = 0, frames = 0;
        const gate = new Promise(res => { release = res; });
        const ret = E.use({ name: 'cmLate', type: 'rules', async init() { await gate; }, fixed() { fixed++; }, frame() { frames++; } });
        E.step(0.2);
        const during = { ret: ret === E, state: E.moduleStates.cmLate, fixed, frames, describe: E.describe().moduleStates?.cmLate, order: E.moduleOrder.includes('cmLate') };
        release();
        await E.loading.settled();
        E.step(0.2);
        const after = { state: E.moduleStates.cmLate, fixedRan: fixed > 0, framesRan: frames > 0, describe: E.describe().moduleStates?.cmLate ?? null };
        let bad = 0;
        E.use({ name: 'cmBad', type: 'rules', init() { throw new Error('late boom'); }, fixed() { bad++; } });
        await E.loading.settled();
        E.error = null; E.unfreeze?.('error');
        E.step(0.2);
        const failed = { state: E.moduleStates.cmBad, ran: bad, described: E.describe().moduleStates?.cmBad };
        [console.error, console.warn] = quiet;
        E.dispose();
        return { during, after, failed };
      });
      check('during init: use() returns the engine, state is "initializing" (also in describe), the module is in moduleOrder, no hook ran', r.during.ret && r.during.state === 'initializing' && r.during.describe === 'initializing' && r.during.fixed === 0 && r.during.frames === 0 && r.during.order, JSON.stringify(r.during));
      check('after init: loading.settled() resolved, state "running", hooks run, describe no longer lists it', r.after.state === 'running' && r.after.fixedRan && r.after.framesRan && r.after.describe === null, JSON.stringify(r.after));
      check('init that throws: state "failed", its hooks never run', r.failed.state === 'failed' && r.failed.ran === 0 && r.failed.described === 'failed', JSON.stringify(r.failed));
    },
  },
  {
    name: 'Core modules: step(0) advances nothing; negative / NaN / Infinity throw with the fix; tiny positive seconds still advance one step',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cm-step' });
        await E.start();
        let n = 0;
        E.use({ name: 'cmCount', type: 'rules', fixed() { n++; } });
        const err = v => { try { E.step(v); return null; } catch (e) { return e.message; } };
        const t0 = E.time.now('real');
        E.step(0);
        const zero = { n, moved: E.time.now('real') - t0 };
        const neg = err(-1), nan = err(NaN), inf = err(Infinity), str = err('1');
        const afterBad = n;
        E.step(0.001);
        const tiny = n;
        E.dispose();
        return { zero, neg, nan, inf, str, afterBad, tiny };
      });
      check('step(0): no fixed step, no time', r.zero.n === 0 && r.zero.moved === 0, JSON.stringify(r));
      check('step(-1) / NaN / Infinity / "1" throw and say what to pass; nothing advanced', [r.neg, r.nan, r.inf, r.str].every(m => /seconds/.test(m ?? '')) && r.afterBad === 0, JSON.stringify(r));
      check('step(0.001) still runs one fixed step (a positive request is never dropped)', r.tiny === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] Core modules: every resource a module registers leaves with it -- unuse / rollback take ops and save parts, saved data stays as unattached data, the same module installs again',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, { inventory } = threedogThreads.all, out = {};
        const err = fn => { try { fn(); return null; } catch (e) { return e; } };
        const parts = E => [...E.saves.providers.keys()].filter(k => k === 'inventory' || k === 'containers');
        const ops = E => [...E.ops.defs.keys()].filter(k => k.startsWith('inventory.'));
        const E = mk(createEngine, 'cm-own');
        await E.start();
        E.use(inventory());
        E.ops.allow(() => E.inventory.add('apple', 3));
        out.resources = E.catalog('inventory').resources;
        E.unuse('inventory');
        out.gone = { ops: ops(E), parts: parts(E) };
        out.kept = E.saves.collect().parts.inventory !== undefined;
        out.again = err(() => E.use(inventory()))?.message ?? null;
        out.apples = E.has('inventory') ? E.inventory.count('apple') : null;
        E.dispose();
        // a batch that throws leaves nothing behind, and a module that never ran writes nothing into the save
        const B = mk(createEngine, 'cm-own-batch');
        await B.start();
        out.boom = err(() => B.use(inventory(), { name: 'cmBoom', type: 'rules', install() { throw new Error('cm boom'); } }))?.message;
        out.batch = { has: B.has('inventory'), ops: ops(B), parts: parts(B), saved: 'inventory' in B.saves.collect().parts };
        B.dispose();
        // a failed init takes what its install registered too
        const F = mk(createEngine, 'cm-own-init');
        F.use({ name: 'cmFail', type: 'rules', install(e, ctx) { ctx.ops?.define('cmFail.go', { run() {} }); ctx.saves?.define('cmFail', { save: () => ({ a: 1 }), load() {} }); ctx.ui?.define('cmFail', () => ({})); },
          init() { throw new Error('cm init'); } });
        const q = [console.error, console.warn]; console.error = console.warn = () => {};
        await F.start();
        [console.error, console.warn] = q;
        out.init = { ctx: F.has('cmFail'), op: F.ops.defs.has('cmFail.go'), part: F.saves.providers.has('cmFail'), ui: F.ui.defs.has('cmFail') };
        F.dispose();
        // the data of a part whose module is gone rides along in later saves and comes back on a later install
        const S = mk(createEngine, 'cm-own-save');
        await S.start();
        let seen = null, v = 5;
        S.use({ name: 'cmPart', type: 'rules', install(e, ctx) { (ctx.saves ?? e.saves).define('cmPart', { version: 2, save: () => ({ v }), load: d => { v = d.v; } }); } });
        S.unuse('cmPart');
        const saved = JSON.parse(JSON.stringify(S.saves.collect()));
        out.rides = saved.parts.cmPart?.v === 5 && saved.versions.cmPart === 2;
        S._cmKeep = err(() => S.use({ name: 'cmPart', type: 'rules', install(e, ctx) { (ctx.saves ?? e.saves).define('cmPart', { version: 2, save: () => ({ v: seen }), load: d => { seen = d.v; } }); } }));
        out.back = seen;
        S.dispose();
        // replaces hands the data to the newcomer through the same path; a failed swap restores the old state
        const R = mk(createEngine, 'cm-own-swap');
        await R.start();
        const box = (name, o = {}) => { const m = { name, type: 'rules', provides: ['cmBox'], v: o.v ?? 0,
          install(e, ctx) { (ctx.saves ?? e.saves).define('cmBox', { save: () => ({ v: m.v }), load: d => { m.v = d.v; } }); if (o.boom) throw new Error('swap boom'); } }; return m; };
        const a = box('cmBoxA', { v: 9 });
        R.use(a);
        a.v = 10;
        out.swapErr = err(() => R.use(box('cmBoxB', { boom: true }), { replaces: 'cmBox' }))?.message;
        out.swap = { a: R.has('cmBoxA'), b: R.has('cmBoxB'), saved: R.saves.collect().parts.cmBox?.v };
        const b = box('cmBoxC');
        R.use(b, { replaces: 'cmBox' });
        out.taken = b.v;
        R.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('the owner record lists what the module registered, by kind (catalog)', r.resources?.includes('op:inventory.transfer') && r.resources?.includes('save:inventory') && r.resources?.includes('ui:inventory'), J);
      check('unuse takes the ops and save parts', !r.gone.ops.length && !r.gone.parts.length, J);
      check('unuse keeps the data: it stays in the save as unattached data', r.kept, J);
      check('use -> unuse -> use works and the items come back', r.again === null && r.apples === 3, J);
      check('a batch that throws leaves no op, no save part and no save data', r.boom === 'cm boom' && !r.batch.has && !r.batch.ops.length && !r.batch.parts.length && !r.batch.saved, J);
      check('a failed init takes the ops, save parts and ui definitions of its install', r.init.ctx && !r.init.op && !r.init.part && !r.init.ui, J);
      check('unattached data keeps its version, rides in saves and returns on a later install', r.rides && r.back === 5, J);
      check('a failed replaces puts the old module back with its live state', r.swapErr === 'swap boom' && r.swap.a && !r.swap.b && r.swap.saved === 10, J);
      check('a replaces with the same part hands the newcomer the data', r.taken === 10, J);
    },
  },
  {
    name: '[guard] Core modules: ground is one exclusive capability -- terrain and level conflict at use(), replaces swaps them, a provider leaving hands the flat ground back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level } = threedogThreads, { terrain } = threedogThreads.all, out = {};
        const err = fn => { try { fn(); return null; } catch (e) { return e; } };
        const E = mk(createEngine, 'cm-ground');
        E.use(terrain({ height: () => 7, viewChunks: 1 }));
        const e1 = err(() => E.use(level({ outside: -3 })));
        out.conflict = { code: e1?.code, msg: e1?.message, level: E.has('level'), surface: E.surface(0, 0) };
        E.dispose();
        const L = mk(createEngine, 'cm-ground-2');
        const e2 = err(() => L.use(level({ outside: -3 }), terrain({ height: () => 7, viewChunks: 1 })));
        out.batch = { code: e2?.code, level: L.has('level'), terrain: L.has('terrain') };
        L.use(level({ outside: -3 }));
        out.level = L.surface(0, 0);
        out.holder = L.stacks.has('ground') ? L.stacks.get('ground').value() : null;
        out.swap = err(() => L.use({ name: 'cmGround', type: 'world', provides: ['ground'], install(e, ctx) { ctx.ground.provide({ height: () => 4 }); } }, { replaces: 'ground' }))?.message ?? null;
        out.swapped = { level: L.has('level'), surface: L.surface(0, 0), engineGround: typeof L.ground.height };
        if (L.has('cmGround')) L.unuse('cmGround');
        out.flat = { surface: L.surface(0, 0), holder: L.stacks.has('ground') ? L.stacks.get('ground').value() : null };
        // a module has to declare the claim, so a conflict can be found before anything installs
        const e3 = err(() => L.use({ name: 'cmSneak', type: 'world', install(e, ctx) { ctx.ground.provide({ height: () => 1 }); } }));
        out.undeclared = { code: e3?.code, has: L.has('cmSneak'), surface: L.surface(0, 0) };
        L.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('terrain then level: shared-taken at use(), naming ground; terrain stays, surface unchanged', r.conflict.code === 'shared-taken' && /ground/.test(r.conflict.msg) && !r.conflict.level && r.conflict.surface === 7, J);
      check('level + terrain in one batch: refused before anything installs', r.batch.code === 'shared-taken' && !r.batch.level && !r.batch.terrain, J);
      check('level alone gives the ground and holds the slot', r.level === -3 && r.holder === 'level', J);
      check('{ replaces: \'ground\' } swaps the provider and engine.ground stays the ground API', r.swap === null && !r.swapped.level && r.swapped.surface === 4 && r.swapped.engineGround === 'function', J);
      check('a provider leaving hands back the flat ground and the slot', r.flat.surface === 0 && !r.flat.holder, J);
      check('ctx.ground.provide without provides: [\'ground\'] is refused', r.undeclared.code === 'module-provides' && !r.undeclared.has && r.undeclared.surface === 0, J);
    },
  },
  {
    name: '[guard] Core modules: a level leaves with its module -- unuse and replaces take the drawn scene, the col_ walls, the rays and what level.track holds, a file on its way is dropped',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, level, collision, THREE } = threedogThreads;
        const build = n => {
          const g = new THREE.Group(); g.name = n;
          const mat = new THREE.MeshBasicMaterial(), floor = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), mat), wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), mat);
          floor.name = 'ground'; wall.name = 'col_wall'; wall.position.set(5, 2, 0);
          g.add(floor, wall);
          return g;
        };
        const leaves = async (key, take) => {
          const E = mk(createEngine, key);
          let gate = null, removed = 0;
          E.assets.manifest({ name: key, models: { late: { build: async () => { await new Promise(res => { gate = res; }); return build('late'); } } } });
          E.use(collision(), level({ scene: build('lvl') }));
          await E.start();
          const blocked = () => !E.collision.walkable({ x: 5, z: 0 });
          E.level.track({ remove() { removed++; } });
          const before = { drawn: !!E.scene.getObjectByName('lvl'), blocked: blocked() };
          const pending = E.level.load('late');
          for (let i = 0; i < 100 && !gate; i++) await new Promise(res => setTimeout(res, 5));
          const scope = E.modules.get('level');
          take(E);
          const after = { drawn: !!E.scene.getObjectByName('lvl'), blocked: blocked(), removed, hasLevel: E.has('level') && E.modules.get('level') === scope };
          gate?.(); await pending.catch(() => {});
          await new Promise(res => setTimeout(res, 20));
          after.late = !!E.scene.getObjectByName('late');
          // the same module installs again and is whole
          if (!E.has('level')) E.use(level({ scene: build('again') }));
          else { E.unuse('cmFlat'); E.use(level({ scene: build('again') })); }
          await new Promise(res => setTimeout(res, 20));
          const again = { drawn: !!E.scene.getObjectByName('again'), blocked: blocked() };
          E.dispose();
          return { before, after, again };
        };
        return {
          unuse: await leaves('cm-lv-unuse', E => E.unuse('level')),
          replaces: await leaves('cm-lv-swap', E => E.use({ name: 'cmFlat', type: 'world', skipKind: 'none', provides: ['level', 'ground'], install(e, ctx) { ctx.ground.provide({ height: () => 0 }); return {}; } }, { replaces: 'ground' })),
        };
      });
      const J = JSON.stringify(r);
      for (const k of ['unuse', 'replaces']) {
        const { before, after, again } = r[k];
        check(`${k}: the level drew and blocked before`, before.drawn && before.blocked, J);
        check(`${k}: the scene is gone`, !after.drawn && !after.hasLevel, J);
        check(`${k}: the col_ walls no longer block`, !after.blocked, J);
        check(`${k}: what level.track held is removed, once`, after.removed === 1, J);
        check(`${k}: a file on its way does not land`, !after.late, J);
        check(`${k}: the module installs again, drawn and blocking`, again.drawn && again.blocked, J);
      }
    },
  },
  {
    name: '[guard] Core modules: use, unuse, replaces and plugin on / off go through one change plan -- every consumer is checked before anything is touched, a plugin is judged as a set',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        const err = fn => { try { fn(); return null; } catch (e) { return e; } };
        // a replace is checked on everything the old module gave
        const E = mk(createEngine, 'cm-plan');
        await E.start();
        let disposed = 0;
        E.use({ name: 'cmOld', type: 'rules', provides: ['cmA', 'cmB'], dispose() { disposed++; } }, { name: 'cmUser', type: 'rules', requires: ['cmB'] });
        const e1 = err(() => E.use({ name: 'cmNew', type: 'rules', provides: ['cmA'] }, { replaces: 'cmA' }));
        out.replace = { code: e1?.code, msg: e1?.message, old: E.has('cmOld'), neu: E.has('cmNew'), disposed };
        if (E.has('cmNew')) E.unuse('cmNew');
        out.ok = err(() => E.use({ name: 'cmNew2', type: 'rules', provides: ['cmA', 'cmB'] }, { replaces: 'cmA' }))?.message ?? null;
        out.afterOk = { old: E.has('cmOld'), user: E.moduleStates.cmUser, disposed };
        const e2 = err(() => E.unuse('cmNew2'));
        out.unuse = { code: e2?.code, still: E.has('cmNew2') };
        E.dispose();
        // plugin off: blocked when an outside module needs it, fine when the plugin owns both ends
        const P = mk(createEngine, 'cm-plan-plugin');
        P.plugins.add({
          './plugins/10-give.js': { default: { name: 'cmGive', type: 'rules', provides: ['cmCap'], install() {} } },
          './plugins/20-pair.js': { default: [{ name: 'cmPairA', type: 'rules', provides: ['cmPair'], install() {} }, { name: 'cmPairB', type: 'rules', requires: ['cmPair'], install() {} }] },
        });
        await P.start();
        P.use({ name: 'cmNeeds', type: 'rules', requires: ['cmCap'] });
        const e3 = err(() => P.plugins.off('10-give'));
        out.off = { code: e3?.code, msg: e3?.message, on: P.plugins.list().find(p => p.name === '10-give').on, give: P.has('cmGive') };
        out.pair = err(() => P.plugins.off('20-pair'))?.message ?? null;
        out.pairGone = !P.has('cmPairA') && !P.has('cmPairB');
        out.pairOn = err(() => P.plugins.on('20-pair'))?.message ?? null;
        out.pairBack = P.has('cmPairA') && P.has('cmPairB');
        P.unuse('cmNeeds');
        out.offNow = err(() => P.plugins.off('10-give'))?.message ?? null;
        P.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('replacing a two-capability provider with a one-capability one is refused before dispose, naming the consumer and capability',
        r.replace.code === 'module-replaces' && /cmUser/.test(r.replace.msg) && /cmB/.test(r.replace.msg) && r.replace.old && !r.replace.neu && r.replace.disposed === 0, J);
      check('a replacement giving everything goes through', r.ok === null && !r.afterOk.old && r.afterOk.user === 'running' && r.afterOk.disposed === 1, J);
      check('unuse of a needed provider is refused', r.unuse.code === 'module-unuse' && r.unuse.still, J);
      check('plugin off with an outside consumer is refused and the plugin stays on', r.off.code === 'module-unuse' && /cmNeeds/.test(r.off.msg ?? '') && r.off.on && r.off.give, J);
      check('a plugin owning provider and consumer goes off and on as a set', r.pair === null && r.pairGone && r.pairOn === null && r.pairBack, J);
      check('once the consumer left, plugin off works', r.offNow === null, J);
    },
  },
  {
    name: '[guard] Core modules: a consumer waits for its provider -- blockedBy is observable, a critical consumer fails start, others stay blocked, a late fix unblocks, unrelated modules go on',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        const q = [console.error, console.warn]; console.error = console.warn = () => {};
        const bad = () => ({ name: 'cmPic', type: 'picture', provides: ['cmLook'], init() { throw new Error('pic boom'); } });
        const E = mk(createEngine, 'cm-block');
        let fx = 0, inits = 0, far = 0, other = 0;
        E.use(bad(), { name: 'cmRules', type: 'rules', requires: ['cmLook'], init() { inits++; }, fixed() { fx++; } },
          { name: 'cmFar', type: 'rules', requires: ['cmRules'], fixed() { far++; } }, { name: 'cmOther', type: 'rules', fixed() { other++; } });
        await E.start();
        E.step(1 / 60); E.step(1 / 60);
        out.soft = { fx, inits, far, other, ready: E.ready, states: { ...E.moduleStates } };
        out.blockedBy = E.catalog('cmRules').blockedBy ?? [];
        out.chain = E.catalog('cmFar').blockedBy ?? [];
        out.problems = E.catalog('cmRules').problems;
        out.describe = E.describe().moduleStates;
        const list = E.catalog();
        out.short = (list.modules ?? list).find?.(m => m.id === 'cmRules')?.blockedBy ?? null;
        // late: a consumer installed now follows the same rule; a working provider lifts every block and the waiting init runs
        let late = 0;
        E.use({ name: 'cmLate', type: 'rules', requires: ['cmLook'], fixed() { late++; } });
        E.step(1 / 60);
        out.late = { late, state: E.moduleStates.cmLate };
        try { E.use({ name: 'cmPic2', type: 'picture', provides: ['cmLook'], async init() { await 0; } }, { replaces: 'cmLook' }); } catch (e) { out.swapErr = e.message; }
        await E.loading.settled();
        fx = far = late = 0;
        E.step(1 / 60);
        out.fixed = { fx, inits, far, late, states: { ...E.moduleStates }, blocked: E.catalog('cmRules').blockedBy ?? [] };
        E.dispose();
        // a critical consumer fails start()
        const C = mk(createEngine, 'cm-block-crit');
        C.use(bad(), { name: 'cmCrit', type: 'rules', critical: true, requires: ['cmLook'] });
        out.crit = await C.start().then(() => null, e => ({ code: e.code, msg: e.message }));
        C.dispose();
        // hooks wait while a late provider is still initializing
        const W = mk(createEngine, 'cm-block-wait');
        await W.start();
        let open, wait = 0;
        const order = [], gate = new Promise(res => { open = res; });
        W.use({ name: 'cmSlow', type: 'rules', provides: ['cmSlowCap'], async init() { await gate; order.push('provider'); } },
          { name: 'cmWait', type: 'rules', requires: ['cmSlowCap'], init() { order.push('consumer'); }, fixed() { wait++; } });
        await 0; await 0;
        W.step(1 / 60);
        out.waiting = { wait, by: W.catalog('cmWait').blockedBy ?? [] };
        open();
        await W.loading.settled();
        W.step(1 / 60);
        out.waited = { wait, order, state: W.moduleStates.cmWait };
        W.dispose();
        [console.error, console.warn] = q;
        return out;
      });
      const J = JSON.stringify(r);
      check('a failed provider blocks its consumer: no init, no hooks, status says blocked', r.soft.fx === 0 && r.soft.inits === 0 && r.soft.states.cmRules === 'blocked', J);
      check('the block goes down the chain', r.soft.far === 0 && r.soft.states.cmFar === 'blocked' && r.chain[0]?.module === 'cmRules', J);
      check('soft failures stay soft: start() finished, an unrelated module runs', r.soft.ready && r.soft.other === 2 && r.soft.states.cmOther === 'running', J);
      check('blockedBy names capability, provider and its state in catalog', r.blockedBy[0]?.requires === 'cmLook' && r.blockedBy[0]?.module === 'cmPic' && r.blockedBy[0]?.state === 'failed', J);
      check('catalog problems and describe say why', r.problems.some(p => /cmPic/.test(p)) && /cmPic/.test(r.describe?.cmRules ?? ''), J);
      check('the short catalog carries blockedBy too', r.short?.[0]?.module === 'cmPic', J);
      check('a late consumer of a failed provider is blocked too', r.late.late === 0 && r.late.state === 'blocked', J);
      check('replacing the failed provider unblocks: the waiting init runs once, hooks start, down the chain', r.fixed.inits === 1 && r.fixed.fx === 1 && r.fixed.far === 1 && r.fixed.late === 1
        && r.fixed.states.cmRules === 'running' && !r.fixed.blocked.length, J);
      check('a critical consumer of a failed provider stops start() with the reason', r.crit?.code === 'module-critical' && /cmCrit/.test(r.crit?.msg) && /cmPic/.test(r.crit?.msg), J);
      check('a consumer waits for a provider still initializing, then inits after it', r.waiting.wait === 0 && r.waiting.by[0]?.state === 'initializing' && r.waited.wait === 1 && r.waited.order.join() === 'provider,consumer' && r.waited.state === 'running', J);
    },
  },
];
