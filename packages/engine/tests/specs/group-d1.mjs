// Group D1 (docs/plans/research/2026-11-10-health-check-d.md): correctness and error-pointer fixes, one test item each so one throw stops no other.
export const specs = [
  {
    name: '[guard] group D1 item 16: a fog slot patch is the one fog mix (default fog written as a patch == no patch, direct and through the chain)',
    url: '/tests/group-p1/',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fogSlotCase());
      console.log('  group D1 fog slot numbers:', JSON.stringify(r));
      check('floor pixels equal between no patch and the patch that mixes default fog (within 1 of 255)', r.diff <= 1 && r.chainDiff <= 1, JSON.stringify(r));
      check('control: mixing twice does move the floor (the check can see a second mix)', r.twiceDiff > 3, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D1 item 6: vegetation.plantOf(hit) returns the full VegetationHit and removeInstance takes it',
    url: '/tests/terrain-edit/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, collision, level, THREE } = threedogTerrain;
        const wait = () => new Promise(res => setTimeout(res, 5));
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: 'd1-plantof' });
        const root = new THREE.Group(), m = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2)); m.name = 'ground_lawn'; m.userData.groundType = 'lawn'; root.add(m);
        E.use(level({ scene: root }), vegetation({ chunkSize: 16, viewChunks: 3, area: { min: [-20, -20], max: [20, 20] } }), collision());
        E.vegetation.define('bush', { geometry: new THREE.ConeGeometry(0.5, 1, 5), rule: { perChunk: 30, maxSlope: 1, sink: 0, biomes: { lawn: 1 } } });
        await E.start();
        E.focus.set(0, 0, 0); for (let i = 0; i < 300 && E.stream.sources().length && !E.vegetation.host.readyAt({ x: 0, z: 0 }); i++) { E.step(1 / 60); await wait(); } E.step(2.2);
        const H = E.vegetation.host;
        let im = null, c = null;
        for (const k of H.chunks.values()) { const x = E.vegetationDraw.meshes.get(k)?.ims.bush; if (x && x.count) { im = x; c = k; break; } }
        const out = { found: !!im };
        if (im) {
          const a = im.instanceMatrix.array, i = 0, want = [c.cx * H.chunkSize + a[i * 16 + 12], a[i * 16 + 13], c.cz * H.chunkSize + a[i * 16 + 14]];
          const hit = E.vegetation.plantOf({ object: im, instanceId: i });
          out.keys = hit && Object.keys(hit).sort().join();
          out.same = !!hit && hit.species === 'bush' && hit.cx === c.cx && hit.cz === c.cz && hit.id === im.userData.plants.ids[i] && hit.position.distanceTo(new THREE.Vector3(...want)) < 1e-4;
          const near = E.vegetation.instanceAt({ x: want[0], z: want[2] }, { radius: 0.05 });
          out.likeInstanceAt = !!near && near.id === hit.id && near.cx === hit.cx && near.cz === hit.cz;
          E.vegetation.removeInstance(hit.species, hit.cx, hit.cz, hit.id);
          out.gone = !E.vegetation.instanceAt({ x: want[0], z: want[2] }, { radius: 0.05 });
        }
        out.notVegetation = E.vegetation.plantOf({ object: new THREE.Mesh(), instanceId: 0 });
        E.dispose();
        return out;
      });
      check('plantOf gives { species, cx, cz, id, position } equal to instanceAt, and removeInstance(hit...) fells it',
        r.found && r.keys === 'cx,cz,id,position,species' && r.same && r.likeInstanceAt && r.gone && r.notVegetation === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D1 item 16b: threePatches.off(fog-linear) leaves a fog slot patch compiling and mixing once; with no patch three\'s own order is back',
    url: '/tests/group-p1/',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fogSlotOffCase());
      console.log('  group D1 fog off numbers:', JSON.stringify(r));
      check('the fog slot patch: no shader error and the same pixels as with the engine mix on', r.errors === 0 && r.slotDiff <= 1, JSON.stringify(r));
      check('no patch: three\'s order is back (chunk restored, the far fog moves to output space)', r.orderBack && r.noneMoved > 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D1 item 16c: a second fog slot patch on one material is rejected like a second replace',
    url: '/tests/group-p1/',
    async run({ check, ev }) {
      const r = await ev(() => window.fogSlotTwoCase());
      check('the second fog patch throws "both replace one chunk"', /both replace one chunk/.test(r.error || ''), JSON.stringify(r));
    },
  },
];
