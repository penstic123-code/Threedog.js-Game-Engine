// One playing sound (a "voice") of engine.audio.sfx / play: source -> voice gain -> [panner] -> bus.
// Split out of Audio.js so the bus / config side and the per-sound side each stay small enough to read in one go.
// Randomness here (variant pick, jitter) only changes what is heard, never gameplay, so it uses Math.random and carries // presentation.
import * as THREE from 'three';
import { xzOf } from '../base/math.js';
import { warnOnce, fmt } from '../base/validate.js';
import { readParams, keysSchema } from '../base/params.js';
import { codedError } from '../base/errorHints.js';
import { isObject } from '../base/util.js';

const SFX_KEYS = ['volume', 'pitch', 'at', 'bus', 'loop', 'params', 'fadeIn'];
const jit = (v, j) => v * (1 + (Math.random() * 2 - 1) * (j || 0));   // presentation
const SOUND_KEYS = ['src', 'params', 'bus', 'volume', 'pitch', 'jitter', 'cooldown', 'voices', 'loop', 'distance'];
// a sound handle's fade / stop take options like music.play / stop (one call shape for every audio verb)
const FADE_PARAMS = { to: { type: 'number', min: 0, desc: 'target volume 0-1' }, seconds: { type: 'number', default: 0.5, min: 0, desc: 'fade length in seconds' } };
const STOP_PARAMS = { fade: { type: 'number', default: 0.05, min: 0, desc: 'fade-out in seconds (0 = at once)' } };
const SYNTH_GONE = "audio.sounds.{name}: {what} is gone. A synth is an asset now: register the function in assets.manifest({ sounds: { {src}: fn } }) "
  + "(engine modules' footstep / shutter / thunder / ambience synths are already registered under their names) and write {name}: {fix}";

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * Normalize a sounds rule: string / string[] / { src, ... } -> { src, ... }; no src = the asset of the rule's own name. The old synth forms throw
 * with the fix: one way to say where a sound comes from (the manifest), so a rule never names a synth by another route. @internal
 */
export function soundDef(name, v) {
  if (v == null) return null;
  if (v === 'synth') throw codedError('audio-synth-gone', fmt(SYNTH_GONE, { name, what: "'synth'", src: name, fix: `'${name}' (or {} with volume, bus...)` }));
  if (isObject(v) && 'synth' in v) throw codedError('audio-synth-gone',
    fmt(SYNTH_GONE, { name, what: '{ synth }', src: v.synth, fix: `{ src: '${v.synth}', params, ... }` }));
  if (typeof v === 'string' || Array.isArray(v)) return { src: v };
  return v.src == null ? { ...v, src: name } : v;
}

/** The synth behind a sound asset name: { fn, params, bus, builtIn } for a manifest sound whose value is a function, else null (a file or unknown) @internal */
function synthOf(audio, src) {
  const a = typeof src === 'string' ? audio.engine.assets.entries.get(src) : null;
  return a?.type === 'sound' && a.opts.build ? { fn: a.opts.build, params: a.opts.params || {}, bus: a.opts.bus, builtIn: !!a.builtIn } : null;
}

/** The rule for a name: its audio.sounds entry, else the asset pack sound of that name; null = silent (a built-in synth the game did not ask for) */
function resolveDef(audio, name) {
  const def = soundDef(name, audio.config.sounds[name]);
  if (def) { readParams(`audio.sounds.${name}`, keysSchema(SOUND_KEYS), def); return def; }
  const asset = audio.engine.assets.entries.get(name);
  if (asset?.type === 'sound' && asset.named) return asset.builtIn ? null : { src: name };   // built-in synths stay silent until a rule names them
  warnOnce(`audio.sfx('${name}'): no sound named ${name}. Register it in an asset pack (engine.assets.manifest({ sounds: { ${name}: '/sfx/${name}.ogg' } }), `
    + `or a synth function), and add a rule to audio.sounds for how it plays (a content pack's audio.sounds or createEngine({ audio: { sounds } }))`);
  return null;
}

