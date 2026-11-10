// threedog play --stop: "stopped" is only reported once the process is really gone; a kill that failed keeps the records and says what to do next.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { endProcesses, stopServer } from '../threedog/play.mjs';

export const name = 'play --stop: a process that survives the kill is reported, not called stopped';

export async function run({ check }) {
  const dead = new Set();
  const kills = [];
  const left1 = await endProcesses([11, 12], { kill: p => { kills.push(p); dead.add(p); }, alive: p => !dead.has(p), tries: 2 });
  check('every killed process gone: nothing left', left1.length === 0 && kills.join() === '11,12', JSON.stringify(left1));
  const left2 = await endProcesses([21, 22], { kill: p => { if (p === 21) dead.add(p); }, alive: p => !dead.has(p), tries: 2 });
  // play's process killed by hand, nothing answering: success, both records gone
  const dir = mkdtempSync(join(tmpdir(), 'td-stop-'));
  try {
    mkdirSync(join(dir, '.threedog'), { recursive: true });
    writeFileSync(join(dir, '.threedog', 'play.json'), JSON.stringify({ pid: 2 ** 22 + 1 }));
    writeFileSync(join(dir, '.threedog', 'dev.json'), JSON.stringify({ pid: 2 ** 22 + 2, port: 1 }));
    const r = await stopServer(dir);
    check('a hand-killed server: stop reports success and clears both records', r.ok && !existsSync(join(dir, '.threedog', 'play.json')) && !existsSync(join(dir, '.threedog', 'dev.json')), r.text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  check('a process that survives the kill is returned (the caller keeps the records)', left2.join() === '22', JSON.stringify(left2));
}
