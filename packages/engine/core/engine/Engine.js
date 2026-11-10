// Engine core: what every 3D web game needs (rendering and post, main loop, events, input, assets, audio, saves, UI basics, loading screen, ground API).
// No terrain, sky or characters, and no art; everything else is a module installed with engine.use(...) (see recipes/14-custom-module.md).
// Split: main loop and step in loop.js, start() in startup.js, ground API in ground.js, module install in modules.js, dispose and counts in lifecycle.js (all
// mixed into Engine.prototype).
import * as THREE from 'three';
import { Page } from './page.js';
import { createServices } from './services.js';
import { Stacks } from '../ops/stacks.js';
import { PostFX } from '../../render/PostFX.js';
import { Occlusion } from '../../render/occlusion.js';
import { createDefaultLights } from '../../render/lights.js';
import { registerEngine } from '../../render/materials.js';
import { createUniforms } from '../../render/effects.js';
import { bindUniforms } from '../../render/engineUniforms.js';
import { UIParts } from '../../ui/Parts.js';
import { defineCoreParts } from '../../ui/defaults.js';
import { applyUITheme } from '../../ui/theme.js';
import { trackValidate, warnOnce, DEV } from '../base/validate.js';
import { readParams } from '../base/params.js';
import { loopMethods } from './loop.js';
import { holdMethods } from '../ops/holds.js';
import { startupMethods } from './startup.js';
import { groundMethods, flatGround } from '../scene/ground.js';
import { actorMethods } from '../ops/actor.js';
import { forcedTier, storedMsaa } from '../scene/tier.js';
import { tier as detectTier, tierBeforeRenderer, ownMsaa, timerContext, isWebGPU, webgpuPart, watchNodePrograms, mathClasses } from '../../render/backend.js';
import { recordSweep } from '../../render/recordSweep.js';
import { dressNodeTwins } from '../../render/patches.js';
import { lifecycleMethods, clearHooks, checkCanvasUsable } from './lifecycle.js';
import { createAdaptive, GpuTimer } from '../scene/adaptive.js';
import { firstRatio, noteDeviceBox, pixelSizeOn } from '../scene/pixelRatio.js';
import { watchRejections } from '../base/errors.js';
import { createMovement } from '../scene/movement.js';
import { moduleMethods } from './modules.js';
import { skipMethods } from '../time/skip.js';
import { checkMethods } from '../inspect/checks.js';
import { toolDoor } from '../inspect/toolDoor.js';
import { canvasBox, placeUI, resizeMethods } from '../scene/canvasBox.js';
import { sceneMethods } from '../scene/sceneMethods.js';
import { movedOwned } from '../ops/owned.js';
import { recordRender } from '../inspect/describeRender.js';
import { installPictureWriters } from '../inspect/pictureWriters.js';
import { ownHook } from './moduleTypes.js';
import { defineShadows } from '../../render/shadows.js';
import { defineTerms } from '../../render/terms.js';
import { defineView, checkCamera } from '../scene/view.js';
import { nameShaderErrors } from '../../render/shaderErrors.js';
import { probeMethods } from '../../render/probes.js';
import { lightmapMethods } from '../../render/lightmap.js';
import { headlessSettled } from './headlessLoad.js';
import { coded, codedError } from '../base/errorHints.js';
// render/backend.js may not import three (threedog/tsl reaches it): its renderer borrow gets the two math classes from here
mathClasses(THREE);
const FALLBACKS = ['webgl2', 'webgl', 'error'];
// createEngine() options: the one table for the unknown-key and type check (dev throws with did-you-mean, release warns once), the plain
// defaults and engine.catalog('core').params; R6 checks EngineOptions (types/core.d.ts) has exactly these keys. A key with several shapes
// names them all ('bool|object'). Object / array defaults stay in the destructuring below (in the schema all engines would share one object).
/** @internal */
export const ENGINE_PARAMS = {
  canvas: 'object?', renderer: { type: 'string|object', optional: true, desc: "'webgl' (default), 'webgpu', or a renderer the game built" },
  fallback: { type: 'string', optional: true, values: FALLBACKS }, antialias: 'bool?',
  pixelRatio: 'number?', pixelSize: { type: 'int', optional: true, min: 1, desc: 'real screen pixels per art pixel' }, adaptiveResolution: { type: 'bool', default: true }, targetFps: { type: 'number', default: 55, min: 1 },
  ui: 'object?', audio: 'object?', fov: { type: 'number', default: 55, min: 1, max: 179 }, near: { type: 'number', default: 0.3, min: 0 },
  locale: { type: 'string', default: 'auto' }, strings: 'object?', bindings: 'object?', saveKey: { type: 'string', default: 'game' },
  joystick: { type: 'string|bool', default: 'auto' }, blockBrowserKeys: { type: 'bool', default: true, desc: 'while playing, keys the game binds (Ctrl+S, F1, Backspace...) do not reach the browser' }, headless: 'bool?', validate: { type: 'bool', default: true }, decoders: 'string?',
  budget: 'object?', urlState: 'bool?', seed: 'number?', movement: 'object?', threads: { type: 'string|number|bool', default: 'auto' },
  pauseOnBlur: { type: 'bool', default: true }, batching: 'bool|object?', lights: { type: 'bool', default: true },
};

