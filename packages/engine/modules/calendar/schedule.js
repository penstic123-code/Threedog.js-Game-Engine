// Calendar clock-time / season timers (implementation of engine.calendar.at / between / daily / onSeason; Calendar owns one Schedule).
// They read the calendar's time of day calendar.timeOfDay, not calendar seconds; for "after N seconds / every N seconds" use engine.clock.after / every.
// at is a "cross a clock time" event: when time moves forward (natural flow, fast-forward, raising calendar.timeOfDay) across several triggers, catchUp decides replay: 'once' fires once (default), 'all' fires all, 'skip' fires none;
// rewinding time (applyState to an earlier time, lowering calendar.timeOfDay) and loading a save only reset the baseline, no replay. To hold a state during a time range use between.
import { parseClock, inFrac } from '../../core/time/dayTime.js';
import { reportError } from '../../core/base/errors.js';
import { readParams, keysSchema } from '../../core/base/params.js';

const AT_KEYS = ['days', 'catchUp'], BETWEEN_KEYS = ['on', 'off'];

// clock-time conversions needed every step are cached on the registered entry (recomputed only when the clock time or hours per day change)
function frac(o, key, hoursPerDay) {
  const c = o._c ||= {};
  if (c[key + 'h'] !== hoursPerDay || c[key + 'v'] !== o[key]) { c[key + 'h'] = hoursPerDay; c[key + 'v'] = o[key]; c[key] = parseClock(o[key], hoursPerDay); }
  return c[key];
}
export class Schedule {
  constructor(cal) {
    this.cal = cal;
    this.points = [];       // at / daily：{ clock, fn, days, catchUp }
    this.ranges = [];       // between：{ from, to, on, off, inside }
    this.last = null;       // last calendar.totalDays (null = reset baseline next step)
    this.ticks = 0;         // steps seen: before the first, every state write (setup, engine:ready, URL params) is a set, not elapsed time
    this.seasons = new Set();   // onSeason handles on the global bus: this schedule made them, so dispose frees them
  }
  get size() { return this.points.length + this.ranges.length; }
  dispose() {
    for (const x of [...this.points, ...this.ranges]) x.dead = true;
    this.points = []; this.ranges = [];
    for (const h of [...this.seasons]) h.remove();
  }
  at(clock, fn, opts) {
    const { days = null, catchUp = 'once' } = readParams('calendar.at()', keysSchema(AT_KEYS), opts);
    parseClock(clock);   // a wrong clock time throws here, at the call, not later inside every step
    const p = { clock, fn, days, catchUp };
    this.points.push(p);
    return { remove: () => { p.dead = true; this.points = this.points.filter(x => x !== p); } };
  }
  between(from, to, opts) {
    const { on, off } = readParams('calendar.between()', keysSchema(BETWEEN_KEYS), opts);
    parseClock(from); parseClock(to);   // as at(): a wrong clock time throws at the call
    const r = { from, to, on, off, inside: null };
    this.ranges.push(r);
    this.syncRanges();
    return { remove: () => { r.dead = true; this.ranges = this.ranges.filter(x => x !== r); } };
  }
  /** A callback that throws is a gameplay error (errors.js), like clock timers; the other timers still run */
  _call(fn, arg) { try { fn(arg); } catch (err) { reportError(this.cal.engine, err, 'calendar timer'); } }
  onSeason(name, fn) {
    const h = this.cal.engine.events.on('season:change', s => { if (s === name) fn(s); }), remove = h.remove.bind(h);
    const mine = { ...h, remove: () => { this.seasons.delete(mine); remove(); } };
    this.seasons.add(mine);
    return mine;
  }
  syncRanges() {
    const t = this.cal.timeOfDay, hpd = this.cal.hoursPerDay;
    for (const r of [...this.ranges]) {
      if (r.dead) continue;   // an earlier callback of this pass removed it
      const inside = inFrac(t, frac(r, 'from', hpd), frac(r, 'to', hpd));
      if (inside === r.inside) continue;
      r.inside = inside;
      const fn = inside ? r.on : r.off;
      if (fn) this._call(fn);
    }
  }
  /** Fraction of a day until the next clock mark (midnight, an at time, a between edge), in (0, 1]; engine.skip ends a segment there.
   *  A mark the clock sits exactly on counts as already crossed (it fired when time arrived), so the next one is a day away */
  untilNext() {
    const t = this.cal.timeOfDay, hpd = this.cal.hoursPerDay;
    let m = 1 - t || 1;
    const near = f => { const d = ((f - t) % 1 + 1) % 1 || 1; if (d < m) m = d; };
    for (const p of this.points) near(frac(p, 'clock', hpd));
    for (const r of this.ranges) { near(frac(r, 'from', hpd)); near(frac(r, 'to', hpd)); }
    return m;
  }
  /** The baseline is now: a step from here on counts the marks it crosses. Called at install; after a load (which only clears it: the clock part may not be
   *  restored yet) state:replaced sets it, index.js */
  rebase() { this.last = this.cal.totalDays; }
  /** Called right after the calendar channel moves (a step or a skip segment) */
  tick() {
    const cal = this.cal;
    if (this.ranges.length) this.syncRanges();
    this.ticks++;
    const cur = cal.totalDays, last = this.last;
    this.last = cur;
    if (last == null || cur <= last) return;     // just loaded or time rewound: only reset the baseline
    for (const p of [...this.points]) {
      if (p.dead) continue;   // removed by a callback earlier in this pass
      const f = frac(p, 'clock', cal.hoursPerDay);
      const first = Math.floor(last - f) + 1, end = Math.floor(cur - f);   // triggers crossed: days first..end (0-based)
      if (end < first) continue;
      const n = end - first + 1;
      if (p.catchUp === 'skip' && n > 1) continue;
      for (let d = p.catchUp === 'all' ? first : end; d <= end && !p.dead; d++) {
        const day = d + 1;
        if (p.days && !(typeof p.days === 'function' ? p.days(day) : p.days.includes(day))) continue;
        this._call(p.fn, day);
      }
    }
  }
}
