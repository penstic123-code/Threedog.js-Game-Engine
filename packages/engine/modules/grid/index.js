// grids() module: placement grids. Anything placed on cells (furniture, building, towers, crops, tactics tiles); installed as engine.grids, free when not installed.
//   engine.use(world(), grids());
//   const room = engine.grids.add('room', { cell: 1, origin: [0, 0], size: [16, 12] });
//   engine.grids.define('rug', { occupy: 'floor' }); engine.grids.define('table', { size: [2, 1] });   // a table may stand on a rug
//   engine.ops.run('grid.place', { grid: 'room', item: 'table', cell: [3, 5], level: 1 });           // upstairs
// Where state lives (nothing is stored twice):
//   placed things  -> world records with a `grid` field (saved by world); occupancy is an index rebuilt from them (world:add / change / remove / load)
//   per-cell layers -> Layer maps, saved here under the save key 'grids' (version 2) as a per-cell diff against the authored cells (Layer.js)
// Picture: grids({ ok, bad, previewOpacity, previewHeight, tiles, tileLift }) for the plain values, pv.material and layer.material for the three.js materials.
// The index is the "don't go around it" check: in dev a record's grid field is frozen (editing it in place throws), writes outside ops
// trigger the ops guard, and a record whose footprint overlaps another one is reported with the fix.
import { keepTable } from '../../core/base/sections.js';
import { Grid, MAIN, occKey, planar } from './Grid.js';
import { layerTiles } from './tiles.js';
import { makePreview } from './preview.js';
import { defineGridOps, placed } from './ops.js';

