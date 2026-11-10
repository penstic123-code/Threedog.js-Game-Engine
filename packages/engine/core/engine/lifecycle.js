// Engine lifecycle: dispose() and counts() for leak hunting.
//
// Part of Engine (mixed into Engine.prototype).
//
// Who cleans up what:
//   - DOM listeners: attach to engine.signal (an AbortController); dispose aborts them all at once. Modules and games adding their own window / document listeners do the same:
//       addEventListener('resize', fn, { signal: engine.signal })
//   - UI elements: the engine and modules build UI under engine.uiRoot, removed as a whole on dispose; do not attach to document.body directly.
//   - Events, onFixed / onFrame, clock timers, jobs, stream, ray registrations: core clears them all here. A module registers its own through
//     ctx.track (modules.js), so they also leave when its install rolls back or its init fails, and go before its dispose hook runs.
//   - Things core does not know about (Worker, physics world, Audio nodes, real-time timers): clean up in the module's dispose(e) hook, called in reverse install order.
//   - GPU memory (design.md 6.2, whoever made it frees it): the scene walk gives back model copies' leases and frees only what the engine made (engineParts below);
//     then the assets cache frees what its loads made, the post composer, then renderer.dispose(). A material or texture the game made stays the game's.
// Waits across dispose, one rule: a wait in game code (model(), jobs.add, nextFixed, a cutscene, an await of what those feed) stays pending for good, because the code after it
// belongs to a dead engine (assetEntry.js says why not reject). Two waits have to answer instead: start(), for whoever booted the engine (startup.js), and a stream source's whenReady,
// which rejects stream-removed: dispose removes every source, and a source made afterwards is born removed.
// Level changes do not come through here: things inside a level register with level.track(handle), and the level removes them itself on change.

import { coded, codedError } from '../base/errorHints.js';
import { fmt, syncOnly } from '../base/validate.js';
import { dropOwned } from '../ops/owned.js';
import { reportError } from '../base/errors.js';
import { releaseContext, memory } from '../../render/backend.js';
import { freeParts, partsOf, copyOwns, kept } from '../base/freeParts.js';
import { moduleOwnerOf } from '../scene/things.js';
import { isEngineMade } from '../../render/patches.js';

/** The per-step / per-frame callback lists (onFixed, onFrame, animators, onRender, module hooks), empty: the constructor's starting state and what dispose leaves */
export function clearHooks(e) {
  e._fixed = []; e._fixedLate = []; e._frame = []; e._animate = []; e._onRender = { before: [], after: [] }; e._hooks = { fixed: [], frame: [], afterRender: [], skip: [] };
}

const STRINGS = { failed: '[engine] dispose hook of module {name} threw (the rest are still cleaned up)', part: '[engine] a cleanup step of engine.dispose() threw, {why} (the rest are still cleaned up)',
  released: 'createEngine(): this canvas lost its WebGL context in an earlier engine.dispose(), so a new engine cannot draw on it; use a new canvas, or dispose the old engine with dispose({ keepContext: true })',
  opts: 'engine.dispose(opts): opts is { keepContext?: boolean }; got {v}' };

// Canvases whose context dispose() released: a lost context cannot host a new renderer, so createEngine on one fails loudly instead of drawing black
const released = new WeakSet();
/** createEngine calls it before building its renderer on a canvas */
export function checkCanvasUsable(canvas) { if (canvas && released.has(canvas)) throw codedError('canvas-released', STRINGS.released); }

/**
 * engine.dispose's owner test (design.md 6.2): the parts the engine made, never the game's or an asset load's. Engine nodes are objects a module put in
 * the scene (engineOwned, or registered under 'engine:<module>') and everything under them. A material or texture is the engine's only when its maker marked
 * it engine-made (markEngineMade): never inferred from the material a texture sits on, since a game texture may sit on an engine material and on a game one
 * at once. A geometry only when no game node draws it (a batch draws the game's own geometry). Asset parts and kept parts (keepPart) never: their owner frees them.
 */
function engineParts(e) {
  const shared = e.assets.shared, T = e._things, nodes = new Set(), gameUsed = new Set();
  const walk = (o, eng) => {
    eng ||= !!moduleOwnerOf(o) || !!T?.byObj.get(o)?.owner?.startsWith('engine:');
    if (eng) nodes.add(o); else for (const x of partsOf(o)) gameUsed.add(x);
    for (const c of o.children) walk(c, eng);
  };
  walk(e.scene, false);
  return {
    mine: x => !shared.has(x) && !kept(x) && (x.isMaterial || x.isTexture ? isEngineMade(x) : !gameUsed.has(x)),
    own: o => nodes.has(o) || copyOwns(shared, o),
  };
}

