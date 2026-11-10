// Baked light probes. A grid of SH probes from the scene (bake / load / JSON) that every lit pixel samples for itself.
// How the light reaches materials: three's probe grid (LightProbeGridWebGL on WebGLRenderer, LightProbeGrid on WebGPURenderer) is a light in the
// scene whose 3D texture both renderers' lighting already reads, so nothing is patched and nothing runs per frame. handle.grid is that plain object.
// Why the engine keeps its own copy of the grid (handle.sh, half precision): three bakes the WebGL grid into a 32-bit float target. Measured on a
// fast GPU that costs +0.6 ms a frame against +0.03 ms in half precision, and float linear filtering is missing on many phones (the light goes
// black there). So the bake target is read back and thrown away, and what draws is a half-float Data3DTexture built from handle.sh, for a bake and a
// file alike. One path also means a shipped file looks like the bake it came from, on either renderer. It is three's atlas layout rebuilt by hand:
// tests/specs/probes.mjs compares the two pictures, so a three.js update that changes the layout fails there.
// Probes sit ON the bounds and the grid's box reaches half a step past them: three puts probes at cell centers, and it tests a pixel half a cell along
// its normal, so a roof exactly at bounds.max would fall outside a box that stops there (the black band on the roofs in the trial).
import { engineOwned } from '../core/scene/things.js';
import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/addons/lighting/LightProbeGridWebGL.js';
import { readParams } from '../core/base/params.js';
import { codedError, coded } from '../core/base/errorHints.js';
import { warnOnce, fmt } from '../core/base/validate.js';
import { vec3 } from '../core/base/math.js';
import { isWebGPU, webgpuPart, freshFrame, readLayer, onRendererSwap } from './backend.js';
import { mats, lit } from './lit.js';
import { litTwice } from '../core/inspect/pictureChecks.js';

const FORMAT = 'threedog-probes', VERSION = 2, MAX_PROBES = 4096, SH = 27;
const CHUNK = 8;        // probes baked per turn of the event loop, so the page keeps drawing during a long bake
const ATLAS = 7;        // three's atlas: 7 RGBA sub-volumes along z, each with one padding slice at both ends
const BAKE = {
  bounds: { type: 'object', desc: 'THREE.Box3 or { min, max } (positions) the grid spans; light reaches half a step past it, outside there is none' },
  spacing: { type: 'number', min: 0.01, desc: 'largest distance between neighbour probes, meters' },
  resolution: { type: 'int', default: 8, min: 4, max: 32, desc: "cube face size in px per probe (SH keeps only low frequencies; three's projection shader unrolls over every pixel, so big faces compile slowly)" },
  include: { type: 'function', optional: true, desc: '(object) => bool: meshes that return false are hidden while baking (the player, moving props)' },
  owner: { type: 'string', default: 'game', desc: 'who made the set (describe().render.probes)' },
};
const LOAD = { owner: BAKE.owner };
const STRINGS = {
  bounds: 'engine.bakeProbes({ bounds }): bounds must be a THREE.Box3 or { min: [x, y, z], max: [x, y, z] } with max >= min on every axis; got {got}',
  tooMany: 'engine.bakeProbes(): {n} probes ({dims}) is more than {max}; raise spacing (each probe costs 6 renders)',
  noFloat: 'engine.bakeProbes(): this device cannot render to float textures (EXT_color_buffer_float), which three\'s WebGL bake needs. Bake on a desktop and ship the file: engine.loadProbes(json) works here',
  data: 'engine.loadProbes(json): {why}. Pass what handle.toJSON() returned (format \'' + FORMAT + '\', version ' + VERSION + '), or bake again',
  outside: '{n} lit object(s) reach outside the probe grid ({names}): the part outside gets no probe light and can go black. Widen bounds, or add light there. describe().render.probes lists them',
  filled: 'engine.bakeProbes(): {n} probe(s) saw a pixel that is not a number (a shader dividing by zero or taking pow of a negative; first at {at}) and took the light of their nearest good neighbours. Fix that material, or leave it out with include',
  noLight: 'engine.bakeProbes(): every probe saw a pixel that is not a number, so nothing usable was baked. A material in view writes NaN (a shader dividing by zero or taking pow of a negative): fix it, or leave it out with include',
};
const sets = e => (e._probeSets ??= new Set());

/** Grid layout from bounds + spacing: probes on the bounds, at least 2 per axis. Why 2: three tests a pixel half a cell along its normal, so with one
 * cell on an axis every upward surface above the middle of the box falls outside it. A flat axis gets its 2 layers a spacing apart around the bounds. */
