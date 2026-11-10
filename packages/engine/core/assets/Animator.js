// Animation state machine: assets.animate(model, config) returns it. Native objects below.
//   const anim = engine.assets.animate(model, {
//     states: { idle: { clip: 'Idle' }, move: { blend: [{ clip: 'Walk', at: 1.5 }, { clip: 'Run', at: 6 }], param: 'speed' },
//               wave: { clip: 'Wave', loop: false, then: 'idle', lock: true },
//               attack: { clip: 'Sword_Slash', loop: false, timing: [[0, 0], [0.16, 0.35], [0.28, 0.6], [0.62, 1]] } },
//     transitions: { '*>idle': 0.3 },
//   });
//   anim.set('speed', 3); anim.go('move'); anim.action('wave');
//   anim.sync('attack', fighter.t); ... anim.sync(null);   // gameplay time drives the pose; null hands control back
// States are the mapping: game names (idle / attack / hurt) on the left, whatever the asset calls the clip on the right.
// The mapping can live in the asset manifest (models: { hero: { url, animation: { states } } }), merged under the code's config, so a new model
// never touches game code. anim.check([...actions]) lists what the game would miss.
// A clip name also matches the part after the last '|' ('Idle' finds 'CharacterArmature|Idle').
// Weights are managed here: each state has a fading weight, blend trees split it by parameter; all action weights sum to 1.
// A one-shot action emits anim:end { root, state } when done, then moves to its `then`. Native objects: mixer, actions (clip name -> AnimationAction).
// Rule: animation is presentation; gameplay timing must not read it. The mixer advances per frame (dropped frames, step's frameEvery or a disposed model all skew it),
// so hit windows, stun and cooldowns count in fixed steps, and sync(state, t) is how that gameplay time reaches the pose: the clip never runs ahead or ends by itself.
import * as THREE from 'three';
import { warnOnce, warnMissing, missingText } from '../base/validate.js';
import { readParams, keysSchema } from '../base/params.js';
import { isOptions } from '../base/util.js';
import { addAim, addFeet, ikRestore, ikRun, ikClear } from './ik.js';
const GO_KEYS = ['fade'];

// Config keys: a typo (loops: false, state: {...}) would silently play the wrong thing, so both levels are checked like any other options
const CONFIG_KEYS = ['fade', 'states', 'transitions', 'params'];
const STATE_KEYS = ['clip', 'blend', 'param', 'sync', 'loop', 'then', 'lock', 'timing'];

/**
 * Find a clip by exact name, else by the part after the last '|' ('Idle' finds 'CharacterArmature|Idle').
 * @example findClip(model.animations, 'Sword_Slash')
 */
export function findClip(clips, name) {
  return THREE.AnimationClip.findByName(clips, name) ?? clips.find(c => c.name.slice(c.name.lastIndexOf('|') + 1) === name) ?? null;
}
const short = n => n.slice(n.lastIndexOf('|') + 1);
const r3 = v => Math.round(v * 1000) / 1000;

const ONE = Object.freeze([1]);   // the blend split of a plain state

