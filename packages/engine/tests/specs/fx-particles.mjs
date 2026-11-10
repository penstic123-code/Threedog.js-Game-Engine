// Particles and weather on WebGPURenderer (docs/plans/2026-11-03-webgpu-phase2.md §7 step 9): sprite quads + node materials instead of point sprites.
// A guard: the engine's own particle / weather code, built against both renderers from one seed, must hold the same particles (count, positions,
// sizes, alpha read from the data) and draw the same picture to within 3% mean brightness, with the particles in the same place; moving time moves
// both and they still agree. GLSL text on WebGPU and a missing threedog/tsl fail by code, never silently. Software rendering like every pixel test.
export const specs = [
  {
    name: '[guard] WebGPU particles and weather match WebGL: orthographic size does not shrink with depth, weather is fogged on both, the "no texture" stand-in is freed',
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fxGroupE());
      check('orthographic camera: two equal particles at depth 20 and 30 draw the same size', r.ortho[0] > 50 && Math.abs(r.ortho[0] - r.ortho[1]) / r.ortho[0] < 0.1, JSON.stringify(r.ortho));
      for (const [f, w] of Object.entries(r.weatherFog)) check(`${f}: fogged on both backends, and the fogged picture matches (WebGL ${w.fogged.toFixed(1)} vs clear ${w.clear.toFixed(1)}, mean diff ${w.meanDiff}%)`,
        w.flags[0] === true && w.flags[1] === true && Math.abs(w.fogged - w.clear) > 0.05 * w.clear && w.meanDiff < 5, JSON.stringify(w));
      check('a game vertex shader without fog chunks plus scene fog: the weather is unfogged, compiles (no shader error) and draws', r.customVertex.fog === false && r.customVertex.lit > 0 && r.customVertex.errs.length === 0, JSON.stringify(r.customVertex));
      check('the stand-in texture is disposed when a real one replaces it, and with the material; the real one is not', r.swapped === 1 && r.disposed[0] === 1 && r.disposed[1] === 0 && r.disposed[2] === 1, JSON.stringify(r));
      check("weather rebuilt (tier change): the new snow draws its own stand-in, not the old one freed with the old material; a game's texture is carried", r.rebuild.own === true && !r.rebuild.carried && r.rebuild.given, JSON.stringify(r.rebuild));
    },
  },
  {
    name: '[guard] particles over life: aLife in a game material, stops, the two-point form, bad values refused, on both routes',
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fxOverLife());
      for (const [n, c] of Object.entries(r.routes)) {
        check(`${n}: aLife is age / life for every live particle, and it reaches the GPU copy`, c.life.every(([a, b]) => Math.abs(a - b) < 1e-5) && c.life.length === 6 && c.lifeUploads, JSON.stringify(c.life));
        check(`${n}: a game's own material reading aLife draws by life (a quarter of the way through: a quarter white)`, Math.abs(c.ownMaterial - 64) < 6, String(c.ownMaterial));
        if (c.ownNodes) check(`${n}: a game's node material gets the engine's place, keeps its own size; a plain one is refused by name`, c.ownNodes.placed && c.ownNodes.sized && /\[module-params\]/.test(c.ownNodes.plain) && /node material/.test(c.ownNodes.plain), JSON.stringify(c.ownNodes));
        check(`${n}: the two-point form gives the numbers it always gave`, c.twoPoint.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.twoPoint));
        check(`${n}: one number, and one color, hold over life`, c.single.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.single));
        check(`${n}: timed stops: opacity fades in, then out`, c.fade.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.fade));
        check(`${n}: evenly spaced stops: size and color pass through the middle stop`, c.even.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.even));
        check(`${n}: ends hold before the first stop and after the last`, c.ends.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.ends));
        check(`${n}: overrides on emit bring their own stops, batches keep theirs`, c.batches.every(([a, b]) => Math.abs(a - b) < 1e-5), JSON.stringify(c.batches));
        check(`${n}: a fade-in draws: nothing at birth, then the particle`, c.fadeIn[0] === 0 && c.fadeIn[1] > 100, JSON.stringify(c.fadeIn));
      }
      for (const [n, m] of Object.entries(r.refused)) check(`refused with [module-params]: ${n}`, /\[module-params\]/.test(m), m);
      check('the options check names the stop forms', /timed stops/.test(r.refused['one stop']), r.refused['one stop']);
    },
  },
  {
    name: '[guard] particles ratePerMeter: even along the path at any speed, spacing carries across steps, pause, freeze and wind hold',
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fxPerMeter());
      check('20 m at 2 per meter in one step: 40 particles, every 0.5 m, none past the emitter', r.fast.n === 40 && Math.abs(r.fast.gap[0] - 0.5) < 1e-4 && Math.abs(r.fast.gap[1] - 0.5) < 1e-4 && r.fast.last <= 20.0001, JSON.stringify(r.fast));
      check('uneven steps: spacing still 0.5 m across them', r.uneven.n === 12 && Math.abs(r.uneven.gap[0] - 0.5) < 1e-4 && Math.abs(r.uneven.gap[1] - 0.5) < 1e-4, JSON.stringify(r.uneven));
      check('rate alone: all born at the emitter, as ever', r.rateOnly.length === 21 && r.rateOnly.slice(1).every(x => x === 20), JSON.stringify(r.rateOnly));
      check('rate and ratePerMeter add up: 1 in the first step, then 5 for the time and 20 for the distance', r.both === 26, String(r.both));
      check('the first step and a still emitter earn nothing', r.still === 0, String(r.still));
      check('the handle changes it live, attach beats the effect', r.live === 3 && r.attachWins === 3, JSON.stringify([r.live, r.attachWins]));
      check('a paused emitter leaves no line to where it wakes', r.paused === 0, String(r.paused));
      check('frozen: nothing born, none moved, no line after it thaws', r.frozen.during === 0 && r.frozen.after === 0, JSON.stringify(r.frozen));
      check('wind still pushes particles born on the path', r.wind > 0.01, String(r.wind));
      check('over max: the newest stay, up to the emitter, in one draw', r.cap.n === 8 && Math.abs(r.cap.last - 100) < 0.01 && Math.abs(r.cap.first - 96.5) < 0.01, JSON.stringify(r.cap));
      check('a negative ratePerMeter is refused', /\[module-params\]/.test(r.refused.define) && /\[module-params\]/.test(r.refused.attach), JSON.stringify(r.refused));
    },
  },
  {
    name: '[guard] particles soft: fades against what writes depth on WebGL and WebGPU, off changes nothing, the depth is drawn once and only when needed',
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ check, ev }) {
      // on a GPU run (--gpu) the same cases run on real WebGPU too
      const r = await ev(async () => window.fxSoft({ real: !!await navigator.gpu?.requestAdapter() }));
      const fades = c => c.hard === 255 && c.near < 8 && Math.abs(c.mid - 128) < 8 && c.far === 255 && c.behind === 0;
      for (const [n, c] of Object.entries(r.routes)) {
        if (c === 'no webgpu here') continue;
        const plainToo = !n.startsWith('webgl2-backend');   // three's depth copy fails there from the canvas and a plain target: see the warning below
        for (const k of ['canvas', 'target', 'msaaTarget', 'ortho'])
          check(`${n} ${k}: gone at the wall, half at half the distance, whole past it, hidden behind it`, plainToo || k === 'msaaTarget' ? fades(c[k]) : c[k].hard === 255 && c[k].far === 255 && c[k].behind === 0, JSON.stringify(c[k]));
      }
      check('nothing went wrong in the console', r.errors.length === 0, r.errors.join(' / '));
      check("the WebGL2 backend says soft has no fade there", r.warned.some(w => /soft has no fade/.test(w) && /\[module-params\]/.test(w)), JSON.stringify(r.warned));
      const c = r.cost;
      check('WebGL, off: same shader text, no depth target, no extra draw, no uniforms', c.off.defines === 0 && !c.off.depth && c.off.renders === 1 && !c.off.uSoft, JSON.stringify(c.off));
      check('WebGL, two soft effects: one depth draw between them', c.two.renders === 2, JSON.stringify(c.two));
      check('WebGL, soft but none alive: no depth draw', c.idle.renders === 1, JSON.stringify(c.idle));
      check("WebGL, a game's material on a soft effect: no depth draw", c.given.renders === 1, JSON.stringify(c.given));
      check('WebGL: the scene is left as found (layers, override, background)', c.restored, JSON.stringify(c));
      check('WebGPU: off builds the material without the depth read, on with it', c.nodes[0] === false && c.nodes[1] === true, JSON.stringify(c.nodes));
      check('uSoft is live', Math.abs(r.routes.webgl.target.live - 64) < 8 && Math.abs(r.routes['webgl2-backend'].msaaTarget.live - 64) < 8, JSON.stringify([r.routes.webgl.target, r.routes['webgl2-backend'].msaaTarget]));
      for (const [n, e] of Object.entries(r.engine)) check(`real engine, ${n}: fades at the wall, half at half the distance (127 blended encoded, 188 blended linear), whole away from it`, e.near < 8 && e.mid > 100 && e.mid < 200 && e.away > 200, JSON.stringify(e));
      check('refused: a negative soft', /\[module-params\]/.test(r.refused), r.refused);
    },
  },
  {
    name: '[guard] particles / weather on WebGPURenderer: same count and positions as WebGL, picture mean within 3% (with fog 1%), time moves both; GLSL fails by name',
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.fxParticles());
      console.log('  fx particles numbers:', JSON.stringify(r));
      const near = c => c.meanDiff < 3 && c.centroid < 3 && c.mean > 0.5;
      for (const [n, c] of Object.entries(r.particles)) {
        check(`particles ${n}: WebGL Points / WebGPU Sprite with PointsNodeMaterial`, c.kinds.join() === 'Points,Sprite,PointsNodeMaterial', c.kinds.join());
        check(`particles ${n}: same live count and the same positions / sizes / alpha on both`, c.count[0] === 50 && c.count[1] === 50 && c.samePos && c.instances >= 50, JSON.stringify(c));
        check(`particles ${n}: picture mean differs < 3%, lit centroid < 3 px apart`, near(c), JSON.stringify(c));
        check(`particles ${n}: aged 0.5 s, both pictures move and still agree`, c.later.moved[0] > 1 && c.later.moved[1] > 1 && c.later.samePos && near(c.later), JSON.stringify(c.later));
      }
      for (const [n, c] of Object.entries(r.fog))
        check(`particles ${n} with fog (linear target, as with post on): fog changes the picture (> 5%), WebGPU mean within 1% of WebGL`,
          c.fogGL > 5 && c.meanDiff < 1 && c.centroid < 3, JSON.stringify(c));
      for (const [n, c] of Object.entries(r.weather)) {
        check(`weather ${n}: node material on WebGPU`, /NodeMaterial$/.test(c.kinds[2]) && c.kinds[1] === (n === 'rain' ? 'LineSegments' : 'Sprite'), c.kinds.join());
        check(`weather ${n}: same scatter and the same number drawn`, c.samePos && c.drawn[0] === c.drawn[1] && c.drawn[0] > 0, JSON.stringify(c));
        check(`weather ${n}: picture mean differs < 3%, lit centroid < 3 px apart`, near(c), JSON.stringify(c));
        check(`weather ${n}: time moved on, both pictures move and still agree`, c.later.moved[0] > 1 && c.later.moved[1] > 1 && near(c.later), JSON.stringify(c.later));
      }
      const e = r.errors;
      check('a weather glsl spec on WebGPU throws [webgpu-needs-tsl], naming the field and the TSL way', /weather particles 'ash'/.test(e.glslGpu) && /\[webgpu-needs-tsl\]/.test(e.glslGpu) && /create\(engine\)/.test(e.glslGpu), e.glslGpu);
      check('the same glsl spec still builds on WebGL', e.glslGl === 'no error', e.glslGl);
      check("without threedog/tsl, particles and weather on WebGPU say import 'threedog/tsl' [webgpu-needs-tsl]",
        [e.noTslParticles, e.noTslWeather].every(m => /import 'threedog\/tsl'/.test(m) && /\[webgpu-needs-tsl\]/.test(m)), JSON.stringify(e));
    },
  },
];
