// The one reverb (helper of Audio.js, engine.audio.reverb): a send/return on the bus graph. Each bus that sends taps its own output (after its
// level and duck, so the settings slider and a duck lower the echo with the dry sound) into one ConvolverNode, whose return goes into master
// (the master slider covers it). Off until the game calls reverb(); nothing is built before that, and nothing plays through it the game did not send.
// Why one convolver with a generated impulse: decaying noise is the classic cheap room (Moorer; Tone.js Reverb does the same), the convolution
// runs on the audio thread at a fixed cost however many sounds send, and no impulse file has to ship. One reverb, not one per zone: a place
// changes how much comes back (wet), not the room's build, and rebuilding the impulse is the only expensive step (only size / decay do it).
// Details: docs/plans/research/2026-11-10-reverb-lit-particles.md.
import { codedError } from '../base/errorHints.js';
import { readParams } from '../base/params.js';

const REVERB_PARAMS = {
  wet: { type: 'number', optional: true, min: 0, max: 1, desc: 'how much of the echo comes back, 0-1' },
  decay: { type: 'number', optional: true, min: 0.1, max: 10, desc: 'seconds the echo takes to fall 60 dB' },
  size: { type: 'number', optional: true, min: 0, max: 1, desc: 'room size 0-1: the gap before the echo (0-80 ms) and how slowly it builds' },
  sends: { type: 'object', optional: true, desc: 'bus -> how much of it goes in, 0-1 (0 stops that send)' },
  fade: { type: 'number', optional: true, min: 0, desc: 'seconds a wet or send change takes' },
};
const DEFAULTS = { wet: 0.3, decay: 2, size: 0.5 };

/** Stereo decaying noise: silent for the pre-delay, a short build, then exp fall to -60 dB at `decay`, darkening as it goes (a one-pole low-pass closing) */
function impulse(ctx, size, decay) {
  const sr = ctx.sampleRate, pre = size * 0.08, build = 0.004 + size * 0.03, len = Math.ceil((pre + decay) * sr), buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let y = 0;
    for (let i = Math.floor(pre * sr); i < len; i++) {
      const t = i / sr - pre, env = Math.exp(-6.9 * t / decay) * Math.min(1, t / build), a = 1 - 0.8 * Math.min(1, t / decay);
      y += a * ((Math.random() * 2 - 1) - y);   // presentation: the noise of the room
      d[i] = y * env;
    }
  }
  return buf;
}

export class Reverb {
  /** @param {any} audio the engine's Audio */
  constructor(audio) {
    this.audio = audio;
    /** what the game asked for */ this.set = { ...DEFAULTS, sends: {} };
    /** wet a place asks for (ambience reverb rules), over the game's own while it holds; null = none */ this.place = null;
    this.nodes = null;
  }
  get wet() { return this.place ?? this.set.wet; }

  /** Merge new settings, check sends name buses, and apply them to the live graph (or keep them for when audio unlocks) */
  configure(opts, where) {
    const o = readParams(where, REVERB_PARAMS, opts), s = this.set, rebuild = (o.size != null && o.size !== s.size) || (o.decay != null && o.decay !== s.decay);
    for (const [bus, v] of Object.entries(o.sends || {})) {
      this.audio._bus(bus);   // an unknown bus throws with the fix
      if (!(v >= 0 && v <= 1)) throw codedError('engine-misuse', `${where}: sends.${bus} is how much of the bus goes into the reverb, 0-1; got ${JSON.stringify(v)}`);
    }
    for (const k of ['wet', 'decay', 'size']) if (o[k] != null) s[k] = o[k];
    Object.assign(s.sends, o.sends);
    // only what this call names moves: a wet change must not restart a send's fade, nor a send change the wet's
    if (this.nodes) { if (rebuild) this._impulse(); if (o.wet != null) this._wet(o.fade ?? 0); for (const bus of Object.keys(o.sends || {})) this._send(bus, o.fade ?? 0); }
  }

  /** Build the graph on the unlocked context (Audio._init, or configure after unlock) */
  build() {
    const ctx = this.audio.ctx; if (!ctx || this.nodes) return;
    const input = ctx.createGain(), out = ctx.createGain();
    out.gain.value = this.wet; out.connect(this.audio.master);
    this.nodes = { input, out, conv: null, sends: {} };
    this._impulse(); this._wet(0);
    for (const bus of Object.keys(this.set.sends)) this._send(bus, 0);
  }
  /** A new convolver with a new impulse (a ConvolverNode's buffer is set once per node in older browsers): swapped in, the old one let go */
  _impulse() {
    const ctx = this.audio.ctx, n = this.nodes, conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, this.set.size, this.set.decay);
    n.input.disconnect(); n.conv?.disconnect();
    n.input.connect(conv).connect(n.out); n.conv = conv;
  }
  /** @internal a gain toward v: at once, or over about fade seconds */
  _to(p, v, fade) { const t = this.audio.ctx.currentTime; if (fade > 0) p.setTargetAtTime(v, t, fade / 3); else p.setValueAtTime(v, t); }
  /** The return level toward the wet in force (the place's, else the game's) */
  _wet(fade) { this._to(this.nodes.out.gain, this.wet, fade); }
  /** One bus's send toward its amount. The node is made once per bus and kept (with its tap, so off() can cut both ends); a bus with no node
   * yet (added later) is linked when it is made */
  _send(bus, fade) {
    const n = this.nodes, tap = this.audio._duckNodes[bus]; if (!tap) return;
    let s = n.sends[bus];
    if (!s) { const g = this.audio.ctx.createGain(); g.gain.value = 0; tap.connect(g).connect(n.input); s = n.sends[bus] = { g, tap }; }
    this._to(s.g.gain, this.set.sends[bus], fade);
  }
  /** A bus was made (addBus after unlock): link its send if the game named it */
  busMade(name) { if (this.nodes && name in this.set.sends) this._send(name, 0); }
  /** A bus was removed: its send node goes with it (the bus's own disconnect already cut the tap) */
  busGone(name) { const s = this.nodes?.sends[name]; if (!s) return; s.g.disconnect(); delete this.nodes.sends[name]; }
  /** A place's wet (ambience reverb rules) or null to give the game's back: the wet only, sends keep their own fades */
  setPlace(v, fade) { if (v === this.place) return; this.place = v; if (this.nodes) this._wet(fade); }
  /** Off: every node is disconnected at both ends (the bus's tap -> send too, or each off / on would leave one more dead branch on the live bus) and dropped */
  off() {
    const n = this.nodes; if (!n) return;
    for (const { g, tap } of Object.values(n.sends)) { try { tap.disconnect(g); } catch { /* the bus was removed meanwhile */ } g.disconnect(); }
    n.input.disconnect(); n.conv?.disconnect(); n.out.disconnect(); this.nodes = null;
  }
  /** What info shows: the targets asked for (the audio clock may stand still on a headless page) and whether the graph is built */
  get info() { return { wet: this.wet, decay: this.set.decay, size: this.set.size, sends: { ...this.set.sends }, ...(this.place != null ? { place: this.place } : {}), built: !!this.nodes }; }
}
