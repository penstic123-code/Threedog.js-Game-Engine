// Create a new game in one step: npm run new-game -- name [--open-world | --pixel | --scene-only] [--webgl]
// Default: the blank template (templates/game): an empty scene with a camera, empty content files, a gray picture/ folder, no gameplay, no genre.
// --open-world: overlays templates/openworld (generated terrain, day/night sky, follow camera, a player).
// --pixel: overlays templates/pixel (a sprite character, pixelSize, pixelSnap camera, input, interaction, dialogue, saves). Not together with --open-world.
// --scene-only: overlays templates/sceneonly and leaves the base's content/ and assets.js out (a showcase scene with nothing placed). One start flag at a time.
// The game runs on WebGPU with TSL shaders; --webgl: on WebGL with GLSL shaders (lib/scaffold.mjs says why it is chosen here).
// Copies the template layers to games/<name>/, replacing __NAME__ in files with the name; links node_modules/<name>, generates GAMEMAP and runs check (scoped to the new game).
// It does not build or touch package-lock.json: a smoke test built a ~10 MB dist/ into the new folder, and `npm install --package-lock-only` rewrote the
// whole root lock for an entry nothing needs yet. npm install runs only when a dependency is not installed.
// The templates are real files; to change the starting point of new games, edit those directories directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { npm } from './lib/proc.mjs';
import { parseArgs, applyDeps, copyTemplates, writeMcp } from './lib/scaffold.mjs';
import { ROOT, TOOLS, GAMES, rel, workspaces } from './paths.mjs';

// npm swallows flags in npm run new-game name --open-world (they become npm config and never reach argv): use `npm run new-game -- name --open-world`; the npm_config_* env vars are read as a fallback (parseArgs)
const opts = parseArgs(process.argv.slice(2), process.env);
const USAGE = 'Usage: npm run new-game -- name [--open-world | --pixel] [--webgl] (name: lowercase letters, digits and hyphens only, e.g. my-farm)';
if (opts.error) { console.error(opts.error + '\n' + USAGE); process.exit(1); }
const name = opts.name;
if (!name) { console.error(USAGE); process.exit(1); }
if (!/^[a-z0-9-]+$/.test(name)) { console.error(`name "${name}" is not allowed: only lowercase letters, digits and hyphens (a-z 0-9 -)`); process.exit(1); }
const dir = join(GAMES, name);
if (existsSync(dir) || workspaces().some(d => d.endsWith(`/${name}`) || d.endsWith(`\\${name}`))) { console.error(`${rel(dir)} already exists, pick another name`); process.exit(1); }

// Blank template (templates/game) = a scene and a camera, empty content, gray picture/; --open-world overlays templates/openworld
copyTemplates(dir, { ...opts, name });
// package.json dependencies follow the open-world choice
const pkgPath = join(dir, 'package.json'), pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies = applyDeps(pkg.dependencies, opts);
// A game inside the repo always uses the workspace copies: "*" matches whatever version they have now (a ^0.x range stops at the next minor, and then
// npm fails with ETARGET or quietly installs a second, old engine from the registry). `threedog doctor --fix` repairs games that still carry a range.
for (const n of Object.keys(pkg.dependencies)) if (n === 'threedog' || n.startsWith('@threedog/')) pkg.dependencies[n] = '*';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
// MCP for Claude Code opened in the game folder: plain node on this repo's tools (npx costs ~2.5 s and needs `cmd /c` on Windows); the path is relative so the repo can move
const mcpBin = relative(dir, join(TOOLS, 'bin', 'threedog.mjs')).replaceAll('\\', '/');
writeMcp(join(dir, '.mcp.json'), mcpBin);
console.log(`✓ created ${rel(dir)} (${opts.pixel ? 'pixel 2.5D' : opts.openWorld ? 'open world' : 'blank'}, ${opts.webgl ? 'WebGL, GLSL shaders' : 'WebGPU, TSL shaders'})`);

// Workspace link node_modules/<name> → the game directory: the path npm itself gives a workspace whose package.json name is <name> (the template's
// name is the plain game name, see templates/game/package.json). A junction needs no administrator rights on Windows, and non-ASCII paths are fine.
// This way the game can be found by -w name without running npm install (which reinstalls and is slow)
const link = join(ROOT, 'node_modules', name);
if (!existsSync(link)) {
  try { mkdirSync(dirname(link), { recursive: true }); symlinkSync(dir, link, 'junction'); }
  catch (err) { console.warn(`! could not create the workspace link (${err.message}), run npm install in the repo root later`); }
}

const threedog = join(TOOLS, 'bin', 'threedog.mjs');
const run = (cmd, args, label) => {
  console.log(`… ${label}`);
  const r = cmd === 'npm' ? npm(args, { cwd: ROOT, stdio: 'inherit' }) : spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
};
// Install only when a dependency is missing from node_modules (e.g. terrain-noise for --open-world outside this repo); otherwise the lock stays as it is
const missing = Object.keys(pkg.dependencies ?? {}).filter(d => !existsSync(join(ROOT, 'node_modules', d)));
if (missing.length) {
  if (!run('npm', ['install', '--no-audit', '--no-fund'], `npm install (not installed yet: ${missing.join(', ')}; this also records the game in package-lock.json)`))
    console.warn(`! npm install failed: install ${missing.join(', ')} by hand (npm install in the repo root)`);
} else console.log('– package-lock.json not touched: every dependency is installed and the game runs through the link; the next npm install in the repo root records it in the lock');
// Scoped to the new game (-w): another game's errors do not fail this one (check.mjs, lib/scope.mjs)
const ws = `games/${name}`;
const steps = [[['map', '-w', ws], 'generate GAMEMAP.md'], [['check', '-w', ws], 'rule checks']];
for (const [args, label] of steps) {
  if (!run(process.execPath, [threedog, ...args], label)) {
    console.error(`✗ "${label}" failed (see the errors printed just above, e.g. type errors or rule violations). The game files ARE generated at ${rel(dir)}. Next: fix the first error shown, then re-run \`threedog ${args.join(' ')}\`; or delete the directory if you do not want it`);
    process.exit(1);
  }
}
console.log(`
✓ Done. Play: npm run dev -- ${name}  write gameplay ideas in ${rel(dir)}/DESIGN.md  (smoke test, which builds: threedog test -w ${ws})`);
