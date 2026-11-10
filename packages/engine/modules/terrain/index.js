// Terrain module: chunked, streamed ground built from a height function (or a height map), with edits, workers and ground types.
// After install: engine.terrain is the data part (chunk manager: heights, chunks, edits, collision); engine.terrainDraw draws it (slot 'terrain-draw').
// engine.surface()/slope()/groundType() come from the data part.
//
// The engine ships no landform and no ground types: terrain() alone is flat gray ground at y = 0 (a placeholder, with a dev warning).
// A game passes a generator: its own pure functions, or a preset such as terrainPreset() from @threedog/terrain-noise:
//   engine.use(terrain({ seed: 7, ...terrainPreset(), flatten: [{ x: 0, z: 0, radius: 20 }] }));
//   engine.use(terrain({ height: (x, z, n) => 10 * n.fbm(x * 0.01, z * 0.01), groundType: (x, z, h) => h > 8 ? 'rock' : 'grass' }));
//   Both run in workers, so they are pure (threads.pure rules: only parameters and globals like Math; an outside variable throws here, naming it).
//   Settings a function needs travel as params (plain data, read as n.params). The engine still does chunks, streaming, collision, flatten and edits on top.
// Height map: terrain({ heightmap: { url: '/textures/height.png', size: [1024, 1024], min: -5, max: 60 } }), a grayscale image, whiter is higher, read at startup.
// Colors: terrain({ colors, biomeColors, steep, variation }), plain data the workers bake into each chunk; a type without a color is neutral gray.
//   engine.terrain.recolor({ ... }) changes them at run time (recipes/36-ground-plants.md).
// Shading: 'smooth' | 'flat' | 'texture' (per-chunk color map, colors independent of the mesh; see recipes/53-ground-up-close.md).
// Material: terrain({ material }), a Material or (engine) => Material; chunks carry position, normal, color and uv (world xz / chunk size, continuous
//   across chunks). Cloud shadows, season tint and terrain({ detail }) are added to it; terrain({ material, effects: false }) draws it exactly as given.
//   engine.terrain.material = m at any time draws m as given too; engine.terrain.patches keeps the effects on it (applyEffects(m, { patches })).
// Edits: engine.terrain.edit(pos, { radius: 2, lower: 1 }) digs; { paint: 'tilled' } paints a ground type (its color: terrain({ biomeColors })). Saved, see terrainEdit.js.

// Outline: terrain({ shape: { mask: (x, z, n) => 40 - Math.hypot(x, z), side: { depth: 2 } } }) keeps ground only where mask > 0 (an island
//   with cliff sides); off it engine.surface is -Infinity, engine.ground.has false, and a fall emits terrain:void. See recipes/28-terrain.md.

import { ChunkManager } from './ChunkManager.js';
import { DEFAULT_TERRAIN } from './terrainGen.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { compilePure } from '../../core/threads/threadPure.js';
import { warnOnce } from '../../core/base/validate.js';
import { loadGray } from '../../core/scene/grayMap.js';
import { prepareShape, voidWatcher } from './terrainShapeMain.js';
import { TerrainDraw, checkGround } from './draw.js';
import { codedError } from '../../core/base/errorHints.js';
import { onTierChange } from '../../core/scene/tier.js';

const NO_HEIGHT = 'terrain(): no height function or height map was given, so the ground is flat gray at y = 0 (a placeholder, not a picture). '
  + 'Pass terrain({ height, groundType }) or a preset, e.g. terrain({ ...terrainPreset() }) with terrainPreset from @threedog/terrain-noise';

export { createTerrain, DEFAULT_TERRAIN } from './terrainGen.js';

const VIEW = { viewChunks: 4, density: 1 };
/** The rows this ground offers the settings menu; a preset's share is of the value the game gave it. Writing density places plants again, so an unchanged value stays unwritten */
const offerGroundRows = (e, T) => e.settings?.define('viewChunks', T.viewChunks, v => { if (T.viewChunks !== v) T.viewChunks = v; }).define('density', T.density, v => { if (T.density !== v) T.density = v; });
const TERRAIN_PARAMS = keysSchema(['viewChunks', 'density', 'material', 'effects', 'detail', 'variation', 'viewFog', 'part', ...Object.keys(DEFAULT_TERRAIN)], { ...DEFAULT_TERRAIN, ...VIEW, viewFog: false });   // defaults shown in the catalog; createTerrain applies the real ones

