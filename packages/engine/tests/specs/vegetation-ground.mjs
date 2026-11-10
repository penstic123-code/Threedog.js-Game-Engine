// Vegetation on any ground ("do not bypass" guards): without terrain, vegetation grows on its own chunks over whoever provides the ground --
// here a level built in code with a 'lawn' and a 'stone' floor at y = 5. Plants follow the rule (only on lawn, at the floor's height, inside
// the area), stay one InstancedMesh per species per chunk, block walking through collision, are felled / saved like terrain trees,
// stream out and back with the source, and a code-built ground (setGround) rebuilds them. Same format as the other files here. Run: npm test -- "vegetation ground"

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const specs = [
  {
    name: 'vegetation define order: species defined before content.load survive it and start',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, openWorld, content, THREE } = threedogTerrain;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-order' });
        E.use(openWorld({ seed: 4, camera: 'follow', terrain: { height: () => 2 } }), content());
        E.vegetation.define('before', { geometry: new THREE.BoxGeometry(1, 1, 1), rule: { perChunk: 5 } });
        const names = () => E.vegetation.list().map(s => s.name).join();
        const out = { defined: names() };
        E.content.load({ items: {} }, { places: {} });
        out.loaded = names();
        E.vegetation.define('after', { geometry: new THREE.BoxGeometry(1, 1, 1), rule: { perChunk: 5 } });
        await E.start();
        out.started = names();
        E.dispose();
        return out;
      });
      check('defined before content.load: still listed after it and after start, beside one defined later', r.defined === 'before' && r.loaded === 'before' && r.started === 'before,after', JSON.stringify(r));
    },
  },
  {
    name: 'vegetation ground: grows on a level model by ground type (no terrain), instanced per chunk, collision / felling / streaming / setGround follow',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, collision, level, THREE } = threedogTerrain;
        const wait = () => new Promise(res => setTimeout(res, 5));
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-ground' });
        const root = new THREE.Group();
        const floor = (name, type, x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2)); m.name = name; m.position.set(x, 5, 0); m.userData.groundType = type; root.add(m); };
        floor('ground_lawn', 'lawn', -20); floor('ground_stone', 'stone', 20);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 3, area: { min: [-40, -20], max: [40, 20] } }), collision());
        E.vegetation.define('bush', { geometry: new THREE.ConeGeometry(0.5, 1, 5), rule: { perChunk: 80, maxSlope: 1, sink: 0, biomes: { lawn: 1 }, collider: 0.4 } });
        await E.start();
        const settle = async (x, z) => { E.focus.set(x, 0, z); for (let i = 0; i < 300 && E.stream.sources().length && !E.vegetation.host.readyAt({ x, z }); i++) { E.step(1 / 60); await wait(); } E.step(2.2); };   // 2.2 s: the outer ring's collision is due by then (commits lag by ring)
        await settle(0, 0);
        const H = E.vegetation.host, all = [];
        let meshes = 0, perChunkMeshes = true;
        for (const c of H.chunks.values()) {
          const ims = Object.values(E.vegetationDraw.meshes.get(c)?.ims ?? {}); meshes += ims.length; if (ims.length > 1) perChunkMeshes = false;
          for (const im of ims) { const a = im.instanceMatrix.array; for (let i = 0; i < im.count; i++) all.push([c.cx * H.chunkSize + a[i * 16 + 12], a[i * 16 + 13], c.cz * H.chunkSize + a[i * 16 + 14]]); }
        }
        // ground types are read per level grid point (0.5 m): at the lawn / stone seam a plant may sit up to half a cell over the line
        const out = { terrain: !!E.terrain, n: all.length, meshes, perChunkMeshes, instanced: [...H.chunks.values()].every(c => Object.values(E.vegetationDraw.meshes.get(c)?.ims ?? {}).every(im => im.isInstancedMesh)),
          onLawn: all.every(p => p[0] <= 0.26 && p[0] >= -40 && Math.abs(p[2]) <= 20), atFloor: all.every(p => Math.abs(p[1] - 5) < 1e-4) };
        // collision: the walk check refuses the spot of a bush (circles reach collision through engine.ground.forEachCollider)
        const b = all[0];
        out.blocked = b ? !E.collision.walkableAt(b[0], b[2], 0.3) : null;
        out.freeOnStone = E.collision.walkableAt(20, 0, 0.3);
        // felling is the same as on terrain: instanceAt -> removeInstance hides it, drops its collider and goes into the save
        const hit = b && E.vegetation.instanceAt({ x: b[0], z: b[2] }, { radius: 0.5 });
        if (hit) E.vegetation.removeInstance(hit.species, hit.cx, hit.cz, hit.id);
        out.felled = hit ? E.collision.walkableAt(b[0], b[2], 0.3) || null : null;
        const saved = JSON.parse(JSON.stringify(E.saves.collect()));
        out.saved = hit ? saved.parts.vegetation?.removed?.[E.vegetation.key(hit.species, hit.cx, hit.cz, hit.id)] === null : false;
        // stream away and back: chunks are released, then placed again with the same plants and the felled one still gone
        await settle(4000, 4000);
        out.released = H.chunks.size === 0;
        await settle(0, 0);
        const hit2 = E.vegetation.instanceAt({ x: b[0], z: b[2] }, { radius: 0.05 });
        let n2 = 0; for (const c of H.chunks.values()) for (const im of Object.values(E.vegetationDraw.meshes.get(c)?.ims ?? {})) n2 += im.count;
        out.back = { n2, stillFelled: !hit2 };
        // a code-built ground replaces the level ground: everything is placed again on the new surface
        E.setGround({ height: () => 2, slope: () => 0, type: () => 'lawn' });
        await settle(0, 0);
        const ys = []; for (const c of H.chunks.values()) for (const im of Object.values(E.vegetationDraw.meshes.get(c)?.ims ?? {})) { const a = im.instanceMatrix.array; for (let i = 0; i < im.count; i++) if (a[i * 16 + 5]) ys.push(a[i * 16 + 13]); }
        out.reground = { n: ys.length, at2: ys.length > 0 && ys.every(y => Math.abs(y - 2) < 1e-4), stoneSideToo: [...H.chunks.values()].some(c => c.cx >= 0 && Object.keys(c.plants).length) };
        out.stillJoined = typeof E.ground.forEachCollider === 'function';
        E.dispose();
        // with terrain installed, vegetation() options are terrain options: refused with where they live
        const T = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-ground-t' });
        T.use(threedogTerrain.terrain({ viewChunks: 1 }));
        try { T.use(vegetation({ density: 2 })); out.refused = 'no throw'; } catch (err) { out.refused = err.message; }
        T.dispose();
        return out;
      });
      check('[guard] no terrain: plants grow on the level floor of the named ground type only, at its height, inside the area',
        !r.terrain && r.n > 20 && r.onLawn && r.atFloor, JSON.stringify(r));
      check('[guard] one InstancedMesh per species per chunk (instancing kept)', r.instanced && r.perChunkMeshes && r.meshes > 0, JSON.stringify(r));
      check('[guard] collision sees the plants through the ground collider API (blocked on a bush, free on bare stone)', r.blocked === true && r.freeOnStone === true, JSON.stringify(r));
      check('felling a plant clears its spot and it is saved', r.felled === true && r.saved, JSON.stringify(r));
      check('[guard] chunks stream: released far away, placed again on return with the same plants, the felled one still gone',
        r.released && r.back.n2 === r.n && r.back.stillFelled, JSON.stringify(r));
      check('[guard] a new ground provider (setGround) re-places every chunk on the new surface, colliders still joined',
        r.reground.at2 && r.reground.stoneSideToo && r.stillJoined, JSON.stringify(r.reground));
      check('with terrain installed, vegetation() options are refused, naming terrain({ density, viewChunks })', /terrain\(\{ density, viewChunks \}\)/.test(r.refused || ''), r.refused);
    },
  },
  {
    name: 'vegetation ground: the settings page drives vegetation density and view distance without terrain',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, level, settings, THREE } = threedogTerrain;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-ground-settings' });
        const root = new THREE.Group();
        const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2)); m.name = 'ground'; root.add(m);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 2 }), settings());
        await E.start();
        const H = E.vegetation.host, out = { terrain: !!E.terrain, v0: E.settings.get('viewChunks'), d0: E.settings.get('density') };
        E.settings.set('density', 0.5); E.settings.set('viewChunks', 4);
        out.host = { density: H.density, view: H.viewChunks };
        // the shadows switch reaches plants on this ground, near-only ones too
        E.vegetation.define('tuft', { geometry: new THREE.BoxGeometry(0.2, 0.2, 0.2), nearOnly: true, castShadow: true, shadowRing: 9, rule: { perChunk: 6 } });
        const meshes = () => [...H.chunks.values()].map(c => E.vegetationDraw.mesh(c, 'tuft')).filter(Boolean);
        const flip = on => { E.renderer.shadowMap.enabled = on; E.events.emit('settings:shadows', on); E.step(0.1, { render: false }); return meshes().map(m => m.castShadow); };
        out.shadowOn = flip(true); out.shadowOff = flip(false);
        E.dispose();
        return out;
      });
      check('settings read the vegetation chunks without terrain', !r.terrain && r.v0 === 2 && r.d0 === 1, JSON.stringify(r));
      check('density and view distance reach the vegetation chunks', r.host.density === 0.5 && r.host.view === 4, JSON.stringify(r));
      check('[guard] the shadows switch reaches near-only plants without terrain', r.shadowOn.length > 0 && r.shadowOn.every(Boolean) && r.shadowOff.length === r.shadowOn.length && !r.shadowOff.some(Boolean), JSON.stringify([r.shadowOn, r.shadowOff]));
    },
  },
  {
    // why: with frustumCulled off every shadow cascade drew every casting chunk and the nearest ring drew behind the camera (a grassy game: ~577 draws)
    name: '[guard] vegetation culling: each chunk mesh is frustum culled by three per camera, its sphere holds every plant; behind the view and outside a shadow box draw nothing; felled slots keep it finite',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, level, THREE } = threedogTerrain;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-cull' });
        const root = new THREE.Group();
        const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2)); m.name = 'ground'; root.add(m);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 2 }));
        E.vegetation.define('tuft', { geometry: new THREE.ConeGeometry(0.2, 0.6, 4).translate(0, 0.3, 0), nearOnly: true, castShadow: true, rule: { perChunk: 40, sink: 0 } });
        E.vegetation.define('shrub', { geometry: new THREE.BoxGeometry(1, 2, 1).translate(0, 1, 0), rule: { perChunk: 6, sink: 0 } });
        await E.start();
        E.camera.position.set(8, 2, 8); E.camera.lookAt(40, 1, 8);   // the main view looks +x: chunk -2,0 (ring 2) is behind it
        E.focus.set(8, 0, 8); for (let i = 0; i < 20; i++) E.step(1 / 30);
        const H = E.vegetation.host, ims = [...H.chunks.values()].map(c => E.vegetationDraw.mesh(c, 'tuft')).filter(Boolean);
        const p = new THREE.Vector3(), q = new THREE.Vector3(), mat = new THREE.Matrix4();
        let inside = true;
        for (const im of ims) {
          im.updateMatrixWorld(true);
          const s = im.boundingSphere.clone().applyMatrix4(im.matrixWorld);
          for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, mat); p.setFromMatrixPosition(mat).applyMatrix4(im.matrixWorld); q.set(0, 0.6, 0).applyMatrix4(mat).applyMatrix4(im.matrixWorld); if (!s.containsPoint(p) || !s.containsPoint(q)) inside = false; }
        }
        const seen = cam => { cam.updateMatrixWorld(true); const f = new THREE.Frustum().setFromProjectionMatrix(mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)); return ims.filter(im => f.intersectsObject(im)).length; };
        const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200); view.position.set(8, 2, 8); view.lookAt(40, 1, 8);   // looking +x from the middle of chunk 0,0
        const box = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 50); box.position.set(8, 30, 8); box.lookAt(8, 0, 8);    // a small shadow box over chunk 0,0
        const out = { n: ims.length, culled: ims.every(im => im.frustumCulled), inside, view: seen(view), box: seen(box) };
        // a ring-2 chunk off the main view still casts into a shadow box over it: its group is not hidden, three culls the mesh per camera
        const far = [...H.chunks.values()].find(c => c.cx === -2 && c.cz === 0), shrub = far && E.vegetationDraw.mesh(far, 'shrub');
        const back = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 80); back.position.set(-24, 40, 8); back.lookAt(-24, 0, 8);
        out.offscreen = shrub ? { group: E.vegetationDraw.meshes.get(far).group.visible, mesh: shrub.visible, inView: far.inView,
          shadow: (back.updateMatrixWorld(true), new THREE.Frustum().setFromProjectionMatrix(mat.multiplyMatrices(back.projectionMatrix, back.matrixWorldInverse)).intersectsObject(shrub)) } : null;
        // felling slot 0 keeps the sphere finite (an all-zero matrix made it NaN: rays and culling missed the chunk); restoring recomputes it
        const c0 = [...H.chunks.values()].find(c => c.cx === 0 && c.cz === 0), im0 = E.vegetationDraw.mesh(c0, 'tuft'), ids = im0.userData.plants.ids;
        E.vegetation.removeInstance('tuft', 0, 0, ids[0]);
        const s1 = im0.boundingSphere, hit = new THREE.Vector3();
        im0.getMatrixAt(1, mat); hit.setFromMatrixPosition(mat).applyMatrix4(im0.matrixWorld);
        const ray = new THREE.Raycaster(new THREE.Vector3(hit.x, hit.y + 5, hit.z), new THREE.Vector3(0, -1, 0));
        out.felled = { finite: Number.isFinite(s1.center.x) && Number.isFinite(s1.radius), hits: ray.intersectObject(im0).filter(h => h.instanceId === 1).length };
        E.vegetation.restoreInstance('tuft', 0, 0, ids[0]);
        out.felled.recomputed = im0.boundingSphere !== s1 && Number.isFinite(im0.boundingSphere.radius);
        E.dispose();
        return out;
      });
      check('[guard] every vegetation chunk mesh is frustum culled (three tests it against the view and each shadow camera)', r.n >= 9 && r.culled, JSON.stringify(r));
      check('[guard] its culling sphere holds every plant, base and top (no plant clipped at the screen edge)', r.inside, JSON.stringify(r));
      check('a view looking one way skips the chunks behind it; a small shadow box draws only the chunk under it', r.view > 0 && r.view < r.n && r.box >= 1 && r.box < r.n, JSON.stringify(r));
      check('[guard] a ring-2 chunk behind the view keeps its group shown and is inside a shadow box over it (its shadow is not dropped)', r.offscreen && r.offscreen.inView === false && r.offscreen.group && r.offscreen.mesh && r.offscreen.shadow, JSON.stringify(r.offscreen));
      check('[guard] felling slot 0: the sphere stays finite and a ray still hits another plant of the chunk; restoring recomputes it', r.felled.finite && r.felled.hits > 0 && r.felled.recomputed, JSON.stringify(r.felled));
    },
  },
  {
    name: 'vegetation ground: rigid bodies collide with plants scattered on a level (cylinders from ground.forEachCollider), and let go when felled',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, level, rigid, collision, THREE } = threedogTerrain;
        const wait = () => new Promise(res => setTimeout(res, 5));
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-ground-rigid' });
        const root = new THREE.Group();
        const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2)); m.name = 'ground_lawn'; m.userData.groundType = 'lawn'; root.add(m);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 2 }), collision(), rigid());
        E.vegetation.define('bush', { geometry: new THREE.ConeGeometry(0.5, 1, 5), rule: { perChunk: 30, maxSlope: 1, sink: 0, collider: 0.4 } });
        await E.start();
        for (let i = 0; i < 300 && !E.vegetation.host.readyAt({ x: 0, z: 0 }); i++) { E.step(1 / 60); await wait(); }
        E.step(2.2);
        const out = { circles: 0, colliders: E.rigid.groundTrees.size };
        E.ground.forEachCollider(0, 0, 20, () => out.circles++);
        const first = [...E.rigid.groundTrees.keys()][0]?.split(',').map(Number);
        if (first) { const hit = E.vegetation.instanceAt({ x: first[0], z: first[1] }, { radius: 0.5 }); if (hit) E.vegetation.removeInstance(hit.species, hit.cx, hit.cz, hit.id); }
        E.step(1);
        out.after = E.rigid.groundTrees.size;
        E.dispose();
        return out;
      });
      check('rigid() builds a cylinder for the plant circles around the physics source', r.colliders > 10 && r.colliders >= r.circles, JSON.stringify(r));
      check('a felled plant loses its rigid collider', r.after === r.colliders - 1 || r.after < r.colliders, JSON.stringify(r));
    },
  },
  {
    name: 'vegetation fade: near-only species shrink out by distance (default band from maxRing, fade:false = hard edge), centred on the focus, shader compiles',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, level, THREE } = threedogTerrain;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-fade' });
        const root = new THREE.Group(), m = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2)); m.name = 'ground_lawn'; m.userData.groundType = 'lawn'; root.add(m);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 2 }));
        const g = () => new THREE.ConeGeometry(0.1, 1, 4), rule = { perChunk: 5 };
        const tuft = E.vegetation.define('tuft', { geometry: g(), nearOnly: true, maxRing: 2, wind: 0.2, rule });
        const hard = E.vegetation.define('hard', { geometry: g(), nearOnly: true, fade: false, rule });
        const set = E.vegetation.define('set', { geometry: g(), nearOnly: true, fade: { start: 5, end: 9 }, rule });
        const tree = E.vegetation.define('tree', { geometry: g(), rule });
        let bad = null; try { E.vegetation.define('bad', { geometry: g(), nearOnly: true, fade: { start: 9, end: 5 }, rule }); } catch (e) { bad = String(e.message); }
        await E.start();
        E.focus.set(12, 0, -7); E.step(0.1);
        const out = { tuft: tuft.fade, hard: hard.fade, set: set.fade, tree: tree.fade, bad, center: E.vegetationDraw.kind('tuft').fadeUniforms.uNearFadeCenter.value.toArray(), hardU: E.vegetationDraw.kind('hard').fadeUniforms };
        const im = new THREE.InstancedMesh(g(), E.vegetationDraw.kind('tuft').material, 2); E.scene.add(im);
        E.renderer.compile(E.scene, E.camera);
        out.programsOk = E.renderer.info.programs.length > 0 && E.renderer.info.programs.every(p => p.diagnostics?.runnable !== false);
        return out;
      });
      check('near-only default: end = maxRing x chunk (2 x 16), start 65%', r.tuft?.end === 32 && Math.abs(r.tuft.start - 20.8) < 1e-6, JSON.stringify(r.tuft));
      check('fade:false and a non-near species keep the hard edge (no band)', r.hard === null && r.hardU === null && r.tree === null, JSON.stringify([r.hard, r.tree]));
      check('fade: { start, end } sets the band', r.set?.start === 5 && r.set?.end === 9, JSON.stringify(r.set));
      check('a reversed band is refused with the numbers', /start < end/.test(r.bad || ''), String(r.bad));
      check('the fade centre follows the view focus each frame', r.center[0] === 12 && r.center[2] === -7, JSON.stringify(r.center));
      check('the faded wind material compiles (no shader error)', r.programsOk);
    },
  },
  {
    // "do not bypass" guard of the three placement parts of one add(): positions plants exactly the listed spots (on own chunks and on terrain
    // chunks, through the worker), densityMap thins by a function or an image, and the old rule path is untouched
    name: 'vegetation ground: positions and densityMap go through the same add() (explicit spots, function / image density, on both hosts)',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, terrain, THREE } = threedogTerrain;
        const wait = () => new Promise(res => setTimeout(res, 5));
        const all = (E, name) => { const H = E.vegetation.host, out = []; for (const c of H.chunks.values()) { const im = E.vegetationDraw.mesh(c, name); if (!im) continue; const a = im.instanceMatrix.array;
          for (let i = 0; i < im.count; i++) out.push([c.cx * H.chunkSize + a[i * 16 + 12], a[i * 16 + 13], c.cz * H.chunkSize + a[i * 16 + 14], im.userData.plants.ids[i], a[i * 16]]); } return out; };
        const settle = async (E, ok) => { for (let i = 0; i < 400 && !ok(); i++) { E.step(1 / 60); await wait(); } E.step(0.5); };
        const out = {};
        // own chunks over a code-built ground at y = 1
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-pos' });
        E.use(vegetation({ chunkSize: 16, viewChunks: 2 }));
        E.setGround({ height: () => 1, slope: () => 0, type: () => 'lawn' });
        const geo = new THREE.ConeGeometry(0.4, 1, 4), spots = [[3, 4], [-10, 7, 2, 0], [20, -5]];
        E.vegetation.define('post', { geometry: geo, positions: spots, rule: { sink: 0, collider: 0.3 } });
        E.vegetation.define('half', { geometry: geo, rule: { perChunk: 200 }, densityMap: (x) => (x < 0 ? 0 : 1) });
        E.vegetation.define('img', { geometry: geo, rule: { perChunk: 200 }, densityMap: { data: [1, 0, 1, 0], width: 2, height: 2, size: [64, 64] } });
        E.vegetation.define('plain', { geometry: geo, rule: { perChunk: 200 } });
        // scatter-only rule keys next to positions do nothing: a dev warning names them, and every listed spot is still planted
        const warn = console.warn; let warned = ''; console.warn = (...m) => { warned += m.join(' '); };
        try { E.vegetation.define('ruled', { geometry: geo, positions: [[1, 2], [-3, 5]], rule: { perChunk: 1, chance: 0 } }); } finally { console.warn = warn; }
        out.ruleWarning = warned;
        await E.start();
        await settle(E, () => E.vegetation.host.readyAt({ x: 0, z: 0 }, { rings: 2 }));
        out.ruled = all(E, 'ruled').sort((a, b) => a[3] - b[3]).map(p => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100, p[3]]);
        const post = all(E, 'post').sort((a, b) => a[3] - b[3]);
        out.post = post.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100, p[1], p[3]]);
        out.postScale = post.find(p => p[3] === 1)?.[4];
        const half = all(E, 'half'), plain = all(E, 'plain'), img = all(E, 'img');
        out.half = { n: half.length, westAny: half.some(p => p[0] < 0), plainWest: plain.filter(p => p[0] < 0).length, plainN: plain.length };
        // a 2 x 2 image over [-32, 32]: column 0 (x < 0) is 1, column 1 is 0; bilinear in between, so only the far east edge is fully bare
        out.img = { n: img.length, farEast: img.filter(p => p[0] > 31).length, farWest: img.filter(p => p[0] < -31).length };
        // a listed plant is felled like a scattered one: its id is the list index
        const hit = E.vegetation.instanceAt({ x: 3, z: 4 }, { radius: 0.1, species: 'post' });
        out.hitId = hit?.id ?? null;
        try { E.vegetation.define('bad2', { geometry: geo, positions: [[1, 'a']] }); out.refusedEntry = 'no throw'; } catch (err) { out.refusedEntry = err.message; }
        try { E.vegetation.define('bad3', { geometry: geo, densityMap: { data: [1], width: 1, height: 1 } }); out.refusedMap = 'no throw'; } catch (err) { out.refusedMap = err.message; }
        E.dispose();
        // terrain chunks: the list travels to the worker inside the rule and comes back placed on the terrain height
        const T = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-pos-t' });
        T.use(terrain({ viewChunks: 1, height: (x, z) => 2 }), vegetation());
        T.vegetation.define('post', { geometry: geo, positions: [[5, 5], [6, -3]], rule: { sink: 0 } });
        await T.start();
        await settle(T, () => all(T, 'post').length >= 2);
        out.terrain = all(T, 'post').map(p => [Math.round(p[0]), Math.round(p[2]), Math.round(p[1] * 100) / 100]).sort((a, b) => a[0] - b[0]);
        T.dispose();
        return out;
      });
      check('[guard] positions plants exactly the listed spots at the ground height, ids are the list indexes, scale from the entry',
        JSON.stringify(r.post) === JSON.stringify([[3, 4, 1, 0], [-10, 7, 1, 1], [20, -5, 1, 2]]) && Math.abs(r.postScale - 2) < 1e-5, JSON.stringify(r));
      check('[guard] densityMap function: nothing where it is 0, the plain rule species still grows there', r.half.n > 0 && !r.half.westAny && r.half.plainWest > 0, JSON.stringify(r.half));
      check('[guard] densityMap image (data + size, terrain heightmap keys): bare where the image is 0, grows where it is 1', r.img.n > 0 && r.img.farEast === 0 && r.img.farWest > 0, JSON.stringify(r.img));
      check('a listed plant is found by instanceAt with its list index as id', r.hitId === 0, String(r.hitId));
      check('scatter-only rule keys next to positions: one dev warning names them, every listed spot is still planted',
        /rule\.perChunk/.test(r.ruleWarning) && /rule\.chance/.test(r.ruleWarning) && /vegetation-option/.test(r.ruleWarning) && JSON.stringify(r.ruled) === JSON.stringify([[1, 2, 0], [-3, 5, 1]]), JSON.stringify([r.ruleWarning, r.ruled]));
      check('a malformed positions entry is refused with its index', /positions\[0\]/.test(r.refusedEntry || ''), r.refusedEntry);
      check('a density image without size is refused', /size/.test(r.refusedMap || ''), r.refusedMap);
      check('[guard] on terrain the positions reach the worker and land on the terrain height', JSON.stringify(r.terrain) === JSON.stringify([[5, 5, 2], [6, -3, 2]]), JSON.stringify(r.terrain));
    },
  },
  {
    // Why a guard: adding a species used to drop every own-ground chunk (the whole map lost its trees and tree collision until placed again),
    // and the ground chunks rebuilt their source list every frame. Both tables now share one streaming helper (core/stream/chunkStream.js).
    name: '[guard] vegetation ground streaming: a species added later keeps the loaded chunks and their plants, a quiet frame keeps its source list',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, THREE } = threedogTerrain;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'veg-ground-add' });
        E.setGround({ height: () => 0, slope: () => 0, type: () => 'lawn' });
        E.use(vegetation({ chunkSize: 16, viewChunks: 2 }));
        E.vegetation.define('bush', { geometry: new THREE.ConeGeometry(0.5, 1, 5), rule: { perChunk: 30, maxSlope: 1, sink: 0, collider: 0.4 } });
        await E.start();
        E.haltLoop();
        for (let i = 0; i < 20; i++) E.step(1 / 60);
        const H = E.vegetation.host, before = new Map([...H.chunks].map(([k, c]) => [k, { c, bush: c.plants.bush }]));
        const centers0 = H._stream.centers[0];
        E.step(1 / 60);
        const quiet = H._stream.centers[0] === centers0;
        E.vegetation.define('rock', { geometry: new THREE.BoxGeometry(0.4, 0.4, 0.4), rule: { perChunk: 10, maxSlope: 1, sink: 0 } });
        const kept = [...before].every(([k, b]) => H.chunks.get(k) === b.c && b.c.plants.bush === b.bush);
        const rocks = [...H.chunks.values()].filter(c => c.state === 'ready' && c.plants.rock?.n > 0).length;
        const out = { n: before.size, kept, rocks, ready: [...H.chunks.values()].filter(c => c.state === 'ready').length, quiet };
        E.dispose();
        return out;
      });
      check('adding a species keeps every loaded chunk and the other species\' plants (no drop and rebuild)', r.n > 4 && r.kept, JSON.stringify(r));
      check('the added species is placed on the loaded chunks at once', r.rocks === r.ready && r.ready > 0, JSON.stringify(r));
      check('a frame where no source changed chunk reuses the source list (no per-frame allocation)', r.quiet, JSON.stringify(r));
    },
  },
  {
    name: '[guard] vegetation ground streaming: one chunk-streaming implementation (core/stream/chunkStream.js) used by terrain and own-ground vegetation',
    url: '/tests/terrain-edit/',
    async run({ check }) {
      const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const read = f => readFileSync(join(ENGINE, f), 'utf8');
      // the streaming tells: the keep-distance formula, the frustum test of a chunk sphere, the simple-source ring rule. Source -> cell
      // conversion alone is not one: stream entries and rigid colliders convert sources to cells for their own, different jobs
      const tells = [/\(s\.R \+ 1\) \* \(s\.R \+ 1\)/, /intersectsSphere\(c\.sphere\)/, /s\.simple \? /];
      const walk = d => readdirSync(join(ENGINE, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []);
      const hits = ['core', 'modules'].flatMap(walk).filter(f => !/chunkStream\.js$/.test(f) && tells.some(t => t.test(read(f))));
      const users = ['modules/terrain/ChunkManager.js', 'modules/vegetation/groundChunks.js'].filter(f => /new ChunkStream\(this/.test(read(f)));
      check('no file but core/stream/chunkStream.js carries chunk streaming code', hits.length === 0, JSON.stringify(hits));
      check('terrain chunks and own-ground vegetation chunks both stream through ChunkStream', users.length === 2, JSON.stringify(users));
    },
  },
];
