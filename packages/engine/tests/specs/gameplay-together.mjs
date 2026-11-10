// The optional gameplay modules used together: who took what, how many times, and what a callback calling back in, a second conversation or a load leaves behind.
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] two seats: the second player walks into an auto pickup and a zone with the default who, as itself',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all;
        const E = mk(T.createEngine, 'seat-take');
        E.use(T.world(), T.collision(), T.characters(), T.inventory(), T.pickups(), T.triggers());
        await E.start(); E.haltLoop();
        E.inventory.define('coin', { name: 'Coin' });
        E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const seat = E.input.seat({ keys: { moveForward: 'KeyI' } });
        E.characters.addPlayer({ id: 'two', input: seat, control: 'camera', spawn: { x: 20, z: 0 } });
        const entered = [];
        E.triggers.add({ shape: 'sphere', position: [20, 0, 0], radius: 3, tag: 'p2', onEnter: (t, who, id) => entered.push(id) });
        E.triggers.add({ shape: 'sphere', position: [0, 0, 0], radius: 3, tag: 'p1', onEnter: (t, who, id) => entered.push(id) });
        E.pickups.spawn([20, 0, 0.5], { give: 'coin', count: 2, auto: true });
        E.pickups.spawn([40, 0, 0], { give: 'coin', auto: true, id: 'nobody' });
        E.step(0.2, { render: false });
        return { two: E.inventory.of('two').count('coin'), one: E.inventory.of('player').count('coin'), left: !!E.world.get('nobody'), entered };
      });
      check('the coin goes into the bag of the seat that touched it', r.two === 2 && r.one === 0 && r.left, JSON.stringify(r));
      check('each player enters the zone it stands in, under its own id', r.entered.includes('two') && r.entered.includes('player'), JSON.stringify(r));
    },
  },
  {
    name: '[guard] quest callback calling back in: advancing from quest:step pays the reward once, by hand and from a check',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'quest-reenter');
        E.use(T.world(), T.quests({ notify: false }));
        await E.start(); E.haltLoop();
        const paid = { hand: 0, check: 0 }, done = [];
        const def = k => ({ title: k, steps: [{ text: 'a', done: () => k === 'check' }, { text: 'b', done: () => false }], reward: () => { paid[k]++; } });
        E.quests.define('hand', def('hand')); E.quests.define('check', def('check'));
        E.events.on('quest:step', ({ id }) => { if (E.quests.isActive(id)) E.quests.advance(id); });   // "a cutscene ends the next step": the listener finishes it at once
        E.events.on('quest:done', ({ id }) => done.push(id));
        E.ops.allow(() => { E.quests.start('hand'); E.quests.start('check'); E.quests.advance('hand'); });
        E.step(1, { render: false });
        return { paid, done };
      });
      check('one reward each', r.paid.hand === 1 && r.paid.check === 1, JSON.stringify(r));
      check('one quest:done each', r.done.filter(x => x === 'hand').length === 1 && r.done.filter(x => x === 'check').length === 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] dialogue replaced while its onEnd opens the next one: no input lock or focus entry is left behind',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'dlg-reenter');
        E.use(T.dialogue());
        await E.start(); E.haltLoop();
        for (const n of ['a', 'b', 'c']) E.dialogue.define(n, { start: { text: n } });
        const ended = []; E.events.on('dialogue:end', s => ended.push(s));
        E.dialogue.start('a', 'start', () => E.dialogue.start('b'));   // a conversation with a follow-up...
        E.dialogue.start('c');                                         // ...interrupted, by a zone or a cutscene line
        const speaking = E.dialogue.speaking;
        E.step(0.05, { render: false });
        E.dialogue.end();
        E.step(0.05, { render: false });
        return { speaking, ended, after: E.dialogue.speaking, contexts: E.input.contexts, top: T.uiFocus(E).top ?? null, enabled: E.input.enabled };
      });
      check('the newest conversation holds the screen', r.speaking === 'c', JSON.stringify(r));
      check('every conversation ended once', r.ended.join() === 'a,b,c', JSON.stringify(r));
      check('input is back and nothing holds the UI focus', !r.after && !r.contexts.includes('dialog') && r.enabled && r.top === null, JSON.stringify(r));
    },
  },
  {
    // the checklist's flow: talk -> quest -> pickups into the bag -> a once-only zone runs a cutscene with a line -> step done -> reward; then the load puts it all back and the
    // same play pays out the same, once
    name: '[guard] one flow: dialogue, quest, pickups, inventory, once-only zone and cutscene; a save inside the cutscene loads back with no repeat and no lock',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, o = {};
        const E = mk(T.createEngine, 'one-flow');
        E.use(T.world(), T.collision(), T.characters(), T.interactions({ pick: 'nearest' }), T.inventory(), T.pickups(), T.quests({ notify: false, checkInterval: 0.05 }), T.dialogue({ charsPerSecond: 0 }), T.triggers(), T.timeline());
        await E.start(); E.haltLoop();
        const P = E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        const steps = s => E.step(s, { render: false });
        const bag = E.inventory.of('player');
        E.inventory.define('gem', { name: 'Gem' }); E.inventory.define('medal', { name: 'Medal' });
        let cutscenes = 0, zone = 0;
        E.quests.define('find', {
          title: 'Find', steps: [
            { id: 'gems', text: 'three gems', done: () => bag.count('gem') >= 3 },
            { id: 'watch', text: 'see the shrine', done: () => E.vars.flag('sawShrine') },
          ],
          reward: () => { bag.add('medal', 1); },
        });
        E.dialogue.define('elder', {
          start: { text: 'Help me?', choices: [{ text: 'Yes', next: 'yes', do: (s, e) => e.quests.start('find') }, { text: 'No', next: 'end' }] },
          yes: { text: 'Thanks.' },
        });
        E.triggers.add({ shape: 'sphere', position: [30, 0, 0], radius: 3, once: true, tag: 'shrine', onEnter: () => {
          zone++;
          E.timeline.play([{ say: { speaker: 'Elder', text: 'Look.' } }, { wait: 0.5 }, { do: e => { cutscenes++; e.vars.setFlag('sawShrine'); } }]);
        } });
        for (let i = 0; i < 2; i++) E.pickups.spawn([10 + i, 0, 0], { id: 'g' + i, give: 'gem', count: 2, auto: true });

        E.dialogue.start('elder');
        E.ops.run('dialogue.advance', {}); E.ops.run('dialogue.choose', { index: 0 }); E.ops.run('dialogue.advance', {});
        o.afterTalk = { active: E.quests.isActive('find'), speaking: E.dialogue.speaking };
        P.placeAt({ x: 10.5, z: 0 }); steps(0.2);
        o.gems = bag.count('gem'); o.ground = E.world.query({ kind: 'pickup' }).length;
        o.step = E.quests.state('find').step;
        P.placeAt({ x: 30, z: 0 }); steps(0.1);
        o.inCut = { zone, line: E.dialogue.speaking?.startsWith('__say_'), contexts: E.input.contexts.join() };
        // save with the line up and the cutscene running, then finish the play
        await E.saves.save('mid'); await E.saves.flush();
        const settle = () => new Promise(r => setTimeout(r, 0));
        E.ops.run('dialogue.advance', {}); await settle(); steps(0.7); await settle(); steps(0.2); await settle();
        o.first = { done: E.quests.isDone('find'), medals: bag.count('medal'), cutscenes, zone, contexts: E.input.contexts.join() };
        steps(0.5);
        o.noRepeat = { medals: bag.count('medal'), cutscenes, zone };
        // a quick load with a cutscene and a line running: what they were about to do belongs to the state the load threw away
        let stale = 0; const said = []; E.events.on('dialogue:line', l => said.push(l.node));
        E.timeline.play([{ wait: 1 }, { do: () => { stale++; } }]);
        E.dialogue.start('elder', 'yes');
        await E.saves.load('mid'); await settle(); steps(1.2); await settle(); steps(0.1); await settle();
        o.stale = stale;
        const bag2 = E.inventory.of('player');
        o.loaded = { done: E.quests.isDone('find'), step: E.quests.state('find').step, medals: bag2.count('medal'), gems: bag2.count('gem'), ground: E.world.query({ kind: 'pickup' }).length,
          used: E.saves.collect().parts?.triggers ?? null, speaking: E.dialogue.speaking, contexts: E.input.contexts.join(), runs: E.timeline.runs.size, zone };
        return o;
      });
      check('the choice starts the quest and the talk ends', r.afterTalk.active && !r.afterTalk.speaking, JSON.stringify(r));
      check('both piles in the bag, ground empty, step moved on', r.gems === 4 && r.ground === 0 && r.step === 1, JSON.stringify(r));
      check('the zone starts the cutscene with its line', r.inCut.zone === 1 && r.inCut.line, JSON.stringify(r));
      check('one reward, one cutscene, input free', r.first.done && r.first.medals === 1 && r.first.cutscenes === 1 && r.first.zone === 1 && r.first.contexts === 'walk', JSON.stringify(r));
      check('nothing repeats afterwards', r.noRepeat.medals === 1 && r.noRepeat.cutscenes === 1 && r.noRepeat.zone === 1, JSON.stringify(r));
      check('the load gives back the quest step and the items, without the reward', !r.loaded.done && r.loaded.step === 1 && r.loaded.medals === 0 && r.loaded.gems === 4 && r.loaded.ground === 0, JSON.stringify(r.loaded));
      check('a cutscene running at the load does not finish its steps in the loaded state', r.stale === 0, JSON.stringify(r.stale));
      check('and no line, cutscene or lock survives it, the once-only zone stays used', !r.loaded.speaking && r.loaded.contexts === 'walk' && r.loaded.runs === 0 && r.loaded.zone === 1, JSON.stringify(r.loaded));
    },
  },
];
