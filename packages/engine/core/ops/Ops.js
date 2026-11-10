// One entry point for actions: engine.ops. An op is one discrete thing an actor (player, NPC, network peer) decides to do:
// buy, talk, attack, roll, fire, craft, build. Continuous input (stick, look) and simulation (hunger, growth, burning) are not ops;
// they stay in fixed / world.simulate.
//   engine.ops.define('shop.buy', { args: { shop: 'string', item: 'string' }, can(e, a, ctx) { return true or 'noMoney' }, run(e, a, ctx) { ... } });
//   engine.ops.run('shop.buy', { shop: 'bakery', item: 'bread' })   // -> { ok: true, value } or { ok: false, code, facts, nextActions }
// Why one entry: UI, keys, bridge, tests, replay and net peers all end in the same run(),
// checked by the same can(), logged in one history (tick, phase, source, actor): tests need no key timing,
// the AI can ask "what can I do now", and replay / netcode have a record of who did what on which step.
// run() is always synchronous: inside a fixed step it is phase 'fixed'; between steps (UI, bridge, tests) phase 'between',
// which lands "after step N" and replays the same. Args must be plain data and self-contained (aim direction goes in the args).
// The guard (ops.guard) backs "don't go around it": in dev, saved gameplay state written outside loading, fixed steps and ops
// is reported (see recipes/23-ops.md). Dev argument checks live in opsCheck.js.
import { DEV, fmt, missingText, warnOnce, syncOnly } from '../base/validate.js';
import { checkTypeRule, asModule } from '../engine/moduleTypes.js';
import { checkDef, checkArgs, devError, SOURCES } from './opsCheck.js';
import { coded, codedError } from '../base/errorHints.js';
import { guardWrite } from './opsGuard.js';
import { failure, isStructured, opsBlocked } from './opsFail.js';
import { runOp } from './opsRun.js';
import { newRing, logEntry, recentEntries } from './opsHistory.js';
import { defaultsOf, withDefaults } from '../base/params.js';
import { reportError } from '../base/errors.js';

const STRINGS = {
  dup: "ops.define('{name}'): already defined. To replace it call remove() on the handle define returned first",
  unknown: 'ops.run({name}): {text}',
  canResult: "{name}'s can must return true or a reason string, e.g. return 'noMoney' (or { code, facts, nextActions }); got {got}",
  badSource: "ops.run('{name}'): source '{source}' is not one of " + SOURCES.join(', '),
  routedTwice: 'engine.ops.route(fn): ops are already routed elsewhere (one router at a time). Fix: remove() the first one before routing again',
};

/**
 * engine.ops: one entry point for the discrete things players and NPCs decide to do. define registers, run executes (sync, logged), can only asks, list says what exists / what is possible now, recent reads the log.
 * Inside an op use ctx.actor (world record id, default engine.actor = 'player'), never engine.player: NPCs and network peers run the same op as themselves.
 */
