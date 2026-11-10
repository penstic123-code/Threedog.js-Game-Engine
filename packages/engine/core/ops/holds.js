// Who holds the engine still: freeze and the loop halt (each ends with its handle's remove()), runState, and the camera takeover (takeCamera / cameraOverride).
// "Stopped" has one meaning for a game: frozen. engine.freeze is what menus, flow 'paused', the page hold and errors use. haltLoop is a tool's switch, not a game's: it
// stops the real-time loop and the picture with it, so tests and the dev bridge can drive the engine by step(). Its name says so because an AI asked to pause a game
// reached for engine.pause and got a dead screen. Time channels at 0 slow or stop one part of the world and are not a hold.
// Each is a named stack (core/ops/stacks.js: 'halt' and 'freeze' kind any, 'camera' kind top), so they follow the same owner rules as every shared quantity:
// engine.freeze('menu') is engine.mod('freeze', { owner: 'menu' }) with the loop's side effects added (ending the last halt restarts the loop).
// One entry per mechanism: the handle's remove() ends a halt / freeze (there is no engine.resume / engine.unfreeze).
import { warnOnce } from '../base/validate.js';
import { readParams, keysSchema } from '../base/params.js';
import { coded } from '../base/errorHints.js';
import { ownerArgs } from './sharedPoint.js';
import { viewHold } from '../scene/view.js';

const FREEZE_KEYS = keysSchema(['owner', 'kind', 'still']);   // an unknown key (the old ambient) throws in dev with a did-you-mean
// The halt / freeze handle is { owner, remove() } only: no chaining, so each is ended in exactly one way.
function handle(owner, remove) { return { owner, remove }; }

/**
 * The three hold stacks: 'freeze' and 'halt' (kind any), 'camera' (kind top). services.js and the test engines call this, so both get the same stacks.
 * The halt stack does the loop side effect itself (onChange), not engine.haltLoop(): engine.mod('halt', { owner }), engine.haltLoop(owner), the handle's
 * remove() and _unhalt(owner) are then one behavior. Making mod('halt') throw instead would leave a quantity that engine.mod names in describe
 * but refuses to change, a special case to remember; with onChange there is no path that holds the stack without stopping the loop.
 * @param {any} engine
 */
export function defineHoldStacks(engine) {
  engine.stacks.define('freeze', { kind: 'any', save: false, onChange: () => engine.input?._kbSync?.() });   // who froze gameplay; a freeze gives the page's key lock back (inputKeyboard.js)
  engine.stacks.define('halt', { kind: 'any', save: false, onChange: () => {   // who stopped the loop; it restarts only when empty
    if (engine.stacks.get('halt').size()) engine.halted = true;
    else if (!engine.disposed) { engine.halted = false; engine._loop(); }
    engine.page._sync();   // a page hold is about the real-time loop: there is none while the loop is stopped (core/engine/page.js)
  } });
  // who holds the camera; the latest is in charge (cameraOverride). A claim that is in charge again after a newer one left gets its opts.onTop() called: it holds the camera
  // but the newer holder moved it, so the holder puts its pose back (a named view). Claims are new objects per take, so "seen on top before" is the identity of one claim
  const onTopBefore = new WeakSet(); let top = null;
  engine.stacks.define('camera', { kind: 'top', save: false, onChange: () => {
    viewHold(engine);
    const t = engine.stacks.get('camera').value() ?? null;
    if (t === top) return;
    top = t;
    if (t) { if (onTopBefore.has(t) && !engine.disposed) t.onTop?.(); onTopBefore.add(t); }   // not after dispose: a shot's async release would write a camera that is gone
  } });
}

