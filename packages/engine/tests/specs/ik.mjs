// IK 是 Animator 的最后一层（core/assets/ik.js）：头看目标、脚踩地面。用真骨骼素材 King（tests/anim），因为它的脚骨不挂在小腿下（挂在 Root 下），
// 骨头沿 +Y 长，正好是"每套骨架不一样"的那种：只在手搓的标准骨架上能过的写法，这里会露馅。
// SETUP 以源码传进页面（ev 只收一个参数，函数传不过去）。
// 为什么用 sync 冻住姿态再手动 update：动画姿态每次一样，"权重 0 / remove() 后姿态和没加 IK 完全一样"才能逐个数比较。

const SETUP = () => {
  engine.haltLoop();
  const p = engine.player, a = p.anim, model = a.root, v = new THREE.Vector3();
  a.sync('idle', 0.3);
  const run = n => { for (let i = 0; i < n; i++) a.update(1 / 30); model.updateMatrixWorld(true); };
  const pose = () => { const out = []; model.traverse(o => { if (o.isBone) out.push(...o.quaternion.toArray(), ...o.position.toArray()); }); return out; };
  const diff = (x, y) => Math.max(...x.map((n, i) => Math.abs(n - y[i])));
  const at = name => model.getObjectByName(name).getWorldPosition(v).clone();
  return { p, a, model, run, pose, diff, at };
};

