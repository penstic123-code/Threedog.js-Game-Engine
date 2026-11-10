// Open-world example (slow photography life): riverside cabin + an old fisherman who walks by the clock + pickups, quests, weather, photos, saves.
// This file only holds rules: installing engine modules, computing place coordinates, handing content/ to the engine, ops and presentation.
// The level is content: the cabin, props, physics props, items, NPCs, dialogues, quests and vegetation all live in content/ (rule R33).
import { createEngine, openWorld, presets, content, interactions, dialogue, inventory, pickups, quests, photo, timeline, triggers, particles, music, hud, createTerrain, toast } from '../../index.js';
import { createPicture } from './picture/index.js';   // the whole picture, plain three.js; the art (procedural trees, rocks, the humanoid body, art/) is registered from assets.js
import packs from './assets.js';
import { terrainPreset, riverAt, terrainStrings } from '@threedog/terrain-noise';   // optional package: the terrain generator (world shape, not a picture)
import data from './content/index.js';
import { TERRAIN } from './picture/palette.js';
import { BODIES } from './models.js';

// ---------- 0. Pick a flat spot as home ----------
// Preview the terrain with the same seed, find a good spot, then tell the engine to flatten it
const SEED = 1337;
const preview = createTerrain({ seed: SEED, ...terrainPreset() });
let home = { x: 0, z: 0 };
for (let r = 0; r < 3000; r += 10) {
  const a = r * 0.37, x = Math.cos(a) * r, z = Math.sin(a) * r, h = preview.surface(x, z);
  if (h > 4 && h < 10 && preview.slope(x, z) < 0.2 && riverAt(x, z, preview.noise) === 0) { home = { x, z }; break; }
}

// core + open-world preset (world and environment: terrain, vegetation, sky, weather, water, collision, physics, camera, characters, ambience, settings, debug) + the gameplay modules this game needs
// Route switch for the WebGL vs WebGPU perf comparison (threedog perf --only=pages --renderer=webgpu): ?renderer=webgpu loads threedog/tsl
// (it registers the WebGPU classes and node parts) and draws this same game on WebGPURenderer. Without the query nothing changes.
const gpuRoute = new URLSearchParams(location.search).get('renderer') === 'webgpu';
if (gpuRoute) await import('../../render/fx/index.js');
const engine = createEngine({ ...(gpuRoute && { renderer: 'webgpu' }), bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory, ...presets.bindings.quests, ...presets.bindings.photo, ...presets.bindings.debug, ...presets.bindings.dialogNumbers, ...presets.bindings.cutsceneSkip }, canvas: document.getElementById('view'), lights: false, strings: terrainStrings, ui: { loading: { title: '慢慢走' } } });
// opt-in presets: four seasons and temperate weather (the engine assumes neither)
engine.use(openWorld({ camera: 'follow', seed: SEED, terrain: { ...terrainPreset(), ...TERRAIN }, flatten: [{ x: home.x, z: home.z, radius: 22 }], time: 0.3, autoWeather: true, calendar: presets.calendar.fourSeasons, weather: presets.weather.temperate }),
  interactions({ ...presets.interactions.nearest }), dialogue(), inventory(), pickups(), quests(), photo(), timeline(), triggers(), particles(), music({ duckDialogue: 0.35 }), hud(),   // gameplay modules: not in the preset, this game uses them all
  content());
const picture = createPicture(engine);

// ---------- 1. Places: nearest riverside to the cabin (fisherman goes there in the morning, barrel floats there) ----------
let river = { x: home.x + 30, z: home.z }, waterSpot = { x: home.x + 34, z: home.z };
search: for (let r = 10; r < 400; r += 4) {
  for (let a = 0; a < 6.28; a += 0.3) {
    const x = home.x + Math.cos(a) * r, z = home.z + Math.sin(a) * r;
    if (engine.surface(x, z) < engine.waterLevel - 1.2) { river = { x: home.x + Math.cos(a) * (r - 8), z: home.z + Math.sin(a) * (r - 8) }; waterSpot = { x, z }; break search; }
  }
}

