// @ts-check
// One fixed sun and a hemisphere fill: the street has no time of day, the page judges shapes.
import { THREE } from 'threedog';
import { LIGHT, SHADOW } from './palette.js';

/** @param {any} engine */
export function createLights(engine) {
  const { sun: key, ambient } = LIGHT, { extent, far, mapSize, lowMapSize, bias, normalBias, radius } = SHADOW;
  const hemi = new THREE.HemisphereLight(ambient.sky, ambient.ground, ambient.intensity);
  const sun = new THREE.DirectionalLight(key.color, key.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(engine.tier === 'low' ? lowMapSize : mapSize);
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far });
  Object.assign(sun.shadow, { bias, normalBias });
  // radius is in shadow texels: scaled with the map so the low tier's half-size map blurs the same meters, never under 2 texels (stair steps) unless set lower
  sun.shadow.radius = Math.max(Math.min(radius, 2), radius * sun.shadow.mapSize.x / mapSize);
  engine.scene.add(hemi, sun, sun.target);

  const [ox, oy, oz] = key.offset;
  return {
    sun, hemi,
    update() {
      // the shadow box sits on what the camera looks at, so ?view=close keeps the same shadows as the street shot
      sun.target.position.set(engine.focus.x, 0, engine.focus.z);
      sun.position.set(engine.focus.x + ox, oy, engine.focus.z + oz);
    },
  };
}
