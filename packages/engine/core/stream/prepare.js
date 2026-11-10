// Ready content that arrives after start before it is first drawn. start() compiles the startup scene behind the loading screen (core/engine/startup.js); a stream
// build that brings a material the renderer has not seen compiled it inside the frame that first drew it (the hitch the player sees), and uploaded its textures there.
// Streamed content goes through this one step instead: textures uploaded with renderer.initTexture, unseen materials compiled with
// renderer.compileAsync(object, camera, scene) against the scene's own lights and environment and the target the scene draws into, as start() does.
// Shown only once that settles; content whose materials are all known (the common case: kits, terrain, plants) is shown at once.
// Plain three.js equivalent: for (const t of textures) renderer.initTexture(t); await renderer.compileAsync(obj, camera, scene); scene.add(obj)
import { isWebGPU, programCount, borrowRenderer } from '../../render/backend.js';

/** Every texture the materials under root hold in a slot (map, normalMap...); a texture reached only through a TSL node is uploaded by the compile @param {any} root @param {Set<any>} [out] */
export function texturesOf(root, out = new Set()) {
  root.traverse(o => { for (const m of [].concat(o.material || [])) for (const k in m) if (m[k]?.isTexture) out.add(m[k]); });
  return out;
}

/** @internal engine.stream's prepare step (one per engine) */
export class Prepare {
  constructor(engine) {
    this.engine = engine;
    // material -> true (compiled) or the Promise of its compile, so a second object with it waits for the same compile instead of drawing it half-done.
    // By identity, not by program: a fresh material with a cached program costs one cheap compileAsync and a frame of delay, never a stall
    this.known = new WeakMap();
    // a disposed material lost its program: one a game reuses across builds must compile again when the player walks back
    const known = this.known;   // the listener holds the WeakMap only: a game material that outlives the engine must not keep the engine alive
    this._forget = ev => known.delete(ev.target);
    /** compileAsync calls made during play (inspect perf, the streaming test) */ this.compiles = 0;
    // WebGPU: one compileAsync at a time (WebGL's parallel compile is safe: render/backend.js compileThrough). WebGPURenderer (three 0.187) keeps one precompile state: a second call whose items interleave with the first's ends the
    // first's state (its _finishPreCompile then throws on null) and leaves _callDepth one too high, so every later frame draws in a fresh render context and
    // each object gets new records that are never freed (found by tests/specs/stream-prepare.mjs: +4 records and 7 uniform buffers per walk out and back)
    /** @internal the compile in flight, or null */ this._busy = null;
  }
  /** @internal compileAsync(obj) for the target the scene really draws into (the program is keyed by its output, as in startup.js) */
  _compile(obj) {
    const e = this.engine, r = e.renderer;
    if (e.disposed) return Promise.resolve();   // a chained compile whose engine went away meanwhile
    // WebGPU's compileAsync culls by the camera frustum: content streaming in behind the player would compile nothing and still count as known
    const culled = [];
    obj.traverse(o => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    try { return Promise.resolve(borrowRenderer(r, () => { r.setRenderTarget(e.post._sceneTarget()); return r.compileAsync(obj, e.camera, e.scene); })); } catch (err) { return Promise.reject(err); } finally {
      for (const o of culled) o.frustumCulled = true;
      // WebGL compiled the programs just now, before this frame's render: that render must not read the new count as a compile stall
      const n = programCount(r), c = e.budget.cost; if (n != null && c._programs >= 0) c._programs = n;
    }
  }
  /** @internal Track m (three's addEventListener skips a listener already added) */
  _know(m, v) { m.addEventListener('dispose', this._forget); this.known.set(m, v); }
  /** Materials under root count as compiled (start() calls it on the whole scene after its compile) @param {any} root */
  mark(root) { root.traverse(o => { for (const m of [].concat(o.material || [])) this._know(m, true); }); }
  /**
   * Upload obj's textures and compile its unseen materials. null: nothing to wait for, show it now. Otherwise a Promise that resolves (never rejects:
   * a shader error is the renderer's to report, and the object is shown as it would have been) when it may be shown.
   * @param {any} obj @returns {Promise<void> | null}
   */
  run(obj) {
    const e = this.engine, r = e.renderer;
    if (!e.ready || e.disposed || r.initialized === false) return null;   // loading: start() compiles everything in the scene; a WebGPURenderer before init has no device
    const t0 = performance.now();   // measure: the 'upload' stage of engine.budget.cost
    const tex = texturesOf(obj);
    for (const t of tex) r.initTexture(t);
    const waits = new Set(), fresh = [];
    obj.traverse(o => { for (const m of [].concat(o.material || [])) { const k = this.known.get(m); if (k === undefined) fresh.push(m); else if (k !== true) waits.add(k); } });
    if (fresh.length) {
      this.compiles++;
      // idle: compiled now, inside the caller's job (its node build is timed below). Busy: chained after the one in flight.
      // shortcut: a chained compile's node build runs in a promise callback, outside the job budget; batch the waiting objects into one call if that shows in applyUploadMs
      const gpu = isWebGPU(r), quiet = () => {}, p = gpu && this._busy ? this._busy.then(() => this._compile(obj)) : this._compile(obj);
      const done = p.then(quiet, quiet).then(() => {
        for (const m of fresh) if (this.known.get(m) === done) this._know(m, true);   // disposed meanwhile: forgotten, stays out
        if (this._busy === done) this._busy = null;
      });
      if (gpu) this._busy = done;
      for (const m of fresh) this._know(m, done);
      waits.add(done);
    }
    if (tex.size || fresh.length) e.budget.cost.add('upload', performance.now() - t0);   // measure
    return waits.size ? Promise.all(waits).then(() => {}) : null;
  }
}
