// Background music module: tracks on the "music" bus, cross-faded; chosen by a small rule list; optional stems that follow an intensity value.
//
//   engine.use(music({ tracks: {
//     explore: '/music/explore.ogg',
//     combat: { url: '/music/combat-base.ogg', stems: [{ url: '/music/combat-drums.ogg', at: [0.3, 0.7] }, { url: '/music/combat-brass.ogg', at: [0.7, 1] }] },
//     win: { url: '/music/win.ogg', loop: false },
//   } }));
//   engine.music.play('explore')          // 2 s cross-fade by default; play('explore', { fade: 0 }) cuts at once
//   engine.music.intensity = 0.8          // stems fade in as it rises through their `at` range (0-1)
//   engine.music.stinger('win')           // a short piece over the music; the music dips under it
//   engine.music.stop({ fade: 3 })        // fade out over 3 s
//
// Rules (checked about once a second; the highest-priority match wins; a new result must hold `hold` seconds before switching):
//   engine.music.rules([
//     { track: 'combat',  when: { state: 'combat' }, priority: 10 },   // engine.audio.state = 'combat' (the game sets it)
//     { track: 'cave',    when: { zone: 'cave' }, priority: 5 },        // condition keys: state, zone (triggers), time (calendar), weather
//     { track: 'night',   when: { time: 'night' }, priority: 2 },
//     { track: 'explore', priority: 0 },                                // no when = always: the fallback
//     { track: null,      when: e => e.dialogue?.active, priority: 20 },  // a function works too; track: null = silence
//   ], { hold: 2, fade: 3 });
//   engine.music.override('boss')    // pick by hand, pausing the rules; override(null) hands control back
// Tracks and rules may also come from createEngine({ audio: { music: { tracks, rules, fade } } }). Ducking is engine.audio.duck({ music: 0.3 });
// music({ duckDialogue: 0.35 }) does that during dialogue (off by default: whether dialogue lowers the music is the game's call). Before the first click play()
// is remembered and starts once audio is usable.
//
// Events: music:change { from, to }, music:stinger { name, played } (played false: the call was made but audio was not running, nothing sounded)

import { warnMissing, warnOnce } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { pickTrack, evaluateRules } from './rules.js';
import { codedError } from '../../core/base/errorHints.js';
const STOP_KEYS = ['fade'], PLAY_KEYS = ['fade', 'force'], STINGER_KEYS = ['duck', 'volume'];   // module constants: keysSchema caches by the array object
/** @import { ModuleDef } from '../../types/core' */
/** @import { MusicTrack, MusicRule, MusicOptions } from '../../types/gameplay' */

const DEFAULTS = { fade: 2, duckDialogue: false, duckFade: 0.4, hold: 2, interval: 1 };
const RULE_KEYS = ['track', 'when', 'priority'];
const stemLevel = (st, x) => { const [lo, hi] = st.at ?? [0, 1]; return (st.volume ?? 1) * Math.min(1, Math.max(0, hi > lo ? (x - lo) / (hi - lo) : +(x >= lo))); };

