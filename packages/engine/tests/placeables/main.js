// Test page: open world + content templates (saveable placeables, one with stages) + particles. Playwright inspects it through window.engine.
import { createEngine, presets, openWorld, interactions, content, particles, THREE } from '../../index.js';
import { models as M, assets } from '../../examples/world/art/index.js';
import { terrainPreset } from '@threedog/terrain-noise';
import { bloom } from '@threedog/post-effects';

localStorage.clear();
const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), ui: { loading: false }, saveKey: 'placetest' });
engine.use(openWorld({ camera: 'follow', terrain: { seed: 1337, ...terrainPreset() }, calendar: { time: 0.4, dayLength: 360, seasons: ['wet', 'dry'], daysPerSeason: 28 }, debug: false, ambience: false }), interactions({ ...presets.interactions.nearest }), content(), particles());   // the preset only builds the world; gameplay modules are installed separately
engine.vegetation.define('松树', {
  geometry: M.pine(), lodGeometry: M.pineLow(),
  rule: { perChunk: 130, minHeight: 1.6, maxHeight: 40, maxSlope: 0.6, cluster: 'forest', scale: [0.75, 1.6], stretch: [0.85, 1.2], sink: 0.15,
    biomes: { forest: 1, meadow: 0.35, snow: 0.6, wetland: 0.3, riverbank: 0.3 }, collider: 0.35 },
  wind: 0.022,
});
engine.vegetation.define('石头', { geometry: M.rock(), rule: { perChunk: 14, chance: 0.6, minHeight: 0.5, maxHeight: 70, maxSlope: 2, scale: [0.4, 1.6], collider: 0.6 }, maxRing: 3 });
engine.assets.manifest(assets);   // template models are asset names (rock, pine)
engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 } });

// a placeable with stages (grows over game time) and an interaction that is an op
engine.ops.define('sapling.water', { run: (e, { id }) => e.world.set(id, { watered: true }) });
engine.content.load({
  templates: {
    sapling: {
      model: 'rock', state: { watered: false },
      stages: [{ name: 'seed', duration: 2, scale: 0.2 }, { name: 'sapling', duration: 2, scale: 0.5 }, { name: 'tree', model: 'pine' }],
      interact: { label: 'Water', op: 'sapling.water' },
    },
  },
});
engine.post.add(bloom(), { name: 'bloom', slot: 'hdr' });   // a game's picture/ code adds its effects; the tier and settings tests read this one
engine.particles.define('dust', { max: 200, lifetime: [0.4, 0.8] });
engine.particles.define('smoke', { max: 200, lifetime: [0.5, 1], gravity: 1, rate: 40 });

window.engine = engine; window.THREE = THREE;
window.errors = [];
engine.start();
