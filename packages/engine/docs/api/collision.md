# engine.collision — collision(opts?: CollisionOptions)

Lightweight collision (collision() module): no clipping while walking, the camera is not blocked

- Options `CollisionOptions`:
  - `maxClimb?: number` Max walkable slope (height difference / horizontal distance), default 1.1
  - `canopyHeight?: number` A camera above this height (meters) is not considered blocked by trees, default 5
  - `cameraPad?: number` (experimental) Margin between the camera and obstacles (meters), default 0.5
  - `cameraMin?: number` Nearest camera distance (meters), default 1.5
  - `walkableWaterMargin?: number` (experimental) Height above the water surface (meters) at which it counts as walkable, default 0.2
  - `cameraOcclusion?: 'colliders' | 'meshes' | 'both'` What camera occlusion checks: 'both' (default) / 'colliders' / 'meshes' = static meshes registered with engine.rays.addStatic(mesh, { occluder: true })

## Methods and properties
- `collision.addCircle(position: PositionLike, opts?: CircleColliderOptions) → Handle` — Add a circle collider (pillar, campfire): position is the center, e.g. addCircle(mesh, { radius: 1 }). Returns a handle { remove() }
- `collision.addBox(position: PositionLike, opts?: BoxColliderOptions) → Handle` — Add a box collider (house, fence): position is the center, e.g. addBox(house, { halfWidth: 3, halfDepth: 2, rotation: 0.3 }). Returns a handle { remove() }
- `collision.addSegment(a: PositionLike, b: PositionLike, opts?: { thickness?, height?, y?, occluder?, layer? }) → Handle` — Add a thin wall along a -> b (fence). Options: thickness (default 0.3), height, y, occluder, layer (as in addBox). A gap between segments is a gate. Returns a handle { remove() }
- `collision.addBlocked(fn: (x: number, z: number) => boolean, opts?: { bounds? }) → Handle` — Mark ground impassable where fn(x, z) is true (river, lava); fn must be pure (no side effects, same answer for the same (x, z)); reading engine.ground in it is fine. findPathAsync caches the answers, so after the ground or your own state changes, remove() and add the field again. bounds { minX, maxX, minZ, maxZ } (world metres, the field's x / z extent) skips fn outside it; give it to keep findPathAsync's ground sampling cheap. Returns a handle { remove() }
- `collision.blockedAt(x: number, z: number, radius?: number) → boolean` — (experimental) Is a character of this radius touching addBlocked ground at (x, z)
- `collision.addObject(obj: Object3D, opts?: { pad?, occluder?, layer? }) → Handle` — Add a collider from an object's bounding box, pad expands outward (meters), occluder and layer as in addBox. Returns a handle { remove() }
- `collision.forEachStatic(fn: (type, data) => void)` — (experimental) Iterate all static colliders added by hand
- `collision.mirror(fns: { add, remove }) → { sync, clear, size }` — (experimental) Keep an outside copy of the static colliders in step (physics colliders, navmesh obstacles): add builds one piece, remove drops one; sync() diffs only when colliders changed and returns whether it compared; clear() forgets every piece without remove (the outside world was thrown away)
- `collision.walkable(position: PositionLike, opts?: { radius?, passes? }) → boolean` — Whether someone can stand at this position (for pathfinding): not in water, not too steep, not inside an obstacle. radius is the character radius (meters, default engine.movement.radius), passes the collider layers it goes through
- `collision.walkableAt(x: number, z: number, radius?: number, y?: number, passes?: readonly string[]) → boolean` — walkable with plain numbers, allocating nothing (A* inner loops); radius defaults to engine.movement.radius; y picks the floor; passes as in walkable
- `collision.lineClear(a: PositionLike, b: PositionLike, opts?: { radius?, who? }) → boolean` — Line of sight with height: is the 3D segment a -> b free of boxes, circles and terrain trees? radius fattens the line; addBlocked water is ignored. Give eye heights in a / b
- Properties:
  - `maxClimb: number` (experimental) 
  - `canopyHeight: number` (experimental) 
  - `cameraPad: number` (experimental) 
  - `cameraMin: number` (experimental) 
  - `walkableWaterMargin: number` (experimental) 
  - `cameraOcclusion: 'colliders' | 'meshes' | 'both'` (experimental) What camera occlusion checks (see CollisionOptions.cameraOcclusion)
  - `version: number` (experimental) +1 each time a static collider is added or removed

## Data structures
- **CircleColliderOptions** Parameters of addCircle() (meters)
  - `radius?: number` Radius, default 0.5
  - `height?: number` Height, default 6
  - `occluder?: boolean` false: walkers are still stopped but the follow camera's occlusion check ignores it (forest trunks the camera may pass through). Default true
  - `layer?: string` A name: movers whose passes list names it go through it (walking, paths, navmesh), every other mover is stopped, e.g. a gate only some characters use. Omitted: it stops every mover. Sight lines and the camera ignore it
- **BoxColliderOptions** Parameters of addBox() (meters, radians)
  - `halfWidth?: number` Half width (X direction), default 1
  - `halfDepth?: number` Half depth (Z direction), default 1
  - `rotation?: number` Rotation around the Y axis (radians), default 0
  - `height?: number` Height, default 6
  - `y?: number` Bottom height of the box; if omitted it sits on the ground (give it for walls placed on platforms in a level)
  - `occluder?: boolean` false: walkers are still stopped but the follow camera's occlusion check ignores it (forest trunks the camera may pass through). Default true
  - `layer?: string` A name: movers whose passes list names it go through it (walking, paths, navmesh), every other mover is stopped, e.g. a gate only some characters use. Omitted: it stops every mover. Sight lines and the camera ignore it
