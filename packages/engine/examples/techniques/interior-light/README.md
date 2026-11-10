Interior light: sun through a window with shadows, the window as an area light, faked bounce with light probes or a fill light, exposure from outside to inside, and lamps at night without glare.

# Interior light (technique example)

A neutral gray room (8 x 6 m, 3 m high, a window in the west wall, a door in the south wall), lit from outside by day and by lamps at night.
Run `npm run dev` and open `/interior-light.html`. The engine never imports this folder.

| URL | What changes |
|---|---|
| `?cam=inside \| doorway \| outside` | the camera view (the zone, and so exposure and ambient, follows the camera) |
| `&fill=probes \| light \| none` | bounce baked into light probes (default), one cheap point light, or nothing |
| `&night=1` | night: lamps instead of the sun |
| `&area=0` | no window area light |
| `&leak=1` | keep the outdoor ambient indoors (shows the problem the zones solve) |

The whole picture is plain three.js in `picture/`; every value of it sits in `picture/palette.js` (`SUN`, `MOON`, `AMBIENT`, `WINDOW_LIGHT`, `BOUNCE_LIGHT`,
`EXPOSURE`, `LAMPS`, `SHADOW`, `SKY`). `main.js` keeps the shapes (`ROOM`, `WINDOW`, `DOOR`, `VIEWS`). Related: `sun-and-key-light` (the sun itself), `contact-shadows`, `night-lights` (lights in an outdoor night).

## The principle
**A room is lit from its openings.** Daylight enters in two parts: the sun (a hard patch on the floor, the brightest thing in the room) and
the sky seen through the window (a soft, cool light that falls off with distance from the window). Everything else is bounce: the sun patch
lights the ceiling and the walls around it. A room without bounce looks like a cave with one spotlight; a room where the bounce is as bright
as the patch looks flat.

**Outdoor ambient leaks.** Hemisphere and environment light reach every surface regardless of walls, so indoors they light the room as if
it had no roof. Turn them down inside and let the bounce do the fill. `?leak=1` shows the room with the outdoor values: evenly gray, the sun
patch barely stands out.

**Exposure is the eye.** Real interiors are many times darker than the street; the eye adapts, a camera changes exposure. Games compress the
range: inside gets a higher exposure, eased over about a second when the player crosses the threshold. Looking in from outside, the room usually
reads darker than the street (and from inside the window brighter than the room), which gives the space its depth; if your game wants a flat,
evenly lit look (a diorama, a cutaway), keep one exposure on purpose.

**Night: light the surfaces, not the bulb.** A lamp is a pool of light on a table, a wall, a floor. Hide the bulb in a shade, keep the visible
emitter dim, and let the light do the work; several small warm lights read cozier than one bright one. Glare and clipped white come from
bright visible emitters plus bloom; without bloom they just look like flat white shapes.

How to judge it in a shot: the sun patch is the brightest area, the wall opposite the window clearly dimmer, and the corner furthest from the
window dark but still readable if the game needs it readable. Check from the cameras the game really uses, including the doorway.

