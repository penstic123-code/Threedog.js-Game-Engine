// R40 bypass hints (warnings only, never errors): game code that hand-rolls something an engine system already does. Each warning says what was seen, which system
// covers it, and how to say "this is on purpose". Scanned: a game's own sources (games/*, or a project installed from npm, proved by pack-external), and the engine's examples; not the engine itself (R4/R19-R21 cover that).
// Why the patterns are not here: the owner of a system knows what its hand-made copy looks like, and a table here forgets the next system. Each system declares
// export const handRolled next to its definition, the generated metadata carries it (metadata.hints), and this file only reads it; a module with no code shape says 'none: why' (R64 checks).
// A hint's fields, all optional but seen, use and one of code / raw (docRef: where the docs explain the system, one threedog/error-hints pointer, checked by metadata.mjs):
//   code   regex on the line with comments and strings blanked   raw   regex on the line as written (a key name, a DOM id); with both, both must match
//   orRaw  regex on the raw line, enough on its own               not / notRaw   the same two lines: a match stays quiet
//   quiet  regex on the file's code: the file already uses the system      near  [{ re, lines, on: 'raw' }] each must match within that many lines
//   gameplayOnly  quiet in a picture / style / art file or a picture module   tags: false  a tag (below) does not silence it
//   yields { kind, raw }  on a matching line the finding belongs to that other kind, while that kind can fire in the file (an Esc handler is pause, not keys)
//   Never hinted: a native three.js loader in game code (a format engine.assets does not read is a plain three.js job; R21 scans the engine only), or a pathfinder of the game's own.
// Known limit of quiet: it reads the whole file, so a file that uses engine.inventory and also keeps a hand-made bag stays silent. A hint is a pointer, not a proof nothing was hand-rolled.
// Not flagged: tests, docs and scripts folders, tagged presentation code (the same tags as R4: // presentation, // measure, // debug, // wall-clock, // main-loop).
//
// Switching off. Per line (this line or the whole-line comment above): `// hint-off` for every hint, or `// hint-off(random, timers)` for named ones.
//   Whole file (one of the first 30 lines): `// hint-off-file` or `// hint-off-file(random)`.
//   Whole game: the game's package.json (games/<name>/package.json; the repo root's applies to every game)  "threedog": { "hints": false }  (all), or
//   { "hints": { "random": false, "timers": false } } (named kinds); one run: THREEDOG_HINTS=off npm run check. Kinds: see KINDS.
//   A switch that cannot work (an unknown kind, hint-off-file below line 30, a wrong hints value) is reported as its own warning, never silently ignored.
import { metadata } from 'threedog/metadata';
import { readFileSync, existsSync } from 'node:fs';
import { walk, lines, codeOnly, rel, ROOT, P } from './_lib.mjs';
import { TAGS } from './R04-real-time.mjs';
import { isArtFile } from '../paths.mjs';
import { docRefsLine, docReadCommand } from 'threedog/error-hints';

/** "/source/flags", as metadata.mjs wrote it, back into a RegExp */
const regex = s => { const m = /^\/(.*)\/(\w*)$/s.exec(s); return new RegExp(m[1], m[2]); };
const compiled = h => ({ ...h, ...Object.fromEntries(['quiet', 'code', 'raw', 'orRaw', 'not', 'notRaw'].filter(k => h[k]).map(k => [k, regex(h[k])])),
  ...(h.near && { near: h.near.map(n => ({ ...n, re: regex(n.re) })) }), ...(h.yields && { yields: { ...h.yields, raw: regex(h.yields.raw) } }) });
const HINTS = Object.fromEntries(Object.entries(metadata.hints).map(([k, h]) => [k, compiled(h)]));
export const KINDS = Object.keys(HINTS);
const HOW = 'on purpose? carry on. // hint-off(KIND) hides it on the line, // hint-off-file(KIND) at the top, or package.json "threedog": { "hints": { "KIND": false } }';

