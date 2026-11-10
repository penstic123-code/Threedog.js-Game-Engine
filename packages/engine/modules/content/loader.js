// Content loading: hands the plain data of content/*.js to the modules (items, pickups, vegetation, NPCs, dialogues, quests, key actions, trigger zones,
// props).
// Position notation: { place: 'home', x: 1, z: 5 } = offset from place home; places come from the places argument of load or level markers; without place it is
// a world coordinate.
// Optional floor (reference height on multi-layer ground) and y (meters above that ground): see content.where.
import { toast } from '../../ui/UI.js';
import { srcOf, applyRenames, pickupId } from './ids.js';
import { DEV, warnOnce } from '../../core/base/validate.js';
import { NO_GAME_EFFECTS, contentFiles, kindProblems, unknownContent } from './rules.js';
import { sectionHomes } from '../../core/inspect/metadata.generated.js';
import { sectionsOf, runSections, keepTable } from '../../core/base/sections.js';
import { whenTurnFree, whileRestoring, liveTurn } from '../../core/saves/stateReplace.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { failure } from '../../core/ops/opsFail.js';

// data order, not ownership: a place or template must exist before what stands on it. A section not listed runs after these. Rules, actions, audio, views and renames run before all of them (loadSteps)
const ORDER = ['level', 'vegetation', 'items', 'startItems', 'containers', 'pickups', 'npcs', 'dialogues', 'quests', 'triggers', 'grids', 'templates', 'props'];
const isEmpty = d => d == null || (typeof d === 'object' && Object.keys(d).length === 0);
const each = (o, fn) => Object.entries(o || {}).forEach(([k, v]) => fn(k, v));
const all = (o, fn) => Object.entries(o || {}).every(([k, n]) => fn(k, n));

/**
 * The bag the item words (has / lacks / give / take) use: the container of ctx.actor (content.test / run pass it; default the running op's actor, else
 * engine.actor), never a fixed 'player' bag. Without the module, a clear error instead of a TypeError deep inside
 */
const inv = (e, word, ctx) => e.inventory?.of(ctx?.actor ?? e.ops.actor) ?? (() => { throw codedError('content-misuse', `content word { ${word} } needs the inventory module: add inventory() to engine.use(...), `
  + 'or track the thing with a flag / counter ({ setFlag } / { bump }) or a game condition word instead'); })();

/** Execution part of the engine's built-in words (descriptions are in rules.js). A run answers by returning a failure ({ ok: false, code, facts }); runWords hands it up */
export const BUILTIN_TESTS = {
  can: (e, v, raw, ctx) => e.ops.can(v[0], v[1] ?? {}, { actor: ctx?.actor }).ok,
  flag: (e, v) => !!e.vars.flag(v),
  notFlag: (e, v) => !e.vars.flag(v),
  has: (e, v, raw, ctx) => all(v, (id, n) => inv(e, 'has', ctx).has(id, n)),
  lacks: (e, v, raw, ctx) => all(v, (id, n) => !inv(e, 'lacks', ctx).has(id, n)),
  counter: (e, v) => all(v, (k, n) => e.vars.counter(k) >= n),
};
export const BUILTIN_RUNS = {
  op: (e, v, raw, ctx) => e.ops.run(v[0], v[1] ?? {}, { actor: ctx?.actor }),
  setFlag: (e, v) => e.vars.setFlag(v),
  // add keeps what fits and calls that ok, so the rest is this word's to report; facts.left is exactly what { give } could still pay later
  give(e, v, raw, ctx) {
    const left = {};
    each(v, (id, n) => { const r = inv(e, 'give', ctx).add(id, n), got = r.ok ? r.added : 0; if (got < n) left[id] = n - got; });
    return Object.keys(left).length ? failure({ code: 'full', facts: { left } }) : undefined;
  },
  take(e, v, raw, ctx) {
    const short = Object.entries(v).filter(([id, n]) => !inv(e, 'take', ctx).remove(id, n)).map(([id]) => id);
    return short.length ? failure({ code: 'notEnough', facts: { short } }) : undefined;
  },
  bump: (e, v) => e.vars.bump(v),
  toast: (e, v) => toast(e, v),
  particles: (e, v) => e.particles.emit(v.name, v.at, { count: v.count }),
  marker: (e, v, raw) => e.content._mark(markerId(raw), v, raw.label),   // the same marker again replaces the old one
  clearMarker: (e, v, raw) => e.content._mark(markerId(raw), null),
};
const markerId = raw => raw.id ?? (typeof raw === 'string' ? raw : raw.place ?? `${raw.x},${raw.z}`);

