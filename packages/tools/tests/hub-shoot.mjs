// Shooting a project for the hub wall: real render, one tiny scene-only game, one build and one browser for all points.
// Real headless render: keep it to one item; the bad point and the broken file prove the failure paths without more browsers.
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, TOOLS } from '../paths.mjs';
import { shootProject } from '../hub/shoot.mjs';

export const name = 'hub-shoot: all points of shots.json shot with one build, a bad point fails alone with a reason, a broken shots.json keeps the old pictures';

export async function run({ check }) {
  // the game sits inside this repository (under .threedog/) so its imports resolve to the workspace packages; init registers it under a temp home
  const home = mkdtempSync(join(tmpdir(), 'hub-shoot-home-')), game = join(ROOT, '.threedog', 'zz-hub-shoot');
  try {
    rmSync(game, { recursive: true, force: true });
    spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'init', game, '--scene-only'], { encoding: 'utf8', env: { ...process.env, THREEDOG_HOME: home } });
    writeFileSync(join(game, 'shots.json'), JSON.stringify([{ name: 'p1' }, { name: 'p2', time: '12:00', size: '480x270' }, { name: 'bad', at: 'nowhere' }]));
    const seen = [];
    const wall = await shootProject(game, { onPoint: (n, ok) => seen.push(`${n}:${ok}`) });
    check('two pictures written', ['p1', 'p2'].every(n => existsSync(wall.points[n]?.shots[0]?.file)), JSON.stringify(wall).slice(0, 400));
    check('a bad point fails alone with a reason', !!wall.points.bad?.error && !wall.points.bad.shots.length && !wall.error, JSON.stringify(wall.points.bad));
    check('onPoint reports each point', seen.join() === 'p1:true,p2:true,bad:false', seen.join());
    writeFileSync(join(game, 'shots.json'), '[{');
    const w2 = await shootProject(game);
    check('broken shots.json → project error, old pictures kept', !!w2.error && w2.points.p1.shots.length === 1 && existsSync(w2.points.p1.shots[0].file), JSON.stringify(w2).slice(0, 300));
    check('THREEDOG_TEST is not left set', process.env.THREEDOG_TEST === undefined || process.env.THREEDOG_TEST === '1');
  } finally {
    rmSync(game, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
