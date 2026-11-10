// Running condition and effect words: content.test and content.run. The vocabulary is rules.js, the built-in meanings are in loader.js.
import { warnMissing, warnOnce, syncOnly } from '../../core/base/validate.js';
import { coded } from '../../core/base/errorHints.js';
import { parseClock } from '../../core/time/dayTime.js';
import { list } from '../../core/base/util.js';
import { failure, isRunFailure } from '../../core/ops/opsFail.js';

/** Convert content notation to runtime values by ref (clock time -> fraction, place -> { x, z }) */
const norm = (e, api, ref, v) => ref === 'clock' ? parseClock(v, e.calendar?.hoursPerDay ?? 24) : ref === 'position' ? api.where(typeof v === 'string' ? { place: v } : v) : v;

/** content.test */
export function testWords(e, api, conds, c, actor) {
  if (!c) return true;
  const ctx = { actor };
  if (typeof c === 'function') return !!c(e, ctx);
  return list(c).every(x => Object.entries(x).every(([k, v]) => {
    const d = conds.get(k);
    if (!d) { warnMissing('condition', k, [...conds.keys()]); return false; }
    return !!d.test(e, norm(e, api, d.ref, v), v, ctx);
  }));
}

/**
 * content.run. The answer goes up, in the shape ops use: { ok: true }, or a failure whose facts.failed lists each word that failed [{ word, code, facts }], so an op or a
 * reward that returns it fails with it. The caller decides what that means; the event is for what has no caller above it (a dialogue do, a trigger)
 */
export function runWords(e, api, effects, a, actor) {
  if (!a) return { ok: true };
  const ctx = { actor };
  if (typeof a === 'function') return a(e, ctx);
  // One failing effect must not drop the ones after it (a reward with give + spawn would be half given): run them all, then rethrow the first error
  let first = null, threw = 0;
  const failed = [];
  for (const x of list(a)) for (const [k, v] of Object.entries(x)) {
    const d = effects.get(k);
    if (!d) { warnMissing('effect', k, [...effects.keys()]); continue; }
    try { const r = d.run(e, d.raw ? v : norm(e, api, d.ref, v), v, ctx); syncOnly(r, `content word { ${k} }`, true); if (isRunFailure(r)) failed.push({ word: k, code: r.code, facts: r.facts }); } catch (err) { first ??= err; threw++; }
  }
  const answer = failed.length ? failure({ code: failed[0].code, facts: { failed } }) : { ok: true };
  if (failed.length) {
    warnOnce(coded('content-misuse', `content: effect { ${failed[0].word} } failed with '${answer.code}'. Listen to content:failed, or read what content.run returns`));
    e.events.emit('content:failed', { code: answer.code, failed, actor: actor ?? null });
  }
  // a word that threw is a bug and goes on as a throw; the answers of the words beside it ride along, so a reward's debt survives it
  if (first) { if (threw > 1) first.message += ` (${threw} effects failed; the others ran)`; first.answer = answer; throw first; }
  return answer;
}
