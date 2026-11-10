// Post chain on WebGPURenderer (RenderPipeline); render/PostFX.js holds the list and calls these with itself as `post`.
// The chain is one node graph: scenePass = pass(scene, camera, { samples }) -> each hdr effect's node() -> renderOutput() (tone mapping + output
// color space, placed by hand: outputColorTransform = false) -> ldr -> final. Fuse effects bring fuse.tsl (color, uv, t) => color; neighbors are
// just nested calls, so three compiles them into one fullscreen pass and fuse.js's merging is not needed here (nor loaded).
// Registered with render/backend.js when threedog/tsl loads (see PostFX.js for why not an import). Only three/webgpu, three/tsl and three's TSL display
// nodes are imported: this file must never pull EffectComposer or other WebGL code.
import { RenderPipeline, UnsignedByteType } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { codedError } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
import { runsOnWebGPU, OUTPUT_TWICE } from '../postRuns.js';
import { registerWebGPUPart, MSAA_SAMPLES, borrowRenderer } from '../backend.js';
import { RESERVED_LAYERS } from '../layers.js';
import * as FX from './library.tsl.js';
import { nameNodeBuild, lostStatements } from './nodeErrors.tsl.js';

const { pass, renderOutput, uniform, screenUV, screenSize, time, convertToTexture, mrt, output, normalView, diffuseColor, velocity, metalness, roughness, vec2, vec4 } = TSL;

// What PostEffect.needsBuffers can ask of the scene render. Raw, not packed into other encodings: display nodes read them as they are.
// metalRough is the one exception in storage, not in meaning: both are 0 to 1, so they share one 8-bit target (three's SSR example does the same), a quarter of a half-float one
const BUFFERS = { normal: normalView, diffuse: diffuseColor, velocity, metalRough: vec2(metalness, roughness) };
const BYTE_BUFFERS = ['metalRough'];
// velocity fills only xy of its target: with both asked, metalRough rides in its zw, one target fewer (output + normal + diffuse + velocity is WebGPU's default ceiling)
const VELOCITY_METAL_ROUGH = vec4(/** @type {any} */ (velocity), BUFFERS.metalRough);   // three types the velocity node as no vec2

/** How many scene targets the device takes. Every target here is rgba16float or rgba8unorm, 8 bytes per sample each in WebGPU's table, so bytes reduce to a count; Infinity before the device exists */
function roomOf(r) {
  const be = r.backend, l = be?.device?.limits, gl = be?.gl;; if (!l && !gl) return Infinity;
  // read once per backend: render() asks every frame, and a GL query there would be a sync call each frame
  if (!rooms.has(be)) rooms.set(be, l ? Math.min(l.maxColorAttachments, Math.floor(l.maxColorAttachmentBytesPerSample / 8)) : gl.getParameter(gl.MAX_DRAW_BUFFERS));
  return rooms.get(be);
}
const rooms = new WeakMap();

/** Which uniform a param value makes: 'number' (numbers, booleans as 0 / 1), a color or vector kind, or null: anything else rebuilds the chain when it changes */
const kindOf = v => (typeof v === 'number' || typeof v === 'boolean' ? 'number' : v?.isColor ? 'color' : v?.isVector2 ? 'vec2' : v?.isVector3 ? 'vec3' : v?.isVector4 ? 'vec4' : null);
/** Live uniform for a param value, or null when it has no live kind */
function liveUniform(v) {
  const kind = kindOf(v);
  return kind === null ? null : uniform(kind === 'number' ? +v : v.clone());
}
/** Can this uniform take the value as a plain write? A color uniform also takes what Color.set takes (0xffcc66, 'red'). A number uniform never takes a color: its type is fixed in the graph */
const fits = (u, v) => !!u && (kindOf(u.value) === kindOf(v) ? kindOf(v) !== null : kindOf(u.value) === 'color' && (typeof v === 'number' || typeof v === 'string'));
function writeUniform(u, v) {
  if (u.value?.isColor) u.value.set(v);
  else if (typeof u.value === 'number') u.value = +v;
  else u.value.copy(v);
}
/** The effect's uniform nodes by param name, made once per effect and kept across chain rebuilds (so set() keeps working on the same nodes) */
function uniformsOf(h) {
  if (!h._u) { h._u = {}; for (const [k, v] of Object.entries(h.params)) { const u = liveUniform(v); if (u) h._u[k] = u; } }
  return h._u;
}

/**
 * ctx.params for node() / fuse.tsl: the effect's live params, noting which keys are read while the node is built. Such a key went into the graph
 * as a plain number, so set() of it rebuilds (WebGL rebuilds an effect without update() the same way); keys read only through ctx.p stay
 * uniform writes. A read after the build (an onRenderUpdate callback, outline's color) sees the current value each time and is not noted.
 */
