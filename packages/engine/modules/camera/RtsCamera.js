// Strategy-game camera (top-down / oblique 45 degree isometric feel): the camera looks at a point on the ground (the focus), and the player moves that point.
//   - Arrow keys / WASD pan (screen-relative), hold the mouse to drag-pan (grab the ground), mouse at the screen edge pans (edgePan)
//   - Wheel zooms (changes camera height); the actions rotateLeft / rotateRight turn it (no keys of its own: presets.bindings.rtsRotate binds Q / R)
//   - The focus always sticks to the ground (engine.surface); bounds limits the range
//   - screenToGround(ndcX, ndcY) -> ground point under a screen point (for click-to-move and placing buildings; every camera kind has it, common.js)
//   - After follow(object) the focus tracks it (done automatically when the player is created) and WASD goes to the character; manual drag/edge pan drops the follow (unless followLock: true)
//     To not follow: call engine.cameraRig.follow(null) after creating the player, and WASD pans the camera
// Cutscene takeover: while someone holds engine.takeCamera (engine.cameraOverride is not null) the camera is left alone (see common.js).
//
//   engine.use(rtsCamera({ height: 30, pitch: 0.95, panSpeed: 1, edgePan: true, bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 } }));
//   const p = engine.cameraRig.screenToGround(engine.input.pointer.ndcX, engine.input.pointer.ndcY);
//   engine.cameraRig.moveTo(position);   // move the view somewhere; { instant: true } skips smoothing
import * as THREE from 'three';
import { rigModule, defineRig, CAMERA_STRINGS, YAW_RIG, rigPlaced, inRange } from './common.js';
import { xzOf } from '../../core/base/math.js';
import { setFov } from '../../core/scene/view.js';
import { surfaceOr } from '../../core/scene/ground.js';

export class RtsCamera {
  /**
   * height camera height above the focus (zoom changes this); minHeight/maxHeight zoom range; pitch pitch-down angle (radians, pi/2 = straight down);
   * yaw initial horizontal facing; panSpeed pan speed multiplier (actual speed scales with height); dragPan drag-to-pan with the mouse;
   * edgePan pan at screen edges; edgeSize edge width (fraction of the screen); bounds { minX, maxX, minZ, maxZ } focus range;
   * rotate false: no turning (default true: the camera module declares the actions rotateLeft / rotateRight, which the game binds); rotateSpeed rotation speed (radians/second);
   * zoomStep zoom ratio per wheel notch; smoothing smoothness; fov field of view (unchanged if omitted); followLock disallow manual pan while following; start initial focus (position)
   */
  constructor(engine, { height = 30, minHeight = 8, maxHeight = 90, pitch = 0.95, yaw = 0, panSpeed = 1, dragPan = true, edgePan = false, edgeSize = 0.02,
    bounds = null, rotate = true, rotateSpeed = 1.8, zoomStep = 0.12, smoothing = 10, fov = null,
    followLock = false, start = null } = {}) {
    Object.assign(this, { engine, height, minHeight, maxHeight, pitch, yaw, panSpeed, dragPan, edgePan, edgeSize, bounds, rotateSpeed, zoomStep, smoothing, followLock });
    inRange(this, 'rtsCamera', 'rtsCamera()', 'height', height, ['minHeight', 'maxHeight'], true);   // a start outside the zoom range stays; the first wheel notch pulls it in
    this.target = null;
    this.following = false;
    const [sx, sz] = start ? xzOf(start) : [0, 0];
    this.focus = new THREE.Vector3(sx, 0, sz);
    this.focus.y = surfaceOr(engine, this.focus.x, this.focus.z);   // a start beyond the island keeps y = 0 instead of -Infinity
    this._f = this.focus.clone();                // smoothed focus
    this._h = height; this._yaw = yaw;
    this._drag = null;
    this._finePointer = matchMedia('(pointer: fine)');   // edge pan is for mice only: query once, read .matches per frame
    this.rotate = !!rotate;
    this.fov = fov;
    this._place();
  }

  /** Called when this camera is switched in (module install, setCamera): applies fov */
  onEnter() { if (this.fov) setFov(this.engine, this.fov); }
  /** Follow an object (called automatically when the player is created). While following, WASD moves the character; manual drag/edge pan drops the follow (not with followLock) */
  follow(obj) { this.target = obj; this.following = !!obj; if (obj) this.moveTo(obj); }
  /** Move the view somewhere; with instant true there is no smoothing */
  moveTo(position, { instant = false } = {}) { const [x, z] = xzOf(position); this.focus.set(x, 0, z); this._clamp(); if (instant) { this._f.copy(this.focus); this._place(); } }
  focusPoint() { return this._f; }

