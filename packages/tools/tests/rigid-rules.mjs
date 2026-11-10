// The rigid module's replaceable parts on real Rapier, in Node: rule 'fall', rigid({ fallbackFloor }), rule 'ragdoll.graph', the collider3d contract.
// The "no way around it" checks: the source keeps no second fall decision (no literal height in the step, no preventDefault on character:fall),
// ragdoll.js knows no body part by name (a human is only the default graph), and rigid holds the collider3d slot, so callers ask the capability, not the module.
import { fakeSaves } from './fixtures/fake-saves.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { ENGINE } from '../paths.mjs';
import { runContract } from '@threedog/tools/contract';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const THREE = await import('three');
const { Stacks } = await imp('core/ops/stacks.js');
const { rigid } = await imp('modules/rigid/RigidBodies.js');

export const name = 'rigid rules: fall on real Rapier, fallbackFloor, ragdoll graph, collider3d';

/** The small engine the rigid module reads: flat ground without collision of its own, no water, one world channel */
export async function physics(opts) {
  const e = { i18n: { add() {} }, movement: { radius: 0.3, height: 1.8 }, rays: { addProvider() {} }, events: { on: () => ({ remove() {} }), emit() {} }, stream: { _sources: [] }, collision: { mirror: () => ({ sync() {}, clear() {} }) },
    time: { dt: () => 1 / 60 }, focus: new THREE.Vector3(), surface: () => 0, waterAt: () => -Infinity, _poses: { add: () => ({ remove() {} }) }, add() {},
    ground: { voidY: () => -Infinity, has: () => true, forEachCollider() {} }, assets: { animatorOf: () => null } };
  e.stacks = new Stacks(e); e.mod = (n, o) => e.stacks.mod(n, o);
  const mod = rigid(opts);
  const r = mod.install(e, { name: 'rigid', track: h => h, rule: (n, d, l) => e.stacks.rule(n, d, l), budget: { metric() {} }, stream: { addReadyCheck() {} }, saves: fakeSaves() });
  await r.init();
  return { e, r, mod, steps: n => { for (let i = 0; i < n; i++) r.step(1 / 60); } };
}
/** A skinned model from { name: [parent, x, y, z] } (local offsets), one box of vertices per bone, in a scene so the ragdoll keeps it */
function skinned(tree, scale = 1) {
  const bones = {}, list = [];
  for (const [n, [parent, x, y, z]] of Object.entries(tree)) {
    const b = bones[n] = new THREE.Bone(); b.name = n; b.position.set(x, y, z); list.push(b);
    if (parent) bones[parent].add(b);
  }
  const root = new THREE.Group(), scene = new THREE.Scene(); scene.add(root);
  const pos = [], idx = [], wt = [];
  root.add(list[0]); root.updateMatrixWorld(true);
  list.forEach((b, i) => { const c = b.getWorldPosition(new THREE.Vector3());  for (const d of [-0.05, 0.05]) for (const k of [-0.05, 0.05]) { pos.push(c.x + d, c.y + k, c.z); idx.push(i, 0, 0, 0); wt.push(1, 0, 0, 0); } });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));
  root.scale.setScalar(scale); root.updateMatrixWorld(true);   // scaled after binding, like an exported 0.01 model
  return { root, mesh, bones };
}
const WOLF = { Spine: [null, 0, 1, 0], Chest: ['Spine', 0, 0, 0.5], Head: ['Chest', 0, 0.2, 0.4], Nose: ['Head', 0, 0, 0.2], FrontL: ['Chest', 0.2, -0.4, 0], PawFL: ['FrontL', 0, -0.4, 0], FrontR: ['Chest', -0.2, -0.4, 0], PawFR: ['FrontR', 0, -0.4, 0],
  BackL: ['Spine', 0.2, -0.4, 0], PawBL: ['BackL', 0, -0.4, 0], BackR: ['Spine', -0.2, -0.4, 0], PawBR: ['BackR', 0, -0.4, 0], Tail1: ['Spine', 0, 0.1, -0.4], Tail2: ['Tail1', 0, 0, -0.4] };
