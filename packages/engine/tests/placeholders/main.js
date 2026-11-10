// Test page: the engine with no style, no model and no terrain generator. Everything should be the neutral placeholder picture
// (gray capsules, gray boxes, flat gray ground at y = 0, technical render baseline) and each missing piece warned once with its fix.
import { createEngine, presets, world, terrain, collision, followCamera, characters, interactions, inventory, pickups } from '../../index.js';

const warns = window.placeholderWarns = [];
const warn = console.warn;
console.warn = (...a) => { warns.push(String(a[0])); warn(...a); };
const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory }, canvas: document.getElementById('view'), ui: { loading: false }, saveKey: 'test-placeholders', adaptiveResolution: false });
engine.use(world(), terrain({ viewChunks: 2 }), collision(), followCamera(), characters(), interactions({ ...presets.interactions.nearest }), inventory(), pickups());
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });
engine.npcs.add({ id: 'walker', name: 'walker', position: [3, 0, -2] });
engine.inventory.define('gem', { name: 'gem' });
window.gemPickup = engine.pickups.spawn({ x: -2, z: 2 }, { give: 'gem' });
engine.pickups.spawn({ x: 1.5, z: 3 }, { give: 'gem' });
await engine.start();
