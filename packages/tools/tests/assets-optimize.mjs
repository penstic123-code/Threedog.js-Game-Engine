// assets optimize: a small real glTF (color + normal texture, real PNG pixels) goes through the real command in a temp game folder.
// Guards: originals unchanged byte for byte, output is KTX2 + Meshopt, the normal map is UASTC / linear and the color map ETC1S / sRGB, a rerun skips,
// --dry writes nothing, assets.js points at the result. Uses `ktx` (KTX-Software) when it is on PATH (or in THREEDOG_KTX_DIR), else the wasm
// encoder ktx2-encoder from npm.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from '../paths.mjs';
import { runOptimize } from '../assets-optimize.mjs';

export const name = 'assets optimize: KTX2 by slot, originals untouched, rerun skips, --dry, assets.js pointed (real glb)';

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const quiet = async fn => { const log = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return { code: await fn(), text: lines.join('\n') }; } finally { console.log = log; } };

/** The test model: a quad with a color map and a normal map (128 x 128 gradients, so they encode quickly) */
export async function makeModel(file) {
  const req = createRequire(resolve(ROOT, 'package.json')), core = req('@gltf-transform/core'), sharp = req('sharp');
  const raw = f => { const b = Buffer.alloc(128 * 128 * 3); for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) b.set(f(x, y), (y * 128 + x) * 3); return b; };
  const png = b => sharp(b, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const color = await png(raw((x, y) => [x * 2, y * 2, 120])), normal = await png(raw((x, y) => [128 + (x % 16) - 8, 128 + (y % 16) - 8, 255]));
  const doc = new core.Document(), buf = doc.createBuffer();
  const acc = (t, a) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf);
  const tex = (n, img) => doc.createTexture(n).setImage(new Uint8Array(img)).setMimeType('image/png');
  const mat = doc.createMaterial('plane_mat').setBaseColorTexture(tex('crate_albedo', color)).setNormalTexture(tex('crate_normal', normal));
  const prim = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))).setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3]))).setMaterial(mat);
  doc.createScene().addChild(doc.createNode('crate').setMesh(doc.createMesh('crate').addPrimitive(prim)));
  await new core.NodeIO().write(file, doc);
}

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'threedog-optimize-')), oldPath = process.env.PATH;
  if (process.env.THREEDOG_KTX_DIR) process.env.PATH = process.env.THREEDOG_KTX_DIR + delimiter + oldPath;
  try {
    mkdirSync(join(dir, 'art/models'), { recursive: true });
    const src = join(dir, 'art/models/crate.glb');
    await makeModel(src);
    writeFileSync(join(dir, 'assets.js'), '// a game\nexport default [];\n');
    const before = sha(src);

    // [guard] a failed model must leave the game as it was: assets.js once pointed at a file this run never made
    const bad = mkdtempSync(join(tmpdir(), 'threedog-optimize-bad-'));
    try {
      mkdirSync(join(bad, 'art/models'), { recursive: true });
      writeFileSync(join(bad, 'art/models/broken.glb'), 'not a model');
      writeFileSync(join(bad, 'assets.js'), '// a game\nexport default [];\n');
      const rb = await quiet(() => runOptimize(bad, {}));
      check('a failed model: exit 1, assets.js unchanged, no pack written, and it says so', rb.code === 1 && readFileSync(join(bad, 'assets.js'), 'utf8') === '// a game\nexport default [];\n'
        && !existsSync(join(bad, 'assets.optimized.js')) && /were not changed/.test(rb.text), rb.text);
    } finally { rmSync(bad, { recursive: true, force: true }); }
    // [guard] no texture, so no ktx needed: which URL a name finally resolves to, and what a cache hit still reports
    const plain = mkdtempSync(join(tmpdir(), 'threedog-optimize-plain-'));
    try {
      mkdirSync(join(plain, 'art/models'), { recursive: true });
      const core = createRequire(resolve(ROOT, 'package.json'))('@gltf-transform/core'), pd = new core.Document(), pb = pd.createBuffer();
      const pp = pd.createPrimitive().setAttribute('POSITION', pd.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0])).setBuffer(pb));
      pd.createScene().addChild(pd.createNode('tri').setMesh(pd.createMesh('tri').addPrimitive(pp)));
      await new core.NodeIO().write(join(plain, 'art/models/tri.glb'), pd);
      const ORIGINAL = 'export default [{ name: \'old\', models: { tri: \'/models/tri.glb\' } }];\n';
      writeFileSync(join(plain, 'assets.js'), ORIGINAL);
      let nImport = 0;
      // later packs win in engine.assets.manifest, so the last pack naming the model decides its URL
      const finalUrl = async () => { let url; for (const p of (await import(pathToFileURL(join(plain, 'assets.js')).href + '?v=' + (++nImport))).default) url = p.models?.tri ?? url; return { url }; };
      const p1 = await quiet(() => runOptimize(plain, {})), fu1 = await finalUrl();
      check('a name in an older pack resolves to the optimized copy', p1.code === 0 && /\/optimized\/tri\.glb$/.test(fu1.url), p1.text + JSON.stringify(fu1));
      // a game rewritten by the older command (`[...optimized, ` first) is moved over: the optimized pack comes last
      writeFileSync(join(plain, 'assets.js'), `import optimized from './assets.optimized.js';\n` + ORIGINAL.replace('export default [', 'export default [...optimized, '));
      await quiet(() => runOptimize(plain, {}));
      const fu2 = await finalUrl();
      check('a game in the old [...optimized, form is migrated and resolves to the optimized copy', /\/optimized\/tri\.glb$/.test(fu2.url) && !/\[\.\.\.optimized, /.test(readFileSync(join(plain, 'assets.js'), 'utf8')), JSON.stringify(fu2));
      // a { url, node } entry follows its file: the optimized pack re-points it (same node), and a node the file lacks is reported
      writeFileSync(join(plain, 'assets.js'), `export default [{ name: 'g', models: { part: { url: '/models/tri.glb', node: 'tri' }, bad: { url: '/models/tri.glb', node: 'nope' } } }];
`);
      const pr = await quiet(() => runOptimize(plain, { force: true })), pk = readFileSync(join(plain, 'assets.optimized.js'), 'utf8');
      check('a { url, node } entry is re-pointed to the optimized copy with its node, and a missing node is reported', /"part": \{\s*"url": "\/optimized\/tri\.glb",\s*"node": "tri"/.test(pk) && /model-needs.*"nope"/.test(pr.text), pr.text + pk);
      // [guard] a part entry is matched by its url's file, not by its entry name: tri: { url: kit.glb, node } must not be re-pointed at the unrelated art/models/tri.glb
      writeFileSync(join(plain, 'assets.js'), `export default [{ name: 'g', models: { tri: { url: '/models/kit.glb', node: 'Wall' } } }];
`);
      await quiet(() => runOptimize(plain, { force: true }));
      const kitPack = readFileSync(join(plain, 'assets.optimized.js'), 'utf8');
      check('[guard] a { url, node } entry named like an unrelated model file is not re-pointed at that file', !/"tri"\s*:/.test(kitPack), kitPack);
      // `needs` is judged on the output too (pruning can drop an empty attach node), in the same list as the part node
      writeFileSync(join(plain, 'assets.js'), `export default [{ name: 'g', base: '/models/', models: { n: { url: 'tri.glb?v=2', needs: { nodes: ['tri', 'zzz'] } } } }];
`);
      const pn = await quiet(() => runOptimize(plain, { force: true }));
      check('needs is checked on the optimized file, through a pack base and a ?v= tag', /model-needs: model "n" .*node "zzz"/.test(pn.text) && !/node "tri"/.test(pn.text), pn.text);
      // a cache hit (the file unchanged) judges the part nodes against the manifest of this run, not the stored report
      writeFileSync(join(plain, 'assets.js'), `export default [{ name: 'g', models: { bad2: { url: '/models/tri.glb', node: 'nope2' } } }];
`);
      const pc = await quiet(() => runOptimize(plain, {}));
      check('on a cache hit a fixed part entry is no longer reported and a new missing node is', /unchanged/.test(pc.text) && /"nope2"/.test(pc.text) && !/"nope"/.test(pc.text), pc.text);
      writeFileSync(join(plain, 'assets.js'), ORIGINAL);
      await quiet(() => runOptimize(plain, { force: true }));
      // cache hits still count problems: a stored output-side problem fails --strict (no reconversion)
      const outP = join(plain, 'public/optimized/tri.glb'), mt = statSync(outP).mtimeMs, repPath = join(plain, '.threedog/optimize-report.json'), rep = JSON.parse(readFileSync(repPath, 'utf8'));
      const c0 = await quiet(() => runOptimize(plain, { strict: true }));
      rep['tri.glb'].problems.push({ code: 'bad-ktx2', msg: 'planted output problem' });
      writeFileSync(repPath, JSON.stringify(rep));
      const c1 = await quiet(() => runOptimize(plain, {})), c2 = await quiet(() => runOptimize(plain, { strict: true }));
      check('cached, no problems: --strict passes', c0.code === 0, c0.text);
      check('cached with a stored problem: a lenient run reports it and exits 0, --strict exits 1, nothing is reconverted',
        c1.code === 0 && /bad-ktx2/.test(c1.text) && c2.code === 1 && /unchanged\s+tri\.glb/.test(c2.text) && statSync(outP).mtimeMs === mt, c1.text + c2.text);
      // [guard] a cached output that was cut short is not "unchanged": it is converted again
      writeFileSync(outP, '');
      const c3 = await quiet(() => runOptimize(plain, { strict: true }));
      check('a truncated cached output is converted again, not reported unchanged', !/unchanged\s+tri\.glb/.test(c3.text) && statSync(outP).size > 0, c3.text);
      // [guard] names that differ only in case collide on a case-insensitive file system
      if (process.platform === 'win32' || process.platform === 'darwin') {
        copyFileSync(join(plain, 'art/models/tri.glb'), join(plain, 'art/models/Tri.gltf'));
        const c4 = await quiet(() => runOptimize(plain, {}));
        check('Tri.gltf next to tri.glb is refused as a name collision', /also becomes.*rename one/.test(c4.text) && c4.code === 1, c4.text);
      }
    } finally { rmSync(plain, { recursive: true, force: true }); }

    const dry = await quiet(() => runOptimize(dir, { dry: true }));
    check('--dry reports the file and writes nothing', dry.code === 0 && /crate\.glb/.test(dry.text) && !existsSync(join(dir, 'public')) && !existsSync(join(dir, '.threedog')) && !existsSync(join(dir, 'assets.optimized.js')), dry.text);
    check('--dry gives the GPU memory before and after', /GPU ≈ [\d.]+ (KB|MB) → [\d.]+ (KB|MB)/.test(dry.text), dry.text);

    // the wasm encoder (ktx2-encoder) stands in when `ktx` is not on PATH, so the KTX2 steps below run on any machine that ran npm install
    check('the run says which texture encoder it uses', /Texture encoder: (ktx \(|ktx2-encoder )/.test(dry.text), dry.text);
    const r1 = await quiet(() => runOptimize(dir, {}));
    const out = join(dir, 'public/optimized/crate.glb');
    check('first run optimizes the model', r1.code === 0 && existsSync(out), r1.text);
    check('the original file is unchanged byte for byte', sha(src) === before);
    const { readModel } = await import('../assets-check/read.mjs'), { doc } = await readModel(out);
    const tx = doc.getRoot().listTextures();
    check('both textures are KTX2', tx.length === 2 && tx.every(t => t.getMimeType() === 'image/ktx2'), tx.map(t => t.getMimeType()).join());
    const ktxParse = createRequire(resolve(ROOT, 'package.json'))('ktx-parse');
    const hdr = n => { const k = ktxParse.read(new Uint8Array(tx.find(t => t.getName() === n).getImage())), d = k.dataFormatDescriptor[0]; return { model: d.colorModel, tf: d.transferFunction }; };
    check('the normal map is UASTC and linear, not compressed as color', hdr('crate_normal').model === 166 && hdr('crate_normal').tf === 1, JSON.stringify(hdr('crate_normal')));
    check('the color map is ETC1S and sRGB', hdr('crate_albedo').model === 163 && hdr('crate_albedo').tf === 2, JSON.stringify(hdr('crate_albedo')));
    check('the model is Meshopt compressed', JSON.stringify(doc.getRoot().listExtensionsUsed().map(e => e.extensionName)).includes('EXT_meshopt_compression'));
    check('assets.js imports the result pack', /import optimized from '\.\/assets\.optimized\.js'/.test(readFileSync(join(dir, 'assets.js'), 'utf8')) && /\/optimized\/crate\.glb/.test(readFileSync(join(dir, 'assets.optimized.js'), 'utf8')));
    const mtime = statSync(out).mtimeMs, r2 = await quiet(() => runOptimize(dir, {}));
    check('a rerun skips the unchanged file', r2.code === 0 && /unchanged\s+crate\.glb/.test(r2.text) && statSync(out).mtimeMs === mtime, r2.text);
    // cached, lowered --budget: over-budget is judged again against this run's budget (needs a texture, so it lives on the ktx path)
    const mt2 = statSync(out).mtimeMs, s3 = await quiet(() => runOptimize(dir, { strict: true, budget: 0.0001 }));
    check('cached, lowered --budget: over-budget is reported again, --strict exits 1, nothing is reconverted', s3.code === 1 && /over-budget/.test(s3.text) && statSync(out).mtimeMs === mt2, s3.text);
    const r3 = await quiet(() => runOptimize(dir, { force: true }));
    check('--force redoes it', /✓ crate\.glb/.test(r3.text), r3.text);
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
}
