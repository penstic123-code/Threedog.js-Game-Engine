// @ts-check
// __NAME__: scene-only start (--scene-only) — an empty scene, a camera and a gray picture in picture/. No content/, no assets.js, no gameplay: build what DESIGN.md describes.
// Wired: start screen (Continue / Start), autosave, Esc = pause + settings. Keep, replace (engine.ui.set) or delete each.
// Something placed and saved later: engine.use(content()) and a content/ folder (npx threedog how "place things"); plain three.js works as it is.
__TSL_IMPORT__
import { createEngine, presets, world, settings } from 'threedog';
import { createPicture } from './picture/index.js';   // the game's own picture in plain three.js: gray for now; make it yours, recipe 62

const engine = createEngine({ __RENDERER__bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, ui: { loading: { title: '__NAME__' }, title: { title: '__NAME__' } }, saveKey: '__NAME__' });
engine.use(world(), settings({ freezeWorld: true }));   // settings: Esc pauses and opens the menu
engine.saves.autosave(0.5);   // minutes of play; the game's own state joins with engine.saves.define('game', { version: 1, save, load }), recipe 20
engine.use(createPicture());   // a picture module; to switch looks: engine.use(another(), { replaces: 'picture' })
const { picture } = engine;   // picture.materials: the game's materials by name

// A plain THREE.PerspectiveCamera: place it, or add a camera module (followCamera...; recipe 21)
engine.camera.position.set(0, 6, 12);
engine.camera.lookAt(0, 0, 0);

Object.assign(window, { engine, picture });   // tests, shots and the console rely on it (before start, so the dev bridge can wait)
await engine.start();      // when start returns the modules are ready
