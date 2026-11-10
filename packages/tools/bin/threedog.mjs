#!/usr/bin/env node
// The threedog command line (bin of @threedog/tools). The root npm scripts and each game's package.json scripts forward here.
// Works in this monorepo and in a game installed from npm (paths.mjs project(): MODE 'monorepo' or 'game'). Usage text is built from the tables below.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, TOOLS, MODE, command, findWorkspace, workspaces, rel, ENGINE, ownViteConfig, VITE_DEFAULT_CONFIG } from '../paths.mjs';
import { parseOptions, pagePath } from '../lib/cli-args.mjs';
import { nodeProblem, pathProblem, NODE_FIX } from '../lib/node-version.mjs';
import { COMMANDS, EXTRA } from '../threedog/command-table.mjs';

/** Commands that run one script of this package (with the remaining arguments) */
export const SCRIPTS = { test: 'run.mjs', check: 'check.mjs', types: 'types.mjs', shot: 'shot.mjs', perf: 'perf.mjs', stress: 'stress.mjs', capture: 'capture.mjs', bake: 'bake.mjs', assets: 'assets.mjs',
  doctor: 'doctor.mjs', 'new-game': 'new-game.mjs', init: 'init.mjs', picture: 'picture.mjs', content: 'content-ids.mjs', tune: 'tune.mjs', gallery: 'gallery.mjs', how: 'how-answer.mjs', relay: 'net-relay.mjs', art: 'art.mjs', lib: 'lib.mjs', examples: 'examples.mjs', mcp: 'threedog/mcp.mjs', 'api-count': 'api-count.mjs' };
/** Dev bridge commands: drive the page running under `npm run dev` (recipes/16-dev-bridge.md) */
export const BRIDGE = [...Object.keys(COMMANDS), ...Object.keys(EXTRA).filter(c => !c.startsWith('picture-')), 'session'];   // picture-* are the MCP's spelling of `threedog picture`
/** vite commands on one workspace */
export const VITE = ['dev', 'build', 'preview'];
/** Commands that start vite (or a page under it): they check the Node version first, since vite's own failure on an old Node names neither */
const NEEDS_NODE = [...VITE, 'test', 'shot', 'perf', 'stress', 'capture', 'gallery', 'bake'];
/** Doc generators: the engine generators only run in the monorepo; a game regenerates its GAMEMAP */
// metadata twice: codemap and apidoc read it, and it reads the api pages apidoc writes; this way one run settles a changed fact
const MAP = MODE === 'monorepo' ? ['metadata.mjs', 'gentypes.mjs', 'codemap.mjs', 'apidoc.mjs', 'metadata.mjs', 'gamemap.mjs'] : ['gamemap.mjs'];
export const USAGE = `Usage: threedog ${VITE.join('|')} [game | -w game] · threedog test [-w game] [test name…] · threedog check|types|map · ` +
  `threedog shot|perf|bake|assets [-w game] … [--gpu|--software] · shot|capture|perf [--size WxH] · threedog bake light [-w game] [--out f] [--size n] [--samples n] [--page url] · threedog stress [--only axis,…] · threedog new-game name · threedog init [folder] · threedog picture palette|compare … · threedog content ids [-w game] [--write] · threedog content set|add|remove|stamp|capture … · threedog tune show|write [file] [--apply] · threedog gallery [-w game] [--shots] · threedog how "task" · threedog art list <source> · threedog art copy <source> [names…] [--to art/] [--force] [--dry] · threedog art board [-w game] [--out file.html] [--json] [--live] · threedog lib add|list|status|check|pull|page … (your own art and systems library, ~/.threedog/library) · threedog examples list|pull <name> [--out dir] [--force] · threedog doctor · threedog api-count [--unused] [--json] [--games dirA,dirB] (engine repo) · threedog relay [port] · threedog mcp [-w game] [--allow-js] · dev bridge: threedog ${BRIDGE.join('|')}`;

const node = (script, args, cwd = process.cwd()) => spawnSync(process.execPath, [join(TOOLS, script), ...args], { stdio: 'inherit', cwd }).status ?? 1;
/** --help / -h: print the script's header comment instead of running it (`threedog test --help` used to start the whole suite) */
const wantsHelp = args => args.includes('--help') || args.includes('-h');
/** The text --help prints for these scripts (their header comments); exported so the CLI test checks each declared option against what --help says */
export const helpText = scripts => scripts.map(s => {
  const out = [];
  for (const l of readFileSync(join(TOOLS, s), 'utf8').split('\n')) { if (l.startsWith('#!')) continue; if (!l.startsWith('//')) break; out.push(l.replace(/^\/\/ ?/, '')); }
  return out.join('\n');
}).filter(Boolean).join('\n\n');
function help(scripts) {
  console.log(helpText(scripts) || USAGE);
  return 0;
}

