// Bodies of several sizes on one navmesh level: Recast bakes the radius into a mesh, so each size gets its own, built when first asked for.
// Held here: a path fits the body that asked, findPath, findPathAsync (workers too), walkTo and NPCs alike; obstacles, links and rebuilds reach every size; one size costs nothing extra.
const PAGE = '/tests/threads/';

const run = async ({ threads }) => {
  const { mk, THREE } = threedogThreads, T = threedogThreads.all, out = {};
  const m = new THREE.MeshBasicMaterial(), g = new THREE.Group();
  const part = (w, d, x, z, name) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m); p.name = name; p.position.set(x, 0, z); g.add(p); };
  part(40, 40, 0, 0, 'floor');
  // a wall across z = 0 with a 1.2 m gap at x = -10 and a 4 m one at x = 10
  for (const [n, a, b] of [['col_a', -20, -10.6], ['col_b', -9.4, 8], ['col_c', 12, 20]]) { const w = new THREE.Mesh(new THREE.BoxGeometry(b - a, 3, 1), m); w.name = n; w.position.set((a + b) / 2, 1.5, 0); g.add(w); }
  // north of it, apart: two platforms joined by a 1.2 m plank, the mesh's own edge and no obstacle
  part(8, 8, -6, 30, 'floor_a'); part(4, 1.2, 0, 30, 'floor_plank'); part(8, 8, 6, 30, 'floor_b');
  const E = mk(T.createEngine, 'sizes' + threads, { threads });
  E.use(T.world(), T.collision(), T.characters({ npcs: true }), T.level({ scene: g }), T.nav({ agentRadius: 0.8, links: [{ id: 'hop', from: [6, 0, 27], to: [6, 0, 19] }] }));
  await E.start(); E.haltLoop();
  for (let i = 0; i < 100 && !E.nav.ready; i++) await new Promise(r => setTimeout(r, 50));
  const step = () => E.step(1 / 60, { render: false, describe: false });
  step();
  const crossing = p => { if (!p) return null; const q = p.find((c, i) => i && Math.sign(c.z) !== Math.sign(p[i - 1].z)); return q.x < 0 ? -10 : 10; };   // which gap
  const via = (r, a = [-10, 0, -6], b = [-10, 0, 6]) => crossing(E.characters.findPath(a, b, r === undefined ? {} : { radius: r }));
  const later = async (a, b, radius) => {
    let got = null; E.characters.findPathAsync(a, b, (path, status) => { got = { path, status }; }, { radius });
    for (let i = 0; i < 400 && !got; i++) { step(); await new Promise(r => setTimeout(r, 1)); }
    return got;
  };
  const meshes = () => E.describe().nav.meshes;

  out.plain = via(); out.plainMeshes = meshes();
  out.sameCells = via(0.65); out.sameCellsMeshes = meshes();
  const t0 = performance.now();
  out.small = via(0.2); out.buildMs = +(performance.now() - t0).toFixed(1);
  out.smallMeshes = meshes();
  out.wide = via(1.7);
  out.tooWide = E.characters.findPath([-10, 0, -6], [-10, 0, 6], { radius: 2.5, detailed: true }).status;
  try { E.characters.findPath([0, 0, -6], [0, 0, 6], { radius: NaN }); } catch (err) { out.bad = err.message; }
  out.wider = via(0.85);   // in the agent's cells, but past its radius: obstacles must grow by more, so it is not the agent's mesh
  out.bytes = [...E.nav.meshes.values()].map(x => [x.cells, E.nav.exportMesh(x).length]);
  out.plank = [E.characters.findPath([-6, 0, 30], [6, 0, 30], { radius: 0.2, detailed: true }).status, E.characters.findPath([-6, 0, 30], [6, 0, 30], { detailed: true }).status];
  const hop = E.characters.findPath([6, 0, 30], [6, 0, 15], { radius: 0.2 });
  out.hop = hop?.find(p => p.link)?.link.id ?? null;
  const edge = E.nav.mesh(0.2).links[0].from.z, base = E.nav.links[0].from.z;
  out.seats = [edge, base];
  // async: the same answers as now, on the same meshes
  const a = await later([-10, 0, -6], [-10, 0, 6], 0.2), b = await later([-10, 0, -6], [-10, 0, 6]), c = await later([-10, 0, -6], [-10, 0, 6], 2.5), d = await later([6, 0, 30], [6, 0, 15], 0.2);
  out.async = [crossing(a.path), crossing(b.path), c.status, d.path?.find(p => p.link)?.link.id ?? null];
  out.log = JSON.stringify([a, b, c, d]);
  // an obstacle reaches every size, and leaving reopens the way
  const plug = E.collision.addBox([-10, 0, 0], { halfWidth: 1, halfDepth: 1 });
  step();
  out.plugged = via(0.2);
  out.pluggedAsync = crossing((await later([-10, 0, -6], [-10, 0, 6], 0.2)).path);
  plug.remove(); step();
  out.open = via(0.2);
  // bodies follow their own radius
  const P = E.characters.addPlayer({ control: 'camera', spawn: { x: -8, z: -6 }, radius: 0.2 });
  let res = null; P.walkTo([-8, 0, 6]).then(v => { res = v; });
  for (let i = 0; i < 1500 && !res; i++) { step(); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
  out.walk = [res?.status, +P.position.z.toFixed(1)];
  const N = E.npcs.add({ id: 'n', name: 'N', position: [-8, 0, -6], radius: 0.2, schedule: [{ at: 0, position: [-8, 0, 6] }] });
  for (let i = 0; i < 900; i++) { step(); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); if (N.position.z > 5) break; }
  out.npc = [+N.position.x.toFixed(1), +N.position.z.toFixed(1)];
  // a rebuild drops the sizes, and the next ask cuts them from the new mesh
  const v = E.nav.version;
  E.events.emit('level:loaded');
  for (let i = 0; i < 100 && E.nav.version === v; i++) await new Promise(r => setTimeout(r, 10));
  out.rebuilt = meshes();
  out.again = via(0.2); out.againMeshes = meshes();
  out.againAsync = crossing((await later([-10, 0, -6], [-10, 0, 6], 0.2)).path);
  E.nav.dispose();
  out.gone = meshes();
  E.dispose();
  return out;
};

