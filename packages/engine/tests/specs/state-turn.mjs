// [guard] Who a state change belongs to, and when it is over. A part's load() and a module's afterLoad get the turn of their replacement and hand it to level.load / content.load, which then
// go at once; everyone else waits in line, past every await (core/saves/stateReplace.js). A late part runs in its own turn (saveApply.js adoptPart). A pack that failed ends only when the old
// level and registrations are back, and content.load answers for its own load (core/base/sections.js). Run: threedog test "state turn"
import { readFileSync } from 'node:fs';
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  const { THREE, mk, createEngine, all: T } = threedogThreads;
  const flat = name => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); s.name = name; m.name = 'ground'; m.position.y = -0.1; s.add(m); return s; };
  const gate = () => { let open; const p = new Promise(res => { open = res; }); return { p, open }; };
  const tick = () => new Promise(res => setTimeout(res, 0));
  // what a promise did within ms: a wait that never ends shows as 'pending', so the row goes on, says so and cleans up
  const within = (p, ms = 800) => Promise.race([p.then(v => ({ ended: 'resolved', v }), err => ({ ended: 'rejected', err })), new Promise(res => setTimeout(() => res({ ended: 'pending' }), ms))]);
  const rig = async (key, extra = [], files = {}) => {
    const was = [console.error, console.warn], said = [];
    console.error = console.warn = (...a) => said.push(a.join(' '));
    const E = mk(createEngine, key);
    E.assets.manifest({ name: 'st', models: { stTown: { build: async () => flat('town') }, stCave: { build: async () => flat('cave') }, ...files } });
    E.use(T.world(), T.content(), T.level({ url: 'stTown' }), ...extra);
    await E.start();
    // a save of this game without its level part, taken while idle, so a row can ask for one mid-load and the level stays what the row made it
    const base = E.saves.collect();
    delete base.parts.level;
    const save = (parts = {}) => ({ ...base, parts: { ...base.parts, ...parts }, versions: { ...base.versions, ...Object.fromEntries(Object.keys(parts).map(k => [k, 1])) } });
    return { E, said, save, root: () => E.level.root?.name ?? null, end() { E.dispose(); [console.error, console.warn] = was; } };
  };
  window.st = { flat, gate, tick, within, rig };
};

