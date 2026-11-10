// One setup for every model the engine hands out (engine.assets.onModel), and a manifest entry that names one node of a multi-part file ({ url, node }).
// Headless engines on the threads page; a gltf served by a stubbed fetch counts its downloads.
import { readFileSync, readdirSync } from 'node:fs';

const J = JSON.stringify;
const src = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

/** Runs in the page: a kit file (a Z-up root turned and scaled like many exports, parts laid out side by side, a Blender ".001" name and a duplicate) */
function setup() {
  const { all: T, THREE, mk } = threedogThreads;
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pos.buffer)));
  const kit = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Kit', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [2, 2, 2], children: [1, 2, 3, 4] },
      { name: 'Wall.001', mesh: 0, translation: [5, 0, 0] },
      { name: 'Fence', mesh: 1, translation: [-3, 0, 0] },
      { name: 'Fence', mesh: 1, translation: [-6, 0, 0] },
      { name: 'Roof', mesh: 0, translation: [0, 4, 0], scale: [3, 3, 3], extensions: { KHR_node_visibility: { visible: false } } },   // a spare part kept hidden in the kit
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: pos.byteLength, uri: 'data:application/octet-stream;base64,' + b64 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  const hits = window.msHits = { kit: 0 };
  const realFetch = window.__msRealFetch ||= window.fetch.bind(window);
  window.fetch = (u, o) => {
    if (!String(u).endsWith('ms-kit.gltf')) return realFetch(u, o);
    hits.kit++;
    return Promise.resolve(new Response(J(kit), { headers: { 'content-type': 'model/gltf+json' } }));
  };
  function J(x) { return JSON.stringify(x); }
  const flat = () => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(200, 0.2, 200), new THREE.MeshBasicMaterial()); m.position.y = -0.1; s.add(m); return s; };
  window.msGame = async (name, { content = false } = {}) => {
    const E = mk(T.createEngine, name);
    E.use(T.world(), T.collision(), T.level({ scene: flat() }), ...(content ? [T.content({})] : []));
    await E.start();
    return E;
  };
  window.msUntil = async fn => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); return !!fn(); };
  window.msMeshes = o => { const m = []; o.traverse(x => { if (x.isMesh) m.push(x); }); return m; };
  window.msBox = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  // a crown 4 m wide on a thin trunk: the crown alone sets the model's overall box, the trunk alone is its base
  window.msTree = () => {
    const g = new THREE.Group(), mat = new THREE.MeshStandardMaterial(), crown = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), mat), trunk = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4), mat);
    crown.position.y = 3; trunk.position.y = 1; trunk.name = 'trunk'; g.add(crown, trunk); return g;
  };
  window.msTHREE = THREE;
}

// the page's console stays quiet for the row; ev runs in the page, so fn sees setup's helpers
const row = (name, fn, checks) => ({
  name, url: '/tests/threads/',
  async run({ check, ev }) {
    await ev(setup);
    const r = await ev(`(async () => { const was = [console.error, console.warn], warned = []; console.error = console.warn = (...a) => warned.push(a.join(' ')); try { const r = await (${fn})(); return { ...r, warned }; } finally { [console.error, console.warn] = was; } })()`);
    checks(check, r);
  },
});

