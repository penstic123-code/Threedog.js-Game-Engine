// Particles module: dust, falling leaves, splashes, chimney smoke, sparks... one effect = one THREE.Points (one draw call).
// Particles live in a ring buffer (the oldest are overwritten when full), updated on the CPU every frame with fixed-length arrays; no object per particle.
// Particles are affected by fog and do not write depth (they do not hide translucent objects behind); an effect with no live particles is not drawn at all.
//
//   engine.use(particles());
//   engine.particles.define('dust', { max: 300, lifetime: [0.6, 1.2], speed: [0.5, 1.5], direction: [0, 1, 0], spread: 1.2,
//                                     gravity: -1, drag: 1.5, size: [0.3, 0.8], color: [0xbbbbbb, 0xdddddd], opacity: [0.6, 0] });
//   engine.particles.emit('dust', { x, y, z }, { count: 20 });                                  // burst of 20 at once
//   engine.particles.emit('dust', pos, { count: 10, overrides: { color: [0xff8800, 0x552200] } }); // temporary param overrides (this batch only)
//   const h = engine.particles.attach('smoke', chimney, { rate: 8, offset: [0, 2, 0] });  // keep emitting while following an object
//   h.remove();   h.rate = 3;   h.active = false;
//   engine.particles.count('dust')   // live particle count; no name = all
//
// Params (all optional; below are the neutral fallback values):
//   max 120         max particles alive at once (the default is 60 when engine.tier is 'low'; a number the game gives stands)
//   lifetime [1,2]  seconds each particle lives (random range)
//   rate 10         particles per second by default for attach
//   speed [0.5,1.5] initial speed (m/s); direction [0,1,0] emit direction; spread 0.5 max angle off the direction (radians, pi = all directions)
//   area 0          radius the spawn point is randomly spread over (meters); a box [x,y,z] also works
//   gravity -2      vertical acceleration (negative falls, positive rises, e.g. smoke)
//   drag 0.5        air drag (fraction of speed lost per second)
//   wind 0          how much wind pushes it (follows engine.uniforms.uWind strength, direction windDir); windDir [1,0,0.3]
//   size [0.3,0.3]  size (meters) at birth / at death
//   color [0xcccccc,0xcccccc]  color at birth / at death
//   opacity [0.8,0] opacity at birth / at death
//   texture         asset name (a texture registered in engine.assets) or URL; default is a soft round dot
//   blending 'normal' | 'additive' (use additive for sparks and magic motes)
//   spin 0          texture rotation speed (radians/s, random sign) - for falling leaves
//   worldSpace true with attach, particles stay in the world after birth (smoke trails behind); false = emit direction rotates with the object (e.g. exhaust, muzzle).
//                   after birth particles always move in world coordinates and are not dragged along by the object
//   fog true        affected by fog
//   maxPixels 512   largest on-screen size of one particle (pixels), so smoke drifting past the camera does not fill the screen
//   ratePerMeter 0  with attach, particles per meter the emitter moves, on top of rate, spread along the path it moved (no beads behind a fast emitter)
//   soft 0          meters over which a particle fades where it meets opaque geometry; 0 is off. Set at define, not per batch
// size, color and opacity also take more stops: evenly spaced [0, 0.8, 0], or timed [[0, 0], [0.1, 0.8], [1, 0]] (time 0 birth, 1 death).
// Each particle's life fraction (0 birth, 1 death) is the geometry attribute aLife, for a game's own material.
//
// Pictures: particles({ effects: { name: {...same params...} }, default: {...} }). effects[name] sits under the define() params (what define sets wins),
//   so a game can write only engine.particles.define('leaves', { max: 200 }) and keep color and texture with the rest of its picture. default is the fallback for all effects.
//   A name in effects that the game never define()d is defined on the first emit/attach.
// Material: each effect's material is a plain three.js material, swapped with fx.material = myMaterial and drawn as given; fx.uniforms are the engine's { value } objects.
import * as THREE from 'three';
import { vec3 } from '../../core/base/math.js';
import { Effect, NEUTRAL, KEYS, OVER_LIFE, curve } from './effect.js';
import { warnMissing } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { isOptions, isUnder } from '../../core/base/util.js';
import { codedError } from '../../core/base/errorHints.js';
import { borrowRenderer } from '../../render/backend.js';
// one schema per public entry (unknown keys throw in dev with did-you-mean). Effect param values come in many shapes (number or [min, max], color), so most are only checked by key name
const FX_PARAMS = keysSchema(KEYS, {}, {
  ratePerMeter: { type: 'number', optional: true, min: 0, desc: 'particles per meter the emitter moves' },
  soft: { type: 'number', optional: true, min: 0, desc: 'meters over which a particle fades into opaque geometry' },
});
/** Check one table of effect params: the schema, then the values over life (at the call, not on a later emit) */
function readFx(where, o) {
  readParams(where, FX_PARAMS, o);
  for (const k of Object.keys(OVER_LIFE)) if (k in o) curve(k, o[k], where);
}
const PARTICLES_PARAMS = {
  effects: { type: 'object', optional: true, desc: 'effect params by name: under what define() gives, and defined on the first emit / attach when define() never ran' },
  default: { type: 'object', optional: true, desc: 'params every effect starts from' },
};
const EMIT_PARAMS = { count: { type: 'number', default: 10, min: 0, desc: 'particles in this burst' }, overrides: 'any?' };   // overrides: null is allowed (no override)
const ATTACH_PARAMS = { rate: { type: 'number', optional: true, min: 0, desc: 'particles per second (default: the effect rate)' },
  ratePerMeter: { type: 'number', optional: true, min: 0, desc: 'particles per meter moved (default: the effect ratePerMeter)' }, offset: 'any?', overrides: 'any?' };
