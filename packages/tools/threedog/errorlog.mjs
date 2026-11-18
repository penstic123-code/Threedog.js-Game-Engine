// Page errors from <workspace>/.threedog/errors.log (written by vite/vite-error-relay.js) as records with an id, a time, a source and a count.
//   threedog errors                new errors since the last read (moves the read position)
//   threedog errors latest [N]     the last N records (default 3); the same ones show again on every call
// Records with the same message and source print as one line: first and last id / time, summed count (×N)
//   threedog errors --since 5      records after id 5 (E5 also works); never moves the read position, so it is safe to repeat
// Ids are the order of appearance in the log (E1, E2…), restarting when the dev server restarts (the log is cleared then) and surviving the relay's size cut.
// A position (the read position, a reload, the start of a verify) is the last id and the counts: a repeat of an old error only raises its count, with no new
// record. The read position stores the log's first line too, so a restarted dev server does not hide its new errors behind an old position.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hintFor } from 'threedog/error-hints';
import { oneLine } from '../lib/oneline.mjs';
import { recordsCut } from '../vite/vite-error-relay.js';

const HEAD = /^\[browser ([^\]×]+?)(?: ×(\d+), (\d+) total)?\] (\d\d:\d\d:\d\d)(?: tick (\d+))?/;

/** Log text → [{ id, kind, time, tick, page, code, message, source, count, hint }] (a "same as above" line adds to the count of its record) */
function parseErrors(text) {
  const out = [], first = recordsCut(text);
  for (const block of text.split(/\n(?=\[browser)/).map(s => s.trim()).filter(s => s.startsWith('[browser'))) {
    const [head, ...rest] = block.split('\n'), m = HEAD.exec(head);
    if (!m) continue;
    const [, kind, repeat, , time, tick] = m;
    if (repeat) {   // the relay's summary of repeats: "… same as above: <message> (<source>)"
      const msg = head.split('same as above: ')[1] ?? '';
      const prev = [...out].reverse().find(r => r.kind === kind && msg.startsWith(oneLine(r.message).slice(0, 100)));
      if (prev) prev.count += Number(repeat);
      continue;
    }
    const page = rest.filter(l => l.startsWith('page| ')).map(l => l.slice(6));
    const end = page.findIndex((l, i) => i > 0 && /^\s*at /.test(l)), message = page.slice(1, end < 0 ? undefined : end).join('\n');
    const h = hintFor(message.replace(/\n\s*(Possible cause|Read):.*/g, ''));
    out.push({ id: first + out.length + 1, kind, time, tick: tick === undefined ? null : Number(tick), page: page[0] ?? '', code: message.match(/\[([a-z][\w-]*)\]/)?.[1] ?? null,
      message, source: end < 0 ? '' : page[end].trim().replace(/^at /, ''), count: 1, hint: h ? `Possible cause: ${h.cause} Read: ${h.docs.join(', ')}` : null });
  }
  return out;
}

const logFile = dir => join(dir, '.threedog/errors.log'), cursorFile = dir => join(dir, '.threedog/errors.cursor');
const readLog = dir => existsSync(logFile(dir)) ? readFileSync(logFile(dir), 'utf8') : '';
/** Identifies one dev-server run: the log's first line holds the time it was cleared */
const epochOf = text => text.split('\n', 1)[0];

const allErrors = dir => parseErrors(readLog(dir));
/** Records that count as errors (warnings are listed but do not fail a check) */
export const isError = r => r.kind !== 'warning';

/** A position in the log: the last id, and the counts of the records that have repeated */
const markOf = list => ({ id: list.at(-1)?.id ?? 0, counts: Object.fromEntries(list.filter(r => r.count > 1).map(r => [r.id, r.count])) });
/** Records that appeared or repeated after a position */
const after = (list, { id, counts }) => list.filter(r => r.id > id || r.count > (counts[r.id] ?? 1));

const reloadFile = dir => join(dir, '.threedog/errors-reload');
/** threedog reload and every hot update (vite-error-relay.js): errors logged so far belong to the code that is about to go. Ids restart with the log, so the log's first line is kept with the position */
export function markReload(dir) {
  const text = readLog(dir);
  mkdirSync(join(dir, '.threedog'), { recursive: true });
  writeFileSync(reloadFile(dir), JSON.stringify({ epoch: epochOf(text), ...markOf(parseErrors(text)) }));
}
/** The errors of the page running now: those after the last reload, or all of them when the log has restarted since */
export function currentErrors(dir) {
  const all = allErrors(dir);
  try {
    const m = JSON.parse(readFileSync(reloadFile(dir), 'utf8'));
    return epochOf(readLog(dir)) === m.epoch ? after(all, m) : all;
  } catch { return all; }
}

/** The position before a run */
export const errorMark = dir => markOf(allErrors(dir));
/** Errors that appeared (or repeated) since errorMark */
export const errorsSince = (dir, mark) => after(allErrors(dir), mark).filter(isError);

/** Records after the saved read position; saves the new position */
function newErrors(dir) {
  const text = readLog(dir), list = parseErrors(text), epoch = epochOf(text);
  let from = { id: 0, counts: {} };
  try { const c = JSON.parse(readFileSync(cursorFile(dir), 'utf8')); if (c.epoch === epoch && c.id <= (list.at(-1)?.id ?? 0)) from = c; } catch { /* no position yet */ }
  if (existsSync(logFile(dir))) writeFileSync(cursorFile(dir), JSON.stringify({ ...markOf(list), epoch }));
  return after(list, from);
}

const at = r => `E${r.id} ${r.time}${r.tick === null ? '' : ' tick ' + r.tick}`;
/** Records with the same kind, page, message and source as one group, in order of first appearance: { ...first, last, count summed } */
function merge(list) {
  const groups = new Map();
  for (const r of list) {
    const k = [r.kind, r.page, r.message, r.source].join('\0'), g = groups.get(k);
    if (g) { g.last = r; g.count += r.count; } else groups.set(k, { ...r, last: null });
  }
  return [...groups.values()];
}
// one line per group; one that came back as several records shows its first and last: "E3 12:00:01 tick 5 … E9 12:00:09 tick 80 ×7"
const one = r => (`${at(r)}${r.last ? ' … ' + at(r.last) : ''}${r.count > 1 ? ` ×${r.count}` : ''} `
  + `${r.kind === 'warning' ? 'warning' : 'error'}${r.code ? ` [${r.code}]` : ''} ${r.page} ${oneLine(r.message)}${r.source ? ' (' + r.source + ')' : ''}`)
  + (r.hint ? `\n  -> ${r.hint}` : '');

/** The errors command: { ok, text, data } for the dispatcher */
export function errorsCommand(dir, rest, opt) {
  const latest = rest[0] === 'latest', all = allErrors(dir), total = all.at(-1)?.id ?? 0;
  let list, label;
  if (opt.since !== undefined) {
    const n = Number(String(opt.since).replace(/^E/i, ''));
    if (!Number.isInteger(n) || n < 0) throw new Error(`--since takes an error id such as 5 or E5 (the cursor printed by threedog errors), got "${opt.since}"`);
    list = all.filter(r => r.id > n); label = `since E${n}`;
  } else if (latest) {
    const n = rest[1] === undefined ? 3 : Number(rest[1]);
    if (!(n >= 1)) throw new Error('errors latest takes a count, e.g. threedog errors latest 5');
    list = all.slice(-n); label = `latest ${list.length} of ${total}`;
  } else { list = newErrors(dir); label = 'new'; }
  const cursor = total, data = { errors: list.slice(-10).map(({ message, ...r }) => ({ ...r, message: oneLine(message) })), cursor, total };
  if (!list.length) return { ok: true, data, text: opt.since !== undefined || latest ? `✓ No errors ${opt.since !== undefined ? label : 'recorded'}` : '✓ No new errors' };
  const groups = merge(list);
  const more = groups.length > 2 && !latest ? `\n…${groups.length - 2} more, see .threedog/errors.log or threedog errors --since ${Math.max(0, list[0].id - 1)}` : '';
  const shown = latest ? groups : groups.slice(0, 2);
  // count errors and warnings apart: a run that only produced warnings is not a failure and does not say "errors"
  const nErr = list.filter(r => r.kind !== 'warning').length, nWarn = list.length - nErr;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const counts = [nErr && plural(nErr, 'error'), nWarn && plural(nWarn, 'warning')].filter(Boolean).join(', ')
    + (groups.length < list.length ? ` (${groups.length} different)` : '');
  return { ok: nErr === 0, data, text: `${nErr ? '✗' : '!'} ${label}: ${counts}\n`
    + shown.map(one).join('\n') + more + `\nCursor E${cursor}: threedog errors --since ${cursor} lists only what comes after` };
}
