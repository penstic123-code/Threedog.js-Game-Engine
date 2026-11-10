// threedog how --read <api name>: one method, option or field by its name, from the API pages (docs/api/*.md), e.g. interactions.add.once, createEngine.budget.fps,
// followCamera.pointerLock, characters.addPlayer.speed, saves.exportFile.files, InteractionOptions. Why on --read and not a command of its own: --read already
// prints one piece of the docs by where it is; a name is the other way to say where. Why the API pages: they are generated from the JSDoc of every public name
// (npm run map), so this answer cannot drift from the code, and nothing here keeps a second list of options.
// A name resolves one segment at a time: the longest start that is a documented name (method, install call, property, type), then each next segment is a field
// of the types the previous one names (its signature, or the field's own type), of what those types extend, or of an inline { a?, b? } in the signature.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TYPE = /\b([A-Z]\w+)\b/g, caps = s => [...new Set([...(s ?? '').matchAll(TYPE)].map(m => m[1]))];
/** The fields of every { ... } in a signature: { files?: boolean } and { speed?, arrive? } both give their names */
const inline = sig => [...sig.matchAll(/\{([^{}]*)\}/g)].flatMap(m => [...m[1].matchAll(/(?:^|[,;])\s*(\w+)\??\s*(?=[:,;]|$)/g)].map(f => f[1]));

