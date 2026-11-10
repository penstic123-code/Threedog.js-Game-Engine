// Every performance feature on one real scene (tests/specs/perf-all.mjs): terrain and a level under one ground, repeated props and stream blocks that really batch, hlod, occlusion,
// kept shadows, threads 'auto'. Why one page: each feature has its own tests, and what none of them can show is two of them disagreeing about who draws or hides a mesh.
// ?r=gpu runs on WebGPURenderer (the WebGL2 backend in the suite, a real device under packages/tools/real-webgpu.mjs), where kept shadows are real; else WebGLRenderer.
import * as THREE from 'three';
import 'threedog/tsl';
import { createEngine, presets, world, terrain, compositeGround, collision, followCamera, characters, hlod, level, content } from '../../index.js';
import { terrainPreset } from '@threedog/terrain-noise';
import { bloom, vignette } from '@threedog/post-effects';
import * as TG from 'three/webgpu';
import { renderOnce } from '../../render/backend.js';
import { RESERVED_LAYERS } from '../../render/layers.js';

const gpu = location.search.includes('r=gpu'), W = 320, H = 200, BATCHED = RESERVED_LAYERS.batched;
const tick = () => new Promise(r => setTimeout(r, 0));
const lit = c => new THREE.MeshStandardMaterial({ color: c, roughness: 1 });
const crateGeo = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0), crateMat = lit(0xa07040);
const pillarGeo = new THREE.BoxGeometry(1, 6, 1).translate(0, 3, 0), pillarMat = lit(0x6080a0);
const SPOT = [[0, 0], [-60, 20], [60, 30]];     // crate clusters on the level
const BLOCKS = [[-40, -60], [40, -60], [0, -90]];   // stream blocks of pillars
const FAR = [900, 0, 900];

const still = o => { o.traverse(m => { m.userData.still = true; }); return o; };
function crate() { const m = new THREE.Mesh(crateGeo, crateMat); m.castShadow = m.receiveShadow = true; return still(m); }
/** A level: one floor, a street of different buildings (hlod merges them; batching has no two alike to take) */
function town(seed) {
  const root = new THREE.Group(); root.name = `town${seed}`;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), lit(0x808880));
  floor.name = 'floor'; floor.receiveShadow = true; root.add(floor);
  const m = [lit(0x907060), lit(0x708090), lit(0x90905c)];
  for (let i = 0; i < 40; i++) {
    const h = 6 + (i * 7 + seed * 3) % 11, b = new THREE.Mesh(new THREE.BoxGeometry(8, h, 8 + i % 3), m[(i + seed) % 3]);
    b.name = `house${i}`; b.position.set(-140 + (i % 10) * 30, h / 2, seed === 1 ? -130 - (i / 10 | 0) * 9 : 110 + (i / 10 | 0) * 9);
    b.castShadow = b.receiveShadow = true; root.add(b);
  }
  // a wall facing the camera of the shots: what stands behind it is what occlusion may hide
  const wall = new THREE.Mesh(new THREE.BoxGeometry(200, 30, 2), m[0]);
  wall.name = 'wall'; wall.position.set(0, 15, -44); wall.castShadow = wall.receiveShadow = true; root.add(wall);
  return still(root);
}

