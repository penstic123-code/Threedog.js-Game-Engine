// Single source of every path. Rules, generators, the test runner, screenshots, perf and bake all read from here; do not hard-code paths elsewhere.
// Two layouts, picked by project(cwd):
//   monorepo  this repository: packages/engine/ (threedog), packages/tools/ (@threedog/tools), games/<name>/ (one workspace per game)
//   game      a game in its own repo that installed threedog + @threedog/tools from npm: the game folder is the root (plus games/* if it holds several)
// ENGINE is packages/engine in the monorepo (taken directly, so a worktree without node_modules never picks up another checkout's engine) and
// node_modules/threedog in a game (found with Node resolution, createRequire(...).resolve('threedog/package.json')).
// Convention: names ending in _REL are paths relative to ROOT, separated by / (shown in rules and generated docs); the rest are absolute paths.
import { existsSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, dirname, sep, resolve, basename } from 'node:path';
import { TOOLS, readJson, subdirs, project, within, norm } from './project.mjs';
import { parseOptions } from './lib/cli-args.mjs';
import { devServerInfo } from './devinfo.mjs';
export { TOOLS, project, within };

const PROJECT = project();
/** 'monorepo' or 'game' (see project()) */
export const MODE = PROJECT.mode;
export const ROOT = PROJECT.root;
/** A path with / separators (shown in rules, generated docs, urls) */
export const posix = p => p.split(sep).join('/');
/** Relative to ROOT, separated by / */
export const rel = p => posix(relative(ROOT, p));
/** Path relative to ROOT → absolute path */
export const abs = r => join(ROOT, r);
/** A path inside ROOT re-spelled from ROOT (same letter case as ROOT and workspaces()), so a c:\ cwd still equals the listed C:\ workspace */
const canon = p => { const a = resolve(p); return within(a, ROOT) ? join(ROOT, relative(ROOT, a)) : a; };
/** How generated game docs cite an engine file (node_modules/threedog/...) */
export const docRef = PROJECT.docRef;

// ── Engine package ──────────────────────────────────────
export const ENGINE = PROJECT.engineDir;
export const ENGINE_REL = rel(ENGINE);
/** Engine source directories (R2, R3, R10, R11, R14, R15, R39 etc. only scan these + index.js) */
export const ENGINE_CODE_DIRS_REL = ['core', 'modules', 'render', 'ui'].map(d => `${ENGINE_REL}/${d}`);
export const CORE_REL = `${ENGINE_REL}/core`;
export const MODULES_REL = `${ENGINE_REL}/modules`;
export const INDEX_JS_REL = `${ENGINE_REL}/index.js`;
export const INDEX_DTS_REL = `${ENGINE_REL}/index.d.ts`;
export const TYPES_REL = `${ENGINE_REL}/types`;
/**
 * Declarations generated from JSDoc in JS source (npm run map generates them, not edited by hand, committed to git); mirrors the engine source directory
 * layout: generated/ui/UI.d.ts ← ui/UI.js
 */
export const TYPES_GEN_REL = `${TYPES_REL}/generated`;
/** The generated facts about modules, sections and contracts (metadata.mjs) */
export const METADATA_REL = `${CORE_REL}/inspect/metadata.generated.js`;
/**
 * Source files already migrated to "JSDoc → generated d.ts" (relative to the repo root). To migrate a file: add a line here → write JSDoc in the source →
 * delete the matching declarations from the hand-written d.ts → npm run map.
 * The path must be inside the engine package (the generated output mirrors its directory layout).
 */