/**
 * Load content packs as one transaction (core/base/sections.js): every pack is checked and prepared before any commits, and whatever fails after that takes every commit
 * back, so a refused load changed nothing. packs are the merged objects of content/index.js; api is engine.content; ids is the IdCheck of this load call (ids.js); st is
 * the content module's load state (shared across repeated load calls): { kinds, ops, sectionIds, refs, levelPlace(name), wait(promise) }; places are this load's new places;
 * turn says it belongs to the state replacement running now (stateReplace.js). checkOps refuses op names nothing defines; a replay passes none, its pack was checked when it came.
 * Returns the Promise of the transaction, or nothing when it ended on this tick.
 * Order per pack: vocabulary -> key actions, audio, views (core services) -> renames -> the modules' sections in ORDER -> any other section -> game kinds. Packs commit in
 * load order, so a later pack stands on an earlier one; with a level file to wait for the whole load commits after it, on the new level's markers. A load waits for the one
 * before it (st.queue) and goes down with it: a level that failed leaves nothing to stand on. A load with its turn does neither: the load before it may be waiting for that very
 * replacement to end, and what a load() brings in is part of the state it builds, not of the line outside. content's isReady waits for all of it.
 * What a section's data means belongs to the module that owns it: replacing the quests module replaces the quests format.
 * Pickups, props and NPCs are initial world data: the save records only changes and removals, independent of load order (rules at the top of world/persist.js).
 * Positions that use level markers (not in places) belong to the current level: pickup, prop and NPC data carry a zone (= current level name,
 * engine.world.zone),
 * a level change only tears down models and they are rebuilt on return, with taken / moved / removed state intact; trigger zones are not data and are removed
 * on level change (level.track).
 */
export function loadContent(e, api, packs, st, ids, places = {}, turn, checkOps) {
  const { where } = api;
  const origin = (id, list, key) => { if (DEV) e.world?.setOrigin(id, { definedAt: srcOf(list, key) }); };
  const onLevel = (...ps) => ps.some(p => p && typeof p === 'object' ? st.levelPlace(p.place) : st.levelPlace(p));
  const bind = (h, ...ps) => { if (h && onLevel(...ps)) e.level?.track(h); return h; };
  const zoneOf = (...ps) => onLevel(...ps) ? e.world?.zone ?? null : null;
  const sections = sectionsOf(e), kinds = { ...st.kinds };
  const list = [{ s: {
    undo: () => keepLoad(e, st),
    // the first commit of the load, so a refusal leaves the rest uncommitted: a game kind's load has no undo. Not in validate: a load waiting for a file may meet an op defined meanwhile
    commit() { Object.assign(st.places, places); for (const p of packs) collectOps(p, st.ops); checkOps?.(); },
  } }];
  for (const pack of packs) list.push(...loadSteps(e, api, pack, st), ...packSections(e, pack, st, sections, kinds));
  // track: these listeners run content words, so they go with the content module
  const inTurn = liveTurn(e, turn), after = inTurn ? null : st.queue, c = { engine: e, content: api, where, bind, zone: zoneOf, ids, origin, pickupId, track: st.track, after };
  // a commit writes state, so it lands between replacements, never inside one: a pack that waited on a file through a load commits on the state that load left
  const commits = fn => { const r = e.ops.allow(fn); if (r) whileRestoring(e, r); return r; };   // only a failure whose undo has to wait gives a result
  const run = runSections(list, c, { after, around: fn => whenTurnFree(e, () => commits(fn), turn) });
  if (!run || inTurn) return run;
  const tail = st.queue = run.finally(() => { if (st.queue === tail) st.queue = null; });
  return tail;
}

/** The undo of a whole load: the world, which several sections write, and the tables content itself fills */
function keepLoad(e, st) {
  const world = e.world?.undoPoint();
  const tables = [st.conds, st.ops, st.templates, st.templateFields, st.templateSrc].map(keepTable);
  const { templateViews, templateSims } = st, was = { kinds: { ...st.kinds }, places: { ...st.places }, sectionIds: structuredClone(st.sectionIds), refs: st.refs.length };
  const views = new Set(templateViews.keys()), sims = new Set(templateSims.keys());
  return () => {
    world?.();
    for (const fn of tables) fn();
    st.kinds = was.kinds; st.places = was.places; st.sectionIds = was.sectionIds; st.refs.length = was.refs;
    for (const [map, had] of [[templateViews, views], [templateSims, sims]]) for (const [name, h] of map) if (!had.has(name)) { h.remove(); map.delete(name); }
  };
}

