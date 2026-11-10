// Audio core: buses (master, music, sfx, ambience, ui + the game's own), sounds by name, ducking, and the condition table for rule lists.
// Sounds are the game's: createEngine({ audio: { sounds, ambience, music, footsteps, levels } }) or a content pack's audio table (contentPack,
// audioRules.js), merged into engine.audio.config. Where a sound comes from is the asset manifest's job (assets.manifest({ sounds: { step:
// '/sfx/step.ogg', ding: synthFn } }): a file or a synth function, used by name); audio.sounds only says how it plays (src, variants, volume, bus...).
// The engine plays nothing the game did not ask for: modules register their synths as built-in sound assets, silent until audio.sounds names them.
// Usage: recipes/31-audio.md.
// Browsers only allow sound after the first click/keypress; this waits for it automatically.

/** @import { AudioCondition, AudioVolume } from '../../types/core' */
import { codedError, coded } from '../base/errorHints.js';
import { missingText, warnOnce } from '../base/validate.js';
import { readParams } from '../base/params.js';
import { SoundHandle, playSound, placeListener, synthNoise, synthTone, loadSound, playFile, soundDef } from './audioVoice.js';
import { Reverb } from './audioReverb.js';
import { matchesWhen, volumeOf, checkRuleName, packAudio, applyDucks, audioInfo } from './audioRules.js';
// createEngine({ audio }) schema: unknown keys throw in dev with did-you-mean. Object / array defaults are not kept here: they would be shared by all engines as one object
const AUDIO_PARAMS = { levels: 'object?', sounds: 'object?', ambience: 'array?', music: 'object?', footsteps: 'object?' };
const BUS_PARAMS = { level: { type: 'number', default: 1, min: 0, desc: 'bus volume 0-1' }, owner: 'string?' };
const DUCK_PARAMS = { fade: { type: 'number', default: 0.3, min: 0, desc: 'fade seconds both ways' } };
const DEFAULT_LEVELS = { master: 0.8, music: 0.5, sfx: 0.8, ambience: 0.7, ui: 0.8 };

