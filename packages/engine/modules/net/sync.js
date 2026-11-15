// State sync for net(): what the host reads into snapshots / diffs, and how a client writes them back.
// A "part" is a map of entries (id -> plain value). world: records by id; containers: item counts by container id (the player bag included);
// vars: { flags, counters }; any other save provider (quests, clock, sky...) is one entry '=' with its save() data.
// The host keeps one baseline (entry -> JSON text) for all peers: a diff is the entries whose JSON changed since the last sync, so
// changes made directly inside simulate are caught too, like saves (persist.js). A peer that missed a diff gets a full snapshot instead.
//
// Ids: each machine calls its own avatar 'player' (characters, inventory and interactions are built on that id). On the host, a peer's
// avatar and bag are its actor id ('guest-2'). A client sees itself as 'player' and the host's avatar as 'host', so the two names swap
// at the wire (toLocal / toHost). Record fields that hold actor ids (owner...) are listed in net({ actorFields }) and swapped too.

// random/level stay per machine; inventory is the home bag 'player', sent inside containers with every other bag; rigid (body velocities, for loads)
// stays per machine too: each machine simulates its own physics, clients follow the host through world records (docs/recipes/11-physics.md, section 3)
const SKIP = ['random', 'level', 'inventory', 'containers', 'world', 'vars', 'rigid'];
const GENERIC = '=';

/** @internal parts to sync: 'auto' = world, containers, vars and every other save provider except random / level / rigid */
export function partKeys(e, sync) {
  if (Array.isArray(sync)) return sync;
  const keys = [];
  if (e.world) keys.push('world');
  if (e.inventory) keys.push('containers');
  keys.push('vars');
  for (const k of e.saves.providers.keys()) if (!SKIP.includes(k)) keys.push(k);
  return keys;
}

/** @internal host: one part as entries { id: value } (live objects; the transport copies them) */
function readPart(e, key) {
  if (key === 'world') return Object.fromEntries(e.world.records);
  if (key === 'containers') return e.inventory.contents();   // public API only: any module that provides 'inventory' syncs the same
  if (key === 'vars') return { flags: e.vars.flags, counters: e.vars.counters };
  const p = e.saves.providers.get(key);
  return p ? { [GENERIC]: p.save() } : {};
}

/** @internal host: entries of `parts` changed since `base` (Map key -> Map id -> json); updates base. Returns null when nothing changed */
export function diffParts(e, keys, base) {
  let out = null;
  for (const key of keys) {
    const now = readPart(e, key), b = base.get(key) ?? base.set(key, new Map()).get(key);
    let set = null, del = null;
    for (const id in now) {
      const j = JSON.stringify(now[id]);
      if (b.get(id) !== j) { b.set(id, j); (set ||= {})[id] = now[id]; }
    }
    for (const id of b.keys()) if (!(id in now)) { b.delete(id); (del ||= []).push(id); }
    if (set || del) (out ||= {})[key] = { set: set ?? undefined, del: del ?? undefined };
  }
  return out;
}

/** @internal host: full snapshot of `keys` */
export function snapshotParts(e, keys) {
  const out = {};
  for (const key of keys) out[key] = readPart(e, key);
  return out;
}

/** @internal id swap between the host's names and this client's names (see the top of the file) */
export function idMap(me) {
  const toLocal = id => id === me ? 'player' : id === 'player' ? 'host' : id;
  const toHost = id => id === 'player' ? me : id === 'host' ? 'player' : id;
  return { toLocal, toHost };
}

/**
 * @internal client: write one part (full snapshot or diff) into this engine. Runs inside ops.allow (the client guard lets it through).
 * Position changes of interpolated kinds go to `glide(id, to)` instead of moving now; the own avatar keeps its local position (the client drives its own movement).
 */
export function applyPart(e, key, part, full, opts) {
  const set = full ? part : part.set ?? {}, del = full ? null : part.del ?? [], { toLocal } = opts;
  if (key === 'world') return applyWorld(e, set, del, full, opts);
  if (key === 'containers') {
    const data = {};
    for (const id in set) data[toLocal(id)] = set[id];
    for (const id of del ?? []) data[toLocal(id)] = null;   // gone on the host: emptied here if it exists
    e.inventory.setContents(data, { only: full });   // silent like a save load; the inventory window redraws once
    return;
  }
  if (key === 'vars') {
    if ('flags' in set || 'counters' in set) e.vars.replace(set.flags, set.counters);
    return;
  }
  if (GENERIC in set) e.saves.providers.get(key)?.load(set[GENERIC]);
}

function applyWorld(e, set, del, full, { toLocal, actorFields, avatarFields, smooth, glide }) {
  const W = e.world;
  const local = rec => {
    const r = { ...rec, id: toLocal(rec.id) };
    for (const f of actorFields) if (typeof r[f] === 'string') r[f] = toLocal(r[f]);
    return r;
  };
  if (full) {
    const keep = new Set(Object.keys(set).map(toLocal));
    for (const id of [...W.records.keys()]) if (id !== 'player' && !keep.has(id)) W.remove(id);
  }
  for (const id of del ?? []) { const l = toLocal(id); if (l !== 'player') W.remove(l); }
  for (const hostId in set) {
    const rec = local(set[hostId]), have = W.get(rec.id);
    if (!have) { W.add(rec, { save: false }); continue; }   // own avatar too, when no characters module made one (it then takes this record over)
    const { id, kind, position, ...fields } = rec, own = id === 'player', patch = {};
    let changed = false;
    for (const k in fields) {
      if (own && avatarFields.includes(k)) continue;   // own avatar: what we sent comes back late; the local value is newer
      if (JSON.stringify(fields[k]) !== JSON.stringify(have[k])) { patch[k] = fields[k]; changed = true; }
    }
    if (!own) for (const k in have) if (!(k in rec) && have[k] !== undefined) { patch[k] = undefined; changed = true; }
    if (changed) W.set(id, patch);
    if (own) continue;   // own avatar: position stays local (this client drives its own movement)
    const p = have.position;
    if (p.x === position.x && p.y === position.y && p.z === position.z) continue;
    if (!full && smooth(have)) glide(id, position); else W.move(id, position);
  }
}
