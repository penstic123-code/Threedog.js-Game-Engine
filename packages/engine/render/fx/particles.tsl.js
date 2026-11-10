// Node-material versions of the particle and weather shaders (modules/particles/shaders.js, modules/weather/shaders.js) for WebGPURenderer.
// Why a registry instead of an import: modules/particles and modules/weather are in every WebGL game's bundle and must not pull in three/tsl, so this
// file (loaded with threedog/tsl, i.e. only on the WebGPU route) registers itself (render/backend.js registerWebGPUPart) and those modules look it up when the
// renderer is a WebGPURenderer (same pattern as patchNodes.tsl.js).
// Why sprites, not Points: WebGPU draws point primitives 1 pixel wide whatever the size, so each particle is an instance of a quad
// (three's Sprite + PointsNodeMaterial, see PointsNodeMaterial.js header); sizeNode then sets its on-screen size.
// Same numbers as GLSL: the modules keep their { value } uniform objects (game and engine code writes .value on either renderer) and the nodes read them
// back each render; sizes are device pixels like gl_PointSize (sizeNode is in CSS pixels, so it is divided by the pixel ratio), sprite uv is
// flipped to gl_PointCoord's y-down so textures and rotation land the same way.
// Fog: particles and weather use the node material's own fog (the weather GLSL has the same fog chunks: rain and snow fade into fog on both backends). It is mixed before the output transform. The GLSL mixes fog after its tone-mapping / color-space chunks, which
// only matters straight on the canvas: in a linear target (every frame with post on) those chunks do nothing and both match (fog parity in
// tests/specs/fx-particles.mjs, mean within 0.01%). On the canvas WebGPU differs anyway for every material: it blends and fogs in its linear
// frame buffer, WebGL on the encoded canvas (9-15% on the test puff, as much without fog), and three's own WebGL materials fog in that same
// late order, so reordering here would only make particles disagree with the fogged meshes around them on WebGPU.
import * as TSL from 'three/tsl';
import { Sprite, PointsNodeMaterial, LineBasicNodeMaterial, InstancedBufferAttribute, DataTexture, SRGBColorSpace,
  NormalBlending, AdditiveBlending } from 'three/webgpu';
import { valueNode } from './uniforms.tsl.js';
import { registerWebGPUPart } from '../backend.js';

const { Fn, texture, cameraProjectionMatrix, instancedDynamicBufferAttribute, attribute, varying, positionGeometry, modelViewMatrix, screenDPR, uv, viewportLinearDepth, cameraNear, cameraFar,
  float, vec2, vec3, vec4, select, min, max, cos, sin, mod, smoothstep, step, dot, length, If, Discard } = TSL;

/** @template {string} T @typedef {import('three/webgpu').Node<T>} N */
/** The particle uniforms as nodes @typedef {{ uScale: N<'float'>, uMaxPx: N<'float'>, uHasMap: N<'float'>, uSoft?: N<'float'> }} ParticleNodes */
/**
 * The weather uniforms as nodes (modules/weather/particles.js; streaks have uWindDir / uLen, sprites uPx / uMaxPx / uSway / uSwayAmp / uUseMap).
 * Colors are typed vec3 (what they are in the shader): @types/three's 'color' node type lacks the vec3 operators.
 * @typedef {{ uCam: N<'vec3'>, uSize: N<'float'>, uFallOff: N<'float'>, uOpacity: N<'float'>, uColor: N<'vec3'>, uWindDir?: N<'vec2'>,
 *   uLen?: N<'float'>, uPx?: N<'float'>, uMaxPx?: N<'float'>, uSway?: N<'float'>, uSwayAmp?: N<'float'>, uUseMap?: N<'float'> }} WeatherNodes
 */
/** A per-instance attribute node of the given node type @type {<T extends string>(a: any, type: T) => N<T>} */
const at = (a, type) => /** @type {any} */ (instancedDynamicBufferAttribute(a, type));

/**
 * { value } objects -> uniform nodes reading them each render (uniforms.tsl.js valueNode, the engine's one read-back form)
 * @param {Record<string, { value: any }>} u @returns {any} ParticleNodes or WeatherNodes: node types follow the values (valueNode)
 */
