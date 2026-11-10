// engine.batching (core/stream/Batching.js): repeated static props drawn as one InstancedMesh per cell. Same style as the other files here.
// Uses the open-world example: 24 'rock' props placed in one 64 m cell next to the player (ids bt-<i>), plus 10 with batch: false.

/** Load the test props and wait until their models are built (prop models are async) */
async function setup() {
  const tick = () => new Promise(r => setTimeout(r, 0));
  engine.haltLoop();
  const W = engine.world, B = engine.batching, cs = B.cell, p = engine.player.position;
  const ox = Math.floor(p.x / cs) * cs, oz = Math.floor(p.z / cs) * cs, cell = `${ox / cs},${oz / cs}`;
  const props = [];
  for (let i = 0; i < 24; i++) props.push({ id: `bt-${i}`, model: 'rock', x: ox + 6 + (i % 6) * 9, z: oz + 6 + Math.floor(i / 6) * 9 });
  for (let i = 0; i < 10; i++) props.push({ id: `bt-off-${i}`, model: 'pine', batch: false, x: ox + 10 + i * 4, z: oz + 50 });
  engine.content.load({ props });
  for (let i = 0; i < 40 && (!W.view('bt-23') || !W.view('bt-off-9') || !W.ready); i++) { engine.step(0.1); await tick(); }
  engine.step(0.1);
  const batchOf = id => B.of(W.view(id))[0] ?? null;
  return { W, B, cell, batchOf, tick };
}

