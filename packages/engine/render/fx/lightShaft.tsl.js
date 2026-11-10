// TSL lightShaft(engine, opts): a cheap beam of light you can see in the air (daylight through a ceiling hole, a window, a stage or a lighthouse beam).
// Research and the five questions: docs/plans/research/2026-11-10-light-shafts.md. Why a mesh and not a post effect: the shadowed ways already exist
// (sunShafts, lightVolumes in @threedog/post-effects/tsl, cost high); what every game rebuilt by hand was one additive cone, and its hard parts are the
// same in every game: sides that fade by view angle, a fade where it meets geometry (scene depth, the soft-particle trick), a fade near the camera so
// standing inside it does not blow the screen, scene fog that dims it instead of adding fog colour, and the tier.
// What it does not do: occluders do not cut it (a pillar in the beam leaves it whole); that is sunShafts / lightVolumes.
// It returns a plain THREE.Mesh: the game adds, moves and removes it (engine.remove frees its geometry and material; no textures are made).
import * as THREE from 'three/webgpu';   // three/webgpu, not three: threedog/tsl stays WebGL-free (both share three.core.js)
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, If, float, vec2, vec3, vec4, abs, dot, normalize, normalView, positionView, positionWorld, positionGeometry, cameraNear, cameraFar,
  viewportLinearDepth, output } from 'three/tsl';
import { codedError } from '../../core/base/errorHints.js';
import { readParams } from '../../core/base/params.js';
import { isWebGPU } from '../backend.js';
import { valueNode, uniforms } from './uniforms.tsl.js';
import { noise } from './noise.tsl.js';

const PARAMS = {
  light: { type: 'object', optional: true, desc: 'a SpotLight (position, aim, cone width, colour) or DirectionalLight (aim, colour) to follow every frame' },
  length: { type: 'number', optional: true, min: 0, desc: 'metres from the top (the opening) to the far end; default the spot light\'s distance, else 4' },
  radiusTop: { type: 'number', default: 0.3, min: 0, desc: 'radius at the opening in m' },
  radiusBottom: { type: 'number', optional: true, min: 0, desc: 'radius at the far end in m; default from the spot light\'s angle, else radiusTop' },
  color: { type: 'any', optional: true, desc: 'beam colour; default the light\'s colour (followed live), else white' },
  intensity: { type: 'number', default: 1, min: 0, desc: 'brightness added at the beam\'s core' },
  softness: { type: 'number', default: 0.6, min: 0, max: 1, desc: 'how far in from the sides the fade reaches: 0 hard edge, 1 fades all the way to the centre' },
  fallOff: { type: 'number', default: 0.5, min: 0, max: 1, desc: 'how much dimmer the far end is than the opening' },
  fadeAtGeometry: { type: 'number', default: 0.5, min: 0, desc: 'metres over which it fades where it meets walls and floor (0 = off, and no depth read)' },
  fadeNear: { type: 'number', default: 1, min: 0, desc: 'metres in front of the camera over which it fades out' },
  dust: { type: 'number', default: 0, min: 0, max: 1, desc: 'how much drifting dust patterns the beam (0 = even beam)' },
  dustScale: { type: 'number', default: 2, min: 0, desc: 'dust pattern size: higher = finer' },
  dustSpeed: { type: 'number', default: 0.3, desc: 'how fast the dust drifts down the beam, m/s' },
  segments: { type: 'int', default: 24, min: 3, desc: 'sides of the cone' },
};

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), DOWN = new THREE.Vector3(0, -1, 0);

/**
 * A light shaft: an open cone, top (the opening) at the mesh origin, pointing down its -Y axis. WebGPURenderer only (its WebGPU and WebGL2 backends).
 * @param {any} engine
 * @param {Record<string, any>} [opts] see PARAMS above (types/tsl.d.ts LightShaftOptions)
 * @returns {THREE.Mesh & { shaft: Record<string, { value: any }> }}
 */