// ---------- 2. Cabin: placed by content/props.js (template 'cabin'); its model is built in code and registered by name ----------
engine.assets.manifest(packs);   // assets.js: this game's procedural trees / rocks / flowers (art/) and its cabin
// Presentation that follows the clock: chimney smoke while the cabin's model is built, doorway lamp on 18:00-06:00
// (sky.between re-aligns after start, load, applying a scenario, or rewinding time)
let smoke = null, smokeOn = null;
engine.calendar.between('18:00', '06:00', { on: () => picture.doorLamp(true), off: () => picture.doorLamp(false) });
engine.onFrame(() => {
  const view = engine.world.view('cabin');
  if (smokeOn !== view) { smoke?.remove(); smoke = view && engine.particles.attach('smoke', view.getObjectByName('chimney')); smokeOn = view; }
});

// ---------- 3. Player + content (vegetation, items, pickups, NPCs, dialogues, quests, key actions, templates, props, physics props, custom conditions) ----------
engine.characters.addPlayer({ ...presets.player.thirdPerson, model: 'humanoid', spawn: { x: home.x + 4, z: home.z + 7 } });   // body: the humanoid asset from art/
// Impostor comparison (threedog perf --only=pages --renderer=webgpu --impostor): ?impostor draws the trees that have a low-poly as baked cards instead
const cards = new URLSearchParams(location.search).has('impostor');
const veg = cards ? Object.fromEntries(Object.entries(/** @type {Record<string, any>} */ (data.vegetation)).map(([n, { lod, ...v }]) => [n, lod ? { ...v, impostor: true } : data.vegetation[n]])) : data.vegetation;
engine.content.load({ ...data, vegetation: veg }, { places: { home, river, water: waterSpot } });   // content names models only; the asset packs above resolve them

// Show the film count at the top left (hud counter)
const showFilm = () => engine.hud.addCounter('film', { icon: '🎞', label: '胶卷', value: engine.inventory.count('film') });
for (const ev of ['item:add', 'item:remove', 'save:loaded']) engine.events.on(ev, showFilm);
showFilm();

// Barter: the fisher's basket (content/containers.js) sells goods for film. An op, so the dialogue choice, the dev bridge and scenario tests share one rule
const PRICE = { berry: 1, feather: 2 };   // film per item
engine.ops.define('barter.buy', {
  desc: 'Buy from a basket, paying in film', args: { shop: 'string', item: 'string' },
  can(e, { shop, item }, ctx) {
    if (!e.inventory.container(shop).has(item)) return 'soldOut';
    return e.inventory.container(ctx.actor).has('film', PRICE[item] ?? 1) ? true : 'noFilm';
  },
  run(e, { shop, item }, ctx) {
    const got = e.inventory.transfer(shop, ctx.actor, item, 1);
    e.inventory.transfer(ctx.actor, shop, 'film', (PRICE[item] ?? 1) * got);
    return got;
  },
  offers: () => Object.keys(PRICE).map(item => ({ shop: 'fisher-basket', item })),
  reasons: { soldOut: 'The basket has none left', noFilm: 'Not enough film' },
});

// ---------- 4. Photos: use film; evening shots count toward quest progress; album strip ----------
engine.photo.canTake = () => engine.inventory.has('film') || 'noFilm';   // the op photo.take's can: no film, no photo (the P key runs the op)
engine.events.on('photo:denied', () => toast(engine, '没有胶卷了'));
engine.events.on('photo:taken', () => {
  engine.inventory.remove('film');
  const t = engine.calendar.timeOfDay;
  if (t > 17 / 24 && t < 19 / 24) engine.vars.bump('sunsetPhotos');
});
const strip = document.getElementById('strip');
engine.events.on('photo:taken', shot => {
  const img = new Image(); img.src = shot.url; img.alt = `${shot.time} 拍摄`; img.title = shot.time;
  img.onclick = () => { /** @type {HTMLImageElement} */ (document.getElementById('viewerImg')).src = shot.url; document.getElementById('viewer').hidden = false; };
  strip.prepend(img);
  while (strip.children.length > 8) strip.lastChild.remove();
  const fl = document.getElementById('flash'); fl.style.transition = 'none'; fl.style.opacity = '0.8';
  requestAnimationFrame(() => { fl.style.transition = ''; fl.style.opacity = '0'; });
});
document.getElementById('shoot').onclick = () => { if (!engine.ops.run('photo.take').ok) toast(engine, '没有胶卷了'); };
document.getElementById('viewerClose').onclick = () => { document.getElementById('viewer').hidden = true; };

