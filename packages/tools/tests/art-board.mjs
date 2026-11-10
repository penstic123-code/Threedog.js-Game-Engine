// threedog art board on a small game: each status comes from a real case, because the page is only worth anything if "unused" can be believed.
// Offline, temp folders only, no browser (the panel's list runs on stand-in objects, sent through text the way the bridge sends it).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TOOLS, ENGINE } from '../paths.mjs';
import { walk } from '../lib/text.mjs';
import { scanArt, BUILT_IN_SOUNDS } from '../art-board-scan.mjs';
import { noComments } from '../lib/text.mjs';
import { loadedArt } from '../panel/art.js';
import { recordPull } from '../lib/lib-records.mjs';

export const name = 'art board: used, unused, missing and not traced each come from a real case; a name built at run time is never called unused; --json is the page\'s data; --live merges what the game loaded; the tools read no style or look layer';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function run({ check }) {
  const tmp = mkdtempSync(join(tmpdir(), 'threedog-art-board-')), g = join(tmp, 'game'), lib = join(tmp, 'library');
  const put = (p, t) => { mkdirSync(dirname(join(g, p)), { recursive: true }); writeFileSync(join(g, p), t); };
  try {
    put('package.json', '{"name":"fixture"}');
    put('assets.js', `export default [{ name: 'g', models: { crate: '/models/crate.glb', spare: '/models/spare.glb', gone: '/models/gone.glb', rootonly: '/models/decoy.glb', tree_1: '/models/tree_1.glb', rock: () => null },
  textures: { bark: '/tex/bark.png' }, sounds: { door: '/sfx/door.ogg' } }];\n`);
    for (const f of ['models/crate.glb', 'models/spare.glb', 'models/tree_1.glb', 'sfx/door.ogg']) put('public/' + f, 'x'.repeat(10));
    for (const f of ['tex/bark.png', 'tex/orphan.png', 'decals/a.png']) put('public/' + f, PNG);
    put('models/decoy.glb', 'xx');   // in the game root, not in public/: the url '/models/decoy.glb' does not serve it
    put('content/props.js', `// spare is only in this comment\nexport default [\n  { id: 'a', model: 'crate' },\n  { id: 'b', model: 'barrel' },\n];\n`);
    put('main.js', `import { createMaterials } from './picture/materials.js';
import './picture/water.js';
const i = 1, d = 'a';
engine.assets.texture('bark');
engine.audio.sfx('door');
engine.assets.model(\`tree_\${i}\`);
engine.ui.say('rock');
fetch('/decals/' + d + '.png');
const m = createMaterials();
mesh.material = m.grass; other.material = materials.grass;
`);
    put('picture/materials.js', `import { THREE } from 'threedog';\nexport function createMaterials() {\n  return { grass: new THREE.MeshStandardMaterial({ color: 0x33aa44 }), dusty: new THREE.MeshBasicMaterial() };\n}\n`);
    put('picture/water.js', `import { THREE } from 'threedog';\nimport wave from './shaders/wave.glsl?raw';\nconst mat = new THREE.ShaderMaterial({ fragmentShader: wave });\nscene.add(new THREE.Mesh(g, mat));\nscene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff0000 })));\n`);
    put('picture/shaders/wave.glsl', 'void main() {}\n');
    put('game/fx.js', `import { THREE } from 'threedog';\nexport const audio = { sfx(n) { return n; } };\naudio.sfx('beep');\nconst m1 = new THREE.MeshBasicMaterial(), w1 = new THREE.Mesh(g, m1);\n`);
    put('picture/shaders/old.glsl', 'void main() {}\n');
    // a library entry this game pulled, noted in its pull records
    mkdirSync(join(lib, 'barkpack'), { recursive: true });
    writeFileSync(join(lib, 'barkpack', 'entry.json'), JSON.stringify({ name: 'barkpack', kind: 'texture', summary: 'bark', use: 'x', from: 'y' }));
    writeFileSync(join(lib, 'barkpack', 'bark.png'), PNG);
    recordPull(g, { name: 'barkpack', kind: 'texture', summary: 'bark', from: 'y', dir: join(lib, 'barkpack') }, [join(g, 'public', 'tex', 'bark.png')]);

    const data = await scanArt(g, { lib }), it = ref => data.items.find(x => x.ref === ref), st = ref => it(ref)?.status;
    check('a name in a model slot is used, with file:line', st('model crate') === 'used' && it('model crate').uses[0].at === 'content/props.js:3', JSON.stringify(it('model crate')));
    check('the copy line names kind, name, file and place', it('model crate').line === 'model crate (public/models/crate.glb), used in content/props.js:3', it('model crate')?.line);
    check('a name only in a comment is unused', st('model spare') === 'unused', st('model spare'));
    check('a file nobody names is unused', st('texture orphan') === 'unused', st('texture orphan'));
    check('a shader file nobody imports is unused, an imported one used', st('shader old') === 'unused' && st('shader wave') === 'used', `${st('shader old')} ${st('shader wave')}`);
    check('a manifest entry whose file is gone is missing', st('model gone') === 'missing', st('model gone'));
    check('[guard] a manifest url means public/<path> only (the one resolver): a same-named file in the game root does not make it exist', st('model rootonly') === 'missing', st('model rootonly'));
    check('a model name no pack has is missing, with where', st('model barrel') === 'missing' && it('model barrel').uses[0].at === 'content/props.js:4', JSON.stringify(it('model barrel')));
    check('a name built at run time: not traced, never unused', st('model tree_1') === 'not-traced', st('model tree_1'));
    check('a folder joined with a name: not traced', st('texture a') === 'not-traced', st('texture a'));
    check('the same text in another slot: not traced, it may mean something else', st('model rock') === 'not-traced', st('model rock'));
    check('a material read by key is used, an unread one unused', st('material grass') === 'used' && st('material dusty') === 'unused', `${st('material grass')} ${st('material dusty')}`);
    check('a material made in place is used and shows its color', it('material water-MeshBasicMaterial-1')?.status === 'used' && it('material water-MeshBasicMaterial-1').preview.value === '#ff0000', JSON.stringify(it('material water-MeshBasicMaterial-1')));
    check('a variable used on the line that declares it is used', st('material m1') === 'used', JSON.stringify(it('material m1')));
    check('the game\'s own sfx() says nothing about the asset list', !it('sound beep') && st('sound door') === 'used', JSON.stringify(it('sound beep')));
    check('a ShaderMaterial is listed with the shaders', st('shader mat') === 'used', st('shader mat'));
    check('a pulled file is marked from the pull records', st('library barkpack') === 'used' && it('texture bark').library === 'barkpack' && it('library barkpack').pulled === 'unchanged', JSON.stringify(it('library barkpack')));
    check('summary counts and lists', data.summary.counts.model === 8 && data.summary.missing.length === 3 && data.summary.unused.includes('model spare') && data.summary.notTraced.includes('model tree_1')
      && data.summary.biggest[0].size > 10, JSON.stringify(data.summary));
    check('the run-time list names the line', data.dynamic.some(d => d.at === 'main.js:6'), JSON.stringify(data.dynamic));

    // [guard] art/models/x.glb and its built public/optimized/x.glb are one resource, listed by the built file: code naming the source read as a file that is gone
    put('art/models/hull.glb', 'x'); put('public/optimized/hull.glb', 'x');
    put('game/hull.js', `export const hull = new URL('../art/models/hull.glb', import.meta.url);\n`);
    const built = await scanArt(g), hull = built.items.find(x => x.file === 'public/optimized/hull.glb');
    check('[guard] code naming the source of an optimized model uses that model, nothing is missing', hull?.status === 'used' && hull.source === 'art/models/hull.glb' && !built.summary.missing.some(r => /hull/.test(r)), JSON.stringify(built.summary.missing));

    // the honesty case: one run-time name of a kind and "unused" is no longer known for that kind
    appendFileSync(join(g, 'main.js'), 'const which = pick();\nengine.assets.model(which);\n');
    const open = await scanArt(g);
    check('a model loaded by a variable turns unused models into not traced', open.items.find(x => x.ref === 'model spare').status === 'not-traced', JSON.stringify(open.items.find(x => x.ref === 'model spare')));
    appendFileSync(join(g, 'main.js'), "const dir = pick();\nfetch(dir + which + '.png');\n");
    check('a folder held in a variable turns unused files of that type into not traced', (await scanArt(g)).items.find(x => x.ref === 'texture orphan').status === 'not-traced', 'stayed unused');

    // the running game's list, sent as text like the bridge does: it must use nothing outside itself
    const m1 = { name: 'hull', type: 'MeshStandardMaterial', userData: {}, map: { isTexture: true, name: '', source: { data: { src: 'http://localhost/tex/orphan.png' } } } };
    const engine = { assets: { entries: new Map([['tree_1', { name: 'tree_1', type: 'model', url: '/models/tree_1.glb', value: {} }], ['spare', { name: 'spare', type: 'model', url: '/models/spare.glb' }], ['wind', { name: 'wind', type: 'sound', url: 'wind', value: {}, builtIn: true }]]) },
      _tools: { standIn: () => false }, scene: { traverse: f => [{ material: m1 }, { material: { type: 'MeshBasicMaterial', userData: {} } }, {}].forEach(f) } };
    const live = (0, eval)(`(${loadedArt.toString()})`)(engine);
    check('the panel list reports loaded assets, named and unnamed materials, textures', live.assets.find(a => a.name === 'tree_1').loaded && !live.assets.find(a => a.name === 'spare').loaded
      && live.materials[0].name === 'hull' && live.unnamedMaterials === 1 && live.textures[0].slot === 'map', JSON.stringify(live));
    const merged = await scanArt(g, { live }), mt = ref => merged.items.find(x => x.ref === ref);
    check('loaded is proof: not traced becomes used', mt('model tree_1').status === 'used' && mt('model tree_1').loaded === true, JSON.stringify(mt('model tree_1')));
    check('not loaded proves nothing: it stays not traced', mt('model spare').status === 'not-traced', mt('model spare').status);
    check('a texture seen in the scene marks its file', mt('texture orphan').status === 'used', mt('texture orphan').status);
    check('a material only the game knows joins the list', mt('material hull')?.runtimeOnly === true && mt('material hull').status === 'used', JSON.stringify(mt('material hull')));

    // the command itself: --json is the same data, the page holds the same lines, and an unknown option fails
    const cli = (...a) => spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), 'art', 'board', ...a], { cwd: g, encoding: 'utf8' });
    const j = cli('--json', '--lib', lib);
    let parsed = null; try { parsed = JSON.parse(j.stdout); } catch { /* the check below reports it */ }
    check('--json prints the scan', j.status === 0 && parsed?.items.find(x => x.ref === 'model crate')?.status === 'used', j.stderr || j.stdout.slice(0, 200));
    const out = join(tmp, 'out', 'board.html'), p = cli('--out', out, '--lib', lib), html = existsSync(out) ? readFileSync(out, 'utf8') : '';
    check('the page is written where asked, the game folder is not touched', p.status === 0 && html.includes('model crate (public/models/crate.glb), used in content/props.js:3') && !existsSync(join(g, '.threedog', 'art-board')), p.stderr || p.stdout);
    check('the page reaches the pictures from where it was written', html.includes('../game/public/tex/bark.png'), html.slice(0, 200));
    check('a script end tag in the data cannot break the page', !/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/.test(html), 'more than one script end');
    check('an unknown option fails', cli('--nope').status === 1, 'exit 0');

    // the list of engine sounds follows the engine: a new built-in must not show up as "missing" in every game
    const names = new Set();
    for (const f of walk(join(ENGINE, 'modules'))) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/builtInSounds\([^,]+,\s*\{\s*(\w+):/g)) names.add(m[1]);
      if (/builtInSounds\([^,]+,\s*SYNTHS/.test(t)) for (const m of (/const SYNTHS = \{([\s\S]*?)\n\};/.exec(t)?.[1] ?? '').matchAll(/^ {2}(\w+)\s*[:(]/gm)) names.add(m[1]);
    }
    check('the built-in sound list matches the engine', names.size >= 4 && [...names].every(n => BUILT_IN_SOUNDS.includes(n)), `engine: ${[...names]}`);

    // cannot be bypassed: the board reads game files, assets.js, three.js objects and engine.assets, nothing of the appearance layer that is going away
    for (const f of ['art-board.mjs', 'art-board-scan.mjs', 'art-board-page.mjs', 'panel/art.js']) {
      const code = noComments(readFileSync(join(TOOLS, f), 'utf8'));
      check(`${f} reads no style / look layer`, !/makeMaterial|engine\.look|engine\.style|\.style\.\w+\s*\(|['"]style\//.test(code.replace(/\.style\b(?=[^.]*`)/g, '')), f);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
