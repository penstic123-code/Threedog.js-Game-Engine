// Performance budget, engine.budget: the game sets limits (only categories given are checked); on overrun it reports which category and who uses the most.
//   createEngine({ budget: { drawCalls: 250, fps: 55 } })  or  engine.budget.enable({ drawCalls: 250 })
//   engine.budget.report()   // { ok, over: [{ category, value, limit, top }] }; null when off
// Off by default: when off, sample() only keeps the frame times (two array writes; the median frame time every reader reports) and checks nothing.
// The engine presets no limit numbers for the game; its own reference limits (registered while it builds) never show as the game's overrun in notice().
// Categories: drawCalls, triangles, textures, gpuMemoryMB (WebGPU: three's own byte count, not driver VRAM), cpuMs, fps, low1 (fps and low1 are lower bounds) + registered metrics (lights, shadowLights, shadowMaps, shadowMapSize, chunkApplyMs, rigidBodies...)
// + the apply-cost stages (applyTransitMs, applyBuildMs, applyColliderMs, applyUploadMs, applyStreamMs: ms per frame, see ApplyCost).
// "Who uses the most": draw calls are estimated by the userData.budgetTag of an object (or its parent); untagged counts as 'other'.
// modules: { name: ms } limits a module's hook time per frame (median of engine.profile(), on in dev builds), checked as category 'modules.<name>'. A fixed-step hook counts its dearest step of the frame, not the sum of catch-up steps (cpuPhases.fixed keeps the sum).
// notice(): the one line shot, verify and describeText print when the game is over its own limits, slower than its recorded baseline
// (engine.budget.baseline, the tools load .threedog/perf-baseline.json into it), or running at a resolution adaptive resolution lowered; null when all is fine.
/** @import { Handle } from '../../types/common' */
/** @import { BudgetLimits, BudgetReport, BudgetTagStat } from '../../types/world' */
import { coded } from '../base/errorHints.js';
import { fmt, warnOnce } from '../base/validate.js';
import { r1, median, cameraFrustum } from '../base/math.js';
import { loweredText } from '../scene/adaptive.js';
import { SHADOW_TYPES } from '../../render/shadowTypes.js';
import * as THREE from 'three';
import { stats, shadowMaps, backendFacts, gpuMemoryMB } from '../../render/backend.js';

const STRINGS = {
  startup: 'Startup took {value} ms, over budget startupMs {limit} ms; slowest module: {top}',
  module: 'Module {name} took {value} ms to start, over budget moduleMs {limit} ms (init + waiting for ready)',
  over: 'Performance budget exceeded: {category} = {value} ({dir} {limit}). Most draw calls: {top}',
  min: 'minimum', max: 'maximum',
  noMemory: 'budget gpuMemoryMB is not checked on WebGLRenderer: three counts GPU bytes only on WebGPURenderer (createEngine({ renderer: "webgpu" })); geometries and textures counts are in engine.counts()',
};
const LOWER = new Set(['fps', 'low1']);   // these two are lower bounds ("not below")
const WINDOW = 300;                       // how many recent frames the frame-rate stats use
/** The recent frames as a ring allocated once: sample() runs every frame with the budget off too, so it writes in place (no push / shift) */
const ring = () => ({ buf: new Float64Array(WINDOW), n: 0, i: 0 });
const put = (r, v) => { r.buf[r.i] = v; r.i = (r.i + 1) % WINDOW; if (r.n < WINDOW) r.n++; };
const view = r => r.buf.subarray(0, r.n);   // the filled part, in any order: every reader is a sum, sort or median

/** Cost stages of bringing a background result into the frame, in the order a chunk goes through them */
const STAGES = ['transit', 'build', 'collider', 'upload', 'stream'];
const EMA = 0.1;   // per-frame smoothing, the same factor chunkApplyMs always used
const COMPILES_KEPT = 20;   // compile-stall frames remembered by ApplyCost.compiles
// Noise margins of the baseline comparison. Times: browsers round performance.now() to 0.1 ms and the same run moves 10-30% between runs
// (recipe 15), so a time is slower only past both +20% and +0.2 ms. Counts (draw calls, triangles) repeat exactly in the same view: +5%.
const SLOW_MS = { share: 0.2, abs: 0.2 }, SLOW_COUNT = 0.05;
const pct = (v, base) => `${v >= base ? '+' : ''}${Math.round((v / base - 1) * 100)}%`;

