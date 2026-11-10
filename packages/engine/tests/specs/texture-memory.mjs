// Texture memory in engine.inspect.perf() and threedog perf's "texture MB" column. Why both renderers: the reading comes from two places, three's own byte count on
// WebGPURenderer (info.memory.texturesSize) and the engine's estimate on WebGLRenderer (material slots + shadow maps); before 2026-11-09 both read the material
// slots only, so a TSL texture (in a node, no slot) and every render target read 0 MB on the world example.
const cases = (label, gpu) => ({
  name: `[guard] texture memory (${label}): a drawn 256x256 texture reads above zero and adds about its size`,
  url: '/tests/backend/index.html',
  software: true,
  async run({ check, ev }) {
    const r = await ev(g => window.textureMemoryCase(g), gpu);
    // 256 * 256 * 4 bytes = 0.25 MB, a third more with mipmaps; the reading is rounded to 0.1 MB, so the step is 0.2 to 0.4
    const step = r.after - r.before;
    check('texture MB above zero once the texture is drawn', r.after > 0, JSON.stringify(r));
    check('it grows by about the texture\'s size', step >= 0.2 && step <= 0.4, JSON.stringify(r));
  },
});
export const specs = [cases('WebGL', false), cases('WebGPU', true)];
