// Guard for the class "the CLI started through a link path runs nothing": the tools entry decides whether it is the main module, and a plain
// URL compare failed when argv[1] was a link (workspace / pnpm symlink, npm link, file: dependency) and printed nothing with exit 0.
// Every way the command is started must print something; plus the engine forwarder's project-first lookup and its broken-install line.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TOOLS, ENGINE, ROOT } from '../paths.mjs';

export const name = 'cli entry links: the threedog CLI runs when started through a link, the engine forwarder, or a broken tools install';

const cli = (file, args, cwd = ROOT) => {
  const r = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
// "help" exits 0 and prints the usage line: exit 0 with nothing printed is exactly the bug
const ranHelp = r => r.code === 0 && /Usage: threedog/.test(r.out);

export async function run({ check }) {
  check('the tools entry, started by its real path, runs', ranHelp(cli(join(TOOLS, 'bin/threedog.mjs'), ['help'])));
  const linked = join(ROOT, 'node_modules/@threedog/tools/bin/threedog.mjs');
  if (existsSync(linked)) check('the tools entry, started through node_modules/@threedog/tools (a workspace link here), runs', ranHelp(cli(linked, ['help'])));
  check('the engine forwarder (the threedog bin) runs the tools CLI', ranHelp(cli(join(ENGINE, 'bin/threedog.mjs'), ['help'])));

  const tmp = mkdtempSync(join(tmpdir(), 'threedog-cli-link-'));
  try {
    // a directory link made here (a junction on Windows needs no admin rights): the same shape as npm link or pnpm's store links
    symlinkSync(TOOLS, join(tmp, 'tools-link'), 'junction');
    const r = cli(join(tmp, 'tools-link', 'bin', 'threedog.mjs'), ['help']);
    check('the tools entry, started through a directory link, runs', ranHelp(r), r.out.slice(0, 200) || `exit ${r.code}, nothing printed`);

    // a project whose own node_modules has a tools package without its files: found before the engine-relative copy, and one repair line
    const proj = join(tmp, 'game');
    mkdirSync(join(proj, 'node_modules/@threedog/tools'), { recursive: true });
    writeFileSync(join(proj, 'node_modules/@threedog/tools/package.json'), '{"name":"@threedog/tools","version":"0.0.0"}');
    const b = cli(join(ENGINE, 'bin/threedog.mjs'), ['help'], proj);
    check('the forwarder looks in the project first; a broken tools install gives the reinstall line, exit 1, no stack',
      b.code === 1 && /incomplete.*npm install -D @threedog\/tools@/.test(b.out) && !/\n\s+at /.test(b.out), b.out.slice(0, 300));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
