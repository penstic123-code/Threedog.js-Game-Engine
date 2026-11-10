// engine.time: the one time source. Every other time in the engine is a read-only view of what this module counts.
//   engine.time.tick                  fixed steps run (the gameplay timeline: commits, op history, input records); stops while frozen
//   engine.time.now('real')           tick / 60 (+ the part of a skip shorter than one step): no scale, stops while frozen. Cooldowns that ignore bullet time
//   engine.time.now('ambient')        wind, water, clouds (= uniforms.uTime): moves while frozen too, unless a freezer asked freeze(owner, { still: true })
//   engine.time.now('world' | 'player' | 'enemies' ...)   channel seconds: each step adds 1/60 x the channel's speed. Movement, AI, status effects
//   engine.time.now('calendar')       calendar seconds = world seconds x the calendar rate (stack 'clock.rate'); engine.clock.now is the same number
// Channel speeds change only through engine.mod (core/ops/stacks.js):
//   engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });          // bullet time: enemies at 35% for 2 real seconds
//   engine.mod('time.local', { owner: 'stopwatch', id: 'e1', set: 0, layer: 'effect' });      // stop one record only
//   engine.onFixed(dt => moveEnemies(dt), { channel: 'enemies' });                     // this dt is already scaled
// Timers: one queue for every channel, written as engine.clock.after(s, fnOrEvent, { data, channel }) / clock.every (default channel 'calendar').
//
// Why one source: separate counters for real seconds, shader time, channels and the calendar, each added to and zeroed in its own place, drift
// apart (a skip that moves some, a new game that zeroes some; review 0.4, B). So only this file adds to any of them, and three entry points move them together: a fixed step (_beginStep / _endStep), engine.skip
// (_skip), and a new playthrough (_restart). A spec greps core/ and modules/ so no second counter comes back.
// Freeze is not "scale 0": a frozen engine runs no fixed step at all (loop.js), so tick, real, channels and timers stay put; only ambient moves.
// A plain onFixed without { channel } gets real seconds (always 1 / 60), so cooldowns and UI are never slowed by accident.
// Built in: world (the root), player (parent world), calendar (parent world, speed 'clock.rate'). Physics (rapier) steps with dt('world'): to slow enemies and leave bodies alone, slow a channel of their own, not world.
import { codedError } from '../base/errorHints.js';
import { reportError } from '../base/errors.js';
import { saveValues, SAVE_MAX_SECONDS } from '../base/saveValues.js';

export const STEP = 1 / 60;
const STRINGS = { where: 'clock timer', onMove: 'time.onMove listener' };
const EPS = 1e-9;   // float sums of STEP x scale land a hair short of a whole second: due within 1e-9 counts as due

