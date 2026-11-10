// @ts-check
// Sun or moon and ambient, both from the day table in palette.js.
import { THREE } from '../../../index.js';
import { AMBIENT_GROUND, SHADOW, skyColor, skyNumber } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { scene } = engine;
  const hemi = new THREE.HemisphereLight(0xffffff, AMBIENT_GROUND, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(engine.tier === 'low' ? SHADOW.lowMapSize : SHADOW.mapSize);
  Object.assign(sun.shadow.camera, { left: -SHADOW.extent, right: SHADOW.extent, top: SHADOW.extent, bottom: -SHADOW.extent, near: 1, far: 420 });
  // radius is in shadow texels: scaled with the map so the low tier's half-size map blurs the same meters, never under 2 texels (stair steps) unless set lower
  sun.shadow.radius = Math.max(Math.min(SHADOW.radius, 2), SHADOW.radius * sun.shadow.mapSize.x / SHADOW.mapSize);
  sun.shadow.bias = -0.00005;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);   // the target stays at the origin: the island is the whole world

  const dir = new THREE.Vector3();
  return {
    sun, hemi,
    /** @param {any} s engine.uniforms */
    update(s) {
      const t = s.uTimeOfDay.value, d = s.uSunDir.value;
      // below the horizon the same light is the moon, across the sky from where the sun went; it fades through 0 at the swap so shadows never jump
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      sun.position.copy(dir).multiplyScalar(SHADOW.distance);
      sun.intensity = skyNumber(3, t) * s.uWeatherLight.value * Math.min(1, Math.abs(d.y) / 0.08);
      skyColor(sun.color, 2, t);
      skyColor(hemi.color, 1, t);
      hemi.intensity = skyNumber(4, t);
    },
  };
}
