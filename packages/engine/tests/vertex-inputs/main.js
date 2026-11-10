// Vertex inputs on WebGPURenderer (tests/specs/vertex-inputs.mjs). A device takes 16 vertex inputs per program (WebGPU maxVertexAttributes, WebGL2
// MAX_VERTEX_ATTRIBS); an instanced mesh already spends 4 on its matrix, the velocity buffer of temporalAA 4 more on last frame's matrix, the instance
// color 1. Why this page: wind and the near-only fade each read the instance origin, and once read the whole matrix again as 4 more inputs per call,
// so grass with both and temporalAA needed 21 and its pipeline failed to build (a game had to fall back to MSAA).
import * as THREE from 'three';
import 'threedog/tsl';
import { createEngine, vegetation, mergeColored } from '../../index.js';
import { temporalAA } from '@threedog/post-effects/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, instancedBufferAttribute, vec4 } from 'three/tsl';
import { nodeProgram } from '../../render/backend.js';

const W = 160, H = 120;
const errors = [];
const keep = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); keep(...a); };

const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
const e = window.engine = createEngine({ canvas, renderer: 'webgpu', pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false, saveKey: 'test-vertex-inputs' });
e.use(vegetation({ area: { min: [-8, -8], max: [8, 8] } }));
const blade = () => mergeColored([[new THREE.ConeGeometry(0.3, 0.9, 5).translate(0, 0.45, 0), 0xa8b848]]);
// grass: wind and the near-only distance fade, the two position patches that read the instance origin
e.vegetation.define('grass', { geometry: blade(), nearOnly: true, wind: 0.05, rule: { perChunk: 120 } });
await e.start();
e.haltLoop();
e.camera.position.set(0, 4, 8); e.camera.lookAt(0, 0, 0); e.camera.updateMatrixWorld();

/** The vertex inputs of the program a material was built into: the `in` declarations of the vertex code (GLSL on the WebGL2 backend, WGSL @location on WebGPU) */
function inputs(material) {
  const src = nodeProgram(e.renderer, material)?.vertexShader ?? '';
  const glsl = src.match(/^\s*(layout\s*\([^)]*\)\s*)?in\s+\w+\s+\w+\s*;/gm) ?? [];
  // WGSL: the inputs are the parameters of the vertex main (the varyings carry @location too, in their own struct)
  const params = /fn\s+main\s*\(([\s\S]*?)\)\s*->/.exec(src)?.[1] ?? '';
  const wgsl = params.match(/@location\(\s*\d+\s*\)\s*(\w+)/g) ?? [];
  const names = glsl.length ? glsl.map(l => l.trim().split(/\s+/).pop()?.replace(';', '')) : wgsl.map(l => l.split(/\)\s*/).pop());
  return { count: Math.max(glsl.length, wgsl.length), names };
}

window.grassWithTAA = async () => {
  const m = [e.vegetationDraw.kind('grass').material].flat()[0];
  e.step(1 / 60);
  const plain = inputs(m);
  e.post.add(temporalAA());
  for (let i = 0; i < 3; i++) e.step(1 / 60);
  await new Promise(requestAnimationFrame);
  const taa = inputs(m);
  return { backend: e.describe().render.backend, plain, taa, errors: errors.slice() };
};

/**
 * A program over the limit on purpose, with temporalAA on: 5 geometry attributes (position, normal, uv, a0, a1), instance matrix 4, last frame's 4,
 * instance color 1 and three attribute nodes of the material's own = 17. 5 geometry attributes keep three on its shared instancing (Instance.js
 * canReferenceInstanceData: at most 8 buffers), where the matrices are vertex inputs on both backends. The engine must name what stacked up before
 * the pipeline fails (three then draws its plain stand-in).
 */
window.overLimit = async () => {
  const N = 300, g = new THREE.PlaneGeometry(0.2, 0.2), vc = g.attributes.position.count;
  for (const n of ['a0', 'a1']) g.setAttribute(n, new THREE.Float32BufferAttribute(new Float32Array(vc * 4), 4));
  const own = [0, 1, 2].map(() => instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4)));
  const m = new MeshBasicNodeMaterial();
  m.colorNode = vec4(attribute('uv'), 0, 1).add(attribute('a0')).add(attribute('a1')).add(own[0]).add(own[1]).add(own[2]);
  const im = new THREE.InstancedMesh(g, m, N);
  im.name = 'stacked';
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  e.scene.add(im);
  const before = errors.length;
  for (let i = 0; i < 2; i++) e.step(1 / 60);
  await new Promise(requestAnimationFrame);
  e.scene.remove(im);
  return { errors: errors.slice(before) };
};
