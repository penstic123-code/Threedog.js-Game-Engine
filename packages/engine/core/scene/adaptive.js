// Adaptive quality by frame cost: one controller, one ladder of steps.
// When frames cost more than the target allows it lowers one step, when they are cheap it raises the last lowered step back, slowly.
// It judges frame COST (main-thread cpuMs, plus GPU time from EXT_disjoint_timer_query_webgl2 when the browser has it), not fps, because a low fps
// alone is ambiguous: a display or power mode that refreshes at 30 Hz (laptop battery saver, phone low-power mode) gives 33.3 ms frames with
// almost no work, and lowering the picture there only blurs it for nothing. The fps path stays only as the fallback without GPU time
// (a GPU-bound game shows a low cpuMs), and even then a frame interval locked to the display's own refresh does not count as overload.
// Frames that compiled shaders (ApplyCost.rendered reports them) and the first GRACE seconds after ready are not judged: startup hitches are
// one-off costs that lowering cannot fix, and a step that rebuilds the post chain must not judge its own compile.
//
// The ladder (engine.adaptive.steps; docs/plans/2026-11-09-quality-ladder.md): the game says what may be lowered and in which order. Default, cheapest
// to see first (Unity's Adaptive Performance lowers low-visual-impact scalers first): each post effect's own `cheaper` params (live uniforms: no
// recompile), then the resolution, then the effects that declare skipOnLowTier held off (a chain rebuild and a compile: last, and never back and forth,
// see FLAP). No list of expensive effects lives here: an effect declares cheaper / skipOnLowTier itself, the engine follows. Only downward: nothing is
// set above what the game wrote, an effect the player or game has off is not a step, and a hold sits on the 'effect' layer: above the game's own writes, under a cutscene or menu (system) and the player's settings, so their later sets never clash with it.
import { DEV, warnOnce } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';
import { writeRatio } from './pixelRatio.js';

const GRACE = 3;          // s after ready that are not judged (warm-up compiles, first uploads, stream fill)
const WINDOW = 1;         // s of samples per decision
const HEAVY = 0.85;       // cost above this share of the frame budget = overload
const LIGHT = 0.6;        // cost under this share = headroom (raise after RAISE_AFTER windows in a row)
const RAISE_AFTER = 4;
const LOCK_TOL = 0.08;    // intervals within 8 % of the window median count as "clustered"
// a step other than the resolution that comes down again within FLAP s of going up was not affordable: its next raise waits WAIT s, doubled each time.
// Why: the cost with an effect off says nothing about its cost on, so "cheap now" can raise it into the same overload; without this it toggles, and each toggle compiles
const FLAP = 20, WAIT = 15;
const OWNER = 'adaptive';
const HELD = coded('pixel-conflict', 'engine.adaptive.on = true does nothing while pixelSize is on; it comes back with engine.setPixelSize(null)');
const STEP_FORMS = "'resolution', 'post.<name>' (the effect's cheaper params), 'post.<name>.off' (the effect held off) or { name, down(), up() } (down returns false when it cannot go lower)";

/** Adaptive resolution lowered the render scale and it has not climbed back to its top: describe().render.scale's answer
 * @param {any} e @returns {boolean} */
export function autoLowered(e) {
  const a = e.adaptive, cur = e.renderer.getPixelRatio();
  return !!a?.lowered && cur < (a.max ?? cur) - 0.01;
}

/** What the ladder holds lowered now, in one clause, or null: the one report, read by engine.budget.notice() (shot, verify, describe text print it)
 * @param {any} e @returns {string | null} */
export function loweredText(e) {
  const a = e.adaptive;
  if (!a) return null;
  const parts = [...(autoLowered(e) ? [`resolution ${a.max} -> ${Math.round(e.renderer.getPixelRatio() * 100) / 100}`] : []), ...[...a.held.values()].map(s => s.text())];
  return parts.length ? `lowered automatically: ${parts.join(', ')} (${a.reason})` : null;
}

