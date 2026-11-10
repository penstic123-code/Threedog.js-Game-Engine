// The "Already here" table of a new game's CLAUDE.md is not written twice: it is cut from AI.md (the one task table) at new-game time.
// KEYS picks the rows by the start of their first cell: the systems blind tests and field runs wrote by hand although the engine had them (2026-11-04 island run:
// dialogue, quests, interaction, terrain, water), plus the start every game takes. A key that matches no row (AI.md renamed it) is a `check` error (R22).
// Why each key names hint kinds: `check` warns about hand-rolled systems from each module's `export const handRolled` (R40). The table read before writing and the
// warning read after must point at the same engine API, or the AI is told two names for one system. hintProblems (run by R22) holds both directions:
// every hint kind sits under one key or in OFF_TABLE with the reason, and a row under a kind names an API that the kind's hint names.
const KEYS = [
  { key: 'Third-person start' }, { key: 'Player, characters' }, { key: 'Camera: follow', hints: ['follow'] }, { key: 'Keys, gamepad', hints: ['keys', 'lock'] },
  { key: 'Save game', hints: ['save'] }, { key: 'NPC conversation', hints: ['dialogue'] }, { key: 'Quests, objective', hints: ['quests'] },
  { key: 'Prompts, trigger zones', hints: ['reach'] }, { key: 'Items, chests', hints: ['inventory'] }, { key: 'UI, menus, HUD', hints: ['pause', 'settings', 'language'] },
  { key: 'Sound, music', hints: ['audio'] }, { key: 'Physics, ragdoll, collision', hints: ['collision', 'physics'] },
  { key: 'Terrain, height' }, { key: 'Water, rain' }, { key: 'Grass, trees' },
  { key: 'Time of day' }, { key: 'Slow, low fps' }, { key: 'Broke; describe' },
];
/** Hint kinds left out of the table on purpose: the table is read every session, so it holds what a game builds as a system; these are found by `threedog how` or `check` */
export const OFF_TABLE = {
  random: 'a correctness rule (AI.md "Common mistakes"), not a system to look for', timers: 'a correctness rule (AI.md "Common mistakes")', loop: 'a correctness rule (AI.md "Common mistakes")',
  loading: 'wired already: createEngine({ ui: { loading } }) in main.js', animation: 'per model, found by how (recipe 13)', grid: 'a helper function, found by how (recipe 29)',
  particles: 'an effect, found by how (recipe 64)', picking: 'found by how (recipe 19)', pool: 'found by how (recipe 65)', tween: 'found by how (recipe 07)',
};

/** The install calls of the modules (followCamera, settings...), aliases too: what a hint names besides engine.<name>. @param {Record<string, { call?: string, aliases?: { call: string }[] }>} modules */
export const installCalls = modules => Object.values(modules).flatMap(m => [m.call, ...(m.aliases ?? []).map(a => a.call)]).filter(Boolean);

/** The table rows of AI.md as [to-do, use, recipe] */
function aiRows(aiText) {
  return aiText.split(/\r?\n/).filter(l => /^\| /.test(l) && !/^\|[-| ]+\|$/.test(l)).map(l => l.slice(1, l.lastIndexOf('|')).split(/ \| /).map(c => c.trim())).filter(r => r.length === 3);
}

/** { table, missing, rows }: the markdown table for CLAUDE.md, the keys no AI.md row starts with, and each found row with its key */
export function defaultLayer(aiText) {
  const all = aiRows(aiText), missing = [], rows = [], out = ['| Needs | Use | Recipe |', '|---|---|---|'];
  for (const k of KEYS) {
    const r = all.find(x => x[0].startsWith(k.key));
    if (r) { out.push(`| ${r.join(' | ')} |`); rows.push({ ...k, row: r }); } else missing.push(k.key);
  }
  return { table: out.join('\n'), missing, rows };
}

/**
 * Where the table and the `check` hints disagree: [message]. hints = metadata.hints ({ kind: { use } }), calls = the module install calls (followCamera, settings...).
 * The API a hint names: every `engine.<name>` and every install call in its `use` text. A row agrees when its text has one of those names as a word.
 * @param {string} aiText @param {Record<string, { use: string }>} hints @param {string[]} calls
 */
export function hintProblems(aiText, hints, calls) {
  const { rows } = defaultLayer(aiText), out = [], placed = new Map();
  for (const r of rows) for (const k of r.hints ?? []) placed.set(k, r);
  for (const kind of Object.keys(hints)) if (!placed.has(kind) && !OFF_TABLE[kind]) out.push(`hint kind "${kind}" is neither under a key of the Already-here table nor in OFF_TABLE`);
  for (const [kind, r] of placed) {
    const h = hints[kind];
    if (!h) { out.push(`key "${r.key}" lists hint kind "${kind}", and no module declares it`); continue; }
    const names = [...new Set([...h.use.matchAll(/\bengine\.(\w+)/g)].map(m => m[1]).concat(calls.filter(c => new RegExp(`\\b${c}\\(`).test(h.use))))];
    if (!names.length) out.push(`hint "${kind}" names no engine API in its use text ("${h.use.slice(0, 60)}..."): write engine.<name> or the install call`);
    else if (!names.some(n => new RegExp(`\\b${n}\\b`).test(r.row.join(' ')))) out.push(`hint "${kind}" points at ${names.join(', ')}, the AI.md row "${r.key}" names none of them`);
  }
  return out;
}
