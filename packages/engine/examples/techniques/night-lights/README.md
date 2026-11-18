Night lights: street lamps, lit windows and signs that read as light at night without glaring, and fade in at dusk.

# Night lights (technique example)

A neutral gray street at night with lamps, lit windows and signs. Run `npm run dev` and open `/night-lights.html` (`?time=22:00`, `halo=0`,
`bloom=0`, `glare=1` shows the classic mistakes all at once). The engine never imports this folder.

## The principle
A light at night is read from what it lights, not from how bright its bulb is: a pool on the ground that fades smoothly, a small hot core,
colored windows, and a night that is darker than all of them.

**Light pools come from distance and decay, not from big intensities.** Physical lights fall off as the square of the distance: with
`decay: 2` the ground under a lamp gets `intensity / height²`. A downward spot with a wide, soft cone puts the light on the ground and leaves
the facades above dark, like a real cut-off fixture. `distance` only cuts the tail; keep it a few times the lamp height so the edge comes
from decay.

**Which pixels bloom is the threshold's choice.** The tone curve (AgX on this page) compresses everything above ~1 toward white. Bloom adds light
around pixels above its `threshold` (linear, before the curve). Usually it sits between the windows and the lamp heads, so only the small heads
glow and windows and signs read as colored light; if your game wants a hazy, everything-glows night, set it lower on purpose.

**Emissive is a color, not a brightness knob.** Saturated emissive colors survive the tone curve; near-white ones have no headroom and clip
to flat white rectangles. Get the warmth from the color and let bloom carry the halo; the
intensities in this example are its values, not targets.

**Lights read when the night is darker than they are.** If the ambient at night is close to the pool brightness, the lamps look painted on.
Usually the night is darkened until the pools carry the scene, with enough left that the dark parts hold some shape; if your game wants a
bright, readable night, keep the ambient up and let the lamps be accents instead.

**A halo is cheap glow.** An additive sprite with a soft falloff around each head gives the "light in damp air" look without any post pass.

**Lights fade in.** A hard switch at 18:00 pops; fade by daylight.

How to judge it in a shot at the game's camera: the ground under a lamp is clearly brighter than half way to the next one, and the pool fades
without a ring; around a lamp only its core is white (the picture check of `threedog shot` / `threedog snap` names each light or glowing material that blows pixels out, and the detail lost under it); the "near black" share stays low enough
that shapes hold.

| Symptom | Cause | Fix |
|---|---|---|
| Lamp heads and windows are flat white blocks | emissive far above the tone curve's shoulder: everything clips to the same white | lower emissiveIntensity, use a saturated color; usually only the small lamp core clips (more if your game wants blinding light) |
| A wall next to a lamp is a bright blown-out sheet | `decay: 0` (or 1) and the light close to the wall: no falloff, the whole wall gets the full intensity | `decay: 2`, aim a spot down, move the light off the wall |
| The whole night scene glows and looks foggy | bloom threshold below 1: every lit surface blooms | threshold between window and lamp-head brightness |
| Everything is too bright or too gray at night | exposure or ambient set for the day | lower the night ambient (`NIGHT.hemi` in `picture/palette.js`) rather than the lights |
| Halo plus bloom look like a smear | both at full strength | pick one as the main glow, keep the other faint |
| Lights pop on at nightfall | a hard switch at 18:00 | fade by daylight (`dusk`) |

`?glare=1` on the demo page shows the first three at once.

## Plain three.js
- Lamps: [SpotLight](https://threejs.org/docs/#api/en/lights/SpotLight) aimed down with `decay: 2`, a wide `angle` and soft `penumbra`;
  intensity in candela ([webgl_lights_spotlight](https://threejs.org/examples/#webgl_lights_spotlight)). Many lamps: keep a fixed number of
  lights and move them to the nearest lamps, so the light count never changes.
- Windows and lamp heads: `MeshStandardMaterial.emissive` and `emissiveIntensity`, faded by a daylight value.
- Bloom: `UnrealBloomPass` with `threshold`, `strength`, `radius` ([webgl_postprocessing_unreal_bloom](https://threejs.org/examples/#webgl_postprocessing_unreal_bloom)).
- Halo: a [Sprite](https://threejs.org/docs/#api/en/objects/Sprite) with a radial-gradient texture, `blending: THREE.AdditiveBlending`,
  `depthWrite: false`.

## Style routes
- **Naturalistic**: pooled spot lights with decay 2, saturated warm windows, bloom only on lamp cores. One bloom pass.
- **Bloom-free / mobile**: halo sprites as the only glow, emissive windows. One sprite draw per lamp batch, no post pass.
- **Stylized / toon**: a projected decal or a baked light texture instead of the spot pool, a hand-drawn halo sprite, the window emissive as
  a palette color; decay 2 still gives pools an edge. No real lights at all if decals carry it.
- **Painterly**: soft wide pools, a colored fog around lamps, halos larger and fainter. Fog and sprites only.
- **Pixel art**: hard-edged pools in two or three palette steps, no bloom. A texture lookup.

## The engine helper (optional convenience)
`threedog examples pull night-lights` copies it. Only `nightLights.js` is the technique (defaults in `NIGHT_LIGHTS_DEFAULTS`) and it stands alone; `main.js` is the
demo scene and `picture/` its picture (sun, ambient, sky, fog, bloom, tone curve). In a game:
```js
engine.use(lightPool({ point: 4, spot: 8 }));      // real lights for the nearest lamps; the rest wait their turn
const lights = createNightLights(engine);
lights.addLamp(headPosition, { head: headMaterial });  // pooled spot aimed down + emissive head + halo
lights.addGlow(windowMaterial);                        // emissive fades in at dusk
```
This example's current values: 80 cd at 5.5 m, so the pool center is a little under the brightness a sunlit mid-gray gets (recipe 52 "How
bright a lit color comes out"); raise it for brighter streets, lower it for moody ones. Lamp heads at 2.5, windows at 0.6, bloom threshold 1.4.
The demo keeps its night ambient far under the pools (`NIGHT.hemi` in `picture/palette.js`). With bloom on, keep the halo's
opacity low; they stack.

Cost (the demo street): 8 pooled spot lights (no shadows) for any number of lamps; one emissive material per kind of glow; one sprite per lamp
sharing one material and a 64 px texture; bloom is one `UnrealBloomPass` (several half-resolution blur passes; costly on integrated GPUs, so
`picture/post.js` starts it off on low-tier devices). Spot shadows add one shadow map each (another pass over the casters): this example gives none; a game that wants lamp shadows picks its hero lamps and measures the frame time as it adds them.

Rules (correctness):
- Lamps take their real lights from `engine.lightPool` (`lightPool({ spot })`): a fixed number of three.js lights, so many lamps never
  recompile shaders or add per-light cost. Without the pool it throws.
- The night factor comes from the time of day (`engine.calendar.daylight`, the sky's when there is no calendar). Nothing here is saved: it
  is recomputed from the time each frame, so loads and time skips are right by construction.
- `addGlow` drives every mesh using that material: give dark windows their own material (the demo uses two lit ones and plain wall gray).
- The lamps' real lights fade through the pool (`lightPool.add(at, { dusk })`). Windows, signs, lamp heads and halos are not pool sources, so
  the technique applies the same curve at the same `dusk` to their `emissiveIntensity` and the halo opacity, in one `engine.onRender`.

Sources: written for this example; no code copied. Light units and falloff as documented for three.js physically based lights; the bloom pass
is three's `UnrealBloomPass` through `@threedog/post-effects`.

This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). TSL version: recipe 56.
