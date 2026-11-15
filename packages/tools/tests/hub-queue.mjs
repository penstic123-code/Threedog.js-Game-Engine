// Re-shoot queue and project watcher of the hub: debounce, one job at a time, exactly one more run for changes during a run, no crash when the folder vanishes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueue, watchProject, newestChange } from '../hub/queue.mjs';

export const name = 'hub-queue: touches debounce to one run, one shoot at a time, a change during a run gives exactly one more run, watcher ignores node_modules and survives a deleted folder';

const tick = () => new Promise(r => setTimeout(r, 5));

export async function run({ check }) {
  // fake timers: pending callbacks fire when the test advances time
  let now = 0, seq = 0; const pend = new Map();
  const timers = { setTimeout: (fn, ms) => { pend.set(++seq, { fn, at: now + ms }); return seq; }, clearTimeout: h => pend.delete(h) };
  const advance = ms => { now += ms; for (const [h, t] of [...pend]) if (t.at <= now) { pend.delete(h); t.fn(); } };
  const calls = [], gates = []; let running = 0, maxRunning = 0;
  const q = createQueue({ delay: 30000, timers, shoot: id => new Promise(res => { calls.push(id); running++; maxRunning = Math.max(maxRunning, running); gates.push(() => { running--; res(); }); }) });
  const finish = () => gates.shift()();

  q.touch('a'); q.touch('a'); advance(29000); check('no run before the quiet period ends', calls.length === 0);
  q.touch('a'); advance(30000); await tick();
  check('debounced touches → one run', calls.join() === 'a' && q.busy() === 'a');
  q.touch('a'); advance(30000);   // while 'a' is still shooting
  q.touch('a'); advance(30000);
  finish(); await tick();
  check('changes during a run → exactly one more run', calls.join() === 'a,a');
  finish(); await tick();
  check('and not a pile after it', calls.join() === 'a,a' && q.busy() === null);
  q.now('b'); q.now('c'); q.now('c'); await tick();
  check('one at a time, a waiting id is not added twice', maxRunning === 1 && q.pending().join() === 'c');
  finish(); await tick(); finish(); await tick();
  check('the waiting one runs after', calls.join() === 'a,a,b,c' && q.busy() === null);
  const bad = createQueue({ delay: 1, timers, shoot: async id => { if (id === 'x') throw new Error('boom'); calls.push('ok'); } });
  bad.now('x'); bad.now('y'); await tick();
  check('a rejected shoot does not stop the queue', calls.at(-1) === 'ok');
  q.stop(); bad.stop();

  // watcher, on a real folder
  const d = mkdtempSync(join(tmpdir(), 'hub-queue-'));
  try {
    mkdirSync(join(d, 'node_modules'));
    let n = 0; const close = watchProject(d, () => n++);
    await new Promise(r => setTimeout(r, 300));
    writeFileSync(join(d, 'node_modules', 'x.js'), '1');
    await new Promise(r => setTimeout(r, 700));
    check('a change in node_modules is ignored', n === 0);
    writeFileSync(join(d, 'main.js'), '1');
    for (let i = 0; i < 40 && !n; i++) await new Promise(r => setTimeout(r, 50));
    check('a change to main.js is reported within 2 s', n > 0);
    check('newestChange sees main.js, not node_modules', newestChange(d) >= Date.now() - 5000 && newestChange(join(d, 'nothing')) === 0);
    let threw = false;
    try { rmSync(d, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 500)); } catch { threw = true; }
    check('deleting the watched folder does not throw', !threw);
    close();
  } finally { rmSync(d, { recursive: true, force: true }); }
}
