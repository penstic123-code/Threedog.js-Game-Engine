// Vegetation data part: what grows where. Species definitions (placement rule, positions, densityMap, rings), placement per chunk
// (c.plants[name]: matrices, colors, stable ids), tree collision circles (c.colliders), felled-tree records (saved) and instanceAt.
// Data only: this file makes no mesh and touches no material. Draw parts subscribe with view({ species, change, ring, show, drop })
// (vegetation/draw.js is the engine's own, slot 'vegetation-draw'); the models and materials given to define() are read there.
import { Vector3 } from 'three';
import { vegetationModel } from '../../core/assets/namedModel.js';
import { isModelName } from '../../core/base/util.js';
import { DEV, warnMissing, warnOnce } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
// radius must be finite: an Infinity radius makes the chunk loops below start at -Infinity and never advance
const AT_PARAMS = keysSchema(['radius', 'species'], {}, { radius: { type: 'number', min: 0, optional: true } });
import { reportError } from '../../core/base/errors.js';
import { xzOf } from '../../core/base/math.js';
import { GroundChunks } from './groundChunks.js';
import { fadeBand } from './nearFade.js';
import { makeDensity, thin } from './densityMap.js';
import { coded, codedError } from '../../core/base/errorHints.js';
// parameters read by vegetation.define(); keys inside rule (sent to the worker thread)
const ADD_KEYS = ['geometry', 'model', 'lodGeometry', 'rule', 'positions', 'densityMap', 'wind', 'nearOnly', 'maxRing', 'lodRing', 'castShadow', 'shadowRing', 'receiveShadow', 'material', 'effects', 'doubleSided', 'fade', 'impostor'];
/**
 * The grass-shadow hint, or null: a species that is grass-scale by its own declaration (nearOnly, or drawn in the nearest ring only: maxRing 1) and
 * casts shadow by the engine default (castShadow ?? !nearOnly, as define() reads it) without the game having chosen: a castShadow or shadowRing
 * written out silences it. Thousands of small plants pay a shadow draw per chunk and cascade for a speckle few see. define() warns with it in dev,
 * content check (tools/content-check/world.mjs) reports it as a hint: one predicate for both
 * @param {string} name @param {any} o the define() / content options @returns {string | null}
 */
export function grassShadowHint(name, o) {
  const small = o?.nearOnly || o?.maxRing <= 1, casts = o?.castShadow ?? !o?.nearOnly;
  if (!small || !casts || o.castShadow !== undefined || o.shadowRing !== undefined) return null;
  return `vegetation ${name} is grass-scale (${o.nearOnly ? 'nearOnly' : 'maxRing 1'}) and casts shadows by default, a shadow draw per chunk and cascade for little to see: `
    + 'set castShadow: false, or shadowRing: 0 to keep them only in the nearest ring (castShadow: true keeps them and silences this)';
}
const RULE_KEYS = ['perChunk', 'chance', 'minHeight', 'maxHeight', 'maxSlope', 'cluster', 'scale', 'stretch', 'sink', 'tintJitter', 'tints', 'biomes', 'collider', 'avoidFlat', 'salt'];
// rule keys that only filter random attempts: with positions the game already chose every spot, so naming one is a mistake, not a no-op
const SCATTER_ONLY = ['perChunk', 'chance', 'minHeight', 'maxHeight', 'maxSlope', 'cluster', 'biomes', 'avoidFlat'];

// positions: [[x, z], [x, z, scale], [x, z, scale, yaw], ...] in world metres / size multiplier / radians. Checked here on the main thread
// because the list travels to the terrain worker as plain data, where a bad entry would only show up as a missing plant
function checkPositions(label, list, rule) {
  if (!Array.isArray(list)) throw codedError('vegetation-option', `${label}: positions is an array of [x, z] or [x, z, scale, yaw] entries`);
  list.forEach((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || p.length > 4 || !p.every(Number.isFinite)) throw codedError('vegetation-option', `${label}: positions[${i}] = ${JSON.stringify(p)}; each entry is [x, z], [x, z, scale] or [x, z, scale, yaw] (finite numbers)`);
  });
  const clash = SCATTER_ONLY.filter(k => rule && k in rule);
  if (DEV && clash.length) warnOnce(coded('vegetation-option', `${label}: rule.${clash.join(' / rule.')} only filters random placement and does not apply to positions (every listed spot is planted). Drop it, or add a second species for the scattered ones`));
}

