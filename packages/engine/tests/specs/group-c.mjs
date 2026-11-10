// Group C (GPT layer-2 review, characters and physics): one check per root cause, each fails with its fix reverted.
//   lifecycle: player.dispose() (1), rigid unloaded during its WASM load (2), nav debug helper after unload (8)
//   who drives the Animator: the character's time channel (4), a model with no clips fires onPose (11)
//   one source of truth: rapier player capsule takes the character radius (6), crowd steps aside for passes (9)
//   others: vehicle chassis under a moved parent (3), an async generator runs once (5), A* edges (10, plain node import)
import { findPath } from '../../modules/characters/astar.js';

export const specs = [
  {
    name: 'group C: A* does not step through a thin wall between two free cells (10)',
    url: '/tests/nav/index.html',   // the runner wants a page; the check itself is plain node
    async run({ check }) {
      // a thin wall on the line x + z = 1 between the free cells (0,0) and (1,1) of a 1 m grid
      const wall = (x, z) => Math.abs(x + z - 1) < 0.3 && x > -0.5 && x < 1.5 && z > -0.5 && z < 1.5;
      const path = findPath((x, z) => !wall(x, z), 0, 0, 1, 1, { step: 1 });
      let hits = 0;
      for (let i = 0; path && i + 1 < path.length; i++) { const a = path[i], b = path[i + 1], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02); for (let k = 0; k <= n; k++) if (wall(a.x + (b.x - a.x) * k / n, a.z + (b.z - a.z) * k / n)) hits++; }
      check('the route goes round the wall (no sample of any leg inside it)', !!path && hits === 0, JSON.stringify({ path, hits }));
      // a box (or a door's frame) at x 3.8..5: a cell centre inside it is not walkable, but a character standing against it, or a target next to it, is
      const box = (x, z) => x > 3.8 && x < 5 && Math.abs(z) < 3, ok = (x, z) => !box(x, z);
      const toBox = findPath(ok, 0, 0, 3.7, 0, { step: 1 }), fromBox = findPath(ok, 3.7, 0, 0, 0, { step: 1 });
      check('a target against a wall (its cell centre inside it) still gets a path', !!toBox && Math.abs(toBox.at(-1).x - 3.7) < 1e-9, JSON.stringify(toBox));
      check('a start against a wall (its cell centre inside it) still gets a path', !!fromBox && Math.abs(fromBox[0].x - 3.7) < 1e-9, JSON.stringify(fromBox));
    },
  },
  {
    name: 'group C: player.dispose(), the Animator takes the time channel, a clip-less model fires onPose, an async generator runs once (1, 4, 11, 5)',
    url: '/tests/anim/index.html',
    expectErrors: /boom/,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const { Character, THREE } = window, out = {};
        // 4: the channel slows the clip time, not only the walk cycle (mixer.time adds dt * time scale)
        const m = engine.player.anim.mixer, m0 = m.time; engine.step(0.5);
        const full = m.time - m0;
        const slow = engine.mod('time.local', { owner: 'groupC', id: engine.player.id, set: 0.1 });
        const m1 = m.time; engine.step(0.5); out.slowed = m.time - m1; out.full = full; slow.remove();
        // 11: a model with no clips has an Animator without a frame hook: onPose still fires every frame
        const plain = new Character(engine, { model: new THREE.Group() }); engine.add(plain.root); engine.onFrame(dt => plain.animate(dt));
        out.noClips = { anim: !!plain.anim, hook: !!plain.anim?._hook }; let poses = 0; plain.onPose(() => poses++);
        engine.step(0.2); out.poses = poses;
        // 5: an async generator runs once per character; a rejecting one is handled (no unhandled rejection)
        let calls = 0, rej = 0;
        const onRej = ev => { rej++; ev.preventDefault(); };
        addEventListener('unhandledrejection', onRej);
        engine.assets.manifest({ models: { gcAsync: async () => { calls++; const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); return g; }, gcBad: async () => { await 0; throw new Error('boom'); } }, name: 'group-c' });
        const a = new Character(engine, { model: 'gcAsync' }); engine.add(a.root); await a.whenReady;
        out.calls = calls; out.swapped = a.ready && !!a.root.children.length;
        const b = new Character(engine, { model: 'gcBad' }); engine.add(b.root); await b.whenReady; await new Promise(res => setTimeout(res, 50));
        removeEventListener('unhandledrejection', onRej); out.rej = rej;
        // 1: the player's own dispose() is the same teardown as removePlayer
        const p = engine.player; p.dispose();
        out.player = { current: engine.player === null, record: !!engine.world.get('player') };
        return out;
      });
      check('4: clip time follows the character\'s time channel (0.1 of normal)', r.full > 0.4 && r.slowed < 0.1, JSON.stringify([r.full, r.slowed]));
      check('11: a clip-less model has an Animator but no frame hook, and onPose fires', r.noClips.anim && !r.noClips.hook && r.poses > 0, JSON.stringify([r.noClips, r.poses]));
      check('5: the async generator ran once and its model arrived; the rejection was handled', r.calls === 1 && r.swapped && r.rej === 0, JSON.stringify([r.calls, r.swapped, r.rej]));
      check('1: player.dispose() leaves no engine.player and no world record', r.player.current && r.player.record === false, JSON.stringify(r.player));
    },
  },
  {
    name: 'group C: rigid unloaded during its WASM load makes no world (2); vehicle chassis under a moved parent (3); rapier player capsule follows the radius (6)',
    url: '/tests/vehicle/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.car, null, { timeout: 30000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const { THREE } = window, out = {};
        // 3: the chassis box is measured in the mesh's own axes, whatever its parent does
        const parent = new THREE.Group(); parent.position.set(30, 0, 40); engine.add(parent);
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), new THREE.MeshBasicMaterial()); body.position.set(0, 1.5, 0); parent.add(body); engine.scene.updateMatrixWorld(true);   // a drawn scene has its world matrices; the old code read them as they were
        const v = engine.rigid.addWheeled(body, { wheels: [[-0.85, 1.2], [0.85, 1.2], [-0.85, -1.2], [0.85, -1.2]].map(([x, z]) => ({ position: [x, 0, z], radius: 0.35, drive: true })) });
        const t = v.body.collider(0).translationWrtParent(), h = v.body.collider(0).halfExtents();
        out.box = { off: Math.hypot(t.x, t.y, t.z), half: [h.x, h.y, h.z] };
        // 3b: a sprite on the car does not widen the chassis; a mirrored box keeps its size
        const tag = new THREE.Sprite(); tag.scale.set(20, 20, 1); body.add(tag);
        const body2 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), new THREE.MeshBasicMaterial()); body2.position.set(0, 1.5, 0); parent.add(body2); body2.add(tag.clone());
        engine.scene.updateMatrixWorld(true);
        const v2 = engine.rigid.addWheeled(body2, { wheels: [{ position: [0.85, 0, 1.2], radius: 0.35, drive: true }] });
        out.tagged = v2.body.collider(0).halfExtents().x;
        const mirror = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), new THREE.MeshBasicMaterial()); mirror.scale.x = -1; mirror.position.set(5, 3, 5); engine.add(mirror);
        const mb = engine.rigid.addBox(mirror, { mass: 1 }); out.mirror = mb.body.collider(0).halfExtents().x;
        // 6: the player's capsule is the character's radius (rigid's playerCapsule is only the default)
        engine.characters.removePlayer();
        const p = engine.characters.addPlayer({ control: () => {}, radius: 1, mover: 'rapier', spawn: { x: 0, z: 0 } });
        const hold = engine.control.take(p, { owner: 'groupC', layer: 'script' }); hold.move(0, 1, false, 1 / 60); hold.remove(); engine.step(0.05);
        out.radius = engine.rigid.playerCollider.radius();
        // 6b: a radius the game wrote in rigid({ playerCapsule }) wins over the character's
        const rg = engine.rigid; engine.characters.removePlayer(); rg._capsuleRadiusGiven = true; rg.playerCapsule = { ...rg.playerCapsule, radius: 0.5 }; rg.playerCollider.setRadius(0.5);
        const q = engine.characters.addPlayer({ control: () => {}, radius: 1, mover: 'rapier', spawn: { x: 0, z: 0 } });
        const hold2 = engine.control.take(q, { owner: 'groupC', layer: 'script' }); hold2.move(0, 1, false, 1 / 60); hold2.remove(); engine.step(0.05);
        out.given = rg.playerCollider.radius();
        return out;
      });
      check('3: the vehicle collider is offset by the mesh-local center (0), not by the parent\'s 30 / 40', r.box.off < 0.01 && Math.abs(r.box.half[2] - 1.8) < 0.01, JSON.stringify(r.box));
      check('3b: a sprite on the car does not widen the chassis box', Math.abs(r.tagged - 0.9) < 0.01, String(r.tagged));
      check('3c: a mirrored box (scale.x = -1) keeps its size', Math.abs(r.mirror - 1) < 0.01, String(r.mirror));
      check('6: the rapier player collider has the character radius 1', Math.abs(r.radius - 1) < 1e-6, String(r.radius));
      check('6b: an explicit rigid({ playerCapsule: { radius } }) wins over the character radius', Math.abs(r.given - 0.5) < 1e-6, String(r.given));
      // 2: install rigid at run time and unload it before its WASM is up: the late init must not build a world
      const w = await page.evaluate(async () => {
        const rigid = window.rigidModule, RB = engine.rigid.constructor;
        engine.unuse('rigid');
        let made = 0; const orig = RB.prototype._newWorld; RB.prototype._newWorld = function () { made++; return orig.apply(this, arguments); };
        try { engine.use(rigid()); engine.unuse('rigid'); await new Promise(res => setTimeout(res, 800)); } finally { RB.prototype._newWorld = orig; }
        return made;
      });
      check('2: no Rapier world is made after the module was unloaded', w === 0, String(w));
    },
  },
  {
    name: 'group C: nav debug helper after unload (8); a crowd leaves NPCs with passes to the path entry (9)',
    url: '/tests/nav/index.html?crowd=1',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.nav?.ready, null, { timeout: 30000 });
      const r = await ev(async () => {
        engine.haltLoop(); const out = {};
        let rej = 0; const onRej = ev => { rej++; ev.preventDefault(); }; addEventListener('unhandledrejection', onRej);
        // 8: a build starts (debug import pending), the level leaves before the import comes back
        engine.events.emit('level:loaded', {}); engine.events.emit('level:unloaded', {});
        await new Promise(res => setTimeout(res, 300));
        removeEventListener('unhandledrejection', onRej);
        out.helper = engine.nav.helper === null && !engine.scene.getObjectByProperty('type', 'NavMeshHelper'); out.rej = rej;
        return out;
      });
      check('8: no debug helper is built for a mesh that was unloaded meanwhile', r.helper && r.rej === 0, JSON.stringify(r));
      const c = await ev(async () => {
        engine.events.emit('level:loaded', {});   // a level is up again: a fresh mesh (helper included) and crowd
        for (let i = 0; i < 200 && !engine.nav.ready; i++) await new Promise(res => setTimeout(res, 50));
        const go = (name, extra) => engine.npcs.add({ name, position: { x: 4, z: -5 }, schedule: [{ at: 0, position: { x: 4, z: 5 } }], ...extra });
        const plain = go('gcPlain'), gated = go('gcGated', { passes: ['gate'] });
        for (let i = 0; i < 90; i++) engine.step(1 / 60, { render: false, describe: false });
        const ch = n => engine.npcs.character(n.id);
        return { crowd: !!engine.nav.crowd, plain: !!ch(plain)?._agent, gated: ch(gated) ? !ch(gated)._agent : null };
      });
      check('9: a crowd NPC gets an agent, one with passes does not (it takes the path entry)', c.crowd && c.plain && c.gated === true, JSON.stringify(c));
    },
  },
];
