// Two copies of the engine on one page (e.g. a game imports `threedog` while a pack or tool bundles its own copy, or a
// workspace link plus an npm copy). Each copy installs the shadow accessors on THREE.Mesh.prototype (render/patches.js) and keeps
// its own patch lists, so the second install makes the first copy's wind / CSM materials cast no matching shadow: nothing throws,
// shadows just go wrong. So each copy writes itself under one global symbol at load and the second one says so, once, naming both.
//   console: [threedog] two copies of the engine on this page (0.2.1 at .../node_modules/threedog/, 0.2.1 at .../packages/engine/): load one, ...
// A hot reload re-runs the same file (same path, a ?t= query): that is one copy, not two, so the path without the query decides.
import { coded } from '../base/errorHints.js';

export const VERSION = '1.2.0';   // kept equal to package.json by the "[guard] engine copies" spec

const KEY = Symbol.for('threedog.engine.copies');

/** Path of an engine file without the query / hash (?t=... from a hot reload) and without the file itself: the copy's root. @param {string} url */
function copyRoot(url) { return String(url).replace(/[?#].*$/, '').replace(/[^/]*$/, '').replace(/render\/$/, ''); }

/**
 * Record this copy; returns the warning text when another copy (different root) is already on the page, else ''.
 * Pure on the passed registry so the spec can feed it fake copies; the engine calls it with the global one.
 * @param {{ version: string, url: string }} me
 * @param {any} [registry]
 */
export function noteCopy(me, registry = globalThis) {
  const list = (registry[KEY] ??= []);
  const root = copyRoot(me.url);
  const other = list.find((/** @type {{ root: string }} */ c) => c.root !== root);
  if (!list.some((/** @type {{ root: string }} */ c) => c.root === root)) list.push({ version: me.version, root });
  if (!other) return '';
  return coded('engine-two-copies', `[threedog] two copies of the engine on this page (${other.version} at ${other.root}, ${me.version} at ${root}): ` +
    "load one, e.g. vite.config.js: resolve: { dedupe: ['threedog', 'three'] }. Each copy hooks THREE.Mesh.prototype for shadows, so " +
    'wind / cascaded-shadow materials of one copy cast wrong shadows. `npm ls threedog` shows who pulls the second; a pack or ' +
    'tool lists threedog under peerDependencies, not dependencies');
}
