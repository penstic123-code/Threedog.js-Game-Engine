// [guard] A content load is one transaction across its packs: when any later step fails, state and registrations equal what they were before the load
// (core/base/sections.js). Each case loads a good pack around a section whose commit throws, on real modules. Run: threedog test "Content transaction"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

/** Runs in the page: an engine with the modules a pack touches, and a picture of everything a pack can register */
const HARNESS = `(() => {
  const { mk, createEngine, THREE } = threedogThreads, T = threedogThreads.all, J = JSON.stringify;
  const quiet = [console.error, console.warn];
  window.__ct = async (key, mods) => {
    console.error = console.warn = () => {};
    const E = mk(createEngine, key);
    const boom = { name: 'ctBoom', type: 'rules', skipKind: 'none', content: { ctBoom: { commit() { throw new Error('late commit failed'); } } } };
    E.use(...mods(T), boom);
    await E.start();
    E.assets.manifest({ name: 'ct', models: { ctModel: () => new THREE.Object3D(), ctPlant: () => new THREE.BoxGeometry() } });
    const safe = fn => { try { return fn(); } catch (err) { return 'threw ' + err.code; } };
    const state = () => J({
      actions: [...E.input.actions.keys()].filter(k => k.startsWith('ct')).map(k => [k, E.input.keysOf(k)]),
      sounds: Object.keys(E.audio.config.sounds).filter(k => k.startsWith('ct')), packs: E.audio.packs.size,
      views: E.views.list(), place: E.content.place('ctPlace'), word: safe(() => E.content.test({ ctWord: 1 })),
      items: E.inventory ? [...E.inventory.defs].map(([k, v]) => [k, v.name]) : null, gold: E.inventory?.count('ctGold'), boxes: E.inventory ? [...E.inventory._containers.map.keys()] : null,
      records: E.world ? [...E.world.records.keys()].sort() : null, base: E.world ? [...E.world._base.keys()].sort() : null, tombs: E.world ? [...E.world._removed] : null,
      moved: E.world?.get('ctProp')?.position.x,
      quests: E.quests ? [...E.quests.defs.keys()] : null, talk: E.dialogue ? [...E.dialogue.scripts.keys()] : null, zones: E.triggers ? E.triggers._list.length : null,
      templates: E.modules.get('content').describe().templates, kinds: safe(() => Object.keys(E.content.fields('ctKind'))),
      grids: E.grids ? [...E.grids._grids.keys()] : null, plants: E.vegetation ? [...E.vegetation.species.keys()] : null,
    });
    const load = (...a) => { try { E.content.load(...a); return null; } catch (err) { return err.message; } };
    // vegetation lands after the load: its models are made in commit, nothing waits for them
    const settled = async () => { for (let i = 0; i < 400 && !E.content.ready; i++) { E.step(1 / 60); await new Promise(r => setTimeout(r, 5)); } };
    return { E, THREE, state, load, settled, end: () => { E.dispose(); [console.error, console.warn] = quiet; } };
  };
  window.__full = T => [T.world(), T.content(), T.inventory(), T.pickups(), T.dialogue(), T.quests(), T.triggers(), T.grids(), T.vegetation()].flat();
  window.__ctPack = {
    name: 'ct', places: { ctPlace: { x: 3, z: 4 } },
    rules: { conditions: { ctWord: { desc: 'test word', test: () => true } }, kinds: { ctKind: { desc: 'a game kind', load() {} } } },
    actions: { ctJump: { label: 'Jump', keys: ['KeyJ'] } },
    audio: { sounds: { ctBeep: { src: 'ctBeep' } } },
    views: { ctView: { position: [1, 2, 3] } },
    items: { ctGold: { name: 'Gold' } }, startItems: { ctGold: 2 }, containers: { ctBox: { capacity: 3, items: { ctGold: 1 } } },
    pickups: [{ id: 'ctCoin', item: 'ctGold', x: 1, z: 1 }],
    dialogues: { ctTalk: { nodes: { start: { text: 'hi' } } } },
    quests: { ctQuest: { title: 'Q', steps: [{ text: 'a', done: { flag: 'never' } }] } },
    triggers: { ctZone: { position: { x: 0, z: 0 }, onEnter: { setFlag: 'in' } } },
    grids: { ctGrid: { cell: 1, origin: [0, 0], size: [4, 4] } },
    vegetation: { ctTree: { model: 'ctPlant' } },
    templates: { ctCrate: { model: 'ctModel' } },
    props: [{ id: 'ctProp', model: 'ctModel', place: 'ctPlace', x: 0, z: 0 }, { id: 'ctCrate1', template: 'ctCrate', x: 2, z: 2 }],
    ctKind: { a: {} },
  };
})()`;
const page = ev => ev(src => { (0, eval)(src); }, HARNESS);

