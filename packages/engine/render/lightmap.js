// Baked lightmaps: reads the file `threedog bake light` writes and hands plain three.js what it needs. At run time a lightmap is only
// material.lightMap and a second UV set, so it costs nothing per frame and looks the same on WebGL and WebGPU.
// Why the file carries geometry and not just a picture: the unwrap cuts seams, so a baked mesh has more vertices than the source. Each entry keeps which
// source vertex every new vertex came from, and the mesh is rebuilt from that: the game's own attributes stay the game's, only the layout changes.
// The checks are here because the runtime is where it goes wrong without a word: a mesh that moved keeps light from where it was, a mesh that is not the
// one baked gets its UVs scrambled, and ambient light the bake already saw adds again.
import * as THREE from 'three';
import { readParams } from '../core/base/params.js';
import { codedError, coded } from '../core/base/errorHints.js';
import { warnOnce, fmt } from '../core/base/validate.js';
import { mats } from './lit.js';
import { litTwice } from '../core/inspect/pictureChecks.js';

const FORMAT = 'threedog-lightmap', VERSION = 1, MAGIC = 0x4d4c4454;   // 'TDLM'
const LOAD = { owner: { type: 'string', default: 'game', desc: 'who loaded it (describe().render.lightmap)' } };
const STRINGS = {
  data: 'engine.loadLightmap(file): {why}. Pass the path or bytes of a file `threedog bake light` wrote, or bake again',
  file: "engine.loadLightmap(file): file must be a path (string) or an ArrayBuffer; got {got}",
  fetch: 'engine.loadLightmap({file}): the file could not be read ({why}). Bake it with `threedog bake light`',
  missing: 'lightmap: {n} baked mesh(es) not in the scene or changed since the bake ({names}): they keep their old look. Load after the level is built, or bake again',
  moved: 'lightmap: {n} baked mesh(es) moved since the bake ({names}): baked light stays where it was. Moving things use a probe grid, not a lightmap',
  shared: 'lightmap: a baked mesh shares its material with an unbaked one ({names}): that mesh has no second UV set and samples the map wrongly. Give it its own material',
};

/** Split the file into its table and its binary part; every problem is a coded refusal before anything is touched */
function parse(buf) {
  const bad = why => codedError('lightmap-data', fmt(STRINGS.data, { why }));
  if (buf.byteLength < 8 || new DataView(buf).getUint32(0, true) !== MAGIC) throw bad('this is not a lightmap file');
  const n = new DataView(buf).getUint32(4, true);
  if (8 + n > buf.byteLength) throw bad('the file is cut short');
  let meta;
  try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))); } catch { throw bad('its table is not JSON'); }
  if (meta.format !== FORMAT) throw bad(`format is ${JSON.stringify(meta.format)}`);
  if (meta.version !== VERSION) throw bad(`version ${JSON.stringify(meta.version)} is not supported`);
  if (!Number.isInteger(meta.size) || meta.size < 4 || !Array.isArray(meta.meshes)) throw bad('its table has no size or mesh list');
  const base = (8 + n + 7) & ~7, end = base + meta.size * meta.size * 8;   // 8: the half floats and the 32-bit lists after them need aligned views
  if (end > buf.byteLength) throw bad('the file is cut short');
  // every entry checked here, before load touches the scene: a typed-array view on a bad offset throws, and a value past the list scrambles the mesh,
  // both half-way through the swaps if found there (GPT review l2-render 1)
  const seen = new Set(), views = meta.meshes.map(m => {
    const name = JSON.stringify(m?.name), whole = v => Number.isInteger(v) && v >= 0;
    if (typeof m?.name !== 'string' || seen.has(m.name)) throw bad(`mesh ${name} has no name of its own in the table`);
    seen.add(m.name);
    if (![m.at, m.count, m.indices, m.vertices].every(whole) || m.at % 4 || !Array.isArray(m.matrix) || m.matrix.length !== 16 || !m.matrix.every(Number.isFinite))
      throw bad(`the table entry of mesh ${name} is malformed (at, count, indices, vertices: whole numbers, at a multiple of 4; matrix: 16 numbers)`);
    if (end + m.at + (m.count * 3 + m.indices) * 4 > buf.byteLength) throw bad(`the data of mesh ${name} is cut short`);
    const at = end + m.at, from = new Uint32Array(buf, at, m.count), index = new Uint32Array(buf, at + m.count * 4, m.indices);
    if (from.some(v => v >= m.vertices) || index.some(v => v >= m.count)) throw bad(`the data of mesh ${name} names a vertex past its own list`);
    return { from, index, uv1: new Float32Array(buf, at + (m.count + m.indices) * 4, m.count * 2) };
  });
  return { meta, base, views };
}

