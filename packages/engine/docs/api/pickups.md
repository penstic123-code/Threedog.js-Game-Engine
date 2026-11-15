# engine.pickups — pickups(opts?: PickupsOptions)

pickups(). Things on the ground that go in the bag. Install: engine.use(world(), inventory(), interactions(), pickups()) (pickups are world records); undefined until installed. A full bag leaves the item on the ground

- Options `PickupsOptions`:
  - `radius?: number` Reach of pickups that do not set their own radius (meters), default 2
  - `showDistance?: number` (experimental) Pickups have a model, float and spin only within this distance (meters) of the stream sources, default 60
  - `takers?: (e: Engine) => string[]` Who walks into auto pickups (actor ids); default engine.actor, plus net peers on a host
  - `color?: ColorLike` Color of the placeholder box and geometry-only models when the pickup and its item set none, default 0xcccccc
  - `size?: number` Edge of the placeholder box (meters), default 0.25
  - `lift?: number` Height above the ground a pickup floats at (meters), default 0.4

## Methods and properties
- `pickups.spawn(position: PositionLike, opts: PickupOptions) → PickupHandle` — Place a pickup on the ground at position; its y, if any, is the reference height on multi-layer ground (needs the interactions module unless auto): spawn(v, { give: 'berry', count: 2 }). Returns a handle, remove() deletes it
- `pickups.nearest(item?: string | null, from?: PositionLike) → WorldRecord | null` — The data of the nearest pickup still on the ground to from (default engine.actorPosition()), of one item id or any; null if none
- Properties:
  - `radius: number` Reach of pickups that do not set their own (meters)
  - `takers: (e: Engine) => string[]` Who walks into auto pickups: default engine.actor plus net peers on a host, none on a client
  - `material: Material` The three.js material of every placeholder box and geometry-only model. Set it to swap all of them at once; used as given. A pickup with its own color or a vertex-colored geometry draws with a copy of it carrying that color. Example: `engine.pickups.material = new THREE.MeshStandardMaterial({ color: 0xffd24a, metalness: 0.8 })`
  - `size: number` Edge of the placeholder box (meters), read when one is built
  - `lift: number` (experimental) Height above the ground new pickups float at (meters)
