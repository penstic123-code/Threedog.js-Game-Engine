// One particle effect (helper of Particles.js): a ring buffer of particles drawn as one THREE.Points, updated on the CPU every frame.
import * as THREE from 'three';
import { needMaterial, warnOnce } from '../../core/base/validate.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { vert, frag } from './shaders.js';
import { isWebGPU, webgpuPart, onRendererSwap } from '../../render/backend.js';

export const NEUTRAL = {
  max: 120, lifetime: [1, 2], rate: 10, speed: [0.5, 1.5], direction: [0, 1, 0], spread: 0.5, area: 0,
  gravity: -2, drag: 0.5, wind: 0, windDir: [1, 0, 0.3], size: [0.3, 0.3], color: [0xcccccc, 0xcccccc], opacity: [0.8, 0],
  texture: null, blending: 'normal', spin: 0, worldSpace: true, fog: true, maxPixels: 512, ratePerMeter: 0, soft: 0, lit: false,
};
export const KEYS = Object.keys(NEUTRAL);
const pair = v => Array.isArray(v) ? v : [v, v];
/** Numbers per stop of the values that change over life */
export const OVER_LIFE = { size: 1, opacity: 1, color: 3 };
const _col = new THREE.Color(), _lit = [1, 1, 1];
/**
 * A value over life as { t, v, w }: stop times (0 birth, 1 death) and w numbers per stop. Given as one value, [birth, death], evenly spaced
 * [a, b, c...] or timed [[0, a], [0.2, b], [1, c]] (before the first time and after the last the end stop holds). Throws on anything else.
 * @param {keyof typeof OVER_LIFE} key @param {any} given @param {string} where
 */
export function curve(key, given, where) {
  const list = Array.isArray(given) ? given : [given, given], timed = Array.isArray(list[0]), n = list.length, w = OVER_LIFE[key], t = [], v = [];
  const bad = why => codedError('module-params', `${where}: ${key} ${why}. It is one value, [birth, death], evenly spaced stops [a, b, c], or timed stops [[0, a], [0.2, b], [1, c]]; got ${JSON.stringify(given)}`);
  if (n < 2) throw bad('needs two stops or more');
  list.forEach((s, i) => {
    if (Array.isArray(s) !== timed || timed && s.length !== 2) throw bad('mixes the forms');
    const at = timed ? s[0] : i / (n - 1), val = timed ? s[1] : s;
    if (!(at >= (i ? t[i - 1] : 0) && at <= 1)) throw bad('needs stop times from 0 to 1, in order');
    t.push(at);
    if (w === 3) { _col.set(val); v.push(_col.r, _col.g, _col.b); }   // three converts to linear color space automatically
    else if (Number.isFinite(val)) v.push(val);
    else throw bad('needs numbers');
  });
  return { t, v, w };
}
/** One channel of c at life fraction k */
function sample(c, k, ch = 0) {
  const t = c.t, last = t.length - 2;
  let s = 0; while (s < last && k >= t[s + 1]) s++;
  const a = c.v[s * c.w + ch];
  return a + (c.v[(s + 1) * c.w + ch] - a) * Math.min(1, Math.max(0, (k - t[s]) / (t[s + 1] - t[s] || 1)));
}
/** The node-material side (render/fx/particles.tsl.js, loaded with threedog/tsl) when the renderer is a WebGPURenderer, else null */
function nodeSide(engine, name) {
  return isWebGPU(engine.renderer) ? webgpuPart('particles', `[particles ${name}] the particle material`) : null;
}

