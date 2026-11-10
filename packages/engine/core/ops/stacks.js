// engine.stacks: the registry of every shared point (the point itself and its rules are core/ops/sharedPoint.js). Here: define / get / mod, the timers
// behind `for`, saving entries, and describe().shared. Kept apart from sharedPoint.js only for size: the rules read without the bookkeeping between.
import { codedError, coded } from '../base/errorHints.js';
import { refuseSave } from '../base/saveValues.js';
import { DEV, warnOnce } from '../base/validate.js';
import { Stack, showValue } from './sharedPoint.js';

const BAD_SAVED = "[saves] shared value '{name}' in the save was not restored ({why}); the save is from a build that defined it differently. The next save writes what is defined now";
const KEYS = ['owner', 'set', 'add', 'mul', 'clamp', 'value', 'for', 'clock', 'id', 'layer'];
// Saved: engine / game / effect entries (what the playthrough did). Not saved: system / debug (menus, cutscenes, debug: "what the
// screen is doing now", retaken after a load), settings (the settings module re-applies the player's choices from its own prefs)
const SAVED = new Set(['engine', 'game', 'effect']);
const saved = e => SAVED.has(e.layer);
const layerOf = l => (SAVED.has(l) ? l : 'game');
// a saved entry of a point not defined yet: only its shape can be checked before the point says its kind (the rest is checked when it is defined)
const OPS = ['set', 'add', 'mul', 'clamp'];
const entryShape = e => !!e && typeof e === 'object' && typeof e.owner === 'string' && !!e.owner && OPS.includes(e.op) && (e.left == null || Number.isFinite(e.left));