export class Animator {
  /** mappedIn (from Assets.animate): { label, states } when part of the mapping came from the manifest, so fix texts point at the data, not at code */
  constructor(engine, root, config = {}, mappedIn = null) {
    // config is the code's options merged over the manifest mapping, so name both places a typo can be in
    readParams(mappedIn ? `assets.animate() / ${mappedIn.label}` : 'assets.animate()', keysSchema(CONFIG_KEYS), config);
    const { fade = 0.25, states = {}, transitions = {}, params = {} } = config;
    this.engine = engine;
    this._mappedIn = mappedIn;
    this.root = root;
    this.fade = fade;
    this.states = states;
    this.transitions = transitions;
    this.params = { speed: 0, ...params };
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = root.animations;
    this.actions = new Map();   // clip name (as written in the state) -> three.js AnimationAction
    this.state = null;
    this._layers = [];          // states being shown: { name, def, w, target, rate, actions: [{ a, clip }], driven }
    this._return = null;        // state to return to when an action() one-shot ends
    this._driven = null;        // state currently posed by sync(); go() and action() leave it alone
    this._t = 0;                // last gameplay time passed to sync (describe)
    // A static model (a procedural prop, a model exported without clips) has nothing to play: no dev warnings, no per-frame hook; go() / action() just return null.
    this.hasClips = this.clips.length > 0;
    this._hook = null;
    /** @internal the time channel's scale for this model, () => number; a Character sets it (useModel.js). null: engine time as it is */
    this._rate = null;
    this._ik = [];                // IK layers (ik.js), run after the mixer in the order added
    this._ikPose = new Map();     // bone IK writes -> { q, p, n }: its pose before IK, put back before the next mixer update
    /** @internal ground height for addFeet, (x, z, y) => y; a Character hands over its own (platforms, only while grounded) */
    this._ground = (x, z, y) => engine.surface(x, z, y);
    /** @internal may the feet stand now; a Character says no while it jumps or swims */
    this._standing = () => true;
    if (this.hasClips) {
      this._check();
      this.mixer.addEventListener('finished', ev => this._finished(ev.action));
      this._needHook();
    }
  }
  /** @internal the per-frame update; a model without clips gets it only once an IK layer needs it */
  _needHook() { this._hook ??= this.engine._onAnimate(dt => this.update(this.engine.still ? 0 : dt * (this._rate?.() ?? 1))); }
  /** @internal */
  _dropHook() { this._hook?.remove(); this._hook = null; }
  /** Dev check at build time: the same problems check() returns, minus the game's action list (the Animator does not know it). */
  _check() {
    for (const [st, def] of Object.entries(this.states)) if (isOptions(def)) readParams(`assets.animate() ${this._where(st)}`, keysSchema(STATE_KEYS), def);
    for (const p of this._problems()) warnOnce(p);
  }
  /** Where a state is written: the manifest entry when the mapping came from there (data), else the code's states. */
  _where(st) {
    const m = this._mappedIn;
    return m && (m.states.includes(st) || !this.states[st]) ? `${m.label}.states.${st}` : `states.${st}`;
  }
  _problems() {
    const names = [...new Set(this.clips.map(c => short(c.name)))], out = [];
    for (const [st, def] of Object.entries(this.states)) {
      for (const clip of def.blend ? def.blend.map(b => b.clip) : [def.clip]) {
        if (!findClip(this.clips, clip)) out.push(`assets.animate(): state "${st}" maps to a missing clip. ${missingText('clip', clip, names)}. Fix the clip name in ${this._where(st)}, or remove the state`);
      }
      if (def.then && !this.states[def.then]) out.push(`assets.animate(): ${this._where(st)}.then. ${missingText('animState', def.then, Object.keys(this.states))}`);
    }
    return out;
  }
  /**
   * Check the mapping against the action names the game plays: every problem as text with its fix, [] when all of them will play.
   * Covers an action without a state, a state whose clip is not in the model, a `then` that is not a state, and a model without clips.
   * Call it once after building (a test, the dev console): a bad name in go() / sync() only warns at the moment it is played.
   * @example anim.check(['idle', 'walk', 'attack', 'hurt'])   // [] or ['action "hurt" has no state. Add it to ... states.hurt: { clip: ... } (clips in the model: Death, Idle, ...)']
   * @param {string[]} [actions] @returns {string[]}
   */
  check(actions = []) {
    if (!this.hasClips) return actions.length ? [`assets.animate(): the model has no animation clips, so ${actions.join(', ')} cannot play. Export the glTF with its animations (Blender: Animation > include all actions), or play them procedurally`] : [];
    const names = [...new Set(this.clips.map(c => short(c.name)))];
    const missing = actions.filter(n => !this.states[n]).map(n => `assets.animate(): action "${n}" has no state. Add it to ${this._where(n)}: { clip: '<name>' } (clips in the model: ${names.join(', ')})`);
    return missing.concat(this._problems());
  }
  /** Get the action for a clip (null if there is no such clip). */
  _action(name) {
    if (!this.actions.has(name)) {
      const c = findClip(this.clips, name);
      if (!c) return null;
      this.actions.set(name, this.mixer.clipAction(c));
    }
    return this.actions.get(name);
  }
  _fadeFor(from, to, fade) {
    const t = this.transitions;
    return fade ?? t[`${from}>${to}`] ?? t[`*>${to}`] ?? t[`${from}>*`] ?? this.fade;
  }

