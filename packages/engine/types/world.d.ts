// World modules: terrain, vegetation, sky, weather, water.
import type { Object3D, Vector3, Color, Material, BufferGeometry, ColorLike, Handle, PositionLike, Loose } from './common';
import type { Mesh, InstancedMesh } from 'three';
import type { Engine, ModuleDef } from './core';
import type { ShaderPatch } from './generated/render/patches';

// ======================================================================
// Terrain terrain()
// ======================================================================

/** Steep-slope colors: used when the normal's Y component is below maxNormalY */
export interface SteepRule { maxNormalY: number; colors: string[] }
/** Flattened plot (for villages, houses): center x/z, radius (meters), height optionally fixes the height */
export interface FlattenZone { x: number; z: number; radius: number; height?: number; clearRatio?: number }

/** Noise helpers handed to a custom height / groundType function (it cannot import anything) */
export interface TerrainNoise {
  fbm(x: number, z: number, octaves?: number): number; noise(x: number, z: number): number; hash(x: number, z: number, salt?: number): number; seed: number;
  /** The terrain's water level (meters; -Infinity when the terrain has no water) */
  waterLevel: number;
  /** terrain({ params }): plain data for the generator (a preset's settings) */
  params: Record<string, any>;
}

/** Options of engine.terrain.edit() */
export interface TerrainEditOptions {
  /** Meters, default half a cell. Heights snap to grid points and paint to cells inside the shape; the nearest one when the shape is smaller */
  radius?: number;
  /** Default 'circle' */
  shape?: 'circle' | 'square';
  /** Raise by meters (one of raise / lower / flatten) */
  raise?: number;
  /** Lower by meters (dig) */
  lower?: number;
  /** Set the height to this many meters (level a foundation) */
  flatten?: number;
  /** Paint the ground type ('tilled', 'wet', or a game's own with biomeColors[type]); null gives the cells back their generated type */
  paint?: string | null;
}

/**
 * World outline, terrain({ shape }): ground only where mask > 0, cut along straight lines through the cells where it crosses 0, with walls
 * down the rim (side) and optionally a hanging underside (bottom). Off it engine.surface is -Infinity, engine.ground.has false, slope 0,
 * groundType 'void'; nothing grows there; a fall below voidY emits terrain:void. Without shape the terrain is unchanged.
 * Depth and mask functions are pure like height (they run in workers). See recipes/28-terrain.md.
 * @example terrain({ height: (x, z, n) => 6 * n.fbm(x * 0.02, z * 0.02), shape: { mask: (x, z) => 40 - Math.hypot(x, z),
 *   edge: { noise: 5, size: 14 }, side: { depth: 2, ground: 'cliff' }, bottom: { depth: (x, z, n, m) => 4 + m * 0.6, ground: 'rock' } } })
 */
export interface TerrainShape {
  /**
   * Where there is ground: (x, z, n) => number, > 0 ground (distance-like values in meters read best: 40 - Math.hypot(x, z) is a 40 m disc).
   * Or a gray image: whiter is ground, value = gray - threshold (default 0.5); outside the image is void.
   */
  mask: ((x: number, z: number, n: TerrainNoise) => number) | string
    | { url?: string; data?: ArrayLike<number>; width?: number; height?: number; size: number[]; center?: number[]; threshold?: number };
  /**
   * The rim's picture. noise: meters of fbm added to the mask (a ragged outline), size: its wavelength in meters (default 16; keep it above a cell,
   * the cut cannot be finer than `resolution`); jitter: meters of per-grid-point random offset (a jagged rim); round: meters the top bends down
   * towards the rim (0 = a hard cliff edge)
   */
  edge?: { noise?: number; size?: number; jitter?: number; round?: number };
  /**
   * Wall down from the rim: depth meters (default 2) or (x, z, n) => meters; ground: color = biomeColors[ground] (default 'cliff');
   * material: a Material (or (engine) => Material) for sides and bottom
   */
  side?: { depth?: number | ((x: number, z: number, n: TerrainNoise) => number) | string; ground?: string;
    material?: Material | ((engine: Engine) => Material) };
  /**
   * Underside, below the side band: depth meters (default 4) or (x, z, n, m) => meters, m = mask value there (larger inland, so the middle
   * hangs lower); ground default 'rock'. Without it the island is open below
   */
  bottom?: { depth?: number | ((x: number, z: number, n: TerrainNoise, m: number) => number) | string; ground?: string } | null;
  /** Height below which a fall emits terrain:void (default 50 m under the lowest island chunk loaded so far); give it for replay-exact games */
  voidY?: number;
}

/** Terrain generation parameters (JSON-able; a custom height / groundType function is sent to workers as source text) */
export interface TerrainConfig {
  /** Random seed; the same seed gives the same terrain */
  seed: number;
  /** Chunk edge length (meters), default 64 */
  chunkSize: number;
  /** Cells per chunk; smaller is more "low poly", default 16 */
  resolution: number;
  /** Water level (meters), default -Infinity = no water (terrainPreset() from @threedog/terrain-noise sets 0) */
  waterLevel: number;
  /** Flattened plots */
  flatten: FlattenZone[];
  /** Ground type → palette color names (two are blended by noise); a type left out is neutral gray */
  biomeColors: Record<string, string[]>;
  /** Steep-slope color rule */
  steep: SteepRule[];
  /** Heightmap (used when there is no height function): url grayscale image, size [width m, length m], min/max height (meters), center [x, z] */
  heightmap: { url?: string; size?: number[]; min?: number; max?: number; center?: number[]; outside?: number; data?: ArrayLike<number>; width?: number; height?: number } | null;
  /**
   * Height generator: (x, z, n) => meters. Without one (and without a heightmap) the ground is flat at y = 0, a placeholder (dev warning).
   * Runs in workers, so it must be pure (only its parameters and globals like Math); an outside variable throws at terrain() naming it.
   * n = { fbm(x, z, octaves?), noise(x, z), hash(x, z, salt?), seed, waterLevel, params }. Flatten still applies. Presets: terrainPreset() from
   * @threedog/terrain-noise.
   * @example terrain({ height: (x, z, n) => 4 + 12 * n.fbm(x * 0.01, z * 0.01) })
   */
  height: ((x: number, z: number, n: TerrainNoise) => number) | string | null;
  /**
   * Ground type: (x, z, h, slope, n) => type name (null = 'default'). Pure, like height. Colors come from biomeColors[type]; vegetation rules and
   * footsteps match by name.
   * @example terrain({ groundType: (x, z, h, slope) => slope > 0.7 ? 'rock' : h < 2 ? 'beach' : 'grass' })
   */
  groundType: ((x: number, z: number, h: number, slope: number, n: TerrainNoise) => string | null) | string | null;
  /** Plain data handed to height / groundType as n.params (a preset's settings); must be serializable */
  params: Record<string, any> | null;
  /**
   * How the ground gets its color: 'smooth' (default) blended per grid point | 'flat' one color and normal per triangle (low poly) |
   * 'texture' per-chunk color map sampled per pixel, so color borders (a river bank) are not confined to triangle edges and the mesh can stay coarse.
   * See recipes/53-ground-up-close.md.
   */
  shading: 'flat' | 'smooth' | 'texture';
  /** Texture shading: color map pixels per chunk edge (default 128, 64 on low-tier devices; independent of `resolution`) */
  colorResolution: number;
  /** Texture shading only: lighting normals 'smooth' (default) | 'flat' */
  normals: 'smooth' | 'flat' | null;
  /**
   * Replace the smooth normal at grid point (i, j): (i, j, h, cell) => [nx, ny, nz] (any length; the engine normalizes). h(i, j) is a grid-point
   * height, cell the grid spacing in meters. Pure, like height (workers get its source). Default: central difference of the neighbors.
   * @example terrain({ normalFn: (i, j, h, cell) => [(h(i - 1, j) - h(i + 1, j)) / (2 * cell), 2, (h(i, j - 1) - h(i, j + 1)) / (2 * cell)] })   // flatter lighting
   */
  normalFn: ((i: number, j: number, h: (i: number, j: number) => number, cell: number) => number[]) | string | null;
  /**
   * How each cell is cut into two triangles: 'fixed' (default, the same diagonal everywhere) | 'adaptive' (along the diagonal with the smaller
   * height difference, fewer zigzag ridges on slopes) | 'alternate' (flips every other cell). It is shape: engine.surface follows it
   */
  diagonal: 'fixed' | 'adaptive' | 'alternate';
  /** Chunk bounding sphere margin in meters (default { up: 3, radius: 8 }): center raised by `up`, radius grown by `radius`. Raise it when a shader moves vertices far */
  boundsPad: { up?: number; radius?: number };
  /** World outline (default null = ground everywhere): an island, a floating rock, a coastline that ends */
  shape: TerrainShape | null;
  /** Palette: color name → color */
  colors: Record<string, ColorLike>;
}

