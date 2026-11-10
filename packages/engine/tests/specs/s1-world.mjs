// Stage 1.11, world data separated from presentation: tests for engine.world (modules/world). Same format as the other files here.
export const specs = [
  {
    name: 'S1 world data: add/set/remove/query, query by distance, events, putting a three.js object in data throws with a fix (open world)',
    url: '/?cutscene=skip',   // the opening cutscene takes over the camera (focus does not follow the player)
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, p = engine.player.position, seen = [];
        const h = engine.events.on('world:change', d => seen.push(d.keys.join(',')));
        const a = W.add({ id: 's1-a', kind: 's1box', position: [p.x + 3, 0, p.z], hp: 5 });
        const b = W.add({ kind: 's1box', position: { x: p.x + 10, z: p.z } });
        W.set('s1-a', { hp: 4 });
        W.move(b.id, [p.x + 1, 0, p.z]);
        const near = W.query({ kind: 's1box', near: p, radius: 20 }).map(x => x.id);
        let plainErr = null; try { W.add({ kind: 's1box', mesh: new __threedogThree.Mesh() }); } catch (e) { plainErr = e.message; }
        let dupErr = null; try { W.add({ id: 's1-a', kind: 's1box' }); } catch (e) { dupErr = e.message; }
        W.remove(b.id);
        h.remove();
        let sameName = null; engine.npcs.add({ name: 's1-same-name' }); try { engine.npcs.add({ name: 's1-same-name' }); } catch (e) { sameName = e.message; }
        return { autoId: /^s1box#\d+$/.test(b.id), hp: W.get('s1-a').hp, seen, near, plainErr, dupErr, sameName, gone: W.get(b.id) === undefined, pos: a.position };
      });
      check('add returns plain data, auto-numbers the id when omitted, position is { x, y, z }', r.autoId && typeof r.pos.x === 'number' && r.pos.y === 0, JSON.stringify(r));
      check('set changes fields and emits world:change', r.hp === 4 && r.seen.includes('hp'), JSON.stringify(r.seen));
      check('query orders by distance, nearest first (the moved one first)', r.near[0] !== 's1-a' && r.near[1] === 's1-a', JSON.stringify(r.near));
      check('three.js object in data: throws and says to use present()', /three\.js object/.test(r.plainErr ?? '') && /present/.test(r.plainErr), r.plainErr);
      check('duplicate id: throws and suggests set', /set/.test(r.dupErr ?? ''), r.dupErr);
      check('get returns undefined after remove', r.gone);
      check('two NPCs with the same name and no id: throws and asks for an id on each (no silent merging)', /its own id/.test(r.sameName ?? ''), r.sameName);
    },
  },
  {
    name: 'S1 world data: build the model when near, tear it down when far without losing data, near / far simulation, save round trip (open world)',
    url: '/?cutscene=skip',   // the opening cutscene takes over the camera (focus does not follow the player)
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, T = __threedogThree, P = engine.player, home = P.position.clone();
        W.present('s1tree', { build: () => new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial()), radius: 40 });
        let nearCalls = 0;
        W.simulate('s1crop', { near: () => { nearCalls++; }, far: (rec, dt) => W.set(rec.id, { growth: rec.growth + dt }), radius: 40 });
        const t = W.add({ id: 's1-tree', kind: 's1tree', position: [home.x + 5, 0, home.z], stage: 'stump' });
        W.add({ id: 's1-crop-near', kind: 's1crop', position: [home.x + 2, 0, home.z], growth: 0 });
        W.add({ id: 's1-crop-far', kind: 's1crop', position: [home.x + 500, 0, home.z], growth: 0 });
        engine.step(0.2);
        const built = W.view('s1-tree'), atRecord = built && built.position.x === t.position.x;
        P.placeAt({ x: home.x + 400, z: home.z }); engine.step(3);   // the camera focus follows smoothly
        const away = { viewGone: W.view('s1-tree') === null, focusX: Math.round(engine.focus.x - home.x), stillThere: W.get('s1-tree')?.stage };
        const g0 = W.get('s1-crop-far').growth;
        engine.step(10, { render: false });
        const grew = W.get('s1-crop-far').growth - g0, stepped = 10;
        P.placeAt({ x: home.x, z: home.z }); engine.step(3);
        const back = !!W.view('s1-tree');
        engine.saves.save('s1-world');
        const json = engine.saves.export('s1-world');
        W.set('s1-tree', { stage: 'tree' }); W.remove('s1-crop-near');
        const ret = engine.saves.load('s1-world');
        return { atRecord, away, grew, stepped, nearCalls, back, isPromise: typeof ret?.then === 'function',
          restored: W.get('s1-tree')?.stage, nearBack: !!W.get('s1-crop-near'), plainSave: !!json && !/"isObject3D"|"uuid"/.test(atob(json)) };
      });
      check('walking near: the model is built automatically and placed at the position in the record', r.atRecord, JSON.stringify(r));
      check('walking far: the model is torn down, the data stays', r.away.viewGone && r.away.stillThere === 'stump', JSON.stringify(r.away));
      check('far simulation: accumulated dt equals the elapsed seconds (no time lost)', r.grew > 0 && Math.abs(r.grew - r.stepped) < r.stepped * 0.15 + 1, `${r.grew} vs ${r.stepped}`);
      check('near simulation runs every fixed step', r.nearCalls > 30, r.nearCalls);
      check('walking back: the model is rebuilt', r.back);
      check('save round trip: changes and removals are restored (load always returns a Promise), the save contains no three.js objects', r.isPromise && r.restored === 'stump' && r.nearBack && r.plainSave, JSON.stringify(r));
    },
  },
  {
    name: 'S1 world data: show hides the model for now, refresh builds at once, radius as a function, async build can be awaited, a failed build reports without blocking ready (open world)',
    url: '/?cutscene=skip',
    expectErrors: /s1bad/,   // make one model fail to build on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const W = engine.world, T = __threedogThree, p = engine.player.position, tick = () => new Promise(r => setTimeout(r, 0));
        const box = () => new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial());
        let R = 20;
        W.present('s1show', { build: box, show: rec => !rec.hidden, radius: () => R });
        W.add({ id: 's1-show', kind: 's1show', position: [p.x + 2, 0, p.z] });
        W.add({ id: 's1-r', kind: 's1show', position: [p.x + 30, 0, p.z] });
        W.refresh();
        const now = { show: !!W.view('s1-show'), far: !!W.view('s1-r') };
        W.set('s1-show', { hidden: true }); engine.step(0.05);
        const hidden = !W.view('s1-show');
        W.set('s1-show', { hidden: false }); engine.step(0.05);
        const shown = !!W.view('s1-show');
        R = 40; W.refresh();
        const followed = !!W.view('s1-r');
        // async build: ready is false until built, whenReady can be awaited; a failure reports once, does not block ready and does not freeze gameplay
        let resolve = null;
        W.present('s1async', { build: () => new Promise(r => { resolve = () => r(box()); }) });
        W.present('s1bad', { build: async () => { throw new Error('s1 bad model'); } });
        const errs = [], ce = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); ce(...a); };
        W.add({ id: 's1-async', kind: 's1async', position: [p.x + 3, 0, p.z] });
        W.add({ id: 's1-bad', kind: 's1bad', position: [p.x + 4, 0, p.z] });
        W.refresh();
        const pendingReady = W.ready;
        let waited = false; W.whenReady.then(() => { waited = true; });
        resolve();
        for (let i = 0; i < 100 && !waited; i++) { await tick(); engine.step(0.05); await tick(); }
        console.error = ce;
        return { now, hidden, shown, followed, pendingReady, waited, ready: W.ready, asyncView: !!W.view('s1-async'), badView: W.view('s1-bad'), errs: errs.filter(s => /s1bad/.test(s)).length, frozen: engine.error };
      });
      check('after refresh the model exists at once (no need to wait a frame); none outside the radius', r.now.show && !r.now.far, JSON.stringify(r.now));
      check('show returns false: the model is torn down after set; changing it back builds it again', r.hidden && r.shown, JSON.stringify(r));
      check('present radius written as a function: growing at runtime, the model is built after a refresh', r.followed);
      check('async build: ready is false until built, whenReady can be awaited, the model exists afterwards', r.pendingReady === false && r.waited && r.asyncView, JSON.stringify(r));
      check('failed build: reports once, no model, ready is not blocked, gameplay is not frozen', r.errs === 1 && r.badView === null && r.ready && !r.frozen, JSON.stringify(r));
    },
  },
  {
    name: 'S1 world data: near / far dt share one yardstick (also under a time scale), the time owed while far is saved (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, p = engine.player.position;
        engine.mod('clock.rate', { owner: 'test', set: 30 });   // game clock runs 30x: dt does not follow it
        let T = 0;
        const h = engine.onFixed(dt => { T += dt; });   // the test counts elapsed seconds itself (onFixed runs before world simulation)
        const acc = (rec, dt) => { rec.acc += dt; rec.at = T; };
        W.simulate('s1acc', { near: acc, far: acc, farEvery: 4, radius: 40 });
        const T0 = T;
        W.add({ id: 's1-acc-near', kind: 's1acc', position: [p.x + 2, 0, p.z], acc: 0, at: 0 });
        W.add({ id: 's1-acc-far', kind: 's1acc', position: [p.x + 500, 0, p.z], acc: 0, at: 0 });
        const c0 = engine.clock.now;
        engine.step(10, { render: false });
        const near = W.get('s1-acc-near').acc, f1 = W.get('s1-acc-far'), first = { acc: f1.acc, span: f1.at - T0 }, clock = engine.clock.now - c0;
        engine.saves.save('s1-acc');
        engine.saves.load('s1-acc');   // load straight back: the time owed since the last far simulation must carry on
        engine.step(6, { render: false });
        const f2 = W.get('s1-acc-far');
        h.remove();
        return { near, elapsed: T - T0 - 6, clock, first, after: { acc: f2.acc, span: f2.at - T0 } };
      });
      check('near dt total = elapsed seconds (not multiplied by the time scale)', Math.abs(r.near - r.elapsed) < 0.02 && r.clock > r.elapsed * 5, JSON.stringify(r));
      check('far dt total = seconds from being added to the last simulation (same yardstick as near)', r.first.span > 0 && Math.abs(r.first.acc - r.first.span) < 0.02, JSON.stringify(r.first));
      check('save -> load: far records carry on with the owed time, total still equals the elapsed seconds', r.after.span > 10 && Math.abs(r.after.acc - r.after.span) < 0.02, JSON.stringify(r.after));
    },
  },
  {
    name: 'S1 world data: 2000 records (far simulation) cost under 0.5 ms per fixed step (open world)',
    url: '/?cutscene=skip',   // the opening cutscene takes over the camera (focus does not follow the player)
    serial: true,   // judges by a measured time (R56)
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, p = engine.player.position;
        W.simulate('s1mob', { near: rec => W.move(rec.id, [rec.position.x + 0.01, 0, rec.position.z]), far: (rec, dt) => { rec.t = (rec.t || 0) + dt; } });
        for (let i = 0; i < 2000; i++) W.add({ kind: 's1mob', position: [p.x + (i % 50) * 20 - 500, 0, p.z + Math.floor(i / 50) * 20 - 400] });
        engine.step(0.5, { render: false });
        engine.profile(true);
        engine.step(2, { render: true });   // 120 fixed steps + 60 frame hooks, rendering only 1 frame
        const ms = engine.profile().world?.mean ?? 0;   // average per frame-hook cycle (60 over these 2 seconds, 2 fixed steps each)
        return { perFrame: ms, perStep: ms / 2 };
      });
      check(`2000 records: world averages < 0.5 ms per fixed step (measured ${r.perStep.toFixed(3)})`, r.perStep < 0.5, JSON.stringify(r));
    },
  },
];
