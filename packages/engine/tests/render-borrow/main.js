// Renderer borrow page (tests/specs/render-borrow.mjs): render/backend.js borrowRenderer on both renderers, with a draw that throws inside
// three's own render; and the ray BVH change of engine.rays as a listed, undone patch. The engine (halted) gives the WebGL renderer and the rays,
// and is what the spec runner waits for.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { computeBoundsTree } from 'three-mesh-bvh';
import { borrowRenderer } from '../../render/backend.js';
import { createEngine } from '../../index.js';
import { threePatches } from '../../core/scene/threePatches.js';

const engine = window.engine = createEngine({ canvas: document.getElementById('gl'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-render-borrow', urlState: false });
await engine.start();
engine.haltLoop();
const gl = engine.renderer;
const gpu = new TG.WebGPURenderer({ canvas: document.getElementById('gpu'), antialias: false, forceWebGL: true });
await gpu.init();
for (const r of [gl, gpu]) { r.setPixelRatio(1); r.setSize(64, 64, false); }

// Every field the borrow promises, read back as plain values
const read = (r, scene, camera) => {
  const v = r.getViewport(new THREE.Vector4()), s = r.getScissor(new THREE.Vector4()), c = r.getClearColor(new THREE.Color());
  return { target: r.getRenderTarget()?.name ?? null, face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), viewport: v.toArray().join(), scissor: s.toArray().join(),
    scissorTest: r.getScissorTest(), clear: c.getHexString(), alpha: r.getClearAlpha(), autoClear: r.autoClear, tone: r.toneMapping, exposure: r.toneMappingExposure,
    shadowAuto: r.shadowMap.autoUpdate, override: scene.overrideMaterial?.name ?? null, background: scene.background?.getHexString?.() ?? null, fog: !!scene.fog, fogNode: scene.fogNode ? 'node' : null,
    layers: camera.layers.mask, mrt: r.getMRT ? !!r.getMRT() : null, drawing: drawing(r) };
};
// What really draws, not what the getters say: on WebGL the GL viewport / scissor box / scissor test and three's current viewport (a bound target
// draws with its own, a setViewport after the bind with the set one); on WebGPU the viewport's depth range, which getViewport's Vector4 drops
const drawing = r => {
  if (r === gpu) { const v = gpu.getCanvasTarget()._viewport; return `depth ${v.minDepth},${v.maxDepth}`; }
  const c = r.getContext();
  return [r.getCurrentViewport(new THREE.Vector4()).toArray(), [...c.getParameter(c.VIEWPORT)], [...c.getParameter(c.SCISSOR_BOX)], c.isEnabled(c.SCISSOR_TEST)].join(' | ');
};

window.borrowCase = (name, order) => {
  const r = name === 'gl' ? gl : gpu;
  const opts = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter };
  const cube = name === 'gl' ? new THREE.WebGLCubeRenderTarget(16, opts) : new TG.CubeRenderTarget(16, opts);
  cube.texture.name = cube.name = 'cube';
  const other = name === 'gl' ? new THREE.WebGLRenderTarget(8, 8) : new THREE.RenderTarget(8, 8);
  other.name = 'other';
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const bomb = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  bomb.onBeforeRender = () => { throw new Error('boom inside render'); };   // thrown by three's own render loop, not by the borrow's caller
  bomb.layers.enableAll(); scene.add(bomb); camera.position.z = 3;   // on every layer: the draw below looks through layer 2 only
  // the state a frame may be in when a task borrows the renderer: a cube face and mip of a target, a viewport, a scissor, its own clear
  scene.background = new THREE.Color(0x224466); scene.fog = new THREE.Fog(0xffffff);
  // the fog WebGPURenderer draws is scene.fogNode, not scene.fog: a pass that clears it and throws must not leave the game's fog off
  if (name === 'gpu') scene.fogNode = TG.TSL.fog(TG.TSL.color(0xffffff), TG.TSL.rangeFogFactor(1, 10));
  scene.overrideMaterial = Object.assign(new THREE.MeshBasicMaterial(), { name: 'debugView' });
  camera.layers.mask = 0b101;
  // order 'after': viewport and scissor set after the bind (they draw); 'own': set before it (the cube's own 16x16, no scissor, draws)
  const set = () => { r.setViewport(1, 2, 30, 40, 0.2, 0.8); r.setScissor(3, 4, 10, 12); r.setScissorTest(true); };
  if (order === 'after') { r.setRenderTarget(cube, 3, 1); set(); } else { set(); r.setRenderTarget(cube, 3, 1); }
  r.setClearColor(0x123456, 0.5); r.autoClear = false; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.7; r.shadowMap.autoUpdate = false;
  const before = read(r, scene, camera);
  let thrown = null, during = null, nested = null;
  try {
    borrowRenderer(r, () => {
      r.setClearColor(0xff0000, 1); r.autoClear = true; r.toneMapping = THREE.NoToneMapping; r.toneMappingExposure = 1; r.shadowMap.autoUpdate = true;
      r.setViewport(0, 0, 8, 8); r.setScissor(0, 0, 8, 8); r.setScissorTest(false);
      scene.overrideMaterial = null; scene.background = null; scene.fog = null; scene.fogNode = null; camera.layers.set(2);
      // a nested borrow that returns gives back only what it took: the outer one's state, not the frame's
      borrowRenderer(r, () => { r.setRenderTarget(null); r.setClearColor(0x00ff00, 1); });
      nested = read(r, scene, camera);
      r.setRenderTarget(other);
      during = read(r, scene, camera);
      r.render(scene, camera);
    }, { scene, camera, clean: true });
  } catch (err) { thrown = err.message; }
  const after = read(r, scene, camera);
  r.setRenderTarget(null); r.setScissorTest(false); r.setViewport(0, 0, 64, 64); r.setScissor(0, 0, 64, 64);
  cube.dispose(); other.dispose();
  return { before, during, nested, after, thrown };
};

window.rayCase = () => {
  const rays = engine.rays, base = rays.statics.size;
  const sphere = () => new THREE.SphereGeometry(1, 32, 32);   // 1984 triangles: over the BVH threshold
  const big = new THREE.Mesh(sphere()), shared = new THREE.Mesh(big.geometry);   // two meshes on one geometry
  const mine = new THREE.Mesh(sphere()), own = () => {};
  mine.raycast = own;   // a game's own raycast override
  const listed = threePatches.list().find(p => p.id === 'ray-bvh') ?? null;
  const h1 = rays.addStatic(big), h2 = rays.addStatic(shared), h3 = rays.addStatic(mine);
  const on = { big: Object.hasOwn(big, 'raycast') && big.raycast !== THREE.Mesh.prototype.raycast, tree: !!big.geometry.boundsTree, mine: mine.raycast === own };
  h1.remove();
  const half = { big: Object.hasOwn(big, 'raycast'), tree: !!big.geometry.boundsTree, shared: Object.hasOwn(shared, 'raycast') };
  h2.remove(); h3.remove();
  const off = { big: Object.hasOwn(big, 'raycast'), shared: Object.hasOwn(shared, 'raycast'), tree: !!big.geometry.boundsTree, mine: mine.raycast === own, mineTree: !!mine.geometry.boundsTree };
  // a boundsTree the game built stays the game's; a geometry dispose unregisters and gives the raycast back
  const g = new THREE.Mesh(sphere()); computeBoundsTree.call(g.geometry); const gameTree = g.geometry.boundsTree;
  rays.addStatic(g);
  const gFast = Object.hasOwn(g, 'raycast');
  g.geometry.dispose();
  const disposed = { fast: gFast, raycast: Object.hasOwn(g, 'raycast'), tree: g.geometry.boundsTree === gameTree, statics: rays.statics.size - base };
  return { listed, on, half, off, disposed };
};
window.ready = true;
