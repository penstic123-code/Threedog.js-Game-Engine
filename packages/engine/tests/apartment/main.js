// Apartment block: a shared acceptance scene, written as an ordinary game. Three storeys (0, 3.5, 7 m) joined by ramps, a cellar at -4 that runs on under a lake,
// a bumpy yard, hills outside. Everything goes through public names; the spec reads window.game and engine, and a private field in here is a finding.
//   plan:  yard x -30..-10 | house x -10..10 | lake x 10..30 (pier along z = 0), cellar under the house and the lake
import { createEngine, presets, world, collision, followCamera, characters, terrain, level, compositeGround, nav, triggers, quests, water, calendar, interactions, rigid, THREE } from '../../index.js';

const RAPIER = new URLSearchParams(location.search).has('rapier');   // ?rapier: the same block with real physics, the Rapier mover on the first player
const FLOOR = { cellar: -4, ground: 0, first: 3.5, second: 7 };
const LAKE = { minX: 10, maxX: 30, minZ: -12, maxZ: 12, bed: -1.5, level: -0.4 };
// the yard's bumps, -0.4 to 1.4 m, levelling out to the door sill: a step taller than stepHeight there would shut the house
const yardHeight = (x, z) => Math.min(1, (-10 - x) / 3) * (0.5 + Math.sin(x * 0.7) * 0.45 + Math.cos(z * 0.6) * 0.45);

const root = new THREE.Group(); root.name = 'apartment';
const grey = new THREE.MeshLambertMaterial({ color: 0x8a8a8a, side: THREE.DoubleSide });
// a walkable quad from x0 to x1 (x0 < x1), height y0 to y1 along x: a floor when they match, a ramp when not
const quad = (name, x0, z0, x1, z1, y0, y1 = y0) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, z0, x0, y0, z1, x1, y1, z1, x1, y1, z0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals();
  const m = new THREE.Mesh(g, grey); m.name = name; root.add(m);
};
const wall = (name, x0, z0, x1, z1, y, h = 3) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), grey);
  m.name = 'col_' + name; m.position.set((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2); root.add(m);
};

quad('floor_cellar', -8, -8, 24, 8, FLOOR.cellar);
quad('ramp_cellar', -6, -8, 6, -4, FLOOR.cellar, FLOOR.ground);
for (const [x0, z0, x1, z1] of [[-10, -4, 10, 8], [-10, -8, -6, -4], [6, -8, 10, -4]]) quad('floor_ground', x0, z0, x1, z1, FLOOR.ground);
quad('ramp_first', -8, 4, 2, 8, FLOOR.ground, FLOOR.first);
for (const [x0, z0, x1, z1] of [[-10, -4, 10, 4], [-10, -8, -8, -4], [2, -8, 10, -4], [2, 4, 10, 8], [-10, 4, -8, 8]]) quad('floor_first', x0, z0, x1, z1, FLOOR.first);
quad('ramp_second', -8, -8, 2, -4, FLOOR.second, FLOOR.first);
for (const [x0, z0, x1, z1] of [[-10, -8, -8, -4], [-10, -4, 10, 8]]) quad('floor_second', x0, z0, x1, z1, FLOOR.second);
// the yard: a real bumpy mesh, so a target written with y = 0 is wrong by a different amount at every point
{
  const g = new THREE.PlaneGeometry(20, 40, 40, 80).rotateX(-Math.PI / 2).translate(-20, 0, 0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, yardHeight(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, grey); m.name = 'ground_yard'; root.add(m);
}
// the lake: its bed is the cellar's roof, a pier from the back door, shores round it
quad('ground_lakebed', LAKE.minX, LAKE.minZ, LAKE.maxX, LAKE.maxZ, LAKE.bed);
quad('floor_pier', 10, -1, 22, 1, FLOOR.ground);
for (const [x0, z0, x1, z1] of [[10, -20, 34, -12], [10, 12, 34, 20], [30, -12, 34, 12]]) quad('ground_shore', x0, z0, x1, z1, FLOOR.ground);
// outer walls per storey: the ground floor has a front door (x = -10) and a back door (x = 10), both at z -1..1
for (const [n, y] of [['ground', 0], ['first', 3.5], ['second', 7]]) {
  wall(`north_${n}`, -10.4, 8, 10.4, 8.4, y); wall(`south_${n}`, -10.4, -8.4, 10.4, -8, y);
  for (const [s, x] of [['w', -10.4], ['e', 10]]) {
    if (y === 0) { wall(`${s}a_${n}`, x, -8, x + 0.4, -1, y); wall(`${s}b_${n}`, x, 1, x + 0.4, 8, y); } else wall(`${s}_${n}`, x, -8, x + 0.4, 8, y);
  }
}
wall('partition_first', 4, -4, 4.4, 4, FLOOR.first);   // upstairs only: a room on the first floor; the lobby below stays open

const spawn = new THREE.Object3D(); spawn.name = 'spawn'; spawn.position.set(-6, 0, 0); root.add(spawn);

const engine = window.engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, canvas: document.getElementById('view'), ui: { loading: { title: 'Apartment block' } }, adaptiveResolution: false, saveKey: 'apartment-test' });
engine.use(world(), collision(), followCamera(), characters({ npcs: true }), calendar({ dayLength: 2400, time: '08:00' }),
  terrain({ part: true, height: (x, z) => 1 + Math.sin(x * 0.05) * 2 + Math.cos(z * 0.07) * 2, viewChunks: 1 }),
  level({ scene: root, part: true }),
  compositeGround({ parts: [{ of: 'level', region: (x, z) => x >= -30 && x <= 34 && Math.abs(z) <= 20, priority: 1 }, { of: 'terrain' }] }),
  nav(), triggers(), quests(), water({ sea: false }), interactions({ ...presets.interactions.nearest }), ...(RAPIER ? [rigid()] : []));

