// Automatic batching, engine.batching: the same static model placed many times is drawn as one THREE.InstancedMesh per (cell, geometry, material),
// with no work from the game. It batches only what the engine itself places through its content paths: world record views (props, templates, grid
// items, world.present), stream builds and level files (the thing registry owners 'world' / 'stream' / 'level', see CONTENT below).
//   A game's own objects (scene.add(mesh), engine.add(mesh), engine.rigid.add(mesh)) are never touched by default: three.js must stay directly
//   writable without surprises (your own Raycaster, scene walks, material swaps see exactly the meshes you made). Opt in per object with
//   obj.userData.batch = true on the root you add to the scene. Dev: when many identical game meshes draw one by one, stats.hint (describe().perf.batching)
//   and one console line say so with that opt-in.
//   Rule: once at least minCount meshes with the same geometry, material and shadow flags sit in one cell (cell meters, default four engine.stream cells),
//   they become instances of one InstancedMesh; below that they stay plain meshes. A batch dissolves when it drops under half of minCount.
//   The placed object stays in the scene as it was (its userData, record, colliders, interactions are untouched): only its meshes are hidden and marked
//   moved to layer 31 (BATCH_LAYER: not drawn, not in shadows; visible stays the game's). engine.raycast / pick / photo still hit the original and
//   return it, never an instance index (engine.rays tests layer 31 too). Your own THREE.Raycaster: batching.item(hit.object, hit.instanceId).
//   Moving / hiding / removing the object updates its instance next frame (checked each frame on the object's own transform); recolor with tint().
//   Ownership with BundleGroup: a mesh under a three BundleGroup is the bundle's. Batching leaves it alone, so each mesh has one owner; userData.batch = true on such a root warns once.
//   Never batched: skinned / instanced / morphing meshes, objects with animations, multi-material, transparent, ShaderMaterial, custom renderOrder /
//   layers / onBeforeRender, meshes with children, anything hlod registered (userData.hlod), and anything marked userData.batch = false (itself or a
//   parent; a world record says batch: false).
//   Safety net: a batched object whose meshes are changed afterwards (material swapped, shown, re-parented, a child part animated) goes back to plain meshes
//   and its geometry is not batched again (dev warns once: mark such models userData.batch = false).
//   Ownership with hlod: batching owns repeated things that are near enough to be built (props, views, stream entries); hlod owns the level geometry it was
//   given and swaps it for merged proxies far away. A mesh belongs to whichever took it first, so they never fight over visibility.
//   createEngine({ batching: false }) turns it off (nothing is watched, zero cost); engine.batching.enabled = false at runtime dissolves every batch.
/** @import { BatchingOptions, BatchingStats, BatchInfo } from '../../types/core' */
import * as THREE from 'three';
import { warnOnce, DEV, note, fmt } from '../base/validate.js';
import { BATCH_LAYER, build, join, leave, dissolve, color, localTint, bounds, snap, same, stored, inBundle } from './batchGroups.js';
import { isUnder, isShown } from '../base/util.js';
import { codedError } from '../base/errorHints.js';
import { notePatch, patchOn } from '../scene/threePatches.js';
import { engineOwned } from '../scene/things.js';

const OPTS = ['minCount', 'cell'];
// Thing-registry owners whose roots are engine-placed content (things.js add). Engine modules' own helpers ('engine:grid' tiles, 'engine:rigid'
// bodies...) are left out on purpose: a rigid body is the game's mesh handed to an engine verb, and the game must still find it as it made it.
const CONTENT = new Set(['world', 'stream', 'level']);
// Round-robin visits in a row that found an unbatched root moved: it is moving, not placed, and stops being a batch candidate until it rests
const MOVING = 3;
// Default batch cell, in stream cells. Why wider than one stream cell: a root lands in one batch cell, so a cell no wider than a streamed block batches nothing across
// blocks. A model used a few times per block (six facades over 16 buildings) never reached minCount and every copy drew alone. Measured on the city run: 64 m 18.9 ms a frame,
// 256 m 9.9 ms. The price is coarser culling, about 13-25% more triangles drawn there; a game with heavy props and little CPU load can set a smaller cell.
const CELL_SPAN = 4;
const VERIFY_MESHES = 256;   // meshes the round robin looks at per frame; one root is always finished, so a single huge root goes over once per lap
const PATCH = 'batching-draw-walk';
notePatch(PATCH, "children of a parent holding batched meshes: those meshes are out of the array during the engine's own draw, back right after (core/stream/Batching.js)", () => {},
  { scope: 'objects in the scene', lost: 'three walks every batched original twice a frame again; a district of blocks pays about a third of its frame for meshes that do not draw' });