export const specs = [
  {
    name: '[guard] Content transaction: a turn kept after its load ended is an outside request: the load waits in line behind the one before it',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const log = []; let open, kept;
        const gate = new Promise(res => { open = res; });
        const hold = { name: 'ctHold', type: 'rules', skipKind: 'none', content: { ctHeld: { prepare: () => gate, commit() { log.push('A'); } }, ctNext: { commit() { log.push('B'); } } } };
        const { E, end } = await window.__ct('ct-turn', T => [T.world(), T.content(), hold]);
        const part = E.saves.define('ct-keep', { save: () => ({ n: 1 }), load(d, turn) { kept = turn; } });
        await E.saves.apply(E.saves.collect());
        const a = E.content.load({ ctHeld: 1 });
        const b = E.content.load({ ctNext: 1 }, { turn: kept });
        const early = [...log];
        open(); await Promise.all([a, b]);
        part.remove(); const order = [...log]; end();
        return { kept: !!kept, early, order };
      });
      check('the load got a turn to keep', r.kept);
      check('B did not jump the line', r.early.length === 0, r.early.join());
      check('A commits first, B stands on it', r.order.join() === 'A,B', r.order.join());
    },
  },
  {
    name: '[guard] Content transaction: a pack whose owner is missing leaves nothing behind, not its action, sound, view, word or place',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { state, load, end } = await window.__ct('ct-owner', T => [T.world(), T.content()]);
        const before = state();
        const { name, places, rules, actions, audio, views, items } = window.__ctPack;
        const msg = load({ name, places, rules, actions, audio, views, items });
        const after = state(); end();
        return { before, after, msg };
      });
      check('refused for the missing owner, by name', /inventory/.test(r.msg ?? ''), r.msg);
      check('state and registrations equal the state before the load', r.before === r.after, `${r.before}\n${r.after}`);
    },
  },
  {
    name: '[guard] Content transaction: a commit that throws late takes back everything committed before it, and the same pack then loads whole',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { state, load, settled, end } = await window.__ct('ct-late', window.__full);
        const before = state();
        const msg = load({ ...window.__ctPack, ctBoom: 1 });
        await settled();
        const after = state();
        const again = load(window.__ctPack);
        await settled();
        const whole = state(); end();
        return { before, after, msg, again, whole };
      });
      check('the error reaches the caller', /late commit failed/.test(r.msg ?? ''), r.msg);
      check('state and registrations equal the state before the load', r.before === r.after, `${r.before}\n${r.after}`);
      check('nothing of the failure blocks the next load', r.again === null && /ctQuest/.test(r.whole) && /ctJump/.test(r.whole) && /ctProp/.test(r.whole), r.again ?? r.whole);
      check('the same vegetation table registers on the retry: the cancellation was that load\'s', /"plants":\["ctTree"\]/.test(r.whole), r.whole);
    },
  },
  {
    name: '[guard] Content transaction: packs of one load share it: a failing second pack takes the first one back',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { state, load, end } = await window.__ct('ct-packs', window.__full);
        const before = state();
        const msg = load([window.__ctPack, { name: 'second', ctBoom: 1 }]);
        const after = state();
        const validate = load([window.__ctPack, { name: 'second', nonsense: 1 }]);
        const refused = state(); end();
        return { before, after, msg, refused, validate };
      });
      check('commit failure in pack two: pack one is gone too', /late commit/.test(r.msg ?? '') && r.before === r.after, `${r.before}\n${r.after}`);
      check('refusal in pack two: pack one never committed', !!r.validate && r.before === r.refused, `${r.validate}\n${r.refused}`);
    },
  },
  {
    name: '[guard] Content transaction: a pack loaded again over its own data gets the earlier definitions back when it fails',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { state, load, end } = await window.__ct('ct-again', window.__full);
        const first = load(window.__ctPack);
        const before = state();
        const changed = { ...window.__ctPack, places: { ctPlace: { x: 9, z: 9 } }, items: { ctGold: { name: 'New' } }, actions: { ctJump: { keys: ['KeyK'] } }, startItems: { ctGold: 5 }, ctBoom: 1 };
        const msg = load(changed);
        const after = state(); end();
        return { first, before, after, msg };
      });
      check('first load fine', r.first === null, r.first);
      check('item name, key, place, moved prop and goods are as they were', /late commit/.test(r.msg ?? '') && r.before === r.after, `${r.before}\n${r.after}`);
    },
  },
  {
    name: '[guard] Content transaction: a pack that swapped the level and then failed goes back to the old level',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { THREE } = threedogThreads;
        const scene = n => { const g = new THREE.Group(); g.name = n; const f = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial()); f.name = 'ground'; g.add(f); return g; };
        const { E, end } = await window.__ct('ct-level', T => [T.level(), T.world(), T.content()]);
        E.assets.manifest({ name: 'ct2', models: { ctOld: { build: async () => scene('ctOld') } } });
        await E.level.load('ctOld');
        const msg = await E.content.load({ level: scene('ctNew'), ctBoom: 1 }).then(() => null, err => err.message);   // it ends with the old level back: state turn rows hold that
        const out = { msg, root: E.level.root?.name ?? null, inScene: !!E.scene.getObjectByName('ctOld'), gone: !E.scene.getObjectByName('ctNew') };
        end();
        return out;
      });
      check('the error reaches the caller', /late commit failed/.test(r.msg ?? ''), r.msg);
      check('the old level is the level again, in the scene; the new one is gone', r.root === 'ctOld' && r.inScene && r.gone, J(r));
    },
  },
  {
    name: '[guard] Content transaction: an op no one defined, in a running game, refuses the load and leaves nothing of it, and the pack loads once the op exists',
    url: PAGE,
    async run({ check, ev }) {
      await page(ev);
      const r = await ev(async () => {
        const { E, state, end } = await window.__ct('ct-op', window.__full);
        let kindRan = 0;
        const tryLoad = async p => { try { await E.content.load(p); return null; } catch (err) { return err; } };   // bad data throws on the line
        const pack = {
          name: 'ctOp', actions: { ctJ: { label: 'J', keys: ['KeyJ'] } }, rules: { kinds: { ctSide: { desc: 'game code, no undo', load() { kindRan++; } } } }, ctSide: {},
          quests: { ctQ: { title: 'Q', steps: [{ text: 'W', done: { flag: 'never' } }], reward: { op: ['ctMissing.pay', {}] } } },
        };
        const before = state();
        const fail = await tryLoad(pack);
        const after = state(), ran = kindRan, keys = E.input.keysOf('ctJ'), quest = E.quests.defs.has('ctQ');
        // a pack in the replay list comes back when a module is put back: a refused one must not
        E.content._replay([E.modules.get('quests')]);
        const replayed = E.quests.defs.has('ctQ');
        const other = (await tryLoad({ name: 'ctOther', views: { ctOk: { position: [0, 1, 0] } } }))?.message ?? null;
        E.ops.define('ctMissing.pay', { run: () => {} });
        const retry = (await tryLoad(pack))?.message ?? null;
        const live = { keys: E.input.keysOf('ctJ'), quest: E.quests.defs.has('ctQ'), ran: kindRan };
        end();
        return { before, after, code: fail?.code, ran, keys, quest, replayed, other, retry, live };
      });
      check('the load answers unknown-name', r.code === 'unknown-name', r.code);
      check('state and registrations equal the state before the load', r.before === r.after, `${r.before}\n${r.after}`);
      check('the action and the quest are gone', !r.keys?.length && !r.quest, J(r));
      check('game code with no undo never ran for the refused load', r.ran === 0, r.ran);
      check('a replay does not bring the refused pack back', !r.replayed);
      check('the refused op does not block another pack', r.other === null, r.other);
      check('the same pack loads whole once the op exists', r.retry === null && r.live.quest && r.live.keys.includes('KeyJ') && r.live.ran === 1, J(r));
    },
  },
];