// the game's own lake: water from the bed up, none under the bed, so the cellar stays dry
const lakeMesh = new THREE.Mesh(new THREE.PlaneGeometry(LAKE.maxX - LAKE.minX, LAKE.maxZ - LAKE.minZ).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x5a6a7a, transparent: true, opacity: 0.5 }));
lakeMesh.position.set((LAKE.minX + LAKE.maxX) / 2, LAKE.level, (LAKE.minZ + LAKE.maxZ) / 2);
const inLake = (x, z) => x >= LAKE.minX && x <= LAKE.maxX && z >= LAKE.minZ && z <= LAKE.maxZ;

// run: fixed steps with the loop halted, handing the thread back now and then so path workers answer
const run = async seconds => { for (let i = 0, n = Math.round(seconds * 60); i < n; i++) { engine.step(1 / 60, { render: false, describe: false }); if (i % 40 === 0) await new Promise(res => setTimeout(res, 1)); } };
// walk: a walkTo run to its end, however long that takes up to max seconds
const walk = async (c, to, max = 40) => { let done = null; c.walkTo(to).then(a => { done = a; }); for (let t = 0; t < max && !done; t += 0.5) await run(0.5); return done ?? { status: 'running' }; };
const game = window.game = { THREE, FLOOR, LAKE, yardHeight, run, walk, entries: [], exits: [], ready: false };

engine.events.on('engine:ready', () => {
  game.lake = engine.addWaterBody({
    query: (x, z, y) => (inLake(x, z) && (y == null || y > LAKE.bed - 0.5) ? LAKE.level : null),
    bounds: { min: { x: LAKE.minX, y: LAKE.bed - 0.5, z: LAKE.minZ }, max: { x: LAKE.maxX, y: 5, z: LAKE.maxZ } },
    mesh: lakeMesh,
  });
  engine.add(lakeMesh);

  // two people at one keyboard: the second has its own keys and the second pad
  game.one = engine.characters.addPlayer({ ...presets.player.thirdPerson, control: 'camera', spawn: [-6, 0, 0], ...(RAPIER && { mover: 'rapier' }) });
  game.seat = engine.input.seat({ pad: 1, keys: { moveForward: 'KeyI', moveBack: 'KeyK', moveLeft: 'KeyJ', moveRight: 'KeyL', jump: 'KeyU', interact: 'KeyO' } });
  game.two = engine.characters.addPlayer({ ...presets.player.thirdPerson, control: 'camera', id: 'two', input: game.seat, spawn: [-6, 0, 3] });

  // the front door counts every entrant; `who` names both players, since a zone hears engine.actor alone by default
  game.door = engine.triggers.add({
    shape: 'box', position: [-11, 0, 0], size: [2, 3, 2], tag: 'frontDoor', occupancy: 'each', who: () => ['player', 'two'],
    onEnter: (t, p, id) => game.entries.push(id), onExit: (t, p, id) => game.exits.push(id),
  });
  // a zone on the first floor, right above the lobby: the lobby must not set it off
  game.landing = engine.triggers.add({ shape: 'box', position: [0, FLOOR.first, 0], size: [4, 3, 4], tag: 'landing', who: () => ['player', 'two'], onEnter: () => engine.vars.bump('landingEntered') });
  // reaching the cellar's far end moves the quest on
  game.cellar = engine.triggers.add({ shape: 'box', position: [12, FLOOR.cellar, 0], size: [8, 3, 8], tag: 'cellar', who: () => ['player', 'two'], onEnter: () => engine.vars.setFlag('sawCellar') });

  engine.quests.define('leak', { title: 'The leak', steps: [
    { id: 'look', text: 'Find where the water comes in', done: e => e.vars.flag('sawCellar'), target: { x: 12, y: FLOOR.cellar, z: 0 }, next: e => (e.vars.flag('hasPump') ? 'pump' : 'call') },
    { id: 'call', text: 'Tell the caretaker upstairs', done: e => e.vars.flag('told'), target: { x: 6, y: FLOOR.second, z: 0 }, next: false },
    { id: 'pump', text: 'Run the pump', done: e => e.vars.flag('pumped'), target: { x: 12, y: FLOOR.cellar, z: 0 } },
  ] });
  engine.quests.start('leak');

  // the caretaker's day crosses every storey: a stop's y picks the floor
  game.caretaker = engine.npcs.add({ id: 'caretaker', name: 'Caretaker', position: [6, FLOOR.second, 2], schedule: [
    { at: '08:00', position: [6, FLOOR.second, 2] }, { at: '10:00', position: [6, FLOOR.first, 2] },
    { at: '12:00', position: [6, FLOOR.ground, 2] }, { at: '14:00', position: [12, FLOOR.cellar, 2] },
  ] });
  game.ready = true;
});
engine.start();
