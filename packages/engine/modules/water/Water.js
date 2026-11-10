// Water module: draws the global water plane (sea, big lakes; snaps to a grid following the focus so it doesn't "swim") and independent water bodies (mountain lakes, ponds, each with its own level).
// water({...}) takes the structural choices (sea, level, flat, size, segments). The picture is plain three.js on the module (recipes/44):
//
// engine.use(water());                                      // global water only (level taken from the terrain water level)
// engine.use(water({ sea: false }));                         // no global water
// engine.use(water({ level: 4, size: 1200 }));
// engine.water.material.color.set(0x3070a0);                // the neutral material: plain three.js writes
// engine.water.uniforms.uWave.value = 1.5;                  // uWave uWaveScale uWaveSpeed uFresnel, live
// engine.water.material = applyEffects(new THREE.MeshPhongMaterial({ color: 0x3070a0, shininess: 90 }), { patches: engine.water.patches });   // your own material, waves kept
// engine.water.shader({ foam: true, depthColor: { shallow: 0x55ddcc, deep: 0x082040 } });   // which GLSL exists (also wave, surface, uniforms)
// engine.water.normalMap('water-n', { scale: 0.4, repeat: 0.05, speed: [0.01, 0.006] });
// const lake = engine.addWaterBody({ position: [120, 0, -40], radius: 25, level: 18 });   // add a mountain lake (can be added any time); lake.remove()
//
// three.js objects: engine.water.sea (global water Mesh, may be null), material (shared by all water), bodies (Map: water body → its Mesh)
import * as THREE from 'three';
import { neutralMaterial } from '../../render/neutral.js';
import { placeholderTexture } from '../../render/effects.js';
import { patchMaterial, unpatchMaterial } from '../../render/patches.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { waterShader, wavesPatch, surfacePatch } from './surface.js';
import { codedError } from '../../core/base/errorHints.js';
import { glslFloat, FRESNEL_POWER } from '../../render/fxNumbers.js';
import { fogLook } from '../../render/fogLook.js';
import { needMaterial } from '../../core/base/validate.js';

const GREY = new THREE.Color(0xcccccc);
/** @import { ModuleDef } from '../../types/core' */
/** @import { Material, Vector3, Texture } from '../../types/common' */
/** @import { WaterBody, WaterOptions, WaterShaderOptions } from '../../types/world' */
// Options accepted by water(): the structural choices only
const WATER_OPTIONS = ['sea', 'level', 'flat', 'size', 'segments'];
// size / segments divide each other (cell) and the sea snap: zero or non-finite would make NaN coordinates (size is meters, so a sub-meter plane is valid: > 0)
const WATER_PARAMS = keysSchema(WATER_OPTIONS, {}, { size: { type: 'number', min: Number.MIN_VALUE, optional: true }, segments: { type: 'int', min: 1, optional: true } });
const SHADER_PARAMS = keysSchema(['wave', 'surface', 'depthColor', 'foam', 'uniforms']);
const NORMAL_PARAMS = { scale: { type: 'number', min: 0, optional: true, desc: 'normal map strength' }, repeat: { type: 'number', min: 0, optional: true, desc: 'tiles per meter' },
  speed: { type: 'position', optional: true, desc: 'scroll [x, z] per second' } };

