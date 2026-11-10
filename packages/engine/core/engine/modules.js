// Module installation (part of Engine, mixed into Engine.prototype): engine.use(...) / engine.has(name) / engine.moduleOrder.
// See CLAUDE.md "writing a module" for the module shape; dispose is called by lifecycle.js in reverse install order.
//
// Run order (fixed / frame / afterRender / skip hooks): by stage first, then before / after within a stage, then install order.
//   stage only orders hooks; what a module may own and what happens when it throws come from its type (moduleTypes.js, errors.js).
//   Stages (first to last): control timeline, camera -> ground terrain, level -> environment weather, sky, water
//     -> gameplay interactions, dialogue, trigger zones -> effects particles, settings, objective markers
//     -> late (the default) characters, physics, navigation... -> audio music
//   before / after: lists of module or capability names (not-installed names are ignored; a capability means whichever module provides it now, so the order follows a replaces);
//     they order modules only inside one stage. One that contradicts the stage order (a 'control' module with after: ['sky']) makes use() throw naming both modules and stages;
//     a cycle makes use() throw on the spot, naming the modules on it. A contradiction reached through provides throws the same way: an order must not turn into a hint after a replaces.
// One change plan: use, unuse, replaces and plugin on / off all go through _planChange (moduleSlots.js), which works out the module graph after the change and checks every
//   consumer, new or kept, before anything is touched. Then install is all-or-nothing per engine.use(...) call: if a module's install() throws, the modules this call already
//   installed are removed again (engine.name, module table, hooks; their dispose() runs) and the error is rethrown.
// Module state (engine.explain({ module })): registered -> initializing -> running | failed; disposed after engine.dispose(). Modules without init() are
// running at once. fixed / frame / afterRender / skip hooks run only for running modules, so no module gets a hook before its init() finished
//   (during start() or when installed later).
// requires is a promise that the provider works, not only that it is installed: a module whose required provider is not running (still initializing, failed, or blocked itself)
//   is 'blocked': its init waits, its hooks do not run, and engine.catalog(name).blockedBy says on what. It starts by itself when a provider comes up (a replaces of a failed one).
//   A critical module blocked by a failure stops start(), or is reported when it happens later. Modules that do not depend on the failed one go on.
// Installed is not usable: engine.has(name) says a module of that name or a provider of that capability is in the module table; engine.usable(name), internal, says it can be called now
//   (running, not blocked, not disabled). A game waits with loading.settled and asks engine.explain({ module }).
//   A capability binds where provides meets requires: dev checks the provider's API against the capability's contract then, on a module change and never per frame (moduleSlots.js).
// Ownership: install(e, ctx) and init(e, ctx) get ctx = { name, track(handle), mod(point, o), borrow(obj, values), control.take(character, o) }. A handle passed to ctx.track (events.on, onFixed, onFrame,
//   clock timers, audio.measure... anything with remove()) belongs to the module and is removed with it: when the use() batch rolls back,
//   when its init fails, and on engine.dispose() (before the module's own dispose). Listeners a module adds go through it, so an install
//   that fails halfway leaves no ghost listener behind (review 0.4 A; the rollback spec checks every built-in module).
//   ctx.mod(point, o) = ctx.track(engine.mod(point, { ...o, owner: ctx.name })): a module's changes to shared values go with it too.
//   ctx.rule(name, default, names?) = a replaceable rule on a plain shared point: .decide(id, facts) gives a built-in name, false for manual, or what the game's function answered.
//   ctx.input.define(name, { context }) / ctx.input.bind(name, keys): the module's input declarations and bindings, gone with it too.
//   ctx.ops.define, ctx.saves.define, ctx.ui.define, ctx.stream.addReadyCheck, ctx.budget.metric, ctx.things.addSource / explainWith, ctx.ground.provide / addColliders:
//   the same registrars, recorded in the one scope with kind, id, owner and instance (engine.catalog(name).resources reads it). Built-in modules register only through
//   these (tools/tests/module-boundaries). A save part leaving keeps its data as unattached data of the save (Saves.define), so a module unloaded for a while loses nothing.
//   Every install is its own instance (engine._modInst: name -> token): a ctx belongs to one install, not to a name. An async init that resumes after
//   its module was unloaded (replaces, a plugin removed) and a same-named one installed must not act on the newcomer: a stale ctx verb does nothing and gives a spent handle, because
//   the owner name is shared and doing it first would replace the newcomer's entry (dev warning naming the module); what it tracks is removed at once; its completion or failure
//   changes no state and drops no handle of the newcomer.
// Exclusive slots: provides: ['inventory'] takes each named slot (a kind 'one' shared point, core/ops/sharedPoint.js) for the module before its install;
//   a second provider is shared-taken. requires may name a slot instead of a module. engine.use(mine(), { replaces: 'inventory' }) unloads the
//   holder first (its handles, slot, drawing parts, dispose), and puts it back if the new install fails, with its save data and content sections (_putBack). Either way the holder now is a fresh install that has none of what
//   others put into the old one, so 'module:restored' tells whoever fed it, once its init is done: they feed it again. The word means "this module is back and holds nothing yet", not that its old state came back; its save data did, its definitions did not.
// critical: true on a module makes a failed init() stop engine.start() with the reason; without it a failed init is reported (picture / ui: disabled;
// other types: error tiers in errors.js) and start() goes on.
// Dependencies: requires must be installed first (throws if missing). optional is a soft dependency: an array is only recorded (for GAMEMAP and rule R16);
//   written as { module: 'what is lost without it' }, start() warns once in dev when it is missing: use this form for optional dependencies
//   that change gameplay results, which must not be skipped silently.
import { warnOnce, DEV, fmt, closest, syncOnly } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';
import { reportError, removeEach } from '../base/errors.js';
import { catalog, catalogSnap, catalogClaim } from '../inspect/catalog.js';
import { readParams } from '../base/params.js';
import { slotMethods, isUseOpts, checkProvides, slotTaken, giversOf, CORE_SLOTS } from './moduleSlots.js';
import { checkType, asModule } from './moduleTypes.js';

