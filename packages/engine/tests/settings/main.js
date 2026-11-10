// Test scene: settings menu (Esc) + background music (rules: switch track when it rains, duck during dialogue)
import { createEngine, presets, world, sky, weather, followCamera, characters, collision, dialogue, interactions, debug, THREE } from '../../index.js';
import { settings } from '../../modules/settings/index.js';
import { music } from '../../modules/music/index.js';

const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), saveKey: 'threedog-test' });
engine.use(
  world(), sky({ time: 0.45 }), weather({ ...presets.weather.temperate, start: 'clear' }), collision(), followCamera(), characters(),
  interactions({ ...presets.interactions.nearest }), dialogue(), debug(),
  music({ tracks: { a: '/tests/settings/audio/a.wav', b: { url: '/tests/settings/audio/b.wav', volume: 0.8 }, sting: { url: '/tests/settings/audio/sting.wav', loop: false } } }),
  settings(new URLSearchParams(location.search).has('pixel') ? { sections: [{ id: 'graphics', omit: ['pixelRatio', 'antialias', 'adaptive'] }, 'audio'] } : {}),
);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8a9a7a }));
ground.receiveShadow = true; engine.add(ground);
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });
engine.dialogue.define('测试', { start: { text: '你好。', next: 'b' }, b: { text: '再见。' } });

engine.music.rules([
  { track: 'b', when: { weather: ['rain', 'storm'] }, priority: 5 },
  { track: 'a', priority: 0 },
], { hold: 1, fade: 1 });

engine.start();
window.engine = engine;
