// Timeline: cutscenes, camera moves, scripted movement. Runs a list of steps in order and returns a Promise.
//
//   await engine.timeline.play([
//     { camera: { to: { position: [10, 6, 10], lookAt: [0, 1, 0] }, duration: 2, ease: 'inOutSine', fov: 45 } },
//     { parallel: [                                          // run at the same time; continue only when all finish
//       { tween: { target: door, to: { 'rotation.y': 1.6 }, duration: 1, ease: 'outBack' } },
//       { path: { object: npc, points: [[0,0,0], [4,0,2], [8,0,0]], duration: 3, lookAhead: 0.05, ground: true } },
//     ] },
//     { say: { speaker: '老渔夫', text: '你来了。' } },      // needs the dialogue module; waits for the dialogue to end
//     { say: { speaker: '路人', text: '看那边！', channel: 'bubble', at: npc.root } },   // a bubble over the speaker (input stays free); waits for it too
//     { wait: 0.5 },                                         // wait 0.5 seconds
//     { waitFor: 'quest:done' },                             // wait for an event
//     { do: engine => engine.events.emit('door:open') },     // run code (may be async)
//     { fade: 1 }, { fade: 0.5, to: 0 },                     // fade the screen to black over 1 second, then back in over 0.5 s (fadeScreen)
//   ], { skippable: true, letterbox: true, actors: [engine.player, npc] });
//
// Options: skippable (default true); letterbox black bars top and bottom (default false); actors: the characters the cutscene drives (default: the
// player when there is one; [] leaves everyone free, e.g. a bubble scene the player walks through)
// Control (core/ops/control.js): the run takes each actor's control slot on layer 'cutscene' (owner 'timeline'), and a path step takes its character too.
// What they were doing pauses, not cancels: the player's keys, a walkTo, an NPC's schedule carry on when the run ends or is skipped. While the
// player is an actor the 'cutscene' input context is up, so gameplay keys do nothing. Every run is one owner ('timeline'), counted per character,
// so two overlapping cutscenes never conflict with each other; the slot goes back when the last run using that character ends.
// Skip: the basic cancel key (Esc / gamepad B; the cutscene is in the UI focus stack, cancel goes only to the top; see ui/Focus.js), the action 'skip'
// (context 'cutscene', no key of its own: presets.bindings.cutsceneSkip binds Backspace), or click the hint on the letterbox.
// While frozen (engine.freeze / flow 'paused') wait, tweens, camera and paths do not advance; they resume after unfreezing.
//   On skip all running tweens jump to their end and the remaining steps finish instantly (do steps still run, so state matches a normal playthrough).
// Camera takeover: a camera step takes the camera (engine.takeCamera, see camera/common.js) and releases its claim and restores the view after the whole run; the camera
// module then resumes. While a newer holder has the camera, or something above the cutscene has a path's character, the step keeps its time and writes nothing (shots.js).
//   To hand the camera back midway: { camera: { release: true } }
// General tween (usable anywhere in a game): await engine.timeline.tween(mesh, { 'position.y': 2, 'material.opacity': 0 }, { duration: 1, ease: 'outCubic' })
// Ending: a run has one, set once: 'finished', 'skipped', 'dropped' (its state is gone: a load, a new game, the engine) or 'failed' (a step threw). play() resolves with
// { ending, error? }, timeline:end carries the same, describe counts them. Dropped and failed run nothing more and give the screen back; a run that ends in a step of its own
// choosing keeps the fade it asked for. What a run holds goes back in the one finally of play().
// Events: timeline:start, timeline:end { id, ending, error? }
// Scenario param cutscene (engine.applyState / URL ?cutscene=skip): 'skip' skips the playing cutscene and all later ones, 'keep' restores normal behavior.
import { Tweener } from './Tween.js';
import { fadeScreen, uiFocus } from '../../ui/UI.js';
import { cameraStep, pathStep, releaseCamera } from './shots.js';
import { buildLetterbox } from './letterbox.js';

import { readParams, keysSchema } from '../../core/base/params.js';   // isOptions: a step part can also be a shot name, a text or a point list
import { isOptions } from '../../core/base/util.js';
import { warnOnce } from '../../core/base/validate.js';
const TWEEN_KEYS = ['duration', 'ease'];
import { coded, codedError } from '../../core/base/errorHints.js';
import { reportError } from '../../core/base/errors.js';
import { stateTurn } from '../../core/saves/stateReplace.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { Ease } from '../../types/common' */
/** @import { TimelineStep, TimelinePlayOptions, TimelineOptions, TweenTo, TweenPromise } from '../../types/gameplay' */

