// Named camera views (core/scene/Views.js): define, show moves the camera and takes it over through engine.takeCamera (core/ops/holds.js), release gives it back
// to whoever held it before (a cutscene keeps its takeover); bad input is rejected with a code.
import * as THREE from 'three';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const { Views } = await import(pathToFileURL(join(ENGINE, 'core/scene/Views.js')).href);
const { holdMethods, defineHoldStacks } = await import(pathToFileURL(join(ENGINE, 'core/ops/holds.js')).href);
const { Stacks } = await import(pathToFileURL(join(ENGINE, 'core/ops/stacks.js')).href);
const { Events } = await import(pathToFileURL(join(ENGINE, 'core/base/Events.js')).href);

export const name = 'named camera views: define / show / release';

export async function run({ check }) {
  // a minimal engine with the real camera takeover (holds.js), so views cannot bypass it
  const engine = Object.defineProperties({ camera: new THREE.PerspectiveCamera(60), focus: new THREE.Vector3() }, Object.getOwnPropertyDescriptors(holdMethods));
  engine.stacks = new Stacks(engine); defineHoldStacks(engine);
  engine.events = new Events();
  engine.onFrame = () => ({ remove() {} });   // the owned camera pose is checked per frame (core/ops/owned.js); this test steps no frames
  engine._oFov = { check() {}, mark() {} };   // the fov owner (core/scene/view.js): a held view writes through holdFov
  const cuts = []; engine.events.on('camera:shot', c => cuts.push(c.name));
  const v = new Views(engine);
  const def = v.define('gate', { position: [0, 2, 10], target: [0, 2, 0], fov: 35 });
  check('defined view is listed', v.has('gate') && v.list().join() === 'gate');
  const shown = v.show('gate');
  check('show places the camera and takes it over', shown && engine.camera.position.z === 10 && engine.camera.fov === 35 && engine.cameraOverride?.owner === 'views');
  check('show announces the cut, so the light pool settles at once', cuts.join() === 'gate');
  check('[guard] the world loads around what the view looks at: the claim carries the target as focus, and engine.focus moves at once',
    engine.cameraOverride?.focus?.z === 0 && engine.cameraOverride?.focus?.y === 2 && engine.focus.y === 2);
  const dir = new THREE.Vector3(); engine.camera.getWorldDirection(dir);
  check('the camera looks at the target (down -z)', dir.z < -0.99);
  shown.remove();
  check('the handle show returns gives the camera back', engine.cameraOverride === null && v.current === null);
  check('release gives the fov back', engine.camera.fov === 60, String(engine.camera.fov));
  // a cutscene held the camera first: a view on top, then release, hands it back to the cutscene (not to nobody)
  const cut = engine.takeCamera('timeline', { focus: null });
  v.show('gate');
  check('the latest holder is in charge', engine.cameraOverride.owner === 'views');
  v.release();
  check('release hands the camera back to the cutscene that held it', engine.cameraOverride?.owner === 'timeline');
  cut.remove();
  check('no holder left: the rig gets the camera', engine.cameraOverride === null);
  def.remove();
  check('the handle define returns undeclares the view', !v.has('gate'));
  let code = null; try { v.define('x', { position: [1, 2] }); } catch (err) { code = err.code; }
  check('a position that is not [x, y, z] throws views-define', code === 'views-define');

  // the content validator knows the kind: good views pass, each mistake is one error naming the view
  const { checkViews } = await import(pathToFileURL(join(ENGINE, '../tools/content-check/views.mjs')).href);
  const run = views => { const errs = []; checkViews({ c: { views }, err: (_, m) => errs.push(m), isObj: x => x && typeof x === 'object' && !Array.isArray(x) }); return errs; };
  check('valid views produce no errors', run({ a: { position: [1, 2, 3] }, b: { position: [0, 1, 0], target: [0, 0, 0], fov: 50 } }).length === 0);
  const e = run({ a: { position: [1, 2] }, b: { position: [0, 0, 0], tgt: [1, 1, 1] }, c: { position: [0, 0, 0], fov: 400 } });
  check('bad position, unknown key and bad fov are each reported: ' + e.join(' | '), e.length === 3 && /"a".*position/.test(e[0]) && /"b".*tgt/.test(e[1]) && /"c".*fov/.test(e[2]));
}