const WOLF_GRAPH = { body: { bone: 'Spine', mass: 20 }, chest: { bone: 'Chest', parent: 'body', mass: 15 }, head: { bone: 'Head', parent: 'chest', mass: 4 },
  legFL: { bone: 'FrontL', parent: 'chest', kind: 'leg' }, legFR: { bone: 'FrontR', parent: 'chest', kind: 'leg' }, legBL: { bone: 'BackL', parent: 'body', kind: 'leg' }, legBR: { bone: 'BackR', parent: 'body', kind: 'leg' },
  tail: { bone: 'Tail1', parent: 'body', mass: 1 } };
const HUMAN = { Hips: [null, 0, 1, 0], Spine: ['Hips', 0, 0.3, 0], Head: ['Spine', 0, 0.4, 0], Top: ['Head', 0, 0.2, 0], LeftArm: ['Spine', 0.2, 0.25, 0], LeftForeArm: ['LeftArm', 0.3, 0, 0], LeftHand: ['LeftForeArm', 0.25, 0, 0], RightArm: ['Spine', -0.2, 0.25, 0], RightForeArm: ['RightArm', -0.3, 0, 0], RightHand: ['RightForeArm', -0.25, 0, 0],
  LeftUpLeg: ['Hips', 0.1, -0.05, 0], LeftLeg: ['LeftUpLeg', 0, -0.45, 0], LeftFoot: ['LeftLeg', 0, -0.45, 0], RightUpLeg: ['Hips', -0.1, -0.05, 0], RightLeg: ['RightUpLeg', 0, -0.45, 0], RightFoot: ['RightLeg', 0, -0.45, 0] };
const massOf = rd => Object.values(rd.parts).reduce((n, p) => n + p.body.mass(), 0);
const finite = rd => Object.values(rd.parts).every(p => { const t = p.body.translation(); return [t.x, t.y, t.z].every(Number.isFinite); });
const failCode = f => { try { f(); return 'no throw'; } catch (x) { return x.code; } };
const box = () => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); m.parent = new THREE.Group(); return m; };

