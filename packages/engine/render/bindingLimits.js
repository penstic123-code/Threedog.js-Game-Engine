// Sampled textures and samplers of a WebGPURenderer program, counted before three writes its code.
// A shader stage binds at most maxSampledTexturesPerShaderStage textures and maxSamplersPerShaderStage samplers (16 each on most devices). They stack up from
// parts that know nothing of each other: the material's own maps (a ground with 4 layers of color, normal and ARM plus a mask is 13), every shadow-casting
// light's shadow map, the environment map. Over the limit the device's only word is `Invalid PipelineLayout` / a bind group layout error that names no
// material. Counted where every node has asked for its bindings and no code exists yet (the builder's buildCode, as render/vertexInputs.js does): the throw
// lands in three's build-error path, which logs it and draws its plain stand-in instead. Real WebGPU only (the WebGL2 backend has no such limits here).
import { codedError } from '../core/base/errorHints.js';

const STAGES = ['vertex', 'fragment'];
/** @param {any} t a texture @returns {'shadow maps' | 'environment / cube maps' | 'other maps'} three has no flag for "this is the environment": a depth texture is a shadow
 *  map, a texture not mapped as plain UVs (cube, equirect, the PMREM of scene.environment) is an environment */
const kindOf = t => t?.isDepthTexture ? 'shadow maps' : t?.isCubeTexture || (t?.mapping ?? 300) !== 300 ? 'environment / cube maps' : 'other maps';

/**
 * Per shader stage: the sampled textures and the samplers three bound for the program being built, and which textures are shadow maps / environment.
 * three keeps them in builder.bindings[stage][group] (WGSLNodeBuilder.getUniformFromNode): a NodeSampledTexture (isSampledTexture; it extends Sampler, so
 * isSampler is true for it too) and, beside each filterable one, a NodeSampler. Storage textures are no sampled textures (their own limit).
 * @internal render/backend.js watchNodePrograms and tests/vertex-inputs @param {any} builder
 * @returns {Record<string, { textures: number, samplers: number, kinds: Record<string, number> }>}
 */
export function bindingCounts(builder) {
  /** @type {Record<string, { textures: number, samplers: number, kinds: Record<string, number> }>} */
  const out = {};
  for (const stage of STAGES) {
    const c = out[stage] = { textures: 0, samplers: 0, kinds: {} };
    for (const group of Object.values(builder.bindings?.[stage] ?? {})) for (const b of /** @type {any[]} */ (group)) {
      if (b.isSampledTexture) {
        if (b.store) continue;
        c.textures++;
        const k = kindOf(b.texture ?? b.textureNode?.value);
        c.kinds[k] = (c.kinds[k] ?? 0) + 1;
      } else if (b.isSampler) c.samplers++;
    }
  }
  return out;
}

/**
 * @internal render/backend.js watchNodePrograms, for every node program before its code is written.
 * Throws, naming the material and what stacked up, when a stage binds more textures or samplers than the device allows (real WebGPU only) @param {any} builder @param {any} r
 */
export function checkBindingLimits(builder, r) {
  const l = r.backend?.device?.limits;
  if (!l) return;
  const counts = bindingCounts(builder), over = [];
  for (const stage of STAGES) {
    const c = counts[stage];
    for (const [what, n, max] of [['sampled textures', c.textures, l.maxSampledTexturesPerShaderStage], ['samplers', c.samplers, l.maxSamplersPerShaderStage]]) {
      if (n <= max) continue;
      const kinds = Object.entries(c.kinds).map(([k, v]) => `${v} ${k}`).join(', ');
      over.push(`the ${stage} stage binds ${n} ${what}, this device takes ${max}${kinds ? ` (${kinds})` : ''}`);
    }
  }
  if (!over.length) return;
  const m = builder.material, o = builder.object;
  throw codedError('texture-bindings', `[threedog] ${m?.type}${m?.name ? ` '${m.name}'` : ''} (#${m?.id}) on ${o?.type ?? 'object'} '${o?.name || '(unnamed)'}': ${over.join('; ')}. `
    + 'To fit: fewer texture layers, pack maps into one texture\'s channels (roughness / ao / metalness in one ARM texture), fewer shadow-casting lights (castShadow = false), '
    + 'or drop the environment map on this material.');
}