/** @param {any} v */
function checkSteps(v) {
  if (v === null) return v;
  const bad = !Array.isArray(v) ? [v] : v.filter(s => !(s === 'resolution' || (typeof s === 'string' && /^post\.[^.]+(\.off)?$/.test(s))
    || (s && typeof s === 'object' && typeof s.name === 'string' && typeof s.down === 'function' && typeof s.up === 'function')));
  if (bad.length) throw codedError('engine-misuse', `engine.adaptive.steps: a list (first lowered first) of ${STEP_FORMS}; null = the default ladder; got ${JSON.stringify(bad[0]) ?? String(bad[0])}`);
  const keys = v.map(keyOf), twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw codedError('engine-misuse', `engine.adaptive.steps: '${twice}' is listed twice; each step once, in the order it is lowered`);
  return v.slice();
}
const keyOf = s => (typeof s === 'string' ? s : `game.${s.name}`);

/**
 * The engine.adaptive state object: the public fields (on, target, min, max, base, lowered, from, steps; base is what this device or game starts at, the settings presets' base) plus the
 * controller's own counters. on is an accessor because every reader (the loop's GPU timer, describe, settings) must see false under pixelSize; what was asked for stays and returns with setPixelSize(null).
 * held: what the ladder lowers now besides the resolution, key -> { text, undo }; the resolution needs no entry (renderer ratio against max says it).
 * @param {{ on: boolean, target: number, max: number, held: () => boolean }} o held: pixelSize decides the ratio now
 */
export function createAdaptive({ on, target, max, held }) {
  let wanted = on, steps = null;
  return { get on() { return wanted && !held(); },
    set on(v) { wanted = v; if (DEV && v && held()) warnOnce(HELD); },
    get steps() { return steps; }, set steps(v) { steps = checkSteps(v); },
    target, min: 0.6, max, base: max, t: 0, good: 0, cooldown: 0, lowered: false, from: null,
    age: 0, costs: [], gaps: [], refresh: Infinity, reason: null, held: new Map(), raisedAt: {}, wait: {}, notBefore: {}, warned: false };
}

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** The default ladder: from the effects added now, in chain order @param {any} e */
function defaultSteps(e) {
  const fx = e.post?._sorted?.() ?? [];
  return [...fx.filter(h => h._def.cheaper).map(h => `post.${h.name}`), 'resolution', ...fx.filter(h => h._def.skipOnLowTier).map(h => `post.${h.name}.off`)];
}

/**
 * One step as { key, down(), lowered(), up() }. down() lowers one notch and says whether it did; up() raises one notch. Every lowered step but the
 * resolution keeps an entry in a.held with its undo, so turning the controller off, a step leaving the list or its effect going away puts it back.
 * @param {any} e @param {any} s
 */
