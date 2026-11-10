// Content loader: game data files into the engine.
// It hands the plain data in content/*.js to the modules (items, pickups, vegetation, NPCs, dialogues, quests, key actions, trigger zones, props).
//   engine.use(content());
//   engine.assets.manifest(yourAssets);                      // models content names (an asset pack; content never holds paths or code)
//   engine.content.load(data, { places: { home: { x, z } } });  // or several packs at once: load([base, dlc, level]) (packs.js)
// Condition/effect vocabulary is in rules.js. Games add condition words (content/rules.js, or content.condition(name, { test }) in code);
// a game's own actions are ops, called from content with { op: ['noun.verb', args] } and tested with { can: [...] }.
// Op names used in content are checked when the game becomes ready (did you mean...).
// Templates (content/templates.js): reusable objects placed from props.js ({ template, x, z }) or engine.content.spawn; see templates.js.
// Props (content/props.js) and pickups (pickups.js) are stored in engine.world (requires world(); openWorld() includes it; see props.js for the stable id
// rule),
// models and collision are built only near the focus; move / remove with engine.world.move / remove, saved with the save. Procedural models of vegetation and
// props go through core/assets/namedModel.js protoOf (name = model name; the same path pickups and vegetation use):
// baked files from npm run bake are read from file, otherwise cached automatically in dev. Models arrive asynchronously: the loading screen of start() waits
// for them (isReady) before the game counts as ready.
// Repeated load: a quest's startOn and a trigger's enter/exit effects do not attach listeners twice (the later load overrides the same name).
// Pickups, props and NPCs are initial world data: the save records only changes and removals, so content.load before or after loading a save gives the same
// result.
// Positions that use level markers belong to the current level: the data carries a zone, and a level change only tears down models (pickups taken and removals
// are remembered); trigger zones are removed on level change.
import { contentExplain } from './explain.js';
import { reportError } from '../../core/base/errors.js';
import { CONDITIONS, EFFECTS } from './rules.js';
import { missingText, warnOnce } from '../../core/base/validate.js';
import { loadContent, checkRefs, BUILTIN_TESTS, BUILTIN_RUNS } from './loader.js';
import { sectionsOf } from '../../core/base/sections.js';
import { addProps, needWorld } from './props.js';
import { templateOf, spawnTemplate, placeTemplate, defineTemplates } from './templates.js';
import { refit } from './models.js';
import { holdProtos } from '../../core/assets/namedModel.js';
import { packsOf } from './packs.js';
import { IdCheck } from './ids.js';
import { fieldsOf } from './fields.js';
import { placesOf, placeOf, offsetFrom, whereOf } from './places.js';
import { testWords, runWords } from './words.js';
import { setMark, marksPart } from './markers.js';
import { codedError, coded } from '../../core/base/errorHints.js';

/** The state the module's files share: loader.js and templates.js fill it on each content.load, st.e is set at install */
function contentState() {
  // the words of a section (startQuest) are its owner's: sections.effects, looked up per run because modules come and go
  const own = new Map(Object.entries(EFFECTS).map(([k, d]) => [k, { ...d, run: BUILTIN_RUNS[k] }]));
  const moduleWords = () => new Map([...sectionsOf(st.e).values()].flatMap(s => Object.entries(s.effects ?? {})));
  const st = {
    e: null, places: {},
    pending: new Set(),                               // model promises the module waits for (ready)
    queue: null,                                      // the last load still waiting to commit: the next one stands on it (loader.js)
    ops: new Set(), kinds: {},
    packs: new Set(),                                 // every pack loaded, latest last: what a module put back after a failed replaces gets again (replay)
    gaveWay: new WeakMap(),                           // pack -> names of its sections that gave way to a newer load: the replay leaves them out
    sectionIds: {}, refs: [],                         // ids each loaded section holds; ids sections name elsewhere, not checked yet (checkRefs)
    marks: new Map(),                                 // marker id -> [position, label]: what the marker effect shows (the content save part)
    templates: new Map(), templateViews: new Map(),   // template name -> frozen definition; name -> its presenter's handle
    templateSims: new Map(),                          // name -> the handle of its world.simulate (stages / update)
    templateSrc: new Map(),                           // dev: template name -> 'content/templates.js:12'
    templateFields: new Map(),                        // template name -> parsed state fields (fields.js), for placement checks and content.fields()
    levelPlace: name => !!name && !(name in st.places) && !!st.e.level?.marker(name),
    wait: p => { st.pending.add(p); p.catch(err => reportError(st.e, err, 'content model', { soft: true })).finally(() => st.pending.delete(p)); },
    conds: new Map(Object.entries(CONDITIONS).map(([k, d]) => [k, { ...d, test: BUILTIN_TESTS[k] }])),
    effects: { get: k => moduleWords().get(k) ?? own.get(k), keys: () => [...own.keys(), ...moduleWords().keys()] },
  };
  return st;
}

