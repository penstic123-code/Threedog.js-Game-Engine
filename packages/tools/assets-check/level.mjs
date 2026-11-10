// Level manifest: what the level module will find in a glb (spawn, col_, trigger_, npc_, marker_, template / id nodes), read statically from the file.
// The same JSON feeds `threedog assets check`, content-check (content then needs no hand-written description of Blender markers) and AI queries.
// The naming rules mirror modules/level (meshes.js COL_RE, nodes.js MARKER_RE and record ids); change them together.
import { basename, extname } from 'node:path';
import { sanitize } from 'threedog/spelling';
import { renamedNodeIssues } from './names.mjs';

const MARKER_RE = /^(spawn|spawn_.*|npc_.*|trigger_.*|marker_.*)$/i;

/**
 * @param {any} doc glTF Transform Document
 * @param {string} file path; its base name is the level name in record ids `<level>/<node>`
 * @returns {{ file: string, level: string, spawns: any[], colliders: any[], triggers: any[], npcs: any[], markers: any[], records: any[], templates: Record<string, number>, issues: { severity: 'error' | 'warn', code: string, msg: string }[], counts: Record<string, number> }}
 */
export function levelManifest(doc, file) {
  const level = basename(file, extname(file));
  const m = { file, level, spawns: [], colliders: [], triggers: [], npcs: [], markers: [], records: [], templates: {}, issues: [] };
  const issue = (severity, code, msg) => m.issues.push({ severity, code, msg });
  const names = new Map(), ids = new Map();
  const walk = (node, underCol) => {
    const name = sanitize(node.getName()), x = node.getExtras() || {}, position = node.getWorldTranslation().map(v => +v.toFixed(3));
    const col = /^col_/i.test(name) || x.collider != null;
    if (MARKER_RE.test(name)) {
      names.set(name, (names.get(name) || 0) + 1);
      const mk = { name, position };
      if (/^spawn/i.test(name)) m.spawns.push(mk);
      else if (/^trigger_/i.test(name)) m.triggers.push({ ...mk, tag: name.slice(8), ...Object.fromEntries(['shape', 'radius', 'height'].filter(k => x[k] != null).map(k => [k, x[k]])) });
      else if (/^npc_/i.test(name)) m.npcs.push(mk);
      else m.markers.push(mk);
    } else if (x.template != null || x.id != null) {
      const id = `${level}/${name}`, template = x.template != null ? String(x.template) : undefined;
      m.records.push({ id, node: name, kind: template ? 'template' : 'node', ...(template && { template }), position });
      ids.set(id, (ids.get(id) || 0) + 1);
      if (template) m.templates[template] = (m.templates[template] || 0) + 1;
    }
    if (col && !underCol) {
      m.colliders.push({ name, via: /^col_/i.test(name) ? 'col_ name' : 'collider property' });
      const hasMesh = n => n.getMesh() || n.listChildren().some(hasMesh);
      if (!hasMesh(node)) issue('warn', 'empty-collider', `${name} is named as a collider but has no mesh, so it blocks nothing (colliders are built from meshes)`);
    }
    for (const c of node.listChildren()) walk(c, underCol || col);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n, false);
  m.issues.push(...renamedNodeIssues(doc));
  for (const [n, c] of names) if (c > 1) issue('error', 'duplicate-marker', `marker ${n} appears ${c} times; the level keeps only one of them (rename in Blender)`);
  for (const [id, c] of ids) if (c > 1) issue('error', 'duplicate-id', `record id ${id} is used by ${c} nodes, they would share one saved state (rename the nodes in Blender)`);
  m.counts = { spawns: m.spawns.length, colliders: m.colliders.length, triggers: m.triggers.length, npcs: m.npcs.length, markers: m.markers.length, records: m.records.length };
  return m;
}

/** Add the issues that need the game's content (loadGame data): templates the glb names but content/templates.js lacks */
export function checkAgainstContent(m, content) {
  const defined = content?.templates || {};
  for (const r of m.records) if (r.template && !defined[r.template]) m.issues.push({ severity: 'error', code: 'missing-template', msg:
    `${r.id} uses template "${r.template}", which content/templates.js does not define (defined: ${Object.keys(defined).join(', ') || 'none'})` });
  return m;
}

/** fromLevel trigger zones of content that no level glb has a trigger_<tag> node for */
export function missingTriggers(content, levels) {
  const tags = new Set(levels.flatMap(l => l.triggers.map(t => t.tag)));
  return Object.entries(content?.triggers || {}).filter(([tag, t]) => t?.fromLevel && !tags.has(tag)).map(([tag]) => tag);
}

/** One line: "spawns 1 · colliders 12 · triggers 3 · npcs 2 · markers 0 · records 2 · templates door x2" */
export function summarize(m) {
  const c = m.counts, t = Object.entries(m.templates).map(([k, v]) => `${k} x${v}`).join(', ');
  return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' · ') + (t ? ` · templates ${t}` : '');
}
