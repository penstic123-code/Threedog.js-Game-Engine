// Async pathfinding (engine.characters.findPathAsync): threads on / off give identical paths at identical steps, statuses stay honest,
// a dead worker falls back to the main thread. The "do not bypass" guard (one A*, one Recast query, NPCs only use the async entry) is rule R20 (npm run check).
// Runs in the page: engines with threads 0 and 2 get the same requests; every answer is logged with the step it landed on
import { readFileSync } from 'node:fs';

const twin = async ({ useNav, n, crash = true, change = true }) => {
  const { createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
  const maze = () => {   // 40x40 floor, a wall across z = 0 with gaps at both ends (same layout as the nav test page)
    const g = new THREE.Group(), m = new THREE.MeshBasicMaterial();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), m); floor.name = 'floor'; g.add(floor);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(24, 3, 1), m); wall.name = 'col_wall'; wall.position.set(0, 1.5, 0); g.add(wall);
    return g;
  };
  const make = async threads => {
    const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, threads, urlState: false, saveKey: 'path' + threads });
    E.use(world(), collision(), characters({ npcs: false }));
    if (useNav) E.use(level({ scene: maze() }), nav());
    await E.start();
    for (let i = 0; i < 100 && useNav && !E.nav.ready; i++) await new Promise(r => setTimeout(r, 50));
    if (!useNav) for (let i = 0; i < 40; i++) E.collision.addBox([(i * 37) % 120 - 60, 0, (i * 53) % 120 - 60], { halfWidth: 1 + i % 5, halfDepth: 1 + (i * 3) % 4, rotation: i * 0.3 });
    return E;
  };
  const A = await make(0), B = await make(2);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const span = useNav ? 18 : 70, reqs = Array.from({ length: n }, () => [{ x: (rnd() * 2 - 1) * span, z: (rnd() * 2 - 1) * span }, { x: (rnd() * 2 - 1) * span, z: (rnd() * 2 - 1) * span }]);
  const logs = [[], []], ms = [0, 0], syncMs = [0];
  const ask = (E, k, from, to, i) => E.characters.findPathAsync(from, to, (path, status) => logs[k].push(`${i}@${E.time.tick}:${status}:${JSON.stringify(path)}`));
  const steps = async (count, k) => { const t0 = performance.now(); for (let s = 0; s < count; s++) { [A, B][k].step(1 / 60); await new Promise(r => setTimeout(r, 2)); } return performance.now() - t0; };
  if (!crash) {   // cost run: workers already started and holding the mesh (a game's first requests also pay that once); base = step cost without requests
    for (const E of [A, B]) E.characters.findPathAsync({ x: 1, z: -5 }, { x: 1, z: 5 }, () => {});
    await Promise.all([steps(60, 0), steps(60, 1)]);
  }
  const before = [A, B].map(E => ({ ...E.commits.stats }));
  for (const [k, E] of [A, B].entries()) reqs.forEach(([f, t], i) => ask(E, k, f, t, i));
  // the same requests answered synchronously, for the main-thread cost comparison
  { const t0 = performance.now(); for (const [f, t] of reqs) A.characters.findPath(f, t); syncMs[0] = performance.now() - t0; }
  let crashed = false, s = 0;
  for (; s < 200 && (logs[0].length < n + 2 || logs[1].length < n + 2); s++) {
    for (const [k, E] of [A, B].entries()) {
      if (s === 3 && change) {   // the walkable state changes while batches are in flight: those answers are recomputed on the new state, identically in both
        if (useNav) E.collision.addBox([16, 0, 0], { halfWidth: 4.5, halfDepth: 1 }); else E.collision.addCircle([0, 0, 0], { radius: 3 });
      }
      if (s === 6 && k === 1 && crash) { const lane = [...E.threads.lanes].find(l => /pathWorker/.test(l.create.toString())); if (lane) { lane._crash('test'); crashed = lane.size === 0; } }
      if (s === 6) { ask(E, k, { x: -15, z: -5 }, { x: 15, z: 5 }, 'late'); ask(E, k, { x: 0, z: -5 }, { x: 300, z: 300 }, 'far'); }
      const t0 = performance.now(); E.step(1 / 60); ms[k] += performance.now() - t0;
    }
    await new Promise(r => setTimeout(r, 4));
  }
  const base = [0, 0];
  for (const k of [0, 1]) { for (let i = 0; i < s; i++) { const t0 = performance.now(); [A, B][k].step(1 / 60); base[k] += performance.now() - t0; } }
  const sorted = l => [...l].sort().join('\n');
  const out = { n, same: logs[0].join('\n') === logs[1].join('\n'), sameSet: sorted(logs[0]) === sorted(logs[1]), counts: logs.map(l => l.length), crashed,
    statuses: [...new Set(logs[0].map(s => s.split(':')[1]))], far: logs[0].find(s => s.startsWith('far@')), firstDiff: logs[0].find((s, i) => s !== logs[1][i]),
    stats: [A, B].map((E, k) => ({ applied: E.commits.stats.applied - before[k].applied, late: E.commits.stats.late - before[k].late })), ms: ms.map((m, k) => +(m - base[k]).toFixed(1)), syncMs: +syncMs[0].toFixed(1), sizes: [A.threads.size, B.threads.size] };
  A.dispose(); B.dispose();
  return out;
};

