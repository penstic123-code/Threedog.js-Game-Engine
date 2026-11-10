// Asset management:
//   1. Asset manifest: register every model, texture and sound under a name; code uses names only, so swapping a file means editing the manifest.
//   2. Preload: load everything marked preload once at startup; the loading screen shows progress.
//   3. Cache and reuse: one name loads once (two names for one file load it twice; register the file once); models return independent copies (geometry and materials shared), so you can place many.
// 4. Release: one count of leases, and a model copy is one (assetEntry.js takeLease); release(name) frees only when the last lease ends, trim() frees every model with no copy in use (see their docs
// below).
//   5. Compression: Draco / Meshopt models and .ktx2 textures load as-is; the decoder downloads on first use (npm run assets -- optimize produces compressed files in public/optimized/).
//   6. Made in code: a model / texture / sound may be a function in the manifest instead of a file, used by name exactly like a file (content, model(),
//      pickups, vegetation, audio.sounds). Models are built on demand and cached automatically (baked file -> dev cache -> build, the internal cached()).
//   7. Observable: every load is a task in engine.loading. A registered file that fails falls back (gray placeholder / silence / the entry's fallback)
//      unless it is critical: true, which stops start() instead (assetEntry.js).
// 8. Asset packs: a manifest is a plain object, so a folder or an npm package can ship one and a game registers it with one call (recipes/05-props-bake.md
// "Asset packs").
//
// Put files under public/: public/models/house.glb -> write the path as '/models/house.glb'
//
// engine.assets.manifest({
//   name: 'main',                                        // shown as the source manifest in engine.loading
//   models:   { house: '/models/house.glb', hero: { url: '/models/hero.glb', critical: true }, block: buildBlock },
//   textures: { paper: { url: '/textures/paper.jpg', color: true }, ground: '/textures/ground.ktx2' },
//   sounds:   { bgm: '/sounds/morning.mp3', ding: (audio, p, out) => { audio.tone({ freq: 880 * p.pitch, dur: 0.2, out }); return 0.2; } },
//   fonts:    { pixel: '/fonts/pixel.woff2', pixelBold: { url: '/fonts/pixel-bold.woff2', family: 'pixel', weight: 700 } },   // ui.fonts names them
// });
// engine.assets.manifest({ name: 'forest', base: '/packs/forest/', models: { oak: 'oak.glb' } });   // -> /packs/forest/oak.glb
// await engine.assets.preload(p => console.log(p));     // p: 0-1 (code-generated models are built ahead only if marked preload)
// const house = await engine.assets.model('house');      // get by name
import { reportGltf } from './assetReport.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { nodeVisibility } from './nodeVisibility.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { warnMissing, warnOnce, fmt, DEV } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';
import { Animator } from './Animator.js';
import { waitLoad, freeEntry, retireEntry, takeLease, explainAsset, disposeEntries, preloadEntries, shadowDefaults, longSound } from './assetEntry.js';
import { disposeProtos } from './namedModel.js';
import { registerManifest, paramValues } from './assetManifest.js';
import { setParams } from './assetHot.js';
import { wrapLod } from './assetLod.js';
import { schemaInfo } from '../base/params.js';
import { loadGrid } from '../scene/gridLoad.js';
import { memory } from '../../render/backend.js';
import { freeParts, copyOwns, cloneModel } from '../base/freeParts.js';

