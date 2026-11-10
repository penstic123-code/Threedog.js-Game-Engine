// threedog/tsl: the engine's shader functions as TSL Fn for NodeMaterials (WebGPURenderer). Same signatures and meaning as the GLSL
// functions of recipe 43 (#include <threedog_wind> ...): a value tuned on engine.uniforms reads the same in both. Not imported by 'threedog'.
// Each Fn reads the engine uniforms of the engine that owns the renderer compiling it (fails with [tsl-misuse] when there is none).

/** A TSL node (three/tsl); kept loose so this file does not pin three's own node typings */
type Node = any;

/**
 * GLSL vec3 threedogWind(vec3 position, vec3 origin, float amplitude): object-space sway offset, higher vertices sway more.
 * position: object space before the instance transform (positionGeometry); origin: the object's world origin (objectOrigin());
 * amplitude: metres per metre of height. Reads uTime, uWind, uWindFreq.
 * @example
 * mat.positionNode = positionLocal.add(wind(positionGeometry, objectOrigin(), float(0.3)));   // plain Mesh (InstancedMesh: wrap the offset in instanceOffset())
 * @experimental
 */
export function wind(position: Node, origin: Node, amplitude: Node | number): Node;
/**
 * GLSL float threedogCloudShadow(vec3 worldPos): light factor 0-1 under the drifting clouds (1 = no shadow). Reads uTime, uWeatherCloud, uCloudShadow*, uCloudShadowSpeed.
 * @example
 * mat.colorNode = color(0x88aa66).mul(cloudShadow(positionWorld));
 * @experimental
 */
export function cloudShadow(worldPos: Node): Node;
/**
 * GLSL vec3 threedogSeason(vec3 color, int kind): kind 0 foliage, 1 ground; tints by uFoliageTint / uGroundTint (mix mode when uFoliageMix / uGroundMix > 0).
 * A vec4 color is read as its rgb.
 * @example
 * mat.colorNode = season(texture(map), 0);
 * @experimental
 */
export function season(color: Node, kind: Node | 0 | 1): Node;
/**
 * World position of the drawn object's origin (an InstancedMesh: of each instance), vec3. Works for any Mesh / InstancedMesh sharing the material;
 * BatchedMesh throws [tsl-misuse].
 * @experimental
 */
export function objectOrigin(): Node;
/**
 * An object-space offset carried through the drawn instance's rotation and scale (a plain Mesh: the offset as it is). A positionNode runs after the instance transform, so an
 * offset meant for before it, like wind()'s, goes through this. BatchedMesh throws [tsl-misuse].
 * @example
 * mat.positionNode = positionLocal.add(instanceOffset(wind(positionGeometry, objectOrigin(), float(0.3))));
 * @experimental
 */
export function instanceOffset(offset: Node): Node;
/**
 * GLSL float threedogHash(vec2 p): a repeatable random number 0-1 from a 2D position (an integer hash of its bits: the same on WebGL and WebGPU).
 * @experimental
 */
export function hash(p: Node): Node;
/**
 * GLSL float threedogNoise(vec2 p): smooth value noise 0-1, the one behind the engine's clouds and cloud shadows. No uniforms.
 * @example
 * mat.colorNode = color(0x88aa66).mul(noise(positionWorld.xz.mul(0.5)).mul(0.4).add(0.8));
 * @experimental
 */
export function noise(p: Node): Node;
/**
 * engine.uniforms as TSL uniform nodes (uTime, uWind, uWeatherCloud, uFoliageTint, uSunDir, uDaylight ...), cached per engine. They read the same
 * { value } objects, so engine.uniforms.uWind.value = 2 changes GLSL and TSL materials alike.
 * @example
 * const u = uniforms(engine);
 * mat.emissiveNode = color(0xffcc66).mul(float(1).sub(u.uDaylight));
 * @experimental
 */
export function uniforms(engine: { uniforms: object }): Record<string, Node>;
/**
 * GLSL vec4 threedogDetailNoise(vec2 p, int kind, float octaves): kind 0 grain, 1 paper, 2 stroke, 3 dabs; returns (gray rgb, height 0-1).
 * No uniforms: p is any 2D pattern position you choose (world xz times a scale, a uv...). octaves: up to 4 (dabs: 3).
 * @example
 * mat.colorNode = color(0xb09070).mul(detailNoise(positionWorld.xz.mul(4), 1, 2).rgb.mul(2));
 * @experimental
 */
