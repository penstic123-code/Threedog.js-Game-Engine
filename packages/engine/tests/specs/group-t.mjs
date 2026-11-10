// [守] 第二层复核 T 组（docs/plans/2026-11-09-group-t.md）：时间、声音的结束 / 卸载 / 身份 / 基线 / 时间契约。每条在对应修复撤掉时会红。
const PAGE = '/tests/threads/';
const run = (name, body, extra = []) => ({
  name: `[守] group T: ${name}`, url: PAGE,
  async run({ check, ev }) {
    const r = await ev(body);
    for (const [label, ok] of extra) check(label, ok(r), JSON.stringify(r));
  },
});

export const specs = [
  run('a dropped cutscene leaves tween values where they are; only a skip completes them', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-drop'); E.use(T.world(), T.timeline()); await E.start();
    const a = { x: 0 }, b = { x: 0 }, out = {};
    const p = E.timeline.play([{ tween: { target: a, to: { x: 10 }, duration: 1 } }], { actors: [] });
    E.step(0.5, { render: false }); out.mid = a.x;
    E.timeline._drop(); E.step(0.1, { render: false }); out.dropped = a.x; out.ending = (await p).ending;
    const q = E.timeline.play([{ tween: { target: b, to: { x: 10 }, duration: 1 } }], { actors: [] });
    E.step(0.3, { render: false }); E.timeline.skip(); out.skipped = b.x; out.ending2 = (await q).ending;
    E.dispose(); return out;
  }, [['dropped: the value stays at the loaded state (< 10), run ends dropped', r => r.dropped < 10 && Math.abs(r.dropped - r.mid) < 1.5 && r.ending === 'dropped'],
      ['a skip leaves the end value and ends the run', r => r.skipped === 10 && r.ending2 === 'skipped']]),

  run('unloading timeline ends direct tweens and removes the letterbox bars', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-unload'); E.use(T.world(), T.timeline()); await E.start();
    const o = { x: 0 }, tl = E.timeline, out = {};
    let state = 'pending'; tl.tween(o, { x: 5 }, { duration: 5 }).then(() => { state = 'done'; }, () => { state = 'rejected'; });
    E.step(0.2, { render: false });
    out.bars = E.uiRoot.querySelectorAll('.threedog-letterbox').length;
    E.unuse('timeline'); E.step(0.1, { render: false });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    out.state = state; out.tasks = tl._tweener.list.length; out.barsAfter = E.uiRoot.querySelectorAll('.threedog-letterbox').length;
    E.dispose(); return out;
  }, [['the tween task is gone and its promise settled', r => r.tasks === 0 && r.state !== 'pending'], ['two bars before, none after', r => r.bars === 2 && r.barsAfter === 0]]),

  run('audio bus remove() is by identity: a stale handle does not delete a newer bus of the same name', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-bus'); await E.start();
    const a = E.audio, h1 = a.addBus('gtv'); h1.remove();
    const h2 = a.addBus('gtv'); h1.remove();
    const out = { kept: 'gtv' in a.levels }; h2.remove(); h2.remove(); out.gone = !('gtv' in a.levels);
    E.dispose(); return out;
  }, [['the newer bus survives the stale remove, and its own remove (twice) works', r => r.kept && r.gone]]),

  run('calendar: a callback removing a later entry stops it; a catch-up callback removing itself stops the rest', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-sched'); E.use(T.world(), T.calendar({ time: '05:00', dayLength: 240 })); await E.start();
    const out = { b: 0, c: 0 }; let hB, hC;
    E.calendar.at('06:00', () => { hB.remove(); });
    hB = E.calendar.at('06:00', () => { out.b++; });
    hC = E.calendar.at('06:00', () => { out.c++; hC.remove(); }, { catchUp: 'all' });
    E.step(0.1, { render: false });
    E.step(20, { render: false });   // 05:00 -> 07:00
    E.step(240 * 4, { render: false });   // several days: 'all' would call c once per day if it kept running after removing itself
    E.dispose(); return out;
  }, [['B never ran', r => r.b === 0], ['C ran once, not once per crossed day', r => r.c === 1]]),

  run('calendar: the first step after install and after a load still fires the mark it crosses; onSeason listeners go with the module', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-base');
    E.use(T.world(), T.calendar({ time: '05:59', dayLength: 240, seasons: ['spring', 'summer'] })); await E.start();
    let n = 0, seasons = 0; const out = {};
    E.calendar.at('06:00', () => { n++; });
    E.calendar.onSeason('summer', () => { seasons++; });
    E.step(0.5, { render: false }); out.first = n;   // 05:59 + 0.5 s (= 3 min) crosses 06:00 on the very first step
    E.calendar.timeOfDay = (5 * 60 + 59.9) / 1440;
    await E.saves.save('gt-base');
    E.step(5, { render: false });
    await E.saves.load('gt-base'); out.clock = E.calendar.clock; out.last = E.calendar._sched.last; out.tot = E.calendar.totalDays;
    n = 0; E.step(0.5, { render: false }); out.second = n;
    E.unuse('calendar'); E.events.emit('season:change', 'summer'); out.seasons = seasons;
    E.dispose(); return out;
  }, [['first step after install fires', r => r.first === 1], ['a step after a load fires the mark it crosses', r => r.second === 1], ['unloaded calendar: its onSeason callback is silent', r => r.seasons === 0]]),

  run('calendar: day / time written at engine:ready (before any step) are a set, not elapsed time: the first step fires no alarm', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-ready'); E.use(T.world(), T.calendar({ time: '05:00', dayLength: 240 }));
    const out = { daily: 0, at: 0 };
    E.calendar.daily(() => { out.daily++; }, { catchUp: 'all' }); E.calendar.at('17:00', () => { out.at++; });
    E.events.on('engine:ready', () => { E.calendar.day = 30; E.calendar.timeOfDay = 18 / 24; });
    await E.start();
    E.step(0.1, { render: false }); out.first = { daily: out.daily, at: out.at, clock: E.calendar.clock };
    E.dispose(); return out;
  }, [['no alarm fired on the first step', r => r.first.daily === 0 && r.first.at === 0 && /^18:/.test(r.first.clock)]]),

  run('calendar: applyState({ time }) before any step is a set; the wait after it is elapsed time and fires the alarm once', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-wait'); E.use(T.world(), T.calendar({ time: '05:00', dayLength: 240 }));
    const out = { n: 0, early: 0 };
    E.calendar.at('08:00', () => { out.n++; }); E.calendar.at('06:00', () => { out.early++; });
    await E.start();
    await E.applyState({ time: '07:59', wait: 1 });   // 1 s = 6 game minutes: crosses 08:00
    E.dispose(); return out;
  }, [['at 08:00 fired once, 06:00 (jumped over by the set) not at all', r => r.n === 1 && r.early === 0]]),

  run('music: a stinger that loads after unload does not play; a playing one is stopped; a natural end disconnects the track gain', async () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'gt-music');
    E.use(T.music({ tracks: { win: '/w.ogg', song: { url: '/s.ogg', loop: false } } })); await E.start();
    const m = E.music, a = E.audio, out = { removed: 0, disc: 0 };
    Object.defineProperty(a, 'running', { get: () => true });
    const param = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
    const node = () => ({ gain: param, connect() {}, disconnect() { out.disc++; } });
    m.output = node();
    a.ctx = { currentTime: 0, createGain: node, createBufferSource: () => ({ connect() {}, start() {}, stop() {}, addEventListener() {} }), close() {} };
    a.load = async () => ({});
    const waiting = []; a.play = () => new Promise(res => waiting.push(res));
    const handle = () => ({ source: { buffer: { duration: 1 }, addEventListener() {} }, remove() { out.removed++; } });
    m.stinger('win'); m.stinger('win');
    waiting[0](handle()); await Promise.resolve(); await Promise.resolve();   // the first one is sounding
    E.unuse('music'); out.stoppedPlaying = out.removed;
    waiting[1](handle()); await new Promise(r => setTimeout(r, 0)); out.afterLate = out.removed;   // the second loads late
    // natural end through the real play path of a second engine
    const E2 = mk(T.createEngine, 'gt-music2'); E2.use(T.music({ tracks: { song: { url: '/s.ogg', loop: false } } })); await E2.start();
    const m2 = E2.music, a2 = E2.audio;
    Object.defineProperty(a2, 'running', { get: () => true });
    m2.output = node(); a2.ctx = a.ctx; a2.load = async () => ({});
    m2.play('song', { fade: 0 }); await new Promise(r => setTimeout(r, 0));
    const slot = m2.playing; out.disc = 0; out.hadSrc = !!slot?.srcs[0];
    slot.srcs[0].onended(); out.natural = out.disc; out.cleared = m2.playing === null;
    E.dispose(); E2.dispose(); return out;
  }, [['unloading stops the sounding stinger', r => r.stoppedPlaying === 1], ['a stinger loaded after unload is removed at once', r => r.afterLate === 2],
      ['natural end disconnects the gain and clears playing', r => r.hadSrc && r.natural === 1 && r.cleared]]),

  {
    name: '[守] group T: frame hooks get the same clamped dt as fixed steps: at most 0.1 s after a stall, 0 after a hidden tab',
    url: '/',
    async run({ check, ev, frames }) {
      await ev(() => {
        window.__dts = [];
        engine.use({ name: 'dtprobe', skipKind: 'none', type: 'rules', label: 'dtprobe', frame(dt) { window.__dts.push(dt); } });
      });
      await frames(3);
      await ev(() => new Promise(res => requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 320); res(); })));   // a 0.3 s stall
      await frames(3);
      const stall = await ev(() => Math.max(...window.__dts));
      await ev(() => { window.__dts.length = 0; const p = engine.page, c = p.consumeResync.bind(p); let once = true; p.consumeResync = () => { if (once) { once = false; return true; } return c(); }; });
      await frames(2);
      const first = await ev(() => window.__dts[0]);
      check('a 0.3 s stall reaches frame hooks as at most 0.1', stall <= 0.1 + 1e-9, String(stall));
      check('the frame after a resync gets dt 0', first === 0, String(first));
    },
  },
];