// Two platforms a walker cannot walk between: x -8..-2 on the ground and x 2..8 raised 1.5 m, a 4 m gap between them. Defined on the page, so each ev can build one.
// deck: true instead makes one floor x -10..10 with a deck 3 m above it over x 0..10, for a ladder that goes straight up (LADDER: both ends at the same x, z)
// hatch: true makes a wider floor with a deck over x, z -6..6 that has a 1.4 m opening in its middle
const platforms = () => {
  window.linkWorld = async ({ links, threads = 0, npcs = false, navOpts = {}, saveKey = 'links', deck = false, hatch = false }) => {
    const { createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
    const g = new THREE.Group(), m = new THREE.MeshBasicMaterial();
    const part = (x, y, z, w, d) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m); p.name = 'floor'; p.position.set(x, y, z); g.add(p); };
    if (hatch) for (const a of [[0, 0, 0, 30, 30], [0, 3, 3.35, 12, 5.3], [0, 3, -3.35, 12, 5.3], [-3.35, 3, 0, 5.3, 1.4], [3.35, 3, 0, 5.3, 1.4]]) part(...a);
    else for (const [x, y, w] of deck ? [[0, 0, 20], [5, 3, 10]] : [[-5, 0, 6], [5, 1.5, 6]]) part(x, y, 0, w, 12);
    const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, threads, urlState: false, saveKey });
    E.use(world(), collision(), characters({ npcs }), level({ scene: g }), nav({ links, ...navOpts }));
    await E.start();
    for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(r => setTimeout(r, 50));
    return E;
  };
  window.GAP = { id: 'gap', from: [-2.2, 0, 0], to: [2.2, 1.5, 0] };
  /** An NPC walks onto GAP: where its crossing began and where the link starts */
  window.crossingWorld = async () => {
    const E = await linkWorld({ links: [GAP], npcs: true, saveKey: 'links-reach' }); let from = null;
    E.events.on('link:enter', ev => { from = { ...ev.crossing.from }; });
    E.npcs.add({ id: 'r', name: 'R', position: [-5, 0, 0], schedule: [{ at: 0, position: [5, 0, 0] }] });
    for (let i = 0; i < 600 && !from; i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(r => setTimeout(r, 1)); }
    const start = E.nav.links[0].from; E.dispose();
    return { from, start };
  };
  window.LADDER = { id: 'ladder', from: [0.8, 0, 0], to: [0.8, 3, 0] };
};

