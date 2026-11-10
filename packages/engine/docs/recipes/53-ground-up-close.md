# The ground up close: options, crisp color borders, normals, diagnosis

> **Covers:** the ground up close: approaches, crisp borders, lighting normals, diagnosis.
> **Use when:** the ground looks wrong at short range.
> **Shortest:** `terrain({ shading: 'texture' })` is one of the approaches.
> **Sections:** Approaches pick by the · Crisp borders shading 'texture' · Lighting normals normals and · Symptom, causes, options

Not a standard recipe. Several pictures are right for different games, and none is the default. **Decide from the reference images first**: is the
ground flat color shapes, a painted surface, a photographic texture, or a few lit polygons? Then pick a row. If the ground already looks wrong,
jump to the symptoms.

## Approaches (pick by the picture you want)
| Picture | How |
|---|---|
| Flat color blocks, no detail (minimal, flat illustration; on purpose) | `shading: 'flat'` or `'smooth'`, `colors` / `biomeColors`, no `detail`; a few `variation.patches` with `levels` |
| Color map + detail layer + near grass (soft variation, crisp borders) | `terrain({ shading: 'texture', colorResolution, detail })`, grass with `vegetation.define(name, { nearOnly: true })` |
| Tiling or triplanar textures (your own painted, photographed or generated images) | your own material with `map` and `texture.repeat` through `terrain({ material })`, or `detail: { texture: 'name' }` (`projection: 'triplanar'` on slopes and rocks) |
| Vertex color + toon lighting | vertex colors from `colors` and `variation.jitter`, `terrain({ material })` with a `MeshToonMaterial`, `gradientMap: rampTexture(...)`; detail optional |
| Your own shader or plain three.js | `terrain({ material })`, or recipe 40 section 8 (what you give up) |

Detail noises (recipe 43): `grain` fine speckle, `paper` fibres, `stroke` directional streaks (stretched on purpose), `dabs` soft oval dabs with
no direction. `fade` (on by default) removes the detail where its pattern is smaller than a pixel. On any
other material: `applyEffects(mat, { detail })`, with your own function as `detail: { glsl }` (recipe 43).

`variation`, `recolor` and your own material are in recipe 36; terrain basics, the triangle cut and heights from a grid in recipe 28.

## Crisp borders: `shading: 'texture'`
With `shading: 'smooth'` or `'flat'` a color is computed at a grid point (or triangle center) and blended across the triangle. At the default
`resolution: 16` on a 64 m chunk that is one color sample per 4 m, so any border between two ground types can only run along triangle edges.
Raising `resolution` fixes it at the price of triangles (and collision, and edit granularity). `shading: 'texture'` cuts the link: color is
computed per pixel into a per-chunk image, the mesh stays as coarse as you like.

```js
engine.use(terrain({
  shading: 'texture', colorResolution: 192, resolution: 16,
  height: (x, z) => 0,
  // the border is a curve; the ground type is evaluated per pixel
  groundType: (x, z) => z > 32 + 14 * Math.sin(x * 0.09) ? 'grass' : 'sand',
  colors: { grass: 0x5a8a3a, sand: 0xd8c690 }, biomeColors: { grass: ['grass'], sand: ['sand'] },
}));
```
With a preset the same switch gives crisp banks without more triangles: `terrain({ ...terrainPreset(), shading: 'texture' })`.

- A worker computes a `(colorResolution + 2)^2` RGBA image per chunk with the same rules as the vertex colors (`groundType`, `biomeColors`, `steep`, `variation`, painted cells).
  The `+ 2` is a 1 pixel border computed from world coordinates, so neighboring chunks hold identical values at the seam and no seam shows.
- Vertex colors are plain white in this mode. The material samples the image by world xz, so `uv`
  stays free for your own textures. The map goes on before the vertex colors, so every patch after it sees the mapped color: a `mode: 'mix'` season tint (recipe 36) tints the textured top like the side walls.
- Each chunk gets its own clone of the terrain material (same patches, one compiled
  program), so a property you write on the material object after chunks exist does not reach loaded chunks. Assign a material instead (`engine.terrain.material = m`, which remounts every chunk), or pass it through `terrain({ material })`.
- Painted cells (`terrain.edit(..., { paint })`) keep their whole-cell color; the image of every chunk touched by an edit is re-uploaded in place.
- Independent of `resolution`: `resolution` still sets mesh, collision and edit granularity, `colorResolution` only the color detail
  (64 m chunk: 128 = 0.5 m per pixel, 256 = 0.25 m). `recolor` cannot change `colorResolution`.

