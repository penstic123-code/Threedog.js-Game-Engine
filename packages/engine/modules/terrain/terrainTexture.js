// Main-thread side of terrain({ shading: 'texture' }): turns the worker's color map into a DataTexture and a per-chunk material that samples it.
// Each chunk gets its own material (a clone of the terrain material with the same patches plus 'terrainColorMap'), because a patch uniform
// is uploaded when the material changes, not per object; clones share one compiled program (same cacheKey), so this costs no shader compile.
// The map is sampled by world xz (the 'world' patch), not by uv, so the mesh uv stays free for the game's own textures.
import * as THREE from 'three';
import { applyEffects } from '../../render/materials.js';
import { cloneMaterial } from '../../render/patches.js';
import { maxAnisotropy } from '../../render/backend.js';

/** Material for one chunk: `base` plus the color map `t` ({ data, size }) of the chunk whose origin is (ox, oz) and edge length `chunk`; kept on `rec` */
export function mountColorMap(engine, base, rec, t, ox, oz, chunk) {
  const { data, size } = t, R = size - 2;
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;   // stored sRGB-encoded: the GPU decodes on sampling, 8 bits keep dark colors smooth
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(4, maxAnisotropy(engine.renderer));   // ground is seen at grazing angles
  tex.needsUpdate = true;
  // upload and mipmaps now, in the chunk's task, not in the first frame that draws it (a WebGPURenderer before init has no device yet)
  if (engine.renderer.initialized !== false) engine.renderer.initTexture(tex);
  // world xz -> texture uv: pixel k is centered (k - 0.5) * chunk / R from the origin (see terrainColorMap.js); .zw = scale, offset
  const rect = new THREE.Vector4(ox, oz, R / (chunk * size), 1 / size);
  const mat = cloneMaterial(base), texU = { value: tex }, rectU = { value: rect };
  applyEffects(mat, { clouds: false, patches: [{
    name: 'terrainColorMap', cacheKey: 1, needs: { patches: ['world'] },
    uniforms: { uTColorMap: texU, uTColorRect: rectU },
    pars: 'uniform sampler2D uTColorMap; uniform vec4 uTColorRect;',
    // slot 'map' (before the vertex colors, white on a textured top): every 'color' patch, such as the season tint in 'mix'
    // mode, then sees the mapped color instead of having it multiplied back over its result
    slot: 'map', glsl: 'diffuseColor.rgb *= texture2D(uTColorMap, (vThreedogWorld.xz - uTColorRect.xy) * uTColorRect.z + uTColorRect.w).rgb;',
    // the same line for WebGPURenderer (positionWorld is vThreedogWorld)
    tsl: c => { const r = c.fx.patchUniform(rectU), uv = c.tsl.positionWorld.xz.sub(r.xy).mul(r.z).add(r.w);
      return c.tsl.vec4(c.map.rgb.mul(c.fx.patchTexture(texU, uv).rgb), c.map.a); },
  }] });
  rec.colorTex = tex; rec.colorMat = mat;
  return mat;
}

/** An edit rebuilt the chunk: upload the new pixels into the same texture */
export function updateColorMap(rec, t) {
  rec.colorTex.image.data.set(t.data);
  rec.colorTex.needsUpdate = true;
}

export function disposeColorMap(rec) {
  rec.colorTex?.dispose();
  rec.colorMat?.dispose();
}