function layout(bounds, spacing) {
  const min = vec3(bounds.min), max = vec3(bounds.max);
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite) || max.x < min.x || max.y < min.y || max.z < min.z) {
    throw codedError('probes-option', fmt(STRINGS.bounds, { got: JSON.stringify({ min, max }) }));
  }
  const origin = [], step = [], counts = [];
  for (const k of ['x', 'y', 'z']) {
    const size = max[k] - min[k], flat = size < Math.max(1e-6, spacing * 1e-6), n = flat ? 2 : Math.ceil(size / spacing - 1e-6) + 1;
    counts.push(n); step.push(flat ? spacing : size / (n - 1)); origin.push(flat ? min[k] - spacing / 2 : min[k]);
  }
  return { origin, step, counts };
}

/** The world box of a grid: the probes plus half a step on every side (what three calls the volume) */
function boxOf({ origin, step, counts }) {
  const lo = i => origin[i] - step[i] / 2, hi = i => origin[i] + (counts[i] - 0.5) * step[i];
  return new THREE.Box3(new THREE.Vector3(lo(0), lo(1), lo(2)), new THREE.Vector3(hi(0), hi(1), hi(2)));
}

/** three's grid for this renderer (it has one class per renderer), placed on the data; not in the scene yet */
function makeGrid(r, d) {
  const Grid = isWebGPU(r) ? webgpuPart('classes', 'a light probe grid').LightProbeGrid : LightProbeGridWebGL;
  const box = boxOf(d), size = box.getSize(new THREE.Vector3());
  const grid = new Grid(size.x, size.y, size.z, ...d.counts);
  box.getCenter(grid.position); grid.updateBoundingBox();
  return grid;
}

/** The half-float atlas three's lighting reads, from sh (probe at (z * ny + y) * nx + x, 27 numbers each, in three's packed order) */
function atlasTexture(sh, [nx, ny, nz]) {
  const padded = nz + 2, row = nx * ny, data = new Uint16Array(row * ATLAS * padded * 4);
  for (let t = 0; t < ATLAS; t++) for (let slice = 0; slice < padded; slice++) {
    const iz = Math.min(nz - 1, Math.max(0, slice - 1));   // the padding slices copy their neighbour, so filtering never reads the next sub-volume
    for (let p = 0; p < row; p++) for (let c = 0; c < 4; c++) {
      const k = t * 4 + c;
      if (k < SH) data[((t * padded + slice) * row + p) * 4 + c] = THREE.DataUtils.toHalfFloat(sh[(iz * row + p) * SH + k]);
    }
  }
  const tex = new THREE.Data3DTexture(data, nx, ny, ATLAS * padded);
  tex.format = THREE.RGBAFormat; tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return tex;
}

/** The bake target back as sh numbers, rounded to half so the bake and its file are the same light.
 * shortcut: reads grid._renderTarget, three gives no public way to the target; a three.js update that renames it fails tests/specs/probes.mjs */
async function readGrid(r, grid, [nx, ny, nz]) {
  const sh = new Float32Array(nx * ny * nz * SH), row = nx * ny, { fromHalfFloat, toHalfFloat } = THREE.DataUtils;
  for (let t = 0; t < ATLAS; t++) for (let iz = 0; iz < nz; iz++) {
    const px = await readLayer(r, grid._renderTarget, nx, ny, t * (nz + 2) + 1 + iz), stride = px.length / ny;   // WebGPU pads its rows
    const half = px instanceof Uint16Array;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) for (let c = 0; c < 4; c++) {
      const k = t * 4 + c, v = px[iy * stride + ix * 4 + c];
      if (k < SH) sh[(iz * row + iy * nx + ix) * SH + k] = fromHalfFloat(half ? v : toHalfFloat(v));
    }
  }
  return sh;
}

/** Bytes as base64: btoa takes a string, and one spread call over a big array overflows the stack */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

/** Visible lit meshes no set fully holds (light counted twice is a picture check: core/inspect/pictureChecks.js). Runs on describe() and when a set is added, never per frame */
function probeChecks(e) {
  const boxes = [...sets(e)].map(s => s.box), b = new THREE.Box3(), outside = [];
  e.scene.traverseVisible(o => {
    if (!o.isMesh || !mats(o).some(lit)) return;
    const src = o.isInstancedMesh ? o : o.geometry;
    if (!src.boundingBox) src.computeBoundingBox();
    b.copy(src.boundingBox).applyMatrix4(o.matrixWorld);
    if (!boxes.some(x => x.containsBox(b))) outside.push(o.name || `${o.type} ${o.id}`);
  });
  return { outside };
}

