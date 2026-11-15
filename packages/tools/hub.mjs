// threedog hub [--port 5180] [--no-open] [--shortcut]
// A local web page that lists your threedog games and shows each game's screenshot wall (points in the game's shots.json), re-shot by itself after file changes.
//   threedog hub                open the hub (if one is already running on the port, just open its page)
//   threedog hub --port 5200    another port
//   threedog hub --no-open      start without opening a browser
//   threedog hub --shortcut     put (or repoint) a desktop icon that starts the hub (Windows)
// Close the console window or Ctrl+C to stop it; the page also has a "Close hub" button.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from './hub/server.mjs';
import { ensureShortcut } from './hub/shortcut.mjs';

const args = process.argv.slice(2), has = f => args.includes(f);
const pi = args.indexOf('--port'), port = pi >= 0 ? Number(args[pi + 1]) : 5180;
if (pi >= 0 && !(port >= 0 && port < 65536)) { console.error('✗ --port needs a number, e.g. --port 5200'); process.exit(1); }
const script = resolve(fileURLToPath(import.meta.url));

if (has('--shortcut')) { console.log(ensureShortcut({ script }).message); process.exit(0); }

function openBrowser(url) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

// single instance: a live hub on this port is reused, not doubled
const live = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).then(j => j.hub === 'threedog', () => false);
if (live) { console.log(`Hub already running: http://127.0.0.1:${port}`); if (!has('--no-open')) openBrowser(`http://127.0.0.1:${port}`); process.exit(0); }

let hub;
try { hub = await startHub({ port }); }
catch (e) { console.error(`✗ cannot start the hub on port ${port}: ${e.message}`); process.exit(1); }
console.log(`Hub: ${hub.url} (Ctrl+C or close this window to stop)`);
// an icon that points at a deleted copy of the tools is repointed here; no icon is never created without being asked
const sc = ensureShortcut({ onlyIfPresent: true, script });
if (sc.action === 'retarget') console.log(sc.message);
if (!has('--no-open')) openBrowser(hub.url);
const stop = () => hub.close().finally(() => process.exit(0));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
