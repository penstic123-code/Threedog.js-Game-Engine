// Guards for per-frame waste, frozen save loads and the picture write paths. Each [guard] turns red when someone brings back the old way:
// serializing every staged copy every frame, re-reading layout for an idle menu, wrapping every camera method with a pose compare, a bad offer
// that makes describe() throw, gameplay running while an async save part loads, a take-handle that adds a cleanup entry per frame.

export const specs = [
  {
    name: 'Leftovers: a staged template copy is not serialized per frame [guard]',
    url: '/tests/placeables/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const W = engine.world, home = engine.player.position.clone();
        engine.content.load({ templates: { tser: { model: 'rock', stages: [{ name: 'a', duration: 100 }, { name: 'b', model: 'pine' }] } } });
        engine.ops.allow(() => engine.content.spawn('tser', { x: home.x + 3, z: home.z }, { id: 'ts-1' }));
        engine.world.refresh(); await W.whenReady; engine.step(0.1); await W.whenReady; engine.step(0.1);
        const built = !!W.view('ts-1');
        const orig = JSON.stringify; let calls = 0;
        JSON.stringify = function (v, ...a) { if (v === 'rock' || v === 'pine') calls++; return orig.call(this, v, ...a); };
        try { engine.step(0.5); } finally { JSON.stringify = orig; }
        // the stage still switches the model (the cheap key must not miss a change)
        engine.ops.allow(() => W.set('ts-1', { stage: 1 }));
        engine.step(0.05); await W.whenReady; engine.step(0.05); await W.whenReady; engine.step(0.05);
        return { built, calls, model: W.view('ts-1')?.userData.model };
      });
      check('[guard] no JSON.stringify of the model during 30 frames of an idle staged copy', r.built && r.calls === 0, JSON.stringify(r));
      check('a stage with another model still rebuilds the copy', r.model === '"pine"', JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: an open menu with an idle cursor reads no layout per frame [guard]',
    url: '/tests/uinav/index.html',
    async run({ check, ev, frames }) {
      await ev(() => engine.ui.open('inventory'));
      await frames(4);
      const r = await ev(async () => {
        const proto = Element.prototype, gcr = proto.getClientRects, gbr = proto.getBoundingClientRect;
        let reads = 0;
        proto.getClientRects = function () { if (this.closest?.('.threedog-win-inventory')) reads++; return gcr.call(this); };
        proto.getBoundingClientRect = function () { if (this.closest?.('.threedog-win-inventory')) reads++; return gbr.call(this); };
        try { for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame); } finally { proto.getClientRects = gcr; proto.getBoundingClientRect = gbr; }
        return { reads, marked: document.querySelectorAll('.threedog-win-inventory .is-cursor').length };
      });
      check('[guard] 10 idle frames: no getClientRects / getBoundingClientRect on the menu, one control still marked', r.reads === 0 && r.marked === 1, JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: camera rig methods are not wrapped; a cut between frames is still the engine\'s write [guard]',
    url: '/tests/cameras/index.html?cam=fixed',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop(); engine.step(0.1);
        const rig = engine.cameraRig, proto = Object.getPrototypeOf(rig);
        const unwrapped = rig.forward === proto.forward && rig.cut === proto.cut;
        const shots = Object.keys(rig.shots), other = shots.find(s => s !== rig.current) ?? shots[0];
        rig.cut(other);
        engine.step(0.1);
        const afterCut = engine._owned.get('camera').mode;
        engine.camera.position.x += 5;   // a real outside write must still yield
        engine.step(0.1);
        const afterWrite = engine._owned.get('camera').mode;
        engine.autoView.manual('camera', false);
        return { unwrapped, afterCut, afterWrite };
      });
      check('[guard] rig methods are the class methods (no per-call pose compare)', r.unwrapped, JSON.stringify(r));
      check('a cut between frames does not stop the rig', r.afterCut === 'engine', JSON.stringify(r));
      check('a direct camera write still yields', r.afterWrite === 'yielded', JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: an op with bad offers shows up in describe instead of throwing [guard]',
    url: '/tests/placeables/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.ops.define('lo.bad', { args: { n: 'number' }, offers: () => [{ n: 'not a number' }], run: () => {} });
        engine.ops.define('lo.throws', { args: { n: 'number' }, offers: () => { throw new Error('offers broke'); }, run: () => {} });
        let d = null, err = null;
        try { d = engine.describe(); } catch (e) { err = String(e.message || e); }
        const list = engine.ops.list({ available: true }).filter(a => a.name.startsWith('lo.'));
        return { err, list: list.map(a => ({ name: a.name, ok: a.ok, code: a.code, error: a.facts?.error })), actions: (d?.actions ?? []).filter(a => a.op.startsWith('lo.')).map(a => a.code) };
      });
      check('[guard] describe() does not throw on a bad offer', r.err === null, JSON.stringify(r));
      check('the bad arg set is reported as badOffer with the reason', r.list.some(a => a.name === 'lo.bad' && a.code === 'badOffer' && a.error), JSON.stringify(r));
      check('a throwing offers is reported as offersFailed', r.list.some(a => a.name === 'lo.throws' && a.code === 'offersFailed' && /offers broke/.test(a.error)), JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: gameplay stays frozen while an async save part loads (no fixed step, no op) [guard]',
    url: '/tests/placeables/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        let release = null, fixed = 0, state = 1;
        engine.saves.define('loSlow', { save: () => ({ v: state }), load: d => new Promise(res => { release = () => { state = d.v; res(); }; }) });
        engine.ops.define('lo.poke', { args: {}, run: () => { state = 99; } });
        const h = engine.onFixed(() => fixed++);
        engine.saves.save('loSlot');
        state = 2;
        const done = engine.saves.load('loSlot');
        for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
        const f0 = fixed;
        engine.step(0.5, { render: false });
        const during = { fixed: fixed - f0, op: engine.ops.run('lo.poke').code, can: engine.ops.can('lo.poke').code, state };
        release?.();
        const ok = await done;
        const f1 = fixed;
        engine.step(0.1, { render: false });
        const after = { ok, fixed: fixed - f1, op: engine.ops.run('lo.poke').ok, state };
        h.remove();
        return { started: !!release, during, after };
      });
      check('[guard] no fixed step while a part is still loading', r.started && r.during.fixed === 0, JSON.stringify(r));
      check('[guard] ops.run / ops.can refuse with code loading meanwhile (state untouched)', r.during.op === 'loading' && r.during.can === 'loading' && r.during.state === 2, JSON.stringify(r));
      check('once every part is applied, steps and ops run again', r.after.ok === true && r.after.fixed > 0 && r.after.op === true && r.after.state === 99, JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: handle.change rewrites a shared entry in place; weather adds no entry or cleanup handle per frame [guard]',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const S = engine.stacks; S.define('lo.k', { base: 2 });
        const h = engine.mod('lo.k', { owner: 'lo', mul: 0.5, layer: 'effect' }), ent0 = S.get('lo.k')._map(undefined).get('lo');
        const v1 = S.get('lo.k').value(); h.change(0.25);
        const v2 = S.get('lo.k').value(), same = S.get('lo.k')._map(undefined).get('lo') === ent0;
        let bad = ''; try { h.change('x'); } catch (e) { bad = e.message; }
        h.remove(); const stale = h.change(3);
        const W = engine.modules.get('weather');
        W.applyState(engine, { weather: 'rain' }); engine.step(0.1);
        const tracked = () => engine._modTracked.get('weatherDraw')?.size ?? 0;
        const tint = () => S.get('sky.tint')._map(undefined)?.get('weatherDraw');
        const t0 = tracked(), e0 = tint();
        engine.step(1);
        return { v1, v2, same, bad: !!bad, stale, t0, t1: tracked(), sameTint: !!e0 && tint() === e0 };
      });
      check('change() rewrites the value in place (same entry, value follows)', r.v1 === 1 && r.v2 === 0.5 && r.same, JSON.stringify(r));
      check('change() checks the value like take; a removed handle changes nothing', r.bad && r.stale === false, JSON.stringify(r));
      check('[guard] 60 weather frames: no new tracked handle, the same sky tint entry', r.t1 === r.t0 && r.sameTint, JSON.stringify(r));
    },
  },
  {
    name: 'Leftovers: a tone-slot post effect replaces the tone-mapping output, one at a time [guard]',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const p = engine.post, THREE = threedogTest.THREE;
        const err = f => { try { f(); return ''; } catch (e) { return e.message; } };
        let made = null;
        const tone = { name: 'myTone', slot: 'tone', create: () => (made = { enabled: true, needsSwap: true, renderToScreen: false, setSize() {}, dispose() {},
          render(r, w, rd) { r.setRenderTarget(this.renderToScreen ? null : w); r.clear(); } }) };
        const h = p.add(tone);
        p.render(0.016);
        const passes = p.composer.passes, out = { has: passes.includes(made), output: passes.some(x => x?.isOutputPass), tone: engine.describe().render?.toneMapping?.value };
        out.second = err(() => p.add({ name: 'otherTone', slot: 'tone', create: () => made }));
        h.remove(); p.render(0.016);
        out.backOutput = !p.composer || p.composer.passes.some(x => x?.isOutputPass) || !p.active;
        return out;
      });
      check('[guard] the tone effect sits where OutputPass was, and OutputPass is gone', r.has && !r.output, JSON.stringify(r));
      check('describe().render.toneMapping names the tone effect', /myTone/.test(r.tone ?? ''), JSON.stringify(r));
      check('[guard] a second tone effect throws (exclusive slot)', /already holds 'myTone'/.test(r.second), r.second);
      check('removing it brings the engine output stage back', r.backOutput, JSON.stringify(r));
    },
  },
];
