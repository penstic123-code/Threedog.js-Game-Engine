// @ts-check
// Procedural animation demo (page /procanim.html): the player is a code-built four-legged body animated without a skeleton. WASD walks,
// Shift runs, Space jumps (landing squashes); stand still for 4 s and the game's own 'sit' state (the character `states` hook) takes over.
// Test page for tests/specs/procedural-animation.mjs: window.procAnimTest = { animator, parts, player }. Shapes and motion only here; the whole picture is picture/.
import { createEngine, openWorld, followCamera, presets, THREE } from 'threedog';
import { buildCreature } from './creature.js';
import { createProceduralAnimator } from './proceduralAnim.js';
import { createPicture } from './picture/index.js';

const engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, ui: { loading: false }, saveKey: 'threedog-procanim' });
engine.use(openWorld({ camera: followCamera({ ...presets.camera.follow, distance: 4 }), terrain: false, vegetation: false, weather: false, water: false, rigid: false,
  ambience: false, calendar: { ...presets.calendar.fixedTime, time: 0.4 }, characters: { npcs: false } }));
const { mat } = createPicture(engine);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat.floor);
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
engine.scene.add(floor);

const { root, parts } = buildCreature({ material: mat.creature });
const RUN_SPEED = 7;
// The game's own state: 'sit' after 4 s without moving. The hook runs every fixed step after the mover's state; null keeps the mover's.
let stillSince = 0;
const player = engine.characters.addPlayer({
  ...presets.player.thirdPerson, runSpeed: RUN_SPEED,
  // rig: the body is ours; limbs: [] so the engine swings nothing. The engine still bobs `body` from its own rule; onPose below overwrites it.
  rig: { root, body: parts.body, limbs: [] },
  states: (ch, facts) => {
    if (facts.speed > 0.1 || !facts.grounded) { stillSince = engine.clock.now; return null; }
    return engine.clock.now - stillSince > 4 ? 'sit' : null;
  },
});

const animator = createProceduralAnimator(parts, { runSpeed: RUN_SPEED });
// Visuals run per frame, right after the engine applied its own pose (onPose): read the facts the fixed steps wrote (speed, state, grounded,
// vy), never write anything gameplay reads. A frame hook is the right clock for visuals: it runs once per drawn frame with that frame's dt.
player.onPose((ch, dt) => {
  animator.update(dt, { speed: ch.moveAmount, state: ch.state, grounded: ch.grounded, vy: ch.vy });
  if (ch.state === 'sit') {   // a state the engine does not know: the game decides its pose, on top of the animator's rest pose
    parts.legs.BL.rotation.x = parts.legs.BR.rotation.x = -1.1;
    parts.body.rotation.x = -0.35;
  }
});

// ?walk=2 walks sideways across the view at 2 m/s by itself (input autopilot), so a headless shot catches a stride in profile
const walk = Number(new URLSearchParams(location.search).get('walk'));
if (walk > 0) engine.input.autopilot = { x: 1, y: 0, speed: walk };
Object.assign(window, { engine, procAnimTest: { animator, parts, player } });
engine.start();