/** Parameters of terrain({...}) */
export interface TerrainOptions extends Partial<TerrainConfig> {
  /** View distance (in chunks), default 4 */
  viewChunks?: number;
  /** Vegetation density multiplier, default 1 */
  density?: number;
  /** true: the signal engine.uniforms.uViewDistance follows the view distance, so a game's fog can read it and fade the far chunk edge out (openWorld() sets true) */
  viewFog?: boolean;
  /** true: do not take the ground slot; compositeGround({ parts: [{ of: 'terrain' }] }) does and reads terrain.ground (so a terrain and a level can both run) */
  part?: boolean;
  /** Ground material (default neutral gray with vertex colors); chunks have position, normal, color and uv = world xz / chunk size. Cloud shadows, season tint and detail are added */
  material?: Material | ((engine: Engine) => Material);
  /** With material: false = draw it exactly as given, no cloud shadow / season / detail patch */
  effects?: boolean;
  /** Detail layer over the ground: a noise, a texture asset name or your own glsl; defaults scale 0.25, strength 0.35, top-down world projection, multiply. Change it with engine.terrain.recolor({ detail }) */
  detail?: MaterialDetail | null;
  /** Ground color noise, baked into the chunks */
  variation?: TerrainVariation;
}

/** The color noise on the ground, baked into the chunks */
export interface TerrainVariation {
  /** The two-color noise: size = wavelength in meters */
  blend?: { size?: number; strength?: number };
  /** Per-cell brightness grain */
  jitter?: { size?: number; min?: number; range?: number };
  /** Large color blocks, off unless given */
  patches?: { size?: number; strength?: number; levels?: number; tint?: ColorLike };
}

/** engine.terrain.recolor({...}): what terrain({...}) baked in. Each value is given whole; null takes it out */
export interface TerrainRecolor {
  colors?: Record<string, ColorLike> | null;
  biomeColors?: Record<string, string[]> | null;
  steep?: SteepRule[] | null;
  variation?: TerrainVariation | null;
  /** null goes back to what terrain({...}) was given */
  shading?: 'flat' | 'smooth' | 'texture' | null;
  normals?: 'smooth' | 'flat' | null;
  /** The detail layer on the engine's material; no chunk is rebuilt, a game's own material is left alone */
  detail?: MaterialDetail | null;
}

/** Pure-computation terrain returned by createTerrain() (draws nothing, only computes heights; usable before the engine exists, e.g. for previews) */
export interface TerrainGen {
  config: TerrainConfig;
  /** Chunk edge length (meters) */
  CHUNK: number;
  /** Cells per chunk */
  RES: number;
  /** Cell size (meters) */
  CELL: number;
  /** Water level (meters) */
  waterLevel: number;
  /** Ground height at (x, z) (meters); -Infinity off the outline of shape */
  surface(x: number, z: number): number;
  /** Is there ground at (x, z) (false only off the outline of shape) */
  has(x: number, z: number): boolean;
  /** Slope at (x, z) */
  slope(x: number, z: number): number;
  /** Ground type name ('default' without a groundType function) */
  biomeAt(x: number, z: number, h?: number, slope?: number): string;
  /** The noise helpers a height / groundType function receives (n), e.g. for a preset's riverAt(x, z, gen.noise) */
  noise: TerrainNoise;
  /** Fractal noise 0–1 */
  fbm(x: number, z: number, octaves?: number): number;
  buildChunk(cx: number, cz: number): any;
  place(cx: number, cz: number, rule: VegetationRule, density?: number): any;
}

/** A loaded chunk record (data only; the draw parts keep their meshes): c.data = generated arrays, c.plants = what grows there */
export interface TerrainChunk {
  cx: number; cz: number; key: string;
  state: 'queued' | 'pending' | 'ready' | 'failed';
  /** generated arrays: pos / nor / col (3 per vertex), uv (2 per vertex), tex (color map of shading 'texture') */
  data: { pos: Float32Array; nor: Float32Array; col: Float32Array; uv: Float32Array; tex?: any; top?: number } | null;
  /** species name -> placement (see VegetationPlants) */
  plants: Record<string, VegetationPlants>;
  /** species name -> felled instance slots (null = none) */
  hidden?: Record<string, Set<number> | null> | null;
  /** LOD ring from the nearest stream source; inView: in the camera view */
  ring?: number; inView: boolean;
}
/** One species' placement in one chunk: n plants, m = 16 floats per plant (chunk-local matrix), c = 3 colors per plant, ids = stable ids */
export interface VegetationPlants { n: number; m: Float32Array; c: Float32Array; ids?: Uint32Array; k?: Float32Array }

/** engine.terrainDraw: draws the terrain chunks (slot 'terrain-draw'; engine.use(mine, { replaces: 'terrain-draw' }) swaps it) @experimental */
export interface TerrainDraw {
  /** The ground material every chunk draws with; setting swaps it on every loaded chunk as given (same as engine.terrain.material). Nothing is regenerated, collision is untouched */
  material: Material;
  /** Same as engine.terrain.patches */
  readonly patches: ShaderPatch[];
  /** Same as engine.terrain.uniforms */
  readonly uniforms: Record<string, { value: any }>;
  /** Same as engine.terrain.recolor */
  recolor(o?: TerrainRecolor): void;
  /** chunk record -> { group, mesh, colorTex, colorMat } */
  meshes: Map<TerrainChunk, { group: Object3D; mesh: Mesh; colorTex: any; colorMat: any }>;
}

/** engine.vegetationDraw: draws the plants (slot 'vegetation-draw'; engine.use(mine, { replaces: 'vegetation-draw' }) swaps it) @experimental */
export interface VegetationDraw {
  /** The InstancedMesh drawing one species in one chunk, null when none */
  mesh(c: TerrainChunk, name: string): InstancedMesh | null;
  /** How one species is drawn: its geometry, low-poly geometry, patched material(s), near-fade uniforms; shared = it draws engine.vegetation.material; null for an unknown name */
  kind(name: string): { geometry: BufferGeometry; lodGeometry: BufferGeometry | null; material: Material | Material[]; fadeUniforms: any; shared: boolean } | null;
  /** chunk record -> { group, ims: { species name: InstancedMesh } } */
  meshes: Map<TerrainChunk, { group: Object3D; ims: Record<string, InstancedMesh> }>;
}