/**
 * createEngine({ renderer: 'webgpu' }): three's WebGPURenderer from the classes threedog/tsl registered (render/backend.js). No powerPreference on
 * Windows: Chrome ignores it there and warns on every page load (crbug.com/369219127) @param {any} canvas
 */
function newWebGPURenderer(canvas, antialias) {
  const power = navigator.userAgent.includes('Windows') ? {} : { powerPreference: 'high-performance' };
  return new (needTsl("'webgpu'").WebGPURenderer)({ canvas, antialias, ...power });
}

/**
 * The three/webgpu classes threedog/tsl registered. Both WebGPU roads need it before createEngine: it brings three/webgpu for 'webgpu', and
 * the tsl side of patches and the WebGPU parts for any WebGPURenderer. Why not a dynamic import in start(): the engine core never imports it,
 * so WebGL games stay small.
 * @param {string} how
 */
const needTsl = how => webgpuPart('classes', `createEngine({ renderer: ${how} })`);

/** Check renderer / fallback and say what start() does: { requested, fallback } @param {any} r @param {any} rendererIn @param {any} fallback */
function rendererWant(r, rendererIn, fallback) {
  if (typeof rendererIn === 'string' && rendererIn !== 'webgpu') throw codedError('engine-misuse', `createEngine({ renderer }): a name is 'webgl' (the default) or 'webgpu', or pass a three.js renderer object, got ${JSON.stringify(rendererIn)}`);
  const gpu = isWebGPU(r);
  if (gpu) needTsl('yourWebGPURenderer');
  if (DEV && fallback !== undefined && !gpu) warnOnce(coded('engine-misuse', `createEngine({ fallback: ${JSON.stringify(fallback)} }) does nothing here: it only applies with renderer: 'webgpu' or your own WebGPURenderer (WebGLRenderer has nothing to fall back from)`));
  return { requested: gpu ? 'webgpu' : 'webgl', fallback: fallback ?? 'webgl2' };
}


/** pixelSize decides the ratio, so an option asking for something else about it is an error that names which to keep */
function checkPixelSizeOptions(pixelSize, pixelRatio, adaptiveResolution) {
  if (pixelRatio != null) throw codedError('pixel-conflict', `createEngine({ pixelRatio: ${pixelRatio}, pixelSize: ${pixelSize} }): both decide the render resolution. Keep pixelSize for art pixels of one exact size, or pixelRatio for a plain render scale`);
  if (adaptiveResolution === true) throw codedError('pixel-conflict', `createEngine({ adaptiveResolution: true, pixelSize: ${pixelSize} }): adaptive resolution would change the art pixels' size. Keep pixelSize and drop adaptiveResolution`);
}

