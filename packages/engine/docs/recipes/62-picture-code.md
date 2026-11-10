# The whole picture in plain three.js: signals in, picture out

> **Covers:** the whole picture as plain three.js in `picture/`: signals in, picture out, parts, a flat look, pixel art.
> **Use when:** writing or changing how the game looks.
> **Shortest:** the generated `picture/` folder (§0).
> **Sections:** 0 The picture/ folder · 1 Setup the engine's · 2 The signals engine.uniforms · 3 The hook engine.onRender · 3b Rules that keep · 3c Wiring picture/ parts · 3d Save to the · 3e Several parts change · 3f Picture parts three.js · 4 A flat illustration · 4b Pixel art low-resolution · 5 What the engine · 6 Check the picture

Any picture (flat, toon, painterly, realistic) can be plain three.js in one folder of the game: its own lights, materials, fog, sky colors and post
passes. The engine hands it signals (time of day, weather), keeps the engineering (streaming, shadows, saves, tests) and writes none of its values.
Working example: `examples/plain-picture/` (page `/plain-picture.html`). Every value has one writer, a line in your code.

## 0. The `picture/` folder: where all picture code goes
`threedog new-game` generates it, with a gray start; it is yours to change or delete. One file per job, so the picture never piles up in one place:
```
picture/
  index.js       wiring: the picture module (engine.use(createPicture()), then engine.picture): creates the parts, calls each part's update(signals) in one engine.onRender; no values here
  palette.js     colors and key values for the whole game, including the tone curve
  lights.js      lights: the mapping from signals to lights
  materials.js   materials by name; other code asks for picture.materials.wall and never builds its own
  sky.js         add when the game has its own sky or fog
  post.js        add when the game has post effects
  shaders/       your shader code: TSL .js on WebGPU (the default), .glsl on WebGL (a saved .glsl hot-reloads)
  areas/<name>.js a large game's overrides for one area (a cave, an interior): only what differs
```
To add a part, write a file that returns `{ update(signals) }` and call it from `index.js`, handing it the module's `ctx` so what it adds leaves with the picture:
```js
// picture/sky.js: the engine's dome stays, fog is the game's
export function createSky(engine, ctx) {
  const fog = new THREE.Fog(palette.fog.color, palette.fog.near, palette.fog.far);
  ctx.borrow(engine.scene, { fog });
  return { update(s) { fog.color.copy(night).lerp(day, s.uDaylight.value); } };
}
// picture/post.js: engine.post.add takes a three.js Pass and keeps the chain in order (recipe 52)
export function createPost(engine, ctx) {
  ctx.track(engine.post.add(new ShaderPass(GrainShader), { name: 'grain' }));
  return { update() {} };
}
```
Gameplay and level code use material names and signals only.

## 1. Setup: the engine's placeholder lights off
```js
const engine = createEngine({ canvas, lights: false });  // no placeholder sun / hemisphere; this is the WebGL form: a new game also has `import 'threedog/tsl'` and `renderer: 'webgpu'`
engine.use(calendar({ time: '22:00' }),
  sky(),  // computes the signals and draws the dome; writes no light or fog
  weather({ types: { clear: {}, rain: { rain: 1, cloud: 0.8 } } }));
engine.renderer.toneMapping = THREE.AgXToneMapping;  // three.js's default (none) stands until you pick one
if (engine.sky) engine.sky.dome.visible = false;  // when you draw your own sky (a gradient sphere, a skybox)
```
Without `calendar` and `sky()` `uDaylight` stays 1 and `uSunDir` straight up; with only `calendar` the daylight moves but the sun stays up. Keep both for a day cycle, even when you draw everything yourself.

