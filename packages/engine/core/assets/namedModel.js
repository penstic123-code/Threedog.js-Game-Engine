// A model, used by name: the one path for "a model made in code (or a file), reused by name". Content (props, templates, vegetation), pickups and
// vegetation.define all resolve a model name here, so caching (baked file -> dev cache -> build), the per-name prototype and the shadow rule exist once.
// It lives in core because several modules need it and none of them owns it (content, inventory, vegetation): no module depends on another for it.
import * as THREE from 'three';
import { neutralMaterial } from '../../render/neutral.js';
import { shadowDefaults } from './assetEntry.js';
import { paramValues } from './assetManifest.js';
import { list } from '../base/util.js';
import { keepPart, partsOf } from '../base/freeParts.js';

/**
 * A model name (name or [name, params...]) whose asset entry is a generator (an asset pack's procedural model) goes through assets.cached:
 * name = model name, params count into the cache key. Returns a Promise (geometry or Object3D); null for a file model or an unknown name (assets.model takes those)
 */
export function cachedModel(e, m) {
  const [name] = list(m), fn = e.assets.builder(name);
  if (!fn) return null;
  // every model asked for by name is remembered, so a dev hot swap (core/assets/assetHot.js) can build the same name + params list again
  const made = (e.assets._made ||= new Map());
  (made.get(name) ?? made.set(name, new Map()).get(name)).set(JSON.stringify(m), m);
  const args = builderArgs(e, m);
  // pass the generator function to cached as is (dev cache hashes its source); wrap only when there are several params
  if (args.length < 2) return e.assets.cached(name, fn, args[0]);
  const spread = function (p) { return fn.apply(this, p); };
  spread.toString = () => String(fn);   // the cache keys on the source text: the wrapper's own text never changes, so an edit to fn would keep serving the old model
  return e.assets.cached(name, spread, args);
}

/** What a generator is called with for a model name: a generator with a params schema gets one object, defaults < dev panel values < the call's own object (assetManifest.js paramValues) @internal */
export function builderArgs(e, m) {
  const [name, ...args] = list(m), entry = e.assets.entries.get(name);
  return entry?.schema ? [paramValues(entry, args[0])] : args;
}

/**
 * A vegetation model by name: { geometry } for a generator that returns geometry or for a file model (its first mesh), { model } for a generator
 * that returns an Object3D (one material per mesh kept). content's vegetation table and vegetation.define(name, { model: 'pine' }) both resolve here,
 * so a name means the same thing in data and in code. @internal
 */
export async function vegetationModel(e, m) {
  const r = await (cachedModel(e, m) ?? e.assets.geometry(list(m)[0]));
  // a fresh copy (assets.cached copies its prototype on every call) handed out like a content prop of the same name, so the game's onModel
  // (its own materials, say) is on the meshes vegetation then copies; a bare geometry has no materials for it to change
  return r?.isObject3D ? { model: e.assets.handOut(r, list(m)[0]) } : { geometry: r };
}

// One prototype per model name: a generator entry -> assets.cached (baked file / dev cache); a file entry -> assets.model. Content names models only (no paths).
// The only entry for "reuse a code-made model by name": content props / templates / vegetation and ground pickups all take it from here, so cache, bake and shadow rules exist once.
// Who owns a prototype (design.md 6.2): engine.assets, one per model key and palette, shared by every consumer. A consumer (content, pickups) is a holder:
// it asks through protoOf and lets go with holdProtos(e, holder), which it ctx.tracks, so unloading it gives back what it held. A file prototype is a bare
// copy holding a lease (Assets._copy); the last holder letting go, a palette write and a hot swap all drop it through dropProto, which returns that lease,
// so assets.release / trim can free the model afterwards. Why not one table per consumer: it would hold two copies of one model and keep an unloaded consumer's table.
/** engine.assets' prototype table: model key -> { promise, palette, holders } (holders: the consumers that asked for it, any object as the key) */
const table = e => (e.assets._protos ||= new Map());
/** Every prototype of this engine as [key, slot]. For core/assets/assetHot.js @internal */
export const protoSlots = e => [...table(e)];
/**
 * The prototype leaves the table and gives back its lease once its build settles (a generator's prototype holds none: assets.cached pins it). Returns the
 * slot's holders, so a rebuild (palette, hot swap) keeps them. after: hold the lease until that promise settles (a hot swap pairs old parts with new first) @internal
 */
