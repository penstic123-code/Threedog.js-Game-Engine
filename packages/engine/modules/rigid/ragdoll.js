// Ragdoll: one dynamic rigid body per part of a skinned character, joined by joints; every fixed step the result is written back to the plain three.js bones.
//   const rd = engine.rigid.ragdoll(player, { impulse: [0, 2, -8], position: hitPoint });
//   rd.remove();   // back to animation
//   engine.mod('ragdoll.graph', { owner: 'game', id: 'wolf', set: { body: { bone: 'Spine' }, tail: { bone: 'Tail1', parent: 'body' } } });   // not a human: any graph of parts
//
// Why it is done this way:
// - Bodies do not use the bone's orientation but "one shared frame for the whole body in bind pose": bodyQ = boneWorldQ * inv(restQ). That way the frames on both sides of every joint coincide in bind pose,
//   so the limit zero is the bind pose, whatever pose the animation was in at the start. Using bone orientation directly gives every joint an error the moment it is created and it blows apart on the first step.
// - Only the root part writes a position, other bones write rotation only: child bones keep their local offsets, so bone length cannot change and the mesh cannot stretch (the forum post this was modelled on fails right here).
// - Parts go through rigid's _add: buoyancy, freezing while terrain is not ready, engine.raycast and world rebuild all come for free; no second copy.
// - Not saved: as soon as rigid's save part is read in (new game, load and saves.load all go through it) every ragdoll ends and a normal character comes back; a refused load never gets here, so the ragdoll keeps lying there.
//   On a world rebuild without a load, rigid carries the bodies over and this rebuilds the joints on rigid:rebuilt.
// - Self-collision is off: capsules of neighbouring parts overlap at the start and would push each other away; the limits keep the pose.
//   shortcut: one collision group, so ragdolls do not collide with each other either; to pile bodies up, give each ragdoll its own group bit.
import * as THREE from 'three';
import { vec3 } from '../../core/base/math.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError } from '../../core/base/errorHints.js';
import { humanoidGraph, shapeParts } from './ragdollBones.js';

const KEYS = keysSchema(['impulse', 'position', 'bones', 'limits', 'mass']);
const GROUP = (0x8000 << 16 | 0x7fff) >>> 0;   // the high 16 bits are its own group, the low 16 bits say what it can touch: everything except its own group
const FRICTION = 2;   // damping in the joints (1/s): limbs with no muscle still do not whip around like ropes forever
const CALM_SPEED = 0.09, CALM_SPIN = 4, CALM_STEPS = 45;   // speed squared (m²/s²), angular speed squared (rad²/s²), how many steps in a row
const HIT_SPEED = 6;   // the speed (m/s) the hit part alone can take, see _push

const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), p1 = new THREE.Vector3(), s1 = new THREE.Vector3(), m1 = new THREE.Matrix4();
const toQ = (r, out = q1) => out.set(r.x, r.y, r.z, r.w);
const worldOf = (o, p, q) => { o.matrixWorld.decompose(p, q, s1); };
const shapes = new WeakMap();   // skeleton -> { key, parts }: the same character falling again and again is not re-measured

export class Ragdolls {
  /** @param {import('./RigidBodies.js').RigidBodies} r */
  constructor(r) {
    this.r = r; this.e = r.engine;
    /** @type {Set<any>} */ this.live = new Set();
    // Listeners are attached on first use: a game that never uses ragdolls pays nothing
    this._sub = this.e.events.on('rigid:rebuilt', () => { for (const rd of this.live) this._joints(rd); });
  }

