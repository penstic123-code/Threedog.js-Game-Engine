// Group HC5 (docs/plans/research/2026-11-10-health-check-a.md): persistence failures that nobody was told about. One test item per fix, so
// reverting one fix turns only its own item red. Storage failures are stubbed (Storage.prototype.setItem, the store's getSlot / putSlot).
const SETTINGS = '/tests/settings/index.html';
const HEADLESS = '/?threedog-headless';

export const specs = [
  {
    name: '[guard] group HC5 a: a settings write that fails keeps the value, still emits settings:change and says once that it will not survive a reload',
    url: SETTINGS,
    async run({ check, ev }) {
      const r = await ev(() => {
        const S = engine.settings, warns = [], w0 = console.warn, set0 = Storage.prototype.setItem, out = {};
        console.warn = (...a) => warns.push(String(a[0]));
        let changes = 0; engine.events.on('settings:change', () => changes++);
        Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };
        try { S.set('vol.music', 0.37); } finally { Storage.prototype.setItem = set0; }
        out.value = S.get('vol.music'); out.changes = changes; out.warn = warns.some(m => /will not survive a reload/.test(m));
        S.reset();
        console.warn = w0;
        return out;
      });
      check('value applied, change emitted, one warning', r.value === 0.37 && r.changes >= 1 && r.warn, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC5 a2: a corrupt stored settings entry is said once before it resets',
    url: SETTINGS,
    async run({ check, ev }) {
      const r = await ev(() => {
        const S = engine.settings, warns = [], w0 = console.warn;
        console.warn = (...a) => warns.push(String(a[0]));
        const was = localStorage.getItem(S.storageKey);
        localStorage.setItem(S.storageKey, '{not json');
        let d; try { d = S._read(); } finally { console.warn = w0; if (was == null) localStorage.removeItem(S.storageKey); else localStorage.setItem(S.storageKey, was); }
        return { empty: Object.keys(d).length === 0, warn: warns.some(m => /stored settings could not be read/.test(m)) };
      });
      check('defaults used and a warning said', r.empty && r.warn, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC5 b: a failed read after a failed write keeps the slot in memory instead of calling it "no save"',
    url: HEADLESS,
    expectErrors: /could not be read back/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const S = engine.saves, out = {};
        await S.save('hc5b'); await S.flush();
        out.before = S._json.has('hc5b');
        const put0 = S.store.putSlot, get0 = S.store.getSlot;
        S.store.putSlot = async () => { throw new Error('disk full'); };
        S.store.getSlot = async () => { throw new Error('read blocked'); };
        const w0 = console.warn; console.warn = () => {};
        try { out.ok = await S.save('hc5b'); await S.flush(); } finally { S.store.putSlot = put0; S.store.getSlot = get0; console.warn = w0; }
        out.kept = S._json.has('hc5b');
        return out;
      });
      check('the slot is still listed after the failed write and failed read', r.ok === false && r.before && r.kept, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC5 c: the localStorage fallback keeps the open error, and attachment writes reject with save-write instead of resolving',
    serial: true,   // swaps Node globals (fetch / console.warn / indexedDB / matchMedia): nothing may run beside it
    url: HEADLESS,
    async run({ check }) {
      const { SaveStore } = await import(new URL('../../core/saves/SaveStore.js', import.meta.url).href);   // Node-side: the store needs only an indexedDB that refuses
      const idb0 = globalThis.indexedDB;
      globalThis.indexedDB = { open: () => { throw new Error('SecurityError: blocked by policy'); } };
      const st = new SaveStore('hc5c', 'hc5c:');
      let open; try { open = await st.open(); } finally { globalThis.indexedDB = idb0; }
      const blob = new Blob(['x']), code = async f => { try { await f(); return 'resolved'; } catch (e) { return e.code; } };
      const r = {
        open, mode: st.mode, cause: /blocked by policy/.test(st.openError?.message ?? ''),
        put: await code(() => st.putBlobs([{ group: 'g', id: 'a', blob, meta: null, at: 1 }])),
        putIf: await code(() => st.putBlobIf({ group: 'g', id: 'a', blob, meta: null, at: 1 }, null)),
      };
      check('open error kept', r.open === false && r.mode === 'localStorage' && r.cause, JSON.stringify(r));
      check('attachment writes reject with save-write', r.put === 'save-write' && r.putIf === 'save-write', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC5 d: a missing bake manifest is silent, a malformed one or an HTTP/network failure is said once',
    serial: true,   // swaps Node globals (fetch / console.warn / indexedDB / matchMedia): nothing may run beside it
    url: HEADLESS,
    async run({ check }) {
      const { bakedIndex } = await import(new URL('../../core/assets/assetLoad.js', import.meta.url).href);
      const f0 = globalThis.fetch, w0 = console.warn;
      const run = async (reply) => {
        const warns = []; console.warn = (...a) => warns.push(String(a[0]));
        globalThis.fetch = async () => { const x = reply(); if (x instanceof Error) throw x; return x; };
        try { const idx = await bakedIndex({}); return { idx, warned: warns.length }; } finally { globalThis.fetch = f0; console.warn = w0; }
      };
      const res = (status, body) => ({ ok: status < 400, status, text: async () => body });
      const miss = await run(() => res(404, ''));
      check('404: empty and silent', Object.keys(miss.idx).length === 0 && miss.warned === 0, JSON.stringify(miss));
      const good = await run(() => res(200, '{"a":{"file":"a.glb"}}'));
      check('a good manifest is read, silent', good.idx.a?.file === 'a.glb' && good.warned === 0, JSON.stringify(good));
      const mal = await run(() => res(200, '{oops'));
      check('malformed: empty and said', Object.keys(mal.idx).length === 0 && mal.warned === 1, JSON.stringify(mal));
      const srv = await run(() => res(500, ''));
      check('HTTP 500: said', srv.warned === 1, JSON.stringify(srv));
      const net = await run(() => new Error('offline'));
      check('network failure: said', net.warned === 1, JSON.stringify(net));
    },
  },
  {
    name: '[guard] group HC5 e: a tier detection that throws is said once before it falls back to high',
    serial: true,   // swaps Node globals (fetch / console.warn / indexedDB / matchMedia): nothing may run beside it
    url: HEADLESS,
    async run({ check }) {
      const { tier } = await import(new URL('../../render/backend.js', import.meta.url).href);
      const mm0 = globalThis.matchMedia, w0 = console.warn, warns = [];
      console.warn = (...a) => warns.push(String(a[0]));
      let t;
      try { globalThis.matchMedia = () => { throw new Error('no media'); }; t = tier({ getContext: () => null }); } finally { globalThis.matchMedia = mm0; console.warn = w0; }
      check("falls back to 'high' and warns", t === 'high' && warns.some(m => /tier could not be detected/.test(m)), JSON.stringify([t, warns]));
    },
  },
  {
    name: '[guard] group HC5 f: photos that cannot be stored tell the player once per session, not once per photo',
    url: '/tests/pixel-size/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const P = engine.photo, ui = engine.ui.get('toast'), show0 = ui.show, w0 = console.warn;
        let toasts = 0; ui.show = () => { toasts++; };
        console.warn = () => {};
        try { for (let i = 0; i < 3; i++) P._fail(Object.assign(new Error('photo p' + i + ' not stored'), { code: 'save-write' })); } finally { ui.show = show0; console.warn = w0; }
        return { toasts };
      });
      check('three failed photos, one toast', r.toasts === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC5 g: a bake manifest whose top level is not an object (null, a number, an array) is said and read as empty',
    serial: true,   // swaps Node globals (fetch / console.warn / indexedDB / matchMedia): nothing may run beside it
    url: HEADLESS,
    async run({ check }) {
      const { bakedIndex } = await import(new URL('../../core/assets/assetLoad.js', import.meta.url).href);
      const f0 = globalThis.fetch, w0 = console.warn;
      for (const body of ['null', '5', '[1]']) {
        const warns = []; console.warn = (...a) => warns.push(String(a[0]));
        globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => body });
        let idx; try { idx = await bakedIndex({}); } finally { globalThis.fetch = f0; console.warn = w0; }
        check(`'${body}': empty object, one warning, a name lookup does not throw`, idx && typeof idx === 'object' && idx['x'] === undefined && warns.length === 1, JSON.stringify([idx, warns.length]));
      }
    },
  },
];
