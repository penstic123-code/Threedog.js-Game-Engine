// Swarm module: many same-kind gameplay objects (bullets, enemy crowds, pickups, debris) that spawn, die, move, collide and get queried.
// Data lives in typed arrays, one array per field; nothing is allocated per object on spawn, update, free or near. One swarm = one plain THREE.InstancedMesh.
//
//   engine.use(swarm());
//   const bullets = engine.swarm({ name: 'bullets', capacity: 4096, geometry, material, fields: ['vx', 'vz', 'life'] });
//   const h = bullets.spawn({ x, y, z, vx, vz, life: 2 });
//   bullets.onStep((d, i, dt) => { d.x[i] += d.vx[i] * dt; d.z[i] += d.vz[i] * dt; return (d.life[i] -= dt) > 0; });   // set once; runs every fixed step
//   enemies.near(x, z, 1.5, (d, i) => { enemies.free(d.id[i]); });
//
// The id rule. Two numbers, never mixed up:
//   a handle (what spawn returns, d.id[i]) names one object for as long as it lives and never names another afterwards; handles kept in a save stay good after loading it;
//   a row i (what onStep and near pass, what d.x[i] reads) is where that object sits now. Rows are valid inside one callback or one plain loop:
//   removing an object moves the last row into the gap. Keep handles (in a variable, or in one of the swarm's own fields); turn one into a row with swarm.row(h) (-1 = gone).
//
// Time: onStep's function runs in the fixed step on the swarm's channel (default 'world'); not at all while frozen, or while that channel stands still.
// Reserved field names drawn by the engine when listed in fields: yaw, pitch, roll (radians, three's order 'YXZ'), scale. Details: recipes/65-swarm.md.
import * as THREE from 'three';
import { codedError, coded } from '../../core/base/errorHints.js';
import { DEV, warnOnce, closest } from '../../core/base/validate.js';
import { readParams } from '../../core/base/params.js';
import { refuseSave } from '../../core/base/saveValues.js';
import { SwarmGrid } from './grid.js';
import { makeMesh, writeMesh } from './draw.js';
/** @import { SwarmData, SwarmOptions, SwarmRowFn } from '../../types/gameplay' */

// handle = serial * SLOT + slot. serial counts this swarm's births and is saved, so an old handle never names a new object.
// A fixed SLOT and not capacity: after a game update raises capacity, a saved handle still gives the same slot.
// serial starts at 1, so a handle is always >= SLOT and a row always < SLOT: a row passed to free is caught at once and never removes the wrong object.
// A handle passes 2^24 after 16 births, past what a Float32 holds exactly, so every column a game names is Float64: a stored target must still resolve. Only x, y, z and colour stay Float32.
const SLOT = 2 ** 20;
const FIXED = ['x', 'y', 'z'], COLOR = ['r', 'g', 'b'], NOT_FIELDS = ['id', 'color'];
const OPTIONS = {
  name: { type: 'string', desc: 'unique name: shown in describe(), the key in a save' },
  capacity: { type: 'int', min: 1, max: SLOT, desc: 'most objects alive at once; all memory is taken up front' },
  geometry: { type: 'any', optional: true, desc: 'plain three.js geometry; leave out with material for a swarm that draws nothing' },
  material: { type: 'any', optional: true, desc: 'plain three.js material; it stays the game\'s to dispose' },
  fields: { type: 'any', optional: true, desc: 'names of the number columns beside x, y, z' },
  color: { type: 'bool', default: false, desc: 'per-object colour: columns r, g, b (linear), spawn({ color: 0xff8800 })' },
  channel: { type: 'string', default: 'world', desc: 'time channel of the onStep dt' },
  cell: { type: 'number', default: 2, desc: 'grid cell for near, in meters: about the usual query radius' },
  save: { type: 'bool', default: false, desc: 'keep this swarm in saves; otherwise it is empty after a load or new game' },
};

