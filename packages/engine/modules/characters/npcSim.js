// NPC simulation (gameplay logic, runs in world.simulate('npc')): pick a stop from the schedule; with a model, pathfind + move the model via the mover; without
// a model, walk in a straight line.
// Reads/writes only world data (plain objects) and the passed-in character (presentation), keeps no state of its own, because models are torn down when far and
// load replaces all data:
// state kept elsewhere (path, current stop, velocity) would go out of sync. It all lives in data (rec.nav, rec.motion), so after load the NPC continues exactly
// as if it had kept running.
// See the top of NPC.js for record fields.

import { standAt } from './movers/support.js';
import { nextPoint, sameLevel, climbTo, startLink, stepLink, landLink, leaveLink, linkAhead, LINK_REACH } from './moveHelpers.js';

/** Fixed steps an NPC waits for a findPathAsync answer before asking again (answers normally land 4 steps later; a long queue adds perStep batches) */
const PATH_WAIT = 300;
/** Recast's DT_CROWDAGENT_STATE_OFFMESH: the crowd has put the agent on a link */
const AGENT_ON_LINK = 2;
const STUCK_SECONDS = 0.5;   // no ground gained for this long while walking a path: ask for a new one
const AGENT_LEASH = 1.5;     // an agent farther than this from its NPC (m) is pulled back
const LINK_WALK = 3;         // farther than this from the link the crowd took (m), the NPC was moved away: the crossing is off

/**
 * Which stop to go to now (index): the latest stop at or before time t (0-1); before the first stop counts as the previous day's last stop; null if no schedule
 */
export function stopIndex(schedule, t) {
  if (!schedule.length) return null;
  let cur = schedule.length - 1;
  for (let i = 0; i < schedule.length; i++) if (schedule[i].at <= t) cur = i;
  return cur;
}
/** time of day from engine.calendar (any module meeting modules/calendar/contract.js; no sky needed): always 0 without a calendar (only the first stop is used) */
export const timeOfDay = e => e.calendar ? e.calendar.timeOfDay : 0;
/** The time channel an NPC record lives on (npcs.add({ channel }), default 'world') */
export const npcChannel = rec => rec.look?.channel ?? 'world';

/**
 * Walk without a model (far, or near but model not built yet): head in a straight line to the current scheduled stop; stop at the stop if reached, otherwise at
 * the interpolated point on the line.
 * seconds is the NPC's channel seconds (world.simulate({ channel }) scales the dt by the NPC's channel, the same dt the near mover gets; may be large):
 * distance = speed * seconds; when several stop-change times are crossed, walk in segments, each toward that segment's stop (day progress follows the calendar
 * clock: channel seconds / channel speed x clock.speed / dayLength).
 */
export function advance(e, W, rec, seconds) {
  const s = rec.schedule;
  if (!s.length || !(seconds > 0)) return;
  const p = rec.position;
  let x = p.x, z = p.z;
  const walk = (i, sec) => {
    const g = s[i], dx = g.x - x, dz = g.z - z, d = Math.hypot(dx, dz), go = Math.min(d, rec.speed * sec);
    if (d > 1e-9) { x += dx / d * go; z += dz / d * go; }
  };
  const cal = e.calendar;
  if (!cal) walk(stopIndex(s, 0), seconds);
  else {
    // channel seconds for a full day (infinite when the calendar is stopped: far NPCs do not walk)
    const k = e.time.scale(npcChannel(rec), rec.id), perDay = cal.dayLength * k / e.clock.speed, now = cal.timeOfDay;
    let left = Math.min(1, seconds / perDay);   // more than one day counts as one day: every stop is visited once, more would only repeat
    let t = ((now - left) % 1 + 1) % 1;
    for (let guard = 0; left > 1e-9 && guard <= s.length + 1; guard++) {
      let next = Infinity;   // next stop-change time after t (tomorrow's first stop if none left today)
      for (const st of s) { const a = st.at > t ? st.at : st.at + 1; if (a < next) next = a; }
      const seg = Math.min(left, next - t);
      walk(stopIndex(s, t), seg * perDay);
      // when landing exactly on a change time take that value, so float error does not leave it on the previous stop
      left -= seg; t = seg === next - t ? next % 1 : t + seg;
    }
  }
  const idx = stopIndex(s, timeOfDay(e)), g = s[idx];
  rec.nav.stop = idx;
  const moving = Math.hypot(g.x - x, g.z - z) > rec.arriveDistance;
  settle(e, W, rec, x, z, moving, moving ? p.y : g.y ?? p.y);   // at the stop, the stop's floor; on the way, the one it walks on
}

