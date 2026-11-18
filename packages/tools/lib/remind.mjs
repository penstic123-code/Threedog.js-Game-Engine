// The one exit for reminders a tool volunteers (R40 bypass hints today; the shot line, expectations and tool pointers later). No tool volunteers a reminder any other way.
// Why one function: each tool printing its own reminders gave each its own count, format and wording, and a reminder nobody reads changes nothing.
//
// Line prefixes, the same in every tool:
//   ✗  must be fixed (an error; a failed expectation is one too)
//   !  a reminder: the tool saw something and says which engine part covers it. Never changes an exit code, a test, a build or a shot
//   ?  a value is gone (used by expectations)
//
// A reminder line is one line:  ! <file>:<line>  <what was seen> → <the engine thing to use, then how to switch it off or a command to copy>
// Two classes, counted on their own lines: "engine already has it" (a hand-made copy of a system) is listed first; "likely mistakes"
// (WRONG: timing, randomness or loops that break replays, a broken hint switch) follow. Mistakes are the bulk of what is found, so they must not use up all the slots.
// remind() only returns text: it has no way to set an exit code, so a reminder cannot fail anything.

/** Reminder lines per place: a check lists a few and counts the rest; a shot gets one line */
export const BUDGET = { check: 5, shot: 1 };

const WRONG = new Set(['random', 'timers', 'loop', 'switch']);

/** One reminder of each kind before a second of any: five timer hints in the first file walked must not hide the hand-made inventory in the next */
export function kindsFirst(list) {
  const seen = new Map(), turn = list.map(r => { const n = seen.get(r.kind) ?? 0; seen.set(r.kind, n + 1); return n; });
  return list.map((r, i) => [r, turn[i]]).sort((a, b) => a[1] - b[1]).map(([r]) => r);
}

/**
 * @param {{ kind?: string, file?: string, line?: number, message: string, short?: string, fix?: string }[]} items reminders (lib/result.mjs items)
 * @param {{ where?: 'check'|'shot', max?: number, rest?: string }} [o] max: lines to list (default the place's BUDGET); rest: how to get the others, shown in the "more" line
 * @returns {{ lines: string[], hidden: number, has: number, wrong: number }} lines: the reminder lines, then one count line per class, then the "more" line
 */
export function remind(items, { where = 'check', max = BUDGET[where], rest } = {}) {
  const has = kindsFirst(items.filter(i => !WRONG.has(i.kind))), wrong = kindsFirst(items.filter(i => WRONG.has(i.kind)));
  const shown = [...has, ...wrong].slice(0, max), hidden = has.length + wrong.length - shown.length;
  const lines = shown.map(i => `! ${i.line ? `${i.file}:${i.line}` : i.file ?? ''}  ${i.message} → ${i.short ?? i.fix}`);
  const listed = list => shown.filter(i => list.includes(i)).length;
  // the count lines are for a list (check, 5 lines); a shot gets exactly one reminder line, so there they would be a second and third line
  if (max > 1) {
    if (has.length) lines.push(`  engine already has it: ${has.length} (${listed(has)} listed)`);
    if (wrong.length) lines.push(`  likely mistakes: ${wrong.length} (${listed(wrong)} listed)`);
    if (hidden) lines.push(`  …${hidden} more${rest ? ` (${rest})` : ''}`);
  }
  return { lines, hidden, has: has.length, wrong: wrong.length };
}
