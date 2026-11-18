// R8 single source of event names: interface EventMap in packages/engine/types/core.d.ts is the only event table.
//   ✗ a name in xxx.events.emit('name') in the engine that is not in EventMap (packages/engine/docs/api/events.md cannot list it, and game listeners get no completion or argument types) → error
//   ! an event in EventMap that nothing in the engine emits (a dead event, or a misspelled name) → warning
//   ✗ an EventMap key that is not noun:action (/^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z]*$/, e.g. 'save' or 'load' alone) → error
// Criteria: the syntax tree is searched for `<…events>.emit(first argument)`; the argument counts if it is a string literal, or `cond ? 'a' : 'b'` with both sides literals.
// Limitation: names held in variables (such as the { event: name } timed events of clock) are not found; those names come from the game anyway.
import { ts, parse, visit, engineFiles, lineOf, strValue, dtsFiles, P } from './_lib.mjs';

// Allowlist: [event name, reason]
const ALLOW_UNDECLARED = [];
const ALLOW_UNEMITTED = [['op:rolledBack', 'emitted through a local alias of events (ev.emit in core/ops/opsAtomic.js), which the events.emit search does not see']];

/** EventMap keys → line numbers (whichever d.ts holds interface EventMap) */
function eventMap() {
  for (const f of dtsFiles()) {
    const sf = parse(f);
    for (const s of sf.statements) if (ts.isInterfaceDeclaration(s) && s.name.text === 'EventMap')
      return { file: f, keys: new Map(s.members.filter(m => m.name).map(m => [m.name.text ?? m.name.getText().replace(/['"]/g, ''), lineOf(m)])) };
  }
  return null;
}

const literalNames = n => {
  const v = strValue(n);
  if (v != null) return [v];
  if (n && ts.isConditionalExpression(n)) { const a = strValue(n.whenTrue), b = strValue(n.whenFalse); if (a != null && b != null) return [a, b]; }
  if (n && ts.isParenthesizedExpression(n)) return literalNames(n.expression);
  return null;
};

export default {
  id: 'R8', title: 'Single source of event names',
  run() {
    const out = [], map = eventMap();
    if (!map) return [{ level: 'error', file: P.CORE_DTS_REL, line: 0, msg: 'interface EventMap not found', fix: 'declare EventMap in the d.ts (event name → arguments)' }];
    const emitted = new Map();   // name → where it first appears
    for (const f of engineFiles()) {
      visit(parse(f), n => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'emit') return;
        const recv = n.expression.expression.getText();
        if (!/(^|\.)events$/.test(recv)) return;            // only the event bus counts (particles.emit and the like are not events)
        const names = literalNames(n.arguments[0]);
        if (!names) return;
        for (const name of names) {
          if (!emitted.has(name)) emitted.set(name, `${f}:${lineOf(n)}`);
          if (!map.keys.has(name) && !ALLOW_UNDECLARED.some(([a]) => a === name))
            out.push({ level: 'error', file: f, line: lineOf(n), msg: `emits event '${name}', but it is not in EventMap in ${map.file}`,
              fix: `add a line '${name}': [args…] to EventMap with a doc comment (packages/engine/docs/api/events.md is generated from it, then npm run map)` });
        }
      });
    }
    for (const [name, line] of map.keys) if (!/^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z]*$/.test(name))
      out.push({ level: 'error', file: map.file, line, msg: `event '${name}' is not noun:action`,
        fix: 'name it <emitter noun>:<lowercase verb or state> (save:written, save:loaded, engine:ready); see .claude/rules/api-design.md' });
    for (const [name, line] of map.keys) {
      if (emitted.has(name) || ALLOW_UNEMITTED.some(([a]) => a === name)) continue;
      out.push({ level: 'warn', file: map.file, line, msg: `EventMap has '${name}', but nothing in the engine calls events.emit('${name}')`,
        fix: 'find out who should emit it; if nobody does, delete it from EventMap (or the name differs at the emit site)' });
    }
    return out;
  },
};
