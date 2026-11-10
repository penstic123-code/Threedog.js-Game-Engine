// Guards for gameplay modules (inventory transfers, world anchor, interaction ids...). Same format as the other files here.

export const specs = [
  {
    name: '[guard] content dialogue: line variants where no "if" holds and no plain fallback show an empty line with one warning (no TypeError, the dialogue goes on)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const D = engine.dialogue;
        engine.content.load({ dialogues: { fixv: { nodes: { start: { text: [{ if: { flag: 'never-set-flag' }, text: 'only if' }], next: 'end' }, end: { text: 'bye' } } } } });
        let err = null;
        const { warns } = await __t.warns(() => { try { D.start('fixv'); engine.step(0.5, { render: false }); } catch (e) { err = e.message; } });
        const out = { err, warns, active: !!D.active, full: D.full };
        D.end(); engine._unhalt();
        return out;
      });
      check('no error, the dialogue is open with an empty line', r.err === null && r.active && r.full === '', JSON.stringify(r));
      check('one warning names the node and the missing fallback [content-misuse]', r.warns.some(w => /dialogues\.fixv\.nodes\.start\.text/.test(w) && /content-misuse/.test(w)), JSON.stringify(r.warns));
    },
  },
  {
    name: 'gameplay guards: transfer can() counts free slots once; drop keeps the actor floor; grid fields cannot override the placement (open world) [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const I = engine.inventory, W = fn => engine.ops.allow(fn);
        I.define('g-sword', { name: 'sword', stack: 1 });
        const box = I.container('g-box', { capacity: 1 });
        W(() => { for (let i = 0; i < 3; i++) I.add('g-sword', 1, { data: { n: i }, silent: true }); });
        const can = engine.ops.can('inventory.transfer', { from: 'player', to: 'g-box', item: 'g-sword', n: 3 });
        const can1 = engine.ops.can('inventory.transfer', { from: 'player', to: 'g-box', item: 'g-sword', n: 1 });
        // drop: the pickup's reference height is the actor's y, not 0
        const p = engine.player.position, seen = [], P = engine.pickups, orig = P.spawn.bind(P);
        P.spawn = (at, o) => { seen.push(at[1]); return orig(at, o); };
        engine.ops.run('inventory.drop', { item: 'g-sword', n: 1 });
        P.spawn = orig;
        // grid.place: fields may not set id / kind / position
        let grid = null;
        if (engine.grids) {
          engine.grids.add('g-grid', { cell: 1, origin: { x: p.x, z: p.z }, size: [4, 4] });
          engine.grids.define('g-crate', { size: [1, 1] });
          grid = engine.ops.can('grid.place', { grid: 'g-grid', item: 'g-crate', cell: [0, 0], fields: { id: 'stolen' } });
        }
        return { can: can.ok ? true : can.code, can1: can1.ok, dropY: seen[0], py: p.y, grid };
      });
      check('3 entries into 1 free slot is refused as full; 1 is fine', r.can === 'full' && r.can1, JSON.stringify(r));
      check('drop passes the actor height as the floor reference', Math.abs(r.dropY - r.py) < 1e-6, JSON.stringify(r));
      check('grid.place refuses fields that set id (when grids is installed)', r.grid === null || r.grid.code === 'badFields', JSON.stringify(r));
    },
  },
  {
    name: 'gameplay guards: world.anchor takes [x, y, z] and refuses junk; grid layer data is read only in dev; openWorld({ vegetation: {...} }) and pickTarget({ range }) throw with the fix (open world) [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const w = engine.world, W = fn => engine.ops.allow(fn), out = {};
        const p = engine.player.position;
        w.simulate('g-near', { near: rec => { rec.hits = (rec.hits ?? 0) + 1; }, radius: 5 });
        W(() => w.add({ id: 'g-n1', kind: 'g-near', position: [p.x + 500, 0, p.z] }));
        w.anchor = [p.x + 500, 0, p.z];
        engine.step(0.2);
        out.nearHits = w.get('g-n1').hits ?? 0;
        w.anchor = null;
        try { w.anchor = 'home'; out.badAnchor = 'no throw'; } catch (err) { out.badAnchor = err.message; }
        if (engine.grids) {
          const g = engine.grids.get('g-l') ?? engine.grids.add('g-l', { cell: 1, origin: { x: 0, z: 0 }, size: [4, 4] });
          const soil = g.layer('g-soil');
          W(() => soil.set([1, 1], { wet: true }));
          try { soil.get([1, 1]).wet = false; out.frozen = 'writable'; } catch { out.frozen = 'frozen'; }
          W(() => soil.updateAll(d => { d.wet = 'x'; }));
          out.updated = soil.get([1, 1]).wet;
        }
        return out;
      });
      const { openWorld, pickTarget } = await import('../../index.js');   // pure option checks: run here in node
      try { openWorld({ camera: false, vegetation: { density: 2 } }); r.veg = 'no throw'; } catch (err) { r.veg = err.message; }
      try { pickTarget({ x: 0, z: 0 }, 0, [], { range: 5 }); r.range = 'no throw'; } catch (err) { r.range = err.message; }
      check('an [x, y, z] anchor simulates the records near it', r.nearHits > 5, JSON.stringify(r));
      check('a non-position anchor throws with the accepted forms', /world.anchor must be/.test(r.badAnchor), r.badAnchor);
      check('openWorld vegetation options throw and point to density', /vegetation takes no options/.test(r.veg) && /density/.test(r.veg), r.veg);
      check('pickTarget range throws and names radius', /radius/.test(r.range), r.range);
      check('layer data is frozen; updateAll still edits its copy', r.frozen === undefined || (r.frozen === 'frozen' && r.updated === 'x'), JSON.stringify(r));
    },
  },
  {
    name: 'gameplay guards: interaction ids are the record id for NPCs, pickups and template instances; the triggers debug toggle is declared without a key; flow.transition does not autosave by default (open world) [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const W = fn => engine.ops.allow(fn), p = engine.player.position;
        if (!engine.ops.defs.has('gBox.open')) engine.ops.define('gBox.open', { run: () => {} });
        engine.content.load({ templates: { gBox: { model: 'rock', interact: { label: 'open', op: 'gBox.open' } } } });
        const ent = W(() => engine.content.spawn('gBox', { x: p.x + 1, z: p.z }));
        const pick = W(() => engine.pickups.spawn({ x: p.x - 1, z: p.z }, { give: 'film', id: 'g-film' }));
        engine.world.refresh(); await engine.world.whenReady; engine.step(0.1);
        const ids = engine.interactions.items.map(i => i.id);
        let saved = 0;
        const off = engine.events.on('save:written', () => saved++);
        if (engine.flow) await engine.flow.transition(() => {}, { fade: 0.01 });
        off.remove();
        return { ent: ent.id, entIn: ids.includes(ent.id), pickIn: ids.includes(pick.id), npc: ids.some(id => engine.world.get(id)?.kind === 'npc'), npcs: engine.world.query({ kind: 'npc' }).length,
          triggerKey: engine.input.actions.has('triggersDebug'), saved, flow: !!engine.flow };
      });
      check('template instance and pickup interactions are named by their record id', r.entIn && r.pickIn && /^gBox#\d+$/.test(r.ent), JSON.stringify(r));
      check('triggers declare the debug toggle action (keyless: presets.bindings.debug binds F4)', r.triggerKey, JSON.stringify(r));
      check('transition saves nothing unless asked', !r.flow || r.saved === 0, JSON.stringify(r));
    },
  },
  {
    // 拾取物的形状和 content 的 props / 模板走同一个 protoOf：生成器只建一次、同几何共享、影子按同一套规则；文件模型也行；模块选项不给形状
    name: '[guard] pickups: the shape is a model name through the content model path (generator built once + shared + shadows, file model works); item mesh is gone',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const { THREE, toGLB } = threedogTest, I = engine.inventory, W = fn => engine.ops.allow(fn), p = engine.actorPosition();
        let n = 0;
        const url = URL.createObjectURL(new Blob([await toGLB(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial()))], { type: 'model/gltf-binary' })) + '#pk.glb';
        engine.assets.manifest({ name: 'pk-test', models: { pkGem: () => { n++; return new THREE.OctahedronGeometry(0.3, 0); }, pkFile: url } });
        I.define('pk-a', { name: 'a', model: 'pkGem', color: 0xff0000 }); I.define('pk-b', { name: 'b', model: 'pkGem', color: 0x00ff00 }); I.define('pk-c', { name: 'c', model: 'pkFile' });
        const ids = ['pk-a', 'pk-b', 'pk-c'].map((id, i) => W(() => engine.pickups.spawn({ x: p.x + 1 + i, z: p.z + 1 }, { give: id, id: 'pk-' + i })).id);
        engine.world.refresh(); engine.step(0.1);
        const inter = ids.every(id => engine.interactions.items.some(x => x.id === id));   // the interaction is there at once, before the model arrives
        await __t.until(() => ids.every(id => engine.world.view(id)?.children.length), 15000).catch(() => {});
        const meshes = id => { const s = []; engine.world.view(id)?.traverse(o => { if (o.isMesh) s.push(o); }); return s; };
        const [a, b, c] = ids.map(meshes);
        // vegetation's code API takes the same model name content does: same resolver, same cached geometry, no second build
        const sp = await engine.vegetation.define('pkVeg', { model: 'pkGem', rule: { perChunk: 0 } });
        // the species record keeps what it was made from in source; the picture draws it (the data / drawing split: vegetationDraw.kind)
        const veg = { same: !!sp && sp.source.geometry === a[0]?.geometry, drawn: engine.vegetationDraw.kind('pkVeg')?.geometry === a[0]?.geometry, builds: n };
        return { veg, n, inter, a: a.length, b: b.length, c: c.length, sameGeo: !!a[0] && a[0].geometry === b[0]?.geometry,
          colors: [a[0]?.material.color.getHex(), b[0]?.material.color.getHex()], role: a[0]?.material.userData?.purpose ?? null,
          shadow: [a[0]?.castShadow, a[0]?.receiveShadow, c[0]?.castShadow], viaCache: !!engine.assets._cachedSrc?.has('pkGem') };
      });
      check('[guard] a generator model name: built once for two items, geometry shared, through the cached path content uses', r.n === 1 && r.sameGeo && r.viaCache, JSON.stringify(r));
      check('a bare-geometry generator gets the item color per item (pickup material), and casts + receives shadows like a template', r.colors[0] === 0xff0000 && r.colors[1] === 0x00ff00 && r.shadow[0] && r.shadow[1], JSON.stringify(r));
      check('vegetation.define(name, { model: "pkGem" }) resolves the name like content: the same cached geometry, no second build', r.veg.same && r.veg.drawn && r.veg.builds === 1, JSON.stringify(r.veg));
      check('a file model name works for pickups (and casts by the same shadow rule)', r.c > 0 && r.shadow[2] === true, JSON.stringify(r));
      check('the pickup interaction exists at once (the model fills in later)', r.inter, JSON.stringify(r));
    },
  },
  {
    // guard for the shared xz index (core/stream/cells.js) under interactions: picks must equal a full scan of every item (fixed, following an Object3D, on a
    // moving NPC or pickup model, ties to the earlier added), and a pick must not measure every far item again (the index is not bypassed)
    name: '[guard] interactions index: nearest pick equals a full scan for fixed, followed, NPC and moved pickup items across 24 spots; a model moved far from its record is found where it stands; ties go to the earlier added; far items are not measured per pick',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const THREE = __threedogThree, I = engine.interactions, A = fn => engine.ops.allow(fn), h = engine.actorPosition().clone();
        engine.haltLoop();
        I.pickMode = 'nearest';
        engine.inventory.define('ix-berry', { name: 'berry' });
        const at = (i, k, r0, r1) => { const a = i * k, r = r0 + (i * 7919 % 97) / 97 * (r1 - r0); return { x: h.x + Math.cos(a) * r, z: h.z + Math.sin(a) * r }; };
        for (let i = 0; i < 300; i++) { const q = at(i, 2.39996, 2, 40); I.add({ x: q.x, y: engine.surface(q.x, q.z), z: q.z }, { id: 'ix-f' + i, label: 'f' }); }
        const followers = [];
        for (let i = 0; i < 20; i++) { const q = at(i, 1.3, 2, 30), o = new THREE.Object3D(); o.position.set(q.x, engine.surface(q.x, q.z), q.z); engine.scene.add(o); followers.push(o); I.add(o, { id: 'ix-o' + i, label: 'o' }); }
        const pk = [];
        for (let i = 0; i < 40; i++) { const q = at(i, 0.77, 2, 35); pk.push(A(() => engine.pickups.spawn(q, { give: 'ix-berry', id: 'ix-p' + i })).id); }
        for (let i = 0; i < 20; i++) { const q = at(i, 2.1, 3, 25); engine.npcs.add({ id: 'ix-n' + i, name: 'n' + i, behavior: 'wander', mind: { radius: 4 }, position: q, interact: { op: 'npc.talk' } }); }
        // two at the very same spot: the earlier added must win
        const tie = { x: h.x + 60, y: engine.surface(h.x + 60, h.z + 60), z: h.z + 60 }; I.add(tie, { id: 'ix-tie-a', label: 't' }); I.add(tie, { id: 'ix-tie-b', label: 't' });
        engine.world.refresh(); await engine.world.whenReady; engine.step(0.2);
        const P = new THREE.Vector3(), Q = new THREE.Vector3();
        const scan = () => {
          const p = engine.actorPosition(); P.set(p.x, p.y ?? 0, p.z);
          let best = null, bs = Infinity;
          for (const it of I.items) { const d = it.object.getWorldPosition(Q).distanceTo(P); if (d < it.radius && it.enabled(it.object, { actor: engine.actor }) && d < bs) { best = it; bs = d; } }
          return best?.id ?? null;
        };
        const diffs = [], seen = new Set();
        for (let k = 0; k < 24; k++) {
          const q = at(k, 2.7, 0, 30);
          followers.forEach((o, i) => { o.position.x += Math.sin(k + i) * 3; o.position.z += Math.cos(k + i) * 3; });
          A(() => engine.world.move(pk[k % pk.length], [q.x + 0.6, engine.surface(q.x + 0.6, q.z), q.z]));   // a pickup record moves next to the spot
          engine.player.placeAt(q); engine.step(1 / 30);
          const got = I.pick()?.id ?? null, want = scan();
          if (got) seen.add(got.replace(/\d+$/, ''));
          if (got !== want) diffs.push({ k, got, want });
        }
        engine.player.placeAt({ x: tie.x, z: tie.z }); engine.step(1 / 30);
        const tieGot = I.pick()?.id;
        // a record's model the game moved far from its record (the record stays): the item is found where the model stands, without a step in between
        const mid = pk.find(id => engine.world.view(id)), pv = engine.world.view(mid), away = { x: h.x - 45, z: h.z - 45 };
        pv.position.set(away.x + 0.4, engine.surface(away.x + 0.4, away.z), away.z);
        engine.player.placeAt(away);
        const moved = { got: I.pick()?.id ?? null, want: scan(), rec: engine.world.get(mid).position.x - pv.position.x, mid };
        // far from everything except the tie: a pick measures the followed objects and what the index finds near, not the 380 others
        let calls = 0; const gw = THREE.Object3D.prototype.getWorldPosition;
        THREE.Object3D.prototype.getWorldPosition = function (t) { calls++; return gw.call(this, t); };
        try { I.pick(); } finally { THREE.Object3D.prototype.getWorldPosition = gw; }
        return { diffs, seen: [...seen], tieGot, calls, moved };
      });
      check('nearest pick equals a full scan at every spot (fixed, followed, NPC, moved pickup)', r.diffs.length === 0, JSON.stringify(r.diffs));
      check('the spots really hit several kinds of item', r.seen.length >= 3, JSON.stringify(r.seen));
      check('a pickup model moved 45+ m from its record is found where it stands (same as a full scan)', r.moved.got === r.moved.want && r.moved.want === r.moved.mid && Math.abs(r.moved.rec) > 2, JSON.stringify(r.moved));
      check('a tie goes to the earlier added', r.tieGot === 'ix-tie-a', JSON.stringify(r));
      check('a pick far from the crowd measures only followed objects and nearby candidates', r.calls <= 25, String(r.calls));
    },
  },
  {
    name: '[guard] gameplay read: a part-fit pickup leaves the rest, a saved seat drives again, wander and placeAt drop stale paths, a line listener may end the dialogue, a late items list refills, a short rigid save is refused, newGame frees NPC names (open world)',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const e = engine, I = e.inventory, W = e.world, R = e.rigid, A = fn => e.ops.allow(fn), out = {}, step = s => e.step(s, { render: false, describe: false });
        const { x, y, z } = e.player.position, at = [x, y, z];

        I.define('gr-arrow', { name: 'arrow', stack: 5, weight: 1 });
        const bag = I.of(); bag.maxWeight = bag.weight + 3;
        e.pickups.spawn(at, { give: 'gr-arrow', count: 5, id: 'gr-pick', radius: 5 });
        const took = e.ops.run('pickup.take', { id: 'gr-pick' });
        out.pick = { ok: took.ok, got: I.count('gr-arrow'), left: W.get('gr-pick')?.count };
        bag.maxWeight = Infinity;

        const npc = A(() => e.npcs.add({ id: 'gr-w', behavior: 'wander', mind: { radius: 30, pause: [0, 0] }, position: [x + 4, 0, z + 4] }));
        W.refresh(); step(0.1);
        const rec = W.get('gr-w'), old = [{ x: 9999, z: 9999 }];
        rec.mind.target = null; rec.mind.wait = 0; rec.nav.path = old;
        step(1 / 60);
        out.wander = { built: !!npc.character, kept: rec.nav.path === old };

        const s = A(() => e.npcs.add({ id: 'gr-s', position: [x + 6, 0, z - 4], schedule: [{ at: 0, position: [x + 30, 0, z - 4] }] }));
        W.refresh();
        let req = null;
        for (let i = 0; i < 30 && !req; i++) { step(1 / 60); req = s.character?._pathReq ?? null; }
        A(() => s.placeAt([x + 6, 0, z + 6]));
        out.placeAt = { asked: !!req, dropped: !!req?.canceled && s.character._pathReq === null };

        e.dialogue.define('gr-d', { start: { text: 'hi', next: 'end' } });
        const off = e.events.on('dialogue:line', () => e.dialogue.end());
        try { A(() => e.dialogue.start('gr-d')); out.dialogue = !e.dialogue.active; } catch (err) { out.dialogue = err.message; }
        off.remove();

        A(() => { I._containers.load({ 'gr-late': [] }); I.container('gr-late', { items: { 'gr-arrow': 2 } }); I._containers.load({}); });
        out.refill = I.container('gr-late').count('gr-arrow');

        try { R._loadState({ 'gr-short': [1, 2] }); out.short = 'loaded'; } catch (err) { out.short = err.code ?? err.message; }

        const src = R.bodies.find(b => b.mesh?.isMesh).mesh, car = R.addWheeled(new src.constructor(src.geometry, src.material), { id: 'gr-car', wheels: [{ position: [-1, 0, 1.5], radius: 0.35, steer: true }, { position: [1, 0, 1.5], radius: 0.35, steer: true }, { position: [-1, 0, -1.5], radius: 0.35, drive: true }, { position: [1, 0, -1.5], radius: 0.35, drive: true }] });
        A(() => { e.characters.removePlayer(); W.add({ id: 'player', kind: 'player', position: at, vehicle: 'gr-car' }); });
        const p = e.characters.addPlayer({ control: 'camera', cameraFollow: true });
        out.car = { seated: p.vehicle === car, keys: e.input.holders.some(h => h.context === 'vehicle'), camera: e.cameraRig?.target === car.mesh };
        A(() => { p.exit(); car.remove(); });

        A(() => e.npcs.add({ name: 'gr-bob', position: [x + 8, 0, z] }));
        await e.session.newGame();
        try { A(() => e.npcs.add({ name: 'gr-bob', position: [x + 8, 0, z] })); out.again = true; } catch (err) { out.again = err.message; }
        return out;
      });
      check('a bag with room for 3 of 5 takes 3 and 2 stay on the ground', r.pick.ok && r.pick.got === 3 && r.pick.left === 2, JSON.stringify(r.pick));
      check('a wander NPC picking a new target drops what is left of the old path', r.wander.built && !r.wander.kept, JSON.stringify(r.wander));
      check('npc.placeAt drops a path answer still on its way', r.placeAt.asked && r.placeAt.dropped, JSON.stringify(r.placeAt));
      check('a dialogue:line listener may end the dialogue', r.dialogue === true, String(r.dialogue));
      check('a container a load made first gets its items list: a save without it refills it', r.refill === 2, String(r.refill));
      check('a rigid body state of the wrong length is refused', r.short === 'save-bad-record', String(r.short));
      check('a player created from a record in a car gets the driving keys and the camera', r.car.seated && r.car.keys && r.car.camera, JSON.stringify(r.car));
      check('newGame frees the names: setup adding them again is no same-name error', r.again === true, String(r.again));
    },
  },
];
