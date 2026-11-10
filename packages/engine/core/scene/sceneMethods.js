// Scene and render settings on the engine (split out of Engine.js): add / detach / remove objects, pixel ratio, one-off renders (renderOnce).
// add registers each root in the thing registry (things.js) so engine.thing / hit.thing can say what it is and what a save keeps. A plain
// engine.scene.add(obj) is registered the same way (things.js adopts roots added under the scene), so both ways in give the same answer.
import { DEV } from '../base/validate.js';
import { askRatio, askPixelSize } from './pixelRatio.js';
import { codedError } from '../base/errorHints.js';
import { thing } from './thingOps.js';
import { isUnder } from '../base/util.js';
import { freshFrame, renderOnce as drawOnce } from '../../render/backend.js';
import { freeParts, partsOf as parts, copyOwns, kept } from '../base/freeParts.js';
/**
 * How many objects in the scene use each geometry and material. Why remove asks: disposing a kit that other streamed blocks still draw makes the renderer
 * rebuild all of them (worst frame 270 ms against 79 in the city stress run). One walk per task, so removing ten thousand objects in a loop walks once; an object
 * added later in that task is not counted, so its geometry may be disposed and uploaded again, which costs time and nothing else; one that left by plain scene.remove
 * in that task still counts, so its model waits for the next engine.remove. Batches are left out:
 * batching.held speaks for them, and it lets go when a batch dissolves in the same task.
 * shortcut: one walk of the scene per frame that removes something (not measured at 100k objects); if it shows up in a profile, keep the counts on the scene-add hook instead.
 */
function sceneUsers(e) {
  if (e._users) return e._users;
  const users = e._users = new Map(), skip = e.batching.root;
  const walk = o => { if (o === skip) return; for (const x of parts(o)) users.set(x, (users.get(x) ?? 0) + 1); for (const c of o.children) walk(c); };
  walk(e.scene);
  queueMicrotask(() => { e._users = null; });
  return users;
}

/** A short stack for "added at main.js:50" (dev): 4 frames are enough (this, add, its caller) and keep the cost low; it is formatted only when read */
function captureStack() {
  const lim = Error.stackTraceLimit; Error.stackTraceLimit = 4;
  try { return new Error(); } finally { Error.stackTraceLimit = lim; }
}