export class Time {
  constructor(engine) {
    this.engine = engine;
    /** @internal whole fixed steps (public: tick) */ this._tick = 0;
    /** @internal real seconds a skip moved past the last whole step (< STEP): kept so real stays exact after a skip */ this._carry = 0;
    /** @internal ambient seconds (public: now('ambient'), uniforms.uTime) */ this._amb = 0;
    /** @type {Map<string, { name: string, parent: string | null, now: number, stack: string }>} */
    this._ch = new Map();
    /** @internal listeners of onMove */ this._onMove = [];
    /** @internal the one timer queue: { ch, due, fn?, event?, data?, every?, dead? } (due is in that channel's seconds) */ this._timers = [];
    /** @internal saved now of channels the game has not defined yet (a load before channel()): applied when it does */ this._pending = {};
    this._local = engine.stacks.define('time.local', { per: true, min: 0 });
    engine.stacks._nowOf = name => this.now(name);
    this.channel('world', { parent: null });
    this.channel('player');
    this.channel('calendar', { stack: 'clock.rate' });
    engine.saves.define('time', { notAtomic: 'time goes on through a failed op: going back would run timers twice',
      version: 2,
      // v1 kept the calendar in its own 'clock' part ({ now, timers }); v2 has it as the 'calendar' channel of this part
      migrate: { 1: (d, save) => {
        const c = save?.parts?.clock ?? {};
        return { channels: { ...(d?.channels ?? {}), calendar: c.now ?? 0 },
          timers: [...(d?.timers ?? []), ...(Array.isArray(c.timers) ? c.timers : []).map(t => ({ ...t, channel: 'calendar' }))] };
      } },
      // real: 'real' timers count on a clock no save restores (a new playthrough starts it from 0), so load shifts them by how far it moved
      // _pending: channels of the loaded save the game has not defined yet stay in the next save
      save: () => ({ channels: { ...this._pending, ...Object.fromEntries([...this._ch.values()].map(c => [c.name, c.now])) }, real: this.now('real'),
        timers: this._timers.filter(t => t.event && !t.dead).map(({ ch, due, event, data, every }) => ({ channel: ch, due, event, data, ...(every ? { every } : null) })) }),
      load: d => this._load(d),
    });
  }
  /** @internal the save part: channel seconds and event timers come from the save; function timers (not saveable) keep their time left */
  _load(d) {
    // saved seconds pass saveValues first: a negative / non-finite channel time ran its timers backwards (durability audit); clamped to >= 0, one warning
    const v = saveValues('time'), chans = {};
    for (const [name, now] of Object.entries(d?.channels ?? {})) chans[name] = v.num(now, `channels.${name}`, { min: 0, max: SAVE_MAX_SECONDS, fallback: 0 });
    const timers = (Array.isArray(d?.timers) ? d.timers : []).filter(t => {
      if (Number.isFinite(t?.due) && typeof t.event === 'string' && typeof t.channel === 'string') return true;
      v.drop('timers[]', t); return false;
    });
    v.done();
    // in the save but not yet defined by the game (channel('enemies') only after load): note it down, fill in when channel() defines it
    this._pending = {};
    for (const [name, now] of Object.entries(chans)) if (!this._ch.has(name)) this._pending[name] = now;
    const delta = {};
    for (const c of this._ch.values()) { const now = chans[c.name] ?? 0; delta[c.name] = now - c.now; c.now = now; this.engine.stacks._rebase(c.name, delta[c.name]); }
    const fn = this._timers.filter(t => !t.event && !t.dead);
    for (const t of fn) t.due += delta[t.ch] ?? 0;
    const shift = Number.isFinite(d?.real) ? this.now('real') - d.real : 0;
    this._timers = fn.concat(timers.map(({ channel, due, event, data, every }) => ({ ch: channel, due: channel === 'real' ? due + shift : due, event, data, every: every > 0 ? every : 0 })));
  }
  /**
   * Define a channel (its speed stack is 'time.<name>'). parent: the channel whose speed it multiplies (default 'world').
   * @param {string} name @param {{ parent?: string | null, stack?: string }} [o]
   * @example engine.time.channel('enemies');  engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });
   */
  channel(name, { parent = 'world', stack = 'time.' + name } = {}) {
    if (this._ch.has(name)) return this;
    if (name === 'real' || name === 'ambient') throw codedError('unknown-name', `engine.time.channel('${name}'): '${name}' is a built-in view of the time source, pick another name`);
    if (parent != null && !this._ch.has(parent)) throw codedError('unknown-name', `engine.time.channel('${name}', { parent: '${parent}' }): no channel '${parent}'. Channels: ${this.channels().join(', ')}`);
    const saved = this._pending[name]; delete this._pending[name];
    // put now in place before defining the speed stack: entries in the stack saved against this channel's clock restore the remaining time from its now
    this._ch.set(name, { name, parent, now: saved ?? 0, stack });
    this.engine.stacks.define(stack, { min: 0 });
    return this;
  }
  /**
   * Call fn() right after the channels moved (each fixed step, each engine.skip segment; not while frozen), before timed mods end and timers fire.
   * For views derived from a channel: the calendar's day and time of day are read from the 'calendar' channel, and its day:start fires here.
   * @param {() => void} fn
   * @returns {{ remove(): void }}
   * @example ctx.track(engine.time.onMove(() => { if (engine.clock.now > nextTide) tide.turn(); }))
   */
  onMove(fn) {
    this._onMove.push(fn);
    return { remove: () => { const i = this._onMove.indexOf(fn); if (i >= 0) this._onMove.splice(i, 1); } };
  }
  /** Channel names */
  channels() { return [...this._ch.keys()]; }
  /** @internal */
  _get(name) {
    const c = this._ch.get(name);
    if (!c) throw codedError('unknown-name', `engine.time: no channel '${name}'. Channels: real, ambient, ${this.channels().join(', ')}; add one with engine.time.channel('${name}')`);
    return c;
  }
  /**
   * The effective speed of a channel (parent x its own stack), times the record's own stack when id is given. Read-only: change it with engine.mod.
   * @param {string} name @param {string} [id]
   */
  scale(name, id) {
    if (name === 'real' || name === 'ambient') return 1;
    const c = this._get(name);
    let s = (c.parent ? this.scale(c.parent) : 1) * this.engine.stacks.get(c.stack).value();
    if (id != null) s *= this._local.value(id);
    return s;
  }
  /** Fixed steps run since the start of this playthrough (the one counter; read-only) */
  get tick() { return this._tick; }
  /** Seconds on a view: 'real', 'ambient', 'calendar' or a channel @param {string} name */
  now(name) {
    if (name === 'real') return this._tick * STEP + this._carry;
    if (name === 'ambient') return this._amb;
    return this._get(name).now;
  }
  /** This fixed step's dt on a channel (STEP x scale), for a record when id is given @param {string} name @param {string} [id] */
  dt(name, id) { return STEP * this.scale(name, id); }

