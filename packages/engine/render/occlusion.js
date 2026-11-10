// Occlusion culling for the engine's own big things (hlod cells, engine.batching's instanced groups), on both renderers. Off by default: it pays only when what hides is heavy;
// on a scene of many small objects the queries cost more CPU than the draws they save.
// three reports occlusion and leaves the rest to the caller, so this file is that rest: one cheap box per item drawn after the opaque objects, colorless and writing no depth,
// whose query says whether any of it was seen. WebGPURenderer: object.occlusionTest + renderer.isOccluded (readable only during the render, hence onBeforeRender). WebGLRenderer has no such
// property, so the box wraps its draw in a WebGL2 query.
// Results arrive frames late, so nothing may wait for them to appear:
//   - the box grows by the distance the camera covers in that delay, so it peeks out before the object does;
//   - a box that was not drawn (off screen) or a camera that outran the box's growth or was swapped means "show it": the frustum still culls it for free;
//   - answers asked before such a moment say nothing about the view after it, so they are thrown away, also those still on their way (DELAY frames);
//   - hiding takes HIDE_AFTER results in a row, showing takes one.
// A query measures one camera, so hiding holds for that camera alone. No layer mask can say so: three shows an object when any bit is shared, and a mesh hidden from the view camera
// would need every other camera (a minimap, a mirror, a probe, shadows, voxelGI's volume) to hold a bit the game never gave it. Both renderers ask object.layers.test(camera.layers), so a hidden
// mesh's Layers gets its own test that says no to the view camera's layers object and is three's test for any other. visible and the mask stay the game's; a Raycaster passes as any other camera.
// The boxes are for the scene render alone: any other render of the same camera would draw them through its override material. The chains see to it: WebGL takes the layer off the camera
// once the scene is drawn (_sceneDrawn), every display.pass on WebGPU renders without it.
import * as THREE from 'three';
import { isWebGPU, onRendererSwap } from './backend.js';
import { codedError } from '../core/base/errorHints.js';
import { engineOwned } from '../core/scene/things.js';
import { notePatch } from '../core/scene/threePatches.js';
import { RESERVED_LAYERS } from './layers.js';

notePatch('occlusion-layers-test', "layers.test on the Layers of a mesh occlusion culling hides (own property, gone when it shows): false for engine.camera's layers, three's test for any other camera", null,
  { scope: 'objects in the scene', lost: 'cannot be switched off alone: engine.occlusion.enabled = false takes it off every mesh' });

const { occlusionHidden: HIDDEN_LAYER, occlusionBox: BOX_LAYER } = RESERVED_LAYERS;
const HIDE_AFTER = 2;
const DELAY = 3;                  // frames between a box being drawn and its result being read, at worst
const LIGHT_WALK = 60;            // frames between looks for a game's new shadow lights; the engine's own say so (shadowLightsAdded)

/** The mask bit of the batch layer, where a far original waits (hlod, assets.lod); three keeps layer masks unsigned */
export const FAR_BIT = (1 << RESERVED_LAYERS.batched) >>> 0;
/** For the raycast slot of an object rays must pass through: a batch, a proxy, an occlusion box */
export const noRaycast = () => {};

/**
 * The mask a mesh goes back to after the engine hid it on one layer. A game's write while hidden stands (hard rule 4): layers.set took the hidden layer
 * away, so the mask is the game's; layers.enable added to it, so the game's bit joins what was there before.
 * @param {number} now the mask now @param {number} bit the hiding layer's bit @param {number} before the mask before hiding @returns {number}
 */
export function unhideMask(now, bit, before) {
  if (now === bit) return before;
  return now & bit ? ((now & ~bit) | before) >>> 0 : now;
}

