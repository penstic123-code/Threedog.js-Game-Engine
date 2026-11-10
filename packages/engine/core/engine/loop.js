// Main loop (part of Engine, mixed into Engine.prototype): fixed step + per-frame hooks + render, deterministic step(), hook timing profile(),
// adaptive resolution.
//
// Hook errors: onFixed / onFrame callbacks and module fixed / frame / afterRender hooks each run in try/catch and are handled by error tier (errors.js):
// picture / ui modules are disabled, errors elsewhere freeze gameplay in dev / tests and are recorded in engine.error, core steps such as render
// report only once; input.endFrame() sits in finally so "just pressed" always clears.
//
// What freezing (engine.freeze) stops: the whole fixed step is skipped (onFixed, module fixed, tick and every time view but ambient stop);
// frame hooks, stream / jobs and render keep going (the picture and UI stay usable). So gameplay logic (movement, timers, quest checks, cutscene
// waits) belongs in fixed,
// or must check engine.frozen first inside frame.
//
// Determinism: in engine.step() and headless loading frames, jobs ignore the real-time budget and drain the queue (see Jobs.js),
// and stream's synchronous builds are attached to the scene before step returns: same input and same seed (engine.random) give the same result.
import { reportError } from '../base/errors.js';
import { DEV, warnOnce, fmt, syncOnly } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';
import { watchLights } from '../inspect/lightWatch.js';
import { watchGeometries } from '../inspect/geometryWatch.js';
import { followFocus } from '../../render/lights.js';
import { STEP } from '../time/time.js';   // fixed step length: 60 per second
import { adapt } from '../scene/adaptive.js';
import { advanceUiClock } from '../time/uiClock.js';
import { resetStats, programCount, freshFrame, holdRenderer, releaseRenderer } from '../../render/backend.js';
import { engineDraws } from '../../render/ownFrame.js';
import { writeDaylight } from '../../render/daylight.js';
import { quantile } from '../base/math.js';
import { unsettled } from './headlessLoad.js';
// Most real time one frame may turn into fixed steps (6 steps). A longer hitch slows the game for that frame
// instead of replaying it in a burst (no spiral of death, no jump after a stall).
const MAX_CATCHUP = 0.1;
// Module hook timing keeps each module's ms of the last PROF_FRAMES frame-hook cycles: median (steady cost, what budgets judge), mean (what a
// benchmark run averages) and p95 (spikes). 300 cycles = 5 s live, 10 s of step(), enough for the benchmark pages; each ring is allocated once
// per module and read on demand, so the sort costs nothing per frame
const PROF_FRAMES = 300;
/** Timing judges play, not start-up: the first frame after ready at which loading is done and nothing is unsettled (modules' isReady, the stream's
 * queued builds: the same answer start() and the tools' waits use) clears the module timing ring and the frame-time window, once. Start-up chunk
 * builds would otherwise sit in the median window and read as spikes; a chunk built while walking later still counts */
function startPlayTiming(e) {
  if (!e.ready || !e.loading.view().done || unsettled(e).length) return;
  e._playTiming = true;
  if (e._prof) e.profile(true);
  e.budget._clearFrames();
}
/** Close one frame-hook cycle of module timing: each module's ms of the cycle goes into its ring (0 for a module whose hooks did not run).
 *  Each ring counts its own samples: a module first timed late (a level's module, a late use()) is judged on its cycles only, not on zeros for
 *  the cycles before it existed.
 *  Fixed hooks count one step: the cycle's dearest step (_runHooks keeps it). Why: a slow frame runs several catch-up steps and step() runs
 *  frameEvery per cycle, so the summed ms grew with the frame rate, not with the module: the open-world physics read median 0.7 / p95 3.9 ms
 *  ("spiky: rigid") on a slow software-rendered page while one step cost about 0.2 ms. The dearest, not the average: a step that itself spikes
 *  (a chunk's collider built) still shows in full */
