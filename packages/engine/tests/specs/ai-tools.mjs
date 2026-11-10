// Stage 2 item 4 (AI tools): describe snapshots instead of screenshots (tools/describe-snapshot.mjs) and errors that carry the likely cause + the doc page to read (core/base/errorHints.js).
// Baselines live in packages/engine/tests/snapshots/*.describe.json; after an intended change update them with `threedog test "describe snapshot" --update-snapshots`.
import { expectDescribe } from '@threedog/tools/describe-snapshot';

export const specs = [
  {
    // [guard] ev(fn, a, b): b vanished without a word and the function ran on undefined
    name: '[guard] test runner: a second argument to ev fails, naming the way to pass both',
    url: '/tests/threads/',
    async run({ check, ev }) {
      let msg = '';
      try { await ev((a, b) => [a, b], 1, 2); } catch (e) { msg = e.message; }
      check('ev(fn, a, b) throws', /takes one argument/.test(msg), msg);
      check('ev(fn, arg) still works', await ev(a => a + 1, 1) === 2);
    },
  },
  {
    name: 'describe snapshot: small town after loading, fields player / camera / ui / modules (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      await ev(() => { engine.haltLoop(); engine.step(0.5); });
      await expectDescribe({ check, ev }, 'city-start', { only: ['player.ground', 'player.state', 'player.inWater', 'camera.type', 'ui', 'modules'], tolerance: 1 });
    },
  },
  {
    name: 'describe snapshot: open world with the opening cutscene skipped, noon (open world)',
    url: '/?cutscene=skip&time=12:00&weather=clear',
    async run({ check, ev }) {
      await ev(() => { engine.haltLoop(); engine.step(0.5); });
      await expectDescribe({ check, ev }, 'world-noon', { only: ['player.ground', 'player.state', 'player.inWater', 'weather.name', 'ui', 'cutscene'], tolerance: 1 });
    },
  },
  {
    name: 'describe snapshot: state registered with describe.add is part of the baseline (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      await ev(() => { engine.haltLoop(); engine.describe.add('snapDemo', () => ({ score: 3, targets: [{ name: 'crate', hp: 10 }, { name: 'barrel', hp: 5 }] })); engine.step(0.1); });
      await expectDescribe({ check, ev }, 'city-custom-state', { only: ['snapDemo'] });
    },
  },
  {
    name: 'errors carry a cause and a doc page: engine.error, describeText and warnOnce (small town)',
    url: '/tests/city/index.html',
    expectErrors: /plain values/,   // a gameplay error provoked on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const { warns } = await __t.warns(() => { engine.input.pressed('jupm'); engine.input.pressed('jupm'); });
        engine.events.on('hint:test', () => { throw new Error('world data must be plain values (number, string, boolean, array, plain object): x is a function [world-plain]'); });   // as the engine writes it: tagged
        engine.events.emit('hint:test');
        return { warns, error: engine.error, text: engine.describeText().split('\n')[0] };
      });
      check('warnOnce: the warning ends with "Possible cause" and a Read line, and repeats are not printed again', r.warns.length === 1 && /Possible cause: .*\n\s+Read: .*api\//.test(r.warns[0]), JSON.stringify(r.warns));
      check('engine.error has a code, the fix and docs (recipes/18-world.md)', r.error?.code === 'world-plain' && /JSON-like/.test(r.error?.fix ?? '') && r.error.docs.some(d => d.startsWith('recipes/18-world.md')), JSON.stringify(r.error));
      check('engine.error.at: the first stack line, also on the describeText error line', /^at |@\S+:\d+/.test(r.error?.at ?? '') && r.text.includes(`(${r.error.at})`), JSON.stringify(r.error?.at));
      // 为什么：一次试玩里 world.present 只调 modelNow 拿代码生成的模型，一直是 null 也没有说明
      const m = await ev(async () => {
        engine.assets.manifest({ name: 'mn', models: { mnBox: { build: () => new __threedogThree.Mesh(new __threedogThree.BoxGeometry(1, 1, 1)) } } });
        const first = await __t.warns(() => engine.assets.modelNow('mnBox'));
        await engine.assets.model('mnBox');
        const later = await __t.warns(() => engine.assets.modelNow('mnBox'));
        return { warns: first.warns, after: !!engine.assets.modelNow('mnBox'), later: later.warns.length };
      });
      check('modelNow of a code-built model nothing loaded: null plus one dev hint naming assets.model() [asset-not-loaded]', m.warns.length === 1 && /asset-not-loaded/.test(m.warns[0]) && /await engine\.assets\.model\('mnBox'\)/.test(m.warns[0]), JSON.stringify(m.warns));
      check('modelNow after model() resolved: the copy, no hint', m.after && m.later === 0, JSON.stringify(m));
      check('describeText: the error line shows the code, the fix and the pages to read', /Code: world-plain \| Fix: .*Read: recipes\/18-world\.md/.test(r.text), r.text);
    },
  },
];
