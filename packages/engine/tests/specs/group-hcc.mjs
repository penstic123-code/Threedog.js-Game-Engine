// Group HC-C (docs/plans/research/2026-11-10-health-check-c.md 1, 2, 3): who owns what, one test item each so one throw stops no other.
// Known, not fixed: a game write that equals the diagnostic's own value cannot be told apart from the diagnostic and is lost on release (DebugOverrides._value).
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: '[guard] group HC-C 1: one object has one physics owner; a stale handle cannot delete a newer owner',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, E = mk(T.createEngine, 'hcc-own'), out = {};
        E.use(T.world(), T.collision(), T.rigid(), T.characters());
        await E.start(); E.haltLoop();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        const a = E.rigid.addBox(mesh, { id: 'a' });
        let err = null; try { E.rigid.addBall(mesh, { id: 'b' }); } catch (e) { err = e; }
        out.code = err?.code ?? err?.message?.slice(0, 40); out.names = /rigid body 'a'/.test(err?.message ?? '');
        out.bodies = E.rigid.bodies.length;   // the refused add left no Rapier body behind
        const p = E.characters.addPlayer({ control: 'camera' });
        let err2 = null; try { E.rigid.addBox(p.root, { id: 'on-root' }); } catch (e) { err2 = e; }
        out.chr = /character/.test(err2?.message ?? '');
        a.remove();
        const b = E.rigid.addBall(mesh, { id: 'b' });   // after the first owner left, the mesh is free
        out.again = !!b && E._poses.map.has(mesh);
        // the old owner's handle (taken before) does nothing to the newer entry
        const o = new THREE.Group(), h1 = E._poses.add(o); h1.remove(); const h2 = E._poses.add(o); h1.remove();
        out.stale = E._poses.map.has(o); h2.remove(); out.gone = !E._poses.map.has(o);
        E.dispose();
        return out;
      });
      check('a second owner throws and names the first; nothing leaks', r.code === 'rigid-misuse' && r.names && r.bodies === 1 && r.chr, JSON.stringify(r));
      check('after remove the mesh is free again; a stale handle leaves the newer entry', r.again && r.stale && r.gone, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC-C 2: a diagnostic override hands back the game\'s latest write, not the value from before it',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads, E = mk(T.createEngine, 'hcc-dbg'), out = {};
        E.use(T.debug());
        await E.start(); E.haltLoop();
        const o = { x: 1, ref: { n: 'old' } }, newer = { n: 'new' };
        const h = E.debug.override('t', o, 'x', 3), g = E.debug.override('t', o, 'ref', null);
        o.x = 0.5; o.ref = newer;                 // the game writes while the diagnostic is on
        E.step(1 / 30);                          // a frame: the diagnostic wins while it is active
        out.during = [o.x, o.ref];
        o.x = 0.25;                               // a write after the last frame, before the release
        h.remove(); g.remove();
        out.after = [o.x, o.ref === newer];
        const k = E.debug.override('t', o, 'x', 9); k.remove();   // no game write at all: the value from before comes back
        out.untouched = o.x;
        E.dispose();
        return out;
      });
      check('the diagnostic wins while active', r.during[0] === 3 && r.during[1] === null, JSON.stringify(r));
      check('on release the game\'s latest write comes back (scalar and reference)', r.after[0] === 0.25 && r.after[1] === true && r.untouched === 0.25, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC-C 3: a named view gets its pose and lens back when the shot above it releases',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads, E = mk(T.createEngine, 'hcc-view'), out = {};
        E.use(T.world(), T.collision(), T.characters(), T.timeline());
        await E.start(); E.haltLoop();
        const run = async s => { for (let t = 0; t < s - 1e-6; t += 0.05) { E.step(0.05, { render: false, describe: false }); await new Promise(q => setTimeout(q, 0)); } };
        const r3 = n => Math.round(n * 1000) / 1000, lens = () => [...E.camera.position.toArray().map(r3), r3(E.camera.fov)];
        E.views.define('gate', { position: [10, 4, 12], target: [0, 1, 0], fov: 50 });
        E.views.define('plain', { position: [-6, 3, 5], target: [0, 1, 0] });
        E.views.show('gate');
        out.shown = lens();
        const shot = E.timeline.play([{ camera: { to: { position: [40, 10, 0], lookAt: [0, 0, 0] }, duration: 0.5, ease: 'linear', fov: 30 } }], { actors: [] });
        let done = false; shot.then(() => { done = true; });
        await run(0.3);
        out.mid = lens();
        for (let i = 0; i < 40 && !done; i++) await run(0.05);
        out.back = lens(); out.current = E.views.current; out.claim = E.cameraOverride?.owner;
        // a view with no lens of its own shows the base lens after a shot with one
        E.views.show('plain');
        const s2 = E.timeline.play([{ camera: { to: { position: [40, 10, 0], lookAt: [0, 0, 0] }, duration: 0.5, ease: 'linear', fov: 30 } }], { actors: [] });
        let d2 = false; s2.then(() => { d2 = true; });
        for (let i = 0; i < 40 && !d2; i++) await run(0.05);
        out.plain = lens();
        E.dispose();
        return out;
      });
      check('the shot moved the camera, then the view\'s position and fov are back', r.mid[0] !== 10 && r.back.join() === '10,4,12,50' && r.current === 'gate' && r.claim === 'views', JSON.stringify(r));
      check('a view without a fov gets the base lens back, not the shot\'s', r.plain.slice(0, 3).join() === '-6,3,5' && r.plain[3] !== 30, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC-C 1b: unuse rigid, use it again, re-add a body on the same mesh',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, E = mk(T.createEngine, 'hcc-redo'), out = {};
        E.use(T.world(), T.collision(), T.rigid());
        await E.start(); E.haltLoop();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        E.rigid.addBox(mesh, { id: 'x' });
        E.unuse('rigid'); E.use(T.rigid()); await new Promise(q => setTimeout(q, 200));
        try { out.again = !!E.rigid.addBox(mesh, { id: 'x' }); } catch (e) { out.err = e.message.slice(0, 120); }
        E.dispose();
        return out;
      });
      check('after rigid is unused and used again, the same mesh takes a new body', r.again === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC-C 2b: two diagnostics on one key, cleared in either order, leave the game\'s value',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads, E = mk(T.createEngine, 'hcc-dbg2'), out = {};
        E.use(T.debug());
        await E.start(); E.haltLoop();
        const o = { x: 1 };
        for (const order of ['ab', 'ba']) {
          const a = E.debug.override('t', o, 'x', 3), b = E.debug.override('t', o, 'x', 5);
          E.step(1 / 30);
          ({ a, b })[order[0]].remove(); E.step(1 / 30); ({ a, b })[order[1]].remove();
          out[order] = o.x;
        }
        const a = E.debug.override('t', o, 'x', 3), b = E.debug.override('t', o, 'x', 5);
        o.x = 0.5; E.step(1 / 30); a.remove(); b.remove(); out.game = o.x;
        const c = E.debug.override('t', o, 'x', 2); o.x = 4; const d = E.debug.override('t', o, 'x', 3);   // a game write between two overrides, before any frame
        c.remove(); d.remove(); out.between = o.x;
        E.dispose();
        return out;
      });
      check('a game write made between two overrides, before a frame, comes back', r.between === 4, JSON.stringify(r));
      check('both orders return the game\'s value; a game write under the stack survives', r.ab === 1 && r.ba === 1 && r.game === 0.5, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group HC-C 4: a camera claim released after dispose does not put the view back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads, E = mk(T.createEngine, 'hcc-late'), out = {};
        E.use(T.world(), T.collision(), T.characters(), T.timeline());
        await E.start(); E.haltLoop();
        E.views.define('gate', { position: [10, 4, 12], target: [0, 1, 0], fov: 50 });
        E.views.show('gate');
        const shot = E.takeCamera('shot');
        E.camera.position.set(5, 5, 5);
        E.dispose();
        try { shot.remove(); } catch (e) { out.err = e.message.slice(0, 80); }
        out.pos = E.camera.position.toArray();
        return out;
      });
      check('the camera is left where it was', r.pos.join() === '5,5,5', JSON.stringify(r));
    },
  },
];