## 2. The signals (`engine.uniforms`, each `{ value }`)
| Signal | Range | From |
|---|---|---|
| `uDaylight` | 0 night .. 1 noon (the sun's height) | calendar, else the sky |
| `uNight` | 0 by day .. 1 at night: the curve `lightPool` `dusk` lamps fade on, for lit windows and signs | calendar or sky |
| `uSunDir` | unit `Vector3` toward the sun | sky |
| `uSunColor` | `Color` of the sun now, from the keyframes (white with no sky): `sun.color.copy(...)` | sky |
| `uTimeOfDay` | 0-1 (0 midnight, 0.5 noon) | calendar, else the sky's fixed time |
| `uRain`, `uSnow`, `uWeatherCloud` | 0-1 | weather state |
| `uWind` | wind multiplier (1 = calm) | weather state |
| `uWeatherLight`, `uWeatherFog` | multipliers (1 = clear): apply them to your own light and fog distance | weather state |
| `uViewDistance` | how far the world is meant to be seen, meters (default 600): your fog's far; the stream radius without terrain | `terrain({ viewFog: true })` |
| `uFoliageTint`, `uGroundTint`, `uGroundCover` | season tints, snow cover | sky + calendar |
| `uSkyTop`, `uSkyHorizon` | the engine dome's colors (its neutral keyframes unless the game sets them) | sky |

Read `.value` in JS, or share the object in a shader (`uniforms: { uDaylight: engine.uniforms.uDaylight }`). The sky colors are the engine dome's
picture, not physics: a styled game mixes them in only if it wants. Gameplay that changes the picture (a cutscene dims the world) goes through a signal
of your own that the picture code reads.

Written every frame: `uSkyTop` and `uSkyHorizon` take `engine.sky.top` / `engine.sky.horizon`, `uDaylight` and `uTimeOfDay` take a `daylight` / `timeOfDay` measure; a direct write is lost and warns once (`signal-overwritten`). `uSunDir` (the same vector as `engine.sky.sunDir`) and `camera.aspect` stay as written: `engine.autoView.manual('sunDir', false)` gives one back.

## 3. The hook: `engine.onRender`, not `onFrame`
```js fragment
const sun = new THREE.DirectionalLight(0xffffff, 2), hemi = new THREE.HemisphereLight();  // made once in picture/lights.js
engine.onRender(() => {
  const day = engine.uniforms.uDaylight.value, rain = engine.uniforms.uRain.value;
  sun.position.copy(engine.uniforms.uSunDir.value).multiplyScalar(100);
  sun.intensity = 2.2 * day * (1 - rain * 0.6);
  hemi.color.copy(NIGHT.sky).lerp(DAY.sky, day);  // your palette, your rule
  for (const m of walls) m.emissiveIntensity = 0.2 * (1 - day);  // flat look: the wall keeps its own color at night
});
```
`onRender` (default `'before'`) runs once per drawn frame after every module updated; `onFrame` runs before them and would read last frame's values (noon on the first frame).

## 3b. Rules that keep the folder working in a bigger game
- **One object's state goes through a name `picture/` exports.** Signals are global, but one street lamp shot out or one flickering sign is not. Gameplay calls
  a name of your own and never touches the light or the material:
  ```js fragment
  // picture/index.js
  export const picture = { lights, materials, lamp: id => ({ off() { lamps.get(id).intensity = 0; } }) };
  // gameplay
  picture.lamp(hit.id).off();
  ```
- **`picture/` shaders follow the renderer.** A new game is on WebGPU and writes TSL (recipe 56); `ShaderMaterial` and `onBeforeCompile` do not run there, and a GLSL material
  on WebGPU stops at start and names itself. A `--webgl` game writes GLSL (recipe 43).
- **The picture reads the quality tier.** The engine cannot hold your code to it, so read `engine.tier` (`'low'` | `'high'`) for what costs: shadow map size,
  real light count, post effects. The generated `lights.js` sizes its shadow map this way.

## 3c. Wiring `picture/` parts
- **One `engine.onRender`, in `picture/index.js`.** It calls each part's `update(signals)` and holds no values. A part never adds its own hook: two hooks hide the order.
- **Order is the call order.** Put what others read first (`palette`, a part that computes this frame's mood from signals), then lights, sky, materials, post.
- **Who may write what:** one part owns each value (`lights.js` the lights, `sky.js` fog and background, `materials.js` the materials, `post.js` tone and exposure);
  another part changes a signal of its own that the owner reads.
- **Several steps in one function are fine** (`fog.color.copy(a); fog.color.lerp(b, t);`), and so is one game state taking over a value another state wrote earlier.

Under the dev server (`npm run dev`, `threedog snap`) the engine records which line last changed each value:
```js fragment
engine.describe('picture').picture.writers  // the state at a glance, every value at once: { values: { 'fog.far': { at: 'picture/sky.js:12', framesAgo: 3 }, 'light:sun.intensity': ... }, conflicts: [...] }
engine.explain({ value: 'fog.far' })  // who wrote it, its last writers with frames (detail.history), a fight if one was seen, and the fix
engine.debug.watch('boss.hp', boss, 'hp')  // any other value, by a name you choose; a Color, Vector or rotation is watched inside
```
Names are `renderer.toneMapping`, `renderer.toneMappingExposure`, `scene.fog`, `fog.near | far | density | color`, `scene.environment`, `scene.environmentIntensity`,
`scene.background`, `scene.backgroundIntensity`, `light:<name>.intensity | color | groundColor | position`, `material:<name>.color | emissive | opacity | emissiveIntensity`,
every id in `describe().owned` (when the engine yields, the warning and `writtenAt` name the line that took the value; an id with no plain property, like `view.pixelRatio`, answers `not tracked`), and any shared point's name.
`framesAgo` is how old the answer is (a value written every frame is sampled about twice a second; `writtenSince: true`: it moved since). A value set before it entered the scene,
a console write or a bundled build (`threedog shot`, `npm test`) answers `not tracked` with the reason. Nothing is blocked, and an unchanged write is not seen, so no conflict is not proof of none.

**A conflict hint** is one line: `fog.far: two writers in one frame, picture/sky.js:14 and picture/rival.js:3; the last write stands`, and `engine.explain({ value: 'fog.far' })` has the history and the fix.
Two writers that never share a frame but keep overwriting each other read `taking turns across frames` (one state handing a value to another does not count). Fix: one part owns the value; delete the other write or make it a signal or shared value the owner reads. Warns once per value; writes through a shared helper count as the helper's line.

## 3d. Save to the library, pull it out
A part of the picture that worked can go into your library (outside the repo, `~/.threedog/library`) and come back in the next game:
```
threedog lib add picture/flat-materials.js --kind picture --summary "Flat material family, emissive rises at night"
threedog lib add picture/shaders/ink.glsl --kind picture           # a .glsl file works the same
threedog lib list flat                                       # next game: look before writing your own
threedog lib pull flat-materials                             # lands in picture/ (a .glsl lands in picture/shaders/)
```
A picture entry is **one plain three.js file that exports a function**: `lib add` refuses a file that imports its siblings (`./palette.js`) and names them. Take the numbers as parameters:
```js fragment
/** Flat materials by name: a flat color plus an emissive copy of it that rises at night.
 *  @param {object} THREE three.js  @param {Record<string, number>} palette name → hex  @param {number} nightGlow emissive at full night */
export function flatMaterials(THREE, palette, nightGlow = 0.2) {
  const mat = {};
  for (const [k, hex] of Object.entries(palette)) mat[k] = new THREE.MeshLambertMaterial({ color: hex, emissive: hex, emissiveIntensity: 0 });
  return { mat, update(signals) {
    const night = 1 - Math.min(1, signals.uDaylight.value * 4);
    for (const m of Object.values(mat)) m.emissiveIntensity = nightGlow * night;
  } };
}
```
The pulled copy is yours to adapt.

## 3e. Several parts change one picture value
A sunset and a cutscene both dim the sun. If each writes the light, the second one's end brings back a value that is already wrong. Make the value a shared point
(recipe 55): everyone changes it with `engine.mod`, and one place in `picture/` reads the result and writes three.js once.
```js fragment
// picture/lights.js: the one writer
const level = engine.stacks.define('sun.level', { base: 1, min: 0, save: false });
const sun = new THREE.DirectionalLight(0xffffff, 2);
engine.onRender(() => { sun.intensity = 2.2 * engine.uniforms.uDaylight.value * level.value(); });

// anywhere else: nobody touches the light
const dusk = engine.mod('sun.level', { owner: 'sunset', mul: 0.6 });
const hold = engine.mod('sun.level', { owner: 'cutscene', mul: 0.3, for: 4 });  // 0.18 while both are on
dusk.remove();  // they end in any order
```
An amount that moves takes one entry and changes it: `const wet = ctx.mod('sun.level', { mul: 1 });` once in the install, then `wet.change(1 - 0.5 * rain)` each frame (a `ctx.mod` per frame piles up entries). In a module use `ctx.mod`: it goes with the module.
`describe().shared` shows who holds it and why it reads what it reads. A value only one part writes needs none of this: write the light.

## 3f. Picture parts: three.js code from different sources in one game
The `picture/` folder of section 0 is one part holding the whole look, with slot `picture`. Use smaller parts when code lives beside code you did not write (a library entry,
another agent's sky). A part is an ordinary module with `type: 'picture'`, plain three.js inside.
```js fragment
// picture/harbor-fog.js
import * as THREE from 'three';

export const harborFog = ({ near = 10, far = 200 } = {}) => ({
  name: 'harborFog', type: 'picture', provides: ['fog'],
  install(e, ctx) {
    ctx.borrow(e.scene, { fog: new THREE.Fog(0x667788, near, far) });  // given back when the part goes
    const flare = new THREE.PointLight(0xffaa66, 2, 30);
    e.scene.add(flare);
    ctx.track(e.onRender(() => {  // reads signals, writes three.js
      e.scene.fog.far = far * (1 - 0.6 * e.uniforms.uRain.value);
      flare.intensity = 2 * (1 - e.uniforms.uDaylight.value);
    }));
    ctx.track({ remove() { e.scene.remove(flare); flare.dispose(); } });  // what it added goes with it
  },
});
```
`ctx.borrow(obj, values)` writes properties on something the part does not own (`scene.fog`, `renderer.toneMapping`, the engine dome's `visible`) and restores them when the part goes, is disabled after an error, or on the handle's `remove()`. A value goes back only while this borrow holds it and it is what the borrow wrote, so a fog the game set meanwhile stands. One property has one holder (a second borrow is refused): a value several parts want goes on a shared point (`engine.mod`).
`engine.use(harborFog())` installs it, `engine.unuse('harborFog')` removes it, `engine.use(otherFog(), { replaces: 'fog' })` swaps it. A part may use its own hooks (the single `onRender` of 3c is for one author's folder).

**A value is one of three kinds, and each has one rule:**
| Kind | Example | Rule | On a collision |
|---|---|---|---|
| Only one can exist | the fog, the tone curve, the main light | take a slot: `provides: ['fog']` | a second claim stops at install (`shared-taken`); `{ replaces: 'fog' }` swaps on purpose |
| Several parties change it | rain and a cutscene both dim the sun | a shared value: `engine.stacks.define` and `engine.mod` (3e), one place writes three.js | combined by the formula |
| Just more things | another lamp, another mesh | add it | none, it only costs budget |

**The slot names**, so two sources spell a claim the same way (`PICTURE_SLOTS`, type `PictureSlot`). Slot names are free text, and a near miss of these in a picture module is warned about:
| Slot | Covers |
|---|---|
| `sky` | the sky behind everything; the engine's `sky()` holds it, so a sky of your own says `{ replaces: 'sky' }` or leaves `sky()` out |
| `fog` | `scene.fog`, `fog.near / far / density / color` |
| `tone` | `renderer.toneMapping`, `renderer.toneMappingExposure` |
| `environment` | `scene.environment`, `scene.environmentIntensity` |
| `background` | `scene.background`, `scene.backgroundIntensity` (a sky drawn this way takes `sky` and `background`) |
| `sun` | the light named `'sun'`: name your main light so, because the name is how another source and this table find it. Add `lights: false` to `createEngine`, or the placeholder sun shines as well |

A part that needs another one says `requires: ['sun']`. A shared value a part defines has to survive a reinstall: `e.stacks.has(n) ? e.stacks.get(n) : e.stacks.define(n, { base: 1, save: false })`.

**What the dev server reports** (`npm run dev`, `threedog snap`). It observes and blocks nothing; a bundled build has none of it. `describe('picture').picture.slots` shows who holds what, in every build.
- `picture-held`: a value in a held slot was written by anyone else, in any frame. It names the holder, the writer and both lines. Fix: delete the write, swap the holder, or make it a shared value.
  In `picture.writers.values`, a held value says `writer: 'holder'` or `writer: 'stray'`; `picture.writers.held` lists the strays.
- `picture-conflict`: two places wrote one value in one frame or kept taking turns (3c), with the part names when they are parts.
- `picture-leftover`: a part went and left lights, objects, post effects, frame callbacks, or the fog, environment or background it wrote. It names each with its line; `picture.writers.leftovers` lists them.
  `ctx.track` only removes what it was handed, so anything else needs a `remove()` or the part's `dispose()`.

**What this cannot catch:** code that never runs, a write before the holder took its slot, a write of the same value, a thing added under another object than the scene root, a main light
not named `'sun'`, and taste (a warm lamp against a cold sea): that takes a screenshot (section 6).

**When not to bother:** one author, one game, a `picture/` folder that works. Turn a file into a part when another source arrives, not before.

**Switching the whole look at run time.** Keep each look as a module holding `picture` and whatever other slots it writes (`provides: ['picture', 'tone', 'fog', 'sun']`), then:
```js fragment
engine.use(duskPicture(), { replaces: 'picture' });  // the old look's lights, hooks, post effects and borrowed values go first
for (const m of myMeshes) m.material = engine.picture.materials[m.userData.surface];
```
The old materials are disposed and the engine cannot know which of your meshes hold them: **a mesh holding an old look's material must take the new one**, by name as above. What the look added through `ctx` leaves with it.

## 4. A flat illustration (one way among many)
Light alone turns a warm wall under a cool night fill into mud. An illustrator keeps each surface its own color and only shifts it:
- `MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0 })`: raise the emissive copy at night, so faces
  keep their hue; or `MeshBasicMaterial` and pick each face's shade yourself (vertex colors by normal); or `MeshToonMaterial` with a `gradientMap`.
- A warm `HemisphereLight` at night instead of a blue one; the night reads from the sky, the windows and the lamps, not from tinting walls blue.
- `NoToneMapping` so the colors come out as written.
- Lamp pools painted (an additive disc on the ground) plus a few real `PointLight`s for the spill near the camera.

**Shadow sides darker than expected?** With no environment map, the ambient you write is all the fill there is. A hemisphere value copied from a scene that also had an
environment map comes out too dark on faces away from the sun: raise the ambient, add an `AmbientLight`, or generate an environment (`engine.sky.environment()`).
`uWeatherLight` is sized for the sun: multiplying ambient by it as well darkens rain more than the sun alone does, so give ambient a share of it.

## 4b. Pixel art: low-resolution rendering with sharp scaling
Pixel art means drawing fewer pixels and then keeping every edge hard when they are enlarged. One engine option does the screen side:
- **`createEngine({ pixelSize: k })`, or `engine.setPixelSize(k)` during play.** One art pixel is k real screen pixels at any display scale, through a page zoom or a move to another display. The canvas gets `image-rendering: pixelated`, and `antialias` defaults to off (it blends hard edges; creation-time only: `antialias: true` warns). Fewer than k real pixels at the right and bottom stay empty and show the page behind. `engine.setPixelSize(null)` turns it off.
- **Nothing else changes the size while it is on.** Adaptive resolution stops; the quality tier leaves the ratio alone. `engine.setPixelRatio` throws `pixel-conflict`, and so does `createEngine` given `pixelRatio` or `adaptiveResolution: true` as well. `engine.photo.take()` keeps the art pixels (the drawing buffer's size, whatever its `scale`). A direct `renderer.setPixelRatio` still wins, as in three.js: the engine stops fitting the canvas (recipe 52).
- **The menu follows.** The settings menu has no render scale or adaptive row, and no preset or stored value moves the ratio. Leave out the anti-aliasing row: `settings({ sections: [{ id: 'graphics', omit: ['antialias'] }, 'audio', 'controls', 'language', 'saves'] })` (an omitted row keeps your value).
- **Sample sharply.** `engine.assets.texture(name, { pixelated: true })` sets `NearestFilter` for enlarging and `NearestMipmapNearestFilter` for shrinking. On a texture of
  your own, set `magFilter` and `minFilter` to `THREE.NearestFilter`.
```js
const engine = createEngine({ canvas: document.querySelector('canvas'), pixelSize: 3 });
```
Whatever blends neighbouring pixels works against the look, so judge each post effect and any tone curve (section 4) by eye. Text and panels under `engine.uiRoot` are page elements and stay at screen
resolution. Objects that move by less than an art pixel shimmer; `pixelSnap` and `pixelSprite` below deal with that. `describe().render.scale.pixelSize` reports k.

**A pixel-perfect camera.** `pixelSnap` on `followCamera` or `fixedCamera` rounds the camera to the art grid on the screen's own axes, so a turned or isometric view works. It is orthographic only. A perspective camera throws `camera-option`.
```js fragment
engine.use(followCamera({ projection: 'orthographic', yaw: Math.PI / 4, pitch: 0.6, lockPitch: true, mouseLook: false,
  pixelSnap: { pixelsPerMeter: 32, bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } } }));
```
- **`pixelsPerMeter` decides the view height.** The view must show buffer height / `pixelsPerMeter` world units, so `pixelSnap` sets it, also after a resize. `size` with `pixelSnap` throws `pixel-conflict`; on `fixedCamera` every shot says `projection: 'orthographic'` and has no `size`. The wheel does not zoom: `engine.setPixelSize(k)` is the zoom that keeps art pixels whole. If the game writes `camera.zoom` or `orthoSize` itself, a `pixel-conflict` warning says so, rounding stops, and `describe().camera.pixelSnap.agrees` reads `false` until it is put back.
- **`bounds`** is a world rectangle (`minY` and `maxY` are optional, 0 by default). The camera does not show past it. It is projected on the screen's axes and rounded inward; the true position is clamped, then rounded, so sliding along a bound stays on whole art pixels. Where the level is smaller than the view, the camera centers. At 45 degrees of yaw the screen rectangle is a box around a diamond and shows empty corners: fill them, or keep yaw near a multiple of 90 degrees.
- **Turns.** The grid is read fresh each frame, so a turn or a new `pixelSize` needs no reset. While the view is turning, nothing can hold still on a grid that turns with it; a `track: true` shot on `fixedCamera` turns all the time.
- **A cutscene** holding `engine.takeCamera` is not rounded.
- **The leftover.** `engine.cameraRig.pixelSnap.error` is the last rounding in art pixels on each screen axis, for a game that wants to slide the final image for smooth scrolling (the engine does not).

**The grid on its own.** `threedog/pixel` is math and plain three.js objects, no look of its own. `engine.cameraRig.pixelSnap.grid` is the camera's grid; `pixelGrid({ camera, pixelsPerMeter })` makes one for a camera of yours. `snap(world)` rounds a point on the screen's axes and keeps its depth, `error(world)` says by how much, `toScreen` and `toWorld` convert, and `axes()` gives right, up and forward. Round a drawn position with these, never what physics or a save reads.

**Sprites in a 3D view: `pixelSprite`.** It returns a plain `THREE.Mesh` with your material: a vertical plane that turns around Y with the camera's forward direction. Its height is stretched by `1 / cos(pitch)`, which the view's tilt takes back: one texel is one art pixel.
```js fragment
import { pixelSprite, spriteFrame } from 'threedog/pixel';
const hero = pixelSprite({ grid: engine.cameraRig.pixelSnap.grid, material, width: 16, height: 24, columns: 4, rows: 3, anchor: [0.5, 0], snap: 'followed' });
spriteFrame(hero, 5, true);  // frame 5 of the sheet, mirrored
```
- Frames count left to right, top to bottom, and `width` and `height` are one frame in texels. The material is yours: `alphaTest` for hard edges, a nearest filter on its texture. The mesh goes in the scene or to a character as its `model` (recipe 13 section 3c). `mesh.position` stays exact; only the drawn matrix is rounded.
- `snap: 'world'` (the default) rounds the drawn position to the grid: use it for anything that stands or walks on its own. `snap: 'followed'` is for the one object the camera follows (rounding both separately steps them on different frames: a one-pixel shake), so it takes the camera's rounding; on anything else it would creep against the ground.
- Standing upright keeps a head out of the wall behind it: the whole figure has the depth of its feet, no shader needed (a plane tilted toward the camera would lean back through the wall). One case still cuts: a wall not parallel to the sprite, with the feet nearer to it than `(sprite width / 2) * |sin(angle between them)|`. Keep the collision radius above that.

**Lighting a sprite from its silhouette.** A flat plane lights flat. A normal map made from the sprite's outline rounds its edge with no drawing work: height is the distance from each texel to the nearest transparent one, blurred; the normal is its slope. A painted one goes in the same slot.
```js fragment
// picture/spriteNormals.js
import * as THREE from 'three';
export function silhouetteNormals(image, frameWidth, frameHeight, { strength = 1.5, blur = 1 } = {}) {
  const W = image.width, H = image.height, ctx = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const alpha = ctx.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H * 4), w = frameWidth, h = frameHeight;
  for (let fy = 0; fy < H; fy += h) for (let fx = 0; fx < W; fx += w) {  // each frame alone: neighbouring frames must not change its outline
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && alpha[((fy + y) * W + fx + x) * 4 + 3] > 127;
    const d = new Float32Array(w * h), at = (a, x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = inside(x, y) ? 1e6 : 0;
    const pass = (x, y, s) => {  // two sweeps of a chamfer distance: plenty for sprite-sized frames
      const v = Math.min(d[y * w + x], at(d, x - s, y) + 1, at(d, x, y - s) + 1, at(d, x - s, y - s) + 1.414, at(d, x + s, y - s) + 1.414);
      d[y * w + x] = v;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pass(x, y, 1);
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) pass(x, y, -1);
    let height = d;
    for (let i = 0; i < blur; i++) {
      const next = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) sum += at(height, x + k, y + j);
        next[y * w + x] = sum / 9;
      }
      height = next;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (at(height, x + 1, y) - at(height, x - 1, y)) * strength, dy = (at(height, x, y - 1) - at(height, x, y + 1)) * strength;  // y: rows run down, a normal's y runs up
      const l = Math.hypot(dx, dy, 1), o = ((H - 1 - fy - y) * W + fx + x) * 4;  // a DataTexture's first row is the bottom
      out.set([(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255, 255], o);
    }
  }
  const t = new THREE.DataTexture(out, W, H);
  t.magFilter = t.minFilter = THREE.NearestFilter;  // hard art pixels, and no mipmaps: they would mix neighbouring frames
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;  // numbers, not colours: an sRGB read would bend every normal
  t.needsUpdate = true;
  return t;
}
```
Give it to the sprite's material as `normalMap`, on a lit material such as `MeshStandardMaterial`, next to the sheet it was made from. Measured on WebGL and WebGPU: a side light brightens the near half about twice as much as the far half. A sprite mirrored with `spriteFrame` lights the right way round (three.js takes the tangent from the UVs). A light straight overhead is the weak case. The plane's normal is horizontal, so without a normal map the sprite goes black, and with one only its upper half lights: add an ambient or hemisphere light, or keep the main light in front of the view.

## 5. What the engine still does with all of this off
- `scene.background` starts as a neutral gray: write your own color or sky.
- `renderer.shadowMap.enabled` is on; nothing casts until your lights do.
- Your materials are never patched unasked: `applyEffects(mat)` gives one the cloud shadow, which `engine.uniforms.uCloudShadow` then deepens.
- The page-wide changes to three.js are listed in `describe().threePatches` (`THREE.md`).

## 6. Check the picture
`threedog shot <page> --time 22:00` (and `--weather rain`): the picture hints measure your lights and glowing materials as they are (the probe's renders do not
run your `onRender`), name the key and fill lights, and report fog that covers most of the picture, a black frame and its material, a shader in view that ignores
fog or tone curve, a light layout that changed during play, and transparent meshes whose pixels depend on draw order. How to judge: `recipes/60-judge-the-picture.md`.
