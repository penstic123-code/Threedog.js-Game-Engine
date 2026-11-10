// Field stress page (driven by tests/stress-field/run.mjs, never part of the normal test run). One page per measurement: window.sf.* returns plain JSON.
// Why a separate page from tests/stress/: that one ramps a fixed set of axes on WebGL; this one asks the questions a medium game raises (object count with
// and without batching, long runs, create/destroy loops, saves, many modules) on WebGPU or WebGL2, in system Chrome on the real GPU.
import * as THREE from 'three';
import 'threedog/tsl';
import { WebGPURenderer } from 'three/webgpu';
import { createEngine, world, terrain, vegetation, sky, particles, weather } from '../../index.js';
import { terrainPreset } from '@threedog/terrain-noise';
import { cityMethods } from './city.js';
import { cityGameMethods } from './cityGame.js';
import { lightMethods } from './lights.js';
import { soakMethods } from './soak.js';

const q = new URLSearchParams(location.search);
const backend = ['webgl', 'webgpu-gl'].includes(q.get('backend')) ? q.get('backend') : 'webgpu';
const DT = 1 / 60, r2 = v => Math.round(v * 100) / 100;
const heap = () => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null;   // MB
const gc = async () => { try { window.gc?.(); } catch {} await new Promise(r => setTimeout(r, 30)); try { window.gc?.(); } catch {} };
const KINDS = ['crate', 'fence', 'ac', 'post'];

const mkEngine = (extra = {}, canvas = document.getElementById('view')) => createEngine({ canvas, headless: true, ui: { loading: false }, pixelRatio: 1, adaptiveResolution: false,
  urlState: false, saveKey: 'field-' + Math.random(), renderer: backend === 'webgpu' ? 'webgpu' : backend === 'webgpu-gl' ? new WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance', forceWebGL: true }) : undefined, ...extra });

/** Wait until the GPU has finished what was queued: WebGPU queue drain, or gl.finish() */
async function gpuDone(e) {
  const b = e.renderer.backend;
  if (b?.device?.queue?.onSubmittedWorkDone) await b.device.queue.onSubmittedWorkDone();
  else e.renderer.getContext?.().finish?.();
}
/** The same frame sequence as the real loop (as tests/perf does) */
function frame(e) { e.input.poll(DT); e._fixedStep(); e._frameHooks(DT); e._render(DT); e.budget.sample(DT); e.input.endFrame(); e._runHooks('afterRender', DT); }

/** CPU ms per frame (JS side, split render / the rest) and throughput ms per frame (K frames queued, then wait for the GPU): throughput >> cpu means GPU-bound */
async function measure(e, K = 40) {
  let renderMs = 0; const orig = e._render.bind(e);
  e._render = dt => { const t = performance.now(); orig(dt); renderMs += performance.now() - t; };
  e.haltLoop();
  for (let i = 0; i < 6; i++) frame(e);
  await gpuDone(e);
  const timing = e.profile() !== null;   // dev builds time modules all along: put it back as it was
  e.profile(true);
  renderMs = 0;
  let cpu = 0, worst = 0;
  const t0 = performance.now();
  for (let i = 0; i < K; i++) { const a = performance.now(); frame(e); const d = performance.now() - a; cpu += d; if (d > worst) worst = d; }
  const issued = performance.now() - t0;
  await gpuDone(e);
  const total = performance.now() - t0;
  const modules = Object.fromEntries(Object.entries(e.profile()).map(([k, p]) => [k, p.mean]));   // the run's average per frame
  if (!timing) e.profile(false);
  e._render = orig;
  const info = e.renderer.info;
  return { cpuMs: r2(cpu / K), renderMs: r2(renderMs / K), otherMs: r2((cpu - renderMs) / K), worstCpuMs: r2(worst), throughputMs: r2(total / K), gpuTailMs: r2((total - issued) / K),
    drawCalls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures,
    batchStats: e.batching?.stats ?? null, modules };
}

const ready = e => e.start().then(() => e);
const mat = c => new THREE.MeshLambertMaterial({ color: c });
const part = (geo, m, y) => { const p = new THREE.Mesh(geo, m); p.position.y = y; return p; };
const models = () => ({ crate: part(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(0xa08050), 0.4), fence: part(new THREE.BoxGeometry(2, 1, 0.1), mat(0x8a6a4a), 0.5),
  ac: part(new THREE.BoxGeometry(0.9, 0.6, 0.5), mat(0xcccccc), 0.3), post: part(new THREE.CylinderGeometry(0.1, 0.1, 3, 6), mat(0x555555), 1.5) });
const viewsOf = e => e.counts().world?.views ?? 0;

/** n world records presented as clones of 4 models. moving: every object is moved each frame in the present() update hook. */
async function propsScene(e, n, moving) {
  e.use(world());
  const M = models(), side = Math.ceil(Math.sqrt(n)), step = 2.6;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) e.world.add({ kind: 'thing', model: KINDS[i % 4], position: [(i % side - side / 2) * step, 0, (Math.floor(i / side) - side / 2) * step], rot: i * 0.7 }, { save: false });
  const addMs = performance.now() - t0;
  let t = 0;
  e.world.present('thing', { radius: 1e6, build: rec => { const o = M[rec.model].clone(); o.rotation.y = rec.rot; return o; },
    ...(moving && { update: (rec, o) => { o.position.y = Math.sin(t + rec.rot * 3) * 0.5 + 0.5; } }) });
  if (moving) e.onFrame(dt => { t += dt; });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(side * step * 1.1, side * step * 1.1).rotateX(-Math.PI / 2), mat(0x9a9a9a)); e.add(ground);
  const half = side * step / 2;
  e.camera.far = Math.max(2000, half * 4); e.camera.updateProjectionMatrix();
  e.camera.position.set(0, half * 0.9, half * 1.1); e.camera.lookAt(0, 0, 0);
  const t1 = performance.now(); let views = 0, rounds = 0;
  while (performance.now() - t1 < 240000) { e.world.refresh(); rounds++; views = viewsOf(e); if (views >= n) break; frame(e); }
  return { addMs: Math.round(addMs), buildMs: Math.round(performance.now() - t1), views, rounds };
}

