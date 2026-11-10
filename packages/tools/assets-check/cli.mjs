// threedog assets check [glb or folder] [--json] [--strict] [--full] [--against old.glb] [-w game]
// Reads each glb statically: the level manifest (spawn / col_ / trigger_ / template ...), material and color-space suspicions, model statistics.
// Default target: art/models of the workspace. Exit 1 on errors (--strict: on warnings too). --json prints one machine-readable object instead of text.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { loadGame, gameAssets } from '../content-check/load.mjs';
import { readModel, hasReader, NO_READER } from './read.mjs';
import { levelManifest, checkAgainstContent, missingTriggers, summarize } from './level.mjs';
import { reviewMaterials } from './materials.mjs';
import { modelStats, statsLines } from './stats.mjs';
import { fileReport, reportLines } from './report.mjs';
import { nameHintLines } from './names.mjs';
import { compareModels } from './against.mjs';
import { declaredNeeds, needsIssues } from './needs.mjs';
import { isFileOf } from '../lib/asset-url.mjs';

/** Check one model file: { file, level, materials, stats } (level = the manifest incl. its issues) */
export async function checkModel(file, content, declared = []) {
  const { doc, core } = await readModel(file);
  const level = checkAgainstContent(levelManifest(doc, file), content);
  level.issues.push(...needsIssues(file, doc, declared));   // the manifest's needs: nodes and clips (the load checks the same declaration)
  return { file, level, materials: reviewMaterials(doc, core), stats: modelStats(doc, core), report: fileReport(doc, level) };
}

/** assets check: opt and the target come from the one parse in assets.mjs (paths.mjs cli), where a misspelled option fails */
export async function runCheck(dir, opt, given) {
  const json = !!opt.json, strict = !!opt.strict, full = !!opt.full, againstFile = opt.against ?? null;
  const target = resolve(given ?? join(dir, 'art/models'));
  // no art/models/ of its own: a game without models (sprites, code-made meshes) has nothing to check. A path the caller named must exist
  if (!given && !existsSync(target)) { console.log(json ? JSON.stringify({ target, models: [], missingContentTriggers: [], errors: 0, warnings: 0 }, null, 2) : '✓ No art/models/ folder: no models to check'); return 0; }
  if (!hasReader()) { console.error('✗ ' + NO_READER); return 1; }
  if (!existsSync(target)) { console.log(`✗ ${target} does not exist. Pass a .glb file or a folder, or put exports into art/models/.`); return 1; }
  const files = statSync(target).isDirectory() ? readdirSync(target).filter(f => /\.(glb|gltf)$/i.test(f)).map(f => join(target, f)) : [target];
  const content = existsSync(join(dir, 'content')) ? (await loadGame(dir)).data : undefined;
  const manifest = await gameAssets(dir), results = [], declared = declaredNeeds(manifest.packs, dir);
  if (manifest.error && !json) console.log(`! ${manifest.error.split('\n')[0]}: manifest needs were not checked`);
  for (const f of files) {
    try { results.push(await checkModel(f, content, declared)); } catch (e) { results.push({ file: f, error: e.message }); }
  }
  // the file the engine loads is public/<resolved url>, wherever the checked folder is: served files outside it are read for their needs (a missing one is content check's missing-file report)
  const extra = [];
  for (const d of statSync(target).isDirectory() ? declared : []) if (existsSync(d.files.served) && !files.some(x => isFileOf(d.files, x))) {
    try { extra.push(...needsIssues(d.files.served, (await readModel(d.files.served)).doc, [d]).map(i => i.msg)); } catch (e) { extra.push(`model "${d.name}": ${d.files.path} cannot be read: ${e.message}`); }
  }
  if (againstFile) {   // asset swap check: the new file against the old one
    let old; try { old = await checkModel(resolve(againstFile), content); } catch (e) { console.error('✗ cannot read --against file: ' + e.message); return 1; }
    for (const r of results) if (!r.error) { r.against = compareModels(r, old); r.level.issues.push(...r.against.map(i => ({ ...i, msg: `vs ${againstFile}: ${i.msg}` }))); }
  }
  const levels = results.filter(r => r.level).map(r => r.level), gone = content && statSync(target).isDirectory() ? missingTriggers(content, levels) : [];
  const errors = results.filter(r => r.error).length + levels.flatMap(l => l.issues).filter(i => i.severity === 'error').length + gone.length + extra.length;
  const warnings = levels.flatMap(l => l.issues).filter(i => i.severity === 'warn').length + results.flatMap(r => r.materials || []).filter(i => i.severity === 'warn').length;
  if (json) console.log(JSON.stringify({ target, models: results, missingContentTriggers: gone, servedNeeds: extra, ...(manifest.error && { manifestError: manifest.error.split(/\r?\n/)[0] }), errors, warnings }, null, 2));
  else {
    for (const r of results) {
      console.log(`\n${relative(process.cwd(), r.file) || r.file}`);
      if (r.error) { console.log(`  ✗ cannot read: ${r.error}`); continue; }
      console.log(`  level       ${summarize(r.level)}`);
      for (const l of statsLines(r.stats, '  ')) console.log(l);
      for (const l of reportLines(r.report, full)) console.log(l);
      for (const i of r.level.issues) if (i.severity !== 'info') console.log(`  ${i.severity === 'error' ? '✗' : '!'} ${i.msg}`);
      for (const l of nameHintLines(r.level.issues, full)) console.log(l);
      for (const i of r.materials) console.log(`  ${i.severity === 'warn' ? '!' : '·'} ${i.where}: ${i.msg}`);
    }
    for (const m of extra) console.log(`\n✗ ${m}`);
    for (const tag of gone) console.log(`\n✗ content/triggers.js: trigger zone ${tag} is fromLevel, but no checked model has a node trigger_${tag}`);
    console.log(`\nAsset check: ${files.length} models, ${errors} errors, ${warnings} warnings`);
  }
  return errors || (strict && warnings) ? 1 : 0;
}
