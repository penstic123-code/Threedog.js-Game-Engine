// Vegetation drawing: draws what the vegetation data part placed. One InstancedMesh per species per chunk from the chunk's placement records
// (c.plants[name]: m matrices, c colors, ids, n), the species' geometry / low-poly geometry / material (wind sway, season tint, near fade
// patched in), ring LOD (draw distance, low-poly swap, shadow distance) and frustum visibility (per mesh and per camera, by three: cullSphere). No show() hook: hiding
// a chunk's group off the main view also took its shadows out of every shadow pass (three skips invisible parents). Installed by vegetation() as its own module
// 'vegetationDraw' holding the slot 'vegetation-draw'. Its picture entries are reached through engine.vegetation: material, patches, sway(), color().
//
// Why a separate module: collision, paths, felling and instanceAt read only the data part, so a game can swap the whole plant picture
// (engine.use(myPlants, { replaces: 'vegetation-draw' })) and keep everything that plays. A replacement draw part does what this file does:
//   install(e, ctx) { ctx.track(e.vegetation.view({ species(sp) {...}, change(c, name) {...c.plants[name]...}, ring(c, ring) {...}, show(c, v) {...}, drop(c) {...} })); }
// This file never changes placement data; it only reads it.
import { engineOwned } from '../../core/scene/things.js';
import { drawOnly } from '../../core/scene/drawOnly.js';
import { needMaterial, oneForm, warnOnce } from '../../core/base/validate.js';
import * as THREE from 'three';
import { fromModel } from './modelGeometry.js';
import { applyEffects, windCustom } from '../../render/materials.js';
import { neutralMaterial } from '../../render/neutral.js';
import { patchMaterial, unpatchMaterial, cloneMaterial } from '../../render/patches.js';
import { EFFECTS, hashText } from '../../render/effects.js';
import { codedError } from '../../core/base/errorHints.js';
import { isWebGPU, webgpuPart, onRendererSwap } from '../../render/backend.js';
import { nearFadePatch } from './nearFade.js';
import { scatterAttempts } from '../../core/stream/scatter.js';

const COLOR = 'vegetationColor';   // the patch name of vegetation.color() on every species' material
// The wind patch in engine.vegetation.patches has one amplitude: a shared material cannot carry each species' own (those are define()'s wind option)
const SHARED_SWAY = 0.05;
const code = v => (typeof v === 'string' ? { glsl: v } : v);
// what applyEffects adds to a species' material (render/effects.js names, the near fade, vegetation.color()): taken off the impostor's bake copy
const FX_NAMES = ['wind', 'clouds', 'season', 'world', 'detail'];
/** A copy of a game material without the engine's effect patches (its own patches stay) @param {any} m @param {any[]} own this species' own patches */
function unpatched(m, own) {
  const c = cloneMaterial(m);
  for (const n of [...FX_NAMES, ...own.map(p => p.name)]) unpatchMaterial(c, n);
  return c;
}

/**
 * How many instances of a placement to draw at a density. A plant with a collider is placed in full at every quality, so collision and felled ids stay the same world, and low
 * quality thins only its drawing. Why a count and not a filter: ids rise in placement order, so the plants a density keeps are the front of the list, the same ones it kept when
 * it thinned placement, and the instances behind just are not drawn. A blocker that is not drawn still blocks. rule.positions are the game's own and never thin.
 * @internal
 */
export function drawnPlants(rule, r, density) {
  if (!rule?.collider || rule.positions) return r.n;
  const keep = scatterAttempts(rule, density);
  let n = r.n;
  while (n > 0 && r.ids[n - 1] >= keep) n--;
  return n;
}

/**
 * The culling sphere of one chunk's plants of one species, so three culls the mesh per camera: the main view skips the chunks it does not see, and
 * each shadow camera (every cascade) draws only the chunks inside its own box. With frustumCulled off every cascade drew every casting chunk and the
 * nearest ring drew behind the camera too: the draw count of a grassy scene, for nothing on screen. Grown by twice the largest plant: the built-in
 * sway moves a vertex by its height x amplitude x wind, within the plant's own height while amplitude x wind stays under 1; the low-poly geometry
 * counts too, as _level swaps it in without a recompute.
 * shortcut: a game's own sway() moving plants farther than their height could clip them at the screen edge; then grow the margin from the sway.
 */
