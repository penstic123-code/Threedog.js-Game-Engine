// threedog verify <scenario>: run a scenario file (tests/scenarios/<name>.json, see scenario.mjs) on the running page and report not only pass / fail but
// what the run tested and what it never touched, so "passed" is not read as "the game works".
//   Tested      the ops it ran with the expected outcomes, the describe sections it compared, the time it advanced
//   Not tested  ops never run, describe sections never compared, steps that did not run after a failure, the real key path, the picture
//   Related     tests that mention an error code seen in the failure or in new page errors (grep over the test files), and the command to re-run this one
// A page error that appears during the run fails it too: a scenario that "passes" while the page logs an exception has not passed.
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runScenario, scenarioFiles, readScenario } from '../scenario.mjs';
import { errorMark, errorsSince } from './errorlog.mjs';
import { oneLine } from '../lib/oneline.mjs';
import { walk } from '../lib/text.mjs';
import { ENGINE, TOOLS, rel } from '../paths.mjs';
import { perfNotice } from '../lib/perf-baseline.mjs';
import { pageMark, pageCoverage, NOT_PROVEN, checkEvidence, coverage, evidenceText } from './evidence.mjs';

const PAGE_FACTS = () => ({ ops: [...window.engine.ops.defs.keys()], sections: Object.keys(window.engine.describe()) });
const list = (xs, n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ` … (+${xs.length - n})` : '');
const root = p => String(p).split(/\.|\[/)[0];

/** Test files and scenarios that mention one of the codes (an error code, or any name threedog impact asks about): [{ name, at }] */
export function relatedTests(dir, codes, max = 3) {
  if (!codes.length) return [];
  const files = [join(dir, 'tests'), join(ENGINE, 'tests'), join(TOOLS, 'tests')].flatMap(d => walk(d, { exts: /\.(mjs|json)$/, skip: ['fixtures', 'snapshots'], unscoped: true }));
  const out = [];
  for (const f of new Set(files)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!codes.some(c => l.includes(`[${c}]`) || l.includes(`'${c}'`) || l.includes(`"${c}"`))) return;
      let name = null;
      for (let j = i; j >= Math.max(0, i - 80) && !name; j--) name = /(?:name:|check\()\s*['"`]([^'"`]{6,80})/.exec(lines[j])?.[1] ?? null;
      out.push({ name, at: `${rel(f)}:${i + 1}` });
    });
  }
  return out.slice(0, max);
}

/** Count per layer (same layer names as evidence.mjs: direct | simulated-input); real-browser-input is always 0, the bridge has no real keyboard path */
const layerCounts = layers => ({ direct: layers.filter(l => l.layer === 'direct').length, 'simulated-input': layers.filter(l => l.layer === 'simulated-input').length, 'real-browser-input': 0, visual: 0 });

/**
 * The one scenario run behind both `verify` and `scenario`: find the file, run it on the page, and collect what the reports need (checks, layers, page
 * coverage, the describe sections it compared, page errors that appeared or repeated during the run). A scenario's own url picks the page unless --page did.
 */
async function runMeasured(driver, dir, name) {
  const files = scenarioFiles(dir), stem = x => basename(x, '.json'), f = files.find(x => stem(x) === name);
  if (!f) throw new Error(`Usage: threedog verify name (a file in tests/scenarios/). Have: ${files.map(stem).join(', ') || 'none'}`);
  const sc = readScenario(f), mark = errorMark(dir), res = [], d = sc.url && driver.page === undefined && driver.withPage ? driver.withPage(sc.url) : driver;
  const { layers } = await runScenario(d, sc, { check: (label, ok, detail) => res.push({ label, ok, detail }), file: name, snapDir: join(dir, 'tests', 'snapshots'),
    onPrepared: () => d.evaluate(pageMark.toString()) });
  const rawCov = await d.evaluate(pageCoverage.toString()), facts = await d.evaluate(PAGE_FACTS.toString()), bad = res.filter(r => !r.ok), steps = sc.steps;
  const failedAt = bad.length ? Number(/^(\d+)\./.exec(bad[0].label)?.[1] ?? steps.length) : steps.length, ran = steps.slice(0, failedAt);
  const checked = new Set(ran.flatMap(s => 'expect' in s && !('op' in s) ? Object.keys(s.expect).map(root)
    : 'snapshot' in s ? (s.only ?? facts.sections.filter(x => !(s.ignore ?? []).includes(x))).map(root) : []));
  return { sc, d, res, layers, rawCov, facts, bad, steps, failedAt, ran, checked, pageErrors: errorsSince(dir, mark) };
}

