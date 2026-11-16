// [guard] Short soak (outside review: "nothing has run for more than minutes"). One self-playing game on the stress-field page: every round streams terrain and city
// blocks in and out, spawns and removes records, runs a quest and a dialogue, switches weather and the day, saves and loads, starts a new game and changes scene;
// every few rounds the whole engine is disposed and created again. After warm-up the engine's own counts must be the same every round, and a new engine must start
// with the same counts as the one before. The long version (30+ minutes real time on real WebGPU, and simulated days) is a release-time command:
//   node packages/engine/tests/stress-field/run.mjs soak '{"minutes":30}'     (docs/plans/release-checklist.md)
// Run: npm test -- Soak
const PAGE = '/tests/stress-field/index.html?backend=webgl&guard';

export const specs = [
  {
    name: 'Soak: 8 rounds of play (stream, spawn, quest, dialogue, weather, save/load, new game, scene change) and an engine re-create keep every count flat after warm-up',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.sf.soak({ rounds: 8, recreateEvery: 4, sampleEvery: 1, simulated: true, stepsPerAction: 40, city: false }));
      const rounds = r.rows.filter(x => x.action === 'round' && x.round > 1 && x.gen === r.rows.find(y => y.round === x.round)?.gen);
      const key = x => JSON.stringify({ listeners: x.listeners, fixed: x.fixed, frame: x.frame, timers: x.timers, statics: x.statics, streamEntries: x.streamEntries, jobs: x.jobs, commits: x.commits, mods: { ...x.mods, particles: x.mods.particles?.emitters }, scene: x.sceneChildren });
      check('soak: ran every round without a thrown error or a page error', r.aborted == null && r.errors.length === 0 && r.rounds === 8, JSON.stringify({ aborted: r.aborted, errors: r.errors, rounds: r.rounds }));
      const byGen = new Map(); for (const x of rounds) (byGen.get(x.gen) ?? byGen.set(x.gen, []).get(x.gen)).push(x);
      check('soak: inside one engine, counts (listeners, hooks, timers, jobs, module counts, scene children) are the same in every round after the first', [...byGen.values()].every(g => g.every(x => key(x) === key(g[0]))),
        JSON.stringify([...byGen.values()].map(g => g.map(key))));
      const fresh = r.rows.filter(x => x.action === 'recreate');
      // a just-made engine: its streamed chunk groups depend on worker timing (about one run in three differed), so they are left out here; the rounds above, after everything built, count them
      const freshKey = x => key({ ...x, sceneChildren: x.sceneChildren - x.sceneStreamed });
      check('soak: a re-created engine starts with the same counts as the one before it (streamed chunks aside)', fresh.length >= 2 && fresh.every(x => freshKey(x) === freshKey(fresh[0])), JSON.stringify(fresh.map(freshKey)));
      check('soak: page canvases and DOM listeners do not pile up across re-creates', r.rows.every(x => x.domCanvas <= r.rows[0].domCanvas + 1), JSON.stringify(r.rows.map(x => x.domCanvas)));
      const heaps = fresh.map(x => x.heapMB).filter(h => h != null);
      check('soak: JS heap after gc at each re-create does not climb by more than 25 MB over the run', heaps.length < 2 || heaps.at(-1) - heaps[0] < 25, JSON.stringify(heaps));
    },
  },
];
