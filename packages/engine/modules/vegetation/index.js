// Vegetation module factory: engine.use(vegetation(...)) installs two modules. 'vegetation' (data: species, placement, tree collision,
// felled trees; Vegetation.js) and 'vegetationDraw' (instanced meshes, wind, fade, LOD; draw.js, slot 'vegetation-draw').
// Why two: collision, paths and felling read only the data, so engine.use(myPlants, { replaces: 'vegetation-draw' }) swaps every pixel
// of the plants and keeps all of play.
import { vegetationModel } from '../../core/assets/namedModel.js';
import { reportError } from '../../core/base/errors.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { Vegetation } from './Vegetation.js';
import { VegetationDraw } from './draw.js';
import { GROUND_DEFAULTS } from './groundChunks.js';
import { codedError } from '../../core/base/errorHints.js';

const OPTS = ['chunkSize', 'viewChunks', 'density', 'area', 'seed'];
const VEG_PARAMS = keysSchema(OPTS, GROUND_DEFAULTS);   // defaults of the own-chunks mode (without terrain)
/**
 * The vegetation section of content data: model names resolve through vegetationModel, the same resolver vegetation.define uses for a name. All kinds register at
 * the same moment once all models are ready, since each registration rebuilds terrain chunks. One model that fails does not stop the others.
 * The models are made in commit, not prepare: nothing stands on vegetation, so the rest of a pack does not wait for them
 */
const VEGETATION_CONTENT = {
  desc: 'vegetation (name -> model, growth rule)',
  // taken back while its models were still generating. On what this load prepared, not on the table: the same table loaded again is a new load
  prepare: table => ({ table, undone: false }),
  undo: load => () => { load.undone = true; },
  commit: (load, { engine: e }) => Promise.all(Object.entries(load.table).map(([name, { model: m, lod, ...rest }]) =>
    Promise.all([vegetationModel(e, m), lod && vegetationModel(e, lod)])
      .then(([main, low]) => [name, { ...rest, ...main, ...(low && { lodGeometry: low.model ?? low.geometry }) }])
      .catch(err => { reportError(e, err, `content vegetation ${name}: model generation`, { soft: true }); return null; })))
    .then(list => { if (!load.undone) for (const v of list) if (v) e.vegetation.define(v[0], v[1]); }),
};

/**
 * Vegetation module. Provides engine.vegetation.define(name, {...}) once installed.
 * With terrain() installed first it grows on the terrain chunks and takes no options (density and view distance are terrain options).
 * Without terrain it grows on its own chunks over whatever provides the ground: a level model (engine.level), a code-built ground
 * (engine.setGround), or the flat default. Rules read engine.surface / slope / groundType, so a level's named surfaces are picked with
 * rule.biomes (a level's ground type is the mesh's groundType property or its material name).
 * Where a species grows is one define() call with up to three parts: rule (random scatter), positions (the game's own spots, instead of the
 * scatter) and densityMap (thins either by a function or a gray image). A game that wants full control still builds its own InstancedMesh.
 * @param {{ chunkSize?: number, viewChunks?: number, density?: number, area?: { min: number[], max: number[] }, seed?: number }} [opts]
 *   only without terrain: chunkSize meters (default 32), viewChunks rings drawn around each stream source (default 3), density multiplier (default 1),
 * area { min: [x, z], max: [x, z] } where it may grow (default: a level's walkable bounds when a level provides the ground, else anywhere), seed placement seed
 * (default 1)
 * @example
 * engine.use(level({ url: '/levels/town.glb' }), vegetation({ area: { min: [-80, -80], max: [80, 80] } }));
 * engine.vegetation.define('grass', { geometry, nearOnly: true, rule: { perChunk: 400, biomes: { lawn: 1 } } });   // only on 'lawn' surfaces
 * engine.vegetation.define('lamp-shrub', { geometry, positions: [[4, -2], [8, -2, 1.2, 0]] });              // exactly where the level designer put them
 * engine.vegetation.define('weed', { geometry, rule: { perChunk: 300 }, densityMap: (x, z) => zoning.wild(x, z) });   // 0..1 per spot, game data
 */
export function vegetation(opts = {}) {
  readParams('vegetation', VEG_PARAMS, opts);
  let v = null, own = null, drawPart = null;
  const data = { content: { vegetation: VEGETATION_CONTENT }, name: 'vegetation', skipKind: 'approx', type: 'world', provides: ['vegetation'], label: 'Vegetation', params: VEG_PARAMS, options: opts, stage: 'ground', after: ['terrain', 'level'], optional: ['terrain', 'level', 'settings'],
    install(e, ctx) {
      e.i18n.add({ 'zh-CN': { 'module.vegetation': '植被' }, en: { 'module.vegetation': 'vegetation' } });
      v = new Vegetation(e, opts, ctx);
      ctx.track(e.events.on('settings:shadows', () => v.host.refreshLevels()));   // whichever chunks it grows on: each level pass rereads the shadow switch
      if (v.host !== e.terrain) {
        own = v.host;
        ctx.ground.addColliders((x, z, range, fn) => own.forEachCollider(x, z, range, fn));   // collision and path planning see the trees
        ctx.stream.addReadyCheck('vegetation', s => own.readyAt(s));
      }
      return v;
    },
    // terrain installed after vegetation would leave two chunk tables: say where to put it
    // a wrong install order is a setup error, not something to play on with; a densityMap image that fails to load would start on bare ground
    critical: true,
    async init(e) {
      if (own && e.terrain) throw codedError('module-requires', 'vegetation() was installed before terrain(): put terrain() first, vegetation then grows on its chunks');
      // over a level or a code-built ground these chunks are the only ones: their rows are this module's to offer (on terrain, the terrain's)
      if (own) e.settings?.define('viewChunks', own.viewChunks, { menu: false, apply: n => { if (own.viewChunks !== n) own.viewChunks = n; } }).define('density', own.density, { menu: false, apply: n => { if (own.density !== n) own.density = n; } });   // the graphics tab draws them
      await v.whenLoaded();   // densityMap.url images of species added before start
    },
    frame(dt, e) { own?.update(e.stream.sources(), e.camera); },
    fixed(dt) { v.tick(dt); }, skip(dt, e, done) { if (done) v.tick(1); },
    describe(e, ctx) { if (own) ctx.out.perf.vegetation = { loaded: own.stats.loaded, visible: own.stats.visible, queued: own.stats.queued }; },
    dispose(e) { own?.dispose(); v?.detach(); } };
  const lookModule = {
    // the same vegetation({...}) call (its options are the data part's; the draw part reads the species' define() options)
    name: 'vegetationDraw', skipKind: 'none', type: 'picture', label: 'Vegetation drawing', params: VEG_PARAMS, options: opts, requires: ['vegetation'], provides: ['vegetation-draw'], stage: 'effects',
    install(e) { e.i18n.add({ 'zh-CN': { 'module.vegetationDraw': '植被外观' }, en: { 'module.vegetationDraw': 'vegetation drawing' } }); drawPart = new VegetationDraw(e, v); return drawPart; },
    frame() { drawPart.updateFade(); drawPart.updateCards(); },
    describe() { return { chunks: drawPart?.meshes.size ?? 0 }; },
    dispose() { drawPart?.dispose(); drawPart = null; },
  };
  return [data, lookModule];
}

export const handRolled = 'none: plants of its own are plain three.js, used on purpose';
