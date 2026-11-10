// The one perf line (engine.budget.notice()) and what feeds it: module timing is a median with p95 beside it (one slow frame does not move the
// median, spikes still show), the line names an overrun of limits the GAME declared (per-module ms too, never the engine's own reference limits),
// a regression against a baseline recorded at the same key (from 0 and new modules too), spikes, and a lowered resolution, and says nothing when
// all is fine. shot / verify / describeText only print this string, so the logic is guarded here once.
export const specs = [
  {
    serial: true,   // timing assertion: runs alone, not beside other pages
    name: 'PERF notice：模块计时取中位数并给 p95，超预算、比基线慢、尖峰、自动降分辨率各报一行，没事不报',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const burn = ms => { const t = performance.now(); while (performance.now() - t < ms); };
        // phase 1: 2 ms on most frame-hook cycles, 25 ms on every fifth (average ~6.6 ms, median 2, p95 25): spiky
        let n = 0, spikes = true;
        engine.use({ name: 'perfburn', type: 'rules', frame() { burn(spikes && ++n % 5 === 0 ? 25 : 2); } });
        const a = engine.adaptive, was = { on: a.on, lowered: a.lowered, max: a.max, reason: a.reason };
        a.on = false; a.lowered = false;   // the software-rendered page may have lowered it already: start from "not lowered"
        const b = engine.budget, out = {};
        engine.profile(true);
        engine.step(2);   // 60 frame-hook cycles
        out.p1 = engine.profile().perfburn;
        b.enable({ drawCalls: 1e9, triangles: 1e9 });
        out.spiky = b.notice();
        // the start-up clear: the page settled long ago (flag set); run it again here, so the spikes above are "before settle": they drop out
        out.settledOnPage = engine._playTiming;
        engine._playTiming = false; engine._settleTick = 0; spikes = false;   // _settleTick 0: the next cycle runs the (every-30th) settle check
        engine.step(1 / 30);   // one frame-hook cycle: the settle check clears the ring
        out.clearedOnce = engine._playTiming;
        engine.step(1);
        out.afterSettleSteady = b.notice();
        spikes = true; engine.step(2);   // a burst after settle
        out.afterSettleBurst = b.notice();
        // phase 2: steady 2 ms over the whole 300-cycle window
        spikes = false; engine.profile(true); engine.step(10);
        const med = engine.profile().perfburn.ms;
        out.fine = b.notice();
        // the engine's own reference limit (gameLights' lights, limit 8) over: report() has it, the notice does not
        const lm = b.metrics.get('lights'), read0 = lm.read;
        lm.read = () => 99;
        out.engineLimit = { report: b.report().over.map(o => o.category), notice: b.notice(), limit: b.limitOf('lights') };
        lm.read = read0;
        b.enable({ drawCalls: 1, modules: { perfburn: 0.5 } });
        out.over = b.notice();
        out.describe = engine.describe().perf.notice;
        out.text = engine.describeText();
        b.enable({ drawCalls: 1e9 });
        const rec = b.record(), mods = rec.values.modules;
        out.rec = rec;
        b.baseline = { [rec.where]: rec.values };
        out.same = b.notice();   // the same numbers: nothing slower
        b.baseline = { [rec.where]: { ...rec.values, modules: { ...mods, perfburn: med / 4 }, drawCalls: Math.floor(rec.values.drawCalls / 2) } };
        out.slower = b.notice();
        b.baseline = { [rec.where]: { ...rec.values, modules: { ...mods, perfburn: 0 } } };
        out.fromZero = b.notice();
        const { perfburn: _gone, ...without } = mods;
        b.baseline = { [rec.where]: { ...rec.values, modules: without } };
        out.newModule = b.notice();
        b.baseline = { [rec.where.replace(/ \d+x\d+@/, ' 1x1@')]: { ...rec.values, modules: without } };
        out.otherKey = b.notice();   // recorded with another canvas size: compared with nothing
        b.baseline = null;
        Object.assign(a, { lowered: true, max: engine.renderer.getPixelRatio() + 0.5, reason: 'frames cost 30 ms (test)' });
        out.lowered = b.notice();
        Object.assign(a, was);
        b.disable();
        return { ...out, med };
      });
      check('profile() gives median, mean and p95: every fifth frame at 25 ms leaves the median at 2 ms, lifts the mean and p95',
        r.p1.ms >= 1.5 && r.p1.ms < 4 && r.p1.mean > 4 && r.p1.p95 > 15, JSON.stringify(r.p1));
      check('a module whose p95 is over 3x its median and over 2 ms is marked spiky', /^Perf: spiky: perfburn \(p95 [\d.]+ ms, median [\d.]+\)/.test(r.spiky ?? ''), String(r.spiky));
      check('start-up spikes (before the first settled frame) leave no spiky marker; a burst after it does', r.settledOnPage && r.clearedOnce
        && !/spiky/.test(r.afterSettleSteady ?? '') && /spiky: perfburn/.test(r.afterSettleBurst ?? ''), JSON.stringify([r.settledOnPage, r.afterSettleSteady, r.afterSettleBurst]));
      check('steady, within the game\'s own limits, no baseline, resolution not lowered: no line', r.fine === null && r.med >= 1.5 && r.med < 4, `${r.fine} (median ${r.med})`);
      check('the engine\'s own lights limit over: in report(), never in the notice', r.engineLimit.report.includes('lights') && r.engineLimit.notice === null && r.engineLimit.limit === 8, JSON.stringify(r.engineLimit));
      check('over budget names the category, the limit and by how much', /^Perf: over budget drawCalls \d+ \(limit 1, \+\d+%\)/.test(r.over ?? ''), String(r.over));
      check('a per-module limit (modules: { perfburn: 0.5 }) is checked against its median', /modules\.perfburn [\d.]+ ms \(limit 0\.5/.test(r.over ?? ''), String(r.over));
      check('describe().perf.notice is the same line, and describeText prints it', r.describe === r.over && r.text.includes(r.over), String(r.describe));
      check('record() keys by GPU, canvas size and pixel ratio, and keeps every module (zeros too)', / \d+x\d+@[\d.]+ @/.test(r.rec.where) && r.rec.values.modules.perfburn > 0
        && Object.values(r.rec.values.modules).some(v => v === 0), JSON.stringify(r.rec).slice(0, 300));
      check('the same numbers as the baseline: nothing reported', r.same === null, String(r.same));
      check('slower than the baseline at this key: the module and the draw calls, with was and the change', /slower than baseline: .*modules\.perfburn [\d.]+ ms \(was [\d.]+, \+\d+%\)/.test(r.slower ?? '') && /drawCalls \d+ \(was \d+/.test(r.slower ?? ''), String(r.slower));
      check('a module that was 0 in the baseline and now costs over 0.2 ms shows (was 0)', /modules\.perfburn [\d.]+ ms \(was 0\)/.test(r.fromZero ?? ''), String(r.fromZero));
      check('a module the baseline lacks shows as new', /modules\.perfburn [\d.]+ ms \(new\)/.test(r.newModule ?? ''), String(r.newModule));
      check('a baseline under another key (canvas size) compares nothing', r.otherKey === null, String(r.otherKey));
      check('a resolution adaptive resolution lowered is named with from and to', /lowered automatically: resolution [\d.]+ -> [\d.]+ \(frames cost 30 ms/.test(r.lowered ?? ''), String(r.lowered));
    },
  },
  {
    // 不许绕开：模块计时里固定步只算一步（这一帧最贵的那步）。为什么：慢帧要补跑好几步、step() 每轮跑 frameEvery 步，
    // 原来把几步加起来，帧率一低物理就被报成"尖峰"（开放世界软件渲染下 rigid 中位 0.7 / p95 3.9 ms，单步其实约 0.2 ms）
    serial: true,   // timing assertion: runs alone, not beside other pages
    name: 'PERF profile：固定步按一步计时（补跑的步不算进模块），单步的尖峰照样看得见',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const burn = ms => { const t = performance.now(); while (performance.now() - t < ms); };
        let n = 0;   // 1 ms every step, 8 ms on every 30th: with 6 steps per cycle one cycle in five holds the dear step
        engine.use({ name: 'perfstep', type: 'rules', fixed() { burn(++n % 30 === 0 ? 8 : 1); } });
        engine.profile(true);
        engine.step(4, { render: false, describe: false, frameEvery: 6 });   // 240 steps in 40 cycles, as a slow frame catching up
        const p = engine.profile().perfstep;
        engine.unuse('perfstep');
        return p;
      });
      check('six steps in a cycle count as one: the median is one step (about 1 ms), not six', r.ms >= 0.8 && r.ms < 2.5, JSON.stringify(r));
      check('the cycle holding the 8 ms step shows it in full (p95 at the dear step, not averaged away)', r.p95 >= 6 && r.p95 < 12, JSON.stringify(r));
    },
  },
];
