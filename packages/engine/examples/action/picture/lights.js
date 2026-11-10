// @ts-check
// Sun or moon and the ambient, from the signals. The ambient's sky half follows the engine's dome, the one sky this room has.
import { THREE } from '../../../index.js';
import { FILL, GROUND_BOUNCE, SHADOW, sampleDay } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { scene } = engine;
  const hemi = new THREE.HemisphereLight(0xffffff, GROUND_BOUNCE, 1);
  const fill = new THREE.AmbientLight(0xffffff, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(engine.tier === 'low' ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -SHADOW.extent, right: SHADOW.extent, top: SHADOW.extent, bottom: -SHADOW.extent, near: 1, far: SHADOW.far });
  sun.shadow.camera.updateProjectionMatrix();   // three does not redo it for a light's shadow camera: without this line the box stays at its 10 m default
  sun.shadow.bias = SHADOW.bias; sun.shadow.normalBias = SHADOW.normalBias;
  // radius is in shadow texels: scaled with the map so the low tier's half-size map blurs the same meters, never under 2 texels (stair steps) unless set lower
  sun.shadow.radius = Math.max(Math.min(SHADOW.radius, 2), SHADOW.radius * sun.shadow.mapSize.x / 2048);
  scene.add(hemi, fill, sun, sun.target);

  const dir = new THREE.Vector3();
  return {
    sun, hemi,
    /** @param {any} s engine.uniforms */
    update(s) {
      const d = s.uSunDir.value, { intensity, ambient } = sampleDay(sun.color, s.uTimeOfDay.value);
      // below the horizon the same light is the moon, across the sky from where the sun went; it fades through 0 at the swap so shadows never jump
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      sun.position.copy(dir).multiplyScalar(SHADOW.distance);
      sun.intensity = intensity * Math.min(1, Math.abs(d.y) / 0.08);
      hemi.color.copy(s.uSkyTop.value).lerp(s.uSkyHorizon.value, 0.5);
      hemi.intensity = ambient;
      const { r, g, b } = hemi.color;
      fill.intensity = ambient * FILL * (0.2126 * r + 0.7152 * g + 0.0722 * b);
    },
  };
}
