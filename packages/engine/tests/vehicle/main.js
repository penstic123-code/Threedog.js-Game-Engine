// Vehicle, character controller (mover) and animation state machine test scene: built entirely in code.
//   floor 80×80 (y=0) · stairs_low (0.4 high, x 6→10) · stairs_high (1 high, x 6→10, z 8→12)
//   car (spawns at (-15, 1.5, -15), nose toward +Z) · skinned dummy window.makeRig() (two bones + Idle/Walk/Run/Wave clips)
//   ?mover=rapier the player uses the Rapier character controller
import { createEngine, presets, world, sky, collision, rigid, followCamera, characters, THREE } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { interactions } from '../../modules/gameplay/Interactions.js';

window.THREE = THREE; window.rigidModule = rigid;   // the group C spec builds a car under a moved parent and installs rigid at run time
const grey = c => new THREE.MeshLambertMaterial({ color: c });
const root = new THREE.Group(); root.name = 'vehicleLevel';
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), grey(0x8a8a8a)); floor.name = 'floor'; root.add(floor);
const block = (name, h, x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(4, h, 4), grey(0x7a7a7a)); m.name = name; m.position.set(x, h / 2, z); root.add(m); };
block('stairs_low', 0.4, 8, 0);
block('stairs_high', 1, 8, 10);
const spawn = new THREE.Object3D(); spawn.name = 'spawn'; spawn.position.set(0, 0, 0); root.add(spawn);

const mover = new URLSearchParams(location.search).get('mover') || 'simple';
const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.brake }, canvas: document.getElementById('view'), ui: { loading: { title: 'Vehicle test' } }, adaptiveResolution: false });
engine.use(world(), sky({ time: 0.45 }), collision(), rigid(), followCamera(), characters({ npcs: false }), interactions({ ...presets.interactions.nearest }), level({ scene: root }));

// Car: body + four wheels (wheels are children of the body; addWheeled makes them follow suspension and steering)
function makeCar() {
  const car = new THREE.Group(); car.name = 'car';
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), grey(0x666666)); body.position.y = 0.3; car.add(body);
  const wheels = [[-0.85, 1.2, true, false], [0.85, 1.2, true, false], [-0.85, -1.2, false, true], [0.85, -1.2, false, true]].map(([x, z, steer, drive]) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 10).rotateZ(Math.PI / 2), grey(0x333333));
    w.position.set(x, 0, z); car.add(w);
    return { position: [x, 0, z], radius: 0.35, steer, drive, object: w };
  });
  car.position.set(-15, 1.5, -15);
  return { car, wheels };
}

// Skinned dummy: two bones, four clips (only the second bone rotates, each clip by a different angle)
window.makeRig = () => {
  const bones = [new THREE.Bone(), new THREE.Bone()]; bones[0].name = 'hip'; bones[1].name = 'arm'; bones[1].position.y = 1; bones[0].add(bones[1]);
  const geo = new THREE.BoxGeometry(0.4, 2, 0.4, 1, 2, 1).translate(0, 1, 0), n = geo.attributes.position.count, idx = [], wts = [];
  for (let i = 0; i < n; i++) { const up = geo.attributes.position.getY(i) > 1.01; idx.push(up ? 1 : 0, 0, 0, 0); wts.push(1, 0, 0, 0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const mesh = new THREE.SkinnedMesh(geo, grey(0x999999)); mesh.add(bones[0]); mesh.bind(new THREE.Skeleton(bones));
  const clip = (name, dur, angle) => new THREE.AnimationClip(name, dur, [new THREE.NumberKeyframeTrack('arm.rotation[x]', [0, dur / 2, dur], [0, angle, 0])]);
  const model = new THREE.Group(); model.add(mesh);
  model.animations = [clip('Idle', 2, 0.1), clip('Walk', 1, 0.8), clip('Run', 0.6, 1.4), clip('Wave', 0.8, 2)];
  return model;
};

engine.events.on('engine:ready', () => {
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 }, mover });
  const { car, wheels } = makeCar();
  window.car = engine.rigid.addWheeled(car, { wheels, mass: 600, engineForce: 1200, camera: { distance: 16, height: 2 } });
});
engine.start();