// Single-instance removal/restore (chop a tree, mine a rock): records are owned by vegetation and saved with the save (save key 'vegetation', entry
// 'veg:<name>:<cx>,<cz>:<id>'), and reapplied when a chunk reloads.
// The id is this tree's stable number (independent of quality and vegetation density), not its index in the instance array.
//   const hit = engine.vegetation.instanceAt(position, { radius: 2, species: '松树' });   // → { species, cx, cz, id, position } or null
//   engine.vegetation.removeInstance(hit.species, hit.cx, hit.cz, hit.id, { regrowSeconds: 300 });  // grows back after 300 calendar seconds
//   engine.vegetation.restoreInstance(...)   // restore immediately
// Hiding: the slot goes into c.hidden[name] (the draw part draws it at zero scale, count unchanged) and out of the chunk's collision circles.
// Regrowth: the record stores the expiry time (engine.calendar seconds), checked once per second; the clock is saved, so the countdown continues after
// reload.
const KEY_RE = /^veg:(.*):(-?\d+),(-?\d+):(\d+)$/;
const hashName = s => { let h = 7; for (const ch of s) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0; return h & 0x7fffffff; };
// stable id -> instance slot of one placement result (built once per result, kept off the record so it never travels)
const SLOTS = new WeakMap();
function slotOf(r, id) {
  let m = SLOTS.get(r);
  if (!m) { m = new Map(); SLOTS.set(r, m); for (let i = 0; i < r.ids.length; i++) m.set(r.ids[i], i); }
  return m.get(id);
}

const REMOVE_KEYS = ['regrowSeconds'];
// impostor: true / false or { views, size }. The numbers size render targets (views layers of size x size), and content data can carry them,
// so a 0, NaN or huge value is refused here instead of building an empty or enormous target
function checkImpostor(label, v) {
  if (v === true || v === false) return;
  const bad = m => { throw codedError('vegetation-option', `${label}: impostor ${m}; write impostor: true or { views: 1..64, size: 16..1024 } (whole numbers)`); };
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`is ${JSON.stringify(v)}`);
  readParams(`${label}.impostor`, keysSchema(['views', 'size']), v);
  const int = (k, lo, hi) => { const n = v[k]; if (n !== undefined && !(Number.isInteger(n) && n >= lo && n <= hi)) bad(`${k} is ${JSON.stringify(n)}`); };
  int('views', 1, 64); int('size', 16, 1024);
}