/** engine.water */
export class Water {
  /** @internal */
  constructor(engine, opts = {}, track) {
    /** @internal */ this.engine = engine;
    /** @internal */ this.st = { flat: true, size: 900, segments: 150, ...opts };
    const st = this.st;
    /** @internal */ this.cell = st.size / st.segments;
    /** @internal the normal map's name and how it tiles */ this._normal = { name: null, scale: 0.4, repeat: 0.05, speed: [0.01, 0.006] };
    /**
     * The loaded normal map (null = none): a game material takes it as its own normalMap. Its offset scrolls and the water UVs tile for it whatever material draws
     * @type {Texture | null}
     */
    this.normalTexture = null;
    /** @internal UV factor applied to the water meshes (1 = as built; size * repeat once a normal map tiles them) and each mesh's size */
    this._uv = new Map();
    /** @internal the uniforms shader() keeps across rebuilds, so a game's handle to one stays live */
    this._tune = { uWave: { value: 1 }, uWaveScale: { value: 1 }, uWaveSpeed: { value: 1 }, uFresnel: { value: 0.5 } };
    /** @internal what shader() was given so far */ this._shader = {};
    const built = this._build(this._shader);
    /**
     * The engine's water shader patches (waves, waterSurface when asked for, fresnel), so a game material keeps the behavior: applyEffects(mat, { patches: engine.water.patches })
     * @type {import('../../render/patches.js').ShaderPatch[]}
     */
    this.patches = built.patches;
    /**
     * Shader values, written directly and live: uWave, uWaveScale, uWaveSpeed, uFresnel, uTime; with depthColor / foam uWaterShallow, uWaterDeep, uWaterCurve,
     * uFoamColor, uFoamStart, uFoamEnd, uFoamOpacity; and what shader({ uniforms }) declared
     * @type {Record<string, { value: any }>}
     */
    this.uniforms = built.uniforms;
    /** @internal the engine's own material; a game's sits in _material instead */
    this._own = patchMaterial(neutralMaterial('water', { color: 0x888888, transparent: true, opacity: 0.85, flatShading: st.flat }), this.patches);
    /** @internal */ this._material = this._own;
    /**
     * Water body → mesh
     * @type {Map<WaterBody, THREE.Mesh>}
     */
    this.bodies = new Map();

    /**
     * Global water mesh (null when absent)
     * @type {THREE.Mesh | null}
     * @experimental
     */
    this.sea = null;
    /** @internal */ this._seaChecked = st.sea === false;   // global water is built on the first frame: terrain (water level) is installed by then, so no dependence on install order
    for (const b of engine.waterBodies) this._addBody(b);
    track(engine.events.on('water:add', b => this._addBody(b)));
    track(engine.events.on('water:remove', b => { const m = this.bodies.get(b); if (m) { this._drop(m); this.bodies.delete(b); } }));
  }

  /** One water mesh out of the scene. The material is shared by all water, so not engine.remove (which would dispose it); the ray registration goes too @internal */
  _drop(m) { const e = this.engine; m.removeFromParent(); e.rays.forget(m); this._uv.delete(m); m.geometry.dispose(); }
  /** The module goes: its meshes and what it made leave with it; a game's material stays the game's @internal */
  dispose() {
    for (const m of [this.sea, ...this.bodies.values()]) if (m) this._drop(m);
    this.sea = null; this.bodies.clear(); this._own.dispose(); this.normalTexture?.dispose();
  }

  /**
   * Water material, shared by all water. Reading gives the plain three.js material in use (a neutral MeshLambertMaterial until you set one); setting swaps it on every
   * water mesh and draws it as given: no engine patch is added, so a material that should keep the waves goes through applyEffects(m, { patches: engine.water.patches })
   * @type {Material}
   */
  get material() { return this._material; }
  set material(m) {
    needMaterial('water-option', 'engine.water.material', m, '; e.g. engine.water.material = applyEffects(new THREE.MeshPhongMaterial({ color: 0x3070a0 }), { patches: engine.water.patches })');
    const was = this._material;
    if (m === was) return;
    this._show(m);
    if (was === this._own) was.dispose();   // only its GPU program: setting it back compiles it again
  }

  /**
   * Which GLSL the water has. Keys left out keep what an earlier call gave; null takes one back to the built-in. Refreshes engine.water.patches and engine.water.uniforms
   * and patches the engine's own material again (one recompile). A game's material is the game's to patch again. uWave, uWaveScale, uWaveSpeed and uFresnel stay the same objects
   * @example
   * engine.water.shader({ depthColor: { shallow: 0x55ddcc, deep: 0x082040 }, foam: true });
   * engine.water.shader({ uniforms: { uBands: 4 }, surface: `vec4 threedogWaterSurface(vec4 base, float wave, float facing, vec3 worldPos, float time) {
   *   return vec4(base.rgb * floor(facing * uBands) / uBands, base.a); }` });
   * @param {WaterShaderOptions} [opts]
   * @returns {void}
   */
  shader(opts = {}) {
    readParams('engine.water.shader', SHADER_PARAMS, opts);
    const next = { ...this._shader, ...opts }, built = this._build(next);   // a wrong value throws here, with nothing changed
    this._shader = next; this.patches = built.patches; this.uniforms = built.uniforms;
    for (const name of ['waves', 'waterSurface', 'fresnel']) unpatchMaterial(this._own, name);   // patchMaterial only adds: foam taken back must leave the program
    patchMaterial(this._own, this.patches);
  }

