// R22 the hand-written docs keep their shape: each sentence in one place, entry docs stay small.
// Detection:
//   1. AI.md entry table (error, engine repository): every public engine namespace (an Engine property whose type has methods, read from the d.ts
//      with the program shared with R18) appears as `engine.<name>` in the "What exists: look here first" table, and every row's last column names
//      a recipe file that exists. Adding a public API means adding its row and recipe section in the same commit.
//      The game template's "Already here" table is generated from AI.md rows (lib/default-layer.mjs); a key without a row is an error, and so is a row that names
//      another API than the `check` hint for the same system (handRolled), or a hint kind placed neither in the table nor in OFF_TABLE.
//   2. Sizes: AI.md over 11.5 KB is an error (an index opened on demand). A new game's first read, its CLAUDE.md plus main.js as new-game writes them (every
//      placeholder filled, every starting point and renderer), over 12 KB (about 3,000 tokens, docs/plans/2026-11-09-agent-entry.md) is an error: the loop, the table,
//      the three rules and pointers stay; steps and ready lines live in the recipe that owns them, reached with threedog how. A game's DESIGN.md over 12 KB and STATUS.md over 4 KB are warnings.
//      Plus a size budget for all shipped AI docs: hand-written (recipes and the rest) and generated (API.md, api/, CODEMAP.md).
//   3. Duplicates (warn): one sentence of 12 or more words in two hand-written docs (AI.md, recipes, READMEs, CLAUDE.md files, .claude/rules,
//      game docs). Both places are printed; keep it in the one that owns the topic and link from the other.
//   4. Copied passages (error): a run of 30 or more words that appears in two docs (all of 3's docs plus COMMANDS and THREE). Why an
//      error: a copied paragraph is a second source of the same fact; one copy gets fixed, the other goes stale, and the AI reads both.
//   5. Recipe cards (error): every recipe opens with a card right under its title: `> **Covers:**`, `> **Use when:**`, `> **Shortest:**` and, when it
//      has sections, `> **Sections:**`, at most 6 lines. Why every recipe and not only the long ones: `threedog how --read <file>` without a section
//      prints the card, so an AI decides from a few lines whether this is the page, and the shortest form is where it looks first.
// Known limits: the duplicate check compares normalised sentences (case, markdown marks and spacing ignored), so a reworded copy passes.
import { existsSync, statSync } from 'node:fs';
import { defaultLayer, hintProblems, installCalls } from '../lib/default-layer.mjs';
import { metadata } from 'threedog/metadata';
import { render } from '../lib/scaffold.mjs';
import { join } from 'node:path';
import { kb } from '../lib/text.mjs';
import { walk, read, abs, rel, P, engineApi, docLevel } from './_lib.mjs';
import { docFiles } from './R18-doc-refs.mjs';
import { ROUTES } from '../how-tasks.mjs';
import { readSection } from '../how.mjs';
import { parseDocRef } from 'threedog/error-hints';