export const MIGRATED_JS_REL = [
  `${ENGINE_REL}/ui/UI.js`, `${ENGINE_REL}/ui/Focus.js`, `${ENGINE_REL}/ui/LoadingScreen.js`,
  `${ENGINE_REL}/render/lighting.js`, `${ENGINE_REL}/render/materials.js`, `${ENGINE_REL}/render/modeling.js`, `${ENGINE_REL}/render/occlusion.js`, `${ENGINE_REL}/render/patches.js`, `${ENGINE_REL}/render/PostFX.js`,
  `${ENGINE_REL}/modules/water/Water.js`, `${ENGINE_REL}/modules/calendar/Calendar.js`, `${ENGINE_REL}/modules/calendar/index.js`, `${ENGINE_REL}/modules/sky/Sky.js`, `${ENGINE_REL}/modules/sky/skyModule.js`, `${ENGINE_REL}/modules/weather/Weather.js`, `${ENGINE_REL}/modules/weather/weatherDraw.js`, `${ENGINE_REL}/modules/particles/Particles.js`, `${ENGINE_REL}/modules/swarm/Swarm.js`, `${ENGINE_REL}/modules/ambience/Ambience.js`, `${ENGINE_REL}/modules/music/Music.js`, `${ENGINE_REL}/modules/timeline/Timeline.js`, `${ENGINE_REL}/modules/debug/DebugPanel.js`, `${ENGINE_REL}/modules/hlod/index.js`, `${ENGINE_REL}/modules/lights/index.js`, `${ENGINE_REL}/modules/hud/index.js`, `${ENGINE_REL}/modules/flow/index.js`,
  `${ENGINE_REL}/modules/net/Net.js`, `${ENGINE_REL}/modules/net/index.js`, `${ENGINE_REL}/modules/net/transports.js`,
  `${ENGINE_REL}/modules/world/World.js`, `${ENGINE_REL}/modules/world/index.js`, `${ENGINE_REL}/modules/grid/index.js`, `${ENGINE_REL}/modules/grid/Grid.js`, `${ENGINE_REL}/modules/grid/Layer.js`,
  `${ENGINE_REL}/core/base/Random.js`, `${ENGINE_REL}/core/input/inputSeat.js`, `${ENGINE_REL}/core/threads/Commits.js`, `${ENGINE_REL}/core/threads/Threads.js`, `${ENGINE_REL}/core/ops/Ops.js`, `${ENGINE_REL}/core/scene/Views.js`, `${ENGINE_REL}/core/threads/Jobs.js`, `${ENGINE_REL}/core/base/Events.js`, `${ENGINE_REL}/core/stream/Stream.js`, `${ENGINE_REL}/core/stream/Batching.js`, `${ENGINE_REL}/core/scene/Rays.js`, `${ENGINE_REL}/core/inspect/DebugOverrides.js`, `${ENGINE_REL}/core/base/I18n.js`, `${ENGINE_REL}/core/audio/Audio.js`, `${ENGINE_REL}/core/audio/audioVoice.js`, `${ENGINE_REL}/core/input/Input.js`, `${ENGINE_REL}/core/saves/Saves.js`, `${ENGINE_REL}/core/saves/session.js`, `${ENGINE_REL}/core/engine/page.js`, `${ENGINE_REL}/core/inspect/Budget.js`,
  `${ENGINE_REL}/core/ops/control.js`,
];
// ── Optional add-on packages ───────────────────────
// Gameplay-side add-ons such as the terrain generator (world shape is not a picture, so it may not live in a style) and shared post effects:
// npm name `@threedog/<name>`, monorepo folder packages/<name>/ (one workspace each). Listed by name so rules scan them.
/** Add-on package names (without the @threedog/ scope) */
const ADDON_PKGS = ['terrain-noise', 'post-effects'];
/** Absolute folder of an add-on package (monorepo: packages/<name>; game mode: node_modules/@threedog/<name>) */
export const addonDir = name => MODE === 'monorepo' ? abs(`packages/${name}`) : join(abs('node_modules/@threedog'), name);
/** Add-on folders scanned as project source, relative to ROOT (game mode: the installed copies under node_modules/@threedog) */
export const ADDONS_REL = ADDON_PKGS.map(n => rel(addonDir(n)));
/** Entry file of an add-on import such as '@threedog/terrain-noise', null for anything else */
export const optionalEntry = spec => {
  const a = spec.startsWith('@threedog/') ? spec.slice('@threedog/'.length).split('/')[0] : null;
  return a && ADDON_PKGS.includes(a) ? join(addonDir(a), 'index.js') : null;
};
export const EXAMPLES_REL = `${ENGINE_REL}/examples`;
export const ENGINE_TESTS_REL = `${ENGINE_REL}/tests`;
export const DOCS_REL = `${ENGINE_REL}/docs`;
export const API_MD_REL = `${DOCS_REL}/API.md`;
export const API_DIR_REL = `${DOCS_REL}/api`;
export const CODEMAP_REL = `${DOCS_REL}/CODEMAP.md`;
export const RECIPES_REL = `${DOCS_REL}/recipes`;
export const EVENTS_GEN_REL = `${CORE_REL}/base/events.generated.js`;
export const CORE_DTS_REL = `${TYPES_REL}/core.d.ts`;
export const I18N_CORE_REL = `${CORE_REL}/base/I18n.js`;
export const CONTENT_RULES_REL = `${MODULES_REL}/content/rules.js`;
export const VEGETATION_REL = `${MODULES_REL}/vegetation/Vegetation.js`;
/** Content field tables (placement fields, template / kind fields): content-check validates entries with them */
export const CONTENT_FIELDS_REL = `${MODULES_REL}/content/fields.js`;
/** Content id rules (index ids, missingIds): read by `threedog content ids` */
export const CONTENT_IDS_REL = `${MODULES_REL}/content/ids.js`;
/** Template stages rules (Node-safe): content-check accepts the same stages the engine does */
export const CONTENT_STAGES_REL = `${MODULES_REL}/content/stages.js`;
export const BAKED_REL = `${CORE_REL}/assets/Baked.js`;
/** Package name games use to import the engine (the d.ts types hang on this package too) */
export const ENGINE_PKG = 'threedog';

