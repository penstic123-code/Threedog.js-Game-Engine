# engine.vegetation — vegetation(opts?: VegetationModuleOptions)

Vegetation (vegetation() module; grows on terrain or on any ground provider)

- Options `VegetationModuleOptions`:
  - `chunkSize?: number` Chunk edge (meters), default 32
  - `viewChunks?: number` Rings of chunks drawn around each stream source, default 3
  - `density?: number` Placement attempts multiplier, default 1
  - `area?: { min: number[]; max: number[] } | null` Where it may grow: { min: [x, z], max: [x, z] }; default anywhere the ground is
  - `seed?: number` Placement seed, default 1

## Methods and properties
- `vegetation.sway(spec: string | { glsl?, tsl?, uniforms? } | null)` — Replace the sway shape of every species whose wind is a number, planted ones too; a species with its own wind object keeps it. null gives the built-in sway back. GLSL defines void threedogWind(inout vec3 transformed, vec3 ip, vec3 position); tsl: (ctx) => the moved object-space position
- `vegetation.color(spec: string | { glsl?, tsl?, uniforms?, pars? } | null)` — Code in the 'color' slot of every species' material, planted ones too (diffuseColor is yours); tsl: (ctx) => vec4 from ctx.color; null takes it off
- `vegetation.view(hooks: { species?, change?, ring?, show?, drop? }) → { remove(): void }` — Draw the plants: the hooks a draw part that replaces 'vegetation-draw' uses. species(sp): defined or defined again (sp.source = the define() options); change(c, name): c.plants[name] placed, replaced or gone, or c.hidden[name] (felled slots) changed; ring(c, ring): LOD ring; show(c, visible); drop(c): released. What is already there is replayed at once. Returns { remove() } (ctx.track it). Example: `ctx.track(engine.vegetation.view({ change(c, name) { draw(c, c.plants[name]) }, drop(c) { undraw(c) } }))`
- `vegetation.rebuild()` — Place every chunk again: after changing the ground behind the same provider (a ground function reading game state). A new setGround or level is followed automatically
- `vegetation.setShadowRing(name: string, ring: number)` — Change at runtime how far a vegetation kind casts shadows: within `ring` chunk rings of the player (0 = only the chunk you stand in, 1 = the default, larger = further and dearer). Takes effect at once; the define() option shadowRing is only the starting value. An unknown name warns with the known ones. Example: `engine.vegetation.setShadowRing('tree', 0);   // graphics setting "shadows: low": trees shadow only the nearest chunk`
- `vegetation.define(name: string, opts: VegetationOptions) → Species | Promise<Species>` — Define a kind of vegetation (a model name in model / lodGeometry: resolves first, so the result is a Promise of the species)
- `vegetation.isRemoved(species: string, cx: number, cz: number, id: number) → boolean` — Was this instance removed (removeInstance) and not restored
- `vegetation.removeInstance(species: string, cx: number, cz: number, id: number, opts?: { regrowSeconds?: number }) → string` — Remove one (chop a tree). regrowSeconds: grows back after this many calendar seconds, 0 = permanent. The record is saved with the save (save key 'vegetation'). Returns the entry name
- `vegetation.restoreInstance(species: string, cx: number, cz: number, id: number)` — Restore one removed instance
- `vegetation.instanceAt(position: PositionLike, opts?: { radius?, species? }) → VegetationHit | null` — The one nearest to position within radius meters (default 2) (species restricts to one kind), null if none
- `vegetation.plantOf(hit: { object?, instanceId? } | null | undefined) → VegetationHit | null` — The plant a ray hit, read from the hit itself (no spatial guess): the same VegetationHit instanceAt returns (goes to removeInstance), null if not vegetation or a far impostor card
- Also: `vegetation.get(name: string) → Species | undefined`, `vegetation.list() → Species[]`
- Properties:
  - `material: Material | null` The shared default material: species with no material or model of their own draw it, as given, planted ones too; null gives the neutral default back. Until set, reading gives the neutral source of each species' own copy (only .color written there reaches them all). Throws when a game module drew the plants instead (replaces: 'vegetation-draw').
  - `patches: any[]` The engine's plant patches (season tint, sway with one amplitude, vegetation.color() code) for applyEffects(myMaterial, { patches })

