// Re-shoot scheduling of the hub: a file change starts a quiet-period timer, and shooting jobs run strictly one at a time across all projects.
// Why one at a time: every job is a build plus a headless browser; two at once on a laptop made the machine stall.
// Why "run once more" for a change during a run: the picture being taken is already stale, but ten saves during it must not become ten runs.
import { watch, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORED = new Set(['node_modules', '.threedog', 'dist', '.git']);

/**
 * @param {{ shoot: (id: string) => Promise<void>, delay?: number, timers?: { setTimeout: Function, clearTimeout: Function } }} o
 *   timers: injectable so tests advance time by hand
 */
export function createQueue({ shoot, delay = 30000, timers = { setTimeout, clearTimeout } }) {
  const waiting = [], again = new Set(), timer = new Map();
  let running = null, stopped = false;

  function enqueue(id) {
    if (stopped) return;
    if (id === running) again.add(id);   // being shot now: exactly one more run after it
    else if (!waiting.includes(id)) waiting.push(id);
    pump();
  }
  function pump() {
    if (running || stopped || !waiting.length) return;
    const id = running = waiting.shift();
    // the shooter records its own errors on the wall; a rejection here must not stop the queue
    Promise.resolve().then(() => shoot(id)).catch(() => {}).finally(() => {
      running = null;
      if (again.delete(id) && !waiting.includes(id)) waiting.push(id);
      pump();
    });
  }
  const clear = id => { if (timer.has(id)) { timers.clearTimeout(timer.get(id)); timer.delete(id); } };

  return {
    touch(id) { clear(id); timer.set(id, timers.setTimeout(() => { timer.delete(id); enqueue(id); }, delay)); },
    now(id) { clear(id); enqueue(id); },
    busy: () => running,
    pending: () => [...waiting],
    stop() { stopped = true; waiting.length = 0; again.clear(); [...timer.keys()].forEach(clear); },
  };
}

const ignored = rel => IGNORED.has(String(rel).split(/[\\/]/)[0]);

/**
 * Call onChange when a file of the project changes (outside node_modules, .threedog, dist, .git). Returns close.
 * Why errors are swallowed: the folder can be deleted or moved while the hub runs; the card then says "not found", the server stays up.
 */
export function watchProject(dir, onChange, onError = () => {}) {
  let w;
  try {
    w = watch(dir, { recursive: true }, (_event, file) => { if (file && !ignored(file)) onChange(); });
    w.on('error', () => { try { w.close(); } catch { /* already closed */ } onError(); });
  } catch { return () => {}; }
  return () => { try { w.close(); } catch { /* already closed */ } };
}

/** Newest mtime (ms) of any file outside the ignored folders: has the project changed since the last run? 0 when there is none or the folder is gone */
export function newestChange(dir) {
  let newest = 0;
  const walk = d => {
    let list; try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (IGNORED.has(e.name) && d === dir) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* removed meanwhile */ } }
    }
  };
  walk(dir);
  return newest;
}
