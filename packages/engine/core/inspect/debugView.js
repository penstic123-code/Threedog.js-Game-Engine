// Diagnostic view modes behind engine.debug.view('albedo' | 'lighting' | 'shadow' | 'normals' | 'overdraw' | 'shaderCost' | 'off') (DebugOverrides.js).
// Temporary and owner-scoped: it changes how the scene is drawn (material swap / scene.overrideMaterial / lights hidden) and puts everything back on 'off'
// or when its owner clears (engine.debug.clear(owner)). Never saved, never part of the game's state; describe().render says so while one is active,
// so an AI reading a screenshot does not take "all white clay" for the real picture.
// Why a view is an entry of the debug override chain and not its own material swap: two independent swaps on one mesh restored each other's stale
// material and disposed the real one (review H3). In the chain, the albedo view is a { material: 'flat' } entry on the scene and the other modes an apply()
// entry whose undo only puts back what it changed, and only disposes the override material it created.
// One view at a time, held in the stack 'debug.view' (core/ops/stacks.js, kind top): only its owner (or force) switches it or turns it off.
// WebGPURenderer: the same plain-three override materials, on purpose. three's renderer turns any plain material into its node twin
// (NodeLibrary.fromMaterial) and, for scene.overrideMaterial, copies each mesh's positionNode onto the override, so swayed meshes keep their
// shape; a node-material copy here would add a three/webgpu import for nothing. Per-mesh stand-ins (albedo, shaderCost) are node materials on
// a NodeMaterial (DebugOverrides._stand), since nothing copies positionNode there. shaderCost reads the generated code (render/backend.js nodeProgram).
// A module adds its own mode with engine.debug.defineView(name, { what, apply }) (the triggers module: 'triggers' draws the zones as wireframes).
// Why one list and not a debug option per module: an AI learns one call (debug.view) for every "show me the hidden thing", the view is owner-scoped
// and said in describe().render like the built-in ones, and the core never names a module (check rule R27).
import * as THREE from 'three';
import { warnMissing } from '../base/validate.js';
import { materialCost } from './shaderCost.js';
import { codedError } from '../base/errorHints.js';

const VIEW_MODES = ['albedo', 'lighting', 'shadow', 'normals', 'overdraw', 'shaderCost', 'off'];
const EXPLAIN = {
  albedo: 'unlit base color and texture only (no lights, no shadows)',
  lighting: 'every surface plain white matte: shows only what the lights do (no textures)',
  shadow: 'plain white matte lit by direct lights only (ambient and hemisphere lights hidden, environment map off): shadows read as black',
  normals: 'surface normals as color (x/y/z -> r/g/b); a normal map shows here, flat shading looks faceted',
  overdraw: 'every drawn layer adds a little orange, depth test off: bright = many layers drawn over each other on that pixel (transparent foliage, particles, stacked planes)',
  shaderCost: 'each material colored by its compiled program cost (fragment code lines + samplers, approximate): green cheap, red the costliest in this scene, gray not compiled yet',
};
const OVERDRAW = 0x1a0c04;   // per layer: ~10 layers of it reach white

/** Cost color per material for the shaderCost view: green -> red by rank against the costliest program in the scene (gray: not compiled) */
function costColors(e) {
  const r = e.renderer, cost = new Map();
  e.scene.traverse(o => { for (const m of [].concat(o.material || [])) if (m && !cost.has(m)) cost.set(m, materialCost(r, m)?.score ?? -1); });
  const max = Math.max(1, ...cost.values());
  const c = new THREE.Color();
  return m => {
    const s = cost.get(m.userData?._dbgOf ?? m) ?? -1;
    return s < 0 ? 0x808080 : c.setHSL(0.33 * (1 - s / max), 0.9, 0.5).getHex();
  };
}

/**
 * scene.environment off inside each render of the scene only (the shadow view): an environment map lights the override's standard material from
 * every side, which lifted the shadows the view shows black (both renderers read it per render: WebGL per material program, WebGPU per render object).
 * Why around each render and not scene.environment = null for the view's lifetime: scene.environment is an owned property (the sky's env row,
 * core/ops/owned.js); a write that lasts across frames reads as the game taking it over. Between renders the scene keeps its real map, so nothing
 * is recorded and nothing needs restoring but the two hooks. Returns the undo (puts the scene's own hooks back exactly: an own property or the prototype's).
 * @param {any} scene @returns {() => void}
 */
function withoutEnvironment(scene) {
  const own = { before: Object.hasOwn(scene, 'onBeforeRender'), after: Object.hasOwn(scene, 'onAfterRender') };
  const prevBefore = scene.onBeforeRender, prevAfter = scene.onAfterRender;
  let env = null, held = false;
  const before = function (...a) {
    if (!held && scene.environment) { env = scene.environment; scene.environment = null; held = true; }
    return prevBefore.apply(this, a);
  };
  const after = function (...a) {
    try { return prevAfter.apply(this, a); } finally { if (held) { if (scene.environment === null) scene.environment = env; env = null; held = false; } }
  };
  scene.onBeforeRender = before; scene.onAfterRender = after;
  return () => {
    if (held && scene.environment === null) scene.environment = env;   // a render that threw between the hooks
    if (scene.onBeforeRender === before) { if (own.before) scene.onBeforeRender = prevBefore; else delete scene.onBeforeRender; }
    if (scene.onAfterRender === after) { if (own.after) scene.onAfterRender = prevAfter; else delete scene.onAfterRender; }
  };
}