/**
 * A game's shader can write NaN, and one such pixel in a probe's cube turns all of its numbers to NaN; three's sum cannot skip it: the light of that one pixel is lost, but what the probe stands in is known from its neighbours.
 * So a broken probe takes the mean of the nearest good ones. Good ones only, so the result does not depend on the order. A file must hold finite numbers (readData refuses others).
 * @param {{ sh: Float32Array, counts: number[], step: number[], origin: number[] }} d
 */
function fillBroken(d) {
  const [nx, ny, nz] = d.counts, n = nx * ny * nz, good = [], broken = [];
  const at = i => [(i % nx) * d.step[0], (Math.floor(i / nx) % ny) * d.step[1], Math.floor(i / (nx * ny)) * d.step[2]];
  for (let i = 0; i < n; i++) (d.sh.subarray(i * SH, (i + 1) * SH).every(Number.isFinite) ? good : broken).push(i);
  if (!broken.length) return;
  if (!good.length) throw codedError('probes-data', STRINGS.noLight);
  for (const i of broken) {
    const p = at(i), far = good.map(g => at(g).reduce((s, v, k) => s + (v - p[k]) ** 2, 0)), near = Math.min(...far), from = good.filter((_, k) => far[k] <= near * (1 + 1e-6));
    for (let c = 0; c < SH; c++) d.sh[i * SH + c] = from.reduce((s, g) => s + d.sh[g * SH + c], 0) / from.length;
  }
  const first = at(broken[0]).map((v, k) => +(v + d.origin[k]).toFixed(2));
  warnOnce(coded('probes-check', fmt(STRINGS.filled, { n: broken.length, at: first.join(', ') })));
}

/** A probe set: grid data + the three.js grid in the scene that draws it. Made by bakeProbes / loadProbes only */
class ProbeSet {
  constructor(e, data, { owner, source }) {
    Object.assign(this, { _e: e, origin: data.origin, step: data.step, counts: data.counts, sh: data.sh, owner, source });
    this.count = this.counts[0] * this.counts[1] * this.counts[2];
    /** bake time in ms (null for a loaded set) */ this.bakeMs = data.bakeMs ?? null;
    /** the world box the grid lights */ this.box = boxOf(this);
    this._tex = atlasTexture(this.sh, this.counts);
    /** three's probe grid, a plain light in the scene: priority, visible and (on WebGPU) intensity are the game's; three's WebGL shader ignores intensity */
    this.grid = null;
    this._build();
    // createEngine({ renderer: 'webgpu', fallback: 'webgl' }) changes renderer inside start(): each renderer needs its own grid class
    this._swap = onRendererSwap(e, () => { this.grid.removeFromParent(); this._build(); });
    sets(e).add(this);
  }
  _build() {
    const grid = makeGrid(this._e.renderer, this);
    grid.name = 'probes:' + this.owner; grid.texture = this._tex;
    this._e.scene.add(engineOwned('probes', grid));
    this.grid = grid;
  }
  /**
   * The interpolated SH at a position (trilinear between the 8 grid probes around it; outside the grid the nearest edge). For what the grid does not
   * light by itself: a gameplay "how dark is it here", or a LightProbe of your own.
   * @param {any} pos any position form (Vector3, Object3D, [x, y, z], { x, y, z })
   * @param {THREE.SphericalHarmonics3 | THREE.LightProbe} [target] written in place (a LightProbe's sh); a new SphericalHarmonics3 when omitted
   * @returns {THREE.SphericalHarmonics3}
   */
  sample(pos, target) {
    const sh = target?.isLightProbe ? target.sh : target ?? new THREE.SphericalHarmonics3();
    const v = vec3(pos, this._s ??= new THREE.Vector3()), [nx, ny] = this.counts, c = sh.coefficients;
    const axis = (x, i) => { const n = this.counts[i], t = Math.min(n - 1, Math.max(0, (x - this.origin[i]) / this.step[i])), a = Math.min(n - 2, Math.floor(t)); return [a, a + 1, t - a]; };
    const [x0, x1, fx] = axis(v.x, 0), [y0, y1, fy] = axis(v.y, 1), [z0, z1, fz] = axis(v.z, 2);
    for (const k of c) k.set(0, 0, 0);
    const add = (ix, iy, iz, w) => {
      if (w === 0) return;
      const b = ((iz * ny + iy) * nx + ix) * SH;
      for (let j = 0; j < 9; j++) c[j].x += this.sh[b + j * 3] * w, c[j].y += this.sh[b + j * 3 + 1] * w, c[j].z += this.sh[b + j * 3 + 2] * w;
    };
    for (const [iz, wz] of [[z0, 1 - fz], [z1, fz]]) for (const [iy, wy] of [[y0, 1 - fy], [y1, fy]]) for (const [ix, wx] of [[x0, 1 - fx], [x1, fx]]) add(ix, iy, iz, wx * wy * wz);
    return sh;
  }
  /** World position of probe i @param {number} i @param {THREE.Vector3} [out] */
  point(i, out = new THREE.Vector3()) {
    const [nx, ny] = this.counts, ix = i % nx, iy = Math.floor(i / nx) % ny, iz = Math.floor(i / (nx * ny));
    return out.set(this.origin[0] + ix * this.step[0], this.origin[1] + iy * this.step[1], this.origin[2] + iz * this.step[2]);
  }
  /** Plain data to ship as a file and give to engine.loadProbes (half precision, base64) */
  toJSON() {
    const half = Uint16Array.from(this.sh, v => THREE.DataUtils.toHalfFloat(v));
    return { format: FORMAT, version: VERSION, origin: this.origin, step: this.step, counts: this.counts, half: toBase64(new Uint8Array(half.buffer)) };
  }
  /** describe().render.probes row */
  info() {
    const { outside } = probeChecks(this._e);
    return { count: this.count, counts: this.counts, step: this.step.map(s => Math.round(s * 100) / 100), source: this.source, owner: this.owner,
      outside: { count: outside.length, names: outside.slice(0, 3) }, ...(this.bakeMs != null ? { bakeMs: Math.round(this.bakeMs) } : {}) };
  }
  /** Take the grid out of the scene and free its texture; the data stays readable (sample, toJSON). Safe to call twice */
  remove() {
    if (!sets(this._e).delete(this)) return;
    this.grid.removeFromParent(); this._tex.dispose(); this._swap.remove();
  }
}

