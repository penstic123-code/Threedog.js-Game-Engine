// A collider with a `layer` blocks every mover except those whose `passes` names it (a gate pigs walk through and enemies do not).
// Held here for every reader of collision: resolve (the simple mover), walkableAt, A* (sync, async, workers), the navmesh (sync, async, workers),
// walkTo and NPCs. And the other half: a mover without passes, or a collider without a layer, behaves exactly as before.
const PAGE = '/tests/threads/';

const run = async ({ threads, withNav }) => {
  const { mk, THREE } = threedogThreads, T = threedogThreads.all, out = {};
  const m = new THREE.MeshBasicMaterial(), g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), m); floor.name = 'floor'; g.add(floor);
  // a wall across z = 0 with a 4 m gap at x = -10 (the gate goes there) and a 4 m one at x = 15 (one long way round)
  for (const [n, a, b] of [['col_a', -20, -12], ['col_b', -8, 13], ['col_c', 17, 20]]) { const w = new THREE.Mesh(new THREE.BoxGeometry(b - a, 3, 1), m); w.name = n; w.position.set((a + b) / 2, 1.5, 0); g.add(w); }
  const E = mk(T.createEngine, 'layers' + threads + withNav, { threads });
  E.use(T.world(), T.collision(), T.characters({ npcs: true }), T.level({ scene: g }), ...(withNav ? [T.nav()] : []));
  await E.start(); E.haltLoop();
  for (let i = 0; withNav && i < 100 && !E.nav.ready; i++) await new Promise(r => setTimeout(r, 50));
  const step = () => E.step(1 / 60, { render: false, describe: false });
  step();
  const col = E.collision;
  // which way: -10 through the gate, 'round' past either end of the wall (A* also walks round its far end, off the level's floor)
  const crossing = p => { if (!p) return null; const q = p.find((c, i) => i && Math.sign(c.z) !== Math.sign(p[i - 1].z)); return !q ? null : Math.abs(q.x + 10) < 3 ? -10 : 'round'; };
  const via = o => crossing(E.characters.findPath([-10, 0, -6], [-10, 0, 6], o));
  const later = async o => {
    let got = null; E.characters.findPathAsync([-10, 0, -6], [-10, 0, 6], path => { got = path; }, o);
    for (let i = 0; i < 400 && !got; i++) { step(); await new Promise(r => setTimeout(r, 1)); }
    return crossing(got);
  };
  out.open = via();
  // the old behaviour first: a plain gate box blocks everyone, also a mover that passes some layer
  const plain = col.addBox([-10, 0, 0], { halfWidth: 2.2, halfDepth: 0.5 }); step();
  out.plain = [via(), via({ passes: ['gate'] })];
  out.plainPath = JSON.stringify(E.characters.findPath([-10, 0, -6], [-10, 0, 6]));
  plain.remove(); step();
  const gate = col.addBox([-10, 0, 0], { halfWidth: 2.2, halfDepth: 0.5, layer: 'gate' }); step();
  out.layeredPath = JSON.stringify(E.characters.findPath([-10, 0, -6], [-10, 0, 6]));
  out.sync = [via(), via({ passes: ['gate'] }), via({ passes: ['other'] }), via({ passes: ['other', 'gate'] })];
  // one layer named "gate,x" is not the two layers gate and x: each list gets its own navmesh, whichever is asked first
  out.comma = [via({ passes: ['gate,x'] }), via({ passes: ['gate', 'x'] })];
  out.async = [await later(), await later({ passes: ['gate'] })];
  const p0 = { x: -10, y: 0, z: 0 }, p1 = { x: -10, y: 0, z: 0 };
  out.resolve = [col.resolve(p0, 0.3), col.resolve(p1, 0.3, ['gate'])];
  out.walkable = [col.walkableAt(-10, 0, 0.3), col.walkableAt(-10, 0, 0.3, undefined, ['gate']), col.walkable([-10, 0, 0], { passes: ['gate'] })];
  try { col.addBox([0, 0, 9], { layer: 3 }); } catch (err) { out.badLayer = err.message; }
  try { E.characters.findPath([0, 0, -6], [0, 0, 6], { passes: 'gate' }); } catch (err) { out.badPasses = err.message; }
  // bodies: a pig walks through the gate, an enemy walking the same line is held at it
  const pig = E.characters.addPlayer({ control: 'camera', spawn: { x: -10, z: -6 }, passes: ['gate'] });
  let res = null; pig.walkTo([-10, 0, 6]).then(v => { res = v; });
  for (let i = 0; i < 1500 && !res; i++) { step(); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
  out.pig = [res?.status, +pig.position.x.toFixed(0), +pig.position.z.toFixed(1)];
  const N = E.npcs.add({ id: 'pig2', name: 'P', position: [-10, 0, -6], passes: ['gate'], schedule: [{ at: 0, position: [-10, 0, 6] }] });
  const W = E.npcs.add({ id: 'wolf', name: 'W', position: [-11, 0, -6], schedule: [{ at: 0, position: [-11, 0, 6] }] });
  // the wolf is never inside the gate's box (|x + 10| < 2.2, |z| < 0.5) at any step; where it ends up depends on the way round, which this does not judge
  let wolfIn = false;
  for (let i = 0; i < 1500; i++) {
    step(); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0));
    if (Math.abs(W.position.x + 10) < 2.2 && Math.abs(W.position.z) < 0.5) wolfIn = true;
    if (N.position.z > 5 && i > 900) break;
  }
  out.npc = [+N.position.x.toFixed(0), +N.position.z.toFixed(0)];
  out.wolfThrough = wolfIn;
  gate.remove(); step();
  out.removed = via();
  E.dispose();
  return out;
};

