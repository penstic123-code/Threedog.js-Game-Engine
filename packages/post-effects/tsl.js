// @threedog/post-effects/tsl: post effects that exist only as TSL nodes, for games that chose WebGPU when they started.
//   import { voxelGI, temporalAA } from '@threedog/post-effects/tsl';
//   engine.post.add(voxelGI({ bounds })); engine.post.add(temporalAA());
// Why a subpath and not the main entry: these import three's vxgi and display nodes, which import three/webgpu; a WebGL game never loads this file, so its bundle stays as it is.
// Everything here is plain three.js plugged into engine.post: voxelGI and sunShafts hand three's node back through setup(), so its settings stay the game's.
// Default order in the hdr slot, low first, one scale with the main entry: voxelGI 2 (the bounce is scene light, so the rest works on it), reflections 3 (it reflects the bounce,
// and dof, ao and bloom then treat a reflection as part of the scene: a reflected lamp blooms), dof 5, outline 10, ao 20, bloom 30,
// sunShafts and lightVolumes 200, autoExposure 800 (after all that adds light: where toneMappingExposure acts), temporalAA 900 (last: it clears the dots of everything before it).
// Tier rule as in index.js: of these voxelGI and reflections declare skipOnLowTier; under load adaptive quality also holds them off as its last step,
// after reflections' declared cheaper params and the resolution (engine.adaptive.steps reorders or drops that). Each effect is held, and describe().render.post says why, on a device where start() fell back to WebGLRenderer;
// voxelGI also on WebGPURenderer's WebGL2 backend. On a WebGLRenderer the game chose, adding any of them throws by name.
import { vxgi } from 'three/addons/lighting/vxgi/VXGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { depthAwareBlend } from 'three/addons/tsl/display/depthAwareBlend.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import { Box3, BoxGeometry, Color, Layers, Mesh, Vector3, VolumeNodeMaterial, QuadMesh, NodeMaterial, RenderTarget, HalfFloatType, FloatType, LinearMipmapLinearFilter } from 'three/webgpu';
import { RESERVED_LAYERS } from 'threedog/layers';
import { codedError } from 'threedog/error-hints';
import { declared } from './about.js';
/** @import { PostEffect } from 'threedog' */

const { lightVolumes: VOLUME_LAYER } = RESERVED_LAYERS;

/**
 * Real-time bounced light from a voxel volume (three's vxgi), added to the scene color in the hdr slot. Only on three's WebGPU backend; held off on low tier.
 * Light may move every frame (three notices); geometry that moves needs a new voxelization, too slow per frame, so keep moving things out of the volume
 * (gi.volume.layers) and call gi.needsUpdate = true only for a rare change. It injects direct light only: sky light stays the game's. Metal counts as diffuse.
 * What occlusion culling hides stays in the volume (its layer is on gi.volume.layers; setup can take it off). Changing any effect of the chain rebuilds the chain, which voxelizes the scene again: a stall.
 * @param {{ resolution?: number, bounds?: import('three').Box3, intensity?: number, occlusion?: number, setup?: (gi: any) => void, order?: number, enabled?: boolean, name?: string }} [o]
 *   resolution: voxels along the longest side; bounds: the part of the world to voxelize (default: the whole scene, so a far sky mesh makes voxels huge);
 *   intensity: how strong the bounce is; occlusion: 0 to 1, how much the voxel occlusion darkens the picture (it darkens direct light too, so it starts at 0);
 *   setup(gi): gets three's VXGINode each time the chain builds it (coneCount, volume.bounces ...).
 * @returns {PostEffect}
 */
export function voxelGI({ resolution = 128, bounds, intensity = 1, occlusion = 0, setup, order = 2, enabled, name = 'voxelGI' } = {}) {
  /** @type {any} */ let gi = null;
  return { ...declared(voxelGI), name, slot: 'hdr', order, enabled, needsBuffers: ['normal', 'diffuse'], params: { intensity, occlusion },
    node(input, ctx) {
      const { tsl, p, scenePass, scene, camera, display } = ctx;
      gi = display.own(vxgi(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), scene, camera, resolution));
      display.own({ dispose() { gi = null; } });
      if (bounds) gi.volume.bounds.copy(bounds);
      setup?.(gi);
      const light = gi.getGINode().rgb.mul(scenePass.getTextureNode('diffuse').rgb).mul(p.intensity);
      return tsl.vec4(input.rgb.mul(tsl.mix(tsl.float(1), gi.getAONode().r, p.occlusion)).add(light), input.a);
    },
    // voxelSize is 0 until the first frame voxelized the scene
    facts: () => (gi ? { resolution, voxelSize: +gi.volume.voxelSizeNode.value.toFixed(3) } : null) };
}

