// Third-person follow camera: drag (or pointer lock) to rotate, wheel to zoom, stays out of the terrain, smooth follow,
// optional shoulder offset and lock-on framing.
// yaw is which side of the focus the camera sits on: camera = focus + (sin yaw, cos yaw) * distance, so it looks along forward() = -(sin yaw, cos yaw).
// To see a character facing angle f from behind, yaw = f + PI.
// Cutscene takeover: while someone holds engine.takeCamera (engine.cameraOverride is not null) the camera is left alone (see common.js).
// Ground (option `ground`): 'raise' lifts a camera that would sink below the ground (the view direction changes: you cannot look up from flat ground);
//   'shorten' pulls the camera along the arm toward the target instead (the view direction stays, so a negative minPitch really looks up); 'none' leaves it;
//   a function (facts) => position | null decides. Default: 'shorten' when minPitch < 0, else 'raise' (what older games were tuned for).
// Game-driven view: setView({ yaw, pitch, distance }) / getView(); mouseLook: false stops the built-in mouse / stick look so the game owns yaw and pitch.
// Close-up: when the camera ends up nearer than hideTargetNear to the look point (wall, ground), the followed object is hidden from the camera (shadow stays).
// Other cameras: firstPersonCamera, fixedCamera, rtsCamera (top-down strategy); all are engine.cameraRig; switch at runtime with engine.setCamera('firstPerson').
import * as THREE from 'three';
import { rigModule, defineRig, YAW_RIG, HIDE_RIG, clickToLock, releaseLock, inRange } from './common.js';
import { setProjection } from '../../core/scene/view.js';
import { rigPixelSnap, checkPixelView } from './pixelSnap.js';
import { codedError } from '../../core/base/errorHints.js';
import { wrapAngle } from '../../core/base/math.js';

const GROUND = ['raise', 'shorten', 'none'];
// ground: 'shorten' sampling. 0.2 m: narrower than this the ground height rarely has a feature that blocks the view (posts and walls are colliders,
// handled by the occlusion pull-in). 160 samples (one surface() each, every frame) keep full spacing up to a 32 m arm.
const SHORTEN_STEP = 0.2, SHORTEN_MAX = 160;
const DISTANCE = ['minDistance', 'maxDistance'], PITCH = ['minPitch', 'maxPitch'];

export class FollowCamera {
  /** yaw/pitch initial angles (yaw: see the top of this file); distance (min/max zoom range); height how high on the character to look; smoothing follow smoothness;
   *  sensitivity drag sensitivity; minPitch/maxPitch pitch range; zoomStep zoom ratio per wheel notch; groundClearance lowest camera height above the ground;
   *  shoulder meters to the right of the target the camera aims (over-the-shoulder; negative = left shoulder, 0 = centered);
   *  pointerLock click locks the mouse (no dragging; the press that locks is swallowed, swallowLockClick: false delivers it);
   *  ground 'raise' | 'shorten' | 'none' | fn (see the top of this file); mouseLook false = the game drives yaw / pitch (setView);
   *  hideTargetNear hide the followed object when the camera is closer than this (m, 0 = never); hideLayer layer used for hiding;
   *  pixelSnap { pixelsPerMeter, bounds } orthographic only: art-pixel rounding, and it decides the view height (pixelSnap.js) */
  constructor(engine, { yaw = 0.8, pitch = 0.42, distance = 13, minDistance = 4, maxDistance = 45, height = 1.4, smoothing = 10,
    sensitivity = 1, minPitch = 0.05, maxPitch = 1.35, zoomStep = 0.1, groundClearance = 1.2, invertY = false, shoulder = 0, pointerLock = false, swallowLockClick = true, projection = 'perspective', size = null,
    ground = null, mouseLook = true, hideTargetNear = 0.9, hideLayer = 30, pixelSnap = null } = {}) {
    if (ground != null && typeof ground !== 'function' && !GROUND.includes(ground)) throw codedError('camera-option', `followCamera({ ground: '${ground}' }): use ${GROUND.map(g => `'${g}'`).join(' | ')} or a function (facts) => position`);
    if (pixelSnap) checkPixelView('followCamera', { projection, size });
    /** Art-pixel rounding (.grid, .error, .agrees) or null */
    this.pixelSnap = rigPixelSnap(engine, pixelSnap, 'followCamera');
    size ??= 20;
    this.projection = projection; this.size = size;   // 'orthographic': size = world units of view height (the wheel changes size there, clamped to the min/max distance ratio)
    this.size0 = size; this.distance0 = distance;
    Object.assign(this, { engine, yaw, pitch, distance, minDistance, maxDistance, height, smoothing, sensitivity, minPitch, maxPitch, zoomStep, groundClearance });
    Object.assign(this, { invertY, shoulder, pointerLock, swallowLockClick, ground, mouseLook, hideTargetNear, hideLayer });
    // a start outside the range stays as given (the first wheel notch or drag pulls it in), and says so
    inRange(this, 'followCamera', 'followCamera()', 'distance', distance, DISTANCE, true); inRange(this, 'followCamera', 'followCamera()', 'pitch', pitch, PITCH, true);
    this._hidden = [];
    /** Arm length used last frame (after walls and ground), meters */
    this.arm = distance;
    this.target = null;
    /** Lock-on framing set by frame(): { target, strength } or null */
    this.framing = null;
    this.focus = new THREE.Vector3();
  }
  /** Follow obj; opts { distance, height } temporarily override distance/height (for driving), restored on the next follow */
  follow(obj, opts) {
    this._unhide();
    if (this._saved) { Object.assign(this, this._saved); this._saved = null; }
    if (opts) { this._saved = { distance: this.distance, height: this.height }; if (opts.distance != null) this.distance = inRange(this, 'followCamera', 'cameraRig.follow(obj, { distance })', 'distance', opts.distance, DISTANCE, true); if (opts.height != null) this.height = opts.height; }
    this.target = obj; if (obj) this.focus.copy(obj.position);
  }

