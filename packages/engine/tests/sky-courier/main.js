// Shared acceptance scene: flight. Ordinary game code on the public API only: a courier flies between floating islands, through a waterfall, on paths the game plans itself.
// tests/specs/sky-courier.mjs plays it. No art: gray boxes; the two looks are the starter pictures a game would pull.
import { createEngine, presets, world, sky, collision, followCamera, characters, rigid, content, triggers, terrain, level, compositeGround, Character, THREE } from '../../index.js';
import { createPicture as brightLook } from '../../../starter-pictures/bright-cartoon/index.js';
import { createPicture as asciiLook } from '../../../starter-pictures/ascii-meadow/index.js';

// ?renderer=webgpu: the looks are TSL, the flight is not
const gpu = new URLSearchParams(location.search).get('renderer') === 'webgpu';
if (gpu) await import('threedog/tsl');

// the landing pad: a hand-made level sitting in the terrain, four meters up
const pad = new THREE.Group(); pad.name = 'pad';
const deck = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 12).translate(0, 3.5, 0), new THREE.MeshStandardMaterial({ color: 0x8a8a8a })); deck.name = 'deck'; pad.add(deck);
const spawn = new THREE.Object3D(); spawn.name = 'spawn'; spawn.position.set(0, 4, 0); pad.add(spawn);

const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: false }, adaptiveResolution: false, saveKey: 'test-sky-courier', urlState: false, ...(gpu && { renderer: 'webgpu' }) });
engine.use(world(), sky({ time: 0.45 }), collision(), followCamera({ distance: 6, pitch: 0.25, height: 1.2 }), characters({ npcs: false }), rigid({ fallbackFloor: false }), content(), triggers(),
  terrain({ part: true, height: (x, z) => Math.sin(x * 0.1) + Math.cos(z * 0.1), viewChunks: 1 }), level({ part: true, scene: pad }),
  compositeGround({ parts: [{ of: 'terrain' }, { of: 'level', region: (x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6, priority: 1 }] }));

// the islands: turned on all three axes, stretched, placed in the air
engine.assets.manifest({ name: 'sky-courier', models: { island: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9a9a90 })) } });
const ISLANDS = [
  { id: 'isle-a', model: 'island', x: 30, y: 40, z: 0, ground: false, rot: [0.4, 0.3, 0.5], scale: [10, 2, 6], collide: 'box' },
  { id: 'isle-b', model: 'island', x: -30, y: 55, z: 20, ground: false, rot: [0, 0, 0.6], scale: [8, 3, 8], collide: 'box' },
];

// the waterfall: water only inside a column of air, so its level depends on how high you ask
const fall = { x: 0, z: 40, r: 3, top: 60, bottom: 2 };
const waterfall = (x, z, y) => (Math.hypot(x - fall.x, z - fall.z) < fall.r && y != null && y <= fall.top && y >= fall.bottom ? y + 1 : null);

// the game's own mover: flies on three axes and stops at anything solid
const fly = (c, e) => ({ name: 'fly', move(x, z, run, dt, y = 0) {
  const p = c.root.position, v = c.stat('speed') * dt, mid = new THREE.Vector3(p.x, p.y + 0.9, p.z), to = new THREE.Vector3(x * v, y * v, z * v).add(mid);
  const hit = e.collider3d.sweep(mid, to, 0.4);   // from the middle of the body: the feet stand exactly on the ground
  p.copy(hit ? hit.point : to).y -= 0.9;
  c.grounded = false; e.characters.kit.ownState(c, 'fly', v / dt);
} });

const game = window.game = { THREE, Character, fly, ISLANDS, fall, falls: 0, wet: 0, brightLook, asciiLook };

engine.events.on('engine:ready', () => {
  game.waterfall = engine.addWaterBody({ query: waterfall, bounds: { min: { x: fall.x - fall.r, y: fall.bottom, z: fall.z - fall.r }, max: { x: fall.x + fall.r, y: fall.top, z: fall.z + fall.r } } });
  engine.content.load({ name: 'sky', props: ISLANDS });
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 }, fall: { belowY: -30 } });
  engine.events.on('character:fall', () => { game.falls++; });
  engine.events.on('character:water', ({ in: inside }) => { if (inside) game.wet++; });
  window.ready = true;
});
engine.start();
