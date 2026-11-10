// Asset hot swap (dev): an edited generator (art/tree.js, a function in assets.js), a file model whose path changed or a generator's params tuned
// in the dev panel is built again and every live copy changes in place: content props and template instances, pickups, vegetation instances,
// assets.model() copies (characters included). The page does not reload, so the player, the clock and world state stay as they were.
// Why in place, not "remove and place again": game code, colliders, interactions and things hold the copy objects; only their meshes' geometry
// and material are replaced (the same objects stay in the scene). Why not a page reload: an art iteration loop of one save -> one look needs the
// same camera, time of day and weather every time.
// The vite preset (tools/vite/vite-threedog-live.js) makes the game's assets.js accept its own updates and calls engine.debug.reloadAssets(packs)
// with the new module; a test or a tool can call it directly. Plain Vite + three.js equivalent: import.meta.hot.accept on the module that builds
// the meshes, then mesh.geometry = newGeometry on each copy you kept.
// Limits (said in the report): a copy's collision box keeps the size it was placed with until the next load; an InstancedMesh or a merged batch
// the game built itself from a geometry is not found (only engine paths are).
import { registerManifest, paramValues } from './assetManifest.js';
import { protoSlots, protoOf, dropProto, cachedModel } from './namedModel.js';
import { list } from '../base/util.js';
import { reportError } from '../base/errors.js';
import { codedError } from '../base/errorHints.js';
import { note, warnOnce } from '../base/validate.js';
import { freeRetired } from './assetEntry.js';
import { partsOf, cloneModel } from '../base/freeParts.js';

// a failed rebuild is reported (soft: the old copies stay on screen) and the swap goes on with the other names
const failWith = e => (err, what) => reportError(e, err, `asset hot swap: ${what}`, { soft: true });
const meshesOf = o => { const out = []; o?.traverse?.(x => { if (x.isMesh || x.isPoints || x.isLine) out.push(x); }); return out; };
/** cached entries are keyed 'cached:<name>:<params>:<palette>:<source hash>'; without the hash, the same build of a new source pairs with the old */
const unhashed = k => k.slice(0, k.lastIndexOf(':'));
const LAST = 10;   // swaps kept for describe().assetSwaps

/**
 * The swap: old model values of `names` (asset entries already replaced by the caller, cached builds and prototypes) are built again and paired
 * with the new ones mesh by mesh; every scene mesh using an old geometry / material gets the new one.
 * @param {any} e @param {{ name: string, type: string, old: any }[]} changed @param {string} why for the report ('edit', 'params')
 */
