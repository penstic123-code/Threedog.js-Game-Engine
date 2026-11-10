// [guard] A value the game gave is used, or a dev warning says where it went (design.md section 2.4 "Nothing silently wrong"):
//   - world.present leaves rot / scale to the game's build (the 1.1 contract), so a model is never turned or sized a second time
//   - followCamera keeps its documented zoom / pitch range, but a requested value outside it warns once, naming the option to change
//   - every warnOnce is listed in describe().warnings (code, text, fix), capped, so an AI sees it without the console
// Run: threedog test "Given values"
const PAGE = '/tests/threads/';
const J = JSON.stringify;
const r3 = v => Math.round(v * 1000) / 1000;

export const specs = [
  {
    // the 1.1 contract: a game's build owns its model's turn and size. A heuristic on the root (applied when the root looked unturned) turned
    // models twice whose build rotated a child, baked the size into geometry or kept rot in degrees
    name: '[guard] Given values: world.present places only the position; rot / scale stay the game build\'s own',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, r3 = v => Math.round(v * 1000) / 1000;
        const E = mk(T.createEngine, 'gv-rot');
        E.use(T.world());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        // rot in degrees on a child; scale baked into the geometry
        E.world.present('gvChild', { build: rec => { const o = new THREE.Object3D(), c = new THREE.Object3D(); c.rotation.y = rec.rot * Math.PI / 180; o.add(c); return o; } });
        E.world.present('gvBaked', { build: rec => new THREE.Mesh(new THREE.BoxGeometry(rec.scale, rec.scale, rec.scale)) });
        E.ops.allow(() => {
          E.world.add({ id: 'gv-child', kind: 'gvChild', position: { x: 1, y: 0, z: 0 }, rot: 90 });
          E.world.add({ id: 'gv-baked', kind: 'gvBaked', position: { x: 2, y: 0, z: 0 }, rot: [0.2, 1, 0], scale: 2 });
        });
        steps(3);
        const root = id => { const o = E.world.view(id); return o && [o.rotation.x, o.rotation.y, o.rotation.z, o.scale.x, o.scale.y, o.scale.z].map(r3).join(); };
        const out = { child: root('gv-child'), childTurn: r3(E.world.view('gv-child').children[0].rotation.y), baked: root('gv-baked') };
        E.ops.allow(() => E.world.set('gv-child', { rot: 180 }));
        out.thing = E.ops.run('thing.set', { id: 'gv-baked', rotation: 1.25, scale: 0.5 }).ok; steps(1);
        out.after = [root('gv-child'), root('gv-baked')];
        E.dispose();
        return out;
      });
      const asBuilt = '0,0,0,1,1,1';
      check('a build that turns a child by rot in degrees: the root is left as built', r.child === asBuilt && r.childTurn === r3(Math.PI / 2), J(r));
      check('a build that bakes scale into its geometry: the root is not scaled again', r.baked === asBuilt, J(r));
      check('later world.set / thing.set of rot / scale do not reach the root', r.thing && r.after.every(x => x === asBuilt), J(r));
    },
  },
  {
    name: '[guard] Given values: followCamera keeps its zoom and pitch range, and a value outside it warns once naming maxDistance / minDistance / maxPitch',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads, out = {};
        const E = mk(T.createEngine, 'gv-cam');
        let rig;
        const made = await __t.warns(async () => { E.use(T.followCamera({ distance: 60 })); await E.start(); E.haltLoop(); rig = E.cameraRig; });
        out.made = { warns: made.warns, distance: rig.distance };
        const { warns } = await __t.warns(() => {
          rig.setView({ distance: 80 }); out.far = rig.distance;
          rig.setView({ distance: 90 });
          rig.setView({ distance: 1 }); out.near = rig.distance;
          rig.setView({ pitch: 3 }); out.pitch = rig.pitch;
          rig.setView({ distance: 20, pitch: 0.5 });
        });
        out.warns = warns; out.inRange = [rig.distance, rig.pitch];
        out.listed = (E.describe('warnings').warnings?.list ?? []).filter(w => w.code === 'camera-clamped');
        E.dispose();
        return out;
      });
      const named = (ws, word) => ws.filter(w => new RegExp(`is (above|below) ${word} `).test(w) && /\[camera-clamped\]/.test(w)).length;
      check('a starting distance past maxDistance is kept as given, and warns naming maxDistance', r.made.distance === 60 && named(r.made.warns, 'maxDistance') === 1, J(r.made));
      check('setView keeps the documented limit', r.far === 45 && r.near === 4 && r.pitch === 1.35, J([r.far, r.near, r.pitch]));
      check('each limit warns once, naming the option to change', named(r.warns, 'maxDistance') === 1 && named(r.warns, 'minDistance') === 1 && named(r.warns, 'maxPitch') === 1 && r.warns.length === 3, J(r.warns));
      check('a value inside the range is taken as is', r.inRange.join() === '20,0.5', J(r.inRange));
      check('describe().warnings lists them with their fix', r.listed.length >= 3 && r.listed.every(w => w.text && !/\[camera-clamped\]/.test(w.text) && w.fix), J(r.listed));
    },
  },
  {
    name: '[guard] Given values: describe().warnings lists every warnOnce with code, text and fix, capped, and counts the rest',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads;
        const E = mk(T.createEngine, 'gv-list');
        await E.start(); E.haltLoop();
        await __t.warns(() => { for (let i = 0; i < 40; i++) T.checkOptions(`gvList${i}()`, { [`colour${i}`]: 1 }, [`color${i}`]); });
        const w = E.describe('warnings').warnings;
        E.dispose();
        return { count: w?.count, n: w?.list?.length, first: w?.list?.find(x => x.text.includes('gvList0()')) };
      });
      check('the count holds every warning, the list is capped', r.count >= 40 && r.n === 20, J(r));
      check('an entry carries code, text and fix', r.first?.code === 'unknown-option' && /colour0/.test(r.first.text) && typeof r.first.fix === 'string', J(r.first));
    },
  },
];
