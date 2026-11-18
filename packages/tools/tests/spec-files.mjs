// Spec files: a file that cannot be imported is named with the cause and the fix while the others still load (S7); R56 flags a time verdict without serial (S6).
// Why: a spec touching `document` at top level used to stop the whole round with a bare "document is not defined" and no file name.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workspaceSpecs } from '../lib/specs.mjs';
import { timingVerdict } from '../rules/R56-timing-serial.mjs';

export const name = 'spec files: an import that throws is named (file, import, why, fix) and the other files still load; R56 timing verdicts';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'td-specs-'));
  try {
    const sd = join(dir, 'tests', 'specs');
    mkdirSync(sd, { recursive: true });
    const put = (f, s) => writeFileSync(join(sd, f), s);
    put('ok.mjs', "export const specs = [{ name: 'ok', url: '/', run() {} }];");
    put('bad-direct.mjs', "export const specs = [{ name: 'd', url: '/', run() {} }]; document.body;");
    put('bad-indirect.mjs', "import './dep.mjs'; export const specs = [{ name: 'i', url: '/', run() {} }];");
    put('dep.mjs', 'export const t = window.innerWidth;');
    const problems = [], found = await workspaceSpecs(dir, problems);
    check('[guard] the good file still loads when others do not', found.length === 1 && found[0].file === 'ok.mjs', JSON.stringify(found.map(x => x.file)));
    const direct = problems.find(p => p.includes('bad-direct.mjs')) ?? '', indirect = problems.find(p => p.includes('bad-indirect.mjs')) ?? '';
    check('[guard] it names the file, the cause and the fix', /document is not defined/.test(direct) && /top level cannot touch document or window/.test(direct) && /Fix:/.test(direct), direct);
    check('[guard] an import of another file names the file that threw', /thrown in .*dep\.mjs/.test(indirect), indirect);
    let thrown = '';
    try { await workspaceSpecs(dir); } catch (e) { thrown = e.message; }
    check('without a problems list it still throws (one message, same text)', /could not be imported/.test(thrown), thrown);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const slow = "check('x', r.crowd.ms < 1, 1)", rel = "check('a', r.msGrid * 3 < r.msLinear)", flat = "check('b', r.removeMs < 150, String(r.removeMs))";
  check('[guard] R56 sees an upper bound on a time (also reversed and scaled)', [slow, rel, flat, "check('c', 100 > r.cpuMs);"].every(s => timingVerdict(s.endsWith(';') ? s : s + ';')));
  check('R56 leaves out lower bounds, "was measured", labels, game time and names that merely end in ms', [
    "check('t', r.ms >= 20);", "check('m', r.ms > 0);", "check('took 5 ms < x', r.n === 3);", "check('e', r.elapsed < 2);", "check('s', stems[0] > 0.9);", "check('rms', r.rms * 3 < r.sm);",
  ].every(s => !timingVerdict(s)));
  // Why: a spec named after a review round says nothing about what it guards, and each round added a new one. Name a new spec for the behavior it guards, or add to the spec that owns it.
  const ROUND_NAMED = /^(group-|review|r4-fixes|audit-fixes|demo2-fixes|friction-fixes|genericity-fixes|chaos-)/, ROUND_NAMED_NOW = 47;
  const named = readdirSync(fileURLToPath(new URL('../../engine/tests/specs', import.meta.url))).filter(f => ROUND_NAMED.test(f));
  check('[guard] no new spec file is named after a review round (the count only goes down)', named.length <= ROUND_NAMED_NOW, `${named.length} > ${ROUND_NAMED_NOW}: ${named.slice(-3).join(', ')}`);
}
