// Target selection: pure functions (no camera, input or engine state), for lock-on, aim assist, "talk to whoever I'm facing", select the nearest unit.
// Why a score and not just "nearest": the player wants what they are looking at; an enemy pressed against their back should not steal the lock.
// The caller keeps the current target (in a world record, a module, a variable) and decides when to pick; these functions only answer "which one".
import { xzOf, wrapAngle } from '../base/math.js';
import { codedError } from '../base/errorHints.js';

const KEYS = ['radius', 'cone', 'close', 'angleWeight', 'blocked', 'at'];
const yawOf = view => typeof view === 'number' ? view : Math.atan2(view.x, view.z);
/** Candidate position: an Object3D / NPC / Character / world record has .position; a Vector3 / { x, z } / [x, y, z] is the position itself */
const posOf = c => c.position ?? c;
// these two functions live in api/tools.md, not api/engine.md (the code's default page), so the error carries its own pointer
const misuse = (code, text) => Object.assign(codedError(code, text), { docs: ['api/tools.md'] });
function check(fn, opts) {
  if ('range' in opts) throw misuse('unknown-option', `${fn}(): the distance option is radius (meters), as in world.query: write { radius: ${opts.range} }`);
  for (const k of Object.keys(opts)) if (!KEYS.includes(k)) throw misuse('unknown-option', `${fn}(): unknown option '${k}'; available: ${KEYS.join(', ')}`);
}

/**
 * Pick the best target: within `radius` meters and within `cone` radians either side of the view, lowest "distance + angle off the view × angleWeight" wins.
 * Inside `close` meters the angle is ignored (surrounded: still lock something). Returns the candidate itself, or null.
 * - from: the picker's position (Object3D / Vector3 / { x, z })
 * - view: horizontal look direction { x, z } (engine.cameraRig.forward()) or a facing angle in radians (character.facing)
 * - candidates: anything with a position (Object3D, NPC, Character, world record, Vector3, { x, z }); opts.at(c) reads another field
 * - opts: radius 15, cone 1.4 (≈ 80°), close 2.5, angleWeight 6, blocked(c) => true to skip a candidate (occlusion, e.g. a raycast hits a wall first)
 * @example
 * const enemies = engine.world.query({ kind: 'enemy', near: player.position, radius: 20 });
 * lock = pickTarget(player, engine.cameraRig.forward(), enemies, { blocked: r => wallBetween(player, r) });
 */
export function pickTarget(from, view, candidates, opts = {}) {
  check('pickTarget', opts);
  const { radius = 15, cone = 1.4, close = 2.5, angleWeight = 6, blocked = null, at = posOf } = opts;
  const [fx, fz] = xzOf(posOf(from)), yaw = yawOf(view);
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    const [x, z] = xzOf(at(c)), d = Math.hypot(x - fx, z - fz);
    if (d > radius) continue;
    const off = Math.abs(wrapAngle(Math.atan2(x - fx, z - fz) - yaw));
    if (off > cone && d > close) continue;
    const score = d + off * angleWeight;
    if (score < bestScore && !blocked?.(c)) { bestScore = score; best = c; }
  }
  return best;
}

/**
 * Switch to the neighbour of `current`: side 1 = the next one to the right, -1 = to the left (as seen along view), wrapping round at the end.
 * Considers candidates within radius (default 15 m) that are not blocked; current missing or gone → the leftmost. Returns a candidate or null.
 * @example lock = switchTarget(player, engine.cameraRig.forward(), lock, enemies, input.axis.x > 0 ? 1 : -1);
 */
export function switchTarget(from, view, current, candidates, side, opts = {}) {
  check('switchTarget', opts);
  if (side !== 1 && side !== -1) throw misuse('engine-misuse', `switchTarget(): side must be 1 (right) or -1 (left), got ${side}`);
  const { radius = 15, blocked = null, at = posOf } = opts;
  const [fx, fz] = xzOf(posOf(from)), yaw = yawOf(view);
  // right of the view is the negative angle direction (facing grows toward +X, the screen's right is at -yaw), so negate to sort left → right
  const list = [];
  for (const c of candidates) {
    const [x, z] = xzOf(at(c));
    if (Math.hypot(x - fx, z - fz) <= radius && !blocked?.(c)) list.push({ c, a: -wrapAngle(Math.atan2(x - fx, z - fz) - yaw) });
  }
  if (!list.length) return null;
  list.sort((p, q) => p.a - q.a);
  const i = list.findIndex(p => p.c === current);
  return i < 0 ? list[0].c : list[(i + side + list.length) % list.length].c;
}
