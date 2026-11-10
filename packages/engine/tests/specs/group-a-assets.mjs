// Group A (docs/plans/2026-11-09-group-a.md): copies of an asset are torn down by one path, a copy's lease follows a hot swap, a rolled-back LOD or a failed
// stream preprocess leaves nothing counted. One check per root cause; each fails when its fix is reverted. Headless engines on the loading test page.
const page = '/tests/loading/index.html';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const specs = [
  {
    name: 'group A: engine.remove frees the buffers an InstancedMesh owns; a prop on lod gives its levels\' leases back; a pickup holds a lease and never adds a model that arrives after its teardown',
    url: page, expectErrors: /404|Not Found|Failed to load resource|stream build|content|ga-missing-level/,   // the lod prop below has a level file that never exists
    async run({ check, ev }) {
      const r = await ev(async png => {
        const T = __threedogThree, { make, gltfUrl, world, content, pickups } = threedogLoad, out = {};
        const tick = () => new Promise(res => setTimeout(res, 0));
        const E = make('ga-copy', { ui: { loading: false } });
        E.use(world(), content(), pickups());
        await E.start();
        // 1. the object-level GPU data of an instanced mesh (finding 7)
        const inst = new T.InstancedMesh(new T.BoxGeometry(), new T.MeshBasicMaterial(), 4);
        let freedInst = 0; inst.addEventListener('dispose', () => freedInst++);
        E.add(inst); E.remove(inst);
        out.inst = freedInst;
        // 2. content prop with lod: the level copies hold leases (finding 4)
        const lodUrl = gltfUrl(png);
        E.assets.manifest({ name: 'ga', models: { tri: { url: gltfUrl(), lods: [lodUrl] } } });
        await E.assets.model('tri');   // loaded
        E.content.load({ props: [{ id: 'ga-p', model: 'tri', x: 3, z: 3, lod: true }] });
        for (let i = 0; i < 80 && !E.world.view('ga-p'); i++) { E.step(0.05); await tick(); }
        out.built = !!E.world.view('ga-p'); out.levelHeld = E.assets._users(lodUrl);
        E.world.remove('ga-p'); await tick();
        out.levelAfter = E.assets._users(lodUrl);
        // 3. pickup: a lease of its own, given back at teardown (finding 2)
        E.assets.manifest({ name: 'ga2', models: { gem: gltfUrl() } });
        await E.assets.model('gem'); const base = E.assets._users('gem');   // the test's own copy counts
        E.pickups.spawn({ x: 2, z: 2 }, { model: 'gem', id: 'ga-pk', give: () => ({}) });
        for (let i = 0; i < 80 && !(E.world.view('ga-pk')?.children.length); i++) { E.step(0.05); await tick(); }
        await tick(); out.pkChild = E.world.view('ga-pk')?.children.length ?? -1; out.pkHeld = E.assets._users('gem') - base;
        E.world.remove('ga-pk'); await tick();
        out.pkAfter = E.assets._users('gem') - base;
        // 4. a pickup torn down before its model arrived (finding 5): nothing is cloned or added to the dead holder, no lease taken
        E.pickups.spawn({ x: 2, z: 3 }, { model: 'gem', id: 'ga-late', give: () => ({}) });
        let holder = null;
        for (let i = 0; i < 80 && !holder; i++) { E.step(0.05); holder = E.world.view('ga-late'); if (!holder) await tick(); }
        const before = E.assets._users('gem');
        E.world.remove('ga-late');   // same task as the build: the prototype's promise has not resolved yet
        await tick(); await tick();
        out.late = { children: holder?.children.length ?? -1, leases: E.assets._users('gem') - before };
        // 5. a lod prop whose level fails to load: the build fails and the lease taken at clone time goes back
        E.assets.manifest({ name: 'ga7', models: { bad: { url: gltfUrl(), lods: ['/ga-missing-level.glb'] } } });
        await E.assets.model('bad'); const badBase = E.assets._users('bad');
        E.content.load({ props: [{ id: 'ga-bad', model: 'bad', x: 5, z: 5, lod: true }] });
        for (let i = 0; i < 20; i++) { E.step(0.05); await tick(); }
        E.world.remove('ga-bad'); await tick();
        out.badLeak = E.assets._users('bad') - badBase - 1;   // minus the prototype's own, held while the module lives
        E.dispose();
        return out;
      }, PNG).catch(err => ({ err: String(err) }));
      check('engine.remove disposes an InstancedMesh\'s own buffers once', r.inst === 1, JSON.stringify(r));
      check('a lod prop holds its level\'s lease and gives it back when the prop is torn down', r.built && r.levelHeld === 1 && r.levelAfter === 0, JSON.stringify(r));
      check('a prop whose lod build fails gives back the lease it took at clone time', r.badLeak === 0, JSON.stringify(r));
      check('a pickup copy holds a lease of its own (2 with the prototype\'s) and gives it back', r.pkChild === 1 && r.pkHeld === 2 && r.pkAfter === 1, JSON.stringify(r));
      check('a model that arrives after its pickup was torn down is not added, and takes no lease', r.late?.children === 0 && r.late.leases === 0, JSON.stringify(r.late ?? r));
    },
  },
  {
    name: 'group A: a hot swap moves a copy\'s lease to the new load (two swaps keep the data it draws) and frees an old generated build once nothing draws it',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async png => {
        const T = __threedogThree, { make, gltfUrl, protoOf } = threedogLoad, out = {};
        const tick = () => new Promise(res => setTimeout(res, 0));
        const E = make('ga-hot', { ui: { loading: false } }); await E.start();
        const A = E.assets;
        // 1. a copy placed in the scene, swapped twice (finding 1): the data it draws now is the data it holds
        A.manifest({ name: 'ga', models: { rock: gltfUrl() } });
        const c = await A.model('rock'); E.add(c);
        let mesh = null; c.traverse(o => { if (o.isMesh) mesh = o; });
        await E.debug.reloadAssets({ name: 'ga', models: { rock: gltfUrl(png) } });
        await E.debug.reloadAssets({ name: 'ga', models: { rock: gltfUrl(png + '#2') } });
        await tick();
        out.hot = { onCurrent: A._instances.get(c)?.load === A.entries.get('rock').load, retired: A._retired.size, trims: A.trim().includes('rock') };
        // 2. a generated model: its old build goes through the retire path and is freed once nothing draws it (finding 3)
        const make1 = () => new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial());
        A.manifest({ name: 'ga2', models: { gen: make1 } });
        const holder = {}, p = await protoOf(E, holder, 'gen');
        let oldFreed = 0; p.obj.traverse(o => { if (o.isMesh) o.geometry.addEventListener('dispose', () => oldFreed++); });
        await E.debug.reloadAssets({ name: 'ga2', models: { gen: () => new T.Mesh(new T.BoxGeometry(2, 1, 1), new T.MeshBasicMaterial()) } });
        await tick();
        out.gen = { oldFreed, retired: A._retired.size };
        // 3. a 2-part model reloaded as 1 part pairs only the first part: the copy still draws the second of the old load, so it keeps its lease on it
        const parts = n => () => { const g = new T.Group(); for (let i = 0; i < n; i++) g.add(i === 1 ? new T.InstancedMesh(new T.BoxGeometry(2, 1, 1), new T.MeshBasicMaterial(), 2) : new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial())); return g; };
        let setups = 0; A.onModel(m => { setups++; m.userData.setUp = true; });
        A.manifest({ name: 'ga3', models: { duo: parts(2) } });
        const d = await A.model('duo'); E.add(d);
        const second = []; d.traverse(o => { if (o.isMesh) second.push(o); });
        let secondFreed = 0; second[1].geometry.addEventListener('dispose', () => secondFreed++);
        const IM = T.InstancedMesh.prototype, wasDispose = IM.dispose; let instFreed = 0; IM.dispose = function () { instFreed++; return wasDispose.call(this); };
        await E.debug.reloadAssets({ name: 'ga3', models: { duo: parts(1) } });
        IM.dispose = wasDispose;
        await tick();
        let parts1 = 0; d.traverse(o => { if (o.isMesh) parts1++; });
        out.duo = { instFreed, setups, userData: !!d.userData.setUp, secondFreed, parts1, onNew: A._instances.get(d)?.load === A.entries.get('duo').load, trimmed: A.trim().includes('duo'), retired: A._retired.size };
        // 4. a pickup / prop copy leases the load its prototype came from, not the one the name reads when it asks
        A.manifest({ name: 'ga4', models: { pebble: gltfUrl() } });
        const pr = await protoOf(E, {}, 'pebble'), load0 = A.entries.get('pebble').load;
        A.manifest({ name: 'ga4', models: { pebble: gltfUrl(png) } });   // registered again: the name reads another file from now on
        const before = load0.users; threedogLoad.protoLease(E, pr);
        out.lease = { onProtoLoad: load0.users - before };
        E.dispose();
        return out;
      }, PNG).catch(err => ({ err: String(err) }));
      check('after two hot swaps the copy holds the load it draws (trim() would not free it)', r.hot?.onCurrent === true && r.hot.trims === false, JSON.stringify(r.hot ?? r));
      check('the oldest file is not kept alive by a stale lease: nothing waits in retired', r.hot?.retired === 0, JSON.stringify(r.hot ?? r));
      check('2 parts reloaded as 1: the copy is rebuilt whole on the new load, which trim() does not free while it is drawn', r.duo?.parts1 === 1 && r.duo.onNew === true && r.duo.trimmed === false, JSON.stringify(r.duo ?? r));
      check('2 parts reloaded as 1: onModel ran again on the rebuilt copy', r.duo?.setups >= 2 && r.duo.userData === true && r.duo.instFreed >= 1, JSON.stringify(r.duo ?? r));
      check('2 parts reloaded as 1: the old load, second part included, is freed after the swap', r.duo?.secondFreed === 1 && r.duo.retired === 0, JSON.stringify(r.duo ?? r));
      check('a copy made from a prototype leases the prototype\'s load, not the name\'s current one', r.lease?.onProtoLoad === 1, JSON.stringify(r.lease ?? r));
      check('a generated model\'s old build is freed after the swap, and nothing is lost in retired', r.gen?.oldFreed >= 1 && r.gen.retired === 0, JSON.stringify(r.gen ?? r));
    },
  },
  {
    name: 'group A: a LOD that cannot be made gives back the full copy and the levels it took; a stream build whose preprocess throws is disposed',
    url: page, expectErrors: /404|Not Found|Failed to load resource|ga-missing-level/,   // the second level file never exists
    async run({ check, ev }) {
      const r = await ev(async png => {
        const { make, gltfUrl } = threedogLoad, out = {};
        const tick = () => new Promise(res => setTimeout(res, 0));
        const E = make('ga-lod', { ui: { loading: false } }); await E.start();
        const A = E.assets, lv = gltfUrl(png);
        A.manifest({ name: 'ga', models: { tri: { url: gltfUrl(), lods: [lv, '/ga-missing-level.glb'] } } });
        const quiet = console.warn; console.warn = () => {};
        let e1 = null; try { await A.lod('tri', { distances: [5, 2] }); } catch (err) { e1 = err.code ?? String(err); }
        let e2 = null; try { await A.lod('tri'); } catch (err) { e2 = err.code ?? String(err); }
        // a level whose clone owns instance buffers: the rollback frees them (dropCopy), not only the lease (forget)
        const T = __threedogThree, IM = T.InstancedMesh.prototype, was = IM.dispose; let lvlFreed = 0;
        A.manifest({ name: 'ga5', models: { galvl: () => { const g = new T.Group(); g.add(new T.InstancedMesh(new T.BoxGeometry(), new T.MeshBasicMaterial(), 2)); return g; }, tri2: { url: gltfUrl(), lods: ['galvl', '/ga-missing-level.glb'] } } });
        IM.dispose = function () { lvlFreed++; return was.call(this); };
        try { await A.lod('tri2'); } catch { /* the missing level */ }
        IM.dispose = was;
        console.warn = quiet;
        out.lvlFreed = lvlFreed;
        out.lod = { e1, e2, full: A._users('tri'), level: A._users(lv) };
        // stream: the object is built, the upload step throws
        let disposed = 0, thrown = 0;
        E.stream._prep.run = () => { thrown++; throw new Error('upload failed'); };
        const errs = []; const ce = console.error; console.error = (...a) => errs.push(a);
        E.stream.add({ position: { x: 0, z: 0 }, radius: 50, build: () => new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial()), dispose: o => { disposed++; E.remove(o); } });
        for (let i = 0; i < 30 && !thrown; i++) { E.step(0.05); await tick(); }
        console.error = ce;
        out.stream = { thrown: thrown > 0, disposed: thrown ? disposed : -1 };
        E.dispose();
        return out;
      }, PNG).catch(err => ({ err: String(err) }));
      check('lod: bad distances reject and leave no lease on the full model', !!r.lod?.e1 && r.lod.full === 0, JSON.stringify(r.lod ?? r));
      check('lod: a level that fails to load rejects and leaves no lease on the full model or on the level that did load', !!r.lod?.e2 && r.lod.full === 0 && r.lod.level === 0, JSON.stringify(r.lod ?? r));
      check('lod: a rolled-back level that owns instance buffers has them freed', r.lvlFreed >= 1, JSON.stringify(r.lod ?? r));
      check('stream: a preprocess that throws hands the built object to its disposer', r.stream?.thrown && r.stream.disposed >= 1, JSON.stringify(r.stream ?? r));
    },
  },
  {
    name: 'group A: engine.remove and dropCopy treat a BatchedMesh\'s geometry like any geometry, and dropCopy frees instance buffers like engine.remove',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = __threedogThree, { make } = threedogLoad, out = {};
        const E = make('ga-batch', { ui: { loading: false } }); await E.start();
        const count = (x, k) => { out[k] = 0; x.addEventListener('dispose', () => out[k]++); };
        // a geometry another mesh still draws is not freed with the batch
        const b1 = new T.BatchedMesh(1, 64, 128, new T.MeshBasicMaterial()), other = new T.Mesh(b1.geometry, new T.MeshBasicMaterial());
        count(b1.geometry, 'sharedGeo'); count(b1, 'batch1');
        b1.addInstance(b1.addGeometry(new T.BoxGeometry())); b1.setColorAt(0, new T.Color(1, 0, 0));   // creates the colors texture too
        out.texN = 0; out.texFreed = 0;
        for (const k of ['_matricesTexture', '_indirectTexture', '_colorsTexture', '_previousMatricesTexture']) if (b1[k]) { out.texN++; b1[k].addEventListener('dispose', () => out.texFreed++); }
        E.add(other); E.add(b1); E.remove(b1);
        // a geometry freed earlier in the same walk is not freed again by the batch
        const b2 = new T.BatchedMesh(1, 4, 4, new T.MeshBasicMaterial()), plain = new T.Mesh(b2.geometry, new T.MeshBasicMaterial());
        count(b2.geometry, 'twiceGeo');
        E.add(plain); E.add(b2); E.remove(plain, b2);
        // dropCopy: the instance buffers of a cloned InstancedMesh are the copy\'s own
        E.assets.manifest({ name: 'ga6', models: { insts: () => { const g = new T.Group(); g.add(new T.InstancedMesh(new T.BoxGeometry(), new T.MeshBasicMaterial(), 2)); return g; } } });
        const copy = await E.assets.model('insts'), mine = new T.InstancedMesh(new T.BoxGeometry(), new T.MeshBasicMaterial(), 2);   // mine: attached by the game's onModel
        copy.add(mine); count(mine, 'mine');
        const IM = T.InstancedMesh.prototype, was = IM.dispose; out.inst = 0; IM.dispose = function () { out.inst++; return was.call(this); };
        E.assets.dropCopy(copy); IM.dispose = was;
        E.dispose();
        return out;
      }).catch(err => ({ err: String(err) }));
      check('a batch whose geometry another mesh draws leaves that geometry, and frees itself', r.sharedGeo === 0 && r.batch1 >= 1, JSON.stringify(r));
      check('the batch\'s own textures are freed (each one it has)', r.texN >= 3 && r.texFreed === r.texN, JSON.stringify(r));
      check('a geometry freed earlier in the walk is freed once, not again by the batch', r.twiceGeo === 1, JSON.stringify(r));
      check('dropCopy disposes an InstancedMesh\'s buffers', r.inst === 1 && r.mine === 0, JSON.stringify(r));
    },
  },
];