/** Stage -> sort position */
const STAGES = { control: 100, ground: 200, environment: 300, gameplay: 400, effects: 450, late: 500, audio: 510 };
const HOOKS = ['fixed', 'frame', 'afterRender', 'skip'];
const STRINGS = {
  cycle: 'module order forms a cycle: {path} (check before / after on these modules)',
  stage: 'module {name} has stage "{stage}", which is not a stage; available stages: {list}',
  order: 'module {name} sets order, which is not supported; modules do not sort by number. Set stage ({list}) and use before / after within a stage',
  optional: 'optional dependency {dep} of module {name} is not installed: {what} (ignore if not needed; otherwise call engine.use({dep}()))',
  called: 'engine.use received the module function {name} itself; call it: {name}()',
  twice: 'module {name} is already installed; the second engine.use({name}()) is ignored',
  readyHook: 'module {name}: the load-complete hook is named isReady(e) (ready is always a boolean property in the engine); ready(e) will not be called',
  // both ways out: the engine's part of that name, or the game's own provider (requires names a capability, never a particular module)
  needs: "module {name} requires '{dep}', which no installed module provides. Fix: install the engine's part first, engine.use({dep}(), {name}(...)), "
    + "or your own module with provides: ['{dep}'] (then engine.{dep} is your module's API){typo}",
  typo: " (did you mean '{hint}'? installed: {list})",
  clash: 'module name {name} clashes with an existing engine property; pick another name',
  twoGivers: "module {named} is named '{cap}' and module {giver} provides '{cap}', so requires, engine.has and engine.{cap} could each reach a different one. "
    + 'Rule: one name answers to one module. Fix: give one of them another name, or unload {named} first when {giver} takes its place',
  slotClash: "module {name} provides '{slot}', but engine.{slot} is already an engine property, so dependents could not reach it there. Fix: pick another slot name",
  lateInit: 'init of module {name} (installed after start)',
  groundClaim: "module {name} called ctx.ground.provide, but ground is an exclusive capability it did not claim. Fix: add 'ground' to its provides",
  blocked: "module {name} cannot run: it requires '{dep}', and {by} is {state}. It stays off until {by} runs again (engine.explain({ module: '{name}' }) says more)",
  critical: "critical module {name} cannot run: it requires '{dep}', and {by} is {state}. Fix what stopped {by}, or drop critical from {name}",
  conflict: 'module {a} (stage "{sa}") sets {kind}: ["{said}"], but module {b} is in stage "{sb}", which always runs {kind} stage "{sa}" (stage order: {list}); '
    + 'before / after only order modules inside one stage. Fix: give both modules the same stage, or remove {kind}: ["{said}"] from {a}',
  capStage: 'module {a} (stage "{sa}") sets {kind}: ["{said}"], but the provider of \'{said}\' is module {b} in stage "{sb}", so this order cannot hold. Fix: give {b} stage: \'{sa}\', or drop the order from {a}',
};
const LOST = "engine.use(..., { replaces }): this unloads {gone}, and module {name} requires '{dep}', which nothing would provide afterwards. Fix: add provides: ['{dep}'] to the module that takes over, or unload {name} first";
const CTX_OWNER = "ctx.mod('{point}', { owner }) in module {name}: ctx.mod names the module as the owner itself; drop owner (use engine.mod for another owner name)";
const BORROW_HELD = "ctx.borrow in module {name}: '{key}' is already borrowed by module {holder}. A borrow is one holder's temporary use: end that one first, or, when several parties want this value, put it on a shared point (engine.mod)";
const BAD_BORROW = 'ctx.borrow(obj, values) in module {name}: obj is the object to write on and values the properties to write, like ctx.borrow(e.renderer, { toneMapping: THREE.AgXToneMapping }); got {got}';
const BAD_HANDLE = 'ctx.track(handle) in module {name}: handle must have remove(), like the result of engine.events.on / onFixed / clock.after; got {got}';
const STALE = 'module {name} registered something after it was unloaded (its async init or a callback resumed after replaces / unload); nothing of it stays. '
  + 'The module installed under that name now is not affected';
const STALE_INIT = 'init of module {name}, which was unloaded before it finished';
const hookCache = new WeakMap();   // module definition -> { fixed, frame, afterRender, skip } hook entries (reused when re-sorting)

