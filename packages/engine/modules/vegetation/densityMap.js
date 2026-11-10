// vegetation.define(name, { densityMap }): how much of a species survives at each spot, 0 (none) .. 1 (everything the rule / positions placed).
// A function (x, z) => 0..1 or a gray image laid over the world with the same keys as a terrain height map ({ url | data, width, height, size,
// center, outside }), so a painted mask, a game's zoning table or a noise function all go in through one option.
//
// Why it thins on the main thread after placement (in Vegetation.mount) and not inside the placer: a function may read game state (closures,
// a zoning grid the game edits), which cannot travel to the terrain worker; and thinning the already placed instances keeps every survivor's
// stable id, so felled-tree records and saves stay valid whether the map is on, off or changed. Each instance keeps or drops by its own hash
// against the density there, so raising the density only adds plants, it never moves the ones already standing.
import { readParams, keysSchema } from '../../core/base/params.js';
import { grayWorld, loadGray } from '../../core/scene/grayMap.js';
import { codedError } from '../../core/base/errorHints.js';

const MAP_KEYS = ['url', 'data', 'width', 'height', 'size', 'center', 'outside'];

/**
 * @param {Function | object} spec a function (x, z) => 0..1, or { url | data + width + height, size: [w, l] m, center?: [x, z], outside?: 0..1 }
 * @param {string} label for errors
 * @returns {{ at(x: number, z: number): number, pending: Promise<void> | null }} pending: the image is still loading (at() is 0 until then)
 */
export function makeDensity(spec, label) {
  if (typeof spec === 'function') return { at: spec, pending: null };
  if (!spec || typeof spec !== 'object') throw codedError('vegetation-option', `${label}: densityMap is a function (x, z) => 0..1 or { url | data, width, height, size: [w, l], center? }`);
  readParams(label, keysSchema(MAP_KEYS), spec);
  if (!Array.isArray(spec.size) || spec.size.length !== 2) throw codedError('vegetation-option', `${label}: densityMap needs size: [width m, length m], the world area the image covers (centred on center, default [0, 0])`);
  if (!spec.url && !(spec.data && spec.width > 0 && spec.height > 0)) throw codedError('vegetation-option', `${label}: densityMap needs url (a gray image) or data + width + height (0..1 values, row 0 at the -z edge)`);
  const M = { ...spec, data: spec.data ?? null };
  const at = (x, z) => {
    if (!M.data) return 0;   // image not loaded yet: nothing grows, the chunks are placed again once it is
    return grayWorld(M, x, z) ?? M.outside ?? 0;
  };
  const pending = M.data ? null : loadGray(spec.url).then(g => { Object.assign(M, g); }, err => { throw codedError('vegetation-option', `${label}: densityMap url ${spec.url} did not load (${err?.message ?? err})`); });
  return { at, pending };
}

// keep/drop roll of one instance: a hash of its stable id and the species salt, 0..1. Not the placement random stream, so a map never shifts
// where the survivors stand
function roll(id, salt) {
  let h = Math.imul(id + 1, 0x9E3779B1) ^ Math.imul(salt + 7, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Placement result r with only the instances at the indices `keep` (same shape as r; r itself when all stay) */
export function select(r, keep) {
  if (keep.length === r.n) return r;
  const n = keep.length, m = new Float32Array(n * 16), c = new Float32Array(n * 3), ids = new Uint32Array(n), hasK = r.k && r.k.length;
  const k = new Float32Array(hasK ? n * 3 : 0);
  keep.forEach((i, j) => {
    m.set(r.m.subarray(i * 16, i * 16 + 16), j * 16); c.set(r.c.subarray(i * 3, i * 3 + 3), j * 3); ids[j] = r.ids[i];
    if (hasK) k.set(r.k.subarray(i * 3, i * 3 + 3), j * 3);
  });
  return { ...r, m, c, k, ids, n };
}

/** Placement result r of chunk origin (ox, oz) with only the instances whose roll is under the density at their spot (same shape as r) */
export function thin(r, ox, oz, at, salt) {
  if (!r.n) return r;
  const keep = [];
  for (let i = 0; i < r.n; i++) {
    const d = at(ox + r.m[i * 16 + 12], oz + r.m[i * 16 + 14]);
    if (d > 0 && roll(r.ids[i], salt) < d) keep.push(i);
  }
  return select(r, keep);
}
