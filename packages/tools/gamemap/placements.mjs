// GAMEMAP sections (used by packages/tools/gamemap.mjs): where the level comes from, and which engine systems the game does not use yet.
//   placementLines: authored placements per content file (counts by template / model / item / kind), then what game code creates at startup that a save would duplicate, and code managing world models (rule R33).
//   unusedLines: the systems from the AI.md "before writing gameplay code" list that this game has not installed, one hint each.
import { read, cut } from './text.mjs';
import { scanText } from '../rules/R33-authored-placement.mjs';

const count = (list, key) => Object.entries(list.reduce((a, x) => { const k = key(x); a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, n]) => `${k}×${n}`).join(', ');
const size = v => Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;

/** Authored placements by content file, then code placements found by R33 in the game's code files (gameFiles: absolute paths; g: path relative to the game) */
export function placementLines(c, gameFiles, g) {
  const out = [];
  const props = Array.isArray(c.props) ? c.props : [];
  if (props.length) {
    const ids = props.filter(p => p.id).length;
    out.push(`- content/props.js: ${props.length} (${count(props, p => p.template ? `template ${p.template}` : [p.model].flat()[0])}); ${ids} with an explicit id, places: ${[...new Set(props.map(p => p.place ?? 'world'))].join(', ')}`);
  }
  const pickups = Array.isArray(c.pickups) ? c.pickups : [];
  if (pickups.length) out.push(`- content/pickups.js: ${pickups.length} (${count(pickups, p => p.item)})`);
  for (const k of ['npcs', 'containers', 'triggers']) if (size(c[k])) out.push(`- content/${k}.js: ${size(c[k])} (${cut(Object.keys(c[k]).join(', '), 100)})`);
  if (size(c.vegetation)) out.push(`- content/vegetation.js: ${size(c.vegetation)} rules (instances generated from each rule)`);
  for (const k of Object.keys(c.rules?.kinds || {})) if (size(c[k])) {
    const v = c[k], kinds = Array.isArray(v) ? v : Object.values(v);
    const by = kinds.every(x => x && typeof x === 'object') ? count(kinds, x => x.shape ?? x.kind ?? x.type ?? k) : '';
    out.push(`- content/${k}.js (game kind): ${size(v)}${by ? ` (${by})` : ''}`);
  }
  if (!out.length) out.push('- none in content yet: place things with a template (content/templates.js) and a placement (content/props.js)');
  const found = [];
  for (const f of gameFiles) {
    if (!/\.m?js$/.test(f) || /(^|[\\/])bake\.js$/.test(f)) continue;
    for (const r of scanText(read(f), f)) found.push(`- ⚠ ${g(f)}:${r.line} ${r.msg.split(':')[0]}`);
  }
  out.push('', found.length ? `Code that breaks saves or manages world models (rule R33; move it into content, or into an op if it happens during play):` : 'Code that breaks saves or manages world models: none (rule R33).', ...found);
  return out;
}

// [system, installed when, one-line hint]
const SYSTEMS = [
  ['inventory', (m, c) => m.has('inventory'), 'items, stacks, containers and pickups: `inventory()` + key map presets.bindings.inventory, content/items.js (recipes/03-items-pickups.md)'],
  ['collision', m => m.has('collision'), 'walls and blocking for characters: `collision()` (in openWorld), template `collide` (recipes/18-world.md)'],
  ['characters', m => m.has('characters'), 'player and NPC movement, spawn, schedules: `characters()` (in openWorld), content/npcs.js (recipes/02-npc.md)'],
  ['saves', (m, c, code) => /saves\.(define|register|save|autosave)\(/.test(code), 'save your own state: `engine.saves.define(key, { version, save, load })` (recipes/20-content-actions-save.md)'],
  ['interactions', m => m.has('interactions'), 'press a key near a thing: `interactions({ ...presets.interactions.nearest })` (E, nearest; the game picks the pick mode and keys), template `interact: { label, op }` (recipes/30-templates.md)'],
  ['quests', m => m.has('quests'), 'goals with steps, conditions and rewards: `quests()` + key map presets.bindings.quests, content/quests.js (recipes/04-quests.md)'],
  ['swarm', m => m.has('swarm'), 'many same-kind moving things (shots, crowds, flocks, debris) in typed arrays, drawn as one mesh: `swarm()` (recipes/65-swarm.md)'],
  ['grids', m => m.has('grids'), 'cell placement for farming and building: `grids()` (recipes/29-grid.md)'],
  ['templates', (m, c) => Object.keys(c.templates || {}).length > 0, 'reusable objects placed from content: content/templates.js + props { template } (recipes/30-templates.md)'],
];

/** Systems the game does not use yet (installed: names of the installed module functions; code: the game's code text) */
export function unusedLines(installed, c, code, docRef) {
  const m = new Set(installed);
  return SYSTEMS.filter(([, used]) => !used(m, c, code)).map(([name, , hint]) => `- ${name}: ${hint.replace(/recipes\/[\w-]+\.md/g, r => docRef('docs/' + r))}`);
}
