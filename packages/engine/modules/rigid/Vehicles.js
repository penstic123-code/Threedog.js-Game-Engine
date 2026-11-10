// Wheeled vehicle: Rapier ray-cast vehicle controller (DynamicRayCastVehicleController). The chassis is a dynamic body; wheels are downward rays + suspension.
// Named addWheeled (not addVehicle) because it is one kind: boats, horses, mechs and gliders are the game's own objects with the same seat interface.
// Convention: the front faces the model's +Z (like characters); wheel position is relative to the chassis origin.
//
// const car = engine.rigid.addWheeled(carMesh, { wheels: [
//   { position: [-0.8, 0, 1.2], radius: 0.35, steer: true, object: wheelFL }, { position: [0.8, 0, 1.2], radius: 0.35, steer: true },
//   { position: [-0.8, 0, -1.2], radius: 0.35, drive: true }, { position: [0.8, 0, -1.2], radius: 0.35, drive: true } ], mass: 800 });
// engine.player.enter(car);   car.drive(throttle, steer, brake)
// Native objects: car.body (rigid body), car.controller (vehicle controller).
import * as THREE from 'three';
import { vec3 } from '../../core/base/math.js';
import { ownBox } from './RigidBodies.js';

export const VEHICLE_KEYS = ['id', 'wheels', 'mass', 'engineForce', 'brakeForce', 'maxSteer', 'suspension', 'seats', 'hideDriver', 'camera', 'size', 'friction', 'exitOffset'];
export const STRINGS = { 'zh-CN': { 'vehicle.enter': '上车', 'vehicle.exit': '下车' }, en: { 'vehicle.enter': 'Get in', 'vehicle.exit': 'Get out' } };

/** Chassis box, wheels excluded and meshes only (a sprite, points or line on the car, like a name tag or glow, is no chassis): the box of a body from its model (ownBox, RigidBodies.js), so a vehicle and a plain body measure alike */
const bodyBox = (mesh, wheelObjs) => ownBox(mesh, o => { if (!o.isMesh) return true; for (let x = o; x; x = x.parent) if (wheelObjs.has(x)) return true; return false; });