function stepOf(e, s) {
  const a = e.adaptive, held = a.held, key = keyOf(s), pr = () => e.renderer.getPixelRatio();
  if (s === 'resolution') return { key,
    // a ratio the game wrote with renderer.setPixelRatio is the game's (core/ops/owned.js): this step stands aside, the others still run
    down() {
      const p = pr();
      if (!e._oPixelRatio.on || p <= a.min + 0.01) return false;
      if (!a.lowered) { a.lowered = true; a.from = p; }
      writeRatio(e, Math.max(a.min, +(p - 0.1).toFixed(2)));
      return true;
    },
    lowered: () => e._oPixelRatio.on && pr() < a.max - 0.01,
    up() { writeRatio(e, Math.min(a.max, +(pr() + 0.05).toFixed(2))); } };
  const up = () => held.get(key)?.undo();
  if (typeof s === 'object') return { key, lowered: () => held.has(key), up,
    // the game's own knob (view distance, density): it says when it is at its floor; each notch down is undone by one up()
    down() {
      if (s.down() === false) return false;
      // step: which object holds these notches, so a new step of the same name never raises with this one's up() (ladder)
      const st = held.get(key) ?? { n: 0, step: s, text: () => (st.n > 1 ? `${s.name} x${st.n}` : s.name), undo: () => { s.up(); if (--st.n <= 0) held.delete(key); } };
      st.n++; held.set(key, st);
      return true;
    } };
  const [, name, off] = /^post\.([^.]+)(\.off)?$/.exec(s) ?? [];
  return { key, lowered: () => held.has(key), up,
    down() {
      const h = e.post.get(name);
      if (!h || !h.enabled || held.has(key)) return false;   // not added, off by the game or player, held by the tier: nothing to lower
      if (off) {
        const point = e.post.switchPoint(`post.${name}.enabled`);
        // an effect-layer set by another owner throws shared-conflict: then this step is not ours to take
        try { point.take({ owner: OWNER, layer: 'effect', set: false }); } catch { return false; }
        held.set(key, { h, text: () => `${name} off`, undo: () => { held.delete(key); point.release(OWNER); } });
        return true;
      }
      // only downward: a number param goes lower, never higher; any other kind is taken as the effect wrote it
      const to = Object.fromEntries(Object.entries(h._def.cheaper ?? {}).filter(([k, v]) => k in h.params && (typeof v === 'number' ? v < h.params[k] : v !== h.params[k])));
      if (!Object.keys(to).length) return false;
      const was = Object.fromEntries(Object.keys(to).map(k => [k, h.params[k]]));
      h.set(to);
      // back only what still holds the lowered value: a param the game set meanwhile is the game's newer word
      held.set(key, { h, text: () => `${name} cheaper`, undo: () => {
        held.delete(key);
        const back = Object.fromEntries(Object.entries(was).filter(([k]) => h.params[k] === to[k]));
        if (!h._removed && Object.keys(back).length) h.set(back);
      } });
      return true;
    } };
}

/**
 * The steps now, and anything held by a step that left the list, whose effect was removed, or that was replaced by another of that name (an effect or a
 * game step: same key, other object) put back, with the old one's own undo, before the new one lowers anything @param {any} e
 */
function ladder(e) {
  const a = e.adaptive, given = a.steps ?? defaultSteps(e), list = given.map(s => stepOf(e, s)), now = new Map(given.map(s => [keyOf(s), s]));
  for (const [k, st] of [...a.held]) if (!now.has(k) || (st.h && e.post.get(st.h.name) !== st.h) || (st.step && now.get(k) !== st.step)) drop(a.held, k);
  return list;
}

/** Every notch of one held step undone (a game step lowered three times is raised three times) @param {Map<string, any>} held @param {string} k */
function drop(held, k) { while (held.has(k)) held.get(k).undo(); }

/** Put back everything the ladder holds (the controller turned off, pixelSize on). The resolution stays where it is: settings' 'adaptive' row and setPixelRatio own that write @param {any} e */
function releaseAll(e) { for (const k of [...e.adaptive.held.keys()]) drop(e.adaptive.held, k); }

/**
 * One frame's sample. dt in s (the requestAnimationFrame interval), cost in ms (max of cpu and gpu), compiled: this frame compiled shaders.
 * gpuKnown: cost includes measured GPU time, so a slow interval with a cheap cost is never our overload.
 */
