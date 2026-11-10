// Kept shadows on WebGPURenderer: what stays still is drawn into a second depth map once; each shadow frame copies that map into the light's own shadow map and draws
// only the rest on top (engine.shadows.cache, render/shadows.js). Loaded only through threedog/tsl (render/fx/index.js).
// Why copy then draw and not a second lookup in the shader: the light's map holds the whole answer again, so no material, filter or custom shadow node changes.
// Why one filter on the shadow draw and a kept set: only what the static pass really drew may be skipped later. A static object that came after that pass (a streamed
// block), or was outside the box then, still draws with the moving things, so it casts a shadow without any redraw. An InstancedMesh is kept with its instance version: batching
// moves, adds and drops instances and replaces whole batches on its own, so a changed geometry or shadow flag, or a mesh hidden or gone from the scene, redraws the kept map with
// no call from the game; a changed instance version draws that mesh live and redraws the kept map at most once every REFILL_EVERY shadow frames.
// With renderer.shadowMap.transmitted the map's color (the tint a castShadowNode writes) is copied too: three reads it beside the depth.
// Why float depth: the depth24plus three picks cannot be a WebGPU copy source. The opted-in light's depth is more precise, nothing else changes.
// shortcut: one plain map only. Cascades build their own shadow nodes inside three's CSMShadowNode; upgrade if a game needs kept far cascades.
import { FloatType, Matrix4, ShadowNode } from 'three/webgpu';
import { registerWebGPUPart, rebuildShadow } from './backend.js';
import { notePatch } from '../core/scene/threePatches.js';
import { warnOnce } from '../core/base/validate.js';

// A kept InstancedMesh still draws what the kept map holds: same instances, same geometry, still casting, still shown in the scene. Why more than the
// instance version: vegetation rings swap a chunk's geometry, hide it past maxRing, stop its shadow past shadowRing, and drop a chunk by removing
// its group (the mesh keeps that parent), all without touching instances, so the kept map showed shadows of plants no longer there
const keptAs = m => ({ v: m.instanceMatrix.version, geo: m.geometry });
/** @param {any} m @param {{ v: number, geo: any }} k @param {boolean} [anyVersion] true: everything but the instances as kept */
function drawsAsKept(m, k, anyVersion = false) {
  if ((!anyVersion && m.instanceMatrix.version !== k.v) || m.geometry !== k.geo || !m.castShadow) return false;
  for (let o = m; o; o = o.parent) { if (!o.visible) return false; if (o.isScene) return true; }
  return false;   // no longer under a scene
}
// Shadow frames between two refills caused by instance writes alone. Why: while streaming, batching joins, drops or moves an instance almost every frame, and each
// write refilled the whole kept map (dearer than no cache). Meanwhile the changed mesh draws with the moving things, so a joined instance casts at once; an instance
// that left or moved leaves its old shadow in the kept map until the refill (at most this many shadow frames, ~0.13 s at 60). Geometry, shadow flag, hiding, a mesh
// gone from the scene and a moved light still refill at once
const REFILL_EVERY = 8;
const Base = /** @type {any} */ (ShadowNode);   // @types/three declares none of the methods a shadow node subclass overrides