export const sceneMethods = {
  /**
   * Add objects to the scene and register them (engine.thing). The last argument may be an options object: id makes the object's thing.set /
   * thing.remove changes saved (unique, no '#'; with several objects pass id for one object only); without it a unique obj.name is used, else a
   * session id obj#n. save: true says you expect it to be saved: dev warns when it cannot be (no id, or added during play). Returns the first object.
   * @example engine.add(windmill, { id: 'windmill' });   // at setup: thing.set changes to it are saved
   * @example engine.add(spark);                          // fine for effects: lives this session only
   * @template {import('three').Object3D} T
   * @param {[T, ...any[]]} objs  Object3D roots, optionally followed by { id?, save? }
   * @returns {T}
   */
  add(...objs) {
    const last = objs.at(-1), opts = last && !last.isObject3D ? objs.pop() : null;
    if (opts?.id != null && objs.length > 1) throw codedError('thing-id', `engine.add(a, b, …, { id: '${opts.id}' }): an id names one object; add the others in their own call`);
    const T = this._things, stack = DEV && !opts?.owner && T.wantStack() ? captureStack() : null;
    if (DEV && opts?.owner !== 'world') for (const o of objs) {
      const rid = this._things.idOf(o);
      if (rid) throw codedError('thing-owned', `engine.add(): this object is the model of world record '${rid}' (world builds, places and tears it down). Change the record instead: ops.run('thing.set', { id: '${rid}', position }) or world.set / world.move`);
    }
    // register first: scene.add below would otherwise adopt each root as a plain game object (thingOps adoptPlainAdds) before opts are seen
    for (const o of objs) T.add(o, opts, stack);
    this.scene.add(...objs);
    return objs[0];
  },
  /**
   * What a thing is and what a save keeps: a world record id, an id / name given to engine.add, or any Object3D (its registered ancestor).
   * Returns { id, kind, owner, at, phase, saved: 'record' | 'code' | 'session' | 'engine', keeps, loses, edit, object } (object is the live
   * Object3D); throws with the closest id when nothing matches. Change it with ops.run('thing.set', { id, position }) or 'thing.remove'.
   * @example engine.thing('windmill').saved   // 'code': rebuilt by code each start, thing.set changes saved
   * @example engine.thing(engine.pick(0, 0).object).edit
   * @param {string | import('three').Object3D} idOrObj
   * @returns {import('../../types/core').Thing}
   */
  thing(idOrObj) { return thing(this, idOrObj); },
  /** @internal Dev: a module found two systems managing one object; listed in describe().scene.conflicts and warned once (code thing-owned) */
  thingConflict(text) { this._things.conflict(text); },
  /**
   * Delete an object for good: detach it, unregister its rays and dispose the geometries and materials nothing else in the scene uses (textures are kept).
   * One still used by another object stays, and goes with its last user. Geometry and materials shared by assets model clones are only decremented in use count (see Assets.js).
   * The call is the game handing the object over (design.md 6.2), so a part the game made goes too; a model copy's own bones go with the copy
   */
  remove(...objs) {
    // every root leaves and is uncounted first, then one free over all of them: two roots sharing a material free it once, and a part one root still
    // drew while the other was freed is not kept by a root that is leaving in the same call
    for (const o of objs) {
      const counted = isUnder(o, this.scene) && !!this._users;   // the count was made while this object was still in the scene
      o.removeFromParent();
      this._things.forget(o);
      this.rays.forget(o);
      this.assets.forget(o);
      this._poses.forget(o);
      if (counted) o.traverse(c => { for (const x of parts(c)) this._users.set(x, (this._users.get(x) ?? 0) - 1); });
    }
    const shared = this.assets.shared, held = this.batching.held;   // a batch still drawing the same geometry / material keeps it alive
    // The whole-scene count only for a part nothing else keeps (mine asks the cheap sets first): unloading a streamed block whose kit is all held by batches
    // walked every object of the district for nothing (7 ms in one frame of the city run). A kept part (keepPart) is its maker's to free
    freeParts(objs, x => !shared.has(x) && !held.has(x) && !kept(x) && !(sceneUsers(this).get(x) > 0), { own: c => copyOwns(shared, c) || c.isInstancedMesh || c.isBatchedMesh });
  },
  /**
   * Draw one picture now, outside the loop, on either renderer. renderOnce() (target null, the engine camera): the frame the player sees, onto
   * the canvas through engine.post; read the canvas in the same task (canvas.toDataURL / drawImage), as photo mode does.
   * renderOnce(target): that frame into a render target instead, always the canvas's pixels (tone mapped, output color space), whether or not an
   * effect is on. renderOnce(target, camera) with another camera: the scene without post (the chain is built around the engine camera's screen) and
   * as three draws into a target, linear and not tone mapped (for data or your own pass); into target or, with target null, the canvas. On WebGPURenderer each call is a fresh node frame, so a RenderPipeline's scene
   * pass, which three draws once per frame, draws again: two calls in one task give two pictures (docs/plans/2026-11-03-webgpu-phase2.md 3).
   * @example engine.renderOnce(); const url = engine.renderer.domElement.toDataURL('image/png');
   * engine.renderOnce(rt, mapCamera);   // a minimap / thumbnail into your own render target
   * @param {any} [target] three render target, null = the canvas
   * @param {import('three').Camera} [camera] default engine.camera
   * @returns {void}
   */
  renderOnce(target = null, camera = this.camera) {
    const own = this._ownFrame;   // an engine draw, not the game taking the canvas over (render/ownFrame.js)
    this._gameLights?.sync();   // the light watch catches up first: a RectAreaLight added since the last frame gets its tables before this draw (gameLights.js)
    if (own) own.inside++;
    try {
      if (camera === this.camera) { freshFrame(this.renderer); this.post.render(0, target); return; }
      drawOnce(this.renderer, this.scene, camera, target);
    } finally { if (own) own.inside--; }
  },
  /** Render resolution, and the top adaptive resolution climbs back to. Throws while pixelSize is on (core/scene/pixelRatio.js) @param {number} p */
  setPixelRatio(p) { askRatio(this, p); },
  /**
   * One art pixel becomes k real screen pixels, every one the same width at any display scale, and it stays so through a page zoom or a move to another display.
   * While on, adaptive resolution stops and engine.setPixelRatio throws; a photo keeps the art pixels. null turns it off.
   * @example engine.setPixelSize(3);
   * @param {number | null} k a whole number from 1 up, or null
   */
  setPixelSize(k) { askPixelSize(this, k); },
  /** Raise camera.far to at least far (terrain view range). Goes through ownership: a game that owns camera.far (engine.autoView.manual('far')) keeps its value. @param {number} far */
  viewFar(far) {
    if (this.camera.far >= far) return;
    if (this._oFar) this._oFar.drive(far); else { this.camera.far = far; this.camera.updateProjectionMatrix(); }
  },
};
