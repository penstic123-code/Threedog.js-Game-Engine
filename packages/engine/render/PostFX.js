// Post effects in five slots (both renderers). One list for WebGL and WebGPU. The engine owns no picture of its own here: bloom, AO and
// outline are effects the game adds (they come from @threedog/post-effects). Everything gets into the list through ONE call, engine.post.add:
// game code, the plugins folder and a style pack's plugins alike, so every effect has a name, on / off, a describe row and a rollback, whoever added it.
// An effect promises only a name, params and on/off; how it draws is its create() (a three.js Pass under WebGLRenderer) or its
// node() (a TSL node under WebGPURenderer), so callers never see which backend runs.
//
// This file is the backend-free part (list, slots, ownership); the chain itself is postWebGL.js (EffectComposer) or, on WebGPURenderer,
// render/fx/postWebGPU.tsl.js (RenderPipeline). Why the WebGPU side is looked up (render/backend.js webgpuPart) and not imported: importing it here would put
// three/webgpu into every WebGL game's bundle; it registers itself when threedog/tsl loads, the way patchNodes.tsl.js does for patches,
// and stays synchronous (a dynamic import would leave the first frames without post and make _sync async).
import * as THREE from 'three';
import { webglPost } from './postWebGL.js';
import { codedError } from '../core/base/errorHints.js';
import { warnOnce } from '../core/base/validate.js';
import { readParams, keysSchema } from '../core/base/params.js';
import { isWebGPU, webgpuPart, ownMsaa } from './backend.js';
import { MSAA_KEY, onTierChange } from '../core/scene/tier.js';
import { defineOwned } from '../core/ops/owned.js';
import { watchOwnFrame } from './ownFrame.js';
import { runsHere, OUTPUT_TWICE } from './postRuns.js';
/** @import { Engine } from '../types/core' */