/** engine.terrain: the terrain data part (chunks, heights, edits, collision); engine.terrainDraw draws it */
export interface Terrain {
  /** Pure-computation terrain (height, landform), what createTerrain() returns */
  generator: TerrainGen;
  /**
   * The plain three.js material every chunk draws with (null under a draw part that replaced 'terrain-draw'). The neutral one takes direct writes; setting one swaps it on every
   * loaded chunk and draws it as given. Nothing is regenerated, collision is untouched. Chunks carry position, normal, color and uv (world xz / chunk size)
   * @example engine.terrain.material = applyEffects(new THREE.MeshStandardMaterial({ vertexColors: true }), { patches: engine.terrain.patches });
   */
  material: Material | null;
  /** The engine's ground patches (world, clouds, season, detail), so a game material keeps them: applyEffects(mat, { patches: engine.terrain.patches }) */
  readonly patches: ShaderPatch[];
  /** The detail layer's { value } uniforms, written directly and live: uDetailStrength, uDetailScale, uDetailTint... ({} without a detail layer) */
  readonly uniforms: Record<string, { value: any }>;
  /**
   * Change at run time what terrain({...}) baked in. colors, biomeColors, steep, variation, shading, normals rebuild every chunk (edits stay); detail only patches the engine's material.
   * Throws under a draw part that replaced 'terrain-draw'
   * @example engine.terrain.recolor({ colors: { grass: 0x6a8a3a }, biomeColors: { meadow: ['grass'] } });
   */
  recolor(o?: TerrainRecolor): void;
  /** Chunk edge length (meters), the same value as the chunkSize option and ground.chunkSize */
  readonly chunkSize: number;
  /**
   * terrain({ shape }) only: below this height the player or a moving rigid body has fallen out of the world (one terrain:void per fall).
   * shape.voidY, else 50 m under the lowest island chunk loaded so far; -Infinity without a shape
   * @example engine.events.on('terrain:void', ({ who }) => { if (who === engine.player) engine.player.placeAt(home); });
   */
  readonly voidY: number;
  /** Loaded chunks: 'cx,cz' → chunk */
  chunks: Map<string, TerrainChunk>;
  /** View distance (in chunks). Writing it moves the camera far plane out too, and with viewFog uViewDistance @experimental */
  viewChunks: number;
  /** Vegetation density multiplier. Writing it places plants again on the loaded chunks: it thins plants without a collider, blocking plants stand at every density, so collision does not change */
  density: number;
  /** Time budget (milliseconds) for uploading chunks per frame */
  applyBudgetMs: number;
  /** Statistics (for the debug panel); failed = chunks that failed every try (terrain:chunkFailed) */
  stats: { builtThisFrame: number; applyMs: number; queued: number; failed: number; visible?: number; loaded?: number; instances?: number };
  /**
   * Draw these chunks: the hooks a draw part that replaces 'terrain-draw' uses. add(c): generated (c.data holds pos / nor / col / uv / tex arrays,
   * c.cx / c.cz the chunk); change(c): an edit rewrote c.data (the vertex count can differ on the rim of a shape with diagonal 'adaptive'); remove(c): released; show(c, visible): in view or not.
   * Chunks already loaded are added at once. Returns { remove() } (ctx.track it).
   * @example ctx.track(engine.terrain.view({ add(c) { draw(c) }, remove(c) { undraw(c) } }))
   */
  view(hooks: { add?: (c: TerrainChunk) => void; change?: (c: TerrainChunk) => void; remove?: (c: TerrainChunk) => void; show?: (c: TerrainChunk, visible: boolean) => void }): { remove(): void };
  /** Send chunks that failed every try (terrain:chunkFailed) again, e.g. after fixing what their rule reads. Returns how many were queued */
  retry(): number;
  /** Rebuild all chunks */
  rebuild(): void;
  /** Grid spacing (meters) = chunkSize / resolution: edits snap to it, paint colors whole cells of this size */
  readonly cellSize: number;
  /**
   * Change the ground: dig, raise, flatten, paint the ground type. Saved gameplay state: call it from an op or a fixed step.
   * engine.surface / slope / groundType, collision, paths and vegetation follow at once; it is saved, and chunks generated later come out edited.
   * @example
   * engine.terrain.edit(pos, { radius: 3, lower: 1.5 });                                                   // dig a pit
   * engine.terrain.edit(pos, { shape: 'square', radius: engine.terrain.cellSize / 2, paint: 'tilled' });  // till one cell
   * @experimental
   */
  edit(position: PositionLike, opts: TerrainEditOptions): { heights: number; cells: number };
}

// ======================================================================
// Vegetation vegetation()
// ======================================================================

/** Vegetation placement rule (must be JSON-able, no functions: it is sent to the terrain workers) */
export interface VegetationRule {
  /** Placement attempts per chunk, default 100 */
  perChunk?: number;
  /** Success probability of each attempt 0–1 (when cluster is 'none'), default 1 */
  chance?: number;
  /** Altitude range (meters); default unlimited both ways (a terrain game names its band above the water, e.g. minHeight: 1.5) */
  minHeight?: number;
  maxHeight?: number;
  /** Max slope */
  maxSlope?: number;
  /** Clustering: 'forest' grows into woods | 'meadow' grows in open ground | 'none' even */
  cluster?: 'forest' | 'meadow' | 'none';
  /** Size range [min, max] multiplier */
  scale?: number[];
  /** Height stretch [min, max] multiplier */
  stretch?: number[];
  /** How deep to bury into the ground (meters, multiplied by size) */
  sink?: number;
  /** Random color jitter 0–1 */
  tintJitter?: number;
  /** Special color: color [r, g, b] multiplier, chance probability */
  tints?: { color: number[]; chance: number }[];
  /**
   * Which ground types it grows on: { type: probability 0–1 } (engine.groundType: a terrain groundType, a level mesh's groundType property or material
   * name); omitted = grows anywhere
   */
  biomes?: Record<string, number> | null;
  /** Collision circle radius (meters, multiplied by size), 0 = no collision */
  collider?: number;
  /** Avoid flattened plots (villages), default true */
  avoidFlat?: boolean;
  /** Random seed offset (default computed from the name) */
  salt?: number;
}
/** Parameters of engine.vegetation.define(name, {...}) */
export interface VegetationOptions {
  /** High-detail model (this or model is required) */
  geometry?: BufferGeometry;
  /**
   * A model name from an asset pack ('pine', or ['flower', color] for a generator with params), resolved as content resolves it (file or generator,
   * cache, bake; add then returns a Promise of the species), or a multi-material Object3D (one material per mesh, e.g. bark trunk + leaf cards);
   * still one InstancedMesh per species. Its materials are cloned
   */
  model?: Object3D | string | [string, ...any[]];
  /** Low-detail model, switched to beyond lodRing rings: a model name, or with model an Object3D with the same mesh order, or a geometry drawn with the first material */
  lodGeometry?: BufferGeometry | Object3D | string | [string, ...any[]];
  /** Placement rule (random scatter per chunk) */
  rule?: VegetationRule;
  /**
   * The game's own spots instead of the random scatter: [x, z], [x, z, scale] or [x, z, scale, yaw] in world metres / size multiplier / radians. Each is
   * planted at the ground height; rule.scale / stretch / sink / tints / tintJitter / collider still apply (scale and yaw only where the entry leaves them
   * out), the scatter filters (perChunk, chance, cluster, min/maxHeight, maxSlope, biomes, avoidFlat) are refused, and the density setting does not
   * thin them. The stable id (instanceAt, removeInstance, saves) is the index in this list. Plain data, so it also works from content files
   */
  positions?: number[][];
  /**
   * How much of this species survives at each spot, 0 (none) .. 1 (all that the rule or positions placed): a function (x, z) => 0..1 (may read game
   * state; call vegetation.rebuild() after what it reads changes), or a gray image laid over the world with the keys of terrain({ heightmap }) — url,
   * or data (0..1, row 0 at the -z edge) + width + height; size [width m, length m]; center [x, z] (default [0, 0]); outside (value beyond the image,
   * default 0). An image url is waited for by start(). Survivors keep their stable ids, so raising the density only adds plants
   */
  densityMap?: ((x: number, z: number) => number) | { url?: string; data?: ArrayLike<number>; width?: number; height?: number; size: number[]; center?: number[]; outside?: number };
  /** Wind sway amplitude, 0 = still; or this species' own sway: { amplitude, glsl, tsl, uniforms }, which vegetation.sway() leaves alone (recipes/36) */
  wind?: number | { amplitude: number; glsl?: string; tsl?: (ctx: any) => any; uniforms?: Record<string, any> };
  /** Only generated near the player (grass, flowers) */
  nearOnly?: boolean;
  /** No longer drawn beyond this many rings */
  maxRing?: number;
  /**
   * Distance fade of a near-only species (grass, flowers, pebbles, debris ...): instances shrink out over a band in metres from the player instead of popping
   * per chunk at the ring edge. Default for nearOnly: end = maxRing x chunk size, start = 65% of it. `false` keeps the hard ring edge (also the default for
   * species that are not nearOnly). Part of the species' own material (no extra draw call or shader), works with wind and shadows
   */
  fade?: false | { start?: number; end?: number };
  /** Switch to the low-detail model beyond this many rings, default 1 */
  lodRing?: number;
  /** Beyond lodRing, draw camera-facing cards baked from this species' own model and materials: one draw for all far chunks, lit through baked normals, no shadow there. views around the plant (default 8), size in pixels per view (default 128). Not with lodGeometry. WebGPU only (WebGL draws the mesh and warns) */
  impostor?: boolean | { views?: number; size?: number };
  /** Cast shadows */
  castShadow?: boolean;
  /** Cast shadows within this many rings */
  shadowRing?: number;
  /** Receive shadows, default true */
  receiveShadow?: boolean;
  /** Custom material, any three.js material (default: the style's 'vegetation' role); wind, cloud shadows and season tint are added to it */
  material?: Material;
  /** false: leave a custom material untouched (no wind / clouds / season added) */
  effects?: boolean;
  /** Double-sided rendering */
  doubleSided?: boolean;
}
/** A defined species (data; how it is drawn: engine.vegetationDraw.kind(name)). source = the options define() was given */
export interface Species {
  name: string; rule: VegetationRule; source: VegetationOptions;
  nearOnly: boolean; maxRing: number; fade: { start: number; end: number } | null; lodRing: number; castShadow: boolean; shadowRing: number; receiveShadow: boolean;
}
/** A found plant: species name, chunk cx/cz, stable id, world coordinates position */
export interface VegetationHit { species: string; cx: number; cz: number; id: number; position: Vector3 }
export interface VegetationRemoveEvent { species: string; cx: number; cz: number; id: number }