/** Hints that stay on for the project: package.json "threedog.hints" (false / 'off' / { kind: false }) and THREEDOG_HINTS=off. Returns a Set of kinds */
export function activeKinds(pkgHints, env = process.env.THREEDOG_HINTS) {
  if (env === 'off' || pkgHints === false || pkgHints === 'off') return new Set();
  const off = pkgHints && typeof pkgHints === 'object' ? KINDS.filter(k => pkgHints[k] === false) : [];
  return new Set(KINDS.filter(k => !off.includes(k)));
}
/** Why a package.json "threedog.hints" value does not do what it seems to: [message] (unknown kinds, a wrong value type) */
export function hintsConfigProblems(pkgHints) {
  if (pkgHints == null || pkgHints === false || pkgHints === 'off') return [];
  if (typeof pkgHints !== 'object') return [`"threedog": { "hints": ${JSON.stringify(pkgHints)} } is ignored: use false (all off) or { "<kind>": false }`];
  return Object.keys(pkgHints).filter(k => !KINDS.includes(k)).map(k => `"threedog.hints.${k}" is ignored: no hint kind "${k}" (kinds: ${KINDS.join(', ')})`);
}

/** Kinds a hint-off comment names: null = no such comment, KINDS = all of them */
function offKinds(comment, word) {
  const m = comment.match(new RegExp(`${word}(?!-)(?:\\(([^)]*)\\))?`));
  if (!m) return null;
  return m[1] ? m[1].split(',').map(s => s.trim()) : KINDS;
}
const commentOf = s => s?.match(/\/\/(.*)$/)?.[1] ?? s?.match(/\/\*(.*?)\*\//)?.[1] ?? '';
const wholeLineComment = s => /^\s*(\/\/|\/\*)/.test(s || '');

/**
 * Hints in a text: [{ level: 'warn', line, kind, msg, fix }]. active: the kinds that stay on (default all).
 * @param {string} text @param {Set<string>} [active] @param {{ art?: boolean }} [o] art: a file of the game's picture (paths.mjs isArtFile)
 */
export function scanText(text, active = new Set(KINDS), { art = false } = {}) {
  const L = text.split(/\r?\n/), out = [];
  const fileOff = new Set(L.slice(0, 30).flatMap(l => offKinds(commentOf(l), 'hint-off-file') ?? []));
  // a switch naming no known kind, or a file switch too far down, would silently do nothing: say so where it is written
  const ignored = (i, why) => out.push({ level: 'warn', line: i + 1, kind: 'switch', msg: `hint switch ignored: ${why}`, fix: `kinds: ${KINDS.join(', ')}; // hint-off-file(...) goes in the first 30 lines` });
  L.forEach((l, i) => {
    const c = commentOf(l), file = offKinds(c, 'hint-off-file');
    if (i >= 30 && file) ignored(i, 'hint-off-file below line 30 (only the first 30 lines are read)');
    for (const k of [...(file ?? []), ...(offKinds(c, 'hint-off') ?? [])]) if (!KINDS.includes(k)) ignored(i, `no hint kind "${k}"`);
  });
  const lineOff = i => new Set([...(offKinds(commentOf(L[i]), 'hint-off') ?? []), ...(wholeLineComment(L[i - 1]) ? offKinds(commentOf(L[i - 1]), 'hint-off') ?? [] : [])]);
  const tagged = i => TAGS.some(t => commentOf(L[i]).includes(t) || (wholeLineComment(L[i - 1]) && commentOf(L[i - 1]).includes(t)));
  const add = (i, kind) => {
    if (!active.has(kind) || fileOff.has(kind) || lineOff(i).has(kind)) return;
    const { seen: what, use, docRef } = HINTS[kind];
    out.push({ level: 'warn', line: i + 1, kind, msg: `${what}: ${L[i].trim().slice(0, 80)}`, short: `use ${use.split(/ [(;]/)[0]} · off: // hint-off(${kind})${docRef ? ` · ${docReadCommand(docRef)}` : ''}`, fix: `use ${use}${docRef ? ` · read ${docRefsLine([docRef])}` : ''}. ${HOW.replaceAll('KIND', kind)}` });
  };
  const code = L.map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : codeOnly(l)));
  const whole = code.join('\n');
  const picture = art || /\btype:\s*['"]picture['"]/.test(text);   // on the raw text: codeOnly blanks strings
  const quietFile = Object.fromEntries(KINDS.map(k => [k, !!HINTS[k].quiet?.test(whole)]));
  const within = (i, n) => (n.on === 'raw' ? L : code).slice(Math.max(0, i - n.lines), i + n.lines + 1).join('\n');
  const fires = (h, c, i) => !quietFile[h.kind] && !(h.gameplayOnly && picture)
    && (((!h.code || h.code.test(c)) && (!h.raw || h.raw.test(L[i]))) || !!h.orRaw?.test(L[i]))
    && !h.not?.test(c) && !h.notRaw?.test(L[i]) && (h.tags === false || !tagged(i))
    && !(h.yields && !quietFile[h.yields.kind] && h.yields.raw.test(L[i]))
    && (h.near ?? []).every(n => n.re.test(within(i, n)));
  code.forEach((c, i) => {
    if (c.trim()) for (const k of KINDS) if (fires(HINTS[k], c, i)) add(i, k);
  });
  // one hint per kind per 7 lines (a blend over four array reads is one finding)
  return out.filter((r, k) => !out.slice(0, k).some(p => p.kind === r.kind && r.line - p.line < 7));
}

