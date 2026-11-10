// Picture on WebGPU, all optional: autoExposure (@threedog/post-effects/tsl), the pcss shadow filter (threedog/tsl), and RectAreaLight with no setup from the game.
// Ordinary runs land on WebGPURenderer's WebGL2 backend; all three run there.
export const specs = [
  {
    // 不许绕开: the exposure lives in a 1x1 target on the GPU, so the only way to see it is the picture; removing the effect leaves none of its targets
    name: '[guard] auto exposure: dark and bright settle near the same brightness, comes down over engine-time frames, a rebuild keeps it, slow easing reaches the goal, key in place, max caps, order, remove leaves nothing',
    url: '/tests/picture-light/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.exposure());
      console.log('  exposure numbers:', JSON.stringify({ ...r, path: r.path.filter((_, i) => i % 4 === 0) }));
      const settled = r.path.at(-1), first = r.path[0];
      check(`without it dark and bright differ (${r.plain.dark} / ${r.plain.bright}); with it both settle near each other (${r.dark} / ${settled})`,
        r.plain.bright > 3 * r.plain.dark && Math.abs(r.dark - settled) < 0.2 * settled, JSON.stringify([r.plain, r.dark, settled]));
      const rises = r.path.filter((v, i) => i > 1 && v > r.path[i - 1] + 3).length;
      check(`dark to bright: starts too bright (${first}) and comes down to ${settled} over ${r.path.length} frames, never back up`, first > settled + 40 && rises === 0 && Math.abs(settled - r.path.at(-3)) < 3, JSON.stringify(r.path));
      check(`a chain rebuild on the way (bloom and temporalAA added) keeps the adapted value: ${r.path[1]}, not the goal`, r.path[1] > settled + 40, JSON.stringify(r.path.slice(0, 3)));
      const end = r.slow.steps.at(-1);
      check(`slow easing (0.15 per second at 60 frames a second) reaches its goal: ${end} against ${r.slow.goal}, within 3`, Math.abs(end - r.slow.goal) <= 3 && r.slow.steps[0] < end, JSON.stringify(r.slow));
      check(`key 0.36 brightens (${r.keyed} > ${settled}) and writes its uniform with no rebuild`, r.keyed > settled + 15 && r.live, JSON.stringify([r.keyed, r.live]));
      check(`max: 2 keeps the dark place darker than its goal (${r.capped} < ${r.dark})`, r.capped < r.dark - 20, String(r.capped));
      check('order in the hdr slot: bloom, autoExposure, temporalAA', r.order.join(',') === 'bloom,autoExposure,temporalAA', r.order.join(','));
      check(`its targets (${r.made}) go when it is removed (${r.left} left)`, r.made >= 3 && r.left <= 0, JSON.stringify([r.made, r.left]));
    },
  },
  {
    // 不许绕开: the same light measured alone and under the engine's cascades, so a cascade that drops the game's filterNode fails here
    name: '[guard] pcss: the edge of a high caster is wide, a low one stays hard, alone and under engine cascades, and it widens smoothly between the search levels',
    url: '/tests/picture-light/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.softShadow());
      console.log('  pcss numbers:', JSON.stringify(r));
      for (const [k, s] of [['alone', r.single], ['cascades', r.cascaded]]) {
        check(`${k}: lit ${s.lit}, in shadow ${s.shade}`, s.lit > s.shade + 40, JSON.stringify(s));
        check(`${k}: outside the edge the high bar's penumbra darkens (${s.highOut} < ${s.lowOut}), inside it lightens (${s.highIn} > ${s.lowIn})`,
          s.highOut < s.lowOut - 10 && s.highIn > s.lowIn + 10, JSON.stringify(s));
      }
      const [m1, m2, m3] = r.mids;
      check(`between the search levels the edge still widens with the gap (1.2, 1.6, 2): outside ${m1.highOut} > ${m2.highOut} > ${m3.highOut}, inside ${m1.highIn} < ${m2.highIn} < ${m3.highIn}`,
        m1.highOut > m2.highOut + 2 && m2.highOut > m3.highOut + 2 && m1.highIn < m2.highIn - 2 && m2.highIn < m3.highIn - 2, JSON.stringify(r.mids));
      check('a wrong option throws by name', /pcss\(\)/.test(r.bad ?? ''), String(r.bad));
    },
  },
  {
    name: '[guard] RectAreaLight: lights a plane on WebGPURenderer and WebGLRenderer with no setup from the game, the first frame before the tables load included',
    url: '/tests/picture-light/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.areaLight());
      console.log('  area light numbers:', JSON.stringify(r));
      check(`WebGPURenderer: the plane under it is lit (${r.gpu}), the frame before the tables loaded drew without an error`, r.gpu > 40 && !r.threw && !r.errors.length, JSON.stringify(r));
      check(`WebGLRenderer: lit too (${r.gl})`, r.isGL && r.gl > 40, JSON.stringify(r));
    },
  },
];
