// Ambience module: a rule table of background sounds. Each rule names a sound from audio.sounds and says when and how loud it plays:
//
//   createEngine({ audio: {
//     sounds: { wind: {}, cave: 'caveDrip', crows: ['crow1', 'crow2'] },   // play rules; the sounds are asset names (files or synths)
//     ambience: [
//       { sound: 'wind', volume: e => 0.1 + (e.audio.value('wind') ?? 0) * 0.1 },   // a loop; volume may be a function of the moment
//       { sound: 'cave', when: { zone: 'cave' }, volume: 0.6, fade: 2 },             // condition keys: zone (triggers), time (calendar), weather, state
//       { sound: 'crows', when: { time: 'day' }, every: [4, 12] },                  // every: a one-shot at random gaps instead of a loop
//     ] } });
// The same rules as data in a content pack (audio: { ambience }): measures instead of functions, e.g.
//   { sound: 'rain', volume: { add: { rain: 0.22 } } }, { sound: 'birds', when: { daylight: { gt: 0.15 } }, every: [2, 7] }
// A rule may set the reverb instead of playing a sound: { reverb: 0.6, when: { zone: 'cave' }, fade: 2 } sets engine.audio.reverb's wet while it
// holds (the highest of those that hold; none: the game's own wet comes back). The same when / volume forms, so places stay data. The game still
// sets the room (engine.audio.reverb({ sends, decay, size })): a rule says how much echo here, not what the room is.
// This module adds the measures nearWater (share of water within 12 m of the listener, 0-1) and altitude (ground height under it, 0 below sea level).
//   engine.use(ambience());          // openWorld() installs it
//
// The engine plays nothing unless a rule asks. Built-in synths (wind, rain, water, birds, crickets) are registered silent and only play
// when the game's audio.sounds names them (wind: {}). A rule that is off fades out and its loop stops, so unused rules cost nothing.
// Timing of one-shots only affects sound (not gameplay), so it uses Math.random and carries // presentation.

import * as THREE from 'three';

import { builtInSounds } from '../../core/assets/assetManifest.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
/** @import { ModuleDef, AmbienceRule } from '../../types/core' */
/** @import { AmbienceOptions } from '../../types/gameplay' */
const RULE_KEYS = ['sound', 'when', 'volume', 'fade', 'every', 'bus', 'reverb'];
const gap = r => r.every[0] + Math.random() * (r.every[1] - r.every[0]);   // presentation

/** engine.ambience: the rule table of background sounds */
export class Ambience {
  /** @internal */
  constructor(engine, opts = {}) {
    /** @internal */ this.engine = engine;
    /** @internal */ this.interval = opts.interval ?? 0.25;
    /** @internal */ this._acc = 0;
    /** @internal @type {{ rule: AmbienceRule, voice: any, level: number, offT: number, next: number }[]} */
    this._rules = [];
    /** Where the sounds are heard from: whoever the player controls (engine.actor), else the camera focus @type {THREE.Vector3} */
    this.position = new THREE.Vector3();
    for (const r of [...(engine.audio.config.ambience || []), ...(opts.rules || [])]) this.add(r);
    /** @internal content pack key -> handles of its rules (a pack loaded again replaces its own rules, never the game's) */
    this._packs = new Map();
  }
  /** @internal a content pack's rules (audio.onPack, wired in install): a pack loaded again replaces its own rules */
  _onPack(key, pack) {
    for (const h of this._packs.get(key) || []) h.remove();
    this._packs.set(key, pack.ambience.map(r => this.add(r)));
  }

