// R64 every public capability stays reachable (error): each module, factory, engine.<group> and recipe has a line of plain task words in how-tasks.mjs, a category and a card
// (threedog how --browse, --card), and threedog how answers that line with the capability in the five routes it lists. Why a rule and not a test: a module added later must fail the
// check the day it is added. A task line may not hold the capability's own name, or the proof proves nothing.
// What this proves: one fixed sentence per capability, written beside this rule, reaches it within five routes, and browsing can reach it. What it does not prove: that words nobody wrote
// here reach it, that it is the route how recommends first (how prints one route, the others need --full), or that an AI finds it or wires it right. Those are not measured.
// A miss is fixed where how reads (how-words.mjs, an AI.md row, a recipe heading), never by changing the task words until they echo the docs.
import { readFileSync, readdirSync } from 'node:fs';
import { metadata } from 'threedog/metadata';
import { abs, P } from './_lib.mjs';
import { search, tokens, firstRoute } from '../how.mjs';
import { parseDocRef } from 'threedog/error-hints';
import { capabilityCards } from '../how-browse.mjs';
import { MODULES, FACTORIES, GROUPS, RECIPES, CATEGORIES, NOT_FOR, ROUTES } from '../how-tasks.mjs';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const split = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
/** A route names a capability when its printed line or the place it sends the reader to does: call(), engine.name, name.method or its api page */
const named = names => new RegExp(names.flatMap(n => [`\\b${esc(n)}\\(`, `\\b${esc(n)}\\.\\w`, `\\bengine\\.${esc(n)}\\b`, `api/${esc(n)}\\.md`]).join('|'));

/** Every capability: { kind, id, file, task, own: words the task may not hold, found: route text -> did how name it } */
export function capabilities(meta = metadata, surface = readFileSync(abs('docs/api-surface.txt'), 'utf8'), recipes = readdirSync(abs(`${P.DOCS_REL}/recipes`))) {
  const out = [], add = (kind, id, file, task, ownNames, re) => out.push({ kind, id, file, task, own: new Set(ownNames.flatMap(split)), found: t => re.test(t) });
  for (const [id, m] of Object.entries(meta.modules)) {
    const names = [id, m.call, ...m.provides, ...(m.aliases ?? []).map(a => a.call)];
    add('module', id, m.file, MODULES[id], [id, m.call], named(names));
    for (const a of m.aliases ?? []) add('factory', a.call, a.file, FACTORIES[a.call], [a.call], named([a.call, id]));
  }
  for (const g of new Set([...surface.matchAll(/^engine sub-objects \| (\w+)\./gm)].map(m => m[1]))) add('group', g, 'docs/api-surface.txt', GROUPS[g], [g], named([g]));
  for (const f of recipes.filter(x => x.endsWith('.md')).map(x => x.slice(0, -3))) add('recipe', f, `${P.DOCS_REL}/recipes/${f}.md`, RECIPES[f], [], new RegExp(`\\b${esc(f)}\\.md|\\brecipes? 0*${parseInt(f)}\\b`));
  return out;
}

/** What a capability is missing: a sentence, or '' when how finds it */
export function gap(c, docs) {
  if (!c.task) return `${c.kind} ${c.id} has no task words`;
  const typed = tokens(c.task).filter(t => c.own.has(t));
  if (typed.length) return `the task words of ${c.kind} ${c.id} use its own name (${typed.join(', ')})`;
  const hits = search(docs, c.task, 5);
  return hits.some(h => c.found(`${h.line} ${h.at} ${h.para} ${h.text}`)) ? '' : `threedog how "${c.task}" does not list ${c.kind} ${c.id}`;
}

/** Does pointer `got` name the section `want` names (the same file; the same number or a heading starting the same; a file-only want takes any section of it) */
const sameSection = (got, want) => !!got && got.file === want.file && (want.sec ? got.sec === want.sec : want.title ? !!got.title?.toLowerCase().startsWith(want.title.toLowerCase()) : true);
/**
 * A ROUTES line (how-tasks.mjs) against how: '' when how opens the section it names, else what it did. A `top` route is checked against the route how
 * really recommends (firstRoute, the same pick as threedog how, in a game and outside one); any route fails on a weak match, where how recommends nothing.
 */
