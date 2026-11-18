// Tool builds are per-build folders: a second build must not take the files from a page another session still serves, and --no-build only reads
// the last successful build of its own kind (browser.mjs buildAndPreview).
// Fixture: the blank game template scaffolded into a throwaway games/ folder (so it resolves this repo's packages), built a few times.
// Run: threedog test "tool builds"
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAndPreview } from '../browser.mjs';
import { copyTemplates } from '../lib/scaffold.mjs';
import { GAMES } from '../paths.mjs';

export const name = 'tool builds: each build has its own folder, a running preview survives another build, --no-build reads only its own kind';

export async function run({ check }) {
  const dir = join(GAMES, 'tool-build-fixture'), madeGames = !existsSync(GAMES);
  rmSync(dir, { recursive: true, force: true });
  const root = join(dir, '.threedog/tool-build');
  const builds = () => readdirSync(root).filter(n => /^(plain|real-webgpu)-/.test(n));
  try {
    copyTemplates(dir, { name: 'tool-build-fixture' });
    const a = await buildAndPreview(dir);
    const aDir = JSON.parse(readFileSync(join(root, 'last-plain.json'), 'utf8')).dir;
    // a hashed chunk of A: the file vite's emptyOutDir took away from a running preview (404) when builds shared one folder
    const chunk = (await (await fetch(a.base + '/')).text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    check('the preview page names a hashed script', !!chunk);
    const b = await buildAndPreview(dir);
    check('[guard] a preview keeps its files after another build of the same game', (await fetch(a.base + chunk)).status === 200);
    await b.close();
    await a.close();
    const c = await buildAndPreview(dir);
    await c.close();
    check('a folder nobody serves and no last-*.json names is swept by the next build', !builds().includes(aDir) && builds().length === 2, builds().join(', '));
    const real = await buildAndPreview(dir, { kind: 'real-webgpu' });
    await real.close();
    rmSync(join(root, 'last-plain.json'));
    let err = '';
    try { await buildAndPreview(dir, { build: false }); } catch (e) { err = e.message; }
    check('[guard] a real-webgpu build is not what a plain --no-build picks up', /no plain tool build/.test(err) && /without --no-build/.test(err), err);
    const again = await buildAndPreview(dir, { kind: 'real-webgpu', build: false });
    const served = (await fetch(again.base + '/')).status;
    await again.close();
    check('--no-build of the same kind serves its last build', served === 200, String(served));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (madeGames && existsSync(GAMES) && !readdirSync(GAMES).length) rmSync(GAMES, { recursive: true, force: true });
  }
}