let n = 0, live = null;
/** @param {{ on: boolean }} o on: every feature, off: none of them */
async function boot({ on }) {
  if (live) { live.dispose(); live = null; }
  document.getElementById('view')?.remove();
  const canvas = Object.assign(document.createElement('canvas'), { id: 'view', width: W, height: H });
  document.body.appendChild(canvas);
  const e = window.engine = live = createEngine({ canvas, renderer: gpu ? 'webgpu' : 'webgl', threads: on ? 'auto' : false, batching: on ? {} : false, lights: false, pixelRatio: 1,
    adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false, seed: 7, saveKey: `perf-all-${++n}`, bindings: { ...presets.bindings.walk } });
  e.assets.manifest({ models: { crate } });
  const street = town(1);
  e.use(world(), terrain({ ...terrainPreset(), seed: 7, part: true }), level({ scene: street, part: true }),
    compositeGround({ parts: [{ of: 'level', region: (x, z) => Math.abs(x) <= 160 && Math.abs(z) <= 160, priority: 1 }, { of: 'terrain' }] }),
    collision(), followCamera(), characters({ npcs: false }), ...(on ? [hlod()] : []), content());
  e.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 70 } });
  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.position.set(-60, 120, 80); sun.castShadow = true; sun.shadow.mapSize.setScalar(1024);
  Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 1, far: 400 });
  e.scene.add(sun, sun.target, new THREE.AmbientLight('#ffffff', 0.5));
  e.scene.background = new THREE.Color(0x203040);
  e.camera.far = 900;

  const props = [];
  SPOT.forEach(([x, z], s) => { for (let i = 0; i < 24; i++) props.push({ id: `c${s}-${i}`, model: 'crate', x: x + (i % 6) * 4 - 10, z: z + (i / 6 | 0) * 4 - 6, collide: 'box' }); });
  e.content.load({ props });
  const blocks = BLOCKS.map(([x, z]) => e.stream.add({ position: [x, 0, z], radius: 30,
    build: () => { const g = new THREE.Group(); g.name = 'block'; for (let i = 0; i < 16; i++) { const m = new THREE.Mesh(pillarGeo, pillarMat); m.position.set(x + (i % 4) * 5 - 8, 0, z + (i / 4 | 0) * 5 - 8); m.castShadow = true; g.add(m); } return still(g); },
    dispose: g => e.remove(g) }));
  await e.start();
  const halt = e.haltLoop();
  // hlod and occlusion come after the first frame in a game too; shadows keep what the page marked, and the page redraws them when it changes what is static
  let kept = null;
  if (on) {
    e.occlusion.enabled = true;
    kept = e.shadows.cache(sun, { static: m => m.userData.still === true });
    e.events.on('level:loaded', () => kept.redraw());
  }
  return { e, on, sun, kept, blocks, halt, street };
}

const steps = async (e, k) => { for (let i = 0; i < k; i++) { e.step(1 / 60); if (i % 8 === 7) await tick(); } };
/** Until the world around the player stands (models are async, teleports wait on steps) */
async function settle(e, k = 240) { await steps(e, k); for (let i = 0; i < 40 && !e.world.ready; i++) await steps(e, 8); }
async function go(e, at) {
  let on = true;
  const pump = (async () => { for (let i = 0; on && i < 4000; i++) { e.step(1 / 60); await tick(); } })();
  try { await e.stream.teleport(at, { timeout: 60 }); } finally { on = false; await pump; }
}

/** Every mesh of the repeated models with its one honest answer: how many times it is drawn */
function census(e) {
  const B = e.batching, inst = new Map();
  let doubled = 0, wrongSlot = 0, orphans = 0;
  for (const b of B.batches) {
    if (b.mesh.count !== b.items.length) wrongSlot++;
    if (!b.mesh.parent) orphans++;
    b.items.forEach((root, i) => {
      if (!root.parent) orphans++;
      const m = new THREE.Matrix4(); b.mesh.getMatrixAt(i, m);
      root.traverse(o => { if (o.isMesh) inst.set(o, (inst.get(o) ?? 0)); });
      const parts = B.of(root).filter(x => x.mesh === b.mesh && x.index === i);
      if (parts.length) { let hit = null; root.traverse(o => { if (o.isMesh && !hit && Math.abs(o.matrixWorld.elements[12] - m.elements[12]) < 1e-3 && Math.abs(o.matrixWorld.elements[14] - m.elements[14]) < 1e-3) hit = o; }); if (hit) inst.set(hit, inst.get(hit) + 1); else wrongSlot++; }
    });
  }
  let plain = 0, batched = 0, lost = 0, crates = 0, pillars = 0;
  e.scene.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || (o.geometry !== crateGeo && o.geometry !== pillarGeo)) return;
    o.geometry === crateGeo ? crates++ : pillars++;
    const self = o.layers.isEnabled(0) && !o.layers.isEnabled(BATCHED) ? 1 : 0, viaBatch = inst.get(o) ?? 0;
    if (self + viaBatch > 1) doubled++;
    if (self + viaBatch === 0) lost++;
    self ? plain++ : batched += viaBatch;
  });
  let sum = 0; for (const b of B.batches) if (b.mesh.geometry === crateGeo || b.mesh.geometry === pillarGeo) sum += b.mesh.count;
  return { crates, pillars, plain, batched, lost, doubled, wrongSlot, orphans, sum, batches: B.stats.batches, instances: B.stats.instances };
}

/** What the collision answers: a line through the crates of two clusters (one batched, one partly plain) and one through a free lane */
function blocks(e) {
  const c = e.collision, [x, z] = SPOT[0], [x1, z1] = SPOT[1];
  return { crate: c.lineClear([x - 10, 1, z - 13], [x - 10, 1, z + 13], { radius: 0.3 }), lane: c.lineClear([x + 40, 1, z - 13], [x + 40, 1, z + 13], { radius: 0.3 }), crate2: c.lineClear([x1 - 10, 1, z1 - 13], [x1 - 10, 1, z1 + 13], { radius: 0.3 }), ground: e.surface(x, z) };
}

