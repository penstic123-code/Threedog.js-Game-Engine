// R69 public names keep the one verb set (error). The three rules every doc teaches (AI.md "Three rules"): each thing has a name describe / explain finds;
// each thing has an owner, and adding it gives back a handle with remove(); a value several sides change has one owner. A public name that breaks them is
// a second way to say the same act, which an AI then guesses wrong:
//   1. an add* / on* function on engine, its sub-objects or a module API returns a handle with remove() (the checker reads the awaited return type, null aside);
//   2. a registration says define (a named kind or rule), add (one placed thing), set, remove, describe: register / create / bind / make / attach / subscribe /
//      listen / declare / mount / hook / insert / append / put are other words for the same act;
//   3. a define* function takes the name first (a string): rule 1 says a defined kind is found by its name;
//   4. giving back is remove (one registration, one record, one saved thing). clear / forget / release / unload / dispose are other verbs for it, each allowed only
//      where it does something remove cannot say, and the exception names that (empty a whole set at once, let go of a hold that has no handle, tear down the owner).
// Existing exceptions are listed below by name, each with its reason; one that no longer applies (gone, or now passing) is an error too, so the list cannot rot.
// Why from the type checker (api-count's pass, shared with R55) and not from source: the public surface is what an AI's editor shows. Engine repository only.
// Known limits: ctx registrars are not on the public surface (modules.js keeps them to define / add by review); a name outside these groups (createEngine, the
// exported module factories) is a factory, where create is the JS word.
import { existsSync } from 'node:fs';
import { publicItems } from '../api-count.mjs';
import { read, abs, P } from './_lib.mjs';

