# engine.ground (GroundProvider) — Ground provider: whoever provides the ground height is the "terrain" (terrain module, level module, or the default flat y=0)

- `ground.height(x: number, z: number, refY?: number) → number` — Ground height (meters) at (x, z). For multi-layer ground (bridges, caves) pass refY: takes the highest layer not above refY + one step (0.45 m); without it the highest layer is used. Single-layer ground ignores refY. A game reads it with engine.surface(x, z)
- `ground.slope(x: number, z: number, refY?: number) → number` — Slope at (x, z) (height difference / horizontal distance). A game reads it with engine.slope
- `ground.type(x: number, z: number, refY?: number) → string` — Ground type at (x, z) (landform name, e.g. 'meadow'). A game reads it with engine.groundType
- `ground.water(x: number, z: number, refY?: number) → number` — Optional: water surface height at (x, z) when it differs per point (-Infinity = none); replaces waterLevel there. A game reads engine.waterAt
- `ground.has(x: number, z: number) → boolean` — Is there ground at (x, z). Always true except off the outline of terrain({ shape }), where height is -Infinity and slope 0. Example: `if (engine.ground.has(x, z)) engine.snapToGround(chest);`
- `ground.voidY() → number` — Height below which something has fallen out of the world (terrain:void): engine.terrain.voidY with terrain({ shape }), else -Infinity
- `ground.forEachCollider(x: number, z: number, range: number, fn: (cx, cz, r) => void)` — Optional: iterate the circular colliders (tree trunks etc.) within range meters of (x, z)
- `ground.viewRange() → number` — (experimental) Optional: how far (meters) the ground is shown around a stream source now; stream entries build within it by default (else engine.uniforms.uViewDistance)
- `ground.chunkCollision(cx: number, cz: number) → any` — (experimental) Optional: collision data of a chunk (used by the physics module)
- `ground.staticTrimeshes() → { positions, indices }[]` — (experimental) Optional: static triangle mesh (the level module provides it for physics)
- `ground.staticVersion() → number` — (experimental) Optional: version number of the static mesh; rebuild when it changes
- Properties:
  - `waterLevel: number` Global water level (meters); -Infinity when there is no water. A game reads engine.waterLevel
  - `chunkSize?: number` Optional: chunk edge length (meters)