/** Set rec.state; with events.traceSize > 0 a change is noted as an `npc:state` trace entry (from, to), so "why did it stop" has a cause chain */
function noteState(e, rec, next) {
  if (rec.state !== next && e.events.traceSize > 0) e.events.note('npc:state', { obj: rec.id, data: { from: rec.state ?? null, to: next } });
  rec.state = next;
}

/**
 * Settle without a model: write the computed x, z back to data (position, facing, animation state); shared by every behaviour's far. The path is for the model,
 * so it is re-found at the new position after the model is built. refY: the height the ground is looked up from, default where it stood
 */
export function settle(e, W, rec, x, z, moving, refY = rec.position.y) {
  const nav = rec.nav;
  if (nav.link) { ({ x, z } = nav.link.to); W.move(rec.id, nav.link.to); leaveLink(e, rec.id, null, nav.link); nav.link = null; }   // no model to cross with: it has crossed
  const p = rec.position; nav.path = null; nav.repath = 0;
  const m = rec.motion ??= {};
  const facing = x !== p.x || z !== p.z ? Math.atan2(x - p.x, z - p.z) : m.facing ?? 0;
  Object.assign(m, { vx: 0, vz: 0, vy: 0, amount: 0, facing, grounded: true, swimming: false, jump: { coyote: 0, used: 0 } });
  noteState(e, rec, moving ? 'walk' : 'idle');
  // NPC of another level: this level's ground height is meaningless for it, keep its y
  const here = W.inZone(rec);
  // the same rule the model uses (support.js standAt), from the height it is at: without it an NPC on a deck or an upper floor dropped to the ground in the data
  const y = here ? standAt(e, x, z, refY, rec.look?.stepHeight ?? e.movement.stepHeight).y : p.y;
  W.move(rec.id, { x, y: y === -Infinity ? p.y : y, z });
}

/** One step of a link crossing with a model (rec.nav.link, saved): it runs before the behavior, so no goal, talk or behavior change leaves an NPC hanging over a gap. held: a control holder above has the body, so it lands now (landLink) */
export function crossLink(W, rec, ch, dt, held = false) {
  if (held ? landLink(ch, rec.nav.link) : stepLink(ch, rec.nav.link, dt)) rec.nav.link = null;
  rec.motion = ch.saveMotion(rec.motion ?? {});
  W.move(rec.id, ch.root.position);
}

/**
 * Near step of a schedule behaviour (every fixed step): pick the stop, goTo it, then copy position and motion state back to data.
 */
export function nearStep(e, W, rec, ch, dt) {
  const nav = rec.nav;
  const idx = rec.busy ? nav.stop : stopIndex(rec.schedule, timeOfDay(e));
  if (idx !== nav.stop) { nav.stop = idx; nav.path = null; nav.repath = 0; }
  goTo(e, W, rec, ch, idx == null ? null : rec.schedule[idx], dt);
}

/**
 * With a model, take one step toward goal ({ x, y?, z }, null = stand): pathfind, move the model via the character's mover, then copy position and motion state
 * back to data; shared by every behaviour's near.
 * Standing when in conversation (rec.busy), arrived (distance < arriveDistance) or no goal.
 * Pathfinding goes through engine.characters.findPathAsync; a goal too far (>120 m) first walks straight 100 m, then pathfinds exactly, to avoid
 * one huge search.
 */