export function adapt(e, dt, cost, compiled, gpuKnown) {
  const a = e.adaptive;
  if (!a.on) { if (a.held.size) releaseAll(e); return; }
  if (!e.ready) return;
  a.age += dt; a.t += dt; a.cooldown -= dt;
  if (!compiled) { a.costs.push(cost); a.gaps.push(dt * 1000); }
  if (a.t < WINDOW) return;
  const costs = a.costs, gaps = a.gaps; a.t = 0; a.costs = []; a.gaps = [];
  // the game set renderer.setPixelRatio itself: the resolution step stands aside (core/ops/owned.js); engine.autoView.manual('pixelRatio', false) resumes it
  e._oPixelRatio.check();
  if (!gaps.length) return;
  const gap = median(gaps), clustered = gaps.filter(g => Math.abs(g - gap) <= gap * LOCK_TOL).length >= gaps.length * 0.7;
  // the fastest steady interval ever seen is the display's refresh (learned during grace too: loading frames are slower, never faster)
  if (clustered) a.refresh = Math.min(a.refresh, gap);
  if (a.age < GRACE) return;
  const c = median(costs), budget = 1000 / a.target;
  const heavy = c > budget * HEAVY;
  const slow = gap > 1000 / (a.target - 5);
  // locked: the frames wait on the display (steady at its refresh, work clearly shorter than the interval), not on us
  const locked = clustered && Math.abs(gap - a.refresh) <= a.refresh * LOCK_TOL && c < gap * 0.8;
  const overload = heavy || (!gpuKnown && slow && !locked);
  const steps = ladder(e);
  if (overload) {
    a.good = 0;
    const s = steps.find(x => x.down());
    if (!s) return;
    a.reason = heavy ? `frames cost ${c.toFixed(1)} ms of a ${budget.toFixed(1)} ms budget (target ${a.target} fps)` : `fps ${(1000 / gap).toFixed(0)} is under ${a.target}`;
    a.cooldown = 5;
    // a step that stayed up for 4 x FLAP was affordable after all: its wait starts over
    if (s.key !== 'resolution') { const up = a.age - (a.raisedAt[s.key] ?? -Infinity); if (up < FLAP) { a.wait[s.key] = (a.wait[s.key] ?? WAIT / 2) * 2; a.notBefore[s.key] = a.age + a.wait[s.key]; } else if (up > FLAP * 4) delete a.wait[s.key]; }
    // never silent: the picture changes, and the game or an AI should know why (dev warning once; engine.budget.notice() keeps what is lowered now)
    if (DEV && !a.warned) { a.warned = true; warnOnce(`${loweredText(e)}; adaptive quality lowers engine.adaptive.steps in order (resolution down to ${a.min}). Turn off with createEngine({ adaptiveResolution: false }) or engine.adaptive.on = false; engine.budget.notice() says what is lowered`); }
  } else if (c < budget * LIGHT && a.cooldown <= 0) {
    // last lowered goes up first; a step that flapped waits its turn, and the ones before it with it
    const s = steps.findLast(x => x.lowered());
    if (!s || a.age < (a.notBefore[s.key] ?? 0)) { a.good = 0; return; }
    if (++a.good >= RAISE_AFTER) { s.up(); a.good = 0; if (s.key !== 'resolution') a.raisedAt[s.key] = a.age; }
  } else a.good = 0;
}

/**
 * GPU time of the engine's render via EXT_disjoint_timer_query_webgl2 (null where the browser does not offer it: Safari, Firefox, most phones).
 * Results arrive a few frames late; ms is the latest one. Only runs while adaptive resolution is on.
 */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl; this.ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
    this.pending = []; this.free = []; this.active = null; this.ms = null;
  }
  begin() {
    const { gl, ext } = this;
    if (this.active) this.end();   // a render that threw left its query open: close it, or timing would stop for good
    if (!ext || gl.isContextLost()) return;
    this._poll();
    if (this.pending.length > 6) return;   // results stopped arriving (driver stall): skip timing rather than pile up queries
    const q = this.free.pop() ?? gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q); this.active = q;
  }
  end() { if (!this.active) return; this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.active); this.active = null; }
  _poll() {
    const { gl, ext } = this, disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);   // a disjoint event (clock change) makes the results meaningless
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.pending.shift();
      if (!disjoint) this.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      this.free.push(q);
    }
  }
  dispose() { if (!this.ext || this.gl.isContextLost()) return; for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q); this.pending = []; this.free = []; }
}
