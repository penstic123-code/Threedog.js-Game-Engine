// [vertical] Top-down audit of the 1.0 chains: each row follows one function from the game's call down to what the player sees. A name starting
// "[vertical FAILING]" proves an open bug and stays red until the bug is fixed (like [map FAILING]); a fix renames the row.
// Report: docs/testing/review/2026-11-07-1.0-audit/vertical-output.md. Each row first checks its setup took, so it fails only on the last checks, for the reason in its name.
const PAGE = '/tests/threads/';
const J = JSON.stringify;
const shot = { position: [20, 8, 20], lookAt: [0, 0, 0] };

const setup = () => {
  window.vQuiet = () => { const was = [console.error, console.warn], said = []; console.error = console.warn = (...a) => said.push(a.map(String).join(' ').slice(0, 200)); return { said, back() { [console.error, console.warn] = was; } }; };
  window.vFixed = a => a.fixedCamera({ shots: { a: { position: [1, 2, 3], lookAt: [0, 0, 0] }, b: { position: [9, 9, 9], lookAt: [0, 0, 0] } } });
  window.vFollow = a => a.followCamera();
  // an engine with a chosen rig and the timeline; extra modules after them
  window.vCam = async (name, rig, ...more) => {
    const { mk, createEngine, all } = threedogThreads;
    const E = mk(createEngine, name);
    E.use(rig(all), all.timeline(), ...more);
    await E.start();
    E.step(0.05);
    return E;
  };
  // steps with a turn of the promise queue between them: a timeline's next step starts in a microtask, so a plain loop of step() would outrun it
  window.vRun = async (E, seconds) => { for (let t = 0; t < seconds; t += 0.05) { E.step(0.05); await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); } };
  window.vPose = E => E.camera.position.toArray().map(n => Math.round(n * 100) / 100);
  window.vFade = E => [...E.uiRoot.querySelectorAll('.threedog-fade')].map(n => +getComputedStyle(n).opacity).at(-1) ?? 0;
};