export function goTo(e, W, rec, ch, goal, dt) {
  const nav = rec.nav, p = ch.root.position;
  const dGoal = goal ? Math.hypot(goal.x - p.x, goal.z - p.z) : 0;
  if (rec.busy || !goal || (dGoal < rec.arriveDistance && sameLevel(e, p, goal) && !linkAhead(nav.path) && !ch._linkNext)) ch.move(0, 0, false, dt);
  // a Detour crowd lives on the agent's one mesh and knows no 'characters.path' source: an NPC with passes or its own source takes the path entry below, like every other walker
  else if (e.nav?.crowd && e.characters._crowdFits(rec.id, ch.passes)) crowdMove(e, rec, ch, goal, dt);
  else {
    nav.repath -= dt;
    // goal changed while waiting, or the answer never came (engine.commits.invalidate dropped it: a partial saves.apply, a level change): ask again
    if (ch._pathReq && (ch._pathReq.goal !== goal || e.time.tick - ch._pathReq.at > PATH_WAIT)) { ch._pathReq.remove(); ch._pathReq = null; }
    if (!nav.path && nav.repath <= 0 && !ch._pathReq) {
      const far = dGoal > 120, tx = far ? p.x + (goal.x - p.x) / dGoal * 100 : goal.x, tz = far ? p.z + (goal.z - p.z) / dGoal * 100 : goal.z, ty = far ? undefined : goal.y;   // the stop's height says nothing about a point on the way
      // async: many NPCs repathing in one step cost the main thread almost nothing; the answer lands a few steps later (the NPC waits in place)
      const req = ch._pathReq = e.characters.findPathAsync(p, { x: tx, y: ty, z: tz }, path => {
        if (ch._pathReq !== req) return;
        // no way there: it stands and asks again at the next repath, a failed search is no licence to press on along the line. A far leg is only a heading, not a place it must reach
        ch._pathReq = null; nav.path = path ?? (far ? [{ x: tx, y: p.y, z: tz }] : null);
      }, { radius: ch.radius, passes: ch.passes, step: rec.pathStep, id: rec.id });
      req.goal = goal; req.at = e.time.tick;
      nav.repath = rec.repath;
    }
    // arriving is judged above, so a point counts as reached no farther out than arriveDistance: else an NPC with a small one stopped short for good, asking for a path every repath
    const reach = Math.min(0.8, rec.arriveDistance);
    let wp = null;
    if (nav.path?.length) {
      const next = nextPoint(nav.path, 0, p.x, p.y, p.z, reach, e.movement.height);
      if (next) nav.path.splice(0, next);   // the path stays one saved list: what is behind the NPC leaves it
      wp = nav.path[0];
      if (Math.hypot(wp.x - p.x, wp.z - p.z) < (wp.link ? LINK_REACH : reach) && sameLevel(e, p, wp)) {
        if (wp.link) { nav.link = startLink(ch, wp.link); nav.path.shift(); }
        else nav.path = null;
        wp = null;
      }
    }
    if (wp) {
      stepToward(nav, ch, wp, dt);
      if (nav.stuck > STUCK_SECONDS) { nav.path = null; nav.stuck = 0; }   // re-pathfind
    } else if (!nav.link) ch.move(0, 0, false, dt);   // waiting for a path: gravity, the idle pose and slowing down go on, it must not hang in the air walking on the spot
  }
  e.npcs.avoid.push(rec, ch, dt);   // keep clear of other NPCs and the player (with crowd, the agents handle it: push adds nothing)
  // position belongs to the mover: copy the model position back to data here (world also copies at the end of each fixed step; copying now means later
  // simulation and saves this step see the latest)
  rec.motion = ch.saveMotion(rec.motion ?? {});
  noteState(e, rec, ch.state);
  W.move(rec.id, p);
}