const _vs = new THREE.Vector2();   // canvas CSS size (particle point scale follows the canvas height, not the window)
/** @import { ModuleDef } from '../../types/core' */
/** @import { Object3D, PositionLike } from '../../types/common' */
/** @import { ParticleEffect, ParticleEmitter, ParticleOptions, ParticlesOptions } from '../../types/gameplay' */

/** engine.particles */
export class Particles {
  /**
   * @internal
   * @param {any} engine
   * @param {ParticlesOptions} [opts]
   */
  constructor(engine, { effects = {}, default: fallback = {} } = {}) {
    /** @internal */ this.engine = engine;
    /** @internal what particles({ effects }) gave */ this._given = effects;
    /** @internal what particles({ default }) gave */ this._fallback = fallback;
    /** Defined effects @type {Map<string, ParticleEffect>} @experimental */
    this.effects = new Map();
    /** @internal */ this.emitters = new Set();
    /** @internal */ this._dir = new THREE.Vector3(); this._up = new THREE.Vector3(); this._t1 = new THREE.Vector3(); this._t2 = new THREE.Vector3();
    /** @internal */ this._q = new THREE.Quaternion();
    /** @internal */ this._o = new THREE.Vector3();
    /** @internal */ this._e = new THREE.Vector3();
    /** @internal */ this._path = { from: new THREE.Vector3(), first: 0, step: 0 };
    /** @internal the scene depth soft effects read on WebGLRenderer, once one draws */ this._depth = null;
  }

  /**
   * Define an effect (same name replaces it, and emitters attached to it move to the new definition); params sit on top of particles({ effects,
   * default }). Returns the effect object: .points is its THREE.Points (a Sprite on WebGPURenderer); .material is its plain three.js material (set
   * your own and it is drawn as given, null gives the engine's back); .uniforms are the engine material's { value } objects (uMap, uHasMap, uScale,
   * uMaxPx), which a ShaderMaterial of yours can share. A material of yours lasts until the effect is defined again
   * @example engine.particles.define('sparks', { blending: 'additive' }).material = myMaterial;
   * @param {string} name
   * @param {ParticleOptions} [opts]
   * @returns {ParticleEffect}
   */
  define(name, opts = {}) {
    readFx(`particles.define('${name}')`, opts);
    const old = this.effects.get(name);
    const o = { ...NEUTRAL, max: this.engine.tier === 'low' ? NEUTRAL.max / 2 : NEUTRAL.max, ...this._fallback, ...this._given[name], ...opts };
    const fx = new Effect(this, name, o);
    this.effects.set(name, fx);
    // emitters attached to the old effect keep running on the new one (redefining tunes an effect, it does not stop it)
    if (old) { for (const h of this.emitters) if (h.fx === old) h.fx = fx; old.dispose(); }
    return fx;
  }
  /**
   * Whether this effect has been defined
   * @param {string} name
   * @returns {boolean}
   */
  has(name) { return this.effects.has(name); }
  /** @internal */
  _get(name) {
    let fx = this.effects.get(name);
    if (!fx && this._given[name]) fx = this.define(name);
    if (!fx) warnMissing('particle', name, [...new Set([...this.effects.keys(), ...Object.keys(this._given)])]);
    return fx;
  }

  /**
   * Burst: emit count particles at once (default 10) at position (Vector3 / Object3D / [x, y, z] / {x, y, z}). overrides affect this batch only (color, speed, direction...; max/texture/blending/soft cannot be changed temporarily)
   * @param {string} name
   * @param {PositionLike} position
   * @param {{ count?: number, overrides?: ParticleOptions | null }} [opts]
   * @returns {void}
   */
  emit(name, position, opts = {}) {
    const { count, overrides = null } = readParams(`particles.emit('${name}')`, EMIT_PARAMS, opts);
    const fx = this._get(name); if (!fx) return;
    if (overrides) readFx(`particles.emit('${name}') overrides`, overrides);
    fx.spawn(vec3(position, this._e), count, overrides ? { ...fx.o, ...overrides } : fx.o, null);
  }

