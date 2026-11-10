// Renderer facts that differ between WebGLRenderer and WebGPURenderer, read in one place.
// Why one file: counters (renderer.info), shadow-map refresh, the GPU name and one-off renders are spelled differently on the two renderers;
// read directly in every caller, each one would need its own WebGPU branch and the next renderer change would miss some of them.
// Plain three.js equivalent: renderer.info.render / .memory / .programs, renderer.shadowMap.autoUpdate / needsUpdate (WebGL) or
// light.shadow.autoUpdate / needsUpdate (WebGPU), WEBGL_debug_renderer_info (WebGL) or GPUDevice.adapterInfo (WebGPU).
// Imports nothing from three at all, and only engine files that do not either: threedog/tsl (render/fx) registers the WebGPU classes here, so
// WebGL games never load three/webgpu; and threedog/tsl reaches this file, so importing 'three' here would load WebGLRenderer into it.
// The two math classes the renderer borrow needs are handed in by the engine core (mathClasses).

import { codedError } from '../core/base/errorHints.js';
import { warnOnce } from '../core/base/validate.js';
import { notePatch, patchOn } from '../core/scene/threePatches.js';
import { isShown } from '../core/base/util.js';
import { checkVertexInputs } from './vertexInputs.js';

/** Samples of the MSAA the post chain's targets use, on both renderers */
export const MSAA_SAMPLES = 4;

/** Whether this is three's WebGPURenderer (either of its backends) @param {any} r */
export const isWebGPU = r => !!r?.isWebGPURenderer;

/**
 * The backend actually drawing: 'webgl' (WebGLRenderer), 'webgpu' or 'webgl2' (WebGPURenderer on its WebGL2 backend). Read after init().
 * @param {any} r @returns {'webgl' | 'webgpu' | 'webgl2'}
 */
export const backendName = r => !isWebGPU(r) ? 'webgl' : r.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';

/**
 * This frame's counters. drawCalls: WebGLRenderer counts draws in info.render.calls (the engine resets info itself each frame),
 * WebGPURenderer in info.render.drawCalls (its render.calls counts render() calls since start). programs: WebGL only (null on WebGPU).
 * @param {any} r @returns {{ drawCalls: number, triangles: number, programs: number | null, geometries: number, textures: number }}
 */
export function stats(r) {
  const i = r.info, gpu = isWebGPU(r);
  return { drawCalls: gpu ? i.render.drawCalls : i.render.calls, triangles: i.render.triangles, programs: programCount(r),
    geometries: i.memory.geometries, textures: i.memory.textures };
}

/**
 * Whether r has drawn at least once. Why here: WebGLRenderer counts frames in info.render.frame; WebGPURenderer has no such field (its
 * info.frame is the node frame, which three's own tick moves before anything is drawn) and counts render() calls since start in info.render.calls
 * @param {any} r @returns {boolean}
 */
export const drawnAFrame = r => (isWebGPU(r) ? r.info.render.calls : r.info.render.frame) > 0;

/** Compiled shader programs (WebGLRenderer keeps the list), or null where the renderer keeps none (WebGPU) @param {any} r @returns {number | null} */
export const programCount = r => isWebGPU(r) ? null : r.info.programs?.length ?? null;

/** WebGLRenderer's compiled programs (three's WebGLProgram objects) for cost reports; [] on WebGPU @param {any} r @returns {any[]} */
export const programList = r => isWebGPU(r) ? [] : r.info.programs ?? [];

// WebGPURenderer keeps no program list (renderer.info.programs is WebGL only); the code it generated lives on each RenderObject, reachable
// only from inside its render loop. renderer.debug.onNodeBuilderCreated(builder, renderObject) is three's one public hook there, so the
// last render object built per material is kept (weakly: the material's lifetime) and its NodeBuilderState read on demand.
// RECENT: the last builds in order, also weak, so a compile error (which three reports without its render object) can be matched back to one.
const NODE_PROGRAMS = new WeakMap(), RECENT = [], RECENT_MAX = 256;
notePatch('node-builder-hook', "renderer.debug.onNodeBuilderCreated of a WebGPURenderer: remembers the render object built per material and counts each program's vertex inputs " +
  "before its code is written (that builder's buildCode), a game's own hook still runs (render/backend.js)", () => {},
  { scope: 'engine renderer', lost: "on WebGPU: shader errors no longer name the material, shaderCost and the program costs in inspect.perf stay empty, and a program over the device's vertex inputs fails with three's raw pipeline error" });
/** @internal core/engine/Engine.js: on WebGPURenderer, remember the render object three builds per material (a game's own hook still runs) @param {any} r */
export function watchNodePrograms(r) {
  const d = r?.debug;
  if (!isWebGPU(r) || !d || d._threedogPrograms) return;
  const prev = d.onNodeBuilderCreated;
  d.onNodeBuilderCreated = (builder, ro) => {
    if (ro?.material && patchOn('node-builder-hook')) {
      NODE_PROGRAMS.set(ro.material, ro); RECENT.push(new WeakRef(ro)); if (RECENT.length > RECENT_MAX) RECENT.shift();
      const code = builder.buildCode;
      // the material's own build only: three's plain stand-in after a failed build gets the same render object, and must not fail again
      builder.buildCode = function () { if (this.material === ro.material) checkVertexInputs(this, r); return code.call(this); };
    }
    prev?.(builder, ro);
  };
  d._threedogPrograms = true;
}