export const lifecycleMethods = {
  /**
   * Destroy the engine: stop the main loop, call each module's dispose(e) in reverse install order, then clean up core (listeners, timers, sound, UI, GPU memory).
   * No callbacks fire afterwards and engine.disposed becomes true. Safe to call repeatedly. start() rejects with engine-disposed; awaits in game code (a model, a job, nextFixed) stay pending for good.
   * The engine's own renderer also gives its WebGL context back (renderer.forceContextLoss): browsers keep only about 16 live contexts, so a page that
   * creates and disposes engines (level editor, tests, restart) would otherwise lose the oldest one. That canvas cannot host a new engine afterwards;
   * keepContext: true keeps the context for a new engine on the same canvas. A renderer the game passed in (createEngine({ renderer })) is never released.
   * @param {{ keepContext?: boolean }} [opts]
   */
  dispose(opts = {}) {
    if (opts === null || typeof opts !== 'object' || Object.keys(opts).some(k => k !== 'keepContext')) throw codedError('dispose-options', fmt(STRINGS.opts, { v: String(JSON.stringify(opts)) }));
    if (this.disposed) return;
    this.phase = 'disposed'; this.halted = true; this._starting = null;   // a finished start() must not answer a later call as if the engine were alive
    cancelAnimationFrame(this._raf);
    // one step that throws must not leave the renderer, the UI and the listeners alive: a game's 'dispose' listener on a material reaches here, and three calls it inside m.dispose()
    const tidy = fn => { try { fn(); } catch (err) { reportError(this, err, coded('module-dispose', fmt(STRINGS.part, { why: String(err?.message ?? err) })), { soft: true }); } };
    tidy(() => dropOwned(this, [...(this._owned?.values() ?? [])]));   // owned.js keeps a page-wide list for allowOwned
    for (const m of [...this.modules.values()].reverse()) {
      this._modState.set(m.name, 'disposed');
      this._dropTracked(m.name);   // its listeners / timers go first, so nothing calls into the module while its dispose tears it down
      if (!m.dispose) continue;
      try { syncOnly(m.dispose(this), `dispose() of module ${m.name}`, true); } catch (err) { reportError(this, err, coded('module-dispose', fmt(STRINGS.failed, { name: m.name })), { soft: true }); }
    }
    this._abort.abort();
    tidy(() => this._untrackValidate());
    tidy(() => this._wraps?.dispose());   // engine.wrap: every wrapped method back on its object (a game object or api may outlive the engine)
    tidy(() => this._adoptAdds?.remove());   // plain scene.add on a scene that outlives the engine must not call into a dead registry
    tidy(() => this._gameLights?.dispose());
    tidy(() => this._picture?.dispose());   // dev tool: its scene watchers go with the engine
    tidy(() => this.debug.dispose());   // before the scene is disposed: undoes every diagnostic override and view (puts swapped materials back)
    for (const part of [this.saves, this.audio, this.time, this.commits, this.jobs, this.threads, this.stream, this.batching, this.rays, this.events]) tidy(() => part.dispose());
    clearHooks(this); this._afterTick = null;
    tidy(() => this.assets.forget(this.scene));   // references and leases first: each model copy gives its lease back, its animator stops
    tidy(() => { const { mine, own } = engineParts(this); freeParts(this.scene, mine, { textures: true, own, tidy }); });
    // scene.environment and a background texture are let go, never disposed here: the engine's own maps (sky PMREM targets, the baseline room map) were
    // freed above by their owners, a skybox file is the asset cache's, and anything else is the game's texture (a direct write), which stays the game's to free
    this.scene.environment = null;
    if (this.scene.background?.isTexture) this.scene.background = null;
    for (const part of [this.assets, this.occlusion, this.post]) tidy(() => part.dispose());
    tidy(() => this._webglOnlyView?.remove()); this._webglOnlyView = null;
    tidy(() => this._gpu?.dispose());
    tidy(() => this.renderer.dispose());
    tidy(() => { if (this._ownsRenderer && !opts.keepContext) { releaseContext(this.renderer); released.add(this.renderer.domElement); } });
    tidy(() => this.ui._dispose());
    tidy(() => this._materials.remove());
    tidy(() => this._uiStyle.remove());
    this.uiRoot.remove();
  },

  /**
   * Counts for leak hunting: after repeatedly entering and leaving levels or opening and closing windows, these should not keep growing.
   * geometries / textures come from three.js renderer.info.memory (counted only once rendered).
   * Each installed module with a counts(e) hook adds its own field under its name, e.g. world { records, views }, rigid (body count), particles { alive, emitters }, sky { timers }.
   */
  counts() {
    const mem = memory(this.renderer);
    const c = {
      listeners: this.events.size, fixed: this._fixed.length + this._fixedLate.length, frame: this._frame.length + this._animate.length, timers: this.time.size,
      statics: this.rays.statics.size, streamEntries: this.stream.entries.size, jobs: this.jobs.pending, commits: this.commits.pending,
      geometries: mem.geometries, textures: mem.textures,
    };
    for (const m of this.modules.values()) if (m.counts) c[m.name] = m.counts(this);
    return c;
  },
};