/** Every before / after declaration as an ordered pair: first runs before then. said is the name as written, by the module that wrote it. Its own capability orders nothing */
function orderPairs(list) {
  const out = [];
  for (const m of list) for (const kind of ['before', 'after']) for (const said of m[kind] ?? []) for (const o of giversOf(list, said)) {
    if (o !== m || said === m.name) out.push({ m, o, kind, said, first: kind === 'before' ? m : o, then: kind === 'before' ? o : m });
  }
  return out;
}
const rankOf = m => STAGES[m.stage] ?? STAGES.late;

/** Sort modules by stage, before / after and install order (Kahn topological sort; among the ready ones take the earliest stage,
 *  then earliest installed); throws on a cycle. */
function sortModules(list) {
  const idx = new Map(list.map((m, i) => [m.name, i])), byName = new Map(list.map(m => [m.name, m]));
  const succ = new Map(list.map(m => [m.name, new Set()])), indeg = new Map(list.map(m => [m.name, 0]));
  const edge = (a, b) => { if (!idx.has(a) || !idx.has(b) || succ.get(a).has(b)) return; succ.get(a).add(b); indeg.set(b, indeg.get(b) + 1); };
  for (const { first, then } of orderPairs(list)) edge(first.name, then.name);
  const cmp = (a, b) => rankOf(a) - rankOf(b) || idx.get(a.name) - idx.get(b.name);
  const ready = list.filter(m => !indeg.get(m.name)), out = [];
  while (ready.length) {
    ready.sort(cmp);
    const m = ready.shift(); out.push(m);
    for (const n of succ.get(m.name)) { indeg.set(n, indeg.get(n) - 1); if (!indeg.get(n)) ready.push(byName.get(n)); }
  }
  if (out.length === list.length) return out;
  // What is left is on a cycle or behind one: walk edges from any node; revisiting a node closes the cycle
  // First drop, repeatedly, the nodes with no successor still left: those are only blocked behind a cycle (a walk starting there would dead-end
  // on a node without a next step); every node that remains has a successor in the set, so the walk always ends in a real cycle
  const left = new Set(list.filter(m => !out.includes(m)).map(m => m.name)), path = [];
  for (let drop = true; drop;) { drop = false; for (const n of left) if (![...succ.get(n)].some(x => left.has(x))) { left.delete(n); drop = true; } }
  for (let n = left.values().next().value; !path.includes(n); n = [...succ.get(n)].find(x => left.has(x))) path.push(n);
  const cyc = path.slice(path.indexOf([...succ.get(path.at(-1))].find(x => path.includes(x))));
  throw codedError('module-cycle', fmt(STRINGS.cycle, { path: [...cyc, cyc[0]].join(' -> ') }));
}

/** before / after across stages must agree with the stage order (the stage always wins), else the declaration would be silently ignored: throw naming both modules */
function checkStages(list) {
  const stage = m => m.stage ?? 'late', order = Object.keys(STAGES).join(' -> ');
  for (const { m, o, kind, said, first, then } of orderPairs(list)) {
    if (rankOf(first) <= rankOf(then)) continue;
    const v = { a: m.name, sa: stage(m), kind, said, b: o.name, sb: stage(o), list: order };
    throw codedError('module-order', fmt(o.name === said ? STRINGS.conflict : STRINGS.capStage, v));
  }
}

