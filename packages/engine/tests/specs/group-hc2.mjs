// Group HC2 (docs/plans/research/2026-11-10-health-check-a.md, GPT part 2 finding 1): a callback whose contract is synchronous must not return a Promise.
// One test item per guarded contract, so reverting one guard turns only its own item red. The contracts that accept async on purpose (module init, a save part's
// load / afterLoad, flow.transition) have a last item that keeps them working.
const PAGE = '/tests/threads/';

/** a started throwaway engine; mods are used before start */
const BOOT = `(async (key, mods) => { const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, key, {}); if (mods) E.use(...mods); await E.start(); E.haltLoop(); return E; })`;
/** run fn with console.error muted (dev reports freeze the game and print) */
const QUIET = `(E, fn) => { const q = console.error; console.error = () => {}; try { return fn(); } finally { console.error = q; } }`;
/** clear what the report left (the freeze), then dispose */
const END = `(E) => { E.error = null; E.stacks.get('freeze').release('error'); E.dispose(); }`;

export const specs = [
  {
    name: '[guard] group HC2a: an async op run is an error: the op fails, an atomic op is rolled back, the Promise is not awaited',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2a', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        let bare = 'before';
        E.saves.define('hcBare', { atomic: true, save: () => bare, load: d => { bare = d; } });
        E.ops.define('hc2.async', { atomic: true, run: async () => { bare = 'written'; await 0; } });
        const res = quiet(E, () => E.ops.run('hc2.async'));
        await new Promise(r => setTimeout(r, 20));
        const out = { ok: res.ok, code: res.code, bare, error: E.error?.code ?? null, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('the run fails (not ok), the write before the first await is undone, the error names the op and the Promise', r.ok === false && r.code === 'error' && r.bare === 'before' && r.error === 'engine-misuse' && /ops\.run\('hc2\.async'\)/.test(r.msg) && /Promise/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2b: an async onFrame hook is reported as an engine error naming the callback',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2b', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        E.onFrame(async () => {});
        quiet(E, () => E.step(1 / 60, { render: false }));
        const out = { error: E.error?.code ?? null, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('engine.error is engine-misuse and says the onFrame callback returned a Promise', r.error === 'engine-misuse' && /onFrame callback returned a Promise/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2c: an async frame hook of a module is reported with the module name',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2c', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        quiet(E, () => { E.use({ name: 'hc2mod', frame: async () => {} }); E.step(1 / 60, { render: false }); });
        const out = { error: E.error?.code ?? null, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('the error names module hc2mod and the Promise', r.error === 'engine-misuse' && /hc2mod/.test(r.msg) && /Promise/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2d: an async onRender hook is reported',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2d', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        E.onRender(async () => {});
        quiet(E, () => E.step(1 / 60));
        const out = { error: E.error?.code ?? null, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('engine.error is engine-misuse naming the onRender callback', r.error === 'engine-misuse' && /onRender callback returned a Promise/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2e: an async install() makes engine.use throw and installs nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc2e', null);
        let err = null; try { E.use({ name: 'hc2inst', install: async () => ({}) }); } catch (x) { err = x; }
        const out = { code: err?.code ?? null, msg: err?.message ?? '', has: E.has('hc2inst') };
        E.dispose();
        return out;
      }, BOOT);
      check('use() throws engine-misuse naming install() of hc2inst; the module is not left installed', r.code === 'engine-misuse' && /install\(\) of module hc2inst/.test(r.msg) && r.has === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2f: an async dispose() of a module is reported when the module leaves',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc2f', null);
        E.use({ name: 'hc2disp', dispose: async () => {} });
        const seen = []; const q = console.error; console.error = (...a) => seen.push(String(a[0]));
        try { E.unuse('hc2disp'); } finally { console.error = q; }
        const out = { seen: seen.some(s => /hc2disp/.test(s)), has: E.has('hc2disp') };
        E.dispose();
        return out;
      }, BOOT);
      check('the unuse reports the dispose() Promise (soft: the module is still removed)', r.seen && r.has === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2g: an async listener running inside a load fails the load; the same listener outside a load is left alone',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2g', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        let ran = 0;
        E.events.on('hc2:ping', async () => { ran++; });
        E.saves.define('hcPing', { atomic: true, save: () => 1, load: () => { E.events.emit('hc2:ping'); } });
        quiet(E, () => E.events.emit('hc2:ping'));   // outside a load: fine
        const outside = { ran, error: E.error?.code ?? null };
        let loadErr = null, res = null;
        const q = console.error; console.error = () => {};
        try { res = await E.saves.apply(E.saves.collect(), 'hc2g'); } catch (x) { loadErr = x?.message ?? String(x); } finally { console.error = q; }
        const out = { outside, loadErr, res, inside: ran, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('outside a load nothing is reported', r.outside.ran === 1 && r.outside.error === null, JSON.stringify(r));
      check('inside a load the listener fails the load, naming the event', r.inside >= 2 && r.res === false && /listener of 'hc2:ping' inside a load/.test(r.msg + r.loadErr), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2i: an async op can() is never "allowed": ops.run and ops.can both refuse it',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2i', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        let ran = 0;
        E.ops.define('hc2.cant', { can: async () => true, run: () => { ran++; } });
        const asked = quiet(E, () => E.ops.can('hc2.cant'));
        const res = quiet(E, () => E.ops.run('hc2.cant'));
        const out = { asked: asked.ok, ok: res.ok, ran, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('can() that returns a Promise: neither allowed nor run, and the error names the op', r.asked === false && r.ok === false && r.ran === 0 && /can\(\) of op 'hc2\.cant'/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2j: an async op after() hook is reported like any hook',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2j', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        E.ops.define('hc2.aft', { run: () => 1, after: async () => {} });
        const res = quiet(E, () => E.ops.run('hc2.aft'));
        const out = { ok: res.ok, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('the op itself succeeded, the after Promise is reported naming the op', r.ok === true && /ops\.run\('hc2\.aft'\) after returned a Promise/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2k: an async content word run is an error thrown after the other words ran',
    url: PAGE,
    async run({ check }) {
      // Node side: runWords takes the word table as data, so no page is needed
      const { runWords } = await import('../../modules/content/words.js');
      let second = 0, err = null;
      const words = { get: k => ({ raw: true, run: k === 'slow' ? async () => {} : () => { second++; } }) };
      try { runWords({}, {}, words, [{ slow: 1 }, { quick: 1 }], null); } catch (x) { err = x; }
      check('the word that returned a Promise throws a coded error naming it; the word beside it still ran', err?.code === 'engine-misuse' && /content word \{ slow \}/.test(err.message) && second === 1, String(err?.message));
    },
  },
  {
    name: '[guard] group HC2l: an async dispose() of a module that is rolled back after a failed use() is reported',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc2l', null);
        const seen = []; const q = console.error; console.error = (...a) => seen.push(String(a[0]));
        let err = null;
        try { E.use({ name: 'hc2first', dispose: async () => {} }, { name: 'hc2bad', install() { throw new Error('boom'); } }); } catch (x) { err = x.message; } finally { console.error = q; }
        const out = { err, seen: seen.some(s => /dispose\(\) of module hc2first after its install failed/.test(s)), has: E.has('hc2first') };
        E.dispose();
        return out;
      }, BOOT);
      check('the failed use() still throws boom, and the rolled-back module\'s async dispose is reported', r.err === 'boom' && r.seen && r.has === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2m: a plain (non-atomic) op may return a Promise as its value: interaction.use with an async onUse, and a photo.trace-shaped op',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        engine.player.placeAt({ x: 20, z: 20 });
        let done = false;
        const h = engine.interactions.add({ x: 20.5, y: 0, z: 20 }, { id: 'hc2-clerk', label: 'Talk', radius: Infinity, onUse: async () => { await 0; done = true; return 'served'; } });
        const res = engine.ops.run('interaction.use', { id: 'hc2-clerk' }, { source: 'test', actor: 'player' });
        const awaited = await res.value;
        h.remove();
        // photo.trace is `run: (_, a) => ph.trace(a)` with trace an async method: the same shape, without a path tracer
        engine.ops.define('hc2.traceLike', { run: () => (async () => 'shot')() });
        const t = engine.ops.run('hc2.traceLike');
        return { ok: res.ok, done, awaited: JSON.stringify(awaited), tok: t.ok, tval: await t.value, error: engine.error?.message ?? null };
      });
      check('both ops are ok with a Promise value that resolves, and no engine error', r.ok && r.done && r.tok && r.tval === 'shot' && r.error === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2n: an async once-listener inside a load fails the load like an on-listener; photo\'s own save:imported listener returns nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('hc2n', null), end = (0, eval)(END_SRC);
        E.events.once('hc2:once', async () => {});
        E.saves.define('hcOnce', { atomic: true, save: () => 1, load: () => { E.events.emit('hc2:once'); } });
        const q = console.error; console.error = () => {};
        let res = null; try { res = await E.saves.apply(E.saves.collect(), 'hc2n'); } finally { console.error = q; }
        const out = { res, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('the once-listener Promise fails the load, naming the event', r.res === false && /listener of 'hc2:once' inside a load/.test(r.msg), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2o: photo\'s save:imported listener is fire-and-forget: it does not fail a load that is running while a save file is imported',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, END_SRC }) => {
        const T = threedogThreads.all, E = await (0, eval)(BOOT_SRC)('hc2o', [T.photo()]), end = (0, eval)(END_SRC);
        E.saves.define('hcImp', { atomic: true, save: () => 1, load: () => { E.events.emit('save:imported', 'x'); } });
        const res = await E.saves.apply(E.saves.collect(), 'hc2o');
        const out = { res, error: E.error?.message ?? null };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, END_SRC: END });
      check('the load succeeds', r.res !== false && r.error === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2p: an async dispose() of a module is reported when the whole engine is disposed',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc2p', null);
        E.use({ name: 'hc2edisp', dispose: async () => {} });
        const seen = []; const q = console.error; console.error = (...a) => seen.push(String(a[0]));
        try { E.dispose(); } finally { console.error = q; }
        return { seen: seen.some(s => /hc2edisp/.test(s)) };
      }, BOOT);
      check('engine.dispose reports the dispose() Promise (soft: the rest still disposes)', r.seen, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC2h: the contracts that accept async still do: module init and a save part load are awaited',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'hc2h', {});
        let inited = false, loaded = null;
        E.use({ name: 'hc2init', init: async () => { await new Promise(r => setTimeout(r, 10)); inited = true; } });
        E.saves.define('hcAsyncPart', { save: () => 7, load: async d => { await 0; loaded = d; } });
        await E.start(); E.haltLoop();
        await E.saves.apply(E.saves.collect(), 'hc2h');
        const out = { inited, loaded, err: E.error?.code ?? null };
        E.dispose();
        return out;
      });
      check('start waited for the async init, the load for the async part, and no error was reported', r.inited && r.loaded === 7 && r.err === null, JSON.stringify(r));
    },
  },
];
