// @ts-check
// __NAME__ palette: the picture's colors and key values, one copy for the whole game; lights.js, sky.js, post.js and materials.js read them.
// A neutral start, not a style: white light, gray surfaces, physically sensible amounts, so forms read as lit 3D from the first shot.
// Change one value, take a shot (npx threedog shot --play), compare the numbers it prints, keep or undo (recipe 60). No value here is a target.
import { THREE } from 'threedog';

export const palette = {
  // Tone curve: how light above 1 rolls off into the screen. AgX keeps hues in bright light, Neutral keeps colors closer to as written, NoToneMapping suits flat color.
  toneMapping: THREE.AgXToneMapping,
  // Brightness after lighting: right when shot's "overexposed" share stays near 0 on what matters and "dark" is only where you meant darkness.
  exposure: 1,
  background: 0x8c8c8c,   // behind everything when nothing is drawn there; a sky() dome draws over it
  // The key light: it casts the shadow, and its strength against the fill below sets how deep shadows look (shot's light: fact is that ratio).
  // shadowRadius: blur of the shadow edge in shadow-map texels (higher for cloud or a gentle look, low for a crisp sun); shadowMap: map size per engine.tier (lights.js follows a tier change).
  // direction: toward the sun when the game has no sky() (with one, the sky aims it); from the side and above, so each form shows a lit and a shaded face.
  sun: { color: 0xffffff, noon: 3, direction: [0.7, 1, 0.3], shadowRadius: 3, shadowMap: { low: 1024, high: 2048 } },
  // The fill: light from every direction (lights.js), so faces away from the sun show their shape instead of going black; Standard and Lambert materials take it.
  // More: softer, more readable shadows; less: harder (shot's light: fact shows key against fill). night: the share left at midnight when a sky() runs the day.
  environment: { intensity: 0.25, night: 0.3 },
  // Fog, only with a sky(): the far edge of the world melts into the horizon color instead of ending in a line. near / far are shares of uViewDistance.
  // Right when the play space stays clear (shot's "fog covers X%" is small where the player looks) and the distance dissolves.
  fog: { near: 0.3, far: 1 },
  // post.js. ao: darker creases and contact corners, radius in meters; right when objects sit on the ground and thin things get no dark halo.
  // bloom: glow around light brighter than threshold (linear light, before the tone curve); right when lamps, the sun and magic glow and lit walls do not turn milky.
  post: { ao: { radius: 0.5, intensity: 1 }, bloom: { strength: 0.3, radius: 0.4, threshold: 1.5 } },
  material: { color: 0xa0a0a0, roughness: 0.9 },
};
