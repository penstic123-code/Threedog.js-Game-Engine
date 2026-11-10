// The reading part of content validation (used by packages/tools/content-check.mjs and gamemap.mjs): find game folders, read content/ data, find duplicate keys in one object, read the game's asset packs (assets.js).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, rel, abs, gameDirs, CONTENT_RULES_REL } from '../paths.mjs';
import { balanced, splitTop } from '../lib/text.mjs';
import { assetFiles } from '../lib/asset-url.mjs';
import { withDomStub } from './dom-stub.mjs';

// The engine's content vocabulary (path read from paths.mjs); content-check.mjs and gamemap.mjs also take mergeRules etc. from here
const rules = await import(pathToFileURL(abs(CONTENT_RULES_REL)).href);
export const { mergeRules, CLOCK_RE, describeCond, describeEffect, NO_GAME_EFFECTS, kindProblems, contentFiles, unknownContent } = rules;
export { ROOT, rel };

/** All game folders: those in packages/engine/examples/* and games/* that have a main.js (gameDirs in paths.mjs) */
export const findGames = gameDirs;

let loadSeq = 0;

/** Import one content file fresh: ?t= keeps a file rewritten during this process (content write checks before and after) out of the ESM cache */
export const importFresh = path => import(pathToFileURL(path).href + '?t=' + Date.now() + '-' + (++loadSeq));

/** The files of one content kind in load order: [path] for content/<kind>.js, the folder's *.js by file name for content/<kind>/ (index.js skipped) */
function kindParts(cdir, name) {
  const folder = join(cdir, name);
  if (existsSync(folder) && statSync(folder).isDirectory()) return readdirSync(folder).filter(f => f.endsWith('.js') && f !== 'index.js').sort().map(f => join(folder, f));
  return [join(cdir, name + '.js')];
}

/**
 * The names `export default { ... }` of content/index.js hands over, or null when it is not an object written out; spread = it also spreads something in.
 * shortcut: reads the source, not the module: index.js may use import.meta.glob (recipe 30), which only runs under vite. A computed export is not read.
 */
