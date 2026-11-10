// A path-traced still for photo.trace(): three-gpu-pathtracer accumulates samples off screen against a snapshot
// (setScene captures geometry, transforms, materials and lights; the camera is a clone), so the game may keep running and moving its camera meanwhile.
// The library is the game's optional dependency and the game writes its import (photo({ pathTracer: () => import('three-gpu-pathtracer/webgpu') }), or 'three-gpu-pathtracer' on WebGL):
// a bundler fails the build of every game that has not installed a package the engine names, even inside a dynamic import.
import { Vector2 } from 'three';
import { backendName } from '../../render/backend.js';
import { codedError } from '../../core/base/errorHints.js';
import { isDrawOnly, drawOnlyWhat } from '../../core/scene/drawOnly.js';

const INSTALL = "path tracing needs the game's three-gpu-pathtracer: npm i -D three-gpu-pathtracer three-mesh-bvh, then photo({ pathTracer: () => import('three-gpu-pathtracer/webgpu') }) (on WebGL: 'three-gpu-pathtracer')";
/** The op's refusals, known before anything loads; the text is also the error photo.trace() rejects with */
export const REFUSALS = { noTracer: INSTALL, webgl2: 'path tracing needs the WebGPU backend or a WebGLRenderer: this page runs WebGPURenderer on its WebGL2 fallback (describe().renderer)', tracing: 'a traced photo is still accumulating (photo.tracing)' };
export const refusal = (e, load) => typeof load !== 'function' ? 'noTracer' : backendName(e.renderer) === 'webgl2' ? 'webgl2' : null;
export const traceError = msg => codedError('photo-path-trace', `photo.trace(): ${msg}`);
const SHOWN = 5;   // the untraced list names this many, then "+N more": a line, not a dump

/** What the tracer will not draw as the game does: it reads Standard / Physical fields by name (any other model becomes a plain Standard surface),
 *  ignores TSL node slots (colorNode, positionNode…) and onBeforeCompile, needs normals, and traces meshes only (on WebGL one instance per InstancedMesh).
 *  skip: the drawOnly parts traceSnapshot hides; each one's own words say what the photo lacks */
export function untracedLine(scene, skip, gpu) {
  const why = new Map(), flat = new Set(); let other = 0, inst = 0;
  scene.traverseVisible(o => {
    if (skip.includes(o)) return;
    if (o.isAmbientLight || o.isHemisphereLight || o.isLightProbe) { flat.add(o.type); return; }   // the tracer lights by lights with a position and scene.environment
    if (!o.isMesh) { if (o.isPoints || o.isLine || o.isSprite) other++; return; }
    if (!gpu && o.isInstancedMesh) inst++;
    if (!o.geometry.attributes.normal) why.set(o, `${o.name || 'a mesh'} (no normals)`);   // generateMissingAttributes stays off: the game's geometry is never written
    for (const m of [o.material].flat()) {
      if (!m || why.has(m)) continue;
      const slots = [...Object.keys(m).filter(k => k.endsWith('Node') && m[k]?.isNode), ...(Object.hasOwn(m, 'onBeforeCompile') ? ['onBeforeCompile'] : [])];
      const what = m.isMeshStandardMaterial || m.isMeshStandardNodeMaterial ? slots.join(', ') : m.type;
      if (what) why.set(m, `${m.name || m.type} (${what})`);
    }
  });
  const list = [...why.values()], more = list.length > SHOWN ? ` +${list.length - SHOWN} more` : '';
  // the last part always: a --ref comparison would otherwise read the missing bloom or grading as a lighting difference
  return `not traced as drawn: ${[...(list.length ? [list.slice(0, SHOWN).join('; ') + more] : []), ...(inst ? [`${inst} InstancedMesh (traced as one instance)`] : []),
    ...(other ? [`${other} points / lines / sprites (left out)`] : []), ...(flat.size ? [`${[...flat].join(', ')} (left out)`] : []),
    ...new Set(skip.map(drawOnlyWhat).filter(Boolean)), 'no post effects (bloom, grading) in a traced picture'].join('; ')}`;
}

/**
 * Hand the scene to the tracer without the parts the engine draws for something else (core/scene/drawOnly.js: the sky dome, a cascade's
 * copies of the sun, which the tracer would add up to several suns, impostor cards, which outside their shader are one quad at the origin).
 * Hidden for the snapshot only: setScene reads visibility now, and they show again before the next frame. Returns the untraced line.
 * @param {{ setScene(scene: any, camera: any): void }} pt @param {any} scene @param {any} camera @param {boolean} gpu @returns {string}
 */
export function traceSnapshot(pt, scene, camera, gpu) {
  const parts = [];
  scene.traverseVisible(o => { if (isDrawOnly(o)) parts.push(o); });
  const untraced = untracedLine(scene, parts, gpu);
  try { for (const o of parts) o.visible = false; pt.setScene(scene, camera); } finally { for (const o of parts) o.visible = true; }
  return untraced;
}

