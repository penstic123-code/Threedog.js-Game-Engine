# Stream sources: what is loaded where (teleport, far camera)

> **Covers:** stream sources: what is loaded around which point (teleport, far camera).
> **Use when:** the camera or the player jumps far away.
> **Shortest:** `await engine.stream.teleport([x, y, z])`.

Part of `18-world.md`: world records never unload; this page is about the models, terrain and colliders built around them.

Three things are kept apart: **what is shown** (terrain chunks, models, stream entries, hlod), **what has colliders** (rigid terrain colliders, chunk
collision), and **world data** (records and their near / far simulation, which follows `world.anchor` and never unloads). Every loader reads one
list, the sources of `engine.stream`:

| Source | Shows | Colliders |
|---|---|---|
| `engine.stream.player` (built in: `world.anchor`, else the player, else `engine.focus`) | full | yes |
| `engine.stream.camera` (built in: `engine.focus`) | full | no |
| `engine.stream.source(p, { radius, detail, physics, until })` | `detail: 'full'` (default) or `'simple'` (terrain and hlod proxies only) | `physics` (default true for `'full'`) |

```js fragment
// teleport: the player moves only after the destination's terrain, collision and nearby models are ready
// a new game or load during the trip abandons it: it rejects with code stream-removed and the player stays
await engine.stream.teleport([800, 0, 300]);

// the same by hand (for a door animation or a fade)
const dest = engine.stream.source([800, 0, 300], { radius: 64 });
await dest.whenReady;
engine.player.placeAt([800, 0, 300]);
dest.remove();

// a photo camera far away: a picture, no colliders; removed when photo mode ends
engine.stream.source(photoCam, { physics: false, until: () => !photoMode.active });

// a far view from a tower: terrain and hlod proxies only
const vista = engine.stream.source(towerTop, { detail: 'simple', radius: 600 });
```
- `radius` caps every loader's own range around that source (terrain view distance, present radius, `stream.radius`); without it each loader uses its own.
- `source.ready` is checked at the end of each frame, a new source after one full frame. Collision takes effect on a fixed tick: under `engine.haltLoop()`, step while waiting.
- `ready` means nothing is pending, not that everything built: a failed build is reported and left out, and `teleport` still lands. Need it built? Check
  `handle.built`, `engine.world.view(id)`. A failed terrain chunk (recipe 28) is different: no ground, never ready, `teleport` ends in `stream-timeout`.
- Leaving and coming back is safe: models unload, records (an opened chest, a removed rock) stay in `engine.world` and the models are rebuilt from them.
- After start, a stream entry bringing an undrawn material attaches after its compile, a task later (not in the
  same `engine.step`); `ready` waits. Unloading frees geometry and materials nothing else uses; textures are yours (`dispose`).
- A module's own distance-based loader reads `engine.stream.sources({ detail: 'full' })` / `sources({ physics: true })` and `s.reach(range)`, and
  registers `engine.stream.addReadyCheck(name, s => ...)`, never `engine.focus` or the player position.
