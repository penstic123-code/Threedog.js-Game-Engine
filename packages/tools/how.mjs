// The search behind threedog how (how-answer.mjs turns its hits into the one answer): which API / recipe answers a task, from the docs alone, offline.
// Why plain token scoring and no fuzzy library: the result must be the same every run and explainable ("matched rain in the AI.md row"); an AI reads
// the top few hits. Sources: the AI.md entry table (one row per task: the best hit), the CONVENTIONS.md "One task, which entry" table (the owner of
// "which of several entries"), recipe headings with their first sentence, and the plain three.js answers: THREE.md (tables and numbered conventions)
// and its idiom table. Ranking: each typed word weighs by how rare it is in the docs (so "game", "player" in a whole sentence barely
// count and "fps", "sidescroller" decide), a synonym from how-words.mjs or a plural / -ing stem counts a little less than the word itself, and a
// word only starting a longer word ("save" in "saveable") counts little. Hits that cover more of the query's weight come first; at about the same
// cover a plain three.js hit comes first (if three.js can do it, that is the answer), then an entry row (the one recommended entry for its task;
// a recipe section or technique example under it is the second read), then by score. A query nothing covers well is said so (weak), with the
// words the docs never use and where to read instead.
// Why each hit carries `at` (path#section) and `para`: progressive disclosure. The AI reads one paragraph of the matching section, not a whole
// recipe (they run to 28 KB); an AI.md row is resolved to the best-matching section of the recipe it points at.
// English only: the docs are English, and an AI asked in another language translates the task into English words first.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { metadata } from 'threedog/metadata';
import { docRef, parseDocRef, docReadCommand } from 'threedog/error-hints';
import { ENGINE, rel } from './paths.mjs';
import { walk, esc, slug } from './lib/text.mjs';
import { STOP as STOP_WORDS, SYNONYMS } from './how-words.mjs';
import { MODULES, FACTORIES, GROUPS, RECIPES } from './how-tasks.mjs';

/** Lower-case word / number tokens of a text */
export function tokens(s) {
  const out = [];
  for (const m of s.toLowerCase().matchAll(/[a-z0-9_.]{2,}/g)) out.push(m[0].replace(/\.+$/, ''));
  return out.filter(t => t.length >= 2);
}
const STOP = new Set(STOP_WORDS);
/** The engine's docs, and a doc as the user can open it: packages/engine/docs in this repo, node_modules/threedog/docs in a game */
export const DOCS = join(ENGINE, 'docs'), docPath = f => rel(join(DOCS, f));
// synonym groups, looked up in lower case: each word points at the one group it belongs to (a word belongs to one group only; how-words.mjs says why)
const GROUP = new Map();
for (const g of SYNONYMS) for (const w of g) GROUP.set(w.toLowerCase(), g.map(x => x.toLowerCase()));

