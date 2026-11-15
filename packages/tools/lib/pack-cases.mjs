// Extra cases of the outside-the-repo check (pack-external.mjs: step 1 package contents, steps 6 and 7) and the template copy it starts from.
//   packageContents: what the packed engine / tools / terrain tarballs contain
//   copyTemplate: the new-game template into a folder, as new-game does (game name 'external'); usePost: the game brings bloom() as a file in its plugins/ folder
//   engineAlone:  the engine folder installed by path with npm install --install-links, only three and vite next to it, a plain vite config builds
//   vendored:     the engine vendored under vendor/threedog (tests included) as a file: dependency; check and types read only the game's sources
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ENGINE, TOOLS, addonDir } from '../paths.mjs';
import { copyTemplates } from './scaffold.mjs';

/** Copy the game template into dir as new-game --open-world does (game name 'external'), without its package.json (the test writes its own) */
export function copyTemplate(to) {
  copyTemplates(to, { name: 'external', openWorld: true }, { skipPackage: true });
}

/** Add grain() from @threedog/post-effects as plugins/10-grain.js, so the outside check loads an effect through a plugin file too. Not bloom: the template's picture/post.js adds bloom, and a second one throws */
export function usePost(dir) {
  writeFileSync(join(dir, 'plugins', '10-grain.js'), "// @ts-check\nimport { grain } from '@threedog/post-effects';\n\nexport default grain();\n");
}

/** Step 6: install the engine folder by path into a project with only threedog, three and vite, then build it with a plain vite config */
export async function engineAlone(tmp, eng, check, { npm, node, MAIN }) {
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  const bad = Object.entries(deps).filter(([n, v]) => n.startsWith('@threedog/') || /^(file|link|workspace):/.test(String(v))).map(([n, v]) => `${n}@${v}`);
  check('engine package.json depends on nothing unpublished (no @threedog/* or file:/workspace: specs, dev ones included)', bad.length === 0, bad.join(', '));
  // the engine folder as a user would have it next to their game: what the tarball ships, package.json as is
  const src = join(tmp, 'threedog'), solo = join(tmp, 'solo'), shipped = new Set(eng.files.map(f => f.path.split('/')[0]));
  cpSync(ENGINE, src, { recursive: true, filter: p => { const r = relative(ENGINE, p).split(sep)[0]; return r === '' || shipped.has(r); } });
  mkdirSync(solo);
  const vite = JSON.parse(readFileSync(join(TOOLS, 'package.json'), 'utf8')).dependencies.vite;
  writeFileSync(join(solo, 'package.json'), JSON.stringify({ name: 'threedog-solo-check', private: true, type: 'module', dependencies: { threedog: 'file:../threedog', three: '~0.187.0', vite } }, null, 2));
  writeFileSync(join(solo, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>solo</title></head><body style="margin:0"><canvas id="view"></canvas><script type="module" src="./main.js"></script></body></html>\n');
  writeFileSync(join(solo, 'main.js'), MAIN);
  // a plain vite config, as recipes/01-new-game.md gives it for a project without @threedog/tools: the engine's Workers must be ES modules
  writeFileSync(join(solo, 'vite.config.js'), "export default { worker: { format: 'es' }, build: { target: 'es2022' } };\n");
  // --install-links: a plain symlink would leave the engine's own dependencies (rapier, recast…) uninstalled, so the build could not resolve them
  const inst = npm(['install', '--install-links', '--no-audit', '--no-fund', '--loglevel=error'], solo);
  check('engine alone: npm install --install-links of the engine folder by path succeeds', inst.status === 0, (inst.stderr || String(inst.error)).slice(0, 300));
  if (inst.status !== 0) return;
  const tools = [join(solo, 'node_modules/@threedog/tools'), join(solo, 'node_modules/threedog/node_modules/@threedog/tools')].filter(existsSync);
  check('engine alone: no @threedog/tools installed', tools.length === 0, tools.join(', '));
  check('engine alone: one copy of three (none nested under threedog)', !existsSync(join(solo, 'node_modules/threedog/node_modules/three')));
  const b = node([join(solo, 'node_modules/vite/bin/vite.js'), 'build'], solo);
  check('engine alone: vite build with a plain config succeeds', b.status === 0, (b.stdout + b.stderr).split('\n').filter(l => /error/i.test(l)).slice(0, 3).join(' | '));
}

/** Step 7: the engine vendored under vendor/threedog (with its tests) and installed as file:./vendor/threedog; a notes/ folder excluded by config */
export async function vendored(tmp, tools, check, { npm, cli }) {
  const dir = join(tmp, 'vend'), engDir = join(dir, 'vendor', 'threedog');
  mkdirSync(engDir, { recursive: true });
  cpSync(ENGINE, engDir, { recursive: true, filter: p => !/(^|[\\/])(node_modules|\.threedog|dist)([\\/]|$)/.test(relative(ENGINE, p)) });
  // the template uses optional packages (the terrain generator and post-effects): vendored next to the engine
  for (const [src, name] of [[addonDir('terrain-noise'), 'terrain-noise'], [addonDir('post-effects'), 'post-effects']])
    cpSync(src, join(dir, 'vendor', name), { recursive: true, filter: p => !/(^|[\\/])node_modules([\\/]|$)/.test(relative(src, p)) });
  copyTemplate(dir);
  mkdirSync(join(dir, 'notes'));
  // a file the game excluded: a type error and a startup placement that would fail check if it were scanned
  writeFileSync(join(dir, 'notes', 'scratch.js'), "// @ts-check\nconst n = 1;\nn.normalise();\nengine.add(n);\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'threedog-vendored-check', private: true, type: 'module', threedog: { exclude: ['notes'] },
    dependencies: { threedog: 'file:./vendor/threedog', '@threedog/terrain-noise': 'file:./vendor/terrain-noise', '@threedog/post-effects': 'file:./vendor/post-effects', three: '~0.187.0' }, devDependencies: { '@threedog/tools': `file:../${tools.filename}` } }, null, 2));
  const inst = npm(['install', '--install-links', '--no-audit', '--no-fund', '--loglevel=error'], dir);
  check('vendored engine: npm install of file:./vendor/threedog succeeds', inst.status === 0, (inst.stderr || String(inst.error)).slice(0, 300));
  if (inst.status !== 0) return;
  await cli(dir, 'map');
  const chk = await cli(dir, 'check'), ty = await cli(dir, 'types');
  const leak = out => out.split('\n').filter(l => /vendor[\\/]|notes[\\/]/.test(l)).slice(0, 3).join(' | ');
  check('vendored engine: threedog check passes and never reports vendor/ or the excluded notes/', chk.code === 0 && !leak(chk.out), leak(chk.out) || chk.out.split('\n').filter(l => /✗/.test(l)).slice(0, 4).join(' | '));
  check('vendored engine: threedog types checks only the game sources', ty.code === 0 && !leak(ty.out), leak(ty.out) || ty.out.slice(-300));
}