/** vegetation({...}): only without terrain (with terrain these are terrain options and are refused) */
export interface VegetationModuleOptions {
  /** Chunk edge (meters), default 32 */
  chunkSize?: number;
  /** Rings of chunks drawn around each stream source, default 3 */
  viewChunks?: number;
  /** Placement attempts multiplier, default 1 */
  density?: number;
  /** Where it may grow: { min: [x, z], max: [x, z] }; default anywhere the ground is */
  area?: { min: number[]; max: number[] } | null;
  /** Placement seed, default 1 */
  seed?: number;
}

/** engine.vegetation: the vegetation data part (species, placement, tree collision, felling); engine.vegetationDraw draws it */
export interface Vegetation {
  /**
   * The shared default material: species with no material or model of their own draw it, as given, planted ones too; null gives the neutral default
   * back. Until set, reading gives the neutral source of each species' own copy (only .color written there reaches them all). Throws when a game
   * module drew the plants instead (replaces: 'vegetation-draw'). Per species: define(name, { material })
   */
  material: Material | null;
  /** The engine's plant patches (season tint, sway with one amplitude, vegetation.color() code) for applyEffects(myMaterial, { patches }) */
  readonly patches: any[];
  /**
   * Replace the sway shape of every species whose wind is a number, planted ones too; a species with its own wind object keeps it. null gives the built-in sway back. GLSL defines
   * void threedogWind(inout vec3 transformed, vec3 ip, vec3 position); tsl: (ctx) => the moved object-space position
   */
  sway(spec: string | { glsl?: string; tsl?: (ctx: any) => any; uniforms?: Record<string, any> } | null): void;
  /** Code in the 'color' slot of every species' material, planted ones too (diffuseColor is yours); tsl: (ctx) => vec4 from ctx.color; null takes it off */
  color(spec: string | { glsl?: string; tsl?: (ctx: any) => any; uniforms?: Record<string, any>; pars?: string } | null): void;
  /**
   * Draw the plants: the hooks a draw part that replaces 'vegetation-draw' uses. species(sp): defined or defined again (sp.source = the define()
   * options); change(c, name): c.plants[name] placed, replaced or gone, or c.hidden[name] (felled slots) changed; ring(c, ring): LOD ring;
   * show(c, visible); drop(c): released. What is already there is replayed at once. Returns { remove() } (ctx.track it).
   * @example ctx.track(engine.vegetation.view({ change(c, name) { draw(c, c.plants[name]) }, drop(c) { undraw(c) } }))
   */
  view(hooks: { species?: (sp: Species) => void; change?: (c: TerrainChunk, name: string) => void; ring?: (c: TerrainChunk, ring: number) => void; show?: (c: TerrainChunk, visible: boolean) => void; drop?: (c: TerrainChunk) => void }): { remove(): void };
  /**
   * Place every chunk again: after changing the ground behind the same provider (a ground function reading game state). A new setGround or level is
   * followed automatically
   */
  rebuild(): void;
  /**
   * Change at runtime how far a vegetation kind casts shadows: within `ring` chunk rings of the player (0 = only the chunk you stand in, 1 = the default,
   * larger = further and dearer). Takes effect at once; the define() option shadowRing is only the starting value. An unknown name warns with the known ones
   * @example engine.vegetation.setShadowRing('tree', 0);   // graphics setting "shadows: low": trees shadow only the nearest chunk
   */
  setShadowRing(name: string, ring: number): void;
  /** Define a kind of vegetation (a model name in model / lodGeometry: resolves first, so the result is a Promise of the species) */
  define(name: string, opts: VegetationOptions): Species | Promise<Species>;
  get(name: string): Species | undefined;
  list(): Species[];
  /** Was this instance removed (removeInstance) and not restored */
  isRemoved(species: string, cx: number, cz: number, id: number): boolean;
  /**
   * Remove one (chop a tree). regrowSeconds: grows back after this many calendar seconds, 0 = permanent. The record is saved with the save (save key
   * 'vegetation'). Returns the entry name
   */
  removeInstance(species: string, cx: number, cz: number, id: number, opts?: { regrowSeconds?: number }): string;
  /** Restore one removed instance */
  restoreInstance(species: string, cx: number, cz: number, id: number): void;
  /** The one nearest to position within radius meters (default 2) (species restricts to one kind), null if none */
  instanceAt(position: PositionLike, opts?: { radius?: number; species?: string | null }): VegetationHit | null;
  /** The plant a ray hit, read from the hit itself (no spatial guess): the same VegetationHit instanceAt returns (goes to removeInstance), null if not vegetation or a far impostor card */
  plantOf(hit: { object?: unknown; instanceId?: number } | null | undefined): VegetationHit | null;
}

// ======================================================================
// Sky sky()
// ======================================================================

/** What engine.sky.environment reports */
export interface SkyEnvironmentInfo { source: string, intensity: number, rotation: number, interval: number, builds: number }

/** Parameters of sky({...}). The sky computes signals and draws the dome; lights and fog are the game's. Picture values are start values here:
 *  after install the numbers are engine.uniforms (write .value), the rest engine.sky fields and calls (keyframes, clouds, layer, replace, backdrop, top, horizon, orbit, dim) */
export interface SkyOptions extends Pick<SkyPictureOptions, 'clouds' | 'backdrop' | 'keyframes' | 'sunSize' | 'sunGlow' | 'sunBrightness' | 'moonColor' | 'moonBrightness' | 'starDensity' | 'dim'> {
  /**
   * The fixed time of day drawn while no calendar() is installed: 'HH:MM' or 0–1 (0.5 noon), default 0.33 (a sunset arena: sky({ time: '18:30' })).
   * With calendar() the sky draws engine.calendar.timeOfDay and this option throws (start the day with calendar({ time }))
   */
  time?: string | number;
}

/** Sky keyframe: [time 0–1, zenith color, horizon color, sun disk color, sun intensity, ambient intensity] */
export type SkyKeyframe = (number | ColorLike)[];