export class Vegetation {
  constructor(engine, opts = {}, ctx) {
    this.engine = engine; this.species = new Map();
    /** this instance is over (removed or replaced, or the engine is gone): a late model or image must not write into the world any more */
    this._gone = () => ctx.signal?.aborted || engine.disposed;
    // where it grows: on terrain chunks when the terrain module is installed (placed in its workers), else on vegetation's own chunks over
    // whatever provides the ground (a level, a code-built ground, flat). Both hosts keep chunks of one shape, so everything below is shared
    if (engine.terrain && Object.keys(opts).length) throw codedError('vegetation-option', `vegetation({ ${Object.keys(opts).join(', ')} }): with terrain() installed vegetation grows on the terrain chunks, and density / view distance are terrain options (terrain({ density, viewChunks })). The vegetation() options are for ground without terrain (a level, a code-built ground)`);
    /** @internal the draw parts drawing the plants (view()) */ this.views = new Set();
    /** @internal the chunk table vegetation lives in: engine.terrain, or its own GroundChunks */
    /** @internal what its chunks live on: terrain, or its own ground chunks. The settings menu sizes the view through it */
    this.host = engine.terrain ?? new GroundChunks(engine, this, opts);
    // on terrain: this is the terrain's planter (it calls mount / unmount / drop / ring; terrain never reads engine.vegetation); a chunk's
    // visibility comes from the terrain data part, so a game that replaces the terrain drawing keeps its trees
    if (engine.terrain) {
      this._planter = engine.terrain.setPlanter(this);
      this._view = engine.terrain.view({ show: (c, v) => this._emit('show', c, v) });
    }
    this._removed = new Map();   // 'name:cx,cz' -> Map(id -> regrow time (calendar seconds), null = permanent)
    this._acc = 0;
    this._pending = [];   // density images still loading (densityMap.url); the module's init waits for them
    this._initDone = false;   // set when init has waited for _pending: an image of a species added later is not awaited, so its error is caught where it is added
    // dev asset hot swap (core/assets/assetHot.js): a species made from a swapped model is added again with the new geometry / materials. Why here and
    // not in the generic scene walk: a species' materials are patched copies (wind, season) and its geometry may be merged from a model
    ctx.track(engine.assets.onSwap(s => this._swapped(s)));
    ctx.saves.define('vegetation', { notAtomic: 'its load redraws the instances it hides: not plain data a rollback restores by itself',
      save: () => {
        const removed = {};
        for (const [ck, m] of this._removed) { for (const [id, until] of m) removed[`veg:${ck}:${id}`] = until; }
        return { removed };
      },
      load: d => {
        this._removed.clear();
        for (const [k, until] of Object.entries(d?.removed || {})) {
          const m = KEY_RE.exec(k); if (!m) continue;
          const ck = `${m[1]}:${m[2]},${m[3]}`;
          if (!this._removed.has(ck)) this._removed.set(ck, new Map());
          this._removed.get(ck).set(+m[4], until);
        }
        for (const c of this.host.chunks.values()) for (const n in c.plants) this.applyEdits(c, n);
      },
    });
  }

