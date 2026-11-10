// Module types: what a module may own (a module's `stage` only says when it runs; its `type` says what it may own and how its errors are handled:
// picture / ui fail soft, see core/base/errors.js). Mixed into Engine with modules.js.
//   type: 'world' | 'picture' | 'actor' | 'rules' | 'ui' | 'net' | 'tool'  -- optional: a module without one is 'rules', game logic. An unknown name is an error (a typo).
// Why a type and not a rule in the docs: an AI follows the shape of the code, not a paragraph. A picture module that defines an op, or a ui module that binds
// keys, is often the start of two modules owning one thing; the check says so once, with the one-line fix, where it happens. It warns and never refuses: a game's
// own module may do what it needs, and only the game knows when that split is right.
// No subtypes: differences inside a type are the declarations the engine already checks (provides, requires, shared values written with ctx.mod,
// material slots patched, the post stage, backends, sounds).
// The checks are dev only and cheap: the engine knows which module is installing (install and the synchronous part of init) or running a hook
// (fixed / frame / afterRender / skip), and the few write points below ask it. A callback a module registered (an event listener, a timer) is not
// attributed: the check is a guard rail at the common places, not a sandbox.
import { DEV, fmt, warnOnce } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';
import { callerAt } from '../ops/stackFrames.js';

/** type -> what it may own (shown in the unknown type error and in recipes/14) */
export const MODULE_TYPES = {
  world: 'game state: save parts, world records, ops, ground / collision / navigation data (draws nothing)',
  picture: 'what is seen and heard: picture values, three.js objects, particles, sounds (changes no game state)',
  actor: 'characters: their control slots and movement values (other state only through ops)',
  rules: 'game logic: save parts, ops, events; may take input, control or the camera for a while (a cutscene)',
  ui: 'DOM panels and menus: declares input actions, runs ops (binds no keys, writes no game save)',
  net: 'multiplayer: remote characters and the transport (other modules only through ops and their public API)',
  tool: 'a one-shot job (a photo, a bake) that undoes itself when it ends or fails',
};

/** How engine.skip advances a module (the skipKind field): what each word means is on ModuleDefinition in types/core.d.ts */
export const SKIP_KINDS = ['exact', 'approx', 'step', 'none'];
/** The time hooks a module definition may carry (engine.catalog and the generated metadata list the ones a module has) */
export const TIME_HOOKS = ['fixed', 'frame', 'afterRender', 'skip', 'afterLoad'];

const STRINGS = {
  badSkip: "module {name} has skipKind '{kind}'. Fix: use one of {list}",
  unknown: "module {name} has type '{type}', which is not a module type. Fix: use one of {list}",
  // rule broken at runtime: module, type, what it did, why not, the fix
  broke: "module {name} (type '{type}') {did}: {why}. Fix: {fix}",
};
const RULES = {
  // [types it is wrong for, why, fix]
  'ops.define': [['picture'], 'a picture module only shows the game, it never adds actions that change it',
    "define the op in a rules (or world) module and let the picture module read the state; or give {name} type: 'rules' if it really is game logic"],
  'world.write': [['picture', 'ui'], 'world records are game state; a {type} module only reads them',
    "run an op that writes it (engine.ops.run('<noun.verb>', args)) or move the write into a rules / world module"],
  'input.bind': [['ui'], 'a ui module declares actions; which key does what is the game\'s choice',
    "declare the action (ctx.input.define(name, { context })) and bind keys in the game: engine.input.bind(name, ['KeyE']) or createEngine({ bindings })"],
  'saves.define': [['ui'], 'a ui module keeps menus and preferences out of the game save (a load must not change the volume)',
    'keep preferences in browser storage (engine.settings does), and game state in a rules / world module'],
};

/** _planUse: no type is 'rules'; any other must be one of MODULE_TYPES (unknown = error naming the fix) */
export function checkType(m) {
  m.type ??= 'rules';
  if (!Object.hasOwn(MODULE_TYPES, m.type)) throw codedError('module-type', fmt(STRINGS.unknown, { name: m.name, type: String(m.type), list: Object.keys(MODULE_TYPES).map(t => `'${t}'`).join(' | ') }));
  if (m.skipKind !== undefined && !SKIP_KINDS.includes(m.skipKind)) throw codedError('module-type', fmt(STRINGS.badSkip, { name: m.name, kind: String(m.skipKind), list: SKIP_KINDS.map(k => `'${k}'`).join(' | ') }));
}

/**
 * @internal dev check at a write point: warns once when the module installing or running a hook now does `what` and its type does not usually own it.
 * what: 'ops.define' | 'world.write' | 'input.bind' | 'saves.define'; did: what it did, for the message ("defined op shop.buy").
 */
export function checkTypeRule(e, what, did) {
  const m = DEV ? e?._curModule : null;
  if (!m) return;
  const [types, why, fix] = RULES[what];
  if (!types.includes(m.type)) return;
  const v = { name: m.name, type: m.type };
  warnOnce(coded('module-type-rule', fmt(STRINGS.broke, { ...v, did, why: fmt(why, v), fix: fmt(fix, v) })), `module-type-rule:${what}:${m.name}`);
}

/** @internal run fn with m as the current module (install, init's synchronous part, a hook); restores the previous one */
export function asModule(e, m, fn) {
  const was = e._curModule;
  e._curModule = m;
  try { return fn(); } finally { e._curModule = was; }
}

/**
 * @internal For a shared service a module calls without its ctx (engine.settings.define): the handle goes on the running module's ctx.track, the one list its things leave by.
 * Nothing when no module is running. The engine knows the module only during its synchronous code, so what an async callback makes counts as the game's.
 */
export function trackForModule(e, h) { if (e._curModule) e._modCtx(e._curModule).track(h); }

/**
 * @internal dev: a frame hook registered while a module installs stays that module's: it runs as the module, so the picture writers tool can tell two parts in one
 * file apart (a stack cannot) and the type checks reach it. part / at let the leftovers check find a hook that outlived its module. Outside dev fn stays as it is.
 */
export function ownHook(e, fn) {
  const m = DEV ? e._curModule : null;
  if (!m) return fn;
  const f = (...a) => asModule(e, m, () => fn(...a));
  f.part = m.name; f.at = callerAt();
  return f;
}

/** @internal describe().modules row: name, type, and provides / requires when there are any */
export function moduleRow(m) {
  return { name: m.name, type: m.type, ...(m.provides?.length ? { provides: [...m.provides] } : {}), ...(m.requires?.length ? { requires: [...m.requires] } : {}) };
}
