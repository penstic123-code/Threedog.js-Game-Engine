// engine.catalog() (core/inspect/catalog.js), params schemas (core/base/params.js) and the bridge `threedog catalog` (tools/threedog/catalog.mjs).
// Same format as the other files here.
export const specs = [
  {
    name: '[guard] catalog post and shadows: a capability row reads the live chain and switch, in the short list too',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const h = engine.post.add({ name: 'catDim', slot: 'ldr', fuse: { glsl: 'color.rgb *= uAmount;', uniforms: { uAmount: 0.5 } }, params: { amount: 0.5 } });
        const post = engine.catalog('post'), shadows = engine.catalog('shadows'), ids = engine.catalog().map(s => s.id);
        h.enabled = false; const paused = engine.catalog('post').facts.effects.find(x => x.name === 'catDim')?.enabled; h.enabled = true;
        const was = engine.shadows.enabled; engine.shadows.enabled = !was; const flipped = engine.catalog('shadows').facts.enabled; engine.shadows.enabled = was;
        h.remove();
        return { post, shadows, ids, was, flipped, paused, gone: engine.catalog('post').facts.effects.some(x => x.name === 'catDim'), json: JSON.stringify(post).length > 0 };
      });
      const dim = r.post.facts?.effects.find(x => x.name === 'catDim');
      check('catalog(post) lists the effect with slot, switch and params; removed, it is gone', dim?.slot === 'ldr' && dim.enabled === true && r.paused === false && dim.params.amount === 0.5 && !r.gone, JSON.stringify([r.paused, r.post.facts]));
      check('catalog(post) names the entries', ['add', 'get', 'own'].every(n => r.post.queries.api.includes(n)), JSON.stringify(r.post.queries));
      check('catalog(shadows) reads the live switch and names the entries', r.flipped === !r.was && ['box', 'budget', 'cascades'].every(n => r.shadows.queries.api.includes(n)), JSON.stringify(r.shadows));
      check('both are rows of the short list', r.ids.includes('post') && r.ids.includes('shadows'), JSON.stringify(r.ids));
    },
  },
  {
    name: '[guard] debug override of a three.js value: held above picture code, listed, undone by remove and clear, a wrong type refused',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const R = engine.renderer, S = engine.scene, out = {}, fog = S.fog, base = R.toneMappingExposure;
        const code = engine.onRender(() => { R.toneMappingExposure = 0.5; });   // the game's picture code, writing every frame
        engine.step(1 / 30, { render: true });
        const h = engine.debug.override('t-three', R, 'toneMappingExposure', 3);
        const f = engine.debug.override('t-three', S, 'fog', null);
        engine.step(1 / 30, { render: true }); out.held = R.toneMappingExposure; out.noFog = S.fog === null;
        out.listed = engine.describe('scene').scene.overrides;
        out.json = JSON.stringify(out.listed).length > 0;
        h.remove(); engine.step(1 / 30, { render: true }); out.back = R.toneMappingExposure;
        out.fogStill = S.fog === null;
        out.cleared = engine.debug.clear('t-three'); out.fogBack = S.fog === fog;
        const err = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
        out.bad = [err(() => engine.debug.override('t-three', engine.lights.sun, 'color', 0xff0000)), err(() => engine.debug.override('t-three', R, 'noSuchKey', 1)),
          err(() => engine.debug.override('t-three', 'nope', 'visible', false)), err(() => engine.debug.override('t-three', R, 'toneMappingExposure'))];
        out.left = engine.describe('scene').scene.overrides;
        code.remove(); R.toneMappingExposure = base;
        return out;
      });
      check('the override beats picture code writing the same value in onRender', r.held === 3 && r.noFog, JSON.stringify(r));
      check('describe().scene.overrides lists owner, target, key, value as plain data', r.listed.some(o => o.owner === 't-three' && o.key === 'toneMappingExposure' && o.value === 3) && r.listed.some(o => o.key === 'fog' && o.value === null), JSON.stringify(r.listed));
      check('remove() stops it and the writer it covered is back; the other override stays', r.back === 0.5 && r.fogStill, JSON.stringify(r));
      check('clear(owner) restores the rest', r.cleared === 1 && r.fogBack, JSON.stringify(r));
      check('a Color given a number, a key the object lacks, a non-object and a missing value are refused with nothing added', /THREE\.Color/.test(r.bad[0]) && /noSuchKey/.test(r.bad[1]) && /three\.js object/.test(r.bad[2]) && /give the value/.test(r.bad[3]) && !r.left?.some?.(o => o.owner === 't-three'), JSON.stringify(r.bad));
    },
  },
  {
    name: 'catalog: modules, ownership of ops / saves / describe, params, time model, op detail, find',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const PARAMS = { power: { type: 'number', default: 2, min: 0, desc: 'push strength' }, mode: { type: 'string', default: 'soft', values: ['soft', 'hard'] } };
        let seen = null;
        const mod = {
          name: 'catTest', type: 'rules', label: 'Catalog test', stage: 'gameplay', optional: { sky: 'no dusk bonus' }, params: PARAMS, options: { power: 3 },
          install(e) {
            e.ops.define('catTest.poke', { desc: 'poke it', args: { n: { type: 'int', default: 1, min: 1, max: 5 }, who: 'string?' },
              can: (e2, a) => a.n < 5 ? true : 'tooMany', run: (e2, a) => { seen = a.n; return a.n; }, reasons: { tooMany: 'At most 4' } });
            e.saves.define('catTestState', { version: 2, migrate: { 1: d => d }, save: () => ({}), load: () => {} });
            return { push() {}, _hidden: 1 };
          },
          init(e) { e.describe.add('catTestInfo', () => ({ ok: true })); },
          fixed() {},
        };
        engine.use(mod);
        await engine.loading.settled();
        const list = engine.catalog(), entry = engine.catalog('catTest');
        const ran = engine.ops.run('catTest.poke', {}, { source: 'test' });
        const fail = engine.ops.run('catTest.poke', { n: 5 }, { source: 'test' });
        let range = null;
        try { engine.ops.run('catTest.poke', { n: 9 }, { source: 'test' }); } catch (err) { range = err.message; }
        const op = engine.catalog('catTest.poke');
        // live, not a copy: an op removed from engine.ops is gone from the catalog at once
        const h = engine.ops.define('catTest.temp', { run: () => 1 });
        const withTemp = engine.catalog('catTest').ops.map(o => o.name);
        h.remove();
        const without = engine.catalog('catTest').ops.map(o => o.name);
        // nothing registered escapes the catalog: every op and save part sits in exactly one entry
        const all = engine.catalog(), opsIn = all.flatMap(s => s.ops), savesIn = all.flatMap(s => s.saves);
        const opsOk = opsIn.length === engine.ops.defs.size && [...engine.ops.defs.keys()].every(k => opsIn.includes(k));
        const savesOk = savesIn.length === engine.saves.providers.size && [...engine.saves.providers.keys()].every(k => savesIn.includes(k));
        const found = engine.catalog({ find: 'poke' }).map(s => s.id);
        const core = engine.catalog('core');
        return { ids: list.map(s => s.id), order: engine.moduleOrder, entry, seen, ran, fail, range, op, withTemp, without, opsOk, savesOk, found,
          coreOps: core.ops.map(o => o.name), coreSaves: core.saves.map(p => p.key), unknown: engine.catalog('noSuchThing'), json: JSON.stringify(all).length > 0 };
      });
      const e = r.entry;
      check('catalog() lists every installed module (+ core)', r.order.every(n => r.ids.includes(n)) && r.ids.includes('core'), JSON.stringify(r.ids));
      check('Module entry: stage, state, optional with what is lost, label', e.stage === 'gameplay' && e.state === 'running' && e.label === 'Catalog test'
        && e.optional[0]?.name === 'sky' && e.optional[0].lost === 'no dusk bonus', JSON.stringify(e));
      check('Ops / save parts / describe names registered in install and init belong to the module', e.ops.map(o => o.name).join() === 'catTest.poke'
        && e.saves[0]?.key === 'catTestState' && e.saves[0].version === 2 && e.queries.extra.join() === 'describe().catTestInfo', JSON.stringify(e));
      check('Op args schema with default and range, failure codes from reasons', e.ops[0].args.n.default === 1 && e.ops[0].args.n.max === 5
        && e.ops[0].args.who.optional && e.ops[0].failures.join() === 'tooMany', JSON.stringify(e.ops[0]));
      check('Params: schema, default and the value in use', e.params.power.default === 2 && e.params.power.value === 3 && e.params.mode.values.length === 2, JSON.stringify(e.params));
      check('Time model and problems: fixed hook without a skip kind is flagged', e.time.step === 'fixed' && !e.time.skip && e.problems.some(p => p.includes('no skipKind')), JSON.stringify(e.time));
      check('api names skip _private', e.queries.api.includes('push') && !e.queries.api.includes('_hidden'), JSON.stringify(e.queries.api));
      check('Default is filled in before can / run', r.ran.ok && r.seen === 1 && !r.fail.ok && r.fail.code === 'tooMany', JSON.stringify([r.ran, r.fail, r.seen]));
      check('Out-of-range arg throws in dev naming the limit', /n must be <= 5/.test(r.range ?? ''), r.range);
      check('Op detail: owner, reasons, last attempt', r.op.kind === 'op' && r.op.owner === 'catTest' && r.op.reasons.tooMany === 'At most 4' && r.op.last?.ok === false, JSON.stringify(r.op));
      check('Live view: a removed op leaves the catalog', r.withTemp.includes('catTest.temp') && !r.without.includes('catTest.temp'), JSON.stringify([r.withTemp, r.without]));
      check('No bypass: every op and save part is in exactly one catalog entry', r.opsOk && r.savesOk);
      check('Core entry has engine-owned ops and saves; find filters; unknown id is null', r.coreOps.includes('time.skip') && r.coreSaves.includes('time')
        && r.found.join() === 'catTest' && r.unknown === null, JSON.stringify([r.coreOps, r.coreSaves, r.found]));
    },
  },
  {
    name: 'catalog: readParams checks and fills options (the bridge text is tested in packages/tools/tests/catalog.mjs)',
    url: '/tests/city/index.html',   // the checks run in the test process; the page is only what the runner needs
    async run({ check }) {
      const { readParams } = await import('../../index.js');
      const S = { radius: { type: 'number', default: 2, min: 0 }, sound: 'string?' };
      const o = readParams('magnet', S, { sound: 'ding' });
      const err = fn => { try { fn(); return null; } catch (x) { return x.message; } };
      check('Defaults filled, given values kept', o.radius === 2 && o.sound === 'ding', JSON.stringify(o));
      // this test runs in Node, where DEV is off (a release build): an unknown option warns once and is ignored; in dev (browser pages) it throws the same text
      const warns = []; const w0 = console.warn; console.warn = m => warns.push(String(m));
      let got; try { got = readParams('magnet', S, { radios: 3 }); } finally { console.warn = w0; }
      check('Unknown option (release): warns once with did-you-mean and the code, no throw', got.radius === 2 && warns.length === 1 && /radios.*did you mean `radius`.*\[module-params\]/.test(warns[0]), JSON.stringify(warns));
      check('Below min throws naming the limit', /radius must be >= 0/.test(err(() => readParams('magnet', S, { radius: -1 })) ?? ''));
      check('Bad schema field is caught when read', /did you mean default/.test(err(() => readParams('magnet', { a: { type: 'int', defualt: 1 } }, {})) ?? ''));
    },
  },
];
