// Module ownership and shared values (docs/plans/2026-11-09-module-ownership.md, group N of the layer-2 review): the "do not bypass" checks.
//   - a closed install (failed init, unload) registers nothing more: ctx verbs after it, and a ctx.track inside a remove() of its own cleanup
//   - a borrow gives a value back only while it still holds it; a setter that throws halfway undoes the batch
//   - a module name and another module's provides cannot claim one name (requires / has / engine.<name> would reach different modules)
//   - a save restoring a shared point goes through the same check as engine.mod (value, same-layer set conflict); a failing point keeps what it had
//   - saved entries of a point not defined yet stay in the next save, shape-checked
// Each item fails on the code before group N. Run: npm test -- ownership
const PAGE = '/tests/threads/';
export const specs = [
  {
    name: 'ownership: a closed install registers nothing (after a failed init, and inside its own cleanup)',
    url: PAGE,
    expectErrors: /own boom/,   // the failed init is reported, on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        // catch a throw as { code, msg }; collect console.warn text while fn runs
        const __own = { err: f => { try { f(); return null; } catch (x) { return { code: x.code, msg: String(x.message) }; } },
          warns: f => { const said = [], w = console.warn; console.warn = (...a) => { said.push(a.join(' ')); }; try { f(); } finally { console.warn = w; } return said; } };
        const E = mk(createEngine, 'own-closed');
        E.stacks.define('ownX', { base: 1 });
        let failedCtx;
        E.use({ name: 'ownFail', init(_e, ctx) { failedCtx = ctx; throw new Error('own boom'); } });
        try { await E.start(); } catch { /* a non-critical init failure does not stop start() */ }
        out.state = E.moduleStates.ownFail;
        // a callback of the failed install resumes later: it must not leave an entry or a save part behind
        __own.warns(() => { failedCtx.mod('ownX', { set: 5 }); failedCtx.saves.define('ownFailPart', { save: () => 1, load() {} }); });
        // a rule asked by the closed ctx defines no point for good, and still answers with its default
        let rule;
        __own.warns(() => { rule = failedCtx.rule('ownRule', 'walk'); });
        out.rule = [E.stacks.has('ownRule'), rule.decide('p', {}), rule.value()];
        out.afterFail = [E.stacks.get('ownX').value(), E.stacks.get('ownX').has('ownFail'), E.saves.providers.has('ownFailPart'), failedCtx.signal.aborted];
        // during unload: a remove() that tracks something new must not file it outside this cleanup
        let late = false;
        E.use({ name: 'ownUnload', install(_e, ctx) { ctx.track({ remove() { ctx.track({ remove() { late = true; } }); } }); } });
        __own.warns(() => E.unuse('ownUnload'));
        out.unload = [late, E._modTracked.has('ownUnload')];
        // a save part of a module that ran keeps its data on unload: that judgment is not the closed state
        E.use({ name: 'ownKeep', install(_e, ctx) { ctx.saves.define('ownKeepPart', { save: () => ({ n: 7 }), load() {} }); } });
        out.keepRunning = E.moduleStates.ownKeep;
        E.unuse('ownKeep');
        out.kept = JSON.stringify(E.saves._foreign.parts.ownKeepPart ?? null);
        E.dispose();
        return out;
      });
      check('failed init: the module reads failed', r.state === 'failed', JSON.stringify(r));
      check('failed init: ctx.rule defines no shared point and answers its default', r.rule.join() === 'false,walk,walk', JSON.stringify(r.rule));
      check('failed init: its ctx no longer writes a shared point or a save part, and its signal is aborted', r.afterFail.join() === '1,false,false,true', JSON.stringify(r.afterFail));
      check('unload of a module that ran: its save part still keeps its data', r.keepRunning === 'running' && r.kept === '{"n":7}', JSON.stringify(r));
      check('unload: a handle tracked inside a remove() of the cleanup is removed at once, no new tracked set', r.unload.join() === 'true,false', JSON.stringify(r.unload));
    },
  },
  {
    name: 'ownership: an old borrow does not undo a later one; a throwing setter undoes the batch',
    url: PAGE,
    expectErrors: /own undo/,   // the setter that throws while giving back is reported, on purpose
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads, out = {};
        // catch a throw as { code, msg }; collect console.warn text while fn runs
        const __own = { err: f => { try { f(); return null; } catch (x) { return { code: x.code, msg: String(x.message) }; } },
          warns: f => { const said = [], w = console.warn; console.warn = (...a) => { said.push(a.join(' ')); }; try { f(); } finally { console.warn = w; } return said; } };
        const E = mk(createEngine, 'own-borrow');
        const obj = { v: 0 }, ctxs = {};
        for (const n of ['ownA', 'ownB', 'ownC']) E.use({ name: n, install(_e, ctx) { ctxs[n] = ctx; } });
        ctxs.ownA.borrow(obj, { v: 1 });
        obj.v = 2;                          // the game takes it over: A has lost it
        ctxs.ownB.borrow(obj, { v: 1 });    // B borrows legally, writing the same value A wrote
        E.unuse('ownA');
        out.afterA = obj.v;                 // B still holds it
        E.unuse('ownB');
        out.afterB = obj.v;                 // B gives back what it found: the game's 2
        // a batch whose second setter throws: the first property goes back, and nobody holds it
        const box = { a: 'orig' };
        Object.defineProperty(box, 'bad', { get: () => 0, set() { throw new Error('own setter'); } });
        out.threw = __own.err(() => ctxs.ownC.borrow(box, { a: 'mine', bad: 1 }))?.msg ?? null;
        out.a = box.a;
        out.free = __own.err(() => ctxs.ownC.borrow(box, { a: 'again' })) === null;
        // undoing throws too: a's setter refuses the way back, b still goes back and is free, and the error reported is c's write error
        let aWrites = 0;
        const box2 = { b: 'orig' };
        Object.defineProperty(box2, 'a', { get: () => 'x', set() { if (++aWrites > 1) throw new Error('own undo'); } });
        Object.defineProperty(box2, 'c', { get: () => 0, set() { throw new Error('own write'); } });
        out.undo = [__own.err(() => ctxs.ownC.borrow(box2, { a: 'y', b: 'mine', c: 1 }))?.msg ?? null, box2.b, __own.err(() => ctxs.ownC.borrow(box2, { b: 'again' })) === null];
        E.dispose();
        return out;
      });
      check('A ending does not undo B, which borrowed after the game took the value over', r.afterA === 1, JSON.stringify(r));
      check('B ending gives back the game\'s value', r.afterB === 2, JSON.stringify(r));
      check('undoing a batch where one setter throws again: the rest go back and are free, the write error is the one thrown', /own write/.test(r.undo[0] ?? '') && r.undo[1] === 'orig' && r.undo[2] === true, JSON.stringify(r.undo));
      check('a setter throwing halfway: the error comes through and the first property is back', /own setter/.test(r.threw ?? '') && r.a === 'orig' && r.free, JSON.stringify(r));
    },
  },
  {
    name: 'ownership: a module name and another module\'s provides cannot claim one name',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads, out = {};
        // catch a throw as { code, msg }; collect console.warn text while fn runs
        const __own = { err: f => { try { f(); return null; } catch (x) { return { code: x.code, msg: String(x.message) }; } },
          warns: f => { const said = [], w = console.warn; console.warn = (...a) => { said.push(a.join(' ')); }; try { f(); } finally { console.warn = w; } return said; } };
        const E = mk(createEngine, 'own-names');
        E.use({ name: 'ownFoo' });
        out.later = __own.err(() => E.use({ name: 'ownBar', provides: ['ownFoo'] }));
        out.batch = __own.err(() => E.use({ name: 'ownBaz', provides: ['ownQux'] }, { name: 'ownQux' }));
        out.left = [E.modules.has('ownBar'), E.modules.has('ownBaz'), E.modules.has('ownQux')];
        // still fine: a module providing its own name, and a replaces of the provider
        out.own = __own.err(() => E.use({ name: 'ownSelf', provides: ['ownSelf'] }));
        E.dispose();
        return out;
      });
      check('a later module providing an installed module\'s name is refused (module-name)', r.later?.code === 'module-name' && /ownFoo/.test(r.later.msg) && /ownBar/.test(r.later.msg), JSON.stringify(r.later));
      check('the same clash inside one use() is refused, the other order', r.batch?.code === 'module-name', JSON.stringify(r.batch));
      check('nothing of the refused calls was installed; a module providing its own name still installs', r.left.join() === 'false,false,false' && r.own === null, JSON.stringify(r));
    },
  },
  {
    name: 'ownership: a save restoring a shared point is checked like engine.mod; a defined point with damaged data refuses the whole load (save-bad-record), nothing is half restored',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        // catch a throw as { code, msg }
        const err = f => { try { f(); return null; } catch (x) { return { code: x.code, msg: String(x.message) }; } };
        const E = mk(createEngine, 'own-restore');
        const S = E.stacks;
        // ownNull is defined before ownGood: the load walks the points in definition order, so each damaged point is met before the good one
        S.define('ownHp', { base: 10 }); S.define('ownFog', { base: 100 }); S.define('ownNull', { base: 1 }); S.define('ownGood', { base: 1 });
        E.mod('ownNull', { owner: 'keep', add: 1 });
        E.mod('ownHp', { owner: 'keep', add: 5 }); E.mod('ownFog', { owner: 'keep', set: 50 });
        const good = [{ owner: 'g', op: 'mul', value: 3, layer: 'effect', left: null }];
        const damaged = {
          hp: { ownHp: [{ owner: 'bad', op: 'mul', value: 'oops', layer: 'game', left: null }] },   // a bad value
          fog: { ownFog: [{ owner: 'a', op: 'set', value: 1, layer: 'game', left: null }, { owner: 'b', op: 'set', value: 2, layer: 'game', left: null }] },   // two set owners on one layer
          nul: { ownNull: null },   // an explicit null is damage, not "no entries"
        };
        const now = () => [S.get('ownHp').value(), S.get('ownFog').value(), S.get('ownNull').value(), S.get('ownGood').value(), S.get('ownHp').names().join()];
        const before = now();
        out.before = before;
        out.threw = {}; out.same = {};
        for (const [k, d] of Object.entries(damaged)) {
          out.threw[k] = err(() => S._load({ ...S._save(), ...d, ownGood: good }));   // the rest of the save is the current state, so points met before the damaged one reload what they hold
          out.same[k] = JSON.stringify(now()) === JSON.stringify(before);
        }
        // the same damage through saves.apply: it fails and everything else rolls back too (ownHp is untouched even though its own data is fine)
        const data = E.saves.collect();
        const part = data.parts.stacks;
        out.partKeys = Object.keys(part ?? {}).join();
        const snap = JSON.stringify(now());
        const apply = async d => { const w = console.warn, said = []; console.warn = (...a) => said.push(a.join(' ')); try { return { ok: await E.saves.apply(d), said }; } finally { console.warn = w; } };
        const bad = JSON.parse(JSON.stringify(data));
        bad.parts.stacks = { ...bad.parts.stacks, ownFog: damaged.fog.ownFog, ownGood: good, ownHp: [{ owner: 'k2', op: 'add', value: 99, layer: 'game', left: null }] };
        const ap = await apply(bad);
        out.apply = { ok: ap.ok, same: JSON.stringify(now()) === snap, nan: now().some(v => typeof v === 'number' && Number.isNaN(v)) };
        // a clean save of the same shape loads: the check refuses damage only
        const fine = JSON.parse(JSON.stringify(data));
        fine.parts.stacks = { ...fine.parts.stacks, ownGood: good };
        const ok = await apply(fine);
        out.clean = { ok: ok.ok, good: S.get('ownGood').value() };
        // an UNKNOWN point with damaged data is dropped with a warning, never a reason to refuse
        const unk = JSON.parse(JSON.stringify(data));
        unk.parts.stacks = { ...unk.parts.stacks, ownGone: 'not a list' };
        const u = await apply(unk);
        out.unknown = { ok: u.ok };
        E.dispose();
        return out;
      });
      for (const k of ['hp', 'fog', 'nul']) check(`${k}: a defined point with damaged data refuses the load (save-bad-record), no point changed, no NaN`, r.threw[k]?.code === 'save-bad-record' && r.same[k], JSON.stringify([r.threw[k], r.same[k], r.before]));
      check('through saves.apply the same damage fails and rolls back, even a point with good data in the same save', r.apply.ok === false && r.apply.same && !r.apply.nan, JSON.stringify(r.apply));
      check('a clean save still loads (ownGood restored); an unknown point with bad data is dropped, not refused', r.clean.ok === true && r.clean.good === 3 && r.unknown.ok === true, JSON.stringify([r.clean, r.unknown, r.partKeys]));
    },
  },
  {
    name: 'ownership: saved entries of a point not defined yet stay in the next save',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads, out = {};
        // catch a throw as { code, msg }; collect console.warn text while fn runs
        const __own = { err: f => { try { f(); return null; } catch (x) { return { code: x.code, msg: String(x.message) }; } },
          warns: f => { const said = [], w = console.warn; console.warn = (...a) => { said.push(a.join(' ')); }; try { f(); } finally { console.warn = w; } return said; } };
        const E = mk(createEngine, 'own-pending');
        const S = E.stacks;
        __own.warns(() => S._load({ ownLater: [{ owner: 'a', op: 'add', value: 2, layer: 'game', left: null }], ownJunk: 'not a list', ownJunk2: [{ op: 'add', value: 1 }] }));
        const saved = S._save();
        out.kept = JSON.stringify(saved.ownLater ?? null);
        out.junk = ['ownJunk' in saved, 'ownJunk2' in saved];
        S.define('ownLater', { base: 1 });
        out.value = S.get('ownLater').value();
        out.after = 'ownLater' in S._pending;
        E.dispose();
        return out;
      });
      check('a point not defined yet: its saved entry is in the next save', /"owner":"a"/.test(r.kept) && /"value":2/.test(r.kept), r.kept);
      check('damaged entries of an undefined point are not carried on', r.junk.join() === 'false,false', JSON.stringify(r.junk));
      check('defining the point later applies the kept entry once', r.value === 3 && r.after === false, JSON.stringify(r));
    },
  },
];
