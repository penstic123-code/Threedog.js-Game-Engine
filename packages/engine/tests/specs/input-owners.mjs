// Input by context, can't-bypass checks (docs/plans/done/2026-11-03-ownership-design.md section 4):
//   - no built-in module binds a key: every built-in module installed with no bindings leaves only the basics with keys
//   - static: key names ('KeyQ', 'Digit1', 'F3', 'Backspace'...) never appear in modules/, ui/ or render/ code (only core/input/inputDefaults.js and
//     presets.js name keys; the rest of core/ is the input layer itself: key events, gamepad buttons, key display names)
//   - two owners binding one action -> input-bound-twice with the fix; two contexts for one action -> input-action-context
//   - an unbound action a module needs -> input-unbound once naming the one-line bind; an optional one stays silent
//   - a module's declarations and bindings leave with it (ctx.input); the settings menu rebinds only through input.rebind
// Run: npm test -- "input owners"
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = '/tests/threads/';
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY_NAME = /[[,(=:?]\s*'(Key[A-Z]|Digit\d|Numpad\d|F\d{1,2}|Backspace|Escape|Space|Enter|ShiftLeft|Tab|Pad[A-Z]\w*)'/g;

const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
// what remains of a source once comments and message texts are gone: a key named inside an error's fix text is a hint, not a binding
const codeOnly = src => src
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

export const specs = [
  {
    name: 'input owners: no module binds a key, modules / ui name no key (only the default preset and presets.js do) [guard]',
    url: PAGE,
    async run({ check, ev }) {
      // static half: module, UI and render code (a key a module names is a default the game did not choose)
      const files = ['modules', 'ui', 'render'].flatMap(d => walk(join(ENGINE, d)));
      const hits = [];
      for (const f of files) {
        const rel = relative(ENGINE, f).replace(/\\/g, '/');
        const code = codeOnly(readFileSync(f, 'utf8'));
        for (const m of code.matchAll(KEY_NAME)) hits.push(`${rel}: '${m[1]}'`);
      }
      check('[guard] modules/, ui/, render/ name no key (keys live in core/input/inputDefaults.js and presets.js)', !hits.length, hits.slice(0, 12).join('; '));

      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(createEngine, 'io-all');
        // every built-in module; modules take no keys, so nothing is bound here
        E.use(...T.openWorld({ seed: 1, camera: 'follow', debug: true }), T.interactions({ ...T.presets.interactions.nearest }), T.dialogue(), T.inventory(),
          T.pickups(), T.quests(), T.photo(), T.triggers(), T.particles(), T.music(), T.timeline(), T.nav(), T.content(), T.flow(), T.hud(), T.grids());
        E.setCamera('rts');   // the strategy camera declares rotateLeft / rotateRight when switched in
        const basics = ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'confirm', 'cancel', 'uiUp', 'uiDown', 'uiLeft', 'uiRight'];
        out.bound = [...E.input.actions.keys()].filter(a => !basics.includes(a) && E.input.keysOf(a).length).map(a => `${a}: ${E.input.keysOf(a).join('/')}`);
        // level holds the ground terrain holds in openWorld, so it is checked on its own engine
        const L = mk(createEngine, 'io-level');
        L.use(T.level());
        out.bound.push(...[...L.input.actions.keys()].filter(a => !basics.includes(a) && L.input.keysOf(a).length));
        L.dispose();
        out.declared = ['choice1', 'choice9', 'skip', 'debugPanel', 'triggersDebug', 'rotateLeft'].filter(a => E.input.actions.has(a));
        out.contexts = { choice1: E.input.actions.get('choice1')?.context, skip: E.input.actions.get('skip')?.context };
        out.basics = basics.every(a => E.input.keysOf(a).length > 0);
        // a preset map binds them in one line
        E.input.bind({ ...T.presets.bindings.dialogNumbers, ...T.presets.bindings.rtsRotate, ...T.presets.bindings.cutsceneSkip, ...T.presets.bindings.debug });
        out.preset = [E.input.keysOf('choice1').includes('Digit1'), E.input.keysOf('rotateLeft').includes('KeyQ'), E.input.keysOf('skip').includes('Backspace'), E.input.keysOf('debugPanel').includes('F3')];
        out.writer = E.describe().shared['input.keys[choice1]']?.writer;
        E.dispose();
        return out;
      });
      check('[guard] with every built-in module installed and no bindings, only the basics have keys', !r.bound.length && r.basics, JSON.stringify(r.bound));
      check('dialogue / timeline / debug / triggers / rts declare their actions (no keys), each in its context', r.declared.length === 6 && r.contexts.choice1 === 'dialog' && r.contexts.skip === 'cutscene', JSON.stringify(r));
      check('presets.bindings.* bind them in one call, owned by the game', r.preset.every(Boolean) && r.writer === 'game', JSON.stringify(r));
    },
  },
  {
    name: 'input owners: bound twice / two contexts throw with the fix, unbound needed action warns once, module bindings leave with it, settings rebinds through input.rebind [guard]',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, T = threedogThreads.all, out = {};
        const err = f => { try { f(); return null; } catch (e) { return String(e.message); } };
        const warns = [], w0 = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
        const E = mk(createEngine, 'io-rules', { bindings: { ioJump: ['KeyJ'] } });
        out.twice = err(() => E.input.bind('ioJump', ['KeyK'], { owner: 'someModule' }));
        E.input.bind('ioJump', ['KeyH']); out.same = E.input.keysOf('ioJump').join();   // the same owner binding again replaces its own keys
        E.input.define('ioTalk', { context: 'dialog', owner: 'modA' });
        out.ctx = err(() => E.input.define('ioTalk', { context: 'walk', owner: 'modB' }));
        out.shared = err(() => E.input.define('ioTalk', { context: 'dialog', owner: 'modB' }));   // same context: the two share one action
        E.input.define('ioNeed', { owner: 'modA' }); E.input.define('ioMaybe', { owner: 'modA', optional: true });
        E.input.pressed('ioNeed'); E.input.pressed('ioNeed'); E.input.pressed('ioMaybe');
        out.unbound = warns.filter(w => w.includes("'ioNeed'") && w.includes("engine.input.bind('ioNeed'")).length;
        out.maybe = warns.filter(w => w.includes("'ioMaybe'")).length;
        out.describe = E.describe().input;
        // a module's declarations and bindings go with it: the batch rolls back, nothing stays
        const mod = { name: 'ioMod', type: 'rules', install(e, ctx) { ctx.input.define('ioModAct', { keys: ['KeyT'] }); ctx.input.bind('ioJump2', ['KeyY']); } };
        out.rollback = err(() => E.use(mod, { name: 'ioBoom', type: 'rules', install() { throw new Error('io boom'); } }));
        out.left = [E.input.actions.has('ioModAct'), E.input.keysOf('ioModAct').length, E.input.keysOf('ioJump2').length];
        // a declaration leaving takes only itself: keys the game bound stay readable; an action nobody bound goes with it
        E.input.bind('ioKept', ['KeyI']);
        E.input.define('ioKept', { owner: 'ioDecl' }).remove();
        E.input.define('ioAlone', { owner: 'ioDecl' }).remove();
        out.declLeft = [E.input.actions.has('ioKept'), E.input.keysOf('ioKept').join(), E.input.actions.has('ioAlone')];
        // settings: the player's key is the settings layer of 'input.keys', saved and reset through input.rebind
        const S = mk(createEngine, 'io-settings');
        S.use(T.settings()); await S.start();
        S.settings.rebind('confirm', 'KeyK');
        out.rebound = S.input.rebound(); out.keys = S.input.keysOf('confirm').join(); out.writer = S.describe().shared['input.keys[confirm]']?.writer;
        out.saved = JSON.parse(localStorage.getItem(S.settings.storageKey) || '{}').bindings;
        S.settings.resetBindings();
        out.reset = { rebound: S.input.rebound(), keys: S.input.keysOf('confirm').join() };
        console.warn = w0;
        E.dispose(); S.dispose();
        localStorage.removeItem(S.settings.storageKey);
        return out;
      });
      const J = JSON.stringify(r);
      check('a declaration removed leaves keys the game bound; an unbound action goes with it', JSON.stringify(r.declLeft) === '[true,"KeyI",false]', JSON.stringify(r.declLeft));
      check('[guard] a second owner binding one action throws input-bound-twice naming both and the fix', /input-bound-twice/.test(r.twice ?? '') && /'game'/.test(r.twice) && /someModule/.test(r.twice) && /Fix/.test(r.twice), J);
      check('the same owner binding again replaces its keys', r.same === 'KeyH', J);
      check('[guard] one action in two contexts throws input-action-context; the same context is shared', /input-action-context/.test(r.ctx ?? '') && r.shared === null, J);
      check('[guard] reading a needed action nobody bound warns once with the one-line bind; optional stays silent', r.unbound === 1 && r.maybe === 0 && r.describe.unbound.includes('ioNeed') && !r.describe.unbound.includes('ioMaybe'), J);
      check('[guard] a module\'s declarations and bindings leave with it (ctx.input)', /io boom/.test(r.rollback ?? '') && r.left.every(v => !v), J);
      check('[guard] settings rebinding goes through input.rebind: settings layer, saved, reset back to the default', r.rebound.confirm?.[0] === 'KeyK' && r.keys.startsWith('KeyK') && r.writer === 'settings'
        && r.saved?.confirm?.[0] === 'KeyK' && !Object.keys(r.reset.rebound).length && r.reset.keys === 'Space,Enter,PadA', J);
    },
  },
];