export const specs = [
  // ---------- chain I: camera and cutscenes ----------
  {
    name: '[guard] cutscene fov: the slider moved during a shot lands at the end, and a shot never makes the engine give up the lens',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async shot => {
        const { all } = threedogThreads, q = vQuiet();
        const E = await vCam('v-fov', vFollow, all.settings({ sections: ['camera'] }));
        E.settings.set('camera.fov', 70); E.step(0.05);
        const before = E.camera.fov;
        const p = E.timeline.play([{ camera: { to: shot, duration: 0.4, fov: 30 } }], { actors: [] });
        await vRun(E, 0.2);
        E.settings.set('camera.fov', 90);   // the settings menu opens over a cutscene
        await vRun(E, 0.5); await p; E.step(0.05);
        const end = E.camera.fov, slider = E.settings.get('camera.fov');
        E.settings.set('camera.fov', 75); E.step(0.05);
        const out = { before, end, slider, after: E.camera.fov, mode: E._oFov.mode, said: q.said.filter(s => /view.fov/.test(s)).length };
        E.dispose(); q.back();
        return out;
      }, shot);
      check('the slider works before the cutscene', r.before === 70, J(r));
      check('the camera ends on what the slider says', r.end === r.slider, J(r));
      check('the slider still works after the cutscene', r.after === 75, J(r));
      check('no warning blames the game for a shot of the engine', r.said === 0, J(r));
    },
  },
  {
    name: '[guard] cutscene overlap fov: two overlapping shots give back the fov the first one took',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async shot => {
        const q = vQuiet(), E = await vCam('v-ov', vFixed), f0 = E.camera.fov;
        const a = E.timeline.play([{ camera: { to: shot, duration: 1, fov: 30 } }], { actors: [] });
        await vRun(E, 0.5);
        const mid = E.camera.fov;
        const b = E.timeline.play([{ camera: { to: shot, duration: 1 } }], { actors: [] });
        await vRun(E, 2); await a; await b; E.step(0.05);
        const out = { f0, mid, end: E.camera.fov, held: E.cameraOverride?.owner ?? null };
        E.dispose(); q.back();
        return out;
      }, shot);
      check('the first shot was changing the fov', r.mid < r.f0, J(r));
      check('both ended and gave the camera back', r.held === null, J(r));
      check('the fov is back where it started', r.end === r.f0, J(r));
    },
  },
  {
    name: '[guard] rig writes during a hold: a shot change only records, and lands at release',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async shot => {
        const q = vQuiet(), E = await vCam('v-hold', vFixed);
        const p = E.timeline.play([{ camera: { to: shot, duration: 0.1 } }, { wait: 5 }], { actors: [] });
        await vRun(E, 0.3);
        const inShot = vPose(E), held = E.cameraOverride?.owner ?? null;
        // what a camera:<shot> trigger zone does when the actor walks through it during the scene
        E.events.emit('trigger:enter', { tag: 'camera:b' }); await vRun(E, 0.1);
        const after = vPose(E); E.timeline.skip(); await p; await vRun(E, 0.1);
        const landed = vPose(E);
        E.dispose(); q.back();
        return { inShot, held, after, landed };
      }, shot);
      check('the cutscene holds the camera', !!r.held && r.inShot[0] === 20, J(r));
      check('the held camera stays on the shot', r.after[0] === 20, J(r));
      check('the shot the rig was told lands at release', r.landed[0] === 9, J(r));
    },
  },
  {
    // every door a rig has to the camera, not only the audited one: a new rig call that writes during a hold fails here
    name: '[guard] rig writes during a hold: no rig call or rig switch moves, reshapes or refocuses a held camera',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), { all } = threedogThreads;
        const view = E => J0(E) ;
        function J0(E) { return JSON.stringify([E.camera.uuid, vPose(E), E.camera.fov]); }
        const E = await vCam('v-hold2', a => a.rtsCamera());
        const hold = E.takeCamera('shot'); E.step(0.05);
        const before = view(E);
        E.cameraRig.moveTo([40, 0, 40], { instant: true });
        const moved = view(E);
        E.setCamera('fixed', { position: [3, 3, 3], lookAt: [0, 0, 0], projection: 'orthographic', size: 8, fov: 20 });
        E.step(0.05);
        const fixed = view(E);
        E.cameraRig.blend('main', { seconds: 1 });
        E.setCamera('follow', { projection: 'perspective' }); E.step(0.05);
        const follow = view(E);
        E.setCamera('fixed'); E.step(0.05);
        hold.remove(); E.step(0.05);
        const landed = { x: vPose(E)[0], ortho: !!E.camera.isOrthographicCamera, held: E.cameraOverride };
        E.dispose(); q.back();
        return { before, moved, fixed, follow, landed };
      });
      check('moveTo instant leaves it', r.moved === r.before, J(r));
      check('a switch of rigs with its own shot, projection and fov leaves it', r.fixed === r.before, J(r));
      check('a switch back leaves it', r.follow === r.before, J(r));
      check('what the rig was told lands at release', r.landed.x === 3 && r.landed.ortho && r.landed.held === null, J(r));
    },
  },
  {
    name: '[guard] view of a hold: a fov the game owns comes back after a shot, and a write of its own during the hold stays',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async shot => {
        const q = vQuiet(), E = await vCam('v-own', vFollow);
        const mine = E.autoView.manual('fov'); E.camera.fov = 33;
        const p = E.timeline.play([{ camera: { to: shot, duration: 0.2, fov: 20 } }], { actors: [] });
        await vRun(E, 0.1); const mid = E.camera.fov;
        await vRun(E, 0.3); await p; const back = E.camera.fov; mine.remove();
        const h = E.takeCamera('me'); E.step(0.05); E.camera.fov = 41; h.remove(); E.step(0.05);
        const own = E.camera.fov;
        E.views.define('v', { position: [1, 1, 1], fov: 22 }); E.autoView.manual('fov', false);
        const f0 = E.camera.fov; E.views.show('v'); const shown = E.camera.fov; E.views.release();
        const out = { mid, back, own, f0, shown, end: E.camera.fov };
        E.dispose(); q.back();
        return out;
      }, shot);
      check('the shot shows its fov over the game\'s', r.mid < 33, J(r));
      check('the game\'s fov comes back', r.back === 33, J(r));
      check('a write by the game during a hold is not taken back', r.own === 41, J(r));
      check('a view hands back through the same route', r.shown === 22 && r.end === r.f0, J(r));
    },
  },
  {
    name: '[guard] cutscene fade: a run that ends early gives the screen back',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet();
        const A = await vCam('v-fd1', vFollow);
        const res = await A.timeline.play([{ fade: 0 }, { do: () => { throw new Error('step failed'); } }, { fade: 0, to: 0 }], { actors: [] });
        const thrown = vFade(A), ended = !A.timeline.playing; A.dispose();
        const B = await vCam('v-fd2', vFollow);
        B.saves.save('s'); await B.saves.flush();
        const p = B.timeline.play([{ fade: 0 }, { wait: 50 }, { fade: 0, to: 0 }], { actors: [] }); await vRun(B, 0.1);
        const during = vFade(B);
        await B.saves.load('s'); await p;
        const loaded = vFade(B), running = B.timeline.playing; B.dispose();
        q.back();
        return { res, thrown, ended, during, loaded, running };
      });
      check('the fade took', r.during === 1, J(r));
      check('both runs are over', r.ended && !r.running, J(r));
      check('a step that threw does not leave the screen black', r.thrown === 0, J(r));
      check('a load that dropped the run does not leave the screen black', r.loaded === 0, J(r));
    },
  },
  {
    name: '[guard] cutscene failure: a step that threw is a failed run for play(), the event and describe',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), E = await vCam('v-err', vFollow); let end = null, rest = false;
        E.events.on('timeline:end', p => { end = p; });
        const res = await E.timeline.play([{ do: () => { throw new Error('step failed'); } }, { do: () => { rest = true; } }], { actors: [] });
        const seen = JSON.stringify(E.describe()).includes('step failed');
        const out = { res, end, rest, seen, error: E.error?.message ?? null, logged: q.said.some(s => /timeline step/.test(s)) };
        E.dispose(); q.back();
        return out;
      });
      check('the later steps did not run and the console has it', !r.rest && r.logged, J(r));
      check('play() tells the caller the run failed', r.res.ending === 'failed' && r.res.error === 'step failed', J(r));
      check('timeline:end tells listeners', r.end.ending === 'failed' && r.end.error === 'step failed', J(r));
      check('describe() shows it, or engine.error does', r.seen || !!r.error, J(r));
    },
  },
  {
    name: '[guard] cutscene dispose: no step runs after the engine is gone',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), E = await vCam('v-disp', vFollow), seen = [];
        const p = E.timeline.play([{ wait: 50 }, { do: e => seen.push(e.disposed) }], { actors: [] });
        E.step(0.05); E.dispose(); const res = await p; q.back();
        return { seen, res };
      });
      check('no step runs on a disposed engine, and the run says dropped', r.seen.length === 0 && r.res.ending === 'dropped', J(r));
    },
  },
  {
    name: '[guard] cutscene endings: every way a run ends is one ending, said alike everywhere, and gives back all it held',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), out = {};
        // one run per ending, each holding all a run can hold: a fade, the letterbox, the camera, the skip key. stop ends it the way the name says
        const once = async (name, steps, stop) => {
          const E = await vCam('v-end-' + name, vFollow), ran = [], ends = [];
          E.events.on('timeline:end', p => ends.push(p.ending));
          const p = E.timeline.play(steps(ran), { actors: [], letterbox: true }); await vRun(E, 0.1);
          const held = { camera: !!E.describe().holds?.camera?.length || E.camera.position.x === 20, cover: vFade(E) };
          await stop?.(E); const res = await p; await vRun(E, 0.1);
          out[name] = { res, ends, ran, held, playing: E.timeline.playing, bars: E.timeline.top.classList.contains('is-on'), fade: vFade(E), cam: E.describe().cutscene ?? null };
          E.dispose();
        };
        const shot = { camera: { to: { position: [20, 8, 20], lookAt: [0, 0, 0] }, duration: 0 } };
        const rest = ran => [{ wait: 50 }, { do: () => { ran.push('rest'); } }];
        await once('finished', ran => [shot, { fade: 0 }, { fade: 0, to: 0 }, { wait: 0.3 }, { do: () => { ran.push('rest'); } }], E => vRun(E, 0.5));
        await once('skipped', ran => [shot, { fade: 0 }, ...rest(ran)], E => E.timeline.skip());
        await once('dropped', ran => [shot, { fade: 0 }, ...rest(ran)], async E => { await E.session.newGame(); });
        await once('failed', ran => [shot, { fade: 0 }, { parallel: [{ sequence: [{ wait: 0.2 }, { do: () => { throw new Error('boom'); } }] }, { sequence: rest(ran) }] }], E => vRun(E, 0.5));
        await once('skip then throw', ran => [shot, { fade: 0 }, { wait: 50 }, { do: () => { ran.push('ran'); throw new Error('boom'); } }, { do: () => { ran.push('rest'); } }], E => E.timeline.skip());
        q.back();
        return out;
      });
      for (const n of ['finished', 'skipped', 'dropped', 'failed']) {
        // "<ending> ending" and not "<ending>:": a label holding 'skipped:' is the runner's mark for a check that compared nothing (run.mjs), and these do compare
        check(n + ' ending, play() and timeline:end say it, once', r[n].res.ending === n && r[n].ends.length === 1 && r[n].ends[0] === n, J(r[n]));
        check(n + ' ending, the run held something, and it all came back', r[n].held.cover === 1 || n === 'finished', J(r[n]));
        check(n + ' ending, no run, no bars', !r[n].playing && !r[n].bars, J(r[n]));
      }
      check('a skip still runs what is left, so the state matches a playthrough', r.skipped.ran.length === 1 && r.finished.ran.length === 1, J(r));
      check('a dropped or failed run runs nothing more, a branch beside the throw included', !r.dropped.ran.length && !r.failed.ran.length, J(r));
      check('the screen comes back from a drop and a failure', r.dropped.fade === 0 && r.failed.fade === 0, J(r));
      check('a skip ends as the script says: it leaves the fade where the steps left it', r.skipped.fade === 1, J(r));
      check('describe counts a failure', r.failed.cam?.endings?.failed === 1 && /boom/.test(r.failed.cam.failure), J(r.failed));
      check('a throw during a skip is a failure, not a skip', r['skip then throw'].res.ending === 'failed' && r['skip then throw'].ran.length === 1, J(r['skip then throw']));
    },
  },
  {
    name: '[guard] autosave in a cutscene: the save holds the state half way and the rest of the run is lost on load',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), E = await vCam('v-auto', vFollow);
        let opened = false; E.saves.define('story', { save: () => ({ opened }), load: d => { opened = d.opened; } });
        await E.session.newGame();
        E.saves.autosave(0.001);
        const p = E.timeline.play([{ wait: 0.3 }, { do: () => { opened = true; } }], { actors: [] });
        E.step(0.1); await E.saves.flush();
        const wrote = (await E.saves.list()).some(s => s.slot === 'auto');
        E.saves.autosave(999);   // the player quits before the next one: the mid-scene save is the one on disk
        await vRun(E, 0.5); await p;
        const finished = opened;
        if (wrote) await E.session.load('auto');
        const out = { wrote, finished, opened, playing: E.timeline.playing, slots: await E.saves.list() };
        E.dispose(); q.back();
        return out;
      });
      check('the run finished in play', r.finished, J(r));
      check('an autosave never records a moment no load can continue from', !r.wrote || r.opened || r.playing, J(r));
    },
  },
  {
    name: '[guard] hold at new game: a hold from writing the camera ends with its playthrough',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const q = vQuiet(), E = await vCam('v-ng', vFollow);
        E.camera.position.x += 1; E.step(0.1);
        const held = E.cameraOverride?.owner ?? null;
        await E.session.newGame(); E.step(0.1);
        const after = E.cameraOverride?.owner ?? null;
        E.takeCamera('mine'); await E.session.newGame(); E.step(0.1);
        const out = { held, after, named: E.cameraOverride?.owner ?? null };
        E.dispose(); q.back();
        return out;
      });
      check('the write took the camera', r.held === 'three', J(r));
      check('the new playthrough starts with the rig in charge', r.after === null, J(r));
      check('a hold taken on purpose stays', r.named === 'mine', J(r));
    },
  },
  {
    name: '[guard] first person body in a shot: hidden only while the first person view shows',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async shot => {
        const { all, mk, createEngine, world, collision, characters, level, THREE } = threedogThreads, q = vQuiet();
        const E = mk(createEngine, 'v-body'); E.use(world(), collision(), characters(), level({ scene: new THREE.Group() }), all.firstPersonCamera(), all.timeline()); await E.start();
        const P = E.characters.addPlayer({ control: 'camera', cameraFollow: true }), m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
        P.root.add(m); E.step(0.1);
        const inFirst = m.layers.test(E.camera.layers);
        const p = E.timeline.play([{ camera: { to: shot, duration: 0.1 } }, { wait: 0.2 }], { actors: [] });
        await vRun(E, 0.2);
        const held = !!E.cameraOverride, inShot = m.layers.test(E.camera.layers);
        const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); P.root.add(late);   // a model that loads during the shot
        const lateShown = late.layers.test(E.camera.layers);
        await vRun(E, 0.4); await p; E.step(0.05);
        const out = { inFirst, held, inShot, lateShown, back: !m.layers.test(E.camera.layers) && !late.layers.test(E.camera.layers) };
        E.dispose(); q.back();
        return out;
      }, shot);
      check('hidden in first person, as it should be', r.inFirst === false, J(r));
      check('a shot from outside shows the body', r.held && r.inShot && r.lateShown, J(r));
      check('hidden again when the first person view is back', r.back, J(r));
    },
  },
  // ---------- chain K: what the tools read from the engine ----------
  {
    name: '[guard] disabled module: one state, read the same by catalog, describe and the module list',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, q = vQuiet();
        const E = mk(createEngine, 'v-off');
        E.use({ name: 'lookBad', type: 'picture', label: 'x', frame() { throw new Error('picture boom'); } });
        await E.start(); E.step(0.1);
        const row = [].concat(E.catalog('lookBad')).flat()[0] ?? E.catalog().find(m => m.id === 'lookBad');
        const out = { disabled: E.describe().disabledModules ?? [], state: row?.state ?? null, states: E.moduleStates.lookBad, usable: E.usable('lookBad'), text: E.describeText(), problems: row?.problems ?? [] };
        E.dispose(); q.back();
        return out;
      });
      check('the module was switched off', r.disabled.includes('lookBad'), J(r));
      check('catalog, the state list and the list in describe say one thing', r.state === 'disabled' && r.states === 'disabled', J(r));
      check('not usable, and the summary and catalog problems name it', !r.usable && /lookBad/.test(r.text) && r.problems.length > 0, J(r));
    },
  },
  // ---------- chain J: picture and performance ----------
  {
    name: '[guard] quality high: the top preset lets through everything the game set',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads, q = vQuiet();
        const E = mk(createEngine, 'v-top'); E.use(all.settings(), all.terrain({ height: () => 0, viewChunks: 8 }));
        await E.start(); E.post.add({ name: 'ao', slot: 'hdr', fuse: { glsl: '' } }); E.step(0.05);
        const game = { view: E.terrain.viewChunks, ao: E.post.get('ao').enabled, quality: E.settings.get('quality') };
        E.settings.preset('high'); E.step(0.05);
        const high = { view: E.terrain.viewChunks, ao: E.post.get('ao').enabled };
        E.settings.preset('low'); E.step(0.05);
        const low = { view: E.terrain.viewChunks };
        E.settings.reset('viewChunks'); const lowBack = E.terrain.viewChunks;
        E.dispose(); q.back();
        return { game, high, low, lowBack };
      });
      check('the game asked for 8 chunks and ao', r.game.view === 8 && r.game.ao, J(r));
      check('High keeps the view distance the game set', r.high.view >= r.game.view, J(r));
      check('High keeps the game\'s ao', r.high.ao, J(r));
      check('Low is a share of what the game set, not a number of its own', r.low.view < r.game.view && r.low.view > 3, J(r));
      check('the game\'s own stays the base of the share when the menu names none', r.lowBack === 8, J(r));
    },
  },
  {
    name: '[guard] quality low: no preset turns the post chain on, and MSAA waits for the next launch',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads, q = vQuiet();
        const E = mk(createEngine, 'v-low'); E.use(all.settings()); await E.start();
        const at = n => { E.settings.preset(n); E.step(0.05); E.step(0.05); return { active: E.post.active, chain: !!E.post.object(), shown: E.describe().render.antialias }; };
        const canvas = E.renderer.getContextAttributes().antialias, now = E.post.antialias;
        const out = { medium: at('medium'), low: at('low') };
        // the choice is for the next launch: the canvas and the chain are as they were, and an engine made after it starts with it
        out.same = E.renderer.getContextAttributes().antialias === canvas && E.post.antialias === now;
        const stored = localStorage.getItem(E.saves.storageKey('msaa'));
        E.dispose();
        const N = mk(createEngine, 'v-low'); out.next = N.renderer.getContextAttributes().antialias; N.dispose(); q.back();
        localStorage.removeItem('v-low-msaa');
        return { ...out, stored, canvas };
      });
      check('Medium has no post chain on this game with no effects', r.medium.active === false, J(r));
      check('Low does no more work per frame than Medium', r.low.active === false && r.low.chain === false, J(r));
      check('nothing about MSAA changes during the run', r.same, J(r));
      check('the next launch starts with the choice', r.next === false || !r.canvas, J(r));
    },
  },
  {
    name: '[guard] settings row that does not exist: set() refuses it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { all } = threedogThreads, q = vQuiet();
        // the camera tab is optional: without it the row was never defined, and the docs name the key
        const E = await vCam('v-row', vFollow, all.settings());
        const f0 = E.camera.fov; let threw = null;
        try { E.settings.set('camera.fov', 90); } catch (err) { threw = err.code ?? String(err); }
        E.step(0.05);
        const out = { f0, fov: E.camera.fov, read: E.settings.get('camera.fov'), threw, warned: q.said.some(s => /camera\.fov/.test(s)) };
        E.dispose(); q.back();
        return out;
      });
      check('the row was not there, so the camera did not change', r.fov === r.f0, J(r));
      check('the caller is told', !!r.threw || r.warned, J(r));
      check('get() does not report a value that is not in effect', r.threw || r.read !== 90, J(r));
    },
  },
  {
    name: '[guard] quality and tier: the player\'s preset reaches everything that reads engine.tier',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all } = threedogThreads, q = vQuiet();
        const E = mk(createEngine, 'v-tier'); E.use(all.settings(), all.particles()); await E.start();
        E.tier = 'high'; E.settings.preset('high'); const high = E.particles.define('a').max;
        E.settings.preset('low'); const low = E.particles.define('b').max;
        E.tier = 'low'; E.settings.preset('high'); const weakHigh = E.particles.define('c').max;
        await E.unuse('settings'); const back = E.tier;
        E.dispose(); q.back();
        return { high, low, weakHigh, back };
      });
      check('the count is readable', r.high > 0, J(r));
      check('one quality decides: Low on a strong device gives the budget of Low', r.low < r.high, J(r));
      check('one quality decides: High on a weak device gives the budget of High', r.weakHigh === r.high, J(r));
      check('the module leaving hands engine.tier back to the device', r.back === 'low', J(r));
    },
  },
];
