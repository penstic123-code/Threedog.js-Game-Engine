// Exclusive slots for modules ("only one may hold this": 'sky', 'inventory', a tone-mapping stage), mixed into Engine with modules.js.
//   provides: ['inventory']                        the module holds the slot while installed (a kind 'one' shared point, core/ops/sharedPoint.js);
//                                                  a second provider is shared-taken, naming both and the replaces fix
//   requires: ['inventory']                        depend on the slot, not on whichever module gives it
//   engine.use(mine(), { replaces: 'inventory' })  unload the holder first (its tracked handles, slot, ctx.mod entries, drawing parts, dispose)
// Why the slot is a shared point and not a module-name table: one owner registry for everything (describe().shared shows the holder beside
// every shared value, ctx.track releases it with the rest), so there is no second mechanism to learn. Kept apart from modules.js only for size.
import { DEV, fmt, closest, warnOnce, syncOnly } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';
import { reportError } from '../base/errors.js';
import { PICTURE_SLOTS } from '../scene/pictureSlots.js';

const STRINGS = {
  provides: 'module {name}: provides is a list of exclusive slot names, e.g. provides: [\'inventory\']; got {got}',
  notSlot: 'module {name} provides \'{slot}\', but \'{slot}\' is a shared value (kind {kind}), not an exclusive slot; pick a slot name of its own, or change the value with ctx.mod(\'{slot}\', { ... })',
  noHolder: 'engine.use(..., { replaces: \'{slot}\' }): no installed module provides \'{slot}\', so there is nothing to replace. Fix: drop { replaces }, or check the slot name (describe().shared lists the slots held now)',
  notProvided: 'engine.use(..., { replaces: \'{slot}\' }): none of the modules in this call provides \'{slot}\', so the swap would leave it empty. Fix: add provides: [\'{slot}\'] to the module that takes over from {holder}',
  tooLate: "this module change takes '{slot}' away: {why}, and '{slot}' owns what they stand on, so it cannot leave or be replaced under them; nothing was changed. Fix: install your {slot} before the modules that need it: engine.use(my{slot}(), ...) first, or { replaces: '{slot}' } while nothing else is installed and before start()",
  nameTaken: 'engine.use(..., { replaces: \'{slot}\' }): module {name} is already installed and does not hold \'{slot}\', so this call would unload {holder} and install nothing. Fix: give the newcomer another name, or unload the installed {name} first',
  unuse: 'dispose hook of module {name} (unloaded by replaces)',
  misspelt: "picture module {name} provides '{slot}', which is not a picture slot, so no other part collides with it and the writers tool cannot see it. Fix: provides: ['{hint}'] (the slots: {list})",
  taken: "slot '{slot}' is held by module {holder}, so module {name} cannot provide it. Fix: engine.use({name}(), { replaces: '{slot}' }) (unloads {holder} cleanly), or install only one of them",
  notIn: "engine.unuse('{name}'): no such module is installed. Installed: {list}",
  needed: "engine.unuse('{gone}'): module {name} requires '{dep}', and nothing else provides it. Fix: unload {name} first, or swap in another provider: engine.use(mine(), { replaces: '{dep}' })",
  gaps: "module {name} provides '{cap}' but lacks {missing}, which the '{cap}' contract lists; a caller of one of those crashes. Fix: add them to {name}'s API (engine.catalog('{name}').problems lists them)",
};

/** Slots named after a core service: the claim is exclusive like any other, but engine.<slot> stays the core API (engine.ground is what everyone reads,
 *  and a provider writes it with ctx.ground.provide), so it never becomes an alias of the provider */
export const CORE_SLOTS = new Set(['ground']);
/** Slots whose holder owns what every other module stands on: what they built in it cannot move to a new holder, so a swap comes before they are there or not at all */
const FOUNDATION_SLOTS = new Set(['world']);

/** capability -> its contract (the existing contract files, filled by index.js: core imports no module). Read only where a capability binds, on module changes */
export const CAP_CONTRACTS = new Map();

/** Who answers to a capability in this list: the module of that name, or the module that provides it. The one reading of a name in requires, before, after, has and usable */
export const giversOf = (mods, cap) => mods.filter(m => m.name === cap || m.provides?.includes(cap));

/** The error for a second provider of a slot, found in the graph before anything is touched */
export const slotTaken = (slot, holder, name) => codedError('shared-taken', fmt(STRINGS.taken, { slot, holder, name }));

