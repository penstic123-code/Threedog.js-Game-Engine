// Shared by new-game and init: read the flags, copy the template layers, fill the placeholders.
//   templates/game       the base: a blank scene with a camera, empty content files, a gray picture/ folder (no gameplay, no genre assumed)
//   templates/openworld  an overlay for --open-world: generated terrain, day/night sky, follow camera, a player (a main.js only)
//   templates/sceneonly  an overlay for --scene-only: a main.js with no content/ and no assets.js (copyTemplates leaves those two out of the base): a showcase scene, nothing placed
//   templates/pixel      an overlay for --pixel: a sprite character in a pixel-snapped orthographic view, input, interaction, dialogue, saves (main.js + picture/sprites.js)
// Why blank by default: an open world is one genre among many (a puzzle, a card table, a side-scroller start from nothing), and a default that has
// to be deleted first steers every new game toward the same shape. Overlays are copied FIRST so their files win over the base.
// Which renderer: a new game starts on WebGPU, its shaders in TSL; --webgl starts on WebGLRenderer, its shaders in GLSL. It is chosen here, once, because it decides the
// language of the game's own shaders; plain three.js materials and lights work on both. createEngine's own default stays WebGL: the choice is written into each new
// game's main.js. A browser without WebGPU gets createEngine's fallback: 'webgl2', the same game on three's WebGL2 backend, TSL still drawing.
// Placeholders in text files: __NAME__, __GAMEPLAY_NOTE__, __DEFAULT_LAYER__ (rows of AI.md) and the ROUTE words below. The art always starts in the game's own gray picture/ folder (the engine ships no art).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TOOLS, ENGINE } from '../paths.mjs';
import { defaultLayer } from './default-layer.mjs';
import { parseOptions } from './cli-args.mjs';

/**
 * .mcp.json for Claude Code opened in the game folder: plain node on the tools' bin. A file already there keeps its other servers and a threedog entry of its own.
 * @param {string} file @param {string} bin @returns {'made' | 'kept' | 'broken'}  broken: not JSON, left alone for its owner to read
 */
export function writeMcp(file, bin) {
  let mcp = {};
  if (existsSync(file)) try { mcp = JSON.parse(readFileSync(file, 'utf8')); } catch { return 'broken'; }
  if (mcp.mcpServers?.threedog) return 'kept';
  writeFileSync(file, JSON.stringify({ ...mcp, mcpServers: { ...mcp.mcpServers, threedog: { command: 'node', args: [bin, 'mcp'] } } }, null, 2) + '\n');
  return 'made';
}

/**
 * A package name, and the saveKey of the game, from a folder name. Two games on one address share a browser's saves, so a folder whose letters are not ASCII gets a mark of
 * its own name: all of them used to become 'game', one save for every Chinese-named folder.
 * @param {string} folder
 */
export function gameName(folder) {
  const plain = folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/[^\0-\x7f]/.test(folder)) return plain || 'game';
  return `${plain || 'game'}-${createHash('sha1').update(folder).digest('hex').slice(0, 6)}`;
}

const GAMEPLAY = {
  clean: 'This game starts blank (a scene, a camera, a start screen, autosave, an Esc menu) and has no gameplay yet; build what DESIGN.md describes. `npx threedog init --open-world` in a new folder starts on generated ground with a player.',
  pixel: 'This game starts from `--pixel`: a gray floor, a placeholder sprite character in a pixel-snapped orthographic view (`pixelSize`, `pixelSprite`, `pixelSnap`), an NPC with dialogue, a pickup, a start screen, autosave and an Esc menu, no gameplay yet; build what DESIGN.md describes and replace the placeholder sprite sheet in picture/sprites.js with real art.',
  sceneOnly: 'This game starts from `--scene-only`: a scene, a camera, picture/, a start screen, autosave and an Esc menu; it has no `content/` and no `assets.js` (add them with `engine.use(content())` when something must be placed and saved); build what DESIGN.md describes.',
  openWorld: 'This game starts from `--open-world`: generated ground, a day/night sky, a follow camera, a player, a start screen, autosave and an Esc menu, no gameplay yet; build what DESIGN.md describes and remove what it does not need.',
};

// What differs by renderer inside shared template files. A __TSL_IMPORT__ line with nothing to say goes away whole.
const ROUTE = {
  webgpu: {
    __TSL_IMPORT__: "import 'threedog/tsl';   // first import: this game runs on WebGPU and writes shaders in TSL, recipe 56. A browser without WebGPU runs the same game on three's WebGL2 backend (slower); engine.describe().renderer says which and why",
    __RENDERER__: "renderer: 'webgpu', ",
    __PICTURE_ROUTE__: 'This game runs on WebGPU: shaders are TSL on node materials (recipe 56); GLSL (`ShaderMaterial`, `onBeforeCompile`) stops with an error naming it.\nWithout WebGPU the browser runs it on WebGL2, slower; `engine.describe().renderer` says which backend draws and why.',
    __MATERIAL_IMPORT__: "// Node materials take the same options as the plain ones. A shader here is TSL on a material's fields (colorNode, positionNode, emissiveNode...), recipe 56:\n// import { color, positionWorld, sin } from 'three/tsl'; material.colorNode = color(0x88aa66).mul(sin(positionWorld.y).mul(0.1).add(0.9));\nimport { MeshStandardNodeMaterial } from 'three/webgpu';",
    __STANDARD_MATERIAL__: 'MeshStandardNodeMaterial',
    __OWN_SHADER__: '`new THREE.*Material`, a node material with TSL, recipe 56',
    __OWN_POST__: 'own TSL effect (`engine.post.add({ name, slot, node })`, recipe 56)',
  },
  webgl: {
    __TSL_IMPORT__: '',
    __RENDERER__: '',
    __PICTURE_ROUTE__: 'This game runs on WebGL: shaders are GLSL (`ShaderMaterial`, `onBeforeCompile`).',
    __MATERIAL_IMPORT__: "import { THREE } from 'threedog';",
    __STANDARD_MATERIAL__: 'THREE.MeshStandardMaterial',
    __OWN_SHADER__: '`new THREE.*Material`, `ShaderMaterial`, `onBeforeCompile`',
    __OWN_POST__: 'own three.js passes / shader (`engine.post.add({ name, slot, create })`)',
  },
};