/**
 * engine.sky.seasonTints: what each season tints the plants and ground, blended by the calendar's season. mode 'multiply' (default) multiplies
 * the color onto the surface (pick tints near white: orange times green is muddy); 'mix' moves the surface `strength` (0-1, default 0.5) of the
 * way to the color. Season names are the other keys, so none can be called mode or strength
 * @example engine.sky.seasonTints = { autumn: { foliage: 0xffb070 }, winter: { foliage: 0xdfe4e8, ground: 0xeef0f2 } }
 */
export interface SeasonTints {
  mode?: Loose<'multiply' | 'mix'>;
  strength?: number;
  [season: string]: any;
}

export interface SkyPictureOptions {
  /**
   * Rows [time, zenith, horizon, sunColor, ambient]. time: share of the day (0 = 00:00, 0.5 = noon), sorted, first row 0,
   * last 1 (midnight again: same values as 0). They color the dome and the signals uSkyTop / uSkyHorizon, and light nothing: sunColor is the sun disk and the signal uSunColor,
   * ambient dims a skybox and the weather's sky tint (recipe 08).
   * @example [[0, 0x0b1030, 0x1c2440, 0x8090c0, 0.25], [0.5, 0x5a8fd0, 0xbcd4ea, 0xfff4e0, 1.1], [1, 0x0b1030, 0x1c2440, 0x8090c0, 0.25]]
   */
  keyframes?: SkyKeyframe[];
  /**
   * A flat background color in place of the dome (no gradient, horizon line, sun / moon disk, stars or clouds).
   * Drawn as written (no tone mapping); a fog asked for in the default horizon color takes it (a
   * fog.color of your own still wins). Leave out for the dome. recipes/08
   * @example backdrop: 0xefebe4
   */
  backdrop?: ColorLike;
  /** Sharpness exponent of the sun disk, default 900 (about 2 deg); larger = smaller. Not a size in degrees: 10 is ~20 deg, under ~3 the "disk" washes most of the sky toward the sun color */
  sunSize?: number;
  /** Sun glow, default 0.18 */
  sunGlow?: number;
  /** Sun brightness, default 6 @experimental */
  sunBrightness?: number;
  /** @experimental */ moonColor?: ColorLike;
  /** @experimental */ moonBrightness?: number;
  /** Share of the sky grid cells (0-1) that hold a star at night, default 0.0025 (0 = no stars). A probability, not a brightness: near 1 every cell is lit and the upper sky turns into a white sheet. */
  starDensity?: number;
  /**
   * What the sky dims for every game unless the style says no (each default true; false turns that one off, the rest stay). The one place these
   * picture decisions are switched:
   * - tint: a sky.tint color (weather grey, a cave tint) dims with the sky's own light, so a grey rain tint stays dark at night. false: the tint
   *   keeps its full color at any hour (a fantasy sky that stays bright at night)
   * - stars: stars fade with the weather's cloud cover, not only behind drawn clouds. false: stars shine through an overcast / rainy sky
   * @example sky({ dim: { stars: false } })   // live: engine.sky.dim.tint = false
   */
  dim?: { tint?: boolean; stars?: boolean };
  /** Clouds in the sky (cloud cover follows the weather); see SkyCloudOptions */
  clouds?: SkyCloudOptions;
}

/**
 * One extra sky layer (modules/sky/domeLayers.js)
 * @example engine.sky.layer('aurora', { blend: 'add', uniforms: { uAurora: [0.2, 1, 0.6] }, glsl: `vec4 threedogSkyLayer(vec3 d, float time, vec3 sunDir, float night){
 *   float band = smoothstep(0.25, 0.45, d.y) * (1.0 - smoothstep(0.55, 0.8, d.y)) * threedogNoise(vec2(d.x * 4.0 + time * 0.05, d.z * 2.0));
 *   return vec4(uAurora, band * night); }` })
 */
export interface SkyLayerOptions {
  /** Not read: the layer's name is the first argument of engine.sky.layer(name, spec) */
  name?: string;
  /** Defines `vec4 threedogSkyLayer(vec3 dir, float time, vec3 sunDir, float night)` returning (rgb, amount 0..1); renamed per layer, so layers never clash. WebGLRenderer draws it */
  glsl?: string;
  /** WebGPURenderer form: (ctx) => vec4 node (rgb, amount); ctx = { dir, time, sunDir, night, color (sky so far), uniforms, fx: { noise, hash }, tsl } (recipe 52 'tsl forms') */
  tsl?: (ctx: any) => any;
  /** Custom uniforms (numbers, THREE.Color, [x, y(, z, w)], THREE.Texture), live in engine.sky.uniforms on both renderers */
  uniforms?: Record<string, any>;
  /** Draw order among the layers, smaller first (default 0) */
  order?: number;
  /** 'mix' (default: mix(sky, rgb, amount)) | 'add' (sky + rgb * amount, for glows) */
  blend?: Loose<'mix' | 'add'>;
}


/**
 * Sky cloud layer. The defaults are the original picture ('plane': one plane projected onto the sky, 3 noise layers), so a style
 * that sets nothing here draws what it always drew. Values below marked (plane) are the defaults of kind 'plane'.
 * @example clouds: { kind: 'cumulus', coverage: 1, scale: 0.5, color: 0xfff6ea, shade: 0x8fa0b8 }   // full-sky billowy clouds with sun-side light
 * Your own cloud function is not a style key: engine.sky.clouds({ glsl, tsl, uniforms }) (modules/sky/clouds.js has the signature).
 */
export interface SkyCloudOptions {
  color?: ColorLike; shade?: ColorLike;
  /** 0-1+, multiplies the weather cloud amount (default 1) */
  coverage?: number;
  /** Cloud cell size: larger = smaller clouds (plane 0.35) */
  scale?: number;
  /** Drift per second [x, z] (plane [0.004, 0.002]) */
  speed?: number[];
  /**
   * 'plane' (default): cheap, 3 noise samples, cells shrink and crowd towards the horizon.
   * 'cumulus': 8 noise samples per cloudy pixel, flatter projection (clouds fill the whole sky), sun-side light and shaded undersides.
   * Both are one 2D pass, no ray marching.
   */
  kind?: Loose<'plane' | 'cumulus'>;
  /** Added to dir.y in the plane projection: smaller = stronger crowding at the horizon (plane 0.08, cumulus 0.5) */
  horizon?: number;
  /** Horizon fade [from, to] in dir.y: clouds are invisible below `from` and full above `to` (plane [0, 0.18], cumulus [0, 0.12]) */
  fade?: number[];
  /** Cloud opacity 0-1 (plane 0.9, cumulus 0.95) */
  opacity?: number;
  /** Width of the cloud edge in noise units: larger = softer edge (plane 0.3, cumulus 0.35) */
  softness?: number;
  /** 'plane' only: the 3 noise layers. scales = frequency multipliers of layers 2 and 3 (default [2.7, 6.1]), weights = their mix (default [0.6, 0.3, 0.1]) */
  noise?: { scales?: number[]; weights?: number[] };
  /** 'cumulus' only: contrast of the sun-side light (default 5) */
  relief?: number;
}



/**
 * The `detail` surface patch. Source: texture (asset name) or noise ('grain' | 'paper' | 'stroke' | 'dabs', default grain) or glsl (your own sampler
 * function). Effects: color (strength, mode), normal (relief height in meters), roughness (amount). Every number is a uniform, so many materials
 * with different values share one shader program. Channels (color / normal / roughness) are fixed when the material is made.
 */
