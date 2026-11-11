# Blender to game (GLB) route

> **Covers:** from Blender to a GLB in the game: export, check, compress, use, troubleshoot.
> **Use when:** art made in Blender.
> **Shortest:** `threedog assets check art/models/town.glb`.
> **Sections:** 1 In Blender · 2 Export glTF / · 3 Check, then compress · 4 Use it · 5 The GLB's own · 6 Smallest copyable flow · 7 Troubleshooting

Code-built geometry (`models.js`, recipe 05) is good for blockout, props and variations, but it cannot reach the finish of hand-made art: painted
textures, baked shadows, sculpted edges. That finish comes from Blender. This page is the whole path, in order. The level naming rules live in
`10-blender-level.md`; they are not repeated here.

## 1. In Blender
1. **Model** at real scale (1 unit = 1 meter), origin at the object's base. Apply scale and rotation (Ctrl+A).
2. **UV unwrap** every textured mesh. A mesh with a texture but no UV set shows one flat pixel (`assets check` warns `texture-without-uv`).
3. **Bake** the picture into textures: base color (the paint), optional AO, optional baked light. One image per material keeps draw calls low;
   one shared atlas for many small props is cheaper still. Keep textures at 2048 or less (`assets check` warns above that).
4. **Name things**: objects, materials and (for animated models) actions. Names survive export and compression, and the engine reads them
   (`spawn`, `col_xxx`, `trigger_xxx`, `template`, `id`; ground type from the material name, see recipe 10).

## 2. Export glTF / GLB
File > Export > glTF 2.0, into `art/models/` of the game:
| Setting | Value | Why |
|---|---|---|
| Format | glTF Binary (.glb) | one file; `.gltf` plus loose files also works |
| Include > Custom Properties | on | `template`, `id`, `groundType`, `shape`... reach `userData` only this way |
| Transform > +Y Up | on | three.js is Y-up; the exporter converts from Blender's Z-up |
| Mesh > Apply Modifiers | on | the game gets the shape you see |
| Mesh > UVs, Normals, Vertex Colors | on if used | missing data cannot be added later |
| Material > Images | Automatic (embedded in the .glb) | `threedog assets optimize` recompresses them anyway |
| Animation > Actions / NLA tracks | on for animated models | each action becomes one clip; name it as the game will (`Idle`, `Walk`, `Slash`) |
| Limit to > Visible Objects | off for levels | hidden `col_` boxes must be exported |

Do not join meshes or decimate a level: node names are its interface.

## 3. Check, then compress
```
threedog assets check art/models/town.glb   # inspect only: spawns, col_ colliders, trigger_ zones, template / id nodes, material suspicions
threedog assets optimize                             # compress art/models/*.glb into public/optimized/ (add -w my-game for a game)
```
`assets check` also lists materials, textures with the color space three gives them (by slot), normal maps, clips, `col_` colliders and template / id nodes.
After loading, `engine.assets.report('hero')` (pass a copy from `model()` to check what the game shows) lists the same from the scene and
flags what the file has but the scene lost: `normal-map-lost`, `material-replaced` (your code took over), `clip-lost`, `clip-unmapped` (an animation
state names a clip the file lacks), `node-lost`, and wrong color spaces. The engine never recomputes normals or drops a normal map on a GLB; only code
that swaps materials as in section 5 does.
Swapping an export for a new one: `threedog assets check new.glb --against old.glb` lists what the old file had and the new one lacks (errors: `col_`
colliders, template / id nodes, spawn / trigger_ / npc_ / marker_ points; warnings: clips, materials, points moved over 0.5 m, a bounding box that changed over 15%).
`assets check` exits 1 on errors (`--strict`: on warnings too; `--json` for tools). It changes no file.
`assets` keeps names, hierarchy and materials and only compresses:
| Step | What it does | When it matters |
|---|---|---|
| Meshopt | compresses geometry; the decoder ships with the engine | always on; smaller download, no visual change |
| KTX2 | textures stay compressed on the GPU too, and the download shrinks | always on for a model with textures; if no encoder runs (`assets optimize` in `../COMMANDS.md`), that model fails, the command says why, and the game's `assets.js` stays as it was |

It needs `@gltf-transform/cli` (`npm i -D @gltf-transform/cli`); its current release pulls a `glob`/`minimatch` that `npm audit` flags (moderate, build time only), so add `"overrides": { "@donmccurdy/caporal": { "glob": "^14.0.4" } }` to your package.json. `--force` redoes unchanged files too.

