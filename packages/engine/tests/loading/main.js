// Test page: observable loading (engine.loading). The page's own engine starts normally with one good model;
// the spec builds extra headless engines through window.threedogLoad to provoke missing files, critical failures and slow steps.
import { createEngine, level, sky, characters, world, content, pickups } from '../../index.js';
import { protoOf, holdProtos, protoSlots, copyLeft, protoLease } from '../../core/assets/namedModel.js';
import { engineOwned } from '../../core/scene/things.js';
import { neutralMaterial } from '../../render/neutral.js';
import { markEngineMade } from '../../render/patches.js';
import { keepPart } from '../../core/base/freeParts.js';

/** A one-triangle glTF as a data URL; texture: an image URL the material references (to provoke a missing reference) */
function gltfUrl(texture) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bytes = new Uint8Array(pos.byteLength + uv.byteLength);
  bytes.set(new Uint8Array(pos.buffer), 0); bytes.set(new Uint8Array(uv.buffer), pos.byteLength);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, ...(texture ? { material: 0 } : {}) }] }],
    buffers: [{ byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes)) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    ...(texture ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: texture }] } : {}),
  };
  return 'data:model/gltf+json;base64,' + btoa(JSON.stringify(gltf));
}

/** A headless engine for one scenario (not window.engine); extra: createEngine options such as a custom loading part */
const make = (key, extra = {}) => createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'load-' + key, ...extra });
window.threedogLoad = { make, gltfUrl, level, protoOf, holdProtos, protoSlots, engineOwned, neutralMaterial, markEngineMade, keepPart, copyLeft, sky, characters, world, content, pickups, protoLease };   // level: tests/specs/loading.mjs (a missing level file blocks start); the rest: tests/specs/resource-lifetime.mjs
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), ui: { loading: { title: 'Loading test' } }, saveKey: 'test-loading', adaptiveResolution: false });
engine.assets.manifest({ name: 'page', models: { tri: { url: gltfUrl(), preload: true } } });
await engine.start();