const STRINGS = {
  evicted: '[batching] a batched copy of "{name}" changed after batching ({why}); it is drawn on its own from now on. Mark models that animate parts or swap materials with batch: false on the record (userData.batch = false on the object)',
  opts: 'createEngine({ batching }) takes false or { minCount, cell }; unknown key "{key}"',
  // Batching is silent by design, but it moves the engine's content meshes to layer 31 and draws an InstancedMesh instead: code that walks the scene
  // or uses its own THREE.Raycaster sees that and is surprised. So the first batch says so once (dev only) and describe().batching keeps the same line.
  note: 'repeated static meshes the engine placed (world records, stream builds, level files) are drawn as InstancedMesh batches (originals stay in the ' +
    'scene on layer 31; your own scene.add meshes only with userData.batch = true). Your own THREE.Raycaster: engine.batching.item(hit.object, hit.instanceId); ' +
    'keep a model as plain meshes: batch: false on its record (userData.batch = false on the object); off: createEngine({ batching: false })',
  bundled: '[batching] userData.batch = true on "{name}" has no effect: it is a BundleGroup, which draws its own meshes. Keep one: a BundleGroup, or a plain Group with batching',
  // Game meshes are not batched by default (see the header); when that costs many draw calls the game should hear the one-line way in.
  hint: '{n} copies of "{name}" added by the game draw one by one (engine.batching only batches what the engine places). If they stay static, set ' +
    'obj.userData.batch = true on each before adding it to batch them as one InstancedMesh per cell',
};
const PROTO_BEFORE = THREE.Object3D.prototype.onBeforeRender;
const HIDDEN = (1 << BATCH_LAYER) >>> 0;   // three keeps layer masks unsigned

/** engine.batching: draws repeated static models as InstancedMesh batches (see the top of core/stream/Batching.js). */
export class Batching {
  /** @internal @param {any} engine @param {BatchingOptions | false} [opts] */
  constructor(engine, opts = {}) {
    for (const k of Object.keys(opts || {})) if (!OPTS.includes(k)) throw codedError('batching-option', fmt(STRINGS.opts, { key: k }));
    /** @internal */ this.engine = engine;
    /** Same model at least this many times in one cell becomes a batch (default 8) @type {number} @experimental */
    this.minCount = (opts && opts.minCount) || 8;
    /** @internal */ this._cell = (opts && opts.cell) || null;
    /** @internal key -> group */ this.groups = new Map();
    /** @internal root -> info */ this.roots = new Map();
    /** @internal roots with at least one batched mesh (checked every frame) */ this.live = new Set();
    /** @internal */ this.list = [];
    /** @internal */ this.cursor = 0;
    /** @internal roots added since the last update */ this.incoming = new Set();
    /** @internal mesh -> its original material while a local tint clone is on it (weak: a tinted mesh that left for good must not stay here) */ this.orig = new WeakMap();
    /** @internal mesh -> tint color */ this.tints = new WeakMap();
    /** @internal geometries evicted once (never batched again) */ this.banned = new WeakSet();
    /** @internal batch InstancedMesh -> group */ this.byMesh = new WeakMap();
    /** Geometries and materials a live batch draws (engine.remove does not dispose these) @type {Map<any, number>} @experimental */ this.held = new Map();
    /** Parent of every batch InstancedMesh (in the scene) @type {THREE.Group} */
    this.root = engineOwned('batching', new THREE.Group());   // the registry is up by now: unmarked, scene.add would adopt it as a game object
    this.root.name = 'batching'; this.root.matrixAutoUpdate = false; this.root.userData.batch = false;
    /** @internal dev: 'geometry.id|material.id' -> how many unbatched game meshes draw it (the opt-in hint) */ this.plain = new Map();
    /** @internal dev: game root -> the plain keys it counted (taken back when it leaves the scene) */ this.counted = new Map();
    /** @internal dev: the key the hint is about (null until some key reached minCount) */ this._hintKey = null; /** @internal the hint console line was printed */ this._hinted = false;
    /** @internal parent -> { parent, all, count, last, drawn }: parents whose batched children skip the draw walk */ this.skips = new Map();
    /** @internal parents with a join, leave or child change since skips was listed */ this.skipsStale = new Set();
    /** @internal the children are swapped right now */ this.skipping = false;
    /** @internal */ this._on = false;
    /** @internal */ this._add = ev => { if (ev.child !== this.root) this.incoming.add(ev.child); };
    /** @internal */ this._rem = ev => { this.incoming.delete(ev.child); this._untrack(ev.child); this._uncount(ev.child); };
    if (opts !== false) this.enabled = true;
  }

