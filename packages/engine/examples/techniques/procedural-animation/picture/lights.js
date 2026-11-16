// @ts-check
// One sun and one ambient that follow the time of day.
import { THREE } from 'threedog';
import { LIGHT, SHADOW } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { ambient, sun: key } = LIGHT, { extent, near, far, bias, normalBias, radius } = SHADOW;
  const hemi = new THREE.HemisphereLight(ambient.dayColor, ambient.dayGround, ambient.day);
  const sun = new THREE.DirectionalLight(key.dayColor, key.day);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a settings preset changes the tier while running)
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near, far });
  sun.shadow.camera.updateProjectionMatrix();
  Object.assign(sun.shadow, { bias, normalBias, radius });
  engine.scene.add(hemi, sun, sun.target);

  const dir = new THREE.Vector3(), day = new THREE.Color(), night = new THREE.Color();
  return {
    /** @param {any} s engine.uniforms */
    update(s) {
      const d = s.uSunDir.value, light = s.uDaylight.value;
      // below the horizon the same light is the moon, across the sky from where the sun went
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      // the shadow box rides on the focus: that is where the creature is, wherever it walks
      sun.target.position.copy(engine.focus);
      sun.position.copy(dir).multiplyScalar(60).add(sun.target.position);
      sun.intensity = THREE.MathUtils.lerp(key.night, key.day, light) * Math.min(1, Math.abs(d.y) / 0.08);
      sun.color.copy(night.set(key.nightColor)).lerp(day.set(key.dayColor), light);
      hemi.intensity = THREE.MathUtils.lerp(ambient.night, ambient.day, light);
      hemi.color.copy(night.set(ambient.nightColor)).lerp(day.set(ambient.dayColor), light);
      hemi.groundColor.copy(night.set(ambient.nightGround)).lerp(day.set(ambient.dayGround), light);
    },
  };
}
