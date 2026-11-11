// threedog init [folder]: turn a folder into a game outside this repository (after `npm install threedog @threedog/tools ...`). The folder is the
// argument (created when missing; the game is named after it) or, without one, the current folder.
// Flags as new-game: --open-world (generated ground, sky, follow camera, player), --scene-only (no content/ and no assets.js), --webgl (WebGL and GLSL shaders instead of WebGPU and TSL). Copies the new-game template (templates/game) without overwriting anything that exists, merges package.json (type, scripts, dependencies),
// and writes .mcp.json so Claude Code opened in this folder finds the threedog MCP server by itself (plain node: no npx start-up, no `cmd /c`).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLS, within } from './paths.mjs';
import { parseArgs, applyDeps, copyTemplates, writeMcp, gameName } from './lib/scaffold.mjs';

const USAGE = 'Usage: threedog init [folder] [--open-world | --pixel | --scene-only] [--webgl]   (folder: where the game goes, default the current folder)';
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) { console.error(parsed.error + '\n' + USAGE); process.exit(1); }
// Why the argument is a path: it used to be only a name, so `threedog init .demo/town-farm` wrote 18 files into the repo root and merged the root package.json
const dir = resolve(parsed.name ?? '.');
// A package.json with "workspaces" is a repository root, not a game: the game's files and scripts would be mixed into the repo
const pkgPath = join(dir, 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
if (pkg?.workspaces) { console.error(`✗ ${dir} is a repository root (its package.json has "workspaces"), not a game folder. Name the game's own folder: threedog init games/my-game\n${USAGE}`); process.exit(1); }
mkdirSync(dir, { recursive: true });
const name = gameName(basename(dir));
const opts = { ...parsed, name };
const made = [], kept = [];

// The template layers (blank base; --open-world overlays it); a file that already exists is kept; package.json is merged below
const r = copyTemplates(dir, opts, { skipPackage: true });
made.push(...r.made); kept.push(...r.kept);

// package.json: keep what the folder has, add only what is missing (the open-world choice adds its dependency)
const tpl = JSON.parse(readFileSync(join(TOOLS, 'templates', 'game', 'package.json'), 'utf8'));
const out = pkg ?? { version: '0.1.0', private: true };
out.name ??= name;
// every file of a game is an ES module: under "commonjs" (what a newer `npm init -y` writes) node cannot load content/*.js, so the tools cannot read the game
const wasType = out.type !== 'module' && out.type;
out.type = 'module';
// the test line `npm init` writes only fails: it stands for "no test yet", and left in place it hides the game's own
const scripts = { ...out.scripts };
if (/no test specified/.test(scripts.test ?? '')) delete scripts.test;
out.scripts = { ...tpl.scripts, ...scripts };
// a package the folder already lists under devDependencies stays there: `npm install -D @threedog/tools` before init left it in both
const wanted = Object.entries(applyDeps(tpl.dependencies, opts)).filter(([n]) => !out.devDependencies?.[n]);
out.dependencies = { ...Object.fromEntries(wanted), ...out.dependencies };
writeFileSync(pkgPath, JSON.stringify(out, null, 2) + '\n');

// The tools running this command, when the game sits under the folder that holds them (hoisted to a repo's node_modules, or the workspace packages/tools of this
// repository); otherwise the game's own node_modules (npx from a cache: the game installs its own copy next)
const home = resolve(TOOLS, ...(TOOLS.split(sep).includes('node_modules') ? ['..', '..', '..'] : ['..', '..']));
const bin = within(dir, home) ? relative(dir, join(TOOLS, 'bin', 'threedog.mjs')).replaceAll('\\', '/') : 'node_modules/@threedog/tools/bin/threedog.mjs';
const mcp = join(dir, '.mcp.json'), mcpState = writeMcp(mcp, bin);
(mcpState === 'made' ? made : kept).push(mcp);
if (mcpState === 'broken') console.warn(`! ${mcp} is not valid JSON, so the threedog server was not added: fix it and run threedog init again`);

// GAMEMAP.md belongs to a finished game: without it the very first threedog check failed. It needs the engine installed, so before npm install it cannot be written yet
const map = spawnSync(process.execPath, [join(TOOLS, 'gamemap.mjs')], { cwd: dir, encoding: 'utf8' });
if (map.status === 0) made.push(join(dir, 'GAMEMAP.md'));

const short = p => p.slice(dir.length + 1).replaceAll('\\', '/');
const where = relative(process.cwd(), dir).replaceAll('\\', '/');
console.log(`✓ threedog init${where ? ' ' + where : ''}: ${made.length} files written, package.json ${pkg ? 'merged' : 'created'}${kept.length ? `, ${kept.length} existing files kept (${kept.slice(0, 5).map(short).join(', ')}${kept.length > 5 ? ', …' : ''})` : ''}`);
if (wasType) console.log(`! package.json "type" was "${wasType}", now "module": a game's files are ES modules, and a CommonJS file of your own in this folder needs the .cjs ending`);
console.log(`Next: ${where ? `cd ${where}  →  ` : ''}npm install  →  ${map.status === 0 ? '' : 'npx threedog map  →  '}npm run dev  →  open Claude Code in this folder (it asks once to trust the threedog MCP server in .mcp.json)`);