/** Pick a variant at random, never the same one twice in a row (a repeated footstep or gunshot sounds mechanical) */
function pickVariant(list, last) {
  if (!Array.isArray(list)) return [list, 0];
  if (list.length < 2) return [list[0], 0];
  let i = Math.floor(Math.random() * (list.length - (last >= 0 ? 1 : 0)));   // presentation
  if (last >= 0 && i >= last) i++;
  return [list[i], i];
}

/** Where a voice sits: a world position ({ x, y, z } / [x, y, z] / Vector3) or an Object3D it follows every frame */
function readPosition(at, out = _v) {
  if (at.isObject3D) return at.getWorldPosition(out);
  if (Array.isArray(at)) return out.set(at[0], at[1] ?? 0, at[2] ?? 0);
  if (at.y === undefined) { const [x, z] = xzOf(at); return out.set(x, 0, z); }
  return out.set(at.x, at.y, at.z);
}
function setParam(p, v, t) { p.setValueAtTime(v, t); }

/** Point the Web Audio listener where the camera is (only called while positional voices exist: zero cost otherwise) */
export function placeListener(ctx, camera) {
  const L = ctx.listener, t = ctx.currentTime;
  camera.getWorldPosition(_v); camera.getWorldDirection(_d); _u.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(_q));   // world up, like the world forward above (a camera inside a rotated rig)
  if (L.positionX) {
    setParam(L.positionX, _v.x, t); setParam(L.positionY, _v.y, t); setParam(L.positionZ, _v.z, t);
    setParam(L.forwardX, _d.x, t); setParam(L.forwardY, _d.y, t); setParam(L.forwardZ, _d.z, t);
    setParam(L.upX, _u.x, t); setParam(L.upY, _u.y, t); setParam(L.upZ, _u.z, t);
  } else { L.setPosition(_v.x, _v.y, _v.z); L.setOrientation(_d.x, _d.y, _d.z, _u.x, _u.y, _u.z); }
}

/** A playing sound. engine.audio.sfx / play return one; the game keeps it to stop, fade or move the sound */
export class SoundHandle {
  /** @internal */
  constructor(audio, name, out, at, distance = {}) {
    const ctx = audio.ctx;
    /** @internal */ this.audio = audio;
    /** Sound name (sfx) or file path (play) */
    this.name = name;
    /** The voice's GainNode (volume of this one sound) @type {any} */
    this.gain = ctx.createGain();
    /** The PannerNode of a positional sound, else null @type {any} */
    this.panner = null;
    /** The AudioBufferSourceNode once a file started (null for synths and while loading) @type {any} */
    this.source = null;
    /** @internal */ this.endsAt = Infinity;
    /** @internal */ this.loop = null;   // a synth loop's { stop(t) }
    /** @internal */ this.follow = null;
    if (at) {
      const p = this.panner = ctx.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = distance.ref ?? 2; p.maxDistance = distance.max ?? 60; p.rolloffFactor = distance.rolloff ?? 1;
      this.gain.connect(p).connect(out);
      this.setPosition(at);
      audio._spatial.add(this);
    } else this.gain.connect(out);
  }
  /** Still sounding (not stopped and not finished)? @returns {boolean} */
  get playing() { return !this._stopped && this.audio.ctx != null && this.audio.ctx.currentTime < this.endsAt; }
  /**
   * Move a positional sound: a position, or an Object3D to follow every frame (no effect on a non-positional sound)
   * @param {any} at
   * @returns {this}
   */
  setPosition(at) {
    if (!this.panner) return this;
    this.follow = at?.isObject3D ? at : null;
    const p = readPosition(at), t = this.audio.ctx.currentTime, n = this.panner;
    if (n.positionX) { setParam(n.positionX, p.x, t); setParam(n.positionY, p.y, t); setParam(n.positionZ, p.z, t); } else n.setPosition(p.x, p.y, p.z);
    return this;
  }
  /**
   * Fade this sound's volume to `to` (0-1) over `seconds` (default 0.5); it keeps playing (use stop to end it). An options object like
   * music.play's: fade(0.2, 1.5) throws in dev
   * @param {{ to: number, seconds?: number }} opts
   * @returns {this}
   * @example h.fade({ to: 0.2, seconds: 1.5 });
   */
  fade(opts) { const o = readParams('sound.fade()', FADE_PARAMS, opts); return this._fade(o.to, o.seconds); }
  /**
   * Stop, fading out over `fade` seconds (default 0.05; 0 = at once). stop(1) throws in dev: stop({ fade: 1 })
   * @param {{ fade?: number }} [opts]
   * @returns {void}
   * @example const h = engine.audio.sfx('engine-hum', { loop: true }); h.stop({ fade: 1 });
   */
  stop(opts) { this._stop(readParams('sound.stop()', STOP_PARAMS, opts).fade); }
  /** Cancel convention (every handle has remove()): the same as stop() @returns {void} */
  remove() { this._stop(STOP_PARAMS.fade.default); }
  /** @internal the engine's own per-frame fades (ambience) skip the option parse */
  _fade(to, seconds) {
    const ctx = this.audio.ctx; if (!ctx || this._stopped) return this;
    const g = this.gain.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(to, t + Math.max(0.01, seconds));
    return this;
  }
  /** @internal */
  _stop(fade) {
    const ctx = this.audio.ctx; if (!ctx || this._stopped) return;
    this._fade(0, fade); this._stopped = true;
    const end = ctx.currentTime + Math.max(0.01, fade) + 0.05;
    try { this.source?.stop(end); } catch { /* already ended: nothing to stop */ }
    this.loop?.stop?.(end);
    this.endsAt = Math.min(this.endsAt, end);
    this.audio._spatial.delete(this);
  }
}