/** Read flags: --open-world, --pixel, --scene-only (one of them: one overlay), --webgl; the name is the first other argument. Unknown flags are an error (a typo
 *  silently making the wrong game is worse). env = process.env (npm eats flags: npm_config_* fallback) */
export function parseArgs(argv, env = {}) {
  let p;
  try { p = parseOptions(argv, { flags: ['open-world', 'pixel', 'scene-only', 'webgl'], positional: true }); } catch (e) { return { error: e.message }; }
  if (p.rest.length > 1) return { error: `one name or folder only, got ${p.rest.join(' ')}` };
  const openWorld = !!p.opt['open-world'] || env.npm_config_open_world === 'true';
  const pixel = !!p.opt.pixel || env.npm_config_pixel === 'true';
  const sceneOnly = !!p.opt['scene-only'] || env.npm_config_scene_only === 'true';
  if (openWorld + pixel + sceneOnly > 1) return { error: '--open-world, --pixel and --scene-only are different starting points: pick one' };
  const webgl = !!p.opt.webgl || env.npm_config_webgl === 'true';
  return { name: p.rest[0], openWorld, pixel, sceneOnly, webgl };
}

/** The "Already here" table: rows of the engine's AI.md (the one task table). Without the engine docs next to the tools: a pointer, not a stale copy */
function defaultLayerTable() {
  const f = join(ENGINE, 'docs', 'AI.md');
  return existsSync(f) ? defaultLayer(readFileSync(f, 'utf8')).table : 'Read `AI.md` in `node_modules/threedog/docs/` (one row per task).';
}

/** Fill the placeholders of one text file */
export function render(text, { name, openWorld, pixel, sceneOnly, webgl }) {
  const route = ROUTE[webgl ? 'webgl' : 'webgpu'];
  let out = text.replaceAll('__NAME__', name).replaceAll('__GAMEPLAY_NOTE__', GAMEPLAY[pixel ? 'pixel' : sceneOnly ? 'sceneOnly' : openWorld ? 'openWorld' : 'clean']);
  out = out.replace('__DEFAULT_LAYER__', () => defaultLayerTable());
  out = out.replace(/__TSL_IMPORT__\r?\n/g, route.__TSL_IMPORT__ && `${route.__TSL_IMPORT__}\n`);
  for (const [word, value] of Object.entries(route)) out = out.replaceAll(word, value);
  return out;
}

/** package.json dependencies: --open-world adds @threedog/terrain-noise (its main.js imports it; the blank base does not) */
export function applyDeps(deps, { openWorld }) {
  const out = { ...deps };
  if (openWorld) out['@threedog/terrain-noise'] ??= '^1.0.1';
  return out;
}

/** Copy the template layers (overlay first, base after) into dir. Existing files are kept (so the overlay wins and init never overwrites).
 *  skipPackage: leave package.json to the caller. Returns { made, kept }. */
export function copyTemplates(dir, opts, { skipPackage = false } = {}) {
  const layers = [...(opts.pixel ? ['pixel'] : opts.sceneOnly ? ['sceneonly'] : opts.openWorld ? ['openworld'] : []), 'game'], made = [], kept = [];
  // --scene-only: the base's content/ and assets.js are what main.js no longer imports, so they are not written at all
  const left = e => opts.sceneOnly && (e.name === 'assets.js' || (e.isDirectory() && e.name === 'content'));
  const walk = (from, to, top) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      // gitignore is stored without its dot: npm leaves a .gitignore out of a published package
      if (top && left(e)) continue;
      const src = join(from, e.name), dst = join(to, top && e.name === 'gitignore' ? '.gitignore' : e.name);
      if (e.isDirectory()) { walk(src, dst, false); continue; }
      if (skipPackage && top && e.name === 'package.json') continue;
      if (made.includes(dst)) continue;   // an overlay wrote it a moment ago: not something the folder already had
      if (existsSync(dst)) {
        // init into a folder that has its own .gitignore: the only edit is one line, so this machine's .threedog/ (perf baseline, shots, logs) is never committed
        if (top && e.name === 'gitignore' && !/^\/?\.threedog\/?\s*$/m.test(readFileSync(dst, 'utf8'))) appendFileSync(dst, (readFileSync(dst, 'utf8').endsWith('\n') ? '' : '\n') + '.threedog/\n');
        kept.push(dst); continue;
      }
      const text = render(readFileSync(src, 'utf8'), opts);
      writeFileSync(dst, text); made.push(dst);
      // AGENTS.md is the same rendered text as CLAUDE.md, for tools that do not read CLAUDE.md. Written only beside a CLAUDE.md made now,
      // and never over a file already there (init into a project that has its own AGENTS.md)
      const agents = join(to, 'AGENTS.md');
      if (top && e.name === 'CLAUDE.md' && !existsSync(agents)) { writeFileSync(agents, text); made.push(agents); }
    }
  };
  for (const l of layers) walk(join(TOOLS, 'templates', l), dir, true);
  return { made, kept };
}
