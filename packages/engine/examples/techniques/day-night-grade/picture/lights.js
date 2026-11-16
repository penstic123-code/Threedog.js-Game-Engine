// @ts-check
// Sun or moon, ambient, exposure and the game's lamps, all from the keyframes. level() is the lamps' one number; the materials read it too.
import { THREE } from 'threedog';
import { COLORS, EXPOSURE, LAMPS, sample, skyColor, skyNumber } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { scene, renderer } = engine;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a settings preset changes the tier while running)
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 120 });
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);

  const lamps = /** @type {THREE.PointLight[]} */ ([]);
  /** @param {number} x @param {number} y @param {number} z */
  function addLamp(x, y, z) {
    const l = new THREE.PointLight(COLORS.lamp, 0, 9, 1.6);   // distance limits its cost to the street
    l.position.set(x, y, z); scene.add(l); lamps.push(l);
  }

  let level = 0;
  const smooth = (/** @type {number} */ x) => x * x * (3 - 2 * x);
  const dir = new THREE.Vector3();
  return {
    sun, hemi, addLamp, level: () => level,
    /** @param {any} s engine.uniforms */
    update(s) {
      const t = s.uTimeOfDay.value, d = s.uSunDir.value;
      // below the horizon the same light is the moon, across the sky from where the sun went; it fades through 0 at the swap so shadows never jump
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      sun.position.copy(dir).multiplyScalar(60).add(sun.target.position);
      sun.intensity = skyNumber(4, t) * Math.min(1, Math.abs(d.y) / 0.08);
      skyColor(sun.color, 3, t);
      skyColor(hemi.color, 5, t);
      hemi.intensity = skyNumber(6, t);
      renderer.toneMappingExposure = sample(EXPOSURE, t)[0];
      level = 1 - smooth(Math.min(1, Math.max(0, (s.uDaylight.value - LAMPS.onBelow) / (LAMPS.offAbove - LAMPS.onBelow))));
      // intensity only, never visible = false: a light count change recompiles every lit material (a stall at dusk)
      for (const l of lamps) l.intensity = LAMPS.light * level;
    },
  };
}