/** Grids save part: version 1 stored every cell of a layer whole ([[i, j, data]]); version 2 stores a diff against the authored cells (Layer.js) */
const GRIDS_MIGRATE = { 1: d => Object.fromEntries(Object.entries(d || {}).map(([g, ls]) => [g, Object.fromEntries(Object.entries(ls || {}).map(([n, rows]) => [n, { set: rows, whole: true }]))])) };
import { closest, DEV, warnOnce, fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { failure } from '../../core/ops/opsFail.js';
import { STRINGS as TEXT } from './strings.js';
import { codedError, coded } from '../../core/base/errorHints.js';

const STRINGS = {
  dup: "grids.add('{name}'): a grid with this name exists",
  noGrid: "grid '{name}': no such grid{hint}. Grids: {list}",
  noItem: "grid item '{name}' is not defined{hint}: engine.grids.define('{name}', { size: [1, 1] }). Defined: {list}",
  orphan: "[engine] grid '{grid}': {id} is a '{item}', which this content no longer defines; it is kept in the save but takes no cells. Define '{item}' again (engine.grids.define) to bring it back, or remove it with engine.ops.run('grid.remove', { id })",
  overlap: "[engine] grid '{grid}': {id} overlaps {other} at cell {cell}; the cell stays with {other}. Place things with engine.ops.run('grid.place', ...) / 'grid.move', which check can() first",
};
const hint = (n, list) => { const c = closest(n, list); return c ? ` (did you mean '${c}'?)` : ''; };
const freeze = p => { Object.freeze(p.cell); Object.freeze(p.size); return Object.freeze(p); };

/**
 * engine.grids: every placement grid, the item rules, previews and the occupancy index
 * @example
 * const shop = engine.grids.add('shop', { cell: 1, origin: [0, 0], size: [16, 12] });
 * engine.grids.define('shelf', { size: [2, 1], kind: 'furniture', fields: { model: 'shelf' } });
 * engine.ops.run('grid.place', { grid: 'shop', item: 'shelf', cell: [4, 4], rotation: 1 });
 * @experimental
 */
export class Grids {
  /**
   * @internal
   * @param {any} e
   * @param {GridsOptions} o
   */
  constructor(e, o) {
    /** @internal */ this.engine = e;
    /** Preview color where it can be placed, read when a preview is made @type {any} */ this.ok = o.ok;
    /** Preview color where it cannot be placed, read when a preview is made @type {any} */ this.bad = o.bad;
    /** Opacity of the preview box, read when a preview is made */ this.previewOpacity = o.previewOpacity;
    /** Height of the preview box (meters), read when a preview is made */ this.previewHeight = o.previewHeight;
    /** Tile colors by layer name, { layer: { field: color } } (first truthy field of a cell wins), read when a layer is made @type {Record<string, Record<string, any>>} */ this.tiles = o.tiles;
    /** Height of tiles above the ground (meters), read when a layer is made */ this.tileLift = o.tileLift;
    /** @internal */ this._grids = new Map();
    /** @internal */ this._defs = new Map();
    /** @internal id -> { g, keys } */ this._byId = new Map();
    /** @internal */ this._tiles = new Map();
    /** @internal */ this._previews = new Set();
    /** @internal layer data from a save, for layers created after the load */ this._loaded = null;
  }
  /** @internal A failed content load takes its grids back (core/base/sections.js undo): the function that does it @returns {() => void} */
  undoPoint() { const back = keepTable(this._grids); return () => { back(); this._rebuild(); }; }
  /**
   * Create a grid. cell: edge length (m, default 1); origin: world [x, z] of the min corner of cell [0, 0]; size: [cells wide, cells deep] (omit = unbounded);
   * zone: level name (tiles only show there); flat: max height difference under a footprint (m, default 0.5);
   * y: height of level 0 (m; default the ground under each cell), levelHeight: meters per level (default 3; level n is at y + n * levelHeight);
   * mapping: { toCell(x, z) => [i, j], center([i, j]) => [x, z] } replaces the square cell <-> world math (one place: toCell, toWorld, tiles, flatness);
   * layers: authored cells { zone: [[i, j, { buildable: true }], ...] } (content/grids.js): the baseline a save diffs against, so a save keeps only changed cells
   * @example const room = engine.grids.add('room', { cell: 0.5, origin: [-3, -3], size: [12, 12], zone: 'house' })
   * @example const tower = engine.grids.add('tower', { cell: 1, origin: [0, 0], size: [8, 8], y: 0.1, levelHeight: 3.2 })   // three floors of one building
   * @param {string} name
   * @param {{ cell?: number, origin?: any, size?: [number, number], zone?: string, flat?: number, y?: number, levelHeight?: number,
   *   mapping?: { toCell(x: number, z: number): [number, number], center(cell: [number, number]): [number, number] },
   *   layers?: Record<string, [number, number, Record<string, any>][]> }} [opts]
   * @returns {Grid}
   */
  add(name, opts = {}) {
    readParams(`grids.add('${name}')`, keysSchema(['cell', 'origin', 'size', 'zone', 'flat', 'y', 'levelHeight', 'mapping', 'layers']), opts);
    const m = opts.mapping;
    if (m && !(typeof m.toCell === 'function' && typeof m.center === 'function')) throw codedError('grids-misuse', `grids.add('${name}'): mapping needs both toCell(x, z) => [i, j] and center([i, j]) => [x, z]`, TypeError);
    if (this._grids.has(name)) throw codedError('grids-misuse', fmt(STRINGS.dup, { name }));
    // a cell of 0 or NaN turns every position into cell NaN: placed things collide with nothing and every later lookup misses
    const { cell = 1, origin = [0, 0], size = null } = opts, whole = n => Number.isSafeInteger(n) && n > 0;
    if (!(cell > 0 && Number.isFinite(cell)) || !planar(origin).every(Number.isFinite) || !(size === null || (Array.isArray(size) && size.length === 2 && size.every(whole))))
      throw codedError('grids-misuse', `grids.add('${name}'): cell must be a number > 0, origin finite and size [width, depth] whole numbers > 0 or left out; got ${JSON.stringify({ cell, origin, size })}`);
    const g = new Grid(this.engine, this, name, opts);
    this._grids.set(name, g);
    for (const [ln, rows] of Object.entries(opts.layers ?? {})) { const l = g.layer(ln); l._byContent = true; l._setBase(rows); }
    this._rebuild();   // records placed on it before it existed (content, a loaded save) now count
    return g;
  }
  /**
   * A grid by name, or undefined when there is none
   * @param {string} name
   * @returns {Grid | undefined}
   */
  get(name) { return this._grids.get(name); }
  /** @internal A grid by name; throws with the names that exist */
  _must(name) {
    const g = this._grids.get(name);
    if (!g) throw codedError('grids-misuse', fmt(STRINGS.noGrid, { name, hint: hint(name, [...this._grids.keys()]), list: [...this._grids.keys()].join(', ') || 'none' }));
    return g;
  }
  /**
   * @internal The record a placement makes (kind + fields), the same math as the grid.place op; content uses it for pre-placed grid items (props entries with grid)
   * @param {string} grid @param {string} item @param {[number, number]} cell @param {number} rotation @param {number} [level]
   */
  placement(grid, item, cell, rotation, level = 0) {
    const g = this._must(grid), rule = this._rule(item);
    return { kind: rule.kind ?? item, fields: { ...structuredClone(rule.fields ?? {}), ...placed(g, rule, item, cell, rotation, level) } };
  }
  /** All grids (a new array) @returns {Grid[]} */
  list() { return [...this._grids.values()]; }
  /**
   * Register what can be placed and its rules. size [w, d] in cells (default [1, 1]); kind of the world record (default the item name);
   * occupy: the occupancy layer it takes (default 'main'): things in different layers share a cell ('floor' tile, 'main' table, 'wall' lamp), two in one
   * layer do not; ground: allowed engine.groundType values; layer: { layerName: field } that must be truthy on every cell (reason 'not' + Field, e.g.
   * notBuildable); flat: max height difference (overrides the grid's); fields: copied into the record; can(e, { grid, cell, rotation, cells, level }): your own rule
   * @example engine.grids.define('tower', { size: [2, 2], layer: { zone: 'buildable' }, fields: { range: 6 } })   // tower defense
   * @example engine.grids.define('tile', { occupy: 'floor' }); engine.grids.define('sofa', { size: [2, 1] })        // a sofa stands on a tile
   * @example engine.grids.define('shed', { size: [3, 2], ground: ['grass', 'dirt'], flat: 0.2 })
   * @param {string} name
   * @param {import('./Grid.js').GridRule} rule
   * @returns {void}
   */
  define(name, rule) {
    readParams(`grids.define('${name}')`, keysSchema(['size', 'kind', 'occupy', 'ground', 'layer', 'flat', 'fields', 'can']), rule);
    this._defs.set(name, { size: [1, 1], ...rule });
    // the occupancy layer is derived from rules (_ruleOf), so changing a placed item's rule must rebuild the index, or at() and can() disagree again
    if (this._byId.size) this._rebuild();
  }
  /** @internal a placed record's rule: its item's current rule when that item is defined, else the record's own size / occupy (inline rules, items this content no longer has) */
  _ruleOf(p) {
    return (p.item && this._defs.get(p.item)) || { size: p.size, occupy: p.occupy };
  }
  /** @internal item name / size / inline rule -> rule */
  _rule(what) {
    if (typeof what === 'string') {
      const r = this._defs.get(what);
      if (!r) throw codedError('grids-misuse', fmt(STRINGS.noItem, { name: what, hint: hint(what, [...this._defs.keys()]), list: [...this._defs.keys()].join(', ') || 'none' }));
      return r;
    }
    return Array.isArray(what) ? { size: what } : { size: [1, 1], ...what };
  }
  /**
   * Show where an item would go: the target cell under the pointer ('pointer', default), in front of the player ('front') or from your
   * function, turned by the input action rotate (default name 'rotate'; the game binds it, e.g. presets.bindings.gridRotate; the engine binds no key itself), light when can() passes, dark otherwise (neutral tool colors; grids({ ok, bad }) override them).
   * draw: false = no visual; (engine) => ({ update(view), hide(), dispose() }) = your own; pv.material is the default box's three.js material. place() runs grid.place with what is shown
   * @example engine.input.bind({ place: ['Mouse0'], ...presets.bindings.gridRotate });   // the game's own bindings
   *   const pv = engine.grids.preview({ grid: 'field', item: 'tower' });
   *   engine.onFrame(() => { if (engine.input.pressed('place')) { const r = pv.place(); if (!r.ok) toast(engine, engine.t('grid.' + r.code)); } });
   * @param {{ grid: string, item: string, from?: 'pointer' | 'front' | ((e: any) => any), rotate?: string | false, rotation?: number, draw?: false | ((e: any) => any) }} opts
   * @returns {{ cell: [number, number] | null, rotation: number, ok: boolean, code: string | null, rotate(n?: number): void, place(fields?: object): { ok: boolean, value?: any, code?: string }, remove(): void }}
   */
  preview(opts) {
    readParams('grids.preview()', keysSchema(['grid', 'item', 'from', 'rotate', 'rotation', 'draw']), opts);
    return makePreview(this.engine, this, opts);
  }

  /** @internal a layer was created: load saved data waiting for it, build its tiles */
  _layerAdded(l) {
    const d = this._loaded?.[l.grid.name]?.[l.name];
    if (d) l.fromJSON(d);
    const t = layerTiles(this.engine, l, this);
    if (t) this._tiles.set(l, t);
  }
  /** @internal a layer's options changed after content created it: rebuild its tiles */
  _retile(l) { this._tiles.get(l)?.dispose(); this._tiles.delete(l); const t = layerTiles(this.engine, l, this); if (t) this._tiles.set(l, t); }
  /** @internal */
  _index(rec) {
    const p = rec.grid, g = this._grids.get(p.id);
    if (DEV && !Object.isFrozen(p)) freeze(p);
    if (!g) return;
    // size and occupancy layer read the rule, not the record: grid.move's can() reads the rule too, same source on both sides, so old saves do not occupy by the old cells when content later changed an item's size / added occupy
    const keys = [], rule = this._ruleOf(p), occupy = rule.occupy ?? MAIN, level = p.level ?? 0;
    // an item this content no longer defines has no size to occupy (a named record stores none): the record stays in the save, takes no cells
    if (!rule.size) { if (DEV) warnOnce(coded('grid-orphan', fmt(STRINGS.orphan, { grid: g.name, id: rec.id, item: p.item }))); this._byId.set(rec.id, { g, keys }); return; }
    for (const [i, j] of g.footprint(p.cell, rule.size, p.rotation)) {
      const k = occKey(occupy, level, i, j), other = g._occ.get(k);
      if (other && other !== rec.id) { if (DEV) warnOnce(coded('grid-overlap', fmt(STRINGS.overlap, { grid: g.name, id: rec.id, other, cell: k }))); continue; }
      g._occ.set(k, rec.id); keys.push(k);
    }
    this._byId.set(rec.id, { g, keys });
  }
  /** @internal */
  _unindex(id) {
    const x = this._byId.get(id); if (!x) return;
    for (const k of x.keys) if (x.g._occ.get(k) === id) x.g._occ.delete(k);
    this._byId.delete(id);
  }
  /** @internal */
  _reindex(id) { this._unindex(id); const r = this.engine.world.get(id); if (r?.grid) this._index(r); }
  /** @internal whole index from world records, by id so overlaps resolve the same way every time */
  _rebuild() {
    for (const g of this._grids.values()) g._occ.clear();
    this._byId.clear();
    const recs = [...this.engine.world.records.values()].filter(r => r.grid).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of recs) this._index(r);
  }
  /** @internal */
  toJSON() {
    // orphans kept: a loaded diff for a grid or layer that does not exist (yet) this run is written back as it was, so nothing is lost
    const out = structuredClone(this._loaded ?? {});
    for (const g of this._grids.values()) for (const l of g._layers.values()) {
      if (l._same) { if (out[g.name]) delete out[g.name][l.name]; } else (out[g.name] ??= {})[l.name] = l.toJSON();
    }
    for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
    return out;
  }
  /** @internal */
  fromJSON(d) {
    this._loaded = d ?? {};
    for (const g of this._grids.values()) for (const l of g._layers.values()) l.fromJSON(this._loaded[g.name]?.[l.name]);
  }
  /** @internal one line per grid for describe() */
  _describe() {
    const out = {};
    for (const g of this._grids.values()) {
      const items = {};
      for (const [id, x] of this._byId) if (x.g === g) { const it = this.engine.world.get(id)?.grid?.item ?? 'other'; items[it] = (items[it] || 0) + 1; }
      const layers = {};
      for (const l of g._layers.values()) layers[l.name] = l.count;
      out[g.name] = { cell: g.cell, size: g.size, occupied: g.occupied, items, layers };
    }
    return out;
  }
  /** @internal engine.explain({ grid: { grid, item, cell, rotation } }) */
  _explain(q) {
    const g = this.get(q?.grid);
    if (!g) return { ok: false, text: `no grid '${q?.grid}' (grids: ${[...this._grids.keys()].join(', ') || 'none'})` };
    const r = g.check(q.item, q.cell, { rotation: q.rotation ?? 0, level: q.level ?? 0 });
    const head = `${q.item} at ${g.name} [${q.cell}] rotation ${q.rotation ?? 0}`;
    if (!r.code) return { ok: true, text: `${head} can be placed` };
    const by = r.by ? ` by ${r.by} (${this.engine.world.get(r.by)?.grid?.item ?? this.engine.world.get(r.by)?.kind})` : '';
    return Object.assign(failure({ code: r.code, facts: { cell: r.cell ?? null, by: r.by ?? null } }), { text: `${head} cannot be placed: ${r.code}${r.cell ? ` at cell [${r.cell}]` : ''}${by}${r.text ? ` (${r.text})` : ''}` });
  }
}