/** engine.music */
export class Music {
  /** @internal track: the module's ctx.track, so its listeners leave with the module */
  constructor(engine, opts, track) {
    /** @internal */ this.engine = engine;
    const st = readParams('createEngine({ audio: { music } })', MUSIC_PARAMS, engine.audio.config.music);   // core keeps this table for music() and does not read it, so its spelling is checked here
    /** @internal */ this.opts = { ...st, ...opts };
    /** Registered tracks @type {Map<string, { url?: string, volume?: number, loop?: boolean, stems?: { url: string, at?: number[], volume?: number }[] }>} */
    this.tracks = new Map();
    this._defineAll(st.tracks || {});
    this._defineAll(opts.tracks || {});
    /** @internal stingers sounding now (their handles), and whether the module is gone: a stinger whose file loads after that must not start */
    this._stingers = new Set(); this._gone = false;
    /** Name of the track playing (or wanted) @type {string | null} */
    this.current = null;
    /** 0-1: how loud each stem of the playing track is (see the stems `at` range); fades in about half a second @type {number} */
    this.intensity = 0;
    /** @internal */ this.playing = null;          // { name, gain, srcs, stems: [{ def, gain }], token }
    /** @internal */ this.pending = null;          // { name, fade } remembered while audio is still locked
    /** @internal */ this._token = 0;
    /** @internal */ this._rules = null;
    /** @internal */ this._ruleOpts = {};
    /** @internal */ this._candidate = undefined;
    /** @internal */ this._candidateT = 0;
    /** @internal */ this._ruleT = 0;
    /** @internal */ this._override = undefined;
    /** @internal */ this._duck = null;
    /** @internal */ this._lastIntensity = -1;
    /** @internal the game's own rules (rules() / options) and each content pack's: the rule list is both, the game's first */
    this._base = null;
    /** @internal */ this._packRules = new Map();
    const rules = opts.rules ?? st.rules;
    if (rules) this.rules(rules);
    // content packs (audio: { music: { tracks, rules } }): tracks by name, rules appended; a pack loaded again replaces its own rules
    // (createEngine({ audio: { music: { tracks } } }) names are checked by engine.audio.contentPack; music({ tracks }) ones here)
    const code = new Set(Object.keys(opts.tracks || {}));
    track(engine.audio.onPack((key, pack) => {
      for (const name of Object.keys(pack.music.tracks)) if (code.has(name)) throw codedError('music-track', `music track '${name}' is defined both in music({ tracks }) `
        + `and in content ${pack.from}. One name, one place: keep it in one of them [audio-name-clash]`);
      this._defineAll(pack.music.tracks);
      this._packRules.set(key, { from: pack.from, rules: pack.music.rules });
      this._setRules();
    }));
    // Duck the music bus during dialogue only when the game asks: music({ duckDialogue: 0.35 }) (0-1 multiplier; false / 1 = no duck)
    if (this.opts.duckDialogue !== false && this.opts.duckDialogue != null && this.opts.duckDialogue < 1) {
      track(engine.events.on('dialogue:start', () => { this._duck?.remove(); this._duck = engine.audio.duck({ music: this.opts.duckDialogue }, { fade: this.opts.duckFade }); }));
      track(engine.events.on('dialogue:end', () => { this._duck?.remove(this.opts.duckFade * 2); this._duck = null; }));
    }
  }

  /**
   * Define a track: a url, or { url, volume, loop, stems }. The same name again replaces it
   * @example engine.music.define('town', '/music/town.ogg')
   * @param {string} name
   * @param {MusicTrack} track
   * @returns {void}
   */
  define(name, track) {
    const tr = typeof track === 'string' ? { url: track } : { ...track };
    if (tr.url == null && !tr.stems?.length) throw codedError('music-track', `music track '${name}' needs url or stems, e.g. { url: '/music/${name}.ogg' }`, TypeError);
    this.tracks.set(name, tr);
  }
  /** @internal */
  _defineAll(map) { for (const [name, track] of Object.entries(map)) this.define(name, track); }
  /**
   * Whether audio is usable
   * @returns {boolean}
   */
  get ready() { return this.engine.audio.running; }
  /** Auto track rules are in use @experimental */
  get ruled() { return !!this._rules; }
  /**
   * State (for debugging and tests): gain is the playing track's fade level, stems each stem's level
   * @returns {{ current: string | null, playing: string | null, pending: string | null, override: string | null, intensity: number, gain: number, stems:
   * number[] }}
   */
  get state() {
    const p = this.playing;
    return { current: this.current, playing: p?.name ?? null, pending: this.pending?.name ?? null, override: this._override ?? null, intensity: this.intensity,
      gain: p ? +p.gain.gain.value.toFixed(3) : 0, stems: p ? p.stems.map(s => +s.gain.gain.value.toFixed(3)) : [] };
  }