  /** Global switch: false dissolves every batch and stops watching; true starts again (scans what is already in the scene) @type {boolean} */
  get enabled() { return this._on; }
  set enabled(on) {
    if (on === this._on) return;
    const s = this.engine.scene;
    this._on = on;
    if (on) {
      s.addEventListener('childadded', this._add); s.addEventListener('childremoved', this._rem);
      for (const c of s.children) if (c !== this.root) this.incoming.add(c);
    } else {
      s.removeEventListener('childadded', this._add); s.removeEventListener('childremoved', this._rem);
      for (const r of [...this.roots.keys()]) this._untrack(r);
      this._listSkips();   // lets go of the parents
      this.incoming.clear(); this.root.removeFromParent();
      this.plain.clear(); this.counted.clear(); this._hintKey = null;   // switching on again recounts every root
    }
  }
  /** Cell edge in meters (default four engine.stream cells, 256 m) @type {number} */
  get cell() { return this._cell ?? this.engine.stream.cellSize * CELL_SPAN; }
  set cell(v) { this._cell = v; this._rescan(); }

  /** Every batch: { mesh: InstancedMesh, cell, count, items } (items[i] is the placed object drawn by instance i) @returns {BatchInfo[]} */
  get batches() {
    const out = [];
    for (const g of this.groups.values()) if (g.mesh) out.push({ mesh: g.mesh, cell: g.cell, count: g.items.length, items: g.items.map(e => e.info.root) });
    return out;
  }
  /** @internal the first batch of this engine: one dev console line naming the model and the ways out (STRINGS.note) */
  _notice(g) {
    if (this._told || !DEV) return;
    this._told = true;
    note(`batching: ${g.members.size} copies of "${g.geometry.name || g.material.name || 'a mesh'}": ${STRINGS.note}`);
  }
  /**
   * batches: InstancedMesh count, instances: meshes drawn through them, saved: draw calls saved per pass (instances - batches); note while anything
   * is batched; hint (dev) while many identical game meshes draw unbatched
   * @returns {BatchingStats}
   */
  get stats() {
    let batches = 0, instances = 0;
    for (const g of this.groups.values()) if (g.mesh) { batches++; instances += g.items.length; }
    const hint = this._hint();
    return { batches, instances, saved: instances - batches, ...(batches ? { note: STRINGS.note } : {}), ...(hint ? { hint } : {}) };
  }
  /** @internal dev: the opt-in line while the most repeated unbatched game mesh still has at least minCount copies in the scene */
  _hint() {
    const k = this._hintKey, n = k ? this.plain.get(k)?.n ?? 0 : 0;
    return n >= this.minCount ? fmt(STRINGS.hint, { n, name: this.plain.get(k).name }) : null;
  }
  /**
   * Where an object is drawn: [{ mesh, index }] for each of its meshes that is batched ([] when drawn on its own).
   * @param {THREE.Object3D} obj placed object (or one of its meshes)
   * @returns {{ mesh: THREE.InstancedMesh, index: number }[]}
   */
  of(obj) {
    const info = this._infoOf(obj), out = [];
    if (info) for (const e of info.entries) if (e.slot >= 0 && (obj === info.root || e.mesh === obj)) out.push({ mesh: e.group.mesh, index: e.slot });
    return out;
  }
  /**
   * The placed object drawn by instance `index` of a batch mesh (for a three.js Raycaster you run yourself; engine.raycast already returns the original).
   * @param {THREE.Object3D} mesh batch InstancedMesh
   * @param {number} index instanceId
   * @returns {THREE.Object3D | null}
   */
  item(mesh, index) { return this.byMesh.get(mesh)?.items[index]?.info.root ?? null; }
  /**
   * Recolor one placed object: its color is multiplied by `color` (instance color when batched, a cloned material otherwise); null restores it.
   * @param {THREE.Object3D} obj
   * @param {THREE.ColorRepresentation | null} c
   * @example engine.batching.tint(engine.world.view('crate_3'), 0xff8080)
   */
  tint(obj, c) {
    obj.traverse(m => {
      if (!m.isMesh) return;
      if (c == null) this.tints.delete(m); else this.tints.set(m, new THREE.Color(c));
      const e = this._entryOf(m);
      if (e && e.slot >= 0) color(this, e); else localTint(this, m);
    });
  }
  /** Re-check one object now (after you changed its parts by hand, or set userData.batch on a root already in the scene); normally automatic @param {THREE.Object3D} obj */
  refresh(obj) {
    // a part of a placed object: the object is what goes round again. Untracked (none of its meshes qualified, all hlod's, say): the scene child holding the part
    const info = this._infoOf(obj);
    let root = info?.root ?? obj;
    while (!info && root.parent && root.parent !== this.engine.scene) root = root.parent;
    if (info) this._untrack(root);
    this._uncount(root);
    if (root.parent === this.engine.scene) this.incoming.add(root);
  }