function cullSphere(im, k) {
  im.boundingSphere = null; im.computeBoundingSphere();   // three: each instance matrix x the geometry's sphere, over im.count
  const a = im.instanceMatrix.array;
  let s2 = 0;
  for (let o = 0; o < im.count * 16; o += 16) s2 = Math.max(s2, a[o] ** 2 + a[o + 1] ** 2 + a[o + 2] ** 2, a[o + 4] ** 2 + a[o + 5] ** 2 + a[o + 6] ** 2, a[o + 8] ** 2 + a[o + 9] ** 2 + a[o + 10] ** 2);
  const radius = g => { if (!g) return 0; if (!g.boundingSphere) g.computeBoundingSphere(); return g.boundingSphere.radius + g.boundingSphere.center.length(); };
  im.boundingSphere.radius += 2 * Math.sqrt(s2) * Math.max(radius(k.geometry), radius(k.lodGeometry));
}

export class VegetationDraw {
  /** @param {any} e @param {any} v the vegetation data part (engine.vegetation) */
  constructor(e, v) {
    this.engine = e; this.v = v;
    // what engine.vegetation.material reads until the game sets one. Each species draws its own copy (wind amplitude and fade band are per species);
    // the copies share this Color, so a write to material.color reaches them
    /** @internal */ this._base = neutralMaterial('vegetation', { vertexColors: true });
    /** @internal the game's shared material, drawn as given */ this._game = null;
    /** @internal vegetation.sway()'s { glsl, tsl, uniforms } */ this._sway = null;
    /** @internal vegetation.color()'s patch */ this._color = null;
    /** @internal species name -> { geometry, lodGeometry, material, fadeUniforms, shared } */ this.kinds = new Map();
    /** @internal chunk record -> { group, ims: { name: InstancedMesh } } */ this.meshes = new Map();
    this._refreshPatches();
    this._view = v.view(this);
    /** @internal */ this._swap = onRendererSwap(e, () => {
      if (isWebGPU(e.renderer)) return;
      let any = false;
      for (const [n, k] of this.kinds) if (k.impostor) { this._dropCards(k); k.impostor = null; this._noCards(n); any = true; }
      if (any) for (const c of this.meshes.keys()) if (c.ring != null) this.ring(c, c.ring);
    });
  }

  /** @internal engine.vegetation.material: every species with no material or model of its own draws it, as given; null gives the neutral default back */
  get material() { return this._game ?? this._base; }
  set material(m) {
    if (m != null) needMaterial('vegetation-option', 'vegetation.material', m, ' (null gives the neutral default back)');
    this._game = m || null;
    for (const sp of this.v.list()) {
      const old = this.kinds.get(sp.name);
      if (old?.shared) this.species(sp);
    }
    for (const [c, rec] of this.meshes) for (const n in rec.ims) {
      const k = this.kinds.get(n), im = rec.ims[n]; if (!k) continue;
      im.userData.base = im.material = k.material;
      if (c.ring != null) this._level(im, this.v.get(n), k, c.ring);
    }
  }

  /** @internal engine.vegetation.sway(): the new shape reaches the engine's own species materials; a shared material of the game is the game's to re-patch */
  sway(spec) {
    const s = spec == null ? null : code(spec);
    if (s) { windCustom(s); this._needForm('sway', s); }   // a wrong sway function throws here, not later inside vegetation.define
    this._sway = s;
    this._refreshPatches();
    // a number is an amplitude for this shape; a species' own wind object is its own sway and stays (see species())
    this._eachOwn((m, sp) => { if (typeof sp.source.wind === 'number' && sp.source.wind) patchMaterial(m, [this._windPatch(sp.source.wind)], { strict: false }); });
  }

