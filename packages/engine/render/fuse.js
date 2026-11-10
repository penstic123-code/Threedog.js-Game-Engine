// Fused post pass. Several effects that each carry a small GLSL snippet (PostEffect.fuse) run as ONE fullscreen pass, so a chain of
// light color effects (LUT, grain, vignette...) costs one read and one write of the screen instead of one per effect.
// Why in the engine: only the engine knows which effects are neighbors in a slot; the effects themselves stay plain data + GLSL.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { codedError } from '../core/base/errorHints.js';
import { NOISE_GLSL } from './effects.js';
/** @import { PostFuse } from './PostFX' */

// Helpers every snippet may call: the engine's one hash / value noise (threedogHash, threedogNoise), so a post effect's random pattern is the
// same as its TSL side's (fx.hash / fx.noise) and as every other effect's
const HELPERS = `${NOISE_GLSL}
#define fxHash threedogHash   // the frozen 1.0 name for post snippets (recipe 52), the same function`;
const EMPTY = { float: () => 0, int: () => 0, vec2: () => new THREE.Vector2(), vec3: () => new THREE.Vector3(), vec4: () => new THREE.Vector4() };

export class FusedPass extends Pass {
  /**
   * @param {{ name: string, params: Record<string, any>, _def: { fuse: PostFuse } }[]} items effect handles, in run order; their
   *   params are read live, so refresh() after a params change is enough
   */
  constructor(items) {
    super();
    this.items = items;
    this.time = 0;
    const uniforms = { tDiffuse: { value: null }, uTime: { value: 0 }, uResolution: { value: new THREE.Vector2() } }, decl = [], body = [], owner = {};
    for (const e of items) {
      const f = e._def.fuse;
      for (const [u, type] of Object.entries(f.uniforms ?? {})) {
        if (u in uniforms) throw codedError('post-effect', `post effect '${e.name}': fuse uniform '${u}' is already taken by ${owner[u] ?? 'the engine'}; prefix your uniform names with the effect name`);
        uniforms[u] = { value: EMPTY[type]?.() ?? null }; owner[u] = `'${e.name}'`;
        decl.push(`uniform ${type} ${u};`);
      }
      body.push(`  { // ${e.name}\n${f.glsl}\n  }`);
    }
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: CopyShader.vertexShader,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uResolution; ${decl.join(' ')}\nvarying vec2 vUv;\n${HELPERS}\n` +
        `void main(){\n  vec4 color = texture2D(tDiffuse, vUv);\n${body.join('\n')}\n  gl_FragColor = color;\n}` });
    this.quad = new FullScreenQuad(this.material);
    this.refresh();
  }
  /** Copy every effect's current values into the uniforms */
  refresh() {
    const u = this.material.uniforms;
    for (const e of this.items) for (const [k, v] of Object.entries(e._def.fuse.values?.(e.params) ?? {})) {
      if (!(k in u)) throw codedError('post-effect', `post effect '${e.name}': fuse.values() returned '${k}', which fuse.uniforms does not declare`);
      u[k].value = v;
    }
  }
  setSize() {}
  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.material.uniforms;
    this.time = (this.time + deltaTime) % 64;   // wrapped so grain keeps its precision in a long session
    u.tDiffuse.value = readBuffer.texture; u.uTime.value = this.time; u.uResolution.value.set(readBuffer.width, readBuffer.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.material.dispose(); this.quad.dispose(); }
}

/**
 * Split an ordered, enabled effect list into entries for the chain: runs of consecutive fuse effects in one slot become one group
 * (an array); an effect whose fuse has reads: true starts a new group because it samples the pass input, which earlier snippets
 * of the same group have not yet changed. Everything else stays as it is.
 * @param {any[]} on
 * @returns {(any | any[])[]}
 */
export function groupFuse(on) {
  const out = [];
  for (const e of on) {
    const f = e._def.fuse, last = out[out.length - 1];
    if (f && Array.isArray(last) && last[0].slot === e.slot && !f.reads) last.push(e);
    else out.push(f ? [e] : e);
  }
  return out;
}

// Only the buffer the scene render wrote holds scene depth: after a pass that swaps buffers, readBuffer.depthTexture is another
// target's (a fullscreen quad's, or stale). A depth reader behind such a pass would silently find nothing, so the chain refuses it.
export function checkDepthOrder(chain) {
  let swapped = null;
  for (const e of chain) {
    if (e._def?.needsDepth && swapped)
      throw codedError('post-effect', `post effect '${e.name}' reads scene depth (needsDepth) but runs after '${swapped}', which swaps buffers, so the depth it would read is not the scene's; ` +
        `give '${e.name}' a lower order or an earlier slot than '${swapped}', or turn one of them off`);
    if (e._impl.needsSwap && !e._impl.keepsDepth) swapped ??= e.name;
  }
}