export const holdMethods = {
  /**
   * Stop the real-time loop for a test or a tool: nothing advances and nothing is drawn until step(), so this is not how a game pauses (engine.freeze, flow 'paused').
   * owner names who stopped it (default 'game'; haltLoop({ owner }) works too): the loop stays stopped until every owner has let go.
   * Returns a handle: remove() lets go for this owner.
   * @param {string | { owner?: string }} [owner]
   * @returns {{ owner: string, remove(): void }}
   * @example const h = engine.haltLoop('perf-test'); engine.step(1); h.remove();
   */
  haltLoop(owner) {
    const a = ownerArgs(owner);
    const P = this.stacks.get('halt');
    const held = P.take({ owner: a.owner, value: true });   // the stack's onChange sets this.halted (defineHoldStacks), same as engine.mod('halt')
    return handle(a.owner, () => held.remove());   // this hold, not the name: a handle kept from an earlier one must not end a later one
  },
  /**
   * @internal The dev bridge and tests: end owner's halt (the handle's remove() calls this); with no halt held (a headless engine) it starts live running.
   * A call by a non-owner while others hold a halt is ignored with a dev warning (a halt that silently stays stops even rendering).
   * @param {string | { owner?: string }} [owner]
   */
  _unhalt(owner) {
    const { owner: o } = ownerArgs(owner);
    const P = this.stacks.get('halt');
    if (P.size() && !P.has(o)) { warnOnce(coded('halt-owner', `ending the halt of '${o}': halted by ${P.names().map(n => `'${n}'`).join(', ')}, not by '${o}'. End a halt with the handle haltLoop() returned (h.remove()), or the loop stays stopped`)); return this; }
    // with holders the stack's onChange restarts the loop; with none (headless start) this call starts it
    if (!P.release(o) && !P.size() && !this.disposed) { this.halted = false; this._loop(); }
    return this;
  },
  // Gameplay freeze (menus, flow 'paused'): no fixed steps (movement, timers, tick and every time view but ambient stop) while frame hooks
  // and rendering go on, so the picture and UI stay alive.
  // Gameplay logic (quest checks, cutscene waits) belongs in fixed, or check engine.frozen first in frame (see the top of this file).
  // Unlike haltLoop(), which stops rendering too and is for tests and step(). owner is the freezer's name; play resumes only when all
  // have unfrozen. step() obeys freezes as well. Same owner rules as every stack (core/ops/stacks.js).
  /**
   * Freeze gameplay for owner (default 'game'; freeze({ owner, kind }) works too). kind 'title' marks a title screen waiting for start (runState 'title-frozen').
   * Ambient motion (uniforms.uTime: wind, water, clouds), skeletal animation and particles keep moving behind the freeze, as behind a pause menu; still: true stops them too
   * (a photo, a cutscene still; the page's own hold).. UI and the camera stay live.
   * Returns a handle whose remove() releases this owner's freeze. Same as engine.mod('freeze', { owner }) plus the kind.
   * @param {string | { owner?: string, kind?: 'title', still?: boolean }} [owner] @param {{ kind?: 'title', still?: boolean }} [opts]
   * @returns {{ owner: string, remove(): void }}
   */
  freeze(owner, opts) {
    const a = ownerArgs(owner, opts);
    readParams('engine.freeze()', FREEZE_KEYS, a.opts);
    const h = this.stacks.get('freeze').take({ owner: a.owner, value: { kind: a.opts.kind ?? null, still: !!a.opts.still } });
    return handle(a.owner, h.remove);
  },
  /** True while someone has frozen gameplay */
  get frozen() { return this.stacks.get('freeze').value(); },
  /** True while a freeze asked for a full still (freeze(owner, { still: true })): code that moves things on frame dt reads this, as animation and particles do */
  get still() { const F = this.stacks.get('freeze'); return F.size() > 0 && F.entries().some(h => h.value?.still); },   // read per character and animator: nothing built while no one froze
  /**
   * The one answer to "why is the page (not) advancing"; the dev bridge and the MCP tools copy it as-is.
   * state: 'loading' | 'title-frozen' (a freeze of kind 'title' is up, waiting for start) | 'halted' (the loop is stopped: a test, the bridge, a headless page)
   *   | 'frozen' (gameplay stopped by the owners in `owners`: a menu, the page, an error) | 'running';
   * owners: every halt and freeze owner, so closing one part's menu can be told from a player's;
   * blockedBy: what keeps the player's input from driving the game: each opaque input context ('win-settings', 'ui-title', 'dialogue', 'cutscene'...),
   *   'error' (a gameplay error froze the game) and 'loading' (the loading screen blocks).
   * @returns {{ state: 'loading' | 'title-frozen' | 'halted' | 'frozen' | 'running', owners: string[], blockedBy: string[] }}
   */
  get runState() {
    const F = this.stacks.get('freeze'), owners = [...this.stacks.get('halt').names(), ...F.names()];
    const lv = this.loading?.view();
    const state = !this.ready || !lv?.done ? 'loading' : F.entries().some(d => d.value.kind === 'title') ? 'title-frozen'
      : this.halted ? 'halted' : F.size() ? 'frozen' : 'running';
    const blockedBy = this.input.blockedBy();
    if (F.has('error')) blockedBy.push('error');
    if (lv?.blocked) blockedBy.push('loading');
    return { state, owners, blockedBy };
  },

  // ---------- camera takeover ----------
  // While anyone holds the camera, no camera module moves it (camera/common.js reads cameraOverride). The 'camera' stack is kind top: the latest holder
  // is in charge, and releasing it hands the camera back to the previous holder (or to the rig when none is left), never to nobody.
  /**
   * Take the camera over: camera modules leave engine.camera alone until every holder has released it. The latest holder is in charge; its focus
   * (optional) is where the world loads around. Returns { remove() } (only this owner's claim). engine.cameraOverride shows the holder in charge.
   * @param {string | { owner: string, focus?: import('three').Vector3 }} owner @param {{ focus?: import('three').Vector3, [k: string]: any }} [opts] extra fields stay readable on cameraOverride
   * @returns {{ owner: string, remove(): void }}
   * @example const cam = engine.takeCamera('photo-mode', { focus: engine.player.position }); ... cam.remove();
   */
  takeCamera(owner, opts) {
    const a = ownerArgs(owner, opts);
    const h = this.stacks.get('camera').take({ owner: a.owner, value: { ...a.opts, owner: a.owner } });
    return { owner: a.owner, remove: h.remove };
  },
  /**
   * The camera holder in charge ({ owner, focus? }), or null. Read-only: take the camera with engine.takeCamera(owner).
   * @type {{ owner: string, focus?: import('three').Vector3, [k: string]: any } | null}
   */
  get cameraOverride() { return this.stacks.get('camera').value() ?? null; },
};

