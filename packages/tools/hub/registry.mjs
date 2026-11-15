// The list of threedog projects on this machine (one JSON file in the user's home) that the hub shows as cards.
// Why a file of absolute paths and not a scan: games live anywhere (desktop, a repo, a temp folder); `threedog init` and "add folder" are the two ways in.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { writeAtomic } from '../lib/atomic.mjs';

export const registryPath = (env = process.env) => join(env.THREEDOG_HOME ?? join(homedir(), '.threedog'), 'projects.json');

/** Why lower-cased: Windows paths differ only by case between a typed path and the one a shell reports; two folders with one name still differ in the rest of the path */
export const projectId = dir => createHash('sha1').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 10);

function read(env) {
  try { const list = JSON.parse(readFileSync(registryPath(env), 'utf8')).projects; return Array.isArray(list) ? list.filter(p => typeof p === 'string') : []; }
  catch { return []; }   // no file yet, or one a person broke by hand: start from an empty list rather than refuse to start
}
function write(list, env) {
  const file = registryPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ projects: list }, null, 2) + '\n');
}
const readPkg = dir => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return null; } };

/** @returns {{ id: string, dir: string, name: string, exists: boolean }[]} */
export function listProjects(env = process.env) {
  return read(env).map(dir => ({ id: projectId(dir), dir, name: readPkg(dir)?.name || basename(dir), exists: existsSync(dir) }));
}

/** @returns {{ ok: true, id: string } | { ok: false, reason: string }} */
export function addProject(dir, env = process.env) {
  const abs = resolve(dir), pkg = readPkg(abs);
  if (!pkg) return { ok: false, reason: `${abs} has no package.json: it is not a threedog project` };
  if (!pkg.dependencies?.threedog && !pkg.devDependencies?.threedog) return { ok: false, reason: `${abs}: package.json does not list threedog in dependencies, so it is not a threedog project` };
  const id = projectId(abs), list = read(env);
  if (!list.some(p => projectId(p) === id)) write([...list, abs], env);
  return { ok: true, id };
}

/** Takes the card off the list; the folder itself is never touched */
export function removeProject(id, env = process.env) {
  const list = read(env), rest = list.filter(p => projectId(p) !== id);
  if (rest.length === list.length) return false;
  write(rest, env);
  return true;
}
