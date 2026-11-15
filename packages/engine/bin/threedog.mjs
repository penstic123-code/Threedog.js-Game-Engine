#!/usr/bin/env node
// The `threedog` command. Why it lives in the engine package and only forwards: `npx threedog init` names the package called threedog, so
// with the engine installed alone npx used to fail with "could not determine executable to run", and an AI concluded the package has no init.
// The commands themselves stay in @threedog/tools (dev-only weight: playwright, vite, typescript); this file runs them in the same process,
// or says the one line to install them. Only one package may own a bin name, so @threedog/tools has no bin of its own.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

// The project's own install first (walking up from where the command runs): under pnpm's strict layout or Yarn PnP the engine's real folder
// cannot see @threedog/tools even when the project has it. Then the engine-relative lookup (a hoisted install, this repository's workspaces).
function findTools() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const pkg = join(dir, 'node_modules', '@threedog', 'tools');
    if (existsSync(join(pkg, 'package.json'))) return join(pkg, 'bin', 'threedog.mjs');
    if (dirname(dir) === dir) break;
  }
  try { return join(dirname(fileURLToPath(import.meta.resolve('@threedog/tools/paths'))), 'bin', 'threedog.mjs'); } catch { return null; }
}

const toolsBin = findTools();
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const install = `npm install -D @threedog/tools@${version.split('.')[0]}`;
if (!toolsBin) {
  console.error(`✗ The threedog commands (init, shot, check, how, dev) come with @threedog/tools, which is not installed here. Run:
  ${install}
  npx threedog ${process.argv.slice(2).join(' ') || 'init'}`);
  process.exit(1);
}
// A half-installed or broken copy: one repair line instead of a module-not-found stack
const broken = what => { console.error(`✗ @threedog/tools is installed but incomplete (${what}). Reinstall it: ${install}`); process.exit(1); };
if (!existsSync(toolsBin)) broken(`no ${toolsBin}`);
// The tools entry runs when argv[1] is its own path (it is also imported by tests, where it must not run)
process.argv[1] = toolsBin;
try { await import(pathToFileURL(toolsBin).href); }
// Only a missing file OF the tools package counts as a broken install; any other error (a game's own missing import) stays as it is
catch (e) {
  const norm = s => String(s).replaceAll('\\', '/').toLowerCase(), first = e?.message?.split('\n')[0] ?? '';
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && norm(first).includes(`module '${norm(dirname(dirname(toolsBin)))}/`)) broken(first); else throw e;
}