/** Start a synth or file for a voice. Synths get (audio, params, out) and return their length in seconds, or { stop(t) } when looping */
function startSource(audio, voice, def, { pitch, loop, url, synth, params }) {
  const ctx = audio.ctx;
  if (!synth) {
    audio.load(url).then(buf => {   // url: a file, or a sound name from an asset pack (audio.load resolves it)
      if (!buf) { voice.endsAt = 0; voice.failed = true; return; }   // an asset that failed and fell back to silence (engine.loading has the error)
      if (voice._stopped || !audio.ctx) return;
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = loop; s.playbackRate.value = pitch;
      s.connect(voice.gain); s.start(); voice.source = s;
      voice.endsAt = loop ? Infinity : ctx.currentTime + buf.duration / pitch;
    }).catch(err => { voice.endsAt = 0; voice.failed = true; audio._warn(err.message); });   // failed: rule loops (ambience) read it and stop retrying
    return;
  }
  const r = synth.fn(audio, { ...synth.params, ...def.params, ...params, pitch, loop }, voice.gain);
  if (r && typeof r === 'object') voice.loop = r;
  else voice.endsAt = typeof r === 'number' ? ctx.currentTime + r : loop ? Infinity : ctx.currentTime + 1;   // a one-shot synth asked to loop still ends
}

/** Synth building block behind audio.noiseBurst: a burst of filtered noise */
export function synthNoise(audio, opts) {
  const { dur = 0.1, type = 'bandpass', freq = 1000, vol = 0.2, bus = 'sfx', out, rate = 1, delay = 0 } = opts;
  if (!audio.running) return;
  const ctx = audio.ctx, t0 = ctx.currentTime + delay, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = audio.noise; src.playbackRate.value = rate; f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
  src.connect(f).connect(g).connect(out ?? audio._bus(bus)); src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);   // presentation
}
/** Synth building block behind audio.tone: a short enveloped tone */
export function synthTone(audio, opts) {
  const { freq = 880, to = null, dur = 0.1, vol = 0.05, type = 'sine', bus = 'sfx', out, delay = 0, pan = 0 } = opts;
  if (!audio.running) return;
  const ctx = audio.ctx, t0 = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
  o.type = /** @type {any} */ (type); o.frequency.setValueAtTime(freq, t0); if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.9);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
  p.pan.value = pan;
  o.connect(g).connect(p).connect(out ?? audio._bus(bus)); o.start(t0); o.stop(t0 + dur + 0.02);
}