/** Batching against streaming: everything a batch has to survive, in step mode, read after each move */
window.batchRun = async () => {
  const s = await boot({ on: true }), { e } = s, out = {};
  e.occlusion.enabled = false;   // this run is about batching alone; the all-features run below keeps it on
  await settle(e);
  const read = name => { out[name] = { ...census(e), ...blocks(e) }; };
  read('home');
  const home = e.player.position.toArray();
  await go(e, FAR); await settle(e, 120); read('far');
  await go(e, home); await settle(e); read('back');
  const props = [];
  SPOT.forEach(([x, z], i) => { for (let k = 0; k < 24; k++) props.push({ id: `c${i}-${k}`, model: 'crate', x: x + (k % 6) * 4 - 10, z: z + (k / 6 | 0) * 4 - 6, collide: 'box' }); });
  e.content.load({ props }); await settle(e, 60); read('reload');
  e.world.remove('c1-3'); e.world.remove('c1-4'); await settle(e, 30); read('removed');
  const saved = structuredClone(e.saves.collect());
  e.world.add({ id: 'late', kind: 'prop', model: 'crate', position: { x: 40, y: 0, z: 70 } }); await settle(e, 30);
  await e.saves.apply(saved, 'perf-all'); await settle(e); read('loaded');
  await go(e, FAR); await settle(e, 120);
  await e.saves.apply(structuredClone(saved), 'perf-all'); await settle(e); read('loadedFromFar');
  // a load landing on a far player brings it home: its save position; the cells around it come back by themselves
  out.error = e.error?.message ?? null;
  return out;
};

async function picture(e) {
  const c = e.camera, mask = c.layers.mask;
  c.layers.disable(RESERVED_LAYERS.occlusionBox);
  const rt = gpu ? new TG.RenderTarget(W, H) : new THREE.WebGLRenderTarget(W, H);
  renderOnce(e.renderer, e.scene, c, rt);
  c.layers.mask = mask;
  let px;
  if (gpu) px = new Uint8Array(await e.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
  else { px = new Uint8Array(W * H * 4); e.renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); }
  rt.dispose();
  return px;
}
const lookFrom = (e, p, t) => { e.camera.position.set(...p); e.camera.lookAt(...t); e.camera.updateMatrixWorld(); };

/** Real frames: the occlusion answers and kept shadows only exist on them. Frozen, so wall-clock time does not reach the state being compared. Returns frame times in ms */
async function frames(s, count) {
  const { e } = s, ms = [], hold = e.freeze('perf-all');
  s.halt.remove();
  let last = performance.now();
  for (let i = 0; i < count; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const t = performance.now(); ms.push(t - last); last = t;
    // rAF intervals stop at the display's rate, so the loop's own measure is what can differ
    if (i % 10 === 9) (s.cpu ??= []).push(e.describe().perf?.cpuMs ?? 0);
  }
  s.halt = e.haltLoop();
  hold.remove();
  return ms;
}
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return +b[Math.floor(b.length * q)].toFixed(2); };

