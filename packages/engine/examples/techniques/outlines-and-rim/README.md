Outlines and rim: post outline vs inverted hull (world or screen units) vs rim light for silhouette readability, side by side with costs.

# Outlines and rim (technique example)

Five columns of gray objects in front of a gray wall: nothing, post outline, inverted hull in world units, inverted hull in screen pixels,
rim light. A capsule far behind each column shows how line width behaves with distance. Page `/technique-outlines.html` (`npm run dev`).
The engine never imports this folder.

## The principle
The goal is a silhouette that reads when object and background have nearly the same value. The eye finds an object by an edge: a change of
value, hue or a drawn line along its outline. So first ask whether value or hue can separate the subject from its background (a darker
character, a lighter backdrop, a fog layer). Lines are one answer to readability, not the only one; rim light separates without drawing anything.
- A screen-wide line (edge detection on depth / normals) lines everything the same way: props, terrain steps, the horizon. It reads as ink or
  comic, and it cannot give one object a different line.
- A per-object line (inverted hull) lets the player and pickups carry a line the scenery does not, or a selected unit a colored one. A line in
  world units thins with distance and feels like a painted rim on a toy; a line in screen pixels stays constant and feels like ink.
- A rim light (fresnel) brightens the edge facing away from the viewer; it follows the form, suits soft and realistic looks where black lines
  would be out of place, and keeps working as the light changes.

How to judge it: a shot at the real camera, with the busiest background the game has. Can you find the player in half a second?

## Plain three.js
- Post outline: `OutlinePass` for selected objects ([webgl_postprocessing_outline](https://threejs.org/examples/#webgl_postprocessing_outline)),
  or a `ShaderPass` that detects depth / normal jumps (a depth texture on the render target,
  [DepthTexture](https://threejs.org/docs/#api/en/textures/DepthTexture)); `EffectComposer` runs it.
- Inverted hull: a second mesh with `side: THREE.BackSide`, an unlit material, and vertices pushed out along smooth normals in
  `onBeforeCompile` (or a scaled copy for convex shapes); `castShadow = false`.
- Rim: `material.onBeforeCompile` adding `pow(1.0 - dot(normal, viewDir), power)` to the outgoing light; or a `ShaderMaterial`.
- Toon shading often pairs with these: [MeshToonMaterial](https://threejs.org/docs/#api/en/materials/MeshToonMaterial)
  ([webgl_materials_toon](https://threejs.org/examples/#webgl_materials_toon)).

## Style routes
- **Ink / comic**: a post outline on depth and normals, every object lined alike. One full-screen pass, any number of objects.
- **Cel-shaded hero lines**: inverted hulls in screen pixels on characters and pickups only. One extra draw per outlined mesh.
- **Toy / clay**: hulls in world units, thinning with distance. Same cost as above.
- **Soft / realistic**: rim light only, no lines. A few operations per pixel.
- **Value design, no effect**: separate by palette and fog (darker subjects, lighter backdrops). Free.
- **Selection highlight**: a colored hull or `OutlinePass` on the selected object only.

## The engine helper (optional convenience)
Copy `outlines.js` into a game; only the demo around it is not part of the tool (`main.js` shapes; `picture/` has the lights, materials by name and the post pass). It gives `trackResolution(engine)` (the drawing-buffer size for screen-unit hulls),
`addHull(mesh, { thickness, units: 'world' | 'screen', color })`, and `rimPatch({ color, strength, power, shadowSide })`.

| route | how | width | cost |
|---|---|---|---|
| post outline | `@threedog/post-effects` `outline()` through `engine.post.add(...)` (see `picture/post.js`): one full-screen pass that draws where depth jumps (`mode: 'normal'` / `'both'` also creases) | screen pixels | one full-screen pass reading depth, any number of objects; `'normal'` adds a scene render; `offLayer` adds a render of the exempt objects |
| inverted hull | `addHull(mesh, { units })`: a back-face copy pushed out along smooth normals, unlit, keeps fog | `'world'`: meters, thins with distance; `'screen'`: pixels, constant | one more draw (and its vertices) per outlined mesh; no full-screen cost |
| rim light | `rimPatch()`: a fresnel edge light added in the material's lighting (engine `threedogRim`) | follows the form | a few ALU per pixel, no extra draw |

Rules (correctness):
- Hulls need smooth (welded) normals; `addHull` welds a copy. Split normals (boxes, flat shading) open gaps at the corners.
- A hull must not cast shadows (it would fatten the object's shadow); `addHull` turns that off.
- The screen-unit hull needs the drawing-buffer size: call `trackResolution(engine)` once.
- `outline({ offLayer })` skips any pixel next to an exempt object, so keep ground and backdrop off that layer if lines should appear
  where outlined objects meet them.
- Skinned or morphing meshes: build the hull from the same skinned mesh (or use the post outline); a static copy will not follow the pose.

Sources: inverted hull as commonly used in cel-shaded games (e.g. the Guilty Gear Xrd GDC 2015 talk), depth / normal edge detection as in
three.js's `OutlinePass` family; the post outline here is the engine's own `@threedog/post-effects`. Code written for this engine; nothing copied.
