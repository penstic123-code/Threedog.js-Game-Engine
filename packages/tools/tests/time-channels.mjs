// Time channels (core/time/time.js) + mod({ for }) expiry, save / load and skip. The plan's acceptance (docs/plans/done/2026-11-02-gameplay-architecture.md §5.1, §7 steps 2-3):
//   - bullet time + haste + stopwatch + pause menu: all 24 orders of ending them give the formula's scale at every step
//   - frozen: no channel moves and no `for` runs down; a plain onFixed dt is always 1 / 60
//   - bullet time with 1.2 s left survives save -> load with 1.2 s left; skip across the end points ends them in the same order as stepping
// The "no way around it" check: clock.rate has no setter (engine.mod('clock.rate') is the one way); writing clock.now warns once.
import { fakeSaves } from './fixtures/fake-saves.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { Stacks } = await imp('core/ops/stacks.js');
const { Time, STEP } = await imp('core/time/time.js');
const { Clock } = await imp('core/time/Clock.js');
const { holdMethods, defineHoldStacks } = await imp('core/ops/holds.js');
const { loopMethods } = await imp('core/engine/loop.js');
const { defineSkipOp } = await imp('core/time/skip.js');
const { NPCManager } = await imp('modules/characters/NPC.js');
const { Sim } = await imp('modules/world/sim.js');
const { Control } = await imp('core/ops/control.js');

export const name = 'time channels: engine.mod on time / clock.rate, 24 end orders, for + save + skip';

/** A minimal engine running the real fixed step (loop.js), clock, time, stacks and the skip op. ops keeps defs by name like core/ops (modules check
 *  ops.defs.has before defining, e.g. NPCManager.setup's npc.talk), and only 'time.skip' is the skip op */
function fake() {
  const parts = {}, events = [];
  const e = Object.defineProperties({ movement: { stepHeight: 0.45 }, get tick() { return this.time._tick; }, ready: false, _hookErrors: new Set(), _fixed: [], _fixedLate: [], _hooks: { fixed: [], skip: [] }, disposed: false, _loop() {},
    uniforms: { uTime: { value: 0 } }, input: { beginFixed() {}, endFixed() {}, endFrame() {} },
    saves: fakeSaves((k, p) => { parts[k] = p; }),
    events: { emit: (n, d) => events.push([n, d]), on: () => ({ remove() {} }) },
    ops: { defs: new Map(), define: (n, d) => { e.ops.defs.set(n, d); if (n === 'time.skip') e._skipOp = d; } } }, { ...Object.getOwnPropertyDescriptors(loopMethods), ...Object.getOwnPropertyDescriptors(holdMethods) });   // descriptors: spreading holdMethods itself would run its getters
  e.stacks = new Stacks(e); e.stacks._hook(); e.mod = (n, o) => e.stacks.mod(n, o);
  e.clock = new Clock(e); e.time = new Time(e);
  e.session = { captured: false, _untrack(h) { return h; } };
  e.control = new Control(e);   // NPC behaviors run through the character control slot (core/ops/control.js)
  defineHoldStacks(e);   // the engine's own hold stacks (halt does the loop side effect itself)
  defineSkipOp(e);
  e.onFixed = (fn, { channel } = {}) => { e._fixed.push(channel ? () => fn(e.time.dt(channel)) : fn); };   // same as Engine.onFixed
  e.steps = n => { for (let i = 0; i < n; i++) e._fixedStep(); };
  e.save = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p.save()]))));
  e.load = d => { for (const [k, p] of Object.entries(parts)) p.load(d[k]); };
  e.skip = seconds => e._skipOp.run(e, { seconds });
  return Object.assign(e, { log: events });
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
function perms(a) { return a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p])); }

