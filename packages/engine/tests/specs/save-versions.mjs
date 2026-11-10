// [guard] The versions of a save decide which migrate steps run, so the container, every value and every migrate key are whole positive numbers, or nothing loads.
// Run: threedog test "Save versions"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Save versions: a bad versions container or value is refused before any provider loads; a migrate key must be a whole version',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = { apply: {} };
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const E = mk(createEngine, 'sv-versions');
        await E.start();
        const loaded = [];
        E.saves.define('svA', { version: 2, migrate: { 1: d => ({ ...d, up: true }) }, save: () => ({}), load: d => { loaded.push(d); } });
        const bad = { word: { svA: 'oops' }, object: { svA: {} }, zero: { svA: 0 }, half: { svA: 1.5 }, neg: { svA: -1 }, nul: { svA: null }, foreign: { svGone: 'oops' }, list: [1], text: 'oops', number: 3, none: null };
        for (const [k, versions] of Object.entries(bad)) out.apply[k] = await E.saves.apply({ format: 1, versions, parts: { svA: { n: 1 }, svGone: { n: 2 } } }, 'sv');
        out.refusedLoads = loaded.length;
        out.good = await E.saves.apply({ format: 1, versions: { svA: 1 }, parts: { svA: { n: 1 } } }, 'sv');
        out.bare = await E.saves.apply({ format: 1, parts: { svA: { n: 1 } } }, 'sv');
        out.loaded = loaded;
        out.keys = {};
        for (const m of ['1.5', '1e0', ' 1', '01', '0', '3', '-1', 'x']) {
          try { E.saves.define('svK', { version: 3, migrate: { [m]: d => d }, save: () => ({}), load() {} }); out.keys[m] = 'accepted'; } catch (err) { out.keys[m] = err.code; }
        }
        try { out.ok = !!E.saves.define('svOk', { version: 3, migrate: { 1: d => d, 2: d => d }, save: () => ({}), load() {} }); } catch (err) { out.ok = err.message; }
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('every bad container and value is refused', Object.values(r.apply).every(ok => ok === false), J(r.apply));
      check('no provider loaded on a refused save', r.refusedLoads === 0, J(r.loaded));
      check('a good save loads through its migrate step, and a save with no versions is all version 1', r.good === true && r.bare === true && r.loaded.length === 2 && r.loaded[0].up === true, J(r));
      check('a migrate key that is no whole version below the current one is refused at register', Object.values(r.keys).every(c => c === 'save-version'), J(r.keys));
      check('whole keys below the version are fine', r.ok === true, J(r.ok));
    },
  },
];
