// The `detail` surface patch: grain, paper, brush strokes or a texture laid over any lit material in world space (no UVs needed).
// Everything that differs between materials is a uniform (scale, strength, direction, stretch, octaves, mode, tint), so N materials with
// different values share ONE shader program; only the structure is in the cacheKey: source kind, projection, which channels it touches.
import * as THREE from 'three';
import { readParams, keysSchema } from '../core/base/params.js';
import { isOptions } from '../core/base/util.js';
import { placeholderTexture, hashText } from './effects.js';
import { declareUniforms } from './uniformDecl.js';
import { codedError } from '../core/base/errorHints.js';
import { DETAIL as D, LUMA_601, glslFloat as f, hashOffset } from './fxNumbers.js';
/** A dab salt (whole cells x, y) as the uvec2 added to a cell's first hash step @param {number} x @param {number} y */
const salt = (x, y) => `uvec2(${hashOffset(x)}u, ${hashOffset(y)}u)`;

/**
 * @typedef {{ texture?: string | import('three').Texture, noise?: 'grain' | 'paper' | 'stroke' | 'dabs', glsl?: string, uniforms?: Record<string, any>,
 *   projection?: 'world' | 'triplanar' | 'screen', scale?: number, strength?: number, mode?: 'multiply' | 'add' | 'mix', tint?: import('../types/common').ColorLike,
 *   direction?: number, stretch?: number, octaves?: number, normal?: number, roughness?: number, fade?: boolean }} DetailOptions
 */
const KEYS = ['texture', 'noise', 'glsl', 'uniforms', 'projection', 'scale', 'strength', 'mode', 'tint', 'direction', 'stretch', 'octaves', 'normal', 'roughness', 'fade'];
const NOISES = ['grain', 'paper', 'stroke', 'dabs'];
const MODES = ['multiply', 'add', 'mix'];

// Callable (#include <threedog_detail> in your own ShaderMaterial; the patch's built-in noises call the same functions). No uniforms:
//   vec4 threedogDetailNoise(vec2 p, int kind, float octaves)   kind 0 grain, 1 paper, 2 stroke, 3 dabs; returns (gray rgb, height 0-1)
//   vec3 threedogDetailBump(vec3 surfPos, vec3 surfNorm, float h, float k, float faceDir)   screen-space bump (three's bump-map math)
// Why: a game's own shader gets the same grain / paper / brush texture by calling it instead of the engine patching its material.
// The hash / value noise are the shared threedogHash / threedogNoise (#include <threedog_noise>, render/effects.js), not a copy: the detail grain,
// cloud shadows and sky clouds are one noise, and the TSL side (render/fx/detail.tsl.js) calls the same hash() / noise().
const CALLABLE = `#ifndef THREEDOG_DETAIL
#define THREEDOG_DETAIL
#include <threedog_noise>
float threedogDFbm(vec2 p, float octaves){ float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 4; i++) { if (float(i) >= octaves) break; s += a * threedogNoise(p); n += a; p = p * ${f(D.lacunarity)} + ${f(D.offset)}; a *= 0.5; }
  return s / n; }
// Soft oval brush dabs: one random dab per cell (random size, rotation, tone), no preferred direction. 3x3 cells cover a dab that reaches into a neighbor.
float threedogDDabs(vec2 p, float octaves){ float s = 0.5, w = ${f(D.dabWeight)};
  for (int o = 0; o < 3; o++) { if (float(o) >= octaves) break;
    vec2 ip = floor(p); float fo = float(o);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      // five hashes of whole cells k + salt (the hash takes cells, a fraction would be cut off); the salt is added to k's first step (effects.js)
      vec2 c = ip + vec2(float(i), float(j)); highp uvec2 k = threedogHashCell(c + fo * 131.0);
      vec2 h = vec2(threedogHashStep(k), threedogHashStep(k + ${salt(57, 113)}));
      float ang = 6.2832 * threedogHashStep(k + ${salt(211, 37)}), r = 0.35 + 0.3 * threedogHashStep(k + ${salt(89, 271)}), tone = threedogHashStep(k + ${salt(163, 199)});
      vec2 d = p - (c + 0.15 + 0.7 * h); float ca = cos(ang), sa = sin(ang);
      d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / vec2(r * 1.3, r * 0.75);
      s = mix(s, tone, (1.0 - smoothstep(0.3, 1.0, length(d))) * w); }
    p = p * ${f(D.lacunarity)} + ${f(D.offset)}; w *= ${f(D.dabFall)}; }
  return s; }
vec4 threedogDetailNoise(vec2 p, int kind, float octaves){
  float s = kind == 1 ? ${f(D.paper[0])} * threedogDFbm(p, octaves) + ${f(D.paper[1])} * threedogNoise(vec2(p.x * ${f(D.paperStretch[0])}, p.y * ${f(D.paperStretch[1])}))
    : kind == 2 ? smoothstep(${f(D.stroke[0])}, ${f(D.stroke[1])}, threedogDFbm(vec2(p.x, p.y * ${f(D.strokeStretch)}), octaves))
    : kind == 3 ? threedogDDabs(p, octaves) : threedogDFbm(p, octaves);
  return vec4(vec3(s), s); }
vec3 threedogDetailBump(vec3 surfPos, vec3 surfNorm, float h, float k, float faceDir){
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos), r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  return normalize(abs(det) * surfNorm - k * sign(det) * (dFdx(h) * r1 + dFdy(h) * r2)); }
#endif`;
Object.assign(THREE.ShaderChunk, { threedog_detail: CALLABLE });   // the same registry effects.js fills
// The patch's own part: the footprint / fade globals the projection writes and a game's glsl sample may read
const NOISE = `#include <threedog_detail>
// Size of one pixel in pattern units (1 = one pattern cell): the fade-out and \`glsl\` samples read it
float threedogDetailFootprint = 0.0;
float threedogDFp(vec2 p){ return max(length(dFdx(p)), length(dFdy(p))); }
float threedogDFade = 1.0;
float threedogDFadeOf(float fp){ return mix(1.0, 1.0 - smoothstep(0.5, 1.0, fp), uDetailFade); }`;

