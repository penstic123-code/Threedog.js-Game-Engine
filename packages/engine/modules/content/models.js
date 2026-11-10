// Models of placed content records: clone the shared prototype of a model name (core/assets/namedModel.js protoOf, the one path every system uses),
// align it and its collision to the record (props and template instances).
import * as THREE from 'three';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
import { protoOf, copyLeft, protoLease } from '../../core/assets/namedModel.js';
import { wrapLod } from '../../core/assets/assetLod.js';
import { Vector3 } from 'three';
import { cloneModel } from '../../core/base/freeParts.js';
import { list } from '../../core/base/util.js';
import { rotOf, scaleOf } from '../../core/base/math.js';
import { isTilted, layerIgnored } from './rules.js';

const BASE_BAND = 0.2;   // the share of the model's height above the ground that counts as its base

/**
 * Every part with geometry under a model root, with its matrix in model space: frame (the root's own matrix as built) times the local matrices down to the part.
 * Why local matrices and not matrixWorld: a copy already placed (a hot swap measures it again) is measured as built, and two copies of the same parts give the
 * very same numbers, which is what baseOf's cache keys on. A LOD's low levels are left out: they only stand in on screen, collision is the full model's. @internal
 */
function partsOf(root, frame) {
  const out = [];
  const walk = (o, m) => {
    if (o.userData.lodLevel) return;
    if (o.geometry?.attributes?.position) out.push({ o, m });
    for (const c of o.children) { if (c.matrixAutoUpdate) c.updateMatrix(); walk(c, m.clone().multiply(c.matrix)); }
  };
  walk(root, frame);
  return out;
}

/**
 * Where a model stands, in model space: { x, z } centre and width of the base (its larger side, so a plain box keeps the same radius). Takes a prototype or a
 * prepared copy's measure (measureOf), and only a circle collider asks, so box colliders and props without one never walk triangles.
 * Why this measure: the base is the geometry in the lowest fifth of the height above y = 0 (above its lowest point when it floats), clipped from the triangles, because a crown or an arm starts higher, a tall box has no vertex halfway up and a boulder's belly is what walkers hit.
 * Cached per prototype by the parts themselves (geometry and matrix): copies whose setup only swapped materials share the prototype's base, while a setup that
 * thickened the trunk under the same crown gets its own. Overall bounds would not tell those two apart. @internal
 */
export function baseOf(m) {
  if (m.base) return m.base;
  if (!m.parts) { m.obj.updateMatrix(); m.parts = partsOf(m.obj, m.obj.matrix.clone()); }   // a prototype: never placed, its root matrix is its frame
  const cache = ((m.owner ?? m).bases ??= new Map());
  // an instanced part falls back to its own instances' bounds, which its geometry does not name: such a part is not shared
  const key = m.parts.map(({ o, m: at }) => (o.isInstancedMesh || o.isBatchedMesh ? `own${o.id}` : o.geometry.id) + ':' + at.elements.join(',')).join('|');
  if (cache.has(key)) return m.base = cache.get(key);
  const meshes = [], p = new Vector3();
  let bottom = Infinity, top = -Infinity, instanced = false;
  for (const { o, m: at } of m.parts) {
    if (!o.isMesh) continue;
    instanced ||= !!(o.isInstancedMesh || o.isBatchedMesh);
    const pos = o.geometry.attributes.position, xyz = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(at).toArray(xyz, i * 3);
      bottom = Math.min(bottom, p.y); top = Math.max(top, p.y);
    }
    meshes.push({ at: xyz, index: o.geometry.index });
  }
  const low = top > 0 ? Math.max(bottom, 0) : bottom, high = low + (top - low) * BASE_BAND;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const take = (x, z) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  const edge = (at, a, b) => {
    const ay = at[a + 1], by = at[b + 1];
    if (ay >= low && ay <= high) take(at[a], at[a + 2]);
    for (const y of [low, high]) if ((ay - y) * (by - y) < 0) { const t = (y - ay) / (by - ay); take(at[a] + (at[b] - at[a]) * t, at[a + 2] + (at[b + 2] - at[a + 2]) * t); }
  };
  for (const { at, index } of meshes) {
    const n = index ? index.count : at.length / 3, v = i => (index ? index.getX(i) : i) * 3;
    for (let i = 0; i + 2 < n; i += 3) { const a = v(i), b = v(i + 1), c = v(i + 2); edge(at, a, b); edge(at, b, c); edge(at, c, a); }
  }
  // shortcut: instanced parts and models without triangles (points, lines, sprites) use the bounding box; measure their instances if a prop ever needs it
  const { size, center } = m;
  m.base = instanced || x0 > x1 ? { x: center.x, z: center.z, width: Math.max(size.x, size.z) }
    : { x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: Math.max(x1 - x0, z1 - z0) };
  cache.set(key, m.base);
  return m.base;
}

