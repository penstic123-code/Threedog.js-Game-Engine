// Rules of a state replacement that hold across owners, each through the public API. The rows that came out of the 1.0 state map stay in map-session.mjs and map-order.mjs.
const THREADS = '/tests/threads/';
const show = r => JSON.stringify(r).slice(0, 900);

// What may differ from a fresh page after a new game, each with its reason. Any other path that differs is a playthrough's state left behind
const DECLARED = [
  [/^(perf|frame|frames|fps|renderer|gpu|memory|budget|loading|timing|build|errorLog|warnings|log)\b/, 'how the page ran, not game state'],
  [/^(ops|time\.)?\.?(revision|recent|log|history)\b/, 'the op log only goes up'],
  [/^session\.id\b/, 'it counts playthroughs'],
  [/^(saves|commits)\b/, 'stored slots and epochs outlive a playthrough'],
  [/^stream\b/, 'what is loaded around the player follows the frames that ran'],
];
const declared = path => DECLARED.some(([re]) => re.test(path));
const diff = (a, b, path = '', out = []) => {
  if (a === b || out.length > 60) return out;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (!declared(path)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 70)} -> ${JSON.stringify(b)?.slice(0, 70)}`); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
};

export const specs = [
  {
    name: '[guard] session fresh page: after a new game describe() matches a fresh page, apart from the fields declared in this spec',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, THREE = threedogThreads.THREE, was = [console.error, console.warn];
        console.error = console.warn = () => {};
        const E = threedogThreads.mk(T.createEngine, 'rule-fresh', {});
        const ground = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial()), scene = new THREE.Group();
        ground.name = 'ground'; ground.position.y = -0.1; scene.add(ground);
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.level({ scene }), T.rigid(), T.followCamera({ distance: 6 }), T.quests(), T.hud(), T.flow(), T.music({ tracks: { calm: '/c.ogg', fight: '/f.ogg' }, rules: [{ track: 'fight', when: { state: 'combat' } }, { track: 'calm' }] }));
        E.onReady?.(() => {});
        await E.start();
        const P = E.characters.addPlayer({ control: 'camera', cameraFollow: true, spawn: { x: 0, z: 0 } });
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        await E.session.newGame(); steps(2);
        const fresh = JSON.parse(JSON.stringify(E.describe()));
        // play: every public kind of state the map names
        E.world.anchor = [50, 0, 50];
        E.audio.state = 'combat';
        E.vars.setFlag('played');
        E.player.placeAt([9, 0, 9]);
        E.control.take(E.player, { owner: 'roll', layer: 'script', step: () => ({ x: 0, z: 1 }) });
        E.quests.define('q', { title: 'Q', steps: [{ text: 'go', target: { x: 3, y: 0, z: 4 }, done: () => false }] });
        E.quests.start('q');
        E.setCamera('follow', { distance: 3 });
        E.cameraRig.yaw = 1;
        E.clock.after(50, () => {}, { channel: 'world' });
        E.session.track(E.onFixed(() => {}));
        steps(30);
        await E.session.newGame(); steps(2);
        const after = JSON.parse(JSON.stringify(E.describe()));
        E.dispose(); [console.error, console.warn] = was;
        return { fresh, after };
      });
      const left = diff(r.fresh, r.after);
      check('nothing of the old playthrough shows', left.length === 0, left.join(' | ').slice(0, 1800));
    },
  },
  {
    name: '[guard] session late pack: a pack loaded after start() keeps its startItems at a new game, as it keeps its props and definitions',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'rule-pack', {}), was = [console.error, console.warn];
        console.error = console.warn = () => {};
        E.use(T.world(), T.content(), T.inventory());
        await E.start();
        await E.content.load({ items: { gold: {} }, startItems: { gold: 5 }, props: [{ id: 'rulePost', model: 'box', position: [1, 0, 1] }] });
        const before = E.inventory.count?.('gold');
        await E.session.newGame();
        const out = { before, after: E.inventory.count?.('gold'), prop: !!E.world.get('rulePost') };
        E.dispose(); [console.error, console.warn] = was;
        return out;
      });
      check('the pack gave its items', r.before === 5, show(r));
      check('its props stay', r.prop === true, show(r));
      check('its start items stay too', r.after === 5, show(r));
    },
  },
  {
    name: '[guard] session late part: a module used after start() joins the new-game state as its init left it, not as install left it',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'rule-late', {});
        await E.start();
        let s = null;
        E.use({ name: 'ruleLate', type: 'rules', install(e, c) { c.saves.define('ruleLate', { save: () => s, load: d => { s = d; } }); }, init() { s = { hp: 10 }; } });
        await E.loading.settled?.(); await new Promise(res => setTimeout(res, 0));
        s.hp = 1;
        await E.session.newGame();
        const out = { hp: s.hp };
        E.dispose();
        return out;
      });
      check('the part starts from what init set', r.hp === 10, show(r));
    },
  },
  {
    name: '[guard] session failed transition: a flow.transition fading out across a load that fails goes on, as a teleport does; one across a load that holds is dropped',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, quiet = console.error;
        console.error = () => {};
        const E = threedogThreads.mk(T.createEngine, 'rule-transition', {});
        E.use(T.flow());
        let armed = false;
        E.saves.define('ruleBad', { save: () => 1, load() { if (armed) { armed = false; throw new Error('a part that cannot load'); } } });
        await E.start();
        E.saves.save('s'); await E.saves.flush();
        const across = async door => {
          let swapped = false;
          const t = E.flow.transition(() => { swapped = true; }, { fade: 0.02 });
          await new Promise(s => setTimeout(s, 0));
          await door();
          for (let i = 0; i < 30; i++) { E.step(0.02, { render: false }); await new Promise(s => setTimeout(s, 0)); }   // the fade runs on frames
          await t;
          return swapped;
        };
        const out = {};
        armed = true; out.failedQuick = await across(() => E.saves.load('s'));
        armed = true; out.failedSession = await across(() => E.session.load('s'));
        out.held = await across(() => E.saves.load('s'));
        E.dispose(); console.error = quiet;
        return out;
      });
      check('a failed quick load keeps the transition', r.failedQuick === true, show(r));
      check('a failed session load keeps the transition', r.failedSession === true, show(r));
      check('a load that held drops it', r.held === false, show(r));
    },
  },
  {
    name: '[guard] session atomic copy: an atomic op that fails puts a NaN back as NaN, not as null',
    url: THREADS,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'rule-atomic', {}), warn = console.error;
        console.error = () => {};
        let part = { hp: 2 };
        E.saves.define('ruleHp', { atomic: true, save: () => part, load: d => { part = d; } });
        let ran = false;
        E.ops.define('rule.hurt', { atomic: true, run() { ran = true; part = { hp: 1 }; return { ok: false, code: 'no', facts: [], nextActions: [] }; } });
        await E.start();
        part = { hp: NaN };   // a bug during play; at boot the new-game capture would stop on it
        const res = await E.ops.run('rule.hurt');
        const out = { ran, ok: res?.ok ?? res, code: res?.code, msg: res?.facts?.message, hp: String(part.hp) };
        E.dispose(); console.error = warn;
        return out;
      });
      check('the op ran, failed and rolled back', r.ran && r.ok !== true && r.hp !== '1', show(r));
      check('the value is what it was', r.hp === 'NaN', show(r));
    },
  },
];