  /**
   * Add one rule; returns a handle whose remove() fades the sound out and drops the rule
   * @param {AmbienceRule} rule
   * @returns {{ remove(): void }}
   * @example const h = engine.ambience.add({ sound: 'storm-wind', when: { weather: 'storm' }, volume: 0.5 });
   */
  add(rule) {
    readParams('ambience rule', keysSchema(RULE_KEYS), rule);
    if (rule.reverb != null) {
      const extra = ['sound', 'volume', 'every', 'bus'].filter(k => k in rule);
      if (extra.length) throw codedError('ambience-rule', `ambience rule: a reverb rule sets the reverb's wet and plays no sound, so ${extra.join(' / ')} has no meaning on it. Two rules: { sound: 'drips', when, volume } and { reverb: 0.6, when }`, TypeError);
      if (!this.engine.audio.reverbOn) warnOnce(coded('ambience-rule', "ambience: a reverb rule changes the reverb's wet, but engine.audio.reverb() was never called, so no bus sends into it and nothing echoes. Call engine.audio.reverb({ sends: { sfx: 0.5 } }) first"), 'ambience-reverb-off');
    } else if (typeof rule.sound !== 'string') throw codedError('ambience-rule', `ambience rule needs sound: a name from audio.sounds, got ${JSON.stringify(rule.sound)}. Example: { sound: 'wind', volume: 0.3 }`, TypeError);
    const slot = { rule, voice: null, level: 0, offT: 0, next: rule.every ? gap(rule) : 0 };
    this._rules.push(slot);
    return { remove: () => { slot.voice?.stop({ fade: rule.fade ?? 1 }); this._rules = this._rules.filter(s => s !== slot); if (rule.reverb != null) this._place(rule.fade ?? 1); } };
  }
  /**
   * Replace the whole rule table (null or [] = silence)
   * @param {AmbienceRule[] | null} list
   * @returns {this}
   */
  rules(list) {
    for (const s of this._rules) s.voice?.stop({ fade: s.rule.fade ?? 1 });
    this._rules = [];
    for (const r of list || []) this.add(r);
    this._place(1);
    return this;
  }
  /**
   * How much of the ground within `radius` meters of the listener is water (0-1), sampled at 6 points: for a water rule's volume
   * @param {number} [radius]
   * @returns {number}
   * @example { sound: 'river', volume: (e, a) => a.nearWater(20) * 0.12 }   // in data: volume: { add: { nearWater: 0.12 } } (12 m)
   */
  nearWater(radius = 12) {
    const e = this.engine, p = this.position; let n = 0;
    for (let ang = 0; ang < 6.28; ang += 1.05) {
      const x = p.x + Math.cos(ang) * radius, z = p.z + Math.sin(ang) * radius;
      if (e.surface(x, z, p.y) < e.waterAt(x, z, p.y)) n += 1 / 6;
    }
    return n;
  }
  /**
   * What each rule is doing (debug, tests): sound name, whether its condition holds, its current target volume
   * @returns {{ sound: string, on: boolean, volume: number }[]}
   * @internal a debug readout the engine tests read; games react to their own rules instead
   */
  get info() { return this._rules.map(s => ({ sound: s.rule.sound ?? 'reverb', on: s.rule.reverb != null ? !!s.on : s.level > 0, volume: +s.level.toFixed(3) })); }

  /**
   * Per-frame update: checks the rules every `interval` seconds and fades sounds toward their targets
   * @param {number} dt
   * @returns {void}
   * @internal
   */
  update(dt) {
    const e = this.engine, a = e.audio;
    if (!a.running || !this._rules.length) return;
    if ((this._acc += dt) < this.interval) return;
    dt = this._acc; this._acc = 0;
    this._listen();
    for (const s of this._rules) this._step(s, dt);
    this._place();
  }
  /** @internal The reverb wet the places ask for: the highest reverb rule that holds now, else null (the game's own wet); fade from that rule */
  _place(fade) {
    let best = null;
    for (const s of this._rules) if (s.rule.reverb != null && s.on && (!best || s.level > best.level)) best = s;
    this.engine.audio.reverbPlace(best ? Math.min(1, best.level) : null, fade ?? best?.rule.fade ?? 1);
  }
  /** @internal Refresh this.position from the listener (player, else the camera focus). The measures call it too: music rules read them while ambience may have no rules (then update() returns early and never moves the position) */
  _listen() { const p = this.engine.actorPosition() ?? this.engine.focus; return this.position.set(p.x, p.y ?? 0, p.z); }
  /** @internal */
  _step(s, dt) {
    const r = s.rule, a = this.engine.audio, fade = r.fade ?? 1;
    if (s.failed) return;   // its file failed to load: retrying every check would refetch it ~4 times a second forever. Reloading the rules (rules(), a pack loaded again, a page reload) tries again
    if (r.reverb != null) { s.on = a.matches(r.when, this); s.level = s.on ? Math.max(0, a.volumeOf(r.reverb, this)) : 0; return; }   // a place's echo: _place picks
    if (s.voice?.failed) { s.failed = true; s.voice = null; warnOnce(coded('asset-load', `[threedog] ambience: sound '${r.sound}' failed to load, its rule stays silent until the rules are loaded again. Fix the file path / asset name in audio.sounds`)); return; }
    const on = a.matches(r.when, this);
    s.level = on ? Math.max(0, a.volumeOf(r.volume, this)) : 0;
    if (r.every) {
      if ((s.next -= dt) > 0) return;
      s.next = gap(r);
      if (s.level > 0) a.sfx(r.sound, { bus: r.bus ?? 'ambience', volume: s.level });
      return;
    }
    if (s.level > 0.001) {
      s.offT = 0;
      if (!s.voice?.playing) s.voice = a.sfx(r.sound, { bus: r.bus ?? 'ambience', loop: true, volume: 0 });
      s.voice?._fade(s.level, fade);   // every check: the internal form skips the option parse
    } else if (s.voice) {
      if (s.offT === 0) s.voice._fade(0, fade);
      if ((s.offT += dt) > fade) { s.voice._stop(0); s.voice = null; s.offT = 0; }   // faded out: stop the loop so an idle rule costs nothing
    }
  }
}

