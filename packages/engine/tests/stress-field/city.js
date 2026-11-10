// City district page section (driven by run.mjs, never part of the normal test run): streamed blocks of buildings and street props, traffic and crowds through
// swarm(), a walking and a flying camera path over one long route, in the live loop. Written the way a game would write it: one shared kit of geometries and
// materials, plain stream.add per block with no custom dispose, default shadows; so a problem found here is a problem a game meets on its first try.
// Numbers come out as one row per `every` seconds: frame interval, CPU split, real GPU draws per frame (counted on the encoder by run.mjs, because
// renderer.info.render.calls does not count WebGPU draws here), heap, tracked GPU bytes. run.mjs adds true VRAM from the Windows GPU counters.
import * as THREE from 'three';
import { BundleGroup } from 'three/webgpu';
import { swarm, sky } from '../../index.js';

export const P = 96; const ROAD = 16, HALF = (P - ROAD) / 2;   // block pitch, road width, half the block's own ground
const rng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** The kit every block shares, like a game's asset set: unit box and street props, six facades */
export function kit() {
  const std = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#333';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) g.fillRect(x * 16 + 3, y * 16 + 3, 10, 10);
  const windows = new THREE.CanvasTexture(cv); windows.colorSpace = THREE.SRGBColorSpace;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  return {
    box, facades: [0xb0a090, 0x8fa0b0, 0xa08878, 0x9aa890, 0xc0b8a8, 0x7f8a99].map(c => std(c, { map: windows })),
    roof: std(0x555555), metal: std(0x777777, { metalness: 0.4 }), wood: std(0x7a5a3a), leaf: std(0x3f7040), bark: std(0x4a3a2a), walk: std(0xa9a9a2), car: std(0x994433),
    pole: new THREE.CylinderGeometry(0.08, 0.1, 6, 6).translate(0, 3, 0), head: new THREE.BoxGeometry(0.9, 0.15, 0.3).translate(0.4, 6, 0),
    trunk: new THREE.CylinderGeometry(0.15, 0.2, 2.4, 6).translate(0, 1.2, 0), crown: new THREE.IcosahedronGeometry(1.7, 1).translate(0, 3.6, 0),
    bench: new THREE.BoxGeometry(1.8, 0.5, 0.5).translate(0, 0.25, 0), bin: new THREE.CylinderGeometry(0.3, 0.3, 0.9, 8).translate(0, 0.45, 0),
    bollard: new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6).translate(0, 0.45, 0), sign: new THREE.BoxGeometry(0.7, 2.6, 0.06).translate(0, 1.3, 0),
    parked: new THREE.BoxGeometry(1.9, 1.3, 4.3).translate(0, 0.65, 0), ground: new THREE.BoxGeometry(HALF * 2, 0.2, HALF * 2).translate(0, -0.1, 0),
  };
}
/** One block as a plain group: about 190 meshes (soak.js reuses kit and makeBlock) */
export function makeBlock(K, x, z, seed, downtown) {
  const r = rng(seed), root = new THREE.Group(); root.position.set(x, 0, z);
  const put = (geo, mat, px, pz, o = {}) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, o.y ?? 0, pz); if (o.s) m.scale.set(...o.s); if (o.yaw) m.rotation.y = o.yaw;
    m.castShadow = o.cast ?? true; m.receiveShadow = true; root.add(m); return m; };
  put(K.ground, K.walk, 0, 0, { cast: false });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {   // lots: taller toward the middle of the district
    const w = 11 + r() * 4, d = 11 + r() * 4, h = 10 + r() * r() * 110 * downtown, px = (i - 1.5) * 17, pz = (j - 1.5) * 17;
    put(K.box, K.facades[Math.floor(r() * 6)], px, pz, { s: [w, h, d] });
    put(K.box, K.roof, px, pz, { y: h, s: [w + 0.6, 0.6, d + 0.6] });
    put(K.box, K.metal, px + 2, pz - 2, { y: h + 0.6, s: [1.6, 1.2, 2] });
    put(K.box, K.metal, px - 2.5, pz + 2, { y: h + 0.6, s: [1.2, 1.5, 1.2] });
  }
  for (let side = 0; side < 4; side++) {   // the four pavements
    const along = (t, off) => side === 0 ? [t, HALF - off] : side === 1 ? [t, -HALF + off] : side === 2 ? [HALF - off, t] : [-HALF + off, t], yaw = side < 2 ? 0 : Math.PI / 2;
    for (let k = 0; k < 5; k++) { const [a, b] = along(-32 + k * 16, 0.6); put(K.pole, K.metal, a, b, { yaw }); put(K.head, K.metal, a, b, { yaw }); }
    for (let k = 0; k < 3; k++) { const [a, b] = along(-24 + k * 24, 1.8); put(K.trunk, K.bark, a, b); put(K.crown, K.leaf, a, b); }
    for (let k = 0; k < 2; k++) { const [a, b] = along(-16 + k * 32, 2.4); put(K.bench, K.wood, a, b, { yaw, cast: false }); const [c, d] = along(-12 + k * 32, 2.4); put(K.bin, K.metal, c, d, { cast: false }); }
    for (let k = 0; k < 4; k++) { const [a, b] = along(-36 + k * 24, 0.3); put(K.bollard, K.metal, a, b, { cast: false }); }
    for (let k = 0; k < 2; k++) { const [a, b] = along(-8 + k * 16, 0.5); put(K.sign, K.metal, a, b, { yaw, cast: false }); }
    for (let k = 0; k < 3; k++) { const [a, b] = along(-20 + k * 20, -1.4); put(K.parked, K.car, a, b, { yaw: yaw + Math.PI / 2 }); }
  }
  return root;
}

