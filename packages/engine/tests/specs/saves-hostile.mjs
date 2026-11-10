// Saves under hostile conditions, from the 1.0 audit: storage that refuses, damaged or hand-made data through the public entries, and what a replacement
// must leave standing when it fails or succeeds. Each item goes through saves / session and reads what the game or the store really holds.

/** In the page: clear a provoked gameplay error so the next case starts clean */
const CLEAR = `() => { engine.error = null; engine.stacks.get('freeze').release('error'); }`;

export const specs = [
  {
    name: 'saves hostile: two refused writes in a row leave memory on the stored save; a part that JSON cannot hold refuses the save; garbage versions are corrupt [guard]',
    url: '/?threedog-headless',
    expectErrors: /failed to write slot|save part 'hsNaN'/,
    async run({ check, ev }) {
      const r = await ev(async CLEAR_SRC => {
        const S = engine.saves, clear = (0, eval)('(' + CLEAR_SRC + ')'), out = {};
        let v = 1;
        const h = S.define('hsV', { save: () => v, load: () => {} });
        await S.save('hs-two');
        const put = S.store.putSlot;
        S.store.putSlot = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
        v = 2; const a = S.save('hs-two'); v = 3; const b = S.save('hs-two');
        out.two = [await a, await b];
        await S.save('hs-new'); await S.flush();
        S.store.putSlot = put;
        out.mem = JSON.parse(S._json.get('hs-two')).parts.hsV;
        out.disk = JSON.parse((await S.store.getSlot('hs-two')).json).parts.hsV;
        out.again = await S.save('hs-two');
        h.remove({ keep: false }); delete S._foreign.parts.hsV; delete S._foreign.versions.hsV;
        await S.remove('hs-two');
        // NaN became null in the text: save() said true and wrote a save that every later load refuses as corrupt
        await S.save('hs-nan');
        const before = S._json.get('hs-nan');
        S.define('hsNaN', { save: () => NaN, load: () => {} });
        out.nan = { ok: await S.save('hs-nan'), kept: S._json.get('hs-nan') === before, check: S.check('hs-nan') };
        clear(); S.providers.delete('hsNaN');
        await S.remove('hs-nan');
        // a version that is no number skipped every migrate step and handed the old shape to load()
        let got = null;
        S.define('hsVer', { version: 2, migrate: { 1: () => ({ v: 2 }) }, save: () => ({ v: 2 }), load: d => { got = d; } });
        out.ver = { ok: await S.apply({ format: 1, versions: { hsVer: 'abc' }, parts: { hsVer: { old: 1 } } }, 'hs'), got };
        S.providers.delete('hsVer');
        // a provider that cannot work is told at register, not when the player saves
        out.reg = ['save', 'load'].map(k => { try { S.define('hsBad', { save: () => 1, load: () => {}, [k]: 5 }); S.providers.delete('hsBad'); return 'accepted'; } catch (e) { return e.message.includes(k) ? 'refused' : e.message; } });
        return out;
      }, CLEAR);
      check('two refused writes: both false, memory holds what is stored', r.two[0] === false && r.two[1] === false && r.mem === 1 && r.disk === 1, JSON.stringify(r));
      check('the slot saves again once storage works', r.again === true, JSON.stringify(r));
      check('a part saving NaN refuses the save and keeps the loadable one', r.nan.ok === false && r.nan.kept && r.nan.check === null, JSON.stringify(r.nan));
      check('a version that is no whole number is refused before load()', r.ver.ok === false && r.ver.got === null, JSON.stringify(r.ver));
      check('register refuses a save / load that is not a function', r.reg.every(x => x === 'refused'), JSON.stringify(r.reg));
    },
  },
  {
    name: 'saves hostile: attachments and imports: a non-Blob is refused, a damaged row does not stop the backup, a failed import leaves no half, hostile times become safe ones [guard]',
    url: '/?threedog-headless',
    expectErrors: /failed to write/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {};
        out.put = await Promise.all(['text', { a: 1 }, null].map(v => S.putAttachment('hs', 'x', v).then(() => 'stored', e => e.code ?? e.message)));
        // a row damaged outside the engine: export still gives the save and every good attachment
        const t = S.store.db.transaction('blobs', 'readwrite');
        t.objectStore('blobs').put({ group: 'hs', id: 'damaged', at: 1, blob: null, meta: null });
        await new Promise(res => { t.oncomplete = res; });
        await S.putAttachment('hs', 'good', new Blob(['hi'], { type: 'text/plain' }));
        await S.save('hs-exp');
        const click = HTMLAnchorElement.prototype.click, made = URL.createObjectURL;
        let file = null;
        URL.createObjectURL = b => { file = b; return made.call(URL, b); };
        HTMLAnchorElement.prototype.click = function () {};
        out.exp = await S.exportFile('hs-exp').catch(e => 'rejected ' + e.message);
        const read = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function () { queueMicrotask(() => this.onerror?.()); };
        out.expFail = await S.exportFile('hs-exp').catch(e => 'rejected ' + e?.message);
        FileReader.prototype.readAsDataURL = read;
        HTMLAnchorElement.prototype.click = click; URL.createObjectURL = made;
        out.files = file ? JSON.parse(await file.text()).files.map(f => f.id) : null;
        await S.removeAttachment('hs', 'damaged'); await S.removeAttachment('hs', 'good');
        // a write that fails on the second attachment: nothing of the import stays
        const data = S._json.get('hs-exp'), f = id => ({ group: 'hsi', id, at: 1, meta: null, type: 'text/plain', url: 'data:text/plain;base64,aGk=' });
        const put = IDBObjectStore.prototype.put;
        let n = 0;
        IDBObjectStore.prototype.put = function (v) { if (v?.group === 'hsi' && ++n === 2) throw new DOMException('full', 'QuotaExceededError'); return put.call(this, v); };
        out.imp = await S.importFile(new Blob([`{"threedog":"save","format":1,"data":${data},"files":${JSON.stringify([f('a'), f('b'), f('c')])}}`]), 'hs-imp');
        IDBObjectStore.prototype.put = put;
        out.listed = S.list().some(s => s.slot === 'hs-imp');
        out.left = (await S.attachments('hsi')).length;
        // hostile times
        const base = JSON.parse(data), wrap = o => new Blob([JSON.stringify({ threedog: 'save', ...o })]);
        await S.importFile(wrap({ data: { ...base, savedAt: { evil: 1 } }, files: [{ group: 'hsi', id: 't', at: 'no time', url: 'data:,hi' }] }), 'hs-at');
        out.savedAt = S.list().find(s => s.slot === 'hs-at')?.savedAt;
        out.at = (await S.attachments('hsi'))[0]?.at;
        await S.removeAttachment('hsi', 't');
        for (const k of ['hs-exp', 'hs-at']) await S.remove(k);
        return out;
      });
      check('a non-Blob attachment is refused', r.put.every(x => x !== 'stored'), JSON.stringify(r.put));
      check('a damaged attachment row does not stop the export; the good one is in the file', r.exp === true && JSON.stringify(r.files) === '["good"]', JSON.stringify(r));
      check('an attachment that cannot be read fails the export with false, not a rejection', r.expFail === false, JSON.stringify(r));
      check('an import whose attachment write fails leaves neither the slot nor part of the attachments', r.imp === null && !r.listed && r.left === 0, JSON.stringify(r));
      check('a savedAt or at that is no number becomes one', Number.isFinite(r.savedAt) && Number.isFinite(r.at), JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: localStorage fallback: a damaged slot is listed as corrupt and can be saved over; a failed write of the text keeps the old rev (reload) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev, page }) {
      await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get: () => undefined }));
      await ev(() => { const p = engine.saves._prefix; localStorage.setItem(p + 'hs-broken', '{{{ not json'); localStorage.setItem(p + 'hs-null', 'null'); });
      await page.reload();
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const S = engine.saves, out = { mode: S.store.mode, check: [S.check('hs-broken'), S.check('hs-null')], savedAt: S.list().find(s => s.slot === 'hs-null')?.savedAt };
        out.save = [await S.save('hs-broken'), await S.save('hs-null')];
        out.after = S.check('hs-broken');
        await S.save('hs-q');
        const old = localStorage.getItem(S.store._revKey('hs-q')), set = Storage.prototype.setItem, p = S._prefix;
        Storage.prototype.setItem = function (k, v) { if (k === p + 'hs-q') throw new DOMException('q', 'QuotaExceededError'); return set.call(this, k, v); };
        out.full = await S.save('hs-q');
        Storage.prototype.setItem = set;
        out.rev = localStorage.getItem(S.store._revKey('hs-q')) === old;
        out.next = await S.save('hs-q');
        for (const k of ['hs-broken', 'hs-null', 'hs-q']) await S.remove(k);
        return out;
      });
      check('the fallback is in use', r.mode === 'localStorage', JSON.stringify(r));
      check('damaged slots read as corrupt, as they do with IndexedDB', r.check.every(c => c === 'corrupt') && Number.isFinite(r.savedAt), JSON.stringify(r));
      check('a damaged slot can be saved over', r.save.every(Boolean) && r.after === null, JSON.stringify(r));
      check('a refused text write leaves the rev, so this tab can save again', r.full === false && r.rev && r.next === true, JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a failed replacement keeps what the old playthrough had waiting; what a load sets up belongs to the new one; a failed quit stays in the game [guard]',
    url: '/?threedog-headless',
    expectErrors: /hs boom/,
    async run({ check, ev }) {
      const r = await ev(async CLEAR_SRC => {
        const S = engine.saves, clear = (0, eval)('(' + CLEAR_SRC + ')'), out = {};
        // background results of the playthrough that goes on still land
        S.define('hsF', { save: () => ({ a: 1 }), load: d => { if (d.bad) throw new Error('hs boom'); } });
        const good = S.collect(), bad = JSON.parse(JSON.stringify(good));
        bad.parts.hsF = { bad: 1 };
        let hit = 0, hit2 = 0, dropped = 0;
        engine.commits.request({ apply: () => hit++, fallback: () => 1, lag: 3 });
        out.direct = await S.apply(bad, 'hs');
        clear();
        engine.step(0.2, { describe: false });
        await S._put('hs-bad', JSON.stringify(bad), Date.now());
        engine.commits.request({ apply: () => hit2++, fallback: () => 1, lag: 3 });
        out.session = await engine.session.load('hs-bad');
        clear();
        engine.step(0.2, { describe: false });
        out.hits = [hit, hit2];
        // a load that goes through still drops them
        engine.commits.request({ apply: () => dropped++, fallback: () => 1, lag: 3 });
        await S.apply(good, 'hs');
        engine.step(0.2, { describe: false });
        out.dropped = dropped;
        await S.remove('hs-bad');
        S.providers.delete('hsF');
        // a part's load / an afterLoad sets up the playthrough being loaded; only what the old one had goes
        let timer = 0, ear = 0, ear2 = 0, oldEar = 0, oldTimer = 0;
        S.define('hsS', { save: () => ({ a: 1 }), load: () => { engine.session.track(engine.events.on('hs:ping', () => ear++)); engine.clock.after(0.1, () => timer++); } });
        engine.modules.set('hsM', { name: 'hsM', afterLoad() { engine.session.track(engine.events.on('hs:ping', () => ear2++)); } }); engine._modState.set('hsM', 'running');   // a stand-in module: the afterLoad gate runs only modules that run
        await S.save('hs-s');
        engine.session.track(engine.events.on('hs:ping', () => oldEar++));
        engine.clock.after(0.1, () => oldTimer++);
        out.loaded = await engine.session.load('hs-s');
        engine.events.emit('hs:ping');
        engine.step(0.5, { describe: false });
        out.setup = { timer, ear, ear2, oldEar, oldTimer };
        S.providers.delete('hsS'); engine.modules.delete('hsM'); engine._modState.delete('hsM');
        await S.remove('hs-s');
        // quit whose apply fails: the game goes on, flow comes back, session:failed says so
        const log = [], id = engine.session.id;
        const hs = ['session:failed', 'session:start'].map(n => engine.events.on(n, x => log.push(n + ':' + x?.kind)));
        let boom = true, opened = 0;
        const open = engine.ui.open;
        engine.ui.open = function (n, d) { if (n === 'title') opened++; return open.call(this, n, d); };
        S.define('hsQ', { save: () => ({ a: 1 }), load: () => { if (boom) { boom = false; throw new Error('hs boom'); } } });
        out.quit = await engine.session.quit();
        engine.ui.open = open;
        clear();
        hs.forEach(h => h.remove()); S.providers.delete('hsQ');
        out.quitInfo = { log, opened, same: engine.session.id === id };
        return out;
      }, CLEAR);
      check('a failed load is false both ways', r.direct === false && r.session === false, JSON.stringify(r));
      check('background results of the playthrough that goes on still land', r.hits[0] === 1 && r.hits[1] === 1, JSON.stringify(r));
      check('a load that went through drops them', r.dropped === 0, JSON.stringify(r));
      check('listeners and timers a load sets up live on; the old ones are gone', r.loaded && r.setup.timer === 1 && r.setup.ear === 1 && r.setup.ear2 === 1 && r.setup.oldEar === 0 && r.setup.oldTimer === 0, JSON.stringify(r));
      check('a failed quit opens no title and says session:failed', r.quit === false && r.quitInfo.opened === 0 && r.quitInfo.same && r.quitInfo.log.join() === 'session:failed:quit', JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a late part that cannot take its data keeps it in the save; huge counters cannot repeat ids; vars keys are the game\'s own [guard]',
    url: '/?threedog-headless',
    expectErrors: /hs boom|save part 'hsA'|is version 3/,
    async run({ check, ev }) {
      const r = await ev(async CLEAR_SRC => {
        const S = engine.saves, clear = (0, eval)('(' + CLEAR_SRC + ')'), W = f => engine.ops.allow(f), out = {};
        const base = JSON.parse(JSON.stringify(S.collect()));
        const d = JSON.parse(JSON.stringify(base));
        d.parts.hsA = { keep: 'gold' }; d.versions.hsA = 3; d.parts.hsB = { keep: 'silver' }; d.parts.hsC = { keep: 'iron' };
        await S.apply(d, 'hs');
        S.define('hsA', { version: 2, migrate: { 1: x => x }, save: () => ({ fresh: true }), load: () => {} });
        S.define('hsB', { save: () => ({ fresh: true }), load: () => { throw new Error('hs boom'); } });
        S.define('hsC', { save: () => ({ fresh: true }), load: () => Promise.reject(new Error('hs boom')) });
        await new Promise(res => setTimeout(res, 20));
        clear();
        const c = S.collect();
        out.kept = [c.parts.hsA, c.versions.hsA, c.parts.hsB, c.parts.hsC];
        for (const k of ['hsA', 'hsB', 'hsC']) S.providers.delete(k);
        await S.apply(base, 'hs');
        // a later good load puts the part back in charge of its data
        const after = S.collect();
        out.gone = 'hsA' in after.parts;
        // a counter past whole numbers stops counting: every new id was the same one
        const e2 = JSON.parse(JSON.stringify(base));
        e2.parts.world.seq = 1e308; e2.parts.inventory.seq = 1e308;
        out.seqWorld = await S.apply(e2, 'hs');
        const e3 = JSON.parse(JSON.stringify(base));
        e3.parts.inventory.seq = 1e308;
        out.seqInv = await S.apply(e3, 'hs');
        out.keys = [engine.inventory._newKey('a'), engine.inventory._newKey('a')];
        await S.apply(base, 'hs');
        // clocks past what a step can move stop time for good
        const e4 = JSON.parse(JSON.stringify(base));
        e4.parts.time.channels.world = 1e308;
        await S.apply(e4, 'hs');
        const t0 = engine.time.now('world');
        engine.step(0.2, { describe: false });
        out.moved = engine.time.now('world') > t0;
        await S.apply(base, 'hs');
        const e6 = JSON.parse(JSON.stringify(base));
        e6.parts.world.time = 1e308;
        out.worldTime = await S.apply(e6, 'hs');
        // weather halfway through a change: a duration or timer that is no number spread NaN through every blended field
        const e7 = JSON.parse(JSON.stringify(base));
        Object.assign(e7.parts.weather, { t: 0.5, dur: 'x', autoTimer: 'soon', nextBolt: {}, auto: 'yes' });
        out.weatherOk = await S.apply(e7, 'hs');
        engine.step(0.2, { describe: false });
        out.weather = { finite: Object.values(engine.weather.current).every(Number.isFinite), t: engine.weather.t, timer: engine.weather.autoTimer, bolt: engine.weather.nextBolt, auto: engine.weather.auto };
        await S.apply(base, 'hs');
        // vars: a name on Object.prototype is an ordinary name
        out.vars = { flag: engine.vars.flag('constructor'), n: engine.vars.counter('toString'), bump: W(() => engine.vars.bump('valueOf', 2)) };
        out.bad = ['x', NaN, Infinity].map(n => { try { W(() => engine.vars.bump('hs', n)); return 'accepted'; } catch (e) { return e.code ?? e.message; } });
        const e5 = JSON.parse(JSON.stringify(base));
        e5.parts.vars.counters = { hs: 'lots', fine: 2 };
        await S.apply(e5, 'hs');
        out.loaded = [engine.vars.counter('hs'), engine.vars.counter('fine')];
        await S.apply(base, 'hs');
        return out;
      }, CLEAR);
      check('data a late part refused stays in the save at its version', JSON.stringify(r.kept) === '[{"keep":"gold"},3,{"keep":"silver"},{"keep":"iron"}]', JSON.stringify(r.kept));
      check('a later load replaces it', r.gone === false, JSON.stringify(r));
      check('a world seq past whole numbers is refused', r.seqWorld === false, JSON.stringify(r));
      check('an inventory seq past whole numbers cannot repeat a key', r.keys[0] !== r.keys[1], JSON.stringify(r));
      check('a clock past what a step moves is clamped, time goes on', r.moved === true, JSON.stringify(r));
      check('a world time past what a step moves is refused', r.worldTime === false, JSON.stringify(r));
      check('weather numbers that are not numbers are replaced, the blend stays finite', r.weatherOk === true && r.weather.finite && Number.isFinite(r.weather.t) && Number.isFinite(r.weather.timer) && Number.isFinite(r.weather.bolt) && r.weather.auto === false, JSON.stringify(r.weather));
      check('vars names on Object.prototype read as unset', r.vars.flag === undefined && r.vars.n === 0 && r.vars.bump === 2, JSON.stringify(r.vars));
      check('bump refuses what is no number', r.bad.every(x => x !== 'accepted'), JSON.stringify(r.bad));
      check('a saved counter that is no number is dropped with the rest kept', r.loaded[0] === 0 && r.loaded[1] === 2, JSON.stringify(r.loaded));
    },
  },
  {
    name: 'saves hostile: what a save holds for something not made yet rides in the next save (a time channel, a swarm) [guard]',
    url: '/tests/swarm/index.html?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {}, base = JSON.parse(JSON.stringify(S.collect()));
        const d = JSON.parse(JSON.stringify(base));
        d.parts.time.channels.hsLater = 12;
        d.parts.swarm = { ...d.parts.swarm, hsLater: { serial: 2, id: [2 ** 20 + 1], cols: {} } };
        await S.apply(d, 'hs');
        const c = S.collect();
        out.channel = c.parts.time.channels.hsLater; out.swarm = c.parts.swarm.hsLater?.id;
        await S.apply(base, 'hs');
        return out;
      });
      check('a channel the game has not defined yet stays in the next save', r.channel === 12, JSON.stringify(r));
      check('a swarm the game has not made yet stays in the next save', r.swarm?.length === 1, JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a terrain edit too big to hold is refused at once, in every build (open world) [guard]',
    url: '/?threedog-headless',
    timeout: 60000,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const code = f => { try { engine.ops.allow(f); return 'accepted'; } catch (e) { return e.code; } };
        const out = { edit: code(() => engine.terrain.edit({ x: 0, z: 0 }, { radius: 1e9, raise: 0.1 })) };
        // a position the save format refuses used to be taken here: save() said true and that save never loaded again
        out.far = code(() => engine.world.add({ kind: 'pickup', position: { x: 1e308, y: 0, z: 0 } }));
        out.radius = [NaN, -1, Infinity].map(n => code(() => engine.triggers.add({ position: { x: 0, z: 0 }, radius: n })));
        out.saved = await engine.saves.save('hs-far'); out.load = await engine.saves.load('hs-far');
        await engine.saves.remove('hs-far');
        return out;
      });
      check('radius 1e9 is refused before any point is touched', r.edit === 'terrain-option', JSON.stringify(r));
      check('a position past what a save holds is refused where it is written, and the save stays loadable', r.far !== 'accepted' && r.saved && r.load, JSON.stringify(r));
      check('a trigger radius that is no size is refused', r.radius.every(c => c !== 'accepted'), JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a new game closes the engine\'s own windows of the old playthrough, and their freeze with them (open world) [guard]',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.ui.open('inventory');
        const open = engine.ui.isOpen('inventory');
        await engine.session.newGame();
        return { open, after: engine.ui.isOpen('inventory'), frozen: engine.frozen };
      });
      check('the inventory window closes with the playthrough and nothing stays frozen', r.open && !r.after && !r.frozen, JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a grid without a usable cell, origin or size is refused at grids.add; a huge one costs nothing [guard]',
    url: '/tests/level/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        if (!engine.grids) engine.use(window.grids());
        const code = (n, o) => { try { engine.grids.add(n, o); return 'accepted'; } catch (e) { return e.code; } };
        return { bad: [{ cell: 0 }, { cell: -1 }, { cell: NaN }, { origin: [NaN, 0] }, { size: [-1, 2] }, { size: [2.5, 2] }, { size: [NaN, 2] }].map((o, i) => code('hs-bad' + i, o)), huge: code('hs-huge', { size: [1e9, 1e9] }) };
      });
      check('each is refused', r.bad.every(c => c === 'grids-misuse'), JSON.stringify(r));
      check('a huge size is only numbers', r.huge === 'accepted', JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: two real tabs: one slot has one writer, a tab closed in the middle of a write leaves a whole save [guard]',
    url: '/?threedog-headless',
    timeout: 180000,
    async run({ check, ev, page }) {
      const [tab2] = await Promise.all([page.waitForEvent('popup'), ev(u => { window.open(u); }, page.url())]);
      await tab2.waitForFunction(() => window.engine?.ready, null, { timeout: 90000 });
      const part = () => { window.hsBig = 'A'; engine.saves.define('hsBig', { save: () => ({ big: window.hsBig }), load: () => {} }); window.hsGo = async () => { const o = []; for (let i = 0; i < 20; i++) o.push(await engine.saves.save('hs-race')); return o; }; };
      await ev(part); await tab2.evaluate(part);
      const [a, b] = await Promise.all([ev(() => window.hsGo()), tab2.evaluate(() => window.hsGo())]);
      const race = await ev(async () => {
        await new Promise(res => setTimeout(res, 200));
        const S = engine.saves, d = await S.store.getSlot('hs-race');
        return { same: d.json === S._json.get('hs-race') };
      });
      await tab2.evaluate(async () => { const S = engine.saves; await S.load('hs-race'); window.hsBig = 'A'.repeat(2e7); await S.save('hs-close'); window.hsBig = 'B'.repeat(2e7); S.save('hs-close'); });
      await tab2.close({ runBeforeUnload: false });
      const closed = await ev(async () => {
        await new Promise(res => setTimeout(res, 800));
        const S = engine.saves, d = await S.store.getSlot('hs-close'), big = JSON.parse(d.json).parts.hsBig.big;
        const out = { head: big[0], whole: big === big[0].repeat(2e7) };
        S.providers.delete('hsBig'); await S.remove('hs-close'); await S.remove('hs-race');
        return out;
      });
      const wa = a.filter(Boolean).length, wb = b.filter(Boolean).length;
      check('each refused save said false; the tab that lost never wrote after the other', (wa === 0 || wb === 0) && wa + wb > 0, JSON.stringify({ wa, wb }));
      check('memory and disk agree after the race', race.same, JSON.stringify(race));
      check('a tab closed mid-write leaves one whole save', closed.whole, JSON.stringify(closed));
    },
  },
  {
    name: 'saves hostile: a photo attachment whose meta names a url shows its own bytes, not that url [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.saves.putAttachment('photo', 'hs-meta', new Blob(['x'], { type: 'image/png' }), { url: 'https://evil.example/p.png', subject: 'hs' });
        await engine.saves.flush(); await engine.photo.restore();
        const shot = engine.photo.album.find(s => s.id === 'hs-meta'), out = { url: shot?.url, subject: shot?.subject };
        await engine.saves.removeAttachment('photo', 'hs-meta');
        return out;
      });
      check('the album holds the stored bytes and keeps the rest of the meta', r.url?.startsWith('blob:') && r.subject === 'hs', JSON.stringify(r));
    },
  },
  {
    name: 'saves hostile: a save cannot make the game fetch: a level or record model naming a URL is refused with the old state kept; registered names and same-origin paths still load [guard]',
    url: '/tests/level/index.html?threedog-headless',
    expectErrors: /save-bad-record|hs-missing/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {}, asked = [], realFetch = window.fetch;
        window.fetch = (u, ...a) => { asked.push(String(u?.url ?? u)); return realFetch(u, ...a); };
        const warns = [], warn = console.warn;
        console.warn = (...x) => { warns.push(x.join(' ')); warn(...x); };
        const root = engine.level.root, base = S.collect();
        const withLevel = name => ({ ...base, parts: { ...base.parts, level: name } });
        const hostile = ['https://evil.example/x.glb', 'http://evil.example/x.glb', '//evil.example/x.glb', '/\\evil.example/x.glb', '\\\\evil.example\\x.glb', '/\t/evil.example/x.glb',
          'HTTPS://evil.example/x.glb', 'data:model/gltf+json,{}', 'blob:' + location.origin + '/x', location.origin + '/models/x.glb', '../secret/x.glb', 'models/../../x.glb', '/models/%2e%2e/x.glb', 'models\\..\\x.glb'];
        out.level = [];
        for (const name of hostile) {
          warns.length = 0;
          const ok = await S.apply(withLevel(name), 'hs-url');
          out.level.push({ name, ok, kept: engine.level.root === root, coded: warns.some(w => w.includes('save-bad-record')), error: engine.error?.message ?? null });
        }
        out.fetchedHostile = [...asked];
        // what names a level legitimately: a registered name and a same-origin path
        engine.assets.manifest({ name: 'hs', models: { hsRoom: () => new THREE.Group() } });
        out.registered = await S.apply(withLevel('hsRoom'), 'hs-url');
        out.nowRegistered = S.collect().parts.level;
        asked.length = 0;
        const room = engine.level.root;
        out.relative = await S.apply(withLevel('models/hs-missing.glb'), 'hs-url');
        out.relativeAsked = asked.some(u => u.endsWith('models/hs-missing.glb'));
        out.relativeKept = engine.level.root === room;
        engine.error = null; engine.stacks.get('freeze').release('error');
        // the same words in a world record: a prop or pickup builds whatever its model field says
        asked.length = 0;
        const rec = { kind: 'prop', position: { x: 0, y: 0, z: 0 }, model: 'https://evil.example/m.glb' };
        const world = base.parts.world, parts = w => ({ ...base, parts: { ...base.parts, world: { ...world, ...w } } });
        const count = engine.world.records.size;
        out.record = await S.apply(parts({ records: { ...world.records, hsProp: rec } }), 'hs-url');
        out.recordList = await S.apply(parts({ records: { ...world.records, hsProp: { ...rec, model: ['//evil.example/m.glb', 1] } } }), 'hs-url');
        out.changed = await S.apply(parts({ changed: { ...world.changed, hsProp: { set: { model: 'https://evil.example/m.glb' } } } }), 'hs-url');
        out.recordsKept = engine.world.records.size === count;
        out.modelFine = await S.apply(parts({ records: { ...world.records, hsProp: { ...rec, model: 'hsRoom' } } }), 'hs-url');
        out.fetchedRecord = [...asked];
        console.warn = warn; window.fetch = realFetch;
        return out;
      });
      const show = JSON.stringify(r);
      check('every URL and escape is refused, coded, with the old level kept', r.level.every(x => x.ok === false && x.kept && x.coded), show);
      check('a refused save does not stop the game like a code error would', r.level.every(x => x.error === null), show);
      check('nothing was fetched for them', r.fetchedHostile.length === 0, show);
      check('a registered name loads', r.registered === true && r.nowRegistered === 'hsRoom', show);
      check('a same-origin path is asked for, and a failure keeps the level', r.relative === false && r.relativeAsked && r.relativeKept, show);
      check('a record model naming a URL is refused, as a list too and as a saved change', r.record === false && r.recordList === false && r.changed === false && r.recordsKept, show);
      check('a record model naming an asset loads, and nothing was fetched for the refused ones', r.modelFine === true && !r.fetchedRecord.some(u => u.includes('evil')), show);
    },
  },
  {
    name: 'saves hostile: two tabs: remove and attachments keep what another tab wrote since this tab last looked; what this tab sees it may change [guard]',
    url: '/?threedog-headless',
    expectErrors: /save-stale/,
    async run({ check, ev }) {
      // two engines with one saveKey share the database as two tabs do; a deaf tab is one the note from the other has not reached yet
      const r = await ev(async () => {
        const mk = () => new engine.constructor({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'hs-tabs' });
        const deaf = e => { e.saves._bc.onmessage = null; };
        const text = async rows => (await rows[0]?.blob.text()) ?? null;
        const out = {}, warns = [], warn = console.warn;
        console.warn = (...x) => { warns.push(x.join(' ')); warn(...x); };
        const A = mk();
        await A.saves.whenReady;
        await A.saves.save('hs-rm');
        const B = mk();
        await B.saves.whenReady;
        deaf(A);
        try {
          await B.saves.save('hs-rm');
          await A.saves.remove('hs-rm');
          out.rm = { disk: !!(await A.saves.store.getSlot('hs-rm')), listed: A.saves.list().some(s => s.slot === 'hs-rm'), told: warns.some(w => w.includes('[save-stale]')) };
          out.rmSave = await A.saves.save('hs-rm');   // the refused tab is still behind: its next save is refused too
          out.rmNow = await A.saves.remove('hs-rm').then(() => A.saves.store.getSlot('hs-rm'));   // it lists that save now, so deleting what it shows is the player's choice
          await B.saves.remove('hs-rm');   // gone already: nothing to protect, nothing to tell
          warns.length = 0;
          await A.saves.remove('hs-rm');
          out.rmGone = { told: warns.length, disk: await A.saves.store.getSlot('hs-rm') };

          const blob = t => new Blob([t]), put = (e, t) => e.saves.putAttachment('hs', 'x', blob(t)).then(() => 'stored', err => err.code ?? String(err));
          const drop = e => e.saves.removeAttachment('hs', 'x').then(() => 'gone', err => err.code ?? String(err));
          out.first = await put(A, 'one');
          out.overOwn = await put(A, 'two');
          const seen = await B.saves.attachments('hs');
          out.bSaw = await text(seen);
          out.bOver = await put(B, 'three');
          out.staleOver = await put(A, 'old');
          out.staleDrop = await drop(A);
          out.kept = await text(await B.saves.attachments('hs'));
          await A.saves.attachments('hs');   // reading is looking: this tab may change it now
          out.afterLook = await put(A, 'four');
          const C = mk();
          await C.saves.whenReady;   // a page opened later knows what is stored: a reload replaces its own attachment as before
          out.fresh = await put(C, 'five');
          C.dispose();
          out.cross = await put(B, 'newer in another tab');   // B has not looked since 'three'
          // an unseen row of another tab is protected even under an id this tab never touched
          await A.saves.putAttachment('hs', 'y', blob('a'));
          out.unseen = await B.saves.putAttachment('hs', 'y', blob('b')).then(() => 'stored', err => err.code);
          // a row with no rev (an older build, a file import, the store used directly) claims nothing
          await A.saves.store.putBlob('hs', 'z', blob('plain'));
          out.plain = await B.saves.putAttachment('hs', 'z', blob('b')).then(() => 'stored', err => err.code);
          await A.saves.attachments('hs');
          await A.saves.removeAttachment('hs', 'x'); await A.saves.removeAttachment('hs', 'y');
          await B.saves.attachments('hs');
          await B.saves.removeAttachment('hs', 'z');
          out.left = (await B.saves.attachments('hs')).length;
          out.missing = await drop(A);
        } finally { console.warn = warn; A.dispose(); B.dispose(); }
        // the localStorage fallback goes through the same compare
        const st = new engine.saves.store.constructor('hs-ls', 'hs-ls-');
        st.mode = 'localStorage';
        await st.putSlot('s', 1, '{}', 'r1');
        out.ls = await st.deleteSlot('s', 'old').then(() => 'deleted', e => e.stale !== undefined ? 'stale' : String(e));
        out.lsKept = (await st.getSlot('s'))?.rev;
        await st.deleteSlot('s', 'r1');
        out.lsGone = await st.getSlot('s');
        return out;
      });
      const show = JSON.stringify(r);
      check('remove keeps a newer save from another tab, says so, and the tab lists it again', r.rm.disk && r.rm.listed && r.rm.told, show);
      check('that tab may still not write over it', r.rmSave === false, show);
      check('a save this tab lists can be deleted', r.rmNow === null, show);
      check('a slot another tab deleted is simply gone', r.rmGone.told === 0 && r.rmGone.disk === null, show);
      check('a tab replaces its own attachment and one it has read', r.first === 'stored' && r.overOwn === 'stored' && r.bSaw === 'two' && r.bOver === 'stored', show);
      check('an attachment another tab replaced is neither overwritten nor deleted, by code', r.staleOver === 'save-stale' && r.staleDrop === 'save-stale' && r.kept === 'three', show);
      check('after reading it the tab may replace it; a page opened later too', r.afterLook === 'stored' && r.fresh === 'stored', show);
      check('a tab behind stays refused, also under a new id', r.cross === 'save-stale' && r.unseen === 'save-stale', show);
      check('a row with no rev claims nothing; everything can be cleaned up; no such id is fine', r.plain === 'stored' && r.left === 0 && r.missing === 'gone', show);
      check('localStorage: the delete compares too', r.ls === 'stale' && r.lsKept === 'r1' && r.lsGone === null, show);
    },
  },
];
