// The screenshot wall of one project: <project>/.threedog/wall/ holds the pictures and index.json, the manifest the hub page reads.
// Why the newest N per point: the wall is a history to see what a change did, not an archive; older pictures are deleted so it never grows.
// Why a failed point keeps its old pictures: an AI half-way through an edit breaks a point for a minute; the last good picture is still the useful one.
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { writeAtomic } from '../lib/atomic.mjs';
import { pointFile } from './points.mjs';

export const wallDir = dir => join(dir, '.threedog', 'wall');
const emptyWall = () => ({ runAt: null, error: null, points: {} });

/** @returns {{ runAt: number|null, error: string|null, points: Record<string, { shots: { file: string, at: number }[], error: string|null }> }} files are absolute, newest first */
export function readWall(dir) {
  try {
    const m = JSON.parse(readFileSync(join(wallDir(dir), 'index.json'), 'utf8')), points = {};
    for (const [name, p] of Object.entries(m.points ?? {})) points[name] = { error: p.error ?? null, shots: (p.shots ?? []).map(s => ({ file: join(wallDir(dir), s.file), at: s.at })) };
    return { runAt: m.runAt ?? null, error: m.error ?? null, points };
  } catch { return emptyWall(); }   // missing or half-written manifest: an empty wall, the next run rebuilds it
}

export const newShotPath = (dir, name, at) => join(wallDir(dir), `${pointFile(name)}-${at}.png`);

/**
 * Store one run. results: one entry per point shot ({ file } on success, { error } on failure). A project-level error (shots.json broken, build failed)
 * comes with no results and keeps every point as it was.
 * @returns the wall as now stored
 */
export function recordRun(dir, { at, error = null, results = [], keep = 10 }) {
  const wall = readWall(dir), gone = f => rmSync(f, { force: true });
  if (!error) for (const name of Object.keys(wall.points)) if (!results.some(r => r.name === name)) { wall.points[name].shots.forEach(s => gone(s.file)); delete wall.points[name]; }
  for (const r of results) {
    const p = wall.points[r.name] ??= { shots: [], error: null };
    if (r.file) { p.shots.unshift({ file: r.file, at }); p.error = null; } else p.error = r.error ?? 'failed';
    p.shots.splice(keep).forEach(s => gone(s.file));
  }
  Object.assign(wall, { runAt: at, error });
  mkdirSync(wallDir(dir), { recursive: true });
  const slim = { runAt: wall.runAt, error: wall.error, points: Object.fromEntries(Object.entries(wall.points).map(([n, p]) => [n, { error: p.error, shots: p.shots.map(s => ({ file: basename(s.file), at: s.at })) }])) };
  writeAtomic(join(wallDir(dir), 'index.json'), JSON.stringify(slim, null, 1) + '\n');
  return wall;
}
