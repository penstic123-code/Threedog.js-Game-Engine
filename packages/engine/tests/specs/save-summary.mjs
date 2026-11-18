// [guard] saves.list() carries the parts a game marked `summary: true`, read from the stored save text (not from live game state), migrated to the current shape,
// and re-read after each new save. Without it a start screen would keep a second copy of level / gold / play time. Run: threedog test "Save summary"
export const specs = [
  {
    name: '[guard] Save summary: list() rows hold the summary parts, from stored text, migrated, and fresh after the next save',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {}, name = 'save-summary-' + Math.random();
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        let gold = 5;
        const E = mk(createEngine, name);
        await E.start();
        E.saves.define('hero', { save: () => ({ gold }), load: d => { gold = d.gold; }, summary: true });
        E.saves.define('big', { save: () => ({ n: 1 }), load() {} });
        await E.saves.save('s1');
        out.first = E.saves.list().find(x => x.slot === 's1').summary;
        gold = 9; await E.saves.save('s1');                                    // data changed: the cached summary must go
        out.second = E.saves.list().find(x => x.slot === 's1').summary;
        await E.saves.flush?.();
        E.dispose();
        // a new engine of the same game: the summary comes from the stored text while the game's own state is still the default
        const F = mk(createEngine, name);
        await F.start();
        gold = -1;
        F.saves.define('hero', { save: () => ({ gold }), load() {}, summary: true });
        out.reopened = F.saves.list().find(x => x.slot === 's1')?.summary;
        // a version 1 save lists in the shape version 2 reads
        const old = { format: 1, savedAt: 1, versions: { vh: 1 }, parts: { vh: { gold: 7 } } };
        F.saves.define('vh', { version: 2, migrate: { 1: d => ({ ...d, coins: d.gold }) }, save: () => ({}), load() {}, summary: true });
        await F.saves.import(btoa(unescape(encodeURIComponent(JSON.stringify(old)))), 'old');
        out.migrated = F.saves.list().find(x => x.slot === 'old')?.summary;
        F.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('first list() carries the marked part only', JSON.stringify(r.first) === '{"hero":{"gold":5}}', JSON.stringify(r.first));
      check('a newer save replaces the cached summary', r.second?.hero?.gold === 9, JSON.stringify(r.second));
      check('a new engine lists the stored summary, not live state', r.reopened?.hero?.gold === 9, JSON.stringify(r.reopened));
      check('an old version lists migrated', r.migrated?.vh?.coins === 7, JSON.stringify(r.migrated));
    },
  },
];