/** @param {{ saveBaseline?: boolean }} [opts] saveBaseline: --save-baseline, store this run's perf numbers in perf-baseline.json */
export async function verify(driver, dir, name, { saveBaseline = false } = {}) {
  const { sc, d, res, layers, rawCov, facts, bad, steps, failedAt, ran, checked, pageErrors } = await runMeasured(driver, dir, name);
  // one line only when the run ended over the game's budget, slower than its baseline, or at a lowered resolution (lib/perf-baseline.mjs)
  const perf = await perfNotice((src, arg) => d.evaluate(src, arg), dir, saveBaseline);
  const rows = checkEvidence(res, layers), kinds = k => steps.filter(s => k in s);

  // What ran: only the steps up to the failing one
  const ops = ran.filter(s => 'op' in s), seconds = ran.filter(s => 'step' in s).reduce((t, s) => t + s.step, 0);
  const byOp = new Map();
  for (const s of ops) byOp.set(s.op, [...(byOp.get(s.op) ?? []), s.expect ?? 'ok']);
  const cov = coverage(rawCov, [...checked]), presses = ran.filter(s => 'press' in s).map(s => s.press);
  const tested = [ops.length && `ops ${[...byOp].map(([o, e]) => `${o}${e.length > 1 ? ' ×' + e.length : ''} (${[...new Set(e)].join(', ')})`).join(', ')}`,
    checked.size && `describe sections ${[...checked].join(', ')}`, (seconds || presses.length) && `time: ${[seconds && `${+seconds.toFixed(2)} s of step`,
      presses.length && `${presses.length} key press${presses.length > 1 ? 'es' : ''} (${[...new Set(presses)].join(', ')})`].filter(Boolean).join(' + ')}`,
    kinds('state').length && 'state changes'].filter(Boolean);
  const idle = facts.ops.filter(o => !byOp.has(o)), unseen = facts.sections.filter(s => !checked.has(s));
  const notTested = [bad.length && failedAt < steps.length && `steps ${failedAt + 1}-${steps.length} never ran (stopped at step ${failedAt})`,
    idle.length && `ops never run (${idle.length}): ${list(idle)}`, unseen.length && `describe sections never compared (${unseen.length}): ${list(unseen)}`,
    ops.length && !presses.length && 'the simulated key path (input binding to op): ops were called directly', 'real browser input (physical keyboard/mouse; the bridge cannot send it)', 'the picture (use threedog snap)'].filter(Boolean);

  const ok = !bad.length && !pageErrors.length;
  const codes = [...new Set([...bad.map(r => r.detail), ...pageErrors.map(r => r.message)].flatMap(t => [...String(t).matchAll(/\[([a-z][\w-]*)\]/g)].map(m => m[1])))];
  const related = relatedTests(dir, codes), rerun = `threedog test "scenario: ${sc.name ?? name}"`;
  const why = bad.length ? `FAIL at step ${failedAt}: ${bad[0].label} → ${bad[0].detail}`.slice(0, 260)
    : pageErrors.length ? `FAIL: the checks passed but the page logged ${pageErrors.length} error${pageErrors.length > 1 ? 's' : ''} during the run (E${pageErrors[0].id}: ${oneLine(pageErrors[0].message)})`
      : `PASS (${res.length} checks, all ${steps.length} steps ran; no real browser input verified)`;
  const lc = layerCounts(layers), layerLine = `Layers: direct ${lc.direct}, simulated-input ${lc['simulated-input']}, real-browser-input 0 (not verified), visual 0`;
  const text = [`${ok ? '✓' : '✗'} verify ${name}: ${why}`, perf.notice, ...perf.lines, `Tested: ${tested.join(' · ') || 'nothing but the scenario setup'}`, `Not tested: ${notTested.join(' · ')}`, layerLine, evidenceText(rows, cov),
    related.length && `Related tests: ${related.map(t => `${t.name ? '"' + t.name + '" ' : ''}${t.at}`).join(' · ')}`, !ok && `Re-run: ${rerun}`].filter(Boolean).join('\n');
  return { ok, text, data: { scenario: name, passed: ok, checks: res, failedStep: bad.length ? failedAt : null, tested, notTested, layers, layerCounts: lc, evidence: { checks: rows, notProven: NOT_PROVEN, coverage: cov }, pageErrors, related, rerun, perf } };
}

/** threedog scenario <name>: the plain pass / fail line plus the short coverage block (what ran, what was only indirectly touched, what never) */
export async function scenarioReport(driver, dir, name) {
  const { res, rawCov, bad, checked, pageErrors } = await runMeasured(driver, dir, name), cov = coverage(rawCov, [...checked]), ok = !bad.length && !pageErrors.length;
  const head = bad.length ? bad.slice(0, 3).map(r => `✗ ${r.label} → ${r.detail}`).join('\n') : pageErrors.length
    ? `✗ scenario ${name}: the checks passed but the page logged ${pageErrors.length} error(s) during the run (E${pageErrors[0].id}: ${oneLine(pageErrors[0].message)})`
    : `✓ scenario ${name}: ${res.length} checks passed`;
  return { ok, text: head + '\n' + evidenceText([], cov, { checks: false }), data: { scenario: name, passed: ok, checks: res, coverage: cov, pageErrors } };
}