/** One swarm: what engine.swarm(options) returns. See the top of modules/swarm/Swarm.js for the handle / row rule */
export class Swarm {
  /**
   * @internal
   * @param {any} engine
   * @param {any} owner the module's table of swarms
   * @param {SwarmOptions} opts
   */
  constructor(engine, owner, opts) {
    const { name, capacity, geometry = null, material = null, fields = [], color, channel, cell, save } = opts;
    /** @internal */ this._owner = owner;
    /** Name given to engine.swarm @type {string} */ this.name = name;
    /** Most objects alive at once @type {number} */ this.capacity = capacity;
    /** Time channel of the onStep dt @type {string} */ this.channel = channel;
    /** Whether this swarm is kept in saves @type {boolean} */ this.saved = save;
    /** Spawns refused because the swarm was full, since it was made @type {number} */ this.dropped = 0;
    const names = [...FIXED, ...fields, ...(color ? COLOR : [])];
    /**
     * The columns: data.x[row], data.y[row], data.z[row] (Float32Array), one Float64Array per field, so a field can hold a handle, and data.id[row], the handle of that row (Float64Array).
     * Rows 0 to count - 1 are live. The same object onStep and near pass as d
     * @type {SwarmData}
     */
    this.data = /** @type {any} */ ({ id: new Float64Array(capacity) });
    /** @internal the columns swap-remove moves together */ this._cols = names.map(n => (this.data[n] = FIXED.includes(n) || (color && COLOR.includes(n)) ? new Float32Array(capacity) : new Float64Array(capacity)));
    /** @internal */ this._names = names;
    // scale defaults to 1, colour to white: a reused row goes back to defaults, so nothing leaks from the object that had it before
    /** @internal */ this._defaults = names.map(n => (n === 'scale' || (color && COLOR.includes(n)) ? 1 : 0));
    /** @internal positions at the end of the step before the last, where interpolation starts; they move with the row */ this._px = new Float32Array(capacity); this._py = new Float32Array(capacity); this._pz = new Float32Array(capacity);
    /** @internal positions at the end of the last step: the next step's _px */ this._ex = new Float32Array(capacity); this._ey = new Float32Array(capacity); this._ez = new Float32Array(capacity);
    /** @internal row -> slot */ this._slot = new Int32Array(capacity);
    /** @internal slot -> row, -1 = free */ this._at = new Int32Array(capacity).fill(-1);
    /** @internal slot -> current handle */ this._handle = new Float64Array(capacity);
    /** @internal rows marked dead, removed when the walk ends */ this._gone = new Uint8Array(capacity);
    /** @internal slots waiting for removal */ this._kill = new Int32Array(capacity); this._killN = 0;
    /** @internal free slots, a stack */ this._free = new Int32Array(capacity); this._freeN = 0;
    this._resetSlots();
    /** @internal next spawn's serial */ this._serial = 1;
    /** @internal live rows, including those waiting in _kill */ this._n = 0;
    /** @internal >0 while onStep or near walks the rows */ this._busy = 0;
    /** @internal */ this._fn = null;
    /** @internal made on the first near: a swarm that never queries pays nothing */ this._grid = null;
    /** @internal */ this._cell = cell;
    /** @internal */ this._tint = color ? new THREE.Color() : null;
    /** @internal */ this._disposed = false;
    /** The swarm's plain THREE.InstancedMesh (null when made without geometry and material); instance index = row. castShadow, layers and the rest are yours @type {THREE.InstancedMesh | null} */
    this.mesh = geometry ? makeMesh(engine, this, geometry, material, color) : null;
  }

  /** Objects alive now @type {number} */
  get count() { return this._n - this._killN; }

  /** @internal every slot free, lowest first */
  _resetSlots() {
    const f = this._free, cap = this.capacity;
    for (let k = 0; k < cap; k++) f[k] = cap - 1 - k;
    this._freeN = cap;
  }

