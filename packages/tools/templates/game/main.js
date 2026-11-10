// @ts-check
// __NAME__: blank start — an empty scene, a camera and a gray picture in picture/. No gameplay and no genre yet: build what DESIGN.md describes.
// Wired: start screen (Continue / Start), autosave, Esc = pause + settings.
// Keep, replace (engine.ui.set) or delete each. Rules live here (modules, ops, state); placed things default to content/ (saves read it); plain three.js works too.
__TSL_IMPORT__
import { createEngine, presets, world, content, settings } from 'threedog';
import { createPicture } from './picture/index.js';   // the game's own picture in plain three.js: gray for now; make it yours, recipe 62
import data from './content/index.js';
import packs from './assets.js';

const engine = createEngine({ __RENDERER__bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, ui: { loading: { title: '__NAME__' }, title: { title: '__NAME__' } }, saveKey: '__NAME__' });   // sounds are content: content/audio.js
engine.use(world(), content(), settings({ freezeWorld: true }));   // world: what content/ places, saved; settings: Esc pauses and opens the menu
engine.saves.autosave(0.5);   // minutes of play; the game's own state joins with engine.saves.define('game', { version: 1, save, load }), recipe 20
engine.use(createPicture());   // a picture module; to switch looks: engine.use(another(), { replaces: 'picture' })
const { picture } = engine;   // picture.materials: the game's materials by name
engine.assets.manifest(packs);   // assets.js: the models / sounds / textures content names

// Ready lines (walk + follow camera, talk, press E, a quest, a counter): npx threedog how --read recipes/63-third-person-start.md#1, then #4.

// A plain THREE.PerspectiveCamera: place it, or add a camera module (followCamera...; recipe 21)
engine.camera.position.set(0, 6, 12);
engine.camera.lookAt(0, 0, 0);
engine.content.load(data);   // content/places.js comes with data; a place computed at startup goes on top: engine.content.load(data, { places: { home } })

Object.assign(window, { engine, picture });   // tests, shots and the console rely on it (before start, so the dev bridge can wait)
await engine.start();      // when start returns the modules are ready
