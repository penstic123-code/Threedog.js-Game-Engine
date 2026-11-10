// Multi-container inventory (chest / corpse / shelf); same style as the other files here.
const READY = { timeout: 60000 };
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, READY); };

export const specs = [
  {
    name: 'Containers: create / add / remove / slots across stacks / transfer / events / errors; limits default to none',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => engine.ops.allow(() => {   // direct container calls are setup here; the guard has its own test
        const I = engine.inventory;
        I.define('rock', { name: '石头', stack: 5 }).define('stick', { name: '木棍' }).define('rag', { name: '布' });
        const log = [], chest = I.container('chest-1', { capacity: 3 });
        const h = chest.on('add', e => log.push(['add', e.id, e.count, e.total]));
        chest.on('remove', e => log.push(['remove', e.id, e.count, e.total]));
        const same = I.container('chest-1') === chest;
        const a = chest.add('rock', 3), b = chest.add('rock', 9);   // stack 5: 12 rocks use 3 slots (5 + 5 + 2)
        const full = chest.add('stick');                            // 3 slots taken
        const afterAdd = { rock: chest.count('rock'), slots: chest.slotsUsed, room: chest.room('rock'), roomStick: chest.room('stick'), playerRock: I.count('rock') };
        const moved = I.transfer('chest-1', 'player', 'rock', 4);
        const t1 = { moved, chest: chest.count('rock'), bag: I.count('rock'), slots: chest.slotsUsed };
        chest.add('stick');
        I.container('chest-2', { capacity: 1 }).add('stick', 1);
        const m2 = I.transfer(chest, 'chest-2', 'stick', 1);        // target already holds this item, so it stacks without a new slot
        const m3 = I.transfer('player', 'chest-1', 'rock', 99);     // bag has only 4
        h.remove(); chest.add('rag', 1);                            // no records after the handle is removed
        const errs = [];
        for (const f of [() => I.transfer('nope', 'player', 'rock'), () => I.container(''), () => I.container('x', { capacity: 0 }), () => I.removeContainer('player'), () => chest.on('zzz', () => {}),
          () => chest.add('rock#1'), () => I.define('a#b', {}), () => chest.setData('nope#9', {}), () => chest.add('rag', 1, { data: [1] })]) {
          try { f(); errs.push(null); } catch (e) { errs.push(e.message); }
        }
        const coreEv = []; engine.events.on('item:add', e => coreEv.push(e.container + ':' + e.id)); I.add('rag', 1, { silent: true }); I.container('chest-ev').add('rag', 1);
        return { same, a, b, full, afterAdd, t1, m2, m3, log, errs, coreEv, chest2: I.container('chest-2').count('stick'), bagList: I.list().map(x => x.id + x.count).join(), cap: I.capacity, cap2: I.container('chest-3').capacity };
      }));
      check('container() with the same id returns the same one; add says the key and spreads over slots of stack size; full slots reject', r.same && r.a.key === 'rock' && r.b.key === 'rock' && r.full.code === 'full'
        && r.afterAdd.rock === 12 && r.afterAdd.slots === 3 && r.afterAdd.room === 3 && r.afterAdd.roomStick === 0, JSON.stringify(r));
      check('Container contents stay out of the player bag; transfer returns the amount actually moved', r.afterAdd.playerRock === 0 && r.t1.moved === 4 && r.t1.chest === 8 && r.t1.bag === 4 && r.t1.slots === 2, JSON.stringify(r.t1));
      check('transfer stacks into the target; moves only what the source has', r.m2 === 1 && r.chest2 === 2 && r.m3 === 4, JSON.stringify({ m2: r.m2, m3: r.m3, chest2: r.chest2 }));
      check('Listener handle: records add / remove, receives nothing after remove(); every container emits item:add naming itself', r.log.some(e => e[0] === 'remove' && e[1] === 'rock' && e[2] === 4) && !r.log.some(e => e[1] === 'rag') && r.coreEv.join() === 'player:rag,chest-ev:rag', JSON.stringify({ log: r.log, core: r.coreEv }));
      check('Bad arguments throw with a fix hint', r.errs.every(Boolean) && /create it first with inventory\.container/.test(r.errs[0]) && /capacity/.test(r.errs[2]) && /cannot be removed/.test(r.errs[3])
        && /not an entry key/.test(r.errs[5]) && /reserved for entry keys/.test(r.errs[6]) && /no entry with that key/.test(r.errs[7]) && /plain object/.test(r.errs[8]), JSON.stringify(r.errs));
      check('No slot limit unless set (player bag and new containers)', r.cap === Infinity && r.cap2 === Infinity && r.bagList.endsWith('rag1'), r.bagList);
    },
  },
  {
    name: '[guard] Containers: moving part of a stacked entry with data gives the moved part a new key (one key, one entry); a whole entry keeps its key',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => engine.ops.allow(() => {
        const I = engine.inventory;
        I.define('potion', { name: 'potion', stack: 10 });
        const a = I.container('fix-a'), b = I.container('fix-b');
        const { key } = a.add('potion', 5, { data: { q: 2 } });
        I.transfer(a, b, key, 2);
        const keysA = a.list().map(e => e.key), keysB = b.list().map(e => e.key);
        const rest = I.transfer(a, b, key, 3);   // the whole remaining entry moves: it may keep its key (merges into b's equal entry)
        return { key, keysA, keysB, rest, after: [...a.list(), ...b.list()].map(e => e.key + ':' + e.count) };
      }));
      check('after a partial move the two containers hold different keys', r.keysA[0] === r.key && r.keysB.length === 1 && r.keysB[0] !== r.key, JSON.stringify(r));
      check('moving the rest merges into the equal entry (5 pieces, one entry)', r.rest === 3 && r.after.length === 1 && r.after[0].endsWith(':5'), JSON.stringify(r));
    },
  },
  {
    name: 'Containers: save -> reopen page and load, contents restored (capacity filled in after load); load discards changes made after the save',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      await ev(async () => {
        const I = engine.inventory; I.define('rock', { name: '石头' }); I.define('stick', { name: '木棍' });
        I.container('chest-1', { capacity: 4 }).add('rock', 7);
        I.add('stick', 2, { silent: true });
        engine.saves.save('cont'); await engine.saves.flush();
      });
      await reload(page);
      const r = await ev(async () => {
        const I = engine.inventory, ret = engine.saves.load('cont'); if (ret?.then) await ret;
        const c = I.container('chest-1', { capacity: 4 });
        const out = { rock: c.count('rock'), cap: c.capacity, bagStick: I.count('stick') };
        c.add('stick', 1); I.container('chest-2').add('rock', 1);   // change made after the save
        const ret2 = engine.saves.load('cont'); if (ret2?.then) await ret2;
        return { ...out, stick: c.count('stick'), chest2: I.container('chest-2').slotsUsed };
      });
      check('Load: chest contents and bag are restored, capacity comes from code', r.rock === 7 && r.cap === 4 && r.bagStick === 2, JSON.stringify(r));
      check('Load again: items added after the save are dropped (same container object)', r.stick === 0 && r.chest2 === 0, JSON.stringify(r));
    },
  },
  {
    name: 'Containers: initial goods from content containers are placed only once; after emptying, save -> reload and load stays empty (same in either order)',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      const DATA = { items: { can: { name: '罐头' } }, containers: { 'shelf-a': { capacity: 4, items: { can: 2 } } } };
      const first = await ev(async d => {
        engine.content.load(d);
        const c = engine.inventory.container('shelf-a');
        const out = { fresh: c.count('can'), cap: c.capacity };
        engine.inventory.transfer(c, 'player', 'can', 2);   // empty it
        out.after = c.count('can');
        engine.saves.save('seed'); await engine.saves.flush();
        return out;
      }, DATA);
      check('content containers: goods placed the first time, capacity applies', first.fresh === 2 && first.cap === 4 && first.after === 0, JSON.stringify(first));
      await reload(page);
      const a = await ev(async d => {   // install content first (which stocks again), then load: the save wins
        engine.content.load(d);
        const before = engine.inventory.container('shelf-a').count('can');
        const ret = engine.saves.load('seed'); if (ret?.then) await ret;
        return { before, after: engine.inventory.container('shelf-a').count('can') };
      }, DATA);
      check('After reload, content.load then load: emptied shelf stays empty', a.before === 2 && a.after === 0, JSON.stringify(a));
      await reload(page);
      const b = await ev(async d => {   // load first, then install content: container exists, so no restocking
        const ret = engine.saves.load('seed'); if (ret?.then) await ret;
        engine.content.load(d);
        return engine.inventory.container('shelf-a').count('can');
      }, DATA);
      check('After reload, load then content.load: emptied shelf is not restocked', b === 0, String(b));
    },
  },
  {
    name: 'Containers: when an add does not fit (slots / weight), DEV warns with the reason and fix; partial fit returns the key',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { const { value, warns } = await __t.warns(() => engine.ops.allow(() => {
        const I = engine.inventory;
        I.define('coin2', { name: '金币' }).define('gem', { name: '宝石', stack: 5 }).define('ore', { name: '矿', weight: 3 });
        const box = I.container('tiny', { capacity: 1 }); const part = box.add('gem', 7), noSlot = box.add('coin2');
        const sack = I.container('sack', { maxWeight: 10 }); const heavy = sack.add('ore', 5), w1 = sack.weight, roomOre = sack.room('ore'), none = sack.add('ore');
        return { part, noSlot, heavy, w1, roomOre, none, gems: box.count('gem'), ores: sack.count('ore') };
      })); return { ...value, warns }; });
      check('partial fit says how many went in, full says why; warn names the limits and the fix', r.part.ok && r.part.key === 'gem' && r.part.added === 5 && r.gems === 5 && r.noSlot.ok === false && r.noSlot.code === 'full' && r.noSlot.facts.id === 'coin2'
        && r.warns.some(m => /Only 5 of 7 gem/.test(m) && /Raise capacity/.test(m)) && r.warns.some(m => /no room for coin2/.test(m)), JSON.stringify(r));
      check('maxWeight: 3 of 5 ore fit under 10, weight 9, then nothing fits', r.heavy.key === 'ore' && r.ores === 3 && r.w1 === 9 && r.roomOre === 0 && r.none.code === 'full', JSON.stringify(r));
    },
  },
  {
    name: 'Shop (recipe 22): shop.buy / shop.sell ops from dialogue { can } / { op }, option disappears when short of money, gold HUD, save -> reload and load',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      // same approach as recipe 22; functions cannot cross ev, so build the data inside the page
      const SETUP = () => {
        const price = { bread: 5 };
        engine.ops.define('shop.buy', {
          args: { shop: 'string', item: 'string' },
          can: (e, { shop, item }, ctx) => !e.inventory.container(shop).has(item) ? 'soldOut' : !e.inventory.container(ctx.actor).has('gold', price[item]) ? 'noMoney' : true,
          atomic: true,
          run(e, { shop, item }, ctx) { e.inventory.container(ctx.actor).remove('gold', price[item]); return e.inventory.transfer(shop, ctx.actor, item, 1) || { ok: false, code: 'bagFull' }; },
        });
        engine.ops.define('shop.sell', {
          args: { shop: 'string', item: 'string' },
          atomic: true,
          can: (e, { item }, ctx) => e.inventory.container(ctx.actor).has(item) || 'notInBag',
          run(e, { shop, item }, ctx) { const bag = e.inventory.container(ctx.actor); e.inventory.transfer(ctx.actor, shop, item, 1); if (bag.room('gold') < 3) return { ok: false, code: 'bagFull' }; bag.add('gold', 3, { silent: true }); return 1; },
        });
        const buy = ['shop.buy', { shop: 'shop-bakery', item: 'bread' }], sell = ['shop.sell', { shop: 'shop-bakery', item: 'bread' }];
        engine.content.load({
          items: { gold: { name: '金币', icon: '🪙', stack: 99999 }, bread: { name: '面包' } },
          containers: { 'shop-bakery': { capacity: 6, items: { bread: 3 } } },
          dialogues: { baker: { speaker: '面包师', nodes: { start: { text: '要点什么？', choices: [
            { text: '买面包', next: 'start', if: { can: buy }, do: { op: buy } },
            { text: '寄卖面包', next: 'start', if: { can: sell }, do: { op: sell } },
            { text: '再见', next: 'end' },
          ] } } } },
        });
        engine.onFrame(() => engine.hud.addCounter('gold', { icon: '🪙', label: '金币', value: engine.inventory.count('gold') }));
      };
      const r = await ev(async s => {
        const I = engine.inventory, S = new Function('return ' + s)();
        S();
        engine.ops.allow(() => I.add('gold', 12, { silent: true }));   // test setup, not a gameplay action
        const D = engine.dialogue, snap = () => ({ gold: I.count('gold'), bag: I.count('bread'), shelf: I.container('shop-bakery').count('bread'), opts: D._opts?.length });
        const pick = i => { D._finishTyping(); engine.ops.run('dialogue.choose', { index: i }, { source: 'test' }); D._finishTyping(); return snap(); };   // i-th visible choice
        D.start('baker'); D._finishTyping();
        const log = [snap(), pick(0), pick(1)];   // buy; then pick the 2nd choice = consign
        pick(0); log.push(pick(0));               // buy twice more, money runs out
        D.end();
        engine.saves.save('shop'); await engine.saves.flush();
        return { log, ops: engine.ops.recent().filter(h => h.name.startsWith('shop.') || h.name === 'dialogue.choose').map(h => `${h.name}:${h.depth}`) };
      }, '' + SETUP);
      await frames(5);
      r.hud = await ev(() => [...document.querySelectorAll('.threedog-hud-counter')].map(x => x.textContent).join(' | '));
      check('Buy: 5 gold deducted, shelf -1, bag +1; consign hidden when there is no bread', r.log[0].opts === 2 && r.log[1].gold === 7 && r.log[1].bag === 1 && r.log[1].shelf === 2, JSON.stringify(r.log.slice(0, 2)));
      check('[guard] each pick is a dialogue.choose op with the shop op nested inside it (depth 1)', r.ops.slice(0, 4).join() === 'dialogue.choose:0,shop.buy:1,dialogue.choose:0,shop.sell:1', JSON.stringify(r.ops));
      check('Consign: bread returns to the shelf, +3 gold', r.log[2].gold === 10 && r.log[2].bag === 0 && r.log[2].shelf === 3, JSON.stringify(r.log[2]));
      check('Buy option disappears when money is short / shelf is empty; gold HUD follows', r.log[3].gold === 0 && r.log[3].shelf === 1 && r.log[3].opts === 2 && /金币 0/.test(r.hud || ''), JSON.stringify({ l: r.log[3], hud: r.hud }));
      await reload(page);
      const a = await ev(async s => {
        new Function('return ' + s)()();
        const ret = engine.saves.load('shop'); if (ret?.then) await ret;
        return { gold: engine.inventory.count('gold'), shelf: engine.inventory.container('shop-bakery').count('bread') };
      }, '' + SETUP);
      check('Reload and load: gold and shelf match (no restocking)', a.gold === 0 && a.shelf === 1, JSON.stringify(a));
    },
  },
  {
    name: '[守] Single pieces: different data = separate entries, count / has by kind, setData keeps the key, transfer keeps key and data; save -> reload -> load identical',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      const snap = () => {
        const I = engine.inventory, rows = c => c.list().map(e => [e.key, e.id, e.count, e.data ?? null]);
        return JSON.stringify({ bag: rows(I.bag), rack: rows(I.container('rack')) });
      };
      const a = await ev(async s => engine.ops.allow(async () => {
        const I = engine.inventory;
        I.define('sword', { name: '剑', stack: 1 }).define('tomato', { name: '番茄', stack: 20 });
        // add() returns { ok, key, added } (not the bare key), so take .key
        const k1 = I.add('sword', 1, { data: { durability: 80, level: 3 } }).key, k2 = I.add('sword', 1, { data: { level: 3, durability: 80 } }).key, k3 = I.add('sword').key;
        const t1 = I.add('tomato', 3, { data: { q: 2 } }).key, t2 = I.add('tomato', 2, { data: { q: 2 } }).key, t3 = I.add('tomato', 1, { data: { q: 1 } }).key;
        const kept = I.setData(k1, { ...I.get(k1).data, durability: 79 });
        const swords = I.count('sword'), has3 = I.has('sword', 3);
        I.container('rack'); const moved = I.transfer('player', 'rack', k2);
        const split = I.setData(t1, { q: 3 }, 2);
        const out = { k1, k2, k3, t1, t2, t3, kept, moved, split, swords, has3, one: I.count(k1), tomatoes: I.count('tomato'),
          t1n: I.count(t1), splitN: I.count(split), dur: I.get(k1).data.durability, rackKey: !!I.container('rack').get(k2), frozen: Object.isFrozen(I.get(k1).data) };
        engine.saves.save('single'); await engine.saves.flush();
        return { ...out, snap: new Function('return ' + s)()() };
      }), '' + snap);
      check('stack-1 pieces with data are separate keys, plain ones keep the item id; count / has count every sword', a.k1 !== a.k2 && /^sword#\d+$/.test(a.k1) && a.k3 === 'sword' && a.swords === 3 && a.has3 && a.one === 1, JSON.stringify(a));
      check('stackable pieces with equal data (any key order) share an entry, different data gets another', a.t1 === a.t2 && a.t3 !== a.t1 && a.tomatoes === 6, JSON.stringify(a));
      check('setData on a whole entry keeps its key; on part of a stack splits off a new key; data is frozen', a.kept === a.k1 && a.dur === 79 && a.split !== a.t1 && a.t1n === 3 && a.splitN === 2 && a.frozen, JSON.stringify(a));
      check('transfer by key moves exactly that piece and keeps its key', a.moved === 1 && a.rackKey, JSON.stringify(a));
      await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, { timeout: 60000 });
      const b = await ev(async s => {
        const I = engine.inventory; I.define('sword', { name: '剑', stack: 1 }).define('tomato', { name: '番茄', stack: 20 });
        const ret = engine.saves.load('single'); if (ret?.then) await ret;
        const snap = new Function('return ' + s)()();
        const fresh = engine.ops.allow(() => I.add('sword', 1, { data: { durability: 1 } })).key;
        return { snap, fresh, keys: I.list().map(e => e.key) };
      }, '' + snap);
      check('[守] save -> reload -> load: every entry, key and data identical', b.snap === a.snap, b.snap + ' vs ' + a.snap);
      check('the key counter is saved: a new piece after load gets an unused key', b.keys.filter(k => k === b.fresh).length === 1 && !a.snap.includes('"' + b.fresh + '"'), JSON.stringify(b));
    },
  },
  {
    name: '[守] Single pieces: writes outside ops are reported (setData, transfer), piece data cannot be edited in place',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const I = engine.inventory, warns = [], orig = console.warn;
        I.define('axe', { name: '斧', stack: 1 });
        const k = engine.ops.allow(() => I.add('axe', 1, { data: { durability: 50 } })).key;
        I.container('shed');
        console.warn = (...a) => { warns.push(String(a[0])); };
        await new Promise(res => setTimeout(() => { I.setData(k, { durability: 49 }); I.transfer('player', 'shed', k); res(); }, 0));   // the misuse under test
        console.warn = orig;
        let threw = '';
        try { (function () { 'use strict'; I.container('shed').get(k).data.durability = 999; })(); } catch (e) { threw = e.constructor.name; }
        return { warns: warns.filter(w => w.includes('outside a fixed step')), threw, dur: I.container('shed').get(k).data.durability };
      });
      check('[守] setData and transfer outside an op are reported with the fix', r.warns.some(w => w.includes('inventory.setData')) && r.warns.some(w => w.includes('inventory.transfer')) && r.warns.every(w => w.includes('engine.ops.run')), JSON.stringify(r.warns));
      check('[守] editing piece data in place throws (frozen), the value is unchanged', r.threw === 'TypeError' && r.dur === 49, JSON.stringify(r));
    },
  },
  {
    name: 'Inventory part and ops: default window draws through the part, Use / Drop buttons run inventory.use / inventory.drop; dropped data survives pickup; auto pickups taken on touch',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const I = engine.inventory, used = [];
        engine.events.on('item:use', e => used.push(e.item + ':' + (e.data?.hp ?? '')));
        I.define('potion', { name: '药', stack: 9, consume: true, use: () => {} }).define('stone', { name: '石' }).define('blade', { name: '刃', stack: 1 }).define('coin', { name: '币' });
        const bk = engine.ops.allow(() => { I.add('potion', 2, { silent: true }); I.add('stone', 3, { silent: true }); return I.add('blade', 1, { data: { sharp: 7 }, silent: true }).key; });
        engine.ui.set('inventory', { drop: true });
        const opened = engine.ui.open('inventory');
        const el = document.querySelector('.threedog-win-inventory'), rows = el?.querySelectorAll('.threedog-row').length, entries = I.list().length;
        el.querySelector('[data-op="inventory.use"][data-key="potion"]').click();
        el.querySelector('[data-op="inventory.drop"][data-key="stone"]').click();
        const afterClicks = { potion: I.count('potion'), stone: I.count('stone'), redrawn: el.textContent.includes('×1'), used: used.join() };
        const notUsable = engine.ops.can('inventory.use', { item: 'stone' }).code;
        engine.ui.close('inventory');
        // drop the blade, walk back onto it: the picked-up piece has the same data
        const p = engine.player.position;
        const drop = engine.ops.run('inventory.drop', { item: bk });
        const rec = engine.world.query({ kind: 'pickup', where: r => r.item === 'blade' })[0];
        engine.haltLoop(); engine.step(0.2, { render: false });
        const take = engine.ops.run('interaction.use', { id: rec.id });
        const back = I.list().find(e => e.id === 'blade');
        // auto pickup: no key, taken in the fixed step when the player is within its radius
        engine.pickups.spawn([p.x + 0.5, 0, p.z], { give: 'coin', count: 4, auto: true, radius: 3 });
        engine.step(0.3, { render: false }); engine._unhalt();
        return { opened, rows, entries, afterClicks, notUsable, drop: drop.ok, recData: rec?.data, take: take.ok, back: back && back.data, coins: I.count('coin'),
          coinLeft: engine.world.query({ kind: 'pickup', where: r => r.item === 'coin' }).length, ui: engine.ui.describe().inventory };
      });
      check('ui.open draws the default part with one row per entry', r.opened === true && r.rows === r.entries && r.ui === 'default', JSON.stringify(r));
      check('Use button runs inventory.use (consume removes one, item:use fires); Drop button drops through inventory.drop; the window redraws',
        r.afterClicks.potion === 1 && r.afterClicks.used === 'potion:' && r.afterClicks.stone === 2 && r.afterClicks.redrawn, JSON.stringify(r.afterClicks));
      check('inventory.use refuses items without a use function', r.notUsable === 'notUsable', r.notUsable);
      check('dropping a piece keeps its data on the ground and back in the bag', r.drop && r.recData?.sharp === 7 && r.take && r.back?.sharp === 7, JSON.stringify(r));
      check('auto pickup is taken by walking into it (no key), record removed', r.coins === 4 && r.coinLeft === 0, JSON.stringify(r));
    },
  },
  {
    name: '[守] Inventory part off: the inventory key and ui.open build no inventory DOM; inventory ops still work',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      await ev(() => engine.ui.set('inventory', false));
      await page.keyboard.press('KeyI'); await frames(3);
      const r = await ev(() => {
        engine.inventory.container('box');
        const opened = engine.ui.open('inventory');
        engine.ops.allow(() => engine.inventory.add('film', 2, { silent: true }));
        const t = engine.ops.run('inventory.transfer', { from: 'player', to: 'box', item: 'film', n: 2 });
        return { opened, dom: !!document.querySelector('.threedog-win-inventory'), isOpen: engine.ui.isOpen('inventory'), moved: t.value, ui: engine.ui.describe().inventory };
      });
      check('[守] no inventory DOM, open returns false, part reported off', r.opened === false && !r.dom && !r.isOpen && r.ui === 'off', JSON.stringify(r));
      check('ops work without the window', r.moved === 2, JSON.stringify(r));
    },
  },
];
