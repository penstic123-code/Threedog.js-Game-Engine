// Level module: load a hand-built scene (glTF/GLB from Blender, or THREE objects assembled in code) and make it playable:
//   - ground: walkable meshes become ground height (provides engine.surface/slope/groundType; holds the exclusive 'ground' slot, as terrain does: installing both is refused at use())
//   - collision: meshes named col_* (or userData.collider) become walls the character cannot cross; col_ meshes themselves are hidden
//   - markers: objects named spawn, spawn_*, npc_*, trigger_*, marker_* (usually Blender empties) have their positions recorded
//
// engine.use(collision(), rigid(), followCamera(), characters(), level({ url: '/models/town.glb' }), triggers());
// engine.events.on('level:loaded', ({ markers }) => {
//   const s = engine.level.spawn;                                   // spawn point { x, y, z }
//   engine.characters.addPlayer({ spawn: { x: s.x, z: s.z } });
//   engine.triggers.fromMarkers({ onEnter: t => console.log('entered', t.tag) });
// });
// engine.start();
//
// Files are optional: level({ scene: a THREE.Group }) is usable immediately on install (spawn point and ground are queryable at once).
//
// Naming conventions in Blender:
//   walkable    name contains ground / floor / road / terrain / stair(s) / ramp, or custom property walkable = true
//              (if none match, all meshes are walkable). Ground type = custom property groundType, else the material name
//   walls/obstacles  col_xxx (hidden collision box, only blocks movement), or custom property collider = true (a visible object that blocks)
//   markers     spawn, spawn_2, npc_shopkeeper, trigger_door, marker_chest -- custom properties go into userData as-is
//   records     custom property template = 'door' (an instance of a content template; its other custom properties fill the template's state) or id = true
//              (the node itself becomes a world record, kind 'levelNode', its custom properties are record fields): id `<level file name>/<node name>`,
//              e.g. town/door_front; saved as a diff like content entries (opened, removed, moved). Untagged meshes stay static scenery
//
// Options:
//   url / scene   pick one: glTF path (or name in the assets manifest) / THREE.Object3D built in code
//   walkable      mesh => true/false, decide which meshes are walkable (default: the naming conventions above)
//   colliders     'named' (default, only col_ and userData.collider) | 'auto' (also treat every non-walkable mesh taller than 0.5 m as a wall) | false
//   cellSize      heightfield cell size in meters, default 0.5. Smaller is more precise but uses more memory
//   sharpEdge     neighboring-point height difference (m) above which it is a step edge, no smoothing, default 0.6
//   outside       ground height outside the level, default 0
//   waterLevel    water surface height, default -Infinity (no water)
//   colliderPad   extra outward padding of collision boxes, default 0
//   colliderHeight minimum collision box height (a too-low col_ box still blocks this high), default 0
//   hideMarkers   hide a marker if it is a mesh (e.g. a placeholder cube), default true
//   addToScene    add the scene to engine.scene, default true
//
// After install, engine.level:
//   root / object scene root node (THREE.Object3D)
//   markers       { name: { name, position, quaternion, scale, userData, object } } (world space; position is a Vector3, object is the original)
//   spawn         spawn position (spawn, else the first spawn_*, else the origin)
//   marker(name) / markersWith(prefix)   get one / get a group (e.g. markersWith('npc_'))
//   ready         the level's state is committed and nothing is loading (boolean). After unload() it is true with no level, since nothing is loading: root says whether a level stands
//   playable      every module and required nearby build settled after the commit too (boolean)
//   heightfield   heightfield data (for debugging)
//   staticTrimeshes()  walkable-mesh triangles (world space), for building Rapier static colliders
//   load(path/asset name or THREE object)   switch level: the new one is built first and replaces the old one only on success; a failure keeps the old level
//                 and rejects. Returns a Promise
//   unload()      unload (also removes everything registered via track)
// track(handle) register things that belong to the current level and need no keeping (handles with remove(): trigger zones...); auto-removed on level switch /
// unload.
// World data that must keep state (NPCs, pickups, props) is not tracked: records carry zone (= level name), a level switch only tears down models.
//                 triggers.fromMarkers and content (when positions use level markers) are tracked automatically
// Rays: all meshes are registered in engine.rays (builds BVH); col_ meshes and non-walkable meshes (buildings, walls) also occlude the camera (collision's
// cameraOcclusion).
// Save: the current level (path or asset name) goes into the save; on load, switch back first and wait for it before loading the rest (save key level comes
// first, load returns a Promise);
// a scene built in code has no file a stored save could name: it saves a token only this page can read back ({ scene: n }), so a rollback and a new game return to it; a token from another page
// stays on the level that stands. To load across pages, register the builder in the assets manifest and use level({ url: name }).
// Events: level:loading { source }, then level:failed { source, error } or level:loaded { root, markers, spawn } (state committed), then level:playable { root }.
// level:unloaded { source } says a level left: on unload(), and on a switch just before the new one commits. What was built from the level goes on it
// Picture: the level module draws nothing itself, the scene looks entirely like your model, so it does not read the style.
import { reportError } from '../../core/base/errors.js';
import * as THREE from 'three';
import { readParams, keysSchema } from '../../core/base/params.js';
import { levelNodes } from './nodes.js';
import { worldTrimeshes } from './geometry.js';
import { follows } from '../../core/base/follows.js';
import { loadLevel, dropLoad, dropAsks, finishLoad, readScene, adoptScene, addColliders, levelSection } from './load.js';
import { warnOnce } from '../../core/base/validate.js';
import { coded } from '../../core/base/errorHints.js';
import { checkSaveFile } from '../../core/base/saveValues.js';
import { whenTurnFree } from '../../core/saves/stateReplace.js';

