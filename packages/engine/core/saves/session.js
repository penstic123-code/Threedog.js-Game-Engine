// engine.session: one playthrough, from "new game" or "load" until the next one. Starting a playthrough leaves nothing of the previous one behind.
//   engine.session.newGame()             // the state right after start() (world, containers, vars, quests, clock, calendar, weather, random...), as if the page had just opened
//   await engine.session.load('slot1')    // continue, or retry from a checkpoint: the new-game state with the save on top (a part the save lacks gets its new-game state)
//   engine.session.quit()                // back to the title screen with a clean slate (the title's Start calls newGame)
//   engine.session.track(handle)          // a listener / timer / hook the game adds during play: removed when the playthrough ends
// Versus engine.saves.load(slot): that applies a save onto the running playthrough (quick load) and keeps what the game added during play.
// Deleting a save is engine.saves.remove(slot); none of these touch stored saves.
//
// What ending a playthrough clears: handles passed to track() and clock function timers added after start() (boot-time ones and a module's install-time ones, ctx.track, follow the module: they come back with their original delay while it stays; what a part's load() or an afterLoad sets up belongs to the new playthrough and stays),
// a running engine.skip (cancelled), background results not yet applied (commits: worker / job results requested in the old playthrough never land), and every
// save part (the state captured when start() finished is applied). Modules end their own part on 'session:end' (a cutscene is skipped, the music stops),
// and the camera starts over on 'session:start' (the same rig object, as installed, keeping the view the load left on it). Listeners and hooks the game registered at boot stay: they belong to the game, not the playthrough.
// engine.time.tick and every time view (core/time/time.js) start again from 0 or the save's value, and physics (rigid) rebuilds its world (velocities, sleep, solver caches), as on a fresh page.
// Events: 'session:end' (before the reset; flow returns to its start state), 'session:start' { kind: 'new' | 'load', slot? } (after; flow goes to 'playing').
// Around a state replacement, one list for every door (saves.apply, saves.load, session.newGame / load / quit):
//   a save put back    'save:loaded' with its slot ('(data)' for saves.apply): what is not saved ends, what is derived rebuilds. The playthrough runs from here: the title closes (_started)
//   a new state        session.* also end the old playthrough first ('session:end') and announce the new one ('session:start')
//   rolled back        'session:failed' { kind, slot? }, kind 'quick' from saves.load / apply: what an end or a load took down comes back on this event, whichever door it was
//   quit               no playthrough runs until a new one starts: session.playing is false even with no title part, so autosave cannot write the blank state over a save
// A replacement that fails (a save part's load() threw: saveApply rolled the data back) keeps the old playthrough: tracked handles, function timers
// and clocks stay as they were, background results still land, no 'session:start' or title follows, 'session:failed' { kind, slot? } fires instead (flow goes back to the state it left).
// What session:end already ended stays ended (the music stopped, a running cutscene was skipped to its end).
import { codedError, coded } from '../base/errorHints.js';
import { removeEach, reportError } from '../base/errors.js';
import { DEV as IS_DEV, fmt } from '../base/validate.js';
import { applySave, partData } from './saveApply.js';
import { readSave } from './saveVersions.js';

const DEV = {
  early: 'engine.session.{fn}() was called before engine.start() finished: the new-game state is captured when loading completes. Call it from a button or after `await engine.start()`.',
  missed: "a 'session:start' listener was added after engine.start() returned, but the playthrough had already started inside start() (?play, or newGame / load during start): it waits for the next new game and did not run for this one. Add it before `await engine.start()`, or read the state after start (engine.session.playing, engine.events.recent('session:start')).",
  badHandle: 'engine.session.track(handle): handle must have remove(), like the result of engine.events.on / onFixed / clock.after. Got {got}.'
};

/**
 * The fixed-step hook behind saves.autosave: saves 'auto' every `every` fixed seconds of play; outside play (session.playing false, or a gameplay error) it counts from zero again.
 * @param {any} saves
 * @param {number} every  fixed seconds
 * @param {() => void} onRemove
 * @returns {{ remove(): void }}
 * @internal
 */