/** The object behind engine.content. Its methods call each other through api, so a wrapped method (engine.wrap) is the one that runs */
function contentApi(st) {
  const api = {
    /** All vegetation models are ready and the models of nearby world data such as props are built (world.ready) */
    get ready() { return st.pending.size === 0 && (!st.e.world || st.e.world.ready); },
    /** marker markers added by the marker effect: id -> hud marker */
    markers: new Map(),
    /**
     * @internal the marker / clearMarker effects: set (v = position) or clear (v = null) marker id. What is shown is playthrough state, kept in
     * the 'content' save part, so a load shows the save's markers and a new game none of the old ones (review 0.4 modules-a B5)
     */
    _mark(id, v, label) { setMark(st.e, api, st, id, v, label); },
    /**
     * Load content data: one pack (the object of content/index.js) or a list of packs loaded together in order, where an id defined by two packs is an error
     * (packs.js).
     * Models are asset names (engine.assets.manifest / an asset pack), never paths. Places: a pack's own places file, then the places option on top (a place
     * computed at startup: { places: { home } }); a place is a position, plus rot (radians about Y), and a place file's text entry waits for the option.
     * Loading again with a place moved or turned moves what stands there, models and collision too, unless play moved that record (world.add).
     * Answers for this load, once its transaction ended: resolves when it committed, rejects when it failed, after the old level and registrations are back
     * (err.notRestored lists what could not be). A load nobody awaits is reported all the same. Bad data throws on the line, and with nothing to wait for the pack is live on the
     * next line. Models keep arriving after it: engine.content.ready says when they did.
     * Inside a save part's load(data, turn) or a module's afterLoad(engine, turn), pass { turn }: without it the load waits for that replacement to end.
     * @example await engine.content.load([baseContent, forestDlc], { places: { home: { x: 0, z: 0 } } })
     * @param {any} data
     * @param {{ places?: Record<string, any>, turn?: object }} [opts]
     * @returns {Promise<void>}
     */
    load(data, { places: given = {}, turn } = {}) {
      const packs = packsOf(data), ids = new IdCheck();   // one IdCheck for the whole call: an id used in two packs' props / pickups is an error too
      const places = placesOf(packs, given);
      const run = st.e.ops.allow(() => loadContent(st.e, api, packs, st, ids, places, turn, st.checkOps));   // loading data is setup, not a gameplay action (ops guard)
      const finish = () => { ids.done(); for (const p of packs) { st.packs.delete(p); st.packs.add(p); } if (st.e.ready) checkRefs(st); };
      if (!run) { finish(); return Promise.resolve(); }
      const done = run.then(finish);
      st.wait(done);   // told once, here, whoever listens to done
      return done;
    },
    /**
     * @internal modules a replaces installed fresh, or a failed one put back ('module:restored'): their sections get every pack again, one load each as they came. A fresh install has
     * none of it. A section's format is its holder's, so a newcomer may refuse what was written for the old one: no line of the game asked for this load, so it is told, not thrown
     */
    _replay(mods) {
      const names = new Set(mods.flatMap(m => Object.entries(m.content ?? {}).filter(([, s]) => !s.once).map(([n]) => n)));
      for (const p of st.packs) {
        const part = Object.fromEntries(Object.entries(p).filter(([k]) => names.has(k) && !st.gaveWay.get(p)?.has(k))), ids = new IdCheck(), keys = Object.keys(part);
        try {
          const run = keys.length ? st.e.ops.allow(() => loadContent(st.e, api, [part], st, ids)) : null;
          if (run) st.wait(run);
          ids.done();
        } catch (err) { warnOnce(coded('content-misuse', `content: ${mods.map(m => m.name).join(', ')} refused ${keys.join(', ')} of pack ${p.name ?? '(no name)'}, written for the module it replaced, so that part stays out: ${err.message}`)); }
      }
    },
    /** Register a condition word: condition('timeAfter', { ref: 'clock', desc, test: (e, value) => ... }) */
    condition(name, def) { st.conds.set(name, def); return api; },
    /**
     * Whether a condition holds (object = all listed items hold, array = every item holds, function = called directly as fn(e, { actor })).
     * actor: whose bag { has } / { lacks } look in (default: the running op's actor, else engine.actor), so a net peer's dialogue checks the peer's bag.
     * @example engine.content.test({ has: { berry: 3 } }, { actor: 'peer-2' })
     * @param {any} c
     * @param {{ actor?: string }} [opts]
     */
    test(c, { actor = st.e.ops.actor } = {}) { return testWords(st.e, api, st.conds, c, actor); },
    /**
     * Run an effect (object, array or function fn(e, { actor })). actor: whose bag { give } / { take } change (default: the running op's actor, else
     * engine.actor), so a reward lands in the bag of whoever earned it. Every word runs; answers { ok: true }, or a failure with facts.failed [{ word, code, facts }]
     * (content:failed fires too): give in a full bag answers 'full' with facts.left, the items that did not fit. A function's own return value is the answer.
     * @param {any} a
     * @param {{ actor?: string }} [opts]
     */
    run(a, { actor = st.e.ops.actor } = {}) { return runWords(st.e, api, st.effects, a, actor); },
    /**
     * The shared definition of a content template (content/templates.js), frozen: instance state lives on the world record, never here.
     * @example engine.content.template('chest').container.capacity   // 6, the same for every chest
     * @param {string} name
     * @returns {Readonly<Record<string, any>>}
     */
    template(name) { return templateOf(st, name); },
    /**
     * Place a new instance of a content template at runtime (a gameplay change: call it inside an op or a fixed step); saved whole.
     * Returns the world record (kind = template name; without fields.id the id is numbered `<template>#<n>`, e.g. 'chest#3').
     * at is a ground position ({ x, z }, [x, y, z] or an object); fields may set id, rot, scale, y (height above ground), items (container start goods)
     * and the template's state fields (stage too, for a template with stages).
     * @example engine.ops.define('chest.build', { run: (e, { x, z }) => e.content.spawn('chest', { x, z }, { items: { stick: 3 } }).id });
     * @param {string} name
     * @param {any} at
     * @param {{ id?: string, rot?: number, scale?: number, y?: number, items?: Record<string, number>, [state: string]: any }} [fields]
     * @returns {import('../world/World.js').WorldRecord}
     */
    spawn(name, at, fields) { return spawnTemplate(st.e, st, name, at, fields); },
    /**
     * @internal A level-model node with the custom property template: an authored instance with id `<level>/<node>` (level module).
     * entry is a props-style entry ({ template, id, x, z, floor, rot, scale, state fields }); origin = { level, node }
     * @internal
     */
    placeNode(entry, zone, origin) { placeTemplate(st.e, api, st, entry, 0, zone, null, origin); },
    /**
     * The fields one content entry may have, in the core/base/params.js format ({ key: { type, optional?, default?, min?, max?, values?, desc? } }):
     * what an editor panel lists and what content-check validates against (one table, rules.js PLACEMENT_FIELDS + the template / kind `fields`).
     * name: a template name (its placement fields plus its state fields; default = the value in state), an engine entry shape
     * ('props', 'props.template', 'props.grid', 'pickups', 'views'), a game kind with fields (content/rules.js kinds), or a world record id
     * (answers for the shape that record came from).
     * @example engine.content.fields('crop').stage   // { type: 'int', optional: true, default: 0, min: 0, max: 4 }
     * @example engine.content.fields('props').rot    // { label: 'Facing', type: 'number|position', optional: true, desc: 'facing around the vertical axis, radians; or [x, y, z] radians to tilt it ...' }
     * @param {string} name
     * @returns {Record<string, { type: string, optional?: boolean, default?: any, min?: number, max?: number, values?: any[], desc?: string }>}
     */
    fields(name) { return fieldsOf(st.e, api, st, name); },
    /** @internal dev: where a template is defined ('content/templates.js:12'), null if unknown */
    templateSource(name) { return st.templateSrc.get(name) ?? null; },
    /** Place name -> position { x, z } plus y when the place has a height (level markers, places given with y) and rot when it is turned; null if not found */
    place(name) { return placeOf(st.e, st.places, name); },
    /** @internal a world x, z as the offset content writes from this place (null: no place), the inverse of where: the editor saves a drag through it */
    offset(place, x, z) { return offsetFrom(api, place, x, z); },
    /**
     * Position notation in content { place?, x?, z?, floor?, y? } -> world coordinates { x, z }, plus y when the notation pins a height.
     * floor: reference height for multi-layer ground (second storey, bridge deck, lower dungeon level): it stands on the highest layer not above floor;
     * a level-marker place lends its own height as floor. y: meters above that ground (shelves, floating pickups).
     * Without floor / y / a marker height the result is { x, z } and the thing sits on the top layer.
     * A place with rot turns the offsets x, z with it (the same sense as a model's rotation.y), so what stands there keeps its layout when the place turns.
     * @example engine.content.where({ place: 'tower', x: 1, floor: 6 })   // the tower's second floor, not its roof
     */
    where(p) { return whereOf(st.e, api, p); },
    /** @internal The floor a position notation stands on (its own floor, else its marker's height); undefined = top layer */
    _floorOf(p) { return p.floor ?? (p.place ? api.place(p.place)?.y : undefined); },
    /** @internal The facing of an entry: its own rot on top of its place's; undefined = neither is written, so the record stays without rot */
    _facingOf(p) {
      const r = p.place ? api.place(p.place)?.rot : undefined;
      if (r === undefined) return p.rot;
      return Array.isArray(p.rot) ? [p.rot[0], p.rot[1] + r, p.rot[2]] : r + (p.rot ?? 0);   // a place turns about Y, so it adds to the y part
    },
  };
  return api;
}

