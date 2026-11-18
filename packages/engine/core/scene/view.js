// engine.autoView: the camera and drawing-buffer values the engine changes on its own (camera.far for the view range, camera.fov for the settings slider and camera
// modules, the pixel ratio for adaptive resolution). Each is an owned property (core/ops/owned.js): a game's direct write wins, manual() takes one on purpose.
import * as THREE from 'three';
import { codedError } from '../base/errorHints.js';
import { defineOwned, manualVerb } from '../ops/owned.js';

/**
 * What engine.camera accepts: exactly THREE.PerspectiveCamera or THREE.OrthographicCamera. Exactly, because a subclass (ArrayCamera, a game's own) may draw by rules the engine's
 * cameras, shadows and post chain never read.
 * @param {any} cam
 */
export function checkCamera(cam) {
  if (cam?.constructor === THREE.PerspectiveCamera || cam?.constructor === THREE.OrthographicCamera) return;
  throw codedError('camera-option', `engine.camera takes a THREE.PerspectiveCamera or THREE.OrthographicCamera, got ${cam?.constructor?.name ?? cam}. Make one of those two, or keep a `
    + `subclass of your own out of engine.camera: render with it into a target in engine.onRender(({ renderer, scene }) => ...)`);
}

/**
 * Give a real orthographic camera a view height and shape around its own center, before camera.zoom.
 * @param {THREE.OrthographicCamera} c @param {number} height world units @param {number} [aspect] width / height, left out: as it is
 */
export function fitOrtho(c, height, aspect = (c.right - c.left) / (c.top - c.bottom)) {
  const x = (c.left + c.right) / 2, y = (c.top + c.bottom) / 2, w = height * aspect;
  c.left = x - w / 2; c.right = x + w / 2; c.top = y + height / 2; c.bottom = y - height / 2;
  c.updateProjectionMatrix();
}

/** The one place that writes camera.fov. A real orthographic camera has none @param {any} e @param {number} v */
function writeLens(e, v) { const c = e.camera; if ('fov' in c && c.fov !== v) { c.fov = v; c.updateProjectionMatrix(); } }

/**
 * Every engine write of camera.fov that is the base view (settings menu slider, camera modules) goes through here: it yields to a fov the game set itself.
 * While someone holds the camera the value is what the view goes back to, not what it shows now (viewHold).
 * @param {any} e @param {number} v
 */
export function setFov(e, v) {
  if (v == null) return;
  const h = e._viewHold, o = e._oFov;
  if (!h) { o.drive(v); return; }
  o.check();
  if (o.on) h.fov = v;
}

/**
 * The fov a holder of the camera shows (a shot, a named view): a layer on the base view, gone when the last holder leaves. It goes on even over a fov the game owns, because the
 * game asked for this shot; the game's value is what the hold recorded, so it comes back with the rest.
 * @param {any} e @param {number} v only with the camera held
 */
export function holdFov(e, v) {
  e._oFov.check();
  writeLens(e, v);
  e._oFov.mark();
  e._viewHold.shown = e.camera.fov;
}

/**
 * The fov of a rig's shot. A shot with one is a layer on the base view like a holder's, so the slider's value waits under it; null, a shot without one, lets the base view show.
 * It yields to a fov the game took, as setFov does. Why not setFov: a rig writes every frame, and what it writes there is the base, so nothing else could ever change it.
 * @param {any} e @param {number | null} v
 */
export function shotFov(e, v) {
  e._oFov.check();
  e._shotLens = v != null && e._oFov.on;
  viewHold(e);
  if (e._shotLens) holdFov(e, v);
}

/**
 * The 'camera' stack changed. Why here and not in each holder: every holder used to record the fov it found and write it back when it left, so two overlapping shots handed back
 * each other's half-way value and a slider moved meanwhile was lost. The first holder records the view it took, whatever asks for the view during the hold changes that record, and
 * the last one out lands it. A fov someone else wrote during the hold differs from what the holders showed, and stays.
 * @param {any} e
 */