// ── Tools package ───────────────────────────────────────
export const TOOLS_REL = rel(TOOLS);
export const RULES_REL = `${TOOLS_REL}/rules`;

// ── Games ───────────────────────────────────────────────
export const GAMES_REL = 'games';
export const GAMES = abs(GAMES_REL);

/** Folder names no scan descends into (dependencies, build output, caches, assets, screenshots); callers add 'tests' etc. when needed */
export const SKIP_DIRS = ['node_modules', 'dist', '.threedog', 'public', 'shots', '.git'];

/**
 * A game in its own repo (MODE 'game'): which files are the game's own sources. Everything else under the game folder is a dependency and is never
 * checked, typed or mapped as game code. Set in the game's package.json, paths relative to the game folder:
 *   "threedog": { "src": ["main.js", "src", "content"], "exclude": ["notes"] }
 * Defaults: src = the whole folder; always excluded: node_modules (SKIP_DIRS), vendor/, and every local-path dependency (file: / link: specs).
 */
const GAME_EXCLUDE_DEFAULT = ['vendor'];
function gameScope() {
  const pkg = readJson(join(ROOT, 'package.json')) ?? {}, cfg = pkg.threedog ?? {};
  const local = Object.values({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })
    .map(String).filter(v => /^(file|link):/.test(v)).map(v => resolve(ROOT, v.replace(/^(file|link):/, '')));
  return {
    src: (cfg.src ?? ['.']).map(p => resolve(ROOT, p)),
    exclude: [...GAME_EXCLUDE_DEFAULT, ...(cfg.exclude ?? [])].map(p => resolve(ROOT, p)).concat(local),
  };
}
let scope = null;
/** The game's source scope in game mode ({ src, exclude }, absolute paths); null in the monorepo */
export const gameSources = () => MODE === 'game' ? (scope ??= gameScope()) : null;
/**
 * Whether a walk that started at `start` should leave out the absolute path p (a file or folder): only in game mode, only for walks over the game
 * folder (a walk inside the engine package, wherever it is installed or vendored, is never filtered). A folder is kept while it contains or lies under
 * a src entry; a file must lie under one.
 */
