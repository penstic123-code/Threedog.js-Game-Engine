# Lights, fog, exposure and environment lighting

> **Covers:** lights, fog, exposure, environment maps, probes, lightmaps, light you can see in the air.
> **Use when:** lighting a scene or making its light change.
> **Shortest:** your own `THREE.DirectionalLight` added in `picture/`.
> **Sections:** Lights the placeholders, and · Fog plain three.js, signals · Exposure and the tone · Environment maps · Light probes baked indirect · Lightmaps baked light on · Real-time bounced light WebGPU · Reflections · Light you can see · Soft shadows, area lights · Occlusion culling

Lights, fog and exposure are your own three.js code ([recipe 62](62-picture-code.md)): the sky computes signals and draws its dome, it writes none of them. The sky itself is `08-weather-sky.md`.

## Lights: the placeholders, and your own
The engine has one directional light (`engine.lights.sun`) and one hemisphere (`engine.lights.hemi`): still white placeholders (sun 2 at (40, 80, 30) with soft shadows, hemi 1.2), so a scene
with no picture code is neutral gray and not black. Nothing moves them, with or without a sky.

```js
const engine = createEngine({ canvas, lights: false });  // the placeholders stay out of the scene
const sun = new THREE.DirectionalLight(0xffd0a0, 2); engine.scene.add(sun, sun.target);  // add your own lights before engine.start()
engine.onRender(() => { sun.position.copy(engine.uniforms.uSunDir.value).multiplyScalar(100); sun.intensity = 2 * engine.uniforms.uDaylight.value * engine.uniforms.uWeatherLight.value; });
const torch = new THREE.PointLight(0xffa040, 6, 12); engine.add(torch);
```

- `createEngine({ lights: false })`: the placeholders never enter the scene; `engine.lights.sun` / `hemi` stay as detached objects so nothing reads `undefined`.
- Shadows: only the engine sun's box is managed. Your own `castShadow` lights work as in three.js (one shadow pass each); `engine.shadows` (recipe 45) takes those you hand in, and `engine.shadows.enabled = false` turns every shadow off.
- Add or remove lights before `engine.start()`; what a change costs mid-play, and many lamps with `lightPool`: recipe 09 "Lights and stalls".

## Fog: plain three.js, signals, your own math
```js
const fog = engine.scene.fog = new THREE.Fog(0x99bbbb, 60, 220);  // or new THREE.FogExp2(color, density)
engine.onRender(() => {  // a fog that follows the day and the weather: your picture/ code
  fog.color.copy(engine.uniforms.uSkyHorizon.value);
  fog.far = 220 / engine.uniforms.uWeatherFog.value;
});
```
There is no fog until your code makes one, and nothing writes it after that.

- Signals to read (table in recipe 62): fog in the color of `uSkyHorizon` hides the line where the dome meets the ground; `uWeatherFog` and `uViewDistance` feed your own fog distance.
- A fog color of your own that differs from the horizon: the dome fades its lower band to it, so fogged ground and sky still meet without a line.
- Color, near, far and density are live. Adding, removing or retyping `scene.fog` recompiles materials once: do it at a scene change.
- Your own fog math (height fog, a warm far haze): on WebGPU `scene.fogNode` (recipe 56); on WebGL the `fogPars` and `fog` slots on a material (recipe 43) or your own `ShaderMaterial`:
  `applyEffects(material, { patches: [{ name: 'haze', slot: 'fog', glsl: 'float f = 1.0 - exp(-fogDensity * vFogDepth); gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.85, 0.7), f * 0.3);' }] })`.
- Check the result with `engine.describe('picture').picture.fog`; `threedog shot` says how much of the picture the fog makes up.

## Exposure and the tone curve
```js
engine.renderer.toneMappingExposure = 1.3;
engine.onRender(() => { engine.renderer.toneMappingExposure = 1 + 0.5 * (1 - engine.uniforms.uDaylight.value); });  // over the day: your picture/ code
engine.renderer.toneMapping = THREE.NeutralToneMapping;  // the curve; materials recompile on their next draw
```
The engine picks no curve: `renderer.toneMapping` stays three.js's default (`NoToneMapping`) until your code writes it. A curve of your own is a post effect in the `'tone'` slot (recipe 52).