class CachedShadowNode extends Base {
  /** @param {any} light @param {(object: any) => boolean} isStatic */
  constructor(light, isStatic) {
    super(light);
    this.isCachedShadowNode = true;
    this._isStatic = isStatic;   // underscore names: three walks a node's public fields looking for child nodes
    this._cache = null;
    this._kept = new WeakSet();
    this._instanced = new Map();   // the InstancedMeshes in the kept map -> how they were drawn then (keptAs)
    this._filling = false;   // true during the static pass
    this._stale = true;
    this._due = false;   // an instance write is waiting for its refill (REFILL_EVERY)
    this._since = 0;     // shadow frames since the last refill
    this._fills = 0;     // refills so far (tests read it)
    this._fresh = true;   // the light's map has no GPU texture yet, or a new size: the copy needs one
    this._matrix = new Matrix4();
    this._base = null; this._draw = null;
    light.shadow.shadowNode = this;
    rebuildShadow(light);
  }
  setupRenderTarget(shadow, builder) {
    const made = super.setupRenderTarget(shadow, builder);
    if (!builder.renderer.backend.isWebGPUBackend) return made;
    const cache = super.setupRenderTarget(shadow, builder);
    made.depthTexture.type = cache.depthTexture.type = FloatType;
    this._cache?.dispose();
    this._cache = cache.shadowMap;
    this._stale = this._fresh = true;
    return made;
  }
  getShadowRenderObjectFunction(renderer, shadow) {
    const base = super.getShadowRenderObjectFunction(renderer, shadow);
    if (!this._cache) return base;
    if (this._base !== base) {
      this._base = base;
      this._draw = (object, ...rest) => {
        if (this._filling) {
          if (!this._isStatic(object)) return;
          this._kept.add(object);
          if (object.isInstancedMesh) this._instanced.set(object, keptAs(object));
        } else if (this._kept.has(object)) return;
        base(object, ...rest);
      };
    }
    return this._draw;
  }
  renderShadow(frame) {
    const { shadow, shadowMap, light } = this, { renderer } = frame, cache = this._cache;
    if (!cache) {   // WebGL2 backend of WebGPURenderer: the depth copy is WebGPU only, so this light simply draws everything, as without the cache
      warnOnce('[threedog] engine.shadows.cache: this WebGPURenderer runs on its WebGL2 backend, which cannot copy a depth map; the light draws its full shadow every frame');
      super.renderShadow(frame);
      return;
    }
    const { x: width, y: height } = shadow.mapSize;
    if (shadowMap.width !== width || shadowMap.height !== height) this._stale = this._fresh = true;
    shadow.updateMatrices(light);
    if (!shadow.matrix.equals(this._matrix)) this._stale = true;   // the light or its box moved: every kept pixel is in the wrong place
    this._since++;
    for (const [mesh, kept] of this._instanced) {
      if (drawsAsKept(mesh, kept)) continue;
      if (!drawsAsKept(mesh, kept, true)) { this._stale = true; break; }
      this._kept.delete(mesh); this._instanced.delete(mesh); this._due = true;   // instances only: drawn live until the refill
    }
    if (this._due && this._since >= REFILL_EVERY) this._stale = true;
    if (this._stale) {
      cache.setSize(width, height, cache.depth);
      this._kept = new WeakSet();
      this._instanced.clear();
      this._filling = true;
      renderer.setRenderTarget(cache);
      super.renderShadow(frame);
      this._filling = false;
      renderer.setRenderTarget(shadowMap);
      this._matrix.copy(shadow.matrix);
      this._stale = this._due = false; this._since = 0; this._fills++;
    }
    if (this._fresh) { shadowMap.setSize(width, height, shadowMap.depth); renderer.initRenderTarget(shadowMap); this._fresh = false; }
    renderer.copyTextureToTexture(cache.depthTexture, shadowMap.depthTexture);
    // transmitted shadows: three reads the tint the static pass wrote from the color attachment, so the kept color comes along with the depth (GPT review l2-render 7)
    if (renderer.shadowMap.transmitted) renderer.copyTextureToTexture(cache.texture, shadowMap.texture);
    renderer.autoClear = false;   // the copied depth is the start of this pass; updateShadow restores the renderer's state after it
    super.renderShadow(frame);
  }
  /** @param {(object: any) => boolean} isStatic */
  set(isStatic) { this._isStatic = isStatic; this.redraw(); }
  redraw() { this._stale = true; /** @type {any} */ (this.light).shadow.needsUpdate = true; }
  dispose() { this._cache?.dispose(); this._cache = null; super.dispose(); }
  /** Switch off: the light gets three's own shadow node back */
  drop() {
    const light = /** @type {any} */ (this.light);
    delete light.shadow.shadowNode;   // three tests `!== undefined`: null would count as a node
    rebuildShadow(light);
  }
}

registerWebGPUPart('shadowCache', Object.freeze({
  /** @param {any} light @param {(object: any) => boolean} isStatic */
  create(light, isStatic) {
    notePatch('shadow-cache', 'light.shadow.shadowNode of a light handed to engine.shadows.cache: a ShadowNode subclass overriding setupRenderTarget (float depth), renderShadow and getShadowRenderObjectFunction', null,
      { scope: 'lights handed to engine.shadows.cache', lost: 'undone light by light with the handle: remove()' });
    return new CachedShadowNode(light, isStatic);
  },
}));
