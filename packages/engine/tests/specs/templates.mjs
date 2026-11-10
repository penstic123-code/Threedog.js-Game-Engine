// Content templates (recipes/30-templates.md) and definition vs instance state. Same style as the other files here.
// Guard: two chests from one template share the model resource, but opened state and goods are per instance and survive save / load;
// changing an instance never changes the definition (definitions are frozen, the error names the fix).
const READY = { timeout: 60000 };
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, READY); };

// the same setup before and after the reload (the template is test data, not part of the example's content)
const setup = () => {
  const p = engine.player.position, x = Math.round(p.x), z = Math.round(p.z);
  engine.ops.define('tchest.toggle', { run: (e, { id }) => e.world.set(id, { opened: !e.world.get(id).opened }) });
  engine.content.load({
    templates: {
      tchest: {
        model: 'rock', collide: 'box', state: { opened: false },
        interact: { label: rec => rec.opened ? 'Close' : 'Open', op: 'tchest.toggle', radius: 2 },
        container: { capacity: 4, items: { berry: 2 } }, sound: { use: 'ding' },
        animate: (rec, obj) => { obj.userData.lid = rec.opened ? 1 : 0; },
      },
    },
    props: [{ template: 'tchest', id: 'tc-a', x: x + 1.2, z }, { template: 'tchest', id: 'tc-b', x: x + 8, z, items: { feather: 1 } }],
  });
  return { x, z };
};