/**
 * Align a built model and its collision to the record (once when built, again after the record moved or rot / scale changed).
 * solid = { collide, static } comes from the prop record, or from the template definition for template instances.
 * A circle stands on the model's base (baseOf); { circle: radius } gives the radius in model meters, so it follows the scale as the model does.
 * mul: a template stage's scale, multiplied onto the record's own scale (the record keeps only its authored scale). @internal
 */
export function settle(e, rec, o, solid, mul = 1) {
  const { x, z } = rec.position, rot = rotOf(rec), sv = scaleOf(rec, mul), ud = o.userData;
  ud.fit = fitOf(rec, mul); ud.shape = shapeOf(rec, mul); ud.holder = holderOf(e, rec);
  const tilted = isTilted(rec);
  if (tilted && solid.collide && !e.collider3d) throw tiltError(rec);
  // ground: false keeps the written height (a floating or hung model); a body's height is the solver's (templates.js addBody). The height comes from the ground, not from play,
  // so it stays out of the save (world.rest), and a ground ray's rounding (1e-16 off a turned level) is no new height: a load would write a change for it
  const y = e.surface(x, z, rec.floor) + (rec.offsetY ?? 0);
  if (rec.ground !== false && !solid.body && Math.abs(rec.position.y - y) > 1e-6 && !e.world.rest(rec.id, { x, y, z })) rec.position.y = y;
  o.position.y = rec.position.y; o.rotation.set(rot[0], rot[1], rot[2]); o.scale.set(sv[0], sv[1], sv[2]);
  ud.unstatic?.remove(); ud.unstatic = null;
  for (const h of ud.colliders.splice(0)) h.remove();
  // a solid prop blocks the camera with its whole mesh, not only its footprint collider: crowns and eaves stand outside the footprint, and no game code should have to say so
  const blocks = !!solid.collide && solid.collide.occluder !== false && solid.occluder !== false;
  if (solid.static !== false && e.rays) { o.updateMatrixWorld(true); ud.unstatic = e.assets.addStatic(o, { occluder: blocks }); }
  if (!solid.collide) return;
  const { collide } = solid, set = typeof collide === 'object' ? collide : null, base = set?.circle !== undefined || collide === 'circle' ? baseOf(ud.measure) : null, layer = set?.layer;
  const size = ud.measure.size.clone().multiply(new THREE.Vector3(...sv));
  // a turned-over solid is held by collider3d, which has no layers: said once, and the prop stops every mover (a world.set that tilts it must not throw mid-game)
  const lost = layerIgnored(rec, collide);
  if (lost) warnOnce(coded('content-layer-ignored', `prop ${JSON.stringify(rec.id ?? rec.model)}: ${lost}`), 'content-layer:' + (rec.id ?? rec.model));
  if (tilted) {   // a turned-over solid is not a footprint on the ground: the three-axis provider holds it (o.quaternion carries the same turn the model has)
    const mid = ud.measure.center.clone().multiply(new THREE.Vector3(...sv)).applyQuaternion(o.quaternion).add(o.position);
    ud.colliders.push(e.collider3d.addSolid(base
      ? { position: [mid.x, mid.y, mid.z], radius: (set?.circle ?? base.width / 2) * Math.max(sv[0], sv[2]) }
      : { position: [mid.x, mid.y, mid.z], size: [size.x, size.y, size.z], rotation: rot }));
    return;
  }
  if (!e.collision) return;
  const c = base ?? ud.measure.center, ox = c.x * sv[0], oz = c.z * sv[2];
  const cx = x + ox * Math.cos(rot[1]) + oz * Math.sin(rot[1]), cz = z - ox * Math.sin(rot[1]) + oz * Math.cos(rot[1]);
  ud.colliders.push(base
    ? e.collision.addCircle({ x: cx, z: cz }, { radius: (set?.circle ?? base.width / 2) * Math.max(sv[0], sv[2]), height: size.y, occluder: blocks, layer })
    : e.collision.addBox({ x: cx, z: cz }, { halfWidth: size.x / 2, halfDepth: size.z / 2, rotation: rot[1], height: size.y, occluder: blocks, layer }));
}
/** Is the model still as settle aligned it, with its collider in the holder installed now (a new one starts empty; with none there is nothing to do yet)? update asks every frame for every built prop, because world.move sends no event @internal */
const fitOf = (rec, mul) => JSON.stringify([rec.position.x, rec.position.z, rec.ground === false ? rec.position.y : null, rotOf(rec), scaleOf(rec, mul)]);
export const fits = (e, o, rec, mul = 1) => { const h = holderOf(e, rec); return (!h || o.userData.holder === h) && o.userData.fit === fitOf(rec, mul); };
const shapeOf = (rec, mul) => JSON.stringify([rotOf(rec), scaleOf(rec, mul)]);
/** The turn and size it was built with still hold (a body moves itself, so its place says nothing) @internal */
export const fitsShape = (o, rec, mul = 1) => o.userData.shape === shapeOf(rec, mul);
/** A tilted solid needs the three-axis provider (collider3d); the same error at load (props.js) and at build, so a mistake shows once, early @internal */
export const tiltError = rec => codedError('content-misuse', `prop ${JSON.stringify(rec.id ?? rec.model)}: collide on a model turned about x or z (rot ${JSON.stringify(rec.rot)}) needs a collider3d provider: install rigid() (or your own collider3d), or set collide: false`);
const holderOf = (e, rec) => isTilted(rec) ? e.collider3d : e.collision;