/** Traffic and crowds over the whole district, bouncing at its edge: cars in lanes, pedestrians on pavements. Each pedestrian looks at its neighbours one step in 16 */
export function makeTraffic(e, N, nCars, nPeople, K, save = false) {
  const span = N * P / 2, r = rng(7);
  const carM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), manM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const cars = e.swarm({ name: 'cars', capacity: nCars, geometry: K.parked, material: carM, fields: ['vx', 'vz', 'yaw'], color: true, cell: 8, save });
  const people = e.swarm({ name: 'people', capacity: nPeople, geometry: new THREE.CapsuleGeometry(0.24, 1.2, 2, 6).translate(0, 0.84, 0), material: manM, fields: ['vx', 'vz', 'yaw'], color: true, cell: 2, save });
  cars.mesh.castShadow = true;
  const line = () => (Math.floor(r() * (N + 1)) - N / 2) * P;
  const heading = (onX, v) => onX ? Math.sign(v) * Math.PI / 2 : (v > 0 ? 0 : Math.PI);
  for (let i = 0; i < nCars; i++) {
    const v = (8 + r() * 6) * (r() < 0.5 ? -1 : 1), onX = r() < 0.5, lane = line() + Math.sign(v) * (onX ? 4 : -4), t = (r() * 2 - 1) * span;
    cars.spawn({ x: onX ? t : lane, z: onX ? lane : t, vx: onX ? v : 0, vz: onX ? 0 : v, yaw: heading(onX, v), color: 0x404040 + Math.floor(r() * 0xbfbfbf) });
  }
  for (let i = 0; i < nPeople; i++) {
    const v = (1 + r() * 0.8) * (r() < 0.5 ? -1 : 1), onX = r() < 0.5, lane = line() + (r() < 0.5 ? -1 : 1) * (ROAD / 2 + 1 + r() * 2), t = (r() * 2 - 1) * span;
    people.spawn({ x: onX ? t : lane, z: onX ? lane : t, vx: onX ? v : 0, vz: onX ? 0 : v, yaw: heading(onX, v), color: 0x303030 + Math.floor(r() * 0xcfcfcf) });
  }
  cars.onStep((d, i, dt) => { d.x[i] += d.vx[i] * dt; d.z[i] += d.vz[i] * dt;
    if (Math.abs(d.x[i]) > span) d.vx[i] = -d.vx[i]; if (Math.abs(d.z[i]) > span) d.vz[i] = -d.vz[i]; });
  let tick = 0; e.onFixed(() => { tick++; });
  people.onStep((d, i, dt) => {
    if (((i + tick) & 15) === 0) people.near(d.x[i], d.z[i], 0.7, (dd, j) => { if (j !== i) { d.x[i] += (d.x[i] - dd.x[j]) * 0.02; d.z[i] += (d.z[i] - dd.z[j]) * 0.02; } });
    d.x[i] += d.vx[i] * dt; d.z[i] += d.vz[i] * dt;
    if (Math.abs(d.x[i]) > span) d.vx[i] = -d.vx[i]; if (Math.abs(d.z[i]) > span) d.vz[i] = -d.vz[i]; });
  return { cars, people };
}

