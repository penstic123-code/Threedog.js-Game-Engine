// @threedog/terrain-noise: an optional terrain generator. Noise hills (or island / canyon / gentle plain), rivers, and a biome rule table
// (beach, snow, rock, riverbank, wetland, savanna, forest, highland, meadow). The engine has no built-in generator: terrain() alone is flat
// ground; a game passes this preset (or its own height / groundType functions) explicitly:
//   import { terrainPreset } from '@threedog/terrain-noise';
//   engine.use(openWorld({ seed: 7, camera: 'follow', terrain: terrainPreset({ shape: 'island' }) }));
// Why its own package and not part of a style: the shape of the world (where hills, rivers and forests are) is gameplay, and a style
// pack holds looks only (packages/engine/docs/recipes/09-materials-lights-models.md). Swapping the picture must never move a river. The colors of these ground types belong
// to whichever style the game uses (e.g. style.terrain.biomeColors, keyed by the names below).
// height and groundType run in terrain workers, so they are pure: they read only their parameters (n.params is the options below) and Math.
// That is also why the river formula is written out in each of them (core/threads/threadPure.js recompiles a function in an empty scope, so a shared helper is out of reach): the numbers live once, in `river`.
// The ground type names are plain strings that vegetation rules, style colors and a game's footstep map match by name.

// Biome rules: checked top to bottom, the first match is the biome there (the last has no condition and is the default).
// Conditions (all optional): minHeight/maxHeight altitude, maxAboveWater height above water, minSlope slope, minTemp/maxTemp temperature 0-1,
// minMoist/maxMoist moisture 0-1, minRiver closeness to a river (0-1); any: [cond, cond] adds "and either of these holds" to the rule's other conditions.
export const BIOMES = [
  { name: 'beach', maxAboveWater: 1.3 },
  { name: 'snow', any: [{ minHeight: 46 }, { maxTemp: 0.2 }] },
  { name: 'rock', any: [{ minSlope: 0.8 }, { minHeight: 34 }] },
  { name: 'riverbank', minRiver: 0.05 },
  { name: 'wetland', minMoist: 0.62, maxHeight: 6 },
  { name: 'savanna', maxMoist: 0.4, minTemp: 0.5 },
  { name: 'forest', minMoist: 0.5 },
  { name: 'highland', minHeight: 16 },
  { name: 'meadow' },
];

/** Display names of the preset's ground types (describe() groundName): createEngine({ strings: terrainStrings }) or engine.i18n.add(terrainStrings) */
export const terrainStrings = {
  'zh-CN': { 'ground.meadow': '草地', 'ground.forest': '森林', 'ground.beach': '沙滩', 'ground.rock': '岩石', 'ground.snow': '雪地',
    'ground.wetland': '湿地', 'ground.riverbank': '河岸', 'ground.savanna': '草原', 'ground.highland': '高地' },
  en: { 'ground.meadow': 'meadow', 'ground.forest': 'forest', 'ground.beach': 'beach', 'ground.rock': 'rock', 'ground.snow': 'snow',
    'ground.wetland': 'wetland', 'ground.riverbank': 'riverbank', 'ground.savanna': 'savanna', 'ground.highland': 'highland' },
};

const DEFAULTS = {
  shape: 'hills',      // 'hills' | 'island' | 'canyon' (mesas) | 'flat' (gentle plain)
  heightScale: 1,      // multiplies the base land and hills around sea level (lows get deeper too, not only highs); `mountains` is a separate amount that heightScale does not scale, so the highest point may not rise with it
  mountains: 1,        // mountain strength
  rivers: true,        // carve rivers
  riverWidth: 0.03,    // river width (noise threshold, 0.02 narrow, 0.05 wide)
  river: { scale: 0.0022, offset: [40, -70], bank: 2.2, edge: 0.85 },   // noise behind the rivers; bank width in river widths; the share of depth outside the river itself
  biomes: BIOMES,
  tempScale: 0.0011, moistScale: 0.0014, tempLapse: 0.006,   // temperature / moisture noise scale; temperature drop per meter of altitude
  noise: { baseScale: 0.0035, baseAmp: 46, hillScale: 0.016, hillAmp: 10, mountainScale: 0.0018, mountainAmp: 900, mountainThreshold: 0.52, seaBias: 0.42 },
  island: { center: [0, 0], radius: 700, falloff: 350, depth: 30 },
  canyon: { scale: 0.004, depth: 40, plateau: 14 },
};