  /** @internal Called by the engine each frame after frame hooks / stream / jobs, before rendering */
  update() {
    if (!this._on) return;
    if (this.incoming.size) { for (const r of this.incoming) if (r.parent === this.engine.scene) this._track(r); this.incoming.clear(); }
    for (const info of this.live) this._check(info);
    // round robin: look for parts changed behind our back. Bounded in meshes, not roots: a streamed city block is one root with hundreds of meshes,
    // and 256 roots a frame checked every mesh of a district every frame (a quarter of the frame in the city stress run)
    const L = this.list;
    for (let seen = 0, left = VERIFY_MESHES; seen < L.length && left > 0; seen++) {
      if (this.cursor >= L.length) this.cursor = 0;
      const info = L[this.cursor++]; left -= info.entries.length; this._verify(info);
    }
    for (const g of this.groups.values()) if (g.dirty) { g.dirty = false; bounds(g); }
  }
  /**
   * @internal Called right before the frame's draw: batched originals leave their parent's children until unskip(), so three's two whole-scene walks
   * (updateMatrixWorld, the draw list) do not visit meshes that never draw. They cost more than the draws themselves in a district of blocks. Only this
   * window: game code, raycasts and scene.traverse always see the scene as it was built. Scene changes made during a render are lost here (three itself
   * walks these arrays then, so that was never safe). A root that is itself the batched mesh stays: it sits in the scene's own children.
   */
  skip() {
    if (!this._on || !patchOn(PATCH)) return;
    // three appends on add, so count and last child together see every add and remove, also a swap that keeps the count
    for (const s of this.skips.values()) { const c = s.parent.children; if (c.length !== s.count || c[c.length - 1] !== s.last) this.skipsStale.add(s.parent); }
    if (this.skipsStale.size) this._listSkips();
    for (const s of this.skips.values()) { s.all = s.parent.children; s.parent.children = s.drawn; }
    this.skipping = true;
  }
  /** @internal Right after the draw: every parent gets its real children back */
  unskip() {
    if (!this.skipping) return;
    this.skipping = false;
    for (const s of this.skips.values()) s.parent.children = s.all;
  }
  /** @internal A mesh joined or left a batch: its parent is listed again before the next draw. A root that is itself the mesh sits in the scene's children, which are never skipped */
  _skipChanged(e) { if (e.mesh !== e.info.root && e.mesh.parent) this.skipsStale.add(e.mesh.parent); }
  /**
   * @internal What is left of the changed parents' children without their batched meshes. Only those parents: listing every parent went through every batched mesh of the district
   * each time a block came or went. A child hung on a batched mesh still draws until the round robin evicts it, so a mesh with children is not skipped.
   */
  _listSkips() {
    for (const parent of this.skipsStale) {
      const drawn = parent.children.filter(c => !c.userData.batched || c.children.length);
      if (drawn.length === parent.children.length) this.skips.delete(parent);
      else this.skips.set(parent, { parent, all: null, count: parent.children.length, last: parent.children.at(-1), drawn });
    }
    this.skipsStale.clear();
  }
  /** @internal */
  dispose() { this.enabled = false; this.groups.clear(); }