export interface MaterialDetail {
  /** Read as data, not color: 50% gray (128) is neutral. An asset name is loaded without sRGB decoding; a THREE.Texture you pass should use NoColorSpace */
  texture?: string | import('three').Texture;
  noise?: Loose<'grain' | 'paper' | 'stroke' | 'dabs'>;
  /** Replaces the noise: `vec4 threedogDetailSample(vec2 p)` returns vec4(color rgb, height 0-1); p is scaled, turned, stretched */
  glsl?: string;
  /** Uniforms for glsl: numbers, colors, [x, y(, z, w)] arrays or textures */
  uniforms?: Record<string, any>;
  /**
   * 'world' (default, looks straight down) | 'triplanar' (three axis planes blended by the surface normal; for walls and rocks) |
   * 'screen' (on the screen pixels: the same grain size near and far, for illustrated / printed looks; scale is pixels per cell)
   */
  projection?: Loose<'world' | 'triplanar' | 'screen'>;
  /** Repeats per meter, default 0.25; with projection 'screen' pixels per pattern cell, default 2 */
  scale?: number;
  /** Color effect 0-1, default 0.35 (0 turns the color part off) */
  strength?: number;
  /** How the color is applied: 'multiply' (default) | 'add' (lighter and darker) | 'mix' (towards the sample color) */
  mode?: Loose<'multiply' | 'add' | 'mix'>;
  /** Colors the sample (default white) */
  tint?: ColorLike;
  /** Default true: the effect fades out where the pattern is smaller than about a pixel (far away, grazing angles), so it does not shimmer. `false` keeps it. In `glsl`, `threedogDetailFootprint` is one pixel in pattern units */
  fade?: boolean;
  /** Degrees; turns the pattern (strokes run along it) */
  direction?: number;
  /** Stretches the pattern along direction (default 1, strokes 6) */
  stretch?: number;
  /** Noise layers 1-4, default 2 */
  octaves?: number;
  /** Relief height in meters (bumps the normal); needs a lit material */
  normal?: number;
  /** How much the sample moves roughness (standard / physical only) */
  roughness?: number;
}

// ======================================================================
// Calendar calendar()
// ======================================================================

export interface CalendarOptions {
  /** Time of day at start: 'HH:MM' or fraction of a day 0–1 (0.5 noon), default 0.33 (afterwards read / write engine.calendar.timeOfDay) */
  time?: string | number;
  /** Calendar seconds per day, default Infinity: the time of day never moves until the game sets a length (presets.calendar.cycle has 360) (one hour = dayLength / hoursPerDay calendar seconds; with clock.rate 1 calendar seconds are real seconds) */
  dayLength?: number;
  /** Hours per day of the displayed clock and of clock notation ('18:30'), default 24 */
  hoursPerDay?: number;
  /** Which day to start from, default 1 */
  day?: number;
  /** Days of each season given by name only, default 7 */
  daysPerSeason?: number;
  /**
   * Seasons, default none ([]): names (each daysPerSeason days) or { name, days } for seasons of their own length, e.g. ['spring',
   * 'summer', 'autumn', 'winter'], [{ name: 'wet', days: 10 }, { name: 'dry', days: 20 }], or ['q1', 'q2', 'q3', 'q4'] for a business year
   */
  seasons?: (string | { name: string, days: number })[];
}
/** Parameters of calendar.at() / daily() */
export interface CalendarAtOptions {
  /** Only fire on these days: a list of days, or (day) => whether to fire */
  days?: number[] | ((day: number) => boolean);
  /** When one advance crosses several trigger points: 'all' fire them all | 'once' fire once (default) | 'skip' do not make up */
  catchUp?: 'all' | 'once' | 'skip';
}
/** Callback of calendar.between: on is called when entering the period, off when leaving it */
export interface CalendarBetweenOptions {
  /** Entering the period (or found inside it when aligned) */
  on?: () => void;
  /** Leaving the period (or found outside it when aligned) */
  off?: () => void;
}

// Sky (engine.sky) is generated from the JSDoc in modules/sky/Sky.js (npm run map); only the types are re-exported here
import type { Sky } from './generated/modules/sky/Sky';
export type { Sky };
// Calendar (engine.calendar) is generated from the JSDoc in modules/calendar/Calendar.js
import type { Calendar } from './generated/modules/calendar/Calendar';
export type { Calendar };

// ======================================================================
// Weather weather()
// ======================================================================

/** Weather preset: intensities of about 0–1 */
export interface WeatherPreset {
  /** Cloud cover 0–1 */
  cloud: number;
  /** Sunlight multiplier */
  sun: number;
  /** Fog distance multiplier (smaller = denser fog) */
  fog: number;
  /** Wind multiplier */
  wind: number;
  /** Rain amount 0–1 */
  rain: number;
  /** Snow amount 0–1 */
  snow: number;
  /** How gray the sky turns 0–1 */
  grey: number;
  /** Thunder: above 0.5 it thunders */
  lightning: number;
  /** A field of the game's own (heat: 1): it blends like the rest and reads back from engine.weather.current */
  [field: string]: number;
}
/** A weather name from the game's table (weather() alone has only 'clear'; presets.weather.temperate brings seven) */
export type WeatherName = string;

export interface WeatherOptions {
  /** Starting weather, default 'clear' (or the first of the game's types when it has no 'clear') */
  start?: WeatherName;
  /** Automatic weather changes */
  auto?: boolean;
  /** Rain / snow particle count, default 6000 */
  particles?: number;
  /** Rain particles (default streaks: color 0xc8c8c8, opacity 0.55, length 0.7 m, speed 22 m/s, slant 1); a texture or a sprite shape draws drops */
  rain?: WeatherParticles;
  /** Snow particles (default round sprites: color 0xffffff, opacity 0.9, size 20, maxSize 5 px, speed 1.6 m/s, sway 1.5 m), plus the cover it leaves */
  snow?: WeatherParticles & { cover?: SnowCover };
  /**
   * Strike picture: flash (1 at the strike, fading in a third of a second) -> sky flash amount; default flickers. Return 0 and draw your own bolt on the
   * weather:lightning event for a whole replacement
   * @example lightning: f => f * f * 0.8
   */
  lightning?: (flash: number, engine: Engine) => number;
  /** Multiplies the sky flash of every strike, default 1 */
  lightningBrightness?: number;
  /** Color the sky turns as a weather type raises grey, default 0x8c8c8c */
  overcastColor?: ColorLike;
  /** The game's weather table, the whole list (default only a calm 'clear'; seven temperate ones in presets.weather.temperate.types, extend them with { ...presets.weather.temperate.types, dust: {...} }). Left-out fields are calm; extra numeric fields of the game's own blend too and show in weather.current */
  types?: Record<string, Partial<WeatherPreset> & Record<string, number>>;
  /** Candidates for automatic changes (repeat an entry for higher probability) */
  autoPool?: string[];
  /** Interval between automatic changes [shortest, longest] seconds */
  autoInterval?: number[];
  /** Transition seconds of automatic changes, default 25 */
  transition?: number;
  /** Rain / snow coverage (meters) */
  area?: number;
  /** Seconds to the first bolt once a type with lightning > 0.5 holds, default 5 */
  lightningFirst?: number;
  /** Seconds between later bolts [shortest, longest], default [6, 20] */
  lightningInterval?: number[];
}

/**
 * Snow cover (weather({ snow: { cover } })): the season tint of foliage / ground (vegetation, terrain, materials with season) moves toward these colors
 * as the weather's snow amount rises, `strength` of the way at full snow, and melts back as it falls. Leave it out and snow only draws particles.
 * The same cover for anything else (ash, frost): engine.mod('ground.cover', { owner: 'ash', value: { ground: 0x555555, amount: 0.6 } }). recipes/44
 * @example cover: { foliage: 0xf2f4f6, ground: 0xeef0f2, strength: 0.8 }
 */
export interface SnowCover {
  /** Snow color on foliage (leave out: foliage keeps its season color) */
  foliage?: ColorLike;
  /** Snow color on the ground (leave out: ground keeps its season color) */
  ground?: ColorLike;
  /** How far toward the color at full snow, 0-1, default 0.8 */
  strength?: number;
}