// Built-in sources: p is already scaled, turned by direction and stretched along it; returns (color, height)
const SOURCES = {
  tex: `vec4 threedogDetailSample(vec2 p){ vec3 c = texture2D(uDetail, p).rgb; return vec4(c, dot(c, vec3(${LUMA_601.join(', ')}))); }`,
  grain: 'vec4 threedogDetailSample(vec2 p){ return threedogDetailNoise(p, 0, uDetailOctaves); }',
  paper: 'vec4 threedogDetailSample(vec2 p){ return threedogDetailNoise(p, 1, uDetailOctaves); }',
  stroke: 'vec4 threedogDetailSample(vec2 p){ return threedogDetailNoise(p, 2, uDetailOctaves); }',
  dabs: 'vec4 threedogDetailSample(vec2 p){ return threedogDetailNoise(p, 3, uDetailOctaves); }',
};

// p (world position) -> sample; 'world' looks straight down (xz), 'triplanar' blends the three axis planes by the surface normal,
// 'screen' ignores w and lays the pattern on the screen pixels (gl_FragCoord), scale = pixels per pattern cell.
// Why screen exists: world / triplanar grain shrinks with distance and the fade then takes it out (it must, or it shimmers), but an
// illustration, print or painted look wants the same grain size over the whole picture, near and far. Its footprint is constant
// (1 / scale), so fade only matters when the cell is under ~2 px.
const PROJECT = {
  world: `vec4 threedogDetail(vec3 w){ vec2 p = threedogDetailUV(w.xz); threedogDetailFootprint = threedogDFp(p); threedogDFade = threedogDFadeOf(threedogDetailFootprint);
  return threedogDetailSample(p); }`,
  triplanar: `vec4 threedogDetail(vec3 w){
  vec3 n = abs(normalize(cross(dFdx(w), dFdy(w)))); n /= n.x + n.y + n.z;
  vec2 a = threedogDetailUV(w.zy), b = threedogDetailUV(w.xz), c = threedogDetailUV(w.xy);
  float fa = threedogDFp(a), fb = threedogDFp(b), fc = threedogDFp(c);
  threedogDFade = threedogDFadeOf(fa) * n.x + threedogDFadeOf(fb) * n.y + threedogDFadeOf(fc) * n.z;
  threedogDetailFootprint = fa; vec4 sa = threedogDetailSample(a); threedogDetailFootprint = fb; vec4 sb = threedogDetailSample(b); threedogDetailFootprint = fc; vec4 sc = threedogDetailSample(c);
  return sa * n.x + sb * n.y + sc * n.z; }`,
  screen: `vec4 threedogDetail(vec3 w){ vec2 p = threedogDTurn(gl_FragCoord.xy / max(uDetailScale, 1e-3));
  threedogDetailFootprint = 1.0 / max(uDetailScale, 1e-3); threedogDFade = threedogDFadeOf(threedogDetailFootprint);
  return threedogDetailSample(p); }`,
};
// default scale per projection: 4 repeats per metre on the ground (world / triplanar), a 2-pixel cell on screen
const SCALE = { world: 0.25, triplanar: 0.25, screen: 2 };

