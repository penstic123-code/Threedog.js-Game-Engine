// engine.control: who decides where a character goes. Every character has one control slot (by its id); one owner is in charge at a time.
//   const h = engine.control.take(npc, { owner: 'escort', layer: 'script', step: (dt, ch) => ({ x: 1, z: 0 }) });   // the engine calls step
//   const m = engine.control.take(player, { owner: 'roll', layer: 'script' }); engine.onFixed(dt => m.move(1, 0, false, dt));   // or you move
//   h.remove();                      // give it back: the owner below carries on where it paused
//   ctx.control.take(ch, { ... })    // inside a module: owner defaults to the module, and the hold goes when the module goes
// Why one slot and not "everyone calls character.move": keys, walkTo, an NPC behaviour, a cutscene and the network all used to push the same
// character in the same step; the last move() won and nobody could tell why the player slid. Now exactly one owner moves it per step.
// Rules (one table, so a tool can predict them):
//   - layers, lowest first: base (the character's own driver: the player's keys, an NPC's behaviour) < script (walkTo, a quest escort, an AI
//     order) < cutscene (timeline) < physics (a ragdoll: nothing can steer a limp body, a cutscene included) < net (a character another machine
//     drives: held for good, nobody else may take it)
//   - the highest layer is in charge; the ones below are paused, not cancelled: when it ends they carry on (a walk resumes after a cutscene)
//   - one owner per layer: a second, different owner on the same layer throws control-conflict naming both, in every build, and the first keeps
//     the character. The same owner taking again replaces its own hold.
//   - a character with any holder moves only through its holder: the step function, or the handle's move(). A direct character.move() from
//     anyone else throws control-bypass in dev. A character nobody holds (a hand-built Character in a test) moves freely.
//   - "who decides where to go" (this) is not "how the body moves" (character.mover: simple / rapier / manual); the two never mix.
//   - a hold given task(why) is a task: it runs until something in TASK_ENDS happens to the ground under it. Pausing below a higher holder does not end it.
// Kept by id, not by model: an NPC's model is torn down and rebuilt as it goes far and near; the hold stays with the NPC. The slot is dropped when
// the world record goes (world:remove) or a record-less character is disposed. Not saved: holders are code (a running walk, a cutscene), retaken
// by that code after a load.
import { codedError } from '../base/errorHints.js';
import { DEV } from '../base/validate.js';
import { callerAt } from './stackFrames.js';
import { STEP } from '../time/time.js';   // the fixed step: handle.move()'s dt when none is given
import { reportError } from '../base/errors.js';

/** Control layers, lowest first (see the header) */
const CONTROL_LAYERS = { base: 0, script: 1, cutscene: 2, physics: 3, net: 4 };
const LAYER_NAMES = Object.keys(CONTROL_LAYERS);

/** @internal What ends a task on a slot, and who says so. The one list: a task subscribes to nothing itself, so a new ending is a row here and a call to endTasks. Pause, freeze and a cutscene only suspend */
export const TASK_ENDS = {
  replaced: 'the state it ran in is gone: a load, a new game, quit (control hears them itself)',
  level: 'the level changed (characters: level:loaded, level:unloaded)',
  placed: 'a placement: character.placeAt, npc.placeAt, a write to its record',
  seated: 'it sat down in a vehicle',
  physics: 'a hold on layer physics took the body: nothing can steer it (take does this)',
  gone: 'its character left: disposed, or its record removed',
  order: 'a newer order replaces it (walkTo: one walk per character)',
};

const idOf = who => (typeof who === 'string' ? who : who?.id);