export function routeMiss([task, want, o = {}], docs) {
  const w = parseDocRef(`recipes/${want}`), hits = search(docs, task, 5, { renderer: o.renderer });
  if (!w) return `ROUTES line "${task}" names no section that parses: recipes/${want}`;
  const ok = h => !!h && sameSection(parseDocRef(h.ref ?? ''), w), i = hits.findIndex(ok);
  const picks = [firstRoute(hits, false), firstRoute(hits, true)];
  if (!hits.weak && (o.top ? picks.every(ok) : i >= 0)) return '';
  const got = picks.find(p => !ok(p)) ?? hits[0];
  return `threedog how "${task}"${o.renderer ? ` (${o.renderer} game)` : ''} ${hits.weak ? 'is a weak match for' : i < 0 ? 'does not list' : `does not recommend`} recipes/${want}; recommends: ${got?.ref || 'nothing'}`;
}

/** What browsing gets wrong against the capabilities: one with no category or card, a card with nothing to act on, a line whose capability is gone. [sentence] */
export function browseProblems(list, cards, tables = { MODULES, FACTORIES, GROUPS, RECIPES, NOT_FOR }, categories = CATEGORIES) {
  const ids = new Set(list.map(c => c.id)), card = new Map(cards.map(c => [c.id, c]));
  const listed = Object.values(categories).flatMap(c => c.ids.trim().split(/\s+/));
  return [...list.flatMap(c => {
    const k = card.get(c.id);
    if (!k) return [`${c.kind} ${c.id} has no card in threedog how --card`];
    return [...(k.category ? [] : [`${c.kind} ${c.id} is in no category of threedog how --browse`]), ...(k.solves && (k.install || k.read) ? [] : [`the card of ${c.kind} ${c.id} says neither what it solves nor how to reach it`])];
  }), ...[...Object.values(tables).flatMap(t => Object.keys(t)), ...listed].filter(k => !ids.has(k)).map(k => `how-tasks.mjs has a line for ${k}, which no longer exists`)];
}

/** Modules that say nothing about hand-written code: the hints stay honest only if a silent module is impossible, so none is forgotten. [{ file, msg }] */
export function silent(modules) {
  return Object.entries(modules).filter(([, m]) => !m.handRolled).map(([id, m]) => ({ file: m.file, msg: `module ${id} does not say what hand-written code it replaces` }));
}

export default {
  id: 'R64', title: 'Every capability has task words how answers, a category and a card, and every module says what hand-written code it replaces',
  run() {
    const docs = abs(P.DOCS_REL), list = capabilities(), error = /** @type {const} */ ('error');
    const out = list.flatMap(c => { const msg = gap(c, docs); return msg ? [{ level: error, file: c.file, line: 1, msg, fix: c.task ? 'add the author\'s word to how-words.mjs, or a row to CONVENTIONS.md "One task, which entry"' : 'add a line to packages/tools/how-tasks.mjs' }] : []; });
    const wrong = browseProblems(list, capabilityCards(docs)).map(msg => ({ level: error, file: 'packages/tools/how-tasks.mjs', line: 1, msg, fix: 'keep how-tasks.mjs to what exists and give each capability a place in CATEGORIES; cards are generated from it, the metadata and the docs' }));
    const quiet = silent(metadata.modules).map(p => ({ level: error, line: 1, ...p, fix: "add export const handRolled = [{ kind, seen, use, code }] to the file (rules/R40-bypass-hints.mjs lists the fields), or = 'none: <why no code shape shows it>'; then npm run map" }));
    // the route list: a top route that is not the first answer is an error (the template sends the AI there in one step); any other miss warns, so the
    // count stays visible while the ranking is improved (2026-11-09: 19 of 74 open, listed in docs/plans/2026-11-09-docs-layers.md)
    const routes = ROUTES.flatMap(r => { const msg = routeMiss(r, docs); return msg ? [{ level: r[2]?.top ? error : /** @type {const} */ ('warn'), file: 'packages/tools/how-tasks.mjs', line: 1, msg, fix: 'fix where how reads: the section heading, the AI.md row, how-words.mjs; not the task words' }] : []; });
    return Object.assign([...out, ...wrong, ...quiet, ...routes], { note: `${list.length - out.length} of ${list.length} capabilities reached by their fixed task line; ${ROUTES.length - routes.length} of ${ROUTES.length} routes open their section` });
  },
};