/**
 * Screen-space reflections (three's SSRNode, mirror mode: one ray per pixel, blurred by roughness), added to the scene color in the hdr slot. Held off on low tier.
 * A surface reflects in proportion to its metalness, and one at metalness 0 is skipped (three's early-out): a wet or polished stone floor wants a small metalness.
 * Why reflectNonMetals is not offered: in this mode three weights the ray by metalness, so the flag only spends the rays on surfaces that then add black.
 * It reflects only what is on screen: things behind the camera or off the edge fade out, and the environment map stays the reflection there.
 * Known limit, double counting: where a ray hits, three's lighting has already added the environment's specular to that pixel, and the reflection comes on top of it.
 * three keeps that term inside each material's lighting, never in a buffer, so a post effect cannot take it out; doing it in the lighting would recompile every lit material
 * of the game when the effect is added. Tune by eye: in a closed place lower the reflective materials' envMapIntensity, under open sky lower intensity.
 * @param {{ intensity?: number, maxDistance?: number, thickness?: number, quality?: number, resolutionScale?: number, blurQuality?: number, binaryRefine?: boolean,
 *   setup?: (ssr: any) => void, order?: number, enabled?: boolean, name?: string }} [o]
 *   intensity: how strong; maxDistance: world units, how far a reflected thing may stand from the surface (it fades toward there); thickness: how deep a thing on screen counts
 *   as solid behind its front; quality: 0 to 1, steps per ray (up to 64); resolutionScale: size of the reflection target against the screen. These change in place.
 *   resolutionScale defaults to 0.5: a screen-filling mirror cost +12.5 ms at 1080p at 1 and +2.9 ms at 0.5 on an integrated GPU (docs/testing/perf.md 6b), and the roughness blur hides
 *   the half size; a sharp mirror sets 1. Cost follows the pixel count (pixel ratio too) and grows with maxDistance.
 *   Built into the shader, so set() of them rebuilds the chain: blurQuality (kernel of the roughness blur), binaryRefine (sharper contact where a thing meets the mirror).
 *   setup(ssr): gets three's SSRNode each time the chain builds it.
 * @returns {PostEffect}
 */
export function reflections({ intensity = 1, maxDistance = 5, thickness = 0.1, quality = 0.5, resolutionScale = 0.5, blurQuality = 2, binaryRefine = false,
  setup, order = 3, enabled, name = 'reflections' } = {}) {
  /** @type {any} */ let node = null;
  return { ...declared(reflections), name, slot: 'hdr', order, enabled, needsBuffers: ['normal', 'metalRough'],
    params: { intensity, maxDistance, thickness, quality, resolutionScale, blurQuality, binaryRefine },
    // adaptive quality's first step under load: both change in place (no recompile), and the roughness blur hides most of a quarter-size target
    cheaper: { quality: 0.25, resolutionScale: 0.25 },
    node(input, { tsl, p, params, scenePass, buffer, camera, display }) {
      const mr = buffer('metalRough');   // not scenePass.getTextureNode: with temporalAA on it shares velocity's target
      // the build-time two are read as plain values here, so set() of them rebuilds the chain; the rest are the engine's uniforms, written in place
      node = display.own(ssr(display.texture(input), scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'),
        { metalnessNode: mr.x, roughnessNode: mr.y, binaryRefine: params.binaryRefine, camera }));
      display.own({ dispose() { node = null; } });
      Object.assign(node, { intensity: p.intensity, maxDistance: p.maxDistance, thickness: p.thickness, quality: p.quality, blurQuality: params.blurQuality });
      // three reads resolutionScale as a number at each frame's resize: it reads and writes the live uniform, so set() needs no rebuild and setup's s.resolutionScale = x holds
      Object.defineProperty(node, 'resolutionScale', { get: () => p.resolutionScale.value, set(v) { p.resolutionScale.value = v; } });
      setup?.(node);
      // the result is premultiplied (already weighted by metalness, distance and angle): it adds
      return tsl.vec4(input.rgb.add(node.getTextureNode().rgb), input.a);
    },
    facts: () => (node ? { surfaces: 'metalness above 0, in proportion', target: node._resolution.value.toArray() } : null) };
}

