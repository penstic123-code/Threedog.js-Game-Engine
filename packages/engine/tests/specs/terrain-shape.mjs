// World outline, terrain({ shape }) (terrain-edit test page). "Do not bypass" guards: the default ground (no shape) keeps its exact chunk
// bytes; an island's mesh, engine.surface / ground.has, vegetation, collision and edits all read the same cut; the side walls stop a rigid body,
// the bottom is left out of collision; walking off the rim falls and emits terrain:void (no built-in respawn); workers build the same chunks.

// Hash of default-config chunk data (meshes, color maps, vegetation placements) for four configs: computed before the shape outlet existed.
// If it changes, the default ground's output moved -- only update it for a deliberate change of the default picture.
const DEFAULT_HASH = 'd43622f534386aefc9cbf09b98e95513540e8f8ec27aacff791f6b393b2a80fe';

const ISLAND = {
  seed: 7, viewChunks: 2, shading: 'texture', colorResolution: 32, height: () => 5,
  colors: { g: 0x55aa33, c: 0x886655, r: 0x555555 }, biomeColors: { default: ['g'], cliff: ['c'], rock: ['r'] },
  shape: { mask: (x, z) => 40 - Math.hypot(x, z), edge: { noise: 4, size: 14 }, side: { depth: 6 }, bottom: { depth: (x, z, n, m) => 3 + m * 0.3 } },
};

