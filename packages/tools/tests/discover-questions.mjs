// Discoverability ruler for `threedog how`: asks the question bank (fixtures/discover/questions.mjs) the way an AI would and counts how often the answer is found.
// Why a test that only asserts the bank and the canary: the four numbers are a baseline to watch (docs/testing/discoverability.md), not a gate; a gate on a ratio
// would push people to tune questions instead of fixing where `how` reads. What must never break is the ruler itself: a valid bank, and a canary that reads red.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocRef } from 'threedog/error-hints';
import { search, readSection, DOCS } from '../how.mjs';
import { seeds, variants, canaries } from './fixtures/discover/questions.mjs';

export const name = 'discover questions: the bank is well formed, the canary counts as not found, and the four discoverability numbers are printed';

/** The text `how` stands behind for one hit: the section its read-ref points at (the answer prints that section) */
function hitText(h) {
  const sec = h.ref && readSection(DOCS, h.ref, { max: Infinity });
  return sec ? sec.text : `${h.line}\n${h.text ?? ''}`;
}

/** Did this hit answer the question: right file and the name in its section */
function right(h, q) {
  const file = h.ref && parseDocRef(h.ref)?.file;
  return !!file && q.files.includes(file) && hitText(h).includes(q.must);
}

/** One question -> 'first' | 'top5' | 'confident-wrong' | 'unsure-wrong'. Renderer 'webgpu': the bank is asked from a WebGPU game, the starter default */
export function grade(q) {
  const hits = search(DOCS, q.q, 5, { renderer: 'webgpu' });
  if (hits[0] && right(hits[0], q)) return 'first';
  if (hits.some(h => right(h, q))) return 'top5';
  return hits.weak || !hits.length ? 'unsure-wrong' : 'confident-wrong';
}

/** The four numbers over a list of questions */
export function tally(list) {
  const t = { first: 0, top5: 0, 'confident-wrong': 0, 'unsure-wrong': 0 }, wrong = [];
  for (const q of list) { const g = grade(q); t[g]++; if (g.endsWith('wrong')) wrong.push(`${q.id}(${g === 'confident-wrong' ? 'sure' : 'unsure'})`); }
  const n = list.length, pct = k => `${k} (${Math.round(100 * k / n)}%)`;
  return { n, wrong, line: `${n} questions: first hit right ${pct(t.first)}; right within 5 ${pct(t.first + t.top5)}; wrong and confident ${pct(t['confident-wrong'])}; wrong but said unsure ${pct(t['unsure-wrong'])}` };
}

export async function run({ check }) {
  // a variant shares its seed's files and must, so the answer a seed expects is what its rewordings are held to
  const byId = Object.fromEntries(seeds.map(s => [s.id, s]));
  const asked = variants.map(v => ({ ...byId[v.of], ...v }));
  const all = [...seeds, ...asked, ...canaries], docsText = f => existsSync(join(DOCS, f)) ? readFileSync(join(DOCS, f), 'utf8') : '';
  const bad = [];
  for (const q of all) {
    for (const k of ['id', 'q', 'files', 'must', 'kind']) if (!q[k] || (k === 'files' && !q.files.length)) bad.push(`${q.id}: missing ${k}`);
    const missing = q.files?.filter(f => !existsSync(join(DOCS, f))) ?? [];
    if (missing.length) bad.push(`${q.id}: no such file ${missing.join(', ')}`);
  }
  for (const v of variants) if (!byId[v.of]) bad.push(`${v.id}: unknown seed ${v.of}`);
  check('every question has id, q, files, must, kind; every file exists; every variant names a seed', !bad.length, bad.join('; '));
  check('ids are unique', new Set(all.map(q => q.id)).size === all.length);
  // the name must be in one of the listed files, or the question could never be answered right; pending marks the known gaps and clears itself
  const stale = [...seeds].filter(q => !q.pending && !q.files.some(f => docsText(f).includes(q.must)));
  check('every must is written in one of its files (or the seed is marked pending)', !stale.length, stale.map(q => `${q.id} "${q.must}"`).join('; '));
  const done = seeds.filter(q => q.pending && q.files.some(f => docsText(f).includes(q.must)));
  check('a pending seed whose name now appears loses its pending flag', !done.length, done.map(q => q.id).join(', '));
  const real = canaries.filter(q => [...new Set(all.flatMap(x => x.files))].some(f => docsText(f).includes(q.must)) || docsText('AI.md').includes(q.must));
  check('canary names are written in no doc', !real.length, real.map(q => q.id).join(', '));
  check('there is at least one canary', canaries.length >= 1);

  // the canary guard: asked the same way as everything else, each must count as not found, or the ruler cannot go red
  const seen = canaries.map(q => [q.id, grade(q)]);
  check('[guard] every canary counts as not passed (a ruler that passes everything measures nothing)', seen.every(([, g]) => g.endsWith('wrong')), JSON.stringify(seen));

  // the baseline: printed, never asserted against a threshold (a pass here means the ruler ran)
  const s = tally(seeds), v = tally(asked);
  console.log(`  seeds    ${s.line}\n  variants ${v.line}\n  wrong: seeds ${s.wrong.join(' ') || '-'}; variants ${v.wrong.join(' ') || '-'}`);
}