const quiet = new WeakSet();
/** three starts this readback without keeping its promise, so a renderer disposed while one is on its way rejects with nobody to catch it, and the page reports an error for a game that did nothing wrong */
function quietReadback(renderer) {
  const b = renderer.backend;
  if (!b?.isWebGPUBackend || quiet.has(b)) return;
  quiet.add(b);
  notePatch('occlusion-readback', 'resolveOccludedAsync of the WebGPU backend, that one instance, once engine.occlusion is on: an AbortError from a buffer destroyed with the renderer is dropped', null,
    { scope: 'the renderer in use', lost: 'disposing an engine while occlusion answers are on their way reports an unhandled rejection' });
  const read = b.resolveOccludedAsync;
  b.resolveOccludedAsync = function (c) { return read.call(this, c).catch(err => { if (err?.name !== 'AbortError') throw err; }); };
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const size = new THREE.Vector3(), center = new THREE.Vector3(), here = new THREE.Vector3(), grown = new THREE.Box3();
const trianglesOf = m => (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3 * (m.isInstancedMesh ? m.count : 1);

export class Occlusion {
  /** @param {any} engine @internal */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** @internal */ this._on = false;
    /** @internal */ this._items = new Set();
    /** @internal */ this._frameNo = 0;
    /** @internal */ this._last = /** @type {THREE.Vector3 | null} */ (null);
    /** @internal the camera of the last frame */ this._cam = null;
    /** @internal */ this._root = null;
    /** @internal */ this._hook = null;
    /** @internal the layer bits this added to each shadow camera, taken back when culling goes off */ this._shadowBits = new Map();
    /** @internal walk the shadow lights in frames up to this one (shadowLightsAdded) */ this._walkUntil = 0;
    const test = THREE.Layers.prototype.test;
    /** @internal layers.test of a hidden mesh; `this` is its Layers @this {THREE.Layers} @param {THREE.Layers} layers */ this._unseen = function (layers) { return layers !== engine.camera.layers && test.call(this, layers); };
    // a restored context holds none of the old queries: one still pending would never answer and its item would stay hidden. Each item starts over and shows until new answers say otherwise
    /** @internal */ this._restored = engine.events.on('page:contextrestored', () => { for (const it of this._items) { it.query = null; it.pending = it.open = false; it.runs = 0; } });
    // fallback 'webgl' replaces the renderer inside start(), and each renderer needs its own query hook on the box
    /** @internal */ this._swap = onRendererSwap(engine, () => { if (this._on) for (const it of this._items) { this._unbox(it); this._box(it); } });
  }
  /** Occlusion culling of hlod cells and batched groups; describe().render.occlusion says what it saved @returns {boolean} */
  get enabled() { return this._on; }
  set enabled(v) {
    if (typeof v !== 'boolean') throw codedError('engine-misuse', `engine.occlusion.enabled is true or false, got ${JSON.stringify(v)}`);
    if (v === this._on) return;
    this._on = v;
    const cam = this.engine.camera;
    if (v) {
      this._root ??= engineOwned('occlusion', Object.assign(new THREE.Group(), { name: 'occlusion boxes' }));
      this.engine.scene.add(this._root);
      this._material ??= new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
      for (const it of this._items) this._box(it);
      this._hook = this.engine.onRender(() => this._frame());
    } else {
      this._hook?.remove(); this._hook = null;
      for (const it of this._items) this._unbox(it);
      this._root?.removeFromParent();
      cam.layers.disable(BOX_LAYER);
      for (const [c, bits] of this._shadowBits) c.layers.mask &= ~bits;
      this._shadowBits.clear();
      this._last = null;
    }
  }
  /** What it does now: { watched, hidden, trianglesSkipped } (items, items hidden this frame, triangles not drawn this frame) */
  get stats() {
    let hidden = 0, trianglesSkipped = 0;
    for (const it of this._items) if (it.hidden) { hidden++; for (const m of it.meshes) if (m.visible) trianglesSkipped += trianglesOf(m); }
    return { watched: this._items.size, hidden, trianglesSkipped: Math.round(trianglesSkipped) };
  }
  /**
   * For the engine's own big things only (a game's ordinary objects are not worth a query each). Watch meshes as one item. box: the world box around them, or a function giving it when it changes (default: read once from the meshes, when culling first needs it: while off, watching costs nothing).
   * @param {any[]} meshes @param {THREE.Box3 | (() => THREE.Box3)} [box] @returns {{ remove(): void }} @internal
   */
  watch(meshes, box) {
    const read = typeof box === 'function' ? box : null;
    const it = { meshes, read, box: read ? null : box ?? null, hidden: false, runs: 0, drawn: -1, wait: 0, pad: 0, proxy: null, query: null, pending: false, open: false };
    this._items.add(it);
    if (this._on) this._box(it);
    return { remove: () => { this._unbox(it); this._items.delete(it); } };
  }
  /**
   * The engine made shadow lights (cascades built or rebuilt on a settings or tier change): look at the shadow cameras in the next two frames, not at the next timed walk.
   * Why: a fresh light's camera lacks the hidden layer, so what culling hides vanished from its shadow for up to LIGHT_WALK frames (~1 s). Two frames: WebGPU's cascade
   * node makes its lights in its first render, after this frame's look. A game's own lights stay on the timed walk (a scene walk each frame would cost every game) @internal
   */
  shadowLightsAdded() { this._walkUntil = this._frameNo + 2; }
  /** The item's box mesh, its query hooks on the renderer in use */
  _box(it) {
    if (!it.read) it.box ??= it.meshes.reduce((b, m) => b.expandByObject(m), new THREE.Box3());
    const p = it.proxy = new THREE.Mesh(unitBox, this._material);
    p.name = 'occlusion box'; p.layers.set(BOX_LAYER); p.renderOrder = Number.MAX_SAFE_INTEGER; p.matrixAutoUpdate = false; p.raycast = noRaycast;
    p.userData.batch = false;
    if (isWebGPU(this.engine.renderer)) {
      quietReadback(this.engine.renderer);
      p.occlusionTest = true;
      p.onBeforeRender = (r, s, camera) => {
        if (camera !== this.engine.camera) return;
        it.drawn = this._frameNo;
        it.runs = r.isOccluded(p) ? it.runs + 1 : 0;
      };
    } else {
      p.onBeforeRender = (r, s, camera) => {
        if (camera !== this.engine.camera) return;
        it.drawn = this._frameNo;
        if (it.pending) return;
        const gl = r.getContext();
        it.query ??= gl.createQuery();
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, it.query);
        it.open = true;
      };
      p.onAfterRender = r => {
        if (!it.open) return;
        const gl = r.getContext();
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        it.open = false; it.pending = true;
      };
    }
    this._root.add(p);
  }
  /** Back to plain meshes: shown, no box, no query */
  _unbox(it) {
    this._show(it);
    it.proxy?.removeFromParent(); it.proxy = null;
    this._dropQuery(it);
    it.runs = 0; it.drawn = -1;
  }
  _dropQuery(it) {
    if (!it.query) return;
    this.engine.renderer.getContext().deleteQuery(it.query);
    it.query = null; it.pending = false; it.open = false;
  }
  /** WebGL: take the query's answer if it has arrived */
  _read(it) {
    if (!it.pending) return;
    const gl = this.engine.renderer.getContext();
    if (!gl.getQueryParameter(it.query, gl.QUERY_RESULT_AVAILABLE)) return;
    it.runs = gl.getQueryParameter(it.query, gl.QUERY_RESULT) ? 0 : it.runs + 1;
    it.pending = false;
  }
  _hide(it) {
    it.hidden = true;
    for (const m of it.meshes) m.layers.test = this._unseen;
  }
  _show(it) {
    if (!it.hidden) return;
    for (const m of it.meshes) delete m.layers.test;
    it.hidden = false;
  }
  /**
   * Shadow cameras see what the view camera sees, the boxes apart, plus HIDDEN_LAYER, which nothing sits on: a shadow camera with layer 0 alone is read through the view camera's layers
   * by both renderers, and then the boxes would cast and WebGL would drop what is hidden. A cascade's own lights hang off its shadow node, not the scene
   */
  _shadowCameras(cam) {
    const want = (cam.layers.mask & ~(1 << BOX_LAYER)) | (1 << HIDDEN_LAYER);
    // OR, never a plain write: a shadow camera can hold layers of its own (a first-person body on the camera's hide layer). Only what was added is noted, so off takes back no more
    const add = l => {
      const c = l.shadow?.camera, bits = c ? want & ~c.layers.mask : 0;
      if (bits) { c.layers.mask |= bits; this._shadowBits.set(c, (this._shadowBits.get(c) ?? 0) | bits); }
    };
    this.engine.scene.traverse(o => { if (o.isLight && o.castShadow) { add(o); o.shadow?.shadowNode?.lights?.forEach(add); } });
  }
  /** The WebGL chain, right after its scene render: the passes after it may render this camera again (outline's views, GTAO's normals, a game's Pass); _frame puts the layer back @internal */
  _sceneDrawn() { if (this._on) this.engine.camera.layers.disable(BOX_LAYER); }
  /** Once a frame, before the render: read what the last frames saw, decide who is drawn, place the boxes @internal */
  _frame() {
    const cam = this.engine.camera, n = ++this._frameNo;
    cam.layers.enable(BOX_LAYER);
    cam.getWorldPosition(here);
    const moved = this._last && cam === this._cam ? here.distanceTo(this._last) : Infinity;
    (this._last ??= new THREE.Vector3()).copy(here); this._cam = cam;
    const gl = !isWebGPU(this.engine.renderer);
    let hidNow = false;
    for (const it of this._items) {
      if (gl) this._read(it);
      if (it.read) it.box = it.read();
      if (it.box.isEmpty()) { this._show(it); it.proxy.visible = false; continue; }
      it.proxy.visible = true;
      it.box.getCenter(center); it.box.getSize(size);
      const pad = Math.max(size.length() * 0.02, Number.isFinite(moved) ? moved * DELAY : 0);
      grown.copy(it.box).expandByScalar(pad);
      // standing on its ground (the camera over its x/z footprint, a batch's 256 m cell, an hlod cell): what is around the camera is drawn whatever stands in front, so its
      // box costs a draw call (filling the screen from inside) and a query that never hides it. Not tested at all: no box, no query, shown. Skipping a test only culls less
      const inside = grown.distanceToPoint(here) <= cam.near * 2 || (here.x >= grown.min.x && here.x <= grown.max.x && here.z >= grown.min.z && here.z <= grown.max.z);
      if (inside) { this._show(it); it.proxy.visible = false; it.runs = 0; it.pad = pad; continue; }
      const seenLast = n - it.drawn <= 1;
      // an answer covers a camera move as far as the growth its box had when asked; a cut beyond that is a different view, however big the item is
      if (moved * DELAY > it.pad) it.wait = n + DELAY;
      it.pad = pad;
      if (n <= it.wait || !seenLast) it.runs = 0;
      const hide = seenLast && it.runs >= HIDE_AFTER;
      if (hide && !it.hidden) { this._hide(it); hidNow = true; } else if (!hide) this._show(it);
      grown.getSize(size);
      it.proxy.matrix.makeScale(size.x, size.y, size.z).setPosition(center);
      it.proxy.matrixWorldNeedsUpdate = true;
    }
    if (hidNow || n <= this._walkUntil || n % LIGHT_WALK === 0) this._shadowCameras(cam);
  }
  /** @internal */
  dispose() { this.enabled = false; this._swap.remove(); this._restored.remove(); this._items.clear(); this._material?.dispose(); }
}