Exposure that adapts like an eye (WebGPU): `engine.post.add(autoExposure({ min: 0.25, max: 4 }))` from `@threedog/post-effects/tsl` measures the average brightness on the GPU and eases toward `key`. It multiplies after everything that adds light, before tone mapping (`toneMappingExposure` still applies on top). Bloom runs before it, so in bright daylight large areas glow and are then darkened: raise bloom's `threshold`, or give bloom an `order` above 800. Narrow `min` / `max` for an authored look; `speedUp` / `speedDown` set how fast, on `engine.time`; a chain rebuild keeps the adapted value. It measures a 64x64 sample, so a small, very bright thing can nudge it. To judge: walk from daylight into a dark room; it should open up over a second or two.

## Environment maps
`scene.environment` is plain three.js and stays `null` until your code writes it. The background (the sky dome or a skybox) and the environment lighting are two separate fields.

```js fragment
const env = engine.sky.environment({ into: engine.scene });  // the sky as a map: follows the time of day; env.texture is the live map
engine.scene.environmentIntensity = 0.8;  // intensity and rotation are three.js
engine.scene.environmentRotation.y = Math.PI / 2;
env.remove();  // takes the map off, frees it
// an asset panorama: plain PMREMGenerator
const pmrem = new THREE.PMREMGenerator(engine.renderer);
engine.assets.useTexture('hdr/studio.hdr', t => { t.mapping = THREE.EquirectangularReflectionMapping; engine.scene.environment = pmrem.fromEquirectangular(t).texture; });
// a PMREM result of your own is used as it is
engine.scene.environment = myPmremTarget.texture;
```
On `renderer: 'webgpu'` take `PMREMGenerator` from `three/webgpu`. A map you made is yours to dispose.

### The sky as a map: `engine.sky.environment({ into?, interval? })`
- Nothing is built before this call. Without `into` nothing is written: put `handle.texture` (a live getter) on the materials you choose (`material.envMap`).
- With `into`, that object's `.environment` gets the map at each rebuild. A map you write there yourself stays: the rebuilds go on, but only `handle.texture` follows them.
- The dome is rendered into a cube (at least 256 px a face) and prefiltered with `PMREMGenerator`, rebuilt only when sky colors, sun direction or cloud cover changed
  AND `interval` seconds passed (default 1, 4 on a low tier; yours stands). A fixed time of day builds once; a call before the first frame waits for it. A second call replaces the first.
- An asset map is a fixed photo: it does not dim at night. Write `scene.environmentIntensity` from your own frame code reading `engine.uniforms.uDaylight`.

### What a MeshLambertMaterial does with it (three 0.187)
The engine's neutral materials are Lambert: they get soft ambient light colored by the environment by direction, and no specular (reflections need Standard / Physical).
The hemisphere light still adds on top, so lower it when the environment comes on. The first frame with an environment recompiles every Lambert program once: do it at start-up.
- Toon, Basic and ShaderMaterial surfaces ignore it.

## Light probes (baked indirect light)
An environment map lights everything as seen from one point. Light probes (`engine.bakeProbes`) record how the light changes from place to place (a colored glow beside
a bright wall, dimmer light under a roof), and every lit pixel takes its own light from the grid, on WebGL and WebGPU, with no shader of your own.
```js fragment
const probes = await engine.bakeProbes({ bounds: { min: [-30, 0, -30], max: [30, 8, 30] }, spacing: 4, include: o => !o.userData.moving });
const file = JSON.stringify(probes.toJSON());  // ship this (half precision, a few tens of KB)
const shipped = engine.loadProbes(json);  // at start-up, instead of the bake; either renderer reads either renderer's file
probes.sample(cart.position);  // the SH at any point, for a "how dark is it here"
probes.remove();
```
- What it builds: three's probe grid over `bounds` (step at most `spacing`, at least 2 layers per axis) as `probes.grid`, a plain three.js light that costs almost nothing per frame:
  `priority` and `visible` are yours; `intensity` works on WebGPU only.
- **Outside the grid there is no probe light** (half a step past `bounds`), and with no other ambient light a mesh goes black there: size `bounds` to where things are.
- **Light counted twice**: the bake saw the hemisphere light, the environment and any `material.lightMap`, and they still add at run time. Lower them where the probes take over, or bake without them (a warning and describe say so).
- Dark bake indoors: `scene.background` is a display color, far weaker than the sun. Raise it (or `backgroundIntensity`) just for the bake, and keep a little fill for walls no window sees.
- Cost: 6 renders per probe, a few per task, so the page keeps drawing (`probes.bakeMs`). Bake once and ship the JSON: phones often cannot bake, all read the file. Meshes `include` rejects are hidden only while the cubes render. Adding a grid recompiles lit materials once: at start-up.
- Check it: `engine.describe().render.probes` (count, step, source, owner, `outside`: lit objects the grid does not hold, `doubled`: what counts twice) and `engine.debug.view('probes')` (a dot per probe in its average color).

