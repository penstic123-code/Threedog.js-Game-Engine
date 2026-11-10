// engine.page: the one place that listens to the browser window and device (focus, tab visibility, mouse lock, WebGL context). Modules never add their own
// blur / visibilitychange / pointerlockchange / webglcontextlost listeners; they read engine.page or listen to the page:* events.
//   createEngine({ pauseOnBlur: false })     // keep playing while the window is in the background (default: gameplay waits)
//   engine.page.pauseOnBlur = false;         // same, at runtime (e.g. a settings toggle)
//   engine.events.on('page:blur', () => engine.flow?.go('paused'));   // show the pause menu as well, if the game wants one
// While the page is away (window lost focus or tab hidden) with pauseOnBlur, gameplay is frozen by owner 'page': an ordinary freeze, so everything that obeys a freeze
// (fixed steps, timers, cutscenes, engine.frozen, runState, describe) agrees with no code of its own here, and the sound waits too (Audio._hold). It is a full still ({ still: true }): limbs walking on
// the spot over a stopped world look broken. Rendering and UI go on. Coming back resumes from where it stopped, with no catch-up burst (the loop drops the time spent
// away). A halted engine (tests, the dev bridge) has no real-time loop to hold, so there is no page freeze, and step() drives a page in a background window.
// Held keys are released by Input when it hears page:blur.
// WebGL context lost (driver reset, GPU memory pressure): the same freeze, and the player sees a message; three.js restores the context itself and play resumes.
// WebGPU device lost: the same, except that a lost device does not come back, so the message asks for a reload.
import { coded } from '../base/errorHints.js';
import { toast } from '../../ui/UI.js';
import { warnOnce } from '../base/validate.js';
import { notePatch, patchOn } from '../scene/threePatches.js';
import { isWebGPU, setShadowUpdate } from '../../render/backend.js';

const STRINGS = {
  'zh-CN': { 'page.gpuLost': '图形设备暂时不可用，正在恢复……如果画面一直不恢复，请刷新页面', 'page.gpuBack': '画面已恢复', 'page.gpuGone': '图形设备已丢失，请刷新页面' },
  en: { 'page.gpuLost': 'The graphics device was lost; trying to recover... If the picture does not come back, reload the page', 'page.gpuBack': 'Graphics restored', 'page.gpuGone': 'The graphics device was lost; please reload the page' },
};
const DEV = { lost: '[page] WebGL context lost: gameplay waits until the browser restores it (three.js rebuilds GPU resources). If it never comes back, the page must be reloaded.',
  gone: '[page] WebGPU device lost: gameplay waits. A lost device does not come back, so the page must be reloaded.' };

notePatch('device-lost-hook', "renderer.onDeviceLost of a WebGPURenderer (three's own hook, kept and called first): reports the loss through engine.page (core/engine/page.js)", () => {},
  { scope: 'engine renderer', lost: 'engines made from now on: after a device loss the picture freezes while the game keeps running, with no message' });

notePatch('page-exit-pointer-lock', "document.exitPointerLock (one wrapper for every live engine, taken off with the last one): tells engine.page the unlock was the game's own call (core/engine/page.js)", () => {},   // off: the wrapper stays (gone with the last engine) and stops telling
  { scope: 'page', lost: 'a game-requested unlock reads as the player pressing Esc (page:pointerlock byEngine stays false)' });

// document.exitPointerLock is one property for the page: one wrapper for every live engine, gone with the last. A wrapper per engine could only be taken off all at once
const lockers = new Set();
/** @param {Page} page @param {AbortSignal} signal */
function watchExitLock(page, signal) {
  const exitLock = document.exitPointerLock;
  if (!exitLock) return;
  if (!lockers.size) {
    const own = Object.hasOwn(document, 'exitPointerLock');
    const wrapper = () => { if (patchOn('page-exit-pointer-lock')) for (const p of lockers) p._releasing = document.pointerLockElement === p.engine.renderer.domElement; return exitLock.call(document); };
    document.exitPointerLock = wrapper;
    lockers.unwrap = () => { if (document.exitPointerLock !== wrapper) return; if (own) document.exitPointerLock = exitLock; else delete document.exitPointerLock; };
  }
  lockers.add(page);
  signal.addEventListener('abort', () => { lockers.delete(page); if (!lockers.size) lockers.unwrap(); });
}