const HOLD_STACKS = { halt: 'halt', freeze: 'freeze', camera: 'camera', debugView: 'debug.view' };
/**
 * Everyone who holds something, in one place (empty parts left out): halt / freeze / camera / debugView [{ owner, at }]; input [{ context, owner,
 * pass }] (pushed input contexts); gates { action: [owners] } (input.gate); shadowed { action: [causes] } (input.blockedBy). Every other shared value is in describe().shared (core/ops/stacks.js).
 * Lives here, next to the hold stacks it reads, so describe() and the input-holds test use the same function (no second copy).
 * "Why can't I move / why is time slow" is answered here without knowing which module did it.
 */
export function describeHolds(e) {
  const out = {};
  for (const [k, n] of Object.entries(HOLD_STACKS)) { const h = e.stacks.has(n) ? e.stacks.get(n).holders() : []; if (h.length) out[k] = h; }
  const inp = e.input.holders; if (inp.length) out.input = inp;
  const g = e.stacks.has('input.gate') ? e.stacks.get('input.gate') : null, gates = {};
  for (const id of g?.ids() ?? []) if (g.size(id)) gates[id] = g.names(id);
  if (Object.keys(gates).length) out.gates = gates;
  // actions whose own context is on the stack but a pass-through context above binds the same key: the one block holds.input does not already show,
  // with every cause input.blockedBy gives
  const shadowed = {};
  for (const a of e.input.actions.keys()) { const why = e.input.blockedBy(a); if (why.some(w => w.startsWith('shadowed-by:'))) shadowed[a] = why; }
  if (Object.keys(shadowed).length) out.shadowed = shadowed;
  return out;
}