const AI_REL = `${P.DOCS_REL}/AI.md`, AI_MAX = 11.5 * 1024, FIRST_READ_MAX = 12 * 1024, DESIGN_MAX = 12 * 1024,   /* 8 -> 12 KB, owner decision 2026-11-08: a real game's DESIGN.md (Pigforest) needed it */ STATUS_MAX = 4 * 1024, MIN_WORDS = 12;
// Size budget of what ships to an AI (set a little above the size after the 2026-11-05 cuts; growing past it is a decision, so raise it in the same change as the reason):
// hand-written = recipes + the docs/*.md that people write (not API.md or CODEMAP.md); generated = API.md + api/ + CODEMAP.md
const HAND_MAX = 879 * 1024,   /* back to 879 KB on 2026-11-09 (batch 5 docs trim): repeats cut to one line and a pointer, COMMANDS detail left to each command's --help, which paid for a card on every recipe; the 880-884 KB raises of that day are undone. Before: +4 KB on 2026-11-09 (batch 3 step 3): the look-dev section (recipe 05) and the textures-from-nodes section (recipe 56) replace two tools the roadmap chose not to build; +1 KB on 2026-11-09 (batch 3 picture): +1 KB on 2026-11-09 (batch 3 picture): reflections, auto exposure, PCSS, area lights and path-traced photos each need their recipe section, and batch 5 slims the docs; +1 KB on 2026-11-09: the model contract (manifest needs) recipe section; +2 KB on 2026-11-08: five public features (collider layers, hud.button, assets.onModel, { url, node } parts, describe().warnings) each need their recipe section after today's text was trimmed; 66-common-tasks.md: whole examples and existing-game sections that threedog how prints and a test runs; CONVENTIONS.md: the entry rows that let how find every capability (R64) */ GENERATED_MAX = 361 * 1024 /* +1 KB on 2026-11-12: the code map lists one more engine file (render/bindingLimits.js, the texture-bindings check) */, GENERATED_FILES = new Set(['API.md', 'CODEMAP.md']);
const PASSAGE = 30, CARD_MAX = 6, CARD_KEYS = ['Covers', 'Use when', 'Shortest'];