const cache = new Map();
/** Every documented name: lower-case key -> { name, line, file, types, ext }. types: the type names it points at; ext: what a type extends */
function index(docsDir) {
  if (cache.has(docsDir)) return cache.get(docsDir);
  const out = new Map(), dir = join(docsDir, 'api');
  const put = (name, e) => { const k = name.toLowerCase(), had = out.get(k); if (!had) out.set(k, { name, types: [], ext: [], ...e }); else had.types = [...new Set([...had.types, ...(e.types ?? [])])]; };
  if (existsSync(dir)) for (const f of readdirSync(dir).filter(x => x.endsWith('.md')).sort()) {
    const page = `api/${f}`, ns = f.replace(/\.md$/, ''), lines = readFileSync(join(dir, f), 'utf8').split('\n');
    // the install calls in the title ("# engine.cameraRig — followCamera(opts?: FollowCameraOptions) / firstPersonCamera(...)"): followCamera.pointerLock starts there
    for (const part of (lines[0].split(' — ')[1] ?? '').split(' / ')) {
      const m = /^\s*(\w+)\((.*)\)\s*$/.exec(part);
      if (m) put(m[1], { line: `${m[1]}(${m[2]})`, file: page, types: caps(m[2]) });
    }
    let owner = null, last = null;   // owner of the indented lines that follow: a type, the page's properties, or nothing
    for (const l of lines) {
      let m;
      if ((m = /^- `([\w$.]+)\(/.exec(l))) {
        // every signature of an overload ("`a(x)` / `a(at)`") counts: their option types and inline fields merge
        const sigs = [...l.split(' — ')[0].matchAll(/`([^`]*)`/g)].map(s => s[1]);
        last = m[1]; owner = null;
        put(m[1], { line: l, file: page, types: caps(sigs.map(s => s.replace(/→.*$/, '')).join(' ')) });
        for (const name of new Set(sigs.flatMap(inline))) put(`${m[1]}.${name}`, { line: l, file: page, inlineOf: m[1] });
      } else if ((m = /^- (?:(\w+) )?[Oo]ptions `(\w+)`/.exec(l))) {
        owner = { type: m[2] }; put(m[2], { line: l, file: page });
        put(m[1] ?? last ?? ns, { line: l, file: page, types: [m[2]] });   // "followCamera options `X`" names its call; a bare "Options" belongs to the call above or the page
      } else if ((m = /^- \*\*(\w+)\*\*(?: \(extends ([^)]*)\))?/.exec(l))) {
        owner = { type: m[1] }; put(m[1], { line: l, file: page, ext: caps(m[2]) });
      } else if (/^- Properties:/.test(l)) owner = { prop: ns };
      else if ((m = /^ {2}- `([\w$]+)\??:([^`]*)`/.exec(l)) && owner) put(`${owner.prop ?? owner.type}.${m[1]}`, { line: l.trim(), file: page, types: caps(m[2]) });
      else if (!/^ {2}/.test(l)) owner = null;
    }
  }
  cache.set(docsDir, out);
  return out;
}

/** A type and everything it extends, nearest first */
function lineage(idx, type, seen = new Set()) {
  if (seen.has(type)) return [];
  seen.add(type);
  return [type, ...(idx.get(type.toLowerCase())?.ext ?? []).flatMap(t => lineage(idx, t, seen))];
}
/** The documented fields of one name: its inline ones, then those of every type it points at (with what they extend) */
function fieldsOf(idx, e) {
  const types = [...(/^[A-Z]/.test(e.name) ? [e.name] : []), ...e.types].flatMap(t => lineage(idx, t));
  return [e.name, ...types].flatMap(owner => [...idx.values()].filter(x => x.name.startsWith(owner + '.') && !x.name.slice(owner.length + 1).includes('.')).map(x => [x.name.slice(owner.length + 1), x]));
}
/** a.b.c -> the entry, or { stuck, at } where resolving stopped */
function resolve(idx, name) {
  const segs = name.split('.');
  for (let i = segs.length; i > 0; i--) {
    const head = segs.slice(0, i).join('.').toLowerCase();
    let e = idx.get(head) ?? idx.get(`engine.${head}`) ?? (head.startsWith('engine.') ? idx.get(head.slice(7)) : undefined);
    if (!e) continue;
    for (const s of segs.slice(i)) {
      const next = fieldsOf(idx, e).find(([f]) => f.toLowerCase() === s.toLowerCase())?.[1];
      if (!next) return { stuck: e };
      e = next;
    }
    return { hit: e };
  }
  return {};
}
/** Edit distance, for a namespace typed wrong (interactons -> interactions) */
function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * One API name as text: { ref, text, more } like readSection, or { near } with close names when it resolves to nothing.
 * @param {string} docsDir @param {string} name
 * @returns {{ ref: string, text: string, more: string } | { near: string[] }}
 */
export function readField(docsDir, name) {
  const idx = index(docsDir), q = name.trim().replace(/\(\)$/, ''), r = resolve(idx, q);
  if (r.hit) {
    const e = r.hit, fields = [...new Set(fieldsOf(idx, e).map(([f]) => f))];
    const title = e.inlineOf ? `${e.name} (an inline option of ${e.inlineOf}, ${e.file})` : `${e.name} (${e.file})`;
    const extra = fields.length ? [`  fields: ${fields.join(', ')}${fields.length > 1 ? ` (threedog how --read ${q}.<field>)` : ''}`] : [];
    return { ref: e.file, text: [title, `  ${e.line.replace(/^- /, '')}`, ...extra].join('\n'), more: `The page: threedog how --read ${e.file} --full` };
  }
  // stuck after a known start: that start's fields; nothing known: the same path under the closest namespace, else names with the closest start
  if (r.stuck) return { near: fieldsOf(idx, r.stuck).map(([f]) => `${r.stuck.name}.${f}`).slice(0, 8) };
  const low = q.toLowerCase(), head = low.split('.')[0], heads = [...new Set([...idx.keys()].map(k => k.split('.')[0]))];
  const best = heads.map(h => [h, dist(h, head)]).filter(([, n]) => n <= Math.max(1, Math.floor(head.length / 4))).sort((a, b) => a[1] - b[1]).map(([h]) => h);
  const rest = q.split('.').slice(1), fix = best.find(h => resolve(idx, [h, ...rest].join('.')).hit);
  if (fix) return { near: [[[...idx.values()].find(e => e.name.toLowerCase().split('.')[0] === fix).name.split('.')[0], ...rest].join('.')] };
  const pool = [...idx.keys()].filter(k => best.includes(k.split('.')[0]) || k.startsWith(head)), shared = s => { let i = 0; while (i < s.length && s[i] === low[i]) i++; return i; };
  return { near: pool.sort((a, b) => shared(b) - shared(a) || a.length - b.length).slice(0, 6).map(k => idx.get(k).name) };
}