/** engine.use(a(), b(), { replaces: 'sky' }): the options object is the last argument and has `replaces` (a module always has a name) */
export const isUseOpts = o => !!o && typeof o === 'object' && !Array.isArray(o) && !('name' in o) && 'replaces' in o;

/** _planUse: a module's provides must be a list of names (checked before anything installs) */
export function checkProvides(m) {
  if (m.provides != null && !(Array.isArray(m.provides) && m.provides.every(s => typeof s === 'string' && s)))
    throw codedError('module-provides', fmt(STRINGS.provides, { name: m.name, got: JSON.stringify(m.provides) }));
  // a misspelt claim is worse than none: it reads as declared and guards nothing. Picture modules only, and only a near miss: their own slots stay free
  if (DEV && m.type === 'picture') for (const slot of m.provides ?? []) {
    const hint = slot in PICTURE_SLOTS ? null : closest(slot, Object.keys(PICTURE_SLOTS));
    if (hint) warnOnce(coded('module-provides', fmt(STRINGS.misspelt, { name: m.name, slot, hint, list: Object.keys(PICTURE_SLOTS).join(', ') })));
  }
}

export const slotMethods = {
  /**
   * @internal engine.use(mod, { replaces }): the installed modules that hold these slots, after checking the swap is well formed
   * (the slot is held, the newcomer provides it); what else the holder gave is _planChange's to check.
   * @returns {Set<string>} module names to unload
   */
  _replaced(list, replaces) {
    const gone = new Set();
    if (replaces == null) return gone;
    const slots = [].concat(replaces), holderOf = slot => [...this.modules.values()].find(m => m.provides?.includes(slot))?.name;
    for (const slot of slots) {
      // read from the module table, not the shared point: a provider whose init failed gave its slot back but is still what a replaces swaps out
      const holder = holderOf(slot);
      if (!holder) throw codedError('module-replaces', fmt(STRINGS.noHolder, { slot }));
      gone.add(holder);
    }
    // a factory's sibling: listed again under its name and built on a module that leaves. _planUse skips a name that stays, which would leave the old sibling bound to the holder
    // that went and the new one never installed. Each pass may reach a sibling of a sibling
    const leaving = dep => gone.has(dep) || [...gone].some(n => this.modules.get(n).provides?.includes(dep));
    for (let grew = true; grew;) {
      grew = false;
      for (const m of list) {
        const old = m?.name && this.modules.get(m.name);
        if (old && old !== m && !gone.has(m.name) && old.requires?.some(leaving)) { gone.add(m.name); grew = true; }
      }
    }
    for (const slot of slots) {
      const givers = list.filter(m => m?.provides?.includes(slot)), holder = holderOf(slot);
      if (!givers.length) throw codedError('module-replaces', fmt(STRINGS.notProvided, { slot, holder }));
      // _planUse skips a name that stays installed, so that newcomer would never come
      if (givers.every(m => this.modules.has(m.name) && !gone.has(m.name))) throw codedError('module-replaces', fmt(STRINGS.nameTaken, { slot, name: givers[0].name, holder }));
    }
    return gone;
  },
  /** @internal a foundation slot leaves or is swapped only before start and before a module that stays names it in requires or optional. engine.dispose does not pass here */
  _refuseLate(slot, holder, gone, code) {
    const names = m => [...(m.requires ?? []), ...(Array.isArray(m.optional) ? m.optional : Object.keys(m.optional ?? {}))];
    const users = [...this.modules.values()].filter(m => !gone.has(m.name) && names(m).some(n => n === slot || n === holder)).map(m => m.name);
    const why = users.length ? `${users.join(', ')} already use it` : this.ready || this._starting ? 'the game has started' : null;
    if (why) throw codedError(code, fmt(STRINGS.tooLate, { slot, why }));
  },
  /**
   * @internal the one gate of every module change (use, unuse, replaces, plugin on / off): the batch is validated, then the graph after the change is worked out and every
   * module in it, kept or new, must still find what it requires. Nothing is touched before this returns. A whole set goes in at once: a plugin may own both provider and consumer.
   * @param {any[]} list  modules to add
   * @param {Set<string>} gone  modules that leave
   * @param {{ code: string, text: string }} refusal  the error when a consumer would lose a provider; text gets {gone}, {name}, {dep}
   * @returns {any[]} the modules to install
   */
  _planChange(list, gone, refusal) {
    const plan = this._planUse(list, gone);
    if (!gone.size) return plan;   // nothing leaves, so no kept module can lose anything
    for (const name of gone) for (const slot of this.modules.get(name)?.provides ?? []) if (FOUNDATION_SLOTS.has(slot)) this._refuseLate(slot, name, gone, refusal.code);
    const after = [...[...this.modules.values()].filter(m => !gone.has(m.name)), ...plan];
    const caps = new Set(after.flatMap(m => [m.name, ...(m.provides ?? [])]));
    for (const m of after) for (const dep of m.requires ?? []) if (!caps.has(dep))
      throw codedError(refusal.code, fmt(refusal.text, { gone: [...gone].join(', '), name: m.name, dep }));
    return plan;
  },
  /**
   * Unload one installed module: its tracked handles, its slots and ctx.mod entries, its dispose. What it added some other way stays (dev reports a picture module's
   * leftovers). To swap a holder use engine.use(mine(), { replaces: 'slot' }).
   * @example engine.unuse('rain');
   * @param {string} name
   */
  unuse(name) {
    const m = this.modules.get(name);
    if (!m) throw codedError('module-unuse', fmt(STRINGS.notIn, { name, list: [...this.modules.keys()].join(', ') || 'none' }));
    const gone = new Set([name]);
    this._applyChange(this._planChange([], gone, { code: 'module-unuse', text: STRINGS.needed }), gone);
  },
  /**
   * @internal unload one installed module (engine.unuse, replaces, a plugin taken out): tracked handles and slots, drawing parts, its dispose, the engine property;
   * returns its definition. swapping: a newcomer takes over its slots, so what it wrote to them is the newcomer's to replace
   */
  _unuse(name, swapping = false) {
    const m = this.modules.get(name);
    this._dropTracked(name);
    try { syncOnly(m.dispose?.(this), `dispose() of module ${name}`, true); } catch (err) { reportError(this, err, fmt(STRINGS.unuse, { name }), { soft: true }); }
    this._picture?.partGone(m, swapping);
    this.modules.delete(name); this._modState.delete(name); this._modInst.delete(name); delete this[name];
    this._sortHooks();
    return m;
  },
  /** @internal engine.<slot> -> the provider's API while it is installed (the returned handle is tracked by the provider, so it goes with it) */
  _aliasSlot(slot, api) {
    (this._slotAlias ??= new Set()).add(slot);
    return { remove: () => { if (this[slot] === api) delete this[slot]; this._slotAlias.delete(slot); } };
  },
  /** @internal is this capability provided by an installed module? */
  _provided(slot) { for (const m of this.modules.values()) if (m.provides?.includes(slot)) return true; return false; },
  /**
   * @internal every bound capability whose running provider lacks part of its contract: [{ cap, module, missing }]. Bound means a module says provides or requires, so a game's own
   * module that merely shares a name with an engine capability is left alone. Why running and not installed: a provider may fill its API in init. Why this reads the API and calls
   * nothing: the behavior half of a contract is the tools/contract check, and a method on a live game must not run just to be looked at.
   */
  _contractGaps() {
    const mods = [...this.modules.values()], gaps = new Map();
    for (const cap of new Set(mods.flatMap(m => [...(m.provides ?? []), ...(m.requires ?? [])]))) {
      const c = CAP_CONTRACTS.get(cap), p = c && giversOf(mods, cap).find(g => this._modState.get(g.name) === 'running');
      if (!p) continue;
      const api = Object(this[p.name]);
      const missing = [...c.api.filter(k => typeof api[k] !== 'function'), ...(c.fields ?? []).filter(k => !(k in api))];
      if (missing.length) gaps.set(cap, { cap, module: p.name, missing });
    }
    return [...gaps.values()];
  },
  /** @internal dev: say each gap once. A warning and not a refusal: a partial provider that serves its game ran before this check existed, and only the game knows what it calls */
  _warnContractGaps() {
    if (DEV) for (const g of this._contractGaps())
      warnOnce(coded('module-contract', fmt(STRINGS.gaps, { name: g.module, cap: g.cap, missing: g.missing.join(', ') })), `module-contract:${g.cap}:${g.module}`);
  },
  /** @internal the exclusive slot a module provides (a 'one' shared point, made on first use) */
  _slot(slot, by) {
    if (!this.stacks.has(slot)) return this.stacks.define(slot, { kind: 'one', save: false });
    const s = this.stacks.get(slot);
    if (s.kind !== 'one') throw codedError('module-provides', fmt(STRINGS.notSlot, { name: by, slot, kind: s.kind }));
    return s;
  },
};
