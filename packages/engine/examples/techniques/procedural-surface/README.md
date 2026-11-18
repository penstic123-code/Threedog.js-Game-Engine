Procedural surface: world-space triplanar variation, a lazily painted brush texture, baked cavity, edge wear and instance jitter, with scales picked from the camera.

# Procedural surface (technique example)

Surface quality without texture files. Four identical houses at a typical game camera distance: plain, world noise at a scale picked from
the camera, the same noise tuned up close (it has faded away), and a stack of brush texture + cavity + edge wear; in front, crates from one
InstancedMesh with and without per-instance jitter. Page `/technique-surface.html` (`npm run dev`). The engine never imports this folder.

## The principle
**Detail must survive the real camera.** Detail tuned one meter from a wall is a few pixels wide at the game's camera. Either it shimmers, or
(with mipmaps or a distance fade) it averages away to the base color, which is what the third house shows. Think in screen pixels per
pattern cell: small cells (a handful of pixels) read as grain; large ones (tens of pixels) read as patches and stains.
- **Stack by scale**: one large variation (patches, dirt, sun-bleaching), one small texture (strokes, grain), and something that follows the
  form (cavity, wear). Two of the same scale fight; one of each reads as "made of something".
- **Variation smaller than the difference between materials**: if two plaster walls vary more than plaster differs from wood, the materials
  stop reading.
- **Jitter is aging, not identity**: kept small, twenty crates look like one kind of crate used for years; pushed far, they look like twenty kinds.

How to judge it: a shot at the camera you ship, not a close-up. Can you still see the variation on the wall you care about? If you have to
zoom to see it, the scale is wrong for this game, whatever it looks like in a close-up.

## Plain three.js
- Pattern scale: `texture.repeat` and `wrapS / wrapT = THREE.RepeatWrapping` ([Texture](https://threejs.org/docs/#api/en/textures/Texture)).
- World-space / triplanar: `material.onBeforeCompile` sampling a texture or noise by world position on three planes, blended by the normal
  (no UVs, no stretching on walls).
- Painted textures in code: [CanvasTexture](https://threejs.org/docs/#api/en/textures/CanvasTexture), created when first needed.
- Cavity: occlusion written into a vertex `color` attribute (`vertexColors: true`), or an `aoMap`.
- Edge wear: a custom vertex attribute (distance to the edge) read in `onBeforeCompile`.
- Instance jitter: `InstancedMesh.setColorAt` ([InstancedMesh](https://threejs.org/docs/#api/en/objects/InstancedMesh)).
- Texture files instead: `map`, `roughnessMap`, `normalMap` on [MeshStandardMaterial](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial).

## Style routes
- **Painted**: brush strokes as the small layer, large soft patches, cavity. One canvas texture, three samples per pixel if triplanar.
- **Realistic**: fine grain plus dirt patches, edge wear on corners; or photo textures. More texture memory or more noise math.
- **Clean low-poly**: flat color plus cavity alone. Load-time bake only.
- **Pixel / retro**: one low-resolution texture with nearest filtering, sized so a texel is a few screen pixels. One sample.
- **Toon**: no noise; variation only by hue per instance and a cavity band. Almost free.

## The engine helper (optional convenience)
Copy `surface.js` into a game; `main.js` is only the demo. `scaleForCamera(camera, distance, viewHeightPx, cellPx)` turns "how many screen
pixels should one pattern cell cover" into repeats per meter for that camera. The engine's detail `fade` is on by default, which is why
mis-scaled detail averages away instead of shimmering. The example values are only the demo's current choice.

| tool | what it does | the knob that matters |
|---|---|---|
| `worldVariation` | engine `detail` with `projection: 'triplanar'`: noise (or a texture) in world space, no UVs, no stretching on walls | `scale` from the camera, `strength` |
| `brushTexture` | a canvas of light strokes, drawn the first time it is asked for; use it as `worldVariation({ texture })` | stroke size vs. cell pixels |
| `cavity` | engine `bakeVertexAO` into vertex colors: corners, wall feet and the area under the roof darken | `strength`, occluders (ground, roof) |
| `edgeWear` | an `aEdge` attribute (distance to the box edge) + a `color` patch with engine noise that lightens a ragged strip | `width`, `strength` |
| `jitterInstances` | small per-instance hue / value offsets (three's `setColorAt`) | `hue`, `value` |

Cost:
- `worldVariation` (triplanar): three noise or texture samples per pixel instead of one; noticeable only on full-screen surfaces on weak GPUs.
- `brushTexture`: one 256x256 canvas, drawn once (a few ms at load).
- `cavity`: load time only (BVH ray casts per vertex; the demo's four walls bake in well under a second), nothing per frame.
- `edgeWear`: one attribute and a few noise operations per pixel.
- `jitterInstances`: free (instance colors are part of the instanced draw).

Rules (correctness):
- Anything that needs a browser (canvas, `document`) is created inside a builder function, never at module load: `threedog check` and other
  Node tools import art code without a DOM.
- Vertex AO needs vertices: give boxes segments, or bake on the real mesh.
- `worldVariation` follows world position: a moving object's pattern slides over it. Use UV or object-space detail for things that move.
- One `detail` per material; stack further layers as patches (as `edgeWear` does).

Sources: triplanar mapping as commonly described (Ben Golus, "Normal Mapping for a Triplanar Shader", 2017); vertex AO and edge wear as
standard game-art practice. Code written for this engine; nothing copied.

This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). TSL version: recipe 56.
