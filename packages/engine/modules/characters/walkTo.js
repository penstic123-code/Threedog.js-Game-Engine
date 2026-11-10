// character.walkTo(target, opts): follow characters.findPath on fixed steps. Exists so a hand-written guard / pet / follower does not re-implement
// path following (turn rate, skipping passed points, stuck detection) every time. Steering only: the mover still owns position (see Character.js).
// Transient on purpose (like a noSkip timer): a walk is not saved and engine.skip does not fast-forward it. So it never outlives what it steers:
// one walk per character (a new walkTo cancels the old, else two hooks would fight over move()), and whatever TASK_ENDS (core/ops/control.js) lists
// ends it with 'cancelled'. A walk listens to nothing itself. A game that must resume a walk saves the target.
// Control: a walk holds the character on layer 'script' (core/ops/control.js). So the player's keys pause while it walks and come back when it ends; a
// cutscene above pauses the walk (no progress, no stuck clock) and the walk carries on after; another script owner on the same character is a
// control-conflict error instead of two hooks pushing one body.
// Links on the path are crossed as NPCs cross them (moveHelpers.js). A walk cancelled by its handle, a newer order or the character going, or paused by a holder above, lands the character at the far end; every other ending has its own idea of where the body is, so it only drops the crossing.
import { xzOf, wrapAngle } from '../../core/base/math.js';
import { nextPoint, sameLevel, climbTo, startLink, stepLink, landLink, linkAhead, LINK_REACH } from './moveHelpers.js';

const STRAIGHT_UP = 0.05;   // metres on the ground plane under which the next point counts as straight above or below
const LANDS = new Set(['order', 'gone']);   // the endings that leave a crossing to finish on its far side (see the header)
const STUCK_PROGRESS = 0.15;   // metres the character must gain on the next point within the stuck window, else it counts as stuck

/**
 * @param {any} ch Character
 * @returns {Promise<{ status: 'arrived' | 'noPath' | 'stuck' | 'cancelled' }> & { remove(): void }}
 */
export function walkTo(ch, target, { speed, arrive = 0.5, turnRate = 8, stuckSeconds = 1.5, maxRepaths = 3, run = false } = {}) {
  const e = ch.engine;
  let done, hook, path = null, i = 0, heading = null, repaths = 0, bestD = Infinity, stuckT = 0, crossing = null;
  const promise = new Promise(res => { done = res; });
  e.control.endTasks(ch, 'order');   // one walk per character: the newer order wins
  let ctl = null;
  // speed is a move.speed entry for the walk (not a speed argument to move): haste / mud modifiers still apply on top, and it ends with the walk
  const sped = speed != null ? e.mod('move.speed', { owner: 'walkTo', id: ch.id, set: speed }) : null;
  const runMod = sped && run ? e.mod('move.runSpeed', { owner: 'walkTo', id: ch.id, set: speed }) : null;
  const finish = status => {
    if (!hook) return; hook.remove(); hook = null; ctl.remove();
    if (crossing) landLink(ch, crossing);
    finishMods();
    done({ status });
  };
  function finishMods() { sped?.remove(); runMod?.remove(); }
  const solve = () => {
    path = e.characters.findPath(ch.root.position, target, { radius: ch.radius, passes: ch.passes, id: ch.id });
    i = 0; bestD = Infinity; stuckT = 0;
    return !!path?.length;
  };
  const refuse = status => { finishMods(); queueMicrotask(() => done({ status })); return Object.assign(promise, { remove() {} }); };
  if (ch.vehicle || e.control.of(ch)?.layer === 'physics') return refuse('cancelled');   // what would end the walk already holds: it could only wait
  if (!solve()) return refuse('noPath');
  try { ctl = e.control.take(ch, { owner: 'walkTo', layer: 'script', task: why => { if (hook && !LANDS.has(why)) crossing = null; finish('cancelled'); } }); } catch (err) { finishMods(); throw err; }
  hook = e.onFixed(() => {
    if (!ctl.active && !crossing) return;   // paused under a cutscene (or another higher holder): keep the path and the stuck clock as they are
    const dt = e.time.dt(ch.channel, ch.id);   // the character's time channel: bullet time slows a walk too
    if (crossing) { if (ctl.active ? stepLink(ch, crossing, dt) : landLink(ch, crossing)) { crossing = null; i++; bestD = Infinity; stuckT = 0; } return; }
    const [gx, gz] = xzOf(target), [x, z] = xzOf(ch.root.position);
    if (Math.hypot(gx - x, gz - z) <= arrive && !linkAhead(path, i) && sameLevel(e, ch.root.position, target)) { ctl.move(0, 0, false, dt); return finish('arrived'); }
    const next = nextPoint(path, i, x, ch.root.position.y, z, arrive * 0.6, e.movement.height);
    if (next !== i) { i = next; bestD = Infinity; stuckT = 0; }   // a point passed is progress, and the next one starts farther away than the best distance to the last
    const p = path[i], d = Math.hypot(p.x - x, p.z - z);
    // the end of the path, and the target has left it: a follower plans on from here, it is not stuck. A new plan that ends here too is a target out of reach
    if (i === path.length - 1 && d < arrive && Math.hypot(gx - p.x, gz - p.z) > arrive) {
      if (!solve() || Math.hypot(path.at(-1).x - x, path.at(-1).z - z) < arrive) { ctl.move(0, 0, false, dt); finish('noPath'); }
      return;
    }
    if (p.link && d < LINK_REACH) { crossing = startLink(ch, p.link); return; }
    // stuck: no gain on the next point for stuckSeconds, so replan; give up after maxRepaths
    const left = Math.hypot(d, (p.y ?? ch.root.position.y) - ch.root.position.y);   // height counts: a flyer on a vertical leg gains nothing on the ground plane
    if (left < bestD - STUCK_PROGRESS) { bestD = left; stuckT = 0; }
    else if ((stuckT += dt) > stuckSeconds) {
      if (++repaths > maxRepaths || !solve()) { ctl.move(0, 0, false, dt); return finish(repaths > maxRepaths ? 'stuck' : 'noPath'); }
      return;
    }
    if (d < STRAIGHT_UP) { ctl.move(0, 0, run, dt, climbTo(ch.root.position, p)); return; }   // the point is right above or below: atan2(0, 0) would send it sideways
    const want = Math.atan2(p.x - x, p.z - z);
    heading ??= ch.facing;
    const diff = wrapAngle(want - heading);
    const step = turnRate * dt;
    heading += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
    // slow down while the body is still turning toward the point, so it does not overshoot sideways
    const align = Math.max(0.2, Math.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    ctl.move(Math.sin(heading) * align, Math.cos(heading) * align, run, dt, climbTo(ch.root.position, p));   // the direction's length scales the speed
  });
  return Object.assign(promise, { remove() { finish('cancelled'); } });
}
