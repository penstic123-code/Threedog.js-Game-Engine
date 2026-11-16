// @ts-check
// Sun or moon and the ambient, from the sky of this moment (sky.js) and the weather. One shadow map that travels with the player: the world streams,
// so a fixed shadow box would be left behind.
import { THREE } from '../../../index.js';
import { FILL, GROUND_BOUNCE, SHADOW, WEATHER_AMBIENT } from './palette.js';

const luminance = (/** @type {THREE.Color} */ c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** @param {any} engine @param {{ now: { sun: THREE.Color, sunIntensity: number, top: THREE.Color, horizon: THREE.Color, ambient: number } }} sky */
export function createLights(engine, sky) {
  const { scene } = engine, { now } = sky;
  const hemi = new THREE.HemisphereLight(0xffffff, GROUND_BOUNCE, 1);
  const fill = new THREE.AmbientLight(0xffffff, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  // sized from engine.tier, resized on 'tier:change' (a settings preset changes the tier while running)
  const fit = () => engine.shadows.mapSize(sun, engine.tier === 'low' ? 1024 : 2048);
  fit(); engine.events.on('tier:change', fit);
  Object.assign(sun.shadow.camera, { left: -SHADOW.extent, right: SHADOW.extent, top: SHADOW.extent, bottom: -SHADOW.extent, near: 1, far: SHADOW.far });
  sun.shadow.camera.updateProjectionMatrix();   // three does not redo it for a light's shadow camera: without this line the box stays at its 10 m default
  sun.shadow.bias = SHADOW.bias; sun.shadow.normalBias = SHADOW.normalBias;
  scene.add(hemi, fill, sun, sun.target);

  const dir = new THREE.Vector3(), snap = (/** @type {number} */ v) => Math.round(v / SHADOW.snap) * SHADOW.snap;
  return {
    sun, hemi, fill,
    /** @param {any} s engine.uniforms */
    update(s) {
      const d = s.uSunDir.value, weather = s.uWeatherLight.value;
      // below the horizon the same light is the moon, across the sky from where the sun went; it fades through 0 at the swap so shadows never jump
      dir.set(d.y < 0 ? -d.x : d.x, Math.abs(d.y), d.z).normalize();
      // snapped: a box that slides by less than a shadow pixel makes every edge in the world shimmer as the player walks
      sun.target.position.set(snap(engine.focus.x), engine.focus.y, snap(engine.focus.z));
      sun.position.copy(sun.target.position).addScaledVector(dir, SHADOW.distance);
      sun.color.copy(now.sun);
      sun.intensity = now.sunIntensity * weather * Math.min(1, Math.abs(d.y) / 0.08);
      // the hemisphere's sky half is the sky itself, halfway between zenith and horizon
      hemi.color.copy(now.top).lerp(now.horizon, 0.5);
      hemi.intensity = now.ambient * (1 - WEATHER_AMBIENT * (1 - weather));
      fill.intensity = hemi.intensity * FILL * luminance(hemi.color);
    },
  };
}