/** audio.load body: a file sound is an engine.assets entry, by name or by path (a path gets an entry of its own, like a model path), so release, trim and dispose reach it */
export async function loadSound(audio, url) {
  const { assets } = audio.engine, e = assets._resolve(url, 'sound');
  if (e.type !== 'sound') throw codedError('asset-misuse', `audio.load('${url}'): ${url} is registered as a ${e.type}, not a sound. Use a sound entry from assets.manifest({ sounds })`);
  if (e.opts.build) throw codedError('audio-synth-gone', `audio.load('${url}'): ${url} is a synth (a function in the asset pack), not a file: play it with audio.sfx('${url}')`);
  audio._init();
  if (!audio.ctx && !e.named) throw codedError('audio-unsupported', 'Audio is not supported by this browser; check typeof AudioContext before calling');   // a named sound falls back to silence
  e.usedAt = performance.now();   // presentation: which long sound goes first when memory is over budget (assetEntry.js)
  return assets._fetch(e);
}
/** audio.play body: a file by path or asset name, no sounds entry needed */
export async function playFile(audio, url, opts) {
  readParams('audio.play()', keysSchema(['bus', 'volume', 'loop', 'fadeIn', 'pitch', 'at']), opts);
  const { bus = 'sfx', volume = 1, loop = false, fadeIn = 0, pitch = 1, at } = opts;
  // create the (suspended) context now: a voice needs one, and without Web Audio there is nothing to play. The sound starts when the first click / key resumes it
  audio._init();
  if (!audio.ctx) return null;   // no Web Audio in this browser: nothing to play (audio.load still throws with the fix)
  const buf = await audio.load(url), ctx = audio.ctx;
  if (!ctx) return null;   // the engine was disposed while the file loaded
  const v = new SoundHandle(audio, url, audio._bus(bus), at);
  const src = ctx.createBufferSource(); src.buffer = buf ?? null; src.loop = loop; src.playbackRate.value = pitch;
  v.gain.gain.value = fadeIn ? 0 : volume; if (fadeIn) v._fade(volume, fadeIn);
  src.connect(v.gain); src.start(); v.source = src; v.endsAt = loop ? Infinity : ctx.currentTime + (buf?.duration ?? 0) / pitch;
  return v;
}
/** audio.sfx body: cooldown, voice limit, variant pick, jitter, then start the source */
export function playSound(audio, name, opts) {
  readParams('audio.sfx()', keysSchema(SFX_KEYS), opts);
  const def = resolveDef(audio, name);
  if (!def || !audio.running) return null;
  const now = audio.ctx.currentTime, last = audio._last.get(name);
  if (def.cooldown && last && now - last.at < def.cooldown) return null;
  const list = (audio._voices.get(name) || []).filter(v => v.playing);
  if (def.voices && list.length >= def.voices) list.shift()._stop(0.03);
  // one variant, then where it comes from: a manifest synth plays its function, anything else is a file (a path or a manifest file sound)
  const [url, variant] = pickVariant(def.src, last?.variant ?? -1), synth = synthOf(audio, url);
  audio._last.set(name, { at: now, variant });
  const bus = audio._bus(opts.bus ?? def.bus ?? synth?.bus ?? 'sfx');
  const v = new SoundHandle(audio, name, bus, opts.at, def.distance);
  const vol = jit((def.volume ?? 1) * (opts.volume ?? 1), def.jitter?.volume), pitch = jit((def.pitch ?? 1) * (opts.pitch ?? 1), def.jitter?.pitch);
  v.gain.gain.value = opts.fadeIn ? 0 : vol; if (opts.fadeIn) v._fade(vol, opts.fadeIn);
  startSource(audio, v, def, { pitch, loop: opts.loop ?? def.loop ?? false, url, synth, params: opts.params });
  list.push(v); audio._voices.set(name, list);
  return v;
}