  // ---------- playback ----------
  /**
   * Play a track (cross-fade over fade seconds). Does nothing if it is already playing; force replays it
   * @param {string | null} name
   * @param {{ fade?: number, force?: boolean }} [opts]
   * @returns {void}
   */
  play(name, opts = {}) {
    const { fade = this.opts.fade, force = false } = readParams('music.play()', keysSchema(PLAY_KEYS), opts);
    if (name == null) return this.stop({ fade });
    const tr = this.tracks.get(name);
    if (!tr) { warnMissing('track', name, [...this.tracks.keys()]); return; }
    if (!force && this.current === name && (this.playing?.name === name || this.pending?.name === name)) return;
    const from = this.current;
    this.current = name;
    if (from !== name) this.engine.events.emit('music:change', { from, to: name });
    const audio = this.engine.audio;
    if (!audio.running || !this._ensureOutput()) { this.pending = { name, fade }; return; }   // cannot sound yet: remember it
    this.pending = null;
    this._fadeOutCurrent(fade);
    const token = ++this._token;
    const ctx = audio.ctx, g = ctx.createGain(), vol = tr.volume ?? 1;
    g.gain.setValueAtTime(fade > 0 ? 0 : vol, ctx.currentTime);
    g.connect(this.output);
    const stems = (tr.stems || []).map(def => { const sg = ctx.createGain(); sg.gain.value = stemLevel(def, this.intensity); sg.connect(g); return { def, gain: sg }; });
    const slot = { name, gain: g, srcs: [], stems, token };
    this.playing = slot;
    const parts = [...(tr.url != null ? [{ url: tr.url, out: g }] : []), ...stems.map(s => ({ url: s.def.url, out: s.gain }))];
    // all parts decode first, then start on the same audio-clock instant: stems only line up if they begin together
    Promise.all(parts.map(p => audio.load(p.url))).then(bufs => {
      if (this._token !== token || this.playing !== slot) { g.disconnect(); return; }   // another track was chosen while loading
      const t = ctx.currentTime + 0.02, loop = tr.loop !== false;
      bufs.forEach((buf, i) => { const src = ctx.createBufferSource(); src.buffer = buf; src.loop = loop; src.connect(parts[i].out); src.start(t); slot.srcs.push(src); });
      if (fade > 0) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + fade); }
      if (slot.srcs[0]) slot.srcs[0].onended = () => this._ended(slot);   // a looping source ends only when a fade stops it
    }).catch(err => { warnOnce(err.message); if (this.playing === slot) this.playing = null; });   // a missing file is said once; the game goes on silent
  }
  /**
   * Fade out and stop (fade over fade seconds; default the music({ fade }) option). An options object like play's: stop(3) throws in dev
   * @param {{ fade?: number }} [opts]
   * @returns {void}
   */
  stop(opts = {}) {
    const { fade = this.opts.fade } = readParams('music.stop()', keysSchema(STOP_KEYS), opts);
    const from = this.current;
    this.pending = null; this.current = null; this._token++;
    this._fadeOutCurrent(fade);
    if (from) this.engine.events.emit('music:change', { from, to: null });
  }
  /** @internal */
  _fadeOutCurrent(fade) {
    const p = this.playing; this.playing = null;
    if (!p) return;
    const ctx = this.engine.audio.ctx, t = ctx.currentTime, f = Math.max(0.02, fade);
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.setValueAtTime(p.gain.gain.value, t);
    p.gain.gain.linearRampToValueAtTime(0, t + f);
    for (const s of p.srcs) { try { s.stop(t + f + 0.05); } catch { /* already stopped */ } }
    if (p.srcs[0]) p.srcs[0].onended = () => this._ended(p);   // free the nodes once the fade has really ended
  }
  /** @internal The one end of a track's nodes, natural or faded (a fade-out already took it off `playing`): free them, and if it is still the playing one, say the music ended */
  _ended(slot) {
    slot.gain.disconnect();
    if (this.playing !== slot) return;
    this.playing = null; const from = this.current; this.current = null;
    this.engine.events.emit('music:change', { from, to: null });
  }
  /** @internal the module goes: stop the background, every stinger, and refuse the ones still loading */
  _close() {
    this._gone = true;
    this.stop({ fade: 0 }); this._duck?.remove(0); this.output?.disconnect();
    for (const h of [...this._stingers]) h.remove();
    this._stingers.clear();
  }
  /** @internal the background bed: tracks connect here, then to the music bus; a stinger dips this node, never the bus (it plays on the bus itself) */
  _ensureOutput() {
    const a = this.engine.audio;
    if (this.output) return true;
    if (!a.ctx) return false;
    /** @internal */ this.output = a.ctx.createGain();
    this.output.connect(a.buses.music);
    return true;
  }

  /**
   * Layer a one-shot piece (victory, discovered place...); the background dips to `duck` while it plays
   * @param {string} name
   * @param {{ duck?: number, volume?: number }} [opts]
   * @returns {void}
   */
  stinger(name, opts = {}) {
    const { duck = 0.5, volume } = readParams('music.stinger()', keysSchema(STINGER_KEYS), opts);
    const tr = this.tracks.get(name);
    if (!tr) { warnMissing('track', name, [...this.tracks.keys()]); return; }
    const a = this.engine.audio;
    // the record comes first: a headless page or a locked audio context plays nothing, but the call still happened and a test must be able to see it (played: false)
    const live = a.running && this._ensureOutput();
    this.engine.events.emit('music:stinger', { name, played: !!live });
    if (!live) return;                                         // a one-shot piece is not worth queueing
    a.play(tr.url, { bus: 'music', volume: volume ?? tr.volume ?? 1 }).then(h => {
      if (this._gone) { h.remove(); return; }   // the file loaded after the module went
      this._stingers.add(h); h.source.addEventListener?.('ended', () => this._stingers.delete(h));
      const d = h.source.buffer?.duration || 1, g = this.output.gain, t = a.ctx.currentTime;
      if (duck >= 1) return;
      // scheduled on the audio clock (no timers): dip, hold for the stinger's length, come back
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(duck, t + 0.15);
      g.setValueAtTime(duck, t + d); g.linearRampToValueAtTime(1, t + d + 0.3);
    }).catch(err => warnOnce(err.message));
  }

  // ---------- rules ----------
  /**
   * Set the auto track rules (null turns them off). opts: hold how many seconds a new result must be stable before switching, fade switch fade seconds,
   * interval check interval
   * @param {MusicRule[] | null} list
   * @param {{ hold?: number, fade?: number, interval?: number }} [opts]
   * @returns {this}
   */
  rules(list, opts = {}) {
    readParams('music.rules()', keysSchema(['hold', 'fade', 'interval']), opts);
    this._base = list ? [...list] : null;
    this._ruleOpts = opts;
    this._setRules();
    return this;
  }
  /** @internal the live rule list: the game's rules, then every content pack's (null = no rules at all) */
  _setRules() {
    for (const r of this._base || []) readParams('music.rules() rule', keysSchema(RULE_KEYS), r);
    // a pack's rule names its pack in the message, so a typo points at the right data file
    for (const p of this._packRules.values()) for (const r of p.rules) readParams(`content ${p.from} audio.music.rules rule`, keysSchema(RULE_KEYS), r);
    const all = [...(this._base || []), ...[...this._packRules.values()].flatMap(p => p.rules)];
    this._rules = all.length || this._base ? all : null;
    this._candidate = undefined; this._candidateT = 0; this._ruleT = 0;
    if (this._rules) this._evaluate(true);
  }
  /**
   * Pick a track by hand, pausing the rules; override(null) hands control back
   * @param {string | null} name
   * @param {{ fade?: number, force?: boolean }} [opts]
   * @returns {void}
   */
  override(name, opts) {
    if (name == null) { this._override = undefined; if (this._rules) this._evaluate(true); return; }
    this._override = name; this.play(name, opts);
  }
  /**
   * Which track the current rules would pick (without switching)
   * @returns {string | null | undefined}
   */
  pick() { return pickTrack(this); }
  /** @internal */
  _evaluate(immediate = false) { return evaluateRules(this, immediate); }
  /**
   * @internal the 'music' save part: a hand-picked track and the intensity are playthrough state, so a new game starts with the rules in charge
   * and a load picks up the save's (an override kept across playthroughs would stop the rules for good)
   */
  _load(d) {
    this._override = typeof d?.override === 'string' ? d.override : undefined;
    this.intensity = Number.isFinite(d?.intensity) ? d.intensity : 0;
    this._candidate = undefined; this._candidateT = 0; this._ruleT = 0;
    if (this._override !== undefined) this.play(this._override);
    else if (this._rules) this._evaluate(true);
  }
  /**
   * Per-frame update (plays queued tracks, follows intensity, picks tracks by rules; the module calls it every frame)
   * @param {number} dt
   * @returns {void}
   * @internal
   */
  frame(dt) {
    // Once audio is usable, play the queued track
    if (this.pending && this.engine.audio.running) { const p = this.pending; this.pending = null; this.play(p.name, { fade: p.fade, force: true }); }
    if (this.playing?.stems.length && this.intensity !== this._lastIntensity) {
      this._lastIntensity = this.intensity;
      const t = this.engine.audio.ctx.currentTime;
      for (const s of this.playing.stems) s.gain.gain.setTargetAtTime(stemLevel(s.def, this.intensity), t, 0.15);
    }
    if (!this._rules) return;
    const iv = this._ruleOpts.interval ?? this.opts.interval;
    if (this._candidate !== undefined) this._candidateT += dt;
    if ((this._ruleT -= dt) > 0) return;
    this._ruleT = iv;
    this._evaluate(false);
  }
}

