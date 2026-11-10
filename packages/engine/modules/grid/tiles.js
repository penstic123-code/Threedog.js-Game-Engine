// Crisp per-cell tiles for a layer (a painted floor, a buildable zone, tilled soil): one mesh per layer, each non-empty cell a quad
// whose four corners sit on engine.surface + lift, so tiles hug a ramp or terrain and work on any ground provider
// (procedural terrain, a Blender level, a flat greenhouse floor). One merged mesh = one draw call; it is rebuilt only when
// the layer version or the ground (level:loaded, a terrain edit's ground:change) changes.
// Picture: layer option tiles.color(data, cell) -> color | null, else tiles.colors = { field: color }, else the module's table grids({ tiles: { layer: { field: color } } })
// (first truthy field in the table's order wins), else neutral gray. tiles: false = off; a function = your own part. layer.material is the three.js material they draw with.
import * as THREE from 'three';
import { neutralMaterial } from '../../render/neutral.js';
import { surfaceOr } from '../../core/scene/ground.js';
import { readParams, keysSchema } from '../../core/base/params.js';

const GAP = 0.03;   // fraction of a cell left between tiles: keeps tiles visibly separate (crisp edges)
const FALLBACK = 0x9a9a9a;

/** Color function from a { field: color } table: the first truthy field in the table's order wins (the layer's tiles.colors wins over the module's grids({ tiles })) @internal */
function tableColor(table) {
  if (!table) return null;
  const order = Object.entries(table);
  return d => { for (const [f, c] of order) if (d[f]) return c; return null; };
}

/** Build the tile view of a layer, or null when off. Returns { frame(), dispose() } @internal */
export function layerTiles(e, layer, st) {
  const t = layer.opts.tiles, name = layer.name;
  if (t === false) return null;
  if (typeof t === 'function') return customTiles(e, layer, t(e, layer));
  if (t && typeof t === 'object') readParams(`layer('${name}') tiles`, keysSchema(['color', 'colors', 'lift']), t);
  const color = (t && typeof t === 'object' && (t.color || tableColor(t.colors))) || tableColor(st.tiles[name]) || (t ? () => FALLBACK : null);
  if (!color) return null;   // no table and not asked for: a pure data layer
  const lift = t?.lift ?? st.tileLift;
  // drawn over the ground it lies on: depth offset instead of a big lift keeps it glued to slopes
  const own = neutralMaterial('decal', { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const geo = new THREE.BufferGeometry(), mesh = new THREE.Mesh(geo, own);
  mesh.name = `grid:${layer.grid.name}.${name}`; mesh.receiveShadow = true; mesh.frustumCulled = false;
  e.add(mesh, { owner: 'engine:grid' });
  let ver = -1, ground = 0, built = -1;
  const offs = ['level:loaded', 'level:unloaded', 'ground:change'].map(n => e.events.on(n, () => { ground++; }));   // new ground heights: a level came or left, or dug / raised terrain
  const col = new THREE.Color(), g = layer.grid;
  function rebuild() {
    const cells = layer.query(), pos = [], clr = [], idx = [];
    let last = 0;   // height of the previous corner: a corner beyond the island borrows it instead of -Infinity
    for (const { cell, data } of cells) {
      const c = color(data, cell);
      if (c == null) continue;
      col.set(c);
      // from the grid's mapping (its cell centers), so a replaced mapping draws where its cells are
      const [cx, cz] = g._map.center(cell), s = g.cell * (1 - 2 * GAP), x0 = cx - s / 2, z0 = cz - s / 2, n = pos.length / 3;
      for (const [x, z] of [[x0, z0], [x0, z0 + s], [x0 + s, z0 + s], [x0 + s, z0]]) { pos.push(x, (last = g.y ?? surfaceOr(e, x, z, undefined, last)) + lift, z); clr.push(col.r, col.g, col.b); }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    geo.dispose();   // frees the old GPU buffers now (new attributes are uploaded on the next draw) instead of leaving them to GC
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(clr, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    mesh.userData.tiles = idx.length / 6;
  }
  return {
    mesh,
    frame() {
      mesh.visible = e.world?.inZone(g) ?? true;
      if (layer._ver !== ver || ground !== built) { ver = layer._ver; built = ground; rebuild(); }
    },
    dispose() { for (const o of offs) o.remove(); mesh.material = own; e.remove(mesh); },   // one free through e.remove (design 6.2): the part's own geometry and material go with it; a material the game set is taken off first, so it stays the game's
  };
}

/** A game-made tile part: called with the cell list whenever the layer changes @internal */
function customTiles(e, layer, part) {
  let ver = -1;
  return {
    mesh: null,
    frame() { if (layer._ver !== ver) { ver = layer._ver; part?.update?.(layer.query()); } },
    dispose() { part?.dispose?.(); },
  };
}