/** Run the CLI with argv (without node and the script path); returns the exit code */
export function main([cmd, ...rest]) {
  const nodeBad = NEEDS_NODE.includes(cmd) && !wantsHelp(rest) && nodeProblem();
  if (nodeBad) { console.error(`✗ ${nodeBad}\n  → ${NODE_FIX}`); return 1; }
  const pathBad = NEEDS_NODE.includes(cmd) && !wantsHelp(rest) && pathProblem(ROOT);
  if (pathBad) { console.error(`✗ ${pathBad}`); return 1; }
  if (VITE.includes(cmd)) {
    // The workspace: -w / --workspace like every other command (taken out here: to vite, -w is --watch, so `build -w game` sat in watch mode on
    // the wrong root and never exited), or a game name as the first argument (the 5000 in a later --port 5000 is not a game name); with neither,
    // the workspace of the current directory, otherwise the engine package. Drop the extra --: vite treats everything after -- as positional
    // arguments, which would disable --port. Every other option is vite's (passthrough), so vite reads and checks it
    let dir, name, args;
    try {
      const picked = command(rest.filter(a => a !== '--'), { fallback: workspaces()[0] ?? ENGINE, positional: true, passthrough: true });
      args = picked.rest;
      name = !picked.named && args[0] && !args[0].startsWith('-') ? args[0] : undefined;
      if (name) { dir = findWorkspace(name); args = args.slice(1); } else dir = picked.dir;
      // --base /my-game/ (deploying under a sub-path): Git Bash rewrote it into "C:/Program Files/Git/my-game/", which vite then wrote into
      // every asset URL of the build; it is a URL path like a page path, so the same undo applies (recipes/61-deploy.md)
      args = args.map((a, i) => args[i - 1] === '--base' ? pagePath(a) : a.startsWith('--base=') ? '--base=' + pagePath(a.slice(7)) : a);
    } catch (e) { console.error(e.message); return 1; }
    if (!dir) { console.error(`"${name}" not found. Available: ${workspaces().map(rel).join(', ')}`); return 1; }
    // vite's exports do not expose bin/vite.js, so find its package.json and read the bin field
    // Look from the game, then from this tools package (npm may install vite nested under packages/tools instead of the root), then the root
    const pkg = [dir, TOOLS, ROOT].map(from => { try { return createRequire(join(from, 'package.json')).resolve('vite/package.json'); } catch { return null; } }).find(Boolean);
    if (!pkg) { console.error('vite is not installed: run npm install (it comes with @threedog/tools)'); return 1; }
    const vite = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.vite);
    console.log(`${cmd}: ${rel(dir) || '.'}`);
    // a game without its own vite config gets the threedog preset (Workers as ES modules, multi-page input, dev bridge), not vite's bare defaults
    const own = ownViteConfig(dir) || args.some(a => a === '--config' || a === '-c' || a.startsWith('--config='));
    const cfg = own ? [] : ['--config', VITE_DEFAULT_CONFIG];
    return spawnSync(process.execPath, [vite, ...(cmd === 'dev' ? [] : [cmd]), ...cfg, ...args], { stdio: 'inherit', cwd: dir }).status ?? 1;
  }
  // map -w <game>: only that game's GAMEMAP (the engine docs and declarations do not depend on one game)
  if (cmd === 'map' && wantsHelp(rest)) return help(MAP);
  if (SCRIPTS[cmd] && wantsHelp(rest)) return help([SCRIPTS[cmd]]);
  if (cmd === 'map') {
    // one parse for the whole map, then each generator gets only the options it reads (they parse strictly too)
    let m;
    try { m = parseOptions(rest, { workspace: true, flags: ['check', 'report'] }); } catch (e) { console.error('✗ ' + e.message); return 1; }
    const check = m.opt.check ? ['--check'] : [];
    const argsOf = { 'gamemap.mjs': [...check, ...(m.workspace !== undefined ? ['-w', m.workspace] : [])], 'apidoc.mjs': [...check, ...(m.opt.report ? ['--report'] : [])] };
    for (const s of m.workspace !== undefined ? ['gamemap.mjs'] : MAP) { const c = node(s, argsOf[s] ?? check); if (c) return c; }
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }   // asked for: not a failure, a script reading the exit code must see that
  if (BRIDGE.includes(cmd)) return node('threedog/cli.mjs', [cmd, ...rest]);
  if (cmd === 'bake' && rest[0] === 'light') return node('bake-light.mjs', rest.slice(1));   // a sub-command, so a baked model can never be named after it
  if (SCRIPTS[cmd]) return node(SCRIPTS[cmd], rest);
  if (cmd) { console.error(`Unknown command "${cmd}". Run threedog --help for the commands.`); return 1; }
  console.log(USAGE);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href || /[\\/]threedog(\.mjs|\.cmd)?$/.test(process.argv[1] || '')) {
  // Bridge commands run IN this process (cli.mjs exits by itself): spawning a second node for them cost ~0.25 s per command on Windows
  if (BRIDGE.includes(process.argv[2])) { process.argv.splice(1, 1, join(TOOLS, 'threedog', 'cli.mjs')); await import('./../threedog/cli.mjs'); }
  else process.exit(main(process.argv.slice(2)));
}
