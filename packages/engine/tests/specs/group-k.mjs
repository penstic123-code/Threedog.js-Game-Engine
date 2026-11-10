// Group K (GPT layer-2 review of scene adoption, rays, three patches, engine core): each item below failed before its fix. Same format as the other files here.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'group K: dispose undoes what the engine did to the game scene: scene.add no longer reaches the dead registry, an idled light gets its shadow redraw back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE } = threedogThreads, out = {};
        const E = mk(createEngine, 'gk-dispose');
        await E.start();
        const lamp = new THREE.PointLight(0xffffff, 0); lamp.castShadow = true;
        E.scene.add(lamp); E._gameLights.frame();
        out.idled = lamp.shadow.autoUpdate === false;
        // a light the game took over (autoUpdate written back to true) while idled, then removed from the scene: the engine does not write again
        const mine = new THREE.PointLight(0xffffff, 0); mine.castShadow = true;
        E.scene.add(mine); E._gameLights.frame();
        mine.shadow.autoUpdate = true; mine.shadow.needsUpdate = false; E.scene.remove(mine); E._gameLights.sync();
        out.gameKept = mine.shadow.needsUpdate === false;
        let adds = 0; const add = E._things.add; E._things.add = (...a) => { adds++; return add.apply(E._things, a); };
        const scene = E.scene; E.dispose();
        scene.add(new THREE.Object3D());
        out.adds = adds; out.back = lamp.shadow.autoUpdate;
        return out;
      });
      check('the light was idled while engine lived', r.idled);
      check('a light the game took over is not written by the leave path', r.gameKept, JSON.stringify(r));
      check('scene.add after dispose does not call the old registry', r.adds === 0, JSON.stringify(r));
      check('dispose gives the idled light its shadow redraw back', r.back === true, JSON.stringify(r));
    },
  },
  {
    name: 'group K: engine.onRender: a callback removed during the pass does not run in that pass',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads;
        const E = mk(createEngine, 'gk-render'), ran = [];
        let hb, ha;
        E.onRender(() => { ran.push('a'); hb.remove(); }, { when: 'before' });
        hb = E.onRender(() => ran.push('b'), { when: 'before' });
        E.onRender(() => { ran.push('c'); ha.remove(); }, { when: 'after' });
        ha = E.onRender(() => ran.push('d'), { when: 'after' });
        E._render(0.016);
        const out = { ran: ran.join() };
        E.dispose();
        return out;
      });
      check('b and d were removed before their turn and skipped', r.ran === 'a,c', r.ran);
    },
  },
  {
    name: 'group K: rays: filter sees the hit behind a refused one, moved statics answer from where they are, stale handles and swapped geometry keep the live registration',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, THREE } = threedogThreads, out = {};
        const E = mk(createEngine, 'gk-rays');
        await E.start();
        const hit = (o, d, opts) => E.rays._ray(o, d, opts)?.point.z ?? null;
        // 1. one mesh, two faces in a row, enough triangles for a BVH (a box seen from outside: near face z=1, far face z=-1); the filter refuses the near one
        const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 10, 10, 10), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        E.scene.add(box); E.rays.addStatic(box);
        out.near = hit([0, 0, 5], [0, 0, -1], {});
        out.filtered = hit([0, 0, 5], [0, 0, -1], { filter: h => h.point.z < 0 });
        // 2. a registered mesh moved between two queries of one tick
        const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.2), new THREE.MeshBasicMaterial());
        door.position.set(10, 0, 0); E.scene.add(door); E.rays.addStatic(door);
        out.before = hit([10, 0, 5], [0, 0, -1], {});
        door.position.set(20, 0, 0); door.updateMatrixWorld();   // the documented rule: a move between two rays of one step
        E.rays.fresh = -1;
        let calls = 0; const uw = door.updateWorldMatrix; door.updateWorldMatrix = function (...a) { calls++; return uw.apply(this, a); };
        for (let i = 0; i < 10; i++) hit([0, 0, 5], [0, 0, -1], {});
        out.calls = calls; door.updateWorldMatrix = uw;
        out.stale = hit([10, 0, 5], [0, 0, -1], {});
        out.moved = hit([20, 0, 5], [0, 0, -1], {});
        // 3. a handle from before forget() must not take the later registration's count
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.position.set(30, 0, 0); E.scene.add(m);
        const h1 = E.rays.addStatic(m); E.rays.forget(m); E.rays.addStatic(m); h1.remove();
        out.live = E.rays.statics.has(m);
        // 4. the mesh got a new geometry; the old one is disposed: the registration follows the new one
        const old = m.geometry; m.geometry = new THREE.BoxGeometry(1, 1, 1); old.dispose();
        out.followed = E.rays.statics.has(m);
        m.geometry.dispose();
        out.gone = !E.rays.statics.has(m);
        E.dispose();
        return out;
      });
      check('without a filter the near face', r.near === 1, JSON.stringify(r));
      check('a filter refusing the near face finds the far one', r.filtered === -1, JSON.stringify(r));
      check('ten rays refresh a static matrix once, not ten times', r.calls === 1, JSON.stringify(r));
      check('the moved door is not hit at its old place', r.before !== null && r.stale === null && r.moved !== null, JSON.stringify(r));
      check('an old handle does not remove the new registration', r.live, JSON.stringify(r));
      check('a mesh with a swapped geometry stays registered when the old one is disposed, and goes with the new one', r.followed && r.gone, JSON.stringify(r));
    },
  },
  {
    name: 'group K: patches: a material subclass key on its prototype is kept; the page-exit-pointer-lock wrapper is listed',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE, applyEffects } = threedogTest, out = {};
        class Keyed extends THREE.MeshLambertMaterial { customProgramCacheKey() { return 'sub-' + this.userData.v; } }
        const a = new Keyed(), b = new Keyed(); a.userData.v = 1; b.userData.v = 2;
        applyEffects(a, { wind: 0.04 }); applyEffects(b, { wind: 0.04 });
        out.keys = [a.customProgramCacheKey(), b.customProgramCacheKey()];
        out.listed = threedogTest.threePatches?.list().some(p => p.id === 'page-exit-pointer-lock') ?? null;
        return out;
      });
      check('the subclass key reaches the program key (two variants differ)', r.keys[0] !== r.keys[1] && r.keys[0].includes('sub-1'), JSON.stringify(r));
      if (r.listed !== null) check('exitPointerLock wrapper is in the patch list', r.listed, JSON.stringify(r));
    },
  },
];
