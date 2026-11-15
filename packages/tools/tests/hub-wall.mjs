// Wall store of the hub: newest 10 pictures per point, a failed point keeps its old pictures, a broken manifest reads as an empty wall.
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWall, recordRun, newShotPath, wallDir } from '../hub/wall.mjs';

export const name = 'hub-wall: keeps the newest 10 pictures per point, a failed point keeps its old ones, project error keeps all, broken index reads empty';

export async function run({ check }) {
  const d = mkdtempSync(join(tmpdir(), 'hub-wall-'));
  try {
    mkdirSync(wallDir(d), { recursive: true });
    const files = [];
    for (let at = 1; at <= 12; at++) { const f = newShotPath(d, 'a', at); writeFileSync(f, 'x'); files.push(f); recordRun(d, { at, results: [{ name: 'a', file: f }] }); }
    const w = readWall(d);
    check('only the newest 10 are kept, newest first', w.points.a.shots.length === 10 && w.points.a.shots[0].at === 12 && w.points.a.shots[9].at === 3);
    check('the 2 oldest files are gone from disk', !existsSync(files[0]) && !existsSync(files[1]) && existsSync(files[2]));
    recordRun(d, { at: 13, results: [{ name: 'a', error: 'boom' }] });
    const w2 = readWall(d);
    check('a failed point keeps its 10 shots and records the reason', w2.points.a.shots.length === 10 && w2.points.a.error === 'boom' && w2.runAt === 13);
    recordRun(d, { at: 14, error: 'shots.json is not valid JSON', results: [] });
    const w3 = readWall(d);
    check('a project-level error is stored and every point is kept', w3.error === 'shots.json is not valid JSON' && w3.points.a.shots.length === 10 && existsSync(files[11]));
    const g = newShotPath(d, 'b', 15); writeFileSync(g, 'x');
    recordRun(d, { at: 15, results: [{ name: 'b', file: g }] });
    check('a point missing from a clean run is dropped with its files', !readWall(d).points.a && !existsSync(files[11]) && existsSync(g));
    writeFileSync(join(wallDir(d), 'index.json'), '{broken');
    const e = readWall(d);
    check('corrupt index.json → empty wall', e.runAt === null && Object.keys(e.points).length === 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
}
