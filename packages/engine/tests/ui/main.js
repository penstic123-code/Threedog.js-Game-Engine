// Test page: UI parts (engine.ui). ?mode=default | off | custom | skin
//   default  every default part, title screen on, settings with the optional 'game' and 'camera' tabs
//   off      every part off: the engine must draw nothing (guards against code that builds UI DOM without going through engine.ui)
//   custom   every part replaced by a recorder writing to window.uiLog
//   &at=name adds content() with the place pier (?at= needs a module that knows places)
//   skin     every default part, with the short style.ui of recipe 26 (window.skin): all of them must take it
import { createEngine, presets, world, hud, quests, settings, dialogue, interactions, followCamera, characters, collision, content, toast, THREE } from '../../index.js';

const mode = new URLSearchParams(location.search).get('mode') || 'default';
const log = window.uiLog = [];
const recorder = name => () => ({
  show: d => log.push([name, 'show', d && { ...d, items: d.items?.map(i => i.id) }]),
  update: d => log.push([name, 'update', d]),
  hide: () => log.push([name, 'hide']),
  dispose: () => log.push([name, 'dispose']),
});
const PARTS = ['loading', 'toast', 'title', 'hud.marker', 'hud.counter', 'hud.bar', 'dialogue', 'prompt', 'questLog', 'touch'];
const ui = mode === 'off' ? Object.fromEntries(PARTS.map(n => [n, false]))
  : mode === 'custom' ? Object.fromEntries(PARTS.map(n => [n, recorder(n)]))
  : { loading: { title: 'UI test' }, title: { title: 'UI test' } };

const skin = window.skin = { bg: 'rgb(10, 20, 30)', fg: 'rgb(240, 230, 200)', muted: 'rgb(150, 140, 120)', accent: 'rgb(200, 90, 40)', line: 'rgb(90, 80, 70)',
  font: 'SkinTestFont, serif', radius: '3px', radiusSmall: '1px', loadingBg: 'rgb(5, 10, 15)' };
if (mode === 'skin') ui.theme = skin;
window.createEngine = createEngine;
const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.quests }, canvas: document.getElementById('view'), ui, saveKey: 'test-ui', adaptiveResolution: false, joystick: true });   // joystick: true = the touch part draws a stick on desktop too
engine.use(world(), collision(), followCamera(), characters(), hud(), quests(), interactions({ ...presets.interactions.nearest }), dialogue(), settings({ sections: ['graphics', 'controls', 'game', 'camera'] }));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x888888 }));
engine.add(ground);
const withPlaces = new URLSearchParams(location.search).has('at');
if (withPlaces) { engine.use(content()); engine.content.load({}, { places: { pier: { x: 20, z: -12 } } }); }
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });
engine.dialogue.define('npc', { start: { text: 'Hello', data: { portrait: 'p1' }, choices: [{ text: 'Bye', next: 'end' }] } });
engine.interactions.add([1, 0, 0], { id: 'lever', label: 'Lever', onUse: () => { window.leverUsed = (window.leverUsed || 0) + 1; } });
engine.quests.define('walk', { title: 'Walk', steps: [{ text: 'Go north', target: { x: 0, z: -10 }, done: e => e.vars.flag('walked') }] });
engine.quests.define('walk2', { title: 'Walk 2', steps: [{ text: 'Go south', done: () => false }] });
window.engine = engine; window.THREE = THREE; window.toast = text => toast(engine, text);
await engine.start();
