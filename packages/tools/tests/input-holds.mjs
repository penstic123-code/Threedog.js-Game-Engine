// Who holds input, in one place (docs/plans/done/2026-11-02-gameplay-architecture.md §2.6, §7 step 9):
//   - input.push(name, { owner }) records the owner; input.holders lists [{ context, owner, pass }]; runState.blockedBy reads it (public API)
//   - input.gate(action, owner) closes one action while anyone holds it (the 'input.gate' stack: only the owner opens it, { for } ends it)
//   - describe().holds lists halt / freeze / camera / input / gates / other stacks with their owners
// The "no way around it" checks: nothing outside the input files reads input._stack; describe has no second "held by" list (time.heldBy, ui.inputContexts).
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { Stacks } = await imp('core/ops/stacks.js');
const { Time, STEP } = await imp('core/time/time.js');
const { defineHoldStacks, holdMethods } = await imp('core/ops/holds.js');
const { Input } = await imp('core/input/Input.js');
const { initContexts, applyContexts } = await imp('core/input/inputContext.js');
const { describeHolds: holds } = await imp('core/ops/holds.js');   // the function describe().holds calls

export const name = 'input holds: push({ owner }), input.gate, describe().holds lists every holder';

function fake() {
  const e = Object.defineProperties({ halted: false, disposed: false, ready: true, _loop() {}, saves: { define() {} }, clock: { rate: 1, _advance() {} },
    events: { emit() {}, on: () => ({ remove() {} }) } }, Object.getOwnPropertyDescriptors(holdMethods));
  e.stacks = new Stacks(e); e.mod = (n, o) => e.stacks.mod(n, o); e.time = new Time(e); defineHoldStacks(e);
  e.stacks.define('input.gate', { kind: 'any', per: true });   // as services.js does
  // the real Input methods without its DOM listeners: one action 'jump' on Space, held this frame
  const inp = Object.create(Input.prototype);
  Object.assign(inp, { engine: e, actions: new Map(), _touchKeys: new Map(), keys: new Set(['Space', 'KeyJ']), _accP: new Set(), _accR: new Set(), _inFixed: false, seats: [] });
  inp._keys = e.stacks.define('input.keys', { kind: 'value', per: true, save: false, settingsSet: true });   // as Input's constructor does
  inp.bind({ jump: ['Space'], attack: ['KeyJ'] });
  inp._live = { keys: inp.keys, pressed: new Set(['Space', 'KeyJ']), released: new Set() };
  initContexts(inp); e.input = inp;
  return e;
}

export async function run({ check }) {
  const e = fake(), inp = e.input;
  check('an open action reads', inp.pressed('jump') && inp.down('jump'));
  const stun = inp.gate('jump', { owner: 'stun', for: 0.5 }), tut = inp.gate('jump', 'tutorial');
  check('gated: jump reads as not pressed / down, attack still reads', !inp.pressed('jump') && !inp.down('jump') && inp.pressed('attack'));
  tut.remove();
  check('one owner opening it is not enough while another holds it', !inp.pressed('jump'));
  for (let i = 0; i < 31; i++) (e.time._beginStep(), e.time._endStep());
  check('{ for: 0.5 } ends by itself: jump reads again', inp.pressed('jump'), String(e.stacks.get('input.gate').names('jump')));
  stun.remove();   // already ended: a no-op
  const g2 = inp.gate('attack', 'cutscene');
  const shop = inp.push('menu', { owner: 'shop' }), car = inp.push('vehicle', { pass: true }); applyContexts(inp);
  e.freeze('flow');
  const h = holds(e);
  check('holds.input lists contexts with owners (default owner = name)', JSON.stringify(h.input) === JSON.stringify([{ context: 'menu', owner: 'shop', pass: false }, { context: 'vehicle', owner: 'vehicle', pass: true }]), JSON.stringify(h.input));
  check('holds.gates lists gate owners by action', JSON.stringify(h.gates) === JSON.stringify({ attack: ['cutscene'] }), JSON.stringify(h.gates));
  check('holds.freeze lists the freeze owner', h.freeze?.[0]?.owner === 'flow', JSON.stringify(h.freeze));
  check('runState.blockedBy names the opaque context (read through input.holders)', e.runState.blockedBy.includes('menu') && !e.runState.blockedBy.includes('vehicle'), JSON.stringify(e.runState.blockedBy));
  // a halted page may not step for a long time: the status line said a closed window was open, and did not know a new one
  const closing = inp.push('win-results'); applyContexts(inp); closing.remove();
  check('[guard] a removed context stops holding at once, before the next fixed step applies it', !e.runState.blockedBy.includes('win-results') && !inp.enabled, JSON.stringify(e.runState.blockedBy));
  const opening = inp.push('win-new');
  check('[guard] a pushed context holds at once in the report', e.runState.blockedBy.includes('win-new'), JSON.stringify(e.runState.blockedBy));
  opening.remove(); applyContexts(inp);
  e.mod('time.world', { owner: 'bullet-time', mul: 0.35 });
  check('other engine.mod points are in describe().shared, not holds', !('stacks' in holds(e)) && e.stacks.describe()['time.world']?.also[0]?.owner === 'bullet-time', JSON.stringify(e.stacks.describe()));
  g2.remove(); shop.remove(); car.remove(); applyContexts(inp); e.stacks.get('freeze').release('flow');
  check('nothing held: holds has no input / gates / freeze', !('input' in holds(e)) && !('gates' in holds(e)) && !('freeze' in holds(e)), JSON.stringify(holds(e)));
  let msg = ''; try { inp.push('x', { owner: '' }); } catch (x) { msg = x.message; }
  check('push with an empty owner throws with an example', /owner: 'shop-menu'/.test(msg), msg);
  // guards
  const files = [];
  const walk = d => { for (const f of readdirSync(join(ENGINE, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p); } };
  for (const d of ['core', 'modules', 'ui', 'render']) walk(d);
  const readers = files.filter(f => !/core\/input\/(Input|inputContext)\.js$/.test(f) && /input\._stack\b/.test(readFileSync(join(ENGINE, f), 'utf8')));
  check('nothing outside Input.js / inputContext.js reads input._stack', !readers.length, readers.join(', '));
  const desc = readFileSync(join(ENGINE, 'core/inspect/Describe.js'), 'utf8');
  check('describe has one holder list (no time.heldBy, no ui.inputContexts)', !/heldBy|inputContexts/.test(desc));
}