function closeProfFrame(p) {
  for (const k in p.fix) { p.cur[k] = (p.cur[k] || 0) + p.fix[k]; p.fix[k] = 0; }
  for (const k in p.cur) if (!p.ring[k]) p.ring[k] = { buf: new Float32Array(PROF_FRAMES), i: 0, n: 0 };
  for (const k in p.ring) {
    const r = p.ring[k];
    r.buf[r.i] = p.cur[k] || 0; p.cur[k] = 0;
    r.i = (r.i + 1) % PROF_FRAMES;
    if (r.n < PROF_FRAMES) r.n++;
  }
}
// Most milliseconds one frame spends on catch-up steps (two steps' worth of real time, one 30 fps frame). Why a time budget on top of the
// step cap: after a hitch in a heavy scene, 6 steps of 13 ms made a 77 ms fixed phase, so the next frame was long too and caught up again
// (a hitch cascade). Judged by the step just measured, so cheap steps still catch up all 6; the time left over is dropped (a brief slow-down)
const CATCHUP_MS = STEP * 2000;
// Dev message (console): which hook failed
const STRINGS = {
  onFixed: 'onFixed callback', onFrame: 'onFrame callback', animate: 'animator update', onRender: 'onRender callback', clock: 'clock timer', render: 'render',
  hook: '{kind} hook of module {name}',
  stepStart: 'engine.step() ran while start() is still loading: no game time passes, only frame hooks run. Wait for it first: await engine.start(); engine.step(1)',
  stepSession: 'engine.step() ran while a new game, load or quit is still replacing the state: the step plays on a half-replaced world. Wait for it first: await engine.session.load(slot); engine.step(1)',
};

const SOFT = { soft: true };   // core steps (render, stream): report once only
/** Call a hook fn.call(self, a, b); errors go to reportError for tiering.
 *  opts: { module } the failing module / SOFT / null (game callback, counts as gameplay).
 *  Takes no ...args and needs no caller closure: the main loop calls this many times a frame, so it must not allocate each time. */
function safe(engine, key, fn, opts, self, a, b) {
  try { syncOnly(fn.call(self, a, b), opts?.module ? `${key} of module ${opts.module}` : key); } catch (err) { reportError(engine, err, key, opts ?? undefined); }
}
/**
 * One engine.onRender hook. What a hook borrows to draw (the target, viewport, scissor, autoClear, scene.overrideMaterial, camera.layers) it gives back on its last lines, which a
 * throw skips, and the engine's frame then draws into an 8-pixel corner or in one flat material from there on. So a hook that throws has them put back (every field
 * render/backend.js holdRenderer lists, scene and camera included). One that returns
 * is taken at its word: what it left is the game's choice.
 */
function drawHook(f, ctx) {
  const held = holdRenderer(ctx.renderer, { scene: ctx.scene, camera: ctx.camera });
  let threw = true;
  try { syncOnly(f(ctx), STRINGS.onRender); threw = false; } finally { releaseRenderer(held, threw); }
}
/** Run one game callback list. remove() replaces the list, so a hook an earlier one removed in this pass (or a dispose) is skipped: it may sit on what its remover just tore down */
function runList(e, name, key, a) {
  const list = e[name];
  for (const f of list) if (live(e, name, list, f)) safe(e, key, f, null, undefined, a);
}
/** Whether f still belongs to holder[name]: the list was replaced (remove, dispose) and f is not in the new one = skip it. Shared by runList and the engine.onRender passes */
const live = (holder, name, list, f) => holder[name] === list || holder[name].includes(f);

// The first frame drawn after ready ends the first-frame measure (engine.startup.firstFrameMs, startup.js); one compare per frame after that
function firstFrame(e, at) {
  const s = e.startup;
  e._readyAt = null;
  if (s) { s.phases.draw = Math.round(at - (s.phases.script + s.phases.construct + s.phases.setup + s.phases.init + s.phases.preload + s.phases.world + s.phases.compile)); s.firstFrameMs = Math.round(at); }
}