/**
 * @internal render/shaderErrors.js: the newest render object three built that passes test(renderObject), or null
 * @param {(ro: any) => boolean} test @returns {any}
 */
export function findNodeBuild(test) {
  for (let i = RECENT.length - 1; i >= 0; i--) { const ro = RECENT[i].deref(); try { if (ro && test(ro)) return ro; } catch { /* a disposed one */ } }
  return null;
}
/**
 * The code WebGPURenderer generated for a material (WGSL, or GLSL on its WebGL2 backend), or null until it was drawn once / off WebGPU.
 * samplers: texture bindings of the program.
 * @param {any} r @param {any} material @returns {{ vertexShader: string, fragmentShader: string, samplers: number } | null}
 */
export function nodeProgram(r, material) {
  const ro = isWebGPU(r) ? NODE_PROGRAMS.get(material) : null;
  if (!ro) return null;
  try {
    const s = ro.getNodeBuilderState();
    let samplers = 0;
    for (const g of s.bindings ?? []) for (const b of g.bindings ?? []) if (b.isSampledTexture) samplers++;
    return { vertexShader: s.vertexShader ?? '', fragmentShader: s.fragmentShader ?? '', samplers };
  } catch { return null; }
}

/**
 * GPU memory counters: WebGL's { geometries, textures } as three keeps them; WebGPU's object has many more keys, cut to the same two
 * so a report reads the same on both @param {any} r
 */
export function memory(r) {
  const m = r.info.memory;
  return isWebGPU(r) ? { geometries: m.geometries, textures: m.textures } : { ...m };
}

/** GPU memory in MB as three.js counts it (WebGPURenderer's info.memory.total: textures, buffers, programs it made; an estimate, not driver VRAM). null on
 *  WebGLRenderer, which keeps counts but no byte sizes @param {any} r @returns {number | null} */
export const GPU_MEMORY = "estimate: three's own count, not driver VRAM";
export const gpuMemoryMB = r => isWebGPU(r) ? Math.round(r.info.memory.total / 104857.6) / 10 : null;
/** Texture bytes as three.js counts them: WebGPURenderer's info.memory.texturesSize, every texture it uploaded (render targets and shadow maps too, which no material
 *  slot holds; TSL textures sit in nodes, not slots). null on WebGLRenderer, which counts textures but not their bytes @param {any} r @returns {number | null} */
export const countedTextureBytes = r => isWebGPU(r) ? r.info.memory.texturesSize ?? null : null;

/** Start this frame's counters from zero (the engine renders with info.autoReset off: onRender targets count too) @param {any} r */
export function resetStats(r) { r.info.reset(); }

/** Shadows on in the picture right now (the renderer's switch: what a game wrote directly counts too) @param {any} e */
export const shadowsOn = e => !!e.renderer?.shadowMap?.enabled;

/**
 * Shadow-map refresh. auto: redraw every frame (true) or only when asked (false); now: redraw on the next render.
 * WebGLRenderer has one switch for all lights (renderer.shadowMap); WebGPURenderer has it per light (light.shadow), so there every
 * shadow-casting light in the scene gets it, which is what the WebGL switch means.
 * @param {any} r @param {any} scene @param {{ auto?: boolean, now?: boolean }} o
 */
export function setShadowUpdate(r, scene, { auto, now } = {}) {
  if (!isWebGPU(r)) {
    if (auto !== undefined) r.shadowMap.autoUpdate = auto;
    if (now) {
      r.shadowMap.needsUpdate = true;
      for (const o of shadowLights(scene)) o.shadow.needsUpdate = true;   // a light under a budget (light.shadow.autoUpdate off) skips the pass without its own flag
    }
    return;
  }
  for (const o of shadowLights(scene)) {
    // the light's own flags too: cascades built later clone them (CSMShadowNode copies light.shadow per cascade on its first build)
    for (const s of [o.shadow, ...cascadeShadows(o)]) {
      if (auto !== undefined) s.autoUpdate = auto;
      if (now) s.needsUpdate = true;
    }
  }
}

/**
 * The lights with a shadow in a scene, kept up to date on add / remove (core/scene/sceneDelta.js) instead of walking the scene.
 * Why: these are asked for every frame (the cascades' early update, the budget's shadow pass count); a full
 * scene walk each time costs more than the frame's game code in a large, streaming world.
 * @param {any} scene @returns {Set<any>}
 */
