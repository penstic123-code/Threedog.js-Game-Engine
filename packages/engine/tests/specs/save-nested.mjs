// A request awaited inside a save load without its turn waits for itself. It used to wait for good, in a release build with no word. Now the wait has the engine's one
// load limit: no sign of life for loading.timeoutMs and the job fails with save-nested, so the load fails its normal way. Run: threedog test "Save nested"
export const specs = [
  {
    name: '[guard] Save nested: a request awaited in a load without its turn fails with save-nested, the load rolls back and the next one works; a slow load with signs of life does not',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE, all: T } = window.threedogThreads, quiet = console.error, said = [];
        console.error = (...a) => said.push(a.join(' '));
        const E = mk(createEngine, 'save-nested-' + Math.random());
        E.use(T.world(), T.level());
        await E.start();
        E.loading.timeoutMs = 150;
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        let mode = null, n = 0, caught = null;
        E.saves.define('sn', { save: () => ({ n }), async load(d) {
          n = d.n;
          // once: the rollback loads this part again
          if (mode === 'nested') { mode = null; n = 99; try { await E.level.load(new THREE.Group()); } catch (err) { caught = err.code; throw err; } }
          if (mode === 'alive') { const t = E.loading._begin('sn', 'model'); for (let i = 0; i < 6; i++) { await sleep(70); t.phase('loading', i / 6); } E.loading._done(t); }
          if (mode === 'long') await sleep(350);
        } });
        const out = {};
        n = 1; const data = JSON.parse(JSON.stringify(E.saves.collect())); n = 2;
        mode = 'nested';
        out.nested = { ok: await E.saves.apply(data), caught, n, told: said.some(s => s.includes('save-nested') && s.includes('turn')), line: E.saves._replace.waiting.length, job: !!E.saves._replace.job };
        mode = null;
        out.after = { saved: await E.saves.save('sn-slot'), loaded: await E.saves.load('sn-slot'), n };
        // an outside request behind a slow load that shows life: 420 ms against a limit of 150
        mode = 'alive';
        const slow = E.saves.apply(data), outside = E.saves.settled().then(() => 'done', err => err.code);
        out.alive = { load: await slow, outside: await outside };
        // a job that left the line is no longer watched: its own long run is not a wait
        mode = null;
        const first = E.saves.apply(data);
        mode = 'long';
        const second = E.saves.apply(data).then(v => v, err => err.code);
        await first;
        out.left = await second;
        E.dispose(); console.error = quiet;
        return out;
      });
      const J = JSON.stringify;
      check('the await inside the load rejects with save-nested', r.nested.caught === 'save-nested', J(r.nested));
      check('the load fails its normal way and the state goes back', r.nested.ok === false && r.nested.n === 2, J(r.nested));
      check('the error names the fix', r.nested.told, J(r.nested));
      check('nothing stays in line or in the turn', r.nested.line === 0 && !r.nested.job, J(r.nested));
      check('a later save and load work', r.after.saved === true && r.after.loaded === true, J(r.after));
      check('a slow load that shows life holds the outside request, and it does not fail', r.alive.load === true && r.alive.outside === 'done', J(r.alive));
      check('a job that left the line is not failed for running long', r.left === true, J(r.left));
    },
  },
];
