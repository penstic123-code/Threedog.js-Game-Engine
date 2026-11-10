// lightShaft (threedog/tsl): the cheap visible beam. Ordinary runs land on WebGPURenderer's WebGL2 backend; `node packages/tools/real-webgpu.mjs light-shaft`
// runs the same on real WebGPU. One page, one run: every number is "beam on minus beam off" at a world point (tests/light-shaft/main.js).
export const specs = [
  {
    // 不许绕开: each fade the research note names (sides, geometry, fog), the tier, the follow, the free and the refusals are checked from pixels and
    // events, so a change that drops one (a beam that stops fading at the floor, fog that tints instead of dims) fails here, not in a game
    name: '[guard] light shaft: brightens its own air, soft sides, fades at the floor, fog dims it, dust off on low, follows a spot, freed, refused by name',
    url: '/tests/light-shaft/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.shaftRun());
      console.log('  light shaft numbers:', JSON.stringify(r));
      const a = r.add;
      check(`brightens its own air: core +${a.core}, outside +${a.outside}`, a.core > 10 && a.core < 150 && Math.abs(a.outside) < 1, JSON.stringify(a));
      check(`soft sides: near the edge +${a.side} is well under the core +${a.core}`, a.side < a.core * 0.7, JSON.stringify(a));
      check(`fades where it meets the floor: foot +${a.foot} vs +${r.hard.foot} without the fade (core ${a.core} vs ${r.hard.core} unchanged)`,
        a.foot < r.hard.foot * 0.5 && Math.abs(a.core - r.hard.core) < 3, JSON.stringify([a, r.hard]));
      check(`intensity is live: half -> +${r.half} of +${a.core} (tone mapping bends it)`, r.half > a.core * 0.3 && r.half < a.core * 0.85, String(r.half));
      check(`fog dims it, never adds fog colour: red beam +${r.fog.red} red in green fog vs +${r.fog.clearRed} clear, green +${r.fog.green}`,
        r.fog.red > 0 && r.fog.red < r.fog.clearRed * 0.9 && Math.abs(r.fog.green) < 1, JSON.stringify(r.fog));
      check(`with bloom after it the beam still adds where it stands: core +${r.bloom.core}, outside +${r.bloom.outside}`, r.bloom.core > 8 && r.bloom.outside < r.bloom.core * 0.25, JSON.stringify(r.bloom));
      check(`dust patterns it on high (spread ${r.dust.even} -> ${r.dust.high}); low tier skips it (spread ${r.dust.low}, core differs by ${r.dust.lowVsEven})`,
        r.dust.high > r.dust.even + 2 && r.dust.lowVsEven < 1 && Math.abs(r.dust.low - r.dust.even) < 1, JSON.stringify(r.dust));
      check(`follows a spot light: at ${r.follow.at}, aims ${r.follow.down}, cone width from its angle (${r.follow.radius}), its colour`,
        r.follow.at.join() === '1.5,3.5,-1' && r.follow.down.join() === '0,-1,0' && Math.abs(r.follow.radius - Math.tan(0.3) * 3) < 1e-3 && r.follow.color, JSON.stringify(r.follow));
      check('engine.remove frees its geometry and material', r.freed.includes('geometry') && r.freed.includes('material'), JSON.stringify(r.freed));
      check('WebGLRenderer refused by name', /tsl-misuse.*WebGPURenderer/.test(r.refused.webgl), r.refused.webgl);
      check('a point light refused by name', /SpotLight or DirectionalLight/.test(r.refused.point), r.refused.point);
      check('an unknown option refused', /radius/.test(r.refused.typo ?? ''), r.refused.typo);
    },
  },
];
