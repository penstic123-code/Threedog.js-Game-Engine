// Pre-1.0 audit, lifecycle group: hostile scenarios that cross modules. Each one builds its own engines and breaks them on purpose: a dispose in the middle of a step, a module
// swapped while late work lands, two live engines on one page, failures in every kind of callback. Run: npm test -- "Audit lifecycle"
const THREADS = '/tests/threads/', PAGE = '/tests/lifetime/index.html';
const show = r => JSON.stringify(r).slice(0, 900);

export const specs = [
  {
    name: 'Audit lifecycle: install, fail, unload, reinstall and replace leave no registration behind, and a dispose survives every part that throws',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE, quiet = console.error;
        console.error = () => {};
        const E = threedogThreads.mk(T.createEngine, 'audit-life', {});
        E.use(T.world(), T.characters());
        await E.start();
        const base = () => ({ c: Object.fromEntries(Object.entries(E.counts()).filter(([k, v]) => typeof v === 'number' && !['geometries', 'textures'].includes(k))), ops: E.ops.defs.size, saves: E.saves.providers.size,
          actions: E.input.actions.size, shared: JSON.stringify(E.stacks.describe()).length, control: JSON.stringify(E.control.describe()), tracked: E._modTracked.size, onMove: E.time._onMove.length,
          exposure: E.renderer.toneMappingExposure, mods: [...E.modules.keys()].join() });
        const full = (name, boom) => ({ name, provides: ['audit-slot'],
          install(e, ctx) {
            ctx.ops.define(name + '.go', { run: () => 1 });
            ctx.saves.define(name, { save: () => ({ a: 1 }), load() {} });
            ctx.input.define(name + 'Act', { context: 'gameplay' }); ctx.input.bind(name + 'Act', ['KeyK']);
            ctx.mod('time.world', { mul: 0.5 }); ctx.borrow(e.renderer, { toneMappingExposure: 3 });
            ctx.control.take('audit-npc', { layer: 'script' });
            ctx.track(e.events.on('audit:x', () => {})); ctx.track(e.onFixed(() => {})); ctx.track(e.onFrame(() => {}));
            ctx.track(e.clock.after(99, () => {})); ctx.track(e.time.onMove(() => {}));
            ctx.track({ remove() { throw new Error('a handle that cannot be removed'); } });
            ctx.stream.addReadyCheck(name, () => true); ctx.budget.metric(name, () => 1);
            if (boom) throw new Error('install fails last');
          } });
        const b0 = base(), out = { b0 };
        E.use(full('auditA')); out.on = base().ops - b0.ops; E.unuse('auditA'); out.afterUnuse = base();
        try { E.use(full('auditB', true)); } catch (err) { out.failed = err.message; } out.afterFail = base();
        E.use(full('auditC')); E.use(full('auditD'), { replaces: 'audit-slot' }); E.unuse('auditD'); out.afterSwap = base();
        // dispose with everything in the way: a module dispose, a tracked handle, a game material's dispose listener all throw
        const bad = new THREE.MeshBasicMaterial(); bad.addEventListener('dispose', () => { throw new Error('game listener in the way'); });
        const geo = new THREE.BoxGeometry(); geo.addEventListener('dispose', () => { throw new Error('geometry listener in the way'); });
        E.scene.add(new THREE.Mesh(geo, bad));
        E.use({ name: 'auditBad', dispose() { throw new Error('module dispose'); } });
        const ui = E.uiRoot; document.body.append(ui);
        const rd = E.renderer; let renderer = 0; const rdd = rd.dispose.bind(rd); rd.dispose = () => { renderer++; rdd(); };
        try { E.dispose(); out.threw = false; } catch (err) { out.threw = err.message; }
        out.after = { renderer, ui: ui.isConnected, listeners: E.events.size, timers: E.time.size, disposed: E.disposed };
        try { E.dispose(); out.twice = true; } catch (err) { out.twice = err.message; }
        console.error = quiet;
        return out;
      });
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      check('the module really registered (ops grew while installed)', r.on === 1, show(r));
      check('unload gives back every registration', same(r.b0, r.afterUnuse), show([r.b0, r.afterUnuse]));
      check('a failed install gives back every registration', r.failed && same(r.b0, r.afterFail), show([r.b0, r.afterFail]));
      check('replace then unload gives back every registration', same(r.b0, r.afterSwap), show([r.b0, r.afterSwap]));
      check('dispose does not throw when a game dispose listener throws', r.threw === false, show(r));
      check('the rest of dispose still ran: renderer, UI, listeners', r.after.renderer === 1 && r.after.ui === false && r.after.listeners === 0 && r.after.disposed === true, show(r));
      check('a second dispose stays quiet', r.twice === true, show(r));
    },
  },
  {
    name: 'Audit lifecycle: a dispose from inside a fixed step fires no callback afterwards on any time path',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, out = {};
        for (const where of ['onFixed', 'moduleFixed', 'timer', 'op', 'onMove']) {
          const E = threedogThreads.mk(T.createEngine, 'audit-mid-' + where, {}), late = [];
          let gone = false; const kill = () => { if (!gone) { gone = true; E.dispose(); } };
          const note = k => () => { if (gone) late.push(k); };
          E.use({ name: 'tail', fixed: note('module fixed'), frame: note('module frame'), afterRender: note('afterRender') });
          if (where === 'moduleFixed') E.use({ name: 'killer', stage: 'control', fixed: kill });
          await E.start();
          E.time.onMove(note('onMove')); E.onFixed(note('onFixed late'), { phase: 'late' }); E.onFrame(note('onFrame')); E.clock.after(1 / 60, note('timer'), { channel: 'real' }); E.events.on('mod:end', note('event'));
          E.mod('time.world', { owner: 't', mul: 0.5, for: 1 / 60 });
          E.ops.define('audit.kill', { run: kill });
          if (where === 'onFixed') E.onFixed(kill);
          if (where === 'timer') E.clock.after(0, kill, { channel: 'real' });
          if (where === 'op') E.onFixed(() => E.ops.run('audit.kill'));
          if (where === 'onMove') E.time._onMove.unshift(kill);
          E.step(1 / 60);
          out[where] = late;
        }
        return out;
      });
      for (const k of Object.keys(r)) check(`dispose from ${k}: nothing ran afterwards`, r[k].length === 0, show(r));
    },
  },
  {
    name: 'Audit lifecycle: a module swapped while its slow init and late work finish cannot touch the newcomer, and an unload mid-conversation gives input back',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, quiet = console.error, warn = console.warn;
        console.error = () => {}; console.warn = () => {};
        const E = threedogThreads.mk(T.createEngine, 'audit-late', {});
        E.use(T.world(), T.characters(), T.dialogue(), T.timeline());
        await E.start();
        let go; const gate = new Promise(res => { go = res; });
        let staleSignal = null; const seen = {};
        const v1 = { name: 'shop', provides: ['shopSlot'], async init(e, ctx) {
          staleSignal = ctx.signal;
          await gate;
          seen.aborted = ctx.signal.aborted;
          // everything the old install tries after it was swapped out, on the names the newcomer holds
          ctx.mod('time.world', { mul: 0.1 });
          ctx.control.take('npc1', { layer: 'script' });
          ctx.input.define('shopAct', { context: 'gameplay' }); ctx.input.bind('shopAct', ['KeyZ']);
          ctx.borrow(e.renderer, { toneMappingExposure: 9 });
          ctx.track(e.events.on('audit:late', () => { seen.staleListener = true; }));
          try { ctx.saves.define('shopSave', { save: () => ({ who: 'stale' }), load() {} }); ctx.ui.define('shopPart', () => ({ el: document.createElement('div') })); } catch (err) { seen.threw = err.message; }
          throw new Error('late failure of the old install');
        } };
        const v2 = { name: 'shop', provides: ['shopSlot'], install(e, ctx) {
          ctx.mod('time.world', { mul: 0.5 });
          ctx.control.take('npc1', { layer: 'script' });
          ctx.input.define('shopAct', { context: 'gameplay' }); ctx.input.bind('shopAct', ['KeyX']);
          ctx.borrow(e.renderer, { toneMappingExposure: 2 });
          ctx.saves.define('shopSave', { save: () => ({ who: 'new' }), load() {} });
          ctx.ui.define('shopPart', () => ({ el: document.createElement('div') }));
        } };
        E.use(v1);
        await Promise.resolve();
        await Promise.resolve();
        E.use(v2, { replaces: 'shopSlot' });
        go(); await E.loading.settled();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const out = { aborted: seen.aborted, world: E.time.scale('world'), holder: E.control.of('npc1')?.owner ?? null, exposure: E.renderer.toneMappingExposure, keys: E.input.keysOf('shopAct'),
          save: E.saves.providers.get('shopSave')?.save?.(), state: E.moduleStates.shop, error: E.error?.message ?? null, threw: seen.threw ?? null };
        E.events.emit('audit:late'); out.staleListener = !!seen.staleListener;
        // an open conversation when its module goes
        const base = E.input.holders.length, frozen = E.frozen;
        let resolved = false;
        const p = E.dialogue.say('A long line that is still typing when the module is unloaded.', { speaker: 'x' });
        p.then(() => { resolved = true; });
        E.step(1 / 30, { render: false });
        out.during = E.input.holders.length;
        E.unuse('dialogue');
        E.step(1 / 30, { render: false });
        await Promise.resolve(); await Promise.resolve();
        out.dialogueUnload = { base, after: E.input.holders.length, stack: E.input.holders.map(h => h.context), frozen: E.frozen === frozen, resolved };
        // a window with its own freeze when its module goes
        E.use(T.inventory({ pauseGame: true }));
        E.ui.open('inventory'); E.step(1 / 30, { render: false });
        const opened = E.frozen;
        E.unuse('inventory'); E.step(1 / 30, { render: false });
        out.modal = { opened, frozen: E.frozen, holders: E.input.holders.filter(h => h.context !== 'dialog').length, open: [...E._openWindows] };
        // a timeline running when its module goes: the promise ends, the hold goes
        const npc = E.world.add({ id: 'walker', kind: 'npc', position: { x: 0, y: 0, z: 0 } });
        let tl = 'pending';
        E.timeline.play?.(async () => { await E.timeline.wait?.(50); }).then?.(() => { tl = 'done'; }, () => { tl = 'rejected'; });
        E.unuse('timeline');
        E.step(1 / 30, { render: false });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        out.timeline = tl;
        // late work: a job's apply after its owner went, a lane reply after dispose
        const lane = E.threads.lane({ create: () => { throw new Error('no worker'); }, local: () => m => m });
        let applied = 0, landed = 0;
        E.jobs.add(() => 1, { apply: () => { applied++; }, lag: 2 });
        E.session?.newGame && await E.session.newGame();
        E.step(0.2, { render: false });
        out.jobAfterNewGame = applied;
        lane.run({ x: 1 }).then(() => { landed++; });
        E.dispose();
        await new Promise(res => setTimeout(res, 20));
        out.laneAfterDispose = landed;
        console.error = quiet; console.warn = warn;
        return out;
      });
      check('the old install was told it ended (ctx.signal)', r.aborted === true, show(r));
      check('its late ctx.mod leaves the newcomer\'s entry alone', Math.abs(r.world - 0.5) < 1e-9, show(r));
      check('its late control.take leaves the newcomer\'s hold', r.holder === 'shop', show(r));
      check('its late borrow leaves the newcomer\'s value', r.exposure === 2, show(r));
      check('its late input bind leaves the newcomer\'s keys', JSON.stringify(r.keys) === '["KeyX"]', show(r));
      check('its late save part leaves the newcomer\'s', r.save?.who === 'new', show(r));
      check('its failure changes nothing for the newcomer', r.state === 'running' && r.error === null, show(r));
      check('its late listener was dropped', r.staleListener === false, show(r));
      check('an unload mid-conversation gives the input context back', r.dialogueUnload.after === r.dialogueUnload.base, show(r));
      check('the say promise has an outcome', r.dialogueUnload.resolved === true, show(r));
      check('a timeline unloaded while running ends its promise', r.timeline !== 'pending', show(r));
      check('a job apply requested before a new game does not land after it', r.jobAfterNewGame === 0, show(r));
      check('a lane without workers answers nothing after its engine went, like a lane with workers', r.laneAfterDispose === 0, show(r));
      check('a window open when its module goes takes its freeze and input context with it', r.modal.frozen === false && r.modal.holders === 0 && r.modal.opened === true, show(r));
    },
  },
  {
    name: 'Audit lifecycle: two live engines on one page with different seeds, timers and pointer lock stay apart until the last one goes',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { make, THREE } = window.lifetime, out = {};
        let held = null, exits = 0;
        const nativeExit = Document.prototype.exitPointerLock;
        Document.prototype.exitPointerLock = function () { exits++; };
        const A = make({ headless: false, seed: 11, saveKey: 'audit-a' }, false), B = make({ headless: false, seed: 22, saveKey: 'audit-b' }, false);
        const shared = { name: 'twin', calls: 0, install(e, ctx) { ctx.mod('time.world', { mul: e === A ? 0.5 : 2 }); }, fixed(dt, e) { this.calls++; } };
        A.use(shared); B.use(shared);
        await A.start(); await B.start();
        const hA = A.haltLoop('t'), hB = B.haltLoop('t');
        const rolls = e => [e.random.next?.() ?? e.random.float?.(), e.random.next?.() ?? e.random.float?.()];
        const ra = rolls(A), rb = rolls(B);
        const fired = []; A.clock.after(0.5, () => fired.push('A')); B.clock.after(0.5, () => fired.push('B'));
        const sa = []; A.events.on('audit:ping', () => sa.push('A')); B.events.on('audit:ping', () => sa.push('B'));
        const wa = A.time.now('world'), wb = B.time.now('world');
        A.step(0.25, { render: false });   // world at 0.5: 0.125 s; B has not moved
        B.step(0.25, { render: false });   // world at 2: 0.5 s, B's timer due
        out.timers = { fired: [...fired], a: A.time.now('world') - wa, b: B.time.now('world') - wb };
        out.rolls = { ra, rb };
        A.events.emit('audit:ping'); out.events = [...sa];
        A.freeze('menu'); out.freeze = { a: A.frozen, b: B.frozen };
        // the keyboard is the window's: one engine owns it. The page's own engine came first, so it keeps it until another is pressed or focused
        document.body.append(A.renderer.domElement, B.renderer.domElement);
        const holds = () => [A.input.keys.has('KeyW'), B.input.keys.has('KeyW')], key = (t, code = 'KeyW') => dispatchEvent(new KeyboardEvent(t, { code }));
        const press = (el, type = 'pointerdown') => { el.setPointerCapture = () => {}; el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 })); };
        out.keys = {};
        key('keydown'); out.keys.first = holds(); out.keys.pageEngine = engine.input.keys.has('KeyW'); key('keyup');
        press(B.renderer.domElement);
        key('keydown'); out.keys.pressedB = holds();
        press(A.renderer.domElement); out.keys.heldGoes = holds();   // B held W when A took the keyboard: the keyup will go unheard as a press, so B lets go now
        key('keyup');
        key('keydown'); out.keys.pressedA = holds(); key('keyup');
        const button = B.uiRoot.appendChild(document.createElement('button'));
        button.focus(); key('keydown'); out.keys.focusedB = holds(); key('keyup'); button.remove();
        const other = document.body.appendChild(document.createElement('button'));
        press(other); key('keydown'); out.keys.outside = holds(); key('keyup'); other.remove();
        A.input.simulate('moveForward'); out.keys.simulated = holds(); A.input.simulate('moveForward', false);
        press(A.renderer.domElement);
        out.uTime = { a: A.uniforms.uTime.value, b: B.uniforms.uTime.value, same: A.uniforms.uTime === B.uniforms.uTime };
        // pointer lock: only the engine whose canvas holds it hears about it
        const got = { A: [], B: [] };
        A.events.on('page:pointerlock', d => got.A.push(d)); B.events.on('page:pointerlock', d => got.B.push(d));
        Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => held });
        const lock = el => { held = el; document.dispatchEvent(new Event('pointerlockchange')); };
        out.exitOwnA = Object.hasOwn(document, 'exitPointerLock');
        lock(A.renderer.domElement);
        out.afterLock = { a: A.page.pointerLocked, b: B.page.pointerLocked, bEvents: got.B.length };
        // the game lets go: engine's own release on A, B must not read it as anything
        document.exitPointerLock(); lock(null);
        out.afterRelease = { a: got.A.at(-1), bEvents: got.B.length };
        // A locks again and the player presses Esc: that must not look like the engine's release (no stale mark)
        lock(B.renderer.domElement); document.exitPointerLock(); lock(null);
        lock(A.renderer.domElement); lock(null);
        out.esc = got.A.at(-1);
        // B locks, A is disposed, B lets go by script: B must still tell it from Esc
        const uiCss = [...document.head.querySelectorAll('style[data-threedog="default"]')].length;
        lock(B.renderer.domElement);
        hA.remove(); A.dispose();
        key('keydown'); out.bKeyAfterA = B.input.keys.has('KeyW'); key('keyup');
        out.afterDispose = { wrapped: Object.hasOwn(document, 'exitPointerLock'), css: [...document.head.querySelectorAll('style[data-threedog="default"]')].length, cssBefore: uiCss };
        document.exitPointerLock(); lock(null);
        out.bAfterA = got.B.at(-1);
        B.step(0.25, { render: false });
        out.bAlive = { tick: B.time.tick, calls: shared.calls > 0 };
        hB.remove(); B.dispose();
        out.gone = { wrapped: Object.hasOwn(document, 'exitPointerLock'), exits };
        delete document.pointerLockElement; Document.prototype.exitPointerLock = nativeExit;
        return out;
      });
      check('seeds are each engine\'s own', r.rolls.ra[0] !== r.rolls.rb[0], show(r));
      check('world speed and timers are each engine\'s own', Math.abs(r.timers.a - 0.125) < 1e-6 && Math.abs(r.timers.b - 0.5) < 1e-6 && JSON.stringify(r.timers.fired) === '["B"]', show(r));
      check('an event stays on its bus', JSON.stringify(r.events) === '["A"]', show(r));
      check('a freeze stays on its engine', r.freeze.a === true && r.freeze.b === false, show(r));
      const only = (k, a) => JSON.stringify(k) === JSON.stringify([a, !a]);
      check('engines that join a page take nothing from the one already there', JSON.stringify(r.keys.first) === '[false,false]' && r.keys.pageEngine === true, show(r));
      check('pressing the other canvas moves the keyboard there', only(r.keys.pressedB, false), show(r));
      check('the engine that loses the keyboard lets go of what it held', JSON.stringify(r.keys.heldGoes) === '[false,false]', show(r));
      check('pressing back moves it back', only(r.keys.pressedA, true), show(r));
      check('focus inside an engine\'s UI moves it too', only(r.keys.focusedB, false), show(r));
      check('a press outside every engine leaves it where it was', only(r.keys.outside, false), show(r));
      check('code driving an engine is not the keyboard', JSON.stringify(r.keys.simulated) === '[true,false]', show(r));
      check('a key reaches the survivor once the owner went', r.bKeyAfterA === true, show(r));
      check('uTime is each engine\'s own', !r.uTime.same, show(r));
      check('the lock is heard only by the engine whose canvas holds it', r.afterLock.a === true && r.afterLock.b === false && r.afterLock.bEvents === 0, show(r));
      check('a script release reads as the engine\'s own on the engine that held the lock', r.afterRelease.a?.locked === false && r.afterRelease.a?.byEngine === true && r.afterRelease.bEvents === 0, show(r));
      check('a later Esc is not mistaken for that release', r.esc?.locked === false && r.esc?.byEngine === false, show(r));
      check('disposing one engine leaves the other\'s script release working', r.afterDispose.wrapped === true && r.bAfterA?.byEngine === true, show(r));
      check('default CSS stays while another engine lives', r.afterDispose.css === r.afterDispose.cssBefore && r.afterDispose.css > 0, show(r));
      check('the other engine keeps stepping', r.bAlive.tick > 0 && r.bAlive.calls, show(r));
      check('the last engine takes the page patch away', r.gone.wrapped === false && r.gone.exits >= 1, show(r));
    },
  },
  {
    name: 'Audit lifecycle: real-time jitter, step and skip agree on ticks, timers, channels and seeded results',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const build = async key => {
          const E = threedogThreads.mk(T.createEngine, key, { seed: 7 }), log = [];
          await E.start();
          E.time.channel('enemies');
          E.mod('time.enemies', { owner: 'bullet', mul: 0.5, for: 0.5 });
          E.clock.after(0.25, () => log.push(['real', E.time.tick]), { channel: 'real' });
          E.clock.after(0.25, () => log.push(['enemies', E.time.tick]), { channel: 'enemies' });
          E.clock.after(0.75, () => log.push(['calendar', E.time.tick]));
          E.clock.every(0.2, () => { if (E.time.tick <= 60) log.push(['every', E.time.tick]); }, { channel: 'world' });
          E.events.on('mod:end', d => log.push(['mod:end', E.time.tick, d.target]));
          let sum = 0;
          E.onFixed(() => { if (E.time.tick <= 60) sum += E.random.next?.() ?? E.random.float?.(); });
          E.onFixed(dt => { log.dtEnemies = dt; }, { channel: 'enemies' });
          E.commits.request({ apply: v => log.push(['commit', E.time.tick, v]), fallback: () => 'late', lag: 10 });
          return { E, log, sum: () => sum };
        };
        const a = await build('audit-t-a'), b = await build('audit-t-b'), c = await build('audit-t-c');
        a.E.step(1, { render: false });
        // the real loop's path with jittered frames: the same seconds in uneven slices. Frames only cut the steps differently
        let i = 0; const slices = [0.004, 0.033, 0.016, 0.051, 0.008, 0.021];
        b.E._acc = 0;
        while (b.E.time.tick < 60) { b.E._catchUp(slices[i++ % slices.length]); }
        // skip the same second: onFixed does not run, timers and timed mods do, in the same order
        await c.E.skip({ seconds: 1 });
        const freeze = { };
        const f = a.E.freeze('menu'); const t0 = a.E.time.tick, w0 = a.E.time.now('world'), u0 = a.E.time.now('ambient'); a.E.step(0.5, { render: false });
        Object.assign(freeze, { tick: a.E.time.tick - t0, world: a.E.time.now('world') - w0, ambient: a.E.time.now('ambient') - u0 }); f.remove();
        // tick, real, world, ambient after the same second
        const views = x => ({ tick: x.E.time.tick, world: +x.E.time.now('world').toFixed(6), enemies: +x.E.time.now('enemies').toFixed(6), calendar: +x.E.time.now('calendar').toFixed(6), real: +x.E.time.now('real').toFixed(6) });
        const out = { a: a.log, b: b.log, c: c.log, va: views(a), vb: views(b), vc: views(c), sa: a.sum(), sb: b.sum(), freeze };
        for (const x of [a, b, c]) x.E.dispose();
        return out;
      });
      const J = JSON.stringify;
      check('uneven frames give the same log as step', J(r.a) === J(r.b), show([r.a, r.b]));
      check('uneven frames give the same seeded sum', r.sa === r.sb, show(r));
      check('skip fires the same timers in the same order', J(r.a.filter(x => x[0] !== 'commit').map(x => x[0])) === J(r.c.filter(x => x[0] !== 'commit').map(x => x[0])), show([r.a, r.c]));
      check('step and skip reach the same views', J(r.va) === J(r.vc) && r.vc.tick === 60, show([r.va, r.vb, r.vc]));
      check('a freeze stops tick and world, ambient goes on', r.freeze.tick === 0 && r.freeze.world === 0 && r.freeze.ambient > 0.4, show(r));
    },
  },
  {
    name: 'Audit lifecycle: the actor and source of an action reach nested ops, content words, after hooks, undo and a conversation',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE, quiet = console.error; console.error = () => {};
        const E = threedogThreads.mk(T.createEngine, 'audit-actor', {});
        E.use(T.world(), T.inventory(), T.content(), T.quests({ notify: false }), T.dialogue());
        await E.start();
        const out = {};
        for (const id of ['coin', 'gem']) E.inventory.define(id, { name: id });
        E.world.add({ id: 'guard', kind: 'npc', position: { x: 0, y: 0, z: 0 } });
        E.ops.define('reward.give', { run: (e, a, ctx) => { e.inventory.of(ctx.actor).add('coin'); return [ctx.actor, ctx.source]; } });
        const seen = [];
        const buy = o => ({ ...o, run: (e, a, ctx) => { e.content.run([{ give: { gem: 1 } }]); return e.ops.run('reward.give').value; },
          after: (e, a, v, ctx) => { seen.push(['after', o.atomic ? 'atomic' : 'plain', e.ops.actor, e.ops.run('reward.give').value]); } });
        E.ops.define('shop.buy', buy({})); E.ops.define('shop.buyAtomic', buy({ atomic: true }));
        const first = E.ops.run('shop.buy', {}, { actor: 'guard', source: 'net' });
        out.first = { ...first, error: E.error }; out.buy = first.value;
        out.buyAtomic = E.ops.run('shop.buyAtomic', {}, { actor: 'guard', source: 'net' }).value;
        out.seen = seen;
        out.bags = { guard: [E.inventory.of('guard').count('coin'), E.inventory.of('guard').count('gem')], player: [E.inventory.of('player').count('coin'), E.inventory.of('player').count('gem')] };
        // undo with an actor: a nested op inside the undo acts for that actor
        E.ops.define('door.open', { run: () => 1, undo: (e, a, v, ctx) => { out.undoCtx = [ctx.actor, e.ops.actor, e.ops.run('reward.give').value]; } });
        const u = E.ops.undo('door.open', {}, 1, { actor: 'guard' });
        out.undo = u.ok;
        // can sees the same actor as run, from every entry
        E.ops.define('can.probe', { can: (e, a, ctx) => ctx.actor === 'guard' ? true : 'notGuard', run: (e, a, ctx) => ctx.actor });
        E.ops.define('nest.probe', { run: e => [e.ops.can('can.probe').ok, e.ops.run('can.probe').ok] });
        out.nested = E.ops.run('nest.probe', {}, { actor: 'guard' }).value;
        // a conversation opened for an NPC: what its choice gives is the NPC's, though the press comes from the local keys
        E.dialogue.define('offer', { start: { text: 'take it', choices: [{ text: 'yes', do: () => E.content.run([{ give: { gem: 1 } }]) }] } });
        E.ops.define('talk.open', { run: e => { e.dialogue.start('offer'); } });
        E.ops.run('talk.open', {}, { actor: 'guard' });
        E.step(1, { render: false });
        // the same on the bubble channel: the line that asks remembers who it asked
        E.dialogue.bubbleChoice = 'ask';
        E.ops.run('dialogue.choose', { index: 0 }, E.dialogue._by);
        E.ops.define('talk.bubble', { run: e => { e.dialogue.start('offer', 'start', null, { channel: 'bubble' }); } });
        E.ops.run('talk.bubble', {}, { actor: 'guard' });
        const ask = [...E.dialogue._asks.values()][0];
        out.ask = ask?.actor;
        out.talk = [E.inventory.of('guard').count('gem'), E.inventory.of('player').count('gem')];
        E.dispose(); console.error = quiet;
        return out;
      });
      const J = JSON.stringify;
      check('a choice in a conversation opened for an NPC gives to that NPC', J(r.talk) === '[3,0]', show(r));
      check('a bubble line that asks remembers the actor it opened for', r.ask === 'guard', show(r));
      check('a plain op: nested op and content word act for the actor', J(r.buy) === '["guard","net"]', show(r));
      check('an atomic op: the same', J(r.buyAtomic) === '["guard","net"]', show(r));
      check('an after hook of a plain op keeps actor and source', J(r.seen[0]) === '["after","plain","guard",["guard","net"]]', show(r));
      check('an after hook of an atomic op keeps actor and source', J(r.seen[1]) === '["after","atomic","guard",["guard","net"]]', show(r));
      check('nothing landed in the local player\'s bag', J(r.bags.player) === '[0,0]' && J(r.bags.guard) === '[4,2]', show(r));
      check('undo: ctx, ops.actor and a nested op all act for the given actor', r.undo === true && J(r.undoCtx?.slice(0, 2)) === '["guard","guard"]' && r.undoCtx?.[2]?.[0] === 'guard', show(r));
      check('can and run agree on the actor when nested', J(r.nested) === '[true,true]', show(r));
    },
  },
  {
    name: 'Audit lifecycle: a use that lands after an approach walk still acts for the actor who asked',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const p = engine.player; p.placeAt({ x: 20, z: 20 });
        const was = engine.actor; engine.actor = 'someone-else';   // the local user moved on to another body while the walk ran
        let seen = null, nested = null;
        engine.ops.define('audit.who', { run: (e, a, ctx) => ctx.actor });
        const h = engine.interactions.add({ x: 26, y: 0, z: 20 }, { id: 'audit-clerk', label: 'Talk', radius: Infinity, approach: true, onUse: () => { seen = engine.ops.actor; nested = engine.ops.run('audit.who').value; return 'served'; } });
        const res = engine.ops.run('interaction.use', { id: 'audit-clerk' }, { source: 'test', actor: 'player' });
        let settled = null; res.value?.approaching?.then(v => { settled = v; });
        for (let i = 0; i < 600 && settled === null; i++) { engine.step(1 / 60, { render: false, describe: false }); await Promise.resolve(); }
        h.remove(); engine.actor = was;
        return { ok: res.ok, settled, seen, nested };
      });
      check('ops.actor and a nested op inside the use read the asking actor', r.seen === 'player' && r.nested === 'player', show(r));
    },
  },
  {
    name: 'Audit lifecycle: shared values, control, camera and input contexts come out the same whichever holder ends first, and a player restriction survives a cutscene',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all;
        const E = threedogThreads.mk(T.createEngine, 'audit-shared', {});
        E.use(T.world(), T.characters());
        await E.start();
        E.stacks.define('audit.speed', { base: 10 });
        E.stacks.define('audit.shake', { kind: 'value', base: true });
        const P = E.stacks.get('audit.speed'), S = E.stacks.get('audit.shake');
        const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]], results = [];
        for (const order of orders) {
          const h = [E.mod('audit.speed', { owner: 'bullet', mul: 0.35 }), E.mod('audit.speed', { owner: 'stopwatch', set: 0, layer: 'effect' }), E.mod('audit.speed', { owner: 'haste', add: 5 }), E.mod('audit.speed', { owner: 'cut', set: 3, layer: 'system' })];
          const trail = [P.value()];
          for (const i of order) { h[i].remove(); trail.push(P.value()); }
          results.push({ top: trail[0], end: trail.at(-1) });
        }
        const out = { results };
        // the player's restriction: a cutscene set on the system layer cannot turn back on what settings turned off, on any end order
        const off = E.mod('audit.shake', { owner: 'player-settings', set: false, layer: 'settings' });
        const cut = E.mod('audit.shake', { owner: 'cutscene', set: true, layer: 'system' });
        out.during = S.value(); cut.remove(); out.afterCut = S.value(); off.remove(); out.afterAll = S.value();
        let raised = null; try { E.mod('audit.speed', { owner: 'p', layer: 'settings', mul: 2 }); } catch (err) { raised = err.code; } out.raised = raised;
        // control: two holders above the base, ended in both orders
        const ctl = [];
        for (const first of ['script', 'cutscene']) {
          const base = E.control.take('hero', { owner: 'keys', layer: 'base' }), s = E.control.take('hero', { owner: 'walk', layer: 'script' }), c = E.control.take('hero', { owner: 'cut', layer: 'cutscene' });
          const row = [E.control.of('hero').owner];
          (first === 'script' ? s : c).remove(); row.push(E.control.of('hero').owner);
          (first === 'script' ? c : s).remove(); row.push(E.control.of('hero').owner, base.active);
          base.remove(); row.push(E.control.of('hero')); ctl.push(row);
        }
        out.ctl = ctl;
        // camera: latest holder in charge, the earlier takes over when it ends, in both orders
        const cam = [];
        for (const order of [[0, 1], [1, 0]]) {
          const h = [E.takeCamera('photo'), E.takeCamera('cut')], row = [E.cameraOverride.owner];
          h[order[0]].remove(); row.push(E.cameraOverride?.owner); h[order[1]].remove(); row.push(E.cameraOverride); cam.push(row);
        }
        out.cam = cam;
        // input contexts ended out of order, with a gate the player set: the cutscene's end must not reopen the gate
        const inp = [];
        for (const order of [[0, 1], [1, 0]]) {
          const gate = E.input.gate('jump', 'tutorial');
          const h = [E.input.push('menu'), E.input.push('cutscene')];
          E.step(1 / 60, { render: false });
          const row = [E.input.holders.map(x => x.context).join()];
          h[order[0]].remove(); E.step(1 / 60, { render: false }); row.push(E.input.holders.map(x => x.context).join());
          h[order[1]].remove(); E.step(1 / 60, { render: false }); row.push(E.input.holders.length, E.stacks.get('input.gate').has('tutorial', 'jump'));
          gate.remove(); row.push(E.stacks.get('input.gate').has('tutorial', 'jump')); inp.push(row);
        }
        out.inp = inp;
        // a timed effect and a freeze: time left does not run down while frozen, in either end order
        const t = E.mod('time.world', { owner: 'slow', mul: 0.5, for: 0.5 }), f = E.freeze('menu'), g = E.freeze('page2');
        E.step(1, { render: false }); out.frozenLeft = E.time.scale('world');
        f.remove(); out.stillFrozen = E.frozen; g.remove(); E.step(0.6, { render: false }); out.afterFor = E.time.scale('world');
        // a value handle after a load keeps ending its own entry
        E.dispose();
        return out;
      });
      const J = JSON.stringify;
      check('every end order starts and ends on the same value', r.results.every(x => x.top === 3 && x.end === 10), show(r));
      check('settings stay off through a cutscene and after it', r.during === false && r.afterCut === false && r.afterAll === true, show(r));
      check('the settings layer cannot raise', r.raised === 'shared-settings', show(r));
      check('control comes back to the base on both end orders', J(r.ctl[0]) === '["cut","cut","keys",true,null]' && J(r.ctl[1]) === '["cut","walk","keys",true,null]', show(r));
      check('the camera comes back to the earlier holder, then the rig', J(r.cam[0]) === '["cut","cut",null]' && J(r.cam[1]) === '["cut","photo",null]', show(r));
      check('input contexts end in any order and the gate stays with its owner', r.inp.every(x => x[2] === 0 && x[3] === true && x[4] === false), show(r));
      check('a timed effect waits out a freeze, then ends', r.frozenLeft === 0.5 && r.stillFrozen === true && r.afterFor === 1, show(r));
    },
  },
  {
    name: 'Audit lifecycle: failures in undo, can, a control step, an atomic part, a commit and a start keep their rules and leave a cause',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, quiet = console.error, warn = console.warn;
        const errs = []; console.error = (...a) => errs.push(a.map(String).join(' ')); console.warn = () => {};
        const fresh = async (key, ...mods) => { const E = threedogThreads.mk(T.createEngine, key, {}); E.use(...mods); await E.start(); return E; };
        const out = {};
        // undo throws: same shape as a run that throws
        let E = await fresh('audit-e1');
        E.ops.define('bad.undo', { run: () => 1, undo: () => { throw new Error('undo broke'); } });
        const rev = E.ops.revision;
        try { out.undo = E.ops.undo('bad.undo', {}, 1); } catch (err) { out.undo = 'threw: ' + err.message; }
        out.undoError = E.error?.where ?? null; out.undoFrozen = E.frozen; out.undoRev = E.ops.revision - rev; E.dispose();
        // can throws: asked from a button, the cause must not vanish
        E = await fresh('audit-e2');
        E.ops.define('bad.can', { can: () => { throw new Error('can broke'); }, run: () => 1 });
        out.can = E.ops.can('bad.can'); out.canSaid = errs.some(s => s.includes('can broke')) || !!E.error;
        E.dispose();
        // one control step that throws does not stop the other characters' steps
        E = await fresh('audit-e3', T.world(), T.characters());
        const moved = [];
        E.control.take('a-bad', { owner: 'x', step: () => { throw new Error('step broke'); } });
        const ghost = id => ({ id, channel: 'world', move() { moved.push(id); } });
        E.control.resolveWith(id => ghost(id));
        E.control.take('b-good', { owner: 'y', step: () => ({ x: 1, z: 0 }) });
        E.step(1 / 60, { render: false });
        out.control = { moved, where: E.error?.where ?? null }; E.dispose();
        // an atomic part with nothing to save at the start: run writes, then fails
        E = await fresh('audit-e4');
        let list = ['new game'], bare = null;
        E.saves.define('auditPart', { atomic: true, save: () => list, load: d => { list = d; } });
        E.saves.define('auditBare', { atomic: true, save: () => bare, load: d => { bare = d; } });
        list = null;
        E.ops.define('bad.atomic', { atomic: true, run: () => { list = ['written']; bare = ['written']; return { ok: false, code: 'nope' }; } });
        out.atomic = { r: E.ops.run('bad.atomic').code, list, said: errs.some(s => s.includes("'auditBare' keeps what the op wrote") && s.includes('[rollback-incomplete]')) }; E.dispose();
        // a commit that throws: the others due on that step still land
        E = await fresh('audit-e5');
        const landed = [];
        E.commits.request({ lag: 1, fallback: () => 0, apply: () => { throw new Error('apply broke'); } });
        E.commits.request({ lag: 1, fallback: () => 0, apply: () => landed.push(E.time.tick) });
        const t0 = E.time.tick;
        E.step(1 / 60, { render: false });
        out.commit = { landed, due: t0 + 1, where: E.error?.where ?? null }; E.dispose();
        // an atomic op that throws in dev: rolled back, frozen with a cause, refused while frozen, after hook not run
        E = await fresh('audit-e6', T.world(), T.inventory());
        E.inventory.define('coin', { name: 'coin' });
        let after = 0;
        E.ops.define('bad.throw', { atomic: true, run: e => { e.inventory.of('player').add('coin'); throw new Error('half way'); }, after: () => { after++; } });
        const r1 = E.ops.run('bad.throw'), r2 = E.ops.run('bad.throw');
        out.halted = { r1: r1.code, r2: r2.code, coin: E.inventory.of('player').count('coin'), after, where: E.error?.where, recent: E.error?.ops?.length > 0, run: E.runState.blockedBy }; E.dispose();
        // a file that fails: the caller is told each time, and a later try is a real try, not a remembered answer
        E = await fresh('audit-e8');
        const tryLoad = () => E.assets.model('data:model/gltf-binary;base64,AAAA').then(() => 'loaded', err => err.code);
        const f1 = await tryLoad(), f2 = await tryLoad();
        out.asset = { f1, f2, failed: E.loading.list({ phase: 'failed' }).length, frozen: E.frozen }; E.dispose();
        // a non-critical init failing during start: its borrow and listeners go, start goes on, whenUsable says why
        const dummy = { x: 1 };
        E = threedogThreads.mk(T.createEngine, 'audit-e7', {});
        E.use({ name: 'flaky', install(e, ctx) { ctx.borrow(dummy, { x: 2 }); ctx.track(e.events.on('audit:flaky', () => { dummy.heard = true; })); }, async init() { await 0; throw new Error('init broke'); } });
        await E.start();
        E.events.emit('audit:flaky');
        out.init = { x: dummy.x, heard: !!dummy.heard, state: E.moduleStates.flaky, error: E.error?.where ?? null }; E.dispose();
        console.error = quiet; console.warn = warn;
        return out;
      });
      const J = JSON.stringify;
      check('an undo that throws answers like a run that throws, and names the cause', r.undo?.ok === false && r.undo?.code === 'error' && /bad\.undo/.test(r.undoError ?? ''), show(r));
      check('ops.can that throws keeps the cause', r.can?.code === 'error' && r.canSaid === true, show(r));
      check('one control step that throws leaves the next character moving and names its owner', J(r.control.moved) === '["b-good"]' && /x/.test(r.control.where ?? ''), show(r));
      check('an atomic part that had nothing goes back to its new-game data, one without any says it could not', r.atomic.r === 'nope' && r.atomic.list?.[0] === 'new game' && r.atomic.said === true, show(r));
      check('a commit that throws does not hold back the next one due', r.commit.landed[0] === r.commit.due && /commits/.test(r.commit.where ?? ''), show(r));
      check('an atomic throw rolls back, freezes with a cause, refuses, skips after', r.halted.r1 === 'error' && r.halted.r2 === 'halted' && r.halted.coin === 0 && r.halted.after === 0 && r.halted.recent && r.halted.run.includes('error'), show(r));
      check('a missing file rejects on every try and freezes nothing', r.asset.f1 === 'asset-load' && r.asset.f2 === 'asset-load' && r.asset.failed >= 1 && r.asset.frozen === false, show(r));
      check('a failed init gives back its borrow and listeners, and the module reads as failed', r.init.x === 1 && r.init.heard === false && r.init.state === 'failed', show(r));
    },
  },
  {
    name: 'Audit lifecycle: a settings row and tab a module made leave with it, its limits given back and the player\'s choice kept for its return; the game\'s rows stay',
    url: '/tests/settings/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const S = engine.settings, P = 'audit.glow.enabled', out = {}, applied = [], point = engine.stacks.define(P, { kind: 'value', save: false, settingsSet: true });
        const mod = { name: 'audit-row', type: 'rules', install(e) { e.settings.define('auditGlow', true, { apply: v => applied.push(v), limits: P }); e.settings.addSection('auditTab', { title: 'Glow', render: () => '' }); return {}; } };
        const rows = () => ({ row: S.custom.has('auditGlow'), tab: S.sections.has('auditTab'), held: point.has('settings'), value: S.get('auditGlow') });
        S.define('auditGame', true);
        engine.use(mod);
        S.set('auditGlow', false);
        out.on = rows();
        S.open(); S.current = 'auditTab'; S.win.refresh();
        engine.unuse('audit-row');
        out.left = { ...rows(), game: S.custom.has('auditGame'), showing: S.current };
        S.close();
        const calls = applied.length;
        let refused = null; try { S.set('auditGlow', true); } catch (err) { refused = err.code; }
        out.deadRow = { calls: applied.length - calls, held: point.has('settings'), refused };
        engine.use(mod);
        out.back = rows();
        // the game took the name over: the row is the game's now, whatever the module does
        S.define('auditGlow', false);
        engine.unuse('audit-row');
        out.takenOver = rows();
        S.reset('auditGlow'); S.custom.delete('auditGlow'); S.custom.delete('auditGame');
        return out;
      });
      const show = JSON.stringify(r);
      check('while the module is here its row limits and its tab shows', r.on.row && r.on.tab && r.on.held, show);
      check('the row and tab leave with it, and nothing stays held off', !r.left.row && !r.left.tab && !r.left.held, show);
      check('the game\'s row stays, and an open menu leaves the gone tab', r.left.game && r.left.showing !== 'auditTab', show);
      check('a gone row calls nothing, limits nothing and says so', r.deadRow.calls === 0 && !r.deadRow.held && r.deadRow.refused === 'settings-row', show);
      check('back again it has the player\'s choice, and applies it', r.back.row && r.back.tab && r.back.value === false && r.back.held, show);
      check('a row the game defined over it stays', r.takenOver.row, show);
    },
  },
];
