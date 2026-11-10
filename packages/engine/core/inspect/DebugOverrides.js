// engine.debug: diagnostic overrides with an owner ("show me this without X") and the diagnostic view modes. They change only what the screen shows,
// never the game state or a save, and describe().scene.overrides lists them so an AI knows the picture is not the real state. Why an owner: a tool
// (view mode, probe, AI session) removes everything it set with one clear(owner), whatever it forgot to remove(); a tool never touches another owner's.
// Generic on purpose: a patch is { visible?, material?, apply? }, and apply(obj) -> undo covers any other picture (the view modes in debugView.js use it).
// All of engine.debug is core (it works without the debug panel); the F3 panel module only adds engine.debug.panel next to it (composition).
// One chain: every material / visibility change, from override() and from a view, is an entry in this._l. Removing any entry undoes the whole chain
// in reverse and re-applies the rest in order, so a view and an override on the same mesh can never restore each other's stale material, and nothing
// here disposes a material it did not create (stand-ins are cached on the original, so the original is never touched).
import { MeshBasicMaterial } from 'three';
import { allowOwned } from '../ops/owned.js';
import { reportError } from '../base/errors.js';
import { codedError } from '../base/errorHints.js';
import { DebugView } from './debugView.js';
import { isWebGPU, webgpuPart } from '../../render/backend.js';
import { reloadGlsl } from '../../render/hotGlsl.js';
import { reloadAssets } from '../assets/assetHot.js';
import { hex } from './MaterialInfo.js';
import { isUnder } from '../base/util.js';

const KEYS = ['visible', 'material', 'apply'];
const MATERIALS = ['flat', 'wire'];   // 'cost' (the shaderCost view) is internal: it needs patch.colorOf

/** Drawable parts under obj (obj itself included) */
function meshes(obj) { const out = []; obj.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) out.push(o); }); return out; }
const patchInfo = p => ({ ...p, ...(p.apply && { apply: 'function' }) });
/** A value in describe(): plain data as is, a three.js object by its type (describe() stays JSON) */
const plain = v => (v === null || typeof v !== 'object' ? v : v.isColor ? hex(v) : `<${v.type ?? 'object'}>`);

export class DebugOverrides {
  /** @internal */
  constructor(e) {
    /** @internal */ this.e = e;
    /** @internal the override chain, in apply order */ this._l = [];
    /** @internal material -> { kind: stand-in } */ this._stands = new WeakMap();
    /** @internal object -> key -> { was, vals }: the game's value under the stack of overrides on that key (_value) */ this._held = new WeakMap();
    /** @internal every stand-in made and not yet freed: stand-in -> [original, kind]. Whoever makes a GPU part frees it (design 6.2) */ this._made = new Map();
    /** @internal */ this._view = new DebugView(e, this);
    /** The F3 debug panel (the debug() module), or null when it is not installed @type {any} */
    this.panel = null;
    // a load can replace the objects a thing id names: an override still holding the old object would show on nothing and lie in describe
    e.events?.on?.('state:replaced', () => this._prune());
  }
  /**
   * Diagnostic view: 'albedo' | 'lighting' | 'shadow' | 'normals' to look at one part of the render, 'overdraw' (bright = many layers on a pixel),
   * 'shaderCost' (materials green -> red by compiled program cost, approximate), 'off' to restore; modules add their own (triggers: 'triggers' draws
   * the trigger zones), viewModes() lists them all. Temporary and owner-scoped; never saved
   * (describe().render says which view is active, so it is not mistaken for the real picture). While one owner's view is on, another owner can neither switch it
   * nor turn it off without force: true; engine.debug.clear(owner) turns that owner's view off too.
   * @example engine.debug.view('normals');   // look at the screenshot, then engine.debug.view('off')
   * @param {'albedo' | 'lighting' | 'shadow' | 'normals' | 'overdraw' | 'shaderCost' | 'off' | string} mode @param {{ owner?: string, force?: boolean }} [opts]
   * @returns {{ mode: string, owner: string | null, what?: string, note?: string }}
   */
  view(mode, opts) { return this._view.set(mode, opts); }
  /**
   * Add a view mode for engine.debug.view (a module's overlay: zones, paths, volumes). apply(scene) draws it and returns the undo; it may run again
   * when the debug chain re-applies, so it builds from scratch each time. Returns { remove() }.
   * @example engine.debug.defineView('paths', { what: 'patrol paths as lines', apply: scene => { scene.add(g); return () => scene.remove(g); } });
   * @param {string} name @param {{ what: string, apply: (scene: import('three').Scene) => () => void }} def
   * @returns {{ remove(): void }}
   */
  defineView(name, def) { return this._view.define(name, def); }
  /** Every mode engine.debug.view accepts now (built-in and module-added) @returns {string[]} */
  viewModes() { return this._view.modes(); }
  /**
   * Shader hot reload: swap GLSL text `old` for `neu` in every scene material using it (ShaderMaterial code, shader patch code) and recompile them.
   * The vite preset calls it when a `?raw`-imported .glsl / .vert / .frag file changes in dev; returns how many materials changed (0: the page reloads).
   * @param {string} old @param {string} neu @param {string} [file] @returns {{ file: string | null, materials: number, names: string[] }}
   */
  reloadGlsl(old, neu, file) { return reloadGlsl(this.e, old, neu, file); }
  /**
   * Asset hot swap: register the asset packs again (the new module of an edited assets.js) and build what changed (a new generator function,
   * url or params schema); every live copy swaps geometry and material in place, the page, player, clock and world state stay. The vite preset
   * calls it when an art module imported by the game's assets.js is saved; returns what was swapped (also in describe().assetSwaps).
   * @example import packs from '../assets.js'; if (import.meta.hot) import.meta.hot.accept('./assets.js', m => engine.debug.reloadAssets(m.default));
   * @param {any} packs @returns {Promise<{ why: string, names: string[], copies: Record<string, number>, ms: number, partsChanged?: string[] }>}
   */
  reloadAssets(packs) { return reloadAssets(this.e, packs); }
  /**
   * Watch one value the engine does not watch by default, on the dev server: who writes it (file:line, frame) goes into engine.explain({ value: name }), and two writers fighting
   * over it give a one-line hint. It observes; every write goes through. In a release build it does nothing: watching is false.
   * Only watched values are seen, and a write that leaves the value unchanged is not: a value that shows no conflict may still have one.
   * @example engine.debug.watch('boss.hp', boss, 'hp'); engine.debug.watch('player.pos', player, 'position');
   * @param {string} name what explain and describe('picture').picture.writers call it; a name already in use is refused (watching false)
   * @param {any} object the object, or a Color, Vector or rotation itself
   * @param {string} [key] a plain property; a Color, Vector or rotation held there is watched inside. A property behind a class accessor cannot be hooked (watching false)
   * @returns {{ watching: boolean, remove(): void }} remove() forgets the name; the accessor stays until reload and passes values through
   */
  watch(name, object, key) { return this.e._picture?.watchNamed(name, object, key) ?? { watching: false, remove() {} }; }
  /** The active view ({ mode: 'off', owner: null } when none) @returns {{ mode: string, owner: string | null, what?: string }} */
  viewState() { return this._view.state(); }

