// Camera and timeline test page：?cam=follow|first|fixed|rts
import { createEngine, presets, world, sky, collision, characters, interactions, dialogue, debug, THREE } from '../../index.js';
import { followCamera } from '../../modules/camera/FollowCamera.js';
import { firstPersonCamera } from '../../modules/camera/FirstPersonCamera.js';
import { fixedCamera } from '../../modules/camera/FixedCamera.js';
import { rtsCamera } from '../../modules/camera/RtsCamera.js';
import { timeline } from '../../modules/timeline/Timeline.js';

const cam = new URLSearchParams(location.search).get('cam') || 'follow';
const rigs = {
  follow: () => followCamera(),
  first: () => firstPersonCamera({ height: 1.6, fov: 70, pointerLock: true }),
  fixed: () => fixedCamera({
    shots: {
      south: { position: [0, 8, 22], lookAt: [0, 0, 0], fov: 50 },
      east: { position: [24, 6, 0], track: true },
      north: { position: [0, 10, -24], lookAt: [0, 0, 0] },
    },
    start: 'south',
  }),
  rts: () => rtsCamera({ height: 30, pitch: 0.95, edgePan: false, bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 } }),
};

const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), ui: { loading: { title: 'camera test' } } });
engine.use(world(), sky({ time: 0.45 }), collision(), rigs[cam](), characters({ npcs: false }), interactions({ ...presets.interactions.nearest }), dialogue(), timeline(), debug());

const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9a9a96 }));
ground.receiveShadow = true;
engine.add(ground);
const mat = new THREE.MeshLambertMaterial({ color: 0xc8c4bc });
const boxes = [];
for (const [x, z, s] of [[-10, -10, 3], [12, -6, 4], [-14, 10, 2.5], [8, 14, 3], [0, -24, 5]]) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
  b.position.set(x, s / 2, z); b.castShadow = b.receiveShadow = true;
  engine.add(b); engine.collision.addBox({ x, z }, { halfWidth: s / 2, halfDepth: s / 2, height: s });
  boxes.push(b);
}
// A translucent box for the tween test
const fader = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshLambertMaterial({ color: 0x888888, transparent: true, opacity: 1 }));
fader.position.set(4, 1, -4);
engine.add(fader);

const player = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });

// Cutscene used by the tests
window.cutscene = (opts = {}) => engine.timeline.play([
  { camera: { to: { position: [14, 7, 14], lookAt: [0, 1, 0] }, duration: 1.2, ease: 'inOutSine', fov: 45 } },
  { parallel: [
    { tween: { target: fader, to: { 'position.y': 4, 'material.opacity': 0.2, 'material.color': 0xffffff }, duration: 1, ease: 'outBack' } },
    { path: { object: boxes[0], points: [[-10, 1.5, -10], [-4, 1.5, -12], [2, 1.5, -8]], duration: 1.5, lookAhead: 0.05 } },
  ] },
  { wait: 0.4 },
], { skippable: true, letterbox: true, ...opts });
engine.input.define('testCutscene', { label: 'testCutscene', keys: ['KeyC'] });
engine.onFrame(() => { if (engine.input.pressed('testCutscene')) window.cutscene(); });

window.engine = engine; window.player = player; window.THREE = THREE; window.boxes = boxes; window.fader = fader;
if (new URLSearchParams(location.search).has('preset')) engine.setCamera('follow', { distance: 22, pitch: 0.7, projection: 'orthographic', size: 14 });
engine.start();