/** Falling weather particles: weather({ rain, snow }) and engine.weather.defineField(field, spec). See recipes/44-water-weather-hooks.md */
export interface WeatherParticles {
  /** 'line' streaks slant with the wind; 'round' | 'soft' | 'square' sprites drift (sway) */
  shape?: Loose<'line' | 'round' | 'soft' | 'square'>;
  /** Sprite image (asset name), replaces the shape */
  texture?: string | null;
  color?: ColorLike;
  opacity?: number;
  /** Sprite size (pixels at 3 m) and its pixel cap */
  size?: number;
  maxSize?: number;
  /** Streak length (meters, lines) */
  length?: number;
  /** Fall speed (m/s) */
  speed?: number;
  /** Streak lean per unit of wind (lines) */
  slant?: number;
  /** Sprite drift (meters) */
  sway?: number;
  /** Particle count (default weather({ particles }), else 6000, 3000 on low-tier devices; a number the game gives stands) */
  count?: number;
  /** Weather amount 0..1 -> share of particles drawn (rain default a => min(1, a * 1.2), snow () => 1; opacity follows the amount too) */
  density?: (amount: number) => number;
  /**
   * Whole shader text (copy modules/weather/shaders.js). In scope: uCam uSize uFallOff uOpacity uColor, lines uWindDir uLen (attribute aEnd),
   * sprites uPx uMaxPx uSway uSwayAmp uMap uUseMap, and your uniforms (declared for you)
   */
  glsl?: { vertex?: string; fragment?: string };
  /** Uniforms for your glsl: numbers, colors, [x, y(, z, w)] arrays, textures; live in engine.weather.particles[field].uniforms */
  uniforms?: Record<string, any>;
  /** A system of your own instead (engine.weather.defineField only): the engine adds object, shows it while the amount is above 0.02, calls update */
  create?: (engine: Engine, ctx: { area: number; count: number }) => {
    object: Object3D; update?: (amount: number, ctx: { camera: any; time: number; wind: number }) => void };
}

/** One entry of engine.weather.particles */
export interface WeatherParticleSystem {
  field: string;
  /** The three.js object drawn (LineSegments, Points; a Sprite on WebGPURenderer; yours with create) */
  object: Object3D;
  /** The plain three.js material; set yours and it is drawn as given (share uniforms to keep the fall), null gives the engine's back */
  material: Material | null;
  /** { value } objects: uColor uLen uPx uMaxPx uSwayAmp are yours to write; uCam uOpacity uFallOff uSway uWindDir are written each frame. null with create */
  uniforms: Record<string, { value: any }> | null;
  /** The keys it was built from; opacity, speed, slant, density are read each frame, so a plain write is live. Undefined with create */
  spec?: WeatherParticles;
  [key: string]: any;
}

// Weather (engine.weather) is generated from the JSDoc in modules/weather/Weather.js (npm run map); only the types are re-exported here
import type { Weather } from './generated/modules/weather/Weather';
export type { Weather };
// the drawing half of weather() (engine.weatherDraw): particles, flash, picture effects; generated from modules/weather/weatherDraw.js
import type { WeatherDraw } from './generated/modules/weather/weatherDraw';
export type { WeatherDraw };

// ======================================================================
// Water water()
// ======================================================================

/**
 * Parameters of engine.addWaterBody(): position center, level water surface height (meters); give radius for a circle, halfWidth / halfDepth for a
 * rectangle
 */
export interface WaterBodyOptions {
  position?: PositionLike;
  level?: number;
  /** Your own water (the engine draws nothing): level at (x, z) for a body at height y, or null where this body has none */
  query?: (x: number, z: number, y?: number) => number | null;
  /** Box3-like { min, max } that lets waterAt skip the query outside it */
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  /** The mesh you draw for it (kept for reference; add it to the scene yourself) */
  mesh?: Object3D;
  /** A plain volume with contains({ x, y, z }); with level it is water inside the volume */
  volume?: { contains(p: { x: number; y: number; z: number }): boolean; bounds?: WaterBodyOptions['bounds'] };
  radius?: number;
  halfWidth?: number;
  halfDepth?: number;
}
/**
 * A standalone body of water (stored in engine.waterBodies and given by the water:add event, already converted): circle { x, z, radius, level } or
 * rectangle { x, z, hw, hd, level } (meters)
 */
export interface WaterBody {
  /** Center position (meters) */
  x: number; z: number;
  /** Water surface height (meters) */
  level: number;
  /** Radius of a circular body (meters) */
  radius?: number;
  /** Half width and half depth of a rectangular body (meters) */
  hw?: number; hd?: number;
}

export interface WaterOptions {
  /** false: do not draw the global water surface (sea) */
  sea?: boolean;
  /** Global water level (meters); if omitted, the terrain's water level is used */
  level?: number;
  /** Flat shading (low poly), default true */
  flat?: boolean;
  /** Edge length of the global water plane (meters), default 900 */
  size?: number;
  /** Mesh subdivision of the global water, default 150 */
  segments?: number;
  // Picture values are not options: water({ color }) throws naming where each is written on engine.water (recipes/44)
}

/** engine.water.shader(): which GLSL the water has */
export interface WaterShaderOptions {
  /** Your wave function: GLSL defining `float threedogWaterWave(vec3 p, float t)`; waveMax is its peak (foam and depthColor 'wave' divide by it, default 0.29); null = built-in */
  wave?: string | { glsl: string; waveMax?: number } | null;
  /** Your surface function: GLSL defining `vec4 threedogWaterSurface(vec4 base, float wave, float facing, vec3 worldPos, float time)`; null = none */
  surface?: string | null;
  /**
   * Water color from the view angle (by 'view', default: shallow looking down, deep at grazing angles) or the wave height (by 'wave': shallow on
   * crests); replaces the material color. curve shapes the blend (default 1). A color left out is a neutral gray
   */
  depthColor?: { shallow?: ColorLike; deep?: ColorLike; by?: 'view' | 'wave'; curve?: number } | null;
  /** Crest foam from the wave height (start / end: fraction of waveMax where foam begins / is full, default 0.55 / 0.85); true = defaults. Shore foam needs depth: recipes/44 */
  foam?: { color?: ColorLike; start?: number; end?: number; opacity?: number } | true | null;
  /** Uniforms for your GLSL, in both stages: numbers, colors, [x, y(, z, w)] arrays or textures; live in engine.water.uniforms */
  uniforms?: Record<string, any>;
}

// Water (engine.water) is generated from the JSDoc in modules/water/Water.js (npm run map); only the types are re-exported here
import type { Water } from './generated/modules/water/Water';
export type { Water };

// ======================================================================
// Module factories
// ======================================================================

// ======================================================================
// Distant merging hlod()
// ======================================================================

/** Parameters of hlod() (also the defaults of add()) */
export interface HlodOptions {
  /** Handle levels automatically (adds the level on level:loaded), default true */
  level?: boolean;
  /** Merge cell edge length (meters), default 64 */
  cell?: number;
  /** Beyond this distance (meters) the merged proxy is shown, default 160 */
  near?: number;
  /** Proxy casts shadows, default false */
  castShadow?: boolean;
  /** Which meshes to merge (return false to skip) */
  include?: (mesh: Object3D) => boolean;
}
/** Parameters of hlod.add() */
export interface HlodAddOptions {
  cell?: number;
  near?: number;
  castShadow?: boolean;
  /** Which meshes to merge (return false to skip) */
  include?: (mesh: Object3D) => boolean;
}
/** One merged cell: proxy is the merged proxy meshes, originals the original objects */
export interface HlodCell {
  /** Cell key 'x,z' */
  key: string;
  /** Merged proxy meshes (one per material) */
  proxy: Object3D[];
  /** Originals */
  originals: Object3D[];
  /** Average center of the originals (for distance) */
  center: Vector3;
  /** The proxy is currently shown */
  far: boolean;
}
/** Handle returned by hlod.add() */
export interface HlodHandle {
  cells: HlodCell[];
  /** Beyond this distance (meters) the proxy is shown */
  near: number;
  /** Are all proxies merged (done over several frames) */
  readonly ready: boolean;
  /** Promise that resolves when merging is done: await h.whenReady */
  whenReady: Promise<HlodHandle>;
  /** Cancel: restore the originals, free the proxies */
  remove(): void;
}
/** engine.hlod: merge a patch of distant objects into a few meshes to cut draw calls @experimental */
export interface Hlod {
  /** All merged cells */
  cells: HlodCell[];
  /** Register a group of objects (a root or an array), merged into proxies by cell */
  add(target: Object3D | Object3D[], opts?: HlodAddOptions): HlodHandle;
}