/**
 * @typedef {'scene' | 'hdr' | 'tone' | 'ldr' | 'final'} PostSlot
 *   scene: replaces the scene render (one at a time, e.g. a pixelating render); hdr: linear color before tone mapping (bloom, AO,
 *   outline); tone: replaces the engine's tone-mapping output stage (one at a time: an own curve, a filmic grade; it receives linear HDR
 *   color and must output display color, tone mapped AND converted to the output color space, as three's OutputPass / renderOutput do);
 *   ldr: sRGB color after tone mapping (LUT, palette, grain, vignette); final: last of all (FXAA / SMAA).
 * @typedef {(renderer: any, draw: () => any, opts?: { scene?: import('three').Scene, camera?: import('three').Camera, clean?: boolean }) => any} BorrowRenderer
 * @typedef {{ engine: Engine, scene: import('three').Scene, camera: import('three').Camera, width: number, height: number, params: Record<string, any>, borrowRenderer: BorrowRenderer }} PostContext
 *   width / height are in device pixels. borrowRenderer(renderer, draw, { scene, camera, clean }): run draw() with the renderer borrowed, the engine's one
 *   borrow (render/backend.js): target with cube face and mip, viewport, scissor, clear color, autoClear, tone mapping, shadowMap.autoUpdate (and with scene
 *   / camera their overrideMaterial, background, fog, layers) are put back afterwards, also when draw throws. For an effect that draws an extra pass of
 *   its own; its targets and materials stay the effect's. clean (WebGPU): start from three's reset state (no MRT), for a quad drawn inside a node frame.
 * @typedef {{ uniforms?: Record<string, string>, values?: (params: Record<string, any>) => Record<string, any>, glsl: string, reads?: boolean }} PostFuse
 *   A GLSL snippet that colors the pixel; neighboring effects with a fuse run as ONE fullscreen pass. glsl is statements that edit
 *   `vec4 color` (the input pixel so far) and may use vUv, tDiffuse, uTime (s), uResolution (device px) and fxHash(vec2). uniforms
 *   declares extra ones by GLSL type ({ uVigStrength: 'float' }; names must be unique across effects, prefix with the effect name);
 *   values(params) returns their current values. reads: true when the snippet samples tDiffuse at other uvs (blur, color fringe):
 *   it then starts a new group, so it sees the real input.
 *   tsl (WebGPURenderer): (color, uv, t) => color, the same snippet as a TSL expression on the vec4 color node; t holds tsl (three/tsl),
 *   p (a uniform node per number, boolean (0 / 1), color and vector param, live: set() changes .value, no rebuild), input (the image so far, sample it at other uvs with
 *   t.input.sample(uv)), time (s), resolution (device px). Neighbors are chained into one node, so three draws them in one pass.
 * @typedef {{ engine: Engine, scene: import('three').Scene, camera: import('three').Camera, width: number, height: number, params: Record<string, any>,
 *   scenePass: any, buffer: (name: string) => any, tsl: any, fx: Record<string, Function>, display: Record<string, Function>, p: Record<string, any>, borrowRenderer: BorrowRenderer }} PostNodeContext
 *   WebGPU only. scenePass: the scene's pass() node (.getTextureNode('depth'), getViewZNode() ...); buffer(name): a needsBuffers output as a texture node
 *   ('normal' | 'diffuse' | 'velocity' | 'metalRough', the last as .x metalness, .y roughness: it may share velocity's target, so read it here, not from scenePass); tsl: three/tsl; display: three's display nodes (bloom, ao from three/addons/tsl/display) plus
 *   pass (an extra scene render), texture (the color so far as a texture to sample at other uvs) and own (a node the effect made itself, disposed with the chain),
 *   handed in so the main entry of an effect package never imports three/webgpu (its /tsl subpath may, a WebGL game never loads that) and so the nodes they make are disposed with the chain;
 *   fx: the threedog/tsl functions (noise, hash ...), handed in for the same reason;
 *   p: live uniform nodes of the number, boolean (0 / 1), color and vector params (as in PostFuse tsl), so set() of those never rebuilds the pipeline; a param read from
 *   ctx.params while node() runs is a constant in the graph, so set() of it rebuilds the chain (as WebGL rebuilds an effect without update()).
 * @typedef {{ name: string, create?: (ctx: PostContext) => object, node?: (input: any, ctx: PostNodeContext) => any, fuse?: PostFuse, slot?: PostSlot | (string & {}), order?: number, enabled?: boolean,
 *   needsDepth?: boolean, needsBuffers?: ('normal' | 'diffuse' | 'velocity' | 'metalRough')[], backend?: 'webgpu', skipOnLowTier?: boolean, cheaper?: Record<string, any>, facts?: () => Record<string, any> | null, about?: Record<string, any>,
 *   params?: Record<string, any>, update?: (impl: any, params: Record<string, any>) => void }} PostEffect
 *   An effect as data, the form post.add() takes. node (WebGPURenderer): returns the effect's output color node built on input (the color node so far); called again only when a param
 *   that is not a number, boolean, color or vector changes (those are live in ctx.p). An effect with only create cannot run on WebGPURenderer (it throws by name).
 *   create: builds the implementation the first time the effect is on (WebGL: a three.js postprocessing Pass); optional when fuse is given.
 *   fuse: see PostFuse; effects with a fuse in the same slot next to each other are merged (never in slot 'scene'), their params
 *   update in place (no update() needed).
 *   slot: a PostSlot; typed as any string too because a slot in a plain JS object (an effect returned from a function) is a string to
 *   TypeScript, and the chain throws on an unknown slot naming the valid ones.
 *   order: position inside the slot, low first; ties keep the order the names were first added in (a name keeps that place when it is
 *   switched off and on, or a plugin is unplugged and plugged again: handle.enabled = false pauses it in place).
 *   needsDepth: the scene's depth texture is kept for it (readBuffer.depthTexture). Only the buffer the scene render wrote holds
 *   scene depth, so a depth reader must run before any pass that swaps buffers (needsSwap, e.g. a ShaderPass, a scene-slot
 *   RenderPixelatedPass, or the tone-mapping output); the chain throws when it would not. A pass that writes the scene depth into its own output (gl_FragDepth, then set pass.keepsDepth = true; dof does) does not count as a swap. update: apply new params in place;
 *   without it set() rebuilds the implementation.
 *   needsBuffers (WebGPU): extra outputs of the one scene render, merged across every effect that is on, so two effects never overwrite each other's setMRT:
 *   'normal' (view space, raw), 'diffuse' (surface color), 'velocity' (a temporal resolve follows, so the scene pass runs without MSAA), 'metalRough' (metalness, roughness).
 *   More targets than the device takes (WebGPU's default: 32 bytes per pixel, four with the color) throws naming the effects.
 *   backend: 'webgpu' = needs three's WebGPU backend itself (storage textures; WebGPURenderer on its WebGL2 backend cannot run it, so it is held there).
 *   skipOnLowTier: the effect's own statement that engine.tier 'low' is too weak for it. The rule: an effect declares this itself and the engine only follows the declaration; no list of
 *   expensive effects lives in the engine, and an effect that does not declare it runs on every tier. A held effect costs nothing, describe().render.post says why in `held`, the console says it once; the game's enabled stays as written.
 *   cheaper: the effect's own cheaper params ({ quality: 0.25 }), the first step adaptive quality takes under load before the resolution (core/scene/adaptive.js); only
 *   params that change in place belong here (live uniforms, or WebGL update()): a param that rebuilds the chain would cause the hitch the step is meant to cure. A declared
 *   skipOnLowTier is the ladder's last step: the effect held off. Neither is a list in the engine; the game reorders or drops them with engine.adaptive.steps.
 *   facts: read by describe().render.post (a voxel size, what the effect still misses).
 *   about: what the picture menu (engine.catalog('picture')) prints for it: { cost, on, recipe, limits, webgpuOnly?, acts? } (acts: 'glow' | 'exposure' | 'ao', what the combination checks, the settings rows and photo read in place of a name); @threedog/post-effects puts the same object on each factory as fn.about.
 * @typedef {{ readonly name: string, readonly slot: PostSlot, readonly order: number, enabled: boolean, readonly params: Record<string, any>,
 *   set(params: Record<string, any>): void, remove(): void }} PostHandle
 *   What add() and get() return. enabled reads what runs now; writing it is the game's choice on the shared point post.<name>.enabled, so a settings
 *   restriction above it still holds it off. set: params by name, unknown names throw. remove: takes it out of the chain (a game's own Pass is not disposed).
 *   A RenderPass or OutputPass handed to add() gives { name: null, ... }: the engine's own stages stand in for them, so only remove() does anything.
 */

