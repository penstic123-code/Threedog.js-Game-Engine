// A depth-compare sample that takes no screen derivative, on WebGPURenderer.
// three r187's WGSL builder writes every compare sample as textureSampleCompare, which takes screen derivatives to choose a mip level. A depth texture the
// renderer compares against (a shadow map) has one level, so the derivative chooses nothing; and WGSL only allows that call in uniform control flow, a rule three
// switches off for the whole shader ('diagnostic( off, derivative_uniformity )'). Tint then lets it through, and D3D's FXC refuses it inside a loop it cannot
// unroll: three's GodraysNode marches the shadow map in a loop whose count comes from a uniform, so sunShafts failed with 'FXC compile failed with error: E_FAIL'
// and every frame after it was invalid. textureSampleCompareLevel takes the same arguments, samples level 0, and is valid in any control flow: the same
// picture for a one-level texture. A compare texture that does carry mipmaps keeps three's call.
import { WGSLNodeBuilder } from 'three/webgpu';
import { notePatch, patchOn } from '../../core/scene/threePatches.js';

// @types/three does not declare the builder's generate methods
const ID = 'compare-sample-level', proto = /** @type {any} */ (WGSLNodeBuilder.prototype), generateTextureCompare = proto.generateTextureCompare;
/** @param {any} texture */
const oneLevel = texture => texture.generateMipmaps !== true && !(texture.mipmaps?.length > 1);
if (!generateTextureCompare._threedogLevel) {   // already wrapped (module loaded twice)
  proto.generateTextureCompare = Object.assign(/** @this {any} @param {any} texture @param {any[]} rest */ function (texture, ...rest) {
    const snippet = generateTextureCompare.call(this, texture, ...rest);
    return patchOn(ID) && oneLevel(texture) && typeof snippet === 'string' ? snippet.replace('textureSampleCompare(', 'textureSampleCompareLevel(') : snippet;
  }, { _threedogLevel: true });
  notePatch(ID, "WGSLNodeBuilder.prototype.generateTextureCompare: a compare sample of a one-level depth texture (every shadow map) is written as textureSampleCompareLevel, which needs no screen derivative",
    () => { proto.generateTextureCompare = generateTextureCompare; },
    { lost: "on a D3D backend that compiles with FXC, a shader that compares a shadow map inside a loop of varying length (sunShafts) no longer compiles, and every frame that draws it is invalid" });
}
