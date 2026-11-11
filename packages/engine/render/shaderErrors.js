// Shader errors naming the patch and slot.
// Design: docs/plans/done/2026-11-02-look-architecture.md §4g.
// Why: patch code is injected into the middle of three's shader, and the original error gives only "line 812", so an AI cannot tell which patch is wrong. On injection slots.js's mark() adds
// `// threedog:begin patch=x slot=y` / `// threedog:end` before and after each piece; here, going up from the error line number, find the nearest begin marker and report the patch name and slot.
// three has a hook renderer.debug.onShaderError: once set, three no longer prints on its own, so the original error is printed in full here too (nothing from plain three.js is lost).
// if the game set onShaderError itself, do not override it.
import { setConsoleFunction, getConsoleFunction } from 'three';
import { isWebGPU, findNodeBuild } from './backend.js';
import { materialPatches } from './patches.js';

const BEGIN = /^\s*\/\/ threedog:begin patch=(\S+) slot=(\S+)/, END = /^\s*\/\/ threedog:end/;
// a GLSL file served by the vite preset's threedog-live plugin (shader hot reload, render/hotGlsl.js): `// threedog:begin file=<path>`
const FILE = /^\s*\/\/ threedog:begin file=(\S+)/;

/**
 * Which patch (and slot) source line `n` (1-based) falls in, or null when it is in the material's own code
 * @internal
 * @param {string[]} lines @param {number} n
 * @returns {{ patch: string | null, slot: string | null, file?: string } | null} file: 'path:line' when the line is in a hot-reloadable GLSL file
 */
function patchAt(lines, n) {
  // markers nest (a file's code inside a patch), so walk down to line n keeping the open blocks
  const open = [];
  for (let i = 0; i < Math.min(n, lines.length) - 1; i++) {
    const l = lines[i];
    if (END.test(l)) { open.pop(); continue; }
    const m = BEGIN.exec(l), f = FILE.exec(l);
    if (m) open.push({ patch: m[1], slot: m[2] }); else if (f) open.push({ file: f[1], first: i + 2 });
  }
  const p = open.findLast(o => o.patch), f = open.findLast(o => o.file);
  if (!p && !f) return null;
  return { patch: p?.patch ?? null, slot: p?.slot ?? null, ...(f && { file: `${f.file}:${n - f.first + 1}` }) };
}

/**
 * Explain one failed shader stage: '[threedog] shader error in patch 'x' (slot y) ...' per error line, or a note that the error is in
 * the material's own code with the list of engine patches present.
 * @internal
 * @param {'vertex' | 'fragment'} stage @param {string} source @param {string} log
 * @returns {string}
 */
function explainShaderError(stage, source, log) {
  const lines = source.split('\n'), patches = [...new Set(lines.map(l => BEGIN.exec(l)?.[1]).filter(Boolean))];
  const out = [];
  for (const row of log.split('\n')) {
    const m = /ERROR:\s*\d+:(\d+):/.exec(row);
    if (!m) continue;
    const n = +m[1], at = patchAt(lines, n), snippet = (lines[n - 1] ?? '').trim();
    const where = at && [at.file && `file ${at.file}`, at.patch && `patch '${at.patch}' (slot ${at.slot})`].filter(Boolean).join(', ');
    out.push(at ? `[threedog] shader error in ${where}, ${stage} shader: ${row.trim()} | ${snippet}`
      : `[threedog] shader error in the material's own ${stage} code (not in a patch; patches in this program: ${patches.join(', ') || 'none'}): ${row.trim()} | ${snippet}`);
  }
  return out.join('\n');
}

/** The stages that failed or left a message, each with its log @param {any} gl @param {any} vs @param {any} fs */
function stageLogs(gl, vs, fs) {
  return /** @type {const} */ ([['vertex', vs], ['fragment', fs]]).map(([stage, sh]) => ({ stage, sh, log: gl.getShaderInfoLog(sh) || '' }))
    .filter(({ sh, log }) => !gl.getShaderParameter(sh, gl.COMPILE_STATUS) || log.trim());
}

/**
 * Hook renderer.debug.onShaderError (when nothing else holds it) so compile errors name the patch and slot.
 * @internal core/engine/Engine.js
 * @param {import('three').WebGLRenderer} renderer
 * @param {(materialId: number) => string} [onFail] WebGPU: called when the device refused a pipeline of that material; returns what was done about it ('' = nothing)
 */
