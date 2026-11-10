// Scene copies (tests/specs/scene-copies.mjs): what copies the game's scene leaves out what the engine draws for something else (core/scene/drawOnly.js
// drawOnly). On WebGLRenderer engine.shadows.cascades(sun) adds copies of the sun that the material patch adds up to one sun; the photo path trace
// (modules/photo/pathTrace.js traceSnapshot, with a stand-in tracer that only records what setScene saw) and the gallery's 'game' light
// (packages/tools/gallery gameLights) must each see the one sun, not one per cascade.
import * as THREE from 'three';
import { createEngine } from '../../index.js';
import { traceSnapshot } from '../../modules/photo/pathTrace.js';
import { gameLights, shots } from '@threedog/tools/gallery';
import { isDrawOnly } from '../../core/scene/drawOnly.js';

const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, urlState: false, saveKey: 'test-scene-copies' });
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(4, 8, 5); sun.castShadow = true;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial()); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
engine.add(floor, sun);
await engine.start();
engine.haltLoop();
engine.shadows.cascades(sun, { count: 3 });
for (let i = 0; i < 3; i++) engine.step(1 / 60);

/** Directional lights shown: their count and summed intensity */
const suns = list => { const d = list.filter(o => o.isDirectionalLight && o.visible); return { n: d.length, sum: d.reduce((a, l) => a + l.intensity, 0) }; };
const shown = s => { const out = []; s.traverseVisible(o => out.push(o)); return out; };
window.sceneCopies = () => {
  const all = shown(engine.scene);
  let traced = [];
  traceSnapshot({ setScene(s) { traced = shown(s); } }, engine.scene, engine.camera, false);
  const rig = { scene: Object.assign(new THREE.Scene(), { userData: { suns: [] } }), notes: [] };
  gameLights(engine, rig);
  // a game's own clone of a cascade light (reused as a fill light) is its own light: not marked
  const extra = all.find(o => o.isDirectionalLight && o !== sun), copy = extra?.clone();
  const clone = { marked: !!extra && isDrawOnly(extra), copied: !!copy && isDrawOnly(copy) };
  return { clone, scene: suns(all), traced: suns(traced), gallery: suns(rig.scene.userData.suns), sun: sun.intensity, back: suns(shown(engine.scene)) };
};
// the gallery reads three from the game's own import on its first use (shots / openGallery): one empty run sets it up
await shots(engine, { only: [], lights: ['game'] });
window.ready = true;
