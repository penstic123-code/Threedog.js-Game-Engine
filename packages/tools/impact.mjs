// threedog impact <id|field|op|capability> [-w game] [--full]: before a change, what it touches: content, calls, saved parts, templates, tests, engine facts.
// It reads the files alone, no page: the game's content (content-check's loader, each section's own `references`), its code, the generated metadata and CODEMAP, and the test folders.
// A name written in full is what it can find. It always says what it cannot see: names computed in game code, and whatever only a running page or a player's save holds.
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { metadata } from 'threedog/metadata';
import { ENGINE, within, posix } from './paths.mjs';
import { loadGame } from './content-check/load.mjs';
import { sectionRefs, engineFile } from './content-check/section-refs.mjs';
import { esc, gameCodeFiles, read } from './lib/text.mjs';
import { parseOptions } from './lib/cli-args.mjs';
import { relatedTests } from './threedog/verify.mjs';

/** Lines of a group printed by default */
const SHOWN = 3;
const TESTS_MAX = 20;
/** Calls that take a name, written with something other than a plain string: impact cannot follow those */
const COMPUTED = /\b(?:ops\.(?:run|can)|world\.(?:get|remove|move)|inventory\.(?:add|remove|has|count)|saves\.(?:define|register)|input\.(?:pressed|down|bind|define|action)|interactions\.add|pickups\.spawn|thing\.\w+)\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/;
/** Every place in a section's data that holds the name, as a key or a whole string value: ['pickups[0].item', ...] */
function holds(value, path, target, out) {
  if (value === target) out.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => holds(v, `${path}[${i}]`, target, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (k === target) out.push(`${path}.${k}`);
    holds(v, `${path}.${k}`, target, out);
  }
}

/** Save parts a module's source registers */
const savePartsOf = file => [...read(engineFile(file)).matchAll(/saves\.(?:define|register)\(\s*['"]([\w.-]+)['"]/g)].map(m => m[1]);

/** What the generated metadata says about the name: lines, and the modules it belongs to */
function engineFacts(t) {
  const lines = [], owners = new Set(), { modules, sections, contracts, actions, fields } = metadata;
  for (const [id, m] of Object.entries(modules)) {
    if (id === t || m.call === t || m.provides.includes(t)) { lines.push(`module ${m.call}() (${m.file})`); owners.add(id); }
    if (m.requires.includes(t)) lines.push(`${m.call}() requires it`);
    if (m.optional.includes(t)) lines.push(`${m.call}() uses it when present`);
    if (m.params?.[t]) lines.push(`option ${t} of ${m.call}()`);
    if (m.names.includes(t)) lines.push(`engine.${id}.${t}`);
  }
  if (sections[t]) { lines.push(`content section of ${sections[t].owner}`); owners.add(sections[t].owner); }
  for (const [name, c] of Object.entries(contracts)) {
    if (name === t) lines.push(`capability contract ${name} (${c.file}): ${c.api.length} names`);
    else if (c.api.includes(t) || c.fields.includes(t)) lines.push(`part of the ${name} contract (${c.file})`);
  }
  for (const a of actions) if (a.action === t) lines.push(`input action, ${a.file}`);
  for (const [shape, f] of Object.entries(fields)) if (f[t]) lines.push(`placement field of ${shape}`);
  const map = join(ENGINE, 'docs/CODEMAP.md'), word = new RegExp(`(^|[^\\w.-])${esc(t)}($|[^\\w-])`);
  if (existsSync(map)) for (const l of readFileSync(map, 'utf8').split('\n')) if (l.startsWith('|') && word.test(l) && !lines.some(x => l.includes(x))) lines.push(`code map: ${l.replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ')}`);
  return { lines: [...new Set(lines)], owners };
}

/**
 * Everything impact reports for one name: { ok, text, data }
 * @param {string} dir game folder  @param {string} target  @param {{ full?: boolean }} [o]
 */
export async function impact(dir, target, { full = false } = {}) {
  const { data, files } = await loadGame(dir), facts = engineFacts(target), g = f => posix(relative(dir, f));
  const content = [], templates = [], sections = new Set(), said = [];
  for (const r of await sectionRefs(data)) if (r.id === target) { content.push(`${g(files[r.section] ?? r.section)} ${r.at} (names ${r.names}.${r.id})`); sections.add(r.section); said.push(r.at); }
  for (const [name, pack] of Object.entries(data)) {
    const at = []; holds(pack, name, target, at);
    for (const p of at) {
      if (said.some(a => p === a || p.startsWith(a + '.') || p.startsWith(a + '['))) continue;   // the section's own reference said it better
      (name === 'templates' ? templates : content).push(`${g(files[name] ?? name)} ${p}`); sections.add(name);
    }
  }
  const quoted = new RegExp(`['"\`]${esc(target)}['"\`]|\\.${esc(target)}\\b|\\b${esc(target)}\\(`), calls = [], saved = [], computed = [];
  for (const f of gameCodeFiles(dir).filter(x => !within(x, join(dir, 'content')))) read(f).split('\n').forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    const at = `${g(f)}:${i + 1}`;
    if (COMPUTED.test(l)) computed.push(at);
    if (!quoted.test(l)) return;
    (/saves\.(?:define|register)\(/.test(l) ? saved : calls).push(`${at} ${l.trim().slice(0, 90)}`);
  });
  for (const id of new Set([...facts.owners, ...[...sections].map(s => metadata.sections[s]?.owner).filter(Boolean)])) {
    const parts = metadata.modules[id] ? savePartsOf(metadata.modules[id].file) : [];
    if (parts.length) saved.push(`${metadata.modules[id].call}() saves it in part ${parts.join(', ')}; a renamed id goes in content/renames.js, or old saves lose it`);
  }
  const tests = relatedTests(dir, [target], TESTS_MAX).map(t => t.name ? `${t.at} ${t.name}` : t.at);
  const unseen = [`Cannot see: names computed in game code (${computed.length ? `${computed.length} such call${computed.length > 1 ? 's' : ''}: ${computed.slice(0, SHOWN).join(', ')}` : 'none found here'}); what only a running page registers (threedog catalog); what is in players' saves.`];
  const groups = { Content: content, Calls: calls, 'Saved parts': saved, Templates: templates, Tests: tests, Engine: facts.lines };
  const total = Object.values(groups).reduce((n, l) => n + l.length, 0);
  const head = total ? `impact ${target}: ${total} places` : `impact ${target}: nothing found. That does not prove it is unused:`;
  const lines = Object.entries(groups).filter(([, l]) => l.length).flatMap(([k, l]) => [`${k} (${l.length}):`, ...(full ? l : l.slice(0, SHOWN)).map(x => '  ' + x), ...(!full && l.length > SHOWN ? [`  … ${l.length - SHOWN} more, --full`] : [])]);
  return { ok: true, text: [head, ...lines, ...unseen].join('\n'), data: { target, content, calls, saved, templates, tests, engine: facts.lines, computed } };
}

/** Bridge-table command: no page needed */
export async function impactCommand(dir, args) {
  const { opt, rest } = parseOptions(args, { flags: ['full'], positional: true });
  if (rest.length !== 1) return { ok: false, text: 'Usage: threedog impact <id|field|op|capability> [-w game] [--full]' };
  return impact(dir, rest[0], { full: !!opt.full });
}
