// Merge geometries that came from different meshes: hlod proxies, a many-material model made into one vegetation species.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** The attribute names every geometry has: what mergeCommon keeps @param {import('three').BufferGeometry[]} geos @returns {string[]} */
export const commonAttributes = geos => Object.keys(geos[0].attributes).filter(n => geos.every(g => g.attributes[n]));

/**
 * One geometry from geometries the caller owns (clones): only the attributes all of them have stay, no morph targets, and an index only if
 * all have one. The inputs are spent: they are changed, then disposed.
 * @param {import('three').BufferGeometry[]} geos @param {boolean} [groups] one group per input
 * @returns {import('three').BufferGeometry}
 */
export function mergeCommon(geos, groups = false) {
  const names = commonAttributes(geos);
  const indexed = geos.every(g => g.index);
  const ready = geos.map(g => {
    const h = indexed || !g.index ? g : g.toNonIndexed();
    for (const n of Object.keys(h.attributes)) if (!names.includes(n)) h.deleteAttribute(n);
    h.morphAttributes = {};
    return h;
  });
  const out = mergeGeometries(ready, groups);
  for (const g of new Set([...geos, ...ready])) g.dispose();
  return out;
}