async function swapModels(e, changed, why = 'edit') {
  const t0 = performance.now(), a = e.assets, fail = failWith(e);   // measure
  const names = new Set(changed.filter(c => c.type === 'model').map(c => c.name));
  const geo = new Map(), mat = new Map(), tex = new Map(), protoNew = new Map(), structure = new Set(), copies = {};
  const pair = (from, to, name) => {
    if (!from || !to) return;
    if (from.isBufferGeometry || to.isBufferGeometry) {
      const g0 = from.isBufferGeometry ? from : meshesOf(from)[0]?.geometry, g1 = to.isBufferGeometry ? to : meshesOf(to)[0]?.geometry;
      if (g0 && g1 && g0 !== g1) geo.set(g0, { to: g1, name });
      if (!from.isBufferGeometry || !to.isBufferGeometry) pairMeshes([from.isBufferGeometry ? null : from], [to.isBufferGeometry ? null : to], name);
      return;
    }
    const m0 = meshesOf(from), m1 = meshesOf(to);
    if (m0.length !== m1.length) structure.add(name);
    pairMeshes(m0, m1, name);
  };
  const pairMeshes = (m0, m1, name) => m0.forEach((m, i) => {
    const n = m1[i]; if (!m || !n) return;
    if (m.geometry !== n.geometry) geo.set(m.geometry, { to: n.geometry, name });
    const a0 = list(m.material), a1 = list(n.material);
    a0.forEach((x, j) => { const y = a1[j] ?? a1[0]; if (x && y && x !== y) mat.set(x, { to: y, name }); });
  });

  // 1. named entries (assets.model copies) and textures: the caller replaced the entry; load the new one if the old was in use
  for (const { name, type, old } of changed) {
    if (!old?.value) continue;
    const neu = await a._fetch(a.entries.get(name)).catch(err => { fail(err, `${type} "${name}"`); return null; });
    if (type === 'texture' && neu?.isTexture) tex.set(old.value, { to: neu, name });
    if (type === 'model' && neu) pair(old.value.scene, neu.scene, name);
  }
  // 2. cached builds (what content, pickups and vegetation got): drop them, build every name + params asked for so far again
  const oldCached = new Map(), builds = [];
  for (const [k, ent] of [...a.entries]) {
    const n = k.startsWith('cached:') ? k.slice(7, k.indexOf(':', 7)) : null;
    if (n == null || !names.has(n)) continue;
    if (ent.value) oldCached.set(unhashed(k), ent.value);
    // retired, not just dropped: the load is pinned (Assets.cached), so it waits in a._retired where dispose reaches it, and is freed below once nothing draws it
    const load = ent.load; a._retire(ent); if (load?.settled) builds.push(load);
    a.entries.delete(k);
  }
  for (const n of names) a._cachedSrc?.delete(n);   // a new source under the same name is not a name clash
  for (const n of names) for (const m of a._made?.get(n)?.values() ?? []) {
    try { await cachedModel(e, m); } catch (err) { fail(err, `model ${JSON.stringify(m)}`); }
  }
  for (const [k, ent] of a.entries) if (k.startsWith('cached:') && ent.value && oldCached.has(unhashed(k))) {
    const o = oldCached.get(unhashed(k)), name = k.slice(7, k.indexOf(':', 7));
    pair(o.geometry ?? o.scene, ent.value.geometry ?? ent.value.scene, name);
  }
  // 3. prototypes (content props / templates, pickups): a new prototype per old one, held by the same consumers; copies point at it from now on.
  // The old one's lease goes back once the scene below no longer draws its parts (swapped), so trim and release can free the old file then
  let swapped; const offScene = new Promise(r => { swapped = r; });
  for (const [key, slot] of protoSlots(e)) {
    const model = JSON.parse(key), name = list(model)[0];
    if (!names.has(name)) continue;
    const old = await slot.promise.catch(() => null);
    let next = null; for (const h of dropProto(e, key, offScene)) next = protoOf(e, h, model);
    const neu = await next?.catch(err => { fail(err, `model "${name}"`); return null; });
    if (!old || !neu) continue;
    protoNew.set(old, neu);
    pair(old.obj, neu.obj, name);
  }

  // 4. the scene: batches dissolve first (their InstancedMeshes hold copies of the old geometry) and form again after
  const b = e.batching, batched = !!b?.enabled;
  if (batched) b.enabled = false;
  const count = n => { copies[n] = (copies[n] || 0) + 1; };
  const oldGeo = new Set(geo.keys()), moved = [];
  e.scene.traverse(o => {
    const ud = o.userData;
    // a model() copy whose parts do not pair 1:1 (2 parts became 1) is rebuilt whole from the new load, like the prototype copies below: never a mix of old and new parts
    const rec = a._instances.get(o), whole = rec && structure.has(rec.e.name) ? a.entries.get(rec.e.name) : null;
    if (whole?.load?.value) {
      const was = new Set(); rec.load.value?.scene?.traverse(x => { for (const p of partsOf(x)) was.add(p); });
      const known = new Set(); rec.load.value?.scene?.traverse(x => { if (x.name) known.add(x.name); });
      rebuildCopy(a, o, rec.e.name, whole.load.value.scene, whole.load.value.animations, c => {
        let old = false; c.traverse(x => { if (partsOf(x).some(p => was.has(p))) old = true; });
        if (old) c.traverse(x => { if (x.name && !known.has(x.name)) warnOnce(`asset hot swap: the parts of "${rec.e.name}" changed, so its copies were rebuilt; objects you attached inside them ("${x.name}") were dropped. Attach them again in onModel`); });
        return old;
      }, count, fail);
    }
    // content copies: later aligns read the new size, measured once their parts are swapped below
    if (ud?.proto && protoNew.has(ud.proto)) { ud.proto = protoNew.get(ud.proto); moved.push(ud); }
    // a model whose part count changed: the copy root stays (code holds it), its parts from the old prototype are replaced by the new ones
    if (ud?.modelKey && !whole?.load?.value && structure.has(list(JSON.parse(ud.modelKey))[0]) && !o.isMesh) {   // not twice: a model() copy was rebuilt above
      const neu = [...protoNew.values()].find(p => p.obj.userData.modelKey === ud.modelKey);
      if (neu) rebuildCopy(a, o, list(JSON.parse(ud.modelKey))[0], neu.obj, neu.obj.animations, c => meshesOf(c).some(m => oldGeo.has(m.geometry)), count, fail);
    }
  });
  const seenMat = new Set();
  e.scene.traverse(o => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const g = geo.get(o.geometry);
    if (g) { o.geometry = g.to; count(g.name); }
    if (Array.isArray(o.material)) o.material = o.material.map(m => mat.get(m)?.to ?? m);
    else if (mat.has(o.material)) { const m = mat.get(o.material); o.material = m.to; if (!g) count(m.name); }
    if (tex.size) for (const m of list(o.material)) {
      if (!m || seenMat.has(m)) continue;
      seenMat.add(m);
      for (const k of Object.keys(m)) { const t = tex.get(m[k]); if (t) { m[k] = t.to; m.needsUpdate = true; count(t.name); } }
    }
  });
  // Leases follow the data: every copy now draws only the new load (a copy whose parts do not pair 1:1 was rebuilt whole above), so its lease moves with it, at this moment
  const stale = [];
  e.scene.traverse(o => {
    const rec = a._instances.get(o), lease = o.userData.lease;
    const next = rec && names.has(rec.e.name) ? a.entries.get(rec.e.name) : null;
    if (next?.load?.value && next.load !== rec.load) { a._instances.set(o, { ...rec, e: next, load: next.load, lease: a._lease(next, undefined, undefined, rec.lease.by) }); stale.push(rec.lease); }
    const own = lease && names.has(lease.name) ? a.entries.get(lease.name) : null;   // content props and pickups lease by name
    if (own?.load?.value) { stale.push(lease); o.userData.lease = a._lease(own, lease.name, undefined, lease.by); }
  });
  // the copy as it stands now (what its setup added stays on it), by the rule content measures every build with: never the bare prototype
  for (const ud of moved) ud.remeasure?.();
  swapped();
  for (const l of stale) l.remove();
  // 5. module hooks: vegetation rebuilds its species from the new models (its materials are patched copies, not found above)
  for (const fn of a._swapHooks ?? []) {
    try { const r = await fn({ names, geometry: geo, material: mat }); for (const [n, k] of Object.entries(r ?? {})) copies[n] = (copies[n] || 0) + k; }
    catch (err) { fail(err, "a module's own copies"); }
  }
  if (batched) b.enabled = true;
  // the old generated builds: what no scene mesh draws any more goes now (a part something still draws, one the swap could not find, waits for dispose)
  if (builds.length) {
    const drawn = new Set(); e.scene.traverse(o => { for (const x of partsOf(o)) drawn.add(x); });
    for (const load of builds) {
      let used = false; load.value?.scene?.traverse(o => { if (partsOf(o).some(x => drawn.has(x))) used = true; });
      if (!used) freeRetired(a, load);
    }
  }

  const report = {
    why, names: [...new Set(changed.map(c => c.name))], copies, ms: Math.round(performance.now() - t0),   // measure
    ...(structure.size && { partsChanged: [...structure] }),
    note: 'collision boxes keep the size they were placed with until the next load',
  };
  remember(e, report);
  return report;
}

