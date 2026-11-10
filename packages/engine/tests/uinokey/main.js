// Test page: a game with interactions and no key bound for them (tests/specs/interact-key.mjs). Everything else works, which is why the fault hid.
import { createEngine, presets, world, collision, followCamera, characters, interactions, THREE } from '../../index.js';

const engine = createEngine({ canvas: document.getElementById('view'), saveKey: 'test-uinokey', adaptiveResolution: false });
engine.use(world(), collision(), followCamera(), characters(), interactions({ ...presets.interactions.nearest }));
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });
Object.assign(window, { engine, THREE });
await engine.start();
