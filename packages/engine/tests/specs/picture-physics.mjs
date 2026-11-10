// Picture physics: pixels held against answers known without a picture (docs/plans/2026-11-09-picture-physics.md). Both renderers, linear float reads.
// 不许绕开: every other picture test compares the engine with itself, so light it adds or loses everywhere passes them; these numbers come from
// physics (a white furnace, twice the light, the BRDF by hand), so the same fault fails here. A miss is reported, never met by a wider tolerance.
const FURNACE = 0.01;   // relative: PMREM filtering and half floats on a constant world, nothing else; min / max of every channel, not the mean only
const PLANE = 0.01;     // relative: one light, one view direction, the formula three itself evaluates
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

export const specs = [{
  name: '[guard] picture physics: white furnace (rough white dielectric and metal vanish), probes plus their own environment read twice and litTwice says so, a plane under one sun reads the BRDF by hand, on WebGPU and WebGL',
  url: '/tests/picture-physics/index.html',
  software: true,
  timeout: 240000,
  async run({ page, check, ev }) {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const res = await ev(() => window.physics());
    console.log('  picture physics numbers:', JSON.stringify(res));
    for (const k of ['gpu', 'gl']) {
      const r = res[k], L = r.bg;
      check(`${k}: the route is the one named (${r.gpu ? 'WebGPURenderer' : 'WebGLRenderer'}), lights: false leaves no light (${r.lights.join(',') || 'none'}), the background reads the world (${L})`,
        r.gpu === (k === 'gpu') && !r.lights.length && near(L, 0.5, FURNACE) && r.dielectric.grey < 1e-3, JSON.stringify([r.gpu, r.lights, L, r.dielectric.grey]));
      for (const m of ['dielectric', 'metal']) {
        const d = r[m];
        check(`${k}: white furnace, rough ${m}: the sphere reads ${d.mean} (${d.min}..${d.max}) against the background ${L}`,
          near(d.mean, L, FURNACE) && near(d.min, L, 2 * FURNACE) && near(d.max, L, 2 * FURNACE) && d.grey < 1e-3, JSON.stringify(d));
      }
      const t = r.twice;
      check(`${k}: the bake saw the world (${t.dc}) and nothing was baked before it (litTwice ${t.before})`, near(t.dc, L, FURNACE) && t.before === null, JSON.stringify(t));
      // a probe is diffuse light only, so alone it reads the world less the specular share (a black sphere's reflection, measured): each light
      // counted once means probes alone plus the environment alone is exactly what both together read
      // every pixel, not the mean: a wrong SH band (brighter on one side, darker on the other) keeps the mean and fails min / max
      const once = L - r.specOnly, flat = (d, want) => near(d.mean, want, FURNACE) && near(d.min, want, 2 * FURNACE) && near(d.max, want, 2 * FURNACE) && d.grey < 1e-3;
      const P = t.probesOnly, B = t.both, E = t.envOnly;
      check(`${k}: probes alone read the world less its reflection on every pixel (${P.min}..${P.max} against ${L} - ${r.specOnly}); both together read the sum of each alone (${B.min}..${B.max} against ${E.mean} + ${P.mean}), twice the diffuse`,
        flat(P, once) && flat(B, E.mean + P.mean) && flat(E, L), JSON.stringify([r.specOnly, t]));
      check(`${k}: litTwice names the environment while both light it, and is quiet after its own Fix (environmentIntensity 0)`,
        /scene\.environment/.test(t.said ?? '') && t.afterFix === null, JSON.stringify([t.said, t.afterFix]));
      for (const [m, label] of [['lambert', 'Lambert: albedo x intensity x cos / pi'], ['standard', 'Standard roughness 1: Lambert x (1 - F) plus three\'s GGX'], ['standardHalf', 'Standard roughness 0.5'], ['specular', 'specular alone (black metal, seen from the mirror direction): intensity x cos x F x V x D']]) {
        const p = r[m];
        check(`${k}: one sun at 60 degrees, ${label}: ${p.lo}..${p.hi} against ${p.want}`, near(p.lo, p.want, PLANE) && near(p.hi, p.want, PLANE), JSON.stringify(p));
      }
    }
  },
}];