/** One typed word as a "concept": the word, its plural-stripped stem, and its synonym group (a synonym hit counts a little less than the typed word) */
function concept(w) {
  const own = new Set([w]), deriv = new Set();
  if (w.length > 4 && w.endsWith('es')) own.add(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s')) own.add(w.slice(0, -1));
  // pixelation / pixelate -> pixel, arrangement -> arrange: the task word is a form of the docs' word (a stem of 4+ letters keeps "water" from becoming "w")
  for (const suf of ['ation', 'ate', 'ment']) if (w.length > suf.length + 3 && w.endsWith(suf)) { const s = w.slice(0, -suf.length); deriv.add(s); if (suf === 'ment') deriv.add(s + 'e'); }
  for (const suf of ['ing', 'ed']) if (w.length > suf.length + 2 && w.endsWith(suf)) {   // jumping -> jump, running -> runn -> run
    const s = w.slice(0, -suf.length); own.add(s); if (/([b-df-hj-np-tv-z])\1$/.test(s)) own.add(s.slice(0, -1));
    else if (/[b-df-hj-np-tv-z]$/.test(s)) own.add(s + 'e');   // losing -> lose, moved -> move
  }
  if (w.length > 4 && /ie[sd]$/.test(w)) own.add(w.slice(0, -3) + 'y');   // enemies -> enemy, carried -> carry
  const syn = new Set();
  for (const x of own) for (const s of GROUP.get(x) ?? []) if (!own.has(s)) syn.add(s);
  // weights: a typed word 1, its stem without the plural 0.9 (a line with "seasons" as typed ranks above one that only says season), a synonym 0.8
  return { word: w, alts: [...[...own].map(a => ({ a, k: a === w ? 1 : 0.9 })), ...[...deriv].filter(a => !own.has(a)).map(a => ({ a, k: 0.7 })), ...[...syn].map(a => ({ a, k: 0.8 }))] };
}

/** { main: the distinct tokens typed, stop words dropped; concepts: each with its stem and synonyms } */
export function queryTokens(q) {
  const main = [...new Set(tokens(q).filter(t => !STOP.has(t)))], concepts = main.map(concept);
  // each typed word counts on its own: fps no longer lists slow among its synonyms (slow is a word of its own), or one slow in a text counts twice,
  // and a networking recipe that mentions slow in passing would beat the performance line that says both slow and fps
  const typed = new Set(concepts.flatMap(c => c.alts.filter(x => x.k > 0.8).map(x => x.a)));
  for (const c of concepts) c.alts = c.alts.filter(x => x.k > 0.8 || !typed.has(x.a));
  return { main, concepts };
}

const reCache = new Map();
/** How well word w hits text t: 1 = a whole word ("save", "saves", "saving", camelCase "openWorld"), 0.4 = only the start of a longer word
 *  ("save" in "saveable"), 0 = no hit. Why the split: word-start matching keeps "rain" out of "terrain", and the whole-word check keeps
 *  "save" from ranking a "saveable" mesh row above the save system. Case matters only for the camelCase boundary, so t keeps its case. */
function hit(t, w) {
  if (!/^[a-z0-9_]/.test(w)) return t.toLowerCase().includes(w) ? 1 : 0;
  let re = reCache.get(w);
  if (!re) reCache.set(w, re = new RegExp('(^|[^a-zA-Z0-9])' + esc(w) + '([a-zA-Z0-9]*)', 'gi'));
  let best = 0;
  for (const m of t.matchAll(re)) {
    const rest = m[2];
    // the word as typed or as a camelCase part 1, a variant with an ending (saves, saved, lighting) 0.9: "save" goes to the saving line before a line that only says saved
    const v = !rest || /^[A-Z]/.test(rest) ? 1 : /^(s|es|ed|d|ing|er|ers|ly)$/.test(rest) ? 0.9 : 0.4;
    best = Math.max(best, v);
    if (best === 1) break;
  }
  return best;
}
// camelCase names are also split into words and searched again: presets.player.thirdPerson must match "third person", sideScroller still matches "sidescroller" (the pass over the raw text)
const camelCache = new Map();
const camelSplit = t => { let s = camelCache.get(t); if (s === undefined) { s = t.replace(/([a-z0-9])([A-Z])/g, '$1 $2'); camelCache.set(t, s === t ? null : s); } return s; };
/** How well a concept hits a text: the best of its alternatives (typed word 1, synonym 0.8; whole word 1, word start 0.4) */
const conceptHit = (text, c) => {
  const split = camelSplit(text);
  let b = 0;
  // a split part is half a word of a code name (the time of uTimeOfDay), a little weaker than a word in prose, so one uniform name does not beat the line that says "time of day"
  for (const { a, k } of c.alts) { const h = Math.max(hit(text, a), split ? hit(split, a) * 0.75 : 0) * k; if (h > b) b = h; if (b === 1) break; }
  return b;
};
/** Words of the query found in the text (each counts once; used where a plain count is enough: which section of a recipe to open) */
const matched = (text, qt) => qt.concepts.filter(c => conceptHit(text, c) > 0).length;
/** Weighted hit: each concept counts by how rare it is in the docs (qt.w, set in search) times how well it hits */
const score = (text, qt) => qt.concepts.reduce((s, c, i) => s + conceptHit(text, c) * qt.w[i], 0);
export const clip = (s, n = 110) => { s = s.replace(/`/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** The recipe whose ## sections are the complete answers to the most asked tasks: one rank above the rows, and how-answer.mjs prints them whole */
const TASKS_RECIPE = '66-common-tasks.md';
/** A task section that holds only the lines to add. The words of this prefix do not rank: "game" would pull all of them into any query */
const SKELETON = 'In an existing game: ';
/** The test that runs its sections, as a card names it */
export const TASKS_TEST = 'recipe 66';
/** The sentence of a section that names the next route */
const NOFIT = /\*\*When it does not fit:\*\*\s*(.+?)(?=\s{2,}|$)/;
const isRule = l => /^\|[\s|:-]+\|?$/.test(l);
/** A sentence of a table cell that ends by pointing at a recipe */
const POINTER = /[^.|]*\(recipes? \d+[^)]*\)\.?/g;
/**
 * Table rows and numbered conventions of a doc (header rows and rules skipped). Only a table whose first header names plain three.js
 * ("You write (plain three.js)", "three.js idiom") gives plain three.js entries; the other tables and the numbered conventions name engine
 * APIs used with three.js (engine.rigid.addBox, engine.terrainDraw.meshes...), so they are labelled 'engine + three.js' and never get the plain-first rank.
 */
function plainRows(file, where, out) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  let adopt = false, plainTable = false, skip = false;   // adopt: inside the "You write (plain three.js) | The engine does | The one line" table; skip: the "| id |" list of changes to three.js (a reference, describe().threePatches, not a task answer)
  lines.forEach((line, i) => {
    if (!line.startsWith('|') || isRule(line) || isRule(lines[i + 1] ?? '')) {   // a row followed by |---| is the header
      if (isRule(lines[i + 1] ?? '')) { adopt = /^\|\s*You write/.test(line); plainTable = /^\|[^|]*three\.js/i.test(line); skip = /^\|\s*id\s*\|/.test(line); }
      return;
    }
    if (skip) return;
    const c = line.split('|').slice(1, -1).map(x => x.trim());
    if (c.length < 2) return;
    // in the adoption table only the first column names the task; the other two describe what the engine then does (save, light, post, scene...)
    // and would make every row a tie-winning "plain three.js" hit for words that belong to an engine route
    // a sentence that sends the reader to a recipe ("On WebGPU ... write a node material (recipe 56)") is printed but does not rank: it names the other route's words, and with
    // the plain-first rank this row would answer "webgpu" and "node material" itself, and in a TSL game it would no longer count as the GLSL row it is
    out.push({ src: plainTable ? 'plain' : 'three', plain: plainTable, title: c[0], use: c.slice(1).filter(x => x && x !== '-').join(' · '), where, text: adopt ? c[0] : c.join(' ').replace(POINTER, ' ') });
  });
  // numbered conventions ("3. **Per-frame logic** ..."): one entry each
  for (const line of lines) {
    const m = /^(\d+)\.\s+\*\*(.+?)\*\*:?\s*(.*)/.exec(line);
    if (m) out.push({ src: 'three', plain: false, title: m[2].replace(/[:.]$/, ''), use: m[3].replace(/^[\s,:;.]+/, ''), where: `${where} §${m[1]}`, text: m[2] + ' ' + m[3] });
  }
}

/** GitHub-style heading anchor: "4b. Third-person action" -> "4b-third-person-action" */
/** The first prose paragraph from line i (code, tables and the next heading end it), at most ~480 chars */
function paragraph(lines, i) {
  const out = [];
  for (; i < lines.length && !/^#/.test(lines[i]); i++) {
    const l = lines[i];
    if (l.startsWith('```') || l.startsWith('|') || l.startsWith('<!--') || !l.trim()) { if (out.length) break; continue; }
    out.push(l.trim());
  }
  const t = out.join(' ');
  return t.length > 480 ? t.slice(0, 479) + '…' : t;
}
/** The ```js blocks of a section, in order (a heading ends the section; a # inside a block is code) */
function sectionBlocks(lines, i) {
  const out = [];
  for (let buf = null; i < lines.length; i++) {
    const l = lines[i];
    if (buf) { if (l.startsWith('```')) { out.push(buf.join('\n')); buf = null; } else buf.push(l); }
    else if (/^```js\s*$/.test(l)) buf = [];
    else if (/^#/.test(l)) break;
  }
  return out;
}
/** A section's own text (to score which section of a recipe an AI.md row should open) */
function sectionText(lines, i) { let t = ''; for (; i < lines.length && !/^#/.test(lines[i]); i++) t += lines[i] + ' '; return t; }

/**
 * AI.md's "What exists" rows by domain: [{ domain, task, use, where, text }]. One parser for the three readers of that table: the search (one entry per row),
 * the fallback when no words match (the domains, so the AI picks one instead of guessing words), and llms.txt (apidoc.mjs writes it from these rows).
 * `where` is the recipe column with its folder: "recipes/62-picture-code.md §0, 34-environment-lighting.md".
 */
export function aiTable(docsDir) {
  const ai = join(docsDir, 'AI.md'), out = [];
  if (!existsSync(ai)) return out;
  let domain = '';
  for (const line of readFileSync(ai, 'utf8').split('\n')) {
    const h = /^###\s+(.*)/.exec(line);
    if (h) { domain = h[1].trim(); continue; }
    if (/^## /.test(line)) domain = '';
    if (!line.startsWith('|') || isRule(line) || /^\|\s*To do\s*\|/i.test(line)) continue;
    const c = line.split('|').slice(1, -1).map(x => x.trim());
    if (c.length < 2) continue;
    // the recipe column is a pointer, not task words: "content-actions-save.md" must not make the content row answer "save game"
    // the last column names recipes by file ("06-clock-events.md, 08-weather-sky.md"): give the first its folder
    const where = c.length > 2 ? c[c.length - 1].replace(/`/g, '').replace(/^(?:recipes\/)?(\d\d-)/, 'recipes/$1') : '';
    out.push({ domain, task: c[0], use: c.length > 2 ? c[1] : '', where, text: (c.length > 2 ? c.slice(0, -1) : c).join(' ') });
  }
  return out;
}

/** All candidates from the docs: AI.md rows, recipe sections, THREE.md rows (plain three.js, or engine + three.js) */
const entriesCache = new Map();
export function docEntries(docsDir) {
  if (entriesCache.has(docsDir)) return entriesCache.get(docsDir);   // a run reads the docs once: rule R64 searches about 140 times
  const out = [];
  for (const r of aiTable(docsDir)) out.push({ src: 'AI.md', title: r.task, use: r.use, where: r.where, text: r.text });
  // CONVENTIONS.md "One task, which entry": | Task | First | Go down a layer when | (the detail AI.md rows leave out)
  const conv = join(docsDir, 'CONVENTIONS.md');
  if (existsSync(conv)) {
    const L = readFileSync(conv, 'utf8').split('\n'), i0 = L.findIndex(l => /^#+ One task, which entry/.test(l));
    for (let i = i0 + 1; i0 >= 0 && i < L.length && !/^#/.test(L[i]); i++) {
      const line = L[i];
      if (!line.startsWith('|') || isRule(line) || isRule(L[i + 1] ?? '')) continue;
      const c = line.split(/(?<!\\)\|/).slice(1, -1).map(x => x.trim());
      if (c.length < 3) continue;
      out.push({ src: 'entry', title: c[0], use: `${c[1]}; else ${c[2]}`, where: 'CONVENTIONS.md#one-task-which-entry', text: c.join(' '), nofit: c[2] });
    }
  }
  const rdir = join(docsDir, 'recipes');
  if (existsSync(rdir)) for (const f of readdirSync(rdir).filter(x => x.endsWith('.md')).sort()) {
    const lines = readFileSync(join(rdir, f), 'utf8').split('\n');
    let h1 = '';
    lines.forEach((l, i) => {
      const m = /^(#{1,3})\s+(.*)/.exec(l);
      if (!m) return;
      if (m[1] === '#') h1 = m[2];
      let snip = ''; for (let j = i + 1; j < lines.length && !/^#/.test(lines[j]); j++) if (lines[j].trim() && !lines[j].startsWith('```') && !lines[j].startsWith('|')) { snip = lines[j]; break; }
      const sec = /^(\d+)\./.exec(m[2]);
      // snip is shown but only some of it ranks: a recipe's top ranks by its card's first line (Covers, R22), which says what the page is about, never by
      // the card's Sections line, which names every section and would outrank the section that answers; a bullet speaks for one item of a list, so one word in an example ("one street lamp shot out") would decide for the whole section
      // a task section opens with its code: only its heading ranks and speaks for it (an import line naming five modules would answer for each of them)
      const task = f === TASKS_RECIPE && m[1] === '##', skeleton = task && m[2].startsWith(SKELETON);
      if (task) snip = 'a whole example, run by a test';
      const ranks = !task && !/^> \*\*Sections:\*\*|^\s*[-*] /.test(snip);
      out.push({ src: 'recipe', title: m[2], h1, where: `recipes/${f}${m[1] === '#' ? '' : sec ? ` §${sec[1]}` : ` "${m[2]}"`}`, snip, name: m[2].replace(/^\d+\.\s*/, ''), text: ranks ? m[2] + ' ' + snip : m[2].replace(SKELETON, ''), head: m[1] === '#' ? '' : h1,
        at: `recipes/${f}${m[1] === '#' ? '' : '#' + slug(m[2])}`, ref: docRef(`recipes/${f}`, m[1] === '#' ? '' : m[2]), para: paragraph(lines, i + 1), body: sectionText(lines, i + 1), blocks: sectionBlocks(lines, i + 1),
        task, skeleton, nofit: NOFIT.exec(sectionText(lines, i + 1))?.[1] });
    });
  }
  // api/*.md: one entry per documented name (the "- `music.stinger(...)` — what it does" lines). Why: these pages are the only place that names helpers like
  // ease, checkOptions or music.stinger; AI.md and the recipe headings cover tasks, not every function, so a task word had no way to reach them
  const adir = join(docsDir, 'api');
  if (existsSync(adir)) for (const f of readdirSync(adir).filter(x => x.endsWith('.md')).sort()) {
    readFileSync(join(adir, f), 'utf8').split('\n').forEach((l) => {
      const m = /^- `([^`]+)`\s*(?:—|-)\s*(.*)/.exec(l);
      if (m) out.push({ src: 'api', title: m[1], use: m[2], where: `api/${f}`, text: m[1].replace(/\(.*$/, '') + ' ' + m[2], at: `api/${f}`, para: '' });
    });
  }
  plainRows(join(docsDir, 'THREE.md'), 'THREE.md', out);
  entriesCache.set(docsDir, out);
  return out;
}

/** Every prose line of every docs file ([{ file, n, text, code }]): the full-text floor under the ranked entries. Why: the entries cover tasks and names; a word that sits only in a
 *  recipe's body must still be found, and "the docs never use it" may only be said after looking here. Cached per folder (a docs folder does not change during a run). */
const linesCache = new Map();
function docLines(docsDir) {
  let out = linesCache.get(docsDir);
  if (out) return out;
  out = [];
  for (const f of walk(docsDir, { exts: /\.md$/, unscoped: true })) {
    const file = relative(docsDir, f).replaceAll('\\', '/');
    let fence = false;
    readFileSync(f, 'utf8').split('\n').forEach((text, i) => {
      if (text.startsWith('```')) { fence = !fence; return; }
      if (text.trim() && !isRule(text)) out.push({ file, n: i + 1, text, code: fence });
    });
  }
  linesCache.set(docsDir, out);
  return out;
}

/** Which renderer the game at `dir` writes shaders for: 'webgpu' (TSL), 'webgl' (GLSL) or null when unknown. Read from main.js: that is where the game says `renderer: 'webgpu'`. */
export function gameRenderer(dir) {
  for (const f of ['main.js', 'src/main.js']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8');
    return /renderer:\s*['"]webgpu['"]|threedog\/tsl/.test(t) ? 'webgpu' : 'webgl';
  }
  return null;
}
/** An entry written for the other renderer than the game's (GLSL text in a TSL game, TSL text in a GLSL game): ranked lower, never hidden */
function otherRenderer(text, renderer) {
  if (!renderer) return false;
  const glsl = /glsl|ShaderMaterial|onBeforeCompile/i.test(text), tsl = /\btsl\b|node material|webgpu/i.test(text);
  return renderer === 'webgpu' ? glsl && !tsl : tsl && !glsl;
}

/** The best `max` hits for a query: [{ score, line }] (ties keep document order, so the output is stable) */
export function search(docsDir, q, max = 5, opts = {}) {
  const qt = queryTokens(q), hits = [], all = docEntries(docsDir), sections = all.filter(e => e.src === 'recipe');
  // a word weighs by its rarity (simple IDF): words found everywhere, like game or player in a long query, count for almost nothing; rare ones like fps or sidescroller decide the order.
  // why not a plain count: the old version weighed every word the same, so game / find in "game is slow, find why fps drops" ranked action games and new-game above the performance recipe
  const base = all.filter(e => e.src !== 'api'), N = base.length;   // rarity is counted on the rows, not on the thousands of text lines below (they would make every word look rare)
  // full-text floor: every prose line of every docs file is a last-rank candidate ("docs text · file:line"). Why: rows cover tasks and api names; a word that sits only in a
  // recipe body or a COMMANDS.md table row (capture, arrangement, pixelation) must still be found, and a line that holds the rare typed word beats a row that only holds a stem
  const lines = docLines(docsDir), floor = lines.filter(l => !l.code && !/^- `/.test(l.text) && l.text.length > 24 && !/^#{1,2} /.test(l.text)).map(l => ({ src: 'line', title: l.file, where: l.file + ':' + l.n, text: l.text, use: '' }));
  // rarity counts the typed word (and its stem) only, not its synonyms: a group joins slow, fps and perf, and counting the whole group would make a rare word like fps "common"
  const own = c => ({ alts: c.alts.filter(x => x.k > 0.8) });
  // a typed word the docs never use but whose synonym they do (rainy, rain) falls back to the group: alone it would count as the rarest word there is and be reported as unknown
  const entriesWith = c => base.reduce((n, e) => n + (conceptHit(e.text, c) > 0 ? 1 : 0), 0);
  qt.w = qt.concepts.map(c => Math.log(1 + N / (1 + (entriesWith(own(c)) || entriesWith(c)))));
  const total = qt.w.reduce((a, b) => a + b, 0) || 1;
  const lineHits = [], anyWord = new RegExp(qt.concepts.flatMap(c => c.alts.map(x => esc(x.a))).join('|'), 'i');
  all.concat(floor).forEach((e, order) => {
    if (!anyWord.test(e.text) && !anyWord.test(e.head ?? '')) return;   // one test per line: most lines hold no word of the query, and scoring them word by word took nearly all the time
    // the other renderer's text (GLSL in a TSL game) counts at 0.5: still listed when it is the only answer, but not first
    const wrong = otherRenderer(e.text + ' ' + (e.snip ?? ''), opts.renderer) ? 0.5 : 1;
    const s = score(e.text, qt) * (e.src === 'AI.md' || e.src === 'entry' ? 1.2 : 1) * wrong + (e.head ? score(e.head, qt) * 0.5 : 0);
    // cov: how much of the query's weight this entry covers by itself (its recipe's top title does not count, it only orders within s); compared in steps of 0.05, and only within one step (mostly: the same words matched)
    // does the old rule apply, "plain three.js first, then the recommended entry". Why the top title does not count: "bullet time on enemies" would beat the engine.mod line because the action recipe's title has enemy
    if (s > 0) (e.src === 'line' || e.src === 'api' ? lineHits : hits).push({ s, cov: score(e.text, qt) / total * wrong, order, e });
  });
  // a text line joins the ranking only when it clearly covers more of the query than the best row (the rare typed word is in the line and the rows only hold its stem);
  // otherwise the rows keep their order, and lines only fill an empty or weak list below. Why: a long prose line holds many words and would outrank the one recommended entry
  const bestRow = Math.max(0, ...hits.map(h => h.cov));
  // and only for a typed word that none of the top rows holds as itself (a stem or synonym does not count) and that the line holds as typed: that is the case the floor is for.
  // A variant in the line is not enough: "the resolution climbs back" is no answer to "climb", and a row with the synonym (ladder) is
  const topRows = [...hits].sort((a, b) => b.cov - a.cov).slice(0, 5), missing = qt.concepts.map(c => !topRows.some(h => conceptHit(h.e.text, c) >= 0.9));
  const upgrade = h => +h.e.title.startsWith('MIGRATING-');   // read once when upgrading: the answer only when nothing else holds the words (how setAuto)
  for (const h of lineHits) if (!upgrade(h) && h.cov >= Math.max(0.5, bestRow + (h.e.src === 'api' ? 0.1 : 0.3)) && qt.concepts.reduce((a, c, i) => a + (missing[i] && conceptHit(h.e.text, c) === 1 ? qt.w[i] : 0), 0) / total >= 0.6) hits.push(h);   // the missing word(s) carry 60% of the query's weight
  const entry = e => e.task ? 2 : e.src === 'AI.md' || e.src === 'entry' ? 1 : e.src === 'api' ? -1 : e.src === 'line' ? -2 : 0, band = h => Math.round(h.cov * 20);
  hits.sort((a, b) => band(b) - band(a) || (b.e.task ? 1 : 0) - (a.e.task ? 1 : 0) || (b.e.plain ? 1 : 0) - (a.e.plain ? 1 : 0) || entry(b.e) - entry(a.e) || b.s - a.s || a.order - b.order);
  // at most 3 plain three.js hits, so the engine route for the same task (coordination: time, weather, saves...) stays in the list
  const seen = new Set(), out = [], plainMax = Math.max(1, max - 2);
  let plain = 0;
  for (const { s, e } of hits) {
    const open = e.src === 'AI.md' ? openSection(sections, e.where, qt) : e.src === 'recipe' ? e : e.src === 'entry' ? entrySection(sections, e, qt) : null;
    if (e.src === 'line') { const lk = 'line' + e.title; if (seen.has(lk + 2)) continue; seen.add(seen.has(lk) ? lk + 2 : lk); }   // two text lines per file: five lines of one recipe are not five answers
    if (seen.has(e.where + e.title) || (e.plain && plain >= plainMax)) continue;
    seen.add(e.where + e.title); if (e.plain) plain++;
    out.push({ score: Math.round(s * 10) / 10, line: e.src === 'AI.md' ? `AI.md · ${e.title} → ${clip(e.use, 90)} → ${e.where || 'AI.md'}`
      : e.src === 'entry' ? `CONVENTIONS.md "One task, which entry" · ${e.title} → ${clip(e.use, 260)}`
      : e.plain ? `plain three.js · ${clip(e.title, 60)} → ${clip(e.use, 100)} → ${e.where}`
      : e.src === 'line' ? `docs text · ${e.where} — ${clip(e.text, 150)}`
      : e.src === 'api' ? `${e.where} · ${clip(e.title, 70)} — ${clip(e.use, 110)}`
      : e.src === 'three' ? `engine + three.js · ${clip(e.title, 60)} → ${clip(e.use, 100)} → ${e.where}` : `${e.where} · ${clip(e.name, 60)} — ${clip(e.snip)}`,
      at: e.src === 'line' ? e.where : open?.at ?? e.where.replace(/ (§\d+\w*|§?".*")$/, ''),
      // ref: the same place in the one pointer spelling (core/base/docRef.js), which is what is printed and what --read takes
      ref: e.src === 'line' ? e.where : open?.ref ?? e.where.replace(/, .*$/, ''),
      // the row may serve both renderers while the paragraph printed under it shows one: a GLSL sample under a row in a WebGPU game reads as the answer
      para: otherRenderer(open?.para ?? '', opts.renderer) ? '' : open?.para ?? '',
      blocks: open?.blocks ?? [], nofit: e.nofit ?? open?.nofit ?? '', task: !!e.task, skeleton: !!e.skeleton, plain: !!e.plain, text: e.text });
    if (out.length >= max) break;
  }
  // say so when the match is weak: when the listed hits together cover less than a third of the query's weight (a long query has ten words, covering half is hard, and a half threshold calls right answers 'not found'), mark it weak; the CLI then says no good match before listing the closest, so an AI does not take a filler result as the answer
  // the verdict reads the whole list, not the first line: a query's words often sit in different rows, and judged on one row alone a small rewording of that row turned a right answer into "no match"
  const listed = hits.slice(0, max), cover = qt.concepts.reduce((s, c, i) => s + Math.max(0, ...listed.map(h => conceptHit(h.e.text, c))) * qt.w[i], 0) / total;
  out.weak = out.length > 0 && cover < Math.min(1 / 3, 2 / qt.concepts.length); // long queries: two words' weight is already a lead
  // "unused" only after looking at every line of every docs file (not only the indexed rows)
  const used = qt.concepts.map(c => lines.some(l => conceptHit(l.text, c) > 0));
  out.unknown = qt.concepts.filter((c, i) => !used[i]).map(c => c.word);
  if (!out.length || out.weak) {   // the floor: the best text lines (two per file) after what the rows gave
    const seenFile = new Map(out.map(h => [h.at.replace(/[#:].*$/, ''), 1]));
    for (const h of lineHits.filter(h => h.cov >= 0.5).sort((a, b) => upgrade(a) - upgrade(b) || b.cov - a.cov || a.order - b.order)) {
      if (out.length >= max) break;
      if ((seenFile.get(h.e.title) ?? 0) >= 1) continue;
      seenFile.set(h.e.title, 1);
      out.push({ score: Math.round(h.s * 10) / 10, line: `docs text · ${h.e.where} — ${clip(h.e.text, 150)}`, at: h.e.where, para: '' });
    }
  }
  out.closestRow = hits.find(h => h.e.src === 'AI.md')?.e.title ?? '';
  return out;
}

/**
 * The route how recommends from a search result, or null when it stands behind none (no hits, or a weak match: then how lists the closest hits instead).
 * One function for threedog how and rule R64, so the route list checks the answer the AI really gets. In a game, the lines to add (a skeleton task of
 * recipe 66) among the first three come before a whole new file; further down it is a different task.
 * @param {ReturnType<typeof search>} hits  @param {boolean} inGame
 */
export function firstRoute(hits, inGame) {
  if (!hits.length || hits.weak) return null;
  return (inGame && hits.slice(0, 3).find(h => h.skeleton)) || hits[0];
}

/** The section of the recipe an AI.md row points at ("recipes/30-templates.md §5", a #anchor, or the file) that best matches the query */
export function openSection(sections, where, qt) {
  const file = /recipes\/[\w.-]+\.md/.exec(where)?.[0];
  if (!file) return null;
  const mine = sections.filter(x => x.at.split('#')[0] === file);
  // a row may list several pointers ("03-x.md §"A", 22-y.md"): the first is the recommended one, and parseDocRef reads one pointer only
  const { anchor, sec, title: quoted } = parseDocRef(where.split(/, (?=(?:recipes\/)?[\w-]+\.md)/)[0]) ?? {};
  const named = mine.find(x => (anchor && x.at.endsWith('#' + anchor)) || (sec && x.title.startsWith(sec + '.')) || (quoted && x.title.startsWith(quoted)));
  if (named) return named;
  // a heading that names more of the typed words wins (body words break ties); else the file's top (its H1 and its summary paragraph).
  // Body words alone never pick a section (a long worked example mentions everything), and one shared word of a longer task ("game" of
  // "save game") is not enough: the heading must name two of the typed words, or the one word typed
  let best = mine[0] ?? null, top = 0;
  const need = Math.min(2, qt.main.length);
  for (const x of mine.slice(1)) { const t = matched(x.title, qt); if (t < need) continue; const n = t * 100 + matched(x.body, qt); if (n > top) { top = n; best = x; } }
  return best;
}

/** The recipe section an entry row points at ("(recipe 20)"): a heading there that answers the query, else the first short example that calls the row's entry. The row stays the answer, the section gives its example */
function entrySection(sections, e, qt) {
  const n = /\brecipes? (\d+)/.exec(e.use)?.[1], file = n && sections.find(x => x.at.startsWith(`recipes/${n.padStart(2, '0')}-`))?.at.split('#')[0];
  const s = file && openSection(sections, file, qt);
  const name = /`([\w.]+)/.exec(e.use)?.[1];
  return s?.at.includes('#') ? s : name ? sections.find(x => x.at.startsWith(file + '#') && x.blocks[0]?.includes(name) && x.blocks[0].split('\n').length <= 12) ?? null : null;
}

/** One hit as printed: the line, then where to read (path#section) and that paragraph */
export function format(h, i) {
  return `${i + 1}. ${h.line}` + (h.ref ? `\n   read: ${h.ref}` : '') + (h.para ? `\n   ${h.para}` : '');
}

/**
 * One section as text, for `threedog how --read <pointer>` and the first answer of `how`: { ref, text, more } or null when the page or heading is not there.
 * The section runs to the next heading of its level or above (its ### subsections come with it); the file alone gives its card, everything above the first ##.
 * Cut at a line so the printed lines (each with `indent` spaces in front) stay within max bytes and maxLines (the output-length rule,
 * docs/testing/tool-output-sizes.md). `more` is always the command that prints all of it (docReadCommand: no quotes to break in any shell), with what was left out.
 * An #anchor may be a section number (`#3b`) or the start of a heading's anchor: that is what the command prints for a pointer kept by number or heading start.
 * @param {string} docsDir  @param {string} ref a pointer in any spelling parseDocRef reads  @param {{ max?: number, maxLines?: number, indent?: number }} [o]
 */
export function readSection(docsDir, ref, { max = 3500, maxLines = Infinity, indent = 0 } = {}) {
  const r = parseDocRef(ref), p = r && join(docsDir, r.file);
  if (!p || !existsSync(p)) return null;
  const L = readFileSync(p, 'utf8').split('\n'), heads = [];
  let fence = false;
  L.forEach((l, i) => { if (l.startsWith('```')) fence = !fence; const m = !fence && /^(#{1,4})\s+(.*)/.exec(l); if (m) heads.push({ i, level: m[1].length, title: m[2].trim() }); });
  const low = s => s.toLowerCase().replace(/[`*]/g, '');
  const h = r.sec ? heads.find(x => x.title.startsWith(r.sec + '.')) : r.title ? heads.find(x => low(x.title).startsWith(low(r.title))) : r.anchor ? heads.find(x => slug(x.title) === r.anchor) ?? heads.find(x => x.title.startsWith(r.anchor + '.') || slug(x.title).startsWith(r.anchor)) : null;
  if ((r.sec || r.title || r.anchor) && !h) return null;
  const start = h ? h.i : 0, level = h ? h.level : 2, end = heads.find(x => x.i > start && x.level <= level)?.i ?? L.length;
  const all = L.slice(start, end).join('\n').trim().split('\n'), out = [];
  let n = 0;
  for (const l of all) { const b = Buffer.byteLength(l) + indent + 1; if (n + b > max || out.length >= maxLines) break; out.push(l); n += b; }
  const at = docRef(r.file, h?.title), left = all.length - out.length, cmd = docReadCommand(at);
  return { ref: at, text: out.join('\n'), more: left > 0 ? `… ${left} more lines: ${cmd}` : `All of it: ${cmd}` };
}

/** AI.md's domains, one line each with its first tasks: the fallback when no words match, so the AI picks a domain instead of guessing more words */
export function domainLines(docsDir, width = 170) {
  const by = new Map();
  for (const r of aiTable(docsDir)) if (r.domain) by.set(r.domain, [...(by.get(r.domain) ?? []), r.task]);
  return [...by].map(([d, tasks]) => `${d}: ${clip(tasks.join('; '), width)}`);
}

/** What to try when nothing fits: drop the words the docs never use, use 2-4 task words, or read the closest AI.md row */
export function tryNext(res) {
  const drop = res.unknown?.length ? `The docs never use: ${res.unknown.map(w => `"${w}"`).join(', ')}. ` : '';
  const row = res.closestRow ? `the closest is "${res.closestRow}"` : 'one row per task';
  return `${drop}Try 2-4 English task words (e.g. "perf", "save game", "rigid push", "2d lights"), or threedog how --browse to pick by category, or read the table in ${docPath('AI.md')} ("What exists: look here first"; ${row}).`;
}

/**
 * Library entries (name, summary) that answer the query, as printed lines with the pull command. Why a separate list and not part of search():
 * the library is the user's own folder, so the same docs give the same ranking on every machine; library hits are listed after the docs hits and
 * never above the one recommended entry. A hit must cover at least half of the typed words (all of them when there are two or fewer).
 * @param {{ name: string, kind?: string, summary?: string }[]} list entries (lib.entries(libraryDir()))
 */
export function libraryHits(list, q, max = 3) {
  const { concepts } = queryTokens(q);
  if (!concepts.length) return [];
  const need = Math.ceil(concepts.length / 2), out = [];
  for (const e of list) {
    const text = `${e.name.replace(/[-_]/g, ' ')} ${e.summary ?? ''}`, n = concepts.filter(c => conceptHit(text, c) > 0).length;
    if (n >= need) out.push({ n, e });
  }
  out.sort((a, b) => b.n - a.n || a.e.name.localeCompare(b.e.name));
  return out.slice(0, max).map(({ e }) => `library · ${e.name} (${e.kind ?? 'other'}) — ${clip(e.summary ?? '', 90)} → threedog lib pull ${e.name}`);
}

/**
 * Engine modules a typed word names exactly: the module, one of its options, or a content field. Works with no page running; what only a running game has
 * (its own modules) is the live lines' job. Exact words only: a docs search already covers near hits, and three loose lines above it would be noise.
 */
export function metadataHits(q) {
  const words = new Set(queryTokens(q).main), lower = k => k.toLowerCase(), out = [];
  for (const [id, m] of Object.entries(metadata.modules)) {
    const opts = Object.keys(m.params ?? {}).filter(k => words.has(lower(k)) && k.length > 3), own = [id, m.call, ...m.provides, ...m.sections].some(k => words.has(lower(k)));
    if (own || opts.length) out.push(`module · ${m.call}()${m.label ? ` (${m.label})` : ''}${opts.length ? `, option ${opts.join(', ')}` : ''} → threedog catalog ${id}`);
  }
  return out.slice(0, 3);
}
