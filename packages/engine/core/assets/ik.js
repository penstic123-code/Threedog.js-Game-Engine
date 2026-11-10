// Inverse kinematics as the Animator's last layer: bones that aim at a target (a head turning to look) and feet that stand on the ground (stairs, slopes).
//   const look = anim.addAim({ bones: ['Neck', 'Head'], target: engine.player.root, limit: 70 });   look.set({ target: null }); look.remove();
//   const feet = anim.addFeet();   // legs found by name; feet.set({ weight: 0 }) fades it out
// Why inside the Animator and not a second per-frame hook: a bone's pose has one owner. The order each frame is: put back the pose IK found last frame
// (a bone no clip keys would otherwise add the IK turn to itself every frame) -> the mixer -> remember this pose -> each IK layer in the order added
// -> onPose. Weight 0 therefore leaves exactly the animation pose, and remove() puts it back at once.
// Why only positions and the bind pose, never a bone axis: every rig points its bones another way (+Y along the bone in Blender exports, +X in others),
// so the head's "forward" is the model's forward read in the head's bind frame, and the legs bend in the plane the animation already bends them in.
// The ground is the Animator's ground query (engine.surface; a Character hands over its own, platforms included, characters/useModel.js): no second raycast path.
import * as THREE from 'three';
import { readParams, keysSchema } from '../base/params.js';
import { codedError } from '../base/errorHints.js';
import { missingText } from '../base/validate.js';

const AIM_KEYS = ['bones', 'target', 'limit', 'speed', 'weight', 'fade', 'forward'];
const FEET_KEYS = ['legs', 'hips', 'reach', 'far', 'speed', 'weight', 'fade', 'ground'];
const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), DEG = Math.PI / 180, EPS = 1e-6;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _s = new THREE.Vector3();
const clamp1 = v => Math.max(-1, Math.min(1, v));
const angle = (u, v) => Math.acos(clamp1(u.dot(v)));

/** World rotation of an object from its matrixWorld (the caller keeps it current) */
function wq(o, out) { o.matrixWorld.decompose(_p, out, _s); return out; }
/** Give o the world rotation q (its parent's matrixWorld is current) */
function setWq(o, q) { o.quaternion.copy(o.parent ? wq(o.parent, _q4).invert().multiply(q) : q); }

/** A bone (any Object3D) by name; the name as written in Blender ('Foot.L') also finds the glTF one ('FootL', three drops the dots) */
function boneOf(root, name, where) {
  const b = root.getObjectByName(name) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
  if (b) return b;
  const names = []; root.traverse(o => { if (o.isBone) names.push(o.name); });
  throw codedError('engine-misuse', `${where}: ${missingText('bone', name, names)}`);
}

/**
 * The two-bone answer (D. Holden, "Simple Two Joint IK"): world rotations for the upper and the middle joint that put the end c at t.
 * a, b, c: joint positions now; pole: where the middle joint bends when the chain is straight. Writes rUpper (applied to the upper joint, carries
 * everything below it) and rMid (applied to the middle joint in the pose before rUpper). Reaches as close as the bone lengths allow.
 * A chain with a zero-length part (joints on top of each other, a scaled-to-zero leg) has no triangle: both stay identity, never NaN.
 */