/** What is wrong with a recipe's card, [] when it is fine (exported for the rule tests) @param {string} text */
export function cardProblems(text) {
  const L = text.split('\n'); let i = 1;
  while (i < L.length && !L[i].trim()) i++;
  if (i > 3 || !/^> \*\*Covers:\*\*/.test(L[i] ?? '')) return ['no card under the title (it starts with "> **Covers:**")'];
  let n = 0; while (i + n < L.length && L[i + n].startsWith('>')) n++;
  const card = L.slice(i, i + n).join('\n'), out = [];
  for (const k of CARD_KEYS) if (!card.includes(`> **${k}:**`)) out.push(`the card has no "${k}" line`);
  if (L.some(l => /^## /.test(l)) && !card.includes('> **Sections:**')) out.push('the card has no "Sections" line');
  if (n > CARD_MAX) out.push(`the card is ${n} lines (at most ${CARD_MAX})`);
  return out;
}

/** Word stream of a markdown text without code blocks: [{ w, line }] (inline code kept as one word, so a copied call counts) */
export function words(text) {
  const out = []; let fence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (fence || /^\s*\|?[\s|:-]+\|?\s*$/.test(raw)) return;
    const flat = raw.replace(/`[^`]*`/g, m => m.replace(/\s+/g, '_')).replace(/[*_#>|]/g, ' ');
    for (const w of flat.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) || []) out.push({ w, line: i + 1 });
  });
  return out;
}

/** Runs of PASSAGE+ words shared by two texts: [{ fa, la, fb, lb, text }] (one per run, not one per overlapping window) */
export function passages(files) {
  const first = new Map(), out = [];
  for (const [f, text] of files) {
    const ws = words(text);
    let lastHit = -2;
    for (let i = 0; i + PASSAGE <= ws.length; i++) {
      const key = ws.slice(i, i + PASSAGE).map(x => x.w).join(' ');
      const seen = first.get(key);
      if (!seen) { first.set(key, { f, line: ws[i].line }); continue; }
      if (seen.f === f) continue;
      if (i !== lastHit + 1) out.push({ fa: seen.f, la: seen.line, fb: f, lb: ws[i].line, text: key.split(' ').slice(0, 10).join(' ') });
      lastHit = i;
    }
  }
  return out;
}

/** Problems with AI.md's entry table and size (exported for the rule tests) */
export function entryTable(text, namespaces, recipeExists, { routes = ROUTES, resolve = ref => !!readSection(abs(P.DOCS_REL), ref) } = {}) {
  const clipRow = s => s.trim().slice(0, 40);
  const out = [], L = text.split('\n');
  const start = L.findIndex(l => /^## What exists: look here first/.test(l));
  if (start < 0) return [{ level: 'error', line: 0, msg: 'AI.md has no "## What exists: look here first" section', fix: 'restore the entry table: | To do | Use | Recipe |' }];
  let end = L.findIndex((l, i) => i > start && /^## /.test(l)); if (end < 0) end = L.length;
  const rows = L.slice(start + 1, end).map((l, i) => [l, start + 2 + i]).filter(([l]) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*To do\s*\|/.test(l));
  const table = rows.map(r => r[0]).join('\n');
  for (const ns of namespaces) if (!new RegExp(`engine\\.${ns}\\b`).test(table))
    out.push({ level: 'error', line: start + 1, msg: `public namespace \`engine.${ns}\` has no row in AI.md's entry table`, fix: `add a one-line row "| task | \`engine.${ns}\` | \`recipes/NN-x.md\` |" and a section in that recipe` });
  for (const [row, n] of rows) {
    const cells = row.split(/(?<!\\)\|/).slice(1, -1), last = cells[cells.length - 1] || '';
    // the column names recipes by file, with or without the folder ("06-clock-events.md" or `recipes/06-clock-events.md`)
    const recs = [...last.matchAll(/(?:recipes\/)?(\d\d-[\w.-]+\.md)/g)].map(m => `recipes/${m[1]}`);
    if (!recs.length) out.push({ level: 'error', line: n, msg: 'entry row without a recipe in its last column', fix: 'point the row at the recipe that teaches the task (`recipes/NN-x.md`)' });
    if (/\.md#/.test(last)) out.push({ level: 'error', line: n, msg: 'entry row names a section as file.md#anchor', fix: 'write the section the way the other rows do: `NN-x.md §2f`' });
    for (const rec of recs) if (!recipeExists(rec)) out.push({ level: 'error', line: n, msg: `entry row points at \`${rec}\`, which does not exist`, fix: 'fix the recipe name' });
    // a section pointer must open a section (threedog how --read), and the row's first pointer needs a route: the one place a new public feature registers
    // both its AI.md line and the task words how must answer with it (how-tasks.mjs ROUTES, run by R64)
    // each pointer is a file plus everything up to the next pointer: a selector the strict parser (core/base/docRef.js) rejects is an error, never read as the file
    const ptrs = [...last.matchAll(/(\d\d-[\w.-]+\.md)((?:\s*§(?:"(?:\\.|[^"\\])*"|[^,|`]*))?)/g)].map(m => (m[1] + m[2]).trim());
    for (const p of ptrs) {
      if (!p.includes('§')) continue;
      if (!parseDocRef(`recipes/${p}`)) out.push({ level: 'error', line: n, msg: `entry row points at \`${p}\`, whose section does not parse`, fix: 'write §<number> or §"<heading start>"' });
      else if (resolve && !resolve(`recipes/${p}`)) out.push({ level: 'error', line: n, msg: `entry row points at \`${p}\`, which is no section`, fix: 'name the section by its number or the start of its heading' });
    }
    const first = ptrs[0];
    if (first && routes && !routes.some(r => r[1] === first)) out.push({ level: 'error', line: n, msg: `entry row "${clipRow(cells[0])}" has no route to ${first}`, fix: `add ['<the task in an author's words>', '${first}'] to ROUTES in ${P.TOOLS_REL}/how-tasks.mjs` });
  }
  return out;
}

/** Normalised sentences of 12+ words in a markdown text: [{ key, line }] (code blocks skipped) */
export function sentences(text) {
  const out = []; let fence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const flat = raw.replace(/`[^`]*`/g, m => m.replace(/\s+/g, '_')).replace(/[*_#>|]/g, ' ');
    for (const s of flat.split(/(?<=[.!?;:。])\s+/)) {
      const words = s.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) || [];
      if (words.length >= MIN_WORDS) out.push({ key: words.join(' '), line: i + 1 });
    }
  });
  return out;
}

export default {
  id: 'R22', title: 'Doc shape: entry table, sizes, one place per sentence', game: true,
  run() {
    const out = [];
    // 1-2. AI.md
    if (P.MODE === 'monorepo' && existsSync(abs(AI_REL))) {
      const text = read(AI_REL), size = Buffer.byteLength(text);
      if (size > AI_MAX) out.push({ level: 'error', file: AI_REL, line: 0, msg: `AI.md is ${kb(size)} > ${kb(AI_MAX)}`, fix: 'AI.md is an index: keep one line per row and convention, move the detail into the recipe (or CONVENTIONS.md)' });
      const tpl = `${P.TOOLS_REL}/templates/game/CLAUDE.md`, layer = defaultLayer(text);
      // the template's "Already here" table is cut from AI.md rows (lib/default-layer.mjs): a row that was renamed or removed breaks the cut, and the size counts the table
      for (const msg of hintProblems(text, metadata.hints, installCalls(metadata.modules))) out.push({ level: 'error', file: `${P.TOOLS_REL}/lib/default-layer.mjs`, line: 0, msg, fix: 'the table read before writing and the check hint read after must name one API: fix the KEYS hints, OFF_TABLE, the AI.md row or the handRolled use text' });
      for (const k of layer.missing) out.push({ level: 'error', file: AI_REL, line: 0, msg: `the new-game CLAUDE.md table takes the AI.md row starting "${k}", and none does`, fix: `rename the key in ${P.TOOLS_REL}/lib/default-layer.mjs to the row's new start, or drop it` });
      // measured as new-game writes it: the renderer words (WebGPU route text), the gameplay note and the overlay's main.js count too, in the longest variant;
      // it once measured only the table and the file a game really reads was 7.2 KB against a 6.5 KB limit
      const tplFile = (layer, f) => `${P.TOOLS_REL}/templates/${layer}/${f}`, variants = [{}, { openWorld: true }, { pixel: true }, { sceneOnly: true }].flatMap(v => [false, true].map(webgl => ({ ...v, webgl })));
      const first = existsSync(abs(tpl)) ? Math.max(...variants.map(v => {
        const main = tplFile(v.pixel ? 'pixel' : v.openWorld ? 'openworld' : v.sceneOnly ? 'sceneonly' : 'game', 'main.js');
        return Buffer.byteLength(render(read(tpl), { name: 'game', ...v })) + Buffer.byteLength(render(read(main), { name: 'game', ...v }));
      })) : 0;
      if (first > FIRST_READ_MAX) out.push({ level: 'error', file: tpl, line: 0, msg: `a new game's first read (CLAUDE.md + main.js) is ${kb(first)} > ${kb(FIRST_READ_MAX)}`, fix: 'every game reads both before its first line: keep the loop, the table, the three rules and one-line pointers; steps and ready lines go to the recipe that owns them (threedog how finds it)' });
      const sizeOf = fs => fs.reduce((n, f) => n + statSync(abs(f)).size, 0);
      const docs = walk(P.DOCS_REL, ['.md']), isGen = f => GENERATED_FILES.has(f.split('/').pop()) || f.startsWith(`${P.API_DIR_REL}/`);
      const isUpgradeNote = f => f.split('/').pop().startsWith('MIGRATING-');   // read once when upgrading, never part of daily reading
      const hand = sizeOf(docs.filter(f => !isGen(f) && !isUpgradeNote(f))), gen = sizeOf(docs.filter(isGen));
      if (hand > HAND_MAX) out.push({ level: 'error', file: AI_REL, line: 0, msg: `hand-written AI docs (recipes, AI.md, CONVENTIONS, COMMANDS, THREE) are ${kb(hand)} > ${kb(HAND_MAX)}`, fix: 'merge or cut before adding: a fact lives in one place; raise HAND_MAX in R22-doc-shape.mjs only with the reason in the same change' });
      if (gen > GENERATED_MAX) out.push({ level: 'error', file: AI_REL, line: 0, msg: `generated docs (API.md, api/, CODEMAP.md) are ${kb(gen)} > ${kb(GENERATED_MAX)}`, fix: 'the public surface grew: see docs/testing/api-count.md; raise GENERATED_MAX in R22-doc-shape.mjs only with the reason' });
      const ns = engineApi().namespaces.map(n => n.name);
      for (const r of entryTable(text, ns, rec => existsSync(join(abs(P.DOCS_REL), rec)))) out.push({ ...r, file: AI_REL });
    }
    // 2. game docs
    const gameDocs = [...P.gameDirs(), ...(P.MODE === 'monorepo' ? [abs(`${P.TOOLS_REL}/templates/game`)] : [])];
    for (const d of gameDocs) for (const [f, max, where] of [['DESIGN.md', DESIGN_MAX, 'docs/design/<system>.md'], ['STATUS.md', STATUS_MAX, 'docs/plans/<feature>.md']]) {
      const p = join(d, f);
      if (existsSync(p) && statSync(p).size > max) out.push({ level: 'warn', file: rel(p), line: 0, msg: `${f} is ${kb(statSync(p).size)} > ${kb(max)}`, fix: `keep ${f} a short index: move the detail into ${where} and link it` });
    }
    // 3. duplicated sentences
    const docs = new Set(docFiles().filter(f => !/\/(COMMANDS|THREE|PERF)\.md$/.test(f)));
    // AGENTS.md of a game is a generated copy of its CLAUDE.md (lib/scaffold.mjs): left out here on purpose, it would only repeat every sentence
    for (const f of ['CLAUDE.md', ...walk('.claude/rules', ['.md']), ...P.gameDirs().map(d => rel(join(d, 'CLAUDE.md'))), `${P.TOOLS_REL}/templates/game/CLAUDE.md`]) if (existsSync(abs(f))) docs.add(f);
    // a game's docs start as copies of the template and quote the engine docs: compare a game's file only with files of the same game
    const gameRoots = [...P.gameDirs().map(d => rel(d)).filter(Boolean).map(r => r + '/'), `${P.TOOLS_REL}/templates/game/`];
    const gameOf = f => gameRoots.find(r => f.startsWith(r)) ?? null;
    const seen = new Map();
    for (const f of docs) for (const s of sentences(read(f))) {
      const first = seen.get(s.key);
      if (!first) seen.set(s.key, { f, line: s.line });
      else if (first.f !== f && gameOf(f) === gameOf(first.f)) out.push({ level: 'warn', file: f, line: s.line, msg: `same sentence as ${first.f}:${first.line} ("${s.key.split(' ').slice(0, 8).join(' ')} …")`, fix: 'keep it in the doc that owns the topic and link to it from the other' });
    }
    // 4. copied passages (the same game scoping as 3: a game's files are compared only with files of the same game)
    const all = [...docs, ...[`${P.DOCS_REL}/COMMANDS.md`, `${P.DOCS_REL}/THREE.md`].filter(f => existsSync(abs(f)))];
    const groups = new Map();
    for (const f of new Set(all)) { const g = gameOf(f) ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push([f, read(f)]); }
    for (const list of groups.values()) for (const p of passages(list))
      out.push({ level: docLevel(p.fb), file: p.fb, line: p.lb, msg: `a passage of ${PASSAGE}+ words is also in ${p.fa}:${p.la} ("${p.text} …")`, fix: 'one source per fact: keep the passage in the doc that owns the topic, replace this copy with one line and a link' });
    // 5. every recipe carries a card under its title
    if (P.MODE === 'monorepo') for (const f of walk(P.RECIPES_REL, ['.md'])) for (const msg of cardProblems(read(f)))
      out.push({ level: 'error', file: f, line: 1, msg, fix: 'under the title, at most 6 lines: > **Covers:** what the page covers / > **Use when:** … / > **Shortest:** one form / > **Sections:** its sections' });
    out.note = `${docs.size} docs compared for repeated sentences, ${all.length} for copied passages`;
    return out;
  },
};