/** Create a vehicle (called by RigidBodies.addWheeled) */
export function createVehicle(rigid, mesh, { wheels, mass = 800, engineForce = 800, brakeForce = 20, maxSteer = 0.5, suspension = {}, seats, hideDriver = true, camera, size, friction = 1.5, exitOffset = 0.8 }, id) {
  const e = rigid.engine, R = rigid.rapier, w = rigid.world;
  const box = bodyBox(mesh, new Set(wheels.map(x => x.object).filter(Boolean)));
  const s = size ? new THREE.Vector3().fromArray(size) : box.getSize(new THREE.Vector3()), c = size ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const entry = rigid._add(mesh, R.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setTranslation(c.x, c.y, c.z), { id, mass, friction: 0.5, damping: 0.1, angularDamping: 0.5 });
  const ctl = w.createVehicleController(entry.body);
  ctl.indexUpAxis = 1; ctl.setIndexForwardAxis = 2;   // up = Y, forward = Z
  const { rest = 0.3, stiffness = 30, damping = 4 } = suspension;
  wheels.forEach((wh, i) => {
    const at = vec3(wh.position);
    ctl.addWheel({ x: at.x, y: at.y, z: at.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, wh.radius);
    ctl.setWheelSuspensionStiffness(i, stiffness);
    ctl.setWheelSuspensionCompression(i, damping);
    ctl.setWheelSuspensionRelaxation(i, damping);
    ctl.setWheelFrictionSlip(i, friction * 10);
    ctl.setWheelMaxSuspensionTravel(i, rest);
    if (wh.object) wh._base = wh.object.position.clone();
  });
  const drives = wheels.filter(x => x.drive).length || wheels.length;
  // seat 0 drives, the rest ride; without seats one driver seat at the chassis center
  const seatAt = seats?.length ? seats.map(p => vec3(p)) : [new THREE.Vector3(c.x, c.y, c.z)];
  let throttle = 0, steerIn = 0, brake = 0, useFrom;

  const v = Object.assign(entry, {
    controller: ctl, wheels, driver: null, camera, hideDriver, seats: seatAt.length, passengers: [],
    /** Control: throttle -1..1, steer -1..1 (right positive), brake 0-1 */
    drive(t, st, b = 0) { throttle = t; steerIn = st; brake = b; if (t || b) entry.body.wakeUp(); },
    /** World position of a seat (0 = driver) */
    seatPosition(seat = 0) { return mesh.localToWorld((seatAt[seat] ?? seatAt[0]).clone()); },
    /** Exit n of a seat, null past the last: exitOffset meters (default 0.8) outside its own door, the other door, behind, in front */
    exitPosition(seat = 0, n = 0) {
      const a = seatAt[seat] ?? seatAt[0], x = (a.x >= c.x ? 1 : -1) * (s.x / 2 + exitOffset), z = s.z / 2 + exitOffset;
      const at = [[c.x + x, a.z], [c.x - x, a.z], [c.x, c.z - z], [c.x, c.z + z]][n];
      return at ? mesh.localToWorld(new THREE.Vector3(at[0], c.y, at[1])) : null;
    },
    /** Every fixed step: write controls to the wheels and advance the vehicle controller (called before the physics step) */
    _update(dt) {
      if (useFrom !== e.interactions) offerSeat();
      wheels.forEach((wh, i) => {
        ctl.setWheelEngineForce(i, wh.drive || drives === wheels.length ? throttle * engineForce / drives : 0);
        ctl.setWheelSteering(i, wh.steer ? -steerIn * maxSteer : 0);
        ctl.setWheelBrake(i, brake * brakeForce);
      });
      ctl.updateVehicle(dt);
    },
    /** After the physics step: wheel models follow suspension travel, steering and rolling */
    _sync() {
      wheels.forEach((wh, i) => {
        if (!wh.object) return;
        const o = wh.object;
        o.position.copy(wh._base); o.position.y -= (ctl.wheelSuspensionLength(i) ?? rest) - rest;
        o.rotation.set(ctl.wheelRotation(i) ?? 0, ctl.wheelSteering(i) ?? 0, 0, 'YXZ');
      });
    },
  });
  /** Current speed (m/s, negative when reversing): chassis velocity component along the front direction (0 when asleep) */
  const fwd = new THREE.Vector3(), q = new THREE.Quaternion();
  Object.defineProperty(v, 'speed', { get: () => {
    const b = entry.body; if (b.isSleeping()) return 0;
    const l = b.linvel(); fwd.set(0, 0, 1).applyQuaternion(q.copy(b.rotation()));
    return l.x * fwd.x + l.y * fwd.y + l.z * fwd.z;
  } });
  // With the interactions module installed: press the interact key near the car to get in, and again while driving to get out
  const offerSeat = () => {
    v._use?.remove(); v._use = null;
    useFrom = e.interactions;   // the use lives in that module: another one starts empty, so _update offers the seat again
    if (!e.interactions) return;
    v._use = e.interactions.add(mesh, {
      id: v.id,
      label: () => e.t(e.player?.vehicle === v ? 'vehicle.exit' : 'vehicle.enter'), radius: Math.max(3, s.z / 2 + 1.5),
      // in it: get out; else get in while a seat is free (driver first, then passenger seats)
      enabled: () => !!e.player && (e.player.vehicle === v || !v.driver || v.passengers.length < v.seats - 1),
      onUse: () => e.player.vehicle === v ? e.player.exit() : e.player.enter(v),
    });
  };
  offerSeat();
  v._seatBook = e.characters?.addVehicle(v);   // after the use: a rider seated here finds a finished vehicle
  return v;
}
