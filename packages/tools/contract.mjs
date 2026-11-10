// The shared contract check (docs/plans/done/2026-11-02-gameplay-architecture.md §1.3): one test that the engine's module and any replacement both run,
// so "can I swap the inventory for my own" has a yes / no answer instead of a guess. It runs on a small Node engine (harness below: the real events,
// ops, stacks / freeze, engine.wrap; stand-ins for input, UI, i18n, audio, saves) so it needs no browser. Works in a game installed from npm:
//   import { runContract } from '@threedog/tools/contract';
//   import contract from 'threedog/modules/gameplay/inventory.contract.js';
//   await runContract(contract, () => myInventory(contract.options), { check });       // check(label, ok, detail?) from your test runner
//   await runContract(cameraContract, () => myCamera(), { check, prepare: e => { e.camera = ... } })   // prepare: add what your module needs to the small engine
// An object contract (kind: 'object', e.g. characters/vehicle.contract.js) checks one object instead: runContract(contract, () => myBoat, { check }).
// Order: install -> name -> api methods -> fields (properties other modules read) -> resolves (characters: control can find a character) -> ops defined and listed -> saves registered with their versions -> probe setup -> each probe event fires ->
//   describe answers -> engine.wrap goes around an api method -> a probed value survives save -> a fresh install -> load -> (probe.copy) and a read -> write into a fresh install
// What it deliberately does not check: behaviour beyond the contract (stack sizes, UI colors): those are the module's own tests.
// The engine core parts come from the installed threedog package (found like every other tool: paths.mjs ENGINE), not a copy.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './paths.mjs';

const core = f => import(pathToFileURL(join(ENGINE, 'core', f)).href);
const [{ Events }, { Ops }, { Stacks }, { defineHoldStacks, holdMethods }, { Wraps }, { Control }, { Saves }, { readSave }, { partData }, { StateReplace }, { syncOnly, isThenable }] =
  await Promise.all(['base/Events.js', 'ops/Ops.js', 'ops/stacks.js', 'ops/holds.js', 'ops/wrap.js', 'ops/control.js', 'saves/Saves.js', 'saves/saveVersions.js', 'saves/saveApply.js', 'saves/stateReplace.js', 'base/validate.js'].map(core));

// The save parts go through the real Saves.define (no storage behind it: save() does nothing), so a part the engine refuses (a key taken twice, a field it
// does not know, a bad first or version) is refused here too. A copy of those checks would drift from the engine and pass a module that engine.use() throws on.
const contractSaves = e => Object.assign(Object.create(Saves.prototype), { engine: e, providers: new Map(), _foreign: { parts: {}, versions: {} }, _replace: new StateReplace(e), save() {} });

/** A minimal engine with the real core parts a gameplay module talks to; everything with a screen is a stand-in that records calls */
export function contractEngine() {
  const e = Object.defineProperties({
    headless: true, ready: true, disposed: false, halted: false, tick: 0, actor: 'player', modules: new Map(), _loop() {},
    events: new Events(),
    i18n: { add() {}, t: k => k, has: () => false },
    audio: { register() {}, sfx() {}, condition() {}, measure() {} },
    clock: { speed: 1, rate: 1, now: 0 },
    // the time source's move hook: views of a channel (the calendar's day) update and fire their events here; '__step' moves clock.now and calls it
    time: { _onMove: [], onMove(fn) { this._onMove.push(fn); return { remove: () => { this._onMove = this._onMove.filter(f => f !== fn); } }; } },
    // asset name table: modules register built-in assets in install (characters' 'footstep' synthesized sound, builtInSounds writes entries), and a real engine always has engine.assets
    assets: { entries: new Map() },
    input: { actions: new Map(), define(a, o) { this.actions.set(a, o ?? {}); return { name: a, remove() {} }; }, bind: () => ({ owner: 'game', remove() {} }), keysOf: () => [], isUnbound: () => false, touchButton() {}, pressed: () => false, pressedRaw: () => false, down: () => false,
      push: name => ({ name, remove() {} }), axis: { x: 0, y: 0 }, padStick: { x: 0, y: 0 }, label: () => '' },
    ui: { define() {}, get: () => null, create: () => null, set() {}, templates: {}, isOpen: () => false, open() {}, close() {}, refresh() {} },
    movement: { radius: 0.3, stepHeight: 0.4, slopeRatio: 1 },
    session: { id: 1, _late() {} }, _things: { sources: [], source: () => null },
    t: k => k, onFixed: () => ({ remove() {} }), onFrame: () => ({ remove() {} }),
  }, Object.getOwnPropertyDescriptors(holdMethods));
  e.saves = contractSaves(e);
  e.ops = new Ops(e);
  e.stacks = new Stacks(e); e.mod = (n, o) => e.stacks.mod(n, o); defineHoldStacks(e);
  e._wraps = new Wraps(e); e.wrap = (t, m, fn, o) => e._wraps.wrap(t, m, fn, o);
  e.control = new Control(e);   // who drives each character (characters installs on it)
  return e;
}

