// A level switch is one commit (engine/modules/level/load.js), against the real level module on a small stand-in engine: the old level survives a load that
// fails at any point before the commit, level:failed replaces level:loaded, the caller sees the error, and a save asked for during a load waits for it.
// Why not a browser: every step here is plain data flow, and the stand-in records exactly the live writes the commit must hold back.
import { fakeSaves } from './fixtures/fake-saves.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const { level } = await imp('modules/level/index.js');
const { StateReplace } = await imp('core/saves/stateReplace.js');

export const name = 'level: prepare then commit; a failure keeps the old level; saves wait for a load';

const scene = n => {
  const root = new THREE.Group(); root.name = n;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4), new THREE.MeshBasicMaterial()); floor.name = 'ground';
  root.add(floor);
  return root;
};

function stand(files) {
  const events = [], live = new Set(), on = {};
  const e = {
    events: { emit: (n, d) => { events.push(n); on[n]?.(d); }, on: () => ({ remove() {} }) },
    assets: { wholeModel: async n => { if (!files[n]) throw new Error('no file ' + n); return files[n](); }, trim() {} },
    commits: { invalidate() { events.push('invalidate'); } }, world: { zone: null, get: () => null },
    add: o => { live.add(o); }, remove: o => { live.delete(o); }, rays: { addStatic: () => ({ remove() {} }) },
    movement: { stepHeight: 0.3, height: 1.8 }, ops: { allow: f => f() }, i18n: { add() {} }, t: k => k,
    saves: { _replace: new StateReplace({ loading: { _limit: p => p } }) }, modules: new Map(), stream: { ready: true }, onFrame: () => ({ remove() {} }), ui: { get: () => null },
  };
  let part = null;
  const m = level({ url: 'a' }), ctx = { ground: { provide() {} }, track: h => h, feeds() {}, saves: fakeSaves((k, p) => { part = p; }) };
  return { e, m, api: m.install(e, ctx), events, live, part };
}

export async function run({ check }) {
  const { m, api, e, events, live, part } = stand({ a: () => scene('a'), b: () => scene('b') });
  const starting = m.init(e);
  part.load('a');
  await starting;
  check('a save naming the first level, loaded while it loads, does not drop it: there is no other level to keep', !!api.root && api.ready);
  const first = api.root;
  check('the first level is up', api.ready && live.has(first) && e.world.zone === 'a');

  events.length = 0;
  let error = null;
  await api.load('missing').catch(err => { error = err; });
  check('a failed load rejects', error?.message === 'no file missing');
  check('the old level stays', api.root === first && live.has(first) && api.heightfield && e.world.zone === 'a');
  check('it says failed, not loaded', events.includes('level:failed') && !events.includes('level:loaded'));
  check('old background results stay valid', !events.includes('invalidate'));
  check('nothing is loading after it', api.ready);
  check('the save still names the old level', m.describe().file === 'a');

  events.length = 0;
  const going = api.load('b');
  check('the old level stays until the commit', api.root === first && !api.ready);
  await going;
  check('the commit swaps it', api.root !== first && !live.has(first) && api.root.name === 'b' && e.world.zone === 'b');
  check('loading, then the commit, in that order', events.indexOf('level:loading') < events.indexOf('level:loaded') && events.includes('invalidate'));
  await Promise.resolve();
  check('playable is its own later moment', events.indexOf('level:loaded') < events.indexOf('level:playable') && api.playable);

  // the rule saves.save goes through
  const q = new StateReplace({ loading: { _limit: p => p }, freeze: () => ({ remove() {} }) }), order = [];
  let finish;
  const load = q.run(null, () => new Promise(res => { finish = res; }));
  const save = q.read(async () => { order.push('save'); return true; });
  order.push('load running');
  finish(true);
  await load;
  check('a save during a load waits for it', (await save) === true && order.join() === 'load running,save');
  check('an idle save runs now', (q.read(() => { order.push('now'); return 1; }), order.at(-1) === 'now'));
}
