// TSL pcss(): a shadow filter whose edge softens with the distance from caster to receiver (percentage-closer soft shadows), for light.shadow.filterNode.
// The game assigns it; the engine never does: light.shadow.filterNode = pcss({ lightSize: 0.04 }).
// Why comparisons only, with no raw depth read: the shadow map keeps three's compare sampler, which WebGL2 refuses to read as plain depth
// (a sampler type that disagrees with the texture's compare mode fails the draw) and which sunShafts reads too. So the blocker search asks
// "is a caster at least t nearer the light here?" at four depths t and adds the answers up: the area under that curve is the average distance.
// Each t is jittered inside its band (per tap and pixel), so on average the estimate is continuous: a sloped caster's edge widens smoothly, not in four steps.
// Directional lights only (orthographic shadow cameras, the engine's cascades included): depth there is linear, so a depth step is a world distance.
import { Fn, Loop, float, texture, reference, screenCoordinate, interleavedGradientNoise, vogelDiskSample, max, min } from 'three/tsl';
import { codedError } from '../../core/base/errorHints.js';

/** @typedef {import('three/webgpu').Node} N */

/**
 * @param {{ lightSize?: number, samples?: number, maxDistance?: number }} [o]
 *   lightSize: how wide the edge grows per world unit between caster and receiver (the sun is about 0.01, a hazy sky 0.05);
 *   samples: taps of the final filter (the search takes half, at least 4); maxDistance: world units from caster to receiver beyond which the edge stops growing.
 * @returns {any} a filter for light.shadow.filterNode
 */
export function pcss({ lightSize = 0.04, samples = 16, maxDistance = 4 } = {}) {
  if (!(lightSize >= 0 && samples >= 1 && maxDistance > 0)) throw codedError('tsl-misuse', `threedog/tsl pcss(): lightSize >= 0, samples >= 1 and maxDistance > 0 (got ${lightSize}, ${samples}, ${maxDistance})`);
  const taps = Math.round(samples), search = Math.max(4, taps >> 1);
  // depths asked in the search, squared steps so a caster close to its receiver (the hard part) is told apart finely
  const steps = [1, 2, 3, 4].map(k => maxDistance * (k / 4) ** 2);
  return Fn(/** @param {any} a @param {any} builder */ ({ depthTexture, shadowCoord, shadow, depthLayer }, builder) => {
    const cam = shadow.camera;
    if (!cam.isOrthographicCamera) throw codedError('tsl-misuse', 'threedog/tsl pcss(): only for a DirectionalLight (an orthographic shadow camera); a spot or point light keeps three\'s filter');
    const lit = (/** @type {N} */ uv, /** @type {any} */ z) => { let d = /** @type {any} */ (texture(depthTexture, uv)); if (depthTexture.isArrayTexture) d = d.depth(depthLayer); return d.compare(z); };
    // per world unit, in shadow-map depth (0 at near, 1 at far, flipped with a reversed depth buffer) and in shadow-map uv (the camera's width)
    const perUnit = float(builder.renderer.reversedDepthBuffer ? -1 : 1).div(reference('far', 'float', cam).sub(reference('near', 'float', cam)));
    const width = reference('right', 'float', cam).sub(reference('left', 'float', cam)).div(reference('zoom', 'float', cam));
    const texel = float(1).div(reference('mapSize', 'vec2', shadow).x);
    const ign = interleavedGradientNoise(screenCoordinate.xy), phi = ign.mul(6.283185307);
    // blocker search over the widest edge that can occur here
    const blocked = float(0).toVar(), gap = float(0).toVar();
    const reach = float(lightSize * maxDistance).div(width).max(texel);
    Loop(search, ({ i }) => {
      const uv = shadowCoord.xy.add(vogelDiskSample(i, search, phi).mul(reach));
      blocked.addAssign(lit(uv, shadowCoord.z).oneMinus());
      for (let k = 0; k < 4; k++) {
        const from = steps[k - 1] ?? 0, band = steps[k] - from, u = ign.add(float(i).mul(4).add(k).mul(0.618034)).fract();
        gap.addAssign(lit(uv, shadowCoord.z.sub(perUnit.mul(u.mul(band).add(from)))).oneMinus().mul(band));
      }
    });
    const distance = gap.div(max(blocked, 1e-4));
    // edge width in shadow-map uv, never under one texel; then plain percentage-closer filtering at that width
    const radius = min(distance.mul(lightSize).div(width), reach).max(texel);
    const sum = float(0).toVar();
    Loop(taps, ({ i }) => { sum.addAssign(lit(shadowCoord.xy.add(vogelDiskSample(i, taps, phi).mul(radius)), shadowCoord.z)); });
    return sum.div(taps);
  });
}