Cost: the worker time per chunk is mostly your `groundType` called once per pixel, several times that of smooth at 128; 64 costs a quarter, 256 four times that.
Memory is `(colorResolution + 2)^2 x 4` bytes per chunk plus mipmaps (about 90 KB at 128, 23 KB at 64). The first frames pay one shader compile and the uploads, not a cost per frame.
On a low tier (`engine.tier === 'low'`) the default drops to 64 unless you set `colorResolution`. To skip the
color map there, choose the shading yourself: `shading: engine.tier === 'low' ? 'smooth' : 'texture'`.

`variation` shapes *what* color a point gets; `shading` decides *where* it is evaluated. In vertex modes every variation is limited to cell size; in
texture mode it is sampled per pixel, so `patches: { size: 20, levels: 4 }` gives hard-edged color blocks, and a `jitter.size` below the pixel size
(0.5 m at `colorResolution: 128`) comes out as one grain per pixel, coarser than asked.

## Lighting normals: `normals` and `normalFn`
- `shading: 'smooth'` lights with one normal per grid point, `'flat'` one per triangle. In texture mode choose: `normals: 'smooth'` (default) or
  `'flat'` (faceted light, fine color: a low-poly shape with crisp borders).
- `normalFn(i, j, h, cell) => [nx, ny, nz]` replaces the smooth normal at grid point `(i, j)`; `h(i, j)` reads a grid-point height, `cell` is the
  spacing in meters. Pure like `height` / `groundType`. The engine normalizes the result. Default: central difference of the four neighbors.
```js
terrain({ normalFn: (i, j, h, cell) => [(h(i - 1, j) - h(i + 1, j)) / cell, 4, (h(i, j - 1) - h(i, j + 1)) / cell] })  // gentler lighting on slopes
```
`normals` and `normalFn` change light only, never height or collision. `engine.terrain.recolor({ normals: 'flat' })` changes it at run time (rebuilds the chunks).

## Symptom, causes, options
**Brushed metal at grazing angles.** Cause: `stroke` stretches one axis (`stretch` 6) and `world` projection looks straight down, so a flat
ground seen at a low angle shows the stretch as long streaks. Options: `noise: 'dabs'` or `'grain'` (no stretch); `stretch: 1`; a smaller
`strength`; `projection: 'triplanar'` only on slopes; no detail at all if the reference is flat.

**Slopes show terraces or creases.** Causes: heights from sparse data with linear (bilinear) interpolation show the data grid as kinks along
its cell lines (`terrain({ heightmap })` always reads its image bilinearly; `sampleGrid` defaults to `interp: 'linear'`); a coarse mesh
`resolution` (16 per 64 m chunk = one height every 4 m); `shading: 'flat'`, which lights each triangle on its own so every facet shows.
Options, any of them: more height samples (a larger image or table), or the data smoothed before the terrain reads it; `sampleGrid(...,
{ interp: 'cubic' })` for smooth heights everywhere outside the terrain module (placement, gameplay; recipe 28 section 9); a finer `resolution` (more triangles, collision and edit cells); `shading: 'smooth'`,
or `normals: 'smooth'` with `shading: 'texture'`; `diagonal: 'adaptive'` against zigzag ridges; or noise in the `height` function (`n.fbm`; ridges from
folding it) instead of a sparse table. Terraces can also be the picture you want: `interp: 'nearest'`, or a stepped `height`.

**Blurry up close.** Cause: the color map is `colorResolution + 2` pixels per 64 m chunk side; 128 is 0.5 m per pixel, which is soft when the
camera is within a few meters. It does not depend on the mesh `resolution`. Options: `colorResolution: 256` (four times the image memory and worker time); a detail layer on top (it is computed per screen
pixel, so it stays sharp); near grass over the ground; or accept soft color and let a texture carry the fine part.

**One flat green.** Cause: not resolution. Color comes from `colors` / `biomeColors` per ground type (`groundType`), `variation.blend`
(wavelength and `strength` of the two-color noise) and `steep`. One color with no `biomeColors` and a flat blend is one green. Options: two
colors in `biomeColors` for the type; a higher `blend.strength`; `variation.patches` with a `tint`; more ground types.

**Dark blotches.** Cause: usually cloud shadows (`engine.uniforms.uCloudShadow.value` above 0), not texture; they drift with `uCloudShadowSpeed`, and bigger clouds mean
bigger blotches. Test by setting `uCloudShadow` to 0; if they vanish, lower it or change `uCloudShadowScale`. Blotches that
never move are `variation.patches` or a strong `detail`.

**Shimmer far away.** Cause: a pattern smaller than a pixel aliases. `detail.fade` (default) fades it out; `fade: false` keeps it. In your own
`glsl`, read `threedogDetailFootprint` (one pixel in pattern units; 1 = one cell per pixel) and fade yourself. A `variation.jitter.size` below a
pixel shimmers the same way; use a few meters, or `shading: 'texture'` (mipmapped).
