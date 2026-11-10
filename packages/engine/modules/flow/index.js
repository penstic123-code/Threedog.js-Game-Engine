// Game flow: states and scene transitions.
// States: title, playing, paused, game over...; transitions: fade out, swap scene, fade in.
//   engine.use(flow());                               // built-in 'playing' (default) and 'paused' (freezes gameplay + locks input)
//   engine.flow.define('title', { enter: e => showTitle(), exit: e => hideTitle(), freeze: true, lockInput: true, music: 'title' });
//   engine.flow.go('paused');  engine.flow.state      // 'paused'
//   await engine.flow.transition(async () => engine.level.load('/models/town2.glb'));   // lock input, fade out, load level, wait for ready, fade in
// Pause has one entry point: flow's 'paused' (internally engine.freeze('flow'); rendering continues); settings({ freezeWorld: true }) switches to it when the menu opens.
// engine.haltLoop() is another thing: it stops rendering too, for tests only. While frozen: fixed step, module fixed hooks, game clock, quest checks, timeline wait/tween all stop.
// engine.session.newGame / load / quit move flow too: back to the start state when a playthrough ends, then 'playing' when the next starts.
// Esc is not handled here: back goes through the UI focus stack (ui/Focus.js), and opens the settings menu when the stack is empty. Events: flow:change { from, to }, flow:transition { phase: 'start' | 'end' }.
import { warnMissing } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { fadeScreen } from '../../ui/UI.js';
import { whenSettled } from '../../core/engine/headlessLoad.js';
import { stateTurn } from '../../core/saves/stateReplace.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { Flow, FlowOptions } from '../../types/gameplay' */

const STATE_KEYS = ['enter', 'exit', 'freeze', 'lockInput', 'music'];

const FLOW_PARAMS = keysSchema(['start']);

/**
 * Game flow and scene transitions → engine.flow
 * @param {FlowOptions} [opts]
 * @returns {ModuleDef<Flow>}
 */