/** Height in meters (pure: runs in workers) */
function height(x, z, n) {
  const P = n.params, N = P.noise, fbm = n.fbm, smooth = t => t * t * (3 - 2 * t);
  const hills = () => {
    const base = fbm(x * N.baseScale, z * N.baseScale, 4);
    const hl = fbm(x * N.hillScale + 71, z * N.hillScale - 33, 3);
    const m = Math.max(0, fbm(x * N.mountainScale + 500, z * N.mountainScale + 200, 4) - N.mountainThreshold);
    return ((base - N.seaBias) * N.baseAmp + (hl - 0.5) * N.hillAmp) * P.heightScale + m * m * N.mountainAmp * P.mountains;
  };
  let h;
  if (P.shape === 'flat') h = (fbm(x * 0.01, z * 0.01, 2) - 0.5) * 2 * P.heightScale + 4;
  else if (P.shape === 'island') {
    const I = P.island, d = Math.hypot(x - I.center[0], z - I.center[1]), t = Math.min(1, Math.max(0, (d - I.radius) / I.falloff));
    h = hills() * (1 - t) + 6 * (1 - t) - I.depth * smooth(t);
  } else if (P.shape === 'canyon') {
    const C = P.canyon, r = Math.abs(fbm(x * C.scale + 13, z * C.scale - 7, 4) - 0.5) * 2;
    const terrace = Math.floor(fbm(x * 0.01, z * 0.01, 2) * 4) / 4;
    h = C.plateau + terrace * 8 - C.depth * Math.pow(1 - Math.min(1, r * 3), 2);
  } else h = hills();
  // rivers: thin bands where noise is near 0.5 are dug below the water surface
  if (P.rivers) {
    const R = P.river, r = Math.abs(fbm(x * R.scale + R.offset[0], z * R.scale + R.offset[1], 3) - 0.5), w = P.riverWidth, bank = w * R.bank;
    if (r < bank) h = h + (n.waterLevel - 1.6 - h) * Math.min(1, smooth(1 - r / bank) * (r < w ? 1 : R.edge) * 1.25);
  }
  return h;
}

/** Ground type from the biome rule table (pure: runs in workers) */
function groundType(x, z, h, sl, n) {
  const P = n.params, fbm = n.fbm, W = n.waterLevel;
  let tp, ms, rv;   // computed on demand; skipped if no rule uses them
  const temp = () => tp ??= fbm(x * P.tempScale + 300, z * P.tempScale - 90, 3) - h * P.tempLapse;
  const moist = () => ms ??= fbm(x * P.moistScale - 200, z * P.moistScale + 100, 3);
  const river = () => rv ??= (() => {
    if (!P.rivers) return 0;
    const R = P.river, r = Math.abs(fbm(x * R.scale + R.offset[0], z * R.scale + R.offset[1], 3) - 0.5), w = P.riverWidth, bank = w * R.bank, t = 1 - r / bank;
    return r >= bank ? 0 : t * t * (3 - 2 * t) * (r < w ? 1 : R.edge);
  })();
  // every plain condition of a rule AND, when the rule has `any`, at least one of its alternatives holds
  const test = c => (!c.any || c.any.some(test)) && !((c.minHeight != null && h < c.minHeight) || (c.maxHeight != null && h > c.maxHeight) ||
    (c.maxAboveWater != null && h >= W + c.maxAboveWater) || (c.minSlope != null && sl < c.minSlope) ||
    (c.minTemp != null && temp() < c.minTemp) || (c.maxTemp != null && temp() > c.maxTemp) ||
    (c.minMoist != null && moist() < c.minMoist) || (c.maxMoist != null && moist() > c.maxMoist) ||
    (c.minRiver != null && river() < c.minRiver));
  for (const rule of P.biomes) if (test(rule)) return rule.name;
  return P.biomes[P.biomes.length - 1].name;
}

/**
 * Closeness to a river at (x, z): 0 away from rivers, up to 1 in the middle of one. Pure; pass the noise helpers of a terrain built with
 * the preset, e.g. riverAt(x, z, createTerrain({ seed, ...terrainPreset() }).noise), to pick a dry spot before the engine starts.
 * @param {number} x
 * @param {number} z
 * @param {{ fbm: (x: number, z: number, octaves?: number) => number, params: any }} n
 */
export function riverAt(x, z, n) {
  const P = n.params;
  if (!P?.rivers) return 0;
  const R = P.river, r = Math.abs(n.fbm(x * R.scale + R.offset[0], z * R.scale + R.offset[1], 3) - 0.5), w = P.riverWidth, bank = w * R.bank, t = 1 - r / bank;
  return r >= bank ? 0 : t * t * (3 - 2 * t) * (r < w ? 1 : R.edge);
}

/**
 * Noise terrain preset: spread it into terrain() (or openWorld({ terrain })). Options override the defaults above; noise, island,
 * canyon and river merge field by field.
 * @example engine.use(terrain({ seed: 7, ...terrainPreset({ shape: 'island', rivers: false }) }))
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
export function terrainPreset(opts = {}) {
  const params = { ...DEFAULTS, ...opts };
  for (const k of ['noise', 'island', 'canyon', 'river']) params[k] = { ...DEFAULTS[k], ...(opts[k] || {}) };
  return { waterLevel: 0, height, groundType, params };   // this generator's rivers and coasts are carved toward sea level 0
}