/**
 * The one rebuild of a copy whose parts changed (model() copies, content props, pickups): the old parts go through dropCopy (leases, cloned bones, instance buffers),
 * the new ones are cloned (cloneModel), and the same steps a first build runs follow: the game's onModel setup (the copy root is the same object) and the static rays.
 * An Animator drives the old skeleton: it is stopped, and unless the setup made a new one the game animates again (one dev warning). Why not rebind: a Character
 * holds that Animator object and its hooks, and hot reload is a dev aid, so the simplest rule that is never wrong wins.
 */
function rebuildCopy(a, o, name, fresh, clips, isOld, count, fail) {
  const was = a.animatorOf(o);
  if (was) { was.dispose(); a._animators.delete(o); }
  for (const c of [...o.children]) if (isOld(c)) { o.remove(c); a.dropCopy(c); }
  for (const c of [...cloneModel(fresh).children]) { o.add(c); count(name); }   // a copy: add() takes c out of the live list
  o.animations = clips;
  try { a._setup?.(o, name); } catch (err) { fail(err, `onModel for "${name}"`); }
  a.restatic(o);
  if (was && !a.animatorOf(o)) warnOnce(`asset hot swap: "${name}" has new parts, so its animation was stopped (it drove the old skeleton). Call assets.animate() on the copy again, or reload the page`);
}