## Plain three.js
- Sun patch: a `DirectionalLight` with `castShadow`, every wall / ceiling / frame `castShadow`, and `shadow.camera` fitted to the room
  ([DirectionalLightShadow](https://threejs.org/docs/#api/en/lights/shadows/DirectionalLightShadow)).
- Window sky light: [RectAreaLight](https://threejs.org/docs/#api/en/lights/RectAreaLight) (the engine loads its tables when it enters the scene)
  ([webgl_lights_rectarealight](https://threejs.org/examples/#webgl_lights_rectarealight)).
- Bounce: a [LightProbe](https://threejs.org/docs/#api/en/lights/LightProbe) filled by `LightProbeGenerator.fromCubeRenderTarget` after a
  `CubeCamera` render inside the room; or a weak unshadowed `PointLight` above the patch; or a lightmap (`material.lightMap`, needs a second UV set).
- Exposure: ease `renderer.toneMappingExposure` and the `HemisphereLight` intensity together when the camera enters a box.
- Lamps: `PointLight` with `decay: 2`, intensity in candela ([PointLight](https://threejs.org/docs/#api/en/lights/PointLight)), a low
  `emissiveIntensity` on the shade.

## Style routes
- **Realistic**: probes or lightmaps for the bounce, a strong sun patch, exposure zones with a noticeable change. Costs a bake.
- **Stylized / cozy**: warmer bounce (`BOUNCE_LIGHT.color`), softer contrast between patch and room, more lamps at night, gentle exposure
  change. Costs a few more lights.
- **Horror / stealth**: little or no fill, a hard window patch, slow exposure adaptation so the player is blind for a moment at the door. Cheapest.
- **Top-down or isometric**: the ceiling is usually hidden; the window patch and lamp pools carry the room. For 2D-like spreading light that
  stops at walls see `examples/rc2d`.
- **Baked (static rooms)**: lightmaps from Blender give per-surface bounce at no run-time cost when the room does not change (recipe 46).

## The engine helper (optional convenience)
`threedog examples pull interior-light` copies `interiorLight.js` and this README into the game; the probes are `engine.bakeProbes` itself.
- `exposureZones(engine, { hemi, isInside, exposure, ambient, ease })`: changes exposure and the leaking outdoor ambient together, eased, and only
  when the zone changes. It writes `hemi.intensity`, `scene.environmentIntensity` and `renderer.toneMappingExposure`; call its `update(dt)` from
  `engine.onFrame`, and `update()` to jump to the zone's values at once. The page uses a box around the room and `EXPOSURE.day.outside` / `.inside`,
  eased over `EXPOSURE.ease` seconds.
- `windowLight(engine, { position, lookAt, width, height })`: a `RectAreaLight` placed in the opening and aimed.

| fill | what it gives | cost |
|---|---|---|
| `probes` | bounce from the actual sun patch and walls, colored by them, direction-dependent | a bake at load (6 cube renders per probe; `probes.bakeMs` says how long); at run time one LightProbe, about free |
| `light` | one unshadowed PointLight above the sun patch, standing in for its bounce | one more light in every lit shader; no bake. Simple and easy to tune, but it is a point, so it shows as a hot spot if too strong |
| `none` | the room as the direct lights leave it | nothing |

Measured in the test (linear light, the floor along the north wall and the wall's lower part, out of the sun patch): probes make them clearly
brighter than no fill (the test requires more than 1.15x).

Zones vs measured exposure: a zone is cheap and predictable, and the designer decides the values. Measured auto exposure (average the frame's
luminance, ease toward a target) adapts to anything but needs a downsample and readback every few frames, can pump when bright objects enter
the view, and still needs limits. A zone also carries the ambient change, which measured exposure cannot. Limit of zones: they follow the
camera, so looking into the room from outside it still gets outdoor ambient (`?cam=doorway`). When that view matters, give indoor surfaces
their own fill (a probe grid over each part, or lightmaps).

Night (`?night=1`): a very low moon (`MOON`), the indoor zone's exposure at 1, two warm PointLights (physical falloff,
decay 2, intensity in candela) inside shades with an emissive of 0.35; one casts a 512 px shadow (a point light shadow is six renders: give it
only to the light that needs it). With bloom (`@threedog/post-effects`), keep the emitter's `emissiveIntensity` low or it blooms across the room.

Rules (correctness):
- `RectAreaLight` lights only `MeshStandardMaterial` / `MeshPhysicalMaterial`, and **casts no
  shadow**: it lights through furniture and walls on its front side. Use it for the window's soft sky light or a screen, and keep the
  shadowed part to the sun (a DirectionalLight) or a SpotLight.
- The sun through a window needs every wall, the ceiling and the window frame to `castShadow`, and a shadow box that covers the room. `picture/lights.js`
  aims its own `DirectionalLight` and writes `shadow.camera` to fit the room. Thin walls want a small `normalBias` (here 1 cm) or light leaks along
  their inner edge.
- `engine.bakeProbes({ bounds, spacing })` bakes the scene as it is at that moment: set the indoor ambient and the lights first, and
  bake again (or ship one bake per state) if the lighting changes a lot (day / night). Probes add to the hemisphere and environment, which
  the bake also saw (recipe 34). Every pixel in the room takes its own light; outside `bounds` there is none,
  so a building seen from outside needs its own light.
- The bake renders after start; this page tracks it in `engine.loading` so screenshots and tests wait for it.
- Do not name page URL parameters `time` or `view` (or the other engine scenario keys: `weather`, `pos`, `season`, `state`, `save`, `wait`,
  `cutscene`): `?time=night` reaches the sky as a clock time, turns into NaN and blacks out the frame.

Sources: written for this repository, no code copied. Background: three.js `RectAreaLight` and `LightProbe` docs and examples (0.187), general
architectural-visualization and game-lighting writing on window light, bounce and eye adaptation.

This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). A game on the default WebGPU route writes the same ideas in TSL (recipe 56).