  /**
   * Normal map by asset name (null = none): a flat-normal placeholder until the asset loads, then it takes the asset's image source (shared, not copied; goes through asset
   * management, so it can be preloaded and released). Goes on the engine's own material; a game's material takes the returned texture (also engine.water.normalTexture).
   * The tiling and the scroll apply whatever material draws. Keys left out keep their value (defaults scale 0.4, repeat 0.05, speed [0.01, 0.006])
   * @example
   * engine.water.normalMap('water-n', { scale: 0.6, repeat: 0.1, speed: [0.02, 0.01] });
   * @param {string | null} name
   * @param {{ scale?: number, repeat?: number, speed?: [number, number] }} [opts] scale: strength; repeat: tiles per meter; speed: scroll [x, z] per second
   * @returns {Texture | null}
   */
  normalMap(name, opts = {}) {
    if (name != null && typeof name !== 'string') throw codedError('water-option', `engine.water.normalMap(name, { scale, repeat, speed }): name is an asset name or path, or null for none; got ${typeof name}`);
    const o = readParams('engine.water.normalMap', NORMAL_PARAMS, opts), n = this._normal, own = /** @type {THREE.MeshLambertMaterial} */ (this._own);
    for (const k of ['scale', 'repeat', 'speed']) if (o[k] !== undefined) n[k] = o[k];
    if ((name ?? null) !== n.name) {
      n.name = name ?? null;
      const t = name ? placeholderTexture('normal') : null;
      this.normalTexture?.dispose();   // the one this replaces: the engine made it, so it frees it (its asset callback ignores it from now on)
      this.normalTexture = own.normalMap = t;
      own.needsUpdate = true;
      if (t) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.engine.assets.useTexture(name, a => { if (this.normalTexture === t) { t.source = a.source; t.needsUpdate = true; } }, { where: 'water normalMap', instead: 'the generated ripples stay', opts: { color: false } });
      }
    }
    own.normalScale.set(n.scale, n.scale);
    for (const mesh of this._uv.keys()) this._tile(mesh);
    return this.normalTexture;
  }

  /** Hand a material to every water mesh @internal */
  _show(m) {
    this._material = m;
    for (const mesh of [this.sea, ...this.bodies.values()]) if (mesh) mesh.material = m;
  }
  /** Scale a mesh's UVs to size * repeat (the normal map tiles in meters); a no-op without a normal map or when already at that factor @internal */
  _tile(mesh) {
    const u = this._uv.get(mesh); if (!this.normalTexture || !u) return;
    const f = u.sx * this._normal.repeat, g = u.sz * this._normal.repeat; if (f === u.f && g === u.g) return;
    // always from the UVs the mesh was made with: scaling the current ones by f / u.f would divide by zero after repeat 0 and lose them for good
    const uv = mesh.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u.base[i * 2] * f, u.base[i * 2 + 1] * g);
    uv.needsUpdate = true; u.f = f; u.g = g;
  }
  /** The patches and uniforms for what shader() was given @internal */
  _build(given) {
    const e = this.engine, water = this, shader = waterShader(given), surface = surfacePatch(e, shader), waves = wavesPatch(e, this._tune, shader, !!surface), { uFresnel } = this._tune;
    // grazing-angle reflection: the flatter the view, the closer to _reflects(); the getter follows whatever exists at draw time
    const uFresnelColor = { get value() { return water._reflects(); } };
    const fresnel = { name: 'fresnel', uniforms: { uFresnel, uFresnelColor },
      pars: 'uniform float uFresnel; uniform vec3 uFresnelColor;', slot: 'output', glsl: `
        #if defined(LAMBERT) || defined(PHONG) || defined(STANDARD) || defined(TOON) || defined(MATCAP)
        float threedogFres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), ${glslFloat(FRESNEL_POWER)}) * uFresnel;
        outgoingLight = mix(outgoingLight, uFresnelColor, clamp(threedogFres, 0.0, 1.0));
        #endif`,   // why the #if: a game's MeshBasicMaterial has no normal / view variables, so it gets no reflection, and patches stays one list for every material
      // NodeMaterial: the same blend (threedog/tsl waterFresnel) on the color before fog; the uniform nodes read these objects every render
      tsl: c => (c.material.isMeshBasicMaterial || c.material.isMeshBasicNodeMaterial ? c.output : c.tsl.vec4(c.fx.waterFresnel(c.output.rgb, c.tsl.normalView, c.tsl.positionViewDirection,
        c.fx.patchUniform(uFresnel), c.fx.patchUniform(uFresnelColor)), c.output.a)) };
    return { patches: surface ? [waves, surface, fresnel] : [waves, fresnel], uniforms: { ...waves.uniforms, ...surface?.uniforms, uFresnel } };
  }
  /** What grazing angles reflect: the fog color; with no fog the sky's horizon, because a fixed gray glows on dark water at night; with no sky a neutral gray @internal */
  _reflects() { const e = this.engine; return fogLook(e.scene, e.renderer)?.color ?? (e.sky ? e.uniforms.uSkyHorizon.value : GREY); }
  /** @internal */
  _prep(mesh, sx, sz = sx) {
    mesh.receiveShadow = true; mesh.renderOrder = 1;
    this._uv.set(mesh, { sx, sz, f: 1, g: 1, base: Float32Array.from(mesh.geometry.attributes.uv.array) }); this._tile(mesh);
  }
  /** @internal */
  _addBody(b) {
    if (b.query) return;   // the game's own water (addWaterBody({ query })): it draws the mesh
    const seg = Math.max(4, Math.round((b.radius ? b.radius * 2 : Math.max(b.hw, b.hd) * 2) / this.cell));
    const geo = b.radius ? new THREE.CircleGeometry(b.radius, Math.max(16, seg * 2)).rotateX(-Math.PI / 2) : new THREE.PlaneGeometry(b.hw * 2, b.hd * 2, seg, seg).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, this._material);
    m.position.set(b.x, b.level - 0.1, b.z);
    this._prep(m, b.radius ? b.radius * 2 : b.hw * 2, b.radius ? b.radius * 2 : b.hd * 2);   // a rectangle tiles per meter on each axis
    this.engine.add(m, { owner: 'engine:water' });
    this.bodies.set(b, m);
  }
  /** @internal */
  _makeSea() {
    this._seaChecked = true;
    const st = this.st, level = st.level ?? (Number.isFinite(this.engine.waterLevel) ? this.engine.waterLevel : null);
    if (level == null) return;
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(st.size, st.size, st.segments, st.segments).rotateX(-Math.PI / 2), this._material);
    this.sea.position.y = level - 0.2;
    this._prep(this.sea, st.size);
    this.engine.add(this.sea, { owner: 'engine:water' });
  }
  /**
   * Per-frame update: global water snaps to the focus grid, normal map scrolls (called by the module itself each frame)
   * @param {Vector3} focus
   * @param {number} dt
   * @returns {void}
   * @internal
   */
  update(focus, dt) {
    if (!this._seaChecked) this._makeSea();
    if (this.sea) {
      const c = this.cell * 4;
      this.sea.position.x = Math.round(focus.x / c) * c;
      this.sea.position.z = Math.round(focus.z / c) * c;
    }
    if (this.normalTexture) { const s = this._normal.speed; this.normalTexture.offset.x += s[0] * dt; this.normalTexture.offset.y += s[1] * dt; }
  }
}