export function dropProto(e, key, after = null) {
  const slot = table(e).get(key);
  if (!slot) return new Set();
  table(e).delete(key);
  slot.promise.then(p => Promise.resolve(after).then(() => retire(e, p)), () => {});
  return slot.holders;
}
// What a prototype makes itself (the neutral material around a bare geometry) is the table's from build to free, held with keepPart so engine.remove and the
// engine.dispose walk leave it; no asset load owns it. A retired one that copies still draw (a palette write leaves placed props as they are) waits here
// until its last copy leaves: content and pickups report each copy that leaves (copyLeft), which frees the ones nothing draws any more.
/** Retired prototypes' parts that copies still draw: part -> its hold */
const deferredOf = e => (e.assets._deferredParts ||= new Map());
/** A retired prototype gives back its lease, and what it made waits for its last copy (sweep) */
function retire(e, p) {
  e.assets._giveBack(p.obj);
  for (const h of p.made) deferredOf(e).set(h.part, h);
  sweep(e);
}
/** Free each waiting part no scene object draws any more */
function sweep(e) {
  const d = deferredOf(e);
  if (!d.size) return;
  const drawn = new Set(); e.scene.traverse(o => { for (const x of partsOf(o)) drawn.add(x); });
  for (const [x, h] of [...d]) if (!drawn.has(x)) { d.delete(x); h.remove(); x.dispose(); }
}
/** A prototype's copy left the scene (content, pickups call it): once per task, the waiting parts it may have been the last to draw are freed @internal */
export function copyLeft(e) {
  const a = e.assets;
  if (!deferredOf(e).size || a._sweepQueued) return;
  a._sweepQueued = true;
  queueMicrotask(() => { a._sweepQueued = false; if (!e.disposed) sweep(e); });
}
/** engine.dispose (Assets.dispose): what every prototype made goes, live or waiting, each once @internal */
export function disposeProtos(e) {
  for (const [x, h] of deferredOf(e)) { h.remove(); x.dispose(); }
  deferredOf(e).clear();
  for (const slot of table(e).values()) slot.promise.then(p => { for (const h of p.made) { h.remove(); h.part.dispose(); } }, () => {});
  table(e).clear();
}
/** Holders that let go, per engine: a later protoOf from one is refused (its module is gone, and nobody would give back what it took) */
const closedOf = e => (e.assets._closedHolders ||= new WeakSet());
/** Never settles: what a refused protoOf answers, as a wait in a disposed engine does (assetEntry.js), so the late caller's code after it never runs */
const NEVER = new Promise(() => {});
/**
 * A consumer's hold on the prototypes it asks for, opened here (again, for a module installed anew): remove() closes it, lets go of each prototype, and one
 * that no other consumer holds is dropped (dropProto). ctx.track it @internal
 */
export function holdProtos(e, holder) {
  closedOf(e).delete(holder);
  return { remove() {
    closedOf(e).add(holder);
    for (const [key, slot] of [...table(e)]) if (slot.holders.delete(holder) && !slot.holders.size) dropProto(e, key);
  } };
}
/**
 * The shared prototype of a model name (or [name, ...params]): { obj, size, center, fromGeometry }. fromGeometry: the generator returned a bare
 * geometry, wrapped here in a mesh of neutral gray; a caller with a material of its own (pickups) swaps that one. holder: who asks; it lets go with holdProtos. @internal
 */
export function protoOf(e, holder, model) {
  if (closedOf(e).has(holder)) return NEVER;   // a build that resumed after its module unloaded: it takes nothing, so nothing is left unreturned
  const key = JSON.stringify(model), palette = e.assets.builder(list(model)[0]) ? e.assets._paletteKey : null;
  let slot = table(e).get(key);
  // a palette written since this prototype was built: the next placement builds again, the same rule assets.cached has by its key; the holders carry over
  const holders = slot && slot.palette !== palette ? dropProto(e, key) : null;
  if (!slot || holders) table(e).set(key, slot = { promise: buildProto(e, model, key), palette, holders: holders ?? new Set() });
  slot.holders.add(holder);
  return slot.promise;
}

/** One build of a prototype: the generator's result (a bare geometry wrapped in a neutral mesh) or a bare copy of the file, measured once */
function buildProto(e, model, key) {
  const gen = cachedModel(e, model), made = [];   // made: holds on what this prototype makes itself (see deferredOf)
  return (gen ? gen.then(r => {
    const p = r.isObject3D ? r : new THREE.Mesh(r, neutralMaterial('prop', { vertexColors: !!r.attributes.color }));
    if (!r.isObject3D) made.push(keepPart(p.material));
    if (!r.isObject3D) p.userData.fromGeometry = true;
    // the generator's own castShadow / receiveShadow are kept (a decal or flat rug that must not cast); the manifest entry can set them;
    // a generator that set none gets cast + receive. Same rule as assets.model (core/assets/assetEntry.js shadowDefaults)
    return shadowDefaults(p, e.assets.entries.get(list(model)[0])?.opts);
  }) : e.assets._bare(list(model)[0], {}, 'prototype')).then(obj => {   // bare: the prototype is never shown, each clone of it gets the onModel setup
    const box = new THREE.Box3().setFromObject(obj);   // collision and the "build within what distance" check both use the prototype's bounding box, computed once
    obj.userData.modelKey = key;   // copies carry it (clone copies userData): a hot swap whose new model has other parts finds them by it
    return { obj, size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()), fromGeometry: !!obj.userData.fromGeometry, made, from: e.assets._instances.get(obj) ?? null };
  });
}

/**
 * A lease for a copy cloned from this prototype, on the load the prototype itself came from, taken in the same step as the clone. Why not assets.lease(name): the name may
 * point at another load by then (a hot swap, a pack registered again), and the copy would hold data it does not draw. Null for a generator's prototype (pinned) @internal
 */
export const protoLease = (e, proto, by) => proto.from ? e.assets._lease(proto.from.e, proto.from.e.name, proto.from.load, by) : null;