export function nameShaderErrors(renderer, onFail) {
  const d = /** @type {any} */ (renderer).debug;
  if (isWebGPU(renderer)) { if (onFail) ON_FAIL.set(renderer, onFail); nameNodeErrors(renderer); watchInvalidPipelines(renderer); return; }
  if (!d || d.onShaderError) return;
  d.onShaderError = (gl, program, vs, fs) => {
    const parts = [];
    for (const { stage, sh, log } of stageLogs(gl, vs, fs)) {
      // always append the full original log after the explanation: the explanation picks only `ERROR: n:m:` lines and drops warnings and others; the file header promised "no line of the original error is lost"
      const why = explainShaderError(stage, gl.getShaderSource(sh) || '', log);
      parts.push(why ? `${why}\n[threedog] ${stage} shader log:\n${log.trim()}` : `[threedog] ${stage} shader: ${log.trim()}`);
    }
    const link = gl.getProgramInfoLog(program) || '';
    console.error(parts.join('\n') + (link.trim() ? `\n[threedog] program link: ${link.trim()}` : '') + '\n(raw anchors and slots: render/slots.js)');
  };
}

// ---------- WebGPURenderer (docs/plans/2026-11-03-webgpu-phase2.md §4 "shader error location") ----------
// What exists there: a tsl patch's own JS error is caught where it runs and named `patch 'x' (slot y)` with the game's line on top of its stack
// (render/fx/patchNodes.tsl.js run()); an error while three builds the node a patch or a post effect returned carries the same name
// (render/fx/nodeErrors.tsl.js), and three's 'TSL:' build-error log gets one more line naming the material and mesh. A compile error comes later, from code three generated from nodes, and that code has no patch markers
// (TSL writes it; there is nothing to put them in), so the line cannot be mapped to a patch. What this names instead: the material and mesh
// whose program failed and the patches on it. Two hooks reach it: on the WebGL2 backend three calls debug.onShaderError like WebGLRenderer;
// on the WebGPU backend there is no callback, three reports pipeline failures (popErrorScope + getCompilationInfo, with WGSL line excerpts)
// through its console function only, so the engine wraps that once (setConsoleFunction, a game's own wrapper still runs) and adds one line.
// Not covered: errors the device raises outside a pipeline build (renderer.onError, three's uncaptured-error handler) keep three's own message.
const NODE_HINT = "node programs have no patch markers (TSL writes them): take the listed patches off one at a time (applyEffects), or read the program with renderer.debug.getShaderAsync(scene, camera, mesh); a patch's own JS error is named patch 'x' (slot y) where it runs";

/** "MeshLambertNodeMaterial 'leaf' (#12) on Mesh 'tree'; patches on it: wind, clouds" @param {any} ro a three RenderObject */
function nodeOwner(ro) {
  const m = ro.material, o = ro.object, p = materialPatches(m);
  return `${m.type}${m.name ? ` '${m.name}'` : ''} (#${m.id}) on ${o?.type ?? 'object'} '${o?.name || '(unnamed)'}'; patches on it: ${p.join(', ') || 'none'}`;
}

/**
 * The explanation for one three console message, or '' (not a pipeline failure)
 * @param {string} message
 * @returns {string}
 */
function explainPipelineError(message) {
  const m = /Render pipeline creation failed \(renderPipeline_.*_(\d+)\)/.exec(message);
  return m ? `${pipelineFailed(+m[1])} three's WGSL lines follow.` : '';
}

// renderer -> what the engine does about a pipeline that failed for one material (core/engine/Engine.js gives it): the post chain holds the effect
// that draws with it. Why here: the device reports a failed pipeline by its label only, and this file is where a label becomes a material and its owner.
const ON_FAIL = new WeakMap();
/** "[threedog] WebGPU pipeline failed for <owner>: <what the engine did about it, or how to find the cause>." @param {number} id material id @param {any} [r] the renderer, when the report came with one */
function pipelineFailed(id, r) {
  const ro = findNodeBuild(x => x.material?.id === id), did = ON_FAIL.get(r ?? ro?.renderer)?.(id);
  return `[threedog] WebGPU pipeline failed for ${ro ? nodeOwner(ro) : `material #${id} (not among the recent builds)`}: ${did || NODE_HINT}.`;
}