  /** @internal engine.vegetation.color(): live on the engine's own species materials, one patch object so they keep sharing a program */
  color(spec) {
    const s = spec == null ? null : code(spec);
    if (s) {
      if (typeof s !== 'object' || (s.glsl != null && typeof s.glsl !== 'string') || (s.tsl != null && typeof s.tsl !== 'function')) throw codedError('vegetation-option', 'vegetation.color() takes GLSL code, or { glsl, tsl: (ctx) => vec4, uniforms, pars }');
      this._needForm('color', s);
    }
    this._color = s && { name: COLOR, slot: 'color', cacheKey: hashText(JSON.stringify([s.glsl ?? '', s.pars ?? ''])),
      ...(s.uniforms && { uniforms: s.uniforms }), ...(s.glsl != null && { glsl: s.glsl, ...(s.pars && { pars: s.pars }) }), ...(s.tsl && { tsl: s.tsl }) };
    this._refreshPatches();
    this._eachOwn(m => { if (this._color) patchMaterial(m, [this._color]); else unpatchMaterial(m, COLOR); });
  }

  /** Each renderer draws its own form; the one this engine's renderer needs, when missing, is named (else the code would do nothing silently) */
  _needForm(entry, s) {
    const gpu = isWebGPU(this.engine.renderer);
    if (gpu ? s.tsl == null : s.glsl == null) throw oneForm('vegetation-option', `vegetation.${entry}()`, !!gpu);
  }
  _windPatch(amplitude) { return EFFECTS.wind(amplitude, this._sway ? windCustom(this._sway) : undefined); }
  /** engine.vegetation.patches: what a game's shared material needs to behave like the engine's (the near fade is per species: define({ material }) gets it) */
  _refreshPatches() { /** @internal */ this.patches = [EFFECTS.season('foliage'), this._windPatch(SHARED_SWAY), ...(this._color ? [this._color] : [])]; }
  /** Materials the engine patches: not effects: false species, not the game's shared material */
  _eachOwn(fn) {
    for (const sp of this.v.list()) {
      const k = this.kinds.get(sp.name);
      if (!k || sp.source.effects === false) continue;
      for (const m of [k.material === this._game ? [] : k.material, k.lodMaterial ?? []].flat()) fn(m, sp);   // a low-poly model's materials are the engine's even under the game's shared one
    }
  }

  /** The InstancedMesh drawing one species in one chunk (null when none is drawn there) @param {any} c chunk record @param {string} name */
  mesh(c, name) { return this.meshes.get(c)?.ims[name] ?? null; }
  /** How one species is drawn: { geometry, lodGeometry, material, fadeUniforms } (null for an unknown name) @param {string} name */
  kind(name) { return this.kinds.get(name) ?? null; }