// Keys recognized by steps and their params
const STEP_KEYS = {
  step: ['parallel', 'sequence', 'wait', 'waitFor', 'timeout', 'do', 'tween', 'camera', 'path', 'say', 'fade', 'to'],
  tween: ['target', 'to', 'duration', 'ease'],
  camera: ['from', 'to', 'duration', 'ease', 'fov', 'release'],
  path: ['object', 'points', 'duration', 'ease', 'lookAhead', 'ground', 'closed', 'curve', 'tension', 'upright'],
  say: ['speaker', 'text', 'nodes', 'node', 'channel', 'at', 'seconds'],
};
const SHOT_KEYS = ['position', 'lookAt', 'fov'];
function checkStep(s) {
  readParams('timeline step', keysSchema(STEP_KEYS.step), s);
  for (const k of ['tween', 'camera', 'path', 'say']) if (isOptions(s[k])) readParams(`timeline ${k}`, keysSchema(STEP_KEYS[k]), s[k]);
  if (s.camera) for (const k of ['from', 'to']) if (isOptions(s.camera[k])) readParams(`timeline camera.${k}`, keysSchema(SHOT_KEYS), s.camera[k]);
}

/** engine.timeline */
export class Timeline {
  /** @internal */
  constructor(engine, ctx) {
    /** @internal */ this.engine = engine;
    /** @internal the module's ctx.track (letterbox.js listens through it) */ this._track = ctx.track;
    /** @internal the module's ctx.control: holds taken through it go back when the timeline module goes */ this._ctl = ctx.control;
    /** @internal character id -> { h (control handle), n (runs using it) } */ this._held = new Map();
    /** @internal character id -> path steps moving it now (shots.js): the hold's step then leaves the body alone */ this._pathing = new Map();
    /** @internal */ this._tweener = new Tweener();
    /** @internal */ this.runs = new Set();
    /** @internal numbers the runs of this engine (timeline:start / timeline:end id) */ this._runSeq = 0;
    /** @internal how runs ended, and the last failure: describe */ this._endings = { finished: 0, skipped: 0, dropped: 0, failed: 0 }; this._failure = null;
    /** Skip every cutscene immediately (set by scenario param cutscene=skip) @type {boolean} @experimental */
    this.skipAll = false;
    ctx.track(engine.input.define('skip', { context: 'cutscene', label: 'timeline.skipAction', optional: true, owner: 'timeline' }));   // cancel skips anyway
    buildLetterbox(this);
  }

  /**
   * Whether a cutscene is playing
   * @returns {boolean}
   * @experimental
   */
  get playing() { return this.runs.size > 0; }

  /**
   * General tween (the only entry point for tweens in the engine): await engine.timeline.tween(mesh, { 'position.y': 2 }, { duration: 1, ease: 'outCubic' }); duration in seconds (default 1), ease default 'inOutCubic'; tween(mesh, to, 1) throws in dev.
   * Returns a Promise (with finish() / remove()); a write that throws ends the tween and rejects it
   * @param {any} target
   * @param {TweenTo} to
   * @param {{ duration?: number, ease?: Ease }} [opts]
   * @returns {TweenPromise}
   */
  tween(target, to, opts) {
    const { duration = 1, ease = 'inOutCubic' } = readParams('timeline.tween()', keysSchema(TWEEN_KEYS), opts);
    return this._tweener.tween(target, to, duration, ease);
  }

