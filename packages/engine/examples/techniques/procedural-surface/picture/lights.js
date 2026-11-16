// @ts-check
// One sun and one ambient, fixed: the scene never changes, so the page has no signals to read.
import { THREE } from 'threedog';
import { COLORS, LIGHT } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const hemi = new THREE.HemisphereLight(0xffffff, COLORS.shade, LIGHT.ambient);
  const sun = new THREE.DirectionalLight(0xffffff, LIGHT.sunIntensity);
  sun.position.set(LIGHT.sun[0], LIGHT.sun[1], LIGHT.sun[2]);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a settings preset changes the tier while running)
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 250 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  engine.scene.add(hemi, sun, sun.target);
  return { sun, hemi };
}