const COLOR = `{ vec3 tdc = threedogDS.rgb * uDetailTint;
  if (uDetailMode < 0.5) diffuseColor.rgb *= mix(vec3(1.0), tdc * 2.0, uDetailStrength * threedogDFade);
  else if (uDetailMode < 1.5) diffuseColor.rgb += (tdc - 0.5) * uDetailStrength * threedogDFade;
  else diffuseColor.rgb = mix(diffuseColor.rgb, tdc, uDetailStrength * threedogDFade); }`;

/**
 * The `detail` patch from a detail option object (DetailOptions above). `engine` loads a texture given by asset name.
 * @internal use applyEffects(mat, { detail }) or terrain({ detail })
 * @param {any} o
 * @param {{ assets?: any } | null} engine
 * @param {string} [label] where the options came from, for errors
 * @returns {import('./patches.js').ShaderPatch}
 */
export function detailPatch(o, engine, label = 'detail') {
  if (isOptions(o)) readParams(label, keysSchema(KEYS), o);
  if (o.mode !== undefined && !MODES.includes(o.mode)) throw codedError('material-option', `${label}.mode '${o.mode}' is not a blend mode; use ${MODES.join(' | ')}`);
  if (o.noise !== undefined && !NOISES.includes(o.noise)) throw codedError('material-option', `${label}.noise '${o.noise}' is not a built-in noise; use ${NOISES.join(' | ')}, or write your own with glsl: 'vec4 threedogDetailSample(vec2 p){ ... }'`);
  const proj = o.projection ?? 'world';
  if (!PROJECT[proj]) throw codedError('material-option', `${label}.projection '${proj}' must be 'world' (top-down), 'triplanar' (walls, rocks) or 'screen' (screen pixels, same grain size near and far; scale = pixels per cell)`);
  if (o.glsl && !/vec4\s+threedogDetailSample\s*\(\s*vec2/.test(o.glsl)) throw codedError('material-option', `${label}.glsl must define \`vec4 threedogDetailSample(vec2 p)\`: p is the scaled, turned, stretched position; return vec4(color rgb, height 0-1). uDetailOctaves, threedogDetailFootprint (one pixel in pattern units; fade yourself or leave it to detail.fade) and the uniforms you list are in scope`);
  const src = o.glsl ? 'glsl:' + hashText(o.glsl) : o.texture ? 'tex' : o.noise ?? 'grain';
  const isStroke = o.noise === 'stroke', ang = (o.direction ?? 0) * Math.PI / 180;
  const colorOn = o.strength !== 0 && (o.strength !== undefined || !(o.normal || o.roughness)), bump = !!o.normal, rough = !!o.roughness;
  const u = /** @type {Record<string, { value: any }>} */ ({
    uDetailScale: { value: o.scale ?? SCALE[proj] }, uDetailStrength: { value: o.strength ?? 0.35 }, uDetailMode: { value: Math.max(0, MODES.indexOf(o.mode ?? 'multiply')) },
    uDetailTint: { value: new THREE.Color(o.tint ?? 0xffffff) }, uDetailDir: { value: new THREE.Vector2(Math.cos(ang), Math.sin(ang)) },
    uDetailStretch: { value: o.stretch ?? (isStroke ? 6 : 1) }, uDetailOctaves: { value: o.octaves ?? 2 },
    uDetailBump: { value: o.normal ?? 0 }, uDetailRough: { value: o.roughness ?? 0 }, uDetailFade: { value: o.fade === false ? 0 : 1 },
  });
  let decl = '';
  if (o.texture) {
    let tex;
    if (o.texture?.isTexture) tex = o.texture;
    else {
      tex = placeholderTexture('detail');
      if (typeof o.texture === 'string') {
        if (!engine?.assets) throw codedError('material-option', `${label}.texture '${o.texture}' is an asset name but no engine is known; pass the engine (applyEffects(mat, { detail, engine })) or give a THREE.Texture`);
        engine.assets.useTexture(o.texture, t => {
          const own = t.clone();   // shares the image (no second upload); own wrapping
          // read as data, like the gray stand-in: 128 is the neutral the blend doubles to 1. Decoded as sRGB it reads 0.22, and the ground
          // would darken the moment the real texture arrives
          own.wrapS = own.wrapT = THREE.RepeatWrapping; own.colorSpace = THREE.NoColorSpace; own.needsUpdate = true;
          tex.dispose(); u.uDetail.value = own;
        }, { where: `${label}.texture`, instead: 'the neutral gray detail stays' });
      }
    }
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; u.uDetail = { value: tex }; decl = 'uniform sampler2D uDetail;';
  }
  const own = declareUniforms(label + '.uniforms', o.uniforms);
  Object.assign(u, own.uniforms); decl += '\n' + own.decl;
  const pars = `uniform float uDetailScale, uDetailStrength, uDetailMode, uDetailStretch, uDetailOctaves, uDetailBump, uDetailRough, uDetailFade;
uniform vec3 uDetailTint; uniform vec2 uDetailDir; ${decl}
${NOISE}
vec2 threedogDTurn(vec2 p){ p = vec2(uDetailDir.x * p.x + uDetailDir.y * p.y, -uDetailDir.y * p.x + uDetailDir.x * p.y); p.x /= uDetailStretch; return p; }
vec2 threedogDetailUV(vec2 w){ return threedogDTurn(w * uDetailScale); }
${o.glsl ?? SOURCES[o.texture ? 'tex' : o.noise ?? 'grain']}
${PROJECT[proj]}`;
  const glsl = /** @type {Record<string, string>} */ ({ color: `vec4 threedogDS = threedogDetail(vThreedogWorld);\n${colorOn ? COLOR : ''}` });
  if (bump) glsl.normal = 'normal = threedogDetailBump(-vViewPosition, normal, threedogDS.a, uDetailBump * threedogDFade, faceDirection);';
  if (rough) glsl.roughness = 'roughnessFactor = clamp(roughnessFactor + (threedogDS.a - 0.5) * uDetailRough * threedogDFade, 0.04, 1.0);';
  return { name: 'detail', cacheKey: `${src}|${proj}|${colorOn ? 'c' : ''}${bump ? 'n' : ''}${rough ? 'r' : ''}`, needs: { patches: ['world'] }, uniforms: u, pars, glsl,
    // a game's own GLSL sample has no TSL twin: no tsl field, so a NodeMaterial names the patch instead of drawing it without its picture
    ...(!o.glsl && { tsl: detailTsl(u, proj, o.texture ? -1 : NOISES.indexOf(o.noise ?? 'grain'), colorOn, bump, rough) }) };
}

/**
 * The patch on a NodeMaterial: the same projection, fade and blend as the GLSL above, written with ctx.tsl / ctx.fx (this file must not import
 * three/tsl: it is in every WebGL game's bundle). kind -1 = texture. The sample is built once per material and shared by the color / normal /
 * roughness code, as threedogDS is in GLSL.
 * @param {Record<string, { value: any }>} u @param {string} proj @param {number} kind @param {boolean} colorOn @param {boolean} bump @param {boolean} rough
 */
function detailTsl(u, proj, kind, colorOn, bump, rough) {
  const memo = new WeakMap();   // material -> { s: vec4 (color, height), fade }
  const sample = c => {
    let r = memo.get(c.material);
    if (r) return r;
    const T = c.tsl, U = k => c.fx.patchUniform(u[k]);
    const dir = U('uDetailDir'), scale = U('uDetailScale'), fadeOn = U('uDetailFade');
    const turn = p => T.vec2(dir.x.mul(p.x).add(dir.y.mul(p.y)).div(U('uDetailStretch')), dir.y.negate().mul(p.x).add(dir.x.mul(p.y)));
    const uv = w => turn(w.mul(scale));
    const fp = p => T.max(T.length(T.dFdx(p)), T.length(T.dFdy(p)));
    const fadeOf = f => T.mix(1, T.float(1).sub(T.smoothstep(0.5, 1, f)), fadeOn);
    const src = p => {
      if (kind >= 0) return c.fx.detailNoise(p, kind, U('uDetailOctaves'));
      const t = c.fx.patchTexture(u.uDetail, p).rgb;
      return T.vec4(t, T.dot(t, T.vec3(...LUMA_601)));
    };
    const w = T.positionWorld;
    if (proj === 'world') { const p = uv(w.xz); r = { s: src(p), fade: fadeOf(fp(p)) }; }
    else if (proj === 'triplanar') {
      const a = T.abs(T.normalize(T.cross(T.dFdx(w), T.dFdy(w)))), n = a.div(a.x.add(a.y).add(a.z));
      const pa = uv(w.zy), pb = uv(w.xz), pc = uv(w.xy);
      r = { s: src(pa).mul(n.x).add(src(pb).mul(n.y)).add(src(pc).mul(n.z)),
        fade: fadeOf(fp(pa)).mul(n.x).add(fadeOf(fp(pb)).mul(n.y)).add(fadeOf(fp(pc)).mul(n.z)) };
    } else {
      // screenCoordinate counts from the top (WebGPU rule) on both backends; flipped back to gl_FragCoord's bottom-left origin,
      // so the grain sits where GLSL puts it
      const k = T.max(scale, 1e-3), sc = T.screenCoordinate;
      r = { s: src(turn(T.vec2(sc.x, T.screenSize.y.sub(sc.y)).div(k))), fade: fadeOf(T.float(1).div(k)) };
    }
    memo.set(c.material, r);
    return r;
  };
  const tsl = /** @type {Record<string, (c: any) => any>} */ ({});
  if (colorOn) tsl.color = c => {
    const T = c.tsl, { s, fade } = sample(c), mode = c.fx.patchUniform(u.uDetailMode), k = c.fx.patchUniform(u.uDetailStrength).mul(fade);
    const tdc = s.rgb.mul(c.fx.patchUniform(u.uDetailTint)), rgb = c.color.rgb;
    return T.vec4(T.select(mode.lessThan(0.5), rgb.mul(T.mix(T.vec3(1), tdc.mul(2), k)),
      T.select(mode.lessThan(1.5), rgb.add(tdc.sub(0.5).mul(k)), T.mix(rgb, tdc, k))), c.color.a);
  };
  if (bump) tsl.normal = c => { const { s, fade } = sample(c);
    return c.fx.detailBump(c.tsl.positionView, c.normal, s.a, c.fx.patchUniform(u.uDetailBump).mul(fade), c.tsl.faceDirection); };
  if (rough) tsl.roughness = c => { const { s, fade } = sample(c);
    return c.tsl.clamp(c.roughness.add(s.a.sub(0.5).mul(c.fx.patchUniform(u.uDetailRough)).mul(fade)), 0.04, 1); };
  return tsl;
}
