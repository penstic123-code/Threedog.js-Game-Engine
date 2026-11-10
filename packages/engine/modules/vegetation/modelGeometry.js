import { mergeCommon, commonAttributes } from '../../render/mergeCommon.js';
import { cloneMaterial } from '../../render/patches.js';
import { coded, codedError } from '../../core/base/errorHints.js';
import { DEV, warnOnce } from '../../core/base/validate.js';

// Multi-material model (bark trunk + alpha-cut leaf cards) -> one geometry with a group per mesh + a material array, so a species stays
// one InstancedMesh: instance matrices, felling and LOD swaps work unchanged for every part. Only attributes all meshes share are kept.
/** @internal */
export function fromModel(root, label) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), geos = [], mats = [];
  root.traverse(n => {
    if (!n.isMesh) return;
    if (Array.isArray(n.material)) throw codedError('vegetation-option', `${label}: model mesh '${n.name}' has several materials; split it into one mesh per material`);
    geos.push(n.geometry.clone().applyMatrix4(n.matrixWorld.clone().premultiply(inv)));
    mats.push(cloneMaterial(n.material));   // the copy keeps what the game gave the material: its own lighting / nodes and its shader patches
  });
  if (!geos.length) throw codedError('vegetation-option', `${label}: model has no meshes`);
  // an attribute only some meshes have (uv on the leaf cards, colors on the trunk) is dropped from all: a material reading it would draw
  // differently from the model shown on its own, so say which one went
  const kept = commonAttributes(geos), lost = [...new Set(geos.flatMap(g => Object.keys(g.attributes)))].filter(n => !kept.includes(n));
  if (DEV && lost.length) warnOnce(coded('vegetation-ignored', `${label}: attribute ${lost.join(', ')} is on only some meshes of the model, so the species draws without it (one instanced geometry keeps what every mesh has). Give every mesh the attribute, or split the model into species`));
  return { geometry: mergeCommon(geos, true), materials: mats };
}
