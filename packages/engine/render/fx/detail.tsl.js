// TSL detailNoise() / detailBump() (GLSL threedogDetailNoise / threedogDetailBump).
// Line for line the callable chunk of render/detail.js (#include <threedog_detail>); no uniforms, plain inputs, like the GLSL ones.
// Why not import detail.js: it registers a ShaderChunk and pulls in the WebGL patch machinery, which threedog/tsl must not.
// The projections (world / triplanar / screen) and the fade are part of the `detail` patch (its uniforms), not callable functions, so they
// belong to the patch's tsl field; a NodeMaterial gets the same pattern by feeding detailNoise any 2D position it likes.
import { Fn, vec2, vec3, vec4, float, int, uint, sin, cos, floor, mix, smoothstep, length, cross, dot, normalize, abs, sign, dFdx, dFdy, Loop, Break, If } from 'three/tsl';
import { hashCell, hashStep, noise } from './noise.tsl.js';   // the GLSL side calls the same threedogHash / threedogNoise (#include <threedog_noise>)
import { DETAIL as D, hashOffset } from '../fxNumbers.js';

/** @template {string} T @typedef {import('three/webgpu').Node<T>} N */
// three's Loop reads `name` (the loop variable's name), but @types/three does not list it yet (a TODO there): the same Loop, typed with names
/** @type {(...args: [...{ start: number, end: number, condition?: string, name: string }[], (vars: Record<string, N<'int'>>) => void]) => void} */
const namedLoop = /** @type {any} */ (Loop);

/** threedogDFbm: up to 4 octaves of value noise, normalized to 0-1 */
const fbm = Fn(/** @param {[N<'vec2'>, N<'float'>]} a */ ([p0, octaves]) => {
  const s = float(0).toVar(), a = float(0.5).toVar(), n = float(0).toVar(), p = vec2(p0).toVar();
  namedLoop({ start: 0, end: 4, name: 'tdFo' }, ({ tdFo }) => {
    If(float(tdFo).greaterThanEqual(octaves), () => { Break(); });
    s.addAssign(a.mul(noise(p))); n.addAssign(a); p.assign(p.mul(D.lacunarity).add(D.offset)); a.mulAssign(0.5);
  });
  return s.div(n);
});

/** threedogDDabs: one soft oval dab per cell (random size, rotation, tone), 3x3 neighbor cells, up to 3 octaves */
const dabs = Fn(/** @param {[N<'vec2'>, N<'float'>]} a */ ([p0, octaves]) => {
  const s = float(0.5).toVar(), w = float(D.dabWeight).toVar(), p = vec2(p0).toVar();
  namedLoop({ start: 0, end: 3, name: 'tdDo' }, ({ tdDo }) => {
    const fo = float(tdDo);
    If(fo.greaterThanEqual(octaves), () => { Break(); });
    const ip = floor(p).toVar();
    // Why named loop variables: nested Loop() calls default to `i` each, and the inner one would shadow the outer one
    namedLoop({ start: -1, end: 1, condition: '<=', name: 'tdDj' }, { start: -1, end: 1, condition: '<=', name: 'tdDi' }, ({ tdDj, tdDi }) => {
      // five hashes of whole cells k + salt, the salt added to k's first step (GLSL detail.js says why)
      const c = ip.add(vec2(float(tdDi), float(tdDj))), [kx, ky] = hashCell(c.add(fo.mul(131))).map(n => n.toVar());
      const salted = (/** @type {number} */ sx, /** @type {number} */ sy) => hashStep(kx.add(uint(hashOffset(sx))), ky.add(uint(hashOffset(sy))));
      const h = vec2(hashStep(kx, ky), salted(57, 113));
      const ang = salted(211, 37).mul(6.2832), r = salted(89, 271).mul(0.3).add(0.35);
      const tone = salted(163, 199);
      const d0 = p.sub(c.add(0.15).add(h.mul(0.7))), ca = cos(ang), sa = sin(ang);
      const d = vec2(ca.mul(d0.x).add(sa.mul(d0.y)), sa.negate().mul(d0.x).add(ca.mul(d0.y))).div(vec2(r.mul(1.3), r.mul(0.75)));
      s.assign(mix(s, tone, float(1).sub(smoothstep(0.3, 1, length(d))).mul(w)));
    });
    p.assign(p.mul(D.lacunarity).add(D.offset)); w.mulAssign(D.dabFall);
  });
  return s;
});

/** GLSL vec4 threedogDetailNoise(vec2 p, int kind, float octaves): kind 0 grain, 1 paper, 2 stroke, 3 dabs; returns (gray rgb, height 0-1) */
export const detailNoise = Fn(/** @param {[N<'vec2'>, N<'int'>, N<'float'>]} a */ ([p, kind, octaves]) => {
  const k = int(kind), o = float(octaves), s = float(0).toVar();
  If(k.equal(1), () => { s.assign(fbm(p, o).mul(D.paper[0]).add(noise(vec2(p.x.mul(D.paperStretch[0]), p.y.mul(D.paperStretch[1]))).mul(D.paper[1]))); })
    .ElseIf(k.equal(2), () => { s.assign(smoothstep(D.stroke[0], D.stroke[1], fbm(vec2(p.x, p.y.mul(D.strokeStretch)), o))); })
    .ElseIf(k.equal(3), () => { s.assign(dabs(p, o)); })
    .Else(() => { s.assign(fbm(p, o)); });
  return vec4(vec3(s), s);
});

/**
 * GLSL vec3 threedogDetailBump(vec3 surfPos, vec3 surfNorm, float h, float k, float faceDir): screen-space bump (three's bump-map math).
 * View space, like the GLSL call `threedogDetailBump(-vViewPosition, normal, h, k, faceDirection)`: in TSL pass positionView, normalView,
 * faceDirection and assign the result to material.normalNode (three reads normalNode in view space; inside it normalView is the geometry normal).
 */
export const detailBump = Fn(/** @param {[N<'vec3'>, N<'vec3'>, N<'float'>, N<'float'>, N<'float'>]} a */ ([surfPos, surfNorm, h, k, faceDir]) => {
  const sx = dFdx(surfPos), sy = dFdy(surfPos), r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  const det = dot(sx, r1).mul(faceDir);
  return normalize(abs(det).mul(surfNorm).sub(float(k).mul(sign(det)).mul(dFdx(h).mul(r1).add(dFdy(h).mul(r2)))));
});