export function lightShaft(engine, opts = {}) {
  // refused, not silently blank: WebGLRenderer cannot draw a node material at all
  if (!isWebGPU(engine?.renderer)) throw codedError('tsl-misuse', 'threedog/tsl lightShaft(engine, ...): needs the engine on WebGPURenderer (its node material does not draw on WebGLRenderer). A WebGL game: the depth haze of recipe 59, or its own additive cone');
  const o = /** @type {any} */ (readParams('lightShaft', PARAMS, opts));   // values checked against PARAMS, defaults filled
  const light = o.light ?? null;
  if (light && !light.isSpotLight && !light.isDirectionalLight) throw codedError('tsl-misuse', `threedog/tsl lightShaft({ light }): a SpotLight or DirectionalLight (got ${light.type ?? typeof light})`);
  const length = o.length ?? (light?.isSpotLight && light.distance > 0 ? light.distance : 4);
  const radiusBottom = o.radiusBottom ?? (light?.isSpotLight ? Math.tan(light.angle) * length : o.radiusTop);

  // the game's numbers, as { value } objects it writes later (beam.shaft.intensity.value = 2); valueNode reads them every render (uniforms.tsl.js says why not uniform())
  const color = o.color != null ? new THREE.Color(o.color) : light ? light.color : new THREE.Color(1, 1, 1);
  const S = { color: { value: color }, intensity: { value: o.intensity }, softness: { value: o.softness }, fallOff: { value: o.fallOff },
    fadeAtGeometry: { value: o.fadeAtGeometry }, fadeNear: { value: o.fadeNear }, dust: { value: o.dust }, dustScale: { value: o.dustScale }, dustSpeed: { value: o.dustSpeed } };
  // dust on: the game's dust and not low tier, so the noise branch is skipped on the GPU (a uniform branch, not a multiply by 0). Worked out where the
  // uniform is read (every render): no per-frame writer to keep in step, and a tier change is followed on the next frame without a rebuild
  const dustOn = { get value() { return S.dust.value > 0 && engine.tier !== 'low' ? 1 : 0; } };
  const U = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, valueNode(v)]));
  const uDustOn = valueNode(dustOn), uTime = uniforms(engine).uTime;   // engine time: pause and slow motion hold the dust too

  const geometry = new THREE.CylinderGeometry(o.radiusTop, radiusBottom, length, o.segments, 1, true).translate(0, -length / 2, 0);
  // additive, unlit, no depth write: it adds light to what is behind and never hides it. Both sides: from inside the cone the far wall still shows.
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const depthFade = o.fadeAtGeometry > 0;   // 0 at creation: no depth read, so a scene with no other depth reader skips three's depth copy
  material.colorNode = Fn(() => {
    // sides: |n . v| is 1 face-on and 0 at the silhouette; curved (smoothstep shape) because the straight value looks solid face-on (research note)
    const facing = abs(dot(normalize(normalView), normalize(positionView.negate())));
    const e = facing.div(U.softness.max(0.001)).clamp(), edge = e.mul(e).mul(e.mul(-2).add(3));
    const along = positionGeometry.y.negate().div(length).clamp();   // 0 at the opening, 1 at the far end
    // the first 5% of the length fades in: a beam hanging free (a stage light) shows no hard ring at its opening (seen in the first shot); at a ceiling hole the ceiling's depth fade does the same
    const a = edge.mul(float(1).sub(U.fallOff.mul(along))).mul(along.div(0.05).clamp()).mul(U.intensity).toVar();
    const dist = positionView.z.negate();
    a.mulAssign(dist.sub(cameraNear).div(U.fadeNear.max(0.001)).clamp());
    if (depthFade) {
      // metres between the beam and what is drawn behind it: the same read as soft particles (render/fx/particles.tsl.js), one depth copy per render shared by both
      const gap = viewportLinearDepth.mul(cameraFar.sub(cameraNear)).add(cameraNear).sub(dist);
      a.mulAssign(gap.div(U.fadeAtGeometry.max(0.001)).clamp());
    }
    If(uDustOn.greaterThan(0.5), () => {
      // streaks along the beam that drift down it: noise stretched 4x along the axis, scrolled by engine time
      const p = positionWorld.mul(U.dustScale), n = noise(vec2(p.x.add(p.z.mul(0.7)), p.y.mul(0.25).add(uTime.mul(U.dustSpeed).mul(U.dustScale).mul(0.25))));
      a.mulAssign(float(1).sub(U.dust).add(U.dust.mul(n).mul(2)).max(0));
    });
    return vec4(vec3(U.color).mul(a), 1);
  })();
  // Fog dims the beam: three's fog mixes the output toward the fog colour, which under additive blending ADDS fog colour (a glowing haze where the beam
  // should fade). The fog node is fog(color, factor) for scene.fog and for the engine's documented scene.fogNode (render/fogLook.js reads it the same way),
  // so its factor is rawInputs[1]: the beam is scaled by 1 - factor. A fog node built otherwise has no factor to read: the beam then draws unfogged.
  /** @type {any} */ (material).setupFog = (/** @type {any} */ builder, /** @type {any} */ outputNode) => {
    const factor = builder.fogNode?.rawInputs?.[1];
    if (!factor) return outputNode;
    output.assign(outputNode);
    return vec4(output.rgb.mul(float(1).sub(factor.toFloat())), output.a);
  };

  const mesh = /** @type {THREE.Mesh & { shaft: typeof S }} */ (/** @type {unknown} */ (new THREE.Mesh(geometry, material)));
  mesh.name = 'lightShaft';
  mesh.shaft = S;
  mesh.castShadow = mesh.receiveShadow = false;
  if (!light) return mesh;
  mesh.frustumCulled = false;   // it moves in onBeforeRender, after culling: a stale box must not cull it for good
  mesh.onBeforeRender = () => {
    // follow the light: a spot light gives position and aim, a directional light only the aim (the game places the opening, e.g. at the hole)
    light.updateMatrixWorld(); light.target.updateMatrixWorld();
    light.getWorldPosition(_p); light.target.getWorldPosition(_t);
    _q.setFromUnitVectors(DOWN, _t.sub(_p).normalize());
    if (light.isSpotLight) { mesh.position.copy(_p); mesh.parent?.worldToLocal(mesh.position); }
    if (mesh.parent) _q.premultiply(mesh.parent.getWorldQuaternion(_pq).invert());
    mesh.quaternion.copy(_q);
    mesh.updateMatrixWorld();
  };
  return mesh;
}