const SLOTS = ['scene', 'hdr', 'tone', 'ldr', 'final'];
// slots one effect at a time: each replaces an engine stage (the scene render, the tone-mapping output), two replacements of one stage cannot both run
const EXCLUSIVE = { scene: 'replace the scene render', tone: 'replace the tone-mapping output' };
const ADD_KEYS = ['name', 'slot', 'order'];

export class PostFX {
  /**
   * @param {Engine} engine
   * @param {{ antialias?: boolean }} [opts]
   * @internal
   */
  constructor(engine, { antialias = true, authored = antialias } = {}) {
    /** @internal */ this.engine = engine;
    /** @internal */ this._aa = antialias;
    /** @internal the antialias this game starts with when the player chose nothing: what a settings row goes back to */ this.authoredAA = authored;
    /** @internal */ this._list = /** @type {any[]} */ ([]);
    // effect name -> its tie-break place in a slot, given the first time the name is added (or reserved by engine.plugins in plugin order).
    // Why kept across remove: plugins.off then on re-added the effect at the end, so A, B with no order of their own came back B, A (review 2026-11-03)
    /** @internal */ this._seq = new Map();
    /** @internal names engine.plugins reserved: their place outlives a remove (plugins.off); a game handle's remove() frees any other name's place */
    this._kept = new Set();
    /** @internal */ this._seqN = 0;
    /** @internal start() replaced a WebGPURenderer with WebGLRenderer on a device without WebGPU */ this._fellBack = false;
    /** @internal the game's plain passes and OutputPass markers in add order: which side of a marker a pass is on decides hdr or ldr */
    this._plain = /** @type {any[]} */ ([]);
    /** @internal */ this._autoN = 0;
    /** @internal EffectComposer, built the first time anything is on */ this.composer = /** @type {any} */ (null);
    /** @internal the chain's backend: postWebGL.js, or the WebGPU one threedog/tsl registers */ this._be = backendFor(engine.renderer);
    /** @internal the renderer's own MSAA on its canvas (fixed when it was made; the engine makes it with the default antialias) */ this._ownAA = ownMsaa(engine.renderer);
    this._be.init(this);
    /** @internal the camera the built chain draws with */ this._camera = engine.camera;
    watchOwnFrame(engine);   // a game that renders the canvas itself (own EffectComposer) takes the frame; the loop yields (ownFrame.js)
    // own(): the game takes the built chain (composer passes / pipeline.outputNode) and the engine stops rebuilding it; handing it
    // back rebuilds from the list. read is a constant: a direct write to object() is not a takeover (the next chain change replaces it)
    /** @internal */ this._own = defineOwned(engine, { id: 'post.chain', part: 'post', key: 'chain', read: () => 0,
      // handed back: the kept WebGPU stages go too, the game may have edited those nodes while it owned them, so the declared chain is rebuilt whole
      levels: { manual: 'engine.post.own()' }, onChange: o => { if (!o.on) return; if (this._pipe) { this._pipe.key = null; this._pipe.stages = []; } this._sync(); } });
    this._sync();
    onTierChange(engine, () => this._sync());   // effects held by tier (skipOnLowTier) follow it; after the first sync, so a throw there leaves no listener
  }