/**
 * Temporal antialiasing (three's TRAANode): averages jittered frames, so it also clears the dots of every stochastic effect before it (voxelGI, lightVolumes).
 * Runs last in the hdr slot. It replaces MSAA while it is on. Moving things can trail; judge it in motion.
 * @param {{ order?: number, enabled?: boolean, name?: string }} [o]
 * @returns {PostEffect}
 */
export function temporalAA({ order = 900, enabled, name = 'temporalAA' } = {}) {
  return { ...declared(temporalAA), name, slot: 'hdr', order, enabled, needsBuffers: ['velocity'],
    // display.texture: traa() would wrap a non-texture input (any effect before it) in a render target of its own that its dispose() leaves behind, two textures per chain rebuild
    node: (input, { scenePass, camera, display }) => display.own(traa(display.texture(input), scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera)) };
}

/**
 * Exposure that adapts like an eye: each frame the log-average brightness of the hdr picture is measured on the GPU (never read back to the CPU, which would stall),
 * and the picture's exposure eases toward key / average, faster one way than the other, inside min..max. A multiply in the hdr slot at 800, after everything that adds light
 * and before temporalAA and tone mapping: where renderer.toneMappingExposure acts, so bloom's threshold reads the scene's own light as before, and the game's
 * toneMappingExposure stays on top as a fixed trim (the effect never writes it). It weighs the whole screen evenly, from a 64x64 sample.
 * @param {{ key?: number, speedUp?: number, speedDown?: number, min?: number, max?: number, order?: number, enabled?: boolean, name?: string }} [o]
 *   key: the average brightness the picture is brought to (0.18 is middle gray); speedUp: how fast exposure rises when the picture gets darker (per second, larger is faster);
 *   speedDown: how fast it falls when it gets brighter (eyes adapt to light faster than to the dark); min, max: the range exposure stays in (narrow it to keep an authored look).
 *   All change in place. The first frame starts at its goal; a chain rebuild keeps the adapted value. Time is engine.time's ambient clock.
 *   Measured from a 64x64 point sample of the picture, so a small very bright thing moving across it can nudge the exposure.
 * @returns {PostEffect}
 */
export function autoExposure({ key = 0.18, speedUp = 1, speedDown = 3, min = 0.1, max = 10, order = 800, enabled, name = 'autoExposure' } = {}) {
  if (!(min > 0 && max >= min)) throw codedError('post-effect', `autoExposure: min must be above 0 and max at least min (got min ${min}, max ${max})`);
  // the adapted value outlives a chain rebuild (another effect added or toggled): its two 1x1 targets stay, so exposure does not snap back to the goal.
  // Float, not half: half's steps near 1 are coarser than one frame's easing at a slow speed, and the value stalled short of the goal
  /** @type {any} */ let S = null;
  return { ...declared(autoExposure), name, slot: 'hdr', order, enabled, params: { key, speedUp, speedDown, min, max },
    node(input, { engine, tsl, p, display, borrowRenderer }) {
      const { vec2, vec4, float, uniform, texture, exp, log, clamp, select, mix } = tsl;
      S ??= { ex: [0, 1].map(() => new RenderTarget(1, 1, { type: FloatType, depthBuffer: false })), i: 0, last: 0, started: false };   // last frame's value and this one's: a target cannot be read while drawn into
      S.built = true;
      // log brightness at 64x64; its mip chain ends in one texel holding the average log: the log-average with no reduction pass of our own
      const lum = new RenderTarget(64, 64, { type: HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: LinearMipmapLinearFilter });
      const measure = new QuadMesh(new NodeMaterial()), adapt = new QuadMesh(new NodeMaterial());
      measure.material.fragmentNode = vec4(log(clamp(tsl.luminance(input.rgb), 1e-4, 6e4)), 0, 0, 1);
      const was = texture(S.ex[S.i].texture, vec2(0.5)), now = texture(S.ex[1 - S.i].texture, vec2(0.5)), dt = uniform(0), fresh = uniform(S.started ? 0 : 1);
      const ok = (/** @type {any} */ x) => x.equal(x).and(x.lessThan(1e30));   // not NaN, not infinite: one bad pixel must not poison every later frame
      const raw = p.key.div(exp(texture(lum.texture, vec2(0.5)).level(6).r)), goal = clamp(select(ok(raw), raw, float(1)), p.min, p.max);
      const before = select(ok(was.r).and(was.r.greaterThan(1e-4)), was.r, goal);
      const k = select(fresh.greaterThan(0), float(1), float(1).sub(exp(dt.mul(select(goal.greaterThan(before), p.speedUp, p.speedDown)).negate())));
      const next = exp(mix(log(before), log(goal), k));   // eased in log steps: a stop up and a stop down take the same time
      adapt.material.fragmentNode = vec4(select(ok(next), next, goal), 0, 0, 1);
      // the output's read of the value draws the two small passes first, once per frame. Time is the engine's ambient clock (the presentation one, core/time/time.js):
      // a stepped or slowed run adapts by the seconds it advanced
      now.updateBeforeType = 'frame';
      now.updateBefore = ({ renderer }) => {
        const t = engine.time.now('ambient');
        dt.value = Math.min(Math.max(t - S.last, 0), 0.25); S.last = t;   // a jump of the clock (a skip, a new game) does not jump the exposure
        // the engine's one borrow (clean: no scene-pass MRT on these quads); it puts the renderer back even when a pass throws
        borrowRenderer(renderer, () => {
          renderer.setRenderTarget(lum); measure.render(renderer);
          was.value = S.ex[S.i].texture; renderer.setRenderTarget(S.ex[1 - S.i]); adapt.render(renderer);
        }, { clean: true });
        now.value = S.ex[1 - S.i].texture; S.i = 1 - S.i; fresh.value = 0; S.started = true;
      };
      display.own({ dispose() {
        lum.dispose(); measure.material.dispose(); adapt.material.dispose();
        // a rebuild calls node() again in the same task; when nothing did (removed, switched off), the kept value goes too
        const mine = S; mine.built = false;
        queueMicrotask(() => { if (S === mine && !mine.built) { for (const t of mine.ex) t.dispose(); S = null; } });
      } });
      return vec4(input.rgb.mul(now.r), input.a);
    } };
}

