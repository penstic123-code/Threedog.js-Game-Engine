// What a killed tool leaves behind: headless browsers nobody can close any more. Kept apart from browser.mjs (which loads Playwright) so every threedog
// command can sweep without paying for that import: bin/threedog.mjs starts a sweep when a command starts and waits for it before exiting, and
// launchBrowser sweeps once per process too. Two kinds are left behind:
//   a child (renderer, gpu) whose browser is gone: a page stuck in a loop does not notice its browser die and spins a core (six once ran 18 hours);
//   a whole browser whose tool is gone: the tool was killed (an agent's command timed out or was stopped) and nothing came later to close it.
// Only headless shells are touched, and only when their owner is gone: a live browser's children have their browser, a live browser has its tool.
// A reused pid can only make a dead owner look alive (a missed sweep, caught next time), never make a live one look dead.
import { execFile } from 'node:child_process';

const HEADLESS_SHELL = /(?:^|[\\/])(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i;
// every process's pid and parent (to see whether an owner is alive); the command line only for headless shells (the listing stays small)
const LIST_PROCESSES = process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.Name -like '*headless*') { $_.CommandLine } else { $_.Name }) }`]]
  : ['ps', ['-eo', 'pid=,ppid=,args=']];
/** The program a command line runs: its first word, or the first quoted part (Chromium quotes its own path on Windows, for its children, and that path can hold spaces) */
const programOf = cmd => { const m = cmd.match(/^"([^"]*)"|^\S*/); return m[1] ?? m[0]; };

/**
 * Headless-shell pids whose owner is gone, from a listing of every process ("pid ppid command" per line): children of a dead browser, and browsers of a
 * dead tool with everything under them. A headless shell is known by its program alone: an argument can name anything.
 * @param {string} listing @returns {number[]}
 */
export function orphanPids(listing) {
  const all = listing.split(/\r?\n/).map(l => l.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const alive = new Set(all.map(p => p.pid));
  const shells = all.filter(p => HEADLESS_SHELL.test(programOf(p.cmd))), shellPids = new Set(shells.map(p => p.pid));
  const child = p => /--type=/.test(p.cmd);
  const out = new Set(shells.filter(p => child(p) ? !shellPids.has(p.ppid) : !alive.has(p.ppid)).map(p => p.pid));
  // a dead tool's browser goes with its whole tree
  for (let grew = true; grew;) { grew = false; for (const p of shells) if (!out.has(p.pid) && out.has(p.ppid)) { out.add(p.pid); grew = true; } }
  return shells.filter(p => out.has(p.pid)).map(p => p.pid);
}

/** Stop every orphaned headless shell; resolves with their pids ([] when the listing failed: a sweep never stops a command) */
export function reapOrphanBrowsers() {
  // timeout: a hung WMI must not hold a finished command open for long
  return new Promise(done => execFile(LIST_PROCESSES[0], LIST_PROCESSES[1], { windowsHide: true, maxBuffer: 1 << 24, timeout: 10000 }, (err, out) => {
    const pids = err ? [] : orphanPids(out);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    done(pids);
  }));
}