function paramsOf(h) {
  return h._paramsProxy ??= new Proxy(h.params, { get(t, k) { if (h._building && typeof k === 'string') h._read.add(k); return t[k]; } });
}

/**
 * Display nodes handed to effects as ctx.display, each call recorded so the effect's nodes are disposed when the chain is rebuilt.
 * Why handed in and not imported by the effect: the main entry of @threedog/post-effects is also loaded by WebGL games; importing three/webgpu there would grow their bundles.
 */
function displayFor(made) {
  const rec = f => (...a) => { const n = f(...a); made.push(n); return n; };
  // pass: an extra scene render (outline's normal / mask views); texture: the color so far as a texture, for effects that sample it at other
  // uvs (dof). Both own render targets, so they go through the recorder too; a node that already is a texture comes back as is and is not ours to dispose.
  const texture = n => { const t = convertToTexture(n); if (t !== n) made.push(t); return t; };
  return { bloom: rec(bloom), ao: rec(ao), pass: rec(extraPass), texture, own: n => { made.push(n); return n; } };
}

/** An extra scene render: occlusion's boxes belong to the scene pass alone, drawn here they would show through an override material (outline's normal view) */
function extraPass(scene, camera, opts) {
  const n = pass(scene, camera, opts), run = n.updateBefore.bind(n);
  n.updateBefore = frame => {
    const mask = camera.layers.mask;
    camera.layers.disable(RESERVED_LAYERS.occlusionBox);
    try { return run(frame); } finally { camera.layers.mask = mask; }
  };
  return n;
}

const SCENE = 'scene render', OUTPUT = 'output (tone mapping)';   // the engine's own stages in P.stages and post.order

const onlyCreate = e => codedError('post-effect', `[threedog] post effect '${e.name}' has only create() (a three.js Pass, WebGLRenderer only); on WebGPURenderer give it ` +
  `node: (input, ctx) => colorNode, e.g. node: (input, { tsl, p }) => tsl.vec4(input.rgb.mul(p.amount), input.a) (recipe 52)`);
const glslOnly = e => codedError('post-effect', `[threedog] post effect '${e.name}': its fuse snippet is GLSL only; on WebGPURenderer add fuse.tsl: ` +
  `(color, uv, t) => color, e.g. tsl: (color, uv, { tsl, p }) => tsl.vec4(color.rgb.mul(p.amount), color.a) (recipe 52)`);