// ======================================================================
// Light pool engine.lightPool (lightPool() module)
// ======================================================================

/** Parameters of lightPool(): how many real lights exist (fixed for the whole game, so shaders never recompile) */
export interface LightPoolOptions {
  /** Real PointLights, default 8 */
  point?: number;
  /** Real SpotLights, default 0 (sources added with type: 'spot' use them) */
  spot?: number;
  /** How many of the point lights cast shadows, default 0; only sources added with castShadow: true get them */
  shadows?: number;
  /** Seconds between choosing which sources get the lights, default 0.1 (fading and following run every frame) */
  every?: number;
  /** Seconds a light takes to fade in or out when it moves to another source, default 0.3 */
  fade?: number;
  /** Measure distance from this object / position instead of the camera (e.g. the player in a top-down game) */
  focus?: PositionLike | null;
}
/** Options of lightPool.add(position, opts): one light source (a torch, lamp, campfire, muzzle flash...) */
export interface LightSourceOptions {
  /** Name shown in describe().lightPool */
  name?: string;
  /** 'point' (default) or 'spot' (needs lightPool({ spot: n })) */
  type?: 'point' | 'spot';
  /** Light color, default white */
  color?: ColorLike;
  /** three.js intensity, default 1; 0 = off (gives its light away). With decay 2 a surface d m away gets intensity / d^2: pick it for the distance to what it lights (one that pools on a street 4 m below blows a wall 1 m away to white). Example values are no targets: threedog shot / snap name a light that glares. */
  intensity?: number;
  /** three.js light distance (range, meters), default 10; also the scale of the distance score */
  distance?: number;
  /** three.js decay, default 2 */
  decay?: number;
  /** Weight in the choice, default 1: 3 = picked over a 1 three times as bright at the same distance (a quest lamp, a muzzle flash) */
  priority?: number;
  /** May take one of the shadow-casting lights (lightPool({ shadows })), default false; fixed when added */
  castShadow?: boolean;
  /** Spot cone half-angle (radians), default PI / 4 */
  angle?: number;
  /** Spot penumbra 0-1, default 0.3 */
  penumbra?: number;
  /** Spot aim: a position or an Object3D it follows; default straight down */
  target?: PositionLike | null;
  /** Brightness factor each frame (time = presentation seconds, index = the source's number): (t, i) => 0.85 + 0.15 * Math.sin(t * 13 + i) */
  flicker?: ((time: number, index: number) => number) | null;
  /**
   * Stand-in shown while the source has no real light: a halo Sprite / Mesh (its material's opacity) or an emissive material (emissiveIntensity) scaled
   * from its value at add() down to 0 as the real light fades in. Give each source its own material
   */
  glow?: Material | Object3D | null;
  /**
   * Follow the time of day on the curve of engine.uniforms.uNight: true = its default dusk, a number = the daylight (0..1; 0 = on only while daylight is 0) below which
   * the source fades in. Off by day (its light goes to lit sources, its stand-in dims too). Default false: lit at any hour. Needs calendar() or sky()
   */
  dusk?: boolean | number;
}
/** What lightPool.add().set(patch) can change (type and castShadow are fixed when added) */
export interface LightSourcePatch {
  /** New position, or an Object3D to follow */
  position?: PositionLike;
  name?: string;
  color?: ColorLike;
  intensity?: number;
  distance?: number;
  decay?: number;
  priority?: number;
  angle?: number;
  penumbra?: number;
  target?: PositionLike | null;
  flicker?: ((time: number, index: number) => number) | null;
  glow?: Material | Object3D | null;
  dusk?: boolean | number;
}
/** Handle returned by lightPool.add() */
export interface LightSource {
  /** The real light lighting this source now, null while it has none */
  readonly light: Object3D | null;
  /** How much of its light it has now, 0-1 */
  readonly weight: number;
  /** Change the source; returns the same handle */
  set(patch: LightSourcePatch): LightSource;
  /** Unregister: its light fades out and moves on, the stand-in is put back (safe to call twice) */
  remove(): void;
}
/** engine.lightPool: register any number of light sources; a fixed set of real lights moves to the most relevant ones */
export interface LightPool {
  /** The real three.js lights, created once at install and never added, removed or hidden (the pool sets their position, color, intensity) */
  readonly lights: Object3D[];
  /** Distance is measured from this object / position; null = the camera */
  focus: PositionLike | null;
  /**
   * Register a light source at a position (an Object3D: it follows that object every frame)
   * @example
   * const torch = engine.lightPool.add(torchMesh, { color: 0xffa040, intensity: 4, distance: 8, glow: haloSprite });
   * torch.set({ intensity: 0 });   // put out: its light goes to another torch
   */
  add(position: PositionLike, opts?: LightSourceOptions): LightSource;
}

// ======================================================================
// Performance budget engine.budget (core, off by default)
// ======================================================================

/** Budget limits: only the given categories are checked. fps/low1 are lower bounds (frame rate must not drop below), the rest are upper bounds */
export interface BudgetLimits {
  /** Draw calls */
  drawCalls?: number;
  /** Average frame rate (lower bound) */
  fps?: number;
  /** Worst 1% frame rate (lower bound) */
  low1?: number;
  /** CPU milliseconds per frame */
  cpuMs?: number;
  /** Triangle count */
  triangles?: number;
  /** Texture count */
  textures?: number;
  /** GPU memory in MB as three counts it (WebGPURenderer only: an estimate, not driver VRAM) */
  gpuMemoryMB?: number;
  /** Terrain chunk upload milliseconds per frame */
  chunkApplyMs?: number;
  /** Rigid body count */
  rigidBodies?: number;
  /** Lit point + spot lights, a game's own and pooled ones (default limit 8) */
  lights?: number;
  /** Lit point + spot lights that cast shadows */
  shadowLights?: number;
  /** Shadow maps drawn each frame, sun and cascades included, a point light counts six */
  shadowMaps?: number;
  /** The largest side of a shadow map, in pixels */
  shadowMapSize?: number;
  /** Per-frame cost of applying background results, by stage (engine.budget.cost): worker transit (approximate), creating three.js objects, colliders, GPU upload (approximate), stream build() */
  applyTransitMs?: number;
  applyBuildMs?: number;
  applyColliderMs?: number;
  applyUploadMs?: number;
  applyStreamMs?: number;
  /** Time from opening to playable (milliseconds); when exceeded, the slowest module is named */
  startupMs?: number;
  /** Single module startup (init + wait for ready, milliseconds); when exceeded, that module is named */
  moduleMs?: number;
  /** Hook ms per frame of one module, { terrain: 1.5 } (median of engine.profile(), on in dev builds); reported as category 'modules.<name>' */
  modules?: Record<string, number>;
  /** Custom module categories (registered via budget.metric) */
  [metric: string]: number | Record<string, number> | undefined;
}
/** One overrun: top is the biggest draw-call contributors grouped by userData.budgetTag */
export interface BudgetOver { category: string; value: number; limit: number; top: BudgetTagStat[] }
/** A category estimated by userData.budgetTag: 'terrain', 'vegetation', 'hlod', 'sky', 'weather', untagged 'other'… */
export interface BudgetTagStat { tag: string; drawCalls: number; triangles: number }
/** Budget report: ok means everything is within budget */
export interface BudgetReport { ok: boolean; over: BudgetOver[] }
// Budget (engine.budget) is generated from the JSDoc in core/inspect/Budget.js (npm run map); only the types are re-exported here
import type { Budget } from './generated/core/inspect/Budget';
export type { Budget };

export type TerrainModule = ModuleDef<Terrain>;
export type VegetationModule = ModuleDef<Vegetation>;
export type SkyModule = ModuleDef<Sky>;
export type WeatherModule = ModuleDef<Weather>;
export type WaterModule = ModuleDef<Water>;