  /**
   * MSAA on or off in the post chain's render targets, for what runs through the chain. It is a render setting, not a drawing part. With no effect on nothing runs through the chain:
   * the canvas's own MSAA shows, fixed when the context was made (createEngine({ antialias })).
   * @example engine.post.antialias = false;
   * @type {boolean}
   * @experimental
   */
  get antialias() { return this._aa; }
  set antialias(on) {
    if (!!on === this._aa) return;   // a game writing its settings each frame writes the same value: nothing to rebuild (GPT review l2-render 4)
    this._aa = !!on;
    this._be.setAntialias(this, this._aa);
    this._sync();
  }
  /**
   * @internal A player's choice for the next launch. MSAA is fixed with the canvas, so a row that changed it live would have to switch the whole post chain on to do it, and the cheap
   * preset cost more than the middle one. createEngine reads it before the renderer exists (core/scene/tier.js storedMsaa); the same value as the game's own is no choice to store.
   * @param {boolean} on
   */
  nextAntialias(on) {
    const key = this.engine.saves.storageKey(MSAA_KEY);
    try { if (!!on === this.authoredAA) localStorage.removeItem(key); else localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage blocked: the settings file has the row, this launch runs as it is */ }
  }
  /**
   * Whether the post chain runs: an effect is on
   * @returns {boolean}
   */
  get active() { return this._list.some(e => e.enabled); }

  /**
   * What the chain runs in, for reading, or null while no post work has run yet (built the first time an effect is on; it is not built here, so asking never costs a
   * render target). WebGLRenderer: the three.js EffectComposer (pass list, sizes, its targets). WebGPURenderer: { pipeline, scenePass }, three's RenderPipeline and the scene's pass() node. Read-only by rule, not by lock:
   * the engine owns it, rebuilds the chain whenever the list changes and disposes it with the engine. To add a pass use post.add,
   * to own the whole chain post.own() (recipe 52). Why public: a game reading the chain had to dig into an internal field (review 2026-11-03)
   * @returns {any}
   * @experimental
   */
  object() { return this._be.object(this); }
  /**
   * The composer's render targets, for reading (sample the last frame's color or depth in a game pass, check formats / samples), or null while
   * there is no composer, and always on WebGPURenderer (its pass nodes own their targets: post.object().scenePass). renderTarget1 / renderTarget2 are the ping-pong pair. During the chain readBuffer is a pass's input and writeBuffer its
   * output; EffectComposer swaps them after every pass with needsSwap (most passes; the scene RenderPass does not). The last pass draws to the
   * canvas and still swaps, so after the frame (engine.onRender(fn, { when: 'after' })) neither target holds the final picture: writeBuffer holds
   * the input of that last pass (readBuffer when the last pass does not swap) and readBuffer is stale. For the final image, render into a target of your own.
   * Owned by the engine like object(): it resizes them, changes samples when antialias is written and adds a depth texture when an effect needs depth;
   * do not dispose them or swap their textures. A target of your own: new THREE.WebGLRenderTarget in onRender (THREE.md)
   * @returns {{ renderTarget1: any, renderTarget2: any, readBuffer: any, writeBuffer: any } | null}
   * @experimental
   */
  targets() { return this._be.targets(this); }

