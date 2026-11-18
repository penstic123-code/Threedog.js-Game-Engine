// R10 duplicated code (warning): copy-pasted snippets in packages/engine/ — change one place, forget the other.
// Criteria: TypeScript's scanner splits each file into tokens (ignoring whitespace and comments) and hashes every WINDOW consecutive tokens;
//   equal hashes at two places are extended forward until they differ, giving a "longest identical run". A run spanning ≥ MIN_LINES lines (at either place) or ≥ MIN_TOKENS tokens → warning, listing both places.
//   Why count tokens too: this project likes many tokens per line (15–25), so "over 6 lines" alone would catch nothing; 50 tokens is about 6–7 lines of ordinary style.
//   Generated files (`*.generated.js`) are left out, the same test layer-scan uses.
// Option: ANON = true treats all identifiers as the same (catches copy-paste with renamed variables) at the cost of more false positives; off by default, --r10-anon turns it on temporarily.
// Limitation: only consecutive verbatim repeats; same structure written differently (argument order, other expression) is missed. Very short repeats (such as a one-line fmt in 4 places) are not reported.
import { ts, engineFiles, read, reE, isGeneratedFile } from './_lib.mjs';

const WINDOW = 25, MIN_LINES = 7, MIN_TOKENS = 50;
const ANON = process.argv.includes('--r10-anon');
// Allowlist: [file regex, reason]
const ALLOW = [
  [reE('modules\\/terrain\\/chunkWorker\\.js$'), 'a Worker cannot import main-thread modules, so a little copying is unavoidable'],
];

function tokenize(file) {
  const text = read(file), sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const lineStarts = ts.computeLineStarts(text), toks = [];
  const lineAt = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  let k, prev = null;
  while ((k = sc.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    // regex / template string: decide from the previous token whether this is a division sign
    if ((k === ts.SyntaxKind.SlashToken || k === ts.SyntaxKind.SlashEqualsToken) && (prev == null || ![ts.SyntaxKind.Identifier, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.StringLiteral].includes(prev))) k = sc.reScanSlashToken();
    const v = k === ts.SyntaxKind.Identifier ? (ANON ? 'ID' : sc.getTokenText()) : (k <= ts.SyntaxKind.LastLiteralToken ? sc.getTokenText() : k);
    toks.push({ v: String(v), line: lineAt(sc.getTokenPos()) });
    prev = k;
  }
  return toks;
}

export default {
  id: 'R10', title: 'Duplicated code',
  run() {
    const files = engineFiles().filter(f => !ALLOW.some(([r]) => r.test(f)) && !isGeneratedFile(f));
    const T = files.map(tokenize);
    // window hash → list of positions
    const buckets = new Map();
    T.forEach((toks, fi) => {
      for (let i = 0; i + WINDOW <= toks.length; i++) {
        let h = '';
        for (let j = 0; j < WINDOW; j++) h += toks[i + j].v + '\u0001';
        if (!buckets.has(h)) buckets.set(h, []);
        buckets.get(h).push([fi, i]);
      }
    });
    const found = [], covered = new Set();
    for (const list of buckets.values()) {
      if (list.length < 2 || list.length > 30) continue;
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const [fa, ia] = list[a], [fb, ib] = list[b];
        if (fa === fb && Math.abs(ia - ib) < WINDOW) continue;   // overlaps with itself
        const A = T[fa], B = T[fb];
        if (ia > 0 && ib > 0 && A[ia - 1].v === B[ib - 1].v) continue;   // not the start of the longest run
        let n = WINDOW;
        while (ia + n < A.length && ib + n < B.length && A[ia + n].v === B[ib + n].v && !(fa === fb && ia + n >= ib)) n++;
        const la = [A[ia].line, A[ia + n - 1].line], lb = [B[ib].line, B[ib + n - 1].line];
        const lines = Math.max(la[1] - la[0], lb[1] - lb[0]) + 1;
        if (lines < MIN_LINES && n < MIN_TOKENS) continue;
        const key = `${fa}:${la[0]}|${fb}:${lb[0]}`;
        if (covered.has(key)) continue;
        covered.add(key);
        found.push({ fa, la, fb, lb, n, lines });
      }
    }
    found.sort((x, y) => y.n - x.n);
    return found.map(d => ({ level: 'warn', file: files[d.fa], line: d.la[0],
      msg: `lines ${d.la[0]}–${d.la[1]} duplicate ${files[d.fb]}:${d.lb[0]}–${d.lb[1]} (${d.n} tokens)`,
      fix: 'extract a shared function (in packages/engine/core or the module\'s own common.js) and call it from both places' }));
  },
};