export const specs = [
  {
    name: '[guard] nav: engine.dispose() frees the Recast objects (navMesh / query / tileCache / crowd live in the WASM heap)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
        const g = new THREE.Group(), f = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()); f.name = 'floor'; g.add(f);
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'nav-dispose' });
        E.use(world(), collision(), characters({ npcs: false }), level({ scene: g }), nav());
        await E.start();
        for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        const freed = [];
        for (const k of ['navMesh', 'query', 'tileCache', 'crowd']) { const o = E.nav[k]; if (o?.destroy) { const d = o.destroy.bind(o); o.destroy = () => { freed.push(k); d(); }; } }
        const N = E.nav, ready = N.ready;
        E.dispose();
        return { ready, freed, after: N.navMesh ?? null };
      });
      check('the navmesh was built, and engine.dispose() destroyed it and its query', r.ready && r.freed.includes('navMesh') && r.freed.includes('query') && r.after === null, JSON.stringify(r));
      const late = await ev(async () => {
        const { createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
        const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()));
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'nav-late' });
        E.use(world(), collision(), characters({ npcs: false }), level({ scene: g }));
        await E.start();
        E.use(nav());
        for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        const ready = E.nav.ready;
        E.dispose();
        return ready;
      });
      check('nav installed after the level loaded still builds its mesh', late === true, String(late));
    },
  },
  {
    name: 'nav: installed without a level mesh (procedural terrain), the A* stand-in is announced once, in dev',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, world, collision, characters, nav } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'nav-nomesh' });
        E.use(world(), collision(), characters({ npcs: false }), nav());
        await E.start();
        const seen = [], info = console.warn; console.warn = (...a) => { seen.push(a.join(' ')); };
        const p1 = E.characters.findPath({ x: 0, z: 0 }, { x: 3, z: 3 });
        E.characters.findPath({ x: 0, z: 0 }, { x: 4, z: 4 }); E.characters.findPathAsync({ x: 0, z: 0 }, { x: 4, z: 4 }, () => {});
        E.step(1 / 60);
        console.info = info;
        const ready = E.nav.ready; E.dispose();
        return { ready, seen: seen.filter(t => /nav/.test(t)), has: !!p1 };
      });
      check('no mesh: one warning naming nav and A*, though called three times', !r.ready && r.seen.length === 1 && /A\*/.test(r.seen[0]), JSON.stringify(r));
    },
  },
  {
    name: 'paths: findPathAsync with A* -- threads 0 and 2 give identical paths on identical steps, also across a collider change and a worker crash (threads test page)',
    url: '/tests/threads/',
    expectErrors: /worker failed/,
    async run({ check, ev }) {
      const r = await ev(twin, { useNav: false, n: 300 });
      check('threads 0 vs 2: every answer (step, status, path) identical, in the same order', r.same && r.counts[0] === r.n + 2, JSON.stringify({ ...r, firstDiff: r.firstDiff?.slice(0, 200) }));
      check('a crashed path worker hands its work to the main thread, answers unchanged', r.crashed, JSON.stringify(r.crashed));
      check('A* without nav reports ok / noPath', r.statuses.every(s => s === 'ok' || s === 'noPath') && r.statuses.includes('ok'), r.statuses.join());
    },
  },
  {
    name: 'paths: findPathAsync main-thread cost -- no crash, no state change: threads 2 uses worker answers (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      for (const useNav of [false, true]) {
        const n = useNav ? 300 : 300, r = await ev(twin, { useNav, n, crash: false, change: false });
        check(`${useNav ? 'navmesh' : 'A*'}: identical answers, threads 2 used worker results (how many depends on machine speed)`, r.same && r.stats[1].late < r.stats[1].applied, JSON.stringify({ ...r, firstDiff: undefined }));
        console.log(`   ${n} ${useNav ? 'navmesh' : 'A*'} paths, main-thread ms: sync findPath ${r.syncMs}; findPathAsync (all steps) threads 0 ${r.ms[0]}, threads 2 ${r.ms[1]}; late ${r.stats[1].late}/${r.stats[1].applied}`);
      }
    },
  },
  {
    name: 'paths: findPathAsync with the navmesh -- worker Recast copy answers like the main thread, notReady vs noPath stay distinct (threads test page)',
    url: '/tests/threads/',
    expectErrors: /worker failed/,
    async run({ check, ev }) {
      const r = await ev(twin, { useNav: true, n: 120 });
      check('threads 0 vs 2: every navmesh answer identical (imported mesh in the worker = live mesh here)', r.same && r.counts[0] === r.n + 2, JSON.stringify({ ...r, firstDiff: r.firstDiff?.slice(0, 200) }));
      check('a goal off the mesh is noPath, not notReady', /^far@\d+:noPath:null$/.test(r.far || ''), r.far);
      const s = await ev(async () => {
        const { createEngine, world, collision, characters, level, nav, THREE } = threedogThreads;
        const g = new THREE.Group(), f = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()); f.name = 'floor'; g.add(f);
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, threads: 2, urlState: false, saveKey: 'pathnr' });
        E.use(world(), collision(), characters({ npcs: false }), level({ scene: g }), nav());
        await E.start();
        E.nav.dispose();   // installed but not ready: A* stands in and says so
        const got = [];
        E.characters.findPathAsync({ x: 0, z: 0 }, { x: 5, z: 5 }, (p, st) => got.push(st));
        for (let i = 0; i < 10; i++) E.step(1 / 60);
        let bad = ''; try { E.characters.findPathAsync({ x: 0, z: 0 }, { x: 1, z: 1 }); } catch (err) { bad = err.message; }
        E.dispose();
        return { got, bad };
      });
      check('nav installed but not ready: notReady (with the A* stand-in path)', s.got[0] === 'notReady', JSON.stringify(s));
      check('missing done callback: the error says what to pass', /done must be a function/.test(s.bad), s.bad);
    },
  },
  {
    name: 'paths: nav links -- a path crosses a link, both ways or one way, keeps it through an obstacle rebuild and in the worker (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(platforms);
      const r = await ev(async () => {
        const a = { x: -5, z: 0 }, b = { x: 5, z: 0 }, legs = p => p?.filter(q => q.link).map(q => q.link) ?? null;
        const none = await linkWorld({ links: [] }), two = await linkWorld({ links: [GAP] }), one = await linkWorld({ links: [{ ...GAP, oneWay: true }] });
        const out = {
          none: none.nav.findPath(a, b, { detailed: true }).status, plain: none.nav.findPath(a, { x: -3, z: 3 }),
          there: two.characters.findPath(a, b), back: two.nav.findPath(b, a), oneThere: one.nav.findPath(a, b), oneBack: one.nav.findPath(b, a, { detailed: true }).status,
          described: two.describe().nav,
        };
        out.legs = legs(out.there); out.backLegs = legs(out.back);
        // an obstacle in the link's tile (not on its landing) rebuilds that tile; one on the landing cuts the link until it goes
        const rev = two.nav.revision, far = two.collision.addBox([-5, 0, -4], { halfWidth: 1, halfDepth: 1 });
        two.step(1 / 60);
        out.rebuilt = two.nav.revision > rev; out.kept = legs(two.nav.findPath(a, b));
        const land = two.collision.addBox([-2.2, 0, 0], { halfWidth: 1.5, halfDepth: 7 });
        two.step(1 / 60);
        out.cut = two.nav.findPath(a, b);
        land.remove(); far.remove(); two.step(1 / 60);
        out.back2 = legs(two.nav.findPath(a, b));
        none.dispose(); two.dispose(); one.dispose();
        return out;
      });
      check('without the link the platforms have no path, and a walk on one platform has no link', r.none === 'noPath' && r.plain?.length >= 2 && r.plain.every(p => !('link' in p)), JSON.stringify(r));
      check('with it characters.findPath crosses, the leg says so, with its id and both ends in 3D', r.legs?.length === 1 && r.legs[0].id === 'gap' && r.legs[0].from.y < 0.2 && r.legs[0].to.y > 1.3 && r.legs[0].from.x < 0 && r.legs[0].to.x > 0, JSON.stringify(r.legs));
      check('the next point on the path is the link\'s far end', (() => { const i = r.there.findIndex(p => p.link); return Math.hypot(r.there[i + 1].x - r.legs[0].to.x, r.there[i + 1].z - r.legs[0].to.z) < 1e-4; })(), JSON.stringify(r.there));
      check('two-way: the way back crosses it the other way round', r.backLegs?.length === 1 && r.backLegs[0].from.y > 1.3 && r.backLegs[0].to.y < 0.2, JSON.stringify(r.backLegs));
      check('one way: there yes, back no', r.oneThere?.some(p => p.link) && r.oneBack === 'noPath', JSON.stringify([r.oneThere, r.oneBack]));
      check('describe().nav counts links', r.described.links === 1, JSON.stringify(r.described));
      check('a tile rebuilt around an obstacle keeps the link', r.rebuilt && r.kept?.length === 1, JSON.stringify([r.rebuilt, r.kept]));
      check('an obstacle on the landing cuts the link, and removing it brings the link back', r.cut === null && r.back2?.length === 1, JSON.stringify([r.cut, r.back2]));
      const w = await ev(async () => {
        const E = await linkWorld({ links: [GAP], threads: 2 });
        const ask = async () => { const got = []; E.characters.findPathAsync({ x: -5, z: 0 }, { x: 5, z: 0 }, (p, st) => got.push({ p, st })); for (let i = 0; i < 400 && !got.length; i++) { E.step(1 / 60); await new Promise(r => setTimeout(r, 2)); } return got[0]; };
        const sync = E.characters.findPath({ x: -5, z: 0 }, { x: 5, z: 0 }), first = await ask();
        const box = E.collision.addBox([-5, 0, -4], { halfWidth: 1, halfDepth: 1 });
        E.step(1 / 60);
        const syncAfter = E.characters.findPath({ x: -5, z: 0 }, { x: 5, z: 0 }), after = await ask();
        // the lane itself, awaited: no timing, and land()'s main-thread answer cannot stand in. lane.handler exists only once the main thread has answered for it
        const lane = [...E.threads.lanes].find(l => /pathWorker/.test(l.create.toString()));
        const req = { mode: 'nav', size: E.nav.mesh().size, s: { x: -5, y: E.surface(-5, 0), z: 0 }, g: { x: 5, y: E.surface(5, 0), z: 0 }, reach: E.nav.reach(), body: E.movement.height };
        const direct = (await lane.run({ type: 'batch', reqs: [req], tiles: {}, trees: [] }))[0];
        const size = E.threads.size, workers = lane.size, local = !!lane.handler;
        box.remove(); E.dispose();
        return { sync, first, syncAfter, after, direct, size, workers, local };
      });
      check('worker route: the async answer equals the sync one, link leg included', w.first?.st === 'ok' && w.size === 2 && JSON.stringify(w.first.p) === JSON.stringify(w.sync) && w.sync.some(p => p.link?.id === 'gap'), JSON.stringify(w));
      check('worker route: after an obstacle the re-sent mesh still has the link', w.after?.st === 'ok' && JSON.stringify(w.after.p) === JSON.stringify(w.syncAfter) && w.after.p.some(p => p.link?.id === 'gap'), JSON.stringify(w.after));
      check('a real worker, on its imported mesh, answers with the link leg', w.workers > 0 && !w.local && w.direct?.status === 'ok' && JSON.stringify(w.direct.path) === JSON.stringify(w.syncAfter), JSON.stringify({ ...w, sync: 0, first: 0, after: 0 }));
      const bad = await ev(async () => {
        const warned = []; const warn = console.warn; console.warn = (...a) => { warned.push(a.join(' ')); };
        const E = await linkWorld({ links: [{ id: 'nowhere', from: [-2.2, 0, 0], to: [-2.2, 6, 30] }] });
        console.warn = warn; E.dispose();
        return warned.filter(t => /nowhere/.test(t));
      });
      check('a link that joins nothing says so at the build', bad.length === 1 && /nav-link|does not join/.test(bad[0]), JSON.stringify(bad));
    },
  },
  {
    name: 'paths: nav links on a real layout -- an end beside a tile edge joins, ends sit on the mesh, walkers step on at the start, an NPC replans round a new obstacle (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(platforms);
      const r = await ev(async () => {
        const step = async (E, done, max = 900) => { for (let i = 0; i < max && !done(); i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(res => setTimeout(res, 1)); } return done(); };
        // the mesh's tiles meet at x = 1.6 here: this end falls in the left tile, the ground it reaches in the right one
        const E = await linkWorld({ links: [{ id: 'edge', from: [-2.2, 0, 0], to: [1.5, 1.5, 0], radius: 1.6 }] });
        const legs = p => p?.filter(q => q.link).map(q => q.link.id) ?? null, a = { x: -5, z: 0 }, b = { x: 5, z: 0 }, l = E.nav.links[0];
        const out = { there: legs(E.nav.findPath(a, b)), back: legs(E.nav.findPath(b, a)), to: l.to.x, onMesh: E.nav.query.findNearestPoly(l.to, { halfExtents: { x: 0.1, y: 0.2, z: 0.1 } }).isOverPoly };
        const box = E.collision.addBox([-5, 0, -4], { halfWidth: 1, halfDepth: 1 });
        E.step(0.1, { render: false, describe: false });
        out.rebuilt = legs(E.nav.findPath(a, b));
        box.remove(); E.dispose();
        const C = await crossingWorld();
        out.steppedOn = C.from; out.start = C.start;
        // an obstacle that came after the path: the NPC does not stay pressed against it
        const W = await linkWorld({ links: [], npcs: true, deck: true, saveKey: 'links-wall' });
        const npc = W.npcs.add({ id: 'w', name: 'W', position: [-9, 0, 0], schedule: [{ at: 0, position: [-1, 0, 0] }] });
        await step(W, () => npc.position.x > -7.5);
        const wall = W.collision.addBox([npc.position.x + 1.5, 0, 0], { halfWidth: 0.4, halfDepth: 2.5 });
        out.round = await step(W, () => npc.position.x > -2);
        wall.remove(); W.dispose();
        return out;
      });
      check('a link whose far ground is across a tile edge joins, both ways', r.there?.[0] === 'edge' && r.back?.[0] === 'edge', JSON.stringify(r));
      check('nav.links holds the end as it sits on the mesh, past the edge', r.to > 1.6 && r.onMesh === true, JSON.stringify(r));
      check('a tile rebuilt round an obstacle keeps the moved link', r.rebuilt?.[0] === 'edge', JSON.stringify(r.rebuilt));
      check('an NPC starts a crossing at the link\'s start, not from its usual reach', Math.hypot(r.steppedOn.x - r.start.x, r.steppedOn.z - r.start.z) < 0.35, JSON.stringify([r.steppedOn, r.start]));
      check('an NPC pressed against an obstacle added after its path walks round it', r.round === true, JSON.stringify(r));
    },
  },
  {
    name: 'paths: nav links -- crowd NPCs through a real hatch: ends sit where recipe 12 says, a crossing starts at the end, nobody jams, none stops short of a goal past the landing (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(platforms);
      const r = await ev(async () => {
        const out = {};
        const E = await linkWorld({ links: [{ id: 'hatch', from: [0.6, 0, 0], to: [1, 3, 0] }], npcs: true, hatch: true, navOpts: { crowd: true }, saveKey: 'links-hatch' });
        const l = E.nav.links[0], enters = [], exits = [];
        out.flat = Math.hypot(l.from.x - l.to.x, l.from.z - l.to.z);
        E.events.on('link:enter', ev => enters.push({ ...ev.crossing.from }));
        E.events.on('link:exit', () => exits.push(1));
        const go = (id, position, to) => E.npcs.add({ id, name: id, position, schedule: [{ at: 0, position: to }] });
        const list = [go('a', [-8, 0, 0], [4, 3, 3]), go('b', [-9, 0, 1], [4, 3, -3]), go('c', [4, 3, 2], [-9, 0, 0]), go('d', [4, 3, -2], [-9, 0, 2])];
        const until = async (done, max) => { for (let i = 0; i < max && !done(); i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(r => setTimeout(r, 1)); } };
        await until(() => list.every(n => n.position.y > 2.9 === n.data.schedule[0].x > 0 && !n.data.nav.link && n.data.state === 'idle'), 1500);
        out.crowd = { ends: list.map(n => [n.position.x, n.position.y]), enters: enters.length, exits: exits.length };
        out.off = Math.max(...enters.map(p => Math.min(Math.hypot(p.x - l.from.x, p.z - l.from.z), Math.hypot(p.x - l.to.x, p.z - l.to.z))));
        E.dispose();
        // the agent walks on alone during a crossing: one that reaches a goal just past the landing must not leave its NPC standing short of it
        const F = await linkWorld({ links: [{ id: 'hatch', from: [0.6, 0, 0], to: [1, 3, 0] }], npcs: true, hatch: true, navOpts: { crowd: true }, saveKey: 'links-hatch2' });
        const land = F.nav.links[0].to, npc = F.npcs.add({ id: 'e', name: 'e', position: [-8, 0, 0], schedule: [{ at: 0, position: [land.x + 1.4, 3, 0] }] });
        for (let i = 0, left = 180; i < 1200 && left > 0; i++) { F.step(1 / 60, { render: false, describe: false }); if (npc.position.y > 2.9) left--; if (i % 40 === 0) await new Promise(r => setTimeout(r, 1)); }
        out.past = { short: Math.hypot(land.x + 1.4 - npc.position.x, npc.position.z), y: npc.position.y, arrive: npc.data.arriveDistance };
        F.dispose();
        return out;
      });
      check('in a hatch the top end sits past the opening, whatever the top given: the mesh stops 0.6 to 0.8 m from the edge (recipe 12)', r.flat > 0.6 && r.flat < 0.95, String(r.flat));
      check('two up and two down at once: everyone gets there, one crossing each', r.crowd?.enters === 4 && r.crowd.exits === 4 && r.crowd.ends.every(([x, y]) => (x > 0 ? Math.abs(y - 3) : Math.abs(y)) < 0.05), JSON.stringify(r.crowd));
      check('a crowd NPC starts a crossing at the link end, not where the crowd took the link', r.off <= 0.31, String(r.off));
      check('a crowd NPC reaches a goal just past the landing', Math.abs(r.past?.y - 3) < 0.05 && r.past.short < r.past.arrive, JSON.stringify(r.past));
      // recipe 57's ladder reads the keys by action name: a wrong name reads false for ever, so it could never climb down
      const names = [...readFileSync(new URL('../../docs/recipes/57-control.md', import.meta.url), 'utf8').matchAll(/input\.down\('(\w+)'\)/g)].map(m => m[1]);
      const unknown = await ev(async names => { const E = await linkWorld({ links: [] }); const bad = names.filter(n => !E.input.actions.has(n)); E.dispose(); return bad; }, names);
      check("recipe 57's ladder names actions that exist", names.length >= 2 && unknown.length === 0, JSON.stringify({ names, unknown }));
    },
  },
  {
    name: 'paths: nav links -- NPCs and walkTo cross, the game sets time and shape, a save mid-link resumes, crowd crosses (threads test page)',
    url: '/tests/threads/',
    async run({ check, ev }) {
      await ev(platforms);
      await ev(() => {
        // a world with an NPC walking from one platform to the other; events and the height at each step are logged
        window.crossing = async (opts = {}) => {
          const E = await linkWorld({ links: [GAP], npcs: true, ...opts }), log = [];
          E.events.on('link:enter', ev => { log.push('enter:' + ev.id + ':' + ev.crossing.link); opts.onEnter?.(ev); });
          E.events.on('link:exit', ev => log.push('exit:' + ev.id + ':' + ev.crossing.link + ':' + (ev.character ? 'model' : 'data')));
          const npc = E.npcs.add({ id: 'runner', name: 'Runner', position: [-5, 0, 0], schedule: [{ at: 0, position: opts.goal ?? [5, 0, 0] }] });
          const until = async (done, max = 900) => { for (let i = 0; i < max && !done(); i++) { E.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(r => setTimeout(r, 1)); } return done(); };
          return { E, npc, log, until, link: () => npc.data.nav.link };
        };
      });
      const r = await ev(async () => {
        const out = {};
        { // nothing from the game: straight line at walking speed
          const { E, npc, log, until, link } = await crossing();
          await until(() => link());
          const c = link(), ys = [], t0 = E.time.tick;
          out.start = { ...c };
          await until(() => { if (link()) ys.push([npc.position.x, npc.position.y]); return !link(); });
          out.ticks = E.time.tick - t0; out.ys = ys.filter((_, i) => i % 8 === 0);
          await until(() => Math.hypot(npc.position.x - 5, npc.position.z) < 1.2);
          out.plain = { x: npc.position.x, y: npc.position.y, z: npc.position.z, log, pathLeft: (npc.data.nav.path ?? []).filter(p => p.link).length };
          E.dispose();
        }
        { // the game: 0.5 s, and a hop
          const { E, npc, log, until, link } = await crossing({ onEnter: ev => { ev.crossing.seconds = 0.5; } });
          let peak = 0, args = null;
          E.characters.linkPose = (t, p, c, ch) => { p.y += Math.sin(t * Math.PI) * 2; peak = Math.max(peak, p.y); args = [typeof t, c.link, ch === npc.character]; };
          await until(() => link());
          const t0 = E.time.tick;
          await until(() => !link());
          out.hop = { steps: E.time.tick - t0, peak, args, y: npc.position.y, log };
          E.dispose();
        }
        { // save halfway: the same spot after a load, on the same curve, one exit and no second enter; the straight run is the reference
          const { E, npc, log, until, link } = await crossing({ saveKey: 'links-mid' });
          E.characters.linkPose = (t, p) => { p.y += Math.sin(t * Math.PI); };
          await until(() => link() && link().time > link().seconds * 0.4);
          await E.saves.save('mid');
          const at = () => [npc.position.x, npc.position.y, npc.position.z];
          const saved = at(), savedLink = { ...link() };
          E.step(1 / 60, { render: false, describe: false });
          const next = at();
          await until(() => !link());
          const straight = at(), logBefore = log.length;
          await E.saves.load('mid');
          const loaded = { link: npc.data.nav.link ? { ...npc.data.nav.link } : null, data: { ...npc.data.position } };
          E.step(1 / 60, { render: false, describe: false });
          const resumed = at(), hanging = !!link();
          await until(() => !link());
          out.save = { saved, savedLink, next, loaded, resumed, hanging, landed: at(), straight, log: log.slice(logBefore), logBefore };
          E.dispose();
        }
        { // a save with a path over a link but not on it yet keeps the leg, and a teleport mid-link ends the crossing
          const { E, npc, log, until, link } = await crossing();
          await until(() => link());
          npc.placeAt([-5, 0, 3]);
          out.teleport = { link: link() ?? null, x: npc.position.x, log: [...log] };
          E.dispose();
        }
        { // out of range mid-crossing: no model to cross with, it lands at the far end
          const { E, npc, log, until, link } = await crossing();
          await until(() => link());
          E.world.anchor = { x: 900, z: 900 };
          await until(() => !link(), 400);
          out.far = { link: link() ?? null, position: { ...npc.data.position }, log };
          E.dispose();
        }
        { // walkTo: the same crossing, without an NPC schedule
          const { E, npc, log, until } = await crossing();
          npc.data.schedule.length = 0;
          await until(() => npc.character);
          let st = null; npc.character.walkTo({ x: 5, z: 0 }).then(x => { st = x.status; });
          await until(() => st);
          out.walk = { st, x: npc.position.x, y: npc.position.y, log: [...log] };
          let st2 = null; const walk = npc.character.walkTo({ x: -5, z: 0 }); walk.then(x => { st2 = x.status; });
          await until(() => log.length > 2);
          walk.remove(); await new Promise(r => setTimeout(r, 1));
          out.cut = { st2, y: npc.position.y, x: npc.position.x, log: log.slice(2) };
          E.dispose();
        }
        { // crowd: Recast's own traversal hands over to the same crossing
          const { E, npc, log, until } = await crossing({ navOpts: { crowd: true } });
          await until(() => Math.hypot(npc.position.x - 5, npc.position.z) < 1.2, 1500);
          out.crowd = { x: npc.position.x, y: npc.position.y, log };
          E.dispose();
        }
        { // rooted beside the link: a crossing at speed 0 would never end
          let seen = null;
          const { E, npc, log, until, link } = await crossing({ onEnter: ev => { seen = ev.crossing; } });
          E.mod('move.speed', { owner: 'root', id: 'runner', set: 0 });
          const foot = E.characters.findPath({ x: -5, z: 0 }, { x: 5, z: 0 }).find(p => p.link);
          npc.placeAt([foot.x - 0.2, 0, foot.z]);
          await until(() => log.length >= 2, 300);
          out.rooted = { seconds: seen?.seconds, link: link() ?? null, y: npc.position.y, log };
          E.dispose();
        }
        { // damaged crossing data is refused before anything changes; what the engine wrote itself loads
          const { E, npc, until, link } = await crossing();
          await until(() => npc.data.nav.path?.some(p => p.link));
          const snap = () => JSON.parse(JSON.stringify(E.world.toJSON())), walking = snap();
          await until(() => link());
          const crossingNow = snap();
          const tryLoad = (from, damage) => { const d = JSON.parse(JSON.stringify(from)); damage(d.records.runner.nav); try { E.world.fromJSON(d); return 'loaded'; } catch (err) { return err.message; } };
          const legOf = nav => nav.path.find(p => p.link);
          out.damage = {
            number: tryLoad(crossingNow, n => { n.link = 5; }), to: tryLoad(crossingNow, n => { n.link.to = { x: 'a', y: 0, z: 0 }; }), seconds: tryLoad(crossingNow, n => { n.link.seconds = null; }), time: tryLoad(crossingNow, n => { delete n.link.time; }),
            pathNumber: tryLoad(walking, n => { legOf(n).link = 5; }), pathTo: tryLoad(walking, n => { legOf(n).link.to.y = 1e12; }),
            stepsOn: !!link(), good: [tryLoad(walking, () => {}), tryLoad(crossingNow, () => {})],
          };
          E.dispose();
        }
        { // a cutscene takes an NPC mid-crossing: it lands, and nothing snaps it back when the cutscene ends
          const { E, npc, log, until, link } = await crossing();
          await until(() => link() && link().time > 0.1);
          const h = E.control.take('runner', { owner: 'scene', layer: 'cutscene' });
          E.step(1 / 60, { render: false, describe: false });
          const landed = { link: link() ?? null, x: npc.position.x, y: npc.position.y };
          for (let i = 0; i < 30; i++) E.step(1 / 60, { render: false, describe: false });
          h.remove();
          E.step(1 / 60, { render: false, describe: false });
          out.held = { landed, x: npc.position.x, y: npc.position.y, log };
          E.dispose();
        }
        { // the same for a walk's crossing, and the walk carries on after the cutscene
          const { E, npc, log, until } = await crossing();
          npc.data.schedule.length = 0;
          await until(() => npc.character);
          let st = null; npc.character.walkTo({ x: 5, z: 0 }).then(x => { st = x.status; });
          await until(() => log.length);
          const h = E.control.take('runner', { owner: 'scene', layer: 'cutscene' });
          E.step(1 / 60, { render: false, describe: false });
          const landed = { y: npc.position.y, log: [...log] };
          h.remove();
          await until(() => st);
          out.walkHeld = { landed, st, x: npc.position.x, y: npc.position.y, log };
          E.dispose();
        }
        { // straight up and down: a goal on the deck within arrive of the ladder's foot in x, z is reached on the deck
          const { E, npc, log, until, link } = await crossing({ links: [LADDER], deck: true, goal: [1.2, 3, 0] });
          out.ladderPath = E.characters.findPath({ x: -5, z: 0 }, { x: 5, z: 0 });
          await until(() => log.length >= 2 && !link());
          await until(() => npc.data.state === 'idle', 120);
          out.ladderNpc = { x: npc.position.x, y: npc.position.y, log: [...log] };
          npc.data.schedule.length = 0;
          out.ladderFirst = E.characters.findPath(npc.position, { x: -5, z: 0 })[0].link;
          let down = null; npc.character.walkTo({ x: -5, z: 0 }).then(x => { down = x.status; });
          await until(() => down);
          out.ladderDown = { st: down, x: npc.position.x, y: npc.position.y, log: log.slice(2) };
          let up = null; npc.character.walkTo({ x: 1, z: 0 }).then(x => { up = x.status; });
          await until(() => up);
          out.ladderUp = { st: up, x: npc.position.x, y: npc.position.y, log: log.slice(4) };
          E.dispose();
        }
        { // the crowd on a steep ladder (Recast's own traversal takes no time on a link with no length in x, z, so a crowd needs some: recipe 12)
          const { E, npc, log, until } = await crossing({ links: [{ ...LADDER, to: [1.2, 3, 0] }], deck: true, navOpts: { crowd: true }, goal: [-5, 0, 0] });
          npc.placeAt([5, 3, 0]);
          await until(() => Math.hypot(npc.position.x + 5, npc.position.z) < 1.3, 1500);
          out.ladderCrowd = { x: npc.position.x, y: npc.position.y, log };
          E.dispose();
        }
        return out;
      });
      const near = (a, b, d) => Math.abs(a - b) <= d;
      check('with no game code an NPC gets across and stands on the far platform', near(r.plain?.x, 5, 1.3) && near(r.plain?.y, 1.5, 0.05), JSON.stringify(r.plain));
      check('the game hears it reach the link and leave it, once each', r.plain?.log.join() === 'enter:runner:gap,exit:runner:gap:model', JSON.stringify(r.plain?.log));
      check('the default is a straight line at walking speed', r.ys?.every(([, y], i, a) => !i || y >= a[i - 1][1] - 1e-6) && near(r.ticks / 60, r.start.seconds, 0.05) && r.start.seconds > 0.5, JSON.stringify({ ys: r.ys, ticks: r.ticks, start: r.start }));
      check('crossing.seconds set at link:enter is how long it takes', near(r.hop?.steps / 60, 0.5, 0.05), JSON.stringify(r.hop));
      check('linkPose bends the line, and it lands where it should', r.hop?.peak > 2 && near(r.hop.y, 1.5, 0.05) && r.hop.args?.join() === 'number,gap,true', JSON.stringify(r.hop));
      const s = r.save;
      check('the crossing is in the save and the record', s?.loaded.link?.link === 'gap' && near(s.loaded.link.time, s.savedLink.time, 1e-9), JSON.stringify(s));
      check('after a load it goes on from the same spot', s && s.resumed.every((v, i) => near(v, s.next[i], 1e-6)) && s.hanging, JSON.stringify(s));
      check('after a load it lands like the run that was not saved', s && s.landed.every((v, i) => near(v, s.straight[i], 1e-6)) && near(s.landed[1], 1.5, 0.05), JSON.stringify(s));
      check('after a load link:exit comes once and link:enter does not repeat', s?.log.join() === 'exit:runner:gap:model', JSON.stringify(s?.log));
      check('npc.placeAt mid-crossing ends it, and link:exit still comes', r.teleport?.link === null && near(r.teleport.x, -5, 0.01) && r.teleport.log[1]?.startsWith('exit:'), JSON.stringify(r.teleport));
      check('out of range mid-crossing the data lands at the far end', r.far?.link === null && r.far.position.x > 1.5 && near(r.far.position.y, 1.5, 0.3) && r.far.log[1] === 'exit:runner:gap:data', JSON.stringify(r.far));
      check('walkTo crosses too', r.walk?.st === 'arrived' && near(r.walk.y, 1.5, 0.05) && r.walk.log.length === 2, JSON.stringify(r.walk));
      check('a walk cancelled mid-crossing lands at the far end with its link:exit', r.cut?.st2 === 'cancelled' && near(r.cut.y, 0, 0.2) && r.cut.x < -1 && r.cut.log.length === 2, JSON.stringify(r.cut));
      const refused = (t, where) => new RegExp(`records\\.runner\\.nav\\.${where}.*refused`).test(t ?? '');
      check('speed 0 at a link start: the crossing ends instead of hanging', r.rooted?.seconds === 0 && r.rooted.link === null && near(r.rooted.y, 1.5, 0.05) && r.rooted.log.length === 2, JSON.stringify(r.rooted));
      const dm = r.damage;
      check('a damaged crossing is refused: not an object, a bad end, no seconds, no time', refused(dm?.number, 'link') && refused(dm?.to, 'link\\.to') && refused(dm?.seconds, 'link\\.seconds') && refused(dm?.time, 'link\\.time'), JSON.stringify(dm));
      check('a damaged link on a path point is refused', refused(dm?.pathNumber, 'path\\.\\d+\\.link') && refused(dm?.pathTo, 'path\\.\\d+\\.link\\.to'), JSON.stringify(dm));
      check('a refused load changes nothing, and undamaged link data loads', dm?.stepsOn && dm.good.join() === 'loaded,loaded', JSON.stringify(dm));
      check('a cutscene mid-crossing: the NPC lands at the far end at once, link:exit once', r.held?.landed.link === null && near(r.held.landed.y, 1.5, 0.05) && r.held.landed.x > 1.5 && r.held.log.join() === 'enter:runner:gap,exit:runner:gap:model', JSON.stringify(r.held));
      check('and it is not snapped back when the cutscene ends', r.held && near(r.held.x, r.held.landed.x, 0.2) && near(r.held.y, 1.5, 0.05), JSON.stringify(r.held));
      check('a cutscene during a walk\'s crossing lands it too, and the walk then arrives', near(r.walkHeld?.landed.y, 1.5, 0.05) && r.walkHeld.landed.log.length === 2 && r.walkHeld.st === 'arrived' && r.walkHeld.log.length === 2 && near(r.walkHeld.x, 5, 0.6), JSON.stringify(r.walkHeld));
      const ladderLeg = r.ladderPath?.find(p => p.link)?.link;
      check('a vertical link is on the path, its ends at one x, z', ladderLeg?.id === 'ladder' && near(ladderLeg.from.x, ladderLeg.to.x, 1e-3) && near(ladderLeg.from.z, ladderLeg.to.z, 1e-3) && ladderLeg.to.y - ladderLeg.from.y > 2.5, JSON.stringify(r.ladderPath));
      check('an NPC whose goal is near the ladder\'s foot in x, z climbs: it stops on the deck', near(r.ladderNpc?.y, 3, 0.05) && r.ladderNpc.log.join() === 'enter:runner:ladder,exit:runner:ladder:model', JSON.stringify(r.ladderNpc));
      check('standing exactly on a link end, the path still starts with the link', r.ladderFirst?.id === 'ladder' && r.ladderFirst.to.y < 0.2, JSON.stringify(r.ladderFirst));
      check('walkTo climbs down a vertical link', r.ladderDown?.st === 'arrived' && near(r.ladderDown.y, 0, 0.05) && near(r.ladderDown.x, -5, 0.6) && r.ladderDown.log.length === 2, JSON.stringify(r.ladderDown));
      check('walkTo does not finish at the foot of a ladder to a goal above it', r.ladderUp?.st === 'arrived' && near(r.ladderUp.y, 3, 0.05) && r.ladderUp.log.length === 2, JSON.stringify(r.ladderUp));
      check('a crowd NPC comes down a steep link', near(r.ladderCrowd?.y, 0, 0.05) && r.ladderCrowd.log.join() === 'enter:runner:ladder,exit:runner:ladder:model', JSON.stringify(r.ladderCrowd));
      check('crowd NPC crosses, with the same events', near(r.crowd?.x, 5, 1.3) && near(r.crowd?.y, 1.5, 0.05) && r.crowd.log.join() === 'enter:runner:gap,exit:runner:gap:model', JSON.stringify(r.crowd));
    },
  },
];
