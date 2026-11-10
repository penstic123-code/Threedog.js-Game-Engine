// Paths across floors and from a game's own source: what A*, nav, findPathAsync, walkTo and NPCs agree on when the ground has layers. Layered ground here is a plain setGround, no level.
const world = () => {
  // ground 0 everywhere; a deck at y 3 over x 0..10, z -5..5; a ramp x -10..0 at z -2..2 climbs to it (conn: false takes the ramp away: two floors nothing joins)
  window.spaceWorld = async ({ conn = true, key = 'space', npcs = false, radius } = {}) => {
    const { createEngine, world, collision, characters, mk } = threedogThreads;
    const E = mk(createEngine, key, radius ? { movement: { radius } } : {});
    E.use(world(), collision(), characters({ npcs }));
    await E.start();
    const onDeck = (x, z) => x >= 0 && x <= 10 && z >= -5 && z <= 5, onRamp = (x, z) => conn && x > -10 && x < 0 && z >= -2 && z <= 2;
    const rampY = x => (x + 10) * 0.3;
    const layers = (x, z) => { const l = [0]; if (onRamp(x, z)) l.push(rampY(x)); if (onDeck(x, z)) l.push(3); return l; };
    const pick = (x, z, y) => { const l = layers(x, z); if (y === undefined) return l[l.length - 1]; let h = l[0]; for (const v of l) if (v <= y + 0.5) h = v; return h; };
    E.setGround({ height: pick, slope: () => 0, type: () => 'default' });
    return E;
  };
};
const ramp = async () => {
  const out = {}, E = await spaceWorld();
  const P = (a, b) => E.characters.findPath(a, b, { detailed: true });
  out.fromSide = P([5, 0, 12], [5, 3, 0]);       // the deck's top is right over the way in: under it first, then round by the ramp
  out.fromRamp = P([-15, 0, 0], [5, 3, 0]);
  out.down = P([5, 3, 0], [5, 0, 12]);
  out.under = P([5, 0, 12], [5, 0, 0]);
  E.dispose();
  const F = await spaceWorld({ conn: false, key: 'space2' });
  out.apart = F.characters.findPath([5, 0, 12], [5, 3, 0], { detailed: true });
  out.asyncApart = await new Promise(res => { F.characters.findPathAsync([5, 0, 12], [5, 3, 0], (path, status) => res({ path, status })); for (let i = 0; i < 12; i++) F.step(1 / 60, { render: false, describe: false }); });
  F.dispose();
  return out;
};
export const specs = [
  {
    name: 'space paths: A* climbs a ramp to a deck it passed under; two floors nothing joins are noPath, sync and async alike (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(world);
      const r = await ev(ramp);
      const top = p => p?.[p.length - 1]?.y;
      check('from beside the deck, the path goes round by the ramp and ends on top', r.fromSide.status === 'ok' && top(r.fromSide.path) === 3 && r.fromSide.path.some(p => p.x < 0 && p.y > 0), JSON.stringify(r.fromSide));
      check('from the ramp\'s foot it goes up', r.fromRamp.status === 'ok', JSON.stringify(r.fromRamp));
      check('and back down', r.down.status === 'ok' && top(r.down.path) === 0, JSON.stringify(r.down));
      check('under the deck stays on the ground', r.under.status === 'ok' && r.under.path.every(p => p.y === 0), JSON.stringify(r.under));
      check('no ramp: noPath', r.apart.status === 'noPath', JSON.stringify(r.apart));
      check('no ramp, findPathAsync: noPath too', r.asyncApart.status === 'noPath', JSON.stringify(r.asyncApart));
    },
  },
  {
    // the exit for what A* will not do: a game's own grid search, two floors joined at a stair it knows, plugged in through the rule
    name: 'space paths: a game\'s own grid A* through characters.path takes walkTo and an NPC up a floor; its list stays the game\'s; bad and empty answers are honest (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(world);
      const r = await ev(async () => {
        const out = {}, E = await spaceWorld({ npcs: true, key: 'space-src' });
        const floorOf = p => (p.y ?? 0) > 1.5 ? 1 : 0;
        // nodes are (i, j, floor) on a 1 m grid; floor 1 is the deck and the ramp, the ramp's foot joins it to floor 0
        const open = (i, j, f) => f === 0 ? Math.abs(i) <= 30 && Math.abs(j) <= 30 : (i >= -10 && i <= 10 && j >= -2 && j <= 2 && !(i >= 0 && Math.abs(j) > 5));
        const gridAStar = (from, to) => {
          const k = (i, j, f) => `${i},${j},${f}`, S = [Math.round(from.x), Math.round(from.z), floorOf(from)], G = [Math.round(to.x), Math.round(to.z), floorOf(to)];
          const came = new Map([[k(...S), null]]), q = [S];
          while (q.length) {
            const c = q.shift();
            if (c[0] === G[0] && c[1] === G[1] && c[2] === G[2]) {
              const list = []; for (let n = c; n; n = came.get(k(...n))) list.unshift({ x: n[0], y: n[2] ? E.surface(n[0], n[1], 3) : 0, z: n[1] });
              return list;
            }
            const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [c[0] + a, c[1] + b, c[2]]);
            if (c[0] === -10 && Math.abs(c[1]) <= 2) next.push([c[0], c[1], 1 - c[2]]);
            for (const n of next) if (open(...n) && !came.has(k(...n))) { came.set(k(...n), c); q.push(n); }
          }
          return null;
        };
        let seen = [];
        const mod = E.mod('characters.path', { owner: 'game', set: ({ from, to }) => { seen.push([typeof from.x, typeof to.x]); return gridAStar(from, to); } });
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 5, z: 12 } });
        const run = async (pr, done, n = 2400) => { for (let i = 0; i < n && !done(); i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 100 === 0) await new Promise(res => setTimeout(res, 0)); } return pr; };
        let res = null;
        E.characters.findPath([5, 0, 12], [5, 3, 0], { detailed: true });
        const w = P.walkTo([5, 3, 0]); w.then(v => { res = v; });
        await run(w, () => res); await w;
        out.up = { res, y: P.position.y, x: P.position.x, z: P.position.z };
        out.seen = seen.slice(0, 2);
        res = null; const d = P.walkTo([5, 0, 12]); d.then(v => { res = v; }); await run(d, () => res); await d;
        out.down = { res, y: P.position.y };
        // an NPC on the same source, up to a stop on the deck
        const npc = E.npcs.add({ id: 'n', name: 'N', position: [-14, 0, 0], schedule: [{ at: 0, position: [5, 3, 1] }] });
        await run(null, () => Math.hypot(npc.position.x - 5, npc.position.z - 1) < 1.3 && npc.position.y > 2.5);
        out.npc = npc.position.toArray();
        mod.remove();
        // one list of the game's, shared by two walkers: what they walk off it stays on it
        const route = Object.freeze([{ x: -14, z: 4 }, { x: -12, z: 4 }, { x: -10, z: 4 }, { x: -8, z: 8 }].map(Object.freeze));
        const m2 = E.mod('characters.path', { owner: 'game', set: () => route });
        const A = E.npcs.add({ id: 'a', name: 'A', position: [-14, 0, 4], schedule: [{ at: 0, position: [-8, 0, 8] }] });
        await run(null, () => Math.hypot(A.position.x + 8, A.position.z - 8) < 1.3, 600);
        out.frozen = A.position.toArray(); out.kept = route.length;
        m2.remove();
        // an empty list says no way, as null does; a walk says noPath and an NPC does not hang on it for good
        const m3 = E.mod('characters.path', { owner: 'game', set: () => [] });
        out.empty = E.characters.findPath([0, 0, 20], [5, 0, 20], { detailed: true }).status;
        m3.remove();
        const m4 = E.mod('characters.path', { owner: 'game', set: () => 'nonsense' });
        try { E.characters.findPath([0, 0, 20], [5, 0, 20]); out.bad = 'no error'; } catch (e) { out.bad = e.code ?? e.message; }
        m4.remove();
        E.dispose();
        // a stop on a floor no walk reaches: the NPC stays where it is, it does not press on along a straight line that was never a path
        const F = await spaceWorld({ conn: false, npcs: true, key: 'space-nopath' });
        const N = F.npcs.add({ id: 'n', name: 'N', position: [5, 0, 12], schedule: [{ at: 0, position: [5, 3, 0] }] });
        for (let i = 0; i < 300; i++) F.step(1 / 60, { render: false, describe: false });
        out.noWay = N.position.toArray();
        F.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('walkTo goes up by the game\'s path and arrives on the deck', r.up.res?.status === 'arrived' && Math.abs(r.up.y - 3) < 0.1, J);
      check('the source reads from and to as { x, y, z }, whatever form the caller used', r.seen.length > 0 && r.seen.every(p => p[0] === 'number' && p[1] === 'number'), J);
      check('and back down', r.down.res?.status === 'arrived' && Math.abs(r.down.y) < 0.1, J);
      check('an NPC follows the same source to its stop upstairs', r.npc[1] > 2.5, J);
      check('a frozen list shared by the game is walked and left whole', Math.hypot(r.frozen[0] + 8, r.frozen[2] - 8) < 1.3 && r.kept === 4, J);
      check('an empty list is noPath', r.empty === 'noPath', J);
      check('an answer that is no path is an error, not a walk', r.bad !== 'no error', J);
      check('an NPC with no way stays put', Math.hypot(r.noWay[0] - 5, r.noWay[2] - 12) < 0.5, J);
    },
  },
  {
    name: 'space paths: navmesh: two unjoined floors are noPath, a body too wide for the only gap is told so before it walks, an obstacle under a live walk is walked round (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, world, collision, characters, level, nav, mk, THREE } = threedogThreads, out = {};
        const m = new THREE.MeshBasicMaterial(), g = new THREE.Group();
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), m); g.add(floor);
        const deck = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), m); deck.position.set(20, 4, 20); g.add(deck);
        // a wall across z = 0 with one 2.8 m gap at x = 0
        for (const [n, x, w] of [['col_l', -15.7, 28.6], ['col_r', 15.7, 28.6]]) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, 3, 1), m); b.name = n; b.position.set(x, 1.5, 0); g.add(b); }
        const E = mk(createEngine, 'space-nav');
        E.use(world(), collision(), characters({ npcs: false }), level({ scene: g }), nav());
        await E.start(); E.haltLoop();
        for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        E.step(1 / 60, { render: false, describe: false });
        out.floors = E.characters.findPath([20, 0, 26], [20, 4, 20], { detailed: true }).status;
        out.floorsBack = E.nav.findPath([20, 4, 20], [20, 0, 26], { detailed: true }).status;
        out.under = E.characters.findPath([20, 0, 26], [20, 0, 20], { detailed: true }).status;
        out.narrow = E.characters.findPath([0, 0, -6], [0, 0, 6], { detailed: true }).status;
        // a walk in progress: a wall lands across the way
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: -6, z: -10 } });
        let res = null; const w = P.walkTo([6, 0, -10]); w.then(v => { res = v; });
        for (let i = 0; i < 30; i++) E.step(1 / 60, { render: false, describe: false });
        const wall = E.collision.addBox([P.position.x + 2, 0, -10], { halfWidth: 0.4, halfDepth: 4 });
        for (let i = 0; i < 1500 && !res; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 200 === 0) await new Promise(r2 => setTimeout(r2, 0)); }
        await w; out.round = res?.status; out.x = P.position.x;
        wall.remove();
        // the path is cut for the body that asks: one too wide for the gap gets no path, and never walks up to it
        P.radius = 1.6; P.placeAt([0, 0, -6]); res = null;
        const v = P.walkTo([0, 0, 6]); v.then(x => { res = x; });
        for (let i = 0; i < 1500 && !res; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 200 === 0) await new Promise(r2 => setTimeout(r2, 0)); }
        await v; out.wide = res?.status; out.wideZ = P.position.z;
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('nav: up to a deck nothing joins is noPath', r.floors === 'noPath', J);
      check('nav: and down from it', r.floorsBack === 'noPath', J);
      check('nav: the ground under the deck is reached', r.under === 'ok', J);
      check('nav: a normal body goes through the gap', r.narrow === 'ok', J);
      check('nav: a body too wide for the gap has no path and stays', r.wide === 'noPath' && Math.abs(r.wideZ + 6) < 0.5, J);
      check('a live walk goes round a wall that lands on its way', r.round === 'arrived' && Math.abs(r.x - 6) < 1, J);
    },
  },
];
