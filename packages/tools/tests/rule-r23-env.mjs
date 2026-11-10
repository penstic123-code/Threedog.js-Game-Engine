// Rule R23: an .env file is found at any depth in packages/, not only in the root and direct children of packages/.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../paths.mjs';
import R23 from '../rules/R23-publish.mjs';

export const name = 'rule R23: an .env file in a nested package folder is reported';

export async function run({ check }) {
  const dir = join(ROOT, 'packages', 'tools', 'tests', '.r23-nested-tmp');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'X=1\n');
    const found = R23.run().filter(f => /\.env/.test(f.file));
    check('a nested .env.local is reported although .local is no text extension', found.some(f => f.file.includes('.r23-nested-tmp')), JSON.stringify(found));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