export function notGameSource(p, start, isDir) {
  const s = gameSources();
  if (!s || within(resolve(start), ENGINE) || !within(resolve(p), ROOT)) return false;
  const a = resolve(p);
  if (s.exclude.some(x => within(a, x))) return true;
  return !s.src.some(x => within(a, x) || (isDir && within(x, a)));
}
/** Source scope scanned by rules, file size etc. (directories relative to the repo root) */
export const SOURCE_DIRS_REL = [...ENGINE_CODE_DIRS_REL, ...ADDONS_REL, EXAMPLES_REL, ENGINE_TESTS_REL, TOOLS_REL, GAMES_REL];
/** Game code (examples + games/*): only checked for direct new materials, type checking, key text, etc. */
export const GAME_CODE_DIRS_REL = [EXAMPLES_REL, GAMES_REL];
/** Generated docs and declarations (not edited by hand, exempt from size checks) */
export const GENERATED = [
  new RegExp(`^${DOCS_REL}/API\\.md$`), new RegExp(`^${API_DIR_REL}/`), new RegExp(`^${DOCS_REL}/CODEMAP\\.md$`), /\/GAMEMAP\.md$/,
  new RegExp(`^${TYPES_GEN_REL}/`), new RegExp(`^${ENGINE_REL}/llms\\.txt$`), new RegExp(`^${METADATA_REL}$`),
];

/** Every game folder (with a main.js), absolute paths (see project().gameDirs) */
export const gameDirs = PROJECT.gameDirs;

/**
 * Workspaces that can be bundled and tested on their own, absolute paths: monorepo = the engine package (examples, test pages) + each game; game mode = the
 * game folder(s)
 */
export const workspaces = () => MODE === 'monorepo'
  ? [ENGINE, ...subdirs(GAMES).filter(d => existsSync(join(d, 'package.json')))]
  : gameDirs().filter(d => existsSync(join(d, 'package.json')));

/** The workspace a folder belongs to (nearest package.json, not above ROOT; ROOT itself only in game mode); null if none */
export function workspaceOf(dir) {
  for (let d = canon(dir); within(d, ROOT); d = dirname(d)) {
    if ((d !== ROOT || MODE === 'game') && existsSync(join(d, 'package.json'))) return d;
    if (d === ROOT) break;
  }
  return null;
}

/**
 * Find a workspace by name: 'engine', 'my-farm', 'games/my-farm', the package name 'threedog', or an unambiguous part of a name ('farm').
 * null if not found; throws when a partial name matches several workspaces.
 */
export function findWorkspace(name) {
  if (!name) return null;
  const list = workspaces();
  const n = String(name).replace(/[\\/]$/, '');
  // a path from the current folder ('.', '../farm', an absolute path) names the workspace at that path: `check -w .` inside a game said "not found"
  const at = canon(n);
  const exact = list.find(d => d === at || rel(d) === n || basename(d) === n || '@threedog/' + basename(d) === n || (d === ENGINE && (n === 'engine' || n === ENGINE_PKG)));
  if (exact) return exact;
  const part = list.filter(d => basename(d).includes(n));
  if (part.length > 1) throw new Error(`workspace "${n}" is ambiguous, matches: ${part.map(rel).join(', ')}`);
  return part[0] ?? null;
}