  // ---------- the one timer queue (public form: engine.clock.after / every) ----------
  /**
   * @internal Add a timer on a view ('real', a channel, 'calendar'). Returns { remove() }.
   * Why remove() marks the timer dead as well as dropping it: the step that fires timers takes its due list first, so a timer removed by an
   * earlier callback in that same list used to fire anyway (review 0.4, B). A dead timer never fires, whatever list it is in.
   */
  _add(ch, seconds, fnOrEvent, data, every = 0) {
    if (ch !== 'real') this._get(ch);
    const t = typeof fnOrEvent === 'string' ? { ch, due: this.now(ch) + seconds, event: fnOrEvent, data, every, dead: false }
      : { ch, due: this.now(ch) + seconds, fn: fnOrEvent, every, dead: false };
    this._timers.push(t);
    return { _timer: t, remove: () => { t.dead = true; this._timers = this._timers.filter(x => x !== t); } };   // _timer: ctx.track files it with its module (Session._keepTimer)
  }
  /** Timers in the queue (engine.counts) */
  get size() { return this._timers.length; }
  /** @internal timers fire per view in this order: real, the channels as defined, the calendar last (calendar timers see this step's channel results) */
  _fireOrder() { const names = this.channels().filter(n => n !== 'calendar'); return ['real', ...names, 'calendar']; }
  /** @internal */
  _runTimers() {
    if (!this._timers.length) return;
    for (const ch of this._fireOrder()) {
      const at = this.now(ch) + EPS;
      const due = this._timers.filter(t => t.ch === ch && t.due <= at).sort((a, b) => a.due - b.due);
      if (!due.length) continue;
      this._timers = this._timers.filter(t => !(t.ch === ch && t.due <= at) || t.every);
      for (const t of due) {
        if (this.engine.disposed) return;   // a callback of this list disposed the engine: dispose cannot reach the ones already taken out of the queue
        if (t.every) { while (!t.dead && t.due <= at) { t.due += t.every; this._call(t); } continue; }
        if (!t.dead) { t.dead = true; this._call(t); }
      }
    }
  }
  /** @internal a callback that throws is a gameplay error; the other timers still run */
  _call(t) {
    if (t.event) { this.engine.events.emit(t.event, t.data); return; }
    try { t.fn(); } catch (err) { reportError(this.engine, err, STRINGS.where); }
  }
  /** @internal engine.session: the function timers now, each with its time left (what a new playthrough starts with) @returns {{ t: any, rem: number }[]} */
  _snapshotFn() { return this._timers.filter(t => !t.event && !t.dead).map(t => ({ t, rem: t.due - this.now(t.ch) })); }
  /** @internal engine.session: keep the event timers (they came with the save) and function timers set since `old` was taken, drop the rest, put back the snapshotted `list` with its original delay */
  _restoreFn(list, old) {
    const gone = new Set([...old, ...list].map(x => x.t));
    this._timers = this._timers.filter(t => t.event || !gone.has(t)).concat(list.map(({ t, rem }) => Object.assign(t, { due: this.now(t.ch) + rem, dead: false })));
  }