export class Effect {
  constructor(sys, name, o) {
    this.sys = sys; this.name = name; this.o = o;
    const N = this.max = Math.max(1, Math.round(o.max));
    this.pos = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.age = new Float32Array(N); this.life = new Float32Array(N).fill(0);   // life 0 = empty slot
    this.spinV = new Float32Array(N);
    this.overLife = { size: new Array(N), opacity: new Array(N), color: new Array(N) };   // each particle's curves, shared by its batch (emit may override)
    this.extra = new Float32Array(N * 3);   // gravity, drag, wind (emit may override)
    this._curves = {};   // the last curve of each kind: most batches reuse the effect's own, like the merged params of a handle
    this.head = 0; this.alive = 0;
    /** @internal clear() zeroed slots the GPU copy still shows: the next upload reaches this far */ this._stale = 0;
    /** @internal the game's material while one is set */ this._given = null;
    this._build();
    // fallback 'webgl': an effect defined before start() was built for the WebGPURenderer start() then replaced; build its draw object again
    // for the renderer in use (the particle state lives in the arrays above, so live particles carry over)
    /** @internal */ this._swap = onRendererSwap(sys.engine, () => {
      const vis = this.points.visible, was = this._attrs.map(a => a.array);
      this._drop();
      this._build();
      this._attrs.forEach((a, i) => a.array.set(was[i]));
      this.points.visible = vis;
      if (this._given) this.points.material = this._given;
      if (this._tex) this._useTexture(this._tex);
    });
    if (o.texture) this._loadTexture(o.texture);
  }

  /** The plain three.js material drawn; set yours and it is drawn as given, null gives the engine's back */
  get material() { return this._given ?? this._own; }
  set material(m) {
    if (m != null) needMaterial('module-params', `particles '${this.name}': material`, m, " (null gives the engine's back)");
    if (m && this._own.isNodeMaterial && !m.isNodeMaterial) throw codedError('module-params', `particles '${this.name}': on WebGPURenderer the material is a node material (PointsNodeMaterial from 'three/webgpu'), got ${m.type}`);
    this._given = m || null;
    // WebGPU: the effect is one quad drawn N times, and where each one goes and how big is the engine material's nodes. Without them every particle sits on the origin
    if (m && this._own.isNodeMaterial) { m.positionNode ??= this._own.positionNode; m.sizeNode ??= this._own.sizeNode; }
    this.points.material = m ?? this._own;
  }
  /** The engine material's { value } objects (uMap, uHasMap, uScale, uMaxPx, and uSoft with soft on): the engine writes them whichever material is drawn, a ShaderMaterial of yours can share them */
  get uniforms() { return this._own.uniforms; }

  /** @internal engine.remove disposes what the object draws, so the game's material comes off first: it stays the game's */
  _drop() { this.points.material = this._own; this.sys.engine.remove(this.points); }

