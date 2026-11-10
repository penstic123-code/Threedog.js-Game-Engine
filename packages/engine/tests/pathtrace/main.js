// Path-traced photo page (tests/specs/photo-pathtrace.mjs): a lit floor and box (Standard, traced as drawn), a Lambert box and a patched material
// (both must be named as not traced), an AmbientLight (the tracer has none). URL: route=webgpu (renderer 'webgpu', its WebGL2 fallback headless),
// nolib (photo() without pathTracer: the install line), full (the canvas fills the page, for threedog shot --path-trace timings). Why the game's own import below: the engine never names the optional package (pathTrace.js).
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { color } from 'three/tsl';
import 'threedog/tsl';
import { createEngine, photo } from '../../index.js';

const q = new URLSearchParams(location.search), gpu = q.get('route') === 'webgpu';
if (q.has('full')) document.getElementById('view').style.cssText = 'width:100vw;height:100vh';
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false, ui: { loading: false },
  urlState: q.has('full'), saveKey: 'test-pathtrace', ...(gpu && { renderer: 'webgpu', fallback: 'webgl2' }) });
const pathTracer = q.has('nolib') ? null : gpu ? () => import('three-gpu-pathtracer/webgpu') : () => import('three-gpu-pathtracer');
engine.use(photo({ pathTracer }));
const std = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), std(0x9a9a9a)); floor.rotation.x = -Math.PI / 2;
const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), std(0xc04030)); box.position.set(0, 0.7, 0);
const lambert = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), Object.assign(new THREE.MeshLambertMaterial({ color: 0x3060c0 }), { name: 'lambertBox' }));
lambert.position.set(-2, 0.4, 0.5);
// each renderer's own way to change a look, which the tracer never runs: a shader hook on WebGL, a TSL color slot on WebGPU
const own = gpu ? Object.assign(new TG.MeshStandardNodeMaterial(), { name: 'tslBall', colorNode: color(0xffcc00) })
  : Object.assign(std(0x30a050), { name: 'patchedBall', onBeforeCompile: () => {} });
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), own); ball.position.set(2, 0.5, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 3); sun.position.set(4, 8, 5);
// a geometry without an index: the tracer's BVH gives it one, and the photo must put the game's geometry back as it was (index, boundsTree)
const loose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(), std(0xdddddd)); loose.position.set(1.2, 0.25, 1.6);
engine.add(floor, box, lambert, ball, loose, sun, new THREE.AmbientLight(0xffffff, 0.4));
// a boundsTree the game itself sets during a trace ({ game: true }) is its own and must stay
const geometryLeft = () => engine.scene.children.filter(o => o.isMesh && ((o.geometry.boundsTree && !o.geometry.boundsTree.game) || o.boundsTree || (o === loose) !== !o.geometry.index)).length;
// every indexed geometry's index, byte for byte: the tracer's BVH reorders it in place, and the photo must write the original order back
const indexBytes = () => engine.scene.children.filter(o => o.isMesh && o.geometry.index).map(o => o.geometry.index.array.join(',')).join('|');
engine.camera.position.set(0, 4, 7); engine.camera.lookAt(0, 0.5, 0);
await engine.start();
engine.haltLoop();

/** Mean luminance 0-1 and the share of pixels brighter than near-black, read from a photo's data URL */
async function stats(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0, lit = 0;
  for (let i = 0; i < d.length; i += 4) { const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; sum += y; if (y > 0.04) lit++; }
  return { mean: sum / (d.length / 4), lit: lit / (d.length / 4), size: [img.width, img.height] };
}
const message = async p => { try { await p; return ''; } catch (e) { return String(e?.message ?? e); } };
window.pathTraceTest = {
  real: async () => stats(engine.photo.take({ format: 'image/png', scale: 1 }).url),
  traced: async (samples, during) => {
    const before = indexBytes(), p = engine.photo.trace({ format: 'image/png', samples, seconds: 120 });
    if (during) { while (!(engine.photo.tracing?.samples > 0)) await new Promise(requestAnimationFrame); during(); }
    const s = await p;
    return { ...(await stats(s.url)), ...s.pathTraced, album: engine.photo.album.length, geometryLeft: geometryLeft(), indexSame: indexBytes() === before };
  },
  gameBounds: () => { floor.geometry.boundsTree = { game: true }; },   // the game's own, set mid-trace
  floorBounds: () => floor.geometry.boundsTree?.game === true,
  error: async opts => message(engine.photo.trace(opts)),
  backend: () => engine.describe().renderer,
};
