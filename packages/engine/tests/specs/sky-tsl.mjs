// The sky dome on WebGPURenderer (docs/plans/2026-11-03-webgpu-phase2.md §7 step 9): a node material over the same uniforms.
// A guard: the real sky drives one set of uniforms, the real makeDome builds the WebGL ShaderMaterial and the WebGPU node material from it, and at five
// moments from sunrise to noon the two pictures agree to within 3% mean brightness; each time step moves both. The cumulus kind, the fog band and
// drifting clouds agree too.  GLSL-only parts (dome layers, the clouds
// and fog hooks) and a missing threedog/tsl fail by code, never silently. Software rendering like every pixel test.
export const specs = [
  {
    name: '[guard] sky dome on WebGPURenderer: picture mean within 3% of WebGL from sunrise to noon, time moves both; GLSL fails by name',
    url: '/tests/sky-tsl/index.html',
    software: true,   // compares rendered pixels (through window.skyTsl): same pixels on every machine
    async run({ check, ev }) {
      const r = await ev(() => window.skyTsl());
      console.log('  sky tsl numbers:', JSON.stringify(r));
      check('WebGL dome is a ShaderMaterial, WebGPU dome a MeshBasicNodeMaterial', r.kinds.join() === 'ShaderMaterial,MeshBasicNodeMaterial', r.kinds.join());
      const near = c => c.meanDiff < 3 && c.absDiff < 3 && c.mean > 5;
      for (const [t, c] of Object.entries(r.times)) {
        check(`time ${t}: picture mean differs < 3%`, near(c), JSON.stringify(c));
        if (c.moved) check(`time ${t}: the time step moved both pictures by about the same`, c.moved[0] > 0.5 && c.moved[1] > 0.5 && Math.abs(c.moved[0] - c.moved[1]) < Math.max(c.moved[0], c.moved[1]) * 0.3, JSON.stringify(c.moved));
      }
      for (const [n, c] of Object.entries(r.cumulus)) check(`${n}: picture mean differs < 3%`, near(c), JSON.stringify(c));
      check("createEngine({ renderer: 'webgpu' }) + sky(): node dome, picture mean within 3% of the WebGL dome",
        r.engine.isGPU && r.engine.dome === 'MeshBasicNodeMaterial' && near(r.engine), JSON.stringify(r.engine));
      check('engine.sky.environment builds on WebGPURenderer and writes into; remove takes it off', r.env?.written && r.env?.off, JSON.stringify(r.env));
      check('[guard] on WebGPURenderer a sky.environment rebuild refills the same texture (a new one rebuilt every material that reads it: a stall at each rebuild)', r.env?.same, JSON.stringify(r.env));
      const mv = r.engine.moved;
      check('[guard] engine.uniforms .value writes move the node dome (uSkyCurve, uCloudCover, uSkyCloudScale); writing back restores it', mv.uSkyCurve > 0.5 && mv.uCloudCover > 0.1 && mv.uSkyCloudScale > 0.5 && mv.back < 0.01, JSON.stringify(mv));
      const e = r.errors, named = (m, what) => new RegExp(what).test(m) && /\[webgpu-needs-tsl\]/.test(m);
      check("engine.sky.clouds() on a WebGPU dome throws [webgpu-needs-tsl], naming it", named(e.cloudsHookGpu, "sky\\.clouds\\(\\)"), e.cloudsHookGpu);
      check("without threedog/tsl, the dome on WebGPU says import 'threedog/tsl' [webgpu-needs-tsl]", named(e.noTslDome, "import 'threedog/tsl'"), e.noTslDome);
      check('the same dome still builds on WebGL', e.glDome === 'no error', e.glDome);
    },
  },
];