  // ---------- the three ways time moves ----------
  /** @internal loop.js, at the start of a fixed step: count it, so this step's commits, ops and input records carry the new tick */
  _beginStep() { this._tick++; }
  /** @internal loop.js, after the step's gameplay: everything else moves by one step (real already moved with the tick) */
  _endStep() { this._move(STEP, null); }
  /** @internal loop.js, a frozen step: only ambient moves (and not even that while a freezer holds ambient) */
  _frozenStep(ambient) { if (ambient) this._setAmbient(this._amb + STEP); }
  /**
   * @internal engine.skip, one segment: `fixed` fixed seconds as if stepped (tick and real too, so skip and stepping agree on every view);
   * calendar = the calendar seconds of the segment when skip measured it itself (exact segment ends; a stopped calendar skips as if at 1x).
   */
  _skip(fixed, calendar) {
    const c = this._carry + fixed, n = Math.floor(c / STEP + EPS);
    this._tick += n; this._carry = Math.max(0, c - n * STEP);
    this._move(fixed, calendar);
  }
  /**
   * @internal engine.session (new game / load / quit): tick, real and ambient start from 0 like a fresh page (channels and the calendar come
   * from the save part). Returns undo(): a refused or rolled-back load puts them back, else 'real' mods and shader time restart mid-play.
   */
  _restart() {
    const was = [this._tick, this._carry, this._amb], real = this.now('real'), S = this.engine.stacks;
    this._tick = 0; this._carry = 0; this._setAmbient(0);
    S._rebase('real', -real);   // an entry no save holds (a system-layer mod, a gate) keeps its time left
    return () => { [this._tick, this._carry] = was; this._setAmbient(was[2]); S._rebase('real', real); };
  }
  /** @internal engine.checkSkip: returns undo(), which puts real back where it is now. A load cannot: no save restores this clock, it only shifts 'real' timers by what moved */
  _mark() { const was = [this._tick, this._carry]; return () => { [this._tick, this._carry] = was; }; }
  /** @internal */
  _setAmbient(v) { this._amb = v; const u = this.engine.uniforms?.uTime; if (u) u.value = v; }   // uTime is this view, written only here
  /**
   * @internal Move ambient, channels and the calendar by `fixed` fixed seconds, end timed mods, fire timers.
   * Speeds are read once before anything moves, so every channel advances with the scales this step's gameplay saw; then timed mods end
   * (earliest first, mod:end each), then timers fire.
   */
  _move(fixed, calendar) {
    const scales = [...this._ch.values()].map(c => [c, this.scale(c.name)]);
    this._setAmbient(this._amb + fixed);
    for (const [c, s] of scales) c.now += c.name === 'calendar' && calendar != null ? calendar : fixed * s;
    for (const fn of [...this._onMove]) { if (!this._onMove.includes(fn)) continue; /* removed earlier in this pass, or by a dispose */ try { fn(); } catch (err) { reportError(this.engine, err, STRINGS.onMove); } }
    if (this.engine.disposed) return;
    this.engine.stacks._expire();
    this._runTimers();
  }
  /**
   * @internal engine.skip: calendar seconds until the next timer or timed mod is due, at the current speeds (a segment ends there so they fire in
   * the same order as when stepping). gamePerFixed = calendar seconds per fixed second of the skip.
   */
  _untilNext(gamePerFixed) {
    const toGame = (ch, left) => {
      if (ch === 'calendar') return left;
      const s = this.scale(ch); return s > 0 ? left / s * gamePerFixed : Infinity;
    };
    let best = Infinity;
    // a loaded timer can name a channel the game has not defined yet: it cannot fire, so it ends no segment
    for (const t of this._timers) if (t.ch === 'real' || this._ch.has(t.ch)) best = Math.min(best, toGame(t.ch, Math.max(0, t.due - this.now(t.ch))));
    return Math.min(best, this.engine.stacks._untilNext(toGame));
  }
  /** describe().time.channels: { name: { scale, now, holders? } } */
  describe() {
    const out = {};
    for (const c of this._ch.values()) {
      const h = this.engine.stacks.get(c.stack).holders();
      out[c.name] = { scale: Math.round(this.scale(c.name) * 1000) / 1000, now: Math.round(c.now * 100) / 100, ...(h.length ? { holders: h } : {}) };
    }
    return out;
  }
  /** Clear all timers and move listeners (engine.dispose) */
  dispose() { for (const t of this._timers) t.dead = true; this._timers = []; this._onMove = []; }
}