function shadowLights(scene) {
  let w = LIGHTS.get(scene);
  if (!w) {
    if (!VISITOR.fn) throw codedError('engine-misuse', '[threedog] render/backend.js shadowLights: core/scene/sceneDelta.js is not loaded (the engine core registers it)');
    const set = new Set();
    w = { set, view: VISITOR.fn(scene, { enter: o => { if (o.isLight && o.shadow) set.add(o); }, leave: o => { set.delete(o); } }) };
    LIGHTS.set(scene, w);
  }
  w.view.sync();
  return w.set;
}
const LIGHTS = new WeakMap();   // scene -> { set, view }
// core/scene/sceneDelta.js hands its sceneVisitor in (it patches three's Object3D, so importing it here would pull 'three' into threedog/tsl)
const VISITOR = { fn: null };
/** @internal core/scene/sceneDelta.js at load @param {Function} fn */
export function useSceneVisitor(fn) { VISITOR.fn = fn; }

/**
 * Stop shadow redraws until the returned release() puts the switch back. For renders that draw the scene again within one frame (a post
 * effect's own scene render: ao normals, outline's normals and mask): three redraws every shadow map in each render() while autoUpdate is on, so on
 * WebGL ao drew them twice a frame (tests/specs/shadow-passes.mjs). A redraw already requested (needsUpdate) still happens on the next render;
 * the scene pass before this has used it up in the usual case. WebGPURenderer: a no-op (three draws a shadow there once per camera and frame by itself, however many passes render the scene).
 * @param {any} r @param {any} scene @returns {() => void}
 */
export function holdShadowRedraw(r, scene) {
  if (isWebGPU(r)) return () => {};
  const was = r.shadowMap.autoUpdate;
  setShadowUpdate(r, scene, { auto: false });
  return () => setShadowUpdate(r, scene, { auto: was });
}

/** Whether a shadow redraw is already requested for the next render @param {any} r @param {any} scene @returns {boolean} */
export function shadowUpdatePending(r, scene) {
  if (!isWebGPU(r) && r.shadowMap.needsUpdate) return true;
  for (const o of shadowLights(scene)) {
    if (!isWebGPU(r)) { if (o.castShadow && o.shadow.needsUpdate) return true; continue; }
    // with cascades the light's own map is never drawn, so its needsUpdate is never cleared: only the cascades' flags count
    const c = cascadeShadows(o);
    if ((c.length ? c : [o.shadow]).some(s => s.needsUpdate)) return true;
  }
  return false;
}

/**
 * The per-cascade LightShadow objects of a light whose shadow is a cascade shadow node (three's CSMShadowNode: render/cascades.tsl.js),
 * else []. Its cascade lights are plain Object3Ds, not lights, so a scene walk for lights never reaches their flags.
 * @param {any} light @returns {any[]}
 */
const cascadeShadows = light => light.shadow.shadowNode?.lights?.map(l => l.shadow) ?? [];

/**
 * The shadow maps the next render draws, as [{ shadow, faces }] (faces: 6 for a point light's cube map, else 1). Why one list for both
 * renderers: on WebGL every cascade is a DirectionalLight in the scene, while on WebGPURenderer a cascade shadow node draws one map per
 * cascade for a single light (its cascade lights are not in the scene and the light's own map is never drawn); counting lights counted
 * the WebGPU cascades once. Before the node's first build its cascades do not exist yet: the light's shadow stands in for each, since
 * the node clones it per cascade.
 * @param {any} r @param {any} scene @returns {{ shadow: any, faces: number }[]}
 */
export function shadowMaps(r, scene) {
  /** @type {{ shadow: any, faces: number }[]} */ const out = [];
  if (!r.shadowMap?.enabled) return out;
  for (const o of shadowLights(scene)) {
    if (!o.castShadow || !isShown(o)) continue;
    const node = isWebGPU(r) ? o.shadow.shadowNode : null;
    if (node?.cascades > 0 && Array.isArray(node.lights)) {
      const c = cascadeShadows(o);
      for (let i = 0; i < node.cascades; i++) out.push({ shadow: c[i] ?? o.shadow, faces: 1 });
      continue;
    }
    out.push({ shadow: o.shadow, faces: o.isPointLight ? 6 : 1 });
  }
  return out;
}

/**
 * The GPU's name as the browser reports it, or '' when it hides it. WebGL: WEBGL_debug_renderer_info. WebGPU: the device's adapterInfo
 * (known only after init(); '' before). WebGPURenderer on its WebGL2 backend: that backend's context, read like WebGL.
 * @param {any} r @returns {string}
 */