/** Bytes of the typed arrays in a plain result object, `depth` levels down @param {any} v @param {number} depth @returns {number} */
function arrayBytes(v, depth) {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (!v || typeof v !== 'object' || depth < 0) return 0;
  let n = 0;
  for (const k in v) n += arrayBytes(v[k], depth - 1);
  return n;
}

/**
 * engine.budget.cost: where the main thread pays for background results (terrain chunks, vegetation, colliders, stream builds), split in stages.
 * Always on (a few performance.now() calls per applied result). Stages: transit = worker round trip minus the worker's own compute (queueing,
 * structured clone, waiting for a busy main thread: an async wait, not main-thread blocking, so it is an approximation); build = creating the
 * three.js objects (geometry, meshes, instanced meshes); collider = physics colliders; upload = GPU upload and shader compile, approximated as the
 * extra render time of frames that first draw new objects over the average render time of other frames; stream = the synchronous part of a stream
 * build() callback.
 */
class ApplyCost {
  /** @internal */
  constructor() {
    /** @internal */ this.t = {};
    for (const k of STAGES) this.t[k] = { n: 0, totalMs: 0, maxMs: 0, frameMs: 0, bytes: 0, _cur: 0 };
    /** @internal */ this._fresh = 0;
    /** @internal */ this._base = -1;
    /** Frames in which three.js compiled new shader programs (the last COMPILES_KEPT): { at (page time s), programs (new), ms (render ms of that frame over the usual) } */
    this.compiles = [];
    /** @internal */ this._programs = -1;
  }
  /** @internal Add ms to a stage (bytes: payload size, transit only) */
  add(stage, ms, bytes = 0) {
    const s = this.t[stage];
    s.n++; s.totalMs += ms; s._cur += ms; s.bytes += bytes;
    if (ms > s.maxMs) s.maxMs = ms;
  }
  /** @internal Close a span started with performance.now(); build and stream spans create objects the next render uploads */
  end(stage, t0) {
    this.add(stage, performance.now() - t0);   // measure
    if (stage === 'build' || stage === 'stream') this._fresh++;
  }
  /** @internal A worker result arrived: t0 is when its job was sent, r.ms what the worker spent computing it.
   * The payload size is the typed arrays in the result, at most two levels down ({ mesh: { pos, nor } }): measured from the shape of
   * any result, so core never learns one module's field names (it used to read terrain's four arrays by name). */
  transit(t0, r) {
    const bytes = arrayBytes(r, 2);
    this.add('transit', Math.max(0, performance.now() - t0 - (r.ms ?? 0)), bytes);   // measure
  }
  /** @internal One render finished (ms): a frame that drew new objects pays the upload, the others set the baseline. Also rolls the per-frame smoothing.
   * programs: renderer.info.programs.length after it; when it grew, three.js compiled shaders in this render (a compile stall, kept in compiles)
   * @returns {boolean} true when this render compiled shaders (adaptive resolution skips such frames) */
  rendered(ms, programs = -1, at = 0) {
    const compiled = programs > this._programs && this._programs >= 0;
    if (compiled) {
      this.compiles.push({ at: r1(at), programs: programs - this._programs, ms: r1(Math.max(0, ms - Math.max(0, this._base))) });
      if (this.compiles.length > COMPILES_KEPT) this.compiles.shift();
    }
    if (programs >= 0) this._programs = programs;
    if (this._fresh) { if (this._base >= 0) this.add('upload', Math.max(0, ms - this._base)); this._fresh = 0; }
    else this._base = this._base < 0 ? ms : this._base + (ms - this._base) * EMA;
    for (const k of STAGES) { const s = this.t[k]; s.frameMs += (s._cur - s.frameMs) * EMA; s._cur = 0; }
    return compiled;
  }
  /**
   * Per stage: n results, totalMs, maxMs of one result, frameMs (smoothed ms per frame), bytes (transit only)
   * @returns {Record<string, { n: number, totalMs: number, maxMs: number, frameMs: number, bytes: number }>}
   * @example engine.budget.cost.report().build   // { n: 12, totalMs: 9.4, maxMs: 1.8, frameMs: 0.2, bytes: 0 }
   */
  report() {
    const out = /** @type {any} */ ({});
    for (const k of STAGES) { const s = this.t[k]; out[k] = { n: s.n, totalMs: r1(s.totalMs), maxMs: r1(s.maxMs), frameMs: r1(s.frameMs), bytes: s.bytes }; }
    return out;
  }
  /** Forget what was counted so far (to measure one scene on its own) */
  reset() { for (const k of STAGES) Object.assign(this.t[k], { n: 0, totalMs: 0, maxMs: 0, frameMs: 0, bytes: 0, _cur: 0 }); this.compiles = []; }
}