/** The debug view: one dot per probe, colored by its average (DC) light, over the real picture */
function drawProbes(e, scene) {
  const list = [...sets(e)], n = list.reduce((s, x) => s + x.count, 0);
  if (!n) return () => {};
  const geo = new THREE.SphereGeometry(0.15, 8, 6), mat = new THREE.MeshBasicMaterial({ toneMapped: false });   // debug overlay only
  const dots = new THREE.InstancedMesh(geo, mat, n), m = new THREE.Matrix4(), p = new THREE.Vector3(), c = new THREE.Color();
  let k = 0;
  for (const s of list) for (let i = 0; i < s.count; i++, k++) {
    dots.setMatrixAt(k, m.makeTranslation(s.point(i, p)));
    const b = i * SH, Y00 = 0.282095;   // the SH constant term times Y00 is the probe's average radiance
    dots.setColorAt(k, c.setRGB(s.sh[b] * Y00, s.sh[b + 1] * Y00, s.sh[b + 2] * Y00));
  }
  dots.name = 'debug:probes'; scene.add(engineOwned('debug', dots));
  return () => { dots.removeFromParent(); geo.dispose(); mat.dispose(); dots.dispose(); };
}
function addSet(e, data, o) {
  e._probeView ??= e.debug?.defineView('probes', { what: 'each light probe as a dot colored by its average light', apply: scene => drawProbes(e, scene) });
  const set = new ProbeSet(e, data, o), { outside } = probeChecks(e), twice = litTwice(e);
  if (outside.length) warnOnce(coded('probes-check', fmt(STRINGS.outside, { n: outside.length, names: outside.slice(0, 3).join(', ') })));
  if (twice) warnOnce(coded('probes-check', twice));
  return set;
}

/** Check a loaded file's shape; every problem is a coded refusal, never a half-applied grid */
function readData(json) {
  const bad = why => codedError('probes-data', fmt(STRINGS.data, { why }));
  if (!json || typeof json !== 'object') throw bad(`got ${typeof json}`);
  if (json.format !== FORMAT) throw bad(`format is ${JSON.stringify(json.format)}`);
  if (json.version !== VERSION) throw bad(`version ${JSON.stringify(json.version)} is not supported`);
  const tri = (k, ok) => { const v = json[k]; if (!Array.isArray(v) || v.length !== 3 || !v.every(ok)) throw bad(`${k} must be 3 numbers, got ${JSON.stringify(v)}`); return v; };
  // 2 per axis and a step above 0: sample() divides by the step, a 0 gave NaN light (a black picture, no error)
  const counts = tri('counts', x => Number.isInteger(x) && x >= 2), origin = tri('origin', Number.isFinite), step = tri('step', x => Number.isFinite(x) && x > 0);
  const n = counts[0] * counts[1] * counts[2];
  if (n > MAX_PROBES) throw bad(`${n} probes is more than ${MAX_PROBES}`);
  if (typeof json.half !== 'string') throw bad(`half must be a base64 string, got ${typeof json.half}`);
  let text;
  try { text = atob(json.half); } catch { throw bad('half is not base64'); }
  if (text.length !== n * SH * 2) throw bad(`half must hold ${n} x ${SH} half floats, got ${text.length} bytes`);
  const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
  const sh = Float32Array.from(new Uint16Array(bytes.buffer), THREE.DataUtils.fromHalfFloat);
  if (!sh.every(Number.isFinite)) throw bad('half holds a value that is not a finite number');
  return { origin, step, counts, sh };
}