export function twoBone(a, b, c, t, pole, rUpper, rMid) {
  const lab = _d.subVectors(b, a).length(), lcb = _e.subVectors(b, c).length();
  rUpper.identity(); rMid.identity();
  if (lab < 1e-5 || lcb < 1e-5 || _a.subVectors(c, a).lengthSq() < 1e-10 || _t.subVectors(t, a).lengthSq() < 1e-10) return rUpper;
  const lat = Math.max(EPS, Math.min(_t.subVectors(t, a).length(), lab + lcb - 1e-4));
  const ac = _a.subVectors(c, a).normalize(), ab = _d.subVectors(b, a).normalize(), at = _t.subVectors(t, a).normalize();
  const ba = _b.subVectors(a, b).normalize(), bc = _e.subVectors(c, b).normalize();
  const acab0 = angle(ac, ab), babc0 = angle(ba, bc), acat0 = angle(ac, at);
  const acab1 = Math.acos(clamp1((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
  const babc1 = Math.acos(clamp1((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));
  // the plane the chain bends in now; a straight chain has none, so the pole gives it
  _ax0.crossVectors(ac, ab); if (_ax0.lengthSq() < 1e-8) _ax0.crossVectors(ac, pole);
  if (_ax0.lengthSq() < 1e-8) _ax0.crossVectors(ac, Math.abs(ac.y) > 0.9 ? Z : UP);
  _ax0.normalize();
  rMid.setFromAxisAngle(_ax0, babc1 - babc0);
  _q1.setFromAxisAngle(_ax0, acab1 - acab0);
  _ax1.crossVectors(ac, at);
  // no swing plane: the target lies along the chain (no swing) or straight opposite it (half a turn, about the bend axis, which is across the chain)
  if (_ax1.lengthSq() < 1e-10) _ax1.copy(_ax0); else _ax1.normalize();
  if (acat0 < 1e-6) rUpper.copy(_q1);
  else rUpper.setFromAxisAngle(_ax1, acat0).multiply(_q1);   // bend first, then swing the bent chain onto the target
  return rUpper;
}

/** Rotate unit vector v toward unit vector to by at most max radians (in place) */
function turnToward(v, to, max) {
  const ang = angle(v, to);
  if (ang <= max || ang < EPS) return v.copy(to);
  const axis = _ax1.crossVectors(v, to);
  if (axis.lengthSq() < 1e-10) axis.copy(Math.abs(v.y) > 0.9 ? Z : UP).cross(v);   // opposite: any axis across v
  return v.applyQuaternion(_q3.setFromAxisAngle(axis.normalize(), max));
}

/** Where a target is (Object3D, Vector3, [x, y, z] or { x, y, z }) into out; null when there is none */
function targetAt(tg, out) {
  if (tg == null) return null;
  if (tg.isObject3D) return tg.getWorldPosition(out);
  if (Array.isArray(tg)) return out.set(tg[0], tg[1], tg[2]);
  return out.set(tg.x, tg.y ?? 0, tg.z);
}
function checkTarget(where, tg) {
  const ok = tg == null || tg.isObject3D || (Array.isArray(tg) && tg.length === 3 && tg.every(Number.isFinite)) || (Number.isFinite(tg.x) && Number.isFinite(tg.z));
  if (!ok) throw codedError('engine-misuse', `${where}: target is an Object3D, a Vector3, [x, y, z] or null (look ahead again), got ${JSON.stringify(tg) ?? typeof tg}`);
}
const nonNeg = (where, k, v) => { if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw codedError('engine-misuse', `${where}: ${k} is a number >= 0, got ${JSON.stringify(v)}`); };

/** The model's forward (+Z of the animated root) in the bone's bind frame: the bind pose is the model standing as built, facing forward */
function bindForward(root, bone) {
  let mesh = null;
  root.traverse(o => { if (!mesh && o.isSkinnedMesh && o.skeleton.bones.includes(bone)) mesh = o; });
  root.updateWorldMatrix(true, true);
  const fwd = Z.clone().applyQuaternion(wq(root, _q));   // world
  if (!mesh) return fwd.applyQuaternion(wq(bone, _q).invert());   // plain Object3D parts: the pose they have now
  const i = mesh.skeleton.bones.indexOf(bone);
  // bone's bind rotation in mesh space, and the model's forward in mesh space (the mesh does not move against the root)
  // bindMatrix, not bindMatrixInverse: in the default 'attached' mode three refreshes the inverse from the mesh's current matrixWorld every frame
  _m.copy(mesh.skeleton.boneInverses[i]).invert().premultiply(_m2.copy(mesh.bindMatrix).invert()).decompose(_p, _q1, _s);
  fwd.applyQuaternion(wq(mesh, _q2).invert());
  return fwd.applyQuaternion(_q1.invert()).normalize();
}

/** Ease a shown weight toward its goal over fade seconds */
function fadeWeight(l, goal, dt) {
  const r = l.fade > 0 ? dt / l.fade : 1;
  l.w = l.w < goal ? Math.min(goal, l.w + r) : Math.max(goal, l.w - r);
}

function aimLayer(anim, opts) {
  const where = 'anim.addAim()', o = readParams(where, keysSchema(AIM_KEYS), opts);
  const names = [o.bones].flat().filter(Boolean);
  if (!names.length) throw codedError('engine-misuse', `${where}: bones is the bone that turns ('Head') or a chain from the body out (['Neck', 'Head']), got ${JSON.stringify(o.bones)}`);
  const bones = names.map(n => boneOf(anim.root, n, where)), tip = bones[bones.length - 1];
  if (o.forward !== undefined && !(Array.isArray(o.forward) && o.forward.length === 3 && o.forward.every(Number.isFinite))) throw codedError('engine-misuse', `${where}: forward is the last bone's own axis it looks along, [x, y, z]; leave it out to read it from the bind pose`);
  const l = { kind: 'aim', names, bones, writes: bones, w: 0, target: null, limit: 70, speed: 360, weight: 1, fade: 0.25, cur: null,
    fwd: o.forward ? new THREE.Vector3().fromArray(o.forward).normalize() : bindForward(anim.root, tip) };
  l.set = p => {
    const s = readParams('aim.set()', keysSchema(AIM_KEYS.filter(k => k !== 'bones' && k !== 'forward')), p);
    if (p && 'target' in p) { checkTarget('aim.set()', s.target); l.target = s.target; }   // the raw options: set({ weight }) keeps the target
    for (const k of ['limit', 'speed', 'weight', 'fade']) if (s[k] !== undefined) { nonNeg('aim.set()', k, s[k]); l[k] = k === 'weight' ? Math.min(1, s[k]) : s[k]; }
  };
  l.set({ target: o.target, limit: o.limit, speed: o.speed, weight: o.weight, fade: o.fade });
  l.run = dt => {
    const T = targetAt(l.target, _c);
    fadeWeight(l, T ? l.weight : 0, dt);
    const D0 = _a.copy(l.fwd).applyQuaternion(wq(tip, _q)).normalize();   // where the animation points it
    if (l.w <= 0) { l.cur = null; return; }
    l.cur ??= D0.clone();
    // the wanted direction, inside the limit around the animated one; the shown one turns toward it at speed (a lost target keeps it, the weight fades)
    if (T) turnToward(l.cur, turnToward(_b.copy(D0), T.sub(tip.getWorldPosition(_d)).normalize(), l.limit * DEG), l.speed * DEG * dt);
    l.cur.copy(turnToward(_t.copy(D0), l.cur, l.limit * DEG));   // the body turned since: still inside the limit
    const F = turnToward(_d.copy(D0), l.cur, angle(D0, l.cur) * l.w);   // the weight blends from the animation
    // spread the turn over the chain: bone i takes 1 / (bones left) of what is left; a direction turns by the same rotation about any pivot
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i], now = _e.copy(l.fwd).applyQuaternion(wq(tip, _q)).normalize();
      _q1.setFromUnitVectors(now, F);
      _q2.identity().slerp(_q1, 1 / (bones.length - i));
      setWq(b, _q2.multiply(wq(b, _q3)));
      b.updateWorldMatrix(false, true);
    }
  };
  return l;
}

/** Left / right from a bone name: Left, Foot_L, L_Foot, FootL (glTF drops the dot of Foot.L) */
function sideOf(n) {
  if (/left/i.test(n) || /(^|[^a-z])l([^a-z]|$)/i.test(n) || /[a-z]L$/.test(n)) return 'L';
  if (/right/i.test(n) || /(^|[^a-z])r([^a-z]|$)/i.test(n) || /[a-z]R$/.test(n)) return 'R';
  return null;
}
const FOOT = /foot/i, NOT_FOOT = /toe|end|ball|ik|target|pole|step/i, KNEE = /lower.?leg|lowleg|shin|calf|knee/i, BODY = /root|hips|pelvis|armature|body/i;

/** Each leg as [upper, lower, foot]: given by name, or found (a foot bone per side; its parent and grandparent, or the side's lower leg when the foot hangs elsewhere) */
function findLegs(root, legs, where) {
  if (legs) {
    if (!Array.isArray(legs) || !legs.length || legs.some(l => !Array.isArray(l) || l.length !== 3)) throw codedError('engine-misuse', `${where}: legs is a list of [upper, lower, foot] bone names, e.g. [['UpperLeg.L', 'LowerLeg.L', 'Foot.L'], ['UpperLeg.R', 'LowerLeg.R', 'Foot.R']]`);
    return legs.map(l => l.map(n => boneOf(root, n, where)));
  }
  const bones = []; root.traverse(o => { if (o.isBone) bones.push(o); });
  const out = [];
  for (const side of ['L', 'R']) {
    const foot = bones.find(b => FOOT.test(b.name) && !NOT_FOOT.test(b.name) && sideOf(b.name) === side);
    if (!foot) continue;
    let lower = foot.parent, upper = lower?.parent;
    if (!lower?.isBone || BODY.test(lower.name) || !upper?.isBone) { lower = bones.find(b => KNEE.test(b.name) && sideOf(b.name) === side); upper = lower?.parent; }
    if (lower && upper?.isBone) out.push([upper, lower, foot]);
  }
  if (out.length < 2) throw codedError('engine-misuse', `${where}: could not tell the legs from the bone names (${bones.map(b => b.name).join(', ') || 'no bones'}); name them: legs: [['<upper leg>', '<lower leg>', '<foot>'], ...]`);
  return out;
}

function feetLayer(anim, opts) {
  const where = 'anim.addFeet()', o = readParams(where, keysSchema(FEET_KEYS), opts);
  const legs = findLegs(anim.root, o.legs, where).map(([upper, lower, foot]) => ({ upper, lower, foot, off: 0, cl: new THREE.Vector3(), fp: new THREE.Vector3(), fq: new THREE.Quaternion() }));
  // the hips lower the whole body when one foot must reach down: the leg tops' common parent unless named
  const hips = o.hips ? boneOf(anim.root, o.hips, where) : legs.every(l => l.upper.parent === legs[0].upper.parent) ? legs[0].upper.parent : null;
  const writes = legs.flatMap(g => [g.upper, g.lower, g.foot]).concat(hips && hips !== anim.root ? [hips] : []);
  const l = { kind: 'feet', names: legs.map(g => g.foot.name), writes, legs, hips: writes.includes(hips) ? hips : null, w: 0, drop: 0,
    reach: 0.5, far: 30, speed: 12, weight: 1, fade: 0.25, ground: o.ground ?? null };
  l.set = p => {
    const s = readParams('feet.set()', keysSchema(FEET_KEYS.filter(k => k !== 'legs' && k !== 'hips')), p);
    for (const k of ['reach', 'far', 'speed', 'weight', 'fade']) if (s[k] !== undefined) { nonNeg('feet.set()', k, s[k]); l[k] = k === 'weight' ? Math.min(1, s[k]) : s[k]; }
    if (s.ground !== undefined) {
      if (typeof s.ground !== 'function') throw codedError('engine-misuse', `${where}: ground is (x, z, y) => height; leave it out to use the model's own ground (engine.surface, a Character's supports)`);
      l.ground = s.ground;
    }
  };
  l.set({ reach: o.reach, far: o.far, speed: o.speed, weight: o.weight, fade: o.fade, ground: o.ground });
  // preallocated: this runs per character per frame (joint positions handed to twoBone must not be its own scratch vectors)
  const pole = new THREE.Vector3(), rU = new THREE.Quaternion(), rM = new THREE.Quaternion(), ja = new THREE.Vector3(), jb = new THREE.Vector3(), jc = new THREE.Vector3(), jt = new THREE.Vector3();
  l.run = dt => {
    const root = anim.root, cam = anim.engine.camera, base = root.getWorldPosition(_b).y;
    // off at once, before any ground query: hidden, far from the camera (nobody sees the feet), or not standing (a Character jumping or swimming);
    // fading over the cached corrections would still bend legs in the air
    if (!root.visible || (cam && cam.position.distanceTo(_b) > l.far) || !anim._standing()) { l.w = 0; l.drop = 0; for (const g of legs) g.off = 0; return; }
    fadeWeight(l, l.weight, dt);
    if (l.w <= 0) { l.drop = 0; for (const g of legs) g.off = 0; return; }
    const ground = l.ground ?? anim._ground, k = dt > 0 ? 1 - Math.exp(-l.speed * dt) : 0;
    let low = 0;
    for (const g of legs) {
      g.foot.getWorldPosition(g.fp); wq(g.foot, g.fq);
      g.cl.copy(g.fp); g.lower.worldToLocal(g.cl);   // the ankle rides with the lower leg, also when the foot bone hangs elsewhere
      const off = ground(g.fp.x, g.fp.z, base) - base;
      g.off += ((Number.isFinite(off) && Math.abs(off) <= l.reach ? off : 0) - g.off) * k;   // smoothed: an edge under the foot does not pop
      low = Math.min(low, g.off);
    }
    l.drop += (low - l.drop) * k;
    if (l.hips && l.drop < 0) {
      const h = l.hips; h.getWorldPosition(_t); _t.y += l.drop * l.w;
      h.position.copy(h.parent ? h.parent.worldToLocal(_t) : _t); h.updateWorldMatrix(false, true);
    }
    pole.copy(Z).applyQuaternion(wq(root, _q));   // knees bend toward the model's front when a leg is straight
    for (const g of legs) {
      jt.copy(g.fp); jt.y += g.off * l.w;
      twoBone(g.upper.getWorldPosition(ja), g.lower.getWorldPosition(jb), jc.copy(g.cl).applyMatrix4(g.lower.matrixWorld), jt, pole, rU, rM);
      setWq(g.lower, rM.multiply(wq(g.lower, _q))); g.lower.updateWorldMatrix(false, false);
      setWq(g.upper, rU.multiply(wq(g.upper, _q))); g.upper.updateWorldMatrix(false, true);
      // the foot keeps the animation's world rotation and sits on the new ankle
      g.lower.localToWorld(_t.copy(g.cl));
      g.foot.position.copy(g.foot.parent ? g.foot.parent.worldToLocal(_t) : _t); setWq(g.foot, g.fq); g.foot.updateWorldMatrix(false, true);
    }
  };
  return l;
}

/** @internal Add a layer to the Animator: remember the bones it writes (the pose put back every frame), start the frame hook a clip-less model lacks */
function addLayer(anim, l) {
  anim._ik.push(l);
  for (const b of l.writes) { const s = anim._ikPose.get(b); if (s) s.n++; else anim._ikPose.set(b, { q: b.quaternion.clone(), p: b.position.clone(), n: 1 }); }
  anim._needHook();
  return {
    set(p) { if (anim._ik.includes(l)) l.set(p); return this; },   // a removed or disposed layer: nothing to set
    remove() {
      const i = anim._ik.indexOf(l); if (i < 0) return;
      anim._ik.splice(i, 1);
      // a ragdoll owns the bones now: forget them, write nothing. Otherwise the pose before IK, and the layers left are laid on it again at once,
      // so a bone two layers share keeps the other one's turn (no frame without it)
      if (!anim._held) ikRestore(anim);
      for (const b of l.writes) { const s = anim._ikPose.get(b); if (--s.n <= 0) anim._ikPose.delete(b); }
      if (!anim._held && anim._ik.length) solve(anim, 0);
      if (!anim._ik.length && !anim.hasClips) anim._dropHook();   // a clip-less model needed the frame hook only for IK
    },
    describe() { return { kind: l.kind, bones: l.names, weight: Math.round(l.w * 1000) / 1000 }; },
  };
}

/** @internal anim.addAim / anim.addFeet */
export const addAim = (anim, opts) => addLayer(anim, aimLayer(anim, opts));
export const addFeet = (anim, opts) => addLayer(anim, feetLayer(anim, opts));
/** @internal Before the mixer: the pose before last frame's IK (a bone no clip keys keeps its own pose, not last frame's turn) */
export function ikRestore(anim) { for (const [b, s] of anim._ikPose) { b.quaternion.copy(s.q); b.position.copy(s.p); } }
/** @internal After the mixer: remember this pose, then run each layer in the order added */
export function ikRun(anim, dt) {
  for (const [b, s] of anim._ikPose) { s.q.copy(b.quaternion); s.p.copy(b.position); }
  solve(anim, dt);
}
/** Each layer on the current pose; dt 0 recomposes without moving any smoothing on */
function solve(anim, dt) {
  anim.root.updateWorldMatrix(true, true);
  for (const l of anim._ik) l.run(dt);
}
/**
 * @internal The Animator is disposed or replaced: the pose before IK goes back (a bone no clip keys would keep the turn, and the next Animator
 * of this model would start from it), every layer ends and its handle does nothing
 */
export function ikClear(anim) {
  if (!anim._held) ikRestore(anim);
  anim._ik.length = 0; anim._ikPose.clear();
}