export const specs = [
  {
    name: 'collision layers: a gate lets only the movers that pass its layer through -- resolve, walkableAt, A* and navmesh paths, sync, async and workers, walkTo and NPCs; without the option nothing changes (threads test page)',
    url: PAGE,
    async run({ check, ev }) {
      for (const withNav of [false, true]) {
        const r = await ev(run, { threads: 0, withNav }), w = await ev(run, { threads: 2, withNav }), J = JSON.stringify(r), k = withNav ? 'navmesh: ' : 'A*: ';
        check(k + 'open gap: the short way', r.open === -10, J);
        check(k + 'a gate without a layer blocks everyone, passes or not (as before)', r.plain.join() === 'round,round', J);
        check(k + 'a layered gate gives a mover without passes the very path a plain one does', r.layeredPath === r.plainPath, J);
        check(k + 'findPath: blocked without passes, through with the layer named, blocked for another layer', r.sync.join() === 'round,-10,round,-10', J);
        check(k + 'findPathAsync: the same', r.async.join() === 'round,-10', J);
        check(k + 'passes ["gate,x"] (one layer) and ["gate", "x"] (two) are different bodies: only the second goes through', r.comma.join() === 'round,-10', J);
        check(k + 'resolve pushes out a mover without passes only', r.resolve.join() === 'true,false', J);
        check(k + 'walkableAt / walkable follow passes', r.walkable.join() === 'false,true,true', J);
        check(k + 'a layer that is no string, and passes that are no list, are refused at the call', /layer/.test(r.badLayer ?? '') && /passes/.test(r.badPasses ?? ''), J);
        check(k + 'walkTo: the pig goes through the gate', r.pig[0] === 'arrived' && r.pig[2] > 5, J);
        check(k + 'NPC with passes goes through the gate; one without never does', r.npc[1] > 4 && r.npc[0] === -10 && !r.wolfThrough, J);
        check(k + 'remove() reopens the way', r.removed === -10, J);
        check(k + 'workers give the same answers', JSON.stringify({ ...w, badLayer: 0, badPasses: 0 }) === JSON.stringify({ ...r, badLayer: 0, badPasses: 0 }), JSON.stringify(w));
      }
    },
  },
  {
    name: 'collision layers: the rapier mover goes through a layered collider only when its passes name the layer; a plain collider still stops it (threads test page)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all, out = {};
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()); floor.name = 'floor';
        const g = new THREE.Group(); g.add(floor);
        const E = mk(T.createEngine, 'layers-rapier', {});
        E.use(T.world(), T.collision(), T.characters(), T.level({ scene: g }), T.rigid());
        await E.start(); E.haltLoop();
        const step = () => E.step(1 / 60, { render: false, describe: false });
        E.collision.addBox([-10, 0, 0], { halfWidth: 2.2, halfDepth: 0.5, layer: 'gate' });
        E.collision.addBox([10, 0, 0], { halfWidth: 2.2, halfDepth: 0.5 });
        const walk = (x, passes) => {
          const P = E.characters.addPlayer({ control: 'camera', spawn: { x, z: -3 }, mover: 'rapier', ...(passes ? { passes } : {}) });
          for (let i = 0; i < 30; i++) step();   // the mirror and the capsule are built on steps
          const h = E.control.take(P, { owner: 'test', layer: 'script' });
          for (let i = 0; i < 150; i++) { h.move(0, 1, false, 1 / 60); step(); }
          const z = +P.position.z.toFixed(1), mover = P.mover?.name; h.remove(); E.characters.removePlayer(); return [mover, z];
        };
        out.gatePig = walk(-10, ['gate']); out.gateWolf = walk(-10); out.plainPig = walk(10, ['gate']);
        E.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('the rapier mover ran', r.gatePig[0] === 'rapier', J);
      check('passes the layer: through the gate', r.gatePig[1] > 1, J);
      check('no passes: stopped at the gate', r.gateWolf[1] < 0, J);
      check('a collider without a layer stops it whatever its passes', r.plainPig[1] < 0, J);
    },
  },
  {
    // the layer test reads the rigid module the controller was built for: kept from the first one, a replaced rigid's colliders were all "no layer" and the gate stopped the pig
    name: 'collision layers: after rigid is replaced, the same rapier mover still goes through its layer (threads test page)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all;
        const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()));
        const E = mk(T.createEngine, 'layers-rapier-swap', {});
        E.use(T.world(), T.collision(), T.characters(), T.level({ scene: g }), T.rigid());
        await E.start(); E.haltLoop();
        const step = () => E.step(1 / 60, { render: false, describe: false });
        E.collision.addBox([-10, 0, 0], { halfWidth: 2.2, halfDepth: 0.5, layer: 'gate' });
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: -10, z: -3 }, mover: 'rapier', passes: ['gate'] });
        const walk = async () => {
          P.placeAt({ x: -10, y: 0, z: -3 });
          for (let i = 0; i < 300 && !(E.rigid?.ready && E.rigid.readyAt(P.position)); i++) { await new Promise(res => setTimeout(res, 10)); step(); }
          for (let i = 0; i < 30; i++) step();
          const h = E.control.take(P, { owner: 'test', layer: 'script' });
          for (let i = 0; i < 150; i++) { h.move(0, 1, false, 1 / 60); step(); }
          h.remove(); return [P.mover?.name, +P.position.z.toFixed(1)];
        };
        const first = await walk(), rigid = E.rigid;
        E.use(T.rigid(), { replaces: 'rigid' });
        const second = await walk(), swapped = E.rigid !== rigid;
        E.dispose();
        return { first, second, swapped };
      });
      const J = JSON.stringify(r);
      check('the first rigid: through the gate', r.first[0] === 'rapier' && r.first[1] > 1, J);
      check('a new rigid: still through, with the same mover', r.swapped && r.second[0] === 'rapier' && r.second[1] > 1, J);
    },
  },
  {
    // a level wall's custom property `layer` (userData.layer on a col_ mesh) is the collider's layer; content collide.layer goes through the same addBox
    name: 'collision layers: a col_ mesh with userData.layer lets passes through; a bad layer warns and stops everyone',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all, m = new THREE.MeshBasicMaterial(), g = new THREE.Group();
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), m); floor.name = 'floor'; g.add(floor);
        for (const [n, x, ud] of [['col_gate', -8, { layer: 'gate' }], ['col_plain', 8, {}], ['col_bad', 0, { layer: 3 }]]) {
          const w = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2), m); w.name = n; w.userData = ud; w.position.set(x, 1.5, 0); g.add(w);
        }
        // the property on the col_ object, its mesh a child (a collider object with parts, a mesh of two materials): read up the chain like occluder
        const grp = new THREE.Group(); grp.name = 'col_parted'; grp.userData = { layer: 'gate' }; grp.position.set(-16, 1.5, 0); g.add(grp);
        const kid = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2), m); kid.name = 'part'; grp.add(kid);
        const E = mk(T.createEngine, 'layer-col'); E.use(T.world(), T.collision(), T.level({ scene: g }));
        await E.start(); E.haltLoop(); E.step(1 / 60, { render: false, describe: false });
        const c = E.collision, at = (x, p) => c.walkableAt(x, 0, 0.3, undefined, p);
        return { gate: [at(-8), at(-8, ['gate'])], plain: [at(8), at(8, ['gate'])], parted: [at(-16), at(-16, ['gate'])], bad: [at(0), at(0, ['gate'])], warns: JSON.stringify(E.describe().warnings ?? []) };
      });
      const J = JSON.stringify(r);
      check('layered wall: blocks a plain mover, lets a mover with passes through', r.gate[0] === false && r.gate[1] === true, J);
      check('a layer on the col_ parent of the mesh counts too', r.parted[0] === false && r.parted[1] === true, J);
      check('a wall without layer, or with a non-text layer, stops everyone', r.plain[1] === false && r.bad[1] === false, J);
      check('the non-text layer is noticed (level-layer-ignored)', /level-layer-ignored/.test(r.warns), J);
    },
  },
  {
    // GLTFLoader 0.187 ignores KHR_node_visibility; the engine's loader plugin applies it (children follow through Object3D.visible)
    name: 'assets: a glTF node with KHR_node_visibility visible:false loads hidden',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'node-vis');
        const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_node_visibility'], scene: 0, scenes: [{ nodes: [0, 2] }],
          nodes: [{ name: 'hid', children: [1], extensions: { KHR_node_visibility: { visible: false } } }, { name: 'kid' }, { name: 'shown' }] };
        const g = await E.assets.gltf.parseAsync(JSON.stringify(json), '');
        const v = n => g.scene.getObjectByName(n).visible;
        return { hid: v('hid'), shown: v('shown'), kid: v('kid') };
      });
      check('the hidden node is not visible, the others are', r.hid === false && r.shown === true && r.kid === true, JSON.stringify(r));
    },
  },
];
