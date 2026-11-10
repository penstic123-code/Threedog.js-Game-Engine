// Input: read by "action", not by "key". Games and modules ask "did the player press interact", not "did they press E".
// Why: keys can be rebound in settings, and on-screen key hints follow automatically.
//
// Who does what (one rule each, so an AI can predict it):
//   - a module DECLARES actions and the context they belong to, never keys: ctx.input.define('choice1', { context: 'dialog', optional: true })
//   - the GAME BINDS keys: createEngine({ bindings: { jump: ['Space'] } }), engine.input.bind('jump', ['Space']) or a whole preset map
//     engine.input.bind(presets.bindings.dialogNumbers). The basics (WASD / arrows move, confirm, cancel, UI cursor) are the one default preset.
//   - the PLAYER REBINDS: engine.input.rebind('jump', ['KeyJ']) (the settings menu calls it and saves it).
// Keys are the shared point 'input.keys' (core/ops/sharedPoint.js), one record per action: the default preset is its base, the game binds on the game
// layer, the player's rebind on the settings layer (it replaces). describe().shared['input.keys[jump]'] says who bound what.
// Two different owners binding one action is input-bound-twice in dev (with the fix); a module's bindings and declarations go with the module.
// Reading an action nobody bound reports input-unbound once in dev (naming the one-line bind), unless its declaration said optional: true.
//
// engine.input.down('run') held; pressed('jump') just pressed; released('jump') just released
// Gameplay (onFixed, module fixed) reads a snapshot taken at the start of each fixed step: reads within one step agree, and "just pressed" counts exactly once,
// never lost, whatever the frame rate. UI keys and camera (onFrame, module frame) read this frame's latest state.
// Contexts (inputContext.js): a stack, the top one wins. Base 'walk'; 'vehicle' passes unrelated actions through; 'dialog', 'menu', 'cutscene' are opaque.
// Window blur / tab hide (page:blur from core/engine/page.js) releases every held key. Several engines on one page: the one last pressed or focused hears the keyboard and the gamepads (inputKeyboard.js).
// engine.input.label('interact') -> "E" (UI hints); engine.input.axis -> { x, y } movement direction (moveLeft/Right/Forward/Back + sticks)
//
// Mouse buttons are keys too: 'Mouse0' left / 'Mouse1' middle / 'Mouse2' right (real mouse only; touch taps do not count); gamepad buttons are 'PadA' etc.
//   engine.input.bind('attack', ['KeyJ', 'Mouse0']);  engine.onFixed(() => { if (engine.input.pressed('attack')) ... });
// input.pointer = { x, y, ndcX, ndcY, down, clicked } (x / y pixels and ndc -1..1 relative to the canvas box, not the window): for UI and ground picking
// (click-to-move via screenToGround); clicked is true only on this frame and a drag does not count,
//   gameplay (fire, attack) must not read it; bind a Mouse0 action instead

/** @import { Pointer, Autopilot } from '../../types/core' */
import { coded, codedError } from '../base/errorHints.js';
import { checkTypeRule } from '../engine/moduleTypes.js';
import { warnMissing, warnOnce, missingText, DEV } from '../base/validate.js';
import { touchButton } from './inputTouch.js';
import { bindPointer } from './inputPointer.js';
import { bindKeyboard } from './inputKeyboard.js';
import { pollPad, keyLabel } from './inputPad.js';
import { Seat, moveAxis } from './inputSeat.js';
import { BASIC_KEYS, BASIC_LABELS, BOUND_LABELS } from './inputDefaults.js';
import { initContexts, pushContext, readableMap, blockers, applyContexts, settledStack, BASE_CONTEXT } from './inputContext.js';

const NONE = Object.freeze([]);
const ACTION_OPTS = ['context', 'label', 'optional', 'keys', 'owner'];


