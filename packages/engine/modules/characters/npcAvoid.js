// NPC-vs-NPC avoidance (near NPCs, every fixed step, called from goTo): nearby NPCs push each other apart to at least the sum of their radii; every player is an
// obstacle (NPCs yield, a player is never pushed).
// Why it is written this way: a continuous run and a save-then-load of the same scenario must give bit-identical positions:
// 1. Each NPC pushes only itself and reads neighbours' positions as of the start of this step (stamped), so a neighbour that already moved this step does not
// matter and order is irrelevant;
// 2. Neighbour pushes are rounded before summing (neighbour iteration order changes after load; float addition order would differ in the last bit, integer
// addition does not);
//  3. No randomness, no state kept in data (start is a per-step scratch value, cleared on load).
// Push is capped (strength m/s * dt), stronger with more overlap, then constrained by engine.collision (if installed) so NPCs are not pushed into walls.
// With nav({ crowd: true }) the Recast agents decide and this adds nothing. Only near NPCs with a model; far NPCs are simulated from data without per-NPC
// avoidance (too costly).
import { readParams, keysSchema } from '../../core/base/params.js';
import { Cells } from '../../core/stream/cells.js';
import { sameFloor } from '../../core/scene/floor.js';

const KEYS = ['on', 'radius', 'strength'];
// push direction is rotated ~25° to the right: two NPCs meeting head-on each swerve to their own right instead of deadlocking in a line
const COS = 0.906, SIN = 0.423;
const Q = 1048576;   // rounding scale before summing (2^20)

/**
 * Push from one neighbour (offset (dx, dz) from me, distance d, wanted separation min), rounded and added to acc; exactly overlapping picks the direction by
 * tie (±1)
 */
function shove(acc, dx, dz, d, min, tie) {
  // more overlap pushes harder, a light touch pushes gently: smooth
  const w = Math.min(1, (min - d) / (0.5 * min)), ux = d > 1e-6 ? dx / d : tie, uz = d > 1e-6 ? dz / d : 0;
  acc.x += Math.round((ux * COS - uz * SIN) * w * Q); acc.z += Math.round((ux * SIN + uz * COS) * w * Q);
}

/** Mounted on engine.npcs: engine.npcs.avoid.set(false | { radius, strength }) */
export class NpcAvoid {
  /** @param {any} engine @param {(h: any) => any} track the characters module's ctx.track: its listeners leave with the module @param {Map<string, { character: any }>} players */
  constructor(engine, track, players) {
    this.engine = engine;
    /** @internal */ this._players = players;
    this.on = true;         // switch (default on)
    this.radius = null;     // avoid radius per NPC (m); null = engine.movement.radius
    this.strength = 3;      // max push speed (m/s)
    this._acc = { x: 0, z: 0 };
    /** @internal ids of NPCs that have a model now (NPCManager keeps it): only they take part, so far NPCs cost nothing per step */ this.built = new Set();
    // id → { id, rec, k, x, y, z, position, n }: x, y, z = where its own step started (stamped on step k); position = where it was filed for step n (the stamp, or
    // where it stood before moving), what neighbours read
    this._start = new Map();
    // the shared xz index (core/stream/cells.js) with cells the size of the minimum distance of two NPCs, so a query looks at 3x3 cells. Not world's record index:
    // that one is 32 m per cell (hundreds of NPCs in one or two cells would make per-pair checks too costly) and holds positions as they move during the step,
    // while every push must read the step-start ones
    this._grid = null; this._gridN = -1; this._filed = new Set();
    this._q = null; this._qRec = null;   // the NPC being pushed, for the query callback (built once, no closure per push)
    this._onNear = (o, d2) => {
      const own = this._q, rec = this._qRec;
      if (o.rec === rec || d2 >= this._min2 || (o.rec.zone != null && rec.zone != null && o.rec.zone !== rec.zone) || !sameFloor(own.y, o.position.y, this.engine.movement.height)) return;
      shove(this._acc, own.x - o.position.x, own.z - o.position.z, Math.sqrt(d2), this._min, rec.id < o.id ? 1 : -1);
    };
    track(engine.events.on('world:remove', ({ id }) => { const s = this._start.get(id); if (s) { this._grid?.delete(s); this._filed.delete(s); this._start.delete(id); } }));
    // after load the simulation step count returns to the saved value, so the old index is stale
    track(engine.events.on('world:load', () => { this._start.clear(); this._filed.clear(); this._grid?.clear(); this._gridN = -1; }));
  }

