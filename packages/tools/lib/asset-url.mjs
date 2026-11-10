// The one rule "manifest url -> file on disk", mirroring the engine (core/assets/assetManifest.js `resolve`), for assets check (needs), assets optimize and content check (missing files).
// '/x.glb' is the game's public/ folder; a relative url is put under the pack's `base` (a trailing / is added); a url with a scheme, `//` or `data:` is remote, and so is a relative url under such a base (null: nothing to find on disk).
// `?v=` / `#` tags are dropped. The served file is public/<path>. No folder name is assumed: art/models is only where `assets optimize` reads sources.
import { join, resolve, posix } from 'node:path';

const REMOTE = /^([a-z][a-z\d+.-]*:|\/\/)/i;

/** Served path of a manifest url ('/models/a.glb'), or null when it is remote / inline */
export function servedPath(url, base) {
  if (typeof url !== 'string' || REMOTE.test(url)) return null;
  const u = url.split(/[?#]/)[0];
  // the base only places a relative url: '/x.glb' is the game's own file even in a pack whose base is a CDN, as the engine resolves it
  if (u.startsWith('/') || base == null) return posix.resolve('/', u);
  return REMOTE.test(String(base)) ? null : posix.resolve('/', String(base).split(/[?#]/)[0], u);
}

/** The file of the game this url means: { path, served: public file } (null for a remote url) */
export function assetFiles(dir, url, base) {
  const p = servedPath(url, base);
  return p == null ? null : { path: p, served: join(dir, 'public', p) };
}

const key = f => process.platform === 'win32' ? resolve(f).toLowerCase() : resolve(f);   // a wrong-case path opens on Windows and fails on the server
/** Is `file` the served file of these assetFiles? */
export const isFileOf = (files, file) => !!files && key(files.served) === key(file);
