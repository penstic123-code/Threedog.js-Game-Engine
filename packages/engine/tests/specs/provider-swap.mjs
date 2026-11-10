// [guard] Every slot a module can hold, swapped under a running game: the same provider installed again, so nothing changes but the object. Whatever a consumer kept from the old one
// (a handle, a version number, the module itself) shows here as an error, a frozen frame or a dead feature. Run: threedog test "Provider swap"
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = '/tests/threads/';
const J = JSON.stringify;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// slot -> the spec file that really swaps it, because this page's one game cannot: a reason alone once hid a slot nobody had swapped (terrain's drawing went missing)
const NOT_SWAPPED = {
  'terrain-draw': 'terrain-split.mjs', 'vegetation-draw': 'terrain-split.mjs', weatherDraw: 'sky-writes-nothing.mjs', ground: 'core-modules.mjs',
  world: 'provider-swap.mjs', collider3d: 'provider-caches.mjs', terrain: 'map-swap.mjs', picture: 'map-swap.mjs',
};
const SWAPPED = ['collision', 'level', 'rigid', 'nav', 'characters', 'interactions', 'weather', 'sky', 'calendar', 'cameraRig', 'particles', 'inventory', 'quests', 'dialogue', 'flow', 'swarm', 'vegetation'];

function* sources(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (f.endsWith('.js')) yield p;
  }
}

const setup = () => {
  window.psGame = async (key, navOpts = { crowd: true }) => {
    const { mk, createEngine, world, collision, characters, level, nav, quests, THREE, all: T } = threedogThreads;
    const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g);
    const E = mk(createEngine, key);
    E.assets.manifest({ name: key, models: { psCrate: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) } });
    E.use(world(), collision(), level({ scene: s }), characters(), nav({ agentRadius: 0.4, ...navOpts }), T.content(), T.rigid(), T.interactions({ pick: 'nearest' }), T.pickups(), T.followCamera({ distance: 8 }),
      T.calendar(), T.sky(), T.weather(), T.particles(), T.inventory(), quests(), T.dialogue(), T.flow(), T.swarm(), T.vegetation());
    await E.start();
    const step = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
    const settle = async n => { for (let i = 0; i < n; i++) { await E.loading.settled(); await new Promise(r => setTimeout(r, 8)); step(1); } };
    for (let i = 0; i < 40 && !E.nav.ready; i++) await settle(1);
    const p = E.characters.addPlayer({ control: 'camera', cameraFollow: true });
    E.ops.define('ps.open', { run: () => ({ ok: true }) });
    E.content.load({ templates: { psCrate: { model: 'psCrate', body: { shape: 'box', mass: 2 } }, psChest: { model: 'psCrate', collide: 'box', interact: { label: 'Open', op: 'ps.open' } } },
      props: [{ id: 'ps-crate', template: 'psCrate', x: 4, z: 4 }, { id: 'ps-chest', template: 'psChest', x: 1, z: 0 }] });
    const npc = E.npcs.add({ id: 'ps-npc', name: 'Npc', position: [-6, 0, 0], interact: { op: 'npc.talk' }, schedule: [{ at: 0, position: [6, 0, -6] }] });
    E.ops.allow(() => E.pickups.spawn([0, 0, 1], { give: () => 1, name: 'Coin', id: 'ps-coin' }));
    await settle(10);
    return { E, T, p, npc, step, settle };
  };
  window.psRun = async (key, swap, read, navOpts) => {
    const was = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 200));
    const G = await psGame(key, navOpts), out = { before: G.E.error?.message ?? null };
    try { await swap(G); await G.settle(12); } catch (x) { out.threw = String(x.message).slice(0, 240); }
    out.err = G.E.error?.message ?? null;
    if (read) try { out.read = await read(G); } catch (x) { out.readThrew = String(x.message).slice(0, 240); }
    out.said = out.err || out.threw ? said.filter(m => !m.startsWith('input:')).slice(0, 3) : undefined;
    try { G.E.dispose(); } catch (x) { out.disposeThrew = String(x.message).slice(0, 240); }
    [console.error, console.warn] = was;
    return out;
  };
};

const clean = (check, r, what) => check(what, !r.before && !r.threw && !r.err && !r.readThrew && !r.disposeThrew, J(r));