  /**
   * Register one kind of vegetation.
   * @param {string} name
   * @param {object} o
   *   geometry      high-detail model (this or model is required)
   *   model         a model name from an asset pack ('pine' or ['flower', color], as in content: then add returns a Promise of the species), or an
   *                 Object3D with one material per mesh (e.g. assets.model('oak')): trunk and leaves keep their own materials, still one draw per part
   * lodGeometry low-detail model (optional), used beyond the lodRing ring; with model it is a geometry (drawn with the first material) or an Object3D with the
   * same mesh order
   *   rule          placement rule: perChunk attempts per chunk, minHeight/maxHeight, maxSlope, cluster('forest'|'meadow'|'none'),
   *                 scale[min,max], stretch[min,max], sink, tintJitter, tints[{color:[r,g,b],chance}]
   *   positions     the game's own spots instead of random attempts: [[x, z], [x, z, scale, yaw], ...] world metres; each is planted at the ground
   *                 height (rule's scale / stretch / sink / tints / collider still apply; the scatter filters are refused). Stable id = list index
   *   densityMap    how much survives per spot, 0..1: (x, z) => 0..1, or a gray image { url | data + width + height, size: [w, l], center?, outside? }
   *                 (the keys of terrain({ heightmap })). Thins the rule's or the positions' placement; call rebuild() after a function's inputs change
   *   wind          wind sway amplitude (0 disables), or this species' own sway: { amplitude, glsl, tsl, uniforms }, which vegetation.sway() leaves alone (recipe 36)
   *   nearOnly      generate only near the player (grass, flowers)
   *   maxRing       not drawn beyond this ring count
   *   fade          near-only species shrink out over a band [start, end] metres from the player instead of popping at the ring edge (default on for
   *                 nearOnly, end = maxRing x chunk size; false = hard edge; { start, end } sets the band)
   *   lodRing       switch to low-poly beyond this ring count
   *   impostor      true or { views = 8, size = 128 }: beyond lodRing draw cards baked from this species' own model and materials (one draw for all far
   *                 chunks, lit live through baked normals, no shadow there). Instead of lodGeometry, not with it. WebGPU only; WebGL draws the mesh
   *   castShadow / shadowRing  whether to cast shadows, and within how many rings
   *   material      this species' own three.js material (optional; default is engine.vegetation.material); wind, cloud shadows, season tint and the
   *                 near fade are added to it (and its shadow sways) unless effects: false
   */
  define(name, o) {
    readParams(`vegetation.define('${name}')`, keysSchema(ADD_KEYS), o);
    const grass = DEV && grassShadowHint(name, o);
    if (grass) warnOnce(grass, 'grass-shadow\0' + name);
    // a model name ('pine' / ['flower', color]) means what it means in content: resolved through the same vegetationModel (cache, bake, file or
    // generator), then added as if the geometry / Object3D had been passed. Returns a Promise of the species then; start waits for it like a density image
    if (isModelName(o.model) || isModelName(o.lodGeometry)) {
      const p = Promise.all([isModelName(o.model) ? vegetationModel(this.engine, o.model) : { model: o.model }, isModelName(o.lodGeometry) ? vegetationModel(this.engine, o.lodGeometry) : null])
        .then(([main, low]) => {
          if (this._gone()) return null;
          const { model: _m, ...rest } = o;
          return this.define(name, { ...rest, ...(main.model ? { model: main.model } : { geometry: main.geometry ?? o.geometry }), ...(low && { lodGeometry: low.model ?? low.geometry }) });
        });
      if (!this._initDone) this._pending.push(p);
      else p.catch(err => reportError(this.engine, err, `vegetation.define('${name}') model`, { soft: true }));
      return p;
    }
    readParams(`vegetation.define('${name}').rule`, keysSchema(RULE_KEYS), o.rule);
    if (o.positions != null) checkPositions(`vegetation.define('${name}')`, o.positions, o.rule);
    const density = o.densityMap != null ? makeDensity(o.densityMap, `vegetation.define('${name}')`) : null;
    // distance fade band of near-only species (nearFade.js), checked here so a bad band throws at define; the draw part draws it
    // impostor and lodGeometry both say what is drawn beyond lodRing: one owner (docs/plans/2026-11-09-impostors.md)
    if (o.impostor && o.lodGeometry) throw codedError('vegetation-option', `vegetation.define('${name}'): impostor and lodGeometry both say what is drawn beyond lodRing; keep one`);
    if (o.impostor != null) checkImpostor(`vegetation.define('${name}')`, o.impostor);
    if (o.fade && typeof o.fade === 'object') readParams(`vegetation.define('${name}').fade`, keysSchema(['start', 'end']), o.fade);
    const maxRing = o.maxRing ?? (o.nearOnly ? 1 : 99);
    const sp = {
      name,
      // random seed from the name: placement is unaffected by registration order. positions rides inside the rule because the rule is what
      // reaches the placer (terrain worker or ground chunks), and a list of numbers travels as plain data
      rule: { salt: hashName(name), ...(o.rule || {}), ...(o.positions != null ? { positions: o.positions } : {}) },
      density,   // densityMap sampler (main thread only: a function may read game state), applied in mount()
      nearOnly: !!o.nearOnly, maxRing, lodRing: o.lodRing ?? 1, fade: o.effects === false ? null : fadeBand(o.fade, !!o.nearOnly, maxRing, this.host.chunkSize),
      castShadow: o.castShadow ?? !o.nearOnly, shadowRing: o.shadowRing ?? 1, receiveShadow: o.receiveShadow ?? true,
    };
    sp.source = o;   // what it was made from: the draw part reads geometry / model / material / wind from it, a hot swap adds it again (_swapped)
    this._emit('species', sp);   // the draw part builds geometry and materials now, so a bad model throws here, before anything is registered
    this.species.set(name, sp);
    this.host.registerSpecies(name, sp.rule);
    // a density image still loading: this species places nothing until it is in, then every chunk is placed again. The module's init waits
    // for those added before start, so a game never opens on a bare map; one added later fills in when its image arrives
    if (density?.pending) {
      // the image may arrive after this instance was removed (or engine.dispose()): the terrain may stay and be another instance's, so no rebuild
      const p = density.pending.then(() => { if (!this._gone() && this.species.get(name) === sp) this.host.rebuild(); });
      // only species added before init took _pending are awaited by init (a failure fails start); later ones nobody awaits, so report once
      // (soft: the species just stays empty, gameplay is not frozen for a missing image)
      if (!this._initDone) this._pending.push(p);
      else p.catch(err => reportError(this.engine, err, `vegetation.define('${name}') densityMap`, { soft: true }));
    }
    return sp;
  }
  /** @internal hot swap: species whose geometry or model meshes were swapped are added again (the chunks rebuild); returns { name: 1 } */
  _swapped({ geometry, material }) {
    const out = {};
    const remap = v => {
      if (v?.isBufferGeometry) return geometry.get(v)?.to ?? v;
      if (!v?.isObject3D) return v;
      const c = v.clone();
      c.traverse(m => {
        if (!m.isMesh) return;
        m.geometry = geometry.get(m.geometry)?.to ?? m.geometry;
        m.material = Array.isArray(m.material) ? m.material.map(x => material.get(x)?.to ?? x) : material.get(m.material)?.to ?? m.material;
      });
      return c;
    };
    const hit = v => {
      if (v?.isBufferGeometry) return geometry.has(v);
      let h = false; v?.traverse?.(m => { if (m.isMesh && (geometry.has(m.geometry) || [].concat(m.material).some(x => material.has(x)))) h = true; });
      return h;
    };
    for (const sp of [...this.species.values()]) {
      const o = sp.source;
      if (!o || !(hit(o.geometry) || hit(o.model) || hit(o.lodGeometry))) continue;
      this.define(sp.name, { ...o, ...(o.geometry && { geometry: remap(o.geometry) }), ...(o.model && { model: remap(o.model) }), ...(o.lodGeometry && { lodGeometry: remap(o.lodGeometry) }) });
      out[sp.name] = 1;
    }
    return out;
  }
  /** @internal module init: density images and named models of species added before start; a named model's define() may add an image of its own, so until none is left */
  async whenLoaded() {
    try { while (this._pending.length) { const p = this._pending; this._pending = []; await Promise.all(p); } }
    finally { this._initDone = true; }
  }
  /**
   * Place every chunk again: after changing the ground behind the same provider (a ground function reading game state), or what a densityMap
   * function reads. A new setGround or level is followed automatically
   */
  rebuild() { this.host.rebuild(); }
  get(name) { return this.species.get(name); }
  list() { return [...this.species.values()]; }
  /**
   * Change at runtime how far a vegetation kind casts shadows: within `ring` chunk rings of the player (0 = only the chunk you stand in, 1 = the default,
   * larger = further and dearer). Takes effect at once; the define() option shadowRing is only the starting value. An unknown name warns with the known ones
   * @example engine.vegetation.setShadowRing('tree', 0);   // graphics setting "shadows: low": trees shadow only the nearest chunk
   * @param {string} name species name given to vegetation.define
   * @param {number} ring chunk rings, 0 or more
   * @returns {void}
   */
  setShadowRing(name, ring) {
    const sp = this.species.get(name);
    if (!sp) { warnMissing('vegetation', name, [...this.species.keys()]); return; }
    sp.shadowRing = ring;
    this.host.refreshLevels();
  }
  /**
   * The shared default material: every species with no material or model of its own draws it. Set it and it is drawn as given, on plants already
   * planted too (no patches added; give it engine.vegetation.patches to keep the sway, season and color code, or use define({ material }) for a species'
   * own amplitude and near fade). null gives the neutral default back. Until set, reading gives the neutral source: each species draws its own copy
   * (engine.vegetationDraw.kind(name).material), so only .color written here reaches them all.
   * @example engine.vegetation.material = applyEffects(new THREE.MeshToonMaterial({ vertexColors: true }), { patches: engine.vegetation.patches });
   * @type {import('three').Material | null}
   */
  get material() { return this._drawPart('material').material; }
  set material(m) { this._drawPart('material').material = m; }
  /**
   * The engine's shader patches for plants (season tint, sway with one amplitude, the vegetation.color() code), for applyEffects on a game's shared
   * material. sway() and color() make a new array, and the game re-applies it to a material of its own
   * @type {any[]}
   */
  get patches() { return this._drawPart('patches').patches; }
  /**
   * Replace the sway shape of every species whose wind is a number, planted ones too; null gives the built-in sway back. This is the default shape; a species
   * defined with its own wind object keeps that one (the narrower entry wins). The GLSL defines
   * void threedogWind(inout vec3 transformed, vec3 ip, vec3 position), moving the vertex in object space (ip = world position of this plant; uTime, uWind,
   * uWindFreq, THREEDOG_WIND_AMP and your uniforms are in scope). tsl is the WebGPURenderer form, (ctx) => the moved object-space position.
   * How hard and fast plants sway are the signals engine.uniforms.uWindAmp and uWindFreq
   * @example engine.vegetation.sway('void threedogWind(inout vec3 t, vec3 ip, vec3 p){ t.x += sin(uTime + ip.x) * max(p.y, 0.0) * THREEDOG_WIND_AMP * uWind; }');
   * @param {string | { glsl?: string, tsl?: (ctx: any) => any, uniforms?: Record<string, any> } | null} spec
   * @returns {void}
   */
  sway(spec) { this._drawPart('sway').sway(spec); }
  /**
   * Code in the 'color' slot of every species' material, planted ones too: diffuseColor (vertex and instance colors, season tint applied) is yours to
   * change. tsl is the WebGPURenderer form, (ctx) => vec4 from ctx.color. null takes it off
   * @example engine.vegetation.color({ glsl: 'diffuseColor.rgb *= vec3(1.1, 0.9, 0.7);', tsl: c => c.color.mul(c.tsl.vec4(1.1, 0.9, 0.7, 1)) });
   * @param {string | { glsl?: string, tsl?: (ctx: any) => any, uniforms?: Record<string, any>, pars?: string } | null} spec
   * @returns {void}
   */
  color(spec) { this._drawPart('color').color(spec); }
  /** @internal the engine's drawing half; a game that replaced it draws with its own materials, so these entries have nothing to act on */
  _drawPart(entry) {
    const l = this.engine.vegetationDraw;
    if (!l) throw codedError('vegetation-option', `vegetation.${entry}: the plants are drawn by a game module (replaces: 'vegetation-draw'), which owns their materials; set the picture there`);
    return l;
  }
  /**
   * Draw the plants. Hooks: species(sp) (defined or defined again; sp.source is what define() was given), change(c, name) (c.plants[name]
   * placed, replaced or gone, or c.hidden[name] changed: felled slots), ring(c, ring) (LOD ring), show(c, visible) (in view or not), drop(c)
   * (the chunk was released). Species and chunks already there are replayed at once. This is how a draw part that replaces 'vegetation-draw'
   * draws. Returns { remove() } (ctx.track it).
   * @example ctx.track(engine.vegetation.view({ change(c, name) { draw(c, c.plants[name]) }, drop(c) { undraw(c) } }))
   * @param {{ species?: (sp: any) => void, change?: (c: any, name: string) => void, ring?: (c: any, ring: number) => void, show?: (c: any, visible: boolean) => void, drop?: (c: any) => void }} v
   * @returns {{ remove(): void }}
   */
  view(v) {
    this.views.add(v);
    try {   // a view that throws while the existing data is replayed is not registered: _emit would keep calling it and starve the views after it
      for (const sp of this.species.values()) v.species?.(sp);
      for (const c of this.host.chunks.values()) {
        if (c.state !== 'ready') continue;
        for (const n in c.plants) v.change?.(c, n);
        if (c.ring != null) v.ring?.(c, c.ring);
        if (c.inView === false) v.show?.(c, false);
      }
    } catch (e) { this.views.delete(v); throw e; }
    return { remove: () => { if (!this.views.delete(v)) return; for (const c of this.host.chunks.values()) if (c.state === 'ready') v.drop?.(c); } };
  }
  /** @internal tell every view */
  _emit(k, c, a) { for (const v of this.views) v[k]?.(c, a); }

