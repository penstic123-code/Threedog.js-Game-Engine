# 52 Around the picture: reading it back, the post chain, who writes what

> **Covers:** around the picture code: reading it back, the post effect chain, who writes which value.
> **Use when:** adding a post effect or finding who set a picture value.
> **Shortest:** `engine.post.add(pass)`.
> **Sections:** Atmosphere fog, sky · Surfaces ground, plants, cloud · Post effect chain · Who writes it the

The picture is plain three.js in a `picture/` folder that reads `engine.uniforms` ([recipe 62](62-picture-code.md)). This page covers what sits around that code: reading the picture back,
trying a value out, and the engine pieces it talks to.

```js
engine.describe('picture').picture;  // tone, exposure, fog, environment, background, every light, shadows: what three.js holds now
const h = engine.debug.override('me', engine.renderer, 'toneMappingExposure', 3);  // try a value on any three.js object; held above your picture/ code
h.remove();  // back to what your code writes (engine.debug.clear('me') takes every override of that owner)
engine.catalog('post');  // a capability's entries and what it holds now; also 'shadows'
```

Which knob changes what on screen, and how to judge it for your picture: [recipe 60](60-judge-the-picture.md). Where picture code sits among the other ways to customize: `../CONVENTIONS.md` "Customization ladder".

- The picture is not saved: after a load, your `picture/` code draws it again from your own state.
- How bright a lit color comes out (three.js light units, exposure 1): a diffuse surface facing up receives `sun.intensity × sin(sun elevation) + hemi.intensity` (the hemisphere's sky color,
  since it faces up), and three divides by π, so a total near π shows mid-tone albedos at roughly their own value under `AgXToneMapping`. AgX darkens light colors and pales saturated ones,
  so a pale or vivid palette needs more, or exposure. Walls and faces away from the sun get only their `N·L` share, and the environment (`scene.environment`) adds on top for Standard / Physical materials.

## Atmosphere: fog, sky

Fog and the placeholder lights: [recipe 34](34-environment-lighting.md). The sky: plain values and calls on `engine.sky`, [recipe 08](08-weather-sky.md). Shadows: `engine.shadows` and three.js, recipe 45. Water and weather: recipe 44.

<a id="tsl-forms"></a>**tsl forms** (`renderer: 'webgpu'`): the GLSL hooks `engine.sky.clouds` and `engine.sky.layer` take `{ glsl, tsl }`; each renderer draws its own form and a missing one throws by name (`[webgpu-needs-tsl]` on WebGPU). `tsl: (ctx) => vec4 node`, ctx = the GLSL function's arguments as nodes plus the value so far (`ctx.clouds` the built-in kind, `ctx.color` the sky under a layer, `ctx.fog` what the fog kind alone draws), `ctx.uniforms` (the dome's, yours included), `ctx.fx` (the `threedog/tsl` functions, `ctx.fx.noise` and `hash` among them) and `ctx.tsl` (three/tsl):
`engine.sky.layer('glow', { glsl, tsl: ({ dir, tsl }) => tsl.vec4(1, 0.6, 0.3, tsl.smoothstep(0.3, 0.8, dir.y).mul(0.4)), blend: 'add' })`.

## Surfaces: ground, plants, cloud shadow, season

```js fragment
engine.terrain.material = myGroundMaterial;  // plain three.js on the module; terrain({ colors, shading, detail }) are its start values (recipe 28)
engine.uniforms.uWindFreq.value = 1.5; engine.uniforms.uWindAmp.value = 0.5;  // signals: live on every plant, planted ones too
engine.vegetation.define('grass', { geometry, wind: { amplitude: 0.05, glsl, tsl } });  // your own sway: threedogWind(...) / tsl: (ctx) => moved position (recipe 36)
engine.vegetation.color({ glsl: 'diffuseColor.rgb *= 0.8;', tsl: c => c.color.mul(0.8) });  // code in the color slot, live on planted species
engine.shaderTerms.cloudShadow({ glsl: 'reflectedLight.directDiffuse *= myShade(vThreedogWorld);', tsl: c => ({ directDiffuse: c.directDiffuse.mul(myShadeNode) }) });
engine.shaderTerms.cloudShadow(false);  // no engine cloud shadow anywhere: draw your own
engine.shaderTerms.season(kind => ({ glsl: 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uGroundCover.y);', tsl: c => myTint(c, kind) }));  // your own season / snow tint
```

