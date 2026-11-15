// pixelSize page (tests/specs/pixel-size.mjs). Why a checkerboard texture as scene.background: each texel is one art pixel on both renderers with no shader
// of its own, so the spec can read art pixel widths off a real screenshot. URL: route=webgl|webgpu, k, hand=1 (the old devicePixelRatio / k by hand, the control),
// fallback, post=1 (through the post chain).
import * as THREE from 'three';
import 'threedog/tsl';
import { vignette } from '@threedog/post-effects';
import { createEngine, photo, settings, followCamera, fixedCamera, characters, collision, rigid, world, Character } from '../../index.js';
import { pixelGrid, pixelSprite, spriteFrame } from 'threedog/pixel';
import { tierRatio } from '../../core/scene/pixelRatio.js';

const q = new URLSearchParams(location.search), k = +(q.get('k') ?? 3);
const opts = q.has('hand') ? { pixelRatio: devicePixelRatio / k, adaptiveResolution: false, antialias: false }
  : q.has('plain') ? {} : { pixelSize: k };
// a box whose CSS size is not a whole number, off the pixel grid: what CSS size times the ratio gets wrong and the browser's measured box does not
if (q.has('frac')) document.getElementById('c').style.cssText = 'width:66.7%;height:66.7%;margin-left:7.3px';
const engine = window.engine = createEngine({ canvas: document.getElementById('c'), lights: false, ui: { loading: false }, urlState: false, saveKey: 'test-pixel-size',
  ...(q.get('route') === 'webgpu' ? { renderer: 'webgpu', fallback: q.get('fallback') ?? 'webgl2' } : {}), ...opts });
if (q.has('hand')) engine.renderer.domElement.style.imageRendering = 'pixelated';
if (q.has('settings')) engine.use(settings());
// pixel=1: an orthographic rig for tests/specs/pixel-game.mjs. snap=0 is that spec's control, the same view without pixelSnap
const pitch = 0.6, yaw = 0.6, view = { projection: 'orthographic', pitch, yaw, distance: 30, minDistance: 1, maxDistance: 80, height: 0, smoothing: 1000, mouseLook: false, minPitch: 0.1 };
if (q.has('pixel')) engine.use(followCamera(q.get('snap') === '0' ? { ...view, size: 8 } : { ...view, pixelSnap: { pixelsPerMeter: 32 } }));
if (q.has('physics')) { engine.use(collision()); engine.use(rigid()); engine.use(world(), characters()); }
Object.assign(window, { THREE, pixelGrid, pixelSprite, spriteFrame, fixedCamera, Character });
engine.use(photo());
if (q.has('post')) engine.post.add(vignette({ strength: 0 }));
await engine.start();

/** Redraw the checkerboard at the size of the drawing buffer */
window.paint = () => {
  const { width: w, height: h } = engine.renderer.domElement, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = (x + y) & 1 ? 255 : 0; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  const t = new THREE.DataTexture(data, w, h);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
  engine.scene.background?.dispose?.();
  engine.scene.background = t;
};
window.paint();
window.tierRatio = tierRatio;
window.createEngine = createEngine;
window.frames = n => new Promise(done => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : done()); f(); });
/**
 * Run lengths of the checkerboard in a screenshot, across rows and down columns, in real pixels. Only inside the art pixels: the padding is the page's magenta.
 * gray counts blended pixels, which a hard edge never has.
 */
window.readWidths = async b64 => {
  const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0);
  const px = c.getImageData(0, 0, img.width, img.height).data, W = img.width, H = img.height, widths = {}, heights = {};
  const kind = (x, y) => { const i = (y * W + x) * 4, r = px[i], g = px[i + 1]; return g > 200 && r > 200 ? 1 : r < 50 && g < 50 ? 0 : r > 200 && g < 50 ? 'pad' : 'gray'; };
  let gray = 0;
  const walk = (n, m, at, out) => {
    for (let j = 0; j < m; j += 7) {
      let run = 0, was = null;
      for (let i = 0; i < n; i++) {
        const v = at(i, j);
        if (v === 'gray') gray++;
        if (v === 'pad') { if (was === null) continue; break; }   // the page before the canvas starts, or after it ends
        if (v === was) run++; else { if (was !== null) out[run] = (out[run] ?? 0) + 1; run = 1; was = v; }
      }
      if (was !== null) out[run] = (out[run] ?? 0) + 1;
    }
  };
  walk(W, H, (x, y) => kind(x, y), widths);
  walk(H, W, (y, x) => kind(x, y), heights);
  return { shot: [W, H], widths, heights, gray };
};
window.ready = true;
