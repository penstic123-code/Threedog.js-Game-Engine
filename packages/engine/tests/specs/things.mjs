// Thing registry (recipes/40-scene.md): the same windmill through the two doors, plain three.js (engine.add(obj, { id })) and a template
// placement, must answer engine.thing / hit.thing the same way, change and undo with thing.set, and come back after a save + page reload.
// Also guards: "cannot be saved" and "two systems manage one object" are reported, engine internals are not listed as game things, the dev stack cap.
const READY = { timeout: 60000 };
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, READY); };

// both windmills; the native one is added in the setup window (what start() / a session:start listener sees), the record one via content
const build = (x, z, native = true) => {
  const T = __threedogThree;
  if (native) {
    const mill = new T.Group(), blade = new T.Mesh(new T.BoxGeometry(1, 4, 1), new T.MeshLambertMaterial());
    blade.position.y = 2; mill.add(blade); mill.position.set(x + 20, engine.surface(x + 20, z), z);
    engine._things.setup = true; engine.add(mill, { id: 'windmill-a' }); engine._things.setup = false;
    mill.updateMatrixWorld(true); engine.rays.addStatic(mill);
  }
  engine.content.load({ templates: { windmill: { model: 'rock' } }, props: [{ template: 'windmill', id: 'windmill-b', x: x - 20, z }] });
};