export const specs = [
  {
    name: 'terrain shape: default bytes unchanged; island mesh = surface = has; walls stop a body, bottom not solid; walking off emits terrain:void; workers = main thread',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async ({ ISLAND_SRC, DEFAULT_HASH }) => {
        const { createEngine, terrain, vegetation, collision, characters, rigid, createTerrain, world, THREE } = threedogTerrain;
        const ISL = (0, eval)('(' + ISLAND_SRC + ')');
        const out = {};
        // 1. default bytes: the same feed as the hash taken before the change
        const parts = [], enc = new TextEncoder();
        const feed = v => parts.push(ArrayBuffer.isView(v) ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : enc.encode(JSON.stringify(v)));
        const rule = { perChunk: 200, collider: 0.4, minHeight: -99, maxHeight: 999, maxSlope: 99 };
        let msDefault = 0, msIsland = 0;
        for (const cfg of [{}, { shading: 'flat' }, { shading: 'texture', colorResolution: 32 }, { height: '(x, z, n) => 8 * n.fbm(x * 0.02, z * 0.02)', diagonal: 'adaptive', flatten: [{ x: 10, z: 10, radius: 12 }] }]) {
          const T = createTerrain({ seed: 7, colors: { g: 0x55aa33, r: 0x887766 }, biomeColors: { default: ['g', 'r'] }, ...cfg });
          for (const [cx, cz] of [[0, 0], [-1, 2], [3, -4]]) {
            const c = T.buildChunk(cx, cz);
            for (const k of ['pos', 'nor', 'col', 'uv']) feed(c[k]);
            feed([c.minH, c.maxH, c.sphere]); if (c.tex) feed(c.tex.data);
            const p = T.place(cx, cz, rule, 1); for (const k in p) feed(p[k]);
          }
        }
        const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        out.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(b => b.toString(16).padStart(2, '0')).join('');
        // generation time per chunk (fresh generators, so no warm caches): default vs island, same height and shading
        for (let k = 0; k < 4; k++) {
          const cx = -1 + (k & 1), cz = -1 + (k >> 1), D = createTerrain({ ...ISL, shape: null }), I = createTerrain(ISL);
          let t = performance.now(); D.buildChunk(cx, cz); msDefault += performance.now() - t;
          t = performance.now(); I.buildChunk(cx, cz); msIsland += performance.now() - t;
        }
        out.ms = [+(msDefault / 4).toFixed(2), +(msIsland / 4).toFixed(2)];

        // 2. engines: A main thread with player and physics, B workers
        const wait = () => new Promise(res => setTimeout(res, 0));
        const make = async (threads, mods) => {
          const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, threads, urlState: false, saveKey: 'shape' + threads });
          E.use(terrain(ISL), vegetation(), collision(), ...mods);
          // no trunk colliders: the walk to the rim must not get stuck on a tree
          E.vegetation.define('tree', { geometry: new THREE.ConeGeometry(1, 3, 5), rule: { perChunk: 400, minHeight: -99, maxHeight: 999, maxSlope: 99 } });
          await E.start();
          E.focus.set(0, 0, 0);
          for (let i = 0; i < 600 && !E.terrain.readyAt({ x: 0, z: 0 }); i++) { E.step(1 / 60, { render: false }); await wait(); }
          return E;
        };
        const snap = (E, key) => { const c = E.terrain.chunks.get(key), g = E.terrainDraw.meshes.get(c).mesh.geometry.attributes; return JSON.stringify([Array.from(g.position.array), Array.from(g.color.array), Array.from(E.vegetationDraw.mesh(c, 'tree')?.instanceMatrix.array ?? [])]); };
        const A = await make(0, [world(), characters(), rigid()]), B = await make(2, []);
        const keys = ['0,0', '-1,0', '0,-1', '-1,-1'];
        out.same = keys.every(k => snap(A, k) === snap(B, k)); out.workers = B.threads.size;
        B.dispose();

        // 3. queries agree with the mesh
        out.q = { s0: A.surface(0, 0), sv: A.surface(120, 0), has0: A.ground.has(0, 0), hasV: A.ground.has(120, 0), slopeV: A.slope(120, 0), typeV: A.groundType(120, 0) };
        let worst = 0, offTop = 0, trees = 0, treesOff = 0, groups = 0, alpha = new Set(), solidLess = true;
        for (const k of keys) {
          const c = A.terrain.chunks.get(k), p = c.data.pos, CH = A.terrain.chunkSize;
          const top = A.terrainDraw.meshes.get(c).mesh.geometry.groups[0]?.count ?? 0;
          for (let i = 0; i < top * 3; i += 9) {
            const x = c.cx * CH + (p[i] + p[i + 3] + p[i + 6]) / 3, z = c.cz * CH + (p[i + 2] + p[i + 5] + p[i + 8]) / 3, y = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
            const s = A.surface(x, z); if (!Number.isFinite(s)) offTop++; else worst = Math.max(worst, Math.abs(s - y));
          }
          groups += A.terrainDraw.meshes.get(c).mesh.geometry.groups.length === 2 ? 1 : 0;
          const d = A.terrainDraw.meshes.get(c).colorTex?.image.data; if (d) for (let i = 3; i < d.length; i += 4) alpha.add(d[i]);
          const col = A.ground.chunkCollision(c.cx, c.cz);
          solidLess &&= !!col && col.positions.length < p.length;
          const im = A.vegetationDraw.mesh(c, 'tree'); if (im) for (let i = 0; i < im.count; i++) { trees++; if (!A.ground.has(c.cx * CH + im.instanceMatrix.array[i * 16 + 12], c.cz * CH + im.instanceMatrix.array[i * 16 + 14])) treesOff++; }
        }
        Object.assign(out, { worst, offTop, trees, treesOff, groups, alpha: [...alpha].sort((a, b) => a - b), solidLess });

        // 4. edits: none off the outline; inside they still dig
        const len0 = A.terrain.chunks.get('0,0').data.pos.length;
        out.editVoid = A.ops.allow(() => A.terrain.edit({ x: 120, z: 0 }, { radius: 3, lower: 1 }));
        out.editIn = A.ops.allow(() => A.terrain.edit({ x: 8, z: 8 }, { radius: 1, lower: 1 }));
        out.dug = A.surface(8, 8); out.lenSame = A.terrain.chunks.get('0,0').data.pos.length === len0;

        // 5. physics and falling: a player stands at the center; a ball is thrown at the side wall from the void
        const voids = [];
        let east = false;   // stands still until the walk east below
        const P = A.characters.addPlayer({ control: () => (east ? { x: 1, z: 0 } : null), spawn: { x: 0, z: 0 } });
        const R = A.rigid;
        for (let i = 0; i < 300 && !(R.terrain.get('0,0')?.ready && R.terrain.get('0,-1')?.ready); i++) { A.step(1 / 60, { render: false }); await wait(); }
        let rimX = 0; while (A.ground.has(rimX + 0.25, 0)) rimX += 0.25;
        const ball = R.addBall(new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial()), { radius: 0.4 });
        A.events.on('terrain:void', e => voids.push(e.who === P ? 'player' : e.who === ball ? 'ball' : 'other'));
        R.setPosition(ball, [rimX + 2, 3, 0]);   // beside the wall (top 5, wall down to -1), in the void
        A.step(1 / 60, { render: false });
        ball.body.setLinvel({ x: -8, y: 0, z: 0 }, true);
        let minX = Infinity;
        for (let i = 0; i < 60; i++) { A.step(1 / 60, { render: false }); minX = Math.min(minX, ball.body.translation().x); }
        out.wall = { rimX, minX };
        out.standY = P.position.y;
        east = true;   // walk east off the rim
        let fellAt = null;
        for (let i = 0; i < 1800 && !(voids.includes('player') && voids.includes('ball')); i++) {
          A.step(1 / 60, { render: false });
          if (fellAt == null && P.position.y < 4) fellAt = P.position.x;
          if (i % 60 === 0) await wait();
        }
        out.voids = voids; out.fellAt = fellAt; out.voidY = A.terrain.voidY; out.py = P.position.y;
        try { const o = new THREE.Object3D().translateX(120); o.position.y = 7; A.snapToGround(o); out.snap = o.position.y; } catch (e) { out.snap = e.message; }
        A.dispose();
        return out;
      }, { ISLAND_SRC, DEFAULT_HASH });
      check('default ground (no shape): chunk bytes identical to before the outlet', r.hash === DEFAULT_HASH, r.hash);
      check('chunk generation time default vs island (ms per chunk)', r.ms[1] < r.ms[0] * 4 + 5, JSON.stringify(r.ms));
      check('workers build the identical island chunks (mesh, colors, trees)', r.same && r.workers > 0, `workers ${r.workers}`);
      const q = r.q;
      check('surface: ground inside, -Infinity in the void; has, slope 0, groundType void', q.s0 === 5 && q.sv === -Infinity && q.has0 && !q.hasV && q.slopeV === 0 && q.typeV === 'void', JSON.stringify(q));
      check('top triangles lie on engine.surface, none in the void', r.worst < 1e-3 && r.offTop === 0, `worst ${r.worst}, off ${r.offTop}`);
      check('texture shading: color map only on the top group, void pixels alpha 0', r.groups === 4 && r.alpha.includes(0) && r.alpha.includes(255), JSON.stringify([r.groups, r.alpha]));
      check('no tree off the outline', r.trees > 0 && r.treesOff === 0, `${r.treesOff} / ${r.trees}`);
      check('collision leaves the bottom out', r.solidLess, '');
      check('edit off the outline does nothing; inside it digs and the mesh keeps its size', r.editVoid.heights === 0 && r.editVoid.cells === 0 && r.editIn.heights > 0 && Math.abs(r.dug - 4) < 1e-6 && r.lenSame, JSON.stringify([r.editVoid, r.editIn, r.dug]));
      check('the side wall stops a rigid body thrown at it from the void', r.wall.minX > r.wall.rimX - 0.5, JSON.stringify(r.wall));
      check('the player stands on the island, walks off the rim and falls', Math.abs(r.standY - 5) < 0.05 && r.fellAt != null && r.fellAt > r.wall.rimX - 1, `${r.standY}, fell at x ${r.fellAt}`);
      check('terrain:void fires once each for the player and the ball, no respawn', r.voids.filter(v => v === 'player').length === 1 && r.voids.includes('ball') && r.py < r.voidY, JSON.stringify([r.voids, r.voidY, r.py]));
      check('snapToGround over the void warns and leaves the object where it is (never -Infinity)', r.snap === 7, String(r.snap));
    },
  },
  {
    // edge.round bends the top down at the rim; the wall's top edge must follow every bend (the cell diagonal splits a rim segment
    // into two planes), else a row of background-colored slits shows between top and wall from the side
    software: true,   // reads rendered pixels: stays on software rendering (same pixels on every machine)
    name: 'terrain shape: edge.round leaves no slit between the top and the side wall (side view pixels)',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { createTerrain, THREE } = threedogTerrain;
        const shot = round => {
          const T = createTerrain({ seed: 7, height: () => 5, shading: 'flat', colors: { g: 0x55aa33 }, biomeColors: { default: ['g'] },
            shape: { mask: (x, z) => 40 - Math.hypot(x, z), edge: { noise: 4, size: 14, round }, side: { depth: 6 } } });
          const sc = new THREE.Scene(); sc.background = new THREE.Color(0x000000);
          const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });   // front faces only, like the real terrain material
          for (let cx = -2; cx < 2; cx++) for (let cz = -2; cz < 2; cz++) {
            const c = T.buildChunk(cx, cz); if (!c.pos.length) continue;
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
            const m = new THREE.Mesh(g, mat); m.position.set(cx * T.CHUNK, 0, cz * T.CHUNK); sc.add(m);
          }
          const W = 256, H = 64, canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
          const R = new THREE.WebGLRenderer({ canvas }), rt = new THREE.WebGLRenderTarget(W, H), px = new Uint8Array(W * H * 4);
          const cam = new THREE.OrthographicCamera(-48, 48, 6, -6, 0.1, 400); cam.position.set(0, 4 + 100 * Math.tan(0.05), 100); cam.lookAt(0, 4, 0);
          R.setRenderTarget(rt); R.render(sc, cam); R.readRenderTargetPixels(rt, 0, 0, W, H, px); R.setRenderTarget(null);
          rt.dispose(); R.dispose(); R.forceContextLoss();
          // a hole = a background pixel with island pixels above and below it in the same column
          let holes = 0, cols = 0;
          for (let x = 0; x < W; x++) {
            let lo = -1, hi = -1;
            for (let y = 0; y < H; y++) if (px[(y * W + x) * 4] > 128) { if (lo < 0) lo = y; hi = y; }
            if (lo < 0) continue; cols++;
            for (let y = lo; y <= hi; y++) if (px[(y * W + x) * 4] < 128) holes++;
          }
          return { holes, cols };
        };
        return { flat: shot(0), round: shot(1.5) };
      });
      check('round 0 and round 1.5 draw the island across the view', r.flat.cols > 150 && r.round.cols > 150, JSON.stringify(r));
      check('no background pixel between top and wall (round 0 and 1.5)', r.flat.holes === 0 && r.round.holes === 0, JSON.stringify(r));
    },
  },
];

// functions do not survive ev()'s serialization: send the config as source and rebuild it on the page
const ISLAND_SRC = '{' + Object.entries(ISLAND).map(([k, v]) => JSON.stringify(k) + ':' + ser(v)).join(',') + '}';
function ser(v) {
  if (typeof v === 'function') return v.toString();
  if (v && typeof v === 'object') return Array.isArray(v) ? '[' + v.map(ser).join(',') + ']' : '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ':' + ser(x)).join(',') + '}';
  return JSON.stringify(v);
}
