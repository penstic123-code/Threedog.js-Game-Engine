// GAMEMAP sections found by scanning the game's code (used by packages/tools/gamemap.mjs): timed events, objective markers and HUD, key actions,
// events, save keys and style keys. ctx: c = loaded content, dir = game folder, g = path relative to the game folder, gameFiles, code = all
// game code without comments, ce = the createEngine(...) call text, sec(title, rows) = add a section.
import { basename } from 'node:path';
import { docRef } from '../paths.mjs';
import { read, uniq, noComments } from './text.mjs';
import { declaredEvents, eventLines } from './extra.mjs';

const CODEMAP = docRef('docs/CODEMAP.md');

/**
 * Whether source code uses the input action a: read by input (pressed / pressedRaw / down / released('a')), or named as the action of an
 * interaction (interactions.add(obj, { action: 'a' }), a thing's second key). Why the second form: an action used only by an interaction
 * was listed as "(not used)" although the engine reads it for that interaction
 */
export function actionUsed(src, a) {
  const q = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), s = `['"\`]${q}['"\`]`;
  return new RegExp(`\\b(pressed|pressedRaw|down|released)\\(\\s*${s}\\s*\\)|\\baction\\s*:\\s*${s}`).test(src);
}

export function codeSections({ c, dir, g, gameFiles, code, ce, sec }) {
  // Timed events (engine.clock, engine.sky; between lists both clock times)
  const tm = [];
  const TIMED = /(?:clock|calendar)\.(at|between|after|every|daily|onSeason)\(([^,)]*(?:, '[^']*')?)/g;
  for (const f of gameFiles) for (const m of noComments(read(f)).matchAll(TIMED)) tm.push(`- ${m[1]}(${m[2].trim()}) — ${g(f)}`);
  if (tm.length) sec('Timed events (engine.clock, engine.sky)', uniq(tm));

  // Objective markers (hud)
  const hl = [];
  for (const [id, q] of Object.entries(c.quests || {})) q.steps.forEach((s,
    i) => { if ([s, ...s.all || []].some(g => g.target !== undefined)) hl.push(`- Quest ${id} step ${i + 1} is marked automatically`); });
  const fx = JSON.stringify(c).match(/"marker":("[^"]*"|\{[^}]*\})/g) || [];
  if (fx.length) hl.push(`- Content effect marker: ${fx.map(x => x.slice(9)).join(', ')}`);
  for (const f of gameFiles) {
    for (const m of noComments(read(f)).matchAll(/hud\.(marker|counter|bar)\(([^,)]*)/g)) hl.push(`- hud.${m[1]}(${m[2].trim()}) — ${g(f)}`);
  }
  if (hl.length) sec('Objective markers and HUD (hud module)', uniq(hl));

  // Key actions
  const handled = a => gameFiles.filter(f => actionUsed(read(f), a)).map(g).join(', ') || '(not used)';
  const al = Object.entries(c.actions || {}).map(([a, d]) => `| ${a} | ${d.keys.join(' ')} | ${d.label} | ${handled(a)} |`);
  for (const m of code.matchAll(/input\.bind\(\s*'(\w+)',\s*\[([^\]]*)\]/g)) al.push(`| ${m[1]} | ${m[2].replace(/'/g, '')} | | ${handled(m[1])} |`);
  sec(`Key actions defined by the game (the engine's own are in ${CODEMAP})`,
    al.length ? ['| Action | Default keys | Label | Handled in |', '|---|---|---|---|', ...al] : []);

  // Events
  const ev = {};
  const add = (n, k, w) => (ev[n] ||= { emit: [], on: [] })[k].push(w);
  // emit(cond ? 'a' : 'b', …) counts both names
  const EVENT_CALL = /events\.(on|once|emit)\((?:[^?),'"`]*(?:'[^']*'[^?),'"`]*)*\?\s*)?'([\w:]+)'(?:\s*:\s*'([\w:]+)')?/g;
  for (const f of gameFiles) for (const m of noComments(read(f)).matchAll(EVENT_CALL))
    for (const n of [m[2], m[3]].filter(Boolean)) add(n, m[1] === 'emit' ? 'emit' : 'on', basename(f));
  for (const [id, q] of Object.entries(c.quests || {})) if (q.startOn) add(q.startOn, 'on', `quests.js (starts ${id})`);
  if (c.triggers) { add('trigger:enter', 'on',
    'triggers.js (loader)'); if (Object.values(c.triggers).some(t => t.onExit)) add('trigger:exit', 'on', 'triggers.js (loader)'); }
  sec('Events the game emits / listens to', eventLines(ev, declaredEvents(dir, g)));

  // Save keys
  const sv = [];
  const sk = code.match(/saveKey: '([^']+)'/); sv.push(`- Save prefix saveKey: ${sk ? sk[1] : 'default'}`);
  const slots = uniq([...code.matchAll(/saves\.(?:save|load)\('([^']+)'\)/g)].map(m => m[1])); if (slots.length) sv.push(`- Save slots: ${slots.join(', ')}`);
  const auto = code.match(/saves\.autosave\(([^)]*)\)/); if (auto) sv.push(`- Autosave: every ${auto[1] || 'default'} minutes`);
  const reg = uniq([...code.matchAll(/saves\.(?:define|register)\('([^']+)'/g)].map(m => m[1])); if (reg.length) sv.push(`- Save entries the game registers itself: ${reg.join(', ')}`);
  sv.push('- Saved parts of the engine modules (vars, inventory, quests, timers, world...): `threedog catalog` (saves per module)');
  sec('Saves', sv);

  // Style keys
  const st = [];
  const vegModels = Object.values(c.vegetation || {}).flatMap(v => [[v.model].flat()[0], v.lod].filter(Boolean));
  const tplModels = Object.values(c.templates || {}).map(t => [t?.model].flat()[0]).filter(m => typeof m === 'string');
  const models = uniq([...code.matchAll(/\.models\.(\w+)/g)].map(m => m[1]).concat(vegModels, tplModels,
    (c.props || []).filter(p => !p.template).map(p => [p.model].flat()[0])));
  if (models.length) st.push(`- Models (asset names): ${models.join(', ')}`);
  const inContent = JSON.stringify(c).match(/"particles":\{"name":"(\w+)"/g)?.map(s => s.split('"')[5]) || [];
  const used = uniq([...code.matchAll(/particles\.(?:emit|attach)\('(\w+)'/g)].map(m => m[1]).concat(inContent));
  const defined = uniq([...code.matchAll(/particles\.define\('(\w+)'/g)].map(m => m[1]));
  if (used.length) st.push(`- Particle presets (style.particles): ${used.map(p => defined.includes(p) ? `${p} (defined by the game)` : p).join(', ')}`);
  const sk2 = uniq([...code.matchAll(/\b(?:engine|e)\.style\.(\w+)/g)].map(m => m[1]));
  if (sk2.length) st.push(`- style keys read directly: ${sk2.join(', ')}`);
  if (Object.keys(c.vegetation || {}).length) st.push(`- Vegetation (content/vegetation.js): ${Object.keys(c.vegetation).join(', ')}`);
  sec('Style keys', st);
}
