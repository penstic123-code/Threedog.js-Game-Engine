// api-count reads every group (a group read as 0 means the reader broke), and the API lock (rules/R55-api-lock.mjs) tells removed, changed and new
// names apart and finds the migration notes. The lock itself runs in `threedog check`; this tests its pieces offline. Reads the type declarations and sources only.
import { apiCount, GROUPS, surfaceLines } from '../api-count.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from '../paths.mjs';
import { parse, diff, unreleased, breaks, marked } from '../rules/R55-api-lock.mjs';

export const name = 'api count: every group has items; the API lock tells removed, changed and new names apart';

export async function run({ check }) {
  const r = await apiCount();
  check('every group has items (a group read as 0 means the reader broke, not that the API shrank)', GROUPS.every(g => r.groups[g].total > 0), GROUPS.map(g => `${g} ${r.groups[g].total}`).join(' · '));

  // what the counter reads: only real values are exports, and a factory returning a tuple or an array of modules has options and APIs like one returning a single module
  const lines = await surfaceLines(), has = (g, n) => lines.some(l => l.startsWith(`${g} | ${n} |`));
  check('a class declared only as a type is not an exported value', !has('exports threedog', 'Sky') && !has('exports threedog', 'Weather') && has('exports threedog', 'Engine'));
  check('tuple and array factories count their options and every API', ['weather.rain', 'terrain.viewChunks', 'openWorld.seed'].every(n => has('module options', n)) && ['weather.set', 'terrainDraw.recolor'].every(n => has('module APIs', n)));

  const base = parse(['# c', 'g | a | () => void', 'g | b | number', 'g | c | string']);
  const now = parse(['g | a | (x: number) => void', 'g | b | number', 'g | d |']);
  const d = diff(base, now);
  check('lock: a signature change is "changed"', d.changed.join() === 'g | a', JSON.stringify(d));
  check('lock: a missing name is "removed"', d.removed.join() === 'g | c', JSON.stringify(d));
  check('lock: a new name is "added" (it needs only the snapshot)', d.added.join() === 'g | d', JSON.stringify(d));

  // [guard] @experimental is one form with three readers: the tag on the declaration, the lock line, the rule. Names from the freeze list's unstable rows:
  // a tag lost in a refactor would silently turn a name that follows Rapier or Recast into a 1.0 promise
  const open = new Set(r.experimental.map(k => k.split(' | ')[1]));
  const must = ['rigid.rapier', 'rigid.world', 'rigid.playerBody', 'rigid.playerCollider', 'nav.navMesh', 'nav.query', 'nav.tileCache', 'nav.helper', 'assets.gltf', 'assets.draco', 'assets.ktx2',
    'post.object', 'post.targets', 'shadows.csm', 'wind', 'voxelGI', 'temporalAA', 'sunShafts', 'lightVolumes', 'threads', 'grids', 'hlod', 'swarm', 'stream.source', 'stream.teleport',
    'stream.addReadyCheck', 'stream.sources', 'post.own', 'post.antialias', 'terrain.edit', 'terrainDraw', 'vegetationDraw', 'weatherDraw', 'bakeProbes', 'loadProbes',
    'loadLightmap', 'moduleOrder', 'player.saveMotion', 'player.loadMotion', 'jobs.loadingMs', 'jobs.maxSteps', 'jobs.slowStepMs', 'stream.unloadFactor',
    'batching.held', 'world.steps', 'level.heightfield'];
  check('[guard] every name of the unstable rows is marked', must.every(n => open.has(n)), must.filter(n => !open.has(n)).join(', '));
  check('a tag on a module covers its API (grids.add)', open.has('grids.add'));
  check('a tag on an engine member covers its sub-objects (threads.lane)', open.has('threads.lane'));
  const commands = readFileSync(join(ENGINE, 'docs/COMMANDS.md'), 'utf8');
  check('[guard] sub-commands have no lock line: the docs mark them', ['content stamp', 'content capture'].every(c => new RegExp(`threedog ${c} [^\\n]*\\| \\(experimental\\)`).test(commands)));

  const m = parse(['g | gone | x @experimental', 'g | moved | () => void @experimental', 'g | bare | @experimental', 'g | stable | number', 'g | keep | number', 'g | kept | number @experimental']);
  check('lock: the mark is read with or without a signature', marked(m.get('g | gone')) && marked(m.get('g | bare')) && !marked(m.get('g | stable')));
  const b = breaks(m, parse(['g | moved | (x: number) => void @experimental', 'g | bare | @experimental', 'g | keep | number @experimental', 'g | kept | number']));
  check('[guard] lock: a marked name may go or change with no note', !b.removed.includes('g | gone') && !b.changed.includes('g | moved'), JSON.stringify(b));
  check('[guard] lock: a stable name stays a break', b.removed.join() === 'g | stable', JSON.stringify(b));
  check('[guard] lock: marking a stable name needs a note, and is not read as a retype', b.marked.join() === 'g | keep' && !b.changed.length, JSON.stringify(b));

  const log = '# Changelog\n\n## Unreleased\n\n- `c` is gone.\n\n## 0.7.1 (x)\n\n- `old` was here.\n';
  check('lock: notes are the text under "## Unreleased" only', unreleased(log).includes('`c`') && !unreleased(log).includes('old'), unreleased(log));
  check('lock: no Unreleased heading means no notes', unreleased('## 0.7.1\n- x\n') === '');
  // [guard] the ground provider contract stays documented (api/ground.md) while the engine.ground samplers stay out of the lock
  const surface = await surfaceLines(), gdoc = readFileSync(join(ENGINE, 'docs/api/ground.md'), 'utf8');
  check('[guard] api/ground.md shows what a provider supplies (height, slope, type), the lock does not list engine.ground.height', ['ground.height(', 'ground.slope(', 'ground.type('].every(n => gdoc.includes(n)) && !surface.some(l => l.startsWith('engine sub-objects | ground.height |')));
}