/** Keep the last swaps for describe().assetSwaps, say it in the console and as a toast (dev aid: the AI and the person both see it) */
function remember(e, r) {
  const a = e.assets;
  if (!a._swaps) {
    a._swaps = [];
    e.describe?.add?.('assetSwaps', () => a._swaps.slice(-3));
  }
  a._swaps.push({ ...r, at: e.clock?.now ?? null });
  if (a._swaps.length > LAST) a._swaps.shift();
  const n = Object.values(r.copies).reduce((s, x) => s + x, 0);
  const text = `asset hot swap (${r.why}): ${r.names.join(', ')} -> ${n} mesh(es) in ${r.ms} ms${r.partsChanged ? ` (parts changed: ${r.partsChanged.join(', ')})` : ''}`;
  note(text);
  try { e.ui?.get?.('toast')?.show({ text, kind: 'info', ms: 1800 }); } catch { /* the toast part may be off */ }
}

/**
 * engine.debug.reloadAssets(packs): register the packs again (the new module of the game's assets.js) and swap what changed. Entries whose
 * build function, url and params are the very objects already registered keep their loaded value: an edited art module re-runs only the modules that
 * import it, so only its generators are new functions.
 * @param {any} e @param {any} packs
 */
export async function reloadAssets(e, packs) {
  const hot = { changed: [] };
  registerManifest(e.assets, packs, hot);
  if (!hot.changed.length) return { why: 'edit', names: [], copies: {}, ms: 0 };
  return swapModels(e, hot.changed, 'edit');
}

/**
 * engine.assets.setParams(name, values): tuned params of a generator (dev panel); the entry keeps them (defaults < tuned < a call's own values)
 * and every copy is built again.
 * @param {any} e @param {string} name @param {Record<string, any>} values
 */
export async function setParams(e, name, values) {
  const ent = e.assets.entries.get(name);
  if (!ent?.schema) throw codedError('asset-misuse', `assets.setParams('${name}'): ${ent ? 'this model declares no params schema ({ build, params: { height: { type: \'number\', default: 2 } } })' : 'no model of that name'}`);
  paramValues(ent, values);   // a typo or a wrong type throws here, before anything is rebuilt
  const old = { ...ent };
  ent.tuned = { ...ent.tuned, ...values };
  e.assets._retire(ent);
  return swapModels(e, [{ name, type: 'model', old }], 'params');
}