const STRINGS = {
  'zh-CN': { 'module.level': '关卡', 'level.loadFailed': '关卡加载失败：{url}', 'level.noScene': '关卡模块需要 url 或 scene 参数' },
  en: { 'module.level': 'level', 'level.loadFailed': 'Failed to load level: {url}', 'level.noScene': 'The level module needs a url or scene option' },
};

const LEVEL_PARAMS = keysSchema(['url', 'scene', 'walkable', 'colliders', 'cellSize', 'outside', 'waterLevel', 'colliderPad', 'colliderHeight', 'sharpEdge', 'hideMarkers', 'addToScene', 'part']);

/** The object behind engine.level; st is the module's state (level() below). load and unload go through api, so a wrapped one (engine.wrap) is the one that runs */
function levelApi(st) {
  const api = {
    root: null, markers: {}, spawn: new THREE.Vector3(), heightfield: null,
    get ready() { return st.done; },
    get playable() { return st.done && st.playable; },
    /** Register things belonging to the current level ({ remove() } handles); auto-removed on level switch / unload; returns the same handle */
    track(h) { if (h) st.removers.push(h); return h; },
    marker: name => api.markers[name] || null,
    markersWith: prefix => Object.values(api.markers).filter(m => m.name.startsWith(prefix)),
    /** @internal Triangles of walkable meshes (world space), [{ positions: Float32Array, indices: Uint32Array }], cached */
    staticTrimeshes() {
      if (st.trimeshCache) return st.trimeshCache;
      st.trimeshCache = worldTrimeshes(st.walkMeshes);
      return st.trimeshCache;
    },
    /** Unload the level: remove from scene, delete colliders, ground reverts to the outside height */
    unload() {
      const source = api.root ? st.current : undefined;   // undefined: no level stood here, nobody needs telling
      // each handle in its own try: one that throws (a trigger's onExit) must not leave the rest, nor the level root, standing; the unload finishes, the error is reported (engine.error in dev, console in release), and the unload goes on
      for (const h of [...st.removers.splice(0), ...st.walls.splice(0)]) { try { h.remove(); } catch (err) { reportError(st.e, err, 'level unload'); } }
      if (api.root && st.o.addToScene) st.e.remove(api.root);   // full removal (geometries and materials shared by assets are not disposed)
      st.walkMeshes.length = 0; st.hf = api.heightfield = null; st.colliders = null; st.wallsIn.reset(); st.trimeshCache = null; api.markers = {}; api.root = null; st.current = null; st.version++; dropAsks(st);
      st.done = true; st.playable = false;   // nothing is loading now: a file still on its way is dropped, and no finishLoad would ever come for it (load sets it back)
      if (source !== undefined) {
        st.unloaded = true;   // a level stood and left: only then is "no level" a fact worth saving (a session that never had one saves nothing, so its new-game state keeps a level loaded later)
        // a level that left takes its zone and spawn with it: the next scene's nodes must not be placed in a zone that is gone
        api.spawn = new THREE.Vector3();
        if (st.e.world) st.e.world.zone = null;
        st.e.events.emit('level:unloaded', { source });
      }
    },
    /** Switch level (glTF path/asset name, or THREE object): the new one is built first, a failure keeps the old one and rejects (load.js). During a save load it waits for the load to end, so the level a load answered true for is the one that stands */
    async load(urlOrScene, { turn } = {}) { return whenTurnFree(st.e, () => loadLevel(st, urlOrScene, false), turn); },
  };
  return api;
}

