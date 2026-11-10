// Estimated GPU bytes of a three.js texture (engine.inspect.materials / engine.inspect.perf). An estimate: three.js does not report VRAM.
// Compressed / data textures: their data size; images: width x height x bytes per texel, x 4/3 with mipmaps, x 6 for a cube.
const PER_CHANNEL = { 1009: 1, 1010: 1, 1011: 2, 1012: 2, 1013: 4, 1014: 4, 1015: 4, 1016: 2, 1020: 4 };   // three's type constants UnsignedByte ... HalfFloat, UnsignedInt248
const CHANNELS = { 1021: 1, 1022: 3, 1023: 4, 1024: 1, 1025: 2, 1026: 1, 1027: 1, 1028: 1, 1030: 2, 1033: 4 };   // Alpha, RGB, RGBA, Luminance, LuminanceAlpha, Depth, DepthStencil, Red, RG, RGBAInteger

/** @param {any} t a THREE.Texture @returns {number} estimated bytes on the GPU (0 when unknown) */
export function textureBytes(t) {
  if (!t) return 0;
  if (t.isCompressedTexture) return (t.mipmaps || []).reduce((s, m) => s + (m?.data?.byteLength ?? 0), 0) * (t.isCubeTexture ? 6 : 1);
  const faces = Array.isArray(t.image) ? t.image : [t.image];
  const i = faces[0];
  if (!i) return 0;
  const w = i.width ?? i.videoWidth ?? 0, h = i.height ?? i.videoHeight ?? 0, d = i.depth ?? 1;
  const texel = (PER_CHANNEL[t.type] ?? 1) * (CHANNELS[t.format] ?? 4);
  const mips = t.generateMipmaps !== false && t.minFilter !== 1006 && t.minFilter !== 1003 ? 4 / 3 : 1;   // Linear / Nearest min filter: no mip chain
  return Math.round(w * h * d * texel * mips * faces.length);
}

/**
 * Estimated bytes of the shadow maps of the scene's lights (color and depth). Why here: on WebGLRenderer three counts no bytes, and a shadow map is often the biggest
 * texture a game has while no material slot holds it, so a scene of procedural materials read 0 MB with 2048x2048 maps in memory @param {any} scene
 */
export function shadowMapBytes(scene) {
  let b = 0;
  scene.traverse(o => { const m = o.isLight && o.castShadow ? o.shadow?.map : null; if (m) b += textureBytes(m.texture) + textureBytes(m.depthTexture); });
  return b;
}

/** Bytes as a short MB / KB string @param {number} b */
export const mb = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