export async function run({ check }) {
  {
    const { e, r, steps } = await physics();
    const b = r.addBox(box(), { id: 'crate' });
    b.body.setTranslation({ x: 0, y: -201, z: 0 }, true); b.body.wakeUp();
    steps(1);
    check('fall default: the engine rescues nothing, the body stays down', b.body.translation().y < -200, String(b.body.translation().y));
    const chosen = e.mod('fall', { owner: 'game', id: 'crate', set: 'rescue' });
    b.body.setTranslation({ x: 0, y: 5, z: 0 }, true); b.body.wakeUp();
    steps(1);
    b.body.setTranslation({ x: 0, y: -201, z: 0 }, true); b.body.wakeUp();
    steps(1);
    check("fall 'rescue', the game's choice: below the line a body comes back above the ground", b.body.translation().y === 2, String(b.body.translation().y));
    chosen.remove();
    const asked = [];
    e.mod('fall', { owner: 'game', id: 'crate', set: f => { asked.push(f); return false; } });
    b.body.setTranslation({ x: 0, y: -201, z: 0 }, true); b.body.wakeUp();
    steps(5);
    check('fall function false: asked once per fall with the facts, the body stays down', asked.length === 1 && asked[0].kind === 'body' && asked[0].who === b && b.body.translation().y < -200, `${asked.length} ${b.body.translation().y}`);
    b.body.setTranslation({ x: 0, y: 5, z: 0 }, true); b.body.wakeUp();
    steps(1);
    b.body.setTranslation({ x: 0, y: -201, z: 0 }, true); b.body.wakeUp();
    steps(1);
    check('... and asked again on the next fall', asked.length === 2, String(asked.length));
  }
  {
    const floored = await physics(), bare = await physics({ fallbackFloor: false });
    check('fallbackFloor: default keeps the plane, false has no collider but the player capsule', floored.r.world.colliders.len() === 2 && bare.r.world.colliders.len() === 1, `${floored.r.world.colliders.len()} ${bare.r.world.colliders.len()}`);
  }
  {
    const { e, r, steps } = await physics();
    const human = skinned(HUMAN), rd = r.ragdoll(human.root, { impulse: [0, 10, 0] });
    steps(2);
    check('humanoid is the default graph: 11 parts, the masses it always had, hips leads', Object.keys(rd.parts).length === 11 && Math.abs(massOf(rd) - 70.7) < 0.01 && rd.parts.hips === r._ragdolls.live.values().next().value.list[0].entry, String(massOf(rd)));
    rd.remove();
    const heavy = skinned(HUMAN), rh = r.ragdoll(heavy.root, { mass: 100 });
    steps(1);
    check('rigid.ragdoll({ mass }) keeps the proportions', Math.abs(massOf(rh) - 100) < 0.01 && Math.abs(rh.parts.hips.body.mass() - 16 / 1.01) < 0.01, String(rh.parts.hips.body.mass()));
    rh.remove();
    check('a wolf has no human bones: the default graph still says what is missing', failCode(() => r.ragdoll(skinned(WOLF).root)) === 'rigid-misuse');

    e.mod('ragdoll.graph', { owner: 'game', set: WOLF_GRAPH });
    const wolf = skinned(WOLF), rw = r.ragdoll(wolf.root, { limits: { leg: { bend: [-0.5, 0.5] } } }), y0 = wolf.bones.Spine.getWorldPosition(new THREE.Vector3()).y;
    check('a four-legged graph: its parts and masses', Object.keys(rw.parts).join() === 'body,chest,legBL,legBR,tail,head,legFL,legFR' || Object.keys(rw.parts).length === 8, Object.keys(rw.parts).join());
    check('... mass in kg, unnamed parts share 70 evenly', Math.abs(rw.parts.body.body.mass() - 20) < 0.01 && Math.abs(rw.parts.legFL.body.mass() - 70 / 8) < 0.01, String(rw.parts.legFL.body.mass()));
    const live = [...r._ragdolls.live][0];
    check('... limits by kind reach its joints', live.list.find(p => p.name === 'legFL').range[2][0] <= -0.5 && live.list.find(p => p.name === 'legFL').range[2][1] < 0.6 && live.joints.length === 7, JSON.stringify(live.list.find(p => p.name === 'legFL').range));
    steps(180);
    check('... it falls under gravity, stays in one piece and its bones follow', finite(rw) && wolf.bones.Spine.getWorldPosition(new THREE.Vector3()).y < y0 - 0.2 && rw.parts.tail.body.translation().y > -1, String(wolf.bones.Spine.getWorldPosition(new THREE.Vector3()).y));
    check('... a torn joint would stretch the body: tail stays within reach of the body', new THREE.Vector3().subVectors(rw.parts.tail.body.translation(), rw.parts.body.body.translation()).length() < 1, '');
    rw.remove();
    const tiny = skinned(WOLF, 0.1), rt = r.ragdoll(tiny.root);
    check('a scaled model: colliders use its real size', Math.abs([...r._ragdolls.live][0].list[0].rad - [...r._ragdolls.live][0].list[0].shape.radius * 0.1) < 1e-4);
    rt.remove();
    check('bones belongs to the humanoid graph', failCode(() => r.ragdoll(skinned(WOLF).root, { bones: { hips: 'Spine' } })) === 'rigid-misuse');
  }
  {
    const { e, r } = await physics();
    const h = e.mod('ragdoll.graph', { owner: 'game', set: { a: { bone: 'Spine' }, b: { bone: 'Chest' } } });
    check('a graph with two roots is refused by name', failCode(() => r.ragdoll(skinned(WOLF).root)) === 'rigid-misuse');
    h.remove();
    const h2 = e.mod('ragdoll.graph', { owner: 'game', set: { a: { bone: 'Chest' }, b: { bone: 'Spine', parent: 'a' } } });
    check('a parent that is not above the bone is refused', failCode(() => r.ragdoll(skinned(WOLF).root)) === 'rigid-misuse');
    h2.remove();
    const h3 = e.mod('ragdoll.graph', { owner: 'game', set: { a: { bone: 'Nope' }, b: { bone: 'Spine', parent: 'a' } } });
    check('a bone that is not there is refused', failCode(() => r.ragdoll(skinned(WOLF).root)) === 'rigid-misuse');
    h3.remove();
    e.mod('ragdoll.graph', { owner: 'game', set: false });
    check('false: no ragdoll, null and nothing held', r.ragdoll(skinned(HUMAN).root) === null && r.bodies.length === 0);
  }
  {
    const { r, mod, steps } = await physics({ fallbackFloor: false });
    const contract = (await imp('modules/rigid/collider3d.contract.js')).default;
    runContract(contract, () => r, { check, label: 'collider3d (rigid)' });
    check('rigid holds the collider3d slot', mod.provides.includes('collider3d'));
    for (const s of [...r._solids]) s.remove();
    steps(1);
    check('removed solids are gone', r._solids.size === 0 && r.world.colliders.len() === 1, String(r.world.colliders.len()));
    const ramp = r.addSolid({ position: [0, 5, 0], size: [10, 1, 10], rotation: [0, 0, Math.PI / 4] });
    steps(1);
    const hit = r.sweep([0, 20, 0], [0, -20, 0], 0.5);
    check('a tilted box stops a ball where it really is, with a tilted normal', hit && hit.distance > 12 && hit.distance < 15 && Math.abs(hit.normal.x + Math.SQRT1_2) < 0.01 && Math.abs(hit.normal.y - Math.SQRT1_2) < 0.01, JSON.stringify(hit));
    check('overlap is true inside and false beside the tilted box (its corner would hold a flat box)', r.overlap([0, 5, 0], 0.1) && !r.overlap([4, 1, 0], 0.1));
    check('a clear sweep is null', r.sweep([20, 20, 0], [20, -20, 0], 0.5) === null);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3)); ball.parent = new THREE.Group(); ball.position.set(0, 9, 0);
    const b = r.addBall(ball, { radius: 0.3 });
    steps(120);
    check('a body rolls off the tilted solid, down its slope', b.body.translation().x < -1, String(b.body.translation().x));
    r._fresh();
    steps(1);
    check('a world rebuild keeps the solid', r.overlap([0, 5, 0], 0.1));
    ramp.remove(); ramp.remove();
    steps(1);
    check('remove() twice is safe', !r.overlap([0, 5, 0], 0.1));
  }
  {
    const e0 = await physics();
    const code = failCode(() => e0.r.addSolid({ position: [0, 0, 0] })), both = failCode(() => e0.r.addSolid({ position: [0, 0, 0], size: [1, 1, 1], radius: 1 }));
    check('addSolid: exactly one of size and radius', code === 'rigid-misuse' && both === 'rigid-misuse');
  }
  const rag = readFileSync(join(ENGINE, 'modules/rigid/ragdoll.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  check('ragdoll.js names no human part: the humanoid is data', !/hips|upperLeg|lowerLeg|chest|PARTS|SHARE|LIMITS/.test(rag), (rag.match(/hips|upperLeg|lowerLeg|chest|PARTS|SHARE|LIMITS/) ?? [])[0]);
  const body = readFileSync(join(ENGINE, 'modules/rigid/RigidBodies.js'), 'utf8'), chars = readFileSync(join(ENGINE, 'modules/characters/movers/support.js'), 'utf8');
  check('one decision: the height lives in FALL_Y and only _fallen reads it; preventDefault on character:fall stays gone', (body.match(/FALL_Y/g) ?? []).length === 2 && !/-200\b/.test(body.replace(/const FALL_Y = -200;/, '')) && !/preventDefault/.test(chars));
}