## Lightmaps (baked light on what never moves)
The best-looking baked light, and free at run time: it is plain `material.lightMap` on a second UV set, so a file baked on WebGPU draws the same on WebGL. Baking needs a real GPU and Google Chrome on the machine that bakes, not on the player's.
```js fragment
floor.userData.static = true; wall.userData.static = true;  // named meshes that never move
// npx threedog bake light --page "/?bake=1" --out public/light/level.lightmap --size 1024
const baking = new URLSearchParams(location.search).has('bake');  // the bake must see the lights the map replaces
if (!baking) {
  const light = await engine.loadLightmap('light/level.lightmap');  // once the level is built
  hemi.visible = false;  // the bake saw it: keep the sun, drop the ambient
}
floor.material.lightMapIntensity = 1.2;  // plain three.js, yours
```
- What is baked: sky and bounced light, by rays traced from every lightmap texel through the static meshes, so light stops at walls and a pillar shades what stands behind it. The sun stays real-time where it lands, so moving things keep their shadows, and its bounce is in the map. The game's hemisphere or ambient light is the sky during the bake, at the same strength: an open floor comes out as bright as under that light.
- Turning the ambient off: picture code that writes `intensity` every frame (the template's `picture/lights.js`) undoes a one-off write, so hide the light (`visible = false`) behind a URL flag as above, never in the palette: the next bake would see no sky. A bake that sees no light stops and writes nothing.
- Instanced and skinned meshes and anything moving cannot hold a lightmap: give them `engine.bakeProbes`. A grid also lights the baked meshes, so where the two overlap the light doubles; keep the grid's `bounds` to where the moving things go, or turn `lightMapIntensity` down.
- Files are large (half precision): 8 MB at 1024, 32 MB at 2048 before compression. Start small.
- Check it: `engine.describe().render.lightmap` lists `skipped` (instanced), `missing` (not found, or changed since the bake: bake again), `moved`, `doubled` (ambient light or a grid on top) and `shared` (an unbaked mesh on a baked material: give it its own).
- WebGPU and TSL: nothing changes. `material.lightMap` is read by node materials too, so there is no separate form.

## Real-time bounced light (WebGPU games only)

Bake first when the scene holds still: probes and lightmaps cost nearly nothing. Real-time bounce is for light that changes while the world stands (a moving sun, a carried lamp, a door opening). WebGPU only (table below).

```js fragment
import { voxelGI, temporalAA } from '@threedog/post-effects/tsl';
engine.post.add(voxelGI({ bounds: new THREE.Box3(min, max), intensity: 1 }));
engine.post.add(temporalAA());  // clears the dots; it replaces MSAA while it is on
```

- `bounds` is the world box to voxelize. Keep it tight: the same voxels spread over a town are too coarse for a room. `describe().render.post` gives `voxelSize`; judge it against the smallest thing that should throw color.
- Lights can move every frame. Geometry cannot: moving things go outside the volume (`setup: gi => gi.volume.layers...`), and a rare change (a wall falls) calls `gi.needsUpdate = true`, a stall.
- It bounces direct light only; sky light stays yours (a low hemisphere or environment light). To judge: a colored wall should tint what stands next to it, and a sunlit floor should lift the ceiling, without the shadows turning flat. A toon look may want only one soft bounce; a realistic interior more, with less fill.
- A chain change at or before it (add, remove, on / off, a rebuilding setting, MSAA or a new scene buffer) voxelizes the scene again, a stall: set the chain at a scene change. Effects after it (a vignette, grain) switch freely: the chain is rebuilt only from the first changed place.
- `occlusion` (0 to 1) darkens corners, direct light too, so it starts at 0.
- Where it is held (table below), give those players probes or a lightmap as the base.
- Does not work: metal bounces as diffuse; moving and transparent things are not in the bounce; one volume cannot cover a big open world.

What runs where (held: the game's `enabled` stays, the effect costs nothing, `describe().render.post` says why):

| Case | voxelGI | reflections (held on 'low'), temporalAA, sunShafts, lightVolumes, autoExposure |
|---|---|---|
| Real WebGPU | runs (held on `engine.tier` 'low') | run |
| WebGL2 backend (no WebGPU or `forceWebGL: true`) | held | run |
| Fell back to `WebGLRenderer` | held | held |
| Game chose WebGL (`--webgl`, `WebGLRenderer`) | throws by name | throw by name |

## Reflections

Screen-space (three's `SSRNode`): only what is on screen, elsewhere the environment map.

```js fragment
import { reflections } from '@threedog/post-effects/tsl';
const shine = engine.post.add(reflections({ maxDistance: 5 }));
shine.set({ intensity: 0.8 });  // in place
```

- It follows metalness (0 and Lambert: none), not base color; roughness blurs it; a wet road wants a little metalness.
- Known limits: where a ray hits, the environment's specular stays and the reflection adds on top (indoors lower the mirror's `envMapIntensity`, under open sky `intensity`, until a dark thing on it reads dark). Added after fog, a far wet road shows through thick fog: lower `intensity` or `maxDistance`.
- Cost: a screen-filling mirror at 1080p on an integrated GPU: +2.9 ms at the default `resolutionScale: 0.5`, +12.5 at 1 (sharp). It grows with pixels (pixel ratio too), `maxDistance` and `quality`.

## Light you can see in the air: sun shafts through a window, lamp cones

Pick by the light. These two are WebGPU only; a WebGL game keeps the depth haze of recipe 59.

```js fragment
import { sunShafts, lightVolumes } from '@threedog/post-effects/tsl';
engine.post.add(sunShafts({ light: engine.lights.sun }));  // sun through gaps
engine.post.add(lightVolumes({ bounds: new THREE.Box3(min, max) }));  // spot cones, point glows
```

- `sunShafts` (three's `GodraysNode`) marches the sun's shadow map, so the sun and whatever makes the gaps must cast shadows. It is made for air mostly in shadow (a room with a window, a forest); open daylight reads as haze, so lower `density` or leave it out. Raise `density` until the beam reads against the dark behind it, and stop before the far wall washes out.
- `lightVolumes` (three's `VolumeNodeMaterial`) fills a box of air and lights it from point and spot lights, shadows included. **The sun does nothing here**, three skips lights at infinity. It is dithered, so run `temporalAA` after it. `scattering: (tsl, { positionRay, density }) => ...` gives density per point for smoke or ground fog; times `uWeatherFog` (recipe 62) to follow the weather.
- Does not work: shafts from more than one light at once, cones through transparent glass. For crisp beams in open air, aim a spot light along the sun under `lightVolumes`.

## Soft shadows, area lights, translucency, lens flare

```js fragment
import { pcss } from 'threedog/tsl';
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.shadow.filterNode = pcss({ lightSize: 0.04, samples: 16 });  // before the first frame, as any filterNode
```

- `pcss` (WebGPU, DirectionalLight, cascades included): the edge widens with the caster-receiver distance, by `lightSize` per world unit (the sun about 0.01) up to `maxDistance`. About ten times PCF's lookups at `samples: 16`. The caster distance is found at four depths, each jittered per pixel, so a sloped caster's edge widens smoothly, with a fine static grain in wide edges.
- `RectAreaLight`: just add it, the engine loads three's tables for it on both renderers. No shadow; lights only MeshStandard / MeshPhysical.
- Light through skin, leaves, wax: three's `MeshSSSNodeMaterial` (`thicknessColorNode` ...), cheap, per light; three's `SSSNode` is screen-space shadows, not this. Glass, jade, liquid: `transmission` + `thickness` + `attenuationColor` on MeshPhysicalMaterial.
- Lens flare: three's `LensflareNode` (`three/addons/tsl/display/`) fed by `ctx.display.bloom` in a post effect of your own (recipe 52), or `LensflareMesh` on a light.

## Occlusion culling

`engine.occlusion.enabled = true` skips the engine's big things while something hides them: hlod cells and `engine.batching` groups. Works on both renderers. Ordinary objects are not watched. Turn it on only when heavy things stand behind others (a walled town, a building full of rooms). In a scene of many small things it is a loss: each box costs CPU, more so on WebGPU. Measure with `describe().render.occlusion` (`hidden`, `trianglesSkipped`) and the frame time, on and off.

- Not to be confused with `cameraOcclusion` of `collision()` (recipe 21: walls between camera and player) or `voxelGI`'s `occlusion` (darker corners).
- Culling hides things from `engine.camera` alone. Every other camera (a minimap, a mirror), shadows, `engine.rays`, a `THREE.Raycaster` of your own and `voxelGI`'s volume see them as ever; `visible` and `layers` stay yours.
- **Step mode hides nothing**: answers arrive over drawn frames, so under `threedog step` / `engine.step()` `hidden` stays 0 and `inspect perf` counts every draw. Judge occlusion with `threedog resume` and real time.
- Answers come a few frames late: camera moves and cuts are covered, a big occluder that moves fast (a falling wall) can show a gap for a few frames.