/** engine.budget: performance budget (turned on by createEngine({ budget }) or enable(); off by default, costs nothing). */
export class Budget {
  /** @internal */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** Is it on? */
    this.enabled = false;
    /** Current limits @type {BudgetLimits} @experimental */
    this.limits = {};
    /** @internal Module-defined categories: name -> { read, limit } @type {Map<string, { read: () => number, limit?: number }>} */
    this.metrics = new Map();
    /** @internal */ this._dts = ring();
    /** @internal */ this._cpu = ring();
    /** @internal */ this._t = 0;
    /** @internal @type {any} */ this._last = null;
    /** Cost of applying background results, split in stages (see ApplyCost) */
    this.cost = new ApplyCost();
    for (const k of STAGES) this.metric('apply' + k[0].toUpperCase() + k.slice(1) + 'Ms', () => this.cost.t[k].frameMs);
    /** The recorded run to compare against: { [where]: { drawCalls, triangles, cpuMs?, modules: { name: ms } } } as record() makes it. threedog shot / verify
     * load the game's .threedog/perf-baseline.json (this machine's) here when the game set none (and write it with --save-baseline). null = no comparison
     * @type {Record<string, any> | null} */
    this.baseline = null;
    /** @internal */ this._frustum = new THREE.Frustum();
  }
  /**
   * Turn on and set limits (only categories given are checked)
   * @param {BudgetLimits} [limits]
   * @returns {this}
   * @example engine.budget.enable({ drawCalls: 250, fps: 55 });
  */
  enable(limits = {}) { this.enabled = true; this.limits = { ...limits }; this._last = null; return this; }
  /** Turn off @experimental */
  disable() { this.enabled = false; this._last = null; }
  /**
   * Module-defined category: read() returns the current value, opts.limit is the limit (the game's enable() takes precedence). Returns a handle { remove() }
   * @param {string} name
   * @param {() => number} read
   * @param {{ limit?: number }} [opts]
   * @returns {Handle}
  */
  metric(name, read, opts = {}) {
    // registered while the engine builds = the engine's reference limit (gameLights' lights), not the game's budget (_ownLimit)
    const m = { read, limit: opts.limit, engine: !this.engine._born?.built };
    this.metrics.set(name, m);
    return { remove: () => { if (this.metrics.get(name) === m) this.metrics.delete(name); } };
  }
  /** Limit of a category; undefined if none was given (not checked) @param {string} name @returns {number | undefined} @experimental */
  limitOf(name) {
    if (name.startsWith('modules.')) return this.limits.modules?.[name.slice(8)];
    const v = this.limits[name];
    return typeof v === 'number' ? v : this.metrics.get(name)?.limit;
  }

  /** @internal Called by the engine after each rendered frame: records frame time, checks once a second, and warns once per category over its limit */
  sample(dt) {
    put(this._dts, dt); put(this._cpu, this.engine._cpuMs ?? 0);   // always: the median frame time describe and inspect.perf report
    if (!this.enabled || (this._t += dt) < 1) return;
    this._t = 0;
    const r = this._last = this._evaluate();
    for (const o of r.over) {
      // once per category: the measured value changes every second, so the text alone would repeat
      warnOnce(coded('budget-over', fmt(STRINGS.over, { ...o, dir: LOWER.has(o.category) ? STRINGS.min : STRINGS.max, top: o.top.map(t => `${t.tag} ${t.drawCalls}`).join(', ') })), 'budget-over\0' + o.category);
    }
  }
  /** Budget report; null when off. In the real-time loop it returns the last second's result; in step() mode it is computed on demand @returns {BudgetReport | null} */
  report() {
    if (!this.enabled) return null;
    return this._last && this._dts.n ? this._last : this._evaluate();
  }
  /**
   * Called by the engine when startup finishes: warns if startupMs / moduleMs is exceeded and returns the offenders (empty array if none)
   * @param {{ totalMs: number, modules: Record<string, { init?: number, ready?: number }> }} s
   * @returns {{ category: 'startupMs' | 'moduleMs', value: number, limit: number, top: { tag: string, ms: number }[] }[]}
  * @experimental
  */
  checkStartup(s) {
    if (!this.enabled) return [];
    const { startupMs, moduleMs } = this.limits, /** @type {any[]} */ over = [];
    const mods = Object.entries(s.modules).map(([tag, v]) => ({ tag, ms: (v.init ?? 0) + (v.ready ?? 0) })).sort((a, b) => b.ms - a.ms);
    const top = mods.slice(0, 3);
    if (startupMs != null && s.totalMs > startupMs) {
      warnOnce(coded('budget-over', fmt(STRINGS.startup, { value: s.totalMs, limit: startupMs, top: top.map(t => `${t.tag} ${t.ms}`).join(', ') })));
      over.push({ category: 'startupMs', value: s.totalMs, limit: startupMs, top });
    }
    if (moduleMs != null) for (const m of mods) if (m.ms > moduleMs) {
      warnOnce(coded('budget-over', fmt(STRINGS.module, { name: m.tag, value: m.ms, limit: moduleMs })));
      over.push({ category: 'moduleMs', value: m.ms, limit: moduleMs, top: [m] });
    }
    return over;
  }
  /** @internal Forget the frame times so far (the loop calls it once, when start-up has settled: start-up frames are not play) */
  _clearFrames() { this._dts.n = this._dts.i = 0; this._cpu.n = this._cpu.i = 0; }
  /** @internal Frame time as every reader reports it: the median main-thread ms of the last n real-time frames (null before the first one) */
  _frameMs() { return this._cpu.n ? { ms: r1(median(view(this._cpu))), n: this._cpu.n } : null; }
  /** Current value per category (fps/low1/cpuMs exist only once there are frame times) @returns {Record<string, number>} */
  values() {
    const r = this.engine.renderer, s = stats(r), v = /** @type {Record<string, number>} */ ({ drawCalls: s.drawCalls, triangles: s.triangles, textures: s.textures });
    const mb = gpuMemoryMB(r);
    if (mb != null) v.gpuMemoryMB = mb;
    else if (this.limits.gpuMemoryMB != null) warnOnce(coded('budget-option', STRINGS.noMemory));   // a declared limit never checked must say so
    const d = view(this._dts);
    if (d.length) {
      const sum = d.reduce((a, b) => a + b, 0), worst = d.slice().sort((a, b) => b - a), n = Math.max(1, Math.floor(d.length * 0.01));
      v.fps = r1(d.length / sum);
      v.low1 = r1(n / worst.slice(0, n).reduce((a, b) => a + b, 0));
      v.cpuMs = this._frameMs().ms;   // median: one GC pause or chunk build does not read as a slow game
    }
    for (const [name, m] of this.metrics) v[name] = r1(m.read());
    const own = this.limits.modules, prof = own && this.engine.profile?.();
    if (prof) for (const k in own) if (prof[k] != null) v['modules.' + k] = prof[k].ms;
    return v;
  }
  /** @internal The limit the GAME declared for a category (enable / createEngine, or a metric registered after the engine was built), else undefined.
   * The one filter between "the game's budget" and the engine's own reference limits (gameLights' lights limit, registered while the engine builds):
   * the notice reports only these */
  _ownLimit(name) {
    if (name.startsWith('modules.')) return this.limits.modules?.[name.slice(8)];
    const v = this.limits[name], m = this.metrics.get(name);
    return typeof v === 'number' ? v : m && !m.engine ? m.limit : undefined;
  }
  /** @internal */
  _evaluate() {
    const v = this.values(), over = [];
    let top = null;
    for (const [category, value] of Object.entries(v)) {
      const limit = this.limitOf(category);
      if (limit == null || value == null) continue;
      if (LOWER.has(category) ? value >= limit : value <= limit) continue;
      over.push({ category, value, limit, top: top ??= this.byTag().slice(0, 5) });
    }
    return { ok: !over.length, over };
  }
  /** @internal Where a measurement was taken: this machine's GPU, timing mode, backend, canvas size and pixel ratio, camera position (1 m) and
   * direction. A baseline compares only like with like: counts follow what the camera sees, times follow the machine and the pixels drawn */
  _where() {
    const e = this.engine, r = e.renderer, c = e.camera, d = c.getWorldDirection(this._v ??= new THREE.Vector3()), cv = r.domElement;
    const n = (/** @type {number} */ x, k = 1) => Math.round(x * k) / k;
    this._gpu ||= backendFacts(r).gpu ?? '';   // WebGPU knows its adapter only after init: asked again until it answers
    return `${e.headless ? 'step' : 'live'} ${r.isWebGPURenderer ? 'webgpu' : 'webgl'} ${this._gpu || 'gpu?'} ${cv.width}x${cv.height}@${n(r.getPixelRatio(), 100)} @${n(c.position.x)},${n(c.position.y)},${n(c.position.z)} >${n(d.x, 10)},${n(d.y, 10)},${n(d.z, 10)}`;
  }
  /**
   * This run's numbers in the shape baseline keeps: { where, values: { drawCalls, triangles, cpuMs (live runs), modules: { name: median ms, 0 too } } }.
   * threedog shot / verify --save-baseline write it into the game's .threedog/perf-baseline.json (this machine's, not committed)
   * @returns {{ where: string, values: { drawCalls: number, triangles: number, cpuMs?: number, modules: Record<string, number> } }}
   */
  record() {
    const v = this.values(), prof = this.engine.profile?.() ?? {};
    const modules = Object.fromEntries(Object.entries(prof).map(([k, p]) => [k, p.ms]));   // zeros kept: a module that was free and now costs shows
    return { where: this._where(), values: { drawCalls: v.drawCalls, triangles: v.triangles, ...(v.cpuMs != null && { cpuMs: v.cpuMs }), modules } };
  }
  /** @internal What is slower than the baseline recorded at this same spot: [{ category, value, base }] (base null: a module the baseline lacks), worst first */
  _slower() {
    const b = this.baseline?.[this._where()];
    if (!b) return [];
    const v = this.values(), prof = this.engine.profile?.() ?? {}, out = [], mods = b.modules ?? {};
    const push = (category, value, base) => out.push({ category, value, base });
    for (const k of ['drawCalls', 'triangles']) if (b[k] > 0 && v[k] > b[k] * (1 + SLOW_COUNT)) push(k, v[k], b[k]);   // a 0 recorded before any draw compares nothing
    // times: past both margins; from 0 or absent (a module new since the baseline) the absolute floor alone, so a regression from nothing shows
    const slowMs = (now, was) => now - (was ?? 0) >= SLOW_MS.abs && (!(was > 0) || now > was * (1 + SLOW_MS.share));
    if (typeof b.cpuMs === 'number' && v.cpuMs != null && slowMs(v.cpuMs, b.cpuMs)) push('cpuMs', v.cpuMs, b.cpuMs);
    for (const [k, p] of Object.entries(prof)) if (slowMs(p.ms, mods[k])) push('modules.' + k, p.ms, typeof mods[k] === 'number' ? mods[k] : null);
    const ratio = s => s.value / Math.max(s.base ?? 0, 1e-3);
    return out.sort((a, b) => ratio(b) - ratio(a));
  }
  /**
   * One line when something is off, null when all is fine: over a limit the game declared (only when the budget is on; the engine's own reference
   * limits never), slower than the baseline recorded at this spot on this machine (medians, past a noise margin), a module with spikes (p95 over 3x
   * its median and over 2 ms), or what adaptive quality lowered (resolution, effects). threedog shot, verify and describeText print it
   * @returns {string | null}
   * @example engine.budget.notice()   // 'Perf: over budget drawCalls 312 (limit 250, +25%); slower than baseline: modules.terrain 1.4 ms (was 0.6, +133%) -> threedog inspect perf'
   */
  notice() { return this._notice(this.report()); }
  /** @internal notice() on a report already made (describe() makes one for its own budget field: an overrun walks the scene once, not twice) */
  _notice(rep) {
    const parts = [], e = this.engine, prof = e.profile?.() ?? {};
    const unit = k => k === 'cpuMs' || k.startsWith('modules.') ? ' ms' : '';
    const over = rep?.over.filter(o => this._ownLimit(o.category) != null) ?? [], slow = this._slower();
    const spiky = Object.entries(prof).filter(([, p]) => p.p95 > 2 && p.p95 > 3 * p.ms);
    if (over.length) parts.push('over budget ' + over.slice(0, 3).map(o => `${o.category} ${o.value}${unit(o.category)} (limit ${o.limit}, ${pct(o.value, o.limit)})`).join(', '));
    if (slow.length) parts.push('slower than baseline: ' + slow.slice(0, 3).map(s => `${s.category} ${s.value}${unit(s.category)} (${s.base == null ? 'new' : s.base > 0 ? `was ${s.base}, ${pct(s.value, s.base)}` : 'was 0'})`).join(', '));
    if (spiky.length) parts.push('spiky: ' + spiky.slice(0, 3).map(([k, p]) => `${k} (p95 ${p.p95} ms, median ${p.ms})`).join(', '));
    const lowered = loweredText(e);   // adaptive quality: what its ladder holds lowered now (core/scene/adaptive.js)
    if (lowered) parts.push(lowered);
    return parts.length ? `Perf: ${parts.join('; ')} -> threedog inspect perf` : null;
  }
  /**
   * Estimate draw calls and triangles by userData.budgetTag (visible meshes inside the frustum; shadow casters count a second shadow draw).
   * Returns [{ tag, drawCalls, triangles }], largest first. Called only on overrun (at most once a second) or when debugging
   * @returns {BudgetTagStat[]}
  */
  byTag() {
    const e = this.engine, cam = e.camera, out = new Map(), shadows = e.renderer.shadowMap.enabled, shadowCost = Object.values(SHADOW_TYPES).find(t => t.three === e.renderer.shadowMap.type)?.cost ?? 1;
    // shadow passes a caster is drawn in: one per shadow map the renderer draws (each cascade on both renderers), six for a point light
    const passes = Math.max(1, shadowMaps(e.renderer, e.scene).reduce((n, m) => n + m.faces, 0));
    cam.updateMatrixWorld();
    cameraFrustum(cam, this._frustum);
    const walk = (o, tag) => {
      if (!o.visible) return;
      tag = o.userData.budgetTag ?? tag;
      if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && (!o.frustumCulled || this._frustum.intersectsObject(o))) {
        const g = o.geometry, groups = Array.isArray(o.material) ? Math.max(1, g?.groups.length ?? 1) : 1;
        // a caster adds a shadow draw, scaled by the filter's rough cost (estimate: vsm ~1.6x, basic ~0.8x of pcf), once per pass
        // (an upper bound: each light culls to its own shadow box, so a near cascade skips most of the scene)
        const calls = groups * (shadows && o.castShadow ? 1 + shadowCost * passes : 1);
        const n = g ? (g.index ? g.index.count : g.attributes.position?.count ?? 0) : 0;
        const s = out.get(tag) || out.set(tag, { tag, drawCalls: 0, triangles: 0 }).get(tag);
        s.drawCalls += calls; s.triangles += o.isMesh ? Math.round(n / 3) * (o.count ?? 1) : 0;
      }
      for (const c of o.children) walk(c, tag);
    };
    walk(e.scene, 'other');
    return [...out.values()].sort((a, b) => b.drawCalls - a.drawCalls);
  }
}
