// Stage 1.11 step 5: props and pickups are data in world with stable ids, saved with the game. Same style as the other files here.
// Open-world example ('/') content: 8 pickups (respawn 120), 7 props (4 with collision). Id rules: `pickup:<item>:<index>`, `prop:<model name>:<index>`.
const READY = { timeout: 60000 };
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, READY); };

export const specs = [
  {
    name: 'S1 props: stable ids (index rule in content), same item at the same spot stays distinct, repeated loading does not duplicate, an id used by other data throws (open world)',
    url: '/?cutscene=skip',   // the opening cutscene takes over the camera (focus would not follow the player)
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, I = engine.inventory, p = engine.player.position, S = (item, at, o) => engine.pickups.spawn(at, { give: item, ...o });
        const pk = W.query({ kind: 'pickup' }).map(x => x.id), pr = W.query({ kind: 'prop' }).map(x => x.id);
        // two pickups of the same item at the same spot: each has its own id, taking one leaves the other
        const a = S('berry', [p.x + 3, 0, p.z], { id: 's1-a' }), b = S('berry', [p.x + 3, 0, p.z], { id: 's1-b' });
        const auto = S('berry', [p.x + 3, 0, p.z]);
        const again = S('berry', [p.x + 3, 0, p.z], { id: 's1-a' });   // same id is reused, not added
        a.remove();
        const sameSpot = { bStays: !!W.get('s1-b'), aGone: !W.get('s1-a'), auto: auto.id, again: again.id };
        let clash = null; try { S('feather', [0, 0, 0], { id: 's1-b' }); } catch (e) { clash = e.message; }
        // load the same content again: data is not duplicated
        const data = { props: [{ id: 's1-rock', model: 'rock', x: p.x + 6, z: p.z }, { model: 'rock', x: p.x + 7, z: p.z }], pickups: [{ item: 'berry', x: p.x + 6, z: p.z + 2 }] };
        const n0 = W.records.size;
        engine.content.load(data); const n1 = W.records.size;
        engine.content.load(data); const n2 = W.records.size;
        let clash2 = null; try { engine.content.load({ props: [{ id: 's1-rock', model: 'pine', x: 0, z: 0 }] }); } catch (e) { clash2 = e.message; }
        return { pk, pr, sameSpot, clash, n: [n0, n1, n2], clash2, ids: [...W.records.keys()].length === new Set(W.records.keys()).size };
      });
      check('content pickup id = pickup:<item>:<index>', r.pk.includes('pickup:feather:0') && r.pk.includes('pickup:berry:1') && r.pk.length === 8, JSON.stringify(r.pk));
      check('content prop id = prop:<model name>:<index> (models with params use the name)', r.pr.includes('prop:rock:3') && r.pr.includes('prop:flower:5') && r.pr.length === 7, JSON.stringify(r.pr));
      check('two of the same item at the same spot: each has an id, removing one leaves the other; no id means auto-numbered; spawning the same id again reuses it', r.sameSpot.bStays && r.sameSpot.aGone && /^pickup#\d+$/.test(r.sameSpot.auto) && r.sameSpot.again === 's1-a', JSON.stringify(r.sameSpot));
      check('id used by another item: throws and says to use a different id', /s1-b/.test(r.clash ?? '') && /different id/.test(r.clash), r.clash);
      check('same content loaded twice: data grows only once (3 records), ids do not collide', r.n[1] - r.n[0] === 3 && r.n[2] === r.n[1] && r.ids, JSON.stringify(r.n));
      check('prop id used by another model: throws and says to write a different id', /s1-rock/.test(r.clash2 ?? '') && /different id/.test(r.clash2), r.clash2);
    },
  },
  {
    name: 'S1 props: walking far removes model and collision, walking back rebuilds from data (picked-up ones are not rebuilt); respawn after pickup counts in game time (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const W = engine.world, P = engine.player, I = engine.inventory, home = P.position.clone();
        const solid = id => W.view(id)?.userData.colliders?.length ?? 0;
        engine.step(0.3);
        const before = { rock: !!W.view('prop:rock:3'), rockSolid: solid('prop:rock:3'), pine: !!W.view('prop:pine:0') };
        // pick one up (place one next to the player, go through interaction)
        const mine = engine.pickups.spawn([home.x + 1, 0, home.z], { give: 'berry', id: 's1-mine' }), n0 = I.count('berry');
        engine.step(0.3);
        const built = !!mine.object;
        engine.ops.run('interaction.use'); engine.step(0.2);
        const taken = { bag: I.count('berry') - n0, gone: !W.get('s1-mine'), noView: !mine.object };
        // with respawn: picking it up becomes a waiting record, it returns when time is up
        const resp = engine.pickups.spawn([home.x - 1, 0, home.z], { give: 'berry', id: 's1-resp', respawnSeconds: 30 });
        engine.step(0.3); engine.ops.run('interaction.use'); engine.step(0.2);
        const waiting = W.get('s1-resp')?.until != null && !resp.object;   // same record gets until written, show says no model
        P.placeAt({ x: home.x + 600, z: home.z }); engine.step(3);
        const away = { rock: !!W.view('prop:rock:3'), rockData: !!W.get('prop:rock:3'), pickupView: !!W.view('pickup:feather:0') };
        engine.step(35, { render: false });   // far away: 30 calendar seconds pass, the waiting pickup returns on time
        const wokeFar = !!W.get('s1-resp') && W.get('s1-resp').until == null;
        P.placeAt({ x: home.x, z: home.z }); engine.step(3); await tick();
        const back = { rock: !!W.view('prop:rock:3'), rockSolid: solid('prop:rock:3'), mine: !!W.get('s1-mine') || !!mine.object, resp: !!resp.object };
        return { before, built, taken, waiting, away, wokeFar, back };
      });
      check('at start: nearby props have models, those with collide have collision', r.before.rock && r.before.rockSolid === 1 && r.before.pine, JSON.stringify(r.before));
      check('pickup: goes into the bag, data deleted, model removed (models are built only when near)', r.built && r.taken.bag === 1 && r.taken.gone && r.taken.noView, JSON.stringify(r.taken));
      check('pickup with respawn: until is written after pickup, no model', r.waiting);
      check('walk far: prop models and collision removed, data stays, far pickups have no model', !r.away.rock && r.away.rockData && !r.away.pickupView, JSON.stringify(r.away));
      check('when time is up while far, waiting pickups still return (computed from data without a model)', r.wokeFar);
      check('walk back: props rebuilt from data (collision too); picked-up ones not rebuilt; respawned ones are back', r.back.rock && r.back.rockSolid === 1 && !r.back.mine && r.back.resp, JSON.stringify(r.back));
    },
  },
  {
    name: 'S1 props: pick up / move / remove → save → reopen the page and load, state unchanged (open world)',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      const mid = await ev(async () => {
        engine.haltLoop();
        const W = engine.world, P = engine.player, I = engine.inventory;
        const berry = W.get('pickup:berry:1'), x0 = W.get('prop:rock:3').position.x;
        P.placeAt({ x: berry.position.x + 0.5, z: berry.position.z }); engine.step(3);
        engine.ops.run('interaction.use'); engine.step(0.2);   // pick up the berry from the content
        const taken = W.get('pickup:berry:1')?.until != null;
        W.move('prop:rock:3', { x: x0 + 3, z: W.get('prop:rock:3').position.z });   // move
        W.remove('prop:pine:0');                                                      // remove
        const bag = I.count('berry');
        engine.saves.save('s1props');
        await engine.saves.flush();
        const json = engine.saves.export('s1props');
        return { taken, x0, bag, plain: !/"isObject3D"|"uuid"/.test(atob(json)) };
      });
      await reload(page);
      const r = await ev(async () => {
        const W = engine.world, before = { berry: W.get('pickup:berry:1')?.until == null, pine: !!W.get('prop:pine:0'), rockX: W.get('prop:rock:3').position.x };
        const ret = engine.saves.load('s1props'); if (ret?.then) await ret;
        engine.step(3); await new Promise(r => setTimeout(r, 0));
        const rock = W.get('prop:rock:3'), view = W.view('prop:rock:3');
        return { before, berry: W.get('pickup:berry:1')?.until != null, berryView: !!W.view('pickup:berry:1'), pine: !!W.get('prop:pine:0'), pineView: !!W.view('prop:pine:0'), rockX: rock.position.x, viewX: view?.position.x, solid: view?.userData.colliders.length,
          bag: engine.inventory.count('berry'), count: W.query({ kind: 'prop' }).length };
      });
      check('before saving: until is written after pickup (waiting for respawn); the save holds no three.js objects', mid.taken && mid.plain, JSON.stringify(mid));
      check('on reopening the page (before load) content loads again: berry, pine and rock in place', r.before.berry && r.before.pine && Math.abs(r.before.rockX - mid.x0) < 1e-6, JSON.stringify(r.before));
      check('load: the picked-up berry does not return (no data, no model), bag items restored', r.berry && !r.berryView && r.bag === mid.bag, JSON.stringify(r));
      check('load: the removed pine stays removed, the other props are all there (6)', !r.pine && !r.pineView && r.count === 6, JSON.stringify(r));
      check('load: the moved rock is at the new position, model and collision too', Math.abs(r.rockX - (mid.x0 + 3)) < 1e-6 && r.viewX !== undefined && Math.abs(r.viewX - r.rockX) < 1e-3 && r.solid === 1, JSON.stringify(r));
    },
  },
  {
    name: 'vegetation: with only openWorld() installed, chopped trees are saved, stay chopped after load, and regrow on time (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const V = engine.vegetation, t = V.instanceAt(engine.player.position, { radius: 60 });
        if (!t) return { none: true };
        const gone = () => V.isRemoved(t.species, t.cx, t.cz, t.id);
        V.removeInstance(t.species, t.cx, t.cz, t.id, { regrowSeconds: 30 });
        const k = V.key(t.species, t.cx, t.cz, t.id);
        const saved = JSON.parse(JSON.stringify(engine.saves.collect()));   // go through JSON like a real save
        const out = { hasWorldEdits: !!engine.worldEdits, inSave: typeof saved.parts.vegetation?.removed?.[k] === 'number' };
        V.restoreInstance(t.species, t.cx, t.cz, t.id);
        out.restored = !gone();
        engine.saves.apply(saved);
        out.afterLoad = gone();
        // drawn: the felled slot is drawn at zero scale in the picture's mesh
        const c = engine.terrain.chunks.get(t.cx + ',' + t.cz);
        const drawnGone = () => { const im = engine.vegetationDraw.mesh(c, t.species), i = im.userData.plants.ids.indexOf(t.id); return im.instanceMatrix.array.subarray(i * 16, i * 16 + 12).every(v => v === 0); };
        out.hiddenInView = c.hidden?.[t.species]?.size > 0 && drawnGone();
        engine.step(40, { render: false });   // regrows after 30 calendar seconds
        out.regrown = !gone() && !c.hidden?.[t.species] && !drawnGone();
        return out;
      });
      check('tree found', !r.none);
      check('no engine.worldEdits, chop records are in the vegetation save', r.hasWorldEdits === false && r.inSave, JSON.stringify(r));
      check('load: tree still chopped (record and view both)', r.restored && r.afterLoad && r.hiddenInView, JSON.stringify(r));
      check('regrows on time', r.regrown, JSON.stringify(r));
    },
  },
];
