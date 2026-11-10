// 检查层第 I 组（GPT 第二层审查 core/inspect）：问不能改状态、造的要释放、同一件事一个读法、文字不丢意思。每条在改回旧代码时会失败。
export const specs = [
  {
    name: 'INSPECT-GROUP-I-READ 检查是只读的、读法统一（阴影矩阵、WebGPU 视锥、TSL 场景、多材质分组、零缩放、模块 blocked）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = engine, THREE = __threedogThree, scene = E.scene, cam = E.camera, out = {};
        E.haltLoop();
        const G = new THREE.Group(); G.name = 'gi-root'; scene.add(G);
        const add = (name, o, x = 0, y = 5, z = 0) => { o.name = name; o.position.set(x, y, z); G.add(o); return o; };
        cam.position.set(0, 5, 20); cam.lookAt(0, 5, 0); cam.updateMatrixWorld(true);
        const item = n => E.inspect.scene({ limit: 2000 }).items.find(i => i.name === n);

        // 1 阴影：picture 检查不得把真灯的阴影矩阵推到新位置（旧阴影图配新矩阵）
        const sun = new THREE.DirectionalLight(0xffffff, 1); sun.castShadow = true; sun.name = 'gi-sun'; sun.position.set(5, 30, 5); G.add(sun); G.add(sun.target);
        add('gi-caster', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())).castShadow = true;
        scene.updateMatrixWorld(true); sun.shadow.updateMatrices(sun);
        const m0 = sun.shadow.matrix.clone(), cam0 = sun.shadow.camera.position.clone();
        sun.position.set(-40, 30, 12); scene.updateMatrixWorld(true);   // the light moved; the baked map did not
        E.catalog('picture'); E.describe().render;
        out.shadowKept = sun.shadow.matrix.equals(m0) && sun.shadow.camera.position.equals(cam0);

        // 4 WebGPU 深度约定：near=1，0.75 m 外的小物体被近裁面切掉，不能报 drawn
        const keep = { cs: cam.coordinateSystem, near: cam.near };
        add('gi-near', new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial()), 0, 5, 19.25);
        cam.coordinateSystem = THREE.WebGPUCoordinateSystem; cam.near = 1; cam.updateProjectionMatrix();
        const near = item('gi-near'); out.nearDrawn = near.drawn; out.nearCodes = (near.reasons ?? []).map(x => x.code);
        cam.coordinateSystem = keep.cs; cam.near = keep.near; cam.updateProjectionMatrix();

        // 5 TSL 场景节点：menu 说开着，describe 不能说没有
        const fog0 = scene.fog, env0 = scene.environment; scene.fog = null; scene.environment = null;
        scene.environmentNode = { isNode: true }; scene.fogNode = { isNode: true };
        const pic = E.describe().picture;
        out.envNode = { present: pic.environment.present, fog: pic.fog?.type, text: E.describe().render.text.split('\n').find(l => l.startsWith('scene:')) };
        out.menuEnv = E.catalog('picture').rows.find(x => x.id === 'environment map').on;
        scene.environmentNode = null; scene.fogNode = null; scene.fog = fog0; scene.environment = env0;

        // 6 TSL 材质：颜色来源和纹理从 node 里找
        const tex = new THREE.Texture(); tex.name = 'gi-node-tex';
        const nm = new THREE.MeshBasicMaterial({ color: 0x336699 }); nm.isNodeMaterial = true;
        nm.colorNode = { isNode: true, traverse(cb) { cb(this); cb({ value: tex }); } };
        add('gi-node', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), nm), 2, 5, 0);
        out.nodeColor = item('gi-node').material.info[0].colorPath;
        out.nodeTex = E.inspect.materials().materials.find(m => m.uuid === nm.uuid)?.textures.map(t => t.slot + ':' + t.name);

        // 9 多材质：所有 group 都指向不可见的 material[0]，数组里没人用的 material[1] 可见 -> 没有画
        const mg = new THREE.BoxGeometry(1, 1, 1); mg.clearGroups(); mg.addGroup(0, mg.index.count, 0);
        add('gi-groups', new THREE.Mesh(mg, [new THREE.MeshBasicMaterial({ visible: false }), new THREE.MeshBasicMaterial()]), -2, 5, 0);
        out.groups = { drawn: item('gi-groups').drawn, codes: (item('gi-groups').reasons ?? []).map(x => x.code) };

        // 11 零缩放：平面本来就扁，scale.z=0 看得见；盒子压成一个面只是 maybe
        const pl = add('gi-plane', new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: 2 })), 4, 5, 0); pl.scale.z = 0;
        const bx = add('gi-flat-box', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()), -4, 5, 0); bx.scale.set(0, 1, 1);
        out.zero = { plane: [item('gi-plane').drawn, (item('gi-plane').reasons ?? []).map(x => x.code)], box: (item('gi-flat-box').reasons ?? []).map(x => x.code + ':' + x.level) };

        // 7 + 8 模块 blocked：文字带出模块名和原因；叫 picture 的模块 explain 走模块不走能力
        E.modules.set('picture', { name: 'picture' }); E._modState.set('picture', 'registered'); E._modBlocked.set('picture', [{ requires: 'zzcap', module: 'zzdep', state: 'failed' }]);
        out.blockedText = E.describeText().split('\n').find(l => /^Blocked modules/.test(l));
        out.explainBlocked = E.explain({ module: 'picture' }).detail?.blockedBy?.length;
        E.modules.delete('picture'); E._modState.delete('picture'); E._modBlocked.delete('picture');

        scene.remove(G); E._unhalt();
        return out;
      });
      check('1 picture 检查不改真灯的阴影矩阵和阴影相机', r.shadowKept === true);
      check('4 WebGPU 相机的近裁面：0.75 m 外 near=1 的小物体不算 drawn', r.nearDrawn === false && r.nearCodes.includes('outside-frustum'), JSON.stringify([r.nearDrawn, r.nearCodes]));
      check('5 environmentNode / fogNode：describe 与 menu 同一个读法（present、fog、scene 行）', r.envNode.present === true && r.envNode.fog === 'Node' && /fog Node/.test(r.envNode.text) && !/environment none/.test(r.envNode.text) && r.menuEnv === true, JSON.stringify(r.envNode));
      check('6 TSL 材质：说"节点材质，颜色来自 colorNode"，纹理从 node 里列出来', /node material, colour from colorNode/.test(r.nodeColor) && r.nodeTex?.includes('node colorNode:gi-node-tex'), JSON.stringify([r.nodeColor, r.nodeTex]));
      check('9 多材质按 geometry.groups：只有 group 用到的材质算数', r.groups.drawn === false && r.groups.codes.includes('material-hidden'), JSON.stringify(r.groups));
      check('11 平面 scale.z=0 仍可见、不报 scale-zero；盒子压成一个面只算 maybe', r.zero.plane[0] === true && !r.zero.plane[1].includes('scale-zero') && r.zero.box.includes('scale-zero:maybe'), JSON.stringify(r.zero));
      check('7 describe 文字：blocked 模块带名字和原因', /Blocked modules: picture blocked by zzdep/.test(r.blockedText ?? ''), r.blockedText);
      check('8 explain({ module: "picture" }) 读到模块的 blockedBy，不是能力的', r.explainBlocked === 1, String(r.explainBlocked));
    },
  },
  {
    name: 'INSPECT-GROUP-I-LIFE 检查造的东西要释放、移除后停止（诊断替身材质、describe.add 句柄（watch 在 packages/tools/tests/picture-writers.mjs）、重复照明降级）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = engine, THREE = __threedogThree, out = {};
        E.haltLoop();
        // 2 诊断替身材质：覆盖移除后释放（dispose 事件）
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.name = 'gi-dbg'; E.scene.add(m);
        const h = E.debug.override('gi', m, { material: 'wire' }), stand = m.material;
        let freed = 0; stand.addEventListener('dispose', () => freed++);
        out.standIsOther = !!stand.userData._dbgOf;
        h.remove();
        out.freedOnRemove = freed;
        E.debug.override('gi', m, { material: 'flat' }); const stand2 = m.material; let freed2 = 0; stand2.addEventListener('dispose', () => freed2++);
        E.debug.clear('gi'); out.freedOnClear = freed2; out.restored = m.material.type === 'MeshStandardMaterial';
        E.scene.remove(m);
        // 12 describe.add：旧句柄不能删掉后来同名的注册
        const h1 = E.describe.add('gi-score', () => 1); h1.remove();
        E.describe.add('gi-score', () => 2); h1.remove();
        out.scoreKept = E.describe('gi-score')['gi-score'];
        // 10 重复照明：没有"这次烘焙见过哪些灯"的记录（读文件）时是 note，不是 mistake
        const kind = id => E.describe().render.checks.find(c => c.id === id)?.kind;
        const set = { source: 'file', info: () => ({ count: 1, counts: [1, 1, 1], step: [1, 1, 1], source: 'file', owner: 'x', outside: { count: 0, names: [] } }) };
        E._probeSets = new Set([set]);
        const hemi = new THREE.HemisphereLight(); hemi.name = 'gi-fill'; E.scene.add(hemi);
        out.twiceFile = kind('lit-twice');
        set.source = 'bake'; out.twiceBake = kind('lit-twice');
        E._probeSets = new Set(); E.scene.remove(hemi);
        E._unhalt();
        return out;
      });
      check('2 诊断替身材质在覆盖移除 / clear 后被 dispose，原材质已还', r.standIsOther && r.freedOnRemove === 1 && r.freedOnClear === 1 && r.restored, JSON.stringify(r));
      check('12 describe.add 的旧句柄不删后来同名的注册', r.scoreKept === 2, String(r.scoreKept));
      check('10 重复照明：烘焙来源是文件时只是 note，本次会话烘焙才是 mistake', r.twiceFile === 'note' && r.twiceBake === 'mistake', JSON.stringify([r.twiceFile, r.twiceBake]));
    },
  },
];