  /** @internal terrain plumbing */
  baseNames() { return this.list().filter(s => !s.nearOnly).map(s => s.name); }
  /** @internal terrain plumbing */
  nearNames() { return this.list().filter(s => s.nearOnly).map(s => s.name); }

  // ---------- single-instance remove / restore ----------
  /** @internal save-key format */
  key(species, cx, cz, id) { return `veg:${species}:${cx},${cz}:${id}`; }
  isRemoved(species, cx, cz, id) { return !!this._removed.get(`${species}:${cx},${cz}`)?.has(id); }
  /** Remove one instance (regrowSeconds: calendar seconds until it grows back, 0/omitted = permanent). The record is saved with the save */
  removeInstance(species, cx, cz, id, opts) {
    const { regrowSeconds = 0 } = readParams('vegetation.removeInstance()', keysSchema(REMOVE_KEYS), opts);
    const ck = `${species}:${cx},${cz}`;
    if (!this._removed.has(ck)) this._removed.set(ck, new Map());
    this._removed.get(ck).set(id, regrowSeconds > 0 ? this.engine.clock.now + regrowSeconds : null);
    this._refresh(species, cx, cz);
    this.engine.events.emit('vegetation:remove', { species, cx, cz, id });
    return this.key(species, cx, cz, id);
  }
  restoreInstance(species, cx, cz, id) {
    const ck = `${species}:${cx},${cz}`, m = this._removed.get(ck);
    if (m) { m.delete(id); if (!m.size) this._removed.delete(ck); }
    this._refresh(species, cx, cz);
    this.engine.events.emit('vegetation:restore', { species, cx, cz, id });
  }
  /** @internal module hook: check once per second, those due grow back */
  tick(dt) {
    this._acc += dt;
    if (this._acc < 1) return;
    this._acc = 0;
    const now = this.engine.clock.now, due = [];
    for (const [ck, m] of this._removed) {
      const a = ck.lastIndexOf(':');
      for (const [id, until] of m) if (until != null && until <= now) due.push([ck.slice(0, a), ...ck.slice(a + 1).split(',').map(Number), id]);
    }
    for (const d of due) this.restoreInstance(...d);
  }