export function autosaveHook(saves, every, onRemove) {
  const e = saves.engine;
  let t = 0;
  const tick = e.onFixed(dt => {
    if (!e.session.playing || e.error) { t = 0; return; }   // nothing of a playthrough to keep: start counting again once one runs
    if ((t += dt) < every || saves._replace.turns) return;   // in a door trip or a cutscene it waits, and goes on the first step after (stateReplace.js)
    t = 0; saves.save('auto');
  });
  return { remove: () => { tick.remove(); onRemove(); } };
}

/** engine.session: new game / continue / back to title, each from a clean slate. */
export class Session {
  /** @internal */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** @internal JSON of the state when start() finished */ this._base = null;
    /** @internal clock function timers at that moment, with their remaining delay */ this._timers = [];
    /** @internal */ this._tracked = new Set();
    /** @internal parts _late captured from a module still installing */ this._lateParts = new Set();
    /** @internal true after a quit with no title to stand for it, until a save or new game starts a playthrough: nothing else would say no playthrough runs */ this._over = false;
    /** @internal true while newGame / load / quit replace the state. Shorter than the turn (stateReplace.js): session:start listeners run inside the turn and are in play */ this._busy = false;
    /** @internal Which playthrough this is: 1 after the page opens, one more with each newGame / load / quit that went through (a quick saves.load stays in the playthrough). Not saved. Ops carry it as ctx.session */
    this.id = 1;
  }

  /**
   * True while a playthrough runs: start() has finished, no newGame / load / quit is replacing the state, and neither the title screen nor a finished quit stands in its place.
   * Autosave and other "only during play" work check it.
   * @type {boolean}
   * @experimental
   */
  get playing() { return !!this._base && !this._busy && !this._over && !this.engine.ui.isOpen('title'); }

  /** @internal start() finished: what changes now is not in the new-game state */
  get captured() { return !!this._base; }
  /** @internal newGame / load / quit are replacing the state; saves.load and saves.apply are not this */
  get replacing() { return this._busy; }

  /** @internal A state to play went in, by any door: it runs from here. The door decides, not each menu: a load from the settings over the title left the title up on a frozen game */
  _started() { this._over = false; this.engine.ui.close('title'); }

  /** @internal Called by start() once the world is ready: what newGame returns to */
  _capture() {
    const base = this.engine.saves.collect();
    // each part checks its own new-game data (world: no records placed by code). Core only hands the data over: it never reads a part's format
    if (IS_DEV) for (const [key, p] of this.engine.saves.providers) if (p.checkNewGame && Object.hasOwn(base.parts, key)) p.checkNewGame(base.parts[key]);
    this._base = JSON.stringify(base);
    this._timers = this.engine.time._snapshotFn();
  }

  /**
   * @internal A save part registered after start() (engine.use later): its state now is its new-game state, so newGame resets it too. Data of that key stays while this part can
   * read it, by the same check a load makes; left from a part it replaced at another version, it would refuse every new game for good.
   */
  _late(key) {
    if (!this._base) return;
    const base = JSON.parse(this._base), p = this.engine.saves.providers.get(key);
    if (Object.hasOwn(base.parts, key) && 'list' in readSave(base, new Map([[key, p]]), '(new game)')) return;
    delete base.parts[key]; delete base.versions[key];
    this._lateParts.add(key);
    // its save() cannot run yet, or has nothing to save (like collectParts): newGame leaves this part as it is. Data a save cannot hold is said now: it would refuse every save too
    try { const d = partData(key, p); if (d != null) { base.parts[key] = d; base.versions[key] = p.version; } } catch (err) { if (err?.code === 'save-part-threw') reportError(this.engine, err, `new-game baseline of save part '${key}'`); }
    this._base = JSON.stringify(base);
  }

  /** @internal A module used after start() finished init: what its parts took from install was half built, and boot parts are captured after init too */
  _lateInit(keys) {
    for (const key of keys) if (this._lateParts.delete(key) && this.engine.saves.providers.has(key)) { const b = JSON.parse(this._base); delete b.parts[key]; delete b.versions[key]; this._base = JSON.stringify(b); this._late(key); this._lateParts.delete(key); }
  }

  /** @internal A module tracked this function timer while it installed after start(): install() will not run again to set it up, so it comes back at every new playthrough like a boot-time one */
  _keepTimer(t) { if (this._base && !t.event) this._timers.push({ t, rem: t.due - this.engine.time.now(t.ch) }); }

  /** @internal The module of this timer left: it stays gone */
  _dropTimer(t) { this._timers = this._timers.filter(x => x.t !== t); }

  /**
   * Keep a handle only for this playthrough: newGame / load / quit call handle.remove(). Returns the handle.
   * @template {{ remove(): void }} H
   * @param {H} handle
   * @returns {H}
   * @example
   * // a quest's helper listener lives only as long as this playthrough
   * engine.session.track(engine.events.on('npc:talk', ({ id }) => { if (id === 'baker') engine.vars.setFlag('metBaker'); }));
   */
  track(handle) {
    if (typeof handle?.remove !== 'function') throw codedError('module-handle', fmt(DEV.badHandle, { got: String(handle) }));
    this._tracked.add(handle);
    return handle;
  }

  /** @internal A handle that outlives the playthrough after all (a module's hold), or that ended by itself. Returns the handle */
  _untrack(handle) { this._tracked.delete(handle); return handle; }

  /**
   * Start a new playthrough from the state the game had right after start(). Returns Promise<boolean> (false only if a save part failed to load: the
   * old playthrough then goes on, with its data, listeners and timers, and 'session:failed' fires instead of 'session:start').
   * @param {{ turn?: object }} [o]  turn: the running request's own (what a save part's load(), an afterLoad or a module's applyState was given): the call then runs inside that request instead of waiting behind it for itself, as level.load({ turn }) does
   * @returns {Promise<boolean>}
   * @example
   * // a "Restart" button in a game-over screen
   * restartBtn.onclick = () => engine.session.newGame();
   */
  newGame({ turn } = {}) { return this._turn('new', () => this._begin('newGame', () => this._applyBase(), { kind: 'new' }), turn); }

  /**
   * Continue from a save (or retry from a checkpoint) with nothing of the current playthrough left over: the new-game state with the save on top,
   * so a part the save does not have (a module added in a later version of the game) starts from its new-game state.
   * A save that cannot be read (missing, corrupt, from a newer build) is refused before anything changes: returns false, the current game and the save stay as they were.
   * @param {string} [slot]
   * @returns {Promise<boolean>}
   * @example
   * engine.events.on('player:dead', () => engine.session.load('checkpoint'));   // retry; the checkpoint was saved with engine.saves.save('checkpoint')
   */
  load(slot = 'auto') {
    const S = this.engine.saves;
    return this._turn(`load ${slot}`, () => {
      const bad = S.check(slot);
      if (bad) return bad === 'missing' ? false : S._load(slot);   // load shows the message and changes nothing
      return this._begin('load', () => S._load(slot, this._baseData()), { kind: 'load', slot });
    });
  }

  /**
   * End the playthrough and show the title screen (the title part when the game turned it on; flow returns to its start state).
   * The state behind the title is the new-game state, so nothing from the old playthrough runs while the title is up.
   * @param {{ turn?: object }} [o]  turn: the running request's own (what a save part's load(), an afterLoad or a module's applyState was given): the call then runs inside that request instead of waiting behind it for itself, as level.load({ turn }) does
   * @returns {Promise<boolean>}
   * @example settingsBackToTitle.onclick = () => engine.session.quit();
   */
  quit({ turn } = {}) {
    return this._turn('quit', async () => {
      const ok = await this._reset('quit', () => this._applyBase());
      if (ok) this._over = !this.engine.ui.open('title');   // ui.open answers false with no title part
      else this.engine.events.emit('session:failed', { kind: 'quit' });   // rolled back: the old playthrough goes on, so no title over it
      return ok;
    }, turn);
  }

  /**
   * @internal A session replacement takes its turn with every other one (stateReplace.js). The same request joins the last in line (a double-clicked
   * Restart); another one waits: joined, a load asked during ?play's new game answered true and never loaded.
   * turn: the running request's own, when it asks (applyState): then it runs inside that request, as level.load({ turn }) does.
   */
  _turn(what, run, turn) { return this.engine.saves._replace.run(what, run, { turn }); }

  /** @internal the new-game state as save data (_reset already refused a call before start() finished) */
  _baseData() { return JSON.parse(this._base); }

  /** @internal apply the new-game state, in the turn already taken */
  _applyBase() { return applySave(this.engine.saves, this._baseData(), '(new game)'); }

  /** @internal end the playthrough, apply, then announce the new one */
  async _begin(fn, apply, info) {
    const ok = await this._reset(fn, apply);
    if (ok) this._started();
    this.engine.events.emit(ok ? 'session:start' : 'session:failed', info);
    // ?play starts the first run inside engine.start(), so a session:start listener attached after `await engine.start()` misses it silently; hint once.
    // Mark only when fired during start(), and hint only once start() returned (phase 'running') with no tick yet; later listeners are waiting for the next run.
    if (ok && this.engine.phase !== 'running') this.engine.events._firedNow('session:start', () => this.engine.phase === 'running', coded('session-start-missed', DEV.missed));
    return ok;
  }

  /** @internal */
  async _reset(fn, apply) {
    const e = this.engine;
    if (!this._base) throw codedError('session-early', fmt(DEV.early, { fn }));
    this._busy = true;
    try {
      e.events.emit('session:end');   // modules end their part: a running engine.skip is cancelled, a cutscene skipped, the music stopped
      await new Promise(r => setTimeout(r, 0));   // main-loop: one macrotask, so what session:end listeners started (a skipped cutscene's last steps) settles first
      if (e.disposed) return false;   // disposed in that macrotask: there is no state left to replace
      // background results die inside apply (saveApply), which gives them back when it fails, before its rollback: a second epoch held here made what the rollback asked for look old
      // tick, real and ambient start from 0 like a fresh page, in one call (core/time/time.js; channels and the calendar come with the save part):
      // a swimmer's bob, a pickup's spin and a 'real'-clock mod read them, so a new game after 10 minutes of play diverged from the same new game on
      // a fresh page (durability audit). Before apply: the stacks part re-times its 'real' mods from the clock as it is now.
      const undo = e.time._restart();
      // what the old playthrough holds now: a part's load() or an afterLoad may set up handles and timers for the new one while apply runs, and those stay
      const oldHandles = [...this._tracked], oldTimers = e.time._snapshotFn();
      let ok = false;
      // a refused or rolled-back load leaves the game as it was, so its clocks go back too (else 'real' mods and shader time restart mid-play)
      try { ok = await apply(); } finally { if (!ok) undo(); }
      if (!ok) return false;   // rolled back: the old playthrough's tracked handles and timers stay, so it goes on as it was (review 0.4 core B3)
      // shortcut: tracked handles stay registered while apply runs, so one may hear the load's own events (world:load); removing them first
      // would make a failed load unrecoverable. Upgrade if a game needs it: suspend tracked handles during apply instead
      // one remove() that throws is reported and the switch goes on: stopping here would leave the new data in with no session id, timers or rebase (review l2 #11)
      removeEach(e, oldHandles, 'remove() of a handle session.track held', h => this._tracked.delete(h));
      this.id++;
      e.time._restoreFn(this._timers, oldTimers);   // event timers came back with the save; function timers are the boot-time ones, each with its original delay, and those apply set up
      e.commits.rebase();   // requests that outlived the load (a nextFixed, terrain colliders) were due on the old tick count, minutes away now that tick restarted
      return true;
    } finally { this._busy = false; }
  }

  /** @internal for describe */
  describe() { return { tracked: this._tracked.size, playing: this.playing }; }
}
