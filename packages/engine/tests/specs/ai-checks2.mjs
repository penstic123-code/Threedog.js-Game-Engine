// AI 友好批 B2：engine.checkSave / checkSkip（一致性检查）、events.trace（事件因果链）、character.onPose（姿势后回调）。
export const specs = [
  {
    name: 'AICHECK2 checkSave 往返一致，坏的存档部件会被点名',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        const good = await engine.checkSave();
        let n = 0;
        engine.saves.define('badpart', { save: () => ({ n: ++n }), load: () => {} });   // load 不还原：每次 save 数字都变
        const bad = await engine.checkSave();
        return { good, bad };
      });
      check('正常往返 ok', r.good.ok === true, JSON.stringify(r.good.diffs));
      check('坏部件 ok=false 且 diffs 点名它', r.bad.ok === false && r.bad.diffs.some(d => d.path.includes('badpart')), JSON.stringify(r.bad.diffs));
    },
  },
  {
    name: 'AICHECK2 checkSkip 返回 {ok,diffs}，空世界跳过与 step 一致',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        engine.clock.after(1000, 't-real', { channel: 'real' });             // 没到点的 real 定时器：跳过和逐步走完，到期时间要一样
        const raw = await engine.checkSkip(30);                            // 跳过不跑近处模拟：玩家/NPC 位置、world.step 必然不同，应被报告
        const ign = await engine.checkSkip(30, { ignore: ['parts.world', 'parts.rigid', 'parts.random'] });   // 刚体也是近处模拟：跳过时不动
        engine.freeze('t-refuse'); const ref = await engine.checkSkip(30); engine.stacks.get('freeze').release('t-refuse');
        return { ok: raw.ok, diffs: raw.diffs, ign, refused: { ok: ref.ok, code: ref.code, diffs: ref.diffs.length, noReason: !('reason' in ref) } };
      });
      check('冻结时 checkSkip 以 failure 拒绝：code frozen，只有 code 没有 reason', r.refused.ok === false && r.refused.code === 'frozen' && r.refused.diffs === 1 && r.refused.noReason, JSON.stringify(r.refused));
      check('checkSkip 有结果结构', typeof r.ok === 'boolean' && Array.isArray(r.diffs), JSON.stringify(r));
      check('近处模拟的差异被报告（带路径）', r.ok === false && r.diffs.every(d => d.path.startsWith('parts.')), JSON.stringify(r.diffs.slice(0, 3)));
      check('忽略 world、rigid 后时间类状态一致', r.ign.ok, JSON.stringify(r.ign.diffs.slice(0, 5)));
    },
  },
  {
    name: 'AICHECK2 events.trace 记录事件由哪个 op/事件引起，关闭时不记录',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = engine.events;
        E.emit('trace:off');                                   // 关着：不记
        const offLen = E.trace().length;
        E.traceSize = 50;
        engine.ops.define('tr.go', { args: {}, run: e => { e.events.emit('tr:a', {}); } });
        const h = E.on('tr:a', () => E.emit('tr:b', {}));
        engine.ops.run('tr.go', {});
        h.remove();
        const b = E.trace('tr:b').at(-1), a = E.trace('tr:a').at(-1);
        E.traceSize = 0;
        return { offLen, a, b };
      });
      check('关着时不记录', r.offLen === 0, String(r.offLen));
      check('tr:a 的父是 op', /^op:tr\.go#\d+$/.test(r.a?.parent ?? ''), JSON.stringify(r.a));
      check('tr:b 的父是 tr:a，chain 追到 op', r.b?.parent === `ev:${r.a?.id}` && r.b.chain.length === 2 && r.b.chain[1] === r.a.parent, JSON.stringify(r.b));
    },
  },
  {
    name: 'AICHECK2 character.onPose 每帧在动画姿势后回调，remove 后停止',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const p = engine.player;
        let n = 0, who = null;
        const h = p.onPose((c, dt) => { n++; who = c === p && dt > 0; });
        engine.step(0.5, { render: false });
        const during = n; h.remove();
        engine.step(0.5, { render: false });
        return { during, after: n, who };
      });
      check('step 期间被回调', r.during > 0 && r.who === true, JSON.stringify(r));
      check('remove 后不再回调', r.after === r.during, JSON.stringify(r));
    },
  },
  {
    // 为什么：原来 player.onStep 是单格属性，第二个系统赋值就把引擎自己的脚步声顶掉，还不报错。事件没有这个问题。
    name: 'AICHECK2 character:step fires for each listener while walking, the slot properties are gone',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const p = engine.player;
        let a = 0, b = 0, who = true;
        const h1 = engine.events.on('character:step', e => { if (e.character === p) a++; else who = false; }), h2 = engine.events.on('character:step', () => b++);
        p.moveAmount = 1; p.grounded = true;
        for (let i = 0; i < 120; i++) { p.moveAmount = 1; p.grounded = true; p._animate(1 / 60); }
        h1.remove(); h2.remove();
        return { a, b, who, slot: [typeof p.onStep, typeof p.onLand].join() };
      });
      check('both listeners heard the steps', r.a > 0 && r.b === r.a && r.who, JSON.stringify(r));
      check('no onStep or onLand property', r.slot === 'undefined,undefined', r.slot);
    },
  },
];