/** The same script with every feature on or off. Marks are the moments the two must agree */
async function script(on) {
  const s = await boot({ on }), { e } = s, marks = [], rec = {};
  e.takeCamera('perf-all');
  const mark = async name => {
    const parts = JSON.parse(JSON.stringify(e.saves.collect().parts));
    marks.push({ name, px: await picture(e), parts, tick: e.time.tick, player: e.player.position.toArray(), lines: blocks(e), census: census(e), hidden: e.occlusion.stats?.hidden ?? 0 });
  };
  await settle(e);
  lookFrom(e, [0, 12, 110], [0, 8, 0]);
  await steps(e, 4);
  await mark('home');
  const ms1 = await frames(s, 90);
  rec.hiddenSeen = e.occlusion.stats?.hidden ?? 0;
  await mark('home after real frames');

  const home = e.player.position.toArray();
  await go(e, FAR); await settle(e, 120);
  await go(e, home); await settle(e);
  lookFrom(e, [0, 12, 110], [0, 8, 0]); await steps(e, 4);
  await frames(s, 30);
  await mark('back from far');

  const saved = structuredClone(e.saves.collect());
  await e.level.load(town(2)); await settle(e); await steps(e, 4);
  lookFrom(e, [0, 12, 110], [0, 8, 0]);
  await frames(s, 30);
  await mark('second level');

  await e.saves.apply(saved, 'perf-all'); await settle(e);
  lookFrom(e, [0, 12, 110], [0, 8, 0]); await steps(e, 4);
  await frames(s, 30);
  await mark('loaded');

  const persp = e.camera, ortho = new THREE.OrthographicCamera(-90, 90, 56, -56, 0.1, 900);
  ortho.position.set(60, 60, 120); ortho.lookAt(0, 0, 0);
  e.camera = ortho; ortho.updateMatrixWorld();
  await steps(e, 4); await frames(s, 30);
  await mark('orthographic');
  e.camera = persp; lookFrom(e, [0, 12, 110], [0, 8, 0]); await steps(e, 4); await frames(s, 30);
  await mark('perspective again');
  const ms2 = await frames(s, 120);
  rec.ms = { p50: pct([...ms1, ...ms2], 0.5), p95: pct([...ms1, ...ms2], 0.95), max: pct([...ms1, ...ms2], 1 - 1e-9) };
  rec.cpuMs = { p50: pct(s.cpu, 0.5), p95: pct(s.cpu, 0.95) };
  rec.backend = e.renderer.backend?.isWebGPUBackend ? 'webgpu' : gpu ? 'webgl2-backend' : 'webgl';
  rec.error = e.error?.message ?? null;
  rec.stats = { batches: e.batching.stats.batches, hlod: on ? e.describe().hlod ?? null : null, commits: e.commits.stats };
  return { rec, marks };
}

/** Percent of pixels that differ visibly, and the worst channel distance */
function diff(a, b) {
  let bad = 0, worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > 12) bad++;
    if (d > worst) worst = d;
  }
  return { bad: +(bad / (a.length / 4) * 100).toFixed(2), worst };
}
const partsDiff = (a, b) => {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = JSON.stringify(a[k]) ?? '', y = JSON.stringify(b[k]) ?? '';
    if (x !== y) { let i = 0; while (x[i] === y[i]) i++; out[k] = [x.slice(Math.max(0, i - 40), i + 40), y.slice(Math.max(0, i - 40), i + 40)]; }
  }
  return out;
};
/** Both runs side by side: picture, saved state, collision, frame times */
window.compareRun = async () => {
  const onRun = await script(true), offRun = await script(false);
  const marks = onRun.marks.map((m, i) => {
    const o = offRun.marks[i];
    return { name: m.name, pixels: diff(m.px, o.px), state: partsDiff(m.parts, o.parts), tick: [m.tick, o.tick], player: [m.player, o.player], lines: [m.lines, o.lines], census: m.census, hidden: m.hidden };
  });
  return { on: onRun.rec, off: offRun.rec, marks };
};

/** Seconds of the frames right after a perspective to orthographic switch with post effects on, against the steady frame */
window.switchRun = async ({ rounds = 8 } = {}) => {
  const s = await boot({ on: false }), { e } = s;
  e.takeCamera('perf-all');
  e.post.add(bloom()); e.post.add(vignette());
  await settle(e);
  lookFrom(e, [0, 12, 110], [0, 8, 0]);
  await frames(s, 60);
  const steady = await frames(s, 60);
  const persp = e.camera, ortho = new THREE.OrthographicCamera(-90, 90, 56, -56, 0.1, 900);
  ortho.position.set(60, 60, 120); ortho.lookAt(0, 0, 0);
  const sw = [];
  s.halt.remove();
  for (let i = 0; i < rounds * 2; i++) {
    const t0 = performance.now();
    e.camera = i % 2 ? persp : ortho;
    const set = performance.now() - t0;
    await new Promise(r => requestAnimationFrame(r));
    const first = performance.now() - t0;
    await new Promise(r => requestAnimationFrame(r));
    const second = performance.now() - t0 - first;
    sw.push({ to: i % 2 ? 'perspective' : 'orthographic', set: +set.toFixed(2), first: +first.toFixed(2), second: +second.toFixed(2) });
    for (let k = 0; k < 10; k++) await new Promise(r => requestAnimationFrame(r));
  }
  s.halt = e.haltLoop();
  return { backend: e.renderer.backend?.isWebGPUBackend ? 'webgpu' : gpu ? 'webgl2-backend' : 'webgl', steady: { p50: pct(steady, 0.5), p95: pct(steady, 0.95) }, sw, error: e.error?.message ?? null };
};
await boot({ on: false });   // the runners wait for a standing engine; each run below then builds its own
window.ready = true;