export default {
  id: 'R40', title: 'Bypass hints: hand-rolled versions of engine systems in game code (warnings only)', game: true,
  remind: true,   // its warnings are reminders: they print through lib/remind.mjs (rules/index.mjs), never as plain warnings
  run() {
    // The switch belongs in the game's own package.json (games/<name>/): reading only the repo root's ignored it in this repository.
    // Both apply: the root's to every game, the game's to its own files. Each package.json is read once
    const hintsOf = new Map(), out = [];
    const settingOf = pj => {
      if (!hintsOf.has(pj)) {
        let h; try { h = existsSync(`${ROOT}/${pj}`) ? JSON.parse(readFileSync(`${ROOT}/${pj}`, 'utf8')).threedog?.hints : undefined; } catch { /* unreadable package.json: no setting */ }
        hintsOf.set(pj, h);
        for (const msg of hintsConfigProblems(h)) out.push({ level: 'warn', file: pj, line: 1, kind: 'switch', msg, fix: `"threedog": { "hints": { "${KINDS[0]}": false } }` });
      }
      return hintsOf.get(pj);
    };
    const rootSet = activeKinds(settingOf('package.json'));
    if (!rootSet.size) return Object.assign([], { note: 'bypass hints are switched off for this project' });
    // a game in its own repo: its own folders. games/ and the engine's examples are this repository's layout, and there they read node_modules instead of the game
    const files = P.MODE === 'game' ? [...new Set(P.gameDirs().flatMap(d => walk(rel(d) || '.', ['.js', '.mjs'])))] : [...walk(P.GAMES_REL, ['.js', '.mjs']), ...walk(P.EXAMPLES_REL, ['.js', '.mjs'])];
    for (const f of files) {
      if (/(^|\/)(tests|docs|scripts)\//.test(f)) continue;
      const game = f.startsWith(P.GAMES_REL + '/') ? f.split('/').slice(0, 2).join('/') + '/' : null;
      const active = game ? new Set([...activeKinds(settingOf(game + 'package.json'))].filter(k => rootSet.has(k))) : rootSet;
      if (!active.size) continue;
      let text; try { text = lines(f).join('\n'); } catch { continue; }
      for (const r of scanText(text, active, { art: isArtFile(f) })) out.push({ ...r, file: f });
    }
    return out;
  },
};