  /**
   * The plant a ray hit, read from the hit itself (no spatial guess): the same { species, cx, cz, id, position } instanceAt returns, so it goes straight to
   * removeInstance / key; null when the hit is not a vegetation draw mesh, or is the far impostor card
   * @param {{ object?: any, instanceId?: number }} hit a raycast hit (engine.pick)
   * @returns {{ species: string, cx: number, cz: number, id: number, position: Vector3 } | null}
   */
  plantOf(hit) {
    const u = hit?.object?.userData, i = hit?.instanceId, id = u?.plants?.ids?.[i];
    if (u?.species == null || id == null) return null;
    const a = u.plants.m, CH = this.host.chunkSize;
    return { species: u.species, cx: u.cx, cz: u.cz, id, position: new Vector3(u.cx * CH + a[i * 16 + 12], a[i * 16 + 13], u.cz * CH + a[i * 16 + 14]) };
  }

  /**
   * Nearest instance within radius meters (default 2) of position (loaded chunks only; species restricts to one kind): { species, cx, cz, id, position } or
   * null
   */
  instanceAt(position, opts = {}) {
    readParams('vegetation.instanceAt()', AT_PARAMS, opts);
    const [x, z] = xzOf(position), { radius = 2, species = null } = typeof opts === 'object' && opts ? opts : {};
    const T = this.host, CH = T.chunkSize;
    let best = null, bestD = radius * radius;
    for (let cz = Math.floor((z - radius) / CH); cz <= Math.floor((z + radius) / CH); cz++)
      for (let cx = Math.floor((x - radius) / CH); cx <= Math.floor((x + radius) / CH); cx++) {
        const c = T.chunks.get(cx + ',' + cz);
        if (!c || c.state !== 'ready') continue;
        for (const name in c.plants) {
          if (species && name !== species) continue;
          const r = c.plants[name], a = r.m, hid = c.hidden?.[name], ox = cx * CH, oz = cz * CH;
          for (let i = 0; i < r.n; i++) {
            if (hid?.has(i)) continue;
            const dx = ox + a[i * 16 + 12] - x, dz = oz + a[i * 16 + 14] - z, d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = { species: name, cx, cz, id: r.ids[i], position: new Vector3(ox + a[i * 16 + 12], a[i * 16 + 13], oz + a[i * 16 + 14]) }; }
          }
        }
      }
    return best;
  }

  /** @internal chunk plumbing (terrain chunks and ground chunks): one species' placement result r for chunk c (data; the draw parts draw it) */
  mount(c, name, r, held = false) {
    const sp = this.species.get(name);
    if (!sp) return;   // a result of a species this instance does not know (a removed instance's job, or one taken back): no plants, no colliders without a draw kind
    // densityMap thins here, before the colliders are taken, so a dropped plant blocks nothing; survivors keep their stable ids
    if (sp.density) r = thin(r, c.cx * this.host.chunkSize, c.cz * this.host.chunkSize, sp.density.at, sp.rule.salt);
    c.plants ||= {}; c.colliders ||= {}; c.collidersAll ||= {};
    // none left (terrain dug, densityMap thinned all): drop the record, so the draw part tears its mesh down too and collision matches what is drawn
    if (r.n === 0) delete c.plants[name]; else c.plants[name] = r;
    if (r.n && r.k?.length) c.collidersAll[name] = r.k; else delete c.collidersAll[name];   // original circles (before felled trees are filtered)
    // held: the plants are drawn but their colliders wait for release() (a near-only species whose collision takes effect on a committed tick)
    if (held) (c.held ||= {})[name] = true; else if (c.held) delete c.held[name];
    this.applyEdits(c, name);   // felled trees stay gone after reload; sets the colliders and tells the draw parts
  }
  /** @internal chunk plumbing: the held colliders of a species take effect */
  release(c, name) { if (c.held?.[name]) { delete c.held[name]; this.applyEdits(c, name); } }
  /** @internal chunk plumbing: drop a near-only species from a chunk that moved out of its ring */
  unmount(c, name) {
    if (!c.plants?.[name]) return;
    delete c.plants[name]; delete c.collidersAll?.[name]; if (c.held) delete c.held[name];
    this.applyEdits(c, name);
  }
  /**
   * @internal the module is removed: on terrain the chunks stay and are not ours, so take back what this instance placed on them (plants, tree
   * colliders, treeToken so physics drops the trunks) through unmount, then let go of the terrain. The own ground chunks go with the module
   */
  detach() {
    if (this._planter) for (const c of this.host.chunks.values()) for (const n in c.plants) this.unmount(c, n);
    this._view?.remove(); this._planter?.remove();
  }
  /** @internal chunk plumbing: the chunk was released */
  drop(c) { this._emit('drop', c); c.plants = {}; c.hidden = null; c.held = null; }
  /** @internal chunk plumbing: the chunk's ring changed; the draw parts pick draw distance, low-poly swap and shadows from it */
  ring(c, ring) { c.ring = ring; this._emit('ring', c, ring); }

  /** @internal felled-tree records -> c.hidden[name] (instance slots) and the chunk's collision circles; tells the draw parts */
  applyEdits(c, name) {
    const r = c.plants?.[name], hid = new Set();
    if (r) for (const id of this._removed.get(`${name}:${c.cx},${c.cz}`)?.keys() ?? []) { const s = slotOf(r, id); if (s !== undefined) hid.add(s); }
    (c.hidden ||= {})[name] = hid.size ? hid : null;
    // collision circles map one-to-one to instances (instance i = group i of [x, z, r]); drop the hidden ones
    const all = r && !c.held?.[name] ? c.collidersAll?.[name] : null, before = c.colliders[name];
    if (!all) delete c.colliders[name];
    else if (!hid.size) c.colliders[name] = all;
    else {
      const out = [];
      for (let i = 0; i < all.length / 3; i++) if (!hid.has(i)) out.push(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]);
      c.colliders[name] = new Float32Array(out);
    }
    // physics rebuilds this chunk's trunks (only them: the ground triangles keep their own token); a new placement always counts as a change
    if (before !== c.colliders[name] || r) c.treeToken = {};
    this._emit('change', c, name);
  }

  _refresh(species, cx, cz) {
    const c = this.host.chunks.get(cx + ',' + cz);
    if (c?.plants?.[species]) this.applyEdits(c, species);   // chunk not loaded: applyEdits runs when it is placed
  }
}