/** Mixed into Engine.prototype (core/engine/Engine.js) */
export const probeMethods = {
  /**
   * Bake a grid of light probes from the scene as it is now: three's probe grid renders a cube at every grid point and keeps spherical harmonics, and
   * every lit pixel inside the grid then takes its own interpolated light, on WebGL and WebGPU alike. The grid adds to whatever ambient light the
   * scene has (hemi, environment), which the bake also saw: lower those where the probes take over (a warning and describe().render.probes say so).
   * Outside the grid there is no probe light. A load-time cost, not per frame: 6 renders per probe, a few probes per task so the page keeps drawing;
   * ship the result with `toJSON()` + `engine.loadProbes(json)` instead of baking at every start. Adding a grid recompiles the lit materials once:
   * bake at start-up, not mid-play.
   * @example const probes = await engine.bakeProbes({ bounds: { min: [-20, 0, -20], max: [20, 6, 20] }, spacing: 4, include: o => !o.userData.moving });
   * saveFile('probes.json', JSON.stringify(probes.toJSON()));
   * @param {{ bounds: THREE.Box3 | { min: any, max: any }, spacing: number, resolution?: number, include?: (o: THREE.Object3D) => boolean, owner?: string }} opts
   * @returns {Promise<import('../types/core').ProbeSet>}
   */
  async bakeProbes(opts) {
    const o = readParams('engine.bakeProbes()', BAKE, opts), r = this.renderer;
    const d = layout(o.bounds, o.spacing), n = d.counts[0] * d.counts[1] * d.counts[2];
    if (n > MAX_PROBES) throw codedError('probes-option', fmt(STRINGS.tooMany, { n, dims: d.counts.join(' x '), max: MAX_PROBES }));
    if (!isWebGPU(r) && !r.extensions.has('EXT_color_buffer_float')) throw codedError('probes-option', STRINGS.noFloat);
    const t0 = performance.now();   // measure
    const grid = makeGrid(r, d);
    // Off the round numbers meshes keep their vertices on, by less than light can show: a vertex exactly on a cube camera's plane leaves a software rasterizer no slopes, so a flat-shaded
    // triangle there is NaN (plain three.js too; no real GPU tried shows it). This grid only bakes: the one in the scene is built from the data, unshifted.
    grid.position.addScalar(1.3e-3);
    // hidden while the cubes render: meshes the filter rejects, and every other probe light (an earlier set lighting the capture would count twice)
    const hide = [];
    this.scene.traverse(x => { if (x.visible && (x.isLightProbe || x.isLightProbeGrid || (o.include && (x.isMesh || x.isPoints || x.isLine || x.isSprite) && !o.include(x)))) hide.push(x); });
    try {
      for (let start = 0; start < n; start += CHUNK) {
        for (const x of hide) x.visible = false;
        try {
          freshFrame(r);
          grid.bake(r, this.scene, { cubemapSize: o.resolution, near: 0.05, far: this.camera.far, start, count: Math.min(CHUNK, n - start) });
        } finally { for (const x of hide) x.visible = true; }   // restored before the await, so normal frames never see them hidden
        await new Promise(go => setTimeout(go));
      }
      d.sh = await readGrid(r, grid, d.counts);
      fillBroken(d);
    } finally { grid.dispose(); }
    d.bakeMs = performance.now() - t0;   // measure
    return addSet(this, d, { owner: o.owner, source: 'bake' });
  },
  /**
   * A probe set from a file made by `handle.toJSON()` (no baking), on either renderer whichever one baked it. A wrong shape is refused with code `probes-data` and nothing is added.
   * @example const probes = engine.loadProbes(await (await fetch('probes.json')).json());
   * @param {object} json
   * @param {{ owner?: string }} [opts]
   * @returns {import('../types/core').ProbeSet}
   */
  loadProbes(json, opts) {
    const o = readParams('engine.loadProbes()', LOAD, opts);
    return addSet(this, readData(json), { owner: o.owner, source: 'file' });
  },
};
