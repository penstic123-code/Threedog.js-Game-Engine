// Small shared helpers
import * as THREE from 'three';
import { codedError } from './errorHints.js';

// API convention: a position is one argument. The old (x, z, ...) form arrives as a number; throw with the fix (otherwise it silently becomes the origin)
const STRINGS = { position: 'A position must be passed as one argument: Vector3 / object / [x, y, z] / { x, z } (see the API conventions); got ' };
const POS_ERR = STRINGS.position;
/**
 * The one bad-position error. It carries the value: an op tells a bad argument (refused) from a bad value of its own making (a bug, reported) by it.
 * @param {string} message @param {any} value @param {ErrorConstructor} [Type] @internal
 */
export const badPosition = (message, value, Type) => Object.assign(codedError('bad-position', message, Type), { value });
// A horizontal position missing x or z (a 2-element [x, z] array reads z as undefined; { x, y } has no z) would become 0 silently
// (player.placeAt([10, 20]) at z = 0): say which part is missing and how to write it
const MAX_COORD = 1e9;
const VEC_ERR = 'A position or vector needs finite numbers in every part; got ';
const XZ_ERR = 'A horizontal position needs finite x and z: pass [x, y, z] (a 2-element [x, z] array does not work) or { x, z }; got ';

/** Round to one decimal (describe, budget reports) @param {number} v @returns {number} */
export const r1 = v => Math.round(v * 10) / 10;

const _vp = new THREE.Matrix4();
/**
 * The camera's view frustum for culling math, read with the camera's own depth convention. Why: THREE.Frustum defaults to WebGL clip depth (-1..1);
 * a WebGPU camera (or one with reversed depth) has a different near plane, so a default frustum calls things drawn that the near plane cuts.
 * The three inspect checks and the chunk stream share this one, so they agree with what the renderer culls.
 * @param {any} cam @param {THREE.Frustum} [out] @returns {THREE.Frustum}
 */
export function cameraFrustum(cam, out = new THREE.Frustum()) {
  cam.updateMatrixWorld();   // also refreshes cam.matrixWorldInverse
  return out.setFromProjectionMatrix(_vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
}
/** Value at share q of the sorted samples (0.5 = median, 0.95 = p95; linear between neighbours), 0 for none. The one helper for "typical frame"
 * readings (module timing, frame time): one long frame (a GC pause, a chunk build) moves a mean, not this @param {ArrayLike<number>} a @param {number} q */
export function quantile(a, q) {
  const s = Array.from(a).sort((x, y) => x - y), n = s.length;
  if (!n) return 0;
  const i = (n - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.min(n - 1, lo + 1)] - s[lo]) * (i - lo);
}
/** @param {ArrayLike<number>} a */
export const median = a => quantile(a, 0.5);

/**
 * Show a value someone set (style post params, exposure, light intensity) without changing it: 4 significant digits, never fewer than
 * the integer part. r1 is for measurements (positions, ms); a set value rounded to one decimal misreports it (bloom 0.25 read as 0.3,
 * contrast 1.12 as 1.1, R5), and a reader then "fixes" a value that was already right. 4 digits only drops float noise (0.30000000000000004).
 * @param {number} v @returns {number}
 */
export const rv = v => (Number.isFinite(v) && v !== 0 ? Number(v.toPrecision(Math.max(4, Math.floor(Math.log10(Math.abs(v))) + 1))) : v);

/** An angle in radians as the same turn in -PI..PI; of a difference, the short way round @param {number} a @returns {number} */
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/** rot / scale of a world record as [x, y, z]: a number is the facing about Y and a uniform scale; an array sets each axis (Euler order XYZ). The one reading,
 *  shared by content models and the editor, so a record turns the same wherever it is read @param {{ rot?: number | number[] }} rec */
export const rotOf = rec => Array.isArray(rec.rot) ? rec.rot : [0, rec.rot ?? 0, 0];
/** @param {{ scale?: number | number[] }} rec @param {number} [mul] */
export const scaleOf = (rec, mul = 1) => (Array.isArray(rec.scale) ? rec.scale : [rec.scale ?? 1, rec.scale ?? 1, rec.scale ?? 1]).map(v => v * mul);

const _world = new THREE.Vector3();
/** Where an Object3D stands: a position argument is a place in the world, and a child's .position is one in its parent's space */
const placeOf = o => (o.parent && !o.parent.isScene ? o.getWorldPosition(_world) : o.position);

/** Normalize a Vector3 / Object3D / [x, y, z] / { x, y, z } into a Vector3. Every part must be a finite number: a NaN let in here reaches the solver, the picture and the save far from the call that made it */
export function vec3(v, out = new THREE.Vector3()) {
  if (v == null || v === false || v === '') return out;
  if (typeof v !== 'object') throw badPosition(POS_ERR + JSON.stringify(v), v, TypeError);
  if (v.isVector3) out.copy(v);
  else if (v.isObject3D) out.copy(placeOf(v));
  else if (Array.isArray(v)) out.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  else out.set(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.z)) throw badPosition(VEC_ERR + `[${out.x}, ${out.y}, ${out.z}]`, v, TypeError);
  return out;
}

/** The height a position names, or undefined when it names none ({ x, z }) */
export function yOf(v) {
  if (v?.isObject3D) v = placeOf(v);
  const y = Array.isArray(v) ? v[1] : v?.y;
  return Number.isFinite(y) ? y : undefined;
}

/** Get the horizontal coordinates [x, z] from a Vector3 / Object3D / [x, y, z] / { x, z } */
export function xzOf(v) {
  if (!v || typeof v !== 'object') throw badPosition(POS_ERR + JSON.stringify(v), v, TypeError);
  if (v.isObject3D) v = placeOf(v);
  const x = Array.isArray(v) ? v[0] : v.x, z = Array.isArray(v) ? v[2] : v.z;
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw badPosition(XZ_ERR + JSON.stringify(v), v, TypeError);
  // Far past float precision (render coordinates are 32-bit): not a place. Worse, the chunk loops (`for (cx = floor(x / size); ...; cx++)`) never advance once x / size passes 2^53, a silent freeze (found by fuzz: pos z = -3.6e178)
  if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) throw badPosition(`A horizontal position must lie within ±${MAX_COORD} (far past that nothing renders or streams correctly, and chunk loops stop advancing); got ` + JSON.stringify(v), v, RangeError);
  return [x, z];
}

