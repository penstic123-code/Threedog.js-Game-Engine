// Navmesh test scene (maze): 40×40 floor; one cross wall col_wall (z=0, x -12→12) with gaps at both ends (x ±12→±20).
//   Going from (4, -5) to (4, 5) must detour around the wall; with the right gap blocked, the path goes around the left. The NPC "信使" (courier) walks from (4, -5) to its schedule point (4, 5).
//   Walls use the level col_ naming (they become collision-module rectangles); the nav module syncs them as dynamic obstacles.
import { createEngine, presets, world, collision, followCamera, characters, Character, THREE } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { nav } from '../../modules/nav/index.js';

const grey = c => new THREE.MeshLambertMaterial({ color: c });
const root = new THREE.Group(); root.name = 'maze';
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), grey(0x8a8a8a)); floor.name = 'floor'; root.add(floor);
const wall = new THREE.Mesh(new THREE.BoxGeometry(24, 3, 1), grey(0x666666)); wall.name = 'col_wall'; wall.position.set(0, 1.5, 0); root.add(wall);
const spawn = new THREE.Object3D(); spawn.name = 'spawn'; spawn.position.set(-6, 0, -8); root.add(spawn);

const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: { title: 'Nav test' } }, adaptiveResolution: false,
  movement: new URLSearchParams(location.search).has('radius') ? { radius: +new URLSearchParams(location.search).get('radius') } : undefined });   // ?radius=0.6：tests the unified movement parameters
engine.use(world(), collision(), followCamera(), characters(), level({ scene: root }), nav({ debug: true, crowd: new URLSearchParams(location.search).has('crowd') }));
engine.events.on('engine:ready', () => {
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: -6, z: -8 } });
  engine.npcs.add({ name: '信使', position: { x: 4, z: -5 }, schedule: [{ at: 0, position: { x: 4, z: 5 } }] });
});
window.Character = Character;
engine.start();
