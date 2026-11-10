// Shared parts of the camera modules: used by every camera (follow / first-person / fixed / strategy top-down).
//
// Camera interface (every camera module is named 'cameraRig', only one installed; swap at runtime with engine.setCamera('firstPerson' | 'follow' | 'rts' | 'fixed', options?),
// the swapped-out camera is kept, so its params survive switching back; engine.cameraRig.kind is the current kind):
//   follow(object)      who to follow (called automatically when the player is created)
//   target              the object being followed
//   forward() / right() unit directions {x, z} on the XZ plane; player movement uses them
//   focusPoint()        where the world loads around; screenToGround(ndcX, ndcY) the ground point under a screen point (rigModule gives every kind one)
//   update(dt, input)   per-frame camera update
// What a game's own camera module must provide instead (what control: 'camera', characters, photo, grid placement read): camera/contract.js.
//
// Cutscene takeover contract: engine.takeCamera(owner, { focus? }) -> { remove() } (core/ops/holds.js); engine.cameraOverride is the holder in charge.
//   A cutscene, a named view or a photo mode that places the camera itself takes it; several can hold it, the latest is in charge.
//   While anyone holds it the camera module leaves the camera alone; with a focus, engine.focus is set to it (the world loads around it).
//   A rig told to move meanwhile (cut, moveTo, a switch of rigs) only records it: its fields change, the camera does not, and its next update after the release lands it.
//   onOverride undoes what the rig did to the view for its own sake (the hidden body, the mouse lock).
//   When the last holder removes its claim the camera module resumes from its previous state. cameraOverride itself is read-only.
import * as THREE from 'three';
import { defineOwned, dropOwned } from '../../core/ops/owned.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { setFov, setProjection } from '../../core/scene/view.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';

// the takeover calls the owned-camera warning quotes (core/ops/owned.js): takeCamera is the one explicit entry (its remove() gives the camera back);
// back is the hand-back for a camera the engine yielded to a direct write (that takeover has no handle)
const LEVELS = { manual: "const cam = engine.takeCamera('me') (cam.remove() gives it back)", back: "engine.autoView.manual('camera', false)" };

/** True during a cutscene takeover, and updates engine.focus from the focus the owner supplied */
function applyOverride(e) {
  const o = e.cameraOverride;
  if (!o) return false;
  if (o.focus) e.focus.copy(o.focus);
  return true;
}

/** Flatten a 3D direction onto the XZ plane and normalize; use fallback when nearly vertical (top-down) */
function planar(dir, fallback = { x: 0, z: -1 }) {
  const l = Math.hypot(dir.x, dir.z);
  return l < 1e-4 ? { x: fallback.x, z: fallback.z } : { x: dir.x / l, z: dir.z / l };
}
/**
 * A rig value kept to its range [rig[loName], rig[hiName]] (the documented limit). Asked for outside it, it is said once in dev, naming the option that
 * widens it: a silent clamp made a game's wheel zoom do nothing past the default maxDistance. kept: return the value as given (a start value the first
 * wheel notch or drag pulls in), else the limit
 * @param {any} rig @param {string} kind the module function ('followCamera') @param {string} call where the value came from ('followCamera()', 'cameraRig.setView()')
 * @param {string} name @param {number} v @param {string[]} names [loName, hiName] @param {boolean} [kept]
 * @internal
 */
export function inRange(rig, kind, call, name, v, [loName, hiName], kept = false) {
  const limit = v > rig[hiName] ? hiName : v < rig[loName] ? loName : null;
  if (!limit) return v;
  const at = rig[limit];
  // a factory: the text is built only the one time it is said (a zoom past the limit asks every frame)
  warnOnce(() => coded('camera-clamped', `${call}: ${name} ${v} is ${limit === hiName ? 'above' : 'below'} ${limit} (${at}), so the camera keeps to ${at}. To allow it: ${kind}({ ${limit}: ${v} }) or engine.cameraRig.${limit} = ${v}`), `camera-clamped:${call}:${limit}`);
  return kept ? v : at;
}
/** Right direction from the forward direction (Y up) */
export const rightOf = f => ({ x: -f.z, z: f.x });

/**
 * Shared methods for cameras that compute direction from horizontal yaw (follow, first-person, strategy): Object.assign(Class.prototype, YAW_RIG).
 * forward() / right() are unit directions on the XZ plane; focusPoint() is the follow target's position (the camera position when there is none)
 */
