// Shot page for lit particles (BT-B, recipes/64 "Lit particles"): a dark room, a cloud of lit dust, and a lamp that ?lamp=0 switches off.
// Judged by numbers, not taste: `THREEDOG_TEST=1 threedog shot /tests/lit-dust/index.html` with and without ?lamp=0, the picture's mean
// brightness must differ clearly (the dust is the only thing the lamp can light here: the floor is far below the view).
import { createEngine, particles, THREE } from '../../index.js';

const lampOn = new URLSearchParams(location.search).get('lamp') !== '0';
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), lights: false, ui: { loading: false }, saveKey: 'threedog-lit-dust-test' });
engine.use(particles());
engine.scene.background = new THREE.Color(0x000000);
engine.add(new THREE.AmbientLight(0xffffff, 0.15));   // a little: dust out of the lamp's reach stays just visible
const lamp = engine.add(new THREE.PointLight(0xffb070, 40, 0, 2));
lamp.position.set(0.8, 1.8, 0.5); lamp.visible = lampOn;
engine.views.define('dust', { position: [0, 1.5, 6], target: [0, 1.5, 0], fov: 50 });
engine.particles.define('dust', { max: 400, lifetime: [1000, 1000], speed: 0, spread: 0, gravity: 0, drag: 0, area: [2, 1, 1], size: 0.35,
  color: 0xc8b89a, opacity: 0.8, lit: true });
await engine.start();
engine.particles.emit('dust', [0, 1.5, 0], { count: 400 });
