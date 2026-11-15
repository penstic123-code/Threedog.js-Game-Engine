// Run npm without a shell. Under `npm run` / `npm test`, npm_execpath points at npm's JavaScript entry, which node runs directly (no shell joining
// arguments unquoted, paths with spaces are safe). Outside npm, the npm-cli.js next to the node binary is used; a shell is the last resort.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function npmCli() {
  const e = process.env.npm_execpath;
  if (e && /\.c?js$/.test(e) && existsSync(e)) return e;
  for (const p of [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')])
    if (existsSync(p)) return p;
  return null;
}

/** spawnSync for npm with args; opts as spawnSync (encoding defaults to utf8) */
export function npm(args, opts = {}) {
  const cli = npmCli(), o = { encoding: 'utf8', ...opts };
  if (cli) return spawnSync(process.execPath, [cli, ...args], o);
  const q = a => /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
  return spawnSync('npm', process.platform === 'win32' ? args.map(q) : args, { ...o, shell: process.platform === 'win32' });
}

/** End a process and everything it started (npm runs through a shell on Windows, check spawns tsc): taskkill /T there, the process group elsewhere */
export function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
}