export const specs = [
  {
    name: 'IK aim: the head turns onto a target inside the limit, stops at the limit beyond it; weight 0 and remove() leave the animation pose',
    url: '/tests/anim/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
      const r = await ev(async src => {
        const { a, model, run, pose, diff, at } = eval(`(${src})`)();
        run(3);
        const base = pose(), head = model.getObjectByName('Head'), q0 = head.getWorldQuaternion(new THREE.Quaternion());
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()));   // the model's front
        let anim0 = null;   // where the idle animation points the head: the forward IK read from the bind pose, on the animated head
        // where the head looks now: the animated look turned by what IK added to the head's world rotation
        const look = () => anim0.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).multiply(q0.clone().invert())).normalize();
        const deg = (u, w) => Math.acos(Math.max(-1, Math.min(1, u.dot(w)))) * 180 / Math.PI;
        const hp = at('Head');
        const inside = hp.clone().add(new THREE.Vector3(1.4, -0.4, 0).add(fwd.clone().multiplyScalar(2.5)));
        const h = a.addAim({ bones: ['Neck', 'Head'], target: inside, limit: 60 });
        anim0 = a._ik[0].fwd.clone().applyQuaternion(q0).normalize();
        const ahead = deg(anim0, fwd);
        run(45);
        const toInside = deg(look(), inside.clone().sub(at('Head')).normalize());
        const shown = a.describe().ik;
        // behind and to the side, 130 degrees away: stops at the 60 degree limit
        h.set({ target: hp.clone().add(anim0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 130 * Math.PI / 180).multiplyScalar(3)) });
        run(45);
        const atLimit = deg(look(), anim0);
        h.set({ weight: 0 }); run(15);
        const w0 = diff(pose(), base);
        h.set({ weight: 1 }); run(30);   // set({ weight }) keeps the target
        const moved = diff(pose(), base);
        h.remove();
        const removedNow = diff(pose(), base); run(2);
        return { ahead, toInside, atLimit, w0, moved, removedNow, removedLater: diff(pose(), base), shown, after: a.describe().ik ?? null };
      }, SETUP.toString());
      check('the forward read from the bind pose is the model front, not a bone axis (idle head within 8 degrees of it)', r.ahead < 8, JSON.stringify(r));
      check('inside the limit the head ends on the target (within 2 degrees)', r.toInside < 2, JSON.stringify(r));
      check('beyond the limit it stops at the limit (60 +- 3 degrees)', Math.abs(r.atLimit - 60) < 3, JSON.stringify(r));
      check('weight 0 leaves the animation pose exactly', r.w0 < 1e-9 && r.moved > 0.01, JSON.stringify(r));
      check('remove() puts the animation pose back at once and for good', r.removedNow < 1e-9 && r.removedLater < 1e-9, JSON.stringify(r));
      check('describe() lists the layer while it is on', r.shown?.[0]?.kind === 'aim' && r.shown[0].bones.join() === 'Neck,Head' && r.after === null, JSON.stringify(r));
    },
  },
  {
    name: 'IK feet: a foot over a step stands on it, a foot off a ledge reaches down with the hips lowered, through the characters ground; remove() restores',
    url: '/tests/anim/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
      const r = await ev(async src => {
        const { p, a, model, run, pose, diff, at } = eval(`(${src})`)();
        run(3);
        const base = pose(), L0 = at('FootL'), R0 = at('FootR'), H0 = at('Body'), s = Math.sign(L0.x - p.root.position.x) || 1;
        // a 15 cm step under the left foot only (not under the body's centre): a platform, so only the characters' ground knows about it
        const step = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.8), new THREE.MeshBasicMaterial());
        step.position.set(L0.x + s * 0.2, 0.075, L0.z); engine.scene.add(step);
        const sup = engine.characters.support(step);
        const feet = a.addFeet();
        run(30);
        const up = { L: at('FootL').y - L0.y, R: at('FootR').y - R0.y };
        // the body stands 15 cm up on a ledge that ends before the left foot: the left foot reaches down, the hips go down with it
        sup.remove(); step.geometry = new THREE.BoxGeometry(1, 0.15, 0.8); step.position.set(L0.x - s * 0.55, 0.075, L0.z);
        const sup2 = engine.characters.support(step);
        p.root.position.y = 0.15; run(30);
        const down = { L: at('FootL').y - L0.y, R: at('FootR').y - R0.y, hips: at('Body').y - H0.y };
        // in the air the feet are off at once (no fade over the cached corrections): one frame later the pose is the animation's
        p.grounded = false; run(1); const air = diff(pose(), base); p.grounded = true;
        feet.remove(); p.root.position.y = 0; run(2);
        const back = diff(pose(), base);
        sup2.remove(); step.removeFromParent();
        return { up, down, back, air };
      }, SETUP.toString());
      check('the foot over the step ends at the step height (15 cm +- 3 cm), the other stays (+- 2 cm)', Math.abs(r.up.L - 0.15) < 0.03 && Math.abs(r.up.R) < 0.02, JSON.stringify(r));
      check('off the ledge the left foot reaches the floor (+- 3 cm), the right stays on the ledge, the hips lower', Math.abs(r.down.L) < 0.03 && Math.abs(r.down.R - 0.15) < 0.03 && r.down.hips < 0.15 - 0.1, JSON.stringify(r));
      check('remove() leaves the animation pose', r.back < 1e-9, JSON.stringify(r));
      check('airborne the feet layer is off at once', r.air < 1e-9, JSON.stringify(r));
    },
  },
  {
    name: 'IK edges: dispose puts unkeyed bones back and ends the handles; removing one of two layers on a bone keeps the other at once; degenerate and opposite two-bone chains',
    url: '/tests/anim/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
      const r = await ev(async src => {
        const { a, model, run, pose, diff } = eval(`(${src})`)();
        run(3);
        // a model without clips: no mixer track writes its "head", so only the IK snapshot can put it back
        const g = new THREE.Group(), neck = new THREE.Object3D(), head = new THREE.Object3D();
        neck.name = 'neck'; head.name = 'head'; neck.position.y = 1.5; head.position.y = 0.2; g.add(neck); neck.add(head); engine.scene.add(g);
        const q = () => head.quaternion.toArray();
        const m = engine.assets.animate(g), h0 = m.addAim({ bones: 'head', target: [2, 1.7, 1], forward: [0, 0, 1] });
        for (let i = 0; i < 30; i++) m.update(1 / 30);
        const turned = Math.abs(q()[1]) > 0.05;
        h0.remove(); const hookGone = m._hook === null;
        const h1 = m.addAim({ bones: 'head', target: [2, 1.7, 1], forward: [0, 0, 1] });
        for (let i = 0; i < 30; i++) m.update(1 / 30);
        const m2 = engine.assets.animate(g);   // replaces (disposes) m
        const disposed = { q: q(), set: (h1.set({ weight: 0.5 }), true), layers: m._ik.length };
        h1.remove(); m2.dispose(); g.removeFromParent();
        // two layers on one bone: removing the first leaves the second's turn in the pose right away
        const base = pose();
        const x1 = a.addAim({ bones: 'Head', target: [2, 1, 3], limit: 80 }), x2 = a.addAim({ bones: 'Head', target: [-2, 1.5, 3], limit: 80 });
        run(40);
        x1.remove(); const now = pose(); run(1);
        const overlap = { kept: diff(now, pose()), off: diff(now, base) };
        x2.remove();
        // two-bone corner cases straight from the solver
        const twoBone = window.twoBone;
        const V = (...v) => new THREE.Vector3(...v), rU = new THREE.Quaternion(), rM = new THREE.Quaternion();
        twoBone(V(0, 1, 0), V(0, 1, 0), V(0, 0, 0), V(0, 0.2, 0), V(0, 0, 1), rU, rM);
        const degenerate = [...rU.toArray(), ...rM.toArray()];
        const A = V(0, 1, 0), B = V(0, 0.5, 0.05), C = V(0, 0, 0), T = V(0, 1.9, 0);
        twoBone(A.clone(), B.clone(), C.clone(), T.clone(), V(0, 0, 1), rU, rM);
        const end = C.clone().sub(B).applyQuaternion(rM).add(B).sub(A).applyQuaternion(rU).add(A);
        return { turned, hookGone, disposed, overlap, degenerate, opposite: end.distanceTo(T) };
      }, SETUP.toString());
      check('a clip-less model turns, and its frame hook goes with its last layer', r.turned && r.hookGone, JSON.stringify(r));
      check('dispose / replace puts the unkeyed bone back and ends the layers (set on the old handle does nothing)', r.disposed.q.every((v, i) => Math.abs(v - [0, 0, 0, 1][i]) < 1e-9) && r.disposed.layers === 0, JSON.stringify(r));
      check('removing one of two layers on a bone keeps the other in the pose at once', r.overlap.kept < 1e-6 && r.overlap.off > 0.01, JSON.stringify(r));
      check('a chain with joints on top of each other gives identity, not NaN', r.degenerate.join() === '0,0,0,1,0,0,0,1', JSON.stringify(r));
      check('a target straight opposite the chain is still reached (half a turn)', r.opposite < 1e-3, JSON.stringify(r));
    },
  },
];