// tool colors, not art: neutral defaults that still tell the two apart (light = can place, dark = cannot)
const GRID_PARAMS = {
  ok: { type: 'any', default: 0xe0e0e0, desc: 'preview color where it can be placed' },
  bad: { type: 'any', default: 0x3a3a3a, desc: 'preview color where it cannot be placed' },
  previewOpacity: { type: 'number', default: 0.45, min: 0, max: 1, desc: 'opacity of the preview box' },
  previewHeight: { type: 'number', default: 0.08, min: 0, desc: 'height of the preview box (meters)' },
  tiles: { type: 'any', default: {}, desc: 'tile colors by layer name: { layer: { field: color } }, first truthy field of a cell wins; a layer named here draws tiles' },
  tileLift: { type: 'number', default: 0.03, desc: 'height of tiles above the ground (meters)' },
};
/**
 * Options of grids()
 * @typedef {{ ok?: any, bad?: any, previewOpacity?: number, previewHeight?: number, tiles?: Record<string, Record<string, any>>, tileLift?: number }} GridsOptions
 */

/**
 * Grid placement module: installed as engine.grids. Needs world(). Adds the ops grid.place / grid.remove / grid.move and the save key 'grids' (layers).
 * Options: ok, bad, previewOpacity, previewHeight (the preview box), tiles, tileLift (layer tiles). The materials are pv.material and layer.material.
 * @example engine.use(world(), grids())
 * @example engine.use(world(), grids({ ok: 0x66dd88, bad: 0xdd5544, tiles: { soil: { watered: 0x5b3d2a, tilled: 0x8a6243 } } }))
 * @param {GridsOptions} [opts]
 * @returns {import('../../types/core').ModuleDef<Grids>}
 * @experimental
 */