/** apply() for the scene-wide modes: returns an undo that restores only what this call changed */
function sceneMode(mode) {
  return scene => {
    // plain three materials on purpose: a diagnostic must not depend on the style it diagnoses
    const add = { color: OVERDRAW, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false };
    const mat = mode === 'normals' ? new THREE.MeshNormalMaterial() : mode === 'overdraw' ? new THREE.MeshBasicMaterial(add) : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });   // debug view only
    const was = scene.overrideMaterial, hidden = [];
    scene.overrideMaterial = mat;
    if (mode === 'shadow') scene.traverse(o => { if ((o.isAmbientLight || o.isHemisphereLight || o.isLightProbe) && o.visible) { o.visible = false; hidden.push(o); } });
    const noEnv = mode === 'shadow' ? withoutEnvironment(scene) : null;
    return () => {
      if (scene.overrideMaterial === mat) scene.overrideMaterial = was;
      mat.dispose();   // ours: created above
      for (const l of hidden) if (!l.visible) l.visible = true;
      noEnv?.();
    };
  };
}

export class DebugView {
  /** @param {any} engine @param {any} debug the engine.debug override chain it lives in */
  constructor(engine, debug) {
    this.engine = engine; this.debug = debug;
    /** @type {{ mode: string, owner: string } | null} the active view (null = the real picture) */
    this.active = null;
    this._holder = engine.stacks.define('debug.view', { kind: 'top', save: false });
    this._entry = null;
    /** @internal modes added by modules: name -> { what, apply } */ this._defs = new Map();
  }
  /**
   * Add a view mode (a module's own overlay or swap). apply(scene) changes the drawing and returns its undo; the debug chain runs it again whenever
   * it re-applies (another override removed), so it builds from scratch each time. Returns { remove() } (turns the view off first if it is on).
   * @param {string} name @param {{ what: string, apply: (scene: any) => () => void }} def
   * @returns {{ remove(): void }}
   */
  define(name, def) {
    if (VIEW_MODES.includes(name) || this._defs.has(name)) throw codedError('debug-view', `engine.debug.defineView('${name}'): this view mode already exists; pick another name`);
    if (typeof def?.apply !== 'function' || typeof def.what !== 'string') throw codedError('debug-view', `engine.debug.defineView('${name}', { what, apply }): what is a one-line explanation, apply(scene) returns its undo`, TypeError);
    this._defs.set(name, def);
    // by identity: a stale handle (the mode was removed and defined again) must not turn off or delete the newer view of the same name
    return { remove: () => { if (this._defs.get(name) !== def) return; if (this.active?.mode === name) this._off(); this._defs.delete(name); } };
  }
  /** Every mode a view can show now: the built-in ones and those modules added @returns {string[]} */
  modes() { return [...VIEW_MODES, ...this._defs.keys()]; }
  /**
   * Show a diagnostic view; 'off' restores the real picture. Temporary: never saved, and a game that reads it must not branch on it.
   * owner names who asked ('debug' by default): while one owner's view is on, another owner can neither switch it nor turn it off unless it passes force.
   * @param {'albedo' | 'lighting' | 'shadow' | 'normals' | 'overdraw' | 'shaderCost' | 'off' | string} mode a built-in mode or one a module added (defineView)
   * @param {{ owner?: string, force?: boolean }} [opts]
   * @returns {{ mode: string, owner: string | null, what?: string, note?: string }}
   */
  set(mode, { owner = 'debug', force = false } = {}) {
    if (!this.modes().includes(mode)) { warnMissing('debug view', String(mode), this.modes()); return this.state(); }
    const a = this.active;
    if (a && a.owner !== owner && !force) return { ...this.state(), note: `view "${a.mode}" belongs to "${a.owner}"; pass { owner: '${a.owner}' } or force: true to ${mode === 'off' ? 'clear' : 'switch'} it` };
    this._off();
    if (mode === 'off') return this.state();
    const e = this.engine, scene = e.scene;
    const def = this._defs.get(mode);
    const patch = def ? { apply: def.apply } : mode === 'albedo' ? { material: 'flat' } : mode === 'shaderCost' ? { material: 'cost', colorOf: costColors(e) } : { apply: sceneMode(mode) };
    this._entry = this.debug._add({ owner, id: 'view:' + mode, byId: false, obj: scene, patch, undo: null, view: true });
    this._holder.take({ owner, value: { mode } });
    this.active = { mode, owner };
    return this.state();
  }
  /** Turn off the view if owner holds it (engine.debug.clear(owner)); true when it did */
  releaseOwner(owner) { if (this.active?.owner !== owner) return false; this._off(); return true; }
  /** @returns {{ mode: string, owner: string | null, what?: string }} the active view, or { mode: 'off' } */
  state() { return this.active ? { ...this.active, what: EXPLAIN[this.active.mode] ?? this._defs.get(this.active.mode)?.what } : { mode: 'off', owner: null }; }
  _off() {
    this._entry?.remove(); this._entry = null;
    this._holder.clear(); this.active = null;
  }
}
