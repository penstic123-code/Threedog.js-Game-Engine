// threedog assets optimize [-w game] [--dry] [--force] [--budget MB] [--strict] [--lod [--lod-shares 0.5,0.2]]
// Reads the game's source models (art/models/*.glb|gltf, never changed), writes the optimized copies to public/optimized/<name>.glb, and points the
// game at them (assets.optimized.js, imported by assets.js). Existing open-source tools do the work: @gltf-transform/cli (meshopt, prune, textures)
// and a Basis Universal texture encoder: KTX-Software's `ktx` when it is on PATH (first choice), else the WebAssembly encoder of the npm package ktx2-encoder
// (assets-ktx.mjs). Neither is needed to install threedog; with no encoder at all only this command fails, and says what to install.
// Textures: one KTX2 per texture, encoded by the slot that uses it (glTF Transform's own rule): normal / occlusion / metallicRoughness are linear data
// and go UASTC, color slots go ETC1S + sRGB. After the run every output texture is read back and checked against its slot, so a normal map
// compressed as color is reported, not shipped silently (this needs ktx-parse; without it the run says the check was skipped).
// Not touched: baked lightmaps (*.lightmap). Their banding after compression is not measured yet, so they are left as baked and the report says so.
// A rerun handles only files whose content, options or tool versions changed (hash, not file time). --dry changes nothing and reports what would be saved.
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, basename, extname, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { declaredNeeds, entryIssues } from './assets-check/needs.mjs';
import { gameAssets } from './content-check/load.mjs';
import { ROOT } from './paths.mjs';
import { walk } from './lib/text.mjs';
import { KB, MB, modelStats } from './assets-check/stats.mjs';
import { readModel, hasReader, NO_READER } from './assets-check/read.mjs';
import { reviewMaterials } from './assets-check/materials.mjs';
import { loadWasmEncoder, encodeTextures, textureSlots, WASM_HOW } from './assets-ktx.mjs';
import { buildLevels, dropLevels, lodSkipReason, parseRatios, triangleCount } from './assets-lod.mjs';

const DEFAULT_BUDGET_MB = 32;   // GPU memory of one model's textures; over it is reported (a game decides the real number with --budget)
const COLOR_SLOTS = ['baseColorTexture', 'emissiveTexture'];
// KTX2 data format descriptor values (Khronos Data Format spec): color model UASTC = 166, ETC1S = 163; transfer function linear = 1, sRGB = 2
const MODEL_UASTC = 166, TRANSFER_SRGB = 2;

const mem = n => (n < 1048576 ? KB(n) : MB(n));   // small models show in KB, not 0.0 MB
/** One report line: triangles per level, or why there are no levels */
const lodLine = (f, l) => l.skipped ? `  LOD ${f}: skipped, ${l.skipped}` : `  LOD ${f}: ${l.triangles.join(' → ')} triangles (full${l.files.map((_, i) => ` → level ${i + 1}`).join('')})${l.note ? '; ' + l.note : ''}`;
/** What the pack says about one model: its path, plus the level files when it has any (only engine.assets.lod reads those, so a game that did not opt in downloads none) */
const packEntry = (name, l) => l?.files?.length ? { url: `/optimized/${name}.glb`, lods: l.files.map(x => `/optimized/${x}`) } : `/optimized/${name}.glb`;
/** Texture GPU bytes once the file is KTX2: block-compressed, ~1 byte per pixel, +1/3 for mips (same estimate as modelStats) */
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';   // default file systems there treat Tree.glb and tree.glb as one file
const ktx2Gpu = t => Math.round(t.width * t.height * 4 / 3);

/** Cache key: source bytes (plus the files a .gltf points to), options and tool versions */
function sourceHash(src, toolKey) {
  const h = createHash('sha256').update(readFileSync(src));
  if (/\.gltf$/i.test(src)) {
    const j = JSON.parse(readFileSync(src, 'utf8'));
    for (const r of [...(j.buffers ?? []), ...(j.images ?? [])]) {
      const p = r.uri && !r.uri.startsWith('data:') && resolve(dirname(src), decodeURIComponent(r.uri));
      if (p && existsSync(p)) h.update(readFileSync(p));
    }
  }
  return h.update(toolKey).digest('hex');
}