  /** @internal The geometry, material and draw object for the engine's current renderer (sprite quads on WebGPU, points on WebGL) */
  _build() {
    const sys = this.sys, o = this.o, N = this.max, name = this.name;
    const g = this.geometry = new THREE.BufferGeometry();
    const gpu = nodeSide(sys.engine, name);   // WebGPU: the same attributes, read per instance by sprite quads
    const attr = (n, size) => { const a = new (gpu ? THREE.InstancedBufferAttribute : THREE.BufferAttribute)(new Float32Array(N * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.aPos = attr('position', 3); this.aSize = attr('aSize', 1); this.aAlpha = attr('aAlpha', 1); this.aAngle = attr('aAngle', 1); this.aColor = attr('aColor', 3); this.aLife = attr('aLife', 1);
    this._attrs = [this.aPos, this.aSize, this.aAlpha, this.aColor, this.aAngle, this.aLife];
    const soft = o.soft > 0 ? o.soft : 0;
    if (gpu) ({ material: this._own, object: this.points } = gpu.particles({ count: N, fog: o.fog !== false, additive: o.blending === 'additive',
      maxPixels: o.maxPixels, soft, attrs: { aPos: this.aPos, aSize: this.aSize, aAlpha: this.aAlpha, aAngle: this.aAngle, aColor: this.aColor, aLife: this.aLife } }));
    else this._own = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, fog: o.fog !== false,
      blending: o.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uHasMap: { value: 0 }, uScale: { value: 400 }, uMaxPx: { value: o.maxPixels } },
        soft ? { uSoft: { value: soft }, uDepth: { value: null }, uDepthView: { value: new THREE.Vector4() }, uClip: { value: new THREE.Vector2() } } : {}]),
      defines: soft ? { SOFT: 1 } : {},
    });
    if (!gpu) this.points = new THREE.Points(g, this._own);
    // On the WebGL2 backend three's depth copy works from a multisampled target only, so the canvas and a plain target give no fade. The backend is known at the first draw
    if (gpu && soft) this.points.onBeforeRender = r => {
      if (r.backend.isWebGLBackend) warnOnce(coded('module-params', `particles '${name}': soft has no fade on WebGPURenderer's WebGL2 backend unless post draws with antialias; the particles draw hard`), 'particles-soft-webgl2');
    };
    if (!gpu && soft) this.points.onBeforeRender = (r, scene, camera) => {
      if (this.points.material !== this._own) return;   // the game's material reads what it wants; nobody needs the depth drawn
      const u = this._own.uniforms;
      u.uDepth.value = sys._sceneDepth(r, scene, camera);
      r.getCurrentViewport(u.uDepthView.value); u.uClip.value.set(camera.near, camera.far);
      this._own.uniformsNeedUpdate = true;
    };
    this.points.frustumCulled = false; this.points.visible = false; this.points.renderOrder = 10;
    this.points.matrixAutoUpdate = false;
    sys.engine.add(this.points, { owner: 'engine:particles' });
  }

  /** @internal */
  _useTexture(tex) { this._tex = tex; this.uniforms.uMap.value = tex; this.uniforms.uHasMap.value = 1; }

  _loadTexture(t) {
    if (t.isTexture) this._useTexture(t);
    else this.sys.engine.assets.useTexture(t, tex => this._useTexture(tex), { where: `particles '${this.name}'`, instead: 'a round dot shows instead' });
  }

  /** curve(), read again only when the value given is another one @internal */
  _curve(key, given, where) {
    const last = this._curves[key];
    return last?.given === given ? last : (this._curves[key] = { ...curve(key, given, where), given });
  }

  /**
   * Emit count particles. origin {x,y,z}; o is the merged params; frame optional: particle direction rotates with the object.
   * path optional { from, first, step }: particle n is born that fraction of the way from `from` to origin (first + n * step); over max, the newest stay
   */
  spawn(origin, count, o, quat, path = null) {
    // presentation: particle scatter
    const N = this.max, rnd = Math.random, life = pair(o.lifetime), spd = pair(o.speed), where = `particles '${this.name}'`;
    const size = this._curve('size', o.size, where), opacity = this._curve('opacity', o.opacity, where), color = this._curve('color', o.color, where);
    const dir = this.sys._dir.set(o.direction[0], o.direction[1], o.direction[2]).normalize();
    if (quat) dir.applyQuaternion(quat);
    // two perpendicular directions around axis dir, for random picks inside the cone
    const up = Math.abs(dir.y) < 0.99 ? this.sys._up.set(0, 1, 0) : this.sys._up.set(1, 0, 0);
    const t1 = this.sys._t1.crossVectors(dir, up).normalize(), t2 = this.sys._t2.crossVectors(dir, t1);
    const area = o.area, ax = Array.isArray(area) ? area[0] : area, ay = Array.isArray(area) ? area[1] : area, az = Array.isArray(area) ? area[2] : area;
    for (let n = path ? Math.max(0, count - N) : 0; n < count; n++) {
      const i = this.head; this.head = (this.head + 1) % N;
      if (this.life[i] === 0) this.alive++;
      const i3 = i * 3;
      const at = path ? this.sys._e.lerpVectors(path.from, origin, path.first + n * path.step) : origin;
      this.pos[i3] = at.x + (rnd() * 2 - 1) * ax; this.pos[i3 + 1] = at.y + (rnd() * 2 - 1) * ay; this.pos[i3 + 2] = at.z + (rnd() * 2 - 1) * az;
      // random direction in a cone: off-axis angle theta in [0, spread] (cos theta uniform = uniform on the sphere)
      const cosT = 1 - rnd() * (1 - Math.cos(Math.min(Math.PI, o.spread))), sinT = Math.sqrt(1 - cosT * cosT), ph = rnd() * Math.PI * 2;
      const a = Math.cos(ph) * sinT, b = Math.sin(ph) * sinT, v = spd[0] + rnd() * (spd[1] - spd[0]);
      this.vel[i3] = (dir.x * cosT + t1.x * a + t2.x * b) * v;
      this.vel[i3 + 1] = (dir.y * cosT + t1.y * a + t2.y * b) * v;
      this.vel[i3 + 2] = (dir.z * cosT + t1.z * a + t2.z * b) * v;
      this.age[i] = 0; this.life[i] = life[0] + rnd() * (life[1] - life[0]) || 0.01;
      this.spinV[i] = o.spin ? (rnd() * 2 - 1) * o.spin : 0;
      this.aAngle.array[i] = rnd() * Math.PI * 2;
      this.overLife.size[i] = size; this.overLife.opacity[i] = opacity; this.overLife.color[i] = color;
      this.extra[i3] = o.gravity; this.extra[i3 + 1] = o.drag; this.extra[i3 + 2] = o.wind;
    }
    this.points.visible = true;
  }

  /** @param {number} dt @param {import('./lit.js').ParticleLights | null} [lights] the scene's lights this frame, for a lit effect */
  update(dt, lights = null) {
    if (!this.alive) { this.points.visible = false; return; }
    const N = this.max, P = this.pos, V = this.vel, ap = this.aPos.array, as = this.aSize.array, aa = this.aAlpha.array, ac = this.aColor.array, ag = this.aAngle.array, al = this.aLife.array, { size, opacity, color } = this.overLife;
    const w = this.o.windDir, wl = Math.hypot(w[0], w[2]) || 1, wind = this.sys.engine.uniforms.uWind.value, wx = w[0] / wl * wind, wz = w[2] / wl * wind;
    let alive = 0, hi = -1;
    for (let i = 0; i < N; i++) {
      const L = this.life[i];
      if (L === 0) continue;
      hi = i;
      const age = this.age[i] += dt;
      if (age >= L) { this.life[i] = 0; aa[i] = 0; continue; }
      alive++;
      const i3 = i * 3, k = age / L, g = this.extra[i3], dr = Math.max(0, 1 - this.extra[i3 + 1] * dt), wd = this.extra[i3 + 2];
      V[i3] = V[i3] * dr + wx * wd * dt; V[i3 + 1] = V[i3 + 1] * dr + g * dt; V[i3 + 2] = V[i3 + 2] * dr + wz * wd * dt;
      ap[i3] = P[i3] += V[i3] * dt; ap[i3 + 1] = P[i3 + 1] += V[i3 + 1] * dt; ap[i3 + 2] = P[i3 + 2] += V[i3 + 2] * dt;
      al[i] = k; as[i] = sample(size[i], k); aa[i] = sample(opacity[i], k);
      ac[i3] = sample(color[i], k); ac[i3 + 1] = sample(color[i], k, 1); ac[i3 + 2] = sample(color[i], k, 2);
      if (lights) { lights.at(P[i3], P[i3 + 1], P[i3 + 2], _lit); ac[i3] *= _lit[0]; ac[i3 + 1] *= _lit[1]; ac[i3 + 2] *= _lit[2]; }   // lit: true (lit.js)
      if (this.spinV[i]) ag[i] += this.spinV[i] * dt;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    // upload only the used range (0 to the last live particle), not the whole buffer
    const n = hi + 1, up = Math.max(n, this._stale);
    this._stale = 0;
    if (this.points.isSprite) this.points.count = n;   // WebGPU sprites: instances up to the last live one (dead ones in between have size 0)
    for (const a of this._attrs) {
      a.clearUpdateRanges(); a.addUpdateRange(0, up * a.itemSize); a.needsUpdate = true;
    }
  }

  dispose() { this._swap.remove(); this._drop(); }
}
