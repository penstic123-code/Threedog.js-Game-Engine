// Pre-push guard for the public copy (../threedog-push): internal records must never reach the public GitHub repo.
// Usage: node scripts/check-public-export.mjs [dir]   (dir defaults to the current folder; exits 1 and names each offending path)
// It checks the files git tracks there (what a push sends), not the folder on disk. The lists below are the one place that says what stays private.
// The contributor documents (CLAUDE.md, .claude/rules/, docs/design.md, docs/architecture.md) are public on purpose: the README sends engine contributors to them.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const PRIVATE = ['HANDOFF.md', 'docs/workflow.md', 'docs/plans/', 'docs/research/', 'experiments/', 'games/', 'docs/testing/'];
/** Inside a private entry, what is public: the testing evidence and perf numbers the README cites, and the empty games folder marker */
export const PUBLIC = ['games/.gitkeep', 'docs/testing/README.md', 'docs/testing/perf.md', 'docs/testing/capability/', 'docs/testing/field/2026-11-05-city/'];

const under = (f, p) => p.endsWith('/') ? f.startsWith(p) : f === p;
/** Offending tracked paths among files (repo-relative, forward slashes) */
export const offending = files => files.filter(f => PRIVATE.some(p => under(f, p)) && !PUBLIC.some(p => under(f, p)));

if (process.argv[1]?.endsWith('check-public-export.mjs')) {
  const dir = resolve(process.argv[2] ?? '.');
  const bad = offending(execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  if (bad.length) {
    console.error(`✗ ${bad.length} internal file(s) tracked in the public copy ${dir}:\n${bad.slice(0, 20).map(f => '  ' + f).join('\n')}${bad.length > 20 ? `\n  … (+${bad.length - 20})` : ''}\nRemove them (git rm) and commit again before pushing. The lists are PRIVATE / PUBLIC in scripts/check-public-export.mjs`);
    process.exit(1);
  }
  console.log('✓ no internal files tracked in ' + dir);
}
