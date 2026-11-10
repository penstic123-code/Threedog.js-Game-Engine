// Asset gallery with node materials (tests/specs/gallery-webgpu.mjs): the gallery (@threedog/tools/gallery, used by `threedog gallery --shots`
// and the preview of `threedog lib add`) once drew with a WebGLRenderer only, so a model with a TSL material came out as an empty turntable.
// Two engines register the same pair of models (a node material box and a classic one): one on the WebGPU route, one on WebGL, where the
// gallery must still pick a WebGPURenderer because an asset carries a node material.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import { color } from 'three/tsl';
import 'threedog/tsl';
import { shots, openGallery, hasNodeMaterial } from '@threedog/tools/gallery';
import { createEngine } from '../../index.js';

const box = material => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
const models = {
  nodeBox: () => { const m = new TG.MeshStandardNodeMaterial({ roughness: 1 }); m.colorNode = color(0xff1010); return box(m); },
  plainBox: () => box(new THREE.MeshStandardMaterial({ color: 0x1030ff, roughness: 1 })),
  // the look-dev probe: every channel has its own value, so each channel picture must differ from the others and from the lit one
  probeBall: () => new THREE.Mesh(new THREE.SphereGeometry(0.5, 48, 24), new THREE.MeshStandardMaterial({ color: 0xff2020, roughness: 0.8, metalness: 0.3 })),
};

async function make(extra, mods = models) {
  const e = createEngine({ canvas: Object.assign(document.createElement('canvas'), { width: 160, height: 120 }), lights: false, ui: { loading: false },
    urlState: false, saveKey: 'test-gallery-webgpu', ...extra });
  e.assets.manifest({ models: mods });
  await e.start();
  e.haltLoop();
  return e;
}

/** Share of pixels (%) in the middle third of a PNG where channel ch clearly leads the other two (the box's own color) */
async function boxShare(png, ch) {
  const img = new Image(); img.src = png; await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const t = Math.floor(img.width / 3), d = x.getImageData(t, t, t, t).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = [d[i], d[i + 1], d[i + 2]], other = Math.max(...v.filter((_, k) => k !== ch));
    if (v[ch] > 60 && v[ch] > 1.8 * other) n++;
  }
  return +(100 * n / (t * t)).toFixed(1);
}

/** Mean [r, g, b] of the middle third of a PNG (where the framed asset is) */
async function middle(png) {
  const img = new Image(); img.src = png; await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const t = Math.floor(img.width / 3), d = x.getImageData(t, t, t, t).data, s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
  return s.map(v => Math.round(v / (t * t)));
}

window.engine = await make({ renderer: 'webgpu' });
// the game's own light (the "game" setup copies it) and a TSL material that is not an asset, only on a mesh in the scene (the "one shader" case)
{
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.position.set(-4, 6, 2);
  const lava = new TG.MeshBasicNodeMaterial(); lava.colorNode = color(0x10ff10); lava.name = 'lava';
  window.engine.scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.3), new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), lava));
}

/** The look-dev switches of the gallery: channels, light setups, exposure / tone mapping, one material, the live grid's header */
window.galleryLookdev = async () => {
  const out = {};
  for (const [route, e] of [['gpu', window.engine], ['gl', await make({})]]) {
    const list = await shots(e, { size: 96, only: ['probeBall'], modes: ['silhouette', 'albedo', 'normal', 'roughness', 'metalness', 'ao'] });
    const r = { errors: list.filter(s => s.error).map(s => `${s.name}/${s.light}: ${s.error}`), mean: {}, facts: {} };
    for (const s of list) if (s.png && s.light !== 'silhouette') { r.mean[s.light] = await middle(s.png); if (s.facts) r.facts[s.light] = s.facts.p50; }
    out[route] = r;
    if (route === 'gl') e.dispose();
  }
  const e = window.engine;
  const light = await shots(e, { size: 96, only: ['probeBall'], lights: ['studio', 'game'] });
  out.lights = Object.fromEntries(await Promise.all(light.map(async s => [s.light, s.png ? await middle(s.png) : s.error])));
  out.lightNotes = light.filter(s => s.note).map(s => s.note);
  const lum = async x => { const [s] = await shots(e, { size: 96, only: ['probeBall'], lights: ['midday'], tone: 'aces', exposure: x }); return (await middle(s.png)).reduce((a, b) => a + b); };
  out.exposure = [await lum(0.4), await lum(2.5)];
  const mat = await shots(e, { size: 96, material: 'lava', modes: ['albedo'] });
  out.material = { names: [...new Set(mat.map(s => `${s.name}:${s.type}`))], errors: mat.filter(s => s.error).map(s => s.error), albedo: await middle(mat.find(s => s.light === 'albedo').png) };
  out.missing = (await shots(e, { size: 32, material: 'nope' }))[0].error;
  // the live grid: switching the header to one channel changes every cell; the midday cell of the probe then shows its roughness gray
  const g = await openGallery(e), frames = () => new Promise(res => { let n = 4; const f = () => (--n ? requestAnimationFrame(f) : res()); requestAnimationFrame(f); });
  const cell = () => [...document.querySelectorAll('canvas[title]')].find(c => c.title === 'probeBall · midday');
  await frames(); out.liveFinal = cell() ? await middle(cell().toDataURL('image/png')) : null;
  g.set({ channel: 'roughness' }); await frames(); out.liveRough = cell() ? await middle(cell().toDataURL('image/png')) : null;
  g.close();
  // a WebGL game without node-material assets: its live grid keeps its WebGL renderer (its onBeforeCompile materials draw as in the game): the channel switch is off there, and says why
  const ge = await make({}, { plainBox: models.plainBox, probeBall: models.probeBall }), gg = await openGallery(ge), sel = document.querySelector('select');
  await frames();
  out.glLive = { disabled: !!sel?.disabled, why: sel?.title ?? '', drawn: !!(await (async () => { const c = [...document.querySelectorAll('canvas[title]')].find(x => x.title === 'probeBall · midday'); return c && (await middle(c.toDataURL('image/png')))[0] > 60; })()) };
  gg.close(); ge.dispose();
  return out;
};

window.galleryNodeMaterials = async () => {
  const out = { node: hasNodeMaterial(models.nodeBox()), plain: hasNodeMaterial(models.plainBox()) };
  for (const [route, e] of [['gpu', window.engine], ['gl', await make({})]]) {
    const list = await shots(e, { size: 96, only: ['nodeBox', 'plainBox'] });
    const r = { renderer: e.renderer.isWebGPURenderer ? 'webgpu' : 'webgl', errors: list.filter(s => s.error).map(s => `${s.name}: ${s.error}`), count: list.length };
    const midday = n => list.find(s => s.name === n && s.light === 'midday')?.png;
    r.nodeRed = midday('nodeBox') ? await boxShare(midday('nodeBox'), 0) : -1;
    r.plainBlue = midday('plainBox') ? await boxShare(midday('plainBox'), 2) : -1;
    out[route] = r;
    if (route === 'gl') e.dispose();
  }
  // the live grid (?gallery=1): each cell is a canvas the picture is copied into; the node material box's midday cell shows its red
  const g = await openGallery(window.engine);
  for (let i = 0; i < 4; i++) await new Promise(res => requestAnimationFrame(res));
  const cell = [...document.querySelectorAll('canvas[title]')].find(c => c.title === 'nodeBox · midday');
  out.live = cell ? await boxShare(cell.toDataURL('image/png'), 0) : -1;
  g.close();
  out.liveGone = !document.querySelector('canvas[title]');
  return out;
};