  /**
   * Keep emitting while following an object: rate per second, ratePerMeter per meter it moves (spread along the path, on top of rate), offset in the object's local coordinates [x, y, z] (meters). Returns a handle { remove(), rate, ratePerMeter, active } (active = false pauses)
   * @param {string} name
   * @param {Object3D} object3d
   * @param {{ rate?: number, ratePerMeter?: number, offset?: number[], overrides?: ParticleOptions | null }} [opts]
   * @returns {ParticleEmitter}
   */
  attach(name, object3d, opts = {}) {
    const { rate, ratePerMeter, offset = [0, 0, 0], overrides = null } = readParams(`particles.attach('${name}')`, ATTACH_PARAMS, opts);
    if (overrides) readFx(`particles.attach('${name}') overrides`, overrides);
    const fx = this._get(name); if (!fx) return { remove() {}, rate: 0, ratePerMeter: 0, active: false };
    const h = { fx, object: object3d, rate: rate ?? fx.o.rate, ratePerMeter: ratePerMeter ?? fx.o.ratePerMeter, last: null, offset, overrides, active: true, acc: 0, remove: () => { h.active = false; this.emitters.delete(h); } };
    this.emitters.add(h);
    return h;
  }

  /**
   * Live particle count (no name = all)
   * @param {string} [name]
   * @returns {number}
   */
  count(name) {
    if (name) return this.effects.get(name)?.alive ?? 0;
    let n = 0; for (const fx of this.effects.values()) n += fx.alive; return n;
  }

  /**
   * Clear one effect's (or all) particles
   * @param {string} [name]
   * @returns {void}
   */
  clear(name) { for (const fx of name ? [this.effects.get(name)].filter(Boolean) : this.effects.values()) { fx.life.fill(0); fx.aAlpha.array.fill(0); fx.alive = 0; fx._stale = fx.max; fx.points.visible = false; } }

  /** @internal Where the emitter is in the world (written into this._o) */
  _at(h) {
    h.object.updateWorldMatrix(true, false);
    return this._o.set(h.offset[0], h.offset[1], h.offset[2]).applyMatrix4(h.object.matrixWorld);
  }

  /**
   * @internal Add what emitter h earned by moving this step to h.acc. Returns the path for spawn, or null when it did not move: every particle
   * this step gets the same spacing, whichever of rate and ratePerMeter earned it, and the fraction left in h.acc carries it across steps
   */
  _walked(h, dt) {
    const to = this._at(h), moved = h.last && dt > 0 ? to.distanceTo(h.last) : 0, path = this._path;
    if (moved > 0) {
      const earned = moved * h.ratePerMeter;
      path.from.copy(h.last); path.step = 1 / (earned + dt * h.rate); path.first = (1 - h.acc) * path.step;
      h.acc += earned;
    }
    (h.last ??= new THREE.Vector3()).copy(to);
    return moved > 0 ? path : null;
  }

