// Art freedom step 3: shapes belong to the game. The city page has no art of its own (shows the fallback); the world page loads the world example's art (shows the game's own shapes).
// [守] 防止以后有人把低模小人、八面体拾取物、分面着色又写回引擎模块里，或让地形网格丢掉 uv、地形材质又变成换不了。

export const specs = [
  {
    name: '[守] 形状归游戏自己：游戏不给模型时角色是灰色胶囊，不强制分面',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { Character } = threedogTest;
        const c = new Character(engine, {}), meshes = [];
        c.root.traverse(o => { if (o.isMesh) meshes.push(o); });
        return { n: meshes.length, capsule: meshes[0]?.geometry.type, limbs: c.limbs.length, armL: 'armL' in c, flat: !!meshes[0]?.material.flatShading };
      });
      check('兜底角色只有一个胶囊网格，没有四肢', r.n === 1 && r.capsule === 'CapsuleGeometry' && r.limbs === 0 && !r.armL, JSON.stringify(r));
      check('兜底角色不强制分面', !r.flat);
    },
  },
  {
    name: '[守] 形状归游戏自己：world 示例的资源给人形和八面体；地形块有 uv、材质可换；植被可用多材质模型（砍树各组一起藏）',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { THREE } = threedogTest, p = engine.player;
        const human = { limbs: p.limbs.length, joints: !!(p.armL?.isGroup && p.legR?.isGroup) };
        engine.inventory.define('artGem', { name: 'gem', color: 0x3366ff });
        const h = engine.pickups.spawn(p.position, { give: 'artGem' });
        engine.step(0.5, { render: false });   // headless page: world builds the model on a step
        // The pickup shape is the asset-pack model named 'pickup' (registered by the world example's art/ assets), built async by content's protoOf and then hung in the placeholder group, so wait for it
        const hasMesh = () => { let m = false; h.object?.traverse(o => { if (o.isMesh) m = true; }); return m; };
        await __t.until(hasMesh, 10000).catch(() => {});
        const obj = h.object;
        let geo = '';
        obj?.traverse(o => { if (o.isMesh) geo = o.geometry.type + ':' + o.material.flatShading; });
        h.remove();
        const chunk = [...engine.terrain.chunks.values()].find(c => c.data);
        const uv = engine.terrainDraw.meshes.get(chunk).mesh.geometry.attributes.uv, pos = engine.terrainDraw.meshes.get(chunk).mesh.geometry.attributes.position;
        // multi-material model: trunk + leaves meshes -> one InstancedMesh with two groups and a material array
        const model = new THREE.Group();
        model.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2), new THREE.MeshLambertMaterial()));
        const leaves = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshToonMaterial()); leaves.position.y = 2; model.add(leaves);
        engine.vegetation.define('artMulti', { model, wind: 0.02, rule: { perChunk: 30, maxSlope: 2, minHeight: -99, maxHeight: 999, avoidFlat: false } });
        const sp = engine.vegetationDraw.kind('artMulti');   // how it is drawn: the picture's geometry and materials
        return { human, geo, uv: !!uv && uv.count === pos.count, mats: Array.isArray(sp.material) && sp.material.length, groups: sp.geometry.groups.length,
          cloned: sp.material[1] !== leaves.material, wind: threedogTest.materialPatches(sp.material[1]).includes('wind') };
      });
      check('world 示例的角色是带四肢的人形，关节挂在角色上（armL / legR）', r.human.limbs === 4 && r.human.joints, JSON.stringify(r.human));
      check('world 示例的拾取物是分面八面体（资源模型 pickup + 材质角色 pickup 的 flatShading）', r.geo === 'OctahedronGeometry:true', r.geo);
      check('地形块带 uv，每个顶点一个', r.uv);
      check('多材质模型：两个材质、两个几何组，材质是克隆的、加上了风吹', r.mats === 2 && r.groups === 2 && r.cloned && r.wind, JSON.stringify(r));
      const f = await ev(async () => {
        for (let i = 0; i < 30 && ![...engine.terrain.chunks.values()].some(c => engine.vegetationDraw.mesh(c, 'artMulti')?.count); i++) { engine.step(0.1, { render: false }); await new Promise(res => setTimeout(res, 50)); }
        for (const c of engine.terrain.chunks.values()) {
          const im = engine.vegetationDraw.mesh(c, 'artMulti');
          if (!im || !im.count) continue;
          const id = im.userData.plants.ids[0];
          engine.vegetation.removeInstance('artMulti', c.cx, c.cz, id);
          const m = im.instanceMatrix.array.slice(0, 16);
          return { draws: Array.isArray(im.material) && im.material.length, hidden: m.slice(0, 12).every(v => v === 0) && m[15] === 1, depth: !!im.customDepthMaterial?.isMeshDepthMaterial };
        }
        return null;
      });
      check('多材质植被长出来了：一个 InstancedMesh 带材质数组', f && f.draws === 2, JSON.stringify(f));
      check('砍掉一棵后整棵（所有组）都藏了', f?.hidden);
      check('多材质植被也有摆动影子', f?.depth);
    },
  },
  // [守] 灯和时间不挂在 sky 上：防止有人把灯搬回 sky（不装 sky 场景全黑），或把倍速挂回 sky
  {
    name: '[守] 灯与 sky 脱开：不装 sky 也有默认灯；游戏时间倍速在 clock 上',
    url: '/tests/perf/index.html?mode=engine',
    async run({ check, ev }) {
      const r = await ev(() => {
        // the cube page adds its own lights too, so check the engine's pair is in the scene
        const L = engine.lights, lights = L.sun.isDirectionalLight && L.hemi.isHemisphereLight && L.sun.parent === engine.scene && L.hemi.parent === engine.scene;
        const t0 = engine.clock.now; engine.mod('clock.rate', { owner: 'test', set: 0 }); engine.step(0.5, { render: false });
        const stopped = engine.clock.now === t0; engine.mod('clock.rate', { owner: 'test', set: 3 }); engine.step(0.5, { render: false });
        const fast = Math.abs(engine.clock.now - t0 - 1.5) < 0.05; engine.mod('clock.rate', { owner: 'test', set: 1 });
        return { sky: !!engine.sky, lights, stopped, fast };
      });
      check('没装 sky 时引擎自带的方向光和半球光在场景里', !r.sky && r.lights, JSON.stringify(r));
      check('clock.rate set 0 停住日历，set 3 三倍速', r.stopped && r.fast);
    },
  },
  {
    name: '[guard] the engine ships no art: no picture code, model or generator gives gray placeholders (capsule, box, flat ground at y = 0) and one warning each with the fix',
    url: '/tests/placeholders/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const W = window.placeholderWarns, has = s => W.filter(w => w.includes(s)).length;
        const hs = [[0, 0], [37, -81], [-120, 64]].map(([x, z]) => engine.surface(x, z));
        const obj = window.gemPickup.object;
        let box = ''; obj?.traverse?.(o => { if (o.isMesh) box = o.geometry.type; });
        // the ground colors are chunk data (c.data.col); the mesh is the drawing half's and holds a copy
        const chunk = [...engine.terrain.chunks.values()].find(c => c.data?.col), col = chunk?.data.col;
        const gray = !!col && [...col.slice(0, 30)].every((v, i, a) => Math.abs(v - a[i - i % 3]) < 1e-6);
        let caps = 0; engine.player.root.traverse(o => { if (o.isMesh && o.geometry.type === 'CapsuleGeometry') caps++; });
        const T = __threedogThree;
        const base = { shadow: engine.lights.sun.castShadow, tone: engine.renderer.toneMapping === T.NoToneMapping, color: engine.renderer.outputColorSpace,
          env: engine.scene.environment === null, shown: [engine.describe().render.toneMapping.value, engine.describe().render.shadows.enabled, 'look' in engine] };
        // onRender: before runs ahead of the frame render with the frame's camera, after runs behind it; a render target set in before is reset
        const order = [], rt = new T.WebGLRenderTarget(8, 8);
        const h1 = engine.onRender(({ renderer, scene, camera }) => { order.push('before', camera === engine.camera); renderer.setRenderTarget(rt); renderer.render(scene, camera); });
        const h2 = engine.onRender(({ renderer }) => order.push('after', renderer.getRenderTarget() === null), { when: 'after' });
        engine.step(1 / 60); h1.remove(); h2.remove(); engine.step(1 / 60); rt.dispose();
        let bad = ''; try { engine.onRender(() => {}, { when: 'during' }); } catch (e) { bad = e.message; }
        return { hs, type: engine.groundType(5, 5), box, gray, caps, base, order, bad,
          warns: { picture: has('the placeholder picture is on'), terrain: has('terrain(): no height function'), chars: has('characters: no model given'), pickups: has("pickups: no model for '") } };
      });
      check('flat ground at y = 0 everywhere, ground type "default"', r.hs.every(h => h === 0) && r.type === 'default', JSON.stringify(r.hs) + ' ' + r.type);
      check('player is one gray capsule, the pickup a box, the ground one neutral gray', r.caps === 1 && r.box === 'BoxGeometry' && r.gray, JSON.stringify(r));
      check('no picture code: no tone curve, srgb output, sun shadows, no environment map, shown in describe()', r.base.shadow && r.base.tone && r.base.color === 'srgb' && r.base.env && r.base.shown.join() === 'none,true,false', JSON.stringify(r.base));
      check('engine.onRender: before (frame camera, may render to a target) then after (target reset); remove() stops it; bad when throws', r.order.join() === 'before,true,after,true' && /before' or 'after'/.test(r.bad), JSON.stringify([r.order, r.bad]));
      check('each missing piece warns exactly once (picture, terrain, characters, pickups)', Object.values(r.warns).every(n => n === 1), JSON.stringify(r.warns));
    },
  },
];
