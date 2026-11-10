// W8 "describe everywhere" guards that need no browser: the R44 rule catches a module definition without describe; triggers' wireframes are only
// the debug view 'triggers' (no option, no setDebug); things.js and picture/layers.js read stack frames through one helper.
// The browser half (each new describe hook returns its fields, no `by` key in describe()) is packages/engine/tests/specs/describe-hooks.mjs.
import * as THREE from 'three';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { ENGINE } from '../paths.mjs';
import { scanText } from '../rules/R44-module-describe.mjs';

const eng = f => import(pathToFileURL(join(ENGINE, f)).href);
const [{ DebugOverrides }, { Stacks }, { triggers }, { stackFrames, frameText }] =
  await Promise.all(['core/inspect/DebugOverrides.js', 'core/ops/stacks.js', 'modules/triggers/index.js', 'core/ops/stackFrames.js'].map(eng));

export const name = 'describe everywhere: R44 catches a module without describe, triggers wireframes are the debug view only, one stack-frame helper';

/** The parts of an engine the triggers module and the debug chain touch, real Stacks and DebugOverrides */
function fakeEngine() {
  const scene = new THREE.Scene();
  const e = { scene, THREE, style: {}, i18n: { add() {} }, input: { define() {}, action: () => ({ remove() {} }), pressed: () => false }, audio: { condition() {} },
    saves: { define() {} }, events: { on() {} }, surface: () => 0, actorPosition: () => null, _things: { entryOf: () => null, live: () => null } };
  e.stacks = new Stacks(e);
  e.debug = new DebugOverrides(e);
  return e;
}

export async function run({ check }) {
  // R44: a module definition (name + install) without describe is a finding; with describe, or not a module, it is not
  check('R44 flags a module definition without describe', scanText("export const m = () => ({ name: 'lamp', type: 'rules', label: 'Lamp', install(e) { return {}; } });\n").join() === 'lamp');
  check('R44 passes one with describe', scanText("const m = { name: 'lamp', type: 'rules', install() {}, describe() { return { on: true }; } };\n").length === 0);
  check('R44 ignores objects that are not module definitions', scanText("const o = { name: 'x', value: 1 }; const p = { install() {} };\n").length === 0);

  // triggers: the old option is unknown now (readParams throws in dev), the old method is gone
  // dev builds throw, release builds (node here has no import.meta.env.DEV) warn once: either way the option is reported as unknown
  let msg = '';
  const w0 = console.warn; console.warn = (...a) => { msg += a.join(' '); };
  try { triggers({ debug: true }); } catch (err) { msg = err.message; } finally { console.warn = w0; }
  check('triggers({ debug }) is an unknown option', /unknown option "debug"/.test(msg), msg);
  const e = fakeEngine(), def = triggers({}), tr = def.install(e, { name: def.name, track: h => h, saves: e.saves });
  check('setDebug and the debug flag are gone', tr.setDebug === undefined && tr.debug === undefined);
  check("the module adds 'triggers' to the debug view modes", e.debug.viewModes().includes('triggers'));

  // debug.view('triggers') draws one wireframe per zone (and zones added while on), 'off' removes and disposes them
  tr.add({ shape: 'box', position: { x: 0, y: 0, z: 0 } }); tr.add({ shape: 'sphere', position: { x: 5, y: 1, z: 0 } });
  const group = () => e.scene.getObjectByName('triggers-debug');
  check('nothing is drawn before the view is on', !group());
  const st = e.debug.view('triggers');
  check('view triggers draws every zone as lines', group()?.children.length === 2 && group().children.every(o => o.isLineSegments), JSON.stringify(st));
  check('the view state explains itself', st.mode === 'triggers' && /wireframe/.test(st.what ?? ''));
  const late = tr.add({ position: { x: 9, y: 0, z: 9 } });
  check('a zone added while the view is on shows at once', group()?.children.length === 3);
  late.remove();
  check('a removed zone leaves the drawing', group()?.children.length === 2);
  let disposed = 0; group().traverse(o => o.geometry?.addEventListener('dispose', () => disposed++));
  e.debug.view('off');
  check("view 'off' removes the wireframes and disposes their geometry", !group() && disposed === 2 && tr.list().every(t => !t._mesh), String(disposed));
  e.debug.view('triggers', { owner: 'probe' }); e.debug.clear('probe');
  check('debug.clear(owner) clears it like any other view', !group() && e.debug.viewState().mode === 'off');
  def.dispose(e);
  check('module dispose drops the mode', !e.debug.viewModes().includes('triggers'));

  // one stack-frame helper: both callers import it and neither keeps its own regex
  const src = f => readFileSync(join(ENGINE, f), 'utf8');
  check('things.js, sharedPoint.js and control.js read frames through core/ops/stackFrames.js, no private FRAME regex',
    ['core/scene/things.js', 'core/ops/sharedPoint.js', 'core/ops/control.js'].every(f => src(f).includes("stackFrames.js'") && !/const FRAME\s*=/.test(src(f))));
  const v8 = 'Error\n    at captureStack (http://localhost:5173/packages/engine/core/scene/things.js?v=3:40:9)\n    at add (http://localhost:5173/core/engine/Engine.js:9:1)\n    at http://localhost:5173/src/main.js:50:7';
  const ff = 'add@http://localhost:5173/core/engine/Engine.js:9:1\n@http://localhost:5173/src/main.js:50:7';
  check('V8 frames: query string dropped, host dropped', frameText(stackFrames(v8)[2]) === 'src/main.js:50' && stackFrames(v8).length === 3);
  check('Firefox frames read the same', frameText(stackFrames(ff)[1]) === 'src/main.js:50');
  check('Windows paths get forward slashes', stackFrames('    at f (C:\\game\\src\\main.js:7:1)')[0]?.file === 'C:/game/src/main.js');
}
