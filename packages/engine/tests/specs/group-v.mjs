// Group V guards (vegetation / terrain / streaming review, docs/plans/2026-11-09-group-v.md): one check per root cause, each fails with its fix reverted.
// Run: npm test -- "group V"
const page = () => {
  const { createEngine, terrain, vegetation, THREE } = threedogTerrain;
  const wait = () => new Promise(r => setTimeout(r, 2));
  window.GV = {
    wait,
    tree: (extra = {}) => ({ geometry: new THREE.ConeGeometry(1, 3, 5), rule: { perChunk: 200, collider: 0.4, minHeight: -99, maxHeight: 999, maxSlope: 99 }, ...extra }),
    async make(key, veg, define) {
      const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: key, threads: false });
      E.use(terrain({ seed: 3, height: () => 0, viewChunks: 1 }), veg ?? vegetation());
      define?.(E);
      await E.start();
      return E;
    },
    async settle(E, x, z, until) {
      E.focus.set(x, 0, z);
      for (let i = 0; i < 400 && !(E.terrain.readyAt({ x, z }) && (!until || until())); i++) { E.step(1 / 60, { describe: false, render: false }); await wait(); }
    },
  };
};
const GV = [
  {
    name: 'group V: removing vegetation takes its plants, colliders and tree token off the terrain chunks (1)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv1', null, e => e.vegetation.define('tree', g.tree()));
        await g.settle(E, 0, 0); E.step(0.2);
        const chunks = () => [...E.terrain.chunks.values()].filter(c => c.state === 'ready');
        const count = f => chunks().reduce((n, c) => n + Object.keys(f(c) ?? {}).length, 0);
        const tokens = chunks().map(c => c.treeToken);
        const before = { plants: count(c => c.plants), colliders: count(c => c.colliders) };
        E.unuse('vegetationDraw'); E.unuse('vegetation');
        const after = { plants: count(c => c.plants), colliders: count(c => c.colliders), tokens: chunks().filter((c, i) => c.treeToken !== tokens[i]).length, n: chunks().length };
        E.dispose();
        return { before, after };
      });
      check('trees were there', r.before.plants > 0 && r.before.colliders > 0, JSON.stringify(r));
      check('after unuse: no plants, no colliders left, every chunk with trees got a new token', r.after.plants === 0 && r.after.colliders === 0 && r.after.tokens > 0, JSON.stringify(r));
    },
  },
  {
    name: 'group V: a density image arriving after vegetation was removed does not rebuild the terrain (3)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv3');
        await g.settle(E, 0, 0);
        const cv = document.createElement('canvas'); cv.width = cv.height = 2; cv.getContext('2d').fillRect(0, 0, 2, 2);
        let rebuilds = 0; const orig = E.terrain.rebuild.bind(E.terrain); E.terrain.rebuild = () => { rebuilds++; orig(); };
        E.vegetation.define('weed', g.tree({ densityMap: { url: cv.toDataURL(), size: [100, 100] } }));   // image loads later than the next line
        E.unuse('vegetationDraw'); E.unuse('vegetation'); const atRemoval = rebuilds;
        await new Promise(res => setTimeout(res, 300));
        const late = rebuilds - atRemoval;
        E.dispose();
        return { rebuilds: late };
      });
      check('no terrain rebuild from a removed instance', r.rebuilds === 0, JSON.stringify(r));
    },
  },
  {
    name: 'group V: a result of an older chunk at the same coordinate does not touch the new chunk (4)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv4', null, e => e.vegetation.define('tree', g.tree()));
        await g.settle(E, 0, 0);
        const M = E.terrain, old = M.chunks.get('0,0'), oldId = old.id;
        await g.settle(E, 4000, 4000); await g.settle(E, 0, 0);   // away and back: a new record at the same coordinate
        const c = M.chunks.get('0,0');
        const fresh = c !== old && c.id !== oldId;
        c.state = 'pending'; c.tries = 0;   // a ground job of the NEW chunk is out; the OLD chunk's job now fails
        M._failed({ cx: 0, cz: 0, terrain: true, gen: M.gen, cid: oldId }, new Error('old'));
        const out = { fresh, tries: c.tries, state: c.state };
        c.state = 'ready';
        // the success path: an older chunk's plants arrive for the new chunk and must not be mounted
        const mine = c.plants.tree, fake = { m: new Float32Array(16), c: new Float32Array(3), k: new Float32Array(3), ids: new Uint32Array(1), n: 1 };
        M.ready.push({ cx: 0, cz: 0, gen: M.gen, cid: oldId, vgen: M.vgen, ev: M.edits.version(c.key), terrain: null, veg: { tree: fake }, regrow: false });
        E.step(1 / 60, { describe: false, render: false });
        out.keptPlants = c.plants.tree === mine && mine !== fake;
        E.dispose();
        return out;
      });
      check('the chunk is a new record with a new identity', r.fresh, JSON.stringify(r));
      check('an older chunk\'s failure is not charged to it', r.tries === 0 && r.state === 'pending', JSON.stringify(r));
      check('an older chunk\'s plants are not mounted on it', r.keptPlants, JSON.stringify(r));
    },
  },
  {
    name: 'group V: near-only plants with a collider block on a tick booked when the chunk is wanted, not when the worker answers (2)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv2', null, e => e.vegetation.define('post', g.tree({ nearOnly: true })));
        await g.settle(E, 0, 0);
        E.focus.set(3000, 0, 3000);   // a new place after start: ring 0 books 30 steps
        const CH = E.terrain.chunkSize, key = Math.floor(3000 / CH) + ',' + Math.floor(3000 / CH), chunk = () => E.terrain.chunks.get(key);
        const has = () => chunk()?.plants?.post, col = () => chunk()?.colliders?.post;
        let booked = null, seen = null, appliedAt = null;
        const req = E.commits.request.bind(E.commits), asked = [];
        E.commits.request = o => { const t = req(o); asked.push({ tick: E.time.tick, lag: o.lag, due: t.due, state: chunk()?.state }); return t; };
        for (let i = 0; i < 500 && !(booked && seen && appliedAt != null); i++) {
          E.step(1 / 60, { describe: false, render: false }); await g.wait();
          const e = chunk()?.near?.post;
          if (e && !booked) booked = { state: chunk().state, due: e.ticket.due, req: asked.find(a => a.due === e.ticket.due) };
          if (has() && !seen) seen = { collidersAtOnce: !!col() };
          if (col() && appliedAt == null) appliedAt = E.time.tick;
        }
        let scans = 0; const scan = E.terrain._bookNear.bind(E.terrain); E.terrain._bookNear = () => { scans++; scan(); };
        for (let i = 0; i < 30; i++) E.step(1 / 60, { describe: false, render: false });   // nobody moved
        const out = { booked, seen, later: !!col(), appliedAt, scans };
        E.dispose();
        return out;
      });
      check('the ticket is booked while the chunk is still being made, with the ring\'s lag', r.booked && r.booked.state !== 'ready' && r.booked.req && r.booked.req.lag === 30 && r.booked.due === r.booked.req.tick + 30, JSON.stringify(r));
      check('plants were drawn, their colliders are not there the moment they are drawn', r.seen && !r.seen.collidersAtOnce, JSON.stringify(r));
      check('a quiet frame books and scans nothing', r.scans === 0, JSON.stringify(r));
      check('they take effect on exactly the booked tick', r.later && r.booked && r.appliedAt >= r.booked.due && r.appliedAt <= r.booked.due + 1, JSON.stringify(r));
    },
  },
  {
    name: 'group V: the near-only collider ticket places on the main thread when the worker never answers (2, fallback)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv2f', null, e => e.vegetation.define('post', g.tree({ nearOnly: true })));
        await g.settle(E, 0, 0);
        const send = E.terrain._send.bind(E.terrain); E.terrain._send = job => { if (job.terrain) send(job); };   // detail jobs are lost
        const CH = E.terrain.chunkSize, key = Math.floor(3000 / CH) + ',' + Math.floor(3000 / CH), late0 = E.commits.stats.late;
        await g.settle(E, 3000, 3000);
        let due = null, at = null;
        for (let i = 0; i < 200 && at == null; i++) {
          E.step(1 / 60, { describe: false, render: false });
          const c = E.terrain.chunks.get(key); due ??= c?.near?.post?.ticket.due;
          if (c?.colliders?.post) at = E.time.tick;
        }
        const c = E.terrain.chunks.get(key), out = { plants: !!c?.plants?.post, colliders: !!c?.colliders?.post, late: E.commits.stats.late - late0, due, at };
        E.dispose();
        return out;
      });
      check('plants and colliders are placed by the fallback at the due tick', r.plants && r.colliders && r.late > 0 && r.due != null && r.at >= r.due && r.at <= r.due + 1, JSON.stringify(r));
    },
  },
  {
    name: 'group V: a terrain edit keeps held colliders under their ticket, and a committed empty answer is asked again after it (3, 4)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV;
        const E = await g.make('gv3e', null, e => { e.vegetation.define('post', g.tree({ nearOnly: true })); e.vegetation.define('none', g.tree({ nearOnly: true, rule: { perChunk: 0, collider: 0.4 } })); });
        E.ops.define('gv.edit', { args: { x: 'number', z: 'number' }, run: (e, a) => e.terrain.edit({ x: a.x, z: a.z }, { radius: 1, raise: 0.5 }) });
        E.focus.set(3000, 0, 3000);
        const CH = E.terrain.chunkSize, c0 = Math.floor(3000 / CH), chunk = () => E.terrain.chunks.get(c0 + ',' + c0);
        for (let i = 0; i < 400 && !chunk()?.plants?.post; i++) { E.step(1 / 60, { describe: false, render: false }); await g.wait(); }
        const held = !!chunk().held?.post && !chunk().colliders.post;
        const nb = chunk().near.none;   // answered (empty) but its ticket is not due
        E.ops.run('gv.edit', { x: c0 * CH + CH / 2, z: c0 * CH + CH / 2 }); E.step(1 / 60, { describe: false, render: false });
        const rebooked = !!nb && !nb.done && !!chunk().near.none && chunk().near.none !== nb;
        const afterEdit = { plants: !!chunk().plants.post, colliders: !!chunk().colliders.post, ticket: !!chunk().near.post && !chunk().near.post.done };
        for (let i = 0; i < 100; i++) E.step(1 / 60, { describe: false, render: false });
        const due = { colliders: !!chunk().colliders.post, done: chunk().near.post.done };
        const doneEmpty = chunk().near.none?.done === true && !chunk().plants.none;
        E.ops.run('gv.edit', { x: c0 * CH + CH / 2, z: c0 * CH + CH / 2 }); E.step(1 / 60, { describe: false, render: false }); E.step(1 / 60, { describe: false, render: false });
        const again = chunk().near.none ? !chunk().near.none.done : false;
        E.dispose();
        return { held, afterEdit, due, doneEmpty, again, rebooked };
      });
      check('colliders were held before the edit', r.held, JSON.stringify(r));
      check('an edit re-places the plants but the colliders stay under their ticket', r.afterEdit.plants && !r.afterEdit.colliders && r.afterEdit.ticket, JSON.stringify(r));
      check('an empty answer whose ticket is not due is booked again by the edit', r.rebooked, JSON.stringify(r));
      check('they take effect at the ticket', r.due.colliders && r.due.done, JSON.stringify(r));
      check('an empty answer was committed, and after an edit the species is booked again', r.doneEmpty && r.again, JSON.stringify(r));
    },
  },
  {
    name: 'group V: what a removed vegetation put into the terrain is retired, a reinstalled one refuses its leftovers (1)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = window.GV, { vegetation } = threedogTerrain;
        const E = await g.make('gv1b', null, e => e.vegetation.define('pine', g.tree({ nearOnly: true })));
        E.focus.set(3000, 0, 3000);
        const CH = E.terrain.chunkSize, c0 = Math.floor(3000 / CH), chunk = () => E.terrain.chunks.get(c0 + ',' + c0);
        for (let i = 0; i < 100 && !chunk()?.near?.pine; i++) { E.step(1 / 60, { describe: false, render: false }); await g.wait(); }
        const booked = !!chunk()?.near?.pine, v0 = E.terrain.vgen;
        const sent = []; const bc = E.terrain.lane.broadcast.bind(E.terrain.lane); E.terrain.lane.broadcast = (m, k) => { sent.push(m); return bc(m, k); };
        E.unuse('vegetationDraw'); E.unuse('vegetation');
        const retired = { table: sent.some(m => m.type === 'species' && m.name === 'pine' && m.rule == null), vgen: E.terrain.vgen > v0, tickets: [...E.terrain.chunks.values()].every(c => !Object.keys(c.near).length) };
        E.use(vegetation()); E.vegetation.define('grass', g.tree());
        const c = chunk(), fake = { m: new Float32Array(16), c: new Float32Array(3), k: new Float32Array(3), ids: new Uint32Array(1), n: 1 };
        E.vegetation.mount(c, 'pine', fake);
        const out = { booked, retired, leftover: !!c.plants.pine || !!c.colliders.pine };
        E.dispose();
        return out;
      });
      check('a ticket was booked, then retired with the instance', r.booked && r.retired.vgen && r.retired.tickets && r.retired.table, JSON.stringify(r));
      check('the new instance mounts nothing of a species it does not know', !r.leftover, JSON.stringify(r));
    },
  },
  {
    name: 'group V: a low-poly model with a plain main geometry and material keeps its own materials, freed once (5, 6)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE } = threedogTerrain, g = window.GV;
        const leaf = new THREE.MeshStandardMaterial({ color: 0x22aa22 });
        const low = new THREE.Group(); low.add(new THREE.Mesh(new THREE.SphereGeometry(1, 4, 3), leaf));
        const E = await g.make('gv5', null, e => e.vegetation.define('bush', { geometry: new THREE.SphereGeometry(1, 8, 6), material: new THREE.MeshStandardMaterial({ color: 0x884400 }), lodGeometry: low, rule: { perChunk: 5 } }));
        await g.settle(E, 0, 0); E.step(0.2);
        const sp = E.vegetation.get('bush'), kk = E.vegetationDraw.kind('bush');
        let im = null; for (const c of E.terrain.chunks.values()) im ??= E.vegetationDraw.mesh(c, 'bush');
        E.vegetationDraw._level(im, sp, kk, sp.lodRing + 1); const far = im.material === kk.lodMaterial && im.geometry === kk.lodGeometry;
        E.vegetationDraw._level(im, sp, kk, 0); const near = im.material === kk.material && im.geometry === kk.geometry;
        const k = E.vegetationDraw.kind('bush'), out = { swapped: !!im && far && near,  low: k.lodMaterial?.length, color: k.lodMaterial?.[0]?.color.getHex(), main: [].concat(k.material).length };
        let disposed = 0; for (const m of k.lodMaterial) m.addEventListener('dispose', () => disposed++);
        E.vegetation.define('bush', { geometry: new THREE.SphereGeometry(1, 8, 6), lodGeometry: low, rule: { perChunk: 5 } });
        out.disposed = disposed;
        E.dispose();
        return out;
      });
      check('the low-poly material list is the low model\'s own', r.low === 1 && r.color === 0x22aa22 && r.main === 1, JSON.stringify(r));
      check('beyond lodRing the mesh draws the low model with its materials, near it the main one', r.swapped, JSON.stringify(r));
      check('a redefine frees each low-poly material once', r.disposed === 1, JSON.stringify(r));
    },
  },
  {
    name: 'group V: under a shared game material a low-poly model still gets the engine effects and its fade follows the player (2, 3)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE } = threedogTerrain, g = window.GV;
        const low = new THREE.Group(); low.add(new THREE.Mesh(new THREE.SphereGeometry(1, 4, 3), new THREE.MeshStandardMaterial({ color: 0x22aa22 })));
        const E = await g.make('gv23', null, e => { e.vegetationDraw.material = new THREE.MeshStandardMaterial({ color: 0x888888 }); e.vegetation.define('shrub', { geometry: new THREE.SphereGeometry(1, 8, 6), lodGeometry: low, nearOnly: true, rule: { perChunk: 5 } }); });
        const k = E.vegetationDraw.kind('shrub'), seen = []; E.vegetationDraw._eachOwn(m => seen.push(m));
        E.focus.set(500, 0, 300); E.vegetationDraw.updateFade();
        const out = { own: seen.includes(k.lodMaterial[0]) && !seen.includes(k.material), fade: k.fadeUniforms?.uNearFadeCenter.value.x === 500 };
        E.dispose();
        return out;
      });
      check('the low model materials are patched by the engine, the shared game one is not', r.own, JSON.stringify(r));
      check('the low model near fade is centred on the player', r.fade, JSON.stringify(r));
    },
  },
  {
    name: 'group V: vegetation area clips each plant and its collider, not only the chunk (6)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation } = threedogTerrain;
        const g = window.GV;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'gv6', threads: false });
        E.use(vegetation({ chunkSize: 32, viewChunks: 2, area: { min: [0, 0], max: [10, 10] } }));
        E.vegetation.define('rock', g.tree({ rule: { perChunk: 400, collider: 0.3, minHeight: -99, maxHeight: 999, maxSlope: 99 } }));
        await E.start();
        E.focus.set(5, 0, 5);
        for (let i = 0; i < 200 && !E.vegetation.host.readyAt({ x: 5, z: 5 }); i++) { E.step(1 / 60, { describe: false, render: false }); await g.wait(); }
        E.step(0.2);
        let n = 0, outside = 0, colOut = 0;
        for (const c of E.vegetation.host.chunks.values()) {
          const r = c.plants.rock; if (!r) continue;
          for (let i = 0; i < r.n; i++) { n++; const x = c.cx * 32 + r.m[i * 16 + 12], z = c.cz * 32 + r.m[i * 16 + 14]; if (x < 0 || x >= 10 || z < 0 || z >= 10) outside++; }
          const k = c.colliders.rock ?? []; for (let i = 0; i < k.length; i += 3) if (k[i] < 0 || k[i] >= 10 || k[i + 1] < 0 || k[i + 1] >= 10) colOut++;
        }
        E.dispose();
        return { n, outside, colOut };
      });
      check('plants grow inside the area (and some do)', r.n > 0 && r.outside === 0, JSON.stringify(r));
      check('no collider outside the area', r.colOut === 0, JSON.stringify(r));
    },
  },
  {
    name: 'group V: a low-poly model keeps its own materials when its part order differs (7)',
    url: '/tests/terrain-edit/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE } = threedogTerrain;
        const g = window.GV;
        const bark = new THREE.MeshStandardMaterial({ color: 0x553311 }), leaf = new THREE.MeshStandardMaterial({ color: 0x22aa22 });
        const part = (geo, m, y) => { const o = new THREE.Mesh(geo, m); o.position.y = y; return o; };
        const main = new THREE.Group(); main.add(part(new THREE.CylinderGeometry(0.2, 0.2, 2, 5), bark, 1), part(new THREE.SphereGeometry(1, 6, 4), leaf, 3));   // trunk, leaves
        const low = new THREE.Group(); low.add(part(new THREE.SphereGeometry(1, 4, 3), leaf, 3), part(new THREE.CylinderGeometry(0.2, 0.2, 2, 4), bark, 1));   // leaves, trunk
        const E = await g.make('gv7', null, e => e.vegetation.define('tree', { model: main, lodGeometry: low, rule: { perChunk: 5 } }));
        const k = E.vegetationDraw.kind('tree'), mats = k.lodMaterial;
        // what each low-poly group would be drawn with, by the colour of the material at its index
        const colors = k.lodGeometry.groups.map(gr => mats[gr.materialIndex].color.getHex());
        E.dispose();
        return { colors };
      });
      check('low-poly leaves group draws with the leaf colour, the trunk group with bark', r.colors[0] === 0x22aa22 && r.colors[1] === 0x553311, JSON.stringify(r));
    },
  },
];
// the page helper is installed once per page; each run() installs it on first use
export const specs = GV.map(s => ({ ...s, async run(ctx) { await ctx.ev(src => { if (!window.GV) new Function('return ' + src)()(); }, page.toString()); return s.run.call(this, ctx); } }));
