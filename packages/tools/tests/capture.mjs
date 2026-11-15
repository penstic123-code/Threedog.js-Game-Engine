// threedog capture: the frame summary and the Spector command count are plain functions, tested on a hand-made frame (no browser, no network)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, spectorDraws, hookScript } from '../lib/capture-lib.mjs';
import { rendererLine } from '../lib/page-url.mjs';
import { refuseState } from '../wait-engine.mjs';
import { TOOLS } from '../paths.mjs';

export const name = 'capture: frame summary and Spector counts';

const frame = {
  passes: [{ name: 'depth target 1024x1024', draws: 2, tris: 20, depthOnly: true }, { name: 'screen', draws: 3, tris: 1100, depthOnly: false }, { name: 'target 960x540', draws: 1, tris: 2, depthOnly: false }],
  draws: [
    { pass: 0, tris: 10, inst: 1, depth: true, type: 'Mesh', name: '', record: 'cabin', tag: 'level', material: 'prop', materialType: 'MeshDepthMaterial' },
    { pass: 0, tris: 10, inst: 1, depth: true, type: 'Mesh', name: '', record: null, tag: 'vegetation', material: 'vegetation', materialType: 'MeshDepthMaterial' },
    { pass: 1, tris: 1000, inst: 50, depth: false, type: 'Mesh', name: '', record: null, tag: 'vegetation', material: 'vegetation', materialType: 'MeshLambertMaterial' },
    { pass: 1, tris: 90, inst: 1, depth: false, type: 'Mesh', name: 'roof', record: 'cabin', tag: 'level', material: 'prop', materialType: 'MeshLambertMaterial' },
    { pass: 1, tris: 10, inst: 1, depth: false, type: 'Mesh', name: '', record: null, tag: null, material: 'water', materialType: 'MeshPhongMaterial' },
    { pass: 2, tris: 2, inst: 1, depth: false, type: 'Mesh', name: '', record: null, tag: null, material: 'ShaderMaterial', materialType: 'ShaderMaterial' },
  ],
};

/** A stand-in for the page: the hook runs against a renderer that draws through `hook` only */
function hooked(renderer) {
  const held = { engine: globalThis.engine, window: globalThis.window };
  globalThis.engine = { renderer }; globalThis.window = {};
  try { return { hook: hookScript(), draws: globalThis.window.__draws }; } finally { for (const [k, v] of Object.entries(held)) if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
}

export async function run({ check }) {
  // [guard] a value the page refused must not read as done: a URL has no caller to answer, so the tool that built it asks
  const pageWith = refused => ({ evaluate: async () => refused }), word = { key: 'weather', value: 'rian', reason: 'no weather named "rian"' };
  const stopped = await refuseState(pageWith([word]), ['weather']).then(() => null, e => e.message);
  check('[guard] a refused value the user named stops the tool, and says why', /weather=rian \(no weather named/.test(stopped ?? ''), stopped);
  check('the tool\'s own keys are not the user\'s to hear about', await refuseState(pageWith([{ key: 'cutscene', value: 'skip', reason: 'x' }]), ['weather']).then(() => true, () => false));
  check('[guard] capture and shot both ask', ['capture.mjs', 'lib/shot-page.mjs'].every(f => /await refuseState\(page,/.test(readFileSync(join(TOOLS, f), 'utf8'))));

  // the hole this closes: the hook wrapped renderBufferDirect, which WebGPURenderer has not, and printed an empty report with exit 0
  const mesh = { isMesh: true, type: 'Mesh', name: 'statue', geometry: { index: { count: 300 }, drawRange: { count: Infinity }, attributes: {} }, userData: {} };
  const gpu = { getRenderTarget: () => null, setRenderTarget() {}, _renderObjectDirect() {} }, h = hooked(gpu);
  gpu._renderObjectDirect(mesh, { type: 'MeshStandardNodeMaterial', userData: {} }, {}, {}, null, null);
  check('[guard] on WebGPURenderer the hook wraps its draw function and counts the draw', h.hook === '_renderObjectDirect' && h.draws.draws.length === 1 && h.draws.draws[0].tris === 100, h.hook);
  const gl = { getRenderTarget: () => null, setRenderTarget() {}, renderBufferDirect() {} }, g = hooked(gl);
  gl.renderBufferDirect({}, {}, mesh.geometry, { type: 'MeshStandardMaterial', userData: {} }, mesh, null);
  check('on WebGLRenderer it still wraps renderBufferDirect', g.hook === 'renderBufferDirect' && g.draws.draws.length === 1);
  check('a renderer with neither is refused, not reported as empty', hooked({ getRenderTarget: () => null }).hook === null);
  check('the renderer line says when a WebGPU game fell back', /WebGL2 \(fallback: WebGPU was asked for, no adapter; this is not a WebGPU picture\) on SwiftShader · software browser/.test(rendererLine({ requested: 'webgpu', backend: 'webgl2', reason: 'no adapter', gpu: 'SwiftShader' }, 'software')));

  const text = summarize(frame, { top: 2, gl: spectorDraws({ commands: [{ name: 'bindFramebuffer' }, { name: 'drawElements' }, { name: 'drawElementsInstanced' }, { name: 'useProgram' }, { name: 'drawArrays' }, { name: 'drawArrays' }, { name: 'drawArrays' }] }) });
  check('first line counts all draws, shadow draws and passes', /^Frame: 6 draw calls in 3 render passes · shadow-map draws 2 · scene and post draws 4/.test(text), text.split('\n')[0]);
  check('a colour pass after the screen pass is counted as a post pass', text.includes('post-effect or off-screen colour passes: 1'));
  check('largest draw is listed first, with instances, tag and material purpose', /1 {3}1000 tris\s+x50 instances.*tag vegetation · material vegetation/.test(text));
  check('only the requested number of largest draws is listed', text.split('Largest 2 scene draws by triangles:\n')[1].split('\n\n')[0].trim().split('\n').length === 2);
  check('world record ids are grouped', /Draws by world record id[^\n]*\n\s+cabin\s+1 draws\s+90 tris/.test(text));
  check('Spector counts: draw calls are counted by command name', spectorDraws({ commands: [{ name: 'drawArrays' }, { name: 'drawElementsInstanced' }, { name: 'clear' }] }).draws === 2);
  check('a draw count that differs from the hook is said, not hidden', text.includes('differs from the renderer hook (6)'));
}
