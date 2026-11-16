// @ts-check
// Sun or moon, ambient, and the night lights technique on this street's materials. addLamp is the one name the street needs from here.
import { THREE } from 'threedog';
import { DAY, GLARE, GLOW, NIGHT, SHADOW, dayLevel } from './palette.js';
import { createNightLights } from '../nightLights.js';

/** @param {any} engine @param {ReturnType<typeof import('./materials.js').createMaterials>} mat @param {{ halo: boolean, glare: boolean }} o */
export function createLights(engine, mat, o) {
  const hemi = new THREE.HemisphereLight(DAY.hemi.sky, DAY.hemi.ground, DAY.hemi.intensity);
  const sun = new THREE.DirectionalLight(DAY.sun.color, DAY.sun.intensity);
  const { center, extent, near, far, distance, normalBias, mapSize } = SHADOW;
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a preset changes it while running); these lights live with the engine, so the listener is not removed: in a module, ctx.track(engine.events.on(...))
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? mapSize.low : mapSize.high);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near, far });
  sun.shadow.normalBias = normalBias;
  sun.target.position.fromArray(center);
  engine.scene.add(hemi, sun, sun.target);

  const nightLights = createNightLights(engine, { halo: o.halo, ...(o.glare ? GLARE.lights : {}) });
  nightLights.addGlow(mat.windowWarm);
  nightLights.addGlow(mat.windowCool, GLOW.windowCool);
  nightLights.addGlow(mat.signCyan, GLOW.sign);
  nightLights.addGlow(mat.signPink, GLOW.sign);

  const dir = new THREE.Vector3(), a = new THREE.Color(), b = new THREE.Color();
  const blend = (/** @type {THREE.Color} */ out, /** @type {number} */ night, /** @type {number} */ day, /** @type {number} */ k) => out.copy(a.set(night)).lerp(b.set(day), k);
  return {
    sun, hemi, nightLights,
    /** @param {{ x: number, y: number, z: number }} at */
    addLamp: at => nightLights.addLamp(at, { head: mat.head }),
    /** @param {any} s engine.uniforms */
    update(s) {
      const d = s.uSunDir.value, k = dayLevel(s.uDaylight.value);
      // below the horizon the same light is the moon, across the sky from where the sun went; it fades through 0 at the swap so shadows never jump
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      sun.position.copy(dir).multiplyScalar(distance).add(sun.target.position);
      sun.intensity = (NIGHT.sun.intensity + (DAY.sun.intensity - NIGHT.sun.intensity) * k) * Math.min(1, Math.abs(d.y) / 0.08);
      blend(sun.color, NIGHT.sun.color, DAY.sun.color, k);
      hemi.intensity = NIGHT.hemi.intensity + (DAY.hemi.intensity - NIGHT.hemi.intensity) * k;
      blend(hemi.color, NIGHT.hemi.sky, DAY.hemi.sky, k);
      blend(hemi.groundColor, NIGHT.hemi.ground, DAY.hemi.ground, k);
    },
  };
}
