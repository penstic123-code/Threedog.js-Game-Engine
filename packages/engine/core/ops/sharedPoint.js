// Shared points: the ONE way several owners change a shared thing (time channels, the calendar rate, halt / freeze / camera holders, move speed,
// input gates, shadows.enabled, sky.tint, post values, a game's own). One entry, one line:
//   const h = engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });   // bullet time; h.remove() ends it early
//   ctx.mod('time.world', { mul: 0.8, layer: 'effect' });                                // inside a module: owned by it, removed with it
// Why entries and not "write the field, remember the old value": with two effects the remembered value is wrong as soon as they end in another
// order (bullet time saves 0.35 under a stopwatch, ends, the stopwatch restores 0.35 forever). Nothing here remembers an old value: every read
// equals a recompute from the base and the entries still there (a memo is reused only until the next change).
// Rules (the same for every point, so a tool can predict them):
//   - one entry per owner (per id on per-record points): the same owner writing again replaces its own entry (normal, never a conflict)
//   - only the owner ends it: handle.remove(); a stale handle (the owner wrote again) ends nothing; `for` seconds end it by itself
//   - a per-frame contribution (weather scaling the sun) takes once and calls handle.change(value) every frame: same entry, same op, new value;
//     taking again every frame would work too, but through ctx.mod it adds a cleanup entry per frame
//   - ONE layer table (LAYERS below), lowest first; inside a layer: set, then every add summed, then every mul, then every clamp.
//     A higher layer's set hides everything below. A number point is clamped to its own min / max last.
//   - two DIFFERENT owners `set` one point on one layer: every build throws shared-conflict naming both (and their code lines), the first value stays. add / mul / clamp never conflict: they are meant to stack.
//   - the settings layer only restricts: clamp { max } or mul 0..1 on a number, set false on a value point; it can never raise a number or
//     switch something on (one exception a point opts into with settingsSet: key bindings, where the player's rebinding is a replacement).
//     It sits above system: a cutscene or menu cannot turn back on what the player turned off; only debug overrides the player
//   - kinds: 'number' (default) | 'value' (any data: a color, a string, a boolean; set only) | 'any' (true while anyone holds it: freeze, gates)
//     | 'top' (the latest holder is in charge: the camera) | 'one' (an exclusive slot: a second holder is shared-taken; module `provides`)
// Plain JS stays first-class: a game's own fields and onFixed logic never need this; it is for things several owners write.
// The registry (engine.stacks: define / get / mod, save, timers, describe().shared) is core/ops/stacks.js.
import { codedError } from '../base/errorHints.js';
import { DEV, note, warnOnce } from '../base/validate.js';
import { callerAt } from './stackFrames.js';

/** The one layer table, lowest first. Who uses which: engine = the engine's own defaults and drivers, game = game code and
 *  game modules (the default), effect = temporary effects (weather, bullet time), system = cutscenes, menus, photo tools, settings = the
 *  player's settings menu (restrict only), debug = debug overrides and panels. Settings is above system so the player's restriction holds in a
 *  cutscene too (screen shake turned off stays off there); only debug can override it. */
export const LAYERS = { engine: 0, game: 200, effect: 300, system: 400, settings: 500, debug: 600 };
const NUM_OPS = ['set', 'add', 'mul', 'clamp'];
const LAYERED = new Set(['number', 'value']);
const KINDS = ['number', 'value', 'any', 'top', 'one'];

const fail = msg => codedError('mod-owner', msg);
/** what a value was, readable in a message: JSON.stringify turns NaN / Infinity into null, which hides the mistake */
const shown = v => (typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v));

/**
 * The one check of a number point's value, the same on engine.mod and handle.change (a NaN slipped in through either one makes the point NaN
 * from then on). set / add / mul: a finite number; clamp: { min?, max? } with each given bound a finite number and min <= max.
 * @param {string} op @param {any} v @param {string} call the call as the message names it
 */
