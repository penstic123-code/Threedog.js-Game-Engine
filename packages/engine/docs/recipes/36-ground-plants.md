# Ground color and plants

> **Covers:** ground colors by height and slope, plants and their wind.
> **Use when:** coloring terrain or covering it with plants.
> **Shortest:** `terrain({ colors: { grass: 0x6a8a3a } })`.
> **Sections:** Ground color terrain { · Plants and wind

```js
import { terrainPreset } from '@threedog/terrain-noise';
engine.use(terrain({ ...terrainPreset(), colors: { grass: 0x6a8a3a, rock: 0x777066 }, biomeColors: { meadow: ['grass'], cliff: ['rock'] } }));
engine.terrain.material.flatShading = true;  // the ground's picture is a plain three.js material
engine.terrain.recolor({ colors: { grass: 0xa8a050, rock: 0x777066 } });  // what the workers baked in, changed at run time
engine.terrain.material = applyEffects(new THREE.MeshToonMaterial({ vertexColors: true }), { patches: engine.terrain.patches });  // your own, effects kept
engine.vegetation.material = applyEffects(new THREE.MeshToonMaterial({ vertexColors: true }), { patches: engine.vegetation.patches });
```

For an AI that wants the ground or the plants to look a way the defaults do not. Each section lists the engine default; code that sets nothing
gets it. None of these settings moves a hill, a river or a species list. The order of work from a reference picture is in `35-picture-from-reference.md`; which ground picture to pick, the color map and what to do when the ground looks wrong are in `53-ground-up-close.md`; the sky and clouds in `08-weather-sky.md`.

## Ground color: `terrain({ colors, biomeColors, steep, variation })`
Terrain colors are baked by the (worker) generator: two colors blended by a noise, a small brightness grain, and an optional layer of large patches.
`colors` names the colors, `biomeColors` gives each ground type one or two of those names, `steep` overrides them on slopes. A ground type with no
color is neutral gray. The `variation` defaults are shown (plain data, so it travels to the workers; unknown keys throw):
```js fragment
terrain({ colors: { ... }, biomeColors: { ... },
  variation: {
    blend:   { size: 33, strength: 1 },  // wavelength in m of the two-color noise; strength > 1 = harder contrast, < 1 = flatter
    jitter:  { size: 0.33, min: 0.92, range: 0.12 },  // grain cell in m; darkest multiplier; how much brighter it can get (0 range = no grain)
    patches: { size: 90, strength: 0.15, levels: 0, tint: 0xb59a5a },  // optional (example values): a second, large layer of color blocks
  } })
```
`patches` is off unless given. It is a noise much larger than `blend`; `levels: 4` snaps it to 4 flat steps (hard-edged color blocks instead of a
soft blend); without `tint` it lightens and darkens the ground, with `tint` it pulls the color towards the tint where the noise is high. Vertex colors
interpolate across a chunk cell (4 m at the default resolution), so blocks smaller than that blur; for crisp blocks use `shading: 'texture'`
(recipe 53) or a texture (next).

### Changing it at run time: `engine.terrain.recolor`
```js fragment
engine.terrain.recolor({ colors, biomeColors, steep, variation, shading, normals });  // every chunk is rebuilt; edits stay, collision does not change
engine.terrain.recolor({ detail: { noise: 'paper', strength: 0.2 } });  // only the material: no chunk is rebuilt
```
Each value is given whole, not merged, and `null` takes it out (`shading: null` goes back to what `terrain({...})` was given). Keys left out stay.
`recolor` throws under a picture that replaced `'terrain-draw'`, which draws the ground its own way.

### Your own ground material
`engine.terrain.material` is what every chunk draws with: a plain three.js material, neutral gray with vertex colors until you change it. Write to it, or
set your own at any time; `terrain({ material })` (a Material or `(engine) => Material`) does the same from the start. Setting it swaps the material on
every loaded chunk, regenerates nothing and adds nothing: a material of yours is drawn as given. To keep the cloud shadow, the season tint and the
detail layer, hand it `engine.terrain.patches`. `terrain({ material })` adds them for you unless `effects: false`. After a later `recolor({ detail })`
patch your material again; the engine only rebuilds its own.

Chunk geometry has `position`, `normal`, `color` and `uv = world xz / chunk size`, continuous across chunk borders, so a repeating texture is seamless whatever chunk it lands in. `texture.repeat.set(8, 8)` = 8 tiles per chunk. Without
UVs (steep sides stretch a top-down map), project from the world position in a patch instead (`needs.patches: ['world']` gives `vThreedogWorld`):
```js fragment
engine.terrain.material = applyEffects(new THREE.MeshLambertMaterial({ vertexColors: true }), { clouds: false, patches: [{
  name: 'triplanar', needs: { patches: ['world'] }, uniforms: { uTex: { value: groundTexture }, uTexScale: { value: 0.1 } },  // groundTexture: repeat wrapping
  glsl: { fragment: { pars: 'uniform sampler2D uTex; uniform float uTexScale;',
    color_fragment: `vec3 n = abs(normalize(cross(dFdx(vThreedogWorld), dFdy(vThreedogWorld)))); n /= n.x + n.y + n.z;
      diffuseColor.rgb *= texture2D(uTex, vThreedogWorld.zy * uTexScale).rgb * n.x + texture2D(uTex, vThreedogWorld.xz * uTexScale).rgb * n.y
        + texture2D(uTex, vThreedogWorld.xy * uTexScale).rgb * n.z;` } } }] });
```

### Detail layer
The lighter alternative, with no material of your own: `terrain({ detail })`, or `engine.terrain.recolor({ detail })` at run time. It takes
`noise: 'grain' | 'paper' | 'stroke' | 'dabs'`, or `texture: 'name'`, or your own `glsl`, and `scale`, `strength`, `fade` ... (keys in recipe 43). `engine.terrain.uniforms` are its `{ value }` objects, written directly and live:
`engine.terrain.uniforms.uDetailStrength.value = 0.2`.

## Plants and wind
`vegetation.define` works at any time after `engine.use`, before or after `content.load` and `engine.start`. A species named by a model (`model: 'oak'`) appears when its promise settles, so `vegetation.list()` right after
that call does not show it yet. To keep plants off a road or a yard, give the species a `densityMap: (x, z) => 0..1`, or a ground type of its own that the species' `biomes` leave out. Per-species options are in `../api/vegetation.md`; `castShadow` defaults to not `nearOnly`.
```js fragment
engine.vegetation.define('oak', { model: await engine.assets.model('oak'), wind: 0.02 });  // per species: its own material, wind, fade
engine.vegetation.define('fern', { geometry, material: new THREE.MeshToonMaterial({ vertexColors: true }), wind: 0.08 });
engine.vegetation.material = applyEffects(new THREE.MeshToonMaterial({ vertexColors: true }), { patches: engine.vegetation.patches });  // the shared default
engine.uniforms.uWindAmp.value = 0.5; engine.uniforms.uWindFreq.value = 2;  // how hard and how fast: plain signals, live (uWindAmp 0 = plants stand still)
```
`engine.vegetation.material` (species with no material or model of their own) is drawn as given, planted ones too: hand it `engine.vegetation.patches`
to keep the season tint, sway and `color()` code; `null` restores the default. A species' own amplitude and near fade need `define(name, { material })`,
which gets wind, cloud shadows, season tint and the fade unless `effects: false`; its live material is `engine.vegetationDraw.kind(name).material`.

The placement, rings and instancing are mechanism and stay (the whole picture is replaceable: recipe 28 section 6). The picture has three entries:
- **Sway shape**: built in, two sines with a phase from each plant's origin, weighted by height, leaning with wind strength. `engine.vegetation.sway(glsl)` replaces it (below).
- **Color**: `engine.vegetation.color(glsl | { glsl, tsl })` puts code in the `color` slot of every species, live.
- **Season tint**: `engine.sky.seasonTints = { mode: 'multiply' | 'mix', strength, autumn: { foliage: 0xffb070, ground: 0xc8a060 } }`, plain data read every frame, blended to the next season over the last fifth of a season. `'multiply'` (default) multiplies the surface; `'mix'` moves it `strength` (default 0.5) of the way to the color, so orange on green leaves stays orange instead of turning muddy.

```js
engine.vegetation.sway({ uniforms: { uSteps: 3 },  // stepped sway: plants snap between 3 poses instead of a smooth sine
  glsl: `void threedogWind(inout vec3 transformed, vec3 ip, vec3 position){
    float s = floor(sin(uTime * uWindFreq + ip.x * 0.3 + ip.z * 0.2) * uSteps) / uSteps;
    transformed.x += s * max(position.y, 0.0) * THREEDOG_WIND_AMP * uWind;
  }` });
```
`threedogWind` receives the vertex (`transformed`, object space), `ip` (world position of this plant's origin, so each plant has its own phase) and
`position`; `uTime`, `uWind` (weather), `uWindFreq` and `THREEDOG_WIND_AMP` (the species' amplitude) are in scope. It applies to every material made by
`vegetation.define` whose `wind` is a number, planted ones too, and the shadow sways with it. A missing function throws with the signature. WebGPU needs the `tsl` form: `{ glsl, tsl }`.
`sway(null)` gives the built-in sway back. A shared material the game set keeps what it was built with: apply the new `engine.vegetation.patches` to it. The same object works in code:
`applyEffects(mat, { wind: { amplitude: 0.03, glsl, uniforms } })`.

`sway()` is the world's default shape; one species' own `define(name, { wind: { amplitude, glsl, tsl, uniforms } })` wins over it, and `sway()` / `sway(null)` leave that one as it is.

Grass costs vertex count and fill, not sway: lower `rule.perChunk` or `maxRing`, or use `nearOnly`.
Grass has no blade-shape setting: give `vegetation.define` your own `geometry` or `model`.

### Far trees as cards: `impostor`
`define('pine', { model, impostor: true })` (or `{ views, size }`, default 8 x 128 px), instead of `lodGeometry`: beyond `lodRing` each plant is a camera-facing card baked from its own model and materials, lit through baked normals, one draw per species. No shadow or sway there. WebGPU only (WebGL draws the mesh and warns).

### Near-only plants fade out by distance
Any `nearOnly` species (grass, flowers, pebbles, twigs, snow tufts, debris ...) is placed per chunk ring
(`maxRing`), whose edge would be a visible line. By default instances shrink toward their base over a band that ends at `maxRing x chunk size` from the
player (start at 65% of it), so nothing pops per chunk. Tune with `fade: { start: 20, end: 45 }` (metres), or `fade: false` for a hard edge
(e.g. a species hidden in fog anyway). It is part of the species' own material (no extra draw call or program), keeps wind sway and shadows in step, and is skipped
when `effects: false`. A larger `maxRing`, fog, or a ground color near the species' base color still help for stylized looks with strong silhouettes.
