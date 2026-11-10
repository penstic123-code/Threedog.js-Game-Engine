// Shared acceptance scene "Sky courier" (docs/plans/done/2026-11-06-batch7-design.md): tests/sky-courier/main.js is game code on the public API; this spec plays it and reads public state only.
// Why a whole scene: each feature passed on a stand-in, and what breaks is where they meet (a mover above a physics world, a path with a vertical leg, water asked at a height).
const PAGE = '/tests/sky-courier/index.html';
const ready = page => page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });

export const specs = [
  {
    name: '[guard] sky courier: composite ground, islands in physics, flight with y, path source, waterfall, fall off',
    url: PAGE,
    async run({ page, check, ev }) {
      await ready(page);
      const r = await ev(async () => {
        engine.haltLoop();
        const T = game.THREE, P = engine.player, C = engine.collider3d, W = engine.world, out = {};
        const steps = async n => { for (let i = 0; i < n; i++) { engine.step(1 / 60); if (i % 30 === 0) await new Promise(res => setTimeout(res, 0)); } };
        const at = () => P.position.toArray().map(v => +v.toFixed(2));
        await steps(60);
        for (let i = 0; i < 100 && !(W.view('isle-a') && W.view('isle-b')); i++) await steps(5);
        await steps(10);

        // terrain plus level: one ground, and both have physics under them
        out.ground = { pad: engine.surface(0, 0), far: +engine.surface(20, 0).toFixed(2), wantFar: +(Math.sin(2) + 1 * Math.cos(0)).toFixed(2), slotted: engine.describe().ground ?? null };
        // both are surfaces in physics, so a sweep finds them (a ball inside a mesh or height field touches nothing)
        const down = (x, z) => +(C.sweep([x, 20, z], [x, -20, z], 0.1)?.point.y ?? NaN).toFixed(1);
        out.solid = { deck: down(0, 0), terrain: down(20, 0), want: +(engine.surface(20, 0) + 0.1).toFixed(1) };
        const walker = P.position.clone();
        out.startOnDeck = at();
        const h0 = engine.control.take(P, { owner: 'walk', layer: 'script', step: () => ({ x: 1, z: 0 }) });
        await steps(300); h0.remove();
        out.walkedOff = at(); out.walkedGround = +engine.surface(P.position.x, P.position.z).toFixed(2);
        P.placeAt([0, 0, 0]); await steps(10); void walker;

        // a tilted solid: where the mesh is drawn is where physics has it
        const isle = id => { const m = W.view(id); m.updateMatrixWorld(true); const mesh = m.isMesh ? m : m.getObjectByProperty('isMesh', true);
          const local = (x, y, z) => mesh.localToWorld(new T.Vector3(x, y, z)).toArray(); return { local, m }; };
        const a = isle('isle-a'), b = isle('isle-b');
        const inside = [[0, 0.5, 0], [0.45, 0.9, 0.45], [-0.45, 0.1, -0.45], [0.45, 0.1, -0.45]], outside = [[0.7, 0.5, 0], [0, 1.4, 0], [0, -0.4, 0], [0, 0.5, 0.7]];
        out.tilt = { in: [a, b].flatMap(i => inside.map(p => C.overlap(i.local(...p), 0.02))), out: [a, b].flatMap(i => outside.map(p => C.overlap(i.local(...p), 0.02))) };
        // the top face, straight down its own normal
        const top = a.local(0, 1, 0), above = a.local(0, 3, 0), hit = C.sweep(above, top.map((v, i) => v + (top[i] - above[i])), 0.05);
        out.topHit = hit ? +new T.Vector3(...hit.point.toArray()).distanceTo(new T.Vector3(...top)).toFixed(2) : null;
        // moved, the solid follows
        W.move('isle-a', { x: 34, y: 40, z: 0 }); await steps(5);
        out.moved = { view: W.view('isle-a').position.toArray(), oldGone: !C.overlap(a.local(0, 0.5, 0).map((v, i) => v - [4, 0, 0][i] + 0), 0.02) || null, newThere: C.overlap(isle('isle-a').local(0, 0.5, 0), 0.02) };
        W.move('isle-a', { x: 30, y: 40, z: 0 }); await steps(5);

        // flight: a hold of the rule, y from a control step, the mover stops under solid rock
        const wings = engine.mod('character.mover', { owner: 'wings', id: 'player', set: game.fly });
        out.moverName = P.mover.name;
        P.placeAt([-30, 3, 20], { y: 3 }); P.root.position.set(-30, 40, 20);
        const up = engine.control.take(P, { owner: 'climb', layer: 'script', step: () => ({ x: 0, y: 1, z: 0 }) });
        await steps(300); up.remove();
        out.stopped = { at: at(), underside: b.local(0, 0, 0) };
        wings.remove(); out.moverBack = P.mover.name;
        P.root.position.set(0, 12, 0); await steps(90);
        out.landed = at();

        // the same flight when the walker is the rapier mover: release, it must land where it flew, not where it left the ground
        P.mover = 'rapier'; await steps(10);
        out.rapierStart = at();
        const w2 = engine.mod('character.mover', { owner: 'wings', id: 'player', set: game.fly });
        const up2 = engine.control.take(P, { owner: 'climb', layer: 'script', step: () => ({ x: 1, y: 1, z: 0 }) });
        await steps(120); up2.remove();
        out.rapierFlown = at();
        w2.remove(); await steps(120);
        out.rapierLanded = { at: at(), ground: +engine.surface(P.position.x, P.position.z).toFixed(2), name: P.mover.name, grounded: P.grounded };
        P.mover = 'simple'; P.placeAt([0, 0, 0]); await steps(5);

        // a path source: a route the game plans, with a straight-up leg, walked by the flying mover, arrival counts height
        const sky1 = engine.mod('character.mover', { owner: 'wings', id: 'player', set: game.fly });
        const planned = engine.mod('characters.path', { owner: 'courier', id: 'player', set: ({ from, to }) => [{ x: from.x, y: from.y, z: from.z }, { x: from.x, y: 30, z: from.z }, { x: to.x, y: 30, z: to.z }, to] });
        P.root.position.set(0, 5, 0);
        const walk = P.walkTo({ x: 12, y: 20, z: 6 }); let result = null; walk.then(v => { result = v; });
        for (let i = 0; i < 40 && result == null; i++) { await steps(30); await new Promise(res => setTimeout(res, 0)); }
        out.walk = { result, at: at() };
        walk.remove?.();
        out.async = await new Promise(res => { engine.characters.findPathAsync({ x: 0, y: 5, z: 0 }, { x: 8, y: 9, z: 8 }, (path, status) => res({ status, ys: path?.map(p => p.y) }), { id: 'player' }); steps(20); });
        planned.remove(); sky1.remove();

        // waterfall: a column of water; the level depends on the height asked
        const f = game.fall;
        out.water = { mid: engine.waterAt(f.x, f.z, 30), above: engine.waterAt(f.x, f.z, 70), beside: engine.waterAt(f.x + 5, f.z, 30), noY: engine.waterAt(f.x, f.z) };
        // the walker in the column, swimming because the height it is at has water: the same answer describe gives
        P.root.position.set(f.x, 30, f.z); P.vy = 0; const wet0 = game.wet;
        await steps(2);
        out.swim = { wet: game.wet - wet0, swimming: P.swimming, inWater: engine.describe().player?.inWater ?? null };
        P.root.position.set(0, 12, 0); await steps(60);

        // a body in the column feels it: rigid asks at its own height
        const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial()); box.position.set(f.x, 30, f.z);
        const body = engine.rigid.addBox(box, { mass: 1 });
        await steps(120);
        out.bodyInFall = +body.body.translation().y.toFixed(1);
        engine.remove(box);

        // fall off: the rule says nobody is rescued; character:fall still fires, once, and the body falls on
        const rescue = engine.mod('fall', { owner: 'game', set: 'rescue' });
        game.falls = 0;
        const kitMover = (c, e) => ({ name: 'kit', move(x, z, run, dt, y = 0) { const k = e.characters.kit; k.beginMove(c); c.root.position.y -= 20 * dt; c.grounded = false; k.endMove(c, dt, null); } });
        P.root.position.set(0, 12, 0); await steps(30);
        const safe = P.safeGround ? { ...P.safeGround } : null;
        const dive = engine.mod('character.mover', { owner: 'dive', id: 'player', set: kitMover });
        P.root.position.y = -29;
        await steps(30);
        out.rescued = { falls: game.falls, y: +P.position.y.toFixed(1), safe };
        rescue.remove();
        const off = engine.mod('fall', { owner: 'game', set: false });
        game.falls = 0; P.root.position.y = -29; await steps(60);
        out.noRescue = { falls: game.falls, y: +P.position.y.toFixed(1) };
        dive.remove();
        const rock = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial()); rock.position.set(20, -190, 0);
        const rb = engine.rigid.addBox(rock, { mass: 1 }); await steps(120);
        out.bodyFalls = +rb.body.translation().y.toFixed(0);
        engine.remove(rock); off.remove();

        // a rapier NPC taking off: its capsule goes with it, nothing invisible stays at the take-off spot
        const npc = new game.Character(engine, { mover: 'rapier', id: 'courier-2' }); engine.add(npc.root); npc.placeAt([4, 0, 2]);
        const stay = engine.control.take(npc, { owner: 'idle', layer: 'script', step: () => ({ x: 0, z: 0 }) });
        await steps(20);
        const foot = npc.position.clone(), mid = [foot.x, foot.y + 0.9, foot.z];
        out.npc = { capsuleThere: C.overlap(mid, 0.1) };
        stay.remove();
        const w3 = engine.mod('character.mover', { owner: 'wings', id: 'courier-2', set: game.fly });
        const go = engine.control.take(npc, { owner: 'climb', layer: 'script', step: () => ({ x: 0, y: 1, z: 0 }) });
        await steps(120); go.remove();
        out.npc.flewTo = +npc.position.y.toFixed(1); out.npc.leftBehind = C.overlap(mid, 0.1);
        w3.remove();
        const idle = engine.control.take(npc, { owner: 'idle', layer: 'script', step: () => ({ x: 0, z: 0 }) });   // a hand-made character moves only when someone drives it
        await steps(240); idle.remove();
        out.npc.landed = +npc.position.y.toFixed(1); out.npc.ground = +engine.surface(foot.x, foot.z).toFixed(1); out.npc.capsuleBack = C.overlap(mid, 0.1);
        npc.dispose(); engine.remove(npc.root); await steps(3);
        out.npc.gone = C.overlap(mid, 0.1);

        // solids of content come back with a load: the rigid world is new, the islands are the same
        out.saved = await engine.saves.save('sky'); out.loaded = await engine.saves.load('sky');
        await steps(10);
        out.afterLoad = { tilt: inside.map(p => C.overlap(isle('isle-a').local(...p), 0.02)), rule: P.mover.name };
        return out;
      });
      const J = k => JSON.stringify(r[k]);
      check('ground: the level answers inside its region, the terrain outside', r.ground.pad === 4 && r.ground.far === r.ground.wantFar, J('ground'));
      check('physics has both the level and the terrain', r.solid.deck === 4.1 && r.solid.terrain === r.solid.want, J('solid'));
      check('walked off the deck onto the terrain', Math.abs(r.walkedOff[1] - r.walkedGround) < 0.2 && r.walkedOff[0] > 6, JSON.stringify([r.walkedOff, r.walkedGround]));
      check('a tilted solid is in physics where it is drawn', r.tilt.in.every(Boolean) && !r.tilt.out.some(Boolean), J('tilt'));
      check('its top face is hit where it is drawn', r.topHit != null && r.topHit < 0.1, J('topHit'));
      check('world.move takes the solid along', r.moved.oldGone && r.moved.newThere, J('moved'));
      check('the rule puts the flying mover on and takes it off', r.moverName === 'fly' && r.moverBack === 'simple', J('moverName'));
      check('y from a control step climbs until the solid above stops it', r.stopped.at[1] > 53 && r.stopped.at[1] < 54.2, J('stopped'));
      check('[guard] a flyer takes off from the ground it stands on and flies over a rapier walker', r.rapierFlown[1] > 10 && r.rapierFlown[0] > 5, J('rapierFlown'));
      check('[guard] released, the rapier mover lands under where it flew', Math.abs(r.rapierLanded.at[0] - r.rapierFlown[0]) < 0.5 && Math.abs(r.rapierLanded.at[1] - r.rapierLanded.ground) < 0.2 && r.rapierLanded.grounded && r.rapierLanded.name === 'rapier', J('rapierLanded'));
      check('[guard] a path source with a vertical leg is walked to the end, height included', r.walk.result?.status === 'arrived' && r.walk.at[1] < 22 && Math.hypot(r.walk.at[0] - 12, r.walk.at[2] - 6) < 0.6, J('walk'));
      check('findPathAsync answers from the path source, with y', r.async.status === 'ok' && r.async.ys.join() === '5,30,30,9', J('async'));
      check('the waterfall answers by height', r.water.mid === 31 && [r.water.above, r.water.beside, r.water.noY].every(v => v === -Infinity), J('water'));
      check('[guard] a character in the column swims, and describe says so', r.swim.wet === 1 && r.swim.swimming && r.swim.inWater, J('swim'));
      check('[guard] a body in the column floats instead of falling through', r.bodyInFall > 20, J('bodyInFall'));
      check('the rescue the game chose brings it back once', r.rescued.falls === 1 && r.rescued.y > -30, J('rescued'));
      check('fall off: told once, nobody moved back', r.noRescue.falls === 1 && r.noRescue.y < -35, J('noRescue'));
      check('[guard] a rapier NPC flying leaves no capsule behind and lands', r.npc.capsuleThere && r.npc.flewTo > 5 && !r.npc.leftBehind && Math.abs(r.npc.landed - r.npc.ground) < 0.3 && r.npc.capsuleBack && !r.npc.gone, J('npc'));
      check('[guard] a tilted solid of content outlives a load', r.saved && r.loaded && r.afterLoad.tilt.every(Boolean), JSON.stringify([r.saved, r.loaded, r.afterLoad]));
      check('fall off: a body far under the ground keeps falling', r.bodyFalls < -195, J('bodyFalls'));
    },
  },
];