export const YAW_RIG = {
  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; },
  right() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; },
  focusPoint() { return this.target ? this.target.position : this.engine.camera.position; },
};

/**
 * Hiding the followed character from the view (first person always, follow on a close-up): its meshes move to the rig's hideLayer, which the
 * camera does not render but every shadow camera does, so the shadow stays. Object.assign(Class.prototype, HIDE_RIG); the rig keeps this._hidden = []
 * and decides when to call _hideTarget (its own guard). Already-hidden meshes are skipped, so calling it again after a child was added is safe.
 */
export const HIDE_RIG = {
  _hideTarget() {
    this.target.traverse(o => {
      if ((o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) && !o.layers.isEnabled(this.hideLayer)) { this._hidden.push([o, o.layers.mask]); o.layers.set(this.hideLayer); }
    });
  },
  _unhide() { for (const [o, mask] of this._hidden) o.layers.mask = mask; this._hidden.length = 0; },   // follow calls it every frame
  // Lights present now (the sky module has built them by onEnter); a light added later calls shadow.camera.layers.enable(hideLayer) itself
  _shadowLayers() { this.engine.scene.traverse(o => { if (o.isLight && o.shadow?.camera) o.shadow.camera.layers.enable(this.hideLayer); }); },
};

/**
 * Click-to-lock the mouse for a camera with a pointerLock flag (first person, over-the-shoulder follow); call from onEnter.
 * Locked, mouse motion turns the view without dragging (input.look); Esc releases. Touch screens keep dragging.
 * The press that locks is swallowed (not Mouse0, not a click) unless the rig sets swallowLockClick: false
 */
export function clickToLock(rig, switched) {
  const e = rig.engine, canvas = e.renderer.domElement;
  const wouldLock = () => rig.pointerLock && !e.cameraOverride && e.input.enabled
    && !matchMedia('(pointer: coarse)').matches && document.pointerLockElement !== canvas;
  // Last outcome, shown by describe(): the drag fallback stays, but a refused lock is no longer silent
  const st = rig.lockState = { configured: !!rig.pointerLock, requested: false, locked: document.pointerLockElement === canvas, lastError: null,
    supported: typeof canvas.requestPointerLock === 'function' };
  const fail = err => { st.locked = false; st.lastError = String(err?.message ?? err ?? 'refused'); st.failedAt = e.time.now('real'); };
  const lock = () => {
    st.configured = !!rig.pointerLock;
    if (!wouldLock()) return;
    st.requested = true;
    try { const r = canvas.requestPointerLock?.(); r?.catch?.(fail); } catch (err) { fail(err); }   // browser refused the lock: fall back to dragging
  };
  rig._off = new AbortController();
  const sig = { signal: AbortSignal.any([e.signal, rig._off.signal]) };
  const change = e.events.on('page:pointerlock', ({ locked }) => { st.locked = locked; if (locked) st.lastError = null; else st.requested = false; });
  sig.signal.addEventListener('abort', change.remove);
  document.addEventListener('pointerlockerror', () => fail('pointerlockerror (browser refused: needs a user gesture, or the page lost focus)'), sig);
  const swallow = () => rig.swallowLockClick !== false && wouldLock();
  e.input.swallowLockClick = swallow; rig._swallow = swallow;
  canvas.addEventListener('click', lock, sig);   // removed on switch-away or engine.dispose()
  if (switched) lock();   // a runtime switch (a key press counts as a gesture) locks at once
}
/**
 * The pointer-lock state machine for describe(): off (not configured) / unsupported / locked / refused (browser denied) / requesting / waiting-click;
 * plus covered (an element other than the canvas sits at its centre, so a click never reaches it), cameraOverride (a takeover blocks locking) and the last failure
 * @internal
 */
