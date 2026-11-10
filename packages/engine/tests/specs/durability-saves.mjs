// Durability guards from the 2026-11-02 durability audit (docs/plans/done/2026-11-02-durability-fixes.md items 1, 2, 6, 7): each reproduces an audit case
// through the public calls (saves / session) and the stored text, so a fix that only patches one path fails here.
// Same format as the other files here.
import { readFileSync } from 'node:fs';

/** In the page: store a hand-edited copy of slot `from` as slot `to` (as a player editing the save text would), returns nothing */
const EDIT = `async (from, to, src) => { const s = JSON.parse(engine.saves._json.get(from)); (0, eval)('(' + src + ')')(s); await engine.saves._put(to, JSON.stringify(s), Date.now()); }`;

export const specs = [
  {
    name: 'state replace: overlapping direct applies end as one whole save; a queued load takes its rollback point when it starts; session waits its turn; a late async adopt cannot write over a newer load (open world) [guard]',
    url: '/?threedog-headless',
    expectErrors: /replace boom/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {}, gate = () => { let open; const p = new Promise(res => { open = res; }); return { p, open }; };
        const state = { x: 0, y: 0 };
        let wait = null;   // the gate part X stops at, for the save whose x equals wait.at
        S.define('rpX', { save: () => ({ x: state.x }), load: d => { state.x = d.x; if (wait?.at === d.x) return wait.p; } });
        S.define('rpY', { save: () => ({ y: state.y }), load: d => { if (d.y < 0) throw new Error('replace boom'); state.y = d.y; } });
        const save = (x, y) => ({ format: 1, versions: { rpX: 1, rpY: 1 }, parts: { rpX: { x }, rpY: { y } } });
        const tick = () => new Promise(res => setTimeout(res, 0));
        // the review's repro: A (1,1) stops after part X, B (2,2) is asked for, A resumes. B waits its turn, so A is released before B is awaited
        wait = { ...gate(), at: 1 };
        const a = S.apply(save(1, 1), 'A'), b = S.apply(save(2, 2), 'B');
        await tick();
        out.mid = { ...state };
        wait.open();
        out.overlap = { a: await a, b: await b, end: { ...state } };
        // B fails while queued behind A: it rolls back to all of A (1,1), not to the half of A there was when B was asked for
        state.x = 0; state.y = 0;
        wait = { ...gate(), at: 1 };
        const a2 = S.apply(save(1, 1), 'A'), b2 = S.apply(save(5, -1), 'B');
        await tick();
        wait.open();
        out.rollback = { a: await a2, b: await b2, end: { ...state } };
        engine.error = null; engine.stacks.get('freeze').release('error');
        // idle: a save with only synchronous parts changes the state before apply returns
        wait = null;
        const c = S.apply(save(3, 3), 'C');
        out.sync = { ...state };
        await c;
        // apply, apply on the next line (a replay in one stretch of code), with afterLoad hooks installed: both apply at once and the hooks rebuild for the last
        let rebuilt = 0;
        engine.modules.set('rp-count', { name: 'rp-count', afterLoad() { rebuilt++; } }); engine._modState.set('rp-count', 'running');   // a stand-in module: the afterLoad gate runs only modules that run
        const c1 = S.apply(save(4, 4), 'C1'), first = state.x, c2 = S.apply(save(5, 5), 'C2');
        out.twice = { first, second: state.x, ok: [await c1, await c2], rebuilt };
        engine.modules.delete('rp-count'); engine._modState.delete('rp-count');
        // session.newGame asked during a direct apply starts after it, on the same rule
        const log = [], h = engine.events.on('session:end', () => log.push('end'));
        wait = { ...gate(), at: 7 };
        const d = S.apply(save(7, 7), 'D'), n = engine.session.newGame();
        await tick();
        out.sessionWaited = log.length === 0;
        wait.open();
        out.session = { d: await d, n: await n, log };
        h.remove();
        // a load() that asks for another replacement: it waits for this one
        let inner = null;
        S.define('rpNest', { save: () => ({}), load: () => { inner ??= S.apply(save(8, 8), 'inner'); } });
        out.nestOuter = await S.apply({ format: 1, versions: { rpNest: 1 }, parts: { rpNest: {} } }, 'outer');
        out.nestInner = await inner;
        out.nest = { x: state.x };
        S.providers.delete('rpNest');
        // a part adopted late with an async load: a newer load waits for it, so the old data cannot land on top
        let v = 0;
        const held = gate();
        await S.apply({ format: 1, versions: { rpLate: 1 }, parts: { rpLate: { v: 1 } } }, 'old');
        S.define('rpLate', { save: () => ({ v }), load: async dd => { if (dd.v === 1) await held.p; v = dd.v; } });
        const e2 = S.apply({ format: 1, versions: { rpLate: 1 }, parts: { rpLate: { v: 2 } } }, 'new');
        await tick();
        held.open();
        await e2;
        await tick();
        out.late = v;
        for (const k of ['rpX', 'rpY', 'rpLate']) S.providers.delete(k);
        return out;
      });
      check('A paused, B asked for: nothing of B is applied yet', r.mid.x === 1 && r.mid.y === 0, JSON.stringify(r));
      check('the end state is one whole save, never (2,1)', r.overlap.a === true && r.overlap.b === true && r.overlap.end.x === 2 && r.overlap.end.y === 2, JSON.stringify(r));
      check('a queued load that fails rolls back to the whole previous save', r.rollback.a === true && r.rollback.b === false && r.rollback.end.x === 1 && r.rollback.end.y === 1, JSON.stringify(r));
      check('[guard] idle: a synchronous save applies before apply returns', r.sync.x === 3 && r.sync.y === 3, JSON.stringify(r));
      check('[guard] apply, apply on the next line: both at once, afterLoad runs once for the last', r.twice.first === 4 && r.twice.second === 5 && r.twice.ok.join() === 'true,true' && r.twice.rebuilt === 1, JSON.stringify(r));
      check('session.newGame waits for a running apply', r.sessionWaited === true && r.session.d === true && r.session.n === true && r.session.log.join() === 'end', JSON.stringify(r));
      check('a late adopted async part cannot land on top of a newer load', r.late === 2, JSON.stringify(r));
      check('a replacement asked from inside a load() runs after it', r.nestOuter === true && r.nestInner === true && r.nest.x === 8, JSON.stringify(r));
      // the rule cannot be walked around: code that replaces state enters through the one turn, and ops know no load's freeze name
      const src = f => readFileSync(new URL('../../core/' + f, import.meta.url), 'utf8').replace(/^\s*(\/\/|\/?\*).*$/gm, '');
      const saves = src('saves/Saves.js'), session = src('saves/session.js'), ops = src('ops/opsFail.js');
      check('[guard] Saves applies and loads only inside a turn', [...saves.matchAll(/^.*(applyAnnounced\(this|this\._load\().*$/gm)].every(m => m[0].includes('_replace.run(')), 'a line in Saves.js calls applyAnnounced / _load outside _replace.run');
      check('[guard] Session keeps no queue of its own and does not re-enter the public calls', !/_running|\.then\(run|saves\.(apply|load)\(|\bS\.load\(/.test(session) && session.includes('_replace.run('), 'session.js');
      check('[guard] ops read the marker, not a load freeze name', ops.includes('saves.replacing') && !/\.has\('(?!error')/.test(ops), 'opsFail.js');
    },
  },
  {
    name: 'state replace: ops refuse by name through afterLoad and a rollback, work again after, and a plain menu freeze still allows them (open world) [guard]',
    url: '/?threedog-headless',
    expectErrors: /replace hook boom/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, E = engine, out = {};
        let value = 0, release, entered, fail = false, slow = null;
        E.use({ name: 'rpRebuild', type: 'rules', afterLoad() { entered?.(); return new Promise((res, rej) => { release = () => (fail ? rej(new Error('replace hook boom')) : res()); }); } });
        E.ops.define('rp.change', { run() { value++; }, undo() {} });
        S.define('rpSlow', { save: () => ({}), load: () => slow?.() });
        const started = () => new Promise(res => { entered = res; });
        // 1. a pending afterLoad
        let on = started(), loading = S.apply(S.collect(), 'rp');
        await on;
        out.hook = { frozen: E.frozen, run: E.ops.run('rp.change').code, can: E.ops.can('rp.change').code, undo: E.ops.undo('rp.change', {}, 1).code, value };
        release();
        out.hook.ok = await loading;
        out.hook.after = E.ops.run('rp.change').ok; out.hook.value2 = value;
        // 2. afterLoad throws; the rollback waits on an async part: still refused until the rollback ended
        value = 0; fail = true;
        const roll = {}; let rollEntered, rollOpen;
        const inRollback = new Promise(res => { rollEntered = res; }), hold = new Promise(res => { rollOpen = res; });
        on = started(); loading = S.apply(S.collect(), 'rp');
        await on;
        slow = () => { rollEntered(); return hold; };   // the next load of this part is the rollback's
        release();
        await inRollback;
        roll.run = E.ops.run('rp.change').code; roll.value = value;
        rollOpen();
        roll.ok = await loading;
        slow = null; fail = false;
        E.error = null; E.stacks.get('freeze').release('error');
        roll.after = E.ops.run('rp.change').ok; roll.value2 = value;
        out.roll = roll;
        E.unuse('rpRebuild'); S.providers.delete('rpSlow');
        // 3. a game's own menu freeze: ops such as inventory keep working
        const menu = E.freeze('rp-menu'), v0 = value;
        out.menu = { frozen: E.frozen, ok: E.ops.run('rp.change').ok, changed: value === v0 + 1 };
        menu.remove();
        // 4. no afterLoad hook and synchronous parts: the replacement is over on the next line, not a tick later
        const hooks = [...E.modules].filter(([, m]) => m.afterLoad);
        for (const [k] of hooks) E.modules.delete(k);
        const p = S.apply(S.collect(), 'rp');
        out.idle = { replacing: S.replacing, op: E.ops.run('rp.change').ok };
        await p;
        for (const [k, m] of hooks) E.modules.set(k, m);
        return out;
      });
      const h = r.hook, ro = r.roll;
      check('pending afterLoad: gameplay frozen, ops.run / can / undo refuse with code loading, nothing changed', h.frozen === true && h.run === 'loading' && h.can === 'loading' && h.undo === 'loading' && h.value === 0, JSON.stringify(r));
      check('after afterLoad ends ops work again', h.ok === true && h.after === true && h.value2 === 1, JSON.stringify(r));
      check('during the rollback ops refuse the same way', ro.run === 'loading' && ro.value === 0, JSON.stringify(r));
      check('after the rollback ops work again', ro.ok === false && ro.after === true && ro.value2 === 1, JSON.stringify(r));
      check('[guard] a plain menu freeze keeps allowing ops', r.menu.frozen === true && r.menu.ok === true && r.menu.changed === true, JSON.stringify(r));
      check('[guard] idle and fully synchronous: ops work on the line after apply', r.idle.replacing === false && r.idle.op === true, JSON.stringify(r));
    },
  },
  {
    name: 'durability: a hand-edited record position, a throwing world:load listener or afterLoad, and a null part all leave the game as it was (open world) [guard]',
    url: '/?threedog-headless',
    expectErrors: /dur listener boom|dur afterLoad boom/,   // the two provoked code errors
    async run({ check, ev }) {
      const r = await ev(async EDIT_SRC => {
        const edit = (0, eval)('(' + EDIT_SRC + ')'), S = engine.saves, P = () => { const p = engine.player.position; return [p.x, p.y, p.z]; };
        engine.step(0.5, { describe: false });
        await S.save('dur-good');
        const out = {}, before = P(), errs = [];
        const errH = engine.events.on('engine:error', e => errs.push(e?.message ?? String(e)));
        // 1. player position { x: 1e12, y: null, z: 'abc' }: refused with save-bad-record, nothing moved, the game keeps stepping
        await edit('dur-good', 'dur-pos', (s => { s.parts.world.records.player.position = { x: 1e12, y: null, z: 'abc' }; }).toString());
        out.pos = { ok: await S.load('dur-pos'), same: JSON.stringify(P()) === JSON.stringify(before), frozen: engine.frozen };
        try { engine.step(0.3, { describe: false }); out.pos.steps = true; } catch (e) { out.pos.steps = e.message; }
        out.pos.finite = P().every(Number.isFinite);
        out.pos.error = !!engine.error;
        // 2. a world:load listener that throws: the load fails and rolls back (the flag set after the save stays set). A throwing listener is a code
        // bug, so it goes through the error tiers (frozen in dev); the load's own freeze is released either way
        const loadHeld = () => S.replacing || engine.stacks.get('freeze').names().includes('threedog:state-replace');
        const clear = () => { engine.error = null; engine.stacks.get('freeze').release('error'); };
        engine.ops.allow(() => engine.vars.setFlag('dur-after', true));
        const h = engine.events.on('world:load', () => { throw new Error('dur listener boom'); });
        out.listener = { ok: await S.load('dur-good'), flag: engine.vars.flag('dur-after'), error: /dur listener boom/.test(engine.error?.message ?? '') };
        h.remove(); clear();
        // 3. a module's afterLoad that throws: same rollback
        engine.modules.set('dur-after-load', { name: 'dur-after-load', afterLoad() { throw new Error('dur afterLoad boom'); } }); engine._modState.set('dur-after-load', 'running');   // a stand-in module: the afterLoad gate runs only modules that run
        out.hook = { ok: await S.load('dur-good'), flag: engine.vars.flag('dur-after'), loadHeld: loadHeld(), error: /dur afterLoad boom/.test(engine.error?.message ?? '') };
        engine.modules.delete('dur-after-load'); engine._modState.delete('dur-after-load'); clear();
        out.clean = await S.load('dur-good');   // the same save loads once nothing throws
        out.flagAfterClean = engine.vars.flag('dur-after');
        // 4. a null part is a corrupt save: refused before anything changes
        engine.ops.allow(() => engine.vars.setFlag('dur-after', true));
        await edit('dur-good', 'dur-null', (s => { s.parts.world = null; }).toString());
        const recs = engine.world.records.size;
        out.nul = { check: S.check('dur-null'), ok: await S.load('dur-null'), recs: engine.world.records.size === recs, flag: engine.vars.flag('dur-after') };
        // a part with nothing to save is left out, never written as null
        S.define('dur-empty', { save: () => null, load: () => {} });
        out.nullWritten = 'dur-empty' in S.collect().parts;
        S.providers.delete('dur-empty');
        errH.remove();
        out.errs = errs.length;
        return out;
      }, EDIT);
      check('a malformed record position is refused like a corrupt save: load false, the player did not move, no gameplay error, stepping works',
        r.pos.ok === false && r.pos.same && !r.pos.frozen && !r.pos.error && r.pos.steps === true && r.pos.finite, JSON.stringify(r.pos));
      check('a world:load listener that throws fails the load and rolls it back (reported as the error)', r.listener.ok === false && r.listener.flag === true && r.listener.error, JSON.stringify(r.listener));
      check('an afterLoad hook that throws fails the load and rolls it back, and the load freeze is released', r.hook.ok === false && r.hook.flag === true && !r.hook.loadHeld && r.hook.error, JSON.stringify(r.hook));
      check('the same save loads once nothing throws', r.clean === true && !r.flagAfterClean, JSON.stringify(r));
      check("a null part is 'corrupt': refused before anything changes", r.nul.check === 'corrupt' && r.nul.ok === false && r.nul.recs && r.nul.flag === true, JSON.stringify(r.nul));
      check('a part whose save() returns null is left out of the save', r.nullWritten === false);
    },
  },
  {
    name: 'durability: out-of-range saved numbers (clock, time channels, random state, item counts) are clamped or dropped with one warning per part (open world) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async EDIT_SRC => {
        const edit = (0, eval)('(' + EDIT_SRC + ')'), S = engine.saves;
        engine.step(0.5, { describe: false });
        await S.save('dur-ok');
        const state0 = engine.random.state, tod0 = engine.calendar.timeOfDay;
        await edit('dur-ok', 'dur-oor', (s => {
          s.parts.time.channels.calendar = -1000; s.parts.time.timers = [{ due: 'abc', event: 'x', channel: 'calendar' }];   // the calendar is a channel of the time part
          s.parts.time.channels.world = -1000;
          s.parts.random.state = 'abc';
          s.parts.calendar = { time: 'abc', day: -5 };
          s.parts.inventory.items = [{ id: 'film', count: 1e308 }, { id: 'film', key: 'film', count: 2 }];
        }).toString());
        const warns = [], warn = console.warn;
        console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
        let ok; try { ok = await S.load('dur-oor'); } finally { console.warn = warn; }
        const per = p => warns.filter(w => w.includes('[save-value]') && w.includes(`save part '${p}'`)).length;
        return { ok, clock: engine.clock.now, world: engine.time.now('world'), state: engine.random.state, state0, film: engine.inventory.count('film'),
          clockWarn: per('clock'), timeWarn: per('time'), randomWarn: per('random'), calWarn: per('calendar'), tod: engine.calendar.timeOfDay, tod0, day: engine.calendar.day, clockText: engine.calendar.clock, rowWarn: warns.filter(w => w.includes('dropped a saved entry')).length };
      }, EDIT);
      check('the load still succeeds (scalars are clamped, not refused)', r.ok === true, JSON.stringify(r));
      check('a negative clock / channel time is clamped to 0', r.clock >= 0 && r.world >= 0, JSON.stringify(r));
      check("random state 'abc' keeps the current state instead of restarting the sequence at 0", r.state === r.state0 && r.state !== 0, JSON.stringify(r));
      check('an item count of 1e308 is dropped, the valid row loads', r.film === 2 && r.rowWarn >= 1, JSON.stringify(r));
      check("calendar time 'abc' keeps the current time of day (a real clock, not NaN:NaN), day -5 becomes 1", Number.isFinite(r.tod) && r.tod >= 0 && r.tod < 1 && !/NaN/.test(r.clockText) && r.day === 1, JSON.stringify(r));
      check('one save-value warning per part that had bad values', r.timeWarn === 1 && r.randomWarn === 1 && r.calWarn === 1, JSON.stringify(r));
    },
  },
  {
    name: 'durability: newGame is a fresh page: pushed crates land where they land on a fresh page, real time starts from 0 (open world) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const play = () => {
          const run = sec => engine.step(sec, { describe: false, render: false }), I = engine.input;
          I.simulate('moveForward', true); run(4);
          I.simulate('moveRight', true); run(3); I.simulate('moveRight', false);
          I.simulate('jump', true); run(0.2); I.simulate('jump', false);
          I.simulate('moveForward', false); run(3);
          const ch = engine.saves.collect().parts.world.changed;
          // crates are the physics props the player walks into on this path (audit case: crate-3 x differed by 0.2 mm after newGame)
          return JSON.stringify(Object.entries(ch).filter(([id]) => id.startsWith('crate')).sort());
        };
        const fresh = play();
        await engine.session.newGame();
        const elapsed0 = engine.time.now('real');
        const again = play();
        return { fresh, again, elapsed0, crates: (fresh.match(/crate/g) || []).length };
      });
      check('the path moves crates (otherwise this guard tests nothing)', r.crates >= 1, r.fresh.slice(0, 200));
      check('after newGame the same inputs move the crates exactly as on the fresh page', r.fresh === r.again, `${r.fresh.slice(0, 300)} vs ${r.again.slice(0, 300)}`);
      check('real time starts from 0 on newGame', r.elapsed0 === 0, String(r.elapsed0));
    },
  },
  {
    name: 'durability: two tabs of one game never overwrite each other’s newer save; a loaded slot can be saved again (city) [guard]',
    url: '/tests/city/index.html?threedog-headless',
    async run({ check, ev }) {
      // two engines with one saveKey on one page share the IndexedDB database and the BroadcastChannel exactly as two tabs of the game do
      const r = await ev(async () => {
        const mk = () => new engine.constructor({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'dur-tabs' });
        const A = mk();
        await A.saves.whenReady;
        await A.saves.remove('auto'); await A.saves.save('auto');   // tab A writes first
        await A.saves.flush();
        const B = mk();
        await B.saves.whenReady;   // tab B opens after it and reads A's save
        try {
          B.ops.allow(() => B.vars.setFlag('dur-b', true));
          const bSaved = await B.saves.save('auto');   // B saw A's save, so B may overwrite it
          const warns = [], warn = console.warn;
          console.warn = (...x) => { warns.push(x.join(' ')); warn(...x); };
          let ok; try { ok = await A.saves.save('auto'); } finally { console.warn = warn; }   // A has not seen B's write: refused
          await A.saves.flush();
          const shows = JSON.parse(A.saves._json.get('auto')).parts.vars.flags['dur-b'] === true;
          const disk = JSON.parse((await A.saves.store.getSlot('auto')).json).parts.vars.flags['dur-b'] === true;
          const loaded = await A.saves.load('auto');
          const again = await A.saves.save('auto');   // A continues from B's save now: allowed
          const bAgain = await B.saves.save('auto');   // and B, which has not seen that, is refused in turn
          const C = mk(), early = C.saves.save('auto');   // a save made before the boot read: its write expects the record that read finds
          const earlyOk = await early; C.dispose();
          return { bSaved, ok, stale: warns.some(w => w.includes('[save-stale]')), shows, disk, loaded, again, bAgain, earlyOk };
        } finally { await A.saves.remove('auto'); A.dispose(); B.dispose(); }
      });
      // a save still queued when remove runs must not leave its rev behind for the deleted record
      const q = await ev(async () => {
        const S = engine.saves;
        const first = S.save('dur-rm'), gone = S.remove('dur-rm');
        await first; await gone;
        const again = await S.save('dur-rm'), st = S.check('dur-rm');
        await S.remove('dur-rm');
        return { again, st };
      });
      check('save then remove (queued together) then save again: the second save is written', q.again === true && q.st === null, JSON.stringify(q));
      check('a save made before storage is read is not taken for another tab', r.earlyOk === true, JSON.stringify(r));
      check('tab B overwrites the save it read at boot', r.bSaved === true, JSON.stringify(r));
      check('tab A is refused (save-stale) instead of overwriting B’s newer save', r.ok === false && r.stale, JSON.stringify(r));
      check('after the refusal tab A lists B’s save, and the stored save is still B’s', r.shows && r.disk, JSON.stringify(r));
      check('once tab A loads that save it may save over it again; B is refused in turn', r.loaded === true && r.again === true && r.bAgain === false, JSON.stringify(r));
    },
  },
  {
    name: 'durability: a rollback waiting on an async part holds gameplay however the load failed; a save with no savedAt exports a readable file (open world) [guard]',
    url: '/?threedog-headless',
    expectErrors: /dur rollback boom/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {}, held = () => S.replacing && engine.stacks.get('freeze').has('threedog:state-replace');
        const clear = () => { engine.error = null; engine.stacks.get('freeze').release('error'); };
        let seen = [];
        S.define('durBoom', { first: true, save: () => ({}), load: d => { if (d.bad) throw new Error('dur rollback boom'); } });
        S.define('durSlow', { save: () => ({}), load: async () => { await new Promise(res => setTimeout(res, 0)); seen.push(held()); } });
        const good = S.collect(), bad = JSON.parse(JSON.stringify(good));
        bad.parts.durBoom = { bad: true };
        out.sync = { ok: await S.apply(bad, 'dur'), seen }; clear();   // threw before any hold was taken
        seen = [];
        engine.modules.set('dur-al', { name: 'dur-al', afterLoad() { throw new Error('dur rollback boom'); } }); engine._modState.set('dur-al', 'running');   // a stand-in module: the afterLoad gate runs only modules that run
        out.hook = { ok: await S.apply(good, 'dur') }; out.hook.seen = seen;   // the parts' hold ended before the hook failed
        engine.modules.delete('dur-al'); engine._modState.delete('dur-al'); clear();
        out.released = !held();
        S.providers.delete('durBoom'); S.providers.delete('durSlow');
        await S._put('dur-odd', JSON.stringify({ parts: {} }), undefined);
        const url = URL.createObjectURL; let blob = null;
        URL.createObjectURL = b => { blob = b; return url.call(URL, b); };
        try { out.exported = await S.exportFile('dur-odd', { files: false }); } finally { URL.createObjectURL = url; }
        out.file = JSON.parse(await blob.text()).savedAt;
        await S.remove('dur-odd');
        return out;
      });
      check('a load that threw at once: gameplay held while the rollback waits', r.sync.ok === false && r.sync.seen.length === 1 && r.sync.seen[0] === true, JSON.stringify(r));
      check('an afterLoad that threw: gameplay held while the rollback waits', r.hook.ok === false && r.hook.seen.length === 2 && r.hook.seen.every(Boolean), JSON.stringify(r));
      check('the hold ends with the load', r.released === true, JSON.stringify(r));
      check('exportFile writes valid JSON for a save without savedAt', r.exported === true && r.file === 0, JSON.stringify(r));
    },
  },
  {
    name: 'durability: a session.load that rolls back keeps real time / shader time as they were (open world) [guard]',
    url: '/?threedog-headless',
    expectErrors: /dur session boom/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.step(1, { describe: false, render: false });
        await engine.saves.save('dur-sess');
        engine.step(1, { describe: false, render: false });
        const before = { elapsed: engine.time.now('real'), uTime: engine.uniforms.uTime.value };
        const h = engine.events.on('world:load', () => { throw new Error('dur session boom'); });
        let ok; try { ok = await engine.session.load('dur-sess'); } finally { h.remove(); }
        engine.error = null; engine.stacks.get('freeze').release('error');
        const out = { ok, before, elapsed: engine.time.now('real'), uTime: engine.uniforms.uTime.value };
        await engine.saves.remove('dur-sess');
        return out;
      });
      check('the load is rolled back (false)', r.ok === false, JSON.stringify(r));
      check('real time and uTime are back to their pre-load values, not 0', r.before.elapsed > 0 && r.elapsed >= r.before.elapsed && r.uTime >= r.before.uTime, JSON.stringify(r));
    },
  },
  {
    name: 'durability: newGame keeps what the game wrote on a rigid body / collider (gravityScale, locks, ccd, dominance, groups, sensor, enabled) (open world) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const R = engine.rigid, src = R.bodies.find(b => b.mesh?.isMesh)?.mesh;
        if (!src) return { none: true };
        const mk = () => new src.constructor(src.geometry, src.material);   // not clone(): a view mesh's userData is circular (clone JSON-copies it)
        const m = mk(); m.position.set(src.position.x + 40, src.position.y + 5, src.position.z);
        const b = R.addBox(m, { size: [1, 1, 1] });
        b.body.setGravityScale(0, false); b.body.lockRotations(true, false); b.body.setEnabledTranslations(true, false, true, false);
        b.body.enableCcd(true); b.body.setDominanceGroup(3);
        b.collider.setCollisionGroups(0x00020002); b.collider.setSensor(true);
        const m2 = mk(); m2.position.set(src.position.x + 60, src.position.y + 5, src.position.z);
        const b2 = R.addBox(m2, { size: [1, 1, 1] }); b2.body.setEnabled(false);
        const old = b.body;
        await engine.session.newGame();
        const y = b.body, c = b.collider;
        const out = { rebuilt: y !== old, g: y.gravityScale(), ccd: y.isCcdEnabled(), dom: y.dominanceGroup(), groups: c.collisionGroups(), sensor: c.isSensor(),
          off: !b2.body.isEnabled() };
        // the locks have no getter: an impulse up and a torque must neither lift nor spin it
        const q0 = y.rotation(), y0 = y.translation().y;
        y.applyImpulse({ x: 0, y: 5, z: 0 }, true); y.applyTorqueImpulse({ x: 3, y: 3, z: 3 }, true);
        engine.step(0.3, { describe: false, render: false });
        const q1 = y.rotation();
        out.lifted = Math.abs(y.translation().y - y0); out.spun = Math.abs(q1.x - q0.x) + Math.abs(q1.y - q0.y) + Math.abs(q1.z - q0.z);
        b.remove(); b2.remove(); engine.remove(m); engine.remove(m2);
        return out;
      });
      check('the open world has a rigid mesh to clone (otherwise this guard tests nothing)', !r.none, JSON.stringify(r));
      check('the body was rebuilt by newGame (the path this guards)', r.rebuilt, JSON.stringify(r));
      check('gravityScale, ccd, dominance, collision groups and sensor survive', r.g === 0 && r.ccd && r.dom === 3 && r.groups === 0x00020002 && r.sensor, JSON.stringify(r));
      check('a body the game disabled stays disabled', r.off, JSON.stringify(r));
      check('axis locks survive (no lift on the locked Y axis, no spin with rotations locked)', r.lifted < 1e-6 && r.spun < 1e-6, JSON.stringify(r));
    },
  },
  {
    // joints are plain Rapier (no engine wrapper); newGame / a load rebuild the world and free them. The contract: rigid:rebuilt is where the game
    // re-creates them (the engine does not patch Rapier to copy them); a game that does not listen gets one dev warning, not a silent loss
    name: 'durability: a game that re-creates its joints on rigid:rebuilt keeps its rope and limited hinge after newGame; one that does not gets a warning (open world) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const R = engine.rigid, RA = R.rapier, src = R.bodies.find(b => b.mesh?.isMesh)?.mesh;
        if (!src) return { none: true };
        const mk = (dx, dy, o) => { const m = new src.constructor(src.geometry, src.material); m.position.set(src.position.x + dx, src.position.y + dy, src.position.z); return R.addBox(m, { size: [1, 1, 1], ...o }); };
        const anchor = mk(8, 12, { fixed: true, id: 'jt-anchor' }), weight = mk(8, 10), post = mk(12, 1.5, { fixed: true }), door = mk(13, 1.5);
        const J = { rope: null, hinge: null };
        const hang = () => {   // what the recipe tells a game to write: one function makes the joints, called at setup and on every rebuild
          J.rope = R.world.createImpulseJoint(RA.JointData.rope(2, { x: 0, y: -0.5, z: 0 }, { x: 0, y: 0.5, z: 0 }), anchor.body, weight.body, true);
          J.hinge = R.world.createImpulseJoint(RA.JointData.revolute({ x: 0.5, y: 0, z: 0 }, { x: -0.5, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), post.body, door.body, true);
          J.hinge.setLimits(-0.5, 0.5);
        };
        hang();
        let payload = null;
        const off = engine.events.on('rigid:rebuilt', p => { payload = p; hang(); });
        const warns = [], warn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
        const warned = () => warns.some(w => w.includes('rigid-misuse') && w.includes('rigid:rebuilt'));
        const out = {};
        try {
          await engine.session.newGame();
          engine.step(1, { describe: false, render: false });
          out.listenWarned = warned();
          out.payload = !!payload && payload.world === R.world && payload.bodies['jt-anchor'] === anchor.body && payload.player === R.playerBody;
          out.joints = R.world.impulseJoints.len(); out.ropeEnds = J.rope.body1().handle === anchor.body.handle && J.rope.body2().handle === weight.body.handle;
          out.limits = [J.hinge.limitsMin(), J.hinge.limitsMax()];
          door.body.applyTorqueImpulse({ x: 0, y: 20, z: 0 }, true);
          engine.step(2, { describe: false, render: false });
          const a = anchor.body.translation(), w = weight.body.translation(), dq = door.body.rotation();
          out.awake = weight.enabled; out.hang = a.y - w.y; out.doorAngle = 2 * Math.asin(Math.min(1, Math.abs(dq.y)));
          // a game that does not listen: its joints are gone after the rebuild and the next step warns once
          off.remove();
          await engine.session.newGame();
          engine.step(1, { describe: false, render: false });
          out.gone = R.world.impulseJoints.len(); out.silentWarned = warned();
        } finally { console.warn = warn; }
        for (const b of [anchor, weight, post, door]) { b.remove(); engine.remove(b.mesh); }
        return out;
      });
      check('the open world has a rigid mesh to clone (otherwise this guard tests nothing)', !r.none, JSON.stringify(r));
      check('rigid:rebuilt carries the new world, the player body and the rebuilt bodies by id', r.payload, JSON.stringify(r));
      check('the listening game has its rope and hinge in the rebuilt world, between the rebuilt bodies, and no warning', r.joints === 2 && r.ropeEnds && !r.listenWarned, JSON.stringify(r));
      check('the weight still hangs on the 2 m rope (did not fall 10 m)', r.awake && r.hang > 0.9 && r.hang < 3.1, JSON.stringify(r));
      check('the hinge keeps its limits (pushed hard, the door stops near 0.5 rad)', r.limits[0] === -0.5 && r.limits[1] === 0.5 && r.doorAngle < 0.6, JSON.stringify(r));
      check('a game that does not re-create its joints loses them with a dev warning naming rigid:rebuilt, not silently', r.gone === 0 && r.silentWarned, JSON.stringify(r));
    },
  },
  {
    name: "durability: a scenario time that is not a clock time (?time=night) fails with clock-time and never reaches the lights (open world) [guard]",
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tod0 = engine.calendar.timeOfDay;
        let code = null, msg = '';
        try { await engine.applyState({ time: 'night' }); } catch (err) { code = err.code; msg = err.message; }
        engine.step(0.1, { describe: false });
        const s = engine.lights.sun;
        let at = null; try { engine.calendar.at('dusk', () => {}); } catch (err) { at = err.code; }
        return { code, msg, at, tod: engine.calendar.timeOfDay, tod0, sun: [s.intensity, s.position.x, s.position.y, s.position.z] };
      });
      check("applyState({ time: 'night' }) throws clock-time naming 'HH:MM' and 0-1", r.code === 'clock-time' && /HH:MM/.test(r.msg) && /0-1/.test(r.msg), JSON.stringify(r));
      check('the time of day and the sun stay finite', Number.isFinite(r.tod) && Math.abs(r.tod - r.tod0) < 0.01 && r.sun.every(Number.isFinite), JSON.stringify(r));
      check("calendar.at('dusk') throws clock-time at the call", r.at === 'clock-time', JSON.stringify(r));
    },
  },
];