const STRINGS = {
  textureFailed: "{where}: texture '{name}' did not load ({msg}); {instead}. Register it (engine.assets.manifest({ textures: { name: 'file.png' } })) or check its URL",
  notLoaded: 'assets.modelNow(\'{name}\') is null: nothing has loaded that model yet (a code-built model is built, or read from the bake cache, on its first load too). Use `engine.assets.modelNow(\'{name}\') ?? await engine.assets.model(\'{name}\')`, or mark it preload: true in the manifest and await engine.assets.preload()',
  noLease: 'assets.lease(\'{name}\'): nothing is registered or loaded under that name, so there is no data to hold. Fix: register it in an asset pack, or load it first with assets.model / assets.texture',
  noFont: 'assets.font(\'{name}\'): no font named {name}{known}. Register the file in an asset pack: engine.assets.manifest({ fonts: { {name}: \'/fonts/{name}.woff2\' } })',
  twoSetups: 'assets.onModel(): a setup is already registered. One setup runs on every model, so two would leave the result to their order. Call both from one function: engine.assets.onModel((model, name) => { first(model, name); second(model, name); })',
  asyncSetup: 'assets.onModel(): the setup returned a promise, but it must be synchronous: the model is added and drawn right after it returns. Load what it needs first (await the textures, then register the setup)',
  movedRoot: "assets.onModel(): the setup changed the position, turn or size of the model '{name}' itself. Its placer owns those (content writes rot / scale from the record, your code places what it loads), so the change would be overwritten. Change a child instead: model.children.forEach(c => c.rotation.y += Math.PI)",
  lateSetup: 'assets.onModel(): {n} model copies were handed out before onModel was registered and did not run the setup. Register it right after createEngine, before start(), content and the first model()',
  sameName: 'model \'{name}\': the same name was used with two different generator functions, so the cache would mix them (keyed by name + params). Use a different name per model; if the result depends on outer variables, put them in params',
};
/** Short hash of the source (cache key; tells apart same-name, different-function cases) */
const srcHash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export class Assets {
  constructor(engine) {
    this.engine = engine;
    this.entries = new Map();   // name -> { type, url, opts, promise, value, load, users } (who owns the data: top of assetEntry.js)
    this.gltf = new GLTFLoader();
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
    this.gltf.register(nodeVisibility);   // a node hidden in the file stays hidden (three does not read KHR_node_visibility)
    this.draco = null;          // DRACOLoader / KTX2Loader：created on the first compressed data
    this.ktx2 = null;
    this.tex = new THREE.TextureLoader();
    this.shared = new WeakSet(); // what asset loads own: model geometry, materials and their textures, loaded textures (engine.remove / engine.dispose never dispose them; assetEntry.js share)
    this._instances = new WeakMap();   // model copy root -> { e: the entry it was asked for by, load: the load that owns its data }
    this._retired = new Set();   // old loads no entry points at, kept for the copies or geometry still using them
    this._disposed = false;
    this._animators = new WeakMap();   // model root -> Animator from animate(): engine.remove disposes it with the model
    this.cacheMinMs = 20;       // builds faster than this are not cached (reading the file would be slower)
    /**
     * Named colors for what is made in code: a generator written with `function` reads this.palette. Plain data, read or replace it freely:
     * it is part of the cache key, so a model or texture asked for after a write is built from the new colors. Copies already placed keep theirs,
     * and a generated model's old build stays cached until engine.dispose.
     * @example engine.assets.palette = { leaf: 0xd98a3a, bark: 0x6b4a30 };
     * @type {Record<string, any>}
     */
    this.palette = {};
    this._loaders = {};
  }

  /**
   * Register an asset manifest or asset pack (may be called repeatedly; a later entry with the same name replaces the earlier one). A model may be a generator
   * function or { build, params, preload, cache } (cache: false = never stored in the dev cache, recipes/05-props-bake.md §2a). params is a schema in the
   * core/base/params.js format ({ height: { type: 'number', min: 1, max: 6, default: 3 }, color: { type: 'color', default: 0x557733 } }): the generator is
   * then called with one object (defaults, then dev panel values, then a call's own `['tree', { height: 4 }]`), and the dev panel shows the fields.
   * Per entry: critical: true = start() stops if it fails (otherwise it falls back and the game continues); fallback: 'otherName' replaces the gray
   * placeholder.
   * name labels the manifest in engine.loading (default 'manifest#1', '#2'...), so a failure says which list it came from.
   * base (a pack's folder: '/packs/forest/', a CDN URL, or new URL('../files', import.meta.url)) resolves the relative paths of this manifest; full URLs stay
   * as written, and '/x' is the game's public/ folder under the build's base (BASE_URL in core/base/validate.js: '/' unless built with --base).
   * @example engine.assets.manifest({ name: 'level-1', models: { hero: { url: '/models/hero.glb', critical: true }, bush: { url: '/models/bush.glb', fallback:
   * 'rock' } } });
   * @example import forest from 'my-forest-assets'; engine.assets.manifest(forest);   // { name: 'forest', base, models: { oak: 'oak.glb' } }
   * @example import packs from '../assets.js'; engine.assets.manifest(packs);   // a list: the game's assets.js, which `npm run check` reads too
   * @example engine.assets.manifest({ models: { wall: { url: '/models/kit.glb', node: 'Wall.001' } } });   // one node of a multi-part file: placed at the origin, the file loads once
   * @param {import('../../types/core').AssetManifest | import('../../types/core').AssetManifest[]} [pack]
  */
  manifest(pack = {}) { return registerManifest(this, pack); }

  /**
   * The game's setup for every model the engine hands out: fn(model, name) runs once on each copy, before it is added or drawn, whoever made it:
   * assets.model / modelNow / lod, content props and templates, pickups, character bodies and a level file. Use it for what the game does to
   * every model (its own materials, layers, userData). Synchronous; one per engine (a second throws); register it before the first model. The root's place, turn and size
   * stay its placer's (dev throws on a change): turn or size a child.
   * A copy shares geometry and materials with the other copies: map each original material to one of yours (a Map), or every copy draws apart and
   * engine.batching cannot merge them. Runs on a code-built model vegetation.define takes by name (before its meshes are copied into instances), not on a bare
   * geometry (a file model named in vegetation gives only its first mesh's geometry) or on what a game builds itself.
   * @example const mine = new Map(); engine.assets.onModel(model => model.traverse(o => { if (o.isMesh) o.material = mine.get(o.material) ?? mine.set(o.material, toon(o.material)).get(o.material); }));
   * @param {(model: THREE.Object3D, name: string) => void} fn
   * @returns {{ remove(): void }}
   */
  onModel(fn) {
    if (typeof fn !== 'function') throw codedError('asset-misuse', `assets.onModel(fn): fn must be a function (got ${typeof fn})`);
    if (this._setup) throw codedError('asset-misuse', STRINGS.twoSetups);
    if (this._handedOut) warnOnce(coded('asset-misuse', fmt(STRINGS.lateSetup, { n: this._handedOut })));
    this._setup = fn;
    return { remove: () => { if (this._setup === fn) this._setup = null; } };
  }
  /**
   * @internal The one door a model leaves by to the game or the scene: runs the onModel setup on it once. Every place that makes a copy for the game calls it
   * (the guard test 'model setup: every clone handed to the game goes through handOut'); prototypes and the bare _copy never do
   */
  handOut(root, name, { static: isStatic = false } = {}) {
    this._handedOut = (this._handedOut ?? 0) + 1;
    const fn = this._setup;
    if (fn && !this._prepared?.has(root)) {
      // one transaction: a setup that throws leaves nothing taken. The caller never gets the root, so it could not give back the copy's lease (or a LOD's levels') itself.
      // What it holds is listed before the setup runs: a setup that took a level out and then threw would leave that level's lease outside the root
      const held = []; root.traverse(o => { if (this._instances.has(o)) held.push(o); });
      try {
        const was = DEV && [...root.position.toArray(), ...root.quaternion.toArray(), ...root.scale.toArray()];
        const r = fn(root, name);
        if (typeof r?.then === 'function') throw codedError('asset-misuse', STRINGS.asyncSetup);
        // the root's transform is the placer's (one writer): a setup that turned it would be undone by content's settle
        if (was && [...root.position.toArray(), ...root.quaternion.toArray(), ...root.scale.toArray()].some((v, i) => v !== was[i])) throw codedError('asset-misuse', fmt(STRINGS.movedRoot, { name }));
      } catch (err) { for (const o of held) this._giveBack(o); this.forget(root); throw err; }   // both: and what the setup hung on it before it threw (each given back once)
      (this._prepared ||= new WeakSet()).add(root);   // only once it worked. Why a WeakSet and not userData: clone() copies userData, so a clone would look prepared
    }
    // after the setup: rays take the meshes it left (one it added is hit, one it removed is not). A LOD's low levels skip themselves (Rays.addStatic)
    if (isStatic) this.addStatic(root);
    return root;
  }
  /** @internal The one static-ray registration of a handed-out copy (handOut's static, content's settle): kept per root so a hot rebuild registers the new parts again (restatic). Returns { remove() } */
  addStatic(root, opts) {
    const s = { h: this.engine.rays.addStatic(root, opts), opts }, all = this._statics ||= new WeakMap();
    all.get(root)?.h.remove(); all.set(root, s);
    return { remove: () => { s.h.remove(); if (all.get(root) === s) all.delete(root); } };
  }
  /** @internal Register the root's parts again, with the options it was first registered with (nothing when it never was) */
  restatic(root) { const s = this._statics?.get(root); if (s) { s.h.remove(); s.h = this.engine.rays.addStatic(root, s.opts); } }
  /** @internal Did the game's setup run on this root (handOut, and it did not throw)? Content measures such a copy itself: the setup may have changed its size */
  prepared(root) { return !!this._prepared?.has(root); }

  /**
   * The generator function registered under a model name (manifest models: { pine: fn } or { build }), null for a file model or an unknown name.
   * Code rarely needs it: name the model instead (content { model: ['flower', 0xff0000] }, assets.model('flower'), item model, vegetation.define)
   * @example if (!engine.assets.builder('flower')) console.warn('flower is a file model');
   * @param {string} name
   * @returns {((...args: any[]) => any) | null}
   */
  builder(name) {
    const e = this.entries.get(name);
    return e?.named && e.type === 'model' && e.opts.build || null;
  }

  /**
   * The params of a generator that declares a schema: { schema (plain data), values (what it is built with now), tuned (set by setParams) }, or null
   * @example engine.assets.paramsOf('tree')?.values   // { height: 3, color: 5600051 }
   * @param {string} name
   * @returns {{ schema: Record<string, any>, values: Record<string, any>, tuned: Record<string, any> } | null}
   */
  paramsOf(name) {
    const e = this.entries.get(name);
    return e?.schema ? { schema: schemaInfo(e.schema), values: paramValues(e), tuned: { ...e.tuned } } : null;
  }
  /**
   * Dev tuning: build a generator again with these params (they replace its defaults; a call's own values still win) and swap every live copy in
   * place (props, templates, pickups, vegetation, model() copies). The dev panel's models folder calls it; `threedog tune write` writes them back.
   * @example await engine.assets.setParams('tree', { height: 4.5 });
   * @param {string} name @param {Record<string, any>} values
   * @returns {Promise<{ why: string, names: string[], copies: Record<string, number>, ms: number, partsChanged?: string[] }>}
   */
  setParams(name, values) { return setParams(this.engine, name, values); }
  /** @internal a module rebuilds its own copies after a hot swap (vegetation): fn({ names, geometry, material }) -> { name: copies } */
  onSwap(fn) { (this._swapHooks ||= new Set()).add(fn); return { remove: () => this._swapHooks.delete(fn) }; }

  _resolve(nameOrUrl, type) {
    let e = this.entries.get(nameOrUrl);
    // not path-like (no / or .) and not registered: most likely a misspelled name
    if (!e && !/[/.]/.test(nameOrUrl)) warnMissing('asset', nameOrUrl, [...this.entries].filter(([, x]) => x.type === type && x.named).map(([n]) => n));
    if (!e) { e = { type, name: nameOrUrl, url: nameOrUrl, opts: {}, promise: null }; this.entries.set(nameOrUrl, e); }
    return e;
  }
  /** @internal the palette as a cache key */
  get _paletteKey() { return JSON.stringify(this.palette); }
  /** @internal A generated model or texture built from a palette that has since been written */
  _stale(e) { return !!e.promise && !!e.opts.build && e.type !== 'sound' && e.palette !== this._paletteKey; }
  /** @internal Load an entry as a task in engine.loading (assetEntry.js) */
  _fetch(e) { return this._with(e, v => v); }
  /**
   * @internal Run use(value, load) on an entry's live data, in the same tick it is checked. Why the loop: code resumed by an await runs after other
   * continuations, and one of them may have released the entry since the load finished; handing out that value is a freed model
   */
  async _with(e, use, wait) {
    for (;;) {
      const v = await waitLoad(this, e, wait);
      if (wait?.whole && e.fellBack) throw e.fellBack;
      if (v === e.load?.value) return use(v, e.load);
    }
  }
  /** @internal A model copy for a caller that cannot stand on a stand-in and may stop waiting: a failed file rejects whatever the manifest falls back to, and an aborted signal leaves the load (assetEntry.js) */
  wholeModel(nameOrUrl, signal) {
    const e = this._resolve(nameOrUrl, 'model');
    return this._with(e, () => this._copy(e), { whole: true, signal }).then(root => this.handOut(root, e.name));
  }
  /** @internal The entry moves on from its current load (assetEntry.js) */
  _retire(e) { retireEntry(this, e); }

  /**
   * Preload manifest assets (all by default; onlyMarked=true loads only those marked preload). Code-generated models and fonts are loaded ahead only if marked
   * preload (ui.fonts loads its own at start()). onProgress(0-1, current name).
   * Finishing is not succeeding: failed lists every entry that failed, including those now showing their fallback (details in engine.loading).
  */
  async preload(onProgress, { onlyMarked = false } = {}) {
    return preloadEntries(this, onProgress, onlyMarked);
  }

  /**
   * A font from an asset pack, by name: downloads it once, adds it to document.fonts and resolves to the FontFace (null when the file
   * failed and the entry is not critical: text then shows the next family of ui.theme.font). Only registered names work, because a font
   * needs its CSS family and descriptors; ui.fonts calls this for you at start().
   * @example engine.assets.manifest({ name: 'ui', fonts: { pixel: '/fonts/pixel.woff2' } }); await engine.assets.font('pixel');
   * @param {string} name
   * @returns {Promise<FontFace | null>}
   */
  async font(name) {
    const e = this.entries.get(name);
    if (e?.type !== 'font') {
      const known = [...this.entries.values()].filter(x => x.type === 'font' && x.named).map(x => x.name);
      throw codedError('unknown-name', fmt(STRINGS.noFont, { name, known: known.length ? ` (fonts: ${known.join(', ')})` : '' }));
    }
    return this._fetch(e);
  }

  /** Get a model copy (name or path); skinned characters clone correctly. static: true registers it with engine.rays (builds ray acceleration) */
  async model(nameOrUrl, opts = {}) {
    return this.handOut(await this._bare(nameOrUrl, opts), this._resolve(nameOrUrl, 'model').name, opts);
  }
  /** @internal A copy that skips the onModel setup and static rays (handOut does both): a prototype that content and pickups clone (each clone is handed out), or a LOD level (the LOD is) */
  _bare(nameOrUrl, opts = {}, by) {
    const e = this._resolve(nameOrUrl, 'model');
    return this._with(e, () => this._copy(e, opts, by));
  }
  /**
   * A model copy as a plain THREE.LOD: the full model near, the levels of `threedog assets optimize --lod` far away (assetLod.js). Off unless called: model() never
   * downloads a level. Default distances follow the model's size. Rays, collision and saves keep using the full model; a LOD object is never batched.
   * @example const tower = await engine.assets.lod('tower', { distances: [40, 120] }); engine.add(tower); tower.levels[1].object;
   * @experimental
   */
  async lod(nameOrUrl, opts = {}) {
    const { distances, hysteresis, ...copy } = opts;
    return this.handOut(await wrapLod(this, nameOrUrl, await this._bare(nameOrUrl, copy), { distances, hysteresis }), this._resolve(nameOrUrl, 'model').name, copy);
  }
  /**
   * A model copy right now if that model has already loaded, else null (never starts a load, never waits). For code that rebuilds often,
   * such as a character coming back into view, so it skips the frame of placeholder an await would cost. Same options as model()
   * @example const m = engine.assets.modelNow('villager') ?? await engine.assets.model('villager');
   */
  modelNow(nameOrUrl, opts = {}) {
    const e = this.entries.get(nameOrUrl);
    if (e?.type === 'model' && e.load?.value && !this._stale(e)) return this.handOut(this._copy(e, opts), e.name, opts);
    // Why warn: generated models also need one load() first (dev reads the baked-cache GLB, release reads the baked file), so before any await model() this is null;
    // in one playtest world.present only called modelNow, the model never showed up and nothing said why. Already loading (promise present) = no warning: that is a normal "not ready yet"
    if (DEV && e?.type === 'model' && !e.promise) warnOnce(coded('asset-not-loaded', fmt(STRINGS.notLoaded, { name: nameOrUrl })));
    return null;
  }
  /**
   * @internal For modules that hand out what they load, as content does for its models. Hold an asset's data until the handle's remove(): release and trim wait for the last lease, and so does a build replaced by a hot swap or a palette write. For a texture, sound or
   * shared material a game keeps past its own scene. Model copies hold one each already, so nobody has to lease what they took from model(). A lease says "do not free this",
   * it frees nothing by itself: the data stays cached until release or trim. Counts are in describe().assets.
   * @example const lease = ctx.track(await engine.assets.lease('rock'));   // in a module: ends with it
   * @param {string} name a registered name, or a path already loaded
   * @returns {Promise<{ name: string, remove(): void }>}
   */
  async lease(name, by = 'assets.lease') {
    const e = this.entries.get(name);
    if (!e) throw codedError('unknown-name', fmt(STRINGS.noLease, { name }));
    return this._with(e, () => this._lease(e, name, undefined, by));
  }
  /** @internal the one place a lease is taken, and where describe().assets starts to report (only a game that holds something pays for the line) */
  _lease(e, name, load, by) {
    if (!this._reported) { this._reported = true; this.engine.describe?.add?.('assets', () => this._holders()); }
    return takeLease(this, e, name, load, by);
  }
  /** @internal describe().assets: leases per name (a model copy is one) and the names whose release waits for them; both empty again means every lease came back */
  _holders() {
    const held = [...this.entries].filter(([, e]) => e.users > 0);
    return { leases: Object.fromEntries(held.map(([k, e]) => [k, e.users])), waiting: held.filter(([, e]) => e.releasePending).map(([k]) => k) };
  }
  /** @internal engine.explain({ asset }) */
  _explain(name) { return explainAsset(this, name); }
  /** @internal one copy of a loaded model, counted on the load that owns its data, which for a name that fell back belongs to the other entry */
  _copy(e, { castShadow, receiveShadow } = {}, by = 'model copy') {
    const load = e.load, gltf = load.value, root = cloneModel(gltf.scene);
    this._instances.set(root, { e, load, lease: this._lease(e, undefined, undefined, by) });
    // the call, then the manifest entry; else a generator's own flags; else cast + receive (shadowDefaults, the same rule content props use)
    shadowDefaults(root, { castShadow: castShadow ?? e.opts.castShadow, receiveShadow: receiveShadow ?? e.opts.receiveShadow });
    root.animations = gltf.animations;   // three's own place: .clone() keeps it as clips, where userData goes through JSON and the clips would come back broken
    if (e.named) root.userData.modelName = e.name;   // which named model this is; .clone() carries it, the _instances map does not (content capture reads it)
    return root;
  }
  /**
   * Import report of a loaded model: materials, textures with their colorSpace, normal maps, clips, nodes, template / id nodes and col_ colliders,
   * with issues for what the file has but the scene lost (normal map, material replaced by an engine one, clip not loaded, clip mapping that names
   * no clip) and for wrong color spaces. Pass a name (the loaded template) or a copy from model() (what the game shows).
   * @example console.table(engine.assets.report('hero').issues);
   * @param {string | any} nameOrRoot
   */
  report(nameOrRoot) {
    const root = typeof nameOrRoot === 'string' ? null : nameOrRoot, copy = root && this._instances.get(root);
    const e = root ? copy?.e : this.entries.get(nameOrRoot), gltf = (root ? copy?.load : e?.load)?.value;
    if (!gltf?.scene) throw codedError('asset-misuse', `assets.report: ${root ? 'that object is not a model copy from assets.model()' : `model "${nameOrRoot}" is not loaded yet (await engine.assets.model(...) first)`}`);
    return reportGltf(gltf, e, root ?? gltf.scene, this.engine.renderer);
  }
  /** Get the geometry of the first mesh in a model (for vegetation and bulk placement) */
  async geometry(nameOrUrl) {
    return this._with(this._resolve(nameOrUrl, 'model'), (gltf, load) => {
      load.pinned = true;   // the geometry was handed out and we cannot know who still uses it: trim does not free it
      let g = null; gltf.scene.traverse(o => { if (!g && o.isMesh) g = o.geometry; });
      return g;
    });
  }
  /**
   * Get a texture (name or path; .ktx2 works too). Color textures default to sRGB; pass { color: false } for normal/roughness maps.
   * opts is part of the cache key: the same image fetched with different opts gives two separately configured textures (never silently reuses the first one's
   * settings). A texture made in code is registered by name too and comes back as made (its colorSpace / wrap / repeat are yours):
   * @example engine.assets.manifest({ textures: { brick: () => makeBrickTexture(), sign: mySignCanvasTexture } }); new THREE.MeshLambertMaterial({ map: await engine.assets.texture('brick') });
  */
  async texture(nameOrUrl, opts = {}) {
    const base = this._resolve(nameOrUrl, 'texture');
    if (base.opts.build || base.opts.texture) return this._fetch(base);   // made in code: one texture as made, no per-option variants
    const diff = Object.keys(opts).filter(k => k !== 'url' && JSON.stringify(opts[k]) !== JSON.stringify(base.opts[k]));
    if (!diff.length) return this._fetch(base);
    const key = nameOrUrl + '#' + JSON.stringify(Object.fromEntries(diff.sort().map(k => [k, opts[k]])));
    let v = this.entries.get(key);
    if (v?.url !== base.url) this.entries.set(key, v = { type: 'texture', url: base.url, opts: { ...base.opts, ...opts }, promise: null, variantOf: nameOrUrl, named: base.named, manifest: base.manifest });   // named: it falls back like its base
    return this._fetch(v);
  }

  /**
   * Fetch a texture for something that already shows a stand-in (a gray detail map, a round particle dot, a flat water normal) and hand it over when
   * it arrives: use(texture) runs on success. A failed load is one dev warning (load-failed) that names where the texture was wanted (`where`), the
   * name and what shows instead (`instead`), and resolves false: the caller keeps its stand-in. An error thrown by use() itself is not a load failure
   * and is not swallowed (the returned promise rejects with it). `opts` are texture()'s options ({ color: false } for data maps).
   * Why one helper: engine code had the same .then(use).catch(warn) in seven places, each with its own wording (some named the slot, some only the
   * loader's message), and a catch that also swallowed bugs inside use().
   * @param {string} nameOrUrl
   * @param {(texture: THREE.Texture) => void} use
   * @param {{ where?: string, instead?: string, opts?: Record<string, any> }} [o]
   * @returns {Promise<boolean>} true when use ran
   * @example engine.assets.useTexture('ripples', t => { mat.normalMap = t; }, { where: 'pond.normalMap', instead: 'the surface stays flat', opts: { color: false } });
   */
  useTexture(nameOrUrl, use, { where = 'assets.useTexture', instead = 'the stand-in stays', opts } = {}) {
    return this.texture(nameOrUrl, opts).then(t => { use(t); return true; },
      err => { warnOnce(coded('asset-load', fmt(STRINGS.textureFailed, { where, name: nameOrUrl, msg: err?.message ?? String(err), instead }))); return false; });
  }

  /**
   * An image as grid data for sampleGrid (height map, moisture, density, walkable mask...): { data: Float32Array, width, height, bits }. Name or path.
   * PNG is read at full precision (8 or 16 bits, grayscale or color); jpg / webp give 8 bits. channel: 'r' (default) 'g' 'b' 'a' or 0-3.
   * range: [min, max] the pixel values map to (default [0, 1]; pass world units, e.g. [-5, 60] meters). bits: 8 reads only the high byte of a 16-bit file.
   * @example const g = await engine.assets.gridFromImage('/maps/height.png', { range: [-5, 60] });  const h = sampleGrid(g.data, { ...g, size: [512, 512] });
   * @param {string} nameOrUrl
   * @param {{ channel?: 'r' | 'g' | 'b' | 'a' | number, range?: [number, number], bits?: 8 | 16 }} [opts]
   * @returns {Promise<{ data: Float32Array, width: number, height: number, bits: number }>}
   */
  gridFromImage(nameOrUrl, opts = {}) { return loadGrid(this.entries.get(nameOrUrl)?.url ?? nameOrUrl, opts); }

  /**
   * Release an asset and return its memory (reloaded on next use). A texture is released together with all its opts variants.
   * A sound (name or path) plays on where it is playing; its memory goes when it ends.
   * A model with copies still in the scene is not released yet; it is freed when the last copy is engine.remove'd (copies in use are never broken).
   * A load still running ends here and its result is thrown away; code awaiting that load is a use, so it gets a fresh load, never the freed data.
   * A name that fell back has no data of its own: release the name it fell back to (describe().assets says what still holds it).
   * A model whose geometry was handed out (assets.geometry, a generator's prototype) stays: nothing can know who still draws it, as with trim.
  */
  release(name) {
    for (const [k, v] of this.entries) if (v.variantOf === name) {
      const waited = v.load && !v.load.settled;   // the fresh load of whoever waits must stay in the table, where the next release can reach it
      this.release(k);
      if (!waited) this.entries.delete(k);
    }
    const e = this.entries.get(name); if (e && !e.load?.pinned) freeEntry(this, e);
  }
  /** Release every model with no copy in use and every long decoded sound (music, long loops; short effects stay), unless marked preload (call after a level change; level calls it). A prop or template keeps one copy for good, so its model stays. A sound still playing plays on. Returns the names released */
  trim() {
    const freed = [];
    for (const [k, e] of this.entries) if (e.type === 'model' ? e.value && !e.users && !e.load.pinned && !e.opts.preload : longSound(e) && !e.users) { freeEntry(this, e); freed.push(k); }
    return freed;
  }
  /**
   * How many copies of this model are in use (taken by model() and not yet engine.remove'd); these are what keep its data in memory. A model that failed
   * and fell back: _users('shrub') is the copies asked for as 'shrub', and _users('rock') counts those too, since they show rock's data; 0 means it can be freed
   */
  _users(name) { return this.entries.get(name)?.users ?? 0; }
  /** Called when an object is fully removed (engine.remove calls it): decrements the usage count of model copies beneath it and stops their animators */
  forget(obj) {
    obj.traverse(o => this._giveBack(o));
  }
  /**
   * @internal The one teardown of a model copy a module cloned itself (content props, pickups; engine.remove frees the same things around its own free): leases of the
   * copy and of its LOD levels, Animators, and the bones skeletonClone gave it. Its geometry and materials are the asset's (or the prototype's) and stay.
   * Why here and not in each module: each had a different subset (a LOD level's lease, a skinned copy's skeleton, an Animator's frame hook were left behind)
   */
  dropCopy(root) { this.forget(root); freeParts(root, () => false, { own: o => copyOwns(this.shared, o) }); }
  /** @internal One object's share: its animator stopped, its lease returned if it is a model copy. A second call does nothing (the copy is no longer listed) */
  _giveBack(o) {
    const anim = this._animators.get(o); if (anim) { this._animators.delete(o); anim.dispose(); }
    const copy = this._instances.get(o); if (!copy) return;
    this._instances.delete(o);
    copy.lease.remove();
  }
  /**
   * Release all loaded assets and decoders (engine.dispose calls it). A load still running ends and leaves nothing behind. Code awaiting one, and any later
   * model() / texture() / font() call, stays pending for good: it never resumes against a disposed engine and never rejects during teardown
   */
  dispose() {
    disposeProtos(this.engine);   // what model prototypes made (namedModel.js): no load owns it
    disposeEntries(this);
    this.draco?.dispose(); this.ktx2?.dispose();
  }

  /**
   * @internal Only core/assets/namedModel.js calls this (the one path for "a model made in code, used by name"): games name the model instead.
   * Code-generated model (build returns an Object3D or BufferGeometry): built once per name + params, returns a copy (geometry returns the same instance).
   * A generator written with `function` (not an arrow) can read this.palette = engine.assets.palette (the key includes it, so a new palette rebuilds).
   * Cache key = name + generator source + params: outer variables build uses (colors, sizes, seeds in the closure...) must go in params,
   * otherwise changing a variable still reads the stale cache. In dev, one name paired with different source warns once.
   * Lookup order: files baked by npm run bake (public/models/baked/) -> the dev auto-cache (.threedog/cache, invalidated when code changes) -> build now.
   * In dev, if the generator code is newer than the baked file, it builds now and warns once.
  */
  async cached(name, build, params) {
    const src = String(build), seen = (this._cachedSrc ||= new Map()).get(name);
    if (seen != null && seen !== src) warnOnce(coded('asset-name-clash', fmt(STRINGS.sameName, { name })));
    else this._cachedSrc.set(name, src);
    const key = 'cached:' + name + ':' + JSON.stringify(params ?? null) + ':' + this._paletteKey + ':' + srcHash(src);
    const e = this.entries.get(key) || this.entries.set(key, { type: 'model', url: name, opts: { build, params }, promise: null }).get(key);
    // Why pinned for good, also after a palette write: what leaves here is a bare geometry or a prototype that content, vegetation and pickups clone on
    // their own, so nothing counts who uses it and a free would break placed props. Counting it needs those three modules to count their copies
    return this._with(e, (g, load) => {
      load.pinned = true;
      return g.geometry ?? cloneModel(g.scene);
    });
  }
  /** Current usage: number of geometries and textures in GPU memory */
  get memory() { return memory(this.engine.renderer); }

  /**
   * Skeletal animation: returns the state machine (Animator.js); it runs per frame, so gameplay timing must not read it.
   * A manifest model entry's `animation` (clip names mapped to game action names, plain data) is the base; config wins per state.
   * @example engine.assets.manifest({ models: { hero: { url: '/models/hero.glb', animation: { states: { attack: { clip: 'Slash', loop: false } } } } } });
   * engine.assets.animate(await engine.assets.model('hero')).go('attack');
   */
  animate(root, config = {}) {
    const m = this.mapping(root), src = this._instances.get(root)?.e;
    const cfg = m ? { ...m, ...config, states: { ...m.states, ...config.states }, transitions: { ...m.transitions, ...config.transitions } } : config;
    const a = new Animator(this.engine, root, cfg, m && { label: `manifest "${src.manifest}" models.${src.name}.animation`, states: Object.keys(m.states || {}).filter(k => !config.states?.[k]) });
    this._animators.get(root)?.dispose();   // one animator per model: a new one replaces the old
    this._animators.set(root, a);
    return a;
  }
  /** @internal the Animator animate() made for a model, or null (a ragdoll holds it while the model is limp) */
  animatorOf(root) { return this._animators.get(root) ?? null; }
  /**
   * A model copy's manifest animation mapping ({ states, transitions, fade }), or null. Characters read it so default clip names never shadow it.
   * @example engine.assets.mapping(model)?.states.attack   // { clip: 'Slash', loop: false }
   * @param {import('three').Object3D} root @returns {{ states?: object, transitions?: object, fade?: number } | null}
   */
  mapping(root) { return this._instances.get(root)?.e.opts.animation ?? null; }
}
