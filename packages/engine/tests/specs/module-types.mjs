// [guard] Module types warn and capabilities hold (core/engine/moduleTypes.js, core/engine/modules.js, docs/plans/done/2026-11-03-ownership-design.md section 6).
// Why a guard: before types, "who may own what" lived only in the docs, so an AI's picture module defined ops and a ui module bound its own keys,
// and a module that depended on 'inventory' broke when a game swapped the bag. One page (perf world: openWorld with world, sky, weather), six rules:
//   1. a module without a type is 'rules'; an unknown one (a typo) is refused with the list
//   2. a picture module defining an op or writing a world record, a ui module binding keys or registering a save part: warned once with rule + fix, and it
//      goes through (a game's own module may need it); the same calls from a rules module say nothing; describe().modules lists name, type, provides, requires
//   3. requires names a capability; a missing one names both fixes (the engine's part, or your own provides)
//   4. replaces of a capability keeps its dependents working: engine.<capability> is the new provider's API
//   5. weather is two modules (state + drawing) from one weather() call: a save made mid-transition loads mid-transition, and removing the drawing
//      half leaves the state (and its save) alone
//   6. (static, node) core / render / ui name no module: packages/tools/tests/module-boundaries.mjs runs R27 and R47
// Same format as the other files here.

export const specs = [
  {
    name: '[guard] module types: default type, picture / ui warnings, requires by capability with both fixes, replaces keeps dependents, weather state + drawing save mid-transition',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.loading.settled();
        engine.haltLoop();
        const out = {}, err = f => { try { f(); return null; } catch (e) { return e; } };
        // 1. no type is game logic
        const said = [], warn = console.warn; console.warn = (...a) => { said.push(a.join(' ')); warn(...a); };
        const noType = err(() => engine.use({ name: 'mtNoType', install() {} }));
        const badType = err(() => engine.use({ name: 'mtBadType', type: 'logic', install() {} }));
        out.noType = { err: noType?.message, type: engine.modules.get('mtNoType')?.type };
        engine._unuse('mtNoType');
        out.badType = { code: badType?.code, msg: badType?.message };
        // 2. per-type rules: a warning at the write, with the rule and the fix; the write goes through
        const pictureOp = err(() => engine.use({ name: 'mtPictureOp', type: 'picture', install(e) { e.ops.define('mt.buy', { run() {} }); } }));
        const pictureWorld = err(() => engine.use({ name: 'mtPictureWorld', type: 'picture', install(e) { e.world.add({ kind: 'mtThing', position: { x: 0, y: 0, z: 0 } }); } }));
        const uiKeys = err(() => engine.use({ name: 'mtUiKeys', type: 'ui', install(e, ctx) { ctx.input.define('mtOpen'); ctx.input.bind('mtOpen', ['KeyM']); } }));
        const uiSave = err(() => engine.use({ name: 'mtUiSave', type: 'ui', install(e) { e.saves.define('mtPanel', { save: () => 1, load() {} }); } }));
        // a hook going against the rule later is seen too (the frame hook runs as the module)
        let hooked = false;
        engine.use({ name: 'mtPictureLater', type: 'picture', frame(dt, e) { if (!hooked) { hooked = true; e.ops.define('mt.later', { run() {} }); } } });
        engine._unhalt(); await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))); engine.haltLoop();
        engine._unuse('mtPictureLater');
        console.warn = warn;
        out.thrown = [pictureOp, pictureWorld, uiKeys, uiSave].map(e => e?.message ?? null);
        out.said = said.filter(s => s.includes('[module-type-rule]'));
        out.wentThrough = engine.has('mtPictureOp') && engine.ops.defs.has('mt.buy') && engine.has('mtUiKeys') && engine.saves.providers.has('mtPanel');
        const fine = err(() => engine.use({ name: 'mtRules', type: 'rules', install(e) { e.ops.define('mt.ok', { run: () => 1 }); e.saves.define('mtRules', { save: () => 1, load() {} }); } }));
        out.rulesFine = !fine && engine.ops.defs.has('mt.ok');
        // 3. requires names a capability: both fixes
        const need = err(() => engine.use({ name: 'mtNeedy', type: 'rules', requires: ['scoreboard'], install() {} }));
        out.need = { code: need?.code, msg: need?.message };
        // 4. replaces of a capability: the dependent keeps working through engine.scoreboard
        const board = (name, tag) => ({ name, type: 'rules', provides: ['scoreboard'], install: () => ({ tag, points: 0, add(n) { this.points += n; return tag; } }) });
        engine.use(board('mtBoardA', 'A'), { name: 'mtShop', type: 'rules', requires: ['scoreboard'], install: e => ({ buy: () => e.scoreboard.add(1) }) });
        out.before = engine.mtShop.buy();
        engine.use(board('mtBoardB', 'B'), { replaces: 'scoreboard' });
        out.after = { tag: engine.mtShop.buy(), holder: engine.stacks.get('scoreboard').value(), aGone: !engine.has('mtBoardA'), alias: engine.scoreboard?.tag };
        out.row = engine.describe().modules.find(m => m.name === 'mtBoardB');
        out.shopRow = engine.describe().modules.find(m => m.name === 'mtShop');
        out.builtinRows = ['weather', 'weatherDraw', 'sky', 'world'].map(n => engine.describe().modules.find(m => m.name === n));
        // 5. weather: state + drawing; a save mid-transition restores mid-transition, the picture follows the state
        const W = engine.weather, names = Object.keys(W.types);
        const dry = names.find(k => !W.types[k].rain && !W.types[k].cloud) ?? names[0], wet = names.find(k => W.types[k].rain > 0) ?? names.find(k => k !== dry);
        W.auto = false; W.set(dry, { seconds: 0.01 }); engine.step(0.2);
        W.set(wet, { seconds: 20 }); engine.step(5);
        const mid = { t: W.t, rain: W.current.rain, name: W.name };
        const data = engine.saves.collect();
        W.set(dry, { seconds: 0.01 }); engine.step(0.5);
        const changes = []; const off = engine.events.on('weather:change', d => changes.push(d));
        await engine.saves.apply(data);
        off.remove();
        engine.step(0.05);
        out.weather = { wet, mid, back: { t: W.t, rain: W.current.rain, name: W.name }, changes: changes.length,
          lookReads: Math.abs(engine.uniforms.uWeatherCloud.value - W.current.cloud) < 1e-9, split: engine.modules.get('weather').type + '+' + engine.modules.get('weatherDraw').type };
        engine._unuse('weatherDraw'); engine.step(0.05);
        out.stateStays = engine.has('weather') && !engine.has('weatherDraw') && engine.saves.providers.has('weather');
        engine._unhalt();
        return out;
      });
      check('1. no type: installs as rules', !r.noType.err && r.noType.type === 'rules', JSON.stringify(r.noType));
      check('1. unknown type: lists the types', r.badType.code === 'module-type' && /'world' \| 'picture'/.test(r.badType.msg), JSON.stringify(r.badType));
      const said = re => r.said.some(x => re.test(x));
      check('2. nothing is refused: every write went through', r.thrown.every(x => x === null) && r.wentThrough, JSON.stringify(r.thrown));
      check('2. picture module defining an op: warned with rule + fix', said(/mtPictureOp \(type 'picture'\) defined op mt\.buy.*Fix: define the op in a rules/s), JSON.stringify(r.said));
      check('2. picture module writing a world record: warned', said(/world records are game state.*ops\.run/s), JSON.stringify(r.said));
      check('2. ui module binding keys: warned', said(/bound keys.*engine\.input\.bind/s), JSON.stringify(r.said));
      check('2. ui module registering a save part: warned', said(/defined save part 'mtPanel'/), JSON.stringify(r.said));
      check('2. a picture module doing it in its frame hook is seen too', said(/mtPictureLater/), JSON.stringify(r.said));
      check('2. the same writes from a rules module are fine', r.rulesFine);
      check('3. missing capability: names both fixes (the engine part, or your own provides)', r.need.code === 'module-requires'
        && /engine\.use\(scoreboard\(\), mtNeedy/.test(r.need.msg) && /provides: \['scoreboard'\]/.test(r.need.msg), JSON.stringify(r.need));
      check('4. replaces keeps the dependent working: engine.scoreboard is the new provider', r.before === 'A' && r.after.tag === 'B' && r.after.alias === 'B'
        && r.after.holder === 'mtBoardB' && r.after.aGone, JSON.stringify(r.after));
      check('2. describe().modules lists name, type, provides, requires', r.row?.type === 'rules' && r.row.provides?.[0] === 'scoreboard' && r.shopRow?.requires?.[0] === 'scoreboard'
        && r.builtinRows.every(x => x?.type), JSON.stringify([r.row, r.shopRow, r.builtinRows]));
      check('5. weather() is a world state and a picture module', r.weather.split === 'world+picture', r.weather.split);
      check('5. a save made mid-transition loads mid-transition (no weather:change), the picture reads the state', r.weather.mid.t > 0.05 && r.weather.mid.t < 1
        && Math.abs(r.weather.back.t - r.weather.mid.t) < 0.02 && r.weather.back.name === r.weather.wet && r.weather.changes === 0 && r.weather.lookReads, JSON.stringify(r.weather));
      check('5. removing the drawing half leaves the weather state and its save part', r.stateStays);
    },
  },
  {
    name: '[guard] module types: a picture or ui module that throws in its frame hook is switched off and the game keeps running; a rules module freezes gameplay',
    url: '/tests/threads/',
    expectErrors: /mt-(picture|ui|rules)-boom/,   // the three modules throw on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        const quiet = console.error; console.error = () => {};
        const run = async (id, type) => {
          const E = threedogThreads.createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: id });
          let calls = 0;
          const lent = { mine: 'game', taken: 'game' };
          // no extra flag: the type alone decides how an error is handled
          E.use({ name: id, type, install(_e, ctx) { ctx.borrow(lent, { mine: 'mod', taken: 'mod' }); },
            frame() { calls++; lent.taken = 'game again'; throw new Error(`${id}-boom`); } });
          await E.start(); E.haltLoop();
          E.step(0.1);
          const t0 = E.clock.now; E.step(0.5);
          const out = { disabled: E.moduleStates[id] === 'disabled', calls, error: E.error?.message ?? null, frozen: E.frozen, clockMoved: E.clock.now > t0, lent: { ...lent } };
          E.dispose();
          return out;
        };
        const out = { picture: await run('mt-picture', 'picture'), ui: await run('mt-ui', 'ui'), rules: await run('mt-rules', 'rules') };
        console.error = quiet;
        return out;
      });
      for (const k of ['picture', 'ui']) {
        const x = r[k];
        check(`${k} module throwing in frame: switched off after one call, no engine.error, not frozen, game time runs`, x.disabled && x.calls === 1 && !x.error && !x.frozen && x.clockMoved, JSON.stringify(x));
        check(`${k} module switched off: what it borrowed is back, and a value someone else took meanwhile stands`, x.lent.mine === 'game' && x.lent.taken === 'game again', JSON.stringify(x.lent));
      }
      check('rules module throwing in frame: gameplay frozen and recorded in engine.error, its borrow kept', r.rules.frozen && /mt-rules-boom/.test(r.rules.error ?? '') && !r.rules.disabled && !r.rules.clockMoved && r.rules.lent.mine === 'mod', JSON.stringify(r.rules));
    },
  },
];
