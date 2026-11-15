// Project registry of the hub: the list of games on this machine, kept in THREEDOG_HOME (a temp folder here, never the real home).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TOOLS } from '../paths.mjs';
import { listProjects, addProject, removeProject } from '../hub/registry.mjs';

export const name = 'hub-registry: two same-named folders stay distinct, only threedog projects are added, a deleted folder is listed as missing, init registers the game';

export async function run({ check }) {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-registry-')), env = { THREEDOG_HOME: join(tmp, 'home') };
  try {
    const game = p => { mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'farm', dependencies: { threedog: '^1.3.0' } })); return p; };
    const farmA = game(join(tmp, 'a', 'farm')), farmB = game(join(tmp, 'b', 'farm')), plain = join(tmp, 'plain');
    mkdirSync(plain); writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain', dependencies: { react: '1' } }));
    const a = addProject(farmA, env), b = addProject(farmB, env), bad = addProject(plain, env);
    const ids = new Set([a.id, b.id]);
    check('two same-named folders get distinct ids', ids.size === 2 && listProjects(env).length === 2);
    check('folder without threedog refused with reason', !bad.ok && /threedog/.test(bad.reason));
    check('a folder with no package.json is refused', !addProject(join(tmp, 'nothing'), env).ok);
    addProject(farmA, env);
    check('adding twice does not duplicate', listProjects(env).length === 2);
    rmSync(farmA, { recursive: true });
    check('deleted folder listed as not existing', listProjects(env).find(p => p.dir === farmA).exists === false);
    check('remove', removeProject(a.id, env) && listProjects(env).length === 1 && !removeProject(a.id, env));
    writeFileSync(join(tmp, 'home', 'projects.json'), '{broken');
    check('a broken registry file reads as empty', listProjects(env).length === 0);

    const initDir = join(tmp, 'newgame');
    spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'init', initDir], { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } });
    check('threedog init registers the new game', listProjects(env).some(p => p.dir === initDir));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