function nodesOf(u) {
  const n = {};
  for (const [k, o] of Object.entries(u)) {
    const v = o.value;
    if (typeof v !== 'number' && !v?.isVector2 && !v?.isVector3 && !v?.isColor) continue;   // textures go through mapSlot; a game's other own uniforms only meant something to its GLSL
    n[k] = valueNode(o);
  }
  return n;
}

// sRGB like the textures games load, so swapping in a real one does not change the colour conversion the node was built with
const white = () => { const t = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.colorSpace = SRGBColorSpace; t.needsUpdate = true; return t; };

/**
 * uniforms.uMap as a texture node: writing .value swaps the texture and rebuilds the material (the GLSL side just swaps the sampler).
 * The white stand-in for "no texture" is the slot's own (made here, so freed here): disposed when a real texture replaces it and with the material.
 * A texture the game passes in stays the game's. `.own` is true while the stand-in is drawn: a copy of these values (weather's rebuild) skips it,
 * since the stand-in is freed with this material and a new slot would take it for the game's
 */
function mapSlot(u, mat) {
  let own = null;
  const blank = () => (own ??= white());
  const node = texture(u.uMap?.value || blank());
  u.uMap = { get own() { return !!own && node.value === own; }, get value() { return node.value; }, set value(t) {
    const old = own;
    if (t) own = null;
    node.value = t || blank();
    if (old && old !== node.value) old.dispose();
    mat.needsUpdate = true;
  } };
  // own stays named after the dispose: a copy made after the old system is dropped (weather's rebuild) still sees it is not the game's
  mat.addEventListener('dispose', () => own?.dispose());
  return node;
}

/** A sprite drawing `count` instances with its own copy of the quad (engine.remove disposes the geometry; Sprite's default one is shared) */
function sprite(mat, count, attrs) {
  const s = new Sprite(mat);
  s.geometry = s.geometry.clone();
  for (const [name, a] of Object.entries(attrs)) s.geometry.setAttribute(name, a);   // listed so dispose frees their GPU buffers too
  s.count = count;
  return s;
}

/** gl_PointCoord (y down) from the sprite uv (y up) */
const pointCoord = () => vec2(uv().x, uv().y.oneMinus());

/** Same as modules/particles/shaders.js, per particle from instanced attributes. Returns { material, object }; material.uniforms holds the { value } objects. */
function particles({ attrs, count, fog, additive, maxPixels, soft }) {
  const u = { uScale: { value: 400 }, uMaxPx: { value: maxPixels }, uHasMap: { value: 0 }, uMap: { value: null }, ...(soft ? { uSoft: { value: soft } } : {}) };
  const m = new PointsNodeMaterial({ transparent: true, depthWrite: false, fog, sizeAttenuation: false, blending: additive ? AdditiveBlending : NormalBlending });
  /** @type {ParticleNodes} */ const U = nodesOf(u);
  const map = mapSlot(u, m);
  const pos = at(attrs.aPos, 'vec3'), size = at(attrs.aSize, 'float'), alpha = at(attrs.aAlpha, 'float');
  m.positionNode = pos;
  const z = modelViewMatrix.mul(vec4(pos, 1)).z;
  // an orthographic camera (projection [2][3] is 0, -1 for perspective; the test the GLSL isOrthographic makes) has no shrink with distance: uScale is pixels per meter
  const dist = select(/** @type {any} */ (cameraProjectionMatrix).element(2).element(3).lessThan(-0.5), max(0.1, z.negate()), float(1));
  m.sizeNode = Fn(() => {
    return select(alpha.lessThanEqual(0), float(0), min(size.mul(U.uScale).div(dist), U.uMaxPx)).div(screenDPR);
  })();
  // meters between the particle and what is drawn behind it; viewportLinearDepth is three's one copy of the depth buffer per render, shared by every effect that reads it
  const gap = soft ? viewportLinearDepth.mul(cameraFar.sub(cameraNear)).add(cameraNear).add(varying(z)) : null;
  const vAlpha = varying(alpha), vAngle = varying(at(attrs.aAngle, 'float')), vColor = varying(at(attrs.aColor, 'vec3'));
  m.colorNode = Fn(() => {
    const p0 = pointCoord().sub(0.5), c = cos(vAngle), s = sin(vAngle);
    const p = vec2(c.mul(p0.x).sub(s.mul(p0.y)), s.mul(p0.x).add(c.mul(p0.y)));
    const tex = select(U.uHasMap.greaterThan(0.5), map.sample(p.add(0.5)), vec4(1, 1, 1, smoothstep(0.2, 0.5, length(p)).oneMinus()));   // = GLSL smoothstep(0.5, 0.2, x): reversed edges are undefined in WGSL
    const a = soft ? tex.a.mul(vAlpha).mul(gap.div(U.uSoft).clamp()) : tex.a.mul(vAlpha);
    If(a.lessThan(0.01), () => { Discard(); });
    return vec4(vColor.mul(tex.rgb), a);
  })();
  /** @type {any} */ (m).uniforms = u;   // not a NodeMaterial field: where Particles.update / the texture loader write, as on the ShaderMaterial
  return { material: m, object: sprite(m, count, attrs) };
}