export function detailNoise(p: Node, kind: Node | 0 | 1 | 2 | 3, octaves: Node | number): Node;
/**
 * GLSL vec3 threedogDetailBump(vec3 surfPos, vec3 surfNorm, float h, float k, float faceDir): screen-space bump from a height h, strength k.
 * View space; the result is a normal for material.normalNode.
 * @example
 * mat.normalNode = detailBump(positionView, normalView, detailNoise(positionWorld.xz.mul(4), 0, 2).a, 1, faceDirection);
 * @experimental
 */
export function detailBump(surfPos: Node, surfNorm: Node, h: Node, k: Node | number, faceDir: Node | number): Node;
/**
 * GLSL vec3 threedogWrapDiffuse(float nl, float wrap, vec3 lightColor, float shadow, vec3 albedo): the half-lambert light beyond plain Lambert,
 * to add to directDiffuse. nl = dot(normal, sunDir). Call it from your LightingModel's direct() (lightColor there already carries the shadow: pass shadow 1).
 * @experimental
 */
export function wrapDiffuse(nl: Node, wrap: Node | number, lightColor: Node, shadow: Node | number, albedo: Node): Node;
/**
 * GLSL vec3 threedogShadowTint(vec3 ambient, vec3 tint, float strength, float soft, float nl, float shadow): the ambient with the shaded side's hue moved
 * toward tint (brightness kept). shadow: 1 lit / 0 shadowed (the sun's lightNode.shadowNode); soft: terminator width in n.l.
 * @experimental
 */
export function shadowTint(ambient: Node, tint: Node, strength: Node | number, soft: Node | number, nl: Node, shadow: Node | number): Node;
/**
 * GLSL vec3 threedogRim(vec3 normal, vec3 viewDir, vec3 color, float strength, float power, float shadowSide, float nl): edge light to add
 * (viewDir from the surface to the eye, e.g. normalView and positionViewDirection); shadowSide 1 = only on the side facing away from the sun.
 * @experimental
 */
export function rim(normal: Node, viewDir: Node, color: Node, strength: Node | number, power: Node | number, shadowSide: Node | number, nl: Node): Node;
/**
 * The lighting model for cel bands with colored ramps: assign it to a MeshToonNodeMaterial, whose gradientMap holds the ramp (rampTexture). A shadowed pixel reads the
 * dark end of the ramp, so a cast shadow takes the same flat band and color as the side turned away. Without a gradientMap: two levels, as three's toon.
 * @example
 * const mat = new MeshToonNodeMaterial({ color: 0xe08050, gradientMap: rampTexture([0x4a5a9a, 0xc0c8e0, 0xffffff]) });
 * mat.setupLightingModel = celLighting;
 * @experimental
 */
export function celLighting(): import('three/webgpu').LightingModel;
/**
 * A shadow filter for a DirectionalLight whose edge softens with the distance from caster to receiver (PCSS). The game assigns it before the first frame; it reaches the engine's cascades too.
 * lightSize: edge width per world unit of that distance; samples: filter taps; maxDistance: where the edge stops growing. A spot or point light throws by name.
 * @example
 * sun.shadow.filterNode = pcss({ lightSize: 0.04, samples: 16 });
 * @experimental
 */
export function pcss(o?: { lightSize?: number; samples?: number; maxDistance?: number }): any;

// three reads light.shadow.filterNode on WebGPURenderer (ShadowNode); @types/three does not declare it, so `sun.shadow.filterNode = pcss()` would not type-check
declare module 'three/src/lights/LightShadow.js' {
  interface LightShadow<TCamera extends import('three').Camera = import('three').Camera> {
    /** A TSL shadow filter ({ depthTexture, shadowCoord, shadow, depthLayer }) => float lit, e.g. pcss(); read when the shadow node builds */
    filterNode: any;
  }
}
/**
 * GLSL float threedogWaterWave(vec3 p, float t): the built-in wave sum (height before waveHeight). p = world position * waveScale, t = time * waveSpeed.
 * @example
 * const h = waterWave(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz, uniforms(engine).uTime).toVarying();
 * mat.positionNode = positionLocal.add(vec3(0, h, 0));
 * @experimental
 */