const MUSIC_PARAMS = keysSchema(['tracks', 'rules', ...Object.keys(DEFAULTS)], DEFAULTS);

/**
 * Background music -> engine.music. tracks; rules; fade: default fade seconds (2); duckDialogue: duck the music bus to this level during dialogue (default
 * false = off; e.g. 0.35); duckFade; hold: rule debounce seconds (2)
 * @param {MusicOptions} [opts]
 * @returns {ModuleDef<Music>}
 * @example engine.use(music({ tracks: { explore: '/music/explore.ogg' }, rules: [{ track: 'explore' }] }));
 */
export function music(opts = {}) {
  readParams('music', MUSIC_PARAMS, opts);
  let m = null;
  return {
    name: 'music', skipKind: 'none', type: 'picture', params: MUSIC_PARAMS, options: opts, label: 'Music', optional: ['dialogue'], stage: 'audio',
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.music': '音乐' }, en: { 'module.music': 'music' } });
      m = new Music(e, opts, ctx.track);
      ctx.track(e.events.on('session:end', () => m.stop({ fade: 0 })));   // a playthrough ends: its music stops at once
      ctx.saves.define('music', { notAtomic: 'sound, which an atomic op leaves alone: side effects go in after', save: () => ({ override: m._override ?? null, intensity: m.intensity }), load: d => m._load(d) });
      return m;
    },
    frame(dt) { m.frame(dt); },
    dispose() { m._close(); },   // nothing would stop a looping track once the module is gone
    // the same state the tests read (music.state) plus why nothing may sound: audio still locked (ready false, the track waits in pending), rules on, ducked by dialogue
    describe() { return { ...m.state, ready: m.ready, ruled: m.ruled, ducked: !!m._duck, tracks: m.tracks.size }; },
  };
}

export const handRolled = 'none: a song by hand is the audio hint already';