- Wind is signals: `engine.uniforms.uWind` (weather), `uWindFreq`, `uWindAmp`. A three.js material of yours sways with `applyEffects(mat, { wind: 0.03 })`; your own shader calls `threedogWind(position, origin, amplitude)` (`#include <threedog_wind>`) or `wind(position, origin, amplitude)` (`threedog/tsl`).
- The whole plant picture is replaced as a module: `engine.use(myPlants, { replaces: 'vegetation-draw' })`.
- `engine.shaderTerms.cloudShadow(spec)` and `engine.shaderTerms.season(spec)` put your own patch (`{ glsl, tsl, uniforms?, pars?, slot? }`, slot `lighting` / `color` by default) in place of the engine's on every material that carries the term, including ones built earlier; `false` removes the term; the handle's `remove()` gives the engine's back. The signals stay bound: `uWeatherCloud, uCloudShadow*` and `threedogCloudShadow(worldPos)`; `uFoliageTint` / `uGroundTint` / `uFoliageMix` / `uGroundMix`, `uGroundCover` (cover amount alone, x foliage, y ground) and `threedogSeason(color, kind)` (TSL: `season(color, kind)`). `season` also takes `kind => spec` (`'foliage'` | `'ground'`). A missing renderer form throws by name.
- Cloud shadow values are signals: `engine.uniforms.uCloudShadow` (darkest, 0 = none), `uCloudShadowScale`, `uCloudShadowSpeed`. The term sits on engine materials and on what you pass to `applyEffects(mat)`; your own shader calls `threedogCloudShadow(worldPos)` (GLSL) or `cloudShadow(positionWorld)` (`threedog/tsl`). The engine adds it to no other material.

## Post effect chain

Post-processing is an ordered list of named effects, and **`engine.post.add(x, { name, slot, order })` is the one way an effect gets
in**: game code and the game's `plugins/` folder (a file that exports the Pass or effect) go through it, so every
effect has a name, a handle and a row in `describe().slots` and `describe().render.post`. It returns `{ name, enabled, set(params), remove() }`, and
`engine.post.get(name)` returns the same handle. A wrong shape throws with nothing added.

`x` is a plain three.js Pass (WebGL), a TSL node function `(input, ctx) => node` (WebGPU), or an effect `{ name, create, node, fuse, slot, order, params, update, needsDepth, needsBuffers, backend, skipOnLowTier, facts }`: both renderers when it gives `create` and `node`, or a `fuse`. `create(ctx) => pass` returns any three.js postprocessing Pass, built the first time the effect is on, and `update?(pass, params)` applies new params (on WebGPU `node`: recipe 56). Optional: `needsBuffers` (extra scene outputs, WebGPU), `backend: 'webgpu'` (the WebGL2 backend cannot run it), `skipOnLowTier` (held on `engine.tier` 'low'), `facts` (a line in `describe().render.post`).

**An extra render inside your own effect** (a mask pass, a depth of selected objects): draw it in `ctx.borrowRenderer(renderer, () => { renderer.setRenderTarget(myTarget); renderer.render(scene, camera); }, { scene, camera })`. The render target, viewport, scissor, clear color, tone mapping and the scene's override material, background and fog come back afterwards, also when the draw throws; targets and materials stay the effect's to dispose. `clean: true` (WebGPU) starts from three's reset state for a quad inside a node frame. Restoring by hand and forgetting one makes the next effect draw into your target.

Each runs in a slot, then by `order` (low first): `scene` (replaces the scene render, one at a time, e.g. pixelation) -> `hdr` (linear color: outline, AO, bloom) -> `tone` (replaces the tone-mapping output, one at a time; it must output display color) -> `ldr` (sRGB: LUT, palette, grain, vignette) -> `final` (FXAA / SMAA).

