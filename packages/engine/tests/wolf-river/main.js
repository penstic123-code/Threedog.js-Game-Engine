// Shared acceptance scene: a body that is not a human. Ordinary game code on the public API only: a four-legged animal by a curved river, a choice asked in a speech bubble,
// a quest format of the game's. tests/specs/wolf-river.mjs plays it. No art: the animal is boxes on a skeleton built here.
import { createEngine, presets, world, sky, collision, followCamera, characters, rigid, content, dialogue, quests, terrain, Character, THREE } from '../../index.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// a skeleton with no human bone names: Rump -> Back -> Withers -> Nape -> Skull, a tail, four legs of two parts and a paw. Faces +z, feet at y = 0
const LAYOUT = {
  Rump: [null, 0, 0.7, -0.5], Back: ['Rump', 0, 0, 0.45], Withers: ['Back', 0, 0.03, 0.45], Nape: ['Withers', 0, 0.12, 0.3], Skull: ['Nape', 0, 0.1, 0.22], Snout: ['Skull', 0, -0.02, 0.22],
  Tail1: ['Rump', 0, 0.02, -0.2], Tail2: ['Tail1', 0, -0.06, -0.3], Tail3: ['Tail2', 0, -0.08, -0.25],
  ...Object.fromEntries(['F', 'H'].flatMap(end => ['L', 'R'].flatMap(s => {
    const x = s === 'L' ? 0.16 : -0.16, top = end === 'F' ? 'Withers' : 'Rump', dz = end === 'F' ? 0 : 0.05;
    return [[`${end}Thigh${s}`, [top, x, -0.08, dz]], [`${end}Shank${s}`, [`${end}Thigh${s}`, 0, -0.3, 0]], [`${end}Paw${s}`, [`${end}Shank${s}`, 0, -0.3, 0]]];
  }))),
};

/** Boxes along each bone, each skinned fully to that bone: enough for the engine to measure real thickness */
function makeAnimal() {
  const names = Object.keys(LAYOUT), bones = names.map(n => { const b = new THREE.Bone(); b.name = n; return b; }), at = n => bones[names.indexOf(n)];
  names.forEach((n, i) => { const [parent, x, y, z] = LAYOUT[n]; bones[i].position.set(x, y, z); if (parent) at(parent).add(bones[i]); });
  bones[0].updateMatrixWorld(true);
  const pieces = [];
  names.forEach((n, i) => {
    const kid = bones[i].children.find(c => c.isBone), from = bones[i].getWorldPosition(new THREE.Vector3());
    const to = kid ? kid.getWorldPosition(new THREE.Vector3()) : from.clone().add(new THREE.Vector3(0, -0.08, 0.05));
    const len = from.distanceTo(to), thick = /Thigh|Shank|Paw|Tail/.test(n) ? 0.07 : 0.16;
    const g = new THREE.BoxGeometry(thick, len, thick).translate(0, len / 2, 0).applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()))).translate(from.x, from.y, from.z);
    const count = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count).fill(0).flatMap(() => [i, 0, 0, 0]), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    pieces.push(g);
  });
  const mesh = new THREE.SkinnedMesh(mergeGeometries(pieces), new THREE.MeshStandardMaterial({ color: 0x777777 }));
  const model = new THREE.Group(); model.name = 'animal'; model.add(bones[0], mesh);
  mesh.bind(new THREE.Skeleton(bones));
  return model;
}

/** The game's data for its parts: a graph, not a human */
const leg = (end, s) => ({ [`thigh${end}${s}`]: { bone: `${end}Thigh${s}`, parent: end === 'F' ? 'chest' : 'hips', kind: 'leg', mass: 3 }, [`shank${end}${s}`]: { bone: `${end}Shank${s}`, parent: `thigh${end}${s}`, kind: 'leg', mass: 2, limits: { bend: [-1.6, 0.1], side: [-0.1, 0.1], twist: [-0.1, 0.1] } } });
const ANIMAL = {
  hips: { bone: 'Rump', mass: 12 }, chest: { bone: 'Withers', parent: 'hips', mass: 14 }, head: { bone: 'Skull', parent: 'chest', mass: 5 },
  tail: { bone: 'Tail1', parent: 'hips', mass: 1, limits: { bend: [-1, 1], side: [-1, 1] } },
  ...leg('F', 'L'), ...leg('F', 'R'), ...leg('H', 'L'), ...leg('H', 'R'),
};

