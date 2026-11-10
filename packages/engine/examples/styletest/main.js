// @ts-check
// This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). On the default WebGPU route the same ideas are written in TSL (recipe 56).
// Style test: one fixed scene to judge a picture by (and the check an AI runs after turning a reference picture into a picture).
// Exhibits (content/): character, trees, rock, grass, flowers, water, terrain, glass, a shadow receiver, wood / stone / metal, a lit room (outside and inside),
// and the UI parts (HUD, dialogue, bag) on the `ui` view. Parameters (params.js): time, weather, env, view, panel. Camera views: views.js.
// main.js holds wiring only: modules, finding the stage, view switching, when the lamp burns. The exhibits are content (rule R33), the picture is picture/.
import { params } from './params.js';   // first: rewrites ?time=dusk style words before the engine reads the URL
import { createEngine, openWorld, presets, content, interactions, dialogue, inventory, fixedCamera, hud, lightPool, particles, createTerrain } from '../../index.js';
import { createPicture } from './picture/index.js';   // the picture under test; its procedural trees / rocks / humanoid are registered from assets.js
import { TERRAIN } from './picture/palette.js';
import { terrainPreset, riverAt, terrainStrings } from '@threedog/terrain-noise';
import data from './content/index.js';
import packs from './assets.js';
import { makeViews, pathAt } from './views.js';

// ---------- 0. The stage: a flat spot with water close by (same seed = same place every run) ----------
const SEED = 1337, preview = createTerrain({ seed: SEED, ...terrainPreset() });
/** Nearest point under water within maxR of (x, z), or null */
function waterNear(x, z, maxR) {
  for (let r = 8; r <= maxR; r += 3) for (let a = 0; a < 6.28; a += 0.3) {
    const wx = x + Math.cos(a) * r, wz = z + Math.sin(a) * r;
    if (preview.surface(wx, wz) < preview.waterLevel - 1.2) return { x: wx, z: wz };
  }
  return null;
}
let stage = { x: 0, z: 0 }, water = { x: 30, z: 0 };
for (let r = 0, found = false; r < 3000 && !found; r += 10) {
  const a = r * 0.37, x = Math.cos(a) * r, z = Math.sin(a) * r, h = preview.surface(x, z);
  if (h > 4 && h < 10 && preview.slope(x, z) < 0.2 && riverAt(x, z, preview.noise) === 0) {
    const w = waterNear(x, z, 60);
    if (w) { stage = { x, z }; water = w; found = true; }
  }
}

// ---------- 1. Engine: open-world preset with a fixed sky (no clock drift between screenshots) + the picture under test ----------
const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory, ...presets.bindings.debug, ...presets.bindings.dialogNumbers }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, strings: terrainStrings, saveKey: 'threedog-styletest',
  ui: { loading: { title: 'style test' } } });
engine.use(openWorld({ camera: fixedCamera(), seed: SEED, terrain: { ...terrainPreset(), ...TERRAIN }, flatten: [{ x: stage.x, z: stage.z, radius: 30 }], calendar: { ...presets.calendar.fixedTime, time: 0.5 },
  weather: presets.weather.temperate, autoWeather: false }),
  interactions({ ...presets.interactions.nearest }), dialogue({ holdSeconds: 1e6 }), inventory(), hud(), lightPool({ point: 2 }), particles(), content());   // particles: the picture under test defines its effects there

const picture = createPicture(engine, { env: params.env });
engine.assets.manifest(packs);   // assets.js: the world example's trees / rocks and the test models content/templates.js uses
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: 'humanoid', spawn: { x: stage.x + 0.5, z: stage.z + 6 } });
engine.content.load(data, { places: { stage, water } });

// ---------- 2. The room's lamp: on from 18:00 to 06:00 ----------
const lamp = picture.addLamp({ x: stage.x + 14, y: engine.surface(stage.x + 14, stage.z - 2) + 2.7, z: stage.z - 2 });
engine.calendar.between('18:00', '06:00', { on: () => lamp(true), off: () => lamp(false) });

// ---------- 3. Views: an op, so the URL, the dev bridge and tests switch the same way ----------
/** @type {{ view: string, since: number, views: ReturnType<typeof makeViews> }} */
const state = { view: params.view, since: 0, views: /** @type {any} */ (null) };
/** Show the UI exhibits only on the ui view; close them when leaving it */
function showUi(on) {
  if (on) {
    engine.dialogue.say('The light is best just before dusk. Mind the step.', { speaker: 'Guide' });   // the main box, shown for its picture
    engine.ui.open('inventory');
  } else { engine.dialogue.end(); engine.ui.close('inventory'); }
}
/** Fixed camera (views.js shots): a view is a shot, cut to at once. The path shot is moved along its line every frame, from the moment it is chosen */
function setView(name) {
  const cam = /** @type {any} */ (engine.cameraRig), views = makeViews(engine, stage, water);
  for (const [n, v] of Object.entries(views)) cam.add(n, { position: v.pos, lookAt: v.look });
  state.view = name; state.since = engine.time.now('real'); state.views = views;
  showUi(name === 'ui');
  cam.cut(name);
}
engine.onFrame(() => {
  if (state.view === 'path' && state.views) /** @type {any} */ (engine.cameraRig).shots.path.position.fromArray(pathAt(state.views.path, engine.time.now('real') - state.since));
});
engine.ops.define('styletest.view', {
  desc: 'Move the camera to a named view: overview, character, water, room, path, ui', args: { name: 'string' },
  can: (e, { name }) => ['overview', 'character', 'water', 'room', 'path', 'ui'].includes(name) ? true : 'unknownView',
  run: (e, { name }) => { setView(name); return name; },
  reasons: { unknownView: 'View names: overview, character, water, room, path, ui' },
});
engine.describe.add('styletest', () => ({ view: state.view, env: params.env, panel: params.panel, stage: { x: +stage.x.toFixed(1), z: +stage.z.toFixed(1) } }));
engine.events.on('engine:ready', () => engine.ops.run('styletest.view', { name: params.view }));
if (params.badView) console.warn(`styletest: unknown view '${params.badView}', showing overview. Views: overview, character, water, room, path, ui`);

// The dev panel (@threedog/tools/panel) on ?panel=1; a production build gets a stub (tweakpane may be missing: the panel then says so in the page)
if (params.panel) import('@threedog/tools/panel').then(m => m.openPanel(engine));

engine.start();
Object.assign(window, { engine, styletest: { picture } });   // the console and the tests: engine, and the picture's own lights
