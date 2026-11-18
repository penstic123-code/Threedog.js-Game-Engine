// The one way engine code makes a material of its own: plain three.js, neutral gray. A module's picture is this material until the game sets or swaps it
// (engine.water.material and the like), so the engine holds no style table and no module asks anyone for a picture.
// Why a helper and not new MeshLambertMaterial at each site: engine-made materials are marked (patches.js), and vertex-colored ones stay white so the
// colors in the geometry show unchanged.
import * as THREE from 'three';
import { markEngineMade } from './patches.js';

/** The gray of everything the engine draws until the game gives it a picture */
const NEUTRAL = 0x8c8c8c;

/**
 * A plain MeshLambertMaterial for engine code: neutral gray unless params say otherwise. params are three.js material properties.
 * @internal
 * @param {string} what who made it, for inspect.scene ('water', 'pickup', ...)
 * @param {THREE.MeshLambertMaterialParameters} [params]
 * @returns {THREE.MeshLambertMaterial}
 */
export function neutralMaterial(what, params = {}) {
  const m = new THREE.MeshLambertMaterial({ color: params.vertexColors ? 0xffffff : NEUTRAL, ...params });
  m.userData.purpose = what;
  markEngineMade(m);
  return m;
}
