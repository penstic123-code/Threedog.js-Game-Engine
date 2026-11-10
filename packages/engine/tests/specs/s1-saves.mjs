// 1.7 saves: world saves use IndexedDB (photos stored separately), export / import files. Same format as the other files here.
// Every test runs in a fresh browser context (storage is empty). The consistency test "keep running vs save -> reload -> continue" waits until the 1.11 world data rework.
import { readFileSync } from 'node:fs';

const READY = { timeout: 60000 };
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, READY); };

export const specs = [
  {
    name: 'S1 saves: a save over 5MB does not fail and reads back identically; it is not put in localStorage (city)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const big = 'abcdefghij'.repeat(700000);   // 7MB of text, too big for localStorage (about 5MB)
        let loaded = null;
        engine.saves.define('s1big', { save: () => ({ big, n: 42 }), load: d => { loaded = d; } });
        const ok = await engine.saves.save('s1-big');
        const listed = engine.saves.list().some(s => s.slot === 's1-big');
        const lsKeys = Object.keys(localStorage).filter(k => k.includes('s1-big'));
        loaded = null; const sync = await engine.saves.load('s1-big');
        return { ok, listed, sync, lsKeys, same: loaded?.big === big && loaded?.n === 42, mode: engine.saves.store.mode,
          bytes: JSON.stringify(engine.saves.collect()).length };
      });
      check('uses IndexedDB', r.mode === 'idb', r.mode);
      check('a save over 5MB is still saved successfully', r.ok === true && r.bytes > 5 * 1024 * 1024, JSON.stringify({ ok: r.ok, bytes: r.bytes }));
      check('it is in list, and load reads it back synchronously with identical content', r.listed && r.sync === true && r.same, JSON.stringify(r));
      check('this save is not in localStorage', r.lsKeys.length === 0, r.lsKeys.join());
    },
  },
  {
    // Why: flush() is the promise "nothing is still on its way to disk". An attachment that skips the queue breaks it without any error.
    name: 'S1 saves: flush waits for an attachment made by a function; the queue and prefix stay private (open world)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves;
        S.putAttachment('s1-att', 'a', async () => { await new Promise(res => setTimeout(res, 30)); return new Blob(['bytes']); }, { n: 1 });
        await S.flush();
        const rows = await S.attachments('s1-att');
        await S.removeAttachment('s1-att', 'a');
        return { rows: rows.map(x => [x.id, x.meta.n, x.blob.size]), left: (await S.attachments('s1-att')).length,
          key: S.storageKey('settings'), settings: engine.settings?.storageKey, old: [typeof S.queue, typeof S.prefix] };
      });
      check('flush waited for the bytes', JSON.stringify(r.rows) === '[["a",1,5]]', JSON.stringify(r.rows));
      check('removeAttachment deletes', r.left === 0);
      check('settings takes its key from storageKey', !r.settings || r.settings === r.key, `${r.settings} / ${r.key}`);
      check('saves.queue and saves.prefix are not public', r.old.join() === 'undefined,undefined', r.old.join());
    },
  },
  {
    name: 'S1 saves: save (with a photo) -> reopen the page -> it is in list, load reads it back, the photo returns to the album (open world)',
    url: '/',
    async run({ page, check, ev, wait }) {
      await ev(async () => {
        engine.saves.define('s1keep', { save: () => ({ v: 'hello', arr: [1, 2, 3] }), load: d => { window.s1got = d; } });
        engine.ops.run('photo.take', {}, { source: 'test' }).value;
        await engine.saves.save('s1-keep');
        await engine.saves.flush();
      });
      await reload(page);
      const r = await ev(async () => {
        engine.saves.define('s1keep', { save: () => null, load: d => { window.s1got = d; } });
        const listed = engine.saves.list().some(s => s.slot === 's1-keep');   // start() has already waited for the save index to be read into memory, no await needed
        const ok = await engine.saves.load('s1-keep');
        await engine.photo.restore();
        return { listed, ok, got: window.s1got, album: engine.photo.album.map(s => s.url.slice(0, 5)) };
      });
      check('after reopening it is in list', r.listed);
      check('load reads back the original content', r.ok === true && r.got?.v === 'hello' && r.got.arr.join() === '1,2,3', JSON.stringify(r.got));
      check('the photo returns from IndexedDB to the album (blob: address)', r.album.length === 1 && r.album[0] === 'blob:', JSON.stringify(r.album));
    },
  },
  {
    name: 'S1 saves: exportFile download -> importFile restore, the round trip is identical and the photo comes back too; a bad file does no damage (open world)',
    software: false,   // the photo in the save is read back, not compared
    url: '/',
    async run({ page, check, ev }) {
      await ev(async () => {
        engine.saves.define('s1exp', { save: () => ({ k: 'v', n: [1, 2] }), load: d => { window.s1got = d; } });
        engine.ops.run('photo.take', {}, { source: 'test' }).value;
        await engine.saves.save('s1-exp');
      });
      const [dl] = await Promise.all([page.waitForEvent('download'), ev(() => engine.saves.exportFile('s1-exp'))]);
      const text = readFileSync(await dl.path(), 'utf8');
      const file = JSON.parse(text);
      check('the file is .json, carrying the save and the photo', dl.suggestedFilename().endsWith('.json') && file.slot === 's1-exp' && file.data.parts.s1exp.k === 'v' && file.files.length === 1,
        dl.suggestedFilename() + ' ' + file.files?.length);
      const r = await ev(async text => {
        await engine.saves.remove('s1-exp');
        for (const b of await engine.saves.store.blobs()) await engine.saves.store.deleteBlob(b.group, b.id);
        engine.photo.album.length = 0;
        const gone = !engine.saves.list().some(s => s.slot === 's1-exp');
        const slot = await engine.saves.importFile(new File([text], 'save.json'), 's1-back');   // pass a File, no picker dialog
        window.s1got = null;
        const ok = await engine.saves.load('s1-back');
        await engine.saves.flush(); await engine.photo.restore();
        const bad = await engine.saves.importFile(new File(['not json'], 'bad.json'));
        return { gone, slot, ok, got: window.s1got, album: engine.photo.album.length, bad, still: engine.saves.list().some(s => s.slot === 's1-back') };
      }, text);
      check('after deleting, it is really gone', r.gone);
      check('importFile returns the slot name, and load reads back identical content', r.slot === 's1-back' && r.ok === true && r.got?.k === 'v' && r.got.n.join() === '1,2', JSON.stringify(r));
      check('the photo returns to the album', r.album === 1, String(r.album));
      check('an invalid file returns null and existing saves are unaffected', r.bad === null && r.still);
    },
  },
  {
    name: 'S1 saves: a write failure shows a notice (toast + console), save returns false, a slot never written is not offered (city)',
    url: '/tests/city/index.html',
    expectErrors: /\[saves\]/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.saves.store.putSlot = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
        engine.saves.define('s1q', { save: () => ({ a: 1 }), load: () => {} });
        const ok = await engine.saves.save('s1-quota');
        return { ok, toast: [...document.querySelectorAll('.threedog-toast')].map(t => t.textContent).join('|'), inMemory: await engine.saves.load('s1-quota') };
      });
      check('save returns false', r.ok === false);
      check('the failure toast is shown', r.toast.includes('存档失败'), r.toast);
      check('a slot whose only write failed is not offered (memory follows the disk)', r.inMemory === false);
    },
  },
  {
    name: 'S1 saves: falls back to localStorage when IndexedDB is unavailable (city)',
    url: '/tests/city/index.html',
    async run({ page, check, ev }) {
      await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get: () => undefined }));
      await reload(page);
      const r = await ev(async () => {
        let got = null;
        engine.saves.define('s1ls', { save: () => ({ z: 9 }), load: d => { got = d; } });
        const ok = await engine.saves.save('s1-ls');
        const inLS = !!localStorage.getItem(engine.saves._prefix + 's1-ls');
        engine.saves.load('s1-ls');
        return { mode: engine.saves.store.mode, ok, inLS, got };
      });
      check('the mode is localStorage, the save is written in localStorage and reads back', r.mode === 'localStorage' && r.ok && r.inLS && r.got?.z === 9, JSON.stringify(r));
    },
  },
  {
    name: 'S1 saves: the load of a part throws -> load returns false, no save:loaded event, goes through reportError, the parts are rolled back; an import whose disk write failed is not reported as success; an import without savedAt records 0 (city)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, loads = [], imported = [];
        engine.events.on('save:loaded', s => loads.push(s)); engine.events.on('save:imported', s => imported.push(s));
        S.define('s1bad', { save: () => ({ a: 1 }), load: () => { throw new Error('boom'); } });
        let good = null; S.define('s1good', { save: () => ({ b: 2 }), load: d => { good = d; } });
        await S.save('s1-bad');
        const origErr = console.error; console.error = () => {};   // the deliberate errors are reported in the console; restored before the test ends
        const ok = await S.load('s1-bad');
        const errWhere = engine.error?.where;
        engine.error = null; engine.stacks.get('freeze').release('error');
        const noImportedAfterFail = (() => {   // disk write failure: _put returns false
          S.store.putSlot = () => Promise.reject(new Error('disk'));
          return S.importFile(new File([JSON.stringify({ threedog: 'save', data: { parts: { s1good: { b: 3 } } } })], 'x.json'), 's1-imp');
        })();
        const slot = await noImportedAfterFail;
        const noStamp = btoa(unescape(encodeURIComponent(JSON.stringify({ parts: {} }))));
        S.store.putSlot = () => Promise.resolve();
        const impOk = await S.import(noStamp, 's1-nostamp');
        console.error = origErr;
        return { ok, loads, good, errWhere, slot, imported, impOk, stamp: S.list().find(x => x.slot === 's1-nostamp')?.savedAt };
      });
      check('provider.load throws: load returns false, no save:loaded event', r.ok === false && r.loads.length === 0, JSON.stringify(r));
      check('the error goes through reportError (engine.error records where it happened), the other parts hold their pre-load state', /s1bad/.test(r.errWhere || '') && r.good?.b === 2, JSON.stringify(r));
      check('importFile disk write failure: returns null, no save:imported for it', r.slot === null && !r.imported.includes('s1-imp'), JSON.stringify(r));
      check('import without savedAt: records 0, not NaN', r.impOk === true && r.stamp === 0, JSON.stringify(r));
    },
  },
  {
    name: 'S1 saves: per-part versions: old part upgraded through migrate, a newer part refuses the whole load with a clear message, bad register throws (city)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves; let got = null, other = null;
        const firstVer = S.define('s1ver', { save: () => ({ n: 1 }), load: d => { got = d; } });
        S.define('s1other', { save: () => ({ o: 1 }), load: d => { other = d; } });
        await S.save('s1-v1');
        const savedVersions = JSON.parse(JSON.stringify(S.collect().versions));
        // the format changed: version 2 renames n -> count
        firstVer.remove();
        S.define('s1ver', { version: 2, migrate: { 1: d => ({ count: d.n }) }, save: () => ({ count: 1 }), load: d => { got = d; } });
        const upOk = await S.load('s1-v1'), upgraded = got;
        // a save written by a newer build (version 9) is refused before any part loads
        got = null; other = null;
        const { value: newOk, warns: errs } = await __t.warns(async () => {
          await S.import(btoa(JSON.stringify({ savedAt: 1, versions: { s1ver: 9 }, parts: { s1ver: { x: 1 }, s1other: { o: 2 } } })), 's1-new');
          return S.load('s1-new');
        });
        let badReg = ''; try { S.define('s1bad', { version: 0, save: () => 1, load: () => {} }); } catch (e) { badReg = e.message; }
        let badMig = ''; try { S.define('s1bad', { version: 2, migrate: { 2: d => d }, save: () => 1, load: () => {} }); } catch (e) { badMig = e.message; }
        return { savedVersions, upOk, upgraded, newOk, got, other, errs, badReg, badMig };
      });
      check('collect writes each part version (default 1)', r.savedVersions.s1ver === 1 && r.savedVersions.s1other === 1, JSON.stringify(r.savedVersions));
      check('a version-1 part is upgraded by migrate[1] before load sees it', r.upOk === true && r.upgraded?.count === 1 && !('n' in r.upgraded), JSON.stringify(r));
      check('a part newer than this build: load returns false, no part loaded, message names the part and versions',
        r.newOk === false && r.got === null && r.other === null && r.errs.some(e => /s1ver/.test(e) && /9/.test(e) && /newer/.test(e)), JSON.stringify(r));
      check('register checks version and migrate keys', /version must be a whole number/.test(r.badReg) && /migrate/.test(r.badMig), r.badReg + ' | ' + r.badMig);
    },
  },
  {
    name: 'S1 saves: register gives a handle: remove twice is safe, an old handle leaves a newer part alone, ctx.track ends it with the module',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, part = v => ({ save: () => v, load: () => {} });
        const old = S.define('s1h', part('old'));
        old.remove();
        const mine = S.define('s1h', part('new'));
        old.remove();
        const kept = S.providers.has('s1h');
        mine.remove(); mine.remove();
        const gone = !S.providers.has('s1h');
        engine.use({ name: 's1hMod', type: 'rules', install(e, ctx) { ctx.track(e.saves.define('s1hTracked', part(1))); } });
        await engine.loading.settled();
        const held = S.providers.has('s1hTracked');
        engine.unuse('s1hMod');
        return { kept, gone, held, after: S.providers.has('s1hTracked') };
      });
      check('an old handle removes nothing of the part that has the key now', r.kept, JSON.stringify(r));
      check('remove ends the part, and a second remove is safe', r.gone, JSON.stringify(r));
      check('ctx.track ends a raw saves.define with the module', r.held && !r.after, JSON.stringify(r));
    },
  },
];
