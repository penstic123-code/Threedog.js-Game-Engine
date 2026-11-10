// Where a post effect definition can run: one rule for the chain (PostFX _held, postWebGL / postWebGPU when they refuse one) and the picture
// menu (core/inspect/pictureMenu.js), so the menu's "runs here" never disagrees with what the chain does. Its own file: postWebGPU.tsl.js
// and core/inspect read it without importing the whole chain.
import { isWebGPU, backendName } from './backend.js';

/** The warning for a pass or node that converts to display colour itself while the engine's output stage does it too (PostFX.add, postWebGPU build). @param {string} what */
export const OUTPUT_TWICE = what => `post effect '${what}' converts to display colour itself (gamma / renderOutput), and the engine's output stage (tone mapping + output color space) runs too, so the picture is converted twice. ` +
  "If it is meant to BE the output stage, add it with { slot: 'tone' } (it replaces the engine's); otherwise remove the conversion from it";

/** WebGLRenderer runs it: a create() (a three.js Pass) or a GLSL fuse snippet @param {any} d */
export const runsOnWebGL = d => typeof d.create === 'function' || !!d.fuse?.glsl;
/** WebGPURenderer runs it: a node(), or a fuse with a tsl part @param {any} d */
export const runsOnWebGPU = d => (d.fuse ? typeof d.fuse.tsl === 'function' : typeof d.node === 'function');

/**
 * Whether an effect definition can run on this engine's renderer now: null = yes, { held: true, why } = the device or tier holds it (the game's
 * value stays), { held: false, why } = it cannot run on the renderer the game chose (switching it on throws by name).
 * @param {{ create?: any, node?: any, fuse?: any, backend?: string, skipOnLowTier?: boolean }} d @param {any} e @returns {{ held: boolean, why: string } | null}
 */
export function runsHere(d, e) {
  const r = e.renderer, gpu = isWebGPU(r);
  if (!gpu && !runsOnWebGL(d)) return e.post?._fellBack
    ? { held: true, why: 'this device has no WebGPU (start() fell back to WebGLRenderer)' }
    : { held: false, why: 'WebGPU only, and the game chose WebGLRenderer (switching it on throws)' };   // before the tier: the mistake must show on every machine
  if (gpu && !runsOnWebGPU(d)) return { held: false, why: d.fuse ? 'its fuse is GLSL only; WebGPURenderer needs fuse.tsl (switching it on throws)'
    : 'it has create() only; WebGPURenderer needs node() (switching it on throws)' };
  if (d.backend === 'webgpu' && gpu && backendName(r) !== 'webgpu') return { held: true, why: r.backend?.parameters?.forceWebGL
    ? "needs three's WebGPU backend; the game chose WebGL2 (forceWebGL: true)"
    : "needs three's WebGPU backend; this device has none, so WebGPURenderer runs on its WebGL2 fallback" };
  if (d.skipOnLowTier && e.tier === 'low') return { held: true, why: "engine.tier is 'low' and the effect declares skipOnLowTier" };
  return null;
}