  /** The body of engine.rigid.ragdoll */
  start(who, o = {}) {
    readParams('rigid.ragdoll()', KEYS, o);
    const { ch, root } = this._find(who);
    const old = [...this.live].find(rd => rd.root === root);
    if (old) { this._push(old, o); return old; }   // already down and hit again: do not rebuild, just push once more
    if (ch?.vehicle) throw codedError('rigid-misuse', `rigid.ragdoll(): character '${ch.id}' sits in a vehicle. Fix: character.exit() first`);
    const mesh = skinOf(root);
    if (!mesh) throw codedError('rigid-misuse', `rigid.ragdoll(): no SkinnedMesh under ${ch ? `character '${ch.id}'` : `'${root.name || root.type}'`}, so there are no bones to drive. A capsule or a procedural rig cannot go limp; a model given by name loads later: await character.whenReady first`);
    const shape = this._shape(ch, root, mesh, o.bones);
    if (!shape) return null;   // the game's rule says this one does not go limp
    // Take control first: a remote character throws here, when nothing has been built yet
    const hold = ch ? this.e.control.take(ch, { owner: 'ragdoll', layer: 'physics', step: () => false }) : null;
    const rd = this._build(ch, root, mesh, shape, hold, o);
    this.live.add(rd);
    this._yield(rd);
    this._push(rd, o);
    return rd;
  }

  /** Accepts a Character, an NPC handle, a character id, or a model that belongs to no character */
  _find(who) {
    if (who?.isObject3D) return { ch: null, root: who };
    const ch = who?.root && who?.move ? who : typeof who === 'string' ? this.e.control.characterOf(who) : who?.character;
    if (!ch) throw codedError('rigid-misuse', `rigid.ragdoll(character): pass a Character, an NPC handle (its model must be built), a character id or a skinned Object3D, got ${String(who?.id ?? who)}`);
    return { ch, root: ch.root };
  }

  /** The rule 'ragdoll.graph' for this body: 'humanoid', a graph, or false for no ragdoll. Measured once per skeleton and graph */
  _shape(ch, root, mesh, bones = {}) {
    const g = this.r._graph.decide(ch?.id, { character: ch, root, mesh });
    if (g === false) return null;
    const human = g === 'humanoid';
    if (!human && Object.keys(bones).length) throw codedError('rigid-misuse', `rigid.ragdoll({ bones }): bones names the parts of the humanoid graph, and this body's rule 'ragdoll.graph' gives its own. Fix: name the bones in the graph`);
    const key = JSON.stringify(human ? bones : g, (k, v) => (v?.isObject3D ? v.uuid : v));
    const c = shapes.get(mesh.skeleton);
    if (c?.key === key) return c.parts;
    const parts = shapeParts(mesh, human ? humanoidGraph(mesh, bones) : g);
    shapes.set(mesh.skeleton, { key, parts });
    return parts;
  }

