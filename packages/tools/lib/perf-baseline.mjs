// This machine's recorded performance runs: .threedog/perf-baseline.json in the game folder, { [where]: { drawCalls, triangles, cpuMs?, modules: { name: ms },
// at } } as engine.budget.record() makes them. threedog shot and verify load it into engine.budget.baseline (unless the game set its own), print
// engine.budget.notice() (one line, nothing when all is fine) and, with --save-baseline, store this run under its where.
// Why per machine and never committed: times depend on the CPU and GPU, so another machine's numbers would read as "slower" or hide a regression;
// where carries the GPU, canvas size and pixel ratio, and .threedog/ is ignored by git. The engine compares (core/inspect/Budget.js); the tools only
// carry the numbers between runs.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE_FILE = '.threedog/perf-baseline.json';

/** Page side, called with { baseline, save }: hand the file to the engine unless the game set a baseline of its own (one the tools put there earlier
 * on this page is replaced, so a dev page that stays open sees the newest file); return the engine's line and (save) this run's record */
const PAGE_PERF = ({ baseline, save }) => {
  const b = window.engine.budget, w = /** @type {any} */ (window);
  if (!b.baseline || b.baseline === w.__threedogPerfBaseline) b.baseline = w.__threedogPerfBaseline = baseline;
  return { notice: b.notice(), record: save ? b.record() : null };
};

/** @param {string} dir the game folder @returns {{ baseline: Record<string, any> | null, note: string | null }} a broken file is a note, never a failure */
function readBaseline(dir) {
  const file = join(dir, BASELINE_FILE);
  if (!existsSync(file)) return { baseline: null, note: null };
  try { return { baseline: JSON.parse(readFileSync(file, 'utf8')), note: null }; } catch (e) {
    return { baseline: null, note: `Perf: ${BASELINE_FILE} unreadable (${String(e.message).split('\n')[0]}), nothing compared; record again with --save-baseline` };
  }
}

/**
 * Load the baseline into the page (call before the page describes itself, so describeText compares too)
 * @param {(src: string, arg: any) => Promise<any>} evaluate runs a function source on the page with one argument @param {string} dir the game folder
 */
export async function loadBaseline(evaluate, dir) { await evaluate(PAGE_PERF.toString(), { baseline: readBaseline(dir).baseline, save: false }); }

/**
 * The engine's one line after the run, and the lines the tool adds (an unreadable file; with save, what was written)
 * @param {(src: string, arg: any) => Promise<any>} evaluate @param {string} dir @param {boolean} save --save-baseline
 * @returns {Promise<{ notice: string | null, lines: string[] }>}
 */
export async function perfNotice(evaluate, dir, save) {
  const { baseline, note } = readBaseline(dir), lines = note ? [note] : [];
  // a page that lost window.engine (the very failure verify reports) must not turn the closing perf line into a crash that hides the verdict: no notice then
  const r = await evaluate(PAGE_PERF.toString(), { baseline, save }).catch(() => null);
  if (!r) return { notice: null, lines };
  if (save && r.record) {
    const all = { ...baseline, [r.record.where]: { ...r.record.values, at: new Date().toLocaleDateString('sv') } };
    mkdirSync(join(dir, '.threedog'), { recursive: true });
    writeFileSync(join(dir, BASELINE_FILE), JSON.stringify(all, null, 1) + '\n');
    lines.push(`Perf baseline saved for this machine: ${r.record.where} in ${BASELINE_FILE} (${Object.keys(all).length} recorded; not committed); later runs from this spot compare against it`);
  }
  return { notice: r.notice, lines };
}
