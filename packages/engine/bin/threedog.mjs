#!/usr/bin/env node
// The `threedog` command. Why it lives in the engine package and only forwards: `npx threedog init` names the package called threedog, so
// with the engine installed alone npx used to fail with "could not determine executable to run", and an AI concluded the package has no init.
// The commands themselves stay in @threedog/tools (dev-only weight: playwright, vite, typescript); this file runs them in the same process,
// or says the one line to install them. Only one package may own a bin name, so @threedog/tools has no bin of its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

let toolsBin = null;
try { toolsBin = join(dirname(fileURLToPath(import.meta.resolve('@threedog/tools/paths'))), 'bin', 'threedog.mjs'); } catch { /* not installed */ }
if (!toolsBin) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.error(`✗ The threedog commands (init, shot, check, how, dev) come with @threedog/tools, which is not installed here. Run:
  npm install -D @threedog/tools@${version.split('.')[0]}
  npx threedog ${process.argv.slice(2).join(' ') || 'init'}`);
  process.exit(1);
}
// The tools entry runs when argv[1] is its own path (it is also imported by tests, where it must not run)
process.argv[1] = toolsBin;
await import(pathToFileURL(toolsBin).href);
