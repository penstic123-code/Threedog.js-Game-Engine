// Performance comparison page (used by packages/tools/perf.mjs and packages/engine/tests/specs/c.mjs). URL parameter mode:
//   native  plain three.js: N cubes (default 2000) + 1 directional-light shadow, renderer.render every frame
//   engine  the same scene inside createEngine (no modules installed), engine.step(1/60) every frame
//   world   openWorld fully on (no game content, with a player); times each module's fixed/frame/afterRender
//   props   3000 repeated props (lamp of 2 meshes, fence, crate, AC unit) placed through world.present + directional shadow; ?batch=0 turns engine.batching off
//   city    group C feature test: code-built block (7×7 buildings) + level + sky + weather + hlod + settings({ freezeWorld: true })
// window.bench.run(frames, { move }) → { cpuMs, renderMs, drawCalls, triangles, shadowRenders, shadowCalls, modules }
// Under software rendering (cloud swiftshader) GPU time counts as CPU time, so use the numbers only for relative comparison.
import * as THREE from 'three';
import { patchesOf } from '../../render/patches.js';
import { createEngine, presets, Character, characters, createTerrain, openWorld, world, interactions, dialogue, inventory, pickups, quests, timeline, triggers, particles, music,
  hud, level, calendar, sky, weather, water, terrain, hlod, settings, rampTexture, applyEffects, materialPatches, terrainMaterial, grids } from '../../index.js';
import { patchMaterial, copyPatches } from '../../render/patches.js';
import { SLOTS } from '../../render/slots.js';
import { injectUICSS } from '../../ui/theme.js';
import { toGLB } from '../../core/assets/Baked.js';
import { protoOf } from '../../core/assets/namedModel.js';
import { neutralMaterial } from '../../render/neutral.js';
import { isEngineMade } from '../../render/patches.js';
import { Assets } from '../../core/assets/Assets.js';
import { NOISE_GLSL } from '../../render/effects.js';
import worldScene from '../fixtures/world-scene/index.js';   // the world example's picture and art (mode world draws that scene)
import { models as sceneryModels, assets as sceneryArt } from '../../examples/world/art/index.js';
const worldModels = sceneryModels, worldArt = sceneryArt;   // the art tests read these models on the body
import * as postEffects from '@threedog/post-effects';
const { outline } = postEffects;
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { terrainPreset, riverAt } from '@threedog/terrain-noise';
import vegetationDefs from '../../examples/world/content/vegetation.js';

const q = new URLSearchParams(location.search), mode = q.get('mode') || 'engine', N = +(q.get('n') || 2000);
const canvas = document.getElementById('view');

function cubeScene(add) {
  const geo = new THREE.BoxGeometry(1, 1, 1), mat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a }), side = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set((i % side - side / 2) * 3, 0.5, (Math.floor(i / side) - side / 2) * 3);
    m.castShadow = m.receiveShadow = true; add(m);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat);
  ground.receiveShadow = true; add(ground);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(60, 120, 40); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 420 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
  add(sun); add(sun.target); add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
}
// A town-like block: one mesh per building (shared material); building b_0_0 has a simplified b_0_0_LOD1
function block() {
  const root = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: 0xc8c4bc });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(160, 1, 160), new THREE.MeshLambertMaterial({ color: 0x9a9a96 }));
  ground.name = 'ground'; ground.position.y = -0.5; root.add(ground);
  for (let gx = -3; gx <= 3; gx++) for (let gz = -3; gz <= 3; gz++) {
    const h = 6 + ((gx * 5 + gz * 3) & 7) * 3, b = new THREE.Mesh(new THREE.BoxGeometry(8, h, 8), mat);
    b.name = `b_${gx}_${gz}`; b.position.set(gx * 22, h / 2, gz * 22); b.castShadow = true; root.add(b);
  }
  const lod = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 8), mat);
  lod.name = 'b_0_0_LOD1'; lod.position.set(0, 3, 0); root.add(lod);
  const spawn = new THREE.Object3D(); spawn.name = 'spawn'; spawn.position.set(0, 0, 11); root.add(spawn);
  return root;
}
// A street-like scene: N repeated props over 4 models, each a world record presented as a clone of its model (how props / grid items / views place models)
function propsScene(engine) {
  engine.use(world());
  const mat = c => new THREE.MeshLambertMaterial({ color: c });
  const part = (geo, m, y) => { const p = new THREE.Mesh(geo, m); p.position.y = y; p.castShadow = p.receiveShadow = true; return p; };
  const lamp = new THREE.Group(); lamp.add(part(new THREE.CylinderGeometry(0.08, 0.1, 4, 6), mat(0x555555), 2),
    part(new THREE.BoxGeometry(0.5, 0.25, 0.5), mat(0xeeeecc), 4.1));
  const models = { lamp, fence: part(new THREE.BoxGeometry(2, 1, 0.1), mat(0x8a6a4a), 0.5),
    crate: part(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(0xa08050), 0.4),
    ac: part(new THREE.BoxGeometry(0.9, 0.6, 0.5), mat(0xcccccc), 0.3) };
  const names = Object.keys(models), side = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) engine.world.add({ kind: 'thing', model: names[i % 4],
    position: [(i % side - side / 2) * 2.6, 0, (Math.floor(i / side) - side / 2) * 2.6], rot: i * 0.7 }, { save: false });
  engine.world.present('thing', { radius: 1000, build: rec => { const o = models[rec.model].clone(); o.rotation.y = rec.rot; return o; } });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat(0x9a9a9a));
  ground.receiveShadow = true; engine.add(ground);
  const sun = engine.lights.sun;
  sun.position.set(60, 120, 40); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 420 }); sun.shadow.camera.updateProjectionMatrix();
  aim(engine.camera);
}
const aim = cam => { cam.position.set(0, 60, 90); cam.lookAt(0, 0, 0); };

