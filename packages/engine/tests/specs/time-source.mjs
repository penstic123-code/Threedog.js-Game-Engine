// 一个时间来源（core/time/time.js）的"不许绕开"检查：
//   1. 跳过（skip）和一步步推（step）在所有时间视图上结果一样（tick、real、ambient、各通道、日历），定时也按同样顺序触发；
//   2. 新一局把所有视图一起清零（tick 也清，以前漏了）；
//   3. 同一步里被取消的定时不再触发（以前同一帧还会触发）；
//   4. 没有第二个计数器：静态检查 core/、modules/、render/ 和 packages/post-effects 里只有 time.js 在累加时间（后期效果的时间也读 engine.time）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../..', import.meta.url));
// Each pattern is one way a second counter came back before: tick++ outside time.js, uTime written by hand, a clock view written, `+= STEP` on a field
const BAD = [/\.tick\s*(\+\+|\+=)/, /\+\+\s*[\w.]*\.tick\b/, /uTime\.value\s*\+?=[^=]/, /\b(clock|time)\.\w*(now|real|elapsed|ambient)\s*\+?=[^=]/, /\.\w+\s*\+=\s*STEP\b/];

// Not game time: the film-grain phase of the post pass and the outline's wobble phase are frame-driven noise that wraps at 64 (render/fuse.js, post-effects/outline.js), like the UI page clock
const EXEMPT = [join('render', 'fuse.js'), join('post-effects', 'outline.js')];

function sources(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out); else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}

export const specs = [
  {
    name: 'TIME 一个时间来源：skip 与 step 在每个时间视图上一致，定时顺序一致 [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = engine.time;
        T.channel('tsEnemies');
        const views = () => ({ tick: T.tick, real: T.now('real'), ambient: T.now('ambient'), uTime: engine.uniforms.uTime.value,
          world: T.now('world'), player: T.now('player'), enemies: T.now('tsEnemies'), calendar: engine.clock.now });
        const diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, Math.round((b[k] - a[k]) * 1e6) / 1e6]));
        const log = [];
        const arm = () => [
          engine.clock.after(2.5, () => log.push('real'), { channel: 'real' }),
          engine.clock.after(1.5, () => log.push('enemies'), { channel: 'tsEnemies' }),
          engine.clock.after(4 * engine.clock.speed, () => log.push('calendar')),
        ];
        await engine.session.newGame();   // both runs start from the same fresh playthrough (it also drops mods, so take it after)
        let h = engine.mod('time.tsEnemies', { owner: 'ts-test', mul: 0.5 });
        let a = views(), hs = arm();
        engine.step(6, { render: false, describe: false });
        const stepped = diff(a, views()), stepLog = log.join(',');
        hs.forEach(x => x.remove()); log.length = 0;
        await engine.session.newGame();
        h = engine.mod('time.tsEnemies', { owner: 'ts-test', mul: 0.5 });
        a = views(); hs = arm();
        await engine.skip({ seconds: 6 * engine.clock.speed });
        const skipped = diff(a, views()), skipLog = log.join(',');
        hs.forEach(x => x.remove()); h.remove();
        return { stepped, skipped, stepLog, skipLog };
      });
      const keys = Object.keys(r.stepped).filter(k => Math.abs(r.stepped[k] - r.skipped[k]) > 1e-3);
      check('every time view moved the same by skip as by step (tick, real, ambient, uTime, world, player, a channel at 0.5x, calendar)',
        keys.length === 0 && r.stepped.tick === 360, JSON.stringify(r));
      check('timers on real, a channel and the calendar fired in the same order', r.stepLog === r.skipLog && r.stepLog === 'real,enemies,calendar', `${r.stepLog} / ${r.skipLog}`);
    },
  },
  {
    name: 'TIME 一个时间来源：新一局把所有视图一起清零；被取消的定时同一步不触发 [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = engine.time, base = JSON.parse(engine.session._base).parts.time.channels;
        engine.step(3, { render: false, describe: false });
        const played = { tick: T.tick, real: T.now('real') };
        await engine.session.newGame();
        const fresh = { tick: T.tick, real: T.now('real'), ambient: T.now('ambient'), uTime: engine.uniforms.uTime.value,
          world: T.now('world'), calendar: engine.clock.now, base };
        // two timers due in the same step: the first removes the second (and an every timer), neither may fire
        const fired = [];
        let b = null, c = null;
        engine.clock.after(0.5, () => { fired.push('a'); b.remove(); c.remove(); }, { channel: 'real' });
        b = engine.clock.after(0.5, () => fired.push('b'), { channel: 'real' });
        c = engine.clock.every(0.5, () => fired.push('c'), { channel: 'real' });
        engine.step(1, { render: false, describe: false });
        let wrote = '';
        try { engine.clock.now = 5; } catch (err) { wrote = String(err.message); }
        return { played, fresh, fired: fired.join(','), wrote };
      });
      const f = r.fresh;
      check('new game: tick, real, ambient and uTime are 0', f.tick === 0 && f.real === 0 && f.ambient === 0 && f.uTime === 0 && r.played.tick > 0, JSON.stringify(r));
      check('new game: the channels and the calendar are the new-game save values', f.world === f.base.world && f.calendar === f.base.calendar, JSON.stringify(f));
      check('a timer removed by an earlier callback in the same step does not fire', r.fired === 'a', r.fired);
      check('engine.clock.now is read-only (the error names engine.skip)', r.wrote.includes('engine.skip'), r.wrote);
    },
  },
  {
    name: 'TIME 一个时间来源：静态检查，只有 core/time/time.js 累加时间（没有第二个计数器） [guard]',
    url: '/?threedog-headless',
    async run({ check }) {
      const hits = [];
      for (const dir of ['core', 'modules', 'render', join('..', 'post-effects')]) {
        for (const f of sources(join(ENGINE, dir))) {
          if (f.endsWith(join('core', 'time', 'time.js')) || EXEMPT.some(x => f.endsWith(x))) continue;
          readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return;
            if (BAD.some(re => re.test(line))) hits.push(`${relative(ENGINE, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          });
        }
      }
      check('no time counter is added to outside core/time/time.js', hits.length === 0, hits.join('\n'));
    },
  },
];