export const specs = [
  {
    name: 'Templates: two chests of one template share the model, opened state and goods are per instance, save / load restores each; definitions are frozen',
    url: '/?cutscene=skip',
    expectErrors: /tchest\.bad|frozen-definition/,   // the deliberate write to a definition inside an op
    async run({ page, check, ev }) {
      const mid = await ev(async (src) => {
        'use strict';   // game modules are strict: a write to a frozen definition throws there (sloppy page code would fail silently)
        engine.haltLoop();
        const { x, z } = (0, eval)(src)();
        const W = engine.world, I = engine.inventory, played = [];
        engine.audio.sfx = name => { played.push(name); };   // spy: the use sound
        engine.step(0.5); await W.whenReady; engine.step(0.1);
        const va = W.view('tc-a'), vb = W.view('tc-b'), mesh = o => { let m = null; o?.traverse(c => { m ||= c.isMesh ? c : null; }); return m; };
        const shared = { both: !!va && !!vb, distinct: va !== vb, geo: mesh(va)?.geometry === mesh(vb)?.geometry, mat: mesh(va)?.material === mesh(vb)?.material,
          solid: va?.userData.colliders.length };
        const use = engine.ops.run('interaction.use', { id: 'tc-a' }); engine.step(0.1);
        const moved = engine.ops.allow(() => I.transfer('tc-a', 'player', 'berry', 1));
        const spawned = engine.ops.allow(() => engine.content.spawn('tchest', { x: x - 6, z }, { opened: true, items: { wood: 3 } }));
        engine.step(0.1);
        const after = {
          a: W.get('tc-a').opened, b: W.get('tc-b').opened, lidA: W.view('tc-a')?.userData.lid, lidB: W.view('tc-b')?.userData.lid,
          aBerry: I.container('tc-a').count('berry'), bBerry: I.container('tc-b').count('berry'), bFeather: I.container('tc-b').count('feather'),
          sId: spawned.id, sKind: spawned.kind, sOpen: spawned.opened, sWood: I.container(spawned.id).count('wood'), sCap: I.container(spawned.id).capacity,
          use: use.ok, moved, played,
        };
        // definition vs instance: the definition did not move, writes to it throw, instance state copies are not shared
        const def = engine.content.template('tchest'), errs = {};
        for (const [k, f] of Object.entries({
          state: () => { def.state.opened = true; }, items: () => { def.container.items.berry = 9; }, add: () => { def.extra = 1; },
          item: () => { I.item('berry').stack = 1; },
          override: () => engine.content.load({ props: [{ template: 'tchest', id: 'tc-x', x, z, model: 'pine' }] }),
          unknown: () => engine.content.load({ props: [{ template: 'tchets', x, z }] }),
          noOp: () => engine.content.load({ templates: { bad: { model: 'rock', interact: { label: 'x' } } } }),
        })) { try { f(); errs[k] = null; } catch (e) { errs[k] = e.message; } }
        const defs = { opened: def.state.opened, items: JSON.stringify(def.container.items), frozen: Object.isFrozen(def.state), stateShared: W.get('tc-a').state };
        engine.saves.save('tpl'); await engine.saves.flush();
        return { shared, after, errs, defs, label: engine.interactions.get('tc-a')?.label() };
      }, setup.toString());
      await reload(page);
      const r = await ev(async (src) => {
        'use strict';   // game modules are strict: a write to a frozen definition throws there (sloppy page code would fail silently)
        engine.haltLoop();
        (0, eval)(src)();
        const W = engine.world, I = engine.inventory;
        const ret = engine.saves.load('tpl'); if (ret?.then) await ret;
        engine.step(0.5); await W.whenReady; engine.step(0.1);
        const s = W.query({ kind: 'tchest' }).find(x => x.id !== 'tc-a' && x.id !== 'tc-b');
        const out = {
          a: W.get('tc-a').opened, b: W.get('tc-b').opened, lidA: W.view('tc-a')?.userData.lid, lidB: W.view('tc-b')?.userData.lid,
          aBerry: I.container('tc-a').count('berry'), bBerry: I.container('tc-b').count('berry'), bFeather: I.container('tc-b').count('feather'),
          sId: s?.id, sOpen: s?.opened, sWood: s && I.container(s.id).count('wood'), sCap: s && I.container(s.id).capacity,
          def: engine.content.template('tchest').state.opened,
        };
        // a write to a definition inside gameplay halts with the hint that names the fix
        engine.ops.define('tchest.bad', { run: e => { e.content.template('tchest').state.opened = true; } });
        const bad = engine.ops.run('tchest.bad', {});
        out.bad = bad.code; out.hint = !!engine.error?.docs?.some(d => d.startsWith('recipes/30-templates.md')) &&   // a pointer names the section too ('recipes/30-templates.md §3')
           /world record/.test(engine.error.fix ?? '');
        return out;
      }, setup.toString());
      const a = mid.after;
      check('two instances share the prototype model (same geometry and material), each its own object; collide builds collision', mid.shared.both && mid.shared.distinct && mid.shared.geo && mid.shared.mat && mid.shared.solid === 1, JSON.stringify(mid.shared));
      check('using chest A (interaction.use -> template op) opens only A; animate follows each record; label reads the record; use sound played', mid.after.use && a.a === true && a.b === false && a.lidA === 1 && a.lidB === 0 && mid.label === 'Close' && a.played.includes('ding'), JSON.stringify({ ...a, label: mid.label }));
      check('goods are per instance: taking a berry from A leaves B alone; a placement items override replaces the starting goods', a.moved === 1 && a.aBerry === 1 && a.bBerry === 0 && a.bFeather === 1, JSON.stringify(a));
      check('engine.content.spawn: runtime instance, kind = template name, own state override and container (capacity from the template)', a.sKind === 'tchest' && a.sOpen === true && a.sWood === 3 && a.sCap === 4, JSON.stringify(a));
      check('definition unchanged and frozen; writes to a template or item definition throw', mid.defs.opened === false && mid.defs.items === '{"berry":2}' && mid.defs.frozen && mid.defs.stateShared === undefined
        && ['state', 'items', 'add', 'item'].every(k => /read only|not extensible/.test(mid.errs[k] ?? '')), JSON.stringify({ defs: mid.defs, errs: mid.errs }));
      check('wrong placements say how to fix: definition field per instance, unknown template (did you mean), interact without op',
        /belongs to the definition/.test(mid.errs.override ?? '') && /tchest/.test(mid.errs.unknown ?? '') && /needs op/.test(mid.errs.noOp ?? ''), JSON.stringify(mid.errs));
      check('after reload + load: each chest restores its own opened state and goods; the picture follows', r.a === true && r.b === false && r.lidA === 1 && r.lidB === 0 && r.aBerry === 1 && r.bBerry === 0 && r.bFeather === 1, JSON.stringify(r));
      check('after load: the runtime instance is back with its state, goods and template container capacity', r.sId === a.sId && r.sOpen === true && r.sWood === 3 && r.sCap === 4, JSON.stringify(r));
      check('writing a definition inside an op halts with the frozen-definition hint (keep state on the world record)', r.def === false && r.bad === 'error' && r.hint === true, JSON.stringify(r));
    },
  },
  {
    name: 'Off the island: engine.content.spawn / a placed prop beyond terrain({ shape }) warns with the fix and is placed at a finite y; a record saves finite positions',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const warns = [], w0 = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
        const err = f => { try { f(); return null; } catch (e) { return e.message; } };
        // stand-in for terrain({ shape }): surface() is -Infinity beyond x = 1000
        engine.setGround({ height: x => x > 1000 ? -Infinity : 0, has: x => x <= 1000 });
        engine.content.load({ templates: { tvoid: { model: 'rock' } } });
        let outY = null;
        const spawnThrew = err(() => engine.ops.allow(() => { outY = engine.content.spawn('tvoid', { x: 2000, z: 0 }).position.y; }));
        const spawnOut = warns.find(m => /no ground/.test(m)) ?? spawnThrew;
        const propThrew = err(() => engine.content.load({ props: [{ template: 'tvoid', id: 'tv-out', x: 2000, z: 0 }] }));
        const propOut = propThrew ?? warns.filter(m => /no ground/.test(m)).join(' / ') + ' |' + warns.length;
        console.warn = w0;
        const spawnIn = engine.ops.allow(() => engine.content.spawn('tvoid', { x: 5, z: 0 }));
        engine.content.load({ props: [{ template: 'tvoid', id: 'tv-y', x: 7, z: 0, y: 3 }] });
        engine.step(0.1);
        const text = JSON.stringify(engine.saves.collect());
        return { spawnThrew, propThrew, outY, spawnOut, propOut, inY: spawnIn.position.y, yRec: engine.world.get('tv-y')?.position.y, bad: /null|NaN|Infinity/.test(JSON.stringify(engine.world.get('tv-y').position) + JSON.stringify(spawnIn.position)), len: text.length };
      });
      check('engine.content.spawn beyond the island warns (no throw), says to check engine.ground.has, and stays finite', !r.spawnThrew && /no ground/.test(r.spawnOut ?? '') && /ground\.has/.test(r.spawnOut ?? '') && Number.isFinite(r.outY), JSON.stringify([r.spawnThrew, r.spawnOut, r.outY]));
      check('a content prop beyond the island does not throw either; inside spawns on the ground', !r.propThrew && r.inY === 0, JSON.stringify([r.propThrew, r.propOut, r.inY]));
      check('records never hold null / NaN / Infinity positions after a save', r.yRec === 3 && !r.bad, JSON.stringify(r));
    },
  },
  {
    // guard: an editor panel lists exactly engine.content.fields(); the loader enforces the same table (range, values, no default in fields)
    name: 'Template fields: engine.content.fields() merges placement fields and state fields (default from state); placements out of range or a default in fields throw',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const err = f => { try { f(); return null; } catch (e) { return e.message; } };
        engine.content.load({ templates: { tcrop: { model: 'rock', state: { stage: 0, sort: 'wheat' }, fields: { stage: { type: 'int', min: 0, max: 4, desc: 'growth' }, sort: { values: ['wheat', 'corn'] } } } } });
        const f = engine.content.fields('tcrop'), p = engine.content.fields('props');
        engine.content.load({ props: [{ template: 'tcrop', id: 'tcrop-1', x: 3, z: 0, stage: 2 }] });
        return {
          stage: f.stage, sort: f.sort, placement: !!f.rot && !!f.x && !!f.template, propRot: p.rot?.type, byId: !!engine.content.fields('tcrop-1').stage,
          range: err(() => engine.content.load({ props: [{ template: 'tcrop', id: 'tcrop-2', x: 3, z: 0, stage: 9 }] })),
          spawn: err(() => engine.ops.allow(() => engine.content.spawn('tcrop', { x: 4, z: 0 }, { sort: 'rice' }))),
          dflt: err(() => engine.content.load({ templates: { tbad: { model: 'rock', state: { n: 1 }, fields: { n: { type: 'int', default: 2 } } } } })),
          grid: err(() => engine.content.load({ props: [{ id: 'g-1', grid: 'yard', item: 'bed', cel: [0, 0] }] })),
          unknown: err(() => engine.content.fields('nope')),
        };
      });
      check('fields(template): state field with default from state, range and desc from fields; type inferred when not written', r.stage?.type === 'int' && r.stage.default === 0 && r.stage.max === 4
        && r.stage.desc === 'growth' && r.sort?.type === 'string' && r.sort.default === 'wheat' && r.sort.values?.length === 2 && r.placement && r.propRot === 'number|position' && r.byId, JSON.stringify(r));
      check('a placement or spawn outside the template fields throws', /stage must be <= 4/.test(r.range ?? '') && /sort must be one of/.test(r.spawn ?? ''), JSON.stringify([r.range, r.spawn]));
      check('default inside fields throws (defaults live only in state); a misspelled grid key says did you mean', /fields\.n has a default/.test(r.dflt ?? '') && /did you mean 'cell'/.test(r.grid ?? ''), JSON.stringify([r.dflt, r.grid]));
      check('an unknown name lists what fields() knows', /field table/.test(r.unknown ?? '') && /props\.grid/.test(r.unknown ?? ''), r.unknown);
    },
  },
  {
    // engine.unuse says tracked handles go with the module: these were not, so a new content() could not present its own template kind ('taken')
    name: '[guard] engine.unuse(content) takes its quest listeners and template presenters with it; a new content() loads the same templates',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'tpl-unuse');
        E.use(T.world(), T.quests(), T.content());
        await E.start(); E.haltLoop();
        const data = () => ({ templates: { tBox: { model: 'rock' } }, quests: { tq: { title: 'q', steps: [{ text: 's', done: { flag: 'never' } }], startOn: 'test:tq' } } });
        E.content.load(data());
        out.before = E.world.presents('tBox');
        E.unuse('content');
        out.after = E.world.presents('tBox');
        E.ops.allow(() => E.events.emit('test:tq', {}));
        out.started = E.quests.state('tq');
        E.use(T.content());
        out.again = (() => { try { E.content.load(data()); return E.world.presents('tBox'); } catch (x) { return x.message; } })();
        E.dispose();
        return out;
      });
      check('the presenter goes with the module and comes back with a new one', r.before === true && r.after === false && r.again === true, JSON.stringify(r));
      check('the startOn listener went too: the event starts nothing', !r.started?.active, JSON.stringify(r));
    },
  },
];
