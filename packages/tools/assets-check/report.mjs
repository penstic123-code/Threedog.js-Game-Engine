// Import report of a glb read statically: the same list engine.assets.report(name) prints at runtime (materials, textures with the color space
// three will give them, normal maps, clips, node count, template / id nodes, col_ colliders), so the file and the loaded model can be compared.
// A glb cannot carry a color-space flag: the slot decides (baseColor / emissive = srgb, the rest = linear data), which is what GLTFLoader applies.

import { hintLine } from './names.mjs';

/** @param {any} doc glTF Transform Document @param {any} manifest levelManifest(doc, file) */
export function fileReport(doc, manifest) {
  const root = doc.getRoot(), tex = new Map();
  const use = (t, slot) => { if (t) { const v = tex.get(t) ?? tex.set(t, { name: t.getName() || t.getURI() || '(unnamed)', slots: [] }).get(t); v.slots.push(slot); } };
  const materials = root.listMaterials().map(m => {
    const slots = { baseColor: m.getBaseColorTexture(), emissive: m.getEmissiveTexture(), normal: m.getNormalTexture(), occlusion: m.getOcclusionTexture(), metallicRoughness: m.getMetallicRoughnessTexture() };
    for (const [k, t] of Object.entries(slots)) use(t, k);
    return { name: m.getName() || '(unnamed)', textures: Object.keys(slots).filter(k => slots[k]), normalMap: !!slots.normal, alphaMode: m.getAlphaMode() };
  });
  const textures = [...tex.values()].map(t => ({ ...t, colorSpace: t.slots.every(s => s === 'baseColor' || s === 'emissive') ? 'srgb' : t.slots.some(s => s === 'baseColor' || s === 'emissive') ? 'mixed' : 'linear' }));
  const clips = root.listAnimations().map(a => ({ name: a.getName(), channels: a.listChannels().length }));
  return {
    nodes: root.listNodes().length, hidden: root.listNodes().filter(n => n.getExtension('KHR_node_visibility')?.getVisible() === false).map(n => n.getName() || '(unnamed)'), materials, textures, normalMaps: materials.filter(m => m.normalMap).length, clips,
    colliders: manifest.colliders.map(c => c.name), templates: manifest.records.map(r => ({ node: r.node, template: r.template })),
    bounds: sceneBounds(doc),
  };
}

/** World-space box of all mesh positions ([min, max] or null): from accessor min / max and each node's world matrix, no vertex data is read */
function sceneBounds(doc) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], any = false;
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh(); if (!mesh) continue;
    const m = n.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION'); if (!pos) continue;
      const a = pos.getMin([]), b = pos.getMax([]);
      for (let i = 0; i < 8; i++) {
        const v = [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
        const w = [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
        any = true;
      }
    }
  }
  return any ? [lo.map(v => +v.toFixed(3)), hi.map(v => +v.toFixed(3))] : null;
}

/** Lines for the console */
export function reportLines(r, full = false, indent = '  ') {
  const L = [`${indent}nodes       ${r.nodes} · normal maps ${r.normalMaps} · col_ ${r.colliders.length} · template/id nodes ${r.templates.length}`];
  if (r.hidden?.length) L.push(hintLine('nodes hidden by KHR_node_visibility (loaded with visible = false, children too)', r.hidden, full, indent));
  for (const m of r.materials) L.push(`${indent}material    ${m.name}: ${m.textures.join(', ') || 'no textures'}${m.alphaMode !== 'OPAQUE' ? ` (${m.alphaMode})` : ''}`);
  for (const t of r.textures) L.push(`${indent}texture     ${t.name}: ${t.colorSpace} (${t.slots.join(', ')})`);
  if (r.clips.length) L.push(`${indent}clips       ${r.clips.map(c => c.name || '(unnamed)').join(', ')}`);
  return L;
}
