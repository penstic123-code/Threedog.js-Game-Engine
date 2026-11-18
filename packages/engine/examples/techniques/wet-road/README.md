Wet road: a road that gets wet in rain and dries after, with soft-edged puddles and lamp / window reflections that still work at night.

# Wet road (technique example)

A neutral gray street whose road gets wet when it rains and dries some time after. Run `npm run dev` and open `/wet-road.html`
(`?time=22:00`, `weather=rain|clear`, `wet=0..1` holds wetness, `mask=1` shows the puddle mask, `streaks=0`, `puddles=0`). The engine never
imports this folder.

## The principle
**Wet = darker + glossier, not just darker.** Water fills the pores of a rough surface: less light scatters back (albedo drops) and the
surface turns into a mirror-ish film (roughness drops). Darkening alone reads as a dirty or shadowed road; the gloss is what says "wet".
Porous materials (asphalt, stone, soil) darken a lot, glazed tile or metal hardly at all.

**Gloss needs something to reflect.** A glossy surface with nothing bright around it only looks darker. By day it reflects the sky; at night
the sky is dark and what the eye reads on a wet street is long vertical streaks of the bright things (lamps, windows, signs); everything else
is too dark to matter.

**Puddles are a mask with soft edges.** A soft band at the rim where the water thins out over the rough ground. A hard threshold gives opaque
black discs that read as holes. Under a puddle: albedo darker again, roughness near zero, and the normal flattened (standing water hides
bumps). Where puddles collect is a game decision: low spots, gutters, ruts.

**Follow the weather with a delay.** Rain wets gradually, and when it stops the road stays wet for a while before drying. Instant drying reads
as a switch, not weather. Games with a fast day cycle want shorter delays, slow walking games longer.

**Where a reflection sits.** The reflection of a point at height `h` is its mirror image `h` below the ground; a rough film smears it along
the view direction, which is why reflections on wet roads are vertical streaks.

How to judge it in a shot at the game's camera: by day the wet road is darker and at grazing angles picks up the sky; at night the lamps
leave streaks on it; every puddle fades out over a band of pixels; streaks are not brighter than the lamp they reflect.

## Plain three.js
- Wetness: lower `color` and `roughness` on [MeshStandardMaterial](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial), ideally
  per pixel through a mask in `onBeforeCompile`; `MeshPhysicalMaterial.clearcoat` is another way to put a glossy film on top.