  /**
   * Add one object. Fields left out start at 0 (scale at 1, colour at white). Returns its handle, or -1 when the swarm is full: the object is not added,
   * dropped goes up, and one [swarm-full] warning is printed. May be called from onStep and near callbacks; an object spawned there first moves in the next step
   * @example const h = bullets.spawn({ x: 0, y: 1, z: 0, vx: 8, life: 2 });
   * @param {Record<string, number>} [o] x, y, z, the fields, and color (a hex colour, with { color: true })
   * @returns {number}
   */
  spawn(o) {
    // a late callback (a timer, a bullet's onStep after a level change) may call spawn after dispose: nothing to add to, so say so once and return -1 like a full swarm
    if (this._disposed) { warnOnce(coded('swarm-disposed', `swarm '${this.name}': spawn() after dispose(), nothing was added`), `swarm-disposed-${this.name}`); return -1; }
    if (DEV && o) this._checkSpawn(o);
    if (this._n >= this.capacity) {
      this.dropped++;
      warnOnce(coded('swarm-full', `swarm '${this.name}' is full (capacity ${this.capacity}): spawn returned -1 and the object was not added`), `swarm-full-${this.name}`);
      return -1;
    }
    const row = this._n++, slot = this._free[--this._freeN], h = this._serial++ * SLOT + slot, cols = this._cols, names = this._names, def = this._defaults, d = this.data;
    this._slot[row] = slot; this._at[slot] = row; this._handle[slot] = h; d.id[row] = h;
    for (let k = 0; k < cols.length; k++) { const v = o ? o[names[k]] : undefined; cols[k][row] = v === undefined ? def[k] : v; }
    if (o?.color !== undefined) { const c = this._tint.setHex(o.color); d.r[row] = c.r; d.g[row] = c.g; d.b[row] = c.b; }
    // last position = birth position: otherwise interpolation draws a line from where the row's previous object was
    this._rest(row);
    if (this._grid?.ok) this._grid.insert(slot, row);
    return h;
  }
  /** @internal dev only: a misspelt field would be dropped without a word */
  _checkSpawn(o) {
    for (const k in o) {
      if (k === 'color' ? this._tint : this._names.includes(k)) continue;
      const hint = closest(k, this._names), fix = k === 'color' ? 'add color: true to engine.swarm({ ... })' : `declare it in fields${hint ? ` (did you mean ${hint}?)` : ''}; columns: ${this._names.join(', ')}`;
      throw codedError('swarm-field', `swarm '${this.name}': spawn({ ${k} }) is not a column. Fix: ${fix}`);
    }
  }

  /**
   * Where a handle's object sits now, or -1 if it is gone. A row is good until the next removal outside a callback: read it, use it, drop it
   * @example const i = enemies.row(target); if (i >= 0) aim(enemies.data.x[i], enemies.data.z[i]);
   * @param {number} handle
   * @returns {number}
   */
  row(handle) {
    const slot = handle % SLOT;
    if (!(slot >= 0 && slot < this.capacity)) return -1;
    const row = this._at[slot];
    return row >= 0 && this._handle[slot] === handle && !this._gone[row] ? row : -1;
  }

  /**
   * Remove an object by handle: d.id[i] inside a callback. False if it was already gone (safe to call twice; -1 from a full spawn too). A row passed
   * by mistake throws [swarm-handle]. Inside onStep and near the object counts as gone at once (near and row skip it) and rows only move when the walk ends
   * @example enemies.near(x, z, 2, (d, i) => { enemies.free(d.id[i]); });
   * @param {number} handle
   * @returns {boolean}
   */
  free(handle) {
    if (handle >= 0 && handle < SLOT) throw codedError('swarm-handle', `swarm '${this.name}': free(${handle}) got a row, not a handle. Fix: free(d.id[i]), or return false from onStep`);
    const row = this.row(handle);
    if (row < 0) return false;
    if (this._busy) this._mark(row); else this._remove(row);
    return true;
  }
  /** @internal rows must not move during a walk: the onStep loop and the near cell chains are still running */
  _mark(row) { this._gone[row] = 1; this._kill[this._killN++] = this._slot[row]; }
  /** @internal swap-remove */
  _remove(row) {
    const slot = this._slot[row], last = --this._n, g = this._grid;
    if (g?.ok) g.unlink(slot);
    this._at[slot] = -1; this._free[this._freeN++] = slot;
    if (row !== last) {
      const cols = this._cols, d = this.data, moved = this._slot[last];
      for (let k = 0; k < cols.length; k++) cols[k][row] = cols[k][last];
      this._px[row] = this._px[last]; this._py[row] = this._py[last]; this._pz[row] = this._pz[last];
      this._ex[row] = this._ex[last]; this._ey[row] = this._ey[last]; this._ez[row] = this._ez[last];
      d.id[row] = d.id[last]; this._slot[row] = moved; this._at[moved] = row; this._gone[row] = this._gone[last];
    }
    this._gone[last] = 0;
  }
  /** @internal apply what was marked during a walk */
  _flush() {
    const k = this._kill, at = this._at, n = this._killN;
    this._killN = 0;
    for (let j = 0; j < n; j++) this._remove(at[k[j]]);
  }

