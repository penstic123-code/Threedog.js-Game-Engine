// The starter pictures in packages/starter-pictures: what each promises, checked offline. Why a test: each promise can break with no visible sign.
// A pull that loses a file only fails in a game; a texture loader brings a licence question back; a line in the engine or template means a game that skips the
// kit pays for it, and the trial's "without" arm is no longer without it. Pictures are judged by screenshots, not here.
// 不许绕开: the pull runs through the real lib code into a real folder, and the scans read every file, so a new file cannot skip them.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as tsl from 'three/tsl';
import { listEntries, pullEntry } from '../lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIB = join(REPO, 'packages', 'starter-pictures');
/** Every entry takes every check; tag is one style tag it must carry. A new entry goes here, so it cannot skip them */
const ENTRIES = [{ name: 'bright-cartoon', tag: 'cartoon' }, { name: 'ascii-meadow', tag: 'ascii' }];
/** The folders a game gets from installing threedog or running new-game: the kit must be named in none of them */
const SHIPPED = ['packages/engine/core', 'packages/engine/modules', 'packages/engine/render', 'packages/engine/docs', 'packages/tools/templates'];
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);

export const name = 'starter kit: each entry pulls whole into a game over the gray starter, loads nothing from outside, uses only real TSL names, its notes name every file, and nothing shipped names it; ascii-meadow keeps its character layer in its own file behind engine.post';

export async function run({ check }) {
  // a folder here that is not in the list would skip every check, and a second take of an entry would sit beside the one that was chosen
  const folders = readdirSync(LIB, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  check('the folder holds exactly the listed entries, one per look', folders.join() === ENTRIES.map(e => e.name).sort().join(), folders.join());
  for (const e of ENTRIES) await entryChecks(e, (label, ...rest) => check(`${e.name}: ${label}`, ...rest));

  const text = readFileSync(join(LIB, 'ascii-meadow', 'ascii.js'), 'utf8'), head = text.slice(0, text.indexOf('function makeAtlas'));
  check('ascii-meadow: the layer goes in through engine.post.add, in the final slot', /engine\.post\.add\(/.test(text) && /slot: 'final'/.test(text));
  check('ascii-meadow: on, cell, glyphs and background are one value each at the top of the file', ['on', 'cell', 'glyphs', 'background'].every(k => new RegExp(`^ +${k}: `, 'm').test(head)));
  check('ascii-meadow: the glyph atlas is released through ctx.display.own() (a dispose() on the effect definition is never called)', /ctx\.display\.own\(\{ dispose\(\) \{ mine\.map\.dispose\(\)/.test(text) && !/^    dispose\(\)/m.test(text));
  check('ascii-meadow: the cell is CSS pixels, scaled by the pixel ratio', /ASCII\.cell \* engine\.renderer\.getPixelRatio\(\)/.test(text));
  // measured on real WebGPU: at 4 CSS pixels and below a glyph is a dot, so a smaller default would keep the name and lose the characters
  check('ascii-meadow: the default cell is at least 5 CSS pixels', Number(/^ +cell: (\d+)/m.exec(head)?.[1]) >= 5);
  // the two promises a screenshot hides: a ramp typed in by guess looks almost right, and a wrong mix only shows as a slowly darker picture
  check('ascii-meadow: the ramp is sorted by ink measured on the canvas, not typed in order', /getImageData/.test(text) && /\.sort\(\(a, b\) => a\.ink - b\.ink\)/.test(text) && /CanvasTexture/.test(text));
  check('ascii-meadow: ink and background are solved from the measured coverage, so the cell mean holds', /cover\.oneMinus\(\)\.mul\(strength\)\.add\(1\)/.test(text) && /cover\.mul\(strength\)\.oneMinus\(\)/.test(text));
}

/** @param {{ name: string, tag: string }} e @param {(label: string, ok: any, detail?: string) => void} check */
async function entryChecks({ name: NAME, tag }, check) {
  const ENTRY = join(LIB, NAME);
  if (!existsSync(ENTRY)) { check('the entry is in packages/starter-pictures', false); return; }
  const code = readdirSync(ENTRY).filter(f => f.endsWith('.js')), text = Object.fromEntries(code.map(f => [f, readFileSync(join(ENTRY, f), 'utf8')]));
  const body = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  const entry = listEntries(LIB).find(e => e.name === NAME);
  check('lib list finds it as a picture entry for WebGPU with style tags and a preview', entry?.kind === 'picture' && entry.backends.join() === 'webgpu' && entry.style?.tags.includes(tag) && existsSync(join(ENTRY, 'preview.png')), JSON.stringify(entry?.backends));

  const tmp = mkdtempSync(join(tmpdir(), 'threedog-kit-'));
  try {
    const game = join(tmp, 'game');
    mkdirSync(join(game, 'picture'), { recursive: true });
    writeFileSync(join(game, 'package.json'), '{"name":"game"}');
    writeFileSync(join(game, 'picture', 'index.js'), '// the gray starter\n');

    const refused = await pullEntry(NAME, { game, lib: LIB });
    check('a game with its own picture/index.js is not overwritten without --force', refused.conflicts.length === 1 && readFileSync(join(game, 'picture', 'index.js'), 'utf8').startsWith('// the gray'), JSON.stringify(refused.conflicts));
    await pullEntry(NAME, { game, lib: LIB, force: true });
    check('--force lands every code file in picture/, unchanged', code.every(f => readFileSync(join(game, 'picture', f), 'utf8') === text[f]), code.join());

    const lost = code.flatMap(f => [...text[f].matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]).filter(i => !existsSync(join(game, 'picture', i))).map(i => `${f} -> ${i}`));
    check('every relative import of the pulled files resolves in the game', lost.length === 0, lost.join('; '));
    await pullEntry(NAME, { game, lib: LIB, to: 'picture/starter' });
    check('--to a subfolder keeps a game\'s own picture/ and the imports still resolve', code.every(f => existsSync(join(game, 'picture', 'starter', f))));
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  const outside = code.filter(f => /Loader\b|fetch\(|https?:|\.(png|jpe?g|webp|glb|gltf|hdr|ktx2)\b/i.test(body(text[f])));
  check('all made in code: no loader, no URL, no image or model file named', outside.length === 0, outside.join());
  const fromEngine = code.filter(f => /from\s+['"]threedog\/(?!tsl['"])|from\s+['"]\.\.\//.test(text[f]));
  check('it reaches only the public entries and its own folder', fromEngine.length === 0, fromEngine.join());

  const badTsl = code.flatMap(f => [...text[f].matchAll(/import\s*\{([^}]*)\}\s*from\s*'three\/tsl'/g)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(n => n && !(n in tsl))).map(n => `${f}: ${n}`));
  check('every name imported from three/tsl exists in the installed three', badTsl.length === 0, badTsl.join('; '));

  const notes = text['index.js'].split(/^import /m)[0];
  const unnamed = code.filter(f => f !== 'index.js' && !notes.includes(f));
  check('the notes at the top of index.js name every file', unnamed.length === 0, unnamed.join());
  check('the notes push toward changing it: the numbered steps start at the palette and the mark', /1\..*palette\.js/.test(notes) && /2\..*paint\.js/.test(notes) && /meant to be changed/.test(notes));

  const named = SHIPPED.flatMap(d => walk(join(REPO, d))).filter(f => statSync(f).size < 2e6 && /\.(m?js|ts|md|json|html)$/.test(f) && new RegExp(`${NAME}|starter-kit`).test(readFileSync(f, 'utf8')));
  check('nothing shipped names it: a game that skips it pays nothing, and no new game finds it by default', named.length === 0, named.join());
}
