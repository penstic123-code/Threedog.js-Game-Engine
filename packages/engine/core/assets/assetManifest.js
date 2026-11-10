// engine.assets.manifest(pack) (helper of Assets.js): registers the named models, textures, sounds and fonts of an asset pack. `a` is the Assets instance.
import { fmt, warnOnce, BASE_URL } from '../base/validate.js';
import { codedError } from '../base/errorHints.js';
import { parseSchema, readParams, keysSchema } from '../base/params.js';
import { readNeeds } from './modelNeeds.js';

const STRINGS = {
  clash: 'assets.manifest(): "{name}" is already registered as a {was} (manifest "{list}"), and now as a {type}; one name is one asset, ' +
    'so the second would replace the first. Rename one, e.g. {name}_{type}',
  node: 'assets.manifest() models.{name}: node names one node of a file, so it needs the file as a url and a node name as a string, e.g. { url: \'/models/kit.glb\', node: \'Wall.001\' } (no build)',
  replaced: 'assets.manifest(): {type} "{name}" from manifest "{was}" is replaced by manifest "{list}" (the later one wins). If both packs mean their own asset, rename one; '
    + 'if the override is intended (a mod replacing a model), ignore this',
};
/** Keys of a manifest / asset pack: anything else is a typo (readParams throws with "did you mean") */
const MANIFEST_KEYS = ['name', 'base', 'models', 'textures', 'sounds', 'fonts'];
/** Keys of one fonts entry: the file, the CSS family it registers (default: the asset name), FontFace descriptors, and the usual asset flags */
const FONT_KEYS = ['url', 'family', 'weight', 'style', 'stretch', 'unicodeRange', 'display', 'featureSettings', 'variationSettings', 'critical', 'preload'];
/** What the 'optimized' pack replaces in an entry: the file (so a generator or Texture it replaces goes too: build is checked before url). Everything else stays the game's */
const FILE_KEYS = new Set(['url', 'lods', 'node', 'build', 'texture']);
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.has(k)));

/**
 * hot: { changed: [] } = a dev hot swap (core/assets/assetHot.js) registering the edited packs again: an entry whose build function (or Texture) and url are unchanged
 * is kept as it is (loaded value and all, so nothing reloads), a changed one is replaced and pushed to changed as { name, type, old } for the swap;
 * no "replaced" warning, since the same pack coming back is not a mod overriding it
 */
