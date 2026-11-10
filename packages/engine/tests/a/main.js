// A 组测试页：压缩资源、射线（BVH）、流式生成、烘焙往返、网址设定现场。用代码搭的街区当关卡。
//   /tests/a/?state=corner   → defineState('corner') 的现场（玩家到 (30, 30)）
import { createEngine, presets, world, collision, characters, level, THREE } from '../../index.js';
import { toGLB, fromGLTF } from '../../core/assets/Baked.js';
import { defineOwned, allowOwned } from '../../core/ops/owned.js';
import { buildTestBlock, buildHeavy } from '../fixtures/block.js';

const engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: false }, saveKey: 'test-a' });
engine.use(world(), level({ scene: buildTestBlock() }), collision(), characters());
engine.createdPlayer = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: engine.level.spawn });
engine.defineState('corner', { pos: '30,30' });

// 启动前登记 400 个按需生成的小方块（20×20 网格，间距 10 米）；范围 40 米内的要在 ready 前做完
engine.stream.radius = 40;
const box = new THREE.BoxGeometry(1, 1, 1);
for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
  const x = (i - 10) * 10, z = (j - 10) * 10;
  engine.stream.add({ position: { x, z }, radius: 1, build: () => { const m = new THREE.Mesh(box, engine.level.root.children[0].material); m.position.set(x, 0.5, z); m.name = 'streamed'; return m; }, dispose: m => m.removeFromParent() });
}

window.threedogTest = {
  THREE, toGLB, fromGLTF, defineOwned, allowOwned, buildTestBlock, buildHeavy,
  urls: {
    meshopt: new URL('../fixtures/box-meshopt.glb', import.meta.url).href,
    draco: new URL('../fixtures/box-draco.glb', import.meta.url).href,
    ktx2: new URL('../fixtures/tex-bc1.ktx2', import.meta.url).href,
  },
};
engine.start();
window.engine = engine;
