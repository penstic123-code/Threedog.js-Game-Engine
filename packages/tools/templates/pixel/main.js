// @ts-check
// __NAME__: pixel 2.5D start (--pixel) — a sprite character in an orthographic, pixel-snapped view; input, interaction, dialogue and saves wired. Gray placeholders, no gameplay: build what DESIGN.md describes.
// One start among many (a side view, a grid or a 3D look start from the blank game). Everything here is the engine's: extend it, do not rewrite it:
// a new key is engine.input.define(...), a talker engine.dialogue.define(...), a thing to use engine.interactions.add(object, ...); pixels: recipe 62 §4b; which modules take a sprite: recipe 13 §3d.
__TSL_IMPORT__
import { createEngine, presets, world, content, settings, collision, characters, followCamera, hud, interactions, dialogue, THREE } from 'threedog';
import { pixelSprite, spriteFrame } from 'threedog/pixel';
import { createPicture } from './picture/index.js';   // the game's own picture in plain three.js: gray for now; make it yours, recipe 62
import { placeholderSheet, SHEET } from './picture/sprites.js';   // a drawn placeholder sheet: replace with your art
import data from './content/index.js';
import packs from './assets.js';

// pixelSize: one art pixel = 3 screen pixels, at any display scale (recipe 62 4b). It owns the render size: no pixelRatio or adaptiveResolution next to it. Antialiasing is off by default then.
const engine = createEngine({ __RENDERER__bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: false, pixelSize: 3, ui: { loading: { title: '__NAME__' }, title: { title: '__NAME__' } }, saveKey: '__NAME__' });   // sounds are content: content/audio.js
// settings: Esc pauses and opens the menu; the antialias row is left out because it would blend the hard pixel edges. The view is orthographic and pixelSnap rounds the camera to the art grid (32 art pixels per meter)
const ARENA = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
engine.use(world(), content(), settings({ freezeWorld: true, sections: [{ id: 'graphics', omit: ['antialias'] }, 'audio', 'controls', 'language', 'saves'] }), collision(), characters({ fall: 'rescue' }),
  followCamera({ projection: 'orthographic', yaw: Math.PI / 4, pitch: 0.6, lockPitch: true, mouseLook: false, pixelSnap: { pixelsPerMeter: 32, bounds: ARENA } }),
  hud(), interactions({ ...presets.interactions.nearest }), dialogue());
engine.saves.autosave(0.5);   // minutes of play; the game's own state: engine.saves.define('game', { version: 1, save, load }), recipe 20
engine.use(createPicture());   // a picture module; to switch looks: engine.use(another(), { replaces: 'picture' })
const { picture } = engine;   // picture.materials: the game's materials by name
engine.assets.manifest(packs);   // assets.js: the models / sounds / textures content names

// ---- The level: a gray floor, plain three.js. engine.collision keeps the player inside the arena; engine.collision.addObject(mesh) makes a mesh solid.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), picture.materials.default); engine.scene.add(floor);
engine.collision.addBlocked((x, z) => x < ARENA.minX || x > ARENA.maxX || z < ARENA.minZ || z > ARENA.maxZ);

const grid = engine.cameraRig.pixelSnap.grid;   // the one art-pixel math (threedog/pixel); sprites and the camera share it
const { frameWidth, frameHeight, columns, rows } = SHEET;
/** @param {number} tone @param {'world' | 'followed'} snap */
const makeSprite = (tone, snap) => pixelSprite({ grid, material: placeholderSheet(tone), width: frameWidth, height: frameHeight, columns, rows, snap });

// ---- Dialogue: flags are part of the save. A talker is just a name; whatever calls engine.dialogue.start says it.
engine.dialogue.define('guide', {
  start: { text: 'Hello! Come back and talk to me again.', choices: [{ text: 'Will do', do: s => { s.flags.met = true; } }, { text: 'Later' }] },
});

// ---- An NPC (any pixelSprite, no character needed) and a thing to pick up: E near an object uses it. The shell counts into the HUD and is saved as gone.
const guide = makeSprite(0xb08060, 'world'); guide.position.set(3, 0, -2); engine.scene.add(guide);
engine.interactions.add(guide, { id: 'guide', label: 'Talk', onUse: () => engine.dialogue.start('guide') });
const shell = new THREE.Mesh(new THREE.SphereGeometry(0.25), picture.materials.default); shell.name = 'shell'; shell.position.set(-3, 0.25, 2); engine.scene.add(shell);
engine.interactions.add(shell, { id: 'shell-1', label: 'Pick up', once: true, counter: 'coins' });
engine.hud.addCounter('coins', { label: 'Coins', value: 0 });

// ---- The player: a character whose model is a pixelSprite. onPose picks the frame from the character's state each frame; the character's position stays exact (saves and physics read it).
const ROW = /** @type {Record<string, number>} */ ({ idle: 0, walk: 1, run: 1, jump: 2, fall: 2 });   // which row of the sheet is which state: your sheet's layout
const hero = makeSprite(0x9a9a9a, 'followed');   // 'followed': the one object the camera follows (recipe 62 4b)
const player = engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero, spawn: [0, 0, 0] });
// facing is an angle (radians around Y), not a left/right sign: mirror when the heading points to the screen's left
player.onPose(c => {
  const right = grid.axes().right, mirrored = Math.sin(c.facing) * right.x + Math.cos(c.facing) * right.z < 0;
  spriteFrame(hero, (ROW[c.state] ?? 0) * columns + Math.floor(engine.time.now('real') * 8) % columns, mirrored);
});
engine.content.load(data);   // content/ is the game's data (places, props, pickups); main.js holds rules

Object.assign(window, { engine, picture });   // tests, screenshots and the console all rely on it (before start, so the dev bridge can wait for it)
await engine.start();      // when start returns the modules are ready
