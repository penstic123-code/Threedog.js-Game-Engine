// Level + trigger zone test scene: built entirely in code, no model files needed.
//   floor (40×40, y=0) · ramp (x 2→8, rising from 0 to 2 m) · platform (x 8→14, top at y=2)
//   three walls col_wall_* (hidden collision boxes, one rotated 30°) · markers spawn、npc_guard、trigger_test、marker_chest
import { createEngine, presets, world, sky, collision, rigid, followCamera, characters, grids, content, THREE } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { triggers } from '../../modules/triggers/index.js';

const grey = c => new THREE.MeshLambertMaterial({ color: c });
const root = new THREE.Group(); root.name = 'testLevel';
const floorMat = grey(0x8a8a8a); floorMat.name = 'stone';
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), floorMat);
floor.name = 'floor'; floor.receiveShadow = true; root.add(floor);

// Ramp: a 6×2 slope rising from (2, 0) to (8, 2)
const rampGeo = new THREE.BufferGeometry();
rampGeo.setAttribute('position', new THREE.Float32BufferAttribute([2, 0, -3, 2, 0, 3, 8, 2, 3, 2, 0, -3, 8, 2, 3, 8, 2, -3], 3));
rampGeo.computeVertexNormals();
const ramp = new THREE.Mesh(rampGeo, grey(0x9a9a9a)); ramp.name = 'ramp'; ramp.userData.groundType = 'wood'; root.add(ramp);

// Platform: x 8→14, z -3→3, 2 m high (walkable top)
const platform = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 6), grey(0x7a7a7a));
platform.name = 'platform_floor'; platform.position.set(11, 1, 0); root.add(platform);

// Collision walls (hidden)
const wall = (name, x, z, w, d, rot = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), grey(0x666666));
  m.name = name; m.position.set(x, 1.5, z); m.rotation.y = rot; root.add(m);
};
wall('col_wall_north', 0, -10, 10, 1);
wall('col_wall_west', -10, 0, 1, 10);
wall('col_wall_rot', -5, 8, 6, 1, Math.PI / 6);
// A wall that is both visible and blocking
const vis = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 6), grey(0x707070)); vis.name = 'pillar'; vis.userData.collider = true; vis.position.set(-14, 1.5, -14); root.add(vis);

// Markers (empty objects)
const mark = (name, x, y, z, scale = 1, ud = {}) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); o.scale.setScalar(scale); Object.assign(o.userData, ud); root.add(o); };
mark('spawn', 0, 0, 4);
mark('npc_guard', -3, 0, -3, 1, { role: 'guard' });
mark('trigger_test', 0, 1, -5, 1.5);   // a 3×3×3 box, bottom at y=-0.5
mark('marker_chest', 5, 0, 5);

const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: { title: 'Level test' } }, adaptiveResolution: false });
engine.use(world(), sky({ time: 0.45 }), collision(), rigid(), followCamera(), characters({ npcs: false }), level({ scene: root }), triggers());

window.log = { enter: [], exit: [] };
window.grids = grids;   // installed at runtime by tests/specs/grid.mjs (the test build has no source files to import)
window.content = content; window.THREE = THREE;   // tests/specs/single-source.mjs: content at runtime, level-node scenes built in the page
engine.events.on('level:loaded', () => {
  const s = engine.level.spawn;
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: s.x, z: s.z } });
  engine.triggers.fromMarkers({ onEnter: t => window.log.enter.push(t.tag), onExit: t => window.log.exit.push(t.tag) });
});
engine.start();
