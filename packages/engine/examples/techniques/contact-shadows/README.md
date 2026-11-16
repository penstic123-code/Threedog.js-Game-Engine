Contact shadows: make objects sit on the ground instead of floating (shadow box size, bias, fill balance, baked and screen-space AO, probes).

# Contact shadows (technique example)

A neutral gray scene with small objects on the ground and on a table. Demo: `npm run dev` in the engine package, open `/contact-shadows.html`
(`?mode=float` shows the failure, `&ao=1` the AO pass, `&probes=1` probes). The whole picture is plain three.js in `picture/`; `main.js` only builds
shapes. The engine never imports this folder.

## The principle
A cup on a table, a box on the floor, a character's feet: if nothing darkens the ground right where the object touches it, the eye reads a
gap, and the object hovers. What grounds it is a small, dark, sharp-ish shadow at the foot plus darkening in the creases between parts. Three
things usually remove that darkening together (`?mode=float` is the picture's loose settings, sized for a 140 m open world):
1. **The shadow map is too coarse for small things.** Shadow detail is texels per meter, nothing else. One sun map covers a box of
   `2 * extent` meters: `extent: 70` on a 2048 map is 140 m / 2048 = **6.8 cm per texel**. A 10 cm cup's shadow is one or two texels,
   blurred away by the soft filter.
2. **The bias pushes the shadow off the foot.** Acne is a sampling error of about one texel, so the bias that cures it scales with the texel.
   `normalBias` moves the lookup along the surface normal so flat ground does not shadow itself; 4 cm is right for 6.8 cm texels and far
   too much under a 10 cm cup: the shadow starts a few centimeters away from its base. Too low: stripes on the ground. Too high: shadows
   detach (peter-panning).
3. **The fill washes out what shadow is left.** A shadow is only the absence of the sun; what you see in it is the fill (hemisphere and
   environment light). When the fill is close to the sun, a shadow darkens the ground by 10-20% and reads as dirt, not contact.
A fourth cause is plain placement: an object 1 cm above its support also floats. Put it at `y = support + half height`.

Occlusion is geometry, not light: a crease or a foot is dark because the surroundings block the sky, which is why ambient occlusion (baked
or screen-space) grounds things even where the sun shadow is soft. Light probes are different: indirect light sampled at points; they do not
ground small objects by themselves, they make the fill vary so shadowed corners and the space under a roof are darker than open ground.

How to judge it: take a shot at the game's real camera and look at whether small things sit or hover. `threedog shot` prints "shadow area
... darkened by N%": the number rises when the fill comes down.
How strongly shadows should read is a decision for DESIGN.md, not a fixed value.

## Plain three.js
- Shadow box: a `DirectionalLight`'s `shadow.camera` is an `OrthographicCamera`; its `left/right/top/bottom` set the box, `shadow.mapSize`
  the texels ([DirectionalLightShadow](https://threejs.org/docs/#api/en/lights/shadows/DirectionalLightShadow),
  [LightShadow](https://threejs.org/docs/#api/en/lights/shadows/LightShadow) for `bias`, `normalBias`, `radius`). Long views use cascades
  ([webgl_shadowmap_csm](https://threejs.org/examples/#webgl_shadowmap_csm)).
- Fill: [HemisphereLight](https://threejs.org/docs/#api/en/lights/HemisphereLight) intensity and `scene.environment` /
  `material.envMapIntensity`.
- Screen-space AO: `GTAOPass` in `three/addons/postprocessing` ([webgl_postprocessing_gtao](https://threejs.org/examples/#webgl_postprocessing_gtao)).
- Baked AO: write occlusion into a vertex `color` attribute with `material.vertexColors = true`, or into an `aoMap` from a DCC tool.
- Probes: [LightProbe](https://threejs.org/docs/#api/en/lights/LightProbe) with `LightProbeGenerator` from a cube render.
- A blob shadow: a transparent quad with a radial gradient texture under the object, `depthWrite: false`.

## Style routes
- **Realistic**: a tight shadow box, small texel-sized bias, a fill low enough that shadows read, plus AO in the creases. Costs shadow-map
  tuning and possibly a screen AO pass.
- **Pastel / flat-shaded**: the same box and bias, a gentler fill (soft shadows read as color, not black). No extra cost.
- **High-contrast / noir**: a lower fill, perhaps a tinted hemisphere ground color. No extra cost.
- **Toon whose material ignores light**: contact only from vertex AO or a blob decal under the object. One quad per object, no shadow map.
- **Big open world**: keep a wide box for the far view and use cascades (`engine.shadows.cascades(sun)`); bias, fill and vertex AO still apply.
- **Interiors with strong bounce** (a sunlit room): probes, baked once and shipped.

## The helper (optional convenience)
`contactShadows.js` writes plain three.js on the lights you pass in. `applyContactShadows(engine, { sun, hemi })` does steps 1-3 below (and 5 with
`ao: true`); it returns `{ remove(), describe() }`, and `remove()` writes back the values it found. `groundStatic(geometry)` bakes vertex AO with
the ground as occluder (wraps `bakeVertexAO`). `shadowTexelCm()` gives one texel in centimeters. The starting values sit in `PARAMS` (tied to this
example's 16 m scene; your game picks its own); `threedog examples pull contact-shadows` copies the file, then tune `PARAMS` against your DESIGN.md picture.

| Step | What | Cost (1280x720, laptop GPU, this demo) |
|---|---|---|
| 1. Size the shadow box to what the player sees up close | `sun.shadow.camera` left/right/top/bottom at 8 m: 16 m / 2048 = **0.8 cm per texel** | none: same map, same draws (4.1 -> 4.3 ms a frame) |
| 2. Bias in texels, not by habit | `normalBias` about 1.5 texels (1.2 cm here), `bias` near 0; re-check after changing the box | none |
| 3. Fill balance | `hemi.intensity` x 0.4: shadows read clearly darker (shot picture numbers) | none |
| 4. Baked vertex AO on static code-built models | `groundStatic(geometry)`: dark foot, dark creases between parts | load time only: ~95 ms for 880 vertices x 32 rays; 0 per frame |
| 5. Screen-space AO (optional) | `applyContactShadows(engine, { sun, ao: true })` (GTAO from `@threedog/post-effects`) | **+6.3 ms a frame** (4.3 -> 10.6 ms): only where contact must hold for moving things too |
| 6. Light probes (optional) | `await engine.bakeProbes({ bounds, spacing })`: bounce light, darker under roofs, lighter beside a sunlit wall | load: 3.6 s for 75 probes (ship the JSON, `engine.loadProbes`); +0.8 ms a frame |
| Bigger map instead | `mapSize: 4096` | +0.6 ms a frame and 4x the shadow memory; try a smaller `extent` first |

Measured with `engine.step` + a 1 px `readPixels` per frame, median of 120 frames. Notes:
- The box centers on `sun.target`. `picture/lights.js` keeps the target on `engine.focus`, so a compact box is fine for a third-person or fixed
  camera; the far ground loses its sun shadow, which is what cascades are for (`engine.shadows.cascades(sun, { count: 3 })`, recipe 45) when the view is long.
- A `scene.environment` lights Standard materials on top of the hemisphere light, so a strong environment plus a strong hemi doubles the fill.
- Which steps where: small props on tables, a tidy room, a yard: 1-3, plus 4 for every static code-built model (free at run time).
  Characters and moving props that must look planted close up: add 5 on desktop, keep it off on low-tier devices (read `engine.tier`, again on `'tier:change'`).

Rules (correctness):
- Vertex AO needs `vertexColors: true` on the material and vertices where the darkening should be; it is baked once, so only static geometry.
- The fill multiplies `hemi.intensity` once. Under a day-night cycle keep the time of day in `hemi.color` (as `picture/lights.js` does), or leave `hemi`
  out and multiply by the fill in your own mapping: a cycle that writes `hemi.intensity` each frame undoes it.
- After writing the shadow camera's box call `updateProjectionMatrix()`; after changing `mapSize` on a light that has drawn, dispose `shadow.map` and set it to null. The helper does both.
- `ao()` comes from `@threedog/post-effects`; install it in the game.

Common mistakes:
- Raising `mapSize` to 8192 before shrinking `extent` (16x memory for what `extent` gives free).
- Copying a `normalBias` from another game: it belongs to that game's texel size.
- Brightening the whole scene with hemisphere light "so shadows are not black": that is what makes everything float; lift exposure instead.
- Baking vertex AO on a 12-triangle box: the corners get it, the faces cannot (no vertices there; tessellate big faces).
- Turning on screen AO and leaving the fill at full: AO darkens creases inside a washed-out picture and looks like dirt.

Sources: written for this engine from the three.js docs (`LightShadow.bias / normalBias`, `GTAOPass`, `LightProbeGenerator`) and the common
shadow-mapping literature (Microsoft "Common Techniques to Improve Shadow Depth Maps"); no code copied.