  /**
   * The one way to add a post effect. x is a three.js Pass (WebGL), a TSL node function (input, ctx) => node (WebGPU), or an effect
   * { name, create | node | fuse, slot, order, params, needsDepth, needsBuffers, backend, skipOnLowTier, cheaper, facts } (both renderers when it gives create and node, or a fuse). A wrong shape throws with nothing added.
   * needsDepth, needsBuffers ('normal' | 'diffuse' | 'velocity' | 'metalRough', WebGPU), backend ('webgpu': not on the WebGL2 backend), skipOnLowTier (held when engine.tier is 'low') and facts (shown by describe().render.post) are explained on PostEffect.
   * A Pass that draws engine.scene takes the 'scene' slot, FXAA / SMAA / TAA 'final', any other 'hdr' after the effects already there, or 'ldr' once an
   * OutputPass was added. A RenderPass of engine.scene and an OutputPass are the engine's own stages: skipped and said once (an OutputPass still marks where display color starts).
   * @example const glow = engine.post.add(new UnrealBloomPass(size, 0.6, 0.4, 0.85), { name: 'glow' }); glow.enabled = false;
   * @example engine.post.add({ name: 'dim', fuse: { glsl: 'color.rgb *= 0.9;' }, slot: 'ldr' });
   * @param {any} x @param {{ name?: string, slot?: PostSlot | (string & {}), order?: number }} [o]
   * @returns {PostHandle}
   */
  add(x, o = {}) {
    readParams('engine.post.add(x, opts)', keysSchema(ADD_KEYS), o);
    const def = effectOf(this, x, o);
    if (!def) return skipped(() => {});   // a RenderPass of engine.scene: the engine's own, skipped, said once
    // the add order of plain passes and the game's OutputPass markers: a pass after an OutputPass runs on display color (reslot)
    const plain = this._plain;
    if (def.output) {   // OutputPass: only marks where display color starts; removing it puts the later passes back before tone mapping
      const m = { output: true }; plain.push(m); reslot(this);
      return skipped(() => { const i = plain.indexOf(m); if (i >= 0) { plain.splice(i, 1); reslot(this); } });
    }
    const h = this._add(def);
    if (def._auto) plain.push(h._entry = { def });
    return h;
  }
  /** @internal */
  _add(effect) {
    if (this.get(effect.name)) throw codedError('post-effect', `post effect '${effect.name}' is already added; change it with engine.post.get('${effect.name}').set({ <param>: value }), give this one another name (add(x, { name })), or drop the first with its handle.remove()`);
    const s = effect.slot ?? 'hdr';
    if (!SLOTS.includes(s)) throw codedError('post-effect', `post effect '${effect.name}': unknown slot '${s}', use ${SLOTS.join(' | ')}`);
    if (effect.fuse && s === 'scene') throw codedError('post-effect', `post effect '${effect.name}': a fuse snippet colors an existing image, it cannot replace the scene render; use slot 'hdr' | 'ldr' | 'final'`);
    const other = s in EXCLUSIVE && this._list.find(e => e.slot === s);
    if (other) throw codedError('post-effect', `post slot '${s}' already holds '${other.name}'; remove it first (only one effect can ${EXCLUSIVE[s]})`);
    const odd = Object.keys(effect.cheaper ?? {}).filter(k => !(k in (effect.params ?? {})));
    if (odd.length) throw codedError('post-effect', `post effect '${effect.name}': cheaper names ${odd.join(', ')}, not in its params (${Object.keys(effect.params ?? {}).join(', ') || 'none'}); cheaper holds lower values of its own params`);
    const post = this, point = this.switchPoint(`post.${effect.name}.enabled`);
    point.release('game'); point.base = effect.enabled ?? true;   // only the game's own word starts over: the player's off and any other owner's hold stay on the effect that comes back
    let on = !!point.value();
    const h = {
      name: effect.name, slot: s, order: effect.order ?? 0, seq: this._place(effect.name),
      params: { ...effect.params }, _def: effect, _impl: /** @type {any} */ (null), _removed: false, _entry: /** @type {any} */ (null), _on: () => on,
      get enabled() { return on && !post._held(h); },
      set enabled(v) {
        if (typeof v !== 'boolean') throw codedError('post-effect', `post effect '${h.name}': enabled is true or false, got ${JSON.stringify(v)}`);
        if (h._removed) return;   // a stale handle: a later effect of this name has its own switch
        const was = point._map()?.get('game')?.value;
        // the chain rebuild runs inside take and may throw (a create() that fails, an order that breaks depth): the game's entry goes back with it
        try { point.take({ owner: 'game', set: v }); } catch (err) { if (was === undefined) point.release('game'); else point.take({ owner: 'game', set: was }); throw err; }
      },
      set(p) {
        if (h._removed) return;
        const unknown = Object.keys(p ?? {}).filter(k => !(k in h.params));
        if (!p || typeof p !== 'object' || unknown.length) throw codedError('post-effect', `post effect '${h.name}': set(params) takes ${Object.keys(h.params).join(', ') || 'nothing, it has no params'}; unknown: ${unknown.join(', ') || JSON.stringify(p)}${unknown.includes('enabled') ? ' (on / off: handle.enabled = false)' : ''}`);
        const changed = Object.fromEntries(Object.entries(p).filter(([k, v]) => h.params[k] !== v));
        if (!Object.keys(changed).length) return;
        const was = Object.fromEntries(Object.keys(changed).map(k => [k, h.params[k]]));
        try { h._apply(changed); } catch (err) { h._apply(was); throw err; }
      },
      _apply(p) {
        Object.assign(h.params, p);
        if (post._be.set?.(post, h, p)) return;   // WebGPU: live uniforms, or a rebuild of the node graph
        if (effect.fuse) { post._be.refresh(post, h); return; }
        if (!h._impl) return;
        if (effect.update) effect.update(h._impl, h.params); else { freeImpl(h); post._sync(); }
      },
      remove() {
        if (h._removed) return;
        h._removed = true;
        point.onChange = null; point.release('game');
        freeImpl(h);
        post._list = post._list.filter(e => e !== h);
        if (!post._kept.has(h.name)) post._seq.delete(h.name);   // removed for good: a later effect of that name starts at the end (plugins keep theirs)
        const i = post._plain.indexOf(h._entry); if (i >= 0) post._plain.splice(i, 1);
        post._sync();
      },
    };
    // a settings restriction or a hold ending turns it on or off here; a rebuild that throws leaves it as it was
    point.onChange = () => { const was = on, now = !!point.value(); if (now !== was) this._change(() => { on = now; }, () => { on = was; }); };
    // a create() that throws or an order that breaks depth leaves no half-added effect behind
    try { this._change(() => this._list.push(h), () => { freeImpl(h); this._list = this._list.filter(e => e !== h); }); }
    catch (err) { point.onChange = null; if (!this._kept.has(h.name)) this._seq.delete(h.name); throw err; }
    this.engine._picture?.added('post effect', h, h.name);   // dev: a picture part removed with this still on is reported (core/inspect/pictureWriters.js)
    this.engine.events.emit('post:add', h.name);   // the settings rows follow an effect by its role, so one added after them still gets the player's choice
    return h;
  }
  /**
   * Why an effect the game has on does not run now, or null (an effect the game has off is simply off). Held, not switched off: the game's value stays, so a device or tier change gives it back.
   * The words separate what the device did from what the game chose: on a WebGLRenderer the game picked, a node-only effect is a mistake, so it is not held and postWebGL's sync throws it by name.
   * @param {any} h @returns {string | null} @internal
   */
  _held(h) {
    if (!h._on()) return null;
    const w = runsHere(h._def, this.engine);
    if (!w?.held) return null;   // a mistake (node-only effect on the game's WebGLRenderer) is not held: postWebGL's sync throws it by name
    warnOnce(`post effect '${h.name}' held off: ${w.why}`);
    return w.why;
  }
  /**
   * What antialiases the picture now: the samples really in effect, and the effect standing in for MSAA (asking for 'velocity' means a temporal resolve, so the scene pass runs without samples).
   * @returns {{ samples: number, replacedBy: string | null }} @internal
   */
  _antialiasNow() {
    const samples = this._be.samples(this);
    return { samples, replacedBy: this._aa && !samples ? this._list.find(e => e.enabled && e._def.needsBuffers?.includes('velocity'))?.name ?? null : null };
  }
  /**
   * The shared point of an effect's switch ('post.<name>.enabled'), made on first asking. It outlives the effect (the registry has no delete) and may come before it: settings installs before
   * the game's boot code adds its effects, and add() starts under whatever is held here. @param {string} id @internal
   */
  switchPoint(id) {
    const S = this.engine.stacks;
    return S.has(id) ? S.get(id) : S.define(id, { kind: 'value', base: true, save: false });
  }
  /**
   * An added effect's handle (as add() returns it), or undefined.
   * @example engine.post.get('bloom').set({ strength: 0.6 });
   * @param {string} name
   * @returns {PostHandle | undefined}
   */
  get(name) { return this._list.find(e => e.name === name); }
  /**
   * The added effects that declare this role in about.acts ('glow', 'ao', 'exposure'): found by what they do, never by name; the settings rows and
   * photo follow every one of them. Only when NO effect declares the role does the effect named `name` stand in (a game's own 'bloom' written before
   * roles existed); with no `name` that case gives [].
   * @param {string} role
   * @param {string} [name] fallback effect name
   * @returns {PostHandle[]}
   * @experimental
   */
  byRole(role, name) { const by = this._list.filter(h => h._def?.about?.acts === role); return by.length || !name ? by : this._list.filter(h => h.name === name); }
  /**
   * Hand the built chain to the game: the engine stops rebuilding it, so the composer's passes (post.object().passes) or the WebGPU pipeline's
   * outputNode are the game's to edit. own(false) gives it back and rebuilds from the list. describe().owned shows who has it.
   * @example engine.post.own(); engine.post.object().passes.reverse();
   * @param {boolean} [on]
   * @returns {void}
   * @experimental
   */
  own(on = true) { this._own.manual(!!on); }
  /**
   * Effects in render order: [{ name, slot, order, enabled }]
   * @returns {{ name: string, slot: PostSlot, order: number, enabled: boolean }[]}
   */
  list() { return this._sorted().map(({ name, slot, order, enabled }) => ({ name, slot, order, enabled })); }