  // ---------- tracking ----------
  /** @internal */
  _track(root) {
    if (this.roots.has(root)) return;
    // Engine content (CONTENT owners) or a game root that opted in; everything else stays exactly as the game made it
    const u = root.userData, owner = this.engine._things?.byObj.get(root)?.owner, mine = u.batch === true || CONTENT.has(owner);
    // the opt-in hint counts only the game's own roots: an engine module's helpers ('engine:grid' tiles, 'engine:rigid' bodies) are not the game's to mark
    if (!mine || u.batch === false || root.animations?.length) { this._plain(root, !mine && u.batch !== false && (owner == null || owner === 'game')); return; }
    if (u.batch === true && root.isBundleGroup) warnOnce(fmt(STRINGS.bundled, { name: root.name || 'a group' }));
    const meshes = [];
    let ok = true;
    root.updateMatrixWorld(true);   // _eligible reads the world matrix
    const walk = (o, top) => {
      if (!ok) return;
      if (o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh) { ok = false; return; }
      const u = o.userData;
      if (u.batched) { o.layers.set(0); delete u.batched; }   // a clone of a batched mesh: draw it again
      if (!top && (u.batch === false || !o.visible)) return;   // a hidden root is tracked anyway (it joins when shown)
      if (o.isMesh && this._eligible(o)) meshes.push(o);
      for (const c of o.children) walk(c, false);
    };
    walk(root, true);
    if (!ok || !meshes.length) return;
    const info = { root, entries: [], snap: [], cell: null, idx: this.list.length, moves: 0, moving: false };
    for (const mesh of meshes) info.entries.push({ mesh, info, group: null, slot: -1 });
    this.roots.set(root, info); this.list.push(info);
    snap(root, info.snap);
    if (root.visible) this._attach(info);
  }
  /** @internal */
  _eligible(m) {
    const mat = this.orig.get(m) ?? m.material;
    return !m.children.length && !Array.isArray(mat) && mat && !mat.transparent && !mat.isShaderMaterial && m.geometry?.attributes.position
      && !m.morphTargetInfluences && !Object.keys(m.geometry.morphAttributes).length && !m.userData.hlod && !this.banned.has(m.geometry)
      && m.renderOrder === 0 && m.layers.mask === 1 && m.frustumCulled && m.onBeforeRender === PROTO_BEFORE && !inBundle(m)
      && m.matrixWorld.determinant() >= 0;   // mirrored: three picks the winding from the object's matrix, and a batch's is identity, so it would draw inside out
  }
  /** @internal */
  _untrack(root) {
    const info = this.roots.get(root); if (!info) return;
    this._detach(info);
    this.roots.delete(root);
    const last = this.list.pop(); if (last !== info) { this.list[info.idx] = last; last.idx = info.idx; }
  }
  /**
   * @internal A root batching leaves alone. A clone of a batched mesh still carries layer 31 (clone copies layers): draw it again. count (dev):
   * remember its eligible meshes for the opt-in hint; walking a game root once when it is added is the whole cost, and only in dev.
   */
  _plain(root, count) {
    const keys = count && DEV ? [] : null;
    root.traverse(o => {
      const u = o.userData;
      if (u.batched) { o.layers.set(0); delete u.batched; }
      if (keys && o.isMesh && u.batch !== false && this._eligible(o)) keys.push([`${o.geometry.id}|${o.material.id}`, o.geometry.name || o.name || root.name || 'a mesh']);
    });
    if (!keys?.length || this.counted.has(root)) return;
    this.counted.set(root, keys.map(k => k[0]));
    for (const [k, name] of keys) {
      let c = this.plain.get(k);
      if (!c) this.plain.set(k, c = { n: 0, name });
      // the hint names the most repeated one
      if (++c.n >= this.minCount && c.n > (this.plain.get(this._hintKey)?.n ?? 0)) this._hintKey = k;
    }
    if (this._hintKey && !this._hinted) { this._hinted = true; note(`batching: ${this._hint()}`); }   // the console line once per engine
  }
  /** @internal a game root left the scene: its meshes no longer count toward the hint */
  _uncount(root) {
    const keys = this.counted.get(root); if (!keys) return;
    this.counted.delete(root);
    for (const k of keys) { const c = this.plain.get(k); if (c && --c.n <= 0) this.plain.delete(k); }
    // the named key dropped: name the most repeated one still at minCount (the hint used to vanish though another key qualified)
    if (this._hintKey && keys.includes(this._hintKey)) {
      let best = null, n = this.minCount - 1;
      for (const [k, c] of this.plain) if (c.n > n) { best = k; n = c.n; }
      this._hintKey = best;
    }
  }
  /** @internal */
  _infoOf(obj) { for (let o = obj; o; o = o.parent) { const i = this.roots.get(o); if (i) return i; } return null; }
  /** @internal */
  _entryOf(m) { return this._infoOf(m)?.entries.find(e => e.mesh === m) ?? null; }
  /** @internal */
  _rescan() { if (!this._on) return; this.enabled = false; this.enabled = true; }