  /**
   * Set the one function that moves this swarm: fn(d, i, dt) for each live row, every fixed step, dt on the swarm's channel. Return false to remove the object;
   * anything else keeps it. Returns a handle: h.remove() takes it off. Set it once at setup, not every step (a second one while one is set throws [swarm-step])
   * @example bullets.onStep((d, i, dt) => { d.x[i] += d.vx[i] * dt; return (d.life[i] -= dt) > 0; });
   * @param {SwarmRowFn} fn
   * @returns {{ remove(): void }}
   */
  onStep(fn) {
    if (typeof fn !== 'function') throw codedError('swarm-step', `swarm '${this.name}': onStep(fn): fn must be a function, got ${typeof fn}`);
    if (this._fn) throw codedError('swarm-step', `swarm '${this.name}': onStep(fn) was called while a function is already set`);
    this._fn = fn;
    return { remove: () => { if (this._fn === fn) this._fn = null; } };
  }
  /** @internal a row with no movement to draw: both interpolation ends at its position */
  _rest(row) {
    const d = this.data;
    this._px[row] = this._ex[row] = d.x[row]; this._py[row] = this._ey[row] = d.y[row]; this._pz[row] = this._ez[row] = d.z[row];
  }
  /**
   * @internal time.onMove, after everything in the step, so it needs no place among the game's onFixed: the last end becomes the start, and a game's own
   * change to d.x in onFixed counts as this step's movement and gets interpolated
   */
  _end() {
    if (this._grid) this._grid.ok = false;
    [this._px, this._ex] = [this._ex, this._px]; [this._py, this._ey] = [this._ey, this._py]; [this._pz, this._ez] = [this._ez, this._pz];
    if (!this._n) return;
    const d = this.data;
    const n = this._n;   // live rows only: capacity is sized for the peak
    this._ex.set(d.x.subarray(0, n)); this._ey.set(d.y.subarray(0, n)); this._ez.set(d.z.subarray(0, n));
  }
  /** @internal one fixed step */
  _step(dt) {
    const fn = this._fn, d = this.data, n = this._n, gone = this._gone;
    if (!fn || !n || dt === 0) return;   // a stopped channel stops the swarm, rather than running 50,000 calls with dt 0
    this._busy++;
    try {
      for (let i = 0; i < n; i++) if (!gone[i] && fn(d, i, dt) === false && !gone[i]) this._mark(i);
    } finally {
      if (--this._busy === 0) this._flush();
      if (this._grid) this._grid.ok = false;   // queries after this step must see the new positions
    }
  }

  /**
   * Visit the live objects within r meters of (x, z), height ignored: cb(d, i, dist2) with the row and the squared distance; cb returning false stops early. Returns
   * how many were visited. The grid is built on the first query after things moved, so a swarm nobody queries pays nothing. Order is the same every run. Inside onStep it stays the
   * grid of that step's first query: distances are exact, but a row that crossed a cell line since then can be missed for one step
   * @example const hit = enemies.near(px, pz, 0.5, (d, i) => { enemies.free(d.id[i]); return false; });
   * @param {number} x
   * @param {number} z
   * @param {number} r
   * @param {(d: SwarmData, i: number, dist2: number) => (boolean | void)} cb
   * @returns {number}
   */
  near(x, z, r, cb) {
    if (!(r >= 0)) throw codedError('module-params', `swarm '${this.name}': near(x, z, r, cb): r must be a number >= 0, got ${r}`);
    if (!this.count) return 0;
    const g = this._grid ??= new SwarmGrid(this, this._cell);
    if (!g.ok) g.build();
    this._busy++;
    try { return g.query(x, z, r, cb); } finally { if (--this._busy === 0) this._flush(); }
  }

