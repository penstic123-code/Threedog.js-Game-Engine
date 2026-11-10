// Module boundaries, static half (browser halves: packages/engine/tests/specs/module-types.mjs, module-boundaries.mjs): core, render and ui name no concrete module
// (R27), and every engine module declares a type, with world modules drawing nothing (R47).
// Why a test as well as npm run check: check is run before committing, this runs with every test pass, so a change that makes core reach into a
// module (the review 0.4 E finding) fails the suite too. It also proves both rules still look at what they claim to: they find the module
// definitions and scan render/ and ui/, not only core/.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLS } from '../paths.mjs';

export const name = 'module boundaries: core / render / ui name no module (R27), every module declares a type and world modules draw nothing (R47), no module touches another module _fields (R25) or files (R46, any import form), calls on a contract-backed module are in its contract (R50)';

export async function run({ check }) {
  const load = async f => (await import(pathToFileURL(join(TOOLS, 'rules', f)).href)).default;
  for (const [file, what] of [['R27-core-names-modules.mjs', 'core / render / ui name no module'], ['R47-module-types.mjs', 'every module has a type; world modules draw nothing'], ['R25-private-reach.mjs', 'no module reaches into another module _fields'], ['R46-module-internals.mjs', 'no module imports another module files']]) {
    const rule = await load(file), out = rule.run(), errors = out.filter(x => x.level === 'error');
    check(`${rule.id}: ${what}`, errors.length === 0, errors.slice(0, 5).map(x => `${x.file}:${x.line} ${x.msg}`).join('; '));
    // the net pass removed its five R25 entries (ops._route, world._s, inventory._containers...): a new one would mean reaching back in
    if (rule.id === 'R25') check('R25 allowlist has no net entries (net uses ops.route / refused, world.pauseSimulation, inventory.contents / setContents)', !/^\s*\['net',/m.test((await import('node:fs')).readFileSync(join(TOOLS, 'rules', file), 'utf8')), file);
    if (rule.id === 'R27') check('R27 found the module names it checks for (definitions with type before label are read)', /module names: (\d+)/.exec(out.note)?.[1] > 25, out.note);
  }
  // R16 / R46 read imports the way they are written in any form: a roundabout path and a dynamic import() land in the other module too
  const { importSpecs, moduleTarget, P } = await import(pathToFileURL(join(TOOLS, 'rules', '_lib.mjs')).href);
  const from = `${P.MODULES_REL}/a/x.js`, lands = raw => importSpecs(raw).map(s => moduleTarget(from, s)?.path ?? null).join();
  check('R16 / R46 imports: ../../modules/nav/x.js, import(\'../nav/x.js\') and import \'../nav/x.js\' land in nav; ./y.js stays in a; ../../core is outside',
    lands(`import { q } from '../../modules/nav/x.js';`) === 'nav/x.js' && lands(`const m = await import('../nav/x.js');`) === 'nav/x.js'
    && lands(`import '../nav/x.js';`) === 'nav/x.js' && lands(`import { y } from './y.js';`) === 'a/y.js' && lands(`import { v } from '../../core/base/math.js';`) === '');
  // [guard] one owner scope: a built-in module registers through ctx, so its unload, rollback and failed init take it along. engine.net stays as it is (decision 2026-11-04)
  const { walk, read } = await import(pathToFileURL(join(TOOLS, 'rules', '_lib.mjs')).href);
  const raw = /\b(?:e|engine|eng|this\.e|this\.engine)\.(ops\.define|saves\.(?:define|register)|ui\.define|stream\.addReadyCheck|budget\.metric|addGroundColliders|setGround|explainWith|_things\.addSource)\(/;
  const bypass = walk(P.MODULES_REL).filter(f => !f.includes('/net/')).flatMap(f => read(f).split('\n').flatMap((l, i) =>
    raw.test(l) && !/^\s*(\/\/|\*|\+ ")/.test(l) && !/^\s*export const \w+ = "/.test(l) ? [`${f}:${i + 1}`] : []));
  check('built-in modules register ops, save parts, ui, ready checks, metrics, sources and ground through ctx, never straight on the engine', !bypass.length, bypass.slice(0, 8).join(' '));
  // R50: calls on a contract-backed module are in its contract (the inventory contract once missed contents / setContents / renameIds)
  const r50 = await load('R50-contract-calls.mjs'), o50 = await r50.run(), e50 = o50.filter(x => x.level === 'error');
  check('R50: every call on a contract-backed module (engine.inventory.contents()...) is in its contract', !e50.length, e50.slice(0, 5).map(x => `${x.file}:${x.line} ${x.msg}`).join('; '));
  // [guard] R50 follows what it says: the receivers of the [layer] contract finding were locals, one declared after another, one behind a function
  const { declared, handsBack } = await import(pathToFileURL(join(TOOLS, 'rules', 'R50-contract-calls.mjs')).href);
  const [one] = declared('const rec = w.get(id), live = w.engine.control?.characterOf(id);', String.raw`\bcharacterOf\([^()]*\)`).concat('none');
  check('[guard] R50: a second declarator holding a live character is a local of it, the first is not', one === 'live', one);
  check('[guard] R50: an argument is no alias', !declared('const near = closest(e.player, 3);', String.raw`\be\.player\b`).length);
  check('[guard] R50: a function that hands a character back is followed', handsBack('  _character(rec) { const ch = this.engine.control?.characterOf(rec.id); return ch; }').includes('_character'));
  // [guard] R68: the private names the tools used to call are still caught, and the door is not
  const { reaches } = await import(pathToFileURL(join(TOOLS, 'rules', 'R68-tool-door.mjs')).href);
  check('[guard] R67: a tool cannot reach past engine._tools', reaches('e._render(0); engine?._cpuMs; m.userData?._dbgOf').length === 3 && !reaches('e._tools.render(0)').length);
  // [guard] L9: a member one folder reads on another is on a public page, in a contract, or @internal: never a contract by habit
  const scan = spawnSync(process.execPath, [join(TOOLS, 'layer-scan.mjs'), '--check'], { encoding: 'utf8' });
  check('[guard] layer scan: every member read across folders is stated', scan.status === 0, (scan.stdout + scan.stderr).slice(0, 400));
  check('R50 read the contracts (inventory, particles, camera ... at least 9)', /^(\d+) contracts/.exec(o50.note)?.[1] >= 9, o50.note);
}
