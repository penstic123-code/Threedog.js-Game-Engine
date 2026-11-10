// [map] Playthrough boundary probes of the 1.0 state map. A name starting "[map FAILING]" proves an open bug: it fails on purpose until the bug is fixed.
// Each row first checks that its setup really took (those checks pass today), so the row fails only on the last checks, for the reason in its name.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  window.mapFlat = (THREE, name = 'home') => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()); s.name = name; m.name = 'ground'; m.position.y = -0.1; s.add(m); return s; };
  window.mapQuiet = () => { const was = [console.error, console.warn], said = []; console.error = console.warn = m => said.push(String(m).slice(0, 180)); return { said, back() { [console.error, console.warn] = was; } }; };
  // ground for characters to stand on; each row makes its player itself, because when it is made is what some rows test
  window.mapWalkers = async name => {
    const { mk, createEngine, world, collision, characters, level, THREE } = threedogThreads;
    const E = mk(createEngine, name);
    E.use(world(), collision(), characters(), level({ scene: mapFlat(THREE) }));
    await E.start();
    return E;
  };
};

export const specs = [
  {
    name: '[guard] session timer: a module function timer follows the module, not the moment of start(): a removed one stays gone at new game, a late one survives it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, q = mapQuiet();
        const beat = (name, count) => ({ name, install(e, ctx) { ctx.track(e.clock.every(0.5, count, { channel: 'world' })); } });
        // removed before the new game: its handle was removed, so nothing may call it again
        const A = mk(createEngine, 'map-t1');
        let gone = 0; A.use(beat('beat', () => gone++));
        await A.start();
        A.step(2); const ranBefore = gone;
        A.unuse('beat'); gone = 0;
        await A.session.newGame(); A.step(2);
        const removed = gone; A.dispose();
        // installed after start(): the module is still in, and install() will not run again to set the timer up
        const B = mk(createEngine, 'map-t2');
        await B.start();
        let late = 0; B.use(beat('beat', () => late++));
        B.step(2); const lateBefore = late; late = 0;
        await B.session.newGame(); B.step(2);
        const lateAfter = late; B.dispose();
        q.back();
        return { ranBefore, removed, lateBefore, lateAfter };
      });
      check('both timers ran before the new game', r.ranBefore > 0 && r.lateBefore > 0, J(r));
      check('the timer of a removed module does not come back', r.removed === 0, J(r));
      check('the timer of a module used after start() keeps running', r.lateAfter > 0, J(r));
    },
  },
  {
    name: '[guard] session hold: a control.take ended by a clock.after does not outlive the playthrough that made it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = mapQuiet(), E = await mapWalkers('map-hold');
        const p = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        // the documented short move: an ability takes the character and a timer gives it back
        const roll = E.control.take(p, { owner: 'roll', layer: 'script', step: () => ({ x: 0, z: 1, run: true }) });
        E.clock.after(0.4, () => roll.remove(), { channel: 'world' });
        E.step(0.1);
        const during = E.control.of(p)?.owner;
        await E.session.newGame();
        E.step(1);
        const out = { during, after: E.control.of(E.player)?.owner ?? null, z: E.player.position.z };
        E.dispose(); q.back();
        return out;
      });
      check('the hold was in charge before the new game', r.during === 'roll', J(r));
      check('nothing of the old roll holds the character after the new game', r.after !== 'roll', J(r));
    },
  },
  {
    name: '[guard] session quit: after session.quit() with no title part, session.playing is false and autosave leaves the slot alone',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, q = mapQuiet(), E = mk(createEngine, 'map-quit');
        let gold = 0;
        E.saves.define('gold', { save: () => ({ gold }), load: d => { gold = d.gold; } });
        await E.start();
        gold = 7;
        await E.saves.save('auto');
        E.saves.autosave(0.01);
        await E.session.quit();
        const playing = E.session.playing;
        E.step(2);
        await new Promise(s => setTimeout(s, 50));
        gold = -1;
        const loaded = await E.session.load('auto');
        const out = { playing, loaded, gold };
        await E.saves.remove('auto');
        E.dispose(); q.back();
        return out;
      });
      check('the save loads', r.loaded === true, J(r));
      check('no playthrough runs after quit', r.playing === false, J(r));
      check("slot 'auto' still holds the quit playthrough", r.gold === 7, J(r));
    },
  },
  {
    name: '[guard] session walk: a walk ends at saves.apply as it does at saves.load: it is not saved, so it cannot go on in the state put back',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = mapQuiet(), E = await mapWalkers('map-walk');
        const p = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const snap = E.saves.collect(), settle = () => new Promise(s => setTimeout(s, 20));
        const walk = async change => {
          let end = null;
          p.walkTo({ x: 20, z: 0 }).then(v => { end = v.status; });
          E.step(0.2);
          await change();
          await settle(); E.step(0.5); await settle();
          return { end, x: Math.round(p.position.x * 10) / 10, slot: E.control.of(p)?.owner ?? null };
        };
        await E.saves.save('map');
        const load = await walk(() => E.saves.load('map'));
        const apply = await walk(() => E.saves.apply(snap));
        await E.saves.remove('map');
        E.dispose(); q.back();
        return { load, apply };
      });
      check('saves.load ends the walk', r.load.end === 'cancelled', J(r));
      check('saves.apply ends the walk too', r.apply.end === 'cancelled' && r.apply.slot !== 'walkTo', J(r));
    },
  },
  {
    name: '[guard] session anchor: a world.anchor set during play is gone after a new game',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = mapQuiet(), E = await mapWalkers('map-anchor');
        const before = E.world.anchor;
        E.world.anchor = [500, 0, 500];
        await E.session.newGame();
        const out = { before, after: E.world.anchor };
        E.dispose(); q.back();
        return out;
      });
      check('a fresh game has no anchor', r.before === null, J(r));
      check('the new game has no anchor either', r.after === null, J(r));
    },
  },
  {
    name: '[guard] session late player: a player made after start() goes back to where it began at a new game',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = mapQuiet(), E = await mapWalkers('map-late');
        const p = E.characters.addPlayer({ control: 'camera', spawn: { x: 1, z: 1 } });
        const begin = p.position.x;
        p.placeAt([9, 0, 9]);
        const moved = p.position.x;
        await E.session.newGame();
        const out = { begin, moved, after: E.player.position.x };
        E.dispose(); q.back();
        return out;
      });
      check('the player moved', r.begin === 1 && r.moved === 9, J(r));
      check('the new game does not keep the old position', r.after !== 9, J(r));
    },
  },
  {
    name: '[guard] session level: a game that opened on a code-built level is back on it after a new game',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level, THREE } = threedogThreads, q = mapQuiet(), E = mk(createEngine, 'map-level');
        E.assets.manifest({ name: 'map-l', models: { mapCave: { build: async () => mapFlat(THREE, 'cave') } } });
        E.use(world(), level({ scene: mapFlat(THREE, 'home') }));
        await E.start();
        const opened = E.level.root?.name;
        await E.level.load('mapCave');
        const moved = E.level.root?.name;
        await E.session.newGame();
        const out = { opened, moved, after: E.level.root?.name };
        E.dispose(); q.back();
        return out;
      });
      check('the level changed during play', r.opened === 'home' && r.moved !== 'home', J(r));
      check('the new game opens on the first level', r.after === 'home', J(r));
    },
  },
  {
    name: '[guard] session error: a dev gameplay error stays frozen until reload, a new game included: an error must not be hidden',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, q = mapQuiet(), E = mk(createEngine, 'map-error');
        await E.start();
        // throws once and removes itself, so what stays frozen afterwards is the old error and not a new one
        const bad = E.onFixed(() => { bad.remove(); throw new Error('map boom'); });
        E.step(1 / 60);
        const hit = { error: !!E.error, frozen: E.frozen };
        const ok = await E.session.newGame();
        const tick = E.time.tick;
        E.step(0.5);
        const out = { hit, ok, frozen: E.frozen, error: E.error?.message ?? null, ticks: E.time.tick - tick };
        E.dispose(); q.back();
        return out;
      });
      check('the throw froze the game and the new game went through', r.hit.error && r.hit.frozen && r.ok === true, J(r));
      check('the game stays frozen and does not step', r.frozen === true && r.ticks === 0, J(r));
      check('the error stays on engine.error', r.error === 'map boom', J(r));
    },
  },
  {
    name: '[guard] session register: a second saves.define on a held key does not silently take the part away from its owner',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, q = mapQuiet(), E = mk(createEngine, 'map-reg');
        await E.start();
        const part = v => ({ save: () => ({ v }), load() {} });
        E.saves.define('mapKey', part('first'));
        let threw = null;
        try { E.saves.define('mapKey', part('second')); } catch (err) { threw = err.code ?? err.message; }
        const out = { threw, said: q.said.filter(s => s.includes('mapKey')), holds: E.saves.collect().parts.mapKey?.v };
        E.dispose(); q.back();
        return out;
      });
      check('the second owner is told by name, and the first keeps the key', r.threw === 'save-key-taken' && r.holds === 'first', J(r));
    },
  },
];