A plain Pass is placed by its kind: one that renders `engine.scene` itself (`RenderPixelatedPass`, `SSAARenderPass`, `TAARenderPass`) goes in `scene` and replaces the engine's scene render (a second one throws), FXAA / SMAA / TAA in `final`, any other in `hdr` after the effects already there (`ldr` when you added it after an OutputPass); a RenderPass of `engine.scene` and an OutputPass are skipped (the engine has them). Without `{ name }` it is listed by class or shader name (`CopyShader#1`); its `remove()` does not dispose it.

To read the chain: `engine.post.object()` and `engine.post.targets()`; both stay the engine's (it rebuilds, resizes, disposes), so change the chain through `engine.post`, or take it over with `engine.post.own()` (`own(false)` gives it back). A game that renders the canvas itself (its own composer) takes the frame: the engine stops drawing and warns once `[own-frame]`.
```js fragment
import { bloom, outline, vignette, lut } from '@threedog/post-effects';  // shared effects come from the add-on
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
const line = engine.post.add(outline({ thickness: 1.5 })); engine.post.add(vignette());
line.enabled = false;  // pauses it in place; a settings restriction above this still holds it off
engine.post.get('vignette').set({ strength: 0.6 });  // params by name; an unknown name throws
if (engine.tier !== 'low') engine.post.add(bloom());  // the heavy ones are the game's call on weak devices
engine.post.add({ name: 'myLut', slot: 'ldr', params: { lut: myLut }, create: ({ params }) => new LUTPass({ lut: params.lut }) });
// a plugin file brings the same effect with no main.js line: plugins/10-bloom.js
export default bloom({ strength: 0.2 });
```
- `bloom({ strength, radius, threshold })`, defaults 0.35, 0.5, 0.85 (glow added, spread 0 to 1, brightness a pixel needs to glow). It reads linear color before the tone curve, so a
  surface brighter than 1 glows hard however small: if the frame washes out, raise `threshold` or dim that surface before lowering `strength`. On the WebGPU route three's own `BloomNode` is also open to you through `engine.post.add({ node })`.
- The engine ships no effects. `@threedog/post-effects` (import only what you use) has `bloom`, `ao`, `outline`, `dof` (all `hdr`; outline and dof read depth) and `lut` (contrast / saturation / warm-cool / optional 3D LUT, or
  `paletteLut(colors)` for a fixed palette), `grain`, `vignette`, `chromatic` (`ldr`), each on both routes. `voxelGI`, `reflections`, `temporalAA`, `sunShafts`, `lightVolumes`, `autoExposure` exist only on WebGPU: `@threedog/post-effects/tsl`. Materials and lighting as TSL: `threedog/tsl`; the three.js layers the engine keeps (`RESERVED_LAYERS`): `threedog/layers`.
  An added effect is on (`enabled: false` adds it off, for `handle.enabled = true` later). The heavy ones (`bloom`, `ao`, `dof`, outline `normal`/`both`) are the game's call on weak devices (`threedog shot` renders the desktop tier, `--tier low` checks the low one).
- Depth: an effect that reads scene depth (`needsDepth: true`, e.g. `outline`) must run before any pass that swaps buffers (a `ShaderPass`, a
  scene-slot pixelation pass, the tone-mapping output). The rule is checked over every added effect, on or off (one held by a preset or a low tier included), so an order that would break throws at the `add`, naming both effects, and turning an effect on or off never throws for order;
  give the depth reader a lower `order`. `dof` keeps the scene depth (`pass.keepsDepth = true`), so `dof` and `outline` can both be on while `dof`
  has the lower `order` (default: dof 5, outline 10). The other order throws.
- Glow and a step-style grade (posterize, palette snap, a few-level LUT): a grade run **after** glow cuts its falloff into flat plateaus that read as a grey stain around a light,
  worse the fewer levels, and the default order is that one (`bloom` is `hdr`, a grade `ldr`). Ways out: (1) grade first: the grade gets `slot: 'hdr'` and an `order` below bloom's (the halo may
  leave the palette); (2) keep the grade last and make the glow stepped on purpose; (3) drop the glow and paint the light. Judge on a `threedog shot` close on one bright light against a dark ground:
  a grey flat disc is the trap. (Reasoned on a one-dimensional model, not yet checked with the real passes.)