## Data structures
- **VegetationOptions** Parameters of engine.vegetation.define(name, {...})
  - `geometry?: BufferGeometry` High-detail model (this or model is required)
  - `model?: Object3D | string | [string, ...any[]]` A model name from an asset pack ('pine', or ['flower', color] for a generator with params), resolved as content resolves it (file or generator, cache, bake; add then returns a Promise of the species), or a multi-material Object3D (one material per mesh, e.g. bark trunk + leaf cards); still one InstancedMesh per species. Its materials are cloned
  - `lodGeometry?: BufferGeometry | Object3D | string | [string, ...any[]]` Low-detail model, switched to beyond lodRing rings: a model name, or with model an Object3D with the same mesh order, or a geometry drawn with the first material
  - `rule?: VegetationRule` Placement rule (random scatter per chunk)
  - `positions?: number[][]` The game's own spots instead of the random scatter: [x, z], [x, z, scale] or [x, z, scale, yaw] in world metres / size multiplier / radians.
  - `densityMap?: ((x, z) => number) | { url?, data?, width?, height?, size, center?, … }` How much of this species survives at each spot, 0 (none) ..
  - `wind?: number | { amplitude, glsl?, tsl?, uniforms? }` Wind sway amplitude, 0 = still; or this species' own sway: { amplitude, glsl, tsl, uniforms }, which vegetation.sway() leaves alone (recipes/36)
  - `nearOnly?: boolean` Only generated near the player (grass, flowers)
  - `maxRing?: number` No longer drawn beyond this many rings
  - `fade?: false | { start?: number; end?: number }` Distance fade of a near-only species (grass, flowers, pebbles, debris ...): instances shrink out over a band in metres from the player instead of popping per chunk at the ring edge. Default for nearOnly: end = maxRing x chunk size, start = 65% of it. `false` keeps the hard ring edge (also the default for species that are not nearOnly).
  - `lodRing?: number` Switch to the low-detail model beyond this many rings, default 1
  - `impostor?: boolean | { views?: number; size?: number }` Beyond lodRing, draw camera-facing cards baked from this species' own model and materials: one draw for all far chunks, lit through baked normals, no shadow there. views around the plant (default 8), size in pixels per view (default 128). Not with lodGeometry. WebGPU only (WebGL draws the mesh and warns)
  - `castShadow?: boolean` Cast shadows
  - `shadowRing?: number` Cast shadows within this many rings
  - `receiveShadow?: boolean` Receive shadows, default true
  - `material?: Material` Custom material, any three.js material (default: the style's 'vegetation' role); wind, cloud shadows and season tint are added to it
  - `effects?: boolean` false: leave a custom material untouched (no wind / clouds / season added)
  - `doubleSided?: boolean` Double-sided rendering
- **VegetationRule** Vegetation placement rule (must be JSON-able, no functions: it is sent to the terrain workers)
  - `perChunk?: number` Placement attempts per chunk, default 100
  - `chance?: number` Success probability of each attempt 0–1 (when cluster is 'none'), default 1
  - `minHeight?: number` Altitude range (meters); default unlimited both ways (a terrain game names its band above the water, e.g. minHeight: 1.5)
  - `maxHeight?: number`
  - `maxSlope?: number` Max slope
  - `cluster?: 'forest' | 'meadow' | 'none'` Clustering: 'forest' grows into woods / 'meadow' grows in open ground / 'none' even
  - `scale?: number[]` Size range [min, max] multiplier
  - `stretch?: number[]` Height stretch [min, max] multiplier
  - `sink?: number` How deep to bury into the ground (meters, multiplied by size)
  - `tintJitter?: number` Random color jitter 0–1
  - `tints?: { color: number[]; chance: number }[]` Special color: color [r, g, b] multiplier, chance probability
  - `biomes?: Record<string, number> | null` Which ground types it grows on: { type: probability 0–1 } (engine.groundType: a terrain groundType, a level mesh's groundType property or material name); omitted = grows anywhere
  - `collider?: number` Collision circle radius (meters, multiplied by size), 0 = no collision
  - `avoidFlat?: boolean` Avoid flattened plots (villages), default true
  - `salt?: number` Random seed offset (default computed from the name)