  /**
   * Change how an object looks for diagnosis, owned by `owner`. Returns { remove() }. Never saved, never part of the game state; listed in
   * describe().scene.overrides while active. A thing id is remembered as the id: when that thing is removed, or a load replaces it, the override is dropped.
   * Any three.js value: override(owner, object, key, value) writes object[key] and keeps it there every frame, above picture code that writes it in
   * onRender, so "show me this with exposure 3" holds; remove() puts the old value back.
   * @param {string} owner who sets it (a tool or session name); engine.debug.clear(owner) removes all of that owner's overrides
   * @param {any} target a thing id (engine.thing), an object name or any Object3D; with a key, any three.js object (renderer, scene, a light, a material) is that part's set() values, written on its debug layer above every game owner
   * @param {string | { visible?: boolean, material?: 'flat' | 'wire', apply?: (obj: any) => (() => void) | void }} patch flat = unlit base colour, wire = wireframe, apply = your own change (return its undo); a string: the property to write
   * @param {any} [value] with a property name: its value, of the type the property holds (null works: scene.fog off)
   * @example const h = engine.debug.override('ai-session', 'windmill', { material: 'flat' }); h.remove();   // or engine.debug.clear('ai-session')
   * @example engine.debug.override('ai-session', engine.renderer, 'toneMappingExposure', 3);
   * engine.debug.override('ai-session', engine.scene, 'fog', null);   // the same picture with no fog
   * @returns {{ remove(): void }}
   */
  override(owner, target, patch, value) {
    if (!owner || typeof owner !== 'string') throw codedError('debug-override', "engine.debug.override(owner, target, patch): owner is a non-empty string naming who sets it, e.g. 'ai-session', so engine.debug.clear(owner) can remove it");
    if (typeof patch === 'string') return this._value(owner, target, patch, value);
    if (!patch || typeof patch !== 'object') throw codedError('debug-override', `engine.debug.override(owner, target, patch): patch is a field name with a value, or { ${KEYS.join(', ')} }; got ${patch}`);
    for (const k of Object.keys(patch)) if (!KEYS.includes(k)) throw codedError('debug-override', `engine.debug.override: unknown field '${k}'. Fields: ${KEYS.join(', ')}, e.g. { visible: false } or { material: 'flat' }`);
    if (patch.material !== undefined && !MATERIALS.includes(patch.material)) throw codedError('debug-override', `engine.debug.override: material must be ${MATERIALS.map(m => `'${m}'`).join(' or ')} (unlit base colour / wireframe), got ${JSON.stringify(patch.material)}`);
    const byId = typeof target === 'string';
    const obj = /** @type {any} */ (target)?.isObject3D ? target : this.e.thing(target).object;
    const id = byId ? target : this.e._things.entryOf(obj)?.[0].id ?? (obj.name || obj.type);
    return this._add({ owner, id, byId, obj, patch: { ...patch }, undo: null });
  }
  /**
   * Remove every override of one owner (nothing else), and its view; returns how many were removed
   * @param {string} owner
   */
  clear(owner) {
    const mine = this._l.filter(o => o.owner === owner && !o.view);
    if (mine.length) this._rebuild(() => { this._l = this._l.filter(o => !mine.includes(o)); });
    const view = this._view.releaseOwner(owner) ? 1 : 0;
    return mine.length + view;
  }
  /** Active overrides as plain data (describe().scene.overrides) */
  overrides() {
    this._prune();
    return this._l.filter(o => !o.view).map(o => ({ owner: o.owner, target: o.id, ...patchInfo(o.patch) }));
  }
  /** @internal One three.js value on the chain: written now and again before each draw, so picture code that writes it per frame does not end the diagnosis */
  _value(owner, obj, key, value) {
    const say = why => codedError('debug-override', `engine.debug.override(owner, object, key, value): ${why}`);
    if (obj === null || typeof obj !== 'object') throw say(`object is the three.js object itself (engine.renderer, engine.scene, a light, a material), got ${JSON.stringify(obj)}`);
    const label = obj === this.e.renderer ? 'renderer' : obj.type ?? 'object';   // a class name is minified in a built page
    if (!(key in obj)) throw say(`${label} has no property '${key}'`);
    const now = obj[key];
    if (now != null && value != null && typeof now !== typeof value) throw say(`'${key}' holds a ${typeof now}, got ${typeof value}${now.isColor ? ': pass a THREE.Color' : ''}`);
    if (value === undefined) throw say(`give the value for '${key}' (null to clear it)`);
    const apply = o => {
      // allowed: a diagnostic is no game write, so the engine keeps driving an owned value (camera.far, tone) once the override ends
      // put is the exemption's owner: one per override, so two overrides of one key on two objects do not end each other's
      // The diagnostic wins while it is on, so a game write meanwhile is overwritten before the next draw. `was` is therefore the game's LATEST value, not the one at the
      // start: whatever stands there that is not ours is a game write, read before each re-write and once more at the end, and that is what comes back
      // One record per object and key, shared by every override on it: the game's value under the whole stack, and the values the stack writes (so one override does not take
      // another's value for a game write). Only the last release puts the game's value back; an earlier one shows the override that is left
      let rec = this._held.get(o)?.get(key);
      if (!rec) { rec = { was: o[key], vals: [] }; if (!this._held.has(o)) this._held.set(o, new Map()); this._held.get(o).set(key, rec); }
      const put = () => { o[key] = value; }, seen = () => { if (!rec.vals.includes(o[key])) rec.was = o[key]; };
      seen();   // a game write since the last frame (before this override joins the stack) is the game's value too
      rec.vals.push(value);
      allowOwned(put, [o]);
      put();
      const h = this.e.onRender(() => { seen(); put(); });
      return () => {
        h.remove(); seen();
        rec.vals.splice(rec.vals.indexOf(value), 1);
        if (rec.vals.length) o[key] = rec.vals[rec.vals.length - 1];
        else { o[key] = rec.was; this._held.get(o)?.delete(key); }
        allowOwned(put, false);
      };
    };
    return this._add({ owner, id: `${label}.${key}`, byId: false, obj, patch: { key, value: plain(value), apply }, undo: null });
  }
  /** Active overrides on one object, for engine.explain({ thing: id }) */
  overridesOn(obj) { this._prune(); return this._l.filter(o => o.obj === obj && !o.view).map(o => ({ owner: o.owner, ...patchInfo(o.patch) })); }
  /** @internal Undo everything, drop / restore what the views put back, re-apply (the engine calls it on dispose) */
  dispose() { this._rebuild(() => { this._l = []; }); this._view.active = null; }