export const specs = [
  row('model setup: onModel runs once on every model copy, whoever made it, before it is drawn', async () => {
    const E = await msGame('ms-every', { content: true }), seen = new Map(), mat = new msTHREE.MeshBasicMaterial({ color: 0x123456 });
    E.assets.manifest({ name: 'ms', models: { box: msBox, kit: '/ms-kit.gltf' } });
    E.assets.onModel((model, name) => {
      seen.set(model, { name, n: (seen.get(model)?.n ?? 0) + 1, parent: !!model.parent, inScene: E.scene.getObjectById(model.id) != null });
      for (const m of msMeshes(model)) m.material = mat;
    });
    const a = await E.assets.model('box'), b = E.assets.modelNow('box'), k = await E.assets.model('kit');
    E.content.load({ props: [{ id: 'ms-p1', model: 'box', x: 3, z: 0 }, { id: 'ms-p2', model: 'box', x: 6, z: 0 }, { id: 'ms-p3', model: 'kit', x: 9, z: 0 }] });
    await msUntil(() => ['ms-p1', 'ms-p2', 'ms-p3'].every(id => E.world.view(id)));
    const props = ['ms-p1', 'ms-p2', 'ms-p3'].map(id => E.world.view(id));
    const all = [a, b, k, ...props];
    const out = {
      prepared: all.map(o => seen.get(o)?.n ?? 0), names: all.map(o => seen.get(o)?.name ?? null),
      beforeDrawn: [...seen.values()].every(s => !s.parent && !s.inScene),
      gameMaterial: all.every(o => msMeshes(o).every(m => m.material === mat)),
      extra: [...seen.keys()].filter(o => !all.includes(o)).length,
    };
    E.dispose(); return out;
  }, (check, r) => {
    check('each copy (model, modelNow, content props of a generator and of a file) ran the setup exactly once', J(r.prepared) === J([1, 1, 1, 1, 1, 1]), J(r));
    check('the setup gets the model name', J(r.names) === J(['box', 'box', 'kit', 'box', 'box', 'kit']), J(r.names));
    check('it ran before the copy had a parent or sat in the scene', r.beforeDrawn, J(r));
    check('every handed-out copy shows the setup\'s material', r.gameMaterial, J(r));
    check('nothing else (a prototype, a template) was handed to the setup', r.extra === 0, J(r));
  }),
  row('model setup: a game without onModel builds copies as before (shared template data, nothing run)', async () => {
    const E = await msGame('ms-none', { content: true });
    E.assets.manifest({ name: 'ms', models: { box: msBox } });
    const a = await E.assets.model('box'), b = await E.assets.model('box');
    E.content.load({ props: [{ id: 'ms-n1', model: 'box', x: 3, z: 0 }, { id: 'ms-n2', model: 'box', x: 6, z: 0 }] });
    await msUntil(() => E.world.view('ms-n1') && E.world.view('ms-n2'));
    // assets.model and content keep their own prototype of a generator (content's goes through the bake cache), so copies are compared within each
    const [ma] = msMeshes(a), [mb] = msMeshes(b), [mp] = msMeshes(E.world.view('ms-n1')), [mq] = msMeshes(E.world.view('ms-n2'));
    const out = { shareGeo: ma.geometry === mb.geometry && mp.geometry === mq.geometry, shareMat: ma.material === mb.material && mp.material === mq.material, keys: Object.keys(a.userData).sort() };
    E.dispose(); return out;
  }, (check, r) => {
    check('copies share geometry and material, two props too', r.shareGeo && r.shareMat, J(r));
    check('a copy carries only its model name in userData', J(r.keys) === J(['modelName']), J(r.keys));
  }),
  row('model setup: a second setup, an async one and a late one are reported', async () => {
    const E = await msGame('ms-errs');
    E.assets.manifest({ name: 'ms', models: { box: msBox } });
    const early = await E.assets.model('box');
    const h = E.assets.onModel(() => {});
    let second = null; try { E.assets.onModel(() => {}); } catch (err) { second = err.message; }
    h.remove();
    const h2 = E.assets.onModel(async () => {});
    let async = null; try { await E.assets.model('box'); } catch (err) { async = err.message; }
    h2.remove();
    E.assets.onModel(m => { m.rotation.y = 1; });
    let turned = null; try { await E.assets.model('box'); } catch (err) { turned = err.message; }
    const out = { second, async, turned, early: !!early };
    E.dispose(); return out;
  }, (check, r) => {
    check('a second onModel while one is set throws and says to call both from one function', /one function/.test(r.second ?? ''), J(r));
    check('a setup that returns a promise throws: the copy is drawn right after', /synchronous|promise/i.test(r.async ?? ''), J(r));
    check('a setup that turns the root throws in dev: the placer owns it, so the change would be overwritten', /child/.test(r.turned ?? ''), J(r));
    check('registering after copies were handed out warns that they did not run it', r.warned.some(w => /before onModel|without the setup|did not run/.test(w)), J(r.warned));
  }),
  row('model setup: rays and content collision measure the copy as the setup left it (LOD too: the full model)', async () => {
    const E = await msGame('ms-measure', { content: true });
    E.assets.manifest({ name: 'ms', models: { box: msBox } });
    // the setup adds a wing 3 m to the side: what the game shows is wider than the prototype
    E.assets.onModel(model => { const w = msBox(); w.name = 'wing'; w.position.x = 3; model.add(w); });
    const a = await E.assets.model('box', { static: true }), wing = a.getObjectByName('wing');
    E.content.load({ props: [{ id: 'ms-m1', model: 'box', x: 20, z: 0, collide: 'box' }, { id: 'ms-m2', model: 'box', x: 40, z: 0, collide: 'box', lod: true }] });
    await msUntil(() => E.world.view('ms-m1') && E.world.view('ms-m2'));
    const out = {
      rayWing: E.rays.statics.has(wing),
      wingBlocks: [!E.collision.walkable([23, 0, 0]), !E.collision.walkable([43, 0, 0])],
      bodyStill: [!E.collision.walkable([20, 0, 0]), !E.collision.walkable([40, 0, 0])],
      gap: !E.collision.walkable([30, 0, 0]),
    };
    E.dispose(); return out;
  }, (check, r) => {
    check('static: true registers rays after the setup, so a mesh the setup added is hit', r.rayWing, J(r));
    check('a prop collides where the setup made it reach, LOD on or off', J(r.wingBlocks) === J([true, true]), J(r));
    check('its own body still collides, and the space between props stays free', J(r.bodyStill) === J([true, true]) && !r.gap, J(r));
  }),
  row('model setup: a circle collider stands on the base the setup left, under the same overall box; only a circle collider measures it', async () => {
    const E = await msGame('ms-base', { content: true });
    E.assets.manifest({ name: 'ms', models: { tree: msTree, plain: msTree } });
    // the setup moves the trunk 1.5 m aside, still under the crown: the overall box does not change, the base does. plain keeps its trunk (materials only)
    E.assets.onModel((model, name) => { if (name === 'tree') model.getObjectByName('trunk').position.x = 1.5; });
    E.content.load({ props: [{ id: 'ms-t1', model: 'tree', x: 20, z: 0, collide: 'circle' }, { id: 'ms-t2', model: 'tree', x: 40, z: 0, collide: 'box' },
      { id: 'ms-t3', model: 'plain', x: 60, z: 0, collide: 'circle' }, { id: 'ms-t4', model: 'plain', x: 70, z: 0, collide: 'circle' }] });
    await msUntil(() => ['ms-t1', 'ms-t2', 'ms-t3', 'ms-t4'].every(id => E.world.view(id)));
    const ud = id => E.world.view(id).userData;
    const out = {
      trunk: !E.collision.walkable([21.5, 0, 0]), oldTrunk: !E.collision.walkable([20, 0, 0]),
      boxBase: ud('ms-t2').measure.base ?? null,
      shared: !!ud('ms-t3').measure.base && ud('ms-t3').measure.base === ud('ms-t4').measure.base,
    };
    E.dispose(); return out;
  }, (check, r) => {
    check('the circle stands where the setup moved the trunk, not where the prototype has it', r.trunk && !r.oldTrunk, J(r));
    check('a box collider never measures the base (no triangle walk for it)', r.boxBase === null, J(r));
    check('copies whose setup left the same parts share one base', r.shared, J(r));
  }),
  row('model setup: a setup that took a LOD level out and then threw still gives that level back', async () => {
    const E = await msGame('ms-lod-throw');
    E.assets.manifest({ name: 'ms', models: { kitlod: { url: '/ms-kit.gltf', lods: ['/lod1/ms-kit.gltf'] } } });
    E.assets.onModel(model => { if (model.isLOD) { model.remove(model.levels[1].object); throw new Error('ms-lod-broke'); } });
    let err = null; try { await E.assets.lod('kitlod'); } catch (x) { err = x.message; }
    const out = { err, full: E.assets._users('kitlod'), level: E.assets._users('/lod1/ms-kit.gltf') };
    E.dispose(); return out;
  }, (check, r) => {
    check('the setup\'s error reaches the caller', r.err === 'ms-lod-broke', J(r));
    check('no lease is left on the model or on the level the setup took out', r.full === 0 && r.level === 0, J(r));
  }),
  row('model setup: after a hot swap a prepared prop is measured again as it stands (the setup\'s wing still collides)', async () => {
    const E = await msGame('ms-hot', { content: true });
    E.assets.manifest({ name: 'ms', models: { hbox: { build: p => new msTHREE.Mesh(new msTHREE.BoxGeometry(1, p.h, 1), new msTHREE.MeshStandardMaterial()), params: { h: { type: 'number', min: 0.1, max: 9, default: 1 } } } } });
    E.assets.onModel(model => { const w = msBox(); w.position.x = 3; model.add(w); });
    E.content.load({ props: [{ id: 'ms-h1', model: 'hbox', x: 20, z: 0, collide: 'box' }] });
    await msUntil(() => E.world.view('ms-h1'));
    const before = !E.collision.walkable([23, 0, 0]);
    await E.assets.setParams('hbox', { h: 2 });
    E.ops.allow(() => E.world.move('ms-h1', { x: 20.5, z: 0 }));   // a move aligns the collider again, from the measure
    for (let i = 0; i < 3; i++) E.step(1 / 60);
    const v = E.world.view('ms-h1'), out = { before, after: !E.collision.walkable([23.5, 0, 0]), height: +v.userData.measure.size.y.toFixed(2) };
    E.dispose(); return out;
  }, (check, r) => {
    check('the wing collides before and after the swap', r.before && r.after, J(r));
    check('the measure has the swapped model\'s new height', r.height === 2, J(r));
  }),
  row('model setup: a setup that throws gives back what the copy took (model, modelNow, lod)', async () => {
    const E = await msGame('ms-throw');
    E.assets.manifest({ name: 'ms', models: { box: msBox } });
    await E.assets.model('box').then(o => E.remove(o));   // loaded, so modelNow has it; that copy is given back
    const rays = E.rays.statics.size;
    let fail = true;
    E.assets.onModel(() => { if (fail) throw new Error('ms-setup-broke'); });
    const errs = [];
    for (const take of [() => E.assets.model('box', { static: true }), () => E.assets.modelNow('box', { static: true }), () => E.assets.lod('box', { static: true })]) {
      try { await take(); errs.push(null); } catch (err) { errs.push(err.message); }
    }
    const after = { leases: E.assets._users('box'), rays: E.rays.statics.size - rays };
    fail = false;
    const ok = await E.assets.model('box');
    const out = { errs, ...after, again: E.assets._users('box'), okShown: !!ok };
    E.dispose(); return out;
  }, (check, r) => {
    check('the setup\'s own error reaches the caller', r.errs.every(m => m === 'ms-setup-broke'), J(r));
    check('no lease is left on the model: it can still be released', r.leases === 0, J(r));
    check('no static rays were registered for copies nobody got', r.rays === 0, J(r));
    check('the next copy runs the setup and counts as one lease', r.okShown && r.again === 1, J(r));
  }),
  row('model node: { url, node } is that node as its own model, placed at the origin, the file downloaded once', async () => {
    const E = await msGame('ms-node');
    E.assets.manifest({ name: 'ms', models: { wall: { url: '/ms-kit.gltf', node: 'Wall.001' }, fence2: { url: '/ms-kit.gltf', node: 'Fence_1' }, roof: { url: '/ms-kit.gltf', node: 'Roof' } } });
    const w = await E.assets.model('wall'), w2 = await E.assets.model('wall'), f = await E.assets.model('fence2'), r = await E.assets.model('roof');
    const kit = await E.assets.model('/ms-kit.gltf');
    const byName = n => kit.getObjectByName(n);
    for (const o of [w, f, r]) o.updateMatrixWorld(true);
    const at = o => { const v = new msTHREE.Vector3(); msMeshes(o)[0].getWorldPosition(v); return v.toArray().map(x => +x.toFixed(4)); };
    const sc = o => { const v = new msTHREE.Vector3(); msMeshes(o)[0].getWorldScale(v); return v.toArray().map(x => +x.toFixed(4)); };
    const q = o => { const v = new msTHREE.Quaternion(); msMeshes(o)[0].getWorldQuaternion(v); return v.toArray().map(x => +x.toFixed(4)); };
    const out = {
      hits: msHits.kit, wallAt: at(w), roofScale: sc(r), wallTurn: q(w), meshes: [w, f, r].map(o => msMeshes(o).length),
      sharesFile: msMeshes(w)[0].geometry === byName('Wall001').geometry && msMeshes(w2)[0].geometry === byName('Wall001').geometry,
      fenceIsSecond: msMeshes(f)[0].geometry === byName('Fence_1').geometry, names: [w, f, r].map(o => o.userData.modelName),
      fileKept: byName('Wall001').position.x, roofShown: [byName('Roof').visible, msMeshes(r).every(m => { let v = true; m.traverseAncestors(a => { v &&= a.visible; }); return v && m.visible; })],
    };
    E.dispose(); return out;
  }, (check, r) => {
    check('three\'s renames are accepted: "Wall.001" finds Wall001, the duplicate "Fence" is Fence_1', J(r.meshes) === J([1, 1, 1]) && r.fenceIsSecond, J(r));
    check('the part sits at the origin', J(r.wallAt) === J([0, 0, 0]), J(r.wallAt));
    check('it keeps the turn and size it had in the file (root rotation and scale included)', J(r.roofScale) === J([6, 6, 6]) && Math.abs(r.wallTurn[0] + Math.SQRT1_2) < 1e-3, J(r));
    check('one download for every part and the whole file; parts share the file\'s geometry', r.hits === 1 && r.sharesFile, J(r));
    check('the file itself is not changed by taking a part', r.fileKept === 5, J(r));
    check('a node hidden in the file (KHR_node_visibility) is hidden in the whole file, shown as the part a manifest names', J(r.roofShown) === J([false, true]), J(r.roofShown));
    check('each part is a model under its own name', J(r.names) === J(['wall', 'fence2', 'roof']), J(r.names));
  }),
  row('model node: a node name the file does not have names the close ones and three\'s renaming', async () => {
    const E = await msGame('ms-node-miss');
    E.assets.manifest({ name: 'ms', models: { wal: { url: '/ms-kit.gltf', node: 'Wal.001', critical: true } } });
    let msg = null; try { await E.assets.model('wal'); } catch (err) { msg = err.message; }
    E.dispose(); return { msg };
  }, (check, r) => {
    check('the error names the missing node, the file and a close name', /Wal\.001/.test(r.msg ?? '') && /ms-kit\.gltf/.test(r.msg ?? '') && /Wall001/.test(r.msg ?? ''), J(r.msg));
    check('it explains three\'s renaming (".001" loses its dot, a duplicate gets _1)', /_1/.test(r.msg ?? '') && /001/.test(r.msg ?? ''), J(r.msg));
  }),
  {
    // 不许绕开 (no way around it): every place that clones a model for the game hands the clone to Assets.handOut, so a new spawner cannot skip the game's setup
    name: '[guard] model setup: every clone handed to the game goes through handOut',
    url: '/tests/threads/',
    async run({ check }) {
      const files = [];
      const walk = d => { for (const f of readdirSync(new URL(`../../${d}`, import.meta.url), { withFileTypes: true })) f.isDirectory() ? walk(`${d}/${f.name}`) : f.name.endsWith('.js') && files.push(`${d}/${f.name}`); };
      walk('modules'); walk('core'); walk('render');
      // where a clone is not a copy the game gets: the cached prototype, the hot swap's replacement parts, the bare copy that handOut is given
      // a file that clones a model or runs a generator itself makes a model; only these make one the game never gets
      const known = { 'core/assets/Assets.js': 'the bare copy and the cached prototype', 'core/assets/assetHot.js': 'parts of copies already prepared', 'core/assets/namedModel.js': 'prototypes', 'core/assets/assetPart.js': 'a file\'s part, the template its copies come from', 'core/base/freeParts.js': 'cloneModel, the one clone helper the files above call (it records what the clone owns)' };
      const bad = files.filter(f => /skeletonClone\(|\.builder\(/.test(src(f)) && !known[f] && !/handOut\(/.test(src(f)));
      check('every file that clones a model or builds one from a generator also calls assets.handOut', !bad.length, J(bad));
      const A = src('core/assets/Assets.js');
      const outside = files.filter(f => f !== 'core/assets/Assets.js' && /\._copy\(/.test(src(f)));
      check('_copy (the bare copy) is called only inside Assets.js', !outside.length, J(outside));
      check('model(), modelNow(), wholeModel() and lod() hand their copy out', (A.match(/handOut\(/g) ?? []).length >= 5, String((A.match(/handOut\(/g) ?? []).length));
      // one order for every copy: setup, then rays. A bare copy that registered rays would hand rays the model before the game's setup changed it
      const copyBody = A.match(/\n {2}_copy\([^\n]*\{\n[\s\S]*?\n {2}\}\n/)?.[0] ?? '', handBody = A.match(/\n {2}handOut\([^\n]*\{\n[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
      check('static rays are registered in handOut after the setup, never by the bare copy', !!copyBody && !/addStatic/.test(copyBody) && handBody.indexOf('addStatic') > handBody.indexOf('fn(root'), J({ copy: copyBody.length, hand: handBody.length }));
      const bareRays = files.filter(f => f !== 'core/assets/Assets.js' && /_bare\([^)]*static/.test(src(f)));
      check('nobody asks a bare copy for static rays', !bareRays.length, J(bareRays));
    },
  },
];