export function flow(opts = {}) {
  readParams('flow', FLOW_PARAMS, opts);
  let e = null, sig = null, chain = Promise.resolve(), held = null, frozen = null, leaving = false, queued = null;
  const states = new Map([['playing', {}], ['paused', { freeze: true, lockInput: true }]]);
  // turn freeze / input lock on or off for one state
  const hold = (def, on) => {
    if (def.freeze) { if (on) frozen ??= e.freeze('flow'); else { frozen?.remove(); frozen = null; } }
    if (def.lockInput) { if (on) held ??= e.input.push('flow'); else { held?.remove(); held = null; } }
  };

  const api = {
    /** Current state name */
    state: 'playing',
    /** True while a scene transition is running */
    transitioning: false,
    /** Define a state: { enter(e, from), exit(e, to), freeze, lockInput, music } */
    define(name, def) { readParams(`flow.define('${name}')`, keysSchema(STATE_KEYS), def); states.set(name, def); return api; },
    /** Switch state */
    go(name) {
      const to = states.get(name);
      if (!to) { warnMissing('flowState', name, [...states.keys()]); return; }
      // a go() asked from inside an exit waits for it: the state is still the old one there, and leaving it twice would recurse or overwrite the state just entered
      if (leaving) { queued = name; return; }
      const from = api.state, def = states.get(from);
      if (from === name) return;
      leaving = true;
      try { def.exit?.(e, name); } catch (err) { queued = null; throw err; } finally { leaving = false; }
      hold(def, false);
      api.state = name;
      hold(to, true);
      if (to.music !== undefined) to.music === null ? e.music?.stop() : e.music?.play(to.music);
      try { to.enter?.(e, from); e.events.emit('flow:change', { from, to: name }); } catch (err) { queued = null; throw err; }
      if (queued !== null) { const next = queued; queued = null; api.go(next); }   // the exit's own go(), now that this change is complete
    },
    /** Scene transition: lock input → fade out → fade music → (autosave: 'auto' saves slot 'auto') → fn() → wait for modules ready → fade in → unlock. Repeated calls are queued.
     *  A new game or load that goes through before the fade out ends drops the transition, one still in line included, as if it was never asked: fn was written for the state that is gone.
     *  One that fails gives the state back, so the transition goes on, like stream.teleport: it waits for the end of a load under way, unless it was asked inside that load, which cannot wait for itself */
    transition(fn, o = {}) {
      readParams('flow.transition()', keysSchema(['fade', 'lockInput', 'music', 'autosave']), o);
      const { fade = 0.5, lockInput = true, music = 'fade', autosave = false } = o, generation = e.saves.generation;
      const replaced = () => e.saves.generation !== generation, waits = !e.saves.replacing;
      const gone = async () => { if (!replaced()) return false; if (waits) await e.saves.settled(); return replaced(); };
      const run = async () => {
        if (await gone()) return;
        api.transitioning = true;
        e.events.emit('flow:transition', { phase: 'start' });
        const lock = lockInput ? e.input.push('transition') : null;
        let shown = false, turn = null;
        try {
          await fadeScreen(e, 1, { seconds: fade });
          if (sig?.aborted || await gone()) return;   // unloaded, or the state replaced, during the fade: no scene swap for what is gone (the finally gives the screen and input back)
          const m = music === 'fade' ? e.music : null, prev = m?.current;
          m?.stop({ fade });
          if (autosave === 'auto') e.saves.save('auto');
          turn = stateTurn(e);   // from here until the far door stands, the world is between two states
          await e.ops.allow(async () => { await fn?.(); });   // the scene swap is loading: the ops guard lets its writes through
          await whenSettled(e, undefined, true);
          if (sig?.aborted) return;
          if (m && prev && !m.current && !m.ruled && !replaced()) m.play(prev);   // no track rule: resume the previous track after the switch. A new game or load has its own music, however fn started it; a level load nobody awaited is still this playthrough
          await fadeScreen(e, 0, { seconds: fade });
          shown = true;
        } finally {
          if (!shown) fadeScreen(e, 0, { seconds: 0 });   // fn threw: don't leave the screen black, fade back in at once (the error still propagates to the caller)
          turn?.remove();
          lock?.remove();
          api.transitioning = false;
          e.events.emit('flow:transition', { phase: 'end' });
        }
      };
      return (chain = chain.then(run, run));
    },
  };
  return {
    name: 'flow', skipKind: 'none', type: 'rules', provides: ['flow'], params: FLOW_PARAMS, options: opts, label: 'Game flow', optional: ['music'],
    install(engine, ctx) { engine.i18n.add({ 'zh-CN': { 'module.flow': '游戏流程' }, en: { 'module.flow': 'game flow' } });
      e = engine; sig = ctx.signal;
      // initial state (title screen etc.): entered once the world is ready, so the game can define it after use()
      if (opts.start && opts.start !== 'playing') ctx.track(e.events.once('engine:ready', () => api.go(opts.start)));
      // a playthrough ends (engine.session): back to the start state, so its enter() runs again; a new one starts in 'playing'
      // a failed replacement keeps the old playthrough: back to the state it was in
      let before = null;
      // the state goes after every session:end listener: the start state may start things (a title track) that another listener of the same event ends (music stops there), and install order must not decide which won
      ctx.track(e.events.on('session:end', () => { before = api.state; queueMicrotask(() => { if (!sig.aborted) api.go(opts.start ?? 'playing'); }); }));
      ctx.track(e.events.on('session:start', () => api.go('playing')));
      ctx.track(e.events.on('session:failed', ({ kind }) => { if (before && kind !== 'quick') api.go(before); }));   // a quick load ended nothing here
      return api;
    },
    // unloaded (unuse, replaces) in a state that stops the game: nothing else would ever end its freeze or input lock
    dispose() { frozen?.remove(); held?.remove(); frozen = held = null; },
    // ?play / applyState({ play }): leave the start state (a title) the way its Start button does; session:start then goes to 'playing'
    stateKeys: ['play'],
    applyState(e, { play }, turn) { if (play != null && opts.start && opts.start !== 'playing' && api.state === opts.start) return e.session.newGame({ turn }); },   // inside the scene request's turn: in line it would wait for itself
    describe() { return { state: api.state, transitioning: api.transitioning }; },
  };
}

export const handRolled = 'none: a scene change is a few ordinary calls in any order';