window.sf = {
  backend, heap, gc,
  /** Record sweep (render/recordSweep.js): ms per frame step and in all, with n records, nothing to free and then all of them to free */
  async sweepCost({ n }) {
    const e = await ready(mkEngine({ batching: false })), s = e._records, mat = new THREE.MeshBasicMaterial(), geo = new THREE.BoxGeometry(), ms = [];
    e.haltLoop();
    for (let i = 0; i < n; i++) { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.position.x = i % 200; m.position.z = Math.floor(i / 200); e.scene.add(m); ms.push(m); }
    e.scene.add(new THREE.Mesh(geo, mat));
    frame(e); await gpuDone(e);
    const records = e.renderer._objects._renderObjects.size;
    const timed = () => {
      let worst = 0, total = 0, steps = 0; s._wait = 4;
      do { const t = performance.now(); s.step(0); const d = performance.now() - t; worst = Math.max(worst, d); total += d; steps++; } while (s._list || s._due.length);
      return { worst: r2(worst), total: r2(total), steps };
    };
    const look = [timed(), timed(), timed(), timed(), timed()];
    for (const m of ms) e.scene.remove(m);
    const first = timed(), second = timed();
    const out = { n, records, left: e.renderer._objects._renderObjects.size, look, first, second };
    e.dispose(); return out;
  },
  /** Plain three.js game: meshes added and removed, one material for all, sweep on or off; heap after a forced gc */
  async plainDrop({ frames = 3000, per = 20, sweep = true, disposeGeometry = true, every = 500 }) {
    const e = await ready(mkEngine({ batching: false })), mat = new THREE.MeshBasicMaterial(), rows = [];
    e.haltLoop();
    e._records.off = !sweep;
    e.scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
    await gc(); rows.push({ frame: 0, heapMB: heap(), records: e.renderer._objects._renderObjects.size });
    for (let f = 1; f <= frames; f++) {
      const ms = [];
      for (let i = 0; i < per; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 6, 6, 6), mat); m.frustumCulled = false; e.scene.add(m); ms.push(m); }
      frame(e);
      for (const m of ms) { e.scene.remove(m); if (disposeGeometry) m.geometry.dispose(); }
      if (f % every === 0) { await gpuDone(e); await gc(); await new Promise(r => setTimeout(r, 100)); rows.push({ frame: f, heapMB: heap(), records: e.renderer._objects._renderObjects.size, geometries: e.renderer.info.memory.geometries }); }
    }
    e.dispose(); return { sweep, disposeGeometry, per, rows };
  },
  /** What a pool pays for coming back after its records were freed: first frame ms, material used by nothing else */
  async poolReturn({ n = 50 }) {
    const e = await ready(mkEngine({ batching: false })), s = e._records, geo = new THREE.BoxGeometry(), ms = [];
    e.haltLoop();
    e.scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    const mat = new THREE.MeshStandardMaterial({ color: 0x3366aa });
    for (let i = 0; i < n; i++) { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; ms.push(m); }
    const shown = async () => { for (const m of ms) e.scene.add(m); const t = performance.now(); frame(e); const d = performance.now() - t; await gpuDone(e); return r2(d); };
    const hidden = () => { for (const m of ms) e.scene.remove(m); frame(e); };
    const cold = await shown(); hidden();
    const warm = await shown(); hidden();
    s.sweepNow(); s.sweepNow();
    const freed = await shown();
    e.dispose(); return { n, coldMs: cold, warmMs: warm, afterSweepMs: freed };
  },
  async env() {
    const e = await ready(mkEngine());
    const d = e.describe?.().renderer; const out = { backend: d?.backend, reason: d?.reason, ua: navigator.userAgent, memoryApi: !!performance.memory, gc: typeof window.gc };
    e.dispose(); return out;
  },
  /** 1: object count */
  async objects({ n, moving = false, batching = true }) {
    const e = await ready(mkEngine({ batching: batching ? undefined : false }));
    const setup = await propsScene(e, n, moving);
    const m = await measure(e, n >= 50000 ? 15 : 40);
    const out = { n, moving, batching, ...setup, ...m, heapMB: heap() };
    e.dispose(); return out;
  },
  /** 3: create and destroy whole engines */
  async churn({ cycles = 200, sample = 25 }) {
    const rows = [];
    await gc(); rows.push({ cycle: 0, heapMB: heap() });
    for (let i = 1; i <= cycles; i++) {
      const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 100 }); document.body.append(canvas);
      const e = await ready(mkEngine({ antialias: false }, canvas));
      e.use(world(), terrain({ height: (x, z) => Math.sin(x * 0.15) * 1.5 + Math.cos(z * 0.12), viewChunks: 1 }), sky({ time: 0.4 }), particles());
      const M = models(); e.world.present('thing', { radius: 1e5, build: rec => M[rec.model].clone() });
      for (let j = 0; j < 200; j++) e.world.add({ kind: 'thing', model: KINDS[j % 4], position: [j % 15 * 2, 0, Math.floor(j / 15) * 2] }, { save: false });
      e.world.refresh();
      for (let f = 0; f < 3; f++) frame(e);
      await gpuDone(e);
      e.dispose(); canvas.remove();
      if (i % sample === 0) { await gc(); await new Promise(r => setTimeout(r, 100)); rows.push({ cycle: i, heapMB: heap(), canvases: document.querySelectorAll('canvas').length, devices: window.__gpu?.devices ?? null, lost: window.__gpu?.lost.length ?? null }); }
    }
    return { rows };
  },
  /** 3b: one engine, load and unload a "scene" (records that build views) many times */
  async sceneChurn({ cycles = 200, sample = 25, n = 300 }) {
    const e = await ready(mkEngine()); e.use(world());
    const M = models(); e.world.present('thing', { radius: 1e5, build: rec => M[rec.model].clone() });
    e.camera.position.set(0, 20, 20); e.camera.lookAt(0, 0, 0);
    const rows = []; await gc();
    const snap = i => { const c = e.counts(); rows.push({ cycle: i, heapMB: heap(), geometries: c.geometries, textures: c.textures, listeners: c.listeners, world: c.world, jobs: c.jobs, timers: c.timers }); };
    snap(0);
    for (let i = 1; i <= cycles; i++) {
      const ids = []; for (let j = 0; j < n; j++) ids.push(e.world.add({ kind: 'thing', model: KINDS[j % 4], position: [j % 20 * 2, 0, Math.floor(j / 20) * 2] }, { save: false }).id);
      e.world.refresh(); frame(e);
      for (const id of ids) e.world.remove(id);
      e.world.refresh(); frame(e);
      if (i % sample === 0) { await gc(); snap(i); }
    }
    await gpuDone(e); e.dispose(); return { rows };
  },
  /** 2: long run in the live loop; resolves with the sample rows when `minutes` have passed. Partial rows are readable from window.rows meanwhile */
  async longStart({ minutes = 30, every = 20 }) {
    const e = window.engine = await ready(mkEngine({ headless: false }));
    e.use(terrain({ ...terrainPreset(), viewChunks: 3 }), vegetation(), sky({ time: 0.4 }), particles(), weather({ types: { wet: { rain: 1 } } }));
    await propsScene(e, 2000, true);
    e.camera.position.set(0, 40, 60); e.camera.lookAt(0, 0, 0);
    window.rows = [];
    const t0 = performance.now(); let frames = 0, last = performance.now(), worst = 0, sumCpu = 0, since = performance.now();
    const raf = () => { const now = performance.now(); const d = now - last; last = now; frames++; if (d > worst) worst = d; sumCpu += e._cpuMs; requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    const sample = async () => {
      const secs = (performance.now() - since) / 1000, fr = frames, w = worst, sc = sumCpu; frames = 0; worst = 0; sumCpu = 0;
      await gc(); const c = e.counts(); const i = e.renderer.info; since = performance.now();
      window.rows.push({ tMin: r2((performance.now() - t0) / 60000), heapMB: heap(), geometries: i.memory.geometries, textures: i.memory.textures, listeners: c.listeners, timers: c.timers, jobs: c.jobs, world: c.world,
        fps: r2(fr / secs), worstMs: r2(w), cpuAvgMs: r2(sc / Math.max(1, fr)) });
    };
    await sample();
    return new Promise(res => { const h = setInterval(async () => { await sample(); if ((performance.now() - t0) / 60000 >= minutes) { clearInterval(h); e.dispose(); res(window.rows); } }, every * 1000); });
  },
  /** 4: fly the camera across terrain chunks in the live loop */
  async fly({ speed = 80, seconds = 30, view = 4 }) {
    const h0 = await this.flyBegin({ view });
    const out = await this.flySegment({ speed, seconds });
    this.flyEnd();
    return { ...out, view, heapStart: h0 };
  },
  /** Set up the flight and wait for the first ring of chunks. Split from fly() so heapdiff.mjs can take heap snapshots between segments */
  async flyBegin({ view = 4 }) {
    const e = window.engine = await ready(mkEngine({ headless: false }));
    e.use(world(), terrain({ ...terrainPreset(), viewChunks: view }), vegetation(), sky({ time: 0.4 }));
    e.vegetation.define('tree', { geometry: new THREE.ConeGeometry(0.8, 3, 6).translate(0, 1.5, 0), wind: 0.08, rule: { perChunk: 60 } });
    e.camera.position.set(0, 60, 0); e.stream.source(e.camera, { detail: 'full' });
    window.flyX = 0;
    await new Promise(r => setTimeout(r, 4000));   // the first ring of chunks
    await gc(); return heap();
  },
  /** Fly on from where the last segment stopped. The camera holds still afterwards, so a snapshot sees a quiet world */
  async flySegment({ speed = 80, seconds = 30 }) {
    const e = window.engine, cam = e.camera, x0 = window.flyX;
    const ivs = [], cpus = []; let last = performance.now(); const t0 = last;
    await new Promise(res => { const tick = now => {
      const d = now - last; last = now; ivs.push(d); cpus.push(e._cpuMs);
      const x = window.flyX += speed * d / 1000; cam.position.set(x, 60, x * 0.3); cam.lookAt(x + 50, 55, x * 0.3 + 15);
      if (now - t0 < seconds * 1000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    const s = [...ivs].sort((a, b) => a - b), med = s[s.length >> 1];
    const sc = [...cpus].sort((a, b) => a - b);
    await gc(); const h1 = heap(); const c = e.counts();
    return { speed, seconds, frames: ivs.length, medianMs: r2(med), p99Ms: r2(s[Math.floor(s.length * 0.99)]), worstMs: r2(s[s.length - 1]), hitchesOver2x: ivs.filter(v => v > Math.max(2 * med, 25)).length,
      hitchesOver50: ivs.filter(v => v > 50).length, cpuMedianMs: r2(sc[sc.length >> 1]), cpuWorstMs: r2(sc[sc.length - 1]), distance: Math.round((window.flyX - x0) * 1.04), heapEnd: h1,
      geometries: c.geometries, textures: c.textures, chunks: e.terrain?.chunks?.size ?? null };
  },
  flyEnd() { window.engine.dispose();
  },
  /** 5: saves */
  async saves({ n }) {
    const e = await ready(mkEngine({ renderer: undefined }));
    e.use(world());
    for (let i = 0; i < n; i++) e.world.add({ kind: 'crate', position: [i % 100, 0, Math.floor(i / 100)], hp: 10 + (i % 7), owner: 'npc' + (i % 50), tags: ['a', 'b'] });
    await gc(); const h0 = heap();
    const t0 = performance.now(); const ok = await e.saves.save('s1'); const saveMs = performance.now() - t0;
    const json = e.saves._json.get('s1') ?? ''; const exp = e.saves.export('s1');
    const t1 = performance.now(); const ok2 = await e.saves.load('s1'); const loadMs = performance.now() - t1;
    const t2 = performance.now(); await e.saves.save('s1'); const resaveMs = performance.now() - t2;
    const out = { n, ok, ok2, saveMs: r2(saveMs), loadMs: r2(loadMs), resaveMs: r2(resaveMs), sizeKB: Math.round(json.length / 1024), exportKB: Math.round(exp.length / 1024), records: e.counts().world, heapDeltaMB: r2((heap() ?? 0) - (h0 ?? 0)) };
    e.dispose(); return out;
  },
  /** 6: many modules and ops. Each module has fixed + frame + afterRender hooks doing a little arithmetic; ops are run from a fixed hook */
  async modules({ modules = 50, opsPerFrame = 200 }) {
    const e = await ready(mkEngine({ renderer: undefined }));
    e.use(world());
    const ms = []; for (let i = 0; i < modules; i++) {
      let acc = 0;
      ms.push({ name: 'mod' + i, type: 'rules', install() { return { v: 0 }; }, fixed(dt) { acc += dt; }, frame(dt) { acc += dt * 0.5; }, afterRender() { acc += 0; } });
    }
    e.use(...ms);
    let hits = 0;
    for (let i = 0; i < 20; i++) e.ops.define('stress.op' + i, { args: { k: 'number' }, can: () => true, run: (en, a) => { hits += a.k; return a.k; } });
    e.onFixed(() => { for (let i = 0; i < opsPerFrame; i++) e.ops.run('stress.op' + (i % 20), { k: i }); });
    e.camera.position.set(0, 10, 10); e.camera.lookAt(0, 0, 0);
    const e2 = await ready(mkEngine({ renderer: undefined })); e2.use(world()); const base = await measure(e2, 120); e2.dispose();
    const m = await measure(e, 120);
    const top = Object.entries(m.modules).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const out = { modules, opsPerFrame, hits, cpuMs: m.cpuMs, renderMs: m.renderMs, otherMs: m.otherMs, baseCpuMs: base.cpuMs, baseOtherMs: base.otherMs,
      perModuleUs: r2(((m.otherMs - base.otherMs) * 1000) / Math.max(1, modules)), topModules: top };
    e.dispose(); return out;
  },
};
Object.assign(window.sf, cityMethods({ mkEngine, ready, heap, gc, r2 }));
Object.assign(window.sf, cityGameMethods({ mkEngine, heap, gc, r2 }));
Object.assign(window.sf, lightMethods({ mkEngine, ready, frame, measure, gpuDone, r2, THREE }));
Object.assign(window.sf, soakMethods({ mkEngine, ready, heap, gc }));
window.sfReady = true;
// the spec runner (tests/specs/soak-guard.mjs) waits for window.engine like on any game page: a bare engine on the page canvas stands in (the soak makes its own)
if (q.has('guard')) mkEngine({ renderer: undefined }).start().then(e => { window.engine = e; });