export function registerManifest(a, pack, hot = null) {
  // a list of packs (a game's assets.js exports one, so `npm run check` reads the same objects): each registered in order, later names win
  if (Array.isArray(pack)) { for (const p of pack) registerManifest(a, p, hot); return a; }
  readParams('assets.manifest()', keysSchema(MANIFEST_KEYS), pack);
  const { models = {}, textures = {}, sounds = {}, fonts = {}, base = null } = pack, list = pack.name ?? 'manifest#' + (a._lists = (a._lists || 0) + 1);
  const at = base == null ? null : new URL(String(base).replace(/\/?$/, '/'), location.href);
  // '/models/x.glb' means the game's public/ folder, which a build with --base /my-game/ serves under that path (recipes/61-deploy.md): vite
  // rewrites bundled URLs only, never these strings, so a game deployed under a sub-path asked the site root for every asset
  const resolve = u => typeof u !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(u) || u.startsWith('//') ? u
    : u.startsWith('/') ? BASE_URL + u.slice(1) : at ? new URL(u, at).href : u;
  const add = (type, map) => {
    for (const [name, v] of Object.entries(map)) {
      const o0 = typeof v === 'string' ? { url: v } : typeof v === 'function' ? { build: v } : v?.isTexture && type === 'texture' ? { texture: v } : v;
      if (type === 'font') readParams(`assets.manifest() fonts.${name}`, keysSchema(FONT_KEYS), o0);
      if (type === 'model' && o0.node != null && (typeof o0.url !== 'string' || typeof o0.node !== 'string' || o0.build)) throw codedError('asset-misuse', fmt(STRINGS.node, { name }));
      if (type === 'model' && o0.needs != null) readNeeds(`models.${name}`, o0.needs);   // a typo'd key or a non-list fails here, naming the entry
      const old = a.entries.get(name);
      // the 'optimized' pack (`threedog assets optimize`) swaps the file only: url, lods and a part's node. The game's other options (needs,
      // prepare, params, ...) stay, since that pack is written as JSON and cannot carry them
      const o1 = list === 'optimized' && old?.named && old.type === type ? { ...without(old.opts, FILE_KEYS), ...o0 } : o0;
      const o = o1.url ? { ...o1, url: resolve(o1.url), ...(o1.lods && { lods: o1.lods.map(resolve) }) } : o1;
      // a model's params is a schema (core/base/params.js format, parsed here so a bad spec fails at registration, naming the field)
      const schema = type === 'model' && o.params ? parseSchema(`assets.manifest() models.${name}.params`, o.params) : null;
      if (hot && old?.named && old.type === type) {
        if (old.opts.build === o.build && old.opts.texture === o.texture && old.opts.node === o.node && old.url === (o.url ?? name) && JSON.stringify(old.opts.params ?? null) === JSON.stringify(o.params ?? null)) continue;
        const was = { ...old };   // the swap pairs the old data with the new
        a._retire(old);
        Object.assign(old, { url: o.url ?? name, opts: o, schema });
        hot.changed.push({ name, type, old: was });
        continue;
      }
      if (old?.named && !old.builtIn && old.type !== type) throw codedError('asset-name-clash', fmt(STRINGS.clash, { name, was: old.type, list: old.manifest, type }));
      // same type from another manifest: allowed (a mod overriding a model) but never silent, the two packs may just share a name by accident
      // the pack named 'optimized' (written by `threedog assets optimize`) exists to replace the originals, so that override is no accident
      if (old?.named && !old.builtIn && old.manifest !== list && list !== 'optimized') warnOnce(fmt(STRINGS.replaced, { type, name, was: old.manifest, list }));
      const fresh = { type, name, url: o.url ?? name, opts: o, schema, promise: null, named: true, manifest: list };
      if (!old) { a.entries.set(name, fresh); continue; }
      // the same object, rewritten: code awaiting the old registration lands on the new one, and copies already out still count here
      a._retire(old);
      for (const k of Object.keys(old)) if (k !== 'users') delete old[k];
      Object.assign(old, fresh);
    }
  };
  add('model', models); add('texture', textures); add('sound', sounds); add('font', fonts);
  return a;
}

/**
 * @internal Engine modules' own synths (footstep, shutter, thunder, the ambience loops) as sound assets, the same kind a game registers with
 * assets.manifest({ sounds: { name: fn } }), but marked built in: silent until the game's audio.sounds names them. A name the game already
 * registered is kept (the game's sound wins), and a game manifest registering the name later replaces it without the "replaced" warning.
 * bus: the default bus when neither the call nor the rule gives one (thunder and ambience: 'ambience').
 */
export function builtInSounds(a, sounds, { bus } = {}) {
  for (const [name, build] of Object.entries(sounds)) {
    if (a.entries.get(name)?.named) continue;
    a.entries.set(name, { type: 'sound', name, url: name, opts: { build, ...(bus && { bus }) }, promise: null, named: true, manifest: 'built-in', builtIn: true });
  }
}

/**
 * The argument a generator with a params schema is called with: defaults < values tuned in the dev panel (entry.tuned) < the call's own object
 * (content model: ['tree', { height: 3 }]). Checked like module options (typo and wrong type throw). A generator without a schema gets the
 * call's arguments as written. @internal
 */
export function paramValues(entry, given) {
  if (!entry?.schema) return given;
  return readParams(`model '${entry.name}' params`, entry.opts.params, { ...entry.tuned, ...(given ?? {}) });
}