const SHAPE = { round: d => step(dot(d, d), 0.25), soft: d => smoothstep(0, 0.25, dot(d, d)).oneMinus(), square: () => float(1) };

/**
 * Fall + wrap around the camera, as in weather/shaders.js (uFallOff and uSway arrive wrapped from the CPU)
 * @param {WeatherNodes} U @param {N<'vec3'>} p @param {(fall: N<'float'>) => N<'float'>} dx @param {(fall: N<'float'>) => N<'float'>} dz
 */
const wrap = (U, p, dx, dz) => {
  const fall = mod(p.y.sub(U.uFallOff), U.uSize), half = U.uSize.mul(0.5);
  return vec3(mod(p.x.sub(U.uCam.x).add(dx(fall)), U.uSize).sub(half), fall.sub(U.uSize.mul(0.35)), mod(p.z.sub(U.uCam.z).add(dz(fall)), U.uSize).sub(half)).add(U.uCam);
};

/** Weather streaks (LineSegments, 1px like WebGL lines): same attributes and uniforms as lineVert / lineFrag */
function weatherLines(u) {
  /** @type {WeatherNodes} */ const U = nodesOf(u);
  const m = new LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  const end = attribute('aEnd', 'float');
  m.positionNode = Fn(() => {
    const w = wrap(U, positionGeometry, f => U.uWindDir.x.mul(f).mul(0.3), f => U.uWindDir.y.mul(f).mul(0.3));
    return w.sub(vec3(end.mul(U.uWindDir.x).mul(0.2), end.mul(U.uLen), end.mul(U.uWindDir.y).mul(0.2)));
  })();
  const vA = varying(end.mul(0.8).oneMinus());
  m.colorNode = vec4(U.uColor, U.uOpacity.mul(vA));
  return m;
}

/** Weather sprites (snow, drops): `geo`'s positions become the instances (geo itself is not drawn); same uniforms as pointVert / pointFrag(shape) */
function weatherPoints(u, geo, shape) {
  const m = new PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
  /** @type {WeatherNodes} */ const U = nodesOf(u);
  const map = mapSlot(u, m), src = geo.getAttribute('position');
  const a = new InstancedBufferAttribute(src.array, 3), p = at(a, 'vec3');
  const w = wrap(U, p, () => sin(U.uSway.mul(0.7).add(p.y)).mul(U.uSwayAmp), () => cos(U.uSway.mul(0.5).add(p.x)).mul(U.uSwayAmp));
  m.positionNode = w;
  m.sizeNode = min(U.uPx.mul(3).div(modelViewMatrix.mul(vec4(w, 1)).z.negate()), U.uMaxPx).div(screenDPR);
  m.colorNode = Fn(() => {
    const pc = pointCoord(), d = pc.sub(0.5);
    const c = select(U.uUseMap.greaterThan(0.5), map.sample(pc), vec4(1, 1, 1, SHAPE[shape](d)));
    If(c.a.lessThan(0.05), () => { Discard(); });
    return vec4(U.uColor.mul(c.rgb), U.uOpacity.mul(c.a));
  })();
  return sprite(m, src.count, { aPos: a });
}

registerWebGPUPart('particles', Object.freeze({ particles, weatherLines, weatherPoints }));