function numCheck(op, v, call) {
  const bad = (expected, eg) => codedError('shared-value', `${call}: ${expected}, got ${op}: ${shown(v)}. Fix: ${eg}`);
  if (op !== 'clamp') { if (!Number.isFinite(v)) throw bad(`${op} is a finite number`, `${op}: 0.5`); return; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('clamp is { min?, max? }', 'clamp: { min: 0, max: 10 }');
  const { min, max } = v;
  for (const [k, b] of [['min', min], ['max', max]]) if (b != null && !Number.isFinite(b)) throw bad(`clamp.${k} is a finite number when given (leave it out for no bound)`, `clamp: { ${k}: 10 }`);
  if (min != null && max != null && min > max) throw bad(`clamp.min must be <= clamp.max (min ${min} > max ${max})`, `clamp: { min: ${max}, max: ${min} }`);
}

/**
 * freeze('x') and freeze({ owner: 'x' }) both work everywhere an owner is named
 * @param {string | { owner?: string } | undefined} a @param {any} [b] @returns {{ owner: string, opts: any }}
 */
export function ownerArgs(a, b, fallback = 'game') {
  if (a && typeof a === 'object') return { owner: a.owner ?? fallback, opts: a };
  return { owner: /** @type {string | undefined} */ (a) ?? fallback, opts: b ?? {} };
}

/** 'sky.flash' or 'move.speed[player]': the name a message and describe().shared use */
const label = (name, id) => (id == null ? name : `${name}[${id}]`);

/** a value as describe / how-strings / the changed line print it (a rule's value may be a function; JSON.stringify(undefined) is undefined) */
export const showValue = v => (typeof v === 'number' ? String(+v.toFixed(4)) : typeof v === 'function' ? 'function' : JSON.stringify(v) ?? String(v));

/** One shared point. Made by engine.stacks.define; games normally only call engine.mod(name, ...) and read value(). */
export class Stack {
  /** @param {any} all the registry @param {string} name @param {any} o */
  constructor(all, name, { kind = 'number', base, min = -Infinity, max = Infinity, save = true, onChange = null, per = false, manual = null, settingsSet = false, important = false }) {
    if (!KINDS.includes(kind)) throw fail(`engine.stacks.define('${name}', { kind }): kind is ${KINDS.join(' / ')}, got ${JSON.stringify(kind)}`);
    if (typeof important !== 'boolean') throw codedError('shared-value', `engine.stacks.define('${name}', { important }): important is true or false, got ${shown(important)}. Fix: { important: true }`);
    this.all = all; this.name = name; this.kind = kind;
    /** stays on the "values being changed now" line (stacks.changed) even at its base */
    this.important = important;
    this.base = base ?? (kind === 'number' ? 1 : kind === 'any' ? false : null);
    // a number point's base is validated like min / max: NaN would pass the nullish default and every read would stay NaN whatever the bounds are
    if (kind === 'number' && !Number.isFinite(this.base)) throw codedError('shared-value', `engine.stacks.define('${name}', { base }): base is a finite number, got ${shown(this.base)}. Fix: { base: 1 }`);
    for (const [k, b] of [['min', min], ['max', max]]) if (typeof b !== 'number' || Number.isNaN(b)) throw codedError('shared-value', `engine.stacks.define('${name}', { ${k} }): ${k} is a number (leave it out for no bound), got ${shown(b)}`);
    if (min > max) throw codedError('shared-value', `engine.stacks.define('${name}', { min, max }): min must be <= max, got min ${min} > max ${max}. Fix: { min: ${max}, max: ${min} }`);
    this.min = min; this.max = max; this.save = save; this.per = per; this.onChange = onChange;
    /** the copyable "take it over on purpose" call the conflict error offers (a module's own takeover entry); default: a set on the system layer */
    this.manual = manual;
    /** the settings layer may set here (key bindings: the player's rebinding replaces the game's keys, it is not a restriction) */
    this.settingsSet = settingsSet;
    /** @type {Map<string, Map<string, any>>} id ('' when not per record) -> owner -> entry */
    this._by = new Map();
    // value memo: id -> { ver, base, v }. Movers read speed / gravity per character per step; every change goes through _changed, which bumps _ver
    this._ver = 0; this._memo = new Map();
  }
  /** @internal */
  _map(id, make) { let m = this._by.get(id ?? ''); if (!m && make) this._by.set(id ?? '', m = new Map()); return m; }
  /**
   * Add or replace owner's entry (engine.mod and ctx.mod call this). number: exactly one of set / add / mul / clamp ({ min, max });
   * value: set; any / one: nothing needed (holding is the value; value is optional data); top: value (e.g. the camera focus).
   * @returns {{ owner: string, remove(): void, change(value: any): boolean }}
   */
  take(o) {
    const { owner, layer, op, value, clock, at } = this._entry(o);
    const m = this._map(o.id, true), old = m.get(owner);
    this._clash(m, owner, op, layer, at);
    // the clock is asked before the old entry goes: an unknown channel throws, and the entry that was there must still be there then
    const until = o.for != null ? this.all._nowOf(clock) + o.for : null;
    // Taking again: delete the old entry and put a new object at the end. Why not edit in place: the Map order would not change, so neither the
    // 'top' latest nor the latest set would be it; and the old handle would then remove the new value. A new object makes a stale handle's _drop miss.
    m.delete(owner);
    // where: the code line of the first take (dev only). Kept on rewrites, so a weather module re-taking every frame costs no stack walk
    const ent = { owner, id: o.id ?? null, since: this.all._at(), where: old ? old.where : callerAt(), op, value, layer, clock, until };
    m.set(owner, ent);
    this.all.engine._picture?.sharedTook(this.name, ent);   // dev server only: the point's history for explain({ value })
    if (ent.until != null) this.all._timedDirty = true;
    this._changed(o.id);
    return { owner, remove: () => { this._drop(owner, o.id, ent); }, change: v => this._rewrite(ent, v, at) };
  }
  /**
   * @internal The one check of an entry (owner, layer, the op and its value, per id, for), the same for engine.mod and for a save putting entries back (_fromSave):
   * a load that skipped it let a damaged save make a point NaN. Throws naming the call; touches nothing.
   * @returns {{ owner: string, layer: string, op: string | null, value: any, clock: string, at: string }}
   */
  _entry(o) {
    const { owner } = o, at = label(this.name, o.id);
    if (!owner || typeof owner !== 'string') throw fail(`engine.mod('${at}', { owner }): owner is a non-empty string naming who changes it, e.g. 'my-menu', got ${JSON.stringify(owner)}`);
    const layer = o.layer ?? 'game';
    if (!(layer in LAYERS)) throw codedError('shared-layer', `engine.mod('${at}', { layer }): layer is one of ${Object.keys(LAYERS).join(' < ')}, got ${JSON.stringify(layer)}`);
    let op = null, value;
    if (this.kind === 'number') {
      const ops = NUM_OPS.filter(k => o[k] !== undefined);
      if (ops.length !== 1) throw fail(`engine.mod('${at}', { owner: '${owner}', ... }): give exactly one of set / add / mul / clamp, e.g. { owner: '${owner}', mul: 0.5 }; got ${ops.length ? ops.join(' + ') : 'none'}`);
      op = ops[0]; value = o[op];
      numCheck(op, value, `engine.mod('${at}', { owner: '${owner}', ${op} })`);
    } else if (this.kind === 'value') {
      if (o.set === undefined || NUM_OPS.some(k => k !== 'set' && o[k] !== undefined)) throw fail(`engine.mod('${at}', { owner: '${owner}', set }): '${this.name}' holds a value (a color, a string, a flag), so only set works, e.g. { owner: '${owner}', set: ${JSON.stringify(this.base ?? '#88aacc')} }`);
      op = 'set'; value = o.set;
    } else value = o.value ?? (this.kind === 'top' ? null : true);   // any / one: optional data beside the hold; top: the holder's value
    if (layer === 'settings') this._restricts(op, value, `engine.mod('${at}', { owner: '${owner}', layer: 'settings', ${op}: ${JSON.stringify(value)} })`);
    if (this.per === true && o.id == null) throw fail(`engine.mod('${this.name}'): this point is per record, pass { id }, e.g. { owner: '${owner}', id: 'slime_3', ... }`);
    const clock = o.clock ?? 'real';
    if (o.for != null && !(o.for >= 0 && Number.isFinite(o.for))) throw fail(`engine.mod('${at}', { for }): for is seconds >= 0 on clock '${clock}', got ${JSON.stringify(o.for)}`);
    return { owner, layer, op, value, clock, at };
  }
  /**
   * @internal A saved list of entries ({ owner, id, op, value, layer, clock, left }) checked as engine.mod would take them, one after another: each entry by _entry,
   * and the list by the conflict rule (two owners setting one layer). Why the list on its own: the entries a load keeps (system / settings / debug) are on other
   * layers than the saved ones, so they cannot clash with them. Throws on the first bad entry and touches nothing (the caller keeps what the point had).
   * @param {any} list @param {(layer: any) => string} layerOf how the registry files a saved layer @returns {any[]} the entries, normalized
   */
  _fromSave(list, layerOf) {
    if (!Array.isArray(list)) throw fail(`'${this.name}': a list of entries, got ${shown(list)}`);
    const seen = new Map();   // id -> owner -> entry: the list's own conflict check
    return list.map(e => {
      if (!e || typeof e !== 'object') throw fail(`'${this.name}': an entry is an object, got ${shown(e)}`);
      const op = e.op, left = e.left == null ? undefined : Math.max(0, e.left);   // a timer already due loads as due
      const o = { owner: e.owner, id: e.id ?? undefined, layer: layerOf(e.layer), clock: e.clock ?? 'real', for: left, ...(NUM_OPS.includes(op) ? { [op]: e.value } : {}) };
      const c = this._entry(o), m = seen.get(o.id ?? '') ?? new Map();
      seen.set(o.id ?? '', m);
      this._clash(m, c.owner, c.op, c.layer, c.at);
      m.set(c.owner, { owner: c.owner, op: c.op, layer: c.layer, where: null });
      return { owner: c.owner, id: o.id ?? null, op: c.op, value: c.value, layer: c.layer, clock: c.clock, left: left ?? null };
    });
  }
  /** @internal the settings layer only restricts: a number goes down (mul 0..1, clamp with only a max), a value point goes off (set false).
   *  Checked on take and on handle.change, so a settings entry cannot be raised afterwards either */
  _restricts(op, value, call) {
    if (!LAYERED.has(this.kind) || this.settingsSet) return;
    const ok = this.kind === 'number'
      ? (op === 'mul' && value >= 0 && value <= 1) || (op === 'clamp' && value.min == null && value.max != null)
      : value === false;
    if (ok) return;
    const fix = this.kind !== 'number' ? `{ layer: 'settings', set: false } to switch it off, or leave it out to allow what the scene chose`
      : op === 'mul' ? `a factor from 0 to 1, e.g. { layer: 'settings', mul: 0.5 }; a value above 1 raises it: write that on the game layer instead`
      : op === 'clamp' ? `only a ceiling, e.g. { layer: 'settings', clamp: { max: ${JSON.stringify(value.max ?? value.min)} } }; a floor (min) raises the value: write it on the game layer instead`
      : `a ceiling { layer: 'settings', clamp: { max: ${JSON.stringify(value)} } } or a factor { layer: 'settings', mul: 0.5 }`;
    throw codedError('shared-settings', `${call}: the settings layer only restricts (it can turn things down or off, never up or on). Fix: ${fix}`);
  }
  /**
   * @internal handle.change(v): the entry's value rewritten in place (same op, layer, owner, position), so a per-frame contribution is one entry
   * for its whole life and one tracked handle (ctx.mod), not a new entry and a new cleanup handle every frame. A stale or removed handle changes
   * nothing (false), like its remove(). An object value is always taken as changed (the caller may have mutated the same object).
   */
  _rewrite(ent, v, at) {
    const m = this._map(ent.id);
    if (!m || m.get(ent.owner) !== ent) return false;
    if (this.kind === 'number') numCheck(ent.op, v, `handle.change() on '${at}' (owner '${ent.owner}', ${ent.op})`);
    else if (this.kind === 'value' && v === undefined) throw fail(`handle.change() on '${at}': a value point needs a value, got undefined`);
    if (ent.layer === 'settings') this._restricts(ent.op, v, `handle.change(${JSON.stringify(v)}) on '${at}' (settings layer, ${ent.op})`);
    if (ent.value === v && (v === null || typeof v !== 'object')) return true;
    ent.value = v;
    this._changed(ent.id ?? undefined);
    return true;
  }
  /** @internal the conflict rule: another owner's set on the same layer, or another holder of an exclusive slot. The engine never picks silently:
   *  every build (development and release alike) throws naming both sides with copyable fixes; the earlier entry stays. */
  _clash(m, owner, op, layer, at) {
    const slot = this.kind === 'one';
    if (!slot && op !== 'set') return;
    for (const e of m.values()) {
      if (e.owner === owner || (!slot && (e.op !== 'set' || e.layer !== layer))) continue;
      const side = (n, w) => `'${n}'${w ? ` (${w})` : ''}`, both = `${side(e.owner, e.where)} and ${side(owner, callerAt())}`;
      const msg = slot
        ? `'${at}' is an exclusive slot: ${both} both provide it. Rule: only one owner may hold an exclusive slot. `
          + `Fix: engine.use(yourModule(), { replaces: '${this.name}' }) (unloads '${e.owner}' cleanly, its changes go with it), or install only one of them`
        // a value point (a color, a switch) has no multiplier, so its fixes start at "another layer": never advise a call that would throw
        : `'${at}': two owners set it on layer '${layer}': ${both}. Rule: on each layer only one owner sets a value; add / mul cooperate. Fix, one of: `
          + (this.kind === 'number' ? `(1) contribute instead of deciding: engine.mod('${this.name}', { owner: '${owner}', mul: 0.5 }); ` : `(1) end the other first (its handle's remove()); `)
          + `(2) decide on another layer: engine.mod('${this.name}', { owner: '${owner}', set: ..., layer: '${layer === 'game' ? 'effect' : 'game'}' }); `
          + `(3) take it over on purpose: ${this.manual ?? `engine.mod('${this.name}', { owner: '${owner}', set: ..., layer: 'system' }) (hides every layer below)`}`;
      const code = slot ? 'shared-taken' : 'shared-conflict';
      throw codedError(code, msg);
    }
  }
  /** @internal remove owner's entry (only `ent` when given: a stale handle removes nothing) */
  _drop(owner, id, ent) {
    const m = this._map(id);
    if (!m || (ent && m.get(owner) !== ent) || !m.delete(owner)) return false;
    if (!m.size && (id ?? '') !== '') this._by.delete(id);
    this._changed(id);
    return true;
  }
  /** @internal */
  _changed(id) { this._ver++; this.all._version++; this.onChange?.(id ?? null); }
  /** @internal End owner's entry by name (engine holds: the halt handle); games end theirs with the handle's remove(). false when it held none @param {string} owner @param {{ id?: string }} [o] */
  release(owner, { id } = {}) { return this._drop(owner, id); }
  /** Drop every entry for record id (world.remove does it, so no orphan entries) @param {string} id */
  dropId(id) { this._memo.delete(id); const m = this._by.get(id); if (!m) return; this._by.delete(id); this._changed(id); }
  /** @param {string} owner @param {string} [id] */
  has(owner, id) { return !!this._map(id)?.has(owner); }
  /** Number of entries (for id, or the global ones) */
  size(id) { return this._map(id)?.size ?? 0; }
  /** Owner names in the order they took it @param {string} [id] */
  names(id) { return [...(this._map(id)?.keys() ?? [])]; }
  /**
   * The current value: always equal to recomputing from base + the entries now present.
   * number / value: the layered result; any: true while anyone holds it; top: the latest holder's value (or base); one: the holder's owner name or null.
   * base: a base kept elsewhere (a character's own speed: the game writes player.speed, the point only holds the modifiers), default the point's.
   * per: 'optional' points combine the entries without an id (every record) with the record's own, the record's after, so its set wins a tie.
   * @param {string} [id] @param {any} [base]
   */
  value(id, base = this.base) {
    const m = this._map(id), all = this.per === 'optional' && id != null ? this._map(undefined) : null;
    if (this.kind === 'any') return m?.size || all?.size ? true : base;
    if (this.kind === 'top') { const t = this.top(id); return t ? t.value : base; }
    if (this.kind === 'one') return this.top(id)?.owner ?? null;
    const num = this.kind === 'number', fit = v => (num ? Math.min(this.max, Math.max(this.min, v)) : v);
    if (!m?.size && !all?.size) return fit(base);
    const k = id ?? '', c = this._memo.get(k);
    if (c && c.ver === this._ver && Object.is(c.base, base)) return c.v;
    const list = this._list(m, all), v = fit(this._combine(list, base));
    if (c) { c.ver = this._ver; c.base = base; c.v = v; } else this._memo.set(k, { ver: this._ver, base, v });
    if (DEV) this._hint(list, v, id);
    return v;
  }
  /** @internal dev, once per point and owner: a game-layer set is shown as another number because effects above changed it. Not a warning
   *  (that is the rule: effects apply on top of what the game set); it says why the screen differs and how to lock the number.
   *  A switch is a warning instead: the lower layer's set loses outright, so it names the holder and its layer. */
  _hint(list, v, id) {
    let lead = null;
    for (const e of list) if (e.op === 'set' && (!lead || LAYERS[e.layer] >= LAYERS[lead.layer])) lead = e;
    // a switch: the set in charge wins, and a lower-layer set that said the other thing gets nothing on screen, so say who holds it (a warning: the writer's intent is lost)
    if (typeof v === 'boolean') {
      if (lead) for (const e of list) if (e.op === 'set' && e.value !== v && LAYERS[e.layer] < LAYERS[lead.layer]) {
        warnOnce(`'${e.owner}' set ${label(this.name, id)} ${e.value} (${e.layer} layer), but '${lead.owner}' holds it ${lead.value} on the ${lead.layer} layer, which wins; the shown value is ${v}. `
          + `Lift that hold, or set it from a layer above ${lead.layer}, if ${e.value} is wanted.`, `shared-hint:${this.name}:${e.owner}`);
      }
      return;
    }
    if (!lead || lead.layer !== 'game' || typeof v !== 'number' || Math.abs(v - lead.value) < 1e-9) return;
    const above = list.filter(e => LAYERS[e.layer] > LAYERS.game);
    if (!above.length) return;
    // once per page for each point and owner (note's dedupe, like warnOnce)
    note(`'${lead.owner}' set ${label(this.name, id)} ${lead.value}, shown ${+v.toFixed(4)} = ${this._how(list, lead, LAYERS.game)}. `
      + `That is the rule (effects apply on top of what the game set). To lock the number: ${this.manual ?? `engine.mod('${this.name}', { owner: '${lead.owner}', set: ${lead.value}, layer: 'system' })`}`, `shared-hint:${this.name}:${lead.owner}`);
  }
  /** @internal the entries that apply to one id, in take order */
  _list(m, all) { return all?.size ? [...all.values(), ...(m?.values() ?? [])] : [...(m?.values() ?? [])]; }
  /** @internal the layered combine (the rules in the header), lowest layer first */
  _combine(list, base) {
    let v = base;
    for (const L of Object.values(LAYERS)) {
      const es = list.filter(e => LAYERS[e.layer] === L);
      if (!es.length) continue;
      for (const e of es) if (e.op === 'set') v = e.value;   // the latest set in the layer (Map keeps take order; dev builds never have two)
      for (const e of es) if (e.op === 'add') v += e.value;
      for (const e of es) if (e.op === 'mul') v *= e.value;
      for (const e of es) if (e.op === 'clamp') v = Math.min(e.value.max ?? Infinity, Math.max(e.value.min ?? -Infinity, v));
    }
    return v;
  }
  /** Each holder's value in take order: [{ owner, value }] (the data an 'any' holder gave, e.g. a freeze's kind) @param {string} [id] */
  entries(id) { return [...(this._map(id)?.values() ?? [])].map(e => ({ owner: e.owner, value: e.value })); }
  /** The latest holder's entry ({ owner, value }) or null: the camera in charge, the slot's holder @param {string} [id] */
  top(id) { let t = null; const m = this._map(id); if (m) for (const e of m.values()) t = e; return t; }
  /** What describe().holds shows per entry: [{ owner, op?, value?, layer?, left?, clock?, at? }] @param {string} [id] */
  holders(id) { return [...(this._map(id)?.values() ?? [])].map(e => this._show(e)); }
  /** @internal one entry for describe: at = its code line (dev), left = seconds still to run */
  _show(e) {
    /** @type {{ owner: string, layer?: string, op?: string, value?: any, left?: number, clock?: string, at?: string, hidden?: boolean }} */
    const h = { owner: e.owner };
    if (LAYERED.has(this.kind)) Object.assign(h, { layer: e.layer, op: e.op, value: e.value });
    else if (this.kind === 'any' && e.value !== true) h.value = e.value;
    if (e.until != null) Object.assign(h, { left: Math.max(0, e.until - this.all._nowOf(e.clock)), clock: e.clock });
    if (e.where) h.at = e.where;
    return h;
  }
  /**
   * The describe().shared row for one id: { value, writer, layer?, at?, also: [...] }. writer = the owner whose value the rest acts on (the set in
   * charge, the slot's holder, the camera's latest holder; 'default' when none); also = every other entry, hidden: true when a set above hides it.
   * @param {string} [id]
   */
  row(id) {
    const m = this._map(id), list = this._list(m, this.per === 'optional' && id != null ? this._map(undefined) : null);
    let lead = null;
    if (LAYERED.has(this.kind)) { for (const e of list) if (e.op === 'set' && (!lead || LAYERS[e.layer] >= LAYERS[lead.layer])) lead = e; }
    else lead = this.kind === 'any' ? list[0] : list.at(-1);
    // the base this record is read with: a mover passes the character's own speed to value(id, base), the memo keeps the last one read; the
    // define-time base is only the fallback (a point nobody has read yet)
    const base = this._memo.has(id ?? '') ? this._memo.get(id ?? '').base : this.base;
    /** @type {{ value: any, base: any, writer: string, layer?: string, at?: string, also?: object[], how?: string }} */
    const r = { value: this.value(id ?? undefined, base), base, writer: lead ? lead.owner : 'default' };
    if (lead?.layer && LAYERED.has(this.kind)) r.layer = lead.layer;
    if (lead?.where) r.at = lead.where;
    const hiddenBelow = lead && LAYERED.has(this.kind) ? LAYERS[lead.layer] : -Infinity;
    r.also = list.filter(e => e !== lead).map(e => {
      const h = this._show(e);
      if (LAYERED.has(this.kind) ? LAYERS[e.layer] < hiddenBelow : this.kind === 'top') h.hidden = true;
      return h;
    });
    if (LAYERED.has(this.kind)) r.how = this._how(list, lead, hiddenBelow, base);
    return r;
  }
  /** @internal how the value was combined, in the order it was: "cave 180 × storm 0.6" (layer order, then set / add / mul / clamp) */
  _how(list, lead, from, base = this.base) {
    const show = showValue;
    const parts = lead ? [] : [`default ${show(base)}`];
    for (const L of Object.values(LAYERS)) {
      if (L < from) continue;
      const es = list.filter(e => LAYERS[e.layer] === L);
      for (const e of es) if (e.op === 'set') parts.push(e === lead || !parts.length ? `${e.owner} ${show(e.value)}` : `then ${e.owner} ${show(e.value)}`);
      for (const e of es) if (e.op === 'add') parts.push(`+ ${e.owner} ${show(e.value)}`);
      for (const e of es) if (e.op === 'mul') parts.push(`× ${e.owner} ${show(e.value)}`);
      for (const e of es) if (e.op === 'clamp') parts.push(`clamp ${e.owner} ${e.value.min ?? ''}..${e.value.max ?? ''}`);
    }
    return parts.join(' ');
  }
  /** The ids that have entries (per-record points) */
  ids() { return [...this._by.keys()].filter(k => k !== ''); }
  /** Drop every entry */
  clear() { this._memo.clear(); if (!this._by.size) return; const ids = [...this._by.keys()]; this._by.clear(); for (const id of ids) this._changed(id || null); }
}

