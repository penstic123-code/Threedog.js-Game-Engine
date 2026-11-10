// Bloom and ambient occlusion (GTAO) as engine.post effects (hdr slot). Both are heavy on weak devices: the game reads engine.tier to decide whether to add them.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { declared } from './about.js';
/** @import { PostEffect } from 'threedog' */

/**
 * bloom()'s strength per unit of UnrealBloomPass strength, for the same picture. Measured 2026-11-03 (tests/post-webgpu, software WebGL2 backend):
 * with strength 0.2 / 0.5 / 1 and radius 0 / 0.5 / 1, a factor of 3 put the screenshot mean within 0.2% of UnrealBloomPass's in all nine cases
 * (1 left it 20-30% darker). Why one factor fits: both sum the same five mips with the same radius lerp; UnrealBloomPass weights them three times higher.
 */
const BLOOM_NODE_STRENGTH = 3;

/**
 * Bloom (glow around bright pixels), hdr slot.
 * @example engine.post.add(bloom({ strength: 0.35, radius: 0.5, threshold: 0.85 }))
 * @param {{ strength?: number, radius?: number, threshold?: number, enabled?: boolean, order?: number }} [o]
 * @returns {PostEffect}
 */
export function bloom({ strength = 0.35, radius = 0.5, threshold = 0.85, enabled, order = 30 } = {}) {
  return { ...declared(bloom), name: 'bloom', slot: 'hdr', order, enabled, params: { strength, radius, threshold },
    create: ({ width, height, params: p }) => new UnrealBloomPass(new THREE.Vector2(width, height), p.strength, p.radius, p.threshold),
    update: (pass, p) => { pass.strength = p.strength; pass.radius = p.radius; pass.threshold = p.threshold; },
    // WebGPU: three's BloomNode returns only the glow, so it is added to the input. Same params do not give the same picture: UnrealBloomPass
    // and bloom() differ in brightness (docs/plans/2026-11-03-webgpu-phase2.md §3), so strength is scaled by BLOOM_NODE_STRENGTH (measured,
    // see above; tests/specs/post-webgpu.mjs keeps the two means within 3%); radius and threshold pass through unchanged (same mip lerp and luminance cut).
    node: (input, { display, p }) => input.add(display.bloom(input, p.strength.mul(BLOOM_NODE_STRENGTH), p.radius, p.threshold)) };
}

/**
 * Ambient occlusion (soft contact shadows in corners; heavy on weak devices), hdr slot. radius: how far a surface looks for
 * occluders, in world units; intensity: 0 = none, 1 = full. Defaults are three's GTAOPass defaults (no look chosen here).
 * Order 20 puts it before bloom (30), so bloom sees the darkened corners. Other GTAOPass settings: post.object().
 * @example engine.post.add(ao({ radius: 0.5 }))
 * @param {{ radius?: number, intensity?: number, enabled?: boolean, order?: number }} [o]
 * @returns {PostEffect}
 */
export function ao({ radius = 0.25, intensity = 1, enabled, order = 20 } = {}) {
  // update in place: GTAOPass keeps its targets and noise, so changing radius never rebuilds it
  const update = (pass, p) => { pass.updateGtaoMaterial({ radius: p.radius }); pass.blendIntensity = p.intensity; };
  return { ...declared(ao), name: 'ao', slot: 'hdr', order, enabled, params: { radius, intensity }, update,
    create: ({ scene, camera, width, height, params }) => { const pass = new GTAOPass(scene, camera, width, height); update(pass, params); return pass; },
    // WebGPU: GTAONode on the scene pass's depth (normals reconstructed from depth), its .r darkens the color; intensity mixes toward no AO as blendIntensity does
    node: (input, { display, scenePass, camera, tsl, p }) => {
      const n = display.ao(scenePass.getTextureNode('depth'), null, camera);
      n.radius = p.radius;
      return tsl.vec4(input.rgb.mul(tsl.mix(tsl.float(1), n.getTextureNode().r, p.intensity)), input.a);
    } };
}

// the picture menu facts of each effect (about.js says why they sit on the factory)
bloom.about = { cost: 'medium', on: 'engine.post.add(bloom())', recipe: 'recipes/52-around-the-picture.md "Post effect chain"', limits: 'glows by brightness alone (no per-object choice); reads the light before exposure', acts: 'glow' };
ao.about = { cost: 'high', on: 'engine.post.add(ao())', recipe: 'recipes/52-around-the-picture.md "Post effect chain"', limits: 'screen space: nothing off screen or hidden behind darkens, thin edges get a halo', acts: 'ao' };