/** engine.stacks: every shared point by name; engine.mod(name, o) is the one way to change one */
export class Stacks {
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, Stack>} */ this._all = new Map();
    /** @internal saved entries of a point the game has not defined yet: applied when it does */ this._pending = {};
    this._version = 0; this._timedDirty = false;
    /** @internal now on a clock ('real' or a channel); core/time/time.js replaces it */ this._nowOf = () => 0;
    // since = game clock time of the take (calendar seconds), not engine.time.now('real'): session.newGame resets the clock, so an entry a fresh
    // playthrough makes reads the same in every new game
    this._at = () => this._nowOf('calendar');
  }
  /** @internal saves and world:remove. The registry is made before them (Engine.js: the drawing parts' points exist from the first drawing part on);
   *  createServices calls this once saves and events exist */
  _hook() {
    const e = this.engine;
    e.saves.define('stacks', { notAtomic: 'a mod is ended through the handle its owner keeps, which a load cannot put back', save: () => this._save(), load: d => this._load(d) });
    // input.keys and input.gate key their entries by action name, not record id: a removed record 'fire' must not unbind the action 'fire'
    e.events.on('world:remove', ({ id }) => { for (const s of this._all.values()) if (s.per && !s.name.startsWith('input.')) s.dropId(id); });
  }
  /**
   * Define a shared point (engine modules and games use the same call). kind: 'number' (default; base 1), 'value' (any data, set only), 'any'
   * (true while held), 'top' (latest holder wins), 'one' (an exclusive slot; modules take theirs with `provides`).
   * per: true = one value per record id (mod with { id }); per: 'optional' = an entry with { id } is that record's, one without is every record's
   * (move.speed: haste on the player, mud on everyone). save: false keeps it out of saves (screen state like the camera holder).
   * manual: the copyable takeover call the conflict error offers (a drawing part's manual()).
   * @param {string} name @param {{ kind?: 'number' | 'value' | 'any' | 'top' | 'one', base?: any, min?: number, max?: number, per?: boolean | 'optional', save?: boolean, manual?: string, settingsSet?: boolean, important?: boolean, onChange?: (id: string | null) => void }} [o]
   * @returns {Stack}
   * @example engine.stacks.define('damageTaken', { per: true, min: 0 }); engine.mod('damageTaken', { owner: 'shield', id: 'player', mul: 0.5, for: 3 });
   */
  define(name, o = {}) {
    if (this._all.has(name)) throw codedError('engine-misuse', `engine.stacks.define('${name}'): already defined; read it with engine.stacks.get('${name}')`);
    const s = new Stack(this, name, o);
    this._all.set(name, s);
    if (this._pending[name]) { this._loadOne(s, this._pending[name]); delete this._pending[name]; }   // checked now that the kind is known
    return s;
  }
  /**
   * @internal The reader behind ctx.rule: a replaceable rule is a plain shared point (kind 'value', per: 'optional', save: false), so owners, conflict
   * errors, layers, cleanup with the module and describe().shared are the ones every other point has; nothing here is a second registry.
   * Why the default lives in the reader and not in the point: two systems may share one rule ('fall' covers bodies and characters) and a module can be
   * replaced and installed again, so asking for a rule that exists is normal, and each reader keeps its own default.
   * Not saved because a function cannot be; whoever set one still holds it after a load, like a control hold.
   * @param {string} name @param {any} def @param {string[] | null} [names] the built-in names a decision may be; default just def when def is a name
   * @returns {{ name: string, value(id?: string): any, decide(id: string | undefined | null, facts: any): any }}
   */
  rule(name, def, names = typeof def === 'string' ? [def] : null) {
    const s = this.has(name) ? this.get(name) : this.define(name, { kind: 'value', per: 'optional', save: false });
    if (s.kind !== 'value' || s.per !== 'optional') throw codedError('engine-misuse', `ctx.rule('${name}'): '${name}' is already a shared point of another shape (kind ${s.kind}), not a rule; pick another name`);
    const value = id => s.value(id ?? undefined, def);
    return { name, value,
      // the check runs at the decision, not at engine.mod: the point is plain and takes any value, and a function's answer can only be checked here anyway
      decide: (id, facts) => {
        const v = value(id), d = typeof v === 'function' ? v(facts, this.engine) : v;
        if (typeof d === 'string' && names && !names.includes(d)) throw codedError('unknown-name', `rule '${name}'${id == null ? '' : ` for '${id}'`}: '${d}' is not one of its built-in names (${names.join(', ')}). Fix: engine.mod('${name}', { owner, set: ${names.map(n => `'${n}'`).join(' | ')} | false | (facts, engine) => decision })`);
        return d;
      } };
  }
  /** @param {string} name @returns {Stack} */
  get(name) {
    const s = this._all.get(name);
    if (!s) throw codedError('unknown-name', `engine.stacks: no shared point '${name}'. Known: ${[...this._all.keys()].join(', ')}. Define your own with engine.stacks.define('${name}', { base })`);
    return s;
  }
  /** @param {string} name */
  has(name) { return this._all.has(name); }
  /** Names of every point */
  list() { return [...this._all.keys()]; }
  /**
   * @internal The entry behind engine.mod (services.js hands it out): games and modules call engine.mod / ctx.mod; stacks.define, get, changed and describe stay public.
   * The one entry: change a shared point; returns a handle whose remove() ends only this owner's entry.
   * @param {string} name @param {{ owner: string, set?: any, add?: number, mul?: number, clamp?: { min?: number, max?: number }, value?: any, for?: number, clock?: string, id?: string, layer?: 'engine' | 'game' | 'effect' | 'system' | 'settings' | 'debug' }} o
   * @returns {{ owner: string, remove(): void, change(value: any): boolean }} remove() ends it; change(v) rewrites its value in place (same op, layer)
   */
  mod(name, o) {
    if (DEV) { const bad = Object.keys(o ?? {}).filter(k => !KEYS.includes(k)); if (bad.length) warnOnce(`engine.mod('${name}'): unknown option ${bad.join(', ')}; known: ${KEYS.join(', ')}`); }
    return this.get(name).take(o ?? {});
  }
  /**
   * describe().shared: one row per point that has entries (or that the engine yielded to a three.js write):
   * { 'time.enemies': { value, writer, layer?, at?, how?, also: [{ owner, layer, op, value, left?, at?, hidden? }] } }.
   * Per-record points show as 'move.speed[player]'; a per: 'optional' point's every-record entries as 'move.speed[*]'.
   */
  describe(rows = this._rows()) { return Object.fromEntries(rows.filter(x => x.has).map(x => [x.label, x.row])); }
  /** @internal one snapshot of every point's row (describe() and changed() take it, so a describe builds the rows once). has = the point has entries */
  _rows() {
    const out = [], add = (label, s, row, has) => out.push({ label, s, row, has });
    for (const s of this._all.values()) {
      if (s.per) {
        for (const id of s.ids()) add(`${s.name}[${id}]`, s, s.row(id), true);
        if (s.size()) add(`${s.name}[*]`, s, s.row(), true);
      } else add(s.name, s, s.row(), s.size() > 0);
    }
    return out;
  }
  /**
   * The values being changed now: [{ name, base, now, how, text }], at most `max`, the furthest from base first. A point is in when its value is off
   * its base (the base the record is read with, e.g. the character's own speed), a settings entry caps it, or it was defined with
   * { important: true } (then also at base). Only number / value points: a hold or the camera slot has no base to be off. Two owners setting one
   * layer throws at take, so a conflict never exists to list here.
   * describeText's "Values being changed now" line and the dev panel's folder both read this, nothing computes it a second way.
   * @param {number} [max] @param {ReturnType<Stacks['_rows']>} [snap] rows already taken (describe passes its own)
   * @example engine.stacks.changed() // [{ name: 'move.speed[player]', base: 6, now: 4.2, how: 'default 6 × haste 1.4 × mud 0.5' }]
   */
  changed(max = 5, snap = this._rows()) {
    const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const rows = [];
    for (const { label: name, s, row: r, has } of snap) {
      if (s.kind !== 'number' && s.kind !== 'value') continue;
      const off = has && !same(r.value, r.base), capped = r.layer === 'settings' || r.also.some(h => h.layer === 'settings');
      if (!off && !capped && !s.important) continue;
      const far = off ? (s.kind === 'number' ? Math.abs(r.value - r.base) / Math.max(Math.abs(r.base), 1) : 1) : 0;
      rows.push({ name, base: r.base, now: r.value, how: r.how, text: `${name} ${showValue(r.base)} → ${showValue(r.value)}${r.how ? ` (${r.how})` : ''}`, far, keep: s.important });
    }
    // important points are picked first (they must not fall off the cap), then the list is ordered by distance from base
    const pick = rows.sort((a, b) => b.keep - a.keep || b.far - a.far).slice(0, max);
    return pick.sort((a, b) => b.far - a.far).map(({ far, keep, ...row }) => row);
  }
  /**
   * Everything one owner changes now, grouped the other way round from describe().shared: "what did rainyNight change?"
   * @param {string} owner a module name, a game owner ('bullet-time'), 'settings', ...
   * @returns {string[]} e.g. ['time.world (mul 0.8, effect)', 'inventory (holds)']
   * @example engine.stacks.of('weather')
   */
  of(owner) {
    const out = [];
    for (const s of this._all.values()) for (const [id, m] of s._by) {
      const e = m.get(owner);
      if (e) out.push(`${id ? `${s.name}[${id}]` : s.name} (${e.op ? `${e.op} ${JSON.stringify(e.value)}, ${e.layer}` : 'holds'})`);
    }
    return out;
  }
  /** @internal entries with a `for`, as [point, entry] */
  _timed() {
    const out = [];
    for (const s of this._all.values()) for (const m of s._by.values()) for (const e of m.values()) if (e.until != null) out.push([s, e]);
    return out;
  }
  /**
   * @internal End every entry whose time is up (core/time/time.js calls it after advancing the clocks), earliest first; emits mod:end for each.
   * @returns {number} how many ended
   */
  _expire() {
    if (!this._timedDirty) return 0;
    const timed = this._timed();
    if (!timed.length) { this._timedDirty = false; return 0; }   // nothing timed: later steps return at once until the next timed mod
    const due = timed.map(([s, e]) => ({ s, e, over: this._nowOf(e.clock) - e.until })).filter(d => d.over >= -1e-9);
    due.sort((a, b) => b.over - a.over);   // the most overdue ended first in time
    for (const { s, e } of due) {
      if (!s._drop(e.owner, e.id, e)) continue;
      this.engine.events?.emit('mod:end', { target: s.name, owner: e.owner, id: e.id });
    }
    return due.length;
  }
  /** @internal smallest time left on any timed entry, converted to calendar seconds by toGame(clock, left) (engine.skip ends a segment there) */
  _untilNext(toGame) {
    let best = Infinity;
    for (const [, e] of this._timed()) best = Math.min(best, toGame(e.clock, Math.max(0, e.until - this._nowOf(e.clock))));
    return best;
  }
  /** @internal a channel's clock jumped by delta (a load set its now): entries timed on it keep their time left, whichever save part loaded first */
  _rebase(clock, delta) { for (const [, e] of this._timed()) if (e.clock === clock) e.until += delta; }
  /** @internal number and value points; entries below the settings layer */
  _save() {
    // entries of a point the game has not defined yet ride along (shape-checked on load), as Time keeps channels not defined yet: else the next save lost them
    const out = { ...this._pending };
    for (const s of this._all.values()) {
      if (s.save === false || (s.kind !== 'number' && s.kind !== 'value')) continue;
      const list = [];
      for (const m of s._by.values()) for (const e of m.values()) {
        if (!saved(e)) continue;
        list.push({ owner: e.owner, id: e.id, op: e.op, value: e.value, layer: e.layer, clock: e.clock, left: e.until == null ? null : e.until - this._nowOf(e.clock) });
      }
      if (list.length) out[s.name] = list;
    }
    return out;
  }
  /** @internal a load replaces every saved (engine..effect) entry; system / settings / debug entries stay (the menu that holds them is still up) */
  _load(d) {
    this._pending = {};
    for (const s of this._all.values()) if (s.save !== false && (s.kind === 'number' || s.kind === 'value')) this._loadOne(s, d != null && Object.hasOwn(d, s.name) ? d[s.name] : []);   // [] only when absent: an explicit null is damage, refused by the check
    for (const [k, v] of Object.entries(d ?? {})) if (!this._all.has(k)) {
      if (Array.isArray(v) && v.every(entryShape)) this._pending[k] = v;
      else warnOnce(coded('save-value', BAD_SAVED.replace('{name}', k).replace('{why}', 'not a list of { owner, op, value } entries')));   // a stack this code no longer defines (an old save): dropped with one warning, never a reason to refuse the save
    }
  }
  /**
   * @internal Replace s's saved entries with list. An owner that holds an entry now and also in the save keeps the SAME entry object, rewritten
   * with the saved values: handles taken before the load (engine.mod, ctx.mod) still remove() / change() it. A new object here made every such
   * handle stale in silence (a slow zone's time.world mul 0.5 stayed after leaving the zone).
   * The list is checked first, as engine.mod checks (Stack._fromSave): a list that fails changes nothing on s and is reported once; the rest of the save loads.
   */
  _loadOne(s, raw) {
    let list;
    try { list = s._fromSave(raw, layerOf); }
    catch (err) { refuseSave('stacks', s.name, 'is not a valid list: ' + err.message, raw); }
    const had = new Map();
    for (const m of [...s._by.values()]) for (const e of [...m.values()]) if (saved(e)) { had.set(`${e.id ?? ''}\0${e.owner}`, e); s._drop(e.owner, e.id, e); }
    for (const e of list) {
      const m = s._map(e.id, true), clock = e.clock, old = had.get(`${e.id ?? ''}\0${e.owner}`);
      const fields = { since: this._at(), op: e.op, value: e.value, layer: e.layer, clock, until: e.left == null ? null : this._nowOf(clock) + e.left };
      m.set(e.owner, old ? Object.assign(old, fields) : { owner: e.owner, id: e.id ?? null, where: null, ...fields });
      this._timedDirty = true;
      s._changed(e.id);
    }
  }
}
