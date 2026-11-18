// Check expectations against one reading and word the answer. Four results, because "could not look" must never count as "fine":
// holds / fails / missing (the path is gone) / unmeasured (this reading cannot answer: no picture, a stopped page, another renderer).
import { atPath } from '../threedog/pageFns.mjs';

/** Values that only a running loop can give (describe().perf.fps is null when the page is stepped by hand) */
const LIVE_ONLY = /^perf\.(fps|cpu)/;
const show = v => JSON.stringify(v);
/** An entry's range as text (">= 0 and <= 5", "= true"): every tool that shows one uses this */
export const rangeText = e => 'is' in e ? `= ${show(e.is)}` : [e.min != null && `>= ${e.min}`, e.max != null && `<= ${e.max}`].filter(Boolean).join(' and ');
const inRange = (e, v) => 'is' in e ? show(v) === show(e.is) : typeof v === 'number' && !(v < e.min) && !(v > e.max);
/** The reason an expectation was written with, as every tool quotes it: `Why: "…" (date)` */
export const whyText = e => `Why: "${e.why}"${e.date ? ` (${e.date})` : ''}`;
/** What a failed value used to be, for the line that shows now-versus-then (empty when no earlier value was kept) */
const wasText = e => (e.was !== undefined ? ` (was ${show(e.was)})` : '');
/** The loud headline for entries whose picture another renderer drew: said aloud, so it never counts as a quiet pass @param {{ entry: any, drawnBy: string }[]} list */
export const backendText = list => `${list.length} cannot be checked here (written for ${list[0].entry.backend}, drawn by ${list[0].drawnBy})`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Why a reading cannot answer this entry, or null: { cause, text } */
function cannotMeasure(e, facts) {
  if (e.value.startsWith('shot.')) {
    if (!facts.hasShot) return { cause: 'noShot', text: `${e.value} needs a picture: threedog shot --point ${e.point}` };
    if (e.backend && facts.backend && e.backend !== facts.backend) return { cause: 'backend', drawnBy: facts.backend, text: `${e.value} not measured here: written for ${e.backend}, this picture was drawn by ${facts.backend}. Write it again here: threedog shot --point ${e.point} --software` };
  }
  if (facts.halted && LIVE_ONLY.test(e.value)) return { cause: 'halted', text: `${e.value} needs a live page (this one is stepped by hand)` };
  return null;
}

/**
 * @param {any[]} entries the file's entries @param {ReturnType<import('./facts.mjs').assemble>} facts
 * @param {{ point?: string }} [opts] the view this reading is of: its entries plus the ones without a point are checked; no point: only those without one
 * @returns {{ entry: any, status: 'holds' | 'fails' | 'missing' | 'unmeasured', actual: any, cause?: string, text?: string }[]}
 */
export function evaluate(entries, facts, { point } = {}) {
  return entries.filter(e => !e.point || e.point === point).map(entry => {
    const skip = cannotMeasure(entry, facts);
    if (skip) return { entry, status: 'unmeasured', actual: undefined, ...skip };
    const actual = atPath(facts.values, entry.value);
    if (actual === undefined) return { entry, status: 'missing', actual };   // null is an answer (`is: null`), only undefined means the path is gone
    return { entry, status: inRange(entry, actual) ? 'holds' : 'fails', actual };
  });
}

const failLine = ({ entry: e, actual }) => `  ✗ ${e.value} ${show(actual)}, expected ${rangeText(e)}${wasText(e)}. ${whyText(e)}`;
const missingLine = ({ entry: e }) => `  ? ${e.value} is no longer in describe() (expected ${rangeText(e)}). ${whyText(e)}. Fix the path or: threedog expect drop ${e.value}${e.point ? ` --point ${e.point}` : ''}`;

/** The result lines of one reading: one line when all hold, else a headline and at most 3 details (failures, then lost values, then not measured) */
export function lines(results, { point } = {}) {
  if (!results.length) return [];
  const by = s => results.filter(r => r.status === s), fails = by('fails'), missing = by('missing'), un = by('unmeasured');
  const at = point ? ` at ${point}` : '';
  if (!fails.length && !missing.length && !un.length) return [`Expectations: ${results.length} hold${results.length === 1 ? 's' : ''}${at}`];
  const wrongBackend = un.filter(r => r.cause === 'backend'), other = un.length - wrongBackend.length;
  const parts = [
    fails.length && `${fails.length} of ${results.length} fail${fails.length === 1 ? 's' : ''}`,
    missing.length && plural(missing.length, 'lost its value', 'lost their values'),
    // loud on purpose: a picture drawn by another renderer must not quietly count as a pass
    wrongBackend.length && backendText(wrongBackend),
    other && `${other} not measured here`,
  ].filter(Boolean);
  const details = [...fails.map(failLine), ...missing.map(missingLine), ...un.map(r => `  - ${r.text}`)];
  const out = [`Expectations${at}: ${parts.join(', ')}`, ...details.slice(0, 3)];
  if (details.length > 3) out.push(`  ${details.length - 3} more: threedog shot --point ${point ?? '<name>'} --json (the expectations field)`);
  return out;
}

/**
 * The one-line offer to record a number for a named view, or null when that view already keeps one. Only a shot of a named point offers it: a
 * one-off shot cannot be checked again, and an offer under every shot of every game would be noise nobody reads.
 * @param {{ point: string, hasAny: boolean }} o hasAny: whether that point already has expectations
 */
export function hintLine({ point, hasAny }) {
  if (hasAny) return null;
  return `threedog expect shot.<number> --max <n> --point ${point} --why "<reason>"`;
}
