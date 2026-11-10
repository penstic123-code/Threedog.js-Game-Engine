# Camera: first / third person, top-down strategy, fixed shots, switched at runtime

> **Covers:** the four cameras (follow, first person, strategy, fixed), switching, framing, limits.
> **Use when:** choosing or tuning how the player sees the game.
> **Shortest:** `openWorld({ camera: 'firstPerson' })`.
> **Sections:** 1 Press V to · 2 What the engine · 3 Other common things · 4 Over the shoulder · 4b Looking up, ground · 4c Chase camera behind · 5 Take over the · 6 Orthographic view, and · 7 Your own camera

Four cameras; the kind names are always: `'follow'` third-person follow · `'firstPerson'` first person · `'rts'` top-down strategy · `'fixed'` fixed shots.
Pick one at the start: `openWorld({ camera: 'firstPerson' })`, or by hand `engine.use(followCamera({ distance: 10 }))` /
`firstPersonCamera({ height: 1.7 })` / `rtsCamera()` / `fixedCamera({ shots })`.
**There is exactly one entry point for changing camera in the game: `engine.setCamera(kind, options?)`**, no restart needed.

## 1. Press V to switch between first and third person (copy it)
```js
engine.input.define('toggleView', { label: 'Switch view', keys: ['KeyV'] });
engine.onFrame(() => {  // UI-type actions read pressed in onFrame
  if (!engine.input.pressed('toggleView')) return;
  engine.setCamera(engine.cameraRig.kind === 'follow' ? 'firstPerson' : 'follow');  // kind is the current kind
});
```
Starting in first person and switching later: `openWorld({ camera: 'firstPerson' })` can still `setCamera('follow')`; you don't need to install two cameras.

## 2. What the engine does for you when switching
- **Target and heading carry over** (the followed character and `yaw`; pitch is not, it means different things per camera).
- **First person hides the body but keeps the shadow**: the model moves to `hideLayer` (default 30), which the shadow camera still sees; a model loaded later too. A light the player carries (within one body width of the body) leaves the hidden body out of its shadow: recipe 34.
- **Mouse lock**: switching to first person by a key press locks the mouse, Esc leaves, switching away releases it. No lock on phones.
- **Field of view**: switching away returns to the value from install; first-person and strategy cameras set their own `fov` option.
- **Settings are kept**: switching back keeps the zoom and pitch; pass options to rebuild that camera with new ones:
```js
engine.setCamera('firstPerson', { height: 1.7, fov: 80 });
engine.setCamera('follow', { distance: 8, pitch: 0.3 });
```
- A wrong kind name throws and lists the valid ones; a wrong option name gets the closest name suggested in development.

## 3. Other common things
- **Which way yaw points**: first person and follow, yaw 0 looks toward -z, `Math.PI / 2` toward -x, `Math.PI` toward +z (forward = -(sin yaw, cos yaw)). Facing +z: `engine.cameraRig.yaw = Math.PI` (recipe 63 §7).
- **Cycling**: find `engine.cameraRig.kind` in a list of kinds, `setCamera` the next.
- **A fixed camera needs shots first**: `engine.setCamera('fixed', { shots: { hall: { position: [0, 6, 12], lookAt: [0, 0, 0] } }, start: 'hall' })`. A shot stays where it was placed; a view that pans at a fixed angle is the follow camera (section 6).
- **Camera-specific methods** exist only after switching: `engine.cameraRig.lookAt(position)` (first person), `cut('name')` (fixed shots),
  `screenToGround(...)` (rts). Check `kind` before calling.
- **Teleport, then lookAt**: `await engine.stream.teleport(p); engine.cameraRig.lookAt(target);` in that order: `lookAt` aims once from the body's current position.
- **Saves and new games**: a save holds the view (`yaw`, `pitch`), and `session.load` / `saves.load` put it back. A new playthrough rebuilds the installed camera on the same object: a kept `engine.cameraRig` stays valid (one from `setCamera` with options does not). A kind switched to with `setCamera` is not restored (only the heading carries): call `setCamera` again on `session:start` to keep the choice.
- **Cutscene takeover**: while anyone holds `engine.takeCamera(owner)` (`engine.cameraOverride` is not null) the camera module leaves the camera alone; see [the engine API](../api/engine.md).