/** What a pack registers with the core services and the vocabulary its sections read, as steps of the transaction */
function loadSteps(e, api, c, st) {
  const steps = [];
  // game kinds stay registered across loads, so a later content.load({ recipes }) without rules still finds them
  if (c.rules) steps.push({ commit() { each(c.rules.conditions, (name, d) => api.condition(name, d)); Object.assign(st.kinds, c.rules.kinds); } });
  // a pack's actions are the game's own (owner 'game'): loading the pack again replaces them, it is not a second binder
  if (c.actions) steps.push({ undo: () => e.input.keepActions(Object.keys(c.actions)), commit: () => each(c.actions, (name, a) => e.input.define(name, { label: a.label, keys: a.keys, ...(a.context ? { context: a.context } : {}) })) });
  // audio: sounds / footsteps by name into engine.audio.config, rules to ambience() / music() (core/audio/audioRules.js). A pack loaded again
  // replaces its own rules (hot reload): a named pack by its name, an unnamed one by the data object itself, so loading the same object
  // twice never stacks its rules (a fresh key per load did); two different unnamed objects both keep theirs
  const key = c.name ? 'pack:' + c.name : c;
  if (c.audio) steps.push({ undo: () => e.audio.keepPack(key), commit: () => e.audio.contentPack(key, c.name ? `pack "${c.name}"` : 'pack (no name)', c.audio) });
  // views: named fixed camera views (core/scene/Views.js); defining a name again replaces it, so a hot reload just works
  if (c.views) steps.push({ undo: () => keepTable(e.views.map), commit: () => each(c.views, (name, v) => e.views.define(name, v)) });
  // saved state under an old id must reach the new id before anything is placed under it. The world goes back with keepLoad
  let goods = null;
  if (c.renames) steps.push({ undo: () => () => goods?.(), commit() { goods = applyRenames(e, c.renames); } });
  return steps.map(s => ({ s }));
}

/** The sections of one pack, in ORDER. Every check that needs no commit runs here, before anything of the load commits. Game kinds are sections too, after the modules' */
function packSections(e, pack, st, modules, kinds) {
  if (pack.rules?.effects) throw codedError('content-misuse', NO_GAME_EFFECTS);
  const bad = kindProblems(pack.rules);
  if (bad.length) throw codedError('content-misuse', 'content/rules.js: ' + bad.join('; '));
  Object.assign(kinds, pack.rules?.kinds);
  const known = { ...contentFiles({ kinds }), ...Object.fromEntries(modules) };
  for (const k of Object.keys(pack)) if (k !== 'name' && !known[k]) throw codedError('unknown-option', 'content.load: ' + unknownContent(k, { kinds }));
  const sections = new Map(modules);
  for (const [name, k] of Object.entries(kinds)) {
    if (sections.has(name)) throw codedError('content-misuse', `content kind "${name}" is also a section of module ${sections.get(name).owner}: keep one`);
    sections.set(name, { owner: 'game', commit: (data, c) => k.load?.(e, data, c.content) });
  }
  const rank = n => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
  for (const name of Object.keys(pack)) {
    const home = sectionHomes[name];
    if (home && !sections.has(name) && !isEmpty(pack[name])) throw codedError('module-needs', `content ${name}: no installed module reads this section. Add ${home} to engine.use(...), or a module with content: { ${name}: { commit } }`);
  }
  const done = (name, s) => r => {
    if (typeof r?.then === 'function') st.wait(r);
    st.gaveWay.get(pack)?.delete(name);
    note(st, name, s, pack[name]);
  };
  const gaveWay = name => () => { if (!st.gaveWay.has(pack)) st.gaveWay.set(pack, new Set()); st.gaveWay.get(pack).add(name); };
  return [...sections].filter(([name]) => pack[name] != null).sort(([a], [b]) => rank(a) - rank(b)).map(([name, s]) => ({ s, data: pack[name], done: done(name, s), gaveWay: gaveWay(name) }));
}

/** What the reference check (checkRefs) needs from a section just loaded */
function note(st, name, s, data) {
  const ids = st.sectionIds[name] ??= new Set();
  for (const k of Array.isArray(data) ? data.map(x => x?.id) : Object.keys(data)) if (k != null) ids.add(k);
  st.refs.push(...s.references?.(data) ?? []);
}

/** Ids a section names in a section that was loaded and does not have them. Only when that section was loaded: a game may define its items in code */
export function checkRefs(st) {
  for (const { section, id, at } of st.refs.splice(0)) {
    if (st.sectionIds[section] && !st.sectionIds[section].has(id)) warnOnce(coded('content-misuse', `content ${at}: ${section} has no "${id}"`), `${at}:${id}`);
  }
}

/** Op names that content data refers to ({ op: [...] } / { can: [...] } anywhere), checked against engine.ops once the game is ready */
function collectOps(v, out, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 12) return;
  if (!Array.isArray(v)) for (const k of ['op', 'can']) if (Array.isArray(v[k]) && typeof v[k][0] === 'string') out.add(v[k][0]);
  for (const x of Array.isArray(v) ? v : Object.values(v)) collectOps(x, out, depth + 1);
}
