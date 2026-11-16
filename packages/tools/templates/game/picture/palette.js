// @ts-check
// __NAME__ palette: the picture's colors and key values, one copy for the whole game; lights.js, sky.js, post.js, materials.js and world.js read them.
// A PLACEHOLDER, not this game's look: a clear temperate day (soft blue sky, warm sun, muted earth and grass) with physically sensible light, so the
// first shot reads as an outdoor scene. Replace it with the game's own style before calling the game done (recipes 60 + 62; style packs: @threedog/starter-pictures).
// Change one value, take a shot (npx threedog shot --play), compare the numbers it prints, keep or undo (recipe 60). No value here is a target.
import { THREE } from 'threedog';

// Warm white, a little below 6000 K: daylight reads warm against a blue sky and cool shade (Unity's default sun is about this, 0xfff4d6). Pure white looks clinical, deep orange looks like a style.
const SUN = 0xfff2dc;

export const palette = {
  // Tone curve: how light above 1 rolls off into the screen. AgX keeps hues in bright light, Neutral keeps colors closer to as written, NoToneMapping suits flat color.
  toneMapping: THREE.AgXToneMapping,
  // Brightness after lighting: right when shot's "overexposed" share stays near 0 on what matters and "dark" is only where you meant darkness.
  exposure: 1,
  background: 0xb8c8d8,   // behind everything when nothing is drawn there (a pale daytime blue-grey, so a scene without a sky() is not on gray); a sky() dome draws over it
  // With a sky(): the dome's day, rows [time 0-1, zenith, horizon, sun color, ambient] (recipe 08 §3). Saturation stays low on purpose (a hazy temperate sky, not a poster blue)
  // so any genre can push it; the horizon is paler than the zenith because that is where the air is thickest, and the fog takes the horizon color.
  // Dawn and dusk are short and warm only at the horizon; by 0.32 the day colors hold, so a morning start does not look like sunset. Night is dark because the light is (lights.js).
  sky: [
    [0.00, 0x0b1222, 0x1a2338, 0x8a9cc8, 0.3],
    [0.20, 0x0f172a, 0x283048, 0x8a9cc8, 0.3],
    [0.25, 0x51658a, 0xd2a888, 0xffc898, 0.8],
    [0.32, 0x6288b8, 0xb8cce0, SUN, 1.1],
    [0.50, 0x5a82b8, 0xb4cae2, SUN, 1.2],
    [0.68, 0x6288b8, 0xbccbdc, SUN, 1.1],
    [0.75, 0x4e5e88, 0xd8a684, 0xffbe8c, 0.8],
    [0.80, 0x0f172a, 0x283048, 0x8a9cc8, 0.3],
    [1.00, 0x0b1222, 0x1a2338, 0x8a9cc8, 0.3],
  ],
  // The key light: it casts the shadow, and its strength against the fill below sets how deep shadows look (shot's light: fact is that ratio).
  // color: used without a sky(); with one, lights.js takes the sky rows' sun color (warm at dawn and dusk, SUN by day).
  // shadowRadius: blur of the shadow edge in shadow-map texels (higher for cloud or a gentle look, low for a crisp sun); shadowMap: map size per engine.tier (lights.js follows a tier change).
  // direction: toward the sun when the game has no sky() (with one, the sky aims it); from the side and above, so each form shows a lit and a shaded face.
  sun: { color: SUN, noon: 3, direction: [0.7, 1, 0.3], shadowRadius: 3, shadowMap: { low: 1024, high: 2048 } },
  // The fill: light from every direction (lights.js), so faces away from the sun show their shape instead of going black; Standard and Lambert materials take it.
  // More: softer, more readable shadows; less: harder (shot's light: fact shows key against fill). sky: the strength with a sky(), whose dome is the map
  // (shade takes its color, night darkens it); room: without one, a neutral studio map that is brighter, hence the lower number.
  environment: { sky: 1, room: 0.25 },
  // Fog, only with a sky(): the far edge of the world melts into the horizon color instead of ending in a line. near / far are shares of uViewDistance.
  // Right when the play space stays clear (shot's "fog covers X%" is small where the player looks) and the distance dissolves.
  fog: { near: 0.3, far: 1 },
  // post.js. ao: darker creases and contact corners, radius in meters; right when objects sit on the ground and thin things get no dark halo.
  // bloom: glow around light brighter than threshold (linear light, before the tone curve); right when lamps, the sun and magic glow and lit walls do not turn milky.
  post: { ao: { radius: 0.5, intensity: 1 }, bloom: { strength: 0.3, radius: 0.4, threshold: 1.5 } },
  // world.js, when the game has terrain(): ground type -> palette names (two blend by noise). Muted, mid-dark earth tones: real grass and soil reflect
  // little (albedo about 0.1-0.25), so lighter or more saturated ground turns pastel under the sun and leaves nothing for props and characters to stand out against.
  // The type names are the terrain generator's (@threedog/terrain-noise BIOMES, plus 'cliff' for island walls and 'tilled' / 'wet' for paint); a type left out is gray.
  ground: {
    colors: { grass: 0x627443, grass2: 0x767c4a, leafy: 0x505e3a, soil: 0x6a5a42, dry: 0x968a5c, dry2: 0x857a50, moss: 0x52603c,
      sand: 0xb8a882, sand2: 0xa89a76, rock: 0x7c776e, rock2: 0x68645c, snow: 0xe4e8ec, mud: 0x4c4234 },
    biomeColors: { meadow: ['grass', 'grass2'], forest: ['leafy', 'grass'], highland: ['grass2', 'dry2'], savanna: ['dry', 'dry2'], wetland: ['moss', 'leafy'],
      riverbank: ['soil', 'moss'], beach: ['sand', 'sand2'], rock: ['rock', 'rock2'], cliff: ['rock2', 'rock'], snow: ['snow', 'snow'], tilled: ['soil', 'mud'], wet: ['mud', 'mud'] },
    // How the two colors mix (meters): a blend shorter than the default and a mild per-cell grain and large patches, so the ground near the player is not one flat tone
    variation: { blend: { size: 14 }, jitter: { min: 0.88, range: 0.2 }, patches: { size: 60, strength: 0.12 } },
  },
  water: 0x3e5c66,   // engine.water's plain material, when the game has water: a dark blue-green, darker than the ground, so shores read; the fog and fresnel lighten the distance
  material: { color: 0xa8a49c, roughness: 0.9 },   // the default surface: a light warm gray, a stand-in that reads as "not made yet" without looking cold
  // Placeholder capsules (engine.characters.material, world.js): light, so the player reads by value against the darker ground at any hue the game later picks.
  character: { color: 0xd8d0c2, roughness: 0.7 },
};
