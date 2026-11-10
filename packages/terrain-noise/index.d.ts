// Types of @threedog/terrain-noise for code that imports it from the published package
// (TypeScript does not read JS inside node_modules, so without this the import would be untyped).
import type { TerrainNoise } from 'threedog';

/** Biome condition: all optional; any: [cond, cond] must also hold (at least one of them) together with the rule's other conditions */
export interface BiomeCondition {
  minHeight?: number; maxHeight?: number;
  /** Max height above the water surface */
  maxAboveWater?: number;
  minSlope?: number;
  /** Temperature 0–1 */
  minTemp?: number; maxTemp?: number;
  /** Moisture 0–1 */
  minMoist?: number; maxMoist?: number;
  /** Closeness to a river 0–1 */
  minRiver?: number;
}
/** Biome rule: checked top to bottom, the first match names the ground type (leave the last without conditions as the default) */
export interface BiomeRule extends BiomeCondition { name: string; any?: BiomeCondition[] }
/** Settings of terrainPreset() (n.params inside the generator) */
export interface TerrainPresetOptions {
  /** Landform, default 'hills' */
  shape?: 'hills' | 'island' | 'canyon' | 'flat';
  /** Multiplies the base land and hills around sea level (lows get deeper as highs rise); the mountain part (`mountains`) is separate and not scaled by it */
  heightScale?: number;
  /** Mountain strength */
  mountains?: number;
  /** Carve rivers, default true */
  rivers?: boolean;
  /** River width (0.02 narrow, 0.05 wide) */
  riverWidth?: number;
  /** Where rivers run and how their banks fall: noise scale and offset, bank width in river widths, the depth share outside the river itself */
  river?: { scale?: number; offset?: number[]; bank?: number; edge?: number };
  /** Biome rule table (default BIOMES) */
  biomes?: BiomeRule[];
  tempScale?: number; moistScale?: number;
  /** Temperature drop per meter of altitude */
  tempLapse?: number;
  noise?: { baseScale?: number; baseAmp?: number; hillScale?: number; hillAmp?: number; mountainScale?: number; mountainAmp?: number; mountainThreshold?: number; seaBias?: number };
  island?: { center?: number[]; radius?: number; falloff?: number; depth?: number };
  canyon?: { scale?: number; depth?: number; plateau?: number };
}
/** The default biome rule table: beach, snow, rock, riverbank, wetland, savanna, forest, highland, meadow */
export const BIOMES: BiomeRule[];
/**
 * Noise terrain generator for terrain() / openWorld({ terrain }) / createTerrain(): noise hills (or island, canyon, flat), rivers, biomes.
 * @example engine.use(openWorld({ seed: 7, camera: 'follow', terrain: terrainPreset({ shape: 'island' }) }))
 */
export function terrainPreset(opts?: TerrainPresetOptions): {
  height: (x: number, z: number, n: TerrainNoise) => number;
  groundType: (x: number, z: number, h: number, slope: number, n: TerrainNoise) => string;
  params: Record<string, any>;
  /** Sea level this generator carves rivers and coasts toward */
  waterLevel: number;
};
/** Display names of the preset's ground types ('ground.<type>' keys in zh-CN and en): engine.i18n.add(terrainStrings) */
export const terrainStrings: Record<string, Record<string, string>>;
/** Closeness to a river (0 away, up to 1 in the middle), e.g. riverAt(x, z, createTerrain({ seed, ...terrainPreset() }).noise) */
export function riverAt(x: number, z: number, n: { fbm: TerrainNoise['fbm']; params: Record<string, any> }): number;