export const specs = [
  {
    name: 'Thing registry: two doors to one windmill (engine.add with id, template) — query, thing.set, undo, save + reload, warnings (open world)',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      const r = await ev(async (src) => {
        'use strict';
        engine.haltLoop();
        const warns = [], warn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
        const err = f => { try { f(); return null; } catch (e) { return e.message; } };
        const p = engine.player.position, x = Math.round(p.x), z = Math.round(p.z);
        const gameBefore = [...engine._things.byId.keys()].filter(id => engine._things.live(id) && engine._things.byObj.get(engine._things.live(id)).owner === 'game')
          .map(id => `${id} ${engine._things.live(id).type}/${engine._things.live(id).material?.type ?? ''} ${engine._things.byObj.get(engine._things.live(id)).at}`);
        (0, eval)(src)(x, z);
        for (let i = 0; i < 40 && !engine.world.view('windmill-b'); i++) { engine.step(0.1); await new Promise(res => setTimeout(res, 0)); }
        const W = engine.world, a = engine.thing('windmill-a'), b = engine.thing('windmill-b');
        const mill = a.object, blade = mill.children[0];
        const hit = engine.raycast({ x: mill.position.x, y: mill.position.y + 50, z: mill.position.z }, { x: 0, y: -1, z: 0 });
        const viaBlade = engine.thing(blade).id, viaModel = engine.thing(W.view('windmill-b')).id;
        // change, undo, change again (then save)
        const at0 = mill.position.toArray(), b0 = { ...W.get('windmill-b').position };
        const setA = engine.ops.run('thing.set', { id: 'windmill-a', position: [x + 5, at0[1], z + 2], rotation: 1 });
        const setB = engine.ops.run('thing.set', { id: 'windmill-b', position: [x + 5, 0, z - 2] });
        const moved = { a: mill.position.toArray(), b: { ...W.get('windmill-b').position } };
        engine.ops.undo('thing.set', { id: 'windmill-a', position: [x + 5, at0[1], z + 2], rotation: 1 }, setA.value);
        engine.ops.undo('thing.set', { id: 'windmill-b', position: [x + 5, 0, z - 2] }, setB.value);
        const undone = { a: mill.position.toArray(), rotY: mill.rotation.y, b: { ...W.get('windmill-b').position }, over: engine._things.over.has('windmill-a') };
        engine.ops.run('thing.set', { id: 'windmill-a', position: [x + 5, at0[1], z + 2] });
        engine.ops.run('thing.set', { id: 'windmill-b', position: [x + 5, 0, z - 2] });
        // remove / undo on the native one keeps the object
        const rm = engine.ops.run('thing.remove', { id: 'windmill-a' }), rmParent = mill.parent;
        engine.ops.undo('thing.remove', { id: 'windmill-a' }, rm.value);
        // made inside an op with save: true: cannot be saved -> warned, listed in describe().scene.unsaved
        if (!engine.ops.defs.has('test.spark')) engine.ops.define('test.spark', { run: e => e.add(new __threedogThree.Object3D(), { save: true }) && null });
        engine.ops.run('test.spark', {});
        const unsavedWarn = warns.find(w => /thing-unsaved/.test(w)) ?? null;
        // two systems, one object: adding a world model throws; moving it by code is reported next frame
        const owned = err(() => engine.add(W.view('windmill-b')));
        engine.step(1 / 60); W.view('windmill-b').position.x += 3; engine.step(1 / 60);   // the first frame after a build only records where world put it
        // ids are unique across engine.add and world records; engine internals are not game things
        const dupRec = err(() => engine.add(new __threedogThree.Object3D(), { id: 'windmill-b' }));
        const badId = err(() => engine.add(new __threedogThree.Object3D(), { id: 'a#1' }));
        const dupNative = err(() => W.add({ id: 'windmill-a', kind: 'windmill' }));
        const named = new __threedogThree.Object3D(); named.name = 'Scene'; engine.add(named);
        const implicit = { id: engine.thing(named).id, saved: engine.thing(named).saved, byName: engine.thing('Scene')?.id };
        engine.remove(named);
        engine.add(new __threedogThree.Object3D(), { owner: 'engine:test' });
        // dev stack cap: after 2000 stacks, at is null and describe says so
        const T = engine._things, s0 = T.stacks; T.stacks = 1999;
        const o1 = new __threedogThree.Object3D(), o2 = new __threedogThree.Object3D(); engine.add(o1); engine.add(o2);
        const capped = { first: engine.thing(o1).at, second: engine.thing(o2).at, flag: engine.describe().scene.atCapped };
        T.stacks = s0; engine.remove(o1, o2);
        const gone = err(() => engine.thing(o1));
        const scene = engine.describe().scene;
        await engine.saves.save('things'); await engine.saves.flush();
        console.warn = warn;
        return { x, z, gameBefore, batchingOwner: (engine.scene.add(engine.batching.root), engine.thing(engine.batching.root).owner), a: { saved: a.saved, owner: a.owner, at: a.at, loses: a.loses, edit: a.edit, kind: a.kind },
          b: { saved: b.saved, owner: b.owner, template: b.template, edit: b.edit }, hit: hit?.thing?.id ?? null, viaBlade, viaModel,
          at0, b0, moved, undone, rmParent: rmParent === null, back: mill.parent === engine.scene, unsavedWarn, owned, dupRec, badId, capped, gone, scene, dupNative, implicit,
          saved: engine.saves.collect().parts.scene, sessionFlag: await (async () => { let f = null; const h = engine.events.on('session:start', () => { f = T.setup; }); await engine.session.newGame(); h.remove(); return f; })() };   // a real new game: the window opens in session.js's start step, not on an emitted event
      }, build.toString());
      console.log('    game things at start:', r.gameBefore.join(' | '), '· windmill-a at', r.a.at);
      check('both doors answer engine.thing: native saved "code" (loses geometry / material), template saved "record"', r.a.saved === 'code' && r.a.owner === 'game' && r.a.loses.some(l => /geometry and material/.test(l)) && r.b.saved === 'record' && r.b.template === 'windmill', JSON.stringify([r.a, r.b]));
      check('hit.thing / thing(child) name the windmill: blade -> windmill-a, record model -> windmill-b', r.hit === 'windmill-a' && r.viaBlade === 'windmill-a' && r.viaModel === 'windmill-b', JSON.stringify([r.hit, r.viaBlade, r.viaModel]));
      check('thing.set moves both (native transform, record position)', r.moved.a[0] === r.x + 5 && r.moved.a[2] === r.z + 2 && r.moved.b.x === r.x + 5 && r.moved.b.z === r.z - 2, JSON.stringify(r.moved));
      check('ops.undo puts both back (rotation too; no override left)', r.undone.a.every((v, i) => v === r.at0[i]) && r.undone.rotY === 0 && r.undone.b.x === r.b0.x && r.undone.b.z === r.b0.z && !r.undone.over, JSON.stringify([r.undone, r.at0, r.b0]));
      check('thing.remove detaches and keeps the object; undo puts it back', r.rmParent && r.back);
      check('the scene save part stores the native override; the record goes in the world part', r.saved?.set?.['windmill-a']?.position?.[0] === r.x + 5 && !r.saved?.set?.['windmill-b'], JSON.stringify(r.saved));
      check('engine.add(obj, { save: true }) inside an op warns it cannot be saved, and describe().scene.unsaved lists it', /thing-unsaved/.test(r.unsavedWarn ?? '') && r.scene.unsaved.some(u => /test\.spark/.test(u)), JSON.stringify([r.unsavedWarn, r.scene.unsaved]));
      check('engine.add of a world model throws; code moving it is reported in describe().scene.conflicts', /thing-owned/.test(r.owned ?? '') && r.scene.conflicts.some(c => /windmill-b/.test(c)), JSON.stringify([r.owned, r.scene.conflicts]));
      check('ids: a world record id and an id with # are refused', /world record id/.test(r.dupRec ?? '') && /without '#'/.test(r.badId ?? ''), JSON.stringify([r.dupRec, r.badId]));
      check('ids: world.add of an id held by an engine.add object throws thing-id (both doors check)', /thing-id|already the id of an object added with engine.add/.test(r.dupNative ?? ''), r.dupNative);
      check('obj.name is not an id: a named object without { id } is session tier (obj#n), still found by name', /^obj#\d+$/.test(r.implicit.id) && r.implicit.saved === 'session' && r.implicit.byName === r.implicit.id, JSON.stringify(r.implicit));
      // the one allowed: the sea (modules/water/Water.js still calls engine.add without { owner: 'engine:water' }; another change owns that file)
      check('engine internals are not game things (describe counts them under engine)', r.scene.engine >= 1 && r.gameBefore.filter(t => /engine/.test(t)).length <= 1, JSON.stringify({ before: r.gameBefore, scene: r.scene }));
      check('the batching root is the engine\'s, not a game object', r.batchingOwner === 'engine:batching', r.batchingOwner);
      check('dev stack cap: the 2001st add has at: null and describe says atCapped', r.capped.first !== undefined && r.capped.second === null && r.capped.flag === true, JSON.stringify(r.capped));
      check('engine.remove forgets the entry (thing throws with a hint)', /nothing has this id/.test(r.gone ?? ''), r.gone);
      check('session:start opens the setup window (what its listeners add is code-built)', r.sessionFlag === true);

      await reload(page);
      const r2 = await ev(async ([src, x, z]) => {
        engine.haltLoop();
        // load before the native windmill exists: its override waits (pending), then applies when it registers
        await engine.saves.load('things');
        const pendingBefore = Object.keys(engine._things.pending.set);
        (0, eval)(src)(x, z);
        for (let i = 0; i < 40 && !engine.world.view('windmill-b'); i++) { engine.step(0.1); await new Promise(res => setTimeout(res, 0)); }
        const a = engine.thing('windmill-a');
        return { pendingBefore, a: a.object.position.toArray(), saved: a.saved, b: { ...engine.world.get('windmill-b').position },
          sparks: engine.describe().scene.unsaved.length, orphans: engine.describe().scene.orphans };
      }, [build.toString(), r.x, r.z]);
      check('after reload + load: native windmill (added after the load) gets its saved position; template one too', r2.pendingBefore.includes('windmill-a') && r2.a[0] === r.x + 5 && r2.a[2] === r.z + 2 && r2.b.x === r.x + 5 && r2.b.z === r.z - 2 && r2.saved === 'code', JSON.stringify(r2));
      check('the unsaved spark did not come back, as the warning said; no orphans', r2.sparks === 0 && r2.orphans.length === 0, JSON.stringify(r2));
    },
  },
  {
    name: 'Thing registry: engine.add cost (1000 adds; release path vs scene.add, dev with stacks)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const O = __threedogThree.Object3D, N = 1000, T = engine._things;
        const mk = () => Array.from({ length: N }, () => new O());
        const time = (list, f) => { const t0 = performance.now(); for (const o of list) f(o); return performance.now() - t0; };
        // best of 5 rounds: one GC pause must not decide the number
        let tPlain = Infinity, tRel = Infinity, tDev = Infinity;
        for (let k = 0; k < 5; k++) {
          const plain = mk(), rel = mk(), dev = mk();
          tPlain = Math.min(tPlain, time(plain, o => engine.scene.add(o)));
          tRel = Math.min(tRel, time(rel, o => { engine.scene.add(o); T.add(o, null, null); }));   // what a release build runs per add
          const s0 = T.stacks; T.stacks = 0;
          tDev = Math.min(tDev, time(dev, o => engine.add(o)));
          T.stacks = s0;
          for (const o of [...plain, ...rel, ...dev]) o.removeFromParent();
        }
        return { tPlain, tRel, tDev, per: { release: (tRel - tPlain) / N * 1000, dev: (tDev - tPlain) / N * 1000 } };
      });
      console.log(`    engine.add x1000: scene.add ${r.tPlain.toFixed(2)} ms, + registry ${r.tRel.toFixed(2)} ms, dev (stacks) ${r.tDev.toFixed(2)} ms; extra per add: release ${r.per.release.toFixed(2)} us, dev ${r.per.dev.toFixed(2)} us`);
      check('release registry cost stays small (< 5 us per add over scene.add)', r.per.release < 5, JSON.stringify(r));
    },
  },
];