  /**
   * @internal The depth of what is opaque, for soft effects on WebGLRenderer. A shader cannot read the depth buffer it is drawing into there, so the scene's
   * opaque objects are drawn once more, depth only, from inside the draw of the first soft effect of this render: nothing runs unless a soft effect is on screen.
   * The stand-in material knows no wind, displacement or alphaTest, so such surfaces fade as their plain shape
   */
  _sceneDepth(r, scene, camera) {
    const d = this._depth ??= { target: new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) }), frame: -1, camera: null,
      material: new THREE.MeshDepthMaterial({ colorWrite: false, side: THREE.DoubleSide }) };
    if (d.frame === r.info.render.frame && d.camera === camera) return d.target.depthTexture;
    const size = r.getDrawingBufferSize(_vs), off = [];
    d.target.setSize(size.x, size.y);
    // by layer, not visible: an opaque child of a transparent parent still counts
    scene.traverseVisible(o => { if (o.material && (o.isPoints || [o.material].flat().some(m => !m.depthWrite || m.transmission > 0))) { off.push(o, o.layers.mask); o.layers.disableAll(); } });
    // a throwing render must not leave the scene on the depth material with layers off (M11): the renderer and scene come back through the
    // engine's one borrow (render/backend.js), the layers of the objects switched off here are this pass's own to give back
    try {
      borrowRenderer(r, () => {
        scene.overrideMaterial = d.material; scene.background = null; r.autoClear = true; r.shadowMap.autoUpdate = false;
        r.state.buffers.depth.setMask(true);   // the transparent pass left it off, and the clear needs it
        r.setRenderTarget(d.target); r.render(scene, camera);
      }, { scene });
    } finally { for (let i = 0; i < off.length; i += 2) off[i].layers.mask = off[i + 1]; }
    d.frame = r.info.render.frame; d.camera = camera;
    return d.target.depthTexture;
  }

  /**
   * Update all effects every frame (called by the module each frame)
   * @param {number} dt
   * @returns {void}
   * @internal
   */
  update(dt) {
    if (this.engine.still) dt = 0;   // freeze(owner, { still: true }): sparks hold in the air
    const cam = this.engine.camera, pr = this.engine.renderer.getPixelRatio(), scale = this.engine.renderer.getSize(_vs).y * pr / (cam.isOrthographicCamera ? 2 / cam.projectionMatrix.elements[5] : 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));   // orthographic: pixels per world unit
    for (const h of this.emitters) {
      if (!h.active) { h.last = null; continue; }   // a pause leaves no line from where it stopped to where it starts again
      if (!isUnder(h.object, this.engine.scene) && !isUnder(h.object, cam)) { h.remove(); continue; }   // object left the scene (it or any group above it was removed; one carried by the camera counts): stop automatically
      const path = h.ratePerMeter > 0 ? this._walked(h, dt) : null;
      h.acc += dt * h.rate;
      const n = Math.floor(h.acc);
      if (n <= 0) continue;
      h.acc -= n;
      // merged params are cached on the handle (re-merged only when overrides is a new object), not spread every frame
      if (h._ov !== h.overrides || h._base !== h.fx.o) { h._ov = h.overrides; h._base = h.fx.o; h._merged = h.overrides ? { ...h.fx.o, ...h.overrides } : h.fx.o; }
      const o = h._merged;
      const p = this._at(h);
      h.object.getWorldQuaternion(this._q);
      h.fx.spawn(p, n, o, o.worldSpace === false ? this._q : null, path);
    }
    for (const fx of this.effects.values()) { fx.uniforms.uScale.value = scale; fx.update(dt); }
  }
}

/**
 * Particles -> engine.particles. effects: params by name, under what define() gives; a name define() never saw is defined on its first emit / attach.
 * default: params every effect starts from
 * @param {ParticlesOptions} [opts]
 * @returns {ModuleDef<Particles>}
 * @example engine.use(particles({ default: { color: 0xc8b89a }, effects: { dust: { max: 300, size: [0.3, 0.8] } } }));
 */
export function particles(opts = {}) {
  readParams('particles', PARTICLES_PARAMS, opts);
  // checked here, not on the first emit: a typo in a style table should fail at startup, not in the middle of play
  for (const [name, spec] of Object.entries(opts.effects ?? {})) {
    if (!isOptions(spec)) throw codedError('module-params', `particles({ effects: { ${name} } }): an effect is an object of params, e.g. { max: 200, color: 0xcccccc }; got ${JSON.stringify(spec)}`);
    readFx(`particles({ effects: { ${name} } })`, spec);
  }
  if (opts.default) readFx('particles({ default })', opts.default);
  let p = null;
  return { name: 'particles', skipKind: 'none', type: 'picture', provides: ['particles'], label: 'Particles', params: PARTICLES_PARAMS, options: opts, stage: 'effects', install(e) { e.i18n.add({ 'zh-CN': { 'module.particles': '粒子' }, en: { 'module.particles': 'particles' } }); p = new Particles(e, opts); return p; }, frame(dt) { p.update(dt); },
    dispose() { for (const fx of p.effects.values()) fx.dispose(); p.effects.clear(); p.emitters.clear(); p._depth?.target.depthTexture.dispose(); p._depth?.target.dispose(); p._depth?.material.dispose(); },
    counts() { return { alive: p.count(), emitters: p.emitters.size }; },   // engine.counts().particles
    // "did the dust burst fire": live particles in total and per effect that has any (idle effects left out to stay short). Kept under `alive`
    // because the numbers change every frame (an emitter's smoke): state comparisons (the session spec) skip that key as presentation, not game state
    describe() {
      const each = {}; for (const [name, fx] of p.effects) if (fx.alive) each[name] = fx.alive;
      return { effects: p.effects.size, emitters: p.emitters.size, alive: { total: p.count(), effects: each } };
    } };
}

export const handRolled = [{ kind: 'particles', seen: 'a particle loop of its own', use: 'engine.particles: emitters on game time, one draw call, budgets (recipe 64)', quiet: /\b(engine|e|eng|ctx)\.particles\b|\bparticles\(\s*[{)]/, code: /\bfor\s*\([^)]*\bof\s+[\w.]*(?:particles|sparks|embers)\b|\b(?:particles|sparks|embers)\.(?:forEach|filter)\s*\(/i, near: [{ re: /\.(?:life|age|ttl|vel\w*|v[xyz])\b/, lines: 5 }] }];