- On / off: `engine.post.get('bloom').enabled = false` for every effect, whoever added it, pauses it where it is (place and params stay); `engine.plugins.off('<file>')` unloads a plugin (the effect leaves the chain; `on` plugs it again; a pack's file: `'<pack>/<file>'`). Either way
  it comes back in the same place: inside a slot `order` decides, and equal orders keep the order the names were first added in. There is no `createEngine({ post })`. The switch is the shared point `post.<name>.enabled`: `enabled` writes its game layer, a hold of your own goes through `engine.mod('post.bloom.enabled', { owner, set, layer })`, and reading `enabled` gives what runs now.
  The settings menu shows `bloom` / `ao` toggles only when effects with those names exist; a toggle the player turns off sits on the settings layer of that point, above the game and any hold (`describe().render.post` reads `writer: 'settings'`). MSAA is `engine.post.antialias = on` and works with every effect on.
- `fuse`: a light color effect can skip its own fullscreen pass by carrying a GLSL snippet instead of `create()`:
  `fuse: { uniforms: { uMyAmount: 'float' }, values: p => ({ uMyAmount: p.amount }), glsl: 'color.rgb *= 1.0 - uMyAmount * length(vUv - 0.5);' }`.
  Fused effects that are on and next to each other in one slot (never `scene`) compile into one shader and draw in one pass, in `order`. The
  snippet edits `vec4 color` and may use `vUv`, `tDiffuse`, `uTime`, `uResolution`, `fxHash(vec2)`; uniform names are shared by the group, so prefix
  them with the effect name. A snippet that samples `tDiffuse` elsewhere (blur, color fringe) sets `reads: true` and starts a new group.
  `engine.post.add({ name, fuse: { glsl }, slot: 'ldr' })` adds just a snippet.
- Outline: `outline({ mode: 'depth' | 'normal' | 'both' })`: `depth` (default, silhouettes), `normal` (creases; draws the scene once more with
  normals, so it costs more), `both`. `fadeWithDistance: false` keeps lines at any distance; `wobble: 1.5` jitters lines by up to 1.5 px at 8 steps a
  second. To exempt objects: `outline({ offLayer: OUTLINE_OFF_LAYER })` and `mesh.layers.enable(OUTLINE_OFF_LAYER)` (one extra render of just those objects; nothing when `offLayer` is `null`).
- Ambient occlusion (darker creases and contact corners): `ao({ radius, intensity })` wraps three's `GTAOPass`; `radius` is in world units, `intensity` 0..1, both change in place: `engine.post.get('ao').set({ radius: 0.6 })`.
  Order 20 runs it before bloom and the tone mapping. It draws the scene once more with normals: points and lines are skipped, and a vertex-moving shader patch (wind) is not applied there, so swaying leaves get the AO of their rest pose.
  Other GTAOPass settings (`samples`, `thickness`, `output`): `engine.post.object().passes.find(p => p.gtaoMaterial)`.

### dof: blur the background (focus blur, bokeh, miniature, tilt shift, cinematic)
`dof` from `@threedog/post-effects` blurs what is away from the focus distance: `engine.post.add(dof({ focus: 8, range: 3, maxBlur: 5 }))`, then `engine.post.get('dof').set({ focus: distanceToTarget })` each frame for a follow focus. A small `range` and a large `maxBlur` read as a miniature; a long `range` as a soft backdrop. Not a shadow setting (`engine.shadows` blur is edge softness).

## Who writes it: the ownership table

Some three.js values the engine writes **on its own**, every frame or on a timer: the camera module places the camera, a sky keeps the shadow box around the focus. Lights, fog, exposure and the environment are not among them: the game's `picture/` code is their one writer (recipe 62).
Each of them is registered once (`core/ops/owned.js`), and every one behaves the same way:

- **Engine** (default): the engine writes it. Adjust it while the engine keeps driving: the `set` call in the table.
- **Taken** (`manual`): `engine.autoView.manual('far' | 'fov' | 'pixelRatio')` stops the engine writing it; the three.js value is yours.
  `manual(key, false)` (or the handle's `remove()`) gives it back. No module option starts a value taken over.
- **Written directly** without `manual`: the engine **stops writing it and keeps your value**, in release builds too, and warns once (dev) with the `manual` and hand-back calls.
- A `timeline.tween` on an object is a temporary takeover of that object only: no warning, no hand-over (other objects stay checked).

`engine.describe().owned` lists every registered value and who writes it now, as `writer` (`engine`, `manual:game`, `three (engine yielded)`).

| id | part | written when | take it | adjust while the engine drives |
|---|---|---|---|---|
| `shadow.follow` | shadow | the box on the engine sun: under a sky every frame (center = `sun.target`); without one the placeholder sun follows `engine.focus` | `engine.shadows.box(engine.lights.sun, { follow: false })` | `engine.shadows.box(engine.lights.sun, { extent })` |
| `toneMapping` | tone | never: `renderer.toneMapping` stays three.js's default until your code writes it | `engine.renderer.toneMapping = THREE.ACESFilmicToneMapping`; an own curve as a post stage: `engine.post.add({ name, slot: 'tone', create })` (or `node` on WebGPU; replaces OutputPass / renderOutput; outputs display color) | - |
| `background` | sky | sky: a backdrop color or skybox every frame; with the dome the dome hides when you take it | `scene.background = x` (the dome hides); whole sky: `engine.sky.replace(texture \| object3D)` | `engine.sky.backdrop = '#335577'` |
| `view.aspect` | view | every resize | `engine.autoView.manual('aspect')` | - |
| `sky.sunDir` | view | `sky()` each frame, from the time and `engine.sky.orbit` (the same vector as `uSunDir`) | `engine.autoView.manual('sunDir')` | - |
| `sky.environment` | sky | the map in the `into` you gave `engine.sky.environment({ into })`, rebuilt after its interval when the sky changed (never without that call) | `scene.environment = x` or `engine.sky.environment().remove()`; `engine.sky.environment({ into })` again gives it back | `engine.sky.environment({ interval })` |
| `view.far` | view | terrain view range (`terrain.viewChunks`) | `engine.autoView.manual('far')` | - |
| `view.fov` | view | the settings menu fov slider, camera modules (first person / rts fov, fixed shots, back to the install fov on a switch) | `engine.autoView.manual('fov')` | - |
| `view.pixelRatio` | view | adaptive resolution, about once a second while slow | `engine.autoView.manual('pixelRatio')` | `engine.setPixelRatio(1.5)` |
| `camera` (position, rotation) | view | the camera module, every frame | `const cam = engine.takeCamera('me')` (`cam.remove()` gives it back) | - |
| `post.chain` | post | whenever the effect list changes (add / remove / on / off, MSAA): the engine rebuilds the composer passes (WebGL) or `pipeline.outputNode` (WebGPU) | `engine.post.own()`: the built chain stays as you left it in `engine.post.object()`; `own(false)` rebuilds it from the list. A write to `object()` without `own()` does not yield: the next chain change replaces it | `engine.post.get('bloom').set({ strength: 0.6 })` |
| `shadow.csm` (not a property: a list) | shadow | while cascades are on: the `csm` patch goes on every built-in lit material, yours too (else N times as bright) | - (`handle.remove()`); your ShaderMaterial is left alone until `engine.shadows.include(mat)` | - |

Not in this table, because the engine writes them once rather than keeps writing them: automatic batching (it moves engine-placed meshes to layer 31
and says so once in the dev console and in `describe().perf.batching`; turn it off per object with `userData.batch = false`, see
[05-props-bake.md](05-props-bake.md) §2b) and `castShadow` on generator props (set when the model is made: a generator's own flags are kept, the
manifest entry can set them; change it on the object afterwards).