  /**
   * Lock-on framing: each frame turn yaw toward "behind the followed object, looking at target" (forward() turns with it, so camera-relative movement strafes around the target).
   * Mouse / stick yaw is ignored while framing; frame(null) hands yaw back. strength: how fast it turns (1/s). Set it once when the lock starts, not every frame
   * @example engine.cameraRig.frame(enemy.root); player.faceMode = 'target'; player.faceTarget = enemy.root;
   */
  frame(target, { strength = 6 } = {}) { this.framing = target ? { target, strength } : null; }
  /**
   * Set the view from game code (scripted look, your own input scheme): any of yaw / pitch (clamped to minPitch..maxPitch) / distance (clamped to the zoom range;
   * a value past the range warns once in dev, naming the option to widen).
   * Pair with mouseLook: false to own the view every frame. Returns the rig
   * @example engine.cameraRig.setView({ pitch: -0.6 })   // look up (negative pitch = camera below the look point)
   */
  setView({ yaw, pitch, distance } = {}) {
    if (yaw != null) this.yaw = yaw;
    if (pitch != null) this.pitch = inRange(this, 'followCamera', 'cameraRig.setView()', 'pitch', pitch, PITCH);
    if (distance != null) this.distance = inRange(this, 'followCamera', 'cameraRig.setView()', 'distance', distance, DISTANCE);
    return this;
  }
  /** The current view: yaw, pitch, distance (wanted), arm (actual after walls / ground, m), lookPoint and look (unit 3D view direction of the camera) */
  getView() {
    const look = this.engine.camera.getWorldDirection(new THREE.Vector3()), p = this._pivot ?? this.focus;
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance, arm: this.arm, lookPoint: { x: p.x, y: p.y, z: p.z }, look: { x: look.x, y: look.y, z: look.z } };
  }
  onEnter(switched) { clickToLock(this, switched); if (this.pixelSnap) this.pixelSnap.enter(); else setProjection(this.engine, this.projection, this.size); this._shadowLayers(); }
  onExit() { releaseLock(this); this._unhide(); }
  onOverride(on) { if (on) { releaseLock(this, true); this._unhide(); } }   // the close-up hide is about this rig's view; update() decides it again at release

  update(dt, input) {
    const cam = this.engine.camera, fr = this.framing;
    if (fr && this.target) {
      const t = fr.target.position ?? fr.target, p = this.target.position;
      this.yaw += wrapAngle(Math.atan2(p.x - t.x, p.z - t.z) - this.yaw) * Math.min(1, dt * fr.strength);
    }
    if (input.enabled && this.mouseLook !== false) {
      if (!fr) this.yaw -= input.look.dx * 0.005 * this.sensitivity;
      if (!this.lockPitch) this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch + input.look.dy * 0.004 * this.sensitivity * (this.invertY ? -1 : 1)));
      if (input.look.zoom && this.pixelSnap) { /* the view height is pixelSnap's; the art-pixel zoom is engine.setPixelSize */ }
      else if (input.look.zoom && cam.isOrthographicCamera) {
        // distance shows nothing in an orthographic view, whichever the rig asked for: zoom `size`, clamped to the same min/max ratio as distance, same wheel feel.
        // A camera the game assigned counts from the height it came with
        if (this._zoomed !== cam) { this._zoomed = cam; this.size = this.size0 = cam.top - cam.bottom; }
        const lo = this.size0 * this.minDistance / this.distance0, hi = this.size0 * this.maxDistance / this.distance0;
        this.size = Math.min(hi, Math.max(lo, this.size * (1 + input.look.zoom * this.zoomStep)));
        setProjection(this.engine, 'orthographic', this.size);
      } else if (input.look.zoom) this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance * (1 + input.look.zoom * this.zoomStep)));
    }
    if (!this.target) return;
    const want = this.target.position, e = this.engine;
    this.focus.lerp(want, 1 - Math.exp(-this.smoothing * dt));
    // shoulder: shift the aim point (and so the camera) sideways along right()
    const sh = this.shoulder, fx = this.focus.x + Math.cos(this.yaw) * sh, fy = this.focus.y + this.height, fz = this.focus.z - Math.sin(this.yaw) * sh, cp = Math.cos(this.pitch);
    const ux = Math.sin(this.yaw) * cp, uy = Math.sin(this.pitch), uz = Math.cos(this.yaw) * cp;   // unit arm direction, look point -> camera
    const place = d => cam.position.set(fx + ux * d, fy + uy * d, fz + uz * d);
    place(this.distance);
    // Occlusion: pull in when a trunk or house blocks the view (at once); ease back out when clear
    const pivot = this._pivot ??= new THREE.Vector3(); pivot.set(fx, fy, fz);
    const allowed = e.collision && this.avoidOcclusion !== false ? e.collision.cameraDistance(pivot, cam.position, this.distance) : this.distance;
    this._d = this._d ?? this.distance;
    this._d = allowed < this._d ? allowed : this._d + (allowed - this._d) * (1 - Math.exp(-3 * dt));
    let arm = this._d;
    // Ground: see the top of this file
    const mode = this.ground ?? (this.minPitch < 0 ? 'shorten' : 'raise');
    const clear = this.groundClearance, surf = (x, z) => e.surface(x, z, fy);
    if (mode === 'shorten') arm = this._shorten(fx, fy, fz, ux, uy, uz, arm, surf);
    place(arm);
    if (mode === 'raise') {
      const g = surf(cam.position.x, cam.position.z) + clear;   // the layer the player is on: a floor above must not lift the camera out of a cellar
      if (cam.position.y < g) cam.position.y = g;
    } else if (typeof mode === 'function') {
      const r = mode({ position: cam.position.clone(), lookPoint: pivot.clone(), dir: { x: ux, y: uy, z: uz }, arm, distance: this.distance,
        groundY: surf(cam.position.x, cam.position.z), clearance: clear, surface: surf, rig: this });
      if (r) cam.position.set(r.x, r.y, r.z);
    }
    this.arm = cam.position.distanceTo(pivot);
    if (this.hideTargetNear > 0 && this.arm < this.hideTargetNear) this._hide(); else this._unhide();
    cam.lookAt(fx, fy, fz);
  }

  /** @internal Longest arm (<= d) from the look point that stays groundClearance above the ground along its whole length (clearance capped at half the look point's own height above ground) */
  _shorten(fx, fy, fz, ux, uy, uz, d, surf) {
    const c = Math.max(0.05, Math.min(this.groundClearance, (fy - surf(fx, fz)) * 0.5));
    const below = t => fy + uy * t < surf(fx + ux * t, fz + uz * t) + c;
    // Samples at most SHORTEN_STEP apart, so a narrow rise between two samples (a ridge, a step, a low wall in the ground height) is not stepped
    // over; a fixed count missed a 0.25 m bump in the middle of an 8 m arm. Very long arms cap the count (cost) and space the samples wider.
    const N = Math.min(SHORTEN_MAX, Math.max(1, Math.ceil(d / SHORTEN_STEP)));
    let lo = 0;
    for (let i = 1; i <= N; i++) {
      const t = d * i / N;
      if (below(t)) {
        let hi = t;
        for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (below(m)) hi = m; else lo = m; }
        return lo;
      }
      lo = t;
    }
    return d;
  }
  // called every frame during a close-up: traverse only on the frame it starts
  _hide() { if (this.target && !this._hidden.length) this._hideTarget(); }
}

