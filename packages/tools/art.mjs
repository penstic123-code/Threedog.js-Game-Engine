// threedog art: reuse art code from another place by COPYING it into this game (no dependency, no link back).
//   threedog art list <source>                                   what the source offers: exported functions + the first JSDoc line
//   threedog art copy <source> [names...] [--to art/] [--force] [--dry]
//   threedog art board [-w game] [--out file.html] [--json] [--live] [--lib dir]   every art resource of this game on one page (art-board.mjs)
// <source>: another game folder (its art/ subfolder is used when it has one), any local folder or one file (./x, ../x, C:/x, /x), or an installed
//   package name (looked up in node_modules from here upward). names: a file ("tree", "tree.js", "props/well.js", "models/well.glb") or an exported
//   function name ("pine"); none = every module of the source.
// What is copied: the named modules, every local file they import (relative imports, followed transitively) and every texture / model file they name
//   by a string ('./bark.png', new URL('./bark.png', import.meta.url), or '/models/well.glb' served from the source game's public/ folder).
//   Files inside the source's art folder keep their layout under --to; local imports from outside it go to <to>/shared/; '/...' files go to this
//   game's public/ (same URL, so the string still works). Relative import strings are rewritten to the new layout; package imports are left as they
//   are and listed (install them if this game lacks them).
// Why copy and not depend: the art becomes the game's own. Editing a tree for this game never changes the game it came from, and an update in
//   the source never changes this game behind its back. There is no record of where it came from and no update command, on purpose.
// Why all-or-nothing: an existing file with different content stops the whole copy (nothing is written) unless --force; a half-copied set would
//   leave imports pointing at files that were not written. A file with the same content is skipped silently.
// The engine ships no art library and this command recommends none: the source is whatever you choose (your earlier games, your own folder, a
//   Blender export folder, files someone gave you, a package you trust). Plain equivalent: copy the files by hand and fix the import paths.
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, basename, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions } from './lib/cli-args.mjs';
import { walk } from './lib/text.mjs';
import { posix } from './paths.mjs';

const CODE = ['.js', '.mjs'];
const ASSET = /\.(png|jpe?g|webp|avif|gif|ktx2|basis|glb|gltf|bin|hdr|exr|svg|wav|mp3|ogg|m4a|woff2?|ttf|otf|json)$/i;
const MODEL = /\.(glb|gltf)$/i, TEXTURE = /\.(png|jpe?g|webp|avif|gif|ktx2|basis|hdr|exr|svg)$/i, SOUND = /\.(wav|mp3|ogg|m4a)$/i;
const isPathArg = s => /^\.{1,2}([\\/]|$)/.test(s) || isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s);
const dotRel = (from, to) => { const r = posix(relative(from, to)); return r.startsWith('.') ? r : './' + r; };

/** The folder of the nearest package.json at or above dir (a game root), or null */
export function gameRoot(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) { if (existsSync(join(d, 'package.json'))) return d; if (dirname(d) === d) return null; }
}

/** <source> → { root: the art folder (or the file's folder), files: [a single file] | null, game: the source game root (for '/...' URLs) } */
function resolveSource(source, cwd = process.cwd()) {
  if (!source) throw new Error('art: name a source: a game folder, a local folder or file, or an installed package');
  let p = null;
  if (isPathArg(source)) p = resolve(cwd, source);
  else for (let d = resolve(cwd); ; d = dirname(d)) {
    const c = join(d, 'node_modules', ...source.split('/'));
    if (existsSync(c)) { p = c; break; }
    if (dirname(d) === d) break;
  }
  if (!p || !existsSync(p)) throw new Error(`art: source "${source}" not found` + (isPathArg(source) ? '' : ' (not a path, and no node_modules/' + source + ' from here upward)'));
  if (statSync(p).isFile()) return { root: dirname(p), files: [p], game: gameRoot(dirname(p)) ?? dirname(p) };
  // a library entry (lib.mjs) is its own root: its files are laid out as they land in a game, even a folder inside it that is named art
  if (existsSync(join(p, 'entry.json'))) return { root: p, files: null, game: p };
  const art = join(p, 'art');
  const root = existsSync(art) && statSync(art).isDirectory() ? art : p;
  return { root, files: null, game: gameRoot(p) ?? p };
}

/** Every file of a pack, public/ and shots/ too (dependencies, build output and dot names left out) */
const packFiles = dir => walk(dir, { exts: /./, unscoped: true });