  /**
   * Turn a bone, or a chain spread from the body out, to look at a target, as the last layer on top of the clips (also on a model without clips).
   * The last bone's forward is the model's front in its bind pose, whatever way the rig's axes point (forward: [x, y, z] in its own axes overrides).
   * limit: degrees it may turn away from where the animation points it (beyond, it stops at the limit); speed: degrees per second; weight 0-1 fades
   * in and out over fade seconds; target null looks ahead again. Weight 0 leaves the animation pose exactly; remove() puts it back at once.
   * @example const look = npc.anim.addAim({ bones: ['Neck', 'Head'], target: engine.player.root, limit: 70 });
   * look.set({ target: null }); look.remove();
   * @param {{ bones: string | string[], target?: import('three').Object3D | import('three').Vector3 | [number, number, number] | null, limit?: number, speed?: number, weight?: number, fade?: number, forward?: [number, number, number] }} opts
   * @returns {{ set(opts: { target?: any, limit?: number, speed?: number, weight?: number, fade?: number }): any, remove(): void, describe(): { kind: string, bones: string[], weight: number } }}
   */
  addAim(opts) { return addAim(this, opts); }
  /**
   * Feet on the ground: each leg (upper, lower, foot) bends so the foot stands on the ground under it, and the hips lower when one foot must reach down
   * (stairs, slopes). The ground is the model's own: engine.surface, or for a Character its walking ground with platforms (only while grounded).
   * legs: [[upper, lower, foot], ...] bone names, found by name when left out; reach: the most a foot moves up or down (m); far: beyond this distance from
   * the camera it fades out and asks nothing; speed: how fast a foot follows a new height (1/s); ground: (x, z, y) => height overrides the ground.
   * @example const feet = engine.player.anim.addFeet();   feet.set({ weight: 0 });
   * @param {{ legs?: string[][], hips?: string, reach?: number, far?: number, speed?: number, weight?: number, fade?: number, ground?: (x: number, z: number, y: number) => number }} [opts]
   * @returns {{ set(opts: { reach?: number, far?: number, speed?: number, weight?: number, fade?: number, ground?: Function }): any, remove(): void, describe(): { kind: string, bones: string[], weight: number } }}
   */
  addFeet(opts) { return addFeet(this, opts); }

  /** Set a parameter for blend trees (e.g. speed). */
  set(param, v) { this.params[param] = v; return this; }