export async function run({ check }) {
  // ---- §5.1: bullet time + haste + stopwatch + pause menu, every end order ----
  let bad = 0, firstBad = '';
  const orders = perms(['bullet', 'haste', 'stopwatch', 'menu']);
  for (const order of orders) {
    const e = fake(); e.time.channel('enemies');
    const h = {
      bullet: e.mod('time.enemies', { owner: 'bullet-time', mul: 0.35 }),
      haste: e.mod('time.player', { owner: 'haste', mul: 1.2 }),
      stopwatch: e.mod('time.local', { owner: 'stopwatch', id: 'e1', set: 0, layer: 'effect' }),
      menu: e.mod('freeze', { owner: 'pause-menu' }),
    };
    const on = { bullet: true, haste: true, stopwatch: true, menu: true };
    const expect = () => ({ player: on.haste ? 1.2 : 1, e1: (on.bullet ? 0.35 : 1) * (on.stopwatch ? 0 : 1), e3: on.bullet ? 0.35 : 1 });
    const look = () => {
      const x = expect(), t = e.time;
      const now0 = { p: t.now('player'), en: t.now('enemies') };
      e.steps(6);
      const moved = { p: t.now('player') - now0.p, en: t.now('enemies') - now0.en };
      const ok = near(t.scale('player'), x.player) && near(t.scale('enemies', 'e1'), x.e1) && near(t.scale('enemies', 'e3'), x.e3)
        && e.frozen === on.menu && (on.menu ? moved.p === 0 && moved.en === 0 : near(moved.p, 6 * STEP * x.player) && near(moved.en, 6 * STEP * x.e3));
      if (!ok && !bad++) firstBad = `${order.join('>')} on=${JSON.stringify(on)} got player ${t.scale('player')} e1 ${t.scale('enemies', 'e1')} e3 ${t.scale('enemies', 'e3')} frozen ${e.frozen}`;
    };
    look();
    for (const k of order) { h[k].remove(); on[k] = false; look(); }
  }
  check(`all ${orders.length} end orders of bullet time / haste / stopwatch / pause menu give the formula at every step`, bad === 0 && orders.length === 24, firstBad);

  // ---- frozen: nothing moves, nothing runs down; a plain onFixed dt is real seconds ----
  {
    const e = fake(); e.time.channel('enemies');
    const dts = [], edts = [];
    e.onFixed(dt => dts.push(dt)); e.onFixed(dt => edts.push(dt), { channel: 'enemies' });
    e.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });
    e.steps(30);
    const left0 = e.stacks.get('time.enemies').holders()[0].left, en0 = e.time.now('enemies'), cal0 = e.clock.now;
    const f = e.freeze('menu'); e.steps(120); f.remove();
    const left1 = e.stacks.get('time.enemies').holders()[0].left;
    check('frozen: channels, calendar and the for timer all stand still', near(left0, left1) && e.time.now('enemies') === en0 && e.clock.now === cal0, `${left0} ${left1}`);
    check('onFixed without channel gets 1 / 60 every step, with { channel } the scaled dt', dts.length === 30 && dts.every(d => d === 1 / 60) && edts.every(d => near(d, 0.35 / 60)));
    // the calendar is world seconds x rate
    e.mod('clock.rate', { owner: 'game', set: 60 }); const c0 = e.clock.now; e.steps(60);
    check('clock.rate set 60: a real second is 60 calendar seconds', near(e.clock.now - c0, 60, 1e-6) && e.clock.rate === 60);
    e.mod('time.world', { owner: 'slow-mo', mul: 0.5 }); const c1 = e.clock.now, p1 = e.time.now('player'); e.steps(60);
    check('the world channel slows the calendar and every child channel', near(e.clock.now - c1, 30, 1e-6) && near(e.time.now('player') - p1, 0.5, 1e-6));
    const code = fn => { try { fn(); return 'no throw'; } catch (x) { return x.code + ' ' + x.message; } };
    check('clock.rate is read-only: a write throws with the mod form and changes nothing', /^mod-owner .*engine\.mod\('clock\.rate'/.test(code(() => { e.clock.rate = 2; })) && e.clock.rate === 60, code(() => { e.clock.rate = 2; }));
  }

  // ---- for: expiry, save / load, skip ----
  {
    const e = fake(); e.time.channel('enemies');
    e.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });
    e.steps(48);   // 0.8 real seconds
    const saved = e.save();
    const e2 = fake(); e2.time.channel('enemies'); e2.steps(17);   // a different playthrough, other clocks
    e2.load(saved);
    const left = e2.stacks.get('time.enemies').holders()[0]?.left;
    check('bullet time with 1.2 s left: save -> load -> 1.2 s left', near(left, 1.2, 1e-9), String(left));
    e2.steps(71); const still = e2.stacks.get('time.enemies').size();
    e2.steps(1); const gone = e2.stacks.get('time.enemies').size();
    check('... and it ends on the same step as without the load (72 steps later)', still === 1 && gone === 0 && e2.log.filter(([n]) => n === 'mod:end').length === 1);
    // channel-clocked for: a slow measured in enemy seconds runs down slower in bullet time
    const e3 = fake(); e3.time.channel('enemies');
    e3.mod('time.enemies', { owner: 'bullet-time', mul: 0.5 });
    e3.mod('time.local', { owner: 'status:slow', id: 'e3', mul: 0.5, for: 1, clock: 'enemies' });
    e3.steps(119); const s1 = e3.stacks.get('time.local').size('e3'); e3.steps(1);
    check('for on a channel clock counts channel seconds (1 enemy second at 0.5 = 2 real seconds)', s1 === 1 && e3.stacks.get('time.local').size('e3') === 0);
    // channel timer: clock.after(..., { channel })
    let fired = 0; e3.clock.after(1, () => fired++, { channel: 'enemies' });
    e3.steps(119); const f1 = fired; e3.steps(1);
    check('clock.after(s, fn, { channel }) fires after s channel seconds', f1 === 0 && fired === 1);
    // skip == stepping: the same mod:end events in the same order, the same clocks
    const setup = () => {
      const x = fake(); x.time.channel('enemies');
      x.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 });
      x.mod('time.player', { owner: 'haste', mul: 1.2, for: 5 });
      x.mod('time.local', { owner: 'status:slow', id: 'e3', mul: 0.5, for: 1.5, clock: 'enemies' });
      x.clock.after(4, 'poison:tick', { data: { id: 'e3' }, channel: 'enemies' });
      return x;
    };
    const A = setup(); A.steps(600);
    const B = setup(); B.skip(10);
    const ends = x => x.log.filter(([n]) => n === 'mod:end' || n === 'poison:tick').map(([n, d]) => d.owner ?? n);
    check('skip({ seconds }) across the end points ends them in the same order as stepping', ends(A).join() === ends(B).join() && ends(A).length === 4, `${ends(A)} | ${ends(B)}`);
    check('... and every clock lands at the same time', near(A.clock.now, B.clock.now, 1e-4) && near(A.time.now('enemies'), B.time.now('enemies'), 0.02) && near(A.time.now('player'), B.time.now('player'), 0.02),
      `${A.time.now('enemies')} vs ${B.time.now('enemies')}, ${A.time.now('player')} vs ${B.time.now('player')}`);
  }
  { // clock.now has one way to move it: engine.skip. It is a view of the time source, so a direct write throws and names that way
    const e = fake();
    let msg = '';
    try { e.clock.now = 50; } catch (err) { msg = String(err?.message); }
    check('clock.now = x: throws, unchanged, the error names engine.skip({ seconds })',
      e.clock.now === 0 && msg.includes('engine.clock.now was written directly') && msg.includes('engine.skip({ seconds })'), msg);
  }
  { // npcs.add({ channel }): a far NPC (data only) walks by its channel's dt, so bullet time on 'enemies' slows it while far too
    const e = fake(); e.time.channel('enemies', { parent: 'world' });
    let sim = null;
    e.world = { present() {}, simulate: (k, o) => { sim = o; }, view: () => null, move: (id, p) => Object.assign(recs[id].position, p), zone: null, inZone: () => true };
    e.surface = () => 0; e.events.traceSize = 0;
    const npcs = new NPCManager(e, { track: h => h, ops: e.ops }); npcs.setup();
    const rec = (id, look) => ({ id, behavior: 'schedule', look, schedule: [{ at: 0, x: 100, z: 0 }], position: { x: 0, y: 0, z: 0 }, speed: 2,
      nav: {}, arriveDistance: 1, mind: {} });
    const recs = { a: rec('a', { channel: 'enemies' }), b: rec('b', {}) };
    e.mod('time.enemies', { owner: 'bullet-time', mul: 0.25 });
    const viaSim = (r, dt) => sim.far(r, new Sim({ engine: e }).scaled(sim, r, dt));   // what world.simulate hands far
    viaSim(recs.a, 2); viaSim(recs.b, 2);
    check("far NPC on channel 'enemies' at 0.25: walks a quarter as far as one on 'world'", near(recs.a.position.x, 1) && near(recs.b.position.x, 4),
      `${recs.a.position.x} / ${recs.b.position.x}`);
  }
  { // world.simulate(kind, { channel }): far turns and the skip catch-up hand far the channel's dt; without channel dt stays real seconds
    const e = fake(); e.time.channel('enemies');
    const w = { engine: e, farMaxPerTick: 1e9, farEvery: STEP, radius: 60, _cells: { forEach() {} }, inZone: () => true, _v: { presenters: new Map() }, view: () => null };
    const S = new Sim(w), slime = { id: 's', kind: 'slime', t: 0 }, crop = { id: 'c', kind: 'crop', t: 0 };
    S.simulate('slime', { far: (r, dt) => { r.t += dt; }, channel: 'enemies' });
    S.simulate('crop', { far: (r, dt) => { r.t += dt; } });
    S.added(slime); S.added(crop);
    e.mod('time.enemies', { owner: 'bullet-time', mul: 0.5 });
    e.time.onMove(() => S.moved());
    for (let i = 0; i < 60; i++) { S.fixed(STEP, { x: 0, z: 0 }); e.time._endStep(); }   // a debt is read off the channels, so they move as in a real step
    S.skip(2, true);
    let threw = '';
    try { S.simulate('x', { far() {}, channel: 3 }); } catch (err) { threw = err.message; }
    check("world.simulate({ channel: 'enemies' }) at 0.5: far gets half the seconds (steps and skip); a kind without channel gets real seconds; a bad channel throws",
      near(slime.t, 1.5, 1e-6) && near(crop.t, 3, 1e-6) && threw.includes('time channel name'), `${slime.t} / ${crop.t} / ${threw}`);
  }
}
