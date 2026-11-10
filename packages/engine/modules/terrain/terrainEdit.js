// Terrain edits (engine.terrain.edit): dig, raise, flatten, and paint the ground type of cells (tilled soil, wet soil, a path).
// Records are plain data owned here: grid-point heights and cell types, saved with the save (key 'terrain'). The main-thread generator reads
// the same maps (so engine.surface / slope / groundType and collision see an edit at once); each worker job carries the edits around its chunk,
// so a chunk generated later -- or regenerated after the player walked away and back -- comes out edited, identically with threads on or off.
// Loaded chunks around an edit are rebuilt on the spot (mesh, vegetation, collision token); a worker result built before the edit is dropped.
import { DEV, fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { xzOf } from '../../core/base/math.js';
import { codedError } from '../../core/base/errorHints.js';
import { isPlainObject } from '../../core/base/util.js';
import { refuseSave, saveNumberOk } from '../../core/base/saveValues.js';
import { unkey } from './terrainGen.js';

// grid points past its edge that a chunk reads: a shared point, then the neighbor smooth normals and the color map's border read
const REACH = 2;
const EDIT_KEYS = ['radius', 'shape', 'raise', 'lower', 'flatten', 'paint'];
/** Grid points one edit may cover: far past any brush, still a moment's work */
const MAX_EDIT_POINTS = 1 << 22;
const STRINGS = {
  big: 'terrain.edit(): radius {r} covers more ground than one edit can hold; at most {max} here. Split a large change into several edits',
  none: "terrain.edit(): pass at least one of raise, lower, flatten or paint, e.g. engine.terrain.edit(pos, { radius: 2, lower: 1 })",
  many: 'terrain.edit(): raise, lower and flatten all set the height; pass only one of them',
  shape: "terrain.edit(): shape must be 'circle' or 'square', got {got}",
  num: 'terrain.edit(): {k} must be a finite number, got {got}',
  paint: "terrain.edit(): paint must be a ground type name such as 'tilled', or null to give the cells back their generated type; got {got}",
};

/** @internal owned by ChunkManager (engine.terrain.edits) */
export class TerrainEdits {
  constructor(engine, mgr, ctx) {
    this.e = engine; this.mgr = mgr;
    this.h = new Map();     // grid key -> height of grid point (i * cell, j * cell)
    this.t = new Map();     // cell key -> ground type of cell [i, i + 1) x [j, j + 1)
    this.ver = new Map();   // chunk key 'cx,cz' -> edit version (jobs carry it; an older result is stale)
    this.attach();
    ctx.saves.define('terrain', { notAtomic: 'height data is too large to copy for each atomic run, and its load rebuilds meshes', save: () => this.save(), load: d => this.load(d) });
  }
  /** Point the main-thread generator at the edit maps (again after the generator is rebuilt, e.g. a height map finished loading) */
  attach() { this.mgr.generator.useEdits(this.h, this.t); }

  edit(position, o = {}) {
    DEV && this.e.ops.guard('terrain.edit');
    readParams('terrain.edit()', keysSchema(EDIT_KEYS), o);
    const ops = ['raise', 'lower', 'flatten'].filter(k => o[k] != null);
    if (!ops.length && !('paint' in o)) throw codedError('terrain-option', STRINGS.none);
    if (ops.length > 1) throw codedError('terrain-option', STRINGS.many);
    for (const k of [...ops, 'radius']) if (o[k] != null && !Number.isFinite(o[k])) throw codedError('terrain-option', fmt(STRINGS.num, { k, got: o[k] }));
    if (o.shape != null && o.shape !== 'circle' && o.shape !== 'square') throw codedError('terrain-option', fmt(STRINGS.shape, { got: JSON.stringify(o.shape) }));
    if ('paint' in o && o.paint !== null && typeof o.paint !== 'string') throw codedError('terrain-option', fmt(STRINGS.paint, { got: JSON.stringify(o.paint) }));
    const T = this.mgr.generator, C = T.CELL, [x, z] = xzOf(position), r = o.radius ?? C / 2, sq = o.shape === 'square';
    // every point covered is a Map entry kept in the save: a radius from bad data would fill memory and hang the tab before anything could refuse it
    if ((2 * r / C) ** 2 > MAX_EDIT_POINTS) throw codedError('terrain-option', fmt(STRINGS.big, { r, max: Math.floor(Math.sqrt(MAX_EDIT_POINTS) * C / 2) }));
    // off the outline of terrain({ shape }) there is no ground to dig or paint; near the rim the grid points just outside still move,
    // because the rim's height is interpolated from them. The outline itself is not editable
    if (!T.has(x, z)) return { heights: 0, cells: 0 };
    const inside = (px, pz) => sq ? Math.abs(px - x) <= r && Math.abs(pz - z) <= r : (px - x) ** 2 + (pz - z) ** 2 <= r * r;
    // grid indices covered: points use (i * C), cells their center ((i + 0.5) * C); an edit smaller than a cell still takes the nearest one
    const pick = (off, fallback) => {
      const out = [];
      for (let j = Math.floor((z - r) / C) - 1; j <= Math.ceil((z + r) / C); j++)
        for (let i = Math.floor((x - r) / C) - 1; i <= Math.ceil((x + r) / C); i++) if (inside((i + off) * C, (j + off) * C)) out.push(i, j);
      return out.length ? out : fallback;
    };
    let heights = 0, cells = 0, i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    const grow = (i, j) => { i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); };
    if (ops.length) {
      const pts = pick(0, [Math.round(x / C), Math.round(z / C)]);
      // read every height first, then write: the result does not depend on visiting order
      const cur = []; for (let n = 0; n < pts.length; n += 2) cur.push(T.gridH(pts[n], pts[n + 1]));
      for (let n = 0; n < pts.length; n += 2) {
        const h = o.flatten ?? cur[n / 2] + (o.raise ?? 0) - (o.lower ?? 0);
        this.h.set(T.key(pts[n], pts[n + 1]), h); heights++; grow(pts[n], pts[n + 1]);
      }
    }
    if ('paint' in o) {
      const cs = pick(0.5, [Math.floor(x / C), Math.floor(z / C)]);
      for (let n = 0; n < cs.length; n += 2) {
        const k = T.key(cs[n], cs[n + 1]);
        if (o.paint === null) this.t.delete(k); else this.t.set(k, o.paint);
        cells++; grow(cs[n], cs[n + 1]);
      }
    }
    this._touch(i0, i1, j0, j1);
    return { heights, cells };
  }

  /** Edits a worker needs to build chunk (cx, cz): those on its grid and REACH points around it */
  forChunk(cx, cz) {
    if (!this.h.size && !this.t.size) return null;
    // looked up point by point: every job pays for this, so its cost must not grow with the edits made elsewhere in the world
    const T = this.mgr.generator, R = T.RES, h = [], t = [];
    for (let j = cz * R - REACH; j <= (cz + 1) * R + REACH; j++) for (let i = cx * R - REACH; i <= (cx + 1) * R + REACH; i++) {
      const k = T.key(i, j), a = this.h.get(k), b = this.t.get(k);
      if (a !== undefined) h.push(i, j, a);
      if (b !== undefined) t.push([i, j, b]);
    }
    return h.length || t.length ? { h, t } : null;
  }
  version(key) { return this.ver.get(key) ?? 0; }

  /** Grid range [i0, i1] x [j0, j1] changed: bump the version of every chunk it reaches, rebuild loaded ones now, tell listeners. rebuilt (load): chunks already done in this pass, rebuilt whole because their own range is skipped */
  _touch(i0, i1, j0, j1, rebuilt = null) {
    if (i0 > i1) return;
    const m = this.mgr, R = m.generator.RES, C = m.generator.CELL;
    const cells = rebuilt ? null : { i0: i0 - REACH, i1: i1 + REACH, j0: j0 - REACH, j1: j1 + REACH };   // the color map pixels that read the range
    for (let cz = Math.floor((j0 - REACH - 1) / R); cz <= Math.floor((j1 + REACH) / R); cz++)
      for (let cx = Math.floor((i0 - REACH - 1) / R); cx <= Math.floor((i1 + REACH) / R); cx++) {
        const k = cx + ',' + cz, c = m.chunks.get(k);
        this.ver.set(k, this.version(k) + 1);
        if (c?.state === 'ready' && !rebuilt?.has(k)) { rebuilt?.add(k); this._rebuild(c, cells); }
      }
    this.e.events.emit('ground:change', { x0: (i0 - 1) * C, z0: (j0 - 1) * C, x1: (i1 + 2) * C, z1: (j1 + 2) * C });
  }

  // same code as the worker on the full edit maps, so a rebuilt chunk equals a freshly generated one. The color map is most of a chunk's time, so
  // only its pixels in cells are repainted: a loaded chunk's map already holds every earlier edit (cells null: the whole map)
  _rebuild(c, cells) {
    const m = this.mgr, T = m.generator, tex = c.data.tex, t = T.buildChunk(c.cx, c.cz, cells && tex && { ...cells, data: tex.data });
    m._adopt(c, t);   // data only: each draw part copies the new arrays in its change(c) hook
    m._emit('change', c);
    const P = m.plants;
    c.detailDone.clear();   // edits can change what grows here, so near-only species are asked again
    for (const sp of P.list()) {
      const e = c.near[sp.name], here = !!c.plants[sp.name];
      // a near-only collider ticket not yet applied (or an empty answer already applied) is booked again from this edit: the same tick whether or not the job had answered
      if (e && (!e.done || !here)) { m._cancelNear(c, sp.name); m._book(c, sp); }
      if (sp.nearOnly && !here) continue;   // detail not loaded here; when it is, its job carries the edits
      m._mountPlants(c, sp.name, T.place(c.cx, c.cz, sp.rule, m.density));   // an empty result drops the old plants inside vegetation.mount
    }
    // new token: the physics module rebuilds this chunk's collision; edits can change what grows here, so near-only species are asked again
    c.colToken = {}; c.level = -1;
  }

  save() {
    const h = [], t = [];
    for (const [k, v] of this.h) h.push(...unkey(k), v);
    for (const [k, v] of this.t) t.push([...unkey(k), v]);
    return { h, t };
  }
  load(d) {
    const cell = (i, j) => Number.isInteger(i) && Number.isInteger(j) && saveNumberOk(i) && saveNumberOk(j);
    const heights = h => h == null || (Array.isArray(h) && h.length % 3 === 0 && h.every(saveNumberOk) && h.every((v, n) => n % 3 || cell(v, h[n + 1])));
    const types = t => t == null || (Array.isArray(t) && t.every(c => Array.isArray(c) && c.length === 3 && cell(c[0], c[1]) && typeof c[2] === 'string'));
    if (d != null && !(isPlainObject(d) && heights(d.h) && types(d.t))) refuseSave('terrain', 'the part', 'must be { h: [i, j, height, ...], t: [[i, j, type], ...] }', d);
    const T = this.mgr.generator, before = [...this.h.keys(), ...this.t.keys()];
    this.h.clear(); this.t.clear();
    for (let n = 0; n < (d?.h?.length ?? 0); n += 3) this.h.set(T.key(d.h[n], d.h[n + 1]), d.h[n + 2]);
    for (const [i, j, v] of d?.t || []) this.t.set(T.key(i, j), v);
    // rebuild what changed: chunks that had edits before and chunks that have them now
    const seen = new Set(), rebuilt = new Set(), R = T.RES;   // rebuilt: a touch reaches the 8 neighbors too, and one rebuild already reads every edit
    for (const k of [...before, ...this.h.keys(), ...this.t.keys()]) {
      const [i, j] = unkey(k), cx = Math.floor(i / R), cz = Math.floor(j / R);
      if (seen.has(cx + ',' + cz)) continue;
      seen.add(cx + ',' + cz); this._touch(cx * R, cx * R + R, cz * R, cz * R + R, rebuilt);
    }
  }
}