// Dev note once when createEngine keeps the engine's placeholder lights; lights: false says the game writes its own picture
const NO_PICTURE = 'createEngine(): the placeholder picture is on: a still white sun and hemisphere light with soft shadows, no tone curve, no environment map (see describe().render.defaults), ' +
  'gray background, ground, capsule characters and box props. Not an error, but the game has no picture yet: making the art is part of building the game. ' +
  'A new game writes its picture in picture/ with createEngine({ lights: false }) (recipes/62-picture-code.md)';

export class Engine {
  /**
   * @param o  createEngine options: each option, its default and meaning is documented once on EngineOptions (types/core.d.ts).
   *   ENGINE_PARAMS and the destructuring below must match it.
   */
  constructor(opts = {}) {
    /** @internal first-frame phases (startup.js): when the page's scripts had run and the engine began / finished building */
    this._born = { at: performance.now(), built: 0, start: 0 };   // measure
    /** This engine's dev checks (createEngine({ validate })); another engine on the page does not change it @type {boolean} */
    this.validate = opts.validate !== false;
    /** @internal */ this._untrackValidate = trackValidate(opts.validate);
    const o = readParams('createEngine()', ENGINE_PARAMS, opts);
    /** @internal createEngine options as read (engine.catalog('core').params shows them with the schema) */ this._createParams = o;
    const { canvas: canvasIn, renderer: rendererName, antialias, pixelRatio, pixelSize, adaptiveResolution, targetFps, ui = {}, audio = {},
      fov, near, locale, strings = {}, bindings = {}, saveKey, joystick, blockBrowserKeys,
      headless = new URLSearchParams(location.search).has('threedog-headless'), validate,
      decoders = null, budget = null, urlState = DEV, seed, movement, threads, pauseOnBlur, batching = {}, lights, fallback } = o;
    if (pixelSize != null) checkPixelSizeOptions(pixelSize, pixelRatio, opts.adaptiveResolution);
    // 'webgl' names the default (a WebGLRenderer the engine builds), so it reads like leaving the option out
    const rendererIn = rendererName === 'webgl' ? undefined : rendererName;
    // 'webgpu' is the same road as a game's own WebGPURenderer: built here, then handed on like one (start() inits it, core/engine/startup.js)
    const gpuWanted = rendererIn === 'webgpu';
    const canvas = canvasIn ?? (gpuWanted ? undefined : rendererIn?.domElement);
    this.movement = createMovement(movement);   // character radius / height / slope / step height: the single copy shared by collision, physics and nav
    if (opts.lights !== false) warnOnce(NO_PICTURE);
    // a game-supplied renderer keeps its settings: the engine configures pixel ratio, size, tone mapping and shadows only on a renderer it created itself.
    // One write on every renderer: info.autoReset = false below, because the frame stats count a whole frame, not each render call
    const owned = !rendererIn || gpuWanted;
    this._ownsRenderer = owned;               // dispose() releases the WebGL context only of a renderer the engine built
    if (owned) checkCanvasUsable(canvas);
    // 'low' | 'high': device tier, decides default quality. A headless tool page names its tier (?threedog-tier, core/scene/tier.js): detection would call
    // every headless browser low tier and drop the game's costly post from shots. An engine-built renderer needs it before it exists: MSAA defaults
    // from the tier and is the canvas's own (antialias, fixed when the context is made), so an effect-free frame skips the post chain
    const tierFirst = (headless && forcedTier()) || (owned ? tierBeforeRenderer() : null);
    // pixelSize: hard art pixels are the point, so the default is off
    const authoredAA = antialias ?? (owned ? tierFirst !== 'low' && pixelSize == null : null);
    // the player's choice from the last launch comes here because here is the last moment it can reach the canvas; art pixels stay as they are
    const aa = (owned && pixelSize == null ? storedMsaa(saveKey) : null) ?? authoredAA;
    const r = this.renderer = gpuWanted ? newWebGPURenderer(canvas, aa) : rendererIn ?? new THREE.WebGLRenderer({ canvas, antialias: aa, powerPreference: 'high-performance' });
    /** @internal what the game asked for and what to do without WebGPU; start() fills describe().renderer from it */
    this._backendWant = rendererWant(r, rendererIn, fallback);
    // the engine made this device's renderer, so its limits are the engine's to ask for (start() fills them from the adapter); a game's own renderer keeps the game's
    if (gpuWanted) this._backendWant.limits = r.backend?.parameters?.requiredLimits;
    watchNodePrograms(r);                      // WebGPU: generated code per material, for debug.view('shaderCost') (render/backend.js)
    this._records = recordSweep(r);            // WebGPU: meshes that left the scene free their records (render/recordSweep.js)
    if (isWebGPU(r)) dressNodeTwins(r);        // WebGPU: classic materials get their patches as nodes (render/patches.js)
    nameShaderErrors(r);                       // compile errors name the patch and slot (render/shaderErrors.js); a game's own handler stays
    this._deviceTier = tierFirst || detectTier(r);
    /** @internal real screen pixels per art pixel, null when off (core/scene/pixelRatio.js) @type {number | null} */ this._pixelSize = null;
    if (owned || pixelRatio != null) firstRatio(r, this._deviceTier, pixelRatio);
    this._autoSize = undefined;                // decided once the canvas is in the page (sizeMode): true = no CSS size, the engine sizes it to the window
    const box = canvasBox(this);
    if (owned) r.setSize(box.w, box.h, !!this._autoSize);
    r.info.autoReset = false;

    this.scene = new THREE.Scene();
    /** @internal the neutral background a scene starts with: describe().render.defaults, and the reference a sky compares with @type {any} */ this.baseBackground = new THREE.Color(0x8c8c8c);
    /** @internal */ this.baseBackgroundHex = this.baseBackground.getHex();
    this.scene.background = this.baseBackground;
    this.stacks = new Stacks(this);   // shared points: before the lights, whose shadow size reads engine.tier, and the first engine.shadows / engine.post point
    /** Placeholder lights { sun: DirectionalLight, hemi: HemisphereLight }: neutral and still; createEngine({ lights: false }) leaves them out of the scene @type {{ sun: any, hemi: any }} */
    this.lights = createDefaultLights(this, { add: lights !== false });
    // the engine's own renderer gets soft shadows by default; tone curve and environment stay three.js's defaults
    defineShadows(this, { owned });   // engine.shadows: master switch, cascades, box, budget on the lights a game hands in (render/shadows.js)
    recordRender(this, { owned });   // baseline for describe().render (after the shadow defaults are written): which values the engine set
    // Dev server only. A bundled build (npm test, threedog shot, release) is one minified file, so a stack there names assets/index-x.js:1 for every value: a
    // wrong answer. Written as the literal, not DEV_SERVER: only the literal folds at build time, so the tracker leaves a release bundle altogether
    // @ts-ignore Vite's import.meta.env (undefined outside Vite)
    if (import.meta.env?.DEV) installPictureWriters(this);
    this._camera = new THREE.PerspectiveCamera(fov, box.w / box.h, near, 1500);
    /** @internal { camera, home }: the orthographic camera a rig's projection swapped in, and the camera it stands in for (setProjection, core/scene/view.js) */ this._ortho = null;
    this._camera.position.set(0, 10, 20);
    this.focus = new THREE.Vector3();          // camera focus (updated by the camera module): the view loads around it; simulation follows world.anchor
    this.ground = flatGround;
    this.player = null;
    /**
     * World record id of the one the local user controls (default 'player'): interactions, trigger zones, markers and ops (ctx.actor) use it. Set it to hand
     * control to a vehicle or squad member @type {string}
     */
    this.actor = 'player';
    /**
     * Where the engine is in its life, the one state every "may this run yet" check reads: 'constructed' (createEngine done, start() not called)
     * -> 'starting' (start() running: modules init; frame hooks run, fixed steps do not, so no game time passes) -> 'loading' (the same, assets and the world build)
     * -> 'ready' (the world is built: fixed steps run, engine:ready fires, the new-game state is captured) -> 'running' (start() resolved)
     * -> 'disposed'. @type {'constructed' | 'starting' | 'loading' | 'ready' | 'running' | 'disposed'}
     */
    this.phase = 'constructed';
    /** @internal module name -> handles its install / init passed to ctx.track (removed with the module: modules.js) */ this._modTracked = new Map();
    /** @internal object -> property -> its one ctx.borrow holder (modules.js) */ this._borrowed = new WeakMap();
    /** @internal module name -> the token of its current install: ctx and async init check it (modules.js, a stale init must not act on a newcomer) */ this._modInst = new Map();
    this._abort = new AbortController();
    // attach DOM listeners to it: addEventListener(type, fn, { signal: engine.signal }); dispose cancels them together
    this.signal = this._abort.signal;
    this.uiRoot = document.createElement('div');   // engine and module UI elements live here (not on body); dispose removes the whole root
    // the UI root sits right after the canvas and covers exactly its box (placeUI): HUD, windows and prompts line up with the canvas
    // whether it fills the window, sits in a page section, a split layout or an editor panel
    this.uiRoot.className = 'threedog-root';
    if (r.domElement.parentElement) r.domElement.after(this.uiRoot); else document.body.appendChild(this.uiRoot);
    this.headless = headless;
    this.halted = headless;                    // while halted the real-time loop does not advance; only step() does
    this.fps = 0;
    /** How far the drawn frame is from the last fixed step to the next, 0-1 (real loop); 1 after step(). Holds still while frozen. For drawing fixed-step state smoothly: prev + (now - prev) * stepBlend */
    this.stepBlend = 1;
    /** @internal the picture check is rendering (tools/picture/check.mjs): what it changes and puts back is not the game's */ this._probing = false;
    /** @internal the tools' one way in (rule R68) */ this._tools = toolDoor(this);
    /** @internal */ this._cpuMs = 0;                            // main-thread ms of the last real-time frame; _cpuPhases splits it (loop.js); read through engine.inspect.perf() and engine.budget
    /** @internal */ this._cpuPhases = { fixed: 0, frame: 0, render: 0, afterRender: 0 };
    this._openWindows = new Set();              // ids of open windows (for describe)
    this.modules = new Map();
    this._modState = new Map();                // module name -> registered | initializing | running | failed | disposed (modules.js)
    /** @internal module name -> what it waits for: [{ requires, module, state }], derived from _modState (modules.js) */ this._modBlocked = new Map();
    /** @internal installs (engine._modInst tokens) whose critical block was already reported */ this._modFatal = new WeakSet();
    this.waterBodies = [];
    clearHooks(this);
    this._hookErrors = new Set();              // places that already reported an error (once per place, see errors.js)
    this.error = null;                         // gameplay error in dev/test: { where, message, cause?, docs? }; gameplay is frozen (see errors.js)
    /**
     * This engine's shader uniforms (uTime, uWind, uWeatherCloud, season tints...); share these objects in your own ShaderMaterial or patch @type
     * {import('../../types/core').EngineUniforms}
     */
    this.uniforms = createUniforms();
    bindUniforms(r, this.uniforms);             // built-in shader effects read this engine's uniforms when compiled by this renderer
    defineView(this);                           // engine.autoView: manual() for camera.far / fov / pixel ratio / camera pose the engine changes on its own (core/scene/view.js)
    defineTerms(this);                          // engine.shaderTerms: the game's own cloud shadow or season tint in place of the engine's (render/terms.js)
    this._materials = registerEngine(this);    // applyEffects without an engine option uses the first live engine

    createServices(this, { canvas: r.domElement, validate, locale, strings, saveKey, joystick, blockBrowserKeys, bindings, audio, decoders, budget, seed, headless, urlState, threads, batching });
    this.startup = null;                       // startup timing report (set once start() finishes)
    this._readyAt = null;                      // set at ready until the first frame is drawn (loop.js firstFrame)
    this._whileCompiling = [];                 // @internal one-time warm-ups a module queues during loading; start() runs them while the GPU compiles
    this._playTiming = false;                  // set at the first settled frame after ready, when timing is cleared of start-up (loop.js startPlayTiming)
    this._prof = null;                         // module hook timing: on in dev builds (a few performance.now() per hook), profile(true) turns it on in production
    if (DEV) this.profile(true);
    this._afterTick = null;                    // at startup, checked once at the end of each frame for readiness
    // a game's own renderer keeps its own MSAA choice by default (used as is, like its pixel ratio)
    this.post = new PostFX(this, { antialias: aa ?? ownMsaa(r), authored: authoredAA ?? ownMsaa(r) });
    this.occlusion = new Occlusion(this);      // off until the game turns it on (render/occlusion.js)
    this._uiStyle = applyUITheme(this, ui);    // theme variables and the game's CSS; removed on dispose
    this.ui = new UIParts(this, ui);           // UI parts: every piece of screen UI is replaceable or off (ui/Parts.js)
    defineCoreParts(this);
    this.ui.get('loading')?.show({});
    const adaptiveOn = adaptiveResolution && !headless;
    this.adaptive = createAdaptive({ on: adaptiveOn, target: targetFps, max: r.getPixelRatio(), held: () => pixelSizeOn(this) });
    this._gpu = adaptiveOn ? new GpuTimer(timerContext(r)) : null;   // GPU frame time for adaptive resolution where the browser offers the timer query
    // follow the canvas's own CSS box, not the window: a canvas in a page section or editor panel renders at its own size.
    // The window event stays for a canvas outside the page (no box, falls back to the window) and for moves that do not resize the canvas
    addEventListener('resize', () => this._resize(), { signal: this.signal });
    this._unhandled = null; watchRejections(this);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(([entry]) => { noteDeviceBox(this, entry); this._resize(); });
      try { ro.observe(r.domElement, { box: 'device-pixel-content-box' }); } catch { ro.observe(r.domElement); }   // Safari rejects the box name
      this.signal.addEventListener('abort', () => ro.disconnect());
    }
    placeUI(this);
    if (pixelSize != null) this.setPixelSize(pixelSize);
    this.page = new Page(this, { pauseOnBlur });   // window focus, tab visibility, mouse lock, WebGL context: handled only there
    this._born.built = performance.now();   // measure
  }

  /**
   * The camera the engine draws with. Assign a real THREE.PerspectiveCamera or THREE.OrthographicCamera to draw through it: rendering, post, picking, shadows, audio and an
   * installed rig all go on with it. Its aspect follows the canvas unless the game took engine.autoView 'aspect'. Keep the first value to swap back. Any other class is refused.
   * @example const own = engine.camera; engine.camera = new THREE.OrthographicCamera(-16, 16, 9, -9, 0.1, 500); engine.camera = own;
   * @type {import('three').PerspectiveCamera | import('three').OrthographicCamera}
   */
  get camera() { return this._camera; }
  set camera(cam) {
    const old = this._camera;
    if (cam === old) return;
    checkCamera(cam);
    cam.coordinateSystem = old.coordinateSystem;   // the renderer's depth range: three sets it at the first draw, and a pick before that needs it too
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    this._camera = cam;
    movedOwned(this, new Map([[old, cam], [old.position, cam.position], [old.quaternion, cam.quaternion]]));
    const c = this.renderer.domElement;
    this._oAspect.drive(c.width / c.height);   // the buffer, as a resize leaves it: with pixelSize it is not the canvas box
  }

  get waterLevel() { return this.ground.waterLevel; }
  /** The one quality value, 'low' | 'high', what everything that scales by quality reads: the device's tier, unless the player's preset says otherwise (shared point 'tier') @type {'low' | 'high'} */
  get tier() { return this.stacks.has('tier') ? this.stacks.get('tier').value() : this._deviceTier; }
  /** The device's tier, the base under a player's preset */
  set tier(t) {
    this._deviceTier = t;
    const st = this.stacks.has('tier') ? this.stacks.get('tier') : null;
    if (st && st.base !== t) { st.base = t; st._changed(); }   // through the stack's change path: onTierChange followers (post, cascades) run once; writing base alone told nobody
  }
  /** True once the world is built (phase 'ready' or 'running'): fixed steps, ops and rendering run from here on @type {boolean} */
  get ready() { return this.phase === 'ready' || this.phase === 'running'; }
  /** @internal start() is on its way: no game time passes */
  get _inStart() { return this.phase === 'starting' || this.phase === 'loading'; }
  /** @internal the modules at start() have had their init, so one installed now runs its own at once */
  get _initsDone() { return this.phase !== 'constructed' && this.phase !== 'starting'; }
  /** True after dispose() @type {boolean} */
  get disposed() { return this.phase === 'disposed'; }

  // ---------- common ----------
  /** Get a UI string (i18n) */
  t(key, params) { return this.i18n._t(key, params); }
  /** Ray cast: the nearest hit or null, see Rays.js */
  raycast(origin, dir, opts) { return this.rays._ray(origin, dir, opts); }
  /** Cast a ray from screen coordinates (-1..1) */
  pick(ndcX, ndcY, opts) { return this.rays._rayAt(ndcX, ndcY, opts); }
  /** Set up a scenario: { time, weather, pos, at, save, wait, cutscene, state }, see UrlState.js */
  applyState(params) { return this._urlState.apply(params); }
  /**
   * Scenario ready: start() has finished, the URL parameters / latest applyState are applied, and (headless) a load begun after start has settled
   * (tests and screenshots wait for it; core/engine/headlessLoad.js)
   */
  get stateApplied() { return this.ready && this._urlState.applied && headlessSettled(this); }
  /** What the URL parameters or the latest applyState could not do: [{ key, value, reason }], e.g. ?weather=typo. Read it after stateApplied @type {{ key: string, value: any, reason: string }[]} */
  get stateRefused() { return this._urlState.refused; }
  /**
   * Name a set of scenario parameters, then use applyState({ state: name }) or the URL ?state=name. Returns a handle: remove() forgets the name
   * @param {string} name @param {import('../../types/core').StateParams} params @param {{ owner?: string }} [opts]
   * @returns {{ owner?: string, remove(): void }}
   */
  defineState(name, params, opts) { return this._urlState.define(name, params, opts); }
  /**
   * Fixed-step logic (60 per second): movement, timers, gameplay keys. dt is real seconds (always 1 / 60) unless { channel } names a time channel:
   * then dt is that channel's scaled dt (bullet time slows it). Returns a handle { remove() }
   * phase (order is declared, never "which line registered first"): 'early' (default) runs before every module fixed hook, so the player has not
   * moved yet this step; 'late' runs after all modules (player moved, physics stepped) and before the clock: hit checks, reading this step's result.
   * @example engine.onFixed(dt => moveEnemies(dt), { channel: 'enemies' })
   * @example engine.onFixed(() => checkHits(engine.player.position), { phase: 'late' })
   */
  onFixed(fn, { channel, phase = 'early' } = {}) {
    if (phase !== 'early' && phase !== 'late') throw codedError('engine-misuse', `engine.onFixed(fn, { phase }): phase is 'early' (default, before modules) or 'late' (after modules), got ${JSON.stringify(phase)}`);
    if (channel) this.time._get(channel);   // unknown channel: throw now, not every step
    const f = ownHook(this, channel ? () => fn(this.time.dt(channel)) : fn), key = phase === 'late' ? '_fixedLate' : '_fixed';
    this[key].push(f); return { remove: () => { this[key] = this[key].filter(x => x !== f); } };
  }
  /** Once per frame: animation, camera, UI. Returns a handle { remove() } */
  onFrame(fn) { const h = ownHook(this, fn); this._frame.push(h); return { remove: () => { this._frame = this._frame.filter(f => f !== h); } }; }
  /** @internal An animator's per-frame update: runs after the whole onFrame list (loop.js), so what onFrame asked of it shows the same frame. Returns a handle { remove() } */
  _onAnimate(fn) { const h = ownHook(this, fn); this._animate.push(h); return { remove: () => { this._animate = this._animate.filter(f => f !== h); } }; }

  /**
   * Around the main render, after the camera update and batching: fn({ renderer, scene, camera, dt }). when 'before' (default) runs just before the
   * engine's frame render: render to your own target there (mirror, minimap, portal, picking); the render target is reset afterwards. 'after' runs
   * right after it (read pixels, overlays). The main frame render stays the engine's. A hook that throws has what it borrowed put back (target, viewport, scissor,
   * autoClear, scene.overrideMaterial, camera.layers). Returns a handle { remove() }
   * @param {(ctx: { renderer: any, scene: any, camera: any, dt: number }) => void} fn @param {{ when?: 'before' | 'after' }} [opts]
   */
  onRender(fn, { when = 'before' } = {}) {
    if (typeof fn !== 'function') throw codedError('engine-misuse', `engine.onRender(fn, { when }): fn must be a function, got ${typeof fn}`);
    if (when !== 'before' && when !== 'after') throw codedError('engine-misuse', `engine.onRender(fn, { when }): when must be 'before' or 'after', got ${JSON.stringify(when)}`);
    const h = ownHook(this, fn);
    this._onRender[when].push(h);
    return { remove: () => { this._onRender[when] = this._onRender[when].filter(f => f !== h); } };
  }

  /**
   * @internal Stands in until a camera module is installed (its install replaces engine.setCamera). Why: core cannot install a module (rule 2), and
   * without this a scene with no openWorld / camera module failed with "setCamera is not a function", which names no fix.
   */
  setCamera(kind, opts) {
    const o = opts && typeof opts === 'object' ? `{ ${Object.keys(opts).join(', ')} }` : '';
    throw codedError('camera-none', `engine.setCamera('${kind}'${o ? ', ' + o : ''}) needs a camera module, and none is installed (openWorld({ camera }) `
      + `installs the one you name, camera: false installs none; a bare scene has none): install the kind you want once, engine.use(${kind === 'firstPerson' ? 'firstPersonCamera' : kind === 'rts' ? 'rtsCamera' : kind === 'follow' ? 'followCamera' : 'fixedCamera'}(${o})), `
      + `then setCamera switches between kinds`);
  }

  /** @internal Display name of a module (loading screen): module.<name> from the string table, else the module's own label */
  moduleName(m) { return this.i18n.has('module.' + m.name) ? this.t('module.' + m.name) : (m.label || m.name); }
}

// Mix in by property descriptor (Object.assign would evaluate getters on the spot and lose them)
for (const part of [loopMethods, holdMethods, startupMethods, groundMethods, actorMethods, moduleMethods, lifecycleMethods, skipMethods, checkMethods, resizeMethods, sceneMethods, probeMethods, lightmapMethods])
  Object.defineProperties(Engine.prototype, Object.getOwnPropertyDescriptors(part));