  /** @internal Add one entry at the end of the chain: applied all-or-nothing, pushed only once it applied */
  _add(o) {
    this._apply(o);   // throws with nothing left changed (see _apply)
    this._l.push(o);
    return { remove: () => this._drop(o) };
  }
  /** @internal */
  _drop(o) { if (this._l.includes(o)) this._rebuild(() => { this._l = this._l.filter(x => x !== o); }); }
  /** @internal Undo the whole chain newest first, change the list, re-apply in order: no entry ever restores a value another entry set after it */
  _rebuild(change) {
    for (const x of [...this._l].reverse()) { try { x.undo?.(); } catch (err) { reportError(this.e, err, `undo of debug override ${x.id ?? x.owner}`, { soft: true }); } x.undo = null; }
    change();
    const keep = [];
    for (const x of this._l) { try { this._apply(x); keep.push(x); } catch { /* an apply that throws now (its object was disposed) is dropped */ } }
    this._l = keep;
    this._freeStands();
  }
  /** @internal Dispose the stand-ins no active entry puts on a mesh any more (the next use makes a new one), so a closed diagnostic leaves no compiled program behind */
  _freeStands() {
    const live = new Set();
    for (const x of this._l) if (x.patch?.material) for (const m of meshes(x.obj)) for (const s of [].concat(m.material)) live.add(s);
    for (const [s, [orig, kind]] of this._made) if (!live.has(s)) { s.dispose(); this._made.delete(s); delete this._stands.get(orig)?.[kind]; }
  }
  /** @internal Drop overrides set by thing id whose thing is gone: removed (detached from the scene) or the id now names another object (a load rebuilt it) */
  _prune() {
    const live = id => this.e._things?.live?.(id);
    const gone = this._l.filter(o => o.byId && (!inScene(o.obj, this.e.scene) || (live(o.id) ?? o.obj) !== o.obj));
    if (gone.length) this._rebuild(() => { this._l = this._l.filter(o => !gone.includes(o)); });
  }
  /** @internal Apply one entry; when a step throws, the steps already done are undone before the error goes on (all-or-nothing) */
  _apply(o) {
    const { patch, obj } = o, undos = [];
    const undo = () => { for (const u of undos.reverse()) u(); };
    try {
      // each undo puts back only what is still ours: a swap the game made meanwhile (a hit flash, a model change) stays
      if (patch.visible !== undefined) { const was = obj.visible; obj.visible = patch.visible; undos.push(() => { if (obj.visible === patch.visible) obj.visible = was; }); }
      if (patch.material) {
        for (const m of meshes(obj)) {
          const was = m.material;
          if (!was) continue;
          m.material = Array.isArray(was) ? was.map(x => this._stand(x, patch.material, patch.colorOf)) : this._stand(was, patch.material, patch.colorOf);
          const put = m.material;
          undos.push(() => { if (m.material === put) m.material = was; });
        }
      }
      if (patch.apply) { const u = patch.apply(obj); if (typeof u === 'function') undos.push(u); }
    } catch (err) { undo(); throw err; }
    o.undo = undo;
  }
  /** @internal One cached unlit stand-in per material and kind. Beside the material, not on its userData: the stand-in points back (_dbgOf), and three's material.clone()
   *  writes userData through JSON, which threw on the circle for the rest of the session */
  _stand(m, kind, colorOf) {
    if (m.userData._dbgOf) m = m.userData._dbgOf;   // already a stand-in (a view under an override): derive from the original, never stack copies
    let cache = this._stands.get(m);
    if (!cache) this._stands.set(m, cache = {});
    if (cache[kind]) { if (colorOf) cache[kind].color.setHex(colorOf(m)); return cache[kind]; }
    // a plain material on purpose: a diagnostic stand-in must not depend on the style it is diagnosing (rule 1 allows dev-only debug overlays)
    // on WebGPURenderer a MeshBasicNodeMaterial carrying the material's shape nodes (a NodeMaterial's own, or a patched material's tsl chain): a
    // plain stand-in would drop positionNode / vertexNode, so swaying trees froze and TSL-displaced meshes changed shape in the very view meant to
    // show them; colorNode is its base color (not for cost)
    const Node = isWebGPU(this.e.renderer) ? webgpuPart('classes', 'debug.view').MeshBasicNodeMaterial : null;
    const s = new (Node ?? MeshBasicMaterial)({ color: colorOf ? colorOf(m) : m.color ?? 0xffffff, map: colorOf ? null : m.map ?? null, alphaMap: m.alphaMap ?? null, vertexColors: !!m.vertexColors,
      transparent: !!m.transparent, opacity: m.opacity ?? 1, side: m.side, alphaTest: m.alphaTest ?? 0, wireframe: kind === 'wire', fog: false });
    if (Node) { s.positionNode = m.positionNode ?? null; s.vertexNode = m.vertexNode ?? null; if (!colorOf) s.colorNode = m.colorNode ?? null; }
    s.name = `debug:${kind}:${m.name || ''}`; s.userData._dbgOf = m;
    this._made.set(s, [m, kind]);
    return cache[kind] = s;
  }
}

/** True while obj hangs under the scene (a removed thing is detached) */
function inScene(obj, scene) { return !scene || isUnder(obj, scene); }
