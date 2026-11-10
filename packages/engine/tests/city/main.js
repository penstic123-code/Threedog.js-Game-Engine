// City example: the same engine, a completely different game. No procedural terrain, no vegetation, all neutral fallback picture, top-down camera, hand-built block.
// The block is loaded with the level module: ground height, collision, spawn points and trigger zones are all read from the scene.
// The block's builder is registered in the asset manifest (name city-block) and the level reads it by name: after npm run bake it reads the baked file, during development it caches automatically;
// when switching to a Blender-exported glTF, change only this manifest line ('city-block': '/models/city.glb').
import { createEngine, presets, world, calendar, sky, collision, rigid, followCamera, characters, interactions, dialogue, level, triggers, particles, timeline, settings, debug, content, flow, THREE, toast } from '../../index.js';
import { neutralMaterial } from '../../render/neutral.js';
import { onTierChange } from '../../core/scene/tier.js';
import { runSections } from '../../core/base/sections.js';
import { writeDaylight } from '../../render/daylight.js';
import data from './content/index.js';

import { buildBlock } from './block.js';

// Route switch for the WebGL vs WebGPU perf comparison (threedog perf --only=pages --renderer=webgpu): ?renderer=webgpu loads threedog/tsl
// (it registers the WebGPU classes and node parts) and draws this same game on WebGPURenderer. Without the query nothing changes.
const gpuRoute = new URLSearchParams(location.search).get('renderer') === 'webgpu';
if (gpuRoute) await import('../../render/fx/index.js');
const engine = createEngine({ ...(gpuRoute && { renderer: 'webgpu' }), bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), ui: { loading: { title: '小城' } }, saveKey: 'city' });
engine.assets.manifest({ models: { 'city-block': buildBlock } });
engine.use(
  world(),   // world data: facts about NPCs such as the shopkeeper live here (changing level only tears down models)
  level({ url: 'city-block' }),
  calendar({ time: 0.45, dayLength: 360 }), sky(),   // NPC schedules follow the calendar: this page needs the day to pass
  collision(),
  rigid(),
  followCamera({ pitch: 1.0, distance: 26, minDistance: 14, maxDistance: 40, lockPitch: true }),
  characters({ npcs: true }),
  interactions({ ...presets.interactions.nearest }),
  dialogue(),
  triggers(),
  particles(),
  timeline(),
  settings(),
  debug(),
  content(),
  flow(),
);
engine.scene.fog = new THREE.Fog(0xcccccc, 66, 220);

// No style in this example, so the plaza trigger defines its own sparks (with a style, use its preset)
engine.particles.define('sparks', { max: 80, lifetime: [0.3, 0.7], speed: [2, 5], direction: [0, 1, 0], spread: 0.9, gravity: -6, size: [0.1, 0.03], color: [0xffffff, 0xaaaaaa], opacity: [1, 0] });

// Spawn and marker points exist only after the level loads (in start()): build the player, install content, place teleporters now
let player = null;
engine.events.once('level:loaded', () => {
  player = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: engine.level.spawn });
  // Content: shopkeeper (schedule, dialogue), plaza trigger zone, crate-push key
  engine.content.load(data);
  // Two teleporters (level markers marker_gate_a / marker_gate_b): press E to fade out -> move -> fade in (flow.transition)
  for (const [from, to] of [['marker_gate_a', 'marker_gate_b'], ['marker_gate_b', 'marker_gate_a']]) {
    const at = engine.level.marker(from).position;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.1, 16), neutralMaterial('prop', { color: 0x8090a0 }));
    pad.position.set(at.x, 0.05, at.z); engine.add(pad);
    engine.level.track(engine.interactions.add(pad, {
      label: '传送到另一个台子', radius: 2,
      onUse: () => engine.flow.transition(() => {
        const p = engine.level.marker(to).position;
        player.placeAt({ x: p.x, z: p.z + 2 });
        engine.cameraRig.follow(player.root);   // camera jumps straight over instead of flying from far away
      }, { autosave: false }),
    }));
    engine.level.track({ remove: () => engine.remove(pad) });
  }
});

// A pile of pushable crates, press F to push
engine.events.on('engine:ready', () => {
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), neutralMaterial('prop', { color: 0xb09070 }));
    m.position.set(4 + (i % 3) * 1.05, 0.5 + Math.floor(i / 3) * 1.05, -4);
    m.castShadow = m.receiveShadow = true;   // rigid bodies do not change the model's shadow settings; enable shadows yourself if wanted
    engine.rigid.addBox(m, { mass: 3 });
  }
  toast(engine, '俯视角 · 没有地形模块 · 没有游戏自己的 style');
});
engine.onFrame(() => {
  if (!player || !engine.input.pressed('kick')) return;
  const f = player.facing, dir = { x: Math.sin(f), z: Math.cos(f) };
  for (const b of engine.rigid.bodies) {
    const t = b.body.translation();
    if (Math.hypot(t.x - player.position.x, t.z - player.position.z) < 2.5) engine.rigid.impulse(b, [dir.x * 15, 6, dir.z * 15]);
  }
});

engine.start();
window.engine = engine;
window.internals = { onTierChange, runSections, writeDaylight };   // group-q.mjs reaches these engine internals through the page
