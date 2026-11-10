// Engine services: the objects every engine owns besides rendering (events, i18n, saves, input, audio, assets, clock, ops, jobs, streaming...).
// Split out of the Engine constructor so it stays readable.
// The true order. At run time services call each other in a cycle (commits, ui, session, input, i18n, saves, clock, stacks, time), always through engine.x when a call
// happens, and nothing runs until createEngine returns. So the only order that counts is what a constructor reads itself:
//   i18n -> saves (its strings); events + saves -> stacks._hook; stacks + events -> input; stacks + saves -> time -> _poses; saves -> vars; ops -> defineSkipOp; events -> control.
//   saves.define calls set the order parts save and load: stacks, time, vars, random, scene, then the modules.
//   Made in Engine.js: stacks before this function (drawing parts define points); post, ui and page after it, so a constructor here must not touch those three.
//   Input binds keys before time exists, so an entry taken then is stamped 0 (Stacks._nowOf), which is what the calendar reads at that moment anyway.
// A new service goes below everything its constructor reads, and its line is added here; tests/specs/services-order.mjs fails when a constructor reads a service made after it.
// Splitting this into "construct all, then connect" would give some ten constructors a second method and the connect step would still keep the save order, so it stays one list.
import { Events } from '../base/Events.js';
import { Wraps } from '../ops/wrap.js';
import { I18n } from '../base/I18n.js';
import { Saves } from '../saves/Saves.js';
import { Session } from '../saves/session.js';
import { Input } from '../input/Input.js';
import { Audio } from '../audio/Audio.js';
import { Assets } from '../assets/Assets.js';
import { Clock } from '../time/Clock.js';
import { Vars } from '../base/Vars.js';
import { Budget } from '../inspect/Budget.js';
import { Rays } from '../scene/Rays.js';
import { Random } from '../base/Random.js';
import { UrlState } from '../inspect/UrlState.js';
import { Jobs } from '../threads/Jobs.js';
import { Threads } from '../threads/Threads.js';
import { Commits } from '../threads/Commits.js';
import { Ops } from '../ops/Ops.js';
import { Views } from '../scene/Views.js';
import { Stream } from '../stream/Stream.js';
import { Batching } from '../stream/Batching.js';
import { defineHoldStacks } from '../ops/holds.js';
import { Control } from '../ops/control.js';
import { StepPoses } from '../scene/stepPoses.js';
import { Time } from '../time/time.js';
import { DebugOverrides } from '../inspect/DebugOverrides.js';
import { describeApi } from '../inspect/Describe.js';
import { reportListenerError } from '../base/errors.js';
import { DEV } from '../base/validate.js';
import { defineSkipOp } from '../time/skip.js';
import { installThings } from '../scene/thingOps.js';
import { Plugins } from './plugins.js';
import { watchGameLights } from '../scene/gameLights.js';
import { tierChanged } from '../scene/tier.js';

/**
 * Create the engine services on `engine` (called once from the Engine constructor, after the renderer, scene and uniforms exist).
 * @param engine  the engine under construction
 * @param o  the createEngine options these services read, already defaulted by the constructor
 */
