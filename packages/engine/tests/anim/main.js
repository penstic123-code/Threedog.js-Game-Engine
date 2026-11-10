// Skeletal animation test scene: a real CC0 glTF character (public/king.glb, see public/ASSETS.md) on a flat floor.
//   The player uses the model; the manifest entry's states map game names to the asset's clip names ('CharacterArmature|Sword_Slash' is found as 'Sword_Slash').
//   window.skinnedGlb() (rig.js) builds a minimal skinned GLB in code for the generated-rig spec.
//   window.swing is a gameplay action timeline (fixed-step seconds): windup 0.16, active 0.12, recovery 0.34. Its timing pairs
//   put the clip's down-swing (measured: the right wrist peaks at clip ~0.24 s and comes down by ~0.5 s) inside the active phase.
//   ?ik=1 shows the IK layers (a step under one foot, a look target).
//   ?swing=1 keeps swinging (sync driven by a fixed-step counter) to look at it.
import { createEngine, presets, world, sky, collision, followCamera, characters, Character, THREE } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { skinnedGlb } from './rig.js';
import { twoBone } from '../../core/assets/ik.js';
window.twoBone = twoBone;   // the IK spec checks the solver's corner cases directly

const root = new THREE.Group(); root.name = 'animLevel';
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8a8a8a })); floor.name = 'floor'; root.add(floor);
const spawn = new THREE.Object3D(); spawn.name = 'spawn'; root.add(spawn);

window.THREE = THREE;   // the test reads bone positions
window.Character = Character;   // character-model spec builds characters directly
const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: { title: 'Animation test' } }, adaptiveResolution: false });
engine.use(world(), sky({ time: 0.45 }), collision(), followCamera({ distance: 4, pitch: 0.25, height: 1.2 }), characters({ npcs: false }), level({ scene: root }));
window.skinnedGlb = skinnedGlb;   // the generated-rig spec builds its own glb

window.swing = { phases: [['windup', 0, 0.16], ['active', 0.16, 0.28], ['recovery', 0.28, 0.62]], duration: 0.62 };
window.STATES = {
  idle: { clip: 'Idle_Sword' }, walk: { clip: 'Walk' }, run: { clip: 'Run' },
  attack: { clip: 'Sword_Slash', loop: false, timing: [[0, 0], [0.16, 0.24], [0.28, 0.5], [0.62, 1]] },
  roll: { clip: 'Roll', loop: false, timing: 0.62 }, hurt: { clip: 'HitRecieve', loop: false, timing: 0.45 }, death: { clip: 'Death', loop: false },
};
// the mapping is data on the model's manifest entry: the player below only names the model
engine.assets.manifest({ name: 'anim-test', models: { king: { url: new URL('./public/king.glb', import.meta.url).href, animation: { states: window.STATES } } } });

engine.events.on('engine:ready', async () => {
  const model = await engine.assets.model('king');
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 }, model });
  window.ready = true;
  if (new URLSearchParams(location.search).get('ik')) {   // ?ik=1: a 15 cm step under the left foot, feet on it, the head on a point to the front left (look with threedog shot)
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.8), floor.material); step.position.set(0.3, 0.075, 0); engine.scene.add(step); engine.characters.support(step);
    engine.player.anim.addFeet(); engine.player.anim.addAim({ bones: ['Neck', 'Head'], target: [1.5, 1.3, 2] });
  }
  if (new URLSearchParams(location.search).get('swing')) {
    let t = 0;
    engine.onFixed(dt => { t = (t + dt) % 1.2; if (t < window.swing.duration) engine.player.anim.sync('attack', t); else engine.player.anim.sync(null); });
  }
});
engine.start();
