// Node names three.js GLTFLoader will rename: it keeps one pool of names per file (nodes, mesh primitives, cameras) and gives a repeat the suffix _1, _2…
// (GLTFLoader.createUniqueName), so getObjectByName('weapon') can find the mesh while the bone you meant became weapon_1. Blender cannot see this clash.
// The rule mirrored here: PropertyBinding.sanitizeNodeName (threedog/spelling sanitize, the one copy the engine's node lookups use too); a node reserves its name
// first, then its mesh reserves one name per primitive (mesh name or 'mesh_<index>'); a named node overwrites a single-primitive mesh's name.
// Node names are reserved in a fixed order (GLTFLoader loadScene / loadNode): each scene in turn (its own name first), its root nodes in the scene's order, and
// every node before its children, depth first. Mesh names come later, asynchronously, so they are taken after all node names. loadOrder is that order, once.
import { sanitize } from 'threedog/spelling';

/** Where a node sits, so two nodes with one name can be told apart: Armature/spine/weapon (mesh) */
const pathOf = n => { const up = []; for (let x = n; x; x = x.getParentNode()) up.unshift(sanitize(x.getName() || '(unnamed)')); return `${up.join('/')}${n.getMesh() ? ' (has mesh)' : ''}`; };

/** The named things GLTFLoader reserves a name for, in the order it does: [{ raw, node }] (node null = a scene; raw '' = unnamed, which takes no name but may carry a mesh). A node in no scene is not here */
function loadOrder(doc) {
  const out = [], seen = new Set();
  const visit = n => { if (seen.has(n)) return; seen.add(n); out.push({ raw: n.getName(), node: n }); n.listChildren().forEach(visit); };
  for (const sc of doc.getRoot().listScenes()) { if (sc.getName()) out.push({ raw: sc.getName(), node: null }); sc.listChildren().forEach(visit); }
  return out;
}

/**
 * The names GLTFLoader gives a document's nodes: sanitized, and a repeat becomes name_1, name_2 (createUniqueName), counted in loadOrder with the scene names.
 * The one rule for node names in the tools: `needs` and the { url, node } part lookup use it (the load sees the same names), and assets optimize's part check.
 * @returns {Map<any, string>} node -> loader name
 */
export function loaderNames(doc) {
  const seen = new Map(), out = new Map();
  for (const { raw, node } of loadOrder(doc)) {
    if (!raw) continue;
    const s = sanitize(raw), k = seen.get(s) ?? 0; seen.set(s, k + 1);
    if (node && raw) out.set(node, k ? `${s}_${k}` : s);
  }
  return out;
}

/** The node a { url, node } part names (authored or sanitized spelling, as assetPart.js reads it): { node, names } or null. names = loaderNames(doc) */
export function partNode(doc, name) {
  const names = loaderNames(doc), want = sanitize(name);
  const node = [...names].find(([, v]) => v === name)?.[0] ?? [...names].find(([, v]) => v === want)?.[0];
  return node ? { node, names } : null;
}

/** One informational line: how many, the first 3 names (all with --full) and why it is not a warning. Used for every name-shaped hint (here and the hidden nodes of report.mjs) */
export function hintLine(label, names, full, indent = '  ') {
  const shown = full ? names : names.slice(0, 3);
  return `${indent}hint        ${names.length} ${label}: ${shown.join(', ')}${shown.length < names.length ? `, … (--full lists all ${names.length})` : ''}`
    + ' · a name matters when the game declares it in needs / node (the needs check already errors on those) or looks it up itself (getObjectByName)';
}
const HINTS = { 'renamed-name': 'names GLTFLoader renames (two owners of one name)', 'sanitized-name': 'names that differ at runtime (. : / [ ] removed, space -> _)' };
/** The hint lines of a model's name issues, one per kind */
export const nameHintLines = (issues, full) => Object.entries(HINTS).flatMap(([code, label]) => {
  const names = issues.filter(i => i.code === code).map(i => i.name);
  return names.length ? [hintLine(label, names, full)] : [];
});

/** Info issues [{ severity: 'info', code, name, msg }] for every name GLTFLoader would suffix, naming both owners and the new name (hints do not count as warnings, --strict ignores them) */
export function renamedNodeIssues(doc) {
  const used = new Map(), owner = new Map(), issues = [], meshDone = new Set(), meshes = doc.getRoot().listMeshes();
  /** Reserve a name like createUniqueName; `visible` false = the result is overwritten later, so a clash costs a suffix slot but names nothing */
  const take = (raw, who, visible) => {
    const s = sanitize(raw);
    if (!used.has(s)) { used.set(s, 0); owner.set(s, who); return false; }
    const to = `${s}_${used.set(s, used.get(s) + 1).get(s)}`;
    if (visible) issues.push({ severity: 'info', code: 'renamed-name', name: `${who} -> ${to}`, msg: `${who} and ${owner.get(s)} are both called "${s}": three.js GLTFLoader renames ${who} to "${to}", `
      + `so a lookup by name (getObjectByName, bone name) finds ${owner.get(s)} or fails. Give them different names in Blender` });
    return true;
  };
  const nodes = [];
  for (const { raw, node } of loadOrder(doc)) {
    if (!node) { take(raw, `scene "${raw}"`, false); continue; }   // a scene name uses a slot of the same counter
    nodes.push(node);
    if (!raw) continue;
    // Blender's Wall.001 becomes Wall001 (the '.' is a track-path character): a lookup by the authored name finds nothing. A clash message already shows both names
    if (!take(raw, `node "${raw}" [${pathOf(node)}]`, true) && sanitize(raw) !== raw) issues.push({ severity: 'info', code: 'sanitized-name', name: `${raw} -> ${sanitize(raw)}`,
      msg: `node "${raw}" [${pathOf(node)}] is named "${sanitize(raw)}" at runtime (three.js removes . : / [ ] and turns spaces into _), so getObjectByName("${raw}") finds nothing. Rename it in Blender` });
  }
  for (const n of nodes) {
    const mesh = n.getMesh();
    if (!mesh || meshDone.has(mesh)) continue;
    meshDone.add(mesh);
    const prims = mesh.listPrimitives().length, base = mesh.getName() || `mesh_${meshes.indexOf(mesh)}`;
    for (let i = 0; i < prims; i++) take(base, `mesh "${sanitize(base)}" [on ${pathOf(n)}]`, !(prims === 1 && n.getName()));
  }
  return issues;
}
