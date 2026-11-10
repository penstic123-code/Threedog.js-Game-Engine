// [guard] The asset gallery draws node materials: a model with a TSL material gets a real turntable picture (it was an empty frame when the
// gallery only had a WebGLRenderer), on a WebGPU-route game and on a WebGL game whose asset carries a node material; a classic material
// still draws in the same run. software: a pixel test like its neighbours (WebGPURenderer falls back to its WebGL2 backend there).
export const specs = [
  {
    name: '[guard] asset gallery draws node materials (WebGPU renderer picked for a TSL asset, on a WebGPU and a WebGL game), classic ones still draw',
    url: '/tests/gallery-webgpu/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.galleryNodeMaterials());
      console.log('  gallery node material numbers:', JSON.stringify(r));
      check('hasNodeMaterial tells a TSL material from a classic one', r.node && !r.plain, JSON.stringify(r));
      for (const k of ['gpu', 'gl']) {
        const g = r[k];
        check(`${k} game: every picture made (2 models x 3 lights), no error`, g.count === 6 && !g.errors.length, JSON.stringify(g));
        check(`${k} game: the node material box shows its own red (> 20% of the middle third)`, g.nodeRed > 20, JSON.stringify(g));
        check(`${k} game: the classic box still shows its blue (> 20% of the middle third)`, g.plainBlue > 20, JSON.stringify(g));
      }
      check('live grid: the node material box cell shows its red (> 20%), close() removes the grid', r.live > 20 && r.liveGone, JSON.stringify({ live: r.live, gone: r.liveGone }));
    },
  },
  {
    // [guard] the look-dev switches (gallery --mode <channel> / --light / --exposure / --tone / --material and the live header) are what an AI
    // reads headless instead of looking: a channel that silently showed the lit picture, black, or a value other than the material's would mislead.
    name: '[guard] look-dev: each channel is its own non-black picture with the material\'s value, studio / game setups, exposure, one material, live switch',
    url: '/tests/gallery-webgpu/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.galleryLookdev());
      console.log('  look-dev numbers:', JSON.stringify(r));
      const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      const near = (v, want) => Math.abs(v - want) <= 0.06;
      for (const k of ['gpu', 'gl']) {
        const g = r[k], names = ['midday', 'albedo', 'normal', 'roughness', 'metalness', 'ao'], m = names.map(n => g.mean[n]);
        check(`${k} game: a picture per channel, none black (mean of the middle > 15)`, !g.errors.length && m.every(c => c && Math.max(...c) > 15), JSON.stringify(g));
        const pairs = names.flatMap((a, i) => names.slice(i + 1).map(b => [a, b, g.mean[a] && g.mean[b] ? dist(g.mean[a], g.mean[b]) : 0]));
        const same = pairs.filter(p => p[2] < 25);
        check(`${k} game: every channel picture differs from every other and from the lit one`, !same.length, JSON.stringify(same));
        check(`${k} game: albedo is the red base color, normal leans blue toward the camera`, g.mean.albedo?.[0] > 2 * g.mean.albedo?.[1] && g.mean.normal?.[2] > g.mean.normal?.[0], JSON.stringify(g.mean));
        check(`${k} game: the gray channels read the material's values (roughness 0.8, metalness 0.3, ao 1 without a map)`, near(g.facts.roughness, 0.8) && near(g.facts.metalness, 0.3) && near(g.facts.ao, 1), JSON.stringify(g.facts));
      }
      check('studio and game setups each draw the asset (not black) and differ', r.lights.studio?.length && r.lights.game?.length && Math.max(...r.lights.studio) > 15 && Math.max(...r.lights.game) > 15 && dist(r.lights.studio, r.lights.game) > 10, JSON.stringify(r.lights));
      check('the game setup says nothing is missing when the game has plain lights and no environment map', !r.lightNotes.length, JSON.stringify(r.lightNotes));
      check('exposure 2.5 is brighter than 0.4 (the override reaches the gallery renderer)', r.exposure[1] > r.exposure[0] + 30, JSON.stringify(r.exposure));
      check('--material: a TSL material found by name in the game\'s scene is drawn alone, its albedo is its own green', r.material.names.join() === 'lava:material' && !r.material.errors.length && r.material.albedo[1] > 2 * r.material.albedo[0], JSON.stringify(r.material));
      check('--material with an unknown name says so and lists the names', /no material named "nope".*lava/.test(r.missing ?? ''), r.missing);
      check('[guard] WebGL game: the live grid stays on WebGL and still draws; the channel switch is off with its reason', r.glLive?.disabled && /WebGPU/.test(r.glLive.why) && r.glLive.drawn, JSON.stringify(r.glLive));
      check('live grid: the header switch to roughness turns the probe cell from lit red to its gray', r.liveFinal && r.liveRough && r.liveFinal[0] > 1.5 * r.liveFinal[1] && dist(r.liveRough, [204, 204, 204]) < 30, JSON.stringify({ final: r.liveFinal, rough: r.liveRough }));
    },
  },
];