export const specs = [
  {
    name: 'paths: each body gets a path that fits it -- a small one takes the gap the agent cannot, a wide one is told no; obstacles, links and rebuilds reach every size (threads test page)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(run, { threads: 0 }), w = await ev(run, { threads: 2 }), J = JSON.stringify({ ...r, log: undefined });
      console.log(`   mesh of a new size: ${r.buildMs} ms on a 40 m level; bytes by cells ${JSON.stringify(r.bytes)}`);
      check('no radius: the mesh of agentRadius, through the wide gap, and no other mesh is built', r.plain === 10 && r.plainMeshes === 1, J);
      check('a body in the same cells and no wider shares it', r.sameCells === 10 && r.sameCellsMeshes === 1, J);
      check('a small body takes the narrow gap, on a mesh of its own', r.small === -10 && r.smallMeshes === 2, J);
      check('a wide one fits only the wide gap', r.wide === 10, J);
      check('one too wide for any gap: noPath', r.tooWide === 'noPath', J);
      check('a radius that is no size is refused at the call', /radius/.test(r.bad ?? ''), J);
      check('a body just past the agent in the same cells still has a way', r.wider === 10, J);
      check('the mesh\'s own edge counts: only the small body crosses the plank', r.plank.join() === 'ok,noPath', J);
      check('a link works on a size of its own, and sits on that size\'s mesh', r.hop === 'hop' && r.seats[0] !== r.seats[1], J);
      check('async: the same meshes', r.async.join() === '-10,10,noPath,hop', J);
      check('an obstacle reaches the small mesh, sync and async', r.plugged === 10 && r.pluggedAsync === 10, J);
      check('and its removal', r.open === -10, J);
      check('walkTo follows the character\'s radius', r.walk[0] === 'arrived' && r.walk[1] > 5, J);
      check('so does an NPC', r.npc[1] > 4, J);
      check('a rebuild drops the sizes and the next ask cuts one again', r.rebuilt === 1 && r.again === -10 && r.againMeshes === 2 && r.againAsync === -10, J);
      check('unload: no mesh left', r.gone === 0, J);
      check('workers give the same answers, sizes and links included', r.log === w.log, JSON.stringify({ a: r.log.slice(0, 300), b: w.log.slice(0, 300) }));
    },
  },
];
