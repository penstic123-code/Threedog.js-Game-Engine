// .threedog/expect-last.json: the last reading of each point, { "<point>": { date, backend, values } }.
// Why: `threedog expect` writes shot.* with the backend the number was read on (and what it was), and it must not open a browser to find out.
// Not a source of truth: a missing or broken file is "no reading yet". It holds only the paths the expectations mention and the picture numbers.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../lib/atomic.mjs';

const FILE = '.threedog/expect-last.json';
const load = dir => { try { const all = JSON.parse(readFileSync(join(dir, FILE), 'utf8')); return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; } catch { return {}; } };

/** The last reading of this point, or null */
export const readLast = (dir, point) => load(dir)[point] ?? null;

/**
 * Keep this reading of `point`
 * @param {ReturnType<import('./facts.mjs').assemble>} facts @param {{ entry: any, actual: any }[]} results evaluate()'s results: their values are the ones kept
 */
export function writeLast(dir, point, facts, results) {
  const values = Object.fromEntries(Object.entries(facts.values.shot ?? {}).map(([k, v]) => ['shot.' + k, v]));
  for (const r of results) if (r.actual !== undefined) values[r.entry.value] = r.actual;
  mkdirSync(join(dir, '.threedog'), { recursive: true });
  writeAtomic(join(dir, FILE), JSON.stringify({ ...load(dir), [point]: { date: new Date().toISOString().slice(0, 10), backend: facts.backend, values } }, null, 1) + '\n');
}
