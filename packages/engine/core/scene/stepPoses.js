// Drawing moving things between fixed steps. Characters and rigid bodies move on the 60 Hz fixed step, and their root.position / mesh.position stays the truth
// that gameplay reads. A screen faster than that (or a frame that ran zero or two steps) would otherwise draw the same pose twice and then jump.
// Each entry keeps the object's pose at the end of the last two steps; a drawn frame shows the pose engine.stepBlend of the way between them (one step behind, like a swarm).
// Why the matrix and not position / quaternion: the blended pose exists for one draw only, so nothing gameplay reads ever holds it, and writing a quaternion
// would rewrite the Euler the mover keeps facing in. The object's own matrix is composed here and matrixAutoUpdate is off just for that draw.
// Anything that placed the object outside a step (a tween, a frame-driven mover, a platform carried in frame) leaves it different from the step's end: it is then drawn as it stands.
import * as THREE from 'three';
import { codedError } from '../base/errorHints.js';

/** Farther than this in one step (squared meters) is a teleport, not motion: drawn at once, never swept across the map */
const JUMP2 = 16;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _keep = new THREE.Vector3();

/** @internal engine._poses */
export class StepPoses {
  constructor(engine) {
    this.engine = engine;
    /** object -> { o, last, lastRot, pos, rot, moved } */ this.map = new Map();
    /** objects whose matrix is held for this draw */ this.held = [];
    engine.time.onMove(() => this.end());
  }
  /** place(at): how to move o if a solver owns its pose (a rigid body); gone(): what that solver does when o leaves for good. Core names no module, so the solver says both here.
   *  One object, one owner: a second add throws and names the first (two solvers writing one mesh, the last one winning silently, was the bug). owner() names it for that error (a function, so a character's id is read only if it is needed). Returns the owner's handle:
   *  remove() deletes only this entry, so an owner that is already gone cannot delete a newer one's */
  add(o, place = null, gone = null, owner = () => 'another owner') {
    const had = this.map.get(o);
    if (had) throw codedError('rigid-misuse', `This object already has a physics owner: ${had.owner()}. One object has one owner of its pose (a rigid body, a character); ${owner()} cannot also take it. Remove the first (its remove() / dispose()) or give ${owner()} an object of its own`);
    const p = { o, owner, place, gone, last: o.position.clone(), lastRot: o.quaternion.clone(), pos: o.position.clone(), rot: o.quaternion.clone(), moved: false };
    this.map.set(o, p);
    return { remove: () => { if (this.map.get(o) === p) this.map.delete(o); } };
  }
  /** o and all under it left for good (engine.remove): a level's root takes the crates placed in it along, and a solver must not keep them solid and unseen */
  forget(o) { if (this.map.size) o.traverse(c => this.map.get(c)?.gone?.()); }
  /** A write moves o outside any step: the object goes there, and whatever solves it too, or the solver's next pose would undo the write */
  place(o, at) { o.position.copy(at); this.map.get(o)?.place?.(at); }
  /** End of a fixed step: the latest pose becomes the start of the blend */
  end() {
    for (const p of this.map.values()) {
      const { o, last, lastRot, pos, rot } = p;
      last.copy(pos); lastRot.copy(rot); pos.copy(o.position); rot.copy(o.quaternion);
      p.moved = !last.equals(pos) || !lastRot.equals(rot);
      if (p.moved && last.distanceToSquared(pos) > JUMP2) { last.copy(pos); lastRot.copy(rot); p.moved = false; }
    }
  }
  /** The entry if it should blend now, else null: nothing to blend, or the object was placed outside a step */
  live(p) { return p?.moved && this.engine.stepBlend < 1 && p.o.position.equals(p.pos) && p.o.quaternion.equals(p.rot) ? p : null; }
  /** Before a draw: every moving object draws at its blended pose */
  draw() {
    const a = this.engine.stepBlend;
    if (a >= 1) return;
    for (const p of this.map.values()) {
      if (!this.live(p) || !p.o.matrixAutoUpdate) continue;
      const o = p.o;
      o.matrix.compose(_v.lerpVectors(p.last, p.pos, a), _q.slerpQuaternions(p.lastRot, p.rot, a), o.scale);
      o.matrixAutoUpdate = false; o.matrixWorldNeedsUpdate = true;
      this.held.push(o);
    }
  }
  /** After a draw: the objects go back to their own pose */
  undraw() { for (const o of this.held) o.matrixAutoUpdate = true; this.held.length = 0; }
  /** Run fn with o standing at its blended position: a camera follows what is drawn, or the view would step while the body glides */
  around(o, fn) {
    const p = this.live(this.map.get(o));
    if (!p) return fn();
    _keep.copy(o.position); o.position.lerpVectors(p.last, p.pos, this.engine.stepBlend);
    try { return fn(); } finally { o.position.copy(_keep); }
  }
}
