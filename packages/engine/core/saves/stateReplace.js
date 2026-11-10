// Replacing the game state is one transaction, owned here. saves.apply, saves.load, session.newGame / load / quit all enter through run(), so:
//   - One at a time. A request made while another runs waits its turn, in order, and only then reads its save and takes its rollback point:
//     two overlapping loads left a mix of both saves (X from one, Y from the other), and the second one's rollback point was the first one's half.
//     A request with a key joins the last one in line when the key is the same (a double-clicked Restart). Nothing is refused for being busy.
//   - Idle means now. run() calls fn synchronously and a job that returns a plain value ends before run() returns. A save whose parts are all
//     synchronous is applied on the line after apply, and replays rely on apply, step, apply, step in one stretch of code. So when only its afterLoad
//     is left, which starts a microtask later, the job is paused: the marker is off (no click or net message can arrive before a microtask, only
//     the caller's next lines) and a direct apply / load on those lines runs at once and takes over. The older job's hooks are then skipped:
//     they would rebuild for a state that is gone, and the newer job's hooks rebuild for the one that stayed. Not past something already in line:
//     apply(x); save('s'); apply(y) would store y.
//     A late part's job (adoptPart) adds to the state, it replaces nothing, so paused it holds nobody back: a read (a save, a content commit) on those lines goes
//     at once, and another late part takes over, its afterLoad round rebuilding for both. Held, use(content()); content.load(...) or a failed replaces putting
//     its module back would leave the next line without its data until a microtask later; nothing it skips is half loaded (paused means every part is in).
//   - One marker. `replacing` is true from reading the save through its parts, afterLoad and any rollback; begin() / end() bracket that span
//     (saveApply.js). Ops read it (opsFail.js) instead of knowing freeze names, so a game's own freeze never looks like a load and a load never
//     looks like a menu. A session's turn is longer than the marker on purpose: session:end listeners (a skipped cutscene's last steps) and
//     session:start listeners still run ops, while the turn stays taken so the next replacement cannot cut in between.
//   - One read rule. saves.save asks through read(): a save collected while parts are half loaded would mix two states, so it waits for every replacement
//     already in line. It never takes over a paused job (that job's hooks must still run) and holds the turn only for the collect, not for the disk write.
//   - One freeze. hold() stops fixed steps while the replacement waits on something; it is the only freeze a load takes, and end() drops it.
//   - One identity, passed by hand. A part's load(data, turn) and a module's afterLoad(engine, turn) get the turn of their replacement, and level.load / content.load take it back as { turn }:
//     that call belongs to the replacement and goes at once, before or after any await. Nothing else can say so. A browser has no async context, so what runs after an await looks like a click;
//     a marker held across the await would let the click in as well. No turn, or one that ended, is an outside request and waits in line, however it was made. The cost is the one a caller
//     can forget: an awaited request without its turn waits for itself. Dev names it when something stalls in line (save-nested). The rule is the same before and after the first await, so
//     a load() does not start hanging on the day it gains an await.
// Async rebuild work needs no other stamp: a part's load() and every afterLoad settle inside their turn (saveApply.js waits for all of them, even when one failed), and a late part
// loads in a turn of its own, whole (adoptPart). What a module starts and does not return (a background job) is engine.commits' case: invalidate() drops it unless its valid() says otherwise.
//   - One word for a change that takes several steps. A door trip or a cutscene holds a stateTurn: between its first and last line the world is between two states no load could continue from, so
//     an autosave waits for it to end. Only the autosave: a save the game asks for itself picked its moment, and may be awaited inside that very trip. A replacement does not wait either, a new game
//     is how a cutscene ends. The owners call stateTurn; this file does not know who they are.
//   - A level change waits for a replacement already in line (whenTurnFree) and does not take the turn: two doors in a row still overtake each other, and a save made while a file downloads
//     stores the level that stands, whole. What a part's load() or afterLoad asks with its turn goes at once: it is inside the turn and cannot wait for itself.
//   - One word for "the state was replaced". A job that changed the state emits the internal state:replaced { undone } as it ends, last, whichever door it came through, so derived state listens to
//     that alone. undone: a failed load put the old state back. A job that refused before changing anything says nothing; a job taken over is announced by the one that took over.
//   - One way back. A failed pack that has to wait for its old level holds everything in line and gameplay until the old state is whole again (restoring): a save or a load in the gap would
//     read or write half of it. Nothing about the saved state changed, so no state:replaced.
// A new replacement has no place inside a running one: it starts after, so a load() may ask for it and not await it (or ask from a save:loaded or session:start listener).
import { DEV, warnOnce } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';