/** Input: read by "action", not by "key". Key names are the browser's KeyboardEvent.code, e.g. 'KeyE', 'Space', 'ShiftLeft'; gamepad keys are 'PadA' etc. */
export class Input {
  /** @internal */
  constructor(engine, canvas, { joystick = 'auto', bindings = {}, padDeadzone = 0.18, padLookSpeed = 9, blockBrowserKeys = true } = {}) {
    /** @internal */ this.engine = engine;
    /** @internal */ this.canvas = canvas;
    /** @internal */ this.keys = new Set();
    /** @internal */ this.justPressed = new Set();    // pressed / released this frame (read in frame, cleared by endFrame)
    /** @internal */ this.justReleased = new Set();
    /** @internal */ this._accP = new Set();          // pressed / released since the last snapshot (accumulated until the start of the next fixed step)
    /** @internal */ this._accR = new Set();
    /** @internal */ this._fx = { keys: new Set(), pressed: new Set(), released: new Set(), x: 0, y: 0 };   // this fixed step's snapshot
    /** @internal */ this._live = { keys: this.keys, pressed: this.justPressed, released: this.justReleased };
    /** @internal */ this._inFixed = false;
    /** @internal local players' seats (inputSeat.js) */ this.seats = [];
    /** @internal frames ended so far. A press lives until endFrame, so this is what "the same press" means to ui/Focus.js, from any fixed step or frame hook */ this.frameCount = 0;
    /** This frame's look-drag amount (pixels) and wheel notches */
    this.look = { dx: 0, dy: 0, zoom: 0 };
    /** Mouse/touch pointer @type {Pointer} */
    this.pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0, down: false, clicked: false, button: 0 };
    /** Set by a camera that locks the mouse on click: true while the next mouse press would only lock it, so that press is not delivered as Mouse0 / a click @internal */
    this.swallowLockClick = /** @type {null | (() => boolean)} */ (null);
    /** On-screen stick (touch) @experimental */
    this.stick = { x: 0, y: 0 };
    /** Auto movement (stress tests, test scripts) @type {Autopilot | null} */
    this.autopilot = null;
    /** action name -> its declaration: labelKey (string-table key), context, optional, by (who declared it; null = only bound so far).
     *  Keys are not here: keysOf(action) reads the shared point 'input.keys' @type {Map<string, { labelKey: string, context: string, optional: boolean, by: string | null }>} */
    this.actions = new Map();
    initContexts(this);
    /** @internal the shared point holding every action's keys (record id = action); its base is the default preset */
    this._keys = engine.stacks.define('input.keys', { kind: 'value', per: true, save: false, settingsSet: true, onChange: () => { this._readable = null; } });
    /** @internal 'Touch:<action>' keys of on-screen buttons (inputTouch.js), added to keysOf */ this._touchKeys = new Map();
    /** @internal createEngine({ blockBrowserKeys }): while playing, bound keys do not reach the browser (inputKeyboard.js) */ this.blockBrowserKeys = blockBrowserKeys;
    /** @internal */ this.padDeadzone = padDeadzone;
    /** @internal */ this.padLookSpeed = padLookSpeed;
    /** @internal */ this.padStick = { x: 0, y: 0 };
    /** Most recently used device: UI key hints follow it @type {'keyboard' | 'pad' | 'touch'} @experimental */
    this.lastDevice = 'keyboard';
    /** Is this a touch device? @experimental */
    this.touch = matchMedia('(pointer: coarse)').matches;
    /** @internal touch buttons the game asked for [{ action, labelKey }]; drawn by the UI part 'touch' (inputTouch.js) */ this._touch = [];
    for (const a of Object.keys(BASIC_KEYS)) this.actions.set(a, { labelKey: BASIC_LABELS[a], context: BASE_CONTEXT, optional: false, by: 'engine' });
    this.bind(bindings);   // createEngine({ bindings }): the game's keys, owner 'game'

    const { signal } = engine;   // engine.dispose() cancels all listeners at once
    bindKeyboard(this, canvas, signal);
    // Losing focus swallows the keyup events, so release everything when the page goes away (window blur or tab hidden; core/engine/page.js owns those listeners)
    engine.events.on('page:blur', () => { for (const k of [...this.keys]) this._keyUp(k); this._muted.clear(); this.stick.x = this.stick.y = 0; });   // a muted key's keyup and the stick's pointerup are lost the same way

    bindPointer(this, canvas, signal);

