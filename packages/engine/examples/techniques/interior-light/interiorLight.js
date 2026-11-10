// @ts-check
// Interior light helpers (technique example, README.md next to this file). Imports only three.
// Why helpers: the zone switch has to change exposure and the leaking outdoor ambient together, eased, and only when the zone changes;
// the window light is placed and aimed in one call. The engine loads the RectAreaLight tables itself when the light enters the scene.
import * as THREE from 'three';

/**
 * Exposure and ambient by zone, following the camera. `isInside(cameraPosition)` decides the zone; on a change the hemisphere / environment
 * intensities switch at once (they light through walls) and the exposure eases over `ease` seconds (an eye adapting). Presentation only: call
 * update(dt) from engine.onFrame; update() with no dt jumps straight to the zone's values. Writes hemi.intensity, scene.environmentIntensity and
 * renderer.toneMappingExposure, nothing else.
 * @param {{ camera: THREE.Camera, scene: THREE.Scene, renderer: THREE.WebGLRenderer }} engine
 * @param {{ hemi: THREE.HemisphereLight, isInside: (p: THREE.Vector3) => boolean, exposure: { inside: number, outside: number }, ambient: { inside: { hemi: number, env: number }, outside: { hemi: number, env: number } }, ease?: number }} o
 */
export function exposureZones(engine, { hemi, isInside, exposure, ambient, ease = 1.2 }) {
  const zone = { name: '', exposure: 0, target: 0 };
  return {
    zone,
    update(dt = Infinity) {
      const name = isInside(engine.camera.position) ? 'inside' : 'outside';
      if (name !== zone.name) {
        zone.name = name;
        zone.target = exposure[name];
        hemi.intensity = ambient[name].hemi;
        engine.scene.environmentIntensity = ambient[name].env;
      }
      zone.exposure = zone.exposure ? zone.exposure + (zone.target - zone.exposure) * Math.min(1, dt / (ease / 3)) : zone.target;
      engine.renderer.toneMappingExposure = zone.exposure;
    },
  };
}

/**
 * The sky seen through a window as a RectAreaLight in the opening, facing `lookAt`. Soft and window-shaped, but it casts no shadow and lights
 * only MeshStandardMaterial / MeshPhysicalMaterial.
 * @param {any} engine
 * @param {{ position: number[], lookAt: number[], width: number, height: number, color?: THREE.ColorRepresentation, intensity?: number }} o
 */
export function windowLight(engine, { position, lookAt, width, height, color = '#cfe0ff', intensity = 2 }) {
  const area = new THREE.RectAreaLight(color, intensity, width, height);
  area.position.set(position[0], position[1], position[2]);
  area.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  engine.scene.add(area);
  return area;
}