## 4. Over the shoulder, lock-on framing, mouse lock (follow camera)
```js fragment
engine.use(followCamera({ distance: 3, shoulder: 0.7, pitch: 0.15, pointerLock: true }));  // shooter / action-adventure view
engine.cameraRig.shoulder = -0.7;  // switch shoulders at any time (plain property)
engine.cameraRig.frame(enemy.root);  // lock-on: turn to "behind the player, looking at the enemy"; frame(null) lets go
```
- **`shoulder`**: meters the aim point (and so the camera) moves to the right along `right()`; negative = left, 0 = centered (default).
- **`pointerLock`** (default false): a click on the canvas locks the mouse, so moving it turns the view with no dragging; Esc releases, and `engine.page.releaseLock()` releases from code without opening the pause menu. Not on phones. If the browser refuses the lock the camera falls back to dragging; `describe().camera.pointerLock` has `state` (`off` / `unsupported` / `waiting-click` / `requesting` / `locked` / `refused`), `covered` (what sits on the canvas centre and eats the click), `cameraOverride` (a takeover blocks locking) and `lastFailure { reason, agoSec }`; the text line shows the same.
  The press that locks is swallowed (no `Mouse0`, no click) so it cannot attack or fire; `swallowLockClick: false` delivers it.
  Leave it off when the mouse buttons are for UI or clicking the ground.
- **`yaw` is which side of the player the camera is on**: `camera = focus + (sin yaw, cos yaw) * distance`, looking along `forward() = -(sin yaw, cos yaw)`; prefer `frame(target)` to computing it.
- **`frame(target, { strength = 6 })`**: `target` is an Object3D or `{ x, z }`; call it once when the lock starts, not every frame. While framing,
  mouse / stick yaw is ignored and a `yaw` you write directly is pulled back, because `frame()` owns the heading; `frame(null)` hands it back.
  `forward()` turns with it, so camera-relative movement strafes around the target.
- Only the follow camera has `frame`, `shoulder` and `pointerLock`; check `engine.cameraRig.kind === 'follow'` after a runtime switch.

## 4b. Looking up, ground and walls, driving the view yourself (follow camera)
```js
engine.use(followCamera(presets.camera.thirdPersonAction));  // locked mouse, look up ~60° and down, ground shortens the arm, walls pull in
engine.use(followCamera({ minPitch: -0.9, ground: 'shorten' }));  // or the same idea on your own options
```
- **Pitch sign**: positive = the camera is above the look point looking down; **negative = looking up**. Looking up needs `minPitch < 0`.
- **`ground`** decides what happens when the camera would go below the ground:
  `'shorten'` slides it along the arm toward the player (the view direction is kept, so you really look up);
  `'raise'` lifts it straight up (the view direction changes: from flat ground you cannot look up);
  `'none'` leaves it; a function `facts => position | null` gets `{ position, lookPoint, dir, arm, distance, groundY, clearance, surface, rig }`.
  Default: `'shorten'` when `minPitch < 0`, otherwise `'raise'`.