/**
 * Water → engine.water. Global level defaults to the terrain water level; independent bodies use engine.addWaterBody()
 * @param {WaterOptions} [opts]
 * @returns {ModuleDef<Water>}
 */
export function water(opts = {}) {
  readParams('water', WATER_PARAMS, opts);
  let w = null;
  return { name: 'water', skipKind: 'none', type: 'picture', label: 'Water', params: WATER_PARAMS, options: opts, stage: 'environment', optional: ['sky'], install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.water': '水面' }, en: { 'module.water': 'water' } }); w = new Water(e, opts, ctx.track); return w; }, frame(dt, e) { w.update(e.focus, dt); }, dispose() { w.dispose(); },
    // "is there water where I think": the global sea (its level and plane size; null = none, e.g. no water level) and each separate body
    describe() {
      const r = v => Math.round(v * 10) / 10, s = w.sea;
      const bodies = [...w.bodies.keys()].map(b => ({ x: r(b.x), z: r(b.z), level: r(b.level), ...(b.radius ? { radius: r(b.radius) } : { size: [r(b.hw * 2), r(b.hd * 2)] }) }));
      return { sea: s ? { level: r(s.position.y + 0.2), size: w.st.size } : null, bodies };
    } };
}

export const handRolled = 'none: water of its own is plain three.js, used on purpose';
