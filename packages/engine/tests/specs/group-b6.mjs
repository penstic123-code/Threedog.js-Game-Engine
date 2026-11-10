// Group B6-core: two async gaps a cross-change review found, one guard each (each was red on the code before its fix).
//  a. an atomic op's rollback is synchronous: an atomic save part whose load() returns a Promise is refused there (engine-misuse), as run / can / hooks are.
//     Waiting for it let the outer op of a failed nested one commit first and the pending load write the old value over it later (opsAtomic.js, saveApply.js runParts).
//  b. applyState waits for every module hook to settle before a failure goes on: the request's turn is released on that rejection, and a sibling hook still
//     running wrote over the next request's state (UrlState.js _ask).
// Run: threedog test "group B6"
const PAGE = '/tests/threads/';

/** a started throwaway engine; mods are used before start */
const BOOT = `(async (key, mods) => { const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, key, {}); if (mods) E.use(...mods); await E.start(); E.haltLoop(); return E; })`;
/** run fn with console.error muted (dev reports freeze the game and print) */
const QUIET = `(E, fn) => { const q = console.error; console.error = () => {}; try { return fn(); } finally { console.error = q; } }`;
/** clear what the report left (the freeze), then dispose */
const END = `(E) => { E.error = null; E.stacks.get('freeze').release('error'); E.dispose(); }`;

export const specs = [
  {
    name: '[guard] group B6a: an atomic part with an async load is refused at define, one whose load() returns a Promise in the rollback, and a sync part still goes back before the op returns',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, Q, END_SRC }) => {
        const E = await (0, eval)(BOOT_SRC)('b6a', null), quiet = (0, eval)(Q), end = (0, eval)(END_SRC);
        let slow = 0, plain = 0;
        // the review's probe: inner writes 1 and fails, outer writes 2 and commits
        // an async function is known at define: refused there, before any op can write
        let defineCode = null;
        try { E.saves.define('b6Async', { atomic: true, save: () => ({}), load: async () => {} }); } catch (err) { defineCode = err.code; }
        const defineKept = E.saves.providers.has('b6Async');
        // a plain function that returns a Promise is not: the rollback refuses it
        E.saves.define('b6Slow', { atomic: true, save: () => ({ v: slow }), load: d => Promise.resolve().then(() => { slow = d.v; }) });
        E.saves.define('b6Plain', { atomic: true, save: () => ({ v: plain }), load: d => { plain = d.v; } });
        E.ops.define('b6.inner', { atomic: true, run: () => { slow = 1; plain = 1; return { ok: false, code: 'no' }; } });
        E.ops.define('b6.outer', { atomic: true, run: e => { e.ops.run('b6.inner'); plain = 2; } });
        let plainAtReturn = null;
        quiet(E, () => { E.ops.run('b6.outer'); plainAtReturn = plain; });
        for (let i = 0; i < 5; i++) await new Promise(res => setTimeout(res, 0));   // what a pending part load would still do
        const out = { defineCode, defineKept, plainAtReturn, plainLater: plain, error: E.error?.code ?? null, msg: E.error?.message ?? '' };
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, Q: QUIET, END_SRC: END });
      check('an async-function atomic load is refused at define; a load returning a Promise is reported as engine-misuse naming the part and the Promise; the sync part was back before the outer op went on and the outer commit stands',
        r.defineCode === 'module-params' && r.defineKept === false && r.error === 'engine-misuse' && /b6Slow/.test(r.msg) && /Promise/.test(r.msg) && r.plainAtReturn === 2 && r.plainLater === 2, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group B6b: applyState releases its turn only after every module hook settled, so a slow sibling of a failing hook cannot write over the next request',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async ({ BOOT_SRC, END_SRC }) => {
        const tick = () => new Promise(res => setTimeout(res, 0));
        let x = null;
        const fails = { name: 'b6Fail', type: 'rules', skipKind: 'none', stateKeys: ['b6'], applyState: async (e, { b6 }) => { if (b6 === 'one') { await tick(); throw new Error('b6: hook failed'); } } };
        const slow = { name: 'b6Slow', type: 'rules', skipKind: 'none', stateKeys: ['b6'], applyState: async (e, { b6 }) => { if (b6 == null) return; if (b6 === 'one') for (let i = 0; i < 5; i++) await tick(); x = b6; } };
        const E = await (0, eval)(BOOT_SRC)('b6b', [fails, slow]), end = (0, eval)(END_SRC);
        const q = console.error; console.error = () => {};
        const a = E.applyState({ b6: 'one' }).then(() => 'resolved', () => 'rejected'), b = E.applyState({ b6: 'two' }).then(() => 'resolved', err => 'rejected ' + err?.message);
        const out = { a: await a, b: await b };
        for (let i = 0; i < 10; i++) await tick();
        console.error = q;
        out.x = x;
        end(E);
        return out;
      }, { BOOT_SRC: BOOT, END_SRC: END });
      check('the first request rejects, the second applies last: its value stands', r.a === 'rejected' && r.x === 'two', JSON.stringify(r));
    },
  },
];
