// Ragdoll test scene (tests/specs/ragdoll.mjs): the real CC0 character of tests/anim on a flat floor with rigid(). ?gpu=1 runs the WebGPU renderer for the screenshot.
import { createEngine, presets, world, sky, collision, followCamera, characters, rigid, Character, THREE } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { readBones } from '../../modules/rigid/ragdollBones.js';
import { backendName } from '../../render/backend.js';

const gpu = new URLSearchParams(location.search).has('gpu');
if (gpu) await import('threedog/tsl');
const root = new THREE.Group(); root.name = 'ragdollLevel';
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8a8a })); floor.name = 'floor'; floor.receiveShadow = true; root.add(floor);
const spawn = new THREE.Object3D(); spawn.name = 'spawn'; root.add(spawn);
Object.assign(window, { THREE, Character, readBones, backendOf: backendName });
const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: false }, adaptiveResolution: false, saveKey: 'test-ragdoll', urlState: false, ...(gpu && { renderer: 'webgpu' }) });
engine.use(world(), sky({ time: 0.45 }), collision(), followCamera({ distance: 4, pitch: 0.25, height: 1.2 }), characters({ npcs: false }), rigid(), level({ scene: root }));
const sun = new THREE.DirectionalLight('#ffffff', 3); sun.position.set(4, 8, 3); sun.castShadow = true;
engine.scene.add(sun, new THREE.AmbientLight('#ffffff', 0.6));
engine.assets.manifest({ name: 'ragdoll-test', models: { king: { url: new URL('../anim/public/king.glb', import.meta.url).href, animation: { states: { idle: { clip: 'Idle_Sword' }, walk: { clip: 'Walk' }, run: { clip: 'Run' } } } } } });
engine.events.on('engine:ready', async () => {
  const model = await engine.assets.model('king');
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 }, model });
  window.ready = true;
});
engine.start();