function gpuName(r) {
  if (isWebGPU(r) && r.backend?.isWebGPUBackend) {
    const a = r.backend.device?.adapterInfo;
    return a ? [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ') : '';
  }
  return glName(isWebGPU(r) ? r.backend?.gl : r.getContext());
}
/**
 * What the renderer in use can run, for describe().renderer: an AI reads here what a game may rely on, instead of learning it from a shader that fails.
 * compute: 'compute-shaders' on WebGPU; 'transform-feedback' on WebGPURenderer's WebGL2 backend, which runs renderer.compute() through vertex shaders, so no
 * storage textures, atomics or workgroup memory; null on WebGLRenderer.
 * @param {any} r @returns {{ gpu: string | null, tsl: boolean, glsl: boolean, compute: 'compute-shaders' | 'transform-feedback' | null }}
 */
export function backendFacts(r) {
  const name = backendName(r);
  return { gpu: gpuName(r) || null, tsl: name !== 'webgl', glsl: name === 'webgl',
    compute: name === 'webgpu' ? 'compute-shaders' : name === 'webgl2' ? 'transform-feedback' : null };
}

/** @param {any} gl @returns {string} */
function glName(gl) {
  if (!gl) return '';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
}

/** Roughly the device tier: phones and integrated / software GPUs count as low. Only sets defaults; settings can change them. @param {any} r @returns {'low' | 'high'} */
export function tier(r) { return tierOf(() => gpuName(r)); }
/** @param {() => string} name @returns {'low' | 'high'} */
function tierOf(name) {
  try {
    if (matchMedia('(pointer: coarse)').matches) return 'low';
    if (/intel|uhd|iris|mali|adreno|powervr|swiftshader|llvmpipe|software/i.test(name())) return 'low';
  } catch (e) { warnOnce(`[backend] the device tier could not be detected (${e?.message ?? e}); assuming a high-end device`); }   // said once: a wrong guess changes every tier-following default
  return 'high';
}
let probedName = /** @type {string | null} */ (null);
/**
 * The tier before the engine builds its renderer, read from a throwaway 1x1 WebGL context (made once a page, then released). Why: the
 * canvas's own MSAA (antialias) is fixed when its context is created, and the default MSAA follows the tier; with the tier known first, an
 * effect-free frame draws straight to an MSAA canvas instead of through the post chain's MSAA targets (render/PostFX.js active).
 * @returns {'low' | 'high'}
 */
export function tierBeforeRenderer() {
  return tierOf(() => {
    if (probedName === null) {
      const c = document.createElement('canvas'), gl = c.getContext('webgl2') ?? c.getContext('webgl');
      probedName = glName(gl);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return probedName;
  });
}
/** Whether r draws to its canvas with MSAA of its own (WebGL: the context's antialias; WebGPU: renderer.samples), both fixed at creation @param {any} r */
export const ownMsaa = r => (isWebGPU(r) ? r.samples > 0 : !!r.getContextAttributes?.()?.antialias);

/** The WebGL context for EXT_disjoint_timer_query GPU timing, or null (WebGPURenderer: three owns its timestamp queries) @param {any} r */
export const timerContext = r => isWebGPU(r) ? null : r.getContext();

/** Highest texture anisotropy the GPU allows @param {any} r @returns {number} */
export const maxAnisotropy = r => (isWebGPU(r) ? r.getMaxAnisotropy?.() : r.capabilities?.getMaxAnisotropy?.()) ?? 1;

/** Release the GPU context of a renderer the engine built (after renderer.dispose()). WebGPURenderer's dispose already lets the device go. @param {any} r */
export function releaseContext(r) { if (!isWebGPU(r)) r.forceContextLoss(); }

/** @type {WeakMap<any, number>} per WebGPURenderer: the node frame id the engine last drew in (freshFrame) */
const drawnIn = new WeakMap();

/**
 * Make the next render of r a frame of its own. Why: WebGPURenderer runs a node's per-frame work (NodeUpdateType.FRAME, e.g. the scene pass of
 * a RenderPipeline, pass()) once per node frame, and three advances that frame only in its own requestAnimationFrame tick (Animation.js:
 * nodeFrame.update(), info.frame = frameId). A second engine render in the same task (a photo after the loop's frame, step() run several times,
 * two renderOnce() calls) would otherwise show the first render's scene pass again: same picture, wrong camera. This advances the node frame
 * the same two lines three's tick does, only when the engine already drew in the current one, so the normal loop (one draw per tick) is
 * untouched. WebGLRenderer has no node frames: nothing to do.
 * @param {any} r
 */
export function freshFrame(r) {
  const f = isWebGPU(r) ? r._nodes?.nodeFrame : null;   // _nodes exists after init(); before it nothing has been drawn
  if (!f) return;
  // three's first render() starts that tick, and starting it runs one tick at once: left to render(), the id moves inside the first draw, after the
  // line below noted it, so the next draw took the id for new and its scene pass, already done in that id, showed the first draw's picture again
  r._animation.start();
  if (drawnIn.get(r) === f.frameId) { f.update(); r.info.frame = f.frameId; }
  drawnIn.set(r, f.frameId);
}

/**
 * Draw scene with camera once into target (null = the canvas), outside the frame loop, and put the previous target back. The same call on
 * both renderers; on WebGPURenderer it starts a fresh node frame first (freshFrame), so two calls in one task give two pictures.
 * No post chain here (this is the renderer-level draw): engine.renderOnce() is the one that goes through engine.post.
 * Plain three.js equivalent: renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(prev).
 * @param {any} r @param {any} scene @param {any} camera @param {any} [target]
 */
export function renderOnce(r, scene, camera, target = null) {
  freshFrame(r);
  borrowRenderer(r, () => { r.setRenderTarget(target); r.render(scene, camera); });
}

// Borrowing the renderer (design.md 4.5): every engine task that changes renderer state to draw something of its own goes through these, so
// each one puts back the same fields, and puts them back when the draw throws. Before, five places each restored their own subset: one lost
// the cube face and mip level of the target it gave back, two skipped the restore on a throw, and the engine's next frame drew into the wrong target.
// The fields are written out below, not looped over a list: each one has its own getter / setter pair on three's renderers.
// What a task draws into (its own targets, materials, the layers of its own objects) stays the task's to make and free.
/** One saved state per nesting depth, reused: borrows run every frame (auto exposure, soft particles, onRender hooks), so the saved vectors are not made anew each time */
const held = [];
let depth = 0;
/** three's Vector4 and Color, handed in by core/engine/Engine.js (it imports 'three'; three/webgpu shares the same three.core.js classes) */
let M = /** @type {{ Vector4: any, Color: any } | null} */ (null), _cv = /** @type {any} */ (null);
/** @param {{ Vector4: any, Color: any }} classes */
export function mathClasses({ Vector4, Color }) { M = { Vector4, Color }; _cv = new Vector4(); }
/**
 * Save the renderer state a borrow may change. Pair it with releaseRenderer(s, putBack) in a finally (borrowRenderer does both).
 * Saved: the target with its cube face and mip level, viewport, scissor and scissor test, clear color and alpha, autoClear (and its color / depth /
 * stencil parts), toneMapping and toneMappingExposure, shadowMap.autoUpdate; on WebGPURenderer also the MRT, the render-object function and the
 * opaque / transparent switches and the viewport's minDepth / maxDepth. With scene: its overrideMaterial, background and fog (and WebGPU's backgroundNode and fogNode);
 * with camera: its layers.mask.
 * WebGLRenderer keeps two of each: what was set (getViewport, getScissor, getScissorTest) and what draws (getCurrentViewport and the GL scissor box / test,
 * which a setViewport after binding a target changes and a later setRenderTarget overwrites with the target's own). Both are saved and both come back.
 * clean: true (WebGPU) then sets what three's RendererUtils.resetRendererState sets (no MRT, no render-object function, clear 0x000000 / 1, every autoClear
 * part on, opaque and transparent on), for a quad drawn inside a node frame that must not inherit the scene pass's MRT.
 * @param {any} r @param {{ scene?: any, camera?: any, clean?: boolean }} [o] @returns {any}
 */
export function holdRenderer(r, { scene = null, camera = null, clean = false } = {}) {
  const V = /** @type {any} */ (M).Vector4;   // null only when the engine core was never loaded: nothing can hand this file a renderer then
  const s = held[depth] ??= { viewport: new V(), scissor: new V(), color: new (/** @type {any} */ (M).Color)(), current: new V(), box: new V() };
  s.depth = depth++; s.r = r; s.scene = scene; s.camera = camera;
  s.target = r.getRenderTarget(); s.face = r.getActiveCubeFace(); s.mip = r.getActiveMipmapLevel();
  r.getViewport(s.viewport); r.getScissor(s.scissor); s.scissorTest = r.getScissorTest();
  r.getClearColor(s.color); s.alpha = r.getClearAlpha();
  s.autoClear = r.autoClear; s.autoColor = r.autoClearColor; s.autoDepth = r.autoClearDepth; s.autoStencil = r.autoClearStencil;
  s.toneMapping = r.toneMapping; s.exposure = r.toneMappingExposure; s.shadowAuto = r.shadowMap.autoUpdate;
  s.gpu = isWebGPU(r);
  if (s.gpu) {
    s.mrt = r.getMRT(); s.objectFn = r.getRenderObjectFunction(); s.opaque = r.opaque; s.transparent = r.transparent;
    // Vector4.copy (getViewport) drops the depth range, and setViewport(vector) puts 0..1 back: read from the canvas target (no public getter)
    const v = r.getCanvasTarget?.()._viewport; s.minDepth = v?.minDepth ?? 0; s.maxDepth = v?.maxDepth ?? 1;
  } else {
    r.getCurrentViewport(s.current);
    const gl = r.getContext(), b = gl.getParameter(gl.SCISSOR_BOX);   // three keeps the drawing scissor nowhere readable
    if (b) s.box.set(b[0], b[1], b[2], b[3]); s.boxTest = gl.isEnabled(gl.SCISSOR_TEST);   // b is null on a lost context
  }
  if (scene) { s.override = scene.overrideMaterial; s.background = scene.background; s.bgNode = scene.backgroundNode; s.fog = scene.fog; s.fogNode = scene.fogNode; }
  if (camera) s.layers = camera.layers.mask;
  if (clean) {
    if (s.gpu) { r.setMRT(null); r.setRenderObjectFunction(null); r.opaque = r.transparent = true; }
    r.setClearColor(0x000000, 1); r.autoClear = r.autoClearColor = r.autoClearDepth = r.autoClearStencil = true;
  }
  return s;
}
/**
 * End a hold: putBack writes every saved field back; false only lets the slot go (an onRender hook that returned keeps what it left).
 * Order on WebGLRenderer: the set values, then the target (which draws with its own viewport / scissor), then the drawing area as it was.
 * @param {any} s @param {boolean} [putBack]
 */
export function releaseRenderer(s, putBack = true) {
  depth = s.depth;
  const { r, scene, camera } = s;
  if (putBack) putBackState(s, r, scene, camera);
  s.r = s.scene = s.camera = s.target = s.mrt = s.objectFn = s.override = s.background = s.bgNode = s.fog = s.fogNode = null;   // a slot keeps no scene alive between borrows
}
/**
 * Run draw() with the renderer borrowed: whatever draw changes of the fields holdRenderer lists is put back afterwards, also when it throws.
 * Returns what draw returns. Plain three.js equivalent: save each field, try { draw } finally { set each one back }.
 * @template T @param {any} r @param {() => T} draw @param {{ scene?: any, camera?: any, clean?: boolean }} [o] @returns {T}
 */
export function borrowRenderer(r, draw, o) {
  const s = holdRenderer(r, o);
  try { return draw(); } finally { releaseRenderer(s); }
}
/** @param {any} s @param {any} r @param {any} scene @param {any} camera */
function putBackState(s, r, scene, camera) {
  if (scene) {
    scene.overrideMaterial = s.override; scene.background = s.background; scene.fog = s.fog;
    // only where it was changed: a WebGL scene gets no such property. fogNode is the fog WebGPURenderer draws (render/fogLook.js), so a pass that
    // turned it off and threw would otherwise leave scene.fog back but the fog gone for good
    if (scene.backgroundNode !== s.bgNode) scene.backgroundNode = s.bgNode;
    if (scene.fogNode !== s.fogNode) scene.fogNode = s.fogNode;
  }
  if (camera) camera.layers.mask = s.layers;
  r.toneMapping = s.toneMapping; r.toneMappingExposure = s.exposure; r.shadowMap.autoUpdate = s.shadowAuto;
  r.setClearColor(s.color, s.alpha);
  r.autoClear = s.autoClear; r.autoClearColor = s.autoColor; r.autoClearDepth = s.autoDepth; r.autoClearStencil = s.autoStencil;
  if (s.gpu) { r.setMRT(s.mrt); r.setRenderObjectFunction(s.objectFn); r.opaque = s.opaque; r.transparent = s.transparent; }
  const v = s.viewport;
  r.setViewport(v.x, v.y, v.z, v.w, s.gpu ? s.minDepth : 0, s.gpu ? s.maxDepth : 1); r.setScissor(s.scissor); r.setScissorTest(s.scissorTest);
  r.setRenderTarget(s.target, s.face, s.mip);
  if (s.gpu) return;   // WebGPURenderer draws a target with the target's own viewport: the set values above are all it keeps
  // the drawing viewport differs from the target's own only when setViewport ran after the bind: running it again gives the same rounding;
  // otherwise (an ArrayCamera's sub-viewport left mid-render) only the GL viewport can be put back
  if (!r.getCurrentViewport(_cv).equals(s.current)) { r.setViewport(v); if (!r.getCurrentViewport(_cv).equals(s.current)) r.state.viewport(s.current); }
  r.state.scissor(s.box); r.state.setScissorTest(s.boxTest);   // three's GL state cache: no GL call when already equal
}

/**
 * Run draw() with every renderer.render(scene, camera) in it turned into renderer.compileAsync(scene, camera) at the render target set at that
 * moment, and resolve (with draw's result) once all those programs are ready. Why: code that draws through three itself (PMREMGenerator, the
 * post chain's fullscreen passes) compiles each program synchronously in its first real render, one after the other (start() measured ~410 ms
 * for the room map and ~130 ms for nine post passes on a real GPU); compileAsync hands them all to the browser's parallel compile
 * (KHR_parallel_shader_compile on WebGL) together with the scene's, so the real render afterwards finds them linked. Nothing is drawn: only
 * target switches and clears happen, so call it where the output is drawn again before anyone sees it. The renderer's own render (or a
 * game's wrapper of it) is put back even when draw throws. WebGLRenderer only: WebGPURenderer's compileAsync calls share one precompile
 * state and break when they overlap (measured: "_precompilationState is null").
 * @template T @param {any} r @param {() => T} draw @returns {Promise<T>}
 */
export function compileThrough(r, draw) {
  const own = Object.hasOwn(r, 'render'), real = r.render, jobs = [];
  r.render = (scene, camera) => { const j = r.compileAsync(scene, camera); j.catch(() => {}); jobs.push(j); };   // handled at once: if a later pass throws, Promise.all below is never reached and a rejection would be unhandled
  let out;
  try { out = draw(); } finally { if (own) r.render = real; else delete r.render; }
  return Promise.all(jobs).then(() => out);
}

/**
 * The pixels of one layer of a 3D render target, RGBA, row 0 first as the target's writer meant it. Float32Array on WebGLRenderer; on WebGPURenderer
 * whatever its readback gives for the target's type, with rows padded to its copy alignment (use length / h as the row stride).
 * Why the flip: WebGPURenderer's node shaders count rows from the top, and on its WebGL2 backend readPixels counts from the bottom, so without
 * it a probe bake on that backend came back upside down.
 * @param {any} r @param {any} rt @param {number} w @param {number} h @param {number} layer @returns {Promise<any>}
 */
export async function readLayer(r, rt, w, h, layer) {
  if (isWebGPU(r)) {
    const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 0, layer);
    if (backendName(r) === 'webgpu') return px;
    const out = new /** @type {any} */ (px.constructor)(px.length), row = px.length / h;
    for (let y = 0; y < h; y++) out.set(px.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    return out;
  }
  const px = new Float32Array(w * h * 4);
  // on WebGL the layer is chosen by what is attached, readRenderTargetPixels has no layer argument
  borrowRenderer(r, () => { r.setRenderTarget(rt, layer); r.readRenderTargetPixels(rt, 0, 0, w, h, px); });
  return px;
}

/** Make three's light node drop the shadow it cached (AnalyticLightNode listens for the light's 'dispose'; its version bump recompiles) @param {any} light */
export function rebuildShadow(light) { light.dispatchEvent({ type: 'dispose' }); }

/** A text that changes when the camera's projection does, for "did it change" checks @param {any} cam @returns {string} */
export const projectionKey = cam => (cam.isPerspectiveCamera ? `${cam.fov},${cam.aspect},${cam.near},${cam.far},${cam.zoom}` : `${cam.left},${cam.right},${cam.top},${cam.bottom},${cam.near},${cam.far},${cam.zoom}`);

// ---------- the WebGPU route (createEngine({ renderer: 'webgpu' }); docs/plans/2026-11-03-webgpu-phase2.md section 1) ----------

// One registration entry for everything threedog/tsl brings (the three/webgpu classes and each node-side part). Why one table here: before,
// the classes had their own setter and five parts each had a global symbol, a lookup function and its own "not loaded" error (four codes);
// a sixth part had nothing to copy. Now a .tsl.js file calls registerWebGPUPart(name, impl) once at load, and every user asks
// webgpuPart(name, who): the same error code and the same fix line wherever threedog/tsl is missing.
// Module scope, not a page global: the .tsl.js files import this file, so they always fill the table the engine copy using them reads.
/** @typedef {'classes' | 'nodePatches' | 'particles' | 'post' | 'sky' | 'cascades' | 'shadowCache' | 'impostor'} WebGPUPartName */
/** @type {Map<string, any>} */
const PARTS = new Map();
/**
 * @internal threedog/tsl files: hand over one WebGPU part (render/fx/index.js loads them all)
 * @param {WebGPUPartName} name @param {any} impl
 */
export function registerWebGPUPart(name, impl) { PARTS.set(name, impl); }
/**
 * A registered WebGPU part, or the one error for "threedog/tsl not loaded" naming who needed it
 * @param {WebGPUPartName} name @param {string} who  what was being built, e.g. "[sky] the dome"
 */
export function webgpuPart(name, who) {
  const p = PARTS.get(name);
  if (!p) throw codedError('webgpu-needs-tsl', `[threedog] ${who} on WebGPURenderer needs threedog/tsl loaded: add import 'threedog/tsl' at the top of the game's entry `
    + '(the engine core never imports it, so WebGL games stay small)');
  return p;
}
/** A registered WebGPU part or null (for code that has a WebGL answer when threedog/tsl is absent) @param {WebGPUPartName} name */
export const webgpuPartOrNull = name => PARTS.get(name) ?? null;
/** @internal tests: take a part away (null) or put one back, to check the "not loaded" error; returns the previous one @param {WebGPUPartName} name @param {any} impl */
export function swapWebGPUPart(name, impl) { const prev = PARTS.get(name) ?? null; if (impl == null) PARTS.delete(name); else PARTS.set(name, impl); return prev; }

// Parts built for the renderer before start() knew the backend. createEngine({ renderer: 'webgpu', fallback: 'webgl' }) swaps the
// WebGPURenderer for a WebGLRenderer inside start(), after modules installed and built node materials (the sky dome). Each such part
// registers a rebuild here; start() runs them right after the swap (core/engine/startup.js), so no part keeps a node material WebGL cannot draw.
const SWAP = new WeakMap();   // engine -> Set of rebuilds
/**
 * @internal Run fn when the engine's renderer is replaced in start() (fallback 'webgl'); returns { remove() }
 * @param {any} engine @param {() => void} fn
 */
export function onRendererSwap(engine, fn) {
  let set = SWAP.get(engine);
  if (!set) SWAP.set(engine, set = new Set());
  set.add(fn);
  return { remove: () => { set.delete(fn); } };
}
/** @internal core/engine/startup.js after the swap: rebuild every registered part for engine.renderer @param {any} engine */
export function rendererSwapped(engine) { for (const fn of [...(SWAP.get(engine) ?? [])]) fn(); }

/**
 * Why this browser cannot give WebGPU, or null when it can. Asks the same two questions three's init() asks (an adapter, then a device),
 * because three answers "no" only with a console warning and a silent switch to its WebGL2 backend, and the reason is lost there.
 * The probe device is destroyed at once; three's init() requests its own. A yes is kept per navigator.gpu, so only the page's first engine pays for a probe device;
 * the adapter is still asked each time, it costs no device. If the GPU goes bad later, three's own fallback still lands and _startRenderer says so.
 * @returns {Promise<string | null>}
 */
/** @param {Record<string, number>} [limits] three's requiredLimits of a renderer the engine made: filled before its init() requests the device @param {string} [powerPreference] */
export async function whyNoWebGPU(limits, powerPreference) {
  const gpu = typeof navigator === 'undefined' ? undefined : /** @type {any} */ (navigator).gpu;
  if (!gpu) return 'navigator.gpu is missing';
  let adapter;
  try { adapter = await gpu.requestAdapter({ featureLevel: 'compatibility', powerPreference }); } catch (err) { return `requestAdapter() failed: ${err?.message ?? err}`; }
  if (!adapter) return 'requestAdapter() returned no adapter';
  // the post chain's merged scene targets (render/fx/postWebGPU.tsl.js) can pass WebGPU's default 32 bytes per pixel; asking what this adapter supports costs nothing and lifts it where the hardware can
  if (limits) for (const k of ['maxColorAttachmentBytesPerSample', 'maxColorAttachments']) limits[k] ??= adapter.limits[k];
  if (deviceFrom === gpu) return null;
  try { (await adapter.requestDevice()).destroy?.(); } catch (err) { return `requestDevice() failed: ${err?.message ?? err}`; }
  deviceFrom = gpu;
  return null;
}
let deviceFrom = null;   // the navigator.gpu that gave a device (a page's stand-in for it is another object, so it is asked again)

/** Each material on a scene object, once @param {any} scene @param {(m: any, o: any) => void} fn */
function eachMaterial(scene, fn) {
  const seen = new Set();
  scene.traverse(o => { for (const m of [o.material].flat()) if (m && !seen.has(m)) { seen.add(m); fn(m, o); } });
}

/** The first NodeMaterial in the scene (TSL; WebGLRenderer cannot draw it) as { material, object }, or null @param {any} scene */
export function firstNodeMaterial(scene) {
  /** @type {{ material: any, object: any } | null} */ let hit = null;
  eachMaterial(scene, (m, o) => { if (!hit && m.isNodeMaterial) hit = { material: m, object: o }; });
  return hit;
}

/**
 * The game's own onBeforeCompile on a material, or null. The engine's patch wrapper (render/patches.js patchMaterial) is not the game's:
 * it marks itself and hands out the game's part kept under it, so a patched engine material counts only when the game added a hook too.
 * three's default is the empty method on the farthest prototype that defines it (Material.prototype; read this way so this file imports nothing from three).
 * @param {any} m @returns {Function | null}
 */
function gameCompileHook(m) {
  let f = m.onBeforeCompile;
  const kept = f?.[Symbol.for('threedog.patchWrapper')];
  if (kept) f = kept();
  if (typeof f !== 'function') return null;
  let base = null;
  for (let p = Object.getPrototypeOf(m); p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'onBeforeCompile')) base = p.onBeforeCompile;
  return f === base ? null : f;
}

/**
 * What WebGPURenderer does not run (plan section 1.3), material by material; WebGPURenderer skips these without a word, so the engine names them.
 * Covered: ShaderMaterial / RawShaderMaterial, a game's onBeforeCompile, and (a rule render/patches.js adds) a patched classic material whose
 * patches cannot all run as nodes. three Pass objects in engine.post are named by the WebGPU post chain itself (render/fx/postWebGPU.tsl.js).
 */
const WEBGL_ONLY = [
  { test: m => m.isShaderMaterial, what: m => m.isRawShaderMaterial ? 'RawShaderMaterial' : 'ShaderMaterial',
    fix: 'write it as a NodeMaterial with TSL (three/tsl, the engine functions in threedog/tsl), or stay on WebGL (no renderer option)' },
  { test: m => !!gameCompileHook(m), what: m => `${m.type} with onBeforeCompile`,
    fix: "onBeforeCompile edits GLSL, which WebGPURenderer never compiles: set the material's nodes instead (a NodeMaterial's positionNode / colorNode with three/tsl), "
      + 'or a patch with a tsl version through applyEffects, or stay on WebGL (no renderer option)' },
];

/** @type {((m: any) => string | null)[]} rules added by other files, each returning its own message (or null) */
const MORE_RULES = [];
/**
 * @internal render/patches.js: one more "does not run on WebGPURenderer" check (it knows the patch lists; this file imports nothing of it)
 * @param {(m: any) => string | null} rule
 */
export function addWebGPURule(rule) { MORE_RULES.push(rule); }

/** The message for one material on object o that WebGPURenderer will not run, or null */
function webglOnlyMaterial(m, o) {
  const rule = WEBGL_ONLY.find(w => w.test(m));
  if (rule) return `${rule.what(m)}${m.name ? ` '${m.name}'` : ''} on ${o.type} '${o.name || '(unnamed)'}' does not run on WebGPURenderer: ${rule.fix}`;
  for (const more of MORE_RULES) { const msg = more(m); if (msg) return `${msg.replace(/^\[threedog\] /, '')} (on ${o.type} '${o.name || '(unnamed)'}')`; }
  return null;
}

/** What WebGPURenderer will not run on one object's own materials (not its children), as a message naming it and the fix, or null @param {any} o */
export function webglOnlyOn(o) {
  for (const m of [o.material].flat()) { const msg = m && webglOnlyMaterial(m, o); if (msg) return msg; }
  return null;
}