  /** @internal view hook: a species was defined (or defined again): build its geometry and patched materials. A bad option throws into define() */
  species(sp) {
    const o = sp.source, e = this.engine, label = `vegetation.define('${sp.name}')`;
    const wind = typeof o.wind === 'number' && o.wind && this._sway ? { amplitude: o.wind, ...this._sway } : o.wind;   // vegetation.sway() is the default shape, a species' own wind object wins
    // distance fade of near-only species (nearFade.js): the band was worked out (and checked) by define(), null = hard ring edge
    const band = sp.fade, nf = band && nearFadePatch(band);
    const own = [nf?.patch, this._color].filter(Boolean);
    const fx = m => o.effects === false ? m : applyEffects(m, { wind, season: 'foliage', engine: e, patches: own.length ? own : undefined });
    const mdl = o.model && fromModel(o.model, label);
    const lodMdl = o.lodGeometry?.isObject3D ? fromModel(o.lodGeometry, label + '.lodGeometry') : null;
    let lod = lodMdl ? lodMdl.geometry : o.lodGeometry || null;
    if (mdl && lod && !lod.groups.length) { lod = lod.clone(); lod.addGroup(0, Infinity, 0); }   // a material array draws nothing without groups
    const shared = !mdl && !o.material, game = shared ? this._game : null;
    // the impostor bakes the game's material as given: copy it before fx patches it in place (wind, clouds, season baked in, season then twice)
    const bakeOwn = o.impostor && !mdl && o.material ? unpatched(o.material, own) : null;
    const material = game ?? (mdl ? mdl.materials.map(fx) : fx(o.material ?? this._neutral(o)));
    // a low-poly model keeps its own parts and materials (its groups index its own list, so the part order of the two models need not match), whatever the main one is made of
    const lodMaterial = lodMdl ? lodMdl.materials.map(fx) : null;
    // what was built here and is ours to free (the game's geometry and materials stay the game's); a mesh still drawing the old ones uploads them again
    const made = [...new Set([...(lodMdl?.materials ?? []), ...(lodMaterial ?? []), ...(lod && lod !== o.lodGeometry ? [lod] : []), ...(mdl ? [mdl.geometry, ...material] : shared && !game ? [material] : [])])];
    // fade: the game's shared material has none, but a low-poly model of the species has its own
    const old = this.kinds.get(sp.name);
    this.kinds.set(sp.name, { geometry: mdl ? mdl.geometry : o.geometry, lodGeometry: lod, lodMaterial, fadeUniforms: game && !lodMaterial ? null : nf?.uniforms ?? null, shared, material, made,
      impostor: this._impostor(sp, mdl, game, bakeOwn) });
    for (const d of old?.made ?? []) d.dispose();
    this._dropCards(old);
  }
  /**
   * Far cards of an impostor species (render/impostor.tsl.js): what to bake from and the one card mesh for all its far chunks, built in updateCards().
   * The bake reads materials without the engine's patches, so wind, cloud shadow and season are not baked in (the card adds the season live):
   * a model's own materials (fromModel patched copies of them), an unpatched copy of a species' own material, the game's shared one as drawn
   */
  _impostor(sp, mdl, game, bakeOwn) {
    const o = sp.source;
    if (!o.impostor) return null;
    if (!isWebGPU(this.engine.renderer)) { bakeOwn?.dispose(); this._noCards(sp.name); return null; }
    const own = [];
    o.model?.traverse?.(n => { if (n.isMesh) own.push(n.material); });   // fromModel's order: one group per mesh
    const neutral = !mdl && !o.material && !game ? this._neutral(o) : null;
    return { opts: o.impostor === true ? {} : o.impostor, src: { geometry: mdl ? mdl.geometry : o.geometry, material: mdl ? own : (bakeOwn ?? game ?? neutral), season: o.effects !== false && !game },
      bake: null, mesh: null, dirty: true, neutral, bakeOwn };
  }
  _noCards(name) {
    warnOnce(`vegetation.define('${name}'): impostor cards need the WebGPU renderer (WebGPURenderer); on WebGLRenderer this species draws its full mesh beyond lodRing too`, 'impostor-webgl\0' + name);
  }
  /** Free a species' far cards (redefined or disposed) */
  _dropCards(k) {
    const I = k?.impostor; if (!I) return;
    if (I.mesh) { I.mesh.removeFromParent(); I.mesh.geometry.dispose(); I.mesh.material.dispose(); }
    I.bake?.dispose(); I.neutral?.dispose(); I.bakeOwn?.dispose();
  }
  /**
   * @internal module frame hook: rebuild the far cards of each impostor species whose chunks changed since the last frame. One mesh per species for every
   * chunk beyond lodRing (that is the draw saved). Reads the chunk meshes' instance arrays, so felled plants (zero scale) and thinned counts carry over
   */
  updateCards() {
    for (const [name, k] of this.kinds) {
      const I = k.impostor, sp = this.v.get(name);
      if (!I?.dirty || !sp) continue;
      I.dirty = false;
      const far = [];
      let n = 0;
      for (const [c, rec] of this.meshes) { const im = rec.ims[name]; if (im && c.ring > sp.lodRing && c.ring <= sp.maxRing && im.count) { far.push([c, im]); n += im.count; } }
      if (!n && !I.mesh) continue;
      const part = webgpuPart('impostor', `vegetation '${name}' impostor`);
      I.bake ??= part.bake(this.engine.renderer, I.src, I.opts);
      if (!I.mesh || I.mesh.geometry.userData.capacity < n) this._cardMesh(I, part, Math.max(64, 2 ** Math.ceil(Math.log2(n || 1))), sp);
      const g = I.mesh.geometry, C = g.attributes.aCenter.array, S = g.attributes.aShape.array, T = g.attributes.aTint.array, CH = this.v.host.chunkSize;
      let j = 0;
      for (const [c, im] of far) {
        const a = im.instanceMatrix.array, col = im.instanceColor?.array;
        for (let i = 0; i < im.count; i++, j++) {
          const o = i * 16;
          // yaw-and-scale matrices (placement turns plants about Y and stretches them up): yaw from column 2, across scale from column 0, up from column 1
          C[j * 3] = c.cx * CH + a[o + 12]; C[j * 3 + 1] = a[o + 13]; C[j * 3 + 2] = c.cz * CH + a[o + 14];
          S[j * 3] = Math.atan2(a[o + 8], a[o + 10]); S[j * 3 + 1] = Math.hypot(a[o], a[o + 2]); S[j * 3 + 2] = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
          if (col) { T[j * 3] = col[i * 3]; T[j * 3 + 1] = col[i * 3 + 1]; T[j * 3 + 2] = col[i * 3 + 2]; } else T.fill(1, j * 3, j * 3 + 3);
        }
      }
      g.instanceCount = n;
      for (const at of [g.attributes.aCenter, g.attributes.aShape, g.attributes.aTint]) at.needsUpdate = true;
      I.mesh.visible = n > 0;
    }
  }
  _cardMesh(I, part, capacity, sp) {
    const old = I.mesh, q = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), g = new THREE.InstancedBufferGeometry();
    g.index = q.index; for (const a of ['position', 'normal', 'uv']) g.setAttribute(a, q.attributes[a]);
    for (const a of ['aCenter', 'aShape', 'aTint']) g.setAttribute(a, new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.userData.capacity = capacity;
    const m = new THREE.Mesh(g, old?.material ?? part.cardMaterial(I.src, I.bake));
    // cards span every far chunk, so no per-chunk culling (two triangles a plant); no shadow (a flat card's shadow would turn with the camera)
    m.frustumCulled = false; m.castShadow = false; m.receiveShadow = sp.receiveShadow; m.matrixAutoUpdate = false;
    m.userData.budgetTag = 'vegetation';
    // one 1 m quad at the origin outside the shader (positionNode places every card): a scene copy such as the path tracer leaves it out and says so
    drawOnly('far plants drawn as impostor cards (left out: they are placed in the shader, so the traced photo has no far plants)', m);
    if (old) { old.removeFromParent(); old.geometry.dispose(); }
    this.engine.scene.add(engineOwned('vegetation', m));
    I.mesh = m;
  }
  _neutral(o) {
    const m = neutralMaterial('vegetation', { vertexColors: true, side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    m.color = this._base.color;
    return m;
  }

  /** @internal view hook: c.plants[name] was placed, replaced, thinned or dropped, or which of its instances are felled changed */
  change(c, name) {
    const r = c.plants?.[name], rec = this.meshes.get(c), old = rec?.ims[name];
    const I = this.kinds.get(name)?.impostor;
    if (I) I.dirty = true;   // placed, felled or gone: the far cards copy it next frame
    if (!r) { if (old) { rec.group.remove(old); old.dispose(); delete rec.ims[name]; } return; }
    const k = this.kinds.get(name), sp = this.v.get(name);
    if (!k || !sp) return;
    const t0 = performance.now();   // measure: the 'build' stage of engine.budget.cost (mesh, matrices, culling sphere)
    let im = old;
    if (!old || old.userData.plants !== r || old.userData.base !== k.material) {   // new placement (or species defined again): a new mesh
      im = new THREE.InstancedMesh(k.geometry, k.material, r.n);
      im.instanceColor = new THREE.InstancedBufferAttribute(r.c, 3);
      im.matrixAutoUpdate = false;   // frustum culled by three against every camera: cullSphere() below
      im.receiveShadow = sp.receiveShadow;
      im.userData.plants = r; im.userData.species = name; im.userData.cx = c.cx; im.userData.cz = c.cz;  im.userData.base = k.material; im.userData.budgetTag = 'vegetation';   // cx, cz: plantOf reads them
      const R = rec ?? this._chunk(c);
      if (old) { R.group.remove(old); old.dispose(); }
      R.group.add(im); im.updateMatrixWorld(true);
      R.ims[name] = im;
    }
    // felled instances draw at zero scale where they stood (count unchanged, so the other instances keep their slots). Translation and w = 1 stay:
    // an all-zero matrix made three's bounding sphere NaN, and every ray and frustum test then missed the whole chunk
    const a = im.instanceMatrix.array, hid = c.hidden?.[name];
    a.set(r.m);
    if (hid) for (const i of hid) if (i < r.n) a.fill(0, i * 16, i * 16 + 12);
    im.instanceMatrix.needsUpdate = true;
    im.count = drawnPlants(sp.rule, r, this.v.host.density);
    cullSphere(im, k);
    this.engine.budget.cost.end('build', t0);
    if (c.ring != null) this._level(im, sp, k, c.ring);
  }

  /** @internal view hook: the chunk's ring changed (or shadows were switched): draw distance, low-poly swap and shadows of every species there */
  ring(c, ring) {
    const rec = this.meshes.get(c); if (!rec) return;
    this._cardsDirty(rec);
    for (const n in rec.ims) { const sp = this.v.get(n), k = this.kinds.get(n); if (sp && k) this._level(rec.ims[n], sp, k, ring); }
  }
  /** @internal view hook: the chunk was released */
  drop(c) {
    const rec = this.meshes.get(c); if (!rec) return;
    this.meshes.delete(c); this._cardsDirty(rec);
    for (const n in rec.ims) rec.ims[n].dispose();
    this.engine.scene.remove(rec.group);
  }

  /** @internal module frame hook: the fade band is centred on the view focus (the player in a follow camera) */
  updateFade() {
    const f = this.engine.focus;
    for (const k of this.kinds.values()) k.fadeUniforms?.uNearFadeCenter.value.copy(f);
  }

  _cardsDirty(rec) { for (const n in rec.ims) { const I = this.kinds.get(n)?.impostor; if (I) I.dirty = true; } }

  _level(im, sp, k, ring) {
    // an impostor species beyond lodRing is drawn by its far cards (updateCards), so its chunk mesh hides there, shadow included
    im.visible = ring <= sp.maxRing && !(k.impostor && ring > sp.lodRing);
    const low = k.lodGeometry && ring > sp.lodRing;
    im.geometry = low ? k.lodGeometry : k.geometry;
    im.material = low && k.lodMaterial ? k.lodMaterial : k.material;
    im.castShadow = !!this.engine.renderer?.shadowMap?.enabled && sp.castShadow && ring <= sp.shadowRing;
  }
  _chunk(c) {
    const CH = this.v.host.chunkSize, g = new THREE.Group();
    g.userData.budgetTag = 'vegetation';
    g.position.set(c.cx * CH, 0, c.cz * CH); g.matrixAutoUpdate = false; g.updateMatrix();
    this.engine.scene.add(engineOwned('vegetation', g)); g.updateMatrixWorld(true);
    const rec = { group: g, ims: {} };
    this.meshes.set(c, rec);
    return rec;
  }

  dispose() {
    this._view.remove(); this._swap.remove();
    for (const k of this.kinds.values()) { for (const d of k.made) d.dispose(); this._dropCards(k); }
    this.kinds.clear(); this._base.dispose();
  }
}