/** Unwrapped geometry -> { vertices: the source's count, place: source vertex -> a vertex holding it now, or -1 }. A second file's list speaks of the source, not of the layout the first file left */
const layouts = new WeakMap();

/** The source vertex list in terms of the geometry as it stands; null when a vertex the file names did not survive the earlier layout @param {any} g @param {Uint32Array} from */
function gatherList(g, from) {
  const was = layouts.get(g);
  if (!was) return from;
  const list = from.map(v => was.place[v]);   // Uint32Array: a -1 reads back as the maximum
  return list.some(v => v >= g.attributes.position.count) ? null : list;
}

/** Remember where each source vertex went @param {any} g the new geometry @param {number} vertices the source's count @param {Uint32Array} from the file's list */
function noteLayout(g, vertices, from) {
  const place = new Int32Array(vertices).fill(-1);
  from.forEach((v, i) => { place[v] = i; });
  layouts.set(g, { vertices, place });
}

/** The mesh with the unwrapped layout: every attribute gathered through the source vertex list, the new index, and uv1 */
function relayout(src, from, index, uv1) {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) {
    if (name === 'uv1') continue;
    const n = a.itemSize, out = new /** @type {any} */ (a.array.constructor)(from.length * n);
    for (let i = 0; i < from.length; i++) for (let c = 0; c < n; c++) out[i * n + c] = a.getComponent(from[i], c);
    g.setAttribute(name, new THREE.BufferAttribute(out, n, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  for (const x of src.groups) g.addGroup(x.start, x.count, x.materialIndex);
  g.name = src.name;
  return g;
}

/** One lightmap in the scene: three's plain texture on the baked meshes' materials. Made by loadLightmap only */
class Lightmap {
  constructor(e, meta, texture, owner, file) {
    Object.assign(this, { _e: e, texture, owner, file, size: meta.size, _entries: new Map(), skipped: meta.skipped ?? [], missing: [], backend: meta.backend });
  }
  /** Meshes that moved, mapped materials shared with unmapped meshes, and what adds the light again. Runs on describe() and at load, never per frame */
  _checks() {
    const moved = [], shared = [], onMapped = new Set();
    for (const [o] of this._entries) for (const m of mats(o)) onMapped.add(m);
    this._e.scene.traverseVisible(o => {
      if (o.isMesh && !this._entries.has(o) && mats(o).some(m => onMapped.has(m))) shared.push(o.name || `${o.type} ${o.id}`);
    });
    for (const [o, matrix] of this._entries) {
      o.updateWorldMatrix(true, false);
      if (o.matrixWorld.elements.some((v, i) => Math.abs(v - matrix[i]) > 1e-3)) moved.push(o.name);
    }
    return { moved, shared };
  }
  /** describe().render.lightmap row */
  info() {
    const { moved, shared } = this._checks();
    return { file: this.file, size: this.size, meshes: this._entries.size, owner: this.owner, bakedOn: this.backend, skipped: this.skipped, missing: this.missing, moved, shared };
  }
  /** Take the map off the meshes and free it (the unwrapped geometry stays: it draws the same). Safe to call twice */
  remove() {
    if (this._e._lightmap !== this) return;
    for (const [o] of this._entries) for (const m of mats(o)) if (m.lightMap === this.texture) { m.lightMap = null; m.needsUpdate = true; }
    this.texture.dispose(); this._e._lightmap = null;
  }
}

/** Mixed into Engine.prototype (core/engine/Engine.js) */
export const lightmapMethods = {
  /**
   * Put a baked lightmap on the scene: `threedog bake light` wrote the file from the meshes the game marked `userData.static = true`; this rebuilds each with
   * its second UV set and sets plain `material.lightMap`, on WebGL and WebGPU alike. Call it once the level is built, with its lights as they will be
   * played. Nothing runs per frame. Keep the sun real-time; the ambient light the bake saw (hemisphere, environment) has to go, or it counts twice.
   * A wrong file is refused with code `lightmap-data` and nothing is changed. `material.lightMapIntensity` is yours. describe().render.lightmap says what
   * was skipped or moved; describe().render.checks names light counted twice.
   * @example userData: floor.userData.static = true;   // then: threedog bake light
   * const light = await engine.loadLightmap('light/level.lightmap');
   * hemi.intensity = 0;
   * @param {string | ArrayBuffer} file a path (fetched) or the file's bytes
   * @param {{ owner?: string }} [opts]
   * @returns {Promise<import('../types/core').Lightmap>}
   */
  async loadLightmap(file, opts) {
    const o = readParams('engine.loadLightmap()', LOAD, opts);
    if (typeof file !== 'string' && !(file instanceof ArrayBuffer)) throw codedError('lightmap-data', fmt(STRINGS.file, { got: String(file) }));
    let buf = file;
    if (typeof file === 'string') {
      const res = await fetch(file).catch(err => ({ ok: false, statusText: String(err) }));
      if (!res.ok) throw codedError('lightmap-data', fmt(STRINGS.fetch, { file, why: res.statusText }));
      buf = await res.arrayBuffer();
    }
    const { meta, base, views } = parse(/** @type {ArrayBuffer} */ (buf));
    const tex = new THREE.DataTexture(new Uint16Array(/** @type {ArrayBuffer} */ (buf), base, meta.size * meta.size * 4), meta.size, meta.size, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.channel = 1; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const set = new Lightmap(this, meta, tex, o.owner, typeof file === 'string' ? file : 'bytes'), names = new Map(), swaps = [];
    this.scene.traverse(x => { if (x.isMesh && x.name) names.set(x.name, x); });
    // two steps, so a failure leaves the scene as it was: every new geometry is made first, nothing in the scene touched; only then the old map goes and all swap at once
    try {
      meta.meshes.forEach((m, i) => {
        const mesh = names.get(m.name);
        // the vertex count is what the bake's list was made from: another count means another mesh, and its UVs would be noise
        if (!mesh || mesh.isInstancedMesh || (layouts.get(mesh.geometry)?.vertices ?? mesh.geometry.attributes.position.count) !== m.vertices) { set.missing.push(m.name); return; }
        const { from, index, uv1 } = views[i], list = gatherList(mesh.geometry, from);
        if (!list) { set.missing.push(m.name); return; }
        swaps.push({ mesh, m, from, geometry: relayout(mesh.geometry, list, index, uv1) });
      });
    } catch (err) { for (const x of swaps) x.geometry.dispose(); tex.dispose(); throw err; }
    this._lightmap?.remove();
    for (const { mesh, m, from, geometry } of swaps) {
      const old = mesh.geometry;
      mesh.geometry = geometry;
      noteLayout(geometry, m.vertices, from);
      old.dispose();   // nothing else frees its GPU buffers; a mesh that shares it just uploads it again
      for (const x of mats(mesh)) { x.lightMap = tex; x.needsUpdate = true; }
      set._entries.set(mesh, m.matrix);
    }
    this._lightmap = set;
    const { moved, shared } = set._checks(), twice = litTwice(this), first = l => l.slice(0, 3).join(', ');
    if (set.missing.length) warnOnce(coded('lightmap-check', fmt(STRINGS.missing, { n: set.missing.length, names: first(set.missing) })));
    if (moved.length) warnOnce(coded('lightmap-check', fmt(STRINGS.moved, { n: moved.length, names: first(moved) })));
    if (twice) warnOnce(coded('lightmap-check', twice));
    if (shared.length) warnOnce(coded('lightmap-check', fmt(STRINGS.shared, { names: first(shared) })));
    return set;
  },
};
