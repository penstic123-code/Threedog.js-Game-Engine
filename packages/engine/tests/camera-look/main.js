// Follow camera look-up test page: flat ground, a roof (with an edge) and a wall. ?ground=raise|shorten|none (default: the preset's).
// window.scene(name) puts the player there and a high marker in front of it; window.view() reports what the camera centre actually sees.
import { createEngine, presets, world, sky, collision, characters, debug, THREE } from '../../index.js';
import { followCamera } from '../../modules/camera/FollowCamera.js';

const q = new URLSearchParams(location.search), groundMode = q.get('ground');
const engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: { title: 'camera look-up test' } } });
const camOpts = { ...presets.camera.thirdPersonAction, ...(groundMode ? { ground: groundMode } : {}) };
engine.use(world(), sky({ time: 0.45 }), collision({ cameraMin: 0.4 }), followCamera(camOpts), characters({ npcs: false }), debug());

// Roof: a 12 x 12 building 6 m tall at x 24..36, z -6..6; the ground height says so too, so the player stands on it
const ROOF = { x0: 24, x1: 36, z0: -6, z1: 6, h: 6 };
const onRoof = (x, z) => x >= ROOF.x0 && x <= ROOF.x1 && z >= ROOF.z0 && z <= ROOF.z1;
// Bump: a 0.25 m wide, 4 m tall ridge in the ground height at z 4.05..4.30 (x -63..-57), so an 8 m arm at pitch 0.2 crosses it between
// the old fixed 12 samples (4.0 and 4.67 m along the arm). Ground height only (no collider): only ground: 'shorten' can see it
const BUMP = { x0: -63, x1: -57, z0: 4.05, z1: 4.3, h: 4 };
const onBump = (x, z) => x >= BUMP.x0 && x <= BUMP.x1 && z >= BUMP.z0 && z <= BUMP.z1;
engine.setGround({ height: (x, z) => onRoof(x, z) ? ROOF.h : onBump(x, z) ? BUMP.h : 0 });
window.THREE = THREE;
const mat = new THREE.MeshLambertMaterial({ color: 0xc8c4bc });
const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9a9a96 }));
groundMesh.name = 'ground'; engine.add(groundMesh);
const house = new THREE.Mesh(new THREE.BoxGeometry(12, ROOF.h, 12), mat);
house.name = 'house'; house.position.set(30, ROOF.h / 2, 0); engine.add(house);
// Wall: 6 m wide, 5 m tall, 0.6 m thick, face toward -z at z = 9.7
const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 0.6), mat);
wall.name = 'wall'; wall.position.set(-20, 2.5, 10); engine.add(wall);
engine.collision.addBox({ x: -20, z: 10 }, { halfWidth: 3, halfDepth: 0.3, height: 5 });

// The high marker: a 6 x 6 slab 10 m above the look point, centred where a 60° upward look from the look point lands.
// Its edges are at about 48° and 74° up, so only a camera that really looks up ~50-70° sees it at the screen centre
const marker = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 6), new THREE.MeshBasicMaterial({ color: 0xff3366 }));
marker.name = 'marker'; engine.add(marker);

const player = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });

// yaw 0: the camera sits on the +z side of the player and looks toward -z
const SCENES = {
  ground: { x: 0, z: 0 },
  roof: { x: 30, z: -3 },        // camera arm over the roof itself
  roofEdge: { x: 30, z: 5.2 },   // camera arm hangs out past the roof edge
  wall: { x: -20, z: 8.6 },      // camera arm goes into the wall behind the player
  bump: { x: -60, z: 0 },        // camera arm crosses the narrow bump about 4.1 m out
  forest: { x: 60, z: -60 },     // open ground: the occluder spec rings it with tree colliders
};
window.scene = name => {
  const s = SCENES[name], rig = engine.cameraRig;
  engine.ops.allow(() => player.placeAt({ x: s.x, z: s.z }));   // test setup, not gameplay: no ops-guard reminder
  rig.setView({ yaw: 0, pitch: 0.25 });
  rig.focus.copy(player.position); rig._d = undefined;
  const top = player.position.y + rig.height + 10, f = rig.forward(), r = rig.right();
  marker.position.set(s.x + r.x * rig.shoulder + f.x * 10 / Math.tan(Math.PI / 3), top, s.z + r.z * rig.shoulder + f.z * 10 / Math.tan(Math.PI / 3));
  return { y: player.position.y };
};
const ray = new THREE.Raycaster(), centre = new THREE.Vector2(0, 0);
const shown = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
window.view = () => {
  const cam = engine.camera, rig = engine.cameraRig, v = rig.getView();
  cam.updateMatrixWorld();
  ray.setFromCamera(centre, cam); ray.layers.mask = cam.layers.mask;   // what the camera can see: a hidden player is skipped like the renderer skips it
  const hits = ray.intersectObjects(engine.scene.children, true).filter(h => h.object.isMesh && shown(h.object) && h.distance > cam.near);
  let playerHit = false; player.root.traverse(o => { if (hits[0]?.object === o) playerHit = true; });
  const meshes = []; player.root.traverse(o => { if (o.isMesh) meshes.push(o); });
  const r2 = x => Math.round(x * 100) / 100;
  return { first: playerHit ? 'player' : hits[0]?.object.name || hits[0]?.object.type || null, upDeg: r2(Math.asin(v.look.y) * 180 / Math.PI), pitch: r2(v.pitch), arm: r2(v.arm),
    camY: r2(cam.position.y), groundUnder: r2(engine.surface(cam.position.x, cam.position.z, v.lookPoint.y)), playerY: r2(player.position.y),
    playerHidden: meshes.length > 0 && meshes.every(m => !cam.layers.test(m.layers)) };
};
window.engine = engine; window.player = player; window.THREE = THREE; window.presets = presets;
engine.start();
