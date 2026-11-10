// First-person camera: sits at the character's eye height; the mouse looks around.
//   - Desktop: with pointerLock true, one click locks the mouse (Esc exits), then moving the mouse turns the head; otherwise hold and drag to turn
//   - Mobile: drag to turn
//   - Slight vertical bob while walking (headBob), can be turned off
//   - hideTarget: hide the followed character from the camera (no seeing inside your own body); the shadow stays
// Cutscene takeover: while someone holds engine.takeCamera (engine.cameraOverride is not null) the camera is left alone (see common.js).
//
//   engine.use(firstPersonCamera({ height: 1.6, sensitivity: 1, fov: 70, headBob: 0.04, pointerLock: true }));
//   engine.cameraRig.yaw = Math.PI;       // set facing directly
//   engine.cameraRig.lookAt(position);    // turn toward a point (Vector3 / object / [x, y, z])
//   engine.setCamera('follow');           // switch back to third person at runtime (mouse lock releases, body shows again); see recipes/21-camera.md
import * as THREE from 'three';
import { rigModule, defineRig, YAW_RIG, HIDE_RIG, clickToLock, releaseLock, inRange } from './common.js';
import { vec3 } from '../../core/base/math.js';
import { setFov } from '../../core/scene/view.js';

export class FirstPersonCamera {
  /**
   * height eye height above the feet; sensitivity mouse sensitivity; fov field of view (unchanged if omitted);
   * headBob walking bob amplitude (m, 0 = off); bobFrequency bobs per meter; hideTarget hide the character itself; hideLayer layer number used for hiding (0-31, must not clash with other uses);
   * pointerLock lock the mouse on click (the press that locks is swallowed: not Mouse0, not a click; swallowLockClick: false delivers it); yaw/pitch initial facing; minPitch/maxPitch look-down/look-up limits (radians);
   * yawLimits [min, max] limits left-right turning (e.g. seated in a car), unlimited by default; smoothing how smoothly the camera follows the body; invertY flip vertical look
   */
  constructor(engine, { height = 1.6, sensitivity = 1, fov = null, headBob = 0.04, bobFrequency = 0.9, hideTarget = true, hideLayer = 30,
    pointerLock = true, yaw = 0, pitch = 0, minPitch = -1.45, maxPitch = 1.45, yawLimits = null, smoothing = 30, invertY = false, swallowLockClick = true } = {}) {
    Object.assign(this, { swallowLockClick, engine, height, sensitivity, headBob, bobFrequency, hideTarget, hideLayer, pointerLock, yaw, pitch, minPitch, maxPitch, yawLimits, smoothing, invertY });
    inRange(this, 'firstPersonCamera', 'firstPersonCamera()', 'pitch', pitch, ['minPitch', 'maxPitch']);   // update keeps pitch in range from the first frame
    this.target = null;
    this.eye = new THREE.Vector3();
    this._bob = 0; this._bobAmp = 0; this._last = null; this._hidden = [];
    this.fov = fov;
  }

  /** Called when this camera is switched in (module install, setCamera): applies fov and click-to-lock; a runtime switch (key press counts as a gesture) locks at once */
  onEnter(switched) {
    const { engine, fov } = this;
    if (fov) setFov(engine, fov);
    // The shadow camera must see the hidden layer too, or the character's shadow vanishes
    this._shadowLayers();
    clickToLock(this, switched);
  }
  /** Called when this camera is switched out: release the mouse lock and show the body again */
  onExit() {
    releaseLock(this);
    this.follow(null);   // body shows again; stop watching newly loaded models
  }