// forward / right relative to the camera heading (player movement) and the focus point: YAW_RIG; close-up hiding: HIDE_RIG
Object.assign(FollowCamera.prototype, YAW_RIG, HIDE_RIG);

/**
 * Third-person follow camera module. Installs engine.cameraRig; engine.cameraRig.follow(object).
 * Over the shoulder: followCamera({ distance: 3, shoulder: 0.7, pitch: 0.15, pointerLock: true }); lock-on: engine.cameraRig.frame(target)
 * Top-down game: followCamera({ pitch: 1.1, distance: 30, minDistance: 15, lockPitch: true })
 * Look up from flat ground (action game): followCamera(presets.camera.thirdPersonAction); game-driven view: mouseLook: false + engine.cameraRig.setView({ yaw, pitch })
 */
export function followCamera(opts = {}) { return rigModule('follow', opts); }
defineRig('follow', (e, opts) => {
  const c = new FollowCamera(e, opts); if (opts.lockPitch) c.lockPitch = true; return c;
}, ['yaw', 'pitch', 'distance', 'minDistance', 'maxDistance', 'height', 'smoothing', 'sensitivity', 'minPitch', 'maxPitch',
    'zoomStep', 'groundClearance', 'invertY', 'lockPitch', 'shoulder', 'pointerLock', 'swallowLockClick', 'projection', 'size',
    'ground', 'mouseLook', 'hideTargetNear', 'hideLayer', 'pixelSnap']);