const webgpuPost = {
  init(post) { post._pipe = null; post._pipeOut = null; },
  object: post => (post._pipe ? { pipeline: post._pipe.pipeline, scenePass: post._pipe.scenePass } : null),
  // The pass node owns its render targets and resizes them with the renderer; nothing is handed out as ping-pong targets on this backend
  targets: () => null,
  /**
   * Param change: number / color params only write their uniforms; another kind (a texture, a mode string), a value of another kind than its
   * uniform (a Color for a param that started as a number: the uniform is replaced), or a param node() read as a plain value from ctx.params
   * (built into the graph as a constant, so its uniform reaches nothing), rebuilds the chain, as WebGL rebuilds an effect without update(). true = handled
   */
  set(post, h, p) {
    if (Object.entries(p).every(([k, v]) => fits(h._u?.[k], v) && !h._read?.has(k))) { for (const [k, v] of Object.entries(p)) writeUniform(h._u[k], v); return true; }
    for (const [k, v] of Object.entries(p)) {
      if (fits(h._u?.[k], v)) writeUniform(h._u[k], v);
      else if (h._u?.[k] && kindOf(v)) h._u[k] = liveUniform(v);
    }
    if (h.enabled) { h._impl?.dispose?.(); h._impl = null; post._pipe && (post._pipe.key = null); post._sync(); }
    return true;
  },
  samples: post => (post.active ? post._pipe?.samples ?? (post._aa ? MSAA_SAMPLES : 0) : post.engine.renderer.samples),
  // nothing here: sync's key holds the effective samples, so a switch under a temporal resolve (samples stay 0) rebuilds nothing
  setAntialias() {},
  sync(post) {
    const { renderer, scene, camera } = post.engine;
    const on = post._sorted().filter(e => e.enabled);
    // nothing on: the frame goes straight to the canvas, so the scene pass's color, depth and MSAA targets are freed now, not at engine.dispose
    // (postWebGL.js frees its composer targets the same way); the next effect builds a new pipeline (GPT review l2-render 6)
    if (!on.length) { for (const e of post._list) { e._impl?.dispose?.(); e._impl = null; } webgpuPost.dispose(post); return; }
    // the union over the effects that are on, in one fixed order: one setMRT for all of them, and none at all (no extra targets) when nobody asks
    const buffers = Object.keys(BUFFERS).filter(b => on.some(e => e._def.needsBuffers?.includes(b)));
    const packed = buffers.includes('velocity') && buffers.includes('metalRough'), room = roomOf(renderer);
    const targets = Object.fromEntries(buffers.filter(b => !(packed && b === 'metalRough')).map(b => [b, packed && b === 'velocity' ? VELOCITY_METAL_ROUGH : BUFFERS[b]]));
    // over the device's limit three's pipeline validation fails naming no effect; checked before anything is torn down, so add() rolls back cleanly
    const n = 1 + Object.keys(targets).length;
    if (n > room) throw codedError('post-effect', `[threedog] post effects ${on.filter(e => e._def.needsBuffers?.length).map(e => `${e.name} (${e._def.needsBuffers.join(', ')})`).join(', ')} ` +
      `need ${n} scene targets (${n * 8} bytes per pixel), this device takes ${room} (${room * 8} bytes): turn off the one that matters least`);
    // velocity means a temporal resolve follows: it is the antialiasing, and MSAA under it would only cost
    const samples = post._aa && !buffers.includes('velocity') ? MSAA_SAMPLES : 0;
    for (const e of on) if (!runsOnWebGPU(e._def)) throw e._def.fuse ? glslOnly(e) : onlyCreate(e);   // the rule the picture menu's "runs here" reads too
    // Same effects, same build, same samples: the graph is current (a set() of a number param never gets here)
    const key = `${samples}|${buffers}|${room}|${on.map(e => e.name).join(',')}`;
    if (post._pipe?.key === key && post._pipe.camera === camera) return;
    let P = post._pipe;
    if (!P) P = post._pipe = { pipeline: new RenderPipeline(renderer), scenePass: null, samples: -1, buffers: '', key: null, order: [] };
    P.key = null;   // the graph is coming down: when a node() throws below, PostFX syncs the old list again, and that sync must rebuild, not find its key current
    P.room = room; P.packed = packed;
    if (P.samples !== samples || P.buffers !== `${buffers}` || P.camera !== camera) {
      P.scenePass?.dispose(); P.scenePass = pass(scene, camera, { samples }); P.samples = samples; P.buffers = `${buffers}`; P.camera = camera;
      if (buffers.length) P.scenePass.setMRT(mrt({ output, ...targets }));
      for (const b of Object.keys(targets)) if (BYTE_BUFFERS.includes(b)) P.scenePass.getTexture(b).type = UnsignedByteType;
      P.stages = [];   // a new scene pass (samples, MRT, camera): every stage reads it, none is kept
    }
    const size = post._size();
    const ctxOf = (e, made) => ({ engine: post.engine, scene, camera, width: size.x, height: size.y, params: paramsOf(e), scenePass: P.scenePass,
      buffer: b => (b === 'metalRough' && P.packed ? P.scenePass.getTextureNode('velocity').zw : P.scenePass.getTextureNode(b)), tsl: TSL, fx: FX, display: displayFor(made), p: uniformsOf(e), borrowRenderer });
    // the effect's node is built only when the pipeline first draws: errors then, and statements lost outside an Fn, name the effect
    const run = (e, color) => {
      const label = `[threedog] post effect '${e.name}'`;
      return nameNodeBuild(lostStatements(label, () => build(e, color)), label, color);
    };
    const build = (e, color) => {
      const made = [];
      e._impl = { nodes: made, dispose() { for (const n of made) n.dispose?.(); made.length = 0; } };
      e._read = new Set(); e._building = true;
      try {
        if (e._def.fuse) {
          const f = e._def.fuse, c = ctxOf(e, made);
          return f.tsl(color, screenUV, { ...c, time, resolution: screenSize, input: f.reads ? c.display.texture(color) : null });
        }
        const out = e._def.node(color, ctxOf(e, made));
        // a node that calls renderOutput() itself is tone mapped a second time by the engine's own output stage: said once, never guessed away
        // (an output stage the INPUT already had is the engine's own, for ldr / final effects)
        if (e.slot !== 'tone' && out?.traverse) {
          const had = new Set(); color.traverse(x => x.isRenderOutputNode && had.add(x));
          let again = false; out.traverse(x => { if (x.isRenderOutputNode && !had.has(x)) again = true; });
          if (again) warnOnce(OUTPUT_TWICE(e.name));
        }
        return out;
      } finally { e._building = false; }
    };
    const slot = s => on.filter(e => e.slot === s);
    // the chain as stages: an effect handle, or the engine's own 'scene render' / 'output (tone mapping)' (a game's tone stage replaces renderOutput)
    const want = [slot('scene')[0] ?? SCENE, ...slot('hdr'), slot('tone')[0] ?? OUTPUT, ...slot('ldr'), ...slot('final')];
    // Why stages are kept: an effect's input is the node before it, so only what follows the first changed stage has to be rebuilt. Toggling a
    // cheap final effect left voxel GI re-voxelising and TRAA / reflections losing their history (GPT review l2-render 5). A stage is the same when
    // it is the same effect at the same place and still holds the nodes it was built with (set() of a baked-in param or freeImpl dropped them)
    const was = P.stages ?? [];
    let k = 0;
    while (k < want.length && k < was.length && was[k].e === want[k] && (typeof want[k] === 'string' || want[k]._impl === was[k].impl)) k++;
    const kept = new Set(was.slice(0, k).map(s => s.e));
    for (const e of post._list) if (!kept.has(e)) { e._impl?.dispose?.(); e._impl = null; }
    const stages = was.slice(0, k);
    P.stages = stages;   // set before the build: a node() that throws below leaves only stages that are still whole
    let color = k ? stages[k - 1].out : P.scenePass.getTextureNode();
    for (const w of want.slice(k)) {
      if (w === OUTPUT) color = renderOutput(color);
      else if (w !== SCENE) color = run(w, color);
      stages.push({ e: w, impl: typeof w === 'string' ? null : w._impl, out: color });
    }
    const order = stages.map(s => (typeof s.e === 'string' ? s.e : s.e.name));
    P.pipeline.outputColorTransform = false;
    P.pipeline.outputNode = color; P.pipeline.needsUpdate = true;
    P.output = color; P.order = order; P.key = key;
  },
  dispose(post) {
    if (post._pipeOut) { post._pipeOut.scenePass.dispose(); post._pipeOut.pipeline.dispose(); post._pipeOut = null; }
    const P = post._pipe;
    if (!P) return;
    P.scenePass?.dispose(); P.pipeline.dispose(); post._pipe = null;
  },
  // start()'s compileAsync target: pass() renders into its own target whose program key three manages; the canvas key is the closest stand-in
  sceneTarget: () => null,
  // target: the pipeline's last quad draws into the renderer's current target (pass() nodes put it back after their own renders)
  render(post, dt, target = null) {
    // a chain built before start() had no device to check against: the first frame after it rebuilds once and checks (sync's key holds the room)
    if (!post._pipe || post._pipe.room !== roomOf(post.engine.renderer)) post._sync();
    onTarget(post.engine.renderer, target, () => post._pipe.pipeline.render());
  },
  /**
   * Straight to the canvas. postWebGL's direct() draws a Color background (or the clear color) as a tone-mapped quad so it matches the composer
   * path; nothing like it is needed here: with tone mapping or an sRGB output, WebGPURenderer draws the scene (clear included) into its own
   * half-float frame-buffer target and tone-maps the whole image in one output pass, so a clear is tone-mapped like every mesh
   * (tests/specs/post-webgpu.mjs: Color, HDR Color and clear-color backgrounds equal WebGL's to the pixel). An sRGB texture background is
   * tone-mapped here too, as on both WebGL paths (postWebGL.js toneBackground; tests/specs/engine-webgpu.mjs colorSpots).
   * MSAA: the renderer's own samples (made with the default antialias), so an effect-free frame needs no pipeline; a runtime switch away from
   * them runs the pipeline with pass() samples (PostFX active).
   */
  direct(post, target = null) {
    const { renderer, scene, camera } = post.engine;
    if (!target) { renderer.render(scene, camera); return; }
    // a target gets the canvas's pixels too (tone mapped, output color space): three's plain draw into a target is linear. A small pipeline, scene pass -> renderOutput,
    // kept for the next call (a minimap asks every frame) and freed with the chain
    let O = post._pipeOut;
    if (!O || O.camera !== camera || O.scene !== scene) {   // engine.scene / engine.camera can be replaced: the pass node holds the ones it was made with
      O?.scenePass.dispose(); O?.pipeline.dispose();
      const scenePass = pass(scene, camera, { samples: 0 }), pipeline = new RenderPipeline(renderer);
      pipeline.outputColorTransform = false; pipeline.outputNode = renderOutput(scenePass.getTextureNode());
      O = post._pipeOut = { pipeline, scenePass, camera, scene };
    }
    onTarget(renderer, target, () => O.pipeline.render());
  },
};

/** Run draw with target set (null: as it is, the canvas), the renderer borrowed and given back */
function onTarget(r, target, draw) {
  if (!target) { draw(); return; }
  borrowRenderer(r, () => { r.setRenderTarget(target); draw(); });
}

registerWebGPUPart('post', Object.freeze(webgpuPost));