  /** @internal put a root's meshes into the groups of its cell */
  _attach(info) {
    const p = info.root.position, cs = this.cell;
    info.cell = Math.floor(p.x / cs) + ',' + Math.floor(p.z / cs);
    info.root.updateMatrixWorld(true);
    for (const e of info.entries) {
      const m = e.mesh, mat = this.orig.get(m) ?? m.material;
      const key = `${info.cell}|${m.geometry.id}|${mat.id}|${+m.castShadow}${+m.receiveShadow}`;
      let g = this.groups.get(key);
      if (!g) this.groups.set(key, g = { key, cell: info.cell, geometry: m.geometry, material: mat, cast: m.castShadow, receive: m.receiveShadow, members: new Set(), items: [], mesh: null, dirty: false, colored: false });
      e.group = g; g.members.add(e);
      if (g.mesh) join(this, e);
      else if (g.members.size >= this.minCount) { build(this, g); this._notice(g); }
    }
  }
  /** @internal take a root's meshes out of their groups (they draw on their own again) */
  _detach(info) {
    for (const e of info.entries) {
      const g = e.group; if (!g) continue;
      e.group = null; g.members.delete(e);
      if (e.slot >= 0) leave(this, g, e);
      if (g.mesh && g.members.size < Math.ceil(this.minCount / 2)) dissolve(this, g);
      if (!g.members.size) this.groups.delete(g.key);
    }
    this.live.delete(info);
  }

