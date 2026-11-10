// Group HC1 + HC3 (docs/plans/research/2026-11-10-health-check-a.md): the error signal and module lifecycle silences. One test item per fix, so reverting one fix turns only its own item red.
const PAGE = '/tests/threads/';

/** a started throwaway engine; mods are used before start */
const BOOT = `(async (key, mods, extra) => { const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, key, extra || {}); if (mods) E.use(...mods); await E.start(); E.haltLoop(); return E; })`;

export const specs = [
  {
    name: '[guard] group HC1a: a release build keeps the first gameplay error in engine.error and emits engine:error once per site, without freezing',
    url: PAGE,
    async run({ check }) {
      // this runs in Node, where DEV is off (a release build)
      const { DEV } = await import('../../core/base/validate.js');
      const { reportError } = await import('../../core/base/errors.js');
      const sent = [], eng = { error: null, _hookErrors: new Set(), froze: 0, freeze() { this.froze++; }, events: { emit: (n, x) => sent.push([n, x?.where]) } };
      const was = console.error; console.error = () => {};
      try {
        reportError(eng, new Error('first'), 'site A'); reportError(eng, new Error('again'), 'site A'); reportError(eng, new Error('other'), 'site B');
        reportError(eng, new Error('soft'), 'site C', { soft: true });
      } finally { console.error = was; }
      check('Node runs without DEV (the release path)', DEV === false);
      check('engine.error keeps the first error, not frozen', eng.error?.where === 'site A' && eng.error.message === 'first' && eng.froze === 0, JSON.stringify(eng.error));
      check('engine:error once per site (A, B), never for a soft report', JSON.stringify(sent) === '[["engine:error","site A"],["engine:error","site B"]]', JSON.stringify(sent));
    },
  },
  {
    name: '[guard] group HC1b: an atomic rollback that cannot restore a part reports through the error path (engine.error + engine:error), not soft',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1b', null);
        let bare = null; const seen = []; E.events.on('engine:error', x => seen.push(x.code));
        E.saves.define('hcBare', { atomic: true, save: () => bare, load: d => { bare = d; } });
        E.ops.define('hc.bare', { atomic: true, run: () => { bare = ['written']; return { ok: false, code: 'nope' }; } });
        const quiet = console.error; console.error = () => {};
        let res; try { res = E.ops.run('hc.bare'); } finally { console.error = quiet; }
        const out = { code: res.code, error: E.error?.code ?? null, seen };
        E.error = null; E.stacks.get('freeze').release('error'); E.dispose();
        return out;
      }, BOOT);
      check('the failed op reports rollback-incomplete as an engine error that fired engine:error', r.code === 'nope' && r.error === 'rollback-incomplete' && r.seen.includes('rollback-incomplete'), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1c: a rolled-back atomic op emits op:rolledBack { op, parts } once, after the state is back; a committed op emits nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1c', null);
        const got = []; E.events.on('op:rolledBack', x => got.push({ ...x, flag: !!E.vars.flag('hc_f') }));
        E.ops.define('hc.fail', { atomic: true, run: e => { e.vars.setFlag('hc_f', true); return { ok: false, code: 'nope' }; } });
        E.ops.define('hc.ok', { atomic: true, run: e => { e.vars.setFlag('hc_g', true); return 1; } });
        E.ops.run('hc.ok');
        const none = got.length;
        E.ops.run('hc.fail');
        const out = { none, got, flagAfter: !!E.vars.flag('hc_f') };
        E.dispose();
        return out;
      }, BOOT);
      check('nothing for the committed op', r.none === 0, JSON.stringify(r));
      check('one event for the rolled-back op, naming it, seen after the flag went back', r.got.length === 1 && r.got[0].op === 'hc.fail' && r.got[0].parts > 0 && r.got[0].flag === false && r.flagAfter === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1c: the HUD quest markers read the state again on op:rolledBack',
    url: PAGE,
    async run({ check }) {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(new URL('../../modules/hud/index.js', import.meta.url), 'utf8');
      check("hud syncQuests is wired to 'op:rolledBack'", /'state:replaced', 'op:rolledBack'\]\) ctx\.track\(e\.events\.on\(ev, syncQuests\)\)/.test(src));
    },
  },
  {
    name: '[guard] group HC1d: the atomic rule is cited as R67 (not R66) in opsAtomic.js and docs/api/saves.md',
    url: PAGE,
    async run({ check }) {
      const { readFileSync } = await import('node:fs');
      const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
      const a = read('../../core/ops/opsAtomic.js'), b = read('../../docs/api/saves.md');
      check('opsAtomic.js says R67', /atomic[\s\S]*\(rule R67\)/.test(a) && !/\(rule R66\)/.test(a));
      check('saves.md says R67', /notAtomic[^\n]*\(rule R67\)/.test(b) && !/\(rule R66\)/.test(b));
    },
  },
  {
    name: '[guard] group HC1e: a damaged list for a shared value the code defines refuses the load (rolled back), also with validate:false',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1e', null, { validate: false });
        const bad = JSON.parse(JSON.stringify(E.saves.collect()));
        const known = [...E.stacks._all.values()].find(x => x.save !== false && (x.kind === 'number' || x.kind === 'value')).name;
        bad.parts.stacks = { [known]: 'not a list' };
        E.vars.setFlag('hc_keep', true);
        const quiet = console.warn; console.warn = () => {};
        let ok; try { ok = await E.saves.apply(bad); } finally { console.warn = quiet; }
        const out = { ok, kept: E.vars.flag('hc_keep'), error: E.error?.message ?? null };
        E.dispose();
        return out;
      }, BOOT);
      check('apply returns false and the state stays; no gameplay error (a damaged save is the save\'s fault)', r.ok === false && r.kept === true && !r.error, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1e: a save with a shared value this code no longer defines (obsolete shape) still loads, and the other parts restore',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1e3', null);
        E.vars.setFlag('hc_old', true);
        const old = JSON.parse(JSON.stringify(E.saves.collect()));
        old.parts.stacks = { ...(old.parts.stacks ?? {}), 'removed.feature': { old: 'shape' } };
        E.vars.setFlag('hc_old', false);
        const quiet = console.warn; console.warn = () => {};
        let ok; try { ok = await E.saves.apply(old); } finally { console.warn = quiet; }
        const out = { ok, flag: !!E.vars.flag('hc_old'), error: E.error?.message ?? null };
        E.dispose();
        return out;
      }, BOOT);
      check('loads, the vars part came back, no gameplay error', r.ok === true && r.flag === true && !r.error, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1c: a listener of op:rolledBack runs an ordinary op: its after hook runs',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1c2', null);
        const afters = [];
        E.ops.define('hc.after', { atomic: true, run: () => 1, after: () => afters.push('after') });
        E.ops.define('hc.fail2', { atomic: true, run: () => ({ ok: false, code: 'nope' }) });
        E.events.on('op:rolledBack', () => { E.ops.run('hc.after'); });
        E.ops.run('hc.fail2');
        const out = { afters, depth: E.ops._stack.length };
        E.dispose();
        return out;
      }, BOOT);
      check('the listener op committed and its after hook ran', r.afters.length === 1 && r.depth === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1c: an undo that runs a failing atomic op emits op:rolledBack before undo() returns, and nothing fires later',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1c3', null);
        const got = [];
        E.events.on('op:rolledBack', x => got.push(x.op));
        E.ops.define('hc.inner', { atomic: true, run: () => ({ ok: false, code: 'nope' }) });
        E.ops.define('hc.undoer', { run: () => 1, undo: e => { e.ops.run('hc.inner'); } });
        E.ops.undo('hc.undoer', {}, 1);
        const during = got.slice();
        E.ops.define('hc.plain', { run: () => 1 });
        E.ops.run('hc.plain');
        const out = { during, later: got.length };
        E.dispose();
        return out;
      }, BOOT);
      check('announced inside undo(), once, nothing later', r.during.join() === 'hc.inner' && r.later === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1b: a part the failed load never reached is not reported as an incomplete rollback',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1b2', null);
        let a = 'a', b = null;   // the later part has no new-game state either
        E.saves.define('hcFirst', { first: true, save: () => a, load: () => { throw new Error('first refuses'); } });
        E.saves.define('hcLater', { save: () => b, load: d => { b = d; } });
        a = 'a1'; b = 'b1';
        const data = JSON.parse(JSON.stringify(E.saves.collect()));
        b = null;   // no baseline for the later part
        const codes = [], quiet = console.error;   // dev reports the first error as engine:error and later ones to the console only: read both
        E.events.on('engine:error', x => codes.push(x.code));
        console.error = (...a) => codes.push(...(a.map(String).join(' ').match(/rollback-incomplete/) ?? ['other']));
        let ok; try { ok = await E.saves.apply(data); } finally { console.error = quiet; }
        const out = { ok, codes };
        E.error = null; E.stacks.get('freeze').release('error'); E.dispose();
        return out;
      }, BOOT);
      check('only the load error is reported, no rollback-incomplete', r.ok === false && r.codes.length >= 1 && !r.codes.includes('rollback-incomplete'), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3c: a late provider that cannot read a newer save version keeps the data and is no engine error',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc3c2', null);
        const data = JSON.parse(JSON.stringify(E.saves.collect()));
        data.parts.hcNewer = { x: 1 }; data.versions.hcNewer = 5;
        await E.saves.apply(data);
        const codes = []; E.events.on('engine:error', x => codes.push(x.code));
        const quiet = console.warn; console.warn = () => {};
        try { E.saves.define('hcNewer', { version: 1, save: () => null, load: () => {} }); await E.loading.settled(); } finally { console.warn = quiet; }
        const out = { codes, error: E.error?.code ?? null, kept: E.saves.collect().parts.hcNewer?.x ?? null };
        E.dispose();
        return out;
      }, BOOT);
      check('no engine:error, and the newer data is still carried', r.codes.length === 0 && !r.error && r.kept === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC1e: a part registered late whose data a save cannot hold is an engine error, also with validate:false',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const E = await (0, eval)(BOOT_SRC)('hc1e2', null, { validate: false });
        const quiet = console.error; console.error = () => {};
        try { E.saves.define('hcLate', { save: () => ({ n: NaN }), load: () => {} }); } finally { console.error = quiet; }
        const out = { code: E.error?.code ?? null, where: E.error?.where ?? null };
        E.error = null; E.stacks.get('freeze').release('error'); E.dispose();
        return out;
      }, BOOT);
      check('engine.error names the part with save-part-threw', r.code === 'save-part-threw' && /hcLate/.test(r.where ?? ''), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3a: a disabled picture module gives back its tracked listeners like unload does',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        let pings = 0;
        let armed = false;   // the page's own loop may run a frame before the test halts it
        const pic = { name: 'hcPic', type: 'picture', install(e, ctx) { ctx.track(e.events.on('hc:ping', () => pings++)); }, frame() { if (armed) throw new Error('pic boom'); } };
        const E = await (0, eval)(BOOT_SRC)('hc3a', [pic]);
        armed = true;
        const quiet = console.error; console.error = () => {};
        try { E.step(1 / 30, { render: false }); } finally { console.error = quiet; }
        const state = E.moduleStates.hcPic;
        E.events.emit('hc:ping', {});
        const out = { state, pings };
        E.dispose();
        return out;
      }, BOOT);
      check('disabled, and its tracked listener is gone', r.state === 'disabled' && r.pings === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3a: a critical module that requires a disabled module is reported (disabled counts as dead)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        let armed = false;
        const pic = { name: 'hcPic2', type: 'picture', frame() { if (armed) throw new Error('pic boom'); } };
        const dep = { name: 'hcNeed', type: 'rules', requires: ['hcPic2'], critical: true };
        const E = await (0, eval)(BOOT_SRC)('hc3a2', [pic, dep]);
        armed = true;
        const quiet = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {};
        try { E.step(1 / 30, { render: false }); } finally { console.error = quiet; console.warn = warn; }
        const out = { dep: E.moduleStates.hcNeed, code: E.error?.code ?? null };
        E.error = null; E.stacks.get('freeze').release('error'); E.dispose();
        return out;
      }, BOOT);
      check('the dependent is blocked and the critical failure is reported', r.dep === 'blocked' && r.code === 'module-critical', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3b: a module blocked by a failed dependency gets one warning naming itself and what it waits for',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const bad = { name: 'hcBroken', type: 'picture', init() { throw new Error('init boom'); } };
        const wait = { name: 'hcWaiter', type: 'rules', requires: ['hcBroken'] };
        const warns = [], w0 = console.warn, q = console.error; console.warn = (...a) => warns.push(a.join(' ')); console.error = () => {};
        let E; try { E = await (0, eval)(BOOT_SRC)('hc3b', [bad, wait]); } finally { console.warn = w0; console.error = q; }
        const mine = warns.filter(w => w.includes('hcWaiter'));
        const out = { n: mine.length, text: mine[0] ?? '' };
        E.dispose();
        return out;
      }, BOOT);
      check('one warning naming hcWaiter, hcBroken and the state', r.n === 1 && /hcBroken/.test(r.text) && /failed/.test(r.text), JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3c: a provider replaced while a load awaits fails the load (providerChanged) and rolls it back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        let release, a = 'a0', b = 'b0';
        const ma = { name: 'hcModA', install(e, ctx) { ctx.track(e.saves.define('hcPartA', { first: true, save: () => a, load: d => { a = d; if (release) return undefined; return new Promise(res => { release = res; }); } })); } };
        const mb = { name: 'hcModB', install(e, ctx) { ctx.track(e.saves.define('hcPartB', { save: () => b, load: d => { b = d; } })); } };
        const E = await (0, eval)(BOOT_SRC)('hc3c', [ma, mb]);
        a = 'a1'; b = 'b1';
        const data = JSON.parse(JSON.stringify(E.saves.collect()));
        a = 'a-now'; b = 'b-now';
        const quiet = console.error; console.error = () => {};
        let ok, seen;
        try {
          const p = E.saves.apply(data);
          for (let i = 0; i < 50 && !release; i++) await new Promise(r => setTimeout(r, 10));   // until part A is loading
          E.unuse('hcModB');   // its provider goes while part A still loads
          release(); ok = await p;
          seen = E.error?.code ?? null;
        } finally { console.error = quiet; }
        const out = { ok, seen, a };
        E.error = null; E.stacks.get('freeze').release('error'); E.dispose();
        return out;
      }, BOOT);
      check('the load fails with save-provider-changed and part A went back to what it was', r.ok === false && r.seen === 'save-provider-changed' && r.a === 'a-now', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3d: a dispose that throws after a failed install is reported, and the install error stays the one thrown',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const ok = { name: 'hcOk', dispose() { throw new Error('dispose boom'); } };
        const bad = { name: 'hcBadInstall', install() { throw new Error('install boom'); } };
        const E = await (0, eval)(BOOT_SRC)('hc3d', null);
        const errs = [], q = console.error; console.error = (...a) => errs.push(a.map(String).join(' '));
        let thrown = null; try { E.use(ok, bad); } catch (x) { thrown = x.message; } finally { console.error = q; }
        const out = { thrown, said: errs.some(s => s.includes('dispose() of module hcOk after its install failed')) };
        E.dispose();
        return out;
      }, BOOT);
      check('install boom is thrown, the dispose failure was reported', /install boom/.test(r.thrown ?? '') && r.said, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3d: a failure giving back a borrow after a failed borrow batch is reported, and the write error stays the one thrown',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const obj = { _a: 'orig', get a() { return this._a; }, set a(v) { if (v === 'orig') throw new Error('giveback boom'); this._a = v; }, get b() { return 0; }, set b(v) { throw new Error('write boom'); } };
        const mod = { name: 'hcBorrower', install(e, ctx) { ctx.borrow(obj, { a: 'new', b: 1 }); } };
        const E = await (0, eval)(BOOT_SRC)('hc3d2', null);
        const errs = [], q = console.error; console.error = (...a) => errs.push(a.map(String).join(' '));
        let thrown = null; try { E.use(mod); } catch (x) { thrown = x.message; } finally { console.error = q; }
        const out = { thrown, said: errs.some(s => s.includes('giving back a failed borrow of module hcBorrower')) };
        E.dispose();
        return out;
      }, BOOT);
      check('write boom is thrown, the give-back failure was reported', /write boom/.test(r.thrown ?? '') && r.said, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC3e: engine.skip warns once per module that has a fixed hook but no skip hook and no skipKind',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async BOOT_SRC => {
        const lone = { name: 'hcLone', fixed() {} }, ok = { name: 'hcDeclared', skipKind: 'none', fixed() {} };
        const E = await (0, eval)(BOOT_SRC)('hc3e', [lone, ok]);
        const warns = [], w0 = console.warn; console.warn = (...a) => warns.push(a.join(' '));
        try { E.ops.run('time.skip', { seconds: 1 }); E.ops.run('time.skip', { seconds: 1 }); } finally { console.warn = w0; }
        const out = { lone: warns.filter(w => w.includes('hcLone')).length, declared: warns.filter(w => w.includes('hcDeclared')).length };
        E.dispose();
        return out;
      }, BOOT);
      check('one warning for the module that says nothing, none for the one that declared skipKind', r.lone === 1 && r.declared === 0, JSON.stringify(r));
    },
  },
];
