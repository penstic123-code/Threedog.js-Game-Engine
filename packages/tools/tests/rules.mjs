// Rule tests (no browser): R7 reads the cancel convention from .claude/rules/api-design.md and must report an error, never skip silently, when it cannot find it.
// The parser is fed fixture texts here, so the test does not depend on the real doc.
import { conventionFromText } from '../rules/R07-naming.mjs';
import r2 from '../rules/R02-unused-exports.mjs';
import r10 from '../rules/R10-duplicates.mjs';
import r22 from '../rules/R22-doc-shape.mjs';

export const name = 'rule R7: cancel convention parser';

const doc = line => `# API design\n\nintro\n\n## Interface conventions\n\n- Position arguments are objects.\n${line}\n- Other line.\n\n## Other section\n\nCancel convention: returns a cancel function off()\n`;

export async function run({ check }) {
  check('"handle with remove()" → handle', conventionFromText(doc('Cancel convention: returns a handle with remove()')).kind === 'handle');
  check('"handle" alone → handle', conventionFromText(doc('Cancel convention: a handle')).kind === 'handle');
  check('"cancel function off()" → off', conventionFromText(doc('Cancel convention: returns a cancel function off()')).kind === 'off');
  check('"stop()" → stop', conventionFromText(doc('Cancel convention: returns { stop() }')).kind === 'stop');
  check('no "## Interface conventions" section → error', !!conventionFromText('# API design\n\nCancel convention: a handle\n').error);
  check('the line must be inside that section, not in a later one', !!conventionFromText('## Interface conventions\n\n- x\n\n## Later\n\nCancel convention: a handle\n').error);
  check('section without a "Cancel convention:" line → error', !!conventionFromText(doc('- no cancel line here')).error);
  check('a line naming none of the three → error', !!conventionFromText(doc('Cancel convention: call dispose()')).error);
  // Rules must not report what they cannot judge: a name read through (await load(file)).name, generated files, a README and its translation.
  check('R2: no "handRolled" reported unused (read via (await load(file)).handRolled in a tool)', !(await r2.run({})).some(r => /handRolled/.test(r.msg)));
  check('R10: no *.generated.js file in the results', !(await r10.run({})).some(r => /[.]generated[.]js/.test(r.file + r.msg)));
  check('R22: README.zh-CN.md is not "same sentence" as README.md', !(await r22.run({})).some(r => /same sentence/.test(r.msg) && /README[.]zh-CN[.]md/.test(r.file) && /README[.]md/.test(r.msg)));
}