- **Walls** (with `collision()` installed) pull the arm in at once and let it out slowly; the shortest arm is `collision({ cameraMin })` (default 1.5 m).
  **What blocks by default**: every `addCircle` / `addBox` / `addSegment` collider, over its footprint and up to its height, and every mesh registered
  with `engine.rays.addStatic(mesh, { occluder: true })` (`level()` registers its buildings and `col_` meshes). A mesh alone blocks nothing (a crown or eave past its collider lets the camera in): registering it stops the arm without a gameplay collider (it does
  join `engine.raycast`). `collision({ cameraOcclusion: 'colliders' })` tests colliders only.
  A content prop or template with `collide` blocks with its whole mesh, crown and eaves included, with no game code. A hand-written mesh stays opt-in: `addStatic(mesh, { occluder: true })`. In a level, `userData.occluder = false` on a node (or a parent) stops it blocking; a hidden mesh does not block (`col_` meshes do). `addStatic` skips `InstancedMesh` and `SkinnedMesh` (dev warns once; rays do not hit them): give them a collider or a plain stand-in mesh.
  Give the colliders the camera may pass through `occluder: false`
  (`engine.collision.addCircle(tree, { radius: 0.4, occluder: false })`, or `collide: { circle: 0.4, occluder: false }` / `occluder: false` on a content prop or template): walkers are still stopped, the arm ignores them. A dense forest of
  blocking trunks collapses the camera onto the player; `collision({ canopyHeight })` covers only the terrain's own trees.
- **Close-up**: when the camera ends up nearer than `hideTargetNear` (default 0.9 m) to the look point, the followed object is hidden from the
  camera (shadow stays, layer `hideLayer`); `hideTargetNear: 0` turns it off.
- **Drive the view from game code**: `engine.cameraRig.setView({ yaw, pitch, distance })` (clamped to the pitch / zoom ranges) and
  `getView()` → `{ yaw, pitch, distance, arm, lookPoint, look }` (`look` is the 3D view direction, `arm` the actual length this frame).
  With `mouseLook: false` the built-in mouse / stick look and wheel zoom are off and the game owns yaw and pitch (call `setView` every frame from `onFrame`).

## 4c. Chase camera behind a car
`addWheeled({ camera })` sets the follow camera's distance and height while seated, but the camera keeps its own yaw, so nothing swings the view behind the car. A racing view is a few lines of game code with `followCamera({ mouseLook: false })`:
```js fragment
let yaw = null;
engine.onFrame(dt => {
  const q = car.body.rotation();  // car: what addWheeled returned
  const want = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)) + Math.PI;  // a car drives along its +z; the view looks along -z at yaw 0
  yaw ??= want;
  yaw += Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)) * Math.min(1, 5 * dt);  // the shortest way round, catching up at 5 per second
  engine.cameraRig.setView({ yaw });
});
```

## 5. Take over the player: your own movement, facing and lock-on
The engine has no default here: `addPlayer` needs `control` (a preset such as `presets.player.thirdPerson` gives keys relative to the camera, Shift
run, Space jump, turning toward where it walks and `cameraFollow: true`). Each piece below replaces one part and keeps the rest (world record, saving,
`describe().player`).
```js fragment
import { pickTarget, switchTarget } from 'threedog';

// how the input steers the player: 'camera' (keys relative to the camera) | (player, input, dt) => ({ x, z, run? }) | null (stand still)
let lock = null, hitStun = 0, knockX = 0, knockZ = 0;
const player = engine.characters.addPlayer({ cameraFollow: true, faceMode: 'manual', control: steer });  // moveInput().run reads the bound 'run' action
engine.input.bind({ lockOn: ['KeyQ'], switchTarget: ['KeyR'] });  // no module binds a key by itself
const enemies = () => engine.world.query({ kind: 'enemy', near: player.position, radius: 20 });

function steer(player, input, dt) {  // called once per fixed step while the input is in charge of the player
  const m = engine.characters.moveInput();  // the 'camera' key direction as a value, relative to the camera (a reused object: copy x / z if you keep it)
  if (engine.input.pressed('lockOn')) {  // pick what is in view; press again to let go
    lock = lock ? null : pickTarget(player, engine.cameraRig.forward(), enemies(), { radius: 15 });
    engine.cameraRig.frame(lock ? engine.world.view(lock.id) : null);
  }
  if (lock && engine.input.pressed('switchTarget')) lock = switchTarget(player, engine.cameraRig.forward(), lock, enemies(), 1) ?? lock;
  player.faceMode = lock ? 'target' : 'move';  // 'move' toward velocity | 'camera' along the camera | 'target' toward faceTarget | 'manual' only face() turns it
  player.faceTarget = lock ? engine.world.view(lock.id) : null;
  if (hitStun > 0) { hitStun -= dt; player.push(knockX, knockZ, dt); return null; }  // knockback / roll: fixed velocity, never turns
  return m;  // the engine calls player.move() with it (one move per step)
}
```
- **`control`** is how the input steers the player: `'camera'` or a function. A function keeps jump and vehicles and only replaces direction
  and speed (a side-scroller returns `{ x: input.axis.x, z: 0 }`); to wrap the camera-relative keys use
  `control: (p, input) => busy ? null : engine.characters.moveInput()`. It is given once; for a while-it-lasts takeover (a scripted walk, a
  roll, a tutorial) take the player's control instead: `engine.control.take(player, { owner: 'roll', layer: 'script', step })`, then
  `h.remove()` gives the keys back (recipe 57). Calling `player.move()` yourself while the input holds it is `[control-bypass]`. Leaving
  `control` out throws `[player-control]`.