// ['__step', seconds]: time passes: the calendar channel moves (onMove listeners run, as core/time/time.js does) and the module's fixed(dt) hook runs,
// for contracts whose events come from time passing (calendar day:start)
const step = (mod, e, dt) => { e.clock.now += dt; for (const fn of [...e.time._onMove]) fn(); mod.fixed?.(dt, e); };
const callOn = (api, [m, ...args], mod, e) => m === '__step' ? step(mod, e, args[0]) : api[m](...args);
// state.read: a method call ['count', 'fish'] or a property name ('day')
const readOf = (api, read) => typeof read === 'string' ? api[read] : callOn(api, read);

/**
 * Run the contract against one implementation. makeModule() returns a module definition ({ name, install(e), describe? }); it is called twice
 * (the save / load round trip installs a fresh one). check(label, ok, detail?) is the test runner's.
 * @param {any} contract @param {() => any} makeModule @param {{ check: (label: string, ok: boolean, detail?: string) => void, label?: string }} o
 */
/** The ctx a module gets on the contract engine: the real verbs, with nothing to own because that engine never uninstalls */
export const contractCtx = (e, name) => ({
  name, track: h => h, feeds: () => ({ remove() {} }), rule: (n, def, names) => e.stacks.rule(n, def, names), input: { define: (a, o) => e.input.define(a, o), bind: (a, k) => e.input.bind(a, k) },
  ops: e.ops, saves: e.saves, ui: e.ui, stream: e.stream, budget: e.budget,
  things: { addSource() {}, explainWith() {} }, ground: { provide: g => e.setGround(g), addColliders() {} },
});

/** A contract's position statement (design.md section 9): the row of that table it falls under, and each writer by name with what it may do */
function checkPosition({ position }, label, check) {
  if (!position) return;
  const { authority, writers } = position;
  const said = Object.values(Object(writers));
  check(`${label}: position names its authority and its writers`, ['record', 'solver', 'physics', 'view'].includes(authority) && said.length > 0 && said.every(w => typeof w === 'string' && w), JSON.stringify(position));
}