  follow(obj) {
    this._unhide();
    this._onChild && this.target?.removeEventListener('childadded', this._onChild);
    this.target = obj; this._last = null;
    if (obj) {
      this.eye.copy(obj.position); this.eye.y += this.height; this._hide();
      // The model may load later (attached under the character): hide children as they are added, no periodic traversal
      this._onChild ??= () => this._hide();
      obj.addEventListener('childadded', this._onChild);
    }
  }
  /**
   * Turn toward a world position (Vector3 / object / [x, y, z] / { x, y, z }).
   * The angle is computed from where the head is NOW (the followed body's current position + eye height), not from the last drawn frame,
   * so teleport-then-lookAt works in one go: `await engine.stream.teleport(p); engine.cameraRig.lookAt(target);`. The eye is also snapped there
   * (no easing up from the old height after a teleport). Call lookAt after the move, not before: yaw/pitch are angles, they do not follow later moves.
   * @example await engine.stream.teleport([10, 0, 4]); engine.cameraRig.lookAt([10, 1.5, -6]);
   * @param {any} position
   */
  lookAt(position) {
    const t = this.target?.position;
    if (t) this.eye.set(t.x, t.y + this.height, t.z);   // teleport moved the body; update() would only catch up on the next frame
    const { x, y, z } = vec3(position, this._look ??= new THREE.Vector3()), dx = x - this.eye.x, dy = y - this.eye.y, dz = z - this.eye.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  update(dt, input) {
    const cam = this.engine.camera;
    if (input.enabled) {
      const k = 0.0025 * this.sensitivity;
      this.yaw -= input.look.dx * k;
      this.pitch -= input.look.dy * k * (this.invertY ? -1 : 1);
    }
    if (this.yawLimits) this.yaw = Math.min(this.yawLimits[1], Math.max(this.yawLimits[0], this.yaw));
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
    if (this.target) {
      const p = this.target.position;
      // Walking bob: advance the phase by how far the character moved this frame
      let speed = 0;
      if (this._last && dt > 0) speed = Math.hypot(p.x - this._last.x, p.z - this._last.z) / dt;
      (this._last ??= new THREE.Vector3()).copy(p);
      if (this.headBob > 0) {
        this._bob += speed * dt * this.bobFrequency * Math.PI * 2;
        const want = Math.min(1, speed / 4) * this.headBob;
        this._bobAmp += (want - this._bobAmp) * (1 - Math.exp(-8 * dt));
      }
      const k = 1 - Math.exp(-this.smoothing * dt);
      this.eye.x = p.x; this.eye.z = p.z;
      this.eye.y += (p.y + this.height - this.eye.y) * k;
    }
    cam.position.copy(this.eye);
    cam.position.y += Math.sin(this._bob) * this._bobAmp;
    cam.rotation.set(this.pitch, this.yaw, Math.sin(this._bob * 0.5) * this._bobAmp * 0.15, 'YXZ');
  }

  /** Someone else's view shows while the camera is held: the mouse goes free and the body is back, since the eye it would block is no longer where the camera is */
  onOverride(on) {
    if (on) { releaseLock(this, true); this._unhide(); } else this._hide();
  }

  // also on every child added to the target (a held item, a swapped model): hide what is new
  _hide() { if (this.hideTarget && this.target && !this.engine.cameraOverride) this._hideTarget(); }
}

Object.assign(FirstPersonCamera.prototype, YAW_RIG, HIDE_RIG);   // forward / right / focusPoint; _hideTarget / _unhide / _shadowLayers

/**
 * First-person camera module. Installs engine.cameraRig (pick it or followCamera; switch at runtime with engine.setCamera('firstPerson')).
 * firstPersonCamera({ height: 1.6, sensitivity: 1, fov: 70, headBob: 0.04, hideTarget: true, pointerLock: true })
 */
export function firstPersonCamera(opts = {}) { return rigModule('firstPerson', opts); }
defineRig('firstPerson', (e, opts) => {
  return new FirstPersonCamera(e, opts);
}, ['height', 'sensitivity', 'fov', 'headBob', 'bobFrequency', 'hideTarget', 'hideLayer', 'pointerLock', 'yaw', 'pitch',
    'minPitch', 'maxPitch', 'yawLimits', 'smoothing', 'invertY', 'swallowLockClick']);
