// @ts-check
// Sun and ambient from the signals. The engine's placeholder lights are off (createEngine({ lights: false })).
import * as THREE from 'three';
import { LIGHT, SHADOW_BOX, dayLevel } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { scene } = engine, { sun: S, ambient: A } = LIGHT;
  const hemi = new THREE.HemisphereLight(A.sky, A.ground, A.day);
  const sun = new THREE.DirectionalLight(S.color, S.intensity);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a preset changes it while running); these lights live with the engine, so the listener is not removed: in a module, ctx.track(engine.events.on(...))
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -SHADOW_BOX, right: SHADOW_BOX, top: SHADOW_BOX, bottom: -SHADOW_BOX, near: 1, far: 120 });
  scene.add(hemi, sun, sun.target);
  return {
    sun, hemi,
    /** @param {any} s engine.uniforms */
    update(s) {
      const day = dayLevel(s.uDaylight.value);
      sun.position.copy(s.uSunDir.value).multiplyScalar(60).add(sun.target.position);
      sun.intensity = S.intensity * day;
      hemi.intensity = A.night + (A.day - A.night) * day;
    },
  };
}
