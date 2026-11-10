// A seat: one local player's share of the keyboard and gamepads, on a shared screen. It reads like engine.input (axis, down, pressed, released), through the same key sets,
// fixed-step snapshot and contexts, so a control function can't tell them apart. Only the routing differs: a seat hears its own keys and its own pad, nothing else.
// A pad's buttons come in as 'PadA@1' (inputPad.js), so a seat with a pad uses the game's pad bindings without binding anything itself, and that pad leaves engine.input.
import { readParams, keysSchema } from '../base/params.js';
import { codedError } from '../base/errorHints.js';

const SEAT_PARAMS = keysSchema(['pad', 'keys']);

/** A stick's (x, y) plus the four move actions as src reads them, at most length 1, into out: engine.input and a seat add up alike @internal */
export function moveAxis(src, x, y, out) {
  if (src.down('moveForward')) y += 1;
  if (src.down('moveBack')) y -= 1;
  if (src.down('moveLeft')) x -= 1;
  if (src.down('moveRight')) x += 1;
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  out.x = x; out.y = y;
  return out;
}

export class Seat {
  /** @param {any} input engine.input @param {{ pad?: number, keys?: Record<string, string | string[]> }} opts */
  constructor(input, opts) {
    readParams('engine.input.seat()', SEAT_PARAMS, opts);
    const { pad, keys = {} } = opts;
    if (pad !== undefined && !(Number.isInteger(pad) && pad >= 0)) throw codedError('input-seat', `engine.input.seat(): pad is a gamepad index (0, 1, ...), got ${JSON.stringify(pad)}`);
    /** @internal */ this.input = input;
    /** The gamepad index this seat owns, if any @type {number | undefined} */ this.pad = pad;
    /** Who this seat acts for, as engine.actor for engine.input: addPlayer sets the player's id; interactions read it. Set it to hand the seat to a vehicle or a squad member @type {string | null} */ this.actor = null;
    /** @internal action -> this seat's keyboard keys */ this.own = new Map(Object.entries(keys).map(([a, k]) => [a, [k].flat()]));
    for (const s of input.seats) {
      if (pad !== undefined && s.pad === pad) throw codedError('input-seat', `engine.input.seat(): pad ${pad} already has a seat; give each seat its own pad`);
      for (const list of this.own.values()) for (const k of list) if ([...s.own.values()].some(l => l.includes(k))) throw codedError('input-seat', `engine.input.seat(): key ${k} already belongs to another seat`);
    }
    /** @internal the pad's stick, written by pollPad */ this.padStick = { x: 0, y: 0 };
    /** @internal */ this._padOn = false;
    /** @internal the axis of this fixed step */ this._fx = { x: 0, y: 0 };
  }
  /** Same list as engine.input.actions: actions are the game's, a seat only routes them */
  get actions() { return this.input.actions; }
  /** The keys that count for an action on this seat: its own, and the game's pad keys on its pad @internal */
  _keysOf(action) {
    const own = this.own.get(action) ?? [];
    if (this.pad === undefined) return own;
    return [...own, ...this.input.keysOf(action).filter(k => k.startsWith('Pad')).map(k => `${k}@${this.pad}`)];
  }
  /** Held, as engine.input.down @param {string} action @returns {boolean} */
  down(action) { return this.input._has(action, 'keys', this._keysOf(action)); }
  /** Just pressed, as engine.input.pressed @param {string} action @returns {boolean} */
  pressed(action) { return this.input._has(action, 'pressed', this._keysOf(action)); }
  /** Just released, as engine.input.released @param {string} action @returns {boolean} */
  released(action) { return this.input._has(action, 'released', this._keysOf(action)); }
  /** Movement direction, as engine.input.axis @returns {{ x: number, y: number }} */
  get axis() {
    if (!this.input.enabled) return { x: 0, y: 0 };
    return this.input._inFixed ? { x: this._fx.x, y: this._fx.y } : this._axisInto({ x: 0, y: 0 });
  }
  /** @internal */
  _axisInto(out) { return moveAxis(this, this.padStick.x, this.padStick.y, out); }
  /** Give the keys and pad back: the pad goes to engine.input again if no other seat holds it */
  remove() {
    const I = this.input, at = I.seats.indexOf(this);
    if (at < 0) return;
    I.seats.splice(at, 1);
    for (const k of [...I.keys]) if (k.endsWith(`@${this.pad}`)) I._keyUp(k);
  }
}