  _build(ch, root, mesh, shape, hold, o) {
    const { r } = this, R = r.rapier, skeleton = mesh.skeleton, top = shape[0];
    const massK = o.mass != null ? o.mass / shape.reduce((n, s) => n + s.mass, 0) : 1;   // the call's whole-body mass keeps the graph's proportions
    root.updateWorldMatrix(true, true);
    const holder = new THREE.Group();   // parent of the placeholder objects: _add does not add to the scene when there is a parent
    const parts = {}, list = [];
    // bind space to world scale: when the model is scaled (0.01 is common for Mixamo) colliders must use the real length as it is now
    // read from the skinning matrix of the root part: bind to now is pose and scale, and pose does not change its size, whatever the body looks like
    const k = s1.setFromMatrixScale(m1.multiplyMatrices(top.bone.matrixWorld, skeleton.boneInverses[skeleton.bones.indexOf(top.bone)])).x;
    for (const s of shape) {
      const proxy = new THREE.Object3D(), bq = new THREE.Quaternion();
      holder.add(proxy);
      worldOf(s.bone, proxy.position, bq);
      proxy.quaternion.copy(bq).multiply(q2.copy(s.q).invert());
      const seg = p1.subVectors(s.end, s.p).multiplyScalar(k), len = seg.length(), rad = s.radius * k;
      const mid = seg.clone().multiplyScalar(0.5), up = q1.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seg.clone().normalize());
      const desc = R.ColliderDesc.capsule(Math.max(len / 2 - rad, len * 0.02), rad).setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: up.x, y: up.y, z: up.z, w: up.w }).setCollisionGroups(GROUP);
      const entry = r._add(proxy, desc, { mass: s.mass * massK, friction: 0.8, restitution: 0, damping: 0.1, angularDamping: 0.8 });
      entry.ragdoll = true; entry.object = s.bone;   // a ray hit returns the bone: the game needs to know what was hit
      entry.body.enableCcd(true);   // limbs are thin and fast when knocked away; without it they pass through thin ground
      const part = { name: s.name, shape: s, entry, mass: s.mass * massK, seg: seg.clone(), rad, bone: s.bone, pos0: s.bone.position.clone(), q0: s.bone.quaternion.clone() };
      list.push(parts[s.name] = part);
    }
    const self = this;
    const rd = {
      ch, root, mesh, list, parts: Object.fromEntries(list.map(p => [p.name, p.entry])), hold, joints: [], limits: o.limits ?? {}, anchor: null, anim: null, drawn: false, void: false, calm: 0,
      get active() { return self.live.has(rd); },
      get settled() { return rd.active && list.every(p => !p.entry.enabled || p.entry.body.isSleeping()); },
      remove() { self._end(rd); },
      /** @internal character.placeAt: root follows the body, so a placement moves the body */ shift(x, y, z) { self._shift(rd, x, y, z); },
    };
    // Joint anchors are computed from the current pose (not the bind pose): in-between bones that are not in the part table (Spine1, clavicle) may not be at their bind position at the start, and this way the error on the first step is zero
    for (const p of list) {
      if (!p.shape.parent) continue;
      p.parent = parts[p.shape.parent];
      const t0 = p.parent.entry.body.translation(), t1 = p.entry.body.translation();
      p.anchor = p1.set(t1.x - t0.x, t1.y - t0.y, t1.z - t0.z).applyQuaternion(toQ(p.parent.entry.body.rotation()).invert()).clone();
      p.range = this._range(p, rd.limits);
    }
    this._joints(rd);
    // falling while running keeps the original velocity
    if (ch) for (const p of list) p.entry.body.setLinvel({ x: ch.velocity.x, y: ch.vy, z: ch.velocity.y }, true);
    return rd;
  }

  /** The three-axis range of this joint. If the starting pose is already past the limit, widen the range to the starting angle: otherwise the solver yanks it back on the first step and it looks like a twitch */
  _range(p, limits) {
    const given = limits[p.name] ?? limits[p.shape.kind], base = p.shape.limits;
    const lim = { twist: given?.twist ?? base.twist, side: given?.side ?? base.side, bend: given?.bend ?? base.bend };
    const F = p.shape.frame;
    // The child's rotation relative to the parent, read in the joint frame: the imaginary x / y / z are the three values Rapier's limits use
    toQ(p.parent.entry.body.rotation(), q1).invert().multiply(toQ(p.entry.body.rotation(), q2));
    const f = q1.premultiply(q2.copy(F).invert()).multiply(F);
    const sign = f.w < 0 ? -1 : 1, ang = c => 2 * Math.asin(THREE.MathUtils.clamp(sign * c, -1, 1));
    return [[lim.twist, f.x], [lim.side, f.y], [lim.bend, f.z]].map(([[lo, hi], c]) => { const x = ang(c); return [Math.min(lo, x - 0.02), Math.max(hi, x + 0.02)]; });
  }

  /** Build the joints; runs again after a world rebuild. Rapier's JS layer only exposes setLimits for single-axis joints; the three-axis limits and damping of a spherical joint (actually type Generic) go through the rawSet below it (the ragdoll test fails first when the version is upgraded) */
  _joints(rd) {
    const { r } = this, R = r.rapier, w = r.world, zero = { x: 0, y: 0, z: 0 };
    rd.joints = [];
    for (const p of rd.list) {
      if (!p.parent) continue;
      const j = w.createImpulseJoint(R.JointData.spherical(p.anchor, zero), p.parent.entry.body, p.entry.body, true);
      const F = p.shape.frame, f = { x: F.x, y: F.y, z: F.z, w: F.w };
      j.setLocalFrame1(p.anchor, f); j.setLocalFrame2(zero, f);
      [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ].forEach((axis, i) => {
        j.rawSet.jointSetLimits(j.handle, axis, p.range[i][0], p.range[i][1]);
        j.rawSet.jointConfigureMotorVelocity(j.handle, axis, 0, FRICTION);
      });
      rd.joints.push(j);
    }
  }

  /**
   * The impulse hits the part nearest to position (the root part when no position is given). That part only takes HIT_SPEED worth, the rest is shared over the whole body by mass:
   * in a real body force travels along the skeleton, but the solver cannot pass that much in one step, and the whole hit on a 5 kg head would send it flying and tear the joints apart. Total momentum is unchanged.
   */
  _push(rd, { impulse, position }) {
    if (!impulse) return;
    const i = vec3(impulse), at = position && vec3(position);
    let hit = rd.list[0], dist = Infinity;
    if (at) for (const p of rd.list) {
      const c = p.entry.collider.translation(), d = at.distanceToSquared(p1.set(c.x, c.y, c.z));
      if (d < dist) { dist = d; hit = p; }
    }
    const size = i.length(), own = size ? Math.min(1, hit.mass * HIT_SPEED / size) : 1, mass = rd.list.reduce((n, p) => n + p.mass, 0);
    const v = { x: i.x * own, y: i.y * own, z: i.z * own };
    if (at) hit.entry.body.applyImpulseAtPoint(v, { x: at.x, y: at.y, z: at.z }, true); else hit.entry.body.applyImpulse(v, true);
    if (own < 1) for (const p of rd.list) {
      const k = (1 - own) * p.mass / mass;
      p.entry.body.applyImpulse({ x: i.x * k, y: i.y * k, z: i.z * k }, true);
    }
  }

  /** Make the character's animation, movement, capsule and camera yield. Control was already taken in start */
  _yield(rd) {
    const { ch, root } = rd, e = this.e;
    rd.anim = ch ? ch.anim : e.assets.animatorOf(root);
    if (rd.anim) rd.anim._held = true;
    if (ch) {
      ch.limp = rd;
      ch.velocity.set(0, 0); ch.vy = 0; ch.moveAmount = 0; ch.state = ch.stateMark = 'ragdoll';
      // the player capsule is turned off by rigid.step according to limp; an NPC's capsule belongs to its mover
      if (ch !== e.player && ch.mover.collider && ch.mover.world === this.r.world) ch.mover.collider.setEnabled(false);
    }
    const rig = e.cameraRig;
    if (rig?.target === root) {
      // follow the root part, not the feet: the camera looks at the body, not at the air a person's height above it
      rd.anchor = new THREE.Object3D();
      this._anchor(rd);
      rig.follow(rd.anchor, { height: 0 });
    }
  }

  _anchor(rd) { const t = rd.list[0].entry.body.translation(); rd.anchor.position.set(t.x, t.y, t.z); }

  /** Every fixed step, after the world has stepped (called by RigidBodies.step) */
  sync() {
    for (const rd of this.live) {
      const { ch, root } = rd;
      if (ch?.disposed || !root.parent) { this._end(rd, true); continue; }   // the character or model was deleted: only clean up the physics
      if (rd.settled) { if (rd.drawn) continue; rd.drawn = true; } else { rd.drawn = false; this._calm(rd); }   // once asleep, stop writing: saves cost and a bone the game wrote stays
      this._pose(rd);
      ch?.syncRecord();
    }
  }

  /** Once slow enough, put the whole body to sleep together: joints resting on their limits jitter slightly, Rapier's own sleep threshold is often never reached, and the body would be simulated forever. It only counts fixed steps, so it stays deterministic */
  _calm(rd) {
    for (const p of rd.list) {
      const v = p.entry.body.linvel(), w = p.entry.body.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > CALM_SPEED || w.x * w.x + w.y * w.y + w.z * w.z > CALM_SPIN) { rd.calm = 0; return; }
    }
    if (++rd.calm >= CALM_STEPS) for (const p of rd.list) p.entry.body.sleep();
  }

  /** Write the physics result back to the bones. root follows the body (triggers, streaming and saves read it), so the bones are computed after root has moved */
  _pose(rd) {
    const { root, list } = rd, core = list[0].entry.body.translation();
    let low = Infinity;
    for (const p of list) {   // lowest point of the body: the soles when standing, the ground when lying, no need to ask the terrain
      const t = p.entry.body.translation(), q = toQ(p.entry.body.rotation());
      low = Math.min(low, t.y - p.rad, t.y + p1.copy(p.seg).applyQuaternion(q).y - p.rad);
    }
    p1.set(core.x, low, core.z);
    if (root.parent) root.parent.worldToLocal(p1);
    root.position.copy(p1);
    root.updateWorldMatrix(true, false);
    for (const p of list) {
      const b = p.entry.body, parent = p.bone.parent;
      parent.updateWorldMatrix(true, false);
      worldOf(parent, p1, q2);
      p.bone.quaternion.copy(q2.invert().multiply(toQ(b.rotation()).multiply(p.shape.q)));
      if (p === list[0]) {
        const t = b.translation();
        p.bone.position.copy(parent.worldToLocal(p1.set(t.x, t.y, t.z)));
      }
      p.bone.updateMatrixWorld();
    }
    if (rd.anchor) this._anchor(rd);
    const under = core.y < this.e.ground.voidY();
    if (under && !rd.void) this.e.events.emit('terrain:void', { who: list[0].entry, position: { x: core.x, y: core.y, z: core.z } });
    rd.void = under;
  }

  /** Is this character lying down (rigid.step turns the player capsule off by this) */
  holds(ch) { return !!ch.limp; }

  /** Load: position belongs to the save, so the character is not put back where the body lies */
  load() { for (const rd of [...this.live]) this._end(rd, false, false); }

  /** A placement: every part moves by the same offset, so the joints see the pose they had, and at rest, so nothing the fall carried arrives with it. Woken parts settle again */
  _shift(rd, x, y, z) {
    for (const p of rd.list) {
      const b = p.entry.body, t = b.translation();
      this.r.setPosition(p.entry, { x: t.x + x, y: t.y + y, z: t.z + z });
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    rd.calm = 0;
    if (rd.anchor) this._anchor(rd);
  }

  /** End: tear down the physics and give every slot back to its owner. gone: the character was already removed, nothing to give back; place: put the character where the body lies */
  _end(rd, gone = false, place = true) {
    if (!this.live.delete(rd)) return;
    const { ch, list, anim, anchor, hold } = rd;
    for (const j of rd.joints) if (j.isValid()) this.r.world.removeImpulseJoint(j, true);
    rd.joints = [];
    for (const p of list) p.entry.remove();
    hold?.remove();   // gone too: a slot is kept by id, so an NPC whose model was torn down while limp would come back paused for good
    if (gone) return;
    for (const p of list) { p.bone.position.copy(p.pos0); p.bone.quaternion.copy(p.q0); }   // bones no animation clip writes also go back to how they were before falling
    if (anim) anim._held = false;
    if (ch) {
      ch.limp = null;
      if (ch !== this.e.player && ch.mover.collider && ch.mover.world === this.r.world) ch.mover.collider.setEnabled(true);
      if (ch.state === 'ragdoll') ch.state = ch.stateMark = 'idle';
      if (place) ch.placeAt(ch.root.position);
    }
    // if the game switched the camera away meanwhile, do not take it back
    const rig = this.e.cameraRig;   // read now: the rig that started following may have been swapped out (architecture 8.2)
    if (rig?.target === anchor) rig.follow(rd.root);
  }

  /** The solver is going (rigid left or was replaced): every limp body gets up while its parts can still be read, or the character stays held by a physics that is gone. A dispose of the whole engine, or of the character, has nobody left to give it to */
  dispose() { this._sub.remove(); for (const rd of [...this.live]) this._end(rd, this.e.disposed || !!rd.ch?.disposed); }
}

/** The SkinnedMesh with the most bones: clothes and accessories are often small meshes on the same skeleton */
function skinOf(root) {
  let best = null;
  root.traverse(o => { if (o.isSkinnedMesh && o.skeleton && (!best || o.skeleton.bones.length > best.skeleton.bones.length)) best = o; });
  return best;
}
