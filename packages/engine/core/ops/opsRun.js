// ops.run itself (split out of Ops.js). Order: can -> log -> [snapshot if atomic] -> run -> commit (revision + 1, after hook) or fail (rollback if atomic).
// A run that returns or throws a structured failure { ok: false, code, facts?, nextActions? } counts as failed, like a can that said no (see opsFail.js).
import { DEV, fmt, syncOnly } from '../base/validate.js';
import { devError, argRange } from './opsCheck.js';
import { reportError } from '../base/errors.js';
import { failure, isRunFailure, opsBlocked } from './opsFail.js';
import { snapshot, rollback, markRolledBack } from './opsAtomic.js';
import { withDefaults } from '../base/params.js';

const MAX_DEPTH = 16;
const RUN_STRINGS = {
  canRun: "{name}'s can called ops.run('{inner}'). can is read-only; call other ops from run",
  loop: 'ops call each other in a loop (deeper than ' + MAX_DEPTH + '): {chain}',
};

/** Undo an atomic run's writes; a failing rollback is reported, never thrown over the original failure */
function undoWrites(ops, e, snap, name, where, seq, depth) {
  ops.revision++;   // the revision only goes up: a rollback is a new state, never "the old number again"
  markRolledBack(ops, seq, depth);
  try { rollback(e, snap, name); } catch (err) { reportError(e, err, where + ' rollback'); }
}

/** @internal Called by Ops.run */
export function runOp(ops, name, args, opts) {
  const e = ops.engine, d = ops._def(name);
  if (!d) return ops._res(failure('unknownOp'));
  args = withDefaults(d.defaults, args);
  if (ops._inCan) throw devError(fmt(RUN_STRINGS.canRun, { name: ops._inCan, inner: name }));
  if (ops._stack.length >= MAX_DEPTH) throw devError(fmt(RUN_STRINGS.loop, { chain: ops._stack.concat(name).join(' -> ') }));
  if (ops._route) { const r = ops._route(d, args, opts); if (r) return r; }   // net client: requests go to the host (also from inside a net: 'local' op)
  const parent = ops._stack.length ? ops._last : null;
  const ctx = ops._ctx(name, args, opts, parent);
  const depth = ops._stack.length, ev = e.events, where = `ops.run('${name}')`;
  const blocked = opsBlocked(e);
  if (blocked) { ops._log(name, args, ctx, false, blocked, depth); return ops._res(failure(blocked)); }
  if (DEV && args && typeof args === 'object') Object.freeze(args);
  const failed = (f, h) => {   // a failed run: log it, trace it with its code
    if (h) { h.ok = false; h.code = f.code; } else ops._log(name, args, ctx, false, f.code, depth);
    if (ev.traceSize > 0) ev.note('op:' + name, { code: f.code, obj: args?.id });
    return ops._res(f);
  };
  if (!DEV) { const bad = argRange(e, d, args); if (bad) return failed(failure(bad), null); }   // release: the data checks still hold (dev throws earlier, in _ctx)
  ops._stack.push(name);
  const prevCtx = ops._last; ops._last = ctx;
  const prevCause = ev._cur, atomic = d.atomic === true, mark = ops._txAfter.length;   // events emitted by this op's run name it as their cause (Events.trace)
  let h = null, seq = 0, snap = null;
  if (atomic) ops._txDepth++;
  try {
    const res = ops._can(d, args, ctx);
    if (res !== true) return failed(failure(res), null);
    h = ops._log(name, args, ctx, true, null, depth); seq = h.seq;   // logged before run so nested ops follow their parent in the history
    if (ev.traceSize > 0) ev._cur = `op:${name}#${seq}`;
    if (atomic) snap = snapshot(e);
    let value;
    try { value = d.run(e, args, ctx); if (ops._txDepth > 0) syncOnly(value, where, true); } catch (err) { if (!isRunFailure(err)) throw err; value = err; }   // a Promise value is an error only inside a transaction (an atomic op, or a run nested in one): it would report success, then write or fail outside the rollback. A plain op may return one as its value (interaction.use, photo.trace)
    if (isRunFailure(value)) {
      if (snap) { undoWrites(ops, e, snap, name, where, seq, depth); ops._txAfter.length = mark; }
      return failed(failure(value), h.seq === seq ? h : null);
    }
    ops.revision++;
    if (d.after) {
      const hook = () => { try { syncOnly(d.after(e, args, value, ctx), where + ' after'); } catch (err) { reportError(e, err, where + ' after'); } };
      if (ops._txDepth > 0) ops._txAfter.push(() => ops._as(name, ctx, hook)); else hook();   // in or inside an atomic run: queue, so hooks run in commit order (nested first) when the outermost one ends; off the stack by then, so with its ctx
    }
    return { ok: true, value, revision: ops.revision };
  } catch (err) {
    if (snap) { undoWrites(ops, e, snap, name, where, seq, depth); ops._txAfter.length = mark; }
    if (err?.opsDevError) throw err;
    // a bad value that came in as an argument is the caller's mistake, not a broken game: refused like a can that said no, so gameplay does not freeze on it.
    // Only that one: a NaN the op worked out itself is a bug in the game, and goes on to stop it where it happened
    if (err?.code === 'bad-position' && Object.values(args ?? {}).includes(err.value)) return failed(failure({ code: 'badPosition', facts: { message: err.message } }), h?.seq === seq ? h : null);
    if (h?.seq === seq) { h.ok = false; h.code = 'error'; } else ops._log(name, args, ctx, false, 'error', depth);
    reportError(e, err, where);
    if (e.error?.where === where && !e.error.ops) e.error.ops = ops.recent().slice(-5).map(r => `${r.name}${r.ok ? '' : ' x ' + r.code}`);
    if (ev.traceSize > 0) ev.note('op:' + name, { code: 'error' });
    return ops._res(failure('error'));
  } finally {
    ops._stack.pop(); ops._last = prevCtx; ev._cur = prevCause;
    if (atomic && --ops._txDepth === 0) { const q = ops._txAfter.splice(0); for (const f of q) f(); }   // outermost atomic op ended: its queued after hooks run now (empty after a rollback)
    ops._drainRolled();   // op:rolledBack, now that nothing of the failed run is left
  }
}