export const specs = [
  {
    name: '[guard] Provider swap: the table names every slot a module holds',
    url: PAGE,
    async run({ check }) {
      const slots = new Set();
      for (const dir of ['modules', 'core']) for (const f of sources(join(ENGINE, dir))) {
        for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?!\/\/|\*).*\bprovides: (?:part \? \[[^\]]*\] : )?\[([^\]]+)\]/gm)) for (const n of m[1].matchAll(/'([\w-]+)'/g)) slots.add(n[1]);
      }
      const missing = [...slots].filter(s => !SWAPPED.includes(s) && !NOT_SWAPPED[s]);
      check('a new slot gets a swap row here, or names the spec that swaps it', !missing.length, missing.join());
      const unswapped = Object.entries(NOT_SWAPPED).filter(([slot, file]) => !readFileSync(join(ENGINE, 'tests/specs', file), 'utf8').includes(`replaces: '${slot}'`));
      check('the spec a skipped slot names really does the swap', !unswapped.length, J(unswapped));
      // the rule in source form: a provider is read where it is used. A field keeps the old one; a version compared across a swap can match by chance
      const names = [...slots].join('|'), kept = [], counted = [];
      for (const f of sources(join(ENGINE, 'modules'))) {
        const text = readFileSync(f, 'utf8'), at = f.slice(ENGINE.length + 1).replaceAll('\\', '/');
        for (const m of text.matchAll(new RegExp(String.raw`this\.\w+ = (?:e|engine|this\.engine)\.(?:${names})\s*[;,\n]`, 'g'))) kept.push(at + ': ' + m[0].trim());
        if (at !== 'modules/characters/pathAsync.js') for (const m of text.matchAll(/[!=]== (?:e|engine)\.(?:nav|collision)\??\.(?:version|revision)\b/g)) counted.push(at + ': ' + m[0]);
      }
      check('no module keeps a provider in a field', !kept.length, kept.join(' | '));
      check('no consumer compares a provider\'s version number outside the one that resets on another provider (compare the object: crowd, world, the module)', !counted.length, counted.join(' | '));
    },
  },
  {
    name: '[guard] Provider swap: what a consumer took from a provider is taken again from the new one',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const out = {}, near = (E, n) => E.step(1 / 60, { render: false, describe: false });
        // interactions: a chest, an NPC, a pickup and a car each hold an entry in the module
        out.interactions = await psRun('ps2-int', async ({ E, T, p, step }) => {
          const { THREE } = threedogThreads;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial()); mesh.position.set(-3, 1, 3); E.scene.add(mesh);
          E.ops.allow(() => { E.rigid.addWheeled(mesh, { id: 'ps-car', wheels: [[-1, 0, 1.5], [1, 0, 1.5], [-1, 0, -1.5], [1, 0, -1.5]].map(position => ({ position, radius: 0.35 })) }); });
          step(2);
          E.use(T.interactions({ pick: 'nearest' }), { replaces: 'interactions' });
        }, ({ E }) => ['ps-chest', 'ps-npc', 'ps-coin', 'ps-car'].map(id => !!E.interactions.get(id)));
        // nav: crowd agents live in the module's crowd; a new one with the same version number has none of them
        out.nav = await psRun('ps2-nav', async ({ E, T, npc, settle }) => {
          await settle(5);
          out.navWas = { v: E.nav.version, agent: !!npc.model?._agent };
          E.use(T.nav({ agentRadius: 0.4, crowd: true }), { replaces: 'nav' });
          for (let i = 0; i < 60 && !E.nav.ready; i++) await settle(1);
          out.navNow = { v: E.nav.version };
        }, async ({ E, npc, settle }) => { const x = npc.position.x; await settle(30); return { moved: Math.abs(npc.position.x - x) > 0.05, agents: E.nav.crowd?.agents?.length ?? E.nav.crowd?.getAgentCount?.() ?? null }; });
        // weather: the drawing half reads the state half
        out.weather = await psRun('ps2-wx', async ({ E, T }) => {
          const m = [].concat(T.weather()); out.wxMods = m.length;
          E.use(...m, { replaces: 'weather' });
        }, ({ E }) => ({ same: E.weatherDraw?.state === E.weather }));
        // the state half alone: a game's own weather module under the engine's drawing
        out.weatherAlone = await psRun('ps2-wx1', async ({ E, T }) => {
          const m = [].concat(T.weather()).find(x => x.name === 'weather') ?? T.weather();
          E.use(m, { replaces: 'weather' });
        }, ({ E }) => ({ same: E.weatherDraw?.state === E.weather, draw: !!E.weatherDraw }));
        // camera rig
        out.rig = await psRun('ps2-rig', async ({ E, T }) => { out.rigWas = !!E.cameraRig.target; E.use(T.followCamera({ distance: 6 }), { replaces: 'cameraRig' }); }, ({ E, p }) => ({ follows: E.cameraRig.target === p.root }));
        // characters
        out.chars = await psRun('ps2-ch', async ({ E, T }) => { E.use(T.characters(), { replaces: 'characters' }); }, ({ E, p }) => ({ player: !!E.player, same: E.player === p }));
        // calendar, sky: the same hour goes on
        out.cal = await psRun('ps2-cal', async ({ E, T }) => { E.use(T.calendar(), { replaces: 'calendar' }); }, ({ E }) => ({ sky: E.sky?.calendar ? E.sky.calendar === E.calendar : null }));
        return out;
      });
      for (const k of ['interactions', 'nav', 'weather', 'weatherAlone', 'rig', 'chars']) clean(check, r[k], k + ': no error');
      check('interactions: a chest, an NPC, a pickup and a car can be used in the new module', r.interactions.read?.every(Boolean), J(r.interactions));
      check('nav: the same version number and another crowd: the NPC gets a new agent and walks on', r.navNow.v === r.navWas.v && r.nav.read?.moved, J(r));
      check('weather: the picture reads the state half installed now, alone or with its drawing', r.weather.read?.same && r.weatherAlone.read?.same, J(r));
      check('camera rig: the new one follows the player', r.rigWas && r.rig.read?.follows, J(r));
      check('characters: the module owns its characters, so the game creates the player again', r.chars.read?.player === false, J(r));
    },
  },
  {
    name: '[guard] Provider swap: findPathAsync asks the collision module installed now, whatever its version number',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, level, THREE } = threedogThreads;
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const s = new THREE.Group(), g = new THREE.Mesh(new THREE.BoxGeometry(80, 0.2, 80), new THREE.MeshBasicMaterial()); g.name = 'ground'; g.position.y = -0.1; s.add(g);
        const E = mk(createEngine, 'ps-path');
        E.use(world(), collision(), characters(), level({ scene: s }));
        await E.start();
        const ask = async () => {
          let got = null;
          E.characters.findPathAsync({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, path => { got = path ?? []; });
          for (let i = 0; i < 80 && !got; i++) { E.step(1 / 60); await new Promise(res => setTimeout(res, 2)); }
          return got && Math.max(0, ...got.map(q => Math.abs(q.z ?? q[2] ?? 0)));
        };
        const out = {};
        E.ops.allow(() => E.collision.addBox({ x: 0, z: 0 }, { halfWidth: 0.5, halfDepth: 12, height: 3 }));
        out.around = await ask();
        const v = E.collision.version;
        E.use(collision(), { replaces: 'collision' }); E.step(1 / 60);
        E.collision.version = v;   // the wall is not in the new module; only its number matches
        out.straight = await ask();
        E.dispose();
        [console.error, console.warn] = quiet;
        return out;
      });
      check('the wall of the first module is walked around', r.around > 10, J(r));
      check('a new module with the same version and no wall: the way is straight', r.straight !== null && r.straight < 3, J(r));
    },
  },
  ...SWAPPED.map(slot => ({
    name: `[guard] Provider swap: ${slot} replaced under a running game keeps it running`,
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async slot => psRun('ps-' + slot, async ({ E, T }) => {
        const make = { world: () => T.world(), collision: () => T.collision(), level: () => E.modules.get('level') && null, rigid: () => T.rigid(), nav: () => T.nav({ agentRadius: 0.4, crowd: true }), characters: () => T.characters(), interactions: () => T.interactions({ pick: 'nearest' }),
          weather: () => T.weather(), sky: () => T.sky(), calendar: () => T.calendar(), cameraRig: () => T.followCamera({ distance: 6 }), particles: () => T.particles(), inventory: () => T.inventory(), quests: () => T.quests(), dialogue: () => T.dialogue(), flow: () => T.flow(), swarm: () => T.swarm(), vegetation: () => T.vegetation() };
        const m = slot === 'level' ? T.level({ scene: E.level.root }) : make[slot]();
        E.use(m, { replaces: slot });
      }, ({ E, p, npc }) => ({ uses: ['ps-chest', 'ps-npc', 'ps-coin'].map(id => !!E.interactions?.get(id)), rig: !!E.cameraRig?.target, x: +npc.position.x.toFixed(1) })), slot);
      clean(check, r, 'no error, no throw, the game steps on and disposes');
    },
  })),
  {
    // the sweep for "an optional neighbour treated as always there": a neighbour that leaves is read on the next step, so one row per module finds it wherever the read sits
    name: '[guard] Provider swap: every module can leave a running game, or is refused, and the game steps on',
    url: PAGE,
    timeout: 120000,
    async run({ check, ev }) {
      await ev(setup);
      const names = await ev(async () => { const G = await psGame('ps-names'), n = [...G.E.modules.keys()]; G.E.dispose(); return n; });
      check('the game has modules to take away', names.length > 15, J(names));
      for (const name of names) {
        const r = await ev(name => psRun('ps-gone-' + name, async ({ E, step, p }) => {
          try { E.unuse(name); } catch (x) { if (x.code !== 'module-unuse') throw x; }   // a provider something requires is refused at the gate: the refusal is the case
          step(30);
          p.placeAt?.(p.position);
          E.step(1 / 60);
        }), name);
        clean(check, r, `${name} leaves or is refused, and nothing breaks`);
      }
    },
  },
  {
    name: '[guard] Provider swap: world is refused under a running game, nothing changes and the game goes on',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const out = {};
        out.game = await psRun('ps-world', async ({ E, T, npc, settle }) => {
          const before = { api: E.world, mods: [...E.modules.keys()].join(), rec: E.world.get('ps-chest') };
          try { E.use(T.world(), { replaces: 'world' }); } catch (x) { out.refused = { code: x.code, message: x.message }; }
          try { E.unuse('world'); } catch (x) { out.unused = { code: x.code, message: x.message }; }
          out.same = E.world === before.api && [...E.modules.keys()].join() === before.mods && E.world.get('ps-chest') === before.rec;
          const x = npc.position.x; await settle(30); out.walked = Math.abs(npc.position.x - x) > 0.05;
        }, ({ E }) => ['ps-chest', 'ps-npc', 'ps-coin'].map(id => !!E.interactions?.get(id)));
        const { mk, createEngine, world, all: T } = threedogThreads;
        const E = mk(createEngine, 'ps-world-late');
        E.use(world()); await E.start();
        const api = E.world;
        try { E.use(world(), { replaces: 'world' }); } catch (x) { out.started = x.code; }
        try { E.unuse('world'); } catch (x) { out.startedUnuse = x.code; }
        out.startedSame = E.world === api && E.has('world');
        try { E.dispose(); out.disposed = E.phase; } catch (x) { out.disposeThrew = x.message; }
        const F = mk(createEngine, 'ps-world-early');
        F.use(world()); F.unuse('world'); out.earlyGone = !F.has('world');
        F.use(world(), T.content());
        try { F.unuse('world'); } catch (x) { out.earlyUsers = x.code; }
        F.dispose();
        return out;
      });
      clean(check, r.game, 'no error, no throw');
      check('refused by name, and the message says what to do', r.refused?.code === 'module-replaces' && /install your world before the modules that need it/.test(r.refused.message), J(r.refused));
      check('nothing changed: the same world, modules and records', r.same, J(r));
      check('the game runs on: uses stand, the NPC walks', r.game.read?.every(Boolean) && r.walked, J(r));
      check('after start, with no other module: refused too', r.started === 'module-replaces' && r.startedSame, J(r));
      check('unuse in a running game: refused by the same check, nothing changed', r.unused?.code === 'module-unuse' && /install your world before the modules that need it/.test(r.unused.message), J(r.unused));
      check('unuse after start, with no other module: refused too', r.startedUnuse === 'module-unuse', J(r));
      check('unuse before start: refused while an optional user is installed, allowed with none', r.earlyGone && r.earlyUsers === 'module-unuse', J(r));
      check('engine.dispose still tears the world down', r.disposed === 'disposed' && !r.disposeThrew, J(r));
    },
  },
  {
    name: '[guard] Provider swap: world replaced before its dependents works, and in the same call as them',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, all: T } = threedogThreads, out = {};
        const quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        const run = async (key, install) => {
          const E = mk(createEngine, key), first = world();
          E.use(first);
          try { install(E); } catch (x) { [console.error, console.warn] = quiet; return { threw: x.message }; }
          await E.start();
          E.ops.allow(() => E.world.add({ id: 'ps-r', kind: 'psThing', position: [1, 0, 1] }));
          E.step(1 / 60);
          const res = { swapped: E.modules.get('world') !== first, rec: !!E.world.get('ps-r'), err: E.error?.message ?? null };
          E.dispose();
          return res;
        };
        out.before = await run('ps-w1', E => { E.use(world(), { replaces: 'world' }); E.use(collision(), characters()); });
        out.together = await run('ps-w2', E => E.use(world(), collision(), characters(), { replaces: 'world' }));
        [console.error, console.warn] = quiet;
        return out;
      });
      const works = a => a.swapped && a.rec && !a.err;
      check('before the modules that need it: the new world holds the records', works(r.before), J(r));
      check('in one call with them: the same', works(r.together), J(r));
    },
  },
];
