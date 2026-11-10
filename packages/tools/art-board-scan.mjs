// The scan behind `threedog art board`: every art resource of one game, read from the game's own files only (assets.js, public/, art/, picture/, content/,
// code), never from anything the engine owns, so it means the same thing in any game.
// One rule decides every status, because a check must not lie:
//   used        at least one reference whose meaning is certain (a path that resolves, a name in a model / sound / texture slot, a material variable)
//   not-traced  no certain reference, but something could reach it: a name built at run time, or the same text in a place that may mean something else
//   unused      no reference of any kind and nothing that could reach it
//   missing     named or pointed at, and it does not exist
// When in doubt the answer is not-traced: a false "maybe" costs one line of reading, a false "nobody uses this" gets art deleted.
import { existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, extname, posix as pp, resolve } from 'node:path';
import { read, walk, balanced, splitTop, esc, noComments } from './lib/text.mjs';
import { posix } from './paths.mjs';
import { assetFiles } from './lib/asset-url.mjs';
import { gameAssets } from './content-check/load.mjs';
import { fileStems } from './gallery/index.js';
import { readLibrary } from './lib.mjs';
import { changeWords, pullStatus } from './lib/lib-records.mjs';

const KIND_OF = [[/\.(glb|gltf)$/i, 'model'], [/\.(png|jpe?g|webp|avif|gif|ktx2|basis|hdr|exr|svg)$/i, 'texture'], [/\.(wav|mp3|ogg|m4a)$/i, 'sound'],
  [/\.(woff2?|ttf|otf)$/i, 'font'], [/\.(glsl|vert|frag|wgsl)$/i, 'shader']];
