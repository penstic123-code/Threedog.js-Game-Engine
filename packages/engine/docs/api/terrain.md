# engine.terrain — terrain(opts?: TerrainOptions)

Procedural terrain, data part (terrain() module: chunks, heights, edits, collision)

- Options `TerrainOptions` (also includes the fields of Partial<TerrainConfig>):
  - `viewChunks?: number` View distance (in chunks), default 4
  - `density?: number` Vegetation density multiplier, default 1
  - `viewFog?: boolean` true: the signal engine.uniforms.uViewDistance follows the view distance, so a game's fog can read it and fade the far chunk edge out (openWorld() sets true)
  - `part?: boolean` true: do not take the ground slot; compositeGround({ parts: [{ of: 'terrain' }] }) does and reads terrain.ground (so a terrain and a level can both run)
  - `material?: Material | ((engine: Engine) => Material)` Ground material (default neutral gray with vertex colors); chunks have position, normal, color and uv = world xz / chunk size. Cloud shadows, season tint and detail are added
  - `effects?: boolean` With material: false = draw it exactly as given, no cloud shadow / season / detail patch
  - `detail?: MaterialDetail | null` Detail layer over the ground: a noise, a texture asset name or your own glsl; defaults scale 0.25, strength 0.35, top-down world projection, multiply. Change it with engine.terrain.recolor({ detail })
  - `variation?: TerrainVariation` Ground color noise, baked into the chunks
  - `seed?: number` Random seed; the same seed gives the same terrain
  - `chunkSize?: number` Chunk edge length (meters), default 64
  - `resolution?: number` Cells per chunk; smaller is more "low poly", default 16
  - `waterLevel?: number` Water level (meters), default -Infinity = no water (terrainPreset() from
  - `flatten?: FlattenZone[]` Flattened plots
  - `biomeColors?: Record<string, string[]>` Ground type → palette color names (two are blended by noise); a type left out is neutral gray
  - `steep?: SteepRule[]` Steep-slope color rule
  - `heightmap?: { url?, size?, min?, max?, center?, outside?, … } | null` Heightmap (used when there is no height function): url grayscale image, size [width m, length m], min/max height (meters), center [x, z]
  - `height?: ((x, z, n) => number) | string | null` Height generator: (x, z, n) => meters. Without one (and without a heightmap) the ground is flat at y = 0, a placeholder (dev warning). Runs in workers, so it must be pure (only its parameters and globals like Math); an outside variable throws at terrain() naming it. n = { fbm(x, z, octaves?), noise(x, z), hash(x, z, salt?), seed, waterLevel, params }. Example: `terrain({ height: (x, z, n) => 4 + 12 * n.fbm(x * 0.01, z * 0.01) })`
  - `groundType?: ((x, z, h, slope, n) => string | null) | string | null` Ground type: (x, z, h, slope, n) => type name (null = 'default'). Pure, like height. Colors come from biomeColors[type]; vegetation rules and footsteps match by name. Example: `terrain({ groundType: (x, z, h, slope) => slope > 0.7 ? 'rock' : h < 2 ? 'beach' : 'grass' })`
  - `params?: Record<string, any> | null` Plain data handed to height / groundType as n.params (a preset's settings); must be serializable
  - `shading?: 'flat' | 'smooth' | 'texture'` How the ground gets its color: 'smooth' (default) blended per grid point / 'flat' one color and normal per triangle (low poly) / 'texture' per-chunk color map sampled per pixel, so color borders (a river bank) are not confined to triangle edges and the mesh can stay coarse. See recipes/53-ground-up-close.md.
  - `colorResolution?: number` Texture shading: color map pixels per chunk edge (default 128, 64 on low-tier devices; independent of `resolution`)
  - `normals?: 'smooth' | 'flat' | null` Texture shading only: lighting normals 'smooth' (default) / 'flat'
  - `normalFn?: ((i, j, h, cell) => number[]) | string | null` Replace the smooth normal at grid point (i, j): (i, j, h, cell) => [nx, ny, nz] (any length; the engine normalizes). h(i, j) is a grid-point height, cell the grid spacing in meters. Pure, like height (workers get its source). Default: central difference of the neighbors. Example: `terrain({ normalFn: (i, j, h, cell) => [(h(i - 1, j) - h(i + 1, j)) / (2 * cell), 2, (h(i, j - 1) - h(i, j + 1)) / (2 * cell)] })   // flatter lighting`
  - `diagonal?: 'fixed' | 'adaptive' | 'alternate'` How each cell is cut into two triangles: 'fixed' (default, the same diagonal everywhere) / 'adaptive' (along the diagonal with the smaller height difference, fewer zigzag ridges on slopes) / 'alternate' (flips every other cell). It is shape: engine.surface follows it
  - `boundsPad?: { up?: number; radius?: number }` Chunk bounding sphere margin in meters (default { up: 3, radius: 8 }): center raised by `up`, radius grown by `radius`. Raise it when a shader moves vertices far
  - `shape?: TerrainShape | null` World outline (default null = ground everywhere): an island, a floating rock, a coastline that ends
  - `colors?: Record<string, ColorLike>` Palette: color name → color

## Methods and properties
- `terrain.recolor(o?: TerrainRecolor)` — Change at run time what terrain({...}) baked in. colors, biomeColors, steep, variation, shading, normals rebuild every chunk (edits stay); detail only patches the engine's material. Throws under a draw part that replaced 'terrain-draw'. Example: `engine.terrain.recolor({ colors: { grass: 0x6a8a3a }, biomeColors: { meadow: ['grass'] } });`
- `terrain.view(hooks: { add?, change?, remove?, show? }) → { remove(): void }` — Draw these chunks: the hooks a draw part that replaces 'terrain-draw' uses. add(c): generated (c.data holds pos / nor / col / uv / tex arrays, c.cx / c.cz the chunk); change(c): an edit rewrote c.data (the vertex count can differ on the rim of a shape with diagonal 'adaptive'); remove(c): released; show(c, visible): in view or not. Chunks already loaded are added at once. Returns { remove() } (ctx.track it). Example: `ctx.track(engine.terrain.view({ add(c) { draw(c) }, remove(c) { undraw(c) } }))`
- `terrain.retry() → number` — Send chunks that failed every try (terrain:chunkFailed) again, e.g. after fixing what their rule reads. Returns how many were queued
- `terrain.rebuild()` — Rebuild all chunks
- `terrain.edit(position: PositionLike, opts: TerrainEditOptions) → { heights: number; cells: number }` — (experimental) Change the ground: dig, raise, flatten, paint the ground type. Saved gameplay state: call it from an op or a fixed step. engine.surface / slope / groundType, collision, paths and vegetation follow at once; it is saved, and chunks generated later come out edited. Example: `engine.terrain.edit(pos, { radius: 3, lower: 1.5 });                                                   // dig a pit engine.terrain.edit(pos, { shape: 'square', radius: engine.terrain.cellSize / 2, paint: 'tilled' });  // till one cell`
- Properties:
  - `generator: TerrainGen` Pure-computation terrain (height, landform), what createTerrain() returns
  - `material: Material | null` The plain three.js material every chunk draws with (null under a draw part that replaced 'terrain-draw'). The neutral one takes direct writes; setting one swaps it on every loaded chunk and draws it as given. Nothing is regenerated, collision is untouched. Chunks carry position, normal, color and uv (world xz / chunk size). Example: `engine.terrain.material = applyEffects(new THREE.MeshStandardMaterial({ vertexColors: true }), { patches: engine.terrain.patches });`
  - `patches: ShaderPatch[]` The engine's ground patches (world, clouds, season, detail), so a game material keeps them: applyEffects(mat, { patches: engine.terrain.patches })
  - `uniforms: Record<string, { value: any }>` The detail layer's { value } uniforms, written directly and live: uDetailStrength, uDetailScale, uDetailTint... ({} without a detail layer)
  - `chunkSize: number` Chunk edge length (meters), the same value as the chunkSize option and ground.chunkSize
  - `voidY: number` terrain({ shape }) only: below this height the player or a moving rigid body has fallen out of the world (one terrain:void per fall). shape.voidY, else 50 m under the lowest island chunk loaded so far; -Infinity without a shape. Example: `engine.events.on('terrain:void', ({ who }) => { if (who === engine.player) engine.player.placeAt(home); });`
  - `chunks: Map<string, TerrainChunk>` Loaded chunks: 'cx,cz' → chunk
  - `viewChunks: number` (experimental) View distance (in chunks). Writing it moves the camera far plane out too, and with viewFog uViewDistance
  - `density: number` Vegetation density multiplier. Writing it places plants again on the loaded chunks: it thins plants without a collider, blocking plants stand at every density, so collision does not change
  - `applyBudgetMs: number` Time budget (milliseconds) for uploading chunks per frame
  - `stats: { builtThisFrame, applyMs, queued, failed, visible?, loaded?, … }` Statistics (for the debug panel); failed = chunks that failed every try (terrain:chunkFailed)
  - `cellSize: number` Grid spacing (meters) = chunkSize / resolution: edits snap to it, paint colors whole cells of this size

## Data structures
- **FlattenZone** Flattened plot (for villages, houses): center x/z, radius (meters), height optionally fixes the height
  - `x: number`
  - `z: number`
  - `radius: number`
  - `height?: number`
  - `clearRatio?: number`
