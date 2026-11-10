// Grass-scale shadows in content validation, no browser: a throwaway game folder goes through checkGame.
// The guard: a vegetation species that declares itself grass-scale (nearOnly, or maxRing 1) and casts shadows by the engine default gets one hint
// with what to do, from the engine's own predicate (grassShadowHint in modules/vegetation/Vegetation.js, which define() warns with in dev); a species
// that chose (castShadow written out, true or false, or shadowRing) stays quiet the same way for nearOnly and maxRing 1, and so do trees.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkGame } from '../content-check.mjs';
import { abs, VEGETATION_REL } from '../paths.mjs';

export const name = 'content-check: grass-scale vegetation that casts shadows gets a hint';

const rule = '{ perChunk: 800 }';
const VEG = `export default {
  meadowGrass: { model: 'grass', nearOnly: true, castShadow: true, rule: ${rule} },
  clover: { model: 'grass', maxRing: 1, rule: ${rule} },
  quietGrass: { model: 'grass', nearOnly: true, rule: ${rule} },
  ringGrass: { model: 'grass', nearOnly: true, castShadow: true, shadowRing: 0, rule: ${rule} },
  bigShrub: { model: 'shrub', maxRing: 1, castShadow: true, rule: ${rule} },
  pine: { model: 'pine', rule: { perChunk: 130 } },
};\n`;

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'threedog-grass-'));
  try {
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'main.js'), '\n');
    writeFileSync(join(dir, 'content/vegetation.js'), VEG);
    const { errors, warnings } = await checkGame(dir);
    const hint = n => warnings.find(w => w.includes(`vegetation ${n} is grass-scale`));
    check('a hint, never an error', !errors.some(e => /grass-scale/.test(e)), errors.join(' | '));
    check('maxRing 1 casting by the engine default is hinted, with what to do', /castShadow: false.*shadowRing: 0/.test(hint('clover') ?? ''), warnings.join(' | '));
    const { grassShadowHint } = await import(pathToFileURL(abs(VEGETATION_REL)).href);
    check('the hint is the engine predicate, word for word', hint('clover')?.endsWith(grassShadowHint('clover', { maxRing: 1 })), String(hint('clover')));
    for (const n of ['meadowGrass', 'quietGrass', 'ringGrass', 'bigShrub', 'pine']) check(`${n} stays quiet (no shadow, or the game chose)`, !hint(n), String(hint(n)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