/** One step straight at wp. nav.stuck counts time, not speed: a body pressed against something that came after the path (an obstacle added in play) still reports a walk */
function stepToward(nav, ch, wp, dt) {
  const p = ch.root.position, dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz), ox = p.x, oz = p.z;
  ch.move(dx / d, dz / d, false, dt, climbTo(p, wp));
  nav.stuck = Math.hypot(p.x - ox, p.z - oz) < 0.002 ? (nav.stuck ?? 0) + dt : 0;
}

// Crowd avoidance (nav({ crowd: true })): Recast agents steer around other NPCs (smarter than the simple push in npcAvoid.js); the NPC reads the agent velocity
// and walks itself.
// The agent belongs to the model (stored on the character) and is deleted with it (dispose in npcView.js); the agent itself does not guarantee identical results
// after load.
// Links: the crowd takes an agent over one by itself, but it runs its own timed line that a game cannot shape, so the NPC crosses the same way as any other (crossLink) and
// the agent is pulled back to it after. Native Recast does not say which link an agent took, so it is the nearest one starting here. The crowd takes a link 2.25 agent radii
// short of its start and a crossing runs from where the walker stands, so the NPC first walks the rest (reachLink), or its climb starts a meter off the ladder and cuts through the deck.
function crowdMove(e, rec, ch, goal, dt) {
  const crowd = e.nav.crowd, p = ch.root.position;
  // nav mesh rebuilt, or another nav module: the old agent went with its crowd. The crowd object says so; version numbers count per module and can match
  if (ch._agent && ch._crowd !== crowd) { ch._agent = null; ch._agentGoal = null; ch._linkNext = null; }
  ch._crowd = crowd;
  if (!ch._agent) ch._agent = crowd.addAgent({ x: p.x, y: p.y, z: p.z }, { radius: ch.radius, height: e.movement.height, maxSpeed: ch.speed, maxAcceleration: ch.acceleration * ch.speed });
  const a = ch._agent;
  if (ch._agentGoal !== goal) { a.requestMoveTarget(e.nav.point(goal)); ch._agentGoal = goal; }
  const onLink = a.state() === AGENT_ON_LINK;
  if (onLink && !ch._agentOnLink) ch._linkNext = linkStartingAt(e.nav.links, p);
  ch._agentOnLink = onLink;   // once per crossing: the agent may still be on its line when a quick game crossing has landed
  if (ch._linkNext) { reachLink(rec, ch, dt); return; }
  const ap = a.position();
  // blocked, drifted too far or left behind by a crossing (it walked on alone, and an agent already at the goal gives the NPC no way there): pull the agent back
  if (ch._agentAhead || Math.hypot(ap.x - p.x, ap.z - p.z) > AGENT_LEASH) { a.teleport({ x: p.x, y: p.y, z: p.z }); ch._agentGoal = null; ch._agentAhead = false; }
  const v = a.velocity(), sp = Math.hypot(v.x, v.z);
  ch.move(sp > 0.05 ? v.x / ch.speed : 0, sp > 0.05 ? v.z / ch.speed : 0, false, dt);
}

/** Walk to the link the crowd took and start the crossing there, or from where the NPC is stuck */
function reachLink(rec, ch, dt) {
  const nav = rec.nav, link = ch._linkNext, p = ch.root.position, d = Math.hypot(link.from.x - p.x, link.from.z - p.z);
  if (d >= LINK_REACH && d < LINK_WALK && !(nav.stuck > STUCK_SECONDS)) { stepToward(nav, ch, link.from, dt); return; }
  ch._linkNext = null; nav.stuck = 0; ch._agentAhead = true;
  if (d < LINK_WALK) nav.link = startLink(ch, link);
}

/** The way across the link nearest to p: { id, from, to }, either end of a two-way link */
function linkStartingAt(links, p) {
  let best = null, bestD = Infinity;
  const take = (id, from, to) => { const d = Math.hypot(from.x - p.x, from.y - p.y, from.z - p.z); if (d < bestD) { bestD = d; best = { id, from, to }; } };
  for (const l of links) { take(l.id, l.from, l.to); if (!l.oneWay) take(l.id, l.to, l.from); }
  return best;
}
