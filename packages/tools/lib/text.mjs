// Source-text helpers shared by the generators, rules and the test runner (codemap, gamemap, check, R18, run): one walk with one skip set,
// the file summary, bracket pairing, top-level argument splitting, and "did you mean" suggestions.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_DIRS, notGameSource } from '../paths.mjs';
import { distance, closest } from 'threedog/spelling';
export { closest };

// Line endings normalized to \n: a file checked out or saved with CRLF (Windows editors, git autocrlf) must give the same map as one with LF.
// In JS regex '.' does not match \r, so '// summary\r' missed the comment pattern and '# Title\r\n' was not stripped; the map then flipped
// between two outputs depending on how the file was last written. Callers only read (maps, scans, checks); nothing writes this text back.
export const read = f => readFileSync(f, 'utf8').replace(/\r\n?/g, '\n');
export const uniq = a => [...new Set(a)];

/**
 * Files under d (sorted, recursive) whose name matches exts (default .js / .mjs). skip adds names to SKIP_DIRS;
 * skipDir(name, path) can veto more folders. In a game's own repo only the game's sources are listed (paths.mjs gameSources).
 * unscoped: a folder read as it is, not as game source (an art pack being copied, its public/ included; a game's tests): only node_modules, dist and
 * dot names are left out, and the game's src / exclude settings do not apply.
 */
export function walk(d, { exts = /\.(js|mjs)$/, skip = [], skipDir, start = d, unscoped = false } = {}, out = []) {
  if (!existsSync(d)) return out;
  const no = new Set([...(unscoped ? ['node_modules', 'dist'] : SKIP_DIRS), ...skip]);
  for (const f of readdirSync(d).sort()) {
    if (no.has(f) || unscoped && f.startsWith('.')) continue;
    const p = join(d, f), dir = statSync(p).isDirectory();
    if (!unscoped && notGameSource(p, start, dir)) continue;
    if (dir) { if (!skipDir?.(f, p)) walk(p, { exts, skip, skipDir, start, unscoped }, out); }
    else if (exts.test(p)) out.push(p);
  }
  return out;
}

/**
 * A game's own code files (absolute paths): every .js / .mjs at any depth (main.js, game/, picture/, plugins/, content/), its tests and vite config left out.
 * The one answer for "the game's code": a scan of the top-level files alone called every action, flag and dialogue of a game built in game/ unused.
 */
export const gameCodeFiles = dir => walk(dir, { skip: ['tests', 'vite.config.js', 'vite.config.mjs'] });

/** A keyboard key's KeyboardEvent.code, as a regex source: what content actions bind and `threedog press` sends */
export const KEYBOARD_CODE = 'Key[A-Z]|Digit\\d|Numpad\\w+|F\\d+|Arrow(Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|'
  + 'Minus|Equal|Comma|Period|Slash|Semicolon|Quote|Backquote|BracketLeft|BracketRight|Backslash';

/** The description at the top of a file: the first comment block, up to two lines (// or /** style) */
export function summary(text) {
  const out = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*\/\/\s?(.*)$/) || l.match(/^\s*\/?\*+\s?(.*?)\s*\*?\/?$/);
    if (!m) { if (out.length) break; else continue; }
    if (m[1].trim()) out.push(m[1].trim());
    if (out.length >= 2) break;
  }
  return out.join(' ');
}

/**
 * The first sentence of a summary, max n characters. A header that ends in ':' followed by a numbered list keeps the first item
 * ("Asset management: asset manifest…" instead of "Asset management: 1").
 */
export function oneSentence(s, n = 70) {
  let t = s.replace(/\|/g, '/');
  t = t.replace(/:\s*1[.)]\s*/, ': ');
  t = t.split(/\.(?:\s|$)|。/)[0].replace(/:\s*$/, '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** The content inside the matching brackets after the first `open` at or after `from`; null if none */
export function balanced(text, open, from = 0) {
  return balancedAt(text, open, from)?.body ?? null;
}
function balancedAt(text, open, from) {
  const i = text.indexOf(open, from); if (i < 0) return null;
  let d = 0;
  for (let j = i + open.length - 1; j < text.length; j++) {
    if ('([{'.includes(text[j])) d++;
    else if (')]}'.includes(text[j]) && --d === 0) return { body: text.slice(i + open.length, j), index: i, end: j };
  }
  return null;
}
/** Every bracketed body after `open` (grids.add( … ) called several times): [{ body, index }] */
export function balancedAll(text, open) {
  const out = [];
  for (let at = 0, b; (b = balancedAt(text, open, at)); at = b.end) out.push(b);
  return out;
}

/** Split arguments at top-level commas (commas inside brackets and quotes do not count, a \\' stays inside its string; stops at an unmatched closing bracket) */
export function splitTop(src) {
  const out = []; let d = 0, q = null, cur = '', esc = false;
  for (const ch of src) {
    if (q) { cur += ch; if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) { if (d === 0) break; d--; }
    else if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The n entries of list nearest to name, nearest first (substring matches rank first); for "close:" hints where nothing matched */
export function nearest(name, list, n = 3) {
  const q = String(name).toLowerCase();
  const score = c => { const s = String(c).toLowerCase(); return s.includes(q) || q.includes(s) ? 0 : distance(q, s.slice(0, Math.max(q.length, 1) + 4)); };
  return uniq(list).map(c => [c, score(c)]).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
}

/** A string as literal regex source */
export const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Bytes as "12.3 KB" */
export const kb = n => (n / 1024).toFixed(1) + ' KB';
/** A heading as its markdown anchor (what GitHub links to): lower case, code ticks and punctuation gone, each whitespace a hyphen */
// one anchor rule for the docs and threedog how --read: the engine's (core/base/docRef.js), so a printed command and a heading always agree
export { docSlug as slug } from 'threedog/error-hints';
/** A value with object keys sorted at every depth, so two JSON texts compare without key order */
export const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
/** Equal ignoring object key order */
export const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Comments blanked, line numbers kept: a name in a comment is not a use. Strings go first so a '//' inside a URL survives.
 *  shortcut: a regex literal holding a quote and // on one line can blank too much of that line; upgrade to a real parser if a game shows it */
export function noComments(text) {
  return text.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/.*$|\/\*[\s\S]*?\*\//gm,
    m => m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m);
}