  /** Remove every object (their handles die for good). Inside a callback it applies when the walk ends */
  clear() {
    if (this._busy) { for (let i = 0; i < this._n; i++) if (!this._gone[i]) this._mark(i); return; }
    if (this._grid) this._grid.ok = false;
    for (let i = this._n - 1; i >= 0; i--) this._remove(i);
  }

  /** Remove this swarm: its mesh leaves the scene and its GPU buffers go. Geometry and material stay, they are the game's. The name is free again */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.mesh?.removeFromParent();
    this.mesh?.dispose();
    this._owner.drop(this);
  }

  /** @internal save part entry */
  _save() {
    const n = this._n, cols = {};
    for (let k = 0; k < this._cols.length; k++) cols[this._names[k]] = Array.from(this._cols[k].subarray(0, n));
    return { serial: this._serial, id: Array.from(this.data.id.subarray(0, n)), cols };
  }
  /** @internal */
  _load(v) {
    if (!Array.isArray(v?.id) || !v.cols) refuseSave(`swarm '${this.name}'`, 'the part', 'must be { id, cols }', v);
    // validate the whole part before touching anything: a damaged save must not leave a half-emptied swarm. Handles are serial * SLOT + slot (whole numbers >= SLOT, one per slot)
    const seen = new Set();
    for (const h of v.id) {
      if (!Number.isSafeInteger(h) || h < SLOT || seen.has(h % SLOT)) refuseSave(`swarm '${this.name}'`, 'id', 'must be unique whole-number handles (serial * 2^20 + slot)', h);
      seen.add(h % SLOT);
    }
    for (const k in v.cols) if (Array.isArray(v.cols[k]) && v.cols[k].length !== v.id.length) refuseSave(`swarm '${this.name}'`, `cols.${k}`, `must have one value per id (${v.id.length})`, v.cols[k].length);
    if (v.serial !== undefined && !Number.isSafeInteger(v.serial)) refuseSave(`swarm '${this.name}'`, 'serial', 'must be a whole number', v.serial);
    this.clear();
    const at = this._at, d = this.data, ids = v.id;
    let lost = 0;
    for (let i = 0; i < ids.length; i++) {
      const h = ids[i], slot = h % SLOT, row = this._n;
      if (!(slot >= 0 && slot < this.capacity) || at[slot] >= 0) { lost++; continue; }   // capacity shrank in a game update (or a damaged id)
      this._n++;
      this._slot[row] = slot; at[slot] = row; this._handle[slot] = h; d.id[row] = h;
      for (let k = 0; k < this._cols.length; k++) { const x = v.cols[this._names[k]]?.[i]; this._cols[k][row] = Number.isFinite(x) ? x : this._defaults[k]; }   // a column added after the save takes its default
      this._rest(row);
    }
    this._freeN = 0;
    for (let s = this.capacity - 1; s >= 0; s--) if (at[s] < 0) this._free[this._freeN++] = s;
    // restored as saved and not as a maximum: loading one save twice must give the same handles (determinism); every saved handle is smaller, so none collide
    if (v.serial !== undefined) this._serial = v.serial;
    if (lost) warnOnce(coded('swarm-full', `swarm '${this.name}': ${lost} saved objects did not fit capacity ${this.capacity} and were left out`), `swarm-load-${this.name}`);
  }
}

/**
 * Module: many same-kind gameplay objects in typed arrays, drawn as one InstancedMesh each. After engine.use(swarm()), engine.swarm(options) makes one and returns a Swarm.
 * Bullets, enemy crowds, pickups, debris. See recipes/65-swarm.md
 * @example engine.use(swarm());
 * const coins = engine.swarm({ name: 'coins', capacity: 500, geometry, material, fields: ['yaw'], save: true });
 * @returns {import('../../types/core').ModuleDef}
 * @experimental
 */
