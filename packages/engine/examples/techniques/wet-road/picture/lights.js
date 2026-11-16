// @ts-check
// Sun or moon, ambient, the street lamps and the streaks they leave on the road. level() is the lamps' one number; the materials and the sky read it too.
import { THREE } from 'threedog';
import { LAMP, LAMPS_OFF_ABOVE, LIGHT, WINDOW } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { sun: key, ambient } = LIGHT;
  const hemi = new THREE.HemisphereLight(ambient.dayColor, ambient.ground, ambient.day);
  const sun = new THREE.DirectionalLight(key.dayColor, key.day);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a preset changes it while running); these lights live with the engine, so the listener is not removed: in a module, ctx.track(engine.events.on(...))
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  // wide enough for the whole visible street around the focus point, which sits 20 m down the road
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 160 });
  sun.shadow.normalBias = 0.04;
  engine.scene.add(hemi, sun, sun.target);

  const lamps = /** @type {{ at: THREE.Vector3, light: any }[]} */ ([]);
  const lampStreaks = /** @type {any[]} */ ([]), windowStreaks = /** @type {any[]} */ ([]);
  let level = 0;
  const dir = new THREE.Vector3(), day = new THREE.Color(), night = new THREE.Color();
  return {
    sun, hemi, level: () => level,
    /** A lamp's light, off until night. A pool source, not a three.js light: the street has more lamps than a fragment shader should pay for @param {THREE.Vector3} at */
    addLamp(at) {
      const lamp = { at, light: engine.lightPool.add(at, { color: LAMP.color, intensity: 0, distance: LAMP.distance }) };
      lamps.push(lamp);
      return lamp;
    },
    /**
     * The streaks on the wet road: lamps reflect warm and strong, the windows facing the street weaker.
     * @param {any} wet createWetRoad's handle @param {THREE.Vector3[]} lampSpots @param {THREE.Vector3[]} windowSpots
     */
    addStreaks(wet, lampSpots, windowSpots) {
      for (const at of lampSpots) lampStreaks.push(wet.addStreak(at, { color: LAMP.color, intensity: 0 }));
      for (const at of windowSpots) windowStreaks.push(wet.addStreak(at, { color: WINDOW.color, intensity: 0 }));
    },
    /** @param {any} s engine.uniforms */
    update(s) {
      const d = s.uSunDir.value, light = s.uDaylight.value, weather = s.uWeatherLight.value;
      // below the horizon the same light is the moon, across the sky from where the sun went
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      // the shadow box sits on what the camera looks at
      sun.target.position.copy(engine.focus);
      sun.position.copy(dir).multiplyScalar(80).add(sun.target.position);
      // fades through 0 at the swap, so the shadows never jump
      sun.intensity = (key.night + (key.day - key.night) * light) * weather * Math.min(1, Math.abs(d.y) / 0.08);
      sun.color.copy(night.set(key.nightColor)).lerp(day.set(key.dayColor), light);
      hemi.intensity = (ambient.night + (ambient.day - ambient.night) * light) * (1 - ambient.weatherShare * (1 - weather));
      hemi.color.copy(night.set(ambient.nightColor)).lerp(day.set(ambient.dayColor), light);
      level = 1 - THREE.MathUtils.smoothstep(light, 0, LAMPS_OFF_ABOVE);
      for (const l of lamps) l.light.set({ intensity: LAMP.light * level });
      for (const st of lampStreaks) st.set({ intensity: LAMP.streak * level });
      for (const st of windowStreaks) st.set({ intensity: WINDOW.streak * level });
    },
  };
}
