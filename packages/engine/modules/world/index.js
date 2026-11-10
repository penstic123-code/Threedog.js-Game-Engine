// world() module: installed as engine.world (world data, see World.js). Models load around engine.stream sources; records stay when models unload. Independent of game type: slow-life NPCs, shooter enemies, survival zombies and containers all use it.
//   engine.use(world())                     // the openWorld() preset installs it by default
//   engine.use(world({ radius: 80 }))       // distance (meters) for building models and counting as near, default 60
// Save key world (runtime records whole, initial records only changes and removals, see the top of persist.js); emits world:load after loading. The loading screen waits for world.ready (nearby models all built). describe() reports world.total / byKind / presented, and nearby records with a name go into nearby.
import { recordSource } from './thingSource.js';
import { World } from './World.js';
import { WORLD_MIGRATE, worldChanges } from './persist.js';
import { worldExplain } from './explain.js';
import { closest, warnOnce, DEV, fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';

const PLACED = '[session] {n} world record(s) were created or removed by code before the game started ({ids}): a new game should equal the content. '
  + 'Move them to content (content/props.js with an id and a template from content/templates.js), or create them during play inside an op';

/**
 * Dev check on the new-game state (saves.define checkNewGame, run once start() finished): authored things come from content, so a new game has
 * no runtime records but the player and removes nothing. Changed fields are not checked: simulation may already move authored records (an NPC
 * walking its schedule) while loading runs in real time. Lives here, not in core/saves/session.js: only the world knows its own save format.
 * @param {any} d the world part of the new-game state
 */
function codePlaced(d) {
  const ids = [...Object.entries(d?.records || {}).filter(([, r]) => r.kind !== 'player').map(([id]) => id), ...(d?.removed || [])];
  if (ids.length) warnOnce(fmt(PLACED, { n: ids.length, ids: ids.slice(0, 8).join(', ') + (ids.length > 8 ? ', …' : '') }));
}

const ORPHAN = '[world] the save has changes for {n} id(s) that the content no longer defines: {list}. They are kept in the save (restoring the entry brings them back); '
  + "if an entry was renamed, add the pair to content/renames.js (export default { 'oldId': 'newId' }) and the saved state follows it; 'oldId': null drops it";
const RENAME_TARGET = '[world] content/renames.js moves saved state to {list}, which no content entry defines: fix the new id (did you mean {near}?)';

const WORLD_PARAMS = keysSchema(['cellSize', 'radius', 'farEvery', 'farMaxPerTick', 'buildPerFrame']);

/**
 * World data module: installed as engine.world. Put things here that must be saved, survive level changes and keep changing while far away; models are only built while nearby
 * @example engine.use(world())
 * @param {{ cellSize?: number, radius?: number, farEvery?: number, farMaxPerTick?: number, buildPerFrame?: number }} [opts]
 * @returns {import('../../types/core').ModuleDef<World>}
 */
export function world(opts = {}) {
  readParams('world', WORLD_PARAMS, opts);
  let w = null;
  return {
    name: 'world', skipKind: 'approx', type: 'world', provides: ['world'], label: 'World data', params: WORLD_PARAMS, options: opts, stage: 'ground',
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.world': '世界数据' }, en: { 'module.world': 'world data' } });
      w = new World(e, opts);
      const followed = e.stream.player.pos;
      e.stream.player.at(() => w.center);   // the default stream source sits where gameplay is simulated (world.anchor, else the player)
      ctx.track({ remove: () => e.stream.player.at(followed) });   // no closure over this world stays behind
      ctx.stream.addReadyCheck('world', s => s.detail !== 'full' || w.ready);
      // after the modules, not in world's own step: physics writes the models at stage late, and a record must end the step on the solver's result, a save included
      ctx.track(e.onFixed(() => w._v.pull(), { phase: 'late' }));
      ctx.track(e.time.onMove(() => w._s.moved()));
      ctx.saves.define('world', { atomic: true, version: 5, migrate: WORLD_MIGRATE, save: () => w.toJSON(), load: d => w.fromJSON(d), checkNewGame: codePlaced });
      ctx.things.addSource(recordSource(w));   // engine.thing / thing.set / the shared id space reach the records through this
      ctx.things.explainWith(worldExplain);
      ctx.budget.metric('worldRecords', () => w.records.size);
      if (DEV) {   // orphans are known once content loaded (engine:ready), after a load, and per level for `<level>/<node>` ids
        const warn = () => {
          targets();
          const o = w.orphans(); if (!o.length) return;
          const ids = [...w._base.keys()];
          // a near id the save has no data for is the likely new name: suggest the exact renames.js pair
          const list = o.slice(0, 8).map(id => { const c = closest(id, ids); return c ? `${id} (did you mean ${c}? renames: { '${id}': '${c}' })` : id; });
          warnOnce(fmt(ORPHAN, { n: o.length, list: list.join(', ') + (o.length > 8 ? ', …' : '') }));
        };
        const targets = () => {   // a rename target nothing defines moves the player's state into a void: name it (level-node targets once that level loaded)
          const due = id => { const i = id.indexOf('/'); return i < 0 || w._levels.has(id.slice(0, i)); };
          const bad = [...w._renames].filter(([, b]) => b != null && !w._base.has(b) && due(b));
          if (bad.length) warnOnce(fmt(RENAME_TARGET, { list: bad.map(([a, b]) => `${b} (from ${a})`).join(', '), near: closest(bad[0][1], [...w._base.keys()]) ?? '-' }));
        };
        for (const ev of ['engine:ready', 'save:loaded', 'level:loaded']) ctx.track(e.events.on(ev, () => { if (e.ready) warn(); }));
      }
      return w;
    },
    isReady() { return w.ready; },
    afterLoad(e) { if (e.halted) w.refresh(); return w.whenReady; },   // a paused engine has no frames to build in: build now
    counts() { let views = 0; for (const id of w.records.keys()) if (w.view(id)) views++; return { records: w.records.size, views }; },   // engine.counts().world
    fixed(dt) { w.fixed(dt); },
    skip(dt, e, done) { w._s.skip(dt, done); },
    frame(dt) { w.frame(dt); },
    describe(e, ctx) {
      const byKind = {};
      for (const r of w.records.values()) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      // with a model, report by the model (merged with the interaction and other modules' reports on the same object into one entry); skip records of another zone (level)
      // a record without a name (props, template instances) is listed by its id, nearest 8 only: 'kind' shows what it is, and the list is capped so a thick prop field cannot push NPCs out of nearby
      let unnamed = 0;
      for (const r of w.query({ near: ctx.center, radius: ctx.radius })) {   // nearest first
        if (!w.inZone(r) || (r.name == null && unnamed >= 8)) continue;
        if (r.name == null) unnamed++;
        ctx.near(w.view(r.id) ?? r.position, { id: r.id, name: r.name ?? r.id, kind: r.kind }, true);
      }
      const orphans = w.orphans();
      return { total: w.records.size, byKind, presented: w._v.map.size, zone: w.zone, ...worldChanges(w), ...(orphans.length && { orphans: orphans.slice(0, 20) }) };
    },
    dispose() { w.dispose(); },
  };
}

export const handRolled = 'none: far records by hand are ordinary objects in ordinary lists';