// Shadow counting: wraps shadowMap.render to record how many real updates ran and how many shadow draw calls were made
function shadowCounter(renderer) {
  const sm = renderer.shadowMap, orig = sm.render.bind(sm), c = { renders: 0, calls: 0 };
  sm.render = (...a) => {
    const on = sm.enabled && (sm.autoUpdate || sm.needsUpdate), b = renderer.info.render.calls;
    orig(...a);
    if (on) { c.renders++; c.calls += renderer.info.render.calls - b; }
  };
  return c;
}
const r2 = v => Math.round(v * 100) / 100;

let bench;
if (mode === 'native') {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8c8c8c);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 1500); aim(camera);
  cubeScene(o => scene.add(o));
  const sc = shadowCounter(renderer);
  bench = {
    run(frames) {
      renderer.render(scene, camera);   // warm-up (compiles shaders)
      sc.renders = sc.calls = 0;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) renderer.render(scene, camera);
      const ms = (performance.now() - t0) / frames;
      return { cpuMs: r2(ms), renderMs: r2(ms), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, shadowRenders: sc.renders,
        shadowCalls: Math.round(sc.calls / Math.max(1, sc.renders)) };
    },
  };
  window.engine = { ready: true };   // "ready" signal for the test scripts
} else {
  const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory, ...presets.bindings.quests }, canvas,
    batching: q.get('batch') === '0' ? false : undefined,
    headless: mode !== 'city', ui: { loading: false }, pixelRatio: 1, adaptiveResolution: false,
    saveKey: 'perf-' + mode });
  if (mode === 'city') {
    engine.use(level({ scene: block() }), calendar({ time: 0.45, dayLength: 360 }), sky(), weather(presets.weather.temperate), hlod(),
      settings({ freezeWorld: true, storageKey: 'perf-city-settings' }));
    aim(engine.camera);
  } else if (mode === 'world') {
    // Same seed, flat area and vegetation as the open-world example, but no game content such as NPCs or quests
    const T = createTerrain({ seed: 1337, ...terrainPreset() });
    let home = { x: 0, z: 0 };
    for (let r = 0; r < 3000; r += 10) {
      const a = r * 0.37, x = Math.cos(a) * r, z = Math.sin(a) * r, h = T.surface(x, z);
      if (h > 4 && h < 10 && T.slope(x, z) < 0.2 && riverAt(x, z, T.noise) === 0) { home = { x, z }; break; }
    }
    const { config: worldGround, ...worldColors } = worldScene.terrain ?? {};   // the world example's ground, colors are terrain options
    const mods = openWorld({ camera: 'follow', seed: 1337, terrain: { ...terrainPreset(), ...worldGround, ...worldColors, ...(q.get('shading') && { shading: q.get('shading') }) }, flatten: [{ x: home.x, z: home.z, radius: 22 }], time: 0.3, dayLength: 360,
      weather: presets.weather.temperate, debug: false, ambience: false });
    // The preset only builds the world; add back the gameplay modules it used to bundle so timings stay comparable with earlier runs (music stays off)
    engine.use(mods, interactions({ ...presets.interactions.nearest }), dialogue(), inventory(), pickups(),
      quests(), timeline(), triggers(), particles(), hud());
    // the world example's picture as plain writes, without its bloom (perf measures the scene)
    engine.renderer.toneMapping = THREE.ACESFilmicToneMapping; engine.renderer.toneMappingExposure = worldScene.exposure;
    engine.uniforms.uCloudShadow.value = worldScene.clouds.shadow;
    const { clouds: worldClouds, ...worldSky } = worldScene.sky;
    engine.pickups.material = new THREE.MeshLambertMaterial({ flatShading: true, emissive: 0x403418 });
    skyLayers(engine, { ...worldSky, clouds: Object.fromEntries(Object.entries(worldClouds).filter(([k]) => k !== 'kind')) });
    const geo = m => [].concat(m).length > 1 ? worldModels[m[0]](...m.slice(1)) : worldModels[m]();
    for (const [name, v] of Object.entries(vegetationDefs)) {
      const { model, lod, ...rest } = v;
      engine.vegetation.define(name, { geometry: geo(model), lodGeometry: lod ? geo(lod) : undefined, ...rest });
    }
    engine.assets.manifest(worldArt);
    engine.characters.addPlayer({ ...presets.player.thirdPerson, model: 'humanoid', spawn: { x: home.x + 4, z: home.z + 7 } });
  } else if (mode === 'props') {
    propsScene(engine);
  } else {
    cubeScene(o => engine.add(o));
    aim(engine.camera);
  }
  // Time rendering separately
  const render = engine._render.bind(engine);
  let renderMs = 0;
  engine._render = dt => { const t0 = performance.now(); render(dt); renderMs += performance.now() - t0; };
  const sc = shadowCounter(engine.renderer);
  // Does what one real-time loop frame (Engine._loop) does: 1 fixed step + frame hooks + render + budget sampling + afterRender (step() also runs describe once
  // more)
  const DT = 1 / 60;
  const frame = () => {
    engine.input.poll(DT); engine._fixedStep(); engine._frameHooks(DT); engine._render(DT);
    engine.budget.sample(DT); engine.input.endFrame();
    engine._runHooks('afterRender', DT);
  };
  bench = {
    /** Run frames frames (per frame: 1 fixed step + 1 frame hook pass + render); with move the player walks forward automatically (m/s) */
    run(frames, { move = 0 } = {}) {
      engine.haltLoop();
      frame();   // warm-up
      const timing = engine.profile() !== null;   // dev builds time modules all along: put it back as it was
      engine.profile(true);   // time module hooks afresh
      renderMs = 0; sc.renders = sc.calls = 0;
      engine.input.autopilot = move ? { x: 0, y: 1, speed: move } : null;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) frame();
      const ms = (performance.now() - t0) / frames;
      engine.input.autopilot = null;
      const modules = Object.fromEntries(Object.entries(engine.profile()).map(([k, p]) => [k, p.mean]));   // the run's average per frame
      if (!timing) engine.profile(false);
      const info = engine.renderer.info.render;
      return { cpuMs: r2(ms), renderMs: r2(renderMs / frames), drawCalls: info.calls, triangles: info.triangles, shadowRenders: sc.renders,
        shadowCalls: Math.round(sc.calls / Math.max(1, sc.renders)), modules };
    },
    /**
     * Stream into a new area in the real-time loop (workers answer between frames, like in play): put the player dist meters away and watch for
     * seconds. Returns the cost of each stage (engine.budget.cost), the frame CPU time (engine._cpuMs, per phase for the worst frame) and how many
     * chunks were loaded, so one number per stage is reproducible.
     */
    async streamIn(dist = 700, seconds = 12) {
      const T = engine.terrain, cost = engine.budget.cost, pl = engine.player.root.position;
      engine.haltLoop();
      for (let i = 0; i < 20; i++) engine.step(1 / 30, { describe: false });
      engine.player.placeAt({ x: pl.x + dist, z: pl.z });
      cost.reset();
      let frames = 0, sum = 0, worst = 0, worstPhases = null, last = -1;
      engine._unhalt();
      const t0 = performance.now();
      await new Promise(res => {
        const poll = () => {
          if (engine._cpuMs !== last) {   // one new real-time frame
            last = engine._cpuMs; frames++; sum += last;
            if (last > worst) { worst = last; worstPhases = { ...engine._cpuPhases }; }
          }
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(poll); else res();
        };
        requestAnimationFrame(poll);
      });
      engine.haltLoop();
      const ph = {}; for (const k in worstPhases) ph[k] = r2(worstPhases[k]);
      return { seconds, frames, cpuAvg: r2(sum / Math.max(1, frames)), cpuMax: r2(worst), worstPhases: ph, chunks: T.chunks.size, cost: cost.report() };
    },
  };
  engine.start();
}
window.bench = bench;
// a fake engine's assets for specs that build materials without an engine: the given texture() plus the real useTexture on top of it
const fakeAssets = texture => ({ texture, useTexture: Assets.prototype.useTexture });
// a real headless engine for specs that test applyEffects / terrainMaterial. assets: e.g. fakeAssets(texture), or null for "no asset loader"
const engineWith = (_, assets) => {
  const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'engine-with-' + performance.now() });
  if (assets !== undefined) e.assets = assets;
  return e;
};
// what a test wants of the sky: the dome layers
function skyLayers(e, { layers = [] } = {}) {
  layers.forEach((l, i) => e.sky.layer(l.name ?? `layer${i}`, l));
  return e;
}
import * as tsl from 'three/tsl';   // scene.fogNode = tsl.fog(...) for the fog readers (tests/specs/group-p5.mjs)
window.threedogTest = { tsl, THREE, patchesOf, skyLayers, fakeAssets, engineWith, Character, characters, protoOf, neutralMaterial, isEngineMade, rampTexture, toGLB, applyEffects, patchMaterial, materialPatches, SLOTS, terrainMaterial, copyPatches, createEngine,
  injectUICSS, NOISE_GLSL, createTerrain, worldScene, worldArt, worldModels, sky, calendar, postEffects, outline, ShaderPass, CopyShader, water, weather, terrain, Reflector, world, grids, particles, pickups, triggers, music };   // packages/engine/tests/specs/c.mjs bake round-trip test uses it
