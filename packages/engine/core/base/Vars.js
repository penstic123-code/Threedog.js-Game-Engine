// Story flags and counters, engine.vars (saved automatically under the save key vars):
//   engine.vars.setFlag('metBaker');  engine.vars.flag('metBaker')   // true
//   engine.vars.bump('fish', 2);      engine.vars.counter('fish')    // 2
// Dialogue state.flags and quest counter/bump all point here. Writes go through the ops guard (dev): outside loading, fixed steps and ops they are reported. Loading replaces the contents in place; the flags / counters objects themselves stay the same.

import { DEV } from './validate.js';
import { codedError } from './errorHints.js';
import { saveValues } from './saveValues.js';

export class Vars {
  constructor(engine) {
    this.engine = engine;
    this.flags = Object.create(null);      // no prototype: a flag or counter named 'constructor' is unset like any other name
    this.counters = Object.create(null);
    engine.saves.define('vars', {
      atomic: true,
      save: () => ({ flags: { ...this.flags }, counters: { ...this.counters } }),   // copy: save data must not share objects with the live state
      load: d => {
        const v = saveValues('vars'), counters = d?.counters && Object.fromEntries(Object.entries(d.counters).filter(([k, n]) => Number.isFinite(n) || (v.drop(`counters.${k}`, n), false)));
        v.done();
        this.replace(d?.flags, counters);
      },
    });
  }
  /** Read a flag */
  flag(k) { return this.flags[k]; }
  /** Set a flag (default true) */
  setFlag(k, v = true) { DEV && this.engine.ops.guard('vars.setFlag'); this.flags[k] = v; }
  /** Read a counter (0 if absent) */
  counter(k) { return this.counters[k] ?? 0; }
  /** Add n to a counter (default 1) and return the new value */
  bump(k, n = 1) {
    DEV && this.engine.ops.guard('vars.bump');
    if (!Number.isFinite(n)) throw codedError('engine-misuse', `vars.bump('${k}', n): n must be a finite number, got ${String(n)}`);
    return (this.counters[k] = this.counter(k) + n);
  }
  /** @internal Replace wholesale (for loading and net sync); a kind passed as undefined stays unchanged */
  replace(flags, counters) {
    DEV && this.engine.ops.guard('vars.replace');
    // same object: already it, skip (clearing first would lose the data). Own keys only, never "__proto__": a save must not swap the prototype
    const set = (o, v) => { if (o === v) return; for (const k of Object.keys(o)) delete o[k]; for (const k of Object.keys(v || {})) if (k !== '__proto__') o[k] = v[k]; };
    if (flags !== undefined) set(this.flags, flags);
    if (counters !== undefined) set(this.counters, counters);
  }
}