  update(dt, input) {
    const on = input.enabled;
    if (on) {
      const speed = this.panSpeed * (6 + this._h * 0.9);      // higher = faster pan
      let px = 0, pz = 0;
      // WASD: goes to the character while following; pans the camera otherwise
      if (!this.following) { const a = input.axis; px += a.x; pz += a.y; }
      // Edge pan (only while the mouse is inside the view)
      if (this.edgePan && !this._drag && this._finePointer.matches) {
        const e = this.edgeSize * 2, p = input.pointer;
        if (p.ndcX < -1 + e) px -= 1; else if (p.ndcX > 1 - e) px += 1;
        if (p.ndcY > 1 - e) pz += 1; else if (p.ndcY < -1 + e) pz -= 1;
      }
      if ((px || pz) && !(this.followLock && this.following)) {
        const f = this.forward(), r = this.right();
        this.focus.x += (f.x * pz + r.x * px) * speed * dt;
        this.focus.z += (f.z * pz + r.z * px) * speed * dt;
        this.following = false;                       // manual pan ends the follow
      }
      // Drag pan: remember the grabbed ground point on press, then keep it under the mouse
      if (this.dragPan && input.pointer.down && (!this.followLock || !this.following)) {
        const g = this.screenToGround(input.pointer.ndcX, input.pointer.ndcY);
        if (!this._drag) this._drag = g ? { grab: g, moved: false } : { grab: null };
        else if (g && this._drag.grab && (input.look.dx || input.look.dy || this._drag.moved)) {
          const dx = this._drag.grab.x - g.x, dz = this._drag.grab.z - g.z;
          if (Math.hypot(dx, dz) > 0.01) { this._drag.moved = true; this.following = false; }
          this.focus.x += dx; this.focus.z += dz; this._f.x += dx; this._f.z += dz;
          this._place();
        }
      } else this._drag = null;
      // Zoom, rotate
      if (input.look.zoom) this.height = Math.min(this.maxHeight, Math.max(this.minHeight, this.height * (1 + input.look.zoom * this.zoomStep)));
      if (this.rotate) {
        if (input.down('rotateLeft')) this.yaw += this.rotateSpeed * dt;
        if (input.down('rotateRight')) this.yaw -= this.rotateSpeed * dt;
      }
    }
    if (this.following && this.target) { this.focus.x = this.target.position.x; this.focus.z = this.target.position.z; }
    this._clamp();
    const k = 1 - Math.exp(-this.smoothing * dt);
    this._f.x += (this.focus.x - this._f.x) * k; this._f.z += (this.focus.z - this._f.z) * k;
    this._h += (this.height - this._h) * k;
    this._yaw += (this.yaw - this._yaw) * k;
    this._place();
  }

  _clamp() {
    const b = this.bounds;
    if (b) { this.focus.x = Math.min(b.maxX ?? Infinity, Math.max(b.minX ?? -Infinity, this.focus.x)); this.focus.z = Math.min(b.maxZ ?? Infinity, Math.max(b.minZ ?? -Infinity, this.focus.z)); }
  }
  _place() {
    if (this.engine.cameraOverride) return;   // a held camera has one writer: focus and _f are what lands at release (common.js)
    const cam = this.engine.camera, f = this._f;
    const g = this.engine.surface(f.x, f.z);
    if (g > -Infinity) f.y = g;                    // focus sticks to the ground; over the void of terrain({ shape }) it keeps its last height
    const a = Math.min(Math.PI / 2 - 1e-3, Math.max(0.05, this.pitch));
    const back = this._h / Math.tan(a);             // horizontal back-off distance
    cam.position.set(f.x + Math.sin(this._yaw) * back, f.y + this._h, f.z + Math.cos(this._yaw) * back);
    cam.lookAt(f);
    rigPlaced(this.engine);   // moveTo({ instant }) between frames is the engine's own write (common.js)
  }
}

// forward / right share YAW_RIG (focusPoint uses its own smoothed focus; the class definition above wins)
for (const k of ['forward', 'right']) RtsCamera.prototype[k] = YAW_RIG[k];

/**
 * Strategy top-down camera module. Installs engine.cameraRig (pick it or followCamera).
 * rtsCamera({ height: 30, pitch: 0.95, panSpeed: 1, edgePan: true, bounds }) + createEngine({ bindings: { ...presets.bindings.rtsRotate } })
 * Actions: rotateLeft / rotateRight (no keys of their own)
 */
export function rtsCamera(opts = {}) { return rigModule('rts', opts); }
defineRig('rts', (e, opts, input) => {
  e.i18n.add(CAMERA_STRINGS);
  // declared through the camera module's ctx (gone with the module); optional: the camera pans and zooms without them
  if (opts.rotate !== false) {
    input.define('rotateLeft', { label: 'camera.rotateLeft', optional: true });
    input.define('rotateRight', { label: 'camera.rotateRight', optional: true });
  }
  return new RtsCamera(e, opts);
}, ['height', 'minHeight', 'maxHeight', 'pitch', 'yaw', 'panSpeed', 'dragPan', 'edgePan', 'edgeSize', 'bounds', 'rotate',
    'rotateSpeed', 'zoomStep', 'smoothing', 'fov', 'followLock', 'start']);