export function waterWave(p: Node, t: Node | number): Node;
/**
 * The built-in water surface as TSL: returns a function with the GLSL signature threedogWaterSurface(base, wave, facing, worldPos, time) -> vec4 (rgb, opacity).
 * Only the parts given exist (depth: shallow / deep by viewing angle or wave height; foam on crests); values are numbers / colors or nodes.
 * wave is waterWave's height, facing = 1 looking straight down.
 * @experimental
 */
export function waterSurface(spec?: { depth?: { shallow?: any, deep?: any, curve?: any, by?: 'view' | 'wave' }, foam?: { color?: any, start?: any, end?: any, opacity?: any }, waveMax?: number }):
  (base: Node, wave: Node, facing: Node, worldPos: Node, time: Node) => Node;
/** The water's fresnel blend: color mixed toward `towards` (the engine uses the fog color) by pow(1 - |viewDir . normal|, 3) * strength, view space @experimental */
export function waterFresnel(color: Node, normal: Node, viewDir: Node, strength: Node | number, towards: Node): Node;
/** lightShaft options: shape and look are the game's; nothing here has a finished look */
export interface LightShaftOptions {
  /** Follow this light every frame: a SpotLight gives position, aim, cone width and colour; a DirectionalLight gives aim and colour (the game places the opening) */
  light?: import('three').SpotLight | import('three').DirectionalLight;
  /** metres from the opening to the far end (default: the spot light's distance, else 4) */
  length?: number;
  /** radius at the opening in m (0.3) */
  radiusTop?: number;
  /** radius at the far end in m (default: from the spot light's angle, else radiusTop) */
  radiusBottom?: number;
  /** beam colour (default: the light's colour, followed live; else white) */
  color?: import('three').ColorRepresentation;
  /** brightness added at the core (1) */
  intensity?: number;
  /** 0 hard sides .. 1 fades to the centre (0.6) */
  softness?: number;
  /** how much dimmer the far end is, 0..1 (0.5) */
  fallOff?: number;
  /** metres over which it fades into walls and floor (0.5); 0 = off and no depth read (fixed at creation) */
  fadeAtGeometry?: number;
  /** metres in front of the camera over which it fades out (1) */
  fadeNear?: number;
  /** drifting dust in the beam, 0..1 (0); off on engine.tier 'low' */
  dust?: number;
  /** dust size: higher = finer (2) */
  dustScale?: number;
  /** dust drift down the beam, m/s (0.3) */
  dustSpeed?: number;
  /** sides of the cone (24) */
  segments?: number;
}
/** The returned beam: a plain Mesh; `shaft` holds its numbers as { value } objects to change live (shape is fixed: make a new one) */
export type LightShaft = import('three').Mesh & { shaft: { color: { value: import('three').Color }; intensity: { value: number }; softness: { value: number };
  fallOff: { value: number }; fadeAtGeometry: { value: number }; fadeNear: { value: number }; dust: { value: number }; dustScale: { value: number }; dustSpeed: { value: number } } };
/**
 * A cheap visible light beam (ceiling hole, window, stage light): an additive open cone, top at the mesh origin pointing down -Y, sides softened by view angle,
 * faded where it meets geometry and near the camera, dimmed (not tinted) by scene fog. Occluders do not cut it (for that: sunShafts / lightVolumes).
 * WebGPURenderer only (both backends); WebGLRenderer throws by name. Add / move / remove it like any mesh; engine.remove frees it.
 * @example
 * const beam = lightShaft(engine, { radiusTop: 0.6, radiusBottom: 1.2, length: 5, color: 0xfff1d0, intensity: 0.4, dust: 0.5 });
 * beam.position.set(0, 5, 0); engine.scene.add(beam);
 * beam.shaft.intensity.value = 0.2;   // live
 * @experimental
 */
export function lightShaft(engine: { renderer: any; uniforms: object; tier: string }, opts?: LightShaftOptions): LightShaft;