  // ---------- per-frame checks ----------
  /** @internal the object's own transform / visibility changed: move its instances (or regroup when it changed cell) */
  _check(info) {
    const r = info.root;
    if (same(r, info.snap)) return;
    snap(r, info.snap);
    if (!r.visible) { this._detach(info); return; }
    const cs = this.cell, cell = Math.floor(r.position.x / cs) + ',' + Math.floor(r.position.z / cs);
    if (cell !== info.cell) { this._detach(info); this._rejoin(info); return; }   // the same judgment as any rejoin: a root that is mirrored as it crosses a cell must not upload
    r.updateMatrixWorld(true);
    // mirrored now (a scale went negative): _eligible refuses that at tracking, so a live root that turns that way leaves its batch (only itself), not uploaded
    if (info.entries.some(e => e.slot >= 0 && e.mesh.matrixWorld.determinant() < 0)) { this._release(info, 'mirrored'); return; }
    for (const e of info.entries) if (e.slot >= 0) { e.group.mesh.setMatrixAt(e.slot, e.mesh.matrixWorld); e.group.mesh.instanceMatrix.needsUpdate = true; e.group.dirty = true; }
  }
  /** @internal slow round robin: hidden roots coming back, pending roots that moved cell, batched parts changed behind our back */
  _verify(info) {
    const r = info.root;
    // A part (or a group above it inside the root) hid itself: same as a hidden root, the model left its batch and rejoins once everything shows again
    if (info.hidden) {
      if (!info.entries.every(e => isShown(e.mesh))) return;
      // what changed while it was out (a transparent material, a child) is judged as at first tracking: _eligible, else the usual eviction
      if (!info.entries.every(e => this._eligible(e.mesh))) { this._release(info, 'changed while hidden'); return; }
      info.hidden = false; snap(r, info.snap); if (r.visible) this._rejoin(info); return;
    }
    if (!this.live.has(info)) {   // not batched: only keep its cell right (so counting stays honest)
      // A root that moves on every visit (a floating pickup, a patrolling prop) is not static: regrouping it each visit cost a detach / attach
      // (and a batch build / dissolve at the minCount edge) forever. After MOVING visits in a row it leaves its group; it rejoins once a visit finds it still
      if (same(r, info.snap)) { info.moves = 0; if (info.moving) { info.moving = false; if (r.visible) this._rejoin(info); } return; }
      snap(r, info.snap);
      if (info.moving) return;
      this._detach(info);
      if (++info.moves >= MOVING) { info.moving = true; return; }
      if (r.visible) this._rejoin(info);
      return;
    }
    for (const e of info.entries) {
      if (e.slot < 0) continue;
      const m = e.mesh, g = e.group;
      if (m.layers.mask === HIDDEN && !isShown(m)) { this._detach(info); info.hidden = true; return; }   // hidden is not a change of the model: no eviction, no ban
      let why = m.layers.mask !== HIDDEN ? 'layers' : m.material !== g.material ? 'material' : m.geometry !== g.geometry ? 'geometry' : m.children.length ? 'children'
        : m.castShadow !== g.cast || m.receiveShadow !== g.receive ? 'shadow flags' : !isUnder(m, r) ? 're-parented' : '';
      if (!why) {
        m.updateWorldMatrix(true, false);
        if (!stored(g.mesh.instanceMatrix.array, e.slot, m.matrixWorld) && same(r, info.snap)) why = 'a part moved';
      }
      if (why) { this._evict(info, why); return; }
    }
  }
  /** @internal a root coming back to a batch (shown again, stopped moving, back in a cell) is judged as at first tracking: _eligible, else the usual eviction */
  _rejoin(info) {
    info.root.updateMatrixWorld(true);
    if (info.entries.every(e => this._eligible(e.mesh))) this._attach(info); else this._release(info, 'changed while out of its batch');
  }
  /** @internal only this root is ineligible (mirrored, a material swapped while it was out): it draws on its own and its geometry is not banned, other copies keep batching */
  _release(info, why) {
    warnOnce(fmt(STRINGS.evicted, { name: info.root.name || info.entries[0].mesh.name || 'model', why }));
    this._untrack(info.root);
  }
  /** @internal a batched part changed behind our back: the geometry is banned too, nothing can tell which copies would do it again */
  _evict(info, why) {
    warnOnce(fmt(STRINGS.evicted, { name: info.root.name || info.entries[0].mesh.name || 'model', why }));
    for (const e of info.entries) this.banned.add(e.mesh.geometry);
    this._untrack(info.root);
  }
}