/**
 * Problems of a model that optimizing does not fix, found on the source: color space by slot / name, textures without UV, a second UV set that
 * a texture asks for and the mesh lacks, texture memory over the budget.
 * @returns {{ code: string, msg: string }[]}
 */
function sourceProblems(doc, core, budgetMb, gpuAfter) {
  const out = reviewMaterials(doc, core).filter(i => i.severity === 'warn' && /color|data|shared|uv/.test(i.code)).map(i => ({ code: i.code, msg: `${i.where}: ${i.msg}` }));
  // second UV: a texture whose texCoord is 1 on a primitive that has no TEXCOORD_1 (typical: ambient occlusion or a baked light on UV2 exported without it)
  const seen = new Set();
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    if (!m || p.getAttribute('TEXCOORD_1')) continue;
    const infos = [[m.getBaseColorTexture(), m.getBaseColorTextureInfo()], [m.getEmissiveTexture(), m.getEmissiveTextureInfo()], [m.getNormalTexture(), m.getNormalTextureInfo()],
      [m.getOcclusionTexture(), m.getOcclusionTextureInfo()], [m.getMetallicRoughnessTexture(), m.getMetallicRoughnessTextureInfo()]];
    if (infos.some(([t, i]) => t && i.getTexCoord() === 1) && !seen.has(mesh)) {
      seen.add(mesh);
      out.push({ code: 'missing-second-uv', msg: `mesh ${mesh.getName() || '(unnamed)'}: a texture reads the second UV set (TEXCOORD_1) but the mesh has none. Add a second UV map in Blender (lightmap / AO unwrap) and export again.` });
    }
  }
  if (gpuAfter > budgetMb * 1048576) out.push(overBudget(gpuAfter, budgetMb));
  return out;
}

const overBudget = (gpuAfter, budgetMb) => ({ code: 'over-budget', msg: `texture GPU memory ≈ ${MB(gpuAfter)} even as KTX2, over the ${budgetMb} MB budget. Lower the texture sizes in the source (a size is an art decision, so it is not done here) or raise --budget.` });

/** Read the KTX2 header of every output texture and compare with its slot: { code, msg }[] */
function encodingProblems(doc, ktxParse) {
  const out = [];
  for (const t of doc.getRoot().listTextures()) {
    if (t.getMimeType() !== 'image/ktx2') continue;
    const label = t.getName() || t.getURI() || '(unnamed texture)', slots = textureSlots(doc, t);
    let k; try { k = ktxParse.read(new Uint8Array(t.getImage())); } catch (e) { out.push({ code: 'bad-ktx2', msg: `texture ${label} is not a readable KTX2 file (${e.message})` }); continue; }
    const dfd = k.dataFormatDescriptor[0], uastc = dfd.colorModel === MODEL_UASTC, srgb = dfd.transferFunction === TRANSFER_SRGB;
    for (const s of slots) {
      if (s === 'normalTexture' && !uastc) out.push({ code: 'normal-compressed-as-color', msg: `normal map ${label} was encoded as color (ETC1S), which bends its directions. Use UASTC for normal maps.` });
      if (!COLOR_SLOTS.includes(s) && srgb) out.push({ code: 'data-tagged-srgb', msg: `texture ${label} is data (${s}) but its KTX2 header says sRGB.` });
      if (COLOR_SLOTS.includes(s) && !srgb) out.push({ code: 'color-tagged-linear', msg: `texture ${label} is color (${s}) but its KTX2 header says linear.` });
    }
  }
  return out;
}