/**
 * Light shafts from the sun (or a point light) through gaps, from its shadow map (three's GodraysNode), blended over the picture in the hdr slot. The light and the things that make the
 * gaps must cast shadows. It lights the air everywhere the shadow map says is lit, so a big open scene turns to haze: it reads best where most of the air is in shadow (a room with a window).
 * @param {{ light?: any, density?: number, maxDensity?: number, falloff?: number, color?: any, steps?: number, setup?: (rays: any) => void, order?: number, enabled?: boolean, name?: string }} [o]
 *   light: default engine.lights.sun; one that is not in the scene or casts no shadow throws by name; density and maxDensity: how thick the air is, and the ceiling of what one pixel can gather; falloff: how fast the shafts fade away from the light;
 *   setup(rays): gets three's GodraysNode each time the chain builds it.
 * @returns {PostEffect}
 */
export function sunShafts({ light, density = 2, maxDensity = 0.6, falloff = 2, color = new Color(1, 1, 1), steps = 60, setup, order = 200, enabled, name = 'sunShafts' } = {}) {
  return { ...declared(sunShafts), name, slot: 'hdr', order, enabled, params: { density, maxDensity, falloff, color: new Color(color) },
    node(input, { engine, tsl, p, scenePass, camera, display }) {
      const depth = scenePass.getTextureNode('depth'), sun = light ?? engine.lights?.sun;
      // engine.lights.sun exists even under createEngine({ lights: false }), out of the scene; three's own error for a light with no shadow map names nothing
      if (!sun?.parent || !sun.castShadow) throw codedError('post-effect', 'sunShafts: no light to follow; give sunShafts({ light }) a light that is in the scene and casts shadows (default: engine.lights.sun)');
      const rays = display.own(godrays(depth, camera, sun));
      Object.assign(rays, { density: p.density, maxDensity: p.maxDensity, distanceAttenuation: p.falloff });
      rays.raymarchSteps.value = steps;
      setup?.(rays);
      const blended = depthAwareBlend(display.texture(input), rays.getTextureNode(), depth, camera, { blendColor: p.color });
      return tsl.vec4(blended.rgb, input.a);
    } };
}

/**
 * Lit air inside a box: spot light cones and point light glows with their shadows (three's VolumeNodeMaterial), drawn at a fraction of the screen size (scale), blurred and added in the hdr slot.
 * Reads point and spot lights only: three skips lights at infinity, so the sun and directional lights do nothing here (use sunShafts). Dithered, so temporalAA after it clears the pattern.
 * @param {{ bounds: Box3, density?: number, steps?: number, scale?: number, blur?: number, scattering?: (tsl: any, at: { positionRay: any, density: any }) => any, order?: number, enabled?: boolean, name?: string }} o
 *   bounds: the box of air, required (the march covers it, so keep it tight); density: how thick the air is; scale: fraction of the screen size the air is drawn at; scattering: density per point, for smoke or ground fog
 *   (it gets the world position of the sample and the density uniform).
 * @returns {PostEffect}
 */
