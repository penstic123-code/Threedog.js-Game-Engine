// Material provenance for engine.inspect.scene(): "why is this mesh the wrong colour?" Diagnostics only: reads the material, never changes it.
// from says who made it: 'engine' (neutralMaterial and the like, render/patches.js keeps the mark) or 'game' (any other three.js material).
import { isEngineMade } from '../../render/patches.js';

/** A three.js color as '#rrggbb' @param {any} c */
export const hex = c => '#' + c.getHexString();
const MAPS = ['map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap', 'gradientMap'];
const SIDES = ['front', 'back', 'double'];

/**
 * Textures a node material (TSL) reads through its nodes: [slot label, texture]. A node graph is code, not data, so this walks the graph three itself
 * keeps (Node.traverse) and reports what it finds. A custom node whose walk throws is skipped: the list is then what could be read, never invented
 * @param {any} m
 * @returns {[string, any][]}
 */
export function nodeTextures(m) {
  const found = [];
  if (!m?.isNodeMaterial) return found;
  for (const [k, n] of Object.entries(m)) {
    if (!n?.isNode) continue;
    try { n.traverse(c => { if (c.value?.isTexture && !found.some(([, t]) => t === c.value)) found.push([`node ${k}`, c.value]); }); } catch { /* unreadable custom node */ }
  }
  return found;
}

/**
 * @param {any} m a three.js material
 * @param {any} [o] the mesh that uses it (its userData.purpose is the fallback role)
 */
export function materialInfo(m, o) {
  const white = !m.color || m.color.getHex() === 0xffffff;
  const maps = MAPS.filter(k => m[k]).map(k => k === 'map' ? 'map (base colour)' : k === 'normalMap' || k === 'bumpMap' ? `${k} (detail, no colour)` : k);
  const vc = !!m.vertexColors, hasMap = !!m.map;
  const node = m.isNodeMaterial && m.colorNode;   // TSL: the colour is a node graph, not map x color
  const base = node ? 'node material, colour from colorNode (a TSL graph: map and color may not apply; its textures are in inspect.materials)' : hasMap ? (white ? 'map' : `map x color ${hex(m.color)}`) : m.color ? `color ${hex(m.color)}` : 'no color';
  const colorPath = `${base} (vertexColors ${vc ? 'on: also multiplied by the geometry color attribute' : 'off'})`;
  const notes = [];
  if (!node && hasMap && !white) notes.push(`map already carries colour and color ${hex(m.color)} is not white: the result is map x color (fine when it is a tint)`);
  if (vc && o?.geometry && !o.geometry.attributes?.color) notes.push('vertexColors is on but the geometry has no color attribute: it renders black');
  return {
    role: m.userData?.purpose ?? o?.userData?.purpose ?? null,
    from: isEngineMade(m) ? 'engine' : 'game',
    type: m.type, color: m.color ? hex(m.color) : null, maps, vertexColors: vc,
    side: SIDES[m.side] ?? m.side, transparent: !!m.transparent, opacity: m.opacity,
    colorPath, ...(notes.length && { notes }),
  };
}

/** One-line text of materialInfo for a list */
export const infoLine = i => `${i.role ?? '-'} from ${i.from} · ${i.type} ${i.color ?? ''} · ${i.colorPath}`
  + `${i.maps.length ? ' · ' + i.maps.join(', ') : ''}${i.side !== 'front' ? ' · side ' + i.side : ''}${i.transparent || i.opacity < 1 ? ` · transparent=${i.transparent} opacity ${i.opacity}` : ''}`
  + (i.notes ? '\n      note: ' + i.notes.join('; ') : '');
