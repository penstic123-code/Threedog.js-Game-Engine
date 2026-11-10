// [guard] A write to a record is never silently lost, whoever solves that record (design.md section 9). The record is not the authority for a seated rider, a
// live character's facing and size or a rigid body, so each write has to reach the one that is:
//   - a seat keeps its rider: a placement of a rider ends the ride, so the rider stands where it was put (a turn it cannot obey is refused by name)
//   - a live character owns its facing and size: rot and scale go to it through the same world write as position, and come back after a rebuild or a load
//   - a body owns its pose: a write to its record goes to the body, whichever way the model was made (a template body, or present + rigid.addBox)
// Run: threedog test "Record writes"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Record writes: a seated rider is placed by world.move, world.set, thing.set and placeAt, never pulled back by the seat',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'rw-seat');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const car = () => ({ object: new THREE.Object3D(), speed: 0, driver: null, seats: 2, hideDriver: false, passengers: [], braked: 0,
          drive(t, s, b) { this.braked += b; }, seatPosition: s => ({ x: 20 + s, y: 0, z: 20 }), exitPosition: () => ({ x: 18, y: 0, z: 20 }) });
        const P = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: { x: 0, z: 0 } });
        const npc = E.npcs.add({ id: 'rw-npc', name: 'Rider', position: { x: 4, z: 0 } });
        steps(2);
        const left = []; E.events.on('vehicle:exit', ({ character }) => left.push(character.id));
        const at = c => [c.root.position.x, c.root.position.z], rec = id => { const p = E.world.get(id).position; return [p.x, p.z]; };
        const seat = (who, v) => { who.enter(v); steps(2); };
        const ways = {
          move: () => E.ops.allow(() => E.world.move('player', { x: 5, z: 6 })),
          set: () => E.ops.allow(() => E.world.set('player', { position: [5, 0, 6] })),
          thing: () => E.ops.run('thing.set', { id: 'player', position: [5, 0, 6] }),
          placeAt: () => P.placeAt({ x: 5, z: 6 }),
        };
        out.ways = {};
        for (const [name, write] of Object.entries(ways)) {
          const v = car(); seat(P, v);
          const seated = at(P)[0] === 20 && P.vehicle === v;
          const res = write(); steps(5);
          out.ways[name] = { seated, ok: res?.ok ?? true, root: at(P), rec: rec('player'), vehicle: P.vehicle === null, freed: v.driver === null, braked: v.braked > 0, rec2: E.world.get('player').vehicle };
          P.placeAt({ x: 0, z: 0 });
        }
        out.left = left.length;
        // following the seat is no placement: a write that agrees leaves the rider in
        const v = car(); seat(P, v);
        E.ops.allow(() => E.world.move('player', { ...E.world.get('player').position })); steps(3);
        out.agrees = P.vehicle === v;
        P.exit();
        // an NPC goes through its own placeAt (its path is dropped too), and the second seat is freed
        const ch = npc.character, v2 = car(); seat(P, v2); seat(ch, v2);
        out.npcSeat = ch.seat;
        E.ops.allow(() => E.world.move('rw-npc', { x: 7, z: 3 })); steps(3);
        out.npc = { root: at(ch), rec: rec('rw-npc'), off: ch.vehicle === null, passengers: v2.passengers.length, driver: P.vehicle === v2 };
        // far from the anchor the record rules, but the seat would still take the rider back when it comes near
        seat(ch, v2);
        E.world.anchor = { x: 3000, z: 0 }; steps(90);
        out.farStays = { far: !E.world._s.isNear('rw-npc'), in: ch.vehicle === v2 };   // a far step lets the model catch up with its data: that is no placement
        E.ops.allow(() => E.world.move('rw-npc', { x: 9, z: 3 }));
        E.world.anchor = null; steps(5);
        out.farRider = { live: !!npc.character, off: ch.vehicle === null, rec: rec('rw-npc') };
        E.dispose();
        return out;
      });
      for (const [name, w] of Object.entries(r.ways)) check(`${name}: the rider stands where it was put, out of the vehicle, the record says the same`,
        w.seated && w.ok && w.root.join() === '5,6' && w.rec.join() === '5,6' && w.vehicle && w.freed && w.braked && w.rec2 == null, J(w));
      check('each placement left the vehicle the one way out: one vehicle:exit each', r.left === 4, J(r.left));
      check('a write that agrees with the seat keeps the rider in', r.agrees, J(r.agrees));
      check('an NPC passenger is placed too: off its seat, the driver stays', r.npcSeat === 1 && r.npc.root.join() === '7,3' && r.npc.rec.join() === '7,3' && r.npc.off && r.npc.passengers === 0 && r.npc.driver, J(r.npc));
      check('far steps leave a rider on its seat', r.farStays.far && r.farStays.in, J(r.farStays));
      check('a far seated rider is placed as well: the seat does not take the write back on its way near', r.farRider.off && r.farRider.rec.join() === '9,3', J(r.farRider));
    },
  },
  {
    name: '[guard] Record writes: rot and scale reach a live character through the record write, survive a rebuild and a load, undo; what it cannot obey is refused by name',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'rw-pose');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const P = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: { x: 0, z: 0 } });
        const npc = E.npcs.add({ id: 'rw-n', name: 'Stander', position: { x: 4, z: 0 } });
        steps(2);
        const pose = c => ({ facing: c.facing, y: c.root.rotation.y, s: c.root.scale.toArray() });
        const args = { id: 'player', rotation: 1.2, scale: 2 }, res = E.ops.run('thing.set', args);
        steps(5);
        out.set = { ok: res.ok, ...pose(P), recFacing: E.world.get('player').facing, recRot: E.world.get('player').rot, recScale: E.world.get('player').scale };
        E.ops.undo('thing.set', args, res.value); steps(2); out.undone = pose(P);
        out.array = E.ops.run('thing.set', { id: 'player', rotation: [0, 0.5, 0], scale: [1, 2, 1] }).ok; steps(2); out.arrayPose = pose(P);
        const before = pose(P), tilted = E.ops.run('thing.set', { id: 'player', rotation: [0.4, 0.9, 0] }); out.tilted = { ok: tilted.ok, code: tilted.code, why: JSON.stringify(tilted).slice(0, 300), same: JSON.stringify(pose(P)) === JSON.stringify(before), rec: E.world.get('player').rot };
        try { E.ops.allow(() => E.world.set('player', { rot: [0, 1, 0.2] })); } catch (x) { out.tiltThrown = x.code; }
        // an NPC with a model: the facing lands in its saved motion, so a rebuilt model has it; the size lives on the record
        E.ops.run('thing.set', { id: 'rw-n', rotation: 0.7, scale: 3 }); steps(3);
        out.npc = pose(npc.character);
        const old = npc.character;
        E.world.anchor = { x: 3000, z: 0 }; E.focus.set(3000, 0, 0); P.root.position.x = 3000; P.syncRecord(); steps(3); E.world.refresh(); steps(1);
        out.torn = !npc.character;
        // written while it has no model: waits on the record until the model is built
        E.ops.run('thing.set', { id: 'rw-n', rotation: -0.4 }); steps(1);
        E.world.anchor = null; E.focus.set(0, 0, 0); P.root.position.x = 0; P.syncRecord(); steps(3); E.world.refresh(); steps(3);
        out.rebuilt = npc.character && npc.character !== old ? pose(npc.character) : null;
        out.rebuiltRot = E.world.get('rw-n').rot;
        // a seat turns its rider: refused, not lost
        const v = { object: new THREE.Object3D(), speed: 0, driver: null, hideDriver: false, passengers: [], drive() {}, seatPosition: () => ({ x: 1, y: 0, z: 1 }), exitPosition: () => ({ x: 2, y: 0, z: 1 }) };
        P.enter(v); steps(2);
        const turned = E.ops.run('thing.set', { id: 'player', rotation: 2 }); out.seated = { ok: turned.ok, why: JSON.stringify(turned).slice(0, 300), in: P.vehicle === v };
        out.seatScale = E.ops.run('thing.set', { id: 'player', scale: 1.5 }).ok && P.vehicle === v && P.root.scale.x === 1.5;
        P.exit();
        // a load puts the written size back, and a save without one takes it off again
        const saved = E.saves.collect();
        E.ops.allow(() => E.world.set('player', { scale: 4 })); out.four = P.root.scale.x;
        await E.saves.apply(saved); steps(2); out.loaded = P.root.scale.x;
        E.dispose();
        return out;
      });
      check('thing.set turns and scales the player, and it holds', r.set.ok && r.set.facing === 1.2 && r.set.y === 1.2 && r.set.s.join() === '2,2,2' && r.set.recFacing === 1.2 && r.set.recScale === 2, J(r.set));
      check('the record keeps no second facing beside the character', r.set.recRot === undefined, J(r.set));
      check('undo gives back the facing and size it had', r.undone.facing === 0 && r.undone.s.join() === '1,1,1', J(r.undone));
      check('an array works: yaw of [x, y, z], one size per axis', r.array && r.arrayPose.facing === 0.5 && r.arrayPose.s.join() === '1,2,1', J(r.arrayPose));
      check('a tilt a character cannot take is refused by name, nothing written', r.tilted.ok === false && /tilt|upright|about x or z/i.test(r.tilted.why) && r.tilted.same && r.tilted.rec === undefined, J(r.tilted));
      check('world.set throws the same refusal', r.tiltThrown === 'character-option', J(r.tiltThrown));
      check('an NPC with a model turns and scales', r.npc.facing === 0.7 && r.npc.s.join() === '3,3,3', J(r.npc));
      check('the rebuilt model has the size from the record and the turn written while it had none', r.torn && r.rebuilt?.facing === -0.4 && r.rebuilt.s.join() === '3,3,3' && r.rebuiltRot === undefined, J([r.torn, r.rebuilt, r.rebuiltRot]));
      check('a rider cannot be turned: refused by name, still seated', r.seated.ok === false && /seat/i.test(r.seated.why) && r.seated.in, J(r.seated));
      check('a rider can be scaled in its seat', r.seatScale, J(r.seatScale));
      check('a load gives the saved size back', r.four === 4 && r.loaded === 1.5, J([r.four, r.loaded]));
    },
  },
  {
    name: '[guard] Record writes: a write to a physics body record moves the body, one way for template bodies and present + rigid, position, rot and scale',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'rw-body');
        E.use(T.world(), T.collision(), T.content(), T.rigid());
        await E.start(); E.haltLoop();
        const steps = async n => { for (let i = 0; i < n; i++) { E.step(1 / 60, { render: false, describe: false }); await new Promise(res => setTimeout(res, 0)); } };
        E.assets.manifest({ name: 'rw', models: { rwBox: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()) } });
        E.content.load({ templates: { rwCrate: { model: 'rwBox', body: { shape: 'box', mass: 1 } } }, props: [{ id: 'rw-t', template: 'rwCrate', x: 4, z: 4 }] });
        // the same thing by hand: a game's own present with a body on the model
        E.world.present('rwHand', { positionFrom: 'view', build(rec) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.position.set(rec.position.x, rec.position.y, rec.position.z);
          E.add(m); m.userData.body = E.rigid.addBox(m, { mass: 1 }); return m;
        }, dispose(rec, o) { o.userData.body.remove(); E.remove(o); } });
        E.ops.allow(() => E.world.add({ id: 'rw-h', kind: 'rwHand', position: [-4, 0.5, 4] }));
        for (let i = 0; i < 60 && !(E.world.view('rw-t') && E.world.view('rw-h')); i++) await steps(1);
        await steps(30);
        const all = id => { const o = E.world.view(id), b = E.rigid.bodies.find(x => x.mesh === o), t = b.body.translation(), p = E.world.get(id).position; return { rec: [p.x, p.z], view: [o.position.x, o.position.z], body: [t.x, t.z] }; };
        const moved = (v, x, z) => [v.rec, v.view, v.body].every(a => Math.abs(a[0] - x) < 0.05 && Math.abs(a[1] - z) < 0.05);
        const ways = {
          move: (id, z) => E.ops.allow(() => E.world.move(id, { x: 9, z })),
          set: (id, z) => E.ops.allow(() => E.world.set(id, { position: { x: 10, y: E.world.get(id).position.y, z } })),
          thing: (id, z) => E.ops.run('thing.set', { id, position: { x: 11, z } }),
          direct: (id, z) => { const p = E.world.get(id).position; p.x = 12; p.z = z; },
        };
        const to = { move: 9, set: 10, thing: 11, direct: 12 };
        out.ways = {};
        for (const id of ['rw-t', 'rw-h']) for (const [name, write] of Object.entries(ways)) {
          const z = id === 'rw-t' ? 9 : -9;   // apart: the two crates must not land on each other
          write(id, z); await steps(20);
          const v = all(id); out.ways[`${id} ${name}`] = { ok: moved(v, to[name], z), v };
        }
        // moved and pushed in one step: the write wins, then the body carries on from there
        const hb = E.rigid.bodies.find(x => x.mesh === E.world.view('rw-h'));
        hb.body.setLinvel({ x: 5, y: 0, z: 0 }, true); E.ops.allow(() => E.world.move('rw-h', { x: -8, z: -8 })); await steps(1);
        out.calm = { v: all('rw-h'), speed: hb.body.linvel().x };
        // a pushed body still follows the solver afterwards: the record keeps following the body
        hb.body.applyImpulse({ x: 3, y: 0, z: 0 }, true); await steps(10); out.pushed = all('rw-h');
        // template body: rot and scale reach the body too, the moved crate stays in the save
        const o0 = E.world.view('rw-t');
        const res = E.ops.run('thing.set', { id: 'rw-t', rotation: 0.8, scale: 2 });
        for (let i = 0; i < 40 && E.world.view('rw-t') === o0; i++) await steps(1);
        await steps(30);
        const o = E.world.view('rw-t'), b = E.rigid.bodies.find(x => x.mesh === o);
        const q = b?.body.rotation(), yaw = q ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w), 'YXZ').y : null;
        const he = b?.collider.halfExtents();
        out.pose = { ok: res.ok, rebuilt: o !== o0, yaw, half: he?.x, scale: o.scale.x, at: all('rw-t') };
        out.saved = E.saves.collect().parts.world.changed?.['rw-t'] ?? null;
        E.dispose();
        return out;
      });
      for (const [name, w] of Object.entries(r.ways)) check(`${name}: record, model and body all stand there`, w.ok, J(w.v));
      check('a write beats a push in the same step: the body starts from the write, at rest', Math.abs(r.calm.v.body[0] + 8) < 0.05 && Math.abs(r.calm.speed) < 0.01, J(r.calm));
      check('the body stays the authority: a later push moves model and record', Math.abs(r.pushed.body[0] - r.pushed.rec[0]) < 1e-6 && r.pushed.body[0] > -8 + 0.1, J(r.pushed));
      check('rot and scale reach a template body: its model is built again, the solver has the new turn and size', r.pose.ok && r.pose.rebuilt && Math.abs(r.pose.yaw - 0.8) < 0.02 && r.pose.scale === 2 && r.pose.half > 0.9, J(r.pose));
      check('the crate stays where it was put', Math.abs(r.pose.at.body[0] - 12) < 0.3, J(r.pose.at));
      check('and the save has it there', Math.abs(r.saved?.set?.position?.x - 12) < 0.3 && r.saved.set.rot === 0.8 && r.saved.set.scale === 2, J(r.saved));
    },
  },
  {
    name: '[guard] Record writes: undo of a placement that ended a ride puts the rider back in its seat; a seat gone or taken is refused by name',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'rw-undo');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const car = () => { const object = new THREE.Object3D(); E.add(object); return { object, speed: 0, driver: null, seats: 3, hideDriver: false, passengers: [],
          drive() {}, seatPosition: s => ({ x: 20 + s, y: 0, z: 20 }), exitPosition: () => ({ x: 18, y: 0, z: 20 }) }; };
        const P = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: { x: 0, z: 0 } });
        const A = E.npcs.add({ id: 'rw-a', name: 'A', position: { x: 4, z: 0 } }), B = E.npcs.add({ id: 'rw-b', name: 'B', position: { x: 4, z: 3 } });
        steps(2);
        const a = A.character, b = B.character, place = id => { const args = { id, position: [5, 0, 6] }; return { args, res: E.ops.run('thing.set', args) }; };
        const undo = (id, w) => E.ops.undo('thing.set', w.args, w.res.value);
        const seen = id => { const p = E.world.get(id).position; return [p.x, p.z]; };
        // the driver: seat, record, the vehicle's driver and the record's vehicle field all come back, at once
        const v = car(); v.id = 'rw-car'; P.enter(v); steps(2);
        const w1 = place('player'); steps(3); const off = P.vehicle;
        const u1 = undo('player', w1);
        out.back = { ok: u1.ok, off: off === null, in: P.vehicle === v, seat: P.seat, driver: v.driver === P, rec: seen('player'), car: E.world.get('player').vehicle };
        steps(3); out.backLater = { root: P.root.position.x, in: P.vehicle === v };
        // a passenger gets its own seat, not the driver's seat that fell free
        a.enter(v); b.enter(v); steps(2); out.seats = [a.seat, b.seat];
        const w2 = place('rw-b'); steps(2); P.exit(); steps(1);
        const u2 = undo('rw-b', w2); out.passenger = { ok: u2.ok, seat: b.seat, driver: v.driver === null, rec: seen('rw-b') };
        a.exit(); b.exit();
        // taken: someone sits there now
        const v2 = car(); P.enter(v2); steps(1);
        const w5 = place('player'); steps(1); a.enter(v2); steps(1);
        const before5 = P.root.position.x, u5 = undo('player', w5); steps(2);
        out.taken = { ok: u5.ok, code: u5.code, why: u5.facts?.why, still: P.vehicle === null && P.root.position.x === before5 };
        a.exit();
        // gone: the vehicle was removed, or left the scene
        const v3 = car(); P.enter(v3); steps(1); const w6 = place('player'); steps(1); v3.gone = true;
        const u6 = undo('player', w6); out.gone = { ok: u6.ok, code: u6.code, why: u6.facts?.why, off: P.vehicle === null };
        const v4 = car(); P.enter(v4); steps(1); const w7 = place('player'); steps(1); E.remove(v4.object);
        const u7 = undo('player', w7); out.left = { ok: u7.ok, code: u7.code, off: P.vehicle === null };
        // it sits somewhere else by now
        const v5 = car(), v6 = car(); P.enter(v5); steps(1); const w8 = place('player'); steps(1); P.enter(v6); steps(1);
        const u8 = undo('player', w8); out.other = { ok: u8.ok, code: u8.code, in: P.vehicle === v6 };
        P.exit();
        // a refused undo did nothing: the revision says so
        const rev = E.ops.revision, keep = undo('player', w6); out.quiet = E.ops.revision === rev && !keep.ok;
        out.json = (() => { try { return JSON.stringify(w1.res.value).length > 0; } catch { return false; } })();
        E.dispose();
        return out;
      });
      check('undo seats the driver again at once: seat, driver, record and its vehicle field', r.back.ok && r.back.off && r.back.in && r.back.seat === 0 && r.back.driver && r.back.rec.join() === '20,20' && r.back.car === 'rw-car', J(r.back));
      check('and it stays on the seat', r.backLater.in && r.backLater.root === 20, J(r.backLater));
      check('a passenger goes back to its own seat, not the free driver seat', r.seats.join() === '1,2' && r.passenger.ok && r.passenger.seat === 2 && r.passenger.driver && r.passenger.rec.join() === '22,20', J([r.seats, r.passenger]));
      check('a taken seat is refused by name, the character stays where it stands', r.taken.ok === false && r.taken.code === 'ownerRefuses' && /taken/i.test(r.taken.why) && r.taken.still, J(r.taken));
      check('a removed vehicle is refused by name', r.gone.ok === false && r.gone.code === 'ownerRefuses' && /gone/i.test(r.gone.why) && r.gone.off, J(r.gone));
      check('a vehicle that left the scene counts as gone', r.left.ok === false && r.left.code === 'ownerRefuses' && r.left.off, J(r.left));
      check('sitting in another vehicle is refused, it stays there', r.other.ok === false && r.other.code === 'ownerRefuses' && r.other.in, J(r.other));
      check('a refused undo changes nothing', r.quiet, J(r.quiet));
      check('the op value stays plain: a vehicle object does not break JSON', r.json, J(r.json));
    },
  },
  {
    // What is meant: a placement of a limp character moves the whole body as one, keeping its shape, at rest. The write is not lost (root, record and bodies all stand
    // there, and stay), nothing explodes (joints see the same relative pose, no velocity is carried over) and it stays limp until remove().
    name: '[guard] Record writes: placing a limp character carries the whole ragdoll there at rest, in the air or settled, and it stays limp',
    url: '/tests/ragdoll/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const p = engine.player, R = engine.rigid, out = {};
        const steps = (n, each) => { for (let i = 0; i < n; i++) { engine.step(1 / 60, { render: false, describe: false }); each?.(); } };
        const parts = () => R.bodies.filter(b => b.ragdoll);
        const shape = () => { const ps = parts(), o = ps[0].body.translation(); return ps.map(b => { const t = b.body.translation(); return [t.x - o.x, t.y - o.y, t.z - o.z]; }); };
        const fastest = () => Math.max(...parts().map(b => { const v = b.body.linvel(); return Math.hypot(v.x, v.y, v.z); }));
        const hips = () => { const t = parts()[0].body.translation(); return [t.x, t.z]; };
        const rec = () => { const q = engine.world.get('player').position; return [q.x, q.z]; };
        const root = () => [p.root.position.x, p.root.position.z];
        steps(5);
        const go = (name, write, x, z, wait) => {
          const s0 = wait && shape();
          write();
          const moved = shape(), gap = s0 ? Math.max(...moved.map((a, i) => Math.hypot(a[0] - s0[i][0], a[1] - s0[i][1], a[2] - s0[i][2]))) : 0;
          const atOnce = { root: root(), rec: rec(), hips: hips(), speed: fastest() };
          let peak = 0; steps(40, () => { peak = Math.max(peak, fastest()); });
          out[name] = { atOnce, gap, peak, later: { root: root(), rec: rec(), hips: hips() }, limp: !!p.limp, state: p.state, x, z };
        };
        // falling: the fall's speed does not come along
        let rd = R.ragdoll(p, { impulse: [0, 0, 40] }); steps(6);
        out.fastBefore = fastest();
        go('air', () => engine.ops.allow(() => engine.world.move('player', { x: 6, z: 2 })), 6, 2, true);
        // asleep: the sleeping body wakes, moves and settles again
        for (let i = 0; i < 900 && !rd.settled; i++) steps(1);
        out.settled = rd.settled;
        go('asleep', () => engine.ops.run('thing.set', { id: 'player', position: [-5, 0, 3] }), -5, 3, true);
        go('placeAt', () => p.placeAt({ x: 1, z: -4 }), 1, -4, true);
        for (let i = 0; i < 900 && !rd.settled; i++) steps(1);
        const lay = root();
        rd.remove(); steps(5);
        out.up = { laid: lay, root: root(), rec: rec(), limp: !!p.limp, state: p.state, parts: parts().length };
        return out;
      });
      const near = (a, x, z, d) => Math.hypot(a[0] - x, a[1] - z) < d;
      for (const n of ['air', 'asleep', 'placeAt']) {
        const w = r[n];
        check(`${n}: root, record and body are all there at once`, near(w.atOnce.root, w.x, w.z, 1e-6) && near(w.atOnce.rec, w.x, w.z, 1e-6) && near(w.atOnce.hips, w.x, w.z, 1.5), J(w.atOnce));
        check(`${n}: the body keeps its shape and comes at rest`, w.gap < 1e-3 && w.atOnce.speed < 1e-6, J([w.gap, w.atOnce.speed]));
        check(`${n}: nothing explodes while it settles`, w.peak < 8, J(w.peak));
        check(`${n}: the write holds, it does not snap back, and it is still limp`, near(w.later.root, w.x, w.z, 1.5) && near(w.later.hips, w.x, w.z, 2) && w.later.rec.join() === w.later.root.join() && w.limp && w.state === 'ragdoll', J(w.later));
      }
      check('the fall had speed to lose', r.fastBefore > 1, J(r.fastBefore));
      check('it settled before the next write', r.settled, J(r.settled));
      check('remove() gets it up where it lies', near(r.up.root, r.up.laid[0], r.up.laid[1], 1e-6) && r.up.rec.join() === r.up.root.join() && !r.up.limp && r.up.state !== 'ragdoll' && r.up.parts === 0, J(r.up));
    },
  },
];