export const specs = [
  {
    name: 'state turn: an async load and an async afterLoad load a level and a pack inside their own replacement',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { tick, within, rig, flat } = st, out = {}, log = [];
        let hook = null;
        const R = await rig('st-in', [{ name: 'stHook', type: 'rules', skipKind: 'none', afterLoad: async (e, turn) => { if (hook) await hook(e, turn); } },
          { name: 'stProbe', type: 'rules', skipKind: 'none', content: { stProbe: { commit: d => { log.push(d); } } } }]);
        const { E, save } = R;
        E.saves.define('stTrip', { save: () => ({}), async load(d, turn) {
          await tick();
          if (d.how === 'level') await E.level.load('stCave', { turn });
          if (d.how === 'pack') await E.content.load({ level: 'stCave', stProbe: 'in pack' }, { turn });
          if (d.how === 'twice') { await E.level.load('stCave', { turn }); await tick(); await E.level.load(flat('built'), { turn }); await E.content.load({ stProbe: 'after two' }, { turn }); }
        } });
        const go = async how => { await within(E.level.load('stTown')); const v = await within(E.saves.apply(save({ stTrip: { how } }))); return { ended: v.ended, v: v.v, root: R.root(), replacing: E.saves.replacing }; };
        out.level = await go('level');
        out.pack = await go('pack');
        out.twice = await go('twice');
        hook = async (e, turn) => { await tick(); await e.level.load('stCave', { turn }); await e.content.load({ stProbe: 'in hook' }, { turn }); };
        out.hook = await go('none');
        hook = null;
        out.log = log;
        R.end();
        return out;
      });
      const done = (x, root) => x.ended === 'resolved' && x.v === true && x.root === root && x.replacing === false;
      check('an async load() that awaits level.load ends, on that level', done(r.level, 'cave'), J(r));
      check('an async load() that awaits a pack with a level ends, on that level', done(r.pack, 'cave') && r.log.includes('in pack'), J(r));
      check('nested: several awaited loads in one load()', done(r.twice, 'built') && r.log.includes('after two'), J(r));
      check('an async afterLoad that awaits level.load and a pack ends', done(r.hook, 'cave') && r.log.includes('in hook'), J(r));
    },
  },
  {
    name: 'state turn: outside requests wait in order, past every await; a turn that ended is no pass; a pack in the turn does not stand on one in line',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { gate, tick, within, rig } = st, out = {}, log = [];
        let held = null, kept = null;
        const release = () => { const h = held; held = null; h.open(); };
        const R = await rig('st-out', [{ name: 'stProbe', type: 'rules', skipKind: 'none', content: { stProbe: { prepare: d => d.wait ? d.wait.then(() => d) : d, commit: d => { log.push(d.say); } } } }]);
        const { E, save } = R;
        E.saves.define('stTrip', { save: () => ({}), async load(d, turn) {
          kept = turn;
          log.push('in ' + d.n);
          if (held) await held.p;
          if (d.pack) await E.content.load({ stProbe: { say: 'in turn' } }, { turn });
          log.push('out ' + d.n);
        } });
        // an outside level load and a second replacement asked after the first await: neither starts before it ended, and they run in the order asked
        held = gate();
        const a = E.saves.apply(save({ stTrip: { n: 1 } }));
        await tick();
        E.events.on('level:loading', () => log.push('level asked'));
        const lvl = E.level.load('stCave');
        const b = E.saves.apply(save({ stTrip: { n: 2 } })).then(() => log.push('B done'));
        await tick(); await tick();
        out.before = { root: R.root(), log: [...log] };
        release();
        await within(a); await within(lvl); await within(b);
        out.order = [...log]; log.length = 0;
        // an object that is no turn, and a turn that ended, prove nothing: they go in line
        held = gate();
        const c = E.saves.apply(save({ stTrip: { n: 3 } }));
        await tick();
        const lv2 = E.level.load('stTown', { turn: {} });
        await tick(); await tick();
        out.unknown = R.root();
        release();
        await within(c); await within(lv2);
        const ended = kept;
        held = gate();
        const d = E.saves.apply(save({ stTrip: { n: 4 } }));
        await tick();
        const lv3 = E.level.load('stCave', { turn: ended });
        await tick(); await tick();
        out.ended = { root: R.root(), differs: ended !== kept };
        release();
        await within(d); await within(lv3);
        // a pack in line behind the replacement must not hold up the pack inside it: that one would wait for itself in a longer circle
        log.length = 0;
        held = gate();
        const e1 = E.saves.apply(save({ stTrip: { n: 5, pack: true } }));
        await tick();
        const line = E.content.load({ stProbe: { say: 'in line', wait: Promise.resolve() } });
        await tick(); await tick();
        release();
        out.circle = (await within(e1)).ended;
        await within(line);
        out.circleLog = [...log];
        R.end();
        return out;
      });
      check('nothing of the outside requests ran while the part waited', r.before.root === 'town' && r.before.log.join() === 'in 1', J(r));
      check('they ran after it, in the order asked (a level change does not hold the turn)', r.order.join() === 'in 1,out 1,level asked,in 2,out 2,B done', J(r.order));
      check('an unknown turn goes in line', r.unknown === 'cave', J(r));
      check('a turn that ended goes in line', r.ended.root === 'town' && r.ended.differs, J(r));
      check('a pack in the turn ends though a pack waits in line, and goes first', r.circle === 'resolved' && r.circleLog.join() === 'in 5,in turn,out 5,in line', J(r));
    },
  },
  {
    name: 'state turn: a request asked inside a load without its turn waits in line, and dev says why when it stalls; a replacement asked from a load runs after it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { gate, tick, within, rig } = st, out = {};
        const R = await rig('st-stall');
        const { E, save, said } = R;
        const free = gate();
        let lvl = null;
        E.saves.define('stNaked', { save: () => ({}), async load() { await tick(); lvl = E.level.load('stCave'); await Promise.race([lvl, free.p]); } });
        const a = E.saves.apply(save({ stNaked: {} }));
        for (let i = 0; i < 100 && !said.some(s => /save-nested/.test(s)); i++) await new Promise(res => setTimeout(res, 50));
        out.told = said.find(s => /save-nested/.test(s)) ?? null;
        free.open();
        out.a = (await within(a)).ended;
        E.saves.providers.delete('stNaked');
        await within(lvl);
        out.root = R.root();
        let inner = null;
        const seen = [];
        E.saves.define('stNest', { save: () => ({}), load(d) { seen.push(d.n); if (d.n === 1) inner = E.saves.apply(save({ stNest: { n: 2 } })); } });
        out.nest = (await within(E.saves.apply(save({ stNest: { n: 1 } })))).ended;
        out.inner = (await within(inner)).ended;
        out.seen = seen;
        R.end();
        return out;
      });
      check('dev names the code and the way out', /save-nested/.test(r.told ?? '') && /turn/.test(r.told ?? ''), J(r));
      check('the request still ran, after the replacement', r.a === 'resolved' && r.root === 'cave', J(r));
      check('a replacement asked from a load() runs after it', r.nest === 'resolved' && r.inner === 'resolved' && r.seen.join() === '1,2', J(r));
    },
  },
  {
    name: 'state turn: a late part loads in its own turn, after the replacement it arrived during, and never over a newer one',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { gate, tick, within, rig } = st, out = {}, log = [];
        let hooks = 0;
        const R = await rig('st-late', [{ name: 'stHook', type: 'rules', skipKind: 'none', afterLoad: () => { hooks++; } }]);
        const { E, save } = R, S = E.saves;
        const held = gate();
        S.define('stSlow', { save: () => ({}), async load() { log.push('slow in'); await held.p; log.push('slow out'); } });
        const a = S.apply(save({ stSlow: {}, stLate: { v: 1 } }));
        await tick();
        // both halves: the line before its first await and the line after it stay out of the running replacement
        S.define('stLate', { save: () => ({}), load: async (d, turn) => { log.push('late in'); out.lateTurn = !!turn; await tick(); await E.level.load('stCave', { turn }); log.push('late out'); } });
        await tick(); await tick();
        out.during = [...log];
        held.open();
        await within(a);
        await within(S.settled());
        out.after = [...log]; out.root = R.root();
        S.providers.delete('stLate'); S.providers.delete('stSlow');
        // a sync part registered with only afterLoad left: it waits too, and does not take the replacement's afterLoad over
        hooks = 0; log.length = 0;
        const b = S.apply(save({ stLate2: { v: 2 } }));
        S.define('stLate2', { save: () => ({}), load: d => { log.push('late2 ' + d.v); } });
        out.syncAt = [...log];
        await within(b); await within(S.settled());
        out.hooks = hooks; out.sync = [...log];
        S.providers.delete('stLate2');
        // idle it is at once, as before
        await within(S.apply(save({ stLate3: { v: 3 } })));
        log.length = 0;
        S.define('stLate3', { save: () => ({}), load: d => { log.push('late3 ' + d.v); } });
        out.idle = [...log];
        S.providers.delete('stLate3');
        // a newer load was asked first: the state the late data belonged to is gone when its turn comes
        const gate2 = gate();
        S.define('stSlow2', { save: () => ({}), load: async d => { if (d.first) await gate2.p; } });
        const c = S.apply(save({ stSlow2: { first: true }, stLate4: { v: 'old' } }));
        const d2 = S.apply(save({ stSlow2: {} }));
        await tick();
        log.length = 0;
        S.define('stLate4', { save: () => ({}), load: d => { log.push('late4 ' + d.v); } });
        gate2.open();
        await within(c); await within(d2); await within(S.settled());
        out.gone = [...log];
        R.end();
        return out;
      });
      check('neither half of a late load() runs during the replacement', r.during.join() === 'slow in', J(r));
      check('it runs after it, with a turn of its own that level.load accepts', r.after.join() === 'slow in,slow out,late in,late out' && r.lateTurn === true && r.root === 'cave', J(r));
      check('a sync part arriving with only afterLoad left waits, and the afterLoad still ran', r.syncAt.length === 0 && r.sync.join() === 'late2 2' && r.hooks === 2, J(r));   // 2: the replacement's afterLoad, then the late part's own (it loads by the same protocol)
      check('[guard] idle: a late part loads before register returns', r.idle.join() === 'late3 3', J(r));
      check('data of a state a newer load replaced does not land', r.gone.length === 0, J(r));
    },
  },
  {
    name: 'state turn: a failed pack ends only when the old level and registrations are back; a failed restore reaches the caller; what is in line waits for it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { gate, tick, within, rig, flat } = st, out = {};
        let hold = null, broken = false;
        const R = await rig('st-tx', [{ name: 'stBoom', type: 'rules', skipKind: 'none', content: { stBoom: { commit() { throw new Error('late commit failed'); } } } }],
          { stOld: { build: async () => { if (hold) await hold.p; if (broken) throw new Error('restore failed'); return flat('old'); } } });
        const { E, save } = R;
        await E.level.load('stOld');
        E.events.on('level:failed', ({ error }) => { out.levelFailed = error?.message; });
        // the place is a registration: it must be gone at the same moment the level is back
        hold = gate();
        const snap = save();
        let endedAt = null, fail = null;
        const load = (async () => E.content.load({ level: flat('new'), stBoom: 1 }, { places: { stHome: { x: 1, z: 1 } } }))();
        const watched = load.then(() => 'resolved', err => { endedAt = R.root(); fail = err; return 'rejected'; });
        await tick(); await tick();
        out.waiting = { pending: (await within(watched, 60)).ended === 'pending', replacing: E.saves.replacing };
        // a save and a replacement asked while the old level is on its way must not see the gap, nor be written over
        let saved = null;
        const line = E.saves.save('stGap').then(() => { saved = R.root(); });
        const apply = E.saves.apply(snap);
        await tick();
        out.savedEarly = saved;
        hold.open(); hold = null;
        await watched; await line; await apply;
        out.msg = fail?.message; out.endedAt = endedAt; out.saved = saved; out.notRestored = fail?.notRestored ?? null;
        out.place = E.content.place('stHome');
        out.root = R.root();
        // the restore itself fails: the caller hears both, and the level says so as any level does
        broken = true;
        const bad = await within((async () => E.content.load({ level: flat('new2'), stBoom: 1 }))());
        broken = false;
        out.bad = { ended: bad.ended, msg: bad.err?.message, restore: bad.err?.notRestored?.map(x => x.message) ?? null, levelFailed: out.levelFailed };
        // a pack with nothing to wait for keeps its answer on the line
        let thrown = null;
        await E.level.load('stCave');
        try { E.content.load({ stBoom: 1 }); } catch (e2) { thrown = e2.message; }
        out.thrown = thrown;
        R.end();
        return out;
      });
      check('while the old level is on its way the pack has not ended and gameplay reads as loading', r.waiting.pending === true && r.waiting.replacing === true, J(r));
      check('a save asked in the gap waits for it', r.savedEarly === null && r.saved === 'old', J(r));
      check('it ends with the error, the old level up, the registration gone', /late commit/.test(r.msg ?? '') && r.endedAt === 'old' && r.root === 'old' && r.place == null && r.notRestored === null, J(r));
      check('a restore that fails reaches the caller with the first error', r.bad.ended === 'rejected' && /late commit/.test(r.bad.msg ?? '') && r.bad.restore?.join().includes('restore failed') && /restore failed/.test(r.bad.levelFailed ?? ''), J(r));
      check('[guard] a pack with nothing to wait for still throws on the line', /late commit/.test(r.thrown ?? ''), J(r));
    },
  },
  {
    name: 'state turn: content.load answers for its own load',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { gate, tick, within, rig } = st, out = {}, log = [];
        const unhandled = [], seen = e => { unhandled.push(String(e.reason?.message ?? e.reason)); e.preventDefault(); };
        window.addEventListener('unhandledrejection', seen);
        const slow = gate();
        const R = await rig('st-own', [{ name: 'stProbe', type: 'rules', skipKind: 'none', content: { stProbe: { prepare: d => d.wait ? d.wait.then(() => d) : d, commit: d => { log.push(d.say); } } } }],
          { stBad: { build: async () => { throw new Error('no such file'); } } });
        const { E } = R;
        const sync = E.content.load({ stProbe: { say: 'now' } });
        out.liveNow = log.join();
        out.thenable = typeof sync?.then;
        await sync;
        const later = Promise.resolve(E.content.load({ stProbe: { say: 'later', wait: slow.p } }));
        out.waits = (await within(later, 30)).ended;
        slow.open();
        out.later = (await within(later)).ended;
        out.log = log.join();
        const a = Promise.resolve(E.content.load({ level: 'stBad', stProbe: { say: 'never' } })), b = Promise.resolve(E.content.load({ stProbe: { say: 'behind' } }));
        const [ra, rb] = [await within(a), await within(b)];
        out.bad = { a: ra.ended, msg: ra.err?.message, b: rb.ended, root: R.root(), log: log.join() };
        // nobody awaits it: it is reported the old way and is no unhandled rejection
        E.content.load({ level: 'stBad' });
        await E.saves.settled(); await tick(); await new Promise(res => setTimeout(res, 40));
        out.unhandled = unhandled;
        window.removeEventListener('unhandledrejection', seen);
        R.end();
        return out;
      });
      check('it is a Promise, and a pack with nothing to wait for is live on the next line', r.thenable === 'function' && r.liveNow === 'now', J(r));
      check('it waits for this pack', r.waits === 'pending' && r.later === 'resolved' && r.log === 'now,later', J(r));
      check('a failure rejects this load and the one standing on it, not only a log', r.bad.a === 'rejected' && /no such file/.test(r.bad.msg ?? '') && r.bad.b === 'rejected' && r.bad.root === 'town' && r.bad.log === 'now,later', J(r));
      check('an unawaited failure is no unhandled rejection', r.unhandled.length === 0, J(r.unhandled));
    },
  },
  {
    name: '[guard] state turn: a task of the old state ends with it, and one a save:loaded or session:start listener starts for the new state survives the replacement',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { tick, rig } = st, ended = [];
        const R = await rig('st-tasks');
        const { E, save } = R;
        const task = name => E.control.take('walker ' + name, { owner: name, task: why => ended.push(`${name} ${why}`) });
        const once = (event, name) => { const h = E.events.on(event, () => { h.remove(); task(name); }); };
        task('old');
        once('save:loaded', 'after a load');
        await E.saves.apply(save());
        await tick();
        const load = [...ended];
        ended.length = 0;
        task('old too');
        once('session:start', 'in a new game');
        await E.session.newGame();
        await tick();
        const out = { load, game: [...ended] };
        R.end();
        return out;
      });
      check('apply: the old task ended, the new one runs on', r.load.join() === 'old replaced', J(r));
      check('new game: the same', r.game.includes('old too replaced') && !r.game.some(x => x.startsWith('in a new game')), J(r));
    },
  },
  {
    name: '[guard] state turn: identity is passed, never guessed',
    url: PAGE,
    async run({ check }) {
      const src = f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8').replace(/^\s*(\/\/|\/?\*).*$/gm, '').replace(/\/\*\*.*?\*\//g, '');
      const q = src('core/saves/stateReplace.js'), apply = src('core/saves/saveApply.js'), lvl = src('modules/level/load.js'), idx = src('modules/level/index.js'), loader = src('modules/content/loader.js');
      check('no marker that lives on the call stack decides who a call belongs to', !/\.inside\b|\.within\(/.test(q + apply), 'stateReplace.js / saveApply.js');
      check('every whenTurnFree hands on a turn', [...(idx + loader).matchAll(/whenTurnFree\(.*$/gm)].every(m => /turn\)/.test(m[0])), 'level/index.js, content/loader.js');
      check('a late part is loaded inside the queued function, not before it', /adoptPart[\s\S]*?\.run\(null, \(\) => \{[\s\S]*?applyRead\(/.test(apply), 'saveApply.js adoptPart');
      check('the undo of a level swap hands its reload back: no background load, no swallowed failure', !/\.catch\(\(\) => \{\}\)/.test(lvl), 'level/load.js');
    },
  },
];