function lockView(e, st) {
  if (!st?.configured) return { state: 'off' };
  const state = !st.supported ? 'unsupported' : st.locked ? 'locked' : st.lastError ? 'refused' : st.requested ? 'requesting' : 'waiting-click';
  const c = e.renderer.domElement, r = c.getBoundingClientRect();
  const top = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return { ...st, state, covered: top && top !== c ? (top.id ? '#' + top.id : top.className ? '.' + String(top.className).split(' ')[0] : top.tagName.toLowerCase()) : null,
    cameraOverride: e.cameraOverride?.owner ?? null, lastFailure: st.lastError ? { reason: st.lastError, agoSec: Math.round((e.time.now('real') - st.failedAt) / 100) / 10 } : null };
}
/** Release the mouse lock; stop listening for clicks too when switched away (call from onExit; from onOverride with keepListening) */
export function releaseLock(rig, keepListening = false) {
  if (!keepListening) { rig._off?.abort(); if (rig.engine.input.swallowLockClick === rig._swallow) rig.engine.input.swallowLockClick = null; }
  if (document.pointerLockElement === rig.engine.renderer.domElement) rig.engine.page.releaseLock();
}

/** The camera's own view direction on the XZ plane */
const _v = new THREE.Vector3();
export function viewForward(camera, fallback) {
  camera.getWorldDirection(_v);
  // When looking almost straight down, use the camera's "up" to stand for screen-up
  if (Math.hypot(_v.x, _v.z) < 0.05) _v.set(0, 1, 0).applyQuaternion(camera.quaternion);
  return planar(_v, fallback);
}

import { screenToGround } from '../../core/scene/screenToGround.js';   // shared with grid placement and click-to-move; lives in core
export { screenToGround };

/**
 * A rig placed the camera outside its update (fixedCamera cut, rtsCamera moveTo instant): that write is the engine's, not the game's, so the
 * next frame's single ownership check (core/ops/owned.js) must not take it for an outside write and stop the rig. Rigs call this from the one
 * method that writes the pose (their _place), instead of the module wrapping every rig method with a pose compare (that ran on every
 * forward() / right() read, several times per fixed step).
 * @internal
 */
export function rigPlaced(engine) { RIG_OWNED.get(engine)?.mark(); }
const RIG_OWNED = new WeakMap();   // engine -> the camera's owned entry (one camera module per engine)

/** Camera kind table: kind name -> build(engine, opts, input). Each camera file registers once with defineRig; setCamera switches by name.
 * input.define(name, o) declares an action owned by the camera module (once per name, removed with the module), so a rig built later by
 * setCamera or a new session leaves no declaration behind */
const RIGS = new Map();
const RIG_PARAMS = new Map();   // kind -> params schema (the option keys of that camera)
/** keys: the options that camera takes; they become its params schema (engine.catalog) and a misspelled one throws in dev */
export function defineRig(kind, build, keys = []) { RIGS.set(kind, build); RIG_PARAMS.set(kind, keysSchema(keys)); }

/**
 * Wrap a camera as a module: handles cutscene takeover, updates engine.focus, and provides runtime switching engine.setCamera(kind, options?).
 * The camera needs update(dt, input) and focusPoint(); optional onEnter(switching) / onExit() (when switched in / out) and onOverride(on) (cutscene takeover start / end).
 * kind: 'follow' | 'firstPerson' | 'fixed' | 'rts', reported in describe()
 */
