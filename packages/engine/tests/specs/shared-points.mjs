// Shared points: the "do not bypass" checks for the one ownership core (core/ops/sharedPoint.js, core/ops/stacks.js, ctx.mod / provides in modules.js).
//   - two different owners set one point on one layer: dev error naming both and the three fixes; the same owner rewriting is fine
//   - layer order: game set, effect mul, settings clamp, debug set; describe().shared shows value, writer, how it combined, who else
//   - settings only restricts: a settings set on a number, a mul above 1, a clamp floor, or set true on a value point throws; set false switches
//     it off, and the player's off holds over the system layer (a cutscene); only debug overrides it
//   - a module's ctx.mod entries and its exclusive slot leave with it (rollback, replaces, dispose); requires may name a slot
//   - bullet time keeps its one line; the dev hint says once why a game-set value shows differently
// Run in dev (the test bundle): npm test -- shared
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'shared points: conflict error, layer order, settings restrict only, describe().shared',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { mk, createEngine } = threedogThreads, out = {};
        const E = mk(createEngine, 'sp-core');
        const S = E.stacks, err = f => { try { f(); return null; } catch (x) { return { code: x.code, msg: x.message }; } };
        // world:remove clears per-record points; input.keys / input.gate are keyed by action, and a record may share an action's name
        E.input.bind('spFire', ['KeyF']);
        const stun = E.input.gate('spFire', { owner: 'spStun' });
        S.define('spHp', { per: true }); E.mod('spHp', { owner: 'x', id: 'spFire', mul: 2 });
        E.events.emit('world:remove', { id: 'spFire' });
        out.sameName = [E.input.keysOf('spFire').join(), S.get('input.gate').size('spFire'), S.get('spHp').size('spFire')];
        stun.remove();
        S.define('fog.far', { base: 600, min: 0 });
        const cave = E.mod('fog.far', { owner: 'cave', set: 180 });
        out.rewrite = err(() => E.mod('fog.far', { owner: 'cave', set: 170 }));   // same owner again: replaces its own entry
        out.clash = err(() => E.mod('fog.far', { owner: 'boss', set: 90 }));
        out.otherLayer = err(() => E.mod('fog.far', { owner: 'boss', set: 90, layer: 'effect' }));
        E.stacks.get('fog.far').release('boss');
        E.mod('fog.far', { owner: 'storm', mul: 0.5, layer: 'effect' });
        E.mod('fog.far', { owner: 'rain', mul: 0.8, layer: 'effect' });          // muls cooperate: never a conflict
        out.layered = S.get('fog.far').value();                                   // 170 x 0.5 x 0.8 = 68
        E.mod('fog.far', { owner: 'settings', clamp: { max: 50 }, layer: 'settings' });
        out.capped = S.get('fog.far').value();
        out.row = E.describe().shared['fog.far'];
        out.of = S.of('storm');
        E.mod('fog.far', { owner: 'debug', set: 999, layer: 'debug' });
        out.debug = S.get('fog.far').value();
        out.debugRow = E.describe().shared['fog.far'];
        // settings: restrict only
        out.setNum = err(() => E.mod('fog.far', { owner: 'settings', set: 2000, layer: 'settings' }));
        S.define('shadow.on', { kind: 'value', base: true });
        out.setTrue = err(() => E.mod('shadow.on', { owner: 'settings', set: true, layer: 'settings' }));
        E.mod('shadow.on', { owner: 'scene', set: false });
        E.mod('shadow.on', { owner: 'settings', set: false, layer: 'settings' });
        out.shadow = S.get('shadow.on').value();
        // settings never raise: mul above 1 or a clamp floor throws, saying what to write instead
        out.mulUp = err(() => E.mod('fog.far', { owner: 'settings', mul: 3, layer: 'settings' }));
        out.floor = err(() => E.mod('fog.far', { owner: 'settings', clamp: { min: 5 }, layer: 'settings' }));
        // the player's off holds over a cutscene on the system layer; debug still overrides it
        S.define('shake.on', { kind: 'value', base: true });
        E.mod('shake.on', { owner: 'settings', set: false, layer: 'settings' });
        const cut = E.mod('shake.on', { owner: 'cutscene', set: true, layer: 'system' });
        out.shakeCut = S.get('shake.on').value();
        out.shakeRow = E.describe().shared['shake.on'];
        E.mod('shake.on', { owner: 'debug', set: true, layer: 'debug' });
        out.shakeDebug = S.get('shake.on').value();
        cut.remove();
        out.badLayer = err(() => E.mod('fog.far', { owner: 'x', mul: 2, layer: 'top' }));
        // a bad number value fails on the way in, on engine.mod and on handle.change alike, and the value never becomes NaN
        out.badClamp = [{ max: 'oops' }, { max: NaN }, { min: 20, max: 5 }].map(c => err(() => E.mod('fog.far', { owner: 'bad', clamp: c }))?.code);
        const okClamp = E.mod('fog.far', { owner: 'bad', clamp: { max: 5000 } });
        out.badChange = [err(() => okClamp.change({ max: NaN }))?.code, err(() => okClamp.change({ min: 20, max: 5 }))?.code];
        out.afterBad = S.get('fog.far').value(); okClamp.remove();
        out.priorityGone = err(() => E.mod('fog.far', { owner: 'x', mul: 2, priority: 'effect' })) === null && S.get('fog.far').names().includes('x');
        cave.remove();
        E.dispose();
        return out;
      });
      check('a removed record clears its per-record entries, not the keys or gate of an action of that name', JSON.stringify(r.sameName) === '["KeyF",1,0]', JSON.stringify(r.sameName));
      check('the same owner rewriting its own value is not a conflict', r.rewrite === null, JSON.stringify(r.rewrite));
      check('two owners set on one layer: shared-conflict naming both owners', r.clash?.code === 'shared-conflict' && r.clash.msg.includes("'cave'") && r.clash.msg.includes("'boss'"), JSON.stringify(r.clash));
      check('... with the three copyable fixes (mul, another layer, take over)', /\(1\).*mul: 0\.5.*\(2\).*layer: 'effect'.*\(3\).*layer: 'system'/.test(r.clash?.msg ?? ''), r.clash?.msg);
      check('a set on another layer is fine', r.otherLayer === null, JSON.stringify(r.otherLayer));
      check('effects multiply on top of the game set: 170 x 0.5 x 0.8', Math.abs(r.layered - 68) < 1e-9, String(r.layered));
      check('settings clamp caps it', r.capped === 50, String(r.capped));
      check('describe().shared row: value, writer, layer, how, also', r.row.value === 50 && r.row.writer === 'cave' && r.row.layer === 'game'
        && r.row.how === 'cave 170 × storm 0.5 × rain 0.8 clamp settings ..50' && r.row.also.map(a => a.owner).join() === 'storm,rain,settings', JSON.stringify(r.row));
      check('stacks.of(owner) lists what one owner changes', r.of.length === 1 && r.of[0].startsWith('fog.far (mul 0.5, effect)'), JSON.stringify(r.of));
      check('a debug set hides every layer below (marked hidden)', r.debug === 999 && r.debugRow.writer === 'debug' && r.debugRow.also.find(a => a.owner === 'cave')?.hidden === true, JSON.stringify(r.debugRow));
      check('settings cannot set a number (only clamp / mul)', r.setNum?.code === 'shared-settings', JSON.stringify(r.setNum));
      check('settings cannot force a value point on', r.setTrue?.code === 'shared-settings', JSON.stringify(r.setTrue));
      check('settings set false agrees with a scene that turned it off', r.shadow === false);
      check('settings cannot raise a number: mul above 1 throws, the fix names a 0..1 factor and the game layer', r.mulUp?.code === 'shared-settings' && /0 to 1/.test(r.mulUp.msg) && /game layer/.test(r.mulUp.msg), JSON.stringify(r.mulUp));
      check('settings cannot set a floor: clamp { min } throws, the fix names clamp { max }', r.floor?.code === 'shared-settings' && /clamp: { max/.test(r.floor.msg), JSON.stringify(r.floor));
      check("the player's off holds over a cutscene's system-layer on (writer settings, the cutscene listed hidden)", r.shakeCut === false && r.shakeRow?.writer === 'settings' && r.shakeRow.also.find(a => a.owner === 'cutscene')?.hidden === true, JSON.stringify(r.shakeRow));
      check('only the debug layer overrides the player', r.shakeDebug === true);
      check('an unknown layer throws shared-layer', r.badLayer?.code === 'shared-layer', JSON.stringify(r.badLayer));
      check('clamp max a string / NaN / min > max throw shared-value on engine.mod and on handle.change, and the value stays a number', r.badClamp.every(c => c === 'shared-value') && r.badChange.every(c => c === 'shared-value') && Number.isFinite(r.afterBad), JSON.stringify([r.badClamp, r.badChange, r.afterBad]));
      check('the old priority option is gone (only an unknown-option warning)', r.priorityGone);
    },
  },
  {
    name: 'shared points: ctx.mod and exclusive slots leave with the module (rollback, replaces, dispose); bullet time; dev hint',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, out = {};
        const E = mk(createEngine, 'sp-mods');
        const S = E.stacks, err = f => { try { f(); return null; } catch (x) { return { code: x.code, msg: x.message }; } };
        // rollback: the batch fails after storm installed, so storm's ctx.mod entry goes too
        const storm = () => ({ name: 'spStorm', type: 'rules', install(e, ctx) { ctx.mod('time.world', { mul: 0.8, layer: 'effect' }); } });
        out.rollback = err(() => E.use(storm(), { name: 'spBoom', type: 'rules', install() { throw new Error('boom'); } }));
        out.afterRollback = S.get('time.world').names();
        out.ownerArg = err(() => E.use({ name: 'spOwner', type: 'rules', install(e, ctx) { ctx.mod('time.world', { owner: 'x', mul: 2 }); } }));
        // slots
        const bag = () => ({ name: 'spBag', type: 'rules', provides: ['inventory'], install(e, ctx) { ctx.mod('time.world', { mul: 0.9, layer: 'effect' }); } });
        const myBag = () => ({ name: 'spMyBag', type: 'rules', provides: ['inventory'] });
        E.use(bag(), { name: 'spShop', type: 'rules', requires: ['inventory'] });   // requires names the slot, not the module
        out.holder = S.get('inventory').value();
        out.taken = err(() => E.use(myBag()));
        out.stillBag = E.has('spBag') && !E.has('spMyBag');
        out.notProvided = err(() => E.use({ name: 'spOther', type: 'rules' }, { replaces: 'inventory' }));
        E.use(myBag(), { replaces: 'inventory' });
        out.swapped = { holder: S.get('inventory').value(), bagGone: !E.has('spBag') && !('spBag' in E), worldOwners: S.get('time.world').names(), shop: E.has('spShop') };
        out.row = E.describe().shared.inventory;
        // bullet time: one line, unchanged
        await E.start();
        E.time.channel('enemies');
        E.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });
        out.bullet = E.time.scale('enemies');
        E.step(2.1, { render: false });
        out.bulletEnded = E.time.scale('enemies');
        // dev hint: a game set shown differently because an effect multiplied it, said once
        const infos = [], i0 = console.info; console.info = (...x) => infos.push(x.join(' '));
        try {
          S.define('sp.sun', { base: 1 });
          E.mod('sp.sun', { owner: 'game', set: 3 }); E.mod('sp.sun', { owner: 'weather', mul: 0.6, layer: 'effect' });
          S.get('sp.sun').value(); E.mod('sp.sun', { owner: 'weather', mul: 0.5, layer: 'effect' }); S.get('sp.sun').value();
        } finally { console.info = i0; }
        out.hints = infos.filter(x => x.includes('sp.sun'));
        E.dispose();
        out.disposed = S.get('time.world').names().concat(S.get('inventory').names());
        return out;
      });
      check('a rolled-back module takes its ctx.mod entries with it', r.rollback?.msg?.includes('boom') && !r.afterRollback.includes('spStorm'), JSON.stringify(r));
      check('ctx.mod names the module itself (an owner option throws)', r.ownerArg?.code === 'mod-owner', JSON.stringify(r.ownerArg));
      check('provides takes the slot; requires may name the slot', r.holder === 'spBag');
      check('a second provider throws shared-taken naming both and the replaces fix', r.taken?.code === 'shared-taken' && r.taken.msg.includes('module spBag') && r.taken.msg.includes("replaces: 'inventory'") && r.stillBag, JSON.stringify(r.taken));
      check('replaces needs a module in the call that provides the slot', r.notProvided?.code === 'module-replaces', JSON.stringify(r.notProvided));
      check('replaces unloads the holder and its changes; the dependent stays', r.swapped.holder === 'spMyBag' && r.swapped.bagGone && !r.swapped.worldOwners.includes('spBag') && r.swapped.shop, JSON.stringify(r.swapped));
      check('describe().shared shows the slot holder', r.row?.writer === 'spMyBag' && r.row.value === 'spMyBag', JSON.stringify(r.row));
      check('bullet time: engine.mod time.enemies mul 0.35 for 2, then back to 1', Math.abs(r.bullet - 0.35) < 1e-9 && r.bulletEnded === 1, `${r.bullet} ${r.bulletEnded}`);
      check('dev hint once: game set 3 shown 1.8 because weather x0.6, with the lock line', r.hints.length === 1 && r.hints[0].includes('shown 1.8') && r.hints[0].includes('weather') && r.hints[0].includes("layer: 'system'"), JSON.stringify(r.hints));
      check('dispose releases every module entry and slot', r.disposed.length === 0, JSON.stringify(r.disposed));
    },
  },
  {
    name: 'replaces: characters, flow and cameraRig each swap for a part that provides the slot',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, world, collision, characters, all } = threedogThreads;
        const E = mk(createEngine, 'sp-replace'), out = { ran: {} }, slots = ['characters', 'flow', 'cameraRig'];
        E.use(world(), collision(), characters(), all.flow(), all.followCamera(), { name: 'spUser', type: 'rules', requires: slots });
        await E.start();
        E.characters.addPlayer({ ...all.presets.player.thirdPerson, spawn: [0, 0, 0] });
        E.step(0.1, { render: false });
        for (const slot of slots) {
          // the callers of each slot keep running on the stand-in: the steps below are the proof
          const mine = { name: 'my-' + slot, type: 'rules', provides: [slot], fixed() { out.ran[slot] = true; }, install: () => ({ mine: slot, define() {}, go() {}, transition() {},
            forward: () => ({ x: 0, z: -1 }), right: () => ({ x: 1, z: 0 }), follow() {}, focusPoint: () => E.focus, screenToGround: () => null, target: null, carryRiders() {}, removePlayer() {} }) };
          E.use(mine, { replaces: slot });
          E.step(0.1, { render: false });
          out[slot] = { api: E[slot]?.mine, holder: E.stacks.get(slot).value(), held: E.has('my-' + slot), dependent: E.has('spUser') };
        }
        out.setCamera = E.setCamera?.toString().slice(0, 60);
        E.dispose();
        return out;
      });
      for (const slot of ['characters', 'flow', 'cameraRig']) check(`replaces '${slot}': the newcomer holds the slot, engine.${slot} is its API, the dependent stays, steps run`,
        r[slot]?.api === slot && r[slot].holder === 'my-' + slot && r[slot].held && r[slot].dependent && r.ran[slot], JSON.stringify(r));
    },
  },
];