const ART_FILE = new RegExp(KIND_OF.map(([re]) => re.source).join('|'), 'i');
const SHOWABLE = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
const PACK_KEYS = [['models', 'model'], ['textures', 'texture'], ['sounds', 'sound'], ['fonts', 'font']];
const KINDS = ['model', 'texture', 'sound', 'font', 'material', 'shader', 'library'];
const kindOf = f => KIND_OF.find(([re]) => re.test(f))?.[1] ?? null;
const bare = v => v.replace(/[?#].*$/, '');
// tmp/ and docs/ hold scratch and reference pictures, not the game's art
const NOT_ART = ['tmp', 'docs'];
// The engine modules' own sounds (builtInSounds calls in packages/engine/modules): they exist with no manifest entry, so naming one is not "missing".
// The test reads the engine source and fails when this list falls behind.
export const BUILT_IN_SOUNDS = ['footstep', 'shutter', 'thunder', 'wind', 'rain', 'water', 'birds', 'crickets'];

// The slots whose text names an asset for certain. A dotted call on any object on purpose: `const a = engine.assets; a.model(x)` must count too.
const SLOTS = [
  [/\.(?:model|modelNow|geometry)\(\s*\[?\s*$/, 'model'], [/\.(?:texture|useTexture)\(\s*$/, 'texture'], [/\.sfx\(\s*$/, 'sound'], [/\.font\(\s*$/, 'font'],
  [/['"]?\b(?:model|models)['"]?\s*:\s*\[?\s*(?:['"][\w.-]*['"]\s*,\s*)*$/, 'model'], [/['"]?\b(?:sound|src)['"]?\s*:\s*\[?\s*(?:['"][\w.-]*['"]\s*,\s*)*$/, 'sound'],
];
const CALL_KIND = { model: 'model', modelNow: 'model', geometry: 'model', texture: 'texture', useTexture: 'texture', font: 'font', sfx: 'sound' };
const DYNAMIC = [
  [/\.(model|modelNow|geometry|texture|useTexture|font|sfx)\(\s*(?!['"`[\s)])([A-Za-z_$][\w$.[\]]*)/g, m => CALL_KIND[m[1]]],
  [/['"]?\b(model|sound)['"]?\s*:\s*(?!null\b|undefined\b|true\b|false\b)([A-Za-z_$][\w$.[\]]*)/g, m => m[1]],
  [/[{,]\s*(model|sound)\s*[,}]/g, m => m[1]],
  [/\b\w*materials?\??\.?\[\s*(?!['"`\d])([^\]]+)\]/gi, () => 'material'],
];
const MAKE = /\bnew\s+(?:[A-Za-z_$][\w$]*\.)?([A-Z]\w*Material|CanvasTexture|DataTexture)\s*\(/g;
// `{ material: new X() }` hands the thing over on the spot; a key like `grass:` names a table entry someone reads later
const SLOT_KEY = /^(material|materials|map|normalMap|roughnessMap|metalnessMap|alphaMap|emissiveMap|envMap|aoMap|bumpMap|lightMap|texture)$/;

function source(dir, f) {
  const raw = read(f), rel = posix(relative(dir, f)), js = /\.m?js$/.test(f), text = js ? noComments(raw) : raw, starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const line = i => { let a = 0, b = starts.length - 1; while (a < b) { const m = (a + b + 1) >> 1; if (starts[m] <= i) a = m; else b = m - 1; } return a + 1; };
  return { rel, js, text, line, at: i => `${rel}:${line(i)}` };
}

/** A written pattern ('/models/tree${i}.glb', './tex/*.png') as a regex over the file path or name it can become (any folder prefix: './' is relative) */
const patternOf = s => new RegExp('(?:^|/)' + s.replace(/^(?:\.{0,2}\/)+/, '').split(/\$\{[^}]*\}|\*+/).map(esc).join('.*') + '$', 'i');

/** Where a written path lands in the game folder: candidates relative to it, or null for a URL */
function candidates(value, fromRel) {
  const v = bare(value);
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(v)) return null;
  if (v.startsWith('/')) return ['public' + v, v.slice(1)];
  return [pp.normalize(pp.join(pp.dirname(fromRel), v)), pp.normalize('public/' + v), ...(v.startsWith('.') ? [] : [pp.normalize(v)])];   // art/x.png written from a deep file means the game's folder
}

class Board {
  constructor(dir) { this.dir = dir; this.items = []; this.byFile = new Map(); this.named = new Map(); this.dynamic = []; this.problems = []; this.registered = new Set(); this.manifestFiles = new Set(); }
  add({ kind, name, file = null, size = null, extra }) {
    const it = { kind, name: this.free(kind, name), file, size, status: 'unused', uses: [], maybe: [], ...extra };
    this.items.push(it); this.named.set(`${kind}:${it.name}`, it);
    return it;
  }
  /** A short name unique in its kind: the first keeps it, later ones take a number, so a name stays put when lines move */
  free(kind, name) {
    if (!this.named.has(`${kind}:${name}`)) return name;
    for (let i = 2; ; i++) if (!this.named.has(`${kind}:${name}-${i}`)) return `${name}-${i}`;
  }
  get(kind, name) { return this.named.get(`${kind}:${name}`); }
}

function scanFiles(b) {
  // walk() skips public/ below the folder it starts from, so that folder is walked on its own, and first: art/models looks for its built file there
  const files = [...walk(join(b.dir, 'public'), { exts: ART_FILE }), ...walk(b.dir, { exts: ART_FILE, skip: NOT_ART })];
  for (const f of files) {
    const rel = posix(relative(b.dir, f));
    // art/models/x.glb is the source of public/optimized/x.glb (threedog assets optimize): one resource with two files, not two with one "unused"
    const built = rel.startsWith('art/models/') ? 'public/optimized/' + rel.slice('art/models/'.length) : null;
    if (built && b.byFile.has(built)) { const it = b.byFile.get(built); it.source = rel; b.byFile.set(rel, it); continue; }   // a path to either file finds it
    const it = b.add({ kind: kindOf(rel), name: basename(rel, extname(rel)), file: rel, size: statSync(f).size });
    b.byFile.set(rel, it);
    if (it.kind === 'shader') it.preview = { type: 'code', text: read(f).split('\n').slice(0, 12).join('\n') };
    else if (SHOWABLE.test(rel)) it.preview = { type: 'image', file: rel };
    else if (it.kind === 'sound') it.preview = { type: 'audio', file: rel };
  }
  for (const rel of [...b.byFile.keys()].filter(r => /\.gltf$/i.test(r))) gltfParts(b, rel);
}

/** A .gltf names its own images and buffers: those are used by the model, whoever else does or does not name them */
function gltfParts(b, rel) {
  try {
    const j = JSON.parse(read(join(b.dir, rel)));
    for (const u of [...(j.images ?? []), ...(j.buffers ?? [])].map(x => x.uri).filter(u => u && !u.startsWith('data:'))) {
      b.byFile.get(pp.normalize(pp.join(pp.dirname(rel), decodeURI(u))))?.uses.push({ at: rel, how: 'part of the model' });
    }
  } catch { b.problems.push(`${rel}: not valid JSON, its textures cannot be followed`); }
}

/** One manifest entry onto the board: a file it points at takes this name, a file that is not there is a problem */
function register(b, kind, name, value, base, defAt) {
  const url = typeof value === 'string' ? value : value?.url ?? null;
  if (!url) return b.add({ kind, name, file: defAt, extra: { made: 'code', defAt } });
  b.registered.add(url);
  // the one url -> file rule (lib/asset-url.mjs, the same as content check and assets check): a manifest url is a file of public/, never of the game root
  const served = assetFiles(b.dir, url, base);
  if (!served) return b.add({ kind, name, file: url, extra: { remote: true, defAt } });
  const hit = 'public' + served.path, it = b.byFile.get(hit);
  if (!it) return b.add({ kind, name, file: hit, extra: { defAt, problem: 'file not found' } });
  if (it.defAt) return b.add({ kind, name, file: hit, size: it.size, extra: { defAt, preview: it.preview } });   // two names, one file
  b.named.delete(`${it.kind}:${it.name}`);
  it.name = b.free(kind, name); it.kind = kind; it.defAt = defAt;
  b.named.set(`${kind}:${it.name}`, it);
  return it;
}

const defLine = (src, name, from = 0) => {
  const m = new RegExp(`(?:^|[\\s{,])['"]?${esc(name)}['"]?\\s*:`, 'm').exec(src.text.slice(from));
  return m ? src.at(from + m.index + m[0].indexOf(name)) : src.rel;
};

/** assets.js through the check's own loader (the objects the game registers), then manifests written straight in code */
async function scanManifests(b, sources) {
  const assets = await gameAssets(b.dir), file = sources.find(s => s.rel === 'assets.js');
  if (assets.error) b.problems.push(assets.error);
  if (file) b.manifestFiles.add(file.rel);
  for (const pack of assets.packs) for (const [key, kind] of PACK_KEYS) {
    for (const [name, v] of Object.entries(pack?.[key] ?? {})) register(b, kind, name, v, pack.base, file ? defLine(file, name) : 'assets.js');
  }
  for (const s of sources) for (const m of s.text.matchAll(/\.manifest\(\s*\{/g)) {
    b.manifestFiles.add(s.rel);
    const body = balanced(s.text, '{', m.index) ?? '';
    for (const [key, kind] of PACK_KEYS) {
      const k = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(body);
      for (const part of k ? splitTop(balanced(body, '{', k.index) ?? '') : []) {
        const e = !part.startsWith('...') && /^['"]?([\w.-]+)['"]?(?:\s*:\s*(?:(['"`])([^'"`]*)\2)?)?/.exec(part);
        if (e && !b.get(kind, e[1])) register(b, kind, e[1], e[3] ?? null, null, defLine(s, e[1], m.index));
      }
    }
  }
}

/** Materials, shader materials and canvas / data textures made in code: one item per place that makes one */
function scanMade(b, sources) {
  const made = [];
  for (const s of sources.filter(x => x.js)) {
    const count = {}, stem = basename(s.rel, extname(s.rel));
    for (const m of s.text.matchAll(MAKE)) {
      const cls = m[1], before = s.text.slice(s.text.lastIndexOf('\n', m.index) + 1, m.index), args = balanced(s.text, '(', m.index) ?? '';
      const v = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)?.[1];
      const keyed = /(?:^|[\s{,(])['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*$/.exec(before)?.[1] ?? /\bthis\.(\w+)\s*=\s*$/.exec(before)?.[1];
      const key = keyed && !SLOT_KEY.test(keyed) ? keyed : undefined;
      const given = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1] ?? (v && new RegExp(`\\b${esc(v)}\\.name\\s*=\\s*['"]([^'"]+)['"]`).exec(s.text)?.[1]);
      const color = /\bcolor\s*:\s*(?:0x([0-9a-f]{6})\b|['"]#([0-9a-f]{3,6})['"])/i.exec(args);
      count[cls] = (count[cls] ?? 0) + 1;
      const it = b.add({ kind: /Shader/.test(cls) ? 'shader' : /Texture/.test(cls) ? 'texture' : 'material', name: given ?? v ?? key ?? `${stem === 'index' ? basename(dirname(s.rel)) : stem}-${cls}-${count[cls]}`,
        file: s.at(m.index), extra: { made: 'code', class: cls, ...(color && { preview: { type: 'color', value: '#' + (color[1] ?? color[2]) } }) } });
      made.push({ it, s, index: m.index, v, key });
      if (!v && !key) it.uses.push({ at: s.at(m.index), how: 'made in place' });   // handed straight to whatever it sits in
    }
  }
  for (const { it, s, index, v, key } of made) {
    // only the declaration is skipped, not its line: `const m = new X(), a = new Mesh(g, m);` uses m right there
    const isDef = (m, len) => m.index < index && /^['"]?\s*[:=]\s*$/.test(s.text.slice(m.index + len, index));
    if (v) {
      // shortcut: scope is not followed, so two `mat` variables in one file see each other's uses; a parser is the upgrade if that ever hides art
      for (const m of s.text.matchAll(new RegExp(`(?<![\\w$.])${esc(v)}\\b`, 'g'))) if (!isDef(m, v.length)) it.uses.push({ at: s.at(m.index), how: 'variable' });
      for (const o of sources) if (o !== s) for (const m of o.text.matchAll(new RegExp(`\\bimport\\b[^;]*\\b${esc(v)}\\b[^;]*from`, 'g'))) it.uses.push({ at: o.at(m.index), how: 'imported' });
    } else if (key) {
      // a table entry: `materials.grass` is certain; `.grass` or 'grass' alone can be any other field with that name
      it.keyed = true;
      for (const o of sources) for (const m of o.text.matchAll(new RegExp(`(\\b\\w*(?:materials?|mats?|shaders?|textures?)\\??\\.|this\\.|\\.|['"])${esc(key)}\\b`, 'gi'))) {
        if (o === s && isDef(m, m[0].length)) continue;
        (/^\.|^['"]/.test(m[1]) ? it.maybe : it.uses).push({ at: o.at(m.index), how: 'by key' });
      }
    }
  }
}

/** Everything that names art: paths, names in a slot, plain text equal to a name, and what is built at run time */
function scanRefs(b, sources) {
  const names = new Map();
  for (const it of b.items) if (it.defAt) names.set(it.name, [...(names.get(it.name) ?? []), it]);
  const gone = new Map();
  const missing = (kind, name, file, at, how) => {
    const key = `${kind}:${file ?? name}`;
    if (!gone.has(key)) gone.set(key, b.add({ kind, name, file, extra: { problem: file ? 'file not found' : 'name not registered' } }));
    gone.get(key).uses.push({ at, how });
  };
  // a game may have its own sfx() or texture(): a call to that says nothing about the asset list, unless it is written on engine.* itself
  const own = new Map(), hasOwn = fn => {
    const re = new RegExp(`\\bfunction\\s+${fn}\\b|(?:^|[\\s{,])(?:async\\s+)?${fn}\\s*(?:\\([^)]*\\)\\s*\\{|[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>))`, 'm');
    if (!own.has(fn)) own.set(fn, sources.some(s => s.js && re.test(s.text)));
    return own.get(fn);
  };
  const soundNames = new Set(BUILT_IN_SOUNDS);
  for (const s of sources) if (/audio/.test(basename(s.rel))) {   // content audio.sounds: { door: { src: 'door' } } gives a name the game plays
    const i = s.text.search(/\bsounds\s*:\s*\{/), body = i >= 0 ? balanced(s.text, '{', i) : null;
    for (const part of body ? splitTop(body) : []) {
      const k = /^['"]?([\w.-]+)['"]?\s*:/.exec(part)?.[1];
      if (!k) continue;
      soundNames.add(k);
      for (const it of names.get(k) ?? []) if (it.kind === 'sound') it.uses.push({ at: defLine(s, k, i), how: 'audio.sounds' });
    }
  }
  for (const s of sources) {
    const re = s.js ? /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\[\s\S]|[^`\\])*)`/g : /["'(]([^"'()\s]+\.\w+)["')]/g;
    for (const m of s.text.matchAll(re)) {
      const value = m[1] ?? m[2] ?? m[3];
      if (!value || value.length > 200 || value.includes('\n')) continue;   // long templates are shader or UI text, not a name
      const at = s.at(m.index), before = s.text.slice(Math.max(0, m.index - 80), m.index).split('\n').pop();
      const call = /\.(\w+)\(\s*\[?\s*$/.exec(before)?.[1], theirs = call && !/\bengine\.\w+\.\w+\(\s*\[?\s*$/.test(before) && hasOwn(call);
      const slot = theirs ? undefined : SLOTS.find(([r]) => r.test(before))?.[1], built = /\$\{|\*/.test(value), path = bare(value);
      if (ART_FILE.test(path)) {
        if (built) { b.dynamic.push({ at, text: value, re: patternOf(path) }); continue; }
        if (b.registered.has(value) && b.manifestFiles.has(s.rel)) continue;   // the manifest line registers the file, it does not use it
        const places = candidates(value, s.rel);
        if (!places) continue;
        const hit = places.find(p => b.byFile.has(p));
        if (hit) b.byFile.get(hit).uses.push({ at, how: 'path' });
        else if (value.includes('/')) missing(kindOf(path), basename(path, extname(path)), places[0], at, 'path');
        continue;
      }
      if (built) { if (slot) b.dynamic.push({ at, text: value, kind: slot, re: patternOf(value), named: true }); continue; }
      const found = names.get(value), fit = found?.find(it => it.kind === slot);
      if (fit) fit.uses.push({ at, how: 'name' });
      else if (found) { for (const it of found) if (it.defAt !== at) it.maybe.push({ at, how: 'same text' }); }
      else if (slot && /^[\w.-]+$/.test(value) && !b.get(slot, value)) {
        // src: is a sound only inside audio content, and a built-in or audio.sounds name exists with no manifest entry
        if (slot !== 'sound' || (!soundNames.has(value) && !/\bsrc['"]?\s*:/.test(before))) missing(slot, value, null, at, 'name');
      }
    }
    // a folder joined with a name at run time: '/models/' + name + '.glb'
    for (const m of s.text.matchAll(/(['"`])([^'"`\n]*\/)\1\s*\+/g)) b.dynamic.push({ at: s.at(m.index), text: m[2] + '…', re: new RegExp('(?:^|/)' + esc(m[2].replace(/^\.{0,2}\//, '')), 'i') });
    // the folder held in a variable: dir + name + '.png'. A folder written out ('/decals/' + name + '.png') is the narrower rule above; this one would reach every .png
    for (const m of s.text.matchAll(/(?<!\/['"`]\s*\+[^'"`\n]*)\+\s*(['"`])(\.\w+)\1/g)) b.dynamic.push({ at: s.at(m.index), text: '…' + m[2], re: new RegExp(esc(m[2]) + '$', 'i') });
    if (s.js) for (const [re2, kind] of DYNAMIC) for (const m of s.text.matchAll(re2)) b.dynamic.push({ at: s.at(m.index), text: m[0].trim().slice(0, 60), kind: kind(m), any: true });
  }
}

/** What this game pulled from a library, from its pull records (lib/lib-records.mjs): each file is marked, and a changed file says so. The library only adds the preview */
function scanLibrary(b, lib) {
  const library = lib ? readLibrary(lib).entries : [];
  for (const r of pullStatus(b.dir, library)) {
    const paths = Object.keys(r.files);
    const it = b.add({ kind: 'library', name: r.entry, file: paths[0] ?? null, extra: { summary: r.summary, entryKind: r.kind, pulled: changeWords(r), changed: [...r.changed, ...r.missing], libraryState: r.library, from: r.from } });
    const e = library.find(x => x.name === r.entry);
    if (e && existsSync(join(e.dir, 'preview.png'))) it.preview = { type: 'image', abs: join(e.dir, 'preview.png') };
    for (const f of paths) {
      it.uses.push({ at: f, how: r.missing.includes(f) ? 'pulled, deleted here' : r.changed.includes(f) ? 'pulled, changed here' : 'pulled, unchanged' });
      if (b.byFile.has(f)) b.byFile.get(f).library = r.entry;
    }
  }
}

const LIMITS = [
  ['runtimeNames', 'A name built at run time cannot be followed: what it could reach is shown as not traced, never as unused. `--live` asks the running game what it really loaded.'],
  ['embedded', 'Textures and materials inside a .glb are not listed one by one; `--live` adds the ones in the scene.'],
  ['codeMeshes', 'Meshes built in code and sounds synthesized in code without a manifest name are not listed; the materials of those meshes are.'],
  ['liveNow', '`--live` only sees what is loaded now: a level not visited yet looks not loaded, so it never turns anything into unused.'],
];

/** Merge what the running game reports (panel/art.js loadedArt): loaded is proof of use, not loaded proves nothing */
function mergeLive(b, live) {
  const stem = u => { const n = basename(bare(String(u ?? ''))); try { return decodeURIComponent(n); } catch { return n; } };   // a url is percent-encoded, a file name is not
  const seen = (kind, name, url, extra) => {
    const it = b.get(kind, name) ?? (url && b.items.find(i => i.kind === kind && i.file && stem(i.file) === stem(url))) ?? b.add({ kind, name, file: url ?? null, extra: { runtimeOnly: true, ...extra } });
    it.loaded = true; it.uses.push({ at: 'running game', how: 'loaded' });
  };
  for (const a of live.assets ?? []) if (a.loaded && !a.builtIn && PACK_KEYS.some(([, k]) => k === a.type)) seen(a.type, a.name, a.url);
  for (const m of live.materials ?? []) seen(m.shader ? 'shader' : 'material', m.name, null, { class: m.type });
  for (const t of live.textures ?? []) if (t.url) seen('texture', stem(t.url).replace(/\.\w+$/, ''), t.url);
}

/** The status rule at the top of this file, in one place */
function judge(b) {
  for (const it of b.items) {
    if (it.problem) { it.status = 'missing'; continue; }
    if (it.uses.length) { it.status = 'used'; continue; }
    const key = String(it.file ?? '').replace(/^public\//, '');
    const reach = b.dynamic.filter(d => d.any ? (d.kind === 'material' ? it.keyed : d.kind === it.kind && !it.class)
      : d.named ? d.kind === it.kind && d.re.test(it.name) : !it.made && it.file && d.re.test(key));
    it.maybe.push(...reach.map(d => ({ at: d.at, how: `built at run time: ${d.text}` })));
    it.status = it.maybe.length ? 'not-traced' : 'unused';
  }
}

const atList = l => [...new Set(l.map(u => u.at))];
const some = (l, n = 3) => l.slice(0, n).join(', ') + (l.length > n ? ` and ${l.length - n} more` : '');
/** The line the owner pastes to the AI */
function lineOf(it) {
  const head = `${it.kind} ${it.name} (${it.file ?? 'no file'}${it.source ? `, source ${it.source}` : ''})`;
  if (it.status === 'missing') return `${head}, MISSING (${it.problem}), named in ${some(atList(it.uses)) || it.defAt}`;
  if (it.kind === 'library') return `${head}, pulled from the library, ${it.pulled}${it.libraryState === 'newer' ? ', newer in the library' : ''}`;
  if (it.status === 'used') return `${head}, used in ${some(atList(it.uses))}`;
  if (it.status === 'not-traced') return `${head}, not traced: maybe reached from ${some(atList(it.maybe))}`;
  return `${head}, unused`;
}

/**
 * Every art resource of a game as plain data (the page and --json are this one object).
 * @param {string} folder game folder
 * @param {{ lib?: string | null, live?: any }} [opts] lib: the library folder to compare with; live: panel/art.js loadedArt() of the running game
 */
export async function scanArt(folder, { lib = null, live = null } = {}) {
  const dir = resolve(folder), b = new Board(dir);
  const sources = walk(dir, { exts: /\.(m?js|html|css)$/, skip: NOT_ART }).map(f => source(dir, f));
  scanFiles(b);
  await scanManifests(b, sources);
  scanMade(b, sources);
  scanRefs(b, sources);
  scanLibrary(b, lib);
  if (live) mergeLive(b, live);
  judge(b);
  // a model's rendered picture, when `threedog gallery --shots` has made one
  const stems = fileStems(b.items.filter(i => i.defAt && ['model', 'texture'].includes(i.kind)).map(i => i.name));
  for (const it of b.items) {
    const shot = stems.has(it.name) && `.threedog/gallery/${stems.get(it.name)}-midday.png`;
    if (shot && it.preview?.type !== 'image' && existsSync(join(dir, shot))) it.preview = { type: 'image', file: shot };
    it.ref = `${it.kind} ${it.name}`;
    it.line = lineOf(it);
  }
  const order = { missing: 0, 'not-traced': 1, unused: 2, used: 3 };
  const items = b.items.sort((x, y) => order[x.status] - order[y.status] || KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind) || x.name.localeCompare(y.name));
  const by = s => items.filter(i => i.status === s).map(i => i.ref), sized = items.filter(i => i.size);
  const summary = {
    counts: Object.fromEntries(KINDS.map(k => [k, items.filter(i => i.kind === k).length]).filter(([, n]) => n)),
    total: items.length, totalBytes: sized.reduce((n, i) => n + i.size, 0),
    biggest: [...sized].sort((x, y) => y.size - x.size).slice(0, 5).map(i => ({ ref: i.ref, size: i.size })),
    unused: by('unused'), missing: by('missing'), notTraced: by('not-traced'),
  };
  const dynamic = [...new Map(b.dynamic.map(d => [d.at + d.text, { at: d.at, text: d.text, kind: d.kind ?? 'file' }])).values()];
  return { game: basename(dir), dir, summary, items, dynamic, problems: b.problems, limits: LIMITS.map(([id, text]) => ({ id, text })),
    live: live ? { assets: live.assets?.filter(a => a.loaded && !a.builtIn).length ?? 0, materials: live.materials?.length ?? 0, textures: live.textures?.length ?? 0, unnamedMaterials: live.unnamedMaterials ?? 0 } : null };
}
