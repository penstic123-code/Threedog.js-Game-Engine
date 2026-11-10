// Group P1 (docs/plans/research/2026-11-10-health-check-b-picture.md items 1, 8, 10; plan docs/plans/2026-11-10-group-p1.md): one colour rule for the
// picture, one test item each so one throw stops no other. Numbers are the largest channel difference (0-255) between two patches of a shot.
const PAGE = '/tests/group-p1/index.html';

export const specs = [
  {
    name: '[guard] group P1 item 1: fog is the same colour with no effect and with the chain on, on WebGL and WebGPU',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fogCase());
      console.log('  group P1 fog numbers:', JSON.stringify(r));
      for (const k of ['gl', 'gpu'])
        check(`${k}: the fully fogged wall and the part-fogged floor match between no effect and bloom / a no-op effect (within 2 of 255)`,
          r[k].wallDiff <= 2 && r[k].floorDiff <= 2 && r[k].wallDiffNoop <= 2 && r[k].floorDiffNoop <= 2, JSON.stringify(r[k]));
      check('WebGL and WebGPU show the same fog on the direct path (within 3)', Math.max(...r.gl.direct.wall.map((v, i) => Math.abs(v - r.gpu.direct.wall[i]))) <= 3, JSON.stringify([r.gl.direct.wall, r.gpu.direct.wall]));
    },
  },
  {
    name: '[guard] group P1 item 1b: a flat background in the fog colour (sky backdrop) leaves no seam against full fog, with or without an effect',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.seamCase());
      console.log('  group P1 seam numbers:', JSON.stringify(r));
      for (const k of ['gl', 'gpu']) for (const n of ['direct', 'bloom'])
        check(`${k} ${n}: wall at full fog against the background above it within 2 of 255`, r[k][n].seam <= 2, JSON.stringify(r[k][n]));
    },
  },
  {
    name: '[guard] group P1 item 1c: with no tone curve (NoToneMapping, sRGB output) fog is still mixed before the encoding: direct equals the chain',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.noToneCase());
      console.log('  group P1 no-tone numbers:', JSON.stringify(r));
      for (const k of ['gl', 'gpu']) check(`${k}: floor and wall equal between no effect and a no-op effect (within 2 of 255)`, r[k].diff <= 2 && r[k].wallDiff <= 2, JSON.stringify(r[k]));
    },
  },
  {
    name: '[guard] group P1 item 1d: a ShaderMaterial that already runs fog_fragment before the tone chunk compiles and draws as three draws it',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.orderCase());
      check('no shader error, and the same pixels with the patch on and off', r.errors === 0 && r.diff <= 1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P1 item 1e: the fog patch evaluated a second time (hot reload) is still undone by threePatches.off',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.reevalCase());
      check('patched, and off() restores three\'s chunks', r.on && r.off, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P1 item 10b: 60 renderOnce(target) calls with no effect on reuse the composer targets (no dispose), and give them back after the idle frames',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.reuseCase());
      check('0 disposes over 60 calls, then the targets are freed once', r.during === 0 && r.afterIdle === 2, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P1 item 10c: after engine.scene is replaced, renderOnce(target) on WebGPU draws the new scene',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.sceneSwapCase());
      check('the target changes to the new scene (green, tone mapped)', r.b[1] - r.b[0] > 60 && r.a[0] > 150, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group P1 item 10: renderOnce(target) gives the canvas pixels (tone mapped, output colour space) with no effect on and with one on',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.targetCase());
      console.log('  group P1 target numbers:', JSON.stringify(r));
      for (const k of ['gl', 'gpu']) for (const n of ['direct', 'chain'])
        check(`${k} ${n}: the target's floor patch equals the canvas's within 3 of 255`, r[k][n].diff <= 3, JSON.stringify(r[k][n]));
    },
  },
  {
    name: '[guard] group P1 item 8: a gamma ShaderPass (WebGL) and a node calling renderOutput (WebGPU) warn once; slot tone is the opt-out',
    url: PAGE,
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.twiceCase());
      check('WebGL: the gamma ShaderPass warns, and with slot tone it does not', r.warnedGl === 1 && r.optOutGl === 0, JSON.stringify(r));
      check('WebGPU: the node calling renderOutput warns, and with slot tone it does not', r.warnedGpu === 1 && r.optOutGpu === 0, JSON.stringify(r));
    },
  },
];