// What three's own scope misses: it wraps pipeline creation in a 'validation' error scope, and a shader the driver's compiler refuses (FXC on D3D:
// GPUInternalError) is no validation error. The pipeline stays invalid, three keeps drawing with it, and the device answers every frame with
// `[Invalid RenderPipeline "renderPipeline_<name>_<id>"] is invalid`, which reaches renderer.onError. Said once per material; a game's own onError still runs first.
const INVALID = /\[Invalid RenderPipeline "renderPipeline_.*_(\d+)"\]/, told = new WeakMap();
/** @param {any} r a WebGPURenderer */
function watchInvalidPipelines(r) {
  if (typeof r.onError !== 'function' || told.has(r)) return;
  const prev = r.onError, said = new Set(); told.set(r, said);
  r.onError = function (info) {
    prev.call(this, info);
    const m = INVALID.exec(String(info?.message));
    if (m && !said.has(m[1])) { said.add(m[1]); console.error(pipelineFailed(+m[1], r)); }
  };
}

/** The explanation for three's node build-error log ('THREE.TSL: TypeError: ...', NodeManager), or '' (another message) @param {string} message */
function explainBuildError(message) {
  if (!/^THREE\.TSL: \w*Error: /.test(message)) return '';
  // three logs right after building the stand-in for the failed one, with the same render object: the newest build is the one that failed
  const ro = findNodeBuild(() => true), named = /\[threedog\] (patch|post effect) '/.test(message);
  return `[threedog] node build failed for ${ro ? nodeOwner(ro) : 'a material not among the recent builds'}; three draws it with a plain NodeMaterial instead (the black or white mesh). `
    + (/\[vertex-inputs\]/.test(message) ? 'The vertex inputs counted above are the cause (render/vertexInputs.js).'
      : named ? 'The patch or post effect named above returned the node that failed.'
      : "Not inside a patch's or post effect's node (those are named when they fail): look at the material's own nodes (colorNode, positionNode ...)");
}

let consoleHooked = false;
/** Wrap three's console function once per page: three's message as before, then the explanation for a pipeline failure */
function hookThreeConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  const prev = getConsoleFunction();
  setConsoleFunction((type, message, ...params) => {
    if (prev) prev(type, message, ...params);
    else if (params[0]?.isStackTrace) console[type](params[0].getError(message));   // what three prints when no function is set
    else console[type](message, ...params);
    const why = type === 'error' ? explainPipelineError(String(message)) || explainBuildError(String(message)) : '';
    if (why) console.error(why);
  });
}

/** @param {any} r a WebGPURenderer */
function nameNodeErrors(r) {
  const d = r.debug;
  if (d && !d.onShaderError) d.onShaderError = (gl, program, vs, fs) => {
    const src = [gl.getShaderSource(vs), gl.getShaderSource(fs)];
    // _nodeBuilderState, not getNodeBuilderState(): reading must never start a build from inside an error report
    const ro = findNodeBuild(x => { const s = x._nodeBuilderState; return !!s && (s.vertexShader === src[0] || s.fragmentShader === src[1]); });
    const logs = [];
    for (const { stage, sh, log } of stageLogs(gl, vs, fs)) {
      const lines = (gl.getShaderSource(sh) || '').split('\n');
      const rows = log.split('\n').filter(l => /ERROR:/.test(l)).map(l => { const n = /ERROR:\s*\d+:(\d+):/.exec(l)?.[1]; return n ? `${l.trim()} | ${lines[+n - 1]?.trim() ?? ''}` : l.trim(); });
      logs.push(`[threedog] ${stage} shader log:\n${rows.join('\n') || log.trim()}`);
    }
    const link = gl.getProgramInfoLog(program) || '';
    console.error(`[threedog] shader error in a node program (WebGPURenderer, WebGL2 backend) for ${ro ? nodeOwner(ro) : 'a material not among the recent builds'}: ${NODE_HINT}\n`
      + logs.join('\n') + (link.trim() ? `\n[threedog] program link: ${link.trim()}` : ''));
  };
  hookThreeConsole();
}