export async function runContract(contract, makeModule, { check, label = contract.name, prepare = null }) {
  checkPosition(contract, label, check);
  if (contract.kind === 'object') return runObjectContract(contract, makeModule, { check, label });
  const install = () => {
    const e = contractEngine(); prepare?.(e);
    const mod = makeModule(), nobody = e.control.characterOf;
    const api = mod.install(e, contractCtx(e, mod.name));
    syncOnly(api, `install() of module ${mod.name}`, true);   // the engine's own check (core/engine/modules.js): engine.use() refuses an install that returns a Promise
    e[mod.name] = api; e.modules.set(mod.name, mod);
    for (const c of contract.probe?.setup ?? []) callOn(api, c);
    return { e, mod, api, nobody };
  };
  const t = (what, ok, detail) => check(`${label}: ${what}`, !!ok, detail);
  let first;
  try { first = install(); } catch (err) { t('installs on the contract engine', false, err.message); return; }
  const { e, mod, api, nobody } = first;
  t(`module name is '${contract.name}'`, mod.name === contract.name, mod.name);
  const missing = contract.api.filter(m => typeof api?.[m] !== 'function');
  t(`api has ${contract.api.join(', ')}`, !missing.length, `missing: ${missing.join(', ')}`);
  if (contract.fields) {
    const noField = contract.fields.filter(f => !(f in Object(api)));
    t(`fields ${contract.fields.join(', ')}`, !noField.length, `missing: ${noField.join(', ')}`);
  }
  if (contract.resolves) t('answers control.characterOf (engine.control.resolveWith at install)', e.control.characterOf !== nobody);
  for (const m of contract.directions ?? []) {
    let v = null; try { v = api[m](); } catch (err) { v = err.message; }
    t(`${m}() is a unit { x, z } on the ground plane`, v && Number.isFinite(v.x) && Number.isFinite(v.z) && Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-3, JSON.stringify(v));
  }
  const listed = new Set(e.ops.list().map(o => o.name)), noOp = contract.ops.filter(n => !listed.has(n));
  t(`defines ops ${contract.ops.join(', ') || '(none)'}`, !noOp.length, `missing: ${noOp.join(', ')}`);
  const reg = e.saves.providers, badSave = Object.entries(contract.saves).filter(([k, v]) => (reg.get(k)?.version ?? 1) !== v || !reg.has(k));
  t(`registers saves ${JSON.stringify(contract.saves)}`, !badSave.length, `wrong or missing: ${badSave.map(([k]) => `${k} (version ${reg.get(k)?.version})`).join(', ')}`);
  for (const [ev, call] of contract.probe?.emits ?? []) {
    let fired = 0; const h = e.events.on(ev, () => fired++);
    try { callOn(api, call, mod, e); } catch (err) { t(`${call[0]}() runs`, false, err.message); }
    h.remove?.(); t(`${call[0]}(${call.slice(1).map(a => JSON.stringify(a)).join(', ')}) fires ${ev}`, fired > 0);
  }
  if (contract.describe) {
    let out = 'threw';
    try { out = typeof mod.describe === 'function' ? mod.describe(e, { center: { x: 0, z: 0 }, radius: 30, near() {}, out: {} }) : 'no describe(e, ctx)'; } catch (err) { out = err.message; }
    t('describe(e, ctx) answers (an object or nothing)', out === undefined || (out !== null && typeof out === 'object'), String(out));
  }
  // engine.wrap is the same for every implementation: going around the first api method sees the call and passes it on
  const m = contract.api[0]; let seen = 0;
  const w = e.wrap(api, m, (next, ...a) => { seen++; return next(...a); }, { owner: 'contract' });
  try { callOn(api, contract.probe?.setup?.find(c => c[0] === m) ?? [m]); } catch { /* the call's own args may not suit: only the wrap is checked */ }
  w.remove();
  t(`engine.wrap(${contract.name}, '${m}') goes around it`, seen === 1);
  const st = contract.probe?.state;
  if (st) {
    // st.map: turn what was read into a comparable plain value (a camera's mode name out of its describe(), say)
    const read = a => st.map ? st.map(readOf(a, st.read)) : readOf(a, st.read);
    const before = read(api), what = typeof st.read === 'string' ? st.read : `${st.read[0]}(${st.read.slice(1).join(', ')})`;
    t(`${what} is ${st.expect} after the probe calls`, before === st.expect, String(before));
    // the save as the engine writes it (partData: what a part may save; nothing to save = left out), then read back by the engine's readSave: the load order by first, the
    // version steps. A part's load may return a Promise and later parts wait for it, as saves.load does, so a part that needs another one loaded first is tested as it runs
    const parts = {}, versions = {};
    for (const [k, p] of reg) { const d = partData(k, p); if (d != null) { parts[k] = JSON.parse(JSON.stringify(d)); versions[k] = p.version; } }
    const fresh = install();
    fresh.e.clock.now = first.e.clock.now;   // the engine's time source is in every save (core/time/time.js part): the fresh engine resumes at the saved second
    const back = readSave({ parts, versions }, fresh.e.saves.providers, 'contract');
    let after;
    if (back.list) try { for (const [, p, d] of back.list) { const r = p.load(d); if (isThenable(r)) await r; } after = read(fresh.api); } catch (err) { after = err.message; }
    else after = back.dev;
    t('the value survives save -> fresh install -> load', after === st.expect, String(after));
    // probe.copy: what one install reads (contents()) written into a fresh one (setContents) gives the same value: the net host -> client path
    const cp = contract.probe.copy;
    if (cp) {
      const copy = install(); let got;
      try { copy.api[cp.write](JSON.parse(JSON.stringify(callOn(api, cp.read)))); got = read(copy.api); } catch (err) { got = err.message; }
      t(`${cp.read[0]}() written into a fresh install with ${cp.write}() keeps ${what} = ${st.expect}`, got === st.expect, String(got));
    }
  }
}

/** An object contract (kind: 'object'): methods are functions, fields exist, points() return finite { x, y, z }, every method runs once without throwing */
function runObjectContract(contract, makeObject, { check, label }) {
  const t = (what, ok, detail) => check(`${label}: ${what}`, !!ok, detail);
  let o;
  try { o = makeObject(); } catch (err) { t('builds', false, err.message); return; }
  const missing = contract.api.filter(m => typeof o?.[m] !== 'function');
  t(`has methods ${contract.api.join(', ')}`, !missing.length, `missing: ${missing.join(', ')}`);
  const noField = (contract.fields ?? []).filter(k => !(o && k in o));
  t(`has fields ${(contract.fields ?? []).join(', ')}`, !noField.length, `missing: ${noField.join(', ')}`);
  for (const [k, ok] of Object.entries(contract.optional ?? {})) if (o?.[k] !== undefined) t(`${k} (optional) is valid`, ok(o[k]), JSON.stringify(o[k]));
  // points take a seat index (vehicle: 0 = driver): every seat the object says it has must give a point
  const seats = Number.isInteger(o?.seats) && o.seats > 0 ? o.seats : 1;
  for (const m of contract.points ?? []) for (let s = 0; s < seats; s++) {
    let v = null; try { v = o[m](s); } catch (err) { v = err.message; }
    t(`${m}(${s}) returns a world point { x, y, z }`, v && ['x', 'y', 'z'].every(k => Number.isFinite(v[k])), JSON.stringify(v));
  }
  for (const k of contract.numbers ?? []) t(`${k} is a number`, Number.isFinite(o?.[k]), String(o?.[k]));
  for (const [m, ...args] of contract.calls ?? []) {
    let ran = true; try { o[m](...args); } catch (err) { ran = err.message; }
    t(`${m}(${args.join(', ')}) runs`, ran === true, String(ran));
  }
}
