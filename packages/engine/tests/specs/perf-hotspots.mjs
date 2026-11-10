// 性能热点修复的"不许绕开"检查（2026-11-02 性能审查）。每条守的是"快了以后结果不变"：
//   1. core/scene/sceneDelta.js：几个要找遍场景的系统（级联阴影、雾、夜光、房间环境图）共用一份"这帧新进场景的子树"，不再各自整场景遍历。
//      守：场外搭好再挂上的子树整棵都被看到；场外组里后加的孙子也被看到；移走的对象 leave 一次；换材质算离开再进来；安静的帧什么都不看。
// 这些都是纯函数 / 纯 three 对象，直接在测试进程里调（不开页面里的引擎）。
export const specs = [
  {
    name: '[守] 场景增量（sceneDelta）：只看新进场景的子树，场外搭好再挂上、嵌套后加、移走、换材质都不漏',
    url: '/',
    async run({ check }) {
      const THREE = await import('three');
      const { sceneVisitor } = await import('../../core/scene/sceneDelta.js');
      const scene = new THREE.Scene(), mk = n => Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), { name: n });
      scene.add(mk('old'));
      const log = [];
      const v = sceneVisitor(scene, { enter: o => log.push('+' + (o.name || o.type)), leave: o => log.push('-' + (o.name || o.type)) });
      const take = () => { v.sync(); const out = log.join(' '); log.length = 0; return out; };
      const first = take();
      const quiet = take();
      // 场外搭：组先在场景外，孙子在挂上之前加进去
      const g = new THREE.Group(); g.name = 'g';
      const a = mk('a'); g.add(a);
      const offAdds = take();   // 还没挂上：什么都不看
      a.add(mk('b'));
      scene.add(g);
      const attached = take();
      a.add(mk('c'));            // 已在场景里的组里后加
      const nested = take();
      g.remove(a);               // 移走：a 和它下面的 b、c 各 leave 一次（马上，不等下一帧）
      const removed = log.join(' '); log.length = 0;
      const gone = take();
      g.add(a);                  // 再挂回去：整棵再进来
      const back = take();
      const tmp = mk('tmp'); scene.add(tmp); scene.remove(tmp);   // 同一帧里进来又走了：不看
      const blink = take();
      a.material = new THREE.MeshStandardMaterial();              // 换材质：离开一次（马上），下一帧再进来
      const swapNow = log.join(' '); log.length = 0;
      const swapped = take();
      const walks = v.walks;
      v.remove();
      scene.add(mk('after'));
      const afterRemove = log.join(' ');
      check('新 visitor 第一次 sync 整场景看一遍（场景本身和原有对象）', first === '+Scene +old', first);
      check('没有变化的帧什么都不看', quiet === '' && blink === '', JSON.stringify({ quiet, blink }));
      check('场外搭的组挂上之前不看，挂上后整棵（含挂上前后加的孙子）各看一次', offAdds === '' && attached.split(' ').sort().join(' ') === '+a +b +g', attached);
      check('已在场景里的组里后加的对象下一帧被看到', nested === '+c', nested);
      check('移走一个子树：子树里每个对象 leave 一次，之后不再提起', removed.split(' ').sort().join(' ') === '-a -b -c' && gone === '', JSON.stringify({ removed, gone }));
      check('挂回去：整棵再进来', back.split(' ').sort().join(' ') === '+a +b +c', back);
      check('mesh.material = 新材质：先 leave（还是旧材质），下一帧再 enter', swapNow === '-a' && swapped === '+a', JSON.stringify({ swapNow, swapped }));
      check('整个过程只有第一次是整场景遍历', walks === 1, String(walks));
      check('visitor 去掉后不再收到任何东西', afterRemove === '', afterRemove);
    },
  },
  {
    name: '[守] 修饰栈的值缓存（stacks memo）：take / remove / 到时 / dropId / 换 base 之后每次读都等于从 base 重算',
    url: '/',
    async run({ check }) {
      const { Stacks } = await import('../../core/ops/stacks.js');
      let now = 0;
      const S = new Stacks({});
      S._nowOf = () => now;
      const s = S.define('move.speed', { per: 'optional', min: 0 });
      // 参照：不经缓存的重算（同一套分层合并），每次读都拿来比
      const fresh = (id, base) => {
        const m = s._map(id), all = id != null ? s._map(undefined) : null;
        const fit = v => Math.min(s.max, Math.max(s.min, v));
        return fit(m?.size || all?.size ? s._combine(s._list(m, all), base) : base);
      };
      let bad = 0, reads = 0, first = '';
      const look = (tag) => {
        for (const id of ['p', 'n1', undefined]) for (const base of [4, 6]) {
          reads++; const a = s.value(id, base), b = fresh(id, base), again = s.value(id, base);
          if (a !== b || again !== b) { bad++; first ||= `${tag} id=${id} base=${base}: ${a} / ${again} vs ${b}`; }
        }
      };
      look('empty');
      const haste = S.mod('move.speed', { owner: 'haste', id: 'p', mul: 1.5 }); look('haste');
      const mud = S.mod('move.speed', { owner: 'mud', mul: 0.5, for: 2 }); look('mud everyone');
      S.mod('move.speed', { owner: 'boost', id: 'p', add: 1, layer: 'effect' }); look('boost');
      S.mod('move.speed', { owner: 'haste', id: 'p', set: 3 }); look('haste re-taken as set');
      haste.remove(); look('stale handle ends nothing');
      now = 2.5; S._expire(); look('mud expired');
      S.mod('move.speed', { owner: 'cap', id: 'n1', clamp: { max: 2 } }); look('clamp');
      s.dropId('n1'); look('dropId');
      s.release('boost', { id: 'p' }); look('release');
      s.clear(); look('clear');
      mud.remove();
      check('每次读（和紧接着的第二次读）都等于不经缓存的重算', bad === 0, first || `${reads} reads`);
      // 同一组修饰、同一 base 的第二次读不再分配新的合并结果：走缓存
      S.mod('move.speed', { owner: 'haste', id: 'p', mul: 2 });
      let calls = 0; const orig = s._combine; s._combine = function (...a) { calls++; return orig.apply(this, a); };
      for (let i = 0; i < 100; i++) s.value('p', 6);
      check('修饰不变时 100 次读只合并 1 次', calls === 1, String(calls));
    },
  },
  {
    name: '[守] 追帧有时间预算（catch-up）：重的固定步卡顿后少跑几步、丢掉余下时间；轻的照样补满；engine.step 不丢时间',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'catchup');
        await E.start();
        let cost = 0;
        E.onFixed(() => { const t = performance.now(); while (performance.now() - t < cost) { /* 模拟一个重的固定步 */ } });
        const run = (ms, dt) => { cost = ms; E._acc = 0; const t0 = performance.now(), n = E._catchUp(dt); return { n, ms: Math.round(performance.now() - t0), left: E._acc }; };
        const light = run(0, 0.1), heavy = run(13, 0.1), hitch = run(13, 0.25);
        cost = 13; const t0 = E.time.tick; E.step(0.1, { render: false, describe: false }); const stepped = E.time.tick - t0;
        E.dispose();
        return { light, heavy, hitch, stepped };
      });
      check('轻的固定步：卡顿 0.1 s 照样补满 6 步', r.light.n === 6, JSON.stringify(r.light));
      check('重的固定步（13 ms）：只跑到预算（约 33 ms）为止，余下不到一步的时间留下，其余丢掉', r.heavy.n >= 1 && r.heavy.n <= 3 && r.heavy.left < 1 / 60 && r.hitch.n <= 3, JSON.stringify(r));
      check('engine.step(0.1) 不走追帧：不管多重都跑满 6 步（确定性）', r.stepped === 6, String(r.stepped));
    },
  },
  {
    name: '[守] 时钟定时器一次扫描（clock timers）：同一步到期的一次性 / 事件 / 循环定时器按时间顺序各触发对的次数，回调里加的删的照常',
    url: '/',
    async run({ check }) {
      const { Clock } = await import('../../core/time/Clock.js');
      const { Stacks } = await import('../../core/ops/stacks.js');
      const { Time } = await import('../../core/time/time.js');
      const log = [], e = { saves: { define() {} }, events: { emit: n => log.push(n), on() {} } };
      e.stacks = new Stacks(e);
      const c = e.clock = new Clock(e); e.time = new Time(e);   // the clock is the calendar view of time's one queue
      const advance = s => e.time._skip(s, s);
      // 1000 个不到期的垫底，看一次触发多少个的时候结果对不对
      for (let i = 0; i < 1000; i++) c.after(100 + i, () => log.push('far'));
      c.after(0.3, () => log.push('c'));
      c.after(0.1, () => log.push('a'));
      c.after(0.2, 'b-event');
      const later = c.after(0.25, () => log.push('removed-but-due'));
      c.every(0.15, () => log.push('tick'));
      c.after(0.05, () => { log.push('first'); c.after(0.01, () => log.push('added-in-callback')); later.remove(); });
      advance(0.32);
      const one = log.join(' ');
      log.length = 0;
      advance(0.01);
      const two = log.join(' ');
      // ordered by first due time; a repeating timer catches up all its runs at once; one removed inside a callback does not fire in that step either (it used to fire once it was already in the due list)
      check('同一步到期的按时间顺序触发，循环定时器补够次数，回调里删掉的不触发', one === 'first a tick tick b-event c', one);
      check('回调里加的定时器下一步到期时触发，一次性的不重复', two === 'added-in-callback', two);
      check('触发过的一次性定时器离开列表，垫底的 1000 个和循环的留下', c.size === 1001, String(c.size));
    },
  },
];