/** A named workspace (findWorkspace) or an error that lists the available ones (and says when the name is a game folder of its own) */
function namedWorkspace(name) {
  const dir = findWorkspace(name);
  if (dir) return dir;
  // a game folder that is not one of this project's workspaces (e.g. a game kept outside games/ in the monorepo) is its own project: the command must run there
  const other = name && existsSync(join(resolve(name), 'package.json')) && project(resolve(name)).root !== ROOT;
  throw new Error(`workspace "${name}" not found. Available: ${workspaces().map(rel).join(', ')}` +
    (other ? `. "${name}" is a game folder of its own: cd ${name} and run the command there, without -w` : ''));
}

/**
 * The workspace a command operates on: the named one (-w) wins; otherwise the workspace of the current directory (with npm run xx -w games/a the
 * cwd is that one); otherwise the nearest folder upward with a live dev server; otherwise (with live) the one workspace whose dev server runs;
 * otherwise the fallback (the engine package by default).
 * @param {string | undefined} name @param {{ cwd?: string, fallback?: string | null, live?: boolean }} [o] @returns {string | null}
 */
export function workspaceFor(name, { cwd = process.cwd(), fallback = ENGINE, live = false } = {}) {
  if (name !== undefined) return namedWorkspace(name);
  const here = workspaceOf(cwd);
  if (here && workspaces().includes(here)) return here;
  // Not inside a known workspace (e.g. a game laid out differently): the nearest folder upward that has a running dev server's .threedog/dev.json
  // is the right one; falling straight back to the engine made the command talk to another game's server when several were running
  for (let d = canon(cwd); within(d, ROOT); d = dirname(d)) {
    if (devServerInfo(d).state === 'live') return d;
    if (d === ROOT) break;
  }
  // live (the dev bridge commands): at the repo root nothing above says which game is meant, but the running dev servers do. One -> that one;
  // several -> the caller must pick; falling back to the engine example said "no dev server is running" while a game's server was up
  if (live) {
    const up = workspaces().filter(w => devServerInfo(w).state === 'live');
    if (up.length === 1) return up[0];
    if (up.length > 1) throw new Error(`${up.length} dev servers are running (${up.map(rel).join(', ')}): pick one with -w, e.g. -w ${rel(up[0])}`);
  }
  return fallback;
}

/**
 * The project context of one command: its arguments parsed strictly (lib/cli-args.mjs parseOptions, spec as there) and the workspace it acts on.
 * Every command goes through here, so -w means the same everywhere and a typo fails; there used to be five readings of -w and three parsers.
 *   spec.workspace  'pick' (default): one workspace, workspaceFor() (spec.fallback, spec.live pass through)
 *                   'scope': a check scope: the named workspace, else the game workspace holding cwd (not the root or the engine), else null
 *                   'targets': every workspace, narrowed to the named one or the one holding cwd (test, the per-game generators)
 *                   false: the command takes no -w
 * Returns { dir, dirs, named, page, opt, rest }: dir the workspace (null for a repo-wide 'scope'), dirs the 'targets' list, named whether -w or
 * the current directory chose it. Throws with a one-line reason; cli() is the script-level form.
 * @param {string[]} argv @param {object} [spec]
 */
export function command(argv, { workspace = 'pick', fallback, live = false, ...spec } = {}) {
  const p = parseOptions(argv, { ...spec, workspace: workspace !== false });
  const name = p.workspace, all = workspaces();
  let dir = null, dirs = [], named = name !== undefined;
  if (workspace === 'pick') dir = workspaceFor(name, { fallback, live });
  else if (workspace === 'scope' || workspace === 'targets') {
    const here = workspaceOf(process.cwd());
    dir = named ? namedWorkspace(name) : here && all.includes(here) && (workspace === 'targets' || (here !== ROOT && here !== ENGINE)) ? here : null;
    named ||= !!dir;
    dirs = dir ? [dir] : all;
  }
  return { dir, dirs, named, page: p.page, pageArg: p.pageArg, opt: p.opt, rest: p.rest };
}

