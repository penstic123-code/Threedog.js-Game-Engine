// TSL hash() / noise() (GLSL NOISE_GLSL).
// TSL value noise: hash(vec2) / noise(vec2), line for line NOISE_GLSL (render/effects.js threedogHashCell / Step / Hash / Noise).
import { Fn, vec2, uint, fract, floor, mix, floatBitsToUint } from 'three/tsl';
import { HASH } from '../fxNumbers.js';

/** @template {string} T @typedef {import('three/webgpu').Node<T>} N */
const M = uint(HASH.mul);
/** threedogHashCell: the cell floor(p)'s first pcg2d step, as two uints [x, y]. float -> int -> uint: a negative float cast straight to
 * uint clamps to 0 in WGSL, int -> uint keeps the bits on both backends @param {N<'vec2'>} p @returns {[N<'uint'>, N<'uint'>]} */
export const hashCell = p => { const c = floor(p); return [c.x.toInt().toUint().mul(M).add(uint(HASH.add)), c.y.toInt().toUint().mul(M).add(uint(HASH.add))]; };
/** threedogHashStep: the rest of pcg2d's x from a first step, 0 <= value < 1 */
export const hashStep = Fn(/** @param {[N<'uint'>, N<'uint'>]} a */ ([x0, y0]) => {
  const x = uint(x0).toVar(), y = uint(y0).toVar();
  x.addAssign(y.mul(M)); y.addAssign(x.mul(M));
  x.assign(x.bitXor(x.shiftRight(16))); y.assign(y.bitXor(y.shiftRight(16)));
  x.addAssign(y.mul(M));
  return x.bitXor(x.shiftRight(16)).shiftRight(8).toFloat().mul(1 / 2 ** 24);
});
/** threedogHash: pcg2d of p's float bits, any vec2, 0 <= value < 1 (fxNumbers.js HASH says why integers, effects.js why two ways in) */
export const hash = Fn(/** @param {[N<'vec2'>]} a */ ([p]) => {
  const b = /** @type {N<'uvec2'>} */ (/** @type {unknown} */ (floatBitsToUint(vec2(p))));   // @types/three types bitcast as its node class
  const fold = (/** @type {N<'uint'>} */ v) => v.bitXor(v.shiftRight(16)).mul(M).add(uint(HASH.add));   // GLSL b ^= b >> 16 says why
  return hashStep(fold(b.x), fold(b.y));
});
/** threedogNoise: smooth value noise, 0-1; the neighbor cells' first steps are the cell's plus mul (no second conversion) */
export const noise = Fn(/** @param {[N<'vec2'>]} a */ ([p]) => {
  const [x, y] = hashCell(p).map(n => n.toVar()), x1 = x.add(M), y1 = y.add(M), f0 = fract(p), f = f0.mul(f0).mul(f0.mul(-2).add(3));
  return mix(mix(hashStep(x, y), hashStep(x1, y), f.x), mix(hashStep(x, y1), hashStep(x1, y1), f.x), f.y);
});
