# Physics: rigid bodies, pushing, joints, vehicles

> **Covers:** rigid bodies, pushing, joints, vehicles, boarding and driving, ragdolls.
> **Use when:** crates that tumble, doors on hinges, a car or a boat.
> **Shortest:** `engine.rigid.addBox(mesh, { id })` with `rigid()` installed (§3).
> **Sections:** 1 Build a car · 2 Boarding and driving · 3 Rigid bodies saves · 3b Ragdoll experimental) · 4 Verify

Any physics body (crates the player pushes, balls, doors on hinges, ropes): §3, read it first when the game has no car. Cars and
boarding: §1–2.

Required modules: `collision()` + `rigid()` (Rapier physics; the vehicle controller lives there) + `characters()`. With
`interactions({ ...presets.interactions.nearest })` installed, a "board/exit" prompt (E key) appears automatically near a vehicle.
Convention: **the front of the car faces the model's +Z**, and a wheel's `position` is relative to the body origin (meters). Rapier has to be
downloaded and initialized, so build the car after `engine:ready`.

## 1. Build a car (main.js)
```js
import { presets, THREE } from 'threedog';

function makeCar() {
  const car = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), new THREE.MeshLambertMaterial({ color: 0xc04a3a }));
  body.position.y = 0.3; body.castShadow = true; car.add(body);
  const wheels = [[-0.85, 1.2, true, false], [0.85, 1.2, true, false], [-0.85, -1.2, false, true], [0.85, -1.2, false, true]].map(([x, z, steer, drive]) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 10).rotateZ(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    w.position.set(x, 0, z); car.add(w);  // wheels are children of the body: they follow suspension, steering and rolling
    return { position: [x, 0, z], radius: 0.35, steer, drive, object: w };
  });
  return { car, wheels };
}

engine.events.on('engine:ready', () => {
  const { car, wheels } = makeCar();
  car.position.set(10, engine.surface(10, 0) + 1.5, 0);  // place it slightly above the ground and let it drop
  const v = engine.rigid.addWheeled(car, { wheels, mass: 600, engineForce: 3000, camera: { distance: 14, height: 2 } });
  window.car = v;  // handy for tests and the console
});
```
Options: `../api/rigid.md` (VehicleOptions). `id` is the stable id saves use (default `vehicle1`, `vehicle2`... in creation order; give one when that order varies).
Rigid bodies and vehicles do not change a model's shadow settings: set `mesh.castShadow = true` yourself if you want a shadow.