// the river: a curve through the terrain, the bed carved below the water, a ribbon the game draws itself
const LEVEL = -0.4, HALF = 4, riverX = z => 12 * Math.sin(z * 0.1);
const away = (x, z) => Math.abs(x - riverX(z));
// terrain runs this in a worker, so it carries its own numbers
const height = (x, z) => { const d = Math.abs(x - 12 * Math.sin(z * 0.1)); return d >= 6 ? 0.5 : 0.5 - 3.5 * (1 - d / 6); };
const river = (x, z) => (away(x, z) < HALF ? LEVEL : null);
function ribbon() {
  const at = [], index = [], N = 60;
  for (let i = 0; i <= N; i++) { const z = -60 + i * 2; at.push(riverX(z) - HALF, LEVEL, z, riverX(z) + HALF, LEVEL, z); if (i < N) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  const m = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(at, 3)).setIndex(index), new THREE.MeshStandardMaterial({ color: 0x5a6a7a, side: THREE.DoubleSide }));
  m.name = 'river'; return m;
}

// a hunt log in place of the quests module: prey to find, no steps. The module that holds 'quests' owns the content section and what it means; quests.contract.js says what else stays true
const huntLog = () => {
  let e = null;
  const hunts = new Map();
  const log = {
    define(id, q) { hunts.set(id, { ...q, id, done: false, active: false }); },
    start(id) { hunts.get(id).active = true; e.events.emit('quest:start', { id }); },
    advance(id) { const h = hunts.get(id); h.active = false; h.done = true; e.events.emit('quest:step', { id }); e.events.emit('quest:done', { id }); },
    state(id) { const h = hunts.get(id); return h ? { step: h.done ? 1 : 0, steps: 1, done: h.done, failed: false, active: h.active } : null; },
    list: () => [...hunts.values()].map(h => ({ id: h.id, title: h.prey, done: h.done })),
  };
  return {
    name: 'huntLog', type: 'rules', provides: ['quests'], label: 'Hunt log',
    content: { quests: {
      validate(d) { for (const [id, q] of Object.entries(d)) if (!q.prey) throw new Error(`hunt ${id}: name the prey`); },
      commit(d) { for (const [id, q] of Object.entries(d)) log.define(id, q); },
    } },
    install(engine, ctx) {
      e = engine;
      ctx.saves.define('quests', { version: 3, save: () => ({ state: Object.fromEntries(hunts) }), load: d => { hunts.clear(); for (const [k, v] of Object.entries(d.state ?? {})) if (v.prey) hunts.set(k, v); } });
      return log;
    },
    describe: () => ({ hunts: hunts.size }),
  };
};

const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk }, canvas: document.getElementById('view'), ui: { loading: false }, adaptiveResolution: false, saveKey: 'test-wolf-river', urlState: false });
engine.use(world(), sky({ time: 0.45 }), terrain({ height, viewChunks: 2 }), collision(), followCamera({ distance: 5, pitch: 0.25, height: 1 }), characters({ npcs: false }), rigid(), content(), dialogue({ bubbleChoice: 'ask' }), quests());
engine.assets.manifest({ name: 'wolf-river', models: { animal: makeAnimal, stone: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 })) } });
engine.mod('ragdoll.graph', { owner: 'game', set: ANIMAL });   // no id: every body here, a copy with no character too

const game = window.game = { THREE, riverX, LEVEL, HALF, huntLog, ANIMAL, Character };

engine.events.on('engine:ready', async () => {
  const water = ribbon(); engine.scene.add(water);
  game.river = engine.addWaterBody({ query: river, bounds: { min: { x: -14, y: -9, z: -60 }, max: { x: 14, y: 9, z: 60 } }, mesh: water });
  engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 20, z: 0 }, model: await engine.assets.model('animal') });
  window.ready = true;
});
engine.start();