const GROUPS = /^(engine members|engine sub-objects|module APIs)$/;
const ADDS = /^(add|on)([A-Z]|$)/;
const DEFINES = /^define([A-Z]|$)/, NAME_FIRST = /^\??(?:<[^>]*>)?\(\s*\w+\??: string\b/;
const TAKEOUT = /^(clear|forget|release|unload|dispose)([A-Z]|$)/;
const SYNONYMS = /^(register|create|bind|make|attach|subscribe|listen|declare|mount|hook|insert|append|put)([A-Z]|$)/;

/** name -> why it may break the rule (doc/plans/2026-11-09-one-idea.md lists the doubtful ones for the batch 6 blind test) */
export const EXCEPTIONS = {
  // returns something other than a handle
  'add': 'mirrors three.js scene.add: returns the object; engine.remove(obj) takes it out',
  'characters.addPlayer': 'returns the Character (engine.player), what the whole game reads; characters.removePlayer(id) takes it out',
  'world.add': 'returns the saved record; world.remove(id): a record is save data, and a handle would outlive a load',
  'inventory.add': 'adds an amount of an item, not a registration; inventory.remove(id, n) takes it back',
  'settings.addSection': 'builds the settings menu at setup and chains; the menu lives as long as the settings module',
  'i18n.add': 'merges string tables and chains; a later table overrides, there is nothing to take out',
  'plugins.add': 'plugs a folder of plugin files; each comes out by name with plugins.off(name)',
  'plugins.on': 'switches a plugged plugin back on (the pair of plugins.off), not an event listener',
  'jobs.add': 'a one-off job that ends by itself; returns the Promise of its result',
  'grids.add': '@experimental; returns the Grid, which lives as long as the grids module',
  'player.addJumps': '@experimental; chains on the character, the jumps go with it',
  // another verb (clear / forget / release / unload / dispose: rule 4)
  'triggers.clear': 'empties the whole set in one call (the JS word, as Map.clear); one zone comes out with its own handle, zone.remove()',
  'debug.clear': 'ends everything one owner overrode or switched (the view too) in one call, as the owner argument says; the single override has no handle to remove',
  'particles.clear': 'kills the live particles of an effect (all of them without a name) and leaves the effect defined; nothing registered goes away, so it is not remove',
  'level.unload': 'takes the loaded level out as a whole (the pair of level.load): the level is one scene, not a registration with a handle',
  'assets.release': 'lets go of the data of a model or texture name when nothing draws it (the pair of the load): it frees memory, it removes no registration',
  'views.release': 'gives the camera back to the previous holder (the pair of the call that took it); the holder has no handle, the call is the take-back',
  'page.releaseLock': 'lets go of the pointer lock the browser gave (document.exitPointerLock); the verb follows the browser, nothing registered goes away',
  'control.forget': '@experimental; the engine drops every hold on a character that left the world (world:remove calls it); it ends all owners, which a single handle cannot',
  'player.dispose': 'tears the player down with its model and listeners (the pair of characters.addPlayer); dispose is the verb of an object that owns resources',
  'nav.dispose': 'frees the navmesh and its workers (the module teardown); dispose is the verb of an object that owns resources',
  'dispose': 'engine.dispose() ends the whole engine and frees the renderer (three.js: renderer.dispose); the one teardown every owner of resources has',
  'input.bind': 'sets the keys of an action (a set with an owner layer, returns a handle); "bind keys" is the word every engine and every player menu uses, and input.set would read as setting an input value',
  'particles.attach': 'a relation (the emitter follows an object), not a registration; returns the emitter',
  'saves.putAttachment': '@experimental; a blob store write like Cache.put, keyed by group and id',
  'ui.create': '@experimental; makes a fresh instance of a multi part, registers nothing',
};

/** What breaks the rule in a list of public items @param {{ group: string, name: string, decl: string, handle: boolean | null }[]} items */
export function verbProblems(items, exceptions = EXCEPTIONS) {
  const out = [], seen = new Set();
  for (const i of items) {
    if (!GROUPS.test(i.group) || i.handle === null) continue;
    const n = i.name.split('.').pop(), noHandle = ADDS.test(n) && !i.handle, synonym = SYNONYMS.test(n) || TAKEOUT.test(n), unnamed = DEFINES.test(n) && !NAME_FIRST.test(i.sig ?? '');
    if (!noHandle && !synonym && !unnamed) continue;
    seen.add(i.name);
    if (Object.hasOwn(exceptions, i.name)) continue;
    out.push({ level: 'error', file: i.decl, line: 1, msg: noHandle ? `${i.name} adds without giving back a handle with remove()` : unnamed ? `${i.name} defines without taking the name first` : `${i.name}: '${(n.match(SYNONYMS) ?? n.match(TAKEOUT))[1]}' is another word for define / add`,
      fix: noHandle ? 'return { remove() } (ctx.track takes it), or list the name in R69 EXCEPTIONS with why it cannot' : 'name it define (a named kind or rule), add (one placed thing) or set; a rename removes the old name in the same change and the CHANGELOG lists it (design.md 2.6)' });
  }
  for (const name of Object.keys(exceptions)) if (!seen.has(name)) out.push({ level: 'error', file: 'packages/tools/rules/R69-one-verb-set.mjs', line: 1, msg: `R69 exception '${name}' no longer applies (gone, or it now keeps the rule)`, fix: 'delete it from EXCEPTIONS' });
  return out;
}

// CONVENTIONS.md names the exceptions on one line so an AI reading the conventions sees them; this table stays the one source (it holds the
// reasons), and the line must name exactly its keys: a list kept by hand in two places drifted before (five names in the doc, seventeen here).
const DOC_REL = `${P.DOCS_REL}/CONVENTIONS.md`, DOC_LINE = /^\s*Exceptions to the verb rules\b/;

/** The doc line against the table: names missing from it and names it has that the table does not @param {string} text */
export function docListProblems(text, exceptions = EXCEPTIONS) {
  const L = text.split('\n'), at = L.findIndex(l => DOC_LINE.test(l));
  if (at < 0) return [{ level: 'error', file: DOC_REL, line: 1, msg: 'CONVENTIONS.md has no "Exceptions to the verb rules" line', fix: 'restore the line under "Registrations return a handle": the names of R69 EXCEPTIONS' }];
  const named = new Set([...L[at].split(':').slice(1).join(':').matchAll(/`([\w.]+)`/g)].map(m => m[1]));
  const keys = new Set(Object.keys(exceptions)), out = [];
  for (const k of keys) if (!named.has(k)) out.push({ level: 'error', file: DOC_REL, line: at + 1, msg: `R69 exception \`${k}\` is missing from the CONVENTIONS line`, fix: `add \`${k}\` to the line` });
  for (const n of named) if (!keys.has(n)) out.push({ level: 'error', file: DOC_REL, line: at + 1, msg: `the CONVENTIONS line names \`${n}\`, which is no R69 exception`, fix: 'drop it from the line, or add it with its reason to EXCEPTIONS' });
  return out;
}

export default {
  id: 'R69', title: 'Public names: add / on give back a handle, registrations use define / add / set / remove / describe', game: false,
  run() {
    const items = publicItems(), out = verbProblems(items);
    if (existsSync(abs(DOC_REL))) out.push(...docListProblems(read(DOC_REL)));
    out.note = `${items.length} public names, ${Object.keys(EXCEPTIONS).length} listed exceptions`;
    return out;
  },
};