### The same shot again, before and after
Declare fixed views once: `engine.views.define('gate', { position: [10, 4, 12], target: [0, 1, 0], fov: 50 })` (`views.show(name)` also works in code, a pose `{ position, target, fov }` too). Then
`npm run shot -- -w my-game --view gate --keep` takes the picture from there in any game (the page's own `?view=` still wins where a page handles it, as
in the picture test). After a change, `npm run shot -- -w my-game --view gate --compare .threedog/shots/<before>.png` prints both file names, one pixel-diff
number (0 = identical) and the brightness / saturation / contrast / detail differences. A view holds the camera (`engine.takeCamera`) until `views.release()` or the handle `show()` returns is removed; a cutscene that held it before gets it back.
Views can also be content: `content/views.js` = `{ gate: { position: [10, 4, 12], target: [0, 1, 0], fov: 50 } }` is defined by `engine.content.load` (checked by `npm run check`; example: `examples/action/content/views.js`, `npm run shot -- action --view corner`).
`describe render` also shows the renderer output color space and warns when it is not srgb; `assets.report` flags color maps that are not srgb and data maps that are.

### Looking at one part of the render
`engine.debug.view('albedo')` shows only the base color and texture (unlit), `'lighting'` plain white clay under the scene lights, `'shadow'` the same with
ambient and hemisphere light hidden so shadows read black, `'normals'` the normals as color (a normal map shows here); `'off'` restores everything.
A view is temporary and owner-scoped (`{ owner }`; another owner needs `force: true` to clear it), never saved, and `describe().render` / `describe render`
start with a DEBUG VIEW line while one is on, so a screenshot of clay is not taken for the real picture. Meshes added after the call are not covered: call it again. One model or material alone, per channel: recipe 05 "Look-dev".

## 4. Use it
Register the compressed file in the asset pack and refer to it by name everywhere else:
```js
engine.assets.manifest({ name: 'town-art', models: {
  well: '/models/well.glb',
  hero: { url: '/models/hero.glb', critical: true, animation: { states: { attack: { clip: 'Slash', loop: false } } } },
} });
// content/templates.js:  well: { model: 'well', collide: 'circle' }      (recipe 30)
// content/props.js:      { template: 'well', id: 'well-square', place: 'square', x: 4, z: -2 }
// or in code:            engine.add(await engine.assets.model('well', { static: true }));
```
A whole level is `level({ url: '/models/town.glb' })` (recipe 10). Animation clips and their mapping to game actions: `13-animation.md`.

## 5. The GLB's own materials
**The GLB keeps its own materials.** The engine loads them as they are (textures, colors, roughness) and does not swap them;
that is what lets a painted or baked texture show. One scene can mix GLB props and code-built things.

There is no automatic mapping from a GLB material name to anything. To give a GLB your game's materials, do it in your game code, per model: name the
material in Blender (`cloth`, `metal`, `glass`) and look it up in your `picture/materials.js`:
```js fragment
const m = await engine.assets.model('hat');
m.traverse(o => { if (o.isMesh && materials[o.material.name]) o.material = materials[o.material.name]; });
```
This replaces the painted material, so the texture is gone unless yours sets `map`.

## 6. Smallest copyable flow
1. Blender: a cube named `well`, UV unwrapped, base color baked to a texture, export `art/models/well.glb` with the settings above.
2. `threedog assets check art/models/well.glb` (no errors), then `threedog assets optimize`.
3. Add `well: '/models/well.glb'` to `engine.assets.manifest({ models })`.
4. `engine.add(await engine.assets.model('well'))`, then `threedog shot /your-page.html --describe-only` or open the page.

## 7. Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| Model too dark, or textures washed out/white | color space: a color map used as data or a data map as color (`assets check` reports `looks like data` / `looks like color`) | color maps (base color, emissive) are sRGB; normal, AO, roughness are Non-Color in Blender; one image per use |
| Texture shows one flat color | no UV set on that mesh (`texture-without-uv`) | unwrap in Blender, export again |
| Emissive never glows | emissive texture with black emissive color (`emissive-hidden`) | set the emissive color to white |
| Node names lost (`spawn`, `col_` not found) | meshes joined before export | keep objects separate; `threedog assets optimize` never flattens or joins; run `assets check` to see what the level finds |
| Custom properties missing (`template`, `id`) | "Custom Properties" off at export | tick it and export again |
| Collision does nothing | `col_` object not exported, or no `collision()` module | export hidden objects; `engine.use(level(...), collision())`; test `engine.collision.walkable({ x, z })` |
| Painted material replaced by a flat look | game code swapped it (section 5) | remove the swap, or give your material a `map` |
| File too big | large textures or many materials | textures at 2048 or less, share atlases, `threedog assets optimize`; sizes are in the `assets` output and `.threedog/optimize-report.json` |
| Clip not found | action name differs from the manifest `animation` mapping | rename the action in Blender or change `clip:` |

See also: `10-blender-level.md` (level names and markers), `43-shader-patches-surfaces.md` (your own material, shader patches),
`35-picture-from-reference.md` (a whole picture from a reference image).
