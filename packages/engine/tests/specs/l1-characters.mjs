// Batch 7, characters lane: the real engine. The "do not bypass" checks: a path always comes through the characters.path rule, a character always moves through the rule's mover,
// and a stop's height is what an NPC is measured against. Also the module going away and coming back.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'L1 path rule: a game source feeds findPath, findPathAsync and walkTo, heights included',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const e = engine, out = {}, p = e.player, from = p.position.clone();
        const off = e.mod('characters.path', { owner: 'l1', id: p.id, set: ({ to }) => [{ x: to.x, y: 30, z: to.z }] });
        out.sync = e.characters.findPath(from, { x: from.x + 2, z: from.z }, { id: p.id })?.[0]?.y;
        out.other = e.characters.findPath(from, { x: from.x + 2, z: from.z }, { id: 'someone-else' })?.[0]?.y !== 30;
        out.async = await new Promise(res => e.characters.findPathAsync(from, { x: from.x + 2, z: from.z }, a => res(a?.[0]?.y), { id: p.id }));
        off.remove();
        const none = e.mod('characters.path', { owner: 'l1', set: false });
        out.none = e.characters.findPath(from, { x: from.x + 2, z: from.z }, { detailed: true }).status;
        none.remove();
        const a = e.characters.findPath(from, { x: from.x + 3, z: from.z });
        out.back = !!a && a.every(q => Number.isFinite(q.y));
        return out;
      });
      check('the source answers findPath, with its y', r.sync === 30);
      check('an id entry leaves others on the default', r.other);
      check('findPathAsync follows the same rule', r.async === 30);
      check('false = no path', r.none === 'noPath');
      check('after it ends the built-in path comes back, every point with y', r.back);
    },
  },
  {
    name: 'L1 mover rule: a temporary mover flies with y from a control step and restores itself',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        const e = engine, p = e.player, out = {};
        e.haltLoop();
        out.before = p.mover.name;
        const y0 = p.position.y;
        let gotY = null;
        const fly = (c, eng) => ({ name: 'fly', move(x, z, run, dt, y) { gotY = y; c.root.position.y += y * 5 * dt; c.grounded = false; eng.characters.kit.ownState(c, 'fly', 0); } });
        const m = e.mod('character.mover', { owner: 'wings', id: p.id, set: fly });
        const ctl = e.control.take(p, { owner: 'l1', layer: 'script', step: () => ({ x: 0, y: 1, z: 0 }) });
        out.during = p.mover.name;
        for (let i = 0; i < 30; i++) e.step(1 / 60, { render: false, describe: false });
        out.rose = p.position.y - y0; out.gotY = gotY; out.state = p.state;
        ctl.remove(); m.remove();
        out.after = p.mover.name;
        const bad = e.mod('character.mover', { owner: 'bad', id: p.id, set: 'nope' });
        try { p.mover; out.bad = 'no throw'; } catch (x) { out.bad = x.code; }
        bad.remove();
        const man = e.mod('character.mover', { owner: 'x', id: p.id, set: false });
        out.manual = p.mover.name; man.remove();
        return out;
      });
      check('the rule replaces the mover for that character', r.during === 'fly' && r.before !== 'fly');
      check('y from the control step reaches the mover', r.gotY === 1);
      check('it actually rose', r.rose > 0.5);
      check('the kit gives the state hook path', r.state === 'fly');
      check('the old mover is back when the entry ends', r.after === r.before);
      check('an unknown name is an error', r.bad === 'character-option');
      check('false means manual', r.manual === 'manual');
    },
  },
  {
    name: 'L1 arrival and reinstall: walkTo refuses another level, pathAsync and the player work after unload and reinstall',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'l1-a');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const mkPlayer = () => E.characters.addPlayer({ control: () => null, spawn: { x: 0, z: 0 } });
        const p = mkPlayer();
        let st = null; p.walkTo({ x: 2, z: 0 }).then(a => { st = a.status; });
        steps(120); await null; await null; out.flat = st;
        const flat = E.surface; E.surface = (x, z, ref) => (ref >= 3.5 ? 4 : 0);   // a second floor at 4
        st = null; p.walkTo({ x: 0, y: 4, z: 0 }, { stuckSeconds: 0.2, maxRepaths: 1 }).then(a => { st = a.status; });
        steps(120); await null; await null; out.high = st; E.surface = flat;
        let late = 0; E.characters.findPathAsync({ x: 0, z: 0 }, { x: 1, z: 1 }, () => { late++; });
        E._unuse('characters', true);
        out.gone = E.characters === undefined || E.characters === null;
        out.player = E.player ? 'still there' : null;
        steps(10);
        E.use(T.characters());
        await new Promise(res => setTimeout(res, 0));   // init of a module installed after start runs as a task: no hooks before it
        const q = mkPlayer();
        let got = null, gs = 'unanswered'; E.characters.findPathAsync({ x: 0, z: 0 }, { x: 3, z: 0 }, (a, s) => { got = a; gs = s; });
        steps(10);
        out.again = got?.[got.length - 1]?.y; out.late = late; out.gs = gs;
        const x0 = q.position.x; q.walkTo({ x: 2, z: 0 }); steps(60); out.moved = q.position.x - x0;
        return out;
      });
      check('a goal at its height arrives', r.flat === 'arrived', r.flat);
      check('a goal on another level does not', r.high === 'stuck' || r.high === 'noPath', r.high);
      check('unloading takes the module away, and its player', r.gone && r.player === null, String(r.gone));
      check('a request left over from the old install does not answer', r.late === 0, r.late);
      check('findPathAsync answers after a reinstall, with y', Number.isFinite(r.again), `${r.gs} ${r.again}`);
      check('a new player walks after a reinstall', r.moved > 0.5, r.moved);
    },
  },
  {
    name: 'L1 stop height: an NPC stop keeps y',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const e = engine, out = {}, g = e.player.position;
        const n = e.npcs.add({ id: 'l1npc', name: 'L1', position: { x: g.x + 3, z: g.z }, schedule: [{ at: 0, position: { x: g.x + 4, y: g.y + 7, z: g.z } }, { at: 0.5, position: { x: g.x + 5, z: g.z } }] });
        out.stops = n.schedule.map(s => s.y === undefined ? 'none' : 'y');
        e.npcs.remove(n);
        return out;
      });
      check('a stop with y keeps it, one without has none', r.stops.includes('y') && r.stops.includes('none'));
    },
  },
  {
    // Real Recast, the "do not bypass" check of the height rule: every way a position reaches the mesh (path, async path, NPC stop) goes through nav.point
    name: 'L1 height rule: a y on no floor finds the ground and warns once on a real navmesh, a y on a floor stays',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const g = new THREE.Group(), f = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
        f.name = 'floor'; f.position.y = 8; g.add(f);
        const E = mk(T.createEngine, 'l1-height');
        E.use(T.world(), T.collision(), T.characters({ npcs: true }), T.level({ scene: g }), T.nav());
        await E.start(); E.haltLoop();
        for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        const warns = [], cw = console.warn; console.warn = (...a) => { const s = a.join(' '); if (s.includes('nav-height')) warns.push(s); };
        out.good = E.characters.findPath([-5, 8, 0], [5, 8.5, 0])?.at(-1)?.y; out.quiet = warns.length;
        const bad = E.characters.findPath([-5, 8, 0], [5, 0, 0], { detailed: true }); out.bad = bad.status; out.badY = bad.path?.at(-1)?.y;
        E.characters.findPath([-5, 0, 0], [6, 0, 0]);
        out.async = await new Promise(res => { E.characters.findPathAsync([-5, 8, 0], [5, 0, 0], (a, s) => res(s)); for (let i = 0; i < 12; i++) E.step(1 / 60, { render: false, describe: false }); });
        const n = E.npcs.add({ id: 'h', name: 'H', position: [-3, 0, 0], schedule: [{ at: 0, position: [3, 0, 0] }] });
        for (let i = 0; i < 400; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(res => setTimeout(res, 1)); }
        out.npc = [n.position.x, n.position.y];
        console.warn = cw; out.warns = warns; E.dispose();
        return out;
      });
      check('a y on the floor is kept, without a warning', Math.abs(r.good - 8) < 0.6 && r.quiet === 0, `${r.good} ${r.quiet}`);
      check('[x, 0, z] on ground at 8 still finds a path, on the ground', r.bad === 'ok' && Math.abs(r.badY - 8) < 0.3, `${r.bad} ${r.badY}`);
      check('findPathAsync too', r.async === 'ok', r.async);
      check('an NPC stop written [x, 0, z] is reached', Math.abs(r.npc[0] - 3) < 1 && Math.abs(r.npc[1] - 8) < 0.5, r.npc.join());
      check('one warning, naming the value', r.warns.length === 1 && r.warns[0].includes('height 0'), r.warns.join('|'));
    },
  },
  {
    // Real Recast and the A* fallback on the same building: ground, a ramp, and a deck at 3 m with a wall across it. The "do not bypass" check of floors: path, walkability, async path and NPC push all read the wall and each other by floor
    name: 'L1 floors: a path climbs a ramp on a real navmesh, a wall upstairs blocks only upstairs, NPCs on two floors leave each other alone',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, out = {};
        const house = () => {
          const g = new THREE.Group(), m = new THREE.MeshBasicMaterial();
          const part = (geo, x, y, z) => { const p = new THREE.Mesh(geo, m); p.name = 'floor'; p.position.set(x, y, z); g.add(p); };
          part(new THREE.PlaneGeometry(40, 30).rotateX(-Math.PI / 2), 0, 0, 0);
          part(new THREE.PlaneGeometry(Math.hypot(6, 3), 10).rotateX(-Math.PI / 2).rotateZ(Math.atan2(3, 6)), 0, 1.5, 0);
          part(new THREE.PlaneGeometry(12, 10).rotateX(-Math.PI / 2), 9, 3, 0);
          return g;
        };
        const wall = E => E.collision.addBox([9, 3, 0], { halfWidth: 0.4, halfDepth: 6, y: 3, height: 2 });
        const steps = async (E, n) => { for (let i = 0; i < n; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(res => setTimeout(res, 1)); } };
        const len = p => p ? p.reduce((s, q, i) => i ? s + Math.hypot(q.x - p[i - 1].x, q.z - p[i - 1].z) : 0, 0) : -1;

        const E = mk(T.createEngine, 'l1-floors');
        E.use(T.world(), T.collision(), T.characters({ npcs: true }), T.level({ scene: house() }), T.nav());
        await E.start(); E.haltLoop();
        for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        const up = E.characters.findPath([-8, 0, 0], [12, 3, 0]);
        out.climb = up && { end: up.at(-1).y, ys: up.map(q => +q.y.toFixed(2)) };
        out.down = E.characters.findPath([12, 0, 0], [12, 3, 0])?.length ?? 0;
        const n = E.npcs.add({ id: 'up', name: 'Up', position: [-6, 0, 0], schedule: [{ at: 0, position: [7, 3, 1] }] });
        await steps(E, 900);
        out.npc = [n.position.x, n.position.y];
        E.npcs.remove(n);
        wall(E); await steps(E, 4);
        out.below = len(E.characters.findPath([5, 0, 0], [13, 0, 0]));
        out.above = E.characters.findPath([5, 3, 0], [13, 3, 0], { detailed: true }).status;
        E.dispose();

        const A = mk(T.createEngine, 'l1-floors-a');
        A.use(T.world(), T.collision(), T.characters({ npcs: true }), T.level({ scene: house() }));
        await A.start(); A.haltLoop();
        wall(A);
        const C = A.collision;
        out.at = [C.walkableAt(9, 0, undefined, 0), C.walkableAt(9, 0, undefined, 3), C.walkableAt(9, 0), C.walkable([9, 0, 0]), C.walkable([9, 3, 0])];
        out.aBelow = len(A.characters.findPath([5, 0, 0], [13, 0, 0]));
        out.aAsync = await new Promise(res => { A.characters.findPathAsync([5, 0, 0], [13, 0, 0], p => res(len(p))); for (let i = 0; i < 12; i++) A.step(1 / 60, { render: false, describe: false }); });
        A.collision.addBox([9, 0, 0], { halfWidth: 0.4, halfDepth: 20, y: 0, height: 2 });
        out.aBlocked = len(A.characters.findPath([5, 0, 0], [13, 0, 0]));

        // two NPCs standing on one spot, one floor apart, and two on one floor
        const stand = (id, p) => A.npcs.add({ id, name: id, position: p, schedule: [{ at: 0, position: p }] });
        const a = stand('a', [8, 0, 3]), b = stand('b', [8, 3, 3]), c = stand('c', [-8, 0, 3]), d = stand('d', [-8, 0, 3.2]);
        A.world.focus?.(a.position);
        await steps(A, 120);
        const flat = (p, q) => Math.hypot(p.position.x - q.position.x, p.position.z - q.position.z);
        out.twoFloors = flat(a, b); out.oneFloor = flat(c, d); out.ys = [a.position.y, b.position.y];
        A.dispose();
        return out;
      });
      check('a path on the mesh ends upstairs', r.climb && Math.abs(r.climb.end - 3) < 0.4, JSON.stringify(r.climb));
      check('from right under the deck it goes round by the ramp', r.down >= 3, r.down);
      check('an NPC walks up the ramp to a stop upstairs', Math.abs(r.npc[0] - 7) < 1 && Math.abs(r.npc[1] - 3) < 0.5, r.npc.join());
      check('the wall upstairs leaves the mesh below free', Math.abs(r.below - 8) < 0.5, r.below);
      check('and cuts the deck: a path that only gets under the goal is no path', r.above === 'noPath', r.above);
      check('walkableAt and walkable go by floor, without y as before', r.at.join() === 'true,false,false,true,false', r.at.join());
      check('A* passes under the wall', Math.abs(r.aBelow - 8) < 0.5, r.aBelow);
      check('async A* passes under it too', Math.abs(r.aAsync - 8) < 0.5, r.aAsync);
      check('a wall on the walker\'s floor still blocks A*', r.aBlocked === -1 || r.aBlocked > 12, r.aBlocked);
      check('same floor pushes apart', r.oneFloor > 0.4, r.oneFloor);
      check('two floors do not', r.twoFloors < 0.01, `${r.twoFloors} ${r.ys}`);
    },
  },
  {
    // The "do not bypass" check of seats: each player hears only its seat, keyboard and pad alike, and engine.player stays the first
    name: 'L1 seats: two players on two seats move apart, a seated pad leaves engine.input, engine.player stays the first',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'l1-seats', { bindings: { jump: ['Space', 'PadA'] } });
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) { E.input.poll(1 / 60); E.step(1 / 60, { render: false, describe: false }); } };
        const a = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const seat = E.input.seat({ pad: 1, keys: { moveForward: 'KeyI', jump: 'KeyU' } });
        const b = E.characters.addPlayer({ id: 'two', input: seat, control: 'camera', spawn: { x: 5, z: 0 } });
        out.first = E.player === a; out.ids = [a.id, b.id]; out.rec = E.world.get('two')?.kind;
        for (const [k, f] of [['pad', () => E.input.seat({ pad: 1 })], ['key', () => E.input.seat({ keys: { jump: 'KeyU' } })], ['twice', () => E.characters.addPlayer({ id: 'three', input: seat, control: 'camera' })], ['loose', () => E.characters.addPlayer({ id: 'three', input: { axis: {} }, control: 'camera' })]]) {
          try { f(); out[k] = 'no throw'; } catch (x) { out[k] = x.code; }
        }
        const z = () => [a.position.z, b.position.z];
        const z0 = z(); E.input._keyDown('KeyI', 'keyboard'); steps(30); E.input._keyUp('KeyI'); steps(60);   // the wait: a body glides on a little after the key
        const z1 = z(); out.seatKey = [z1[0] - z0[0], z1[1] - z0[1]];
        E.input._keyDown('KeyW', 'keyboard'); steps(30); E.input._keyUp('KeyW'); steps(60);
        const z2 = z(); out.mainKey = [z2[0] - z1[0], z2[1] - z1[1]];
        // two fake pads: pad 0 free, pad 1 seated, both pushing the stick forward. The page's own engine owns them until this one is focused
        E.uiRoot.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        const pad = () => ({ connected: true, axes: [0, -1, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) });
        const real = navigator.getGamepads; let pads = [null, pad()];
        navigator.getGamepads = () => pads;
        steps(30); pads = [null, null]; steps(60); const z3 = z(); out.seatPad = [z3[0] - z2[0], z3[1] - z2[1]];
        pads = [pad(), null]; steps(30); const z4 = z(); out.freePad = [z4[0] - z3[0], z4[1] - z3[1]];
        navigator.getGamepads = real; pads = []; steps(2);
        const m = seat.axis; out.axis = [m.x, m.y];
        out.reqFree = E.characters.moveInput(seat).z;
        E.input._keyDown('KeyI', 'keyboard'); steps(1); out.req = E.characters.moveInput(seat).z; E.input._keyUp('KeyI');
        const saved = E.world.get('two').position.x;
        out.same = Math.abs(saved - b.position.x) < 1e-6;
        E.characters.removePlayer('two'); out.afterTwo = [E.player === a, E.world.get('two') === undefined || E.world.get('two') === null];
        E.characters.removePlayer(); out.gone = E.player;
        const c = E.characters.addPlayer({ control: () => null, spawn: { x: 1, z: 1 } }); out.solo = [E.player === c, c.id];
        E.dispose();
        return out;
      });
      check('engine.player is the first, the second has its own record', r.first && r.ids.join() === 'player,two' && r.rec === 'player', JSON.stringify(r));
      check('a pad, a key or a seat used twice is a named error', r.pad === 'input-seat' && r.key === 'input-seat' && r.twice === 'input-seat' && r.loose === 'input-seat', JSON.stringify([r.pad, r.key, r.twice, r.loose]));
      check('a seat\'s key moves only its player', Math.abs(r.seatKey[0]) < 0.01 && Math.abs(r.seatKey[1]) > 0.5, r.seatKey.join());
      check('engine.input moves only the first', Math.abs(r.mainKey[1]) < 0.01 && Math.abs(r.mainKey[0]) > 0.5, r.mainKey.join());
      check('a seated pad moves only its player', Math.abs(r.seatPad[0]) < 0.01 && Math.abs(r.seatPad[1]) > 0.5, r.seatPad.join());
      check('a free pad goes to engine.input', Math.abs(r.freePad[0]) > 0.5, r.freePad.join());
      check('moveInput reads the seat', r.reqFree === 0 && r.req !== 0, `${r.reqFree} ${r.req}`);
      check('position writes back to its own record', r.same);
      check('removing the second leaves the first; without an id it works as before', r.afterTwo.join() === 'true,true' && r.gone === null && r.solo.join() === 'true,player', JSON.stringify([r.afterTwo, r.gone, r.solo]));
    },
  },
];