/** A serpentine along the streets, arc length to position: the same route for walking and flying, so it crosses the whole district */
export function route(N) {
  const span = (N / 2 - 1) * P, pts = []; let flip = false;
  for (let k = -(N / 2 - 1); k <= N / 2 - 1; k += 2) { const z = k * P; pts.push([flip ? span : -span, z], [flip ? -span : span, z]); flip = !flip; }
  const seg = []; let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = Math.hypot(bx - ax, bz - az); seg.push({ ax, az, dx: (bx - ax) / len, dz: (bz - az) / len, len, at: total }); total += len; }
  return { total, at(s, out) { s %= total; let i = seg.length - 1; while (seg[i].at > s) i--; const g = seg[i], t = s - g.at; out.x = g.ax + g.dx * t; out.z = g.az + g.dz * t; out.dx = g.dx; out.dz = g.dz; return out; } };
}
export const pct = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;

/** @param {{ mkEngine: Function, ready: Function, heap: Function, gc: Function, r2: Function }} h the page's helpers */
export function cityMethods({ mkEngine, ready, heap, gc, r2 }) {
  return {
    /** Run one camera path through the district and return per-interval rows. mode 'walk' (street level) or 'fly' (over the roofs); radius = stream build radius in meters */
    async city({ mode = 'walk', seconds = 90, every = 10, blocks = 20, radius = 320, speed, cars = 2000, people = 12000, shadows = true, batching = true, far = 1600, ownDispose = false, off = [], gcEvery = 0, settle = 0, drain = false, bundles = '', engine: extra = {} }) {
      const e = window.engine = await ready(mkEngine({ headless: false, batching: batching ? undefined : false, ...extra }));
      e.use(swarm(), sky({ time: 0.4 }));
      // off: undo one city-run fix from out here, so a run can ask which fix a change in behaviour belongs to, with no switch in the engine itself.
      //   walk: batched originals stay in three's walks. verify: every mesh checked every frame, as the round robin did by root. remove: the shared kit is disposed on unload.
      if (off.includes('walk')) e.batching.skip = () => {};
      if (off.includes('verify')) e.onFrame(() => { for (const info of e.batching.list) e.batching._verify(info); });
      const unload = off.includes('remove') && (o => { const held = e.batching.held; e.remove(o); o.traverse(c => { for (const x of [c.geometry, ...[].concat(c.material)]) if (x && !held.has(x)) x.dispose(); }); });
      // bundles: try three's BundleGroup on this scene. 'blocks': each streamed block is one BundleGroup (run with batching: false); 'cells': every batch of a cell in one BundleGroup,
      // recorded again when a batch's count changes (the instance count is baked into a bundle). Neither is the engine's way: docs/testing/field/2026-11-05-city/ says why.
      let records = 0;
      if (bundles === 'cells') {
        const byCell = new Map(), root = e.batching.root, addRoot = root.add.bind(root);
        root.add = im => { let b = byCell.get(im.userData.cell); if (!b) { byCell.set(im.userData.cell, b = new BundleGroup()); b.matrixAutoUpdate = false; b.userData.sum = -1; addRoot(b); } b.add(im); return root; };
        e.onFrame(() => { for (const b of byCell.values()) { let sum = 0; for (const c of b.children) sum += c.count * 7 + 1; if (sum !== b.userData.sum) { b.userData.sum = sum; b.needsUpdate = true; records++; } } });
      }
      if (!shadows) e.renderer.shadowMap.enabled = false;
      e.camera.far = far; e.camera.updateProjectionMatrix();
      e.stream.radius = radius;
      const K = kit(), N = blocks, mid = N * P / 2;
      const road = new THREE.Mesh(new THREE.PlaneGeometry(N * P + P, N * P + P).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95 })); road.position.y = -0.05; road.receiveShadow = true; e.add(road);
      let entries = 0; const handles = [];
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const x = (i - N / 2 + 0.5) * P, z = (j - N / 2 + 0.5) * P, downtown = Math.max(0.15, 1 - Math.hypot(x, z) / mid), seed = i * 1000 + j;
        handles.push(e.stream.add({ position: [x, 0, z], radius: P / 2, build: () => { const block = makeBlock(K, x, z, seed, downtown); if (bundles !== 'blocks') return block; const b = new BundleGroup(); b.position.copy(block.position); b.add(...block.children); return b; }, ...(ownDispose && { dispose: o => e.detach(o) }), ...(unload && { dispose: unload }) })); entries++;
      }
      const sw = makeTraffic(e, N, cars, people, K);
      // shared kit pieces disposed while other blocks still draw them: each one throws away the GPU state of everything using it
      let kitDisposed = 0; for (const x of Object.values(K).flat()) if (x.isMaterial || x.isBufferGeometry) x.addEventListener('dispose', () => { kitDisposed++; });
      const R = route(N), p = {}, v = speed ?? (mode === 'walk' ? 8 : 60), H = mode === 'walk' ? 1.7 : 90, side = mode === 'walk' ? 6 : 0;
      let s = 0;
      const place = () => { R.at(s, p); const c = e.camera; c.position.set(p.x + side, H, p.z + side); c.lookAt(c.position.x + p.dx * 40, mode === 'walk' ? 1.7 : H - 30, c.position.z + p.dz * 40); };
      place(); e.stream.source(e.camera, { detail: 'full', physics: false });
      const tReady = performance.now(); window.cityStage = () => ({ stage: 'streaming', ms: Math.round(performance.now() - tReady), cpuMs: e._cpuMs, stream: e.stream.stats, ready: e.stream.ready, jobs: e.counts().jobs });
      while (!e.stream.ready && performance.now() - tReady < 45000) await new Promise(r => setTimeout(r, 50));   // capped: a run that never gets ready must still report
      const readyMs = Math.round(performance.now() - tReady);
      await new Promise(r => setTimeout(r, 3000));   // first shaders and pipelines are a loading cost, not a frame cost
      await gc();
      const rows = window.rows = [], G = window.__gpu ?? {}, dev = e.renderer.backend?.device;
      // WebGL2 has no per-pass stamps here: one timer query around the whole draw, read a few frames later. Only one may run at a time, so a frame starts one only when none is out.
      const gl = e.renderer.isWebGLRenderer ? e.renderer.getContext() : e.renderer.backend?.gl, tq = gl?.getExtension('EXT_disjoint_timer_query_webgl2'), glMs = [];
      let glQ = null, glOpen = false;
      const glRead = () => { if (glQ && !glOpen && gl.getQueryParameter(glQ, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) glMs.push(gl.getQueryParameter(glQ, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(glQ); glQ = null; } };
      let renderMs = 0; const orig = e._render.bind(e);
      e._render = dt => { const t = performance.now(); if (tq) { glRead(); if (!glQ) { glQ = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, glQ); glOpen = true; } } orig(dt); if (glOpen) { gl.endQuery(tq.TIME_ELAPSED_EXT); glOpen = false; } renderMs += performance.now() - t; };
      const timing = e.profile() !== null;   // dev builds time modules all along: put it back as it was
      e.profile(true);
      // walls: real time between frames from performance.now(). rAF's own timestamp sits on the display's grid, so a 17 ms frame can read 34 then 2 (p95 of ivs is that grid, not the frame)
      const ivs = [], cpus = [], walls = []; let lastWall = performance.now(), last = performance.now(), renderSum = 0, tails = [], d0 = G.draws ?? 0, p0 = G.passes ?? 0, f0 = 0, frames = 0;
      const t0 = last; let nextRow = t0 + every * 1000, done; const finish = new Promise(r => { done = r; });
      const row = () => {
        const f = Math.max(1, frames - f0), wl = [...walls].sort((a, b) => a - b), sorted = [...ivs].sort((a, b) => a - b), sc = [...cpus].sort((a, b) => a - b), i = e.renderer.info, st = e.stream.stats, b = e.batching?.stats;
        rows.push({ t: Math.round((performance.now() - t0) / 1000), km: r2(s / 1000), frames: f, w50: r2(pct(wl, 0.5)), w95: r2(pct(wl, 0.95)), w99: r2(pct(wl, 0.99)), p50: r2(pct(sorted, 0.5)), p95: r2(pct(sorted, 0.95)), p99: r2(pct(sorted, 0.99)), worst: r2(sorted.at(-1) ?? 0), over50: ivs.filter(q => q > 50).length,
          cpuP50: r2(pct(sc, 0.5)), cpuP95: r2(pct(sc, 0.95)), objDraws: Math.round(objDraws / f), renderMs: r2(renderSum / f), gpuTail: r2(pct([...tails].sort((a, b) => a - b), 0.5)),
          draws: G.draws != null && G.draws > d0 ? Math.round((G.draws - d0) / f) : i.render.calls, passes: G.passes != null ? r2((G.passes - p0) / f) : null, tris: i.render.triangles,
          built: st.built, queued: st.queued, batches: b?.batches ?? null, instances: b?.instances ?? null, geometries: i.memory.geometries, textures: i.memory.textures,
          records: e.renderer._objects?._renderObjects?.size ?? null, heapMB: heap(), gpuMB: G.bytes ? r2(G.bytes / 1048576) : null });
        ivs.length = 0; cpus.length = 0; walls.length = 0; tails = []; renderSum = 0; objDraws = 0; f0 = frames; d0 = G.draws ?? 0; p0 = G.passes ?? 0;
      };
      // renderObject calls per frame, every pass together: three's per-object cost scales with this, not with the real GPU draws (drawn originals with no instance count too)
      let objDraws = 0; const ro = e.renderer.renderObject; e.renderer.renderObject = function (...a) { objDraws++; return ro.apply(this, a); };
      let failure = null, nextGc = t0 + gcEvery * 1000; const hitches = [], part = {}, long = [];
      // long tasks tell a busy main thread from a waiting one: a late frame with no long task under it was not held up by JS
      const watch = new PerformanceObserver(l => { for (const x of l.getEntries()) long.push([x.startTime, x.duration]); }); watch.observe({ entryTypes: ['longtask'] });
      // where a long frame went: each stage of the frame, summed since the last frame, kept for frames over 40 ms
      const timed = (o, k, name) => { const f = o[k]; o[k] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { part[name] = (part[name] ?? 0) + performance.now() - t; } }; };
      timed(e, '_fixedStep', 'fixed'); timed(e, '_frameHooks', 'hooks'); timed(e.jobs, 'run', 'jobs'); timed(e.stream, '_update', 'stream'); timed(e.batching, 'update', 'batching'); timed(e, '_render', 'render'); if (e._records) timed(e._records, 'step', 'sweep');
      // inside three's frame: nested renders (the shadow passes) call these too, so depth keeps a recursive or re-entered stage from counting twice
      const inner = (o, k, name) => { const f = o[k]; let depth = 0; o[k] = function (...a) { if (depth++) { try { return f.apply(this, a); } finally { depth--; } } const t = performance.now(); try { return f.apply(this, a); } finally { depth--; part[name] = (part[name] ?? 0) + performance.now() - t; } }; };
      inner(e.scene, 'updateMatrixWorld', 'matrices');
      if (e.renderer.drawingPipeline) {   // WebGLRenderer has none of these stages: there only the engine's own and matrices are split
        inner(e.renderer, '_renderObjects', 'draw'); inner(e.renderer.drawingPipeline, 'project', 'project'); inner(e.renderer.backend, 'finishRender', 'finish'); inner(e.renderer.backend, 'beginRender', 'begin');
        // top-level scene walks per frame and what each one is for: a difference here is a difference in work, not in speed
        const dp = e.renderer.drawingPipeline, pj = dp.project; let deep = 0; const walks = window.cityWalks = {};
        dp.project = function (o, cam, ...a) { if (!deep++) { part.walks = (part.walks ?? 0) + 1; const k = `${o.type}:${cam.type}`; walks[k] = (walks[k] ?? 0) + 1; } try { return pj.call(this, o, cam, ...a); } finally { deep--; } };
      }
      if (dev) { const q = dev.queue, wb = q.writeBuffer, sb = q.submit; q.writeBuffer = function (...a) { const t = performance.now(); try { return wb.apply(this, a); } finally { part.write = (part.write ?? 0) + performance.now() - t; } }; q.submit = function (...a) { const t = performance.now(); try { return sb.apply(this, a); } finally { part.submit = (part.submit ?? 0) + performance.now() - t; } }; }
      const allFrames = window.allFrames = [];
      window.cityStage = () => ({ stage: 'path', frames, failure, last: rows.at(-1) ?? null, sinceStart: Math.round(performance.now() - t0) });
      const tick = now => {
        try {
          const d = Math.max(0, now - last); last = now; ivs.push(d); cpus.push(e._cpuMs); const wNow = performance.now(); walls.push(wNow - lastWall); lastWall = wNow; if (d > 40 && hitches.length < 2000) hitches.push({ f: frames, at: now, ms: r2(d), built: e.stream.stats.built, ...Object.fromEntries(Object.entries(part).map(([k, v]) => [k, r2(v)])) }); allFrames.push({ ms: d, cpu: e._cpuMs, ...part }); for (const k in part) part[k] = 0; renderSum += renderMs; renderMs = 0; frames++;
          s += v * d / 1000; place();
          if (gcEvery && now >= nextGc) { window.gc?.(); nextGc += gcEvery * 1000; }
          if (dev && frames % 30 === 0) { const a = performance.now(); dev.queue.onSubmittedWorkDone().then(() => tails.push(performance.now() - a)); }
          if (now >= nextRow) { row(); nextRow += every * 1000; }
          if (now - t0 < seconds * 1000) requestAnimationFrame(tick); else done();
        } catch (err) { failure = String(err?.stack ?? err).slice(0, 400); done(); }   // an error in a rAF callback would otherwise hang the run with nothing to show
      };
      requestAnimationFrame(tick);
      await finish;
      await new Promise(r => setTimeout(r, 200)); watch.disconnect();
      for (const h of hitches) { const a = h.at - h.ms; h.jsBusy = r2(long.reduce((s, [st, du]) => s + Math.max(0, Math.min(h.at, st + du) - Math.max(a, st)), 0)); delete h.at; }
      window.cityStage = () => ({ stage: 'closing', frames, failure });
      // slow frames against normal ones, stage by stage: which stage grew, and how much of the frame no stage holds
      const stageAvg = l => { const s = {}; for (const f of l) for (const k in f) s[k] = (s[k] ?? 0) + f[k]; for (const k in s) s[k] = r2(s[k] / Math.max(1, l.length)); s.n = l.length; return s; };
      const cut = allFrames.map(f => f.cpu).sort((a, b) => a - b)[Math.floor(allFrames.length * 0.5)] * 1.5;
      const stages = { cut: r2(cut), normal: stageAvg(allFrames.filter(f => f.cpu < cut)), slow: stageAvg(allFrames.filter(f => f.cpu >= cut)), seq: allFrames.slice(600, 660).map(f => Math.round(f.ms) + '/' + Math.round(f.cpu)).join(' ') };
      // the same frames by what they carried: a block arriving or leaving (entry), only a fixed step (the swarm sim), or neither. over13 is a count, so each kind's share of the tail reads off directly
      const byKind = {}; for (const f of allFrames) (byKind[f.stream > 0.2 || f.jobs > 0.2 ? 'entry' : f.fixed > 0.2 ? 'fixed' : 'plain'] ??= []).push(f);
      const frameKinds = Object.fromEntries(Object.entries(byKind).map(([k, l]) => { const c = l.map(f => f.cpu).sort((x, y) => x - y); return [k, { n: l.length, over13: l.filter(f => f.cpu > 13).length, cpu50: r2(pct(c, 0.5)), cpu95: r2(pct(c, 0.95)), cpuMax: r2(c.at(-1)), avg: stageAvg(l) }]; }));
      if (failure) throw new Error(failure);
      const modules = Object.fromEntries(Object.entries(e.profile()).map(([k, p]) => [k, p.mean]));   // the run's average per frame
      if (!timing) e.profile(false);
      e._render = orig;
      if (glMs.length) { const s = [...glMs].sort((a, b) => a - b); window.__gpuTimeGL = { frames: s.length, busyP50: r2(pct(s, 0.5)), busyP95: r2(pct(s, 0.95)), busyP99: r2(pct(s, 0.99)), busyMax: r2(s.at(-1)) }; }
      const top = Object.entries(modules).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, ms]) => [k, r2(ms)]);
      // records split by whether their object is still in the scene, and the live GPU buffers by kind: a cache of what is loaded is bounded, what has left the scene is a leak
      const recs = () => { let inside = 0, outside = 0; for (const ro of e.renderer._objects?._renderObjects ?? []) { let o = ro.object; while (o.parent) o = o.parent; if (o.isScene) inside++; else outside++; } return { inside, outside }; };
      const kinds = () => Object.entries(G.kinds ?? {}).filter(k => k[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const snap = () => ({ recs: recs(), buffers: G.buffers, kinds: kinds(), geometries: e.renderer.info.memory.geometries, kitDisposed, built: e.stream.stats.built });
      const atEnd = snap(); let drained = null;
      // what three's walks really visit: the scene with batched originals out, as during the draw
      e.batching?.skip(); const walk = { all: 0, mesh: 0, instanced: 0, group: 0, castMesh: 0 }; e.scene.traverse(o => { walk.all++; if (o.isInstancedMesh) walk.instanced++; else if (o.isMesh) { walk.mesh++; if (o.castShadow) walk.castMesh++; } else if (o.isGroup) walk.group++; }); e.batching?.unskip();
      // drain: unload every block through the default path, then give the sweep time. What stays afterwards was never going to be freed
      if (drain) { window.cityStage = () => ({ stage: 'drain', frames }); for (const h of handles) h.remove(); await new Promise(r => setTimeout(r, 16000)); await gc(); drained = snap(); }
      await gc(); const heapEnd = heap(), counts = e.counts();
      // settle: nothing drawn, garbage collected; run.mjs keeps reading VRAM, so what comes back shows what was only waiting to be freed
      if (settle) { e.haltLoop(); window.cityStage = () => ({ stage: 'settle', frames }); const end = performance.now() + settle * 1000; while (performance.now() < end) { await gc(); await new Promise(r => setTimeout(r, 3000)); } }
      const out = { bundles, records, frameKinds, mode, speed: v, radius, blocks: N, entries, readyMs, km: r2(s / 1000), cars: sw.cars.count, people: sw.people.count, shadows, heapEnd, top, kitDisposed, walk, stages, walks: window.cityWalks, hitchCount: hitches.length, opening: hitches.filter(h => h.f < 10), longTasks: long.length, hitches: [...hitches].sort((a, b) => b.ms - a.ms).slice(0, 12), hitchSum: hitches.reduce((s, h) => { for (const k in h) if (k !== 'f' && k !== 'built' && k !== 'at') s[k] = r2((s[k] ?? 0) + h[k]); return s; }, {}), atEnd, drained, geometries: counts.geometries, textures: counts.textures, rows };
      e.dispose(); return out;
    },
  };
}