const NESTED = "something has waited long behind a state replacement that has not ended. If it was asked inside a save part's load() or a module's afterLoad and awaited, it waits for itself: "
  + 'pass the turn they get to level.load / content.load ({ turn }) and it goes at once; a new saves.apply / load / save or session.newGame / load / quit starts after the running one, so do '
  + 'not await it there, or ask from a save:loaded or session:start listener';
const STALL_MS = 3000;   // a dev hint only: a slow download behind a load is told too, and the words say "if"
const FREEZE = 'threedog:state-replace';   // a namespaced owner: a game's own freeze('load') must not be released by (or release) the engine's

/** @internal One state replacement at a time, and the marker that says one is under way (top of the file) */
export class StateReplace {
  constructor(engine) {
    this.engine = engine;
    /** The job holding the turn, or null */ this.job = null;
    /** Jobs waiting for the turn, oldest first */ this.waiting = [];
    /** When the turn last changed hands (performance.now) */ this.moved = 0;
    /** True from reading a save until its load or rollback ended */ this.replacing = false;
    /** The freeze while the replacement waits on something */ this.freeze = null;
    /** How many stateTurns are open */ this.turns = 0;
    /** Restore jobs (restoring) not ended yet: while any is, end() leaves the marker and the freeze on */ this.restores = 0;
    /** Which saved state the game holds: moves when a load starts changing parts, goes back when it fails. A level change does not move it, so what a level load's caller asked next survives (commits.epoch moves for both) */ this.generation = 0;
  }