  /**
   * Play a timeline; resolves with { ending, error? } when it ends: 'finished', 'skipped', 'dropped' (a load, a new game or dispose took its state) or 'failed' (a step threw; error says what)
   * @param {TimelineStep | TimelineStep[]} steps
   * @param {TimelinePlayOptions} [opts]
   * @returns {Promise<{ ending: 'finished' | 'skipped' | 'dropped' | 'failed', error?: string }>}
   */
  async play(steps, opts = {}) {
    readParams('timeline.play()', keysSchema(['skippable', 'letterbox', 'actors']), opts);
    const { skippable = true, letterbox = false } = opts, e = this.engine;
    const actors = opts.actors ?? (e.player ? [e.player] : []);
    if (!Array.isArray(actors)) throw codedError('module-params', `timeline.play(steps, { actors }): actors is a list of characters (or ids) the cutscene drives, e.g. [engine.player, guard]; [] drives nobody. Got ${typeof actors}`);
    const run = { id: ++this._runSeq, skippable, letterbox, ending: null, error: null, cancels: new Set(), cam: null, actors: new Set(), ctx: null, line: false, faded: false, duringLoad: e.saves.replacing };
    // a bad or remote actor throws: the ones already taken go back, or the player stays in the cutscene with no run left to end it
    try { for (const a of actors) this._take(run, a); } catch (err) { this._give(run); throw err; }
    // enter the UI focus stack: skippable cutscenes skip on Esc, unskippable ones swallow Esc (so it does not open the settings menu)
    run.focus = uiFocus(e).push('timeline', { cancel: skippable ? () => this.skip(run) : null });
    this.runs.add(run);
    this._refreshUI();
    e.events.emit('timeline:start', { id: run.id });
    if (this.skipAll && skippable) this.skip(run);
    const turn = stateTurn(e);   // no load could continue a run from half way: an autosave waits for its end
    try {
      await this._step(steps, run);
      run.ending ??= 'finished';
    } catch (err) {
      reportError(this.engine, err, 'timeline step', { soft: true });   // a step that threw ends this run; the game carries on
      run.error = err?.message ?? String(err);
      this._stop(run, 'failed');   // a parallel branch beside the throw is still waiting
    } finally {
      if (run.faded && gone(run) && ![...this.runs].some(r => r !== run && r.faded)) fadeScreen(e, 0, { seconds: 0 });   // the steps that would have faded back in will not run
      turn.remove();
      releaseCamera(this, run);
      run.focus.remove();
      this._give(run);
      this.runs.delete(run);
      this._refreshUI();
      this._endings[run.ending]++;
      if (run.error) this._failure = run.error;
      e.events.emit('timeline:end', { id: run.id, ...answer(run) });
    }
    return answer(run);
  }

  /**
   * Skip all (or one) playing timelines
   * @param {any} [run]
   * @returns {void}
   */
  skip(run) {
    for (const r of run ? [run] : [...this.runs]) if (!r.ending) this._stop(r, 'skipped');
  }

  /** @internal The one way a run stops early. The ending is set once; only a skip can still turn into a harder one, because it goes on running the steps left */
  _stop(r, ending) {
    if (r.ending && r.ending !== 'skipped') return;
    r.ending = ending;
    // only a skip completes the tweens (the playthrough's end state); a drop or a failure leaves the values where they are
    if (ending === 'skipped') this._tweener.finishAll(r); else this._tweener.cancelAll(r);
    for (const c of [...r.cancels]) c();
  }

  /** @internal The state a run belongs to is gone: it ends without its remaining steps, whose effects would land in what replaced it. keep: a run a load started stays */
  _drop(keep = () => false) {
    for (const r of [...this.runs]) if (!keep(r)) this._stop(r, 'dropped');
  }

  /**
   * Update every frame (called by the module each frame)
   * @param {number} dt
   * @returns {void}
   * @internal
   */
  frame(dt) {
    if (this.engine.frozen) return;   // wait and tweens do not advance while frozen, and a key pressed there is not for the cutscene
    this._tweener.update(dt);
    const inp = this.engine.input;
    // skip keys other than Esc (e.g. Backspace): Esc is already dispatched by the UI focus stack, so do not handle it twice
    if (!this.runs.size || !inp.pressedRaw('skip') || inp.pressedRaw('cancel')) return;
    // same reach as Esc: the top of the UI focus stack only (the newest run, or the run whose line is showing), so a key typed in a window above the
    // cutscene stays in that window; the first frame of a run does not count
    const top = uiFocus(this.engine).top, runs = [...this.runs];
    const r = top === 'timeline' ? runs.at(-1) : top === 'dialogue' ? runs.findLast(x => x.line) : null;
    if (r?.skippable && !r.focus.fresh) this.skip(r);
  }