export function lightVolumes({ bounds, density = 0.3, steps = 16, scale = 0.25, blur = 4, scattering, order = 200, enabled, name = 'lightVolumes' } = /** @type {any} */ ({})) {
  if (!bounds?.isBox3) throw codedError('post-effect', 'lightVolumes: bounds is required, the box of air to light: lightVolumes({ bounds: new THREE.Box3(min, max) })');
  return { ...declared(lightVolumes), name, slot: 'hdr', order, enabled, params: { density },
    node(input, { tsl, p, scene, camera, scenePass, display, borrowRenderer }) {
      const size = bounds.getSize(new Vector3()), mat = new VolumeNodeMaterial();
      mat.steps = steps;
      mat.offsetNode = bayer16(tsl.screenCoordinate);
      mat.scatteringNode = ({ positionRay }) => (scattering ? scattering(tsl, { positionRay, density: p.density }) : p.density);
      mat.depthNode = scenePass.getTextureNode('depth').sample(tsl.screenUV);
      const box = new Mesh(new BoxGeometry(size.x, size.y, size.z), mat);
      bounds.getCenter(box.position);
      box.receiveShadow = true;
      box.layers.set(VOLUME_LAYER);   // not on the view camera: only the small pass below draws it, and voxel GI or probes never take it for geometry
      scene.add(box);
      const layers = new Layers(); layers.set(VOLUME_LAYER);
      const air = display.pass(scene, camera, { depthBuffer: false, samples: 0 });
      air.setLayers(layers); air.setResolutionScale(scale);
      // a pass clears to the scene's background and the renderer's clear color; this one is added over the picture, so it must start from nothing
      const draw = air.updateBefore;
      const lamps = new Set();
      let look = 0;
      air.updateBefore = frame => {
        // three lights a pass only with the lights on its layers; a new lamp is found within half a second
        if (look-- <= 0) { look = 30; scene.traverse(l => { if ((l.isPointLight || l.isSpotLight) && !l.layers.isEnabled(VOLUME_LAYER)) { l.layers.enable(VOLUME_LAYER); lamps.add(l); } }); }
        // three prefers backgroundNode over background, so both go; the engine's one borrow gives them and the clear back
        borrowRenderer(frame.renderer, () => { scene.background = scene.backgroundNode = null; frame.renderer.setClearColor(0x000000, 0); draw.call(air, frame); }, { scene });
      };
      display.own({ dispose() { for (const l of lamps) l.layers.disable(VOLUME_LAYER); box.removeFromParent(); box.geometry.dispose(); mat.dispose(); } });
      return tsl.vec4(input.rgb.add(display.own(gaussianBlur(air.getTextureNode(), blur)).rgb), input.a);
    },
    facts: () => ({ lights: 'point and spot only; the sun does nothing here (sunShafts)' }) };
}

// the picture menu facts of each effect (about.js says why they sit on the factory)
voxelGI.about = { cost: 'high', on: "engine.post.add(voxelGI({ bounds })) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Real-time bounced light (WebGPU games only)"', limits: 'bounce only inside its box; a chain change at or before it voxelizes again (a stall; on WebGPU a change after it keeps it); walls thinner than a voxel leak', webgpuOnly: true, backend: 'webgpu', skipOnLowTier: true };
reflections.about = { cost: 'high', on: "engine.post.add(reflections()) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Reflections"', limits: 'screen space: what is off screen is not reflected; it adds on top of the environment map', webgpuOnly: true, skipOnLowTier: true };
temporalAA.about = { cost: 'medium', on: "engine.post.add(temporalAA()) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Real-time bounced light (WebGPU games only)"', limits: 'smears fast motion a little; replaces MSAA while on', webgpuOnly: true };
autoExposure.about = { cost: 'low', on: "engine.post.add(autoExposure()) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Exposure and the tone curve"', limits: 'weighs the whole screen evenly; bloom ordered before it sees the unexposed light', webgpuOnly: true, acts: 'exposure' };
sunShafts.about = { cost: 'high', on: "engine.post.add(sunShafts({ light: engine.lights.sun })) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Light you can see in the air"', limits: 'one light, which must cast shadows; open daylight turns to haze', webgpuOnly: true };
lightVolumes.about = { cost: 'high', on: "engine.post.add(lightVolumes({ bounds })) from '@threedog/post-effects/tsl'", recipe: 'recipes/34-environment-lighting.md "Light you can see in the air"', limits: 'point and spot lights only (the sun does nothing); dithered, so temporalAA after it', webgpuOnly: true };
