// Does a docRef point at something real? Shared by metadata.mjs (checks every handRolled hint) and its test. Not how.mjs readSection: how reads metadata's
// output, so metadata cannot import it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocRef } from 'threedog/error-hints';

/** Why a docRef points nowhere, or null when it exists: it must parse, name a file under docsDir, and its section must be a heading of that file. @param {string} docsDir @param {string} ref */
export function badDocRef(docsDir, ref) {
  const r = parseDocRef(ref);
  if (!r) return 'does not parse';
  const file = join(docsDir, r.file);
  if (!existsSync(file)) return 'names a file that is not there';
  if (!r.sec && !r.title) return null;
  const heads = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => /^#{2,} /.test(l)).map(l => l.replace(/^#+ /, ''));
  return heads.some(h => (r.sec ? h.startsWith(`${r.sec}. `) : h.startsWith(r.title))) ? null : 'names a section that is not there';
}