export function grids(opts = {}) {
  const o = readParams('grids', GRID_PARAMS, opts);
  let G = null;
  return {
    // layout rules, not saved, before props: a props entry with grid places an item on one; a repeated load keeps the grid that exists
    content: { grids: { desc: 'placement grids (name -> { cell, origin, size, zone?, flat? }); layout rules, not saved', undo: (d, { engine: e }) => e.grids.undoPoint(), commit(d, { engine: e }) { for (const [name, g] of Object.entries(d)) if (!e.grids.get(name)) e.grids.add(name, g); } } },
    name: 'grids', skipKind: 'none', type: 'world', label: 'Grid placement', stage: 'gameplay', requires: ['world'], params: GRID_PARAMS, options: o,
    install(e, ctx) {
      G = new Grids(e, o);
      e.i18n.add(TEXT);   // grid.<code> player text for every built-in failure code, and the rotate action's label
      ctx.saves.define('grids', { atomic: true, version: 2, migrate: GRIDS_MIGRATE, save: () => G.toJSON(), load: d => G.fromJSON(d) });
      defineGridOps(ctx, G);
      ctx.track(e.events.on('world:add', ({ id }) => G._reindex(id)));
      ctx.track(e.events.on('world:remove', ({ id }) => G._unindex(id)));
      ctx.track(e.events.on('world:change', ({ id, keys }) => { if (keys.includes('grid')) G._reindex(id); }));
      ctx.track(e.events.on('world:load', () => G._rebuild()));
      return G;
    },
    frame() { for (const t of G._tiles.values()) t.frame(); for (const p of G._previews) p.frame(); },
    explain: { grid: (e, q) => G._explain(q) },
    describe() { return G._describe(); },
    dispose() {
      for (const t of G._tiles.values()) t.dispose();
      for (const p of [...G._previews]) p.remove();
    },
  };
}

export const handRolled = 'none: cell maths is one Math.floor that any other code writes too';
