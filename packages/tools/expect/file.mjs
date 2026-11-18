// expectations.jsonl: one JSON object per line, sorted by value then point, so two lines added in two worktrees never touch the same line.
// Why parse reports problems instead of throwing: `check` and the commands both need every bad line at once, with line numbers, and must never guess what a broken line meant.
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from '../lib/atomic.mjs';

export const FILE_NAME = 'expectations.jsonl';

/** Field order on disk (also the list of fields we know); anything else in a line is an error, not silently kept */
const FIELDS = ['value', 'min', 'max', 'is', 'point', 'why', 'date', 'was', 'backend'];
const CONFLICT = /^(<{7}|={7}|>{7})( |$)/;

export const MIN_WHY = 10;
/** Why a reason is too thin to help whoever sees the expectation fail later, or null: one place for the write command (refuses) and check (reminds) */
export const whyProblem = e => (typeof e.why !== 'string' || e.why.trim().length < MIN_WHY || e.why.trim() === e.value)
  ? `"why" is too short to explain itself (at least ${MIN_WHY} characters, not the value): it is quoted whenever this fails` : null;

/** The primary key: value + point (no separate id, so there is nothing extra to name or remember) */
export const keyOf = e => `${e.value} at ${e.point ?? 'any view'}`;

/** What is wrong with one parsed line, or null. Why `budget.` is refused: limits already have one home, engine.budget, and a second address for the same number would drift */
function problemOf(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'a line must be a JSON object';
  const unknown = Object.keys(e).find(k => !FIELDS.includes(k));
  if (unknown) return `unknown field "${unknown}" (known: ${FIELDS.join(', ')})`;
  if (typeof e.value !== 'string' || !e.value) return '"value" is required: the dotted path of the number, e.g. "economy.gold"';
  if (e.value.startsWith('budget.')) return `${e.value}: limits stay in engine.budget (createEngine({ budget })); expectations do not take budget.* values`;
  for (const k of ['min', 'max']) if (k in e && !Number.isFinite(e[k])) return `"${k}" must be a number`;
  if (!('min' in e || 'max' in e || 'is' in e)) return 'one of "min", "max" or "is" is required';
  if ('is' in e && ('min' in e || 'max' in e)) return '"is" cannot be combined with "min" or "max"';
  if (typeof e.why !== 'string' || !e.why.trim()) return '"why" is required: the reason is quoted whenever the expectation fails';
  for (const k of ['point', 'date', 'backend']) if (k in e && (typeof e[k] !== 'string' || !e[k])) return `"${k}" must be a non-empty string`;
  if (e.value.startsWith('shot.') && !e.point) return `${e.value}: "point" is required (a picture number needs a named view from shots.json)`;
  return null;
}

/**
 * Parse the file text. Blank lines are allowed, everything else must be a valid entry
 * @param {string} text @returns {{ entries: any[], problems: string[] }} problems carry "line N: ..."; entries holds only the valid lines
 */
export function parse(text) {
  const entries = [], problems = [], seen = new Map();
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1, line = raw.trim();
    if (!line) return;
    if (CONFLICT.test(line)) return problems.push(`line ${n}: git conflict marker "${line.slice(0, 7)}": resolve the merge, keep the right lines`);
    let e;
    try { e = JSON.parse(line); } catch (err) { return problems.push(`line ${n}: not valid JSON (${err.message.split('\n')[0]})`); }
    const bad = problemOf(e);
    if (bad) return problems.push(`line ${n}: ${bad}`);
    const key = keyOf(e);
    if (seen.has(key)) return problems.push(`line ${n}: ${key} is written twice (lines ${seen.get(key)} and ${n}, after a merge?): keep one`);
    seen.set(key, n);
    entries.push(e);
  });
  return { entries, problems };
}

/** Sorted, fixed field order, one line each, LF, trailing newline (an empty list is an empty file) */
export function serialize(entries) {
  const sorted = [...entries].sort((a, b) => a.value.localeCompare(b.value) || (a.point ?? '').localeCompare(b.point ?? ''));
  return sorted.map(e => JSON.stringify(Object.fromEntries(FIELDS.filter(k => k in e).map(k => [k, e[k]])))).join('\n') + (sorted.length ? '\n' : '');
}

/** Read the file at path; no file is no expectations (the template ships none) */
export function read(path) {
  return existsSync(path) ? parse(readFileSync(path, 'utf8')) : { entries: [], problems: [] };
}

/**
 * Read, change, write back. The file is read again right here, so only two commands landing in the same few milliseconds can lose a line.
 * Why it refuses a file with problems: writing back only the valid lines would silently delete the broken ones
 * @param {string} path @param {(entries: any[]) => any[]} change returns the new list (it may throw to refuse)
 * @returns {{ entries: any[] }}
 */
export function update(path, change) {
  const { entries, problems } = read(path);
  if (problems.length) throw new Error(`${path} has problems, fix them first:\n  ${problems.join('\n  ')}`);
  const text = serialize(change(entries)), check = parse(text);
  if (check.problems.length) throw new Error(`refusing to write:\n  ${check.problems.join('\n  ')}`);
  writeAtomic(path, text);
  return { entries: check.entries };
}