/** Step 1 of the outside-the-repo check: what the four packed tarballs contain (each is { filename, files: [{ path }] } from npm pack) */
export function packageContents(check, { eng, tools, terrainPkg, engPkg }) {
  const engFiles = eng.files.map(f => f.path), toolFiles = tools.files.map(f => f.path);
  const has = (pkg, ...names) => names.every(n => pkg.files.some(x => x.path === n));
  const need = ['index.js', 'index.d.ts', 'README.md', 'docs/AI.md', 'core/base/errorHints.js', 'core/threads/pureWorker.js', 'modules/terrain/chunkWorker.js'];
  const hidden = engFiles.filter(f => /^(tests|public)\//.test(f));
  check('engine tarball has entry points, types, docs, workers', need.every(f => engFiles.includes(f)), need.filter(f => !engFiles.includes(f)).join(', '));
  check('engine tarball has no tests/ or public/', hidden.length === 0, hidden.slice(0, 3).join(', '));
  check('engine tarball ships no art (no styles/) and ships the examples', !engFiles.some(f => f.startsWith('styles/')) && engFiles.some(f => f.startsWith('examples/')));
  check('the terrain generator is its own package (index.js, index.d.ts)', has(terrainPkg, 'index.js', 'index.d.ts'));
  check('tools tarball has the CLI and vite preset, no tests/',
    toolFiles.includes('bin/threedog.mjs') && toolFiles.includes('vite/gameConfig.js') && !toolFiles.some(f => f.startsWith('tests/')));
  // the `threedog` bin belongs to the engine package (it forwards to the tools CLI): without it `npx threedog init` fails after npm install threedog
  check('engine tarball ships the threedog bin (bin/threedog.mjs and package.json bin.threedog)', engFiles.includes('bin/threedog.mjs') && engPkg?.bin?.threedog === './bin/threedog.mjs');
  check('both tarballs carry LICENSE; the engine carries llms.txt', engFiles.includes('LICENSE') && toolFiles.includes('LICENSE') && engFiles.includes('llms.txt'),
    ['LICENSE', 'llms.txt'].filter(f => !engFiles.includes(f)).concat(toolFiles.includes('LICENSE') ? [] : ['tools LICENSE']).join(', '));
}