/**
 * The manifest entries that care about a file's content, { name, url, node, needs, files } (assets-check/needs.mjs, the one reader): `{ url: '/models/kit.glb', node: 'Wall' }`
 * is one node of a file (core/assets/assetPart.js), and `needs` names nodes and clips the game uses. The file is optimized once like any other; a node entry only needs
 * its node to survive and to point at the optimized copy, and both are checked on the output (pruning can drop an empty attach node). assets.js is imported through
 * content check's loader (gameAssets); if that fails these entries are skipped and the run says so.
 */
async function partEntries(dir) {
  const { packs, error } = await gameAssets(dir);   // the same import (under the DOM stand-ins) content check reads names with
  if (error) return { parts: [], note: `${error.split(/\r?\n/)[0]}: { url, node } entries and needs were not checked` };
  return { parts: declaredNeeds(packs, dir) };
}

/** What a file's entries lack, in one list: a part node that is gone, or declared nodes / clips that are gone ('model-needs', the same message as assets check) */
const partProblems = (doc, parts) => parts.flatMap(p => entryIssues(doc, p)).map(msg => ({ code: 'model-needs', msg }));

/** assets.optimized.js: the pack pointing at the results; assets.js gets the import once (only when it has the usual `export default [` form) */
function pointGameAtResults(dir, models) {
  const pack = resolve(dir, 'assets.optimized.js');
  const body = `// Written by \`threedog assets optimize\` (rerun it to refresh): the optimized copies in public/optimized/. Edit the sources in art/models/, not this file.\n` +
    `export default [{ name: 'optimized', models: ${JSON.stringify(models, null, 2)} }];\n`;
  if (!existsSync(pack) || readFileSync(pack, 'utf8') !== body) writeFileSync(pack, body);
  const assets = resolve(dir, 'assets.js');
  if (!existsSync(assets)) return `no assets.js here: import ./assets.optimized.js where you call engine.assets.manifest(...)`;
  let text = readFileSync(assets, 'utf8');
  // Packs registered later win (core/assets/assetManifest.js), so the optimized pack must come LAST: an older version of this command wrote
  // `[...optimized, ` first, which let the original path replace /optimized/x.glb. Move such a game over.
  const old = text.includes('[...optimized, ');
  if (text.includes('assets.optimized') && !old) return null;
  if (!/export default \[/.test(text)) return `add to assets.js: import optimized from './assets.optimized.js'; and spread ...optimized LAST in the packs (the later pack wins)`;
  if (old) text = text.replace('export default [...optimized, ', 'export default [');
  else text = `import optimized from './assets.optimized.js';\n` + text;
  // the game's own array keeps its text; only its name and the final export change
  writeFileSync(assets, text.replace(/export default \[/, 'const gamePacks = [') + `\nexport default [...gamePacks, ...optimized];   // optimized last: the later pack wins\n`);
  return 'assets.js now imports ./assets.optimized.js as the last pack, so its models win over the originals of the same name';
}

/** @returns {Promise<number>} exit code */
export async function runOptimize(dir, opt) {
  const SRC = resolve(dir, 'art/models'), OUT = resolve(dir, 'public/optimized'), STATE = resolve(dir, '.threedog');
  const dry = !!opt.dry, force = !!opt.force, strict = !!opt.strict, budget = opt.budget === undefined ? DEFAULT_BUDGET_MB : Number(opt.budget);
  if (!(budget > 0)) { console.error('✗ --budget takes a number of MB, like --budget 32'); return 1; }
  let ratios = null;
  try { if (opt.lod || opt['lod-shares']) ratios = parseRatios(opt['lod-shares'] ?? true); } catch (e) { console.error('✗ ' + e.message); return 1; }
  if (!existsSync(SRC)) { console.log(`${SRC} does not exist. Put the .glb / .gltf exported from Blender into art/models/ and run again.`); return 0; }
  if (!hasReader()) { console.error('✗ assets optimize needs @gltf-transform/cli: run npm i -D @gltf-transform/cli (' + NO_READER + ')'); return 1; }
  const req = createRequire(resolve(ROOT, 'package.json'));
  let cliBin; try { cliBin = resolve(dirname(req.resolve('@gltf-transform/cli')), '../bin/cli.js'); } catch { console.error('✗ assets optimize needs @gltf-transform/cli: run npm i -D @gltf-transform/cli'); return 1; }
  let ktxParse = null; try { ktxParse = req('ktx-parse'); } catch {}
  const ktx = spawnSync('ktx', ['--version'], { encoding: 'utf8' }), ktxOk = !ktx.error && ktx.status === 0;
  const ktxVersion = ktxOk ? (ktx.stdout || ktx.stderr).trim() : null;
  // encoder: `ktx` on PATH stays the first choice; else the wasm one; the run says which one it used
  const wasm = ktxOk ? null : await loadWasmEncoder(), encoderOk = ktxOk || !!wasm;
  const encoderName = ktxOk ? `ktx (KTX-Software ${ktxVersion})` : wasm ? `ktx2-encoder ${wasm.version} (Basis Universal, WebAssembly)` : null;

  // No texture resize (a size is an art decision); names, hierarchy and material names stay (the level module reads col_, spawn ...)
  const FLAGS = ['--compress', 'meshopt', '--texture-compress', 'ktx2', '--texture-size', '16384', '--flatten', 'false', '--join', 'false', '--instance', 'false', '--simplify', 'false', '--palette', 'false'];
  const version = JSON.parse(readFileSync(resolve(dirname(cliBin), '../package.json'), 'utf8')).version;
  const toolKey = JSON.stringify({ gltfTransform: version, encoder: encoderName, flags: FLAGS, lod: ratios });
  const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
  const cachePath = resolve(STATE, 'optimize-cache.json'), reportPath = resolve(STATE, 'optimize-report.json');
  const cache = readJson(cachePath, {}), report = readJson(reportPath, {});

  const files = readdirSync(SRC).filter(f => /\.(glb|gltf)$/i.test(f));
  if (!dry) mkdirSync(OUT, { recursive: true });
  let failed = 0, problemCount = 0, done = 0, before = 0, after = 0, gpuB = 0, gpuA = 0;
  const names = {};   // only models with a usable result: the pack must never point at a file this run could not make
  let readBackSkipped = false;
  console.log(`${dry ? 'Dry run (nothing is written): ' : ''}${files.length} model(s) in ${SRC}`);
  console.log(`Texture encoder: ${encoderName ?? 'none found'}`);
  const outOf = new Map();
  const { parts, note: partNote } = await partEntries(dir);
  if (partNote) console.log('  ! ' + partNote);
  // entries called like an output file that do not mean that file (a { url, node } part, or a url to another file): the plain re-point <name> -> /optimized/<name>.glb would replace their url and drop their node
  const ownEntry = new Set(parts.filter(p => p.node != null || basename(p.files.path, extname(p.files.path)) !== p.name).map(p => p.name));
  for (const f of files) {
    const name = basename(f, extname(f)), src = resolve(SRC, f), out = resolve(OUT, name + '.glb');
    // Windows and macOS file systems ignore case: Tree.glb and tree.gltf would write the same output file
    const nameKey = CASE_BLIND ? name.toLowerCase() : name;
    if (outOf.has(nameKey)) { console.log(`✗ ${f}: ${outOf.get(nameKey)} also becomes ${name}.glb: rename one`); failed++; continue; }
    outOf.set(nameKey, f);
    // the entries this output serves; the file they get is public/optimized/<n>.glb. A plain entry is matched by its name (documented); a { url, node } part entry only by the file its url
    // names (its entry name says which part, not which file: wall: { url: kit.glb, node: 'Wall' } must not take an unrelated wall.glb)
    const mine = parts.filter(p => (p.node == null && p.name === name) || basename(p.files.path, extname(p.files.path)) === name);
    for (const p of mine) p.out = name;
    let key;
    try { key = sourceHash(src, toolKey); } catch (e) { console.log(`✗ ${f}: cannot be read (${e.message})`); failed++; continue; }
    // a cached output must still be a readable model (a truncated or zeroed file would pass as "unchanged"); unreadable → convert again
    let outDoc = null, hit = !force && existsSync(out) && cache[f] === key;
    if (hit) try { outDoc = (await readModel(out)).doc; } catch (e) { console.log(`  ${f}: the optimized file is unreadable (${e.message}), converting again`); hit = false; }
    if (hit) {
      // No reconversion, but the verdict must match THIS run's flags: the budget problem is judged again against the current --budget, the other
      // problems (source and KTX2 slot checks) do not depend on flags and come from the stored report, so a cache hit cannot hide them from --strict
      console.log(`  unchanged  ${f}`);
      const prev = report[f];
      if (!ownEntry.has(name)) names[name] = packEntry(name, prev?.lods);
      if (prev?.lods) console.log(lodLine(f, prev.lods));
      if (prev?.source) {
        const gpu = (prev.source.textures?.list || []).reduce((s, t) => s + ktx2Gpu(t), 0);
        // part nodes are judged again too: the manifest may have changed while the file did not (a fixed or a new { url, node } entry)
        let partNow = [];
        if (mine.length) partNow = partProblems(outDoc, mine);
        const now = [...(prev.problems || []).filter(p => p.code !== 'over-budget' && p.code !== 'model-needs' && p.code !== 'part-node-missing'), ...partNow, ...(gpu > budget * 1048576 ? [overBudget(gpu, budget)] : [])];
        for (const p of now) console.log(`  ! ${p.code}: ${p.msg}`);
        problemCount += now.length; prev.problems = now;
      }
      continue;
    }
    let src0;
    try { src0 = await readModel(src); } catch (e) { console.log(`✗ ${f}: cannot read (${e.message})`); failed++; continue; }
    const s0 = modelStats(src0.doc, src0.core), hasTex = s0.textures.count > 0;
    const gpuEst = s0.textures.list.reduce((s, t) => s + ktx2Gpu(t), 0), a = statSync(src).size;
    const problems = sourceProblems(src0.doc, src0.core, budget, gpuEst);
    let s1 = null, b = null, lods = null;
    const skip = ratios && lodSkipReason(src0.doc);
    if (dry) {
      problems.push(...partProblems(src0.doc, mine));
      if (ratios) console.log(skip ? lodLine(f, { skipped: skip }) : `  LOD ${f}: ${triangleCount(src0.doc)} triangles, levels are measured in a real run`);
      console.log(`- ${f}  ${KB(a)}, ${s0.textures.count} texture(s): GPU ≈ ${mem(s0.textures.gpuBytes)} → ${mem(gpuEst)} as KTX2 (estimate); the download size is known after a real run${hasTex && !encoderOk ? '\n  ! no texture encoder is installed: a real run would fail on this file. ' + WASM_HOW : ''}`);
    } else {
      if (hasTex && !encoderOk) { console.log(`✗ ${f}: ${WASM_HOW}`); failed++; continue; }
      const t0 = Date.now();
      // the CLI's own ktx2 step needs the `ktx` program; without textures or without it, texture compression is switched off for the CLI
      let input = src, flags = hasTex && ktxOk ? FLAGS : FLAGS.map((x, i) => FLAGS[i - 1] === '--texture-compress' ? 'false' : x), encMs = 0;
      if (hasTex && wasm) {
        // wasm route: encode the textures here (by slot), hand the CLI a glb whose textures are already KTX2 and tell it not to touch textures
        try {
          const tmp = resolve(STATE, 'tmp-' + name + '.glb'); mkdirSync(STATE, { recursive: true });
          const gx = req('@gltf-transform/extensions'), e = await encodeTextures(src0.doc, gx, wasm); encMs = e.ms;
          await new (req('@gltf-transform/core').NodeIO)().registerExtensions(gx.ALL_EXTENSIONS).write(tmp, src0.doc);
          input = tmp;
        } catch (e) { console.log(`✗ ${f}: texture encoding failed (${e.message})`); failed++; continue; }
      }
      const r = spawnSync(process.execPath, [cliBin, 'optimize', input, out, ...flags], { encoding: 'utf8' });
      if (input !== src) try { unlinkSync(input); } catch {}
      if (r.status !== 0) { console.log(`✗ ${f}\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}`); failed++; continue; }
      b = statSync(out).size;
      let res; try { res = await readModel(out); } catch (e) { console.log(`✗ ${f}: the output cannot be read back (${e.message})`); failed++; continue; }
      s1 = modelStats(res.doc, res.core);
      problems.push(...partProblems(res.doc, mine));   // optimize keeps names (flatten / join off); a node that had nothing in it is dropped by prune, so check
      if (ktxParse) problems.push(...encodingProblems(res.doc, ktxParse));
      else if (hasTex && !readBackSkipped) { readBackSkipped = true; console.log('  ! KTX2 read-back check skipped: ktx-parse is not installed, so a texture encoded for the wrong slot would not be reported (npm i -D ktx-parse)'); }
      dropLevels(OUT, name);
      if (skip) lods = { skipped: skip };
      else if (ratios) try { lods = await buildLevels(out, OUT, name, ratios); } catch (e) { console.log(`✗ ${f}: LOD levels failed (${e.message})`); failed++; delete cache[f]; continue; }   // the levels are gone: the next run must not call this model unchanged
      if (!ownEntry.has(name)) names[name] = packEntry(name, lods);
      cache[f] = key; before += a; after += b; done++; gpuB += s0.textures.gpuBytes; gpuA += s1.textures.gpuBytes;
      console.log(`✓ ${f}  ${KB(a)} → ${KB(b)} (${Math.round(b / a * 100)}%, ${Date.now() - t0} ms${encMs ? `, ${encMs} ms of it encoding textures` : ''}); textures ${s0.textures.count} × ${s1.textures.formats.join('+') || '-'}, GPU ≈ ${mem(s0.textures.gpuBytes)} → ${mem(s1.textures.gpuBytes)} (estimate)`);
      if (lods) console.log(lodLine(f, lods));
    }
    for (const p of problems) console.log(`  ! ${p.code}: ${p.msg}`);
    problemCount += problems.length;
    report[f] = { sourceBytes: a, outputBytes: b, output: b ? `public/optimized/${name}.glb` : null, source: s0, optimized: s1, lods: lods ?? undefined, problems, dry: dry || undefined };
  }
  // part entries follow their file: the later pack wins, so the same entry name now reads its node from the optimized copy
  for (const p of parts) if (p.node != null && names[p.out]) names[p.name] = { url: `/optimized/${p.out}.glb`, node: p.node };
  if (!dry) {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 1) + '\n');
    writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
    // a failed run leaves the game as it was: a half list would drop models that still work, and a full one would name a file that is not there
    if (failed) console.log('\nassets.js and assets.optimized.js were not changed: fix the failed model(s) and run again.');
    else if (files.length) { const note = pointGameAtResults(dir, names); if (note) console.log('\n' + note + '.'); }
  }
  // Lightmaps are listed, not compressed
  const lm = walk(resolve(dir, 'public'), { exts: /\.lightmap$/, unscoped: true });
  if (lm.length) console.log(`\nLightmaps left as baked (${lm.length}): banding after compression is not measured yet, so they are not compressed.`);
  if (done) console.log(`\nOptimized ${done}: ${KB(before)} → ${KB(after)}, texture GPU ≈ ${mem(gpuB)} → ${mem(gpuA)} (estimate). Originals in art/models/ are untouched.`);
  else if (!failed && !dry) console.log('\nNothing to do.');
  console.log(`${problemCount} problem(s), ${failed} failed`);
  return failed || (strict && problemCount) ? 1 : 0;
}
