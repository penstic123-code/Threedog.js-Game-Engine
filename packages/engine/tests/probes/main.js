// Test scene for light probes (tests/specs/probes.mjs): a gray floor and a red wall on the +x side, nothing else.
// The wall is unlit (MeshBasicMaterial) so its red reaches every cube capture whatever the lights do; the spec bakes a small grid and compares.
import { LightProbeGridWebGL } from 'three/addons/lighting/LightProbeGridWebGL.js';
import { createEngine, THREE } from '../../index.js';

const engine = createEngine({ canvas: document.getElementById('view'), headless: true, ui: { loading: false }, saveKey: 'threedog-probes-test' });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x808080 }));
floor.rotation.x = -Math.PI / 2;
const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 20), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
wall.position.set(3.6, 3, 0); wall.name = 'redWall';
engine.add(floor, wall);
engine.camera.position.set(0, 1.7, 6);
import * as tsl from 'three/tsl';   // scene.fogNode = tsl.fog(...) for the fog readers (tests/specs/group-p5.mjs)
window.threedogTest = { THREE, wall, LightProbeGridWebGL, tsl };
window.engine = engine;
engine.start();
