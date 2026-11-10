import { codedError } from '../base/errorHints.js';
// Input contexts. Like Unity Action Maps: a stack of named groups of actions. The top context shadows lower ones that bind the same key;
// an opaque context (the default) blocks everything below it, a `pass` context lets unrelated actions through. Menus, dialogue, cutscenes and
// full-screen UI push an opaque context instead of "locking input", so there is one mechanism, not two.
// Changes take effect at the start of the next fixed step (before the input snapshot), so a key pressed in step N never acts in both the old and the new context.

/** The base context: walking around (the common names: walk, vehicle, dialog, menu, cutscene; a game may add its own) */
export const BASE_CONTEXT = 'walk';

/** @internal */
export function initContexts(input) {
  input._stack = [{ name: BASE_CONTEXT, pass: true }];
  input._pendingCtx = [];
  input._readable = null;   // action -> readable? Rebuilt lazily after a switch / define / rebind
  input._muted = new Set(); // keys cleared by a switch: ignored until physically released (keyboard auto-repeat must not revive them)
}

/** @internal */
export function pushContext(input, name, { pass = false, owner = name } = {}) {
  // owner: who pushed it (describe().holds.input, runState.blockedBy), so "why can't I move" names a system, not only a context
  if (typeof owner !== 'string' || !owner) throw codedError('input-owner', `input.push('${name}', { owner }): owner must be a non-empty string, e.g. input.push('${name}', { owner: 'shop-menu' })`, TypeError);
  const entry = { name, pass, owner };
  let gone = false;
  input._pendingCtx.push({ add: entry });
  return {
    name,
    /** Pop this context (safe to call twice) */
    remove() { if (!gone) { gone = true; input._pendingCtx.push({ del: entry }); } },
  };
}

/** context name -> the keys its actions bind */
function keyIndex(input) {
  const keysOf = new Map();
  for (const [n, a] of input.actions) { const c = a.context || BASE_CONTEXT; let s = keysOf.get(c); if (!s) keysOf.set(c, s = new Set()); for (const k of input.keysOf(n)) s.add(k); }
  return keysOf;
}
/**
 * Every reason an action cannot be read on this stack, walked from the top down to the action's own context: an opaque context above it (its name),
 * a pass-through context above it that binds one of its keys ('shadowed-by:<context>'); or, alone, its own context not on the stack ('context-off:<context>').
 * [] = readable. The one walk behind readableMap, input.blockedBy and describe().holds, so "can it be read" and "why not" never disagree @internal
 */
export function blockers(input, name, stack = input._stack, keysOf = keyIndex(input)) {
  const ctx = input.actions.get(name)?.context || BASE_CONTEXT, keys = input.keysOf(name), out = [];
  let at = stack.length - 1;
  while (at >= 0 && stack[at].name !== ctx) at--;
  // its context is off: nothing is "above" it, and pushing it would put it on top, so that is the one cause (a closed menu's action under a walk key)
  if (at < 0) return [`context-off:${ctx}`];
  for (let i = stack.length - 1; i > at; i--) {
    const c = stack[i], shadow = keysOf.get(c.name);
    if (!c.pass) out.push(c.name);
    else if (shadow && keys.some(k => shadow.has(k))) out.push(`shadowed-by:${c.name}`);
  }
  return out;
}

/** Which actions can currently be read (no blocker on the applied stack); cached until a switch / define / rebind @internal */
export function readableMap(input) {
  if (input._readable) return input._readable;
  const m = new Map(), keysOf = keyIndex(input);
  for (const name of input.actions.keys()) m.set(name, !blockers(input, name, input._stack, keysOf).length);
  return input._readable = m;
}

/** Queued pushes and removes played onto a stack @internal */
function playQueue(q, stack) {
  for (const op of q) {
    if (op.add) stack.push(op.add);
    else { const i = stack.indexOf(op.del); if (i > 0) stack.splice(i, 1); }
  }
  return stack;
}

/** The stack as the next fixed step will leave it: what reports read, because a halted page may wait long for that step @internal */
export function settledStack(input) { return playQueue(input._pendingCtx, input._stack.slice()); }

/** Apply queued push/remove at the start of a fixed step; held keys of newly blocked actions are cleared (a key stays dead until released) @internal */
export function applyContexts(input) {
  const q = input._pendingCtx;
  if (!q.length) return;
  const before = readableMap(input);
  playQueue(q, input._stack);
  q.length = 0;
  input._readable = null;
  const after = readableMap(input);
  for (const [name, was] of before) {
    if (!was || after.get(name)) continue;
    for (const k of input._sourcesOf(name)) {
      if (!input.keys.has(k)) continue;   // even if another action on this key becomes readable: it needs a fresh press (F that boards must not also exit)
      input.keys.delete(k); input._accP.delete(k); input._accR.delete(k); input._muted.add(k);
    }
  }
  input.engine.events.emit('input:context', { stack: input._stack.map(c => c.name) });
}