/** engine.page: window focus, tab visibility, mouse lock and WebGL context, all handled here. */
export class Page {
  /** @internal */
  constructor(engine, { pauseOnBlur = true } = {}) {
    /** @internal */ this.engine = engine;
    /** @internal public: pauseOnBlur */ this._pauseOnBlur = pauseOnBlur;
    /** @internal the 'page' freeze while it is up */ this._hold = null;
    /** The window has keyboard focus @type {boolean} @experimental */
    this.focused = true;   // a page that starts unfocused (opened behind devtools, driven by the dev bridge) still plays until the window is left once
    /** The tab is visible @type {boolean} */
    this.visible = document.visibilityState !== 'hidden';
    /** The mouse is locked to the canvas (first-person / shoulder cameras lock on click) @type {boolean} @experimental */
    this.pointerLocked = false;
    /** The WebGL context is lost and not yet restored, or the WebGPU device is lost @type {boolean} @experimental */
    this.contextLost = false;
    /** @internal the real-time loop drops the time accumulated so far (set when the page comes back) */ this._resync = false;
    /** @internal the lock ending next is the engine's own */ this._releasing = false;
    engine.i18n.add(STRINGS);
    if (engine.headless) return;   // headless advances only through step(); there is no real-time play to hold
    const signal = engine.signal, canvas = engine.renderer.domElement;
    addEventListener('blur', () => this._set('focused', false), { signal });
    addEventListener('focus', () => this._set('focused', true), { signal });
    document.addEventListener('visibilitychange', () => this._set('visible', document.visibilityState !== 'hidden'), { signal });
    // Esc and a script's exitPointerLock() end in the same pointerlockchange, so the call is the one place to tell them apart: a game that calls it is not the player pausing
    watchExitLock(this, signal);
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (locked === this.pointerLocked) return;   // another engine's canvas on this page: not locking is not "the player pressed Esc"
      this.pointerLocked = locked;
      // the camera locks again on the next click (camera/common.js). byEngine: the engine let go itself; otherwise it was the player's Esc (ui/Focus.js)
      engine.events.emit('page:pointerlock', { locked: this.pointerLocked, byEngine: !this.pointerLocked && this._releasing });
      this._releasing = false;
    }, { signal });
    canvas.addEventListener('webglcontextlost', ev => {
      ev.preventDefault();   // tells the browser we want the context back
      this._lost(DEV.lost, 'page.gpuLost');
    }, { signal });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false; this._resync = true; this._sync();
      toast(engine, engine.t('page.gpuBack'));
      // a restored context has empty shadow maps, and a map kept on purpose (autoUpdate off, a budget) would stay blank until the game next asked for it
      setShadowUpdate(engine.renderer, engine.scene, { now: true });
      engine.events.emit('page:contextrestored');
    }, { signal });
    // WebGPU fires no canvas event, three calls this hook. Its WebGL2 backend calls it too, but there the listeners above report the loss and its return
    const r = engine.renderer, threeLost = r.onDeviceLost;
    if (isWebGPU(r) && patchOn('device-lost-hook')) r.onDeviceLost = info => { threeLost.call(r, info); if (info?.api !== 'WebGL') this._lost(DEV.gone, 'page.gpuGone'); };
  }

  /** Freeze gameplay while the page is away; default true. Settable at runtime @type {boolean} */
  get pauseOnBlur() { return this._pauseOnBlur; }
  set pauseOnBlur(v) { this._pauseOnBlur = v; this._sync(); }

  /** @internal take or drop the 'page' freeze to match the page. Called on every change it depends on, so nothing asks each frame */
  _sync() {
    const want = !this.engine.halted && ((this._pauseOnBlur && this.away) || this.contextLost);
    if (want === !!this._hold) return;
    if (want) this._hold = this.engine.freeze('page', { still: true });
    else { this._hold.remove(); this._hold = null; }
    this.engine.audio?._hold(want);   // a frozen game keeps no loop sounding on its own in a background tab
  }

  /** @internal the graphics went away: gameplay freezes, the developer and the player are told, page:contextlost goes out. Once per loss */
  _lost(dev, message) {
    if (this.contextLost) return;
    this.contextLost = true; this._sync();
    warnOnce(coded('webgl-lost', dev));
    toast(this.engine, this.engine.t(message), { kind: 'error', ms: 8000 });
    this.engine.events.emit('page:contextlost');
  }

  /** The page is away: the window lost focus or the tab is hidden @type {boolean} @experimental */
  get away() { return !this.focused || !this.visible; }

  /** @internal For the real-time loop: true once after the page came back (drop the time accumulated while away), then false @returns {boolean} */
  consumeResync() { const r = this._resync; this._resync = false; return r; }

  /** @internal one focus / visibility change: emit page:blur / page:focus only when "away" actually flips */
  _set(key, v) {
    const was = this.away;
    this[key] = v;
    if (was === this.away) return;
    if (!this.away) this._resync = true;   // a hidden tab gets no frames, so its time arrives as one long dt: that must not become a burst of fixed steps
    this._sync();
    this.engine.events.emit(this.away ? 'page:blur' : 'page:focus', { focused: this.focused, visible: this.visible });
  }

  /**
   * Let go of the mouse (a game's own screen, a click-driven moment). Not read as the player's Esc, so the pause menu stays shut. Does nothing without a lock; the next
   * click on the view locks again.
   * @returns {void}
   * @example engine.page.releaseLock(); showMyMap();
   */
  releaseLock() { document.exitPointerLock?.(); }

  /** @internal for describe */
  describe() { return { away: this.away, pointerLocked: this.pointerLocked, contextLost: this.contextLost }; }
}