  /** @internal */
  _sorted() { return SLOTS.flatMap(s => this._list.filter(e => e.slot === s).sort((a, b) => a.order - b.order || a.seq - b.seq)); }
  /** The tie-break place of an effect name, given on first use and kept (engine.plugins reserves its effects' names in plugin order) @internal */
  _place(name, keep = false) { if (keep) this._kept.add(name); if (!this._seq.has(name)) this._seq.set(name, this._seqN++); return this._seq.get(name); }
  /** @internal */
  _size() { return this.engine.renderer.getSize(new THREE.Vector2()).multiplyScalar(this.engine.renderer.getPixelRatio()); }
  /** Apply a list change, rebuild the chain, and undo the change when the rebuild throws (then rethrow) @internal */
  _change(apply, undo) {
    apply();
    try { this._sync(); } catch (err) { undo(); this._sync(); throw err; }
  }
  // Rebuild the chain from the list (the backend does it)
  /** @internal */
  _sync() {
    if (!this.composer && !this._pipe && !this.active) return;
    if (!this._own.on && (this.composer || this._pipe)) return;   // the game owns the built chain (own())
    this._be.sync(this);
  }

  /**
   * Dispose the composer, every effect and the render targets (called by engine.dispose)
   * @internal
   */
  dispose() {
    for (const e of this._list) freeImpl(e);
    this._be.dispose(this);
  }
  /**
   * @internal The target the scene is drawn into this frame, for start()'s compileAsync: three keys a program by its output (the canvas gets tone
   * mapping + sRGB, a render target gets neither), so compiling for the canvas while the composer draws into its half-float target compiled
   * variants no frame used and the first frame compiled everything again. Builds the composer now when post is on; null when drawing straight to the canvas.
   * @returns {any}
   */
  _sceneTarget() {
    if (!this.active) return null;
    return this._be.sceneTarget(this);
  }
  /**
   * Draw the frame through the chain. target: a render target to draw the finished picture into instead of the canvas (engine.renderOnce(target));
   * it gets the canvas's pixels (tone mapped, output color space). Why a target argument and not "set the render target first": the WebGL chain's
   * last pass always writes to the canvas (EffectComposer renderToScreen); the WebGPU pipeline draws into whatever target is set.
   * @param {number} dt @param {any} [target] @returns {void}
   */
  render(dt, target = null) {
    this._followCamera();
    if (!this.active) { this._be.direct(this, target); return; }
    this._be.render(this, dt, target);
  }
  /**
   * @internal engine.camera was assigned. Passes take the camera when they are built, so the chain is built again from the list, as for a list change. A pass the game made
   * is kept and moves to the new camera if it drew with the old one. While the game owns the chain it is the game's to change; the rebuild waits for the hand-back.
   */
  _followCamera() {
    const now = this.engine.camera, old = this._camera;
    if (now === old || !this._own.on) return;
    this._camera = now;
    for (const e of this._list) { if (e._def._pass?.camera === old) e._def._pass.camera = now; freeImpl(e); }
    this._sync();
  }
  /**
   * @internal start() replaced the renderer (fallback: 'webgl'): the chain and every effect's built part (bloom's node, its targets) belong to
   * the old backend. Dropping each _impl matters: the WebGL backend builds an effect only when it has none, so a WebGPU record left behind
   * was used as a Pass and start() crashed.
   */
  _setBackend() {
    this._fellBack = !isWebGPU(this.engine.renderer);
    this._be.dispose(this);
    for (const e of this._list) freeImpl(e);
    this._be = backendFor(this.engine.renderer);
    this._ownAA = ownMsaa(this.engine.renderer);
    this._be.init(this);
    this._sync();
  }
  /** @internal The renderer's clear color when it stands in for a missing background: opaque and cleared by three (not the game), else null */
  _clearColor() {
    const r = this.engine.renderer;
    return r.autoClear && r.autoClearColor && r.getClearAlpha() === 1 ? r.getClearColor(this._clear ??= new THREE.Color()) : null;
  }
}