export const loopMethods = {
  _fixedStep() {
    // No game time while start() loads (engine.phase): loading takes as long as the machine needs, so a step during it would make the opening
    // tick and clock depend on machine speed (review 0.4 core B1). step() during loading (headless scenario settling) still runs frame
    // hooks. An engine never started ('constructed': no loop, nothing loading) steps by hand only, for tests and tools that need no world
    if (this._inStart) return;
    // input snapshot for this step: keys read in fixed depend only on the step count, not on how many steps a frame ran
    this.input.beginFixed();
    try {
      // gameplay frozen: no clock moves, no channel, no mod({ for }) timer (frame hooks and render continue). uTime is the ambient clock (wind, water,
      // clouds): it keeps moving behind a pause menu, the common expectation, unless a freezer asked freeze(owner, { still: true })
      if (this.frozen) { this.time._frozenStep(!this.still); return; }
      this.time._beginStep();                  // the one counter (core/time/time.js): this step's commits, ops and input records carry the new tick
      this._inFixed = true;                    // ops log phase 'fixed' and the dev guard lets gameplay writes through
      // due background results first, so this step's gameplay sees them; an engine stepped by hand before start() applies none (start() rebases them)
      if (this.ready) this.commits.tick(this.time.tick);
      runList(this, '_fixed', STRINGS.onFixed, STEP);
      this._runHooks('fixed', STEP);
      runList(this, '_fixedLate', STRINGS.onFixed, STEP);   // onFixed({ phase: 'late' }): reads this step's result
      safe(this, STRINGS.clock, this.time._endStep, null, this.time);   // ambient, channel and calendar seconds; timed mods end; timers fire
    } finally { this._inFixed = false; this.input.endFixed(); }
  },
  /** @internal The loop and the dev tools. Per frame: onFrame callbacks, module frame, stream, jobs. With deterministic true (step, headless loading) jobs ignore real time. */
  _frameHooks(dt, deterministic = false) {
    if (this.disposed) return;   // a fixed step of this frame disposed the engine (step() checks the same)
    // one profile frame = one frame-hook cycle (the real loop: one per rendered frame; step(): one per frameEvery fixed steps). Counting rendered frames
    // instead made step(render: false) divide by zero frames and report the whole run's milliseconds as one frame's
    if (this._prof) closeProfFrame(this._prof);
    this._picture?.frameStart();
    this.rays.fresh = -1;   // frames advance while time is frozen (tick stays): the next ray re-reads the statics' matrices
    advanceUiClock(this, dt);   // headless pages: UI display timers run on the stepped time (core/time/uiClock.js)
    writeDaylight(this);   // before the hooks: an onFrame reads this frame's signal
    runList(this, '_frame', STRINGS.onFrame, dt);
    // after every onFrame, whoever registered first: an anim.sync / go / set made this frame shows this frame. Before the module frame hooks, which read the pose
    runList(this, '_animate', STRINGS.animate, dt);
    this._runHooks('frame', dt);
    safe(this, 'stream.update', this.stream._update, SOFT, this.stream);
    this.jobs.run({ deterministic });
    safe(this, 'stream.settle', this.stream._settle, SOFT, this.stream);   // after every loader ran: readiness of stream sources
    safe(this, 'batching.update', this.batching.update, SOFT, this.batching);   // last before rendering: picks up everything built this frame
    safe(this, 'audio.tick', this.audio._tick, SOFT, this.audio);   // positional sounds follow their objects (returns at once when there are none)
    // every 30th cycle: loading.view() and unsettled() build arrays, and a game that never settles would pay that every frame
    if (!this._playTiming && (this._settleTick = ((this._settleTick ?? 0) + 1) % 30) === 1) startPlayTiming(this);
  },
  /** @internal The loop and the dev tools: one whole engine frame (onRender hooks, own-frame yielding, per-frame bookkeeping). engine.renderOnce stays the public draw: photo mode needs its picture even from a game that owns the frame, and a game may call it inside a hook.
   *  @param {number} dt @param {boolean} [hooks] false: draw without the game's onRender hooks (the picture check's probe renders: picture code
   *  run there wrote back the light it had just turned off) */
  _render(dt, hooks = true) {
    const r = this.renderer;
    resetStats(r);
    this._gameLights?.frame();   // plain PointLight / SpotLight at intensity 0 stop redrawing their shadow map (gameLights.js)
    writeDaylight(this);   // again: a time jump in onFrame / a module's frame hook after the first write must reach uDaylight / uTimeOfDay in the frame that draws it, with uSunDir
    followFocus(this);   // baseline sun (no sky module): its shadow box follows engine.focus (render/lights.js)
    const t0 = performance.now();   // measure
    const gpu = this.adaptive.on ? this._gpu : null;   // GPU time feeds adaptive resolution only; no queries while it is off
    gpu?.begin();
    // engine.onRender: camera and batching are final here. 'before' may render into its own targets (counted in renderer.info and the render phase)
    const before = hooks ? this._onRender.before : [], after = hooks ? this._onRender.after : [];
    const ctx = before.length || after.length ? { renderer: r, scene: this.scene, camera: this.camera, dt } : null;
    // the game drew the canvas itself since the last engine frame (own composer / render loop): it holds the frame, the engine yields (render/ownFrame.js)
    const draws = engineDraws(this), own = this._ownFrame;
    if (own) own.inside++;
    this._poses.draw();   // moving things draw between the last two fixed steps (stepPoses.js); undone below, gameplay never sees it
    try {
      for (const f of before) { if (!live(this._onRender, 'before', before, f)) continue; safe(this, STRINGS.onRender, drawHook, null, undefined, f, ctx); r.setRenderTarget(null); }
      this.shadows._frame();   // a game light's cascades, after 'before': picture code aims its light there, and the placement must be what is drawn (render/shadows.js)
      this._checkBackendAdds();   // WebGPU route: a WebGL-only material added since the last frame is named, not drawn blank (startup.js)
      freshFrame(r);   // WebGPU: step() several times in one task, or a renderOnce() earlier in this tick, must not reuse that scene pass
      if (this._picture) this._picture.drawing = true;
      if (draws) { this.batching.skip(); try { this.post.render(dt); } finally { this.batching.unskip(); } }
      if (this._picture) this._picture.drawing = false;
      for (const f of after) if (live(this._onRender, 'after', after, f)) safe(this, STRINGS.onRender, drawHook, null, undefined, f, ctx);
    } finally { this._poses.undraw(); if (own) own.inside--; this._picture?.frameEnd(); }
    gpu?.end();
    // frames that first draw new objects pay their GPU upload here (Budget.js ApplyCost); a frame that compiled shaders is not judged by adaptive resolution
    this._compiled = this.budget.cost.rendered(performance.now() - t0, programCount(r) ?? -1, t0 / 1000);   // measure
    if (DEV && this.ready && !this._probing) {
      watchLights(this);   // dev: a light added / removed mid-play compiled new shaders (one long frame): say so (lightWatch.js)
      watchGeometries(this, dt);   // dev: geometries piling up that nothing in the scene uses (geometryWatch.js)
    }
    this._records?.step(dt);   // WebGPU: free the records of meshes that left the scene, a slice per frame (render/recordSweep.js)
  },
  _runHooks(kind, dt) {
    const p = this._prof;
    const was = this._curModule, list = this._hooks[kind];
    for (const h of list) {
      if (this._hooks[kind] !== list && !this._hooks[kind].includes(h)) continue;   // its module went earlier in this pass (unuse, disabled): no hook after its dispose
      const key = h.key ??= fmt(STRINGS.hook, { name: h.name, kind });   // build the key once
      const opts = h.opts ??= { module: h.mod };
      this._curModule = h.mod;   // the module type checks (moduleTypes.js) know whose hook is writing
      if (!p) { safe(this, key, h.fn, opts, undefined, dt, this); continue; }
      const t0 = performance.now();   // measure
      safe(this, key, h.fn, opts, undefined, dt, this);
      const into = kind === 'fixed' ? p.step : p.cur;   // fixed hooks: this step's ms, kept below as the cycle's dearest step (closeProfFrame)
      into[h.name] = (into[h.name] || 0) + performance.now() - t0;   // measure
    }
    if (p && kind === 'fixed') for (const k in p.step) { if (p.step[k] > (p.fix[k] || 0)) p.fix[k] = p.step[k]; p.step[k] = 0; }
    this._curModule = was;
  },
  /** Time module hooks (fixed + frame + afterRender): on by default in dev builds, off in production. profile(true) starts afresh, profile(false) stops;
   *  profile() returns { moduleName: { ms, mean, p95 } } per frame over the last 300 frame-hook cycles: ms is the median (null when off); fixed hooks
   *  count one fixed step per frame (the frame's dearest), so a slow frame's catch-up steps do not read as the module's cost. Only the
   *  module's own hooks count, not engine.jobs / stream work it hands off. Without cross-origin isolation the browser rounds performance.now() to 0.1 ms */
  profile(on) {
    if (on !== undefined) { this._prof = on ? { cur: {}, step: {}, fix: {}, ring: {} } : null; return this; }
    const p = this._prof;
    if (!p) return null;
    const r = {};
    const r2 = v => Math.round(v * 100) / 100;
    for (const k in p.ring) {
      const a = p.ring[k].buf.subarray(0, p.ring[k].n);
      r[k] = { ms: r2(quantile(a, 0.5)), mean: r2(a.reduce((s, v) => s + v, 0) / a.length), p95: r2(quantile(a, 0.95)) };
    }
    return r;
  },

  // ---------- nextFixed (halt / freeze / runState live in holds.js; step() below is the deterministic way to advance) ----------
  /**
   * Run fn at the start of the next fixed step (before that step's fixed hooks), from any callback (UI click, promise, worker result): gameplay state is safe to write there.
   * Returns a Promise of fn's value (rejects if fn throws). Waits while frozen or loading. Built on engine.commits: applies in request order and survives save loads.
   * @template T
   * @param {() => T} fn
   * @returns {Promise<T>}
   * @example engine.nextFixed(() => engine.ops.run('door.open', { id: 'gate' }));
   */
  nextFixed(fn) {
    return new Promise((resolve, reject) => {
      const t = this.commits.request({ lag: 1, valid: () => true, fallback: () => undefined, apply: () => { try { resolve(fn()); } catch (err) { reject(err); } } });
      t.resolve(undefined);   // nothing to wait for: otherwise the fallback would count as late
    });
  },

  /**
   * Real loop only (step() never comes here, so it stays deterministic): turn this frame's real time dt into fixed steps. At least one step
   * runs when one is due; another runs only while this frame's fixed work, plus the cost of the step just run, stays within CATCHUP_MS.
   * Returns how many ran (tests read it).
   */
  _catchUp(dt) {
    const want = (this._acc || 0) + dt;
    let acc = Math.min(want, MAX_CATCHUP), n = 0, lost = want - acc;   // lost: real time the fixed steps will not run (over MAX_CATCHUP, or dropped for the budget below)
    const f0 = performance.now();   // measure
    let s0 = f0;
    while (acc >= STEP && !this.disposed) {   // a hook may dispose the engine
      this._fixedStep(); acc -= STEP; n++;
      const t = performance.now();   // measure
      if (acc >= STEP && t - f0 + (t - s0) > CATCHUP_MS) { lost += acc - acc % STEP; acc %= STEP; break; }   // the next one would go over: drop the rest
      s0 = t;
    }
    this._acc = acc;
    this._gameDt = Math.max(0, dt - lost);   // the one time frame hooks get this frame: what the fixed steps took of dt, minus every drop (hooks never run ahead of game logic)
    // held while frozen: with no fixed steps positions stand still, and a moving ratio would make interpolated things shake in place
    if (!this.frozen) this.stepBlend = acc / STEP;
    return n;
  },

  _loop() {
    if (this._looping) return;
    this._looping = true;
    this._acc = 0;   // real time not yet turned into fixed steps
    let last = performance.now();   // main-loop
    const tick = now => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.25, Math.max(0, now - last) / 1000); last = now;   // max: the first frame's timestamp can be older than the performance.now() above
      if (this.halted) { this._acc = 0; return; }        // halted: no advance, no render
      // Adaptive resolution judges the frames up to the last one (cpuMs, GPU time and _compiled still describe it) and changes the
      // render scale here, before this frame draws. Why not after the render: a canvas resize clears its drawing buffer, so a change made
      // after the draw handed the compositor a blank frame (R2: a screenshot caught the 1 -> 0.9 frame black). Not counted in cpuMs
      this._adapt(dt);
      this._compiled = false;
      // CPU time of one frame = main-thread work from here to the end of the afterRender hooks, in four phases (engine._cpuPhases):
      // fixed (input poll + fixed steps), frame (onFrame + module frame hooks + stream / jobs / batching), render (submitting the draw
      // calls: three.js CPU work, upload of new objects, shader compiles; not GPU time), afterRender (module hooks). Adaptive resolution
      // (before, above) and the startup readiness check (after) are not counted. Budget is sampled last so it sees this frame, not the previous one.
      const c0 = performance.now();   // measure
      let c1, c2, c3;
      try {
        this.input.poll(dt);
        // coming back from a hidden tab drops the time spent away, so play resumes without a burst of steps (page.js)
        // gameDt: the time the fixed steps took this frame (_catchUp: minus MAX_CATCHUP and budget drops; none after a resync), so frame hooks (tweens, cutscenes) never move more than game logic does
        let gameDt = 0;
        if (this.page.consumeResync()) this._acc = 0;
        else { this._catchUp(dt); gameDt = this._gameDt; }
        c1 = performance.now();   // measure
        this._frameHooks(gameDt);
        c2 = performance.now();   // measure
        // Before ready only the loading screen (DOM) is on screen: a scene frame there is never seen, but it compiled shaders and uploaded
        // geometry in the middle of loading (cold start measured 2.9 s -> 1.6 s without it). start() draws one hidden warm-up frame itself
        if (this.ready) safe(this, STRINGS.render, this._render, SOFT, this, dt);
        c3 = performance.now();   // measure
        if (this._readyAt != null && this.ready) firstFrame(this, c3);
      } finally { this.input.endFrame(); }
      this._runHooks('afterRender', dt);
      const c4 = performance.now(), P = this._cpuPhases;   // measure
      P.fixed = c1 - c0; P.frame = c2 - c1; P.render = c3 - c2; P.afterRender = c4 - c3;
      this._cpuMs = c4 - c0;
      this.budget.sample(dt);
      this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
      this._afterTick?.();
    };
    this._raf = requestAnimationFrame(tick);
  },

  /**
   * Advance synchronously by seconds of real (fixed-step) time; channels and the calendar advance by their own scales (core/time/time.js): fixed hooks run at 60 Hz;
   * frame hooks run once per frameEvery fixed steps (default 2, i.e. 30 Hz, dt = 1/30),
   * so fast-forwarding 600 seconds runs only 18000 frame-hook calls with no rendering and finishes in seconds. Renders one frame at the end when
   * render is true.
   * Input is read as usual: set engine.input.autopilot = { x, y, speed } to make the player walk by itself.
   * Jobs ignore real time inside step and drain the queue each frame; stream's synchronous builds are attached before it returns (stream.ready and
   * handle built are correct immediately).
   * Note: step is synchronous, so Promise continuations (the next timeline segment, await, async build) resume only after step returns; split a long
   * cutscene across several step calls.
   * seconds must be a finite number >= 0: step(0) advances nothing (no fixed step, no render), a negative or non-finite value throws; any positive
   * value runs at least one fixed step. While start() is still loading it runs frame hooks only (no game time passes until engine.phase is
   * 'ready'); in dev that, and a step during a session change nobody awaited, warns once.
   * Returns the result of describe() (null with { describe: false }, which callers that ignore it pass to skip the work).
   */
  step(seconds, { render = true, frameEvery = 2, describe = true } = {}) {
    if (this.disposed) return null;            // nothing advances after dispose
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
      throw codedError('step-seconds',
        `engine.step(${String(seconds)}): seconds must be a finite number >= 0, e.g. engine.step(0.5) (real seconds; 1 / 60 is one fixed step)`);
    if (seconds === 0) return describe ? this.describe() : null;   // 0 advances nothing (a tiny positive value still runs one fixed step)
    if (DEV && (this._inStart || this.session._busy)) warnOnce(coded('step-during-load', this._inStart ? STRINGS.stepStart : STRINGS.stepSession), 'step-during-load');
    const n = Math.max(1, Math.round(seconds / STEP));
    this.stepBlend = 1;   // step() takes the state to the end of each step, so the latest state is what cameras read and what gets drawn
    let since = 0;
    for (let i = 0; i < n && !this.disposed; i++) {   // a hook may dispose the engine
      this._fixedStep();
      if (++since >= frameEvery || i === n - 1) {
        try { this._frameHooks(since * STEP, true); } finally { this.input.endFrame(); }
        since = 0;
      }
    }
    if (this.disposed) return null;
    if (render) {
      safe(this, STRINGS.render, this._render, SOFT, this, STEP);
      this._runHooks('afterRender', STEP);
    }
    return describe ? this.describe() : null;   // describe: false for internal loops that ignore the result (describe() walks every module)
  },

  // Adaptive resolution (core/scene/adaptive.js): judged on frame cost; tests drive it with explicit cost / compiled values
  _adapt(dt, cost = Math.max(this._cpuMs, this._gpu?.ms ?? 0), compiled = !!this._compiled, gpuKnown = this._gpu?.ms != null) { adapt(this, dt, cost, compiled, gpuKnown); },
};

export const handRolled = [{ kind: 'loop', seen: 'a requestAnimationFrame game loop of its own', use: 'engine.onFrame(dt => ...) for what is seen, engine.onFixed(dt => ...) for rules: pause, step, tests and saves follow them', code: /\brequestAnimationFrame\s*\(\s*[\w.]+\s*\)|\.setAnimationLoop\s*\(/ }];
