// Lit particles (helper of Particles.js, the `lit: true` effect param): the scene's lights tint each particle's color on the CPU, in the same loop
// that already samples its color over life.
// Why on the CPU and not in the shader: the particle color is already written per particle per frame into aColor, so one multiply there lights
// every route the same (WebGLRenderer points, WebGPURenderer sprite quads, and a game's own material that reads aColor), with no second shader
// path per renderer to keep in step. Cost: live lit particles x lights, a few multiplies each (300 dust x 4 lights ~ 1200 per frame).
// What it is, so a game knows what it gets: what a matte card facing every light would show (three's Lambert formula, color * light / pi, no
// facing term: soft dust and smoke scatter from all sides). No shadows (dust behind a wall still sees the lamp), no environment map or light
// probes, no area lights. A game wanting more swaps the material (recipes/64 "The material").
import * as THREE from 'three';

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _c = new THREE.Color();
const INV_PI = 1 / Math.PI;
/** Frames between scene walks for lights: lights come and go rarely, their positions are read every frame from the list. Frames, not game
 * seconds: under engine.still the particles' dt is 0, and a light removed or added during the freeze must still be seen */
const GATHER = 15;

export class ParticleLights {
  /** @param {any} engine anything with a scene */
  constructor(engine) {
    this.engine = engine;
    /** @type {THREE.Light[]} visible lights found by the last walk */ this.found = [];
    this.since = GATHER;
    /** packed per light this frame: [kind, x, y, z, r, g, b, distance, decay, dx, dy, dz, coneCos, penumbraCos]; kind 0 = everywhere (ambient, hemisphere, directional) */
    this.packed = new Float32Array(0); this.n = 0;
    /** the constant part (ambient, hemisphere, directional), summed once */ this.base = [0, 0, 0];
  }

  /** Once per frame, before lit effects update. force: walk the scene now (the picture check, which changes lights between captures) */
  refresh(force = false) {
    if (force || ++this.since > GATHER) {
      if (!force) this.since = 0;   // a forced walk (picture check) keeps the normal schedule
      const f = this.found = [];
      this.engine.scene.traverseVisible(o => { if (o.isLight && !o.isLightProbe && !o.isLightProbeGrid && !o.isRectAreaLight) f.push(o); });
    }
    const b = this.base; b[0] = b[1] = b[2] = 0;
    if (this.packed.length < this.found.length * 14) this.packed = new Float32Array(this.found.length * 14);
    const P = this.packed; let n = 0;
    for (const l of this.found) {
      if (!(l.intensity > 0) || !l.visible) continue;
      if (l.isHemisphereLight) { _c.copy(l.color).add(l.groundColor).multiplyScalar(0.5 * l.intensity * INV_PI); b[0] += _c.r; b[1] += _c.g; b[2] += _c.b; continue; }   // no normal: the mean of sky and ground
      _c.copy(l.color).multiplyScalar(l.intensity * INV_PI);
      if (!l.isPointLight && !l.isSpotLight) { b[0] += _c.r; b[1] += _c.g; b[2] += _c.b; continue; }   // ambient and directional reach every particle alike
      l.updateWorldMatrix(true, false); _p.setFromMatrixPosition(l.matrixWorld);
      const k = n * 14; P[k] = l.isSpotLight ? 2 : 1; P[k + 1] = _p.x; P[k + 2] = _p.y; P[k + 3] = _p.z; P[k + 4] = _c.r; P[k + 5] = _c.g; P[k + 6] = _c.b;
      P[k + 7] = l.distance; P[k + 8] = l.decay;
      if (l.isSpotLight) {
        l.target.updateWorldMatrix(true, false); _t.setFromMatrixPosition(l.target.matrixWorld).sub(_p).normalize();   // light -> target
        P[k + 9] = _t.x; P[k + 10] = _t.y; P[k + 11] = _t.z; P[k + 12] = Math.cos(l.angle); P[k + 13] = Math.cos(l.angle * (1 - l.penumbra));
      }
      n++;
    }
    this.n = n;
  }

  /** The light at (x, y, z) into out[0..2], per channel (multiply the particle color by it) */
  at(x, y, z, out) {
    const P = this.packed, b = this.base; let r = b[0], g = b[1], bl = b[2];
    for (let i = 0; i < this.n; i++) {
      const k = i * 14, dx = x - P[k + 1], dy = y - P[k + 2], dz = z - P[k + 3], d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      // three's getDistanceAttenuation: 1 / max(d^decay, 0.01), with the smooth cutoff when distance > 0
      let f = 1 / Math.max(Math.pow(d, P[k + 8]), 0.01);
      const cut = P[k + 7]; if (cut > 0) { const q = d / cut, s = Math.min(1, Math.max(0, 1 - q * q * q * q)); f *= s * s; }
      if (P[k] === 2) {   // spot: smoothstep(coneCos, penumbraCos, cos of the angle off its axis), as three does
        const cos = (dx * P[k + 9] + dy * P[k + 10] + dz * P[k + 11]) / d, lo = P[k + 12], hi = P[k + 13];
        const t = Math.min(1, Math.max(0, (cos - lo) / ((hi - lo) || 1e-4))); f *= t * t * (3 - 2 * t);
      }
      if (f <= 0) continue;
      r += P[k + 4] * f; g += P[k + 5] * f; bl += P[k + 6] * f;
    }
    out[0] = r; out[1] = g; out[2] = bl;
  }
}