export function swarm() {
  /** @type {Swarm[]} */ let list = [];
  let pending = {};   // a swarm not made yet at load: kept here and filled in when it is made
  const stats = s => ({ count: s.count, capacity: s.capacity, dropped: s.dropped, ...(s.saved ? { saved: true } : {}) });
  return { name: 'swarm', skipKind: 'none', type: 'rules', provides: ['swarm'], label: 'Swarm', stage: 'gameplay',
    install(e, ctx) {
      e.i18n.add({ 'zh-CN': { 'module.swarm': '成群对象' }, en: { 'module.swarm': 'swarm' } });
      const owner = { drop: s => { list = list.filter(o => o !== s); } };
      let firstLoad = false;   // set by the first load or new game: swarms spawned before it are warned about when it empties them
      ctx.track(e.time.onMove(() => { for (const s of list) s._end(); }));
      // onRender and not frame: step(render: false) skips the matrices, only drawn frames write them
      ctx.track(e.onRender(() => { for (const s of list) if (s.mesh) writeMesh(s, e.stepBlend); }));
      // one save part for all swarms: a load or new game also empties swarms not in saves, or last round's bullets stay on the field
      ctx.saves.define('swarm', { notAtomic: 'simulated in bulk each step: one copy per atomic run would cost more than the op', version: 1,
        save: () => ({ ...pending, ...Object.fromEntries(list.filter(s => s.saved).map(s => [s.name, s._save()])) }),   // pending: swarms of the loaded save not made yet stay in the next save
        load: d => {
          pending = { ...d };
          for (const s of list) {
            if (s.saved && d?.[s.name]) { s._load(d[s.name]); delete pending[s.name]; continue; }
            // objects spawned before the first load / new game (at startup) are emptied with the rest: allowed, but it looks like a spawn that did not work
            if (!firstLoad && s.count) warnOnce(`engine.swarm('${s.name}'): ${s.count} objects spawned before the first new game / load were cleared by it. Spawn after the game starts (on the start event), or pass save: true`);
            s.clear();
          }
          firstLoad = true;
        } });
      return /** @param {SwarmOptions} opts */ opts => {
        const o = readParams('engine.swarm', OPTIONS, opts), { name, geometry, material, fields = [], color, channel, cell } = o;
        if (list.some(s => s.name === name)) throw codedError('swarm-name', `engine.swarm: a swarm named '${name}' already exists`);
        if (!geometry !== !material) throw codedError('module-params', `engine.swarm('${name}'): give geometry and material together, or neither for a swarm that draws nothing`);
        e.time.dt(channel);   // a misspelt channel fails here, with time's own message
        if (!(cell > 0)) throw codedError('module-params', `engine.swarm('${name}'): cell must be > 0 meters, got ${cell}`);
        const taken = [...FIXED, ...(color ? COLOR : []), ...NOT_FIELDS];
        if (!Array.isArray(fields) || fields.some((f, i) => typeof f !== 'string' || taken.includes(f) || fields.indexOf(f) !== i))
          throw codedError('module-params', `engine.swarm('${name}'): fields is a list of new column names; ${taken.join(', ')} are taken and a name may appear once. Got ${JSON.stringify(fields)}`);
        const s = new Swarm(e, owner, o);
        list.push(s);
        if (s.saved && pending[name]) { s._load(pending[name]); delete pending[name]; }
        return s;
      };
    },
    fixed(dt, e) { for (const s of list) s._step(e.time.dt(s.channel)); },
    counts() { let alive = 0; for (const s of list) alive += s.count; return { alive, swarms: list.length }; },   // engine.counts().swarm
    describe() { return Object.fromEntries(list.map(s => [s.name, stats(s)])); },
    explain: { swarm: (e, name) => { const s = list.find(o => o.name === name); return s ? { ...stats(s), channel: s.channel, fields: s._names, moves: !!s._fn, drawn: !!s.mesh } : { error: `no swarm '${name}'; swarms: ${list.map(o => o.name).join(', ') || 'none'}` }; } },
    dispose() { for (const s of [...list]) s.dispose(); list = []; } };
}

export const handRolled = [{ kind: 'pool', seen: 'a pool or list of many shots of its own', use: 'engine.swarm: thousands of shots, crowds and debris in one draw, with reuse and hits (recipe 65)', quiet: /\b(engine|e|eng|ctx)\.swarm\b|\bswarm\(\s*[{)]/, code: /(?:\b(?:const|let|var)\s+|\bthis\.)(?:pool|\w*(?:bullet|projectile|shot|enemy|particle|mesh|object)pool|bullets|projectiles)\s*=\s*(?:\[\s*\]|new Map\b|new Set\b)/i }];