/** command() for a script's top level: prints `✗ <reason>` and exits 1 instead of a stack trace */
export function cli(argv, spec) {
  try { return command(argv, spec); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
}

/**
 * Whether the engine this project's games really import is the one the tools read. In a git worktree without its own node_modules, Node climbs
 * out to the main checkout's node_modules/threedog: vite then builds the games against the other copy while check reads this one, and nothing
 * says so. Returns null when they agree, else the problem and the fix (doctor and test refuse to go on).
 */
export function engineMismatch() {
  let found = null;
  try { found = realpathSync(dirname(createRequire(join(ROOT, 'package.json')).resolve(`${ENGINE_PKG}/package.json`))); } catch {}
  if (!found) return `${ENGINE_PKG} is not installed for ${ROOT}: run npm install there`;
  // the folder whose node_modules Node took it from: the first one at or above ROOT that has node_modules/threedog
  let from = ROOT;
  while (!existsSync(join(from, 'node_modules', ENGINE_PKG)) && dirname(from) !== from) from = dirname(from);
  const repo = gitTop(ROOT);
  if (MODE === 'monorepo' && norm(found) !== norm(ENGINE) || repo && !within(from, repo))
    return `games here import ${ENGINE_PKG} from ${found} (through ${join(from, 'node_modules')}), outside this project ${ROOT}: ` +
      `check and map read ${ENGINE} but builds and tests would run the other copy. Run npm install in ${ROOT} first`;
  return null;
}
/** The nearest folder at or above dir holding .git (a folder in a checkout, a file in a git worktree); null outside git */
function gitTop(dir) {
  for (let d = dir; ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return d; if (dirname(d) === d) return null; }
}

// ── Vite config ─────────────────────────────────────
// One answer for every command that starts vite (dev / build / preview through bin, test, shot, capture, perf, gallery, bake, doctor, pack):
// the folder's own config of any extension vite reads, else the threedog preset. They used to hard-code vite.config.js, so a game that ran
// with threedog dev (no config, or a .mjs one) failed to start under test / shot / gallery / bake.
const VITE_CONFIG_EXTS = ['js', 'mjs', 'ts', 'cjs', 'mts'];
/** The preset file for vite's CLI (bin's dev / build / preview spawn vite in the game folder; the preset roots itself at its cwd) */
export const VITE_DEFAULT_CONFIG = join(TOOLS, 'threedog', 'vite-default.config.mjs');
/** A folder's own vite config file (absolute), null when it has none */
export const ownViteConfig = dir => VITE_CONFIG_EXTS.map(x => join(dir, `vite.config.${x}`)).find(f => existsSync(f)) ?? null;
/**
 * Options for vite's JS API (build / createServer / preview) on a folder: { root, configFile: own } with `inline` on top (vite merges it with the
 * file), or, without an own config, the preset merged with `inline` and configFile: false. The preset is built for `dir` here: its config file
 * roots itself at process.cwd(), which in-process callers (the test runner at the repo root) do not share.
 */
export async function viteOptions(dir, inline = {}) {
  const own = ownViteConfig(dir);
  if (own) return { ...inline, root: dir, configFile: own };
  const [{ mergeConfig }, { gameConfig }] = await Promise.all([import('vite'), import('./vite/gameConfig.js')]);
  return { ...mergeConfig(gameConfig(dir), inline), root: dir, configFile: false };
}

/** Whether a file is under a directory (both as paths relative to the repo root) */
export const under = (file, dirRel) => file === dirRel || file.startsWith(dirRel + '/');
/**
 * A game's art code (a path relative to ROOT, / separated): the picture/, style/ and art/ folders, assets.js, art.js. Procedural models, textures and
 * hand-made three.js materials belong there (AI.md "Picture and sound"), so R1 does not warn about its size below the error limit.
 */
export const isArtFile = f => /(^|\/)(picture|style|art)\//.test(f) || /(^|\/)(assets|art)\.m?js$/.test(f);
/** Whether it is an existing file */
export const isFile = p => existsSync(p) && statSync(p).isFile();