- **`cameraFollow: true`** points the camera module at the player (again after a vehicle and on a new session); without it the camera stays where the
  game puts it (`engine.cameraRig.follow(obj)`), and dev builds warn once if a camera is installed and the option was left out.
- **`faceMode`** is a plain property of every Character (NPCs too), change it per state. `player.face(angle)` turns at once (0 = +Z, PI / 2 = +X),
  `face(target)` toward a point; with `'manual'` that is the only thing that turns it.
- **`push(vx, vz, seconds)`** moves at a fixed velocity for that long, ignoring the direction given to `move()`; gravity and collision still apply.
  When you push again every fixed step, pass `dt`.
- **`pickTarget` / `switchTarget`** are pure functions: they return the candidate itself (anything with a `position`) or null. The game keeps the
  current target and its own rules, such as "let go beyond 20 m" or "target died, pick the next".
- The engine already calls `player.animate(dt)` every frame; a module with its own loop over characters must skip the player, or the walk cycle runs
  twice as fast.
- Test without a keyboard: `engine.input.simulate('lockOn'); engine.step(1 / 60); engine.input.simulate('lockOn', false)`.

## 6. Orthographic view, and taking the camera over yourself

**Orthographic (isometric / 2.5D) with the built-in rigs.** `projection: 'orthographic'` plus `size` (world units of view height) on the fixed and follow cameras.
The default stays perspective. On resize the view height stays `size` and the width follows the aspect.

```js fragment
// one fixed isometric shot (shorthand for a single shot named 'main')
engine.setCamera('fixed', { position: [14, 14, 14], lookAt: [0, 0, 0], projection: 'orthographic', size: 16 });
// per shot: shots: { hall: { position, lookAt, projection: 'orthographic', size: 12 }, yard: { position, lookAt } }  // yard stays perspective
// follow the player from a fixed angle
engine.setCamera('follow', { pitch: 0.6, yaw: 0.8, distance: 20, projection: 'orthographic', size: 14, mouseLook: false, ground: 'none' });
```
**A view that pans at a fixed angle** (isometric, tactics, city builders) is that follow camera, not a fixed shot. `mouseLook: false` stops the drag and the wheel from moving the view, and `ground: 'none'` stops hills from tilting it. It follows the player, or with no player any object the game moves:
```js fragment
const view = new THREE.Object3D();  // the point the view is centered on
engine.cameraRig.follow(view);  // again on 'session:start': a new playthrough follows the player or nothing
engine.onFrame(dt => { view.position.x += engine.input.axis.x * 12 * dt; view.position.z -= engine.input.axis.y * 12 * dt; });
```
`smoothing` sets how tightly the view keeps up (higher is tighter).

