// The numbers inside the engine's shared shader functions, written once. render/effects.js builds the GLSL functions (threedogWind,
// threedogHash / threedogNoise, threedogCloudShadow), render/detail.js threedogDetailNoise and modules/sky the dome from them, and
// render/fx/*.tsl.js the TSL ones; the water surface numbers below serve modules/water's GLSL patches and render/fx/water.tsl.js alike.
// Why one file: the two versions used to carry their own copies of every constant, and only a screenshot comparison noticed when one side changed. Imports nothing (both sides use it,
// and the TSL side must not pull in effects.js, which registers ShaderChunks).

/** threedogWind: sway = sin(t * (speed + gust * uWind) + origin . phase) * weight + sin(t * speed2 + origin . phase2) * weight2; lean along x, side share on z */
export const WIND = Object.freeze({ speed: 1.2, gust: 0.6, phase: [0.31, 0.23], weight: 0.6, speed2: 2.9, phase2: [0.77, -0.4], weight2: 0.4, lean: 0.4, side: 0.6 });
/** threedogHash: the x of pcg2d (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering") on p's float bits (public) or the cell floor(p) (engine noise), as uints:
 * v = v * mul + add; v.x += v.y * mul; v.y += v.x * mul; v ^= v >> 16; v.x += v.y * mul; x ^= x >> 16; value = (x >> 8) / 2^24, so 0 <= value < 1.
 * Why integers and not the usual sin hash: sin of large arguments differs between GPUs and between GLSL and WGSL, so WebGL and WebGPU drew different
 * patterns; uint multiply / xor / shift wrap the same way everywhere, and a 24-bit uint turns into a float exactly. */
export const HASH = Object.freeze({ mul: 1664525, add: 1013904223 });
/** A whole-cell offset as the uint it adds to a cell's first pcg2d step (n * mul, wrapped to 32 bits): what the dabs add per salt @param {number} n */
export const hashOffset = n => Math.imul(n, HASH.mul) >>> 0;
/** threedogCloudShadow: two noise octaves (weight, then weight2 at octave x the scale), cover edge width */
export const CLOUD = Object.freeze({ weight: 0.65, octave: 2.3, weight2: 0.35, edge: 0.25 });

/** threedogDetailNoise (render/detail.js): fbm octave step (p = p * lacunarity + offset), paper = fbm * paper[0] + stretched noise * paper[1]
 * at (x * paperStretch[0], y * paperStretch[1]); stroke = smoothstep(stroke[0], stroke[1], fbm(x, y * strokeStretch)); dabs: first weight, then * dabFall per octave */
export const DETAIL = Object.freeze({ lacunarity: 2.03, offset: 17, paper: [0.65, 0.35], paperStretch: [7, 0.9], stroke: [0.15, 0.85], strokeStretch: 1.7, dabWeight: 0.85, dabFall: 0.6 });
/** The sky dome (modules/sky/shader.js, clouds.js): stars = threedogHash of the star cell g as (g.x + g.z * starZ, g.y) (no two cells of a
 * star grid up to starZ / 2 per side share a value); sun glow power; sun-below-horizon cut-off;
 * stars fade in over dir.y 0..starFade; clouds dim to nightDim at night; plane tone smoothstep(tone); cumulus fbm step / normalizer,
 * sun-ward probe step, cover share, core width, shading (rim boost, core darkening) */
export const SKY = Object.freeze({ starZ: 4096, glowPower: 12, sunCut: 0.05, starFade: 0.25, nightDim: 0.35,
  planeTone: [0.3, 0.8], lacunarity: 2.03, offset: 3.7, norm: 0.9375, toSun: 0.12, cover: 0.9, core: 0.35, rim: 0.5, coreDark: 0.45 });

/** Luminance weights: Rec. 709 for light (render/lighting.js, the sky's own light), Rec. 601 for a detail texture's alpha. Two sets on purpose: moving either shifts pictures */
export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]), LUMA_601 = Object.freeze([0.299, 0.587, 0.114]);

/** A number as a GLSL float literal (1 -> 1.0) @param {number} v */
export const glslFloat = v => { const s = String(v); return /[.e]/.test(s) ? s : s + '.0'; };

// Water surface defaults (GLSL modules/water/surface.js, TSL render/fx/water.tsl.js). They live here and not in modules/water so render/ imports
// no module file (R27); the water module imports them from render/, the allowed direction.
/** The built-in wave sum threedogWaterWave: sin(p.x * x[0] + t * x[1]) * x[2] + cos(p.z * z[0] + t * z[1]) * z[2] + sin((p.x + p.z) * xz[0] + t * xz[1]) * xz[2] */
export const WAVE = Object.freeze({ x: [0.21, 1.1, 0.12], z: [0.17, 0.9, 0.12], xz: [0.37, 1.7, 0.05] });
/** Height the built-in wave sum reaches (the three heights added): depthColor.by 'wave' and foam divide by it */
export const WAVE_MAX = +(WAVE.x[2] + WAVE.z[2] + WAVE.xz[2]).toFixed(4);
/** The fresnel patch: pow(1 - |view . normal|, power) * strength */
export const FRESNEL_POWER = 3;
/** Fallbacks when a style gives depthColor / foam without some values (light / dark neutral grays: the blend shows, no water color is picked) */
export const DEPTH = { shallow: 0xaaaaaa, deep: 0x555555, curve: 1 };
export const FOAM = { color: 0xffffff, start: 0.55, end: 0.85, opacity: 1 };