  // ---------- Control of the characters in the cutscene ----------
  /** @internal hold one character for run (layer 'cutscene'); a path step calls it for its character. Throws control-net for a remote one */
  _take(run, who) {
    const id = typeof who === 'string' ? who : who?.id;
    if (!id) throw codedError('module-params', `timeline actors: a character, an NPC handle or an id, got ${String(who)}`);
    if (run.actors.has(id)) return;
    let a = this._held.get(id);
    // the hold's step: stand still (move(0, 0): gravity, ground, the idle pose go on) unless a path step is placing it, then no move at all
    // (false), so the mover does not pull the body back from where the path put it
    if (!a) a = { h: this._ctl.take(who, { owner: 'timeline', layer: 'cutscene', step: () => (this._pathing.get(id) ? false : null) }), n: 0 };
    this._held.set(id, a);
    a.n++; run.actors.add(id);
    if (id === 'player' && !run.ctx) run.ctx = this.engine.input.push('cutscene');   // the player is driven by the cutscene: gameplay keys rest
  }
  /** @internal run ended: hand back every character it held (the last run using one gives its slot back) */
  _give(run) {
    for (const id of run.actors) { const a = this._held.get(id); if (a && --a.n <= 0) { a.h.remove(); this._held.delete(id); } }
    run.actors.clear();
    run.ctx?.remove(); run.ctx = null;
  }

  // ---------- Steps ----------
  /** @internal */
  async _step(s, run) {
    if (s == null || gone(run)) return;
    if (Array.isArray(s)) { for (const x of s) await this._step(x, run); return; }
    if (typeof s === 'function') { await s(this.engine, run); return; }
    checkStep(s);
    if (s.parallel) { await Promise.all(s.parallel.map(x => this._step(x, run))); return; }
    if (s.sequence) { await this._step(s.sequence, run); return; }
    if ('wait' in s) { await this._wait(run, s.wait); return; }
    if (s.waitFor) { await this._waitFor(s.waitFor, s.timeout, run); return; }
    if (s.do) { await s.do(this.engine, run); return; }
    if (s.tween) { const t = s.tween; await this._tween(run, t.target, t.to, t.duration ?? 1, t.ease ?? 'inOutCubic'); return; }
    if (s.camera) { await cameraStep(this, s.camera, run); return; }
    if (s.path) { await pathStep(this, s.path, run); return; }
    if (s.say) { await this._say(s.say, run); return; }
    if ('fade' in s) { await this._fade(s.fade, s.to ?? 1, run); return; }
  }

  /** Full-screen fade: jumps to the target when skipped. faded: the run holds the screen, so an ending that drops the later steps gives it back @internal */
  async _fade(seconds, to, run) {
    const now = () => fadeScreen(this.engine, to, { seconds: 0 });
    run.faded = to > 0;
    if (run.ending) return now();
    run.cancels.add(now);
    await fadeScreen(this.engine, to, { seconds });
    run.cancels.delete(now);
  }

  /**
   * { wait: s }: a timer on the 'real' view of engine.time, so it ends inside a fixed step (game logic only in fixed steps) and counts real
   * seconds whatever the frame rate; before it rode the frame tweener, so the step after a wait ran between frames. Skip / cancel resolve it now
   * @internal
   */
  _wait(run, seconds) {
    if (run.ending || !(seconds > 0)) return Promise.resolve();
    return new Promise(res => {
      const done = () => { h.remove(); run.cancels.delete(done); res(); };
      const h = this.engine.clock.after(seconds, done, { channel: 'real' });
      run.cancels.add(done);
    });
  }
  /** @internal */
  _timed(run, o) { return this._tweener.run({ ...o, duration: run.ending ? 0 : o.duration, group: run }); }
  /** @internal */
  _tween(run, target, to, d, ease) { return this._tweener.tween(target, to, run.ending ? 0 : d, ease, run); }

  /** @internal */
  _waitFor(name, timeout, run) {
    if (run.ending) return Promise.resolve();
    return new Promise(res => {
      let timer = null, over = false;
      const done = () => { if (over) return; over = true; sub.remove(); timer?.remove(); run.cancels.delete(done); res(); };
      const sub = this.engine.events.once(name, done);
      run.cancels.add(done);
      if (timeout) timer = this.engine.clock.after(timeout, done, { channel: 'real' });   // real seconds, ends in a fixed step like { wait }
    });
  }

  /** Line: { speaker, text, node?, channel?: 'main' | 'bubble', at?, seconds? }. Needs the dialogue module; skipped with a warning if not installed @internal */
  _say(s, run) {
    const e = this.engine, d = e.dialogue;
    if (!d) { warnOnce(coded('module-needs', '[timeline] the say step was skipped: it needs dialogue(); add it to engine.use(...)')); return Promise.resolve(); }
    if (run.ending) return Promise.resolve();
    // the line is on top of the focus stack: Esc still skips the whole cutscene
    const said = d.say(s.nodes || s.text, { speaker: s.speaker, node: s.node || 'start', channel: s.channel, at: s.at, seconds: s.seconds, onCancel: run.skippable ? () => this.skip(run) : null });
    run.line = s.channel !== 'bubble';   // a main line sits above the run in the focus stack; a bubble takes no focus
    return new Promise(done => {
      // skipping the cutscene closes this line; it also settles the step when the line was dropped without ending (a new playthrough)
      const cancel = () => { said.remove(); run.line = false; done(); };   // remove(): the say() handle of the dialogue contract, either channel
      run.cancels.add(cancel);
      said.then(() => { run.cancels.delete(cancel); run.line = false; done(); });
    });
  }