export class Ops {
  /** @internal */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    /** @internal */ this.defs = new Map();
    /** @internal ring of history entries, allocated once */ this._ring = [];
    /** @internal */ this._head = 0;
    /** @internal */ this._len = 0;
    /** @internal names of the ops currently running (nesting) */ this._stack = [];
    /** @internal */ this._inCan = null;
    /** @internal > 0 while state may be written without an op (save load, applyState, net sync) */ this._allowDepth = 0;
    /** @internal request counter (net replies carry it) */ this._seq = 0;
    /** @internal ctx of the innermost running op (nested ops inherit source, actor and session) */ this._last = null;
    /** @internal set through route() (net clients): (def, args, opts) => result to return instead of running locally, or null to run here */ this._route = null;
    /** @internal true while route() is held: every write outside allow() is reported, even in fixed steps and ops (own movement, world.move, excepted) */ this._client = false;
    /** Counter that only goes up: each committed op, undo, load and rollback bumps it (a failed op that changed nothing does not); every run result carries it, so "did anything change since I looked" is one compare */
    this.revision = 0;
    /** @internal depth of atomic runs in progress, and after hooks waiting for the outermost one to commit */ this._txDepth = 0; this._txAfter = []; /** @internal op:rolledBack announcements waiting for the failed run to leave the stack (opsAtomic.js) */ this._rolled = [];
    this.historySize = 256;
  }
  /** @internal Stamp a failed result with the current revision */
  _res(f) { f.revision = this.revision; return f; }
  /** @internal Name of the innermost op running right now, or null (world records who spawned a runtime record with it, dev only) @type {string | null} */
  get running() { return this._stack.at(-1) ?? null; }
  /**
   * Who is acting right now: the actor of the innermost running op (a net peer, an NPC, the local user), else engine.actor.
   * Code that changes state outside an op's own ctx (an item event, a content effect) names its actor with this, so it is never assumed to be the local player.
   * @type {string}
   */
  get actor() { return this._stack.length && this._last ? this._last.actor : this.engine.actor; }

  /** History entries kept (ring, default 256); setting it clears the history */
  get historySize() { return this._ring.length; }
  set historySize(n) {
    this._ring = newRing(n);
    this._head = 0; this._len = 0;
  }

  /**
   * Register an op. Name it noun.verb. run changes state; can (optional) is read-only and returns true or a reason string; offers (optional) lists the arg sets possible now (for list / describe / the dev bridge `ops` command).
   * args shape types: string number int bool position id any, suffix ? for optional. net: 'peer' lets remote players request it (default: host only);
   * or { type, default, min, max, values, desc } (default is filled in, engine.catalog shows it).
   * atomic: true = world records, inventory containers and vars written by run are rolled back if run fails or throws (events and other state are not; see recipe 23); after(e, args, value, ctx): sound / animation, runs only once the op committed.
   * run (and can) may fail with { ok: false, code, facts, nextActions } (facts: object or list [{ id, field, actual, expected? }]); nextActions are the game's own suggestions.
   * owner (optional, checked by net() for peer requests): args => world record id whose `owner` field must equal the requesting actor.
   * @param {string} name
   * targets (optional): the thing ids, kinds or template names this op is for; engine.explain({ thing: id }).ops lists it ('*' = any thing).
   * @param {{ run: (e: any, args: any, ctx: OpContext) => any, can?: (e: any, args: any, ctx: OpContext) => true | string | { code: string, facts?: object, nextActions?: { op: string, args?: object }[] }, targets?: string | string[], args?: Record<string, string | { type: string, default?: any, min?: number, max?: number, values?: any[], desc?: string, optional?: boolean }>, offers?: (e: any, ctx: OpContext) => object[], reasons?: Record<string, string>, desc?: string, undo?: (e: any, args: any, value: any) => void, net?: 'peer' | 'local', owner?: (args: any) => string, atomic?: boolean, after?: (e: any, args: any, value: any, ctx: OpContext) => void }} def
   * @returns {{ remove(): void }}
   * @example
   * const PRICE = { bread: 5 };
   * engine.ops.define('shop.buy', {
   *   desc: 'Buy from a shop shelf',
   *   args: { shop: 'string', item: 'string', n: 'int?' },
   *   can(e, { shop, item, n = 1 }, ctx) {
   *     if (!e.inventory.container(shop).has(item, n)) return 'soldOut';
   *     if (e.inventory.container(ctx.actor).count('gold') < PRICE[item] * n) return 'noMoney';
   *     return true;
   *   },
   *   run(e, { shop, item, n = 1 }, ctx) {
   *     const got = e.inventory.transfer(shop, ctx.actor, item, n);
   *     e.inventory.container(ctx.actor).remove('gold', PRICE[item] * got);
   *     return got;
   *   },
   *   reasons: { soldOut: 'Shelf is empty', noMoney: 'Not enough gold' },
   * });
   */
  define(name, def) {
    checkTypeRule(this.engine, 'ops.define', `defined op ${name}`);
    if (this.defs.has(name)) throw devError(fmt(STRINGS.dup, { name }));
    const shape = checkDef(name, def);
    const d = { name, ...def, shape, defaults: defaultsOf(shape) };
    this.defs.set(name, d);
    return { remove: () => { if (this.defs.get(name) === d) this.defs.delete(name); } };
  }

  /**
   * Run an op now (synchronously): checks args (dev), calls can, then run, and logs it. Returns { ok: true, value, revision } or { ok: false, code, facts, nextActions, revision } (revision = ops.revision, counts committed ops); can may also return { code, facts?, nextActions? }.
   * Pass a fresh args object each call (it is kept in the history; in dev it is frozen). opts.source: 'player' | 'game' | 'bridge' | 'test' | 'replay' | 'net' | 'editor'
   * (default: 'game' inside a fixed step, 'player' between steps); opts.actor: who does it (world record id, default engine.actor, which is 'player' unless the game hands control elsewhere).
   * @param {string} name
   * @param {object} [args]
   * @param {{ source?: string, actor?: string }} [opts]
   * @returns {{ ok: boolean, value?: any, revision: number, code?: string, facts?: object, nextActions?: { op: string, args?: object }[] }}
   * @example
   * const r = engine.ops.run('shop.buy', { shop: 'bakery', item: 'bread' });
   * if (!r.ok) showHint(engine.t('op.shop.buy.' + r.code));
   * // from a fixed step, for an input-driven action: e.ops.run('combat.roll', { dir }, { source: 'player' })
   */
  run(name, args = {}, opts) {
    // the op's code is the defining module's, not the caller's: a ui module running shop.buy is fine even though shop.buy writes records
    return asModule(this.engine, null, () => runOp(this, name, args, opts));
  }

  /**
   * Reverse a finished op with the undo(e, args, value) its definition declared: pass the same args and the value run returned.
   * canUndo(e, args, value) in the definition answers like can (true, a reason, a structured failure) when the world may have moved on so far that it cannot be reversed.
   * Returns { ok: true }, or { ok: false, code: 'noUndo', facts: { op }, nextActions } when the op did not declare undo. The undo runs as an op write (the dev guard stays quiet).
   * @example const r = engine.ops.run('inventory.trade', { take: 'rusty_key', give: 'gold_key' }); engine.ops.undo('inventory.trade', { take: 'rusty_key', give: 'gold_key' }, r.value);
   * @param {string} name
   * @param {object} args
   * @param {any} value
   * @param {{ actor?: string }} [opts]
   * @returns {{ ok: boolean, code?: string, facts?: object, nextActions?: { op: string, args?: object }[] }}
   */
  undo(name, args, value, opts) {
    const d = this._def(name);
    if (!d) return this._res(failure({ code: 'unknownOp', facts: { op: name } }));
    if (typeof d.undo !== 'function') return this._res(failure({ code: 'noUndo', facts: { op: name }, nextActions: [] }));
    const blocked = opsBlocked(this.engine);   // as run: a load in progress or a gameplay error
    if (blocked) return this._res(failure(blocked));
    // as run: a broken op is reported and answered, a thrown error is not the caller's to catch
    const broke = err => { if (err?.opsDevError) throw err; reportError(this.engine, err, `ops.undo('${name}')`); return this._res(failure('error')); };
    let no;
    try { no = d.canUndo?.(this.engine, args, value) ?? true; } catch (err) { return broke(err); }
    if (no !== true) return this._res(failure(no));   // as can: answered, and nothing changed, so the revision stays
    const ctx = this._ctx(name, args, opts, this._stack.length ? this._last : null);
    this._allowDepth++;
    try {
      // the op's code is the defining module's, not the caller's (run)
      asModule(this.engine, null, () => this._as(name, ctx, () => d.undo(this.engine, args, value, ctx)));
    } catch (err) {
      return broke(err);
    } finally {
      this._allowDepth--;
      this.revision++;   // the state changed, a half-done undo too: "did anything change since I looked" must see it
    }
    return { ok: true };
  }
  /** @internal Run fn as part of op `name` with its ctx, when the op is not on the stack (undo, an after hook held for the commit, a use after a walk): nested ops, ops.actor and content words read it */
  _as(name, ctx, fn) {
    const prev = this._last;
    this._stack.push(name); this._last = ctx;
    try { return fn(); } finally { this._stack.pop(); this._last = prev; this._drainRolled(); }
  }
  /** @internal Tell the queued op:rolledBack announcements (opsAtomic.js) once the ops stack is empty again: called where it empties (runOp, _as). One drain at a time; ones queued while it runs go out in the same loop (guarded like the other loops) */
  _drainRolled() {
    if (this._draining || this._stack.length) return;
    this._draining = true;
    try { for (let n = 0; this._rolled.length && n < 16; n++) for (const say of this._rolled.splice(0)) say(); }
    finally { this._draining = false; this._rolled.length = 0; }   // past the guard the rest is dropped, not left for an unrelated op
  }

  /**
   * Ask without doing: runs only can (no state change, no history). For greying out buttons and input buffers.
   * @param {string} name
   * @param {object} [args]
   * @param {{ actor?: string, source?: string }} [opts]
   * @returns {{ ok: boolean, code?: string, facts?: object, nextActions?: { op: string, args?: object }[] }}
   * @example const { ok, code } = engine.ops.can('shop.buy', { shop: 'bakery', item: 'bread' });
   * button.disabled = !ok;
   */
  can(name, args = {}, opts) {
    const d = this._def(name);
    if (!d) return this._res(failure('unknownOp'));
    args = withDefaults(d.defaults, args);
    const ctx = this._ctx(name, args, opts, this._stack.length ? this._last : null);
    const blocked = opsBlocked(this.engine);
    if (blocked) return this._res(failure(blocked));
    let res;
    try { res = this._can(d, args, ctx); } catch (err) {
      if (err?.opsDevError) throw err;
      // soft: buttons and describe() ask every frame, and asking must not freeze a game; the run path stops it. The reason stays in the answer
      reportError(this.engine, err, `ops.can('${name}')`, { soft: true });
      res = { code: 'error', facts: { message: String(err?.message ?? err) } };
    }
    return this._res(res === true ? { ok: true } : failure(res));
  }

  /**
   * What exists, or with { available: true } what is possible now: every arg set from each op's offers checked with can
   * (an op with neither offers nor args is checked once with {}; one with args but no offers is skipped, since its args are free-form).
   * An offers that throws gives one entry with code 'offersFailed'; an offered arg set that fails the op's args check gives code 'badOffer' (facts.error says why).
   * @param {{ available?: boolean, actor?: string }} [opts]
   * @returns {{ name: string, desc?: string, args?: any, atomic: boolean, ok?: boolean, code?: string }[]}
   * @example engine.ops.list({ available: true });   // [{ name: 'shop.buy', args: { shop: 'bakery', item: 'bread' }, ok: false, code: 'noMoney' }, ...]
   */
  list({ available = false, actor } = {}) {
    if (!available) return [...this.defs.values()].map(d => ({ name: d.name, desc: d.desc, args: d.args, atomic: d.atomic === true }));
    const out = [];
    for (const d of this.defs.values()) {
      const ctx = this._ctx(d.name, null, { actor }, null);
      let sets;
      // A broken offers / an offered arg set that fails its own args check is the game's bug, but describe() reads this list every call: one bad
      // op must not make describe throw (that hid every other fact). It shows up as an entry with the error instead, so the AI still sees it.
      try { sets = d.offers ? d.offers(this.engine, ctx) : d.shape ? [] : [{}]; }
      catch (err) { out.push({ name: d.name, args: null, ...failure({ code: 'offersFailed', facts: { op: d.name, error: String(err?.message || err) } }) }); continue; }
      for (const args of sets || []) {
        let r;
        try { r = this.can(d.name, args, { actor }); }
        catch (err) { r = failure({ code: 'badOffer', facts: { op: d.name, error: String(err?.message || err) } }); }
        out.push({ name: d.name, args, ...r });
      }
    }
    return out;
  }

  /**
   * Recent history (old -> new), optionally of one op: { seq, tick, phase: 'fixed' | 'between', name, args, source, actor, ok, code, depth, count }.
   * Consecutive identical failures (same actor, op and code) merge into one entry with count.
   * @param {string} [name]
   * @returns {{ seq: number, tick: number, phase: string, name: string, args: any, source: string, actor: string, ok: boolean, code: string | null, depth: number, count: number }[]}
   * @example engine.ops.recent('shop.buy').at(-1);   // { tick: 812, phase: 'between', ok: false, code: 'noMoney', ... }
   */
  recent(name) {
    return recentEntries(this, name);
  }

  /**
   * Dev guard for a module that owns saved gameplay state: call it at the top of every method that writes that state. In development it warns once per call site
   * when the write happens outside a fixed step, an op or an allow() window (before ready everything is allowed); in a production build it is a no-op, so just call `engine.ops.guard(...)` (no DEV check needed).
   * @experimental
   * @example set(k, v) { this.engine.ops.guard('myStore.set'); this.data[k] = v; }
   * @param {string} where label shown in the warning, e.g. 'vars.setFlag'
   * @returns {void}
   */
  guard(where) {
    if (!DEV) return;   // release builds do not check; games cannot read DEV, so the no-op lives here
    guardWrite(this, where);
  }
  /**
   * Send every op to someone else instead of running it here (a multiplayer client: the host decides). fn(def, args, opts) returns the result to
   * hand back, or null to run the op locally after all. While routed, a write outside an op or allow() is reported even in fixed steps (only the
   * host changes game state). One router at a time; remove() runs ops locally again. Public so a transport module needs no ops internals.
   * @param {(def: any, args: any, opts: any) => any} fn
   * @returns {{ remove(): void }}
   * @example const r = engine.ops.route((d, args) => d.name.startsWith('chat.') ? null : sendToHost(d.name, args));   // r.remove() on disconnect
   */
  route(fn) {
    if (this._route) throw codedError('engine-misuse', STRINGS.routedTwice);
    this._route = fn; this._client = true;
    return { remove: () => { if (this._route !== fn) return; this._route = null; this._client = false; } };
  }
  /**
   * Put a refused request into the op history (describe().ops, ops.history) without running it: a host refusing a peer's op keeps the refusal visible
   * next to the ops that ran. The op must be defined.
   * @param {string} name
   * @param {any} args
   * @param {{ reason: string, actor?: string, source?: string }} why  source defaults to 'net'
   * @returns {void}
   * @experimental
   */
  refused(name, args, { reason, actor = '', source = 'net' }) { this._log(name, args, { source, actor, tick: this.engine.time.tick }, false, reason, 0); }
  /** @internal A separator in the history (save load): later entries belong to a different world state */
  _mark(label) { this._log(label, null, { tick: this.engine.time.tick, source: 'game', actor: '' }, true, null, 0); }
  /**
   * Run fn with guarded writes allowed (loading a save, applying a scenario, net sync); works for an async fn too (allowed until its Promise settles). Returns what fn returns.
   * @experimental
   * @example engine.ops.allow(() => store.load(data));
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  allow(fn) {
    this._allowDepth++;
    let r;
    try { r = fn(); } catch (err) { this._allowDepth--; throw err; }
    if (r && typeof r.then === 'function') return /** @type {any} */ (r.finally(() => { this._allowDepth--; }));
    this._allowDepth--;
    return r;
  }

  /** @internal */
  _def(name) {
    const d = this.defs.get(name);
    if (d) return d;
    const msg = fmt(STRINGS.unknown, { name: JSON.stringify(name), text: missingText('op', name, [...this.defs.keys()]) });
    if (!DEV) { warnOnce(coded('op-misuse', msg)); return d; }   // release: the op is a no-op (reason unknownOp), said once
    throw devError(msg);
  }
  /** @internal */
  _ctx(name, args, opts, parent) {
    const e = this.engine;
    let source = opts?.source ?? parent?.source ?? (e._inFixed ? 'game' : 'player');
    if (DEV) {
      if (!SOURCES.includes(source)) throw devError(fmt(STRINGS.badSource, { name, source }));
      if (args) checkArgs(e, this.defs.get(name), args);
    }
    return { source, actor: opts?.actor ?? parent?.actor ?? e.actor, tick: e.time.tick, frozen: e.frozen, session: parent?.session ?? e.session.id };
  }
  /** @internal returns true or a reason string */
  _can(d, args, ctx) {
    if (!d.can) return true;
    const prev = this._inCan; this._inCan = d.name;
    let r;
    try { r = d.can(this.engine, args, ctx); syncOnly(r, `can() of op '${d.name}'`, true); } finally { this._inCan = prev; }
    if (r === true || (typeof r === 'string' && r) || isStructured(r)) return r;
    const msg = fmt(STRINGS.canResult, { name: d.name, got: JSON.stringify(r) ?? 'undefined' });
    if (DEV) throw devError(msg);
    warnOnce(coded('op-misuse', msg));   // release: denied, said once
    return 'denied';
  }
  /** @internal write a history entry in place (no allocation); consecutive identical failures merge */
  _log(name, args, ctx, ok, reason, depth) {
    return logEntry(this, name, args, ctx, ok, reason, depth);
  }
}

/** @typedef {{ source: string, actor: string, tick: number, frozen: boolean }} OpContext */