/** engine.audio: buses, sounds by name, ducking. Sfx play by name from the game's audio.sounds (file, variants or synth). */
export class Audio {
  /** @internal */
  constructor(engine, opts = {}) {
    const { levels = {}, sounds = {}, ambience = [], music = {}, footsteps = {} } = readParams('createEngine({ audio })', AUDIO_PARAMS, opts);
    /** @internal */ this.engine = engine;
    /** The browser AudioContext (exists only after the first click) @type {any} */
    this.ctx = null;
    /** Volume per bus 0-1 ('master' is the total). Every key is a bus: levels: { voice: 1 } adds a 'voice' bus @type {Record<string, number>} */
    this.levels = { ...DEFAULT_LEVELS, ...levels };
    /**
     * The game's sound config from createEngine({ audio }); sounds and footsteps also hold content packs' (copies: the game's object is never changed).
     * Content packs' ambience / music rules go to ambience() / music(), not here
     * @type {import('../../types/core').AudioConfig}
     */
    for (const [n, v] of Object.entries(sounds)) soundDef(n, v);   // the old synth forms fail here, at createEngine, not at the first play
    this.config = { sounds: { ...sounds }, ambience, music, footsteps: { ...footsteps } };
    /** Bus input GainNodes by name, 'master' included (connect your own nodes here); empty until audio unlocks. A name that is no bus warns and gives master: node.connect(undefined) would throw, and in dev a throw freezes gameplay @type {Record<string, any>} */
    this.buses = new Proxy({}, { get: (t, k) => {
      if (typeof k !== 'string' || k in t || k === 'toJSON' || k === 'then') return t[k];
      warnOnce(coded('unknown-name', this.master ? `audio.buses.${k} is not a bus, so master was given instead. Buses: ${Object.keys(t).join(', ')}` : `audio.buses.${k}: buses are empty until audio unlocks; connect after the 'audio:ready' event`), `audio-bus-${k}`);
      return this.master;
    } });
    /** The game's current mode for rule lists, e.g. 'combat' / 'explore' (condition `state` in music and ambience rules) @type {string | null} */
    this.state = null;
    // the mode belongs to the playthrough: a new game opens as the page did, a load in the mode it was saved in
    engine.saves.define('audio', { notAtomic: 'sound, which an atomic op leaves alone: side effects go in after', save: () => ({ state: this.state }), load: d => { this.state = d.state ?? null; } });
    /** @internal */ this.conditions = new Map([['state', v => [].concat(v).includes(this.state)]]);
    /** @internal name -> (engine) => number: values rule data compares ({ daylight: { gt: 0.15 } }) and data volumes add up */
    this.measures = new Map();
    // names defined in code: the same name in a content pack is an error (one name, one place)
    /** @internal */ this._code = { sounds: new Set(Object.keys(sounds)), footsteps: new Set(Object.keys(footsteps)), tracks: new Set(Object.keys(music.tracks || {})) };
    /** @internal content packs' audio: pack key -> { ambience, music } (ambience() / music() read it at install and follow it after) */
    this.packs = new Map();
    /** @internal */ this._packWatch = new Set();
    /** @internal */ this._duckNodes = {};
    /** @internal */ this._ducks = new Set();
    /** @internal */ this._voices = new Map();      // name -> live voices (voice limit, info)
    /** @internal */ this._last = new Map();        // name -> { at, variant } (cooldown, no-repeat)
    /** @internal */ this._spatial = new Set();     // positional voices: the listener and followed objects update only while any exist
    /** @internal the one reverb send/return (audioReverb.js), made by the first reverb() call */ this._reverb = null;
    /** @internal */ this._readySent = false;
    /** @internal the game is held by the page (core/engine/page.js): the sound waits with it */ this._held = false;
    // Create or resume audio on a click/keypress (a context created earlier is suspended and must be resumed inside a user gesture). Every press, not only the first:
    // a touch pointerdown or Escape is no activation for the browser, and a phone suspends a running context on a call or an app switch
    const unlock = () => { if (this._held) return; this._init(); if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'pointerup', 'keydown']) addEventListener(ev, unlock, { signal: engine.signal });
  }
  /** @internal page.js: the page froze the game, or let it go */
  _hold(on) { this._held = on; if (this.ctx) (on ? this.ctx.suspend() : this.ctx.resume()).catch(() => {}); }
  /** @internal Close the audio context (engine.dispose calls it): playing sounds and nodes modules attached stop together */
  dispose() { this.ctx?.close(); this.ctx = null; }

  /** @internal */
  _init() {
    if (this.ctx || this.engine.disposed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    /** The master GainNode (every bus ends here) @type {any} */
    this.master = this.buses.master = ctx.createGain(); this.master.gain.value = this.levels.master; this.master.connect(ctx.destination);
    for (const name of Object.keys(this.levels)) if (name !== 'master') this._makeBus(name);
    this._applyDucks(0);
    this._reverb?.build();
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;   // presentation
    /** 2 s of white noise, reused by synthesized sounds @type {any} */
    this.noise = buf;
    const ready = () => { if (ctx.state === 'running' && !this._readySent) { this._readySent = true; this.engine.events.emit('audio:ready'); } };
    ctx.addEventListener('statechange', ready); ready();
  }
  /** @internal a bus is two gains: its level (what setVolume sets) then its duck (what duck() lowers), so the two never fight */
  _makeBus(name) {
    const ctx = this.ctx, g = ctx.createGain(), d = ctx.createGain();
    g.gain.value = this.levels[name]; g.connect(d).connect(this.master);
    this.buses[name] = g; this._duckNodes[name] = d;
    this._reverb?.busMade(name);
  }
  /** Is audio usable (the player has clicked/pressed a key)? @returns {boolean} @experimental */
  get running() { return this.ctx?.state === 'running'; }
  /** @internal */
  _warn(msg) { warnOnce(msg); }
  /** @internal */
  _bus(name) {
    if (name in this.levels && name !== 'master') return this.buses[name];
    throw codedError('unknown-name', missingText('bus', name, Object.keys(this.levels).filter(n => n !== 'master'))
      + '. Add a bus with createEngine({ audio: { levels: { name: 1 } } }) or engine.audio.addBus(name)');
  }

  /**
   * Add a bus of your own (routed to master). It gets a settings slider like the others (label key settings.vol.<name>)
   * until the handle is removed (the one give-back form, like every other handle). A name that is already a bus throws: two owners of one bus
   * could not both remove it.
   * @param {string} name
   * @param {{ level?: number, owner?: string }} [opts] level 0-1 (1)
   * @returns {{ owner?: string, remove(): void }}
   * @example const voice = engine.audio.addBus('voice', { level: 1 }); engine.audio.sfx('line-01', { bus: 'voice' }); voice.remove();
   */
  addBus(name, opts = {}) {
    const { level, owner } = readParams('audio.addBus()', BUS_PARAMS, opts);
    if (name === 'master' || name in this.levels) throw codedError('engine-misuse', `audio.addBus('${name}'): '${name}' is already a bus (${Object.keys(this.levels).join(', ')}); use it by name, or remove the handle that added it first`);
    this.levels[name] = level; if (this.ctx) this._makeBus(name);
    // identity, not name: a stale handle (already removed, the name taken again by a newer bus) must not delete the newer bus
    const handles = this._busHandles ??= new Map();
    const h = { owner, remove: () => {
      if (handles.get(name) !== h) return;
      handles.delete(name);
      delete this.levels[name];
      if (this.ctx) { this.buses[name].disconnect(); this._duckNodes[name].disconnect(); }   // sounds still playing on this bus are cut with the node (bus gone, no sound should linger)
      this._reverb?.busGone(name);
      delete this.buses[name]; delete this._duckNodes[name];
    } };
    handles.set(name, h);
    return h;
  }
  /**
   * Set a bus volume 0-1 ('master' for the total)
   * @param {string} bus
   * @param {number} v
   * @returns {void}
   * @example engine.audio.setVolume('music', 0.3);
  */
  setVolume(bus, v) {
    if (bus !== 'master' && !(bus in this.levels)) this._bus(bus);   // throws with the fix; a known bus has no node before audio unlocks, and only its level changes then
    this.levels[bus] = v; if (!this.ctx) return;
    (bus === 'master' ? this.master : this.buses[bus]).gain.value = v;
  }

  /**
   * The one reverb: a send/return any bus can feed (a cave, a hall, a bathroom). Off until called: nothing is built or heard before. Each call
   * changes only the keys given (sends merge per bus; 0 stops one); null turns it off. The echo of a bus follows its slider and its ducks, and
   * comes back through master. The impulse is generated (decaying noise, no file): changing size or decay rebuilds it, wet and sends only fade.
   * Called before the first click it waits for audio to unlock. Places: an ambience rule { reverb: 0.6, when: { zone: 'cave' } } sets wet while it holds (recipes/31 §9)
   * @param {{ wet?: number, decay?: number, size?: number, sends?: Record<string, number>, fade?: number } | null} opts wet 0-1 (0.3), decay seconds to -60 dB (2), size 0-1 (0.5), fade seconds
   * @returns {void}
   * @example engine.audio.reverb({ sends: { sfx: 0.5, ambience: 0.8 }, decay: 3, size: 0.8, wet: 0.4 });
   * @experimental
   */
  reverb(opts) {
    if (opts === null) { this._reverb?.off(); this._reverb = null; return; }
    const first = !this._reverb, r = this._reverb ??= new Reverb(this);
    try { r.configure(opts ?? {}, 'audio.reverb()'); } catch (err) { if (first) this._reverb = null; throw err; }
    if (this.ctx) r.build();
  }
  /** @internal ambience reverb rules: the wet a place asks for, null when none holds */
  reverbPlace(v, fade) { this._reverb?.setPlace(v, fade); }
  /** @internal has the game turned the reverb on (ambience warns when a reverb rule would echo nothing) */
  get reverbOn() { return !!this._reverb; }

  /**
   * Lower buses until the handle is removed (dialogue, pause menu, a cutscene). Several ducks stack (their levels multiply).
   * @param {Record<string, number>} levels bus -> multiplier 0-1
   * @param {{ fade?: number }} [opts] fade seconds both ways (0.3)
   * @returns {{ remove(fade?: number): void }}
   * @example const d = engine.audio.duck({ music: 0.3, ambience: 0.5 }); engine.events.once('dialogue:end', () => d.remove());
   */
  duck(levels, opts = {}) {
    for (const b of Object.keys(levels)) if (b === 'master' || !(b in this.levels)) this._bus(b);
    const { fade } = readParams('audio.duck()', DUCK_PARAMS, opts), entry = { levels };
    this._ducks.add(entry); this._applyDucks(fade);
    return { remove: (f = fade) => { if (this._ducks.delete(entry)) this._applyDucks(f); } };
  }
  /** @internal */
  _applyDucks(fade) { applyDucks(this, fade); }

  /**
   * Add a condition key for music / ambience rule lists: `when: { [name]: value }` calls test(value, engine). Modules add theirs
   * (calendar: time, weather: weather, triggers: zone); the engine has `state` (engine.audio.state).
   * @param {string} name
   * @param {(value: any, e: any) => boolean} test
   * @returns {{ remove(): void }}
   * @example engine.audio.condition('inside', v => engine.vars.flag('indoors') === v);
   */
  condition(name, test) { checkRuleName(this, name, false); this.conditions.set(name, test); return { remove: () => { if (this.conditions.get(name) === test) this.conditions.delete(name); } }; }
  /**
   * Add a measure: a number rule data compares (`when: { daylight: { gt: 0.15 } }`; gt / gte / lt / lte) and adds up (`volume: { add: { wind: 0.08 } }`).
   * calendar adds daylight, weather rain / snow / wind, ambience nearWater / altitude. A name is a condition or a measure, not both
   * @param {string} name
   * @param {(e: any) => number} fn
   * @returns {{ remove(): void }}
   * @example engine.audio.measure('danger', e => e.vars.counter('alarm') / 10);   // data: when: { danger: { gt: 0.5 } }
   * Measures are not only for sound: render/daylight.js reads 'daylight' for night glow, so the calendar (or the sky without one) registers it once
   * and nothing else has to know which module tells day from night. remove() drops only this registration (a later one under the name stays).
   */
  measure(name, fn) {
    checkRuleName(this, name, true); this.measures.set(name, fn);
    return { remove: () => { if (this.measures.get(name) === fn) this.measures.delete(name); } };
  }
  /**
   * The current value of a measure (debug, tests); undefined when none is registered under that name
   * @param {string} name
   * @returns {number | undefined}
   */
  value(name) { return this.measures.get(name)?.(this.engine); }
  /**
   * Does a rule's `when` hold now? An object needs every key to hold (condition keys, or measure comparisons); a function gets
   * (engine, ...extra); missing = always.
   * @param {AudioCondition | undefined} when
   * @param {...any} extra
   * @returns {boolean}
   * @example engine.audio.matches({ time: 'night', zone: 'forest', rain: { lt: 0.2 } });
   * @experimental
   */
  matches(when, ...extra) { return matchesWhen(this, when, extra); }
  /**
   * A rule's volume now: a number, a function (engine, ...extra), or data { base, add: { measure: factor }, min, max }; missing = 1
   * @param {AudioVolume | undefined} volume
   * @param {...any} extra
   * @returns {number}
   * @example engine.audio.volumeOf({ base: 0, add: { rain: 0.22 } });   // 0.22 in full rain
   * @experimental
   */
  volumeOf(volume, ...extra) { return volumeOf(this, volume, extra); }
  /**
   * @internal content.load hands each pack's audio table here (audioRules.js packAudio): sounds / footsteps merge into config, rules go to
   * ambience() / music() through onPack; a pack loaded again under the same key replaces its rules
   * @param {any} key  'pack:<name>', or the pack's data object for an unnamed pack (loading the same object again replaces its rules)
   * @param {string} from  'pack "forest"' for messages
   * @param {any} data
   */
  contentPack(key, from, data) {
    for (const [n, v] of Object.entries(data?.sounds || {})) soundDef(n, v);   // same early check for a content pack's rules
    const p = packAudio(this, data, from);
    Object.assign(this.config.sounds, p.sounds); Object.assign(this.config.footsteps, p.footsteps);
    const pack = { from, ambience: p.ambience, music: p.music };
    this.packs.set(key, pack);
    for (const fn of this._packWatch) fn(key, pack);
  }
  /**
   * @internal A failed content load puts this pack back as it was (core/base/sections.js undo): the function that does it. Tracks music took stay defined, unnamed by any rule
   * @param {any} key  as contentPack @returns {() => void}
   */
  keepPack(key) {
    const { sounds, footsteps } = this.config, was = [{ ...sounds }, { ...footsteps }], pack = this.packs.get(key);
    return () => {
      [sounds, footsteps].forEach((t, i) => { for (const k of Object.keys(t)) delete t[k]; Object.assign(t, was[i]); });
      if (pack) this.packs.set(key, pack); else this.packs.delete(key);
      const rules = pack ?? { from: '', ambience: [], music: { tracks: {}, rules: [] } };
      for (const fn of this._packWatch) fn(key, rules);
    };
  }
  /** @internal ambience() / music() follow content packs' rules: fn(key, pack) per pack, now for each loaded one and later for new ones */
  onPack(fn) {
    for (const [k, p] of this.packs) fn(k, p);
    this._packWatch.add(fn); return { remove: () => this._packWatch.delete(fn) };
  }

  /**
   * Play a sound by name: its audio.sounds rule (src / variants, volume, bus...), or with no rule the asset pack sound of that name (file or synth
   * function from assets.manifest({ sounds })). Returns a SoundHandle (stop, fade, setPosition), or null when it is silent: not configured, a
   * built-in synth the game did not name, audio still locked, or held back by the sound's cooldown. Over its `voices` limit the oldest voice stops.
   * @param {string} name
   * @param {{ volume?: number, pitch?: number, at?: any, bus?: string, loop?: boolean, params?: Record<string, any>, fadeIn?: number }} [opts]
   *   at: a position or an Object3D to follow (3D sound); params: extra synth params
   * @returns {SoundHandle | null}
   * @example engine.audio.sfx('hit', { at: enemy.root, volume: 0.8 });
  */
  sfx(name, opts = {}) { return playSound(this, name, opts); }
  /** @internal per frame (loop.js): positional voices follow their objects and the listener follows the camera; nothing to do without them */
  _tick() {
    if (!this._spatial.size || !this.ctx) return;
    placeListener(this.ctx, this.engine.camera);
    for (const v of this._spatial) { if (!v.playing) this._spatial.delete(v); else if (v.follow) v.setPosition(v.follow); }
  }
  /**
   * What is playing (describe().audio shows it while something is ducked or playing): bus levels, the duck multiplier per bus, live voices per sound name.
   * ducks is the level the active ducks ask for (1 = not lowered), read at once even while a fade is still ramping or the audio clock does not run (headless page).
   * reverb (only once reverb() was called): its targets, `place` while an ambience rule sets wet, `built` once audio unlocked.
   * @returns {{ running: boolean, state: string | null, levels: Record<string, number>, ducks: Record<string, number>, voices: Record<string, number>, reverb?: { wet: number, decay: number, size: number, sends: Record<string, number>, place?: number, built: boolean } }}
   * @example engine.audio.duck({ music: 0.3 }); engine.audio.info.ducks.music   // 0.3
   */
  get info() { return audioInfo(this); }

  /**
   * Synth building block: a burst of filtered noise (footsteps, shutter, rain, thunder). dur seconds, freq Hz, vol 0-1; out: the node to
   * connect to (a synth's `out`), else the named bus
   * @param {{ dur?: number, type?: string, freq?: number, vol?: number, bus?: string, out?: any, rate?: number, delay?: number }} [opts]
   * @returns {void}
  */
  noiseBurst(opts = {}) { synthNoise(this, opts); }
  /**
   * Synth building block: a short tone (bird call, notification). freq/to Hz, dur seconds, pan -1..1; out as in noiseBurst
   * @param {{ freq?: number, to?: number | null, dur?: number, vol?: number, type?: string, bus?: string, out?: any, delay?: number, pan?: number }} [opts]
   * @returns {void}
   * @example engine.audio.tone({ freq: 660, to: 880, dur: 0.15, bus: 'ui' });
  */
  tone(opts = {}) { synthTone(this, opts); }

  // ---------- audio files ----------
  /**
   * Download and decode an audio file, as an engine.loading task: a path or a sound name from an asset pack (manifest sounds), so sounds entries and music
   * tracks may name assets instead of paths. engine.assets caches it: short effects stay; long sounds go with assets.release / trim or over a memory budget, and load again on next use
   * @param {string} url  a file path or an asset pack sound name
   * @returns {Promise<any>}
   */
  load(url) { return loadSound(this, url); }
  /**
   * Play an audio file by path (no sounds entry needed); resolves to a SoundHandle once the file is decoded
   * @param {string} url
   * @param {{ bus?: string, volume?: number, loop?: boolean, fadeIn?: number, pitch?: number, at?: any }} [opts]
   * @returns {Promise<SoundHandle | null>} null only without Web Audio; called before the first click it still resolves and the sound starts once audio unlocks
   * @example const h = await engine.audio.play('/sfx/door.ogg', { bus: 'ui' }); h.stop({ fade: 0.5 });
  */
  play(url, opts = {}) { return playFile(this, url, opts); }
}

export const handRolled = [{ kind: 'audio', seen: 'an AudioContext / Audio element of its own', use: 'engine.audio: engine.audio.play(url, { bus, volume }) or named sounds, with buses and volume settings (recipe 31)', code: /\bnew\s+(?:window\.)?(?:AudioContext|webkitAudioContext)\b|\bnew\s+Audio\s*\(/ }];