/** content may name ops that main.js defines after load: check once everything is set up, and inside the transaction of every load after that */
function checkOps(e, st) {
  for (const name of st.ops) if (!e.ops.defs.has(name)) throw codedError('unknown-name', `content: ${missingText('op', name, [...e.ops.defs.keys()])} (used in { op } / { can })`);
}

/** A section the loader itself reads before the others run (rules and renames change how they load). Declared so its name and sentence have one home */
const readEarly = desc => ({ desc, commit() {} });

export function content() {
  const st = contentState(), api = contentApi(st);
  return {
    name: 'content', skipKind: 'none', type: 'rules', label: 'Content',
    content: {
      templates: { desc: 'reusable objects (name -> model, collide, interact, container, sound, animate, state defaults, physics body); shared read-only definitions', commit(d) { needWorld(st.e); defineTemplates(st.e, api, st, d); } },
      props: { desc: 'props (list: model, position, facing, collision; or { template, x, z } = an instance of a template; or { id, grid, item, cell } = a grid item), streamed in on demand', live: true, commit(d, c) { if (d.length) addProps(st.e, api, d, st, c.zone, c.ids); } },
      actions: readEarly('own key actions of the game (action name -> default key, label)'),
      places: readEarly('place names (name -> { x, z, y?, rot? }; rot turns everything placed there about Y; coordinates may be computed at runtime in main.js)'),
      audio: readEarly('sounds by asset name, ambience and music rules as data, footsteps (sounds, ambience, music: { tracks, rules }, footsteps)'),
      views: readEarly('named fixed camera views (name -> { position: [x, y, z], target?: [x, y, z], fov? }); engine.views.show(name), ?view=name, npm run shot -- -w game --view name'),
      renames: readEarly("renamed or deleted authored ids (old id -> new id, or null = deleted on purpose): the player's saved changes follow the new id"),
      rules: readEarly('condition words and data kinds added by the game ({ conditions, kinds }); actions are ops, not effect words'),
    },
    optional: ['level', 'calendar', 'inventory', 'pickups', 'quests', 'particles', 'hud', 'vegetation', 'dialogue', 'triggers', 'collision', 'world', 'interactions', 'grids', 'rigid'],
    install(engine, ctx) { engine.i18n.add({ 'zh-CN': { 'module.content': '内容' }, en: { 'module.content': 'content' } });
      const e = st.e = engine;
      st.track = ctx.track;   // templates.js subscribes on content.load: those listeners belong to the module too
      ctx.track(holdProtos(e, api));   // the model prototypes its props and templates clone (namedModel.js): unloading content gives them back
      ctx.things.explainWith(contentExplain);
      ctx.saves.define('content', { ...marksPart(api, st), atomic: true });
      for (const holder of ['collision', 'collider3d']) ctx.feeds(holder, () => refit(e));
      ctx.track(e.events.on('engine:ready', () => { checkOps(e, st); checkRefs(st); }));
      ctx.track(e.events.on('module:restored', ({ modules }) => api._replay(modules)));
      ctx.track({ remove: () => { for (const m of api.markers.values()) m.remove(); api.markers.clear(); } });   // the marks stay in st.marks and the save part; only what is on screen goes
      st.checkOps = () => { if (e.ready) checkOps(e, st); };
      return api;
    },
    isReady() { return api.ready; },
    // ?at=<place> / applyState({ at }): this module owns the names, core does the placing with what it gets back. An unknown name stops here: a picture of the
    // spawn point taken for "the pier" would look fine and be wrong
    stateKeys: ['at'],
    applyState(e, { at }) {
      if (at == null) return;
      const p = api.place(at);
      if (!p) throw codedError('content-place', `applyState({ at: '${at}' }): no such place. Places: ${Object.keys(st.places).join(', ') || '(none loaded)'}; a level marker works too`);
      return p;
    },
    describe() {
      return { props: st.e.world ? st.e.world.query({ kind: 'prop' }).length : 0, templates: [...st.templates.keys()], markers: api.markers.size, sections: [...sectionsOf(st.e).keys()] };
    },
  };
}

export const handRolled = 'none: game data in plain objects is the normal way to start, not a bypass';
