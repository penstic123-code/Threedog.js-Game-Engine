// The edges of space: a fast body and a thin wall, a spawn inside a collider, rays on parented, scaled, instanced and hidden objects, positions given as a child object,
// and one geometry for drawn ground, walking height and physics. Each runs across modules on throwaway engines (threads test page).
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'space edges: a fast walker stops at a thin wall, a spawn inside a collider comes out, a wall upstairs leaves the floor below free',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'edge-walk');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }));
        await E.start(); E.haltLoop();
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const go = (speed, x0, dir) => {
          const m = E.mod('move.speed', { owner: 't', set: speed }), h = E.control.take(P, { owner: 't', layer: 'script' });
          P.placeAt([x0, 0, 0]); P.velocity.set(speed * dir, 0);
          for (let i = 0; i < 30; i++) h.move(dir, 0, false, 1 / 60);
          h.remove(); m.remove(); P.velocity.set(0, 0);
          return P.position.x;
        };
        const wall = E.collision.addSegment([5, 0, -20], [5, 0, 20], { thickness: 0.2 });
        out.slow = go(6, 0, 1); out.fast = go(40, 0, 1); out.faster = go(200, 0, 1); out.back = go(200, 10, -1);
        wall.remove();
        const river = E.collision.addBlocked((x, z) => x > 5 && x < 5.2);
        out.river = go(200, 0, 1);
        river.remove();
        out.free = go(40, 0, 1);
        const box = E.collision.addBox([20, 0, 0], { halfWidth: 3, halfDepth: 3 }), tree = E.collision.addCircle([40, 0, 0], { radius: 2 });
        const h = E.control.take(P, { owner: 't', layer: 'script' });
        P.placeAt([20.5, 0, 0.2]); h.move(0, 0, false, 1 / 60); out.boxOut = [P.position.x, P.position.z];
        P.placeAt([40, 0, 0]); h.move(0, 0, false, 1 / 60); out.treeOut = [P.position.x, P.position.z];
        const up = E.collision.addBox([60, 0, 0], { halfWidth: 3, halfDepth: 3, y: 4, height: 2 });
        P.placeAt([60, 0, 0]); h.move(0, 0, false, 1 / 60); out.under = P.position.x;
        h.remove(); box.remove(); tree.remove(); up.remove();
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('walking speed stops at the wall', r.slow < 5, J);
      check('40 m/s stops at the wall', r.fast < 5, J);
      check('200 m/s stops at the wall', r.faster < 5, J);
      check('from the other side too', r.back > 5, J);
      check('a thin blocked strip stops it as well', r.river < 5.2, J);
      check('with the wall gone it runs on', r.free > 5.2, J);
      check('a spawn inside a box comes out of it', Math.abs(r.boxOut[0] - 20) >= 3 || Math.abs(r.boxOut[1]) >= 3, J);
      check('a spawn at a pillar\'s centre comes out', Math.hypot(r.treeOut[0] - 40, r.treeOut[1]) >= 2, J);
      check('a wall upstairs does not push a walker below', r.under === 60, J);
    },
  },
  {
    name: 'space edges: rays and positions on a rotated, scaled child; a moved object answers where it is; instanced and hidden objects',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'edge-ray');
        E.use(T.world(), T.collision());
        await E.start(); E.haltLoop();
        const mat = new THREE.MeshBasicMaterial();
        // a child under a rotated, unevenly scaled parent: the box's world place is worked out by three itself
        const P = new THREE.Group(); P.position.set(10, 2, 0); P.rotation.y = Math.PI / 2; P.scale.set(2, 3, 4); E.scene.add(P);
        const C = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); C.position.set(0, 0, 1); P.add(C);
        const reg = E.rays.addStatic(C);
        const w = C.getWorldPosition(new THREE.Vector3());
        out.world = w.toArray();
        const hit = E.raycast([w.x, w.y + 10, w.z], [0, -1, 0]);
        out.hitY = hit?.point.y; out.hitN = hit?.normal?.toArray();
        reg.remove();
        // a slanted face under an uneven scale: the normal must stay square to the surface
        const G = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, -1, 2, 1, 1, 2, 1, -1, 0, -1, 1, 2, 1, 1, 0, -1], 3));
        const S = new THREE.Group(); S.scale.set(1, 4, 1); S.position.set(0, 0, 30); E.scene.add(S);
        const W = new THREE.Mesh(G, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); S.add(W);
        const reg2 = E.rays.addStatic(W);
        const nh = E.raycast([0, 4, 40], [0, 0, -1]);
        out.slant = nh?.normal?.toArray();
        reg2.remove();
        // moved this step, nothing rendered since
        const M = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat); E.scene.add(M);
        const reg3 = E.rays.addStatic(M);
        M.position.set(50, 0, 0);
        out.movedHit = E.raycast([50, 10, 0], [0, -1, 0])?.point.y ?? null;
        out.oldSpot = E.raycast([0, 10, 0], [0, -1, 0])?.point.y ?? null;
        M.visible = false;
        out.hidden = E.raycast([50, 10, 0], [0, -1, 0]);
        out.hiddenOcc = null;
        reg3.remove();
        // instances
        const I = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 3); E.scene.add(I);
        const m4 = new THREE.Matrix4();
        for (let i = 0; i < 3; i++) I.setMatrixAt(i, m4.makeTranslation(70 + i * 5, 0, 0));
        I.instanceMatrix.needsUpdate = true; I.computeBoundingSphere(); I.updateMatrixWorld(true);
        const ih = E.raycast([75, 10, 0], [0, -1, 0], { targets: [I] });
        out.inst = ih ? { id: ih.instanceId, y: ih.point.y } : null;
        const B = new THREE.BatchedMesh(2, 100, 100, mat); const gid = B.addGeometry(new THREE.BoxGeometry(1, 1, 1));
        const a = B.addInstance(gid), b = B.addInstance(gid); B.setMatrixAt(a, m4.makeTranslation(90, 0, 0)); B.setMatrixAt(b, m4.makeTranslation(95, 0, 0)); E.scene.add(B); B.updateMatrixWorld(true);
        const bh = E.raycast([95, 10, 0], [0, -1, 0], { targets: [B] });
        out.batch = bh ? { id: bh.batchId, want: b } : null;
        // a position given as a child object
        const h = E.collision.addBox(C, { halfWidth: 0.5, halfDepth: 0.5 });
        out.boxAt = !E.collision.walkableAt(w.x, w.z, 0.1);
        out.surfaceArg = E.collision.lineClear([w.x - 5, w.y, w.z], C);
        h.remove();
        // a thing high up: its collider keeps its height
        const L = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat); L.position.set(110, 10, 0); E.scene.add(L);
        const lh = E.collision.addObject(L);
        out.objHigh = E.collision.lineClear([105, 10, 0], [115, 10, 0]);
        out.objBelow = E.collision.lineClear([105, 1, 0], [115, 1, 0]);
        out.objWalk = E.collision.walkableAt(110, 0, 0.3, 0);
        lh.remove();
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r), near = (a, b) => Math.abs(a - b) < 1e-3;
      check('a ray lands on the top of the scaled child', near(r.hitY, r.world[1] + 1.5), J);
      check('and its normal points up', r.hitN && near(r.hitN[1], 1), J);
      // the wall's plane in world: rise 8 over run 2 in z, so its normal is (0, -2, 8) / |..| or its opposite
      check('a slanted face under an uneven scale keeps a true normal', r.slant && Math.abs(r.slant[1] / r.slant[2] + 0.25) < 1e-3, J);
      check('a moved object is hit where it is', near(r.movedHit, 1), J);
      check('and no more where it was', r.oldSpot === null, J);
      check('a hidden object is not hit', r.hidden === null, J);
      check('an instance hit names the instance', r.inst?.id === 1 && near(r.inst.y, 0.5), J);
      check('a batched hit names the batch item', r.batch && r.batch.id === r.batch.want, J);
      check('a child object given as a position is where it stands in the world', r.boxAt === true, J);
      check('line of sight ends at the child\'s world place', r.surfaceArg === false, J);
      check('collision.addObject keeps the height: a line through it is blocked', r.objHigh === false, J);
      check('a line under it is clear', r.objBelow === true, J);
      check('and the ground under it is free', r.objWalk === true, J);
    },
  },
  {
    name: 'space edges: drawn ground, engine.surface and Rapier agree on a steep grid, at chunk seams and after an edit; a character neither floats nor sinks',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        for (const diagonal of ['fixed', 'adaptive', 'alternate']) {
          const E = mk(T.createEngine, 'edge-ground-' + diagonal);
          E.use(T.terrain({ height: (x, z) => 18 * Math.sin(x * 0.23) * Math.cos(z * 0.19) + 7 * Math.sin((x - z) * 0.41), diagonal, viewChunks: 3 }), T.world(), T.collision(), T.characters({ npcs: false }), T.rigid());
          await E.start(); E.haltLoop();
          const G = E.terrain, gen = G.generator, CH = gen.CHUNK, R = E.rigid;
          for (let i = 0; i < 600 && !(R.terrain.size >= 9 && [...R.terrain.values()].every(t => t.ready)); i++) { E.step(1 / 30, { render: false, describe: false }); await new Promise(res => setTimeout(res, 0)); }
          // height of the drawn triangles at (x, z), straight from the chunk's vertex list
          const drawn = (x, z) => {
            const cx = Math.floor(x / CH), cz = Math.floor(z / CH), c = G.chunks.get(cx + ',' + cz); if (!c?.data) return null;
            const p = c.data.pos, lx = x - cx * CH, lz = z - cz * CH, C = gen.CELL, i = Math.min(gen.RES - 1, Math.floor(lx / C)), j = Math.min(gen.RES - 1, Math.floor(lz / C)), base = (j * gen.RES + i) * 18;
            for (let t = 0; t < 2; t++) {
              const o = base + t * 9, ax = p[o], az = p[o + 2], bx = p[o + 3], bz = p[o + 5], qx = p[o + 6], qz = p[o + 8];
              const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz), u = ((bz - qz) * (lx - qx) + (qx - bx) * (lz - qz)) / d, v = ((qz - az) * (lx - qx) + (ax - qx) * (lz - qz)) / d, w = 1 - u - v;
              if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * p[o + 1] + v * p[o + 4] + w * p[o + 7];
            }
            return null;
          };
          const rapierY = (x, z) => { const hit = R.world.castRay(new R.rapier.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true); return hit ? 200 - hit.timeOfImpact : null; };
          const sample = () => {
            let n = 0, wd = 0, wr = 0, miss = 0, s = 11, lo = Infinity, hi = -Infinity; const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
            const px = E.player?.position.x ?? 0;
            for (let k = 0; k < 1500; k++) {
              let x = (rnd() * 2 - 1) * CH * 0.95, z = (rnd() * 2 - 1) * CH * 0.95;
              if (k % 3 === 0) x = Math.round(x / CH) * CH + (rnd() - 0.5) * 0.02;       // on a seam
              if (k % 3 === 1) z = Math.round(z / CH) * CH + (rnd() - 0.5) * 0.02;
              const h = E.surface(x, z), d = drawn(x, z), q = rapierY(x, z);
              if (d === null || q === null) { miss++; continue; }
              n++; lo = Math.min(lo, h); hi = Math.max(hi, h); wd = Math.max(wd, Math.abs(h - d)); wr = Math.max(wr, Math.abs(h - q));
            }
            return { n, miss, span: hi - lo, wd: +wd.toFixed(4), wr: +wr.toFixed(4) };
          };
          const res = out[diagonal] = { before: sample() };
          E.terrain.edit([CH, 0, 0], { raise: 9, radius: 6 });
          E.terrain.edit([0, 0, CH * 0.5], { lower: 7, radius: 5, shape: 'square' });
          res.waited = 0;
          while (res.waited < 30 && (Math.abs(E.surface(CH, 0) - rapierY(CH, 0)) > 2e-3 || E.rigid._srcPending)) { E.step(1 / 60, { render: false, describe: false }); res.waited++; }
          res.after = sample();
          res.edge = +Math.abs(E.surface(CH, 0) - rapierY(CH, 0)).toFixed(4);
          // a character walking the steep ground, simple mover: its feet stay on the surface every step
          const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 3, z: 3 } }), h = E.control.take(P, { owner: 't', layer: 'script' });
          let worst = 0;
          for (let i = 0; i < 240; i++) { h.move(Math.cos(i * 0.02), Math.sin(i * 0.02), false, 1 / 60); if (P.grounded) worst = Math.max(worst, Math.abs(P.position.y - E.surface(P.position.x, P.position.z))); }
          res.feet = +worst.toFixed(4);
          h.remove();
          // the same ground under a Rapier capsule: it rests on the same triangles. A round foot on a steep face stands off the point under its centre by up to its radius times the slope, never below it
          P.mover = 'rapier'; P.placeAt([3, undefined, 3]);
          const k = E.control.take(P, { owner: 't', layer: 'script' });
          let sink = 0, rise = 0, on = 0;
          for (let i = 0; i < 240; i++) {
            k.move(Math.cos(i * 0.02), Math.sin(i * 0.02), false, 1 / 60);
            E.step(1 / 60, { render: false, describe: false });
            if (P.grounded && E.rigid.readyAt(P.position)) { on++; const d = P.position.y - E.surface(P.position.x, P.position.z); sink = Math.max(sink, -d); rise = Math.max(rise, d - P.radius * (1 + E.slope(P.position.x, P.position.z))); }
          }
          res.capsule = { on, sink: +sink.toFixed(3), rise: +rise.toFixed(3), mover: P.mover.name };
          k.remove(); E.dispose();
        }
        return out;
      });
      for (const k of ['fixed', 'adaptive', 'alternate']) {
        const a = r[k], J = JSON.stringify(a);
        check(k + ': enough points measured', a.before.n > 1000 && a.after.n > 1000, J);
        check(k + ': engine.surface equals the drawn triangles', a.before.wd < 2e-3 && a.after.wd < 2e-3, J);
        check(k + ': engine.surface equals Rapier', a.before.wr < 2e-3 && a.after.wr < 2e-3, J);
        check(k + ': on the raised seam too, within a few steps of the edit (not the half-second check)', a.edge < 2e-3 && a.waited < 12, J);
        check(k + ': the ground is steep, and differs by diagonal', a.before.span > 20, J);
        check(k + ': feet stay on the ground', a.feet < 1e-3, J);
        check(k + ': a Rapier capsule does not sink or float', a.capsule.on > 30 && a.capsule.sink < 0.05 && a.capsule.rise < 0.1, J);
      }
    },
  },
  {
    name: 'space edges: a rigid body under a rotated, scaled parent has the size it is drawn at; a fast body and a thin wall; a ray hits it',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'edge-rigid');
        E.use(T.world(), T.collision(), T.rigid());
        await E.start(); E.haltLoop();
        const R = E.rigid, mat = new THREE.MeshBasicMaterial(), step = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const half = c => { const s = c.halfExtents(); return [s.x, s.y, s.z].map(v => +v.toFixed(3)); };
        // a 4 x 1 x 1 box turned 45 degrees: its own size, not the larger box around it
        const A = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1), mat); A.rotation.y = Math.PI / 4; A.position.set(0, 3, 0); E.scene.add(A);
        out.turned = half(R.addBox(A, { fixed: true }).collider);
        // under a parent scaled 2: twice the size, also for a hull and a ball
        const P = new THREE.Group(); P.scale.setScalar(2); P.rotation.y = 1; P.position.set(20, 0, 0); E.scene.add(P);
        const B = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); B.position.set(0, 2, 0); P.add(B);
        out.scaled = half(R.addBox(B, { fixed: true }).collider);
        const H = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); H.position.set(3, 2, 0); P.add(H);
        const he = R.addHull(H, { fixed: true }); const w = H.getWorldPosition(new THREE.Vector3());
        step(1);
        out.hullTop = E.raycast([w.x, 50, w.z], [0, -1, 0], { targets: 'all', filter: h => h.entry === he })?.point.y ?? null; out.hullWant = w.y + 1;
        const Bl = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat); Bl.rotation.z = 0.7; Bl.position.set(-3, 2, 0); P.add(Bl);
        out.ball = R.addBall(Bl, { fixed: true }).collider.radius();
        // the ccd exit of Rapier for a thin wall, on the entry's native body
        const fire = ccd => {
          const W = new THREE.Mesh(new THREE.BoxGeometry(0.1, 6, 6), mat); W.position.set(-30, 30, ccd ? 30 : 40); E.scene.add(W);
          R.addBox(W, { fixed: true });
          const S = new THREE.Mesh(new THREE.SphereGeometry(0.1), mat); S.position.set(-40, 30, ccd ? 30 : 40); E.scene.add(S);
          const b = R.addBall(S, { radius: 0.1, mass: 1, damping: 0 }); b.body.setGravityScale(0, true);
          if (ccd) b.body.enableCcd(true);
          b.body.setLinvel({ x: 170, y: 0, z: 0 }, true); step(20);   // 2.83 m a step: no step lands on the wall
          return b.body.translation().x;
        };
        out.plain = fire(false); out.ccd = fire(true);
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r), near = (a, b, e = 0.01) => Math.abs(a - b) < e;
      check('a turned box keeps its own size', near(r.turned[0], 2) && near(r.turned[2], 0.5), J);
      check('a box under a scaled parent is twice the size, turned or not', near(r.scaled[0], 1) && near(r.scaled[1], 1) && near(r.scaled[2], 1), J);
      check('a hull under a scaled parent too', r.hullTop !== null && near(r.hullTop, r.hullWant, 0.05), J);
      check('a ball under a scaled parent too', near(r.ball, 2), J);
      check('a ball at 170 m/s stops at a 10 cm wall, with or without Rapier\'s ccd on the native body', r.plain < -29 && r.ccd < -29, J);
    },
  },
  {
    name: 'space edges: under a deck the answer is the floor you are on: sight past a pillar, a spawn asked for below, the ambience around the listener, a body rescued, a camera box',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { all: T, mk, THREE } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'edge-under');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.rigid(), T.ambience());
        await E.start(); E.haltLoop();
        const on = (x, z) => x >= -30 && x <= 30 && z >= -30 && z <= 30;
        E.setGround({ height: (x, z, y) => (on(x, z) && (y === undefined || y >= 2.5) ? 3 : 0), slope: () => 0, type: () => 'default', waterLevel: 2 });
        const pillar = E.collision.addCircle([0, 0, 0], { radius: 0.5, height: 2.4 }), wall = E.collision.addBox([0, 0, 10], { halfWidth: 3, halfDepth: 0.2, height: 2.4 });
        out.pillarBelow = E.collision.lineClear([-5, 1.6, 0], [5, 1.6, 0]);
        out.pillarAbove = E.collision.lineClear([-5, 4.6, 0], [5, 4.6, 0]);
        out.wallBelow = E.collision.lineClear([-5, 1.6, 10], [5, 1.6, 10]);
        pillar.remove(); wall.remove();
        out.spawn = E.characters.findSpawn([5, 2.6, 5], { waterMargin: -9 }).y; out.spawnLow = E.characters.findSpawn([5, 0, 5], { waterMargin: -9 }).y; out.spawnTop = E.characters.findSpawn({ x: 5, z: 5 }, { waterMargin: -9 }).y;
        E.focus.set(5, 0, 5); E.step(1 / 60, { render: false, describe: false });
        E.ambience._listen(); out.waterBelow = E.ambience.nearWater(3);
        E.focus.set(5, 3, 5); E.step(1 / 60, { render: false, describe: false });
        E.ambience._listen(); out.waterAbove = E.ambience.nearWater(3);
        // a body gone through the world under the deck comes back to the ground it left, not onto the deck
        E.mod('fall', { owner: 'game', set: 'rescue' });
        const b = E.rigid.addBall(new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial()), { radius: 0.2 });
        E.rigid.setPosition(b, [5, -400, 5]);
        E.step(1 / 60, { render: false, describe: false });
        out.rescued = b.body.translation().y;
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('sight under the deck is cut by the pillar that stands there', r.pillarBelow === false, J);
      check('the wall too', r.wallBelow === false, J);
      check('findSpawn with a height below the deck stays below', r.spawnLow === 0, J);
      check('with a height on the deck, on it; with none, the top ground', r.spawn === 3 && r.spawnTop === 3, J);
      check('ambience hears the water the listener stands in, under the deck', r.waterBelow > 0.99, J);
      check('and none up on the deck', r.waterAbove < 0.01, J);
      check('a body lost under the deck comes back under it', r.rescued > 0 && r.rescued < 3, J);
    },
  },
];