  // ---------- Letterbox ----------
  /** @internal */
  _refreshUI() {
    const runs = [...this.runs], on = runs.some(r => r.letterbox), canSkip = runs.some(r => r.letterbox && r.skippable && !r.ending);
    this.top.classList.toggle('is-on', on); this.bottom.classList.toggle('is-on', on);
    this.skipBtn.textContent = this.engine.t('timeline.skip');
    this.skipBtn.classList.toggle('is-on', canSkip);
    this.skipBtn.hidden = !canSkip;
  }
}

/** The run's state is gone, or it broke: the steps left must not run. A skip does run them, so what it leaves matches a playthrough */
const gone = run => run.ending === 'dropped' || run.ending === 'failed';
/** What a run says when it ends, to play() and timeline:end alike */
const answer = run => ({ ending: run.ending, ...(run.error && { error: run.error }) });

const STRINGS = {
  'zh-CN': { 'module.timeline': '时间轴', 'timeline.skip': '{key:cancel} 跳过', 'timeline.skipAction': '跳过过场' },
  en: { 'module.timeline': 'timeline', 'timeline.skip': '{key:cancel} Skip', 'timeline.skipAction': 'Skip cutscene' },
};

const TIMELINE_PARAMS = keysSchema([]);

/**
 * Timeline (cutscenes, tweens) -> engine.timeline.
 * timeline() (cancel skips, dispatched by the UI focus stack; bind the 'skip' action for another key, e.g. presets.bindings.cutsceneSkip)
 * Optional dependency: dialogue (say step). The camera module cooperates with engine.cameraOverride automatically.
 * @param {TimelineOptions} [opts]
 * @returns {ModuleDef<Timeline>}
 */
export function timeline(opts = {}) {
  readParams('timeline', TIMELINE_PARAMS, opts);
  let t = null;
  return {
    name: 'timeline', skipKind: 'none', type: 'rules', params: TIMELINE_PARAMS, options: opts, label: 'Timeline', stage: 'control', before: ['cameraRig'], optional: ['dialogue'],   // before the camera, so the takeover applies on the same frame
    install(e, ctx) {
      e.i18n.add(STRINGS); t = new Timeline(e, ctx);
      // a running cutscene ends with its playthrough (session waits one macrotask for its steps to settle)
      ctx.track(e.events.on('session:end', () => t._drop()));
      return t;
    },
    frame(dt) { t.frame(dt); },
    afterLoad() { t._drop(r => r.duringLoad); },
    // unloaded mid-cutscene: every run ends through its finally (camera, focus, actors go back); nothing else would, the frame hook is gone
    dispose() { t._drop(); t._tweener.cancelAll(); },   // also the tweens started with timeline.tween(): no run owns them
    // scenario param cutscene: 'skip' | 'keep'
    stateKeys: ['cutscene'],
    applyState(e, p) {
      if (p.cutscene === undefined) return;
      t.skipAll = p.cutscene === 'skip';
      if (t.skipAll) t.skip();
    },
    describe(e, ctx) {
      const runs = [...t.runs];
      if (runs.length || t._failure) ctx.out.cutscene = { count: runs.length, skippable: runs.some(r => r.skippable && !r.ending), letterbox: runs.some(r => r.letterbox), actors: [...t._held.keys()], endings: { ...t._endings }, ...(t._failure && { failure: t._failure }) };
    },
  };
}

export const handRolled = [{ kind: 'tween', seen: 'a tween of its own', use: 'await engine.timeline.tween(target, to, { duration, ease }): on game time, stops with pause (recipe 07)', quiet: /\b(engine|e|eng|ctx)\.timeline\b/, code: /\b(?:elapsed|time|timer|age|t)\s*\/\s*(?:\w+\.)?(?:dur|duration)\b/i, orRaw: /\bfrom\s+['"](?:gsap|@tweenjs\/tween\.js|tween\.js|animejs)['"]/ }];
