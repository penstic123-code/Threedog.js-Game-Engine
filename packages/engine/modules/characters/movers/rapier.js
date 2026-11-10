// Rapier character-controller mover (mover: 'rapier', needs the rigid module): real collision shapes, auto step-up, slope snapping.
// Feel parameters (speed, acceleration, jump, air control, swimming) match simple; while physics is not ready or the collision under the feet is not built, simple is used temporarily.
// Native objects: mover.controller (KinematicCharacterController), mover.body, mover.collider.
// The player uses rigid.playerBody / playerCollider (rigid syncs it to the player position each step); each NPC builds its own kinematic capsule.
import { steer, water, float, tryJump, tickJump, leaveGround, land, finish, stat, inherited, climbLimit } from './common.js';
import { beginMove, endMove } from './support.js';
import { passesThrough } from '../../collision/grid.js';
import { warnOnce, DEV } from '../../../core/base/validate.js';

/** Create the 'rapier' mover (c is the character, fallback is the simple mover used when not ready) */
export function rapierMover(c, fallback) {
  const m = {
    name: 'rapier', controller: null, body: null, collider: null,
    move(dirX, dirZ, run, dt) {
      const e = c.engine, r = e.rigid, p = c.root.position;
      if (!r?.ready || !r.readyAt(p)) return fallback.move(dirX, dirZ, run, dt);
      const fresh = !m.controller || m.world !== r.world;   // another world (newGame / load rebuilt it, a replaced rigid brought its own): the old controller went with the old one
      if (fresh) setup(e, r);
      const col = m.collider;
      // moved outside the mover (placeAt, load, leaving a vehicle, a platform carrying it; support.js tells exactly): the collider goes there first
      if (beginMove(c) || fresh || m.away) { m.away = false; col.setEnabled(true); m.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true); r.world.propagateModifiedBodyPositionsToColliders(); }
      steer(c, dirX, dirZ, run, dt);
      const ox = p.x, oz = p.z, inh = c.grounded ? null : inherited(c);

      // vertical intent: float to the surface when swimming, otherwise gravity + jump
      tickJump(c, dt);
      // -Infinity: no water here any more (placed in a dry cellar under the lake, the water removed); water() below ends the swim, this step already falls
      const floatY = c.swimming ? e.waterAt(p.x, p.z, p.y) - c.swimDepth : -Infinity;
      let dy;
      if (floatY > -Infinity) dy = floatY - p.y;
      else {
        tryJump(c);
        if (c.grounded && c.vy <= 0) { c.vy = 0; dy = 0; }   // do not press down while standing (it would break auto step-up); downhill relies on ground snapping
        else { c.vy += stat(c, 'gravity') * dt; dy = c.vy * dt; }
      }
      const wasGrounded = c.grounded;
      // a collision-module collider with a layer this body passes is skipped (the same passesThrough the simple mover and paths use); no layers anywhere: no predicate, as before
      const through = c.passes && r._layered.size ? m.through : undefined;
      m.controller.computeColliderMovement(col, { x: (c.velocity.x + (inh?.x ?? 0)) * dt, y: dy, z: (c.velocity.y + (inh?.y ?? 0)) * dt }, r.rapier.QueryFilterFlags.EXCLUDE_DYNAMIC | r.rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, through);
      const mv = m.controller.computedMovement();
      p.x += mv.x; p.y += mv.y; p.z += mv.z;
      // hit a wall (not stepping up): velocity becomes the wall-sliding velocity, so standing at a wall does not keep walking
      const want = Math.hypot(c.velocity.x, c.velocity.y) * dt, got = Math.hypot(mv.x, mv.z);
      if (wasGrounded && mv.y <= 1e-3 && got < want * 0.5) c.velocity.set(mv.x / dt, mv.z / dt);
      const grounded = m.controller.computedGrounded();
      if (c.vy > 0 && mv.y < dy * 0.5) c.vy = 0;                                   // hit the ceiling

      const { swimY, ground, hit } = water(c, ox, oz);
      if (c.swimming) float(c, swimY);
      else if (grounded && !wasGrounded && c.vy <= 0) land(c, -c.vy);
      else if (!grounded && wasGrounded && c.vy <= 0) leaveGround(c);   // walked off an edge
      else c.grounded = grounded;
      if (m.body !== r.playerBody) m.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      finish(c, dt);
      endMove(c, dt, hit && Math.abs(ground - p.y) < 0.1 ? hit : null, 'collider');   // a support counts when the capsule stands on its top
    },
    /** Another mover took over: an NPC's capsule stays out of the world until this mover runs again, or it is an invisible wall where the character left and blocks that mover's own sweeps. The player's belongs to rigid, which keeps it on the character */
    leave() {
      const r = c.engine.rigid;
      if (m.controller && m.body !== r?.playerBody && m.world === r?.world) { m.collider.setEnabled(false); m.away = true; }
    },
    /** Called when the character is deleted: release the NPC's own capsule and controller */
    dispose() {
      const r = c.engine.rigid;
      if (!m.controller) return;
      // built for a world that was rebuilt or disposed since (engine.dispose runs rigid's before world's, which tears down the NPC models): freed with it
      if (m.world !== r?.world) { m.controller = m.body = m.collider = null; return; }
      r.world.removeCharacterController(m.controller);
      if (m.body !== r.playerBody) r.world.removeRigidBody(m.body);
      m.controller = m.body = m.collider = null;
    },
  };

  function setup(e, r) {
    const R = r.rapier, w = r.world, p = c.root.position;
    m.world = w;   // what the handles below belong to: the world object itself, since a count would match across two rigid modules
    // built with the controller: a replaced rigid keeps its layered colliders in its own map, and a test kept from the first one would read every collider as "no layer"
    m.through = hit => { const o = r._layered.get(hit); return !(o && passesThrough(o, c.passes)); };
    if (c === e.player) {
      m.body = r.playerBody; m.collider = r.playerCollider;
      // the capsule is the character's radius (as for every other character, and for simple movers and paths), unless the game set rigid({ playerCapsule: { radius } }): that wins.
      // Written back, so a rebuilt world (rigid _newWorld) makes the same capsule
      if (r._capsuleRadiusGiven) { if (DEV && c.radius !== r.playerCapsule.radius) warnOnce(`rigid({ playerCapsule: { radius: ${r.playerCapsule.radius} } }) differs from the player's radius ${c.radius}: the rapier collider uses ${r.playerCapsule.radius}, paths and the simple mover ${c.radius}. Set one of them, or make them equal`); }
      else if (c.radius !== r.playerCapsule.radius) {
        r.playerCapsule = { ...r.playerCapsule, radius: c.radius };
        m.collider.setRadius(c.radius); m.collider.setTranslationWrtParent({ x: 0, y: r.playerCapsule.halfHeight + c.radius, z: 0 });
      }
    }
    else {
      const hh = r.playerCapsule.halfHeight;
      m.body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
      m.collider = w.createCollider(R.ColliderDesc.capsule(hh, c.radius).setTranslation(0, hh + c.radius, 0), m.body);
    }
    const k = m.controller = w.createCharacterController(0.02);
    k.enableAutostep(c.stepHeight, 0.15, false);
    k.setMaxSlopeClimbAngle(Math.atan(climbLimit(e)));
    k.enableSnapToGround(c.stepHeight);
  }
  return m;
}
