// engine.jobs: a frame-sliced job scheduler. Build work (streaming, prop instancing, merging, cache reads) is queued and each frame spends at most budgetMs, so startup does not hitch.
//   await engine.jobs.add(() => buildHouse());                       // plain function: runs to completion in one go
//   engine.jobs.add(function* () { for (const p of props) { place(p); yield; } });   // generator: may pause at each yield until the next frame
//   engine.jobs.add(fn, { priority: 10 })                            // higher priority first (FIFO within a priority)
// Returns a Promise of the job's result (a returned Promise is awaited). Runs after the frame hooks each frame.
// Jobs that change gameplay state pass apply: the result takes effect on a fixed tick through engine.commits, not on whichever frame the work finished (machine speed must not affect gameplay):
//   engine.jobs.add(function* () { ...compute...; yield; ...; return result; }, { apply: result => changeGameplayState })
//   If the job is not done by the due tick, the remaining steps run to completion on the spot, so such a job must be a plain function or generator (it cannot return a Promise).
//   Those steps are capped by maxSteps too: a generator that never ends would hang the fixed step, so past the cap its promise rejects with jobs-endless and apply does not run.
//   With apply, the returned Promise resolves when the work finishes, which may be before apply runs (it waits for the fixed tick); put anything that needs "state already changed" inside apply, do not assume it after await.
// Steps are packed by time, not by count: a frame runs as many next() calls as fit in budgetMs (3 ms), so one yield per unit of work is enough and there is no row count to guess. One step over slowStepMs (8 ms, real-time loop) is only a reminder: it warns once in dev, so add more yields to slice that step (the budget cannot split one step).
// Two ways to advance:
//   Real-time loop: at most budgetMs per frame (loadingMs while the loading screen is up), always at least one step so a slow job cannot starve.
//   Deterministic (engine.step(), headless loading): ignores real time and drains the queue on each run (generators run to the end);
//     to stop jobs that keep adding jobs from hanging, one run takes at most maxSteps steps (default 100000), warns once past that, and continues next frame.
// The queue is a binary heap (priority, then insertion order), so thousands of queued builds stay fast.
import { warnOnce, fmt } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';

const STRINGS = { slow: 'engine.jobs: a step of {who} took {ms} ms (over {max}) and will hitch the frame; add more yield calls in its loop to slice it, or give the function a name so this line can say which', async: 'engine.jobs.add(..., { apply }): a job that changes gameplay state cannot return a Promise (it must be finishable on the spot when due); make it a plain function or generator', endless: 'engine.jobs: {who} with apply was due and did not finish within {n} steps (engine.jobs.maxSteps), so it was stopped and its apply will not run. Make the generator end, or give it a later lag', tooMany: 'engine.jobs: deterministic advance (step / headless) did not finish within {n} steps, next up {who}; the rest continues next frame. If that job adds new jobs each time, end the chain' };

/** A job as a message names it: the function it was given */
const jobName = j => j.work?.name ? `job ${j.work.name}` : 'an unnamed job';

// a runs before b: higher priority first, then earlier insertion
const before = (a, b) => a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq);

/**
 * engine.jobs queues build work in a binary heap (higher priority first, FIFO within a priority).
 * In the real-time loop each frame spends at most budgetMs; engine.step() and headless loading ignore real time and drain the queue each frame (reproducible results).
 */