  /**
   * Switch to a state ({ fade }: transition seconds). Returns the action, or null (with a dev warning) if the state or its clip does not exist.
   * Does not switch while the current state is locked and unfinished, or while sync() drives a state.
   * @example anim.go('idle'); anim.go('run', { fade: 0.1 })
   */
  go(state, opts) {
    const fade = opts === undefined ? undefined : readParams('animator.go()', keysSchema(GO_KEYS), opts).fade;
    if (this._driven) return this._layers.find(l => l.name === this._driven).actions[0].a;
    const cur = this._layers.find(l => l.name === this.state && l.target === 1);
    if (cur && state === this.state && !cur.done) return cur.actions[0].a;   // already in this state (a finished one-shot may replay)
    if ((cur?.def.lock || cur?.once) && !cur.done) return cur.actions[0].a;
    return this._enter(state, fade);
  }
  /** Switch unconditionally (go after its guards, and sync). */
  _enter(state, fade) {
    if (!this.hasClips) return null;   // static model: nothing to play, nothing to warn about
    const def = this.states[state];
    if (!def) { warnMissing('animState', state, Object.keys(this.states)); return null; }
    const actions = (def.blend ? def.blend.map(b => b.clip) : [def.clip]).map(clip => ({ a: this._action(clip), clip }));
    if (actions.some(x => !x.a)) return null;   // missing clip: already reported by _check
    const f = this._fadeFor(this.state, state, fade), rate = f > 0 ? 1 / f : 1e9;   // not Infinity: 0 * Infinity (dt 0 behind a full still) is NaN
    for (const l of this._layers) { l.target = 0; l.rate = rate; }
    let layer = this._layers.find(l => l.name === state);
    if (!layer) {
      layer = { name: state, def, w: this._layers.some(l => l.w > 0) ? 0 : 1, actions };   // the first state shows immediately
      this._layers.push(layer);
      for (const { a } of actions) {
        // a clip another layer is playing keeps its time (states may share a clip); a fresh one starts over, at the speed a blend may have left on it
        if (!this._held1(a, layer)) a.reset().setEffectiveTimeScale(1).setEffectiveWeight(0);
        if (def.loop === false) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } else a.setLoop(THREE.LoopRepeat, Infinity);
        a.play();
      }
    } else if (def.loop === false) for (const { a } of actions) a.reset().play();
    Object.assign(layer, { target: 1, rate, done: false, once: false, driven: false });
    for (const { a } of actions) a.paused = false;
    this.state = state;
    this._weights();
    return actions[0].a;
  }
  /** Play a one-shot action: when done, go to the state's `then`; without `then` (or given a bare clip name) return to the previous state ({ fade } like go). */
  action(name, opts) {
    const prev = this.state, def = this.states[name];
    if (!def) {
      if (!findClip(this.clips, name)) { if (this.hasClips) warnMissing('clip', name, this.clips.map(c => short(c.name))); return null; }
      this.states[name] = { clip: name, loop: false, lock: true };
    }
    const a = this.go(name, opts);
    if (a && this.state === name) {
      // only a clip that ends can hold the state until it ends: a looping state would lock the animator for good
      if (this.states[name].loop === false) this._layers.find(l => l.name === name).once = true;   // not interrupted by the character's per-frame go() until it ends
      if (!this.states[name].then && prev !== name) this._return = prev;   // a repeat press of the same action keeps the state to go back to
    }
    return a;
  }

  /**
   * Gameplay drives the clock: show `state` at gameplay time `t` (seconds since the gameplay action started, counted in fixed steps).
   * While synced the clip does not advance or end by itself, and go() / action() leave it alone (a character's per-frame locomotion cannot override it).
   * The state's `timing` maps gameplay seconds to clip seconds: a number = the gameplay length the whole clip is stretched over,
   * or [[gameT, clipT], ...] pairs (piecewise linear) to land the swing on the hit phase. Without timing, clip seconds = t.
   * sync(null) hands control back (the next go() switches as usual). Call it every frame or fixed step; cheap when nothing changes.
   * @example
   * // states: { slash: { clip: 'Sword_Slash', loop: false, timing: [[0, 0], [0.16, 0.4], [0.28, 0.6], [0.62, 1]] } }
   * engine.onFrame(() => fighter.act ? anim.sync('slash', fighter.act.t) : anim.sync(null));
   * @param {string | null} state @param {number} [t] @returns {import('three').AnimationAction | null}
   */
  sync(state, t = 0) {
    if (state == null) {
      const l = this._driven && this._layers.find(x => x.name === this._driven);
      if (l) { l.driven = false; l.done = true; for (const { a } of l.actions) a.paused = false; }
      this._driven = null;
      return null;
    }
    if (this._driven !== state || !this._layers.some(l => l.name === state && l.target === 1)) {
      this._driven = null;
      if (!this._enter(state)) return null;
      const l = this._layers.find(x => x.name === state);
      l.driven = true; this._driven = state;
      for (const { a } of l.actions) { a.paused = true; a.enabled = true; }
    }
    this._t = t;
    const def = this.states[state], l = this._layers.find(x => x.name === state);
    for (const { a } of l.actions) a.time = this._clipTime(def, a.getClip().duration, t);
    return l.actions[0].a;
  }
  /** Gameplay seconds -> clip seconds through the state's timing; looping states wrap, one-shots clamp to the clip. */
  _clipTime(def, dur, t) {
    const k = def.timing;
    let c = t;
    if (typeof k === 'number') c = k > 0 ? t / k * dur : 0;
    else if (Array.isArray(k) && k.length) {
      c = k[k.length - 1][1];
      if (t <= k[0][0]) c = k[0][1];
      else for (let i = 1; i < k.length; i++) if (t < k[i][0]) { const [t0, c0] = k[i - 1], [t1, c1] = k[i]; c = c0 + (c1 - c0) * (t - t0) / (t1 - t0); break; }
    }
    return def.loop === false ? Math.min(Math.max(c, 0), dur) : ((c % dur) + dur) % dur;
  }

  _finished(action) {
    const layer = this._layers.find(l => l.name === this.state);
    if (!layer || layer.driven || !layer.actions.some(x => x.a === action)) return;
    layer.done = true;
    this.engine.events.emit('anim:end', { root: this.root, state: layer.name });
    const next = layer.def.then ?? this._return;
    this._return = null;
    if (next) this.go(next);
  }

  /** @internal Per frame: advance fades, split blend-tree weights by parameter, sync stride, then advance the mixer (the engine calls it). */
  update(dt) {
    if (this._held) { this.afterPose?.(dt); return; }   // physics owns the bones (a ragdoll): the mixer writes nothing, attachments still follow the pose
    if (this._ik.length) ikRestore(this);
    let j = 0;   // fade, stop faded-out layers and compact in place (no arrays per frame)
    for (const l of this._layers) {
      if (l.w < l.target) l.w = Math.min(l.target, l.w + dt * l.rate);
      else if (l.w > l.target) l.w = Math.max(l.target, l.w - dt * l.rate);
      if (l.w === 0 && l.target === 0) { for (const { a } of l.actions) if (!this._held1(a, l)) a.setEffectiveWeight(0).stop(); continue; }
      this._layers[j++] = l;
    }
    this._layers.length = j;
    this._weights();
    this.mixer.update(dt);
    if (this._ik.length) ikRun(this, dt);   // IK is the pose's last layer, before anything is attached to it
    this.afterPose?.(dt);   // Character.onPose callbacks (the pose is final here)
  }
  /** @internal is action a also held by a live layer other than l? (states may share a clip, and three keeps one action per clip) */
  _held1(a, l) { return this._layers.some(o => o !== l && !(o.w === 0 && o.target === 0) && o.actions.some(x => x.a === a)); }
  _weights() {
    let total = 0;
    for (const l of this._layers) { total += l.w; for (const x of l.actions) x.a.setEffectiveWeight(0); }
    for (const l of this._layers) {
      const lw = total > 0 ? l.w / total : 0, bw = l.def.blend ? this._blend(l.def) : ONE;
      let dur = 0;
      for (let i = 0; i < l.actions.length; i++) dur += bw[i] * l.actions[i].a.getClip().duration;
      for (let i = 0; i < l.actions.length; i++) {
        const { a } = l.actions[i];
        a.setEffectiveWeight(a.weight + lw * bw[i]);   // added: two layers on one clip each give their share
        // blended actions share one beat (walk and run footfalls land together)
        if (l.def.blend && l.def.sync !== false && dur > 0) a.setEffectiveTimeScale(a.getClip().duration / dur);
      }
    }
  }
  /** Blend-tree weights: a parameter between two `at` values splits proportionally across the two neighbours. */
  _blend(def) {
    const v = this.params[def.param ?? 'speed'] ?? 0, b = def.blend, w = b.map(() => 0);
    if (v <= b[0].at) w[0] = 1;
    else if (v >= b[b.length - 1].at) w[b.length - 1] = 1;
    else for (let i = 0; i < b.length - 1; i++) if (v >= b[i].at && v < b[i + 1].at) { const t = (v - b[i].at) / (b[i + 1].at - b[i].at); w[i] = 1 - t; w[i + 1] = t; }
    return w;
  }
  /**
   * What is showing, as plain data (describe, dev bridge, tests): state, its clip and clip time, progress 0-1 through the clip,
   * whether gameplay drives it (and the last gameplay t), and every fading state's weight.
   * @example engine.player.anim.describe()   // { state: 'attack', clip: 'Sword_Slash', time: 0.42, progress: 0.42, driven: true, t: 0.2, weights: { attack: 0.8, idle: 0.2 } }
   */
  describe() {
    const l = this._layers.find(x => x.name === this.state), a = l?.actions[0].a, dur = a?.getClip().duration || 0;
    const total = this._layers.reduce((s, x) => s + x.w, 0) || 1;   // shown as shares, like the mixer weights (they sum to 1)
    return { state: this.state, clip: l?.actions[0].clip ?? null, time: a ? r3(a.time) : 0, progress: dur ? r3(a.time / dur) : 0,
      driven: !!l?.driven, ...(l?.driven && { t: r3(this._t) }), weights: Object.fromEntries(this._layers.map(x => [x.name, r3(x.w / total)])),
      ...(this._ik.length && { ik: this._ik.map(x => ({ kind: x.kind, bones: x.names, weight: r3(x.w) })) }) };
  }
  /** Call when no longer needed to stop per-frame updates. */
  dispose() { this._dropHook(); ikClear(this); this.mixer.stopAllAction(); }
}

export const handRolled = [{ kind: 'animation', seen: 'an AnimationMixer of its own', use: 'engine.assets.animate(model, { states }): states, crossfades, sync with game time and pause (recipe 13)', quiet: /\bassets\.animate\b/, code: /\bnew\s+(?:THREE\.)?AnimationMixer\s*\(|\bmixer\.update\s*\(/i }];
