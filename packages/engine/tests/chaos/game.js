// The composite game the chaos driver plays: one small world built only through the public API, with every system the driver touches in it at once, because
// the bugs worth finding sit between systems. Level, player, NPCs, a car, templates with bodies, solid and tilted props, content, inventory, quests, a
// camera with shots, post effects, particles, weather and sky. Everything is code-built, so no run waits on a file.
import { createEngine, presets, THREE, world, content, sky, weather, collision, rigid, followCamera, characters, inventory, pickups, quests, triggers, particles, interactions, dialogue, timeline } from '../../index.js';
import { level } from '../../modules/level/index.js';
import { nav } from '../../modules/nav/index.js';
import { bloom, grain } from '@threedog/post-effects';

const grey = c => new THREE.MeshLambertMaterial({ color: c });

/** One level; n picks the layout, so swapping levels moves what navigation and collision must know */
export function levelScene(n = 0) {
  const root = new THREE.Group(); root.name = `chaos-level-${n}`;
  const size = 60 + n * 10, mat = grey(0x8a8a8a);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat); floor.name = 'floor'; root.add(floor);
  const wall = (name, x, z, w, d, rot = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), mat); m.name = name; m.position.set(x, 1.5, z); m.rotation.y = rot; root.add(m); };
  wall('col_wall_a', 8 + n * 3, 0, 1, 16);
  wall('col_wall_b', -6, 9 - n * 4, 14, 1, 0.5);
  const spawn = new THREE.Object3D(); spawn.name = 'spawn'; root.add(spawn);
  return root;
}

/** Wheeled car on the rigid module that holds the slot now: the driver calls it again after a swap, as a game would rebuild its car */
export function makeCar(E) {
  const g = new THREE.Group(); g.name = 'chaos-car';
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), grey(0x666666)); body.position.y = 0.3; g.add(body);
  const wheels = [[-0.85, 1.2, true, false], [0.85, 1.2, true, false], [-0.85, -1.2, false, true], [0.85, -1.2, false, true]].map(([x, z, steer, drive]) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 10).rotateZ(Math.PI / 2), grey(0x333333)); w.position.set(x, 0, z); g.add(w);
    return { position: [x, 0, z], radius: 0.35, steer, drive, object: w };
  });
  g.position.set(-14, 1, -14);
  E.scene.add(g);
  return E.rigid.addWheeled(g, { id: 'chaos-car', wheels, seats: 2, mass: 600 });
}

/** A skinned body the driver can throw limp. Two bones, so its ragdoll graph is game data like any non-human body */
function makeRig() {
  const bones = [new THREE.Bone(), new THREE.Bone()]; bones[0].name = 'hip'; bones[1].name = 'top'; bones[1].position.y = 0.9; bones[0].add(bones[1]);
  const geo = new THREE.BoxGeometry(0.4, 1.8, 0.4, 1, 2, 1).translate(0, 0.9, 0), n = geo.attributes.position.count, idx = [], wts = [];
  for (let i = 0; i < n; i++) { idx.push(geo.attributes.position.getY(i) > 1 ? 1 : 0, 0, 0, 0); wts.push(1, 0, 0, 0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const mesh = new THREE.SkinnedMesh(geo, grey(0x999999)); mesh.add(bones[0]); mesh.bind(new THREE.Skeleton(bones));
  const g = new THREE.Group(); g.add(mesh);
  return g;
}

/** Fresh module instances by slot: the driver swaps and reinstalls through these. name is the module's installed name */
export const MODS = [
  { slot: 'collision', name: 'collision', make: () => collision() },
  { slot: 'rigid', name: 'rigid', make: () => rigid() },
  { slot: 'nav', name: 'nav', make: () => nav({ agentRadius: 0.4 }) },
  { slot: 'cameraRig', name: 'cameraRig', make: () => followCamera({ distance: 6 }) },
  { slot: 'weather', name: 'weather', make: () => weather({ types: { clear: {}, wet: { rain: 1 } } }) },
  { slot: 'sky', name: 'sky', make: () => sky({ time: 0.4 }) },
  { slot: 'quests', name: 'quests', make: () => quests({ notify: false }) },
  { slot: 'particles', name: 'particles', make: () => particles() },
];

const CONTENT = {
  items: { coin: { name: 'Coin' }, key: { name: 'Key' } },
  startItems: { coin: 1 },
  templates: {
    'chaos-crate': { model: 'chaos-box', body: { shape: 'box', mass: 2 }, state: { hits: 0 } },
    'chaos-tilted': { model: 'chaos-slab', collide: 'box', state: { tag: 0 } },
    'chaos-post': { model: 'chaos-box', collide: 'circle', state: { tag: 0 } },
  },
  props: [
    { id: 'crate-a', template: 'chaos-crate', x: 3, z: 3 },
    { id: 'crate-b', template: 'chaos-crate', x: 5, z: -4 },
    { id: 'tilted-a', template: 'chaos-tilted', x: -5, z: 2, rot: 0.6 },
    { id: 'post-a', template: 'chaos-post', x: 1, z: -8 },
  ],
  quests: { fetch: { title: 'Fetch', steps: [{ text: 'a', done: { flag: 'never' } }, { text: 'b', done: { flag: 'never' } }] } },
};

export const NPCS = [
  { id: 'npc-a', name: 'Ann', position: { x: -3, z: -3 } },
  { id: 'npc-b', name: 'Bo', position: { x: 4, z: 7 } },
];

/** Build and start one game. saveKey keeps runs apart; seed feeds engine.random */
export async function buildGame({ saveKey, seed }) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 96, height: 64 });
  const E = createEngine({ canvas, pixelRatio: 1, adaptiveResolution: false, antialias: false, ui: { loading: false }, urlState: false, headless: true, saveKey, seed, bindings: { ...presets.bindings.walk } });
  E.use(world(), content(), level({ scene: levelScene(0) }), ...MODS.map(m => m.make()), characters({ npcs: true }), inventory(), pickups(), triggers(), interactions({ ...presets.interactions.nearest }), dialogue(), timeline());
  E.assets.manifest({ name: 'chaos', models: {
    'chaos-box': () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), grey(0x996633)),
    'chaos-slab': () => new THREE.Mesh(new THREE.BoxGeometry(3, 2, 0.4), grey(0x667788)),
  } });
  E.mod('ragdoll.graph', { owner: 'chaos', set: { body: { bone: 'hip', mass: 20 }, top: { bone: 'top', parent: 'body', mass: 5 } } });
  E.content.load(CONTENT);
  // on engine:ready, as a game does it: what stands there is part of the new-game state
  const ready = new Promise(res => E.events.once('engine:ready', () => {
    E.characters.addPlayer({ ...presets.player.thirdPerson, spawn: { x: 0, z: 0 }, model: makeRig() });
    for (const n of NPCS) E.npcs.add({ ...n, model: makeRig() });
    res();
  }));
  await E.start();
  await ready;
  E.haltLoop();
  return { E, car: makeCar(E), effects: {}, bloom, grain, THREE };
}
