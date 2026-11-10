// Record ids inside save data, for upgrade steps (saves.define migrate). Shared by the world part and every part that keys data by a record id
// (containers): when the world part renames ids, those parts must rename the same ones, and core is the one place both may import from.
// Runtime record ids: world save part version 2 numbered them `<kind>-<n>`, version 3 `<kind>#<n>` (an authored id may not contain `#`,
// so the two can never collide; modules/content/ids.js).

/**
 * Old auto-numbered runtime ids of a world save part (version 1 or 2) -> the version-3 id: `crate-4` -> `crate#4`.
 * Exact rule, because an authored-looking id must never be renamed: only records saved whole (runtime records; authored ones live in changed / removed)
 * whose id is `<its own kind>-<n>`, n a whole number from 1 to the saved counter seq (world.add numbered with ++seq, one counter for every kind, so
 * each n was handed out once). An n claimed by two records means one of them was given that id by hand: both are left alone.
 * Limit: a runtime record given `<kind>-<n>` by hand, with n <= seq and no auto record sharing n, looks exactly like an auto id and is renamed too.
 * @param {any} d  world part data, version 1 (records array) or 2 (records keyed by id)
 * @returns {Map<string, string>}
 * @internal
 */
export function legacyRuntimeIds(d) {
  const seq = Number.isInteger(d?.seq) ? d.seq : 0, recs = d?.records;
  const list = Array.isArray(recs) ? recs.map(r => [r?.id, r]) : Object.entries(recs || {});
  const byN = new Map();
  for (const [id, r] of list) {
    const m = typeof id === 'string' && /^(.+)-([1-9]\d*)$/.exec(id);
    if (!m || m[1] !== r?.kind || Number(m[2]) > seq) continue;
    byN.set(m[2], byN.has(m[2]) ? null : id);
  }
  const out = new Map();
  for (const [n, id] of byN) if (id) out.set(id, `${id.slice(0, -n.length - 1)}#${n}`);
  return out;
}

/** Rename ids inside saved data: string values equal to an old id (a record field that names another record, e.g. owner: 'crate-4'), deep @internal */
export function renameIdValues(v, map, depth = 0) {
  if (typeof v === 'string') return map.get(v) ?? v;
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map(x => renameIdValues(x, map, depth + 1));
  const out = {};
  for (const k in v) out[k] = renameIdValues(v[k], map, depth + 1);
  return out;
}
/** Rename the keys of an id-keyed object (values untouched) @internal */
export const renameIdKeys = (o, map) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [map.get(k) ?? k, v]));

/**
 * Migrate step for a part keyed by record id (containers): rename the same runtime ids the world part renames. save is the whole save as read (upgradePart).
 * @param {any} d
 * @param {{ parts?: Record<string, any>, versions?: Record<string, number> }} [save]
 * @internal
 */
export function followRuntimeIds(d, save) {
  const w = save?.parts?.world;
  if (!w || (save.versions?.world ?? 1) >= 3) return d;   // a version-3 world part already uses `#`: nothing to follow
  const map = legacyRuntimeIds(w);
  return map.size ? renameIdKeys(d, map) : d;
}