export class Jobs {
  /** @internal */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** Milliseconds allowed per frame, default 3 @experimental */
    this.budgetMs = 3;
    /** Milliseconds allowed per frame while the loading screen is up, default 12 @experimental */
    this.loadingMs = 12;
    /** Max steps per deterministic run (stops jobs that keep adding jobs from hanging), default 100000 @experimental */
    this.maxSteps = 100000;
    /** A step slower than this many ms warns in dev (default 8) @experimental */
    this.slowStepMs = 8;
    /** @internal */ this.heap = [];
    /** @internal */ this._seq = 0;
    /** @internal Total finished jobs (for describe) */ this.doneCount = 0;
  }
  /** Number of jobs not yet finished @returns {number} @experimental */
  get pending() { return this.heap.length; }
  /** @internal Drop queued jobs (called by engine.dispose; their Promises never settle) */
  dispose() { this.heap.length = 0; }
  /**
   * Add a job: a plain function runs in one go, a generator may pause at each yield until the next frame; higher priority runs first; returns the job's result.
   * A job that changes gameplay state passes apply: the result takes effect on a fixed tick via engine.commits (lag fixed steps later, default 30), and is finished on the spot if not done by then, so machine speed does not affect gameplay.
   * Such a job must be a plain function or generator (it cannot return a Promise). With apply, the returned Promise resolves when the work finishes, before apply may have run; put logic that needs "state already changed" inside apply. A step over slowStepMs warns in dev to slice it with yield.
   * @template [T=any]
   * @param {(() => T) | (() => Generator<any, T, any>) | Generator<any, T, any>} work
   * valid (with apply): still wanted when due? Default: dropped when a save load or level change happened since add.
   * @param {{ priority?: number, apply?: ((result: T) => void) | null, lag?: number, valid?: () => boolean }} [opts]
   * @returns {Promise<T>}
   * @example await engine.jobs.add(function* () { for (const p of props) { place(p); yield; } }, { priority: 10 });
   */
  add(work, opts = {}) {
    const { priority = 0, apply = null, lag, valid } = opts, c = this.engine.commits, epoch = c.epoch;
    return new Promise((res, rej) => {
      const j = { work, priority, seq: this._seq++, res, rej, it: null, ticket: null };
      const still = () => !j.failed && (valid ? valid() : c.epoch === epoch);
      if (apply) j.ticket = c.request({ apply, lag, fallback: () => this._finishNow(j), valid: still });
      this._push(j);
    });
  }
  /** @internal Not done by the due tick: run the remaining steps now and return the result */
  _finishNow(j) {
    // same cap as run(): the fixed step cannot wait for "next frame", so an endless generator fails here instead of hanging the page
    for (let n = 0; !j.finished && !j.failed; n++) {
      if (n >= this.maxSteps) { this._fail(j, codedError('jobs-endless', fmt(STRINGS.endless, { who: jobName(j), n: this.maxSteps }))); break; }
      this._step(j);
    }
    // A job that fails here already told its caller through the promise (j.rej). Throwing again from the fixed step would freeze the game a second time
    // for the same error, and apply(undefined) must not run: cancel the ticket, and Commits.tick drops a canceled request after its fallback
    if (j.failed) { j.ticket?.remove(); return undefined; }
    return j.value;
  }
  /**
   * Run the queue (the engine calls this each frame): by millisecond budget by default; deterministic: true ignores real time and drains it (used by step)
   * @param {{ deterministic?: boolean }} [opts]
   */
  run(opts = {}) {
    const { deterministic = false } = opts;
    if (!this.heap.length) return;
    if (deterministic) {
      let n = 0;
      while (this.heap.length && n++ < this.maxSteps) this._stepTop();
      if (this.heap.length) warnOnce(coded('jobs-slow', fmt(STRINGS.tooMany, { n: this.maxSteps, who: jobName(this.heap[0]) })));
      return;
    }
    const end = performance.now() + (this.engine.ready ? this.budgetMs : Math.max(this.budgetMs, this.loadingMs));   // measure: frame budget
    let first = true;
    while (this.heap.length && (first || performance.now() < end)) { first = false; this._stepTop(); }   // measure: frame budget
  }
  /** @internal Advance the top job by one step */
  _stepTop() { this._step(this.heap[0]); }
  /** @internal */
  _step(j) {
    const t0 = performance.now();   // measure: step time
    try {
      if (!j.it) {
        const r = typeof j.work === 'function' ? j.work() : j.work;
        if (typeof r?.next !== 'function') { this._finish(j, r); return; }
        j.it = r;
      }
      const s = j.it.next();
      if (s.done) this._finish(j, s.value);
    } catch (err) { this._fail(j, err); }
    const ms = performance.now() - t0;   // measure: step time
    if (ms > this.slowStepMs && this.engine.ready) warnOnce(coded('jobs-slow', fmt(STRINGS.slow, { who: jobName(j), ms: Math.round(ms), max: this.slowStepMs })));
  }
  /** @internal */
  _fail(j, err) { this._removeJob(j); j.failed = true; j.error = err; j.rej(err); }
  /** @internal */
  _finish(j, v) {
    if (j.ticket && typeof v?.then === 'function') throw codedError('engine-misuse', STRINGS.async);
    this._removeJob(j); this.doneCount++; j.finished = true; j.value = v; j.ticket?.resolve(v); j.res(v);
  }

  // ---------- binary heap ----------
  /** @internal */
  _push(j) {
    this.heap.push(j);
    this._siftUp(this.heap.length - 1);
  }
  /** @internal Remove a job (usually the top; not the top if a higher-priority job was added mid-run) */
  _removeJob(j) {
    const h = this.heap, i = h.indexOf(j);
    if (i < 0) return;
    const last = h.pop();
    if (i === h.length) return;
    h[i] = last;
    this._siftDown(i); this._siftUp(i);
  }
  /** @internal */
  _siftUp(i) {
    const h = this.heap;
    while (i > 0) { const p = (i - 1) >> 1; if (!before(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; }
  }
  /** @internal */
  _siftDown(i) {
    const h = this.heap, n = h.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && before(h[l], h[m])) m = l;
      if (r < n && before(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]]; i = m;
    }
  }
}