/**
 * Drop what an effect built. A plain Pass the game handed in is the game's object: like three's composer.removePass it is not disposed. Only that case: on WebGPU
 * _impl is the engine's record of the nodes it built (bloom's mip targets), and skipping it leaked them on every off / on
 * @param {any} h
 */
function freeImpl(h) {
  if (h._impl !== h._def._pass) h._impl?.dispose?.();
  h._impl = null;
}

/** The chain backend for this renderer: WebGL here; the WebGPU one only when threedog/tsl registered it (render/fx/postWebGPU.tsl.js) */
function backendFor(r) {
  return isWebGPU(r) ? webgpuPart('post', 'engine.post (the post chain)') : webglPost;
}

/** What add() gives for a pass the engine's own stage stands in for @param {() => void} remove */
const skipped = remove => /** @type {any} */ ({ name: null, enabled: false, set() {}, remove });

/** hdr or ldr for each plain pass by its place among the game's OutputPass markers, as in the game's hand-built composer */
function reslot(post) {
  let after = false, changed = false;
  for (const e of post._plain) {
    if (e.output) { after = true; continue; }
    const h = post._list.find(x => x._def === e.def), s = after ? 'ldr' : 'hdr';
    if (h && h.slot !== s) { h.slot = s; changed = true; }
  }
  if (changed) post._sync();
}