export function viewHold(e) {
  const held = e.stacks.get('camera').size() > 0 || !!e._shotLens, h = e._viewHold;
  if (held === !!h) return;
  if (held) { e._viewHold = { fov: e.camera.fov, shown: e.camera.fov, projection: null }; return; }
  e._viewHold = null;
  if (h.projection) setProjection(e, ...h.projection);
  if (e.camera.fov !== h.shown || h.fov === undefined) return;
  writeLens(e, h.fov);
  e._oFov.mark();   // the record is the engine's own write; a fov that differed above stays for check() to see
}

/** The fov of the perspective view: while a rig's orthographic camera stands in, that is the camera it stands in for @param {any} e @returns {number | undefined} */
export const lensFov = e => (e._ortho?.home ?? e.camera).fov;

/** The base view's fov, what a shot with none blends to @param {any} e @returns {number | undefined} */
export const baseFov = e => e._viewHold?.fov ?? lensFov(e);

/** Hand everything a camera carries that its class does not decide to the next one, and make it engine.camera @param {any} e @param {any} to */
function swapCamera(e, to) {
  const from = e.camera;
  to.near = from.near; to.far = from.far; to.zoom = from.zoom; to.layers.mask = from.layers.mask;
  to.position.copy(from.position); to.quaternion.copy(from.quaternion); to.up.copy(from.up);
  if (from.parent) { from.parent.add(to); from.removeFromParent(); }
  if (from.children.length) to.add(...from.children);   // what a game hung on the camera stays on the view
  e.camera = to;
}

/**
 * A rig's projection option, as a thin call into the one way to an orthographic view: a real THREE.OrthographicCamera in engine.camera (the setter in core/engine/Engine.js, where
 * everything that draws, picks or owns a camera value already follows). The option stays because a view is not only a camera: a shot, a rig switch and a new playthrough each ask
 * for theirs, and going back needs someone who remembers what was there. That memory is engine._ortho: the one orthographic camera the rigs share, and the camera it stands in for.
 * A camera the game assigned is never overruled: 'perspective' is the rigs' "back to the default" and leaves a real orthographic camera as it is, and 'orthographic' on one only
 * sets its height.
 * @param {any} e the engine
 * @param {'perspective' | 'orthographic'} [projection]
 * @param {number} [size] orthographic only: world units covered by the view height (before camera.zoom)
 */
export function setProjection(e, projection = 'perspective', size = 20) {
  if (projection !== 'perspective' && projection !== 'orthographic') throw codedError('camera-option', `projection must be 'perspective' or 'orthographic', got '${projection}'`);
  if (e._viewHold) { e._viewHold.projection = [projection, size]; return; }   // a swap would pull the camera out from under the holder: it lands with the rest of the view
  const cam = e.camera;
  if (projection === 'perspective') { if (cam === e._ortho?.camera) swapCamera(e, e._ortho.home); return; }
  if (!(size > 0)) throw codedError('camera-option', `orthographic projection needs size > 0 (world units of view height), got ${size}`);
  if (cam.isOrthographicCamera) { if (cam.top - cam.bottom !== size) fitOrtho(cam, size); return; }
  e._ortho ??= { camera: new THREE.OrthographicCamera(), home: null };
  e._ortho.home = cam;
  fitOrtho(e._ortho.camera, size, cam.aspect);
  swapCamera(e, e._ortho.camera);
}

/**
 * engine.renderer.toneMapping as one owned value.
 * @param {any} e
 * @param {{ owned: boolean }} o owned: false when the game passed its own renderer
 */