  /**
   * Change settings: set(false) off, set(true) on, set({ radius, strength }) tune (pass only what changes; passing it means on). Read current values from on /
   * radius / strength.
   * @example engine.npcs.avoid.set({ radius: 0.6, strength: 2 });   // a bit sparser, pushed more slowly
   * @param {boolean | { on?: boolean, radius?: number | null, strength?: number }} opts radius per-NPC avoid radius (m, null = engine.movement.radius),
   * strength max push speed (m/s, default 3)
   * @returns {this}
   */
  set(opts) {
    this._gridN = -1;
    if (typeof opts === 'boolean') { this.on = opts; return this; }
    readParams('engine.npcs.avoid.set()', keysSchema(KEYS), opts);
    this.on = opts.on ?? true;
    if (opts.radius !== undefined) this.radius = opts.radius;
    if (opts.strength !== undefined) this.strength = opts.strength;
    return this;
  }

  /** This NPC's simulation step starts: record the start position (called from the near entry in NPC.js, before behaviours change the position) */
  stamp(rec) {
    if (!this.on) return;
    const s = this._entry(rec);
    s.k = this.engine.world.steps; s.x = rec.position.x; s.y = rec.position.y; s.z = rec.position.z;
  }
  _entry(rec) {
    let s = this._start.get(rec.id);
    if (!s) this._start.set(rec.id, s = { id: rec.id, rec, k: -1, x: 0, y: 0, z: 0, position: { x: 0, y: 0, z: 0 }, n: -1 });
    s.rec = rec;   // a load replaces record objects
    return s;
  }

  /**
   * On the first avoid of this step, file model-bearing NPCs by their step-start positions: the stamp for one that already ran this step, else where it
   * stands (it has not moved yet this step). Entries move cell only when they cross one, so a crowd costs a lookup each, not a rebuild and a sort.
   * Neighbour visiting order does not matter: pushes are summed as rounded integers
   */
  _file(W, n, min) {
    if (this._grid?.size !== min) { this._grid = new Cells(min); this._filed.clear(); }
    const G = this._grid, filed = this._filed;
    this._gridN = n;
    for (const id of this.built) {
      const o = W.get(id); if (!o || !W.view(id)) continue;
      const s = this._entry(o);
      const q = s.k === n ? s : o.position;
      s.position.x = q.x; s.position.y = q.y; s.position.z = q.z;
      s.n = n; G.put(s); filed.add(s);
    }
    for (const s of filed) if (s.n !== n) { G.delete(s); filed.delete(s); }   // model gone since last step
  }

  /** Push ch (the rec's model) apart in x, z, from walkers on its own floor only (nav({ crowd: true }) separates by the mesh). Call after ch.move, edits ch.root.position x, z directly */
  push(rec, ch, dt) {
    const e = this.engine, W = e.world;
    if (!this.on || (e.nav?.crowd && ch._agent)) return;   // a walker with a crowd agent is steered by it; one the crowd cannot serve (passes, own path source) is pushed as without a crowd
    const n = W.steps, own = this._start.get(rec.id), r = this.radius ?? e.movement.radius, min = 2 * r;
    if (!own || own.k !== n) return;   // did not enter via NPC.js (goTo called directly): no avoidance
    if (this._gridN !== n) this._file(W, n, min);
    // accumulate integers: float addition depends on order and neighbour order changes after load; rounded integer addition is exact and order-independent
    const acc = this._acc; acc.x = acc.z = 0;
    this._q = own; this._qRec = rec; this._min = min; this._min2 = min * min;
    this._grid.forEach(own, min, this._onNear);
    const ox = own.x, oz = own.z;
    for (const { character: pl } of this._players.values()) {   // a player is an obstacle: only the NPC yields, a player's position belongs to its mover
      if (!sameFloor(own.y, pl.root.position.y, e.movement.height)) continue;
      const q = pl.root.position, m = r + (pl.radius ?? r), dx = ox - q.x, dz = oz - q.z, d = Math.hypot(dx, dz);
      if (d < m) shove(acc, dx, dz, d, m, 1);
    }
    const ax = acc.x / Q, az = acc.z / Q;
    const len = Math.sqrt(ax * ax + az * az);
    if (!len) return;
    const k = this.strength * dt / Math.max(1, len), p = ch.root.position;
    const mx = ax * k, mz = az * k;
    p.x += mx; p.z += mz;
    // skip collision for pushes under half a centimetre (the mover keeps it out of walls next step); in a crowd every NPC is nudged every step, so this saves
    // most collision queries
    if (mx * mx + mz * mz > 2.5e-5) e.collision?.resolve(p, ch.radius, ch.passes);
  }
}