export function createServices(engine, { canvas, validate, locale, strings, saveKey, joystick, blockBrowserKeys, bindings, audio, decoders, budget, seed, headless, urlState, threads, batching }) {
  // DEV, not import.meta.env.DEV: the npm test bundle is a production build that sets THREEDOG_TEST, and the spelling check must run there too
  engine.events = new Events({ check: DEV && validate !== false,
    onError: (name, err) => reportListenerError(engine, name, err), now: () => engine.time.tick });   // listener errors are handled by severity (errors.js)
  engine.i18n = new I18n(engine, { locale, strings });
  engine.saves = new Saves(engine, { prefix: saveKey + '-' });
  engine.session = new Session(engine);          // new game / continue / back to title from a clean slate (session.js)
  // shared quantities (stacks.js): engine.mod(name, { owner, mul | add | set | clamp, for }) is the one way several systems change one
  engine.stacks._hook();   // one registry, made early by Engine.js (drawing parts register points); saves and events hook in now
  engine.mod = (name, o) => engine.stacks.mod(name, o);
  engine.stacks.define('input.gate', { kind: 'any', per: true });   // input.gate(action, owner): one entry per owner and action (Input.js)
  engine.input = new Input(engine, canvas, { joystick, bindings, blockBrowserKeys });
  engine.events.on('ui:open', id => engine._openWindows.add(id));
  engine.events.on('ui:close', id => engine._openWindows.delete(id));
  engine.audio = new Audio(engine, audio);
  engine._decoders = decoders;
  engine.assets = new Assets(engine);
  engine.control = new Control(engine);          // who decides where each character goes (control.js): one holder in charge per character
  // module methods (wrap.js): engine.wrap(engine.inventory, 'add', (next, ...a) => ...) is the one way to change what a public method does
  engine._wraps = new Wraps(engine);
  engine.wrap = (target, method, fn, o) => engine._wraps.wrap(target, method, fn, o);
  engine.clock = new Clock(engine);              // calendar clock (calendar seconds, timers); its rate is the stack 'clock.rate'
  engine.time = new Time(engine);                // time channels: world, player, the game's own (time.js)
  engine._poses = new StepPoses(engine);         // characters and rigid bodies drawn between fixed steps (stepPoses.js)
  engine.vars = new Vars(engine);                // story flags and counters
  engine.budget = new Budget(engine);            // performance budget (default off)
  if (budget) engine.budget.enable(budget);
  engine.rays = new Rays(engine);        // ray registry: engine.raycast / pick
  Object.assign(engine, describeApi(engine));     // describe / describeText / inspect / explain, see Describe.js
  engine.random = new Random(seed ?? (headless ? 1 : Date.now()));   // wall-clock: differs per run when no seed is given
  engine.saves.define('random', { atomic: true, save: () => engine.random.toJSON(), load: d => engine.random.fromJSON(d) });
  engine._urlState = new UrlState(engine, { fromUrl: urlState });
  // who holds the engine still: three named stacks (stacks.js: same owner rules as every shared quantity, holders in describe); haltLoop / freeze / takeCamera in holds.js
  defineHoldStacks(engine);
  // the one quality value (engine.tier): the device gives the base, the player's preset sets over it. settingsSet: on this point the player's choice is a choice, not a restriction
  engine.stacks.define('tier', { kind: 'value', base: engine._deviceTier, save: false, settingsSet: true, onChange: () => tierChanged(engine) });   // the post chain and cascades follow it (core/scene/tier.js onTierChange)
  engine.commits = new Commits(engine);          // background results that affect gameplay take effect on a fixed tick (see Commits.js)
  engine.ops = new Ops(engine);                  // one entry point for actions (define / run / can / list / recent), see Ops.js
  engine.views = new Views(engine);              // named fixed camera views for repeatable screenshots (Views.js)
  defineSkipOp(engine);                        // 'time.skip', behind engine.skip (skip.js)
  installThings(engine);                       // engine.add registry, thing.set / remove, 'scene' save part
  engine.plugins = new Plugins(engine);          // the plugins folder: files plugged by what they export (plugins.js)
  watchGameLights(engine);                     // plain PointLight / SpotLight: light budget, shadow switch (gameLights.js)
  engine.debug = new DebugOverrides(engine);     // diagnostic overrides and view modes, all core; the debug() panel module adds engine.debug.panel (DebugOverrides.js)
  engine.jobs = new Jobs(engine);                // frame-spread job scheduler
  engine.threads = new Threads(threads);       // worker pool (see Threads.js); workers start only when a lane is used
  // spatial stream-in and the stream sources (where the world is loaded: stream, models, terrain, colliders read them)
  engine.stream = new Stream(engine);
  engine.batching = new Batching(engine, batching);   // repeated static models drawn as InstancedMesh batches (Batching.js)
}
