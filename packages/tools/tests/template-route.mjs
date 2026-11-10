// Which renderer a new game starts on: WebGPU and TSL by default, WebGL and GLSL with --webgl, for the blank and the open-world template alike.
// Why here: main.js is assembled from placeholders and an overlay, so a word left unfilled or a GLSL line in a TSL game would only show when someone builds that game.
// Offline: writes the four combinations into a temp folder and reads them.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTemplates, parseArgs } from '../lib/scaffold.mjs';
import { TOOLS } from '../paths.mjs';

export const name = 'template route: new games start on WebGPU with TSL, --webgl on WebGL with GLSL; no placeholder survives';

const textFiles = dir => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(e => e.isFile()).map(e => join(e.parentPath, e.name));

export async function run({ check }) {
  check('no flag: WebGPU', parseArgs(['g'], {}).webgl === false);
  check('--webgl chooses WebGL', parseArgs(['g', '--webgl'], {}).webgl === true);
  check('npm swallowing --webgl still counts', parseArgs(['g'], { npm_config_webgl: 'true' }).webgl === true);

  const tmp = mkdtempSync(join(tmpdir(), 'threedog-route-'));
  try {
    for (const openWorld of [false, true]) for (const webgl of [false, true]) {
      const label = `${openWorld ? 'open world' : 'blank'} ${webgl ? '--webgl' : 'default'}`;
      const dir = join(tmp, `${openWorld}-${webgl}`);
      copyTemplates(dir, { name: 'routecheck', openWorld, webgl });
      const left = textFiles(dir).filter(f => /__[A-Z_]+__/.test(readFileSync(f, 'utf8')));
      check(`${label}: every placeholder filled`, left.length === 0, left.join(', '));
      const main = readFileSync(join(dir, 'main.js'), 'utf8'), materials = readFileSync(join(dir, 'picture', 'materials.js'), 'utf8');
      const imports = main.split('\n').filter(l => l.startsWith('import '));
      const notes = readFileSync(join(dir, 'CLAUDE.md'), 'utf8') + readFileSync(join(dir, 'DESIGN.md'), 'utf8');
      if (webgl) {
        check(`${label}: main.js asks for no renderer and no TSL`, !/threedog\/tsl|renderer:/.test(main), imports[0]);
        check(`${label}: plain materials`, /new THREE\.MeshStandardMaterial/.test(materials) && !/three\/webgpu/.test(materials));
        check(`${label}: the notes name GLSL`, /onBeforeCompile/.test(notes) && /engine\.post\.add\(\{ name, slot, create \}\)/.test(notes));
      } else {
        // first import, because recipe 56 and the engine need its classes registered before createEngine runs
        check(`${label}: threedog/tsl is the first import`, imports[0].startsWith("import 'threedog/tsl';"), imports[0]);
        check(`${label}: main.js asks for WebGPU`, /createEngine\(\{ renderer: 'webgpu', /.test(main));
        check(`${label}: node materials`, /new MeshStandardNodeMaterial/.test(materials) && /three\/webgpu/.test(materials));
        check(`${label}: the notes name TSL and where to read the backend`, /describe\(\)\.renderer/.test(notes) && /slot, node \}/.test(notes) && !/\bslot, create \}/.test(notes));
      }
    }
    // --pixel: the third starting point (templates/pixel). One overlay at a time; it wires the engine's own pieces and keeps the start screen, autosave and the module hint
    check('--pixel is read, and not together with --open-world', parseArgs(['g', '--pixel'], {}).pixel === true && !!parseArgs(['g', '--pixel', '--open-world'], {}).error);
    for (const webgl of [false, true]) {
      const dir = join(tmp, `pixel-${webgl}`);
      copyTemplates(dir, { name: 'pixelcheck', pixel: true, webgl });
      const left = textFiles(dir).filter(f => /__[A-Z_]+__/.test(readFileSync(f, 'utf8')));
      const main = readFileSync(join(dir, 'main.js'), 'utf8');
      check(`pixel ${webgl ? '--webgl' : 'default'}: every placeholder filled`, left.length === 0, left.join(', '));
      check(`pixel ${webgl ? '--webgl' : 'default'}: engine path (pixelSize, pixelSnap, pixelSprite, input, interactions, dialogue, saves, start screen)`,
        ['pixelSize: 3', 'pixelSnap', 'pixelSprite', 'presets.bindings', 'interactions(', 'dialogue(', 'saves.autosave', 'ui: {'].every(w => main.includes(w)));
      check(`pixel ${webgl ? '--webgl' : 'default'}: the notes say it is a pixel start`, /--pixel/.test(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')));
    }
    const tpl = f => readFileSync(join(TOOLS, 'templates/game', f), 'utf8');
    // [guard] a project-local install (the README's) puts no threedog on the PATH: every command the entry names runs as npx threedog, one form
    const bare = [...tpl('CLAUDE.md').matchAll(/`(?!npx )(threedog [a-z]|npm run )[^`]*`/g)].map(m => m[0]);
    check('[guard] the entry names every command as npx threedog (none bare, no npm run)', !bare.length, bare.join(' '));
    check('[guard] the game\'s own notes name threedog play, and STATUS.md does not contradict "build it, no confirmation round"',
      tpl('CLAUDE.md').includes('`npx threedog play`') && !/three minimal versions/i.test(tpl('STATUS.md')) && /build it, no confirmation round/.test(tpl('CLAUDE.md')));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
