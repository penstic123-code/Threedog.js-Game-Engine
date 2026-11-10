// Lightmaps at run time (render/lightmap.js). Page: tests/lightmap. A small file is made by hand here, so this runs anywhere; the real bake needs a GPU and is
// `threedog bake light`. The non-bypassable checks: a mesh rebuilt from the file keeps its shape and gets uv1 and material.lightMap, the map really reaches a pixel,
// and each way it goes wrong in silence (moved, doubled, shared, not the baked mesh, instanced) is reported.

export const specs = [
  {
    name: 'lightmap: file puts uv1 and lightMap on the mesh, draws, refuses a bad file, reports moved / doubled / shared / missing / instanced',
    software: true,   // reads drawn pixels
    url: '/tests/lightmap/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE, floor, wall, crate, hemi, sun, row } = threedogTest, out = {}, H = THREE.DataUtils.toHalfFloat;
        engine.step(0.1); engine.scene.updateMatrixWorld(true);
        // the same layout `threedog bake light` writes: head, table, padding, half-float map, then per mesh source vertices, index, uv1
        const size = 4, tex = new Uint16Array(size * size * 4).fill(H(4));
        const entry = (m, extra) => { const g = m.geometry, n = g.attributes.position.count; return { o: { name: m.name, vertices: n, count: n, indices: g.index.count, matrix: Array.from(m.matrixWorld.elements), ...extra }, list: [Uint32Array.from({ length: n }, (_, i) => i), Uint32Array.from(g.index.array), new Float32Array(n * 2).fill(0.5)] }; };
        // an entry's own at wins over the running offset: the bad-offset case below writes one
        const make = (meshes, skipped = []) => {
          let at = 0; const parts = [];
          const table = meshes.map(e => { const o = { at, ...e.o }; for (const p of e.list) { parts.push(p); at += p.byteLength; } return o; });
          const head = new TextEncoder().encode(JSON.stringify({ format: 'threedog-lightmap', version: 1, size, backend: 'webgpu', meshes: table, skipped }));
          const base = (8 + head.length + 7) & ~7, buf = new ArrayBuffer(base + tex.byteLength + at), v = new DataView(buf);
          v.setUint32(0, 0x4d4c4454, true); v.setUint32(4, head.length, true); new Uint8Array(buf).set(head, 8); new Uint8Array(buf).set(new Uint8Array(tex.buffer), base);
          let w = base + tex.byteLength; for (const p of parts) { new Uint8Array(buf).set(new Uint8Array(p.buffer), w); w += p.byteLength; }
          return buf;
        };
        // an unlit view of the floor: no sun, no hemi, so what shows is the map
        const fr = new THREE.WebGLRenderTarget(8, 8, { type: THREE.FloatType }), R = engine.renderer;
        const top = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50); top.position.set(0, 5, 0); top.lookAt(0, 0, 0); top.updateMatrixWorld();
        const shot = () => { const px = new Float32Array(8 * 8 * 4); hemi.visible = sun.visible = false; R.setRenderTarget(fr); R.render(engine.scene, top); R.readRenderTargetPixels(fr, 0, 0, 8, 8, px); R.setRenderTarget(null); hemi.visible = sun.visible = true; return px[(4 * 8 + 4) * 4]; };
        out.before = shot();
        const positions = floor.geometry.attributes.position.count, shape = Array.from(floor.geometry.attributes.position.array), oldGeo = floor.geometry;
        let oldFreed = false; oldGeo.addEventListener('dispose', () => { oldFreed = true; });
        // the wall comes in with the wrong vertex count, so it is another mesh now (more than it has: the file's own list stays inside its count)
        const map = await engine.loadLightmap(make([entry(floor), entry(wall, { vertices: wall.geometry.attributes.position.count + 1 })], [{ name: 'row', why: 'instanced' }]));
        out.lit = shot();
        out.uv1 = floor.geometry.attributes.uv1?.count === positions && floor.geometry !== oldGeo;
        out.oldFreed = oldFreed;
        out.shape = Array.from(floor.geometry.attributes.position.array).every((v, i) => v === shape[i]) && !!floor.geometry.attributes.normal;
        out.plain = floor.material.lightMap === map.texture && map.texture.channel === 1 && map.texture.type === THREE.HalfFloatType;
        out.wallOld = !wall.material.lightMap;
        let d = engine.describe().render.lightmap;
        Object.assign(out, { missing: d.missing, skipped: d.skipped, doubled: engine.describe().render.checks.find(c => c.id === 'lit-twice')?.text ?? '', bakedOn: d.bakedOn, meshes: d.meshes });
        // a baked mesh that moved, and an unbaked mesh on the baked material
        floor.position.x += 2; crate.material = floor.material;
        d = engine.describe().render;
        out.moved = d.lightmap.moved; out.shared = d.lightmap.shared; out.text = /lightmap: 1 mesh/.test(d.text) && /moved: floor/.test(d.text);
        floor.position.x -= 2;
        // refusals: nothing is changed
        const bad = async f => { try { await engine.loadLightmap(f); return 'no throw'; } catch (e) { return e.code; } };
        out.badBytes = await bad(new ArrayBuffer(64)); out.badType = await bad(12); out.badPath = await bad('/no-such-file.lightmap');
        const cut = make([entry(floor)]).slice(0, 200); out.cut = await bad(cut);
        out.cutEnd = await bad(make([entry(floor)]).slice(0, -8));   // only the last mesh list is short: the check must count the map in front of it
        // a file whose first entry is good and the second is not: refused before anything changes, the loaded map stays (GPT review l2-render 1)
        const geo0 = floor.geometry, wallGeo = wall.geometry, kept = engine._lightmap;
        const lateBad = async edit => { const e2 = entry(wall); edit(e2); const c = await bad(make([entry(floor), e2])); return c === 'lightmap-data' && floor.geometry === geo0 && wall.geometry === wallGeo && engine._lightmap === kept && floor.material.lightMap === map.texture && !wall.material.lightMap; };
        out.lateBad = { misaligned: await lateBad(e2 => { e2.o.at = 2; }), index: await lateBad(e2 => { e2.list[1] = e2.list[1].map(() => 9999); }),
          from: await lateBad(e2 => { e2.list[0] = e2.list[0].map(() => 9999); }), negative: await lateBad(e2 => { e2.o.count = -1; }) };
        out.same = engine.describe().render.lightmap.meshes === 1;
        // off: the map leaves the material
        const tex0 = map.texture; map.remove(); map.remove();
        out.off = floor.material.lightMap === null && !engine.describe().render.lightmap && !!tex0;
        out.after = shot();
        fr.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('[guard] the geometry the mesh had is disposed, or its GPU buffers stay for good', r.oldFreed === true);
      check('[guard] the mesh is rebuilt with uv1 and the same shape, and the map is a plain half-float material.lightMap on channel 1', r.uv1 && r.shape && r.plain, J);
      check('[guard] the map reaches a pixel with every light off, and remove() takes it away', r.lit > r.before + 0.05 && Math.abs(r.after - r.before) < 1e-3 && r.off, J);
      check('[guard] a mesh that is not the one baked is left alone and listed as missing', r.wallOld && r.missing.includes('wall') && r.meshes === 1, J);
      check('[guard] an instanced mesh the bake skipped is reported', r.skipped[0]?.name === 'row', J);
      check('[guard] a baked mesh that moved is reported; so is an unbaked mesh on a baked material', r.moved.includes('floor') && r.shared.includes('crate') && r.text, J);
      check('[guard] light counted twice is reported (hemisphere)', /^lightmap light .*skyFill/.test(r.doubled), J);
      check('[guard] a file whose later entry is malformed (offset not a multiple of 4, index or source vertex past its list, negative count) is refused before the first mesh is swapped, the loaded map stays',
        Object.values(r.lateBad).every(Boolean), JSON.stringify(r.lateBad));
      check('a wrong, cut or missing file is refused (lightmap-data) and changes nothing', [r.badBytes, r.badType, r.badPath, r.cut, r.cutEnd].every(c => c === 'lightmap-data') && r.same, J);
    },
  },
];