/**
 * Accumulate up to `samples` per pixel (or until `seconds` pass). `state` ({ samples, of, stop }) is written as it goes; stop or a disposed engine
 * ends it. Returns { ratio, present(), dispose(), info }: present() draws the result to the canvas, for a read in the same task.
 * @param {any} e @param {() => Promise<any>} load @param {{ samples?: number, seconds?: number }} opts @param {number} ratio @param {any} state
 */
export async function traceFrame(e, load, { samples = 128, seconds = 60 }, ratio, state) {
  let lib; try { lib = await load(); } catch (err) { throw traceError(`${INSTALL} (the import failed: ${err?.message ?? err})`); }
  const stopped = () => e.disposed || state.stop, STOPPED = 'stopped: the engine was disposed or the photo module removed';
  if (stopped()) throw traceError(STOPPED);   // the import took frames: the renderer may be gone
  // two entries, one per renderer: WebGPUPathTracer (compute kernels, needs a device) and WebGLPathTracer (a WebGLRenderer; deprecated upstream)
  const r = e.renderer, drawnBy = backendName(r), gpu = drawnBy === 'webgpu', name = gpu ? 'WebGPUPathTracer' : 'WebGLPathTracer';
  if (!lib?.[name]) throw traceError(`path tracing on ${drawnBy} needs ${name}: photo({ pathTracer: () => import('three-gpu-pathtracer${gpu ? '/webgpu' : ''}') })`);
  const pt = new lib[name](r), css = r.getSize(new Vector2()), w = Math.max(1, Math.floor(css.x * ratio)), h = Math.max(1, Math.floor(css.y * ratio));
  // setScene builds a BVH per geometry (not indirect, and the library takes no BVH options): it adds a boundsTree (on a skinned mesh, the mesh),
  // gives an unindexed geometry an index and reorders an existing index in place, which would move a game's drawRange subsets and faceIndex
  // meanings. Copy each index first; afterwards remove only the objects the tracer made (by identity) and write the original order back.
  // shortcut: a game that edits the contents of its own index during a trace loses that edit; upgrade if one ever needs to
  const held = new Map(); e.scene.traverse(o => { if (o.isMesh) for (const x of [o, o.geometry]) if (!held.has(x)) held.set(x, { bt: x.boundsTree, ix: x.index, copy: x.index?.array.slice() }); });
  const mark = () => { for (const [x, h] of held) { h.madeBt = x.boundsTree !== h.bt ? x.boundsTree : null; h.madeIx = x.index !== h.ix ? x.index : null; } };
  const dispose = () => {
    pt.dispose();
    for (const [x, h] of held) {
      if (h.madeBt && x.boundsTree === h.madeBt) delete x.boundsTree;
      if (h.madeIx && x.index === h.madeIx) x.setIndex(null);
      if (h.copy && x.index === h.ix) { h.ix.array.set(h.copy); h.ix.needsUpdate = true; }
    }
  };
  try {
    // off screen at a size fixed now, no preview, fade or raster stand-in: adaptive resolution, a resize or a take() between frames changes
    // the canvas, never the tracer, so nothing restarts and present() never shows a raster frame
    Object.assign(pt, { renderToCanvas: false, dynamicLowRes: false, rasterizeScene: false, generateMissingAttributes: false, renderDelay: 0, fadeDuration: 0, minSamples: 1, maxSamples: samples });
    if (gpu) { pt.synchronizeRenderSize = false; pt.setSize(w, h); } else pt.renderScale = ratio / r.getPixelRatio();   // the WebGL tracer sizes on its first sample, then stops following
    const info = { samples: 0, ms: 0, size: [w, h], untraced: '' };
    pt.addEventListener?.('progress', ev => { if (ev.samples) state.samples = info.samples = Math.round(ev.samples.avg); });
    const count = () => gpu ? info.samples : state.samples = info.samples = Math.floor(pt.samples), done = () => gpu ? pt.complete : count() >= samples;
    const t0 = performance.now();   // wall-clock: the limit is the player's seconds; accumulation runs off the game clock
    try { info.untraced = traceSnapshot(pt, e.scene, e.camera.clone(), gpu); } finally { mark(); }
    // a frame, or a timer when the tab is hidden (no animation frames there), so `seconds` always ends it
    while (!done() && !stopped() && performance.now() - t0 < seconds * 1000) { pt.renderSample(); pt.synchronizeRenderSize = false; await new Promise(go => { requestAnimationFrame(go); setTimeout(go, 250); }); }   // wall-clock
    if (stopped()) throw traceError(STOPPED);
    if (gpu && pt.complete) state.samples = info.samples = samples;
    // nothing to present (the kernels were still compiling, or no count came back): a black picture must not pass for a traced one
    if (!count()) throw traceError(`no sample arrived in ${seconds} s (kernels still compiling?): raise seconds`);
    info.ms = Math.round(performance.now() - t0);   // wall-clock
    const present = () => {
      Object.assign(pt, { renderToCanvas: true, pause: true, pausePathTracing: true }); pt.renderSample();
      if (!count()) throw traceError('the traced picture lost its samples before it was drawn: nothing was kept');
    };
    return { ratio, info, present, dispose };
  } catch (err) { dispose(); throw err; }
}
