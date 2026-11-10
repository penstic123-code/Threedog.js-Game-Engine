// The dev guard of engine.ops (split out of Ops.js): reports saved gameplay state written outside a fixed step, an op or an allow() window.
// Ops.guard(where) is the public entry; the work is here.
import { coded } from '../base/errorHints.js';
import { devError } from './opsCheck.js';
import { fmt, warnOnce } from '../base/validate.js';

const STRINGS = {
  canWrote: "{name}'s can changed state ({where}). can is read-only; change state in run",
  guard: "[engine] gameplay state changed outside a fixed step or an op: {where}{at}.\n"
    + "Change state from UI buttons and timers through an op: engine.ops.run('name', args); put simulation in a module's fixed or world.simulate. See recipes/23-ops.md §5",
  clientGuard: "[engine] net client changed shared state locally: {where}{at}.\n"
    + "On a client the host owns the state; request the change with engine.ops.run (op defined with net: 'peer'). See recipes/27-net.md §2",
};

/** Warn once per call site when `where` writes state outside the allowed places; throws when called from inside a can() */
export function guardWrite(ops, where) {
  const e = ops.engine;
  if (ops._inCan) throw devError(fmt(STRINGS.canWrote, { name: ops._inCan, where }));
  if (ops._client ? !e.ready || ops._allowDepth > 0 || where === 'world.move' : !e.ready || e._inFixed || ops._stack.length || ops._allowDepth > 0) return;
  // first caller outside the engine: skip frames in engine folders, or in the bundle file this guard itself lives in
  const lines = (new Error().stack || '').split('\n'), file = l => l.match(/\(?([^()\s]+?):\d+:\d+\)?$/)?.[1], own = file(lines[1] || '');
  // 0 Error, 1 guardWrite, 2 Ops.guard, 3 the module method that called guard, then its callers
  const at = lines.slice(4).find(l => !/\/(core|modules)\//.test(l) && file(l) !== own)?.trim() ?? '';
  const key = where + '|' + at;
  warnOnce(coded('ops-guard', fmt(ops._client ? STRINGS.clientGuard : STRINGS.guard, { where, at: at ? ', called ' + at : '' })), 'ops-guard\0' + key);   // once per call site
}