export function rigModule(kind, opts) {
  let c = null, home = null, was = false, owned = null, hold = null, fresh = true, engine = null;   // home: the rig install built; every new playthrough goes back to this same object
  // the fov a switch of rigs goes back to, per camera: the value it had when first asked, so a camera the game assigned keeps its own
  const fovs = new WeakMap(), fov0 = () => { const m = engine.camera; if (!fovs.has(m)) fovs.set(m, m.fov); return fovs.get(m); };
  const cache = new Map();   // kind -> camera instance: params like distance and pitch survive switching away and back
  const builtWith = new WeakMap();   // rig -> the options it was built with
  let modInput = null; const declared = new Set();
  const input = { define: (n, o) => { if (!declared.has(n)) { declared.add(n); modInput.define(n, o); } } };
  const make = (k, o) => {
    const build = RIGS.get(k);
    if (!build) throw codedError('camera-kind', `setCamera() has no camera kind '${k}'; available: ${[...RIGS.keys()].join(', ')}`);
    readParams(`${k}Camera`, RIG_PARAMS.get(k), o);   // also covers setCamera(kind, options)
    const r = build(engine, o ?? {}, input);
    r.kind = k; cache.set(k, r); builtWith.set(r, o);
    // every kind answers the contract's screenToGround (click-to-move and placement work under any camera, not only the strategy one)
    if (typeof r.screenToGround !== 'function') r.screenToGround = (x, y) => screenToGround(engine, x, y);
    return r;
  };
  function setCamera(k, o) {
    if (k === c.kind && !o) return c;
    const old = c, target = old.target;
    old.onExit?.();
    setProjection(engine);   // back to perspective; an orthographic rig sets its own in onEnter / constructor
    setFov(engine, fov0());   // fov returns to the value at install; each camera applies its own in onEnter / constructor
    let next;
    // a bad kind or option throws, or a view engine.camera cannot show (onEnter): the old rig goes back on, or the game keeps a rig that let go of its target and of the mouse
    const back = err => { cache.set(old.kind, old); c = engine.cameraRig = old; old.onEnter?.(false); old.follow(target ?? null); throw err; };
    try { next = o || !cache.has(k) ? make(k, o) : cache.get(k); } catch (err) { back(err); }
    c = engine.cameraRig = next;
    try { next.onEnter?.(true); } catch (err) { next.onExit?.(); back(err); }
    // set up before play (boot code, the title up): this is the game's camera, so the playthrough starts from it, not from the module's options
    if (!engine.session.playing) { home = next; kind = k; opts = builtWith.get(next); }
    if (old.yaw !== undefined && next.yaw !== undefined && !(o && o.yaw != null)) next.yaw = old.yaw;   // keep turning from the same heading, no sudden spin
    next.follow(target ?? null);
    fresh = true;   // the camera position was changed here, not counted as "the game moved the camera"
    engine.events.emit('camera:change', { kind: k, previous: old.kind });   // player settings (sensitivity, fov) live on the rig: the settings menu re-applies them
    return c;
  }
  return {
    name: 'cameraRig', skipKind: 'none', type: 'picture', provides: ['cameraRig'], label: 'Camera', params: RIG_PARAMS.get(kind), options: opts, optional: ['collision', 'characters'], stage: 'control',
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.cameraRig': '相机' }, en: { 'module.cameraRig': 'camera' } });
      engine = e; fov0(); modInput = ctx.input; declared.clear();
      e.setCamera = setCamera;
      c = home = make(kind, opts);
      c.onEnter?.(false);
      // The view the player had is save data. Written to a rig of the saved kind only: a follow rig's pitch means the opposite of a first-person one's, so across kinds
      // only the heading carries (as in setCamera). A kind switched to at runtime is not restored: its options are the game's and are not save data
      ctx.saves.define('cameraRig', { notAtomic: 'the view is output: no game rule reads it, and a rollback must not move the camera',
        save: () => ({ kind: c.kind, yaw: c.yaw, pitch: c.pitch }),
        load: d => {
          const r = d.kind === c.kind ? c : home;
          if (r.yaw !== undefined && Number.isFinite(d.yaw)) r.yaw = d.yaw;
          if (r.pitch !== undefined && r.kind === d.kind && Number.isFinite(d.pitch)) r.pitch = d.pitch;
        },
      });
      // a new playthrough (newGame / load) starts with the camera as installed (kind, distance, every option), placed at the player instead of flying across the map.
      // The same object, so a rig the game kept at boot stays the camera; its view is what the load just left on it (the part above, or a game part's load() writing the rig)
      ctx.track(e.events.on('session:start', () => {
        // a hold made by writing the camera has no handle and no one who will end it: it belonged to the playthrough that is over. A manual() hold is on purpose and stays
        if (owned.mode === 'yielded') owned.manual(false);
        // the view the load left is on the rig of the saved kind, and that may be a rig switched to at runtime (the cameraRig part above)
        const old = c, { yaw, pitch } = c.kind === kind ? c : home;
        old.onExit?.(); cache.clear();
        setProjection(e);
        setFov(e, fov0());
        const built = make(kind, opts);
        for (const k of Object.keys(home)) delete home[k];
        c = e.cameraRig = Object.assign(home, built, yaw !== undefined && { yaw, pitch });
        cache.set(kind, home);
        // follows the player only if the game asked (addPlayer({ cameraFollow })), through the seat the load put it in: the rig was rebuilt after that seat was taken
        const P = e.player, car = P?.cameraFollow ? P.vehicle : null;
        c.onEnter?.(false); c.follow(car ? car.object : P?.cameraFollow ? P.root : null, car?.camera); fresh = true;
        e.events.emit('camera:change', { kind, previous: old.kind });   // settings re-apply the player's sensitivity / fov to the rebuilt rig
      }));
      // a scenario put the player somewhere else (?at, ?pos): a rig that eases would open on a glide across the map; follow() puts it there at once
      ctx.track(e.events.on('state:placed', () => { if (c.target) { c.follow(c.target); fresh = true; } }));
      // The camera module places position / orientation every frame: a game that moves the camera directly takes it (the rig stops), warned once
      const cam = e.camera;
      // One camera state: takeCamera's 'camera' stack. engine.autoView.manual('camera') and a direct write become a takeCamera hold too (owner
      // 'manual:<who>' / 'three'), so cameraOverride, describe().holds and the rig's onOverride see every takeover the same way; handing back
      // (manual('camera', false)) removes that hold. Why: four entries with four states meant a pointer lock or focus that only one of them reset.
      owned = defineOwned(e, { id: 'camera', part: 'view', key: 'camera', read: () => { const { position: p, quaternion: q } = e.camera; return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]; }, objects: [cam, cam.position, cam.quaternion], levels: LEVELS,
        onChange: o => {
          if (o.mode === 'engine') { hold?.remove(); hold = null; }
          // focus: the rig's live focus point (its target's position), so the world keeps loading around the player while the game moves the camera
          else if (!hold) hold = e.takeCamera(o.mode === 'manual' ? `manual:${o.by}` : 'three', { focus: c.focusPoint() });
        } });
      RIG_OWNED.set(e, owned);
      return c;
    },
    frame(dt, e) {
      const over = !!e.cameraOverride;
      if (over !== was) { was = over; c.onOverride?.(over); }
      if (applyOverride(e)) { fresh = true; return; }   // not checked during takeover; re-record afterwards
      if (!fresh) owned.check();
      // a platform moved this frame (onFrame, a timeline tween before this hook): the rider goes with it first, so the rig does not read last frame's position.
      // Here and not by moving rigs after characters: prompts, markers, bubbles and chunk culling run in between and must see this frame's camera
      e.characters?.carryRiders?.();
      if (owned.on) { e._poses.around(c.target, () => c.update(dt, e.input)); c.pixelSnap?.apply(); }   // the rig follows what is drawn this frame; pixelSnap rounds what the rig decided, whichever rig it is
      e.focus.copy(c.focusPoint());   // decides only where the view (terrain, models) loads; the gameplay simulation center is world.anchor (default the player), so moving the camera away changes nothing
      owned.mark(); fresh = false;
    },
    describe(e, ctx) { ctx.out.camera ??= {}; ctx.out.camera.type = c.kind; if (c.current !== undefined) ctx.out.camera.shot = c.current;
      ctx.out.camera.pointerLock = lockView(e, c.lockState); if (c.pixelSnap) ctx.out.camera.pixelSnap = c.pixelSnap.describe(); },
    // the active rig lets go of what it holds (pointer lock, a fixed rig's zone listener); engine.setCamera falls back to the core stand-in,
    // so a rolled-back install leaves no camera function behind that drives a rig nobody owns
    // a hold this rig opened on a write or a manual('camera') ends with it: the next rig has its own state, and nothing it hears could hand this hold back
    dispose(e) { c?.onExit?.(); hold?.remove(); hold = null; dropOwned(e, [owned]); setProjection(e); setFov(e, fov0()); delete e.setCamera; RIG_OWNED.delete(e); },
  };
}

/** Shared camera module text */
export const CAMERA_STRINGS = {
  'zh-CN': { 'camera.rotateLeft': '视角左转', 'camera.rotateRight': '视角右转' },
  en: { 'camera.rotateLeft': 'Rotate view left', 'camera.rotateRight': 'Rotate view right' },
};

export const handRolled = [{ kind: 'follow', seen: 'a camera follow of its own', use: 'followCamera() or openWorld({ camera }): collision, smoothing and switching are handled; a shot of your own: engine.takeCamera(owner) (recipe 21)', quiet: /\b(?:follow|firstPerson|fixed|rts)Camera\(|\bopenWorld\(|\b(engine|e|eng|ctx)\.(takeCamera|cameraRig|setCamera)\b/, code: /\bcamera\.position\.(?:lerp|copy|set)\s*\(/, raw: /player|hero|target|character|avatar/i, near: [{ re: /\bonFrame\b|\bonRender\b|\bonFixed\b|requestAnimationFrame|\bupdate\b|\btick\b|\banimate\b/, lines: 12 }] }];