export function defineTone(e, { owned }) {
  // who writes tone mapping now is one owned record like every other picture value (core/ops/owned.js),
  // not a comparison against a remembered creation value here: a direct renderer.toneMapping write yields it ('three (engine yielded)'), quietly (once),
  // because that write is the documented way to change the curve. A game-supplied renderer (owned false) starts manual: the engine never wrote it
  e._oTone = defineOwned(e, { id: 'toneMapping', part: 'tone', key: 'toneMapping', read: () => e.renderer.toneMapping, objects: [e.renderer], once: true,
    write: v => { e.renderer.toneMapping = v; }, levels: { manual: 'engine.renderer.toneMapping = THREE.AgXToneMapping' } });
  if (owned) e._oTone.mark(); else e._oTone.manual(true, 'game renderer');
}

/** @param {any} e */
export function defineView(e) {
  const cam = () => e.camera;
  // A real THREE.OrthographicCamera has no fov and no aspect, and its depth range is the game's: the engine leaves its far and fov alone, and its aspect is the frustum's shape.
  // The one a rig's projection made (setProjection) stands in for the perspective camera, so its far stays the view range's and goes back with the swap.
  // Rounded because a new view height writes the frustum again, and float noise there is not a game's write
  const lens = () => 'fov' in cam(), shape = c => Math.round((c.right - c.left) / (c.top - c.bottom) * 1e6) / 1e6;
  e._oFar = defineOwned(e, { id: 'view.far', part: 'view', key: 'far', read: () => cam().far, objects: [e.camera],
    write: v => { if (lens() || cam() === e._ortho?.camera) { cam().far = v; cam().updateProjectionMatrix(); } }, levels: { manual: "engine.autoView.manual('far')" } });
  e._oPixelRatio = defineOwned(e, { id: 'view.pixelRatio', part: 'view', key: 'pixelRatio', read: () => e.renderer.getPixelRatio(), objects: [e.renderer],
    levels: { manual: "engine.autoView.manual('pixelRatio')", set: 'engine.setPixelRatio(1.5)' } });
  // fov: the settings menu slider and camera modules (first person / rts / fixed shots, and restoring the fov at uninstall) go through setFov, and a holder's shot through holdFov,
  // so a game that sets camera.fov itself (a zoom) is not undone by the next camera switch.
  e._oFov = defineOwned(e, { id: 'view.fov', part: 'view', key: 'fov', read: () => cam().fov, objects: [e.camera],
    write: v => writeLens(e, v), levels: { manual: "engine.autoView.manual('fov')" } });
  // aspect: the engine writes it on every resize and when engine.camera is assigned. A game's own (letterbox, split view) stays, the same as far and fov.
  // A real orthographic camera keeps its view height and its width follows; left / right the game wrote itself count as its own aspect
  e._oAspect = defineOwned(e, { id: 'view.aspect', part: 'view', key: 'aspect', read: () => (lens() ? cam().aspect : shape(cam())), objects: [e.camera],
    write: v => { const c = cam(); if (lens()) { c.aspect = v; c.updateProjectionMatrix(); } else fitOrtho(c, c.top - c.bottom, v); }, levels: { manual: "engine.autoView.manual('aspect')" } });
  e._oFar.mark(); e._oPixelRatio.mark(); e._oFov.mark(); e._oAspect.mark();
  e.autoView = {
    /**
     * Stop the engine changing a camera or drawing-buffer value: the value is yours until you hand it back. A direct write takes it too; this says so on purpose,
     * with no warning. 'camera' hands the pose back after a direct write (take it with engine.takeCamera(owner)).
     * @example
     * const mine = engine.autoView.manual('far');
     * engine.camera.far = 5000;
     * mine.remove();
     * @param {'far' | 'fov' | 'aspect' | 'pixelRatio' | 'sunDir' | 'camera'} key
     * @param {boolean} [on] false hands it back
     * @returns {{ remove(): void }} remove() hands it back
     */
    manual(key, on = true) {
      if (typeof key !== 'string') throw codedError('owned-misuse', `engine.autoView.manual(key): key must be 'far', 'fov', 'aspect', 'pixelRatio', 'sunDir' or 'camera'; got ${JSON.stringify(key)}`);
      return manualVerb(e, 'view', key, on);
    },
  };
}
