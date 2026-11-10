// @ts-check
// The room's lights: sun or moon aimed by hand with its shadow box fitted to the room, the hemisphere, the window as an area light, the bounce
// stand-in and the lamps. The sun stays fixed all day: this page is about the room, not the clock; only the hemisphere's colors read the signals.
import { THREE } from 'threedog';
import { windowLight } from '../interiorLight.js';
import { BOUNCE_LIGHT, HEMI, LAMPS, LAMP_SHADOW, MOON, SHADOW, SUN, WINDOW_LIGHT } from './palette.js';

/**
 * @param {any} engine
 * @param {{ night: boolean, fill: string, windowOpening: { position: number[], lookAt: number[], width: number, height: number } | null }} o
 */
export function createLights(engine, { night, fill, windowOpening }) {
  const { scene, renderer } = engine, key = night ? MOON : SUN;
  const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight(key.color, key.intensity);
  const az = THREE.MathUtils.degToRad(key.azimuth), el = THREE.MathUtils.degToRad(key.elevation);
  sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(SHADOW.distance);
  sun.castShadow = true;
  renderer.shadowMap.type = SHADOW.type;
  sun.shadow.mapSize.setScalar(SHADOW.mapSize[engine.tier === 'low' ? 'low' : 'high']);
  const { extent: e, distance } = SHADOW;
  Object.assign(sun.shadow.camera, { left: -e, right: e, top: e, bottom: -e, near: 1, far: distance * 2 });
  // three adds bias in the shadow camera's 0-1 depth, i.e. a world offset of bias x (far - near)
  // radius is in shadow texels: scaled with the map so the low tier's half-size map blurs the same meters, never under 2 texels (stair steps) unless set lower
  Object.assign(sun.shadow, { normalBias: SHADOW.normalBias, bias: -SHADOW.biasCm / 100 / (distance * 2 - 1), radius: Math.max(Math.min(SHADOW.radius, 2), SHADOW.radius * sun.shadow.mapSize.x / SHADOW.mapSize.high) });
  scene.add(hemi, sun, sun.target);

  if (windowOpening && !night) windowLight(engine, { ...windowOpening, ...WINDOW_LIGHT });
  if (fill === 'light' && !night) {
    const { color, intensity, distance: reach, decay, at } = BOUNCE_LIGHT, bounce = new THREE.PointLight(color, intensity, reach, decay);
    bounce.position.set(at[0], at[1], at[2]);
    scene.add(bounce);
  }

  /** The light of one lamp; the bulb hides inside the shade main.js puts around it @param {keyof typeof LAMPS} kind @param {number[]} at */
  function addLamp(kind, at) {
    const l = LAMPS[kind], p = new THREE.PointLight(l.color, l.intensity, 0, 2);
    p.position.set(at[0], at[1], at[2]);
    p.castShadow = l.shadow;
    if (l.shadow) { p.shadow.mapSize.setScalar(LAMP_SHADOW.mapSize); p.shadow.bias = LAMP_SHADOW.bias; p.shadow.radius = LAMP_SHADOW.radius; }
    scene.add(p);
  }

  const day = { sky: new THREE.Color(HEMI.day.sky), ground: new THREE.Color(HEMI.day.ground) }, dark = { sky: new THREE.Color(HEMI.night.sky), ground: new THREE.Color(HEMI.night.ground) };
  return {
    sun, hemi, addLamp,
    /** @param {any} s engine.uniforms */
    update(s) {
      const light = s.uDaylight.value;
      hemi.color.copy(dark.sky).lerp(day.sky, light);
      hemi.groundColor.copy(dark.ground).lerp(day.ground, light);
    },
  };
}
