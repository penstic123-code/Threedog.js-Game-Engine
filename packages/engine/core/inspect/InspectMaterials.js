// engine.inspect.materials(): every material in the scene with its textures, read on call (nothing runs per frame).
// Answers "why is this texture washed out / too dark / the normals wrong" and "what uses the VRAM": per material its textures (slot, size,
// color space, estimated GPU bytes), who made it (engine or game), its shader patches and their slots, and how many meshes share it.
// Color space rule (three.js): textures holding colors (map, emissiveMap, ...) are SRGBColorSpace; textures holding data (normal, roughness,
// metalness, ao, bump, displacement, alpha) are NoColorSpace / linear. A wrong one is listed as an issue, first.
// Plain three.js equivalent: scene.traverse + material[slot] + texture.colorSpace / texture.image; renderer.info.memory.textures is the count.
import { isEngineMade, materialPatchSlots } from '../../render/patches.js';
import { nodeTextures } from './MaterialInfo.js';
import { textureBytes, mb } from './textureBytes.js';
import { COLOR_SLOTS, DATA_SLOTS } from '../assets/assetReport.js';

const OTHER_SLOTS = ['lightMap', 'envMap', 'gradientMap', 'matcap'];   // listed, with no one right color space
const SRGB = 'srgb';

/** Textures of a material: the standard slots, the textures inside a node material's graph, then any texture uniform of a ShaderMaterial */
function texturesOf(m) {
  const out = [];
  for (const k of [...COLOR_SLOTS, ...DATA_SLOTS, ...OTHER_SLOTS]) if (m[k]?.isTexture) out.push([k, m[k]]);
  for (const [k, t] of nodeTextures(m)) if (!out.some(([, x]) => x === t)) out.push([k, t]);
  for (const [k, u] of Object.entries(m.uniforms || {})) if (u?.value?.isTexture && !out.some(([, t]) => t === u.value)) out.push([`uniform ${k}`, u.value]);
  return out;
}

/** Is this texture's color space right for the slot? null when fine (or the slot does not say) */
function spaceIssue(slot, t) {
  if (t.isRenderTargetTexture || t.isDepthTexture) return null;
  const name = `${slot} "${t.name || t.uuid.slice(0, 8)}"`;
  if (COLOR_SLOTS.includes(slot) && t.colorSpace !== SRGB && !t.isDataTexture && !t.isCompressedTexture)
    return `${name} holds colors but its colorSpace is '${t.colorSpace || 'none'}': it renders washed out. Fix: texture.colorSpace = THREE.SRGBColorSpace`;
  if (DATA_SLOTS.includes(slot) && t.colorSpace === SRGB)
    return `${name} holds data but is marked sRGB: values are bent (normals tilt, roughness shifts). Fix: texture.colorSpace = THREE.NoColorSpace`;
  return null;
}

const sizeOf = t => { const i = Array.isArray(t.image) ? t.image[0] : t.image; const w = i?.width ?? i?.videoWidth ?? 0, h = i?.height ?? i?.videoHeight ?? 0; return w && h ? `${w}x${h}` : '?'; };

/**
 * @param {any} e the engine
 * @param {{ limit?: number }} [opts] limit: how many lines of materials the text lists (alike ones share a line; all are in `materials`)
 */
export function inspectMaterials(e, { limit = 30 } = {}) {
  const mats = new Map(), texUsers = new Map();
  e.scene.traverse(o => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      if (!m) continue;
      const real = m.userData?._dbgOf ?? m;   // a debug-view stand-in: the real picture is the material behind it
      const r = mats.get(real) ?? mats.set(real, { m: real, users: 0, first: o }).get(real);
      r.users++;
    }
  });
  if (e.scene.background?.isTexture) texUsers.set(e.scene.background, new Set(['scene.background']));
  if (e.scene.environment?.isTexture) texUsers.set(e.scene.environment, new Set(['scene.environment']));
  const materials = [], issues = [], pairs = [];
  for (const { m, users, first } of mats.values()) {
    const textures = texturesOf(m).map(([slot, t]) => {
      (texUsers.get(t) ?? texUsers.set(t, new Set()).get(t)).add(m.uuid);
      const issue = spaceIssue(slot, t);
      if (issue) issues.push(`material "${m.name || m.type}" (mesh "${first.name || first.type}"): ${issue}`);
      const row = { slot, name: t.name || null, size: sizeOf(t), colorSpace: t.colorSpace || 'none', bytes: textureBytes(t), sharedBy: 1, ...(issue && { issue }) };
      pairs.push([row, t]);
      return row;
    });
    materials.push({ name: m.name || null, type: m.type, uuid: m.uuid, madeBy: isEngineMade(m) ? 'engine' : 'game', role: m.userData?.purpose ?? null,
      sharedBy: users, firstMesh: first.name || null, patches: materialPatchSlots(m), textures });
  }
  for (const [row, t] of pairs) row.sharedBy = texUsers.get(t).size;   // materials using that texture
  let bytes = 0;
  for (const t of texUsers.keys()) bytes += textureBytes(t);
  const textureCount = texUsers.size;
  materials.sort((a, b) => b.textures.reduce((s, t) => s + t.bytes, 0) - a.textures.reduce((s, t) => s + t.bytes, 0) || b.sharedBy - a.sharedBy);
  const line = mt => `${mt.name ?? '(unnamed)'} ${mt.type} [${mt.madeBy}${mt.role ? ' ' + mt.role : ''}] x${mt.sharedBy} meshes`
    + (mt.patches.length ? ` · patches ${mt.patches.map(p => `${p.name}${p.slots.length ? '(' + p.slots.join(',') + ')' : ''}`).join(' ')}` : '')
    + (mt.textures.length ? ' · ' + mt.textures.map(t => `${t.slot} ${t.size} ${t.colorSpace} ${mb(t.bytes)}${t.sharedBy > 1 ? ` shared x${t.sharedBy}` : ''}`).join(', ') : ' · no textures');
  // materials whose line reads the same (one per placed copy of a model, say) are one line with a count; limit counts lines
  const rows = new Map();
  for (const mt of materials) { const l = line(mt); rows.set(l, (rows.get(l) ?? 0) + 1); }
  const shown = [...rows].slice(0, limit), rest = materials.length - shown.reduce((s, [, n]) => s + n, 0);
  const text = [`${materials.length} materials, ${textureCount} textures, ~${mb(bytes)} texture memory (estimate, mipmaps included)`
    + `${issues.length ? `, ${issues.length} color-space issue${issues.length > 1 ? 's' : ''}` : ''}`,
  ...issues.map(i => '✗ ' + i),
  ...shown.map(([l, n]) => n > 1 ? `${l} · ×${n} materials alike` : l),
  rest ? `… ${rest} more (engine.inspect.materials({ limit }) or .materials)` : ''].filter(Boolean).join('\n');
  return { count: materials.length, textures: textureCount, textureBytes: bytes, issues, materials, text };
}
