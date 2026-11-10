// @ts-check
// __NAME__: open-world start (--open-world) — a player on generated ground with a follow camera and a day/night sky. No gameplay yet: build what DESIGN.md describes.
// Wired because nearly every game needs them: start screen (Continue / Start), autosave, Esc = pause + settings, third-person walking and camera; delete or swap a line to drop one.
// Rules live here (modules, ops, state); placed things default to content/ (saves read it), plain three.js works as well. Other systems: CLAUDE.md "Already here".
__TSL_IMPORT__
import { createEngine, presets, openWorld, followCamera, content } from 'threedog';
import { createPicture } from './picture/index.js';   // the game's own picture in plain three.js: gray for now; make it yours, recipe 62
import { terrainPreset } from '@threedog/terrain-noise';   // optional: a terrain generator (the engine ships none)
import data from './content/index.js';
import packs from './assets.js';

const engine = createEngine({ __RENDERER__bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.debug }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, ui: { loading: { title: '__NAME__' }, title: { title: '__NAME__' } }, saveKey: '__NAME__' });   // sounds are content: content/audio.js
// openWorld installs the world and environment (terrain, vegetation, sky, weather, water, collision, camera, characters, settings, debug); add gameplay modules yourself.
// More you can add: interactions() inventory() pickups() (items lying on the ground) hud() dialogue() quests() triggers() timeline() particles() music() photo() grids(), usage in node_modules/threedog/docs/api/<module>.md
engine.use(openWorld({ camera: followCamera({ pointerLock: true }), seed: 42, terrain: terrainPreset(), time: 0.3, weather: presets.weather.temperate, calendar: presets.calendar.cycle,
  settings: { freezeWorld: true } }), content());   // the sky gives the signals and draws its dome; lights and fog are picture/'s; settings: Esc pauses and opens the menu
engine.saves.autosave(0.5);   // minutes of play; Continue on the start screen loads it. The game's own state joins with engine.saves.define('game', { version: 1, save, load }), recipe 20
engine.use(createPicture());   // a picture module; to switch looks: engine.use(another(), { replaces: 'picture' })
const { picture } = engine;   // picture.materials: the game's materials by name
engine.assets.manifest(packs);   // assets.js: the models / sounds / textures content names (the marker example for now)
// Camera: click the view once to capture the mouse, then the mouse turns the view (Esc releases it). For drag-to-turn instead: followCamera({ pointerLock: false }).

const home = engine.characters.findSpawn([0, 0, 0], { minH: 3, maxH: 14 });   // the terrain is generated: find a flat spot as "home". home is a Vector3, use home.x / home.z, not home[0]
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: home });
engine.content.load(data, { places: { home } });   // content/ is empty for now; place things relative to home with { place: 'home', x, z }

Object.assign(window, { engine, picture });   // tests, screenshots and the console all rely on it (before start, so the dev bridge can wait for it)
await engine.start();      // when start returns the modules are ready; anything that needs the terrain generated (finding a shore, reading ground height) goes after this line