- Sky reflection: `scene.environment` from a `PMREMGenerator` ([webgl_materials_envmaps](https://threejs.org/examples/#webgl_materials_envmaps)).
- True mirror: `Reflector` from `three/addons/objects/Reflector.js` ([webgl_mirror](https://threejs.org/examples/#webgl_mirror)): renders the
  scene twice, flat planes only.
- Screen-space reflections: `SSRPass` ([webgl_postprocessing_ssr](https://threejs.org/examples/#webgl_postprocessing_ssr)).
- Faked streaks: an [InstancedMesh](https://threejs.org/docs/#api/en/objects/InstancedMesh) of additive quads on the ground, placed per emitter.

| Approach | Cost | What it gets right | Where it breaks |
|---|---|---|---|
| Environment map (`scene.environment`; this example bakes its sky) | free once set up | daytime sky in puddles and gloss at grazing angles | nothing local: lamps, windows, cars are missing; at night it is almost black |
| Real lights' specular (GGX) | free with lights you already have | exact highlight of each real light on low roughness | only real lights (a light pool has a handful), tiny on puddles, windows and signs are not lights |
| three's `Reflector` on the ground plane | renders the scene twice | true mirror image of everything | flat plane only, mirror-sharp unless you blur it (more passes), doubles draw calls; too costly for a whole street |
| Screen-space reflections | a full-screen pass, heavy on integrated GPUs | local reflections of what is on screen | nothing off screen (the sky, lamps above the frame), noisy on rough water, needs depth / normal buffers |
| **Faked streaks** (this example) | one instanced draw, CPU work per emitter per frame | the night look: long vertical smears of every lamp, window and sign | not occluded by objects between emitter and road, flat ground only, no reflection of unlit objects |

## Style routes
- **Realistic**: darken + lower roughness, sky env by day, the real lights' specular, faked streaks at night (this example's mix); SSR on
  desktop if local reflections matter. Free to one full-screen pass.
- **Toon / flat**: keep the wetness state and the mask, swap the gloss for a band of lighter color or a rim, and draw the streaks as
  hard-edged stripes in the palette. Cheaper.
- **Painterly**: drive the mask with your brush texture instead of value noise; soft, wide streaks.
- **Pixel art**: snap the streak quads to the pixel grid and drop the gaussian for two steps of color.
- **Mirror-pool set piece**: one small `Reflector` for a single hero puddle. One extra scene render.
The parts that carry over to every route are the wetness-from-weather state, the shared mask, and placing reflections at the mirror point.

## The engine helper (optional convenience)
`threedog examples pull wet-road` copies it. Only `wetRoad.js` is the technique (defaults in `WET_ROAD_DEFAULTS`); `main.js` and `picture/` are the
demo scene and its picture, plain three.js. In a game:
```js
const wet = createWetRoad(engine, { materials: [roadMaterial], bounds: [-5, -130, 5, 30] });
wet.addStreak(lampHead.position, { color: 0xffc890, intensity: 1.6 });   // per emitter; .set({ intensity }) when it switches on / off
```
- Surface: set `darken` per material family. The example darkens to `0.6` and caps roughness at `0.32`; lower `wetRoughness` is shinier and
  more "just rained". By day give it an environment: write `scene.environment` (`picture/sky.js` bakes its
  sky through `PMREMGenerator`).
- Puddles: world-space noise thresholded with `smoothstep(t - soft, t + soft, n)`; check with `mask=1`. Puddles grow in after the film is there
  (wetness above 0.35) and shrink first when drying. Multiply the mask by your own low-spot or rut texture for gutters and tire tracks.
- Weather: the wetting rate scales with `weather.current.rain`; after rain the road stays wet for `dryDelay` seconds before drying over
  `drySeconds`. The example uses 25 s / 40 s / 120 s.
- Streak placement: the camera sees the mirror point at an angle `th` below the horizon; the wet film smears it by `±streakSpread` in angle.
  Turning those two angles back into ground distances (`cameraHeight / tan(angle)`) gives where the quad starts and ends; the far end stops at
  the emitter's foot. A gaussian along the quad, centered at the mirror point and stretched separately on each side, keeps the smear even in
  screen space. Its strength is multiplied by the same puddle noise the surface uses (`streakFilm` on bare wet film, full in puddles) and cut
  to `bounds`. Larger `streakSpread` = rougher film, longer streaks; 0.02 is a still puddle.

Cost (the demo street, 960x540): one noise of 3 octaves in the road's fragment shader (the mask), done once more in the streak shader; one
extra draw call for all streaks (up to 128); a few dozen vector operations per emitter per frame on the CPU. No render target, no extra pass.

Common mistakes:
- Opaque dark puddle discs: hard threshold or puddles drawn as separate black meshes. Use the soft mask and lower roughness instead.
- Only darkening: no gloss, so it reads as shadow or dirt.
- Streaks everywhere with the same strength: they belong on water, stronger in puddles, and off the curbs (`bounds`, or a stencil bit for
  irregular roads).
- Streaks brighter than the lamp: keep their intensity near the emitter's.
- Drying instantly when the rain stops.

Rules (correctness):
- Road materials must be `MeshStandardMaterial` / `MeshPhysicalMaterial`: wetness is mostly a roughness change, Lambert has none (it throws).
- The surface change is a material patch (`applyEffects` with slots `color`, `roughness`, `normal`, `output`), never an edit of three's global
  `ShaderChunk`: other materials stay untouched and the patch shares one program across every road material.
- Wetness advances in `engine.onFixed` (game time), so pausing, `engine.freeze` and time skips behave. It is not saved: after a load it starts
  from the current rain (wet if raining). Save `wet.wetness` yourself if a dried-out-later road matters to your game.
- Streak intensities are linear light, added after lighting: keep them in the same range as the emitters' `emissiveIntensity` or they will
  outshine what they reflect.

Sources: written for this example; no code copied. Background: the mirror-image construction is basic optics; wet-surface shading follows
the common darken + lower-roughness approach discussed in Sébastien Lagarde, "Water drop 2a / 2b – Dynamic rain and its effects" (2013);
`Reflector` and SSR as found in the three.js examples (`webgl_mirror`, `webgl_postprocessing_ssr`).

This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). TSL version: recipe 56.