/** Exported functions of a module's text with the first line of the JSDoc above each: [{ name, doc, local? }]; a default export is named 'default', local its own name */
export function exportsOf(text) {
  // the doc body may not contain */ : a lazy [\s\S]*? would start at an earlier comment and run across code to the one right above the export
  const out = [], re = /(\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?export\s+(default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)?|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
  for (const m of text.matchAll(re)) {
    const doc = (m[2] ?? '').split('\n').map(l => l.replace(/^\s*\*?\s?/, '').trim()).find(l => l && !l.startsWith('@')) ?? '';
    out.push(m[3] ? { name: 'default', local: m[4], doc } : { name: m[4] ?? m[5], doc });
  }
  return out;
}

/** String references in a module: [{ spec, start, end }] (start / end = the spec's offsets in text, for rewriting) */
function refsOf(text) {
  const out = [], seen = new Set();
  const res = [/\bfrom\s*(['"])([^'"\n]+)\1/g, /\bimport\s*(['"])([^'"\n]+)\1/g, /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /(['"`])((?:\.{1,2}\/|\/)[^'"`\s$]+)\1/g];
  for (const re of res) for (const m of text.matchAll(re)) {
    const start = m.index + m[0].indexOf(m[1] + m[2]) + 1;
    if (seen.has(start)) continue;
    // the generic string pattern catches only asset files (import specifiers are caught by the first three, with or without an extension)
    if (re === res[3] && !ASSET.test(m[2])) continue;
    seen.add(start); out.push({ spec: m[2], start, end: start + m[2].length });
  }
  return out;
}

/** A relative module specifier → the file it means (tries .js, .mjs, /index.js), or null */
function resolveModule(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const c of [base, ...CODE.map(x => base + x), ...CODE.map(x => join(base, 'index' + x))]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** What the source offers: [{ file (relative to the source's art folder), exports: [{ name, doc }] }] plus asset files */
export function listArt(source, cwd) {
  const src = resolveSource(source, cwd), files = src.files ?? packFiles(src.root);
  const modules = [], assets = [];
  for (const f of files.sort()) {
    const r = posix(relative(src.root, f));
    if (CODE.includes(extname(f))) modules.push({ file: r, exports: exportsOf(readFileSync(f, 'utf8')) });
    else if (ASSET.test(f) && basename(f) !== 'package.json') assets.push(r);
  }
  return { root: src.root, modules, assets };
}

const LIST_SHOWN = 6;
/** The lines `art list` prints (CLI and MCP share them): by default the first few entries (modules, then assets) and how to see the rest; full lists everything. @param {ReturnType<typeof listArt>} r */
export function artListText(r, full, where, source) {
  const entries = [...r.modules.map(m => ({ m })), ...r.assets.map(a => ({ a }))], shown = full ? entries : entries.slice(0, LIST_SHOWN);
  const out = [`${where}: ${r.modules.length} module(s), ${r.assets.length} asset file(s)${shown.length < entries.length ? `; showing the first ${shown.length}` : ''}`];
  for (const { m, a } of shown) {
    if (!m) { out.push(`  ${a}`); continue; }
    out.push(`  ${m.file}`);
    for (const e of m.exports) out.push(`    ${e.name}${e.doc ? '  ' + e.doc : ''}`);
  }
  if (shown.length < entries.length) out.push(`${entries.length - shown.length} more: threedog art list ${source} --full`);
  return out;
}

/** Pick the files named on the command line (file path with or without extension, or an exported function name) */
function pick(src, names) {
  const all = src.files ?? packFiles(src.root), code = all.filter(f => CODE.includes(extname(f)));
  // a .glsl shader file is code a folder copy takes along too (a picture entry can be one)
  // a folder with no code at all (a Blender export) is its files
  if (!names.length) return src.files ?? (code.length ? [...code, ...all.filter(f => extname(f) === '.glsl')] : all);
  return names.map(n => {
    const want = posix(n).replace(/^\.\//, '');
    const byPath = all.find(f => { const r = posix(relative(src.root, f)); return r === want || r.replace(/\.(m?js)$/, '') === want || basename(f) === want || basename(f).replace(/\.(m?js)$/, '') === want; });
    if (byPath) return byPath;
    const byFn = code.find(f => exportsOf(readFileSync(f, 'utf8')).some(e => e.name === n || e.local === n));
    if (byFn) return byFn;
    throw new Error(`art: "${n}" is neither a file nor an exported function in ${src.root} (threedog art list <source> shows what is there)`);
  }).filter((f, i, a) => a.indexOf(f) === i);
}

/**
 * Plan and (unless dry) do a copy. Returns { writes: [{ from, to }], same, conflicts, packages, missing, register, picked } and writes nothing
 * when there is a conflict without force.
 * @param {string} source
 * @param {string[]} names
 * @param {{ to?: string, force?: boolean, dry?: boolean, cwd?: string }} [o]
 */
export function copyArt(source, names = [], { to = 'art', force = false, dry = false, cwd = process.cwd(), game: into } = {}) {
  // into: the destination root when it is not the game around cwd (lib add writes into a library entry folder)
  const src = resolveSource(source, cwd), game = into ? resolve(into) : gameRoot(cwd) ?? resolve(cwd);
  const dest = resolve(game, to), pub = join(game, 'public'), srcPub = join(src.game, 'public');
  const picked = pick(src, names);
  // where each source file goes: inside the art folder → same layout under dest; '/...' files → public/; other local files → dest/shared/
  const target = f => {
    if (f.startsWith(srcPub + sep)) return join(pub, relative(srcPub, f));
    if (f.startsWith(src.root + sep) || dirname(f) === src.root) return join(dest, relative(src.root, f));
    // a dependency above the source folder gives '../..' here; that would write outside the project, so each '..' level becomes a folder 'up' (levels stay distinct) and a drive prefix is dropped
    const rel = relative(dirname(src.root), f).split(/[\\/]/).filter(x => x && !/^[a-z]:$/i.test(x)).map(x => x === '..' ? 'up' : x);
    return join(dest, 'shared', ...rel);
  };
  const plan = new Map(), packages = new Set(), missing = [], queue = [...picked];
  while (queue.length) {
    const f = queue.shift();
    if (plan.has(f)) continue;
    if (!CODE.includes(extname(f))) {
      plan.set(f, { buf: readFileSync(f) });
      if (/\.gltf$/i.test(f)) {   // a .gltf names its .bin and textures by relative uri; they keep their place next to it
        try { const j = JSON.parse(readFileSync(f, 'utf8')); for (const x of [...(j.buffers ?? []), ...(j.images ?? [])]) if (x.uri && !/^data:|^[a-z]+:\/\//i.test(x.uri)) { const d = resolve(dirname(f), decodeURI(x.uri)); if (existsSync(d)) queue.push(d); else missing.push(`${x.uri} (named by ${basename(f)})`); } } catch { /* not JSON: copied as is */ }
      }
      continue;
    }
    const text = readFileSync(f, 'utf8'), edits = [];
    for (const r of refsOf(text)) {
      if (!r.spec.startsWith('.') && !r.spec.startsWith('/')) { if (/\s/.test(r.spec)) continue;   // `// from "The Book of Shaders"` is no package
        packages.add(r.spec.startsWith('@') ? r.spec.split('/').slice(0, 2).join('/') : r.spec.split('/')[0]); continue; }
      if (r.spec.startsWith('/')) {   // a URL served from the source game's public/ folder: copy it there, the string stays
        const d = join(srcPub, r.spec);
        if (existsSync(d) && statSync(d).isFile()) queue.push(d); else if (ASSET.test(r.spec)) missing.push(`${r.spec} (named by ${basename(f)})`);
        continue;
      }
      const d = ASSET.test(r.spec) && !CODE.includes(extname(r.spec)) ? (existsSync(resolve(dirname(f), r.spec)) ? resolve(dirname(f), r.spec) : null) : resolveModule(f, r.spec);
      if (!d) { missing.push(`${r.spec} (named by ${basename(f)})`); continue; }
      queue.push(d); edits.push({ ...r, file: d });
    }
    plan.set(f, { text, edits });
  }
  // rewrite each relative string to point from the new place to the new place (back to front so offsets stay valid)
  const writes = [], same = [], conflicts = [], landed = new Map();
  for (const [f, p] of plan) {
    let out = p.buf;
    if (!out) {
      let t = p.text;
      for (const e of [...p.edits].sort((a, b) => b.start - a.start)) t = t.slice(0, e.start) + dotRel(dirname(target(f)), target(e.file)) + t.slice(e.end);
      out = Buffer.from(t);
    }
    const to = target(f);
    // two different sources must never land on one target: the second would silently replace the first
    if (landed.has(to)) throw new Error(`art: ${landed.get(to)} and ${f} would both be copied to ${to}; copy them in separate runs or rename one`);
    landed.set(to, f);
    if (existsSync(to)) {
      if (readFileSync(to).equals(out)) { same.push(to); continue; }
      if (!force) { conflicts.push(to); continue; }
    }
    writes.push({ from: f, to, out });
  }
  // what to register: the picked modules' exported functions as manifest models (assets.manifest takes a generator function as a model), picked
  // model / texture / sound files by URL. Imports a picked module only uses internally need nothing.
  const fns = [], files = { models: [], textures: [], sounds: [] };
  for (const f of picked) {
    if (CODE.includes(extname(f))) { const ex = exportsOf(readFileSync(f, 'utf8')).map(e => e.name).filter(n => n !== 'default'); if (ex.length) fns.push({ path: dotRel(game, target(f)), names: ex }); continue; }
    const t = target(f), url = t.startsWith(pub + sep) ? '/' + posix(relative(pub, t)) : dotRel(game, t), key = basename(f).replace(/\.[^.]+$/, '').replace(/[^\w$]/g, '_');
    (MODEL.test(f) ? files.models : TEXTURE.test(f) ? files.textures : SOUND.test(f) ? files.sounds : []).push(`${key}: '${url}'`);
  }
  const register = [...fns.map(m => `import { ${m.names.join(', ')} } from '${m.path}';`)];
  const parts = [];
  const models = [...fns.flatMap(m => m.names), ...files.models];
  if (models.length) parts.push(`models: { ${models.join(', ')} }`);
  if (files.textures.length) parts.push(`textures: { ${files.textures.join(', ')} }`);
  if (files.sounds.length) parts.push(`sounds: { ${files.sounds.join(', ')} }`);
  if (parts.length) register.push(`engine.assets.manifest({ name: 'art', ${parts.join(', ')} });`);
  const result = { root: src.root, writes: writes.map(({ from, to }) => ({ from, to })), same, conflicts, packages: [...packages].sort(), missing, register, picked };
  if (dry || (conflicts.length && !force)) return result;
  for (const w of writes) { mkdirSync(dirname(w.to), { recursive: true }); writeFileSync(w.to, w.out); }
  return result;
}

async function cli(argv) {
  const [sub, ...rest] = argv;
  const usage = 'Usage: threedog art list <source> [--full] · threedog art copy <source> [names...] [--to art/] [--force] [--dry] · threedog art board [-w game] [--out file.html] [--json] [--live] [--lib dir]';
  const cwd = process.cwd(), show = p => posix(relative(cwd, p)) || '.';
  try {
    if (sub === 'board') return await (await import('./art-board.mjs')).boardCli(rest, cwd);   // imported here: it imports lib.mjs, which imports this file
    // one strict parse (lib/cli-args.mjs): `art list` takes --full, `art copy` --to / --force / --dry
    const { opt, rest: pos } = parseOptions(rest, sub === 'copy' ? { positional: true, flags: ['force', 'dry'], values: ['to'] } : { positional: true, flags: ['full'] });
    const flags = new Set(Object.keys(opt).map(k => '--' + k)), to = opt.to;
    if (sub === 'list') {
      const r = listArt(pos[0], cwd);
      console.log(artListText(r, flags.has('--full'), show(r.root), pos[0]).join('\n'));
      return 0;
    }
    if (sub === 'copy') {
      const [source, ...names] = pos;
      const r = copyArt(source, names, { to: to ?? 'art', force: flags.has('--force'), dry: flags.has('--dry'), cwd });
      if (r.conflicts.length && !flags.has('--force')) {
        console.error(`✗ nothing copied: ${r.conflicts.length} file(s) already exist with different content (--force overwrites them):`);
        for (const c of r.conflicts) console.error('  ' + show(c));
        return 1;
      }
      const verb = flags.has('--dry') ? 'would copy' : 'copied';
      console.log(`${verb} ${r.writes.length} file(s) from ${show(r.root)}${r.same.length ? ` (${r.same.length} already identical)` : ''}:`);
      for (const w of r.writes) console.log(`  ${show(w.to)}`);
      if (r.missing.length) console.log('Not found in the source (left as written, fix by hand):\n' + r.missing.map(m => '  ' + m).join('\n'));
      if (r.packages.length) console.log(`Package imports kept as they are (this game needs them installed): ${r.packages.join(', ')}`);
      if (r.register.length) console.log('Register (in the game code that sets up assets):\n' + r.register.map(l => '  ' + l).join('\n'));
      console.log('The copies are this game\'s own now: edit them freely; nothing links back to the source and nothing updates them.');
      return 0;
    }
    console.log(usage);
    return sub ? 1 : 0;
  } catch (e) { console.error('✗ ' + e.message); return 1; }
}

// exitCode, not exit(): a long --json on a Windows pipe would be cut off. No top-level await: lib.mjs imports this file while it waits for art-board.mjs
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) cli(process.argv.slice(2)).then(code => { process.exitCode = code; });
