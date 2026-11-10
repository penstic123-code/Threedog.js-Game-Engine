// Weather particle shaders: lines (rain streaks; position loops downward in the shader, zero CPU cost) and point sprites (snow, textured
// drops, a game's own particles). Time arrives already wrapped on the CPU (uFallOff = fall distance mod area size, uSway = time mod 20π,
// the common period of the drift), so drops do not jitter from float32 precision in multi-hour sessions. Colors go through tone mapping
// and the output color space like three's own materials, so rain looks the same with and without post-processing.
// weather({ rain: { glsl: { vertex, fragment } } }) replaces either text (recipes/44); copy these as the starting point.
import * as THREE from 'three';
import { warnOnce } from '../../core/base/validate.js';
import { coded } from '../../core/base/errorHints.js';

export const lineVert = `uniform vec3 uCam; uniform float uSize; uniform float uFallOff; uniform vec2 uWindDir; uniform float uLen; attribute float aEnd;
varying float vA;
#include <fog_pars_vertex>
void main(){
  vec3 p = position;
  float fall = mod(p.y - uFallOff, uSize);
  vec3 w = vec3(mod(p.x - uCam.x + uWindDir.x * fall * 0.3, uSize) - uSize*0.5, fall - uSize*0.35, mod(p.z - uCam.z + uWindDir.y * fall * 0.3, uSize) - uSize*0.5);
  w += uCam;
  w.y -= aEnd * uLen; w.x -= aEnd * uWindDir.x * 0.2; w.z -= aEnd * uWindDir.y * 0.2;
  vA = 1.0 - aEnd * 0.8;
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
export const lineFrag = `uniform float uOpacity; uniform vec3 uColor; varying float vA;
#include <fog_pars_fragment>
void main(){
  gl_FragColor = vec4(uColor, uOpacity * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
export const pointVert = `uniform vec3 uCam; uniform float uSize; uniform float uPx; uniform float uMaxPx; uniform float uFallOff; uniform float uSway; uniform float uSwayAmp;
#include <fog_pars_vertex>
void main(){
  vec3 p = position;
  float fall = mod(p.y - uFallOff, uSize);
  vec3 w = vec3(mod(p.x - uCam.x + sin(uSway*0.7 + p.y)*uSwayAmp, uSize) - uSize*0.5, fall - uSize*0.35, mod(p.z - uCam.z + cos(uSway*0.5 + p.x)*uSwayAmp, uSize) - uSize*0.5) + uCam;
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  gl_PointSize = min(uPx * 3.0 / -mvPosition.z, uMaxPx);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
// sprite alpha by shape (d = offset from the sprite center, |d| <= 0.5); a texture, when there is one, replaces the shape
export const SHAPES = { round: 'step(dot(d,d), 0.25)', soft: '1.0 - smoothstep(0.0, 0.25, dot(d,d))', square: '1.0' };
export const pointFrag = (shape = 'round') => `uniform float uOpacity; uniform vec3 uColor; uniform sampler2D uMap; uniform float uUseMap;
#include <fog_pars_fragment>
void main(){
  vec2 d = gl_PointCoord - 0.5;
  vec4 c = uUseMap > 0.5 ? texture2D(uMap, gl_PointCoord) : vec4(1.0, 1.0, 1.0, ${SHAPES[shape]});
  if (c.a < 0.05) discard;
  gl_FragColor = vec4(uColor * c.rgb, uOpacity * c.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Particle shader material (transparent, no depth write) */
export const shaderMat = (vertexShader, fragmentShader, uniforms) => {
  // fogged like the WebGPU node materials (and the engine's particles): the fog chunks are in the shaders above; their uniforms are this material's own
  // (three writes the scene's fog into them each draw), added beside the { value } objects the engine shares with the game.
  // Only when the vertex shader provides vFogDepth (fog_vertex): the default fragment reads it under USE_FOG, and a game's own vertex without
  // the chunks would fail to link with scene fog on (the fog chunks are empty without USE_FOG, so the default fragment is fine unfogged)
  const fog = vertexShader.includes('fog_vertex');
  if (fog) for (const k of ['fogColor', 'fogNear', 'fogFar', 'fogDensity']) uniforms[k] ??= THREE.UniformsUtils.clone(THREE.UniformsLib.fog)[k];
  else warnOnce(coded('weather-option', 'weather glsl.vertex has no fog chunks, so this weather is not fogged on WebGL (WebGPU fogs it). Add #include <fog_pars_vertex> before main() and #include <fog_vertex> after gl_Position (mvPosition = the view-space position), and <fog_pars_fragment> / <fog_fragment> in your fragment, to fade it into fog'), 'weather-glsl-fog');
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, fog });
};
/** Initial particle positions: presentation only, no effect on gameplay */
export const scatter = (n, size) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.random() * size; return a; };   // presentation