## 2. Boarding and driving
- Player: press E near the car to board (when interactions is installed); while driving, WASD = throttle/steering; the brake key (action `brake`, only
  when the game gives one: `engine.input.bind(presets.bindings.brake)` is B / gamepad LT, or `engine.input.bind('brake', ['KeyX'])`; keep it off Space so
  it doesn't compete with jumping) brakes, and without one the engine warns once; press E again to exit.
- Saving: the player save records which vehicle the player is in (its `id`); loading an on-foot save while driving exits the vehicle first, and
  loading a driving save puts the player back in the car.
- Code: `engine.player.enter(v)`, `engine.player.exit()` (takes the first walkable exit of `exitPosition(seat, n)`; none: answers `false` and the rider stays, `exit({ force: true })` always gets out); `engine.player.vehicle` is the vehicle being driven (null when on foot); `v.driver` is who is driving, `v.passengers` who rides, `character.seat` the seat (0 drives; a second `enter` takes a free passenger seat, which does not steer). Placing a rider (`placeAt`, a teleport, a write to its record's position) ends the ride, as `exit()` does; to take it along, move the vehicle.
- NPCs/scripts driving: `v.drive(throttle -1..1, steer -1..1 (right is positive), brake 0-1)`; the last values set are used on every fixed step.
- Events: `vehicle:enter`, `vehicle:exit` (`{ character, vehicle }`). Removal: `v.remove()` (anyone inside exits first; the model stays,
  `engine.remove(car)` deletes it).
- Native objects: `v.body` (Rapier rigid body), `v.controller` (vehicle controller), `v.speed` (m/s, negative when reversing).

## 3. Rigid bodies: saves, joints, determinism
This section covers every `engine.rigid` body (crates, balls, hulls, vehicles), not only cars.

**Pushing bodies with the player.** Yes, with any mover: with `rigid()` installed the player carries a kinematic capsule
(`rigid.playerBody`) that follows it every fixed step, so walking into a dynamic body (`addBox(mesh, { mass })`, `addBall`, `addHull`) shoves it
ahead. The mover leaves dynamic bodies out of its own collision, so a body is pushed instead of stopping the player; how hard it resists is
its `mass` and friction. A body that should stop the player is `{ fixed: true }` with `mover: 'rapier'` (that mover collides with fixed bodies).
A puzzle reads the result from the body (`entry.body.translation()` in `onFixed`, or a trigger zone) and gives the body an `id`, so a save keeps
where it was pushed. Test: `threedog test "rigid push"` (both movers).

**Far bodies freeze.** On chunked terrain only the chunks within `rigid({ terrainRing })` of the player (default 1 ring) have terrain colliders. A
body outside them stops (`entry.enabled` is false, `describe().rigid.frozen` counts them) instead of falling through the ground, and goes on when
the player comes near. A body that must keep moving out there, such as a rival car on a long track, needs a larger ring: `rigid({ terrainRing: 6 })`;
each ring adds colliders. In dev the first moving body that freezes warns once.

**Saves.** A body added with an `id` (`rigid.addBox(mesh, { id: rec.id })`; vehicles always have one) is saved with its pose, rotation,
velocities and sleep, and a load gives that state back to the body with the same id, also when it is built after the load (a world presenter's
`build`). A body without an id is not saved: after a load it is wherever its record (or your code) puts it, upright and at rest.

**Joints** (hinges, doors, ropes, chains) are plain Rapier on engine bodies; the engine has no wrapper. `R.world` is the Rapier world and `entry.body` the Rapier body. newGame and a load rebuild the physics world (physics starts over like a fresh
page) and free the old world's joints with it; the engine does not copy them. It emits `rigid:rebuilt` once the bodies are back, and that is
where a game re-creates its joints, with the same code that made them:
```js fragment
const R = engine.rigid, J = R.rapier.JointData;
const post = R.addBox(postMesh, { fixed: true }), door = R.addBox(doorMesh, { mass: 8 });
function hang() {  // makes the joints; called after the bodies are added, and again after every rebuild
  // hinge on the post's right edge, turning around Y; anchors are in each body's local space
  const h = R.world.createImpulseJoint(J.revolute({ x: 0.5, y: 0, z: 0 }, { x: -0.5, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), post.body, door.body, true);
  h.setLimits(-1.5, 1.5);
  R.world.createImpulseJoint(J.rope(2, { x: 0, y: -0.5, z: 0 }, { x: 0, y: 0.5, z: 0 }), hook.body, weight.body, true);
}
hang();
engine.events.on('rigid:rebuilt', hang);  // { world, player, bodies }: bodies maps the ids you gave addBox / addBall / addHull
```
`entry.body` already points at the rebuilt body there; a joint object kept from before belongs to the freed world (hold the new one). A body
the game made with `world.createRigidBody` is not rebuilt: make anchors with `addBox(mesh, { fixed: true })`. In development a `rigid-misuse`
warning names a rebuild that dropped joints when none was re-created by the next step. Joints are not saved: on a load, bodies a presenter's
`build` adds come back after the event, so create their joints in that `build`. With a vehicle present the world is kept (no event, joints
stay). Removing a body removes its joints (Rapier does that).

**Determinism**, the one place this is stated (replay, `engine.step`, saves and net link here):
- Same build, same machine, same inputs and the same number of fixed steps give bit-identical bodies, in a fresh page and at any frame rate.
  Physics only advances in fixed steps. Test: `threedog test "rigid determinism"`: stacked boxes knocked over, a rolling ball, a driving car, the
  `mover: 'rapier'` player, two fresh pages, `frameEvery` 1 / 2 / 4.
- A load restores each saved body exactly. Rapier's contact and warm-start caches and its solver order are not saved, so the run after a load
  is not bit-identical to the run that went on without the load: a toppling stack can end some centimetres away. Bodies at rest stay at rest.
- Across machines: the engine uses `@dimforge/rapier3d-compat`, which Rapier does not promise to be cross-platform deterministic (that is the
  separate `rapier3d-deterministic` build). Two machines can drift apart. The net module does not depend on matching physics: the host owns the
  state, and physics is not synced (each machine simulates its own bodies).

## 3b. Ragdoll (experimental)

```js fragment
const rd = engine.rigid.ragdoll(enemy, { impulse: [0, 150, -400], position: hit.point });  // a Character, NPC handle, id or skinned Object3D
engine.clock.after(4, () => rd.remove(), { channel: 'real' });  // back to animation where the body lies; a get-up clip is yours to play
```
- **Skeletons.** Mixamo, Blender, Unreal, Bip01, VRM and Quaternius names are read by themselves. Otherwise name the parts: `{ bones: { lowerLegL: 'Shin_01' } }`; an unreadable skeleton throws, naming the missing parts.
  Parts: `hips chest head upperArmL lowerArmL upperArmR lowerArmR upperLegL lowerLegL upperLegR lowerLegR`.
- **Limits** are `[min, max]` radians from the bind pose, per part or kind: `{ limits: { lowerLeg: { bend: [0, 2] } } }`. `bend` is forward (a knee: backward), then `side` and `twist`.
- **The bones stay plain three.js.** Each fixed step writes rotations, and hips' position only, so bones keep their length. Attach things with `character.onPose`. Once `rd.settled`, nothing is written and your bone writes stay. Hands, feet and bones between parts keep their pose.
- **One owner.** While limp, control is held on the layer `physics` (recipe 57), the animator writes nothing, the capsule is off, the camera follows the hips, `state` is `'ragdoll'` and `root` follows the body. `remove()` gives each back; a camera you moved stays moved. In a vehicle it throws: `exit()` first. `placeAt`, or a write to its record's position, carries the whole body there at rest, still limp. A mixer you made yourself is yours to stop.
- **Physics.** One rigid body per part (`rd.parts.head.body`; ray hits carry the bone in `object`), so buoyancy and ground freezing apply. Parts do not collide with each other, nor ragdolls with one another.
- **Not saved.** A load or new game ends it. A world rebuild without a load keeps it and re-creates its joints on `rigid:rebuilt`. Deleting the character frees everything.
- **Collision on three axes.** `engine.collider3d` is the slot rigid holds: `addSolid({ position, size | radius, rotation })` puts a fixed solid at any tilt, `overlap(position, radius)` and `sweep(from, to, radius)` answer for a flying mover or a path source. `engine.collision` does not know these solids, so walkers on the simple mover pass through. A game's own provider passes `modules/rigid/collider3d.contract.js` and takes the slot with `engine.use(mine(), { replaces: 'collider3d' })`.
- **Not a human.** The rule `ragdoll.graph` says what the parts are. The default `'humanoid'` is a physics helper that reads the 11 parts from bone names, not a choice of body for your game; every other body plan passes its own graph, one part without a parent, the rest hanging from it:
  ```js
  engine.mod('ragdoll.graph', { owner: 'game', id: 'wolf', set: {
    body: { bone: 'Spine', mass: 20 },
    head: { bone: 'Head', parent: 'body', mass: 4 },
    legFL: { bone: 'FrontL', parent: 'body', kind: 'leg', forward: [0, 0, 1] },
    tail: { bone: 'Tail1', parent: 'body', limits: { bend: [-1, 1], side: [-1, 1] } },
  } });
  ```
  Without `id` it covers every body; a function `(facts, engine) => graph` picks per body; `false` makes `ragdoll()` return null.
- **Left out:** partial or blended ragdoll (an arm thrown by a hit while the rest animates); `remove()` cuts to the animation.

## 4. Verify
- In a test (no real key presses): `engine.player.enter(car); engine.input.autopilot = { x: 0, y: 1 }; engine.step(3)`,
  then `describe().player.vehicle.speed` is above 0 and the car has moved; after `engine.player.exit()`, `engine.player.vehicle` is null and the
  player stands outside the door.
- Vehicle speed is only in the object form `engine.describe().player.vehicle` (the player line of describeText does not show it);
  `describe().player.mover` and `grounded` are there too.

A load seats a rider by vehicle id and seat. Your own vehicle joins with `engine.characters.addVehicle(boat)`, before or after the load.