// ---------- built-in synths (sound assets, silent until the game's audio.sounds names them, e.g. wind: {}) ----------
/** A filtered noise loop with an optional slow wobble on its level (wind gusts) */
function noiseLoop(audio, out, filters, wobble = 0) {
  const ctx = audio.ctx, src = ctx.createBufferSource(), mix = ctx.createGain(), nodes = [src];
  src.buffer = audio.noise; src.loop = true; src.playbackRate.value = 0.5 + Math.random() * 0.5;   // presentation
  for (const [type, freq, q, vol = 1] of filters) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = vol;
    src.connect(f).connect(g).connect(mix);
  }
  if (wobble) {   // two slow oscillators on the level: gusting without per-frame work
    for (const hz of [0.37, 0.13]) { const o = ctx.createOscillator(), d = ctx.createGain(); o.frequency.value = hz; d.gain.value = wobble / 2; o.connect(d).connect(mix.gain); o.start(); nodes.push(o); }
    mix.gain.value = 1 - wobble / 2;
  }
  mix.connect(out); src.start(0, Math.random());   // presentation
  return { stop: t => { for (const n of nodes) n.stop(t); } };
}
const SYNTHS = {
  wind: (a, p, out) => noiseLoop(a, out, [['bandpass', p.freq ?? 330, 0.6]], p.gust ?? 0.3),
  rain: (a, p, out) => noiseLoop(a, out, [['highpass', 1800, 0.3], ['lowpass', 500, 0.5, 0.8]]),
  water: (a, p, out) => noiseLoop(a, out, [['lowpass', p.freq ?? 700, 1]]),
  birds: (a, p, out) => {   // p.range: [low, high] Hz of the chirps; p.pitch is the sfx pitch multiplier every synth gets
    const [lo, hi] = p.range ?? [2200, 4000], base = (lo + Math.random() * (hi - lo)) * (p.pitch ?? 1), notes = 2 + Math.floor(Math.random() * 4), pan = Math.random() * 2 - 1;   // presentation
    let t = 0;
    for (let i = 0; i < notes; i++) { a.tone({ freq: base * (1 + Math.random() * 0.3), to: base * (0.7 + Math.random() * 0.6), dur: 0.08, vol: p.volume ?? 0.04, delay: t, pan, out }); t += 0.09 + Math.random() * 0.06; }   // presentation
    return t + 0.1;
  },
  crickets: (a, p, out) => {   // p.freq: chirp Hz (default 4300); p.pitch is the sfx pitch multiplier (~1), like birds
    const pan = Math.random() * 2 - 1;   // presentation
    for (let i = 0; i < 3; i++) a.tone({ freq: ((p.freq ?? 4300) + Math.random() * 200) * (p.pitch ?? 1), dur: 0.035, vol: p.volume ?? 0.02, delay: i * 0.05, pan, out });   // presentation
    return 0.2;
  },
};

const AMBIENCE_PARAMS = keysSchema(['rules', 'interval']);

/**
 * Ambience -> engine.ambience. Rules come from createEngine({ audio: { ambience: [...] } }) plus opts.rules
 * @param {AmbienceOptions} [opts]
 * @returns {ModuleDef<Ambience>}
 * @example engine.use(ambience({ rules: [{ sound: 'hum', when: { zone: 'lab' }, volume: 0.4 }] }));
 */
export function ambience(opts = {}) {
  readParams('ambience', AMBIENCE_PARAMS, opts);
  let a = null;
  return { name: 'ambience', skipKind: 'none', type: 'picture', params: AMBIENCE_PARAMS, options: opts, label: 'Ambience', stage: 'late',
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.ambience': '环境音' }, en: { 'module.ambience': 'ambience' } });
      builtInSounds(e.assets, SYNTHS, { bus: 'ambience' });   // sound assets wind / rain / water / birds / crickets, silent until audio.sounds names them
      a = new Ambience(e, opts);
      ctx.track(e.audio.onPack((key, pack) => a._onPack(key, pack)));
      // measures for data rules (content packs hold no functions). Each reads the listener position itself: music rules call them too,
      // and ambience refreshes this.position only while it has rules of its own
      ctx.track(e.audio.measure('nearWater', () => { a._listen(); return a.nearWater(12); }));
      ctx.track(e.audio.measure('altitude', () => { const p = a._listen(); return Math.max(0, e.surface(p.x, p.z, p.y)); }));
      return a;
    },
    frame(dt) { a.update(dt); },
    dispose() { a.rules(null); },   // its loops would play on with nobody left to fade them
    // "is the rain sound on here" without listening: the rules whose condition holds now, with their target volume; failed = files that did not load
    describe() {
      const on = a.info.filter(r => r.on).map(r => ({ sound: r.sound, volume: r.volume })), failed = a._rules.filter(s => s.failed).map(s => s.rule.sound);
      // audio starts only after a real click or key press (browser rule): until then `on` is empty everywhere, which is not "no rule matches here"
      const locked = a._rules.length > 0 && !a.engine.audio.running;
      return { rules: a._rules.length, on, ...(failed.length ? { failed } : {}), ...(locked ? { audioLocked: 'audio starts after a real click or key press; a bridge page has none, so `on` stays empty here whatever the position' } : {}) };
    } };
}

export const handRolled = 'none: sounds by place are data, and a hand-made version has no one shape in code';