export const specs = [
  {
    // 不许绕开: unloading one block must not dispose the kit other blocks still draw (the renderer rebuilds all their state), and the last user must still free it
    name: '[guard] engine.remove: a geometry or material another object uses stays; it goes with its last user (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { try {
        engine.haltLoop();
        const T = __threedogThree, g = new T.BoxGeometry(), m = new T.MeshStandardMaterial(), solo = new T.BoxGeometry(), soloM = new T.MeshStandardMaterial();
        const seen = { g: 0, m: 0, solo: 0, soloM: 0 };
        g.addEventListener('dispose', () => seen.g++); m.addEventListener('dispose', () => seen.m++); solo.addEventListener('dispose', () => seen.solo++); soloM.addEventListener('dispose', () => seen.soloM++);
        const block = extra => { const b = new T.Group(); b.add(new T.Mesh(g, m), new T.Mesh(g, m)); if (extra) b.add(new T.Mesh(solo, soloM)); engine.add(b); return b; };
        const a = block(true), b = block(), c = block(), d = block();
        engine.remove(a);
        const first = { ...seen };
        await new Promise(r => setTimeout(r, 0));   // a new task: the count is made again
        engine.remove(b);
        const second = { ...seen };
        engine.remove(c, d);   // same call, the last users of the kit
        const last = { ...seen };
        const loose = new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial()); let looseFreed = 0; loose.geometry.addEventListener('dispose', () => looseFreed++);
        engine.remove(loose);   // never in the scene: disposed as before
        return { first, second, last, looseFreed };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      check('removing a block keeps the shared kit and frees only what was its own', r.first.g === 0 && r.first.m === 0 && r.first.solo === 1 && r.first.soloM === 1, JSON.stringify(r.first));
      check('the same in a later task', r.second.g === 0 && r.second.m === 0, JSON.stringify(r.second));
      check('the last users free the kit', r.last.g > 0 && r.last.m > 0, JSON.stringify(r.last));
      check('an object that was never in the scene is disposed', r.looseFreed === 1, String(r.looseFreed));
    },
  },
  {
    // 不许绕开: what made a block's arrival and departure expensive in the city run. A row of blocks must not unload inside one frame; unloading must not walk the whole scene
    // when batches hold the whole kit; one block leaving must not list every batched parent again
    name: '[guard] entry frames: unloads take turns in engine.jobs, no scene count for a held kit, skip list redone only for changed parents (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => { try {
        engine.haltLoop();
        const T = __threedogThree, S = engine.stream, B = engine.batching, was = S.radius, p = new T.Vector3(9000, 0, 9000), src = S.source(p, { physics: false });
        S.radius = 50;
        let unloaded = 0; const burn = () => { const end = performance.now() + 4; while (performance.now() < end); unloaded++; };   // longer than the jobs budget: one unload per frame
        const hs = []; for (let i = 0; i < 5; i++) hs.push(S.add({ position: [9000 + i, 0, 9000], radius: 1, build: () => new T.Group(), dispose: burn }));
        engine.step(1 / 30); engine.step(1 / 30);
        const built = hs.filter(h => h.built).length;
        p.x += 1000; S._update();
        const sameFrame = unloaded;
        engine.jobs.run({ deterministic: false });
        const oneTurn = unloaded;
        p.x -= 1000; S._update(); engine.jobs.run({ deterministic: false });   // the source came back: its turn finds the entry in range again
        const back = unloaded;
        p.x += 1000; engine.step(1 / 30); engine.step(1 / 30);   // a stepped frame still drains them
        const stepped = unloaded;
        for (const h of hs) h.remove();
        src.remove(); S.radius = was;
        const g = new T.BoxGeometry(), m = new T.MeshStandardMaterial(), roots = [];
        for (let i = 0; i < 12; i++) { const o = new T.Group(); o.userData.batch = true; o.position.set(9000 + i, 0, 0); o.add(new T.Mesh(g, m), new T.Mesh(g, m)); engine.add(o); roots.push(o); }
        engine.step(1 / 30); B.skip(); B.unskip();
        const kept = B.skips.get(roots[1]), held = B.held.has(g) && B.held.has(m);
        engine.remove(roots[0]);
        const scanned = !!engine._users;
        B.skip(); B.unskip();
        const same = B.skips.get(roots[1]) === kept && !!kept, gone = !B.skips.has(roots[0]);
        engine.remove(...roots.slice(1));
        return { built, sameFrame, oneTurn, back, stepped, held, scanned, same, gone };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      const s = JSON.stringify(r);
      check('entries were built', r.built === 5, s);
      check('going out of range unloads nothing inside the frame that noticed', r.sameFrame === 0, s);
      check('one jobs turn unloads what its budget allows, not the row', r.oneTurn >= 1 && r.oneTurn < 5, s);
      check('an entry whose source came back is not unloaded when its turn comes', r.back <= r.oneTurn + 1 && r.back < 5, s);
      check('engine.step still finishes the unloads (5, plus the one already gone that was rebuilt when the source came back)', r.stepped === 6, s);
      check('a kit held by batches is unloaded with no walk of the scene', r.held && !r.scanned, s);
      check('a root leaving relists only its own parent', r.same && r.gone, s);
    },
  },
  {
    // 不许绕开: the two costs the city run found. A block-sized root must not be checked mesh by mesh every frame, and three must not walk batched originals in the
    // draw; both while game code still sees the scene as built, and everything that is not batched still draws
    name: '[guard] batching: the default cell reaches across streamed blocks, so a model used a few times per block still batches (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { try {
        const { B } = await window.__bt();
        const T = __threedogThree, g = new T.BoxGeometry(0.3, 0.3, 0.3), m = new T.MeshStandardMaterial(), p = engine.player.position, step = engine.stream.cellSize, cs = B.cell, parts = [];
        const ox = Math.floor(p.x / cs) * cs, oz = Math.floor(p.z / cs) * cs;
        // one root per stream cell, three copies each: under minCount in every block, over it across the four. A default cell of one stream cell leaves all twelve plain
        for (let k = 0; k < 4; k++) {
          const root = new T.Group(); root.userData.batch = true; root.position.set(ox + 1 + k * step, p.y + 30, oz + 1);
          for (let i = 0; i < 3; i++) { const x = new T.Mesh(g, m); x.position.x = i; root.add(x); parts.push(x); }
          engine.scene.add(root);
        }
        engine.step(0.05); engine.step(0.05);
        const at = parts.map(x => B.of(x)[0]?.mesh ?? null);
        return { cell: cs, step, batched: at.filter(Boolean).length, batches: new Set(at).size };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      check('twelve copies over four stream cells become one batch', r.batched === 12 && r.batches === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] batching: big roots stay inside the per-frame check bound; batched originals skip the draw walk only (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { try {
        const { B } = await window.__bt();
        const T = __threedogThree, g = new T.BoxGeometry(0.3, 0.3, 0.3), m = new T.MeshStandardMaterial(), p = engine.player.position, roots = [], parts = [];
        let walked = 0, checked = 0, plainWalked = 0;
        const spy = x => { const w = x.updateMatrixWorld, c = x.updateWorldMatrix;
          x.updateMatrixWorld = function (f) { walked++; return w.call(this, f); }; x.updateWorldMatrix = function (a, b) { checked++; return c.call(this, a, b); }; };
        for (let k = 0; k < 4; k++) {
          const root = new T.Group(); root.userData.batch = true; root.position.set(p.x + k * 3, p.y + 30, p.z);
          for (let i = 0; i < 300; i++) { const x = new T.Mesh(g, m); x.position.set(i % 20 * 0.1, 0, Math.floor(i / 20) * 0.1); root.add(x); parts.push(x); }
          engine.scene.add(root); roots.push(root);
        }
        const plain = new T.Mesh(new T.BoxGeometry(0.3, 0.3, 0.3), new T.MeshStandardMaterial()); roots[0].add(plain);
        engine.step(0.05); engine.step(0.05);
        const batched = parts.every(x => B.of(x).length === 1) && B.of(plain).length === 0;
        for (const x of parts) spy(x);
        const pw = plain.updateMatrixWorld; plain.updateMatrixWorld = function (f) { plainWalked++; return pw.call(this, f); };
        engine.step(0.05);
        const frame = { walked, checked, plainWalked };
        const kids = roots[0].children.length, found = []; roots[0].traverse(o => { if (o.isMesh) found.push(o); });
        const late = new T.Mesh(new T.BoxGeometry(0.3, 0.3, 0.3), new T.MeshStandardMaterial()); let lateWalked = 0;
        const lw = late.updateMatrixWorld; late.updateMatrixWorld = function (f) { lateWalked++; return lw.call(this, f); }; roots[1].add(late);
        engine.step(0.05);
        const a = new T.Matrix4(), b = new T.Matrix4(), at = B.of(parts[0])[0];
        at.mesh.getMatrixAt(at.index, a); roots[0].position.x += 2; engine.step(0.05);
        const now = B.of(parts[0])[0]; now.mesh.getMatrixAt(now.index, b);
        const moved = b.elements[12] - a.elements[12];
        const part = parts[1000]; part.position.y += 1;   // a part changed behind batching's back: the slower lap still finds it
        let lap = 0; while (B.of(part).length && lap < 40) { engine.step(0.05); lap++; }
        const evicted = B.of(part).length === 0;
        for (const x of roots) engine.remove(x);
        engine.step(0.05);
        return { batched, frame, kids, found: found.length, lateWalked, moved, lap, evicted, left: [...B.skips.values()].filter(s => roots.includes(s.parent)).length, swapped: B.skipping };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      check('1200 meshes in 4 roots are batched, the odd one out is not', r.batched, JSON.stringify(r));
      check('a frame checks at most about one bound plus one root of meshes, not all 1200', r.frame.checked > 0 && r.frame.checked <= 600, JSON.stringify(r.frame));
      check('three does not walk batched originals in a frame', r.frame.walked === 0, JSON.stringify(r.frame));
      check('the plain mesh beside them is still walked', r.frame.plainWalked > 0, JSON.stringify(r.frame));
      check('after the frame the scene is as built (children and traverse)', r.kids === 301 && r.found === 301, JSON.stringify(r));
      check('a child added later to a root with batched meshes is walked in the next frame', r.lateWalked > 0, String(r.lateWalked));
      check('moving a root still moves its instances', Math.abs(r.moved - 2) < 1e-4, String(r.moved));
      check('a part moved by hand is still found by the round robin within a lap', r.evicted, JSON.stringify(r));
      check('removed roots leave the skip list, nothing stays swapped', r.left === 0 && r.swapped === false, JSON.stringify(r));
    },
  },
  {
    // 不许绕开: a game's own scene.add / engine.add meshes are never moved to layer 31 or drawn by an InstancedMesh unless userData.batch = true
    name: '[guard] batching: game-made meshes stay as made (layer 0, own Raycaster hits them); dev hint names the opt-in; userData.batch = true batches them (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { try {
        const { B } = await window.__bt();
        const T = __threedogThree, g = new T.BoxGeometry(0.4, 0.4, 0.4), m = new T.MeshStandardMaterial(), p = engine.player.position;
        const mine = [], opted = [];
        for (let i = 0; i < 12; i++) { const x = new T.Mesh(g, m); x.position.set(p.x + 3 + i * 0.6, p.y + 40, p.z + 3); (i % 2 ? engine.scene : engine).add(x); mine.push(x); }
        engine.step(0.05); engine.step(0.05);
        const rc = new T.Raycaster(new T.Vector3(mine[0].position.x, p.y + 60, mine[0].position.z), new T.Vector3(0, -1, 0));
        const own = { layer0: mine.every(x => x.layers.mask === 1 && !B.of(x).length), hit: rc.intersectObjects(engine.scene.children, true)[0]?.object === mine[0],
          hint: B.stats.hint ?? null, counted: B.plain.get(`${g.id}|${m.id}`)?.n ?? 0, perf: /userData\.batch = true/.test(engine.inspect.perf().text) };
        const g2 = new T.BoxGeometry(0.2, 0.2, 0.2);
        for (let i = 0; i < 12; i++) { const x = new T.Mesh(g2, m); x.position.set(p.x + 3 + i * 0.6, p.y, p.z + 5); x.userData.batch = true; engine.scene.add(x); opted.push(x); }
        engine.step(0.05); engine.step(0.05);
        const opt = { batched: opted.every(x => B.of(x).length === 1) };
        for (const x of [...mine, ...opted]) engine.remove(x);
        engine.step(0.05);
        return { own, opt, after: B.plain.has(`${g.id}|${m.id}`) };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      check('12 identical game meshes (scene.add and engine.add) are not batched: layer 0, no instance', r.own.layer0, JSON.stringify(r.own));
      check('a plain THREE.Raycaster over the scene hits the game mesh itself', r.own.hit, JSON.stringify(r.own));
      check('dev hint in batching.stats and inspect.perf() names userData.batch = true', r.own.counted === 12 && /userData\.batch = true/.test(r.own.hint) && r.own.perf, JSON.stringify(r.own));
      check('userData.batch = true opts game meshes in (batched)', r.opt.batched, JSON.stringify(r.opt));
      check('removed game meshes no longer count toward the hint', r.after === false, String(r.after));
    },
  },
  {
    name: 'batching: same-model props become one batch per cell; move / recolor / pick / remove one item; batch: false opt-out; shadows (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => { try {
        const { W, B, cell, batchOf } = await window.__bt();
        const b0 = batchOf('bt-0'), mine = B.batches.filter(b => b.cell === cell && b.items.includes(W.view('bt-0')));
        const same = Array.from({ length: 24 }, (_, i) => batchOf(`bt-${i}`)?.mesh).every(m => m && m === b0.mesh);
        const first = { ok: !!b0, isInstanced: !!b0?.mesh.isInstancedMesh, batches: mine.length, count: mine[0]?.count,
          cast: b0?.mesh.castShadow, receive: b0?.mesh.receiveShadow,
          meshHidden: (() => { let h = true; W.view('bt-0').traverse(o => { if (o.isMesh && o.visible && o.layers.test(engine.camera.layers)) h = false; }); return h; })(), same,
          inScene: (() => { let s = false; for (let o = b0?.mesh; o; o = o.parent) if (o === engine.scene) s = true; return s; })() };
        // opt-out
        const off = Array.from({ length: 10 }, (_, i) => W.view(`bt-off-${i}`));
        const optOut = { built: off.every(Boolean), none: off.every(o => o && !B.of(o).length), visible: off.every(o => { let v = false; o?.traverse(m => { if (m.isMesh && m.visible && m.layers.test(engine.camera.layers)) v = true; }); return v; }) };
        // move one inside a fixed step (gameplay changes go through fixed steps / ops)
        const at = W.get('bt-5').position, to = { x: at.x + 1.5, z: at.z + 1 };
        const h = engine.onFixed(() => { W.move('bt-5', to); h.remove(); }); engine.step(0.1);
        const s = batchOf('bt-5'), a = s.mesh.instanceMatrix.array, o = s.index * 16;
        const moved = { x: a[o + 12], z: a[o + 14], want: to, viewX: W.view('bt-5').position.x };
        // recolor
        B.tint(W.view('bt-7'), 0xff0000); engine.step(0.05);
        const t = batchOf('bt-7'), c = t.mesh.instanceColor.array.slice(t.index * 3, t.index * 3 + 3), other = batchOf('bt-8');
        const tint = { c: [...c], other: [...other.mesh.instanceColor.array.slice(other.index * 3, other.index * 3 + 3)] };
        // pick: the ray returns the original item, not the batch
        const pos = W.view('bt-5').position, hit = engine.raycast([to.x, pos.y + 30, to.z], [0, -1, 0]);
        let root = hit?.object; while (root && root.parent !== engine.scene) root = root.parent;
        const pick = { hit: !!hit, isItem: root === W.view('bt-5'), notBatch: !hit?.object.isInstancedMesh };
        // remove one
        const n0 = batchOf('bt-0').mesh.count, h2 = engine.onFixed(() => { W.remove('bt-9'); h2.remove(); }); engine.step(0.1);
        const removed = { before: n0, after: batchOf('bt-0').mesh.count, gone: !W.view('bt-9') };
        const d = engine.describe().perf.batching;
        return { first, optOut, moved, tint, pick, removed, describe: d };
      } catch (err) { return { err: String(err.stack) }; } });
      if (r.err) { check('runs without error', false, r.err); return; }
      check('24 same-model props in one cell: one InstancedMesh batch holding all of them, in the scene', r.first.ok && r.first.isInstanced && r.first.batches === 1 && r.first.count >= 24 && r.first.same && r.first.inScene, JSON.stringify(r.first));
      check('the placed object stays, its own meshes are hidden (drawn by the batch)', r.first.meshHidden, JSON.stringify(r.first));
      check('batch casts and receives shadows like the props', r.first.cast === true && r.first.receive === true, JSON.stringify(r.first));
      check('batch: false props are not batched and draw on their own', r.optOut.built && r.optOut.none && r.optOut.visible, JSON.stringify(r.optOut));
      check('world.move of one item moves its instance', Math.abs(r.moved.x - r.moved.want.x) < 1e-3 && Math.abs(r.moved.z - r.moved.want.z) < 1e-3, JSON.stringify(r.moved));
      check('tint recolors only that instance', r.tint.c[0] === 1 && r.tint.c[1] === 0 && r.tint.c[2] === 0 && r.tint.other.every(v => v === 1), JSON.stringify(r.tint));
      check('engine.raycast returns the item (its original mesh), not the batch', r.pick.hit && r.pick.isItem && r.pick.notBatch, JSON.stringify(r.pick));
      check('world.remove of one item takes its instance out', r.removed.gone && r.removed.after === r.removed.before - 1, JSON.stringify(r.removed));
      check('describe().perf.batching reports batches / instances / saved', r.describe && r.describe.batches >= 1 && r.describe.saved === r.describe.instances - r.describe.batches, JSON.stringify(r.describe));
    },
  },
  {
    name: 'batching: unloading a cell frees its batch, coming back rebuilds it; saves identical with batching on / off and after save-load; global switch (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { W, B, cell, batchOf, tick } = await window.__bt();
        const P = engine.player, home = P.position.clone();
        const here = () => B.batches.filter(b => b.cell === cell).length;
        const before = { batches: here(), mesh: batchOf('bt-0')?.mesh };
        P.placeAt({ x: home.x + 2000, z: home.z }); engine.step(3);
        const away = { batches: here(), view: !!W.view('bt-0'), data: !!W.get('bt-0'), freed: !before.mesh?.parent };
        P.placeAt({ x: home.x, z: home.z });
        for (let i = 0; i < 40 && !W.view('bt-23'); i++) { engine.step(0.1); await tick(); }
        engine.step(0.1);
        const back = { batches: here(), item: !!batchOf('bt-0') };
        // saves: batching never touches save data
        const c1 = JSON.stringify(engine.saves.collect().parts);
        B.enabled = false;
        const off = { batches: B.batches.length, shown: (() => { let v = false; W.view('bt-0').traverse(m => { if (m.isMesh && m.visible && m.layers.test(engine.camera.layers)) v = true; }); return v; })() };
        const c2 = JSON.stringify(engine.saves.collect().parts);
        B.enabled = true; engine.step(0.05);
        const on = { item: !!batchOf('bt-0') };
        // world.owed (near-sim bookkeeping) is left out: it drops the player entry on load with or without batching
        const parts = () => { const p = engine.saves.collect().parts; if (p.world) delete p.world.owed; return JSON.stringify(p); };
        const cs = parts();
        await engine.saves.save('bt-save');
        await engine.saves.load('bt-save');
        const c3 = parts();
        return { before: before.batches, away, back, off, on, same12: c1 === c2, same13: cs === c3, diff: (() => { const a = JSON.parse(cs), b = JSON.parse(c3), out = []; for (const k in a) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k + ': ' + JSON.stringify(a[k]).slice(0, 300) + ' VS ' + JSON.stringify(b[k]).slice(0, 300)); return out.join(' | '); })() };
      });
      check('cell near: has a batch', r.before >= 1, String(r.before));
      check('walk far: views torn down, the cell batch is freed (removed from the scene), data kept', r.away.batches === 0 && !r.away.view && r.away.data && r.away.freed, JSON.stringify(r.away));
      check('walk back: the batch is rebuilt', r.back.batches >= 1 && r.back.item, JSON.stringify(r.back));
      check('batching.enabled = false dissolves every batch and shows the originals; true batches again', r.off.batches === 0 && r.off.shown && r.on.item, JSON.stringify({ off: r.off, on: r.on }));
      check('save data identical with batching on and off', r.same12);
      check('save -> load round trip: save data identical', r.same13, r.diff);
    },
  },
  {
    // 不许绕开 (group V 5): hiding a Group between the root and a batched mesh hides it in the scene, so the batch must let go of it too
    name: '[guard] batching: a hidden Group between the root and a batched mesh takes the object out of its batch',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { B, tick } = await window.__bt();
        const T = __threedogThree, geo = new T.BoxGeometry(), mat = new T.MeshStandardMaterial(), p = engine.player.position, roots = [], subs = [];
        for (let i = 0; i < Math.max(B.minCount, 10) + 2; i++) {
          const root = new T.Group(), sub = new T.Group();   // root -> sub -> mesh
          root.userData.batch = true; root.position.set(p.x + 3 + i * 1.5, 0, p.z + 40); sub.add(new T.Mesh(geo, mat)); root.add(sub); engine.add(root); roots.push(root); subs.push(sub);
        }
        for (let i = 0; i < 6; i++) { engine.step(0.1); await tick(); }
        const before = B.of(roots[0]).length > 0;
        const warns = [], w0 = console.warn; console.warn = (...a) => { warns.push(String(a[0])); };
        subs[0].visible = false;
        for (let i = 0; i < 10; i++) { engine.step(0.1); await tick(); }
        const afterHide = B.of(roots[0]).length > 0, others = B.of(roots[1]).length > 0;
        subs[0].visible = true;   // group Q 1: hidden is not a change of the model: it rejoins when shown again, no eviction warning, geometry not banned
        for (let i = 0; i < 40; i++) { engine.step(0.1); await tick(); }
        const afterShow = B.of(roots[0]).length > 0, banned = B.banned.has(roots[0].children[0].children[0].geometry);
        console.warn = w0;
        engine.remove(...roots);
        return { before, afterHide, others, afterShow, banned, warns };
      });
      check('with the Group shown the object is in a batch, as are its neighbours', r.before && r.others, JSON.stringify(r));
      check('hiding the middle Group removes it from the batch', !r.afterHide, JSON.stringify(r));
      check('showing it again batches it again, no warning, geometry not banned', r.afterShow && !r.banned && !r.warns.length, JSON.stringify(r));
    },
  },
  {
    // group Q review: a part that changed while hidden is judged as at first tracking, not blindly rejoined
    name: '[guard] batching: a part hidden, given its own render order, then shown is not batched again',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { B, tick } = await window.__bt();
        const T = __threedogThree, geo = new T.BoxGeometry(), mat = new T.MeshStandardMaterial(), p = engine.player.position, roots = [], subs = [];
        for (let i = 0; i < Math.max(B.minCount, 10) + 2; i++) {
          const root = new T.Group(), sub = new T.Group();
          root.userData.batch = true; root.position.set(p.x + 3 + i * 1.5, 0, p.z + 40); sub.add(new T.Mesh(geo, mat)); root.add(sub); engine.add(root); roots.push(root); subs.push(sub);
        }
        for (let i = 0; i < 6; i++) { engine.step(0.1); await tick(); }
        const before = B.of(roots[0]).length > 0;
        const w0 = console.warn; console.warn = () => {};
        subs[0].visible = false;
        for (let i = 0; i < 10; i++) { engine.step(0.1); await tick(); }
        subs[0].children[0].renderOrder = 5;   // not batchable (a batch draws at one order); only _eligible notices, the group key and the live checks do not
        subs[0].visible = true;
        for (let i = 0; i < 40; i++) { engine.step(0.1); await tick(); }
        console.warn = w0;
        const after = B.of(roots[0]).length > 0;
        engine.remove(...roots);
        return { before, after };
      });
      check('batched before; after hide, a render order and show it is not in a batch', r.before && !r.after, JSON.stringify(r));
    },
  },
].map(s => ({ ...s, async run(ctx) { await ctx.ev(src => { window.__bt = new Function('return ' + src)(); }, setup.toString()); return s.run.call(this, ctx); } }));
