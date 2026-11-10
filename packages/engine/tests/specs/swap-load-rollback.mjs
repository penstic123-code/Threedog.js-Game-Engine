// [guard] A failed change leaves the game as it was: a replaces that fails puts back what it took out, a load that fails puts back what it wrote, and neither
// reaches over a newer change. Each check names what a game would see, so a red line reads as the bug and not as an internal.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Swap rollback: a failed replaces puts the old module back with its content and progress, in its place; a swap that would do nothing is refused',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, quests, all } = threedogThreads, out = {};
        const { inventory } = all;
        const quiet = [console.error, console.warn];
        console.error = console.warn = () => {};
        const bad = (name, provides) => ({ name, type: 'rules', provides, install() { throw new Error('bad install'); } });
        const E = mk(createEngine, 'sw-quests');
        E.use(world(), all.content(), inventory(), quests());
        await E.start();
        E.content.load({ items: { gold: { name: 'Gold' } }, startItems: { gold: 2 }, quests: { q1: { title: 'One', steps: [{ text: 'a', done: { flag: 'never' } }] } } });
        E.ops.allow(() => E.quests.start('q1'));
        const base = E.session._base;
        let msg = '';
        try { E.use(bad('badq', ['quests']), { replaces: 'quests' }); } catch (e) { msg = e.message; }
        out.q = { msg, defined: E.quests.defs.has('q1'), state: Object.keys(E.saves.collect().parts.quests?.state ?? {}), waiting: Object.keys(E.quests._saved), base: E.session._base === base };
        E.ops.allow(() => E.inventory.add('gold', 3));
        try { E.use(bad('badi', ['inventory']), { replaces: 'inventory' }); } catch { /* the swap fails, that is the point */ }
        out.bag = { gold: E.inventory.count('gold'), item: !!E.inventory.def?.('gold') };
        E.dispose();

        const A = mk(createEngine, 'sw-pair');
        const order = [];
        const mod = (name, o = {}) => ({ name, type: 'rules', fixed() { order.push(name); }, install() {}, ...o });
        A.use(mod('first'), mod('sb', { provides: ['b'] }), mod('mid'), mod('sa', { provides: ['a'], requires: ['b'] }), mod('last'));
        await A.start();
        const was = [...A.modules.keys()];
        msg = '';
        try { A.use(bad('both', ['a', 'b']), { replaces: ['a', 'b'] }); } catch (e) { msg = e.message; }
        A.step(1 / 60, { render: false });
        out.pair = { msg, was, now: [...A.modules.keys()], ran: order };
        A.dispose();

        const S = mk(createEngine, 'sw-same');
        S.use(mod('x'), mod('holder', { provides: ['slot'] }));
        const code = f => { try { f(); return null; } catch (e) { return e.code ?? e.message; } };
        out.same = { code: code(() => S.use(mod('x', { provides: ['slot'] }), { replaces: 'slot' })), holder: S.has('holder'), x: !S.modules.get('x').provides };
        out.self = { code: code(() => S.use(mod('holder', { provides: ['slot'] }), { replaces: 'slot' })), holder: S.has('holder') };
        S.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('the failed swap throws the newcomer\'s error', /bad install/.test(r.q.msg), J(r.q));
      check('content quests are defined again', r.q.defined, J(r.q));
      check('progress is on the quest again, nothing left waiting for a definition', r.q.state.includes('q1') && r.q.waiting.length === 0, J(r.q));
      check('the new-game state is what it was', r.q.base, J(r.q));
      check('the bag has what it had: saved goods back, starting goods not given again', r.bag.gold === 5, J(r.bag));
      check('replaces of two modules, one requiring the other: both come back, in their old places', r.pair.now.join() === r.pair.was.join() && /bad install/.test(r.pair.msg), J(r.pair));
      check('... and run in their old order', r.pair.ran.join() === 'first,sb,mid,sa,last', J(r.pair));
      check('a newcomer whose name is taken by a module that does not hold the slot is refused, the holder stays', r.same.code === 'module-replaces' && r.same.holder && r.same.x, J(r.same));
      check('a newcomer named like the holder still swaps', r.self.code === null && r.self.holder, J(r.self));
    },
  },
  {
    name: '[guard] Load rollback: a part with no data before the load goes back to its new-game state; a taken-over load leaves the newer one alone; a swap never locks new game',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        const quiet = [console.error, console.warn];
        console.error = console.warn = () => {};
        const save = (parts, versions = {}) => ({ format: 1, savedAt: 0, versions, parts });

        // a part whose save() gave nothing just before the load, then a later part fails it
        const R = mk(createEngine, 'sw-gap');
        const st = { v: 'start', none: false, thrower: 'start', throwing: false, empty: null };
        R.use({ name: 'gap', type: 'rules', install(e, ctx) {
          ctx.saves.define('gap', { save: () => st.none ? null : { v: st.v }, load: d => { st.v = d.v; } });
          ctx.saves.define('thrower', { save: () => { if (st.throwing) throw new Error('save boom'); return { v: st.thrower }; }, load: d => { st.thrower = d.v; } });
          ctx.saves.define('empty', { save: () => st.empty == null ? null : { v: st.empty }, load: d => { st.empty = d.v; } });
          ctx.saves.define('zboom', { save: () => ({ n: 1 }), load: d => { if (d.bad) throw new Error('load boom'); } });
        } });
        await R.start();
        const said = [];
        console.error = console.warn = (...a) => said.push(a.map(String).join(' '));
        st.none = true; st.throwing = true; st.v = 'play'; st.thrower = 'play';
        const ok = await R.saves.apply(save({ gap: { v: 'failed' }, thrower: { v: 'failed' }, empty: { v: 'failed' }, zboom: { bad: true } }));
        console.error = console.warn = () => {};
        out.gap = { ok, v: st.v, thrower: st.thrower, empty: st.empty, named: said.some(s => s.includes("'empty'")) };
        R.dispose();

        // saves.apply(A) with afterLoad, a listener throws, saves.apply(B) on the next line
        const T = mk(createEngine, 'sw-over');
        const t = { v: 0, loaded: [] };
        T.use({ name: 'over', type: 'rules', afterLoad() {}, install(e, ctx) {
          ctx.saves.define('over', { save: () => ({ v: t.v }), load: d => { t.v = d.v; } });
        } });
        await T.start();
        T.events.on('sw:boom', () => { throw new Error('listener boom'); });
        T.events.on('save:loaded', s => t.loaded.push(s));
        const heard = [], on = T.events.onError;
        T.events.onError = (n, e) => heard.push(e.message);
        const a = T.saves.apply(save({ over: { v: 1 } }));
        T.events.emit('sw:boom');
        const b = T.saves.apply(save({ over: { v: 2 } }));
        await Promise.all([a, b]);
        out.over = { v: t.v, heard };
        T.events.onError = on;
        t.v = 10; await T.saves.save('sa');
        t.v = 20; await T.saves.save('sb');
        t.loaded.length = 0;   // the applies above announced themselves: saves.apply says save:loaded too
        await Promise.all([T.saves.load('sa'), T.saves.load('sb')]);
        out.loads = { v: t.v, loaded: t.loaded };
        T.dispose();

        // a late swap to a part of a lower version: the new-game state must stay readable
        const V = mk(createEngine, 'sw-ver');
        const giver = (name, version, migrate) => ({ name, type: 'rules', provides: ['vslot'], install(e, ctx) {
          ctx.saves.define('vpart', { version, migrate, save: () => ({ by: name }), load() {} });
        } });
        V.use(giver('old', 3, { 1: d => d, 2: d => d }));
        await V.start();
        V.use(giver('mine', 1, {}), { replaces: 'vslot' });
        out.ver = { newGame: await V.session.newGame(), quit: await V.session.quit(), base: JSON.parse(V.session._base).versions.vpart };
        V.dispose();

        // session:start runs inside the turn, and its listeners are in play: playing reads true there (session.js _busy)
        const P = mk(createEngine, 'sw-play');
        await P.start();
        const seen = {};
        P.events.on('session:end', () => { seen.end = P.session.playing; });
        P.events.on('session:start', () => { seen.start = P.session.playing; });
        await P.session.newGame();
        out.playing = seen;
        P.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('a failed load is reported as failed', r.gap.ok === false, J(r.gap));
      check('a part whose save() gave nothing goes back to its new-game state, not the failed save\'s', r.gap.v === 'start', J(r.gap));
      check('... the same for a part whose save() threw', r.gap.thrower === 'start', J(r.gap));
      check('a part with nothing to go back to is named, not silent', r.gap.named, J(r.gap));
      check('a listener error of a taken-over load does not roll back over the newer load', r.over.v === 2, J(r.over));
      check('... and is still reported', r.over.heard.includes('listener boom'), J(r.over));
      check('a taken-over saves.load announces nothing, the newer one does', r.loads.v === 20 && r.loads.loaded.join() === 'sb', J(r.loads));
      check('after a late swap to a lower version, new game and quit work', r.ver.newGame === true && r.ver.quit === true && r.ver.base === 1, J(r.ver));
      check('session.playing: false in session:end, true in session:start', r.playing.end === false && r.playing.start === true, J(r.playing));
    },
  },
  {
    name: '[guard] Borrow: one holder per property, a second is refused naming shared points, in any order of ending; setPixelSize(null) leaves a ratio the game took',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        const E = mk(createEngine, 'sw-borrow'), obj = { v: 0, w: 0 };
        let a, b;
        E.use({ name: 'lenderA', type: 'rules', install(e, ctx) { a = ctx; } }, { name: 'lenderB', type: 'rules', install(e, ctx) { b = ctx; } });
        const first = a.borrow(obj, { v: 1 });
        try { b.borrow(obj, { w: 7, v: 2 }); } catch (err) { out.refused = { code: err.code, msg: err.message, v: obj.v, w: obj.w }; }
        const none = (() => { try { a.borrow(obj, { v: 3 }); return true; } catch { return false; } })();
        out.sameModule = !none;
        first.remove();
        out.ended = obj.v;
        const again = b.borrow(obj, { v: 2 });   // free again
        out.again = obj.v;
        obj.v = 5;   // the game took it: that borrow has nothing left, so a new one holds it, and both ends leave the game's value
        const third = a.borrow(obj, { v: 6 });
        again.remove(); out.oldEnd = obj.v;
        third.remove(); out.after = obj.v;
        a.borrow(obj, { v: 8 });
        E.unuse('lenderA');
        out.gone = obj.v;
        b.borrow(obj, { v: 9 }).remove();   // a module leaving frees what it held
        E.dispose();
        const P = mk(createEngine, 'sw-pixel', { pixelSize: 2 });
        await P.start();
        P.renderer.setPixelRatio(0.75);
        P.step(1 / 60);
        P.setPixelSize(null);
        out.ratio = P.renderer.getPixelRatio();
        P.dispose();
        return out;
      });
      check('a second borrow of a held property is refused, names the holder and engine.mod, and writes nothing', r.refused?.code === 'module-handle' && /lenderA/.test(r.refused.msg) && /engine\.mod/.test(r.refused.msg) && r.refused.v === 1 && r.refused.w === 0, J(r));
      check('the same module too', r.sameModule, J(r));
      check('ending gives the original back, and the property is free again', r.ended === 0 && r.again === 2, J(r));
      check('a value the game took ends the old borrow: the next holder restores it, the old end changes nothing', r.oldEnd === 6 && r.after === 5, J(r));
      check('a module leaving gives back and frees', r.gone === 5, J(r));
      check('setPixelSize(null) keeps the ratio the game wrote', r.ratio === 0.75, J(r));
    },
  },
];
