// Fixed-step order is declared, not "which line registered first" (docs/plans/done/2026-11-02-gameplay-architecture.md §3.3, §7 step 8):
//   - onFixed({ phase: 'early' }) (default) runs before every module fixed hook, 'late' after them and before the clock
//   - the player is driven by the characters module's fixed hook, so a game callback registered before addPlayer and one registered after it read
//     the same player position (both 'early': before this step's move; both 'late': after it)
// The "no way around it" check: characters/index.js registers no engine.onFixed / onFrame of its own (player control lives in the module hooks only).
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { loopMethods } = await imp('core/engine/loop.js');
const { Engine } = await imp('core/engine/Engine.js');

export const name = 'fixed phase: onFixed early / late around module hooks, player position the same before or after addPlayer';

/** The real _fixedStep and onFixed on a minimal engine; one module hook stands in for the characters module driving the player */
function fake() {
  const e = Object.assign(Object.create(null), loopMethods, {
    onFixed: Engine.prototype.onFixed, frozen: false, tick: 0, ready: false, _elapsed: 0, uniforms: { uTime: { value: 0 } },
    _fixed: [], _fixedLate: [], _hooks: { fixed: [] }, _hookErrors: new Set(),
    input: { beginFixed() {}, endFixed() {} }, time: { _beginStep() {}, _endStep() { e.clockRan = (e.clockRan ?? 0) + 1; }, _get() {}, dt: () => 1 / 60 },
    player: { x: 0 },
  });
  e._hooks.fixed.push({ name: 'characters', mod: {}, fn: () => { e.player.x += 1; } });
  return e;
}

export async function run({ check }) {
  const e = fake(), seen = {};
  e.onFixed(() => { seen.earlyBefore = e.player.x; });                  // "registered before addPlayer"
  e.onFixed(() => { seen.lateBefore = e.player.x; }, { phase: 'late' });
  e.onFixed(() => { seen.earlyAfter = e.player.x; });                   // "registered after addPlayer"
  e.onFixed(() => { seen.lateAfter = e.player.x; seen.clockAtLate = e.clockRan ?? 0; }, { phase: 'late' });
  e._fixedStep(); e._fixedStep();
  check('early callbacks before and after addPlayer read the same (pre-move) position', seen.earlyBefore === 1 && seen.earlyAfter === 1, JSON.stringify(seen));
  check('late callbacks before and after addPlayer read the same (moved) position', seen.lateBefore === 2 && seen.lateAfter === 2, JSON.stringify(seen));
  check('late runs before the clock advances this step', seen.clockAtLate === 1, String(seen.clockAtLate));
  const h = e.onFixed(() => { seen.removed = true; }, { phase: 'late' }); h.remove(); e._fixedStep();
  check('a late handle removes like an early one', !seen.removed);
  let msg = '';
  try { e.onFixed(() => {}, { phase: 'after' }); } catch (x) { msg = x.message; }
  check('an unknown phase throws naming both phases', /'early'/.test(msg) && /'late'/.test(msg), msg);
  // guard: the characters module drives the player only through its own fixed / frame hooks
  for (const file of ['index.js', 'player.js']) {
    const src = readFileSync(join(ENGINE, 'modules/characters', file), 'utf8');
    check(`characters/${file} registers no engine.onFixed / onFrame (player control is the module hook)`, !/\be\.on(Fixed|Frame)\(/.test(src));
  }
}