    /** @internal */ this.joystick = joystick;
  }

  // ---------- actions ----------
  /**
   * Declare an action: its context and display name, never its keys (the game binds those). Modules call ctx.input.define (owned by the module,
   * removed with it); a game's own action can pass keys to declare and bind in one line.
   * context: the input context it is read in (default 'walk'); readable only while that context is on the stack and not shadowed, see push().
   * optional: true = the module works without it (number keys for dialogue choices), so reading it unbound is silent.
   * A second owner declaring the same action with another context throws input-action-context.
   * @param {string} name
   * @param {{ context?: string, label?: string, optional?: boolean, keys?: string | string[], owner?: string }} [o]
   * @returns {{ name: string, remove(): void }} remove() takes the declaration (and keys given here) away
   * @example ctx.input.define('choice1', { context: 'dialog', label: 'dialogue.choice', optional: true });   // in a module: no keys
   * @example engine.input.define('brake', { context: 'vehicle', keys: ['KeyB', 'PadLT'] });                     // a game's own action, bound at once
   */
  define(name, o = {}) {
    const bad = Object.keys(o).filter(k => !ACTION_OPTS.includes(k));
    if (bad.length) throw codedError('unknown-option', `input.define('${name}', { ${bad.join(', ')} }): known options are ${ACTION_OPTS.join(', ')}. Keys are bound by the game: engine.input.bind('${name}', ['KeyX'])`, TypeError);
    const { context = BASE_CONTEXT, label, optional = false, keys, owner = 'game' } = o;
    const cur = this.actions.get(name);
    if (cur?.by && cur.by !== owner && cur.context !== context) {
      throw codedError('input-action-context', `input.define('${name}'): '${cur.by}' already declared it in context '${cur.context}', now '${owner}' declares it in '${context}'. `
        + `Rule: an action belongs to one context. Fix: give one of them another name (e.g. '${owner}.${name}'), or declare it in the same context`);
    }
    // a second owner declaring the same action in the same context shares the first declaration (two modules may read one 'interact')
    const entry = cur?.by && cur.by !== owner ? cur : { labelKey: label || cur?.labelKey || name, context, optional, by: owner, users: 0 };
    if (entry !== cur) this.actions.set(name, entry);
    entry.users++;
    this._readable = null;
    const bound = keys !== undefined ? this.bind(name, keys, { owner }) : null;
    let gone = false;
    return { name, remove: () => {
      if (gone) return; gone = true;
      bound?.remove();
      if (--entry.users !== 0 || this.actions.get(name) !== entry) return;   // a sharing owner keeps it
      // keys someone else bound stay readable: back to an action only bound, as bind() makes it
      if (this._keys.size(name)) this.actions.set(name, { labelKey: entry.labelKey, context: BASE_CONTEXT, optional: false, by: null }); else this.actions.delete(name);
      this._readable = null;
    } };
  }
  /**
   * @internal A failed content load puts these actions back, declarations and the game's keys (core/base/sections.js undo): the function that does it
   * @param {string[]} names @returns {() => void}
   */
  keepActions(names) {
    const gameKeys = n => this._keys.holders(n).find(h => h.layer === 'game' && h.owner === 'game')?.value;
    const was = names.map(n => [n, this.actions.get(n), gameKeys(n)]);
    return () => {
      for (const [n, entry, keys] of was) {
        if (gameKeys(n) !== keys) { const h = this.bind(n, keys ?? NONE); if (!keys) h.remove(); }
        if (entry) this.actions.set(n, entry); else this.actions.delete(n);
      }
      this._readable = null;
    };
  }
  /**
   * Bind keys to an action (the game's choice; owner 'game'). Takes one action or a whole map, e.g. a preset: bind(presets.bindings.rtsRotate).
   * Binding again as the same owner replaces; a DIFFERENT owner binding the same action throws input-bound-twice in dev (release: the later wins).
   * An action nobody declared yet is created in context 'walk' (a module declaring it later sets its context; order does not matter).
   * @param {string | Readonly<Record<string, string | readonly string[]>>} name an action, or { action: keys }
   * @param {string | readonly string[]} [keys] key names (KeyboardEvent.code, 'PadA', 'Mouse0'); [] = deliberately no key
   * @param {{ owner?: string }} [o]
   * @returns {{ owner: string, remove(): void }} remove() takes these keys away (the default preset or a lower binding shows again)
   * @example engine.input.bind('jump', ['Space', 'PadA']);
   * @example engine.input.bind({ ...presets.bindings.dialogNumbers, ...presets.bindings.cutsceneSkip });
   */
  bind(name, keys, { owner = 'game' } = {}) {
    checkTypeRule(this.engine, 'input.bind', `bound keys to '${typeof name === 'string' ? name : Object.keys(name ?? {}).join(', ')}'`);
    if (name && typeof name === 'object') {
      const hs = Object.entries(name).map(([a, k]) => this.bind(a, k, { owner }));
      return { owner, remove: () => { for (const h of hs) h.remove(); } };
    }
    keys = [].concat(keys ?? NONE);
    if (keys.some(k => typeof k !== 'string' || !k)) throw codedError('input-keys', `input.bind('${name}', ${JSON.stringify(keys)}): keys are key names like 'KeyE', 'Space', 'PadA', 'Mouse0'`, TypeError);
    if (!this.actions.has(name)) this.actions.set(name, { labelKey: BOUND_LABELS[name] || name, context: BASE_CONTEXT, optional: false, by: null });
    // checked here, before the shared point's own conflict rule, so the message talks about keys (mul / add make no sense for a key list)
    const other = this._keys.holders(name).find(h => h.layer === 'game' && h.owner !== owner);
    if (other && DEV) {
      throw codedError('input-bound-twice', `input.bind('${name}'): '${other.owner}' already binds it (${other.value.join(', ') || 'no key'}${other.at ? `, ${other.at}` : ''}), now '${owner}' binds ${keys.join(', ') || 'no key'}. `
        + `Rule: one owner binds an action. Fix: keep one of the two binds, or bind another action name`);
    }
    return this._keys.take({ owner, id: name, set: Object.freeze([...keys]), layer: 'game' });
  }
  /**
   * Touch button (appears only on touch devices); pressing it triggers the action. labelKey is the string-table key of the button text (updates when the
   * language changes). Returns { remove() }: a module tracks it, so the button leaves with the module
   * @param {string} action @param {string} labelKey @returns {{ remove(): void }}
   */
  touchButton(action, labelKey) { return touchButton(this, action, labelKey); }

  /**
   * Press (down true) or release an action from code, through the same path as a real key: tests, AI drivers, replays. Presses the action's first bound key
   * and holds it until simulate(action, false), so the player walks like with a held key. Takes action names (moveForward, moveLeft, run, interact, ...;
   * engine.input.actions lists them), not keys; an unknown name throws unknown-name with the closest one
   * @param {string} action @param {boolean} [down]
   * @example engine.input.simulate('moveForward'); engine.step(1); engine.input.simulate('moveForward', false)
   */
  simulate(action, down = true) {
    // throws (reading only warns): a driver pressing a wrong name would otherwise "succeed" with nothing moving, and a script rarely shows warnings
    if (!this.actions.has(action)) throw codedError('unknown-name', `engine.input.simulate('${action}'): ${missingText('action', action, [...this.actions.keys()])}`);
    const k = this.keysOf(action)[0]; if (k) { if (down) this._keyDown(k, this.lastDevice); else this._keyUp(k); }
  }
  _keyDown(code, device) {
    if (this.keys.has(code) || this._muted.has(code)) return;
    this.keys.add(code); this.justPressed.add(code); this._accP.add(code); this.lastDevice = device;
  }
  /** @internal */
  _keyUp(code) { this._muted.delete(code); if (this.keys.delete(code)) { this.justReleased.add(code); this._accR.add(code); } }
  /**
   * A local player's share of the input on a shared screen: its own keys and gamepad, read like engine.input (axis, down, pressed, released). Pass it to addPlayer({ id, input }).
   * pad: gamepad index; that pad leaves engine.input and answers the game's pad bindings here. keys: { action: keys } for this seat alone. Two seats on one pad or key throw `input-seat`.
   * @example const two = engine.input.seat({ pad: 1, keys: { moveForward: 'KeyI', moveBack: 'KeyK', moveLeft: 'KeyJ', moveRight: 'KeyL', jump: 'KeyU' } });
   * @param {{ pad?: number, keys?: Record<string, string | string[]> }} [opts] @returns {Seat}
   */
  seat(opts = {}) { const s = new Seat(this, opts); this.seats.push(s); return s; }
  /** @internal Called at the start of each frame: read the gamepad (runs every frame, allocates nothing) */
  poll(dt) { pollPad(this, dt); }
  /**
   * The player's rebinding (the settings menu calls this and saves it): replaces the game's keys on the settings layer of 'input.keys'.
   * keys null takes the player's choice away (the game's or the default keys show again). Works before the action is declared (a saved binding
   * is restored at start, the module declaring the action comes later).
   * @param {string} action @param {string | string[] | null} keys
   * @example engine.input.rebind('jump', ['KeyJ']);   engine.input.rebind('jump', null);   // back to the game's keys
   */
  rebind(action, keys) {
    if (keys == null) this._keys.release('settings', { id: action });
    else this._keys.take({ owner: 'settings', id: action, set: Object.freeze([].concat(keys)), layer: 'settings' });
    this.engine.events.emit('input:rebind', { action, keys: this.keysOf(action) });
  }
  /** The player's rebindings now in effect: { action: keys } (what the settings menu saves) @returns {Record<string, string[]>} */
  rebound() {
    const out = {};
    for (const id of this._keys.ids()) { const h = this._keys.holders(id).find(x => x.layer === 'settings'); if (h) out[id] = [...h.value]; }
    return out;
  }
  /**
   * All keys bound to an action: the player's rebinding, else the game's bind, else the default preset (basics only); plus its touch button
   * @param {string} action @returns {readonly string[]}
   */
  keysOf(action) {
    const k = this._keys.value(action, BASIC_KEYS[action] ?? null) ?? NONE, t = this._touchKeys.get(action);
    return t ? [...k, t] : k;
  }
  /** @internal Every key that can drive an action: its bound keys, plus each seat's own keys and its '@pad' gamepad keys. The context switch lets go of all of them @param {string} action @returns {string[]} */
  _sourcesOf(action) { return [...new Set([...this.keysOf(action), ...this.seats.flatMap(s => s._keysOf(action))])]; }
  /** @internal reading an undeclared action is most likely a misspelled name; a declared one nobody bound says how to bind it (dev, once) */
  _known(action) {
    const a = this.actions.get(action);
    if (!a) { warnMissing('action', action, [...this.actions.keys()]); return; }
    if (DEV && this.isUnbound(action)) {
      warnOnce(coded('input-unbound', `input: '${action}' (context '${a.context}'${a.by ? `, declared by '${a.by}'` : ''}) is read but no key is bound, so it never fires. `
        + `Fix: engine.input.bind('${action}', ['KeyX']) or createEngine({ bindings: { ${action}: ['KeyX'] } }); a presets.bindings.* map may cover it`), `input-unbound:${action}`);
    }
  }
  /**
   * True when an action needs a key and has none, so no player input can fire it. Not for an optional action, and not for one bound to [] on purpose
   * (a mouse-only game): "no key at all" is the fault, whichever key the game or the player chose is not.
   * @param {string} action @returns {boolean}
   * @example if (engine.input.isUnbound('interact')) engine.input.bind(presets.bindings.interact);
   */
  isUnbound(action) { return !this.actions.get(action)?.optional && !this.keysOf(action).length && !this._keys.size(action); }
  /** Key name shown in the UI, e.g. "E" @param {string} action @returns {string} */
  label(action) { return keyLabel(this, action); }
  /** Which copy to read: the snapshot inside fixed steps, this frame's latest state elsewhere @internal */
  _has(action, set, keys = this.keysOf(action)) { this._known(action); if (!readableMap(this).get(action) || this._gated(action)) return false; const S = (this._inFixed ? this._fx : this._live)[set]; return keys.some(k => S.has(k)); }
  /** Held (a snapshot of this step in fixed, the latest state in frame) @param {string} action @returns {boolean} */
  down(action) { return this._has(action, 'keys'); }
  /**
   * Just pressed. Read in onFixed / module fixed: pressed since the previous fixed step, true only for this step (counted once however the frame rate varies,
   * never lost);
   * read in onFrame / module frame: pressed this frame (UI keys only). Read gameplay keys in fixed
   * @param {string} action @returns {boolean}
   * @example engine.onFixed(() => { if (engine.input.pressed('jump')) player.jump(); });
  */
  pressed(action) { return this._has(action, 'pressed'); }
  /**
   * Just released (which copy is read is the same as pressed; for things like release-to-fire after charging) @param {string} action @returns {boolean}
   * @example if (engine.input.released('fire')) shoot(charge);
   */
  released(action) { return this._has(action, 'released'); }
  /**
   * Just pressed, ignoring input contexts (for menus and dialogue themselves, which run while a context blocks the game) @param {string} action @returns
   * {boolean}
   */
  pressedRaw(action) { this._known(action); const S = (this._inFixed ? this._fx : this._live).pressed; return this.keysOf(action).some(k => S.has(k)); }

  /**
   * Push an input context (an action group, like a Unity Action Map). The top context shadows lower actions bound to the same key.
   * Opaque by default (nothing below is readable: menus, dialogue, cutscenes); { pass: true } lets unrelated lower actions keep working (vehicle, build mode).
   * Applies at the start of the next fixed step; actions it blocks lose their held state (no stuck keys after a menu closes). Join a context with
   * input.define(name, { context }); menu keys: pressedRaw.
   * @param {string} name e.g. 'vehicle', 'dialog', 'menu', 'cutscene', 'build' (the base context is 'walk')
   * owner (default the name) is who pushed it, listed in describe().holds.input
   * @param {{ pass?: boolean, owner?: string }} [opts]
   * @returns {{ name: string, remove(): void }} remove() pops it (safe to call twice)
   * @example const h = engine.input.push('vehicle', { pass: true });   // vehicle-context actions (brake) work, and shadow gameplay actions on the same key
   *   h.remove();
   */
  push(name, opts) { return pushContext(this, name, opts); }
  /**
   * describe().input: the context stack, declared actions nobody bound (unbound: isUnbound) and the player's rebindings
   * @returns {{ stack: string[], unbound: string[], rebound: Record<string, string[]> }}
   */
  describe() {
    const unbound = [...this.actions.keys()].filter(n => this.isUnbound(n));
    return { stack: this._stack.map(c => (c.owner && c.owner !== c.name ? `${c.name}(owner: ${c.owner})` : c.name)), unbound, rebound: this.rebound() };
  }
  /** Names of the active contexts, bottom to top (pending switches apply at the next fixed step) @returns {string[]} @experimental */
  get contexts() { return this._stack.map(c => c.name); }
  /**
   * Who holds input, bottom to top above the base context: [{ context, owner, pass }] (pass: unrelated gameplay actions still read).
   * Pushes and removes count at once, before the next fixed step applies them: on a halted page a closed window is not a holder any more
   * @returns {{ context: string, owner: string, pass: boolean }[]}
   * @experimental
   */
  get holders() { return settledStack(this).slice(1).map(c => ({ context: c.name, owner: c.owner, pass: c.pass })); }
  /**
   * Close one action while anyone holds its gate (stun: no jump; a tutorial: no attack yet), without a whole input context. Same rules as every
   * engine.mod stack (it is the shared point 'input.gate', one entry per owner and action): only the owner opens it, { for } ends it by itself.
   * A closed action reads as not down / pressed / released; describe().holds.gates lists the owners.
   * @param {string} action @param {string | { owner?: string, for?: number, clock?: string }} [owner] default 'game'
   * @returns {{ owner: string, remove(): void }}
   * @example const stun = engine.input.gate('jump', { owner: 'stun', for: 1.5 });   // no jumping for 1.5 s; stun.remove() reopens it early
   */
  gate(action, owner = 'game') {
    this._known(action);
    const o = typeof owner === 'string' ? { owner } : owner;
    return this.engine.mod('input.gate', { ...o, id: action });
  }
  /**
   * Why a game action cannot be read right now, for a driver about to press it or that pressed it and saw nothing happen; [] when it is readable. Every cause,
   * top down: an opaque input context above the action's own ('win-settings', 'dialogue'...), 'shadowed-by:<context>' (a pass-through context above binds
   * the same key), or 'context-off:<context>' alone (its own context is not on the stack); then the owners of the action's gate. Pushes and removes
   * count at once, as in holders. A real key is blocked the same way, so this is the game's rule, not the driver's.
   * Without an action: every opaque context, which is runState.blockedBy's input part (one list, so the two never disagree)
   * @param {string} [action] @returns {string[]}
   * @internal
   */
  blockedBy(action) {
    if (action == null) return this.holders.filter(h => !h.pass).map(h => h.context);
    return [...blockers(this, action, settledStack(this)), ...(this._gated(action) ? this._gateStack.names(action) : [])];
  }
  /** @internal true while someone holds this action's gate */
  _gated(action) { return (this._gateStack ??= this.engine.stacks.get('input.gate')).size(action) > 0; }
  /**
   * False while an opaque context (menu, dialogue, cutscene...) covers gameplay: no game action can be read, and cameras ignore picture/zoom @returns {boolean}
   */
  get enabled() { return this._stack.every(c => c.pass); }

  /**
   * Movement direction: x positive right, y positive forward, length <= 1 (a snapshot of this step in fixed, the latest state in frame) @returns {{ x: number,
   * y: number }}
   */
  get axis() {
    if (!this.enabled) return { x: 0, y: 0 };
    if (this._inFixed) return { x: this._fx.x, y: this._fx.y };
    return this._axisInto({ x: 0, y: 0 });
  }
  /** @internal Write the live movement axis into out (beginFixed reuses its snapshot object: no allocation per step) */
  _axisInto(out) {
    out.x = out.y = 0;
    if (!this.enabled) return out;
    return moveAxis(this, this.stick.x + this.padStick.x, this.stick.y + this.padStick.y, out);
  }
  /** Take the snapshot at the start of a fixed step (also while frozen, so keys pressed during a freeze do not take effect only after unfreezing) @internal */
  beginFixed() {
    applyContexts(this);
    const f = this._fx;
    f.keys.clear(); for (const k of this.keys) f.keys.add(k);
    let t = f.pressed; f.pressed = this._accP; this._accP = t; t.clear();   // swap the two copies, no allocation
    t = f.released; f.released = this._accR; this._accR = t; t.clear();
    this._axisInto(f);
    for (const s of this.seats) s._axisInto(s._fx);
    this._inFixed = true;
  }
  /** @internal */
  endFixed() { this._inFixed = false; }


  /** @internal */
  endFrame() { this.frameCount++; this.justPressed.clear(); this.justReleased.clear(); this.look.dx = this.look.dy = this.look.zoom = 0; this.pointer.clicked = false; }
}

export const handRolled = [
  { kind: 'keys', seen: 'a raw keydown / keyup listener', use: "engine.input.define('jump', { label, keys }) in a module, the game binds keys with engine.input.bind (rebinding, contexts, gamepad); read engine.input.pressed(name) (recipe 58)", raw: /(?:^|[^\w.])(?:(?:window|document|self|globalThis|canvas|document\.body|[\w.]*domElement)\.)?(?:addEventListener\s*\(\s*['"]|on)key(?:down|up)\b/, yields: { kind: 'pause', raw: /['"]Escape['"]/ } },
  { kind: 'lock', seen: 'an input lock of its own', use: "engine.input.push('ride', { owner }) takes the keys and h.remove() gives them back: no key sticks, and describe().holds.input shows who holds them (recipe 07 §2b)", quiet: /\b(engine|e|eng|ctx)\.input\.(push|gate)\b|\blockInput\b/, code: /\b(?:let|var)\s+(?:input|controls?|keys)(?:Locked|Disabled|Enabled|Frozen)\s*=/i, tags: false },
];
