// Second review, saves and streaming: probes through public API. Failing items are real findings, see the review report.
export const specs = [
  {
    name: '[guard] teleport: a door trip still loading when the player retries does not move the player in the new playthrough',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const start = engine.player.position.toArray();
        // a far destination keeps the trip open for at least the frames the new game takes
        const trip = engine.stream.teleport([start[0] + 900, 0, start[2] + 900], { timeout: 30 }).then(() => 'landed', e => e.code ?? e.message);
        await engine.session.newGame();
        const home = engine.player.position.toArray();
        for (let i = 0; i < 240; i++) { engine.step(1 / 60); await Promise.resolve(); }
        const out = await Promise.race([trip, new Promise(r => setTimeout(() => r('open'), 500))]);
        return { out, home, after: engine.player.position.toArray() };
      });
      check('the new playthrough keeps the player at its own start', Math.hypot(r.after[0] - r.home[0], r.after[2] - r.home[2]) < 50, JSON.stringify(r));
      check('the trip says it was abandoned, so the code after it does not run', r.out === 'stream-removed', JSON.stringify(r));
    },
  },
  {
    name: '[guard] teleport: a quick load during the trip abandons it as a new game does',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.saves.save('r2-trip');
        const start = engine.player.position.toArray();
        const trip = engine.stream.teleport([start[0] + 900, 0, start[2] + 900], { timeout: 30 }).then(() => 'landed', e => e.code ?? e.message);
        await engine.saves.load('r2-trip');
        const home = engine.player.position.toArray();
        for (let i = 0; i < 240; i++) { engine.step(1 / 60); await Promise.resolve(); }
        const out = await Promise.race([trip, new Promise(r => setTimeout(() => r('open'), 500))]);
        return { out, home, after: engine.player.position.toArray(), sources: engine.stream.sources().map(s => s.name) };
      });
      check('the player stays where the load put it', Math.hypot(r.after[0] - r.home[0], r.after[2] - r.home[2]) < 50, JSON.stringify(r));
      check('the trip ended and left no source behind', r.out === 'stream-removed' && !r.sources.includes('teleport'), JSON.stringify(r));
    },
  },
  {
    name: '[guard] flow: a transition still fading out when a new game goes through never runs its scene swap',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        let ran = 0;
        const p = engine.flow.transition(() => { ran++; }, { fade: 0.2, autosave: false });
        await engine.session.newGame();
        for (let i = 0; i < 20; i++) { engine.step(0.05, { render: false }); await tick(); }
        await p;
        // a queued transition follows one whose fn replaces the level (it moves the epoch): both run
        let after = 0;
        const q = [engine.flow.transition(() => { after++; engine.commits.invalidate(); }, { fade: 0.01, autosave: false }), engine.flow.transition(() => { after++; }, { fade: 0.01, autosave: false })];
        for (let i = 0; i < 40; i++) { engine.step(0.05, { render: false }); await tick(); }
        await Promise.all(q);
        return { ran, after, unlocked: engine.input.enabled, transitioning: engine.flow.transitioning };
      });
      check('the old swap did not land, the screen and input came back, the next ones run', r.ran === 0 && r.after === 2 && r.unlocked && !r.transitioning, JSON.stringify(r));
    },
  },
  {
    name: '[guard] skip: a quick load during the fade out cancels the skip, on the page without flow',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        await engine.saves.save('r2-skip');
        const flow = !!engine.flow;
        const p = engine.skip({ seconds: 60, fade: 0.2 });
        await engine.saves.load('r2-skip');
        for (let i = 0; i < 40; i++) { engine.step(0.05, { render: false }); await tick(); }
        return { flow, out: await p };
      });
      check('this page has no flow, so skip goes through its own fade', r.flow === false, JSON.stringify(r));
      check('the skip resolves null and moved nothing', r.out === null, JSON.stringify(r));
    },
  },
  {
    name: 'review2 guard: junk in each save part is refused or harmless',
    url: '/?threedog-headless',
    expectErrors: /./,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, base = S.collect(), bad = {}, keys = Object.keys(base.parts);
        const junk = [{}, [], 5, 'x', true];
        const clear = () => { engine.error = null; engine.stacks.get('freeze').release('error'); };
        for (const k of keys) for (const j of junk) {
          const d = structuredClone(base); d.parts[k] = j;
          let ok, threw = null;
          try { ok = await S.apply(d, 'fuzz'); } catch (e) { threw = e.message; }
          let after = null, saveErr = null;
          try { for (let i = 0; i < 5; i++) engine.step(1 / 60); after = JSON.stringify(S.collect().parts[k]); } catch (e) { saveErr = e.message; }
          const err = engine.error?.message ?? null;
          const tag = k + '=' + JSON.stringify(j);
          if (threw || saveErr || (ok === true && err)) bad[tag] = { ok, threw, saveErr, err: err?.slice(0, 110) };
          clear();
          await S.apply(structuredClone(base), 'fuzz-back'); clear();
        }
        return { n: keys.length, bad };
      });
      check('no part breaks the game on junk (' + r.n + ' parts)', !Object.keys(r.bad).length, JSON.stringify(r.bad).slice(0, 1200));
    },
  },
  {
    name: '[guard] saves: a delete the store refused leaves the list showing what the disk holds',
    url: '/?threedog-headless',
    expectErrors: /failed to write/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves;
        await S.save('r2-del');
        const del = S.store.deleteSlot;
        S.store.deleteSlot = () => Promise.reject(new DOMException('nope', 'UnknownError'));
        await S.remove('r2-del');
        S.store.deleteSlot = del;
        return { listed: S.list().some(s => s.slot === 'r2-del'), onDisk: !!(await S.store.getSlot('r2-del')) };
      });
      check('list agrees with the store after a failed delete', r.listed === r.onDisk, JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves: a NaN inside a part refuses the save as a NaN at the top of the part does',
    url: '/?threedog-headless',
    expectErrors: /save part/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves; let got;
        const h = S.define('r2nan', { save: () => ({ hp: NaN, pos: [Infinity, 0, 0] }), load: d => { got = d; } });
        const ok = await S.save('r2-nan');
        const said = engine.error?.message ?? '';
        const loaded = await S.load('r2-nan');
        h.remove({ keep: false }); engine.error = null; engine.stacks.get('freeze').release('error');
        return { ok, loaded, got, said: said.slice(0, 200) };
      });
      check('the save is refused, so the player never gets hp null back', r.ok === false && r.loaded === false && r.got === undefined, JSON.stringify(r));
      check('the message names the part and the path', /r2nan/.test(r.said) && /hp/.test(r.said), JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves: a part named like an Object method registers, saves and loads',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves;
        try {
          const got = {}, hs = ['constructor', 'toString'].map(k => S.define(k, { save: () => ({ a: 1 }), load: d => { got[k] = d.a; } }));
          await S.save('r2-ctor');
          const part = JSON.parse(S._json.get('r2-ctor'));
          // the same save with these two left out of the versions table: each reads as version 1, not as Object's own constructor
          const bare = structuredClone(part); delete bare.versions.constructor; delete bare.versions.toString;
          const loaded = await S.load('r2-ctor') && await S.apply(bare);
          hs.forEach(h => h.remove({ keep: false }));
          return { saved: Object.hasOwn(part.parts, 'constructor') && Object.hasOwn(part.parts, 'toString'), loaded, got };
        } catch (e) { return { threw: e.message.slice(0, 100) }; }
      });
      check('saved and loaded back', r.saved === true && r.loaded === true && r.got?.constructor === 1 && r.got?.toString === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] stream: a longer view distance from the settings menu builds what it now reaches without the player moving',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const p = engine.player.position, st = engine.stream, was = engine.uniforms.uViewDistance.value;
        const R = st.activeRadius, had = st.radius;
        let built = 0;
        const h = st.add({ position: [p.x + R + 30, 0, p.z], build: () => { built++; return null; } });
        for (let i = 0; i < 5; i++) engine.step(1 / 60);
        const before = built;
        engine.uniforms.uViewDistance.value = was + 200;
        const follows = st.activeRadius > R;
        for (let i = 0; i < 5; i++) engine.step(1 / 60);
        const out = { before, after: built, follows, R, had };
        h.remove(); engine.uniforms.uViewDistance.value = was;
        return out;
      });
      if (!r.follows) { check('skipped: this page takes its radius from elsewhere', true); return; }
      check('built once in reach', r.before === 0 && r.after === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] flow: a transition still in line when a new game goes through is dropped, without a fade of its own',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const starts = []; engine.events.on('flow:transition', x => { if (x.phase === 'start') starts.push(x); });
        let ran = 0;
        const q = [engine.flow.transition(() => { ran++; }, { fade: 0.2, autosave: false }), engine.flow.transition(() => { ran++; }, { fade: 0.2, autosave: false })];
        await engine.session.newGame();
        for (let i = 0; i < 40; i++) { engine.step(0.05, { render: false }); await tick(); }
        await Promise.all(q);
        return { ran, starts: starts.length, unlocked: engine.input.enabled };
      });
      check('neither swap landed and the one in line never started', r.ran === 0 && r.starts === 1 && r.unlocked, JSON.stringify(r));
    },
  },
  {
    name: '[guard] flow music: the track comes back after a scene swap, not after a new game the swap started',
    url: '/tests/threads/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, { createEngine } = T, tick = () => new Promise(r => setTimeout(r, 0));
        const E = mk(createEngine, 'r2-music');
        E.use(T.flow(), T.music({ tracks: { a: '/none.ogg' } })); await E.start(); E.haltLoop();
        const turn = async fn => { const p = E.flow.transition(fn, { fade: 0.01, autosave: false }); for (let i = 0; i < 30; i++) { E.step(0.05, { render: false }); await tick(); } await p; };
        const track = () => E.music.current ?? E.music.pending;
        E.music.play('a'); const asked = track();
        await turn(() => { E.music.stop({ fade: 0 }); });   // a swap that is not a replacement, a level.load nobody awaits included: the track resumes
        const swap = track();
        E.music.play('a');
        await turn(() => E.session.newGame());
        const fresh = track();
        E.dispose();
        return { asked, swap, fresh };
      });
      check('the page plays the track', r.asked === 'a', JSON.stringify(r));
      check('a plain swap resumes it', r.swap === 'a', JSON.stringify(r));
      check('a new game has no old track', r.fresh == null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] teleport: a trip that came ready during a load that failed lands once the rollback ended',
    url: '/tests/threads/',
    expectErrors: /r2fail/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        // a page with no physics: readiness needs frames only, so the destination can come ready under the load's freeze
        const { mk } = threedogThreads, { createEngine } = threedogThreads.all, E = mk(createEngine, 'r2-trip'); await E.start(); E.haltLoop();
        const S = E.saves, tick = () => new Promise(r => setTimeout(r, 0)); let boom = false, open = null;
        const h = S.define('r2fail', { save: () => ({ boom }), load: async d => { if (d.boom) { await new Promise(r => { open = r; }); throw new Error('r2fail'); } } });
        boom = true; await S.save('r2-tf'); boom = false;
        const to = [E.focus.x + 3, 0, E.focus.z], p = E.focus.toArray();
        const trip = E.stream.teleport(to, { timeout: 30 }).then(() => 'landed', e => e.code ?? e.message);
        const load = S.load('r2-tf');
        const midLoad = S.replacing;
        for (let i = 0; i < 30; i++) { E.step(1 / 60, { render: false }); await tick(); }
        const moved = Math.hypot(E.focus.x - p[0], E.focus.z - p[2]), early = await Promise.race([trip, tick().then(() => 'open')]);
        open(); const ok = await load;
        E.error = null; E.stacks.get('freeze').release('error');
        for (let i = 0; i < 30; i++) { E.step(1 / 60, { render: false }); await tick(); }
        const out = await Promise.race([trip, new Promise(r => setTimeout(() => r('open'), 500))]);
        const end = Math.hypot(E.focus.x - to[0], E.focus.z - to[2]);
        h.remove({ keep: false }); E.dispose();
        return { midLoad, moved, early, ok, out, end };
      });
      check('the load was under way and failed', r.midLoad === true && r.ok === false, JSON.stringify(r));
      check('nothing moved while the state was being replaced, and the trip stayed open', r.moved < 0.01 && r.early === 'open', JSON.stringify(r));
      check('the trip landed afterwards', r.out === 'landed' && r.end < 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] teleport: a save part whose load awaits a trip does not wait for itself',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, { createEngine } = threedogThreads.all, E = mk(createEngine, 'r2-own'); await E.start(); E.haltLoop();
        const S = E.saves, to = [E.focus.x + 3, 0, E.focus.z]; let go = false;
        const h = S.define('r2own', { save: () => ({ go }), load: async d => { if (d.go) await E.stream.teleport(to, { timeout: 30 }); } });
        go = true; await S.save('r2-own'); go = false;
        let done = null; S.load('r2-own').then(v => { done = v; });
        for (let i = 0; i < 120 && done === null; i++) { E.step(1 / 60, { render: false }); await new Promise(r => setTimeout(r, 0)); }
        const end = Math.hypot(E.focus.x - to[0], E.focus.z - to[2]);
        h.remove({ keep: false }); E.dispose();
        return { done, end };
      });
      check('the load ended and the trip landed', r.done === true && r.end < 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves: a part named __proto__ is refused by name at register',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        try { engine.saves.define('__proto__', { save: () => ({ a: 1 }), load: () => {} }); return { code: null, has: engine.saves.providers.has('__proto__') }; }
        catch (e) { return { code: e.code, msg: e.message, has: engine.saves.providers.has('__proto__') }; }
      });
      check('refused with the name in the message, nothing registered', r.code === 'module-params' && /__proto__/.test(r.msg) && !r.has, JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves: a late part and a removed part hold no null from a NaN either',
    url: '/?threedog-headless',
    expectErrors: /r2late|r2gone/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, E = engine.session; let got;
        const a = S.define('r2late', { save: () => ({ hp: NaN }), load: d => { got = d; } });
        const inBase = JSON.parse(E._base).parts.r2late;
        await E.newGame();
        a.remove({ keep: false });
        const b = S.define('r2gone', { save: () => ({ pos: [Infinity] }), load: () => {} });
        b.remove();
        const kept = S._foreign.parts.r2gone;
        engine.error = null; engine.stacks.get('freeze').release('error');
        return { inBase, got, kept };
      });
      check('the new-game state has no such part, so newGame does not hand it hp null', r.inBase === undefined && r.got === undefined, JSON.stringify(r));
      check('the removed part left no data with a null in it', r.kept === undefined, JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves.apply ends a walk and says save:loaded, as saves.load does',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const S = engine.saves, p = engine.player, data = S.collect(), said = [];
        const on = engine.events.on('save:loaded', s => said.push(s));
        let st = null; p.walkTo({ x: p.position.x + 30, z: p.position.z }).then(a => { st = a.status; });
        for (let i = 0; i < 5; i++) engine.step(1 / 60, { render: false });
        const ok = await S.apply(data, 'r2-walk');
        await new Promise(r => setTimeout(r, 0));
        on.remove();
        const was = st;
        return { ok, st: was, said };
      });
      check('the load went through', r.ok === true, JSON.stringify(r));
      check('the walk of the old state ended', r.st === 'cancelled', JSON.stringify(r));
      check('derived state hears it', r.said.join() === 'r2-walk', JSON.stringify(r));
    },
  },
  {
    name: '[guard] world: a presenter whose radius grows builds what it now reaches without the player moving',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const W = engine.world, p = engine.player.position; let R = 5, built = 0;
        const h = W.present('r2far', { radius: () => R, build: () => { built++; return new __threedogThree.Object3D(); } });
        W.add({ id: 'r2-far', kind: 'r2far', position: [p.x + 40, p.y, p.z] });
        for (let i = 0; i < 5; i++) engine.step(1 / 60);
        const before = built;
        R = 100;
        for (let i = 0; i < 5; i++) engine.step(1 / 60);
        const after = built;
        W.remove('r2-far'); h?.remove?.();
        return { before, after };
      });
      check('built once in reach', r.before === 0 && r.after === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] saves: apply, save, apply on consecutive lines stores the first state, on a page with afterLoad hooks',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves; let v = 0;
        const h = S.define('r2seq', { save: () => ({ v }), load: d => { v = d.v; } });
        const hooks = [...engine.modules.values()].filter(m => m.afterLoad).length;
        const x = structuredClone(S.collect()), y = structuredClone(x);
        x.parts.r2seq = { v: 1 }; y.parts.r2seq = { v: 2 };
        const a = S.apply(x), b = S.save('r2-seq'), c = S.apply(y);
        const ok = await Promise.all([a, b, c]);
        const saved = JSON.parse(S._json.get('r2-seq')).parts.r2seq.v;
        h.remove({ keep: false });
        return { hooks, ok, saved, now: v };
      });
      check('the page takes the path under test', r.hooks > 0, JSON.stringify(r));
      check('the save holds what the line before it applied, the game what the line after it applied', r.saved === 1 && r.now === 2, JSON.stringify(r));
    },
  },
  {
    name: '[guard] commits: a request made while a failed session load rolls back lands, what the failed load asked for does not',
    url: '/?threedog-headless',
    expectErrors: /r2rb/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, C = engine.commits; let boom = false; const landed = [];
        const ask = what => C.request({ lag: 1, fallback: () => what, apply: w => landed.push(w) });
        const h = S.define('r2rb', { save: () => ({ boom }), load: d => { ask(d.boom ? 'failed load' : 'rollback'); if (d.boom) throw new Error('r2rb'); } });
        boom = true; await S.save('r2-rb'); boom = false;
        const epoch = C.epoch, ok = await engine.session.load('r2-rb');
        engine.error = null; engine.stacks.get('freeze').release('error');
        for (let i = 0; i < 5; i++) engine.step(1 / 60);
        h.remove({ keep: false });
        return { ok, landed, back: C.epoch === epoch };
      });
      check('the load failed and gave the epoch back', r.ok === false && r.back, JSON.stringify(r));
      check('only the rollback request landed', r.landed.join() === 'rollback', JSON.stringify(r));
    },
  },
  {
    name: '[guard] rigid: a body made after the save stays through a quick load, as what the game added during play does',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const e = window.engine, S = e.saves, R = e.rigid, T = __threedogThree;
        e.haltLoop();
        await S.save('r2-barrel');
        const m = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial()); m.position.set(3, 40, 3); e.add(m);
        const b = R.addBox(m, { id: 'barrel', size: [1, 1, 1], mass: 2 });
        const inSave = Object.hasOwn(JSON.parse(S._json.get('r2-barrel')).parts.rigid ?? {}, 'barrel');
        for (let i = 0; i < 10; i++) e.step(1 / 60, { render: false });
        const ok = await S.load('r2-barrel');
        for (let i = 0; i < 10; i++) e.step(1 / 60, { render: false });
        const here = R.bodies.some(x => x.id === 'barrel');
        const kept = Object.hasOwn(S.collect().parts.rigid, 'barrel');
        b.remove(); e.remove(m);
        return { inSave, ok, here, kept };
      });
      check('the save did not hold it and the load went through', r.inSave === false && r.ok === true, JSON.stringify(r));
      check('the body stays and the next save holds it (saves.load keeps what the game added)', r.here && r.kept, JSON.stringify(r));
    },
  },
];