A `setCamera` before play (boot code, or with the title up) is the camera every playthrough starts from, the same as passing the options to the camera module. During play it is a switch: a new playthrough goes back.

- The option is a short way to the real thing below: the rig puts a real `THREE.OrthographicCamera` in `engine.camera`, and the next perspective view brings the camera it replaced back. Pose, `near`, `far`, `zoom`, layers, the parent and anything hung on the camera go with the view. So read `engine.camera` where you use it, and do not keep a copy across a switch.
- Blends between two orthographic shots blend `size`; a perspective/orthographic mix switches to the target's mode at once. Switching rig kinds returns to perspective.
- Limits: on the follow camera the mouse wheel changes `size` (clamped to the `minDistance`/`maxDistance` ratio of the starting `distance`).
  The `fov` slider in the settings menu has no effect. Cascaded shadows, `dof` and `outline` handle orthographic depth; a custom post pass that assumes perspective depth must do the same.

**Placing the camera yourself (cutscene, photo mode, your own rig).** Take it with `engine.takeCamera(owner, { focus })`; the camera module leaves the camera alone until you `remove()` the handle.
Several holders can take it (a cutscene, then a named view on top): the latest is in charge, and removing it hands the camera back to the previous one, not to nobody.

```js fragment
let t = 0;
const cam = engine.takeCamera('my-orbit', { focus: engine.player.position });  // focus (optional): where the world loads around
const frame = engine.onFrame(dt => {
  t += dt; engine.camera.position.set(Math.cos(t) * 12, 8, Math.sin(t) * 12); engine.camera.lookAt(0, 1, 0);
});
// done: frame.remove(); cam.remove();  // the rig resumes from its own state
```

To draw through your own three.js camera, assign it. A real `THREE.PerspectiveCamera` or `THREE.OrthographicCamera` is taken as it is, and any other class, a subclass too, is refused:

```js fragment
const original = engine.camera;
const ortho = new THREE.OrthographicCamera(-16, 16, 9, -9, 0.1, 500);
ortho.position.set(10, 10, 10); ortho.lookAt(0, 0, 0);
engine.camera = ortho;  // rendering, post, picking, shadows, audio and the camera module go on with it
// give it back: engine.camera = original;
```

The aspect follows the canvas, on assignment and on every resize: an orthographic camera keeps its height and its width follows. `engine.autoView.manual('aspect')` before assigning keeps your own frustum. The engine leaves `far` and `fov` of a real orthographic camera alone.
A camera module goes on placing the camera you assigned, and one assigned during a shot stays until the next view is asked for. `projection: 'orthographic', size` sets the height of a real orthographic camera; on a real perspective one the rig's own orthographic camera stands in until the next perspective view brings yours back. `pixelSnap` writes the height it needs. A chain taken with `engine.post.own()` is yours to point at the new camera; a `pixelGrid` you made keeps the camera you gave it.

**Side view (side-scroller).** `presets.player.sideScroller` moves the player along world X only (A / D, `z` stays) and turns it toward the move. Face the camera along -Z with `yaw: 0`, so +X is screen right (`yaw: Math.PI` looks from the far side and flips left and right), on `followCamera`:
```js fragment
engine.use(followCamera({ projection: 'orthographic', size: 15, yaw: 0, pitch: 0, lockPitch: true, distance: 40, ground: 'none', mouseLook: false }));
```

## 7. Your own camera module
Everything else in the engine reads only what `modules/camera/contract.js` lists from `engine.cameraRig`: `forward()` / `right()` (control: 'camera',
faceMode 'camera', targeting), `follow(object, opts?)` (addPlayer, getting in and out of a vehicle), `focusPoint()` (photo, where the world loads)
and `screenToGround(ndcX, ndcY)` (click-to-move, placing things; every built-in kind has it). A module named `cameraRig` with those five methods
replaces the built-in cameras: `tests/contract/fakeCamera.js` in the engine repository is one in ~35 lines and the player walks with it.
