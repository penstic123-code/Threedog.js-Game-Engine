// Placeholder lights (engine.lights): a directional "sun" + hemisphere, white and neutral gray, static. They exist so a game with no picture code yet
// shows neutral gray instead of black (P5). Nothing moves them with the time of day: the sky only gives signals. A game lights its own world with
// createEngine({ lights: false }) and its own three.js lights, before engine.start(): a light count that changes during play recompiles shaders
// (recipes/09 "Lights and stalls", lightPool() for many lights).
import { engineOwned } from '../core/scene/things.js';
import * as THREE from 'three';
import { defineOwned } from '../core/ops/owned.js';
import { onTierChange } from '../core/scene/tier.js';

const BOX = 30, SNAP = 0.5;

/** @param {any} engine @returns {{ sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight }} */
export function createDefaultLights(engine, { add = true } = {}) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x555555, 1.2);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(40, 80, 30);   // above and to the side, so faces read with some shading
  sun.castShadow = true;          // the engine's light casts; whether anything draws shadows is engine.shadows.enabled (render/shadows.js)
  // the one place these defaults live: nothing writes them later, a sky included, so what a game writes on engine.lights.sun stays.
  // baseline shadow box: 2048 map over 60 m around engine.focus (~3 cm texels; 1024 on a low-tier device, a quarter of the fill cost), PCF with a small blur
  // radius = soft edges; bias / normalBias keep acne off flat ground and slopes without visible peter-panning at this texel size. bias is in the shadow
  // camera's 0-1 depth (near 1 - far 250 m): -0.0001 = 2.5 cm; the old -0.0005 was 12 cm and cut the shadow at the base of things standing on the ground
  const sc = sun.shadow.camera, sizeFor = () => engine.tier === 'low' ? 1024 : 2048;
  let map = sizeFor();
  sun.shadow.mapSize.set(map, map);
  sc.left = sc.bottom = -BOX; sc.right = sc.top = BOX; sc.near = 1; sc.far = 250; sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.04; sun.shadow.radius = 3;
  // add: false (createEngine({ lights: false })): the objects still exist so engine.lights.sun / hemi and the sky module never hit undefined, but they
  // are not in the scene, so nothing is lit by them and they cost no shader light slots; the game brings all its own lights
  // the size is a tier default: it follows the tier (a stored preset arrives after this runs, settings installs last) unless the game wrote another size
  // on the sun, which stays. engine.shadows.mapSize is the one resize path (reallocates the map on WebGL, the cascades' maps too); the engine lives as long as this listener
  onTierChange(engine, () => {
    const was = map, next = map = sizeFor();
    if (sun.shadow.mapSize.x === was && sun.shadow.mapSize.y === was && next !== was) (engine.shadows ? engine.shadows.mapSize(sun, next) : sun.shadow.mapSize.set(next, next));
  });
  engineOwned('lights', hemi, sun, sun.target);   // the module's, not the game's, when the scene adopts what is added (core/scene/things.js)
  if (add) engine.scene.add(hemi, sun, sun.target);
  return { sun, hemi };
}

/**
 * Baseline sun follow (no sky module): keep the shadow box around engine.focus, snapped to SNAP m so it only moves in steps (no shimmer while still).
 * Under a sky, or after engine.shadows.box(engine.lights.sun), that box does it (render/shadows.js). Called before the main render.
 * @param {any} e
 */
export function followFocus(e) {
  const sun = e.lights?.sun;
  if (!sun?.castShadow || !sun.parent || e._cascades?.light === sun) return;   // cascades place the sun themselves
  // 'shadow.follow' is one row in describe().owned: a module that moves the sun itself (a sky) defines it while installed, and then this
  // baseline steps aside. Asking who holds the row, not whether e.sky exists, keeps render/ free of module names and lets a game's own sun
  // driver take over the same way. A game that places sun.target itself keeps it (manual level).
  const held = e._owned?.get('shadow.follow');
  if (held && held !== e._oBaseFollow) return;
  // registered again whenever it is not the current one (a box came and went)
  const o = held ?? (e._oBaseFollow = defineOwned(e, {
    id: 'shadow.follow', part: 'shadow', key: 'follow', read: () => sun.target.position.toArray(), objects: [sun.target, sun.target.position],
    levels: { manual: 'engine.shadows.box(engine.lights.sun, { follow: false })', back: "engine.shadows.box(engine.lights.sun, { follow: 'focus' })" } }));
  if (!o._snap) o.mark();
  o.check();
  if (!o.on) return;
  const f = e.focus, x = Math.round(f.x / SNAP) * SNAP, z = Math.round(f.z / SNAP) * SNAP;
  const t = sun.target.position, dx = x - t.x, dz = z - t.z;
  if (dx === 0 && dz === 0) return;
  // the sun moves with its target by the same step: where the game put it stays the game's, only the box's center changes
  t.x = x; t.z = z; sun.position.x += dx; sun.position.z += dz;
  sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  o.mark();
}