  /**
   * Run fn when its turn comes: at once when idle, else after the jobs before it. Returns what fn returned, as a Promise.
   * @param {string | null} key  same key as the last job in line: join it instead of running again
   * @param {() => any} fn
   * @param {{ behind?: boolean, whole?: boolean, turn?: object }} [o]  behind: a late part (adoptPart), fn adds to the state the running job leaves: it takes over only a paused late part's job (_passable).
   *   whole: the job is one request from its first line to its last (a scene request, applyState), so it never pauses for a direct apply to take over.
   *   turn: the turn of the request asking. When it is the running one, fn is part of that request and runs now, inside it: in line it would wait for itself
   * @returns {Promise<any>}
   */
  run(key, fn, { behind = false, whole = false, turn } = {}) {
    if (turn && this.job?.turn === turn) { try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); } }
    const last = this.waiting.at(-1) ?? this.job;
    if (key && last?.key === key) return last.done;
    const job = { key, fn, done: null, settle: null, paused: false, whole, behind, turn: Object.freeze({}) };
    job.done = new Promise(res => { job.settle = res; });
    if (this.job && (behind && !this._passable() || !this.job.paused || this.waiting.length)) this._line(job); else this._start(job);
    return job.done;
  }

  /**
   * Read the whole state when no replacement is under way or waiting: at once when idle, else in line (top of the file).
   * @param {() => Promise<any>} fn  its collect runs in the turn; what it returns settles outside it
   * @returns {Promise<any>}
   */
  read(fn) {
    if (!this.job || this._passable()) return fn();
    let give;
    const job = { key: null, fn: () => { try { give(fn()); } catch (err) { give(Promise.reject(err)); } }, done: new Promise(res => { give = res; }), settle() {}, paused: false };   // a throw reaches the one who asked, and the line goes on
    this._line(job);
    return job.done;
  }

  /**
   * A failed pack is putting the old state back: gameplay and everything in line wait until p settled (top of the file). Next in line, so the transaction it ends is not overtaken.
   * @param {Promise<any>} p
   */
  restoring(p) {
    // the job ends itself once p settled and its turn came (_start's next). Asked while another job runs (an atomic op inside applyState), that job's own end()
    // must not drop the marker, and nothing else would raise it again: restores keeps it on until this one ends
    const job = { key: null, fn: () => p, done: p, settle() {}, paused: false, restoring: true };
    this.restores++; this.begin(); this.hold();
    if (this.job) this.waiting.unshift(job); else this._start(job);
  }

  /**
   * Wait in line. An awaited request a load() made without its turn waits for itself, and nothing can tell it from a click: dev says so when it stalls, and with no sign of
   * life for loading.timeoutMs the job fails, in every build. Life is the line moving or a load task's phase: a replacement awaiting something no task reports shows none.
   */
  _line(job) {
    const L = this.engine.loading, since = performance.now();   // measure: the limit is a wall clock, a stepped or frozen engine runs no frames
    this.waiting.push(job);
    if (DEV) setTimeout(() => { if (this.waiting.includes(job)) warnOnce(coded('save-nested', NESTED), 'save-nested'); }, STALL_MS);   // debug: a dev hint on real time, gameplay never reads it
    job.done = L._limit(job.done, () => this.waiting.includes(job) ? Math.max(since, this.moved, ...[...L.tasks.values()].map(t => t.at)) : null, () => {
      this.waiting.splice(this.waiting.indexOf(job), 1);
      return codedError('save-nested', NESTED);
    });
  }

  /** Start a job; its turn ends when fn's result settled, whichever way (a failed job must not block the next) */
  _start(job) {
    this.job = job; this.moved = performance.now();   // measure: a sign of life for those in line
    const next = () => {
      if (this.job !== job) return;   // not its turn any more: taken over
      if (job.restoring) { this.restores--; this.end(); }   // the old state is whole again: gameplay and the line go on
      // the notice is still this job's turn: a load asked in a state:replaced listener goes in line. Were the turn cleared first, that load would start at once and the
      // job in line beside it right after (review l2 #1). Not paused either: a paused job would let it take over and skip the line
      job.paused = false;
      if (job.changed) this.engine.events.emit('state:replaced', { undone: job.changed === 'undone' });
      if (this.job !== job) return;
      this.job = null;
      this._next();
    };
    let out;
    try { out = job.fn(); } catch (err) { out = Promise.reject(err); }
    if (typeof out?.then === 'function') out.then(next, next);
    else next();
    job.settle(out);
  }
  /** A paused late part's job with nobody in line: what comes next does not wait for its afterLoad round (top of the file) */
  _passable() { return !!this.job?.paused && this.job.behind && !this.waiting.length; }
  /** The one place the next job starts: only when no job holds the turn, so a job ending inside another's notice cannot start a second one beside it */
  _next() {
    if (this.job) return;
    const n = this.waiting.shift();
    if (n) this._start(n);
  }

  /** The state starts being replaced (the marker's span: top of the file) */
  begin() { this.replacing = true; }
  /** This turn's job changed the state, or (undone) put the old one back: state:replaced says so when it ends */
  changed(undone = false) { this.job.changed = undone ? 'undone' : true; }
  /** Only a microtask's wait is left: a direct apply / load may take over until resume (top of the file). A session's job has more to do after its
   *  apply, and a job already holding the freeze is mid-load, so neither pauses. Returns the job, for resume */
  pause() {
    const job = this.job;
    if (!job.key && !job.whole && !this.freeze) { job.paused = true; this.replacing = false; }
    return job;
  }
  /** The wait ended: false when a newer job took over, else the marker is back on */
  resume(job) {
    if (this.job !== job) return false;
    job.paused = false; this.replacing = true;
    return true;
  }
  /** The job whose apply this is ended: the marker goes off, unless a newer job took over and owns it now */
  endOf(job) { if (this.job === job) this.end(); }
  /** The replacement waits on something: stop fixed steps until end() */
  hold() { this.freeze ??= this.engine.freeze(FREEZE); }
  /** The load or its rollback ended */
  end() { if (this.restores) return; this.replacing = false; this.freeze?.remove(); this.freeze = null; }
}

/**
 * @internal A change of several steps is under way until the handle's remove() (top of the file).
 * @param {any} e
 * @returns {{ remove(): void }}
 */
export function stateTurn(e) {
  const q = e.saves._replace;
  let open = true;
  q.turns++;
  return { remove() { if (open) { open = false; q.turns--; } } };
}

/**
 * @internal A failed pack is putting the old state back: everything in line and gameplay wait until p settled (top of the file).
 * @param {any} e
 * @param {Promise<any>} p
 */
export function whileRestoring(e, p) { e.saves._replace.restoring(p); }

/**
 * @internal Run fn behind the replacements in line (at once when none is), or at once when turn is the one running (top of the file).
 * @template T
 * @param {any} e
 * @param {() => T | Promise<T>} fn
 * @param {object} [turn]  what the caller's load() or afterLoad was given
 * @returns {T | Promise<T>}
 */
export function whenTurnFree(e, fn, turn) { return liveTurn(e, turn) ? fn() : e.saves._replace.read(fn); }

/** @internal Is this the turn of the replacement running now? A turn kept after its load ended is an outside request, like no turn at all @param {any} e @param {object} [turn] */
export const liveTurn = (e, turn) => !!turn && e.saves._replace.job?.turn === turn;
