// The one JSON result shape of tool commands (`threedog check --json`, `threedog test --json`):
//   { ok, summary, items: [{ code, level, kind, file, line, message, fix, short }] }
// Item fields are present only when known (no null, no empty string). level is 'error' or 'warn'; short is the one-line form of fix. stdout carries only this JSON (one line);
// everything the command would print goes to stderr, and the exit code stays what the plain command gives.
import { writeSync } from 'node:fs';

/** One item; unknown fields (undefined, null, '', 0) are left out */
export const item = ({ code, level = 'error', kind, file, line, message, fix, short }) => {
  const o = {};
  for (const [k, v] of Object.entries({ code, level, kind, file, line, message: String(message ?? ''), fix, short })) if (v !== undefined && v !== null && v !== '' && v !== 0) o[k] = v;
  return o;
};

/** { ok, summary, items }; ok defaults to "no item at level error" */
export const result = (items, summary, ok = !items.some(i => i.level === 'error')) => ({ ok, summary, items });

/** Parse the one JSON line a sub-command printed with --json; null when it printed something else (it crashed before the JSON) */
export const parseResult = text => {
  const line = String(text).trim().split('\n').filter(Boolean).at(-1);
  try { const r = JSON.parse(line); return r && Array.isArray(r.items) && 'ok' in r ? r : null; } catch { return null; }
};

/**
 * Start JSON mode: console output goes to stderr so stdout stays clean, and the result is written when the process exits, whichever
 * exit path it takes (an early process.exit(1) included). build(exitCode) returns the result.
 */
export function startJson(build) {
  console.log = console.info = console.warn = console.error;
  process.on('exit', code => { try { writeSync(1, JSON.stringify(build(code)) + '\n'); } catch { /* stdout already closed */ } });
}