/** Clone the shared prototype of a model for one record and align it (props and template instances). skeletonClone: a skinned part of a plain clone keeps the prototype's bones and draws where they stand @internal */
export async function buildModel(e, api, rec, model, solid, mul = 1) {
  const proto = await protoOf(e, api, model), name = list(model)[0], lod = rec.lod ?? solid.lod;
  // the record keeps only the word `lod`, so a save holds no level
  const lease = protoLease(e, proto, `content:${rec.id ?? name}`);   // at clone time, before any wait: a hot swap during the LOD wait retires the prototype's own lease
  try {
  const o = lod ? await wrapLod(e.assets, name, cloneModel(proto.obj), { distances: Array.isArray(lod) ? lod : undefined, scale: Math.max(...scaleOf(rec, mul)) }) : cloneModel(proto.obj);
  o.name ||= name; o.userData.name ??= name;
  // one order: copy, the game's setup, measure, then settle registers rays and colliders. A setup that throws gives back what the copy took (Assets.handOut)
  e.assets.handOut(o, name);
  o.updateMatrix();
  const frame = o.matrix.clone();   // before settle places it: what the parts are measured in, now and after a hot swap
  o.userData.proto = proto; o.userData.colliders = [];
  // a hot swap gives the copy new parts and a new prototype (core/assets/assetHot.js): measured again by this same rule, and the next align reads it
  (o.userData.remeasure = () => { o.userData.measure = measureOf(e, o.userData.proto, o, frame); })();
  o.userData.refit = r => { if (!solid.body && !fits(e, o, r, mul)) settle(e, r, o, solid, mul); };   // a body places itself; a stale solid or mul is put right by the presenter's next update
  // a file model only: a generator's prototype is pinned for good (Assets.cached), so nothing could free it. The built prop counts in describe().assets until it is torn down
  o.userData.lease = lease;
  if (rec.batch === false) o.userData.batch = false;   // opt out of engine.batching for this record
  o.position.set(rec.position.x, 0, rec.position.z);   // world puts the model on the record after build; height and collision are aligned here
  settle(e, rec, o, solid, mul);
  return o;
  } catch (err) { lease?.remove(); throw err; }   // a build that fails gives the lease back (handOut gave back the copy's own)
}
/** ctx.feeds: every built solid goes into the holder installed now, so the line after use() reads it. The presenters' update asks the same every frame, for what moved @internal */
export const refit = e => { for (const rec of e.world?.query({}) ?? []) e.world.view(rec.id)?.userData.refit?.(rec); };

/**
 * What collision and bodies measure for one built copy: { obj, size, center } like a prototype, so baseOf takes either. The prototype when no setup ran on the
 * copy; else the copy as prepared, from its parts (partsOf: as built whatever its place now, never a LOD's low levels, so collision is the same with lod on or
 * off). Only the bounds here, cheap (each geometry's own box); the base waits for a circle collider (baseOf). frame: the root's matrix as built (a LOD's is identity) @internal
 */
function measureOf(e, proto, o, frame) {
  if (!e.assets.prepared(o)) return proto;
  const parts = partsOf(o, frame), box = new THREE.Box3(), b = new THREE.Box3();
  // the box three's Box3.setFromObject takes (protoOf measures the prototype with it): an instanced or skinned part's own, else its geometry's
  const own = x => x.boundingBox ?? (x.computeBoundingBox(), x.boundingBox);
  for (const { o: p, m } of parts) box.union(b.copy(p.boundingBox !== undefined ? own(p) : own(p.geometry)).applyMatrix4(m));
  return { obj: o, parts, owner: proto, size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()) };
}

/** Tear down only: geometry and material belong to the shared prototype, the next build clones it again; dropCopy gives back what the copy itself took (LOD levels' leases, Animators, bones) @internal */
export function unbuildModel(e, o) { o.userData.lease?.remove(); o.userData.unstatic?.remove(); for (const h of o.userData.colliders) h.remove(); o.removeFromParent(); e.assets.dropCopy(o); copyLeft(e); }   // copyLeft: a retired prototype's material this copy drew may go now
