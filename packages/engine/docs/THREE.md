# Write three.js; the engine adopts it

The scene, camera, lights, characters and models in the engine are **plain three.js objects** (three 0.187). Write the three.js you already
know: what the engine can see, it plugs in with no extra call. Only where it cannot know your intent do you write one line.
Picture work (materials, shaders, textures, lights, post passes) always take this route first; engine picture features are optional conveniences on top.
This is the one place that order is stated: a material is `new THREE.*Material` / `ShaderMaterial` before a slot patch, a post
pass is a three.js Pass (`engine.post.add(pass)`) before a ready-made effect.

| You write (plain three.js) | The engine does | The one line, only when you mean it |
|---|---|---|
| `engine.scene.add(obj)` / `group.add(obj)` | registers each root under the scene like `engine.add`: `engine.thing`, `describe().scene`, `thing.set` / `thing.remove` | a stable id so a save finds it: `engine.add(obj, { id: 'mill' })` |
| `new THREE.PointLight(...)` / `SpotLight` added to the scene | a real light, adopted as a thing; counted by `engine.budget` `lights` / `shadowLights`, listed in `describe().render.lights`; a casting light at intensity 0 stops redrawing its shadow map; weather and day-night leave its values alone | many sources, few real lights: `lightPool` (recipe 09) |
| `new THREE.MeshStandardMaterial(...)` | cascaded shadows (`scene.fog` is three.js's own `material.fog`, untouched) | wind sway: `applyEffects(mat, { wind: 0.03 })` |
| `engine.post.add(pass)`, the one way into the chain (the other renderer's form: recipe 56) | slots it by kind (recipe 52, "Post effect chain"): after the scene render and before tone mapping, FXAA / SMAA last; listed in `post.list()` | a settings name and position: `add(pass, { name: 'glow', order })`, then `engine.post.get('glow').enabled = false` |
| your own `EffectComposer` / `renderer.render` of the whole canvas, every frame | yields the frame (stops drawing its own, warns once `[own-frame]`); delete your render call to hand it back. A minimap / HUD layer on top (scissor, smaller viewport, or `autoClear = false` with another scene) is not a takeover | - |
| `renderer.setSize` / `setPixelRatio` yourself | the post chain follows on its next draw | - |
| `scene.fog.far = 80`, `sun.intensity = 3`, `renderer.toneMappingExposure = 1.4` | stays: the engine never writes these on its own | - |
| one file per piece in `plugins/` next to index.html (`export default mesh`, a Pass, a post effect such as `grain()`, a module; never a bare function; a Material goes on its mesh in `picture/`) | plugs each at `engine.start()` by what it exports, through the same calls as above (`scene.add`, `engine.post.add`, `engine.use`); order by file name or a `plugins.json` beside them; anything else is a `[plugin-shape]` error naming the file, what it found and the fix (a factory: `export default makeIt({ ... })`; a module with no `type`: add one) | switch one off: `plugins.json` `"off": ["20-bloom"]` or `engine.plugins.off('20-bloom')` |
| a static mesh you want `engine.pick` to hit | - | `engine.rays.addStatic(obj)` (a BVH only pays off for things that do not move) |

`describe().slots` is the one table of what is plugged in where: each row is `{ slot, plugged, file, on, affects }`, for the plugins folder,
`scene.add` roots (with the file:line that added them), `engine.post.add` effects, modules and plain lights. Without the vite preset, hand the folder over
yourself: `engine.plugins.add(import.meta.glob('./plugins/*.js', { eager: true }))` before `engine.start()`.

## three.js idioms and who writes the value

Write the three.js first; it works. What you need to know is which values the engine **writes on its own** (every frame or on a timer): a direct write
to one hands it to you (the engine stops and warns once with the explicit call); the full list is recipe 52 "Who writes it". Optional on top: `engine.mod(point, ...)` adds owners and layers where several
systems share a value (recipe 55); `engine.autoView.manual(key)` takes a value without the warning (`manual(key, false)` gives it back);
`engine.describe('picture').picture` says what three.js holds now; `describe().owned` who writes each engine-driven value now.

| three.js idiom | Where it goes in the engine | Engine writes it? | How to take it over |
|---|---|---|---|
| `renderer.toneMapping` | Just set it: `engine.renderer.toneMapping = THREE.ACESFilmicToneMapping` (any three mapping). A curve of your own: a post stage in the `'tone'` slot, `engine.post.add({ name, slot: 'tone', create, node })`, which runs on both renderers (a `ShaderChunk` edit is page-wide and reaches only WebGLRenderer) | Never: three's default (none) stands until you write it | Nothing to take: `describe().render.toneMapping.writer` then says `game` |
| `renderer.outputColorSpace` | Leave it at `SRGBColorSpace` (three's default) | No | Changing it makes every color wrong; `assets.report` flags it |
| `renderer.shadowMap` | On at start on a renderer the engine built; the switch is `engine.shadows.enabled`; `type` is yours | `enabled` when the switch changes | `createEngine({ renderer })` and run your own |
| `scene.environment` | None by default. The sky as a map: `engine.sky.environment({ into: engine.scene })` | Only after that call; a map you write stays | Write it; recipe 34 |
| `scene.background` | Starts neutral gray; assign yours, or `engine.sky.replace(name \| Texture \| Object3D)` with a sky | The sky dome draws over it; a backdrop / skybox writes it every frame | Assign it: the dome hides and the sky stops writing it |
| Your own sky (three/addons `Sky`, a ShaderMaterial dome, a skybox) | `engine.sky.replace(mySky)`; feed it from `engine.uniforms` (`uSunDir`, `uDaylight`, `uTimeOfDay`, `uWind`, `uWeatherCloud`) | Never: the engine only hides its dome and adds `mySky` to the scene when it has no parent; time, lights, fog and weather keep running | `engine.sky.replace(null)` gives the dome back. Per key instead of whole: write `engine.sky.top` and friends in your frame code |
| Lights (`DirectionalLight`, `PointLight`, ...) | `engine.scene.add(light)` before `engine.start()` (a light count change mid-play recompiles shaders; `lightPool()` for many) | Never; `engine.lights.sun` / `.hemi` are placeholders that nothing writes but you | `createEngine({ lights: false })` leaves the placeholders out |
| Shadow camera (`light.shadow.camera`, `mapSize`, `bias`) | Your own lights: just do it. Engine sun: the same, plus `engine.shadows.box(engine.lights.sun, ...)` | The engine sun's shadow box follows `engine.focus` every frame | `engine.shadows.box(sun, { follow: 'focus' \| 'camera' \| object3D \| fn \| false, extent })`, or place `sun.target` yourself (the box stops following); recipe 45 |
| `onBeforeCompile`, `customProgramCacheKey` | On the WebGL route just assign them, on any material: `m.onBeforeCompile = s => { ... }`. On WebGPU neither works and it stops with an error: write a node material (recipe 56). A named, checked patch: `applyEffects(m, { patches: [...] })` | Nothing: on a material the engine patched (wind, clouds, season), your function runs first and the patches after it; your cache key is joined in front of theirs | - |
| Textures, `CanvasTexture`, `DataTexture` | Just do it; set `colorSpace = SRGBColorSpace` on color textures. File textures by name: `engine.assets.manifest({ textures })` then `assets.texture(name)` | No | A texture made in code gets a name too: `assets.manifest({ textures: { brick: () => makeBrick(), sign: mySignTexture } })`, then `map: 'brick'`; it keeps its own repeat / wrap / colorSpace. Baking: recipe 05 |
| `EffectComposer` passes | `const h = engine.post.add(pass)` (`composer.addPass`; `{ order }` for `insertPass`; `h.remove()` for `removePass`) | The engine renders the main frame through its own composer | `engine.post.own()` for the whole chain. To read them: `engine.post.object()` (the EffectComposer, null until post first runs) and `engine.post.targets()` (`renderTarget1 / 2`, `readBuffer`, `writeBuffer`; read in `onRender(fn, { when: 'after' })`). Read-only: the engine rebuilds `passes`, resizes and disposes them |
| Render targets (mirror, minimap, portal, picking) | `engine.onRender(({ renderer, scene, camera, dt }) => { renderer.setRenderTarget(rt); renderer.render(scene, cam); })`; runs after the camera and batching, before the frame (`{ when: 'after' }` after it) | No; the render target is reset to the screen after each `before` callback | The main frame render itself stays the engine's |
| Loaders (`GLTFLoader`, `TextureLoader`, `EXRLoader`, `FBXLoader`, `FontLoader`, exporters) | glTF and png / jpg / ktx2 / hdr textures: `engine.assets.manifest(...)` gives them names, the loading screen and `describe` | No | A hand-made `GLTFLoader` / `TextureLoader` works (rule R21 warns: the asset gets no name). Formats the manifest cannot load (EXR, FBX, OBJ, typeface fonts) and exporters: just use the three.js addon |
| Camera (`fov`, `position`, `far`) | Camera modules (`followCamera()`, ...) or `engine.camera` with none installed | An installed camera module writes position / fov every frame; terrain view distance rewrites `camera.far` | `engine.takeCamera('me')` (gives it back on `remove()`), or just write `camera.position` (the rig stops; `engine.autoView.manual('camera', false)` resumes). `camera.far` / `fov`: `engine.autoView.manual('far' \| 'fov')` |
| Meshes (`scene.add(mesh)`) | `engine.add(mesh, { id })` (tracked, saveable) or plain `engine.scene.add(mesh)` | No: auto-batching only merges what the engine places (world records, stream builds, level files); your own meshes stay as you made them | Many static copies of your own mesh: `mesh.userData.batch = true` before adding (recipe 05, 2b) |

Contact shadows are no engine feature: `threedog examples pull contact-shadows` copies one way in. WebGPU and TSL: recipe 56.

## What the engine changes in three.js (Global changes)
Everything else in three is untouched. Every change below is listed in `describe().threePatches` (`{ id, what, scope, on, offable, lost }`);
an offable one is undone page-wide with `threePatches.off(id)` (`import { threePatches } from 'threedog'`) before creating the objects that should not
see it, for every engine on the page; `engine.dispose()` does not undo a change. A wrapper another library put on `Object3D.prototype.add` stays when `scene-add-hook` is turned off. `lost` says what stops working; a change that cannot be undone says why and `off` throws.

| id | Change | Effect on your code | Off |
|---|---|---|---|
| `occlusion-layers-test` | `layers.test` of a mesh `engine.occlusion` hides, an own property while it is hidden | `engine.camera` skips the mesh; every other camera, shadows and rays see it. `mask`, `visible` and clones stay yours | no; `engine.occlusion.enabled = false` removes it |
| `shadow-accessors` | `Mesh.prototype.customDepthMaterial / customDistanceMaterial` become accessors | Unassigned, they return a shadow material only for a mesh whose material carries a vertex-moving engine patch (wind), so its shadow sways too; otherwise `undefined` as in three. An assignment always wins | yes |
| `fog-linear` | `ShaderChunk.fog_pars_fragment`, `tonemapping_fragment` and `fog_fragment` (page-wide, WebGL) | Fog is mixed once, in linear space before the tone curve and the output encoding, on the canvas, under the composer and on WebGPU alike (three mixes after both, so far fog changed colour when the first effect turned on). Adds the GLSL helpers threedogFogColor and threedogFogFactor and the define `THREEDOG_FOG_DONE`; a material `fog` slot patch replaces this mix. A shader without the fog chunks keeps three's code | yes: `threePatches.off('fog-linear')` turns off only the engine's mix (distant fog mixes after tone mapping again); the helpers and the guard stay, so a fog slot patch keeps working |
| `compare-sample-level` | `WGSLNodeBuilder.prototype.generateTextureCompare` wrapped | WebGPU only: a shadow map compare is written as `textureSampleCompareLevel` (no screen derivative, same picture), so one inside a loop compiles on D3D's FXC (`sunShafts`); a mipmapped compare texture keeps three's call. | yes |
| `node-setup-position` | `NodeMaterial.prototype.setupPosition` wrapped | WebGPU only: runs the engine's vertex-moving patches (wind) first; other node materials unchanged | yes |
| `scene-add-hook` | `Object3D.prototype.add / remove` wrapped (page-wide) | None to the call itself; the engine sees what enters and leaves its scene at any depth (adopting `scene.add`, cascades, cloud shadow, light counts). Another library wrapping the same methods stacks with it | yes (`scene.add` no longer adopted) |
| `mesh-material-accessor` | `material` on each object entering the engine's scene: an own get / set on that object (a class accessor, e.g. troika text, still runs) | In devtools `mesh.material` shows as an accessor; `mesh.material = other` works as in three and is seen | yes (new objects) |
| `material-compile-accessor` | `onBeforeCompile` / `customProgramCacheKey` on each material the engine patches (what applyEffects was asked for, wind, the game's own shader slots) | Your own hook, assigned before or after, runs first, then the engine's | yes (new materials) |
| `renderer-render` | `engine.renderer.render` (that instance only) wrapped | Counts your full-canvas draws so the engine yields the frame; a scissored / smaller-viewport / `autoClear = false` layer (minimap, HUD) does not count | yes |
| `shader-chunks` | `THREE.ShaderChunk.threedog_*` added (new names, nothing replaced) | None until you `#include` one | no (the engine's patches include them) |
| `light-idle-shadow` | `shadow.autoUpdate` of your shadow-casting point / spot lights: off while intensity is 0, back on when lit | Only lights whose autoUpdate was on; writing autoUpdate yourself hands the light back; `light.userData.idleShadow = false` opts one out; `describe().render.lights` shows `shadowIdled` | yes |
| `ray-bvh` | `geometry.boundsTree` and an own `mesh.raycast` on meshes of 256+ triangles in `engine.rays.addStatic` | Your `Raycaster` gets the BVH too; your own raycast is kept; the last unregister gives the raycast back and drops a tree the engine built | yes |
| `shadow-cache` | `light.shadow.shadowNode` of a light handed to `engine.shadows.cache`: a `ShadowNode` subclass with float depth, a second depth map and a draw filter | Only that light, only after the call; the handle's `remove()` puts three's node back |
| `batching-draw-walk` | `children` of a parent holding batched meshes: those meshes leave the array during the engine's own draw and come back right after | None outside the draw: your code, raycasts and `scene.traverse` see the scene as built. A scene change made inside a render (`onBeforeRender`) on such a parent is lost | yes (three walks every batched original twice a frame again) |
| `picture-writers` | Dev server only (not in bundles or release builds): an own get / set on the picture values of objects in the engine's scene (light intensity / color / position, `scene.fog` and its values, tone and exposure, environment, background, material color / emissive / opacity), on plain-property values in `describe().owned` (the camera, `view.far`, the shadow target), on values named with `engine.debug.watch`, and on the components of those colors, vectors and rotations | Reads and writes pass through unchanged; devtools shows accessors. A write records who made it for `describe('picture').writers` and `engine.explain({ value })` | yes: `threePatches.off('picture-writers')`, accessors stay and only pass values through |
| `post-shadow-hold` | `render` of the first pass of the WebGL post chain wrapped (it may be your own Pass) | None to what the pass draws; shadow maps redraw once a frame | yes |
| `post-background-tone` | `onBeforeRender` of three's own background mesh, while the engine draws straight to the canvas | A texture background is tone-mapped as it is through the post chain; your own `renderer.render` keeps three's rule | yes |
| `node-twin-dress` | `renderer.library.fromMaterial` of a WebGPURenderer wrapped | WebGPU only: the node twin of a classic material gets its patches | no (patched materials would lose their picture on WebGPU) |
| `node-builder-hook` | `renderer.debug.onNodeBuilderCreated` of a WebGPURenderer wrapped | WebGPU only: your own hook still runs; a later write of yours replaces the engine's | yes |
| `pipeline-internal-scope` | `createRenderPipeline` of the renderer's GPUDevice wrapped | WebGPU only: an 'internal' error scope around the call; a pipeline the driver refuses is named, its post effect held | yes |
| `device-lost-hook` | `renderer.onDeviceLost` of a WebGPURenderer wrapped | WebGPU only: three's hook still runs; a later write of yours replaces the engine's | yes |
| `page-exit-pointer-lock` | `document.exitPointerLock` wrapped (one wrapper for all live engines, gone with the last) | a game-requested unlock reads as the player pressing Esc | yes |
| `occlusion-readback` | `resolveOccludedAsync` of the WebGPU backend (that one instance), once `engine.occlusion` is on | WebGPU only: an AbortError from a buffer destroyed with the renderer is dropped; any other error still reaches you | no (disposing an engine while occlusion answers are on their way would report an unhandled rejection) |
| `lod-view-camera` | `update` and `clone` of the `THREE.LOD` objects `assets.lod` and a prop's `lod` make | Only the engine camera moves the level, and far off the full model waits on the batch layer with `visible` still true, so rays reach it | yes |
| `webgpu-record-sweep` | A `'dispose'` event sent to objects drawn earlier that have left every Scene for a few seconds, found through WebGPURenderer's private record list | WebGPU only: your `'dispose'` listener on such an object runs; drawing it again rebuilds its record | yes |


## Getting three.js objects from the engine

| You want | Use |
|---|---|
| THREE itself | `import { THREE } from 'threedog'` (the same copy the engine uses) |
| Scene / camera / renderer | `engine.scene`, `engine.camera` (PerspectiveCamera), `engine.renderer` (WebGPURenderer on the default route of a new game, WebGLRenderer on `--webgl`) |
| Player, NPCs | `engine.player.root`, `engine.npcs.get('name').root` (Group); position `.position` (Vector3) |
| Pickups, template instances | `pickups.spawn(...)` returns a handle with `.object` (Mesh); a template instance's model is `engine.world.view(id)` (exists only near) |
| Level | `engine.level.root`; markers `engine.level.marker('spawn').object / .position` |
| Sun, ambient light, sky dome, fog | `engine.lights.sun` (DirectionalLight), `engine.lights.hemi` (HemisphereLight), `engine.sky.dome`, `engine.scene.fog` |
| Water | `engine.water.sea` (Mesh; null when the game sets no water level), `water.material` (get / set), `water.uniforms`, `water.bodies.get(body)` |
| Particles, weather particles | `.points` and `.material` of the value returned by `particles.define(...)`; `engine.weather.particles[field].material` (the plain material of a weather field) |
| Rigid bodies | `engine.rigid.addBox(mesh)` returns a handle `{ object, body, remove() }`, or null before Rapier is ready (object is your mesh; `castShadow` / `receiveShadow` keep the values you set, the engine does not change them) |
| Terrain chunks | `engine.terrain.chunks` (Map of chunk data); a chunk's three.js objects: `engine.terrainDraw.meshes.get(chunk)` (`{ group, mesh }`) |
| Models, textures, animation | `await engine.assets.model('name or path')` (an Object3D copy), `assets.texture(...)`, `assets.animate(model).mixer` |
| Vehicles, navigation, character controller | `engine.rigid.addWheeled(mesh, ...)` returns `{ body, controller }`; `engine.nav.navMesh / query / tileCache / crowd` (they are destroyed and replaced on rebuild; code that caches them compares `engine.nav.version`); `engine.player.mover.controller` (mover: 'rapier') |
| glTF / compression decoders | `engine.assets.gltf` (GLTFLoader, Meshopt installed), `assets.draco` (DRACOLoader), `assets.ktx2` (KTX2Loader); the last two are created the first time compressed data is met and are null before that |
| Rays | `engine.raycast(origin, direction)` / `engine.pick(ndcX, ndcY)` return three hits (`object` is the mesh, `face` and `point` unchanged); `{ targets: 'all' }` hits rigid bodies too (the hit carries `entry` and `kind: 'rigid'`); the underlying `engine.rays.ray` (THREE.Raycaster, `firstHitOnly` on) |
| Ray acceleration (BVH) | three-mesh-bvh, without touching three's prototypes: only on meshes in `engine.rays.addStatic` (`ray-bvh` above); every other mesh is plain three. Page-wide BVH for your rays: three-mesh-bvh's documented setup (`Mesh.prototype.raycast = acceleratedRaycast`, ...) |
| Streamed-in objects | `.object` of the handle returned by `engine.stream.add({ position, build })` (the Object3D that build returned; null before it is built) |
| Post-processing | `engine.post.add(pass)`, the one way in (a Pass, or an effect `{ name, slot, create: ctx => pass }` plus its twin for the other renderer, recipe 56; slots `scene` / `hdr` / `tone` / `ldr` / `final`; on / off and params with its handle); `engine.post.own()` hands over the whole chain |
| Where the mouse points | Ground: `screenToGround(engine, input.pointer.ndcX, ndcY)` -> Vector3; objects: `engine.pick(input.pointer.ndcX, ndcY)` (registered static objects; for any object pass `{ targets: [object] }`) |

Returned positions are all `THREE.Vector3` (the camera's `forward()/right()` are planar directions `{x, z}`; positions in photo records are saveable `{x, z}`).
Anywhere a position is accepted it is **one argument**: Vector3 / Object3D / `[x, y, z]` / `{ x, z }` all work, and sizes go in an options object ("Interface conventions" in `CONVENTIONS.md`).

## Engine conventions when using three.js

1. **Materials**: `new THREE.MeshStandardMaterial(...)` is the way. Your own shader code works as in three.js: TSL on WebGPU (recipe 56),
   `ShaderMaterial` / `onBeforeCompile` on WebGL (table above). The engine adds effects only to materials it made; yours opt in with `applyEffects(mat, { wind: 0.03 })`.
   One exception, named: with cascaded shadows on (`engine.shadows.cascades(light)`) every built-in lit material gets the `csm` patch, or it would
   be lit N times; a lit `ShaderMaterial` of yours joins with `engine.shadows.include(mat)` (recipe 45).
2. **Adding to the scene**: `engine.scene.add(obj)` registers every root (`engine.thing(obj)` says what a save keeps); `engine.add(obj, { id })` only adds a stable id (`recipes/40-scene.md`). To attach to a character: `player.root.add(hat)`.
3. **Per-frame logic goes in `engine.onFrame(dt => ...)`** (movement and timing use `engine.onFixed`); it returns a handle, cancel with `h.remove()`.
   Don't start your own `requestAnimationFrame` loop: the engine owns pausing, fast-forward in tests and ordering. Rendering the whole canvas yourself takes the frame over
   (post chain, adaptive resolution and photo mode stop applying); a render target of your own goes in `engine.onRender` (table above).
4. **Snap to ground**: get ground height with `engine.surface(x, z)`, or `engine.snapToGround(obj, heightAboveGround)`. Don't raycast the terrain.
   **Rays** always go through `engine.raycast / pick`: level meshes are registered automatically; register your own static objects with
   `engine.rays.addStatic(obj)` or `assets.model(name, { static: true })`.
5. **Deleting**: `engine.remove(obj)` (recipe 05 §5; it also unregisters rays). A copy from `assets.model()` shares resources with other copies (`remove` skips them); `assets.release(name)` frees them together.
6. **The sky lights nothing**: it computes signals and draws the dome; your `picture/` code writes lights, fog and exposure (recipe 62).
7. **Camera**: `engine.camera` is a three.js camera: change its properties, or assign your own real `THREE.PerspectiveCamera` or `THREE.OrthographicCamera` (`engine.camera = cam`, keep the old value to swap back). Rendering, post, picking, shadows, audio and an installed camera module all go on with it; any other class, a subclass too, is refused. Aspect, frustum and a rig's `projection`: recipe 21. `engine.setCamera('follow')` swaps the camera *module*, not the object. When a camera
   module is installed it places the camera every frame; to control the view yourself take it with `const cam = engine.takeCamera('me')` and `cam.remove()` it
   (`engine.cameraOverride` is read-only: it shows the holder in charge, or `null`).
8. Collision: the player only respects `engine.collision` (`addCircle / addBox / addObject(mesh)`); a mesh alone does not block anyone.
9. **Big code-generated things**: a generator in the manifest, fetched by name (recipe 05 §2). Things needed only nearby: `engine.stream.add({ position, build })`;
   long loops: `engine.jobs.add(function* () { ...; yield; })`, spread over frames.
10. **One copy of the engine and of three per page**: `resolve: { dedupe: ['threedog', 'three'] }` in vite.config.js. A second engine copy
   (a pack that lists threedog under `dependencies` instead of `peerDependencies`, a linked plus an installed copy) breaks shadows of wind and
   cascaded-shadow materials; the engine warns once at load, naming both paths [engine-two-copies].

## Example: a spinning windmill (plain three.js + engine conventions)
The same windmill as a template with an id, saved and editable without code, is in `recipes/40-scene.md` §1.

```js
import { THREE } from 'threedog';
const mill = new THREE.Group(), blades = new THREE.Group();  // plain three.js: meshes and materials as usual
mill.add(blades);
mill.position.set(20, 0, -10);
engine.snapToGround(mill);  // snap to ground
engine.scene.add(mill);  // registered like engine.add; engine.add(mill, { id: 'mill' }) also keeps thing.set changes in saves
engine.collision?.addCircle(mill, { radius: 1.3 }); // block the player (when the collision module is installed)
engine.onFrame(dt => { blades.rotation.z += dt * 1.5; });
```

## Example: your own rain (three.js drops, a plain call or a module)
`weather({ rain })` is there if it fits. Your own effect: three.js builds it, a call adds it, a module only when something must clean up or swap it.

```js
import { THREE } from 'threedog';
function makeRain({ count = 2000, area = 40, height = 20, speed = 18 } = {}) {
  const pos = new Float32Array(count * 6);  // one short line per drop
  for (let i = 0; i < count; i++) pos.set([(i * 0.618 % 1 - 0.5) * area, i * 0.31 % 1 * height, (i * 0.754 % 1 - 0.5) * area], i * 6);
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const drops = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fb8d0, transparent: true, opacity: 0.5 }));
  drops.frustumCulled = false;
  const step = dt => {
    for (let i = 0; i < count; i++) {
      const y = (pos[i * 6 + 1] - speed * dt + height) % height;
      pos[i * 6 + 1] = y; pos[i * 6 + 3] = pos[i * 6]; pos[i * 6 + 4] = y + 0.4; pos[i * 6 + 5] = pos[i * 6 + 2];
    }
    geo.attributes.position.needsUpdate = true;
  };
  return { drops, step };
}

// A plain call is enough when the rain stays for the whole game
const rain = makeRain();
engine.scene.add(rain.drops);
engine.onFrame(rain.step);

// A module when it can leave or be swapped: the same code, the callbacks go through ctx.track
const rainEffect = o => ({ name: 'rain', install(e, ctx) {
  const r = makeRain(o);
  e.scene.add(r.drops);
  ctx.track(e.onFrame(r.step));
  ctx.track({ remove: () => e.remove(r.drops) });
} });
engine.use(rainEffect({ count: 4000 }));
```

The engine then does the rest: `engine.unuse('rain')`, a failed install or `{ replaces }` runs what `ctx.track` holds, and two modules of one name or two owners of one slot are refused with the fix. A value that others change too (rain slowing the player) goes through `ctx.mod`.

## Example: wet stone in rain (the engine gives the signal, the game decides)
The weather module knows how hard it rains, not what your stone looks like wet or whether it is slick: that is the game's look and rule.

```js
import { THREE } from 'threedog';
const stone = new THREE.MeshStandardMaterial({ color: 0x777066, roughness: 0.9 });
engine.onFrame(() => { stone.roughness = 0.9 - 0.6 * engine.uniforms.uRain.value; });  // the look: the game's material reads the rain

let slick = null;  // the rule, if the game wants one: in game time, through the shared value
engine.onFixed(() => {
  const wet = (engine.weather?.current.rain ?? 0) > 0.5 && engine.groundType(engine.player.position) === 'stone';
  if (wet && !slick) slick = engine.mod('move.speed', { owner: 'wet-stone', id: 'player', mul: 0.8 });
  if (!wet && slick) { slick.remove(); slick = null; }
});
```

## Code-built models: what three.js already has
Models written in code (recipe 05, 2a) mostly need helpers three.js ships; import them inside the model generator, so the result is cached and baked with the model.
`three`: `LatheGeometry`, `TubeGeometry`, `ExtrudeGeometry` (`extrudePath`), `ShapeGeometry`, `InstancedMesh`, `BatchedMesh`, `CanvasTexture`. `three/addons`: `BufferGeometryUtils` (`mergeGeometries`, `mergeVertices`, `toCreasedNormals`),
`LoftGeometry`, `RoundedBoxGeometry`, `ParametricGeometry`, `TextGeometry`, `DecalGeometry`, `ConvexGeometry`, `Flow` (CurveModifier), `MeshSurfaceSampler`, `SimplifyModifier`, `TessellateModifier`, `EdgeSplitModifier`, `SimplexNoise`, `ImprovedNoise`.

```js
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { bakeVertexAO } from 'threedog';

const rng = engine.random.seeded(7), simplex = new SimplexNoise({ random: () => rng.next() });  // seeded noise: the same shape every load
// weld first, or the noise opens cracks; mergeVertices compares every attribute, so drop normal and uv (their seams would stay unwelded)
const rock = mergeVertices(new THREE.IcosahedronGeometry(1, 3).deleteAttribute('normal').deleteAttribute('uv'));
const p = rock.attributes.position, v = new THREE.Vector3();
for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); v.multiplyScalar(1 + 0.25 * simplex.noise3d(v.x, v.y, v.z)); p.setXYZ(i, v.x, v.y, v.z); }
rock.computeVertexNormals();
const slab = new THREE.CylinderGeometry(1.2, 1.4, 0.3).translate(0, -0.9, 0).deleteAttribute('uv');
const model = mergeGeometries([rock, slab]);  // same attributes (position, normal), both indexed
bakeVertexAO(model, { samples: 32, strength: 0.7, occluders: [new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2).translate(0, -1.05, 0)] });
```

Traps: `mergeGeometries` needs the same attributes on every part, all indexed or none. A non-indexed geometry (`geometry.toNonIndexed()`, a merge where one part has no index) gives every triangle its own
vertices, so `geometry.computeVertexNormals()` shades each face flat: weld first with `mergeVertices` (per part, so hard edges between parts stay). `SimplifyModifier.modify` is async in this three version.

| Need | Engine, only what three lacks |
|---|---|
| Parts of one flat color each, into one geometry | `mergeColored([[g, color], ...])` (vertex colors) |
| Ambient occlusion in a code-built model (three's `aoMap` needs a baked texture) | `bakeVertexAO(geometry, { samples, radius, strength, occluders })`: hemisphere rays per vertex (three-mesh-bvh), multiplied into the vertex colors; detail is per vertex, so tessellate big faces first |
| Points over the ground by height, slope and biome | `engine.vegetation.define(name, { rule })` (recipe 36) |
| Far copies of whole areas | `hlod` (recipe 15) |
| Terrain heights | `@threedog/terrain-noise` (recipe 28) |
| Many copies | Auto-batching for copies the engine places, `userData.batch` for yours (recipe 05, 2b) |
