// @ts-check
// One sun and one ambient, fixed: the scene never changes, so the page has no signals to read. The ambient's ground color is light on purpose: with no
// room map, it is what keeps the walls near the ground's value.
import { THREE } from 'threedog';
import { COLORS, LIGHT } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const hemi = new THREE.HemisphereLight(0xffffff, COLORS.shade, LIGHT.ambient);
  const sun = new THREE.DirectionalLight(0xffffff, LIGHT.sunIntensity);
  sun.position.set(LIGHT.sun[0], LIGHT.sun[1], LIGHT.sun[2]);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(engine.tier === 'low' ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 250 });
  sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.03;   // the box covers the row of columns with a little margin
  // radius is in shadow texels: scaled with the map so the low tier's half-size map blurs the same meters, never under 2 texels (stair steps) unless set lower
  sun.shadow.radius = Math.max(Math.min(3, 2), 3 * sun.shadow.mapSize.x / 2048);
  engine.scene.add(hemi, sun, sun.target);
  return { sun, hemi };
}
