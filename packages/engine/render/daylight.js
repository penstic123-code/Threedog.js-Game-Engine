// Day and night as a signal. engine.uniforms.uNight is 0 by day and 1 at night; lightPool sources with `dusk` fade on this same curve, so a game's
// emissive windows that read uNight switch on together with the lamps instead of two curves drifting apart.

// default dusk: lights fade in as daylight drops below 0.3 (calendar daylight: about 16:50 -> fully lit at 18:00). It is only a starting value:
// each lightPool source may pass its own `dusk`, and a game's own fade reads uDaylight with its own edge
import { DEV, warnOnce } from '../core/base/validate.js';
import { coded } from '../core/base/errorHints.js';
import { resetSignals } from './effects.js';
export const DUSK = 0.3;

/** Daylight 0..1 from the 'daylight' measure (engine.audio.measure): the calendar registers it (gameplay day / night), the sky only when no
 * calendar did (the drawn sun). Read through the measure, not e.calendar / e.sky, so render/ names no module and a game's own clock module counts
 * the same by registering the measure. null when nothing tells day from night */
export const daylightOf = e => { const d = e.audio?.measures.get('daylight')?.(e); return typeof d === 'number' ? d : null; };
/**
 * 0 by day, 1 at night for one dusk (daylight below which it fades in); null daylight -> 0 (the day value is kept). dusk 0 has no fade:
 * on only while daylight is 0 (a cave mushroom that glows only in full dark); the d / dusk curve would divide by zero there
 */
export function nightOf(d, dusk) {
  if (d === null) return 0;
  if (dusk === 0) return d > 0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, d / dusk));
  return 1 - t * t * (3 - 2 * t);   // smoothstep: no visible kink when the fade starts or ends
}

/** Time of day 0..1 from the 'timeOfDay' measure: the calendar registers it (the game clock), the sky only when no calendar did (its fixed time).
 * null when nothing owns a time of day (the uniform keeps its default) */
const timeOfDayOf = e => { const t = e.audio?.measures.get('timeOfDay')?.(e); return typeof t === 'number' ? t : null; };

/**
 * Twice per frame, before the modules' frame hooks (an onFrame reads this frame's signal) and again just before drawing (a time jump in a hook reaches the picture
 * in the same frame as uSunDir): the one writer of uDaylight and uTimeOfDay. They come from the measures, so whoever owns game
 * time (the calendar, else the sky's fixed time) decides them, and a game with no sky() still has them moving. The sky writes neither.
 * @internal core/engine/loop.js
 * @param {any} e
 */
export function writeDaylight(e) {
  const d = daylightOf(e), t = timeOfDayOf(e), w = e._daySignals ??= signalWatch(e, { uDaylight: "engine.audio.measure('daylight', () => value)", uTimeOfDay: "engine.audio.measure('timeOfDay', () => value)" });
  w.check();
  if (d !== null || !e._daySeen) e.uniforms.uNight.value = nightOf(d, DUSK);   // a source seen and gone for one write: held with the others until the reset below moves all three
  if (d !== null) e.uniforms.uDaylight.value = d;
  if (t !== null) e.uniforms.uTimeOfDay.value = t;
  // the last day / night source went (calendar and sky removed): all three go back to the neutral day together, or uNight 0 would sit beside a
  // midnight uDaylight and two readers would see two times of day. Gone means no source at two writes in a row: the first write of a frame runs before
  // the sky's frame hook has taken a removed calendar's measure over, so one null alone is a swap in progress, and a reset there would show noon for a frame.
  // A game with no source from the start may write the signals itself: nothing is reset until a source has been seen
  if (d !== null) { e._daySeen = true; e._dayGone = 0; } else if (e._daySeen && ++e._dayGone >= 2) { resetSignals(e, ['uNight', 'uDaylight', 'uTimeOfDay']); e._daySeen = false; }
  w.mark();
}

/**
 * Dev: signals with one writer that rewrites them every frame. These have an entry of their own, so they are not owned values (a write has somewhere better to go),
 * but a direct write used to vanish without a word, the bug core/ops/owned.js exists to prevent: warn once with the entry. Release builds do nothing.
 * @internal @param {any} e @param {Record<string, string>} exits signal name -> the line that changes it
 */
export function signalWatch(e, exits) {
  const names = Object.keys(exits), last = new Map(), read = n => { const v = e.uniforms[n].value; return v?.isColor ? v.getHex() : v; };
  return {
    check() { if (DEV) for (const n of names) if (last.has(n) && last.get(n) !== read(n)) warnOnce(coded('signal-overwritten', `engine.uniforms.${n} was written directly, and the engine rewrites it every frame, so the write is lost. Use: ${exits[n]}`), `signal-overwritten:${n}`); },
    mark() { if (DEV) for (const n of names) last.set(n, read(n)); },
  };
}
