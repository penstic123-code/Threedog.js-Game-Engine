// Test page: the UI choice cursor, the dialogue bubble channel, and the engine's callers running on contract fakes. ?fakes=1 | (none)
//   (none)   the engine's own dialogue / quests / inventory / follow camera; navigator.getGamepads is replaced by window.__pad so a test plays gamepad-only
//   fakes=1  dialogue, quests and the camera are the fakes of tests/contract/ (no engine module of those names): NPC talk, timeline say, the content
//            loader, the hud, control: 'camera' and character.enter (with a fake vehicle) must work on them through the contract surface only
import { createEngine, presets, makeWindow, world, collision, followCamera, characters, interactions, dialogue, quests, inventory, hud, content, timeline, THREE } from '../../index.js';
import { fakeDialogue } from '../contract/fakeDialogue.js';
import { fakeQuests } from '../contract/fakeQuests.js';
import { fakeCamera } from '../contract/fakeCamera.js';
import { fakeVehicle } from '../contract/fakeVehicle.js';
Object.assign(window, { fakeVehicle, makeWindow });   // the tests build a vehicle without the rigid module, and their own windows

const fakes = new URLSearchParams(location.search).has('fakes');
// a standard-layout pad the test drives: 16 buttons (A B X Y LB RB LT RT Select Start L3 R3 Up Down Left Right), two sticks
const pad = window.__pad = { connected: true, buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
Object.defineProperty(navigator, 'getGamepads', { value: () => [pad], configurable: true });

const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), saveKey: 'test-uinav', adaptiveResolution: false, ui: { loading: false } });
engine.use(world(), collision(), fakes ? fakeCamera() : followCamera(), characters(), interactions({ ...presets.interactions.nearest }),
  fakes ? fakeDialogue() : dialogue({ charsPerSecond: 0 }), fakes ? fakeQuests() : quests(), hud(), content(), timeline(),
  ...(fakes ? [] : [inventory()]));
engine.add(new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x888888 })));
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });
if (!fakes) {
  engine.inventory.define('apple', { name: 'Apple', use: () => true }).define('bread', { name: 'Bread', use: () => true });
  engine.inventory.add('apple', 2); engine.inventory.add('bread', 2);
}
window.engine = engine;
await engine.start();