export function listedNames(dir) {
  const path = join(dir, 'content', 'index.js');
  if (!existsSync(path)) return null;
  // the whole object, nested values included: lib pull merges a system in as `items: { ...items, ...tide.items }`, and a spread inside a value hands over no name of its own.
  // comments are stripped from the object only: a glob string like './props/*.js' reads as the start of one
  const text = readFileSync(path, 'utf8'), at = [...text.matchAll(/export\s+default\s*\{/g)].at(-1);
  const body = at && balanced(text, '{', at.index);
  if (body == null) return null;
  const parts = splitTop(body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' '));
  return { names: new Set(parts.filter(p => !p.startsWith('...')).map(p => p.match(/^['"]?([\w$-]+)/)?.[1]).filter(Boolean)), spread: parts.some(p => p.startsWith('...')) };
}

/**
 * Read all content files of a game: { data: { items, … }, files: { items: path }, parts: { items: [{ path, from, count }] }, unread: [path], errors, warnings }
 * A kind is one file (content/props.js) or a folder (content/props/forest.js, town.js…: arrays joined, objects merged, in file-name order, the
 * order the runtime contentParts() joins them). files[kind] is the file or the folder; parts says which file holds which entries (from = index of
 * its first entry in the joined array), so a tool can go from "props[731]" to "content/props/town.js[31]". unread: the files that failed to load, which parts leaves out.
 */
export async function loadGame(dir) {
  const data = {}, files = {}, parts = {}, unread = [], errors = [], warnings = [], listed = listedNames(dir);
  const cdir = join(dir, 'content');
  if (!existsSync(cdir)) return { data, files, parts, unread, errors, warnings };
  // arrangements/ is read by `content stamp` only, never at runtime, so it is no content kind. rules.js first: its kinds decide which other names are known (the same contentFiles() the engine loader uses)
  const names = readdirSync(cdir).filter(f => f !== 'index.js' && (f.endsWith('.js') || statSync(join(cdir, f)).isDirectory()))
    .map(f => f.replace(/\.js$/, '')).filter((f, i, a) => a.indexOf(f) === i && f !== 'arrangements').sort((a, b) => (b === 'rules') - (a === 'rules'));
  for (const name of names) {
    const folder = join(cdir, name), isFolder = existsSync(folder) && statSync(folder).isDirectory();
    if (isFolder && existsSync(folder + '.js')) { errors.push(`${rel(folder)}: both content/${name}.js and the folder content/${name}/ exist: keep one (move the file into the folder)`); continue; }
    if (!contentFiles(data.rules)[name]) {
      const at = rel(isFolder ? folder : folder + '.js');
      // index.js is what the page loads: a name it leaves out never reaches the loader, so it is the game's own file, not a broken one
      if (listed && !listed.spread && !listed.names.has(name)) warnings.push(`${at}: content/index.js does not load it and it is no content kind, so the engine never reads it: move a game's own data out of content/ (recipe 20), or register a kind in content/rules.js`);
      else errors.push(`${at}: ${unknownContent(name, data.rules)}`);
      continue;
    }
    const list = [];
    for (const path of kindParts(cdir, name)) {
      try { list.push({ path, mod: await importFresh(path) }); }
      catch (err) { unread.push(path); errors.push(`${rel(path)}: the file cannot be loaded (most likely a syntax error, such as a missing comma or bracket): ${err.message}`); }
    }
    if (!list.length) continue;
    files[name] = isFolder ? folder : list[0].path;
    if (!isFolder) {
      const { path, mod } = list[0], d = mod.default;
      data[name] = d; parts[name] = [{ path, from: 0, count: Array.isArray(d) ? d.length : Object.keys(d || {}).length }];
      if (mod.startItems) { data.startItems = mod.startItems; files.startItems = path; }
      continue;
    }
    // A folder: every part must have the same shape; object keys may not repeat across files (a merge would silently drop one, as a duplicate key does)
    const arrays = list.filter(p => Array.isArray(p.mod.default)).length;
    if (arrays && arrays !== list.length) { errors.push(`${rel(folder)}: some files export an array and some an object; every file of one kind exports the same shape`); continue; }
    let joined = arrays ? [] : {};
    const owner = new Map();
    parts[name] = [];
    for (const { path, mod } of list) {
      const d = mod.default ?? (arrays ? [] : {});
      parts[name].push({ path, from: arrays ? joined.length : 0, count: arrays ? d.length : Object.keys(d).length });
      if (arrays) { joined = joined.concat(d); continue; }
      for (const k of Object.keys(d)) {
        if (owner.has(k)) errors.push(`${rel(path)}: "${k}" is also defined in ${rel(owner.get(k))}; an id must be unique across the files of content/${name}/`);
        else owner.set(k, path);
      }
      joined = { ...joined, ...d };
    }
    data[name] = joined;
  }
  return { data, files, parts, unread, errors, warnings };
}

/** Which file holds entry `index` of a joined array kind: { path, index (in that file) } or null */
export function partOf(parts, name, index) {
  const p = (parts[name] || []).find(x => index >= x.from && index < x.from + x.count);
  return p ? { path: p.path, index: index - p.from } : null;
}

// Two identical keys in one object (JS silently lets the later one overwrite, so they must be found in the source)
export function dupKeys(src) {
  const out = [], stack = [];
  let i = 0, line = 1, last = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i) + 2; line += src.slice(i, j).split('\n').length - 1; i = j; continue; }
    const top = stack[stack.length - 1];
    if (top?.keys && (last === '{' || last === ',')) {
      const m = /^(?:([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)|'([^'\\]*)'|"([^"\\]*)")\s*:/.exec(src.slice(i, i + 200));
      if (m) {
        const k = m[1] ?? m[2] ?? m[3];
        if (top.keys.has(k)) out.push({ key: k, line, first: top.keys.get(k) }); else top.keys.set(k, line);
        i += m[0].length; last = ':'; continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j++; if (src[j] === '\n') line++; j++; }
      i = j + 1; last = 'v'; continue;
    }
    if (ch === '{') stack.push({ keys: new Map() });
    else if (ch === '[' || ch === '(') stack.push({});
    else if ('}])'.includes(ch)) stack.pop();
    last = ch; i++;
  }
  return out;
}

/**
 * The asset names a game registers, read from the asset pack objects themselves (not from scanning source text): <game>/assets.js exports the
 * packs main.js hands to engine.assets.manifest (export default one pack or a list), so the runtime and this check read the same objects.
 * Returns { file, models, textures, sounds, error }: file = the assets.js path (null when the game has none), the rest Sets of names,
 * error = why assets.js could not be imported (the names are then empty).
 */
export async function gameAssets(dir) {
  const file = join(dir, 'assets.js'), out = { file: existsSync(file) ? file : null, models: new Set(), textures: new Set(), sounds: new Set(), packs: [], error: null };
  if (!out.file) return out;
  let packs;
  // under no-op browser stand-ins: module-top canvas textures / materials (recipe 05) load in Node; only the names are read (dom-stub.mjs)
  try { packs = (await withDomStub(() => importFresh(file))).default; }
  catch (err) { out.error = `${rel(file)}: the file cannot be loaded: ${err.message}` + (/is not defined/.test(err.message) ? '. The check imports '
    + 'assets.js (and the files it imports) in Node to read the asset names; drawing and DOM calls run as no-ops there, other browser-only work '
    + 'at module top (loading a file, a font) does not: move it into the generator, or a texture function textures: { name: () => make() } '
    + '(runs on first use in the browser)' : ''); return out; }
  out.packs = [packs].flat();
  for (const pack of out.packs) for (const kind of ['models', 'textures', 'sounds']) for (const k of Object.keys(pack?.[kind] || {})) out[kind].add(k);
  return out;
}

/**
 * Files the asset packs name that the project does not have. Why check says so: a pack naming a missing file passes the build too, and the game shows "load failed" to the player.
 * A local path is what the dev server and the build serve from public/; a remote url or inline data has a scheme, and a generator is no path: neither is ours to find.
 * Only the entry the game will load counts: the later pack wins a name, as in the engine, so an original replaced by the optimized pack needs no file.
 * @param {string} dir @param {{ packs: any[] }} assets @returns {string[]}
 */
export function missingAssetFiles(dir, assets) {
  const out = [], winners = new Map();
  for (const pack of assets.packs) for (const kind of ['models', 'textures', 'sounds']) for (const [name, entry] of Object.entries(pack?.[kind] || {})) winners.set(`${kind}/${name}`, { kind, name, entry, base: pack.base });
  for (const { kind, name, entry, base } of winners.values()) {
    const f = assetFiles(dir, typeof entry === 'string' ? entry : entry?.url, base);   // null: remote / inline / a generator
    if (f && !existsSync(f.served)) out.push(`assets.js: ${kind} "${name}" names ${f.path}, which is not in public/: put the file there or fix the path`);
  }
  return out;
}

/** The level is a file (level({ url })): its markers are inside the .glb and cannot be read statically */
export const levelIsFile = code => /\blevel\(\s*\{[^}]*\burl\s*:/.test(code);