export const moduleMethods = {
  ...slotMethods,   // provides / replaces (moduleSlots.js)
  /**
   * Install one or more modules in order; dependencies must be installed first; hook order is described at the top of this file.
   * All-or-nothing: the batch is validated first, and if an install() throws, the modules this call installed are removed again.
   * A module installed after start() has its init(e) run at once (a task in engine.loading; an error goes through the error tiers) and gets no hooks
   * until it succeeded:
   * `await engine.loading.settled()` waits for it; engine.explain({ module }) shows where each module is.
   */
  use(...mods) {
    const opts = isUseOpts(mods.at(-1)) ? mods.pop() : null;
    const list = mods.flat(Infinity), gone = this._replaced(list, opts?.replaces);
    this._applyChange(this._planChange(list, gone, { code: 'module-replaces', text: LOST }), gone);
    return this;
  },
  /** @internal A change is finished when queries can trust it: everyone feeding a name these modules answer to (ctx.feeds) has fed the newcomer, so the line after use() reads it whole */
  _feed(plan) {
    const names = new Set(plan.flatMap(m => [m.name, ...(m.provides ?? [])]));
    for (const f of [...(this._feeders ?? [])]) if (names.has(f.name)) f.fn();
  },
  /** @internal carry out a change _planChange accepted: the modules in gone leave, then the plan installs (all or nothing) */
  _applyChange(plan, gone, swapping = plan.length > 0) {
    const done = [], order = [...this.modules.keys()], base = this.session._base;
    // replaces: the holder goes first (its tracked handles, its slot, its drawing parts, its dispose), so the newcomer's install sees a free slot. It cannot wait for the
    // newcomer to prove itself: both would claim the slot, the save key, the ops and engine.<name>, so a failure is undone instead (_putBack).
    // Newest first like dispose; removed ends in install order, so each module comes back after what it requires
    const removed = order.filter(n => gone.has(n)).reverse().map(n => this._unuse(n, swapping)).reverse();
    try {
      for (const m of plan) {
        const had = Object.hasOwn(this, m.name), prev = this[m.name], snap = catalogSnap(this);
        done.push({ m, had, prev });   // before install(): what it tracked before throwing is removed too
        this._modInst.set(m.name, { ac: new AbortController() });   // this install's identity: install and init ctx check it, so a stale async init cannot act on a later install
        const ctx = this._modCtx(m);
        this._picture?.installing(m);
        for (const slot of m.provides ?? []) ctx.track(this._slot(slot, m.name).take({ owner: m.name }));   // shared-taken when another module holds it
        const api = asModule(this, m, () => { const r = m.install?.(this, ctx); syncOnly(r, `install() of module ${m.name}`, true); return r; }) ?? m;   // asModule: the type checks know who is installing (moduleTypes.js)
        catalogClaim(this, m.name, snap);   // ops / save parts / describe names it registered show under it in engine.catalog()
        this.modules.set(m.name, m);
        if (m.name) this[m.name] = api;
        // engine.<slot> is the provider's API too, so a module that requires 'inventory' reaches the game's own bag at engine.inventory after
        // a replaces: dependents name the capability, never the module that gives it
        for (const slot of m.provides ?? []) if (slot !== m.name && !CORE_SLOTS.has(slot)) { this[slot] = api; ctx.track(this._aliasSlot(slot, api)); }
        this._modState.set(m.name, m.init ? 'registered' : 'running');
      }
      this._feed(plan);   // inside the try: a provider that cannot take what feeds it fails its install
    } catch (err) {
      for (const { m, had, prev } of done.reverse()) {   // undo in reverse install order, like dispose
        const installed = this.modules.get(m.name) === m;
        this._modInst.get(m.name)?.ac.abort();   // before the token goes: ctx.signal of a rolled-back install
        this.modules.delete(m.name); this._modState.delete(m.name); this._modInst.delete(m.name);
        if (had) this[m.name] = prev; else delete this[m.name];   // put back what was there (an undefined slot stays undefined), never blank it
        this._dropTracked(m.name);
        if (installed) try { syncOnly(m.dispose?.(this), `dispose() of module ${m.name}`, true); } catch (e2) { reportError(this, e2, `dispose() of module ${m.name} after its install failed`, { soft: true }); }   // reported, but the install error below stays the primary one
      }
      this._sortHooks();
      if (removed.length) this._putBack(removed, order, base);
      throw err;
    }
    this._sortHooks();
    if (removed.length && plan.length) this._tellRestored(plan);
  },
  /**
   * @internal 'module:restored' for these fresh modules, after their init: what is fed then lands as it does on a running game, where content.load comes after init
   * (a level's own url would otherwise overtake the pack's level). Nothing in flight tells at once. One replaced again meanwhile is not told about
   */
  _tellRestored(modules) {
    const tell = () => {
      const live = modules.filter(m => this.modules.get(m.name) === m);
      if (live.length && !this.disposed) this.events.emit('module:restored', { modules: live });
    };
    if (this.loading._inits.size) this.loading.settled().then(tell); else tell();
  },
  /**
   * @internal a failed swap leaves the game as it was: the replaced modules install fresh (their old handles already went), their save parts take back their data as a part registered
   * late does (Saves.define), and 'module:restored' tells whoever fed them, because a fresh install has no definitions, as after a swap that worked: content sections load again (modules/content).
   * What game code defined by hand it defines again on that event. Colliders of the level and of props need no event: they check the holder themselves.
   * @param {any[]} removed  in install order @param {string[]} order  the module names to go back to @param {string | null} base  the new-game state to go back to
   */
  _putBack(removed, order, base) {
    this.session._base = base;   // a newcomer's save part may have written over a part of the same key (session._late)
    try { this.use(...removed); } catch (e2) { return reportError(this, e2, 'putting back the module a failed replaces removed', { soft: true }); }
    for (const n of order) { const m = this.modules.get(n); this.modules.delete(n); this.modules.set(n, m); }   // hooks of one stage run in install order: same places
    this._sortHooks();
    this._tellRestored(removed);
  },
  /** @internal validate a batch without touching the engine (so a failure leaves nothing half-installed);
   *  returns the modules to install */
  _planUse(list, gone = new Set()) {
    const names = new Set([...this.modules.keys()].filter(n => !gone.has(n))), plan = [];
    // who holds each exclusive slot after this change: read from the graph, so a clash is refused here, before a replaced module is disposed
    const holders = new Map();
    for (const n of names) for (const s of this.modules.get(n).provides ?? []) holders.set(s, n);
    // requires names a module or a capability: another module's provides (depend on 'inventory', not on whichever module gives it)
    const caps = new Set(names);
    for (const n of names) for (const s of this.modules.get(n).provides ?? []) caps.add(s);
    for (const m of list) {
      if (!m) continue;
      if (typeof m === 'function') throw codedError('module-called', fmt(STRINGS.called, { name: m.name }));
      if (names.has(m.name)) { warnOnce(coded('module-name', fmt(STRINGS.twice, { name: m.name }))); continue; }
      // one name, one module: requires, has and engine.<name> read a module name and a provides alike (giversOf), so two modules answering to one name
      // would bind each of them to a different one (and unloading the provider would clear engine.<name> under the other). Both orders, also inside one call
      if (holders.has(m.name)) throw codedError('module-name', fmt(STRINGS.twoGivers, { named: m.name, giver: holders.get(m.name), cap: m.name }));
      if (typeof m.ready === 'function') warnOnce(coded('engine-misuse', fmt(STRINGS.readyHook, { name: m.name })));
      if (m.order != null) throw codedError('module-stage', fmt(STRINGS.order, { name: m.name, list: Object.keys(STAGES).join(', ') }));
      if (m.stage != null && !(m.stage in STAGES))
        throw codedError('module-stage', fmt(STRINGS.stage, { name: m.name, stage: m.stage, list: Object.keys(STAGES).join(', ') }));
      checkType(m);
      for (const dep of m.requires || []) if (!caps.has(dep)) {
        const hint = closest(dep, [...caps]);
        throw codedError('module-requires', fmt(STRINGS.needs, { name: m.name, dep, typo: hint ? fmt(STRINGS.typo, { hint, list: [...caps].join(', ') }) : '' }));
      }
      checkProvides(m);
      for (const slot of m.provides ?? []) {
        if (holders.has(slot)) throw slotTaken(slot, holders.get(slot), m.name);
        holders.set(slot, m.name);
        if (slot !== m.name && names.has(slot)) throw codedError('module-name', fmt(STRINGS.twoGivers, { named: slot, giver: m.name, cap: slot }));
        if (slot !== m.name && !gone.has(slot) && !CORE_SLOTS.has(slot) && slot in this && this[slot] !== undefined && !this._slotAlias?.has(slot))
          throw codedError('module-provides', fmt(STRINGS.slotClash, { name: m.name, slot }));
      }
      if (DEV && m.params && m.options) readParams(m.name, m.params, m.options);   // a definition built by hand still gets its options checked
      if (!gone.has(m.name) && m.name in this && this[m.name] !== undefined) throw codedError('module-name', fmt(STRINGS.clash, { name: m.name }));
      names.add(m.name); caps.add(m.name); for (const s of m.provides ?? []) caps.add(s);
      plan.push(m);
    }
    if (plan.length) { const all = [...[...this.modules.values()].filter(m => !gone.has(m.name)), ...plan]; checkStages(all); sortModules(all); }
    return plan;
  },
  /** @internal after start(): every module whose init has not run and whose providers are up gets it now, in install order */
  _initWaiting() {
    if (!this._initsDone) return;
    const start = [...this.modules.values()].filter(m => m.init && this._modState.get(m.name) === 'registered' && !this._modBlocked.has(m.name));
    for (const m of start) this._lateInit(m);
    if (start.length) this._refreshBlocks();   // what waits on them now reads 'initializing', not 'registered'
  },
  /** @internal init of a module installed after start(): run now, tracked in engine.loading, errors through the error tiers;
   *  its hooks join only after it succeeded */
  _lateInit(m) {
    this._modState.set(m.name, 'initializing');
    const L = this.loading, task = L._begin(m.name, 'module');
    task.phase('build');
    const snap = catalogSnap(this);
    // the instance and its ctx are taken now, not when the microtask runs: by then a same-named module may be installed in its place
    const inst = this._modInst.get(m.name), ctx = this._modCtx(m, inst), live = () => this._isLive(m.name, inst);
    // live() again when the microtask runs: an unuse in the same turn already disposed it, and an init after dispose would leak what it makes
    L._track(Promise.resolve().then(() => (live() ? asModule(this, m, () => m.init(this, ctx)) : undefined)).then(
      () => { L._done(task); if (live()) { catalogClaim(this, m.name, snap); this._setModState(m, 'running'); this.session._lateInit([...(this._modTracked.get(m.name) ?? [])].filter(h => h.kind === 'save').map(h => h.id)); } },
      e => {
        L._fail(task, e);
        // unloaded meanwhile: its handles already went with it, and the state / handles under this name belong to the newcomer now
        if (!live()) return reportError(this, e, fmt(STALE_INIT, { name: m.name }), { soft: true });
        this._setModState(m, 'failed'); this._dropTracked(m.name); reportError(this, e, fmt(STRINGS.lateInit, { name: m.name }), { module: m });
      }));
  },
  /** @internal the one gate for module hooks, the loop's and afterLoad (saveApply.js): registered (init not run yet), initializing, failed, disabled, blocked run none */
  _runsHooks(name) { return this._modState.get(name) === 'running' && !this._modBlocked.has(name); },
  /**
   * @internal may this install (token from engine._modInst) still register? It is the one under its name and not closed. Closed = its signal aborted (_dropTracked:
   * unload, rollback, failed init), set before the cleanup runs, so a late callback and a remove() that calls ctx.track during that cleanup are both refused (design 6.1)
   */
  _isLive(name, inst) { return this._wasRunning(name, inst, false) && !inst.ac.signal.aborted; },
  /** @internal is this the install under its name (and, with running, did it run)? The question a save part asks while its install closes: a module that ran keeps its data on unload */
  _wasRunning(name, inst, running = true) {
    return !this.disposed && inst !== undefined && this._modInst.get(name) === inst && (!running || this._modState.get(name) === 'running');
  },
  /** @internal the ctx install / init receive: track(handle) ties a handle to the module's life (see the top of this file) */
  _modCtx(m, inst = this._modInst.get(m.name)) {
    const name = m.name;
    const stale = () => { if (this._isLive(name, inst)) return false; if (DEV && !this.disposed) warnOnce(coded('module-handle', fmt(STALE, { name }))); return true; };
    const spent = { owner: name, active: false, remove() {}, change: () => false, move: () => false };   // what a verb of a gone install answers: every handle shape, doing nothing
    const ifLive = fn => (...a) => (stale() ? spent : fn(...a));
    const track = h => {
      if (typeof h?.remove !== 'function') throw codedError('module-handle', fmt(BAD_HANDLE, { name, got: String(h) }));
      // a registration from an install that is gone (replaced / unloaded while its async init awaited, or a dispose): filing it under the name would hand it
      // to the newcomer, which would then own a listener it never made; remove it now instead
      if (stale()) { h.remove(); return h; }
      let set = this._modTracked.get(name);
      if (!set) this._modTracked.set(name, set = new Set());
      set.add(h);
      if (h._timer && this._modState.get(name) !== 'running') this.session._keepTimer(h._timer);
      if (this._curModule === m) this._picture?.learn(m);   // the module's own code called this: its file is the part's (core/inspect/pictureWriters.js)
      return h;
    };
    // mod: engine.mod with the module as owner, tracked. Why a ctx verb and not "guess the running module": in an async callback the guess is wrong;
    // and a handle that is not tracked is a weather multiplier still on after the module went
    const mod = ifLive((point, o) => {
      if (o?.owner !== undefined) throw codedError('mod-owner', fmt(CTX_OWNER, { point, name }));
      return track(this.mod(point, { ...o, owner: name }));
    });
    // borrow: write values on an object the module does not own (a renderer setting, scene.fog, the engine dome's visible) and give them back when it goes.
    // Why compare on the way back: a later legal takeover (the game set its own fog meanwhile) must win, so a value goes back only if it is still what this borrow left there.
    // Why read back after writing: a setter may keep something else than it was handed, and that is what "still mine" has to compare with.
    // Why one holder: a borrow is one party's temporary use. Two overlapping ones ended oldest first brought an ended value back, and a value with two parties is what
    // shared points own (engine.mod). A holder whose value the game replaced has lost it, so that property is free again.
    // Why the holder is asked on the way back too, not only the value: a later borrow may write the same value the lost one wrote, and then the value alone cannot tell them apart.
    // Why a batch is undone when a setter throws: no handle exists yet to give the first properties back, so they would stay written with nobody holding them.
    const borrow = ifLive((obj, values) => {
      if (!obj || typeof obj !== 'object' || !values || typeof values !== 'object') throw codedError('module-handle', fmt(BAD_BORROW, { name, got: `${String(obj)}, ${String(values)}` }));
      let lent = this._borrowed.get(obj);
      if (!lent) this._borrowed.set(obj, lent = new Map());
      for (const key of Object.keys(values)) {
        const t = lent.get(key);
        if (t && Object.is(obj[key], t.wrote)) throw codedError('module-handle', fmt(BORROW_HELD, { name, key, holder: t.name }));
      }
      const taken = [];
      // each property on its own: a setter that throws while giving back must not keep the others written, and its holder record goes either way (the list is
      // already emptied, so nothing could clean it later). Returns the first such error, which the caller throws after the rest went back
      const giveBack = () => {
        let failed = null;
        for (const t of taken.splice(0)) {
          try { if (lent.get(t.key) === t && Object.is(obj[t.key], t.wrote)) obj[t.key] = t.was; }
          catch (err) { failed ??= { err }; }
          finally { if (lent.get(t.key) === t) lent.delete(t.key); }
        }
        return failed;
      };
      try { for (const key of Object.keys(values)) { const was = obj[key]; obj[key] = values[key]; const t = { key, was, wrote: obj[key], name }; lent.set(key, t); taken.push(t); } }
      catch (err) {   // the write error stays the primary one; a failure undoing it is reported on its own (soft), not lost
        const undo = giveBack();
        if (undo) reportError(this, undo.err, `giving back a failed borrow of module ${name}`, { soft: true });
        throw err;
      }
      const h = { borrow: true, remove: () => {
        const failed = giveBack();
        this._modTracked.get(name)?.delete(h);   // a module that borrows often (a cutscene a minute) does not pile up dead handles, as with control below
        if (failed) throw failed.err;
      } };
      return track(h);
    });
    // input: declare actions / bind the keys the game handed the module, owned by the module (removed with it); never a key of its own
    const input = {
      define: ifLive((n, o) => track(this.input.define(n, { ...o, owner: name }))),
      bind: ifLive((n, keys) => track(this.input.bind(n, keys, { owner: name }))),
    };
    // control: engine.control.take with the module as default owner, tracked, so a module that goes (unload, rollback, replaces) hands back every
    // character it was steering. Unlike mod an owner may be given: one module can hold several characters on its own names (one per cutscene run).
    // A hold that ends by itself leaves the tracked set too, so a module taking control often (a cutscene a minute) does not pile up dead handles.
    // Taking the same character again under the same owner replaces the hold, so the stale handle leaves the tracked set as well.
    const held = new Map();   // `${id} ${owner}` -> the live handle
    const control = {
      take: ifLive((who, o = {}) => {
        const h = this.session._untrack(this.control.take(who, { ...o, owner: o.owner ?? name })), end = h.remove, key = `${h.id} ${h.owner}`;
        const old = held.get(key);
        if (old) this._modTracked.get(name)?.delete(old);
        held.set(key, h);
        h.remove = () => { end(); if (held.get(key) === h) held.delete(key); this._modTracked.get(name)?.delete(h); };
        return track(h);
      }),
      has: (who, owner = name) => this.control.has(who, owner),
    };
    // whileCompiling: a one-time warm-up (a WASM library's first call) run while start() waits for the GPU to compile shaders, when the page's
    // thread is idle anyway (startup.js); after start() it runs at once
    // It checks the install like track does: a warm-up queued by an install that was unloaded before start() ran the queue must not run
    // (it would touch state of an install that is gone), and one asked for by an install that is already stale is not queued at all
    const whileCompiling = fn => {
      if (!this._isLive(name, inst)) return;
      const run = () => { if (this._isLive(name, inst)) fn(); };
      if (this.ready) run(); else this._whileCompiling.push(run);
    };
    // one scope for everything a module registers, so unload, rollback and a failed init all clean up through _dropTracked and none of them needs its own list.
    // Why ctx verbs and not "the module installing now": the callback that registers may run long after install; inst says which install it belongs to
    const own = (kind, id, h) => track(Object.assign(h, { kind, id, owner: name, inst }));
    const owned = (kind, add) => ifLive((id, ...rest) => own(kind, id, add(id, ...rest)));
    // a part keeps its data only when the module ran: a rolled-back or failed install has only half-built state to offer (Saves.define)
    const defineSave = ifLive((key, part) => {
      const h = this.saves.define(key, part);
      return own('save', key, { remove: () => h.remove({ keep: this._wasRunning(name, inst) }) });   // runs after the install closed: not _isLive
    });
    // declared, not just called: _planUse finds a ground conflict from provides before anything installs, which a call inside install() could not give
    const provideGround = ifLive(g => {
      if (!m.provides?.includes('ground')) throw codedError('module-provides', fmt(STRINGS.groundClaim, { name }));
      return own('ground', 'ground', this._provideGround(g));
    });
    // feeds: this module puts data into whoever holds that capability. fn runs when a new holder arrives, before its use() returns, and leaves with this module
    const feeds = (capability, fn) => {
      const f = { name: capability, fn };
      (this._feeders ??= []).push(f);
      return track({ remove: () => { const i = this._feeders.indexOf(f); if (i >= 0) this._feeders.splice(i, 1); } });   // a handle removed twice must not take the next feeder
    };
    // signal: aborts when this install ends (_dropTracked), the one lifecycle; an async init checks it after each await instead of keeping its own flag
    // commits: a module reaches the commit queue through its ctx; a game outside a module uses engine.nextFixed (engine.commits is internal)
    return { name, signal: inst?.ac.signal, track, mod, borrow, feeds, input, control, whileCompiling, commits: this.commits,
      // rule: a replaceable rule of this module, set by anyone with engine.mod(name, { owner, id?, set }). Not tracked: the point outlives a module that shares it, its entries go with their owners
      // a closed install defines no rule: Stacks.rule would define a point for good under a name a later module may need. It still answers like a rule, with its default
      rule: (n, def, names) => (stale() ? { name: n, value: () => def, decide: (_id, facts) => (typeof def === 'function' ? def(facts, this) : def) } : this.stacks.rule(n, def, names)),
      ops: { define: owned('op', (n, def) => this.ops.define(n, def)) },
      saves: { define: defineSave },
      ui: { define: owned('ui', (n, factory, def) => this.ui.define(n, factory, def)) },
      stream: { addReadyCheck: owned('ready', (n, fn) => this.stream.addReadyCheck(n, fn)) },
      budget: { metric: owned('metric', (n, read, o) => this.budget.metric(n, read, o)) },
      things: { addSource: ifLive(src => own('source', name, this._things.addSource(src))), explainWith: ifLive(fn => own('explainer', name, this.explainWith(fn))) },
      ground: { provide: provideGround, addColliders: ifLive(fn => own('colliders', name, this.addGroundColliders(fn))) },
    };
  },
  /** @internal remove every handle a module tracked, newest first like dispose; one that throws is reported and the rest still go */
  _dropTracked(name) {
    this._modInst.get(name)?.ac.abort();   // ctx.signal: the install is over (unload, rollback, failed init), async work it started stops
    const set = this._modTracked.get(name);
    if (!set) return;
    this._modTracked.delete(name);
    removeEach(this, [...set].reverse(), `remove() of a handle module ${name} tracked`, h => { if (h._timer) this.session._dropTimer(h._timer); });
  },
  /** @internal move a module to a new state and refresh the hooks (initializing / failed modules run none) */
  _setModState(m, state) {
    if (this.disposed || this._modState.get(m.name) === state) return;
    this._modState.set(m.name, state);
    this._sortHooks();
  },
  /**
   * Where each module is: 'registered' (init not started yet), 'initializing', 'running', 'failed' (init threw: no hooks), 'disabled' (a picture or ui module that threw while
   * running: switched off, the game goes on), 'blocked' (a provider it requires is not running: no init, no hooks; engine.catalog(name).blockedBy says which) or 'disposed'.
   * @returns {Record<string, string>}
   * @example engine.use(shop()); await engine.loading.settled(); engine.explain({ module: 'shop' }).ok   // true
   */
  /** @internal */
  get moduleStates() {
    return Object.fromEntries([...this._modState].map(([n, s]) => [n, s !== 'failed' && s !== 'disposed' && this._modBlocked.has(n) ? 'blocked' : s]));
  },
  /**
   * What this game can do, read from the registrations (see core/inspect/catalog.js): no argument = short list, a module id or op name = that entry expanded.
   * @param {string | { find?: string }} [id]
   * @returns {any}
   * @example engine.catalog();  engine.catalog('sky');  engine.catalog('shop.buy');  engine.catalog({ find: 'buy' })
   */
  catalog(id, o) { return catalog(this, id, o); },
  /**
   * Is a module of this name, or a provider of this capability, installed? Installed only: engine.explain({ module: name }) says whether it is running.
   * @param {string} name
   * @example if (!engine.has('inventory')) engine.use(inventory());
   */
  has(name) { return this.modules.has(name) || this._provided(name); },
  /** @internal Can this module or capability be called now? True once it is running: init finished, nothing it requires is down, not disabled after an error. Game code asks engine.explain({ module }) */
  usable(name) {
    return giversOf([...this.modules.values()], name).some(m => this._modState.get(m.name) === 'running' && !this._modBlocked.has(m.name));
  },
  /** Run order of module hooks (module names, first to last), for debugging "who runs first". */
  get moduleOrder() { return this._moduleOrder ?? []; },

  /** Re-sort the module hooks in the main loop (disabled picture / ui modules are not put back). */
  _sortHooks() {
    const order = sortModules([...this.modules.values()]);
    this._moduleOrder = order.map(m => m.name);
    this._refreshBlocks();
    for (const k of HOOKS) this._hooks[k] = [];
    for (const m of order) {
      if (!this._runsHooks(m.name)) continue;
      let c = hookCache.get(m);
      if (!c) hookCache.set(m, c = {});
      for (const k of HOOKS) if (m[k]) this._hooks[k].push(c[k] ??= { fn: m[k].bind(m), name: m.name, mod: m });
    }
    this._initWaiting();
    this._warnContractGaps();
  },
  /** @internal who is blocked now: derived from the states on every change, so install, unload, replace and a failed init need no rule of their own */
  _refreshBlocks() {
    const mods = [...this.modules.values()], seen = new Map(), blocks = new Map(), dead = new Set();
    const up = m => {
      if (seen.has(m)) return seen.get(m);
      seen.set(m, true);   // a requires cycle does not block itself
      const by = [];
      for (const dep of m.requires ?? []) {
        const givers = giversOf(mods, dep);
        if (givers.some(up)) continue;
        const p = givers[0], state = !p ? 'missing' : blocks.has(p.name) ? 'blocked' : this._modState.get(p.name);
        by.push({ requires: dep, module: p?.name ?? null, state });
        if (state === 'failed' || state === 'disabled' || dead.has(p?.name)) { dead.add(m.name); warnOnce(fmt(STRINGS.blocked, { name: m.name, dep, by: p.name, state })); }   // waiting ends by itself; a failure does not, so it is said once
      }
      if (by.length) blocks.set(m.name, by);
      const ok = !by.length && this._modState.get(m.name) === 'running';
      seen.set(m, ok);
      return ok;
    };
    mods.forEach(up);
    this._modBlocked = blocks;
    for (const name of dead) {
      const m = this.modules.get(name), inst = this._modInst.get(name);
      if (!m.critical || this._modFatal.has(inst)) continue;
      this._modFatal.add(inst);
      const b = blocks.get(name)[0], err = codedError('module-critical', fmt(STRINGS.critical, { name, dep: b.requires, by: b.module, state: b.state }));
      if (this._initsDone) reportError(this, err, fmt(STRINGS.lateInit, { name }), { module: m });
      else this.loading._fail(this.loading._begin(name, 'module', { critical: true }), err);   // start() stops on it, like a critical init that threw
    }
  },
  /** Called by start(): warn once in dev when an optional dependency written as { module: 'what is lost' } is not installed. */
  _checkOptional() {
    if (!DEV) return;
    for (const m of this.modules.values()) {
      const opt = m.optional;
      if (!opt || Array.isArray(opt)) continue;
      for (const [dep, what] of Object.entries(opt)) if (!this.has(dep))
        warnOnce(coded('module-requires', fmt(STRINGS.optional, { name: m.name, dep, what })));
    }
  },
};