// ---------- 5. Save / load (keys in content/actions.js) ----------
engine.onFrame(() => {
  if (engine.input.pressed('save')) { engine.saves.save('slot1').then(ok => { if (ok) toast(engine, '已存档'); }); }   // on false the engine already said why
  if (engine.input.pressed('load')) engine.saves.load('slot1').then(ok => toast(engine, ok ? '已读档' : '还没有存档'));
});
engine.saves.autosave(3);

// ---------- 6. Real physics: crates, a ball and a barrel floating by the river (placed in content/bodies.js); press F to push/kick ----------
// The records come from content; this presenter gives each one a mesh and a rigid body while it is near. positionFrom 'view': the body moves
// the mesh and the record follows, so a pushed crate's position is saved. Physics is ready at engine:ready, so the presenter is registered then.
engine.events.on('engine:ready', () => {
  if (!engine.rigid?.ready) return;
  engine.world.present('body', {
    positionFrom: 'view',
    build(rec) {
      const [mesh, add, opts] = BODIES[rec.shape]();
      mesh.position.copy(rec.position);
      mesh.castShadow = mesh.receiveShadow = true;   // rigid bodies do not change the model's shadow settings
      mesh.userData.body = engine.rigid[add](mesh, { ...opts, id: rec.id });   // id: the save keeps its rotation and velocity, not only the position
      return mesh;
    },
    dispose(rec, mesh) { if (engine.rigid.world) mesh.userData.body?.remove(); engine.remove(mesh); },   // after engine.dispose the physics world is already gone
  });
});
engine.onFrame(() => {
  if (!engine.rigid?.ready || !engine.input.pressed('kick')) return;
  const p = engine.player.position, f = engine.player.facing;
  const dir = { x: Math.sin(f), z: Math.cos(f) };
  let best = null, bestD = 2.6;
  for (const b of engine.rigid.bodies) {
    const t = b.body.translation(), d = Math.hypot(t.x - p.x, t.z - p.z);
    if (d < bestD && (t.x - p.x) * dir.x + (t.z - p.z) * dir.z > 0) { best = b; bestD = d; }
  }
  if (best) { const m = best.body.mass(); engine.rigid.impulse(best, [dir.x * 6 * m, 2.5 * m, dir.z * 6 * m]); }
});

// ---------- 7. Chop trees (world-change record: chopped trees are saved and regrow after 2 minutes) ----------
// An op, so the key, the dev bridge and tests share it and the wood lands in a fixed step, not a frame callback
const nearTree = (e, ctx) => {
  const p = e.actorPosition(ctx.actor);
  return p && (e.vegetation.instanceAt(p, { radius: 2.5, species: '松树' }) || e.vegetation.instanceAt(p, { radius: 2.5, species: '圆树' }));
};
engine.ops.define('tree.chop', {
  desc: 'Chop the nearest tree for wood',
  can: (e, a, ctx) => nearTree(e, ctx) ? true : 'noTree',
  run(e, a, ctx) {
    const tree = nearTree(e, ctx);
    e.vegetation.removeInstance(tree.species, tree.cx, tree.cz, tree.id, { regrowSeconds: 120 });
    e.particles.emit('leaves', { x: tree.position.x, y: tree.position.y + 3, z: tree.position.z }, { count: 30 });
    e.inventory.of(ctx.actor).add('wood', 2);
  },
  reasons: { noTree: 'No tree within 2.5 m' },
});
engine.onFixed(() => {
  if (engine.input.pressed('chop') && !engine.ops.run('tree.chop', {}, { source: 'player' }).ok) toast(engine, '附近没有树');
});
// Landing dust
engine.events.on('character:land', ({ character, impact }) => {
  if (impact > 4) engine.particles.emit('dust', character.position, { count: Math.min(40, Math.round(impact * 4)) });
});

// ---------- 8. Intro camera (circles the cabin, Esc skips) ----------
engine.events.on('engine:ready', () => {
  const h = engine.surface(home.x, home.z);
  engine.timeline.play([
    { camera: { to: { position: [home.x + 30, h + 18, home.z + 30], lookAt: [home.x, h + 2, home.z] }, duration: 0.01 } },
    { camera: { to: { position: [home.x - 20, h + 10, home.z + 25], lookAt: [home.x, h + 2, home.z] }, duration: 5, ease: 'inOutSine' } },
    { camera: { release: true } },
  ], { letterbox: true });
});

engine.start();
Object.assign(window, { engine, worldTest: { picture } });   // the console and the tests: engine, and the picture's own lights