/** A three.js Pass that draws the scene itself (RenderPixelatedPass, SSAARenderPass, TAARenderPass, a RenderPass): it replaces the scene render */
const drawsScene = (eng, p) => p.scene === eng.scene && !!p.camera;

/**
 * add()'s value as a post effect; null for a RenderPass of engine.scene and { output: true } for an OutputPass (the engine's own stages). The three accepted shapes and where a plain Pass goes:
 * a pass that renders engine.scene itself goes in the 'scene' slot (it replaces the engine's scene render: stacked after it, the scene was
 * drawn twice a frame), FXAA / SMAA / TAA in 'final', any other pass in 'hdr' after the other effects (order 1000+), where it would sit in
 * a hand-built composer.
 * @param {any} post @param {any} x @param {{ name?: string, slot?: string, order?: number }} o
 */
function effectOf(post, x, { name, slot, order }) {
  const eng = post.engine, pick = d => ({ ...d, ...(name != null ? { name } : {}), ...(slot != null ? { slot } : {}), ...(order != null ? { order } : {}) });
  // game passes go after the other effects in their slot, in add order; the same counter numbers their names
  const next = () => ++post._autoN;
  if (typeof x === 'function') { const n = next(); return pick({ name: `nodePass#${n}`, node: x, order: 1000 + n }); }
  if (x && typeof x === 'object' && typeof x.render === 'function') {
    if (x.isRenderPass && x.scene === eng.scene) {
      warnOnce('engine.post.add(RenderPass): the engine already renders engine.scene first in its chain; this pass was skipped (add the passes that come after it)');
      return null;
    }
    if (x.isOutputPass) {
      // the engine's own output stage stands in for it, and where the game put it still counts: plain passes added after it run on display
      // color ('ldr'), as in its hand-built composer (bloom -> OutputPass -> LUT keeps the LUT after tone mapping); its remove() ends that
      warnOnce('engine.post.add(OutputPass): the engine chain already tone maps and converts to the output color space once; this pass was skipped, and plain passes added after it run after tone mapping (slot ldr)');
      return { output: true };
    }
    // a readable name that survives minified class names: the pass's own name, else a ShaderPass's shader name (CopyShader, FXAAShader)
    const mn = x.material?.name, cls = (typeof x.name === 'string' && x.name) || (mn && mn !== 'unspecified' ? mn : 'pass'), n = next();
    // a known display-conversion shader (three's GammaCorrectionShader / OutputShader as a ShaderPass) is encoded a second time by the engine's output stage
    if (/^(GammaCorrection|Output)Shader$/.test(mn ?? '') && slot !== 'tone') warnOnce(OUTPUT_TWICE(cls));
    const s = drawsScene(eng, x) ? 'scene' : /FXAA|SMAA|TAA/i.test(cls) || x._edgesRT ? 'final' : post._plain.some(e => e.output) ? 'ldr' : 'hdr';
    // _pass: the game's own object, not disposed when the effect is removed (three's removePass habit; remove() in _add).
    // _auto: hdr / ldr follows where the game's OutputPass sits (reslot above), unless the game named the slot
    return pick({ name: `${cls}#${n}`, slot: s, order: 1000 + n, create: () => x, _pass: x, _auto: slot == null && (s === 'hdr' || s === 'ldr') });
  }
  if (x && typeof x === 'object' && typeof x.name === 'string' && (typeof x.create === 'function' || typeof x.node === 'function' || (x.fuse && typeof x.fuse === 'object')))
    return name != null || slot != null || order != null ? pick(x) : x;
  throw codedError('post-effect', 'engine.post.add(x): x is a three.js Pass (has render(); WebGL), a node function (input, ctx) => node (WebGPU), ' +
    "or an effect { name: 'myEffect', create: ctx => pass, node: (input, ctx) => node } / { name, fuse: { glsl } } (both renderers, see PostEffect)");
}
