// Group L3R (docs/plans/research/2026-11-10-gpt-review-l3-render.md items 1-9): one test item each, so one throw stops no other.
const PAGE = '/tests/threads/';
const run = (name, body, label, ok) => ({
  name: `[guard] group L3R ${name}`, url: PAGE,
  async run({ check, ev }) { const r = await ev(body); check(label, ok(r), JSON.stringify(r)); },
});

export const specs = [
  run('1: vegetation.instanceAt({ radius: Infinity }) is refused, not an endless loop', () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'l3r-1');
    E.use(T.world(), T.vegetation());
    let msg = ''; try { E.vegetation.instanceAt({ x: 0, z: 0 }, { radius: Infinity }); } catch (e) { msg = e.message; }
    const fine = E.vegetation.instanceAt({ x: 0, z: 0 }, { radius: 3 });
    E.dispose(); return { msg, fine };
  }, 'a non-finite radius throws; a finite one still answers', r => /radius/.test(r.msg) && r.fine === null),

  run('2: a rejected patch batch leaves none of its earlier patches installed', () => {
    const T = threedogThreads.all, THREE = threedogThreads.THREE;
    const m = new THREE.MeshLambertMaterial(), a = { name: 'l3r-a', slot: 'output', glsl: '' }, bad = { name: 'l3r-b', slot: 'output', glsl: '', needs: { patches: ['no_such_patch'] } };
    let msg = ''; try { T.applyEffects(m, { patches: [a, bad] }); } catch (e) { msg = e.message; }
    const key = m.customProgramCacheKey?.() ?? '';
    return { msg: msg.slice(0, 80), key };
  }, 'after the throw the first patch is not in the material program key', r => r.msg && !/l3r-a/.test(r.key)),

  {
    name: '[guard] group L3R 3: compileThrough handles each compile promise when it starts (a later throw leaves no unhandled rejection)',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { compileThrough } = threedogThreads;
        const unhandled = []; const on = e => { unhandled.push(1); e.preventDefault(); };
        addEventListener('unhandledrejection', on);
        const r = { compileAsync: () => Promise.reject(new Error('compile failed')), render() {} };
        let threw = false; try { compileThrough(r, () => { r.render({}, {}); throw new Error('later pass'); }); } catch { threw = true; }
        await new Promise(res => setTimeout(res, 50));
        removeEventListener('unhandledrejection', on);
        return { threw, unhandled: unhandled.length };
      });
      check('the draw error propagates and the compile rejection is handled', r.threw && r.unhandled === 0, JSON.stringify(r));
    },
  },

  run('4: a weather type with a non-finite field is refused', () => {
    const { mk } = threedogThreads, T = threedogThreads.all;
    const tryType = f => { let msg = ''; try { const E = mk(T.createEngine, 'l3r-4'); E.use(T.world(), T.weather({ types: { clear: {}, gale: f } })); E.dispose(); } catch (e) { msg = e.message; } return msg; };
    return { inf: tryType({ wind: Infinity }), nan: tryType({ rain: NaN }), ok: tryType({ wind: 3 }) };
  }, 'Infinity and NaN throw naming the field; a finite wind installs', r => /wind/.test(r.inf) && /rain/.test(r.nan) && r.ok === ''),

  run('5: water({ segments: 0 }) is refused, so the sea never gets NaN coordinates', () => {
    const T = threedogThreads.all;
    const tryOpt = o => { let msg = ''; try { T.water(o); } catch (e) { msg = e.message; } return msg; };
    return { zero: tryOpt({ level: 0, segments: 0 }), size: tryOpt({ size: 0 }), ok: tryOpt({ level: 0, segments: 8, size: 40 }) };
  }, 'zero segments / zero size throw; a normal setup does not', r => /segments/.test(r.zero) && /size/.test(r.size) && r.ok === ''),

  run('6: mergeColored reads an interleaved geometry by vertex, not by .array', () => {
    const { THREE } = threedogThreads, T = threedogThreads.all;
    // 3 vertices, each record [x y z  nx ny nz  u v] (stride 8) in one shared buffer
    const buf = new THREE.InterleavedBuffer(new Float32Array([0, 0, 0, 0, 0, 1, 0, 0,  1, 0, 0, 0, 0, 1, 1, 0,  0, 1, 0, 0, 0, 1, 0, 1]), 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(buf, 3, 3));
    g.setAttribute('uv', new THREE.InterleavedBufferAttribute(buf, 2, 6));
    const m = T.mergeColored([[g, 0xff0000]], { flat: false });
    return { pos: Array.from(m.attributes.position.array), n: m.attributes.position.count, cols: m.attributes.color.count, uv: Array.from(m.attributes.uv.array) };
  }, 'positions, color count and uvs come from the vertices', r => r.n === 3 && r.cols === 3 && r.pos.join() === '0,0,0,1,0,0,0,1,0' && r.uv.join() === '0,0,1,0,0,1'),

  run('7: a vegetation view that throws while replaying is not left registered', () => {
    const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, E = mk(T.createEngine, 'l3r-7');
    E.use(T.world(), T.vegetation());
    E.vegetation.define('bush', { geometry: new THREE.BoxGeometry(1, 1, 1), rule: { perChunk: 1 } });
    const before = E.vegetation.views.size; let msg = '';
    try { E.vegetation.view({ species() { throw new Error('view broke'); } }); } catch (e) { msg = e.message; }
    const out = { msg, before, after: E.vegetation.views.size };
    E.dispose(); return out;
  }, 'the error reaches the caller and the view count is unchanged', r => r.msg === 'view broke' && r.after === r.before),

  run('8: photo.subject names a non-vegetation InstancedMesh', () => {
    const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, E = mk(T.createEngine, 'l3r-8');
    E.use(T.world(), T.photo());
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 1); im.name = 'lamp'; im.position.set(0, 0, -5);
    E.scene.add(im); im.updateMatrixWorld(true);
    E.camera.position.set(0, 0, 0); E.camera.lookAt(0, 0, -5); E.camera.updateMatrixWorld(true);
    const s = E.photo.subject();
    E.dispose(); return { s };
  }, 'the lamp is the subject (kind object), not null', r => r.s?.name === 'lamp' && r.s.kind === 'object'),

  run('9: a rectangular water body tiles the normal map per meter on each axis', () => {
    const { mk } = threedogThreads, T = threedogThreads.all, E = mk(T.createEngine, 'l3r-9');
    E.use(T.world(), T.water({ sea: false }));
    E.addWaterBody({ position: [0, 0, 0], halfWidth: 50, halfDepth: 5, level: 0 });
    E.water.normalMap('l3r-n', { repeat: 0.05 });
    const mesh = [...E.water.bodies.values()][0], uv = mesh.geometry.attributes.uv;
    let maxU = 0, maxV = 0; for (let i = 0; i < uv.count; i++) { maxU = Math.max(maxU, uv.getX(i)); maxV = Math.max(maxV, uv.getY(i)); }
    E.dispose(); return { maxU, maxV };
  }, '100 m x 10 m at 0.05/m: 5 tiles along the long side, 0.5 along the short', r => Math.abs(r.maxU - 5) < 1e-6 && Math.abs(r.maxV - 0.5) < 1e-6),

  run('10: water size is any finite number above 0 (a sub-meter plane is valid)', () => {
    const T = threedogThreads.all;
    const tryOpt = o => { let msg = ''; try { T.water(o); } catch (e) { msg = e.message; } return msg; };
    return { half: tryOpt({ size: 0.5, segments: 4 }), zero: tryOpt({ size: 0 }) };
  }, 'size 0.5 installs; size 0 still throws', r => r.half === '' && /size/.test(r.zero)),

  run('11: a failed patch batch does not keep its earlier patch in the cacheKey registry', () => {
    const T = threedogThreads.all, THREE = threedogThreads.THREE;
    const mk = glsl => ({ name: 'l3r-reg', cacheKey: 'k', slot: 'output', glsl });
    const bad = { name: 'l3r-reg-bad', slot: 'output', glsl: '', needs: { patches: ['nope'] } };
    try { T.applyEffects(new THREE.MeshLambertMaterial(), { patches: [mk('outgoingLight *= 1.0;'), bad] }); } catch {}
    let msg = ''; try { T.applyEffects(new THREE.MeshLambertMaterial(), { patches: [mk('outgoingLight *= 0.5;')] }); } catch (e) { msg = e.message; }
    return { msg };
  }, 'the corrected retry under the same cacheKey is accepted', r => r.msg === ''),

  run('12: photo.subject names the plant the ray hit (same id on two species; a hit far from the trunk), and a non-vegetation instanced mesh by its own name', () => {
    const { mk } = threedogThreads, T = threedogThreads.all, THREE = threedogThreads.THREE, E = mk(T.createEngine, 'l3r-12');
    E.use(T.world(), T.vegetation(), T.photo());
    // a vegetation draw mesh as draw.js makes it: userData.plants (the placement: ids) and userData.species
    const veg = (species, x, size) => { const im = new THREE.InstancedMesh(new THREE.BoxGeometry(size, size, 1), new THREE.MeshBasicMaterial(), 1); im.name = 'm'; im.userData.plants = { ids: [0], m: new Float32Array(16) }; im.userData.cx = 0; im.userData.cz = 0; im.userData.species = species; im.position.set(x, 0, -5); return im; };
    const look = () => { E.camera.position.set(0, 0, 0); E.camera.lookAt(0, 0, -5); E.camera.updateMatrixWorld(true); return E.photo.subject(); };
    const out = {}, add = m => { E.scene.add(m); m.updateMatrixWorld(true); return m; };
    const oak = add(veg('oak', 0, 2)); oak.position.z = -8; oak.updateMatrixWorld(true);   // behind: same id 0, other species
    const birch = add(veg('birch', 0, 2));
    out.birch = look()?.name;
    E.scene.remove(birch, oak);
    const canopy = add(veg('pine', 8, 20));   // the ray meets it 8 m from the instance's center
    out.canopy = look()?.name;
    E.scene.remove(canopy);
    const lamp = add(new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 1)); lamp.name = 'lamp'; lamp.position.set(0, 0, -5); lamp.updateMatrixWorld(true);
    out.lamp = look()?.name;
    E.dispose(); return out;
  }, 'birch, pine (far from its center) and the lamp are each named for what was hit', r => r.birch === 'birch' && r.canopy === 'pine' && r.lamp === 'lamp'),
];
