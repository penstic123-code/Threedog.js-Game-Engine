// [guard] Vertex inputs on WebGPURenderer: what the engine adds per instance must fit the device's 16 inputs, and a combination that does not is named
// before the pipeline fails. Ordinary runs land on WebGPURenderer's WebGL2 backend (same 16); `node packages/tools/real-webgpu.mjs vertex-inputs` runs it on real WebGPU.
export const specs = [
  {
    name: '[guard] vertex inputs: wind + near fade grass with temporalAA fits the device, one instance-origin input',
    url: '/tests/vertex-inputs/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.grassWithTAA());
      console.log('  vertex inputs:', JSON.stringify(r));
      check(`with temporalAA's velocity buffer the grass needs ${r.taa.count} vertex inputs, at most 16`, r.taa.count > 0 && r.taa.count <= 16, JSON.stringify(r.taa.names));
      // geometry position, normal, color 3 + instance matrix 4 + instance color 1 + the origin 1 (it was 4 per patch: 16, at the limit before temporalAA)
      check(`wind and near fade together read the instance origin as one input: ${r.plain.count} inputs without the velocity buffer, 9 expected`, r.plain.count === 9 && r.taa.count - r.plain.count === 4, JSON.stringify(r.plain.names));
      check('no error while drawing', !r.errors.length, JSON.stringify(r.errors));
    },
  },
  {
    // 不许绕开: a program over the limit is named by what stacked up, before three's raw location / pipeline error
    name: '[guard] vertex inputs: a program over the device limit is named by the features that stacked up, before the pipeline fails',
    url: '/tests/vertex-inputs/index.html',
    software: true,
    // what this test provokes on purpose; check 4 below still fails on three's raw error
    expectErrors: /\[vertex-inputs\]|node build failed|shader error in a node program|THREE\.TSL/,
    async run({ check, ev }) {
      await ev(() => window.grassWithTAA());
      const r = await ev(() => window.overLimit()), text = r.errors.join('\n');
      console.log('  over limit:', JSON.stringify(r.errors.map(x => x.slice(0, 700))));
      check('the error carries its code and the count against the device limit', /\[vertex-inputs\]/.test(text) && /17 vertex inputs/.test(text) && /takes 16/.test(text), text.slice(0, 400));
      check('it names every feature that stacked up', ['geometry', 'instance matrix', "last frame's instance matrix", 'temporalAA', 'instance color', "material's own"].every(w => text.includes(w)), text.slice(0, 700));
      check('it says what to do', /storage buffer/.test(text) && /MSAA/.test(text), text.slice(0, 700));
      check("three's raw location / pipeline error does not follow", !/Attribute location out of range|pipeline creation failed/i.test(text), text.slice(0, 400));
    },
  },
];