const NONE = { none: true };   // saved when no level stands: null means "nothing to save" to the save system, and a load without the part keeps the level that stands
const OPENING = '(opening scene)';   // no file or asset can be named this

/** What the save holds for a level built in code. Weak: a token in a stored save must not keep every level this page ever built in memory */
function sceneToken(st, root) {
  const ids = st.sceneIds, id = ids.get(root) ?? ids.set(root, st.scenes.push(new WeakRef(root)) - 1).get(root);
  return { scene: id };
}

export function level(opts = {}) {
  readParams('level', LEVEL_PARAMS, opts);
  const { url = null, scene = null, walkable = null, colliders = 'named', cellSize = 0.5, outside = 0, waterLevel = -Infinity,
    colliderPad = 0, colliderHeight = 0, sharpEdge = 0.6, hideMarkers = true, addToScene = true, part = false } = opts;
  const st = {
    e: null, hf: null, playable: false,
    _done: false, idle: [],   // done: nothing is loading. idle: who waits for that (init); a setter, because a load ends in many ways: committed, failed, cancelled, overtaken, unloaded
    get done() { return this._done; },
    set done(v) { this._done = v; if (v) for (const go of this.idle.splice(0)) go(); },
    version: 0, trimeshCache: null,
    colliders: null, walls: [], wallsIn: follows(() => st.e.collision),   // the level's collision meshes, the handles of their boxes, the module those boxes are in (load.js addColliders)
    o: { walkable, colliders, cellSize, outside, colliderPad, colliderHeight, sharpEdge, hideMarkers, addToScene },
    asks: [],   // the loads under way, newest last: only the newest may commit, so a file that arrives after a newer load, a save or an unload is dropped
    current: typeof url === 'string' && !scene ? url : null,   // current level path/asset name (for saving)
    walkMeshes: [], removers: [],
    scenes: [], sceneIds: new WeakMap(),   // levels built in code, by token (sceneToken)
    nodeSet: null,   // level nodes that become world records (nodes.js), created at install
    taken: [],       // record nodes of the adopted scene, placed by finishLoad
  };
  const api = st.api = levelApi(st);
  st.section = levelSection(st);

  return {
    name: 'level', skipKind: 'none', type: 'world', provides: part ? ['level'] : ['level', 'ground'], params: LEVEL_PARAMS, options: opts, label: 'Level', stage: 'ground', optional: ['world', 'content', 'collision'],
    content: { level: st.section },
    install(engine, ctx) {
      ctx.feeds('collision', () => addColliders(st));
      const e = st.e = engine;
      st.nodeSet = levelNodes(e, ctx, () => api.root, () => st.current);
      e.i18n.add(STRINGS);
      // ground API: before the heightfield is built, return the outside height
      const ground = {
        height: (x, z, refY) => st.hf ? st.hf.height(x, z, refY) : outside,
        slope: (x, z, refY) => st.hf ? st.hf.slope(x, z, refY) : 0,
        type: (x, z, refY) => st.hf ? st.hf.type(x, z, refY) : 'default',
        waterLevel,
        staticTrimeshes: () => api.staticTrimeshes(),
        staticVersion: () => st.version,          // +1 on level change; the physics module rebuilds static colliders on it
      };
      if (part) api.ground = ground; else ctx.ground.provide(ground);   // part: compositeGround holds the slot and reads level.ground
      // the level is the module's: scene, walls, rays and level.track handles leave with it (unuse, replaces, a failed init). Before the part: handles go newest first, so the
      // part still reads the level as it leaves
      ctx.track({ remove: () => api.unload() });
      // on load, switch back to the saved level (code-built scenes have no name, record null, no switch)
      // load returns a Promise: the save system waits for the new level (old level's trigger zones are already removed by unload) before reading player
      // position etc.
      // a save that names this level, or none, stays here: a load on its way would land on top of what the save put back
      // The level a holder stood on comes back through the same part when a module takes over the key (Saves.define): a swap keeps the game where it was, and a pack's older
      // level must not take it back (the section's once). A newcomer that says where to open keeps that promise; the same definition put back after a failed swap has none to make
      // the opening scene has no name either, so it saves as OPENING: a new game goes back to it, and a save from before this mark takes it from the new-game state
      const opens = !st.installed && (scene || url);
      let installing = st.installed = true;
      st.kept = false;
      ctx.saves.define('level', { notAtomic: 'its load fetches and builds a level: not plain data, and not something a failed op can wait for', first: true, save: () => st.current ?? (!api.root ? (st.unloaded ? NONE : null) : api.root === scene ? OPENING : sceneToken(st, api.root)), load: (d, turn) => {
        if (installing) { if (opens || typeof d !== 'string' || d === OPENING) return; st.kept = true; }
        else if (d?.none) return api.root ? api.unload() : dropLoad(st);   // saved with no level standing: that is what the save says, so the level now standing goes
        else if (d === OPENING) return api.root === scene ? dropLoad(st) : api.load(scene, { turn });
        else if (d?.scene != null) { const root = st.scenes[d.scene]?.deref(); return !root || root === api.root ? dropLoad(st) : api.load(root, { turn }); }
        else if (typeof d !== 'string' || d === st.current) return dropLoad(st);
        checkSaveFile(e.assets, 'level', 'the level file', d);
        return api.load(d, { turn });
      } });
      installing = false;
      if (scene) adoptScene(st, readScene(st, scene));
      return api;
    },
    critical: true,   // the level file is the game's world: a failed load stops start() with the reason
    async init(engine) {
      // the options say where to open; what the game asked for before init (a pack's level, level.load) comes first and stays, and the url file is not fetched. Asking here
      // would be the newer load and overtake it. If that load ends with no level (refused, failed), the options are the level after all
      if (st.asks.length) await new Promise(res => st.idle.push(res));
      if (api.root && api.root !== scene) return;
      if (scene) return finishLoad(st);
      if (url) return loadLevel(st, url, true);
      warnOnce(coded('level-node', engine.t('level.noScene')));
      finishLoad(st);
    },
    isReady() { return st.done; },
    // which level is up and what it gave: a wrong path shows as file set but markers 0 / walk 0, a code-built scene as file null
    describe() {
      const s = api.spawn, r = v => Math.round(v * 10) / 10;
      return { file: st.current, ready: st.done, playable: api.playable, markers: Object.keys(api.markers).length, walkMeshes: st.walkMeshes.length, removers: st.removers.length + st.walls.length,
        spawn: { x: r(s.x), y: r(s.y), z: r(s.z) } };
    },
  };
}

export const handRolled = 'none: loading a map by hand is one model load that looks like any other';