/** engine.control (made for every engine in services.js; the characters module tells it how to find a character by id) */
export class Control {
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** @type {Map<string, Map<string, any>>} id -> owner -> entry (take order) */ this._by = new Map();
    /** @internal the entry whose move is running now (handle.move / a behaviour run): the one caller character.move() lets through */ this._cur = null;
    /** @internal id -> Character; set by the characters module through resolveWith (core names no module) */ this.characterOf = () => null;
    engine.events.on('world:remove', ({ id }) => this.forget(id));
    // Two moments, and state:replaced is neither. A playthrough ending: session.js calls endTasks first in its end step, before anything is replaced, so no walk runs on into the swap.
    // save:loaded: a save landed on a running playthrough, the only word a direct apply gives. state:replaced comes last, after the save:loaded and session:start listeners that start the new state's walks: it would end them
    engine.events.on('save:loaded', () => this.endTasks(null, 'replaced'));
  }
  /**
   * Take a character's control. step (optional): (dt, character) => ({ x, y?, z, run? }) | null | false, called each fixed step while this owner is in
   * charge (dt on the character's time channel): a direction moves it, null stands still (gravity and the idle pose go on), false skips the
   * move this step (you placed it yourself). Without step, move it with handle.move(x, z, run, dt), which does nothing while paused.
   * @param {any} who a Character, an NPC handle or a character id ('player', an NPC id)
   * @param {{ owner: string, layer?: 'base' | 'script' | 'cutscene' | 'physics' | 'net', step?: (dt: number, ch: any) => ({ x: number, y?: number, z: number, run?: boolean } | null | false | void) }} o
   * @returns {{ owner: string, layer: string, id: string, readonly active: boolean, move(x: number, z: number, run?: boolean, dt?: number): boolean, remove(): void }}
   * @example const h = engine.control.take(player, { owner: 'tutorial', layer: 'script', step: () => ({ x: 0, z: 1 }) }); ... h.remove();
   */
  take(who, o = {}) {
    const id = idOf(who), { owner, layer = 'script', step = null, task = null } = o;
    if (!id || typeof id !== 'string') throw codedError('control-layer', `engine.control.take(character, { owner }): pass a character, an NPC handle or an id like 'player', got ${String(who)}`);
    if (!owner || typeof owner !== 'string') throw codedError('control-layer', `engine.control.take('${id}', { owner }): owner is a non-empty string naming who drives it, e.g. 'escort-quest', got ${JSON.stringify(owner)}`);
    if (!(layer in CONTROL_LAYERS)) throw codedError('control-layer', `engine.control.take('${id}', { layer }): layer is one of ${LAYER_NAMES.join(' < ')}, got ${JSON.stringify(layer)}`);
    if (step != null && typeof step !== 'function') throw codedError('control-layer', `engine.control.take('${id}', { step }): step is (dt, character) => ({ x, z, run }) or left out (then move with handle.move()), got ${typeof step}`);
    let m = this._by.get(id);
    if (!m) this._by.set(id, m = new Map());
    const at = DEV ? callerAt() : null;
    for (const e of m.values()) {
      if (e.owner === owner) continue;
      // the network holds a remote character for good: always an error, release builds too (moving it here would be undone by the next update)
      if (e.layer === 'net') throw codedError('control-net', `character '${id}' is driven by another machine (held by '${e.owner}'), so '${owner}' cannot take it. `
        + `Fix: change it where it is driven: run an op the host runs (engine.ops.run(...)), or take the character that is yours (engine.player)`);
      if (e.layer !== layer) continue;
      throw codedError('control-conflict', `character '${id}': two owners want layer '${layer}': '${e.owner}'${e.at ? ` (${e.at})` : ''} and '${owner}'${at ? ` (${at})` : ''}. `
        + `Rule: one owner per layer, so nothing silently decides which one steers. Fix, one of: (1) end the old one first (its handle.remove()); `
        + `(2) take another layer: engine.control.take(ch, { owner: '${owner}', layer: '${layer === 'cutscene' ? 'script' : 'cutscene'}' }) (higher pauses lower)`);
    }
    if (layer === 'physics') this.endTasks(id, 'physics');
    const old = m.get(owner);
    m.delete(owner);   // a new object: the old handle goes stale, so its remove() cannot end the new hold
    const ent = { id, owner, layer, step, task, at: old ? old.at : at, ch: typeof who === 'object' && who?.move ? who : null };
    m.set(owner, ent);
    const self = this;
    const hold = {
      owner, layer, id,
      /** true while this owner is in charge (highest layer); false while paused below a higher one, or after remove() */
      get active() { return self._top(id) === ent; },
      /** @internal true while this owner may place the body itself (a cutscene path): in charge, and no ragdoll or seat has the body, which is what makes character.move() refuse too */
      get placing() { return self._top(id) === ent && !self._char(ent)?.bodyHeld; },
      /** Move the character for this step (x, z: world direction, length 0-1 scales the speed; y: up or down, default 0, used by a mover that flies or swims). Does nothing and returns false while paused */
      move(x, z, run = false, dt = STEP, y = 0) {
        if (self._top(id) !== ent) return false;
        const ch = self._char(ent);
        if (!ch) return false;
        self._drive(ent, () => ch.move(x, z, run, dt, y));
        return true;
      },
      remove() { self.engine.session._untrack(hold); const mm = self._by.get(id); if (mm?.get(owner) === ent) { mm.delete(owner); if (!mm.size) self._by.delete(id); ent.task?.('replaced'); } },   // a task's own ending removes its hold too and ignores this; here the playthrough ended the hold first
    };
    // a hold taken during play is not saved and what ends it (a timer, a callback) dies with the playthrough, so it ends there too. Base and net holds stand for a character's whole life, not a move in it
    if (this.engine.session.captured && layer !== 'base' && layer !== 'net') this.engine.session.track(hold);
    return hold;
  }
  /**
   * Who controls a character now: { owner, layer, at?, waiting: [{ owner, layer }] } (waiting = paused below, highest first), or null.
   * @param {any} who a Character, an NPC handle or an id
   */
  of(who) {
    const id = idOf(who), top = this._top(id);
    if (!top) return null;
    const waiting = [...this._by.get(id).values()].filter(e => e !== top).sort((a, b) => CONTROL_LAYERS[b.layer] - CONTROL_LAYERS[a.layer]).map(e => ({ owner: e.owner, layer: e.layer }));
    return { owner: top.owner, layer: top.layer, ...(top.at && { at: top.at }), waiting };
  }
  /** @internal Tell every task on a slot (who null: on every slot) that the ground under it changed. Each decides what that means for it @param {any} who @param {keyof typeof TASK_ENDS} why */
  endTasks(who, why) {
    if (!(why in TASK_ENDS)) throw codedError('control-layer', `control.endTasks: '${why}' is not in TASK_ENDS (core/ops/control.js)`);
    for (const m of who == null ? [...this._by.values()] : [this._by.get(idOf(who))]) for (const ent of m ? [...m.values()] : []) ent.task?.(why);
  }
  /** @internal a provider of characters tells control how to find a live character by id (the player, an NPC's model); what it answers with is characters/character.contract.js @param {(id: string) => any} fn */
  resolveWith(fn) { this.characterOf = fn; }
  /** True while owner holds the character (in charge or paused) @param {any} who @param {string} owner */
  has(who, owner) { return !!this._by.get(idOf(who))?.has(owner); }
  /** describe().control: every held character by id, as of() */
  describe() { const out = {}; for (const id of this._by.keys()) out[id] = this.of(id); return out; }
  /** Drop every hold on a character (its record left the world, or a record-less character was disposed) @param {string} id @experimental */
  forget(id) { this.endTasks(id, 'gone'); this._by.delete(id); }
  /** @internal the entry in charge: highest layer, latest taker inside it (only one per layer in dev) */
  _top(id) {
    const m = this._by.get(id); if (!m) return null;
    let t = null;
    for (const e of m.values()) if (!t || CONTROL_LAYERS[e.layer] >= CONTROL_LAYERS[t.layer]) t = e;
    return t;
  }
  /** @internal the Character an entry moves: the one passed in, if it is still the live one, else found by id (an NPC model rebuilt) */
  _char(ent) { const ch = ent.ch && !ent.ch.disposed ? ent.ch : this.characterOf(ent.id); return ch ?? null; }
  /** @internal run fn as the entry's own move (checkMove reads _cur) */
  _drive(ent, fn) { const prev = this._cur; this._cur = ent; try { return fn(); } finally { this._cur = prev; } }
  /** @internal for drivers that call character.move inside their own code (an NPC behaviour): run fn as owner's move when it is in charge; false when paused */
  runAs(id, owner, fn) {
    const top = this._top(id);
    if (!top || top.owner !== owner) return false;
    this._drive(top, fn);
    return true;
  }
  /** @internal each fixed step (the characters module calls it): every in-charge holder with a step moves its character once */
  stepAll() {
    const T = this.engine.time;
    for (const id of [...this._by.keys()]) {
      const top = this._top(id);
      if (!top?.step) continue;
      const ch = this._char(top);
      if (!ch) continue;
      const dt = T ? T.dt(ch.channel, ch.id) : STEP;
      let m;
      try { m = top.step(dt, ch); } catch (err) { reportError(this.engine, err, `control step of '${top.owner}' on character '${id}'`); continue; }   // the next character's holder is not to blame
      if (m === false || this._top(id) !== top) continue;   // placed by hand this step, or the step handed control on (ended itself, something took it)
      this._drive(top, () => ch.move(m?.x ?? 0, m?.z ?? 0, !!m?.run, dt, m?.y ?? 0));
    }
  }
  /** @internal dev check from character.move(): a held character moves only through its holder (the header's bypass rule) */
  checkMove(ch) {
    const top = this._top(ch.id);
    if (!top || this._cur === top) return;
    throw codedError('control-bypass', `character '${ch.id}' is controlled by '${top.owner}' (layer ${top.layer}), but its move() was called from outside that owner. `
      + `Rule: one owner moves a character per step. Fix: take control and move through it: const h = engine.control.take(ch, { owner: 'mine', layer: 'script' }); h.move(x, z, run, dt) `
      + `(or give step); it pauses '${top.owner}' until h.remove()`);
  }
}