export function terrain(opts = {}) {
  readParams('terrain', TERRAIN_PARAMS, opts);
  checkGround('terrain', opts);
  // material and detail stay on the main thread (a texture, a function): everything left in cfg is plain data for the workers
  const { viewChunks = VIEW.viewChunks, density = VIEW.density, material, effects, detail = null, viewFog = false, part = false, ...cfg } = opts;
  // effects only says how the game's own material is used: without one it would silently do nothing
  if (effects !== undefined && (material == null || typeof effects !== 'boolean'))
    throw codedError('terrain-option', 'terrain({ effects }): goes with your own material, terrain({ material: myMaterial, effects: false }) = drawn as given (no cloud shadow / season / detail patch); got ' + JSON.stringify({ effects, material: material == null ? material : typeof material }));
  let w = null, watchVoid = null, sideMat = null;
  // the config the chunks are generated from now (a loaded height map, recolor): shared by both halves
  const state = { cfg: null };
  // Two modules from one call: 'terrain' (data: heights, chunks, edits, collision, queries) and 'terrainDraw' (meshes, materials, recolor).
  // Why two: collision, paths and vegetation read only the data, so engine.use(myGround, { replaces: 'terrain-draw' }) swaps every pixel of the
  // ground and keeps all of play. The draw part reads chunk data and never changes it.
  const data = {
    name: 'terrain', skipKind: 'none', type: 'world', provides: part ? ['terrain'] : ['terrain', 'ground'], label: 'Terrain', params: TERRAIN_PARAMS, options: opts, noSkip: 'void-fall watch only; nothing accumulates over time', optional: ['vegetation', 'settings'], stage: 'ground',
    install(e, ctx) {
      e.i18n.add({ 'zh-CN': { 'module.terrain': '地形' }, en: { 'module.terrain': 'terrain' } });
      for (const k in cfg) if (cfg[k] === undefined) delete cfg[k];
      // the shape of the ground only: the picture keys (colors, shading...) are added by the drawing half (drawConfig), so a replaced draw part leaves them out
      const terrainCfg = Object.fromEntries(Object.entries(cfg).filter(([k]) => !DRAW_KEYS.includes(k)));
      // a game's generator functions go to the workers as source text: checked here (outside variables name themselves) so the error points at this call
      for (const k of ['height', 'groundType']) if (typeof terrainCfg[k] === 'function') terrainCfg[k] = compilePure(terrainCfg[k], `terrain({ ${k} })`).src;
      if (!terrainCfg.height && !terrainCfg.heightmap) warnOnce(NO_HEIGHT);
      sideMat = terrainCfg.shape ? prepareShape(terrainCfg) : null;
      w = new ChunkManager(e, terrainCfg, ctx);
      if (terrainCfg.shape) watchVoid = voidWatcher(e, w);
      w._density = density;   // before anything is placed: nothing to place again yet
      w.viewFog = viewFog;   // opt-in: the view distance goes out as the signal uViewDistance (a game's fog reads it to hide the edge)
      state.cfg = terrainCfg;
      const ground = {
        height: (x, z) => w.generator.surface(x, z),
        slope: (x, z) => w.generator.slope(x, z),
        type: (x, z) => w.generator.biomeAt(x, z, w.generator.surface(x, z), w.generator.slope(x, z)),   // 'void' outside terrain({ shape })
        waterLevel: w.generator.waterLevel,
        // public collision API: the collision and physics modules read terrain only through these, never chunk internals
        forEachCollider: (x, z, range, fn) => w.forEachCollider(x, z, range, fn),
        chunkSize: w.generator.CHUNK,
        viewRange: () => w.viewChunks * w.generator.CHUNK,   // stream entries build within the terrain view by default
        chunkCollision: (cx, cz) => w.chunkCollision(cx, cz),
        has: (x, z) => w.generator.has(x, z),
        voidY: () => w.voidY,   // the physics module reports its own bodies falling below it (terrain:void)
      };
      if (part) w.ground = ground; else ctx.ground.provide(ground);   // part: compositeGround holds the slot and reads terrain.ground
      w.viewChunks = viewChunks;
      // a source is ready when the ring around it is generated, and for a physics source its collision has taken effect (chunkCollision non-null)
      ctx.stream.addReadyCheck('terrain', s => w.readyAt(s, { rings: 1 }) && (!s.physics || w.readyAt(s, { rings: 1, solid: true })));
      ctx.budget.metric('chunkApplyMs', () => w.stats.applyMs);   // chunk upload ms per frame (the limit comes from the game's budget)
      return w;
    },
    frame(dt, e) {
      w.update(e.stream.sources(), e.camera);   // chunks load around every engine.stream source
      // shortcut: the value stays after the terrain unloads; upgrade if a game swaps terrains with different ranges
      const far = w.viewFogFar; if (far != null) e.uniforms.uViewDistance.value = far;
    },
    fixed() { watchVoid?.(); },   // terrain({ shape }) only: falls below voidY are gameplay, so they are seen on the fixed step
    describe(e, ctx) { ctx.out.perf.chunks = { loaded: w.stats.loaded ?? 0, visible: w.stats.visible ?? 0, queued: w.stats.queued, failed: w.stats.failed }; },
    // height map / mask image wait for the image: after it loads, rebuild terrain with the new config (both the main-thread copy and the workers)
    critical: true,   // a missing height map would start the game on flat ground: stop start() with the reason instead
    async init(e) {
      offerGroundRows(e, w);
      const hm = state.cfg.heightmap, mk = state.cfg.shape?.mask;
      const needH = hm?.url && !hm.data, needM = mk?.url && !mk.data;
      if (!needH && !needM) return;
      // the live object, edited in place and never swapped for a copy: the tier listener (terrainDraw install) edits colorResolution on the same object while the images
      // load, and a copy taken before the await would reinit the workers at the old resolution
      const live = state.cfg;
      if (needH) live.heightmap = { ...hm, ...await loadGray(hm.url), url: undefined };
      if (needM) live.shape = { ...live.shape, mask: { ...mk, ...await loadGray(mk.url), url: undefined } };
      w.reinit(live, speciesRules(w));
    },
    isReady(e) { return e.stream.sources().every(s => w.readyAt(s)); },
    dispose() { w.dispose(); },
  };
  let drawPart = null;
  const lookModule = {
    // the same terrain({...}) call: material / effects are read here, the rest by the data part
    name: 'terrainDraw', skipKind: 'none', type: 'picture', label: 'Terrain drawing', params: TERRAIN_PARAMS, options: opts, requires: ['terrain'], provides: ['terrain-draw'], stage: 'effects',
    install(e, ctx) {
      e.i18n.add({ 'zh-CN': { 'module.terrainDraw': '地形外观' }, en: { 'module.terrainDraw': 'terrain drawing' } });
      // the colors the workers bake into each chunk: no chunk is generated before the first frame, so this reinit only swaps the config
      state.cfg = { ...state.cfg, ...drawConfig(e, cfg) };
      w.reinit(state.cfg, speciesRules(w));
      // the low-tier color map follows the tier (a stored preset arrives after this install). A resolution the game gave in terrain({}) stays; recolor cannot set one
      // (it is not in recolor's keys), so the only other writer is this listener. Followed by reinit, the path recolor takes too: every chunk is generated again, which is
      // fine at a settings change (and before the first frame it is free). Only colorResolution is changed, on the live object: init above may still be loading images into it
      ctx.track(onTierChange(e, () => {
        const c = state.cfg;
        if (cfg.colorResolution != null) return;
        const want = drawConfig(e, { ...c, colorResolution: undefined }).colorResolution;
        if (want === c.colorResolution) return;
        if (want == null) delete c.colorResolution; else c.colorResolution = want;   // a key holding undefined would hide createTerrain's default
        w.reinit(c, speciesRules(w));
      }));
      // effects false (terrain({ material, effects: false })): the game's material is drawn untouched
      drawPart = w.drawPart = new TerrainDraw(e, w, { material, effects: material == null || effects !== false, detail, sideMat,
        config: { get: () => state.cfg, set: c => { state.cfg = c; }, species: () => speciesRules(w) } });
      return drawPart;
    },
    describe() { return { chunks: drawPart?.meshes.size ?? 0 }; },
    dispose() { drawPart?.dispose(); drawPart = w.drawPart = null; },
  };
  return [data, lookModule];
}

/** Picture keys of terrain({...}): baked into the chunk colors by the workers, but only the drawing half reads them */
const DRAW_KEYS = ['colors', 'biomeColors', 'steep', 'variation', 'shading', 'colorResolution', 'normals', 'normalFn'];

/** The drawing half's part of the worker config: the picture keys terrain({...}) was given */
function drawConfig(e, cfg) {
  const out = Object.fromEntries(Object.entries(cfg).filter(([k]) => DRAW_KEYS.includes(k)));
  if (typeof out.normalFn === 'function') out.normalFn = compilePure(out.normalFn, 'terrain({ normalFn })').src;
  // low-tier devices start with a coarser color map (a quarter of the pixels and upload); the game's own colorResolution wins
  if (out.shading === 'texture' && out.colorResolution == null && e.tier === 'low') out.colorResolution = 64;
  return out;
}

/** Every species' placement rule (the workers get the full table when the terrain config is replaced) */
function speciesRules(w) { const out = {}; for (const sp of w.plants.list()) out[sp.name] = sp.rule; return out; }

export const handRolled = 'none: a ground of its own is plain three.js, used on purpose';
