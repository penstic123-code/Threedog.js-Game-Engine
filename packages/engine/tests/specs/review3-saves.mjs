// 第三次审查，优先项 3：存档。两个真页面共用一个 IndexedDB，以及同一页里的并发读写。
const url = '/?threedog-headless';
const second = async page => {
  // 跑测试的页面不让 context().newPage()；window.open 同样得到共用 IndexedDB 的第二个标签页
  const [b] = await Promise.all([page.waitForEvent('popup'), page.evaluate(u => { window.open(u); }, page.url())]);
  await b.waitForFunction(() => window.engine?.phase === 'running', null, { timeout: 60000 });
  return b;
};
const slots = p => p.evaluate(async () => { const out = {}; for (const s of engine.saves.list()) out[s.slot] = s.savedAt; return out; });

export const specs = [
  {
    name: 'review3 saves: two tabs writing different slots at once lose nothing, on disk or in either list',
    url,
    async run({ check, page }) {
      const b = await second(page);
      const write = (p, tag) => p.evaluate(async t => { const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => engine.saves.save(`r3-${t}-${i}`))); return rs.filter(Boolean).length; }, tag);
      const [x, y] = await Promise.all([write(page, 'a'), write(b, 'b')]);
      await page.waitForTimeout(300);
      const [la, lb] = [await slots(page), await slots(b)];
      await page.reload(); await page.waitForFunction(() => window.engine?.phase === 'running', null, { timeout: 60000 });
      const after = await slots(page);
      const n = o => Object.keys(o).filter(k => k.startsWith('r3-')).length;
      await b.close();
      check('all writes reported true', x === 12 && y === 12, `${x} ${y}`);
      check('each tab lists all 24', n(la) === 24 && n(lb) === 24, `${n(la)} ${n(lb)}`);
      check('24 survive a reload', n(after) === 24, String(n(after)));
    },
  },
  {
    name: 'review3 saves: two tabs on one slot: both lists end on what the disk holds, and a true means it was written',
    url,
    async run({ check, page }) {
      const b = await second(page);
      const round = (p, tag) => p.evaluate(async t => { const out = []; engine.saves.define('r3mark', { version: 1, save: () => ({ t, n: window.__n = (window.__n ?? 0) + 1 }), load() {} }); for (let i = 0; i < 15; i++) { out.push(await engine.saves.save('r3-same')); await new Promise(r => setTimeout(r, Math.random() * 12)); } return out; }, tag);
      const [ra, rb] = await Promise.all([round(page, 'a'), round(b, 'b')]);
      await page.waitForTimeout(400);
      const view = p => p.evaluate(async () => { const dec = j => { const t = /^\{/.test(j) ? j : new TextDecoder().decode(Uint8Array.from(atob(j), c => c.charCodeAt(0))); return JSON.parse(t); }; const d = await engine.saves.store.getSlot('r3-same'); return { disk: dec(d.json).parts?.r3mark, mem: dec(engine.saves._json.get('r3-same')).parts?.r3mark }; });
      const [va, vb] = [await view(page), await view(b)];
      await b.close();
      check('at least one tab wrote', ra.some(Boolean) || rb.some(Boolean), JSON.stringify({ ra, rb }));
      check('tabs agree with the disk', JSON.stringify(va.disk) === JSON.stringify(vb.disk) && (va.mem == null || JSON.stringify(va.mem) === JSON.stringify(va.disk)) && (vb.mem == null || JSON.stringify(vb.mem) === JSON.stringify(vb.disk)), JSON.stringify({ va, vb }));
    },
  },
  {
    name: 'review3 saves: a new game after a reload may save over the old auto slot',
    url,
    async run({ check, page }) {
      await page.evaluate(() => engine.saves.save('auto'));
      await page.reload(); await page.waitForFunction(() => window.engine?.phase === 'running', null, { timeout: 60000 });
      const r = await page.evaluate(async () => { await engine.session.newGame(); return engine.saves.save('auto'); });
      check('the save is written', r === true, String(r));
    },
  },
  {
    name: 'review3 saves: a tab that never opened a slot does not overwrite what another tab just wrote',
    url,
    async run({ check, page }) {
      const b = await second(page);
      await page.evaluate(() => { engine.saves.define('r3who', { version: 1, save: () => 'a', load() {} }); });
      await b.evaluate(() => { engine.saves.define('r3who', { version: 1, save: () => 'b', load() {} }); });
      await b.evaluate(() => engine.saves.save('r3-own'));
      await page.waitForTimeout(0);
      // A 的通知可能还没到：这正是竞争窗口。立刻写
      const wrote = await page.evaluate(() => engine.saves.save('r3-own'));
      const who = await page.evaluate(async () => { const dec = j => { const t = /^\{/.test(j) ? j : new TextDecoder().decode(Uint8Array.from(atob(j), c => c.charCodeAt(0))); return JSON.parse(t); }; return dec((await engine.saves.store.getSlot('r3-own')).json).parts?.r3who; });
      await b.close();
      check('the other tab refused or the note made it visible first', wrote === false && who === 'b', JSON.stringify({ wrote, who }));
    },
  },
  {
    name: 'review3 saves: save, load and new game fired together never leave a half state',
    url,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves; let n = 0;
        S.define('r3a', { version: 1, save: () => ({ v: n }), load: d => { n = d.v; } });
        S.define('r3b', { version: 1, save: () => ({ v: n }), load: d => { if (d.v !== n) throw new Error('half'); } });
        await S.save('r3-x'); n = 5; await S.save('r3-y');
        const out = [];
        for (let i = 0; i < 20; i++) {
          n = i;
          const ps = [S.save('r3-x'), S.load('r3-y'), S.save('r3-y'), engine.session.load('r3-x'), S.remove('r3-z'), S.load('r3-x'), S.save('r3-z')];
          if (i % 5 === 0) ps.push(engine.session.newGame());
          const rs = await Promise.allSettled(ps);
          out.push(...rs.filter(x => x.status === 'rejected').map(x => x.reason?.message));
          engine.step(1 / 60);
        }
        const d = S.collect();
        return { out: [...new Set(out)], same: d.parts.r3a?.v === d.parts.r3b?.v, err: engine.error?.message ?? null };
      });
      check('no rejection, no error, parts agree', !r.out.length && r.same && !r.err, JSON.stringify(r).slice(0, 500));
    },
  },
  {
    name: '[guard] saves: every part round-trips, collect after apply equals collect before',
    url,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves;
        for (let i = 0; i < 90; i++) engine.step(1 / 60);
        // views refresh only once a source moved past a tolerance (views.js moved), and a load always refreshes, so a body inside that band would first appear in the second collect.
        // That is the view catching up, not a drifting part: bring the views up to date first, and what follows has to match exactly
        engine.world.refresh();
        for (let i = 0; i < 30; i++) engine.step(1 / 60);
        const a = S.collect(), diff = {};
        await S.apply(structuredClone(a), 'r3');
        const b = S.collect();
        for (const k of Object.keys(a.parts)) { const x = JSON.stringify(a.parts[k]), y = JSON.stringify(b.parts[k]); if (x !== y) { let i = 0; while (x[i] === y[i]) i++; diff[k] = [x?.slice(Math.max(0, i - 30), i + 40), y?.slice(Math.max(0, i - 30), i + 40)]; } }
        return { parts: Object.keys(a.parts).length, diff };
      });
      check(`no part drifts (${r.parts})`, !Object.keys(r.diff).length, JSON.stringify(r.diff).slice(0, 700));
    },
  },
];
